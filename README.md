# Tab Audio Normalizer v5

Lightweight Chromium/Brave extension for per-site audio normalization.

## What it does

- Keeps audio in comfortable loudness range (-23.5 to -18 LUFS) with adaptive gain control
- Single toggle per hostname - persists across tabs
- Works with: YouTube, Spotify, Facebook, Instagram, TikTok, and more
- Uses EBU R128-inspired 400ms loudness measurement
- Blast Guard peak protection mode for sensitive content

## Files

```
audio-normalizeV5/
├── manifest.json          # Extension manifest v3
├── background.js          # Storage, injection, site coordination
├── content-script.js      # Page injection controller + SPA detection
├── page-hook.js          # Web Audio API patching
├── shared.js             # Cross-context helpers (site keys, config, migration)
├── popup.html            # Controls UI (dark theme, presets, gain slider)
├── popup.js              # Popup logic
├── audio/
│   ├── normalizer-worklet.js  # Audio processing
│   └── icon-*.png        # Extension icons
└── README.md
```

### Installation (Brave / Chromium)
1. Open `brave://extensions` or `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select this folder

## Usage

1. Visit a site with audio (YouTube, etc.)
2. Click extension icon
3. Toggle **Active** ON for that site
4. Adjust gain slider or use presets (Speech/Music/Boost)
5. Enable **Blast Guard** for stricter peak protection
6. Open new tabs to same site → auto-normalizes

## Presets

| Preset | Gain | Use case |
|--------|------|----------|
| Speech | -3 dB | Dialogue-heavy content |
| Music  |  0 dB | Balanced default |
| Boost  | +3 dB | Quiet content |

## Technical

- **Comfort zone:** -23.5 to -18 LUFS (content outside this range gets gentle correction)
- **Loudness measurement:** Three-window algorithm (momentary/short/program) with gating
- **Attack/Release:** 20ms down / 250ms up (25ms down in Blast Guard), 50ms minimum analysis, no startup assist
- **True peak limiting:** -1 dBTP ceiling with 3ms lookahead
- **Architecture:** Content script injection → AudioWorklet processing (Chromium-only, no Firefox support)

## Permissions

- `storage`: Persist per-site preferences
- `tabs`: Get current tab info for popup
- `scripting`: Inject audio processing into page context
- `host_permissions`: All URLs (required for universal audio normalization)

## Privacy

All processing happens locally in the browser. No audio is uploaded or transmitted.
