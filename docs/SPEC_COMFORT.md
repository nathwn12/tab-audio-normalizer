# SPEC: comfort loudness chain

Status: frozen. Judge the chain against this document.

## 1. Outcome

Every tab converges to one program target. Within a program, quiet
passages rise and loud passages fall, bounded. A program already inside
the bound is left alone.

In the owner's own words, quoted verbatim: "turn the quiet parts louder,
and the louder parts quiet"; "a HUMAN COMFORT loudness, always, and
consistent". The rejected design's failure report, quoted verbatim:
"loud videos stay loud", "the quiet parts are even enhanced for it",
"my ears are equally fucked".

## 2. Scope

This spec covers the worklet comfort chain only: gated loudness
measurement, within-program levelling, slow program gain, user trim
staging, and the true-peak limiter. It covers every site with one
algorithm; sites are verification coverage, never configuration.

Program target: −20 LUFS, fixed.

## 3. Current evidence

The −20 LUFS target rests on this evidence: it sits inside the owner's
original documented band (−23.5…−18 LUFS, centre ≈−20.75, from the
repo's own CHANGELOG 5.2.0 and README history); inside EBU R 128 s2's
streaming window (−20.0…−16.0); ~6 LU below the ≈−14 the platforms
serve, which leaves the levelling stage headroom before the ceiling;
1 LU from EBU R 128 s4's own worked cinematic example (−21 LUFS); and
it is the value already implemented and already converging across
programs at both sample rates (tails at exactly −20.00).

## 4. Requirements, sourced

Each clause carries its source. A clause without a source is not here;
it is in section 5.

S1. The user trim sits inside what the true-peak detector measures.
Apply every gain the output carries before the detector measures the
sample and before the sample enters the delay line. Sources: ffmpeg
`loudnorm` multiplies gain and offset into `limiter_buf`, the buffer
that is both delay line and detector input
(`libavfilter/af_loudnorm.c`, `INNER_FRAME`/`FIRST_FRAME`/`FINAL_FRAME`;
docs: "Gain is applied before the true-peak limiter.",
<https://ffmpeg.org/ffmpeg-filters.html#loudnorm>); EBU Tech 3344
places the volume control before the limiter (§6.9 / Figure B.5) and
places an offset gain in front of loudness analysis (§6.10,
<https://tech.ebu.ch/docs/tech/tech3344.pdf>).

S2. The adaptation gate is a dead band. Inside ±`target_lra`/2 of the
program the levelling gain collapses to the static integrated gain: no
adaptation is applied at all inside the band. Outside the band the
correction saturates at ±`target_lra`/2. Sources: ffmpeg `loudnorm`
`INNER_FRAME` (`env_global` collapses to `shortterm − global`, i.e.
static gain, inside the band); EBU R 128 s4 clauses (j) and (k) give
the standard's one-shot form, LDR ≤ 5 LU
(<https://tech.ebu.ch/docs/r/r128s4.pdf>).

S3. No flattening. Never raise quiet material to match program
loudness (LDR = 0). Inside the bound, perform no adaptation at all:
clause (k) is a gate, not a ceiling on how much adaptation is allowed.
Source: EBU R 128 s4 clause (k) ("if the Loudness-to-Dialogue Ratio
… is within 5 LU, no dynamic adaptation needs to be performed") with
its explicit prohibition on matching Dialogue to Programme loudness.

S4. Recovery from a level step comes from the AGC stage, not from the
averaged loop and not from the limiter. The levelling stage answers a
step on its measurement window (~3 s short-term window, ~2.1 s
Gaussian smoothing in `loudnorm`). The 30 s–2 min averaged loop is a
long-term tool and does not catch steps; the limiter bounds peak only,
never loudness. Sources: `af_loudnorm.c` (3 s window, 100 ms
subframes, 21-tap Gaussian smoothing); AES Loudness Normalization
(rolling average "between 30 seconds to two minutes", "Longer
integration times usually yield natural-sounding loudness
normalization results"); limiter peak-only per AES ("Peak limiting is
provided since gain may be applied"), `loudnorm` (limiter targets
maximum true peak only), EBU R 128 s2 clause k, EBU R 128 s4 clauses
(l)/(m), and the published Spotify limiter (−1 dB sample, 5 ms attack,
100 ms decay).

S5. True peak never exceeds −1 dBTP. Hard-clip count is 0. Sources:
EBU R 128, AES TD1006/TD1008 and Apple (−1 dBTP); AES TD1008 (§1.2)
and EBU R 128 s2 clause k for the limiter-ceiling rule.

## 5. Requirements, ours

No source publishes a number for anything in this section. These are
house targets, not standards. Do not cite them as standards.

H1. No residual-spread floor. The chain asserts no minimum on residual
dynamic range. EBU Tech 3343 states it is "impossible and not useful
to define a strict limit for LRA" and sets no maximum permitted LRA;
no located source sets a minimum either. A flat but compliant program
may therefore measure arbitrarily low residual spread without failing
this spec.

H2. Settling after a level step. After a sustained ±10 LU program step,
output short-term loudness returns to within ±1.0 LU of the target
within 10 s and stays there. No source states a permitted overshoot or
settling time; this bound is a house choice.

H3. Trim slew. Every trim change completes within one 128-frame render
quantum as a per-sample ramp. No block-rate gain step reaches the
output. No source states a slew constant for a user trim; this bound
is a house choice.

H4. Tolerances. Program-level clauses in section 7 pass within ±1.0
LU; spread clauses pass within ±0.5 LU. These tolerances are house
choices. (EBU R 128 publishes ±1.0 LU as a broadcast live-delivery
tolerance; that governs delivery QC, not this chain, so the numbers
here stay in this section.)

H5. Cold-start onset convergence. Before the first gated levelled
block the session is cold and the slow loop has no measurement. While
cold, a cut-only pre-cut driven by a ~100 ms levelled power probe,
slewed with a fast ~0.12 s log-domain time constant and ratcheting
down only, cuts a loud onset toward the target from the start; the
slow loop then takes over from the current gain with no snap
(continuous handoff), and the guard never boosts, so a quiet onset is
not moved. Measured offline 2026-10-19 on a loud onset from cold: the
pre-guard chain was −1.55 dB down at 0.5 s (time to −6 dB 0.949 s);
the guard reads −9.30 dB at 0.5 s, −9.70 dB at 1.0 s, settled −10.00;
the quiet onset moves 0.000 dB. No source publishes a cold-start
number; this is house wiring and these numbers stay house.

H6. Within-program lift of sub-relative-gate passages. Passages above
−70 LUFS but below the −10 LU relative gate are lifted by the
levelling stage, not held. Two gates make the lift land: within the
slow loop's 30 s window only the blocks whose level lies within
[−6, +15] LU of the current level count (`SLOW_LOCK_LO_DB` /
`SLOW_LOCK_HI_DB`), and the AGC's boost applies only while the ~0.1 s
levelled probe is itself below the programme mean's dead-band edge —
without those gates a loud passage pinned a quiet passage's mean and
the AGC's boost lagged a loud return. Measured offline 2026-10-19 on
the dialogue fixture: the quiet section rises +6.74 dB and the tail
sits at −20.00 LUFS. AES TD1008's "Upward compression is the
preferred approach for raising low level passages" is directional
backing, recorded in `docs/RESEARCH_QUIET_LIFT.md`; no source
publishes these numbers, so they stay house.

## 6. Failure behavior

Silence holds the last gain; it never re-targets on noise. Gain
pressure against the ceiling sheds into the limiter; the ceiling
clauses in S5 hold under maximum trim. A trim outside
−12…+12 dB is ignored.

## 7. Acceptance evidence

Measure every clause against the ffmpeg EBU R 128 oracle on captured
output buffers. Each clause names its fixture, its window, and its
threshold.

A1. Program convergence. Fixtures: steady programs at −30, −20, and
−12 LUFS, at 44.1 kHz and 48 kHz. Window: gated integrated loudness
over the full program, oracle-measured. Threshold: every program lands
at −20 LUFS within ±1.0 LU (H4); tails read exactly −20.00.

A2. Within-program levelling. Fixture: a program with quiet passages
≈12 LU below loud passages. Window: oracle LRA plus per-section
integrated loudness before and after. Threshold: residual spread ≤ 5
LU (EBU R 128 s4 (j)); quiet sections rise, loud sections fall; boost
stays within the published Dolby maxima (Film 6 dB, Music 12 dB,
Speech 15 dB) and cut stays near-limiting (20:1, standard profiles).

A3. In-bound program untouched. Fixture: a program whose spread is
already ≤ 5 LU. Window: oracle LRA and section dynamics before and
after. Threshold: levelling term 0 dB inside ±2.5 LU of program (S2);
output spread equals input spread within ±0.5 LU (H4).

A4. Ceiling under trim. Fixture: a near-ceiling transient burst, with
the trim at 0 dB and at +12 dB. Window: oracle true-peak over the
burst plus hard-clip counter. Threshold: ≤ −1 dBTP, 0 clips in both
trim cases (S1, S5).

A5. Step recovery. Fixture: 60 s of quiet program followed by 30 s
≈10 LU louder. Window: output short-term loudness sampled each second
after the step, oracle-measured. Threshold: back within ±1.0 LU of
target within 10 s (H2), driven by the AGC stage (S4).

A6. Cold-start onset. Fixture: a loud onset from a cold session
(comfort-loud); controls: a quiet onset (comfort-quiet) and digital
silence. Window: the applied-gain trace over the first second after
the onset, plus the settled tail, measured on captured output.
Threshold: the onset is cut toward the target from the start (H5);
the quiet onset is not moved; silence stays bit-zero. Measured
offline 2026-10-19: pre-guard chain −1.55 dB at 0.5 s (time to −6 dB
0.949 s); guard −9.30 dB at 0.5 s, −9.70 dB at 1.0 s, settled −10.00;
quiet onset 0.000 dB. Gate: the ONSET section of
`qa/loudness-verify.cjs`, including the negative control (the
pre-change worklet must fail the 0.5 s bound).

A7. Quiet-passage lift and step recovery. Fixtures: comfort-dialogue
(spread and quiet lift) and comfort-step (60 s quiet then 30 s ≈10 LU
louder), both sample rates. Window: section RMS spread and quiet rise
for the dialogue; output short-term loudness sampled after the step;
oracle-measured. Threshold: the quiet section rises without
dialogue-to-program matching (S3) and the tail meets the target; the
step returns within ±1.0 LU (H2/H4). Measured offline 2026-10-19:
spread reduction 12.77 dB (in 26.02 → out 13.25), quiet rise
+6.74 dB, the level stage engaged, tail −20.00 LUFS; step ST@70
−20.40 LUFS (delta −0.40, tolerance ±1.0). Gate: the LEVEL and STEP
sections of `qa/loudness-verify.cjs`.

## 8. Controls

For each acceptance clause, evidence includes one case the change
must FIRE on and one case it must NOT change. A control that cannot
fail is not a control.

- A1 FIRES on the −30 and −12 LUFS fixtures; it does NOT move the
  −20 LUFS fixture beyond ±0.5 LU.
- A2 FIRES on the 12 LU-spread fixture; it does NOT alter a ≤ 5 LU
  fixture beyond ±0.5 LU.
- A3 FIRES on a passage just outside the band (it adapts); it does
  NOT touch a passage inside the band.
- A4 FIRES on the burst with +12 dB trim (the detector sees the trim,
  S1); the same burst at 0 dB trim also passes, proving the limiter
  holds in both stagings.
- A5 FIRES on the 60 s/30 s step; a steady program shows no pumping
  (gain stable within ±0.5 LU), proving the slow loop is not chasing
  itself.
- A6 FIRES on the loud onset from cold (cut to −9.30 dB by 0.5 s);
  the quiet onset is unchanged (0.000 dB) and silence stays zero.
- A7 FIRES on the dialogue spread (quiet rise +6.74 dB) and on the
  60 s/30 s step; the no-pump control stands at 0.00 dB, proving the
  slow loop and AGC are not chasing each other.

Two controls are banned because review already caught them proving
nothing. A constant-tone zero-LRA signal must never serve as the "no
adaptation" control: it stays at zero spread under any compression, so
it passes with or without the gate. A token-presence check (asserting
that limiter, gate, or trim code exists) must never stand in for a
behavioral measurement.

## 9. Exclusions

No per-site special cases: the algorithm is general, and site
coverage never becomes configuration. DRM/EME-protected audio and
WebRTC audio are structurally unreachable and out of scope. The
persistence layer (per-site records, migration, sequencing) is
untouched by this spec.

## 10. Verification limits

The worklet's behavior is proven offline only: in a Node `vm` harness
driving `process()` on synthetic buffers, and through the ffmpeg
oracle. The engine's in-browser audio path has not been observed. The
repo's Audio Safety rule is what prevents that observation, and this
spec does not authorize breaching it.

## 11. Risks and decisions

The live chain measures the levelled signal with the slow loop while
the levelling gain stays feedforward from raw input only, so the loops
cannot chase each other; the published offline order (level, then
normalize) is the constraint and the live wiring is the judgment. EBU
Tech 3343 prefers offline/iterative adaptation over live processing; a
browser tab cannot pre-pass, so this chain is the live approximation.
Dialogue-gated LDR cannot be measured without dialogue isolation, so
the oracle LRA plus section spread is the proxy, and it is named as a
proxy, never as LDR.
