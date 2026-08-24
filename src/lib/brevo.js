// Client API Brevo v3 + résolution des attributs contacts / sociétés
import { cleanCompanyName, companyNameKey, domainOf, formatNumberFR, stripAccents } from './normalize.js';

const BASE = 'https://api.brevo.com/v3';

export class BrevoError extends Error {
  constructor(message, { status, code } = {}) {
    super(message);
    this.name = 'BrevoError';
    this.status = status;
    this.code = code;
  }
}

export class BrevoClient {
  constructor(apiKey, fetchImpl = fetch) {
    if (!apiKey) throw new BrevoError('Clé API Brevo manquante');
    this.apiKey = apiKey;
    // Ne pas stocker fetch comme méthode : appelé avec `this` ≠ window, le navigateur lève "Illegal invocation"
    this.fetch = (...args) => fetchImpl(...args);
  }

  async request(method, path, body) {
    const r = await this.fetch(BASE + path, {
      method,
      headers: {
        'api-key': this.apiKey,
        accept: 'application/json',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (r.status === 204) return null;
    const text = await r.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      /* réponse non JSON */
    }
    if (!r.ok) {
      const msg = data?.message || `Brevo HTTP ${r.status}`;
      throw new BrevoError(r.status === 401 ? 'Clé API Brevo refusée (401)' : msg, { status: r.status, code: data?.code });
    }
    return data;
  }

  getAccount() {
    return this.request('GET', '/account');
  }

  // ----- Contacts -----
  async getContactAttributes() {
    const d = await this.request('GET', '/contacts/attributes');
    return d?.attributes || [];
  }

  createContactAttribute(category, name, body) {
    return this.request('POST', `/contacts/attributes/${category}/${encodeURIComponent(name)}`, body);
  }

  async getContact(identifier, identifierType) {
    try {
      const qs = identifierType ? `?identifierType=${encodeURIComponent(identifierType)}` : '';
      return await this.request('GET', `/contacts/${encodeURIComponent(identifier)}${qs}`);
    } catch (e) {
      if (e.status === 404 || e.code === 'document_not_found') return null;
      throw e;
    }
  }

  createContact(body) {
    return this.request('POST', '/contacts', body);
  }

  updateContact(id, body) {
    return this.request('PUT', `/contacts/${encodeURIComponent(id)}`, body);
  }

  // ----- Sociétés -----
  getCompanyAttributes() {
    return this.request('GET', '/crm/attributes/companies');
  }

  listCompanies(params = {}) {
    const qs = new URLSearchParams(params).toString();
    return this.request('GET', `/companies${qs ? '?' + qs : ''}`);
  }

  createCompany(body) {
    return this.request('POST', '/companies', body);
  }

  updateCompany(id, body) {
    return this.request('PATCH', `/companies/${encodeURIComponent(id)}`, body);
  }

  linkContacts(companyId, contactIds) {
    return this.request('PATCH', `/companies/link-unlink/${encodeURIComponent(companyId)}`, { linkContactIds: contactIds });
  }
}

export function contactUrl(id) {
  return `https://app.brevo.com/contact/index/${id}`;
}

export function normKey(s) {
  return stripAccents(String(s || ''))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

// ---------- Attributs contact ----------

export const CONTACT_FIELDS = {
  firstName: { label: 'Prénom', candidates: ['PRENOM', 'FIRSTNAME', 'FIRST_NAME'], create: { name: 'PRENOM', type: 'text' } },
  lastName: { label: 'Nom', candidates: ['NOM', 'LASTNAME', 'LAST_NAME'], create: { name: 'NOM', type: 'text' } },
  jobTitle: { label: 'Titre de poste', candidates: ['TITRE', 'POSTE', 'JOB_TITLE', 'TITLE', 'FONCTION'], create: { name: 'TITRE', type: 'text' } },
  company: { label: 'Société', candidates: ['SOCIETE', 'ENTREPRISE', 'COMPANY', 'COMPANY_NAME'], create: { name: 'SOCIETE', type: 'text' } },
  language: { label: 'Langue', candidates: ['LANGUE', 'LANGUAGE', 'LANG'], create: { name: 'LANGUE', type: 'text' } },
  qualified: { label: 'Qualifié', candidates: ['QUALIFIE', 'QUALIFIED'], create: { name: 'QUALIFIE', type: 'text' } },
  companyPhone: { label: 'Téléphone société', candidates: ['TELEPHONE_SOCIETE', 'TEL_SOCIETE', 'COMPANY_PHONE'], create: { name: 'TELEPHONE_SOCIETE', type: 'text' } },
  linkedin: { label: 'URL LinkedIn', candidates: ['LINKEDIN', 'LINKEDIN_URL', 'URL_LINKEDIN'], create: { name: 'LINKEDIN', type: 'text' } },
};

export function resolveContactAttributes(attrs = []) {
  const map = {};
  for (const [field, def] of Object.entries(CONTACT_FIELDS)) {
    for (const c of def.candidates) {
      const a = attrs.find((x) => normKey(x.name) === normKey(c));
      if (a) {
        map[field] = a;
        break;
      }
    }
  }
  return map;
}

export async function ensureContactAttributes(client, { create = true } = {}) {
  let attrs = await client.getContactAttributes();
  let map = resolveContactAttributes(attrs);
  const created = [];
  if (create) {
    for (const [field, def] of Object.entries(CONTACT_FIELDS)) {
      if (map[field]) continue;
      await client.createContactAttribute('normal', def.create.name, { type: def.create.type });
      created.push(def.create.name);
    }
    if (created.length) {
      attrs = await client.getContactAttributes();
      map = resolveContactAttributes(attrs);
    }
  }
  return { map, created, missing: Object.keys(CONTACT_FIELDS).filter((f) => !map[f]) };
}

export function formatContactValue(attr, value) {
  if (value == null || value === '') return null;
  if (attr.category === 'category' && Array.isArray(attr.enumeration)) {
    const k = normKey(value);
    const e = attr.enumeration.find((x) => normKey(x.label) === k);
    return e ? e.value : null;
  }
  if (attr.type === 'boolean') return /^(oui|yes|true|1)$/i.test(String(value));
  if (attr.type === 'float') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return String(value);
}

// ---------- Sociétés ----------

export const COMPANY_FIELDS = {
  name: { label: 'Nom', candidates: ['name', 'nom', 'company_name', 'nom_de_la_societe', "nom_de_l_entreprise"] },
  website: { label: 'Site Web', candidates: ['domain', 'site_web', 'website', 'domaine', 'site_internet', 'url', 'site'] },
  employees: { label: "Nombre d'employés", candidates: ['number_of_employees', 'nombre_d_employes', 'nombre_employes', 'employees', 'nombre_de_salaries', 'effectif', 'effectifs'] },
  revenue: { label: 'Revenus', candidates: ['revenue', 'revenus', 'chiffre_d_affaires', 'ca', 'annual_revenue'] },
  cp: { label: 'CP', candidates: ['cp', 'code_postal', 'zip', 'zip_code', 'postal_code', 'departement'] },
  city: { label: 'Ville', candidates: ['city', 'ville'] },
  status: { label: 'Statut', candidates: ['statut', 'statut_juridique', 'status', 'situation', 'procedure_collective'] },
};

export function resolveCompanyAttributes(defs = []) {
  const out = {};
  for (const [field, def] of Object.entries(COMPANY_FIELDS)) {
    for (const c of def.candidates) {
      const a = defs.find((d) => normKey(d.internalName) === normKey(c) || normKey(d.label) === normKey(c));
      if (a) {
        out[field] = a;
        break;
      }
    }
  }
  return out;
}

function isNumericAttr(def) {
  return /number|float|int|double|decimal|currency/i.test(def?.attributeTypeName || '');
}

/** Construit {internalName: valeur} pour PATCH /companies/{id} à partir des infos annuaire. */
export function buildCompanyAttributes(map, info, website) {
  const values = {};
  const missing = [];
  const rows = [];
  const set = (field, textVal, numVal) => {
    const d = map[field];
    if (!d) {
      missing.push(COMPANY_FIELDS[field].label);
      return;
    }
    const num = isNumericAttr(d);
    const v = num ? numVal : textVal;
    if (v == null || v === '' || (num && !Number.isFinite(v))) return;
    values[d.internalName] = v;
    rows.push({ field, internalName: d.internalName, label: d.label || d.internalName, value: v });
  };
  if (website) set('website', domainOf(website), null);
  if (info) {
    set(
      'employees',
      info.effectifLabel ? `${info.effectifLabel}${info.effectifAnnee ? ` (${info.effectifAnnee})` : ''}` : null,
      info.effectifMin
    );
    set('revenue', info.ca != null ? `${formatNumberFR(info.ca)} €${info.caAnnee ? ` (${info.caAnnee})` : ''}` : null, info.ca);
    set('cp', info.departement || null, Number(info.departement));
    set('city', info.ville || null, null);
    set('status', info.statut || null, null);
  }
  return { values, missing, rows };
}

/** Cherche une société Brevo par nom (clé normalisée) puis par domaine. */
export async function findCompany(client, { name, domain } = {}) {
  const key = companyNameKey(name || '');
  const candidates = [];
  const tryFilter = async (attr, value) => {
    if (!value) return;
    try {
      const d = await client.listCompanies({ [`filters[attributes.${attr}]`]: value, limit: 50 });
      for (const it of d?.items || []) if (!candidates.some((c) => c.id === it.id)) candidates.push(it);
    } catch {
      /* filtre non supporté : on continue */
    }
  };
  if (name) await tryFilter('name', name);
  if (name && !candidates.length) {
    const cleaned = cleanCompanyName(name);
    if (cleaned && cleaned !== name) await tryFilter('name', cleaned);
  }
  if (domain) await tryFilter('domain', domain);

  if (!candidates.length) return null;
  const nameOf = (c) => c.attributes?.name || '';
  const exact = key && candidates.find((c) => companyNameKey(nameOf(c)) === key);
  if (exact) return exact;
  if (domain) {
    const byDomain = candidates.find((c) => domainOf(c.attributes?.domain || '') === domainOf(domain));
    if (byDomain) return byDomain;
  }
  if (key && candidates.length === 1) {
    const ck = companyNameKey(nameOf(candidates[0]));
    if (ck && (ck.includes(key) || key.includes(ck))) return candidates[0];
  }
  return null;
}
