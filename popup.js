const toggle = document.getElementById('toggle');
const gainSlider = document.getElementById('gain-slider');
const gainValueEl = document.getElementById('gain-value');
const hostnameEl = document.getElementById('hostname');
const statusDotEl = document.getElementById('status-dot');
const statusTextEl = document.getElementById('status-text');

const {
  clampGainDb,
  extractHostname,
  getSiteKey,
  getPopupIndicator,
} = globalThis.TabNormalizerShared;

let hostname = '';
let siteKey = '';
let tabId = null;
let statusTimer = null;
let hookWasActiveAt = 0;
let lastHookActive = false;
let saveGainTimer = null;
let statusRequestToken = 0;
const ACTIVE_STALE_MS = 3000;

void init();

toggle.addEventListener('change', () => {
  void toggleSite();
});

gainSlider.addEventListener('input', () => {
  if (gainSlider.disabled) return;
  const gainDb = clampGainDb(gainSlider.value);
  gainSlider.value = String(gainDb);
  renderGain(gainDb);
  queueGainSave(gainDb);
});

async function init() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url) {
      hostnameEl.textContent = 'N/A';
      toggle.disabled = true;
      gainSlider.disabled = true;
      renderStatus({ indicator: 'gray', text: 'No supported tab.' });
      return;
    }

    tabId = tab.id ?? null;
    hostname = extractHostname(tab.url);
    siteKey = getSiteKey(hostname);
    if (!hostname) {
      hostnameEl.textContent = 'N/A';
      toggle.disabled = true;
      gainSlider.disabled = true;
      renderStatus({ indicator: 'gray', text: 'No supported tab.' });
      return;
    }

    hostnameEl.textContent = siteKey || hostname;

    const res = await chrome.runtime.sendMessage({
      type: 'GET_SITE_STATE',
      siteKey,
    });

    toggle.checked = Boolean(res?.enabled);
    gainSlider.value = String(clampGainDb(res?.gainDb));
    renderGain(gainSlider.value);
    toggle.disabled = false;
    syncGainControlState();
    await refreshDocumentStatus();
    statusTimer = setInterval(() => {
      void refreshDocumentStatus();
    }, 750);
  } catch {
    hostnameEl.textContent = 'Error';
    toggle.disabled = true;
    gainSlider.disabled = true;
    renderStatus({ indicator: 'red', text: 'Extension status unavailable.' });
  }
}

async function toggleSite() {
  if (!siteKey) {
    toggle.checked = !toggle.checked;
    return;
  }

  if (!toggle.checked) {
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
    const res = await chrome.runtime.sendMessage({
      type: 'SET_SITE_STATE',
      siteKey,
      enabled: toggle.checked,
      gainDb: clampGainDb(gainSlider.value),
    });

    toggle.checked = Boolean(res?.enabled);
    gainSlider.value = String(clampGainDb(res?.gainDb));
    renderGain(gainSlider.value);
    syncGainControlState();
    await refreshDocumentStatus();
  } catch {
    toggle.checked = !toggle.checked;
  } finally {
    toggle.disabled = false;
    syncGainControlState();
  }
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
    const res = await chrome.runtime.sendMessage({
      type: 'SET_SITE_STATE',
      siteKey,
      gainDb,
    });
    const nextGain = clampGainDb(res?.gainDb);
    gainSlider.value = String(nextGain);
    renderGain(nextGain);
  } catch {}
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
    const lastError = String(doc?.lastError || '');

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

    renderStatus({
      indicator: nextIndicator,
      text: getStatusText({
        enabled,
        hookActive: recentlyActive,
        lastError,
      }),
    });
  } catch {
    if (requestToken !== statusRequestToken) return;
    renderStatus({
      indicator: fallbackIndicator,
      text: toggle.checked ? 'Waiting for page hook…' : 'Off for this site.',
    });
  }
}

function getStatusText({ enabled, hookActive, lastError }) {
  if (enabled && lastError) return lastError;
  if (enabled && hookActive) return 'Normalizer active.';
  if (enabled) return 'Enabled. Waiting for audio.';
  return 'Off for this site.';
}

function renderStatus({ indicator, text }) {
  statusDotEl.className = `dot${indicator === 'green' ? ' green' : indicator === 'red' ? ' red' : ''}`;
  statusTextEl.textContent = text;
}

function renderGain(gainDb) {
  const numeric = clampGainDb(gainDb);
  const prefix = numeric > 0 ? '+' : '';
  gainValueEl.textContent = `${prefix}${numeric.toFixed(1)} dB`;
}

function syncGainControlState() {
  gainSlider.disabled = toggle.disabled || !toggle.checked;
}

window.addEventListener('unload', () => {
  if (statusTimer) clearInterval(statusTimer);
  if (saveGainTimer) clearTimeout(saveGainTimer);
});
