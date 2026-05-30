try { importScripts('shared.js'); } catch {} // Firefox uses background.scripts instead

const {
  extractHostname,
  getSiteKey,
  getSiteConfig,
  migrateSiteSettings,
  setSiteConfig,
} = self.TabNormalizerShared;

const INJECTABLE_FILES = ['shared.js', 'content-script.js'];
const SUPPORTED_PROTOCOL_PATTERN = /^https?:$/i;
const RESTRICTED_URL_PATTERN = /^(chrome|chrome-extension|devtools|edge|about|moz-extension):/i;
const WEBSTORE_URL_PATTERN = /^https?:\/\/(chrome\.google\.com\/webstore|microsoftedge\.microsoft\.com\/addons)\b/i;
const pendingSessionStates = new Map();

function canAccessTabUrl(url) {
  if (typeof url !== 'string' || !url || RESTRICTED_URL_PATTERN.test(url) || WEBSTORE_URL_PATTERN.test(url)) {
    return false;
  }

  try {
    return SUPPORTED_PROTOCOL_PATTERN.test(new URL(url).protocol);
  } catch {
    return false;
  }
}

function getTabSiteKey(tab) {
  if (!canAccessTabUrl(tab?.url)) {
    return '';
  }

  return getSiteKey(extractHostname(tab.url));
}

async function hasInjectedContentScript(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: 'GET_DOCUMENT_STATUS' });
    return Boolean(response?.ok);
  } catch {
    return false;
  }
}

async function injectMainWorldScript(tabId, file) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: [file],
      world: 'MAIN',
    });
  } catch (e) {
    await chrome.tabs.executeScript(tabId, { file });
  }
}

async function injectTabScripts(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: INJECTABLE_FILES,
    });
  } catch (e) {
    for (const file of INJECTABLE_FILES) {
      await chrome.tabs.executeScript(tabId, { file, allFrames: true });
    }
  }
}

async function prepareCurrentTabActivation(tabId, siteKey) {
  if (!tabId) {
    return { state: 'pending' };
  }

  let tab = null;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    return { state: 'pending' };
  }

  if (!canAccessTabUrl(tab?.url)) {
    return { state: 'restricted', message: 'Enabled. Reload on a supported page.' };
  }

  if (getTabSiteKey(tab) !== siteKey) {
    return { state: 'pending' };
  }

  try {
    if (!await hasInjectedContentScript(tabId)) {
      await injectTabScripts(tabId);
    }
  } catch {
    return { state: 'unavailable', message: 'Enabled. Reload if this page stays unavailable.' };
  }

  return { state: 'pending' };
}

async function getPendingSessionStates() {
  return Object.fromEntries(pendingSessionStates);
}

async function setPendingSessionState(tabId, value) {
  if (!tabId) return;

  const key = String(tabId);
  if (value) {
    pendingSessionStates.set(key, value);
  } else {
    pendingSessionStates.delete(key);
  }
}

async function tryApplyPendingSessionState(tabId, tab) {
  if (!tabId) return false;

  const pending = await getPendingSessionStates();
  const entry = pending[String(tabId)];
  if (!entry) return false;

  if (!canAccessTabUrl(tab?.url)) {
    return false;
  }

  if (getTabSiteKey(tab) !== entry.siteKey) {
    return false;
  }

  try {
    if (!await hasInjectedContentScript(tabId)) {
      await injectTabScripts(tabId);
    }

    await chrome.tabs.sendMessage(tabId, {
      type: 'SET_DOCUMENT_STATE',
      enabled: Boolean(entry.enabled),
      gainDb: entry.gainDb,
      blastGuard: Boolean(entry.blastGuard),
    });
    return true;
  } catch (error) {
    console.warn('[bg] pending session apply failed:', tabId, String(error));
    return false;
  }
}

async function softRecheckDocument(tabId, siteKey) {
  if (!tabId) {
    return { ok: false, error: 'Missing tabId.' };
  }

  let tab = null;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    return { ok: false, error: 'Tab unavailable.' };
  }

  if (!canAccessTabUrl(tab?.url)) {
    return { ok: true, activation: { state: 'restricted', message: 'Enabled. Reload on a supported page.' } };
  }

  if (siteKey && getTabSiteKey(tab) !== siteKey) {
    return { ok: true, activation: { state: 'idle' } };
  }

  try {
    if (!await hasInjectedContentScript(tabId)) {
      await injectTabScripts(tabId);
    }
  } catch {
    return { ok: true, activation: { state: 'unavailable', message: 'Enabled. Waiting for this page.' } };
  }

  try {
    return await chrome.tabs.sendMessage(tabId, { type: 'SOFT_RECHECK_DOCUMENT' });
  } catch {
    return { ok: true, activation: { state: 'unavailable', message: 'Enabled. Waiting for this page.' } };
  }
}

async function syncExistingTabsForSite(siteKey) {
  if (!siteKey) {
    return;
  }

  const tabs = await chrome.tabs.query({});
  const matchingTabs = tabs.filter((tab) => tab.id && getTabSiteKey(tab) === siteKey);

  await Promise.all(matchingTabs.map(async (tab) => {
    if (!tab.id || !canAccessTabUrl(tab.url)) {
      return;
    }

    const isInjected = await hasInjectedContentScript(tab.id);
    if (isInjected) {
      return;
    }

    try {
      await injectTabScripts(tab.id);
    } catch (error) {
      console.warn('[bg] skipped tab injection:', tab.id, String(error));
    }
  }));
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!tabId || (changeInfo.status !== 'complete' && typeof changeInfo.url !== 'string')) {
    return;
  }

  void tryApplyPendingSessionState(tabId, tab);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void setPendingSessionState(tabId, null);
});

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
        if (nextEnabled) {
          await syncExistingTabsForSite(siteKey);
        }
        console.log('[bg] stored:', JSON.stringify(siteSettings));
        return {
          ok: true,
          enabled: nextEnabled,
          gainDb: current.gainDb,
          blastGuard: current.blastGuard,
          siteKey,
        };
      }
      case 'SET_SITE_STATE': {
        const hostname = String(message.hostname || message.siteKey || '');
        if (!hostname) throw new Error('Missing hostname.');

        const stored = await chrome.storage.local.get({ activeSites: {}, siteSettings: {} });
        const siteKey = getSiteKey(hostname);
        const current = getSiteConfig(stored.siteSettings, stored.activeSites, siteKey);
        const requestedEnabledChange = Object.prototype.hasOwnProperty.call(message, 'enabled');
        const enabled = Object.prototype.hasOwnProperty.call(message, 'enabled')
          ? Boolean(message.enabled)
          : current.enabled;
        const gainDb = Object.prototype.hasOwnProperty.call(message, 'gainDb')
          ? message.gainDb
          : current.gainDb;
        const blastGuard = Object.prototype.hasOwnProperty.call(message, 'blastGuard')
          ? Boolean(message.blastGuard)
          : current.blastGuard;
        const siteSettings = setSiteConfig(stored.siteSettings, stored.activeSites, siteKey, {
          enabled,
          gainDb,
          blastGuard,
        });
        const shouldActivateCurrentTab = requestedEnabledChange && enabled;
        const persist = message.persist !== false;

        if (persist) {
          await chrome.storage.local.set({ activeSites: {}, siteSettings });
          await setPendingSessionState(message.tabId, null);
        }
        const activation = shouldActivateCurrentTab
          ? await prepareCurrentTabActivation(message.tabId, siteKey)
          : { state: 'idle' };
        if (!persist && message.tabId) {
          const nextConfig = getSiteConfig(siteSettings, {}, siteKey);
          await setPendingSessionState(
            message.tabId,
            {
              siteKey,
              enabled,
              gainDb: nextConfig.gainDb,
              blastGuard: nextConfig.blastGuard,
            },
          );
        }
        if (shouldActivateCurrentTab && persist) {
          await syncExistingTabsForSite(siteKey);
        }
        console.log('[bg]', persist ? 'stored:' : 'transient:', JSON.stringify(siteSettings));
        return {
          ok: true,
          enabled,
          gainDb: getSiteConfig(siteSettings, {}, siteKey).gainDb,
          blastGuard: getSiteConfig(siteSettings, {}, siteKey).blastGuard,
          siteKey,
          activation,
        };
      }
      case 'GET_SITE_STATE': {
        const hostname = String(message.hostname || message.siteKey || '');
        if (!hostname) return { ok: true, enabled: false, gainDb: 0, blastGuard: false };

        const stored = await chrome.storage.local.get({ activeSites: {}, siteSettings: {} });
        const config = getSiteConfig(stored.siteSettings, stored.activeSites, hostname);
        const siteSettings = migrateSiteSettings(stored.siteSettings, stored.activeSites);
        const shouldPersistMigration = Object.keys(stored.activeSites || {}).length > 0 ||
          JSON.stringify(siteSettings) !== JSON.stringify(stored.siteSettings || {});
        if (shouldPersistMigration) {
          await chrome.storage.local.set({ activeSites: {}, siteSettings });
        }
        return {
          ok: true,
          enabled: config.enabled,
          gainDb: config.gainDb,
          blastGuard: config.blastGuard,
          siteKey: config.siteKey,
        };
      }
      case 'INJECT_PAGE_HOOK': {
        const tabId = _sender?.tab?.id;
        if (!tabId) throw new Error('No tab ID for page hook injection.');
        await injectMainWorldScript(tabId, 'page-hook.js');
        return { ok: true };
      }
      case 'SOFT_RECHECK_DOCUMENT': {
        return softRecheckDocument(message.tabId, String(message.siteKey || ''));
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

chrome.runtime.onStartup.addListener(async () => {
  try {
    const stored = await chrome.storage.local.get({ activeSites: {}, siteSettings: {} });
    const siteSettings = migrateSiteSettings(stored.siteSettings, stored.activeSites);
    for (const [key, config] of Object.entries(siteSettings)) {
      if (/** @type {Record<string, unknown>} */ (config).enabled) {
        await syncExistingTabsForSite(key);
      }
    }
  } catch {
    // ignore startup re-injection errors
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.siteToggles) {
    const newToggles = changes.siteToggles.newValue || {};
    const oldToggles = changes.siteToggles.oldValue || {};
    for (const siteKey of Object.keys(newToggles)) {
      if (newToggles[siteKey] !== oldToggles[siteKey]) {
        chrome.tabs.query({}, (tabs) => {
          tabs.forEach(tab => {
            if (tab.url && tab.id && new URL(tab.url).hostname.toLowerCase() === siteKey.split(':')[0]) {
              chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_CHANGED', siteKey, enabled: newToggles[siteKey] }).catch(() => {});
            }
          });
        });
      }
    }
  }
});

export {};
