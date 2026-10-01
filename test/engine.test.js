import test from 'node:test';
import assert from 'node:assert/strict';
import { KrellVoice } from '../public/audio/engine.js';
const controls = { pace: 1, root: 220, spread: 0, memory: 1, waveform: 0 };

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
