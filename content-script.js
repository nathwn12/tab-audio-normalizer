const CHANNEL = 'tab-normalizer-v5';
const HOOK_TIMEOUT_MS = 1000;
const HOOK_FRESH_MS = 3000;
const INJECT_TIMEOUT_MS = 5000;

const {
  extractHostname,
  getSiteKey,
  migrateActiveSites,
  getContentAction,
  getPopupIndicator,
} = globalThis.TabNormalizerShared;

const state = {
  hostname: extractHostname(location.href),
  siteKey: getSiteKey(extractHostname(location.href)),
  enabled: false,
  injected: false,
  hookAlive: false,
  hookActive: false,
  injecting: false,
  injectStartedAt: 0,
  lastError: '',
  lastStatusAt: 0,
  pendingProbe: null,
  syncInFlight: false,
  queuedSyncReason: '',
};

const PENDING_ATTR = 'data-tab-normalizer-pending';

console.log('[cs] loaded on:', state.hostname, location.href);

if (!state.siteKey) {
  console.log('[cs] no hostname, skipping');
} else {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.activeSites) return;
    console.log('[cs] storage changed, syncing');
    scheduleSync('storage');
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== 'GET_DOCUMENT_STATUS') return false;

    void getDocumentStatus().then(sendResponse);
    return true;
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

  scheduleSync('init');
}

function scheduleSync(reason) {
  if (state.syncInFlight) {
    state.queuedSyncReason = reason;
    return;
  }

  void sync(reason);
}

async function sync(reason) {
  if (state.syncInFlight) {
    state.queuedSyncReason = reason;
    return;
  }

  state.syncInFlight = true;

  try {
    const stored = await chrome.storage.local.get({ activeSites: {} });
    const activeSites = migrateActiveSites(stored.activeSites);
    const enabled = Boolean(activeSites[state.siteKey]);
    state.enabled = enabled;

    console.log('[cs] sync:', state.siteKey, 'enabled:', enabled, 'injected:', state.injected, 'hookAlive:', state.hookAlive, 'reason:', reason);

    const hookAlive = enabled ? await evaluateHookHealth() : state.hookAlive;
    const action = getContentAction({ enabled, injected: state.injected, hookAlive });

    if (action === 'inject') {
      setPendingStart();
      inject();
      return;
    }

    if (action === 'start') {
      setPendingStart();
      postToPage('START', { reason });
      console.log('[cs] sent START to hook');
      return;
    }

    if (action === 'stop') {
      clearPendingStart();
      postToPage('STOP', { reason });
      state.hookActive = false;
      state.hookAlive = false;
      state.lastError = '';
      return;
    }

    clearPendingStart();
    if (!enabled) {
      state.hookAlive = false;
      state.hookActive = false;
      state.lastError = '';
    }
  } finally {
    state.syncInFlight = false;
    if (state.queuedSyncReason) {
      const nextReason = state.queuedSyncReason;
      state.queuedSyncReason = '';
      scheduleSync(nextReason);
    }
  }
}

function inject() {
  if (state.injecting && (Date.now() - state.injectStartedAt) < INJECT_TIMEOUT_MS) return;

  // On re-injection only: clear stale pending attribute from previous page/SPA
  if (state.injected) clearPendingStart();

  state.injecting = true;
  state.injectStartedAt = Date.now();
  state.injected = true;
  state.hookAlive = false;
  console.log('[cs] injecting page-hook.js');

  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('page-hook.js');
  script.async = false;
  script.onload = () => {
    console.log('[cs] page-hook.js loaded');
    state.injecting = false;
    script.remove();
  };
  script.onerror = (e) => {
    console.error('[cs] page-hook.js FAILED to load:', e);
    state.injecting = false;
    state.injected = false;
    state.lastError = 'Failed to inject page hook.';
  };
  (document.head || document.documentElement).appendChild(script);
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

  const requestId = `probe-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const pending = createProbe(requestId);
  postToPage('STATUS_REQUEST', { requestId });
  return pending;
}

function createProbe(requestId) {
  if (state.pendingProbe?.timeoutId) {
    clearTimeout(state.pendingProbe.timeoutId);
  }

  return new Promise((resolve) => {
    state.pendingProbe = {
      requestId,
      resolve,
      timeoutId: setTimeout(() => {
        if (state.pendingProbe?.requestId !== requestId) return;
        state.pendingProbe = null;
        state.hookAlive = false;
        state.hookActive = false;
        resolve(false);
      }, HOOK_TIMEOUT_MS),
    };
  });
}

function resolveProbe(alive) {
  if (!state.pendingProbe) return;

  clearTimeout(state.pendingProbe.timeoutId);
  state.pendingProbe.resolve(alive);
  state.pendingProbe = null;
}

function probePopup() {
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
      resolve(false);
    }, HOOK_TIMEOUT_MS);

    window.addEventListener('message', handler);
    postToPage('STATUS_REQUEST', { requestId });
  });
}

async function getDocumentStatus() {
  const stored = await chrome.storage.local.get({ activeSites: {} });
  const activeSites = migrateActiveSites(stored.activeSites);
  const enabled = Boolean(activeSites[state.siteKey]);

  state.enabled = enabled;

  if (enabled) {
    if (state.hookAlive && (Date.now() - state.lastStatusAt) < HOOK_FRESH_MS) {
      // Fresh status available, no probe needed
    } else {
      await probePopup();
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
    hookAlive: state.hookAlive,
    hookActive: state.hookActive,
    lastError: enabled ? state.lastError : '',
    indicator,
  };
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
