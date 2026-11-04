// Original chiptune written for this game. Each melody token is NOTE:sixteenths, or r:sixteenths.

export type NoteEvent = { step: number; length: number; note: string };

export type Bar = {
  /** One chord for the whole bar, or two for a half-bar change. */
  chords: string[];
  lead: NoteEvent[];
  section: string;
};

export type Track = { bpm: number; swing: number; bars: Bar[] };

export const STEPS_PER_BAR = 16;

export const CHORD_TONES: Record<string, string[]> = {
  C: ['C', 'E', 'G'],
  Dm: ['D', 'F', 'A'],
  Em: ['E', 'G', 'B'],
  F: ['F', 'A', 'C'],
  G: ['G', 'B', 'D'],
  Am: ['A', 'C', 'E'],
};

export const CHORD_ROOT_MIDI: Record<string, number> = { C: 36, Dm: 38, Em: 40, F: 41, G: 43, Am: 45 };

function parseBar(line: string): NoteEvent[] {
  const events: NoteEvent[] = [];
  let step = 0;
  for (const token of line.trim().split(/\s+/)) {
    const [note, length] = token.split(':');
    if (note !== 'r') events.push({ step, length: Number(length), note });
    step += Number(length);
  }
  return events;
}

export function barLength(line: string): number {
  return line.trim().split(/\s+/).reduce((sum, token) => sum + Number(token.split(':')[1]), 0);
}

type Section = { name: string; chords: string[][]; lead: string[] };

const HUNT_A: Section = {
  name: 'A',
  chords: [['C'], ['G'], ['Am'], ['F'], ['C'], ['G'], ['F', 'G'], ['C']],
  lead: [
    'G4:2 C5:2 E5:2 G5:4 E5:2 C5:2 E5:2',
    'D5:3 B4:1 D5:2 G5:4 F5:2 E5:2 D5:2',
    'E5:2 A5:2 C6:2 A5:4 G5:2 E5:2 G5:2',
    'A5:3 G5:1 F5:2 C5:2 F5:4 r:4',
    'G4:2 C5:2 E5:2 G5:4 A5:2 G5:2 E5:2',
    'D5:2 G5:2 B5:2 D6:4 B5:2 G5:2 D5:2',
    'C6:3 A5:1 F5:2 A5:2 B5:3 G5:1 D5:2 G5:2',
    'C6:6 G5:2 E5:2 G5:2 C6:4',
  ],
};

const HUNT_B: Section = {
  name: 'B',
  chords: [['Am'], ['Em'], ['F'], ['C'], ['Dm'], ['G'], ['Em', 'Am'], ['Dm', 'G']],
  lead: [
    'r:2 A4:2 C5:2 E5:4 D5:2 C5:2 B4:2',
    'B4:2 E5:2 G5:4 E5:2 D5:2 B4:4',
    'r:2 A4:2 C5:2 F5:4 E5:2 D5:2 C5:2',
    'E5:2 G5:2 C6:4 B5:2 G5:2 E5:4',
    'F5:2 A5:2 D6:4 C6:2 A5:2 F5:4',
    'D6:2 B5:2 G5:4 A5:2 B5:2 D6:4',
    'E6:3 D6:1 B5:2 G5:2 C6:3 B5:1 A5:2 E5:2',
    'F5:2 A5:2 D6:2 C6:2 B5:2 G5:2 A5:1 B5:1 D6:2',
  ],
};

// A lighter middle section, so a ten-minute round doesn't wear the main tune out.
const HUNT_C: Section = {
  name: 'C',
  chords: [['F'], ['G'], ['Em'], ['Am'], ['F'], ['G'], ['Am'], ['G']],
  lead: [
    'A5:6 G5:2 F5:4 C5:4',
    'G5:6 F5:2 D5:4 B4:4',
    'G5:6 E5:2 B4:4 E5:4',
    'A5:8 r:4 E5:2 G5:2',
    'A5:4 C6:4 F6:4 E6:2 C6:2',
    'D6:6 B5:2 G5:4 D6:4',
    'E6:4 C6:2 A5:2 E5:4 A5:4',
    'B5:4 D6:4 G6:4 r:4',
  ],
};

const LOBBY_A: Section = {
  name: 'A',
  chords: [['C'], ['Am'], ['F'], ['G'], ['C'], ['Am'], ['Dm', 'G'], ['C']],
  lead: [
    'E5:4 G5:2 E5:2 C5:6 D5:2',
    'E5:2 C5:2 A4:4 C5:4 r:4',
    'F5:4 A5:2 F5:2 C5:6 D5:2',
    'D5:2 E5:2 D5:2 B4:2 G4:4 r:4',
    'E5:4 G5:2 E5:2 C6:6 B5:2',
    'A5:2 G5:2 E5:4 C5:4 r:4',
    'D5:2 F5:2 A5:4 G5:2 F5:2 D5:2 B4:2',
    'C5:8 r:8',
  ],
};

const LOBBY_B: Section = {
  name: 'B',
  chords: [['F'], ['G'], ['Em'], ['Am'], ['F'], ['G'], ['Dm', 'G'], ['C']],
  lead: [
    'A5:6 C6:2 A5:4 F5:4',
    'G5:6 B5:2 D6:4 B5:4',
    'B5:4 G5:4 E5:4 G5:4',
    'A5:8 r:4 C6:2 B5:2',
    'A5:4 F5:2 A5:2 C6:4 A5:4',
    'B5:4 G5:2 B5:2 D6:4 B5:4',
    'A5:4 F5:4 G5:4 B5:4',
    'C6:8 G5:4 E5:4',
  ],
};

function expand(sections: Section[]): Bar[] {
  return sections.flatMap((section) =>
    section.lead.map((line, i) => ({
      chords: section.chords[i],
      lead: parseBar(line),
      section: section.name,
    })),
  );
}

export const RAW_SECTIONS = { HUNT_A, HUNT_B, HUNT_C, LOBBY_A, LOBBY_B };

export const TRACKS: Record<'lobby' | 'hunt', Track> = {
  lobby: { bpm: 96, swing: 0.14, bars: expand([LOBBY_A, LOBBY_B, LOBBY_A]) },
  hunt: { bpm: 132, swing: 0, bars: expand([HUNT_A, HUNT_B, { ...HUNT_A, name: 'A2' }, HUNT_C]) },
};

const NOTE_INDEX: Record<string, number> = { C: 0, 'C#': 1, D: 2, 'D#': 3, E: 4, F: 5, 'F#': 6, G: 7, 'G#': 8, A: 9, 'A#': 10, B: 11 };

export function noteToMidi(note: string): number {
  const match = note.match(/^([A-G]#?)(\d)$/);
  if (!match) throw new Error(`Bad note: ${note}`);
  return 12 * (Number(match[2]) + 1) + NOTE_INDEX[match[1]];
}

export function midiToFreq(midi: number): number {
  return 440 * 2 ** ((midi - 69) / 12);
}

const C_MAJOR = [0, 2, 4, 5, 7, 9, 11];

/** The note a diatonic third below, for the harmony line. */
export function thirdBelow(midi: number): number {
  const pitchClass = midi % 12;
  const degree = C_MAJOR.indexOf(pitchClass);
  if (degree < 0) return midi - 3;
  const target = C_MAJOR[(degree + 5) % 7];
  return midi - ((pitchClass - target + 12) % 12);
}
