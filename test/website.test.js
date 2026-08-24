import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crawlSite, extractLinks, extractTelLinks, stripHtml } from '../src/lib/website.js';

test('stripHtml supprime scripts/styles et décode les entités', () => {
  const html = '<html><head><style>a{}</style><script>var x="01 02 03 04 05"</script></head><body><p>T&eacute;l&nbsp;: 01&#46;23.45.67.89</p></body></html>';
  const t = stripHtml(html);
  assert.ok(!t.includes('var x'));
  assert.ok(t.includes('01.23.45.67.89'), t);
});

test('extractLinks résout les URLs relatives et ignore mailto/tel', () => {
  const html = '<a href="/contact">Contact</a><a href="mailto:a@b.fr">mail</a><a href="https://ext.com/x">Ext</a>';
  const links = extractLinks(html, 'https://www.site.fr/page');
  assert.deepEqual(
    links.map((l) => l.href),
    ['https://www.site.fr/contact', 'https://ext.com/x']
  );
  assert.equal(links[0].text, 'Contact');
});

test('extractTelLinks', () => {
  assert.deepEqual(extractTelLinks('<a href="tel:+33 1 23 45 67 89">x</a><a href=\'tel:0612345678\'>y</a>'), ['+33123456789', '+33612345678']);
});

test('crawlSite suit la page contact puis les mentions légales', async () => {
  const pages = {
    'https://www.site.fr/': '<a href="/contact">Nous contacter</a><a href="/mentions-legales">Mentions légales</a><p>Bienvenue</p>',
    'https://www.site.fr/contact': '<p>Standard : 03 20 33 50 00</p>',
    'https://www.site.fr/mentions-legales': '<p>SIREN 306 138 900 — RCS Lille</p>',
  };
  const fetched = [];
  const fetchImpl = async (u) => {
    fetched.push(u);
    if (!(u in pages)) throw new Error('HTTP 404');
    return pages[u];
  };
  const r = await crawlSite('www.site.fr', { fetchImpl });
  assert.equal(r.phone, '+33320335000');
  assert.equal(r.phoneSource, 'https://www.site.fr/contact');
  assert.equal(r.siren, '306138900');
  assert.equal(r.sirenSource, 'https://www.site.fr/mentions-legales');
  assert.deepEqual(fetched.slice(0, 3), Object.keys(pages));
});

test('crawlSite ne cherche pas de téléphone si wantPhone=false et s’arrête dès le SIREN trouvé', async () => {
  const fetchImpl = async (u) => (u === 'https://www.site.fr/' ? '<p>Tél 01 23 45 67 89 — SIRET 306 138 900 01294</p>' : '');
  const r = await crawlSite('https://www.site.fr', { fetchImpl, wantPhone: false });
  assert.equal(r.phone, null);
  assert.equal(r.siret, '30613890001294');
  assert.deepEqual(r.pages, ['https://www.site.fr/']);
});
