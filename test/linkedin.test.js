import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractCompanyWebsite,
  linkedInCompanyAboutUrl,
  linkedInCompanyRef,
  parseContactInfoHtml,
  parseContactRsc,
  unwrapLinkedInRedirect,
} from '../src/lib/linkedin.js';

test('extractCompanyWebsite depuis les blocs <code> échappés (page entreprise Ember)', () => {
  const included = [
    { $type: 'com.linkedin.voyager.dash.organization.Company', entityUrn: 'urn:li:fsd_company:999', universalName: 'autre', websiteUrl: 'https://autre.fr' },
    { $type: 'com.linkedin.voyager.dash.organization.Company', entityUrn: 'urn:li:fsd_company:6331', universalName: 'desjardins', websiteUrl: 'http://www.desjardins.com/fr/bienvenue.jsp' },
  ];
  const code = JSON.stringify({ data: {}, included }).replace(/"/g, '&quot;');
  const html = `<html><body><code id="x">${code}</code></body></html>`;
  assert.equal(extractCompanyWebsite(html, { id: '6331' }), 'http://www.desjardins.com/fr/bienvenue.jsp');
  assert.equal(extractCompanyWebsite(html, { slug: 'Desjardins' }), 'http://www.desjardins.com/fr/bienvenue.jsp');
  assert.equal(extractCompanyWebsite(html), 'https://autre.fr'); // sans indice : première société
});

test('extractCompanyWebsite : JSON brut, lien about_website, redirection LinkedIn', () => {
  assert.equal(extractCompanyWebsite('{"name":"X","websiteUrl":"https:\\/\\/www.decathlon.fr\\/"}'), 'https://www.decathlon.fr/');
  assert.equal(
    extractCompanyWebsite('<a data-tracking-control-name="about_website" href="https://www.linkedin.com/redir/redirect?url=https%3A%2F%2Fwww.decathlon.fr&amp;urlhash=x">site</a>'),
    'https://www.decathlon.fr'
  );
  assert.equal(extractCompanyWebsite('<a href="https://www.linkedin.com/company/x">x</a>'), null);
});

test('unwrapLinkedInRedirect / linkedInCompanyRef / linkedInCompanyAboutUrl', () => {
  assert.equal(unwrapLinkedInRedirect('https://www.linkedin.com/redir/redirect?url=https%3A%2F%2Fa.fr%2Fb'), 'https://a.fr/b');
  assert.equal(unwrapLinkedInRedirect('https://a.fr'), 'https://a.fr');
  assert.deepEqual(linkedInCompanyRef('https://www.linkedin.com/company/6331/'), { id: '6331' });
  assert.deepEqual(linkedInCompanyRef('https://www.linkedin.com/company/decathlon/about/'), { slug: 'decathlon' });
  assert.equal(linkedInCompanyRef('https://www.linkedin.com/sales/company/1'), null);
  assert.equal(linkedInCompanyAboutUrl('https://www.linkedin.com/company/6331/'), 'https://www.linkedin.com/company/6331/about/');
});

test('parseContactInfoHtml (ancien overlay)', () => {
  const html =
    '<a href="mailto:Jean.Dupont@Example.com?subject=x">mail</a>' +
    '{"emailAddress":"jean.dupont@example.com","phoneNumbers":[{"number":"+33 6 12 34 56 78","type":"MOBILE"}],"websites":[]}';
  const r = parseContactInfoHtml(html);
  assert.deepEqual(r.emails, ['jean.dupont@example.com']);
  assert.deepEqual(r.phones, ['+33 6 12 34 56 78']);
});

test('parseContactRsc (nouvelle interface, flux RSC)', () => {
  const rsc =
    '11:["$","p",null,{"className":"x","children":["Profil de Denis"]}]\n' +
    '12:["$","p",null,{"children":["linkedin.com/in/denis"]}]\n' +
    '13:{"action":{"url":{"urlValue":{"$case":"url","url":"https://www.linkedin.com/in/denis/"}}}}\n' +
    '14:["$","p",null,{"children":["E-mail"]}]\n' +
    '15:{"url":"mailto:Denis.V@Example.com"}\n' +
    '16:["$","p",null,{"children":["+1 418 555-0199"]}]\n' +
    '17:{"url":"https://www.example.com/"}\n' +
    '18:["$","p",null,{"children":["marie@example.org"]}]';
  const r = parseContactRsc(rsc);
  assert.deepEqual(r.emails, ['denis.v@example.com', 'marie@example.org']);
  assert.deepEqual(r.phones, ['+1 418 555-0199']);
  assert.deepEqual(r.websites, ['https://www.example.com/']);
  assert.deepEqual(parseContactRsc('["Profil de X"]').emails, []);
});
