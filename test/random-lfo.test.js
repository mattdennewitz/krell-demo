import test from 'node:test';
import assert from 'node:assert/strict';
import { RandomLFO } from '../public/audio/random-lfo.js';

test('random target period controls segment timing without resetting a trajectory', () => {
  const sampleRate = 1000;
  const lfo = new RandomLFO(sampleRate, 42);
  const buffer = new Float32Array(250);
  lfo.render(buffer, 1);
  const before = lfo.value;
  const sample = new Float32Array(1);
  lfo.render(sample, 0.1);
  assert.ok(Math.abs(sample[0] - before) < 0.002);
  lfo.render(new Float32Array(100), 0.1);
  assert.equal(lfo.segment, 1);
});

test('reseed preserves the active random trajectory and changes future targets', () => {
  const a = new RandomLFO(1000, 42);
  const b = new RandomLFO(1000, 42);
  const x = new Float32Array(200);
  const y = new Float32Array(200);
  a.render(x, 1);
  b.render(y, 1);
  a.reseed(99);
  a.render(x, 1);
  b.render(y, 1);
  assert.deepEqual(x, y);
  const futureA = new Float32Array(1400);
  const futureB = new Float32Array(1400);
  a.render(futureA, 1);
  b.render(futureB, 1);
  assert.notDeepEqual(futureA, futureB);
  assert.ok(futureA.every(value => value >= -1 && value <= 1));
});
