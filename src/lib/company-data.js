// Données société : API Recherche d'entreprises (data.gouv) + BODACC (procédures collectives)
import { companyNameKey, departementFromCP, stripAccents } from './normalize.js';

export const RECHERCHE_ENTREPRISES = 'https://recherche-entreprises.api.gouv.fr';
export const BODACC = 'https://bodacc-datadila.opendatasoft.com/api/explore/v2.1/catalog/datasets/annonces-commerciales';

// Tranches d'effectif salarié (nomenclature INSEE)
export const TRANCHE_EFFECTIF = {
  NN: { label: 'Unité non employeuse', min: 0 },
  '00': { label: '0 salarié', min: 0 },
  '01': { label: '1 à 2 salariés', min: 1 },
  '02': { label: '3 à 5 salariés', min: 3 },
  '03': { label: '6 à 9 salariés', min: 6 },
  11: { label: '10 à 19 salariés', min: 10 },
  12: { label: '20 à 49 salariés', min: 20 },
  21: { label: '50 à 99 salariés', min: 50 },
  22: { label: '100 à 199 salariés', min: 100 },
  31: { label: '200 à 249 salariés', min: 200 },
  32: { label: '250 à 499 salariés', min: 250 },
  41: { label: '500 à 999 salariés', min: 500 },
  42: { label: '1 000 à 1 999 salariés', min: 1000 },
  51: { label: '2 000 à 4 999 salariés', min: 2000 },
  52: { label: '5 000 à 9 999 salariés', min: 5000 },
  53: { label: '10 000 salariés et plus', min: 10000 },
};

export function effectifInfo(code) {
  if (code == null || code === '') return null;
  return TRANCHE_EFFECTIF[String(code)] || null;
}

async function getJson(url, fetchImpl = fetch) {
  const r = await fetchImpl(url, { headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error(`HTTP ${r.status} (${url})`);
  return r.json();
}

/**
 * Choisit le résultat correspondant à un nom de société : nom identique (formes juridiques ignorées),
 * sinon nom commençant par le nom cherché. Jamais de choix arbitraire : null si ambigu.
 */
export function pickBestMatch(name, results = []) {
  if (!results.length) return null;
  const key = companyNameKey(name);
  if (!key) return null;
  const exact = results.find((r) =>
    [r.nom_complet, r.nom_raison_sociale, r.sigle, ...(r.siege?.liste_enseignes || []), r.siege?.nom_commercial]
      .filter(Boolean)
      .some((n) => companyNameKey(n) === key)
  );
  if (exact) return exact;
  return results.find((r) => companyNameKey(r.nom_complet || '').startsWith(key)) || null;
}

async function rawSearch(q, fetchImpl) {
  const url = `${RECHERCHE_ENTREPRISES}/search?q=${encodeURIComponent(q)}&per_page=10&page=1`;
  const data = await getJson(url, fetchImpl);
  return data.results || [];
}

export function normalizeEntreprise(r) {
  if (!r) return null;
  const finances = r.finances || {};
  const years = Object.keys(finances).sort();
  const lastYear = years.length ? years[years.length - 1] : null;
  const ca = lastYear && finances[lastYear] ? finances[lastYear].ca ?? null : null;
  const siege = r.siege || {};
  const eff = effectifInfo(r.tranche_effectif_salarie);
  return {
    siren: r.siren,
    nom: r.nom_complet || r.nom_raison_sociale || '',
    nomRaisonSociale: r.nom_raison_sociale || '',
    siret: siege.siret || null,
    codePostal: siege.code_postal || '',
    ville: siege.libelle_commune || '',
    departement: siege.departement || departementFromCP(siege.code_postal || ''),
    effectifCode: r.tranche_effectif_salarie ?? null,
    effectifLabel: eff?.label || null,
    effectifMin: eff ? eff.min : null,
    effectifAnnee: r.annee_tranche_effectif_salarie || null,
    ca,
    caAnnee: lastYear,
    resultatNet: lastYear && finances[lastYear] ? finances[lastYear].resultat_net ?? null : null,
    etatAdministratif: r.etat_administratif || null,
    dateFermeture: r.date_fermeture || null,
    natureJuridique: r.nature_juridique || null,
    annuaireUrl: `https://annuaire-entreprises.data.gouv.fr/entreprise/${r.siren}`,
    societeUrl: `https://www.societe.com/cgi-bin/search?champs=${r.siren}`,
  };
}

export async function searchEntreprise({ siren, name, fetchImpl = fetch } = {}) {
  const q = siren || name;
  if (!q) return null;
  const results = await rawSearch(q, fetchImpl);
  const best = siren ? results.find((r) => r.siren === siren) || results[0] : pickBestMatch(name, results);
  return normalizeEntreprise(best);
}

/** Candidats (normalisés) pour un nom, quand aucune correspondance sûre n'existe. */
export async function searchEntreprises({ name, fetchImpl = fetch, limit = 6 } = {}) {
  if (!name) return [];
  return (await rawSearch(name, fetchImpl)).slice(0, limit).map(normalizeEntreprise);
}

// ---------- BODACC ----------

export function classifyNature(nature = '') {
  const n = stripAccents(String(nature)).toLowerCase();
  if (!n) return null;
  if (/cloture|fin de la procedure|mettant fin|extinction du passif|retractation|annulation/.test(n)) return 'Procédure clôturée';
  if (/liquidat/.test(n)) return 'Liquidation';
  if (/redressement|plan de continuation/.test(n)) return 'RJ';
  if (/sauvegarde/.test(n)) return 'Sauvegarde';
  return 'Procédure collective';
}

export function classifyProcedures(records = []) {
  if (!records.length) return { statut: null, label: 'Aucune procédure collective au BODACC', date: null, nature: null };
  const latest = records[0];
  let j = latest.jugement;
  if (typeof j === 'string') {
    try {
      j = JSON.parse(j);
    } catch {
      j = { nature: j };
    }
  }
  const nature = j?.nature || latest.typeavis_lib || latest.familleavis_lib || '';
  const complement = j?.complementJugement || '';
  // La nature est souvent générique ("Autre jugement et ordonnance") : le détail est dans complementJugement
  let statut = classifyNature(nature);
  if ((statut === 'Procédure collective' || statut == null) && complement) statut = classifyNature(complement) || statut;
  const date = j?.date || latest.dateparution || null;
  const detail = /autre jugement/i.test(nature) && complement ? ` — ${complement.slice(0, 90)}${complement.length > 90 ? '…' : ''}` : '';
  return { statut, label: `${nature}${detail}${date ? ` (${date})` : ''}`, date, nature, complement };
}

export async function getProcedureCollective(siren, { fetchImpl = fetch } = {}) {
  const where = `registre like "${siren}" and familleavis="collective"`;
  const url = `${BODACC}/records?where=${encodeURIComponent(where)}&order_by=${encodeURIComponent('dateparution desc')}&limit=10`;
  const data = await getJson(url, fetchImpl);
  return classifyProcedures(data.results || []);
}

export function computeStatut(ent, proc) {
  if (proc?.statut && ['Liquidation', 'RJ', 'Sauvegarde', 'Procédure collective'].includes(proc.statut)) return proc.statut;
  if (ent?.etatAdministratif === 'C') return 'Cessée';
  return 'Actif';
}

/**
 * Recherche + procédures collectives.
 * Sans SIREN et sans correspondance sûre sur le nom, renvoie { candidates: [...] } pour laisser l'utilisateur choisir.
 */
export async function getCompanyInfo({ siren, name, fetchImpl = fetch } = {}) {
  let ent = null;
  if (siren) ent = await searchEntreprise({ siren, fetchImpl }).catch(() => null);
  if (!ent && name) {
    let results = await rawSearch(name, fetchImpl);
    let best = pickBestMatch(name, results);
    // Collectivités : « Ville de X » est enregistrée « Commune de X » dans SIRENE
    const commune = name.replace(/^\s*(?:ville|mairie)\s+(?:de\s+|d')/i, 'Commune de ');
    if (!best && commune !== name) {
      const more = await rawSearch(commune, fetchImpl);
      best = pickBestMatch(commune, more);
      results = [...more, ...results].filter((r, i, a) => a.findIndex((x) => x.siren === r.siren) === i);
    }
    if (!best) return { candidates: results.slice(0, 6).map(normalizeEntreprise) };
    ent = normalizeEntreprise(best);
  }
  if (!ent) return null;
  let procedure = null;
  let procedureError = null;
  try {
    procedure = await getProcedureCollective(ent.siren, { fetchImpl });
  } catch (e) {
    procedureError = e.message;
  }
  return { ...ent, procedure, procedureError, statut: computeStatut(ent, procedure) };
}
