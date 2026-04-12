importScripts('shared.js');

const {
  getSiteKey,
  migrateActiveSites,
  setSiteEnabled,
} = self.TabNormalizerShared;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message?.type) return false;

  console.log('[bg] received:', message.type, message.hostname);

  void (async () => {
    switch (message.type) {
      case 'TOGGLE_SITE': {
        const hostname = String(message.hostname || message.siteKey || '');
        if (!hostname) throw new Error('Missing hostname.');

        const stored = await chrome.storage.local.get({ activeSites: {} });
        const migrated = migrateActiveSites(stored.activeSites);
        const siteKey = getSiteKey(hostname);
        const nextEnabled = !Boolean(migrated[siteKey]);
        const activeSites = setSiteEnabled(migrated, siteKey, nextEnabled);

        await chrome.storage.local.set({ activeSites });
        console.log('[bg] stored:', JSON.stringify(activeSites));
        return { ok: true, enabled: nextEnabled, siteKey };
      }
      case 'SET_SITE_STATE': {
        const hostname = String(message.hostname || message.siteKey || '');
        if (!hostname) throw new Error('Missing hostname.');

        const enabled = Boolean(message.enabled);
        const stored = await chrome.storage.local.get({ activeSites: {} });
        const migrated = migrateActiveSites(stored.activeSites);
        const siteKey = getSiteKey(hostname);
        const activeSites = setSiteEnabled(migrated, siteKey, enabled);

        await chrome.storage.local.set({ activeSites });
        console.log('[bg] stored:', JSON.stringify(activeSites));
        return { ok: true, enabled, siteKey };
      }
      case 'GET_SITE_STATE': {
        const hostname = String(message.hostname || message.siteKey || '');
        if (!hostname) return { ok: true, enabled: false };

        const stored = await chrome.storage.local.get({ activeSites: {} });
        const migrated = migrateActiveSites(stored.activeSites);
        const siteKey = getSiteKey(hostname);
        return { ok: true, enabled: Boolean(migrated[siteKey]), siteKey };
      }
      default:
        return { ok: false, error: `Unknown: ${message.type}` };
    }
  })()
    .then((r) => sendResponse(r))
    .catch((e) => {
      console.error('[bg] error:', e);
      sendResponse({ ok: false, error: String(e) });
    });

  return true;
});
