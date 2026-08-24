import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildGenericEmail,
  cleanCompanyName,
  companyNameKey,
  departementFromCP,
  domainOf,
  extractPhones,
  extractSiren,
  luhnValid,
  normalizePhone,
  normalizeSiteUrl,
  pickBestPhone,
  splitFullName,
} from '../src/lib/normalize.js';

test('cleanCompanyName retire les formes juridiques en tête/queue', () => {
  assert.equal(cleanCompanyName('Decathlon SA'), 'Decathlon');
  assert.equal(cleanCompanyName('S.A.S. Décathlon France'), 'Decathlon France');
  assert.equal(cleanCompanyName('SAS Institute'), 'Institute'); // limite connue
  assert.equal(cleanCompanyName('Groupe Rocher'), 'Groupe Rocher');
  assert.equal(companyNameKey('DECATHLON S.A.'), companyNameKey('Decathlon'));
});

test('buildGenericEmail : prenom.nom.societe@domaine', () => {
  assert.equal(
    buildGenericEmail({ firstName: 'Jean-Édouard', lastName: "D'Aubigny", company: 'Décathlon SAS', domain: 'example.com' }),
    'jeanedouard.daubigny.decathlon@example.com'
  );
  assert.equal(buildGenericEmail({ firstName: 'Zoé', lastName: '', company: '', domain: 'x.fr' }), 'zoe@x.fr');
});

test('splitFullName', () => {
  assert.deepEqual(splitFullName('Jean Dupont (He/Him), PhD'), { firstName: 'Jean', lastName: 'Dupont' });
  assert.deepEqual(splitFullName('Marie-Claire de la Tour 🚀'), { firstName: 'Marie-Claire', lastName: 'de la Tour' });
});

test('normalizePhone', () => {
  assert.equal(normalizePhone('01 23 45 67 89'), '+33123456789');
  assert.equal(normalizePhone('+33 (0)1 23 45 67 89'), '+33123456789');
  assert.equal(normalizePhone('0033 6 12 34 56 78'), '+33612345678');
  assert.equal(normalizePhone('+1 415 555 2671'), '+14155552671');
  assert.equal(normalizePhone('12345'), null);
});

test('extractPhones + pickBestPhone', () => {
  const text = 'Mobile : 06 12 34 56 78 — Standard : 03.20.33.50.00 — Fax +33 3 20 33 50 01 — SIRET 306 138 900 01294';
  const phones = extractPhones(text);
  assert.deepEqual(phones, ['+33612345678', '+33320335000', '+33320335001']);
  assert.equal(pickBestPhone(phones), '+33320335000');
  // Numéros étrangers : pas d'absorption des chiffres voisins (années, identifiants)
  assert.deepEqual(extractPhones('Support +1 (877) 273-3049 depuis 2026'), ['+18772733049']);
  assert.deepEqual(extractPhones('CA 94110 États-Unis – +1 877-273-3049\n2. Conditions générales'), ['+18772733049']);
  assert.deepEqual(extractPhones('Tél : 03 20 33 50 00'), ['+33320335000']);
  assert.deepEqual(extractPhones('Ref 0123456789012 (pas un numéro)'), []);
});

test('luhn / extractSiren', () => {
  assert.equal(luhnValid('306138900'), true);
  assert.equal(luhnValid('306138901'), false);
  assert.deepEqual(extractSiren('RCS Lille Métropole B 306 138 900 — capital 10 000 €'), { siren: '306138900', siret: null });
  assert.deepEqual(extractSiren('N° SIRET : 306 138 900 01294'), { siren: '306138900', siret: '30613890001294' });
  assert.deepEqual(extractSiren('TVA intracommunautaire FR63 306 138 900'), { siren: '306138900', siret: null });
  assert.deepEqual(extractSiren('Siren : 123 456 789 (faux)'), null);
});

test('departementFromCP', () => {
  assert.equal(departementFromCP('59650'), '59');
  assert.equal(departementFromCP('20090'), '2A');
  assert.equal(departementFromCP('20200'), '2B');
  assert.equal(departementFromCP('97400'), '974');
  assert.equal(departementFromCP(''), '');
});

test('normalizeSiteUrl / domainOf', () => {
  assert.equal(normalizeSiteUrl('www.decathlon.fr'), 'https://www.decathlon.fr/');
  assert.equal(normalizeSiteUrl('http://decathlon.fr/a?b=1'), 'http://decathlon.fr/a?b=1');
  assert.equal(normalizeSiteUrl('pas une url'), null);
  assert.equal(domainOf('https://www.Decathlon.fr/fr/'), 'decathlon.fr');
});
