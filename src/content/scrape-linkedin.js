// Extraction d'une fiche profil linkedin.com/in/<slug>
// Nouvelle interface LinkedIn (cartes SDUI "com.linkedin.sdui.profile.card.*") avec repli sur l'ancienne (Ember).
// Aucune interaction avec la page (pas de clic) : coordonnées obtenues par l'appel serveur que fait l'overlay lui-même.
import { parseContactInfoHtml, parseContactRsc } from '../lib/linkedin.js';
import { extractPhones, splitFullName } from '../lib/normalize.js';

const LOG = '[LinkedIn→Brevo]';
const DATE_RE = /\b(?:19|20)\d{2}\b|aujourd|present|présent|actuel|\d+\s*(?:ans|mois|yrs?|mos?)\b/i;

export function isLinkedInProfileUrl(url) {
  return /^https:\/\/www\.linkedin\.com\/in\/[^/?#]+/.test(url);
}

export function profileSlug(url = location.href) {
  const m = String(url).match(/\/in\/([^/?#]+)/);
  return m ? decodeURIComponent(m[1]) : '';
}

const txt = (elm) => (elm?.textContent || '').replace(/\s+/g, ' ').trim();

function csrfToken() {
  const m = document.cookie.match(/JSESSIONID="?([^";]+)"?/);
  return m ? m[1] : null;
}

// ----- Nouvelle interface (SDUI) -----
function sduiCard(suffix) {
  return [...document.querySelectorAll('[id^="com.linkedin.sdui.profile.card."]')].find((e) => e.id.endsWith(suffix)) || null;
}

// Les cartes (Expérience…) sont chargées à la demande au défilement : on fait défiler le conteneur jusqu'à leur apparition.
async function ensureSduiCard(suffix, { maxSteps = 12, step = 800 } = {}) {
  if (sduiCard(suffix)) return true;
  const scroller =
    [...document.querySelectorAll('main, [id="workspace"]')].find((e) => e.scrollHeight > e.clientHeight + 100) ||
    document.scrollingElement;
  const initial = scroller.scrollTop;
  try {
    for (let i = 1; i <= maxSteps && !sduiCard(suffix); i++) {
      scroller.scrollTop = i * step;
      await new Promise((r) => setTimeout(r, 350));
    }
  } finally {
    scroller.scrollTop = initial;
  }
  return Boolean(sduiCard(suffix));
}

function fromSdui() {
  const top = sduiCard('Topcard');
  if (!top) return null;
  const name = txt(top.querySelector('h2'));
  const ps = [...top.querySelectorAll('p')].map(txt).filter(Boolean);
  const afterDegree = ps.filter((p) => !/^·/.test(p) && p !== 'Coordonnées' && p !== 'Contact info');
  const headline = afterDegree[0] || '';
  const topCompanyLine = afterDegree[1] || '';

  let title = '';
  let company = '';
  let companyUrl = null;
  const exp = sduiCard('ExperienceTopLevelSection') || sduiCard('Experience');
  if (exp) {
    const hr = exp.querySelector('hr');
    const before = (el) => !hr || Boolean(el.compareDocumentPosition(hr) & Node.DOCUMENT_POSITION_FOLLOWING);
    const entryPs = [...exp.querySelectorAll('p')].filter(before).map(txt).filter(Boolean);
    if (entryPs.length) {
      if (DATE_RE.test(entryPs[1] || '')) {
        // Plusieurs postes chez la même société : société en tête, puis premier poste
        company = entryPs[0];
        title = entryPs.find((p, i) => i > 1 && !DATE_RE.test(p)) || '';
      } else {
        title = entryPs[0];
        company = (entryPs[1] || '').split('·')[0].trim();
      }
    }
    companyUrl = [...exp.querySelectorAll('a[href*="/company/"]')].find(before)?.href || null;
  }
  if (!company && topCompanyLine) company = topCompanyLine.split('·')[0].trim();
  const { firstName, lastName } = splitFullName(name);
  return { firstName, lastName, headline, title, company, companyLinkedInUrl: companyUrl };
}

async function fromSduiContact(slug) {
  const token = csrfToken();
  if (!token) throw new Error('cookie JSESSIONID introuvable');
  const screenId = 'com.linkedin.sdui.flagshipnav.profile.ProfileContactDetailsOverlay';
  const body = {
    clientArguments: {
      $type: 'proto.sdui.actions.requests.RequestedArguments',
      requestedStateKeys: [],
      payload: { vanityName: slug, isVanityNameResolved: true },
      requestMetadata: { $type: 'proto.sdui.common.RequestMetadata' },
      states: [],
      screenId,
      knownTemplateIds: [],
    },
    isModal: true,
  };
  const r = await fetch(`https://www.linkedin.com/flagship-web/rsc-action/actions/navigation?screenId=${screenId}&sduiid=${screenId}`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'csrf-token': token, 'content-type': 'application/json', accept: '*/*', 'x-li-rsc-stream': 'true' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const { emails, phones } = parseContactRsc(await r.text());
  return { email: emails[0] || '', phone: phones[0] || '' };
}

// ----- Ancienne interface (Ember) -----
function fromEmbeddedJson(slug) {
  const inc = [];
  for (const code of document.querySelectorAll('code')) {
    const t = code.textContent;
    if (!t || !t.includes('"included"')) continue;
    try {
      const j = JSON.parse(t);
      if (Array.isArray(j.included)) inc.push(...j.included);
    } catch {
      /* bloc non JSON */
    }
  }
  const prof = inc.find((o) => o.$type === 'com.linkedin.voyager.dash.identity.profile.Profile' && o.publicIdentifier === slug);
  if (!prof) return null;
  const pid = String(prof.entityUrn || '').split(':').pop();
  const positions = inc.filter(
    (o) => o.$type === 'com.linkedin.voyager.dash.identity.profile.Position' && String(o.entityUrn || '').includes(`(${pid},`)
  );
  const current = positions.find((p) => !p.dateRange?.end) || positions[0];
  const company = current?.['*company'] ? inc.find((o) => o.entityUrn === current['*company']) : null;
  return {
    firstName: prof.firstName || '',
    lastName: prof.lastName || '',
    headline: prof.headline || '',
    language: prof.primaryLocale?.language || '',
    title: current?.title || '',
    company: current?.companyName || company?.name || '',
    companyLinkedInUrl: company?.url || (company?.universalName ? `https://www.linkedin.com/company/${company.universalName}/` : null),
  };
}

function fromLegacyDom() {
  const main = document.querySelector('main') || document;
  const name = txt(main.querySelector('h1'));
  if (!name) return null;
  const headline = txt(main.querySelector('.text-body-medium'));
  let title = '';
  let company = '';
  let companyUrl = null;
  const first = document.getElementById('experience')?.closest('section')?.querySelector('ul > li');
  if (first) {
    const spans = (root) => [...root.querySelectorAll('span[aria-hidden="true"]')].map(txt).filter(Boolean);
    const texts = spans(first);
    const nested = first.querySelector('ul li');
    if (nested) {
      company = texts[0] || '';
      title = spans(nested)[0] || '';
    } else {
      title = texts[0] || '';
      company = (texts[1] || '').split('·')[0].trim();
    }
    companyUrl = first.querySelector('a[href*="/company/"]')?.href || null;
  }
  const { firstName, lastName } = splitFullName(name);
  return { firstName, lastName, headline, title, company, companyLinkedInUrl: companyUrl };
}

function fromOpenDialog() {
  const dlg = document.querySelector('dialog[open] [id$="ContactInfoDetailSection"], .pv-contact-info__contact-type');
  const box = dlg?.closest('dialog, .artdeco-modal, [role="dialog"]');
  if (!box) return null;
  const emails = [...box.querySelectorAll('a[href^="mailto:"]')].map((a) => a.getAttribute('href').replace(/^mailto:/i, '').split('?')[0].toLowerCase());
  const phones = extractPhones(box.innerText || box.textContent || '');
  return { email: emails[0] || '', phone: phones[0] || '' };
}

async function fromLegacyOverlay(slug) {
  const r = await fetch(`https://www.linkedin.com/in/${encodeURIComponent(slug)}/overlay/contact-info/`, { credentials: 'include' });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const { emails, phones } = parseContactInfoHtml(await r.text());
  return { email: emails[0] || '', phone: phones[0] || '' };
}

async function attempt(label, fn, warnings) {
  try {
    const v = await fn();
    console.debug(LOG, label, v);
    return v;
  } catch (e) {
    console.debug(LOG, label, 'échec :', e.message);
    warnings.push(`${label} : ${e.message}`);
    return null;
  }
}

const hasContact = (c) => c && (c.email || c.phone);

export async function scrapeLinkedInProfile() {
  const slug = profileSlug();
  const url = `https://www.linkedin.com/in/${slug}/`;
  const warnings = [];
  const merged = {};
  const merge = (v) => {
    if (v) for (const [k, val] of Object.entries(v)) if (val) merged[k] = val;
  };

  const isSdui = Boolean(sduiCard('Topcard'));
  if (isSdui) {
    await attempt('Chargement de la carte Expérience', () => ensureSduiCard('ExperienceTopLevelSection'), warnings);
    merge(await attempt('Nouvelle interface (DOM)', () => fromSdui(), warnings));
  } else {
    merge(await attempt('Ancienne interface (DOM)', () => fromLegacyDom(), warnings));
    merge(await attempt('JSON embarqué', () => fromEmbeddedJson(slug), warnings));
  }

  let contact = fromOpenDialog();
  if (!hasContact(contact)) {
    contact = isSdui
      ? await attempt('Coordonnées (appel serveur)', () => fromSduiContact(slug), warnings)
      : await attempt('Coordonnées (overlay)', () => fromLegacyOverlay(slug), warnings);
  }
  if (!hasContact(contact) && !isSdui) contact = await attempt('Coordonnées (appel serveur)', () => fromSduiContact(slug), warnings);
  contact = contact || { email: '', phone: '' };

  const language = (merged.language || document.documentElement.lang || '').split(/[-_]/)[0].toLowerCase();
  const profile = {
    source: 'linkedin',
    url,
    slug,
    firstName: merged.firstName || '',
    lastName: merged.lastName || '',
    title: merged.title || merged.headline || '',
    company: merged.company || '',
    companyLinkedInUrl: merged.companyLinkedInUrl || null,
    companyWebsite: '',
    email: contact.email || '',
    phone: contact.phone || '',
    language,
    warnings,
  };
  console.debug(LOG, 'profil extrait', profile);
  return profile;
}
