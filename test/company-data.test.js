import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyNature,
  classifyProcedures,
  computeStatut,
  getCompanyInfo,
  normalizeEntreprise,
  pickBestMatch,
} from '../src/lib/company-data.js';

const decathlon = {
  siren: '306138900',
  nom_complet: 'DECATHLON',
  nom_raison_sociale: 'DECATHLON',
  siege: { siret: '30613890001294', code_postal: '59650', libelle_commune: "VILLENEUVE-D'ASCQ", departement: '59' },
  tranche_effectif_salarie: '52',
  annee_tranche_effectif_salarie: '2023',
  etat_administratif: 'A',
  finances: { 2023: { ca: 15000000000, resultat_net: 1 }, 2024: { ca: 16207285000, resultat_net: 1144531000 } },
};

test('normalizeEntreprise', () => {
  const e = normalizeEntreprise(decathlon);
  assert.equal(e.departement, '59');
  assert.equal(e.ville, "VILLENEUVE-D'ASCQ");
  assert.equal(e.effectifLabel, '5 000 à 9 999 salariés');
  assert.equal(e.effectifMin, 5000);
  assert.equal(e.ca, 16207285000);
  assert.equal(e.caAnnee, '2024');
  assert.equal(e.annuaireUrl, 'https://annuaire-entreprises.data.gouv.fr/entreprise/306138900');
});

test('pickBestMatch : nom exact (formes juridiques ignorées), sinon préfixe, sinon null', () => {
  const results = [{ nom_complet: 'DECATHLON PRO', etat_administratif: 'A' }, { nom_complet: 'DECATHLON SA', etat_administratif: 'A' }];
  assert.equal(pickBestMatch('Decathlon', results).nom_complet, 'DECATHLON SA');
  assert.equal(pickBestMatch('Decathlon P', [results[0]]).nom_complet, 'DECATHLON PRO');
  // « Ville de Roubaix » ne doit jamais retomber sur « SEM VILLE RENOUVELEE - EFFIA ROUBAIX »
  assert.equal(pickBestMatch('Ville de Roubaix', [{ nom_complet: 'SEM VILLE RENOUVELEE - EFFIA ROUBAIX SAS', etat_administratif: 'A' }]), null);
  assert.equal(pickBestMatch('X', []), null);
});

test('getCompanyInfo : « Ville de X » est retentée en « Commune de X »', async () => {
  const queries = [];
  const fetchImpl = async (url) => {
    queries.push(decodeURIComponent(url.match(/q=([^&]+)/)?.[1] || url));
    const isCommune = /Commune de Roubaix/i.test(decodeURIComponent(url));
    const body = url.includes('recherche-entreprises')
      ? { results: isCommune ? [{ siren: '215905126', nom_complet: 'COMMUNE DE ROUBAIX', siege: { code_postal: '59100', libelle_commune: 'ROUBAIX', departement: '59' }, etat_administratif: 'A' }] : [{ siren: '752364539', nom_complet: 'SEM VILLE RENOUVELEE', siege: {} }] }
      : { results: [] };
    return { ok: true, json: async () => body };
  };
  const r = await getCompanyInfo({ name: 'Ville de Roubaix', fetchImpl });
  assert.equal(r.siren, '215905126');
  assert.equal(r.ville, 'ROUBAIX');
  assert.deepEqual(queries.slice(0, 2), ['Ville de Roubaix', 'Commune de Roubaix']);
});

test('getCompanyInfo renvoie des candidats quand le nom est ambigu', async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => ({ results: [{ siren: '1', nom_complet: 'LES ATELIERS DE LA VILLE DE ROUBAIX', siege: { libelle_commune: 'ROUBAIX', code_postal: '59100' } }, { siren: '2', nom_complet: 'SEM VILLE RENOUVELEE', siege: {} }] }) });
  const r = await getCompanyInfo({ name: 'Ville de Roubaix', fetchImpl });
  assert.ok(Array.isArray(r.candidates));
  assert.deepEqual(r.candidates.map((c) => c.siren), ['1', '2']);
  assert.equal(r.candidates[0].ville, 'ROUBAIX');
});

test('classifyNature / classifyProcedures', () => {
  assert.equal(classifyNature("Jugement d'ouverture d'une procédure de redressement judiciaire"), 'RJ');
  assert.equal(classifyNature('Jugement de conversion en liquidation judiciaire'), 'Liquidation');
  assert.equal(classifyNature("Jugement d'ouverture d'une procédure de sauvegarde"), 'Sauvegarde');
  assert.equal(classifyNature("Jugement de clôture pour insuffisance d'actif"), 'Procédure clôturée');
  assert.equal(classifyProcedures([]).statut, null);
  const p = classifyProcedures([{ dateparution: '2024-05-01', jugement: '{"nature":"Jugement d\'ouverture de liquidation judiciaire","date":"2024-04-25"}' }]);
  assert.equal(p.statut, 'Liquidation');
  assert.equal(p.date, '2024-04-25');
  // Nature générique : le détail est dans complementJugement (format réel BODACC)
  const g = classifyProcedures([
    {
      dateparution: '2026-08-23',
      jugement: '{"type":"initial","famille":"Extrait de jugement","nature":"Autre jugement et ordonnance","date":"2026-07-08","complementJugement":"Ouvre les opérations de la liquidation judiciaire - Mandataire: X"}',
    },
  ]);
  assert.equal(g.statut, 'Liquidation');
  assert.match(g.label, /Ouvre les opérations/);
  const plan = classifyProcedures([{ jugement: { nature: 'Autre jugement et ordonnance', complementJugement: 'Jugement prononçant la modification substantielle du plan de continuation.' } }]);
  assert.equal(plan.statut, 'RJ');
});

test('computeStatut', () => {
  assert.equal(computeStatut({ etatAdministratif: 'A' }, { statut: null }), 'Actif');
  assert.equal(computeStatut({ etatAdministratif: 'A' }, { statut: 'RJ' }), 'RJ');
  assert.equal(computeStatut({ etatAdministratif: 'C' }, { statut: 'Procédure clôturée' }), 'Cessée');
});

test('getCompanyInfo enchaîne annuaire + BODACC', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    const body = url.includes('recherche-entreprises') ? { results: [decathlon] } : { total_count: 0, results: [] };
    return { ok: true, json: async () => body };
  };
  const info = await getCompanyInfo({ name: 'Decathlon', fetchImpl });
  assert.equal(info.siren, '306138900');
  assert.equal(info.statut, 'Actif');
  assert.ok(calls[1].includes('familleavis%3D%22collective%22'));
  assert.ok(calls[1].includes('306138900'));
});
