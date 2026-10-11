<p align="center">
  <img src="assets/icon.svg" width="128" height="128" alt="Tab Audio Normalizer icon" />
</p>
<h1 align="center">Tab Audio Normalizer</h1>
<p align="center"><strong>Normalize per-site audio loudness in Chrome and Brave.</strong></p>
<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/github/license/nathwn12/tab-audio-normalizer" alt="License" /></a>
  <img src="https://img.shields.io/github/languages/top/nathwn12/tab-audio-normalizer" alt="Language" />
  <img src="https://img.shields.io/badge/platform-chrome--brave-2b3137?logo=googlechrome&logoColor=white" alt="Platform" />
  <a href="https://github.com/nathwn12/tab-audio-normalizer/actions/workflows/ci.yml"><img src="https://github.com/nathwn12/tab-audio-normalizer/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
</p>

## What it is

Tab Audio Normalizer is a Manifest V3 browser extension for Chrome and Brave that keeps per-site audio inside a comfortable loudness range. Each hostname gets a single toggle that persists across tabs, with adaptive gain control doing the levelling. It is for anyone who bounces between loud and quiet videos, streams, and calls.

## Why

Loudness jumps between sites and videos, so one tab whispers while the next one shouts. This extension evens that out automatically, per site, with all processing kept local in the browser.

## Features

- Per-hostname Active toggle that persists across tabs
- Adaptive gain control holding audio near a -23.5 to -18 LUFS comfort zone
- EBU R128-inspired 400ms loudness measurement with momentary, short-term, and program windows
- Blast Guard mode for stricter peak protection with a -1 dBTP true-peak ceiling
- Gain slider (-12 to +12 dB) plus Speech, Music, and Boost presets
- Content-script injection into AudioWorklet processing, with SPA navigation detection
- All audio processing stays local; nothing is uploaded or transmitted

## Install

1. Open `chrome://extensions` or `brave://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this folder.

## Usage

1. Visit a site with audio, such as YouTube.
2. Click the extension icon to open the popup.
3. Toggle **Active** ON for that site.
4. Adjust the gain slider or pick a Speech, Music, or Boost preset.
5. Open new tabs on the same site; they normalize automatically.

## Docs

- [PRIVACY_POLICY.md](PRIVACY_POLICY.md) — what data the extension touches and why it stays local.
- [STORE_SUBMISSION.md](STORE_SUBMISSION.md) — Chrome Web Store submission checklist.

## Status

**Unverified** — as-is, use at your own risk. Clean-profile install and store review are unverified.

## License

MIT — see [LICENSE](LICENSE).

<!-- nathwn12 house footer: identical in every repo. Do not edit. -->
<p align="center">
  <a href="https://github.com/nathwn12"><img src="assets/signature.svg" width="96" alt="nathwn12" /></a>
</p>
<p align="center">
  <sub>Built by <a href="https://github.com/nathwn12">nathwn12</a> · <a href="https://github.com/nathwn12?tab=repositories">All projects</a></sub>
</p>
