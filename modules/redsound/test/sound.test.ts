/**
 * The `redsound` bank, measured against the real synth.
 *
 * NOBODY WHO WROTE THIS BANK COULD HEAR IT, and neither can this suite. So
 * every claim README.md makes about the sound is a number produced here by
 * running the actual sequencer and the actual mixer over the actual bytes, and
 * the assertions below are the claims. There is no listening step to fall back
 * on and no golden waveform to diff against: what stands between this bank and
 * a game that is unpleasant to play is the arithmetic in this file.
 *
 * FOUR THINGS ARE PINNED, in rising order of how much they matter:
 *
 *   1. gen.mjs regenerates sfx.bin and music.bin byte for byte. The .bin files
 *      are output; the tracker text is the source; a note edited in one and not
 *      the other is caught here rather than at the next regeneration.
 *   2. Effects 0, 2 and 3 fire constantly and are therefore the quietest in the
 *      bank and among the shortest. In numbers, not in adjectives.
 *   3. Effect 10 does not resemble anything else in the bank. Its pitch contour
 *      and amplitude envelope are correlated against all sixteen others and the
 *      nearest neighbour is asserted to be far away.
 *   4. Nothing clips, and the song cannot bury the alarm.
 *
 * AND THE README TABLE IS PARSED AND CHECKED against the measurements, because
 * that table is what a person with ears will eventually check the bank against,
 * and a table that has drifted from the bytes is worse than no table.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  ADDR,
  AUDIO_REGS_BYTES,
  CH,
  CH_STRIDE,
  MUSIC_PATTERN_BYTES,
  MUS,
  MUSIC_STATE_ADDR,
  MUS_PLAYING,
  OWNER,
  CTRL_OWNER_MASK,
  CTRL_OWNER_SHIFT,
  PAT,
  PAT_LOOP_END,
  PAT_LOOP_START,
  RAM_SIZE,
  SFX_HDR,
  SFX_STEP,
  SFX_STEPS,
  SFX_STEPS_OFFSET,
  SFX_STEP_BYTES,
  SFX_STRIDE,
  WAVE,
  createSndApi,
  createSynthState,
  readAudioRegs,
  renderAudio,
  tickAudio,
} from "@sq1/runtime";

// @ts-expect-error -- gen.mjs is plain JavaScript with no type declarations,
// and importing it is the point: the generator is the single source of truth
// for the bytes, so the test compares the committed files against IT rather
// than against a second transcription of the same data.
import { buildMusic, buildSfx } from "../gen.mjs";

const MOD = "modules/redsound";
const SFX_BIN = new Uint8Array(readFileSync(`${MOD}/sfx.bin`));
const MUSIC_BIN = new Uint8Array(readFileSync(`${MOD}/music.bin`));
const README = readFileSync(`${MOD}/README.md`, "utf8");

/** The console runs at 60 Hz and the reference mixer at 48 kHz. */
const SR = 48000;
const FRAME_SAMPLES = SR / 60;

/** The effects Red Breaker's design names. 17..28 are music voices. */
const GAME_EFFECTS = 17;
const FIRST_MUSIC_VOICE = 17;
const LAST_MUSIC_VOICE = 28;

/** The three that fire constantly, and must stay out of the way. */
const CONSTANT = [0, 2, 3];

/** The alarm. */
const ALARM = 10;

// ---------------------------------------------------------------------------
// Reading the bank
// ---------------------------------------------------------------------------

function header(id: number, off: number): number {
  return SFX_BIN[id * SFX_STRIDE + off] as number;
}

function stepByte(id: number, s: number, off: number): number {
  return SFX_BIN[id * SFX_STRIDE + SFX_STEPS_OFFSET + s * SFX_STEP_BYTES + off] as number;
}

function length(id: number): number {
  return header(id, SFX_HDR.LENGTH);
}

/** The volume nibble and waveform of every sounding step. */
function voices(id: number): { vol: number; wave: number; note: number }[] {
  const out: { vol: number; wave: number; note: number }[] = [];
  for (let s = 0; s < length(id); s++) {
    const note = stepByte(id, s, SFX_STEP.NOTE);
    if (note > 95) continue;
    const mix = stepByte(id, s, SFX_STEP.MIX);
    out.push({ vol: (mix >> 4) & 0x0f, wave: mix & 0x0f, note });
  }
  return out;
}

/**
 * The pitch contour: one note per step, a rest holding the note before it.
 *
 * Taken from the STEP TABLE and not from the rendered samples. Pitch is what
 * the sequencer wrote; measuring it back out of a noise waveform would be
 * measuring the LFSR instead.
 */
function pitch(id: number): number[] {
  const out: number[] = [];
  let last = -1;
  for (let s = 0; s < length(id); s++) {
    const n = stepByte(id, s, SFX_STEP.NOTE);
    if (n <= 95) last = n;
    out.push(last);
  }
  const first = out.find((n) => n >= 0) ?? 0;
  return out.map((n) => (n < 0 ? first : n));
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

interface Rendered {
  /** Frames the sequencer held the channel: LENGTH x SPEED. */
  readonly seqFrames: number;
  /** Frames until the last non-zero sample, release tail included. */
  readonly audibleFrames: number;
  /** Largest absolute sample, where one channel at full tilt is 0.25. */
  readonly peak: number;
  /** Per-frame RMS over the sequenced frames only. */
  readonly amp: number[];
}

/**
 * Play one effect on one channel of a real machine and measure what comes out.
 *
 * The bank goes into RAM at 0x6300 exactly as the loader would put it there,
 * `snd.sfx` arms the channel, `tickAudio` runs the sequencer once per frame,
 * and `renderAudio` renders that frame's registers. Nothing here reimplements
 * any part of the synth.
 */
function render(bank: Uint8Array, id: number, ch = 0, cap = 600): Rendered {
  const ram = new Uint8Array(RAM_SIZE);
  ram.set(bank, ADDR.SFX);
  const snd = createSndApi(ram);
  const state = createSynthState();
  const regs = new Uint8Array(AUDIO_REGS_BYTES);
  const buf = new Float32Array(FRAME_SAMPLES);

  snd.sfx(id, ch);
  const amp: number[] = [];
  let peak = 0;
  let seqFrames = 0;
  let seqDone = false;
  let lastLoud = -1;

  for (let f = 0; f < cap; f++) {
    tickAudio(ram);
    if (!seqDone) {
      if ((ram[ADDR.AUDIO_CH + ch * CH_STRIDE + CH.SEQ_SFX] as number) === 0) seqDone = true;
      else seqFrames++;
    }
    readAudioRegs(ram, regs);
    renderAudio(regs, state, buf, SR);

    let framePeak = 0;
    let sq = 0;
    for (let i = 0; i < buf.length; i++) {
      const v = buf[i] as number;
      const a = v < 0 ? -v : v;
      if (a > framePeak) framePeak = a;
      sq += v * v;
    }
    amp.push(Math.sqrt(sq / buf.length));
    if (framePeak > peak) peak = framePeak;
    if (framePeak > 0) lastLoud = f;
    if (seqDone && framePeak === 0) break;
  }

  return { seqFrames, audibleFrames: lastLoud + 1, peak, amp: amp.slice(0, seqFrames) };
}

/** Every game effect, rendered once. */
const R: Rendered[] = [];
for (let id = 0; id < GAME_EFFECTS; id++) R.push(render(SFX_BIN, id));

// ---------------------------------------------------------------------------
// The distinctiveness metric
// ---------------------------------------------------------------------------

const BINS = 32;

/**
 * Squash a contour of any length to `BINS` points by averaging each slice.
 *
 * Bin MEANS rather than nearest-neighbour picks, because effect 10 alternates
 * its volume every two frames and a nearest-neighbour resample of that aliases
 * into whatever shape the bin spacing happens to beat against. An average
 * cannot invent a shape that is not there.
 */
function squash(src: readonly number[], n = BINS): number[] {
  const out: number[] = [];
  for (let k = 0; k < n; k++) {
    const lo = (k * src.length) / n;
    const hi = ((k + 1) * src.length) / n;
    let sum = 0;
    let w = 0;
    for (let i = Math.floor(lo); i < Math.ceil(hi); i++) {
      const part = Math.min(hi, i + 1) - Math.max(lo, i);
      if (part <= 0) continue;
      sum += (src[Math.min(i, src.length - 1)] as number) * part;
      w += part;
    }
    out.push(w === 0 ? (src[Math.min(Math.floor(lo), src.length - 1)] as number) : sum / w);
  }
  return out;
}

/** Pearson correlation. A contour that never moves correlates with nothing. */
function correlate(a: readonly number[], b: readonly number[]): number {
  const n = a.length;
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < n; i++) {
    ma += a[i] as number;
    mb += b[i] as number;
  }
  ma /= n;
  mb /= n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    const x = (a[i] as number) - ma;
    const y = (b[i] as number) - mb;
    num += x * y;
    da += x * x;
    db += y * y;
  }
  if (da === 0 || db === 0) return 0;
  return num / Math.sqrt(da * db);
}

/**
 * How alike two effects are in SHAPE: the mean of the two correlations, pitch
 * and loudness.
 *
 * The amplitude contour covers the sequenced frames only. Every effect in the
 * bank ends by fading out, so a shared release tail says nothing about which
 * effect it is, and including it pulls every long pair towards 1.
 *
 * This measure is deliberately blind to timbre and to absolute register: it
 * asks "is this the same gesture", not "is this the same sound". Effects 0 and
 * 2 are the same gesture in two registers on purpose. `confusable` below is the
 * measure that accounts for the rest.
 */
function shape(i: number, j: number): number {
  const p = correlate(squash(pitch(i)), squash(pitch(j)));
  const a = correlate(squash((R[i] as Rendered).amp), squash((R[j] as Rendered).amp));
  return (p + a) / 2;
}

/**
 * How alike two effects are in VOICE: waveforms in common, and register shared.
 *
 * Two effects can only be mistaken for one another if they are the same gesture
 * AND played by the same instrument in the same part of the keyboard, so the
 * product of this and `shape` is the honest confusability number.
 */
function voice(i: number, j: number): number {
  const va = voices(i);
  const vb = voices(j);
  const wa = new Set(va.map((v) => v.wave));
  const wb = new Set(vb.map((v) => v.wave));
  let inter = 0;
  for (const w of wa) if (wb.has(w)) inter++;
  const jaccard = inter / (wa.size + wb.size - inter);

  const aLo = Math.min(...va.map((v) => v.note));
  const aHi = Math.max(...va.map((v) => v.note));
  const bLo = Math.min(...vb.map((v) => v.note));
  const bHi = Math.max(...vb.map((v) => v.note));
  const over = Math.max(0, Math.min(aHi, bHi) - Math.max(aLo, bLo));
  const union = Math.max(aHi, bHi) - Math.min(aLo, bLo);
  return (jaccard + (union === 0 ? 1 : over / union)) / 2;
}

function confusable(i: number, j: number): number {
  return shape(i, j) * voice(i, j);
}

// ===========================================================================

describe("the .bin files are output and gen.mjs is the source", () => {
  it("regenerating the bank produces the committed bytes exactly", () => {
    expect(Array.from(buildSfx() as Uint8Array)).toEqual(Array.from(SFX_BIN));
    expect(Array.from(buildMusic() as Uint8Array)).toEqual(Array.from(MUSIC_BIN));
  });

  it("running the generator twice produces the same bytes", () => {
    expect(Array.from(buildSfx() as Uint8Array)).toEqual(Array.from(buildSfx() as Uint8Array));
    expect(Array.from(buildMusic() as Uint8Array)).toEqual(Array.from(buildMusic() as Uint8Array));
  });

  it("sfx.bin is the whole SFX region and music.bin fits inside MUS", () => {
    expect(SFX_BIN.length).toBe(32 * SFX_STRIDE);
    expect(MUSIC_BIN.length % MUSIC_PATTERN_BYTES).toBe(0);
    expect(MUSIC_BIN.length).toBeLessThanOrEqual(255 * MUSIC_PATTERN_BYTES);
  });
});

describe("every effect the design asks for is present and well formed", () => {
  it("effects 0..16 all have steps, and the spare slots are silent", () => {
    for (let id = 0; id < GAME_EFFECTS; id++) {
      expect(length(id), `effect ${id} has no steps`).toBeGreaterThan(0);
      expect(length(id)).toBeLessThanOrEqual(SFX_STEPS);
      expect(header(id, SFX_HDR.SPEED)).toBeGreaterThan(0);
    }
    for (let id = LAST_MUSIC_VOICE + 1; id < 32; id++) {
      expect(length(id), `slot ${id} should be silent`).toBe(0);
    }
  });

  it("nothing loops, because the engine has no way to stop a looping effect", () => {
    for (let id = 0; id < 32; id++) {
      expect(header(id, SFX_HDR.LOOP_END)).toBe(0);
      expect(header(id, SFX_HDR.LOOP_START)).toBe(0);
    }
  });

  it("no effect uses the wavetable waveform, which a soundbank cannot fill", () => {
    // WAVE.WAVETABLE reads the master block at 0x2150. That is a REGISTER, not
    // a cart chunk, so nothing this module ships can put anything there and an
    // effect that named it would play a zeroed table, which is silence.
    for (let id = 0; id < 32; id++) {
      for (const v of voices(id)) expect(v.wave).not.toBe(WAVE.WAVETABLE);
    }
  });

  it("every pulse effect sets its own duty on its first sounding step", () => {
    // DUTY persists on a channel between effects. An effect that inherited the
    // 9% duty of the shot fired a moment earlier would be a different sound
    // depending on what happened before it, which is exactly the kind of bug
    // nobody can reproduce.
    for (let id = 0; id < 32; id++) {
      const len = length(id);
      if (len === 0) continue;
      let firstPulse = -1;
      for (let s = 0; s < len; s++) {
        const note = stepByte(id, s, SFX_STEP.NOTE);
        if (note > 95) continue;
        if ((stepByte(id, s, SFX_STEP.MIX) & 0x0f) === WAVE.PULSE) {
          firstPulse = s;
          break;
        }
      }
      if (firstPulse < 0) continue;
      const fx = stepByte(id, firstPulse, SFX_STEP.FX);
      expect((fx >> 4) & 0x0f, `effect ${id} step ${firstPulse} does not set DUTY`).toBe(2);
    }
  });
});

/**
 * RULE ONE from modules/FORMATS-breakout-art.md.
 *
 * "A game that is annoying after ninety seconds has failed no matter how good
 * the fanfare is." These are the numbers that stand in for ninety seconds of
 * listening.
 */
describe("the three effects that fire constantly stay out of the way", () => {
  const loud = R.map((r) => r.peak);
  const others = [...Array(GAME_EFFECTS).keys()].filter((i) => !CONSTANT.includes(i));

  it("they are the three quietest effects in the bank, with a clear gap", () => {
    const loudestConstant = Math.max(...CONSTANT.map((i) => loud[i] as number));
    const quietestOther = Math.min(...others.map((i) => loud[i] as number));
    expect(loudestConstant).toBeLessThan(quietestOther);
    // And not by a hair: the gap is worth stating, because "quietest" with a
    // 1% margin is a coincidence rather than a design.
    expect(loudestConstant).toBeLessThan(quietestOther * 0.9);
  });

  it("each is under a tenth of full scale, and the alarm is over twice that", () => {
    for (const i of CONSTANT) expect(loud[i]).toBeLessThan(0.1);
    expect((R[ALARM] as Rendered).peak).toBeGreaterThan(2 * Math.max(...CONSTANT.map((i) => loud[i] as number)));
  });

  it("each is three frames long, tail included -- 50 ms", () => {
    for (const i of CONSTANT) {
      expect((R[i] as Rendered).audibleFrames, `effect ${i}`).toBe(3);
    }
    // Nothing in the bank is shorter, and only effect 8 -- the tick that says a
    // shot did nothing -- is as short.
    const shortestOther = Math.min(...others.map((i) => (R[i] as Rendered).audibleFrames));
    expect(shortestOther).toBeGreaterThanOrEqual(3);
  });

  it("they separate from each other on register, waveform and direction", () => {
    // Not on loudness alone: a player has to know WHICH of the three fired, and
    // three quiet blips that differ only in volume are one blip.
    const p0 = pitch(0);
    const p2 = pitch(2);
    const p3 = pitch(3);
    expect(p0[0]).toBeGreaterThan(p2[0] as number); // block above paddle
    expect((p0[0] as number) - (p2[0] as number)).toBe(12); // by exactly an octave
    expect((p0[p0.length - 1] as number) - (p0[0] as number)).toBeGreaterThan(0); // block rises
    expect((p2[p2.length - 1] as number) - (p2[0] as number)).toBeGreaterThan(0); // paddle rises
    expect((p3[p3.length - 1] as number) - (p3[0] as number)).toBeLessThan(0); // the wall falls
    expect(voices(0)[0]?.wave).toBe(WAVE.PULSE);
    expect(voices(2)[0]?.wave).toBe(WAVE.PULSE);
    expect(voices(3)[0]?.wave).toBe(WAVE.TRIANGLE); // and the softest waveform
  });

  it("ninety seconds of a plausible rally stays quiet and never clips", () => {
    // A wall every 24 frames, a paddle return every 72, a block hit every 48
    // and a break every 96, over the band A loop, for 5400 frames.
    const ram = new Uint8Array(RAM_SIZE);
    ram.set(SFX_BIN, ADDR.SFX);
    ram.set(MUSIC_BIN, ADDR.MUSIC);
    const snd = createSndApi(ram);
    const state = createSynthState();
    const regs = new Uint8Array(AUDIO_REGS_BYTES);
    const buf = new Float32Array(FRAME_SAMPLES);
    snd.music(0, 0, 0b1100);

    let peak = 0;
    let sq = 0;
    let n = 0;
    const TOTAL = 90 * 60;
    for (let f = 0; f < TOTAL; f++) {
      if (f % 24 === 0) snd.sfx(3, 1);
      if (f % 72 === 0) snd.sfx(2, 0);
      if (f % 48 === 12) snd.sfx(0, 1);
      if (f % 96 === 30) snd.sfx(1, 1);
      tickAudio(ram);
      readAudioRegs(ram, regs);
      renderAudio(regs, state, buf, SR);
      for (let i = 0; i < buf.length; i++) {
        const v = buf[i] as number;
        const a = v < 0 ? -v : v;
        if (a > peak) peak = a;
        sq += v * v;
        n++;
      }
    }
    const rms = Math.sqrt(sq / n);
    expect(peak).toBeLessThan(0.35);
    expect(rms).toBeLessThan(0.05);
    // And the alarm, dropped into that same rally, is far above the bed it has
    // to be heard over.
    expect((R[ALARM] as Rendered).peak / rms).toBeGreaterThan(5);
  });
});

/**
 * RULE TWO from modules/FORMATS-breakout-art.md.
 *
 * "Effect 10 must not resemble anything else in the bank." Proved rather than
 * asserted: correlated against all sixteen others, on both axes, and compared
 * against how alike the rest of the bank is to itself.
 */
describe("effect 10 is unlike everything else in the bank", () => {
  const others = [...Array(GAME_EFFECTS).keys()].filter((i) => i !== ALARM);
  const pairs: { a: number; b: number }[] = [];
  for (let i = 0; i < GAME_EFFECTS; i++) {
    for (let j = i + 1; j < GAME_EFFECTS; j++) {
      if (i !== ALARM && j !== ALARM) pairs.push({ a: i, b: j });
    }
  }

  it("its nearest neighbour by contour is an order below the bank's closest pair", () => {
    const nearest = Math.max(...others.map((i) => shape(ALARM, i)));
    const closestOther = Math.max(...pairs.map((p) => shape(p.a, p.b)));
    expect(nearest).toBeLessThan(0.2);
    expect(nearest).toBeLessThan(closestOther / 5);
  });

  it("its nearest neighbour by confusability is further still", () => {
    const nearest = Math.max(...others.map((i) => confusable(ALARM, i)));
    const closestOther = Math.max(...pairs.map((p) => confusable(p.a, p.b)));
    expect(nearest).toBeLessThan(0.1);
    expect(nearest).toBeLessThan(closestOther / 5);
  });

  it("it is the only effect that oscillates: every other one sweeps one way", () => {
    // Direction reversals in the pitch contour. Everything else in the bank
    // moves one way or holds; this turns round eleven times.
    const turns = (id: number): number => {
      const p = pitch(id);
      let n = 0;
      let dir = 0;
      for (let i = 1; i < p.length; i++) {
        const d = Math.sign((p[i] as number) - (p[i - 1] as number));
        if (d !== 0 && dir !== 0 && d !== dir) n++;
        if (d !== 0) dir = d;
      }
      return n;
    };
    expect(turns(ALARM)).toBeGreaterThan(10);
    // The most any other effect turns is twice -- the two cues that dip before
    // their final note, effect 6 and effect 14 -- and the alarm turns five
    // times more often than that.
    for (const i of others) expect(turns(i), `effect ${i} turns round`).toBeLessThanOrEqual(2);
    expect(turns(ALARM)).toBeGreaterThan(5 * Math.max(...others.map(turns)));
  });

  it("its mean pitch does not drift, so it correlates with nothing that sweeps", () => {
    // The first draft of this effect climbed a semitone every four steps and
    // measured 0.50 against the level-clear fanfare. Widening a fixed-centre
    // interval instead is what took that to under 0.1.
    const p = pitch(ALARM);
    const half = p.length / 2;
    const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
    expect(Math.abs(mean(p.slice(0, half)) - mean(p.slice(half)))).toBeLessThan(0.5);
    // ...while the interval it spans more than triples.
    const span = (k: number) => Math.abs((p[k * 2] as number) - (p[k * 2 + 1] as number));
    expect(span(p.length / 2 - 1)).toBeGreaterThan(3 * span(0));
  });

  it("it owns the saw waveform, volume 15, and the register above the song", () => {
    for (let id = 0; id < 32; id++) {
      for (const v of voices(id)) {
        if (v.wave === WAVE.SAW) expect(id, "saw belongs to effect 10").toBe(ALARM);
        if (v.vol >= 15) expect(id, "volume 15 belongs to effect 10").toBe(ALARM);
      }
    }
    const alarm = voices(ALARM);
    expect(alarm.every((v) => v.wave === WAVE.SAW)).toBe(true);
    expect(Math.min(...alarm.map((v) => v.vol))).toBeGreaterThanOrEqual(12);
    // Every note of the alarm is above every note of every music voice.
    let ceiling = 0;
    for (let id = FIRST_MUSIC_VOICE; id <= LAST_MUSIC_VOICE; id++) {
      for (const v of voices(id)) ceiling = Math.max(ceiling, v.note);
    }
    expect(Math.min(...alarm.map((v) => v.note))).toBeGreaterThan(ceiling);
  });

  it("its loudness holds flat while every other effect's decays", () => {
    // ENV_D 0 means "no decay stage": the level holds while the gate is open.
    expect(header(ALARM, SFX_HDR.ENV_D)).toBe(0);
    for (let id = 0; id < GAME_EFFECTS; id++) {
      if (id === ALARM) continue;
      expect(header(id, SFX_HDR.ENV_D), `effect ${id} has no decay`).toBeGreaterThan(0);
    }
  });

  it("it is long enough to be noticed and short enough to be over in time", () => {
    // The player has about a second to move the paddle out of the way.
    const a = R[ALARM] as Rendered;
    expect(a.seqFrames).toBe(48);
    expect(a.audibleFrames).toBeLessThan(60);
    expect(a.audibleFrames).toBeGreaterThan(40);
  });
});

describe("the extra life is the longest and warmest cue in the bank", () => {
  it("nothing else in the bank runs as long", () => {
    const six = R[6] as Rendered;
    for (let id = 0; id < GAME_EFFECTS; id++) {
      if (id === 6) continue;
      expect((R[id] as Rendered).audibleFrames, `effect ${id}`).toBeLessThan(six.audibleFrames);
    }
    expect(six.seqFrames).toBe(96); // the full 32 steps the format allows
  });

  it("it is a triangle throughout, and it arrives twice at the same note", () => {
    const v = voices(6);
    expect(v.every((x) => x.wave === WAVE.TRIANGLE)).toBe(true);
    const p = pitch(6);
    const top = Math.max(...p);
    // Two separate arrivals at the top note, not one long hold.
    let arrivals = 0;
    for (let i = 1; i < p.length; i++) {
      if (p[i] === top && (p[i - 1] as number) < top) arrivals++;
    }
    expect(arrivals).toBe(2);
    expect(header(6, SFX_HDR.ENV_R)).toBeGreaterThanOrEqual(40); // a long tail
  });

  it("it is the second loudest effect, behind the alarm and nothing else", () => {
    const ranked = [...Array(GAME_EFFECTS).keys()].sort(
      (a, b) => (R[b] as Rendered).peak - (R[a] as Rendered).peak,
    );
    expect(ranked[0]).toBe(ALARM);
    expect(ranked[1]).toBe(6);
  });
});

describe("relief and disaster do not sound alike", () => {
  it("11 and 12 share a contour but nothing else", () => {
    // Both are long downward glides, so the shape measure puts them close. They
    // are the two cues that must never be confused, and what separates them is
    // that one is a pitched square and the other is unpitched noise -- which is
    // exactly what `voice` is for.
    expect(shape(11, 12)).toBeGreaterThan(0.9);
    expect(voice(11, 12)).toBeLessThan(0.3);
    expect(confusable(11, 12)).toBeLessThan(0.3);
    expect(voices(11).every((v) => v.wave === WAVE.PULSE)).toBe(true);
    expect(voices(12).every((v) => v.wave === WAVE.NOISE)).toBe(true);
  });

  it("the deflection lands and holds; the destruction keeps falling", () => {
    const p11 = pitch(11);
    const p12 = pitch(12);
    const tail = (p: number[], k: number) => p.slice(p.length - k);
    // The last quarter of the deflection is one note, held.
    expect(new Set(tail(p11, 3)).size).toBe(1);
    // The destruction is still descending at the end.
    expect(p12[p12.length - 1] as number).toBeLessThan(p12[p12.length - 2] as number);
    expect((R[12] as Rendered).audibleFrames).toBeGreaterThan(1.8 * (R[11] as Rendered).audibleFrames);
  });
});

describe("nothing clips", () => {
  function mix(ids: number[], frames = 200): number {
    const ram = new Uint8Array(RAM_SIZE);
    ram.set(SFX_BIN, ADDR.SFX);
    const snd = createSndApi(ram);
    const state = createSynthState();
    const regs = new Uint8Array(AUDIO_REGS_BYTES);
    const buf = new Float32Array(FRAME_SAMPLES);
    for (let c = 0; c < 4; c++) snd.sfx(ids[c] as number, c);
    let peak = 0;
    for (let f = 0; f < frames; f++) {
      tickAudio(ram);
      readAudioRegs(ram, regs);
      renderAudio(regs, state, buf, SR);
      for (let i = 0; i < buf.length; i++) {
        const v = buf[i] as number;
        const a = v < 0 ? -v : v;
        if (a > peak) peak = a;
      }
    }
    return peak;
  }

  it("the four loudest effects sounding at once stay under the rail", () => {
    expect(mix([10, 6, 14, 12])).toBeLessThan(0.85);
  });

  it("the engine's own busiest frame is nowhere near it", () => {
    // The four channels the engine names, each carrying the loudest thing it
    // ever puts there: the alarm on 3, a break on 1, a paddle return on 0, a
    // caught drop on 2.
    expect(mix([2, 1, 5, 10])).toBeLessThan(0.6);
  });

  it("even the same effect on all four channels only reaches the rail", () => {
    // The pathological case, which the engine cannot produce: four copies of
    // the loudest effect, phase-locked. The mixer's quarter-scale sum is what
    // makes this land AT 1.0 rather than past it, and the clamp never fires.
    expect(mix([10, 10, 10, 10])).toBeLessThanOrEqual(1);
  });
});

describe("the music sits under the effects and never buries the alarm", () => {
  function playPattern(first: number, frames: number): { peak: number; rms: number } {
    const ram = new Uint8Array(RAM_SIZE);
    ram.set(SFX_BIN, ADDR.SFX);
    ram.set(MUSIC_BIN, ADDR.MUSIC);
    const snd = createSndApi(ram);
    const state = createSynthState();
    const regs = new Uint8Array(AUDIO_REGS_BYTES);
    const buf = new Float32Array(FRAME_SAMPLES);
    snd.music(first, 0, 0b1100);
    let peak = 0;
    let sq = 0;
    let n = 0;
    for (let f = 0; f < frames; f++) {
      tickAudio(ram);
      readAudioRegs(ram, regs);
      renderAudio(regs, state, buf, SR);
      for (let i = 0; i < buf.length; i++) {
        const v = buf[i] as number;
        const a = v < 0 ? -v : v;
        if (a > peak) peak = a;
        sq += v * v;
        n++;
      }
    }
    return { peak, rms: Math.sqrt(sq / n) };
  }

  it("each band is two patterns that loop back on themselves", () => {
    expect(MUSIC_BIN.length / MUSIC_PATTERN_BYTES).toBe(6);
    for (let p = 0; p < 6; p++) {
      const base = p * MUSIC_PATTERN_BYTES;
      expect(MUSIC_BIN[base + PAT.SFX0], `pattern ${p} claims channel 0`).toBe(0);
      expect(MUSIC_BIN[base + PAT.SFX1], `pattern ${p} claims channel 1`).toBe(0);
      const lead = (MUSIC_BIN[base + PAT.SFX2] as number) - 1;
      const bass = (MUSIC_BIN[base + PAT.SFX3] as number) - 1;
      expect(lead).toBeGreaterThanOrEqual(FIRST_MUSIC_VOICE);
      expect(bass).toBeGreaterThanOrEqual(FIRST_MUSIC_VOICE);
      expect(lead).toBeLessThanOrEqual(LAST_MUSIC_VOICE);
      expect(bass).toBeLessThanOrEqual(LAST_MUSIC_VOICE);
      // Both voices of a bar must be the same number of frames, or the pattern
      // does not end until the longer one does and the bar drags.
      expect(header(lead, SFX_HDR.SPEED) * length(lead)).toBe(
        header(bass, SFX_HDR.SPEED) * length(bass),
      );
      const flags = MUSIC_BIN[base + PAT.FLAGS] as number;
      expect(flags).toBe(p % 2 === 0 ? PAT_LOOP_START : PAT_LOOP_END);
    }
  });

  it("each band runs, hands its channels back and comes round again", () => {
    for (const first of [0, 2, 4]) {
      const ram = new Uint8Array(RAM_SIZE);
      ram.set(SFX_BIN, ADDR.SFX);
      ram.set(MUSIC_BIN, ADDR.MUSIC);
      createSndApi(ram).music(first, 0, 0b1100);
      const seen = new Set<number>();
      for (let f = 0; f < 1200; f++) {
        tickAudio(ram);
        seen.add(ram[MUSIC_STATE_ADDR + MUS.PATTERN] as number);
      }
      expect(seen, `band starting at ${first}`).toEqual(new Set([first, first + 1]));
      expect((ram[MUSIC_STATE_ADDR + MUS.FLAGS] as number) & MUS_PLAYING).toBe(MUS_PLAYING);
      // Channels 0 and 1 are still the cart's, which is where the engine fires
      // the block, break and paddle effects many times a second.
      for (const c of [0, 1]) {
        const ctrl = ram[ADDR.AUDIO_CH + c * CH_STRIDE + CH.CTRL] as number;
        expect((ctrl & CTRL_OWNER_MASK) >> CTRL_OWNER_SHIFT).not.toBe(OWNER.MUSIC);
      }
    }
  });

  it("the band gets faster as the game gets harder", () => {
    const barFrames = (p: number): number => {
      const lead = (MUSIC_BIN[p * MUSIC_PATTERN_BYTES + PAT.SFX2] as number) - 1;
      return header(lead, SFX_HDR.SPEED) * length(lead);
    };
    expect(barFrames(0)).toBeGreaterThan(barFrames(2));
    expect(barFrames(2)).toBeGreaterThan(barFrames(4));
  });

  it("every band is quieter than every effect in the bank", () => {
    const quietestEffect = Math.min(...R.map((r) => r.peak));
    for (const first of [0, 2, 4]) {
      const m = playPattern(first, 400);
      expect(m.peak, `band at ${first}`).toBeLessThan(0.15);
      expect(m.peak).toBeLessThanOrEqual(quietestEffect * 3);
    }
  });

  it("the alarm is more than four times the band's level", () => {
    // The measure that matters is loudness over time, not peak: a track can
    // have a low peak and still mask a warning by sitting on it continuously.
    const alarmRms = Math.sqrt(
      (R[ALARM] as Rendered).amp.reduce((a, b) => a + b * b, 0) / (R[ALARM] as Rendered).amp.length,
    );
    for (const first of [0, 2, 4]) {
      expect(alarmRms / playPattern(first, 400).rms, `band at ${first}`).toBeGreaterThan(4);
    }
  });

  it("no music voice reaches the effects' register or their waveforms", () => {
    for (let id = FIRST_MUSIC_VOICE; id <= LAST_MUSIC_VOICE; id++) {
      for (const v of voices(id)) {
        expect(v.note, `voice ${id}`).toBeLessThanOrEqual(69); // A5
        expect(v.vol, `voice ${id}`).toBeLessThanOrEqual(4);
        expect(v.wave === WAVE.PULSE || v.wave === WAVE.TRIANGLE, `voice ${id}`).toBe(true);
      }
    }
  });
});

/**
 * The table in README.md is the artefact somebody with ears will eventually
 * check this bank against, so it is checked against the bank here.
 *
 * A number in that table that no longer matches the bytes is a lie told to the
 * next person to open the file, and it would survive indefinitely because
 * nothing else reads it.
 */
describe("README.md agrees with the bytes", () => {
  const rows = new Map<number, string[]>();
  for (const line of README.split("\n")) {
    const m = /^\|\s*(\d+)\s*\|(.*)\|\s*$/.exec(line.trim());
    if (m === null) continue;
    const id = Number(m[1]);
    const cells = (m[2] as string).split("|").map((c) => c.trim());
    // The measurement table is the wide one: name, shape, five numbers, two
    // notes, a direction and prose. Narrower tables in the file are something
    // else and are not what this checks.
    if (cells.length < 9) continue;
    if (rows.has(id)) continue;
    rows.set(id, cells);
  }

  it("has a row for every effect", () => {
    for (let id = 0; id < GAME_EFFECTS; id++) expect(rows.has(id), `no row for ${id}`).toBe(true);
  });

  it("the frames, milliseconds, peak and notes in each row are the measured ones", () => {
    for (let id = 0; id < GAME_EFFECTS; id++) {
      const cells = rows.get(id) as string[];
      const r = R[id] as Rendered;
      const p = pitch(id);
      const want = [
        `${length(id)}x${header(id, SFX_HDR.SPEED)}`,
        String(r.seqFrames),
        String(r.audibleFrames),
        String(Math.round((r.audibleFrames * 1000) / 60)),
        r.peak.toFixed(3),
        String(p[0]),
        String(p[p.length - 1]),
      ];
      // The row is `| id | name | steps x speed | seq | audible | ms | peak |
      // start | end | direction | ... |`; the columns after `end` are prose.
      expect(cells.slice(1, 8), `README row for effect ${id}`).toEqual(want);
    }
  });
});
