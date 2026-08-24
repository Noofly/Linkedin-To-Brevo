import { Panel } from './ui.js';
import { isLinkedInProfileUrl, scrapeLinkedInProfile } from './scrape-linkedin.js';
import { isSalesNavLeadUrl, scrapeSalesNavLead } from './scrape-salesnav.js';

function pageKind(url = location.href) {
  if (isLinkedInProfileUrl(url)) return 'profile';
  if (isSalesNavLeadUrl(url)) return 'salesnav';
  return null;
}

const panel = new Panel({
  onFabClick: analyse,
  onSubmit: submit,
  onOpenOptions: () => chrome.runtime.sendMessage({ type: 'OPEN_OPTIONS' }).catch(() => {}),
});
await panel.mount();
panel.showFab(!!pageKind());
setInterval(() => panel.showFab(!!pageKind()), 1000);

async function analyse() {
  panel.open();
  panel.setStatus('Analyse de la fiche…');
  try {
    const kind = pageKind();
    if (!kind) throw new Error('Ouvrez une fiche de profil LinkedIn ou Sales Navigator.');
    const profile = kind === 'profile' ? await scrapeLinkedInProfile() : await scrapeSalesNavLead();
    panel.fillForm(profile);
    const empty = ['firstName', 'lastName', 'title', 'company'].filter((k) => !profile[k]);
    panel.setStatus(
      empty.length
        ? `Champs non trouvés : ${empty.join(', ')} — complétez-les puis cliquez sur « Créer dans Brevo ».`
        : 'Vérifiez les informations puis cliquez sur « Créer dans Brevo ».'
    );
  } catch (e) {
    console.error('[LinkedIn→Brevo] analyse', e);
    panel.setStatus(`Erreur d'analyse : ${e.message} — remplissez le formulaire à la main.`, 'error');
    panel.fillForm({ source: 'linkedin', url: location.href.split('?')[0] });
  }
}

async function submit(profile) {
  panel.resetSteps();
  panel.setBusy(true);
  panel.setStatus('Envoi vers Brevo…');
  let res;
  try {
    res = await chrome.runtime.sendMessage({ type: 'ADD_CONTACT', profile });
  } catch (e) {
    res = { ok: false, error: `Extension injoignable (${e.message}). Rechargez la page.` };
  }
  panel.setBusy(false);
  panel.showResult(res || { ok: false, error: 'Réponse vide du service worker' });
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  switch (msg?.type) {
    case 'PROGRESS':
      panel.setStep(msg.step, msg.status, msg.message);
      return false;
    case 'ASK':
      panel
        .ask(msg)
        .then((v) => sendResponse(v))
        .catch((e) => sendResponse({ value: null, error: e.message }));
      return true;
    case 'FETCH_SAME_ORIGIN':
      fetch(msg.url, { credentials: 'include' })
        .then(async (r) => sendResponse({ ok: r.ok, status: r.status, text: r.ok ? await r.text() : '' }))
        .catch((e) => sendResponse({ ok: false, error: e.message }));
      return true;
    default:
      return false;
  }
});
