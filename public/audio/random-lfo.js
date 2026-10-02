/**
 * Random LFO Engine
 *
 * Provides a continuous, smoothly interpolated bipolar random low-frequency
 * oscillator for modulation of synthesizer parameters.
 *
 * Operational Timing Semantics:
 * - Deterministic PRNG: Uses Mulberry32 (32-bit state) initialized with an unsigned seed.
 * - Normalized Progress: Phase progress `p` advances per sample by 1 / (sampleRate * period).
 *   On timing / period changes, `p` is preserved across rate adjustments so the current
 *   trajectory is never reset or phase-shifted.
 * - Zero-Slope Boundaries: Segments are interpolated using a cubic smoothstep polynomial:
 *     S(p) = 3*p^2 - 2*p^3 = p * p * (3 - 2 * p)
 *   with S'(0) = 0 and S'(1) = 0. This ensures zero slope at segment endpoints, providing
 *   continuous C1 smooth transitions without audio pops or clicks.
 * - Boundary Target Selection: New random target values in [-1, 1] are drawn strictly at segment
 *   boundaries when normalized progress reaches or exceeds 1.0.
 * - Initial Conditions: Starts at 0.0 so the signal fades smoothly toward the first random target.
 * - Reseed Semantics: Calling `reseed(seed)` re-initializes the PRNG generator for subsequent
 *   endpoints without altering the current phase progress or interrupting the active segment,
 *   guaranteeing click-free reseed behavior during audio playback.
 * - Zero Allocations: Per-sample calculations are purely scalar and allocation-free.
 * - Block-Size Invariance: Output sample values depend purely on sample count and are identical
 *   regardless of render buffer size.
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

export class RandomLFO {
  /**
   * @param {number} sampleRate Context sample rate in Hz (e.g. 44100 or 48000)
   * @param {number} [seed=1337] Unsigned integer PRNG seed
   */
  constructor(sampleRate, seed = 1337) {
    this.sampleRate = sampleRate;
    this.progress = 0.0;
    this.segment = 0;
    this.startVal = 0.0;
    this.targetVal = 0.0;
    this.value = 0.0;
    this.hasRendered = false;
    this.reseed(seed);
  }

  /**
   * Generate next bipolar random value in [-1, 1]
   * @private
   */
  _nextRandom() {
    return this.rand() * 2.0 - 1.0;
  }

  /**
   * Reseed the PRNG generator.
   * If called before rendering starts, the initial target is derived from this seed.
   * If called mid-playback, current phase and active segment endpoints are preserved;
   * subsequent target endpoints will be drawn from the new seed.
   *
   * @param {number} seed Unsigned 32-bit integer seed
   */
  reseed(seed) {
    this.rand = createMulberry32(seed);
    if (!this.hasRendered) {
      this.targetVal = this._nextRandom();
    }
  }

  /**
   * Render continuous smooth bipolar LFO samples into the provided output buffer.
   *
   * @param {Float32Array} buffer Output channel buffer to populate
   * @param {number} [period=3] Period in seconds between new random targets (clamped to min 0.1s)
   */
  render(buffer, period = 3) {
    this.hasRendered = true;
    const safePeriod = Math.max(0.1, period);
    const dp = 1.0 / (this.sampleRate * safePeriod);
    const len = buffer.length;

    let p = this.progress;
    let sVal = this.startVal;
    let tVal = this.targetVal;
    let seg = this.segment;
    let val = this.value;

    for (let i = 0; i < len; i++) {
      // Smoothstep interpolation: zero first derivative at p=0 and p=1
      const t = p * p * (3.0 - 2.0 * p);
      val = sVal + (tVal - sVal) * t;
      buffer[i] = val;

      p += dp;
      if (p >= 1.0) {
        while (p >= 1.0) {
          seg++;
          sVal = tVal;
          tVal = this._nextRandom();
          p -= 1.0;
        }
      }
    }

    this.progress = p;
    this.startVal = sVal;
    this.targetVal = tVal;
    this.segment = seg;
    this.value = val;
  }
}
