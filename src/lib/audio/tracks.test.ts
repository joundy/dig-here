import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { audio } from './audio.svelte';
import { HUNT_LEVELS, MAP_MUSIC, scheduleBar, stepSeconds } from './song';
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

// Strict like a real browser: a bad automation value throws here instead of going silent there.
class FakeParam {
  value = 0;
  peak = 0;
  #check(v: number, t: number) {
    if (!Number.isFinite(v) || !Number.isFinite(t) || t < 0) throw new RangeError(`bad automation ${v} at ${t}`);
    this.peak = Math.max(this.peak, v);
  }
  setValueAtTime(v: number, t: number) { this.#check(v, t); }
  linearRampToValueAtTime(v: number, t: number) { this.#check(v, t); }
  exponentialRampToValueAtTime(v: number, t: number) {
    this.#check(v, t);
    if (v <= 0) throw new RangeError('exponential ramp to zero');
  }
  cancelScheduledValues() {}
}

class FakeNode {
  gain = new FakeParam();
  out: (FakeNode | FakeParam)[] = [];
  connect(dest: FakeNode | FakeParam) { this.out.push(dest); }
  disconnect() {}
}

type Note = { type: OscillatorType | 'pulse' | 'noise'; freq: number; start: number; stop: number; peak: number };

class FakeSource extends FakeNode {
  frequency = new FakeParam();
  type: OscillatorType | 'pulse' | 'noise' = 'sine';
  buffer: unknown = null;
  #first = 0;
  #note: Note | null = null;
  #ac: FakeContext;
  constructor(ac: FakeContext, type?: 'noise') {
    super();
    this.#ac = ac;
    if (type) this.type = type;
    const set = this.frequency.setValueAtTime.bind(this.frequency);
    this.frequency.setValueAtTime = (v, t) => {
      this.#first ||= v;
      set(v, t);
    };
  }
  setPeriodicWave() { this.type = 'pulse'; }
  start(t: number, _offset?: number, duration?: number) {
    let node: FakeNode = this;
    while (!(node.out[0] instanceof FakeParam) && node.gain.peak === 0 && node.out[0]) node = node.out[0] as FakeNode;
    // A vibrato LFO drives a pitch, not the speakers.
    if (node.out[0] instanceof FakeParam) return;
    this.#note = { type: this.type, freq: this.#first, start: t, stop: t + (duration ?? 0), peak: node.gain.peak };
    this.#ac.notes.push(this.#note);
  }
  stop(t: number) {
    if (this.#note) this.#note.stop = t;
  }
}

class FakeContext {
  notes: Note[] = [];
  state = 'running';
  currentTime = 0;
  sampleRate = 8000;
  destination = new FakeNode();
  resume() { return Promise.resolve(); }
  suspend() { return Promise.resolve(); }
  createGain() { return new FakeNode(); }
  createBiquadFilter() { return Object.assign(new FakeNode(), { type: '', frequency: new FakeParam() }); }
  createDelay() { return Object.assign(new FakeNode(), { delayTime: new FakeParam() }); }
  createDynamicsCompressor() { return Object.assign(new FakeNode(), { threshold: new FakeParam(), ratio: new FakeParam() }); }
  createOscillator() { return new FakeSource(this); }
  createBufferSource() { return new FakeSource(this, 'noise'); }
  createPeriodicWave() { return {}; }
  createBuffer(_channels: number, length: number) {
    return { getChannelData: () => new Float32Array(length) };
  }
}

const asContext = (ac: FakeContext) => ac as unknown as BaseAudioContext;
const fakeBuses = () => ({ dry: new FakeNode(), send: new FakeNode() }) as unknown as { dry: AudioNode; send: AudioNode };

/** The most that can be sounding at once, adding every voice's peak. */
function worstLoad(notes: Note[]): number {
  let worst = 0;
  for (const { start } of notes) {
    const load = notes.filter((n) => n.start <= start && start < n.stop).reduce((sum, n) => sum + n.peak, 0);
    worst = Math.max(worst, load);
  }
  return worst;
}

function playBars(intensity: number, map = MAP_MUSIC.tropical, track: 'hunt' | 'lobby' = 'hunt', bars = TRACKS[track].bars.length) {
  const ac = new FakeContext();
  let at = 0;
  for (let i = 0; i < bars; i++) at += scheduleBar(asContext(ac), fakeBuses(), track, i, intensity, at, map);
  return { notes: ac.notes, seconds: at };
}

describe('hunt intensity', () => {
  it('only the top level lifts the tempo', () => {
    expect(stepSeconds('hunt', 3)).toBeLessThan(stepSeconds('hunt', 2));
    expect(stepSeconds('hunt', 2)).toBe(stepSeconds('hunt', 0));
    expect(stepSeconds('hunt', 1)).toBe(stepSeconds('hunt', 0));
  });

  it('only the top level lifts the key', () => {
    const firstNote = (level: number) => playBars(level, MAP_MUSIC.tropical, 'hunt', 1).notes[0].freq;
    expect(firstNote(0)).toBeCloseTo(firstNote(2));
    expect(firstNote(1)).toBeCloseTo(firstNote(2));
    expect(firstNote(3) / firstNote(2)).toBeCloseTo(2 ** (2 / 12));
  });

  it('has four levels, each busier than the one below', () => {
    expect(HUNT_LEVELS).toHaveLength(4);
    const counts = [0, 1, 2, 3].map((level) => playBars(level).notes.length);
    for (let i = 1; i < counts.length; i++) expect(counts[i]).toBeGreaterThan(counts[i - 1]);
  });

  it('survives intensities outside the range', () => {
    expect(() => playBars(-1)).not.toThrow();
    expect(() => playBars(9)).not.toThrow();
    expect(() => playBars(Number.NaN)).not.toThrow();
    expect(stepSeconds('hunt', 9)).toBe(stepSeconds('hunt', 3));
  });
});

describe('map variations', () => {
  const maps = Object.entries(MAP_MUSIC);

  for (const [name, map] of maps) {
    for (const track of ['hunt', 'lobby'] as const) {
      it(`${name} ${track} schedules at every level and stays below clipping`, () => {
        for (const level of [0, 1, 2, 3]) {
          const { notes, seconds } = playBars(level, map, track);
          expect(notes.length).toBeGreaterThan(0);
          expect(seconds).toBeCloseTo(stepSeconds(track, level) * 16 * TRACKS[track].bars.length);
          expect(worstLoad(notes) * 0.42).toBeLessThan(1);
        }
      });
    }
  }

  it('keeps bars the same length on every map, so a change lands on the beat', () => {
    const [, , one] = maps.map(([, map]) => scheduleBar(asContext(new FakeContext()), fakeBuses(), 'hunt', 0, 1, 0, map));
    expect(one).toBeCloseTo(stepSeconds('hunt', 1) * 16);
  });

  it('snowy is sparser and higher, desert is swung and lower', () => {
    const first = (map: typeof MAP_MUSIC.tropical) => playBars(1, map, 'hunt', 1).notes[0].freq;
    expect(first(MAP_MUSIC.snowy)).toBeGreaterThan(first(MAP_MUSIC.tropical));
    expect(first(MAP_MUSIC.desert)).toBeLessThan(first(MAP_MUSIC.tropical));
    expect(playBars(2, MAP_MUSIC.snowy).notes.length).toBeLessThan(playBars(2).notes.length);
    const s = stepSeconds('hunt', 3);
    const offGrid = playBars(3, MAP_MUSIC.desert, 'hunt', 1).notes.filter((n) => Math.abs((n.start / s) % 1) > 0.01 && Math.abs((n.start / s) % 1) < 0.99);
    expect(offGrid.length).toBeGreaterThan(0);
    expect(playBars(3, MAP_MUSIC.tropical, 'hunt', 1).notes.every((n) => Math.round(n.start / s) * s - n.start < 1e-9)).toBe(true);
  });
});

describe('sound effects', () => {
  let ac: FakeContext;

  beforeAll(() => {
    vi.useFakeTimers();
    vi.stubGlobal('AudioContext', class extends FakeContext {
      constructor() {
        super();
        ac = this;
      }
    });
    vi.stubGlobal('document', { addEventListener() {}, hidden: false });
    audio.unlock();
  });

  afterAll(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  function played(effect: () => void): Note[] {
    ac.notes = [];
    effect();
    return ac.notes;
  }

  const effects: Record<string, () => void> = {
    join: () => audio.join(),
    roomFilling: () => audio.roomFilling(0.5),
    spotStolen: () => audio.spotStolen(),
    spotGone: () => audio.spotGone(),
    jackpot: () => audio.jackpot(),
    deposit: () => audio.deposit(),
    roundStart: () => audio.roundStart(),
  };

  for (const [name, effect] of Object.entries(effects)) {
    it(`${name} plays and stays below clipping`, () => {
      const notes = played(effect);
      expect(notes.length).toBeGreaterThan(0);
      expect(worstLoad(notes) * 0.6).toBeLessThan(1);
    });
  }

  it('the jackpot lasts at least two seconds', () => {
    const notes = played(() => audio.jackpot());
    expect(Math.max(...notes.map((n) => n.stop)) - Math.min(...notes.map((n) => n.start))).toBeGreaterThanOrEqual(2);
  });

  it('roomFilling rises and tolerates a bad ratio', () => {
    const at = (p: number) => played(() => audio.roomFilling(p))[0].freq;
    expect(at(1)).toBeGreaterThan(at(0.5));
    expect(at(0.5)).toBeGreaterThan(at(0));
    expect(at(Number.NaN)).toBe(at(0));
    expect(at(7)).toBe(at(1));
  });

  it('setMapMusic takes effect from the next bar, not the one already scheduled', () => {
    const chimes = () => ac.notes.filter((n) => n.type === 'sine' && n.freq !== 150);
    audio.setMapMusic('tropical');
    ac.notes = [];
    audio.playMusic('hunt', 1);
    expect(ac.notes.length).toBeGreaterThan(0);
    expect(chimes()).toHaveLength(0);

    audio.setMapMusic('snowy');
    audio.playMusic('hunt', 1);
    expect(chimes()).toHaveLength(0);

    ac.currentTime += stepSeconds('hunt', 1) * 16;
    audio.playMusic('hunt', 1);
    expect(chimes().length).toBeGreaterThan(0);
    audio.stopMusic();
    audio.setMapMusic('tropical');
  });
});
