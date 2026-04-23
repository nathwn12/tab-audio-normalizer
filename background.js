importScripts('shared.js');

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
const PENDING_SESSION_KEY = 'pendingSessionStates';

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

async function injectTabScripts(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    files: INJECTABLE_FILES,
  });
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
  const stored = await chrome.storage.session.get({ [PENDING_SESSION_KEY]: {} });
  const pending = stored?.[PENDING_SESSION_KEY];
  return pending && typeof pending === 'object' ? pending : {};
}

async function setPendingSessionState(tabId, value) {
  if (!tabId) return;

  const pending = await getPendingSessionStates();
  const key = String(tabId);
  if (value) {
    pending[key] = value;
  } else {
    delete pending[key];
  }

  await chrome.storage.session.set({ [PENDING_SESSION_KEY]: pending });
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
    });
    await setPendingSessionState(tabId, null);
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
        return { ok: true, enabled: nextEnabled, gainDb: current.gainDb, siteKey };
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
        const siteSettings = setSiteConfig(stored.siteSettings, stored.activeSites, siteKey, { enabled, gainDb });
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
          const shouldQueueSessionState = activation?.state === 'restricted';
          await setPendingSessionState(
            message.tabId,
            shouldQueueSessionState
              ? {
                  siteKey,
                  enabled,
                  gainDb: getSiteConfig(siteSettings, {}, siteKey).gainDb,
                }
              : null,
          );
        }
        if (shouldActivateCurrentTab && persist) {
          await syncExistingTabsForSite(siteKey);
        }
        console.log('[bg]', persist ? 'stored:' : 'transient:', JSON.stringify(siteSettings));
        return { ok: true, enabled, gainDb: getSiteConfig(siteSettings, {}, siteKey).gainDb, siteKey, activation };
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
