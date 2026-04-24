const toggle = document.getElementById('toggle');
const remember = document.getElementById('remember');
const gainSlider = document.getElementById('gain-slider');
const gainValueEl = document.getElementById('gain-value');
const hostnameEl = document.getElementById('hostname');
const statusDotEl = document.getElementById('status-dot');
const statusTextEl = document.getElementById('status-text');
const presetButtons = [...document.querySelectorAll('[data-preset]')];

const {
  clampGainDb,
  extractHostname,
  getSiteKey,
  getPopupIndicator,
} = globalThis.TabNormalizerShared;

const PRESETS = {
  speech: -3,
  music: 0,
  boost: 3,
};

let hostname = '';
let siteKey = '';
let tabId = null;
let statusTimer = null;
let hookWasActiveAt = 0;
let lastHookActive = false;
let saveGainTimer = null;
let statusRequestToken = 0;
let runtimeActivationState = 'idle';
let runtimeActivationMessage = '';
let softWakePromise = null;
const ACTIVE_STALE_MS = 3000;

void init();

toggle.addEventListener('change', () => {
  void toggleSite();
});

remember.addEventListener('change', () => {
  void handleRememberChange();
});

gainSlider.addEventListener('input', () => {
  if (gainSlider.disabled) return;
  const gainDb = clampGainDb(gainSlider.value);
  gainSlider.value = String(gainDb);
  renderGain(gainDb);
  queueGainSave(gainDb);
});

gainSlider.addEventListener('pointerdown', () => {
  void requestSliderSoftWake();
});

presetButtons.forEach((button) => {
  button.addEventListener('click', () => {
    const presetGain = PRESETS[button.dataset.preset];
    if (typeof presetGain !== 'number') return;
    applyPreset(presetGain);
  });
});

async function init() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url) {
      hostnameEl.textContent = 'N/A';
      disableAll('No supported tab.');
      return;
    }

    tabId = tab.id ?? null;
    hostname = extractHostname(tab.url);
    siteKey = getSiteKey(hostname);
    if (!hostname) {
      hostnameEl.textContent = 'N/A';
      disableAll('No supported tab.');
      return;
    }

    hostnameEl.textContent = siteKey || hostname;

    const [state, settings] = await Promise.all([
      chrome.runtime.sendMessage({ type: 'GET_SITE_STATE', siteKey }),
      chrome.storage.local.get({ rememberEnabled: true }),
    ]);

    toggle.checked = Boolean(state?.enabled);
    gainSlider.value = String(clampGainDb(state?.gainDb));
    renderGain(gainSlider.value);
    remember.checked = Boolean(settings.rememberEnabled ?? true);
    toggle.disabled = false;
    remember.disabled = false;
    syncGainControlState();
    syncPresetControlState();
    await refreshDocumentStatus();
    statusTimer = setInterval(() => {
      void refreshDocumentStatus();
    }, 750);
  } catch {
    hostnameEl.textContent = 'Error';
    disableAll('Extension status unavailable.');
  }
}

function disableAll(statusText) {
  toggle.disabled = true;
  remember.disabled = true;
  gainSlider.disabled = true;
  syncPresetControlState();
  renderStatus({ indicator: 'gray', text: statusText });
}

async function handleRememberChange() {
  const rememberEnabled = remember.checked;
  await chrome.storage.local.set({ rememberEnabled });

  if (rememberEnabled && siteKey && tabId) {
    try {
      const res = await chrome.runtime.sendMessage({
        type: 'SET_SITE_STATE',
        siteKey,
        tabId,
        enabled: toggle.checked,
        gainDb: clampGainDb(gainSlider.value),
      });
      applyControlState({
        enabled: res?.enabled,
        gainDb: res?.gainDb,
      });
      await chrome.tabs.sendMessage(tabId, { type: 'CLEAR_SESSION_OVERRIDE' });
    } catch {}
  }
}

async function toggleSite() {
  if (!siteKey) {
    toggle.checked = !toggle.checked;
    return;
  }

  if (!toggle.checked) {
    runtimeActivationState = 'idle';
    runtimeActivationMessage = '';
    lastHookActive = false;
    hookWasActiveAt = 0;
    if (saveGainTimer) {
      clearTimeout(saveGainTimer);
      saveGainTimer = null;
    }
  }

  toggle.disabled = true;
  syncGainControlState();

  try {
    if (remember.checked) {
      await toggleSitePersistent();
    } else {
      await toggleSiteSession();
    }
    await refreshDocumentStatus();
  } catch {
    toggle.checked = !toggle.checked;
  } finally {
    toggle.disabled = false;
    syncGainControlState();
    syncPresetControlState();
  }
}

async function toggleSitePersistent() {
  if (toggle.checked) {
    runtimeActivationState = 'pending';
    runtimeActivationMessage = 'Enabling on this tab…';
    renderStatus({ indicator: 'gray', text: runtimeActivationMessage });
  }

  const res = await chrome.runtime.sendMessage({
    type: 'SET_SITE_STATE',
    siteKey,
    tabId,
    enabled: toggle.checked,
    gainDb: clampGainDb(gainSlider.value),
  });

  toggle.checked = Boolean(res?.enabled);
  runtimeActivationState = String(res?.activation?.state || (toggle.checked ? 'pending' : 'idle'));
  runtimeActivationMessage = String(res?.activation?.message || '');
  gainSlider.value = String(clampGainDb(res?.gainDb));
  renderGain(gainSlider.value);
  syncGainControlState();
}

async function toggleSiteSession() {
  if (!tabId) return;

  if (toggle.checked) {
    runtimeActivationState = 'pending';
    runtimeActivationMessage = 'Enabling on this tab…';
    renderStatus({ indicator: 'gray', text: runtimeActivationMessage });
  }

  const res = await chrome.runtime.sendMessage({
    type: 'SET_SITE_STATE',
    siteKey,
    tabId,
    enabled: toggle.checked,
    gainDb: clampGainDb(gainSlider.value),
    persist: false,
  });

  runtimeActivationState = String(res?.activation?.state || (toggle.checked ? 'pending' : 'idle'));
  runtimeActivationMessage = String(res?.activation?.message || '');

  try {
    await chrome.tabs.sendMessage(tabId, {
      type: 'SET_DOCUMENT_STATE',
      enabled: toggle.checked,
      gainDb: clampGainDb(gainSlider.value),
    });
  } catch {
    // Content script may be unreachable on restricted pages.
  }

  syncGainControlState();
}

function queueGainSave(gainDb) {
  if (!siteKey || !toggle.checked || gainSlider.disabled) return;
  if (saveGainTimer) clearTimeout(saveGainTimer);
  saveGainTimer = setTimeout(() => {
    saveGainTimer = null;
    void saveGain(gainDb);
  }, 120);
}

async function saveGain(gainDb) {
  if (!toggle.checked) return;
  try {
    if (remember.checked) {
      const res = await chrome.runtime.sendMessage({
        type: 'SET_SITE_STATE',
        siteKey,
        gainDb,
      });
      const nextGain = clampGainDb(res?.gainDb);
      gainSlider.value = String(nextGain);
      renderGain(nextGain);
    } else if (tabId) {
      await chrome.tabs.sendMessage(tabId, {
        type: 'SET_DOCUMENT_STATE',
        enabled: toggle.checked,
        gainDb,
      });
    }
  } catch {}
}

async function requestSliderSoftWake() {
  if (softWakePromise || !siteKey || !tabId) return;
  if (!toggle.checked && runtimeActivationState !== 'pending' && runtimeActivationState !== 'active') return;

  softWakePromise = (async () => {
    try {
      const res = await chrome.runtime.sendMessage({
        type: 'SOFT_RECHECK_DOCUMENT',
        siteKey,
        tabId,
      });
      if (res?.activation?.state) {
        runtimeActivationState = String(res.activation.state);
        runtimeActivationMessage = String(res.activation.message || '');
      }
    } catch {
      // Restricted or unreachable tabs can fail quietly here.
    } finally {
      try {
        await refreshDocumentStatus();
      } finally {
        softWakePromise = null;
      }
    }
  })();

  await softWakePromise;
}

function applyPreset(gainDb) {
  if (gainSlider.disabled) return;

  const nextGain = clampGainDb(gainDb);
  gainSlider.value = String(nextGain);
  renderGain(nextGain);
  queueGainSave(nextGain);
}

async function refreshDocumentStatus() {
  const requestToken = ++statusRequestToken;
  const fallbackIndicator = getPopupIndicator({
    enabled: toggle.checked,
    hookAlive: false,
    hookActive: false,
    lastError: '',
  });

  if (!tabId) {
    renderStatus({ indicator: fallbackIndicator, text: toggle.checked ? 'Waiting for tab status…' : 'Off for this site.' });
    return;
  }

  try {
    const doc = await chrome.tabs.sendMessage(tabId, { type: 'GET_DOCUMENT_STATUS' });
    if (requestToken !== statusRequestToken) return;
    const enabled = Boolean(doc?.enabled);
    const hookAlive = Boolean(doc?.hookAlive);
    const hookActive = Boolean(doc?.hookActive);
    const activating = Boolean(doc?.activating);
    const lastError = String(doc?.lastError || '');

    if (!remember.checked) {
      applyControlState({
        enabled,
        gainDb: doc?.gainDb,
      });
    }

    if (hookActive) {
      hookWasActiveAt = Date.now();
      lastHookActive = true;
    }

    const recentlyActive = hookActive || (lastHookActive && enabled && hookAlive && (Date.now() - hookWasActiveAt) < ACTIVE_STALE_MS);

    const nextIndicator = getPopupIndicator({
      enabled,
      hookAlive,
      hookActive: recentlyActive,
      lastError,
    });

    if (!enabled) {
      runtimeActivationState = 'idle';
      runtimeActivationMessage = '';
    } else if (lastError) {
      runtimeActivationState = 'idle';
      runtimeActivationMessage = '';
    } else if (hookAlive || recentlyActive) {
      runtimeActivationState = 'active';
      runtimeActivationMessage = '';
    } else if (activating || runtimeActivationState === 'pending') {
      runtimeActivationState = 'pending';
    } else {
      runtimeActivationState = 'idle';
      runtimeActivationMessage = '';
    }

    renderStatus({
      indicator: nextIndicator,
      text: getStatusText({
        enabled,
        hookActive: recentlyActive,
        activating,
        lastError,
      }),
    });
  } catch {
    if (requestToken !== statusRequestToken) return;
    if (toggle.checked && runtimeActivationState === 'restricted') {
      renderStatus({ indicator: 'gray', text: runtimeActivationMessage || 'Enabled. Reload on a supported page.' });
      return;
    }

    renderStatus({
      indicator: fallbackIndicator,
      text: toggle.checked
        ? (runtimeActivationMessage || 'Enabled. Waiting for this page.')
        : 'Off for this site.',
    });
  }
}

function getStatusText({ enabled, hookActive, activating, lastError }) {
  if (enabled && lastError) return lastError;
  if (enabled && hookActive) return 'Normalizer active.';
  if (enabled && runtimeActivationState === 'restricted') {
    return runtimeActivationMessage || 'Enabled. Reload on a supported page.';
  }
  if (enabled && (activating || runtimeActivationState === 'pending')) {
    return runtimeActivationMessage || 'Enabling on this tab…';
  }
  if (enabled) return 'Enabled. Waiting for audio.';
  return 'Off for this site.';
}

function renderStatus({ indicator, text }) {
  statusDotEl.className = indicator === 'green' ? 'green' : indicator === 'red' ? 'red' : '';
  statusTextEl.textContent = text;
}

function renderGain(gainDb) {
  const numeric = clampGainDb(gainDb);
  const prefix = numeric > 0 ? '+' : '';
  gainValueEl.textContent = `${prefix}${numeric.toFixed(1)} dB`;
}

function applyControlState({ enabled, gainDb }) {
  toggle.checked = Boolean(enabled);
  gainSlider.value = String(clampGainDb(gainDb));
  renderGain(gainSlider.value);
  syncGainControlState();
  syncPresetControlState();
}

function syncGainControlState() {
  gainSlider.disabled = toggle.disabled || !toggle.checked;
}

function syncPresetControlState() {
  const disabled = toggle.disabled || !toggle.checked;
  for (const button of presetButtons) {
    button.disabled = disabled;
  }
}

window.addEventListener('unload', () => {
  if (statusTimer) clearInterval(statusTimer);
  if (saveGainTimer) clearTimeout(saveGainTimer);
});
