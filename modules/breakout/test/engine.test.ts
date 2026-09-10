/**
 * The breakout engine, tested against a real machine.
 *
 * THIS FILE IS THE STAMPER'S STAND-IN, the same way
 * modules/topdown/test/engine.test.ts is: it reads module.toml as the stamper
 * does, builds the same `const KNOB = {...}` preamble, and hands the source to
 * `compileCart` and `createMachine`. If the stamper ever emits a different
 * preamble, this file is what says so.
 *
 * WHAT IT DOES DIFFERENTLY, AND WHY
 * ---------------------------------
 * `topdown` pairs an engine with art packs. This engine pairs with a LEVEL
 * PACK, and the level pack (`redlevels`) is being authored in parallel against
 * modules/FORMATS-breakout.md. So the fixtures here BUILD THE CHUNKS IN MEMORY
 * from that document rather than reading a pack off disk: ten 16-byte headers
 * into `DATA` at 0x7800, ten 16 x 12 grids into `MAP ` at 0x4300. That keeps
 * this suite green on its own, and it means the format -- not one pack's
 * choices -- is what is pinned.
 *
 * Every knob in this engine's manifest has a default, because nothing here
 * binds to an art pack, so there is no recipe to read and no required knob to
 * check against one. `resolve()` therefore takes the defaults and the test that
 * every knob HAS one is the check that replaces `topdown`'s.
 *
 * The scenario tests clear the block grid after boot and place exactly the
 * blocks they are about, the way the topdown suite pokes its own maps. A
 * generated field is a fine thing to look at and a terrible thing to assert on.
 *
 * The test that matters most is the last one: snapshot, 120 ticks, restore, the
 * same 120 ticks, and the framebuffers must be identical byte for byte. If any
 * engine state escaped RAM into a module variable, that is what catches it, and
 * the fix is to move the state -- never to relax the assertion.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { countTokens, fromFloat } from "@sq1/core";
import { TOKEN_BUDGET, lintCartSource } from "@sq1/cart";
import { ADDR, compileCart, createMachine, planCartData } from "@sq1/runtime";
import type { Machine } from "@sq1/runtime";

const MOD = "modules/breakout";
const ENGINE_SRC = readFileSync(`${MOD}/engine.js`, "utf8");
const ENGINE_TOML = readFileSync(`${MOD}/module.toml`, "utf8");

// ---------------------------------------------------------------------------
// Just enough TOML to read a manifest -- the same reader the platformer and
// topdown suites use, and deliberately: a third half-real parser here would
// drift from those two as well as from the stamper.
// ---------------------------------------------------------------------------

type Scalar = number | boolean | string;

function scalar(raw: string): Scalar {
  const s = raw.trim();
  if (s === "true") return true;
  if (s === "false") return false;
  if (s.startsWith('"')) return s.slice(1, -1);
  return Number(s);
}

interface Knob {
  readonly type: string;
  readonly def?: Scalar;
}

/** Every `[knobs.name]` block, in declaration order. */
function knobs(toml: string): Map<string, Knob> {
  const out = new Map<string, Knob>();
  let name = "";
  let type = "";
  let def: Scalar | undefined;
  const flush = (): void => {
    if (name !== "") out.set(name, def === undefined ? { type } : { type, def });
  };
  for (const line of toml.split(/\r?\n/)) {
    const head = /^\[knobs\.([a-z0-9_]+)\]\s*$/.exec(line.trim());
    if (head) {
      flush();
      name = head[1] as string;
      type = "";
      def = undefined;
      continue;
    }
    if (/^\[/.test(line.trim())) {
      flush();
      name = "";
      continue;
    }
    if (name === "") continue;
    const kv = /^(type|default)\s*=\s*([^#]+?)\s*(?:#.*)?$/.exec(line.trim());
    if (kv?.[1] === "type") type = scalar(kv[2] as string) as string;
    if (kv?.[1] === "default") def = scalar(kv[2] as string);
  }
  flush();
  return out;
}

const KNOBS = knobs(ENGINE_TOML);

/** `paddle_speed` -> `paddleSpeed`, the stamper's own rule. */
function camel(s: string): string {
  return s.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase());
}

/**
 * A knob's JavaScript literal. `fromFloat` comes FROM @sq1/core rather than
 * being re-derived here: there is one float-to-fixed conversion in this
 * repository and the stamper's `bind` uses the same one.
 */
function literal(k: Knob, v: Scalar): string {
  if (k.type === "fixed") return `${fromFloat(v as number)} / 65536`;
  if (k.type === "bool") return v === true ? "true" : "false";
  return String(v);
}

function resolve(): Map<string, Scalar> {
  const out = new Map<string, Scalar>();
  for (const [name, k] of KNOBS) {
    if (k.def === undefined) throw new Error(`knob "${name}" has no default`);
    out.set(name, k.def);
  }
  return out;
}

const VALUES = resolve();

function preamble(): string {
  const pairs: string[] = [];
  for (const [name, k] of KNOBS) pairs.push(`${camel(name)}: ${literal(k, VALUES.get(name)!)}`);
  return `const KNOB = { ${pairs.join(", ")} };\n`;
}

const SOURCE = preamble() + ENGINE_SRC;

// ---------------------------------------------------------------------------
// The knob values this file needs by name.
// ---------------------------------------------------------------------------

const GW = VALUES.get("grid_w") as number;
const GH = VALUES.get("grid_h") as number;
const BW = VALUES.get("block_w") as number;
const BH = VALUES.get("block_h") as number;
const TOP = VALUES.get("field_top") as number;
const CEIL = VALUES.get("ceiling_y") as number;
const BS = VALUES.get("ball_size") as number;
const MB = VALUES.get("max_balls") as number;
const MD = VALUES.get("max_drops") as number;
const MS = VALUES.get("max_shots") as number;
const PADY = VALUES.get("paddle_y") as number;
const PADH = VALUES.get("paddle_h") as number;
const BEAMY = VALUES.get("beam_y") as number;
const LIVES = VALUES.get("lives") as number;
const PAD_ZONE = VALUES.get("pad_zone") as number;
const SHOT_SPEED = VALUES.get("shot_speed") as number;
const LEVEL_COUNT = VALUES.get("level_count") as number;
const C_BEAM = VALUES.get("beam_color") as number;
const C_BG = VALUES.get("bg_color") as number;
const MF = VALUES.get("max_fx") as number;
const FXF = VALUES.get("fx_frames") as number;
const SB = VALUES.get("sprite_base") as number;
const RED_FLASH = VALUES.get("red_flash") as number;

// ---------------------------------------------------------------------------
// The fixture chunks, built from modules/FORMATS-breakout.md.
// ---------------------------------------------------------------------------

/** Header field offsets, quoted from the format document. */
const H_MECH = 0;
const H_SPEED = 1;
const H_PADW = 2;
const H_DROPR = 4;
const H_DROPM = 5;
const H_COUNT = 6;
const H_DRIFT = 7;
const H_PADS = 8;
const H_AMMO = 9;

/** Base paddle width of level `L`. Distinct per level, so a load is visible. */
function padWidthOf(L: number): number {
  return 20 + L;
}

/**
 * Ten 16-byte headers. MECHANIC is 9 -- everything on -- for every fixture
 * level, so a scenario turns a mechanic OFF by poking the byte rather than
 * having to reach a particular level to turn one on.
 */
function dataChunk(): Uint8Array {
  const d = new Uint8Array(10 * 16);
  for (let L = 0; L < 10; L++) {
    const o = L * 16;
    d[o + H_MECH] = 9;
    d[o + H_SPEED] = 16; // exactly one pixel a frame
    d[o + H_PADW] = padWidthOf(L);
    d[o + 3] = 1; // RED_COUNT, which the engine does not read
    d[o + H_DROPR] = 0;
    d[o + H_DROPM] = 0;
    d[o + H_COUNT] = 1;
    d[o + H_DRIFT] = 0;
    d[o + H_PADS] = 0;
    d[o + H_AMMO] = 0;
  }
  return d;
}

/**
 * Ten grids, `level L -> column (L % 8) * 16, row (L / 8) * 12`.
 *
 * Four rows of every block type, so the boot-time field and the state
 * containment run exercise red blocks, tough blocks, drifters, solids and
 * shielded blocks without any scenario having to build them.
 */
function mapChunk(): Uint8Array {
  const m = new Uint8Array(8192);
  const pattern = [1, 1, 2, 1, 4, 1, 8, 1, 1, 3, 1, 7, 1, 6, 1, 5];
  for (let L = 0; L < 10; L++) {
    const bx = (L % 8) * GW;
    const by = ((L / 8) | 0) * GH;
    for (let r = 0; r < 4; r++) {
      for (let c = 0; c < GW; c++) m[(by + r) * 128 + bx + c] = pattern[(c + r) % 16] as number;
    }
  }
  return m;
}

const DATA = planCartData([
  { type: "MAP ", data: mapChunk() },
  { type: "DATA", data: dataChunk() },
]).data;

// ---------------------------------------------------------------------------
// A SPRITE SHEET BUILT IN MEMORY, for the same reason the level chunks are.
//
// `arcade` is drawing the real one against modules/FORMATS-breakout-art.md
// right now, and a suite that waited for it would be a suite that could not run
// today and would pin one pack's pixels tomorrow. So this builds sixty-four
// cells whose pixels ENCODE THEIR OWN CELL NUMBER, which is the one property a
// test of "did it blit the right cell" actually needs.
//
// Cell `n` carries `n` in its top-left three pixels, offset by two so that
// nothing drawn is distinguishable from an empty background (slot 1 by
// default), and is otherwise a flat body colour so the cell is opaque:
//
//     (0, 0) = 2 + (n >> 4)          (1, 0) = 2 + (n & 7)
//     (2, 0) = 2 + ((n >> 3) & 1)    the rest = 6
//
// Those three carry all six bits of a cell number under 64, so `cellDrawn`
// reads a blit straight back out of the framebuffer.
// ---------------------------------------------------------------------------

const SHEET_BODY = 6;

/** One 4bpp sheet pixel. Even x is the low nibble -- raster.ts is normative. */
function poke4(sheet: Uint8Array, x: number, y: number, c: number): void {
  const i = y * 64 + (x >> 1);
  sheet[i] = x & 1 ? (sheet[i]! & 0x0f) | (c << 4) : (sheet[i]! & 0xf0) | c;
}

/** 256 flag bytes, then four sheet rows of cells. `GFX ` carries flags first. */
function gfxChunk(): Uint8Array {
  const g = new Uint8Array(256 + 2048);
  const px = g.subarray(256);
  for (let n = 0; n < 64; n++) {
    const cx = (n & 15) * 8;
    const cy = (n >> 4) * 8;
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) poke4(px, cx + x, cy + y, SHEET_BODY);
    }
    poke4(px, cx, cy, 2 + (n >> 4));
    poke4(px, cx + 1, cy, 2 + (n & 7));
    poke4(px, cx + 2, cy, 2 + ((n >> 3) & 1));
  }
  return g;
}

const ART = planCartData([
  { type: "MAP ", data: mapChunk() },
  { type: "DATA", data: dataChunk() },
  { type: "GFX ", data: gfxChunk() },
]).data;

// ---------------------------------------------------------------------------
// A SOUND BANK BUILT IN MEMORY, for the same reason the level chunks are.
//
// `redsound` is writing the real one against modules/FORMATS-breakout-art.md,
// and a suite that read it off disk would pin one bank's bytes rather than this
// engine's wiring. What "did it play the right effect on the right channel"
// actually needs is only that an effect be OBSERVABLE, and it is: `snd.sfx(n,
// ch)` writes `n + 1` into channel `ch`'s SEQ_SFX register at
// `0x2110 + ch * 16 + 0xC`, and the sequencer leaves it there until the effect
// runs out of steps.
//
// So all 32 slots here are the same shape: 32 steps at 255 frames each. No test
// in this file runs long enough to reach the end of one, which makes a channel's
// SEQ_SFX exactly "the last effect started here" -- and that is the whole
// assertion. WITH AN EMPTY BANK IT WOULD NOT BE: a zero-length effect is
// released by the very next `tickAudio`, so a sound would be gone before
// anything could look at it, and every one of these tests would pass by
// accident on an engine that played nothing.
// ---------------------------------------------------------------------------

const SFX_SLOTS = 32;
const SFX_BYTES = 104;

function sfxChunk(): Uint8Array {
  const s = new Uint8Array(SFX_SLOTS * SFX_BYTES);
  for (let n = 0; n < SFX_SLOTS; n++) {
    const o = n * SFX_BYTES;
    s[o + 0] = 255; // SPEED: 255 frames to a step
    s[o + 1] = 32; // LENGTH: every step used
    for (let k = 0; k < 32; k++) {
      s[o + 8 + k * 3 + 0] = 60; // NOTE, well inside 0..95 so it is not a rest
      s[o + 8 + k * 3 + 1] = 0xf0; // MIX: volume 15, pulse
    }
  }
  return s;
}

const SOUND = planCartData([
  { type: "MAP ", data: mapChunk() },
  { type: "DATA", data: dataChunk() },
  { type: "SFX ", data: sfxChunk() },
]).data;

/** One channel's 16-byte register block, and the sequencer byte inside it. */
const CH_STRIDE = 16;
const CH_SEQ_SFX = 0xc;

// ---------------------------------------------------------------------------
// The engine's RAM, quoted from the block comment at the top of engine.js.
// ---------------------------------------------------------------------------

const SUB = 16;
const S = 0x7900;
const G_LEVEL = S + 0;
const G_LIVES = S + 1;
const G_STATE = S + 2;
const G_PADX = S + 4;
const G_PADW = S + 6;
const G_AMMO = S + 7;
const G_WIDE = S + 8;
const G_SLOW = S + 9;
const G_CATCH = S + 10;
const G_DRIFT = S + 12;
const G_ROWS = S + 16;
const G_DEAD = S + 18;
const G_ART = S + 19;
const G_BALLS = S + 24;
const G_DROPS = G_BALLS + MB * 10;
const G_SHOTS = G_DROPS + MD * 4;
const G_BLOCKS = G_SHOTS + MS * 3;
const G_FX = G_BLOCKS + GW * GH;

const B_X = 0;
const B_Y = 2;
const B_VX = 4;
const B_VY = 6;
const B_F = 8;

const BTN_LEFT = 1 << 2;
const BTN_RIGHT = 1 << 3;
const BTN_A = 1 << 4;
const BTN_B = 1 << 5;

function ball(i: number): number {
  return G_BALLS + i * 10;
}

function r16(m: Machine, a: number): number {
  const v = m.ram[a]! | (m.ram[a + 1]! << 8);
  return v > 32767 ? v - 65536 : v;
}

function w16(m: Machine, a: number, v: number): void {
  m.ram[a] = v & 0xff;
  m.ram[a + 1] = (v >> 8) & 0xff;
}

/** The header byte of level `L`, live in RAM, where the engine reads it. */
function header(m: Machine, L: number, field: number, v: number): void {
  m.ram[ADDR.USER_RAM + L * 16 + field] = v;
}

function blockAt(m: Machine, r: number, c: number): number {
  return m.ram[G_BLOCKS + r * GW + c]!;
}

function setBlock(m: Machine, r: number, c: number, type: number, hits = 1): void {
  m.ram[G_BLOCKS + r * GW + c] = type | (hits << 4);
}

/** A framebuffer pixel, straight out of RAM. The draw remap is the identity. */
function pixel(m: Machine, x: number, y: number): number {
  const b = m.ram[ADDR.FRAMEBUFFER + (y << 6) + (x >> 1)]!;
  return x & 1 ? b >> 4 : b & 15;
}

function run(m: Machine, frames: number, buttons = 0): void {
  const input = new Uint8Array(4);
  input[0] = buttons;
  for (let i = 0; i < frames; i++) m.tick(input);
}

function boot(): Machine {
  const m = createMachine(compileCart(SOURCE, { name: "breakout" }), { data: DATA });
  m.boot(1);
  return m;
}

/** The same cart with a sheet installed, which is the only difference. */
function bootArt(): Machine {
  const m = createMachine(compileCart(SOURCE, { name: "breakout" }), { data: ART });
  m.boot(1);
  return m;
}

/** The same cart with a sound bank installed, which is the only difference. */
function bootSnd(): Machine {
  const m = createMachine(compileCart(SOURCE, { name: "breakout" }), { data: SOUND });
  m.boot(1);
  return m;
}

/** A knob's value by name, for the sfx table below. */
function sfxId(name: string): number {
  return VALUES.get(name) as number;
}

/**
 * The effect sounding on channel `ch`, straight out of the audio registers, or
 * -1 for silence. THIS IS HOW A TEST HEARS: the engine has no other way to
 * report a sound and needs none, because `snd.sfx` writes RAM like everything
 * else and RAM is what a snapshot carries.
 */
function playing(m: Machine, ch: number): number {
  return m.ram[ADDR.AUDIO_CH + ch * CH_STRIDE + CH_SEQ_SFX]! - 1;
}

/** Silence all four, so the next assertion is about a sound made SINCE here. */
function hush(m: Machine): void {
  for (let c = 0; c < 4; c++) m.ram[ADDR.AUDIO_CH + c * CH_STRIDE + CH_SEQ_SFX] = 0;
}

/**
 * Which sheet cell was blitted with its top-left at (x, y), read back out of
 * the framebuffer. -1 when nothing was: the encoding starts at 2, so an
 * untouched background pixel cannot be mistaken for cell 0.
 */
function cellDrawn(m: Machine, x: number, y: number): number {
  const a = pixel(m, x, y);
  const b = pixel(m, x + 1, y);
  const c = pixel(m, x + 2, y);
  if (a < 2 || b < 2 || c < 2) return -1;
  return ((a - 2) << 4) | ((c - 2) << 3) | (b - 2);
}

/**
 * A cleared field with ONE plain block parked in the top-left corner.
 *
 * The keeper matters: the engine advances the level the moment no breakable
 * block is left, so a scenario on a genuinely empty grid would load level 1
 * underneath itself on the first tick. Row 0 column 0 is out of the way of
 * everything these tests do.
 */
function field(m: Machine): Machine {
  m.ram.fill(0, G_BLOCKS, G_BLOCKS + GW * GH);
  setBlock(m, 0, 0, 1, 1);
  m.ram.fill(0, G_DROPS, G_BLOCKS);
  for (let i = 0; i < MB; i++) m.ram[ball(i) + B_F] = 0;
  m.ram[ball(0) + B_F] = 5; // alive and stuck: an inert serve
  return m;
}

/** Ball 0, alive, off the paddle, at a pixel position with a subpixel velocity. */
function freeBall(m: Machine, x: number, y: number, vx: number, vy: number, red = false): number {
  const b = ball(0);
  for (let i = 1; i < MB; i++) m.ram[ball(i) + B_F] = 0;
  w16(m, b + B_X, x * SUB);
  w16(m, b + B_Y, y * SUB);
  w16(m, b + B_VX, vx);
  w16(m, b + B_VY, vy);
  m.ram[b + B_F] = red ? 3 : 1;
  return b;
}

function bx(m: Machine, i = 0): number {
  return r16(m, ball(i) + B_X) >> 4;
}
function by(m: Machine, i = 0): number {
  return r16(m, ball(i) + B_Y) >> 4;
}
function padX(m: Machine): number {
  return r16(m, G_PADX) >> 4;
}

/** Park the paddle at a pixel column, out of a falling ball's way. */
function movePaddle(m: Machine, x: number): void {
  w16(m, G_PADX, x * SUB);
}

/**
 * Run until ball 0's velocity on `axis` changes sign, and answer how many
 * frames it took. The assertion afterwards is about the frame the bounce
 * happened on: a frame later the ball has already left the wall it touched.
 */
function untilBounce(m: Machine, axis: 0 | 1, limit = 40): number {
  const addr = ball(0) + (axis ? B_VY : B_VX);
  const was = r16(m, addr) < 0 ? -1 : 1;
  let n = 0;
  while (n++ < limit) {
    run(m, 1);
    const now = r16(m, addr);
    if ((now < 0 ? -1 : 1) !== was) return n;
  }
  return -1;
}

/**
 * Nudge the ball into the block at (5, 8) from below, once.
 *
 * Two ticks is exactly one contact: at one pixel a frame the ball starts at row
 * 6 and reaches row 5 on the second tick, bounces, and is heading away again.
 */
function tap(m: Machine): void {
  freeBall(m, 65, TOP + 6 * BH + 1, 0, -SUB);
  run(m, 2);
}

// ===========================================================================

describe("the breakout engine as a cart", () => {
  it("names only knobs its manifest declares", () => {
    const used = new Set<string>();
    for (const mm of ENGINE_SRC.matchAll(/KNOB\.([A-Za-z0-9]+)/g)) used.add(mm[1] as string);

    const declared = new Set<string>();
    for (const name of KNOBS.keys()) declared.add(camel(name));

    expect([...used].filter((k) => !declared.has(k)).sort(), "read but not declared").toEqual([]);
    expect([...declared].filter((k) => !used.has(k)).sort(), "declared but never read").toEqual([]);
  });

  it("gives every knob a doc and a default", () => {
    // A knob without a sentence saying what it does is a magic number with a
    // longer name. And this engine binds to no art pack, so nothing about it
    // has to be supplied by a recipe: every knob is defaulted, and a recipe may
    // set as few as none.
    const undocumented: string[] = [];
    let name = "";
    let doc = false;
    for (const line of ENGINE_TOML.split(/\r?\n/)) {
      const head = /^\[knobs\.([a-z0-9_]+)\]\s*$/.exec(line.trim());
      if (head) {
        if (name !== "" && !doc) undocumented.push(name);
        name = head[1] as string;
        doc = false;
        continue;
      }
      if (/^\[/.test(line.trim())) {
        if (name !== "" && !doc) undocumented.push(name);
        name = "";
        continue;
      }
      if (/^doc\s*=/.test(line.trim())) doc = true;
    }
    if (name !== "" && !doc) undocumented.push(name);
    expect(undocumented).toEqual([]);

    expect([...KNOBS].filter(([, k]) => k.def === undefined).map(([n]) => n)).toEqual([]);
    expect(KNOBS.size).toBeGreaterThan(40);
  });

  it("passes the build gate: no forbidden names, inside the token budget", () => {
    const result = lintCartSource(SOURCE);
    expect(result.findings.map((f) => `${f.rule} ${f.identifier ?? ""} @${f.line}`)).toEqual([]);
    expect(result.tokens).toBeLessThan(TOKEN_BUDGET);
    console.log(
      `breakout: engine ${countTokens(ENGINE_SRC)} tokens, ` +
        `stamped cart ${result.tokens} of ${TOKEN_BUDGET}`,
    );
  });

  it("boots and ticks without throwing", () => {
    const m = boot();
    expect(() => run(m, 120)).not.toThrow();
    expect(m.ram[G_LIVES]).toBe(LIVES);
  });

  it("reads level 1 out of the DATA header rather than hard-coding it", () => {
    const m = boot();
    expect(m.ram[G_LEVEL]).toBe(0);
    expect(m.ram[G_PADW], "paddle width comes from the header").toBe(padWidthOf(0));
    expect(padX(m), "and the paddle is centred on it").toBe(64 - (padWidthOf(0) >> 1));
  });

  it("reads the block grid out of the MAP chunk", () => {
    // The fixture fills four rows; the rest of the level must be empty, and the
    // types must be the pattern the chunk carries -- not anything the engine
    // decided for itself.
    const m = boot();
    const pattern = [1, 1, 2, 1, 4, 1, 8, 1, 1, 3, 1, 7, 1, 6, 1, 5];
    for (let r = 0; r < GH; r++) {
      for (let c = 0; c < GW; c++) {
        const want = r < 4 ? (pattern[(c + r) % 16] as number) : 0;
        expect(blockAt(m, r, c) & 15, `block at (${r}, ${c})`).toBe(want);
      }
    }
    // The drifting-row mask is derived from where the type-7 blocks landed.
    let rows = 0;
    for (let r = 0; r < GH; r++) {
      for (let c = 0; c < GW; c++) if ((blockAt(m, r, c) & 15) === 7) rows |= 1 << r;
    }
    expect(r16(m, G_ROWS)).toBe(rows);
  });
});

describe("the paddle", () => {
  it("moves left and right and clamps at both walls", () => {
    const m = field(boot());
    const start = padX(m);
    run(m, 10, BTN_RIGHT);
    const east = padX(m);
    expect(east).toBeGreaterThan(start);
    run(m, 5, BTN_LEFT);
    expect(padX(m), "and back again").toBeLessThan(east);

    run(m, 300, BTN_LEFT);
    expect(padX(m), "clamped at the west wall").toBe(0);

    run(m, 300, BTN_RIGHT);
    expect(padX(m) + m.ram[G_PADW]!, "clamped at the east wall").toBe(128);
  });
});

describe("the ball", () => {
  it("bounces off the west wall", () => {
    const m = field(boot());
    movePaddle(m, 60);
    freeBall(m, 1, 60, -SUB, 0);
    expect(untilBounce(m, 0), "it reached the wall").toBeGreaterThan(0);
    expect(bx(m)).toBe(0);
    expect(r16(m, ball(0) + B_VX), "and is heading east again").toBeGreaterThan(0);
  });

  it("bounces off the east wall", () => {
    const m = field(boot());
    movePaddle(m, 60);
    freeBall(m, 128 - BS - 1, 60, SUB, 0);
    expect(untilBounce(m, 0)).toBeGreaterThan(0);
    expect(bx(m) + BS).toBe(128);
    expect(r16(m, ball(0) + B_VX)).toBeLessThan(0);
  });

  it("bounces off the ceiling", () => {
    const m = field(boot());
    movePaddle(m, 60);
    freeBall(m, 60, CEIL + 2, 0, -SUB);
    expect(untilBounce(m, 1)).toBeGreaterThan(0);
    expect(by(m)).toBe(CEIL);
    expect(r16(m, ball(0) + B_VY), "and is heading down again").toBeGreaterThan(0);
  });

  it("is returned by the paddle, angled by where it landed", () => {
    const m = field(boot());
    movePaddle(m, 50);
    const w = m.ram[G_PADW]!;
    // Left of centre must come back going left; right of centre, going right.
    freeBall(m, 50, PADY - BS - 1, 0, SUB);
    run(m, 2);
    expect(r16(m, ball(0) + B_VY), "returned upward").toBeLessThan(0);
    expect(r16(m, ball(0) + B_VX), "and angled left").toBeLessThan(0);

    freeBall(m, 50 + w - BS, PADY - BS - 1, 0, SUB);
    run(m, 2);
    expect(r16(m, ball(0) + B_VX), "angled right").toBeGreaterThan(0);
  });

  it("never tunnels through a block, however fast the header makes it", () => {
    // BALL_SPEED 255 is just under sixteen pixels a frame, and a block is six
    // pixels tall. Substepping is the only reason this passes.
    const m = field(boot());
    header(m, 0, H_SPEED, 255);
    movePaddle(m, 0);
    for (let c = 0; c < GW; c++) setBlock(m, 8, c, 1, 1);
    freeBall(m, 64, TOP + 11 * BH, 0, -255);
    run(m, 1);
    let solid = 0;
    for (let c = 0; c < GW; c++) if (blockAt(m, 8, c) !== 0) solid++;
    expect(solid, "the wall of blocks stopped it").toBe(GW - 1);
    expect(by(m), "and it is below the wall it broke into").toBeGreaterThan(TOP + 8 * BH);
  });
});

describe("blocks", () => {
  it("breaks a plain block in one hit", () => {
    const m = field(boot());
    movePaddle(m, 0);
    setBlock(m, 5, 8, 1, 1);
    tap(m);
    expect(blockAt(m, 5, 8)).toBe(0);
  });

  it("takes two hits to break a tough block, and shows the damage", () => {
    const m = field(boot());
    movePaddle(m, 0);
    setBlock(m, 5, 8, 2, 2);
    tap(m);
    expect(blockAt(m, 5, 8) & 15, "still there").toBe(2);
    expect(blockAt(m, 5, 8) >> 4, "one hit left").toBe(1);
    tap(m);
    expect(blockAt(m, 5, 8)).toBe(0);
  });

  it("draws a damaged tough block in a different colour", () => {
    // "shows damage after the first hit" is the whole of the tough block's
    // teaching, so it is worth an assertion on actual pixels.
    const m = field(boot());
    movePaddle(m, 0);
    setBlock(m, 5, 8, 2, 2);
    run(m, 1);
    expect(pixel(m, 66, TOP + 5 * BH + 2)).toBe(VALUES.get("color_tough"));
    tap(m);
    expect(pixel(m, 66, TOP + 5 * BH + 2)).toBe(VALUES.get("color_damaged"));
  });

  it("takes three hits to break a hard block", () => {
    const m = field(boot());
    movePaddle(m, 0);
    setBlock(m, 5, 8, 3, 3);
    tap(m);
    expect(blockAt(m, 5, 8) >> 4).toBe(2);
    tap(m);
    expect(blockAt(m, 5, 8) >> 4).toBe(1);
    tap(m);
    expect(blockAt(m, 5, 8)).toBe(0);
  });

  it("never breaks a solid block, and still bounces off it", () => {
    const m = field(boot());
    movePaddle(m, 0);
    setBlock(m, 5, 8, 5, 1);
    tap(m);
    expect(blockAt(m, 5, 8) & 15).toBe(5);
    expect(r16(m, ball(0) + B_VY), "the ball came back down").toBeGreaterThan(0);
  });

  it("advances to the next level when every breakable block is gone", () => {
    const m = field(boot());
    m.ram.fill(0, G_BLOCKS, G_BLOCKS + GW * GH);
    // Solid blocks are scenery: a field of nothing but solids is cleared.
    setBlock(m, 3, 3, 5, 1);
    run(m, 1);
    expect(m.ram[G_LEVEL], "moved on").toBe(1);
    expect(m.ram[G_PADW], "and level 2's header is loaded").toBe(padWidthOf(1));
    // And the next level's blocks came out of the MAP chunk, not level 1's.
    expect(blockAt(m, 0, 0) & 15).toBe(1);
  });

  it("wins the game rather than reading an eleventh header", () => {
    const m = field(boot());
    m.ram[G_LEVEL] = LEVEL_COUNT - 1;
    m.ram.fill(0, G_BLOCKS, G_BLOCKS + GW * GH);
    run(m, 1);
    expect(m.ram[G_STATE]).toBe(2);
    expect(m.ram[G_LEVEL]).toBe(LEVEL_COUNT - 1);
  });
});

// ===========================================================================
// The red ball. This is the game, so it is the longest block in the file.
// ===========================================================================

describe("the red ball", () => {
  function redBall(m: Machine): number {
    return m.ram[ball(0) + B_F]! & 2;
  }

  it("turns RED when a type-4 block breaks", () => {
    const m = field(boot());
    movePaddle(m, 0);
    setBlock(m, 5, 8, 4, 1);
    tap(m);
    expect(blockAt(m, 5, 8), "the red block broke in one hit").toBe(0);
    expect(redBall(m), "and the ball is RED").toBe(2);
  });

  it("does not turn RED before the mechanic is live", () => {
    // MECHANIC selects. Below mech_red a type-4 block is an ordinary block, so
    // level one can hold one without teaching the wrong lesson.
    const m = field(boot());
    header(m, 0, H_MECH, 0);
    movePaddle(m, 0);
    setBlock(m, 5, 8, 4, 1);
    tap(m);
    expect(blockAt(m, 5, 8)).toBe(0);
    expect(redBall(m)).toBe(0);
  });

  it("draws the beam below the paddle while RED, and only then", () => {
    const m = field(boot());
    movePaddle(m, 0);
    freeBall(m, 60, 60, 0, 0);
    run(m, 1);
    expect(pixel(m, 40, BEAMY), "no beam for a normal ball").toBe(C_BG);

    freeBall(m, 60, 60, 0, 0, true);
    run(m, 1);
    expect(pixel(m, 40, BEAMY), "the beam is drawn while RED").toBe(C_BEAM);
    expect(BEAMY, "and it is BELOW the paddle").toBeGreaterThan(PADY);

    // Clear the ball and the beam goes with it.
    m.ram[ball(0) + B_F] = 1;
    run(m, 1);
    expect(pixel(m, 40, BEAMY)).toBe(C_BG);
  });

  it("costs a life when it touches the paddle, and resets to NORMAL", () => {
    const m = field(boot());
    movePaddle(m, 50);
    freeBall(m, 55, PADY - BS + 1, 0, SUB, true);
    expect(m.ram[G_LIVES]).toBe(LIVES);
    run(m, 1);
    expect(m.ram[G_LIVES], "a life gone").toBe(LIVES - 1);
    expect(m.ram[ball(0) + B_F]! & 2, "and the ball is NORMAL again").toBe(0);
    expect(m.ram[G_PADW], "the paddle is rebuilt at the header's width").toBe(padWidthOf(0));
  });

  it("bounces off a wall and clears, rather than costing anything", () => {
    const m = field(boot());
    movePaddle(m, 0);
    freeBall(m, 1, 60, -SUB, 0, true);
    expect(untilBounce(m, 0)).toBeGreaterThan(0);
    expect(bx(m)).toBe(0);
    expect(r16(m, ball(0) + B_VX), "bounced").toBeGreaterThan(0);
    expect(redBall(m), "and cleared").toBe(0);
    expect(m.ram[G_LIVES], "no life lost").toBe(LIVES);
  });

  it("bounces off the ceiling and clears", () => {
    const m = field(boot());
    movePaddle(m, 0);
    freeBall(m, 60, CEIL + 2, 0, -SUB, true);
    expect(untilBounce(m, 1)).toBeGreaterThan(0);
    expect(by(m)).toBe(CEIL);
    expect(redBall(m)).toBe(0);
  });

  it("bounces off a block and clears", () => {
    const m = field(boot());
    movePaddle(m, 0);
    setBlock(m, 5, 8, 5, 1); // solid, so nothing else changes
    freeBall(m, 65, TOP + 6 * BH + 1, 0, -SUB, true);
    run(m, 2);
    expect(r16(m, ball(0) + B_VY)).toBeGreaterThan(0);
    expect(redBall(m)).toBe(0);
  });

  it("is deflected by the beam, which clears it", () => {
    // The player's escape: move the paddle aside and let the beam take it.
    const m = field(boot());
    movePaddle(m, 0);
    freeBall(m, 100, BEAMY - BS - 2, 0, SUB, true);
    let guard = 0;
    while (r16(m, ball(0) + B_VY) > 0 && guard++ < 30) run(m, 1);
    expect(guard, "the beam caught it").toBeLessThan(30);
    expect(by(m)).toBe(BEAMY - BS);
    expect(redBall(m), "and cleared it").toBe(0);
    expect(m.ram[ball(0) + B_F]! & 1, "the ball is still in play").toBe(1);
    expect(m.ram[G_LIVES]).toBe(LIVES);
  });

  it("is cleared by a shot, which is the skilled way out", () => {
    const m = field(boot());
    movePaddle(m, 56);
    m.ram[G_AMMO] = 1;
    freeBall(m, 66, 60, 0, 0, true);
    run(m, 1); // a frame with nothing held, so btnp sees a new press
    run(m, 1, BTN_B);
    expect(m.ram[G_AMMO], "the shot was spent").toBe(0);
    run(m, 20);
    expect(redBall(m), "the shot cleared the red ball").toBe(0);
    expect(m.ram[ball(0) + B_F]! & 1, "and the ball survived").toBe(1);
    expect(m.ram[G_LIVES]).toBe(LIVES);
  });
});

describe("the beam is not a floor", () => {
  it("lets a NORMAL ball fall straight past it, and the ball is lost", () => {
    // THE TEST THAT STOPS THE BEAM QUIETLY BECOMING A FLOOR. If a normal ball
    // ever bounced here, the game would have no way to end.
    const m = field(boot());
    movePaddle(m, 0);
    freeBall(m, 100, PADY + 1, 0, SUB);
    let guard = 0;
    // `& 5) === 1` is "alive and NOT stuck": once the ball is lost the engine
    // parks a fresh one on the paddle in the same slot, and that replacement is
    // not the ball this test is about.
    while ((m.ram[ball(0) + B_F]! & 5) === 1 && guard++ < 60) {
      run(m, 1);
      if ((m.ram[ball(0) + B_F]! & 5) === 1) {
        expect(r16(m, ball(0) + B_VY), "it never turned around").toBeGreaterThan(0);
      }
    }
    expect(guard, "the ball fell off the bottom").toBeLessThan(60);
    expect(m.ram[G_LIVES], "and it cost a life").toBe(LIVES - 1);
  });
});

describe("drops", () => {
  it("falls from a broken block when DROP_RATE allows it", () => {
    const m = field(boot());
    header(m, 0, H_DROPR, 255);
    header(m, 0, H_DROPM, 1 << 4); // life, and nothing else
    movePaddle(m, 0);
    setBlock(m, 5, 8, 1, 1);
    tap(m);
    expect(m.ram[G_DROPS + 3], "a life drop is falling").toBe(5);
    const y0 = r16(m, G_DROPS + 1);
    run(m, 20);
    expect(r16(m, G_DROPS + 1), "and it is falling downward").toBeGreaterThan(y0);
  });

  it("is caught by the paddle, and the life drop adds a life", () => {
    const m = field(boot());
    movePaddle(m, 50);
    m.ram[G_DROPS] = 55;
    w16(m, G_DROPS + 1, (PADY - 6) * SUB);
    m.ram[G_DROPS + 3] = 5; // kind 4 + 1: life
    expect(m.ram[G_LIVES]).toBe(LIVES);
    run(m, 30);
    expect(m.ram[G_DROPS + 3], "caught").toBe(0);
    expect(m.ram[G_LIVES], "and it was a life").toBe(LIVES + 1);
  });

  it("applies the wide, gun, slow and catch drops", () => {
    const base = field(boot()).ram[G_PADW]!;

    const caught = (kind: number): Machine => {
      const m = field(boot());
      movePaddle(m, 50);
      m.ram[G_DROPS] = 55;
      w16(m, G_DROPS + 1, (PADY - 6) * SUB);
      m.ram[G_DROPS + 3] = kind + 1;
      run(m, 30);
      expect(m.ram[G_DROPS + 3], `drop kind ${kind} was caught`).toBe(0);
      return m;
    };

    expect(caught(0).ram[G_PADW], "wide grows the paddle").toBeGreaterThan(base);
    expect(caught(1).ram[G_SLOW], "slow starts a timer").toBeGreaterThan(0);
    expect(caught(2).ram[G_AMMO], "gun grants shots").toBeGreaterThan(0);
    expect(caught(5).ram[G_CATCH], "catch starts a timer").toBeGreaterThan(0);
  });

  it("keeps falling while the ball is RED", () => {
    // Rule 4 does not stop the world: a red ball is a problem for the paddle,
    // not for the power-up that is already in the air.
    const m = field(boot());
    movePaddle(m, 0);
    m.ram[G_DROPS] = 60;
    w16(m, G_DROPS + 1, 40 * SUB);
    m.ram[G_DROPS + 3] = 1;
    freeBall(m, 100, 60, 0, 0, true);
    const y0 = r16(m, G_DROPS + 1);
    run(m, 20);
    expect(r16(m, G_DROPS + 1)).toBeGreaterThan(y0);
  });

  it("serves BALL_COUNT balls, once, on the serve and not on a catch release", () => {
    const alive = (m: Machine): number => {
      let n = 0;
      for (let i = 0; i < MB; i++) if (m.ram[ball(i) + B_F]! & 1) n++;
      return n;
    };

    const m = field(boot());
    header(m, 0, H_COUNT, 3);
    movePaddle(m, 50);
    expect(alive(m), "one ball, waiting on the paddle").toBe(1);
    run(m, 1);
    run(m, 1, BTN_A);
    expect(alive(m), "three at the serve").toBe(3);

    // A `catch` release is not a serve. Hold one ball on a caught paddle and
    // let it go: it must not mint a fresh BALL_COUNT.
    const c = field(boot());
    header(c, 0, H_COUNT, 3);
    c.ram[G_CATCH] = 200;
    run(c, 1);
    run(c, 1, BTN_A);
    expect(alive(c), "no multiball off a catch").toBe(1);
  });

  it("splits the ball on a multi drop", () => {
    const m = field(boot());
    movePaddle(m, 50);
    freeBall(m, 60, 60, SUB, -SUB);
    m.ram[G_DROPS] = 55;
    w16(m, G_DROPS + 1, (PADY - 6) * SUB);
    m.ram[G_DROPS + 3] = 4; // kind 3 + 1: multi
    run(m, 30);
    let alive = 0;
    for (let i = 0; i < MB; i++) if (m.ram[ball(i) + B_F]! & 1) alive++;
    expect(alive, "two balls in play").toBeGreaterThan(1);
  });
});

describe("shooting", () => {
  it("a shielded block ignores a ball and breaks to a shot", () => {
    const m = field(boot());
    movePaddle(m, 0);
    setBlock(m, 5, 8, 6, 1);
    tap(m);
    expect(blockAt(m, 5, 8) & 15, "the ball bounced off it").toBe(6);
    expect(r16(m, ball(0) + B_VY), "and came back down").toBeGreaterThan(0);

    // Now shoot it. The paddle's centre lines up with column 8.
    movePaddle(m, 56);
    m.ram[G_AMMO] = 1;
    run(m, 1);
    run(m, 1, BTN_B);
    run(m, 30);
    expect(blockAt(m, 5, 8), "the shot broke it").toBe(0);
  });

  it("a shielded block is an ordinary block before the mechanic is live", () => {
    const m = field(boot());
    header(m, 0, H_MECH, 0);
    movePaddle(m, 0);
    setBlock(m, 5, 8, 6, 1);
    tap(m);
    expect(blockAt(m, 5, 8)).toBe(0);
  });

  it("charges a shot on touching a side pad, once per arrival", () => {
    const m = field(boot());
    header(m, 0, H_PADS, 1);
    movePaddle(m, PAD_ZONE + 10);
    expect(m.ram[G_AMMO]).toBe(0);
    run(m, 40, BTN_LEFT);
    expect(padX(m)).toBe(0);
    expect(m.ram[G_AMMO], "one shot for arriving").toBe(1);
    run(m, 60, BTN_LEFT);
    expect(m.ram[G_AMMO], "and parking on it does not mint more").toBe(1);
    run(m, 300, BTN_RIGHT);
    expect(m.ram[G_AMMO], "the other pad charges too").toBe(2);
  });

  it("spends ammunition, and cannot fire without it", () => {
    const m = field(boot());
    movePaddle(m, 50);
    run(m, 1);
    run(m, 1, BTN_B);
    let live = 0;
    for (let i = 0; i < MS; i++) if (m.ram[G_SHOTS + i * 3 + 2]) live++;
    expect(live, "no ammunition, no shot").toBe(0);

    m.ram[G_AMMO] = 2;
    run(m, 1);
    run(m, 1, BTN_B);
    expect(m.ram[G_AMMO]).toBe(1);
    expect(m.ram[G_SHOTS + 2], "a shot is in the air").toBe(1);
    const y0 = m.ram[G_SHOTS + 1]!;
    run(m, 1);
    expect(m.ram[G_SHOTS + 1], "and it rises").toBe(y0 - SHOT_SPEED);
  });
});

describe("drifting rows", () => {
  it("slides a row that holds a type-7 block, and turns at the limit", () => {
    const m = field(boot());
    header(m, 0, H_DRIFT, 8);
    movePaddle(m, 0);
    setBlock(m, 6, 4, 7, 1);
    m.ram[G_ROWS] = 1 << 6;
    m.ram[G_ROWS + 1] = 0;
    expect(r16(m, G_DRIFT)).toBe(0);
    run(m, 4);
    expect(r16(m, G_DRIFT), "it slid").toBeGreaterThan(0);
    run(m, 400);
    const lim = (VALUES.get("drift_range") as number) * SUB;
    expect(Math.abs(r16(m, G_DRIFT)), "and stayed inside drift_range").toBeLessThanOrEqual(lim);
  });

  it("stands still when DRIFT_SPEED is zero", () => {
    const m = field(boot());
    movePaddle(m, 0);
    setBlock(m, 6, 4, 7, 1);
    m.ram[G_ROWS] = 1 << 6;
    run(m, 60);
    expect(r16(m, G_DRIFT)).toBe(0);
  });
});

describe("lives and the end of the game", () => {
  it("loses a life when the last ball falls out of the world", () => {
    const m = field(boot());
    movePaddle(m, 0);
    freeBall(m, 100, 120, 0, SUB * 4);
    run(m, 10);
    expect(m.ram[G_LIVES]).toBe(LIVES - 1);
    expect(m.ram[ball(0) + B_F]! & 5, "and a new ball waits on the paddle").toBe(5);
  });

  it("ends the game when the last life goes", () => {
    const m = field(boot());
    movePaddle(m, 0);
    m.ram[G_LIVES] = 1;
    freeBall(m, 100, 120, 0, SUB * 4);
    run(m, 10);
    expect(m.ram[G_LIVES]).toBe(0);
    expect(m.ram[G_STATE], "game over").toBe(1);
    // And it stays over until A restarts it.
    run(m, 60);
    expect(m.ram[G_STATE]).toBe(1);
    run(m, 1);
    run(m, 1, BTN_A);
    expect(m.ram[G_STATE], "A starts a new run").toBe(0);
    expect(m.ram[G_LIVES]).toBe(LIVES);
    expect(m.ram[G_LEVEL]).toBe(0);
  });

  it("keeps playing while another ball is still up", () => {
    const m = field(boot());
    movePaddle(m, 0);
    freeBall(m, 100, 120, 0, SUB * 4);
    const o = ball(1);
    w16(m, o + B_X, 40 * SUB);
    w16(m, o + B_Y, 60 * SUB);
    w16(m, o + B_VX, 0);
    w16(m, o + B_VY, -SUB);
    m.ram[o + B_F] = 1;
    run(m, 10);
    expect(m.ram[G_LIVES], "no life lost").toBe(LIVES);
  });
});

// ===========================================================================
// Sound.
//
// Seventeen events and seventeen knobs, and the assertions below are about the
// two halves a recipe cannot fix for itself: WHICH EFFECT each event plays, and
// WHICH CHANNEL it plays on. A channel plays one thing at a time, so a shared
// channel is not a detail of the mix -- it is the engine saying that one cue
// may interrupt another, and the alarm and the deflection are exactly that.
//
// Every one of these reads the audio registers at 0x2110 out of RAM. The engine
// grew no way to report a sound and needs none.
// ===========================================================================

describe("sound", () => {
  it("defaults every sfx knob to the effect the bank gives that event", () => {
    // FORMATS-breakout-art.md owns this table; this is the engine agreeing with
    // it. The defaults were once a straight run 0..5 that lined up with nothing,
    // and `sfx_drop` therefore pointed at the WALL HIT -- a default that is a
    // plausible number rather than the right one, which nothing notices.
    const want: Array<[string, number]> = [
      ["sfx_hit", 0],
      ["sfx_break", 1],
      ["sfx_paddle", 2],
      ["sfx_wall", 3],
      ["sfx_spawn", 4],
      ["sfx_drop", 5],
      ["sfx_life", 6],
      ["sfx_shoot", 7],
      ["sfx_ping", 8],
      ["sfx_shield", 9],
      ["sfx_red", 10],
      ["sfx_deflect", 11],
      ["sfx_smash", 12],
      ["sfx_lose", 13],
      ["sfx_clear", 14],
      ["sfx_over", 15],
      ["sfx_charge", 16],
    ];
    for (const [name, id] of want) expect(VALUES.get(name), name).toBe(id);

    // No event without a number and no number without an event.
    const declared = [...KNOBS.keys()].filter((k) => k.startsWith("sfx_")).sort();
    expect(declared).toEqual(want.map(([n]) => n).sort());

    // And not one of them carries `indexes`. They are soundbank ids, not sheet
    // cells -- the near-miss rule in modules/README.md -- so `sprite_base` is
    // still the only annotated knob in the manifest.
    expect((ENGINE_TOML.match(/^indexes\s*=/gm) ?? []).length).toBe(1);
    expect(/\[knobs\.sprite_base\]\ntype\s*=[^\n]*\nindexes\s*=/.test(ENGINE_TOML)).toBe(true);
  });

  it("finds the audio registers where the machine keeps them", () => {
    // The address every assertion below reads. Quoted from
    // packages/runtime/src/audio.ts rather than assumed.
    expect(ADDR.AUDIO_CH).toBe(0x2110);
    const m = bootSnd();
    hush(m);
    for (let c = 0; c < 4; c++) expect(playing(m, c), `channel ${c} is silent`).toBe(-1);
  });

  // -------------------------------------------------------------------------
  // THE ONE THIS SUITE EXISTS FOR.
  // -------------------------------------------------------------------------

  it("sounds the alarm when the ball turns RED", () => {
    const m = field(bootSnd());
    movePaddle(m, 0);
    setBlock(m, 5, 8, 4, 1);
    hush(m);
    tap(m);
    expect(blockAt(m, 5, 8), "the red block broke").toBe(0);
    expect(m.ram[ball(0) + B_F]! & 2, "and the ball is RED").toBe(2);
    expect(playing(m, 3), "so the alarm is sounding").toBe(sfxId("sfx_red"));
    expect(playing(m, 3), "and it is not the ordinary break").not.toBe(sfxId("sfx_break"));
  });

  it("does not sound the alarm when the mechanic is not live", () => {
    // Below mech_red a type-4 block is an ordinary block, and an alarm for a
    // ball that did not turn red would be a lie the player learns to ignore.
    const m = field(bootSnd());
    header(m, 0, H_MECH, 0);
    movePaddle(m, 0);
    setBlock(m, 5, 8, 4, 1);
    hush(m);
    tap(m);
    expect(m.ram[ball(0) + B_F]! & 2).toBe(0);
    expect(playing(m, 3), "channel 3 stayed quiet").toBe(-1);
  });

  it("cuts the alarm off with the deflection, on the alarm's own channel", () => {
    // The composer put effects 10 and 11 on one channel deliberately: a channel
    // plays one thing, so the sound of relief physically interrupts the sound of
    // danger. Two effects on two channels would leave the warning warbling on
    // under the rescue.
    const m = field(bootSnd());
    movePaddle(m, 0);
    setBlock(m, 5, 8, 4, 1);
    hush(m);
    tap(m);
    expect(playing(m, 3), "the alarm is up").toBe(sfxId("sfx_red"));

    freeBall(m, 100, BEAMY - BS - 2, 0, SUB, true);
    let guard = 0;
    while (r16(m, ball(0) + B_VY) > 0 && guard++ < 30) run(m, 1);
    expect(guard, "the beam caught it").toBeLessThan(30);
    expect(by(m)).toBe(BEAMY - BS);
    expect(playing(m, 3), "the deflection took the alarm's channel").toBe(sfxId("sfx_deflect"));

    // Which is only true because they share one, so say so directly: nothing
    // else in the engine may quietly move one of them to a channel of its own.
    for (let c = 0; c < 4; c++) {
      if (c !== 3) expect(playing(m, c), `no deflection on channel ${c}`).not.toBe(sfxId("sfx_deflect"));
    }
  });

  it("tells a destroyed paddle from a merely lost ball", () => {
    // They shared `sfx_lose` once. They are different events, they cost the
    // same life, and only one of them is the worst sound in the game.
    expect(sfxId("sfx_smash"), "different effects").not.toBe(sfxId("sfx_lose"));

    const red = field(bootSnd());
    movePaddle(red, 50);
    freeBall(red, 55, PADY - BS + 1, 0, SUB, true);
    hush(red);
    run(red, 1);
    expect(red.ram[G_LIVES], "a life gone").toBe(LIVES - 1);
    expect(playing(red, 3), "the paddle was destroyed").toBe(sfxId("sfx_smash"));

    const out = field(bootSnd());
    movePaddle(out, 0);
    freeBall(out, 100, 120, 0, SUB * 4);
    hush(out);
    run(out, 10);
    expect(out.ram[G_LIVES], "the same life cost").toBe(LIVES - 1);
    expect(playing(out, 3), "but a ball merely fell out of the world").toBe(sfxId("sfx_lose"));
  });

  // -------------------------------------------------------------------------
  // The rest of the bank.
  // -------------------------------------------------------------------------

  it("sounds a wall and the ceiling, which were silent", () => {
    const side = field(bootSnd());
    movePaddle(side, 0);
    freeBall(side, 1, 60, -SUB, 0);
    hush(side);
    expect(untilBounce(side, 0)).toBeGreaterThan(0);
    expect(playing(side, 1), "the west wall").toBe(sfxId("sfx_wall"));

    const top = field(bootSnd());
    movePaddle(top, 0);
    freeBall(top, 60, CEIL + 2, 0, -SUB);
    hush(top);
    expect(untilBounce(top, 1)).toBeGreaterThan(0);
    expect(playing(top, 1), "and the ceiling with it").toBe(sfxId("sfx_wall"));
  });

  it("does not sound a wall for a block, which also bounces", () => {
    // Every contact in the game runs through `bounce`, so a wall cue placed
    // there would play on top of every block hit and every deflection. Effects
    // 0, 2 and 3 are three separable blips precisely so a player knows WHICH.
    const m = field(bootSnd());
    movePaddle(m, 0);
    setBlock(m, 5, 8, 1, 1);
    hush(m);
    tap(m);
    expect(blockAt(m, 5, 8), "it broke").toBe(0);
    expect(playing(m, 1), "the break, not the wall").toBe(sfxId("sfx_break"));

    const paddled = field(bootSnd());
    movePaddle(paddled, 50);
    freeBall(paddled, 55, PADY - BS - 1, 0, SUB);
    hush(paddled);
    run(paddled, 2);
    expect(playing(paddled, 0), "and a return is the paddle's own").toBe(sfxId("sfx_paddle"));
    expect(playing(paddled, 1), "with no wall under it").not.toBe(sfxId("sfx_wall"));
  });

  it("gives the extra life its own cue, and not the generic catch", () => {
    const caught = (kind: number): Machine => {
      const m = field(bootSnd());
      movePaddle(m, 50);
      m.ram[G_DROPS] = 55;
      w16(m, G_DROPS + 1, (PADY - 6) * SUB);
      m.ram[G_DROPS + 3] = kind + 1;
      hush(m);
      run(m, 30);
      expect(m.ram[G_DROPS + 3], `drop kind ${kind} was caught`).toBe(0);
      return m;
    };

    const life = caught(4);
    expect(life.ram[G_LIVES], "it was the life drop").toBe(LIVES + 1);
    expect(playing(life, 2), "the extra life has its own sound").toBe(sfxId("sfx_life"));
    expect(playing(life, 2)).not.toBe(sfxId("sfx_drop"));
    expect(playing(caught(0), 2), "every other drop is the catch").toBe(sfxId("sfx_drop"));
  });

  it("announces a drop when it appears, not only when it lands", () => {
    const m = field(bootSnd());
    header(m, 0, H_DROPR, 255);
    header(m, 0, H_DROPM, 1); // wide, and nothing else
    movePaddle(m, 0);
    setBlock(m, 5, 8, 1, 1);
    hush(m);
    tap(m);
    expect(m.ram[G_DROPS + 3], "something is falling").toBe(1);
    expect(playing(m, 2), "and it said so").toBe(sfxId("sfx_spawn"));
  });

  it("tells a shield that held from a shield that broke", () => {
    const m = field(bootSnd());
    movePaddle(m, 0);
    setBlock(m, 5, 8, 6, 1);
    hush(m);
    tap(m);
    expect(blockAt(m, 5, 8) & 15, "the ball bounced off it").toBe(6);
    expect(playing(m, 2), "a ping, which is `shoot this one`").toBe(sfxId("sfx_ping"));

    movePaddle(m, 56);
    m.ram[G_AMMO] = 1;
    run(m, 1);
    hush(m);
    run(m, 1, BTN_B);
    expect(playing(m, 2), "the gun").toBe(sfxId("sfx_shoot"));
    run(m, 30);
    expect(blockAt(m, 5, 8), "the shot broke it").toBe(0);
    expect(playing(m, 2), "and the shield's own break, not the plain one").toBe(sfxId("sfx_shield"));
  });

  it("ticks once when a side pad charges a shot, and not while parked on it", () => {
    const m = field(bootSnd());
    header(m, 0, H_PADS, 1);
    movePaddle(m, PAD_ZONE + 10);
    hush(m);
    run(m, 40, BTN_LEFT);
    expect(m.ram[G_AMMO], "one shot for arriving").toBe(1);
    expect(playing(m, 2), "and one tick with it").toBe(sfxId("sfx_charge"));
    hush(m);
    run(m, 60, BTN_LEFT);
    expect(m.ram[G_AMMO], "parking mints nothing").toBe(1);
    expect(playing(m, 2), "and sounds nothing").toBe(-1);
  });

  it("sounds a level cleared, including the last one", () => {
    const m = field(bootSnd());
    movePaddle(m, 0);
    m.ram.fill(0, G_BLOCKS, G_BLOCKS + GW * GH); // even the keeper block
    hush(m);
    run(m, 1);
    expect(m.ram[G_LEVEL], "the level advanced").toBe(1);
    expect(playing(m, 3), "with a fanfare").toBe(sfxId("sfx_clear"));

    const last = field(bootSnd());
    movePaddle(last, 0);
    last.ram[G_LEVEL] = LEVEL_COUNT - 1;
    last.ram.fill(0, G_BLOCKS, G_BLOCKS + GW * GH);
    hush(last);
    run(last, 1);
    expect(last.ram[G_STATE], "the game is won").toBe(2);
    expect(playing(last, 3), "and winning is still a level cleared").toBe(sfxId("sfx_clear"));
  });

  it("sounds game over, over the top of the loss that caused it", () => {
    // Both live on channel 3, and the later one wins. That is why a player
    // hears `life lost` on every life EXCEPT the last, which is the right way
    // round: on the last one, what they need to know is that it is over.
    const m = field(bootSnd());
    movePaddle(m, 0);
    m.ram[G_LIVES] = 1;
    freeBall(m, 100, 120, 0, SUB * 4);
    hush(m);
    run(m, 4);
    expect(m.ram[G_STATE], "game over").toBe(1);
    expect(playing(m, 3)).toBe(sfxId("sfx_over"));

    // And a red-ball death on the last life ends the same way.
    const red = field(bootSnd());
    movePaddle(red, 50);
    red.ram[G_LIVES] = 1;
    freeBall(red, 55, PADY - BS + 1, 0, SUB, true);
    hush(red);
    run(red, 1);
    expect(red.ram[G_STATE]).toBe(1);
    expect(playing(red, 3)).toBe(sfxId("sfx_over"));
  });

  it("keeps the constant effects off the channels a song claims", () => {
    // The song takes 2 and 3 and leaves 0 and 1 to the engine, because effects
    // 0, 2 and 3 fire many times a second and a song under them would be
    // shredded. This is that policy, asserted where it is implemented.
    const m = field(bootSnd());
    movePaddle(m, 50);
    setBlock(m, 5, 8, 2, 2); // a tough block: hit, survives
    hush(m);
    tap(m);
    expect(blockAt(m, 5, 8) & 15, "still standing").toBe(2);
    expect(playing(m, 1), "the block hit").toBe(sfxId("sfx_hit"));
    expect(playing(m, 2), "nothing on the song's lead").toBe(-1);
    expect(playing(m, 3), "nor on its bass").toBe(-1);
  });
});

// ===========================================================================
// The two draw paths.
//
// The engine picks between them at boot BY READING THE SHEET, so both halves
// are the same cart with a different chunk list -- which is exactly the thing
// worth testing, because the fallback is what a player sees when an art pack
// goes missing and a cart that renders nothing is worse than one that renders
// plainly.
// ===========================================================================

describe("drawing without a spriteset", () => {
  it("falls back to rectangles, and says so in one byte", () => {
    const m = field(boot());
    setBlock(m, 5, 8, 1, 1);
    run(m, 1);
    expect(m.ram[G_ART], "no sheet, so the rectangle path").toBe(0);
    expect(pixel(m, 66, TOP + 5 * BH + 2), "the block is a filled bar").toBe(
      VALUES.get("color_plain"),
    );
    // A blit would have put this cell's own number in the first three pixels of
    // its top row. A bar is one flat colour all the way across.
    const top = [pixel(m, 64, TOP + 5 * BH), pixel(m, 65, TOP + 5 * BH), pixel(m, 66, TOP + 5 * BH)];
    expect(top, "a flat bar, not a blit").toEqual([15, 15, 15].map(() => VALUES.get("color_plain")));
    expect(pixel(m, padX(m) + 2, PADY), "the paddle too").toBe(VALUES.get("paddle_color"));
  });

  it("still draws every colour knob it ever drew", () => {
    // The knobs are the fallback's whole vocabulary, so a sheet arriving must
    // not have quietly retired any of them.
    const m = field(boot());
    setBlock(m, 5, 2, 4, 1);
    setBlock(m, 5, 4, 5, 1);
    setBlock(m, 5, 6, 8, 1);
    m.ram[G_DROPS] = 40;
    w16(m, G_DROPS + 1, 60 * SUB);
    m.ram[G_DROPS + 3] = 1;
    run(m, 1);
    expect(pixel(m, 18, TOP + 5 * BH + 2)).toBe(VALUES.get("color_red"));
    expect(pixel(m, 34, TOP + 5 * BH + 2)).toBe(VALUES.get("color_solid"));
    expect(pixel(m, 50, TOP + 5 * BH + 2)).toBe(VALUES.get("color_prize"));
    expect(pixel(m, 41, 61), "and the drop's own slot").toBe(VALUES.get("drop_color"));
  });
});

describe("drawing from the sheet", () => {
  it("sees the sheet at sprite_base and takes the sprite path", () => {
    expect(bootArt().ram[G_ART]).toBe(1);
  });

  it("blits a block from the cell its type and damage state name", () => {
    // The table is modules/FORMATS-breakout-art.md's, quoted here in the only
    // form that can be checked: a column, a block, and the cell that must land.
    const m = field(bootArt());
    const want: [number, number, number, number][] = [
      // column, type, hits left, cell
      [2, 1, 1, 0],
      [3, 2, 2, 1],
      [4, 2, 1, 2],
      [5, 3, 3, 3],
      [6, 3, 2, 4],
      [7, 3, 1, 5],
      [8, 5, 1, 8],
      [9, 6, 1, 9],
      [10, 7, 1, 11],
      [11, 8, 1, 12],
    ];
    for (const [c, t, h] of want) setBlock(m, 5, c, t, h);
    run(m, 1);
    for (const [c, t, h, n] of want) {
      expect(cellDrawn(m, c * BW, TOP + 5 * BH), `type ${t} with ${h} left`).toBe(SB + n);
    }
  });

  it("pulses the red block between its two cells", () => {
    const m = field(bootArt());
    setBlock(m, 5, 3, 4, 1);
    const seen = new Set<number>();
    for (let i = 0; i < 4 * RED_FLASH; i++) {
      run(m, 1);
      seen.add(cellDrawn(m, 3 * BW, TOP + 5 * BH));
    }
    expect([...seen].sort(), "the block the ball must not break is never still").toEqual([
      SB + 6,
      SB + 7,
    ]);
  });

  it("alternates the RED ball's two frames, fast", () => {
    const m = field(bootArt());
    movePaddle(m, 0);
    freeBall(m, 60, 60, 0, 0, true);
    const seen = new Set<number>();
    for (let i = 0; i < 4 * RED_FLASH; i++) {
      run(m, 1);
      // The ball is three pixels and its cell is eight, centred on it.
      seen.add(cellDrawn(m, 60 + (BS >> 1) - 4, 60 + (BS >> 1) - 4));
    }
    expect([...seen].sort()).toEqual([SB + 23, SB + 24]);

    // A NORMAL ball is one cell and does not flicker at all.
    freeBall(m, 60, 60, 0, 0);
    const plain = new Set<number>();
    for (let i = 0; i < 4 * RED_FLASH; i++) {
      run(m, 1);
      plain.add(cellDrawn(m, 60 + (BS >> 1) - 4, 60 + (BS >> 1) - 4));
    }
    expect([...plain]).toEqual([SB + 22]);
  });

  it("scrolls the beam, and draws none of it without a RED ball", () => {
    const m = field(bootArt());
    movePaddle(m, 0);
    freeBall(m, 60, 60, 0, 0);
    run(m, 1);
    expect(cellDrawn(m, 64, BEAMY), "no beam for a normal ball").toBe(-1);

    freeBall(m, 60, 60, 0, 0, true);
    const seen = new Set<number>();
    for (let i = 0; i < 4 * (VALUES.get("beam_flow") as number); i++) {
      run(m, 1);
      seen.add(cellDrawn(m, 64, BEAMY));
    }
    expect([...seen].sort(), "it steps between its two segments").toEqual([SB + 25, SB + 26]);
  });

  it("fits the gun to the paddle the moment it has a shot", () => {
    // The paddle IS the ammunition readout. A player should never have to read
    // a number to know they can shoot.
    const m = field(bootArt());
    movePaddle(m, 50);
    run(m, 1);
    expect(cellDrawn(m, 50, PADY), "the bare left cap").toBe(SB + 16);
    m.ram[G_AMMO] = 2;
    run(m, 1);
    expect(cellDrawn(m, 50, PADY), "and the gun variant").toBe(SB + 19);
    m.ram[G_AMMO] = 0;
    run(m, 1);
    expect(cellDrawn(m, 50, PADY), "and back again when it is spent").toBe(SB + 16);
  });

  it("tumbles a falling drop between its two frames", () => {
    const m = field(bootArt());
    movePaddle(m, 0);
    m.ram[G_DROPS] = 60;
    w16(m, G_DROPS + 1, 40 * SUB);
    m.ram[G_DROPS + 3] = 5; // kind 4 + 1: life, cells 40 and 41
    const seen = new Set<number>();
    for (let i = 0; i < 4 * (VALUES.get("drop_spin") as number); i++) {
      const y = r16(m, G_DROPS + 1) >> 4;
      run(m, 1);
      seen.add(cellDrawn(m, 60 + (VALUES.get("drop_w") as number) / 2 - 4, y - 3));
    }
    expect([...seen].filter((n) => n >= 0).sort()).toEqual([SB + 40, SB + 41]);
  });

  it("plays a block break where the block was, three frames, and then stops", () => {
    const m = field(bootArt());
    movePaddle(m, 0);
    setBlock(m, 5, 8, 1, 1);
    tap(m);
    expect(blockAt(m, 5, 8), "the block is gone").toBe(0);
    const x = 8 * BW;
    const y = TOP + 5 * BH;
    expect(cellDrawn(m, x, y), "and the break is playing where it was").toBe(SB + 13);
    run(m, FXF);
    expect(cellDrawn(m, x, y)).toBe(SB + 14);
    run(m, FXF);
    expect(cellDrawn(m, x, y)).toBe(SB + 15);
    run(m, FXF);
    expect(cellDrawn(m, x, y), "three frames and done").toBe(-1);
    expect(pixel(m, x, y), "the field is back to the background").toBe(C_BG);
    for (let i = 0; i < MF; i++) {
      expect(m.ram[G_FX + i * 3 + 2]! & 15, `effect slot ${i} is free again`).toBe(0);
    }
  });

  it("sparks where the ball hits, and flashes a shield that shrugged it off", () => {
    const m = field(bootArt());
    movePaddle(m, 0);
    setBlock(m, 5, 8, 6, 1); // shielded: it ignores the ball
    tap(m);
    expect(blockAt(m, 5, 8) & 15, "the block is unhurt").toBe(6);
    expect(cellDrawn(m, 8 * BW, TOP + 5 * BH), "and flashes").toBe(SB + 10);
    // The spark goes where the BALL is -- a row below the block -- and is
    // centred on it exactly as the ball's own cell is.
    const sx = bx(m) + (BS >> 1) - 4;
    const sy = by(m) + (BS >> 1) - 4;
    expect(cellDrawn(m, sx, sy), "the ball struck something").toBe(SB + 52);
  });

  it("plays four frames of destruction and holds the game for a beat", () => {
    const m = field(bootArt());
    movePaddle(m, 50);
    freeBall(m, 55, PADY - BS + 1, 0, SUB, true);
    run(m, 1);
    expect(m.ram[G_LIVES], "the life is taken on the frame of the contact").toBe(LIVES - 1);
    expect(m.ram[G_DEAD], "and only the beat is held afterwards").toBeGreaterThan(0);

    // Two cells right of the paddle's left edge, clear of the waiting serve.
    const probe = 50 + 16;
    expect(cellDrawn(m, probe, PADY)).toBe(SB + 48);
    for (const n of [49, 50, 51]) {
      run(m, FXF);
      expect(cellDrawn(m, probe, PADY), `destruction frame ${n}`).toBe(SB + n);
    }

    // Nothing simulates while it plays: the paddle cannot slide out from under
    // the animation and the serve cannot be launched through it.
    const held = padX(m);
    run(m, 1, BTN_RIGHT | BTN_A);
    expect(padX(m), "the paddle is held").toBe(held);
    expect(m.ram[ball(0) + B_F]! & 4, "and so is the serve").toBe(4);

    run(m, FXF);
    expect(m.ram[G_DEAD], "then the game comes back").toBe(0);
    run(m, 1);
    run(m, 1, BTN_A);
    expect(m.ram[ball(0) + B_F]! & 4, "and the ball launches").toBe(0);
  });

  it("keeps the mechanics identical on both paths", () => {
    // The art is a skin and must never be a rule. Same scenario, same outcome.
    for (const m of [field(boot()), field(bootArt())]) {
      movePaddle(m, 0);
      setBlock(m, 5, 8, 4, 1);
      tap(m);
      expect(blockAt(m, 5, 8), "the red block broke in one hit").toBe(0);
      expect(m.ram[ball(0) + B_F]! & 2, "and the ball is RED").toBe(2);
    }
  });
});

describe("state containment", () => {
  /**
   * A deliberately varied input script -- paddle sweeps, serves, shots and
   * stops -- so that a hundred and twenty frames of it visit the collision,
   * bounce, break, drop, shot, drift and draw paths rather than one straight
   * line of holding right.
   */
  function scripted(i: number): number {
    let b = 0;
    const leg = (i / 13) | 0;
    if (leg % 3 === 0) b |= BTN_RIGHT;
    else if (leg % 3 === 1) b |= BTN_LEFT;
    if (i % 7 === 0) b |= BTN_A;
    if (i % 11 === 0) b |= BTN_B;
    if (i % 29 === 0) b = 0;
    return b;
  }

  function play(m: Machine, from: number, frames: number): void {
    const input = new Uint8Array(4);
    for (let i = 0; i < frames; i++) {
      input[0] = scripted(from + i);
      m.tick(input);
    }
  }

  it("rewinds byte-for-byte: snapshot, 120 ticks, restore, 120 ticks", () => {
    const m = boot();
    // Drops, pads and a real ball speed, so the rich paths are live.
    for (let L = 0; L < 10; L++) {
      m.ram[ADDR.USER_RAM + L * 16 + H_DROPR] = 200;
      m.ram[ADDR.USER_RAM + L * 16 + H_DROPM] = 0x3f;
      m.ram[ADDR.USER_RAM + L * 16 + H_DRIFT] = 4;
      m.ram[ADDR.USER_RAM + L * 16 + H_PADS] = 1;
      m.ram[ADDR.USER_RAM + L * 16 + H_AMMO] = 3;
      m.ram[ADDR.USER_RAM + L * 16 + H_COUNT] = 2;
    }
    play(m, 0, 90); // get into a rich state first

    const snap = m.snapshot();

    play(m, 90, 120);
    m.present();
    const fbA = m.ram.slice(ADDR.FRAMEBUFFER, ADDR.FRAMEBUFFER + 8192);
    const ramA = m.snapshot();
    const rgbaA = Uint32Array.from(m.rgba);

    m.restore(snap);
    play(m, 90, 120);
    m.present();
    const fbB = m.ram.slice(ADDR.FRAMEBUFFER, ADDR.FRAMEBUFFER + 8192);
    const ramB = m.snapshot();
    const rgbaB = Uint32Array.from(m.rgba);

    // Named first difference: "expected Uint8Array to equal Uint8Array" is not
    // a diagnosis.
    let first = -1;
    for (let i = 0; i < fbA.length && first < 0; i++) if (fbA[i] !== fbB[i]) first = i;
    expect(first, "first differing framebuffer byte after a restore").toBe(-1);
    expect(fbA).toEqual(fbB);
    expect(rgbaA).toEqual(rgbaB);

    // The framebuffer is the visible half. RAM is the whole claim.
    let firstRam = -1;
    for (let i = 0; i < ramA.length && firstRam < 0; i++) if (ramA[i] !== ramB[i]) firstRam = i;
    expect(firstRam, "first differing RAM byte after a restore").toBe(-1);
  });

  /**
   * The same claim with the sheet installed and every animation running.
   *
   * ANIMATION IS STATE, and this is the assertion that says so. A frame counter
   * kept in a module variable would survive a `restore` untouched and the two
   * runs would diverge on the first frame that read it; a counter in RAM comes
   * back with everything else. The free-running half rides `sys.frame()`, which
   * is machine state at 0x20FC, and the event-driven half is the effect pool at
   * G_FX -- and this run has drops falling, blocks breaking and a RED ball live
   * across the snapshot, so both halves are moving when it is taken.
   */
  it("rewinds byte-for-byte with the sheet installed and the animation live", () => {
    const m = bootArt();
    for (let L = 0; L < 10; L++) {
      m.ram[ADDR.USER_RAM + L * 16 + H_DROPR] = 200;
      m.ram[ADDR.USER_RAM + L * 16 + H_DROPM] = 0x3f;
      m.ram[ADDR.USER_RAM + L * 16 + H_DRIFT] = 4;
      m.ram[ADDR.USER_RAM + L * 16 + H_PADS] = 1;
      m.ram[ADDR.USER_RAM + L * 16 + H_AMMO] = 3;
      m.ram[ADDR.USER_RAM + L * 16 + H_COUNT] = 2;
    }
    play(m, 0, 90);
    expect(m.ram[G_ART], "the sprite path is the one under test").toBe(1);

    // A drop in the air and a RED ball, put there rather than hoped for.
    m.ram[G_DROPS] = 60;
    w16(m, G_DROPS + 1, 40 * SUB);
    m.ram[G_DROPS + 3] = 5;
    m.ram[ball(0) + B_F] = (m.ram[ball(0) + B_F]! | 3) & 251;

    const snap = m.snapshot();

    /** One leg, counting the frames on which an effect was mid-flight. */
    const leg = (): { fb: Uint8Array; ram: Uint8Array; rgba: Uint32Array; fx: number } => {
      const input = new Uint8Array(4);
      let fx = 0;
      for (let i = 0; i < 120; i++) {
        input[0] = scripted(90 + i);
        m.tick(input);
        for (let k = 0; k < MF; k++) if (m.ram[G_FX + k * 3 + 2]! & 15) fx++;
      }
      m.present();
      return {
        fb: m.ram.slice(ADDR.FRAMEBUFFER, ADDR.FRAMEBUFFER + 8192),
        ram: m.snapshot(),
        rgba: Uint32Array.from(m.rgba),
        fx,
      };
    };

    const a = leg();
    m.restore(snap);
    const b = leg();

    expect(a.fx, "effects were actually playing during the run").toBeGreaterThan(0);
    expect(b.fx, "and the same ones, the same number of frames").toBe(a.fx);

    let first = -1;
    for (let i = 0; i < a.fb.length && first < 0; i++) if (a.fb[i] !== b.fb[i]) first = i;
    expect(first, "first differing framebuffer byte after a restore").toBe(-1);
    expect(a.rgba).toEqual(b.rgba);

    let firstRam = -1;
    for (let i = 0; i < a.ram.length && firstRam < 0; i++) {
      if (a.ram[i] !== b.ram[i]) firstRam = i;
    }
    expect(firstRam, "first differing RAM byte after a restore").toBe(-1);
  });

  /**
   * The same claim with a sound bank installed and effects actually sounding.
   *
   * THE SEQUENCER'S POSITION IS STATE, and it lives in the audio registers at
   * 0x2110 -- inside the 64 KB, therefore inside a snapshot. That is the whole
   * reason `snd.sfx` writes RAM and returns nothing. A rewind puts the effects
   * back mid-flight along with the ball that started them, and the two legs
   * below must agree byte for byte across the registers as well as the field.
   */
  it("rewinds byte-for-byte with the sound bank installed and effects sounding", () => {
    const m = bootSnd();
    for (let L = 0; L < 10; L++) {
      m.ram[ADDR.USER_RAM + L * 16 + H_DROPR] = 200;
      m.ram[ADDR.USER_RAM + L * 16 + H_DROPM] = 0x3f;
      m.ram[ADDR.USER_RAM + L * 16 + H_DRIFT] = 4;
      m.ram[ADDR.USER_RAM + L * 16 + H_PADS] = 1;
      m.ram[ADDR.USER_RAM + L * 16 + H_AMMO] = 3;
      m.ram[ADDR.USER_RAM + L * 16 + H_COUNT] = 2;
    }
    play(m, 0, 90);

    // A RED ball across the snapshot, so the alarm is one of the sounds in
    // flight rather than one this run happened not to reach.
    m.ram[ball(0) + B_F] = (m.ram[ball(0) + B_F]! | 3) & 251;

    const snap = m.snapshot();

    /** One leg, counting the channel-frames on which something was sounding. */
    const leg = (): { ram: Uint8Array; regs: Uint8Array; heard: number } => {
      const input = new Uint8Array(4);
      let heard = 0;
      for (let i = 0; i < 120; i++) {
        input[0] = scripted(90 + i);
        m.tick(input);
        for (let c = 0; c < 4; c++) if (playing(m, c) >= 0) heard++;
      }
      return {
        ram: m.snapshot(),
        regs: m.ram.slice(ADDR.AUDIO_CH, ADDR.AUDIO_CH + 4 * CH_STRIDE),
        heard,
      };
    };

    const a = leg();
    m.restore(snap);
    const b = leg();

    expect(a.heard, "sounds were actually playing during the run").toBeGreaterThan(0);
    expect(b.heard, "and the same ones, for the same frames").toBe(a.heard);
    expect(b.regs, "the audio registers come back identical").toEqual(a.regs);

    let firstRam = -1;
    for (let i = 0; i < a.ram.length && firstRam < 0; i++) if (a.ram[i] !== b.ram[i]) firstRam = i;
    expect(firstRam, "first differing RAM byte after a restore").toBe(-1);
  });

  it("never writes below 0x7900, where the headers live", () => {
    // The level headers are cart data, installed once. An engine that scribbled
    // on them would rewrite the game it is playing.
    const m = boot();
    const headers = mapHeaders();
    play(m, 0, 200);
    expect(m.ram.slice(ADDR.USER_RAM, S), "the ten headers are untouched").toEqual(headers);
  });

  function mapHeaders(): Uint8Array {
    const want = new Uint8Array(S - ADDR.USER_RAM);
    want.set(dataChunk(), 0);
    return want;
  }

  it("draws the same picture from the same RAM", () => {
    const a = boot();
    const b = boot();
    play(a, 0, 75);
    play(b, 0, 75);
    a.present();
    b.present();
    expect(a.snapshot()).toEqual(b.snapshot());
    expect(Uint32Array.from(a.rgba)).toEqual(Uint32Array.from(b.rgba));
  });

  it("keeps nothing on the ABI objects", () => {
    const a = boot();
    const b = boot();
    run(a, 40);
    run(b, 40);
    expect(a.snapshot()).toEqual(b.snapshot());
  });
});
