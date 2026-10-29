# SPEC: per-program feed reset

Status: frozen 2026-10-21. Amends the cold-start portion of
`docs/SPEC_COMFORT.md` (H5/A6 numbers below are the historical pre-feed
record): a scroll feed replays the cold-start problem at every program
boundary, so each new program gets a per-program reset plus a faster cold
probe. Judge the feed fix against this document.

## 1. Outcome

A new video in a scroll feed starts at the previous video's settled gain
(no snap to unity, no click); a louder next video is cut to within 1.5 dB
of its own settled gain by 250 ms and 0.5 dB by 500 ms; a within-1-LU
transition moves <= 0.5 dB; a quiet next video is never boosted by the
reset; no added latency (no pre-roll, no silence).

## 2. Scope

Code: `audio/normalizer-worklet.js` (`reset-program` handler, 50 ms /
0.08 s cold probe), `page-hook.js` (program-boundary detection, generation
tokens). Gate: `qa/loudness-verify.cjs` (ONSET, 0.5 s bound + guard-disabled negative control),
`qa/feed-transition-qa.cjs`, `qa/program-boundary-qa.cjs`. Global: one
algorithm for every site; sites are verification coverage, never
configuration.

## 3. Exclusions

No pre-roll delay or added latency. No tabCapture rewrite. No network
preload or pre-analysis of the next video. No change to the −20 LUFS
target, persistence, popup, or user trim. No browser audio path changes.

## 4. Requirements and evidence

F1. Boundary signal. A new program is detected on media-element
`loadstart` / `emptied` / `ended`-then-`play`, on a different element
starting, or on a dirty same element starting. Pause/resume, seek, and
stall (`waiting` then `playing`) are continuity, never a boundary. A
`play()` attempt whose promise has not resolved is not a start: while it
is pending its `play`/`playing` events cannot reset, and a rejected
attempt leaves the program untouched; the resolved promise confirms the
start. Evidence: `qa/program-boundary-qa.cjs`, 10/10 rows PASS,
generations [1, 2, 3, 4, 5] monotonic. Control: rows 2/3/4/8/9 assert +0
resets, row 9 rejecting after emitting `play` + `playing`.

F2. Reset semantics. `reset-program` folds `currentAgcDb` into
`currentLoudnessDb` (clamped to the total −20/+12 dB clamp) and zeroes
AGC; clears both K-filter states, rings, blocks, gates, momentary,
short-term, warm flag, fast probe, and onset cut; preserves the folded
slow gain, trim, delay line, limiter schedule/state, both true-peak
histories, `truePeakTrack`, `totalFrames`, target/mode/cadence; refreshes
telemetry. The applied gain does not move at the reset instant.
Evidence: `qa/feed-transition-qa.cjs` F2 continuity row (+0.000 dB,
bound 0.1; duplicate generation +0.000). Control: a reset-to-unity fix
fails this row (~6 dB step).

F3. Carry-over cold gain. After reset the branch runs
`desired = min(slow, probe)` with `probe = target − fastLevel − AGC`,
clamped to [−20, +12] dB, cut-only, holding until the 50 ms probe fills
(`FAST_ONSET_SECONDS` 0.05, `FAST_ONSET_TC_SECONDS` 0.08). A ~6 dB louder
next program lands within 1.5 dB of its own settled gain by 250 ms and
0.5 dB by 500 ms; a same-loudness program moves <= 0.5 dB; a quieter
program sees no positive gain in the first 400 ms.
Evidence: `qa/feed-transition-qa.cjs` — GA −0.007 dB, GB −6.027 dB;
F3 +0.494 dB @250 ms, +0.065 dB @500 ms; SAME −0.000 dB; QUIET +0.000 dB.
Release-gate echo: `qa/loudness-verify.cjs` ONSET, −9.57 dB at 0.3 s
(−6 dB by 0.123 s), −9.96 dB at 1.0 s, settled −10.00, quiet 0.000 dB.
Control (must FAIL): A→B with NO reset reads +6.010 dB off at 250 ms
(bound 1.5 dB); without the reset the handoff cannot converge.

F4. Handoff without snap. `resetMeasurementForModeSwitch()` is untouched;
the slow loop takes over from the carried gain continuously (same
`desired = min(slow, probe)` branch as cold start). Evidence: F2
continuity + TRANSITION rows in the release gate (immediate step 0,
per-quantum slew within the configured slow-loop slew).

F5. Pause/seek/stall continuity. No reset fires on pause/resume, seek, or
stall; the gain trace is continuous across them. Evidence:
`qa/program-boundary-qa.cjs` rows 2–4 (+0 each).

F6. Long-form unaffected. A program with no boundary events never resets:
dialogue lift (+6.74 dB quiet rise), step recovery (ST@70 −20.40 LUFS),
and all closed-loop/true-peak/adversarial rows are unchanged.
Evidence: full `qa/loudness-verify.cjs` — every non-ONSET section PASS.

## 5. Runnable check

`node qa/feed-transition-qa.cjs` — exit 0 all PASS; exit 2 any FAIL or
UNTESTED; exit 1 harness error. Release gate: `node qa/loudness-verify.cjs`
(exit 0 PASS; exit 2 FAIL/UNTESTED).

## 6. Open calls

- Probe 50 vs 100 ms: the 50 ms probe converges faster (t6 0.123 s vs
  0.211 s) but reads less history. Kill it (restore 100 ms) if any program
  under-reads by > 3 dB at the handoff.
- Boundary heuristic: if a live scroll still jumpscares (a boundary the
  events miss), add a soft reset on > 1.5 s of silence followed by a > 6 LU
  rise — audio-derived, still no preload.
- Quiet-after-loud dip: if the owner objects to the post-reset hold on a
  much quieter next video, add a bounded fast lift (+3 dB max, 0.3 s max)
  — only then, never speculatively.
- Cross-origin silence: media routed cross-origin without CORS stays
  silent by platform design; out of scope for this spec.

## 7. Risks

- Page-routed elements (`__tnWebAudio && !__tnAttached`) are deliberately
  unwatched by the boundary handler (accepted T2 deviation, T4 to review):
  page-created AudioContexts that bypass the hook never reset.
- `broadcastProgramReset` resets every live session, including unrelated
  page AudioContexts on the tab — over-reset is benign (continuity holds)
  but imprecise.
- Reused MSE/append-only elements that never fire `loadstart` may
  under-fire the reset; the next video then converges on the slow loop
  alone (no jumpscare protection for that handoff).
- No browser proof: Audio Safety bans audible/browser QA, so the offline
  harness is the automated gate and the owner's manual scroll is the live
  acceptance (UNVERIFIED in a browser).
- The A6 negative control is a guard-disabled variant (`FAST_ONSET_SECONDS = 2` in a temp copy) because HEAD 5.4.1 already contains the 0.1 s (100 ms) guard; the 0.05 s probe is the new chain. the variant must read above -6.0 dB at 0.5 s and does. This keeps the control able to go red without pinning a git revision.

## 8. Sources

Local: `audio/normalizer-worklet.js` (`FAST_ONSET_SECONDS`,
`FAST_ONSET_TC_SECONDS`, `resetProgram()`), `page-hook.js` (generation
tokens, `handleElementPlaybackStart`), `qa/loudness-verify.cjs` (ONSET),
`qa/feed-transition-qa.cjs`, `qa/program-boundary-qa.cjs`,
`docs/SPEC_COMFORT.md` (H5/A6 pre-feed record). Primary URLs actually
used: CORS silence
`https://webaudio.github.io/web-audio-api/#MediaElementAudioSourceOptions-security`;
preload advisory `https://html.spec.whatwg.org/multipage/media.html`;
worklet latency `https://www.w3.org/TR/webaudio-1.1/`; boundary events
`https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/load`;
`play()` after `ended` archival note
`http://lists.whatwg.org/pipermail/whatwg-whatwg.org/2009-March/061084.html`
(secondary); tabCapture
`https://developer.chrome.com/docs/extensions/reference/api/tabCapture`
and `https://developer.chrome.com/docs/extensions/how-to/web-platform/screen-capture`;
400 ms / 3 s windows
`https://www.itu.int/dms_pubrec/itu-r/rec/bs/R-REC-BS.1770-4-201510-S!!PDF-E.pdf`
and `https://tech.ebu.ch/docs/tech/tech3341.pdf`; muted autoplay
`https://developer.chrome.com/blog/autoplay/`. TikTok's loudness target:
UNVERIFIED (no primary source located).
