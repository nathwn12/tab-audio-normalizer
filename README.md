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

Open a page that plays audio and click the extension icon. The popup names the current site. Switch **Active** on; the setting is saved per site, so it holds across tabs. Drag the gain slider (-12 to +12 dB) for an immediate output trim, or pick **Speech**, **Music**, or **Boost**. Switch **Blast Guard** on for stricter peak protection, and click the reset button to return a site to defaults.

## What you get

- One **Active** toggle per site, remembered across tabs.
- Human-comfort loudness: within-program levelling (dead-band AGC — no adaptation inside ±2.5 LU of the program, engagement outside it) plus slow normalisation toward a fixed **-20 LUFS** program target, driven by gated integrated loudness per ITU-R BS.1770-4 / EBU R128 and measured from the levelled signal.
- Speech, Music, and Boost presets plus a manual gain slider (-12 to +12 dB); the slider is an immediate output trim, separate from the target.
- Blast Guard mode with stricter peak protection.
- Fully local processing: your audio never leaves the browser.
- A true-peak limiter holds output at or below **-1 dBTP** (-2 dBTP with Blast Guard on), measured offline against ffmpeg's true-peak meter across a fixture set and an adversarial sweep — not verified in a browser, and not a guarantee for every possible signal.
- You hear a short clip start near its original loudness and move gradually toward the target over roughly 15–20 seconds while the engine acquires a valid gated measurement.

## Requirements

- Chrome or Brave on desktop (Chromium with Manifest V3 support). Firefox is not supported.
- Access to enable Developer mode on `chrome://extensions`.
- Git to clone the repo. No build step and no dependencies.

## Links

- Source: https://github.com/nathwn12/tab-audio-normalizer
- Privacy policy: [PRIVACY_POLICY.md](PRIVACY_POLICY.md)
- Release history: [CHANGELOG.md](CHANGELOG.md)
- License: [LICENSE](LICENSE) (MIT)
