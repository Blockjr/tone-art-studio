/**
 * Instant session checks behind the help agent's “Check my session”.
 *
 * These are static inspections of the project: no rendering, no audio, so the
 * list is ready the moment the panel opens. Anything that needs real audio is
 * the AI Mix & Master analysis instead.
 */

import { createDevice } from '../core/project';
import type { DeviceState, Project } from '../core/types';

export type DiagnosisSeverity = 'fix' | 'warn' | 'info';

export interface Diagnosis {
  id: string;
  severity: DiagnosisSeverity;
  title: string;
  detail: string;
  fixLabel?: string;
  /** Repairs the issue in place; called inside a store.edit() undo step. */
  fix?: (project: Project) => void;
}

function hasDevice(devices: DeviceState[], type: DeviceState['type']): boolean {
  return devices.some((device) => device.type === type && device.enabled);
}

export function diagnoseProject(project: Project, selectedTrackId: string): Diagnosis[] {
  const found: Diagnosis[] = [];

  if (!project.tracks.length) {
    found.push({
      id: 'no-tracks',
      severity: 'info',
      title: 'This session has no tracks',
      detail: 'Open the start screen and create a project, or load the demo session, then come back here.',
    });
  }

  const muted = project.tracks.filter((track) => track.mute);
  if (muted.length) {
    found.push({
      id: 'muted',
      severity: 'warn',
      title: `${muted.length} track${muted.length === 1 ? '' : 's'} muted`,
      detail: `Muted: ${muted.map((track) => track.name).join(', ')}. If the mix sounds thin or silent, start here.`,
      fixLabel: 'Unmute all',
      fix: (scope) => {
        for (const track of scope.tracks) track.mute = false;
      },
    });
  }

  const soloed = project.tracks.filter((track) => track.solo);
  if (soloed.length) {
    found.push({
      id: 'solo',
      severity: 'warn',
      title: `${soloed.length} track${soloed.length === 1 ? '' : 's'} soloed`,
      detail: `Soloed: ${soloed.map((track) => track.name).join(', ')}. Everything else is muted while solo is on.`,
      fixLabel: 'Clear solo',
      fix: (scope) => {
        for (const track of scope.tracks) track.solo = false;
      },
    });
  }

  if (!hasDevice(project.master.devices, 'limiter')) {
    found.push({
      id: 'no-limiter',
      severity: 'fix',
      title: 'No limiter on the master',
      detail: 'Nothing is catching peaks above full scale right now. A limiter at −1 dB is the standard safety net before export.',
      fixLabel: 'Add limiter at −1 dB',
      fix: (scope) => {
        const device = createDevice('limiter');
        device.params = { ...device.params, ceiling: -1, release: 0.12, gain: 0 };
        scope.master.devices.push(device);
      },
    });
  }

  if (!hasDevice(project.master.devices, 'compressor') && project.tracks.length > 2) {
    found.push({
      id: 'no-glue',
      severity: 'info',
      title: 'No glue compression on the master',
      detail: 'A slow 2:1 compressor over the whole mix holds the tracks together before limiting. Optional, but it is what most finished mixes have.',
      fixLabel: 'Add 2:1 glue',
      fix: (scope) => {
        const device = createDevice('compressor');
        device.params = { ...device.params, threshold: -20, ratio: 2, attack: 0.03, release: 0.3, makeup: 0 };
        scope.master.devices.push(device);
      },
    });
  }

  if (project.master.volume > 1.02) {
    found.push({
      id: 'master-hot',
      severity: 'warn',
      title: 'Master fader is above unity',
      detail: `The master fader sits at ${project.master.volume.toFixed(2)}. Boosting the whole mix before the limiter is how clipping starts; a trim of the loudest tracks is usually cleaner.`,
      fixLabel: 'Set master to 1.00',
      fix: (scope) => {
        scope.master.volume = 1;
      },
    });
  }

  const hotTrim = project.tracks.filter((track) => track.gain > 12);
  if (hotTrim.length) {
    found.push({
      id: 'hot-trim',
      severity: 'warn',
      title: `${hotTrim.length} track${hotTrim.length === 1 ? '' : 's'} with heavy input trim`,
      detail: `${hotTrim.map((track) => `${track.name} (${track.gain.toFixed(1)} dB)`).join(', ')}. Large trim values push inserts hard; check whether the fader is the better place.`,
    });
  }

  const noHighPass = project.tracks.filter((track) => track.eq.hp < 20);
  if (noHighPass.length) {
    found.push({
      id: 'no-highpass',
      severity: 'info',
      title: `${noHighPass.length} track${noHighPass.length === 1 ? '' : 's'} without a high-pass`,
      detail: 'Rumble below 20 Hz eats headroom and never reaches the listener. A high-pass at 30 Hz on most tracks, higher on keys and vocals, buys back level.',
      fixLabel: 'High-pass at 30 Hz',
      fix: (scope) => {
        for (const track of scope.tracks) {
          if (track.eq.hp < 20) track.eq.hp = 30;
        }
      },
    });
  }

  const emptyAudio = project.tracks.filter(
    (track) => track.kind === 'audio' && !project.clips.some((clip) => clip.trackId === track.id),
  );
  if (emptyAudio.length) {
    found.push({
      id: 'empty-audio',
      severity: 'info',
      title: `${emptyAudio.length} audio track${emptyAudio.length === 1 ? '' : 's'} with no clips`,
      detail: `${emptyAudio.map((track) => track.name).join(', ')} will render silence. Import a file onto the track or delete it.`,
    });
  }

  const selected = project.tracks.find((track) => track.id === selectedTrackId);
  if (selected && selected.devices.length === 0) {
    found.push({
      id: 'bare-track',
      severity: 'info',
      title: `“${selected.name}” has no inserts`,
      detail: 'A high-pass, a compressor or the AI Mix & Master insert are the usual next steps for a bare channel.',
    });
  }

  if (project.clips.length === 0 && project.tracks.length) {
    found.push({
      id: 'no-clips',
      severity: 'info',
      title: 'The arrangement is empty',
      detail: 'There are tracks but no clips, so playback and export will be silent. Draw or import something first.',
    });
  }

  if (!found.length) {
    found.push({
      id: 'clean',
      severity: 'info',
      title: 'No structural problems found',
      detail: 'Mutes, solos, the master chain and track trims all look sane. For tonal balance and loudness, run the AI Mix & Master analysis.',
    });
  }

  const order: Record<DiagnosisSeverity, number> = { fix: 0, warn: 1, info: 2 };
  return found.sort((a, b) => order[a.severity] - order[b.severity]);
}
