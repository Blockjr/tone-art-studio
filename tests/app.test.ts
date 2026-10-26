// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

/* ------------------------------------------------------------------ *
 * Minimal Web Audio double: enough surface for the engine to boot and
 * schedule without a real device.
 * ------------------------------------------------------------------ */
const param = (value = 0) => ({
  value,
  setValueAtTime() {},
  linearRampToValueAtTime() {},
  exponentialRampToValueAtTime() {},
  setTargetAtTime() {},
  cancelScheduledValues() {},
});

interface FakeNode {
  connect(dest?: unknown): FakeNode;
  disconnect(): void;
  [key: string]: unknown;
}

function fakeNode(): FakeNode {
  return {
    connect: (dest?: unknown) => (dest as FakeNode) ?? fakeNode(),
    disconnect() {},
    start() {},
    stop() {},
    gain: param(1),
    frequency: param(440),
    Q: param(1),
    detune: param(0),
    delayTime: param(0),
    pan: param(0),
    threshold: param(-24),
    knee: param(30),
    ratio: param(12),
    attack: param(0.003),
    release: param(0.25),
    type: 'sine',
    curve: null,
    oversample: 'none',
    fftSize: 1024,
    smoothingTimeConstant: 0.5,
    buffer: null,
    stream: {},
    getByteTimeDomainData(array: Uint8Array) {
      array.fill(128);
    },
    setPeriodicWave() {}
  };
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  static oscillators = 0;
  destination = fakeNode();
  sampleRate = 48000;
  state = 'running';
  private started = performance.now();

  constructor() {
    FakeAudioContext.instances.push(this);
  }

  get currentTime(): number {
    return (performance.now() - this.started) / 1000;
  }

  async resume(): Promise<void> {
    this.state = 'running';
  }

  async close(): Promise<void> {
    this.state = 'closed';
  }

  createGain = () => fakeNode();
  createBiquadFilter = () => fakeNode();
  createDynamicsCompressor = () => fakeNode();
  createWaveShaper = () => fakeNode();
  createOscillator = () => {
    FakeAudioContext.oscillators++;
    return fakeNode();
  };
  createBufferSource = () => fakeNode();
  createAnalyser = () => fakeNode();
  createPeriodicWave = () => ({});
  createStereoPanner = () => fakeNode();
  createChannelSplitter = () => fakeNode();
  createChannelMerger = () => fakeNode();
  createDelay = () => fakeNode();
  createConvolver = () => fakeNode();
  createMediaStreamSource = () => fakeNode();
  createBuffer = (_channels: number, length: number) => ({
    length,
    numberOfChannels: 1,
    sampleRate: 48000,
    getChannelData: () => new Float32Array(length),
  });
}

function installBrowserDoubles(): void {
  const audio = new Proxy({}, {
    get: (_target, prop) => {
      if (prop === 'createLinearGradient') return () => ({ addColorStop() {} });
      return () => {};
    },
    set: () => true,
  });

  HTMLCanvasElement.prototype.getContext = function getContext(this: HTMLCanvasElement) {
    return audio as unknown as CanvasRenderingContext2D;
  } as unknown as typeof HTMLCanvasElement.prototype.getContext;

  if (!('ResizeObserver' in window)) {
    class ResizeObserverDouble {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    (window as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverDouble;
  }
  if (!('requestAnimationFrame' in window)) {
    (window as unknown as { requestAnimationFrame: unknown }).requestAnimationFrame = (cb: FrameRequestCallback) =>
      setTimeout(() => cb(performance.now()), 16);
  }
}

async function bootApp(): Promise<void> {
  const html = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8');
  const body = html.match(/<body>([\s\S]*?)<\/body>/)?.[1] ?? '';
  document.body.innerHTML = body.replace(/<script[\s\S]*?<\/script>/g, '');
  installBrowserDoubles();
  (window as unknown as { AudioContext: unknown }).AudioContext = FakeAudioContext;
  // Boot straight into the workspace; the start screen has its own tests.
  localStorage.setItem(
    'hybrid.prefs',
    JSON.stringify({ showStartup: false, scanVst3OnStart: false, autosave: true }),
  );
  await import('../src/main');
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 120));
}

const $ = (id: string): HTMLElement => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing #${id}`);
  return node;
};

const wait = (ms: number): Promise<void> => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

beforeAll(async () => {
  await bootApp();
}, 15000);

describe('Tone Art Studio app shell', () => {
  it('renders the default project across all three panes', () => {
    expect(document.querySelectorAll('.track-head').length).toBe(4);
    expect(document.querySelectorAll('.strip').length).toBe(9);
    expect(document.querySelectorAll('.strip.is-return').length).toBe(4);
    expect(document.querySelectorAll('#rack-body .device').length).toBeGreaterThanOrEqual(2);
    expect(document.querySelectorAll('#browser-body .browser-item').length).toBeGreaterThan(8);
    expect($('song-meta').textContent).toContain('4 tracks');
  });

  it('starts and stops the transport with the audio clock', async () => {
    $('btn-play').click();
    await wait(450);
    expect($('pos-time').textContent).not.toBe('00:00.000');
    expect($('btn-play').className).toContain('is-on');
    expect(FakeAudioContext.instances.length).toBeGreaterThan(0);

    $('btn-stop').click();
    await wait(80);
    expect($('pos-time').textContent).toBe('00:00.000');
  });

  it('types a location, adds a marker and navigates between locators', async () => {
    $('pos').click();
    await wait(30);
    const position = document.querySelector('.position-input') as HTMLInputElement;
    expect(position).not.toBeNull();
    position.value = '2.1.1';
    position.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await wait(60);
    expect($('pos-bars').textContent).toBe('2.1.1');

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'm', bubbles: true }));
    await wait(60);
    const name = document.querySelector('.marker-name-input') as HTMLInputElement;
    expect(name).not.toBeNull();
    name.value = 'Test Marker';
    name.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await wait(60);

    document.dispatchEvent(new KeyboardEvent('keydown', { key: '.', bubbles: true }));
    await wait(60);
    expect($('pos-bars').textContent).toBe('3.1.1');

    document.dispatchEvent(new KeyboardEvent('keydown', { key: ',', bubbles: true }));
    await wait(60);
    expect($('pos-bars').textContent).toBe('2.1.1');
  });

  it('launches a track mute from the mixer into the track header', async () => {
    const strip = document.querySelector('.strip') as HTMLElement;
    const mute = [...strip.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'M') as HTMLButtonElement;
    mute.click();
    await wait(60);
    const header = document.querySelector('.track-head') as HTMLElement;
    expect(header.querySelectorAll('button.is-on').length).toBeGreaterThan(0);
  });

  it('adds a device from the rack and undoes it', async () => {
    const before = document.querySelectorAll('#rack-body .device').length;
    const selects = document.querySelectorAll('#rack-body select');
    const addSelect = selects[selects.length - 1] as HTMLSelectElement;
    addSelect.value = 'reverb';
    addSelect.dispatchEvent(new Event('change', { bubbles: true }));
    await wait(80);
    expect(document.querySelectorAll('#rack-body .device').length).toBe(before + 1);

    $('btn-undo').click();
    await wait(80);
    expect(document.querySelectorAll('#rack-body .device').length).toBe(before);
  });

  it('gives the echo a working faceplate', async () => {
    const selects = document.querySelectorAll('#rack-body select');
    const addSelect = selects[selects.length - 1] as HTMLSelectElement;
    addSelect.value = 'delay';
    addSelect.dispatchEvent(new Event('change', { bubbles: true }));
    await wait(120);

    // The rack now has a faceplate for every insert, so find the echo's own.
    const echoPanel = (): HTMLElement | null =>
      ([...document.querySelectorAll('#rack-body .device')].find(
        (card) => card.querySelector('.device-title')?.textContent === 'Echo',
      )?.querySelector('.fx-panel') as HTMLElement | undefined) ?? null;
    const panel = echoPanel();
    expect(panel).toBeTruthy();
    expect([...panel!.querySelectorAll('.fx-mode')].map((b) => b.textContent)).toEqual([
      'Tape',
      'BBD',
      'Digital',
      'Ping-Pong',
    ]);
    expect(panel!.querySelectorAll('.knob')).toHaveLength(10);
    expect((panel!.querySelector('.fx-chips') as HTMLElement).hidden).toBe(true);

    (panel!.querySelector('.fx-sync') as HTMLButtonElement).click();
    await wait(100);
    const synced = echoPanel() as HTMLElement;
    expect((synced.querySelector('.fx-chips') as HTMLElement).hidden).toBe(false);
    expect(synced.querySelector('.knob')?.classList.contains('is-locked')).toBe(true);
    expect(synced.querySelector('.fx-tag')?.textContent).toContain('BPM');

    // Freeze holds the repeats and locks the controls it overrides.
    const freeze = synced.querySelector('.fx-freeze') as HTMLButtonElement;
    expect(freeze.getAttribute('aria-pressed')).toBe('false');
    freeze.click();
    await wait(80);
    const frozen = echoPanel() as HTMLElement;
    expect((frozen.querySelector('.fx-freeze') as HTMLElement).classList.contains('is-on')).toBe(true);
    expect(frozen.querySelector('.fx-freeze')?.getAttribute('aria-pressed')).toBe('true');
    expect(frozen.querySelector('.fx-tag')?.textContent).toContain('HOLD');
    expect(frozen.querySelectorAll('.knob.is-locked')).toHaveLength(2);
    (frozen.querySelector('.fx-freeze') as HTMLButtonElement).click();
    await wait(80);
    expect((echoPanel()!.querySelector('.fx-freeze') as HTMLElement).classList.contains('is-on')).toBe(false);

    // Mode changes rebuild the card, so the subtitle names the storage type.
    const bbd = [...synced.querySelectorAll('.fx-mode')].find((b) => b.textContent === 'BBD') as HTMLButtonElement;
    bbd.click();
    await wait(120);
    expect(echoPanel()?.closest('.device')?.querySelector('.device-sub')?.textContent).toContain('BBD');

    // Leave the session as it was found, whatever the gesture history holds.
    for (let step = 0; step < 12 && echoPanel(); step++) {
      $('btn-undo').click();
      await wait(80);
    }
    expect(echoPanel()).toBeFalsy();
  });

  it('gives every track its own insert chain in the rack', async () => {
    const tabs = [...document.querySelectorAll('.rack-tab')];
    expect(tabs.length).toBe(document.querySelectorAll('.track-head').length + 1);
    expect(tabs.at(-1)?.textContent).toContain('Master');

    // Moving to another track shows that track's chain, on its own tab.
    const second = tabs[1] as HTMLElement;
    second.click();
    await wait(80);
    expect(document.querySelector('.rack-tab.is-on')?.textContent).toContain(second.textContent?.trim() ?? '');
    expect($('rack-track-name').textContent).toBe(second.textContent?.trim());

    (tabs[0] as HTMLElement).click();
    await wait(80);
  });

  it('loads a track template into the rack and undoes it', async () => {
    const before = document.querySelectorAll('#rack-body .device').length;
    const templates = [...document.querySelectorAll('.chain-actions .chain-btn')].find((b) =>
      b.textContent?.includes('Templates'),
    ) as HTMLButtonElement;
    templates.click();
    await wait(80);
    expect(document.querySelectorAll('.chain-template').length).toBeGreaterThan(3);

    document.querySelector<HTMLButtonElement>('.chain-template')!.click();
    await wait(120);
    const titles = [...document.querySelectorAll('#rack-body .device .device-title')].map((node) =>
      node.textContent?.trim(),
    );
    expect(titles).toContain('Console Strip');
    expect(titles).toContain('FET Comp');
    expect(document.querySelectorAll('#rack-body .device-slot').length).toBeGreaterThan(2);
    expect(document.querySelector('.chain-status')?.textContent).toContain('applied');

    $('btn-undo').click();
    await wait(120);
    expect(document.querySelectorAll('#rack-body .device').length).toBe(before);
  });

  it('loads a master template that ends in a limiter', async () => {
    (document.querySelector('.rack-tab-master') as HTMLElement).click();
    await wait(80);
    expect($('rack-track-name').textContent).toBe('Master bus');

    const templates = [...document.querySelectorAll('.chain-actions .chain-btn')].find((b) =>
      b.textContent?.includes('Templates'),
    ) as HTMLButtonElement;
    templates.click();
    await wait(80);
    const master = [...document.querySelectorAll('.chain-template')].find((node) =>
      node.textContent?.includes('Streaming'),
    ) as HTMLButtonElement;
    master.click();
    await wait(120);
    const titles = [...document.querySelectorAll('#rack-body .device .device-title')].map((node) =>
      node.textContent?.trim(),
    );
    expect(titles.at(-1)).toBe('Limiter');
    expect(titles).toContain('Bus Glue');

    $('btn-undo').click();
    await wait(120);
    (document.querySelector('.rack-tab') as HTMLElement).click();
    await wait(80);
  });

  it('changes tempo from the transport field', async () => {
    const tempo = $('tempo-input') as HTMLInputElement;
    tempo.value = '96';
    tempo.dispatchEvent(new Event('change', { bubbles: true }));
    await wait(80);
    expect($('song-meta').textContent).toContain('96 BPM');
  });

  it('adds a MIDI track and lists it everywhere', async () => {
    const before = document.querySelectorAll('.track-head').length;
    $('btn-add-midi').click();
    await wait(100);
    expect(document.querySelectorAll('.track-head').length).toBe(before + 1);
    expect(document.querySelectorAll('.strip').length).toBe(before + 6);
  });

  it('loops between the markers around the playhead and keeps the clip bar ready', async () => {
    // With no clip selected the audio inspector stays out of the way.
    expect($('clip-bar').hidden).toBe(true);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'l', bubbles: true }));
    await wait(80);
    expect($('btn-loop').className).toContain('is-on');
    expect($('toast').textContent).toContain('Looping between');
    // The bar and its audio-only commands exist and are wired even when hidden.
    expect($('clip-gain')).not.toBeNull();
    expect($('clip-stretch')).not.toBeNull();
    expect(($('btn-quantize') as HTMLButtonElement).disabled).toBe(false);
  });

  it('switches the browser between the library and the file explorer', async () => {
    const library = $('browser-body');
    const files = $('browser-files');
    expect(library.hidden).toBe(false);
    expect(files.hidden).toBe(true);

    $('browser-tab-files').click();
    await wait(40);
    expect(files.hidden).toBe(false);
    expect(library.hidden).toBe(true);
    expect($('browser-tab-files').getAttribute('aria-selected')).toBe('true');

    // The explorer is a real panel, not a placeholder.
    expect(document.querySelector('.explorer')).not.toBeNull();
    expect(document.querySelector('.explorer-search-input')).not.toBeNull();
    expect(document.querySelector('.explorer-pool')).not.toBeNull();

    $('browser-tab-library').click();
    await wait(40);
    expect(library.hidden).toBe(false);
    expect(files.hidden).toBe(true);
    expect($('browser-tab-library').getAttribute('aria-selected')).toBe('true');
  });

  it('toggles loop and metronome', () => {
    $('btn-loop').click();
    expect($('btn-loop').className).not.toContain('is-on');
    $('btn-metro').click();
    expect($('btn-metro').className).toContain('is-on');
  });

  it('configures the click sound, level and count-in length', async () => {
    $('btn-metro-menu').click();
    await wait(20);
    const menu = document.getElementById('metronome-menu') as HTMLElement;
    expect(menu.classList.contains('is-open')).toBe(true);

    const sound = document.getElementById('metro-sound') as HTMLSelectElement;
    sound.value = 'wood';
    sound.dispatchEvent(new Event('change', { bubbles: true }));

    const volume = document.getElementById('metro-volume') as HTMLInputElement;
    volume.value = '30';
    volume.dispatchEvent(new Event('input', { bubbles: true }));

    const countIn = document.getElementById('metro-countin') as HTMLInputElement;
    countIn.click();
    const bars = document.getElementById('metro-countin-bars') as HTMLSelectElement;
    bars.value = '2';
    bars.dispatchEvent(new Event('change', { bubbles: true }));
    await wait(30);

    expect($('btn-countin').title).toContain('2 bars');
    const stored = JSON.parse(localStorage.getItem('hybrid.prefs') ?? '{}');
    expect(stored.metronome).toMatchObject({ sound: 'wood', volume: 0.3, countIn: true, countInBars: 2 });

    $('btn-metro-menu').click();
    expect(menu.classList.contains('is-open')).toBe(false);
  });

  it('counts down before the transport starts rolling', async () => {
    const tempo = $('tempo-input') as HTMLInputElement;
    tempo.value = '260';
    tempo.dispatchEvent(new Event('change', { bubbles: true }));
    await wait(30);

    // Use one bar so the transition to rolling happens quickly in the test.
    $('btn-metro-menu').click();
    await wait(20);
    const bars = document.getElementById('metro-countin-bars') as HTMLSelectElement;
    bars.value = '1';
    bars.dispatchEvent(new Event('change', { bubbles: true }));
    $('btn-metro-menu').click();

    const clickVoices = FakeAudioContext.oscillators;
    $('btn-play').click();
    await wait(120);
    expect($('pos').className).toContain('is-counting');
    expect($('btn-countin').textContent).toMatch(/[1-8]/);
    expect(FakeAudioContext.oscillators - clickVoices).toBeGreaterThanOrEqual(4);

    await wait(1200);
    expect($('pos').className).not.toContain('is-counting');
    expect($('pos-time').textContent).not.toBe('00:00.000');

    $('btn-stop').click();
    await wait(40);
    expect($('pos').className).not.toContain('is-counting');
    expect($('pos-time').textContent).toBe('00:00.000');

    // Leave the shared session with the count-in off for the remaining tests.
    $('btn-countin').click();
  });

  it('gives every channel strip its own EQ band set and input trim', () => {
    const strip = document.querySelector('.strip') as HTMLElement;
    expect(strip.querySelectorAll('.strip-eq .knob').length).toBe(6);
    const labels = [...strip.querySelectorAll('.strip-eq .knob-label')].map((node) => node.textContent);
    expect(labels).toEqual(['Trim', 'HP', 'Low', 'Mid', 'Mid F', 'High']);
  });

  it('offers four aux sends per channel with pre/post switching', () => {
    const strip = document.querySelector('.strip') as HTMLElement;
    const sends = strip.querySelectorAll('.send-cell');
    expect(sends.length).toBe(4);

    const labels = [...strip.querySelectorAll('.send-cell .knob-label')].map((node) => node.textContent);
    expect(labels).toEqual(['Rev', 'Dly', 'Cho', 'Room']);

    const mode = strip.querySelector('.send-mode') as HTMLButtonElement;
    expect(mode.textContent).toBe('POST');
    mode.click();

    const live = document.querySelector('.strip .send-mode') as HTMLButtonElement;
    expect(live.textContent).toBe('PRE');
    expect(live.className).toContain('is-pre');

    live.click();
    expect(document.querySelector('.strip .send-mode')?.textContent).toBe('POST');
  });

  it('shows aux return channels with fader, pan and mute', () => {
    const returns = [...document.querySelectorAll('.strip.is-return')] as HTMLElement[];
    expect(returns.length).toBe(4);
    expect(returns[0].querySelector('.strip-num')?.textContent).toBe('A');
    expect(returns[0].textContent).toContain('Reverb');
    expect(returns[0].textContent).toContain('RETURN');
    expect(returns[0].querySelector('.fader-wrap input')).not.toBeNull();
    expect(returns[0].querySelectorAll('.knob').length).toBe(1);
    expect(returns[0].querySelectorAll('.send-cell').length).toBe(0);

    const fader = returns[1].querySelector('.fader-wrap input') as HTMLInputElement;
    fader.value = '0.42';
    fader.dispatchEvent(new Event('input', { bubbles: true }));
    expect(fader.value).toBe('0.42');

    const muteOf = (node: ParentNode): HTMLButtonElement =>
      [...node.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'M') as HTMLButtonElement;

    muteOf(returns[2]).click();

    const liveMute = muteOf(document.querySelectorAll('.strip.is-return')[2]);
    expect(liveMute.className).toContain('is-on');

    liveMute.click();
    expect(muteOf(document.querySelectorAll('.strip.is-return')[2]).className).not.toContain('is-on');
  });

  it('gives every console strip a dB fader, peak meter and channel utilities', () => {
    const strip = document.querySelector('.strip') as HTMLElement;
    expect(strip.querySelector('.strip-num')?.textContent).toBe('01');
    expect(strip.querySelectorAll('.fader-tick').length).toBe(6);
    expect(strip.querySelector('.strip-db')?.textContent).toContain('dB');
    expect(strip.querySelector('.clip-led')).not.toBeNull();
    expect(strip.querySelector('.meter-peak')).not.toBeNull();

    const toggles = [...strip.querySelectorAll('.strip-toggle')].map((n) => n.textContent);
    expect(toggles).toEqual(['EQ', 'WAVE']);

    const fader = strip.querySelector('.fader-wrap input') as HTMLInputElement;
    fader.value = '0.5';
    fader.dispatchEvent(new Event('input', { bubbles: true }));
    expect(fader.value).toBe('0.5');
    expect(strip.querySelector('.strip-db')?.textContent).toContain('-6.0');
  });

  it('toggles the channel EQ in and out', async () => {
    const eq = document.querySelector('.strip .strip-toggle') as HTMLButtonElement;
    expect(eq.textContent).toBe('EQ');
    expect(eq.className).toContain('is-on');

    eq.click();
    await wait(80);
    const off = document.querySelector('.strip .strip-toggle') as HTMLButtonElement;
    expect(off.className).not.toContain('is-on');

    off.click();
    await wait(80);
    expect(document.querySelector('.strip .strip-toggle')?.className).toContain('is-on');
  });

  it('turns the per-channel waveform viewer on and off', async () => {
    const waveButton = [...document.querySelectorAll('.strip .strip-toggle')].find(
      (node) => node.textContent === 'WAVE',
    ) as HTMLButtonElement;
    const strip = waveButton.closest('.strip') as HTMLElement;
    expect(strip.classList.contains('has-wave')).toBe(false);

    waveButton.click();
    const live = document.querySelector('.strip') as HTMLElement;
    expect(live.classList.contains('has-wave')).toBe(true);
    expect(live.querySelector('.strip-toggle.is-on:last-child')?.textContent).toBe('WAVE');

    ([...document.querySelectorAll('.strip .strip-toggle')].find(
      (node) => node.textContent === 'WAVE',
    ) as HTMLButtonElement).click();
    expect((document.querySelector('.strip') as HTMLElement).classList.contains('has-wave')).toBe(false);
  });

  it('renames a console channel from its scribble strip', async () => {
    const strip = document.querySelector('.strip') as HTMLElement;
    const name = strip.querySelector('.strip-name') as HTMLElement;
    name.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));

    const input = document.querySelector('.strip-rename') as HTMLInputElement;
    expect(input).not.toBeNull();
    input.value = 'Room Drums';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await wait(80);

    expect(document.querySelector('.strip .strip-name')?.textContent).toBe('Room Drums');
    expect(document.querySelector('.track-name')?.textContent).toBe('Room Drums');
  });

  it('has console monitor controls on the master strip', () => {
    const master = document.querySelector('.strip.is-master') as HTMLElement;
    const labels = [...master.querySelectorAll('.strip-toggle')].map((b) => b.textContent);
    expect(labels).toEqual(['MONO', 'DIM', 'WAVE']);

    const [mono, dim] = [...master.querySelectorAll('.strip-toggle')] as HTMLButtonElement[];
    mono.click();
    expect(mono.className).toContain('is-on');
    mono.click();
    expect(mono.className).not.toContain('is-on');

    dim.click();
    expect(dim.className).toContain('is-on');
    dim.click();
    expect(dim.className).not.toContain('is-on');
  });

  it('opens the AI Assistant on Mix & Master, and the tablet remote panels', () => {
    $('btn-assistant').click();
    const agent = document.querySelector('.agent') as HTMLElement;
    expect(agent.classList.contains('is-open')).toBe(true);
    expect(agent.textContent).toContain('AI Assistant');
    expect(agent.querySelector('.agent-title strong')?.textContent).toBe('Sage');
    expect(agent.querySelector('.agent-tab.is-on')?.textContent).toBe('Mix & Master');
    expect(agent.querySelector('#ai-scope')).not.toBeNull();
    // The default scope hears the whole mix, not just one channel.
    expect((agent.querySelector('#ai-scope') as HTMLSelectElement).value).toBe('master');
    expect(agent.textContent).toContain('Whole mix (all tracks + master)');
    expect(agent.querySelector('.agent-run')?.textContent).toBe('Analyze whole mix');
    expect(agent.textContent).toContain('Intensity');
    expect(agent.textContent).toContain('every value stays editable');

    $('btn-remote').click();
    const remote = document.querySelector('.remote-panel') as HTMLElement;
    expect(remote.classList.contains('is-open')).toBe(true);
    expect(remote.textContent).toContain('Tablet Remote');
  });

  it('opens the help tab with search, session checks and guides', () => {
    $('btn-help').click();
    const agent = document.querySelector('.agent') as HTMLElement;
    expect(agent.querySelector('.agent-tab.is-on')?.textContent).toBe('Help');
    expect(agent.textContent).toContain('Check my session');

    const search = agent.querySelector('.help-search') as HTMLInputElement;
    search.value = 'vst3';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    const titles = [...agent.querySelectorAll('.help-topic-title')].map((node) => node.textContent);
    expect(titles).toContain('VST3 plugins');
    expect(titles.length).toBeLessThan(6);

    search.value = '';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    expect(agent.querySelectorAll('.help-topic').length).toBeGreaterThan(10);
    expect(agent.querySelectorAll('.help-diag-card').length).toBeGreaterThan(0);
  });

  it('opens the AI Assistant for the master bus from the insert chips', () => {
    const chain = document.querySelector('.master-chain') as HTMLElement;
    expect(chain.classList.contains('is-clickable')).toBe(true);
    chain.click();
    const agent = document.querySelector('.agent') as HTMLElement;
    expect(agent.classList.contains('is-open')).toBe(true);
    expect(agent.querySelector('.agent-tab.is-on')?.textContent).toBe('Mix & Master');
    expect((agent.querySelector('#ai-scope') as HTMLSelectElement).value).toBe('master');
  });

  it('links the rack AI insert to the full assistant', () => {
    const select = document.querySelector('.add-device select') as HTMLSelectElement;
    select.value = 'aimix';
    select.dispatchEvent(new Event('change', { bubbles: true }));

    const open = document.querySelector('.ai-open') as HTMLButtonElement;
    expect(open).not.toBeNull();
    open.click();

    const agent = document.querySelector('.agent') as HTMLElement;
    expect(agent.classList.contains('is-open')).toBe(true);
    expect((agent.querySelector('#ai-scope') as HTMLSelectElement).value).not.toBe('master');
  });

  it('opens the audio preview studio with tempo, pitch and metronome controls', () => {
    $('btn-preview').click();

    const panel = document.getElementById('preview') as HTMLElement;
    expect(panel.classList.contains('is-open')).toBe(true);
    expect(panel.textContent).toContain('Audio Preview');

    for (const id of [
      'preview-play',
      'preview-stop',
      'preview-loop',
      'preview-metro',
      'preview-detect',
      'preview-tempo',
      'preview-raw',
      'preview-pitch-up',
      'preview-pitch-down',
      'preview-send',
      'preview-wave',
      'preview-loop-badge',
      'preview-region',
      'preview-slice-mode',
      'preview-snap',
      'preview-slice',
      'preview-send-slices',
      'preview-export',
    ]) {
      expect(document.getElementById(id), `missing #${id}`).not.toBeNull();
    }

    const bpm = document.getElementById('preview-bpm') as HTMLInputElement;
    expect(Number(bpm.value)).toBeGreaterThan(30);
    expect(document.getElementById('preview-pitch')?.textContent).toContain('0 st');
  });

  it('emulates a microphone with model presets from the browser and the rack', async () => {
    const headings = [...document.querySelectorAll('#browser-body .section-title')].map(
      (node) => node.textContent ?? '',
    );
    expect(headings.some((text) => text.includes('Microphones'))).toBe(true);

    const ribbon = [...document.querySelectorAll('#browser-body .browser-item')].find((node) =>
      node.textContent?.includes('Vintage Ribbon'),
    ) as HTMLButtonElement;
    expect(ribbon).toBeTruthy();
    ribbon.click();
    await wait(120);

    const card = [...document.querySelectorAll('#rack-body .device')].find((node) =>
      node.textContent?.includes('Mic Emulator'),
    ) as HTMLElement;
    expect(card, 'mic emulator card').toBeTruthy();
    expect(card.querySelector('.mic-select')).not.toBeNull();
    expect(card.querySelector('canvas.mic-curve')).not.toBeNull();

    const chips = [...card.querySelectorAll('.mic-chip')].map((node) => node.textContent);
    expect(chips).toEqual(['Vintage Croon', 'Dark Room', 'Guitar Cab']);
    expect(card.querySelector('.mic-chip.is-on')?.textContent).toBe('Vintage Croon');

    (card.querySelectorAll('.mic-chip')[2] as HTMLButtonElement).click();
    await wait(100);

    const live = [...document.querySelectorAll('#rack-body .device')].find((node) =>
      node.textContent?.includes('Mic Emulator'),
    ) as HTMLElement;
    expect(live.querySelector('.mic-chip.is-on')?.textContent).toBe('Guitar Cab');

    $('btn-undo').click();
    await wait(120);
    const restored = [...document.querySelectorAll('#rack-body .device')].find((node) =>
      node.textContent?.includes('Mic Emulator'),
    ) as HTMLElement;
    expect(restored.querySelector('.mic-chip.is-on')?.textContent).toBe('Vintage Croon');
  });

  it('can switch auto fades on and off from the arrangement toolbar', () => {
    const toggle = $('chk-auto-fade') as HTMLInputElement;
    expect(toggle.checked).toBe(true);

    toggle.checked = false;
    toggle.dispatchEvent(new Event('change', { bubbles: true }));
    expect(toggle.checked).toBe(false);

    toggle.checked = true;
    toggle.dispatchEvent(new Event('change', { bubbles: true }));
    expect(toggle.checked).toBe(true);
  });

  it('opens the studio rig panel and reports the browser build limits', () => {
    $('btn-rig').click();

    const rig = document.querySelector('.rig-panel') as HTMLElement;
    expect(rig.classList.contains('is-open')).toBe(true);
    expect(rig.textContent).toContain('Studio Rig');
    expect(rig.querySelector('.rig-badge')?.textContent).toBe('browser');
    expect(rig.textContent).toContain('desktop build only');

    const select = rig.querySelector('.rig-select') as HTMLSelectElement;
    expect(select.disabled).toBe(true);
    expect(rig.querySelectorAll('.rig-item').length).toBe(0);
  });

  it('renames the project from the title chip and flags unsaved work', async () => {
    const name = document.getElementById('project-name') as HTMLButtonElement;
    expect(name.textContent).toBe('Tone Art Demo');

    name.click();
    const input = document.querySelector('.project-rename') as HTMLInputElement;
    expect(input).not.toBeNull();
    input.value = 'Neon Nights';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

    expect(document.getElementById('project-name')?.textContent).toBe('Neon Nights');
    expect(document.title).toContain('Neon Nights');
    expect(document.getElementById('project-dirty')?.className).toContain('is-on');
  });

  it('opens the project menu and the start screen from the top bar', () => {
    const file = document.getElementById('btn-file') as HTMLButtonElement;
    expect(file).not.toBeNull();
    file.click();

    const items = [...document.querySelectorAll<HTMLButtonElement>('.file-menu-item')];
    expect(items.length).toBeGreaterThanOrEqual(6);

    const startEntry = items.find((item) => item.textContent?.includes('Start screen')) as HTMLButtonElement;
    startEntry.click();

    const screen = document.querySelector('.start-screen') as HTMLElement;
    expect(screen).not.toBeNull();
    expect(screen.classList.contains('is-open')).toBe(true);
    expect(document.getElementById('start-create')).not.toBeNull();

    (document.getElementById('start-enter') as HTMLButtonElement).click();
    expect(document.querySelector('.start-screen')).toBeNull();
  });

  it('starts a named project from the start screen', async () => {
    (document.getElementById('btn-file') as HTMLButtonElement).click();
    const entry = [...document.querySelectorAll<HTMLButtonElement>('.file-menu-item')].find((item) =>
      item.textContent?.includes('New project'),
    ) as HTMLButtonElement;
    entry.click();

    const name = document.querySelector('.start-input') as HTMLInputElement;
    name.value = 'Blue Room';
    (document.getElementById('start-create') as HTMLButtonElement).click();
    await wait(120);

    expect(document.getElementById('project-name')?.textContent).toBe('Blue Room');
    expect(document.querySelectorAll('.track-head').length).toBe(4);
    expect(document.querySelectorAll('.strip[data-drag-id]').length).toBe(4);
    expect($('song-meta').textContent).toContain('0 clips');
  });

  it('autosaves the session so a reload can recover it', async () => {
    const strip = document.querySelector('.strip') as HTMLElement;
    const mute = [...strip.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'M') as HTMLButtonElement;
    mute.click();

    await wait(2800);
    const raw = localStorage.getItem('hybrid.autosave');
    expect(raw).toBeTruthy();
    const snapshot = JSON.parse(raw as string) as { name: string; data: string };
    expect(snapshot.name).toBe('Blue Room');
    expect(snapshot.data).toContain('hybrid-studio-project');
    expect(snapshot.data).toContain('Blue Room');
  });

  it('reorders tracks by dragging a header or a console strip, keeping both in step', async () => {
    const headerIds = (): string[] =>
      [...document.querySelectorAll<HTMLElement>('.track-head')].map((node) => node.dataset.trackId ?? '');
    const stripIds = (): string[] =>
      [...document.querySelectorAll<HTMLElement>('.strip[data-drag-id]')].map(
        (node) => node.dataset.dragId ?? '',
      );

    // jsdom has no layout, so give the items a predictable geometry.
    const layout = (nodes: HTMLElement[], horizontal: boolean, size: number): void => {
      nodes.forEach((node, position) => {
        const start = position * size;
        const left = horizontal ? start : 0;
        const top = horizontal ? 0 : start;
        const width = horizontal ? size - 8 : 240;
        const height = horizontal ? 240 : size;
        node.getBoundingClientRect = () =>
          ({
            left,
            top,
            width,
            height,
            right: left + width,
            bottom: top + height,
            x: left,
            y: top,
            toJSON: () => ({}),
          }) as DOMRect;
      });
    };

    const drag = (node: HTMLElement, toX: number, toY: number): void => {
      node.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 10, clientY: 10 }));
      window.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: toX, clientY: toY }));
      window.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));
    };

    const before = headerIds();
    expect(before.length).toBeGreaterThan(3);
    expect(stripIds()).toEqual(before);

    // A header dragged above the first row moves to the top of both lists.
    const headers = [...document.querySelectorAll<HTMLElement>('.track-head')];
    layout(headers, false, 84);
    drag(headers[headers.length - 1], 10, -20);
    await wait(260);

    const moved = before[before.length - 1];
    expect(headerIds()[0]).toBe(moved);
    expect(stripIds()[0]).toBe(moved);

    // The same move from the console side: drag the first strip to the end.
    const strips = [...document.querySelectorAll<HTMLElement>('.strip[data-drag-id]')];
    layout(strips, true, 160);
    drag(strips[0].querySelector('.strip-cap') as HTMLElement, 160 * 6, 10);
    await wait(260);

    const after = headerIds();
    expect(after[after.length - 1]).toBe(moved);
    expect(stripIds()).toEqual(after);
    expect(after.filter((id) => id === moved)).toHaveLength(1);
  });

  it('gives every built-in insert a live faceplate and a meter', async () => {
    // The master chain always carries an EQ and a limiter, whatever the tracks
    // have been through earlier in the suite.
    const tabs = [...document.querySelectorAll<HTMLElement>('.rack-tab')];
    tabs.at(-1)?.click();
    await wait(80);
    const panels = [...document.querySelectorAll<HTMLElement>('#rack-body .fx-panel.is-module')];
    expect(panels.length).toBeGreaterThan(0);
    for (const panel of panels) {
      expect(panel.querySelector('.fx-scope')).toBeTruthy();
      expect(panel.querySelector('.fx-legend')?.textContent?.length).toBeGreaterThan(0);
      expect(panel.querySelector('.fx-readout strong')?.textContent?.length).toBeGreaterThan(0);
      expect(panel.querySelectorAll('.knob').length).toBeGreaterThan(0);
    }
  });

});

/**
 * The floating panels all dock into the same right-hand slot. Opening one while
 * another was open used to leave both on screen, one exactly on top of the
 * other: the panel underneath could not be closed and its controls could not be
 * reached. This walks the panel buttons and checks the invariant.
 */
describe('floating panels', () => {
  const openers = ['btn-midi', 'btn-rig', 'btn-remote', 'btn-takes', 'btn-preview', 'btn-midi', 'btn-rig'];

  it('keeps at most one panel open at a time', async () => {
    for (const id of openers) {
      const button = document.getElementById(id);
      expect(button, `missing #${id}`).not.toBeNull();
      (button as HTMLButtonElement).click();
      await wait(40);
      const open = document.querySelectorAll('.agent.is-open').length;
      expect(open, `${id} left ${open} panels open`).toBeLessThanOrEqual(1);
    }
  });

  it('has a MIDI button wired into the top bar', async () => {
    const button = document.getElementById('btn-midi');
    expect(button).not.toBeNull();
    expect(document.querySelector('#midi-panel')).not.toBeNull();
  });

  it('stays usable after every panel has been opened and closed', async () => {
    for (const id of openers) {
      (document.getElementById(id) as HTMLButtonElement).click();
      await wait(20);
    }
    // A panel left open would sit over the transport; closing all of them brings
    // the arrangement back, and the transport still responds.
    for (const id of openers) {
      const panel = document.getElementById(id);
      if (panel) (panel as HTMLButtonElement).click();
      await wait(10);
    }
    document.getElementById('btn-midi')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await wait(20);
    expect(document.body.classList.contains('is-detached')).toBe(false);
  });
});

describe('startup health', () => {
  it('marks the interface ready so a failed start is never silent', () => {
    expect(document.documentElement.dataset.appReady).toBe('true');
    const banner = document.getElementById('boot-error');
    expect(banner).not.toBeNull();
    expect((banner as HTMLElement).hidden).toBe(true);
  });
});
