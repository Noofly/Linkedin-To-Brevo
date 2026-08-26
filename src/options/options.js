import {
  BrevoClient,
  COMPANY_FIELDS,
  CONTACT_ATTRS_CACHE_KEY,
  CONTACT_FIELDS,
  ensureContactAttributes,
  listAllContacts,
  resolveCompanyAttributes,
} from '../lib/brevo.js';
import { findLinkedInProfile, isLinkedInLoggedOut, profileUrlFromSlug, slugFromExtId } from '../lib/linkedin-search.js';
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
    await setCache(CONTACT_ATTRS_CACHE_KEY, map);
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

// ---------- Mise à jour des URL LinkedIn des contacts existants ----------

const upd = { running: false, stop: false };
const updMsg = $('updMsg');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sayUpd(text, kind = '') {
  updMsg.textContent = text;
  updMsg.className = `msg ${kind}`;
}

function link(href, text) {
  const a = document.createElement('a');
  a.href = href;
  a.target = '_blank';
  a.rel = 'noopener';
  a.textContent = text;
  return a;
}

/** fetch LinkedIn depuis la page d'options (cookies envoyés grâce aux host_permissions), cadencé, avec détection de session absente. */
function linkedInFetcher({ minGapMs = 2500, jitterMs = 1500 } = {}) {
  let last = 0;
  let count = 0;
  const fatal = (message) => Object.assign(new Error(message), { fatal: true });
  return {
    get count() {
      return count;
    },
    async fetchHtml(url) {
      const wait = last + minGapMs + Math.random() * jitterMs - Date.now();
      if (wait > 0) await sleep(wait);
      last = Date.now();
      count++;
      const r = await fetch(url, { credentials: 'include' });
      if (r.status === 429) throw fatal('LinkedIn limite les requêtes (HTTP 429) : réessayez plus tard.');
      const html = await r.text();
      if (isLinkedInLoggedOut({ url: r.url, html })) {
        throw fatal('Session LinkedIn absente : connectez-vous à LinkedIn dans ce navigateur puis relancez.');
      }
      if (!r.ok) throw new Error(`LinkedIn HTTP ${r.status}`);
      return html;
    },
  };
}

const STATUS_LABELS = {
  running: 'Recherche…',
  written: 'Enregistré',
  proposed: 'À confirmer',
  none: 'Introuvable',
  skipped: 'Ignoré',
  error: 'Erreur',
};

function resultsTable(box) {
  const t = document.createElement('table');
  t.innerHTML = '<thead><tr><th>Contact</th><th>Société</th><th>Résultat</th><th>URL LinkedIn</th></tr></thead>';
  const tb = document.createElement('tbody');
  t.append(tb);
  box.append(t);
  return {
    add(info) {
      const tr = document.createElement('tr');
      const cell = () => {
        const td = document.createElement('td');
        tr.append(td);
        return td;
      };
      const who = cell();
      const fullName = [info.firstName, info.lastName].filter(Boolean).join(' ');
      who.textContent = fullName || info.email || `#${info.id}`;
      if (fullName && info.email) {
        const s = document.createElement('small');
        s.textContent = info.email;
        who.append(document.createElement('br'), s);
      }
      cell().textContent = info.company || '';
      const status = cell();
      const result = cell();
      tb.append(tr);
      const row = {
        set(st, url, note) {
          status.textContent = STATUS_LABELS[st] || st;
          status.className = `st st-${st}`;
          result.replaceChildren();
          if (url) result.append(link(url, url.replace(/^https:\/\/www\.linkedin\.com/, '')));
          if (note) {
            const s = document.createElement('small');
            s.textContent = `${url ? ' — ' : ''}${note}`;
            result.append(s);
          }
        },
        propose(candidates, write) {
          row.set('proposed', null, candidates.length > 1 ? 'plusieurs profils possibles' : 'nom seul, société non confirmée');
          const ul = document.createElement('ul');
          ul.className = 'cands';
          for (const p of candidates) {
            const li = document.createElement('li');
            const b = document.createElement('button');
            b.textContent = 'Utiliser';
            b.onclick = async () => {
              b.disabled = true;
              try {
                await write(p.url);
                row.set('written', p.url, p.headline);
              } catch (e) {
                b.disabled = false;
                b.textContent = `Réessayer (${e.message})`;
              }
            };
            li.append(b, ' ', link(p.url, p.name), ` — ${[p.headline, p.location].filter(Boolean).join(' · ')}`);
            ul.append(li);
          }
          result.append(ul);
        },
      };
      return row;
    },
  };
}

async function updateLinkedInUrls() {
  if (upd.running) return;
  upd.running = true;
  upd.stop = false;
  $('updateLinkedin').disabled = true;
  $('stopUpdate').hidden = false;
  const box = $('updResults');
  box.replaceChildren();
  try {
    const s = await getSettings();
    const c = new BrevoClient(s.apiKey);
    sayUpd('Lecture des attributs Brevo…');
    const { map } = await ensureContactAttributes(c, { create: false });
    const need = ['linkedin', 'firstName', 'lastName'].filter((f) => !map[f]);
    if (need.length) {
      throw new Error(`Attributs contact absents dans Brevo : ${need.map((f) => CONTACT_FIELDS[f].label).join(', ')} — cliquez sur « Vérifier les attributs ».`);
    }
    const attr = (ct, field) => String((map[field] && ct.attributes?.[map[field].name]) ?? '').trim();

    const contacts = await listAllContacts(c, { onPage: (n, total) => sayUpd(`Lecture des contacts Brevo… ${n}/${total}`) });
    const todo = contacts.filter((ct) => !attr(ct, 'linkedin'));
    if (!todo.length) {
      sayUpd(`${contacts.length} contacts : tous ont déjà une URL LinkedIn.`, 'ok');
      return;
    }
    const maxSearches = Math.max(1, Number($('maxSearches').value) || 50);
    const li = linkedInFetcher();
    const table = resultsTable(box);
    const stats = { written: 0, proposed: 0, none: 0, skipped: 0, errors: 0 };
    const progress = (i) =>
      sayUpd(
        `${i}/${todo.length} — enregistrés : ${stats.written}, à confirmer : ${stats.proposed}, introuvables : ${stats.none}, ignorés : ${stats.skipped}, erreurs : ${stats.errors} (${li.count} recherches LinkedIn)`
      );
    let searched = 0;
    let i = 0;
    for (const ct of todo) {
      if (upd.stop) break;
      i++;
      const info = { id: ct.id, email: ct.email, firstName: attr(ct, 'firstName'), lastName: attr(ct, 'lastName'), company: attr(ct, 'company') };
      const row = table.add(info);
      const write = (url) => c.updateContact(ct.id, { attributes: { [map.linkedin.name]: url } });
      try {
        const slug = slugFromExtId(ct.attributes?.EXT_ID);
        if (slug) {
          const url = profileUrlFromSlug(slug);
          await write(url);
          row.set('written', url, 'depuis EXT_ID');
          stats.written++;
        } else if (!info.firstName || !info.lastName) {
          row.set('skipped', null, 'prénom ou nom manquant');
          stats.skipped++;
        } else if (searched >= maxSearches) {
          row.set('skipped', null, 'quota de recherches atteint pour ce passage');
          stats.skipped++;
        } else {
          row.set('running');
          progress(i - 1);
          searched++;
          const r = await findLinkedInProfile(info, li.fetchHtml);
          if (r.status === 'found' && r.confidence === 'haute') {
            await write(r.profile.url);
            row.set('written', r.profile.url, r.profile.headline);
            stats.written++;
          } else if (r.status === 'found') {
            row.propose([r.profile], write);
            stats.proposed++;
          } else if (r.status === 'ambiguous') {
            row.propose(r.candidates, write);
            stats.proposed++;
          } else {
            row.set('none', null, `aucun résultat pour « ${r.searched.join(' » / « ')} »`);
            stats.none++;
          }
        }
      } catch (e) {
        row.set('error', null, e.message);
        stats.errors++;
        if (e.fatal) throw e;
      }
      progress(i);
    }
    const summary = `enregistrés ${stats.written}, à confirmer ${stats.proposed}, introuvables ${stats.none}, ignorés ${stats.skipped}, erreurs ${stats.errors} (${li.count} recherches LinkedIn)`;
    if (upd.stop) sayUpd(`Arrêté après ${i}/${todo.length} contacts — ${summary}.`);
    else sayUpd(`Terminé : ${todo.length} contacts sans URL traités — ${summary}.`, stats.errors ? '' : 'ok');
  } catch (e) {
    sayUpd(`Échec : ${e.message}`, 'error');
  } finally {
    upd.running = false;
    $('updateLinkedin').disabled = false;
    $('stopUpdate').hidden = true;
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
$('updateLinkedin').addEventListener('click', async () => {
  await save();
  await updateLinkedInUrls();
});
$('stopUpdate').addEventListener('click', () => {
  upd.stop = true;
  sayUpd('Arrêt demandé : fin après le contact en cours…');
});
load();
