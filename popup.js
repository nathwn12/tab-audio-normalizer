const resetBtnEl = /** @type {HTMLButtonElement} */ (document.getElementById('reset-btn'));
const toggle = /** @type {HTMLInputElement} */ (document.getElementById('toggle'));
const blastGuardToggle = /** @type {HTMLInputElement} */ (document.getElementById('blast-guard'));
const gainSlider = /** @type {HTMLInputElement} */ (document.getElementById('gain-slider'));
const gainValueEl = /** @type {HTMLElement} */ (document.getElementById('gain-value'));
const hostnameEl = /** @type {HTMLElement} */ (document.getElementById('hostname'));
const statusDotEl = /** @type {HTMLElement} */ (document.getElementById('status-dot'));
const statusTextEl = /** @type {HTMLElement} */ (document.getElementById('status-text'));
/** @type {NodeListOf<HTMLButtonElement>} */
const presetButtons = document.querySelectorAll('[data-preset]');

const popupShared = globalThis.TabNormalizerShared;

const PRESETS = {
  speech: -3,
  music: 0,
  boost: 3,
};

let hostname = '';
let siteKey = '';
let tabId = null;
let hookWasActiveAt = 0;
let lastHookActive = false;
let statusRequestToken = 0;
let runtimeActivationState = 'idle';
let runtimeActivationMessage = '';
let softWakePromise = null;
const ACTIVE_STALE_MS = 3000;

// Single owner: the background owns persisted state and applies intents.
// This popup sends field-level intents (`set` with ONLY the changed field)
// with no timestamps and no ordering token. Dispatch is immediate with no
// in-memory queue. Ordering is last-accepted-write-wins: the background
// applies an intent's fields to the live record, writes the whole record
// back in one `set`, bumps the per-site `seq` audit counter (observability
// only, never a gate), and returns the stored truth. Nothing is ever
// rejected on ordering grounds. Accepted trade (deliberate): if two popups
// race the same field and one message is delayed past a newer one, the later
// *arrival* wins rather than the later action; there is no clock-free way to
// distinguish those, the window is milliseconds between two
// simultaneously-open popups, and the wall-clock alternative locked a field
// out until the clock caught up. The popup always renders what the
// background returned, never what it sent; a response missing the stored
// truth is a failure, not a success.
// No `unload` flush: every change is already sent on its `change`/
// `input` event (RESEARCH §6: the popup document is unloaded on close with no
// flush facility).

/**
 * Require the background's stored truth. The popup renders what the
 * background returned, never what it sent: a response missing the stored
 * fields is a failure, not a success.
 * @param {unknown} res
 */
function requireStoredTruth(res) {
  if (!res || typeof res !== 'object') throw new Error('save failed: no stored truth');
  const r = /** @type {Record<string, unknown>} */ (res);
  if (r.ok === false) throw new Error(String(r.error || 'save failed'));
  if (typeof r.enabled !== 'boolean'
    || typeof r.blastGuard !== 'boolean'
    || !Number.isFinite(Number(r.gainDb))) {
    throw new Error('save failed: response carries no stored truth');
  }
  return r;
}

/**
 * Re-read the stored truth and apply it to the controls.
 * Rejects when the background does not report ok so callers
 * never mistake a failed read for the stored truth.
 * @returns {Promise<Record<string, unknown> | null>}
 */
async function revertToStoredTruth() {
  const state = await chrome.runtime.sendMessage({ type: 'GET_SITE_STATE', hostname: siteKey });
  if (!state || state.ok !== true) {
    throw new Error(String((state && state.error) || 'read failed'));
  }
  applyControlState({ enabled: state.enabled, gainDb: state.gainDb, blastGuard: state.blastGuard });
  return state;
}

/**
 * @param {string} text
 */
function reportWriteError(text) {
  renderStatus({ indicator: 'red', text });
}

void init();

toggle.addEventListener('change', () => {
  void toggleSite();
});

blastGuardToggle.addEventListener('change', () => {
  void saveBlastGuard(Boolean(blastGuardToggle.checked));
});

gainSlider.addEventListener('input', () => {
  if (gainSlider.disabled) return;
  const gainDb = popupShared.clampGainDb(gainSlider.value);
  gainSlider.value = String(gainDb);
  renderGain(gainDb);
  // Immediate dispatch: no debounce queue, no `unload` flush, no popup-side
  // chain. RESEARCH §6: the popup document is unloaded on close with no
  // documented flush facility, so any queued-but-unwritten value would be
  // lost. Each input sends its own field-level intent at once; the
  // background applies it on arrival (last-accepted-write-wins) and returns
  // the stored truth, which the popup renders.
  void saveGainInner(gainDb);
});

gainSlider.addEventListener('pointerdown', () => {
  void requestSliderSoftWake();
});

resetBtnEl.addEventListener('click', () => {
  if (gainSlider.disabled) return;
  gainSlider.value = '0';
  blastGuardToggle.checked = false;
  renderGain(0);
  // Reset is ONE logical update — gain 0 + Blast Guard off in a SINGLE
  // field-level intent and a SINGLE per-site storage write. Two separate
  // writes would leave a crash/close window between them.
  void saveResetInner();
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
      hostnameEl.textContent = 'Unsupported';
      disableAll('Not available on this page.');
      return;
    }

    tabId = tab.id ?? null;
    hostname = popupShared.extractHostname(tab.url);
    siteKey = popupShared.getSiteKey(hostname);
    if (!hostname) {
      hostnameEl.textContent = 'Unsupported';
      disableAll('Not available on this page.');
      return;
    }

    if (!/^https?:\/\//i.test(tab.url)) {
      hostnameEl.textContent = 'Unsupported';
      disableAll('Not available on this page.');
      return;
    }

    hostnameEl.textContent = hostname;

    const state = await chrome.runtime.sendMessage({ type: 'GET_SITE_STATE', hostname: siteKey });

    // Authority first: the stored per-site record is the truth.
    toggle.checked = state ? Boolean(state.enabled) : false;
    gainSlider.value = String(popupShared.clampGainDb(state?.gainDb));
    blastGuardToggle.checked = Boolean(state?.blastGuard);
    renderGain(gainSlider.value);
    toggle.disabled = false;
    syncGainControlState();
    syncBlastGuardControlState();
    syncPresetControlState();

    if (toggle.checked) {
      await refreshDocumentStatus();
    } else {
      renderStatus({ indicator: 'gray', text: 'Off for this site.' });
    }

    setInterval(() => {
      void refreshDocumentStatus();
    }, 750);
  } catch {
    hostnameEl.textContent = 'Unsupported';
    disableAll('Extension status unavailable.');
  }
}

function disableAll(statusText) {
  toggle.disabled = true;
  blastGuardToggle.disabled = true;
  gainSlider.disabled = true;
  syncPresetControlState();
  renderStatus({ indicator: 'gray', text: statusText });
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
  }

  toggle.disabled = true;
  syncGainControlState();
  syncBlastGuardControlState();

  const wanted = toggle.checked;
  try {
    // Field-level intent: ONLY the toggled field. Never send gainDb /
    // Blast Guard from a cache — a concurrent sibling popup may have
    // changed them newer, and a snapshot would revert them. Dispatched
    // immediately with no popup-side chain; the background applies on
    // arrival (last-accepted-write-wins) and returns the stored truth.
    const res = await chrome.runtime.sendMessage({
      type: 'SET_SITE_STATE',
      siteKey,
      tabId,
      set: { enabled: wanted },
    });
    requireStoredTruth(res);
    // Render what the background returned, never what was sent.
    applyControlState({ enabled: res.enabled, gainDb: res.gainDb, blastGuard: res.blastGuard });

    if (res.enabled) {
      runtimeActivationState = 'pending';
      runtimeActivationMessage = 'Enabling on this tab…';
      renderStatus({ indicator: 'gray', text: runtimeActivationMessage });
    } else {
      // Immediate apply for the current tab's TOP FRAME ONLY (frameId 0:
      // RESEARCH §5.3). The named siteKey keeps every other frame from
      // acting on this as defence in depth.
      if (tabId) {
        await chrome.tabs.sendMessage(tabId, {
          type: 'SET_DOCUMENT_STATE',
          siteKey,
          enabled: false,
        }, { frameId: 0 }).catch(() => {});
      }
    }
    await refreshDocumentStatus();
  } catch {
    // A failed write must not look like a success: revert the control to
    // the stored truth and surface it on the existing status line. If the
    // recovery read itself failed, the state is UNKNOWN — never claim a
    // revert that never happened.
    let reverted = false;
    try {
      await revertToStoredTruth();
      reverted = true;
    } catch {}
    await refreshDocumentStatus();
    reportWriteError(reverted ? 'Could not save. Reverted.' : 'Could not save. State unknown — reopen the popup and try again.');
  } finally {
    toggle.disabled = false;
    syncGainControlState();
    syncBlastGuardControlState();
    syncPresetControlState();
  }
}



async function saveGainInner(gainDb) {
  if (!toggle.checked) return;
  const wantedGain = popupShared.clampGainDb(gainDb);
  try {
    // Field-level intent: ONLY gainDb. Never send enabled / Blast Guard
    // from this popup's cache — a sibling popup may own newer values.
    // The background applies on arrival and returns the stored truth.
    const res = await chrome.runtime.sendMessage({
      type: 'SET_SITE_STATE',
      siteKey,
      tabId,
      set: { gainDb: wantedGain },
    });
    requireStoredTruth(res);
    // Render the returned truth, never the sent value.
    const nextGain = popupShared.clampGainDb(res.gainDb);
    gainSlider.value = String(nextGain);
    renderGain(nextGain);
    if (tabId) {
      await chrome.tabs.sendMessage(tabId, {
        type: 'SET_DOCUMENT_STATE',
        siteKey,
        enabled: toggle.checked,
        gainDb: nextGain,
      }, { frameId: 0 }).catch(() => {});
    }
  } catch {
    let reverted = false;
    try {
      await revertToStoredTruth();
      reverted = true;
    } catch {}
    reportWriteError(reverted ? 'Could not save gain. Reverted.' : 'Could not save gain. State unknown — reopen the popup and try again.');
  }
}

async function saveBlastGuard(blastGuard) {
  if (!toggle.checked || blastGuardToggle.disabled) return;
  return saveBlastGuardInner(blastGuard);
}

async function saveBlastGuardInner(blastGuard) {
  if (!toggle.checked || blastGuardToggle.disabled) return;
  const previous = blastGuardToggle.checked;
  try {
    // Field-level intent: ONLY blastGuard. Render the returned truth.
    const res = await chrome.runtime.sendMessage({
      type: 'SET_SITE_STATE',
      siteKey,
      tabId,
      set: { blastGuard },
    });
    requireStoredTruth(res);
    blastGuardToggle.checked = Boolean(res.blastGuard);
    if (tabId) {
      const gainDb = popupShared.clampGainDb(gainSlider.value);
      await chrome.tabs.sendMessage(tabId, {
        type: 'SET_DOCUMENT_STATE',
        siteKey,
        enabled: toggle.checked,
        gainDb,
        blastGuard: Boolean(res.blastGuard),
      }, { frameId: 0 }).catch(() => {});
    }
  } catch {
    blastGuardToggle.checked = previous;
    let reverted = false;
    try {
      await revertToStoredTruth();
      reverted = true;
    } catch {}
    reportWriteError(reverted ? 'Could not save Blast Guard. Reverted.' : 'Could not save Blast Guard. State unknown — reopen the popup and try again.');
  }
}

/**
 * Reset both gain and Blast Guard in ONE message / ONE storage write.
 * Field-level: ONLY the two fields the reset touches — never `enabled`.
 * The two fields apply together and the popup renders the returned truth,
 * never the sent 0/false.
 */
async function saveResetInner() {
  if (!toggle.checked) return;
  try {
    const res = await chrome.runtime.sendMessage({
      type: 'SET_SITE_STATE',
      siteKey,
      tabId,
      set: { gainDb: 0, blastGuard: false },
    });
    requireStoredTruth(res);
    // Render the returned truth, never the sent values: if the background
    // stored something else, acknowledging 0/false would claim a change
    // that never happened.
    const nextGain = popupShared.clampGainDb(res.gainDb);
    const nextGuard = Boolean(res.blastGuard);
    gainSlider.value = String(nextGain);
    blastGuardToggle.checked = nextGuard;
    renderGain(nextGain);
    if (tabId) {
      await chrome.tabs.sendMessage(tabId, {
        type: 'SET_DOCUMENT_STATE',
        siteKey,
        enabled: toggle.checked,
        gainDb: nextGain,
        blastGuard: nextGuard,
      }, { frameId: 0 }).catch(() => {});
    }
  } catch {
    let reverted = false;
    try {
      await revertToStoredTruth();
      reverted = true;
    } catch {}
    reportWriteError(reverted ? 'Could not save. Reverted.' : 'Could not save. State unknown — reopen the popup and try again.');
  }
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

  const nextGain = popupShared.clampGainDb(gainDb);
  gainSlider.value = String(nextGain);
  renderGain(nextGain);
  // Immediate persist (no debounce, no chain): the preset click IS the
  // user's change event and dispatches its own field-level intent at once.
  void saveGainInner(nextGain);
}

async function refreshDocumentStatus() {
  const requestToken = ++statusRequestToken;

  if (!toggle.checked && runtimeActivationState !== 'pending' && runtimeActivationState !== 'active') {
    renderStatus({ indicator: 'gray', text: 'Off for this site.' });
    return;
  }

  const fallbackIndicator = popupShared.getPopupIndicator({
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
    // Defect 1: target the TOP FRAME ONLY. Without frameId the message fires
    // in every frame (RESEARCH §5.1) and the sender gets one arbitrary answer
    // (RESEARCH §5.2: "one of answers"), so an embedded cross-origin iframe's
    // state could overwrite the selected site's controls. frameId 0 is the
    // documented main-frame id (RESEARCH §5.3) and needs no new permission.
    const doc = await chrome.tabs.sendMessage(tabId, { type: 'GET_DOCUMENT_STATUS' }, { frameId: 0 });
    if (requestToken !== statusRequestToken) return;
    // Defence in depth: the content script names its siteKey; a reply that
    // does not name THIS site (a non-top frame's answer, a stale tab) must
    // never overwrite the popup's controls.
    const docSite = typeof doc?.siteKey === 'string' ? popupShared.getSiteKey(doc.siteKey) : '';
    if (!docSite || docSite !== siteKey) return;
    const enabled = Boolean(doc?.enabled);
    const hookAlive = Boolean(doc?.hookAlive);
    const hookActive = Boolean(doc?.hookActive);
    const activating = Boolean(doc?.activating);
    const lastError = String(doc?.lastError || '');

    applyControlState({
      enabled,
      gainDb: doc?.gainDb,
      blastGuard: doc?.blastGuard,
    });

    if (hookActive) {
      hookWasActiveAt = Date.now();
      lastHookActive = true;
    }

    const recentlyActive = hookActive || (lastHookActive && enabled && hookAlive && (Date.now() - hookWasActiveAt) < ACTIVE_STALE_MS);

    const nextIndicator = popupShared.getPopupIndicator({
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
  const numeric = popupShared.clampGainDb(gainDb);
  const prefix = numeric > 0 ? '+' : '';
  gainValueEl.textContent = `${prefix}${numeric.toFixed(1)} dB`;
}

function applyControlState({ enabled, gainDb, blastGuard }) {
  toggle.checked = Boolean(enabled);
  gainSlider.value = String(popupShared.clampGainDb(gainDb));
  blastGuardToggle.checked = Boolean(blastGuard);
  renderGain(gainSlider.value);
  syncGainControlState();
  syncBlastGuardControlState();
  syncPresetControlState();
}

function syncGainControlState() {
  gainSlider.disabled = toggle.disabled || !toggle.checked;
}

function syncBlastGuardControlState() {
  blastGuardToggle.disabled = toggle.disabled || !toggle.checked;
}

function syncPresetControlState() {
  const disabled = toggle.disabled || !toggle.checked;
  for (const button of presetButtons) {
    button.disabled = disabled;
  }
}

// No `unload` handler by design (defect 3): every user change is persisted
// immediately on its `change`/`input` event, so there is never pending work
// for teardown to flush. RESEARCH §6 documents no flush-on-teardown facility
// and warns async teardown work is not guaranteed to complete.
