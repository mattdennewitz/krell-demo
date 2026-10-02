/**
 * Krell Random LFO AudioWorkletProcessor
 *
 * Implements a dedicated mono AudioWorklet processor 'krell-random-lfo'
 * providing a sample-clocked, smooth bipolar random LFO.
 *
 * Operational Timing & Control:
 * - k-rate AudioParam 'period' (default 3.0s, range 0.1 .. 30.0s).
 * - Bi-directional port communication:
 *     Inbound control:
 *       { type: 'reseed', seed: uint32 }
 *       { type: 'telemetry', enabled: boolean }
 *     Outbound telemetry:
 *       { type: 'lfo', value: -1..1, segment: integer, period: seconds }
 * - Telemetry is throttled to ~12 Hz and can be paused when page is hidden or stopped.
 * - Native routes in audio graph ensure processor is clocked continuously.
 */

import { RandomLFO } from './random-lfo.js';

class RandomLFOWorkletProcessor extends AudioWorkletProcessor {
  /**
   * AudioParam descriptors:
   * period: default 3.0 (0.1 .. 30.0 seconds)
   */
  static get parameterDescriptors() {
    return [
      {
        name: 'period',
        defaultValue: 3.0,
        minValue: 0.1,
        maxValue: 30.0,
        automationRate: 'k-rate'
      }
    ];
  }

  constructor(options) {
    super();

    const seed = options?.processorOptions?.seed ?? 1337;
    this.lfo = new RandomLFO(sampleRate, seed);

    // Telemetry throttling: 12 Hz rate
    this.telemetryEnabled = true;
    this.telemetryIntervalSamples = Math.max(1, Math.round(sampleRate / 12));
    this.samplesSinceTelemetry = 0;

    // Inbound port messages
    this.port.onmessage = (event) => {
      const data = event.data;
      if (!data) return;

      if (data.type === 'reseed') {
        this.lfo.reseed(data.seed >>> 0);
      } else if (data.type === 'telemetry') {
        this.telemetryEnabled = Boolean(data.enabled);
      }
    };
  }

  process(inputs, outputs, parameters) {
    const output = outputs[0];
    if (!output || !output[0]) return true;

    const channel = output[0];
    const period = parameters.period?.[0] ?? 3.0;

    // Render audio block
    this.lfo.render(channel, period);

    // Emit telemetry at ~12 Hz
    if (this.telemetryEnabled) {
      this.samplesSinceTelemetry += channel.length;
      if (this.samplesSinceTelemetry >= this.telemetryIntervalSamples) {
        this.samplesSinceTelemetry %= this.telemetryIntervalSamples;
        this.port.postMessage({
          type: 'lfo',
          value: this.lfo.value,
          segment: this.lfo.segment,
          period: period
        });
      }
    }

    return true;
  }
}

registerProcessor('krell-random-lfo', RandomLFOWorkletProcessor);
