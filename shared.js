(function (root, factory) {
  const api = factory();

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }

  root.TabNormalizerShared = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const MULTIPART_PUBLIC_SUFFIXES = new Set([
    'ac.uk',
    'co.jp',
    'co.uk',
    'com.au',
    'com.br',
    'com.mx',
    'com.tr',
    'net.au',
    'org.au',
    'org.uk',
  ]);
  const DEFAULT_GAIN_DB = 0;
  const MIN_GAIN_DB = -6;
  const MAX_GAIN_DB = 6;
  const GAIN_STEP_DB = 0.5;

  function extractHostname(url) {
    try {
      return new URL(url).hostname;
    } catch {
      return '';
    }
  }

  function getSiteKey(hostname) {
    const normalized = String(hostname || '').trim().toLowerCase().replace(/\.+$/, '');
    if (!normalized) return '';

    if (normalized === 'localhost' || /^[\d.:]+$/.test(normalized)) {
      return normalized;
    }

    const parts = normalized.split('.').filter(Boolean);
    if (parts.length <= 2) {
      return normalized;
    }

    const suffix = parts.slice(-2).join('.');
    if (MULTIPART_PUBLIC_SUFFIXES.has(suffix) && parts.length >= 3) {
      return parts.slice(-3).join('.');
    }

    return parts.slice(-2).join('.');
  }

  function migrateActiveSites(activeSites) {
    const next = {};

    for (const [rawKey, enabled] of Object.entries(activeSites || {})) {
      if (!enabled) continue;

      const siteKey = getSiteKey(rawKey);
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
      return { enabled: true, gainDb: DEFAULT_GAIN_DB };
    }

    const raw = value && typeof value === 'object' ? value : {};
    return {
      enabled: Boolean(raw.enabled),
      gainDb: clampGainDb(raw.gainDb),
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
      return { siteKey: '', enabled: false, gainDb: DEFAULT_GAIN_DB };
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

  return {
    DEFAULT_GAIN_DB,
    MIN_GAIN_DB,
    MAX_GAIN_DB,
    GAIN_STEP_DB,
    clampGainDb,
    extractHostname,
    getSiteKey,
    migrateActiveSites,
    migrateSiteSettings,
    getSiteConfig,
    setSiteConfig,
    setSiteEnabled,
    getContentAction,
    getPopupIndicator,
  };
});
