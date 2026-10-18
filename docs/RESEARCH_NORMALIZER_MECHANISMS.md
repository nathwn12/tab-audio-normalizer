# RESEARCH: The three mechanisms a comfort normaliser gets wrong — limiter gain staging, the levelling gate, and the adaptation rate

Companion to `docs/RESEARCH_COMFORT_NORMALIZER.md` and `docs/RESEARCH_LOUDNESS.md`. Those two files
already establish, from primary sources: the BS.1770 measurement chain and true-peak under-read bound;
the EBU R 128 / ATSC A/85 / streaming targets; the published DRC profiles with their numbers; the
two-loop structure (slow absolute gain + faster within-program levelling + limiter); the anti-maximiser
bounds; the comfort-target family; the frequency-domain verdict; and the instant-slider distinction.
**This file restates none of it.** It cites those files by section and adds only what they do not cover:
the three *mechanisms* an implementation has to get mechanically right, each of which the existing
documents leave at "the standards fix the structure and leave the detail to the encoder":

1. **Gain staging with a lookahead true-peak limiter** — where a user/output gain belongs relative to a
   detector that schedules gain ahead of the samples it has already seen.
2. **Gating within-program levelling** — how "within 5 LU, no adaptation" (EBU R 128 s4 clause k) is
   turned into a mechanism by implementations that cannot isolate dialogue.
3. **The adaptation rate** — the attack/release time constants a consumer normaliser is documented or
   implemented with, and which stage is supposed to catch a sudden level step.

**Scope rule.** Every number carries a URL and a verbatim quote. Reference-implementation behaviour is
quoted from the source; where a source implements a mechanism but does not explain it, that is said
explicitly and the code is cited. Where the documentation is silent, this file says **"the documentation
does not state this"**. Nothing here is a design proposal for this repo and nothing here is code.

**Why a companion file and not new sections of `RESEARCH_COMFORT_NORMALIZER.md`.** Two reasons.
(1) Classification: that file is the *design/target* reference (which numbers, which profiles, which
ordering), while these three items are *implementation mechanisms* — what the detector must see, how a
gate is wired, what the time constants are. It is the same split the repo already uses between
`RESEARCH_LOUDNESS.md` (measurement/runtime) and `RESEARCH_COMFORT_NORMALIZER.md` (design).
(2) Safety: another worker was editing `audio/`, `qa/`, `tests/` and parts of `docs/` while this was
written; `docs/RESEARCH_LOUDNESS.md` moved at 20:01 and this file was written from 20:45. A new file
under the `docs/` UPPER_SNAKE convention removes any write contention. Both files follow the repo's
`RESEARCH_*.md` companion pattern (`RESEARCH_MV3_STATE.md`, `RESEARCH_COMFORT_NORMALIZER.md`).

**The symptoms these three questions come from.** An implementation under test has, measured:
(a) a burst already inside the limiter's lookahead, then a `+12 dB` output trim, produces **+1.6 dBTP
with 20 exact clip-rail hits** — both ceilings breached by ~2.6 dB — while the same burst with the trim
unchanged gives **−1.9 dBTP and zero clips**; (b) a program whose loudness varies 4.0 LU comes out with
**LRA 0.3 LU**; (c) 60 s of quiet followed by 30 s of loud leaves **eight seconds at −10.3 LUFS**, 3.2 LU
above target and still unsettled. This file is the published mechanism for each.

---

## 1. Gain staging with a lookahead true-peak limiter

### 1.1 The defect stated as a topology fact

The failing implementation applies a user output trim **after** its delay line, while its true-peak
detector schedules gain for the **undelayed incoming** samples. That combination is the one topology in
which a limiter's ceiling cannot hold: the detector computes gain reduction from a signal that does not
contain the trim, but the trim is multiplied in later, so `ceiling / peak` bounds a signal that is not
the one leaving the node. The empirical result above (+1.6 dBTP, clip-rail hits) is the arithmetic of
that, not a tuning error.

The published answer is uniform across every reference implementation and standard located: **a gain
that the output will carry must be applied before the detector measures the signal, i.e. on the same
samples that the detector examines and that the delay line carries.** Below is where each source does it,
followed by the general principle and the runtime-change question.

### 1.2 Reference-implementation topology — every source, quoted

#### ffmpeg `loudnorm` — the offset is *inside* the limiter buffer and the detector

The user-facing option is documented explicitly as pre-limiter. FFmpeg Filters Documentation,
*loudnorm* (<https://ffmpeg.org/ffmpeg-filters.html#loudnorm>), on the `offset` option:

> "Set offset gain. **Gain is applied before the true-peak limiter.**"
> "Range is -99.0 - +99.0. Default is +0.0."

The filter's headline states the split between the two modes and the oversampled detector:

> "EBU R128 loudness normalization. Includes both dynamic and linear normalization modes. … This
> algorithm can target IL, LRA, and maximum true peak. **In dynamic mode, to accurately detect true
> peaks, the audio stream will be upsampled to 192 kHz.**"

The source shows *why* that documentation sentence is what it is. In `libavfilter/af_loudnorm.c`
(<https://github.com/FFmpeg/FFmpeg/blob/master/libavfilter/af_loudnorm.c>), the AGC gain **and** the
offset are multiplied together into `limiter_buf` — the buffer that is simultaneously the lookahead
delay line and the detector's input — and `true_peak_limiter()` then reads and limits from that same
buffer:

- `config_input()`: `s->offset = pow(10., s->offset / 20.);` — the offset is a linear multiplier.
- `INNER_FRAME`: 
  ```c
  limiter_buf[s->limiter_buf_index + c] = buf[s->buf_index + c] *
      (gain + (((double) n / in->nb_samples) * (gain_next - gain))) * s->offset;
  ```
- `FIRST_FRAME` and `FINAL_FRAME` contain the same `* s->offset` term.
- `true_peak_limiter()` takes `ceiling = s->target_tp;`, runs `detect_peak()` over `s->limiter_buf`, and
  applies the computed `gain_reduction` back into `buf` (= `s->limiter_buf`); it then emits
  `out[c] = buf[index + c]` and clips to `ceiling`.

So the offset is added **before** the detector sees the sample and before the sample is delayed; the
detector's `ceiling / peak_value` therefore measures a signal that already contains the offset.

`loudnorm` even enforces the ceiling for that gain in its mode-selection and single-pass setup:

- `init()`: linear mode is chosen only when the offset still fits —
  ```c
  offset    = s->target_i - s->measured_i;
  offset_tp = s->measured_tp + offset;
  if ((offset_tp <= s->target_tp) && (s->measured_lra <= s->target_lra)) {
      s->frame_type = LINEAR_MODE; s->offset = offset;
  }
  ```
- `FIRST_FRAME`: the single-pass offset is reduced so the peak fits —
  ```c
  offset    = pow(10., (s->target_i - global) / 20.);
  offset_tp = true_peak * offset;
  s->offset = offset_tp < s->target_tp ? offset : s->target_tp / true_peak;
  ```
- `LINEAR_MODE` applies the offset and runs no limiter (`dst[c] = src[c] * s->offset;`) precisely
  because that branch is only reachable when `offset_tp <= s->target_tp`.

The filter's author documents the intent in his own write-up of the reference implementation,
*loudnorm* (<https://k.ylo.ph/2016/04/04/loudnorm.html>; **labelled here as the implementer's own
documentation, corroborated by the source above, not a standard**):

> "The loudnorm filter consists of a **specially designed loudness-tuned AGC followed by a transparent
> look-ahead true peak limiter**."

> "This **linear offset gain is pre-limiter, so it will not affect your true peak value. Maximum true
> peak is always guaranteed.**"

> "The limiter uses a 100 ms look-ahead, which allows it to calculate and use the absolute minimum
> amount of gain reduction required, as well as react before each peak takes place."

#### ffmpeg `alimiter` — input gain before the detector, output gain *after* the limiter

`alimiter` is the cleaner demonstration, because it separates the two gains and shows what each one is
worth. FFmpeg Filters Documentation, *alimiter*
(<https://ffmpeg.org/ffmpeg-filters.html#alimiter>):

> "The limiter prevents an input signal from rising over a desired threshold. **This limiter uses
> lookahead technology** to prevent your signal from distorting. It means that there is a small delay
> after the signal is processed. Keep in mind that the delay it produces is the attack time you set."
> "level_in — Set input gain. Default is 1."
> "level_out — Set output gain. Default is 1."

In `libavfilter/af_alimiter.c`
(<https://github.com/FFmpeg/FFmpeg/blob/master/libavfilter/af_alimiter.c>), `level_in` is multiplied into
the sample **before** it is written to the buffer, and the peak that drives the limiter is measured from
that written sample:

```c
double sample = src[c] * level_in;
buffer[s->pos + c] = sample;
peak = FFMAX(peak, fabs(sample));
```

The output gain, by contrast, is applied **after** the limiter's gain and its hard ceiling clip:

```c
dst[c] = av_clipd(dst[c], -limit, limit) * level * level_out;
```

Consequence, read off the code: `level_in` is *inside* the detector's view (so the ceiling holds
relative to the gained signal), while `level_out` is *outside* it — it scales the already-limited output
and therefore is not bounded by `limit`. `alimiter`'s options also carry
`AV_OPT_FLAG_RUNTIME_PARAM` (`#define AF AV_OPT_FLAG_AUDIO_PARAM | AV_OPT_FLAG_FILTERING_PARAM |
AV_OPT_FLAG_RUNTIME_PARAM`, and the filter sets `.process_command = ff_filter_process_command`), i.e.
`level_out` is a real-time-settable output gain that does **not** preserve the ceiling — see §1.5.

#### ffmpeg `acompressor` — the same topology, and why it differs for a compressor

`acompressor` (implemented in `libavfilter/af_sidechaincompress.c`,
<https://github.com/FFmpeg/FFmpeg/blob/master/libavfilter/af_sidechaincompress.c>) has an input gain and a
makeup gain. The docs state the makeup is "made up afterwards":

> "The overall reduction of the signal can be **made up afterwards** with the makeup setting."
> "level_in — Set input gain. Default is 1."
> "makeup — set make up gain. … Default is 1."

The code confirms: the detector sees the input gain
(`abs_sample = fabs(scsrc[0] * level_sc)`; for `acompressor`, `level_sc` is passed as `level_in` — see
`acompressor_filter_frame()` calling `compressor(s, src, dst, src, …, s->level_in, s->level_in, …)`),
and the makeup is applied outside the gain computation:

```c
dst[c] = src[c] * level_in * (gain * makeup * mix + (1. - mix));
```

**Read this as a contrast, not a counterexample.** A compressor has no ceiling to enforce, so its makeup
gain is correctly post-detector. The moment the stage has a ceiling (a limiter), an output gain is a
ceiling-breaking act unless the detector saw it — which is exactly the loudnorm/alimiter split above.

### 1.3 The published *device* topology — the user gain precedes the limiter

EBU Tech 3344, *Guidelines for Distribution and Reproduction in accordance with EBU R 128* (v2.1, 2016,
<https://tech.ebu.ch/docs/tech/tech3344.pdf>), is the standard that puts the limiter and the user gain in
a fixed order. In §6.9 ("Audio processing in mobile devices"):

> "it is strongly recommended that equipment like that has a **volume control stage** shown in Figure B.5
> with a range that includes sufficient positive gain to allow a Target Level of −23 LUFS. **A limiter
> after the positive gain circuit but before the digital to analogue converter and headphone output
> prevents distortion due to numerical overload.**"

The Figure B.5 block list states the same order for the Personal Music Player signal chain:

> "File media or streaming source … **Volume control** … **(True) Peak limiter @−1 dBTP**" → "Stereo D-A
> converter & output to loudspeaker(s) & headphones".

And §6.2 Note 1 (Home Theatre Equipment) puts a True Peak limiter on a gain stage the same way:

> "Signals from other sources **shall have a gain of +8 dB applied to the stereo outputs** … Distortion
> due to numerical overload can be prevented by a **True Peak limiter** as shown in the same figure."

The same document states the general rule for any manual offset in the loudness-matching path (§6.10,
DAB/DAB+/FM receivers):

> "if the manufacturer wishes to implement an offset gain setting for DAB, it is strongly recommended to
> **place it in front of the block 'Loudness & sync analysis'.** The alignment for FM radio will
> subsequently follow this manual gain offset automatically."

i.e. a user/offset gain is placed **upstream** so that every downstream stage — measurement and
limiting — sees it. §6.14 adds the fallback rule for a decoder that is told to do no DRC:

> "if, for example, the encoder uses no DRC, the decoder shall not apply any control other than
> **overload protection**."

(Tech 3344 also cites **ITU-R BS.642**, *Limiters for high-quality sound-programme signals*, as its
limiter reference; the recommendation is free at <https://www.itu.int/rec/R-REC-BS.642>, but its text did
not render to a plain client here, so no clause from it is quoted or relied on in this file.)

### 1.4 The general principle, stated so it cannot be got wrong again

Derived from §1.2–§1.3 (the statements below *are* the generalisation the cited code enforces, not a
verbatim standard sentence):

> **The detector must measure exactly the samples to which the scheduled gain will be applied — with
> every gain the output will carry already multiplied in.** A true-peak limiter's scheduled reduction is
> `ceiling / peak(measured)`. That ratio bounds the output only if `peak(measured)` is the peak of the
> signal the reduction is multiplied into. Therefore:
>
> 1. Every gain that survives to the output — the loudness/AGC gain, the user trim/offset — must be
>    applied **before** the detector measures the sample **and** before the sample enters the delay
>    line.
> 2. In a delay line that carries the output, the trim is written **into** the delay line (as loudnorm
>    does: `limiter_buf[...] = … * gain * s->offset`) so the *same* post-trim sample is both delayed and
>    measured.
> 3. A gain applied at the **read** side of the delay line (after the detector has already scheduled the
>    reduction) is outside the detector's view and breaks the ceiling by exactly that gain. There is no
>    post-hoc correction: the reduction for a sample already inside the lookahead was computed from the
>    untrimmed peaker.
> 4. If the sample rate is oversampled for true-peak detection (as loudnorm does, to 192 kHz), the
>    oversampled detector must see the post-gain samples too; an inter-sample peak scales with the gain
>    exactly as a sample does.

The failing "+1.6 dBTP" case is item 3: the trim is at the read side, so both the sample ceiling and the
true-peak ceiling are exceeded by that trim.

### 1.5 Runtime change of an output gain — what is and is not published

- **ffmpeg `loudnorm`'s `offset` is not runtime-changeable.** Its option table uses
  `#define FLAGS AV_OPT_FLAG_AUDIO_PARAM|AV_OPT_FLAG_FILTERING_PARAM` (no `AV_OPT_FLAG_RUNTIME_PARAM`)
  and `ff_af_loudnorm` sets no `.process_command`; the manual's "Changing options at runtime with a
  command" list does not include `loudnorm`. So the reference normaliser offers no runtime output-gain
  change at all.
- **ffmpeg `alimiter`'s `level_out` is runtime-changeable but is applied after the limiter** (§1.2) and
  therefore does not preserve the ceiling. That is a documented-by-code case of a runtime output gain
  that overshoots by construction.
- **The published device topology puts the user gain *before* the limiter** (EBU Tech 3344 §6.9 / B.5,
  §1.3), so a change of that gain is re-bounded by the limiter continuously. The standard shows the
  block order; it does **not** describe the internal behaviour of a lookahead limiter when a gain
  upstream of its buffer changes mid-buffer.

**The documentation does not state** any scheme in which a gain applied *after* a lookahead limiter is
made changeable at runtime while the limiter's ceiling is preserved without re-scheduling gain for the
samples already inside the lookahead. No located source (ffmpeg sources, EBU Tech 3344, R 128 s2/s4, the
AES loudness pages) describes such a scheme. What *is* consistent across the sources is narrower and
sufficient: put the gain upstream of the detector and the delay line, and the ceiling holds continuously
(the device topology of EBU Tech 3344 B.5), because each sample is bounded by a reduction computed from
its own already-gained value.

### 1.6 Section 1 — "the documentation does not state"

- No located source describes a runtime change of a **post-limiter** output gain that preserves the
  ceiling (§1.5).
- ITU-R BS.642 is cited by EBU Tech 3344 as the limiter standard but its text was not retrievable here;
  no clause from it is claimed (see §1.3).
- The "general principle" in §1.4 is a generalisation the cited implementations enforce, not a sentence
  any standard states in those words.

---

## 2. Gating within-program levelling so a compliant program is untouched

### 2.1 What the Loudness-to-Dialogue Ratio is, precisely

EBU R 128 s4 (Nov 2023, <https://tech.ebu.ch/docs/r/r128s4.pdf>) defines the quantity itself, and its
footnote names the substitutes explicitly:

> **Definitions** — "**Programme Loudness (PL):** The integrated loudness over the duration of a
> programme …"
> "**Dialogue Loudness (DL):** The average loudness of the speech component of a programme"
> "**Loudness-to-Dialogue Ratio (LDR):** The difference between Programme and Dialogue Loudness
> (**LDR = PL − DL**)"
> Footnote 1: "**Dialogue Loudness is also called 'Speech Loudness' or 'Speech-gated Loudness'.**"

It is thus a **programme-to-dialogue** difference (PL is whole-programme, DL is the speech component),
computed once for the programme — not a windowed quantity, and not a within-programme dynamic value.
R 128 s4 clause (d) states the consequence for anyone who cannot separate speech:

> "d) that **for measuring Dialogue Loudness the speech part of the programme needs to be separated.**
> In case an isolated speech track (dialogue stem or pre-mix) is not available, the Dialogue Loudness
> Level can be spot checked or automatically measured (for example, using a speech detection algorithm);"

**How it is computed** is in EBU Tech 3343 §9.4.1 (<https://tech.ebu.ch/docs/tech/tech3343.pdf>):

> "choose three **on-screen dialogue sequences from the beginning, the middle and the end** of the film
> (omit off-screen narration, radio voices and similar signals); … each of the three sequences should be
> **about 30 seconds long**; measure the individual loudness of the three sequences with ITU-R BS.1770;
> take the **average of the three loudness values** to obtain narrow-range Dialogue Loudness"

> "**Automatic separation** gives more consistency and repeatability but is dependent on the separation
> algorithm. It is anticipated that algorithms using Artificial Intelligence (AI) can lead to
> increasingly precise results …"

**Does the existing file already answer this?** Partly: `RESEARCH_COMFORT_NORMALIZER.md` §2.5 already
gives the LDR threshold values, clauses (b), (j), (k), the Case-a worked example and the fidelity note
that LDR needs dialogue measurement. This section adds only the *definition wording*, the
*speech-gated/Speech-Loudness* naming, and the *measurement window* (three 30 s sequences / automatic
separation), which §2.5 does not contain.

### 2.2 The substitute when dialogue cannot be isolated — and what it is called

The naming R 128 s4 gives is **"Speech Loudness" / "Speech-gated Loudness"** (footnote 1 above). When
speech is not measurable at all, the AES's own guidance substitutes **programme** loudness. AES,
*Loudness Normalization* (<https://aes.org/resources/audio-topics/loudness-project/loudness-normalization/>;
retrieved via the Wayback Machine capture of 2025-12-23 because the live page requires a browser
challenge):

> "If assorted content has speech elements that are measurable (usually with automatic software) then
> the gain of the overall content is adjusted so that the dialog Integrated Loudness is -18 LUFS. **Note
> that the gain is set only once: no gain-riding is performed, so the content producer's mix is
> preserved** when encoded for distribution."

> "**If the speech elements are not reliably measurable, such as when the speech is combined with music
> beds, sound effects, etc., TD1008 recommends that the overall content be normalized to -18 LUFS**
> before encoding and distribution."

So: the names are *Dialogue Loudness / Speech Loudness / Speech-gated Loudness*; when dialogue cannot be
isolated the published fallback is *Programme Loudness*, and the AES states the corresponding **no
gain-riding** rule for that fallback.

For a real-time within-programme leveller that cannot separate dialogue at all, the substitute quantity
is **Loudness Range (LRA)** plus the short-term-vs-integrated difference, and the substitute mechanism is
a **dead-band** — §2.3.

### 2.3 How the gate is implemented in practice — measured window, band, boundary

Two distinct published mechanisms exist: the standard's one-shot LDR gate, and the real-time leveller's
running dead-band.

**(a) The standard's gate is a whole-programme threshold, no window, no hysteresis.**
EBU Tech 3343 §9.4.2:

> "EBU R 128 s4 specifies that the **LDR value of adapted content should not exceed 5 LU. If after the
> calculation of LDR this is already the case (LDR ≤ 5 LU), no dynamic processing needs to be performed.**
> Depending on the normalisation scheme, True-peak limiting may be applicable, though."
> "**If LDR exceeds 5 LU, dynamic processing should be applied.**"

§9.4.2 states the parameters in one table: "Loudness-to-Dialogue Ratio (LDR) ≤ 5 LU" and
"Maximum True-Peak Level −1 dBTP (linear audio)". §9.4.5 states the same as a preservation rule:

> "EBU R 128 s4 recommends that if the Loudness-to-Dialogue Ratio is **lower than 5 LU, the mix should be
> left untouched and the process becomes transparent.**"
> "If the target criteria are met and no dynamic adaptation is needed, **the original mix is left
> untouched** independent of whether programme- or anchor-based normalization is used."

The "measured window" is therefore the **whole programme** for PL and the three ~30 s dialogue excerpts
(or an automatic separation) for DL (§2.1). There is no per-block window and **no hysteresis** — the
boundary is a single hard comparison `LDR ≤ 5 LU`; at the boundary nothing is done, above it the adaption
targets LDR = 5 LU.

**(b) A running leveller's substitute gate is a dead-band around the integrated loudness.**
`ffmpeg loudnorm` dynamic mode implements this, and it is the mechanism that leaves a compliant program
untouched. In `af_loudnorm.c`, `INNER_FRAME` computes the correction as:

```c
env_global = fabs(shortterm - global) < (s->target_lra / 2.) ? shortterm - global
            : (s->target_lra / 2.) * ((shortterm - global) < 0 ? -1 : 1);
env_shortterm = s->target_i - shortterm;
s->delta[s->index] = pow(10., (env_global + env_shortterm) / 20.);
```

Arithmetic of that expression, read off the code: inside the band the two terms cancel to
`target_i − global` — i.e. the gain applied is exactly the **static** integrated gain and the programme's
internal dynamics are *not* touched. Outside the band, `env_global` saturates at `±target_lra/2`, so a
loud passage is attenuated relative to the static gain and a quiet passage is boosted, by at most
`target_lra/2`. The `lra` option is documented as:

> "LRA, lra — Set loudness range target. Range is 1.0 - 50.0. **Default value is 7.0.**"
> (<https://ffmpeg.org/ffmpeg-filters.html#loudnorm>)

and the mode is summarised by the docs as "**This algorithm can target IL, LRA, and maximum true
peak.**" The author's own write-up states the intent behind the dead-band:

> "In this AGC, **local dynamics are maintained by specifying a target LRA, and only adjusting when
> loudness exceeds this range (in either direction.)**"
> (<https://k.ylo.ph/2016/04/04/loudnorm.html> — implementer's own documentation)

**Note (explicit, as required): ffmpeg's *manual* does not explain this dead-band.** The manual states
only the `LRA` option and that the filter targets `IL, LRA and maximum true peak`; the ±`LRA/2` band is
in the source (`af_loudnorm.c`, `INNER_FRAME`) and described in the author's blog, not in
`ffmpeg-filters.html`. The code is cited above.

`loudnorm`'s silence gate is separate and is also visible in the source. It holds its last gain when the
short-term loudness is below the programme's **relative gate** (or effectively silent), and it advances
only once the output has come back above target:

```c
if (shortterm < relative_threshold || shortterm <= -70. || s->above_threshold == 0) {
    s->delta[s->index] = s->prev_delta;
}
```

The author describes the same mechanism as a substitute for an arbitrary silence threshold:

> "the EBU R128 standard also provides us with a **relative gating threshold** which puts this 'silence'
> threshold in perceptual context within the program, shifting as it goes along."

**(c) A frame-level gate is the cruder substitute, and it is published.** `ffmpeg dynaudnorm` gates on
frame level rather than dialogue at all. FFmpeg Filters Documentation, *dynaudnorm*
(<https://ffmpeg.org/ffmpeg-filters.html#dynaudnorm>):

> "**threshold, t** — Set the target threshold value. This specifies the lowest permissible magnitude
> level for the audio input which will be normalized. **If input frame volume is above this value frame
> will be normalized. Otherwise frame may not be normalized at all.** The default value is set to 0,
> which means all input frames will be normalized."

Its measurement window and bounds are published too: "framelen, f … **Default is 500 milliseconds.**";
"gausssize, g … **Default is 31**" (Gaussian gain smoothing, in frames); "maxgain, m … In range from 1.0
to 100.0. **Default is 10.0.**" And the filter is documented as leaving within-frame dynamics alone:
"It will retain 100% of the dynamic range *within* each section of the audio file", achieved
"*without* applying 'dynamic range compressing'".

### 2.4 Is there a floor on residual dynamic range an implementation can assert against?

**The documentation does not state a numeric floor on residual dynamic range** — i.e. no located source
states a minimum acceptable output LRA. EBU states the opposite, qualitatively and explicitly, that no
such limit should exist. EBU Tech 3343 §3.3 ("Loudness Range"):

> "It is important to understand that **it is impossible and not useful to define a strict limit for LRA
> for all broadcasters and all programmes.** LRA should not be a brick wall parameter for delivery
> specifications of programmes."
> "As a result of the heterogenous situation regarding Loudness Range, **EBU R 128 does not include a
> maximum permitted LRA value.** A broadcaster has to decide if guidelines for upper limits of LRA for
> different distribution paths are to be used."

(That EBU sentence rules out a *maximum*; no EBU document located sets a *minimum* either.) The
qualitative prohibition is real but not numeric — EBU Tech 3343 §2.4 ("Loudness processors"):

> "Generally, care has to be taken **not to create 'loudness sausage' through overly aggressive
> processing**, thus ruining the original intention of increasing the contrast and dynamics …"
> "**Don't produce loudness sausage!** … For compliant material, a Loudness Processor should be switched
> to **BYPASS**."

The nearest thing to an enforceable numeric bound *is* R 128 s4: **LDR ≤ 5 LU** caps how far the
dialogue-to-programme spread may be reduced (§2.3a), and clause (k) — already quoted in
`RESEARCH_COMFORT_NORMALIZER.md` §2.5 — forbids adaptation when LDR is already ≤ 5 LU. That is a bound on
the *amount of adaptation*, not a floor on the *post-processing LRA*; a differently-shaped program can
still be flattened to LRA 0.3 LU while satisfying an LDR-derived rule, because a monocular implementation
cannot measure LDR at all (§2.1–§2.2). **No source located gives a number an implementation can assert
against as "residual dynamic range must be ≥ X".**

### 2.5 Section 2 — where the companion already answers, and what is not stated

Already in `RESEARCH_COMFORT_NORMALIZER.md` — cite, do not repeat here:
- §2.5: the LDR threshold clauses (b)/(j)/(k), the Case-a worked example, and the fidelity note that LDR
  requires dialogue measurement.
- §3.2: the anti-oscillation rule that the equaliser must not drive the loudness measure, and that the
  slow loop's integration time must be long.
- §4: the anti-maximiser bound table (including "within 5 LU, no dynamic adaptation needs to be
  performed").
- §6: the user trim is an output quantity and must not be wired to the target.

**The documentation does not state:** a numeric floor on residual dynamic range (§2.4); a windowed,
hysteretic runtime version of the LDR gate (the standard's gate is one-shot over the programme, §2.3a);
and — for real-time implementations that cannot measure dialogue — which substitute quantity to use.
Both substitutes located (LRA dead-band in `loudnorm`; frame-level `threshold` in `dynaudnorm`) are
implementation choices, not standardised prescriptions.

---

## 3. The adaptation rate

### 3.1 Published time constants — every number, sourced

| Stage | Time constant | Source (verbatim) |
|---|---|---|
| **AES active/real-time controller** — integrated term | rolling average of **"several seconds to many minutes"**; "**recommended … between 30 seconds to two minutes**" | AES, *Loudness Normalization*: "the integrated LUFS value is based on a user-defined rolling average from several seconds to many minutes. It is recommended that this period be between 30 seconds to two minutes." |
| **Let's note the same source's own caution** | — | "**Longer integration times usually yield natural-sounding loudness normalization results with less audible artifacts.**" |
| **ffmpeg `loudnorm` dynamic mode** — AGC measurement window | **3 s** short-term loudness; processed in **100 ms** subframes; a **30-frame** history; gain smoothed by a **21-tap Gaussian** (σ = 3.5) | `af_loudnorm.c`: `ls->buf_size = frame_size(sr, 3000)`; `activate()` consumes `frame_size(sr,100)`; `double delta[30];`; `init_gaussian_filter()` loops `i < 21` with `sigma = 3.5` |
| **ffmpeg `loudnorm`** — limiter | attack **10 ms**, release **100 ms**, lookahead buffer **210 ms** | `af_loudnorm.c`: `s->attack_length = frame_size(sr, 10); s->release_length = frame_size(sr, 100);` and `s->limiter_buf_size = frame_size(sr, 210)`. The author states "The limiter uses a **100 ms look-ahead**." |
| **ffmpeg `dynaudnorm`** — gain smoothing | frame **500 ms**, Gaussian over **31 frames** (±15 frames) | `dynaudnorm` docs: "Default is 500 milliseconds." / "Default is 31" (gausssize, in frames) |
| **ffmpeg `acompressor`** — compressor | attack **20 ms**, release **250 ms** (defaults) | `acompressor` docs and `af_sidechaincompress.c`: `{ "attack", … {.dbl=20}, …}`, `{ "release", … {.dbl=250}, …}` |
| **Spotify loud-mode limiter** | engage **−1 dB** (sample), attack **5 ms**, decay **100 ms** | Spotify for Artists, quoted in `RESEARCH_LOUDNESS.md` §1.4 / `RESEARCH_COMFORT_NORMALIZER.md` §1.4 |
| **Windows "Loudness Equalization"** | "**fast attack and slow decay**" — no numbers | Microsoft Learn, quoted in `RESEARCH_COMFORT_NORMALIZER.md` §2.3 |
| **EBU Tech 3344** — DAB/FM loudness matching | integrates "over a certain time, **for example one minute**" | EBU Tech 3344 §6.10 |

Read as a whole: the **integrated/absolute loop is deliberately slow** (30 s – 2 min in the AES
description; 3 s short-term window in `loudnorm`), while the **limiter is fast** (5–100 ms attack;
5–100 ms release). Nothing in the sources puts a lever between them other than the levelling/AGC stage.

### 3.2 Which stage is expected to catch a sudden level step

From the sources:

- **The limiter is peak-only by definition, so it is not the step-catcher for loudness.** The AES page
  states the limiter's role as a consequence of gain, nothing more: "**Peak limiting is provided since
  gain may be applied to the controlled audio.**" `loudnorm`'s limiter bounds `s->target_tp` only.
- **The AES integral term is explicitly a long-average tool, not a step response.** "Longer integration
  times usually yield natural-sounding loudness normalization results with less audible artifacts"; the
  real-time controller "can meet **long-term loudness goals** and may even avoid sudden increases in
  loudness". It also states the fundamental limitation: "real time processes cannot 'predict the future'
  for the remainder of a live program or stream".
- **The stage documented to react to changes of loudness is the levelling/AGC stage, and its response
  time is the AGC's measurement window, not the limiter's attack.** In `loudnorm` that window is the
  **3 s** short-term loudness with a ~2.1 s Gaussian smoothing of the applied gain (`af_loudnorm.c`,
  §3.1); the author describes it as an envelope "smoothed with a Gaussian kernel and linearly
  interpolated, which allows it to deal with sudden rapid changes in loudness while also still being able
  to honor local dynamics." In `dynaudnorm` the equivalent is a 500 ms frame with a ±15-frame Gaussian
  (≈ ±7.5 s). EBU Tech 3344's DAB/FM matcher uses ~1 min.
- **That a 30 s–2 min averaged loop will not catch a 30 s step is a direct reading of the sources
  above**, not a documented failure mode: the integrated term by construction responds over its averaging
  period. **The documentation does not state** a separate rule for how fast the *within-programme*
  levelling stage must respond to a level step.

For the measured case in the brief (60 s quiet then 30 s loud; eight seconds still 3.2 LU high), the
published constants that bound the behaviour are the AGC/levelling window (`loudnorm`: ~3 s +
~2.1 s smoothing) versus the AES integral window (30 s–2 min). Which of those is authoritative for a
consumer normaliser is not stated by any source; the sources describe two different loops and put the
step-catching duty in the levelling stage.

### 3.3 Maximum permitted overshoot or settling time after a level step

**The documentation does not state this.** No located primary source (EBU R 128 / s1 / s2 / s4, EBU Tech
3343 / 3344, AES TD1006 / TD1008, the AES loudness pages, ISO/IEC 23003-4, ffmpeg) states a maximum
permitted loudness overshoot, a settling time, or a maximum time-to-target after a level step. The
sources state *averaging periods* (§3.1) and describe the qualitative goal ("meet long-term loudness
goals"); they do not state a step-response limit. Nothing further is inferred here.

### 3.4 Does a limiter bound loudness overshoot as well as peak overshoot?

**Sources state peak only, never loudness.** Every located statement of what a limiter bounds names the
peak:

- AES: "**Peak limiting is provided** since gain may be applied to the controlled audio."
- `loudnorm`: the limiter's only target is `max true peak` (`TP`, default −2.0; docs: "Set maximum true
  peak"), and its output loudness is reported separately (`output_i`) — never clamped by the limiter.
- EBU R 128 s2 clause k: "appropriate **True-peak Limiting** … should be performed in the device, if a
  Target Level higher than −23.0 LUFS results in insufficient headroom" (quoted in
  `RESEARCH_COMFORT_NORMALIZER.md` §1.2/§4).
- EBU R 128 s4, clause (l)/(m): the bound is "the **True Peak Level** of a programme shall not exceed
  −1 dBTP"; programme loudness is a *target*, not a limiter action.
- Spotify's published limiter: "The limiter will engage at **−1 dB (sample values)**, with a **5 ms
  attack** time and a **100 ms decay** time" — a sample-peak threshold.

**The documentation does not state** that a limiter bounds loudness overshoot. Loudness is bounded by the
slow averaged loop (§3.1, §3.2), and peak by the limiter; the sources keep the two separate.

### 3.5 Section 3 — "the documentation does not state"

- A maximum permitted loudness overshoot or settling time after a level step (§3.3).
- Which loop (slow integrated vs faster levelling) must catch a sudden step for a consumer normaliser —
  the sources describe both and assign the step-catching role to the levelling stage only in the
  reference implementation's own write-up, not as a standard.
- That a limiter bounds loudness as well as peak — it is stated for peak only (§3.4).

---

## 4. Consolidated `UNVERIFIED` and "the documentation does not state"

`UNVERIFIED` (claim not in a primary source; scope given):

- **No source was found for a runtime output-gain change that preserves a lookahead limiter's ceiling
  without re-scheduling.** Scope: the claim "such a scheme exists / does not exist". The positive facts
  are: `loudnorm`'s offset is not runtime-settable and is pre-limiter; `alimiter`'s `level_out` is
  runtime-settable and post-limiter (§1.2, §1.5). ffmpeg source is the authority for those two; the
  general absence is stated as "not located", not as proven absence.
- **ITU-R BS.642** is named by EBU Tech 3344 as the limiter reference, but its text did not render to a
  plain client here; no clause from it is claimed (§1.3).

"The documentation does not state":

- A runtime change of a **post-limiter** output gain that preserves the ceiling (§1.5).
- A **numeric floor on residual dynamic range** / minimum output LRA (§2.4). EBU explicitly declines to
  set an LRA limit of any kind, and gives only the qualitative "don't produce loudness sausage" rule.
- A **windowed, hysteretic runtime version** of the LDR ≤ 5 LU gate; the standard's gate is a one-shot
  whole-programme comparison (§2.3a).
- **Which substitute quantity** a real-time implementation that cannot isolate dialogue should use —
  the located substitutes (LRA dead-band, frame-level threshold) are implementation choices (§2.2,
  §2.3).
- A **maximum permitted overshoot or settling time** after a level step (§3.3).
- That a limiter bounds **loudness** overshoot; only peak is stated (§3.4).
- Detailed *explanations* (as opposed to code) of the `loudnorm` dead-band and of `alimiter`'s
  gain placement; those mechanisms are read from source and are noted as such in §1.2 and §2.3.

---

## Sources

Standards and specifications (primary):

- EBU R 128 s2 (2023), *Loudness in Streaming*: <https://tech.ebu.ch/docs/r/r128s2.pdf>
- EBU R 128 s4 (2023), *Loudness Normalisation of Cinematic Content*: <https://tech.ebu.ch/docs/r/r128s4.pdf>
- EBU Tech 3343 (2023), *Guidelines for Production of Programmes in accordance with R 128*: <https://tech.ebu.ch/docs/tech/tech3343.pdf>
- EBU Tech 3344 (2016), *Guidelines for Distribution and Reproduction in accordance with EBU R 128*: <https://tech.ebu.ch/docs/tech/tech3344.pdf>
- ITU-R BS.642, *Limiters for high-quality sound-programme signals* (cited by EBU Tech 3344; text not retrieved here): <https://www.itu.int/rec/R-REC-BS.642>

Vendor / association documentation:

- AES, *Loudness Normalization* (Audio Topics; live page is browser-gated, quoted from the Wayback capture): <https://aes.org/resources/audio-topics/loudness-project/loudness-normalization/> — capture: <https://web.archive.org/web/20251223024458/https://aes.org/resources/audio-topics/loudness-project/loudness-normalization/>
- Spotify for Artists, *Loudness normalization*: <https://support.spotify.com/us/artists/article/loudness-normalization/> (quoted via `RESEARCH_LOUDNESS.md` §3.2)
- Microsoft Learn, *Loudness Equalization DSP*: <https://learn.microsoft.com/en-us/windows-hardware/drivers/audio/loudness-equalization-dsp> (quoted via `RESEARCH_COMFORT_NORMALIZER.md` §2.3)

Reference implementations and tools:

- ffmpeg filters manual — `loudnorm`, `alimiter`, `acompressor`, `dynaudnorm`: <https://ffmpeg.org/ffmpeg-filters.html>
- ffmpeg `libavfilter/af_loudnorm.c`: <https://github.com/FFmpeg/FFmpeg/blob/master/libavfilter/af_loudnorm.c>
- ffmpeg `libavfilter/af_alimiter.c`: <https://github.com/FFmpeg/FFmpeg/blob/master/libavfilter/af_alimiter.c>
- ffmpeg `libavfilter/af_sidechaincompress.c` (implements `acompressor`/`sidechaincompress`): <https://github.com/FFmpeg/FFmpeg/blob/master/libavfilter/af_sidechaincompress.c>
- ffmpeg `libavfilter/af_dynaudnorm.c`: <https://github.com/FFmpeg/FFmpeg/blob/master/libavfilter/af_dynaudnorm.c>
- Kyle Swanson, *loudnorm* (the reference implementation's author, documenting his own filter — labelled implementer documentation, not a standard): <https://k.ylo.ph/2016/04/04/loudnorm.html>
