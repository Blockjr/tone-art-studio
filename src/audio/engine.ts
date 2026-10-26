import type { Store } from '../core/store';
import { clamp, dbToGain } from '../core/time';
import { applyMidiFx, type MidiNote } from '../core/midifx';
import { devicePeak } from './devices';
import { buildGraph, type Graph } from './graph';
import { applyFadeEnvelope, fadeEnvelope, resolveFades } from './fades';
import { prepareProjectAudio, resolveClipAudio } from './clipsource';
import {
  countInBeats,
  countInClickLevel,
  normalizeMetronomeSettings,
  type ClickLevel,
  type ClickSound,
  type MetronomeSettings,
} from './metronome';

const LOOKAHEAD_SECONDS = 0.12;
const TICK_MS = 25;
const START_DELAY = 0.06;

export class Engine {
  private store: Store;
  private ctx: AudioContext | null = null;
  private graph: Graph | null = null;
  private timer: number | null = null;
  private playing = false;
  private startCtxTime = 0;
  private startBeat = 0;
  private cursorElapsed = 0;
  private stopPosition = 0;
  private lastStart = 0;
  private metro: MetronomeSettings;
  private onMetronomeChange?: (settings: MetronomeSettings) => void;
  private signature = '';
  private lastBpm: number;
  private unsubscribe: () => void;
  private silenceTimer = 0;
  /** a count-in is scheduled, with the transport still parked at its target */
  private countInTimer: number | null = null;
  private countInStartAt = 0;
  private countInEndsAt = 0;
  private countInTotalBeats = 0;
  private countInTarget = 0;
  private countInNodes: OscillatorNode[] = [];
  /** monitor-only console tools: dim −18 dB and L/R mono sum */
  private monitorDimOn = false;
  private monitorMonoOn = false;
  /** one-shot playback stops here (a selection range); null = play to the end */
  private stopAt: number | null = null;
  /** a warp/reverse render is running before the transport can start */
  private preparing: Promise<void> | null = null;
  /** tape-scrub grains are throttled to one per grain interval */
  private lastScrubAt = 0;

  constructor(
    store: Store,
    metronome?: Partial<MetronomeSettings>,
    onMetronomeChange?: (settings: MetronomeSettings) => void,
  ) {
    this.store = store;
    this.metro = normalizeMetronomeSettings(metronome);
    this.onMetronomeChange = onMetronomeChange;
    this.lastBpm = store.project.bpm;
    this.unsubscribe = store.subscribe((reason) => {
      if (reason === 'structure') this.syncStructure();
      else if (reason === 'params') this.syncParams();
    });
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  /** True while warped or reversed audio is being prepared for playback. */
  get isPreparing(): boolean {
    return this.preparing !== null;
  }

  get context(): AudioContext | null {
    return this.ctx;
  }

  get metronome(): boolean {
    return this.metro.enabled;
  }

  /** Full click/count-in settings, rendered by the transport settings panel. */
  get metronomeSettings(): MetronomeSettings {
    return { ...this.metro };
  }

  get countIn(): boolean {
    return this.metro.countIn;
  }

  get isCountingIn(): boolean {
    return this.countInEndsAt > 0;
  }

  /**
   * What the transport badge shows while counting down. `remaining` is the
   * number of the count (4, 3, 2, 1), not the elapsed beat.
   */
  get countInState(): {
    active: boolean;
    bars: number;
    totalBeats: number;
    remaining: number;
    position: number;
  } {
    if (!this.isCountingIn || !this.ctx) {
      return { active: false, bars: 0, totalBeats: 0, remaining: 0, position: this.stopPosition };
    }
    const beatsPerSecond = this.store.project.bpm / 60;
    const elapsed = Math.max(0, (this.ctx.currentTime - this.countInStartAt) * beatsPerSecond);
    return {
      active: true,
      bars: this.metro.countInBars,
      totalBeats: this.countInTotalBeats,
      remaining: Math.max(1, Math.ceil(this.countInTotalBeats - elapsed - 1e-6)),
      position: this.countInTarget,
    };
  }

  async ensureContext(): Promise<AudioContext> {
    if (!this.ctx) {
      this.ctx = new AudioContext({ latencyHint: 'interactive' });
      this.graph = buildGraph(this.ctx, this.store.project, { meters: true });
      this.signature = this.computeSignature();
      this.applyMix();
    }
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    return this.ctx;
  }

  get positionBeat(): number {
    if (this.isCountingIn) return this.countInTarget;
    if (!this.playing || !this.ctx) return this.stopPosition;
    const beatsPerSecond = this.store.project.bpm / 60;
    const elapsed = Math.max(0, (this.ctx.currentTime - this.startCtxTime) * beatsPerSecond);
    return this.songBeatAtElapsed(elapsed);
  }

  /**
   * Context time and beat where the transport actually starts rolling. The
   * recorder uses the same AudioContext, so this aligns a take to the grid.
   * Null while stopped or during a count-in.
   */
  get transportAnchor(): { beat: number; ctxTime: number } | null {
    if (!this.playing || this.isCountingIn || !this.ctx) return null;
    return { beat: this.startBeat, ctxTime: this.startCtxTime };
  }

  /** Where the transport last started rolling, for the return-to-last command. */
  get lastPlayStart(): number {
    return this.lastStart;
  }

  /**
   * Starts the transport at `fromBeat`. With count-in enabled the transport
   * stays parked at that beat while a bar (or more) of clicks plays first;
   * seeking and tempo changes pass `countIn: false` so they resume instantly.
   */
  async play(fromBeat?: number, options: { countIn?: boolean; until?: number } = {}): Promise<void> {
    const ctx = await this.ensureContext();
    if (this.playing || this.isCountingIn) return;
    window.clearTimeout(this.silenceTimer);
    // Warped and reversed clips are rendered before the clock starts, so the
    // first downbeat already uses the processed buffer. The readout shows a
    // preparing state while this runs.
    const job = prepareProjectAudio(this.store);
    this.preparing = job;
    this.store.emit('transport');
    try {
      await job;
    } finally {
      if (this.preparing === job) this.preparing = null;
      this.store.emit('transport');
    }
    if (this.playing) return;
    this.applyMix();
    const target = clamp(fromBeat ?? this.stopPosition, 0, this.store.project.length);
    this.startBeat = target;
    this.lastStart = target;
    this.stopPosition = target;
    this.stopAt = options.until != null ? Math.max(target, options.until) : null;
    this.startCtxTime = ctx.currentTime + START_DELAY;

    if (options.countIn ?? this.metro.countIn) {
      this.beginCountIn(ctx, target);
      return;
    }

    this.startRolling(ctx, this.startCtxTime);
  }

  pause(): void {
    if (this.isCountingIn) {
      this.cancelCountIn();
      return;
    }
    if (!this.playing) return;
    const position = this.positionBeat;
    this.playing = false;
    this.clearTimer();
    this.stopPosition = position;
    this.stopAt = null;
    this.fadeOutAndSilence();
    this.store.emit('transport');
  }

  stop(): void {
    this.cancelCountIn(false);
    this.playing = false;
    this.clearTimer();
    this.stopPosition = 0;
    this.stopAt = null;
    this.fadeOutAndSilence();
    this.store.emit('transport');
  }

  togglePlay(): void {
    if (this.isCountingIn) this.pause();
    else if (this.playing) this.pause();
    else void this.play();
  }

  seek(beat: number): void {
    const wasPlaying = this.playing;
    const until = this.stopAt;
    this.cancelCountIn(false);
    this.playing = false;
    this.clearTimer();
    this.stopAt = null;
    this.stopPosition = clamp(beat, 0, this.store.project.length);
    this.silence();
    this.store.emit('transport');
    // Locating during playback keeps rolling, but never starts another count-in.
    if (wasPlaying) void this.play(this.stopPosition, { countIn: false, until: until ?? undefined });
  }

  /**
   * Moves a paused playhead without rebuilding the audio graph. Dragging the
   * ruler calls this dozens of times per second, so it must stay cheap.
   */
  locate(beat: number): void {
    if (this.isCountingIn) this.cancelCountIn(false);
    if (this.playing) return;
    this.stopPosition = clamp(beat, 0, this.store.project.length);
    this.store.emit('transport');
  }

  setMetronome(on: boolean): void {
    this.updateMetronome({ enabled: on });
  }

  setCountIn(on: boolean): void {
    this.updateMetronome({ countIn: on });
  }

  setMetronomeSettings(patch: Partial<MetronomeSettings>): void {
    this.updateMetronome(patch);
  }

  /** A one-shot click for tuning the sound and level in the settings panel. */
  async previewClick(level: ClickLevel = 'accent'): Promise<void> {
    const ctx = await this.ensureContext();
    this.click(ctx.currentTime + 0.02, level);
  }

  /**
   * Tape-style scrub: dragging the playhead plays short grains of every audio
   * clip under it, through the same channel strip as playback. `velocity` is
   * the drag speed in beats per second and tilts the grain pitch slightly.
   * Grains are throttled and self-fading, so scrubbing stays click-free.
   */
  async scrubAt(beat: number, velocity = 0): Promise<void> {
    if (this.playing || this.isCountingIn) return;
    const ctx = await this.ensureContext();
    const now = ctx.currentTime;
    if (now - this.lastScrubAt < 0.032) return;
    const graph = this.graph;
    if (!graph) return;
    this.lastScrubAt = now;

    const project = this.store.project;
    const secondsPerBeat = 60 / project.bpm;
    const anySolo = project.tracks.some((track) => track.solo);
    const rate = clamp(0.7 + Math.min(1.2, Math.abs(velocity) / 6) * 0.35, 0.7, 1.15);
    let grains = 0;

    for (const track of project.tracks) {
      if (grains >= 6) break;
      if (track.mute || (anySolo && !track.solo)) continue;
      const chain = graph.tracks.get(track.id);
      if (!chain) continue;

      for (const clip of project.clips) {
        if (grains >= 6) break;
        if (clip.trackId !== track.id || clip.kind !== 'audio') continue;
        if (beat < clip.start || beat >= clip.start + clip.length) continue;
        const audio = resolveClipAudio(this.store, clip, secondsPerBeat);
        if (!audio || audio.available <= 0.01) continue;

        const localSeconds = (beat - clip.start) * secondsPerBeat;
        const scale = clip.warp?.stretch
          ? audio.buffer.duration / Math.max(0.01, clip.length * secondsPerBeat)
          : 1;
        const offset = Math.min(audio.buffer.duration - 0.01, audio.offset + localSeconds * scale);
        if (offset < 0) continue;

        const grain = Math.min(0.07, Math.max(0.02, audio.available - localSeconds * scale));
        if (grain <= 0.01) continue;

        const source = ctx.createBufferSource();
        source.buffer = audio.buffer;
        source.playbackRate.value = rate;
        const gain = ctx.createGain();
        const level = 0.22 * clamp(clip.gain, 0, 4);
        const start = now + 0.004;
        gain.gain.setValueAtTime(0, start);
        gain.gain.linearRampToValueAtTime(level, start + 0.006);
        gain.gain.linearRampToValueAtTime(0, start + grain / rate);
        source.connect(gain);
        gain.connect(chain.input);
        source.start(start, offset, grain);
        source.onended = () => {
          source.disconnect();
          gain.disconnect();
        };
        grains++;
      }
    }
  }

  private updateMetronome(patch: Partial<MetronomeSettings>): void {
    const previous = this.metro;
    this.metro = normalizeMetronomeSettings({ ...this.metro, ...patch });
    if (this.isCountingIn && (!this.metro.countIn || this.metro.countInBars !== previous.countInBars)) {
      this.cancelCountIn(false);
    }
    this.onMetronomeChange?.(this.metronomeSettings);
    this.store.emit('view');
  }

  private beginCountIn(ctx: AudioContext, target: number): void {
    const project = this.store.project;
    const secondsPerBeat = 60 / project.bpm;
    const totalBeats = countInBeats(this.metro, project.beatsPerBar);
    if (totalBeats <= 0) {
      this.startRolling(ctx, ctx.currentTime + START_DELAY);
      return;
    }

    this.countInTarget = target;
    this.countInTotalBeats = totalBeats;
    this.countInStartAt = ctx.currentTime + START_DELAY;
    this.countInEndsAt = this.countInStartAt + totalBeats * secondsPerBeat;
    this.countInNodes = [];

    for (let beat = 0; beat < totalBeats; beat++) {
      this.click(
        this.countInStartAt + beat * secondsPerBeat,
        countInClickLevel(this.metro, beat, project.beatsPerBar),
        this.countInNodes,
      );
    }

    const delayMs = Math.max(0, (this.countInEndsAt - ctx.currentTime) * 1000);
    this.countInTimer = window.setTimeout(() => {
      this.countInTimer = null;
      if (!this.isCountingIn) return;
      const end = this.countInEndsAt;
      this.countInEndsAt = 0;
      this.countInTotalBeats = 0;
      this.countInNodes = [];
      this.startRolling(ctx, end);
    }, delayMs + 8);

    this.store.emit('transport');
  }

  private startRolling(ctx: AudioContext, startCtxTime: number): void {
    this.startCtxTime = startCtxTime;
    // A late timer means playback should already be under way; start the
    // scheduling cursor where the audio clock actually is, never at beat zero.
    this.cursorElapsed = Math.max(0, (ctx.currentTime - startCtxTime) * (this.store.project.bpm / 60));
    this.playing = true;
    this.clearTimer();
    this.timer = window.setInterval(this.tick, TICK_MS);
    this.tick();
    this.store.emit('transport');
  }

  /** Stops any pending count-in and its already-scheduled click oscillators. */
  private cancelCountIn(announce = true): void {
    if (this.countInTimer !== null) {
      window.clearTimeout(this.countInTimer);
      this.countInTimer = null;
    }
    for (const node of this.countInNodes) {
      try {
        node.stop();
        node.disconnect();
      } catch {
        // already stopped
      }
    }
    this.countInNodes = [];
    if (this.isCountingIn) this.stopPosition = this.countInTarget;
    this.countInEndsAt = 0;
    this.countInTotalBeats = 0;
    if (announce) this.store.emit('transport');
  }

  /** Console monitor section. Listen-only: the exported mix is unaffected. */
  setMonitor(options: { mono?: boolean; dim?: boolean }): void {
    if (options.mono !== undefined) this.monitorMonoOn = options.mono;
    if (options.dim !== undefined) this.monitorDimOn = options.dim;
    this.applyMonitor();
  }

  get monitor(): { mono: boolean; dim: boolean } {
    return { mono: this.monitorMonoOn, dim: this.monitorDimOn };
  }

  private applyMonitor(): void {
    const graph = this.graph;
    if (!graph || !this.ctx) return;
    const now = this.ctx.currentTime;
    // Mono sums L+R at −6 dB into both outputs; stereo passes each side through.
    graph.monoSum.gain.setTargetAtTime(this.monitorMonoOn ? 0.5 : 0, now, 0.01);
    graph.stereoLeft.gain.setTargetAtTime(this.monitorMonoOn ? 0 : 1, now, 0.01);
    graph.stereoRight.gain.setTargetAtTime(this.monitorMonoOn ? 0 : 1, now, 0.01);
    graph.masterDim.gain.setTargetAtTime(this.monitorDimOn ? dbToGain(-18) : 1, now, 0.01);
  }

  async previewNote(trackId: string, pitch: number, duration = 0.5): Promise<void> {
    const ctx = await this.ensureContext();
    const chain = this.graph?.tracks.get(trackId);
    chain?.instrument?.noteOn(ctx.currentTime + 0.01, pitch, 0.8, duration);
  }

  /**
   * Plays notes that arrive from a MIDI controller or the computer keyboard.
   *
   * The track's MIDI effects run first, so a chord device turns one key into a
   * chord and an arpeggiator turns a held key into a pattern; every resulting
   * note is scheduled against the audio clock, which is what keeps an
   * arpeggio in time instead of drifting with the UI thread.
   */
  async playLiveNotes(trackId: string, notes: readonly MidiNote[]): Promise<void> {
    if (notes.length === 0) return;
    const ctx = await this.ensureContext();
    const chain = this.graph?.tracks.get(trackId);
    if (!chain?.instrument) return;

    const secondsPerBeat = 60 / this.store.project.bpm;
    const start = ctx.currentTime + 0.02;
    for (const note of notes) {
      const when = start + Math.max(0, note.start) * secondsPerBeat;
      chain.instrument.noteOn(when, note.pitch, note.velocity, Math.max(0.05, note.duration * secondsPerBeat));
    }
  }

  /** One note through the track's MIDI effect chain, for live playing. */
  async liveNote(trackId: string, pitch: number, velocity: number, duration = 2): Promise<void> {
    const track = this.store.project.tracks.find((entry) => entry.id === trackId);
    const secondsPerBeat = 60 / this.store.project.bpm;
    const notes = applyMidiFx(
      track?.midiFx,
      [{ pitch, start: 0, duration, velocity }],
      { secondsPerBeat },
    );
    await this.playLiveNotes(trackId, notes);
  }

  trackPeak(trackId: string): number {
    const chain = this.graph?.tracks.get(trackId);
    if (!chain?.analyser || !chain.meter) return 0;
    return this.readPeak(chain.analyser, chain.meter);
  }

  /**
   * Real output level of one insert, 0..1 — the number its faceplate meter
   * draws. The insert list is the enabled subset the graph built, so the index
   * comes from the same filter the graph used.
   */
  deviceLevel(scope: 'master' | string, deviceId: string): number {
    if (!this.graph) return 0;
    const project = this.store.project;
    const states =
      scope === 'master'
        ? project.master.devices
        : project.tracks.find((track) => track.id === scope)?.devices;
    const devices = scope === 'master' ? this.graph.masterDevices : this.graph.tracks.get(scope)?.devices;
    if (!states || !devices) return 0;
    const active = states.filter((state) => state.enabled);
    const index = active.findIndex((state) => state.id === deviceId);
    if (index < 0) return 0;
    return devicePeak(devices[index]);
  }

  /** Peak level of an aux return channel, for its mixer meter. */
  returnPeak(index: number): number {
    const chain = this.graph?.returns[index];
    if (!chain?.analyser || !chain.meter) return 0;
    return this.readPeak(chain.analyser, chain.meter);
  }

  private readPeak(analyser: AnalyserNode, meter: Uint8Array<ArrayBuffer>): number {
    analyser.getByteTimeDomainData(meter);
    let peak = 0;
    for (let i = 0; i < meter.length; i++) {
      const v = Math.abs((meter[i] - 128) / 128);
      if (v > peak) peak = v;
    }
    return peak;
  }

  /** Time-domain data for a channel's mixer scope; null when nothing is running. */
  trackWaveform(trackId: string): Uint8Array | null {
    const chain = this.graph?.tracks.get(trackId);
    if (!chain?.analyser || !chain.meter) return null;
    chain.analyser.getByteTimeDomainData(chain.meter);
    return chain.meter;
  }

  returnWaveform(index: number): Uint8Array | null {
    const chain = this.graph?.returns[index];
    if (!chain?.analyser || !chain.meter) return null;
    chain.analyser.getByteTimeDomainData(chain.meter);
    return chain.meter;
  }

  masterWaveform(): Uint8Array | null {
    const analyser = this.graph?.masterAnalyser;
    const meter = this.graph?.masterMeter;
    if (!analyser || !meter) return null;
    analyser.getByteTimeDomainData(meter);
    return meter;
  }

  masterPeak(): number {
    const analyser = this.graph?.masterAnalyser;
    const meter = this.graph?.masterMeter;
    if (!analyser || !meter) return 0;
    analyser.getByteTimeDomainData(meter);
    let peak = 0;
    for (let i = 0; i < meter.length; i++) {
      const v = Math.abs((meter[i] - 128) / 128);
      if (v > peak) peak = v;
    }
    return peak;
  }

  dispose(): void {
    this.cancelCountIn(false);
    this.clearTimer();
    this.unsubscribe();
    this.graph?.dispose();
    void this.ctx?.close();
    this.ctx = null;
    this.graph = null;
  }

  // ---------------------------------------------------------------- internals

  private clearTimer(): void {
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
  }

  private computeSignature(): string {
    const project = this.store.project;
    // Sorted by id, so reordering the channel list never looks like a graph
    // change and can't tear the audio down mid-take.
    const ordered = [...project.tracks].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const tracks = ordered
      .map(
        (t) =>
          `${t.id}:${t.kind}:${t.instrument?.type ?? '-'}:${t.devices
            .map((d) => `${d.type}${d.enabled ? '+' : '-'}`)
            .join(',')}`,
      )
      .join('|');
    const master = project.master.devices.map((d) => `${d.type}${d.enabled ? '+' : '-'}`).join(',');
    const sends = ordered.map((t) => t.preSends.map((pre) => (pre ? 'p' : 'f')).join('')).join('|');
    const returns = project.returns
      .map((bus) => `${bus.id}:${bus.devices.map((d) => `${d.type}${d.enabled ? '+' : '-'}`).join(',')}`)
      .join('|');
    return `${tracks}#${master}#${sends}#${returns}`;
  }

  private silence(): void {
    if (!this.ctx) return;
    this.graph?.dispose();
    this.graph = buildGraph(this.ctx, this.store.project, { meters: true });
    this.signature = this.computeSignature();
    this.applyMix();
  }

  /**
   * Ramp the master down over a few milliseconds before tearing the graph down,
   * so pause/stop does not produce a click. Playback restores the level through
   * applyMix(), and a late timer can never silence a newly started transport.
   */
  private fadeOutAndSilence(): void {
    if (!this.ctx || !this.graph) {
      this.silence();
      return;
    }

    const ctx = this.ctx;
    const graph = this.graph;
    const now = ctx.currentTime;

    graph.masterGain.gain.cancelScheduledValues(now);
    graph.masterGain.gain.setTargetAtTime(0, now, 0.004);

    window.clearTimeout(this.silenceTimer);
    this.silenceTimer = window.setTimeout(() => {
      if (this.ctx === ctx && !this.playing) this.silence();
    }, 45);
  }

  private syncStructure(): void {
    if (!this.ctx) return;
    if (this.computeSignature() !== this.signature) {
      this.silence();
    }
    this.applyMix();
    this.syncParams();
  }

  private syncParams(): void {
    const project = this.store.project;
    if (!this.graph) return;

    if (project.bpm !== this.lastBpm) {
      this.lastBpm = project.bpm;
      // A count-in's click times are already committed at the old tempo; cancel
      // rather than let the first downbeat land off the grid.
      if (this.isCountingIn) this.cancelCountIn(false);
      if (this.playing) {
        this.restart(this.positionBeat);
        return;
      }
    }

    for (const track of project.tracks) {
      const chain = this.graph.tracks.get(track.id);
      if (!chain) continue;
      const active = track.devices.filter((d) => d.enabled);
      active.forEach((state, index) => {
        const device = chain.devices[index];
        if (!device) return;
        // Synced echoes follow the session tempo without needing a re-save.
        if (state.type === 'delay') device.setParam('bpm', project.bpm);
        for (const [key, value] of Object.entries(state.params)) device.setParam(key, value);
      });
      if (track.instrument && chain.instrument) {
        for (const [key, value] of Object.entries(track.instrument.params)) {
          chain.instrument.setParam(key, value);
        }
      }
    }

    const masterActive = project.master.devices.filter((d) => d.enabled);
    masterActive.forEach((state, index) => {
      const device = this.graph?.masterDevices[index];
      if (!device) return;
      if (state.type === 'delay') device.setParam('bpm', project.bpm);
      for (const [key, value] of Object.entries(state.params)) device.setParam(key, value);
    });

    // Return effects follow their edits and the session tempo too.
    project.returns.forEach((bus, busIndex) => {
      const chain = this.graph?.returns[busIndex];
      if (!chain) return;
      bus.devices
        .filter((state) => state.enabled)
        .forEach((state, index) => {
          const device = chain.devices[index];
          if (!device) return;
          if (state.type === 'delay') device.setParam('bpm', project.bpm);
          for (const [key, value] of Object.entries(state.params)) device.setParam(key, value);
        });
    });

    this.applyMix();
  }

  private restart(beat: number): void {
    this.playing = false;
    this.clearTimer();
    this.stopPosition = beat;
    this.silence();
    void this.play(beat, { countIn: false });
  }

  private applyMix(): void {
    if (!this.ctx || !this.graph) return;
    const project = this.store.project;
    const anySolo = project.tracks.some((t) => t.solo) || project.returns.some((r) => r.solo);
    const now = this.ctx.currentTime;
    for (const track of project.tracks) {
      const chain = this.graph.tracks.get(track.id);
      if (!chain) continue;
      const audible = !track.mute && (!anySolo || track.solo);
      chain.trim.gain.setTargetAtTime(dbToGain(track.gain), now, 0.012);
      // EQ OUT is a true bypass: the high-pass becomes an all-pass and the
      // shelves/bell sit at 0 dB, so the channel is flat without a rebuild.
      const eqOn = track.eqOn !== false;
      chain.hp.type = eqOn ? 'highpass' : 'allpass';
      chain.hp.frequency.setTargetAtTime(eqOn ? track.eq.hp : 20, now, 0.012);
      chain.low.gain.setTargetAtTime(eqOn ? track.eq.low : 0, now, 0.012);
      chain.mid.frequency.setTargetAtTime(track.eq.midFreq, now, 0.012);
      chain.mid.gain.setTargetAtTime(eqOn ? track.eq.mid : 0, now, 0.012);
      chain.high.gain.setTargetAtTime(eqOn ? track.eq.high : 0, now, 0.012);
      chain.gain.gain.setTargetAtTime(audible ? track.volume : 0, now, 0.012);
      chain.panner.pan.setTargetAtTime(track.pan, now, 0.012);
      chain.sends.forEach((send, index) => {
        send.gain.setTargetAtTime(track.sends[index] ?? 0, now, 0.012);
      });
    }

    project.returns.forEach((bus, index) => {
      const chain = this.graph?.returns[index];
      if (!chain) return;
      const audible = !bus.mute && (!anySolo || bus.soloSafe || bus.solo);
      chain.gain.gain.setTargetAtTime(audible ? bus.volume : 0, now, 0.012);
      chain.panner.pan.setTargetAtTime(bus.pan, now, 0.012);
    });

    this.graph.masterGain.gain.setTargetAtTime(project.master.volume, now, 0.012);
    this.applyMonitor();
  }

  private songBeatAtElapsed(elapsed: number): number {
    const project = this.store.project;
    const { loop } = project;
    if (!loop.enabled || loop.end <= loop.start) return this.startBeat + elapsed;
    const loopLen = loop.end - loop.start;
    const firstLen = loop.end - this.startBeat;
    if (firstLen <= 0) return loop.start + ((elapsed - firstLen) % loopLen);
    if (elapsed < firstLen) return this.startBeat + elapsed;
    return loop.start + ((elapsed - firstLen) % loopLen);
  }

  private elapsedForSongBeat(beat: number, cursor: number): number {
    const { loop } = this.store.project;
    if (!loop.enabled || loop.end <= loop.start) return beat - this.startBeat;

    const loopLen = loop.end - loop.start;
    const firstLen = loop.end - this.startBeat;

    if (beat >= this.startBeat && beat < loop.end) {
      const direct = beat - this.startBeat;
      if (direct >= cursor - 1e-6) return direct;
    }

    if (beat < loop.start) {
      if (beat >= this.startBeat) {
        const direct = beat - this.startBeat;
        return direct >= cursor - 1e-6 ? direct : Number.NEGATIVE_INFINITY;
      }
      return Number.NEGATIVE_INFINITY;
    }

    const base = firstLen + (beat - loop.start);
    if (base >= cursor - 1e-6) return base;
    const wraps = Math.ceil((cursor - base) / loopLen);
    return base + wraps * loopLen;
  }

  private tick = (): void => {
    if (!this.playing || !this.ctx || !this.graph) return;
    const project = this.store.project;

    if (this.stopAt !== null && this.positionBeat >= this.stopAt - 1e-9) {
      // Range playback ends cleanly on its own, leaving the transport parked on
      // the selection end rather than at zero.
      const end = this.stopAt;
      this.playing = false;
      this.clearTimer();
      this.stopAt = null;
      this.stopPosition = clamp(end, 0, project.length);
      this.fadeOutAndSilence();
      this.store.emit('transport');
      return;
    }

    if (!project.loop.enabled && this.positionBeat >= project.length) {
      this.stop();
      return;
    }

    const beatsPerSecond = project.bpm / 60;
    const nowElapsed = Math.max(0, (this.ctx.currentTime - this.startCtxTime) * beatsPerSecond);
    const lookaheadBeats = LOOKAHEAD_SECONDS * beatsPerSecond;
    const windowEnd = nowElapsed + lookaheadBeats;
    const windowStart = Math.min(this.cursorElapsed, windowEnd);

    this.scheduleWindow(windowStart, windowEnd);
    this.cursorElapsed = windowEnd;
  };

  private scheduleWindow(from: number, to: number): void {
    if (!this.ctx || !this.graph || to <= from) return;
    const project = this.store.project;
    const secondsPerBeat = 60 / project.bpm;
    const base = this.startCtxTime;
    const nowTime = this.ctx.currentTime;

    for (const track of project.tracks) {
      const chain = this.graph.tracks.get(track.id);
      if (!chain) continue;

      for (const clip of project.clips) {
        if (clip.trackId !== track.id) continue;

        if (clip.kind === 'midi' && chain.instrument) {
          // MIDI effects sit in front of the instrument: the notes scheduled
          // here are the device chain's output, not the stored notes.
          const played = track.midiFx?.length
            ? applyMidiFx(
                track.midiFx,
                clip.notes.map((note) => ({
                  pitch: note.pitch,
                  start: note.start,
                  duration: note.duration,
                  velocity: note.velocity,
                })),
                { secondsPerBeat },
              )
            : clip.notes;

          for (const note of played) {
            const elapsed = this.elapsedForSongBeat(clip.start + note.start, from);
            if (!Number.isFinite(elapsed) || elapsed < from - 1e-6 || elapsed >= to) continue;
            const when = base + elapsed * secondsPerBeat;
            if (when < nowTime - 0.002) continue;
            chain.instrument.noteOn(
              when,
              note.pitch,
              note.velocity,
              Math.max(0.03, note.duration * secondsPerBeat),
            );
          }
        } else if (clip.kind === 'audio' && clip.assetId) {
          const audio = resolveClipAudio(this.store, clip, secondsPerBeat);
          if (!audio) continue;
          const elapsed = this.elapsedForSongBeat(clip.start, from);
          if (!Number.isFinite(elapsed) || elapsed < from - 1e-6 || elapsed >= to) continue;
          const when = base + elapsed * secondsPerBeat;
          if (when < nowTime - 0.002) continue;
          const limit = project.loop.enabled ? Math.max(0, project.loop.end - clip.start) : clip.length;
          const durationBeats = Math.max(0.05, Math.min(clip.length, limit));
          const seconds = Math.min(durationBeats * secondsPerBeat, audio.available);
          if (seconds <= 0.002) continue;

          const source = this.ctx.createBufferSource();
          source.buffer = audio.buffer;
          const gain = this.ctx.createGain();

          // Fade in and out so clip boundaries never click or pop.
          const fades = resolveFades(clip, this.store.autoFade, seconds);
          applyFadeEnvelope(gain.gain, fadeEnvelope(when, seconds, fades, clip.gain), when);

          source.connect(gain);
          gain.connect(chain.input);
          source.start(when, audio.offset, seconds);
        }
      }
    }

    if (this.metro.enabled) this.scheduleClicks(from, to);
  }

  private scheduleClicks(from: number, to: number): void {
    if (!this.ctx) return;
    const project = this.store.project;
    const secondsPerBeat = 60 / project.bpm;
    const step = 1 / this.metro.subdivision;
    const first = Math.ceil(from / step - 1e-6);

    for (let index = first; index * step < to; index++) {
      const elapsed = index * step;
      if (elapsed < from - 1e-6 || elapsed < 0) continue;
      const songBeat = this.songBeatAtElapsed(elapsed);
      const nearestBeat = Math.round(songBeat);
      const onBeat = Math.abs(songBeat - nearestBeat) < 0.03;
      const inBar = ((nearestBeat % project.beatsPerBar) + project.beatsPerBar) % project.beatsPerBar;
      const level: ClickLevel = onBeat ? (inBar === 0 ? 'accent' : 'beat') : 'subdivision';
      this.click(this.startCtxTime + elapsed * secondsPerBeat, level);
    }
  }

  /**
   * One metronome voice. The frequency, envelope and level differ per sound
   * and per metric role, and the click rides the master input so its level is
   * audible in context without ever being part of an exported mixdown.
   */
  private click(when: number, level: ClickLevel, keep?: OscillatorNode[]): void {
    if (!this.ctx || !this.graph) return;
    const ctx = this.ctx;
    if (this.metro.volume <= 0.0005 || when < ctx.currentTime - 0.01) return;

    const accent = level === 'accent' && this.metro.accent;
    const sound: ClickSound = this.metro.sound;
    const base = sound === 'classic' ? 1568 : sound === 'click' ? 2093 : 1046;
    const ratio = level === 'subdivision' ? 0.5 : accent ? 1 : 0.75;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = sound === 'click' ? 'square' : sound === 'wood' ? 'triangle' : 'sine';
    osc.frequency.setValueAtTime(base * ratio, when);

    const attack = sound === 'wood' ? 0.0015 : 0.002;
    const release = sound === 'wood' ? 0.07 : sound === 'click' ? 0.028 : 0.05;
    const peak = (accent ? 0.22 : level === 'beat' ? 0.12 : 0.06) * this.metro.volume;
    gain.gain.setValueAtTime(0.0001, when);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), when + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, when + release);

    osc.connect(gain);
    gain.connect(this.graph.masterInput);
    osc.start(when);
    osc.stop(when + release + 0.01);
    if (keep) keep.push(osc);
  }
}
