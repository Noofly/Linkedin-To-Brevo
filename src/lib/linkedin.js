// Extraction (pure, regex/JSON) depuis les réponses LinkedIn : site web d'une page entreprise, coordonnées d'un profil
import { decodeEntities } from './website.js';

export function decodeJsonString(s = '') {
  return String(s)
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\\//g, '/');
}

export function unwrapLinkedInRedirect(u) {
  try {
    const url = new URL(u);
    if (/(^|\.)linkedin\.com$/i.test(url.hostname) && url.pathname.startsWith('/redir/')) {
      const t = url.searchParams.get('url');
      if (t) return t;
    }
  } catch {
    /* ignore */
  }
  return u;
}

const isExternal = (u) => /^https?:\/\//i.test(u) && !/linkedin\.com|licdn\.com/i.test(u);

/** Objets JSON contenus dans les blocs <code> (pages Ember : entités HTML échappées). */
export function readEmbeddedObjects(html = '') {
  const out = [];
  for (const m of String(html).matchAll(/<code[^>]*>([\s\S]*?)<\/code>/gi)) {
    const raw = decodeEntities(m[1]).trim();
    if (!raw.startsWith('{') || !raw.includes('included')) continue;
    try {
      const j = JSON.parse(raw);
      if (Array.isArray(j.included)) out.push(...j.included);
    } catch {
      /* bloc non JSON */
    }
  }
  return out;
}

/**
 * Site web d'une page entreprise LinkedIn.
 * @param {string} html HTML de https://www.linkedin.com/company/<id|slug>/about/
 * @param {{id?: string, slug?: string}} hint identifiant numérique ou universalName pour cibler la bonne entité
 */
export function extractCompanyWebsite(html = '', hint = {}) {
  const objs = readEmbeddedObjects(html);
  const withSite = objs.filter((o) => typeof o.websiteUrl === 'string' && o.websiteUrl);
  const pick = (o) => (o ? unwrapLinkedInRedirect(o.websiteUrl.trim()) : null);
  if (withSite.length) {
    const byId = hint.id && withSite.find((o) => String(o.entityUrn || '').endsWith(`:${hint.id}`));
    const bySlug = hint.slug && withSite.find((o) => String(o.universalName || '').toLowerCase() === String(hint.slug).toLowerCase());
    const company = withSite.find((o) => /organization\.Company$/.test(o.$type || ''));
    const u = pick(byId || bySlug || company || withSite[0]);
    if (u && isExternal(u)) return u;
  }
  const h = String(html).includes('&quot;websiteUrl&quot;') ? String(html).replace(/&quot;/g, '"') : String(html);
  const patterns = [
    /"websiteUrl"\s*:\s*"([^"]+)"/,
    /"website"\s*:\s*"(https?:[^"]+)"/,
    /data-tracking-control-name="about_website"[^>]*href="([^"]+)"/,
    /href="([^"]+)"[^>]*data-tracking-control-name="about_website"/,
    /(?:Site web|Website|Sitio web|Webseite)[\s\S]{0,400}?href="(https?:\/\/(?![^"]*linkedin\.com)[^"]+)"/i,
  ];
  for (const re of patterns) {
    const m = h.match(re);
    if (!m) continue;
    const u = unwrapLinkedInRedirect(decodeJsonString(decodeEntities(m[1])).trim());
    if (isExternal(u)) return u;
  }
  return null;
}

export function linkedInCompanyRef(companyUrl = '') {
  const m = String(companyUrl).match(/linkedin\.com\/company\/([^/?#]+)/i);
  if (!m) return null;
  const ref = decodeURIComponent(m[1]);
  return /^\d+$/.test(ref) ? { id: ref } : { slug: ref };
}

export function linkedInCompanyAboutUrl(companyUrl = '') {
  const m = String(companyUrl).match(/linkedin\.com\/company\/([^/?#]+)/i);
  if (m) return `https://www.linkedin.com/company/${m[1]}/about/`;
  return companyUrl || null;
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const EMAIL_IN_TEXT_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/** Coordonnées depuis le HTML de l'ancien overlay (pages Ember). */
export function parseContactInfoHtml(html = '') {
  const h = String(html);
  const emails = new Set();
  const phones = new Set();
  for (const m of h.matchAll(/mailto:([^"'?\s<>\\]+)/gi)) emails.add(decodeEntities(decodeJsonString(m[1])).toLowerCase());
  for (const m of h.matchAll(/"emailAddress"\s*:\s*"([^"]+)"/g)) emails.add(decodeJsonString(m[1]).toLowerCase());
  for (const m of h.matchAll(/href="tel:([^"]+)"/gi)) phones.add(decodeEntities(m[1]));
  const pn = h.match(/"phoneNumbers"\s*:\s*\[([\s\S]*?)\]/);
  if (pn) for (const m of pn[1].matchAll(/"number"\s*:\s*"([^"]+)"/g)) phones.add(decodeJsonString(m[1]));
  return {
    emails: [...emails].filter((e) => EMAIL_RE.test(e)),
    phones: [...phones].map((p) => p.trim()).filter(Boolean),
  };
}

/**
 * Coordonnées depuis la réponse RSC (nouvelle interface) de l'overlay « Coordonnées » :
 * flux texte contenant des fragments JSON ("url":"mailto:…", "children":["+33 …"]).
 */
export function parseContactRsc(text = '') {
  const t = decodeJsonString(String(text));
  const emails = new Set();
  const phones = new Set();
  const websites = new Set();
  for (const m of t.matchAll(/"url"\s*:\s*"mailto:([^"?]+)/g)) emails.add(m[1].toLowerCase());
  for (const m of t.matchAll(/"url"\s*:\s*"tel:([^"]+)"/g)) phones.add(m[1]);
  for (const m of t.matchAll(/"url"\s*:\s*"(https?:[^"]+)"/g)) if (isExternal(m[1])) websites.add(m[1]);
  for (const m of t.matchAll(/"children"\s*:\s*\[\s*"([^"]{3,120})"\s*\]/g)) {
    const s = m[1].trim();
    for (const e of s.match(EMAIL_IN_TEXT_RE) || []) emails.add(e.toLowerCase());
    const digits = s.replace(/\D/g, '');
    if (digits.length >= 8 && digits.length <= 15 && /^[+(]?\d[\d\s().-]+$/.test(s)) phones.add(s);
  }
  return {
    emails: [...emails].filter((e) => EMAIL_RE.test(e)),
    phones: [...phones].map((p) => p.trim()).filter(Boolean),
    websites: [...websites],
  };
}
