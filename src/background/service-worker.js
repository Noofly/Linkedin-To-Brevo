// Orchestrateur : reçoit ADD_CONTACT du content script, pilote Brevo / annuaire / site web, ouvre la fiche Brevo
import {
  BrevoClient,
  CONTACT_ATTRS_CACHE_KEY,
  buildCompanyAttributes,
  contactUrl,
  ensureContactAttributes,
  findCompany,
  formatContactValue,
  resolveCompanyAttributes,
} from '../lib/brevo.js';
import { crawlSite } from '../lib/website.js';
import { getCompanyInfo } from '../lib/company-data.js';
import { buildGenericEmail, domainOf, formatNumberFR, normalizePhone, normalizeSiteUrl } from '../lib/normalize.js';
import { extractCompanyWebsite, linkedInCompanyAboutUrl, linkedInCompanyRef } from '../lib/linkedin.js';
import { getCache, getSettings, setCache } from '../lib/settings.js';

chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'ADD_CONTACT') {
    handleAddContact(msg.profile || {}, sender.tab?.id)
      .then((r) => sendResponse({ ok: true, ...r }))
      .catch((e) => {
        console.error('[LinkedIn→Brevo]', e);
        sendResponse({ ok: false, error: e?.message || String(e), code: e?.code });
      });
    return true;
  }
  if (msg?.type === 'OPEN_OPTIONS') {
    chrome.runtime.openOptionsPage();
  }
  return false;
});

async function handleAddContact(profile, tabId) {
  const report = (step, status, message, extra = {}) =>
    chrome.tabs.sendMessage(tabId, { type: 'PROGRESS', step, status, message, ...extra }).catch(() => {});
  const ask = (payload) => chrome.tabs.sendMessage(tabId, { type: 'ASK', ...payload });
  const fetchViaTab = async (url) => {
    const r = await chrome.tabs.sendMessage(tabId, { type: 'FETCH_SAME_ORIGIN', url });
    if (!r?.ok) throw new Error(r?.error || `HTTP ${r?.status || '?'}`);
    return r.text;
  };
  const warnings = [];

  const settings = await getSettings();
  if (!settings.apiKey) throw new Error("Clé API Brevo manquante : ouvrez les options de l'extension.");
  const client = new BrevoClient(settings.apiKey);

  // 1. Attributs Brevo
  report('prepare', 'running', 'Vérification des attributs Brevo…');
  let contactAttrs = await getCache(CONTACT_ATTRS_CACHE_KEY);
  if (!contactAttrs) {
    const { map, created } = await ensureContactAttributes(client, { create: settings.autoCreateAttributes });
    contactAttrs = map;
    await setCache(CONTACT_ATTRS_CACHE_KEY, map);
    if (created.length) warnings.push(`Attributs contact créés dans Brevo : ${created.join(', ')}`);
  }
  let companyAttrDefs = await getCache('companyAttrs');
  if (!companyAttrDefs) {
    companyAttrDefs = await client.getCompanyAttributes();
    await setCache('companyAttrs', companyAttrDefs);
  }
  const companyAttrMap = resolveCompanyAttributes(companyAttrDefs || []);
  const companyLabel = (internalName) =>
    (companyAttrDefs || []).find((d) => d.internalName === internalName)?.label || internalName;
  report('prepare', 'done', 'Attributs Brevo OK');

  // 2. Site web de la société
  report('website', 'running', 'Recherche du site web de la société…');
  let website = profile.companyWebsite ? normalizeSiteUrl(profile.companyWebsite) : null;
  if (!website && profile.companyLinkedInUrl) {
    try {
      const html = await fetchViaTab(linkedInCompanyAboutUrl(profile.companyLinkedInUrl));
      website = extractCompanyWebsite(html, linkedInCompanyRef(profile.companyLinkedInUrl) || {});
    } catch (e) {
      warnings.push(`Page LinkedIn de la société inaccessible : ${e.message}`);
    }
  }
  if (!website) {
    const a = await ask({
      kind: 'input',
      title: 'Site web de la société',
      message: `Site web de « ${profile.company || '?'} » introuvable. Indiquez-le (laisser vide pour continuer sans).`,
      placeholder: 'https://www.exemple.fr',
    });
    website = a?.value ? normalizeSiteUrl(a.value) : null;
  }
  report('website', website ? 'done' : 'warn', website || 'Aucun site web connu');

  // 3. Coordonnées
  const email = (profile.email || '').trim().toLowerCase() || null;
  const phone = profile.phone ? normalizePhone(profile.phone) : null;
  if (profile.phone && !phone) warnings.push(`Téléphone LinkedIn non reconnu : ${profile.phone}`);
  const needPhone = !email && !phone;
  let companyPhone = null;
  let crawl = null;
  if (website) {
    report('phone', 'running', needPhone ? "Recherche d'un téléphone sur le site de la société…" : 'Recherche du SIREN sur le site…');
    crawl = await crawlSite(website, {
      wantPhone: needPhone,
      wantSiren: true,
      onPage: (u) => report('phone', 'running', `Lecture de ${u}`),
    });
    if (needPhone) companyPhone = crawl.phone;
  }
  if (email || phone) report('phone', 'done', [email, phone].filter(Boolean).join(' · '));
  else if (companyPhone) report('phone', 'done', `Téléphone société trouvé : ${companyPhone} (${crawl.phoneSource})`);
  else report('phone', 'warn', 'Aucune coordonnée : email générique + Qualifié = Non');

  const qualified = email || phone || companyPhone ? 'Oui' : 'Non';
  const identifierEmail =
    email ||
    buildGenericEmail({
      firstName: profile.firstName,
      lastName: profile.lastName,
      company: profile.company,
      domain: settings.genericDomain,
    });

  // 4. Société dans Brevo
  report('company', 'running', 'Recherche de la société dans Brevo…');
  let company = profile.company ? await findCompany(client, { name: profile.company, domain: website ? domainOf(website) : null }) : null;
  const companyName = company?.attributes?.name || (profile.company || '').trim();
  report('company', company ? 'done' : 'running', company ? `Société existante : ${companyName}` : 'Société absente : elle sera créée');

  // 5. Contact
  report('contact', 'running', 'Création du contact…');
  const attrValues = {
    firstName: profile.firstName,
    lastName: profile.lastName,
    jobTitle: profile.title,
    company: companyName,
    language: (profile.language || settings.defaultLang || 'fr').toLowerCase(),
    qualified,
    companyPhone,
    linkedin: profile.url,
    // Booléen Brevo TUTOIEMENT : faux par défaut, coché dans le panneau si le contact se tutoie
    tutoiement: Boolean(profile.tutoiement),
  };
  const attributes = {};
  for (const [field, val] of Object.entries(attrValues)) {
    const def = contactAttrs[field];
    if (!def) continue;
    const v = formatContactValue(def, val);
    if (v != null) attributes[def.name] = v;
  }
  if (phone) attributes.SMS = phone;

  let existing = await client.getContact(identifierEmail);
  if (!existing && profile.slug) existing = await client.getContact(profile.slug, 'ext_id');
  let contactId;
  let alreadyExisted = false;
  if (existing) {
    contactId = existing.id;
    alreadyExisted = true;
    // Contact existant : on complète uniquement les attributs vides, sans écraser ce qui est déjà renseigné
    const cur = existing.attributes || {};
    const gaps = Object.fromEntries(Object.entries(attributes).filter(([k]) => cur[k] == null || cur[k] === ''));
    let filled = [];
    if (Object.keys(gaps).length) {
      try {
        await client.updateContact(contactId, { attributes: gaps });
        filled = Object.keys(gaps);
      } catch (e) {
        warnings.push(`Attributs du contact existant non complétés : ${e.message}`);
      }
    }
    report(
      'contact',
      'done',
      `Contact déjà présent dans Brevo (${existing.email || existing.id})${filled.length ? ` — complété : ${filled.join(', ')}` : ''}`
    );
  } else {
    const body = { email: identifierEmail, attributes, updateEnabled: false };
    if (profile.slug) body.ext_id = profile.slug;
    let created;
    try {
      created = await client.createContact(body);
    } catch (e) {
      if (e.code === 'duplicate_parameter' && attributes.SMS) {
        const sms = attributes.SMS;
        delete attributes.SMS;
        const cp = contactAttrs.companyPhone;
        if (cp && !attributes[cp.name]) attributes[cp.name] = sms;
        warnings.push(`Le numéro ${sms} est déjà utilisé par un autre contact Brevo : stocké en attribut texte.`);
        created = await client.createContact(body);
      } else throw e;
    }
    contactId = created?.id;
    if (!contactId) {
      const again = await client.getContact(identifierEmail);
      contactId = again?.id;
    }
    if (!contactId) throw new Error('Brevo n\'a pas renvoyé d\'identifiant de contact.');
    report('contact', 'done', `Contact créé : ${identifierEmail}`);
  }

  // 6. Société : création / liaison
  if (companyName) {
    if (!company) {
      const attrs = {};
      const wd = companyAttrMap.website;
      if (website && wd) attrs[wd.internalName] = domainOf(website);
      const created = await client.createCompany({ name: companyName, attributes: attrs, linkedContactsIds: [contactId] });
      company = { id: created.id, attributes: { name: companyName, ...attrs }, linkedContactsIds: [contactId], fresh: true };
      report('company', 'done', `Société créée : ${companyName}`);
    } else if (!(company.linkedContactsIds || []).includes(contactId)) {
      await client.linkContacts(company.id, [contactId]);
      report('company', 'done', `Contact rattaché à « ${companyName} »`);
    }
  } else {
    report('company', 'warn', 'Aucun nom de société : étape ignorée');
  }

  // 7. Enrichissement société (annuaire des entreprises + BODACC) — non bloquant : le contact existe déjà à ce stade
  let infoSummary = null;
  try {
    infoSummary = await enrichCompany({ client, company, companyName, profile, website, crawl, companyAttrMap, companyLabel, report, ask, warnings });
  } catch (e) {
    console.error('[LinkedIn→Brevo] enrichissement', e);
    warnings.push(`Enrichissement société : ${e.message}`);
    report('enrich', 'error', e.message);
  }

  // 8. Ouvrir la fiche Brevo
  const url = contactUrl(contactId);
  report('open', 'running', 'Ouverture de la fiche Brevo…');
  try {
    await chrome.tabs.create({ url, active: true });
    report('open', 'done', url);
  } catch (e) {
    warnings.push(`Ouverture de l'onglet Brevo impossible : ${e.message}`);
    report('open', 'warn', url);
  }

  return { contactId, url, alreadyExisted, email: identifierEmail, companyName, companyId: company?.id || null, info: infoSummary, warnings };
}

async function enrichCompany({ client, company, companyName, profile, website, crawl, companyAttrMap, companyLabel, report, ask, warnings }) {
  report('enrich', 'running', "Recherche dans l'annuaire des entreprises…");
  let info = null;
  try {
    info = await getCompanyInfo({ siren: crawl?.siren || null, name: companyName || profile.company });
    if (info?.candidates) {
      // Pas de correspondance sûre : on ne devine pas, on demande
      const c = info.candidates;
      info = null;
      if (c.length) {
        report('enrich', 'running', 'Plusieurs entreprises possibles : choix à confirmer');
        const a = await ask({
          kind: 'choice',
          title: 'Quelle entreprise ?',
          message: `Aucune correspondance exacte pour « ${companyName || profile.company} » dans l'annuaire des entreprises. Choisissez la bonne, ou « Aucune » pour ne pas enrichir.`,
          options: c.map((x) => ({
            value: x.siren,
            label: x.nom,
            detail: [`SIREN ${x.siren}`, [x.codePostal, x.ville].filter(Boolean).join(' '), x.etatAdministratif === 'C' ? 'cessée' : null].filter(Boolean).join(' · '),
          })),
          no: 'Aucune',
        });
        if (a?.value) info = await getCompanyInfo({ siren: a.value });
      }
    }
  } catch (e) {
    warnings.push(`Annuaire des entreprises : ${e.message}`);
  }
  if (!info) {
    report('enrich', 'warn', "Société introuvable dans l'annuaire des entreprises");
    return null;
  }
  const infoSummary = {
    siren: info.siren,
    nom: info.nom,
    effectif: info.effectifLabel ? `${info.effectifLabel}${info.effectifAnnee ? ` (${info.effectifAnnee})` : ''}` : null,
    ca: info.ca != null ? `${formatNumberFR(info.ca)} €${info.caAnnee ? ` (${info.caAnnee})` : ''}` : null,
    statut: info.statut,
    procedure: info.procedure?.label || null,
    departement: info.departement,
    ville: info.ville,
    annuaireUrl: info.annuaireUrl,
    societeUrl: info.societeUrl,
    sirenSource: crawl?.sirenSource || null,
  };
  if (info.procedureError) warnings.push(`BODACC injoignable : ${info.procedureError}`);
  if (!company) {
    report('enrich', 'warn', `Infos trouvées (SIREN ${info.siren}) mais aucune société Brevo à mettre à jour`);
    return infoSummary;
  }

  const { values, missing, rows } = buildCompanyAttributes(companyAttrMap, info, website);
  if (missing.length) {
    warnings.push(`Attributs société absents dans Brevo (à créer dans Brevo → Entreprises → Attributs) : ${missing.join(', ')}`);
  }
  const current = company.attributes || {};
  const websiteKey = companyAttrMap.website?.internalName;
  // Brevo impose l'unicité du domaine, y compris contre la société elle-même : ne pas le renvoyer s'il est déjà renseigné
  if (websiteKey && values[websiteKey] && current[websiteKey]) delete values[websiteKey];
  // Valeurs déjà identiques : rien à écrire, rien à demander
  for (const k of Object.keys(values)) if (current[k] != null && String(current[k]) === String(values[k])) delete values[k];
  if (!Object.keys(values).length) {
    report('enrich', 'done', 'Société déjà à jour dans Brevo');
    return infoSummary;
  }
  const conflicts = Object.keys(values).filter((k) => k !== websiteKey && current[k] != null && current[k] !== '');
  let doUpdate = true;
  if (doUpdate && conflicts.length && !company.fresh) {
    const a = await ask({
      kind: 'confirm',
      title: 'Mettre à jour la société ?',
      message: `« ${companyName} » a déjà des informations dans Brevo. Les remplacer par celles de l'annuaire (SIREN ${info.siren}) ?`,
      rows: conflicts.map((k) => ({ label: companyLabel(k), current: String(current[k]), next: String(values[k]) })),
      links: [
        { label: 'annuaire-entreprises.data.gouv.fr', url: info.annuaireUrl },
        { label: 'societe.com', url: info.societeUrl },
      ],
      yes: 'Mettre à jour',
      no: 'Ne rien faire',
    });
    doUpdate = !!a?.value;
  }
  if (!doUpdate) {
    report('enrich', conflicts.length ? 'done' : 'warn', conflicts.length ? 'Infos société conservées (pas de mise à jour)' : 'Aucun attribut société exploitable dans Brevo');
    return infoSummary;
  }
  try {
    await client.updateCompany(company.id, { attributes: values });
  } catch (e) {
    if (websiteKey && values[websiteKey] && /domain/i.test(e.message || '')) {
      warnings.push(`Domaine ${values[websiteKey]} déjà utilisé par une autre société Brevo : non modifié.`);
      delete values[websiteKey];
      if (Object.keys(values).length) await client.updateCompany(company.id, { attributes: values });
    } else throw e;
  }
  const written = rows.filter((r) => r.internalName in values);
  report('enrich', 'done', written.map((r) => `${r.label} : ${r.value}`).join(' · ') || 'Aucune donnée à écrire');
  return infoSummary;
}
