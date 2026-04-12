const LOUDNESS_OFFSET = -0.691;
const HOP_SECONDS = 0.1;
const BLOCK_SECONDS = 0.4;

// Fixed intensity=50 parameters (middle of V3.5 range)
const TARGET_LUFS = -16;
const COMFORT_MIN_LUFS = -23.5;
const COMFORT_MAX_LUFS = -18;
const MAX_BOOST_DB = 6;
const MAX_CUT_DB = 11;
const BAND_STRENGTH = 0.55;
const BAND_DEADBAND_DB = 1.3;
const LOCAL_BOOST_STRENGTH = 0.21;
const LOCAL_CUT_STRENGTH = 0.38;
const LOCAL_MAX_BOOST_DB = 3;
const LOCAL_MAX_CUT_DB = 5.5;
const LOCAL_DEADBAND_DB = 3.5;
const DOWN_TIME_SECONDS = 0.08;
const UP_TIME_SECONDS = 2.9;
const MOMENTARY_TAU = 0.365;
const SHORT_TAU = 2.9;
const PROGRAM_TAU = 13;
const PEAK_TAU = 0.925;
const CEILING_DB = -1;
const CEILING_LINEAR = Math.pow(10, CEILING_DB / 20);
const LIMITER_ATTACK_SECONDS = 0.003;
const LIMITER_RELEASE_SECONDS = 0.1;
// LIMITER_RELEASE_COEFF calculated per-context in constructor using actual sampleRate
const SOFT_KNEE_DB = 3;
const ABSOLUTE_GATE_DB = -50;
const RELATIVE_GATE_OFFSET_DB = 10;
const GATE_PEAK = 0.01;
const MIN_ANALYSIS_SECONDS = 0.35;
const STARTUP_ASSIST_SECONDS = 0.75;
const STARTUP_MAX_BOOST_DB = 3;
const STARTUP_MAX_CUT_DB = 4;

class LoudnessNormalizerProcessor extends AudioWorkletProcessor {
  constructor() {
    super();

    this.currentGain = 1;
    this.currentLimiterGain = 1;
    this.userGainDb = 0;
    this.userGainLinear = 1;
    this.hopPeak = 0;
    this.peakFollower = 0;
    this.analysisFrames = 0;
    this.startupAssistFrames = Math.max(1, Math.round(sampleRate * STARTUP_ASSIST_SECONDS));
    this.startupFramesRemaining = this.startupAssistFrames;

    // Three-window loudness from V3.5
    this.momentarySq = 0;
    this.shortSq = 0;
    this.programSq = 0;

    this.delayFrames = Math.max(128, Math.round(sampleRate * LIMITER_ATTACK_SECONDS));
    this.limiterReleaseCoeff = Math.exp(-1 / (sampleRate * LIMITER_RELEASE_SECONDS));
    this.bufferLength = this.nextPowerOfTwo(this.delayFrames + 2048);
    this.channelBuffers = [];
    this.analysisFilters = [];
    this.inputPeakHistory = [];
    this.limiterTargets = new Float32Array(this.bufferLength);
    this.limiterTargets.fill(1);
    this.writeIndex = 0;
    this.limiterAttackFrames = Math.max(1, Math.round(sampleRate * LIMITER_ATTACK_SECONDS));

    this.hopFrameTarget = Math.max(1, Math.round(sampleRate * HOP_SECONDS));
    this.blockHopCount = Math.max(1, Math.round(BLOCK_SECONDS / HOP_SECONDS));
    this.minAnalysisFrames = Math.round(sampleRate * MIN_ANALYSIS_SECONDS);
    this.hopEnergy = 0;
    this.hopFrames = 0;
    this.hopPowers = [];

    this.port.onmessage = (event) => {
      if (event.data?.type === 'set-gain-db') {
        this.userGainDb = clamp(event.data.gainDb, MIN_GAIN_DB, MAX_GAIN_DB);
        this.userGainLinear = dbToGain(this.userGainDb);
        return;
      }

      if (event.data?.type === 'start-normalizing') {
        this.startupFramesRemaining = this.startupAssistFrames;
      }
    };
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];

    if (!output.length) return true;

    const frameCount = output[0].length;
    const inCh = Math.max(input.length, 1);
    const outCh = output.length;

    this.ensureBuffers(outCh);
    this.ensureFilters(inCh);
    this.ensurePeaks(outCh);

    if (!input.length) {
      for (let c = 0; c < outCh; c++) output[c].fill(0);
      return true;
    }

    // Process block for loudness measurement (V3.5 style)
    let blockPeak = 0;
    let blockSq = 0;

    for (let i = 0; i < frameCount; i++) {
      for (let ch = 0; ch < input.length; ch++) {
        const sample = input[ch][i] ?? 0;
        const absolute = Math.abs(sample);
        if (absolute > blockPeak) blockPeak = absolute;

        const weighted = this.weight(ch, sample);
        blockSq += weighted * weighted;
      }
    }

    blockSq /= frameCount * input.length;
    this.updateMeasurement(blockSq, blockPeak, frameCount);

    // Compute target gain using V3.5's superior algorithm
    const momentaryDb = powerToDb(this.momentarySq);
    const shortDb = powerToDb(this.shortSq);
    const programDb = powerToDb(this.programSq || this.shortSq || blockSq);

    const gateDb = Math.max(lufsToInternalDb(ABSOLUTE_GATE_DB), programDb - RELATIVE_GATE_OFFSET_DB);
    const quietBlock = this.analysisFrames < this.minAnalysisFrames ||
      (shortDb < gateDb && blockPeak < GATE_PEAK);

    let targetGain = 1;
    if (!quietBlock) {
      targetGain = this.computeTargetGain(momentaryDb, shortDb, programDb, blockPeak);
    }

    const startupGain = this.computeStartupAssist(momentaryDb, shortDb, programDb, blockPeak, quietBlock, frameCount);

    // Smooth gain changes
    const transitionSeconds = targetGain < this.currentGain ? DOWN_TIME_SECONDS : UP_TIME_SECONDS;
    const smoothing = Math.exp(-frameCount / (sampleRate * transitionSeconds));
    const nextGain = targetGain + (this.currentGain - targetGain) * smoothing;

    const startLog = Math.log(Math.max(this.currentGain, 1e-5));
    const endLog = Math.log(Math.max(nextGain, 1e-5));
    const gainStep = (endLog - startLog) / frameCount;

    let processLimiterGain = this.currentLimiterGain;

    // Process audio with lookahead limiting (V5's superior limiter)
    for (let i = 0; i < frameCount; i++) {
      const readIndex = (this.writeIndex + this.bufferLength - this.delayFrames) % this.bufferLength;

      let framePeak = 0;
      for (let ch = 0; ch < inCh; ch++) {
        const sample = input[ch]?.[i] ?? input[0]?.[i] ?? 0;
        const tp = pushTruePeak(this.inputPeakHistory[ch], sample);
        if (tp > framePeak) framePeak = tp;
      }

      this.scheduleLimiter(this.writeIndex, this.calcLimiterTarget(framePeak));

      const loudnessGain = Math.exp(startLog + gainStep * i);
      processLimiterGain = this.stepLimiter(this.limiterTargets[readIndex]);
      const totalGain = loudnessGain * startupGain * this.userGainLinear * processLimiterGain;

      for (let ch = 0; ch < outCh; ch++) {
        const ic = input[ch] ?? input[0];
        const writeSample = ic?.[i] ?? 0;
        const delayed = this.channelBuffers[ch][readIndex];
        const processed = applySoftKnee(delayed * totalGain, CEILING_LINEAR, SOFT_KNEE_DB);
        output[ch][i] = processed;
        this.channelBuffers[ch][this.writeIndex] = writeSample;
      }

      this.limiterTargets[readIndex] = 1;
      this.writeIndex = (this.writeIndex + 1) % this.bufferLength;
    }

    this.currentGain = nextGain;
    this.currentLimiterGain = processLimiterGain;

    return true;
  }

  // V3.5's superior three-window measurement
  updateMeasurement(blockSq, blockPeak, frameCount) {
    const momentaryCoeff = Math.exp(-frameCount / (sampleRate * MOMENTARY_TAU));
    const shortCoeff = Math.exp(-frameCount / (sampleRate * SHORT_TAU));
    const programCoeff = Math.exp(-frameCount / (sampleRate * PROGRAM_TAU));

    this.momentarySq = this.momentarySq === 0
      ? blockSq
      : blockSq + (this.momentarySq - blockSq) * momentaryCoeff;

    this.shortSq = this.shortSq === 0
      ? blockSq
      : blockSq + (this.shortSq - blockSq) * shortCoeff;

    // Gated program loudness from V3.5
    const shortDb = powerToDb(this.shortSq);
    const currentProgramDb = powerToDb(this.programSq || this.shortSq || blockSq);
    const gateDb = Math.max(lufsToInternalDb(ABSOLUTE_GATE_DB), currentProgramDb - RELATIVE_GATE_OFFSET_DB);
    const shouldTrackProgram = this.programSq === 0 || shortDb >= gateDb || blockPeak >= GATE_PEAK;

    if (shouldTrackProgram) {
      this.programSq = this.programSq === 0
        ? blockSq
        : blockSq + (this.programSq - blockSq) * programCoeff;
    }

    // Update peak follower and frame count (V3.5 style - before gain computation)
    const peakCoeff = Math.exp(-frameCount / (sampleRate * PEAK_TAU));
    this.peakFollower = blockPeak * blockPeak + (this.peakFollower - blockPeak * blockPeak) * peakCoeff;
    this.analysisFrames += frameCount;
  }

  // V3.5's superior multi-zone gain computation
  computeTargetGain(momentaryDb, shortDb, programDb, blockPeak) {
    const targetDb = lufsToInternalDb(TARGET_LUFS);
    const comfortMinDb = lufsToInternalDb(COMFORT_MIN_LUFS);
    const comfortMaxDb = lufsToInternalDb(COMFORT_MAX_LUFS);

    let desiredDb = 0;

    // Comfort zone band - only correct when outside comfortable range
    const quietFloorDb = comfortMinDb - BAND_DEADBAND_DB;
    const loudCeilingDb = comfortMaxDb + BAND_DEADBAND_DB;

    if (programDb < quietFloorDb) {
      desiredDb += (quietFloorDb - programDb) * BAND_STRENGTH;
    } else if (programDb > loudCeilingDb) {
      desiredDb -= (programDb - loudCeilingDb) * BAND_STRENGTH;
    }

    // Local dynamics - handle momentary spikes/dips differently from program
    const loudDeltaDb = Math.max(momentaryDb, shortDb) - programDb;
    if (loudDeltaDb > LOCAL_DEADBAND_DB) {
      desiredDb -= Math.min(
        (loudDeltaDb - LOCAL_DEADBAND_DB) * LOCAL_CUT_STRENGTH,
        LOCAL_MAX_CUT_DB
      );
    } else {
      const quietDeltaDb = programDb - shortDb;
      if (quietDeltaDb > LOCAL_DEADBAND_DB) {
        desiredDb += Math.min(
          (quietDeltaDb - LOCAL_DEADBAND_DB) * LOCAL_BOOST_STRENGTH,
          LOCAL_MAX_BOOST_DB
        );
      }
    }

    desiredDb = Math.max(-MAX_CUT_DB, Math.min(MAX_BOOST_DB, desiredDb));
    if (Math.abs(desiredDb) < 0.2) return 1;

    let targetGain = dbToGain(desiredDb);

    // Peak protection (V3.5 style + V5's better peak following)
    const smoothedPeak = Math.max(blockPeak, Math.sqrt(this.peakFollower));
    const predictedPeak = smoothedPeak * targetGain;
    if (predictedPeak > CEILING_LINEAR) {
      targetGain *= CEILING_LINEAR / predictedPeak;
    }

    return targetGain;
  }

  computeStartupAssist(momentaryDb, shortDb, programDb, blockPeak, quietBlock, frameCount) {
    if (this.startupFramesRemaining <= 0 || quietBlock) {
      this.startupFramesRemaining = Math.max(0, this.startupFramesRemaining - frameCount);
      return 1;
    }

    const comfortMinDb = lufsToInternalDb(COMFORT_MIN_LUFS);
    const comfortMaxDb = lufsToInternalDb(COMFORT_MAX_LUFS);
    const loudDb = Math.max(momentaryDb, shortDb);
    let assistDb = 0;

    if (shortDb < comfortMinDb) {
      assistDb = Math.min(comfortMinDb - shortDb, STARTUP_MAX_BOOST_DB);
    } else if (loudDb > comfortMaxDb) {
      assistDb = -Math.min(loudDb - comfortMaxDb, STARTUP_MAX_CUT_DB);
    }

    const fade = this.startupFramesRemaining / this.startupAssistFrames;
    this.startupFramesRemaining = Math.max(0, this.startupFramesRemaining - frameCount);

    if (assistDb === 0) return 1;

    let assistGain = dbToGain(assistDb * fade);
    if (assistGain > 1 && blockPeak > 0) {
      assistGain = Math.min(assistGain, CEILING_LINEAR / blockPeak);
    }
    return Math.max(0.25, Math.min(4, assistGain));
  }

  calcLimiterTarget(peak) {
    if (!Number.isFinite(peak) || peak <= CEILING_LINEAR) return 1;
    return Math.max(0.05, Math.min(1, CEILING_LINEAR / peak));
  }

  scheduleLimiter(writeIndex, targetGain) {
    if (targetGain >= 1) return;
    for (let off = 0; off < this.limiterAttackFrames; off++) {
      const ramp = 1 - off / this.limiterAttackFrames;
      const idx = (writeIndex - off + this.bufferLength) % this.bufferLength;
      const ramped = 1 + (targetGain - 1) * ramp;
      this.limiterTargets[idx] = Math.min(this.limiterTargets[idx], ramped);
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

  ensureBuffers(n) {
    while (this.channelBuffers.length < n)
      this.channelBuffers.push(new Float32Array(this.bufferLength));
  }

  ensureFilters(n) {
    while (this.analysisFilters.length < n)
      this.analysisFilters.push(createKWeightingChannel());
  }

  ensurePeaks(n) {
    while (this.inputPeakHistory.length < n)
      this.inputPeakHistory.push([0, 0, 0, 0]);
  }

  weight(channel, sample) {
    let out = sample;
    for (const stage of this.analysisFilters[channel])
      out = processBiquad(stage, out);
    return out;
  }

  nextPowerOfTwo(v) {
    let n = 1;
    while (n < v) n <<= 1;
    return n;
  }
}

function dbToGain(db) { return Math.pow(10, db / 20); }
function gainToDb(gain) { return 20 * Math.log10(Math.max(gain, 1e-5)); }
function clamp(value, min, max) { return Math.max(min, Math.min(max, Number(value) || 0)); }

const MIN_GAIN_DB = -6;
const MAX_GAIN_DB = 6;

function lufsToInternalDb(lufs) {
  return lufs - LOUDNESS_OFFSET;
}

function powerToDb(power) {
  return 10 * Math.log10(power + 1e-12);
}

function applySoftKnee(sample, ceiling, kneeDb) {
  const abs = Math.abs(sample);
  if (abs <= ceiling) return sample;
  const kneeRatio = dbToGain(kneeDb);
  const norm = (abs - ceiling) / Math.max(ceiling / kneeRatio, 1e-5);
  const limited = Math.min(ceiling, abs * (1 - Math.tanh(norm * 2) * 0.1));
  return Math.sign(sample) * limited;
}

function pushTruePeak(history, sample) {
  history[0] = history[1];
  history[1] = history[2];
  history[2] = history[3];
  history[3] = sample;

  let peak = Math.abs(history[2]);
  const a0 = -0.5 * history[0] + 1.5 * history[1] - 1.5 * history[2] + 0.5 * history[3];
  const a1 = history[0] - 2.5 * history[1] + 2 * history[2] - 0.5 * history[3];
  const a2 = -0.5 * history[0] + 0.5 * history[2];
  const a3 = history[1];

  for (let idx = 1; idx <= 3; idx++) {
    const t = idx * 0.25;
    const interp = ((a0 * t + a1) * t + a2) * t + a3;
    peak = Math.max(peak, Math.abs(interp));
  }
  return peak;
}

function createBiquadState(coeffs) {
  return { ...coeffs, x1: 0, x2: 0, y1: 0, y2: 0 };
}

function createKWeightingChannel() {
  return [
    createBiquadState(designHighShelf(sampleRate, 1681.97, 0.71, 4)),
    createBiquadState(designHighPass(sampleRate, 38.14, 0.5)),
  ];
}

function processBiquad(state, input) {
  const output = state.b0 * input + state.b1 * state.x1 + state.b2 * state.x2 -
    state.a1 * state.y1 - state.a2 * state.y2;
  state.x2 = state.x1;
  state.x1 = input;
  state.y2 = state.y1;
  state.y1 = output;
  return output;
}

function designHighPass(fs, frequency, q) {
  const w = 2 * Math.PI * frequency / fs;
  const c = Math.cos(w);
  const s = Math.sin(w);
  const a = s / (2 * q);
  const a0 = 1 + a;
  return {
    b0: ((1 + c) / 2) / a0, b1: (-(1 + c)) / a0, b2: ((1 + c) / 2) / a0,
    a1: (-2 * c) / a0, a2: (1 - a) / a0,
  };
}

function designHighShelf(fs, frequency, q, gainDb) {
  const A = Math.pow(10, gainDb / 40);
  const w = 2 * Math.PI * frequency / fs;
  const c = Math.cos(w);
  const s = Math.sin(w);
  const alpha = (s / 2) * Math.sqrt((A + 1 / A) * (1 / q - 1) + 2);
  const beta = 2 * Math.sqrt(A) * alpha;
  const a0 = (A + 1) - (A - 1) * c + beta;
  return {
    b0: (A * ((A + 1) + (A - 1) * c + beta)) / a0,
    b1: (-2 * A * ((A - 1) + (A + 1) * c)) / a0,
    b2: (A * ((A + 1) + (A - 1) * c - beta)) / a0,
    a1: (2 * ((A - 1) - (A + 1) * c)) / a0,
    a2: ((A + 1) - (A - 1) * c - beta) / a0,
  };
}

registerProcessor('loudness-normalizer', LoudnessNormalizerProcessor);
