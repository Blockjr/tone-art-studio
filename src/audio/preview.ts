import type { Engine } from './engine';
import { computePeaks, detectTempo, stretchChannelsAsync } from './dsp';
import { peakBuckets } from './waveform';

export interface PreviewClip {
  id: string;
  name: string;
  buffer: AudioBuffer;
  peaks: number[];
  /** detected tempo in BPM, 0 when the analysis found nothing */
  bpm: number;
  confidence: number;
}

export interface PreviewSnapshot {
  playing: boolean;
  processing: boolean;
  progress: number;
  position: number;
  duration: number;
  tempoRate: number;
  pitch: number;
  prepared: boolean;
}

/**
 * Audition player for a single file, independent of the arrangement: its own
 * transport, its own metronome, pitch-preserving tempo change and a pitch
 * control. Processing happens once per setting change and is cached, and the
 * audio is only scheduled while it is playing, so an idle panel costs nothing.
 */
export class PreviewPlayer {
  private engine: Engine;
  private clip: PreviewClip | null = null;
  private processed: AudioBuffer | null = null;
  private processedKey = '';
  private peaks: number[] = [];

  private source: AudioBufferSourceNode | null = null;
  private gain: GainNode | null = null;
  private startedAt = 0;
  private offsetSeconds = 0;
  private playing = false;
  private looping = true;
  private loopRange: { start: number; end: number } | null = null;
  private volume = 0.9;

  private metronomeOn = false;
  private metronomeBpm = 120;
  private metronomeTimer: number | null = null;
  private nextClickTime = 0;
  private clickIndex = 0;

  private tempoRate = 1;
  private pitch = 0;
  private generation = 0;
  private processing = false;
  private progress = 0;
  private listeners = new Set<(snapshot: PreviewSnapshot) => void>();

  constructor(engine: Engine) {
    this.engine = engine;
  }

  get current(): PreviewClip | null {
    return this.clip;
  }

  /** The decoded file, before tempo and pitch processing. */
  get rawBuffer(): AudioBuffer | null {
    return this.clip?.buffer ?? null;
  }

  get rawDuration(): number {
    return this.clip?.buffer.duration ?? 0;
  }

  get processedBuffer(): AudioBuffer | null {
    return this.processed;
  }

  get waveform(): number[] {
    return this.peaks;
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  get tempoRateValue(): number {
    return this.tempoRate;
  }

  get pitchValue(): number {
    return this.pitch;
  }

  get metronomeEnabled(): boolean {
    return this.metronomeOn;
  }

  get state(): PreviewSnapshot {
    return {
      playing: this.playing,
      processing: this.processing,
      progress: this.progress,
      position: this.position(),
      duration: this.duration(),
      tempoRate: this.tempoRate,
      pitch: this.pitch,
      prepared: this.processed !== null,
    };
  }

  onState(listener: (snapshot: PreviewSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  // ------------------------------------------------------------------ loading

  /** Loads a file into the preview, detecting its tempo. */
  async loadFile(file: File): Promise<PreviewClip> {
    const ctx = await this.engine.ensureContext();
    const bytes = await file.arrayBuffer();
    const buffer = await ctx.decodeAudioData(bytes);
    return this.loadBuffer(buffer, file.name);
  }

  loadBuffer(buffer: AudioBuffer, name: string, id = `preview-${Date.now()}`): PreviewClip {
    const channels: Float32Array[] = [];
    for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
      channels.push(Float32Array.from(buffer.getChannelData(channel)));
    }

    const estimate = detectTempo(channels, buffer.sampleRate);
    const clip: PreviewClip = {
      id,
      name,
      buffer,
      peaks: computePeaks(channels, peakBuckets(buffer.duration)),
      bpm: estimate.bpm,
      confidence: estimate.confidence,
    };

    this.stop();
    this.clip = clip;
    this.processed = null;
    this.processedKey = '';
    this.peaks = clip.peaks;
    this.offsetSeconds = 0;
    this.generation++;
    this.notify();
    return clip;
  }

  // ------------------------------------------------------------------ settings

  async setTempoRate(rate: number): Promise<void> {
    const next = Math.max(0.5, Math.min(2, rate));
    if (Math.abs(next - this.tempoRate) < 1e-4) return;
    const wasPlaying = this.playing;
    this.tempoRate = next;
    await this.prepare();
    if (wasPlaying) void this.play(true);
  }

  async setPitch(semitones: number): Promise<void> {
    const next = Math.max(-12, Math.min(12, Math.round(semitones)));
    if (next === this.pitch) return;
    const wasPlaying = this.playing;
    this.pitch = next;
    await this.prepare();
    if (wasPlaying) void this.play(true);
  }

  setLoop(loop: boolean): void {
    this.looping = loop;
    if (this.source) this.source.loop = loop;
    this.applyLoopRange();
    this.notify();
  }

  /**
   * Restricts loop playback to a region, in processed seconds. Passing null
   * loops the whole file again. The range only takes effect while looping.
   */
  setLoopRange(range: { start: number; end: number } | null): void {
    const duration = this.duration();
    if (!range || range.end - range.start <= 0.01 || duration <= 0) {
      this.loopRange = null;
    } else {
      this.loopRange = {
        start: Math.max(0, Math.min(duration, range.start)),
        end: Math.max(0, Math.min(duration, range.end)),
      };
      if (this.loopRange.end - this.loopRange.start <= 0.01) this.loopRange = null;
    }

    this.applyLoopRange();
    this.notify();
  }

  setVolume(value: number): void {
    this.volume = Math.max(0, Math.min(1, value));
    if (this.gain && this.engine.context) {
      this.gain.gain.setTargetAtTime(this.volume, this.engine.context.currentTime, 0.01);
    }
  }

  setMetronome(on: boolean): void {
    this.metronomeOn = on;
    if (on && this.playing) this.startMetronome();
    else this.stopMetronome();
    this.notify();
  }

  setMetronomeBpm(bpm: number): void {
    this.metronomeBpm = Math.max(30, Math.min(300, bpm));
    this.notify();
  }

  // ------------------------------------------------------------------ transport

  /** Applies the current tempo/pitch settings to the audio, chunked. */
  async prepare(): Promise<boolean> {
    if (!this.clip) return false;
    const ctx = await this.engine.ensureContext();
    const key = `${this.clip.id}:${this.tempoRate.toFixed(3)}:${this.pitch}:${ctx.sampleRate}`;

    if (this.processed && key === this.processedKey) return true;

    const generation = ++this.generation;
    this.processing = true;
    this.progress = 0;
    this.notify();

    const channels: Float32Array[] = [];
    for (let channel = 0; channel < this.clip.buffer.numberOfChannels; channel++) {
      channels.push(Float32Array.from(this.clip.buffer.getChannelData(channel)));
    }

    try {
      const stretched = await stretchChannelsAsync(channels, {
        tempoRate: this.tempoRate,
        pitchRatio: 2 ** (this.pitch / 12),
        onProgress: (progress) => {
          if (generation !== this.generation) return;
          this.progress = progress;
          this.notify();
        },
        shouldCancel: () => generation !== this.generation,
      });

      if (!stretched || generation !== this.generation) return false;

      const frames = Math.max(1, stretched[0].length);
      const buffer = ctx.createBuffer(stretched.length, frames, ctx.sampleRate);

      for (let channel = 0; channel < stretched.length; channel++) {
        buffer.copyToChannel(stretched[channel] as Float32Array<ArrayBuffer>, channel);
      }

      this.processed = buffer;
      this.processedKey = key;
      this.peaks = computePeaks(stretched, peakBuckets(frames / Math.max(1, ctx.sampleRate)));
      this.progress = 1;
      return true;
    } finally {
      if (generation === this.generation) {
        this.processing = false;
        this.notify();
      }
    }
  }

  async play(resume = false): Promise<void> {
    if (!this.clip) return;
    const ctx = await this.engine.ensureContext();
    const ready = await this.prepare();
    if (!ready || !this.processed) return;

    const position = resume ? this.position() : this.offsetSeconds;
    this.stopSource();

    const source = ctx.createBufferSource();
    source.buffer = this.processed;
    source.loop = this.looping;
    source.loopStart = this.loopRange?.start ?? 0;
    source.loopEnd = this.loopRange?.end ?? this.processed.duration;

    const gain = ctx.createGain();
    gain.gain.value = this.volume;

    source.connect(gain).connect(ctx.destination);

    // Starting outside the loop range would play the lead-in once and then
    // jump; start inside it instead, as every DAW preview does.
    let from = Math.min(position, this.processed.duration);
    if (this.loopRange && (from < this.loopRange.start || from >= this.loopRange.end)) {
      from = this.loopRange.start;
    }

    this.offsetSeconds = from;
    this.startedAt = ctx.currentTime + 0.02 - this.offsetSeconds;
    source.start(ctx.currentTime + 0.02, this.offsetSeconds);

    source.onended = () => {
      if (this.source !== source) return;
      this.playing = false;
      this.source = null;
      this.gain = null;
      this.stopMetronome();
      this.offsetSeconds = 0;
      this.notify();
    };

    this.source = source;
    this.gain = gain;
    this.playing = true;

    if (this.metronomeOn) this.startMetronome();
    this.notify();
  }

  pause(): void {
    if (!this.playing) return;
    this.offsetSeconds = this.position();
    this.playing = false;
    this.stopSource();
    this.stopMetronome();
    this.notify();
  }

  stop(): void {
    this.playing = false;
    this.offsetSeconds = 0;
    this.stopSource();
    this.stopMetronome();
    this.notify();
  }

  seek(seconds: number): void {
    this.offsetSeconds = Math.max(0, Math.min(this.duration(), seconds));

    if (this.playing) {
      this.stopSource();
      this.playing = false;
      void this.play(false);
      return;
    }

    this.notify();
  }

  dispose(): void {
    this.stop();
    this.listeners.clear();
  }

  // ------------------------------------------------------------------ internals

  private duration(): number {
    const buffer = this.processed ?? this.clip?.buffer;
    return buffer?.duration ?? 0;
  }

  private position(): number {
    if (!this.playing || !this.engine.context) return this.offsetSeconds;

    const elapsed = this.engine.context.currentTime - this.startedAt;
    const duration = this.duration();

    if (!Number.isFinite(elapsed)) return this.offsetSeconds;

    if (duration <= 0) return 0;
    if (!this.looping) return Math.max(0, Math.min(duration, elapsed));

    const span = this.loopRange ? this.loopRange.end - this.loopRange.start : duration;
    if (span <= 0) return Math.max(0, elapsed % duration);
    return (this.loopRange?.start ?? 0) + Math.max(0, elapsed % span);
  }

  /** Keeps a live loop range in sync when the user drags a new region. */
  private applyLoopRange(): void {
    if (!this.source || !this.looping) return;
    this.source.loopStart = this.loopRange?.start ?? 0;
    this.source.loopEnd = this.loopRange?.end ?? this.source.buffer?.duration ?? 0;
  }

  private stopSource(): void {
    if (!this.source) return;
    const source = this.source;
    this.source = null;
    source.onended = null;
    try {
      source.stop();
    } catch {
      // already stopped
    }
    source.disconnect();
    this.gain?.disconnect();
    this.gain = null;
  }

  private startMetronome(): void {
    this.stopMetronome();
    if (!this.engine.context) return;

    this.nextClickTime = this.engine.context.currentTime + 0.06;
    this.clickIndex = 0;

    this.metronomeTimer = window.setInterval(() => this.scheduleClicks(), 25);
    this.scheduleClicks();
  }

  private stopMetronome(): void {
    if (this.metronomeTimer !== null) {
      window.clearInterval(this.metronomeTimer);
      this.metronomeTimer = null;
    }
  }

  private scheduleClicks(): void {
    const ctx = this.engine.context;
    if (!ctx || !this.metronomeOn || !this.playing) return;

    const interval = 60 / this.metronomeBpm;

    while (this.nextClickTime < ctx.currentTime + 0.1) {
      const accent = this.clickIndex % 4 === 0;

      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'square';
      osc.frequency.value = accent ? 1600 : 1100;
      gain.gain.setValueAtTime(0.0001, this.nextClickTime);
      gain.gain.linearRampToValueAtTime(accent ? 0.09 : 0.05, this.nextClickTime + 0.002);
      gain.gain.exponentialRampToValueAtTime(0.0001, this.nextClickTime + 0.04);
      osc.connect(gain).connect(ctx.destination);
      osc.start(this.nextClickTime);
      osc.stop(this.nextClickTime + 0.05);

      this.clickIndex++;
      this.nextClickTime += interval;
    }
  }

  private notify(): void {
    const snapshot = this.state;
    for (const listener of this.listeners) listener(snapshot);
  }
}
