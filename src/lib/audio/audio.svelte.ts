// Live audio: the unlock-on-first-gesture context, the music scheduler and the sound effects.
import type { MapId } from '../game/types';
import { MAP_MUSIC, scheduleBar } from './song';
import type { TrackName } from './song';
import { buildMusicChain, kick, noise, snare, tone } from './synth';

const SETTINGS_KEY = 'dig-here-sound-v1';
const LOOK_AHEAD = 0.25;
const MUSIC_LEVEL = 0.42;
const SFX_LEVEL = 0.6;

type Wanted = { track: TrackName; intensity: number } | null;

function loadSettings() {
  try {
    return { music: true, sfx: true, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') };
  } catch {
    return { music: true, sfx: true };
  }
}

class Audio {
  settings = $state<{ music: boolean; sfx: boolean }>(loadSettings());

  #ac: AudioContext | null = null;
  #limiter: DynamicsCompressorNode | null = null;
  #musicOut: GainNode | null = null;
  #sfxOut: GainNode | null = null;
  #chain: ReturnType<typeof buildMusicChain> | null = null;
  #timer: ReturnType<typeof setInterval> | null = null;

  #wanted: Wanted = null;
  #playing: TrackName | null = null;
  #map = MAP_MUSIC.tropical;
  #bar = 0;
  #nextBarAt = 0;
  #lastBlip = 0;

  /** Browsers only allow sound after a click or key press, so this runs on the first one. */
  unlock() {
    if (!this.#ac) {
      const ac = new AudioContext();
      const limiter = ac.createDynamicsCompressor();
      limiter.threshold.value = -10;
      limiter.ratio.value = 8;
      limiter.connect(ac.destination);
      this.#limiter = limiter;

      this.#musicOut = ac.createGain();
      this.#musicOut.gain.value = this.settings.music ? MUSIC_LEVEL : 0;
      this.#musicOut.connect(limiter);
      this.#sfxOut = ac.createGain();
      this.#sfxOut.gain.value = this.settings.sfx ? SFX_LEVEL : 0;
      this.#sfxOut.connect(limiter);

      this.#chain = buildMusicChain(ac, this.#musicOut);
      this.#chain.delay.delayTime.value = 0.34;
      this.#ac = ac;
      this.#timer = setInterval(() => this.#schedule(), 40);
      document.addEventListener('visibilitychange', () => {
        if (document.hidden) void ac.suspend();
        else void ac.resume();
      });
    }
    // iPhones report 'interrupted' after a call or a lock, which also needs a resume.
    if (this.#ac.state !== 'running') void this.#ac.resume();
    this.#schedule();
  }

  toggleMusic() {
    this.settings.music = !this.settings.music;
    this.#fade(this.#musicOut, this.settings.music ? MUSIC_LEVEL : 0);
    this.#saveSettings();
  }

  toggleSfx() {
    this.settings.sfx = !this.settings.sfx;
    this.#fade(this.#sfxOut, this.settings.sfx ? SFX_LEVEL : 0);
    this.#saveSettings();
  }

  /** Asks for a track. It starts on the next bar, or right away after silence. */
  playMusic(track: TrackName, intensity = 0) {
    this.#wanted = { track, intensity };
    this.#schedule();
  }

  /** Same song, dressed for the map. Bars already scheduled play out, so it lands on the next one. */
  setMapMusic(mapId: MapId) {
    this.#map = MAP_MUSIC[mapId];
  }

  stopMusic(fadeSeconds = 0.25) {
    this.#wanted = null;
    this.#playing = null;
    if (!this.#ac || !this.#musicOut) return;
    // Notes already scheduled keep sounding, so the old bus fades out and a new one takes over.
    const ac = this.#ac;
    const old = this.#musicOut;
    old.gain.cancelScheduledValues(ac.currentTime);
    old.gain.setValueAtTime(old.gain.value, ac.currentTime);
    old.gain.linearRampToValueAtTime(0, ac.currentTime + fadeSeconds);
    setTimeout(() => old.disconnect(), fadeSeconds * 1000 + 1500);

    const fresh = ac.createGain();
    fresh.gain.value = this.settings.music ? MUSIC_LEVEL : 0;
    fresh.connect(this.#limiter!);
    this.#musicOut = fresh;
    this.#nextBarAt = 0;
    this.#chain = buildMusicChain(ac, fresh);
    this.#chain.delay.delayTime.value = 0.34;
  }

  #schedule() {
    const ac = this.#ac;
    if (!ac || !this.#chain || ac.state !== 'running' || !this.#wanted) return;
    const { track, intensity } = this.#wanted;

    if (this.#playing !== track) {
      this.#playing = track;
      this.#bar = 0;
      this.#nextBarAt = Math.max(this.#nextBarAt, ac.currentTime + 0.06);
    }
    // After a long pause the clock has moved on, so rejoin instead of rushing to catch up.
    if (this.#nextBarAt < ac.currentTime) this.#nextBarAt = ac.currentTime + 0.05;

    while (this.#nextBarAt < ac.currentTime + LOOK_AHEAD) {
      this.#nextBarAt += scheduleBar(ac, { dry: this.#chain.dry, send: this.#chain.send }, track, this.#bar, intensity, this.#nextBarAt, this.#map);
      this.#bar++;
    }
  }

  #fade(node: GainNode | null, to: number) {
    if (!node || !this.#ac) return;
    const now = this.#ac.currentTime;
    node.gain.cancelScheduledValues(now);
    node.gain.setValueAtTime(node.gain.value, now);
    node.gain.linearRampToValueAtTime(to, now + 0.2);
  }

  #saveSettings() {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.settings));
    } catch {
      // Without storage the choice just lasts until the page reloads.
    }
  }

  #sfx(play: (ac: AudioContext, out: AudioNode, t: number) => void) {
    const ac = this.#ac;
    if (!ac || !this.#sfxOut || ac.state !== 'running' || !this.settings.sfx) return;
    play(ac, this.#sfxOut, ac.currentTime + 0.005);
  }

  hover() {
    const now = performance.now();
    if (now - this.#lastBlip < 50) return;
    this.#lastBlip = now;
    this.#sfx((ac, out, t) => tone(ac, out, t, 880, 0.03, 0.05, { duty: 0.125 }));
  }

  click() {
    this.#sfx((ac, out, t) => tone(ac, out, t, 520, 0.07, 0.14, { duty: 0.25, slideTo: 780 }));
  }

  /** Spot chosen on the map. */
  pick() {
    this.#sfx((ac, out, t) => {
      tone(ac, out, t, 660, 0.05, 0.14, { duty: 0.25 });
      tone(ac, out, t + 0.05, 990, 0.08, 0.14, { duty: 0.25 });
    });
  }

  /** The little voice a landmark makes when the shovel passes over it. */
  critter(pitch: number) {
    const now = performance.now();
    if (now - this.#lastBlip < 90) return;
    this.#lastBlip = now;
    this.#sfx((ac, out, t) => tone(ac, out, t, pitch, 0.09, 0.07, { duty: 0.5, slideTo: pitch * 1.25 }));
  }

  dig() {
    this.#sfx((ac, out, t) => {
      kick(ac, out, t, 0.5);
      noise(ac, out, t, 0.16, 0.25, 'lowpass', 1400);
      noise(ac, out, t + 0.12, 0.1, 0.16, 'lowpass', 1800);
      tone(ac, out, t + 0.14, 392, 0.07, 0.14, { duty: 0.25 });
      tone(ac, out, t + 0.21, 523, 0.07, 0.14, { duty: 0.25 });
      tone(ac, out, t + 0.28, 784, 0.16, 0.16, { duty: 0.25 });
    });
  }

  botDig() {
    this.#sfx((ac, out, t) => noise(ac, out, t, 0.07, 0.07, 'lowpass', 1000));
  }

  newClue() {
    this.#sfx((ac, out, t) => {
      [523, 659, 784, 1047].forEach((f, i) => tone(ac, out, t + i * 0.07, f, 0.14, 0.15, { duty: 0.5 }));
      tone(ac, out, t + 0.28, 1319, 0.3, 0.12, { duty: 0.25, vibrato: true });
    });
  }

  /** One letter of the parrot talking. */
  blip(pitch: number) {
    this.#sfx((ac, out, t) => tone(ac, out, t, pitch, 0.035, 0.05, { duty: 0.5 }));
  }

  tick(urgent: boolean) {
    this.#sfx((ac, out, t) => tone(ac, out, t, urgent ? 1175 : 880, 0.05, urgent ? 0.14 : 0.08, { duty: 0.125 }));
  }

  error() {
    this.#sfx((ac, out, t) => {
      tone(ac, out, t, 196, 0.09, 0.14, { duty: 0.5 });
      tone(ac, out, t + 0.1, 147, 0.14, 0.14, { duty: 0.5 });
    });
  }

  drumroll(seconds: number) {
    this.#sfx((ac, out, t) => {
      let at = 0;
      let gap = 0.11;
      while (at < seconds) {
        snare(ac, out, t + at, 0.05 + (at / seconds) * 0.13);
        gap = Math.max(0.045, gap * 0.965);
        at += gap;
      }
    });
  }

  rollStep(progress: number) {
    this.#sfx((ac, out, t) => tone(ac, out, t, 330 * 2 ** (progress * 1.6), 0.06, 0.13, { duty: 0.25 }));
  }

  chestLands() {
    this.#sfx((ac, out, t) => {
      kick(ac, out, t, 0.9);
      noise(ac, out, t, 0.5, 0.4, 'lowpass', 900);
      tone(ac, out, t, 110, 0.4, 0.3, { type: 'triangle', slideTo: 45 });
    });
  }

  chestOpens() {
    this.#sfx((ac, out, t) => {
      [784, 988, 1175, 1568, 1976].forEach((f, i) => tone(ac, out, t + i * 0.05, f, 0.22, 0.1, { duty: 0.125 }));
    });
  }

  coin() {
    this.#sfx((ac, out, t) => {
      tone(ac, out, t, 988, 0.06, 0.11, { duty: 0.25 });
      tone(ac, out, t + 0.06, 1319, 0.2, 0.11, { duty: 0.25 });
    });
  }

  scoreRow(progress: number) {
    this.#sfx((ac, out, t) => tone(ac, out, t, 440 * 2 ** progress, 0.07, 0.1, { duty: 0.25 }));
  }

  fanfare() {
    this.#sfx((ac, out, t) => {
      const line: [number, number, number][] = [
        [523, 0, 0.1], [523, 0.11, 0.1], [523, 0.22, 0.1], [523, 0.33, 0.28],
        [415, 0.61, 0.26], [466, 0.87, 0.26], [523, 1.13, 0.16], [466, 1.29, 0.1], [523, 1.39, 0.7],
      ];
      for (const [f, at, d] of line) {
        tone(ac, out, t + at, f * 2, d, 0.17, { duty: 0.25, vibrato: true });
        tone(ac, out, t + at, f, d, 0.11, { duty: 0.5 });
      }
      for (const at of [0, 0.33, 0.61, 0.87, 1.13, 1.39]) kick(ac, out, t + at, 0.4);
      tone(ac, out, t + 1.39, 131, 0.7, 0.3, { type: 'triangle' });
    });
  }

  lose() {
    this.#sfx((ac, out, t) => {
      [392, 370, 349].forEach((f, i) => tone(ac, out, t + i * 0.28, f, 0.26, 0.15, { duty: 0.5 }));
      tone(ac, out, t + 0.84, 330, 0.7, 0.15, { duty: 0.5, vibrato: true, slideTo: 300 });
    });
  }

  join() {
    this.#sfx((ac, out, t) => {
      tone(ac, out, t, 587, 0.06, 0.13, { duty: 0.25 });
      tone(ac, out, t + 0.06, 880, 0.12, 0.13, { duty: 0.25, slideTo: 988 });
    });
  }

  /** One step of the waiting room filling up. */
  roomFilling(progress: number) {
    const p = Math.max(0, Math.min(1, progress || 0));
    const f = 294 * 2 ** (p * 2);
    this.#sfx((ac, out, t) => tone(ac, out, t, f, 0.1, 0.1 + p * 0.04, { duty: 0.25, slideTo: f * 1.12 }));
  }

  spotStolen() {
    this.#sfx((ac, out, t) => {
      tone(ac, out, t, 466, 0.14, 0.14, { duty: 0.5 });
      tone(ac, out, t + 0.16, 370, 0.36, 0.14, { duty: 0.5, vibrato: true, slideTo: 349 });
    });
  }

  spotGone() {
    this.#sfx((ac, out, t) => {
      tone(ac, out, t, 988, 0.5, 0.13, { duty: 0.25, slideTo: 123 });
      noise(ac, out, t + 0.42, 0.12, 0.08, 'lowpass', 1200);
    });
  }

  /** Our own hook climbing to a held top note, under a shower of coins. */
  jackpot() {
    this.#sfx((ac, out, t) => {
      const line: [number, number, number][] = [
        [392, 0, 0.1], [523, 0.1, 0.1], [659, 0.2, 0.1], [784, 0.3, 0.2],
        [659, 0.5, 0.1], [784, 0.6, 0.1], [1047, 0.7, 0.3],
        [880, 1.0, 0.1], [1047, 1.1, 0.1], [1397, 1.2, 0.3],
        [1175, 1.5, 0.1], [1397, 1.6, 0.1], [1568, 1.7, 0.3],
        [1319, 2.0, 0.1], [1568, 2.1, 0.1], [2093, 2.2, 1.2],
      ];
      for (const [f, at, d] of line) {
        tone(ac, out, t + at, f, d, 0.15, { duty: 0.25, vibrato: true });
        tone(ac, out, t + at, f / 2, d, 0.09, { duty: 0.5 });
      }
      const bass: [number, number][] = [[131, 0], [131, 0.5], [175, 1.0], [196, 1.5], [131, 2.2]];
      bass.forEach(([f, at], i) => tone(ac, out, t + at, f, i === 4 ? 1.2 : 0.42, 0.24, { type: 'triangle', sustain: 0.8 }));
      for (const at of [0, 0.5, 1.0, 1.5, 2.0, 2.2]) kick(ac, out, t + at, 0.4);
      for (const at of [0.7, 1.2, 1.7, 2.1]) snare(ac, out, t + at, 0.1);
      for (let i = 0; i < 44; i++) {
        tone(ac, out, t + 0.3 + i * 0.07, [988, 1319, 1568, 1976][(i * 3) % 4], 0.06, 0.05, { duty: 0.25 });
      }
    });
  }

  deposit() {
    this.#sfx((ac, out, t) => {
      [0, 0.05, 0.09, 0.15, 0.19, 0.26].forEach((at, i) => {
        tone(ac, out, t + at, [1319, 988, 1568, 1175, 1760, 1319][i], 0.05, 0.09, { duty: 0.25 });
        noise(ac, out, t + at, 0.025, 0.03, 'highpass', 6000);
      });
    });
  }

  /** A short pickup, then the hit on "go". */
  roundStart() {
    this.#sfx((ac, out, t) => {
      tone(ac, out, t, 392, 0.06, 0.13, { duty: 0.25 });
      kick(ac, out, t + 0.07, 0.5);
      snare(ac, out, t + 0.07, 0.14);
      tone(ac, out, t + 0.07, 784, 0.28, 0.15, { duty: 0.25, slideTo: 880 });
      tone(ac, out, t + 0.07, 523, 0.28, 0.1, { duty: 0.5 });
      tone(ac, out, t + 0.07, 196, 0.2, 0.24, { type: 'triangle', sustain: 0.8 });
    });
  }

  refund() {
    this.#sfx((ac, out, t) => {
      [659, 523, 659].forEach((f, i) => tone(ac, out, t + i * 0.1, f, 0.12, 0.12, { duty: 0.25 }));
    });
  }
}

export const audio = new Audio();
