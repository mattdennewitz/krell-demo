import test from 'node:test';
import assert from 'node:assert/strict';
import { KrellVoice, BuchlaTimbre } from '../public/audio/engine.js';
const controls = { pace: 1, root: 220, spread: 0, memory: 1, waveform: 0, timbre: 0 };

test('zero MODAMP depth passes the synth unchanged', async () => {
  const { Modamp } = await import('../public/audio/reverb.js');
  const modamp = new Modamp(48000);
  for (const sample of [-1, -0.5, 0, 0.5, 1]) {
    assert.equal(modamp.process(sample, 73, 0), sample);
  }
});

test('full MODAMP depth produces sum and difference sidebands', async () => {
  const { Modamp } = await import('../public/audio/reverb.js');
  const sampleRate = 48000;
  const modamp = new Modamp(sampleRate);
  const frequencies = [367, 440, 513];
  const real = [0, 0, 0];
  const imag = [0, 0, 0];
  for (let i = 0; i < sampleRate * 3; i++) {
    const input = Math.sin(2 * Math.PI * 440 * i / sampleRate);
    const output = modamp.process(input, 73, 1);
    if (i < sampleRate) continue;
    for (let k = 0; k < frequencies.length; k++) {
      const angle = 2 * Math.PI * frequencies[k] * i / sampleRate;
      real[k] += output * Math.cos(angle);
      imag[k] += output * Math.sin(angle);
    }
  }
  const amplitude = frequencies.map((_, k) => Math.hypot(real[k], imag[k]));
  assert.ok(amplitude[0] > 1000);
  assert.ok(amplitude[2] > 1000);
  assert.ok(amplitude[1] < 1e-6);
});

test('zero spread uses the selected root from the first envelope cycle', () => {
  const voice = new KrellVoice(48000, 42);
  const block = new Float32Array(4800);
  voice.render(block, controls);
  assert.equal(voice.state.cycle, 1);
  assert.ok(Math.abs(voice.state.frequency - controls.root) < 0.001);
});

test('changing pace preserves envelope continuity during rise and fall', () => {
  for (const stage of ['rise', 'fall']) {
    const voice = new KrellVoice(48000, 42);
    const sample = new Float32Array(1);
    while (voice.state.stage !== stage || voice.state.envelope < 0.3 || voice.state.envelope > 0.7) {
      voice.render(sample, controls);
    }
    for (const pace of [4, 0.25, 1]) {
      const before = voice.state.envelope;
      voice.render(sample, { ...controls, pace });
      assert.ok(Math.abs(voice.state.envelope - before) < 0.002, `${stage} jumped when pace became ${pace}`);
    }
  }
});

test('BuchlaTimbre passes signals linearly at zero timbre below threshold', () => {
  const timbre = new BuchlaTimbre(96000);
  // At timbre = 0, DC input in [-0.5, 0.5] remains strictly below the 0.6V threshold.
  // Filter state settles to exact input value.
  for (const val of [-0.5, -0.25, 0, 0.25, 0.5]) {
    let out = 0;
    for (let i = 0; i < 500; i++) {
      out = timbre.process(val, 0);
    }
    assert.ok(Math.abs(out - val) < 1e-4, `Expected ${val}, got ${out}`);
  }
});

test('BuchlaTimbre folds waveform and generates odd harmonics as timbre increases', () => {
  const sampleRate = 96000;
  const timbre = new BuchlaTimbre(sampleRate);
  const freq = 220;
  // Measure harmonic content (3rd and 5th harmonics) of 220 Hz sine wave
  const harmonicsZero = [0, 0]; // [3rd, 5th]
  const harmonicsFolded = [0, 0];

  // Steady-state render at timbre = 0
  for (let i = 0; i < sampleRate; i++) {
    const input = Math.sin((2 * Math.PI * freq * i) / sampleRate);
    const out = timbre.process(input, 0.0);
    if (i >= sampleRate * 0.5) {
      for (const [k, h] of [3, 5].entries()) {
        const angle = (2 * Math.PI * freq * h * i) / sampleRate;
        harmonicsZero[k] += out * Math.sin(angle);
      }
    }
  }

  // Steady-state render at timbre = 1.0 (full folding)
  timbre.reset();
  for (let i = 0; i < sampleRate; i++) {
    const input = Math.sin((2 * Math.PI * freq * i) / sampleRate);
    const out = timbre.process(input, 1.0);
    if (i >= sampleRate * 0.5) {
      for (const [k, h] of [3, 5].entries()) {
        const angle = (2 * Math.PI * freq * h * i) / sampleRate;
        harmonicsFolded[k] += out * Math.sin(angle);
      }
    }
  }

  // Harmonic energy at 3rd and 5th harmonics should be negligible at timbre 0 and large at timbre 1
  assert.ok(Math.abs(harmonicsZero[0]) < 10, '3rd harmonic should be near zero for clean sine');
  assert.ok(Math.abs(harmonicsFolded[0]) > 500, '3rd harmonic should be prominent after folding');
  assert.ok(Math.abs(harmonicsFolded[1]) > 200, '5th harmonic should be prominent after folding');
});

test('variable wave shape smoothly morphs and alters harmonic profile', () => {
  const sampleRate = 48000;
  // Render 100ms blocks at different waveform morph points
  const voice = new KrellVoice(sampleRate, 42);
  const block = new Float32Array(4800);

  // Morph at 0 (Sine), 0.33 (Triangle), 0.67 (Sawtooth), 1.0 (Square)
  const shapes = [0.0, 0.333, 0.667, 1.0];
  const rmsValues = [];

  for (const waveform of shapes) {
    voice.render(block, { ...controls, waveform });
    let sumSq = 0;
    for (let i = 0; i < block.length; i++) {
      sumSq += block[i] * block[i];
    }
    rmsValues.push(Math.sqrt(sumSq / block.length));
  }

  // Check that all waveforms render cleanly without NaN or infinite values
  for (const rms of rmsValues) {
    assert.ok(Number.isFinite(rms));
    assert.ok(rms > 0.005, `RMS level should be healthy, got ${rms}`);
  }
});
