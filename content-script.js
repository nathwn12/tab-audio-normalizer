(() => {
  const existing = globalThis.__tabNormalizerContentScriptV5;
  if (existing?.reinject) {
    existing.reinject();
    return;
  }

  const CHANNEL = 'tab-normalizer-v5';
  const HOOK_TIMEOUT_MS = 1000;
  const HOOK_FRESH_MS = 3000;
  const INJECT_TIMEOUT_MS = 5000;
  const ACTIVATE_RETRY_COUNT = 5;
  const ACTIVATE_RETRY_MS = 250;
  const PENDING_ATTR = 'data-tab-normalizer-pending';

  const {
    DEFAULT_BLAST_GUARD,
    DEFAULT_GAIN_DB,
    clampGainDb,
    extractHostname,
    getSiteKey,
    getSiteConfig,
    migrateSiteSettings,
    getContentAction,
    getPopupIndicator,
  } = globalThis.TabNormalizerShared;

  /** @type {{
   *   hostname: string, siteKey: string, enabled: boolean, gainDb: number,
   *   blastGuard: boolean, injected: boolean, hookAlive: boolean,
   *   hookActive: boolean, injecting: boolean, injectStartedAt: number,
   *   lastError: string, lastStatusAt: number,
   *   pendingProbe: ({ requestId: string, promise: Promise<boolean>, resolve: (v: boolean) => void, timeoutId: number } | null),
   *   popupProbe: (Promise<boolean> | null),
   *   syncInFlight: boolean, queuedSyncReason: string,
   *   queuedSyncPayload: (Record<string, unknown> | null),
   *   bootstrapped: boolean, activationRetryTimer: (number | null),
   *   activationRetryCount: number, spaWatchTimer: (number | null),
   *   hasSessionOverride: boolean, sessionEnabled: boolean,
   *   sessionGainDb: number, sessionBlastGuard: boolean
   * }} */
  const state = {
    hostname: '',
    siteKey: '',
    enabled: false,
    gainDb: DEFAULT_GAIN_DB,
    blastGuard: DEFAULT_BLAST_GUARD,
    injected: false,
    hookAlive: false,
    hookActive: false,
    injecting: false,
    injectStartedAt: 0,
    lastError: '',
    lastStatusAt: 0,
    pendingProbe: null,
    popupProbe: null,
    syncInFlight: false,
    queuedSyncReason: '',
    queuedSyncPayload: null,
    bootstrapped: false,
    activationRetryTimer: null,
    activationRetryCount: 0,
    spaWatchTimer: null,
    hasSessionOverride: false,
    sessionEnabled: false,
    sessionGainDb: DEFAULT_GAIN_DB,
    sessionBlastGuard: DEFAULT_BLAST_GUARD,
  };

  globalThis.__tabNormalizerContentScriptV5 = {
    reinject: handleReinject,
  };

  refreshLocationState();
  console.log('[cs] loaded on:', state.hostname, location.href);
  ensureBootstrapListeners();
  if (state.siteKey) {
    scheduleSync('init');
  } else {
    console.log('[cs] no hostname, skipping');
  }

  function refreshLocationState() {
    state.hostname = extractHostname(location.href);
    state.siteKey = getSiteKey(state.hostname);
  }

  function ensureBootstrapListeners() {
    if (state.bootstrapped || !state.siteKey) return;

    let storageChangeTimer = null;

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || (!changes.activeSites && !changes.siteSettings)) return;
      if (storageChangeTimer) return;
      storageChangeTimer = setTimeout(() => {
        storageChangeTimer = null;
        console.log('[cs] storage changed, syncing');
        scheduleSync('storage');
      }, 100);
    });

    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message?.type === 'GET_DOCUMENT_STATUS') {
        void getDocumentStatus().then(sendResponse);
        return true;
      }
      if (message?.type === 'SET_DOCUMENT_STATE') {
        void handleSetDocumentState(message).then(sendResponse);
        return true;
      }
      if (message?.type === 'SOFT_RECHECK_DOCUMENT') {
        void handleSoftRecheckDocument().then(sendResponse);
        return true;
      }
      if (message?.type === 'CLEAR_SESSION_OVERRIDE') {
        state.hasSessionOverride = false;
        scheduleSync('clear-override');
        sendResponse({ ok: true });
        return true;
      }
      if (message?.type === 'TOGGLE_CHANGED') {
        if (message.enabled) {
          void handleSetDocumentState(message);
        } else {
          cleanupAndReset();
        }
        sendResponse({ ok: true });
        return true;
      }
      return false;
    });

    window.addEventListener('message', (event) => {
      if (event.source !== window || event.data?.channel !== CHANNEL) return;
      handleHookMessage(event.data);
    });

    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) scheduleSync('visibilitychange');
    });
    window.addEventListener('pageshow', () => scheduleSync('pageshow'));
    window.addEventListener('focus', () => scheduleSync('focus'));
    window.addEventListener('popstate', () => {
      refreshLocationState();
      if (state.siteKey) scheduleSync('popstate');
    });
    window.addEventListener('hashchange', () => {
      refreshLocationState();
      if (state.siteKey) scheduleSync('hashchange');
    });

    state.bootstrapped = true;
  }

  function startSpaWatch() {
    stopSpaWatch();
    let lastHref = location.href;
    state.spaWatchTimer = setInterval(() => {
      if (location.href === lastHref) return;
      lastHref = location.href;
      refreshLocationState();
      if (state.siteKey) scheduleSync('spa-navigation');
    }, 5000);
  }

  function stopSpaWatch() {
    if (state.spaWatchTimer) {
      clearInterval(state.spaWatchTimer);
      state.spaWatchTimer = null;
    }
  }

  function handleReinject() {
    refreshLocationState();
    console.log('[cs] reinjected on:', state.hostname, location.href);
    ensureBootstrapListeners();
    if (!state.siteKey) return;
    scheduleSync('reinject');
  }

  function isActivationPending() {
    return state.enabled && (state.injecting || state.syncInFlight || Boolean(state.pendingProbe));
  }

  /**
   * @param {string} reason
   * @param {Record<string, unknown>|null} [payload]
   */
  function scheduleSync(reason, payload = null) {
    if (state.syncInFlight) {
      state.queuedSyncReason = reason;
      state.queuedSyncPayload = payload;
      return;
    }

    void sync(reason, payload);
  }

  function clearActivationRetry() {
    if (state.activationRetryTimer) {
      clearTimeout(state.activationRetryTimer);
      state.activationRetryTimer = null;
    }
    state.activationRetryCount = 0;
  }

  function scheduleActivationRetry(reason) {
    if (!state.enabled || !state.siteKey) return;

    clearActivationRetry();

    const tick = () => {
      state.activationRetryTimer = null;

      if (!state.enabled || !state.siteKey) {
        state.activationRetryCount = 0;
        return;
      }

      postToPage('START', { reason, gainDb: state.gainDb, blastGuard: state.blastGuard });
      postToPage('SET_GAIN', { gainDb: state.gainDb });
      postToPage('SET_BLAST_GUARD', { blastGuard: state.blastGuard });

      state.activationRetryCount += 1;
      if (state.activationRetryCount < ACTIVATE_RETRY_COUNT && (!state.hookAlive || !state.hookActive)) {
        state.activationRetryTimer = setTimeout(tick, ACTIVATE_RETRY_MS);
      } else {
        state.activationRetryCount = 0;
      }
    };

    tick();
  }

  async function handleSetDocumentState(message) {
    state.hasSessionOverride = true;
    state.sessionEnabled = Boolean(message.enabled);
    state.sessionGainDb = clampGainDb(message.gainDb);
    state.sessionBlastGuard = Boolean(message.blastGuard);
    scheduleSync('session-override', {
      enabled: state.sessionEnabled,
      gainDb: state.sessionGainDb,
      blastGuard: state.sessionBlastGuard,
    });
    return { ok: true };
  }

  function cleanupAndReset() {
    state.hasSessionOverride = false;
    clearPendingStart();
    clearActivationRetry();
    stopSpaWatch();
    postToPage('STOP', { reason: 'toggle-changed' });
    state.hookActive = false;
    state.hookAlive = false;
    state.lastError = '';
  }

  async function handleSoftRecheckDocument() {
    const { enabled } = await getEffectiveDocumentState();
    if (!enabled) {
      return getDocumentStatus();
    }

    await sync('soft-recheck');
    return getDocumentStatus();
  }

  /**
   * @param {string} reason
   * @param {Record<string, unknown>|null} [payload]
   */
  async function sync(reason, payload = null) {
    refreshLocationState();
    if (!state.siteKey) {
      clearPendingStart();
      clearActivationRetry();
      stopSpaWatch();
      state.enabled = false;
      state.hookAlive = false;
      state.hookActive = false;
      state.lastError = '';
      return;
    }

    if (state.syncInFlight) {
      state.queuedSyncReason = reason;
      state.queuedSyncPayload = payload;
      return;
    }

    state.syncInFlight = true;

    try {
      let enabled, gainDb, blastGuard;

      if (payload && typeof payload.enabled === 'boolean') {
        enabled = payload.enabled;
        gainDb = clampGainDb(payload.gainDb);
        blastGuard = Boolean(payload.blastGuard);
      } else if (state.hasSessionOverride) {
        enabled = state.sessionEnabled;
        gainDb = state.sessionGainDb;
        blastGuard = state.sessionBlastGuard;
      } else {
        const stored = await chrome.storage.local.get({ activeSites: {}, siteSettings: {} });
        const siteSettings = migrateSiteSettings(stored.siteSettings, stored.activeSites);
        const config = getSiteConfig(siteSettings, {}, state.siteKey);
        enabled = config.enabled;
        gainDb = config.gainDb;
        blastGuard = config.blastGuard;

        const shouldPersistMigration = Object.keys(stored.activeSites || {}).length > 0 ||
          JSON.stringify(siteSettings) !== JSON.stringify(stored.siteSettings || {});
        if (shouldPersistMigration) {
          await chrome.storage.local.set({ activeSites: {}, siteSettings });
        }
      }

      state.enabled = enabled;
      state.gainDb = gainDb;
      state.blastGuard = blastGuard;

      console.log('[cs] sync:', state.siteKey, 'enabled:', enabled, 'gainDb:', gainDb, 'blastGuard:', blastGuard, 'injected:', state.injected, 'hookAlive:', state.hookAlive, 'reason:', reason, 'session:', state.hasSessionOverride);

      const hookAlive = enabled ? await evaluateHookHealth() : state.hookAlive;
      const action = getContentAction({ enabled, injected: state.injected, hookAlive });

      if (action === 'inject') {
        setPendingStart();
        inject();
        scheduleActivationRetry(reason);
        startSpaWatch();
        return;
      }

      if (action === 'start') {
        setPendingStart();
        postToPage('START', { reason, gainDb, blastGuard });
        postToPage('SET_GAIN', { gainDb });
        postToPage('SET_BLAST_GUARD', { blastGuard });
        scheduleActivationRetry(reason);
        startSpaWatch();
        console.log('[cs] sent START to hook');
        return;
      }

      if (action === 'stop') {
        clearPendingStart();
        clearActivationRetry();
        stopSpaWatch();
        postToPage('STOP', { reason });
        state.hookActive = false;
        state.hookAlive = false;
        state.lastError = '';
        return;
      }

      clearPendingStart();
      if (!enabled) {
        stopSpaWatch();
        state.hookAlive = false;
        state.hookActive = false;
        state.lastError = '';
      }

      if (enabled && state.injected) {
        startSpaWatch();
        postToPage('SET_GAIN', { gainDb });
        postToPage('SET_BLAST_GUARD', { blastGuard });
        scheduleActivationRetry(reason);
      }
    } finally {
      state.syncInFlight = false;
      if (state.queuedSyncReason) {
        const nextReason = state.queuedSyncReason;
        const nextPayload = state.queuedSyncPayload;
        state.queuedSyncReason = '';
        state.queuedSyncPayload = null;
        void sync(nextReason, nextPayload);
      }
    }
  }

  function inject() {
    if (state.injecting && (Date.now() - state.injectStartedAt) < INJECT_TIMEOUT_MS) return;

    if (state.injected) clearPendingStart();

    state.injecting = true;
    state.injectStartedAt = Date.now();
    state.injected = true;
    state.hookAlive = false;

    const workletUrl = chrome.runtime.getURL('audio/normalizer-worklet.js');
    document.documentElement?.setAttribute('data-tn-worklet-url', workletUrl);

    chrome.runtime.sendMessage({ type: 'INJECT_PAGE_HOOK' })
      .then((response) => {
        state.injecting = false;
        if (!response?.ok) {
          console.error('[cs] page-hook injection failed:', response?.error || 'unknown');
          state.injected = false;
          state.lastError = 'Failed to inject page hook.';
          return;
        }
        console.log('[cs] page-hook.js injected via background');
        if (state.enabled) {
          postToPage('START', { reason: 'inject-onload', gainDb: state.gainDb, blastGuard: state.blastGuard });
          postToPage('SET_GAIN', { gainDb: state.gainDb });
          postToPage('SET_BLAST_GUARD', { blastGuard: state.blastGuard });
          scheduleActivationRetry('inject-onload');
        }
      })
      .catch(() => {});
  }

  function handleHookMessage(data) {
    if (!data?.type) return;

    if (data.type === 'HOOK_STARTED' || data.type === 'HOOK_STATUS' || data.type === 'HOOK_ERROR') {
      console.log('[cs] hook status:', data.type, 'active:', Boolean(data.active), 'error:', data.error || '');
      state.injected = true;
      state.hookAlive = true;
      state.hookActive = Boolean(data.active);
      state.lastError = state.enabled ? String(data.error || '') : '';
      state.lastStatusAt = Date.now();
      if (data.type === 'HOOK_STARTED' || data.active) {
        clearPendingStart();
      }
      resolveProbe(true);
      return;
    }

    if (data.type === 'HOOK_STOPPED') {
      state.hookAlive = false;
      state.hookActive = false;
      state.lastError = '';
      state.lastStatusAt = Date.now();
      clearActivationRetry();
      resolveProbe(false);
    }
  }

  async function evaluateHookHealth() {
    if (!state.injected) return false;
    if (state.hookAlive && (Date.now() - state.lastStatusAt) < HOOK_FRESH_MS) return true;
    return probeHook();
  }

  async function probeHook() {
    if (!state.injected) {
      return false;
    }

    if (state.pendingProbe) {
      return state.pendingProbe.promise;
    }

    const requestId = `probe-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const pending = createProbe(requestId);
    postToPage('STATUS_REQUEST', { requestId });
    return pending;
  }

  function createProbe(requestId) {
    if (state.pendingProbe?.timeoutId) {
      clearTimeout(state.pendingProbe.timeoutId);
    }

    /** @type {(v: boolean) => void} */
    let resolvePending = () => {};
    const pendingPromise = new Promise((resolve) => {
      resolvePending = resolve;
    });

    state.pendingProbe = {
      requestId,
      promise: pendingPromise,
      resolve: resolvePending,
      timeoutId: setTimeout(() => {
        if (state.pendingProbe?.requestId !== requestId) return;
        state.pendingProbe = null;
        state.hookAlive = false;
        state.hookActive = false;
        resolvePending(false);
      }, HOOK_TIMEOUT_MS),
    };

    return pendingPromise;
  }

  function resolveProbe(alive) {
    if (!state.pendingProbe) return;

    clearTimeout(state.pendingProbe.timeoutId);
    state.pendingProbe.resolve(alive);
    state.pendingProbe = null;
  }

  function probePopup() {
    if (!state.enabled) return Promise.resolve(false);
    if (!state.injected) return Promise.resolve(false);

    return new Promise((resolve) => {
      const requestId = `popup-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      let settled = false;

      const handler = (event) => {
        if (settled) return;
        if (event.source !== window || event.data?.channel !== CHANNEL) return;
        if (event.data.requestId !== requestId) return;
        settled = true;
        window.removeEventListener('message', handler);
        clearTimeout(timeoutId);
        state.hookAlive = true;
        state.hookActive = Boolean(event.data.active);
        state.lastError = state.enabled ? String(event.data.error || '') : '';
        state.lastStatusAt = Date.now();
        resolve(true);
      };

      const timeoutId = setTimeout(() => {
        if (settled) return;
        settled = true;
        window.removeEventListener('message', handler);
        state.hookAlive = false;
        state.hookActive = false;
        resolve(false);
      }, HOOK_TIMEOUT_MS);

      window.addEventListener('message', handler);
      postToPage('STATUS_REQUEST', { requestId });
    });
  }

  async function getEffectiveDocumentState() {
    let enabled, gainDb, blastGuard;
    if (state.hasSessionOverride) {
      enabled = state.sessionEnabled;
      gainDb = state.sessionGainDb;
      blastGuard = state.sessionBlastGuard;
    } else {
      const stored = await chrome.storage.local.get({ activeSites: {}, siteSettings: {} });
      const config = getSiteConfig(stored.siteSettings, stored.activeSites, state.siteKey);
      enabled = config.enabled;
      gainDb = config.gainDb;
      blastGuard = config.blastGuard;
    }

    state.enabled = enabled;
    state.gainDb = gainDb;
    state.blastGuard = blastGuard;
    return { enabled, gainDb, blastGuard };
  }

  async function getDocumentStatus() {
    const { enabled } = await getEffectiveDocumentState();

    if (enabled) {
      if (!state.injected && !state.syncInFlight) {
        scheduleSync('popup-status');
      }

      if (!state.hookAlive || (Date.now() - state.lastStatusAt) >= HOOK_FRESH_MS) {
        void ensureFreshPopupStatus();
      }
    }

    const indicator = getPopupIndicator({
      enabled,
      hookAlive: state.hookAlive,
      hookActive: state.hookActive,
      lastError: state.lastError,
    });

    return {
      ok: true,
      enabled,
      hostname: state.hostname,
      siteKey: state.siteKey,
      gainDb: state.gainDb,
      blastGuard: state.blastGuard,
      hookAlive: state.hookAlive,
      hookActive: state.hookActive,
      activating: isActivationPending(),
      lastError: enabled ? state.lastError : '',
      indicator,
    };
  }

  function ensureFreshPopupStatus() {
    if (state.popupProbe) {
      return state.popupProbe;
    }

    state.popupProbe = probePopup().finally(() => {
      state.popupProbe = null;
    });

    return state.popupProbe;
  }

  function postToPage(type, payload) {
    window.postMessage({ channel: CHANNEL, type, ...payload }, '*');
  }

  function setPendingStart() {
    document.documentElement?.setAttribute(PENDING_ATTR, '1');
  }

  function clearPendingStart() {
    document.documentElement?.removeAttribute(PENDING_ATTR);
  }
})();
