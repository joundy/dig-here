// Turns one bar of a track into scheduled notes. Pure scheduling: no timers and no live state.
import { hat, kick, snare, tone } from './synth';
import { CHORD_ROOT_MIDI, CHORD_TONES, midiToFreq, noteToMidi, STEPS_PER_BAR, thirdBelow, TRACKS } from './tracks';
import type { Bar } from './tracks';

export type TrackName = 'lobby' | 'hunt';
export type Buses = { dry: AudioNode; send: AudioNode };

/** Intensity follows the clues. The last clue also lifts the key and the tempo. */
export function stepSeconds(name: TrackName, intensity: number): number {
  const bpm = TRACKS[name].bpm * (name === 'hunt' && intensity >= 2 ? 1.1 : 1);
  return 60 / bpm / 4;
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

export function scheduleBar(ac: BaseAudioContext, buses: Buses, name: TrackName, barIndex: number, intensity: number, start: number): number {
  return name === 'lobby'
    ? scheduleLobby(ac, buses, barIndex, start)
    : scheduleHunt(ac, buses, barIndex, intensity, start);
}

function scheduleLobby(ac: BaseAudioContext, { dry, send }: Buses, barIndex: number, start: number): number {
  const track = TRACKS.lobby;
  const bar = track.bars[barIndex % track.bars.length];
  const s = stepSeconds('lobby', 0);
  const at = (step: number) => start + step * s + (step % 2 === 1 ? s * track.swing : 0);

  for (const n of bar.lead) {
    const f = midiToFreq(noteToMidi(n.note));
    const d = n.length * s * 0.95;
    tone(ac, dry, at(n.step), f, d, 0.22, { type: 'triangle', vibrato: true, sustain: 0.75 });
    tone(ac, send, at(n.step), f, d, 0.09, { duty: 0.5 });
  }

  for (let step = 0; step < STEPS_PER_BAR; step += 2) {
    const notes = chordNotes(chordAt(bar, step), 60);
    const midi = notes[[0, 2, 1, 2, 3, 2, 1, 2][step / 2]];
    tone(ac, dry, at(step), midiToFreq(midi), s * 1.6, 0.045, { duty: 0.125 });
    tone(ac, send, at(step), midiToFreq(midi), s * 1.6, 0.03, { duty: 0.125 });
  }

  for (const step of [0, 6, 8, 14]) {
    const chord = chordAt(bar, step);
    const root = CHORD_ROOT_MIDI[chord];
    const midi = step === 6 || step === 14 ? root + 7 : root;
    tone(ac, dry, at(step), midiToFreq(midi), s * 3.5, 0.24, { type: 'triangle', sustain: 0.8 });
  }

  for (const step of [2, 6, 10, 14]) hat(ac, dry, at(step), 0.022);
  kick(ac, dry, at(0), 0.16);
  kick(ac, dry, at(8), 0.1);

  return s * STEPS_PER_BAR;
}

const BASS_STEPS = [
  { step: 0, offset: 0 },
  { step: 3, offset: 0 },
  { step: 6, offset: 7 },
  { step: 8, offset: 12 },
  { step: 11, offset: 0 },
  { step: 14, offset: 7 },
];

function scheduleHunt(ac: BaseAudioContext, { dry, send }: Buses, barIndex: number, intensity: number, start: number): number {
  const track = TRACKS.hunt;
  const bar = track.bars[barIndex % track.bars.length];
  const s = stepSeconds('hunt', intensity);
  const lift = intensity >= 2 ? 2 : 0;
  const at = (step: number) => start + step * s;
  const breakdown = bar.section === 'C';

  for (const n of bar.lead) {
    const midi = noteToMidi(n.note) + lift;
    const f = midiToFreq(midi);
    const d = n.length * s * 0.92;
    const volume = breakdown ? 0.15 : intensity === 0 ? 0.13 : 0.17;
    tone(ac, dry, at(n.step), f, d, volume, { duty: breakdown ? 0.5 : 0.25, vibrato: true });
    tone(ac, send, at(n.step), f, d, volume * 0.5, { duty: 0.25 });
    if (bar.section === 'A2' && intensity >= 1) {
      tone(ac, dry, at(n.step), midiToFreq(thirdBelow(midi - lift) + lift), d, volume * 0.5, { duty: 0.125 });
    }
    if (intensity >= 2 && !breakdown) {
      tone(ac, send, at(n.step), f * 2, d, volume * 0.22, { duty: 0.5 });
    }
  }

  for (const { step, offset } of BASS_STEPS) {
    const midi = CHORD_ROOT_MIDI[chordAt(bar, step)] + offset + lift;
    tone(ac, dry, at(step), midiToFreq(midi), s * 2.2, 0.26, { type: 'triangle', sustain: 0.8 });
  }

  if (intensity >= 1 || breakdown) {
    const pattern = [0, 1, 2, 3, 2, 1];
    for (let step = 0; step < STEPS_PER_BAR; step++) {
      const notes = chordNotes(chordAt(bar, step), 72);
      const midi = notes[pattern[step % pattern.length]] + lift;
      tone(ac, breakdown ? send : dry, at(step), midiToFreq(midi), s * 0.8, breakdown ? 0.07 : 0.035, { duty: 0.125 });
    }
  }

  scheduleHuntDrums(ac, dry, barIndex, intensity, breakdown, at);
  return s * STEPS_PER_BAR;
}

function scheduleHuntDrums(ac: BaseAudioContext, dry: AudioNode, barIndex: number, intensity: number, breakdown: boolean, at: (step: number) => number) {
  const level = breakdown ? Math.min(intensity, 1) : intensity;
  const kicks = level === 0 ? [0, 8] : level === 1 ? [0, 6, 8] : [0, 3, 6, 8, 11];
  const snares = level === 0 ? [] : [4, 12];
  const hatEvery = level === 0 ? 4 : level === 1 ? 2 : 1;

  for (const step of kicks) kick(ac, dry, at(step), 0.3);
  for (const step of snares) snare(ac, dry, at(step), 0.14);
  for (let step = 0; step < STEPS_PER_BAR; step += hatEvery) {
    hat(ac, dry, at(step), step % 4 === 2 ? 0.05 : 0.03);
  }
  if (level >= 1 && barIndex % 8 === 7) {
    for (const step of [13, 14, 15]) snare(ac, dry, at(step), 0.1);
  }
}
