# Tab Audio Normalizer v5

Lightweight Chrome extension for per-site audio normalization.

## What it does

- Keeps audio in comfortable loudness range (-23.5 to -18 LUFS) with adaptive gain control
- Single toggle per hostname - persists across tabs
- Works with: YouTube, Spotify, Facebook, Instagram, TikTok, etc.
- Uses EBU R128-inspired 400ms loudness measurement

## Files

```
audio-normalizeV5/
├── manifest.json          # Extension manifest v3
├── background.js          # Storage, injection, site coordination
├── content-script.js      # Page injection controller + SPA detection
├── page-hook.js          # Web Audio API patching
├── shared.js             # Cross-context helpers (site keys, config, migration)
├── popup.html            # Toggle UI (dark theme, presets, gain slider)
├── audio/
│   ├── normalizer-worklet.js  # Audio processing
│   └── icon-*.png        # Extension icons
└── README.md
```

## Load in Chrome/Brave

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select this folder

## Usage

1. Visit a site with audio (YouTube, etc.)
2. Click extension icon
3. Toggle ON for that site
4. Open new tabs to same site → auto-normalizes
5. Toggle OFF → stops normalizing

## Technical

- **Comfort zone:** -23.5 to -18 LUFS (content outside this range gets gentle correction)
- **Loudness measurement:** Three-window algorithm (momentary/short/program) with gating
- **Attack/Release:** 80ms attack, 2.9s release
- **True peak limiting:** -1 dBTP ceiling with 3ms lookahead
- **Architecture:** Content script injection → AudioWorklet processing

## Permissions

- `storage`: Remember per-site preferences
- `tabs`: Get current tab info for popup
- `scripting`: Inject audio processing into page context
- `host_permissions`: All URLs (required for universal audio normalization)

## Privacy

All processing happens locally in the browser. No audio is uploaded or transmitted.
