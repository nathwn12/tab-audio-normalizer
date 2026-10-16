<p align="center">
  <img src="audio/icon-128.png" width="120" height="120" alt="Tab Audio Normalizer icon" />
</p>
<h1 align="center">Tab Audio Normalizer</h1>
<p align="center"><strong>Keep per-site tab audio at a comfortable loudness in Chrome and Brave.</strong></p>
<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/github/license/nathwn12/tab-audio-normalizer" alt="License" /></a>
  <img src="https://img.shields.io/github/languages/top/nathwn12/tab-audio-normalizer" alt="Language" />
  <img src="https://img.shields.io/badge/platform-chrome--brave-2b3137?logo=googlechrome&logoColor=white" alt="Platform" />
</p>

## Project name and description

**Tab Audio Normalizer** (v5.2.0, Manifest V3) evens out loudness differences between tabs and sites. Each hostname gets one persisted Active toggle; adaptive gain control then holds audio inside a −23.5 to −18 LUFS comfort zone. All processing stays local in the browser — nothing is uploaded or transmitted. For anyone who bounces between loud and quiet videos, streams, and calls in Chrome or Brave (Chromium only, no Firefox).

## Technology stack

- Vanilla JavaScript, Manifest V3 extension (no framework, no build step)
- Web Audio: `AudioContext` patch + `AudioWorkletProcessor` (`audio/normalizer-worklet.js`)
- Extension APIs: `storage`, `tabs`, `scripting` permissions; `http://*/*` and `https://*/*` host permissions
- Dev-only: Node.js, TypeScript `^6.0.3` and `@types/chrome` `~0.0.332` for `npm run typecheck` (`tsc --noEmit`, `checkJs`)

## Architecture

```text
popup.html / popup.js ── chrome.storage ──► siteSettings (source of truth)
background.js (service worker, importScripts shared.js)
content-script.js + shared.js (ISOLATED world, document_start, all frames)
        │ window.postMessage on "tab-normalizer-v5"
page-hook.js (MAIN world via chrome.scripting.executeScript)
        │ patches AudioContext / AudioNode.connect / HTMLMediaElement.play
audio/normalizer-worklet.js (AudioWorkletProcessor, loaded by page-hook.js)
```

Notes: `shared.js` is a UMD module and the source of truth for `getSiteKey`, `migrateSiteSettings`, `get/setSiteConfig`, `getContentAction`, `getPopupIndicator`, and gain clamp (−12…+12 dB, 0.5 step). `page-hook.js` runs in MAIN world and cannot import `shared.js`, so `MIN/MAX_GAIN_DB`, `CHANNEL` (`tab-normalizer-v5`), and `PENDING_ATTR` are deliberately duplicated — do not "dedupe". `content-script.js` handles lifecycle/sync only, no audio processing. Storage: `siteSettings` is authoritative; legacy `activeSites` is migrated then cleared to `{}`. Loudness measurement is EBU R128-inspired with 400 ms blocks and momentary, short-term, and program windows; Blast Guard adds a −2 dBTP true-peak ceiling.

## Getting started

Prerequisites: Chrome or Brave (desktop), Developer mode access.

1. Open `chrome://extensions` (or `brave://extensions`).
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select the repo root (the folder containing `manifest.json`).
5. Visit a site with audio, click the extension icon, and toggle **Active** ON for that site.

> [!NOTE]
> There is no build step. `package.json` / `tsconfig.json` are local-only helpers for typechecking; loading the unpacked repo root is the install.

## Project structure

```text
manifest.json            MV3 manifest (v5.2.0; storage/tabs/scripting; popup.html)
background.js            service worker
content-script.js        ISOLATED-world lifecycle/sync (no audio processing)
shared.js                UMD source of truth (site keys, config, gain clamp)
page-hook.js             MAIN-world AudioContext/connect/play patch
audio/normalizer-worklet.js  AudioWorkletProcessor DSP
audio/icon-*.png         toolbar/store raster icons (16/32/48/128)
assets/icon.svg          house tile mark (README header)
popup.html / popup.js    per-site popup (Active toggle, gain, presets, Blast Guard)
global.d.ts              type declarations for checkJs
PRIVACY_POLICY.md        data-handling statement
STORE_SUBMISSION.md      Web Store submission checklist
CHANGELOG.md             release history (Keep a Changelog)
```

## Key features

- Per-hostname Active toggle persisted across tabs (sibling-subdomain and ccTLD aware via `getSiteKey`)
- Adaptive gain holding audio near the −23.5 to −18 LUFS comfort zone
- EBU R128-inspired 400 ms loudness measurement (momentary, short-term, program windows)
- Blast Guard mode with −2 dBTP true-peak ceiling
- Gain slider (−12 to +12 dB, 0.5 step) plus Speech, Music, and Boost presets
- SPA navigation detection and service-worker restart recovery
- Fully local processing; no network transmission of audio

## Development workflow

- Source change? Edit the root `*.js` directly — no bundler, reload the unpacked extension to test.
- Typecheck (local-only helpers, absent from a fresh clone): `npm install` once, then `npm run typecheck` (`tsc --noEmit`; only root `*.js` + `*.d.ts` are checked, `tests/` excluded, `qa/*.cjs` never typechecked).
- Unit tests (local-only, not shipped): `node tests/shared.test.js` when touching `shared.js`.
- Popup IDs are a contract with QA — preserve `#hostname`, `#status-dot`, `#status-text`, `#toggle`, `#blast-guard`, `#gain-slider`, `#gain-value`, `#reset-btn`.
- Popup disables gain/preset/Blast Guard controls unless the per-site toggle is on.

> [!CAUTION]
> Never play audio in a test. The local-only `qa/extension-qa.cjs` and `qa/responsive-normalizer-qa.cjs` launch Chromium with a real `AudioContext` and are **banned from execution**. Verify audio paths silently: static/code checks plus offline numeric analysis of captured buffers in Node (stub `AudioWorkletProcessor` / `registerProcessor` / `sampleRate`, call `process()` on synthetic `Float32Array` blocks). If a browser audio check seems unavoidable, stop and get explicit approval first.

## Coding standards

- `shared.js` is the single source of truth for site-key, config, and gain logic; ISOLATED/MAIN duplication of constants is intentional (see `docs/DELETION_LOG.md`).
- `content-script.js` stays lifecycle/sync only; DSP lives in the worklet and the page hook.
- Consult `docs/DELETION_LOG.md` before deleting code — it records prior dead-code removals and the duplication rationale.
- Keep the MV3 surface minimal: no new permissions or host patterns without a manifest-verified reason.

## Testing

> [!NOTE]
> The test harness is local-only and not shipped: `tests/`, `qa/`, `package.json`, and `tsconfig.json` are gitignored, so none of the commands below work from a fresh clone.

- `node tests/shared.test.js` — unit tests for `shared.js` (11/11 passing at last check).
- `npm run typecheck` — `tsc --noEmit` with `checkJs` (needs `npm install` first).
- Browser QA scripts (`qa/`, local-only) are banned from execution (see caution above); run only static/offline checks.

## Contributing

Small, focused PRs against `main`. See `AGENTS.md` for the contributor contract. Keep the unpacked-load flow working, preserve the popup ID contract, add or update unit tests (local-only) when touching `shared.js`, and run `npm run typecheck`. See [CHANGELOG.md](CHANGELOG.md) for release history.

## License

MIT — see [LICENSE](LICENSE).

<!-- nathwn12 house footer: identical in every repo. Do not edit. -->
<p align="center">
  <a href="https://github.com/nathwn12"><img src="assets/signature.svg" width="96" alt="nathwn12" /></a>
</p>
<p align="center">
  <sub>Built by <a href="https://github.com/nathwn12">nathwn12</a> · <a href="https://github.com/nathwn12?tab=repositories">All projects</a></sub>
</p>
