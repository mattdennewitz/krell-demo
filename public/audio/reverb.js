/**
 * Pure balanced modulation followed by a final mono spring-reverb stage.
 *
 * SpringReverb is a procedural spring-inspired model: unequal recirculating
 * paths, cascaded dispersive allpasses and frequency-dependent losses. It is
 * not a measured impulse response or a mechanical/transistor-exact model.
 *
 * The ARP 4014 balanced-modulator submodule is NOT reverb hardware. Its ideal
 * bipolar multiplication acts directly on the input signal before the spring.
 * Amount scales the carrier amplitude; there is no dry-signal MODAMP blend.
 * No claim is made to emulate the 4014's preamp, transistor multipliers or
 * postamp at circuit level.
 */

const TWO_PI = 2 * Math.PI;
const WET_GAIN = 0.35;
const SETTLED_GAIN = 1e-8;

function samplesFor(sampleRate, seconds) {
  return Math.max(1, Math.round(sampleRate * seconds));
}

class DelayLine {
  constructor(sampleRate, seconds) {
    this.buffer = new Float32Array(samplesFor(sampleRate, seconds));
    this.index = 0;
  }

  read() {
    return this.buffer[this.index];
  }

  write(sample) {
    this.buffer[this.index] = sample;
    if (++this.index === this.buffer.length) this.index = 0;
  }

  process(sample) {
    const delayed = this.read();
    this.write(sample);
    return delayed;
  }
}

// H(z) = (z^-D - g) / (1 - g z^-D): unity magnitude, dispersive group delay.
// All coefficients below have |g| < 1; the delay lengths scale with sample rate.
class Allpass {
  constructor(sampleRate, seconds, coefficient) {
    this.delay = new DelayLine(sampleRate, seconds);
    this.coefficient = coefficient;
  }

  process(sample) {
    const delayed = this.delay.read();
    const output = delayed - this.coefficient * sample;
    this.delay.write(sample + this.coefficient * output);
    return output;
  }
}

class Highpass {
  constructor(sampleRate, cutoff) {
    this.pole = Math.exp(-TWO_PI * cutoff / sampleRate);
    this.low = 0;
  }

  process(sample) {
    this.low += (1 - this.pole) * (sample - this.low);
    return sample - this.low;
  }
}

// A highpass followed by a convex blend of unity and a one-pole lowpass.
// Each factor has frequency-response magnitude <= 1: damping cannot amplify
// a feedback loop, while the residual high band retains a metallic attack.
class Damping {
  constructor(sampleRate, lowCut, highCut, highBand) {
    this.highpass = new Highpass(sampleRate, lowCut);
    this.lowCoefficient = 1 - Math.exp(-TWO_PI * highCut / sampleRate);
    this.highBand = highBand;
    this.low = 0;
  }

  process(sample) {
    const highpassed = this.highpass.process(sample);
    this.low += this.lowCoefficient * (highpassed - this.low);
    return this.low + this.highBand * (highpassed - this.low);
  }
}

class SpringPath {
  constructor(sampleRate, delay, dispersion, feedback, cutoff) {
    this.delay = new DelayLine(sampleRate, delay);
    this.allpasses = [
      new Allpass(sampleRate, dispersion * 0.11, 0.62),
      new Allpass(sampleRate, dispersion * 0.19, 0.73),
      new Allpass(sampleRate, dispersion * 0.29, 0.69),
      new Allpass(sampleRate, dispersion * 0.41, 0.77)
    ];
    this.damping = new Damping(sampleRate, 85, cutoff, 0.22);
    this.feedback = feedback;
  }

  process(sample) {
    let reflected = this.delay.read();
    for (let i = 0; i < this.allpasses.length; i++) {
      reflected = this.allpasses[i].process(reflected);
    }
    reflected = this.damping.process(reflected);
    this.delay.write(0.65 * sample + this.feedback * reflected);
    return reflected;
  }
}

export class SpringReverb {
  constructor(sampleRate) {
    this.excitation = new Highpass(sampleRate, 130);
    this.paths = [
      new SpringPath(sampleRate, 0.0417, 0.0081, 0.86, 3700),
      new SpringPath(sampleRate, 0.0533, 0.0107, 0.87, 3200),
      new SpringPath(sampleRate, 0.0611, 0.0133, 0.88, 2800)
    ];
  }

  /** Return wet signal only; deterministic and allocation-free per sample. */
  process(sample) {
    const excitation = this.excitation.process(sample);
    let wet = 0;
    for (let i = 0; i < this.paths.length; i++) {
      wet += this.paths[i].process(excitation);
    }
    // Each independent loop is an allpass cascade times a passive damper times
    // feedback <= 0.88: its L2 loop norm is strictly below one. Delays and
    // dispersion give a few-second, frequency-dependent ringing decay.
    return 0.44 * wet;
  }
}

/**
 * Full depth gives balanced multiplication and sum/difference sidebands; zero
 * depth passes the input unchanged. Intermediate values vary modulation depth,
 * not a dry-versus-wet effect mix.
 */
export function balancedMultiply(a, b) {
  return a * b;
}

export class Modamp {
  constructor(sampleRate) {
    this.sampleRate = sampleRate;
    this.phase = 0;
    this.rate = 73;
    this.amount = 0;
    this.smoothing = 1 - Math.exp(-1 / (0.020 * sampleRate));
  }

  process(sample, rate = 73, amount = 0) {
    this.rate += this.smoothing * (rate - this.rate);
    this.amount += this.smoothing * (amount - this.amount);
    if (Math.abs(amount - this.amount) < SETTLED_GAIN) this.amount = amount;
    const carrier = Math.sin(this.phase);
    this.phase += TWO_PI * this.rate / this.sampleRate;
    if (this.phase >= TWO_PI) {
      this.phase -= TWO_PI * Math.floor(this.phase / TWO_PI);
    }
    const modulation = 1 - this.amount + this.amount * carrier;
    return balancedMultiply(sample, modulation);
  }
}

export class ReverbChain {
  constructor(sampleRate) {
    this.spring = new SpringReverb(sampleRate);
    this.modamp = new Modamp(sampleRate);
    this.springAmount = 0;
    this.smoothing = 1 - Math.exp(-1 / (0.020 * sampleRate));
  }

  /**
   * Render mono blocks of any size; input may be null when no node is connected.
   * Amount controls are 0..1 and modRate is 10..1000 Hz. The worklet supplies
   * these bounds. No per-sample/block allocation, saturation or hidden limiter.
   */
  render(input, output, controls) {
    const springTarget = controls.spring ?? 0;
    const modampTarget = controls.modamp ?? 0;
    const rate = controls.modRate ?? 73;
    let springAmount = this.springAmount;
    for (let i = 0; i < output.length; i++) {
      springAmount += this.smoothing * (springTarget - springAmount);
      // Settle spring return smoothing to exact endpoints. The oscillator and
      // spring history always advance, even when MODAMP amount is zero.
      if (Math.abs(springTarget - springAmount) < SETTLED_GAIN) {
        springAmount = springTarget;
      }
      const source = input ? input[i] : 0;
      const modulated = this.modamp.process(source, rate, modampTarget);
      const springWet = this.spring.process(modulated);
      output[i] = springAmount === 0 ? modulated : modulated + WET_GAIN * springAmount * springWet;
    }
    this.springAmount = springAmount;
  }
}
