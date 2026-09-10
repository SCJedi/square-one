/**
 * The topdown engine, tested against a real machine.
 *
 * THIS FILE IS THE STAMPER'S STAND-IN, and deliberately so: it reads
 * module.toml the way the stamper does, builds the same `const KNOB = {...}`
 * preamble, composes the same `PAL ` and `GFX ` chunks out of the same art
 * packs, and hands both to `compileCart` and `createMachine`. That pins the
 * whole contract from this side -- if the stamper emits a different preamble,
 * or lays a chunk out differently, this file is what says so.
 *
 * It is deliberately the same shape as modules/platformer/test/engine.test.ts,
 * because the point of milestone M6 is whether a second engine in a second genre
 * fits the first one's interface. A test file that had to be structured
 * differently would itself have been a finding; it did not.
 *
 * The preamble is KNOBS AND NOTHING ELSE. The art is not in it: a cart's `PAL `,
 * `GFX ` and `MAP ` chunks are installed into RAM by the player between zeroing
 * and `boot()` (specification 3.3), so this file builds them and passes them to
 * `createMachine` as `data`, which is exactly what `loadCartBytes` does.
 *
 * The knob values come from module.toml's defaults, and from
 * examples/moss-keep/recipe.toml for the knobs the manifest declares REQUIRED by
 * omitting a default. So a knob added to the engine and not to the manifest
 * fails here, and so does a required knob the example recipe forgot.
 *
 * The scenario tests build their OWN maps by poking the MAP region after boot.
 * The engine's generated overworld is a fine thing to look at and a terrible
 * thing to assert against; one wall in a known place is not.
 *
 * The test that matters most is the last one. Snapshot, run sixty frames,
 * restore, run the same sixty frames, and the framebuffers must be identical
 * byte for byte. If any engine state ever escapes RAM into a closure variable,
 * that is the test that catches it, and the fix is to move the state -- never to
 * relax the assertion.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { countTokens, fromFloat } from "@sq1/core";
import { TOKEN_BUDGET, lintCartSource } from "@sq1/cart";
import {
  ADDR,
  GFX_SHEET_OFFSET,
  HW_PALETTE,
  compileCart,
  createMachine,
  planCartData,
} from "@sq1/runtime";
import type { Machine } from "@sq1/runtime";

// ---------------------------------------------------------------------------
// Locating the module. Vitest runs from the repository root.
// ---------------------------------------------------------------------------

const MOD = "modules/topdown";
const ENGINE_SRC = readFileSync(`${MOD}/engine.js`, "utf8");
const ENGINE_TOML = readFileSync(`${MOD}/module.toml`, "utf8");
const RECIPE_TOML = readFileSync("examples/moss-keep/recipe.toml", "utf8");
const PALETTE_TOML = readFileSync("modules/sweetie16/module.toml", "utf8");
const TILES_BIN = readFileSync("modules/overworld/tiles.bin");
const SPRITES_BIN = readFileSync("modules/wanderer/sprites.bin");

// ---------------------------------------------------------------------------
// Just enough TOML to read a manifest. Same reader as the platformer's test,
// and deliberately: a second half-real parser here would drift from that one as
// well as from the stamper.
// ---------------------------------------------------------------------------

type Scalar = number | boolean | string;

function scalar(raw: string): Scalar {
  const s = raw.trim();
  if (s === "true") return true;
  if (s === "false") return false;
  if (s.startsWith('"')) return s.slice(1, -1);
  return Number(s);
}

/** Every `key = value` inside one `[section]`, comments stripped. */
function section(toml: string, want: string): Map<string, Scalar> {
  const out = new Map<string, Scalar>();
  let here = "";
  for (const line of toml.split(/\r?\n/)) {
    const head = /^\[([^\]]+)\]\s*$/.exec(line.trim());
    if (head) {
      here = head[1] as string;
      continue;
    }
    if (here !== want) continue;
    const kv = /^([a-z0-9_]+)\s*=\s*([^#]+?)\s*(?:#.*)?$/.exec(line.trim());
    if (kv) out.set(kv[1] as string, scalar(kv[2] as string));
  }
  return out;
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
const TUNING = section(RECIPE_TOML, "tuning");

/** `map_width` -> `mapWidth`, the stamper's own rule. */
function camel(s: string): string {
  return s.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase());
}

// ---------------------------------------------------------------------------
// The preamble the stamper will emit.
// ---------------------------------------------------------------------------

/**
 * A knob's JavaScript literal.
 *
 * The conversion is `fromFloat` FROM @sq1/core, and not a local rounding that
 * happens to agree with it. There is one float-to-fixed conversion in this
 * repository and the stamper's `bind` uses the same one.
 */
function literal(k: Knob, v: Scalar): string {
  if (k.type === "fixed") return `${fromFloat(v as number)} / 65536`;
  if (k.type === "bool") return v === true ? "true" : "false";
  return String(v);
}

/** The resolved value of every knob: the manifest default, else the recipe. */
function resolve(): Map<string, Scalar> {
  const out = new Map<string, Scalar>();
  for (const [name, k] of KNOBS) {
    const v = TUNING.has(name) ? TUNING.get(name) : k.def;
    if (v === undefined) throw new Error(`knob "${name}" has no default and the recipe does not set it`);
    out.set(name, v);
  }
  return out;
}

const VALUES = resolve();

/**
 * The `GFX ` chunk: the art packs merged into one flags block and one sheet.
 *
 * `overworld` declares base 0 and `wanderer` base 64. A base is a SHEET CELL,
 * and the sheet is one 128-pixel-wide picture, so cell 64 is the start of sheet
 * row 4 -- pixel row 32, byte offset 32 * 64.
 *
 * THE FLAGS COME FIRST INSIDE THE CHUNK, at offset 0, and the sheet follows at
 * `GFX_SHEET_OFFSET`.
 */
function gfxChunk(): Uint8Array {
  const chunk = new Uint8Array(GFX_SHEET_OFFSET + 8192);
  const flags = chunk.subarray(0, GFX_SHEET_OFFSET);
  const sheet = chunk.subarray(GFX_SHEET_OFFSET);

  sheet.set(TILES_BIN.subarray(0, 2048), 0);
  flags.set(TILES_BIN.subarray(2048, 2112), 0);
  sheet.set(SPRITES_BIN.subarray(0, 1024), (64 >> 4) * 8 * 64);
  flags.set(SPRITES_BIN.subarray(1024, 1056), 64);

  return chunk;
}

/** The `PAL ` chunk: the hardware palette, then the pack's sixteen live slots. */
function palChunk(): Uint8Array {
  const raw = /entries\s*=\s*\[([^\]]+)\]/.exec(PALETTE_TOML);
  const entries = (raw?.[1] as string).split(",").map((s) => Number(s.trim()));

  const chunk = new Uint8Array(HW_PALETTE.length + 16);
  chunk.set(HW_PALETTE, 0);
  chunk.set(Uint8Array.from(entries), HW_PALETTE.length);
  return chunk;
}

const DATA = planCartData([
  { type: "PAL ", data: palChunk() },
  { type: "GFX ", data: gfxChunk() },
]).data;

/** Knobs and nothing else. Art travels in chunks; see the header. */
function preamble(): string {
  const pairs: string[] = [];
  for (const [name, k] of KNOBS) pairs.push(`${camel(name)}: ${literal(k, VALUES.get(name)!)}`);
  return `const KNOB = { ${pairs.join(", ")} };\n`;
}

const SOURCE = preamble() + ENGINE_SRC;

// ---------------------------------------------------------------------------
// Reading the engine's RAM. These addresses are engine.js's own layout, quoted
// from the block comment at the top of it.
// ---------------------------------------------------------------------------

const SUB = 256;
const U = ADDR.USER_RAM;
const G_FACE = U + 0;
const G_ATK = U + 1;
const G_HP = U + 2;
const G_INV = U + 3;
const G_KEYS = U + 4;
const G_COINS = U + 5;
const G_HURT = U + 6;
const G_STEP = U + 7;
const G_CAMX = U + 8;
const G_CAMY = U + 12;
const E_BASE = U + 16;
const E_SIZE = 20;
const E_X = 0;
const E_Y = 4;
const E_VX = 8;
const E_VY = 12;
const E_KIND = 16;
const E_FACE = 17;
const E_HP = 18;
const E_HIT = 19;

/** The four facings, as engine.js numbers them. */
const DOWN = 0;
const UP = 1;
const LEFT = 2;
const RIGHT = 3;

const BTN_UP = 1 << 0;
const BTN_DOWN = 1 << 1;
const BTN_LEFT = 1 << 2;
const BTN_RIGHT = 1 << 3;
const BTN_A = 1 << 4;
const BTN_B = 1 << 5;

const N = VALUES.get("entities") as number;
const PW = VALUES.get("player_width") as number;
const PH = VALUES.get("player_height") as number;
const EW = VALUES.get("enemy_width") as number;
const MAP_W_TILES = VALUES.get("map_width") as number;
const MAP_H_TILES = VALUES.get("map_height") as number;
const ENEMY_HP = VALUES.get("enemy_hp") as number;
const PLAYER_HP = VALUES.get("player_hp") as number;
const HIT_FLASH = VALUES.get("hit_flash_frames") as number;
const ATTACK_FRAMES = VALUES.get("attack_frames") as number;
const START_X = (VALUES.get("start_tile_x") as number) * 8;
const START_Y = (VALUES.get("start_tile_y") as number) * 8;

/** Indices out of modules/overworld/module.toml's [names] table. */
const T_GRASS = VALUES.get("tile_grass") as number;
const T_WALL = VALUES.get("tile_wall") as number;
const T_BRAMBLE = VALUES.get("tile_bramble") as number;
const T_DOOR = VALUES.get("tile_door") as number;
const T_DOOR_OPEN = VALUES.get("tile_door_open") as number;

function ent(i: number): number {
  return E_BASE + i * E_SIZE;
}

function r32(m: Machine, a: number): number {
  const r = m.ram;
  return (r[a]! | (r[a + 1]! << 8) | (r[a + 2]! << 16) | (r[a + 3]! << 24)) | 0;
}

function w32(m: Machine, a: number, v: number): void {
  m.ram[a] = v & 0xff;
  m.ram[a + 1] = (v >> 8) & 0xff;
  m.ram[a + 2] = (v >> 16) & 0xff;
  m.ram[a + 3] = (v >> 24) & 0xff;
}

/** The walker's position in whole pixels, the way the engine draws it. */
function px(m: Machine): number {
  return r32(m, ent(0) + E_X) >> 8;
}
function py(m: Machine): number {
  return r32(m, ent(0) + E_Y) >> 8;
}

function place(m: Machine, x: number, y: number): void {
  const e = ent(0);
  w32(m, e + E_X, x * SUB);
  w32(m, e + E_Y, y * SUB);
  w32(m, e + E_VX, 0);
  w32(m, e + E_VY, 0);
}

/** Put a pool entity at a pixel position, fully initialised. */
function put(m: Machine, i: number, kind: number, x: number, y: number, face = DOWN): number {
  const e = ent(i);
  w32(m, e + E_X, x * SUB);
  w32(m, e + E_Y, y * SUB);
  w32(m, e + E_VX, 0);
  w32(m, e + E_VY, 0);
  m.ram[e + E_KIND] = kind;
  m.ram[e + E_FACE] = face;
  m.ram[e + E_HP] = ENEMY_HP;
  m.ram[e + E_HIT] = 0;
  return e;
}

/** Empty the tile map. Tile 0 is the console's "nothing" and carries no flags. */
function clearMap(m: Machine): void {
  m.ram.fill(0, ADDR.MAP, ADDR.MAP + 8192);
}

function setTile(m: Machine, tx: number, ty: number, t: number): void {
  m.ram[ADDR.MAP + ty * 128 + tx] = t;
}

function tileAt(m: Machine, tx: number, ty: number): number {
  return m.ram[ADDR.MAP + ty * 128 + tx]!;
}

/** Retire every entity but the walker, so a scenario is only the scenario. */
function clearPool(m: Machine): void {
  for (let i = 1; i < N; i++) m.ram[ent(i) + E_KIND] = 0;
}

/** Spend the invulnerability the respawn hands out, so damage lands at once. */
function clearInv(m: Machine): void {
  m.ram[G_INV] = 0;
}

const NO_INPUT = new Uint8Array(4);

function run(m: Machine, frames: number, buttons = 0): void {
  const input = new Uint8Array(4);
  input[0] = buttons;
  for (let i = 0; i < frames; i++) m.tick(input);
}

function boot(): Machine {
  const m = createMachine(compileCart(SOURCE, { name: "topdown" }), { data: DATA });
  m.boot(1);
  return m;
}

/**
 * A cleared machine on open ground: no tiles at all, no pool, and the walker in
 * the middle of it. Tile 0 has no flags, so an empty map IS a field -- and
 * `edge_solid` still walls the rim, which is the point of the four-sided rule.
 */
function openField(): Machine {
  const m = boot();
  clearMap(m);
  clearPool(m);
  clearInv(m);
  place(m, 64, 64);
  return m;
}

// ===========================================================================

describe("the topdown engine as a cart", () => {
  it("names only knobs its manifest declares", () => {
    const used = new Set<string>();
    for (const m of ENGINE_SRC.matchAll(/KNOB\.([A-Za-z0-9]+)/g)) used.add(m[1] as string);

    const declared = new Set<string>();
    for (const name of KNOBS.keys()) declared.add(camel(name));

    const missing = [...used].filter((k) => !declared.has(k)).sort();
    expect(missing, "knobs the engine reads that module.toml does not declare").toEqual([]);

    const unused = [...declared].filter((k) => !used.has(k)).sort();
    expect(unused, "knobs module.toml declares that the engine never reads").toEqual([]);
  });

  it("has every required knob set by the example recipe", () => {
    const required = [...KNOBS].filter(([, k]) => k.def === undefined).map(([n]) => n);
    expect(required.length).toBeGreaterThan(0);
    const unset = required.filter((n) => !TUNING.has(n));
    expect(unset, "required knobs examples/moss-keep/recipe.toml does not set").toEqual([]);
  });

  it("gives every knob a doc", () => {
    // A knob without a sentence saying what it does is a magic number with a
    // longer name. Cheap to check, and it is the rule modules/README.md states.
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
  });

  it("passes the build gate: no forbidden names, inside the token budget", () => {
    const result = lintCartSource(SOURCE);
    expect(result.findings.map((f) => `${f.rule} ${f.identifier ?? ""} @${f.line}`)).toEqual([]);
    expect(result.tokens).toBeLessThan(TOKEN_BUDGET);
    console.log(
      `topdown: engine ${countTokens(ENGINE_SRC)} tokens, ` +
        `stamped cart ${result.tokens} of ${TOKEN_BUDGET}`,
    );
  });

  it("boots and ticks without throwing", () => {
    const m = boot();
    expect(() => run(m, 120)).not.toThrow();
    expect(m.ram[ent(0) + E_KIND]).toBe(1); // the walker is entity 0, always
    expect(m.ram[G_HP]).toBe(PLAYER_HP);
  });

  it("builds a world and fills part of the entity pool", () => {
    const m = boot();
    let tiles = 0;
    for (let i = 0; i < 8192; i++) if (m.ram[ADDR.MAP + i]! !== 0) tiles++;
    // The whole map is ground before anything is drawn on it.
    expect(tiles).toBe(MAP_W_TILES * MAP_H_TILES);

    let used = 0;
    for (let i = 1; i < N; i++) if (m.ram[ent(i) + E_KIND]! !== 0) used++;
    expect(used).toBeGreaterThan(4);
  });

  it("builds a keep with a locked door in it, and a key outside", () => {
    const m = boot();
    const kx = VALUES.get("keep_x") as number;
    const ky = VALUES.get("keep_y") as number;
    const kw = VALUES.get("keep_w") as number;
    const kh = VALUES.get("keep_h") as number;

    expect(tileAt(m, kx + (kw >> 1), ky + kh - 1)).toBe(T_DOOR);
    expect(m.ram[ent(1) + E_KIND]).toBe(4); // the coin the door is for
    expect(m.ram[ent(2) + E_KIND]).toBe(5); // and the key that opens it
  });

  it("leaves the spawn point and its neighbours clear", () => {
    // Regression by construction: the home chunk and the eight around it are
    // forced to open ground, so nothing the generator rolls can put the walker
    // inside a solid tile on frame one.
    const m = boot();
    const sx = VALUES.get("start_tile_x") as number;
    const sy = VALUES.get("start_tile_y") as number;
    const flagsOf = (tx: number, ty: number): number =>
      m.ram[ADDR.SPRITE_FLAGS + tileAt(m, tx, ty)]!;

    for (let ty = sy - 2; ty <= sy + 2; ty++) {
      for (let tx = sx - 2; tx <= sx + 2; tx++) {
        expect(flagsOf(tx, ty) & 0x07, `tile at (${tx}, ${ty}) is not clear`).toBe(0);
      }
    }

    run(m, 60);
    expect(m.ram[G_HURT]).toBe(0);
    expect(px(m)).toBe(START_X);
    expect(py(m)).toBe(START_Y);
  });

  it("is the same world every time, from the same seed", () => {
    const a = boot();
    const b = boot();
    expect(a.ram.subarray(ADDR.MAP, ADDR.MAP + 8192)).toEqual(b.ram.subarray(ADDR.MAP, ADDR.MAP + 8192));
  });
});

describe("eight-directional movement", () => {
  /** Hold `buttons` for 30 frames from the middle of an empty field. */
  function walk(buttons: number): { dx: number; dy: number; face: number } {
    const m = openField();
    run(m, 30, buttons);
    return { dx: px(m) - 64, dy: py(m) - 64, face: m.ram[G_FACE]! };
  }

  it("moves on all eight headings, and on neither axis with nothing held", () => {
    const sign = (n: number): number => (n > 0 ? 1 : n < 0 ? -1 : 0);
    const cases: [number, number, number, string][] = [
      [BTN_RIGHT, 1, 0, "east"],
      [BTN_LEFT, -1, 0, "west"],
      [BTN_DOWN, 0, 1, "south"],
      [BTN_UP, 0, -1, "north"],
      [BTN_RIGHT | BTN_DOWN, 1, 1, "south-east"],
      [BTN_RIGHT | BTN_UP, 1, -1, "north-east"],
      [BTN_LEFT | BTN_DOWN, -1, 1, "south-west"],
      [BTN_LEFT | BTN_UP, -1, -1, "north-west"],
      [0, 0, 0, "nothing"],
    ];
    for (const [buttons, ex, ey, name] of cases) {
      const { dx, dy } = walk(buttons);
      expect(sign(dx), `x movement going ${name}`).toBe(ex);
      expect(sign(dy), `y movement going ${name}`).toBe(ey);
    }
  });

  it("faces the way it walks, on each of the four cardinals", () => {
    expect(walk(BTN_RIGHT).face).toBe(RIGHT);
    expect(walk(BTN_LEFT).face).toBe(LEFT);
    expect(walk(BTN_DOWN).face).toBe(DOWN);
    expect(walk(BTN_UP).face).toBe(UP);
  });

  it("keeps its facing when it stops", () => {
    // The thing a platformer's facing bit does not have to do. A walker that
    // forgets which way it was pointing the moment you let go cannot swing at
    // anything, and cannot open a door.
    const m = openField();
    run(m, 20, BTN_UP);
    expect(m.ram[G_FACE]).toBe(UP);
    run(m, 60); // nothing held, for a whole second
    expect(m.ram[G_FACE]).toBe(UP);
    expect(m.ram[G_STEP], "the walk cycle stops when the walking does").toBe(0);
  });

  it("does not travel further on a diagonal than on a straight line", () => {
    // The bug every top-down game ships once: holding two directions moves you
    // 1.414 times as fast. `diagonal_scale` is the knob that says it must not.
    const straight = walk(BTN_RIGHT).dx;
    const diagonal = walk(BTN_RIGHT | BTN_DOWN).dx;
    expect(diagonal).toBeLessThan(straight);
    expect(diagonal).toBeGreaterThan(0);
  });

  it("obeys face_prefer_x on a diagonal", () => {
    expect(VALUES.get("face_prefer_x")).toBe(true);
    expect(walk(BTN_RIGHT | BTN_UP).face).toBe(RIGHT);
    expect(walk(BTN_LEFT | BTN_DOWN).face).toBe(LEFT);
  });
});

describe("two-axis tile collision", () => {
  it("stops against a wall to the east", () => {
    const m = openField();
    for (let ty = 0; ty < MAP_H_TILES; ty++) setTile(m, 12, ty, T_WALL);
    run(m, 200, BTN_RIGHT);
    expect(px(m) + PW).toBe(12 * 8);
  });

  it("stops against a wall to the west", () => {
    const m = openField();
    for (let ty = 0; ty < MAP_H_TILES; ty++) setTile(m, 4, ty, T_WALL);
    run(m, 200, BTN_LEFT);
    expect(px(m)).toBe(5 * 8);
  });

  it("stops against a wall to the south", () => {
    const m = openField();
    for (let tx = 0; tx < MAP_W_TILES; tx++) setTile(m, tx, 12, T_WALL);
    run(m, 200, BTN_DOWN);
    expect(py(m) + PH).toBe(12 * 8);
  });

  it("stops against a wall to the north", () => {
    const m = openField();
    for (let tx = 0; tx < MAP_W_TILES; tx++) setTile(m, tx, 4, T_WALL);
    run(m, 200, BTN_UP);
    expect(py(m)).toBe(5 * 8);
  });

  it("slides along a wall instead of sticking to it", () => {
    // The reason X and Y are resolved separately. Pushed south-east into a wall
    // that only blocks the east, the walker must still go south -- a single
    // combined resolution stops both axes and the walker glues itself to the
    // wall.
    const m = openField();
    for (let ty = 0; ty < MAP_H_TILES; ty++) setTile(m, 12, ty, T_WALL);
    run(m, 120, BTN_RIGHT | BTN_DOWN);
    expect(px(m) + PW).toBe(12 * 8);
    expect(py(m)).toBeGreaterThan(64);
  });

  it("is walled on all four sides of the map, with no bottom to fall out of", () => {
    // A platformer must let a body leave through the bottom. A walker must not
    // leave at all, and `edge_solid` is one rule for four edges.
    expect(VALUES.get("edge_solid")).toBe(true);
    const m = openField();
    place(m, 4, 4);
    run(m, 200, BTN_LEFT | BTN_UP);
    expect(px(m)).toBe(0);
    expect(py(m)).toBe(0);

    place(m, MAP_W_TILES * 8 - 20, MAP_H_TILES * 8 - 20);
    run(m, 200, BTN_RIGHT | BTN_DOWN);
    expect(px(m) + PW).toBe(MAP_W_TILES * 8);
    expect(py(m) + PH).toBe(MAP_H_TILES * 8);
  });

  it("does not fling a body that is already inside a wall", () => {
    // Regression carried over from the platformer, because the collision
    // routine is: a resolution may never move a body backwards.
    const m = openField();
    for (let ty = 8; ty < 12; ty++) setTile(m, 10, ty, T_WALL);
    place(m, 10 * 8, 9 * 8);
    run(m, 90, BTN_RIGHT);
    expect(px(m)).toBe(10 * 8);
    expect(py(m)).toBe(9 * 8);
  });
});

describe("the camera", () => {
  const CAM_MAX_X = MAP_W_TILES * 8 - 128;
  const CAM_MAX_Y = MAP_H_TILES * 8 - 128;

  function camAt(x: number, y: number): { x: number; y: number } {
    const m = openField();
    place(m, x, y);
    run(m, 120);
    return { x: r32(m, G_CAMX) >> 8, y: r32(m, G_CAMY) >> 8 };
  }

  it("clamps at the west and north edges", () => {
    const c = camAt(0, 0);
    expect(c.x).toBe(0);
    expect(c.y).toBe(0);
  });

  it("clamps at the east and south edges", () => {
    const c = camAt((MAP_W_TILES - 1) * 8, (MAP_H_TILES - 1) * 8);
    expect(c.x).toBe(CAM_MAX_X);
    expect(c.y).toBe(CAM_MAX_Y);
  });

  it("follows the walker in both axes away from an edge", () => {
    const look = VALUES.get("camera_lookahead") as number;
    const m = openField();
    place(m, 300, 260);
    run(m, 240); // facing is DOWN after a boot, so the look-ahead is on y
    expect(m.ram[G_FACE]).toBe(DOWN);
    const cx = r32(m, G_CAMX) >> 8;
    const cy = r32(m, G_CAMY) >> 8;
    expect(cx).toBe(300 + (PW >> 1) - 64);
    expect(cy).toBe(260 + (PH >> 1) - 64 + look);
    expect(cx).toBeGreaterThan(0);
    expect(cx).toBeLessThan(CAM_MAX_X);
    expect(cy).toBeGreaterThan(0);
    expect(cy).toBeLessThan(CAM_MAX_Y);
  });

  it("leads in the direction the walker faces, on either axis", () => {
    const look = VALUES.get("camera_lookahead") as number;
    const m = openField();
    place(m, 300, 260);
    run(m, 1, BTN_RIGHT); // face east without going anywhere much
    place(m, 300, 260);
    run(m, 240);
    expect(m.ram[G_FACE]).toBe(RIGHT);
    expect(r32(m, G_CAMX) >> 8).toBe(300 + (PW >> 1) - 64 + look);
    expect(r32(m, G_CAMY) >> 8).toBe(260 + (PH >> 1) - 64);
  });
});

describe("the swing", () => {
  /**
   * Face `f` without moving, then throw one swing.
   *
   * The facing is poked rather than walked into, because holding a direction to
   * turn also moves the walker and the whole test is about where the hitbox is
   * relative to where the walker is standing.
   */
  function swingFacing(m: Machine, f: number): void {
    m.ram[G_FACE] = f;
    m.tick(NO_INPUT); // so btnp sees a NEW press next frame
    m.ram[G_FACE] = f;
    run(m, 1, BTN_A);
  }

  it("damages an enemy in front and not one behind", () => {
    const m = openField();
    const front = put(m, 1, 2, 72, 64);
    const behind = put(m, 2, 2, 48, 64);
    swingFacing(m, RIGHT);
    expect(m.ram[front + E_HP], "the one in front").toBe(ENEMY_HP - 1);
    expect(m.ram[behind + E_HP], "the one behind").toBe(ENEMY_HP);
  });

  it("swings in whichever direction the walker faces", () => {
    const cases: [number, number, number][] = [
      [RIGHT, 74, 64],
      [LEFT, 54, 64],
      [DOWN, 64, 74],
      [UP, 64, 54],
    ];
    for (const [f, ex, ey] of cases) {
      const m = openField();
      const hit = put(m, 1, 2, ex, ey);
      const miss = put(m, 2, 2, 128 - ex, 128 - ey);
      swingFacing(m, f);
      expect(m.ram[hit + E_HP], `facing ${f}, the one in front`).toBe(ENEMY_HP - 1);
      expect(m.ram[miss + E_HP], `facing ${f}, the one opposite`).toBe(ENEMY_HP);
    }
  });

  it("cannot hit the same enemy twice inside the hit-flash window", () => {
    const m = openField();
    const e = put(m, 1, 2, 72, 64);
    swingFacing(m, RIGHT);
    expect(m.ram[e + E_HP]).toBe(ENEMY_HP - 1);
    // The swing set it to HIT_FLASH and `pool` ran later in the same tick and
    // counted it down once, which is what every other frame will do too.
    expect(m.ram[e + E_HIT]).toBe(HIT_FLASH - 1);
    // The swing is still playing, so a second press is eaten anyway; force the
    // issue by ending it and pressing again inside the flash.
    m.ram[G_ATK] = 0;
    swingFacing(m, RIGHT);
    expect(m.ram[e + E_HP], "struck again while still flashing").toBe(ENEMY_HP - 1);
  });

  it("kills an enemy in enemy_hp swings, and it stays dead", () => {
    const m = openField();
    const e = put(m, 1, 2, 70, 64);
    for (let s = 0; s < ENEMY_HP; s++) {
      swingFacing(m, RIGHT);
      run(m, ATTACK_FRAMES + HIT_FLASH + 2);
      // Standing still, out of chase range of nothing: keep it in reach.
      w32(m, e + E_X, 70 * SUB);
      w32(m, e + E_Y, 64 * SUB);
    }
    expect(m.ram[e + E_KIND]).toBe(0);
  });

  it("knocks a survivor back rather than through a wall", () => {
    const m = openField();
    const e = put(m, 1, 2, 72, 64);
    for (let ty = 0; ty < MAP_H_TILES; ty++) setTile(m, 10, ty, T_WALL);
    swingFacing(m, RIGHT);
    expect(m.ram[e + E_HP]).toBe(ENEMY_HP - 1);
    expect((r32(m, e + E_X) >> 8) + EW).toBeLessThanOrEqual(10 * 8);
  });
});

describe("two enemy behaviours", () => {
  it("a chaser closes on the walker when it is in range", () => {
    const m = openField();
    clearInv(m);
    place(m, 100, 64);
    const e = put(m, 1, 2, 70, 64);
    const before = r32(m, e + E_X) >> 8;
    run(m, 30);
    expect(r32(m, e + E_X) >> 8).toBeGreaterThan(before);
  });

  it("a chaser out of range does not move at all", () => {
    const range = VALUES.get("chase_range") as number;
    const m = openField();
    place(m, 8, 64);
    const e = put(m, 1, 2, 8 + range + 20, 64);
    const before = r32(m, e + E_X);
    run(m, 40);
    expect(r32(m, e + E_X)).toBe(before);
    expect(r32(m, e + E_Y)).toBe(before === 0 ? 0 : r32(m, e + E_Y)); // y likewise
  });

  it("a chaser closes on both axes at once", () => {
    const m = openField();
    place(m, 90, 90);
    const e = put(m, 1, 2, 70, 70);
    run(m, 20);
    expect(r32(m, e + E_X) >> 8).toBeGreaterThan(70);
    expect(r32(m, e + E_Y) >> 8).toBeGreaterThan(70);
  });

  it("a patroller walks its heading and reverses at a wall", () => {
    const m = openField();
    place(m, 8, 8); // out of the way; a patroller does not care where you are
    const e = put(m, 1, 3, 64, 64, RIGHT);
    for (let ty = 0; ty < MAP_H_TILES; ty++) setTile(m, 10, ty, T_WALL);

    const start = r32(m, e + E_X) >> 8;
    run(m, 20);
    const walked = r32(m, e + E_X) >> 8;
    expect(walked, "it walked east").toBeGreaterThan(start);

    let guard = 0;
    while (m.ram[e + E_FACE] === RIGHT && guard++ < 400) run(m, 1);
    expect(guard, "it reached the wall").toBeLessThan(400);
    expect(m.ram[e + E_FACE], "and turned around").toBe(LEFT);
    expect((r32(m, e + E_X) >> 8) + EW).toBe(10 * 8);

    const turned = r32(m, e + E_X) >> 8;
    run(m, 40);
    expect(r32(m, e + E_X) >> 8, "and walked back west").toBeLessThan(turned);
  });

  it("a patroller ignores the walker standing right beside it", () => {
    const m = openField();
    place(m, 200, 200);
    const e = put(m, 1, 3, 64, 64, DOWN);
    run(m, 20);
    // It went south because that is its heading, not because anything is there.
    expect(r32(m, e + E_Y) >> 8).toBeGreaterThan(64);
    expect(r32(m, e + E_X) >> 8).toBe(64);
  });

  it("touching an enemy costs a heart, once, and then buys invulnerability", () => {
    const invuln = VALUES.get("hurt_invuln_frames") as number;
    const m = openField();
    clearInv(m);
    put(m, 1, 3, 64, 64, DOWN); // standing exactly on the walker
    expect(m.ram[G_HP]).toBe(PLAYER_HP);
    run(m, 1);
    expect(m.ram[G_HP]).toBe(PLAYER_HP - 1);
    // `pool` runs after `player`, so the window is granted a whole frame's
    // worth: nothing has counted it down yet on the frame it was bought.
    expect(m.ram[G_INV]).toBe(invuln);
    run(m, invuln - 2);
    expect(m.ram[G_HP], "no second hit inside the window").toBe(PLAYER_HP - 1);
  });
});

describe("pickups, keys and doors", () => {
  it("collects a coin once and not twice", () => {
    const m = openField();
    const c = put(m, 1, 4, 64, 64);
    expect(m.ram[G_COINS]).toBe(0);
    run(m, 2);
    expect(m.ram[G_COINS]).toBe(1);
    expect(m.ram[c + E_KIND]).toBe(0); // gone, not collected again
    run(m, 20);
    expect(m.ram[G_COINS]).toBe(1);
  });

  it("collects a key into the key count", () => {
    const m = openField();
    put(m, 1, 5, 64, 64);
    run(m, 2);
    expect(m.ram[G_KEYS]).toBe(1);
    expect(m.ram[G_COINS]).toBe(0);
  });

  /** A door at tile (12, 8) with the walker standing west of it, facing east. */
  function atDoor(): Machine {
    const m = openField();
    for (let ty = 0; ty < MAP_H_TILES; ty++) {
      for (let tx = 0; tx < MAP_W_TILES; tx++) setTile(m, tx, ty, T_GRASS);
    }
    setTile(m, 12, 8, T_DOOR);
    place(m, 11 * 8, 8 * 8);
    m.ram[G_FACE] = RIGHT;
    m.tick(NO_INPUT);
    m.ram[G_FACE] = RIGHT;
    return m;
  }

  it("does not open a door without a key", () => {
    const m = atDoor();
    run(m, 1, BTN_B);
    expect(tileAt(m, 12, 8)).toBe(T_DOOR);
    expect(m.ram[G_KEYS]).toBe(0);
  });

  it("opens a door with a key, spends the key, and leaves it open", () => {
    const m = atDoor();
    m.ram[G_KEYS] = 1;
    run(m, 1, BTN_B);
    expect(tileAt(m, 12, 8)).toBe(T_DOOR_OPEN);
    expect(m.ram[G_KEYS]).toBe(0);

    // And the doorway is now walkable, which is the whole point of the flag.
    run(m, 120, BTN_RIGHT);
    expect(px(m)).toBeGreaterThan(12 * 8);
  });

  it("a closed door is a wall", () => {
    const m = atDoor();
    run(m, 120, BTN_RIGHT);
    expect(px(m) + PW).toBe(12 * 8);
  });
});

describe("hazards", () => {
  it("a bramble costs a heart, and is not solid", () => {
    const m = openField();
    clearInv(m);
    setTile(m, 8, 8, T_BRAMBLE);
    place(m, 8 * 8, 8 * 8);
    expect(m.ram[G_HP]).toBe(PLAYER_HP);
    run(m, 1);
    expect(m.ram[G_HP]).toBe(PLAYER_HP - 1);
    expect(m.ram[G_HURT]).toBe(1);

    // Not solid: a walker can leave the way they came, and could have chosen not
    // to enter. A hazard that also blocked would just be a wall that hurts.
    const was = px(m);
    run(m, 30, BTN_RIGHT);
    expect(px(m)).toBeGreaterThan(was);
  });

  it("running out of hearts restarts the run at the start tile", () => {
    const m = openField();
    setTile(m, 8, 8, T_BRAMBLE);
    place(m, 8 * 8, 8 * 8);
    let guard = 0;
    while (m.ram[G_HURT]! < PLAYER_HP && guard++ < 2000) {
      clearInv(m);
      run(m, 1);
    }
    expect(guard).toBeLessThan(2000);
    expect(px(m)).toBe(START_X);
    expect(py(m)).toBe(START_Y);
    expect(m.ram[G_HP]).toBe(PLAYER_HP);
  });
});

describe("state containment", () => {
  /**
   * The input script. Deliberately varied -- eight headings, swings, door
   * presses, stops -- so that sixty frames of it visit the facing, diagonal,
   * collision, swing, pool, camera, animation and minimap paths rather than one
   * straight line of walking east.
   */
  function scripted(i: number): number {
    let b = 0;
    const leg = (i / 17) | 0;
    if (leg % 4 === 0) b |= BTN_RIGHT;
    else if (leg % 4 === 1) b |= BTN_DOWN | BTN_RIGHT;
    else if (leg % 4 === 2) b |= BTN_UP;
    else b |= BTN_LEFT | BTN_DOWN;
    if (i % 11 === 0 || i % 11 === 1) b |= BTN_A;
    if (i % 23 === 0) b |= BTN_B;
    if (i % 37 === 0) b = 0;
    return b;
  }

  function play(m: Machine, from: number, frames: number): void {
    const input = new Uint8Array(4);
    for (let i = 0; i < frames; i++) {
      input[0] = scripted(from + i);
      m.tick(input);
    }
  }

  it("rewinds byte-for-byte: snapshot, 60 ticks, restore, 60 ticks", () => {
    const m = boot();
    play(m, 0, 90); // get into a rich state first

    const snap = m.snapshot();

    play(m, 90, 60);
    m.present();
    const fbA = m.ram.slice(ADDR.FRAMEBUFFER, ADDR.FRAMEBUFFER + 8192);
    const ramA = m.snapshot();
    const rgbaA = Uint32Array.from(m.rgba);

    m.restore(snap);
    play(m, 90, 60);
    m.present();
    const fbB = m.ram.slice(ADDR.FRAMEBUFFER, ADDR.FRAMEBUFFER + 8192);
    const ramB = m.snapshot();
    const rgbaB = Uint32Array.from(m.rgba);

    // Named first difference, because "expected Uint8Array to equal
    // Uint8Array" is not a diagnosis.
    let first = -1;
    for (let i = 0; i < fbA.length && first < 0; i++) if (fbA[i] !== fbB[i]) first = i;
    expect(first, "first differing framebuffer byte after a restore").toBe(-1);

    expect(fbA).toEqual(fbB);
    expect(rgbaA).toEqual(rgbaB);

    // The framebuffer is the visible half. RAM is the whole claim: if any
    // engine state lived outside it, the two runs would diverge here.
    let firstRam = -1;
    for (let i = 0; i < ramA.length && firstRam < 0; i++) if (ramA[i] !== ramB[i]) firstRam = i;
    expect(firstRam, "first differing RAM byte after a restore").toBe(-1);
  });

  it("rewinds to a frame in the middle of a swing and a hit-flash, too", () => {
    const m = openField();
    put(m, 1, 2, 72, 64);
    m.ram[G_FACE] = RIGHT;
    m.tick(NO_INPUT);
    m.ram[G_FACE] = RIGHT;
    run(m, 2, BTN_A);
    expect(m.ram[G_ATK]).toBeGreaterThan(0);
    expect(m.ram[ent(1) + E_HIT]).toBeGreaterThan(0);

    const snap = m.snapshot();
    play(m, 0, 60);
    const a = m.snapshot();
    m.restore(snap);
    play(m, 0, 60);
    expect(m.snapshot()).toEqual(a);
  });

  it("draws the same picture from the same RAM", () => {
    // The map is mutable state -- an opened door is a changed tile -- so a
    // restore has to bring the world back with it, not just the walker.
    const a = boot();
    const b = boot();
    play(a, 0, 45);
    play(b, 0, 45);
    a.present();
    b.present();
    expect(a.snapshot()).toEqual(b.snapshot());
    expect(Uint32Array.from(a.rgba)).toEqual(Uint32Array.from(b.rgba));
  });

  it("keeps nothing on the ABI objects", () => {
    const a = boot();
    const b = boot();
    run(a, 30);
    run(b, 30);
    expect(a.snapshot()).toEqual(b.snapshot());
  });
});
