import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BrevoClient,
  buildCompanyAttributes,
  contactUrl,
  findCompany,
  formatContactValue,
  listAllContacts,
  resolveCompanyAttributes,
  resolveContactAttributes,
} from '../src/lib/brevo.js';

test('resolveContactAttributes accepte PRENOM/NOM ou FIRSTNAME/LASTNAME', () => {
  const fr = resolveContactAttributes([{ name: 'PRENOM' }, { name: 'NOM' }, { name: 'QUALIFIÉ', category: 'category' }, { name: 'TUTOIEMENT', type: 'boolean' }]);
  assert.equal(fr.firstName.name, 'PRENOM');
  assert.equal(fr.qualified.name, 'QUALIFIÉ');
  assert.equal(fr.tutoiement.name, 'TUTOIEMENT');
  const en = resolveContactAttributes([{ name: 'FIRSTNAME' }, { name: 'LASTNAME' }]);
  assert.equal(en.lastName.name, 'LASTNAME');
  assert.equal(en.company, undefined);
});

test('formatContactValue selon le type', () => {
  assert.equal(formatContactValue({ type: 'text' }, 'Non'), 'Non');
  assert.equal(formatContactValue({ category: 'category', enumeration: [{ value: 1, label: 'Oui' }, { value: 2, label: 'Non' }] }, 'non'), 2);
  assert.equal(formatContactValue({ category: 'category', enumeration: [{ value: 1, label: 'Oui' }] }, 'Non'), null);
  assert.equal(formatContactValue({ type: 'boolean' }, 'Non'), false);
  assert.equal(formatContactValue({ type: 'float' }, '12'), 12);
  assert.equal(formatContactValue({ type: 'text' }, ''), null);
  // Booléens JS (tutoiement) : conservés tels quels pour un attribut boolean, Oui/Non sinon
  assert.equal(formatContactValue({ type: 'boolean' }, false), false);
  assert.equal(formatContactValue({ type: 'boolean' }, true), true);
  assert.equal(formatContactValue({ type: 'text' }, false), 'Non');
  assert.equal(formatContactValue({ category: 'category', enumeration: [{ value: 1, label: 'Oui' }, { value: 2, label: 'Non' }] }, true), 1);
});

test('listAllContacts : pagination par offset jusqu\'au total', async () => {
  const all = Array.from({ length: 7 }, (_, i) => ({ id: i + 1 }));
  const calls = [];
  const client = {
    listContacts: async ({ limit, offset }) => {
      calls.push(offset);
      return { contacts: all.slice(offset, offset + limit), count: all.length };
    },
  };
  const pages = [];
  const res = await listAllContacts(client, { pageSize: 3, onPage: (n, total) => pages.push(`${n}/${total}`) });
  assert.deepEqual(res.map((c) => c.id), [1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(calls, [0, 3, 6]);
  assert.deepEqual(pages, ['3/7', '6/7', '7/7']);
  assert.deepEqual(await listAllContacts({ listContacts: async () => ({ contacts: [], count: 0 }) }), []);
});

const companyDefs = [
  { internalName: 'name', label: 'Nom', attributeTypeName: 'text' },
  { internalName: 'domain', label: 'Site Web', attributeTypeName: 'text' },
  { internalName: 'number_of_employees', label: "Nombre d'employés", attributeTypeName: 'number' },
  { internalName: 'revenue', label: 'Revenus', attributeTypeName: 'number' },
  { internalName: 'cp_1', label: 'CP', attributeTypeName: 'text' },
  { internalName: 'city', label: 'Ville', attributeTypeName: 'text' },
];

test('resolveCompanyAttributes par label ou internalName', () => {
  const m = resolveCompanyAttributes(companyDefs);
  assert.equal(m.website.internalName, 'domain');
  assert.equal(m.employees.internalName, 'number_of_employees');
  assert.equal(m.cp.internalName, 'cp_1');
  assert.equal(m.status, undefined);
});

test('buildCompanyAttributes : numérique vs texte, champs manquants', () => {
  const m = resolveCompanyAttributes(companyDefs);
  const info = { effectifLabel: '10 à 19 salariés', effectifMin: 10, effectifAnnee: '2023', ca: 1234567, caAnnee: '2024', departement: '59', ville: 'LILLE', statut: 'RJ' };
  const { values, missing } = buildCompanyAttributes(m, info, 'https://www.site.fr/');
  assert.deepEqual(values, { domain: 'site.fr', number_of_employees: 10, revenue: 1234567, cp_1: '59', city: 'LILLE' });
  assert.deepEqual(missing, ['Statut']);
});

test('findCompany : correspondance exacte par clé de nom, sinon domaine, sinon null', async () => {
  const items = [
    { id: 'a', attributes: { name: 'DECATHLON PRO', domain: 'decathlon-pro.fr' } },
    { id: 'b', attributes: { name: 'Décathlon S.A.', domain: 'decathlon.fr' } },
  ];
  const client = { listCompanies: async () => ({ items }) };
  assert.equal((await findCompany(client, { name: 'Decathlon' })).id, 'b');
  assert.equal((await findCompany(client, { name: 'Autre', domain: 'www.decathlon-pro.fr' })).id, 'a');
  assert.equal(await findCompany(client, { name: 'Autre' }), null);
  assert.equal(await findCompany({ listCompanies: async () => ({ items: [] }) }, { name: 'X' }), null);
});

test('BrevoClient : en-têtes, erreurs, 404 → null', async () => {
  const calls = [];
  // Comme window.fetch : refuse d'être appelé avec un `this` étranger ("Illegal invocation")
  const fetchImpl = async function (url, init) {
    if (this !== undefined && this !== globalThis) throw new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation");
    calls.push({ url, init });
    if (url.endsWith('/contacts/missing%40x.fr')) return { ok: false, status: 404, text: async () => '{"code":"document_not_found","message":"Contact does not exist"}' };
    if (url.endsWith('/contacts')) return { ok: true, status: 201, text: async () => '{"id":42}' };
    return { ok: false, status: 401, text: async () => '{"message":"Key not found"}' };
  };
  const c = new BrevoClient('key', fetchImpl);
  assert.equal(await c.getContact('missing@x.fr'), null);
  assert.deepEqual(await c.createContact({ email: 'a@b.fr' }), { id: 42 });
  assert.equal(calls[1].init.headers['api-key'], 'key');
  assert.equal(calls[1].init.headers['content-type'], 'application/json');
  await assert.rejects(() => c.getAccount(), /401/);
  assert.equal(contactUrl(42), 'https://app.brevo.com/contact/index/42');
});
