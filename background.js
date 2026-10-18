importScripts('shared.js');

const backgroundShared = self.TabNormalizerShared;

const INJECTABLE_FILES = ['shared.js', 'content-script.js'];
const SUPPORTED_PROTOCOL_PATTERN = /^https?:$/i;
const RESTRICTED_URL_PATTERN = /^(chrome|chrome-extension|devtools|edge|about):/i;
const WEBSTORE_URL_PATTERN = /^https?:\/\/(chrome\.google\.com\/webstore|microsoftedge\.microsoft\.com\/addons)\b/i;
const pendingSessionStates = new Map();

// Per-site single-key storage: each site lives under ONE top-level key
// `site:<siteKey>` holding { enabled, gainDb, blastGuard, seq, mirror }.
// Platform fact (RESEARCH §2.1): `chrome.storage.local.set` guarantees only
// that "Any other key/value pairs in storage will not be affected" —
// top-level-key granularity. A write to `site:a.com` therefore cannot touch
// `site:b.com` by construction, unlike the old whole-map `siteSettings`
// read-modify-write where two contexts could clobber each other's sites.
// A single `set` carries the whole per-site record, so settings / mirror /
// sequence can never diverge across separate writes (defect 4) — there is no
// second write to crash between. This beats serialising (an in-memory queue):
// the queue is lost on service-worker restart (RESEARCH §1: "Any global
// variables you set will be lost"), spans no context but its own, and cannot
// help a popup direct-write racing the worker; per-site keys survive restart
// (disk) and work across contexts via the documented granularity.
// The queue below is kept only as best-effort same-worker serialisation for
// same-site concurrent handlers; cross-site safety and single-write
// divergence-freedom hold without it.
/** @type {Promise<unknown>} */
let storageWriteChain = Promise.resolve();
/**
 * @template T
 * @param {() => Promise<T>} task
 * @returns {Promise<T>}
 */
function withStorageWrite(task) {
  const run = storageWriteChain.then(task, task);
  storageWriteChain = run.catch(() => {});
  return run;
}

// Background is the ONLY owner of persisted state and the ONLY writer.
// The popup sends field-level intents (`{ siteKey, set: { gainDb } }` —
// only the field the user just changed). The background applies the
// intent's fields to the live record and writes the whole record back in
// one `set` (a partial `set` is a delete — see RESEARCH §10). Top-level
// `enabled`/`gainDb`/`blastGuard` on the message are legacy and are IGNORED
// when `set` is present; when `set` is absent they are treated as the intent
// for backward compatibility only.
// Ordering is last-accepted-write-wins: every accepted write bumps the
// per-site `seq` INSIDE the same single-key value (`seq = stored.seq + 1`)
// and returns it to the popup. `seq` is audit and observability only —
// never an acceptance gate. Nothing is ever rejected on ordering grounds.
// Accepted trade (deliberate): if two popups race the same field and one
// message is delayed past a newer one, the later *arrival* wins rather than
// the later *action*; there is no clock-free way to distinguish those, the
// window is milliseconds between two simultaneously-open popups, and the
// alternative (wall-clock per-field maxima) locked a field out until the
// wall clock caught up — potentially for years after a mistakenly
// future-dated write — with no restart helping because the maxima persisted.
// Do not reintroduce wall-clock comparison against stored maxima.
// Legacy `siteSeq` is read once to keep the audit counter monotonic across
// migration and never written; the per-site key's existence replaces any marker.
const SITE_SEQ_KEY = 'siteSeq';

/**
 * Read the stored per-site record, preferring the per-site key. Falls back
 * to legacy maps (`siteSettings` / `activeSites` / `siteToggles`) once and
 * migrates them in memory; the caller persists the migrated record with a
 * single per-site `set`. Never drops a stored setting: legacy values seed
 * the record, with an explicit `siteToggles` boolean winning `enabled` once
 * (the pre-fix historical diverge repair). Afterwards the per-site key
 * exists and is preferred, so a stale legacy mirror can never resurrect.
 * @param {string} siteKey normalized site key
 * @returns {Promise<{ record: { enabled: boolean, gainDb: number, blastGuard: boolean, seq: number, mirror: boolean }, fromLegacy: boolean }>}
 */
async function readSiteRecord(siteKey) {
  const perKey = backgroundShared.siteStorageKey(siteKey);
  // Platform fact (measured Step 1 repro): an object-form key whose default
  // is `undefined` is dropped by the extension API's JSON marshal, so
  // `get({ [perKey]: undefined })` returns `{}` even when the key exists.
  // The array form is proven to return the value; missing keys are simply
  // absent and the `|| {}` fallbacks below preserve the old defaults.
  const stored = await chrome.storage.local.get([
    perKey,
    'activeSites',
    'siteSettings',
    'siteToggles',
    SITE_SEQ_KEY,
  ]);
  const existing = stored[perKey];
  if (existing && typeof existing === 'object') {
    return { record: backgroundShared.normalizeSiteRecord(existing), fromLegacy: false };
  }
  const migrated = backgroundShared.migrateLegacyToRecord(
    /** @type {Record<string, unknown>} */ (stored.siteSettings || {}),
    /** @type {Record<string, unknown>} */ (stored.activeSites || {}),
    /** @type {Record<string, unknown>} */ (stored.siteToggles || {}),
    siteKey,
  );
  if (migrated) {
    // Keep the audit counter monotonic across migration: adopt a persisted
    // legacy sequence maximum when present. `seq` is audit-only, never a
    // gate — this changes nothing about acceptance.
    const legacySeq = /** @type {Record<string, unknown>} */ (stored[SITE_SEQ_KEY] || {});
    const seqNum = Number(legacySeq[siteKey]);
    if (Number.isFinite(seqNum) && seqNum > migrated.seq) {
      migrated.seq = Math.floor(seqNum);
    }
    return { record: migrated, fromLegacy: true };
  }
  return {
    record: backgroundShared.normalizeSiteRecord({ enabled: false, seq: 0, mirror: false }),
    fromLegacy: false,
  };
}

/**
 * Persist one per-site record with a SINGLE `set` carrying a SINGLE
 * top-level key. No other key is touched.
 * @param {string} siteKey normalized site key
 * @param {{ enabled: boolean, gainDb: number, blastGuard: boolean, seq: number, mirror: boolean }} record
 */
async function writeSiteRecord(siteKey, record) {
  const perKey = backgroundShared.siteStorageKey(siteKey);
  await chrome.storage.local.set({
    [perKey]: backgroundShared.normalizeSiteRecord(record),
  });
}

/**
 * Extract the field-level intent from a SET_SITE_STATE message. New callers
 * send `set` with ONLY the changed fields (e.g. `{ gainDb: 6 }`). When `set`
 * is present, top-level `enabled`/`gainDb`/`blastGuard` are IGNORED — they
 * are a cached snapshot that would let a sibling popup overwrite unrelated
 * newer fields. When `set` is absent, fall back to top-level fields for
 * backward compatibility with older callers/tests.
 * @param {Record<string, unknown>} message
 */
function extractIntentSet(message) {
  const rawSet = /** @type {unknown} */ (message.set);
  if (rawSet && typeof rawSet === 'object') {
    const src = /** @type {Record<string, unknown>} */ (rawSet);
    /** @type {Record<string, unknown>} */
    const out = {};
    if (Object.prototype.hasOwnProperty.call(src, 'enabled')) out.enabled = Boolean(src.enabled);
    if (Object.prototype.hasOwnProperty.call(src, 'gainDb')) out.gainDb = backgroundShared.clampGainDb(src.gainDb);
    if (Object.prototype.hasOwnProperty.call(src, 'blastGuard')) out.blastGuard = Boolean(src.blastGuard);
    return out;
  }
  /** @type {Record<string, unknown>} */
  const legacy = {};
  if (Object.prototype.hasOwnProperty.call(message, 'enabled')) legacy.enabled = Boolean(message.enabled);
  if (Object.prototype.hasOwnProperty.call(message, 'gainDb')) legacy.gainDb = backgroundShared.clampGainDb(message.gainDb);
  if (Object.prototype.hasOwnProperty.call(message, 'blastGuard')) legacy.blastGuard = Boolean(message.blastGuard);
  return legacy;
}

/**
 * Migrate legacy `activeSites` enables into per-site keys, clearing ONLY
 * the entries actually consumed. An entry whose canonical site already has
 * a per-site record is left untouched (not consumed): clearing it would be
 * data loss with no migration to back it up. Safe across crashes: reads
 * prefer per-site keys, so a crash between the per-site writes and the
 * partial clear leaves duplicates that the per-site key still outranks.
 */
async function migrateActiveSitesOnce() {
  return withStorageWrite(async () => {
    const stored = await chrome.storage.local.get({ activeSites: {}, siteSettings: {}, siteToggles: {}, siteSeq: {} });
    const activeSites = /** @type {Record<string, unknown>} */ (stored.activeSites || {});
    const activeKeys = Object.keys(activeSites).filter((k) => Boolean(activeSites[k]));
    if (activeKeys.length === 0) return { changed: false };
    /** @type {string[]} */
    const consumed = [];
    for (const rawKey of activeKeys) {
      const siteKey = backgroundShared.getSiteKey(rawKey);
      if (!siteKey) continue;
      const perKey = backgroundShared.siteStorageKey(siteKey);
      const existing = await chrome.storage.local.get([perKey]);
      const migrated = backgroundShared.migrateLegacyToRecord(
        /** @type {Record<string, unknown>} */ (stored.siteSettings || {}),
        /** @type {Record<string, unknown>} */ (stored.activeSites || {}),
        /** @type {Record<string, unknown>} */ (stored.siteToggles || {}),
        siteKey,
      );
      if (existing[perKey] && typeof existing[perKey] === 'object') {
        // Per-site already exists: only clear when it already reflects this
        // legacy entry (same enabled/gain/guard) — i.e. the legacy was
        // consumed by an earlier migration (e.g. GET_SITE_STATE). Otherwise
        // leave it: clearing un-consumed data is data loss.
        if (!migrated) continue;
        const cur = backgroundShared.normalizeSiteRecord(existing[perKey]);
        if (cur.enabled !== migrated.enabled
          || cur.gainDb !== migrated.gainDb
          || cur.blastGuard !== migrated.blastGuard) continue;
        consumed.push(rawKey);
        continue;
      }
      if (migrated) {
        // Same legacy-sequence preservation as the ordinary read path
        // (readSiteRecord): adopt a persisted legacy sequence maximum so the
        // audit counter stays monotonic across migration. `seq` is audit-only.
        const legacySeq = /** @type {Record<string, unknown>} */ (stored.siteSeq || {});
        const seqNum = Number(legacySeq[siteKey]);
        if (Number.isFinite(seqNum) && seqNum > migrated.seq) {
          migrated.seq = Math.floor(seqNum);
        }
        await chrome.storage.local.set({ [perKey]: migrated });
        consumed.push(rawKey);
      }
    }
    if (consumed.length === 0) return { changed: false };
    // Remove ONLY consumed raw keys; any un-consumed entry survives.
    const nextActives = { ...activeSites };
    for (const k of consumed) delete nextActives[k];
    await chrome.storage.local.set({ activeSites: nextActives });
    return { changed: true };
  });
}

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

  return backgroundShared.getSiteKey(backgroundShared.extractHostname(tab.url));
}

async function hasInjectedContentScript(tabId) {
  try {
    // Target the top frame only (frameId 0: RESEARCH §5.3). Without frameId
    // every frame answers and the sender gets one arbitrary answer.
    const response = await chrome.tabs.sendMessage(tabId, { type: 'GET_DOCUMENT_STATUS' }, { frameId: 0 });
    return Boolean(response?.ok);
  } catch {
    return false;
  }
}

async function injectMainWorldScript(tabId, file) {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: [file],
    world: 'MAIN',
  });
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
      siteKey: entry.siteKey,
      enabled: Boolean(entry.enabled),
      gainDb: entry.gainDb,
      blastGuard: Boolean(entry.blastGuard),
      // Genuine transient: the tab installs a session override for this and
      // only this flagged shape. Ordinary persisted saves arrive unflagged and
      // read storage instead.
      transient: true,
    }, { frameId: 0 });
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
    return await chrome.tabs.sendMessage(tabId, { type: 'SOFT_RECHECK_DOCUMENT' }, { frameId: 0 });
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

        const siteKey = backgroundShared.getSiteKey(hostname);
        // Single owner: flip the live record, bump the audit counter inside
        // the same write. Last-accepted-write-wins: nothing is rejected on
        // ordering grounds; a delayed toggle that arrives later flips whatever
        // is live at arrival time (documented trade).
        /** @type {{ seq: number, nextEnabled: boolean, gainDb: number, blastGuard: boolean }} */
        const outcome = await withStorageWrite(async () => {
          const { record: storedRec } = await readSiteRecord(siteKey);
          const nextEnabled = !storedRec.enabled;
          const nextSeq = storedRec.seq + 1;
          const next = backgroundShared.normalizeSiteRecord({
            enabled: nextEnabled,
            gainDb: storedRec.gainDb,
            blastGuard: storedRec.blastGuard,
            seq: nextSeq,
            mirror: nextEnabled,
          });
          // Single top-level key, single set: settings + mirror + sequence
          // can never diverge.
          await writeSiteRecord(siteKey, next);
          return { seq: nextSeq, nextEnabled, gainDb: next.gainDb, blastGuard: next.blastGuard };
        });
        if (outcome.nextEnabled) {
          await syncExistingTabsForSite(siteKey);
        }
        console.log('[bg] stored toggle:', siteKey, outcome.nextEnabled);
        return {
          ok: true,
          enabled: outcome.nextEnabled,
          gainDb: outcome.gainDb,
          blastGuard: outcome.blastGuard,
          siteKey,
          seq: outcome.seq,
        };
      }
      case 'SET_SITE_STATE': {
        const hostname = String(message.hostname || message.siteKey || '');
        if (!hostname) throw new Error('Missing hostname.');

        const siteKey = backgroundShared.getSiteKey(hostname);
        const persist = message.persist !== false;
        // Field-level intent only: `set` carries ONLY the changed fields.
        // Top-level snapshot fields are ignored when `set` is present, so a
        // sibling popup can never overwrite an unrelated newer field.
        const intent = extractIntentSet(/** @type {Record<string, unknown>} */ (message));

        /** @type {{ seq: number, enabled: boolean, gainDb: number, blastGuard: boolean, enabledApplied: boolean }} */
        const applied = await withStorageWrite(async () => {
          const { record: storedRec } = await readSiteRecord(siteKey);
          // Last-accepted-write-wins: every intent field applies to the live
          // record together or not at all — there is no per-field staleness
          // and no partial apply. Fields absent from the intent keep stored
          // values. Any legacy `at`/`actionAt` stamp on the message is
          // ignored (never compared, never persisted).
          let enabled = storedRec.enabled;
          let gainDb = storedRec.gainDb;
          let blastGuard = storedRec.blastGuard;
          let enabledApplied = false;
          if (Object.prototype.hasOwnProperty.call(intent, 'enabled')) {
            enabled = Boolean(intent.enabled);
            enabledApplied = true;
          }
          if (Object.prototype.hasOwnProperty.call(intent, 'gainDb')) gainDb = backgroundShared.clampGainDb(intent.gainDb);
          if (Object.prototype.hasOwnProperty.call(intent, 'blastGuard')) blastGuard = Boolean(intent.blastGuard);
          const requestedEnabledChange = Object.prototype.hasOwnProperty.call(intent, 'enabled');
          const nextSeq = storedRec.seq + 1;
          const next = backgroundShared.normalizeSiteRecord({
            enabled,
            gainDb,
            blastGuard,
            seq: nextSeq,
            // The mirror follows `enabled` in the SAME per-site write; a
            // gain/blast-guard-only patch leaves it untouched.
            mirror: requestedEnabledChange ? enabled : storedRec.mirror,
          });

          if (persist) {
            // ONE top-level key, ONE set: the whole logical update lands
            // together or not at all. No crash window between settings,
            // mirror and sequence. Legacy maps are left untouched here;
            // reads prefer the per-site key, so stale legacy can never
            // resurrect (migrated lazily, `activeSites` cleared on startup
            // only for consumed entries).
            await writeSiteRecord(siteKey, next);
            await setPendingSessionState(message.tabId, null);
          }
          return { seq: persist ? nextSeq : storedRec.seq, enabled: next.enabled, gainDb: next.gainDb, blastGuard: next.blastGuard, enabledApplied };
        });

        const shouldActivateCurrentTab = applied.enabledApplied && applied.enabled;
        const activation = shouldActivateCurrentTab
          ? await prepareCurrentTabActivation(message.tabId, siteKey)
          : { state: 'idle' };
        if (!persist && message.tabId) {
          await setPendingSessionState(
            message.tabId,
            {
              siteKey,
              enabled: applied.enabled,
              gainDb: applied.gainDb,
              blastGuard: applied.blastGuard,
            },
          );
        }
        if (shouldActivateCurrentTab && persist) {
          await syncExistingTabsForSite(siteKey);
        }
        console.log('[bg]', persist ? 'stored:' : 'transient:', siteKey, JSON.stringify(applied));
        return {
          ok: true,
          enabled: applied.enabled,
          gainDb: applied.gainDb,
          blastGuard: applied.blastGuard,
          siteKey,
          seq: applied.seq,
          activation,
        };
      }
      case 'GET_SITE_STATE': {
        const hostname = String(message.hostname || message.siteKey || '');
        if (!hostname) return { ok: true, enabled: false, gainDb: 0, blastGuard: false };
        const siteKey = backgroundShared.getSiteKey(hostname);

        const reconciled = await withStorageWrite(async () => {
          const { record, fromLegacy } = await readSiteRecord(siteKey);
          if (fromLegacy) {
            // Persist the migrated per-site record once so later reads hit
            // it directly; legacy is left for the startup clear and can never
            // override the per-site key afterwards.
            await writeSiteRecord(siteKey, record);
          }
          return record;
        });
        return {
          ok: true,
          enabled: reconciled.enabled,
          gainDb: reconciled.gainDb,
          blastGuard: reconciled.blastGuard,
          siteKey,
          seq: reconciled.seq,
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
  // Finding 3: a rejected migration write must not abort re-injection. The
  // migration is isolated in its own try/catch that reports and continues;
  // the injection union below always runs, and its own failures are reported
  // per-site rather than aborting siblings.
  try {
    await migrateActiveSitesOnce();
  } catch (e) {
    console.warn('[bg] startup migration failed, continuing to re-inject:', String(e));
  }
  try {
    // Re-inject enabled sites: UNION of per-site truth and every legacy
    // shape. A legacy-enabled site is covered even when unrelated per-site
    // keys already exist (the old `if (enabledKeys.size === 0)` gate dropped
    // legacy sites as soon as any per-site key existed). Per-site outranks
    // legacy for the SAME site (readSiteRecord prefers it), so a disabled
    // per-site is never re-enabled by stale legacy — but a legacy-only site
    // is still injected.
    /** @type {Record<string, unknown>} */
    let all = {};
    try {
      all = await chrome.storage.local.get(null);
    } catch {
      all = await chrome.storage.local.get({ activeSites: {}, siteSettings: {}, siteToggles: {} });
    }
    const enabledKeys = new Set();
    for (const [key, value] of Object.entries(all || {})) {
      if (backgroundShared.isSiteStorageKey(key) && value && typeof value === 'object') {
        const rec = backgroundShared.normalizeSiteRecord(value);
        if (rec.enabled) enabledKeys.add(backgroundShared.siteKeyFromStorageKey(key));
      }
    }
    // Legacy union: normalise every legacy raw key, evaluate its effective
    // config (toggles win for enabled), add when enabled — regardless of
    // whether per-site keys exist for other sites.
    {
      const siteSettings = /** @type {Record<string, unknown>} */ (all.siteSettings || {});
      const activeSites = /** @type {Record<string, unknown>} */ (all.activeSites || {});
      const siteToggles = /** @type {Record<string, unknown>} */ (all.siteToggles || {});
      /** @type {Set<string>} */
      const candidates = new Set();
      for (const raw of Object.keys(siteSettings)) {
        const k = backgroundShared.getSiteKey(raw);
        if (k) candidates.add(k);
      }
      for (const [raw, v] of Object.entries(activeSites)) {
        if (!Boolean(v)) continue;
        const k = backgroundShared.getSiteKey(raw);
        if (k) candidates.add(k);
      }
      for (const [raw, v] of Object.entries(siteToggles)) {
        if (typeof v !== 'boolean') continue;
        const k = backgroundShared.getSiteKey(raw);
        if (k) candidates.add(k);
      }
      for (const candidate of candidates) {
        if (enabledKeys.has(candidate)) continue;
        // Per-site outranks legacy for the same site: skip legacy when a
        // per-site record already decides this site.
        const perKey = backgroundShared.siteStorageKey(candidate);
        if (perKey && all[perKey] && typeof all[perKey] === 'object') continue;
        const rec = backgroundShared.migrateLegacyToRecord(siteSettings, activeSites, siteToggles, candidate);
        if (rec && rec.enabled) enabledKeys.add(candidate);
      }
    }
    for (const key of enabledKeys) {
      try {
        await syncExistingTabsForSite(key);
      } catch (e) {
        console.warn('[bg] startup re-injection failed for', key, ':', String(e));
      }
    }
  } catch (e) {
    console.warn('[bg] startup re-injection failed:', String(e));
  }
});

// Single storage listener: preserves the legacy `siteToggles` broadcast
// contract AND carries the per-site broadcast. Reads prefer the per-site key,
// so a delayed legacy mirror write that disagrees with the per-site record
// is stale and never broadcast as truth.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  // Legacy path (preserved): a `siteToggles` change nudges matching tabs,
  // but only when it agrees with the per-site/legacy stored truth.
  if (changes.siteToggles) {
    const newToggles = changes.siteToggles.newValue || {};
    const oldToggles = changes.siteToggles.oldValue || {};
    for (const siteKey of Object.keys(newToggles)) {
      if (newToggles[siteKey] !== oldToggles[siteKey]) {
        chrome.tabs.query({}, (tabs) => {
          void (async () => {
            const { record } = await readSiteRecord(backgroundShared.getSiteKey(siteKey) || siteKey);
            if (record.enabled !== Boolean(newToggles[siteKey])) return;
            tabs.forEach(tab => {
              if (tab.url && tab.id && backgroundShared.getSiteKey(backgroundShared.extractHostname(tab.url)) === siteKey) {
                chrome.tabs.sendMessage(tab.id, {
                  type: 'TOGGLE_CHANGED',
                  siteKey,
                  enabled: newToggles[siteKey],
                  gainDb: record.gainDb,
                  blastGuard: record.blastGuard,
                }, { frameId: 0 }).catch(() => {});
              }
            });
          })();
        });
      }
    }
  }
  // Per-site path: a `site:<key>` change broadcasts to the top frame only.
  // A delayed `enabled:false` change must not overwrite a newer activation.
  // The `newRec` captured from the change record may already be stale by the
  // time the async `tabs.query` returns, so re-read the stored truth and
  // broadcast that; fail closed (no broadcast) when the re-read fails.
  for (const [key, change] of Object.entries(changes)) {
    if (!backgroundShared.isSiteStorageKey(key)) continue;
    const siteKey = backgroundShared.siteKeyFromStorageKey(key);
    if (!siteKey) continue;
    const oldRec = change.oldValue && typeof change.oldValue === 'object'
      ? backgroundShared.normalizeSiteRecord(change.oldValue)
      : null;
    const newRec = change.newValue && typeof change.newValue === 'object'
      ? backgroundShared.normalizeSiteRecord(change.newValue)
      : null;
    if (!newRec) continue;
    if (oldRec && oldRec.enabled === newRec.enabled
      && oldRec.gainDb === newRec.gainDb
      && oldRec.blastGuard === newRec.blastGuard) continue;
    chrome.tabs.query({}, (tabs) => {
      void (async () => {
        let current;
        try {
          const { record } = await readSiteRecord(siteKey);
          // Stale broadcast: stored truth moved on (e.g. re-enabled after
          // this disable change). Send the current truth. Fail closed: when
          // the re-read itself fails the truth is unknown, so send nothing
          // rather than a possibly stale captured change.
          current = record;
        } catch {
          // Fail closed on a read failure: no broadcast without truth.
          return;
        }
        tabs.forEach(tab => {
          if (tab.url && tab.id && backgroundShared.getSiteKey(backgroundShared.extractHostname(tab.url)) === siteKey) {
            chrome.tabs.sendMessage(tab.id, {
              type: 'TOGGLE_CHANGED',
              siteKey,
              enabled: current.enabled,
              gainDb: current.gainDb,
              blastGuard: current.blastGuard,
            }, { frameId: 0 }).catch(() => {});
          }
        });
      })();
    });
  }
});
