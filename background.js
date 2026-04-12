importScripts('shared.js');

const {
  getSiteKey,
  getSiteConfig,
  migrateSiteSettings,
  setSiteConfig,
} = self.TabNormalizerShared;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message?.type) return false;

  console.log('[bg] received:', message.type, message.hostname);

  void (async () => {
    switch (message.type) {
      case 'TOGGLE_SITE': {
        const hostname = String(message.hostname || message.siteKey || '');
        if (!hostname) throw new Error('Missing hostname.');

        const stored = await chrome.storage.local.get({ activeSites: {}, siteSettings: {} });
        const siteKey = getSiteKey(hostname);
        const current = getSiteConfig(stored.siteSettings, stored.activeSites, siteKey);
        const nextEnabled = !current.enabled;
        const siteSettings = setSiteConfig(stored.siteSettings, stored.activeSites, siteKey, { enabled: nextEnabled });

        await chrome.storage.local.set({ activeSites: {}, siteSettings });
        console.log('[bg] stored:', JSON.stringify(siteSettings));
        return { ok: true, enabled: nextEnabled, gainDb: current.gainDb, siteKey };
      }
      case 'SET_SITE_STATE': {
        const hostname = String(message.hostname || message.siteKey || '');
        if (!hostname) throw new Error('Missing hostname.');

        const stored = await chrome.storage.local.get({ activeSites: {}, siteSettings: {} });
        const siteKey = getSiteKey(hostname);
        const current = getSiteConfig(stored.siteSettings, stored.activeSites, siteKey);
        const enabled = Object.prototype.hasOwnProperty.call(message, 'enabled')
          ? Boolean(message.enabled)
          : current.enabled;
        const gainDb = Object.prototype.hasOwnProperty.call(message, 'gainDb')
          ? message.gainDb
          : current.gainDb;
        const siteSettings = setSiteConfig(stored.siteSettings, stored.activeSites, siteKey, { enabled, gainDb });

        await chrome.storage.local.set({ activeSites: {}, siteSettings });
        console.log('[bg] stored:', JSON.stringify(siteSettings));
        return { ok: true, enabled, gainDb: getSiteConfig(siteSettings, {}, siteKey).gainDb, siteKey };
      }
      case 'GET_SITE_STATE': {
        const hostname = String(message.hostname || message.siteKey || '');
        if (!hostname) return { ok: true, enabled: false, gainDb: 0 };

        const stored = await chrome.storage.local.get({ activeSites: {}, siteSettings: {} });
        const config = getSiteConfig(stored.siteSettings, stored.activeSites, hostname);
        const siteSettings = migrateSiteSettings(stored.siteSettings, stored.activeSites);
        const shouldPersistMigration = Object.keys(stored.activeSites || {}).length > 0 ||
          JSON.stringify(siteSettings) !== JSON.stringify(stored.siteSettings || {});
        if (shouldPersistMigration) {
          await chrome.storage.local.set({ activeSites: {}, siteSettings });
        }
        return { ok: true, enabled: config.enabled, gainDb: config.gainDb, siteKey: config.siteKey };
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
