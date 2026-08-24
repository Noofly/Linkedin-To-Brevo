// Les content scripts MV3 ne sont pas des modules ES : on charge le module principal dynamiquement.
(async () => {
  try {
    await import(chrome.runtime.getURL('src/content/main.js'));
  } catch (e) {
    console.error('[LinkedIn→Brevo] chargement impossible', e);
  }
})();
