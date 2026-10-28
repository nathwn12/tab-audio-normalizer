(() => {
  if (window.__tabNormalizerHookV5?.revive) {
    window.__tabNormalizerHookV5.revive();
    return;
  }

  const CHANNEL = 'tab-normalizer-v5';
  const PENDING_ATTR = 'data-tab-normalizer-pending';
  const RECOVERY_BURST_MS = 250;
  const RECOVERY_BURST_COUNT = 6;
  const HOOK_GUARD_TIMEOUT_MS = 1500;
  const WORKLET_URL = document.documentElement?.getAttribute('data-tn-worklet-url')
    || new URL(
      'audio/normalizer-worklet.js',
      /** @type {HTMLScriptElement|null} */ (document.currentScript)?.src || location.href,
    ).toString();
  document.documentElement?.removeAttribute('data-tn-worklet-url');
  const MIN_GAIN_DB = -12;
  const MAX_GAIN_DB = 12;

  console.log('[hook] loaded, worklet:', WORKLET_URL);

  const originalConnect = AudioNode.prototype.connect;
  const originalPlay = HTMLMediaElement.prototype.play;
  const originalCreateMediaElementSource = AudioContext.prototype.createMediaElementSource;

  const sessions = new Set();
  const contextSessions = new WeakMap();
  const mediaSessions = new WeakMap();
  let mediaSessionPromise = null;
  const guardedMediaElements = new Set();
  let recoveryBurstTimer = null;
  let recoveryBurstRemaining = 0;

  // Program-boundary tracking (feed fix, page-hook half): exactly one
  // {type:'reset-program', generation} per new program to each active
  // session's worklet port. Per-element generation counter lives on the
  // element (__tnProgramGen) mirrored in elementProgramGenerations;
  // the tab-wide generation is currentProgramGeneration; each session
  // tracks lastResetGeneration / pendingResetGeneration; the active
  // program element is activeProgramElement.
  const elementProgramGenerations = new WeakMap();
  let currentProgramGeneration = 0;
  let activeProgramElement = null;

  /** @type {{ active: boolean, observer: (MutationObserver|null), recovering: boolean, internalWiring: boolean, creatingContext: boolean, gainDb: number, lastError: string }} */
  const state = {
    active: false,
    observer: null,
    recovering: false,
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
    if (event.data.type === 'START') start(event.data);
    if (event.data.type === 'STOP') stop();
    if (event.data.type === 'SET_GAIN') setGain(event.data.gainDb);
    if (event.data.type === 'STATUS_REQUEST') reportStatus('HOOK_STATUS', { requestId: event.data.requestId });
  }

  function revive() {
    console.log('[hook] revive requested');
    reportStatus('HOOK_STATUS');

    if (readPendingStart()) {
      start();
      return;
    }

    scheduleRecoveryBurst();
  }

  let lifecycleTimer = null;

  function handleLifecycleEvent() {
    if (!state.active) return;
    if (lifecycleTimer) return;
    lifecycleTimer = setTimeout(() => {
      lifecycleTimer = null;
      scheduleRecoveryBurst();
    }, 200);
  }

  /**
   * @param {{ gainDb?: number }|null} [nextState]
   */
  function start(nextState = null) {
    const wasActive = state.active;
    if (nextState && typeof nextState === 'object') {
      state.gainDb = normalizeGainDb(nextState.gainDb);
    }
    state.active = true;
    state.gainDb = normalizeGainDb(state.gainDb);
    state.lastError = '';

    // Owner-directed seamless start: pre-warm the media session (AudioContext +
    // AudioWorklet module + node) so it is ready before the first media element
    // plays. The CPU cost is accepted. Never awaited; failures surface via setError.
    if (!mediaSessions.has(document) && !mediaSessionPromise) {
      void ensureMediaSession().catch(() => {});
    }

    if (wasActive) {
      routeSessions();
      updateSessionGains();
      reportStatus('HOOK_STATUS');
      return;
    }

    clearRecoveryBurst();
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
    scheduleRecoveryBurst();
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
    clearRecoveryBurst();
    console.log('[hook] stopping');
    restoreAllHookGuards();

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
      const OrigAC = /** @type {typeof AudioContext & {__tnPatched?: boolean}} */ (window.AudioContext);
      if (OrigAC && !OrigAC.__tnPatched) {
        class PatchedAudioContext extends OrigAC {
          constructor(...args) {
            super(...args);
            if (state.creatingContext || this.state === 'closed') return;
            try { ensureContextSession(this); } catch {}
          }
        }
        PatchedAudioContext.__tnPatched = true;
        window.AudioContext = /** @type {typeof AudioContext & {__tnPatched?: boolean}} */ (PatchedAudioContext);
      }

      const OrigOAC = /** @type {typeof OfflineAudioContext & {__tnPatched?: boolean}} */ (window.OfflineAudioContext);
      if (OrigOAC && !OrigOAC.__tnPatched) {
        const Parent = /** @type {{ new (...a: any[]): OfflineAudioContext & {__tnPatched?: boolean} }} */ (OrigOAC);
        class PatchedOfflineAudioContext extends Parent {
          constructor(...args) {
            super(...args);
            if (state.creatingContext) return;
            try { ensureContextSession(this); } catch {}
          }
        }
        PatchedOfflineAudioContext.__tnPatched = true;
        window.OfflineAudioContext = /** @type {typeof OfflineAudioContext & {__tnPatched?: boolean}} */ (PatchedOfflineAudioContext);
      }

      if (window.webkitAudioContext) {
        const Orig = /** @type {typeof AudioContext & {__tnPatched?: boolean}} */ (window.webkitAudioContext);
        if (!Orig.__tnPatched) {
          class PatchedWebkitAudioContext extends Orig {
            constructor(...args) {
              super(...args);
              if (state.creatingContext || this.state === 'closed') return;
              try { ensureContextSession(this); } catch {}
            }
          }
          PatchedWebkitAudioContext.__tnPatched = true;
          window.webkitAudioContext = /** @type {typeof AudioContext & {__tnPatched?: boolean}} */ (PatchedWebkitAudioContext);
        }
      }
    } catch {}

    try { scanExistingContexts(); } catch {}
  }

  function scanExistingContexts() {
    const candidates = new Set();

    // Fast path: check known common variable names
    const knownKeys = ['audioCtx', 'audioContext', 'ctx', 'context', 'actx', 'ac'];
    for (const key of knownKeys) {
      try {
        const val = window[key];
        if (val && typeof val === 'object') candidates.add(val);
      } catch {}
    }

    // Fallback: scan window keys with audio/context pattern, capped at 200
    if (candidates.size === 0) {
      let scanned = 0;
      try {
        for (const key of Object.keys(window)) {
          if (scanned++ > 200) break;
          if (!/audio|ctx|context/i.test(key)) continue;
          try {
            const val = window[key];
            if (val && typeof val === 'object') candidates.add(val);
          } catch {}
        }
      } catch {}
    }

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
      if (state.active && (!this.__tnWebAudio || this.__tnAttached)) {
        watchProgramBoundaries(this);
        handleElementPlaybackStart(this);
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

    let observerTimer = null;

    state.observer = new MutationObserver((mutations) => {
      if (!state.active) return;
      if (observerTimer) return;

      observerTimer = setTimeout(() => {
        observerTimer = null;
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
      }, 100);
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
    /** @type {AudioContext|undefined} */
    let context;
    state.creatingContext = true;
    try {
      context = new AudioContext({ latencyHint: 'interactive' });
      await context.resume();
    } catch (e) {
      console.warn('[hook] AudioContext resume blocked by autoplay policy:', e.message || e);
    } finally {
      state.creatingContext = false;
    }

    if (!context) return /** @type {*} */ (null);

    console.log('[hook] AudioContext created, state:', context.state, 'sampleRate:', context.sampleRate);

    const session = createSession(context, 'media');
    mediaSessions.set(document, session);
    sessions.add(session);

    if (context.state === 'suspended') {
      const resumeOnInteraction = async () => {
        try {
          await context.resume();
          console.log('[hook] AudioContext resumed on user interaction');
        } catch {}
        document.removeEventListener('click', resumeOnInteraction);
        document.removeEventListener('touchstart', resumeOnInteraction);
        document.removeEventListener('keydown', resumeOnInteraction);
      };
      document.addEventListener('click', resumeOnInteraction);
      document.addEventListener('touchstart', resumeOnInteraction);
      document.addEventListener('keydown', resumeOnInteraction);
    }

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
      lastResetGeneration: null,
      pendingResetGeneration: null,
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
        if (!state.recovering) {
          state.recovering = true;
          setTimeout(() => {
            state.recovering = false;
            void recoverAudio();
          }, 500);
        }
      };

      console.log('[hook] worklet node created, routing audio through normalizer');
      state.lastError = '';
      routeSession(session, workletNode);
      updateSessionGain(session);
      notifySessionStart(session);
      flushPendingProgramReset(session);
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
    flushPendingProgramReset(session);
  }

  // Program-boundary detection. New program: first playback of a newly
  // attached managed element; loadstart/emptied followed by playback; a
  // different element begins playing while another was the active
  // program; replay after ended. Not a new program: pause/resume, seek
  // within the same program, waiting/playing buffer stall, repeated
  // play() while already playing. Never resets at attach time; only
  // when the element actually starts playing.
  /** @param {any} mediaElement */
  function watchProgramBoundaries(mediaElement) {
    if (!mediaElement || mediaElement.__tnProgramWatched) return;
    mediaElement.__tnProgramWatched = true;
    try {
      mediaElement.addEventListener('loadstart', () => markProgramDirty(mediaElement));
      mediaElement.addEventListener('emptied', () => markProgramDirty(mediaElement));
      mediaElement.addEventListener('ended', () => {
        markProgramDirty(mediaElement);
        try { mediaElement.__tnPlaying = false; } catch {}
      });
      mediaElement.addEventListener('pause', () => {
        try { mediaElement.__tnPlaying = false; } catch {}
      });
      mediaElement.addEventListener('play', () => handleElementPlaybackStart(mediaElement));
      mediaElement.addEventListener('playing', () => handleElementPlaybackStart(mediaElement));
    } catch {}
  }

  /** @param {any} mediaElement */
  function markProgramDirty(mediaElement) {
    if (!mediaElement) return;
    try {
      mediaElement.__tnProgramDirty = true;
    } catch {}
  }

  /** @param {any} mediaElement */
  function handleElementPlaybackStart(mediaElement) {
    if (!state.active || !mediaElement) return;
    // Elements wired by the page through WebAudio are unmanaged; elements
    // wired by our own attach carry __tnAttached and stay managed.
    if (mediaElement.__tnWebAudio && !mediaElement.__tnAttached) return;
    let isNewProgram = false;
    try {
      if (mediaElement !== activeProgramElement) {
        isNewProgram = true;
      } else if (mediaElement.__tnProgramDirty) {
        isNewProgram = true;
      } else {
        isNewProgram = false;
      }
    } catch {
      return;
    }
    if (!isNewProgram) {
      try { mediaElement.__tnPlaying = true; } catch {}
      return;
    }
    // New program: bump the per-element counter, mint one tab-wide
    // generation, broadcast exactly once per session (or stash pending).
    try {
      const next = (elementProgramGenerations.get(mediaElement) || 0) + 1;
      elementProgramGenerations.set(mediaElement, next);
      mediaElement.__tnProgramGen = next;
      mediaElement.__tnProgramDirty = false;
      mediaElement.__tnPlaying = true;
    } catch {}
    currentProgramGeneration += 1;
    activeProgramElement = mediaElement;
    broadcastProgramReset(currentProgramGeneration);
  }

  function broadcastProgramReset(generation) {
    for (const session of sessions) {
      sendProgramResetToSession(session, generation);
    }
  }

  function sendProgramResetToSession(session, generation) {
    if (!session || session.lastResetGeneration === generation) return;
    if (session.workletNode?.port) {
      try {
        session.workletNode.port.postMessage({ type: 'reset-program', generation });
        session.lastResetGeneration = generation;
        if (session.pendingResetGeneration === generation) session.pendingResetGeneration = null;
      } catch {}
      return;
    }
    // Worklet not ready: keep a single pending generation per session;
    // never queue duplicates. A newly created worklet is already cold,
    // so a pending reset is harmless.
    if (session.lastResetGeneration !== generation) {
      session.pendingResetGeneration = generation;
    }
  }

  function flushPendingProgramReset(session) {
    if (!session?.workletNode?.port) return;
    let target = session.pendingResetGeneration;
    if (target == null && currentProgramGeneration > 0 && session.lastResetGeneration !== currentProgramGeneration) {
      target = currentProgramGeneration;
    }
    if (target == null || session.lastResetGeneration === target) {
      if (session.pendingResetGeneration === target) session.pendingResetGeneration = null;
      return;
    }
    try {
      session.workletNode.port.postMessage({ type: 'reset-program', generation: target });
      session.lastResetGeneration = target;
    } catch {}
    session.pendingResetGeneration = null;
  }

  // Silence-until-routed guard: while the extension is active, a managed media
  // element is muted synchronously at attach time (before the patched play()
  // reaches the original) so it cannot play un-processed audio at full volume
  // while createMediaElementSource + connect are still pending. The previous
  // muted value is restored once routing is live (source connected to the
  // session input), on any attach error, on STOP/teardown, or by a 1.5 s safety
  // timer — never a permanent mute; on failure the element plays raw as before.
  /** @param {any} mediaElement */
  function armHookGuard(mediaElement) {
    if (mediaElement.__tnGuarding) return;
    guardedMediaElements.add(mediaElement);
    mediaElement.__tnGuardPrevMuted = mediaElement.muted;
    mediaElement.muted = true;
    mediaElement.__tnGuarding = true;
    mediaElement.__tnGuardTimer = setTimeout(() => restoreHookGuard(mediaElement), HOOK_GUARD_TIMEOUT_MS);
  }

  /** @param {any} mediaElement */
  function restoreHookGuard(mediaElement) {
    if (!mediaElement || !mediaElement.__tnGuarding) return;
    if (mediaElement.__tnGuardTimer) {
      clearTimeout(mediaElement.__tnGuardTimer);
      mediaElement.__tnGuardTimer = null;
    }
    mediaElement.muted = mediaElement.__tnGuardPrevMuted;
    delete mediaElement.__tnGuarding;
    delete mediaElement.__tnGuardPrevMuted;
    delete mediaElement.__tnGuardTimer;
    guardedMediaElements.delete(mediaElement);
  }

  function restoreAllHookGuards() {
    for (const mediaElement of Array.from(guardedMediaElements)) {
      restoreHookGuard(mediaElement);
    }
  }

  /** @param {any} mediaElement */
  async function attachMediaElement(mediaElement) {
    if (!state.active || !isMediaElement(mediaElement) || mediaElement.__tnAttached) return;
    if (mediaElement.__tnWebAudio) return;
    watchProgramBoundaries(mediaElement);
    if (/** @type {any} */ (mediaElement).__tnGuarding) return;
    // Arm synchronously (before the first await) so the patched play(), which
    // calls the original right after this, can only produce silence until routing.
    armHookGuard(mediaElement);

    try {
      const session = await ensureMediaSession();
      await session.context.resume();
      const source = session.context.createMediaElementSource(mediaElement);
      source.connect(session.inputNode);
      // Routing is live: restore the pre-guard muted value.
      restoreHookGuard(mediaElement);
      mediaElement.__tnAttached = true;
      session.sources.add(source);
      session.mediaElements.add(mediaElement);
      console.log('[hook] media element attached:', mediaElement.tagName, mediaElement.src?.slice(0, 60));
      reportStatus('HOOK_STATUS');
    } catch (e) {
      restoreHookGuard(mediaElement);
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
    scanExistingContexts();

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

  function scheduleRecoveryBurst() {
    if (!state.active || recoveryBurstTimer) return;

    recoveryBurstRemaining = RECOVERY_BURST_COUNT;

    const tick = async () => {
      recoveryBurstTimer = null;

      if (!state.active) {
        recoveryBurstRemaining = 0;
        return;
      }

      try {
        await recoverAudio();
      } catch {}

      recoveryBurstRemaining -= 1;
      if (state.active && recoveryBurstRemaining > 0) {
        recoveryBurstTimer = setTimeout(tick, RECOVERY_BURST_MS);
      } else {
        recoveryBurstRemaining = 0;
      }
    };

    recoveryBurstTimer = setTimeout(tick, 0);
  }

  function clearRecoveryBurst() {
    if (recoveryBurstTimer) {
      clearTimeout(recoveryBurstTimer);
      recoveryBurstTimer = null;
    }
    recoveryBurstRemaining = 0;
  }

  function teardownSession(session) {
    try {
      if (session.workletNode) {
        session.workletNode.disconnect();
      }
    } catch {}

    for (const mediaElement of session.mediaElements) {
      restoreHookGuard(mediaElement);
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
    return Math.max(MIN_GAIN_DB, Math.min(MAX_GAIN_DB, Math.round(numeric * 2) / 2));
  }

  function readPendingStart() {
    const value = document.documentElement?.getAttribute(PENDING_ATTR);
    document.documentElement?.removeAttribute(PENDING_ATTR);
    return value === '1';
  }
})();
