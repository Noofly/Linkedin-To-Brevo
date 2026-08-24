import { BrevoClient, COMPANY_FIELDS, CONTACT_FIELDS, ensureContactAttributes, resolveCompanyAttributes } from '../lib/brevo.js';
import { clearCache, getSettings, saveSettings, setCache } from '../lib/settings.js';

const $ = (id) => document.getElementById(id);
const msg = $('msg');

function say(text, kind = '') {
  msg.textContent = text;
  msg.className = `msg ${kind}`;
}

async function load() {
  const s = await getSettings();
  $('apiKey').value = s.apiKey;
  $('genericDomain').value = s.genericDomain;
  $('defaultLang').value = s.defaultLang;
  $('autoCreateAttributes').checked = !!s.autoCreateAttributes;
}

async function save() {
  await saveSettings({
    apiKey: $('apiKey').value.trim(),
    genericDomain: $('genericDomain').value.trim().replace(/^@/, '') || 'example.com',
    defaultLang: $('defaultLang').value.trim().toLowerCase() || 'fr',
    autoCreateAttributes: $('autoCreateAttributes').checked,
  });
  await clearCache();
  say('Réglages enregistrés.', 'ok');
}

async function client() {
  const s = await getSettings();
  return new BrevoClient(s.apiKey);
}

async function test() {
  try {
    const c = await client();
    const a = await c.getAccount();
    say(`Connecté : ${a.email || ''} ${a.companyName ? `(${a.companyName})` : ''}`, 'ok');
  } catch (e) {
    say(`Échec : ${e.message}`, 'error');
  }
}

async function check() {
  const box = $('attrs');
  box.replaceChildren();
  try {
    const s = await getSettings();
    const c = new BrevoClient(s.apiKey);
    say('Vérification en cours…');
    const { map, created, missing } = await ensureContactAttributes(c, { create: s.autoCreateAttributes });
    await setCache('contactAttrs', map);
    const companyDefs = await c.getCompanyAttributes();
    await setCache('companyAttrs', companyDefs);
    const cmap = resolveCompanyAttributes(companyDefs);

    const table = (title, fields, resolved, nameOf) => {
      const h = document.createElement('h2');
      h.textContent = title;
      const t = document.createElement('table');
      t.innerHTML = '<thead><tr><th>Champ</th><th>Attribut Brevo</th><th>Type</th></tr></thead>';
      const tb = document.createElement('tbody');
      for (const [field, def] of Object.entries(fields)) {
        const a = resolved[field];
        const tr = document.createElement('tr');
        const td = (text, cls) => {
          const d = document.createElement('td');
          d.textContent = text;
          if (cls) d.className = cls;
          tr.append(d);
        };
        td(def.label);
        td(a ? nameOf(a) : 'ABSENT', a ? '' : 'missing');
        td(a ? a.type || a.attributeTypeName || '' : '');
        tb.append(tr);
      }
      t.append(tb);
      box.append(h, t);
    };
    table('Attributs contact', CONTACT_FIELDS, map, (a) => a.name);
    table('Attributs société', COMPANY_FIELDS, cmap, (a) => `${a.label || ''} (${a.internalName})`);

    const notes = [];
    if (created.length) notes.push(`Attributs contact créés : ${created.join(', ')}.`);
    if (missing.length) notes.push(`Attributs contact absents : ${missing.join(', ')}.`);
    const cmissing = Object.keys(COMPANY_FIELDS).filter((f) => !cmap[f]);
    if (cmissing.length) {
      notes.push(
        `Attributs société absents (à créer dans Brevo → Entreprises → Attributs, en gardant ces libellés) : ${cmissing
          .map((f) => COMPANY_FIELDS[f].label)
          .join(', ')}.`
      );
    }
    say(notes.join(' ') || 'Tous les attributs sont disponibles.', cmissing.length || missing.length ? '' : 'ok');
  } catch (e) {
    say(`Échec : ${e.message}`, 'error');
  }
}

$('save').addEventListener('click', save);
$('test').addEventListener('click', async () => {
  await save();
  await test();
});
$('check').addEventListener('click', async () => {
  await save();
  await check();
});
load();
