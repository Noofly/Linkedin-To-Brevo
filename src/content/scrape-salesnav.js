// Extraction d'une fiche lead Sales Navigator (linkedin.com/sales/lead/… ou /sales/people/…)
import { splitFullName } from '../lib/normalize.js';
import { profileSlug } from './scrape-linkedin.js';

export function isSalesNavLeadUrl(url) {
  return /^https:\/\/www\.linkedin\.com\/sales\/(lead|people)\//.test(url);
}

const txt = (elm) => (elm?.textContent || '').replace(/\s+/g, ' ').trim();
const q = (sel) => txt(document.querySelector(sel));

export async function scrapeSalesNavLead() {
  const name = q('[data-anonymize="person-name"]') || q('main h1') || q('h1');
  const title = q('[data-anonymize="job-title"]') || q('[data-anonymize="headline"]');
  const company = q('[data-anonymize="company-name"]');
  const mailto = document.querySelector('a[href^="mailto:"]');
  const email = mailto ? mailto.getAttribute('href').replace(/^mailto:/i, '').split('?')[0] : q('[data-anonymize="email"]');
  const tel = document.querySelector('a[href^="tel:"]');
  const phone = q('[data-anonymize="phone"]') || (tel ? tel.getAttribute('href').replace(/^tel:/i, '') : '');
  const companyLink = document.querySelector('a[href*="linkedin.com/company/"], a[href*="/sales/company/"], a[href*="/sales/accounts/"]');
  const website = document.querySelector('a[data-anonymize="url"]')?.href || '';
  const liProfile = document.querySelector('a[href*="linkedin.com/in/"]')?.href || '';
  const leadId = (location.pathname.match(/\/sales\/(?:lead|people)\/([^,/?#]+)/) || [])[1] || '';
  const { firstName, lastName } = splitFullName(name);
  const language = (document.documentElement.lang || '').split(/[-_]/)[0].toLowerCase();
  return {
    source: 'salesnav',
    url: liProfile || location.href.split('?')[0],
    slug: liProfile ? profileSlug(liProfile) : leadId ? `salesnav:${leadId}` : '',
    firstName,
    lastName,
    title,
    company,
    companyLinkedInUrl: companyLink?.href || null,
    companyWebsite: website,
    email: email || '',
    phone: phone || '',
    language,
    warnings: [],
  };
}
