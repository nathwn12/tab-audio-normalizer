# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Within-program levelling is now a dead-band AGC on the raw input
  (mechanism: ffmpeg `loudnorm` `INNER_FRAME` — inside ±2.5 LU of the program
  no adaptation is applied at all, per EBU R 128 s4 clause k; outside, the
  short-term spread is compressed back to the band edge), replacing the Dolby
  Film Standard static curve. Boost capped at the published +6 dB Film max;
  the +12/−20 dB clamp (+6/−24 dB Blast Guard) still binds the total program
  gain. The 4-LU varying program keeps its range; the 12-dB pair lands near
  the LDR ≤ 5 LU outcome.
- The user trim is now written into the limiter delay line before the
  detector (ffmpeg `loudnorm` offset topology, EBU Tech 3344 device order),
  so a trim change can no longer punch through the true-peak ceiling. It
  takes effect after the 5 ms lookahead flushes instead of in the same
  render quantum.

### Fixed

- Trim-step ceiling punch-through (silence, burst, then +12 dB trim):
  was +1.6 dBTP normal / +0.6 dBTP Blast Guard with rail hits; now at or
  below both ceilings with zero rail hits at both sample rates.
- Level-step recovery (60 s quiet then 30 s loud) is now caught by the ~3 s
  AGC stage instead of riding hot for seconds: within ±2 LU of target from
  ~3 s after the step, settled tail on target.

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
