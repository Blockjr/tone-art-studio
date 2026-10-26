// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { Engine } from '../src/audio/engine';
import { emptyProject } from '../src/core/project';
import { Store } from '../src/core/store';

/**
 * A console window has no sound card of its own — the studio window has it — so
 * its transport is a message, and the transport it draws is the studio's. This
 * is what keeps a detached mixer from playing a second, silent copy of the song
 * over the one already coming out of the speakers.
 */
function consoleEngine(): { engine: Engine; delegate: Record<string, ReturnType<typeof vi.fn>> } {
  const engine = new Engine(new Store(emptyProject()));
  const delegate = {
    play: vi.fn(),
    pause: vi.fn(),
    stop: vi.fn(),
    seek: vi.fn(),
  };
  engine.setTransportDelegate(delegate);
  return { engine, delegate };
}

describe('a console window follows the studio transport', () => {
  it('sends every transport command to the window that owns the audio device', async () => {
    const { engine, delegate } = consoleEngine();

    await engine.play(4);
    engine.pause();
    engine.stop();
    engine.seek(12);
    engine.locate(8);
    engine.togglePlay();

    expect(delegate.play).toHaveBeenCalledWith(4);
    expect(delegate.pause).toHaveBeenCalledTimes(1);
    expect(delegate.stop).toHaveBeenCalledTimes(1);
    expect(delegate.seek).toHaveBeenCalledWith(12);
    // Locating a parked playhead is the one command a console can answer alone:
    // it moves the marker it draws and tells the studio where it went.
    expect(delegate.seek).toHaveBeenCalledWith(8);
    // The toggle follows the mirrored state, which is still stopped, so it is
    // the second play command and no pause.
    expect(delegate.play).toHaveBeenCalledTimes(2);
    expect(delegate.pause).toHaveBeenCalledTimes(1);
  });

  it('never starts an audio context of its own', async () => {
    const { engine } = consoleEngine();
    await engine.play();
    engine.seek(2);

    expect(engine.context).toBeNull();
    expect(engine.isPlaying).toBe(false);
    expect(engine.isConsole).toBe(true);
  });

  it('shows the studio position and play state', () => {
    const { engine } = consoleEngine();

    engine.mirrorTransport(true, 16.5);
    expect(engine.isPlaying).toBe(true);
    expect(engine.positionBeat).toBe(16.5);

    engine.mirrorTransport(true, 20);
    expect(engine.positionBeat).toBe(20);

    engine.mirrorTransport(false, 20);
    expect(engine.isPlaying).toBe(false);
    expect(engine.positionBeat).toBe(20);
  });

  it('pauses the studio when the toggle is pressed while it is rolling', () => {
    const { engine, delegate } = consoleEngine();
    engine.mirrorTransport(true, 8);

    engine.togglePlay();

    expect(delegate.pause).toHaveBeenCalledTimes(1);
    expect(delegate.play).not.toHaveBeenCalled();
  });

  it('draws the studio meters instead of its own, which are silent', () => {
    const { engine } = consoleEngine();

    // With no audio running here every meter reads zero, which on a detached
    // console looks like a broken mixer rather than a silent one.
    expect(engine.trackPeak('track-1')).toBe(0);
    expect(engine.masterPeak()).toBe(0);

    engine.setMirroredLevels(
      new Map([
        ['track:track-1', 0.4],
        ['return:0', 0.2],
        ['master', 0.9],
      ]),
    );

    expect(engine.trackPeak('track-1')).toBe(0.4);
    expect(engine.returnPeak(0)).toBe(0.2);
    expect(engine.masterPeak()).toBe(0.9);
    // A track the studio did not report is silent, not stale.
    expect(engine.trackPeak('track-2')).toBe(0);

    engine.setMirroredLevels(null);
    expect(engine.masterPeak()).toBe(0);
  });

  it('leaves the studio window alone', () => {
    const engine = new Engine(new Store(emptyProject()));

    expect(engine.isConsole).toBe(false);
    engine.mirrorTransport(true, 30);
    // A studio window that took its transport from a link would never play.
    expect(engine.isPlaying).toBe(false);

    engine.setTransportDelegate({
      play: vi.fn(),
      pause: vi.fn(),
      stop: vi.fn(),
      seek: vi.fn(),
    });
    engine.setTransportDelegate(null);
    expect(engine.isConsole).toBe(false);
  });
});
