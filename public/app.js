/**
 * Krell Patch Synthesizer — Main Application Controller
 *
 * Architecture:
 * - Web Audio API with single lazily constructed AudioContext
 * - AudioWorklet node ('krell-voice') -> AudioWorklet node ('krell-reverb': pure MODAMP -> spring reverb) -> AnalyserNode -> StereoPannerNode -> GainNode -> destination
 * - Voice AudioParams: pace, root, spread, memory, waveform
 * - Effects AudioParams: modamp (0..1, carrier amplitude), modRate (10..1000 Hz), spring (0..1, wet return level)
 * - Native pan: -1..1, master gain: 0..0.5 (safe ceiling)
 * - 20ms setTargetAtTime smoothing on native pan and gain
 * - Bi-directional Worklet communication:
 *     Inbound telemetry: { type: 'telemetry', envelope, frequency, cycle, stage, rise, fall, resistance }
 *     Outbound control: { type: 'reseed', seed }, { type: 'telemetry', enabled: boolean }
 * - Visibilitychange optimization: halts RAF and disables worklet telemetry when tab is hidden
 * - Reusable typed arrays and DPR-aware oscilloscope rendering
 * - Keyboard & accessible screen-reader updates
 */

// Helper to convert linear gain (0..1) to decibels
function linearToDb(gain) {
  if (gain <= 0.00001) return -Infinity;
  return 20 * Math.log10(gain);
}

// Frequency to Note name converter (A4 = 440 Hz)
function freqToNoteName(freq) {
  if (!freq || freq <= 0) return '—';
  const noteNames = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const midi = Math.round(69 + 12 * Math.log2(freq / 440));
  const note = noteNames[(midi % 12 + 12) % 12];
  const octave = Math.floor(midi / 12) - 1;
  return `${note}${octave}`;
}

// State container
const state = {
  // Audio state
  audioCtx: null,
  workletNode: null,
  effectsNode: null,
  analyserNode: null,
  pannerNode: null,
  gainNode: null,
  // Graph status
  isRunning: false,
  isTransitioning: false,
  hasInitialized: false,

  // Seed cache (applied on graph init if generated before first play)
  cachedSeed: null,

  // Control parameter cache (applied before or after graph exists)
  params: {
    waveform: 0,   // 0 = sine, 1 = triangle
    pace: 1.0,     // 0.25 .. 4.0
    root: 110.0,   // 55 .. 440 Hz
    spread: 2.0,   // 0 .. 4 octaves
    memory: 1.0,   // 0.4 .. 2.5
    spring: 0.0,    // 0 .. 1 (0% .. 100% wet return)
    modamp: 0.0,    // 0 .. 1 modulation depth: pure synth .. full balanced multiplication
    modRate: 73.0,  // 10 .. 1000 Hz
    pan: 0.0,       // -1 (Left) .. 1 (Right)
    gain: 0.18      // 0 .. 0.5 (nominal 0.18)
  },
  telemetry: {
    envelope: 0,
    frequency: 110,
    cycle: 0,
    stage: 'standby',
    rise: 0,
    fall: 0,
    resistance: 0
  },

  // Animation / Scope state
  rafId: null,
  isCanvasVisible: typeof document !== 'undefined' ? !document.hidden : true,
  scopeData: null,    // Float32Array for waveform samples
  historyEnv: new Float32Array(128) // Ring buffer for envelope trajectory visual
};

// DOM References
const elements = {
  statusDot: document.getElementById('system-status-indicator'),
  statusLabel: document.getElementById('system-status-label'),
  errorBanner: document.getElementById('error-banner'),
  errorTitle: document.getElementById('error-title'),
  errorMessage: document.getElementById('error-message'),
  errorDismiss: document.getElementById('error-dismiss'),

  // Transport
  btnPlay: document.getElementById('btn-play'),
  btnPlayText: document.getElementById('btn-play-text'),
  btnReseed: document.getElementById('btn-reseed'),

  // Controls
  radioSine: document.getElementById('wave-sine'),
  radioTri: document.getElementById('wave-tri'),
  paramPace: document.getElementById('param-pace'),
  paramRoot: document.getElementById('param-root'),
  paramSpread: document.getElementById('param-spread'),
  paramMemory: document.getElementById('param-memory'),
  paramSpring: document.getElementById('param-spring'),
  paramModamp: document.getElementById('param-modamp'),
  paramModRate: document.getElementById('param-modRate'),
  paramPan: document.getElementById('param-pan'),
  paramGain: document.getElementById('param-gain'),
  // Readouts
  readoutPace: document.getElementById('readout-pace'),
  readoutRoot: document.getElementById('readout-root'),
  readoutSpread: document.getElementById('readout-spread'),
  readoutMemory: document.getElementById('readout-memory'),
  readoutSpring: document.getElementById('readout-spring'),
  readoutModamp: document.getElementById('readout-modamp'),
  readoutModRate: document.getElementById('readout-modRate'),
  readoutPan: document.getElementById('readout-pan'),
  readoutGain: document.getElementById('readout-gain'),
  // Scope & Telemetry
  canvas: document.getElementById('scope-canvas'),
  scopeOverlay: document.getElementById('scope-overlay'),
  scopeWatermark: document.getElementById('scope-state-text'),
  telStage: document.getElementById('tel-stage'),
  telPitch: document.getElementById('tel-pitch'),
  telFreq: document.getElementById('tel-freq'),
  telDuration: document.getElementById('tel-duration'),
  telRes: document.getElementById('tel-res'),
  telCycle: document.getElementById('tel-cycle')
};

// Canvas context
let ctx2d = null;
if (elements.canvas) {
  ctx2d = elements.canvas.getContext('2d');
}

/**
 * Display error banner
 */
function showError(title, message) {
  console.error(`[Krell Synthesizer] ${title}: ${message}`);
  if (elements.errorTitle) elements.errorTitle.textContent = title;
  if (elements.errorMessage) elements.errorMessage.textContent = message;
  if (elements.errorBanner) elements.errorBanner.hidden = false;
  if (elements.statusDot) {
    elements.statusDot.className = 'badge-dot error';
  }
  if (elements.statusLabel) {
    elements.statusLabel.textContent = `Error: ${title}`;
  }
}
function clearError() {
  if (elements.errorBanner) elements.errorBanner.hidden = true;
}

/**
 * Update system status badge
 */
function updateSystemStatus(status, text) {
  if (elements.statusDot) {
    elements.statusDot.className = `badge-dot ${status}`;
  }
  if (elements.statusLabel) {
    elements.statusLabel.textContent = text;
  }
}

/**
 * Format readouts
 */
function updatePanReadout(val) {
  let text = 'Center (C)';
  if (val < -0.02) {
    text = `L ${Math.abs(Math.round(val * 100))}%`;
  } else if (val > 0.02) {
    text = `R ${Math.round(val * 100)}%`;
  }
  if (elements.readoutPan) {
    elements.readoutPan.textContent = text;
  }
  if (elements.paramPan) {
    elements.paramPan.setAttribute('aria-valuenow', Number(val).toFixed(2));
    elements.paramPan.setAttribute('aria-valuetext', text);
  }
}

function updateGainReadout(val) {
  const db = linearToDb(val);
  const dbStr = db === -Infinity ? '-inf dB' : `${db.toFixed(1)} dB`;
  const text = `${dbStr} (${val.toFixed(2)})`;
  if (elements.readoutGain) {
    elements.readoutGain.textContent = text;
  }
  if (elements.paramGain) {
    elements.paramGain.setAttribute('aria-valuenow', val.toFixed(3));
    elements.paramGain.setAttribute('aria-valuetext', text);
  }
}

function updatePaceReadout(val) {
  const text = `${Number(val).toFixed(2)}×`;
  if (elements.readoutPace) elements.readoutPace.textContent = text;
  if (elements.paramPace) {
    elements.paramPace.setAttribute('aria-valuenow', Number(val).toFixed(2));
    elements.paramPace.setAttribute('aria-valuetext', `${Number(val).toFixed(2)} times`);
  }
}

function updateRootReadout(val) {
  const freq = Math.round(Number(val));
  const note = freqToNoteName(freq);
  const text = `${freq} Hz (${note})`;
  if (elements.readoutRoot) elements.readoutRoot.textContent = text;
  if (elements.paramRoot) {
    elements.paramRoot.setAttribute('aria-valuenow', freq);
    elements.paramRoot.setAttribute('aria-valuetext', `${freq} Hertz, Note ${note}`);
  }
}

function updateSpreadReadout(val) {
  const text = `${Number(val).toFixed(2)} Oct`;
  if (elements.readoutSpread) elements.readoutSpread.textContent = text;
  if (elements.paramSpread) {
    elements.paramSpread.setAttribute('aria-valuenow', Number(val).toFixed(2));
    elements.paramSpread.setAttribute('aria-valuetext', `${Number(val).toFixed(2)} Octaves`);
  }
}

function updateMemoryReadout(val) {
  const text = `${Number(val).toFixed(2)}×`;
  if (elements.readoutMemory) elements.readoutMemory.textContent = text;
  if (elements.paramMemory) {
    elements.paramMemory.setAttribute('aria-valuenow', Number(val).toFixed(2));
    elements.paramMemory.setAttribute('aria-valuetext', `${Number(val).toFixed(2)} times`);
  }
}

function updateSpringReadout(val) {
  const percent = Math.round(Number(val) * 100);
  const text = `${percent}%`;
  if (elements.readoutSpring) elements.readoutSpring.textContent = text;
  if (elements.paramSpring) {
    elements.paramSpring.setAttribute('aria-valuenow', Number(val).toFixed(2));
    elements.paramSpring.setAttribute('aria-valuetext', `${percent} percent`);
  }
}

function updateModampReadout(val) {
  const percent = Math.round(Number(val) * 100);
  const text = `${percent}%`;
  if (elements.readoutModamp) elements.readoutModamp.textContent = text;
  if (elements.paramModamp) {
    elements.paramModamp.setAttribute('aria-valuenow', Number(val).toFixed(2));
    elements.paramModamp.setAttribute('aria-valuetext', `${percent} percent`);
  }
}

function updateModRateReadout(val) {
  const freq = Math.round(Number(val));
  const text = `${freq} Hz`;
  if (elements.readoutModRate) elements.readoutModRate.textContent = text;
  if (elements.paramModRate) {
    elements.paramModRate.setAttribute('aria-valuenow', freq);
    elements.paramModRate.setAttribute('aria-valuetext', `${freq} Hertz`);
  }
}

/**
 * Apply AudioParam value safely
 */
function setWorkletParam(name, val) {
  if (state.workletNode && state.workletNode.parameters.has(name)) {
    const param = state.workletNode.parameters.get(name);
    // k-rate AudioParams in our worklet
    const now = state.audioCtx ? state.audioCtx.currentTime : 0;
    param.setValueAtTime(val, now);
  }
}

/**
 * Apply AudioParam value to effects worklet safely
 */
function setEffectsParam(name, val) {
  if (state.effectsNode && state.effectsNode.parameters.has(name)) {
    const param = state.effectsNode.parameters.get(name);
    const now = state.audioCtx ? state.audioCtx.currentTime : 0;
    param.setValueAtTime(val, now);
  }
}

/**
 * Set native parameter with 20ms smoothing
 */
function setNativeParam(param, val) {
  if (!param || !state.audioCtx) return;
  const timeConstant = 0.020; // 20ms smoothing
  const now = state.audioCtx.currentTime;
  param.setTargetAtTime(val, now, timeConstant);
}

/**
 * Apply all current control state to the active audio graph
 */
function applyAllParamsToGraph() {
  if (!state.workletNode || !state.audioCtx) return;

  setWorkletParam('waveform', state.params.waveform);
  setWorkletParam('pace', state.params.pace);
  setWorkletParam('root', state.params.root);
  setWorkletParam('spread', state.params.spread);
  setWorkletParam('memory', state.params.memory);

  setEffectsParam('spring', state.params.spring);
  setEffectsParam('modamp', state.params.modamp);
  setEffectsParam('modRate', state.params.modRate);
  if (state.pannerNode) {
    setNativeParam(state.pannerNode.pan, state.params.pan);
  }

  if (state.gainNode && state.isRunning) {
    setNativeParam(state.gainNode.gain, state.params.gain);
  }
}

/**
 * Check if the browser environment supports AudioWorklet securely
 */
function verifyEnvironment() {
  const isSecure = window.isSecureContext ||
    window.location.hostname === 'localhost' ||
    window.location.hostname === '127.0.0.1';

  if (!isSecure) {
    showError(
      'Insecure Context',
      'AudioWorklet requires a secure origin (HTTPS) or local address (http://localhost or http://127.0.0.1).'
    );
    return false;
  }

  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) {
    showError(
      'Web Audio Unsupported',
      'This browser does not support the Web Audio API standard.'
    );
    return false;
  }

  if (typeof AudioWorkletNode === 'undefined') {
    showError(
      'AudioWorklet Unsupported',
      'AudioWorkletNode is not supported in this browser environment.'
    );
    return false;
  }

  return true;
}

/**
 * Clean up partially constructed or failed audio graph
 */
async function cleanupAudioGraph() {
  try {
    if (state.workletNode) {
      state.workletNode.disconnect();
      state.workletNode = null;
    }
    if (state.effectsNode) {
      state.effectsNode.disconnect();
      state.effectsNode = null;
    }
    if (state.analyserNode) {
      state.analyserNode.disconnect();
      state.analyserNode = null;
    }
    if (state.pannerNode) {
      state.pannerNode.disconnect();
      state.pannerNode = null;
    }
    if (state.gainNode) {
      state.gainNode.disconnect();
      state.gainNode = null;
    }
    if (state.audioCtx) {
      if (state.audioCtx.state !== 'closed') {
        await state.audioCtx.close();
      }
      state.audioCtx = null;
    }
  } catch (err) {
    console.warn('[Krell Synthesizer] Error cleaning audio graph:', err);
  } finally {
    state.hasInitialized = false;
    state.isRunning = false;
  }
}

/**
 * Initialize AudioContext and AudioWorklet graph lazily on first user gesture
 */
async function initAudioGraph() {
  if (state.hasInitialized && state.audioCtx && state.audioCtx.state !== 'closed') {
    return true;
  }

  if (!verifyEnvironment()) {
    return false;
  }

  let ctx = null;
  let worklet = null;
  let effects = null;
  let analyser = null;
  let panner = null;
  let masterGain = null;
  try {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    ctx = new AudioContextClass();
    state.audioCtx = ctx;

    // Check audioWorklet availability on context
    if (!ctx.audioWorklet || typeof ctx.audioWorklet.addModule !== 'function') {
      throw new Error('AudioContext audioWorklet property is unavailable in this browser.');
    }

    // Listen to state changes (interrupted / suspended by OS or browser)
    ctx.addEventListener('statechange', () => {
      handleContextStateChange();
    });

    // Load worklet modules (voice generator and reverb effects)
    await Promise.all([
      ctx.audioWorklet.addModule(new URL('./audio/krell-worklet.js', import.meta.url)),
      ctx.audioWorklet.addModule(new URL('./audio/reverb-worklet.js', import.meta.url))
    ]);
    const workletOptions = {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [1]
    };
    if (state.cachedSeed !== null) {
      workletOptions.processorOptions = { seed: state.cachedSeed };
    }
    worklet = new AudioWorkletNode(ctx, 'krell-voice', workletOptions);
    state.workletNode = worklet;
    // Telemetry handler from worklet
    worklet.port.onmessage = (event) => {
      const data = event.data;
      if (!data) return;
      if (data.type === 'telemetry') {
        handleTelemetryMessage(data);
      }
    };


    // Create mono effects node (pure MODAMP multiplication -> final spring reverb)
    effects = new AudioWorkletNode(ctx, 'krell-reverb', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1]
    });
    state.effectsNode = effects;
    // Pre-pan AnalyserNode for oscilloscope
    analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.5;
    state.analyserNode = analyser;
    state.scopeData = new Float32Array(analyser.fftSize);

    // Native StereoPannerNode
    panner = ctx.createStereoPanner();
    state.pannerNode = panner;

    // Master GainNode
    masterGain = ctx.createGain();
    masterGain.gain.setValueAtTime(0.0, ctx.currentTime); // Start silent to avoid pops
    state.gainNode = masterGain;

    // Wire graph: worklet -> effects -> analyser -> panner -> gain -> destination
    worklet.connect(effects);
    effects.connect(analyser);
    analyser.connect(panner);
    panner.connect(masterGain);
    masterGain.connect(ctx.destination);
    state.hasInitialized = true;
    return true;
  } catch (err) {
    showError('Audio Initialization Failed', err.message || String(err));
    await cleanupAudioGraph();
    return false;
  }
}

/**
 * Handle state change on AudioContext
 */
function handleContextStateChange() {
  if (!state.audioCtx) return;
  const ctxState = state.audioCtx.state;

  if (ctxState === 'suspended' || ctxState === 'interrupted') {
    state.isRunning = false;
    stopScopeLoop();
    updateSystemStatus('suspended', `Audio ${ctxState === 'interrupted' ? 'Interrupted' : 'Suspended'}`);
    if (elements.btnPlay) {
      elements.btnPlay.classList.remove('active');
      elements.btnPlay.setAttribute('aria-label', 'Resume Audio');
    }
    if (elements.btnPlayText) {
      elements.btnPlayText.textContent = 'Resume Synthesis';
    }
    if (elements.scopeOverlay) {
      elements.scopeOverlay.classList.remove('hidden');
    }
    if (elements.scopeWatermark) {
      elements.scopeWatermark.textContent = 'AUDIO SUSPENDED';
    }
  } else if (ctxState === 'running') {
    // If external system/OS resumed the audio context while initialized and not in manual transition
    if (state.hasInitialized && !state.isTransitioning) {
      state.isRunning = true;
      state.isCanvasVisible = !document.hidden;
      updateSystemStatus('active', 'Synthesizer Active • Krell Voice Running');

      if (elements.btnPlay) {
        elements.btnPlay.classList.add('active');
        elements.btnPlay.setAttribute('aria-label', 'Pause Audio');
      }
      if (elements.btnPlayText) {
        elements.btnPlayText.textContent = 'Pause Synthesis';
      }
      if (elements.scopeOverlay) {
        elements.scopeOverlay.classList.add('hidden');
      }

      if (state.workletNode) {
        state.workletNode.port.postMessage({ type: 'telemetry', enabled: state.isCanvasVisible });
      }

      if (state.isCanvasVisible) {
        startScopeLoop();
      } else {
        stopScopeLoop();
      }
    }
  } else if (ctxState === 'closed') {
    state.isRunning = false;
    state.hasInitialized = false;
    stopScopeLoop();
    updateSystemStatus('error', 'Audio Context Closed');
    if (elements.btnPlay) {
      elements.btnPlay.classList.remove('active');
      elements.btnPlay.setAttribute('aria-label', 'Start Audio');
    }
    if (elements.btnPlayText) {
      elements.btnPlayText.textContent = 'Start Synthesis';
    }
  }
}
/**
 * Handle incoming telemetry from worklet
 */
function handleTelemetryMessage(msg) {
  // msg: { type:'telemetry', envelope:0..1, frequency:Hz, cycle:int, stage:'rise'|'fall', rise:sec, fall:sec, resistance:ohms }
  state.telemetry.envelope = msg.envelope ?? 0;
  state.telemetry.frequency = msg.frequency ?? 110;
  state.telemetry.cycle = msg.cycle ?? 0;
  state.telemetry.stage = msg.stage ?? '—';
  state.telemetry.rise = msg.rise ?? 0;
  state.telemetry.fall = msg.fall ?? 0;
  state.telemetry.resistance = msg.resistance ?? 0;

  // Push envelope to history ring buffer for visualization
  state.historyEnv.copyWithin(0, 1);
  state.historyEnv[state.historyEnv.length - 1] = state.telemetry.envelope;

  // Update DOM readouts if visible
  if (state.isCanvasVisible) {
    renderTelemetryDOM();
  }
}

/**
 * Render telemetry stats into DOM
 */
function renderTelemetryDOM() {
  const { stage, frequency, cycle, rise, fall, resistance } = state.telemetry;

  if (elements.telStage) {
    const stageUpper = stage ? String(stage).toUpperCase() : '—';
    elements.telStage.textContent = stageUpper;
    elements.telStage.style.color = stage === 'rise' ? 'var(--amber-bright)' : 'var(--cyan-subtle)';
  }

  if (elements.telPitch) {
    elements.telPitch.textContent = freqToNoteName(frequency);
  }

  if (elements.telFreq) {
    elements.telFreq.textContent = `${Math.round(frequency)} Hz`;
  }

  if (elements.telDuration) {
    elements.telDuration.textContent = `${Number(rise).toFixed(2)}s / ${Number(fall).toFixed(2)}s`;
  }

  if (elements.telRes) {
    const r = Math.round(resistance);
    if (r >= 1000000) {
      elements.telRes.textContent = `${(r / 1000000).toFixed(2)} MΩ`;
    } else if (r >= 1000) {
      elements.telRes.textContent = `${(r / 1000).toFixed(1)} kΩ`;
    } else {
      elements.telRes.textContent = `${r} Ω`;
    }
  }

  if (elements.telCycle) {
    elements.telCycle.textContent = `#${cycle}`;
  }
}

/**
 * Clear telemetry readings on standby
 */
function clearTelemetryDOM() {
  if (elements.telStage) elements.telStage.textContent = '—';
  if (elements.telPitch) elements.telPitch.textContent = '—';
  if (elements.telFreq) elements.telFreq.textContent = '—';
  if (elements.telDuration) elements.telDuration.textContent = '—';
  if (elements.telRes) elements.telRes.textContent = '—';
  if (elements.telCycle) elements.telCycle.textContent = '—';
}

/**
 * Start or resume audio graph
 */
async function startAudio() {
  if (state.isTransitioning) return;
  state.isTransitioning = true;
  clearError();

  try {
    if (!state.hasInitialized) {
      const ok = await initAudioGraph();
      if (!ok) {
        state.isTransitioning = false;
        return;
      }
    }
    if (state.audioCtx.state === 'suspended' || state.audioCtx.state === 'interrupted') {
      await state.audioCtx.resume();
    }

    // Apply all cached controls
    applyAllParamsToGraph();

    // Ramp master gain up to the selected parameter target using 20ms smoothing
    const now = state.audioCtx.currentTime;
    state.gainNode.gain.cancelScheduledValues(now);
    state.gainNode.gain.setValueAtTime(state.gainNode.gain.value, now);
    state.gainNode.gain.setTargetAtTime(state.params.gain, now, 0.020);

    // Update canvas visibility from current document state
    state.isCanvasVisible = !document.hidden;

    // Send explicit telemetry state ({ enabled: !document.hidden })
    if (state.workletNode) {
      state.workletNode.port.postMessage({ type: 'telemetry', enabled: state.isCanvasVisible });
    }

    state.isRunning = true;
    updateSystemStatus('active', 'Synthesizer Active • Krell Voice Running');

    if (elements.btnPlay) {
      elements.btnPlay.classList.add('active');
      elements.btnPlay.setAttribute('aria-label', 'Pause Audio');
    }
    if (elements.btnPlayText) {
      elements.btnPlayText.textContent = 'Pause Synthesis';
    }
    if (elements.scopeOverlay) {
      elements.scopeOverlay.classList.add('hidden');
    }

    // Start scope loop only if visible
    if (state.isCanvasVisible) {
      startScopeLoop();
    } else {
      stopScopeLoop();
    }
  } catch (err) {
    showError('Playback Error', err.message || String(err));
  } finally {
    state.isTransitioning = false;
  }
}
/**
 * Pause / Stop audio graph
 * Requirement: "stopping ramps gain to zero then suspends after ramp (never leave zero gain when resuming)"
 */
async function pauseAudio() {
  if (state.isTransitioning || !state.audioCtx || !state.isRunning) return;
  state.isTransitioning = true;

  try {
    const rampTime = 0.040; // 40ms smooth ramp to 0
    const now = state.audioCtx.currentTime;

    if (state.gainNode) {
      state.gainNode.gain.cancelScheduledValues(now);
      state.gainNode.gain.setValueAtTime(state.gainNode.gain.value, now);
      state.gainNode.gain.linearRampToValueAtTime(0.0, now + rampTime);
    }

    // Wait for the ramp to complete before suspending context
    await new Promise((resolve) => setTimeout(resolve, Math.round(rampTime * 1000) + 10));

    if (state.audioCtx.state === 'running') {
      await state.audioCtx.suspend();
    }

    // Notify worklet to stop telemetry
    if (state.workletNode) {
      state.workletNode.port.postMessage({ type: 'telemetry', enabled: false });
    }

    state.isRunning = false;
    updateSystemStatus('suspended', 'Synthesizer Paused • Graph Retained');

    if (elements.btnPlay) {
      elements.btnPlay.classList.remove('active');
      elements.btnPlay.setAttribute('aria-label', 'Start Audio');
    }
    if (elements.btnPlayText) {
      elements.btnPlayText.textContent = 'Resume Synthesis';
    }
    if (elements.scopeOverlay) {
      elements.scopeOverlay.classList.remove('hidden');
    }
    if (elements.scopeWatermark) {
      elements.scopeWatermark.textContent = 'AUDIO PAUSED';
    }

    stopScopeLoop();
  } catch (err) {
    showError('Pause Error', err.message || String(err));
  } finally {
    state.isTransitioning = false;
  }
}

/**
 * Toggle Play/Pause on transport button click
 */
async function togglePlay() {
  if (state.isRunning) {
    await pauseAudio();
  } else {
    await startAudio();
  }
}

function reseed() {
  // Generate a random 32-bit unsigned integer
  const seed = (Math.random() * 0xFFFFFFFF) >>> 0;
  state.cachedSeed = seed;
  if (state.workletNode) {
    state.workletNode.port.postMessage({ type: 'reseed', seed });
  }

  // Visual feedback on button
  if (elements.btnReseed) {
    elements.btnReseed.classList.add('active');
    setTimeout(() => elements.btnReseed.classList.remove('active'), 200);
  }
}

/**
 * Oscilloscope & Envelope Visualizer Loop
 * Uses reusable typed arrays and DPR-aware scaling. Never allocates in RAF loop.
 */
function resizeCanvas() {
  if (!elements.canvas || !ctx2d) return;
  const dpr = window.devicePixelRatio || 1;
  const rect = elements.canvas.getBoundingClientRect();
  const width = Math.floor(rect.width * dpr);
  const height = Math.floor(rect.height * dpr);

  if (elements.canvas.width !== width || elements.canvas.height !== height) {
    elements.canvas.width = width;
    elements.canvas.height = height;
  }
}

function startScopeLoop() {
  if (state.rafId !== null) return;
  resizeCanvas();
  renderFrame();
}

function stopScopeLoop() {
  if (state.rafId !== null) {
    cancelAnimationFrame(state.rafId);
    state.rafId = null;
  }
  // Draw resting grid line
  drawRestingScope();
}

function drawRestingScope() {
  if (!ctx2d || !elements.canvas) return;
  const w = elements.canvas.width;
  const h = elements.canvas.height;
  ctx2d.clearRect(0, 0, w, h);

  // Background grid
  drawScopeGrid(w, h);

  // Flat amber center line
  ctx2d.strokeStyle = 'rgba(245, 158, 11, 0.4)';
  ctx2d.lineWidth = (window.devicePixelRatio || 1);
  ctx2d.beginPath();
  ctx2d.moveTo(0, h * 0.5);
  ctx2d.lineTo(w, h * 0.5);
  ctx2d.stroke();
}

function drawScopeGrid(w, h) {
  const dpr = window.devicePixelRatio || 1;
  ctx2d.strokeStyle = 'rgba(37, 43, 51, 0.6)';
  ctx2d.lineWidth = 1 * dpr;

  // Horizontal divisions
  const numH = 4;
  for (let i = 1; i < numH; i++) {
    const y = (h / numH) * i;
    ctx2d.beginPath();
    ctx2d.moveTo(0, y);
    ctx2d.lineTo(w, y);
    ctx2d.stroke();
  }

  // Vertical divisions
  const numV = 8;
  for (let j = 1; j < numV; j++) {
    const x = (w / numV) * j;
    ctx2d.beginPath();
    ctx2d.moveTo(x, 0);
    ctx2d.lineTo(x, h);
    ctx2d.stroke();
  }
}

function renderFrame() {
  if (!state.isRunning || !state.isCanvasVisible) {
    state.rafId = null;
    return;
  }

  if (ctx2d && elements.canvas && state.analyserNode && state.scopeData) {
    const w = elements.canvas.width;
    const h = elements.canvas.height;
    const dpr = window.devicePixelRatio || 1;

    // Grab time-domain data into reusable buffer
    state.analyserNode.getFloatTimeDomainData(state.scopeData);

    ctx2d.clearRect(0, 0, w, h);
    drawScopeGrid(w, h);

    // 1. Draw Audio Waveform (Amber)
    ctx2d.strokeStyle = '#fbbf24';
    ctx2d.lineWidth = 2 * dpr;
    ctx2d.beginPath();

    const bufferLength = state.scopeData.length;
    const sliceWidth = w / bufferLength;
    let x = 0;

    for (let i = 0; i < bufferLength; i++) {
      const v = state.scopeData[i];
      // v is in -1..1 range; scale to canvas height (center = 0.5)
      const y = (0.5 - v * 0.45) * h;

      if (i === 0) {
        ctx2d.moveTo(x, y);
      } else {
        ctx2d.lineTo(x, y);
      }
      x += sliceWidth;
    }
    ctx2d.stroke();

    // 2. Draw Envelope Trajectory overlay (Cyan subtle)
    const envHistoryLen = state.historyEnv.length;
    if (envHistoryLen > 1) {
      ctx2d.strokeStyle = 'rgba(56, 189, 248, 0.85)';
      ctx2d.lineWidth = 1.5 * dpr;
      ctx2d.beginPath();
      const stepX = w / (envHistoryLen - 1);
      for (let k = 0; k < envHistoryLen; k++) {
        const envVal = state.historyEnv[k]; // 0..1
        // Map 0..1 to bottom-to-top range
        const ey = (1 - envVal * 0.9 - 0.05) * h;
        const ex = k * stepX;
        if (k === 0) {
          ctx2d.moveTo(ex, ey);
        } else {
          ctx2d.lineTo(ex, ey);
        }
      }
      ctx2d.stroke();
    }
  }

  state.rafId = requestAnimationFrame(renderFrame);
}

/**
 * Handle document visibility change
 * Requirement: "hidden UI disables worklet telemetry and cancels requestAnimationFrame, but audio continues."
 */
function handleVisibilityChange() {
  if (document.hidden) {
    state.isCanvasVisible = false;
    if (state.rafId !== null) {
      cancelAnimationFrame(state.rafId);
      state.rafId = null;
    }
    if (state.workletNode) {
      state.workletNode.port.postMessage({ type: 'telemetry', enabled: false });
    }
  } else {
    state.isCanvasVisible = true;
    if (state.workletNode && state.isRunning) {
      state.workletNode.port.postMessage({ type: 'telemetry', enabled: true });
    }
    if (state.isRunning) {
      resizeCanvas();
      startScopeLoop();
    }
  }
}

/**
 * Setup UI Event Listeners
 */
function setupEventListeners() {
  // Play / Pause Button
  if (elements.btnPlay) {
    elements.btnPlay.addEventListener('click', togglePlay);
  }

  // Reseed Button
  if (elements.btnReseed) {
    elements.btnReseed.addEventListener('click', reseed);
  }

  // Waveform Radio buttons
  const waveRadios = [elements.radioSine, elements.radioTri];
  waveRadios.forEach((radio) => {
    if (!radio) return;
    radio.addEventListener('change', (e) => {
      const val = parseFloat(e.target.value);
      state.params.waveform = val;
      setWorkletParam('waveform', val);
    });
  });

  // Pace Slider
  if (elements.paramPace) {
    elements.paramPace.addEventListener('input', (e) => {
      const val = parseFloat(e.target.value);
      state.params.pace = val;
      updatePaceReadout(val);
      setWorkletParam('pace', val);
    });
  }

  // Root Pitch Slider
  if (elements.paramRoot) {
    elements.paramRoot.addEventListener('input', (e) => {
      const val = parseFloat(e.target.value);
      state.params.root = val;
      updateRootReadout(val);
      setWorkletParam('root', val);
    });
  }

  // Pitch Spread Slider
  if (elements.paramSpread) {
    elements.paramSpread.addEventListener('input', (e) => {
      const val = parseFloat(e.target.value);
      state.params.spread = val;
      updateSpreadReadout(val);
      setWorkletParam('spread', val);
    });
  }

  // Vactrol Memory Slider
  if (elements.paramMemory) {
    elements.paramMemory.addEventListener('input', (e) => {
      const val = parseFloat(e.target.value);
      state.params.memory = val;
      updateMemoryReadout(val);
      setWorkletParam('memory', val);
    });
  }
  // Spring Reverb Slider
  if (elements.paramSpring) {
    elements.paramSpring.addEventListener('input', (e) => {
      const val = parseFloat(e.target.value);
      state.params.spring = val;
      updateSpringReadout(val);
      setEffectsParam('spring', val);
    });
  }

  // MODAMP Amount Slider (carrier amplitude, pure multiplication without dry blend)
  if (elements.paramModamp) {
    elements.paramModamp.addEventListener('input', (e) => {
      const val = parseFloat(e.target.value);
      state.params.modamp = val;
      updateModampReadout(val);
      setEffectsParam('modamp', val);
    });
  }

  // MODAMP Frequency Slider (modulates entire voice signal)
  if (elements.paramModRate) {
    elements.paramModRate.addEventListener('input', (e) => {
      const val = parseFloat(e.target.value);
      state.params.modRate = val;
      updateModRateReadout(val);
      setEffectsParam('modRate', val);
    });
  }


  // Stereo Pan Slider
  if (elements.paramPan) {
    elements.paramPan.addEventListener('input', (e) => {
      const val = parseFloat(e.target.value);
      state.params.pan = val;
      updatePanReadout(val);
      if (state.pannerNode) {
        setNativeParam(state.pannerNode.pan, val);
      }
    });
  }

  // Master Gain Slider
  if (elements.paramGain) {
    elements.paramGain.addEventListener('input', (e) => {
      // Clamped strictly to 0..0.5
      let val = parseFloat(e.target.value);
      if (val > 0.5) val = 0.5;
      if (val < 0) val = 0;
      state.params.gain = val;
      updateGainReadout(val);
      // Only apply automation if actively running and not in transition
      if (state.gainNode && state.isRunning && !state.isTransitioning) {
        setNativeParam(state.gainNode.gain, val);
      }
    });
  }

  // Error dismiss button
  if (elements.errorDismiss) {
    elements.errorDismiss.addEventListener('click', clearError);
  }

  // Document visibility change
  document.addEventListener('visibilitychange', handleVisibilityChange);

  // Window resize for oscilloscope DPR handling
  window.addEventListener('resize', () => {
    resizeCanvas();
    if (!state.isRunning) {
      drawRestingScope();
    }
  });

  // Spacebar hotkey to toggle play/pause when not focused on an input
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && e.target.tagName !== 'INPUT' && e.target.tagName !== 'BUTTON') {
      e.preventDefault();
      togglePlay();
    }
  });
}

/**
 * Initialize application on DOM ready
 */
function initApp() {
  // Sync initial DOM slider values to state
  if (elements.paramPace) {
    state.params.pace = parseFloat(elements.paramPace.value);
    updatePaceReadout(state.params.pace);
  }
  if (elements.paramRoot) {
    state.params.root = parseFloat(elements.paramRoot.value);
    updateRootReadout(state.params.root);
  }
  if (elements.paramSpread) {
    state.params.spread = parseFloat(elements.paramSpread.value);
    updateSpreadReadout(state.params.spread);
  }
  if (elements.paramMemory) {
    state.params.memory = parseFloat(elements.paramMemory.value);
    updateMemoryReadout(state.params.memory);
  }
  if (elements.paramSpring) {
    state.params.spring = parseFloat(elements.paramSpring.value);
    updateSpringReadout(state.params.spring);
  }
  if (elements.paramModamp) {
    state.params.modamp = parseFloat(elements.paramModamp.value);
    updateModampReadout(state.params.modamp);
  }
  if (elements.paramModRate) {
    state.params.modRate = parseFloat(elements.paramModRate.value);
    updateModRateReadout(state.params.modRate);
  }
  if (elements.paramPan) {
    state.params.pan = parseFloat(elements.paramPan.value);
    updatePanReadout(state.params.pan);
  }
  if (elements.paramGain) {
    state.params.gain = parseFloat(elements.paramGain.value);
    updateGainReadout(state.params.gain);
  }
  if (elements.radioTri && elements.radioTri.checked) {
    state.params.waveform = 1;
  } else {
    state.params.waveform = 0;
  }

  setupEventListeners();
  resizeCanvas();
  drawRestingScope();
  clearTelemetryDOM();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initApp);
} else {
  initApp();
}

export {
  state,
  startAudio,
  pauseAudio,
  togglePlay,
  reseed
};
