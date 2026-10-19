# Tab Audio Normalizer

**Keep every site at one comfortable loudness in Chrome and Brave.**

## Install

There is no store listing, so you load it unpacked from source. Clone the repo first:

```bash
git clone https://github.com/nathwn12/tab-audio-normalizer.git
```

Then open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, and select the cloned folder (the one containing `manifest.json`). Visit a site with audio, click the extension icon, and switch **Active** on for that site.

Once loaded, the extension measures the loudness of the sites you activate and moves each one toward its -20 LUFS program target and levels loud and quiet passages within each program instead of leaving loud and quiet tabs far apart. It adjusts tab audio gain locally in your browser; it asks for `storage`, `tabs`, `scripting`, plus read access to `http`/`https` pages so it can process their audio.

### Or let your AI install it

```
Clone nathwn12/tab-audio-normalizer and load it unpacked in Chrome: open chrome://extensions, enable Developer mode, click Load unpacked, and select the folder containing manifest.json.
Then open a page with audio, click the extension icon, switch Active on, and confirm the popup shows that page's hostname.
Reply with the extension version from manifest.json and the hostname you tested.
```

### Offline or pinned

There is no build step, so the checked-out folder is the extension. To pin an exact copy:

```bash
git clone https://github.com/nathwn12/tab-audio-normalizer.git
cd tab-audio-normalizer
git checkout 862797bf53accbb8964595bf55638bdc272551d7
```

Then load it unpacked with the steps above.

## Use it

Open a page that plays audio and click the extension icon. The popup names the current site. Switch **Active** on; the setting is saved per site, so it holds across tabs. Drag the gain slider (-12 to +12 dB) for an immediate output trim, or pick **Speech**, **Music**, or **Boost**. Click the reset button to return a site to defaults.

## What you get

- One **Active** toggle per site, remembered across tabs.
- Human-comfort loudness: within-program levelling (dead-band AGC — no adaptation inside ±2.5 LU of the program, engagement outside it) plus slow normalisation toward a fixed **-20 LUFS** program target, driven by gated integrated loudness per ITU-R BS.1770-4 / EBU R128 and measured from the levelled signal.
- Speech, Music, and Boost presets plus a manual gain slider (-12 to +12 dB); the slider is an immediate output trim, separate from the target.
- Fully local processing: your audio never leaves the browser.
- A true-peak limiter holds output at or below **-1 dBTP**, measured offline against ffmpeg's true-peak meter across a fixture set and an adversarial sweep — not verified in a browser, and not a guarantee for every possible signal.
- Startup: while an element attaches, it stays silent until its audio graph is routed (a 1.5-second fallback restores it if routing never completes), and the session pre-warms before your first playback. A loud cold start is attenuated toward the target from a ~100 ms probe: the old chain was still only -1.55 dB down at 0.5 s, while this one reaches -9.3 dB by 0.5 s and settles at -10.00 dB — measured offline in the loudness harness, not verified in a browser.
- Quiet-passage lift and level-step recovery are fixed: the dialogue fixture's quiet section rises +6.74 dB, its loud:quiet spread shrinks 12.77 dB (26.02 → 13.25), its tail settles at -20.00 LUFS, and the 60 s-quiet/30 s-loud step lands at -20.40 LUFS (delta -0.40, tolerance ±1.0) — measured offline in the loudness harness (qa/loudness-verify.cjs, release gate), not verified in a browser.

## Requirements

- Chrome or Brave on desktop (Chromium with Manifest V3 support). Firefox is not supported.
- Access to enable Developer mode on `chrome://extensions`.
- Git to clone the repo. No build step and no dependencies.

## Links

- Source: https://github.com/nathwn12/tab-audio-normalizer
- Privacy policy: [PRIVACY_POLICY.md](PRIVACY_POLICY.md)
- Release history: [CHANGELOG.md](CHANGELOG.md)
- License: [LICENSE](LICENSE) (MIT)
