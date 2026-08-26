// Recherche de personnes LinkedIn à partir du HTML servi par
// https://www.linkedin.com/search/results/people/?keywords=… (rendu serveur : un simple fetch avec cookies suffit).
// Fonctions pures (testables sous Node) : extraction des résultats, rapprochement avec un contact Brevo.
import { decodeEntities } from './website.js';
import { cleanCompanyName, companyNameKey, stripAccents } from './normalize.js';

export function peopleSearchUrl(keywords) {
  return `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(String(keywords).replace(/\s+/g, ' ').trim())}`;
}

export function profileUrlFromSlug(slug) {
  return `https://www.linkedin.com/in/${String(slug).trim().replace(/^\/+|\/+$/g, '')}/`;
}

/** EXT_ID posé par l'extension = slug du profil (ou `salesnav:<id>` quand seul le lead Sales Navigator était connu). */
export function slugFromExtId(extId) {
  const s = String(extId || '').trim();
  if (!s || /^salesnav:/i.test(s) || /[\s/?#@]/.test(s)) return null;
  return s;
}

const text = (s) => decodeEntities(String(s).replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

/** Réponse renvoyée à un visiteur non connecté (page de connexion / authwall). */
export function isLinkedInLoggedOut({ url = '', html = '' } = {}) {
  if (/\/(authwall|login|checkpoint|uas\/login|signup)/i.test(url)) return true;
  const title = (String(html).match(/<title>([^<]*)<\/title>/i) || [])[1] || '';
  return /^(Se connecter|Sign In|Login|Identifiez-vous)/i.test(title.trim());
}

/**
 * Cartes de résultats « personnes » : chaque carte est un role="listitem" dont le premier lien pointe vers /in/<slug>,
 * suivi de paragraphes : « Nom • 1er », titre, localisation.
 */
export function parsePeopleSearch(html = '') {
  const out = [];
  for (const seg of String(html).split(/role="listitem"/).slice(1)) {
    const m = seg.match(/href="https:\/\/www\.linkedin\.com\/in\/([^"/?#]+)\/?[^"]*"/);
    if (!m) continue;
    let slug = m[1];
    try {
      slug = decodeURIComponent(slug);
    } catch {
      /* slug déjà décodé */
    }
    const ps = [...seg.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/g)].map((x) => text(x[1])).filter(Boolean);
    const name = (ps[0] || '').split('•')[0].trim();
    if (!name || /^Membre LinkedIn$|^LinkedIn Member$/i.test(name) || out.some((r) => r.slug === slug)) continue;
    const headline = ps[1] && ps[1] !== '--' ? ps[1] : '';
    out.push({ slug, url: profileUrlFromSlug(slug), name, headline, location: ps[2] || '' });
  }
  return out;
}

// ---------- Rapprochement ----------

export function nameTokens(s = '') {
  return stripAccents(String(s))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
}

/** 'exact' : mêmes mots (ordre libre) ; 'partial' : le résultat contient tous les mots du contact (ex. « Jean Pierre Desmons ») ; null sinon. */
export function nameMatchLevel(candidateName, firstName, lastName) {
  const cand = nameTokens(candidateName);
  const want = [...nameTokens(firstName), ...nameTokens(lastName)];
  if (!want.length || !cand.length) return null;
  if (!want.every((t) => cand.includes(t))) return null;
  return cand.every((t) => want.includes(t)) ? 'exact' : 'partial';
}

const GENERIC_WORDS = new Set(
  'groupe group france french societe company entreprise international services service conseil consulting solutions solution agence agency holding partners associes associates digital global technologies technology europe'.split(' ')
);

/** Le titre du résultat mentionne-t-il la société du contact ? */
export function companyMatches(headline = '', company = '') {
  const key = companyNameKey(company);
  if (!key || key.length < 3) return false;
  const h = stripAccents(String(headline)).toLowerCase();
  if (h.replace(/[^a-z0-9]+/g, '').includes(key)) return true;
  const words = cleanCompanyName(company)
    .toLowerCase()
    .split(' ')
    .filter((w) => w.length >= 4 && !GENERIC_WORDS.has(w));
  // `w` ne contient que des lettres/chiffres (cleanCompanyName) : pas d'échappement nécessaire
  return words.some((w) => new RegExp(`(^|[^a-z0-9])${w}([^a-z0-9]|$)`).test(h));
}

/**
 * Choisit un profil parmi les résultats d'une recherche.
 * @returns {{status:'found', profile, confidence:'haute'|'moyenne'} | {status:'ambiguous', candidates} | {status:'none'}}
 */
export function chooseProfile(results = [], { firstName, lastName, company } = {}, { withCompanyQuery = false } = {}) {
  const scored = results
    .map((r) => ({ ...r, nameMatch: nameMatchLevel(r.name, firstName, lastName), companyMatch: companyMatches(r.headline, company) }))
    .filter((r) => r.nameMatch);
  if (!scored.length) return { status: 'none', candidates: [] };
  const exact = scored.filter((r) => r.nameMatch === 'exact');
  const pool = exact.length ? exact : scored;
  const withCompany = pool.filter((r) => r.companyMatch);
  if (withCompany.length === 1) return { status: 'found', profile: withCompany[0], confidence: 'haute' };
  if (exact.length === 1 && !withCompany.length) {
    return { status: 'found', profile: exact[0], confidence: withCompanyQuery && company ? 'haute' : 'moyenne' };
  }
  const candidates = [...withCompany, ...pool.filter((r) => !r.companyMatch)].slice(0, 5);
  return { status: 'ambiguous', candidates };
}

/**
 * Recherche complète pour un contact : « Prénom Nom Société » puis, si rien, « Prénom Nom ».
 * @param {{firstName:string,lastName:string,company?:string}} contact
 * @param {(url:string)=>Promise<string>} fetchHtml renvoie le HTML de la page (gère cookies, cadence, session)
 */
export async function findLinkedInProfile(contact, fetchHtml) {
  const first = String(contact.firstName || '').trim();
  const last = String(contact.lastName || '').trim();
  if (!first || !last) return { status: 'skip', reason: 'prénom ou nom manquant' };
  const company = cleanCompanyName(contact.company || '');
  const queries = [];
  if (company) queries.push({ keywords: `${first} ${last} ${company}`, withCompanyQuery: true });
  queries.push({ keywords: `${first} ${last}`, withCompanyQuery: false });
  const searched = [];
  for (const q of queries) {
    const html = await fetchHtml(peopleSearchUrl(q.keywords));
    searched.push(q.keywords);
    const r = chooseProfile(parsePeopleSearch(html), { firstName: first, lastName: last, company: contact.company }, q);
    if (r.status !== 'none') return { ...r, searched };
  }
  return { status: 'none', candidates: [], searched };
}
