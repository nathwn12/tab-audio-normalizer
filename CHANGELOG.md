# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [5.4.2] - 2026-10-21

### Fixed

- Per-video feed jumpscare: a new video in a scroll feed no longer starts
  on the previous video's stale measurement. The page hook detects program
  boundaries (new element, `loadstart`/`emptied`/`ended`-then-`play`, dirty
  same element; pause/resume, seek, and stall stay continuity) and sends one
  `reset-program` per live session; the worklet folds AGC into the slow gain
  so the next video starts at the previous video's settled gain with no snap.
- Carry-over cold gain: after the reset the cut-only branch
  (`desired = min(slow, probe)`) re-levels from a fresh probe, so a ~6 dB
  louder next video lands within 1.5 dB of its own settled gain by 250 ms
  (+0.49 dB measured) and 0.5 dB by 500 ms (+0.07 dB); same-loudness moves
  −0.00 dB; quiet next videos see no boost (+0.00 dB).
- Cold probe is now ~50 ms with a fast ~0.08 s log-domain slew (was ~100 ms
  / ~0.12 s): time to −6 dB 0.211 s → 0.123 s; −9.57 dB at 0.3 s, −9.90 dB
  at 0.5 s, settled −10.00; quiet onset untouched (0.000 dB).

### Added

- `reset-program` worklet contract (generation-token idempotent reset;
  AGC fold, meter/probe clear, audio-path preserve; never reset at attach
  time) — see `docs/SPEC_FEED.md`.
- `qa/feed-transition-qa.cjs` (F1–F6 transition harness, 11/11 rows PASS,
  including the delayed-duplicate-after-resume row) and
  `qa/program-boundary-qa.cjs` (page-hook handoff, 13/13 rows PASS,
  generations [1–7], overlap rows 11–13); the release gate's ONSET −6 dB
  check stays at 0.5 s and its negative control is a guard-disabled
  variant (must read above −6.0 dB at 0.5 s, reads −1.55 dB).

## [5.4.1] - 2026-10-19

### Changed

- Startup is seamless: a silence-until-routed attach guard mutes a media element
  until its graph is routed (1.5 s fallback restores its previous muted value;
  on failure the element plays raw as before), the media session (AudioContext +
  AudioWorklet module + node) is pre-warmed before the first media element
  plays, and a cold-start, cut-only onset guard driven by a ~100 ms levelled
  power probe with a fast ~0.12 s log-domain slew hands over continuously to the
  slow loop — so a loud onset is cut toward the target from the start instead of
  passing uncut for ~400 ms. Measured 2026-10-19 on comfort-loud: the old chain
  was still only −1.55 dB down at 0.5 s (−6 dB not reached until ~0.95 s); the
  guard reads −9.3 dB by 0.5 s, −9.7 dB by 1.0 s, settled −10.00, never deeper
  than settled + 1.5 dB, and quiet onsets are untouched.
- Within-program levelling is now a dead-band AGC on the raw input
  (mechanism: ffmpeg `loudnorm` `INNER_FRAME` — inside ±2.5 LU of the program
  no adaptation is applied at all, per EBU R 128 s4 clause k; outside, the
  short-term spread is compressed back to the band edge), replacing the Dolby
  Film Standard static curve. Boost capped at the published +6 dB Film max;
  the +12/−20 dB clamp still binds the total program gain. The 4-LU varying
  program keeps its range; the 12-dB pair lands near
  the LDR ≤ 5 LU outcome.
- The user trim is now written into the limiter delay line before the
  detector (ffmpeg `loudnorm` offset topology, EBU Tech 3344 device order),
  so a trim change can no longer punch through the true-peak ceiling. It
  takes effect after the 5 ms lookahead flushes instead of in the same
  render quantum.

### Removed

- Blast Guard, entirely (owner-directed): the popup control `#blast-guard`, the
  per-site record field `blastGuard`, the hook message `SET_BLAST_GUARD`, and
  the worklet's `set-blast-guard` inbound with its −2 dBTP ceiling, clamps,
  release and hold. The single −1 dBTP true-peak ceiling remains. Legacy
  per-site records that still carry `blastGuard` read cleanly — the field is
  ignored and dropped on the next write.

### Fixed

- Quiet-passage lift and level-step recovery are fixed: the dialogue
  fixture's quiet section rises +6.74 dB, its spread shrinks 12.77 dB
  (26.02 → 13.25), the tail sits at −20.00 LUFS, and the step lands at
  −20.40 LUFS (delta −0.40, tolerance ±1.0) — verified offline in
  qa/loudness-verify.cjs (release gate).
- Trim-step ceiling punch-through (silence, burst, then +12 dB trim):
  was +1.6 dBTP with rail hits; now at or below the ceiling with zero rail
  hits at both sample rates.
- Level-step recovery (60 s quiet then 30 s loud) no longer rides hot for
  seconds; the measured outcome under the release gate is in the Fixed entry
  above (ST@70 -20.40 LUFS, delta -0.40, gate +-1.0 LU).

## [5.4.0] - 2026-10-18

### Changed

- Human-comfort loudness chain in `audio/normalizer-worklet.js`: the
  program target is now FIXED at −20 LUFS (a judgment inside the published
  −20.0 to −16.0 LUFS window — EBU R 128 s2 interim; AES TD1008 speech −18 /
  music −16 — below the platforms' ≈−14 so the levelling stage has headroom,
  and corroborated within 1 dB by EBU R 128 s4's own cinematic remedy, which
  lands program loudness at −21 LUFS).
- New within-program levelling stage, always on: the Dolby Film Standard DRC
  static curve (6 dB max boost below −43 dB, 2:1 boost −43 to −31 dB, 5 dB
  null −31 to −26 dB left untouched, 2:1 early cut −26 to −16 dB, 20:1 cut
  above −16 dB) driven feedforward by a fast peak envelope (3 ms attack,
  250 ms release). The curve keeps its published absolute thresholds — the
  null band is anchored at absolute −31 to −26 dBFS and is NOT re-anchored to
  measured program loudness (the extension cannot measure dialogue, and
  program loudness is not dialogue). Correctness is judged by outcome
  (program → −20, range reduced toward LDR ≤ 5 LU), not by the thresholds.
- The user slider is now an immediate output trim, separate from the target:
  it ramps per sample within one render quantum, never moves the target, and
  never perturbs the integrated measurement. It is written into the delay
  line before the detector, so the −1 dBTP ceiling (−2 dBTP Blast Guard)
  holds at any slider position (the change takes effect after the 5 ms
  lookahead flushes).
- Two loops in the published order with anti-maximizer bounds (LDR ≤ 5 LU;
  short-term ≤ program + 5 LU), a final true-peak limiter, and `set-mode`
  retained for compatibility (both modes run the same comfort chain).
- Live compromise stated plainly: EBU Tech 3343 §9.4.2 prefers offline,
  iterative dynamics adaptation over live processing, and a browser tab cannot
  do a pre-pass — this chain is the live approximation, not offline-grade.

### Fixed

- Loud programs with quiet dialogue no longer sit against the average: the
  levelling stage pulls loud passages down and lifts quiet ones up before the
  slow loop measures, so "loud videos stay loud" and "the quiet parts are
  enhanced" are both addressed at the cause instead of the average.

## [5.3.0] - 2026-10-18

### Changed

- Rewrote `audio/normalizer-worklet.js` as a gated ITU-R BS.1770-4 / EBU R128
  loudness normalizer: exact K-weighting (libebur128 `ebur128_init_filter`
  constants), 400 ms blocks at 75% overlap, an absolute gate at −70 LUFS then
  a relative gate at −10 LU, gain driven only by the gated integrated value
  toward −18 LUFS, the ReplayGain 2.0 reference loudness (slow asymmetric
  slew; `set-gain-db` shifts the target instead of adding gain on top, fixing
  a bug where the user gain was applied twice, so the slider delivers the
  ±12 dB it advertises), and a 4x-oversampled true-peak lookahead limiter
  holding output at or below −1 dBTP (−2 dBTP under Blast Guard) with a
  1.0 dB detector margin sized from the measured worst-case end-to-end under-read against the ffmpeg ebur128 oracle (0.51 dB on a steady full-scale 11.025 kHz tone; transient bursts within 0.21 dB), covering the BS.1770-4 4x under-read bound. Adds
  `set-target-lufs` / `set-mode` (normalize|level with a −20 dBFS 3:1
  compressor) / `reset-meter` inbound and `meter` + `this.telemetry`
  outbound; the old exponential-window gain-riding scheme is deleted.
  Verified offline in Node against ffmpeg's EBU R128 implementation: every
  fixture measures within ±0.1 LU per EBU Tech 3341 with true peak at or
  below the ceiling — the harness lives in the gitignored `qa/` directory,
  so a fresh clone cannot run it and CI does not cover it.


### Fixed

- Persistence is per-site top-level storage records (`site:<siteKey>` holding enabled/gainDb/blastGuard/seq/mirror in ONE write) with the background as the single writer: the popup sends field-level intents (`set` with ONLY the changed field) and the background applies the intent's fields to the live record and writes the whole record back in one `set` (whole-record read-modify-write), bumping the per-site `seq` audit counter; ordering is last-accepted-write-wins with the sequence kept as audit only and nothing ever rejected on ordering grounds. Document messages are frame-targeted (`frameId: 0` with a named `siteKey` provenance check) so one site never resets another frame. Fixed the `chrome.storage.local.get({'key': undefined})` marshalling defect (an object-form `undefined` default is dropped by the extension API JSON marshal, returning `{}` even when the key exists) by using the array form. Legacy migration is lossless (legacy keys normalised before matching so `www.`-only entries survive, an explicit `siteToggles` boolean wins `enabled`, `activeSites` cleared only for consumed entries) and the recurrence path is closed (the whole-map `siteToggles` mirror writer is deleted, so product code can no longer rewrite `siteToggles`/`siteSettings`).

## [5.2.0] - 2026-10-02

### Added

- Per-site loudness normalisation to EBU R128 (superseded by the gated integrated normaliser in 5.3.0).
- True-peak limiter with a -1 dBTP ceiling, plus the Blast Guard mode for stricter peak protection.
- AudioWorklet processing via content-script injection, with SPA navigation detection and service-worker restart recovery.
- Per-hostname Active toggle that persists across tabs.
- Early normalizer tuning work, superseded by the gated integrated normaliser in 5.3.0.
