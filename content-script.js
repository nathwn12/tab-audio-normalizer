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

  const contentShared = globalThis.TabNormalizerShared;

  /** @type {{
   *   hostname: string, siteKey: string, enabled: boolean, gainDb: number,
   *   blastGuard: boolean, injected: boolean, hookAlive: boolean,
   *   hookActive: boolean, injecting: boolean, injectStartedAt: number,
   *   lastError: string, lastStatusAt: number,
   *   transient: ({ enabled: boolean, gainDb: number, blastGuard: boolean } | null),
   *   pendingProbe: ({ requestId: string, promise: Promise<boolean>, resolve: (v: boolean) => void, timeoutId: number } | null),
   *   popupProbe: (Promise<boolean> | null),
   *   syncInFlight: boolean, queuedSyncReason: string,
   *   bootstrapped: boolean, activationRetryTimer: (number | null),
   *   activationRetryCount: number, spaWatchTimer: (number | null)
   * }} */
  const state = {
    hostname: '',
    siteKey: '',
    enabled: false,
    gainDb: contentShared.DEFAULT_GAIN_DB,
    blastGuard: contentShared.DEFAULT_BLAST_GUARD,
    injected: false,
    hookAlive: false,
    hookActive: false,
    injecting: false,
    injectStartedAt: 0,
    lastError: '',
    lastStatusAt: 0,
    transient: null,
    pendingProbe: null,
    popupProbe: null,
    syncInFlight: false,
    queuedSyncReason: '',
    bootstrapped: false,
    activationRetryTimer: null,
    activationRetryCount: 0,
    spaWatchTimer: null,
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
    state.hostname = contentShared.extractHostname(location.href);
    state.siteKey = contentShared.getSiteKey(state.hostname);
  }

  function ensureBootstrapListeners() {
    if (state.bootstrapped || !state.siteKey) return;

    let storageChangeTimer = null;

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      const perKey = state.siteKey ? contentShared.siteStorageKey(state.siteKey) : '';
      if (!changes.activeSites && !changes.siteSettings && !changes.siteToggles && !(perKey && changes[perKey])) return;
      // Persisted truth changed. Drop the transient session override
      // only when this tab's effective config actually changed, so an
      // unrelated site's save never cuts a transient session short — but the
      // next storage change for THIS site always clears it, and an ordinary
      // persisted save then reads storage like any other tab.
      if (storageChangeAffectsThisSite(changes)) {
        state.transient = null;
      }
      if (storageChangeTimer) return;
      storageChangeTimer = setTimeout(() => {
        storageChangeTimer = null;
        console.log('[cs] storage changed, syncing');
        scheduleSync('storage');
      }, 50);
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
        state.transient = null;
        scheduleSync('clear-override');
        sendResponse({ ok: true });
        return true;
      }
      if (message?.type === 'TOGGLE_CHANGED') {
        // The stored per-site record is the authority. This broadcast is only
        // a nudge to re-read storage, never a snapshot that outranks it. Guard the
        // site: tabs.sendMessage reaches every frame (all_frames:true), so a
        // toggle for page A must never reset an embedded frame from site B.
        // Finding 3: fail-closed — act only on an exact `siteKey` match and
        // reject when it is absent. `intendedToggleSite && ...` let an absent
        // key through to STOP, so disabling page A reset foreign frames.
        // Finding 2: a delayed disable broadcast must never stop a
        // re-enabled tab. The disable path re-reads the stored truth first;
        // when storage says enabled the broadcast is stale and the tab
        // re-syncs instead of calling cleanupAndReset().
        const intendedToggleSite = typeof message.siteKey === 'string'
          ? contentShared.getSiteKey(message.siteKey)
          : '';
        if (!intendedToggleSite || intendedToggleSite !== state.siteKey) {
          sendResponse({ ok: false, error: 'site mismatch' });
          return true;
        }
        if (message.enabled) {
          scheduleSync('toggle-changed');
          sendResponse({ ok: true });
          return true;
        }
        void (async () => {
          try {
            const cfg = await readStoredConfig();
            if (cfg.enabled) {
              scheduleSync('toggle-changed-stale-disable');
            } else {
              state.transient = null;
              cleanupAndReset();
            }
          } catch {
            // Fail closed on a read failure: never stop a potentially live
            // hook on a message alone — re-sync instead.
            scheduleSync('toggle-changed-read-failed');
          }
          sendResponse({ ok: true });
        })();
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

  /**
   * Whether a storage change alters this tab's effective config. A per-site
   * `site:<key>` change for THIS site counts; missing maps are equal on both
   * sides, so only a real before/after difference for this siteKey counts
   * (legacy activeSites merges are evaluated exactly).
   * @param {Record<string, { oldValue?: unknown, newValue?: unknown }>} changes
   */
  function storageChangeAffectsThisSite(changes) {
    if (!state.siteKey) return true;
    try {
      const perKey = contentShared.siteStorageKey(state.siteKey);
      if (perKey && changes[perKey]) {
        const oldRec = changes[perKey].oldValue && typeof changes[perKey].oldValue === 'object'
          ? contentShared.normalizeSiteRecord(changes[perKey].oldValue)
          : null;
        const newRec = changes[perKey].newValue && typeof changes[perKey].newValue === 'object'
          ? contentShared.normalizeSiteRecord(changes[perKey].newValue)
          : null;
        if (!oldRec || !newRec) return true;
        return oldRec.enabled !== newRec.enabled
          || oldRec.gainDb !== newRec.gainDb
          || oldRec.blastGuard !== newRec.blastGuard;
      }
      // Legacy fallback: evaluate the effective config (settings + actives
      // + toggles, all normalised) on both sides. A `siteToggles` change for
      // THIS site counts exactly like a settings/active change.
      if (!changes.siteSettings && !changes.activeSites && !changes.siteToggles) return false;
      const oldSettings = changes.siteSettings ? (changes.siteSettings.oldValue || {}) : {};
      const newSettings = changes.siteSettings ? (changes.siteSettings.newValue || {}) : {};
      const oldActive = changes.activeSites ? (changes.activeSites.oldValue || {}) : {};
      const newActive = changes.activeSites ? (changes.activeSites.newValue || {}) : {};
      const oldToggles = changes.siteToggles ? (changes.siteToggles.oldValue || {}) : {};
      const newToggles = changes.siteToggles ? (changes.siteToggles.newValue || {}) : {};
      const oldMig = contentShared.migrateLegacyToRecord(oldSettings, oldActive, oldToggles, state.siteKey);
      const newMig = contentShared.migrateLegacyToRecord(newSettings, newActive, newToggles, state.siteKey);
      if (oldMig || newMig) {
        const o = oldMig || { enabled: false, gainDb: 0, blastGuard: false };
        const n = newMig || { enabled: false, gainDb: 0, blastGuard: false };
        return o.enabled !== n.enabled || o.gainDb !== n.gainDb || o.blastGuard !== n.blastGuard;
      }
      const oldConfig = contentShared.getSiteConfig(oldSettings, oldActive, state.siteKey);
      const newConfig = contentShared.getSiteConfig(newSettings, newActive, state.siteKey);
      return oldConfig.enabled !== newConfig.enabled
        || oldConfig.gainDb !== newConfig.gainDb
        || oldConfig.blastGuard !== newConfig.blastGuard;
    } catch {
      return true;
    }
  }

  /**
   * Read this tab's effective stored config: the per-site `site:<key>` record
   * is the authority; legacy `siteSettings`/`activeSites` (+ explicit
   * `siteToggles` when present via the background migration) are the fallback
   * for data written before the per-site keys existed. Read-only: this file
   * performs NO storage write.
   * @returns {Promise<{ enabled: boolean, gainDb: number, blastGuard: boolean }>}
   */
  async function readStoredConfig() {
    const perKey = contentShared.siteStorageKey(state.siteKey);
    // Platform fact (measured Step 1 repro): an object-form `undefined`
    // default is dropped by the extension API's JSON marshal, so
    // `get({ [perKey]: undefined })` returns `{}` even when the key exists.
    // The array form is proven to return the value. Missing keys are simply
    // absent; the callees below tolerate undefined legacy maps.
    /** @type {string[]} */
    const keys = ['activeSites', 'siteSettings', 'siteToggles'];
    if (perKey) keys.push(perKey);
    const stored = await chrome.storage.local.get(keys);
    const perValue = perKey ? stored[perKey] : undefined;
    if (perValue && typeof perValue === 'object') {
      const rec = contentShared.normalizeSiteRecord(perValue);
      return { enabled: rec.enabled, gainDb: rec.gainDb, blastGuard: rec.blastGuard };
    }
    // Lossless legacy fallback: normalise every legacy shape (settings,
    // actives AND toggles) before matching, so a `www.`-only entry is found
    // from the canonical key. Read-only — persistence belongs to the
    // background single writer.
    const migrated = contentShared.migrateLegacyToRecord(
      stored.siteSettings, stored.activeSites, stored.siteToggles, state.siteKey,
    );
    if (migrated) {
      return { enabled: migrated.enabled, gainDb: migrated.gainDb, blastGuard: migrated.blastGuard };
    }
    const config = contentShared.getSiteConfig(stored.siteSettings, stored.activeSites, state.siteKey);
    return { enabled: config.enabled, gainDb: config.gainDb, blastGuard: config.blastGuard };
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
   */
  function scheduleSync(reason) {
    if (state.syncInFlight) {
      state.queuedSyncReason = reason;
      return;
    }

    void sync(reason);
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
    // Single-writer rule: persistence lives only in background.js
    // (SET_SITE_STATE -> per-site `site:<key>`). This tab message is
    // read-only: it applies state to the live document and never writes
    // storage (zero `chrome.storage.local.set` calls are reachable from this
    // path; no migration write exists anywhere in this file).
    // Explicit site guard: a popup action names the site it is showing and a
    // frame ignores a mismatched key, so disabling page A can never disable
    // an embedded cross-origin iframe from site B. Fail-closed — only an
    // exact `siteKey` match applies; a matching `hostname` alone is rejected.
    const intendedSite = typeof message?.siteKey === 'string'
      ? contentShared.getSiteKey(message.siteKey)
      : '';
    if (!intendedSite || intendedSite !== state.siteKey) {
      return { ok: false, error: 'site mismatch' };
    }
    // Genuine transient session state — the background flags its
    // pending-session apply with `transient: true` (`persist: false` is
    // accepted for the same contract). ONLY a flagged request installs the
    // session override: an ordinary persisted save arrives
    // unflagged and must leave this document reading storage like any other
    // tab, never installing a snapshot that later storage changes cannot
    // dislodge. A transient DISABLE installs the override too:
    // enabled:false outranks stored enabled:true for this tab's lifetime, and
    // only the next storage change for this site clears it.
    const isTransient = message.transient === true || message.persist === false;
    if (!isTransient) {
      state.transient = null;
      await sync('document-state');
      return { ok: true };
    }
    // Transient path: apply the message's fields to the live document without
    // touching storage. Missing fields fall back to stored defaults via a
    // single read; nothing is persisted.
    const base = await readStoredConfig();
    const enabled = Object.prototype.hasOwnProperty.call(message, 'enabled')
      ? Boolean(message.enabled)
      : base.enabled;
    const gainDb = Object.prototype.hasOwnProperty.call(message, 'gainDb')
      ? contentShared.clampGainDb(message.gainDb)
      : base.gainDb;
    const blastGuard = Object.prototype.hasOwnProperty.call(message, 'blastGuard')
      ? Boolean(message.blastGuard)
      : base.blastGuard;
    state.transient = { enabled, gainDb, blastGuard };
    state.enabled = enabled;
    state.gainDb = gainDb;
    state.blastGuard = blastGuard;

    console.log('[cs] document-state (transient):', state.siteKey, 'enabled:', enabled, 'gainDb:', gainDb, 'blastGuard:', blastGuard);

    const hookAlive = await evaluateHookHealth();
    const action = contentShared.getContentAction({ enabled, injected: state.injected, hookAlive });

    if (action === 'inject') {
      setPendingStart();
      inject();
      scheduleActivationRetry('document-state');
      startSpaWatch();
      return { ok: true };
    }

    if (action === 'start') {
      setPendingStart();
      postToPage('START', { reason: 'document-state', gainDb, blastGuard });
      postToPage('SET_GAIN', { gainDb });
      postToPage('SET_BLAST_GUARD', { blastGuard });
      scheduleActivationRetry('document-state');
      startSpaWatch();
      console.log('[cs] sent START to hook');
      return { ok: true };
    }

    if (action === 'stop') {
      clearPendingStart();
      clearActivationRetry();
      stopSpaWatch();
      postToPage('STOP', { reason: 'document-state' });
      state.hookActive = false;
      state.hookAlive = false;
      state.lastError = '';
      return { ok: true };
    }

    clearPendingStart();
    if (state.injected) {
      startSpaWatch();
      postToPage('SET_GAIN', { gainDb });
      postToPage('SET_BLAST_GUARD', { blastGuard });
      scheduleActivationRetry('document-state');
    }
    return { ok: true };
  }

  function cleanupAndReset() {
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
   */
  async function sync(reason) {
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
      return;
    }

    state.syncInFlight = true;

    try {
      // The per-site `site:<key>` record is the single authority; legacy maps
      // are the read fallback. This file performs NO storage write — migration
      // persistence belongs to the background's single writer; this context
      // only reads.
      const config = await readStoredConfig();
      // Finding 7: an active transient session override outranks stored
      // settings for the live document until cleared (disable/clear-override).
      const enabled = state.transient ? state.transient.enabled : config.enabled;
      const gainDb = state.transient ? state.transient.gainDb : config.gainDb;
      const blastGuard = state.transient ? state.transient.blastGuard : config.blastGuard;

      state.enabled = enabled;
      state.gainDb = gainDb;
      state.blastGuard = blastGuard;

      console.log('[cs] sync:', state.siteKey, 'enabled:', enabled, 'gainDb:', gainDb, 'blastGuard:', blastGuard, 'injected:', state.injected, 'hookAlive:', state.hookAlive, 'reason:', reason);

      const hookAlive = enabled ? await evaluateHookHealth() : state.hookAlive;
      const action = contentShared.getContentAction({ enabled, injected: state.injected, hookAlive });

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
        state.queuedSyncReason = '';
        void sync(nextReason);
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
      .catch((error) => {
        // A rejected injection must not stall later attempts until
        // INJECT_TIMEOUT_MS expires: release the flag and surface the error.
        state.injecting = false;
        state.lastError = 'Failed to inject page hook.';
        console.error('[cs] page-hook injection failed:', error);
      });
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
    // A transient session override outranks stored settings for the live
    // document until cleared. The per-site record stays the persistence
    // authority; the transient only shapes what this tab applies and reports.
    if (state.transient) {
      state.enabled = state.transient.enabled;
      state.gainDb = state.transient.gainDb;
      state.blastGuard = state.transient.blastGuard;
      return { ...state.transient };
    }
    // The per-site record is the single authority (legacy maps are the
    // read fallback). No session snapshot outranks it.
    const config = await readStoredConfig();
    const enabled = config.enabled;
    const gainDb = config.gainDb;
    const blastGuard = config.blastGuard;

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

    const indicator = contentShared.getPopupIndicator({
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
