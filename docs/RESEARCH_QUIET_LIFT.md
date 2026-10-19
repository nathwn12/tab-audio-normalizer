# RESEARCH: Quiet-lift and step recovery — what loudnorm does, what the standards allow, and why holding is not required

Primary-source reference for the within-program quiet-lift fix (SPEC H6) shipping in release
5.4.1: sub-relative-gate passages are lifted by the levelling stage (slow-window level gate +
probe-gated AGC boost) instead of being held. Researched 2026-10-19.

**Scope rule.** Every finding carries its source and a confidence tag:

- **high** — read directly from the source (spec text or source code), or an absence checked
  against the fetched full texts.

Where a source was not read, that is said explicitly. Nothing here is a design proposal for
this repo beyond the implications stated at the end.

**No browser was launched.** Desk research only, per the repo's Audio Safety rule.

---

## 1. ffmpeg `loudnorm` holds passages below the relative gate — it does not lift them

**Claim.** In `loudnorm` dynamic mode (`libavfilter/af_loudnorm.c`), a passage above −70 LUFS
but below the −10 LU relative gate is HELD: `s->delta = prev_delta` (the previous frame's
delta is retained). The only lift path is the first-frame ramp when `above_threshold == 0`,
which steps `prev_delta *= 1.0058`. Frames: a 3 s first frame, then 100 ms frames, with
Gaussian smoothing σ = 3.5 over 21 taps. No program-gain attack/release constants are defined
anywhere in the filter.

**Source:** FFmpeg — `libavfilter/af_loudnorm.c`
<https://github.com/FFmpeg/FFmpeg/blob/master/libavfilter/af_loudnorm.c> (source read).

**Confidence: high (source read).**

## 2. EBU R 128 s4 and Tech 3343: no dialogue-to-program matching; raising dialogue is permitted

**Claim.** EBU R 128 s4 (items j/k/n) and Tech 3343 §9.4.2/9.4.3 together state: LDR ≤ 5;
dialogue-to-programme matching (LDR → 0) is forbidden; raising dialogue loudness up to the
target level is permitted; live processing is explicitly out of scope for the standard's
adaptation methods; and Tech 3343 §3.2's gradual integrated loop is the long-term safety net.

**Sources:** EBU R 128 s4 (2023) — <https://tech.ebu.ch/docs/r/r128s4.pdf>; EBU Tech 3343 —
<https://tech.ebu.ch/docs/tech/tech3343.pdf>.

**Confidence: high.**

## 3. AES TD1008 v3.13: upward compression preferred; no step-recovery time is published

**Claim.** AES TD1008 v3.13 states that "Upward compression is the preferred approach for
raising low level passages", and places classical-music dialogue 3–6 LU below the loudest
parts. No ±10 LU step-recovery time appears anywhere in TD1008, EBU Tech 3343, or EBU R 128
s4 — the step bound is not a published one.

**Source:** AES TD1008 v3.13 —
<https://aes.org/wp-content/uploads/2024/01/20210924_TD1008_v3.13.pdf>.

**Confidence: high for the absence in the fetched full texts.**

## 4. Implications for this codebase

- Holding sub-relative-gate passages is `loudnorm`'s implementation choice, **not a standard
  requirement**: no located source forbids raising them, and TD1008 prefers upward
  compression for exactly this case (finding 3).
- The H6 fix (slow-window level gate + probe-gated AGC boost; see SPEC H6) is the
  standards-consistent resolution: it raises sub-relative-gate passages without
  dialogue-to-program matching (finding 2's forbidden LDR → 0).
- The step gate (back within ±1.0 LU of target, SPEC H2) remains a **house bound** — no
  published step-recovery number exists (checked TD1008, Tech 3343, R 128 s4, finding 3).
