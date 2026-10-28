'use strict';
/*
 * program-boundary-qa.cjs
 * Local-only QA harness (qa/ is gitignored). Pure Node, node:vm. No browser, no audio.
 *
 * Verifies the page-hook half of the feed fix: exactly one
 * {type:'reset-program', generation} per new program to each active
 * session.workletNode.port, best-effort on missing/closed ports.
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const repoRoot = path.resolve(__dirname, '..');
const hookSrc = fs.readFileSync(path.join(repoRoot, 'page-hook.js'), 'utf8');

const resetMessages = [];
const statusMessages = [];

class FakeElement {
  constructor() { this._tnListeners = Object.create(null); }
  addEventListener(type, fn) {
    if (typeof fn !== 'function') return;
    (this._tnListeners[type] = this._tnListeners[type] || []).push(fn);
  }
  removeEventListener(type, fn) {
    const a = this._tnListeners[type];
    if (!a) return;
    const i = a.indexOf(fn);
    if (i >= 0) a.splice(i, 1);
  }
  dispatchEvent(ev) {
    const type = typeof ev === 'string' ? ev : ev && ev.type;
    if (!type) return true;
    const listeners = (this._tnListeners[type] || []).slice();
    const event = typeof ev === 'string' ? { type, target: this } : Object.assign({ target: this }, ev);
    for (const fn of listeners) {
      try { fn.call(this, event); } catch {}
    }
    return true;
  }
  querySelectorAll() { return []; }
}

class FakeMediaElement extends FakeElement {
  constructor() {
    super();
    this.muted = false;
    this.src = '';
    this.tagName = 'VIDEO';
  }
  play() {
    if (this.rejectPlay) {
      const err = new Error('play() rejected by autoplay policy');
      err.name = 'NotAllowedError';
      return Promise.reject(err);
    }
    return Promise.resolve();
  }
}

class FakeAudioNode {
  connect() { return undefined; }
  disconnect() {}
}

class FakeAudioContext {
  constructor() {
    this.state = 'running';
    this.sampleRate = 48000;
    this.destination = {};
    this.audioWorklet = { addModule: async () => {} };
  }
  async resume() {}
  createGain() {
    const n = new FakeAudioNode();
    n.context = this;
    return n;
  }
  createMediaElementSource() { return { connect() {}, disconnect() {} }; }
  addEventListener() {}
  removeEventListener() {}
}

class FakeWorkletNode {
  constructor(context, name) {
    this.context = context;
    this.name = name;
    this._ope = null;
    this.port = {
      postMessage: (msg) => {
        if (msg && msg.type === 'reset-program') {
          resetMessages.push({ generation: msg.generation });
        }
      },
    };
    FakeWorkletNode.instances.push(this);
  }
  connect() { return undefined; }
  disconnect() {}
  set onprocessorerror(v) { this._ope = v; }
  get onprocessorerror() { return this._ope; }
}
FakeWorkletNode.instances = [];

class FakeMutationObserver {
  constructor() {}
  observe() {}
  disconnect() {}
}

const locationStub = { href: 'https://example.com/' };
const documentElementStub = {
  _attrs: { 'data-tab-normalizer-pending': '1' },
  getAttribute(k) { return Object.prototype.hasOwnProperty.call(this._attrs, k) ? this._attrs[k] : null; },
  removeAttribute(k) { delete this._attrs[k]; },
};
const documentStub = {
  documentElement: documentElementStub,
  currentScript: null,
  querySelectorAll() { return []; },
  addEventListener() {},
  removeEventListener() {},
};
const windowStub = {
  __tabNormalizerHookV5: undefined,
  addEventListener() {},
  removeEventListener() {},
  postMessage(msg) { statusMessages.push(msg); },
  AudioContext: FakeAudioContext,
  OfflineAudioContext: FakeAudioContext,
  webkitAudioContext: undefined,
};

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function main() {
  const sandbox = {
    window: windowStub,
    document: documentStub,
    location: locationStub,
    Element: FakeElement,
    HTMLMediaElement: FakeMediaElement,
    AudioNode: FakeAudioNode,
    AudioContext: FakeAudioContext,
    OfflineAudioContext: FakeAudioContext,
    AudioWorkletNode: FakeWorkletNode,
    MutationObserver: FakeMutationObserver,
    DOMException: globalThis.DOMException || Error,
    URL: globalThis.URL,
    console,
    setTimeout,
    clearTimeout,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(hookSrc, sandbox, { filename: 'page-hook.js' });

  // Await pre-warm: media session + worklet node ready.
  const deadline = Date.now() + 3000;
  while (FakeWorkletNode.instances.length === 0 && Date.now() < deadline) {
    await sleep(25);
  }
  if (FakeWorkletNode.instances.length === 0) {
    console.log('FAIL harness: worklet node never became ready');
    process.exitCode = 1;
    return;
  }
  await sleep(50);

  const A = new FakeMediaElement();
  const B = new FakeMediaElement();
  const C = new FakeMediaElement();
  C.rejectPlay = true;

  const rows = [];
  async function check(label, action, expectDelta) {
    const before = resetMessages.length;
    await action();
    await sleep(30);
    const after = resetMessages.length;
    const delta = after - before;
    const pass = delta === expectDelta;
    rows.push({ label, delta, expectDelta, total: after, pass });
    return pass;
  }

  await check('1 first play A -> 1 reset', async () => { await A.play(); }, 1);
  await check('2 pause/resume A -> +0', async () => {
    A.dispatchEvent({ type: 'pause' });
    await A.play();
  }, 0);
  await check('3 seek A -> +0', async () => {
    A.dispatchEvent({ type: 'seeking' });
    A.dispatchEvent({ type: 'seeked' });
    A.dispatchEvent({ type: 'playing' });
  }, 0);
  await check('4 stall playing A -> +0', async () => {
    A.dispatchEvent({ type: 'waiting' });
    A.dispatchEvent({ type: 'playing' });
  }, 0);
  await check('5 B starts -> +1', async () => { await B.play(); }, 1);
  await check('6 loadstart+playing A -> +1', async () => {
    A.dispatchEvent({ type: 'loadstart' });
    A.dispatchEvent({ type: 'playing' });
  }, 1);
  await check('7 ended+play A -> +1', async () => {
    A.dispatchEvent({ type: 'ended' });
    await A.play();
  }, 1);
  await check('8 repeated play A -> +0', async () => { await A.play(); }, 0);
  await check('9 rejected play C -> +0 (no reset)', async () => {
    await C.play().catch(() => {});
  }, 0);
  await check('10 C play after rejection succeeds -> +1', async () => {
    C.rejectPlay = false;
    await C.play();
  }, 1);

  console.log('event/message table');
  for (const r of rows) {
    console.log(`${r.pass ? 'PASS' : 'FAIL'} ${r.label} delta=${r.delta} expected=${r.expectDelta} total=${r.total}`);
  }
  console.log(`reset-program generations: [${resetMessages.map((m) => m.generation).join(', ')}]`);
  const gens = resetMessages.map((m) => m.generation);
  const monotonic = gens.every((g, i) => Number.isInteger(g) && (i === 0 || g > gens[i - 1]));
  console.log(`generations monotonic integers: ${monotonic ? 'yes' : 'no'}`);

  const allPass = rows.every((r) => r.pass) && monotonic && gens.length === 5;
  if (!allPass) {
    console.log('OVERALL: FAIL');
    process.exitCode = 2;
    return;
  }
  console.log('OVERALL: ALL PASS');
  process.exitCode = 0;
}

main().catch((e) => {
  console.log(`HARNESS ERROR: ${e && e.stack || e}`);
  process.exitCode = 1;
});
