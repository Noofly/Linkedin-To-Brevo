import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chooseProfile,
  companyMatches,
  findLinkedInProfile,
  isLinkedInLoggedOut,
  nameMatchLevel,
  parsePeopleSearch,
  peopleSearchUrl,
  slugFromExtId,
} from '../src/lib/linkedin-search.js';

const card = (slug, name, headline, location, extra = '') =>
  `<div role="listitem"><div><a href="https://www.linkedin.com/in/${slug}/?miniProfileUrn=x"><div>${name}<svg aria-label="Premium"></svg></div></a>` +
  `<p><span>${name}</span> • <span>3e et +</span></p><p>${headline}</p><p>${location}</p>${extra}</div></div>`;

const html =
  '<html><title>Recherche | LinkedIn</title><div role="list">' +
  card('pierre-desmons59', 'Pierre Desmons', 'Responsable Commercial chez Caquant', "Villeneuve-d&#x27;Ascq, Hauts-de-France, France") +
  card('pierre-desmons-25992a10', 'Pierre Desmons', 'Owner at DESMONS CONSULTING SPRL', 'Nivelles, Belgique') +
  card('jean-pierre-desmons-58986671', 'jean pierre Desmons', '--', 'Le Havre') +
  card('audrey-vict%C3%B3ria', 'Audrey Vict&#xF3;ria Randon', 'Closer', 'Porto Alegre', '<p>Ces résultats sont-ils utiles ?</p>') +
  '</div><footer><a href="https://www.linkedin.com/in/pierre-desmons59/">dup</a></footer></html>';

test('parsePeopleSearch : slug, nom sans degré, titre, localisation, entités décodées', () => {
  const r = parsePeopleSearch(html);
  assert.equal(r.length, 4);
  assert.deepEqual(r[0], {
    slug: 'pierre-desmons59',
    url: 'https://www.linkedin.com/in/pierre-desmons59/',
    name: 'Pierre Desmons',
    headline: 'Responsable Commercial chez Caquant',
    location: "Villeneuve-d'Ascq, Hauts-de-France, France",
  });
  assert.equal(r[2].headline, '');
  assert.equal(r[3].slug, 'audrey-victória');
  assert.equal(r[3].name, 'Audrey Victória Randon');
  assert.deepEqual(parsePeopleSearch('<html><p>Aucun résultat</p></html>'), []);
});

test('nameMatchLevel / companyMatches', () => {
  assert.equal(nameMatchLevel('Pierre DESMONS', 'Pierre', 'Desmons'), 'exact');
  assert.equal(nameMatchLevel('Desmons Pierre', 'Pierre', 'Desmons'), 'exact');
  assert.equal(nameMatchLevel('jean pierre Desmons', 'Pierre', 'Desmons'), 'partial');
  assert.equal(nameMatchLevel('Pierre Dupont', 'Pierre', 'Desmons'), null);
  assert.equal(nameMatchLevel('Élodie Le Gall', 'Elodie', 'Le Gall'), 'exact');
  assert.equal(companyMatches('Responsable Commercial chez Caquant', 'Caquant - Groupe Efire'), true);
  assert.equal(companyMatches('Ingénieur chez Décathlon', 'Decathlon S.A.'), true);
  assert.equal(companyMatches('Directeur du Groupe Machin', 'Groupe Truc'), false);
  assert.equal(companyMatches('Barman', ''), false);
});

test('chooseProfile : société dans le titre > nom exact unique > ambigu', () => {
  const results = parsePeopleSearch(html);
  const contact = { firstName: 'Pierre', lastName: 'Desmons', company: 'Caquant' };
  const a = chooseProfile(results, contact);
  assert.equal(a.status, 'found');
  assert.equal(a.profile.slug, 'pierre-desmons59');
  assert.equal(a.confidence, 'haute');

  const b = chooseProfile(results, { firstName: 'Pierre', lastName: 'Desmons', company: 'Inconnue SAS' });
  assert.equal(b.status, 'ambiguous');
  assert.deepEqual(
    b.candidates.map((c) => c.slug),
    ['pierre-desmons59', 'pierre-desmons-25992a10']
  );

  const c = chooseProfile(results.slice(0, 1), { firstName: 'Pierre', lastName: 'Desmons', company: 'Inconnue' }, { withCompanyQuery: true });
  assert.equal(c.status, 'found');
  assert.equal(c.confidence, 'haute');
  const d = chooseProfile(results.slice(0, 1), { firstName: 'Pierre', lastName: 'Desmons' });
  assert.equal(d.confidence, 'moyenne');
  assert.equal(chooseProfile(results, { firstName: 'Paul', lastName: 'Martin' }).status, 'none');
  // Seul un nom partiel : proposé, jamais écrit d'office
  assert.equal(chooseProfile(results.slice(2, 3), { firstName: 'Pierre', lastName: 'Desmons' }).status, 'ambiguous');
});

test('findLinkedInProfile : requête avec société puis repli sur le nom seul', async () => {
  const calls = [];
  const fetchHtml = async (url) => {
    calls.push(decodeURIComponent(url.split('keywords=')[1]));
    return calls.length === 1 ? '<html></html>' : html;
  };
  const r = await findLinkedInProfile({ firstName: 'Pierre', lastName: 'Desmons', company: 'Caquant SAS' }, fetchHtml);
  assert.deepEqual(calls, ['Pierre Desmons Caquant', 'Pierre Desmons']);
  assert.equal(r.status, 'found');
  assert.equal(r.profile.slug, 'pierre-desmons59');
  assert.deepEqual(await findLinkedInProfile({ firstName: '', lastName: 'X' }, fetchHtml), { status: 'skip', reason: 'prénom ou nom manquant' });
  assert.equal((await findLinkedInProfile({ firstName: 'Paul', lastName: 'Martin' }, async () => '')).status, 'none');
});

test('utilitaires : URL de recherche, EXT_ID, détection déconnexion', () => {
  assert.equal(peopleSearchUrl(' Pierre  Desmons '), 'https://www.linkedin.com/search/results/people/?keywords=Pierre%20Desmons');
  assert.equal(slugFromExtId('pierre-desmons59'), 'pierre-desmons59');
  assert.equal(slugFromExtId('salesnav:123'), null);
  assert.equal(slugFromExtId(''), null);
  assert.equal(isLinkedInLoggedOut({ url: 'https://www.linkedin.com/authwall?trk=x' }), true);
  assert.equal(isLinkedInLoggedOut({ url: 'https://www.linkedin.com/search/results/people/?keywords=a', html: '<title>Recherche | LinkedIn</title>' }), false);
  assert.equal(isLinkedInLoggedOut({ url: 'https://www.linkedin.com/x', html: '<title>Se connecter | LinkedIn</title>' }), true);
});
