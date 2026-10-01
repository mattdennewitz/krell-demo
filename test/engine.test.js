import test from 'node:test';
import assert from 'node:assert/strict';
import { KrellVoice } from '../public/audio/engine.js';
const controls = { pace: 1, root: 220, spread: 0, memory: 1, waveform: 0 };

test('zero MODAMP amount multiplies the source to silence without blending', async () => {
  const { Modamp } = await import('../public/audio/reverb.js');
  const modamp = new Modamp(48000);
  // Allow its specified 20 ms carrier-amplitude ramp to settle at zero.
  for (let i = 0; i < 24000; i++) modamp.process(1, 73, 0);
  for (let i = 0; i < 128; i++) {
    assert.ok(Math.abs(modamp.process(Math.sin(i), 73, 0)) < 1e-12);
  }
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
