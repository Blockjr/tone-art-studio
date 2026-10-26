/**
 * Capture processor for the record path.
 *
 * Runs on the audio thread, so a busy UI thread can never drop input blocks.
 * The samples are copied out of the render quantum untouched: no gain, no
 * limiter, no dither — the take stays 32-bit float at the device rate, which
 * is the most faithful copy of the converter's output the browser can hand
 * over. Only the first two channels are kept, matching the stereo take format.
 *
 * Quanta are gathered into 2048-frame messages before crossing to the main
 * thread, so a long take costs ~23 messages a second instead of ~375.
 */
const FRAMES_PER_MESSAGE = 2048;

class ToneArtCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.active = false;
    this.buffers = [];
    this.filled = 0;
    this.port.onmessage = (event) => {
      if (event.data === 'start') {
        this.active = true;
        this.filled = 0;
      }
      if (event.data === 'stop') {
        this.active = false;
        this.flush();
        this.port.postMessage({ type: 'stopped' });
      }
    };
  }

  flush() {
    if (this.filled === 0) return;
    const channels = this.buffers.map((buffer) => buffer.slice(0, this.filled));
    this.filled = 0;
    this.port.postMessage({ type: 'block', channels });
  }

  process(inputs) {
    if (!this.active) return true;

    const input = inputs[0];
    if (!input || input.length === 0) return true;

    const channels = Math.min(2, input.length);
    while (this.buffers.length < channels) this.buffers.push(new Float32Array(FRAMES_PER_MESSAGE));

    const frames = input[0].length;
    let offset = 0;
    while (offset < frames) {
      const room = FRAMES_PER_MESSAGE - this.filled;
      const take = Math.min(room, frames - offset);
      for (let channel = 0; channel < channels; channel++) {
        this.buffers[channel].set(input[channel].subarray(offset, offset + take), this.filled);
      }
      this.filled += take;
      offset += take;
      if (this.filled === FRAMES_PER_MESSAGE) this.flush();
    }

    return true;
  }
}

registerProcessor('toneart-capture', ToneArtCaptureProcessor);
