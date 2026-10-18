(function (root, factory) {
  const api = factory();

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }

  /** @type {Record<string, unknown>} */ (root).TabNormalizerShared = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const DEFAULT_GAIN_DB = 0;
  const DEFAULT_BLAST_GUARD = false;
  const MIN_GAIN_DB = -12;
  const MAX_GAIN_DB = 12;
  const GAIN_STEP_DB = 0.5;

  function extractHostname(url) {
    try {
      return new URL(url).hostname;
    } catch {
      return '';
    }
  }

  function getSiteKey(hostname) {
    let normalized = String(hostname || '').trim().toLowerCase().replace(/\.+$/, '');
    if (!normalized) return '';

    const bracketedIpv6 = normalized.match(/^\[(.+)\](?::\d+)?$/);
    if (bracketedIpv6) {
      normalized = bracketedIpv6[1];
    } else if (/^[^:]+:\d+$/.test(normalized)) {
      normalized = normalized.replace(/:\d+$/, '');
    }

    if (normalized === 'localhost' || /^[\d.:]+$/.test(normalized)) {
      return normalized;
    }

    const parts = normalized.split('.').filter(Boolean);
    if (parts.length <= 2) {
      return normalized;
    }

    const suffix = parts.slice(-2).join('.');
    if (suffix === 'co.uk' || suffix === 'co.jp' || suffix === 'com.au' || suffix === 'com.br' || suffix === 'com.mx' || suffix === 'com.tr' || suffix === 'net.au' || suffix === 'org.au' || suffix === 'org.uk' || suffix === 'ac.uk') {
      if (parts.length >= 3) {
        return parts.slice(-3).join('.');
      }
    }

    return parts.slice(-2).join('.');
  }

  function getLegacySiteKey(hostname) {
    return getSiteKey(hostname);
  }

  function migrateActiveSites(activeSites) {
    const next = {};

    for (const [rawKey, enabled] of Object.entries(activeSites || {})) {
      if (!enabled) continue;

      const siteKey = getLegacySiteKey(rawKey);
      if (!siteKey) continue;
      next[siteKey] = true;
    }

    return next;
  }

  function clampGainDb(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return DEFAULT_GAIN_DB;
    return Math.max(MIN_GAIN_DB, Math.min(MAX_GAIN_DB, Math.round(numeric / GAIN_STEP_DB) * GAIN_STEP_DB));
  }

  function normalizeSiteSettings(value) {
    if (value === true) {
      return { enabled: true, gainDb: DEFAULT_GAIN_DB, blastGuard: DEFAULT_BLAST_GUARD };
    }

    const raw = value && typeof value === 'object' ? value : {};
    return {
      enabled: Boolean(raw.enabled),
      gainDb: clampGainDb(raw.gainDb),
      blastGuard: Boolean(raw.blastGuard),
    };
  }

  // Per-site top-level storage keys: `site:<siteKey>` holds that site's
  // { enabled, gainDb, blastGuard, seq, mirror } in ONE value. The documented
  // `chrome.storage.local.set` granularity is the top-level key ("Any other
  // key/value pairs in storage will not be affected"), so a write to
  // `site:youtube.com` can never touch `site:example.com` — cross-site
  // clobber is impossible by construction, unlike a whole-map
  // read-modify-write of `siteSettings`. A single `set` carrying the whole
  // per-site record means settings/mirror/sequence can never diverge across
  // separate writes.
  var SITE_KEY_PREFIX = 'site:';

  function siteStorageKey(siteKey) {
    const normalized = getSiteKey(siteKey);
    if (!normalized) return '';
    return SITE_KEY_PREFIX + normalized;
  }

  function isSiteStorageKey(key) {
    return typeof key === 'string' && key.indexOf(SITE_KEY_PREFIX) === 0;
  }

  function siteKeyFromStorageKey(key) {
    if (!isSiteStorageKey(key)) return '';
    return getSiteKey(key.slice(SITE_KEY_PREFIX.length));
  }

  /**
   * Normalize a per-site record. Ordering is last-accepted-write-wins: the
   * background applies an intent's fields to the live record and writes the
   * whole record back in one `set`; the later *arrival* wins, not the later
   * user action. `seq` is a durable per-site monotonic counter bumped on
   * every accepted write — audit and observability only, never an acceptance
   * gate; nothing is ever rejected on ordering grounds.
   * Accepted trade (deliberate): if two popups race the same field and one
   * message is delayed past a newer one, the later arrival wins rather than
   * the later action. There is no clock-free way to distinguish those; the
   * window is milliseconds between two simultaneously-open popups, and the
   * alternative (wall-clock per-field maxima) froze a field until the wall
   * clock caught up — potentially for years after a mistakenly future-dated
   * write — with no restart helping because the maxima persisted.
   * `mirror` is the popup-facing follower of `enabled` carried in the same
   * write so the two can never part across a crash. Legacy `at*` clock
   * fields are ignored when present and never written back.
   * @param {unknown} value
   */
  function normalizeSiteRecord(value) {
    const raw = /** @type {Record<string, unknown>} */ (value && typeof value === 'object' ? value : {});
    const enabled = Boolean(raw.enabled);
    const seqRaw = Number(raw.seq);
    const seq = Number.isFinite(seqRaw) && seqRaw >= 0 ? Math.floor(seqRaw) : 0;
    const mirrorRaw = Object.prototype.hasOwnProperty.call(raw, 'mirror')
      ? raw.mirror
      : enabled;
    return {
      enabled,
      gainDb: clampGainDb(raw.gainDb),
      blastGuard: Boolean(raw.blastGuard),
      seq,
      mirror: Boolean(mirrorRaw),
    };
  }

  /**
   * One-time legacy migration into a per-site record (in-memory only; the
   * caller persists the returned record with a single per-site `set`).
   * Rule: an explicit `siteToggles` boolean wins for `enabled` — it is the
   * surface the user actually toggled — repairing the pre-fix historical
   * diverge (mirror-off while settings-on). Afterwards the per-site key
   * exists and is preferred over legacy on every read, so a stale mirror
   * entry can never resurrect over newer truth and no separate marker is
   * needed. Legacy `activeSites` enables are honoured. Returns null when no
   * legacy entry exists for the site.
   * Lossless rule: legacy keys are NORMALISED before matching, so a
   * `www.`/sibling-subdomain key is found when reading the canonical key.
   * A user with only `siteSettings['www.youtube.com']` keeps gain and
   * Blast Guard when reading `youtube.com`.
   * @param {Record<string, unknown>} siteSettings
   * @param {Record<string, boolean>} activeSites
   * @param {Record<string, unknown>} siteToggles
   * @param {string} hostnameOrSiteKey
   */
  function migrateLegacyToRecord(siteSettings, activeSites, siteToggles, hostnameOrSiteKey) {
    const siteKey = getSiteKey(hostnameOrSiteKey);
    if (!siteKey) return null;
    const toggles = siteToggles && typeof siteToggles === 'object' ? siteToggles : {};
    const settings = siteSettings && typeof siteSettings === 'object' ? siteSettings : {};
    const actives = activeSites && typeof activeSites === 'object' ? activeSites : {};
    // Normalised existence: any raw key collapsing to `siteKey` counts.
    // The old exact-match check (`settings[siteKey] || settings[raw]`)
    // missed a `www.`-only entry when reading the canonical key and
    // returned null, dropping gain/Blast Guard on upgrade.
    let hasSettings = false;
    let hasToggle = false;
    let hasActive = false;
    /** @type {boolean | null} */
    let normalizedToggle = null;
    for (const [rawKey, value] of Object.entries(settings)) {
      try {
        if (getSiteKey(rawKey) === siteKey) { hasSettings = true; break; }
      } catch {}
    }
    for (const [rawKey, value] of Object.entries(toggles)) {
      try {
        if (getSiteKey(rawKey) === siteKey && typeof value === 'boolean') {
          hasToggle = true;
          normalizedToggle = value;
        }
      } catch {}
    }
    for (const [rawKey, value] of Object.entries(actives)) {
      try {
        if (getSiteKey(rawKey) === siteKey && Boolean(value)) { hasActive = true; break; }
      } catch {}
    }
    if (!hasSettings && !hasToggle && !hasActive) return null;
    const base = getSiteConfig(siteSettings, activeSites, siteKey);
    let enabled = base.enabled;
    if (hasToggle && normalizedToggle !== null) {
      enabled = Boolean(normalizedToggle);
    }
    return normalizeSiteRecord({
      enabled,
      gainDb: base.gainDb,
      blastGuard: base.blastGuard,
      seq: 0,
      mirror: enabled,
    });
  }

  function migrateSiteSettings(siteSettings, activeSites) {
    const next = {};

    for (const [rawKey, config] of Object.entries(siteSettings || {})) {
      const siteKey = getSiteKey(rawKey);
      if (!siteKey) continue;
      const prev = next[siteKey];
      if (!prev) {
        next[siteKey] = normalizeSiteSettings(config);
        continue;
      }
      // Merge when two raw keys collapse to one site (finding 4): the second
      // raw entry must not wipe the first's fields. Precedence is
      // last-explicit-field-wins — a field present in the later raw entry
      // overwrites, an absent field preserves the earlier value. The `true`
      // shorthand asserts only `enabled:true` and preserves gain/guard.
      if (config === true) {
        next[siteKey] = { ...prev, enabled: true };
        continue;
      }
      const raw = (config && typeof config === 'object' ? config : {});
      const merged = { ...prev };
      if (Object.prototype.hasOwnProperty.call(raw, 'enabled')) merged.enabled = Boolean(raw.enabled);
      if (Object.prototype.hasOwnProperty.call(raw, 'gainDb')) merged.gainDb = clampGainDb(raw.gainDb);
      if (Object.prototype.hasOwnProperty.call(raw, 'blastGuard')) merged.blastGuard = Boolean(raw.blastGuard);
      next[siteKey] = normalizeSiteSettings(merged);
    }

    for (const [rawKey, enabled] of Object.entries(activeSites || {})) {
      if (!enabled) continue;
      const siteKey = getSiteKey(rawKey);
      if (!siteKey) continue;
      next[siteKey] = normalizeSiteSettings({
        ...next[siteKey],
        enabled: true,
      });
    }

    return next;
  }

  function getSiteConfig(siteSettings, activeSites, hostnameOrSiteKey) {
    const siteKey = getSiteKey(hostnameOrSiteKey);
    const migrated = migrateSiteSettings(siteSettings, activeSites);

    if (!siteKey) {
      return { siteKey: '', enabled: false, gainDb: DEFAULT_GAIN_DB, blastGuard: DEFAULT_BLAST_GUARD };
    }

    return {
      siteKey,
      ...normalizeSiteSettings(migrated[siteKey]),
    };
  }

  function setSiteConfig(siteSettings, activeSites, hostnameOrSiteKey, updates) {
    const migrated = migrateSiteSettings(siteSettings, activeSites);
    const siteKey = getSiteKey(hostnameOrSiteKey);

    if (!siteKey) {
      return migrated;
    }

    const current = normalizeSiteSettings(migrated[siteKey]);
    const next = normalizeSiteSettings({
      ...current,
      ...(updates && typeof updates === 'object' ? updates : {}),
    });

    migrated[siteKey] = next;
    return migrated;
  }

  function setSiteEnabled(activeSites, hostnameOrSiteKey, enabled) {
    const next = migrateActiveSites(activeSites);
    const siteKey = getSiteKey(hostnameOrSiteKey);

    if (!siteKey) {
      return next;
    }

    if (enabled) {
      next[siteKey] = true;
    } else {
      delete next[siteKey];
    }

    return next;
  }

  function getContentAction({ enabled, injected, hookAlive }) {
    if (!enabled) {
      return injected ? 'stop' : 'idle';
    }

    if (!injected || !hookAlive) {
      return 'inject';
    }

    return 'start';
  }

  function getPopupIndicator({ enabled, hookAlive, hookActive, lastError }) {
    if (enabled && lastError) {
      return 'red';
    }

    if (enabled && hookAlive && hookActive) {
      return 'green';
    }

    return 'gray';
  }

  // Recurrence-path closure: the whole-map `siteToggles` mirror writer used
  // to live here (`saveSiteState`, a serialised read-modify-write of the
  // entire mirror map). It had zero callers in the product — the background
  // writes only per-site `site:<key>` records (plus the startup
  // `activeSites` clear), the content script performs zero storage writes,
  // and the popup sends field-level intents via messages — but as long as
  // the writer existed, any future popup-path call could re-create the
  // diverging state the owner reported (`siteToggles[site] = false` while a
  // per-site record says `enabled: true`, mirror newer). The writer is
  // therefore deleted; the mirror is now write-impossible from product code
  // and survives read-only as a migration fallback
  // (`migrateLegacyToRecord`, which repairs the diverge once by letting an
  // explicit toggle win `enabled`). Every legacy READ shape is preserved:
  // `get` keys, the `changes.siteToggles` listeners, and the migration
  // arguments. A structural test (`setting-loss.test.js`: "no product writer
  // can re-create a mirror/settings diverge") fails if any `siteToggles` /
  // `siteSettings` write ever returns to product code.

  return {
    DEFAULT_GAIN_DB,
    DEFAULT_BLAST_GUARD,
    clampGainDb,
    extractHostname,
    getSiteKey,
    getLegacySiteKey,
    migrateActiveSites,
    migrateSiteSettings,
    getSiteConfig,
    setSiteConfig,
    setSiteEnabled,
    getContentAction,
    getPopupIndicator,
    // NOTE: `saveSiteState` (the whole-map `siteToggles` mirror writer) was
    // deleted to close the recurrence path — see the note above. It is
    // deliberately absent from this export, not an omission.
    SITE_KEY_PREFIX,
    siteStorageKey,
    isSiteStorageKey,
    siteKeyFromStorageKey,
    normalizeSiteRecord,
    migrateLegacyToRecord,

  };
});
