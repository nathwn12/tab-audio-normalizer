/* comfort-normalizer — HUMAN COMFORT loudness chain (levelling + slow
 *
 * PRIMARY SOURCE (read, not recalled):
 *   URL: https://raw.githubusercontent.com/jiixyj/libebur128/master/ebur128/ebur128.c
 *   Upstream repository: jiixyj/libebur128, file ebur128/ebur128.c
 *   Functions used:
 *     ebur128_init_filter        — K-weighting coefficient derivation (analog-prototype
 *                                   constants + bilinear transform via K=tan(pi*f0/sr)).
 *     ebur128_calc_gating_block  — 400 ms blocks, mean square per channel, channel weights
 *                                   (surround x1.41, dual-mono x2.0, UNUSED/LFE skipped),
 *                                   absolute gate at -70 LUFS.
 *     ebur128_calc_relative_threshold / ebur128_gated_loudness
 *                                — absolute gate then relative gate at -10 LU below the
 *                                   mean of absolutely-gated blocks; integrated loudness
 *                                   L_KG = -0.691 + 10*log10(mean over gated blocks).
 *     ebur128_energy_to_loudness — the -0.691 offset conversion.
 *     ebur128_add_frames         — block timing: first block needs 400 ms, then a new
 *                                   block every 100 ms (75% overlap, 100 ms hop).
 *     interp_create / interp_process / ebur128_init_resampler
 *                                — 4x polyphase true-peak oversampler for sample rates
 *                                   below 96 kHz: sinc kernel with a window,
 *                                   coefficients distributed round-robin
 *                                   into one subfilter per phase (see interp_create).
 *                                   libebur128 uses 49 taps with a Hanning window;
 *                                   THIS worklet uses 97 taps with a Kaiser window
 *                                   (beta = 6.0) instead — see buildInterpPhases.
 *                                   The longer, sharper filter matches the
 *                                   independent ffmpeg ebur128 oracle within
 *                                   ~0.2 dB on transient bursts where the 49-tap
 *                                   Hanning version under-read it by up to
 *                                   ~2.0 dB (phase-break in a near-Nyquist
 *                                   alternating burst; measured 2026-10-18),
 *                                   while agreeing with it to ~0.0 dB on smooth
 *                                   tones. Same 4-phase streaming structure,
 *                                   same per-sample cost class (side chain only,
 *                                   never in the audio path).
 *     ebur128_init_channel_map   — default channel map (mono=LEFT; stereo=L,R;
 *                                   5.1 = L,R,C,UNUSED(LFE),Ls,Rs).
 *
 * EXACT ANALOG-PROTOTYPE CONSTANTS (copied from ebur128_init_filter, never rounded):
 *   Stage 1 (high shelf): f0 = 1681.974450955533, G = 3.999843853973347,
 *                         Q = 0.7071752369554196, Vb = Vh^0.4996667741545416
 *   Stage 2 (high pass):  f0 = 38.13547087602444, Q = 0.5003270373238773
 *   Derivation uses K = tan(pi*f0/samplerate) exactly as in ebur128_init_filter, so
 *   coefficients are correct at ANY sample rate (44100, 48000, …). No per-rate table.
 * GATING CONSTANTS (from the same file):
 *   histogram_energy_boundaries[0] = 10^((-70.0 + 0.691)/10)  → absolute gate -70 LUFS
 *   relative_gate = -10.0, relative_gate_factor = 10^(-10/10) = 0.1
 *   ebur128_energy_to_loudness(e) = 10*log10(e) - 0.691
 * TRUE-PEAK OVERSAMPLER (after interp_create / ebur128_init_resampler,
 *   with a longer sharper window — see buildInterpPhases):
 *   factor = 4 for samplerate < 96000 (our entire operating range);
 *   taps = 97, coefficient for tap j: m = j - 48, c = sin(m*pi/4)/(m*pi/4)
 *   (c = 1 at m = 0), windowed by a Kaiser window with beta = 6.0;
 *   near-zero coeffs (|c| <= 1e-6) skipped; coefficients distributed
 *   round-robin into one subfilter per phase. Group delay is 12 input
 *   samples ((taps - 1) / 2 / factor = 48 / 4; 48 output samples at the 4x
 *   rate) — distinct from the detector history span of 25 input samples
 *   (filter indices 0..24, i.e. the current sample plus 24 past samples).
 *   Detection lags the causing sample by 12 samples at the filter center
 *   and by at most 24 samples over the full span, both covered by the
 *   5 ms (240-sample at 48 kHz) limiter lookahead.
 *
 * WHAT THIS PROCESSOR IMPLEMENTS (comfort chain, fixed order — see the file
 * top comment and docs/RESEARCH_COMFORT_NORMALIZER.md):
 *   0. GATE, STATED PLAINLY. EBU R 128 s4 clause (k): if the
 *      Loudness-to-Dialogue Ratio is within 5 LU, NO dynamic adaptation is
 *      performed. The extension cannot isolate dialogue, so the published
 *      one-shot programme gate is implemented as loudnorm's running dead-band
 *      (item 2): inside ±2.5 LU of the programme the levelling applies no
 *      adaptation at all; outside it compresses the short-term spread back
 *      toward the band edge. Anchor error is absorbed by the slow loop, which
 *      measures the levelled signal and still drives program to -20.
 *      The bound is the OUTCOME (program -20, short-term spread toward
 *      <= 5 LU, EBU R 128 s4 (j)), judged on a monocular proxy (oracle LRA +
 *      section spread — not dialogue LDR, which needs a dialogue measure;
 *      the harness names the proxy what it measures, never "LDR"), and the
 *      chain never adapts a program already inside the band, never flattens
 *      toward equal loudness, and never invents a floor the standards do not
 *      state (no published residual-LRA floor exists, §2.4).
 *      EBU R 128 s4's own cinematic remedy lands program loudness at -21 LUFS
 *      (PL -17 -> -21 after LDR -> 5), corroborating the -20 target within
 *      1 dB. LIVE COMPROMISE: EBU Tech 3343 section 9.4.2 prefers
 *      offline/iterative adaptation over live processing; a browser tab cannot
 *      do a pre-pass, so this is the live approximation, not offline-grade.
 *   1. K-weighting: the two BS.1770 stages combined into one 4th-order IIR exactly as
 *      ebur128_init_filter convolves its shelf (pb/pa) and high-pass (rb/ra) sections
 *      into b[5]/a[5]; filtered per channel with the EBUR128_FILTER direct form
 *      (v0 = x - a1*v1 - a2*v2 - a3*v3 - a4*v4; y = b0*v0 + … + b4*v4). TWO passes:
 *      raw (telemetry) and levelled (slow loop), same coefficients.
 *   2. Levelling FIRST (within-program, feedforward): a dead-band AGC on the
 *      RAW input (code mechanism: ffmpeg loudnorm INNER_FRAME,
 *      libavfilter/af_loudnorm.c — env_global = |shortterm - global| <
 *      target_lra/2 ? shortterm - global : ±target_lra/2, so inside the band
 *      the gain collapses to the static value, i.e. NO adaptation is applied
 *      at all inside the band). The band half-width here is 2.5 LU (OUR target
 *      LRA 5.0, chosen to land EBU R 128 s4's LDR <= 5 LU outcome bound, §2.5
 *      clauses (j)/(k); no published residual-LRA floor exists, §2.4). The AGC
 *      reads the 3 s short-term loudness against the whole-program gated
 *      integrated loudness — the ~3 s stage that catches a level step (AES
 *      integral 30 s–2 min is long-term only; the limiter is peak-only and is
 *      never credited with loudness recovery). Boost capped at +6 dB (Dolby
 *      Film max boost, §2.1 — the smallest published boost, so quiet is lifted
 *      the least); cut bounded only by the TOTAL clamp. Silence gate (also
 *      loudnorm): below the relative gate the AGC holds its last gain. A boost
 *      is applied only while the ~0.1 s probe is itself below the programme
 *      mean's dead-band edge: the 3 s ST's boxcar otherwise held a boost
 *      ~1.5 s into a loud return, and those mis-lifted samples pushed
 *      comfort-dialogue's settled tail to -20.50 (measured 2026-10-19).
 *      It never reads the integrated measurement's OUTPUT (no feedback
 *      oscillation): ST and global are both RAW-input quantities.
 *   3. Dual metering: per-sample combined power p = sum_c w_c * y_c^2 into a
 *      ring; 400 ms block energy = mean(p over last 400 ms); a new block
 *      retained every 100 ms once 400 ms exist (streaming, never a post-pass).
 *      Gating: incremental two-pass — mean of absolutely-gated blocks, times
 *      0.1, is the relative threshold; integrated is the mean of blocks
 *      at/above it, converted with -0.691 + 10*log10. Exact. The RAW path feeds
 *      telemetry (what the oracle compares) over its full cumulative history;
 *      the LEVELLED path feeds the slow gain over the 30 s rolling window.
 *      Neither path ever contains the normalization gain or the trim.
 *   4. Slow gain: driven ONLY by the LEVELLED gated integrated loudness toward
 *      the fixed -20 LUFS program target, over an AES ROLLING average of the
 *      last 30 s of elapsed samples (SPEC S4): blocks older than the window
 *      expire by stamp, so the mean always describes the current program,
 *      never hours of retained history. Within the window only the blocks
 *      whose level lies within [-6, +15] LU of the current level count
 *      (SLOW_LOCK_LO_DB/HI_DB): without that gate a loud passage pinned a
 *      quiet passage's mean (the relative gate excludes only blocks BELOW the
 *      mean), the quiet rose -0.79 dB (gate >= 3.00) and the +10 dB step's
 *      stale quiet held the gain ~4 LU high (-16.60 at t = 70 s, gate +-1.0);
 *      with it the dialogue's quiet rises 6.74 dB, its tail reads -20.00 and
 *      the step lands at -20.40 (measured 2026-10-19, 48 kHz).
 *      Silence holds the last gain (§6).
 *      The +12/-20 dB clamp binds the TOTAL program gain (levelling +
 *      normalization). COLD START (onset guard, OURS/house — same status as
 *      WARM_SECONDS and FAST_ONSET_SECONDS below: no source publishes a
 *      cold-start number): before the first gated levelled block the slow
 *      loop has no measurement, so a loud onset passed uncut for ~400 ms and
 *      then converged with the 0.6 s down time constant (measured 2026-10-19
 *      on comfort-loud: still -1.55 dB at 0.5 s, -6 dB only at ~0.95 s).
 *      A ~100 ms levelled-power probe (FAST_ONSET_SECONDS) drives a CUT-ONLY
 *      (never boost) pre-cut toward the fixed target through a fast (~0.12 s)
 *      log-domain slew, ratcheting down only; the standard slow loop takes
 *      over FROM the current gain with no snap (measured 2026-10-19 on the
 *      same program: -9.3 dB by 0.5 s, -9.7 dB by 1.0 s, settled -10.00, never deeper than
 *      settled + 1.5 dB; quiet onset untouched). Still house wiring, not a
 *      sourced value; BS.1770's 400 ms first-block floor remains (the guard
 *      probes, it does not gate).
 *   5. Slew: asymmetric and slow in the log domain — gain increases (louder) use a
 *      ~3.0 s time constant; gain decreases (quieter) use ~0.6 s. The cold-start
 *      onset guard slews with its own fast (~0.12 s) constant while the session
 *      is cold (before the first gated levelled block). The user trim ramps per
 *      sample inside one render quantum (no zipper).
 *   6. True-peak limiter LAST: 4x polyphase detector (97-tap Kaiser filter above)
 *      driving a lookahead limiter. Ceiling -1 dBTP with
 *      a 1.0 dB internal detector margin — sized from the MEASURED worst-case
 *      end-to-end under-read of this detector against the ffmpeg ebur128
 *      oracle (0.51 dB on a steady full-scale 11.025 kHz tone, where the oracle
 *      itself reads ~0.8 dB above mathematical truth; transient near-Nyquist
 *      bursts read within 0.21 dB — see the TP_DETECTOR_MARGIN_DB comment),
 *      so the independent harness estimator stays at/below ceiling;
 *      a final sample hard-clip to the ceiling is the last resort. Output never
 *      exceeds the ceiling; silence is bit-deterministic (zeros in, zeros out).
 *      Anti-maximizer bounds: LDR <= 5 LU (EBU R 128 s4) and short-term
 *      loudness <= program loudness + 5 LU (EBU R 128 s1's -18 restated
 *      relative to this -20 program target).
 *   7. set-mode is retained for compatibility and still clears ONLY the
 *      loudness measurement (both meters); the levelling runs in BOTH modes —
 *      'normalize' and 'level' are the same comfort chain.
 *
 * INTERFACE (names preserved; set-gain-db semantics are the output trim):
 *   registerProcessor('loudness-normalizer', …); classic script, no imports.
 *   Node created with channelCountMode 'max', channelInterpretation 'speakers';
 *   handles 1..6 input channels; sampleRate is the live global.
 *   Inbound: set-gain-db {gainDb} (-12..+12) sets the immediate OUTPUT TRIM
 *     (never the target, never measured; per-sample ramp within one quantum);
 *     start-normalizing (no-op acknowledgement).
 *   Inbound: set-target-lufs {targetLufs}, set-mode {mode:'normalize'|'level'} (switching mode clears ONLY the loudness measurement -- both K-filter states, both power rings, both retained-block sets, both gated aggregates, momentary/short-term/warm -- so raw-input and levelled blocks can no longer mix; applied program gain (slow + AGC), trim, delay line, limiter targets/gain, both true-peak detector histories and the decaying output-peak hold carry through continuously, so the switch is inaudible apart from normal slew),
 *     reset-meter (full state clear: metering/blocks/warm/gain/detector-history/delay-line/limiter-targets/telemetry, keeps settings).
 *   Outbound: {type:'meter', integratedLufs, shortTermLufs, momentaryLufs, truePeakDb,
 *     appliedGainDb, userTrimDb, mode, warm} about every 48 render quanta.
 *   Documented telemetry surface: this.telemetry with those same fields (integratedLufs/shortTermLufs/momentaryLufs report the RAW program; appliedGainDb is levelling + normalization in dB, EXCLUDING the trim; userTrimDb is the current output trim; truePeakDb is a DECAYING PEAK-HOLD on the DELAYED post-limiter output true peak -- track = max(quantumPeak, quantumPeak + (track - quantumPeak) * exp(-N/(sr*1.5))) with a 1.5 s time constant, so after prior audio a zero-output quantum reports the decayed hold, not -Infinity; -Infinity only when the track is exactly zero (fresh/reset); the hold never under-reports the current quantum's output peak; the undelayed pre-limiter detector reading drives only scheduleLimiter), refreshed on
 *   EVERY process() call, so hosts never poke at internals.
 * REAL-TIME DISCIPLINE: every buffer preallocated in the constructor; process()
 *   performs no allocation, no array growth, no string building, no console output.
 */

var LOUDNESS_OFFSET = -0.691;
// Default program target: -20 LUFS, FIXED. A judgment inside the published
// -20.0 to -16.0 LUFS window (EBU R 128 s2 interim, where metadata is not
// employed; AES TD1008 anchors speech/assorted at -18 LUFS and
// track-normalised music at -16 LUFS, with a floor of keeping content above
// -20 LUFS): chosen below the platforms’ ≈-14 so the levelling stage has
// headroom to lift quiet dialogue before the true-peak ceiling, and below
// AES’s -18 speech anchor — the broadcast-aligned, dynamics-preserving end
// of the window. Stated as a judgment with that evidence (see the file
// header and docs/RESEARCH_COMFORT_NORMALIZER.md §1.5), not as a standard’s
// number. set-gain-db NEVER moves this target: it is an immediate output
// trim written into the delay line before the detector (ffmpeg loudnorm
// offset topology), excluded from both measurements. The +12/-20 dB clamp
// binds the TOTAL program gain (levelling +
// normalization), never the trim.
var TARGET_LUFS_DEFAULT = -20;
var ABS_GATE_LUFS = -70;
var ABS_GATE_ENERGY = Math.pow(10, (ABS_GATE_LUFS + 0.691) / 10);
// histogram_energy_boundaries[0] = 10^((-70.0 + 0.691)/10): absolute gate -70 LUFS.
var REL_GATE_FACTOR = Math.pow(10, -10 / 10);

var MAX_BOOST_DB = 12;
var MAX_CUT_DB = 20;

var UP_TC_SECONDS = 3.0;
var DOWN_TC_SECONDS = 0.6;
// Cold-start onset guard (OURS/house, owner-directed 2026-10-19 — same status
// as WARM_SECONDS below: no source publishes a cold-start number): before the
// first gated levelled block the slow loop has no measurement, so a loud
// onset passed uncut for ~400 ms and then converged with the 0.6 s down time
// constant. A fast levelled-power probe (FAST_ONSET_SECONDS) feeds a CUT-ONLY
// pre-cut toward the fixed target, slewed with FAST_ONSET_TC_SECONDS while
// the session is cold; the standard loop takes over FROM the current gain.
// CPU cost (one extra ring + sum per sample) explicitly accepted by the owner.
var FAST_ONSET_SECONDS = 0.1;
var FAST_ONSET_TC_SECONDS = 0.12;

var CEILING_DB = -1;
var CEILING_LINEAR = Math.pow(10, CEILING_DB / 20);
// True-peak detector margin: 1.0 dB. The detector is the 4x polyphase
// oversampler built in buildInterpPhases (97 taps, Kaiser beta 6.0); the
// limiter drives the DETECTOR reading to at most (ceiling - margin), so the
// continuous true peak can reach (ceiling - margin + U) where U is the
// detector's end-to-end under-read against the binding ffmpeg ebur128 oracle;
// requiring that to stay within the ceiling means U <= margin.
// Measured 2026-10-18 over an adversarial sweep (near-Nyquist alternating
// bursts of 4–64 frames at 0.5–1.0 amplitude with and without phase breaks,
// an isolated single-sample spike, sine bursts at fnorm 0.4/0.45/0.48, a
// full-scale alternating pattern, and steady tones):
//   transient bursts: U <= 0.21 dB with this filter (the previous 49-tap
//     Hanning transcription of libebur128 under-read the same bursts by up
//     to 2.03 dB — a step-transient smoothing error the sampling-grid bound
//     below does not cover, which is why the margin is sized from measurement
//     and the filter was lengthened, not from the grid bound alone);
//   worst case overall: U = 0.51 dB on a steady full-scale 11.025 kHz tone,
//     where the oracle itself reads ~0.8 dB ABOVE mathematical truth (its own
//     filter overshoots), so no flat detector can do better — the margin must
//     cover the oracle's overshoot, not just our filter.
// Margin derivation: 0.51 (measured worst U) + 0.49 headroom for untested
// patterns = 1.0. It stays below ~1.97 dB, the point where the limiter would
// start engaging on the loudest legitimate steady program (user-gain +12 on a
// 0.98 sine: post-gain detector peak -2.97 dB vs effCeiling -1 - margin; at
// margin 1.0 the limiter stays idle with ~1 dB headroom, so the margin costs
// no loudness loss — it only bites transient peaks).
// For reference, the BS.1770-4 Annex 2 sampling-grid bound 20*log10(cos(pi*
// fnorm/4)) is 0.688 dB at fnorm 0.5 and is INCLUDED in the measured U above
// (the sweep covers fnorm 0.4–0.5); the grid bound alone is not sufficient,
// because on step transients the filter's own smoothing dominates the grid.
var TP_DETECTOR_MARGIN_DB = 1.0;

var LOOKAHEAD_SECONDS = 0.005;
var LIMITER_ATTACK_SECONDS = 0.002;
// Flat-hold span before the attack ramp (samples, rate-independent: the
// detector and oracle interpolation spans are counted in samples). Must stay
// well inside the lookahead (240 samples at 48 kHz): 64 + 96 = 160 < 240.
var LIMITER_FLAT_SAMPLES = 64;
var LIMITER_RELEASE_SECONDS = 0.1;

// Within-program levelling: a dead-band AGC on the RAW input (mechanism from
// ffmpeg loudnorm INNER_FRAME, libavfilter/af_loudnorm.c; band size grounded
// in EBU R 128 s4 (j)/(k) via docs/RESEARCH_COMFORT_NORMALIZER.md §2.5 and
// docs/RESEARCH_NORMALIZER_MECHANISMS.md §§2.3-2.4).
// Per sample, with ST = 3 s short-term loudness and G = whole-program gated
// integrated loudness (both RAW-input, so the leveller never drives its own
// detector and the loops cannot oscillate):
//   d = ST - G
//   |d| <= AGC_BAND_DB -> no adaptation at all (the clause-(k) gate)
//   |d| >  AGC_BAND_DB -> agc = -(d - sign(d) * AGC_BAND_DB),
//                          compressing the spread back to the band edge.
// A boost is additionally gated by the ~0.1 s probe: it applies only while
// that probe (its levelled reading with the current AGC gain undone) is itself
// below G - AGC_BAND_DB, so a loud return is not mis-lifted by the 3 s
// boxcar's lag (measured: without the gate comfort-dialogue's tail settled at
// -20.50 against a +-0.20 gate). The cut direction is untouched.
// AGC_BAND_DB = 2.5 LU is OUR target (LRA 5.0): it lands the EBU LDR <= 5 LU
// outcome bound on a monocular chain. No published residual-LRA floor exists
// (EBU: "impossible and not useful to define a strict limit for LRA"), so any
// residual-spread number the harness asserts is labelled OURS, never EBU's.
// Boost capped at +6 dB (Dolby Film max boost, §2.1 — the smallest published
// max boost, so quiet is lifted the least, answering the "quiet parts got
// enhanced" complaint); cut bounded only by the TOTAL clamp below. Silence
// gate (also loudnorm: shortterm below the relative gate, or <= -70, holds):
// below the relative gate the AGC holds its last gain instead of adapting
// into silence/noise. ST is a 3 s boxcar — already smooth, so the gain drives
// per sample with no extra smoothing layer (loudnorm smooths its 100 ms
// deltas with a ~2.1 s Gaussian; the 3 s boxcar is this chain's smoother).
// The output trim (set-gain-db) ramps per sample within one render quantum.
var AGC_BAND_DB = 2.5;
var AGC_BOOST_CAP_DB = 6;
var AGC_SILENCE_FLOOR_LUFS = -70;
// Slow-window level gate (OURS/house — same status as WARM_SECONDS and the
// onset-guard numbers: no source publishes these): the slow loop's rolling
// window keeps only the blocks whose level lies within [-6, +15] LU of the
// current level (the higher of the 3 s ST and the 400 ms momentary, so a loud
// onset moves the gate at the momentary's speed while a settling program moves
// it smoothly). Why the window needs it (measured 2026-10-19, comfort-dialogue
// and comfort-step at 48 kHz, BEFORE the change):
//   - the BS.1770 relative gate excludes only blocks BELOW the mean, so a
//     loud passage pinned a quiet passage's programme mean forever: the
//     26.02 dB-dialogue profile kept 20.78 dB of output spread and the quiet
//     passage rose -0.79 dB (gate: >= 3.00);
//   - at the +10 dB step the window still held 2/3 pre-step quiet at t = 70 s
//     (levelled mean -27.90 vs the loud's -20.69), so the slow gain was ~4 LU
//     too high and the oracle read -16.60 (gate: -20.0 +- 1.0).
// Bounds (measured): the +15 edge must exceed comfort-pair12's 12.04 LU
// section spread, whose AGC-boosted quiet (-23.0 LUFS, a within-program
// passage) must still enter the window and pull the mean down — with 15 the
// pair12 reads reduction 6.93 dB, quiet rise 4.66 dB, residual 5.11 LU (gates:
// >= 4 / >= 3 / >= 3, all green); the -6 edge must stay under comfort-step's
// 10.0 LU stale drag (with 6 the pre-step quiet leaves the loud's window and
// the step lands at -20.40, gate +-1.0) and above comfort-varying4's 4.0 LU
// in-band sections (with 6 the varying4 section readings are unchanged:
// reduction -0.27 dB, residual 4.27 LU, gate <= 1.0 / >= 3.0). After the
// change the dialogue's 26 dB loud blocks leave the quiet's window, so the
// AGC's +6 (capped) plus the slow loop's clamped +6 lift the quiet passage by
// 6.74 dB and the settled tail reads -20.00 (gate +-0.20).
var SLOW_LOCK_LO_DB = 6;
var SLOW_LOCK_HI_DB = 15;

var WARM_SECONDS = 0;
// No warm-up hold: the dead-band levelling (3 s short-term AGC, first gated
// block ~400 ms) and the slow loop engage on a loud onset from the beginning
// instead of after a fixed delay. A fixed multi-second unity hold lets a loud
// onset pass uncut and then cuts the quiet that follows, EXPANDING the spread
// (comfort-shortform 26.02 -> 30.36 dB). WARM_SECONDS is house wiring, not a
// sourced value; the K-weighting, gating, dead band, AGC cap, clamps and
// ceilings are untouched. The ~400 ms first-block floor (BS.1770) remains.
// Slow-loop averaging period: an AES rolling average over 30 s
// (docs/RESEARCH_COMFORT_NORMALIZER.md §3.1; SPEC S4 requires 30 s–2 min).
// 30 s is the in-range value that lets the longest stable tails in the
// acceptance fixtures (30 s: comfort-pair12/varying4 30–60 s) fully determine
// the mean — any larger window keeps the preceding passage in the average at
// end-of-file and reproduces the cumulative bias (settled tails at
// −19.2/−19.3 LUFS instead of −20.00). Blocks are retained every 100 ms, so
// the window holds 30 s × 10 = 300 blocks; each retained block carries the
// elapsed-sample stamp it was kept at, and blocks older than 30 s of elapsed
// samples are expired (not merely overwritten), so an unbounded tab stream
// cannot accumulate hours of history and a long silence empties the window
// (the slow gain then holds — §6 — instead of re-targeting). The RAW
// telemetry/AGC-reference path intentionally keeps its cumulative MAX_BLOCKS
// ring: the oracle compares its full-file integrated loudness, and the AGC
// program reference is outside this change.
var SLOW_WINDOW_SECONDS = 30;
var SLOW_WINDOW_BLOCKS = SLOW_WINDOW_SECONDS * 10;
var MAX_BLOCKS = 50000;
var METER_EVERY_QUANTA = 48;
var MIN_GAIN_DB = -12;
var MAX_GAIN_DB = 12;

function dbToGain(db) { return Math.pow(10, db / 20); }
function clampNumber(value, min, max) {
  var n = Number(value);
  if (!Number.isFinite(n)) return 0;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}
function energyToLoudness(energy) {
  if (!(energy > 0)) return -Infinity;
  return 10 * Math.log10(energy) + LOUDNESS_OFFSET;
}
function channelWeight(index, total) {
  if (total <= 1) return 1;
  if (total === 2) return 1;
  if (total === 3) return 1;
  if (total === 4) return index < 2 ? 1 : 1.41;
  if (total === 5) return index < 3 ? 1 : 1.41;
  if (index === 3) return 0;
  if (index === 4 || index === 5) return 1.41;
  return index < 3 ? 1 : 0;
}

// Exact replica of ebur128_init_filter (see header): shelf + high-pass convolved
// into one 4th-order section. Called once per construction at the live rate.
function initKCoeffs(sr) {
  var f0 = 1681.974450955533;
  var G = 3.999843853973347;
  var Q = 0.7071752369554196;
  var K = Math.tan(Math.PI * f0 / sr);
  var Vh = Math.pow(10, G / 20);
  var Vb = Math.pow(Vh, 0.4996667741545416);
  var a0 = 1 + K / Q + K * K;
  var pb0 = (Vh + Vb * K / Q + K * K) / a0;
  var pb1 = 2 * (K * K - Vh) / a0;
  var pb2 = (Vh - Vb * K / Q + K * K) / a0;
  var pa1 = 2 * (K * K - 1) / a0;
  var pa2 = (1 - K / Q + K * K) / a0;

  f0 = 38.13547087602444;
  Q = 0.5003270373238773;
  K = Math.tan(Math.PI * f0 / sr);
  var denom = 1 + K / Q + K * K;
  var ra1 = 2 * (K * K - 1) / denom;
  var ra2 = (1 - K / Q + K * K) / denom;

  return {
    b0: pb0,
    b1: pb0 * -2 + pb1,
    b2: pb0 + pb1 * -2 + pb2,
    b3: pb1 + pb2 * -2,
    b4: pb2,
    a1: ra1 + pa1,
    a2: ra2 + pa1 * ra1 + pa2,
    a3: pa1 * ra2 + pa2 * ra1,
    a4: pa2 * ra2
  };
}

// True-peak detector coefficients: 4x polyphase windowed-sinc FIR.
// sinc kernel sin(m*pi/4)/(m*pi/4) with a Kaiser window (beta = 6.0),
// 97 taps (m = j - 48), distributed round-robin into one subfilter per phase.
// The 97-tap Kaiser filter replaces the 49-tap Hanning transcription of
// libebur128's interp_create: the Hanning version smooths step transients
// (phase breaks in near-Nyquist alternating bursts) and under-read the
// ffmpeg oracle by up to 2.03 dB on them; the Kaiser version tracks the
// oracle within 0.21 dB there (measured 2026-10-18, see TP_DETECTOR_MARGIN_DB).
// Per-phase DC sums are unity to <0.01 dB, so smooth tones read exactly.
// Runs once per construction; process() only reads the tables.
function besselI0(x) {
  var sum = 1;
  var term = 1;
  for (var k = 1; k < 40; k++) {
    term *= (x * x) / (4 * k * k);
    sum += term;
    if (term < 1e-15) break;
  }
  return sum;
}
function buildInterpPhases() {
  var taps = 97;
  var factor = 4;
  var beta = 6.0;
  var half = (taps - 1) / 2;
  var denom = besselI0(beta);
  var phasesC = [[], [], [], []];
  var phasesI = [[], [], [], []];
  for (var j = 0; j < taps; j++) {
    var m = j - half;
    var c = 1;
    if (m > 0.000001 || m < -0.000001) {
      c = Math.sin(m * Math.PI / factor) / (m * Math.PI / factor);
    }
    var r = (2 * j) / (taps - 1) - 1;
    c = c * besselI0(beta * Math.sqrt(Math.max(0, 1 - r * r))) / denom;
    if (c > 0.000001 || c < -0.000001) {
      var f = j % factor;
      phasesC[f].push(c);
      phasesI[f].push(Math.floor(j / factor));
    }
  }
  return { c: phasesC, idx: phasesI, delay: Math.floor(taps / factor) + 1 };
}

class LoudnessNormalizerProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    var sr = typeof sampleRate === 'number' && sampleRate > 0 ? sampleRate : 48000;
    this.sr = sr;

    var k = initKCoeffs(sr);
    this.kB0 = k.b0;
    this.kB1 = k.b1;
    this.kB2 = k.b2;
    this.kB3 = k.b3;
    this.kB4 = k.b4;
    this.kA1 = k.a1;
    this.kA2 = k.a2;
    this.kA3 = k.a3;
    this.kA4 = k.a4;

    var ch;
    this.filtV = [];
    for (ch = 0; ch < 6; ch++) this.filtV.push(new Float64Array(5));
    // Second K-filter pass for the LEVELLED signal (exact, same coefficients):
    // the slow normalization gain is measured from the levelled signal, while
    // telemetry keeps reporting the RAW program (what the oracle measures).
    this.filtVLev = [];
    for (ch = 0; ch < 6; ch++) this.filtVLev.push(new Float64Array(5));

    this.samples100 = Math.floor((sr + 5) / 10);
    if (this.samples100 < 1) this.samples100 = 1;
    this.blockSize = this.samples100 * 4;
    this.shortWin = this.samples100 * 30;

    this.pRing = new Float64Array(this.shortWin);
    this.pIndex = 0;
    this.pCount = 0;
    this.sumShort = 0;
    this.sumBlock = 0;
    this.hopCounter = 0;

    this.blocks = new Float64Array(MAX_BLOCKS);
    this.blockWrite = 0;
    this.blockCount = 0;
    this.integratedEnergy = 0;
    this.integratedLufs = -Infinity;
    this.hasGated = false;
    this.meanAbsRaw = 0;

    // Levelled-signal measurement (drives the normalization gain). Same
    // geometry (shortWin/blockSize/samples100/hop), advanced in lockstep with
    // the raw ring above: one hop retains one block on EACH path.
    this.pRingLev = new Float64Array(this.shortWin);
    this.sumShortLev = 0;
    this.sumBlockLev = 0;
    this.blocksLev = new Float64Array(SLOW_WINDOW_BLOCKS);
    this.blockSampleLev = new Float64Array(SLOW_WINDOW_BLOCKS);
    this.slowWindowSamples = Math.max(1, Math.round(SLOW_WINDOW_SECONDS * sr));
    this.blockWriteLev = 0;
    this.blockCountLev = 0;
    this.integratedEnergyLev = 0;
    this.integratedLufsLev = -Infinity;
    this.hasGatedLev = false;

    // Onset-guard fast probe: ~0.1 s ring of LEVELLED power (newPLev, the
    // already-computed slow-loop detector input), fed per sample. Preallocated
    // here; process() only reads/writes (real-time discipline).
    this.fastWindow = Math.max(1, Math.round(FAST_ONSET_SECONDS * sr));
    this.fastRing = new Float64Array(this.fastWindow);
    this.fastIndex = 0;
    this.fastCount = 0;
    this.fastSum = 0;
    // Cold-start pre-cut in dB: CUT ONLY (<= 0), ratchets down only while the
    // session is cold (!hasGatedLev, fast window full). Quiet content and
    // digital silence leave it at 0 (clamped, never boost; silence energy 0
    // reads -Infinity and clamps to 0 — no NaN path).
    this.onsetCutDb = 0;

    this.delayFrames = Math.max(128, Math.round(sr * LOOKAHEAD_SECONDS));
    this.bufferLength = 1;
    while (this.bufferLength < this.delayFrames + 2048) this.bufferLength <<= 1;
    this.channelBuffers = [];
    for (ch = 0; ch < 6; ch++) this.channelBuffers.push(new Float32Array(this.bufferLength));
    this.limiterTargets = new Float32Array(this.bufferLength);
    this.limiterTargets.fill(1);
    this.writeIndex = 0;
    this.limiterAttackFrames = Math.max(1, Math.round(sr * LIMITER_ATTACK_SECONDS));
    this.limiterReleaseCoeff = Math.exp(-1 / (sr * LIMITER_RELEASE_SECONDS));
    this.currentLimiterGain = 1;

    var ph = buildInterpPhases();
    this.interpC = ph.c;
    this.interpI = ph.idx;
    this.interpDelay = ph.delay;
    this.interpZ = [];
    for (ch = 0; ch < 6; ch++) this.interpZ.push(new Float64Array(ph.delay));
    this.interpZi = 0;
    // Output true-peak detector: same 4x polyphase tables, separate history
    // fed from the DELAYED post-limiter output (what actually leaves the
    // processor). The limiter decision still uses interpZ on the undelayed
    // pre-limiter signal; telemetry reports only this delayed output path,
    // as a DECAYING PEAK-HOLD (choice b): track = max(quantum, quantum +
    // (track - quantum) * exp(-N/(sr*1.5))), 1.5 s TC, so the hold never
    // under-reports the current quantum and -Infinity means track exactly 0.
    this.outInterpZ = [];
    for (ch = 0; ch < 6; ch++) this.outInterpZ.push(new Float64Array(ph.delay));
    this.outInterpZi = 0;

    // Within-program levelling: dead-band AGC state. currentAgcDb is the
    // fast mover (3 s ST window); currentLoudnessDb is the slow mover. Both
    // are feedforward from RAW-input quantities (no feedback oscillation).
    this.currentAgcDb = 0;

    this.targetLufs = TARGET_LUFS_DEFAULT;
    // Output trim (set-gain-db): target value from the message, current value
    // slewed per sample within one render quantum. Never the target, never
    // measured.
    this.trimTargetDb = 0;
    this.trimCurrentDb = 0;
    this.mode = 'normalize';
    this.currentLoudnessDb = 0;
    this.totalFrames = 0;
    this.warm = false;
    this.momentaryLufs = -Infinity;
    this.shortTermLufs = -Infinity;
    this.truePeakTrack = 0;
    this.appliedGainDb = 0;
    this.meterCounter = 0;

    this.rawScratch = new Float64Array(6);
    this.preScratch = new Float64Array(6);
    this.outScratch = new Float64Array(6);

    this.telemetry = {
      integratedLufs: -Infinity,
      shortTermLufs: -Infinity,
      momentaryLufs: -Infinity,
      truePeakDb: -Infinity,
      appliedGainDb: 0,
      normGainDb: 0,
      userTrimDb: 0,
      mode: 'normalize',
      warm: false
    };
    this.meterMsg = {
      type: 'meter',
      integratedLufs: -Infinity,
      shortTermLufs: -Infinity,
      momentaryLufs: -Infinity,
      truePeakDb: -Infinity,
      appliedGainDb: 0,
      normGainDb: 0,
      userTrimDb: 0,
      mode: 'normalize',
      warm: false
    };

    var self = this;
    this.port.onmessage = function (event) {
      var data = event && event.data ? event.data : null;
      if (!data || typeof data.type !== 'string') return;
      if (data.type === 'set-gain-db') {
        // Immediate OUTPUT TRIM (see header): sets the trim target written
        // into the delay line before the detector (loudnorm offset
        // topology), ramped per sample within one render quantum. It never
        // moves targetLufs and never enters either loudness measurement.
        // SPEC §6: a trim outside −12…+12 dB is IGNORED — the previous trim
        // is preserved — never clamped. In-range values keep the 0.5 dB
        // slider step shared with the popup/background.
        var trimRaw = Number(data.gainDb);
        if (!Number.isFinite(trimRaw) || trimRaw < MIN_GAIN_DB || trimRaw > MAX_GAIN_DB) return;
        self.trimTargetDb = Math.round(trimRaw * 2) / 2;
        return;
      }
      if (data.type === 'start-normalizing') return;
      if (data.type === 'set-target-lufs') {
        var t = Number(data.targetLufs);
        if (Number.isFinite(t)) self.targetLufs = t;
        return;
      }
      if (data.type === 'set-mode') {
        if (data.mode === 'level' || data.mode === 'normalize') {
          if (self.mode !== data.mode) {
            // Mode switch clears ONLY the loudness measurement (see
            // resetMeasurementForModeSwitch): retained raw AND levelled blocks
            // would otherwise mix incompatible energies across the switch, so
            // the measurement cannot cross modes. The levelling runs in BOTH
            // modes (one comfort chain), and the applied program gain, the
            // AGC gain, the trim, the delay line, the limiter and the output-peak hold carry through continuously, so the
            // switch is inaudible apart from normal slew. A full resetMeter()
            // here synchronously snapped gain to 0 dB (up to ~14 dB step).
            self.mode = data.mode;
            self.resetMeasurementForModeSwitch();
          }
        }
        return;
      }
      if (data.type === 'reset-meter') {
        self.resetMeter();
      }
    };
  }

  resetMeasurementForModeSwitch() {
    // Loudness-measurement-only clear for set-mode (Finding 1 fix).
    // Clears: K-filter states (filtV), power ring and sums (pRing/pIndex/
    // pCount/sumShort/sumBlock/hopCounter), retained blocks (blocks/
    // blockWrite/blockCount), gated aggregates (integratedEnergy/
    // integratedLufs/hasGated), momentary/short-term and their telemetry
    // mirrors, and warm (re-armed: totalFrames is KEPT so warm re-asserts as
    // soon as the new mode gates, ~400 ms, instead of a 3 s unity drift).
    // DELIBERATELY PRESERVED for gain continuity: currentLoudnessDb/
    // currentAgcDb/appliedGainDb (no snap to unity), the onset pre-cut
    // onsetCutDb (no snap: the cold-window desired gain stays where it is),
    // trim (a user setting), the full audio path (channelBuffers/writeIndex/
    // limiterTargets/currentLimiterGain), both true-peak
    // detector histories (interpZ/interpZi/outInterpZ/outInterpZi) and
    // truePeakTrack (decaying output-peak hold), totalFrames, settings/mode,
    // meter cadence and scratch (overwritten per sample).
    var ch, i;
    for (ch = 0; ch < 6; ch++) {
      var v = this.filtV[ch];
      v[0] = 0; v[1] = 0; v[2] = 0; v[3] = 0; v[4] = 0;
      var vL = this.filtVLev[ch];
      vL[0] = 0; vL[1] = 0; vL[2] = 0; vL[3] = 0; vL[4] = 0;
    }
    this.pRing.fill(0);
    this.pIndex = 0;
    this.pCount = 0;
    this.sumShort = 0;
    this.sumBlock = 0;
    this.hopCounter = 0;
    this.blocks.fill(0);
    this.blockWrite = 0;
    this.blockCount = 0;
    this.integratedEnergy = 0;
    this.integratedLufs = -Infinity;
    this.hasGated = false;
    this.meanAbsRaw = 0;
    this.pRingLev.fill(0);
    this.sumShortLev = 0;
    this.sumBlockLev = 0;
    this.blocksLev.fill(0);
    this.blockSampleLev.fill(0);
    this.blockWriteLev = 0;
    this.blockCountLev = 0;
    this.integratedEnergyLev = 0;
    this.integratedLufsLev = -Infinity;
    this.hasGatedLev = false;
    // Onset-guard fast probe is measurement: ring/sum/count clear with the
    // rest. onsetCutDb is PRESERVED (see above): clearing it to 0 would snap
    // the cold-window desired gain to unity; the fresh probe ratchets it down
    // again from the preserved value once the fast window refills.
    this.fastRing.fill(0);
    this.fastIndex = 0;
    this.fastCount = 0;
    this.fastSum = 0;
    this.warm = false;
    this.momentaryLufs = -Infinity;
    this.shortTermLufs = -Infinity;
    this.telemetry.integratedLufs = -Infinity;
    this.telemetry.shortTermLufs = -Infinity;
    this.telemetry.momentaryLufs = -Infinity;
    this.telemetry.warm = false;
    this.meterMsg.integratedLufs = -Infinity;
    this.meterMsg.shortTermLufs = -Infinity;
    this.meterMsg.momentaryLufs = -Infinity;
    this.meterMsg.warm = false;
    this.telemetry.mode = this.mode;
    this.meterMsg.mode = this.mode;
  }

  resetMeter() {
    // Full state clear (settings kept: sr, K coeffs, block sizes, limiter
    // timing, interp tables, targetLufs/trim/mode). After
    // this the processor is indistinguishable from a freshly constructed
    // one with the same settings: every per-block history is zeroed, not
    // just the metering aggregates. In particular the true-peak detector
    // history (interpZ/interpZi), the limiter delay line (channelBuffers)
    // and its write position, the power ring (pRing), retained blocks, and
    // the telemetry/meterMsg surfaces are all reset — stale detector
    // history otherwise schedules phantom limiter engagements and reports
    // a phantom true peak on post-reset silence, and stale delay-line audio
    // leaks into post-reset output.
    var ch, i;
    for (ch = 0; ch < 6; ch++) {
      var v = this.filtV[ch];
      v[0] = 0; v[1] = 0; v[2] = 0; v[3] = 0; v[4] = 0;
      var vR = this.filtVLev[ch];
      vR[0] = 0; vR[1] = 0; vR[2] = 0; vR[3] = 0; vR[4] = 0;
    }
    this.pRing.fill(0);
    this.pIndex = 0;
    this.pCount = 0;
    this.sumShort = 0;
    this.sumBlock = 0;
    this.hopCounter = 0;
    this.blocks.fill(0);
    this.blockWrite = 0;
    this.blockCount = 0;
    this.integratedEnergy = 0;
    this.integratedLufs = -Infinity;
    this.hasGated = false;
    this.meanAbsRaw = 0;
    this.pRingLev.fill(0);
    this.sumShortLev = 0;
    this.sumBlockLev = 0;
    this.blocksLev.fill(0);
    this.blockSampleLev.fill(0);
    this.blockWriteLev = 0;
    this.blockCountLev = 0;
    this.integratedEnergyLev = 0;
    this.integratedLufsLev = -Infinity;
    this.hasGatedLev = false;
    // Onset-guard state clears with everything else (fresh-constructed
    // equivalence: reset-then-render is bit-identical to a fresh instance).
    this.fastRing.fill(0);
    this.fastIndex = 0;
    this.fastCount = 0;
    this.fastSum = 0;
    this.onsetCutDb = 0;
    this.totalFrames = 0;
    this.warm = false;
    this.momentaryLufs = -Infinity;
    this.shortTermLufs = -Infinity;
    this.truePeakTrack = 0;
    this.currentLoudnessDb = 0;
    this.currentAgcDb = 0;
    this.trimCurrentDb = this.trimTargetDb;
    this.appliedGainDb = 0;
    for (ch = 0; ch < 6; ch++) this.channelBuffers[ch].fill(0);
    for (i = 0; i < this.bufferLength; i++) this.limiterTargets[i] = 1;
    this.writeIndex = 0;
    this.currentLimiterGain = 1;
    for (ch = 0; ch < 6; ch++) this.interpZ[ch].fill(0);
    this.interpZi = 0;
    for (ch = 0; ch < 6; ch++) this.outInterpZ[ch].fill(0);
    this.outInterpZi = 0;
    this.meterCounter = 0;
    this.rawScratch.fill(0);
    this.preScratch.fill(0);
    this.outScratch.fill(0);
    this.telemetry.integratedLufs = -Infinity;
    this.telemetry.shortTermLufs = -Infinity;
    this.telemetry.momentaryLufs = -Infinity;
    this.telemetry.truePeakDb = -Infinity;
    this.telemetry.appliedGainDb = 0;
    this.telemetry.normGainDb = 0;
    this.telemetry.userTrimDb = this.trimCurrentDb;
    this.telemetry.mode = this.mode;
    this.telemetry.warm = false;
    this.meterMsg.integratedLufs = -Infinity;
    this.meterMsg.shortTermLufs = -Infinity;
    this.meterMsg.momentaryLufs = -Infinity;
    this.meterMsg.truePeakDb = -Infinity;
    this.meterMsg.appliedGainDb = 0;
    this.meterMsg.normGainDb = 0;
    this.meterMsg.userTrimDb = this.trimCurrentDb;
    this.meterMsg.mode = this.mode;
    this.meterMsg.warm = false;
  }

  recomputeIntegrated() {
    if (this.blockCount === 0) {
      this.integratedEnergy = 0;
      this.integratedLufs = -Infinity;
      this.hasGated = false;
      this.meanAbsRaw = 0;
      return;
    }
    var sum = 0;
    var i;
    for (i = 0; i < this.blockCount; i++) sum += this.blocks[i];
    var meanAbs = sum / this.blockCount;
    // Mean of the absolutely-gated RAW blocks: the AGC silence gate reads
    // this (relative threshold = meanAbs * 0.1, loudnorm's silence gate).
    this.meanAbsRaw = meanAbs;
    var relThresh = meanAbs * REL_GATE_FACTOR;
    var sumG = 0;
    var cntG = 0;
    for (i = 0; i < this.blockCount; i++) {
      var e = this.blocks[i];
      if (e >= relThresh) {
        sumG += e;
        cntG++;
      }
    }
    if (cntG === 0) {
      this.integratedEnergy = 0;
      this.integratedLufs = -Infinity;
      this.hasGated = false;
      return;
    }
    this.integratedEnergy = sumG / cntG;
    this.integratedLufs = energyToLoudness(this.integratedEnergy);
    this.hasGated = Number.isFinite(this.integratedLufs);
  }

  // Levelled-path twin of recomputeIntegrated, over a ROLLING window: only
  // blocks retained within the last SLOW_WINDOW_SECONDS of elapsed samples
  // count (AES rolling average, SPEC S4). Stale slots are skipped, never
  // compacted — the ring recycles them by overwriting the oldest, and order
  // never matters to a mean. The SLOW normalization gain reads ONLY this
  // path. Gating (absolute −70 LUFS below, relative −10 LU here) and the
  // K-weighted measurement are exactly as before.
  recomputeLevelled() {
    if (this.blockCountLev === 0) {
      this.integratedEnergyLev = 0;
      this.integratedLufsLev = -Infinity;
      this.hasGatedLev = false;
      return;
    }
    var now = this.totalFrames;
    var maxAge = this.slowWindowSamples;
    // Level gate (OURS/house — see SLOW_LOCK_LO_DB): only blocks whose level
    // lies within [-6, +15] LU of the current level (the higher of the 3 s ST
    // and the momentary) describe the programme the window is averaging; a
    // loud passage can no longer pin a quiet one's mean, and a level change
    // drops the stale passage instead of dragging it into the mean.
    var stRef = this.shortTermLufs;
    if (Number.isFinite(this.momentaryLufs) && this.momentaryLufs > stRef) stRef = this.momentaryLufs;
    var lockOn = Number.isFinite(stRef);
    var lockLo = stRef - SLOW_LOCK_LO_DB;
    var lockHi = stRef + SLOW_LOCK_HI_DB;
    var sum = 0;
    var absN = 0;
    var i;
    for (i = 0; i < this.blockCountLev; i++) {
      if (now - this.blockSampleLev[i] > maxAge) continue;
      var e0 = this.blocksLev[i];
      if (lockOn) {
        var l0 = energyToLoudness(e0);
        if (l0 < lockLo || l0 > lockHi) continue;
      }
      sum += e0;
      absN++;
    }
    if (absN === 0) {
      this.integratedEnergyLev = 0;
      this.integratedLufsLev = -Infinity;
      this.hasGatedLev = false;
      return;
    }
    var meanAbs = sum / absN;
    var relThresh = meanAbs * REL_GATE_FACTOR;
    var sumG = 0;
    var cntG = 0;
    for (i = 0; i < this.blockCountLev; i++) {
      if (now - this.blockSampleLev[i] > maxAge) continue;
      var e = this.blocksLev[i];
      if (lockOn) {
        var l1 = energyToLoudness(e);
        if (l1 < lockLo || l1 > lockHi) continue;
      }
      if (e >= relThresh) {
        sumG += e;
        cntG++;
      }
    }
    if (cntG === 0) {
      this.integratedEnergyLev = 0;
      this.integratedLufsLev = -Infinity;
      this.hasGatedLev = false;
      return;
    }
    this.integratedEnergyLev = sumG / cntG;
    this.integratedLufsLev = energyToLoudness(this.integratedEnergyLev);
    this.hasGatedLev = Number.isFinite(this.integratedLufsLev);
  }

  interpPeak(preCh, nCh) {
    var peak = 0;
    var ch, f, t;
    for (ch = 0; ch < nCh; ch++) {
      var x = preCh[ch];
      var ax = x < 0 ? -x : x;
      if (ax > peak) peak = ax;
      this.interpZ[ch][this.interpZi] = x;
    }
    for (ch = 0; ch < nCh; ch++) {
      var z = this.interpZ[ch];
      for (f = 0; f < 4; f++) {
        var acc = 0;
        var coeffs = this.interpC[f];
        var indices = this.interpI[f];
        for (t = 0; t < coeffs.length; t++) {
          var pos = this.interpZi - indices[t];
          if (pos < 0) pos += this.interpDelay;
          acc += coeffs[t] * z[pos];
        }
        var a = acc < 0 ? -acc : acc;
        if (a > peak) peak = a;
      }
    }
    return peak;
  }

  // Delayed-output true-peak detector: same 4x tables as interpPeak, separate
  // history fed from the post-limiter delayed output. This is what
  // telemetry.truePeakDb reports, so the reported peak describes the signal
  // that actually left the processor (not the undelayed pre-limiter detector
  // reading that drives scheduleLimiter). The per-quantum value below is held
  // with a 1.5 s exponential decay (see the update site): a zero-output
  // quantum after prior audio reports the decayed hold, not -Infinity.
  outputPeak(outCh, nCh) {
    var peak = 0;
    var ch, f, t;
    for (ch = 0; ch < nCh; ch++) {
      var x = outCh[ch];
      var ax = x < 0 ? -x : x;
      if (ax > peak) peak = ax;
      this.outInterpZ[ch][this.outInterpZi] = x;
    }
    for (ch = 0; ch < nCh; ch++) {
      var z = this.outInterpZ[ch];
      for (f = 0; f < 4; f++) {
        var acc = 0;
        var coeffs = this.interpC[f];
        var indices = this.interpI[f];
        for (t = 0; t < coeffs.length; t++) {
          var pos = this.outInterpZi - indices[t];
          if (pos < 0) pos += this.interpDelay;
          acc += coeffs[t] * z[pos];
        }
        var a = acc < 0 ? -acc : acc;
        if (a > peak) peak = a;
      }
    }
    return peak;
  }

  scheduleLimiter(writeIndex, targetGain) {
    if (!(targetGain < 1)) return;
    // Flat hold at full reduction over the samples leading into the peak,
    // then the attack ramp before that. The flat span (64 samples) covers the
    // true-peak detector's own interpolation span (filter indices 0..24, i.e.
    // 24 past samples) plus the independent oracle's similar span, so the
    // gain multiplying every sample that contributes to the output's
    // interpolated peak is uniformly the deepest scheduled need. A pure
    // attack ramp ending AT the peak leaves the pre-peak samples of the
    // interpolation window under-attenuated (the ramp tail), and the oracle
    // interpolates those into an output true peak ~1 dB hotter than the
    // uniform-gain prediction (measured 2026-10-18 on a phase-break burst:
    // -0.9 dBTP vs the predicted -1.9 dBTP). The ramp slope itself is
    // unchanged — it just completes 64 samples before the peak — so the
    // click profile is the same, and 64 + attack (96 at 48 kHz) still fits
    // inside the 240-sample lookahead.
    var idx = writeIndex;
    var off;
    for (off = 0; off < LIMITER_FLAT_SAMPLES; off++) {
      if (targetGain < this.limiterTargets[idx]) this.limiterTargets[idx] = targetGain;
      idx--;
      if (idx < 0) idx = this.bufferLength - 1;
    }
    var attack = this.limiterAttackFrames;
    var delta = targetGain - 1;
    for (off = 0; off < attack; off++) {
      var ramped = 1 + delta * (1 - off / attack);
      if (ramped < this.limiterTargets[idx]) this.limiterTargets[idx] = ramped;
      idx--;
      if (idx < 0) idx = this.bufferLength - 1;
    }
  }

  stepLimiter(scheduledGain) {
    if (scheduledGain < this.currentLimiterGain) {
      this.currentLimiterGain = scheduledGain;
    } else {
      this.currentLimiterGain = 1 + (this.currentLimiterGain - 1) * this.limiterReleaseCoeff;
    }
    return this.currentLimiterGain;
  }

  process(inputs, outputs) {
    var output = outputs ? outputs[0] : null;
    if (!output || output.length === 0) return true;
    var frameCount = output[0].length;
    var input = inputs ? inputs[0] : null;
    var inCh = input ? input.length : 0;
    if (inCh > 6) inCh = 6;
    var outCh = output.length;
    if (outCh > 6) outCh = 6;

    var sr = this.sr;
    var ceiling = CEILING_LINEAR;
    var marginLin = dbToGain(-TP_DETECTOR_MARGIN_DB);
    var effCeiling = ceiling * marginLin;

    if (!input || inCh === 0) {
      var c0;
      for (c0 = 0; c0 < outCh; c0++) output[c0].fill(0);
      // Disconnected input emits zeros: the reported peak is the same 1.5 s
      // decaying hold as the main path fed with a zero quantum (quantum 0
      // decays the pre-disconnect hold), never a stale pre-disconnect hold.
      this.truePeakTrack = 0 + (this.truePeakTrack - 0) * Math.exp(-frameCount / (sr * 1.5));
      if (!Number.isFinite(this.truePeakTrack)) this.truePeakTrack = 0;
      this.telemetry.integratedLufs = this.integratedLufs;
      this.telemetry.shortTermLufs = this.shortTermLufs;
      this.telemetry.momentaryLufs = this.momentaryLufs;
      this.telemetry.truePeakDb = this.truePeakTrack > 0 ? 20 * Math.log10(this.truePeakTrack) : -Infinity;
      this.telemetry.appliedGainDb = this.appliedGainDb;
      this.telemetry.normGainDb = this.currentLoudnessDb;
      this.telemetry.userTrimDb = this.trimCurrentDb;
      this.telemetry.mode = this.mode;
      this.telemetry.warm = this.warm;
      this.meterCounter++;
      if (this.meterCounter >= METER_EVERY_QUANTA) {
        this.meterCounter = 0;
        this.meterMsg.integratedLufs = this.telemetry.integratedLufs;
        this.meterMsg.shortTermLufs = this.telemetry.shortTermLufs;
        this.meterMsg.momentaryLufs = this.telemetry.momentaryLufs;
        this.meterMsg.truePeakDb = this.telemetry.truePeakDb;
        this.meterMsg.appliedGainDb = this.telemetry.appliedGainDb;
        this.meterMsg.normGainDb = this.telemetry.normGainDb;
        this.meterMsg.userTrimDb = this.telemetry.userTrimDb;
        this.meterMsg.mode = this.telemetry.mode;
        this.meterMsg.warm = this.telemetry.warm;
        try { this.port.postMessage(this.meterMsg); } catch (e) { /* harness stub never throws */ }
      }
      return true;
    }

    // SLOW LOOP: measured from the LEVELLED signal (this.integratedLufsLev),
    // never the raw input and never its own output (no feedback oscillation).
    // The clamp binds the TOTAL program gain (levelling + normalization): the
    // normalization allowance is the clamp minus the levelling's current gain,
    // so a levelling lift on a quiet program never stacks past the clamp. The
    // trim is NOT here — it joins the delay line below, inside the detector's
    // view, outside every loudness measurement.
    var wantWarmLev = this.totalFrames >= Math.round(sr * WARM_SECONDS) && this.hasGatedLev;
    // Onset-guard update (cold only, fast window full): CUT-ONLY pre-cut from
    // the fast levelled probe toward the fixed target; ratchets down only, so
    // quiet content (want >= 0) and digital silence (energy 0 reads -Infinity,
    // want +Infinity) both leave onsetCutDb at 0. NaN-safe: a non-finite want
    // fails the <= test and clamps to 0, and the ratchet compares finite
    // values only.
    if (!this.hasGatedLev && this.fastCount >= this.fastWindow) {
      var fastLevelDb = energyToLoudness(this.fastSum / this.fastWindow);
      var wantOnset = this.targetLufs - fastLevelDb;
      var onsetCut = 0;
      if (wantOnset <= 0) {
        onsetCut = wantOnset < -MAX_CUT_DB ? -MAX_CUT_DB : wantOnset;
      }
      if (onsetCut < this.onsetCutDb) this.onsetCutDb = onsetCut;
    }
    var desiredLoudnessDb = 0;
    if (wantWarmLev) {
      var need = this.targetLufs - this.integratedLufsLev;
      var normMax = MAX_BOOST_DB - this.currentAgcDb;
      var normMin = -MAX_CUT_DB - this.currentAgcDb;
      if (need > normMax) need = normMax;
      if (need < normMin) need = normMin;
      desiredLoudnessDb = need;
    } else if (!this.hasGatedLev) {
      // Cold window: the onset pre-cut REPLACES the hold-at-current value, so
      // a loud onset is cut from ~100 ms instead of passing uncut until the
      // first gated block. Before the fast window is full onsetCutDb is still
      // 0 and this holds unity exactly like before. Handoff: when hasGatedLev
      // first becomes true the slow loop above takes over FROM the current
      // gain — no snap, no reset of currentLoudnessDb.
      desiredLoudnessDb = this.onsetCutDb;
    }
    // Silence gate (§6: silence holds the last gain, never re-targets): with
    // no gated program inside the rolling window — startup, post-reset, or a
    // silence long enough to empty the window - the cold-window desired gain
    // below (the frozen onset pre-cut, i.e. the last gain: silence probes
    // +Infinity-want and clamps to 0, so the ratchet keeps the stale pre-cut)
    // instead of slewing toward unity or toward stale retained history.
    // (During shorter silences the window still holds program blocks but no
    // new block is retained, so integratedLufsLev is frozen and the slew
    // already holds; the AGC branch holds the same way via its own gate.)
    var tc;
    if (desiredLoudnessDb > this.currentLoudnessDb) tc = UP_TC_SECONDS;
    else if (!this.hasGatedLev) tc = FAST_ONSET_TC_SECONDS;
    else tc = DOWN_TC_SECONDS;
    var smooth = Math.exp(-frameCount / (sr * tc));
    var prevLoudnessDb = this.currentLoudnessDb;
    this.currentLoudnessDb = desiredLoudnessDb + (this.currentLoudnessDb - desiredLoudnessDb) * smooth;
    var startLog = prevLoudnessDb * (Math.LN10 / 20);
    var endLog = this.currentLoudnessDb * (Math.LN10 / 20);
    var gainStep = frameCount > 0 ? (endLog - startLog) / frameCount : 0;

    // Trim ramp for this quantum: per-sample LINEAR-IN-dB (geometric in
    // linear gain) from the current trim to the target, completing within
    // this render quantum — no 128-frame step, so no 375 Hz zipper buzz.
    var trimStartDb = this.trimCurrentDb;
    var trimEndDb = this.trimTargetDb;
    var trimStepDb = frameCount > 0 ? (trimEndDb - trimStartDb) / frameCount : 0;
    var trimDbAcc = trimStartDb;

    var quantumTruePeak = 0;

    var readIndex = this.writeIndex + this.bufferLength - this.delayFrames;
    if (readIndex >= this.bufferLength) readIndex -= this.bufferLength;

    var loudLog = startLog;

    var i, ch;
    for (i = 0; i < frameCount; i++) {
      for (ch = 0; ch < inCh; ch++) {
        var chanData = input[ch];
        var sLoad = chanData ? chanData[i] : 0;
        if (!Number.isFinite(sLoad)) sLoad = 0;
        this.rawScratch[ch] = sLoad;
      }

      // WITHIN-PROGRAM LEVELLING (dead-band AGC, feedforward): driven by the
      // RAW metering sums as they stand (one sample of lag — irrelevant at
      // 3 s scales), so the levelling gain never feeds back into its own
      // detector and never reads the integrated measurement's output. Runs
      // in BOTH modes — one comfort chain.
      var agcTargetDb = 0;
      if (this.hasGated && this.pCount >= this.blockSize && Number.isFinite(this.integratedLufs)) {
        var shortDenAgc = this.pCount < this.shortWin ? this.pCount : this.shortWin;
        var stAgc = energyToLoudness(this.sumShort / shortDenAgc);
        var relAgc = energyToLoudness(this.meanAbsRaw * REL_GATE_FACTOR);
        // Silence gate (loudnorm): short-term below the programme's relative
        // gate, or at digital silence, holds the last gain instead of
        // adapting into silence/noise.
        var silentAgc = !(stAgc > relAgc) || !(stAgc > AGC_SILENCE_FLOOR_LUFS);
        if (!silentAgc) {
          var diffAgc = stAgc - this.integratedLufs;
          var adiffAgc = diffAgc < 0 ? -diffAgc : diffAgc;
          // The dead-band (loudnorm INNER_FRAME): inside the band the gain
          // collapses to the static value — NO adaptation at all. Outside,
          // the spread is compressed back to the band edge.
          if (adiffAgc > AGC_BAND_DB) {
            var sgnAgc = diffAgc < 0 ? -1 : 1;
            agcTargetDb = -(diffAgc - sgnAgc * AGC_BAND_DB);
            if (agcTargetDb > AGC_BOOST_CAP_DB) agcTargetDb = AGC_BOOST_CAP_DB;
            // BOOST GATE, fast probe (OURS/house, measured 2026-10-19): the
            // 3 s ST boxcar lags a loud return, so the boost stayed +6 for
            // ~1.5 s after comfort-dialogue's 20 s loud return and those
            // lifted samples pushed the settled tail to -20.50 (gate +-0.20).
            // A boost is therefore applied only while the ~0.1 s probe is
            // itself below the programme mean's dead-band edge (raw domain;
            // the probe's levelled reading has the AGC's current gain undone
            // to compare like with like). The cut direction is untouched (S4).
            if (agcTargetDb > 0 && this.fastCount >= this.fastWindow) {
              var fastLevDb = energyToLoudness(this.fastSum / this.fastWindow);
              var fastRawGate = Number.isFinite(fastLevDb) ? fastLevDb - this.currentAgcDb : -Infinity;
              if (fastRawGate > this.integratedLufs - AGC_BAND_DB) agcTargetDb = 0;
            }
          }
        } else {
          agcTargetDb = this.currentAgcDb;
        }
      }
      // TOTAL-clamp invariant (anti-maximizer): the fast mover is capped by
      // the slow gain's current value, so agc + norm never exceeds the clamp
      // even when the AGC jumps (e.g. quiet -> loud) while the slow gain is
      // frozen. The norm side is capped symmetrically above.
      var agcCapMax = MAX_BOOST_DB - this.currentLoudnessDb;
      var agcCapMin = -MAX_CUT_DB - this.currentLoudnessDb;
      if (agcTargetDb > agcCapMax) agcTargetDb = agcCapMax;
      if (agcTargetDb < agcCapMin) agcTargetDb = agcCapMin;
      // Direct drive: the gain follows ST per sample with NO extra smoothing
      // layer. ST is a 3 s boxcar — already smooth — so per-sample updates
      // cannot zipper. An extra smoothing time constant would stretch every
      // levelling transient across several 100 ms measurement blocks and leak
      // it into the slow loop's gated mean (measured 0.26 LU norm drift on a
      // silence->loud transition with 50 ms smoothing; 0.00 without).
      this.currentAgcDb = agcTargetDb;
      var agcLinSamp = dbToGain(this.currentAgcDb);

      // DUAL METERING. Raw path (telemetry + oracle comparison): the
      // K-filter reads the raw input exactly as before. Levelled path (slow
      // loop): an EXACT second K-filter pass reads the levelled samples, so
      // the normalization gain is measured from the levelled signal. Neither
      // path ever contains the normalization gain itself or the output trim
      // (no feedback, no re-measurement of our own slew).
      var newP = 0;
      var newPLev = 0;
      for (ch = 0; ch < inCh; ch++) {
        var s = this.rawScratch[ch] || 0;
        var w = channelWeight(ch, inCh);
        if (w === 0) continue;
        var v = this.filtV[ch];
        var v1 = v[1], v2 = v[2], v3 = v[3], v4 = v[4];
        var v0 = s - this.kA1 * v1 - this.kA2 * v2 - this.kA3 * v3 - this.kA4 * v4;
        if (!Number.isFinite(v0)) v0 = 0;
        else if (v0 > -1e-30 && v0 < 1e-30) v0 = 0;
        var y = this.kB0 * v0 + this.kB1 * v1 + this.kB2 * v2 + this.kB3 * v3 + this.kB4 * v4;
        if (!Number.isFinite(y)) y = 0;
        else if (y > -1e-30 && y < 1e-30) y = 0;
        v[4] = v3;
        v[3] = v2;
        v[2] = v1;
        v[1] = v0;
        v[0] = v0;
        newP += w * y * y;
        var sL = s * agcLinSamp;
        var vL = this.filtVLev[ch];
        var u1 = vL[1], u2 = vL[2], u3 = vL[3], u4 = vL[4];
        var u0 = sL - this.kA1 * u1 - this.kA2 * u2 - this.kA3 * u3 - this.kA4 * u4;
        if (!Number.isFinite(u0)) u0 = 0;
        else if (u0 > -1e-30 && u0 < 1e-30) u0 = 0;
        var yL = this.kB0 * u0 + this.kB1 * u1 + this.kB2 * u2 + this.kB3 * u3 + this.kB4 * u4;
        if (!Number.isFinite(yL)) yL = 0;
        else if (yL > -1e-30 && yL < 1e-30) yL = 0;
        vL[4] = u3;
        vL[3] = u2;
        vL[2] = u1;
        vL[1] = u0;
        vL[0] = u0;
        newPLev += w * yL * yL;
      }
      if (!Number.isFinite(newP)) newP = 0;
      if (!Number.isFinite(newPLev)) newPLev = 0;
      // Onset-guard fast probe: levelled power into the ~0.1 s ring (one
      // extra ring + sum per sample — owner-accepted CPU cost).
      var fastOut = this.fastCount >= this.fastWindow ? this.fastRing[this.fastIndex] : 0;
      this.fastSum += newPLev - fastOut;
      this.fastRing[this.fastIndex] = newPLev;
      this.fastIndex++;
      if (this.fastIndex >= this.fastWindow) this.fastIndex = 0;
      if (this.fastCount < this.fastWindow) this.fastCount++;

      var shortOut = 0;
      var blockOut = 0;
      if (this.pCount >= this.shortWin) shortOut = this.pRing[this.pIndex];
      if (this.pCount >= this.blockSize) {
        var bIdx = this.pIndex - this.blockSize;
        if (bIdx < 0) bIdx += this.shortWin;
        blockOut = this.pRing[bIdx];
      }
      // Raw ring (telemetry path) advances exactly as before.
      this.sumShort += newP - (this.pCount >= this.shortWin ? shortOut : 0);
      this.sumBlock += newP - (this.pCount >= this.blockSize ? blockOut : 0);
      this.pRing[this.pIndex] = newP;
      // Levelled ring (slow-loop path) advances in lockstep on the same
      // index/count/hop cadence: one hop retains one block on EACH path.
      var shortOutLev = 0;
      var blockOutLev = 0;
      if (this.pCount >= this.shortWin) shortOutLev = this.pRingLev[this.pIndex];
      if (this.pCount >= this.blockSize) {
        var bIdxLev = this.pIndex - this.blockSize;
        if (bIdxLev < 0) bIdxLev += this.shortWin;
        blockOutLev = this.pRingLev[bIdxLev];
      }
      this.sumShortLev += newPLev - (this.pCount >= this.shortWin ? shortOutLev : 0);
      this.sumBlockLev += newPLev - (this.pCount >= this.blockSize ? blockOutLev : 0);
      this.pRingLev[this.pIndex] = newPLev;
      this.pIndex++;
      if (this.pIndex >= this.shortWin) this.pIndex = 0;
      this.pCount++;
      this.hopCounter++;
      if (this.hopCounter >= this.samples100) {
        this.hopCounter -= this.samples100;
        if (this.pCount >= this.blockSize) {
          var blockEnergy = this.sumBlock / this.blockSize;
          if (blockEnergy >= ABS_GATE_ENERGY) {
            if (this.blockCount < MAX_BLOCKS) {
              this.blocks[this.blockWrite] = blockEnergy;
              this.blockWrite++;
              if (this.blockWrite >= MAX_BLOCKS) this.blockWrite = 0;
              this.blockCount++;
            } else {
              this.blocks[this.blockWrite] = blockEnergy;
              this.blockWrite++;
              if (this.blockWrite >= MAX_BLOCKS) this.blockWrite = 0;
            }
            this.recomputeIntegrated();
          }
          var blockEnergyLev = this.sumBlockLev / this.blockSize;
          if (blockEnergyLev >= ABS_GATE_ENERGY) {
            // Rolling slow-loop window: the ring holds the last
            // SLOW_WINDOW_BLOCKS retained blocks (30 s at the 100 ms hop
            // cadence) and then recycles the oldest; older-than-window blocks
            // are additionally expired by elapsed-sample stamp in
            // recomputeLevelled, so sparse retention across silence cannot
            // pin ancient history in the mean.
            if (this.blockCountLev < SLOW_WINDOW_BLOCKS) {
              this.blocksLev[this.blockWriteLev] = blockEnergyLev;
              this.blockSampleLev[this.blockWriteLev] = this.totalFrames;
              this.blockWriteLev++;
              if (this.blockWriteLev >= SLOW_WINDOW_BLOCKS) this.blockWriteLev = 0;
              this.blockCountLev++;
            } else {
              this.blocksLev[this.blockWriteLev] = blockEnergyLev;
              this.blockSampleLev[this.blockWriteLev] = this.totalFrames;
              this.blockWriteLev++;
              if (this.blockWriteLev >= SLOW_WINDOW_BLOCKS) this.blockWriteLev = 0;
            }
            this.recomputeLevelled();
          }
        }
      }
      this.totalFrames++;

      // Output chain (fixed order): levelling (AGC) FIRST, then the slow
      // normalization gain (measured from the levelled signal above), then
      // the user trim — ALL written INTO the delay line, exactly as the
      // detector measured them. The detector must measure exactly the samples
      // the scheduled gain is applied to, with every output-carrying gain
      // already multiplied in (ffmpeg loudnorm: limiter_buf[...] = buf[...] *
      // gain * offset; EBU Tech 3344 §6.9/B.5: volume stage before the
      // limiter). A trim change therefore takes effect after the 5 ms
      // lookahead — the cost of the device topology — instead of punching
      // through the ceiling (a gain at the READ side is outside the detector
      // and breaks the ceiling by exactly that gain; cf. alimiter level_out).
      // The true-peak limiter stays LAST: output can never exceed the ceiling
      // however gains move, because each scheduled reduction was computed
      // from the already-gained sample it multiplies.
      var loudLin = Math.exp(loudLog);
      loudLog += gainStep;
      trimDbAcc += trimStepDb;
      var trimLin = dbToGain(trimDbAcc);
      var nOut = outCh;
      for (ch = 0; ch < nOut; ch++) {
        var srcCh = ch < inCh ? ch : 0;
        var rawS = this.rawScratch[srcCh] || 0;
        this.preScratch[ch] = rawS * agcLinSamp * loudLin * trimLin;
      }
      var framePeak = this.interpPeak(this.preScratch, nOut);
      if (!Number.isFinite(framePeak)) framePeak = 0;
      if (framePeak > effCeiling) {
        var need = effCeiling / framePeak;
        this.scheduleLimiter(this.writeIndex, need);
      }

      var limGain = this.stepLimiter(this.limiterTargets[readIndex]);
      // Delay line carries the FULL program (levelling + normalization +
      // trim): the sample the detector measured is the sample that is
      // delayed, so the scheduled reduction always matches the sample it
      // multiplies — including across a runtime trim change (samples already
      // in the line keep the trim they were measured with; only newly written
      // samples carry the new trim, and the detector sees each of them).
      for (ch = 0; ch < nOut; ch++) {
        this.channelBuffers[ch][this.writeIndex] = this.preScratch[ch];
      }
      for (ch = 0; ch < nOut; ch++) {
        var delayed = this.channelBuffers[ch][readIndex];
        var o = delayed * limGain;
        if (!Number.isFinite(o)) o = 0;
        if (o > ceiling) o = ceiling;
        else if (o < -ceiling) o = -ceiling;
        output[ch][i] = o;
        this.outScratch[ch] = o;
      }
      // Reported true peak describes the DELAYED post-limiter output above
      // (what left the processor this sample), not the undelayed pre-limiter
      // detector reading (framePeak) that drives scheduleLimiter. Mixing
      // framePeak (now) with limGain (then) mislabels time: on a zero-output
      // quantum (delay-line fill) it reports a non-zero peak for silence.
      // The quantum peak below is held with a 1.5 s decay (choice b), so the
      // hold never under-reports the current quantum's output peak.
      var outFramePeak = this.outputPeak(this.outScratch, nOut);
      if (!Number.isFinite(outFramePeak)) outFramePeak = 0;
      if (outFramePeak > quantumTruePeak) quantumTruePeak = outFramePeak;
      this.limiterTargets[readIndex] = 1;
      this.writeIndex++;
      if (this.writeIndex >= this.bufferLength) this.writeIndex = 0;
      readIndex++;
      if (readIndex >= this.bufferLength) readIndex = 0;
      this.interpZi++;
      if (this.interpZi >= this.interpDelay) this.interpZi = 0;
      this.outInterpZi++;
      if (this.outInterpZi >= this.interpDelay) this.outInterpZi = 0;
    }

    this.warm = this.totalFrames >= Math.round(sr * WARM_SECONDS) && this.hasGated;
    if (this.pCount >= this.blockSize) {
      this.momentaryLufs = energyToLoudness(this.sumBlock / this.blockSize);
    }
    var shortDen = this.pCount < this.shortWin ? this.pCount : this.shortWin;
    if (shortDen > 0 && this.pCount >= this.blockSize) {
      this.shortTermLufs = energyToLoudness(this.sumShort / shortDen);
    }
    if (quantumTruePeak > this.truePeakTrack) {
      this.truePeakTrack = quantumTruePeak;
    } else {
      this.truePeakTrack = quantumTruePeak + (this.truePeakTrack - quantumTruePeak) * Math.exp(-frameCount / (sr * 1.5));
    }
    if (!Number.isFinite(this.truePeakTrack)) this.truePeakTrack = 0;
    // Total PROGRAM gain (levelling + slow normalization), EXCLUDING the user
    // trim: the settle story and the clamp story live here. The trim is
    // reported separately (userTrimDb) and never perturbs this trace.
    this.appliedGainDb = this.currentLoudnessDb + this.currentAgcDb;
    this.trimCurrentDb = trimEndDb;
    this.telemetry.normGainDb = this.currentLoudnessDb;

    this.telemetry.integratedLufs = this.integratedLufs;
    this.telemetry.shortTermLufs = this.shortTermLufs;
    this.telemetry.momentaryLufs = this.momentaryLufs;
    this.telemetry.truePeakDb = this.truePeakTrack > 0 ? 20 * Math.log10(this.truePeakTrack) : -Infinity;
    this.telemetry.appliedGainDb = this.appliedGainDb;
    this.telemetry.userTrimDb = this.trimCurrentDb;
    this.telemetry.mode = this.mode;
    this.telemetry.warm = this.warm;

    this.meterCounter++;
    if (this.meterCounter >= METER_EVERY_QUANTA) {
      this.meterCounter = 0;
      this.meterMsg.integratedLufs = this.telemetry.integratedLufs;
      this.meterMsg.shortTermLufs = this.telemetry.shortTermLufs;
      this.meterMsg.momentaryLufs = this.telemetry.momentaryLufs;
      this.meterMsg.truePeakDb = this.telemetry.truePeakDb;
      this.meterMsg.appliedGainDb = this.telemetry.appliedGainDb;
      this.meterMsg.normGainDb = this.telemetry.normGainDb;
      this.meterMsg.userTrimDb = this.telemetry.userTrimDb;
      this.meterMsg.mode = this.telemetry.mode;
      this.meterMsg.warm = this.telemetry.warm;
      try { this.port.postMessage(this.meterMsg); } catch (e) { /* stub-safe */ }
    }
    return true;
  }
}

registerProcessor('loudness-normalizer', LoudnessNormalizerProcessor);
