/**
 * Buchla 292 Lowpass Gate (Both Mode) & Krell Synthesizer Engine
 *
 * Modeled after:
 * "A Digital Model of the Buchla Lowpass-Gate"
 * Julian Parker and Stefano D'Angelo, DAFx 2013.
 * https://dafx.de/paper-archive/2013/papers/44.dafx2013_submission_56.pdf
 *
 * ---------------------------------------------------------------------------
 * CIRCUIT TOPOLOGY & SIMULTANEOUS TRAPEZOIDAL KCL SOLVE (Section 2 & Both Mode)
 * ---------------------------------------------------------------------------
 * The Buchla 292 LPG in "Both" mode acts simultaneously as a voltage-controlled
 * lowpass filter and a voltage-controlled amplifier (VCA). The physical network
 * consists of a 2-stage ladder driven by dual photoresistors (VTL5C3/2):
 *
 *   Vin o---[ Rf ]---o Vx o---[ Rf ]---o Vo o---[ R ]---o GND
 *                     |                  |
 *                   [ C2 ]             [ C1 ]
 *                     |                  |
 *                    GND                GND
 *
 * Component values per Parker & D'Angelo (2013):
 *   C1 = 1.0 nF (1e-9 F)
 *   C2 = 220 pF (220e-12 F)
 *   C3 = 0 (unpopulated in Both mode)
 *   R  = 5.0 MΩ (5e6 Ω)
 *   Rf = Photoresistor resistance, modulated by vactrol illumination.
 *
 * Continuous-Time Kirchhoff's Current Law (KCL):
 *   At Node Vx:
 *     (Vx - Vin)/Rf + C2 * (dVx/dt) + (Vx - Vo)/Rf = 0
 *   At Node Vo:
 *     (Vo - Vx)/Rf + C1 * (dVo/dt) + Vo/R = 0
 *
 * Trapezoidal Discretization (Companion Model):
 *   With sampling period T = 1 / internalRate and trapezoidal parameter h = T / 2 = 1 / (2 * internalRate):
 *   Capacitor companion model currents:
 *     i_C2 = (C2 / h) * (Vx - sx)
 *     i_C1 = (C1 / h) * (Vo - so)
 *   where sx, so are companion history state variables (Volts).
 *
 * Normalizing KCL by capacitor companion conductances:
 *   Let:
 *     g = (1 / Rf) / (C2 / h) = h / (C2 * Rf)
 *     j = (1 / Rf) / (C1 / h) = h / (C1 * Rf)
 *     k = (1 / R)  / (C1 / h) = h / (C1 * R)   (fixed for a given sample rate)
 *
 * Nodal equations become:
 *   Node Vo:
 *     (Vo - so) + j * (Vo - Vx) + k * Vo = 0
 *     => Vo * (1 + j + k) = so + j * Vx
 *     => Vo = (so + j * Vx) / (1 + j + k)
 *
 *   Node Vx:
 *     (Vx - sx) + g * (Vx - Vin) + g * (Vx - Vo) = 0
 *     => Vx * (1 + 2*g) - g * Vo = sx + g * Vin
 *
 *   Coupled simultaneous linear solve:
 *     Substituting Vo into Vx equation:
 *     Vx * (1 + 2*g) - g * (so + j * Vx) / (1 + j + k) = sx + g * Vin
 *     Multiplying by (1 + j + k):
 *     Vx * [ (1 + 2*g) * (1 + j + k) - g * j ] = (sx + g * Vin) * (1 + j + k) + g * so
 *
 *   Determinant denominator:
 *     D = (1 + 2*g) * (1 + j + k) - g * j
 *     Note: D = 1 + 2*g + j + g*j + k + 2*g*k.
 *     Since g > 0, j > 0, k > 0, D >= 1, ensuring the matrix is nonsingular.
 *
 *   Node Solutions:
 *     Vx = ((sx + g * input) * (1 + j + k) + g * so) / D
 *     Vo = (so + j * Vx) / (1 + j + k)
 *
 *   Companion State Updates:
 *     sx[n+1] = 2 * Vx - sx[n]
 *     so[n+1] = 2 * Vo - so[n]
 *
 *   Steady-State DC Gain Verification:
 *     At DC (z = 1), sx = Vx and so = Vo.
 *     Substitution analytically simplifies to:
 *       Vo / Vin = R / (R + 2 * Rf)
 *     matching continuous circuit DC voltage division.
 *
 * ---------------------------------------------------------------------------
 * DYNAMIC NONLINEAR VACTROL MODEL (Section 3.2 & Equation 39)
 * ---------------------------------------------------------------------------
 * CdS photoresistors exhibit memory, asymmetric rise/fall response, and
 * output-dependent sluggish tail decay due to trapped electron release kinetics.
 *
 * 1. Control Drive & Patch Excitation Range:
 *    The model accepts 10 µA..40 mA, the paper's LED current bounds.
 *    This patch uses 10 µA..1 mA with quadratic envelope drive. Driving every
 *    cycle to 40 mA leaves the gate wide open through much of the vactrol tail;
 *    the lower excitation lets filtering and attenuation articulate each note.
 *    This is a patch-level approximation, not the paper's full CV/op-amp circuit.
 *
 * 2. Asymmetric Nonlinear Current Integrator:
 *    Target current clamped to model physical rating [10 µA, 40 mA].
 *    - Rise phase (target >= current): snappy ~12 ms time constant.
 *    - Fall phase (target < current): slow ~250 ms time constant scaled by
 *      `memory` parameter, with level-dependent slowing at low illumination
 *      per Section 3.2.
 *
 * 3. Parker & D'Angelo Eq. 39 Photoresistance:
 *    Rf = 3.464 / (current ^ 1.4) + 1136.212
 *    At 10 µA:  Rf ≈ 34.64 MΩ (gate closed, DC gain ≈ -23.4 dB)
 *    At 1 mA:   Rf ≈ 56.0 kΩ  (gate open, DC gain ≈ -0.2 dB)
 *    At 40 mA:  Rf ≈ 1.45 kΩ  (physical saturation limit)
 *
 * ---------------------------------------------------------------------------
 * KRELL FUNCTION GENERATOR & SYNTHESIS PIPELINE
 * ---------------------------------------------------------------------------
 * Sample-clocked analog computer emulation:
 * - Function generator cycles between 'rise' and 'fall' stages.
 * - Normalized stage progress increments by (dt * pace) / baseDuration,
 *   preserving phase continuity without jumps when pace changes.
 * - Rise durations logarithmically distributed in [0.03 s, 1.5 s].
 * - Fall durations logarithmically distributed in [0.08 s, 4.0 s],
 *   allowing snappy attacks to blend with long resonant tails.
 * - End-of-fall event increments cycle and executes Sample & Hold:
 *   stores normalized pitch random in [-0.5, 0.5], deriving pitch from
 *   the active spread parameter across all cycles, including initialization.
 * - 2x oversampled processing with 15-tap linear-phase halfband FIR decimation.
 * - Bandlimited triangle harmonic tables attenuate Nyquist aliasing.
 * - Gentle one-pole slewing on pitch and waveform eliminate clicks.
 * - Zero per-sample memory allocations; browser- and Node-importable.
 */

// Mulberry32 deterministic 32-bit PRNG
function createMulberry32(seed) {
  let s = (seed >>> 0) || 1;
  return function mulberry32() {
    s |= 0;
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// PRECOMPUTED BANDLIMITED HARMONIC WAVETABLES FOR OSCILLATOR
// ---------------------------------------------------------------------------
const TABLE_SIZE = 2048;
const NUM_HARMONIC_TABLES = 10;
const triangleWavetables = [];
const sawWavetables = [];
const squareWavetables = [];

(function initHarmonicTables() {
  for (let t = 0; t < NUM_HARMONIC_TABLES; t++) {
    const maxHarmonic = Math.max(1, Math.floor(512 / Math.pow(2, t)));
    const triTable = new Float32Array(TABLE_SIZE);
    const sawTable = new Float32Array(TABLE_SIZE);
    const sqTable = new Float32Array(TABLE_SIZE);

    for (let n = 0; n < TABLE_SIZE; n++) {
      const phase = (2 * Math.PI * n) / TABLE_SIZE;

      // Triangle: (8 / pi^2) * sum_{k=0} (-1)^k / (2k+1)^2 * sin((2k+1)*phase)
      let sumTri = 0;
      for (let k = 0; ; k++) {
        const harm = 2 * k + 1;
        if (harm > maxHarmonic) break;
        const sign = (k % 2 === 0) ? 1 : -1;
        sumTri += (sign / (harm * harm)) * Math.sin(harm * phase);
      }
      triTable[n] = (8 / (Math.PI * Math.PI)) * sumTri;

      // Sawtooth (phase-aligned with sine fundamental):
      // (2 / pi) * sum_{k=1} (-1)^(k+1) / k * sin(k * phase)
      let sumSaw = 0;
      for (let k = 1; k <= maxHarmonic; k++) {
        const sign = (k % 2 === 1) ? 1 : -1;
        sumSaw += (sign / k) * Math.sin(k * phase);
      }
      sawTable[n] = (2 / Math.PI) * sumSaw;

      // Square: (4 / pi) * sum_{k=0} 1 / (2k+1) * sin((2k+1)*phase)
      let sumSq = 0;
      for (let k = 0; ; k++) {
        const harm = 2 * k + 1;
        if (harm > maxHarmonic) break;
        sumSq += (1 / harm) * Math.sin(harm * phase);
      }
      sqTable[n] = (4 / Math.PI) * sumSq;
    }

    triangleWavetables.push({ maxHarmonic, table: triTable });
    sawWavetables.push({ maxHarmonic, table: sawTable });
    squareWavetables.push({ maxHarmonic, table: sqTable });
  }
})();

/**
 * Buchla 259 Timbre Circuit / Wavefolder
 *
 * Implements the virtual analog Buchla 259 wavefolder modeled by
 * Esqueda, Pöntynen, Välimäki, & Parker (DAFx-17, Edinburgh, 2017).
 *
 * The circuit features 5 parallel op-amp deadband center-clipping folding cells
 * plus a direct signal path, summed and filtered by a 1-pole lowpass filter
 * (R_F2 = 1.2 MΩ, C = 100 pF -> fc ≈ 1.33 kHz) discretized via the bilinear transform.
 */
export class BuchlaTimbre {
  /**
   * @param {number} sampleRate Processing sample rate in Hz (e.g. 2x oversampled rate)
   */
  constructor(sampleRate) {
    this.sampleRate = sampleRate;

    // Output 1-pole lowpass filter at fc ≈ 1326.29 Hz (1.2 MΩ, 100 pF)
    // Bilinear transform: H(z) = (b0 + b1*z^-1) / (1 + a1*z^-1)
    const fc = 1326.291;
    const wc = 2.0 * Math.PI * fc;
    const T = 1.0 / sampleRate;
    const denom = 2.0 + wc * T;
    this.b0 = (wc * T) / denom;
    this.b1 = this.b0;
    this.a1 = (wc * T - 2.0) / denom;

    this.x1 = 0.0;
    this.y1 = 0.0;
  }

  /**
   * Reset filter states
   */
  reset() {
    this.x1 = 0.0;
    this.y1 = 0.0;
  }

  /**
   * Process a single audio sample through the 5-cell Buchla 259 wavefolder.
   *
   * @param {number} input Normalized input sample in [-1, 1]
   * @param {number} timbre Timbre / fold amount [0 .. 1]
   * @returns {number} Folded output sample Vo
   */
  process(input, timbre) {
    const t = Math.max(0.0, Math.min(1.0, timbre));

    // Input drive: linear range is below 0.60V threshold.
    // At timbre = 0, drive = 0.55V (|Vin| <= 0.55 < 0.60V: all 5 folding cells in deadband).
    // At timbre = 1, drive = 6.00V, progressively activating all 5 folding stages:
    // cell 1 (0.60V), cell 4 (1.80V), cell 2 (2.994V), cell 5 (4.08V), cell 3 (5.46V).
    const drive = 0.55 + 5.45 * t;
    const vin = drive * input;

    // 5 parallel op-amp deadband center-clipping cells (Eqs. 13-17)
    const s = vin > 0.0 ? 1.0 : (vin < 0.0 ? -1.0 : 0.0);
    const av = Math.abs(vin);

    const v1 = av > 0.6000 ? (0.8333 * vin - 0.5000 * s) : 0.0;
    const v2 = av > 2.9940 ? (0.3768 * vin - 1.1281 * s) : 0.0;
    const v3 = av > 5.4600 ? (0.2829 * vin - 1.5446 * s) : 0.0;
    const v4 = av > 1.8000 ? (0.5743 * vin - 1.0338 * s) : 0.0;
    const v5 = av > 4.0800 ? (0.2673 * vin - 1.0907 * s) : 0.0;

    // Summing amplifier stage (Eq. 9) with direct path (+5.000 * vin)
    const vSum = -12.000 * v1 - 27.777 * v2 - 21.428 * v3 + 17.647 * v4 + 36.363 * v5 + 5.000 * vin;

    // Bilinear transform 1-pole lowpass filter (fc ≈ 1.33 kHz)
    const vout = this.b0 * vSum + this.b1 * this.x1 - this.a1 * this.y1;
    this.x1 = vSum;
    this.y1 = vout;

    // Normalize: at timbre = 0, DC / linear gain is direct path gain (5.0) * base drive (0.55) = 2.75.
    // Dividing by 2.75 preserves unity amplitude for input.
    return vout / 2.75;
  }
}
/**
 * Buchla 292 Vactrol Lowpass Gate (Both Mode)
 *
 * Implements Parker & D'Angelo (DAFx 2013) coupled 2-node KCL trapezoidal solve.
 */
export class BuchlaLPG {
  /**
   * @param {number} sampleRate Processing sample rate in Hz
   */
  constructor(sampleRate) {
    this.sampleRate = sampleRate;
    // Time step dt and trapezoidal integration parameter h = dt / 2
    this.dt = 1.0 / sampleRate;
    this.h = 1.0 / (2.0 * sampleRate);

    // Component values per Parker & D'Angelo (2013)
    this.C1 = 1.0e-9;    // 1 nF
    this.C2 = 220.0e-12; // 220 pF
    this.R = 5.0e6;      // 5 MΩ

    // Precompute constant fixed conductance k = h / (C1 * R)
    this.k = this.h / (this.C1 * this.R);
    this.hOverC1 = this.h / this.C1;
    this.hOverC2 = this.h / this.C2;

    // Vactrol current state initialized to dark current (10 µA)
    this.current = 10.0e-6;

    // Resistance per Eq. 39: Rf = 3.464 / (current^1.4) + 1136.212
    this.resistance = 3.464 / Math.pow(this.current, 1.4) + 1136.212;

    // Companion capacitor history states (Volts)
    this.sx = 0.0;
    this.so = 0.0;
  }

  /**
   * Process a single audio sample through the lowpass gate.
   *
   * @param {number} input Audio input sample (Volts / normalized amplitude)
   * @param {number} currentAmps Control current target in Amperes [10µA .. 40mA]
   * @param {number} [memory=1.0] Vactrol memory time constant scaling factor [0.4 .. 2.5]
   * @returns {number} Filtered output sample Vo
   */
  process(input, currentAmps, memory = 1.0) {
    // Constrain input current to physical vactrol operating range [10 µA .. 40 mA]
    const target = Math.max(10.0e-6, Math.min(40.0e-3, currentAmps));

    // Dynamic nonlinear vactrol model (Section 3.2):
    // Asymmetric rise/fall with level-dependent tail elongation
    let tau;
    if (target >= this.current) {
      tau = 0.012; // 12 ms rise anchor
    } else {
      const norm = (this.current - 10.0e-6) / (40.0e-3 - 10.0e-6);
      tau = 0.250 * memory * (0.6 + 0.8 * (1.0 - norm)); // 250 ms fall anchor with level dependence
    }

    // 1-pole exponential smoothing
    const alpha = 1.0 - Math.exp(-this.dt / tau);
    this.current += alpha * (target - this.current);

    // Compute photoresistance via Parker & D'Angelo Eq. 39
    this.resistance = 3.464 / Math.pow(this.current, 1.4) + 1136.212;

    // Normalized companion conductances
    const Rf = this.resistance;
    const invRf = 1.0 / Rf;
    const g = this.hOverC2 * invRf;
    const j = this.hOverC1 * invRf;
    const k = this.k;

    // Determinant denominator D = (1 + 2*g) * (1 + j + k) - g * j
    const onePlusJK = 1.0 + j + k;
    const D = (1.0 + 2.0 * g) * onePlusJK - g * j;

    // Simultaneous linear node voltage solve
    const Vx = ((this.sx + g * input) * onePlusJK + g * this.so) / D;
    const Vo = (this.so + j * Vx) / onePlusJK;

    // Companion capacitor state updates for next step
    this.sx = 2.0 * Vx - this.sx;
    this.so = 2.0 * Vo - this.so;

    return Vo;
  }
}

/**
 * Complete Krell Synthesizer Voice
 *
 * Implements sample-clocked envelope cycling, S&H pitch/duration logic,
 * continuously variable wave-shape oscillator (Sine -> Triangle -> Saw -> Square),
 * Buchla 259 timbre waveshaper, and 2x oversampled Buchla 292 LPG with decimation.
 */
export class KrellVoice {
  /**
   * @param {number} sampleRate Output sample rate in Hz (e.g. 44100 or 48000)
   * @param {number} [seed=1337] Unsigned integer PRNG seed
   */
  constructor(sampleRate, seed = 1337) {
    this.sampleRate = sampleRate;
    // 2x oversampling rate for audio oscillator, timbre folder & LPG
    this.internalRate = sampleRate * 2;
    this.dtInternal = 1.0 / this.internalRate;

    // Buchla 259 Timbre circuit / wavefolder running at 2x rate
    this.timbreShaper = new BuchlaTimbre(this.internalRate);

    // Internal LPG running at 2x oversampled rate
    this.lpg = new BuchlaLPG(this.internalRate);

    // Initialize PRNG
    this.reseed(seed);

    // Precompute smoothing filter coefficients for 2x internal rate
    // 8ms pitch slew, 20ms waveform slew, 20ms timbre slew
    this.freqAlpha = 1.0 - Math.exp(-this.dtInternal / 0.008);
    this.waveAlpha = 1.0 - Math.exp(-this.dtInternal / 0.020);
    this.timbreAlpha = 1.0 - Math.exp(-this.dtInternal / 0.020);
    // Function generator states
    this.stage = 'rise';
    this.stageProgress = 0.0; // Normalized progress in [0, 1]
    this.envelope = 0.0;
    this.cycle = 1;

    // Base rise/fall durations at pace = 1.0 (seconds, log-random distributions)
    // Rise: 0.03 s .. 1.5 s (50x ratio)
    // Fall: 0.08 s .. 4.0 s (50x ratio)
    this.baseRise = 0.03 * Math.pow(50.0, this.rand());
    this.baseFall = 0.08 * Math.pow(50.0, this.rand());
    this.riseDuration = this.baseRise;
    this.fallDuration = this.baseFall;

    // Normalized held pitch random in [-0.5, 0.5]
    this.heldPitchRandom = this.rand() - 0.5;
    this.currentFrequency = 110.0;
    this.targetFrequency = 110.0;

    // Waveform, Timbre & Oscillator states
    this.phase = 0.0;
    this.smoothedWaveform = 0.0;
    this.smoothedTimbre = 0.0;
    // 15-tap Halfband Decimation FIR Circular Buffer
    this.firBuffer = new Float32Array(16);
    this.firIndex = 0;

    // Telemetry state object
    this.state = {
      envelope: 0.0,
      frequency: this.currentFrequency,
      cycle: this.cycle,
      stage: this.stage,
      rise: this.riseDuration,
      fall: this.fallDuration,
      resistance: this.lpg.resistance
    };
  }

  /**
   * Reseed the PRNG without resetting audio phase or filter states.
   *
   * @param {number} seed Unsigned 32-bit integer seed
   */
  reseed(seed) {
    this.rand = createMulberry32(seed);
  }

  /**
   * Render an output block of mono audio samples.
   *
   * @param {Float32Array} output Destination buffer (any block length)
   * @param {Object} controls Parameter dictionary
   * @param {number} [controls.pace=1.0] Rate multiplier [0.25 .. 16.0]
   * @param {number} [controls.root=110.0] Root pitch in Hz [55 .. 440]
   * @param {number} [controls.spread=2.0] Pitch spread in octaves [0 .. 4]
   * @param {number} [controls.memory=1.0] Vactrol decay memory [0.4 .. 2.5]
   * @param {number} [controls.waveform=0.0] Variable wave shape [0 = sine .. 0.33 = tri .. 0.67 = saw .. 1.0 = sq]
   * @param {number} [controls.timbre=0.0] Buchla 259 timbre / wavefolder depth [0 .. 1]
   */
  render(output, controls) {
    const pace = Math.max(0.25, Math.min(16.0, controls.pace ?? 1.0));
    const root = Math.max(55.0, Math.min(440.0, controls.root ?? 110.0));
    const spread = Math.max(0.0, Math.min(4.0, controls.spread ?? 2.0));
    const memory = Math.max(0.4, Math.min(2.5, controls.memory ?? 1.0));
    const targetWave = Math.max(0.0, Math.min(1.0, controls.waveform ?? 0.0));
    const targetTimbre = Math.max(0.0, Math.min(1.0, controls.timbre ?? 0.0));
    const dt = this.dtInternal;
    const len = output.length;
    const freqAlpha = this.freqAlpha;
    const waveAlpha = this.waveAlpha;
    const timbreAlpha = this.timbreAlpha;

    // Symmetric 15-tap halfband FIR decimator non-zero coefficients
    const h0 = -0.003651;
    const h2 = 0.016179;
    const h4 = -0.068412;
    const h6 = 0.304948;
    const h7 = 0.501873;

    // Derive active target frequency from held pitch random and current spread
    this.targetFrequency = root * Math.pow(2.0, this.heldPitchRandom * spread);

    // Compute active display durations once per block
    this.riseDuration = this.baseRise / pace;
    this.fallDuration = this.baseFall / pace;

    // Normalized progress increments per internal step
    let progressInc = (dt * pace) / (this.stage === 'rise' ? this.baseRise : this.baseFall);

    for (let i = 0; i < len; i++) {
      // 2 oversampled sub-steps per output sample
      for (let sub = 0; sub < 2; sub++) {
        this.stageProgress += progressInc;

        if (this.stage === 'rise') {
          if (this.stageProgress >= 1.0) {
            this.stage = 'fall';
            this.stageProgress = 0.0;
            this.envelope = 1.0;
            progressInc = (dt * pace) / this.baseFall;
          } else {
            // Smooth cosine rise
            this.envelope = 0.5 * (1.0 - Math.cos(Math.PI * this.stageProgress));
          }
        } else {
          if (this.stageProgress >= 1.0) {
            // End of fall triggers the next envelope cycle and S&H
            this.cycle++;
            this.stage = 'rise';
            this.stageProgress = 0.0;
            this.envelope = 0.0;

            // Sample & Hold next pitch random in [-0.5, 0.5]
            this.heldPitchRandom = this.rand() - 0.5;
            this.targetFrequency = root * Math.pow(2.0, this.heldPitchRandom * spread);

            // Sample & Hold next base durations (log-random distribution)
            this.baseRise = 0.03 * Math.pow(50.0, this.rand());
            this.baseFall = 0.08 * Math.pow(50.0, this.rand());
            this.riseDuration = this.baseRise / pace;
            this.fallDuration = this.baseFall / pace;

            progressInc = (dt * pace) / this.baseRise;
          } else {
            // Smooth cosine fall
            this.envelope = 0.5 * (1.0 + Math.cos(Math.PI * this.stageProgress));
          }
        }

        // Smooth pitch, waveform and timbre transitions
        this.currentFrequency += freqAlpha * (this.targetFrequency - this.currentFrequency);
        this.smoothedWaveform += waveAlpha * (targetWave - this.smoothedWaveform);
        this.smoothedTimbre += timbreAlpha * (targetTimbre - this.smoothedTimbre);
        // Audio oscillator phase accumulator
        this.phase += this.currentFrequency * dt;
        if (this.phase >= 1.0) {
          this.phase -= Math.floor(this.phase);
        }

        // Pure sine wave fundamental
        const sine = Math.sin(2.0 * Math.PI * this.phase);

        let rawOsc;
        if (this.smoothedWaveform <= 0.0001) {
          // Pure sine when wave shape is 0
          rawOsc = sine;
        } else {
          // Bandlimited tables selected by frequency
          const maxHarmonicAllowed = Math.floor((this.internalRate * 0.5) / this.currentFrequency);
          let tableIdx = 0;
          while (tableIdx < NUM_HARMONIC_TABLES - 1 && triangleWavetables[tableIdx].maxHarmonic > maxHarmonicAllowed) {
            tableIdx++;
          }

          const pIdx = this.phase * TABLE_SIZE;
          const i0 = Math.floor(pIdx) & (TABLE_SIZE - 1);
          const frac = pIdx - Math.floor(pIdx);
          const i1 = (i0 + 1) & (TABLE_SIZE - 1);

          const triTbl = triangleWavetables[tableIdx].table;
          const tri = triTbl[i0] + frac * (triTbl[i1] - triTbl[i0]);

          const s = this.smoothedWaveform;
          if (s <= 0.333333) {
            // Sine -> Triangle morph [0 .. 0.333]
            const t = s / 0.333333;
            rawOsc = (1.0 - t) * sine + t * tri;
          } else if (s <= 0.666667) {
            // Triangle -> Sawtooth morph [0.333 .. 0.667]
            const sawTbl = sawWavetables[tableIdx].table;
            const saw = sawTbl[i0] + frac * (sawTbl[i1] - sawTbl[i0]);
            const t = (s - 0.333333) / 0.333334;
            rawOsc = (1.0 - t) * tri + t * saw;
          } else {
            // Sawtooth -> Square morph [0.667 .. 1.0]
            const sawTbl = sawWavetables[tableIdx].table;
            const saw = sawTbl[i0] + frac * (sawTbl[i1] - sawTbl[i0]);
            const sqTbl = squareWavetables[tableIdx].table;
            const sq = sqTbl[i0] + frac * (sqTbl[i1] - sqTbl[i0]);
            const t = (s - 0.666667) / 0.333333;
            rawOsc = (1.0 - t) * saw + t * sq;
          }
        }

        // Buchla 259 Timbre circuit / wavefolder process
        const shapedOsc = this.timbreShaper.process(rawOsc, this.smoothedTimbre);
        // Krell patch control drive:
        // Quadratic drive to 1 mA leaves room for the vactrol to close between
        // notes; the coupled circuit determines both attenuation and brightness.
        const ledCurrent = 10.0e-6 + (1.0e-3 - 10.0e-6) * (this.envelope * this.envelope);

        // Buchla 292 LPG process
        const lpgOut = this.lpg.process(shapedOsc, ledCurrent, memory);

        // Store into circular FIR buffer
        this.firBuffer[this.firIndex] = lpgOut;
        this.firIndex = (this.firIndex + 1) & 15;
      }

      // Compute decimated 15-tap linear-phase FIR output on downsampled boundary
      const idx = (this.firIndex - 1) & 15;
      const decimated =
        h0 * (this.firBuffer[idx] + this.firBuffer[(idx - 14) & 15]) +
        h2 * (this.firBuffer[(idx - 2) & 15] + this.firBuffer[(idx - 12) & 15]) +
        h4 * (this.firBuffer[(idx - 4) & 15] + this.firBuffer[(idx - 10) & 15]) +
        h6 * (this.firBuffer[(idx - 6) & 15] + this.firBuffer[(idx - 8) & 15]) +
        h7 * this.firBuffer[(idx - 7) & 15];

      output[i] = decimated;
    }

    // Update telemetry state values for readers
    this.state.envelope = this.envelope;
    this.state.frequency = this.currentFrequency;
    this.state.cycle = this.cycle;
    this.state.stage = this.stage;
    this.state.rise = this.riseDuration;
    this.state.fall = this.fallDuration;
    this.state.resistance = this.lpg.resistance;
  }
}
