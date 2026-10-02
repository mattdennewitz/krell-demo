/**
 * Krell Synthesizer AudioWorkletProcessor
 *
 * Implements the Web Audio AudioWorklet interface for the Krell voice.
 * Connects directly to engine.js, manages AudioParams, handles reseed and
 * visibility-aware telemetry messaging at 12 Hz.
 */

import { KrellVoice } from './engine.js';

class KrellWorkletProcessor extends AudioWorkletProcessor {
  /**
   * AudioParam descriptors:
   * pace: 1.0 (0.25 .. 16.0)
   * root: 110.0 (55 .. 440 Hz)
   * spread: 2.0 (0 .. 4 octaves)
   * memory: 1.0 (0.4 .. 2.5)
   * waveform: 0.0 (0 = sine, 1 = triangle)
   */
  static get parameterDescriptors() {
    return [
      {
        name: 'pace',
        defaultValue: 1.0,
        minValue: 0.25,
        maxValue: 16.0,
        automationRate: 'k-rate'
      },
      {
        name: 'root',
        defaultValue: 110.0,
        minValue: 55.0,
        maxValue: 440.0,
        automationRate: 'k-rate'
      },
      {
        name: 'spread',
        defaultValue: 2.0,
        minValue: 0.0,
        maxValue: 4.0,
        automationRate: 'k-rate'
      },
      {
        name: 'memory',
        defaultValue: 1.0,
        minValue: 0.4,
        maxValue: 2.5,
        automationRate: 'k-rate'
      },
      {
        name: 'waveform',
        defaultValue: 0.0,
        minValue: 0.0,
        maxValue: 1.0,
        automationRate: 'k-rate'
      }
    ];
  }

  constructor(options) {
    super();

    // Voice instance running at context sampleRate
    this.voice = new KrellVoice(sampleRate, options.processorOptions?.seed ?? 1337);

    // Reusable control dictionary to avoid allocations in process()
    this.controls = {
      pace: 1.0,
      root: 110.0,
      spread: 2.0,
      memory: 1.0,
      waveform: 0.0
    };

    // Telemetry throttling: 12 Hz rate
    this.telemetryEnabled = true;
    this.telemetryIntervalSamples = Math.max(1, Math.round(sampleRate / 12));
    this.samplesSinceTelemetry = 0;

    // Incoming messages from UI / host
    this.port.onmessage = (event) => {
      const data = event.data;
      if (!data) return;

      if (data.type === 'reseed') {
        this.voice.reseed(data.seed >>> 0);
      } else if (data.type === 'telemetry') {
        this.telemetryEnabled = Boolean(data.enabled);
      }
    };
  }

  /**
   * Audio rendering loop (supports arbitrary block sizes)
   */
  process(inputs, outputs, parameters) {
    const output = outputs[0];
    if (!output || !output[0]) return true;

    const channel = output[0];

    // Extract k-rate AudioParams
    this.controls.pace = parameters.pace?.[0] ?? 1.0;
    this.controls.root = parameters.root?.[0] ?? 110.0;
    this.controls.spread = parameters.spread?.[0] ?? 2.0;
    this.controls.memory = parameters.memory?.[0] ?? 1.0;
    this.controls.waveform = parameters.waveform?.[0] ?? 0.0;

    // Render audio block
    this.voice.render(channel, this.controls);

    // Telemetry messaging at ~12 Hz
    if (this.telemetryEnabled) {
      this.samplesSinceTelemetry += channel.length;
      if (this.samplesSinceTelemetry >= this.telemetryIntervalSamples) {
        this.samplesSinceTelemetry %= this.telemetryIntervalSamples;
        const st = this.voice.state;
        this.port.postMessage({
          type: 'telemetry',
          envelope: st.envelope,
          frequency: st.frequency,
          cycle: st.cycle,
          stage: st.stage,
          rise: st.rise,
          fall: st.fall,
          resistance: st.resistance
        });
      }
    }

    return true;
  }
}

registerProcessor('krell-voice', KrellWorkletProcessor);
