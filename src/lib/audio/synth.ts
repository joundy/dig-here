// Small chip-style instruments. Every one takes any BaseAudioContext, so a song can also be
// rendered offline and measured.

const pulseCache = new WeakMap<BaseAudioContext, Map<number, PeriodicWave>>();
const noiseCache = new WeakMap<BaseAudioContext, AudioBuffer>();

function pulseWave(ac: BaseAudioContext, duty: number): PeriodicWave {
  let waves = pulseCache.get(ac);
  if (!waves) pulseCache.set(ac, (waves = new Map()));
  let wave = waves.get(duty);
  if (!wave) {
    const harmonics = 32;
    const real = new Float32Array(harmonics);
    const imag = new Float32Array(harmonics);
    for (let n = 1; n < harmonics; n++) real[n] = (2 / (n * Math.PI)) * Math.sin(n * Math.PI * duty);
    wave = ac.createPeriodicWave(real, imag);
    waves.set(duty, wave);
  }
  return wave;
}

function noiseBuffer(ac: BaseAudioContext): AudioBuffer {
  let buffer = noiseCache.get(ac);
  if (!buffer) {
    buffer = ac.createBuffer(1, ac.sampleRate, ac.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    noiseCache.set(ac, buffer);
  }
  return buffer;
}

function envelope(ac: BaseAudioContext, dest: AudioNode, t: number, duration: number, volume: number, sustain = 0.6): GainNode {
  const gain = ac.createGain();
  const decayEnd = Math.min(t + 0.09, t + duration * 0.7);
  gain.gain.setValueAtTime(0, t);
  gain.gain.linearRampToValueAtTime(volume, t + 0.004);
  gain.gain.exponentialRampToValueAtTime(Math.max(volume * sustain, 0.0001), decayEnd);
  gain.gain.setValueAtTime(Math.max(volume * sustain, 0.0001), Math.max(decayEnd, t + duration - 0.025));
  gain.gain.linearRampToValueAtTime(0, t + duration);
  gain.connect(dest);
  return gain;
}

export type ToneOptions = { duty?: number; type?: OscillatorType; vibrato?: boolean; slideTo?: number; sustain?: number };

export function tone(ac: BaseAudioContext, dest: AudioNode, t: number, freq: number, duration: number, volume: number, options: ToneOptions = {}): void {
  const osc = ac.createOscillator();
  if (options.type) osc.type = options.type;
  else osc.setPeriodicWave(pulseWave(ac, options.duty ?? 0.25));
  osc.frequency.setValueAtTime(freq, t);
  if (options.slideTo) osc.frequency.exponentialRampToValueAtTime(options.slideTo, t + duration);

  // Vibrato eases in late on held notes, which keeps a square wave from sounding stiff.
  if (options.vibrato && duration > 0.28) {
    const lfo = ac.createOscillator();
    const depth = ac.createGain();
    lfo.frequency.value = 5.5;
    depth.gain.setValueAtTime(0, t);
    depth.gain.setValueAtTime(0, t + 0.16);
    depth.gain.linearRampToValueAtTime(freq * 0.012, t + 0.32);
    lfo.connect(depth);
    depth.connect(osc.frequency);
    lfo.start(t);
    lfo.stop(t + duration + 0.02);
  }

  osc.connect(envelope(ac, dest, t, duration, volume, options.sustain));
  osc.start(t);
  osc.stop(t + duration + 0.02);
}

export function noise(ac: BaseAudioContext, dest: AudioNode, t: number, duration: number, volume: number, filter: BiquadFilterType, cutoff: number): void {
  const source = ac.createBufferSource();
  source.buffer = noiseBuffer(ac);
  const biquad = ac.createBiquadFilter();
  biquad.type = filter;
  biquad.frequency.value = cutoff;
  const gain = ac.createGain();
  gain.gain.setValueAtTime(volume, t);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + duration);
  source.connect(biquad);
  biquad.connect(gain);
  gain.connect(dest);
  source.start(t, Math.random() * 0.5, duration + 0.02);
}

export function kick(ac: BaseAudioContext, dest: AudioNode, t: number, volume: number): void {
  const osc = ac.createOscillator();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(150, t);
  osc.frequency.exponentialRampToValueAtTime(42, t + 0.1);
  const gain = ac.createGain();
  gain.gain.setValueAtTime(volume, t);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.15);
  osc.connect(gain);
  gain.connect(dest);
  osc.start(t);
  osc.stop(t + 0.17);
}

export function snare(ac: BaseAudioContext, dest: AudioNode, t: number, volume: number): void {
  noise(ac, dest, t, 0.12, volume, 'bandpass', 1900);
  tone(ac, dest, t, 210, 0.07, volume * 0.5, { type: 'triangle', slideTo: 130 });
}

export function hat(ac: BaseAudioContext, dest: AudioNode, t: number, volume: number): void {
  noise(ac, dest, t, 0.035, volume, 'highpass', 7500);
}

/** Output chain shared by live play and offline rendering: music plus a soft echo, then a limiter. */
export function buildMusicChain(ac: BaseAudioContext, out: AudioNode) {
  const dry = ac.createGain();
  dry.gain.value = 1;

  const send = ac.createGain();
  send.gain.value = 0.32;
  const delay = ac.createDelay(1);
  const feedback = ac.createGain();
  feedback.gain.value = 0.3;
  const damp = ac.createBiquadFilter();
  damp.type = 'lowpass';
  damp.frequency.value = 2600;
  send.connect(delay);
  delay.connect(damp);
  damp.connect(feedback);
  feedback.connect(delay);

  const soften = ac.createBiquadFilter();
  soften.type = 'lowpass';
  soften.frequency.value = 9000;
  dry.connect(soften);
  damp.connect(soften);
  soften.connect(out);

  return { dry, send, delay };
}
