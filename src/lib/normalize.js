// Fonctions pures de normalisation (testables sous Node, sans dépendance à chrome.*)

export function stripAccents(s = '') {
  return String(s).normalize('NFD').replace(/\p{M}/gu, '');
}

// Formes juridiques retirées en tête/queue du nom de société (pour comparaison et email générique)
const FORMS =
  'sasu|sas|sa|sarl|eurl|sci|snc|scop|sca|selarl|sel|gie|gmbh|ltd|inc|llc|plc|bv|nv|ag|co|cie|company|corp|corporation|limited';
const LEAD_RE = new RegExp(`^(?:${FORMS})(?:\\s+|$)`, 'i');
const TRAIL_RE = new RegExp(`(?:^|\\s+)(?:${FORMS})$`, 'i');

export function cleanCompanyName(name = '') {
  let s = stripAccents(name).replace(/\./g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  for (let i = 0; i < 3; i++) {
    const before = s;
    s = s.replace(LEAD_RE, '').replace(TRAIL_RE, '').trim();
    if (s === before) break;
  }
  return s.replace(/\s+/g, ' ');
}

export function companyNameKey(name = '') {
  return cleanCompanyName(name).toLowerCase().replace(/\s/g, '');
}

export function slugPart(s = '') {
  return stripAccents(s).toLowerCase().replace(/[^a-z0-9]+/g, '');
}

export function buildGenericEmail({ firstName = '', lastName = '', company = '', domain }) {
  const parts = [slugPart(firstName), slugPart(lastName), slugPart(cleanCompanyName(company))].filter(Boolean);
  return `${parts.join('.')}@${domain}`;
}

// Sépare "Jean Dupont (He/Him), PhD" -> { firstName: 'Jean', lastName: 'Dupont' }
export function splitFullName(fullName = '') {
  const cleaned = String(fullName)
    .replace(/\(.*?\)/g, ' ')
    .split(',')[0]
    .replace(/[^\p{L}\p{M}\p{N}\s'’-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const parts = cleaned.split(' ').filter(Boolean);
  return { firstName: parts[0] || '', lastName: parts.slice(1).join(' ') };
}

// ---------- Téléphones ----------

export function normalizePhone(raw) {
  if (!raw) return null;
  let s = String(raw).trim().replace(/[^\d+]/g, '');
  if (s.startsWith('00')) s = '+' + s.slice(2);
  if (/^\+330\d{9}$/.test(s)) s = '+33' + s.slice(4); // "+33 (0)1 23 45 67 89"
  if (s.startsWith('+')) {
    const d = s.slice(1);
    if (/^\d{8,15}$/.test(d)) return '+' + d;
    return null;
  }
  if (/^0[1-9]\d{8}$/.test(s)) return '+33' + s.slice(1);
  return null;
}

const PHONE_RE =
  /(?:\+|00) ?33[ .\-]?(?:\(0\)[ .\-]?)?[1-9](?:[ .\-]?\d{2}){4}(?![ .\-]?\d)|(?<!\d)0[1-9](?:[ .\-]?\d{2}){4}(?![ .\-]?\d)|\+(?!33)\d{1,3}[ .\-]?\(?\d{1,4}\)?(?:[ .\-]?\d){5,10}(?![ .\-]?\d)/g;

export function extractPhones(text = '') {
  const out = [];
  // Espaces insécables / tabulations → espace ; les sauts de ligne restent des séparateurs de numéros
  const t = String(text).replace(/[^\S\n]/g, ' ');
  for (const m of t.matchAll(PHONE_RE)) {
    const p = normalizePhone(m[0]);
    if (p && !out.includes(p)) out.push(p);
  }
  return out;
}

// Standard (01–05, 09) > mobile (06/07) > numéros spéciaux (08) > étranger
export function phoneRank(p) {
  if (!p.startsWith('+33')) return 4;
  const d = p[3];
  if ('12345'.includes(d) || d === '9') return 0;
  if (d === '6' || d === '7') return 1;
  if (d === '8') return 3;
  return 2;
}

export function pickBestPhone(phones = []) {
  if (!phones.length) return null;
  return [...phones].sort((a, b) => phoneRank(a) - phoneRank(b))[0];
}

// ---------- SIREN / SIRET ----------

export function luhnValid(digits) {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

const SEP = '[\\s.-]?';
const NINE = `((?:\\d${SEP}){8}\\d)`;
const SIRET_TAIL = `(?:${SEP}((?:\\d${SEP}){4}\\d))?`;
const SIREN_LABEL_RE = new RegExp(`(?:siren|siret|r\\s?\\.?\\s?c\\s?\\.?\\s?s)\\b[^0-9]{0,60}?${NINE}${SIRET_TAIL}`, 'gi');
const VAT_RE = new RegExp(`\\bFR\\s?[0-9A-Z]{2}\\s?${NINE}(?!\\d)`, 'g');
const SIRET_PLAIN_RE = /(?<!\d)(\d{3})[\s.]?(\d{3})[\s.]?(\d{3})[\s.]?(\d{5})(?!\d)/g;

function onlyDigits(s = '') {
  return String(s).replace(/\D/g, '');
}

export function extractSiren(text = '') {
  const t = String(text);
  for (const m of t.matchAll(SIREN_LABEL_RE)) {
    const siren = onlyDigits(m[1]);
    if (siren.length === 9 && luhnValid(siren)) {
      const tail = onlyDigits(m[2] || '');
      return { siren, siret: tail.length === 5 ? siren + tail : null };
    }
  }
  for (const m of t.matchAll(VAT_RE)) {
    const siren = onlyDigits(m[1]);
    if (luhnValid(siren)) return { siren, siret: null };
  }
  for (const m of t.matchAll(SIRET_PLAIN_RE)) {
    const siren = m[1] + m[2] + m[3];
    const siret = siren + m[4];
    if (luhnValid(siren) && luhnValid(siret)) return { siren, siret };
  }
  return null;
}

// ---------- Adresses ----------

export function departementFromCP(cp = '') {
  const d = String(cp).replace(/\D/g, '');
  if (d.length < 2) return '';
  if (d.startsWith('97') || d.startsWith('98')) return d.slice(0, 3);
  if (d.startsWith('20') && d.length === 5) {
    const n = Number(d);
    return n < 20200 ? '2A' : '2B';
  }
  return d.slice(0, 2);
}

// ---------- URLs ----------

export function normalizeSiteUrl(u = '') {
  let s = String(u).trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s.replace(/^\/+/, '');
  try {
    const url = new URL(s);
    if (!url.hostname.includes('.')) return null;
    return url.toString();
  } catch {
    return null;
  }
}

export function domainOf(u = '') {
  try {
    const url = new URL(/^https?:\/\//i.test(u) ? u : 'https://' + u);
    return url.hostname.replace(/^www\./i, '').toLowerCase();
  } catch {
    return '';
  }
}

export function formatNumberFR(n) {
  if (n == null || !Number.isFinite(Number(n))) return '';
  return Number(n).toLocaleString('fr-FR');
}
