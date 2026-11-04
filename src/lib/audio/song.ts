// Turns one bar of a track into scheduled notes. Pure scheduling: no timers and no live state.
import type { MapId } from '../game/types';
import { hat, kick, snare, tone } from './synth';
import { CHORD_ROOT_MIDI, CHORD_TONES, midiToFreq, noteToMidi, STEPS_PER_BAR, thirdBelow, TRACKS } from './tracks';
import type { Bar } from './tracks';

export type TrackName = 'lobby' | 'hunt';
export type Buses = { dry: AudioNode; send: AudioNode };

type LeadStyle = 'pulse' | 'chime' | 'reed';

/** How one map bends the same tune. Tropical's values leave the song as written. */
export type MapMusic = {
  transpose: number;
  /** Parallel minor: the tune keeps its shape and rhythm but its thirds and sixths go dark. */
  minor: boolean;
  lead: LeadStyle;
  swing: number;
  pluckedBass: boolean;
  /** Thins the drums, the arpeggio and the backing lines. */
  sparse: boolean;
  hatLevel: number;
};

export const MAP_MUSIC: Record<MapId, MapMusic> = {
  tropical: { transpose: 0, minor: false, lead: 'pulse', swing: 0, pluckedBass: false, sparse: false, hatLevel: 1 },
  snowy: { transpose: 5, minor: false, lead: 'chime', swing: 0, pluckedBass: false, sparse: true, hatLevel: 0.5 },
  desert: { transpose: -2, minor: true, lead: 'reed', swing: 0.24, pluckedBass: true, sparse: false, hatLevel: 0.8 },
};

type HuntLevel = {
  tempo: number;
  lift: number;
  leadVolume: number;
  harmony: boolean;
  octave: boolean;
  arpeggio: boolean;
  kicks: number[];
  snares: number[];
  hats: number[];
  fill: boolean;
};

const BASS_STEPS = [
  { step: 0, offset: 0 },
  { step: 3, offset: 0 },
  { step: 6, offset: 7 },
  { step: 8, offset: 12 },
  { step: 11, offset: 0 },
  { step: 14, offset: 7 },
];

const everyNth = (n: number) => Array.from({ length: STEPS_PER_BAR / n }, (_, i) => i * n);

/** Index is the music intensity, which steps up with each clue. */
export const HUNT_LEVELS: HuntLevel[] = [
  { tempo: 1, lift: 0, leadVolume: 0.13, harmony: false, octave: false, arpeggio: false, kicks: [0, 8], snares: [], hats: everyNth(4), fill: false },
  { tempo: 1, lift: 0, leadVolume: 0.13, harmony: false, octave: false, arpeggio: false, kicks: [0, 8], snares: [12], hats: everyNth(4), fill: false },
  { tempo: 1, lift: 0, leadVolume: 0.17, harmony: true, octave: false, arpeggio: true, kicks: [0, 6, 8], snares: [4, 12], hats: everyNth(2), fill: true },
  { tempo: 1.1, lift: 2, leadVolume: 0.17, harmony: true, octave: true, arpeggio: true, kicks: [0, 3, 6, 8, 11], snares: [4, 12], hats: everyNth(1), fill: true },
];

function clampIntensity(intensity: number): number {
  return Math.max(0, Math.min(HUNT_LEVELS.length - 1, Math.round(intensity) || 0));
}

/** Only the top level, the last clue, lifts the tempo. */
export function stepSeconds(name: TrackName, intensity: number): number {
  const bpm = TRACKS[name].bpm * (name === 'hunt' ? HUNT_LEVELS[clampIntensity(intensity)].tempo : 1);
  return 60 / bpm / 4;
}

const MINOR_FLATS = new Set([4, 9, 11]);

function bendPitch(midi: number, map: MapMusic): number {
  return (map.minor && MINOR_FLATS.has(midi % 12) ? midi - 1 : midi) + map.transpose;
}

/** Every odd sixteenth arrives late. The track's own swing is the floor. */
function stepClock(start: number, s: number, swing: number) {
  return (step: number) => start + step * s + (step % 2 === 1 ? s * swing : 0);
}

function everyOther(steps: number[]): number[] {
  return steps.filter((_, i) => i % 2 === 0);
}

function chordAt(bar: Bar, step: number): string {
  return bar.chords.length === 2 && step >= STEPS_PER_BAR / 2 ? bar.chords[1] : bar.chords[0];
}

function chordNotes(chord: string, octaveBase: number): number[] {
  const root = CHORD_ROOT_MIDI[chord];
  const rootClass = root % 12;
  const notes = CHORD_TONES[chord].map((name) => {
    const index = noteToMidi(`${name}4`) % 12;
    return octaveBase + ((index - rootClass + 12) % 12) + rootClass;
  });
  return [...notes, notes[0] + 12];
}

export function scheduleBar(ac: BaseAudioContext, buses: Buses, name: TrackName, barIndex: number, intensity: number, start: number, map: MapMusic = MAP_MUSIC.tropical): number {
  return name === 'lobby'
    ? scheduleLobby(ac, buses, barIndex, start, map)
    : scheduleHunt(ac, buses, barIndex, intensity, start, map);
}

function altLead(ac: BaseAudioContext, { dry, send }: Buses, style: LeadStyle, t: number, f: number, d: number, volume: number) {
  if (style === 'chime') {
    tone(ac, dry, t, f, d, volume, { type: 'sine', sustain: 0.3 });
    tone(ac, dry, t, f * 2, d * 0.6, volume * 0.22, { type: 'sine', sustain: 0.2 });
    tone(ac, dry, t, f * 3, Math.min(d, 0.08), volume * 0.12, { type: 'sine', sustain: 0.2 });
    tone(ac, send, t, f, d, volume * 0.4, { type: 'sine', sustain: 0.3 });
  } else {
    tone(ac, dry, t, f, d, volume * 0.9, { duty: 0.5, vibrato: true, sustain: 0.55 });
    tone(ac, send, t, f, d, volume * 0.4, { duty: 0.25 });
  }
}

function playBass(ac: BaseAudioContext, dry: AudioNode, t: number, f: number, roundLength: number, volume: number, map: MapMusic) {
  if (map.pluckedBass) {
    tone(ac, dry, t, f, Math.min(roundLength, 0.2), volume * 0.92, { type: 'triangle', sustain: 0.25 });
    tone(ac, dry, t, f * 2, 0.06, volume * 0.25, { duty: 0.5, sustain: 0.2 });
  } else {
    tone(ac, dry, t, f, roundLength, volume, { type: 'triangle', sustain: 0.8 });
  }
}

function scheduleLobby(ac: BaseAudioContext, buses: Buses, barIndex: number, start: number, map: MapMusic): number {
  const { dry, send } = buses;
  const track = TRACKS.lobby;
  const bar = track.bars[barIndex % track.bars.length];
  const s = stepSeconds('lobby', 0);
  const at = stepClock(start, s, Math.max(track.swing, map.swing));

  for (const n of bar.lead) {
    const f = midiToFreq(bendPitch(noteToMidi(n.note), map));
    const d = n.length * s * 0.95;
    if (map.lead === 'pulse') {
      tone(ac, dry, at(n.step), f, d, 0.22, { type: 'triangle', vibrato: true, sustain: 0.75 });
      tone(ac, send, at(n.step), f, d, 0.09, { duty: 0.5 });
    } else {
      altLead(ac, buses, map.lead, at(n.step), f, d, 0.2);
    }
  }

  for (let step = 0; step < STEPS_PER_BAR; step += map.sparse ? 4 : 2) {
    const notes = chordNotes(chordAt(bar, step), 60);
    const midi = bendPitch(notes[[0, 2, 1, 2, 3, 2, 1, 2][step / 2]], map);
    tone(ac, dry, at(step), midiToFreq(midi), s * 1.6, 0.045, { duty: 0.125 });
    tone(ac, send, at(step), midiToFreq(midi), s * 1.6, 0.03, { duty: 0.125 });
  }

  for (const step of [0, 6, 8, 14]) {
    const chord = chordAt(bar, step);
    const root = CHORD_ROOT_MIDI[chord];
    const midi = bendPitch(step === 6 || step === 14 ? root + 7 : root, map);
    playBass(ac, dry, at(step), midiToFreq(midi), s * 3.5, 0.24, map);
  }

  for (const step of map.sparse ? everyOther([2, 6, 10, 14]) : [2, 6, 10, 14]) hat(ac, dry, at(step), 0.022 * map.hatLevel);
  kick(ac, dry, at(0), 0.16);
  kick(ac, dry, at(8), 0.1);

  return s * STEPS_PER_BAR;
}

function scheduleHunt(ac: BaseAudioContext, buses: Buses, barIndex: number, intensity: number, start: number, map: MapMusic): number {
  const { dry, send } = buses;
  const track = TRACKS.hunt;
  const bar = track.bars[barIndex % track.bars.length];
  const s = stepSeconds('hunt', intensity);
  const levelIndex = clampIntensity(intensity);
  const level = HUNT_LEVELS[levelIndex];
  const pitch = (midi: number) => bendPitch(midi, map) + level.lift;
  const at = stepClock(start, s, Math.max(track.swing, map.swing));
  const breakdown = bar.section === 'C';

  for (const n of bar.lead) {
    const written = noteToMidi(n.note);
    const f = midiToFreq(pitch(written));
    const d = n.length * s * 0.92;
    const volume = breakdown ? 0.15 : level.leadVolume;
    if (map.lead === 'pulse') {
      tone(ac, dry, at(n.step), f, d, volume, { duty: breakdown ? 0.5 : 0.25, vibrato: true });
      tone(ac, send, at(n.step), f, d, volume * 0.5, { duty: 0.25 });
    } else {
      altLead(ac, buses, map.lead, at(n.step), f, d, volume);
    }
    if (bar.section === 'A2' && level.harmony && !map.sparse) {
      tone(ac, dry, at(n.step), midiToFreq(pitch(thirdBelow(written))), d, volume * 0.5, { duty: 0.125 });
    }
    if (level.octave && !breakdown && !map.sparse) {
      tone(ac, send, at(n.step), f * 2, d, volume * 0.22, { duty: 0.5 });
    }
  }

  for (const { step, offset } of map.sparse ? BASS_STEPS.filter((b) => b.step % 2 === 0) : BASS_STEPS) {
    const midi = pitch(CHORD_ROOT_MIDI[chordAt(bar, step)] + offset);
    playBass(ac, dry, at(step), midiToFreq(midi), s * 2.2, 0.26, map);
  }

  if (level.arpeggio || breakdown) {
    const pattern = [0, 1, 2, 3, 2, 1];
    for (let step = 0; step < STEPS_PER_BAR; step += map.sparse ? 2 : 1) {
      const notes = chordNotes(chordAt(bar, step), 72);
      const midi = pitch(notes[pattern[step % pattern.length]]);
      tone(ac, breakdown ? send : dry, at(step), midiToFreq(midi), s * 0.8, breakdown ? 0.07 : 0.035, { duty: 0.125 });
    }
  }

  // The breakdown holds the drums back, so the top level drops one step there.
  scheduleHuntDrums(ac, dry, barIndex, HUNT_LEVELS[breakdown ? Math.min(levelIndex, 2) : levelIndex], map, at);
  return s * STEPS_PER_BAR;
}

function scheduleHuntDrums(ac: BaseAudioContext, dry: AudioNode, barIndex: number, level: HuntLevel, map: MapMusic, at: (step: number) => number) {
  const kicks = map.sparse ? level.kicks.filter((step) => step % 8 === 0) : level.kicks;
  const snares = map.sparse ? level.snares.filter((step) => step === 12) : level.snares;
  const hats = map.sparse ? everyOther(level.hats) : level.hats;

  for (const step of kicks) kick(ac, dry, at(step), 0.3);
  for (const step of snares) snare(ac, dry, at(step), 0.14);
  for (const step of hats) hat(ac, dry, at(step), (step % 4 === 2 ? 0.05 : 0.03) * map.hatLevel);
  if (level.fill && !map.sparse && barIndex % 8 === 7) {
    for (const step of [13, 14, 15]) snare(ac, dry, at(step), 0.1);
  }
}
