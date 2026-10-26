/**
 * Microphone / interface capture for the arrangement.
 *
 * Capture uses the transport's own AudioContext, so the first input block and
 * the beat the transport started on share one clock. That makes the take align
 * with the grid to the sample instead of "about when the user pressed record".
 *
 * The input is captured with a ScriptProcessor because it works in every
 * Chromium build the app supports without shipping a worklet file; it is not on
 * the monitoring path, so its latency never reaches the speakers.
 */

export type InputDevice = { id: string; label: string };

export interface RecorderOptions {
  deviceId?: string;
  monitor?: boolean;
}

export interface RecordingResult {
  channels: Float32Array[];
  sampleRate: number;
  frames: number;
  /** context time of the first captured sample */
  startTime: number;
  /** context time of the stop request */
  endTime: number;
}

export interface TransportAnchor {
  /** context time where the transport's first beat is scheduled */
  ctxTime: number;
  /** arrangement beat at that time */
  beat: number;
}

const BLOCK = 2048;
const SCRIPT_PROCESSOR_MIN = 256;
/** Served from public/: the audio-thread half of the capture path. */
const CAPTURE_WORKLET_URL = '/capture-worklet.js';
/** Frame count the worklet gathers before posting; keep in step with the worklet. */
const WORKLET_BLOCK = 2048;

export type CaptureEngine = 'worklet' | 'compatibility';

/**
 * What the converter is actually handing over.
 *
 * The browser's capture path is always 32-bit float, so there is no bit-depth
 * narrowing to lose here; what matters is that the device rate is kept, that
 * the browser's voice processing stays off, and that capture runs on the audio
 * thread instead of waiting for the UI.
 */
export interface CaptureFormat {
  sampleRate: number;
  /** rate the device reported, when it reports one */
  deviceSampleRate: number | null;
  channels: number;
  bitDepth: 32;
  blockSize: number;
  engine: CaptureEngine;
  /** true when the browser kept echo cancellation or noise suppression on */
  processing: boolean;
  resampled: boolean;
  latencySeconds: number | null;
}

function describeRate(hz: number): string {
  if (!Number.isFinite(hz) || hz <= 0) return 'unknown rate';
  return hz % 1000 === 0 ? `${hz / 1000} kHz` : `${(hz / 1000).toFixed(1)} kHz`;
}

/** One line for the recording panel: what came off the converter and how. */
export function describeCapture(format: CaptureFormat): string {
  const rate =
    format.resampled && format.deviceSampleRate
      ? `${describeRate(format.deviceSampleRate)} in → ${describeRate(format.sampleRate)}`
      : describeRate(format.sampleRate);
  const parts = [
    rate,
    `${format.channels} ch`,
    '32-bit float',
    format.engine === 'worklet' ? 'audio-thread capture' : 'compatibility capture',
    format.processing ? 'browser processing on' : 'no input processing',
  ];
  if (format.latencySeconds !== null && format.latencySeconds > 0) {
    parts.push(`${(format.latencySeconds * 1000).toFixed(1)} ms input latency`);
  }
  return parts.join(' · ');
}

/**
 * Where the input counts as full scale.
 *
 * Integer converters cannot reach 1.0 in float — a 16-bit sample tops out at
 * 32767/32768, about -0.0003 dBFS — so a literal `>= 1` test would never light
 * the clip indicator on real hardware. Anything inside the last hundredth of a
 * dB counts as hitting the ceiling.
 */
export const FULL_SCALE = 0.999;

/**
 * Peak of a block, looked at sample by sample.
 *
 * The old meter stepped through every 16th sample, which could miss a single
 * full-scale transient — exactly the moment a converter clips and the one the
 * clip indicator exists for.
 */
export function scanPeak(channels: Float32Array[]): { peak: number; clipped: boolean } {
  let peak = 0;
  let clipped = false;
  for (const channel of channels) {
    for (let i = 0; i < channel.length; i++) {
      const level = Math.abs(channel[i]);
      if (level > peak) peak = level;
      if (level >= FULL_SCALE) clipped = true;
    }
  }
  return { peak, clipped };
}

export async function listInputDevices(): Promise<InputDevice[]> {
  const media = navigator.mediaDevices;
  if (!media?.enumerateDevices) return [];

  try {
    const devices = await media.enumerateDevices();
    return devices
      .filter((device) => device.kind === 'audioinput')
      .map((device, index) => ({ id: device.deviceId, label: device.label || `Input ${index + 1}` }));
  } catch {
    return [];
  }
}

/**
 * The outputs the machine offers: an audio interface, the built-in speakers, a
 * virtual loopback device. The engine plays its master through whichever one is
 * chosen, so an interface is a real output choice and not a label in a list.
 */
export async function listOutputDevices(): Promise<InputDevice[]> {
  const media = navigator.mediaDevices;
  if (!media?.enumerateDevices) return [];

  try {
    const devices = await media.enumerateDevices();
    return devices
      .filter((device) => device.kind === 'audiooutput')
      .map((device, index) => ({ id: device.deviceId, label: device.label || `Output ${index + 1}` }));
  } catch {
    return [];
  }
}

export interface InputCheck {
  /** loudest sample heard, 0..1 */
  peak: number;
  /** true when the input hit full scale, so the gain has to come down */
  clipped: boolean;
  /** true when the input opened at all */
  opened: boolean;
  /** what to tell the user when it did not */
  error?: string;
}

/**
 * Opens one input for a moment and reports the loudest sample it heard.
 *
 * This is how an interface is checked *before* a take: a level that never leaves
 * zero is the wrong input, a muted channel or a cable that is not in, and it is
 * better to find that out here than after recording three minutes of silence.
 * It is a plain check with no side effects — nothing is recorded, nothing is
 * written to the project — and it never throws, so the caller can put the answer
 * straight on screen.
 */
export async function measureInputLevel(deviceId: string, milliseconds = 1500): Promise<InputCheck> {
  const media = navigator.mediaDevices;
  if (!media?.getUserMedia) {
    return { peak: 0, clipped: false, opened: false, error: 'This browser cannot open an audio input.' };
  }

  const audio = {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
    sampleRate: { ideal: 48000 },
  } as MediaTrackConstraints;
  if (deviceId) audio.deviceId = { exact: deviceId };

  let stream: MediaStream | null = null;
  let ctx: AudioContext | null = null;
  try {
    stream = await media.getUserMedia({ audio });
    // A context of its own: the check must not disturb the transport's clock or
    // add a node to the live graph.
    ctx = new AudioContext();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    ctx.createMediaStreamSource(stream).connect(analyser);

    const buffer = new Float32Array(analyser.fftSize);
    let peak = 0;
    const until = Date.now() + Math.max(200, milliseconds);

    while (Date.now() < until) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      analyser.getFloatTimeDomainData(buffer);
      for (let i = 0; i < buffer.length; i++) {
        const level = Math.abs(buffer[i]);
        if (level > peak) peak = level;
      }
    }

    return { peak, clipped: peak >= FULL_SCALE, opened: true };
  } catch (error) {
    return {
      peak: 0,
      clipped: false,
      opened: false,
      error: error instanceof Error ? error.message : 'The input could not be opened.',
    };
  } finally {
    for (const track of stream?.getTracks() ?? []) track.stop();
    if (ctx) void ctx.close().catch(() => {});
  }
}

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));

/** Joins the recorded blocks into one array per channel. */
export function mergeChunks(chunks: Float32Array[][]): Float32Array[] {
  const channels = chunks[0]?.length ?? 0;
  if (channels === 0) return [];

  const frames = chunks.reduce((total, block) => total + (block[0]?.length ?? 0), 0);
  const merged = Array.from({ length: channels }, () => new Float32Array(frames));

  let offset = 0;
  for (const block of chunks) {
    const length = block[0]?.length ?? 0;
    for (let channel = 0; channel < channels; channel++) {
      if (block[channel]) merged[channel].set(block[channel], offset);
    }
    offset += length;
  }

  return merged;
}

/**
 * Cuts the pre-roll and any tail off a capture so the take starts exactly on the
 * transport's first beat. Returns null when there is nothing usable.
 */
export function takeFromRecording(
  result: RecordingResult,
  anchor: TransportAnchor,
  bpm: number,
  /** punch range in arrangement beats; capture outside it is discarded */
  punch?: { start: number; end: number },
): { channels: Float32Array[]; startBeat: number; lengthBeats: number } | null {
  if (result.frames <= 0 || result.sampleRate <= 0) return null;

  const merged = result.channels;
  const lead = Math.max(0, Math.round((anchor.ctxTime - result.startTime) * result.sampleRate));
  const lateSeconds = Math.max(0, result.startTime - anchor.ctxTime);
  const available = result.frames - lead;
  const wanted = Math.round(
    Math.max(0, result.endTime - Math.max(anchor.ctxTime, result.startTime)) * result.sampleRate,
  );
  const frames = Math.min(available, wanted);

  if (frames < 16) return null;

  const beatsPerSecond = bpm / 60;
  const fromBeat = Math.max(0, anchor.beat + lateSeconds * beatsPerSecond);

  if (!punch) {
    return {
      channels: merged.map((channel) => channel.slice(lead, lead + frames)),
      startBeat: fromBeat,
      lengthBeats: (frames / result.sampleRate) * beatsPerSecond,
    };
  }

  // The punch points are arrangement beats; convert them to frame offsets from
  // the first captured frame so the take begins exactly on the punch-in point
  // and stops dead on punch-out, however long the transport had been rolling.
  const framesPerBeat = result.sampleRate / beatsPerSecond;
  const skip = Math.round(Math.max(0, punch.start - fromBeat) * framesPerBeat);
  const keep = Math.round(Math.max(0, punch.end - Math.max(punch.start, fromBeat)) * framesPerBeat);
  const startFrame = lead + Math.min(skip, frames);
  const endFrame = Math.min(lead + frames, startFrame + keep);
  const punched = endFrame - startFrame;

  if (punched < 16) return null;

  return {
    channels: merged.map((channel) => channel.slice(startFrame, endFrame)),
    startBeat: Math.max(punch.start, fromBeat),
    lengthBeats: (punched / result.sampleRate) * beatsPerSecond,
  };
}

export interface LoopTakeSlice {
  channels: Float32Array[];
  /** arrangement beat the slice starts on (the loop start) */
  startBeat: number;
  lengthBeats: number;
  /** true when the slice fills a whole loop lap */
  complete: boolean;
}

/** A final lap shorter than this is dropped; it is not worth a take. */
const MIN_PARTIAL_BEATS = 0.25;

function sliceChannels(source: Float32Array[], from: number, frames: number): Float32Array[] {
  return source.map((channel) => {
    const out = new Float32Array(frames);
    const skip = Math.max(0, -from);
    const start = Math.max(0, from);
    if (skip < frames) {
      const available = Math.max(0, channel.length - start);
      out.set(channel.subarray(start, start + Math.min(available, frames - skip)), skip);
    }
    return out;
  });
}

/**
 * Cuts a loop pass into one slice per lap, each aligned to the loop start.
 *
 * A capture that began after the transport anchor is padded with silence so
 * every lap starts on the same beat, and a final short lap is kept as an
 * incomplete take. Slices are ordered oldest first.
 */
export function loopSlicesFromCapture(
  result: RecordingResult,
  anchor: TransportAnchor,
  loop: { start: number; end: number },
  bpm: number,
): LoopTakeSlice[] {
  const loopBeats = loop.end - loop.start;
  if (result.frames <= 0 || result.sampleRate <= 0 || loopBeats <= 0) return [];

  const trimmed = takeFromRecording(result, anchor, bpm);
  if (!trimmed) return [];

  const sampleRate = result.sampleRate;
  const secondsPerBeat = 60 / Math.max(1, bpm);
  const lapFrames = Math.max(1, Math.round(loopBeats * secondsPerBeat * sampleRate));
  const lateFrames = Math.max(0, Math.round((result.startTime - anchor.ctxTime) * sampleRate));
  const totalFrames = lateFrames + trimmed.channels[0].length;
  const fullLaps = Math.floor(totalFrames / lapFrames);
  const remainder = totalFrames - fullLaps * lapFrames;
  const minPartial = MIN_PARTIAL_BEATS * secondsPerBeat * sampleRate;

  const slices: LoopTakeSlice[] = [];

  for (let lap = 0; lap < fullLaps; lap++) {
    slices.push({
      channels: sliceChannels(trimmed.channels, lap * lapFrames - lateFrames, lapFrames),
      startBeat: loop.start,
      lengthBeats: loopBeats,
      complete: true,
    });
  }

  if (remainder >= minPartial) {
    slices.push({
      channels: sliceChannels(trimmed.channels, fullLaps * lapFrames - lateFrames, remainder),
      startBeat: loop.start,
      lengthBeats: remainder / sampleRate / secondsPerBeat,
      complete: false,
    });
  }

  return slices;
}

export class InputRecorder {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private processor: ScriptProcessorNode | null = null;
  private sink: GainNode | null = null;
  private monitorGain: GainNode | null = null;
  private worklet: AudioWorkletNode | null = null;
  private chunks: Float32Array[][] = [];
  private channelCount = 1;
  private sampleRate = 48000;
  private firstTime = 0;
  private capturing = false;
  private peakValue = 0;
  private clipped = false;
  private formatInfo: CaptureFormat | null = null;

  get isCapturing(): boolean {
    return this.capturing;
  }

  /** Input level of the last block, 0..1, for the record meter. */
  get peak(): number {
    return this.peakValue;
  }

  /** True once the input has hit full scale since this pass started. */
  get isClipped(): boolean {
    return this.clipped;
  }

  /** Details of the open capture, or null when no input is open. */
  get format(): CaptureFormat | null {
    return this.formatInfo;
  }

  get elapsedSeconds(): number {
    if (!this.capturing || !this.ctx) return 0;
    return Math.max(0, this.ctx.currentTime - this.firstTime);
  }

  async start(ctx: AudioContext, options: RecorderOptions = {}): Promise<void> {
    if (this.capturing) return;

    const media = navigator.mediaDevices;
    if (!media?.getUserMedia) throw new Error('This browser cannot open a microphone.');

    // Ask for the interface's own samples: every one of these would otherwise
    // reshape the signal before it reaches the take. `sampleRate` keeps the
    // device at the context rate so the browser does not resample on the way in.
    const audio = {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      voiceIsolation: false,
      sampleRate: { ideal: Math.round(ctx.sampleRate) },
    } as MediaTrackConstraints;
    if (options.deviceId) audio.deviceId = { exact: options.deviceId };

    this.ctx = ctx;
    this.sampleRate = ctx.sampleRate;
    this.chunks = [];
    this.peakValue = 0;
    this.clipped = false;
    this.formatInfo = null;

    let stream: MediaStream;
    try {
      stream = await media.getUserMedia({ audio });
    } catch (error) {
      this.ctx = null;
      throw error;
    }
    this.stream = stream;

    const track = stream.getAudioTracks()[0];
    const settings = (track?.getSettings?.() ?? {}) as MediaTrackSettings & {
      voiceIsolation?: boolean;
      latency?: number;
    };
    this.channelCount = clamp(Math.round(Number(settings.channelCount) || 1), 1, 2);
    const deviceSampleRate = Number(settings.sampleRate) > 0 ? Number(settings.sampleRate) : null;
    const processing = Boolean(
      settings.echoCancellation || settings.noiseSuppression || settings.autoGainControl || settings.voiceIsolation,
    );

    // Capture on the audio thread when the browser has a worklet; fall back to
    // the compatibility path rather than failing to record on older builds.
    let engine: CaptureEngine = 'compatibility';
    if (ctx.audioWorklet && typeof AudioWorkletNode !== 'undefined') {
      try {
        await ctx.audioWorklet.addModule(CAPTURE_WORKLET_URL);
        engine = 'worklet';
      } catch {
        engine = 'compatibility';
      }
    }

    const source = ctx.createMediaStreamSource(stream);
    // A capture node only runs while it is connected to the destination. The
    // sink is silent so this stays a capture path, not a second monitor.
    const sink = ctx.createGain();
    sink.gain.value = 0;
    sink.connect(ctx.destination);

    this.source = source;
    this.sink = sink;
    this.capturing = true;

    try {
      if (engine === 'worklet') {
        const node = new AudioWorkletNode(ctx, 'toneart-capture', {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          outputChannelCount: [this.channelCount],
        });
        node.port.onmessage = (event: MessageEvent) => {
          const message = event.data as { type?: string; channels?: Float32Array[] };
          if (message?.type !== 'block' || !message.channels) return;
          this.pushBlock(message.channels);
        };
        source.connect(node);
        node.connect(sink);
        this.worklet = node;
        node.port.postMessage('start');
      } else {
        const processor = ctx.createScriptProcessor(
          Math.max(SCRIPT_PROCESSOR_MIN, BLOCK),
          this.channelCount,
          this.channelCount,
        );
        processor.onaudioprocess = (event) => {
          const buffer = event.inputBuffer;
          const block: Float32Array[] = [];
          for (let channel = 0; channel < Math.min(2, buffer.numberOfChannels); channel++) {
            block.push(new Float32Array(buffer.getChannelData(channel)));
          }
          this.pushBlock(block);
        };
        source.connect(processor);
        processor.connect(sink);
        this.processor = processor;
      }
    } catch (error) {
      this.capturing = false;
      this.release();
      throw error;
    }

    this.formatInfo = {
      sampleRate: ctx.sampleRate,
      deviceSampleRate,
      channels: this.channelCount,
      bitDepth: 32,
      blockSize: engine === 'worklet' ? WORKLET_BLOCK : Math.max(SCRIPT_PROCESSOR_MIN, BLOCK),
      engine,
      processing,
      resampled: deviceSampleRate !== null && deviceSampleRate !== ctx.sampleRate,
      latencySeconds: Number(settings.latency) > 0 ? Number(settings.latency) : null,
    };

    if (options.monitor) this.setMonitoring(true);
  }

  /** Copies one untouched render quantum into the take and updates the meter. */
  private pushBlock(block: Float32Array[]): void {
    if (!this.capturing || !this.ctx || block.length === 0) return;

    const channels = block.slice(0, 2);
    const length = channels[0]?.length ?? 0;
    if (length === 0) return;

    if (this.chunks.length === 0) {
      this.channelCount = channels.length;
      if (this.formatInfo) this.formatInfo.channels = channels.length;
      this.firstTime = Math.max(0, this.ctx.currentTime - length / this.sampleRate);
    }

    this.chunks.push(channels);
    const stats = scanPeak(channels);
    if (stats.peak > this.peakValue) this.peakValue = stats.peak;
    if (stats.clipped) this.clipped = true;
  }

  setMonitoring(enabled: boolean): void {
    if (!this.ctx || !this.source) return;

    if (enabled && !this.monitorGain) {
      this.monitorGain = this.ctx.createGain();
      this.monitorGain.gain.value = 1;
      this.source.connect(this.monitorGain);
      this.monitorGain.connect(this.ctx.destination);
    } else if (!enabled && this.monitorGain) {
      this.monitorGain.disconnect();
      this.monitorGain = null;
    }
  }

  stop(): RecordingResult | null {
    const ctx = this.ctx;
    if (!ctx || !this.capturing) {
      this.release();
      return null;
    }

    const endTime = ctx.currentTime;
    this.capturing = false;

    const channels = mergeChunks(this.chunks);
    const frames = channels[0]?.length ?? 0;
    const result: RecordingResult | null =
      frames > 0
        ? {
            channels,
            sampleRate: this.sampleRate,
            frames,
            startTime: this.firstTime,
            endTime,
          }
        : null;

    this.release();
    this.chunks = [];
    return result;
  }

  cancel(): void {
    this.capturing = false;
    this.chunks = [];
    this.release();
  }

  private release(): void {
    this.setMonitoring(false);

    if (this.worklet) {
      this.worklet.port.onmessage = null;
      try {
        this.worklet.port.postMessage('stop');
      } catch {
        // The context may already be closed; nothing to tell the thread.
      }
      this.worklet.disconnect();
    }

    if (this.processor) {
      this.processor.onaudioprocess = null;
      this.processor.disconnect();
    }
    this.source?.disconnect();
    this.sink?.disconnect();
    this.stream?.getTracks().forEach((track) => track.stop());

    this.worklet = null;
    this.processor = null;
    this.source = null;
    this.sink = null;
    this.stream = null;
    this.ctx = null;
    this.peakValue = 0;
  }
}
