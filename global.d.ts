/* eslint-disable */
// Global type declarations for the Tab Audio Normalizer extension
// These ensure tsc --checkJs passes on the JS source files

/** Typed interface matching the API returned by shared.js factory function */
interface TabNormalizerSharedApi {
  DEFAULT_GAIN_DB: number;
  DEFAULT_BLAST_GUARD: boolean;
  clampGainDb: (value: unknown) => number;
  extractHostname: (url: string) => string;
  getSiteKey: (hostname: string) => string;
  getLegacySiteKey: (hostname: string) => string;
  migrateActiveSites: (activeSites: Record<string, boolean>) => Record<string, boolean>;
  migrateSiteSettings: (
    siteSettings: Record<string, unknown>,
    activeSites: Record<string, boolean>
  ) => Record<string, unknown>;
  getSiteConfig: (
    siteSettings: Record<string, unknown>,
    activeSites: Record<string, boolean>,
    hostnameOrSiteKey: string
  ) => { siteKey: string; enabled: boolean; gainDb: number; blastGuard: boolean };
  setSiteConfig: (
    siteSettings: Record<string, unknown>,
    activeSites: Record<string, boolean>,
    hostnameOrSiteKey: string,
    updates: Record<string, unknown>
  ) => Record<string, unknown>;
  setSiteEnabled: (
    activeSites: Record<string, boolean>,
    hostnameOrSiteKey: string,
    enabled: boolean
  ) => Record<string, boolean>;
  getContentAction: (state: {
    enabled: boolean;
    injected: boolean;
    hookAlive: boolean;
  }) => string;
  getPopupIndicator: (state: {
    enabled: boolean;
    hookAlive: boolean;
    hookActive: boolean;
    lastError: string;
  }) => string;
  getExactHostKey: (url: string) => string;
  storageGet: (keys: string | string[] | Record<string, unknown>) => Promise<Record<string, unknown>>;
  storageSet: (items: Record<string, unknown>) => Promise<void>;
  loadSiteState: (siteKey: string) => Promise<boolean | null>;
  saveSiteState: (siteKey: string, enabled: boolean) => Promise<void>;
  migrateLegacyState: (siteKey: string) => Promise<boolean>;
  onStorageChanged: (callback: (toggles: Record<string, boolean>) => void) => void;
}

interface Window {
  TabNormalizerShared: TabNormalizerSharedApi;
  __tabNormalizerContentScriptV5: { reinject: () => void };
  __tabNormalizerHookV5: { revive: () => void };
  webkitAudioContext?: typeof AudioContext;
}

// Augment AudioNode for patched connect tracking
interface AudioNode {
  __tnConnect?: boolean;
}

// Augment AudioContext for patched AudioContext tracking
interface AudioContextConstructor {
  __tnPatched?: boolean;
}

interface OfflineAudioContextConstructor {
  __tnPatched?: boolean;
}

interface AudioContext {
  __tnMediaSource?: boolean;
}

// Augment HTMLMediaElement for element tracking
interface HTMLMediaElement {
  __tnPlay?: boolean;
  __tnWebAudio?: boolean;
  __tnAttached?: boolean;
}

// No augmentation needed for HTMLOrSVGScriptElement (it's a type alias, not an interface)

// Firefox service worker function
declare function importScripts(...urls: string[]): void;
