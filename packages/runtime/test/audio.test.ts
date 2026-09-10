/**
 * Audio: the register layout, the sequencer, and the synth.
 *
 * Everything here runs in Node with no AudioContext anywhere, which is the
 * point of putting the synth in the runtime rather than in the player. The one
 * thing these tests cannot see is a real audio callback; what they can see is
 * that the function that callback runs is deterministic, allocation-free, and
 * identical to the source text the player ships into the worklet realm.
 */

import { describe, expect, it } from "vitest";

import {
  AUDIO_CHANNELS,
  AUDIO_REGS_BYTES,
  AUDIO_REGS_START,
  CH,
  CH_STRIDE,
  CTRL_ENABLE,
  CTRL_GATE,
  CTRL_OWNER_MASK,
  CTRL_OWNER_SHIFT,
  MUS,
  MUSIC_PATTERNS,
  MUSIC_PATTERN_BYTES,
  MUSIC_STATE_ADDR,
  MUS_PENDING,
  MUS_PLAYING,
  NOTE_HZ16,
  OWNER,
  PAT,
  PAT_LOOP_END,
  PAT_LOOP_START,
  SFX_COUNT,
  SFX_HDR,
  SFX_STEP,
  SFX_STEPS,
  SFX_STEPS_OFFSET,
  SFX_STEP_BYTES,
  SFX_STRIDE,
  WAVE,
  WAVETABLE_ADDR,
  WAVETABLE_REG_OFFSET,
  createSndApi,
  createSynthState,
  readAudioRegs,
  renderAudio,
  tickAudio,
  type SynthState,
} from "../src/audio";
import { createMachine } from "../src/machine";
import { ADDR, LEN, RAM_SIZE } from "../src/memory";

const SR = 48000;

/** A fresh 80-byte register block: every channel disabled, wavetable zeroed. */
function regs(): Uint8Array {
  return new Uint8Array(AUDIO_REGS_BYTES);
}

interface Voice {
  wave?: number;
  vol?: number;
  hz?: number;
  duty?: number;
  gate?: boolean;
  trig?: number;
  env?: [number, number, number, number];
}

/** Write one channel of a register block, in the layout the header documents. */
function voice(r: Uint8Array, c: number, v: Voice): void {
  const b = c * CH_STRIDE;
  r[b + CH.CTRL] = CTRL_ENABLE | (v.gate === false ? 0 : CTRL_GATE);
  r[b + CH.WAVE] = v.wave ?? WAVE.PULSE;
  r[b + CH.VOL] = v.vol ?? 255;
  r[b + CH.DUTY] = v.duty ?? 0;
  const p = Math.round((v.hz ?? 440) * 16);
  r[b + CH.PITCH_LO] = p & 0xff;
  r[b + CH.PITCH_HI] = (p >> 8) & 0xff;
  r[b + CH.TRIG] = v.trig ?? 0;
  const e = v.env ?? [0, 0, 0, 0];
  r[b + CH.ENV_A] = e[0];
  r[b + CH.ENV_D] = e[1];
  r[b + CH.ENV_S] = e[2];
  r[b + CH.ENV_R] = e[3];
}

/** Sign changes, ignoring exact zeros. Two per period for a square. */
function crossings(out: Float32Array): number {
  let last = 0;
  let n = 0;
  for (let i = 0; i < out.length; i++) {
    const v = out[i] as number;
    const s = v > 0 ? 1 : v < 0 ? -1 : 0;
    if (s === 0) continue;
    if (last !== 0 && s !== last) n++;
    last = s;
  }
  return n;
}

function render(r: Uint8Array, samples: number, state?: SynthState): Float32Array {
  const out = new Float32Array(samples);
  renderAudio(r, state ?? createSynthState(), out, SR);
  return out;
}

// ---------------------------------------------------------------------------

describe("the register layout fits the memory map exactly", () => {
  it("the register block is the channel blocks plus the master block", () => {
    expect(AUDIO_REGS_START).toBe(ADDR.AUDIO_CH);
    expect(AUDIO_REGS_BYTES).toBe(80);
    expect(AUDIO_CHANNELS * CH_STRIDE).toBe(LEN.AUDIO_CH);
    expect(WAVETABLE_REG_OFFSET).toBe(LEN.AUDIO_CH);
    expect(WAVETABLE_ADDR).toBe(ADDR.AUDIO_MASTER);
  });

  it("the sfx bank is exactly 32 effects of 104 bytes", () => {
    expect(SFX_COUNT * SFX_STRIDE).toBe(LEN.SFX);
    expect(SFX_STEPS_OFFSET + SFX_STEPS * SFX_STEP_BYTES).toBe(SFX_STRIDE);
  });

  it("the music region is 255 patterns plus the 8-byte sequencer state", () => {
    expect(MUSIC_PATTERNS * MUSIC_PATTERN_BYTES + 8).toBe(LEN.MUSIC);
    expect(MUSIC_STATE_ADDR).toBe(ADDR.MUSIC + 2040);
    expect(MUSIC_STATE_ADDR + 8).toBe(ADDR.MUSIC + LEN.MUSIC);
  });

  it("the note table is 96 entries with A4 = 440 Hz and B7 inside u16", () => {
    expect(NOTE_HZ16.length).toBe(96);
    expect(NOTE_HZ16[57]).toBe(440 * 16);
    expect(NOTE_HZ16[95]).toBeLessThan(65536);
  });
});

describe("readAudioRegs", () => {
  it("copies the 80 bytes and hands back a copy, not a view", () => {
    const ram = new Uint8Array(RAM_SIZE);
    for (let i = 0; i < AUDIO_REGS_BYTES; i++) ram[ADDR.AUDIO_CH + i] = (i * 7) & 0xff;
    const out = regs();
    readAudioRegs(ram, out);
    for (let i = 0; i < AUDIO_REGS_BYTES; i++) expect(out[i]).toBe((i * 7) & 0xff);

    out[0] = 0xaa;
    expect(ram[ADDR.AUDIO_CH]).toBe(0);
  });
});

// ---------------------------------------------------------------------------

/** A one-note effect: pulse, full volume, A4, one step. */
function writeSfx(ram: Uint8Array, id: number, note: number, speed = 1, length = 1): void {
  const base = ADDR.SFX + id * SFX_STRIDE;
  ram[base + SFX_HDR.SPEED] = speed;
  ram[base + SFX_HDR.LENGTH] = length;
  ram[base + SFX_HDR.ENV_A] = 1;
  ram[base + SFX_HDR.ENV_D] = 2;
  ram[base + SFX_HDR.ENV_S] = 128;
  ram[base + SFX_HDR.ENV_R] = 3;
  for (let s = 0; s < length; s++) {
    const so = base + SFX_STEPS_OFFSET + s * SFX_STEP_BYTES;
    ram[so + SFX_STEP.NOTE] = note + s;
    ram[so + SFX_STEP.MIX] = (0x0f << 4) | WAVE.TRIANGLE;
    ram[so + SFX_STEP.FX] = 0;
  }
}

function owner(ram: Uint8Array, c: number): number {
  const ctrl = ram[ADDR.AUDIO_CH + c * CH_STRIDE + CH.CTRL] as number;
  return (ctrl & CTRL_OWNER_MASK) >> CTRL_OWNER_SHIFT;
}

function chByte(ram: Uint8Array, c: number, off: number): number {
  return ram[ADDR.AUDIO_CH + c * CH_STRIDE + off] as number;
}

describe("sfx() writes what the layout says", () => {
  it("arms the named channel and copies the effect's envelope in", () => {
    const ram = new Uint8Array(RAM_SIZE);
    writeSfx(ram, 3, 57);
    createSndApi(ram).sfx(3, 2);

    expect(chByte(ram, 2, CH.SEQ_SFX)).toBe(4); // id + 1, so a zeroed RAM is idle
    expect(chByte(ram, 2, CH.SEQ_STEP)).toBe(0);
    expect(chByte(ram, 2, CH.ENV_A)).toBe(1);
    expect(chByte(ram, 2, CH.ENV_D)).toBe(2);
    expect(chByte(ram, 2, CH.ENV_S)).toBe(128);
    expect(chByte(ram, 2, CH.ENV_R)).toBe(3);
    expect(chByte(ram, 2, CH.CTRL) & CTRL_ENABLE).toBe(CTRL_ENABLE);
    expect(owner(ram, 2)).toBe(OWNER.SFX);
  });

  it("the first step lands on the same tick the cart asked for it", () => {
    const ram = new Uint8Array(RAM_SIZE);
    writeSfx(ram, 0, 57);
    createSndApi(ram).sfx(0, 0);
    tickAudio(ram);

    const hz = NOTE_HZ16[57] as number;
    expect(chByte(ram, 0, CH.PITCH_LO) | (chByte(ram, 0, CH.PITCH_HI) << 8)).toBe(hz);
    expect(chByte(ram, 0, CH.VOL)).toBe(255);
    expect(chByte(ram, 0, CH.WAVE)).toBe(WAVE.TRIANGLE);
    expect(chByte(ram, 0, CH.CTRL) & (CTRL_ENABLE | CTRL_GATE)).toBe(CTRL_ENABLE | CTRL_GATE);
    expect(chByte(ram, 0, CH.TRIG)).toBe(1);
  });

  it("advances one step per SPEED frames and then releases the channel", () => {
    const ram = new Uint8Array(RAM_SIZE);
    writeSfx(ram, 0, 57, 3, 2);
    createSndApi(ram).sfx(0, 0);

    tickAudio(ram); // step 0
    expect(chByte(ram, 0, CH.PITCH_LO) | (chByte(ram, 0, CH.PITCH_HI) << 8)).toBe(NOTE_HZ16[57]);
    tickAudio(ram);
    tickAudio(ram);
    expect(chByte(ram, 0, CH.PITCH_LO) | (chByte(ram, 0, CH.PITCH_HI) << 8)).toBe(NOTE_HZ16[57]);
    tickAudio(ram); // step 1, three frames later
    expect(chByte(ram, 0, CH.PITCH_LO) | (chByte(ram, 0, CH.PITCH_HI) << 8)).toBe(NOTE_HZ16[58]);

    for (let i = 0; i < 4; i++) tickAudio(ram);
    expect(chByte(ram, 0, CH.SEQ_SFX)).toBe(0);
    expect(chByte(ram, 0, CH.CTRL) & CTRL_GATE).toBe(0);
    expect(owner(ram, 0)).toBe(OWNER.CART);
  });

  it("picks a free channel when none is named, and a negative id stops one", () => {
    const ram = new Uint8Array(RAM_SIZE);
    writeSfx(ram, 0, 57);
    const snd = createSndApi(ram);

    snd.sfx(0);
    expect(chByte(ram, 0, CH.SEQ_SFX)).toBe(1);
    snd.sfx(0);
    expect(chByte(ram, 1, CH.SEQ_SFX)).toBe(1);

    snd.sfx(-1, 0);
    expect(chByte(ram, 0, CH.SEQ_SFX)).toBe(0);
    snd.sfx(-1);
    for (let c = 0; c < AUDIO_CHANNELS; c++) expect(chByte(ram, c, CH.SEQ_SFX)).toBe(0);
  });

  it("ignores an out-of-range effect or channel instead of throwing", () => {
    const ram = new Uint8Array(RAM_SIZE);
    const snd = createSndApi(ram);
    snd.sfx(SFX_COUNT, 0);
    snd.sfx(0, 9);
    snd.sfx(0, -1);
    for (let i = 0; i < LEN.AUDIO_CH; i++) expect(ram[ADDR.AUDIO_CH + i]).toBe(0);
  });
});

describe("music() writes what the layout says", () => {
  function writePattern(ram: Uint8Array, p: number, sfxPerCh: number[], flags = 0): void {
    const base = ADDR.MUSIC + p * MUSIC_PATTERN_BYTES;
    for (let c = 0; c < AUDIO_CHANNELS; c++) ram[base + c] = sfxPerCh[c] ?? 0;
    ram[base + PAT.FLAGS] = flags;
  }

  it("records the pattern, mask and fade, and starts on the next tick", () => {
    const ram = new Uint8Array(RAM_SIZE);
    writeSfx(ram, 0, 57, 1, 4);
    writePattern(ram, 0, [1, 0, 0, 0]);
    createSndApi(ram).music(0, 12, 0b0011);

    const st = MUSIC_STATE_ADDR;
    expect(ram[st + MUS.FLAGS]).toBe(MUS_PLAYING | MUS_PENDING);
    expect(ram[st + MUS.PATTERN]).toBe(0);
    expect(ram[st + MUS.MASK]).toBe(0b0011);
    expect(ram[st + MUS.FADE_LEN]).toBe(12);

    tickAudio(ram);
    expect((ram[st + MUS.FLAGS] as number) & MUS_PENDING).toBe(0);
    expect(owner(ram, 0)).toBe(OWNER.MUSIC);
    expect(chByte(ram, 0, CH.SEQ_SFX)).toBe(1);
    expect(owner(ram, 1)).toBe(OWNER.CART);
  });

  it("fades in over FADE_LEN frames by scaling the channel volume", () => {
    const ram = new Uint8Array(RAM_SIZE);
    writeSfx(ram, 0, 57, 8, 4);
    writePattern(ram, 0, [1, 0, 0, 0]);
    createSndApi(ram).music(0, 8);

    tickAudio(ram);
    const first = chByte(ram, 0, CH.VOL);
    expect(chByte(ram, 0, CH.SEQ_VOL)).toBe(255);
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThan(255);

    for (let i = 0; i < 8; i++) tickAudio(ram);
    expect(chByte(ram, 0, CH.VOL)).toBe(255);
  });

  it("advances to the next pattern when every claimed channel is done", () => {
    const ram = new Uint8Array(RAM_SIZE);
    writeSfx(ram, 0, 57, 1, 1);
    writeSfx(ram, 1, 60, 1, 1);
    writePattern(ram, 0, [1, 0, 0, 0]);
    writePattern(ram, 1, [2, 0, 0, 0]);
    createSndApi(ram).music(0);

    tickAudio(ram); // pattern 0 starts, step 0 plays
    expect(chByte(ram, 0, CH.PITCH_LO) | (chByte(ram, 0, CH.PITCH_HI) << 8)).toBe(NOTE_HZ16[57]);
    tickAudio(ram); // effect ends, channel released
    tickAudio(ram); // pattern 1 starts
    expect(ram[MUSIC_STATE_ADDR + MUS.PATTERN]).toBe(1);
    expect(chByte(ram, 0, CH.PITCH_LO) | (chByte(ram, 0, CH.PITCH_HI) << 8)).toBe(NOTE_HZ16[60]);
  });

  it("loops back to the most recent LOOP_START on LOOP_END", () => {
    const ram = new Uint8Array(RAM_SIZE);
    writeSfx(ram, 0, 57, 1, 1);
    writePattern(ram, 0, [1, 0, 0, 0], PAT_LOOP_START);
    writePattern(ram, 1, [1, 0, 0, 0], PAT_LOOP_END);
    createSndApi(ram).music(0);

    for (let i = 0; i < 3; i++) tickAudio(ram);
    expect(ram[MUSIC_STATE_ADDR + MUS.PATTERN]).toBe(1);
    for (let i = 0; i < 3; i++) tickAudio(ram);
    expect(ram[MUSIC_STATE_ADDR + MUS.PATTERN]).toBe(0);
    expect((ram[MUSIC_STATE_ADDR + MUS.FLAGS] as number) & MUS_PLAYING).toBe(MUS_PLAYING);
  });

  it("never steals a channel the cart is driving itself", () => {
    const ram = new Uint8Array(RAM_SIZE);
    writeSfx(ram, 0, 57, 1, 4);
    writePattern(ram, 0, [1, 1, 0, 0]);
    // The cart owns channel 1 by hand.
    ram[ADDR.AUDIO_CH + CH_STRIDE + CH.CTRL] = CTRL_ENABLE | CTRL_GATE;
    ram[ADDR.AUDIO_CH + CH_STRIDE + CH.VOL] = 200;
    createSndApi(ram).sfx(0, 1);

    createSndApi(ram).music(0);
    tickAudio(ram);
    expect(owner(ram, 0)).toBe(OWNER.MUSIC);
    expect(owner(ram, 1)).toBe(OWNER.SFX);
  });

  it("a negative pattern stops the song and frees its channels", () => {
    const ram = new Uint8Array(RAM_SIZE);
    writeSfx(ram, 0, 57, 4, 4);
    writePattern(ram, 0, [1, 0, 0, 0]);
    const snd = createSndApi(ram);
    snd.music(0);
    tickAudio(ram);
    expect(owner(ram, 0)).toBe(OWNER.MUSIC);

    snd.music(-1);
    expect(ram[MUSIC_STATE_ADDR + MUS.FLAGS]).toBe(0);
    expect(owner(ram, 0)).toBe(OWNER.CART);
    expect(chByte(ram, 0, CH.SEQ_SFX)).toBe(0);
  });

  it("tickAudio does nothing at all on a zeroed machine", () => {
    const ram = new Uint8Array(RAM_SIZE);
    const before = new Uint8Array(ram);
    for (let i = 0; i < 60; i++) tickAudio(ram);
    expect(ram).toEqual(before);
  });
});

describe("the registers are machine state", () => {
  it("audio survives snapshot and restore like everything else", () => {
    const m = createMachine({ boot: () => {}, tick: () => {} });
    m.boot(1);
    writeSfx(m.ram, 0, 57, 4, 8);
    const snd = createSndApi(m.ram);
    snd.sfx(0, 1);
    snd.music(0, 4, 0b0100);
    tickAudio(m.ram);

    const snap = m.snapshot();
    const audio = m.ram.slice(ADDR.AUDIO_CH, ADDR.AUDIO_CH + AUDIO_REGS_BYTES);
    const seq = m.ram.slice(MUSIC_STATE_ADDR, MUSIC_STATE_ADDR + 8);

    // Trash everything the audio system owns, then rewind.
    m.ram.fill(0, ADDR.AUDIO_CH, ADDR.AUDIO_CH + AUDIO_REGS_BYTES);
    m.ram.fill(0, MUSIC_STATE_ADDR, MUSIC_STATE_ADDR + 8);
    expect(m.ram.slice(ADDR.AUDIO_CH, ADDR.AUDIO_CH + AUDIO_REGS_BYTES)).not.toEqual(audio);

    m.restore(snap);
    expect(m.ram.slice(ADDR.AUDIO_CH, ADDR.AUDIO_CH + AUDIO_REGS_BYTES)).toEqual(audio);
    expect(m.ram.slice(MUSIC_STATE_ADDR, MUSIC_STATE_ADDR + 8)).toEqual(seq);
  });

  it("a rewind puts the sequencer back where it was, note for note", () => {
    const ram = new Uint8Array(RAM_SIZE);
    writeSfx(ram, 0, 40, 2, 16);
    createSndApi(ram).sfx(0, 0);
    for (let i = 0; i < 7; i++) tickAudio(ram);

    const snap = new Uint8Array(ram);
    const forward: number[] = [];
    for (let i = 0; i < 20; i++) {
      tickAudio(ram);
      forward.push(chByte(ram, 0, CH.PITCH_LO));
    }

    ram.set(snap);
    const again: number[] = [];
    for (let i = 0; i < 20; i++) {
      tickAudio(ram);
      again.push(chByte(ram, 0, CH.PITCH_LO));
    }
    expect(again).toEqual(forward);
  });
});

// ---------------------------------------------------------------------------

describe("renderAudio is deterministic", () => {
  it("the same registers and the same starting state give identical samples", () => {
    const r = regs();
    voice(r, 0, { wave: WAVE.PULSE, hz: 261.63 });
    voice(r, 1, { wave: WAVE.NOISE, hz: 900 });
    voice(r, 2, { wave: WAVE.SAW, hz: 55, env: [10, 20, 100, 30] });
    expect(render(r, 2048)).toEqual(render(r, 2048));
  });

  it("stays identical across a sequence of buffers", () => {
    const r = regs();
    voice(r, 0, { wave: WAVE.NOISE, hz: 1200, env: [5, 5, 90, 5] });

    function run(): number[] {
      const s = createSynthState();
      const out = new Float32Array(256);
      const acc: number[] = [];
      for (let i = 0; i < 12; i++) {
        renderAudio(r, s, out, SR);
        acc.push(out[0] as number, out[128] as number, out[255] as number);
      }
      return acc;
    }
    expect(run()).toEqual(run());
  });

  it("nothing it does reaches back into the register block", () => {
    const r = regs();
    voice(r, 0, { wave: WAVE.WAVETABLE, hz: 220 });
    for (let k = 0; k < 16; k++) r[WAVETABLE_REG_OFFSET + k] = (k * 17) & 0xff;
    const before = new Uint8Array(r);
    render(r, 1024);
    expect(r).toEqual(before);
  });
});

/**
 * Allocation.
 *
 * The same counting-Proxy probe `machine.test.ts` uses, for the same reason: a
 * heap sample cannot see a short-lived allocation, and `renderAudio` runs in an
 * audio callback where a collection pause is an audible click.
 */
const COUNTED_CTORS = [
  "Array",
  "ArrayBuffer",
  "DataView",
  "Float32Array",
  "Float64Array",
  "Int8Array",
  "Int16Array",
  "Int32Array",
  "Map",
  "Set",
  "Uint8Array",
  "Uint16Array",
  "Uint32Array",
  "WeakMap",
] as const;

type Ctor = new (...args: never[]) => unknown;

function countingConstructions(body: () => void): number {
  const g = globalThis as unknown as Record<string, Ctor>;
  const saved = new Map<string, Ctor>();
  let count = 0;
  for (const name of COUNTED_CTORS) {
    const orig = g[name] as Ctor;
    saved.set(name, orig);
    g[name] = new Proxy(orig, {
      construct(target, args, newTarget): object {
        count++;
        return Reflect.construct(target, args, newTarget) as object;
      },
    }) as Ctor;
  }
  try {
    body();
  } finally {
    for (const [name, orig] of saved) g[name] = orig;
  }
  return count;
}

describe("allocation discipline", () => {
  it("1000 buffers of every waveform construct nothing", () => {
    const r = regs();
    voice(r, 0, { wave: WAVE.PULSE, hz: 440, env: [5, 10, 128, 20] });
    voice(r, 1, { wave: WAVE.TRIANGLE, hz: 220 });
    voice(r, 2, { wave: WAVE.NOISE, hz: 1500, duty: 1 });
    voice(r, 3, { wave: WAVE.WAVETABLE, hz: 110 });
    for (let k = 0; k < 16; k++) r[WAVETABLE_REG_OFFSET + k] = (k * 11) & 0xff;

    const state = createSynthState();
    const out = new Float32Array(128);
    renderAudio(r, state, out, SR); // warm up outside the probe

    const constructions = countingConstructions(() => {
      for (let i = 0; i < 1000; i++) renderAudio(r, state, out, SR);
    });
    expect(constructions).toBe(0);
  });

  it("the probe actually detects an allocation", () => {
    const n = countingConstructions(() => {
      for (let i = 0; i < 5; i++) new Float32Array(8);
    });
    expect(n).toBe(5);
  });

  it("tickAudio allocates nothing either", () => {
    const ram = new Uint8Array(RAM_SIZE);
    writeSfx(ram, 0, 40, 1, 32);
    createSndApi(ram).sfx(0, 0);
    tickAudio(ram);

    const constructions = countingConstructions(() => {
      for (let i = 0; i < 500; i++) tickAudio(ram);
    });
    expect(constructions).toBe(0);
  });
});

// ---------------------------------------------------------------------------

describe("each waveform is the shape it claims to be", () => {
  const HZ = 480; // 48000 / 480 = exactly 100 samples per period
  const N = 4800; // 48 periods
  const PERIODS = 48;

  // Every one of these waveforms changes sign twice per period. A sawtooth
  // crosses zero once, but its wrap from +1 to -1 is a sign change too, so the
  // count alone does not tell the four apart -- the tests below use the count
  // to prove the FREQUENCY is right and the shape assertions after it to prove
  // the waveform is.
  const SIGN_CHANGES = 2 * PERIODS;

  it("stays inside the rail whatever is playing", () => {
    const r = regs();
    voice(r, 0, { wave: WAVE.PULSE, hz: HZ });
    voice(r, 1, { wave: WAVE.SAW, hz: HZ });
    voice(r, 2, { wave: WAVE.TRIANGLE, hz: HZ });
    voice(r, 3, { wave: WAVE.NOISE, hz: HZ });
    const out = render(r, N);
    for (let i = 0; i < N; i++) {
      const v = out[i] as number;
      expect(Number.isFinite(v)).toBe(true);
      expect(Math.abs(v)).toBeLessThanOrEqual(1);
    }
  });

  it("a 50% pulse crosses zero twice a period and is half high", () => {
    const r = regs();
    voice(r, 0, { wave: WAVE.PULSE, hz: HZ });
    const out = render(r, N);
    expect(crossings(out)).toBeGreaterThanOrEqual(SIGN_CHANGES - 1);
    expect(crossings(out)).toBeLessThanOrEqual(SIGN_CHANGES);
    const values = new Set<number>();
    for (let i = 0; i < N; i++) values.add(out[i] as number);
    expect(values.size).toBe(2); // a pulse is two-valued and nothing else
    let high = 0;
    for (let i = 0; i < N; i++) if ((out[i] as number) > 0) high++;
    expect(high / N).toBeCloseTo(0.5, 2);
  });

  it("DUTY 0 is a square and DUTY 64 is a quarter-width pulse", () => {
    const wide = regs();
    voice(wide, 0, { wave: WAVE.PULSE, hz: HZ, duty: 0 });
    const narrow = regs();
    voice(narrow, 0, { wave: WAVE.PULSE, hz: HZ, duty: 64 });

    const a = render(wide, N);
    const b = render(narrow, N);
    let ha = 0;
    let hb = 0;
    for (let i = 0; i < N; i++) {
      if ((a[i] as number) > 0) ha++;
      if ((b[i] as number) > 0) hb++;
    }
    expect(ha / N).toBeCloseTo(0.5, 2);
    expect(hb / N).toBeCloseTo(0.25, 2);
  });

  it("a triangle crosses twice a period and moves in small steps", () => {
    const r = regs();
    voice(r, 0, { wave: WAVE.TRIANGLE, hz: HZ });
    const out = render(r, N);
    expect(crossings(out)).toBeGreaterThanOrEqual(SIGN_CHANGES - 1);
    expect(crossings(out)).toBeLessThanOrEqual(SIGN_CHANGES);
    let biggest = 0;
    for (let i = 1; i < N; i++) {
      const d = Math.abs((out[i] as number) - (out[i - 1] as number));
      if (d > biggest) biggest = d;
    }
    // 4 / 100 samples per period, scaled by the 0.25 mix headroom.
    expect(biggest).toBeLessThan(0.02);
  });

  it("a saw crosses once a period and falls off a cliff once a period", () => {
    const r = regs();
    voice(r, 0, { wave: WAVE.SAW, hz: HZ });
    const out = render(r, N);
    expect(crossings(out)).toBeGreaterThanOrEqual(SIGN_CHANGES - 1);
    expect(crossings(out)).toBeLessThanOrEqual(SIGN_CHANGES);
    // One cliff per period and a rising ramp everywhere else: that is what
    // separates a saw from a triangle, not the crossing count.
    let cliffs = 0;
    let falls = 0;
    for (let i = 1; i < N; i++) {
      const d = (out[i] as number) - (out[i - 1] as number);
      if (d < -0.3) cliffs++;
      else if (d < 0) falls++;
    }
    expect(cliffs).toBeGreaterThanOrEqual(PERIODS - 1);
    expect(cliffs).toBeLessThanOrEqual(PERIODS);
    expect(falls).toBe(0);
  });

  it("noise is two-valued and does not repeat inside a short window", () => {
    const r = regs();
    voice(r, 0, { wave: WAVE.NOISE, hz: 1500 });
    const out = render(r, 8192);

    const values = new Set<number>();
    for (let i = 0; i < out.length; i++) values.add(out[i] as number);
    expect(values.size).toBe(2);

    let same = 0;
    for (let i = 0; i < 4096; i++) if (out[i] === out[i + 4096]) same++;
    // A period of 4096 would make every pair equal. The LFSR's period is 32767
    // clocks, so the halves are uncorrelated and land near half agreement.
    expect(same).toBeGreaterThan(1500);
    expect(same).toBeLessThan(2600);
    expect(crossings(out)).toBeGreaterThan(100);
  });

  it("the wavetable plays the nibbles it is given, signed", () => {
    const r = regs();
    voice(r, 0, { wave: WAVE.WAVETABLE, hz: HZ });
    // Steps 0..15 = +7, steps 16..31 = -8: a square, built by hand.
    for (let k = 0; k < 8; k++) r[WAVETABLE_REG_OFFSET + k] = 0x77;
    for (let k = 8; k < 16; k++) r[WAVETABLE_REG_OFFSET + k] = 0x88;
    const out = render(r, N);
    expect(crossings(out)).toBeGreaterThanOrEqual(SIGN_CHANGES - 1);
    expect(crossings(out)).toBeLessThanOrEqual(SIGN_CHANGES);

    let hi = 0;
    let lo = 0;
    for (let i = 0; i < N; i++) {
      const v = out[i] as number;
      if (v > 0) hi++;
      else if (v < 0) lo++;
    }
    expect(hi).toBeGreaterThan(0);
    expect(lo).toBeGreaterThan(0);
    expect(Math.abs(hi - lo)).toBeLessThan(N * 0.02);
  });

  it("a zeroed wavetable is silence, not a full-scale DC step", () => {
    const r = regs();
    voice(r, 0, { wave: WAVE.WAVETABLE, hz: HZ });
    const out = render(r, 512);
    for (let i = 0; i < out.length; i++) expect(out[i]).toBe(0);
  });

  it("a reserved waveform id is silence, not a crash", () => {
    const r = regs();
    voice(r, 0, { wave: 9, hz: HZ });
    const out = render(r, 512);
    for (let i = 0; i < out.length; i++) expect(out[i]).toBe(0);
  });
});

describe("the envelope", () => {
  it("with a zeroed ADSR a gated channel is simply on at full level", () => {
    const r = regs();
    voice(r, 0, { wave: WAVE.PULSE, hz: 480 });
    const out = render(r, 256);
    expect(Math.abs(out[0] as number)).toBeCloseTo(0.25, 6);
  });

  it("attacks, decays to the sustain level, and holds there", () => {
    const r = regs();
    // 40 ms attack, 40 ms decay, sustain at half.
    voice(r, 0, { wave: WAVE.SAW, hz: 480, env: [10, 10, 128, 0] });
    const out = render(r, SR / 4);

    const peak = (i: number): number => {
      let m = 0;
      for (let k = i; k < i + 400; k++) m = Math.max(m, Math.abs(out[k] as number));
      return m;
    };
    expect(peak(0)).toBeLessThan(peak(1600)); // still rising through the attack
    const held = peak(SR / 8);
    expect(held).toBeGreaterThan(0.1);
    expect(held).toBeCloseTo(peak(SR / 4 - 400), 2);
  });

  it("reaches exactly zero after the release, and stays there", () => {
    const r = regs();
    voice(r, 0, { wave: WAVE.PULSE, hz: 480, env: [0, 0, 0, 25] }); // 100 ms release
    const s = createSynthState();

    const held = new Float32Array(256);
    renderAudio(r, s, held, SR);
    expect(Math.abs(held[0] as number)).toBeGreaterThan(0);

    r[CH.CTRL] = CTRL_ENABLE; // gate off, still enabled: the tail must ring out
    const tail = new Float32Array(SR / 4);
    renderAudio(r, s, tail, SR);

    let lastNonZero = -1;
    for (let i = 0; i < tail.length; i++) if ((tail[i] as number) !== 0) lastNonZero = i;
    expect(lastNonZero).toBeGreaterThan(SR * 0.05);
    expect(lastNonZero).toBeLessThan(SR * 0.15);
    for (let i = lastNonZero + 1; i < tail.length; i++) expect(tail[i]).toBe(0);
  });

  it("a change in TRIG restarts the note from the beginning", () => {
    const r = regs();
    voice(r, 0, { wave: WAVE.SAW, hz: 480, env: [25, 0, 0, 0], trig: 1 });
    const s = createSynthState();
    const first = new Float32Array(512);
    renderAudio(r, s, first, SR);

    const noRetrig = new Float32Array(512);
    renderAudio(r, s, noRetrig, SR);
    expect(Math.abs(noRetrig[0] as number)).toBeGreaterThan(Math.abs(first[0] as number));

    r[CH.TRIG] = 2;
    const retrig = new Float32Array(512);
    renderAudio(r, s, retrig, SR);
    // Level back to zero and phase back to zero: the retriggered buffer is the
    // very first buffer again, sample for sample.
    expect(Array.from(retrig)).toEqual(Array.from(first));
  });
});

describe("silence", () => {
  it("a disabled channel emits exact zeros", () => {
    const r = regs();
    voice(r, 0, { wave: WAVE.NOISE, hz: 1000 });
    r[CH.CTRL] = 0; // enable bit cleared, everything else still set
    const out = render(r, 1024);
    for (let i = 0; i < out.length; i++) expect(out[i]).toBe(0);
  });

  it("an all-zero register block emits exact zeros", () => {
    const out = render(regs(), 1024);
    for (let i = 0; i < out.length; i++) expect(out[i]).toBe(0);
  });

  it("disabling a channel does not disturb the others", () => {
    const solo = regs();
    voice(solo, 2, { wave: WAVE.TRIANGLE, hz: 480 });

    const mixed = regs();
    voice(mixed, 2, { wave: WAVE.TRIANGLE, hz: 480 });
    voice(mixed, 0, { wave: WAVE.NOISE, hz: 900 });
    mixed[CH.CTRL] = 0;

    expect(render(mixed, 1024)).toEqual(render(solo, 1024));
  });
});

/**
 * The worklet copy.
 *
 * The player builds its AudioWorklet processor by serialising these two
 * functions with `Function.prototype.toString`, because the worklet lives in
 * another realm and can only be handed source text. That only works while the
 * functions name nothing outside themselves, so the property is pinned here:
 * rebuild the synth from its own source and demand bit-identical samples. A
 * module-scope constant sneaking into `renderAudio` fails this immediately, in
 * Node, without a browser.
 */
describe("the synth survives being serialised into another realm", () => {
  it("rebuilt from its own source text it renders identical samples", () => {
    const source = `${createSynthState.toString()}\n${renderAudio.toString()}\nreturn { createSynthState, renderAudio };`;
    const rebuild = new Function(source) as () => {
      createSynthState: () => SynthState;
      renderAudio: typeof renderAudio;
    };
    const other = rebuild();

    const r = regs();
    voice(r, 0, { wave: WAVE.PULSE, hz: 261.63, env: [5, 10, 120, 20] });
    voice(r, 1, { wave: WAVE.NOISE, hz: 1700, duty: 1 });
    voice(r, 2, { wave: WAVE.WAVETABLE, hz: 82.41 });
    voice(r, 3, { wave: WAVE.SAW, hz: 55 });
    for (let k = 0; k < 16; k++) r[WAVETABLE_REG_OFFSET + k] = (k * 29) & 0xff;

    const mine = createSynthState();
    const theirs = other.createSynthState();
    const a = new Float32Array(512);
    const b = new Float32Array(512);
    for (let i = 0; i < 8; i++) {
      if (i === 4) r[CH.CTRL] = CTRL_ENABLE; // release the first voice mid-run
      renderAudio(r, mine, a, SR);
      other.renderAudio(r, theirs, b, SR);
      expect(Array.from(b)).toEqual(Array.from(a));
    }
  });

  it("neither function's source names anything outside itself", () => {
    const text = `${createSynthState.toString()}${renderAudio.toString()}`;
    // Vite's SSR transform rewrites imported bindings to __vite_ssr_import_*.
    // If either function had grown one, it would appear here -- and it would be
    // a ReferenceError inside the worklet realm.
    expect(text).not.toMatch(/__vite_ssr/);
    expect(text).not.toMatch(/\bADDR\b/);
    expect(text).not.toMatch(/\bCH_STRIDE\b/);
  });
});
