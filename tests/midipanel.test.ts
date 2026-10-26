// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import type { Engine } from '../src/audio/engine';
import { blankProject } from '../src/core/project';
import { Store } from '../src/core/store';
import { MidiPanel } from '../src/ui/midi';

/**
 * The MIDI panel's behaviour, without an audio device.
 *
 * The panel is the only place a player sets a controller up, so what matters
 * here is that a key press reaches the engine, that the octave changes the
 * pitch it reaches with, and that MIDI effects are attached to the track the
 * user is looking at.
 */

interface Played {
  trackId: string;
  pitch: number;
  velocity: number;
}

function fakeEngine(played: Played[]): Engine {
  return {
    liveNote: async (trackId: string, pitch: number, velocity: number) => {
      played.push({ trackId, pitch, velocity });
    },
  } as unknown as Engine;
}

function build() {
  const project = blankProject('MIDI test');
  const store = new Store(project);
  const midiTrack = project.tracks.find((track) => track.kind === 'midi');
  if (!midiTrack) throw new Error('blankProject has no MIDI track');
  store.selectedTrackId = midiTrack.id;

  const played: Played[] = [];
  const toasts: string[] = [];
  const panel = new MidiPanel(store, fakeEngine(played), { toast: (message) => toasts.push(message) });
  panel.mount();
  return { store, project, midiTrack, played, toasts, panel };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  document.body.innerHTML = '';
  localStorage.clear();
});

describe('MIDI panel', () => {
  it('mounts closed and opens on demand', () => {
    const { panel } = build();
    const root = document.querySelector('#midi-panel');
    expect(root).not.toBeNull();
    expect(panel.visible).toBe(false);

    panel.toggle();
    expect(panel.visible).toBe(true);
    expect(root?.classList.contains('is-open')).toBe(true);

    panel.close();
    expect(panel.visible).toBe(false);
  });

  it('plays a note on the selected MIDI track', async () => {
    const { panel, played, midiTrack } = build();
    panel.openPanel();

    expect(panel.handleKey('a', true, false)).toBe(true);
    await flush();

    expect(played).toHaveLength(1);
    expect(played[0].trackId).toBe(midiTrack.id);
    // Octave 3 starts at C3 = 48.
    expect(played[0].pitch).toBe(48);
  });

  it('leaves keys that are not notes alone', () => {
    const { panel } = build();
    panel.openPanel();
    expect(panel.handleKey('1', true, false)).toBe(false);
    expect(panel.handleKey('Enter', true, false)).toBe(false);
  });

  it('does not retrigger a key that is already held', async () => {
    const { panel, played } = build();
    panel.openPanel();

    panel.handleKey('a', true, false);
    panel.handleKey('a', true, true); // auto-repeat
    panel.handleKey('a', false, false);
    await flush();

    expect(played).toHaveLength(1);
  });

  it('octave keys transpose what is played', async () => {
    const { panel, played } = build();
    panel.openPanel();

    expect(panel.handleKey('x', true, false)).toBe(true);
    panel.handleKey('a', true, false);
    await flush();
    expect(played[0].pitch).toBe(60);

    panel.handleKey('z', true, false);
    panel.handleKey('z', true, false);
    panel.handleKey('s', true, false);
    await flush();
    expect(played[1].pitch).toBe(38);
  });

  it('velocity keys change how hard the note hits', async () => {
    const { panel, played } = build();
    panel.openPanel();

    panel.handleKey('c', true, false);
    panel.handleKey('a', true, false);
    await flush();

    expect(played[0].velocity).toBeCloseTo(0.7, 5);
  });

  it('adds a MIDI effect to the selected track and renders it', () => {
    const { panel, store, midiTrack, toasts } = build();
    panel.openPanel();

    const picker = document.querySelector('#midi-panel select') as HTMLSelectElement;
    picker.value = 'chord';
    const add = [...document.querySelectorAll('#midi-panel button')].find(
      (button) => button.textContent === 'Add MIDI effect',
    ) as HTMLButtonElement;
    add.click();

    const track = store.project.tracks.find((entry) => entry.id === midiTrack.id);
    expect(track?.midiFx).toHaveLength(1);
    expect(track?.midiFx?.[0].type).toBe('chord');
    expect(document.querySelectorAll('#midi-panel .midi-fx')).toHaveLength(1);
    expect(toasts.at(-1)).toBe('Added Chord');
  });

  it('keeps the slider alive while it is dragged', () => {
    const { panel } = build();
    panel.openPanel();

    const picker = document.querySelector('#midi-panel select') as HTMLSelectElement;
    picker.value = 'chord';
    ([...document.querySelectorAll('#midi-panel button')].find(
      (button) => button.textContent === 'Add MIDI effect',
    ) as HTMLButtonElement).click();

    const slider = document.querySelector('#midi-panel .midi-fx-slider') as HTMLInputElement;
    slider.value = '7';
    slider.dispatchEvent(new Event('input', { bubbles: true }));

    // The card must not be rebuilt under the pointer: a new element would end
    // the drag on the first movement.
    expect(slider.isConnected).toBe(true);
    expect(document.querySelector('#midi-panel .midi-fx-slider')).toBe(slider);
    expect(document.querySelector('#midi-panel .midi-fx-name span')?.textContent).toContain('+7');
  });

  it('removes a MIDI effect again', () => {
    const { panel, store, midiTrack } = build();
    panel.openPanel();

    const picker = document.querySelector('#midi-panel select') as HTMLSelectElement;
    picker.value = 'scale';
    ([...document.querySelectorAll('#midi-panel button')].find(
      (button) => button.textContent === 'Add MIDI effect',
    ) as HTMLButtonElement).click();

    const remove = document.querySelector('#midi-panel .midi-fx-remove') as HTMLButtonElement;
    remove.click();

    const track = store.project.tracks.find((entry) => entry.id === midiTrack.id);
    expect(track?.midiFx).toHaveLength(0);
  });

  it('keeps MIDI effects off audio tracks', () => {
    const { panel, store, toasts } = build();
    const audioTrack = store.project.tracks.find((track) => track.kind === 'audio');
    if (!audioTrack) throw new Error('blankProject has no audio track');
    store.selectedTrackId = audioTrack.id;
    panel.openPanel();

    const picker = document.querySelector('#midi-panel select') as HTMLSelectElement;
    picker.value = 'arp';
    ([...document.querySelectorAll('#midi-panel button')].find(
      (button) => button.textContent === 'Add MIDI effect',
    ) as HTMLButtonElement).click();

    expect(audioTrack.midiFx).toBeUndefined();
    expect(toasts.at(-1)).toBe('MIDI effects belong on a MIDI track.');
  });

  it('explains the computer keyboard layout', () => {
    build();
    const text = document.querySelector('#midi-panel .agent-suggestion-detail')?.textContent ?? '';
    expect(text).toContain('white keys');
    expect(text).toContain('Octave down is Z');
  });
});
