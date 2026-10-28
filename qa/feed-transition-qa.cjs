'use strict';
/*
 * qa/feed-transition-qa.cjs — feed-boundary (reset-program) transition harness.
 * Local-only (qa/ is gitignored).
 *
 * SAFETY: pure Node, no browser, no Chromium, no Playwright, no audio device,
 * no sound, no ffmpeg. The worklet source runs inside node:vm with a stub
 * AudioWorkletProcessor / registerProcessor / sampleRate (same pattern as
 * qa/loudness-verify.cjs renderThroughWorkletChannels: proc.process([ins],
 * [ous]) with 128-frame quanta, gain trace from proc.telemetry.appliedGainDb).
 * NOTE: qa/worklet-equivalence-qa.cjs is browser/OfflineAudioContext-based and
 * has no vm loadProcessor pattern; this harness follows the repo's canonical
 * vm pattern (loudness-verify / worklet-silent-analysis) instead.
 *
 * Flow: settle programme A (1 kHz sine), post reset-program, switch to
 * programme B ~6 dB louder. References G_A / G_B come from cold solo renders.
 *
 * Exit codes: 0 = all rows PASS; 2 = any FAIL or UNTESTED; 1 = harness error.
 */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const repoRoot = path.resolve(__dirname, '..');
const WORKLET_PATH = path.join(repoRoot, 'audio', 'normalizer-worklet.js');

const SR = 48000;
const BLOCK = 128;
const FREQ = 1000;
const AMP_A = 0.1;   // programme A
const AMP_B = 0.2;   // ~+6.02 dB above A (20*log10(2))
const AMP_Q = 0.01;  // quieter control (~-20 dB below A)
const AMP_LOUD = 0.5;  // A6-INFO loud onset probe (settles near -10 dB gain)
const AMP_QUIET = 0.02; // A6-INFO quiet onset probe

const PRE_A_SEC = 12;   // A pre-roll (slow boost TC 3 s: residual ~0.1 dB)
const REF_B_SEC = 8;    // B solo reference (cut direction: fast)
const POST_SEC = 2;     // post-boundary render for F3 / controls
const NCH = 2;

function loadProcessor(source, rate) {
  let Captured = null;
  const sandbox = {
    sampleRate: rate,
    console,
    registerProcessor: (_name, cls) => { Captured = cls; },
    AudioWorkletProcessor: class {
      constructor() { this.port = { onmessage: null, postMessage() {} }; }
    },
  };
  const context = vm.createContext(sandbox);
  vm.runInContext(source, context, { filename: 'normalizer-worklet.vm.js' });
  if (!Captured) throw new Error('HARNESS BROKEN: registerProcessor was never called');
  return Captured;
}

function makeSine(amp, seconds) {
  const n = Math.round(seconds * SR);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = amp * Math.sin(2 * Math.PI * FREQ * i / SR);
  return x;
}

// Render a mono signal duplicated to NCH channels; per-quantum telemetry gain
// trace plus full outputs. Returns { outs, trace, badGain, badOut }.
function render(proc, signal) {
  const n = signal.length;
  const outs = [];
  for (let c = 0; c < NCH; c++) outs.push(new Float32Array(n));
  const trace = [];
  let badGain = 0;
  let badOut = 0;
  for (let pos = 0; pos < n; pos += BLOCK) {
    const len = Math.min(BLOCK, n - pos);
    const ins = [];
    const ous = [];
    for (let c = 0; c < NCH; c++) {
      const a = new Float32Array(BLOCK);
      for (let i = 0; i < len; i++) a[i] = signal[pos + i];
      ins.push(a);
      ous.push(new Float32Array(BLOCK));
    }
    proc.process([ins], [ous]);
    for (let c = 0; c < NCH; c++) {
      const oc = ous[c];
      const dst = outs[c];
      for (let i = 0; i < len; i++) {
        const v = oc[i];
        dst[pos + i] = v;
        if (!Number.isFinite(v)) badOut++;
      }
    }
    const g = proc.telemetry.appliedGainDb;
    trace.push(g);
    if (!Number.isFinite(g)) badGain++;
  }
  return { outs, trace, badGain, badOut };
}

function atTime(trace, tSec) {
  const idx = Math.min(trace.length - 1, Math.floor(tSec * SR / BLOCK));
  return { v: trace[idx], t: (idx + 1) * BLOCK / SR, idx };
}

function spreadLast(trace, seconds) {
  const k = Math.max(1, Math.round(seconds * SR / BLOCK));
  const tail = trace.slice(-k);
  let mn = Infinity, mx = -Infinity;
  for (const v of tail) {
    if (!Number.isFinite(v)) return { spread: NaN, ok: false };
    if (v < mn) mn = v;
    if (v > mx) mx = v;
  }
  return { spread: mx - mn, ok: true };
}

function fmt(v, d) {
  if (v === null || v === undefined) return 'n/a';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return String(v);
    return (v >= 0 ? '+' : '') + v.toFixed(d === undefined ? 3 : d);
  }
  return String(v);
}

function main() {
  const source = fs.readFileSync(WORKLET_PATH, 'utf8');
  if (!source.includes('reset-program')) {
    console.error('HARNESS BROKEN: worklet has no reset-program handler');
    process.exitCode = 1;
    return;
  }
  const Proc = loadProcessor(source, SR);
  const rows = [];
  let untested = 0;
  const push = (name, measured, bound, pass, note) => {
    rows.push({ name, measured, bound, pass, note: note || '' });
  };

  // References from cold.
  const procA = new Proc();
  procA.port.onmessage({ data: { type: 'set-gain-db', gainDb: 0 } });
  const rA = render(procA, makeSine(AMP_A, PRE_A_SEC));
  const GA = rA.trace[rA.trace.length - 1];
  const sA = spreadLast(rA.trace, 2);
  const procB = new Proc();
  procB.port.onmessage({ data: { type: 'set-gain-db', gainDb: 0 } });
  const rB = render(procB, makeSine(AMP_B, REF_B_SEC));
  const GB = rB.trace[rB.trace.length - 1];
  const sB = spreadLast(rB.trace, 2);
  if (!sA.ok || sA.spread > 0.3 || !sB.ok || sB.spread > 0.3 || !Number.isFinite(GA) || !Number.isFinite(GB)) {
    untested++;
    push('REF-settled', 'spreadA=' + fmt(sA.spread) + ' spreadB=' + fmt(sB.spread), '<=0.300', false, 'UNTESTED reference');
  } else {
    push('REF-settled', 'spreadA=' + fmt(sA.spread) + ' spreadB=' + fmt(sB.spread), '<=0.300', true, '');
  }

  // MAIN: A -> reset-program (x2: missing + duplicate generation) -> B.
  const proc = new Proc();
  proc.port.onmessage({ data: { type: 'set-gain-db', gainDb: 0 } });
  render(proc, makeSine(AMP_A, PRE_A_SEC));
  const preReset = proc.telemetry.appliedGainDb;
  proc.port.onmessage({ data: { type: 'reset-program' } });
  const postImmediate = proc.currentLoudnessDb + proc.currentAgcDb;
  proc.port.onmessage({ data: { type: 'reset-program', generation: 7 } }); // duplicate: no-op
  const postDup = proc.currentLoudnessDb + proc.currentAgcDb;
  const rMain = render(proc, makeSine(AMP_B, POST_SEC));
  const f2 = Math.abs(postImmediate - preReset);
  const f2dup = Math.abs(postDup - preReset);
  push('F2 continuity', fmt(postImmediate - preReset) + ' dB (dup ' + fmt(f2dup) + ')', '<=0.100', f2 <= 0.1 && f2dup <= 0.1, 'Gpre=' + fmt(preReset));
  const g250 = atTime(rMain.trace, 0.25);
  const g500 = atTime(rMain.trace, 0.5);
  push('F3 @250ms', fmt(g250.v - GB) + ' dB (g=' + fmt(g250.v) + ' GB=' + fmt(GB) + ')', '<=1.500', Math.abs(g250.v - GB) <= 1.5, '');
  push('F3 @500ms', fmt(g500.v - GB) + ' dB (g=' + fmt(g500.v) + ' GB=' + fmt(GB) + ')', '<=0.500', Math.abs(g500.v - GB) <= 0.5, '');

  // SAME-loudness control: A -> reset -> A.
  const procS = new Proc();
  procS.port.onmessage({ data: { type: 'set-gain-db', gainDb: 0 } });
  render(procS, makeSine(AMP_A, PRE_A_SEC));
  procS.port.onmessage({ data: { type: 'reset-program' } });
  const rSame = render(procS, makeSine(AMP_A, POST_SEC));
  const s250 = atTime(rSame.trace, 0.25);
  push('SAME @250ms', fmt(s250.v - GA) + ' dB (g=' + fmt(s250.v) + ' GA=' + fmt(GA) + ')', '<=0.500', Math.abs(s250.v - GA) <= 0.5, '');

  // QUIETER control: A -> reset -> quiet; no positive gain in first 400 ms.
  const procQ = new Proc();
  procQ.port.onmessage({ data: { type: 'set-gain-db', gainDb: 0 } });
  render(procQ, makeSine(AMP_A, PRE_A_SEC));
  const preQ = procQ.telemetry.appliedGainDb;
  procQ.port.onmessage({ data: { type: 'reset-program' } });
  const rQuiet = render(procQ, makeSine(AMP_Q, 0.5));
  const k400 = Math.min(rQuiet.trace.length, Math.round(0.4 * SR / BLOCK));
  let maxUp = -Infinity;
  for (let i = 0; i < k400; i++) {
    const d = rQuiet.trace[i] - preQ;
    if (!Number.isFinite(d)) { maxUp = NaN; break; }
    if (d > maxUp) maxUp = d;
  }
  push('QUIET max+400ms', fmt(maxUp) + ' dB', '<=+0.100', Number.isFinite(maxUp) && maxUp <= 0.1, 'pre=' + fmt(preQ));

  // NEGATIVE control: A -> B with NO reset must FAIL the 250 ms bound.
  const procN = new Proc();
  procN.port.onmessage({ data: { type: 'set-gain-db', gainDb: 0 } });
  render(procN, makeSine(AMP_A, PRE_A_SEC));
  const rNeg = render(procN, makeSine(AMP_B, POST_SEC));
  const n250 = atTime(rNeg.trace, 0.25);
  const negDev = Math.abs(n250.v - GB);
  push('NEG no-reset', fmt(n250.v - GB) + ' dB (must FAIL 1.5)', '>1.500', negDev > 1.5, negDev > 1.5 ? 'control valid' : 'HARNESS BROKEN');

  // NaN sweep over every trace and output.
  let badG = rA.badGain + rB.badGain + rMain.badGain + rSame.badGain + rQuiet.badGain + rNeg.badGain;
  let badO = rA.badOut + rB.badOut + rMain.badOut + rSame.badOut + rQuiet.badOut + rNeg.badOut;
  for (const r of [rA, rB, rMain, rSame, rQuiet, rNeg]) {
    for (const t of r.trace) if (!Number.isFinite(t)) badG++;
  }
  push('NAN sweep', 'gain=' + badG + ' out=' + badO, '0/0', badG === 0 && badO === 0, '');

  // Digital silence stays bit-zero (fresh processor).
  const procZ = new Proc();
  procZ.port.onmessage({ data: { type: 'set-gain-db', gainDb: 0 } });
  const rZ = render(procZ, new Float32Array(512));
  let nz = 0;
  for (const ch of rZ.outs) for (let i = 0; i < ch.length; i++) if (ch[i] !== 0) nz++;
  push('SILENCE bit-zero', nz + ' nonzero', '0', nz === 0, rZ.badOut === 0 ? '' : 'non-finite in silence out');

  // A6-INFO (non-gating, for T3): loud onset from cold + quiet onset.
  const procL = new Proc();
  procL.port.onmessage({ data: { type: 'set-gain-db', gainDb: 0 } });
  const rL = render(procL, makeSine(AMP_LOUD, 3));
  const settledL = rL.trace[rL.trace.length - 1];
  let t6 = null, t8 = null;
  for (let i = 0; i < rL.trace.length; i++) {
    const t = (i + 1) * BLOCK / SR;
    if (t6 === null && rL.trace[i] <= -6) t6 = t;
    if (t8 === null && rL.trace[i] <= -8) t8 = t;
  }
  const l500 = atTime(rL.trace, 0.5);
  const l1000 = atTime(rL.trace, 1.0);
  const procQz = new Proc();
  procQz.port.onmessage({ data: { type: 'set-gain-db', gainDb: 0 } });
  const rQz = render(procQz, makeSine(AMP_QUIET, 2));
  // Guard behavior binds only over the cold window (~400 ms to first gated
  // block): there the probe must never boost. Past gating the SLOW loop takes
  // over and lifts a far-quiet program toward target by design (A1
  // convergence), so the 2 s max is reported separately, not asserted.
  const kCold = Math.min(rQz.trace.length, Math.round(0.4 * SR / BLOCK));
  let qmax = 0;
  let qmax2 = 0;
  for (let i = 0; i < rQz.trace.length; i++) {
    const t = rQz.trace[i];
    if (!Number.isFinite(t)) { qmax = NaN; qmax2 = NaN; break; }
    const a = Math.abs(t);
    if (a > qmax2) qmax2 = a;
    if (i < kCold && a > qmax) qmax = a;
  }

  console.log('FEED-TRANSITION QA (node:vm, 48kHz, 1kHz sine A=' + AMP_A + '/B=' + AMP_B + '/Q=' + AMP_Q + ', 128-frame quanta)');
  console.log('GA=' + fmt(GA) + ' dB  GB=' + fmt(GB) + ' dB  (B-A=' + fmt(GB - GA) + ' dB, expect ~-6.02)');
  console.log('row             measured                              bound     verdict');
  let allPass = untested === 0;
  for (const r of rows) {
    const ok = r.pass;
    if (!ok) allPass = false;
    const line = (r.name + '            ').slice(0, 16) + ' ' +
      (r.measured + '                                    ').slice(0, 38) + ' ' +
      (r.bound + '          ').slice(0, 10) + ' ' + (ok ? 'PASS' : 'FAIL') + (r.note ? '  ' + r.note : '');
    console.log(line);
  }
  console.log('A6-INFO loud onset (0.5 sine, cold): t(-6dB)=' + (t6 === null ? 'never' : t6.toFixed(3) + 's') +
    ' t(-8dB)=' + (t8 === null ? 'never' : t8.toFixed(3) + 's') +
    ' g@0.5s=' + fmt(l500.v) + ' g@1.0s=' + fmt(l1000.v) + ' settled=' + fmt(settledL));
  console.log('A6-INFO quiet onset (0.02 sine, cold): max|gain| cold-window(400ms)=' + fmt(qmax) + ' dB; 2s max=' + fmt(qmax2) + ' dB (post-gating slow-loop lift, A1 by design)');
  console.log(allPass ? 'OVERALL: ALL PASS' : 'OVERALL: FAILURES PRESENT');
  process.exitCode = allPass ? 0 : 2;
}

try {
  main();
} catch (err) {
  console.error('HARNESS ERROR: ' + (err && err.stack ? err.stack : String(err)));
  process.exitCode = 1;
}
