import { describe, expect, it } from 'vitest';
import { barLength, CHORD_TONES, noteToMidi, RAW_SECTIONS, STEPS_PER_BAR, thirdBelow, TRACKS } from './tracks';

const C_MAJOR = new Set([0, 2, 4, 5, 7, 9, 11]);

describe('the music', () => {
  for (const [name, section] of Object.entries(RAW_SECTIONS)) {
    it(`${name} has full bars that match its chords`, () => {
      expect(section.lead).toHaveLength(section.chords.length);
      section.lead.forEach((line) => expect(barLength(line)).toBe(STEPS_PER_BAR));
    });
  }

  for (const [name, track] of Object.entries(TRACKS)) {
    it(`${name} stays in C major`, () => {
      for (const bar of track.bars) {
        for (const n of bar.lead) expect(C_MAJOR.has(noteToMidi(n.note) % 12)).toBe(true);
      }
    });

    it(`${name} lands on a chord tone at every chord change`, () => {
      for (const bar of track.bars) {
        bar.chords.forEach((chord, i) => {
          const step = (i * STEPS_PER_BAR) / bar.chords.length;
          const note = bar.lead.find((n) => n.step === step);
          // A rest on the downbeat is a pickup, which is fine.
          if (note) expect(CHORD_TONES[chord]).toContain(note.note.replace(/\d/, ''));
        });
      }
    });
  }

  it('harmonises a third below, in key', () => {
    expect(thirdBelow(noteToMidi('E5'))).toBe(noteToMidi('C5'));
    expect(thirdBelow(noteToMidi('C5'))).toBe(noteToMidi('A4'));
    expect(thirdBelow(noteToMidi('G5'))).toBe(noteToMidi('E5'));
    expect(thirdBelow(noteToMidi('F5'))).toBe(noteToMidi('D5'));
  });
});
