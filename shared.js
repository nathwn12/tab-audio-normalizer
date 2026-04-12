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
    extractHostname,
    getSiteKey,
    migrateActiveSites,
    setSiteEnabled,
    getContentAction,
    getPopupIndicator,
  };
});
