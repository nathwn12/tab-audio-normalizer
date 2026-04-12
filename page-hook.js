(() => {
  if (window.__tabNormalizerHookV5?.revive) {
    window.__tabNormalizerHookV5.revive();
    return;
  }

  const CHANNEL = 'tab-normalizer-v5';
  const PENDING_ATTR = 'data-tab-normalizer-pending';
  const WORKLET_URL = new URL(
    'audio/normalizer-worklet.js',
    document.currentScript?.src || location.href,
  ).toString();

  console.log('[hook] loaded, worklet:', WORKLET_URL);

  const originalConnect = AudioNode.prototype.connect;
  const originalPlay = HTMLMediaElement.prototype.play;
  const originalCreateMediaElementSource = AudioContext.prototype.createMediaElementSource;

  const sessions = new Set();
  const contextSessions = new WeakMap();
  const mediaSessions = new WeakMap();
  let mediaSessionPromise = null;

  const state = {
    active: false,
    observer: null,
    internalWiring: false,
    creatingContext: false,
    gainDb: 0,
    lastError: '',
  };

  window.__tabNormalizerHookV5 = {
    revive,
  };

  window.addEventListener('message', handleMessage);
  document.addEventListener('visibilitychange', handleLifecycleEvent);
  window.addEventListener('focus', handleLifecycleEvent);
  window.addEventListener('pageshow', handleLifecycleEvent);

  if (readPendingStart()) {
    start();
  }

  function handleMessage(event) {
    if (event.source !== window || event.data?.channel !== CHANNEL) return;
    if (event.data.type === 'START') start();
    if (event.data.type === 'STOP') stop();
    if (event.data.type === 'SET_GAIN') setGain(event.data.gainDb);
    if (event.data.type === 'STATUS_REQUEST') reportStatus('HOOK_STATUS', { requestId: event.data.requestId });
  }

  function revive() {
    console.log('[hook] revive requested');
    reportStatus('HOOK_STATUS');

    if (readPendingStart()) {
      start();
    }
  }

  function handleLifecycleEvent() {
    if (!state.active) return;
    void recoverAudio();
  }

  function start() {
    state.active = true;
    state.gainDb = normalizeGainDb(state.gainDb);
    state.lastError = '';
    console.log('[hook] starting');
    try {
      bootstrap();
    } catch (e) {
      console.error('[hook] bootstrap failed:', e);
      setError(`Bootstrap failed: ${e.message || e}`);
    }
    attachExistingMediaElements();
    routeSessions();
    updateSessionGains();
    notifySessionStarts();
    void recoverAudio();
    reportStatus('HOOK_STARTED');
  }

  function setGain(gainDb) {
    state.gainDb = normalizeGainDb(gainDb);
    updateSessionGains();
    reportStatus('HOOK_STATUS');
  }

  function stop() {
    if (!state.active) return;
    state.active = false;
    console.log('[hook] stopping');

    for (const session of sessions) {
      bypassSession(session);
    }

    if (state.observer) {
      state.observer.disconnect();
      state.observer = null;
    }

    reportStatus('HOOK_STOPPED');
  }

  function bootstrap() {
    patchConnect();
    patchPlay();
    patchCreateMediaElementSource();
    observeDom();

    try {
      const OrigAC = window.AudioContext;
      if (OrigAC && !OrigAC.__tnPatched) {
        class Patched extends OrigAC {
          constructor(...args) {
            super(...args);
            if (state.creatingContext || this.state === 'closed') return;
            try { ensureContextSession(this); } catch {}
          }
        }
        Patched.__tnPatched = true;
        window.AudioContext = Patched;
      }

      const OrigOAC = window.OfflineAudioContext;
      if (OrigOAC && !OrigOAC.__tnPatched) {
        class Patched extends OrigOAC {
          constructor(...args) {
            super(...args);
            if (state.creatingContext) return;
            try { ensureContextSession(this); } catch {}
          }
        }
        Patched.__tnPatched = true;
        window.OfflineAudioContext = Patched;
      }

      if (window.webkitAudioContext && !window.webkitAudioContext.__tnPatched) {
        const Orig = window.webkitAudioContext;
        class Patched extends Orig {
          constructor(...args) {
            super(...args);
            if (state.creatingContext || this.state === 'closed') return;
            try { ensureContextSession(this); } catch {}
          }
        }
        Patched.__tnPatched = true;
        window.webkitAudioContext = Patched;
      }
    } catch {}

    try { scanExistingContexts(); } catch {}
  }

  function scanExistingContexts() {
    const candidates = new Set();

    try {
      for (const key of Object.keys(window)) {
        if (!/audio|ctx|context/i.test(key)) continue;
        try {
          const val = window[key];
          if (val && typeof val === 'object') candidates.add(val);
        } catch {}
      }
    } catch {}

    for (const c of candidates) {
      try {
        if (c && typeof c === 'object' &&
            c.state !== 'closed' &&
            Number.isFinite(c.sampleRate) &&
            c.destination && typeof c.createGain === 'function') {
          ensureContextSession(c);
        }
      } catch {}
    }
  }

  function patchConnect() {
    if (AudioNode.prototype.__tnConnect) return;
    AudioNode.prototype.__tnConnect = true;

    AudioNode.prototype.connect = function (dest, out, inp) {
      if (!state.internalWiring && state.active && this.context && dest === this.context.destination) {
        const s = ensureContextSession(this.context);
        if (s) return originalConnect.call(this, s.inputNode, out, inp);
      }
      return originalConnect.call(this, dest, out, inp);
    };
  }

  function patchPlay() {
    if (HTMLMediaElement.prototype.__tnPlay) return;
    HTMLMediaElement.prototype.__tnPlay = true;

    HTMLMediaElement.prototype.play = function (...args) {
      if (state.active && !this.__tnWebAudio) {
        void attachMediaElement(this);
      }
      return originalPlay.apply(this, args);
    };
  }

  function patchCreateMediaElementSource() {
    if (AudioContext.prototype.__tnMediaSource) return;
    AudioContext.prototype.__tnMediaSource = true;

    AudioContext.prototype.createMediaElementSource = function (el) {
      if (el) el.__tnWebAudio = true;
      return originalCreateMediaElementSource.call(this, el);
    };
  }

  function observeDom() {
    if (state.observer) return;

    state.observer = new MutationObserver((mutations) => {
      if (!state.active) return;

      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (!(node instanceof Element)) continue;

          if (isMediaElement(node)) {
            void attachMediaElement(node);
          }

          for (const media of node.querySelectorAll?.('audio, video') ?? []) {
            void attachMediaElement(media);
          }
        }
      }
    });

    state.observer.observe(document.documentElement || document, {
      childList: true,
      subtree: true,
    });
  }

  function attachExistingMediaElements() {
    for (const media of document.querySelectorAll('audio, video')) {
      void attachMediaElement(media);
    }
  }

  function ensureContextSession(context) {
    let session = contextSessions.get(context);
    if (session) return session;

    if (context.state === 'closed') {
      console.log('[hook] skipping closed context');
      return null;
    }

    session = createSession(context, 'context');
    contextSessions.set(context, session);
    sessions.add(session);

    if (state.active && session.readyResolved && !session.workletNode) {
      attachWorklet(session);
    }
    return session;
  }

  async function ensureMediaSession() {
    if (mediaSessions.has(document)) {
      return mediaSessions.get(document);
    }

    if (mediaSessionPromise) {
      return mediaSessionPromise;
    }

    mediaSessionPromise = createMediaSession();

    try {
      return await mediaSessionPromise;
    } finally {
      mediaSessionPromise = null;
    }
  }

  async function createMediaSession() {
    let context;
    state.creatingContext = true;
    try {
      context = new AudioContext({ latencyHint: 'interactive' });
      await context.resume();
    } catch (e) {
      console.error('[hook] AudioContext creation/resume failed:', e.message || e);
      throw e;
    } finally {
      state.creatingContext = false;
    }

    console.log('[hook] AudioContext created, state:', context.state, 'sampleRate:', context.sampleRate);

    const session = createSession(context, 'media');
    mediaSessions.set(document, session);
    sessions.add(session);

    if (state.active && session.readyResolved && !session.workletNode) {
      attachWorklet(session);
    }

    await session.ready;
    return session;
  }

  function createSession(context, kind) {
    const inputNode = context.createGain();
    const outputNode = context.createGain();

    state.internalWiring = true;
    try {
      originalConnect.call(inputNode, outputNode);
      originalConnect.call(outputNode, context.destination);
    } finally {
      state.internalWiring = false;
    }

    const session = {
      context,
      inputNode,
      outputNode,
      workletNode: null,
      readyResolved: false,
      ready: null,
      sources: new Set(),
      mediaElements: new Set(),
      kind,
    };

    context.addEventListener?.('statechange', () => {
      if (!state.active) return;
      if (context.state === 'closed') {
        setError('Audio context closed. Reconnecting…');
        teardownSession(session);
        void recoverAudio();
        return;
      }
      reportStatus('HOOK_STATUS');
    });

    session.ready = context.audioWorklet
      .addModule(WORKLET_URL)
      .then(async () => {
        console.log('[hook] worklet module loaded for context:', context.state);
        if (context.state === 'closed') {
          console.log('[hook] skipping worklet for closed context');
          return;
        }
        try {
          await context.resume();
        } catch (e) {
          console.warn('[hook] context resume before worklet node:', e.message);
        }
        session.readyResolved = true;
        if (!state.active || session.workletNode) return;
        attachWorklet(session);
      })
      .catch((e) => {
        console.error('[hook] worklet module load failed:', e.message || e);
        setError(`Worklet module load failed: ${e.message || e}`);
      });

    return session;
  }

  function routeSessions() {
    for (const session of sessions) {
      if (session.workletNode) {
        routeSession(session, session.workletNode);
      } else if (session.readyResolved && state.active) {
        attachWorklet(session);
      }
    }
  }

  function attachWorklet(session) {
    if (!session || session.workletNode || !session.readyResolved || !state.active) return;

    try {
      const workletNode = new AudioWorkletNode(session.context, 'loudness-normalizer', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        channelCountMode: 'max',
        channelInterpretation: 'speakers',
      });

      workletNode.onprocessorerror = (e) => {
        console.error('[hook] worklet processor error:', e);
        session.workletNode = null;
        setError('Audio processor error. Retrying…');
        void recoverAudio();
      };

      console.log('[hook] worklet node created, routing audio through normalizer');
      state.lastError = '';
      routeSession(session, workletNode);
      updateSessionGain(session);
      notifySessionStart(session);
      reportStatus('HOOK_STATUS');
    } catch (e) {
      console.error('[hook] AudioWorkletNode creation failed:', e.message || e);
      console.log('[hook] audio will pass through unprocessed (bypass mode)');
      setError(`AudioWorkletNode creation failed: ${e.message || e}`);
    }
  }

  function routeSession(session, workletNode) {
    if (!session || !workletNode) return;

    try { session.inputNode.disconnect(session.outputNode); } catch {}
    try { session.inputNode.disconnect(workletNode); } catch {}
    try { workletNode.disconnect(session.outputNode); } catch {}

    session.inputNode.connect(workletNode);
    workletNode.connect(session.outputNode);
    session.workletNode = workletNode;
  }

  function bypassSession(session) {
    if (!session) return;

    try {
      if (session.workletNode) {
        session.inputNode.disconnect(session.workletNode);
        session.workletNode.disconnect(session.outputNode);
      }
    } catch {}

    try { session.inputNode.disconnect(session.outputNode); } catch {}

    try {
      session.inputNode.connect(session.outputNode);
    } catch {}
  }

  function updateSessionGains() {
    for (const session of sessions) {
      updateSessionGain(session);
    }
  }

  function notifySessionStarts() {
    for (const session of sessions) {
      notifySessionStart(session);
    }
  }

  function updateSessionGain(session) {
    if (!session?.workletNode) return;
    try {
      session.workletNode.port.postMessage({ type: 'set-gain-db', gainDb: state.gainDb });
    } catch {}
  }

  function notifySessionStart(session) {
    if (!session?.workletNode) return;
    try {
      session.workletNode.port.postMessage({ type: 'start-normalizing' });
    } catch {}
  }

  async function attachMediaElement(mediaElement) {
    if (!state.active || !isMediaElement(mediaElement) || mediaElement.__tnAttached) return;
    if (mediaElement.__tnWebAudio) return;

    try {
      const session = await ensureMediaSession();
      await session.context.resume();
      const source = session.context.createMediaElementSource(mediaElement);
      source.connect(session.inputNode);
      mediaElement.__tnAttached = true;
      session.sources.add(source);
      session.mediaElements.add(mediaElement);
      console.log('[hook] media element attached:', mediaElement.tagName, mediaElement.src?.slice(0, 60));
      reportStatus('HOOK_STATUS');
    } catch (e) {
      if (e instanceof DOMException && e.name === 'InvalidStateError') {
        mediaElement.__tnWebAudio = true;
        console.log('[hook] media element already connected to another source, skipping');
      } else {
        console.error('[hook] attachMediaElement failed:', e.message || e);
        setError(`Attach media failed: ${e.message || e}`);
      }
    }
  }

  async function recoverAudio() {
    for (const session of Array.from(sessions)) {
      if (session.context.state === 'closed') {
        teardownSession(session);
        continue;
      }

      try {
        await session.context.resume();
      } catch (e) {
        console.warn('[hook] context resume during recovery failed:', e.message || e);
      }

      if (session.readyResolved && !session.workletNode) {
        attachWorklet(session);
      }
    }

    attachExistingMediaElements();
    routeSessions();
    reportStatus('HOOK_STATUS');
  }

  function teardownSession(session) {
    try {
      if (session.workletNode) {
        session.workletNode.disconnect();
      }
    } catch {}

    for (const mediaElement of session.mediaElements) {
      mediaElement.__tnAttached = false;
    }

    sessions.delete(session);
    contextSessions.delete(session.context);

    if (mediaSessions.get(document) === session) {
      mediaSessions.delete(document);
    }
  }

  function setError(message) {
    state.lastError = String(message || 'Unknown normalizer error.');
    reportStatus('HOOK_ERROR');
  }

  function reportStatus(type, extra = {}) {
    window.postMessage({
      channel: CHANNEL,
      type,
      alive: true,
      active: isHookActive(),
      error: state.active ? state.lastError : '',
      requestId: extra.requestId || '',
    }, '*');
  }

  function isHookActive() {
    if (!state.active) return false;
    for (const session of sessions) {
      if (session.workletNode && session.context.state !== 'closed') {
        return true;
      }
    }
    return false;
  }

  function isMediaElement(node) {
    return node instanceof HTMLMediaElement;
  }

  function normalizeGainDb(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return 0;
    return Math.max(-6, Math.min(6, Math.round(numeric * 2) / 2));
  }

  function readPendingStart() {
    const value = document.documentElement?.getAttribute(PENDING_ATTR);
    document.documentElement?.removeAttribute(PENDING_ATTR);
    return value === '1';
  }
})();
