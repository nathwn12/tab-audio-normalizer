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
    return String(hostname || '').trim().toLowerCase().replace(/\.+$/, '');
  }

  function getLegacySiteKey(hostname) {
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

  function migrateSiteSettings(siteSettings, activeSites) {
    const next = {};

    for (const [rawKey, config] of Object.entries(siteSettings || {})) {
      const siteKey = getSiteKey(rawKey);
      if (!siteKey) continue;
      next[siteKey] = normalizeSiteSettings(config);
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

  // --- Firefox port: exact-host site key (no subdomain collapsing) ---

  function getExactHostKey(url) {
    try {
      const u = new URL(url);
      let key = u.hostname.toLowerCase();
      if (u.port && u.port !== '80' && u.port !== '443') {
        key += ':' + u.port;
      }
      return key;
    } catch {
      return '';
    }
  }

  function storageGet(keys) {
    return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
  }

  function storageSet(items) {
    return chrome.storage.local.set(items);
  }

  async function loadSiteState(siteKey) {
    const result = await storageGet('siteToggles');
    const toggles = /** @type {Record<string, boolean>} */ (result.siteToggles || {});
    return siteKey in toggles ? toggles[siteKey] : null;
  }

  async function saveSiteState(siteKey, enabled) {
    const result = await storageGet('siteToggles');
    const toggles = /** @type {Record<string, boolean>} */ (result.siteToggles || {});
    toggles[siteKey] = enabled;
    await storageSet({ siteToggles: toggles });
  }

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
    getExactHostKey,
    storageGet,
    storageSet,
    loadSiteState,
    saveSiteState,

  };
});
