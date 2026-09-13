/**
 * The song, and the one rule that outranks it: NEVER BURY THE ALARM.
 *
 * =========================================================================
 * NOBODY WHO WROTE THIS COULD HEAR IT. SO IT IS RENDERED AND MEASURED.
 * =========================================================================
 * `modules/redsound/README.md` can state a peak and an RMS for every band
 * because the small console's synth is a pure function of registers and its
 * test suite runs it over the real bytes. Prime's mixer is a WebAudio graph,
 * and Node has no WebAudio at all -- so the numbers in
 * `packages/prime/README.md` would be assertions of taste rather than
 * measurements unless something renders the graph.
 *
 * {@link OfflineCtx} below is that something: a sample-accurate
 * `OfflineAudioContext` implementing exactly the part of the API the mixer
 * uses -- band-limited oscillators and periodic waves, audio-rate parameter
 * automation, RBJ biquads, a stereo panner, a compressor, and a looping buffer
 * source. **The mixer is not told it is being measured.** `createPrimeAudio`
 * takes it through `opts.context`, and every sample below comes out of the same
 * `play()` and the same `music()` a browser would run.
 *
 * The four ways the song keeps clear of effect 10 are each measured here:
 *
 *   LEVEL         the alarm's RMS against each band's, broadband and inside the
 *                 alarm's own octave, which is the number that decides masking
 *   REGISTER      the closest approach in semitones, from the score
 *   TIMBRE        the waveforms in the score against the waveforms in the bank
 *   INTERRUPTION  the bed under the alarm with the duck working, and the
 *                 alarm's own peak with the music playing versus alone
 *
 * **If a number in `packages/prime/README.md` moves, this file fails.** That is
 * the point of it: a table nothing checks is a table that goes stale in the
 * first week and then misleads for a year.
 */

import { describe, expect, it } from "vitest";

import { BANK_INFO, SFX, createPrimeAudio, createRecordingSnd, noteHz } from "../src/audio";
import {
  BAND_FIRST_LEVEL,
  BAR_STEPS,
  MUSIC,
  MUSIC_CEILING,
  MUSIC_COUNT,
  MUSIC_FADE_FRAMES,
  MUSIC_LEVEL,
  REST,
  SCORE,
  SCORE_INFO,
  bandForLevel,
  barEvents,
  barSeconds,
  createMusicScheduler,
  loopSeconds,
} from "../src/music";
import { ChainHasher } from "../src/hash";
import { ADDR, breakoutCart } from "../src/carts/breakout";
import { ARENA_HEADER, CART_BYTES, createMachine, emptyInput } from "../src/sim";

/** The two arena slots this file reads, from the cart's own address table. */
const G_LEVEL = ADDR.G.LEVEL;
const G_BAND = ADDR.G.BAND;

// ===========================================================================
// THE MEASURED TABLE
//
// Every number below came out of the renderer in this file, and every one of
// them is repeated in `packages/prime/README.md`. They are checked to a
// tolerance rather than to the bit because a biquad is a recursive filter and
// the last place of a double is not a promise worth making -- but the
// tolerances are tight enough that any real change to the score, the level or
// the voicing moves one of them out of range.
// ===========================================================================

/** Sample rate every measurement is taken at. A frame is exactly 800 samples. */
const SR = 48000;

/** Peak and RMS of each band, alone, over two full loops. */
const BAND_PEAK = [0.089, 0.0717, 0.0799] as const;
const BAND_RMS = [0.0184, 0.0139, 0.0185] as const;

/** The alarm, alone, over its 900 ms -- broadband, and in its own octave. */
const ALARM_PEAK = 0.5231;
const ALARM_RMS = 0.1203;
const ALARM_IN_BAND = 0.092;

/** Alarm RMS over band RMS. The chip's number is 4.4x; this must not be worse. */
const ALARM_OVER_BAND = [6.54, 8.66, 6.52] as const;

/** The same ratio inside the alarm's own octave, 900 Hz to 2.4 kHz. */
const ALARM_OVER_BAND_IN_BAND = [11.9, 24.8, 10.5] as const;

/** The alarm's peak with each band playing under it, against 0.5231 alone. */
const ALARM_PEAK_WITH_BAND = [0.5296, 0.5242, 0.5305] as const;

/** What is left of the bass, and of the whole bed, while the alarm holds. */
const DUCKED_LOW = [0.019, 0.009, 0.084] as const;
const DUCKED_RMS = [0.577, 0.392, 0.853] as const;

/** How close the song ever gets to the alarm, in semitones. */
const CLOSEST_SEMITONES = 2;

/** Fractional tolerance every measured ratio is held to. */
const TOL = 0.04;

function near(actual: number, expected: number, tol = TOL): void {
  expect(Math.abs(actual - expected) / Math.max(1e-9, Math.abs(expected))).toBeLessThan(tol);
}

// ===========================================================================
// A sample-accurate OfflineAudioContext
//
// Only what `audio.ts` and `music.ts` actually call. Everything here follows
// the Web Audio specification's own formulas: the RBJ biquad cookbook with the
// spec's Q conventions (decibels for lowpass and highpass, linear for
// bandpass), equal-power panning, and automation curves evaluated per sample.
//
// The oscillators are BAND-LIMITED, by mipmapped wavetables built from each
// waveform's Fourier series. That is not a nicety: a naive sawtooth at F#6
// aliases several percent of its energy back down the spectrum, and the whole
// question this file exists to answer is how much energy is where.
// ===========================================================================

const BLOCK = 128;
const TWO_PI = Math.PI * 2;

/** Harmonics kept when a waveform's series is infinite. Past audibility here. */
const MAX_HARMONICS = 128;

type AutoKind = "set" | "linear" | "exp";

interface AutoEvent {
  kind: AutoKind;
  time: number;
  value: number;
}

class Param {
  events: AutoEvent[] = [];
  inputs: OfflineNode[] = [];
  private intrinsic: number;
  private cursor = 0;

  constructor(defaultValue: number) {
    this.intrinsic = defaultValue;
  }

  get value(): number {
    return this.intrinsic;
  }
  set value(v: number) {
    this.intrinsic = v;
  }

  private insert(e: AutoEvent): void {
    let i = this.events.length;
    while (i > 0 && (this.events[i - 1] as AutoEvent).time > e.time) i--;
    this.events.splice(i, 0, e);
    this.cursor = 0;
  }

  setValueAtTime(v: number, t: number): this {
    this.insert({ kind: "set", time: t, value: v });
    return this;
  }
  linearRampToValueAtTime(v: number, t: number): this {
    this.insert({ kind: "linear", time: t, value: v });
    return this;
  }
  exponentialRampToValueAtTime(v: number, t: number): this {
    this.insert({ kind: "exp", time: t, value: v });
    return this;
  }
  cancelScheduledValues(t: number): this {
    this.events = this.events.filter((e) => e.time < t);
    this.cursor = 0;
    return this;
  }

  /** The scheduled value at `t`, before any audio-rate input is added. */
  scheduledAt(t: number): number {
    const ev = this.events;
    if (ev.length === 0) return this.intrinsic;
    if (t < (ev[0] as AutoEvent).time) return this.intrinsic;
    let i = this.cursor;
    if (i >= ev.length || (ev[i] as AutoEvent).time > t) i = 0;
    while (i + 1 < ev.length && (ev[i + 1] as AutoEvent).time <= t) i++;
    this.cursor = i;
    const cur = ev[i] as AutoEvent;
    const next = ev[i + 1];
    if (next !== undefined && (next.kind === "linear" || next.kind === "exp")) {
      const span = next.time - cur.time;
      if (span <= 0) return next.value;
      const k = (t - cur.time) / span;
      if (next.kind === "linear") return cur.value + (next.value - cur.value) * k;
      const a = Math.max(1e-9, Math.abs(cur.value)) * Math.sign(cur.value || 1);
      const b = Math.max(1e-9, Math.abs(next.value)) * Math.sign(next.value || 1);
      return a * (b / a) ** k;
    }
    return cur.value;
  }

  render(out: Float32Array, startSample: number, n: number, block: number): void {
    for (let i = 0; i < n; i++) out[i] = this.scheduledAt((startSample + i) / SR);
    for (const src of this.inputs) {
      src.pull(block);
      if (src.silent) continue;
      const l = src.outL;
      for (let i = 0; i < n; i++) out[i] = (out[i] as number) + (l[i] as number);
    }
  }
}

/**
 * A band-limited wavetable set, one table per octave of fundamental.
 *
 * `cosine` because a `PeriodicWave` built from REAL coefficients -- which is
 * how `audio.ts` and `music.ts` both build their pulses -- is a sum of cosines.
 * The sine-phase sum has the same spectrum and a completely different crest
 * factor, and a peak measurement taken on the wrong one would be wrong by
 * several decibels while looking entirely plausible.
 */
class WaveSet {
  private readonly tables: (Float32Array | null)[] = new Array(13).fill(null);
  constructor(
    private readonly harmonic: (n: number) => number,
    private readonly cosine = false,
  ) {}

  private build(level: number): Float32Array {
    const base = 20 * 2 ** level;
    const limit = Math.min(MAX_HARMONICS, Math.max(1, Math.floor(SR / 2 / base)));
    const N = 2048;
    const t = new Float32Array(N + 1);
    for (let n = 1; n <= limit; n++) {
      const a = this.harmonic(n);
      if (a === 0) continue;
      for (let i = 0; i < N; i++) {
        const ph = (TWO_PI * n * i) / N;
        t[i] = (t[i] as number) + a * (this.cosine ? Math.cos(ph) : Math.sin(ph));
      }
    }
    let peak = 0;
    for (let i = 0; i < N; i++) peak = Math.max(peak, Math.abs(t[i] as number));
    if (peak > 0) for (let i = 0; i < N; i++) t[i] = (t[i] as number) / peak;
    t[N] = t[0] as number;
    return t;
  }

  table(hz: number): Float32Array {
    const level = Math.max(0, Math.min(12, Math.floor(Math.log2(Math.max(20, hz) / 20))));
    let t = this.tables[level];
    if (t === null || t === undefined) {
      t = this.build(level);
      this.tables[level] = t;
    }
    return t;
  }
}

const SINE = new WaveSet((n) => (n === 1 ? 1 : 0));
const SAW = new WaveSet((n) => ((-1) ** (n + 1) * 2) / (n * Math.PI));
const SQUARE = new WaveSet((n) => (n % 2 === 1 ? 4 / (n * Math.PI) : 0));
const TRIANGLE = new WaveSet((n) =>
  n % 2 === 1 ? ((-1) ** ((n - 1) / 2) * 8) / (n * n * Math.PI * Math.PI) : 0,
);

/**
 * `silent` is how a minute of music renders in seconds rather than minutes.
 *
 * A bar that has been scheduled but has not started -- or has finished -- is
 * still a hundred and seventy connected oscillators, and summing their zeros
 * block by block is most of the cost of the whole render. A source outside its
 * own start/stop window says so, and everything downstream skips it. It is also
 * simply true: a stopped source outputs silence.
 */
class OfflineNode {
  inputs: OfflineNode[] = [];
  outL = new Float32Array(BLOCK);
  outR = new Float32Array(BLOCK);
  silent = true;
  private seen = -1;

  constructor(readonly ctx: OfflineCtx) {}

  connect<T>(dest: T): T {
    if (dest instanceof Param) dest.inputs.push(this);
    else if (dest instanceof OfflineNode) dest.inputs.push(this);
    return dest;
  }
  disconnect(): void {
    this.inputs = [];
  }

  pull(block: number): void {
    if (this.seen === block) return;
    this.seen = block;
    this.render(block);
  }

  /** Sum the live inputs. Returns false when every one of them was silent. */
  protected sum(block: number): boolean {
    this.outL.fill(0);
    this.outR.fill(0);
    let any = false;
    for (const src of this.inputs) {
      src.pull(block);
      if (src.silent) continue;
      any = true;
      for (let i = 0; i < BLOCK; i++) {
        this.outL[i] = (this.outL[i] as number) + (src.outL[i] as number);
        this.outR[i] = (this.outR[i] as number) + (src.outR[i] as number);
      }
    }
    return any;
  }

  protected render(block: number): void {
    this.silent = !this.sum(block);
  }
}

class GainN extends OfflineNode {
  gain = new Param(1);
  private buf = new Float32Array(BLOCK);
  protected override render(block: number): void {
    if (!this.sum(block)) {
      this.silent = true;
      return;
    }
    this.silent = false;
    this.gain.render(this.buf, block * BLOCK, BLOCK, block);
    for (let i = 0; i < BLOCK; i++) {
      const g = this.buf[i] as number;
      this.outL[i] = (this.outL[i] as number) * g;
      this.outR[i] = (this.outR[i] as number) * g;
    }
  }
}

class OscN extends OfflineNode {
  type = "sine";
  frequency = new Param(440);
  detune = new Param(0);
  private wave: WaveSet | null = null;
  private phase = 0;
  startAt = Infinity;
  stopAt = Infinity;
  private f = new Float32Array(BLOCK);
  private d = new Float32Array(BLOCK);

  setPeriodicWave(w: WaveSet): void {
    this.wave = w;
  }
  start(t: number): void {
    this.startAt = t;
  }
  stop(t: number): void {
    this.stopAt = Math.min(this.stopAt, t);
  }

  private set(): WaveSet {
    if (this.wave !== null) return this.wave;
    if (this.type === "sawtooth") return SAW;
    if (this.type === "square") return SQUARE;
    if (this.type === "triangle") return TRIANGLE;
    return SINE;
  }

  protected override render(block: number): void {
    this.outL.fill(0);
    this.outR.fill(0);
    const s0 = block * BLOCK;
    // The whole point of `silent`: a bar scheduled for thirty seconds' time
    // costs one comparison a block instead of two hundred and fifty-six adds.
    if ((s0 + BLOCK) / SR <= this.startAt || s0 / SR >= this.stopAt) {
      this.silent = true;
      return;
    }
    this.silent = false;
    this.frequency.render(this.f, s0, BLOCK, block);
    this.detune.render(this.d, s0, BLOCK, block);
    const set = this.set();
    for (let i = 0; i < BLOCK; i++) {
      const t = (s0 + i) / SR;
      if (t < this.startAt || t >= this.stopAt) continue;
      const hz = Math.max(0, (this.f[i] as number) * 2 ** ((this.d[i] as number) / 1200));
      const tbl = set.table(hz);
      const x = this.phase * 2048;
      const k = x | 0;
      const frac = x - k;
      const a = tbl[k] as number;
      const b = tbl[k + 1] as number;
      const v = a + (b - a) * frac;
      this.outL[i] = v;
      this.outR[i] = v;
      this.phase += hz / SR;
      if (this.phase >= 1) this.phase -= Math.floor(this.phase);
    }
  }
}

class BufferSourceN extends OfflineNode {
  buffer: { data: Float32Array } | null = null;
  loop = false;
  startAt = Infinity;
  stopAt = Infinity;
  private pos = 0;
  start(t: number): void {
    this.startAt = t;
  }
  stop(t: number): void {
    this.stopAt = Math.min(this.stopAt, t);
  }
  protected override render(block: number): void {
    this.outL.fill(0);
    this.outR.fill(0);
    const buf = this.buffer;
    const s0 = block * BLOCK;
    if (buf === null || (s0 + BLOCK) / SR <= this.startAt || s0 / SR >= this.stopAt) {
      this.silent = true;
      return;
    }
    this.silent = false;
    for (let i = 0; i < BLOCK; i++) {
      const t = (s0 + i) / SR;
      if (t < this.startAt || t >= this.stopAt) continue;
      if (this.pos >= buf.data.length) {
        if (!this.loop) continue;
        this.pos = 0;
      }
      const v = buf.data[this.pos++] as number;
      this.outL[i] = v;
      this.outR[i] = v;
    }
  }
}

class BiquadN extends OfflineNode {
  type = "lowpass";
  frequency = new Param(350);
  Q = new Param(1);
  private zL = [0, 0, 0, 0];
  private zR = [0, 0, 0, 0];
  private f = new Float32Array(BLOCK);
  private q = new Float32Array(BLOCK);

  protected override render(block: number): void {
    // A filter is never declared silent while it has anything connected: it has
    // memory, and truncating its ring would be a lie about what it does.
    this.sum(block);
    this.silent = this.inputs.length === 0;
    if (this.silent) return;
    const s0 = block * BLOCK;
    this.frequency.render(this.f, s0, BLOCK, block);
    this.Q.render(this.q, s0, BLOCK, block);
    // Coefficients once a block. A biquad whose corner moves at audio rate is
    // not what any of these filters is doing, and 2.7 ms of granularity is
    // finer than the fastest sweep in the bank.
    const hz = Math.max(10, Math.min(SR / 2 - 100, this.f[0] as number));
    const qv = this.q[0] as number;
    const w0 = (TWO_PI * hz) / SR;
    const cos = Math.cos(w0);
    const sin = Math.sin(w0);
    // The specification's own conventions: decibels for lowpass and highpass,
    // a plain quality factor for bandpass.
    const alpha =
      this.type === "bandpass" ? sin / (2 * Math.max(1e-4, qv)) : sin / (2 * 10 ** (qv / 20));
    let b0 = 1;
    let b1 = 0;
    let b2 = 0;
    if (this.type === "highpass") {
      b0 = (1 + cos) / 2;
      b1 = -(1 + cos);
      b2 = (1 + cos) / 2;
    } else if (this.type === "bandpass") {
      b0 = alpha;
      b1 = 0;
      b2 = -alpha;
    } else {
      b0 = (1 - cos) / 2;
      b1 = 1 - cos;
      b2 = (1 - cos) / 2;
    }
    const a0 = 1 + alpha;
    const a1 = -2 * cos;
    const a2 = 1 - alpha;
    const n0 = b0 / a0;
    const n1 = b1 / a0;
    const n2 = b2 / a0;
    const d1 = a1 / a0;
    const d2 = a2 / a0;
    for (const [buf, z] of [
      [this.outL, this.zL],
      [this.outR, this.zR],
    ] as [Float32Array, number[]][]) {
      let x1 = z[0] as number;
      let x2 = z[1] as number;
      let y1 = z[2] as number;
      let y2 = z[3] as number;
      for (let i = 0; i < BLOCK; i++) {
        const x = buf[i] as number;
        const y = n0 * x + n1 * x1 + n2 * x2 - d1 * y1 - d2 * y2;
        x2 = x1;
        x1 = x;
        y2 = y1;
        y1 = y;
        buf[i] = y;
      }
      z[0] = x1;
      z[1] = x2;
      z[2] = y1;
      z[3] = y2;
    }
  }
}

class PannerN extends OfflineNode {
  pan = new Param(0);
  private p = new Float32Array(BLOCK);
  protected override render(block: number): void {
    if (!this.sum(block)) {
      this.silent = true;
      return;
    }
    this.silent = false;
    this.pan.render(this.p, block * BLOCK, BLOCK, block);
    for (let i = 0; i < BLOCK; i++) {
      const x = Math.max(-1, Math.min(1, this.p[i] as number));
      const a = ((x + 1) * Math.PI) / 4;
      const l = (this.outL[i] as number) * Math.cos(a);
      const r = (this.outR[i] as number) * Math.sin(a);
      this.outL[i] = l;
      this.outR[i] = r;
    }
  }
}

class CompressorN extends OfflineNode {
  threshold = new Param(-24);
  knee = new Param(30);
  ratio = new Param(12);
  attack = new Param(0.003);
  release = new Param(0.25);
  /** The most gain this ever took off, in dB. Zero means it never engaged. */
  maxReductionDb = 0;
  private env = 0;
  protected override render(block: number): void {
    this.sum(block);
    this.silent = false;
    const thr = this.threshold.value;
    const ratio = this.ratio.value;
    const atk = Math.exp(-1 / (Math.max(1e-4, this.attack.value) * SR));
    const rel = Math.exp(-1 / (Math.max(1e-4, this.release.value) * SR));
    for (let i = 0; i < BLOCK; i++) {
      const x = Math.max(Math.abs(this.outL[i] as number), Math.abs(this.outR[i] as number));
      const db = 20 * Math.log10(Math.max(1e-9, x));
      const over = Math.max(0, db - thr);
      const wanted = over - over / ratio;
      const c = wanted > this.env ? atk : rel;
      this.env = wanted + (this.env - wanted) * c;
      if (this.env > this.maxReductionDb) this.maxReductionDb = this.env;
      const g = 10 ** (-this.env / 20);
      this.outL[i] = (this.outL[i] as number) * g;
      this.outR[i] = (this.outR[i] as number) * g;
    }
  }
}

/**
 * The context itself.
 *
 * `currentTime` stays at zero until {@link OfflineCtx.render} runs, exactly as
 * an `OfflineAudioContext`'s does, which is what lets the mixer schedule the
 * whole render from its own `currentTime + LOOKAHEAD`.
 */
class OfflineCtx {
  readonly sampleRate = SR;
  currentTime = 0;
  readonly destination: OfflineNode;
  readonly compressors: CompressorN[] = [];

  constructor(readonly length: number) {
    this.destination = new OfflineNode(this);
  }

  createGain(): GainN {
    return new GainN(this);
  }
  createOscillator(): OscN {
    return new OscN(this);
  }
  createBiquadFilter(): BiquadN {
    return new BiquadN(this);
  }
  createBufferSource(): BufferSourceN {
    return new BufferSourceN(this);
  }
  createStereoPanner(): PannerN {
    return new PannerN(this);
  }
  createDynamicsCompressor(): CompressorN {
    const c = new CompressorN(this);
    this.compressors.push(c);
    return c;
  }
  createBuffer(_ch: number, n: number): { getChannelData: () => Float32Array; data: Float32Array } {
    const data = new Float32Array(n);
    return { data, getChannelData: (): Float32Array => data };
  }
  createPeriodicWave(real: Float32Array, _imag: Float32Array, _o?: unknown): WaveSet {
    const coeffs = Float32Array.from(real);
    return new WaveSet((n) => (n < coeffs.length ? (coeffs[n] as number) : 0), true);
  }

  /** Render the whole context. Returns interleaved-free left and right. */
  render(): { L: Float32Array; R: Float32Array } {
    const L = new Float32Array(this.length);
    const R = new Float32Array(this.length);
    const blocks = Math.ceil(this.length / BLOCK);
    for (let b = 0; b < blocks; b++) {
      this.currentTime = (b * BLOCK) / SR;
      this.destination.pull(b);
      const off = b * BLOCK;
      const n = Math.min(BLOCK, this.length - off);
      for (let i = 0; i < n; i++) {
        L[off + i] = this.destination.outL[i] as number;
        R[off + i] = this.destination.outR[i] as number;
      }
    }
    return { L, R };
  }
}

/** Hand the mixer an offline context. It is never told it is being measured. */
function offlineMixer(seconds: number): {
  ctx: OfflineCtx;
  audio: ReturnType<typeof createPrimeAudio>;
} {
  const ctx = new OfflineCtx(Math.ceil(seconds * SR));
  const audio = createPrimeAudio({
    context: ctx as unknown as BaseAudioContext,
    // Unity master, so every number below is the mix rather than the mix times
    // a taste knob. MASTER_GAIN scales all of it equally when it is not 1.
    master: 1,
  });
  return { ctx, audio };
}

// ===========================================================================
// Measuring
// ===========================================================================

function mono(L: Float32Array, R: Float32Array): Float32Array {
  const out = new Float32Array(L.length);
  for (let i = 0; i < L.length; i++) out[i] = ((L[i] as number) + (R[i] as number)) * 0.5;
  return out;
}

/** A scheduler on a bare context, for the claims that are about timing alone. */
function bare(): ReturnType<typeof createMusicScheduler> {
  const ctx = new OfflineCtx(1);
  return createMusicScheduler(
    ctx as unknown as BaseAudioContext,
    ctx.createGain() as unknown as AudioNode,
  );
}

/** Render a context and fold it to one channel. Every level below is this. */
function renderMono(ctx: OfflineCtx): Float32Array {
  const { L, R } = ctx.render();
  return mono(L, R);
}

function peakOf(x: Float32Array, from = 0, to = x.length): number {
  let p = 0;
  for (let i = from; i < to; i++) p = Math.max(p, Math.abs(x[i] as number));
  return p;
}

function rmsOf(x: Float32Array, from = 0, to = x.length): number {
  let s = 0;
  for (let i = from; i < to; i++) s += (x[i] as number) * (x[i] as number);
  return Math.sqrt(s / Math.max(1, to - from));
}

/**
 * A second-order bandpass over the alarm's octave, 900 Hz to 2.4 kHz.
 *
 * The alarm's notes run from B5 at 988 Hz to C#7 at 2217 Hz. Broadband RMS is
 * the number the small console quotes and it is kept, but it flatters a bed
 * whose energy is all in the bass -- and a bass an octave below the warning
 * masks nothing. THIS is the number that decides whether the alarm is audible,
 * so it is measured too and it is the larger margin of the two.
 */
function alarmBand(x: Float32Array): Float32Array {
  const f0 = Math.sqrt(900 * 2400);
  const q = f0 / (2400 - 900);
  const w0 = (TWO_PI * f0) / SR;
  const alpha = Math.sin(w0) / (2 * q);
  const a0 = 1 + alpha;
  const n0 = alpha / a0;
  const n2 = -alpha / a0;
  const d1 = (-2 * Math.cos(w0)) / a0;
  const d2 = (1 - alpha) / a0;
  const out = new Float32Array(x.length);
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = x[i] as number;
    const y = n0 * v + n2 * x2 - d1 * y1 - d2 * y2;
    x2 = x1;
    x1 = v;
    y2 = y1;
    y1 = y;
    out[i] = y;
  }
  return out;
}

/**
 * A second-order lowpass at 250 Hz: the bass and nothing else.
 *
 * The duck takes the BASS voice away, and the bass is two per cent of the bed's
 * broadband RMS once the lead is in the same number. Measured where the bass
 * actually lives, the same event is unmistakable.
 */
function lowBand(x: Float32Array): Float32Array {
  // FOUR poles at 200 Hz. Two would leave most of an A4 in the answer, and the
  // lead's lowest notes are down there -- so a gentle filter would report the
  // melody as bass and hide exactly the change this is looking for.
  const w0 = (TWO_PI * 200) / SR;
  const alpha = Math.sin(w0) / (2 * 0.707);
  const cos = Math.cos(w0);
  const a0 = 1 + alpha;
  const n0 = (1 - cos) / 2 / a0;
  const n1 = (1 - cos) / a0;
  const n2 = n0;
  const d1 = (-2 * cos) / a0;
  const d2 = (1 - alpha) / a0;
  let out = x;
  for (let pass = 0; pass < 2; pass++) {
    const next = new Float32Array(out.length);
    let x1 = 0;
    let x2 = 0;
    let y1 = 0;
    let y2 = 0;
    for (let i = 0; i < out.length; i++) {
      const v = out[i] as number;
      const y = n0 * v + n1 * x1 + n2 * x2 - d1 * y1 - d2 * y2;
      x2 = x1;
      x1 = v;
      y2 = y1;
      y1 = y;
      next[i] = y;
    }
    out = next;
  }
  return out;
}

/** Render one band alone, from the mixer, and return its samples. */
function renderBand(band: number, seconds: number): Float32Array {
  const { ctx, audio } = offlineMixer(seconds);
  void audio.start();
  // No fade: a measurement of the bed should be a measurement of the bed and
  // not of half a second of it arriving.
  audio.music(band, 0);
  return renderMono(ctx);
}

/** Render the alarm alone, with no music under it. */
function renderAlarm(seconds: number): Float32Array {
  const { ctx, audio } = offlineMixer(seconds);
  void audio.start();
  audio.play(SFX.RED);
  return renderMono(ctx);
}

/** Render the alarm with a band playing under it, through the real duck. */
function renderAlarmOverBand(
  band: number,
  seconds: number,
): { x: Float32Array; reduction: number } {
  const { ctx, audio } = offlineMixer(seconds);
  void audio.start();
  audio.music(band, 0);
  audio.play(SFX.RED);
  const x = renderMono(ctx);
  return { x, reduction: Math.max(0, ...ctx.compressors.map((c) => c.maxReductionDb)) };
}

/** One measurement of everything, rendered once and shared by every claim. */
interface Measured {
  readonly alarmPeak: number;
  readonly alarmRms: number;
  readonly alarmInBand: number;
  readonly band: readonly {
    readonly peak: number;
    readonly rms: number;
    readonly inBand: number;
    /** RMS below 250 Hz -- the bass, and what the duck takes away. */
    readonly low: number;
    readonly alarmPeakOver: number;
    readonly limiterDb: number;
    /** The same band alone over the alarm's own 900 ms, for the duck to beat. */
    readonly windowRms: number;
    readonly windowLow: number;
    /** Under the alarm, with the duck working: below 250 Hz, and broadband. */
    readonly duckedLow: number;
    readonly duckedRms: number;
  }[];
}

let cached: Measured | null = null;

/**
 * Render every case once.
 *
 * Eight renders of a few seconds each, and every claim below reads this rather
 * than rendering again -- which is both faster and, more to the point, means
 * every number in the table came out of the SAME pass, so two rows can be
 * compared against each other and not merely against a constant.
 */
function measured(): Measured {
  if (cached !== null) return cached;
  const alarm = renderAlarm(2.2);
  const alarmTo = Math.round(0.9 * SR);
  const band: Measured["band"][number][] = [];
  for (let b = 0; b < 3; b++) {
    const spec = SCORE[b] as (typeof SCORE)[number];
    const x = renderBand(b, Math.max(loopSeconds(spec) * 2 + 0.5, 2.2));
    // Skip the first bar: the deck is arriving and the filters are settling,
    // and neither is what the bed sounds like.
    const from = Math.round(barSeconds(spec) * SR);
    const to = Math.round(loopSeconds(spec) * 2 * SR);
    const over = renderAlarmOverBand(b, 2.2);
    // Everything here is deterministic, so subtracting the alarm rendered alone
    // leaves exactly the bed that was playing under it. THAT is what the duck
    // changes, and the alarm's own energy would drown it in any other measure.
    const residue = new Float32Array(alarmTo);
    for (let i = 0; i < alarmTo; i++) {
      residue[i] = (over.x[i] as number) - (alarm[i] as number);
    }
    band.push({
      peak: peakOf(x, from),
      rms: rmsOf(x, from, to),
      inBand: rmsOf(alarmBand(x), from, to),
      low: rmsOf(lowBand(x), from, to),
      alarmPeakOver: peakOf(over.x),
      limiterDb: over.reduction,
      windowRms: rmsOf(x, 0, alarmTo),
      windowLow: rmsOf(lowBand(x), 0, alarmTo),
      duckedLow: rmsOf(lowBand(residue), 0, alarmTo),
      duckedRms: rmsOf(residue, 0, alarmTo),
    });
  }
  cached = {
    alarmPeak: peakOf(alarm),
    alarmRms: rmsOf(alarm, 0, alarmTo),
    alarmInBand: rmsOf(alarmBand(alarm), 0, alarmTo),
    band,
  };
  return cached;
}

// ===========================================================================
// The score, with no audio at all
// ===========================================================================

describe("three bands, and the difficulty curve is the speed", () => {
  it("is three bands over the levels the small console fixed", () => {
    expect(MUSIC_COUNT).toBe(3);
    expect(SCORE.length).toBe(3);
    expect(SCORE_INFO.map((b) => b.levels)).toEqual(["1-3", "4-7", "8-10"]);
    expect(BAND_FIRST_LEVEL).toEqual([0, 3, 7]);
  });

  it("gets faster, and ONLY faster, as the game gets harder", () => {
    // Six frames a step, then five, then four. Not a key change and not a new
    // melody: a player on level 9 is not listening to the music.
    expect(SCORE_INFO.map((b) => b.stepFrames)).toEqual([6, 5, 4]);
    for (let i = 1; i < SCORE_INFO.length; i++) {
      expect((SCORE_INFO[i] as { barSeconds: number }).barSeconds).toBeLessThan(
        (SCORE_INFO[i - 1] as { barSeconds: number }).barSeconds,
      );
    }
    // The chip's own bar lengths, to a hundredth of a second.
    expect(SCORE_INFO.map((b) => Math.round(b.barSeconds * 10) / 10)).toEqual([3.2, 2.7, 2.1]);
  });

  it("puts every bar boundary on a whole sample at 48 kHz", () => {
    // A frame is 800 samples, a step is a whole number of frames and a bar is
    // 32 steps, so the grid a loop runs on is exact. That is what makes the
    // drift claim below a property rather than a measurement that happened to
    // come out well.
    for (const b of SCORE_INFO) {
      const samples = (b.stepFrames * BAR_STEPS * SR) / 60;
      expect(Number.isInteger(samples)).toBe(true);
    }
  });

  it("is two bars a band, thirty-two steps a bar, two voices a bar", () => {
    for (const band of SCORE) {
      expect(band.bars.length).toBe(2);
      for (const bar of band.bars) {
        expect(bar.lead.length * band.lead.div).toBe(BAR_STEPS);
        expect(bar.bass.length * band.bass.div).toBe(BAR_STEPS);
      }
    }
  });

  it("is in A minor, with band C turning harmonic", () => {
    // The bass lands on A2 at the top of every band, and only band C carries the
    // G#: that raised seventh is the whole reason band C sounds like being
    // chased rather than merely being played faster.
    const gsharp = (b: number): boolean =>
      (SCORE[b] as (typeof SCORE)[number]).bars.some((bar) =>
        [...bar.lead, ...bar.bass].some((n) => n >= 0 && n % 12 === 8),
      );
    expect((SCORE[0] as (typeof SCORE)[number]).bars[0]?.bass[0]).toBe(33);
    expect(gsharp(2)).toBe(true);
    // Band C's bass carries it too -- G#2, the pedal's own leading tone.
    expect((SCORE[2] as (typeof SCORE)[number]).bars[0]?.bass).toContain(32);
  });

  it("puts a rest where the phrase breathes", () => {
    for (const band of SCORE) {
      for (const bar of band.bars) {
        expect(bar.lead).toContain(REST);
      }
    }
  });
});

describe("which band a level gets", () => {
  it("changes at the documented boundaries and NOT on every level", () => {
    // `G.LEVEL` counts from zero; the HUD counts from one. Bands A, B and C are
    // HUD levels 1-3, 4-7 and 8-10.
    const bands = Array.from({ length: 10 }, (_, l) => bandForLevel(l));
    expect(bands).toEqual([0, 0, 0, 1, 1, 1, 1, 2, 2, 2]);
    // Two changes over ten levels. A band that restarted every level would be
    // nine, and a two-bar loop clipped nine times is not a loop.
    let changes = 0;
    for (let i = 1; i < bands.length; i++) if (bands[i] !== bands[i - 1]) changes++;
    expect(changes).toBe(2);
  });

  it("clamps rather than indexing off the end of the pack", () => {
    expect(bandForLevel(-5)).toBe(MUSIC.A);
    expect(bandForLevel(99)).toBe(MUSIC.C);
  });
});

// ===========================================================================
// REGISTER and TIMBRE -- the two the score settles on its own
// ===========================================================================

describe("register: the song and the alarm do not share a semitone", () => {
  const ALARM_NOTES = [
    76.5, 79.5, 75, 81, 74, 82, 73, 83, 72, 84, 71, 85,
  ];

  it("keeps the whole score at or below A5, where the alarm begins at B5", () => {
    expect(MUSIC_CEILING).toBe(69);
    expect(Math.min(...ALARM_NOTES)).toBe(71);
    for (const b of SCORE_INFO) expect(b.highest).toBeLessThanOrEqual(69);
  });

  it("measures the closest approach, and it is a whole tone", () => {
    let closest = Infinity;
    for (const b of SCORE_INFO) {
      for (const n of ALARM_NOTES) closest = Math.min(closest, Math.abs(n - b.highest));
    }
    expect(closest).toBe(CLOSEST_SEMITONES);
    // In hertz, so the gap is legible: A5 is 880, B5 is 988.
    near(noteHz(71) / noteHz(69), 2 ** (2 / 12), 1e-6);
  });

  it("rolls the lead off before the alarm's octave rather than merely quietening it", () => {
    // What Prime adds to the register rule. A 9% pulse is nearly all upper
    // harmonics and those harmonics land exactly where the alarm lives, so the
    // lead's corner sits below the alarm's own range.
    for (const band of SCORE) {
      // The lead's corner is below C7, the top of the alarm's range, and it is
      // FOUR poles -- so what is left of a pulse an octave above the corner is
      // twenty-four decibels down rather than twelve.
      expect(band.lead.cutoff).toBeLessThan(noteHz(84));
      expect(band.lead.poles).toBe(4);
      // The bass never even reaches the alarm's lowest note.
      expect(band.bass.cutoff).toBeLessThan(noteHz(71));
    }
  });
});

describe("timbre: the alarm owns a waveform nothing else uses", () => {
  it("keeps saw and noise out of the music entirely", () => {
    for (const b of SCORE_INFO) {
      for (const w of b.waves) expect(["pulse", "triangle", "sine"]).toContain(w);
    }
  });

  it("leaves the saw to effect 10 and to nothing else in the console", () => {
    const saws = BANK_INFO.filter((e) => e.waves.includes("sawtooth")).map((e) => e.id);
    // The bank's own claim, restated here because the music is the other half of
    // it: a waveform used by one warning and nothing else is a channel of its
    // own, and the song joining in would spend it.
    expect(saws).toContain(SFX.RED);
    const scoreWaves = new Set(SCORE_INFO.flatMap((b) => b.waves));
    expect(scoreWaves.has("sawtooth")).toBe(false);
    expect(scoreWaves.has("noise")).toBe(false);
  });
});

// ===========================================================================
// LEVEL -- rendered and measured
// ===========================================================================

describe("level: the bed sits well under the alarm", () => {
  it("measures every band's peak and RMS, and they are the README's", () => {
    const m = measured();
    for (let b = 0; b < 3; b++) {
      near((m.band[b] as { peak: number }).peak, BAND_PEAK[b] as number);
      near((m.band[b] as { rms: number }).rms, BAND_RMS[b] as number);
    }
  });

  it("measures the alarm, alone", () => {
    const m = measured();
    near(m.alarmPeak, ALARM_PEAK);
    near(m.alarmRms, ALARM_RMS);
    near(m.alarmInBand, ALARM_IN_BAND);
  });

  it("puts the alarm at least 4.4x the loudest band on RMS, the chip's margin", () => {
    const m = measured();
    for (let b = 0; b < 3; b++) {
      const ratio = m.alarmRms / (m.band[b] as { rms: number }).rms;
      near(ratio, ALARM_OVER_BAND[b] as number);
      // The small console measures 4.4x and that is the bar. Prime clears it on
      // every band, which is what the four-pole lowpass buys: the bed can sit at
      // a block hit's level and still be nowhere near the warning.
      expect(ratio).toBeGreaterThan(4.4);
    }
  });

  it("is far further clear inside the alarm's own octave", () => {
    // THE NUMBER THAT ACTUALLY DECIDES MASKING. A bass an octave below the
    // warning hides nothing, and broadband RMS cannot tell the difference.
    const m = measured();
    for (let b = 0; b < 3; b++) {
      const ratio = m.alarmInBand / (m.band[b] as { inBand: number }).inBand;
      near(ratio, ALARM_OVER_BAND_IN_BAND[b] as number);
      expect(ratio).toBeGreaterThan(9);
      // And it is always the better of the two margins, which is the whole
      // point of rolling the lead off rather than merely turning it down.
      expect(ratio).toBeGreaterThan(m.alarmRms / (m.band[b] as { rms: number }).rms);
    }
  });

  it("keeps every band's peak to under a quarter of the alarm's", () => {
    // The chip's bed peaks at 0.109 against an alarm of 0.250, so it leans on
    // the other three rules for most of its margin. Prime's headroom pays for a
    // bigger gap here and still lands the bed at about a block hit's level,
    // which is where a bed belongs: present, and never the loudest thing.
    const m = measured();
    for (const b of m.band) expect(b.peak).toBeLessThan(m.alarmPeak * 0.25);
  });
});

// ===========================================================================
// INTERRUPTION -- the rule that is a mechanic
// ===========================================================================

describe("interruption: an effect that needs a voice takes it", () => {
  it("loses the alarm nothing at all by having a band under it", () => {
    // THE ONE THAT WOULD MATTER MOST IF IT WERE WRONG. If the bed pushed the
    // master limiter, the alarm would come out QUIETER with music playing than
    // without it -- a mix that gets worse exactly when the game gets busy.
    const m = measured();
    for (let b = 0; b < 3; b++) {
      const over = m.band[b] as { alarmPeakOver: number; limiterDb: number };
      near(over.alarmPeakOver, ALARM_PEAK_WITH_BAND[b] as number);
      expect(over.alarmPeakOver).toBeGreaterThanOrEqual(m.alarmPeak * 0.999);
      // And the limiter never fired, so nothing is being paid for anywhere.
      expect(over.limiterDb).toBeLessThan(0.01);
    }
  });

  it("drops the bass out from under the alarm for its whole length", () => {
    // The chip put the alarm on channel 3, the song's bass channel, and an
    // effect claiming a music channel TOOK it. Prime keeps the rule on purpose,
    // and this is the rule happening: under the alarm, below 250 Hz, the bed
    // has almost nothing left.
    const m = measured();
    for (let b = 0; b < 3; b++) {
      const row = m.band[b] as {
        windowRms: number;
        windowLow: number;
        duckedLow: number;
        duckedRms: number;
      };
      // Against the SAME band over the SAME 900 ms with no alarm in it, so the
      // only difference between the two numbers is the duck.
      near(row.duckedLow / row.windowLow, DUCKED_LOW[b] as number, 0.12);
      // Twenty to forty decibels down. The floor is gone.
      expect(row.duckedLow).toBeLessThan(row.windowLow * 0.12);
      // The melody, though, is still there. Silencing the whole song would put
      // a second of silence exactly where the cue is.
      near(row.duckedRms / row.windowRms, DUCKED_RMS[b] as number, 0.06);
      expect(row.duckedRms).toBeGreaterThan(row.windowRms * 0.3);
    }
  });

  it("gives the voice back, so the song is still there when the alarm stops", () => {
    const { ctx, audio } = offlineMixer(3.2);
    void audio.start();
    audio.music(MUSIC.C, 0);
    audio.play(SFX.RED);
    const x = renderMono(ctx);
    // A second after the alarm ended, the bass is back under the melody.
    const from = Math.round(2.2 * SR);
    const to = Math.round(3.1 * SR);
    const back = rmsOf(lowBand(x), from, to);
    const bed = (measured().band[2] as { low: number }).low;
    expect(back).toBeGreaterThan(bed * 0.6);
  });

  it("leaves the lead alone when the effect is on the lead's channel", () => {
    // Channel 2 is the lead and channel 3 is the bass, which is the chip's
    // wiring. A drop caught is on channel 2, so it takes the melody and not the
    // floor -- the opposite trade from the alarm's, and the right one.
    expect(BANK_INFO[SFX.DROP]?.ch).toBe(2);
    expect(BANK_INFO[SFX.RED]?.ch).toBe(3);
    expect(BANK_INFO[SFX.HIT]?.ch).toBe(1);
    expect(BANK_INFO[SFX.PADDLE]?.ch).toBe(0);
  });

  it("never ducks for the three effects that fire constantly", () => {
    // Channels 0 and 1 are the engine's, exactly as on the chip: the block, the
    // paddle and the wall fire many times a second and a song being chopped by
    // them would be a song being shredded.
    for (const id of [SFX.HIT, SFX.PADDLE, SFX.WALL, SFX.BREAK]) {
      const ch = BANK_INFO[id]?.ch ?? -1;
      expect(ch === 0 || ch === 1).toBe(true);
    }
  });
});


describe("the scheduler", () => {
  it("puts every bar exactly on the grid, with no drift over a rendered minute", () => {
    const s = bare();
    s.play(MUSIC.B, 0);
    s.pump(60);
    const band = SCORE[MUSIC.B] as (typeof SCORE)[number];
    const bar = barSeconds(band);
    const t = s.barTimes;
    expect(t.length).toBeGreaterThan(20);
    const anchor = t[0] as number;
    for (let i = 0; i < t.length; i++) {
      // Computed, never accumulated. `anchor + i * bar` to the bit.
      expect(t[i]).toBe(anchor + i * bar);
    }
    // And in real terms: the last bar of the minute is where it should be to
    // better than a thousandth of a sample.
    const last = (t[t.length - 1] as number) - anchor;
    expect(Math.abs(last * SR - Math.round(last * SR))).toBeLessThan(1e-3);
  });

  it("is sample-accurate in the rendered audio a minute in", () => {
    // The scheduler's arithmetic being right is one claim; the SOUND landing on
    // the grid is the one that matters. Band B's loop is two bars, so the bar
    // that starts at 53.333 s is the same bar as the one at 0 -- and if it is,
    // the two stretches of samples correlate best at a lag of exactly zero.
    const band = SCORE[MUSIC.B] as (typeof SCORE)[number];
    const loop = loopSeconds(band);
    const loops = Math.floor(56 / loop);
    const seconds = loops * loop + barSeconds(band) + 0.2;
    const x = renderBand(MUSIC.B, seconds);
    const barN = Math.round(barSeconds(band) * SR);
    // Compare the second bar of the run against the same bar `loops-1` loops on.
    const a = Math.round(barSeconds(band) * SR);
    const b = a + Math.round((loops - 1) * loop * SR);
    let bestLag = 0;
    let best = -Infinity;
    for (let lag = -24; lag <= 24; lag++) {
      let dot = 0;
      for (let i = 0; i < barN; i += 4) {
        dot += (x[a + i] as number) * (x[b + i + lag] as number);
      }
      if (dot > best) {
        best = dot;
        bestLag = lag;
      }
    }
    expect(bestLag).toBe(0);
    // And the same bar really is the same bar: near-perfect correlation.
    let num = 0;
    let da = 0;
    let db = 0;
    for (let i = 0; i < barN; i += 4) {
      const u = x[a + i] as number;
      const v = x[b + i] as number;
      num += u * v;
      da += u * u;
      db += v * v;
    }
    // Not 1.0: the bus filters are recursive and have been running for a
    // minute, so their state differs in the last few places. The LAG is the
    // sample-accuracy claim; this is only that the same bar came round again.
    expect(num / Math.sqrt(da * db)).toBeGreaterThan(0.99);
  });

  it("lands on the same grid driven in small steps as driven in one", () => {
    // How the LIVE mixer runs it: a timer every 125 ms asking for half a second
    // of horizon. A scheduler that built from wherever it happened to be asked
    // would put a seam at every pump; this one is asked eight times a second
    // for a minute and produces exactly the bars it would have produced in one
    // call, at exactly the same times, with none missed and none built twice.
    const band = SCORE[MUSIC.C] as (typeof SCORE)[number];
    const bar = barSeconds(band);

    const one = bare();
    one.play(MUSIC.C, 0);
    one.pump(60);

    const many = bare();
    many.play(MUSIC.C, 0);
    for (let t = 0; t < 60; t += 0.125) many.pump(t + 0.5);

    expect(many.barTimes.length).toBeGreaterThan(25);
    const anchor = many.barTimes[0] as number;
    for (let i = 0; i < many.barTimes.length; i++) {
      expect(many.barTimes[i]).toBe(anchor + i * bar);
    }
    expect(many.barTimes.length).toBe(one.barTimes.length);
  });

  it("does not restart a band that is already playing, mid-bar or anywhere else", () => {
    const s = bare();
    s.play(MUSIC.A, 0);
    s.pump(20);
    const before = [...s.barTimes];
    // The cart asserts the band every tick; sixty of those is one second of
    // play. Not one of them may move the loop.
    for (let i = 0; i < 60; i++) s.play(MUSIC.A, MUSIC_FADE_FRAMES);
    s.pump(20);
    expect(s.barTimes).toEqual(before);
    expect(s.track).toBe(MUSIC.A);
  });

  it("does restart when the band actually changes", () => {
    const s = bare();
    s.play(MUSIC.A, 0);
    s.pump(10);
    const a = s.barTimes.length;
    s.play(MUSIC.B, 0);
    s.pump(10);
    expect(s.track).toBe(MUSIC.B);
    expect(s.barTimes.length).toBeGreaterThan(a);
  });

  it("plays nothing for an id this console has no band for", () => {
    const s = bare();
    s.play(-1, 0);
    s.pump(10);
    expect(s.playing).toBe(false);
    expect(s.barTimes.length).toBe(0);
    s.play(7, 0);
    s.pump(10);
    expect(s.playing).toBe(false);
  });

  it("stops, and stays stopped", () => {
    const s = bare();
    s.play(MUSIC.C, 0);
    s.pump(10);
    const n = s.barTimes.length;
    expect(n).toBeGreaterThan(2);
    s.stop(0);
    expect(s.playing).toBe(false);
    expect(s.track).toBe(-1);
    s.pump(30);
    expect(s.barTimes.length).toBe(n);
  });
});

// ===========================================================================
// The mixer's half
// ===========================================================================

describe("the mixer", () => {
  it("makes real sound for music(), and silence after stopMusic()", () => {
    const { ctx, audio } = offlineMixer(2.0);
    void audio.start();
    audio.music(MUSIC.A, 0);
    const loud = rmsOf(renderMono(ctx));
    expect(loud).toBeGreaterThan(0.005);

    const off = offlineMixer(2.0);
    void off.audio.start();
    off.audio.music(MUSIC.A, 0);
    off.audio.stopMusic(0);
    expect(rmsOf(renderMono(off.ctx))).toBeLessThan(loud * 0.05);
  });

  it("latches a track asked for before the context is running", () => {
    // The case that decides whether this console has music at all. A cart calls
    // `snd.music` on its first tick, which on a browser is long before the
    // gesture that lets the context start -- and it does not call again until
    // the BAND changes, which on levels 1-3 is never.
    const ctx = new OfflineCtx(Math.ceil(2.0 * SR));
    const audio = createPrimeAudio({ context: ctx as unknown as BaseAudioContext, master: 1 });
    audio.music(MUSIC.A, 0); // before start(): the mixer is not running yet
    expect(audio.running).toBe(false);
    void audio.start();
    expect(audio.running).toBe(true);
    expect(rmsOf(renderMono(ctx))).toBeGreaterThan(0.005);
  });

  it("is safe to call before there is any mixer at all", () => {
    const a = createPrimeAudio();
    expect(() => {
      a.music(MUSIC.A);
      a.music(MUSIC.C, 12);
      a.stopMusic();
      a.stopMusic(0);
    }).not.toThrow();
  });

  it("silences the song along with everything else when muted", () => {
    const { ctx, audio } = offlineMixer(2.0);
    void audio.start();
    audio.muted = true;
    audio.music(MUSIC.A, 0);
    // Past the mute's own 20 ms ramp, which is there so muting is not a click.
    expect(peakOf(renderMono(ctx), Math.round(0.05 * SR))).toBeLessThan(1e-4);
  });

  it("never reaches the rail, band and busiest frame together", () => {
    // The engine's busiest realistic moment: a paddle return, a block breaking,
    // a drop caught and the alarm, over the fastest band.
    const { ctx, audio } = offlineMixer(1.6);
    void audio.start();
    audio.music(MUSIC.C, 0);
    audio.play(SFX.PADDLE);
    audio.play(SFX.BREAK);
    audio.play(SFX.DROP);
    audio.play(SFX.RED);
    const { L, R } = ctx.render();
    expect(peakOf(L)).toBeLessThan(1);
    expect(peakOf(R)).toBeLessThan(1);
  });
});

// ===========================================================================
// Music is not simulation
// ===========================================================================

describe("music is not simulation", () => {
  it("leaves the conformance chain identical with music on and off", () => {
    // THE LOAD-BEARING ONE. The cart writes the BAND to the arena, so the band
    // travels in a snapshot -- but nothing about whether a mixer exists, or
    // what it does with the call, may reach a single byte of it.
    const TICKS = 400;
    const script = (t: number): number => (t % 91 === 0 ? 1 << 4 : t % 7 < 4 ? 1 << 2 : 1 << 3);
    const chainOf = (snd: Parameters<typeof createMachine>[1]): string => {
      const machine = createMachine(breakoutCart, snd);
      machine.boot(0xba7dn);
      const input = emptyInput();
      const hasher = new ChainHasher();
      for (let t = 0; t < TICKS; t++) {
        input.buttons[0] = script(t);
        machine.step(input);
        hasher.push(machine.arena.bytes);
      }
      return hasher.digest;
    };
    const silent = chainOf(undefined);
    const recording = createRecordingSnd();
    const loud = chainOf(recording);
    const musical = chainOf(createPrimeAudio());
    expect(loud).toBe(silent);
    expect(musical).toBe(silent);
    // And the run really did ask for music, or the comparison proved nothing.
    expect(recording.calls.filter((c) => c.kind === "music").length).toBe(1);
    expect(recording.calls.find((c) => c.kind === "music")?.id).toBe(MUSIC.A);
  });

  it("asks for the band once, on the first tick, and not again", () => {
    let machine!: ReturnType<typeof createMachine>;
    const snd = createRecordingSnd(() => machine.tick);
    machine = createMachine(breakoutCart, snd);
    machine.boot(3n);
    // Boot makes no sound: everything that happens, happens in `tick`.
    expect(snd.calls.length).toBe(0);
    const input = emptyInput();
    for (let t = 0; t < 200; t++) machine.step(input);
    const music = snd.calls.filter((c) => c.kind === "music");
    expect(music.length).toBe(1);
    expect(music[0]?.tick).toBe(0n);
    expect(music[0]?.id).toBe(MUSIC.A);
  });

  it("restores the band with the game: snapshot and restore across a band switch", () => {
    const snd = createRecordingSnd();
    const machine = createMachine(breakoutCart, snd);
    machine.boot(11n);
    const input = emptyInput();
    machine.step(input);

    // Jump the cart to a band-B level by hand -- reaching level 4 by play takes
    // longer than a test should -- and let the next tick notice.
    const mem = new DataView(machine.arena.buf, ARENA_HEADER, CART_BYTES);
    mem.setFloat64(G_LEVEL * 8, 4, true);
    snd.clear();
    machine.step(input);
    expect(snd.calls.filter((c) => c.kind === "music").map((c) => c.id)).toEqual([MUSIC.B]);
    expect(mem.getFloat64(G_BAND * 8, true)).toBe(MUSIC.B + 1);

    const snap = machine.snapshot();
    for (let t = 0; t < 60; t++) machine.step(input);
    const after = machine.snapshot();

    machine.restore(snap);
    snd.clear();
    for (let t = 0; t < 60; t++) machine.step(input);
    expect(machine.snapshot()).toEqual(after);
    // And a restored machine does not re-announce the band it was already on.
    expect(snd.calls.filter((c) => c.kind === "music").length).toBe(0);
  });

  it("changes band exactly twice over the ten levels, and never mid-band", () => {
    const snd = createRecordingSnd();
    const machine = createMachine(breakoutCart, snd);
    machine.boot(5n);
    const input = emptyInput();
    const mem = new DataView(machine.arena.buf, ARENA_HEADER, CART_BYTES);
    const asked: number[] = [];
    for (let level = 0; level < 10; level++) {
      mem.setFloat64(G_LEVEL * 8, level, true);
      machine.step(input);
      for (const c of snd.calls) if (c.kind === "music") asked.push(c.id);
      snd.clear();
    }
    expect(asked).toEqual([MUSIC.A, MUSIC.B, MUSIC.C]);
  });
});

// ===========================================================================
// The events the score produces, for the record
// ===========================================================================

describe("barEvents", () => {
  it("gives a note its slot, and a rest none", () => {
    const band = SCORE[MUSIC.A] as (typeof SCORE)[number];
    const e = barEvents(band, 0).filter((x) => x.voice === "lead");
    // Sixteen slots, two of them rests.
    expect(e.length).toBe(14);
    expect(e[0]?.note).toBe(57);
    expect(e[0]?.at).toBe(0);
    // Tied pairs: the lead's slot is two steps at six frames each.
    near(e[1]?.at ?? 0, (2 * 6) / 60, 1e-9);
  });

  it("holds band C's pedal on every step", () => {
    const band = SCORE[MUSIC.C] as (typeof SCORE)[number];
    const bass = barEvents(band, 0).filter((x) => x.voice === "bass");
    expect(bass.length).toBe(BAR_STEPS);
    near(bass[1]?.at ?? 0, 4 / 60, 1e-9);
  });
});

// ===========================================================================
// Regenerating the table
//
//   SQ1_MUSIC_TABLE=1 npx vitest run packages/prime/test/music.test.ts
//
// prints every number the constants at the top of this file hold and
// `packages/prime/README.md` publishes, in the README's own order. It is how
// the table is produced and the only way it should ever be updated: a number
// typed by hand is a number nothing produced.
// ===========================================================================

describe.runIf(process.env["SQ1_MUSIC_TABLE"] === "1")("the measurement table", () => {
  it("prints what the README publishes", () => {
    const m = measured();
    const rows = [
      `ALARM_PEAK = ${m.alarmPeak.toFixed(4)}`,
      `ALARM_RMS  = ${m.alarmRms.toFixed(4)}   in-band ${m.alarmInBand.toFixed(4)}`,
      `BAND_PEAK = [${m.band.map((b) => b.peak.toFixed(4)).join(", ")}]`,
      `BAND_RMS  = [${m.band.map((b) => b.rms.toFixed(4)).join(", ")}]`,
      `ALARM_OVER_BAND = [${m.band.map((b) => (m.alarmRms / b.rms).toFixed(2)).join(", ")}]`,
      `ALARM_OVER_BAND_IN_BAND = [${m.band
        .map((b) => (m.alarmInBand / b.inBand).toFixed(1))
        .join(", ")}]`,
      `ALARM_PEAK_WITH_BAND = [${m.band.map((b) => b.alarmPeakOver.toFixed(4)).join(", ")}]`,
      `limiter dB = [${m.band.map((b) => b.limiterDb.toFixed(3)).join(", ")}]`,
      `ducked low / free low = [${m.band
        .map((b) => (b.duckedLow / b.windowLow).toFixed(3))
        .join(", ")}]`,
      `ducked rms / free rms = [${m.band
        .map((b) => (b.duckedRms / b.windowRms).toFixed(3))
        .join(", ")}]`,
    ];
    // eslint-disable-next-line no-console
    console.log(["", ...rows, ""].join("\n"));
    expect(rows.length).toBe(10);
  });
});

describe("the published shape", () => {
  it("keeps MUSIC_LEVEL the one knob the mix is made of", () => {
    expect(MUSIC_LEVEL).toBeGreaterThan(0);
    // Every band's summed peak gain is under the alarm's 0.45, before a single
    // filter has touched it.
    for (const b of SCORE_INFO) expect(b.peak).toBeLessThan(0.45);
  });

  it("agrees with itself about how many notes there are", () => {
    for (let i = 0; i < SCORE.length; i++) {
      const band = SCORE[i] as (typeof SCORE)[number];
      let n = 0;
      for (let b = 0; b < band.bars.length; b++) n += barEvents(band, b).length;
      expect((SCORE_INFO[i] as { notes: number }).notes).toBe(n);
    }
  });
});
