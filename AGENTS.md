# AGENTS

## Repo Shape
- MV3 Chromium-only extension (no Firefox). No build step — load repo root as unpacked extension.
- Entrypoints: `background.js` (service worker, `importScripts('shared.js')`), `content-script.js` + `shared.js` (ISOLATED, `document_start`, all frames per `manifest.json`), `page-hook.js` (MAIN world via `chrome.scripting.executeScript`, patches `AudioContext` / `AudioNode.connect` / `HTMLMediaElement.play`), `popup.html`/`popup.js`, `audio/normalizer-worklet.js` (AudioWorkletProcessor loaded by `page-hook.js`).

## Commands
- `node tests/shared.test.js` — unit tests; run when touching `shared.js`. Currently 18/18 pass.
- `npm run typecheck` — `tsc --noEmit` with `checkJs`. Needs `npm install` first (`package.json`/`tsconfig.json` are gitignored local-only). Only root `*.js` + `*.d.ts` are checked; `tests/` excluded, `qa/*.cjs` never typechecked.
- `node loudness-alignment.cjs` — must exit 0 before any commit that changes `audio/normalizer-worklet.js`, `popup.html`, `README.md` or `CHANGELOG.md`.
- `node qa/extension-qa.cjs` - popup/content-script flow. **BANNED from execution (see Audio Safety).**
- `node qa/responsive-normalizer-qa.cjs` - AudioWorklet loud/quiet/burst/toggle scenarios. **BANNED from execution (see Audio Safety): launches Chromium and plays audio via a real AudioContext.**
- QA loads Playwright from hardcoded Scoop path; override with `TN_PLAYWRIGHT_PATH`. `TN_QA_HEADLESS=0` for visible browser (default headless). **Do not run either QA script - see Audio Safety.**

## Audio Safety (permanent)
- **No audio playback in any test, ever.** Never launch a Chromium instance that can produce sound: no autoplay, no headed browser, no chrome-devtools/MCP audio or traces, and **not even muted playback as a test**.
- `qa/responsive-normalizer-qa.cjs` and `qa/extension-qa.cjs` are **banned from execution** - they launch Chromium and drive an oscillator/AudioContext.
- All audio verification is **silent**: static/code checks plus offline numeric analysis of captured sample buffers, run in Node with no browser and no audio device (e.g. a worklet DSP simulation harness that stubs `AudioWorkletProcessor`/`registerProcessor`/`sampleRate` and calls `process()` on synthetic `Float32Array` blocks).
- If a browser-based audio check is truly unavoidable, **STOP and escalate for explicit user approval** before launching anything.

## Architecture Gotchas
- `shared.js` is a UMD module and the source of truth for `getSiteKey`, `migrateSiteSettings`, `getContentAction`, `getPopupIndicator`, gain clamp (-12..+12 dB, 0.5 step), and the per-site record helpers (`siteStorageKey` / `normalizeSiteRecord` / `migrateLegacyToRecord`) that the background and content script use at runtime. `getSiteConfig` is a legacy whole-map read helper still called in product on the legacy fallback path (`content-script.js:223,224` legacy-branch compare, `content-script.js:267` legacy fallback in `readStoredConfig`, plus `shared.js:206` inside `migrateLegacyToRecord` which the background and content script call at runtime); `setSiteConfig` is the legacy whole-map write helper with zero product callers (tests only: `tests/shared.test.js`); runtime persistence uses per-site `site:<key>` records. `content-script.js` does lifecycle/sync only — **no audio processing**.
- `page-hook.js` runs in MAIN world and **cannot import `shared.js`**. `MIN/MAX_GAIN_DB`, `CHANNEL` (`tab-normalizer-v5`), `PENDING_ATTR` are deliberately duplicated across `shared.js` / `page-hook.js` / `content-script.js` / worklet (see `docs/DELETION_LOG.md`) — do not "dedupe".
- `getSiteKey()` collapses sibling subdomains + handles ccTLDs (`co.uk`, `com.au`, …), localhost, IPs, ports. `content-script.js` ↔ `page-hook.js` talk via `window.postMessage` on `tab-normalizer-v5`.
- Storage: `site:<siteKey>` is source of truth (one top-level key per site holding enabled/gainDb/blastGuard/mirror/seq in ONE write; cross-site clobber impossible by top-level granularity); legacy `activeSites`/`siteSettings`/`siteToggles`/`siteSeq` are read for migration only (`activeSites` cleared on startup) — preserve those read paths and the `siteToggles` listener. Ordering is last-accepted-write-wins: the background applies an intent's fields to the live record and writes the whole record back in one `set`, bumping the per-site `seq` audit counter; nothing is ever rejected on ordering grounds. Accepted trade: a delayed message that arrives after a newer one wins by arrival, not by action time.

## Popup / QA Constraints
- Preserve popup IDs — QA reads them directly: `#hostname`, `#status-dot`, `#status-text`, `#toggle`, `#blast-guard`, `#gain-slider`, `#gain-value`, `#reset-btn`.
- Popup disables gain/preset/Blast Guard controls unless the per-site toggle is on.

## Git Hygiene
- Run `git status` before committing. `.gitignore` is aggressive (`*.json`, `tests/`, `qa/`) — new docs/config are silently ignored; only already-tracked files stay tracked.
- Tracked extension files: `background.js`, `content-script.js`, `page-hook.js`, `popup.js`, `popup.html`, `shared.js`, `manifest.json`, `audio/`, `global.d.ts`, `README.md`, `PRIVACY_POLICY.md`, `STORE_SUBMISSION.md`. `package.json` / `tsconfig.json` / `package-lock.json`, `tests/`, `qa/`, `.opencode/`, `node_modules/` stay local.
- Consult `docs/DELETION_LOG.md` before deleting code — it records prior dead-code removals and ISOLATED/MAIN duplication rationale.
