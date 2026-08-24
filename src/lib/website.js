// Exploration légère du site web d'une société (exécutée dans le service worker : pas de DOMParser → regex)
import { extractPhones, extractSiren, normalizePhone, normalizeSiteUrl, pickBestPhone } from './normalize.js';

export async function fetchText(url, { timeoutMs = 8000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: { Accept: 'text/html,application/xhtml+xml,*/*;q=0.8' },
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const ct = r.headers.get('content-type') || '';
    if (ct && !/html|xml|text/i.test(ct)) throw new Error(`Contenu non HTML (${ct})`);
    return await r.text();
  } finally {
    clearTimeout(t);
  }
}

export function decodeEntities(s = '') {
  return String(s)
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'");
}

export function stripHtml(html = '') {
  return decodeEntities(
    String(html)
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<\/?(?:br|p|div|li|tr|td|th|h[1-6]|section|article|footer|header)\b[^>]*>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/[^\S\n]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}

export function extractLinks(html = '', baseUrl) {
  const out = [];
  for (const m of String(html).matchAll(/<a\b[^>]*?href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const raw = decodeEntities(m[1]).trim();
    if (/^(mailto:|tel:|javascript:|#)/i.test(raw)) continue;
    try {
      const href = new URL(raw, baseUrl).toString();
      out.push({ href, text: stripHtml(m[2]).slice(0, 120) });
    } catch {
      /* lien invalide */
    }
  }
  return out;
}

export function extractTelLinks(html = '') {
  const out = [];
  for (const m of String(html).matchAll(/href\s*=\s*["']tel:([^"']+)["']/gi)) {
    const p = normalizePhone(decodeEntities(m[1]));
    if (p && !out.includes(p)) out.push(p);
  }
  return out;
}

const CONTACT_HINT = /contact|nous-joindre|joindre|coordonn|contactez/i;
const LEGAL_HINT = /mentions?[-_ ]?l[ée]gales?|legal|cgv|cgu|conditions[-_ ]g|imprint|impressum|qui[-_ ]sommes|a[-_ ]propos|apropos|about/i;

function sameHost(href, host) {
  try {
    const h = new URL(href).hostname.replace(/^www\./i, '').toLowerCase();
    return h === host || h.endsWith('.' + host);
  } catch {
    return false;
  }
}

function stripHash(u) {
  return u.split('#')[0];
}

/**
 * Parcourt l'accueil puis les pages contact / mentions légales pour trouver un téléphone et/ou un SIREN.
 * @returns {{phone:string|null, phones:string[], phoneSource:string|null, siren:string|null, siret:string|null, sirenSource:string|null, pages:string[], errors:string[]}}
 */
export async function crawlSite(siteUrl, opts = {}) {
  const { wantPhone = true, wantSiren = true, maxPages = 7, maxAttempts = 12, fetchImpl = fetchText, onPage } = opts;
  const res = { phone: null, phones: [], phoneSource: null, siren: null, siret: null, sirenSource: null, pages: [], errors: [] };
  const start = normalizeSiteUrl(siteUrl);
  if (!start) return res;
  const host = new URL(start).hostname.replace(/^www\./i, '').toLowerCase();

  const guessed = [];
  if (wantSiren) guessed.push('/mentions-legales', '/mentions-legales/', '/mentions_legales', '/mentions-legales.html', '/legal', '/informations-legales', '/cgv');
  if (wantPhone) guessed.push('/contact', '/contact/', '/nous-contacter', '/contactez-nous', '/contact.html');

  const queue = [start];
  const seen = new Set();
  let attempts = 0;
  let triedHttpFallback = false;
  const need = () => (wantPhone && !res.phone) || (wantSiren && !res.siren);

  while (queue.length && res.pages.length < maxPages && attempts < maxAttempts && need()) {
    const url = queue.shift();
    if (seen.has(url)) continue;
    seen.add(url);
    attempts++;
    let html;
    try {
      html = await fetchImpl(url);
    } catch (e) {
      res.errors.push(`${url}: ${e.message}`);
      if (res.pages.length === 0 && !triedHttpFallback && url.startsWith('https://')) {
        triedHttpFallback = true;
        queue.unshift(url.replace(/^https:\/\//, 'http://'));
      }
      continue;
    }
    res.pages.push(url);
    onPage?.(url);
    const text = stripHtml(html);

    if (wantPhone && !res.phone) {
      // Sur les mentions légales, les numéros étrangers sont ceux de l'hébergeur : on ne garde que les numéros français
      const legalPage = LEGAL_HINT.test(url);
      const phones = [...extractTelLinks(html), ...extractPhones(text)]
        .filter((p, i, a) => a.indexOf(p) === i)
        .filter((p) => !legalPage || p.startsWith('+33'));
      if (phones.length) {
        res.phones = phones;
        res.phone = pickBestPhone(phones);
        res.phoneSource = url;
      }
    }
    if (wantSiren && !res.siren) {
      const s = extractSiren(text);
      if (s) {
        res.siren = s.siren;
        res.siret = s.siret;
        res.sirenSource = url;
      }
    }
    if (!need()) break;

    const links = extractLinks(html, url).filter((l) => sameHost(l.href, host));
    const wanted = links.filter((l) => {
      const hay = `${l.href} ${l.text}`;
      return (wantSiren && !res.siren && LEGAL_HINT.test(hay)) || (wantPhone && !res.phone && CONTACT_HINT.test(hay));
    });
    for (const l of wanted) {
      const u = stripHash(l.href);
      if (!seen.has(u) && !queue.includes(u)) queue.push(u);
    }
    if (res.pages.length === 1) {
      for (const p of guessed) {
        const u = new URL(p, start).toString();
        if (!seen.has(u) && !queue.includes(u)) queue.push(u);
      }
    }
  }
  return res;
}
