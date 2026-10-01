/** Pure balanced MODAMP multiplication followed by final spring reverb. */

import { ReverbChain } from './reverb.js';

class KrellReverbProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      {
        name: 'spring',
        defaultValue: 0,
        minValue: 0,
        maxValue: 1,
        automationRate: 'k-rate'
      },
      {
        name: 'modamp',
        defaultValue: 0,
        minValue: 0,
        maxValue: 1,
        automationRate: 'k-rate'
      },
      {
        name: 'modRate',
        defaultValue: 73,
        minValue: 10,
        maxValue: 1000,
        automationRate: 'k-rate'
      }
    ];
  }

  constructor() {
    super();
    this.reverb = new ReverbChain(sampleRate);
    this.controls = { spring: 0, modamp: 0, modRate: 73 };
  }

  process(inputs, outputs, parameters) {
    const output = outputs[0]?.[0];
    if (!output) return true;

    this.controls.spring = parameters.spring?.[0] ?? 0;
    this.controls.modamp = parameters.modamp?.[0] ?? 0;
    this.controls.modRate = parameters.modRate?.[0] ?? 73;
    // Disconnected input still renders zero excitation so existing tails decay.
    this.reverb.render(inputs[0]?.[0] ?? null, output, this.controls);
    return true;
  }
}

registerProcessor('krell-reverb', KrellReverbProcessor);
