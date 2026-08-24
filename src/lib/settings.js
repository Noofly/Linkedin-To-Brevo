// Réglages + cache (chrome.storage.local). Ne pas importer sous Node.
export const DEFAULTS = {
  apiKey: '',
  genericDomain: 'example.com',
  defaultLang: 'fr',
  autoCreateAttributes: true,
};

const CACHE_TTL_MS = 60 * 60 * 1000;

export async function getSettings() {
  const o = await chrome.storage.local.get('settings');
  return { ...DEFAULTS, ...(o.settings || {}) };
}

export async function saveSettings(patch) {
  const cur = await getSettings();
  await chrome.storage.local.set({ settings: { ...cur, ...patch } });
}

export async function getCache(key) {
  const o = await chrome.storage.local.get('cache');
  const c = o.cache?.[key];
  if (c && Date.now() - c.ts < CACHE_TTL_MS) return c.value;
  return null;
}

export async function setCache(key, value) {
  const o = await chrome.storage.local.get('cache');
  await chrome.storage.local.set({ cache: { ...(o.cache || {}), [key]: { ts: Date.now(), value } } });
}

export async function clearCache() {
  await chrome.storage.local.remove('cache');
}
