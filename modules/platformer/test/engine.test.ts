/**
 * The platformer engine, tested against a real machine.
 *
 * THIS FILE IS THE STAMPER'S STAND-IN, and deliberately so: it reads
 * module.toml the way the stamper does, builds the same `const KNOB = {...}`
 * preamble, composes the same `PAL ` and `GFX ` chunks out of the same art
 * packs, and hands both to `compileCart` and `createMachine`. That pins the
 * whole contract from this side -- if the stamper emits a different preamble,
 * or lays a chunk out differently, this file is what says so.
 *
 * The preamble is KNOBS AND NOTHING ELSE. The art is not in it: a cart's `PAL `,
 * `GFX ` and `MAP ` chunks are installed into RAM by the player between zeroing
 * and `boot()` (specification 3.3), so this file builds them and passes them to
 * `createMachine` as `data`, which is exactly what `loadCartBytes` does with a
 * real cart file.
 *
 * The knob values come from module.toml's defaults, and from
 * examples/cave-runner/recipe.toml for the knobs the manifest declares REQUIRED
 * by omitting a default. So a knob added to the engine and not to the manifest
 * fails here, and so does a required knob the example recipe forgot.
 *
 * The scenario tests build their OWN maps by poking the MAP region after boot.
 * The engine's generated cave is a fine thing to look at and a terrible thing to
 * assert against; a three-tile ledge in a known place is not.
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

const MOD = "modules/platformer";
const ENGINE_SRC = readFileSync(`${MOD}/engine.js`, "utf8");
const ENGINE_TOML = readFileSync(`${MOD}/module.toml`, "utf8");
const RECIPE_TOML = readFileSync("examples/cave-runner/recipe.toml", "utf8");
const PALETTE_TOML = readFileSync("modules/sweetie16/module.toml", "utf8");
const TILES_BIN = readFileSync("modules/caves/tiles.bin");
const SPRITES_BIN = readFileSync("modules/hero/sprites.bin");

// ---------------------------------------------------------------------------
// Just enough TOML to read a manifest.
//
// Deliberately small and deliberately strict about what it looks at: only
// `[knobs.*]`'s `type` and `default`, only `[tuning]`, only `entries`. A real
// parser belongs in the stamper, and a half-real one here would drift from it.
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
 * A `fixed` knob becomes an exact division by 65536 rather than a decimal, so
 * the value the cart sees is bit-identical on every engine: 0.42 is not
 * representable and `27524 / 65536` is, and two engines that both round the
 * same 16.16 numerator land on the same double.
 *
 * The conversion is `fromFloat` FROM @sq1/core, and not a local `Math.round`
 * that happens to agree with it. There is one float-to-fixed conversion in this
 * repository and the stamper's `bind` uses the same one, so a change to the
 * console's rounding cannot leave this test asserting against the old rule --
 * which is the drift this project keeps finding.
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
    const v = k.def !== undefined ? k.def : TUNING.get(name);
    if (v === undefined) throw new Error(`knob "${name}" has no default and the recipe does not set it`);
    out.set(name, v);
  }
  return out;
}

const VALUES = resolve();

/**
 * The `GFX ` chunk: the art packs merged into one flags block and one sheet.
 *
 * `caves` declares base 0 and `hero` base 64. A base is a SHEET CELL, and the
 * sheet is one 128-pixel-wide picture, so cell 64 is the start of sheet row 4 --
 * pixel row 32, byte offset 32 * 64. Getting this wrong is the classic art-pack
 * bug and it looks like a game whose tiles are also its characters.
 *
 * THE FLAGS COME FIRST INSIDE THE CHUNK, at offset 0, and the sheet follows at
 * `GFX_SHEET_OFFSET`. The flags block is fixed-size and the sheet is not, so
 * the fixed part goes first and the split needs no header.
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

/**
 * The cart's static data, planned by the runtime's own planner.
 *
 * Not placed into RAM by hand: `planCartData` is the function `loadCartBytes`
 * calls, so a chunk laid out wrongly here fails here rather than passing this
 * file and failing on a real cart.
 */
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
const G_DEAD = U + 0;
const G_DEATHS = U + 1;
const G_GEMS = U + 2;
const G_CAMX = U + 4;
const G_CAMY = U + 8;
const E_BASE = U + 16;
const E_SIZE = 20;
const E_X = 0;
const E_Y = 4;
const E_VX = 8;
const E_VY = 12;
const E_KIND = 16;
const E_COY = 18;

const BTN_LEFT = 1 << 2;
const BTN_RIGHT = 1 << 3;
const BTN_A = 1 << 4;

const N = VALUES.get("entities") as number;
const PW = VALUES.get("player_width") as number;
const PH = VALUES.get("player_height") as number;
const MAP_W_TILES = VALUES.get("map_width") as number;
const MAP_H_TILES = VALUES.get("map_height") as number;
const COYOTE = VALUES.get("coyote_frames") as number;

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

/** The player's position in whole pixels, the way the engine draws it. */
function px(m: Machine): number {
  return r32(m, ent(0) + E_X) >> 8;
}
function py(m: Machine): number {
  return r32(m, ent(0) + E_Y) >> 8;
}
function vy(m: Machine): number {
  return r32(m, ent(0) + E_VY);
}

function place(m: Machine, x: number, y: number): void {
  const e = ent(0);
  w32(m, e + E_X, x * SUB);
  w32(m, e + E_Y, y * SUB);
  w32(m, e + E_VX, 0);
  w32(m, e + E_VY, 0);
}

/** Empty the tile map. Tile 0 is the console's "nothing" and is never drawn. */
function clearMap(m: Machine): void {
  m.ram.fill(0, ADDR.MAP, ADDR.MAP + 8192);
}

function setTile(m: Machine, tx: number, ty: number, t: number): void {
  m.ram[ADDR.MAP + ty * 128 + tx] = t;
}

/** Retire every entity but the player, so a scenario is only the scenario. */
function clearPool(m: Machine): void {
  for (let i = 1; i < N; i++) m.ram[ent(i) + E_KIND] = 0;
}

const NO_INPUT = new Uint8Array(4);

function run(m: Machine, frames: number, buttons = 0): void {
  const input = new Uint8Array(4);
  input[0] = buttons;
  for (let i = 0; i < frames; i++) m.tick(input);
}

function boot(): Machine {
  // `data` is how a cart's art reaches RAM, and it is passed here for the same
  // reason `loadCartBytes` returns it: the engine reads sprite flags while it
  // generates its level, on the boot that installs them.
  const m = createMachine(compileCart(SOURCE, { name: "platformer" }), { data: DATA });
  m.boot(1);
  return m;
}

/**
 * A cleared machine on a flat floor: solid rock along tile row `groundRow`
 * across the whole map, nothing else, no pool.
 */
const SOLID_TILE = 1; // caves: `rock`, flagged solid
const HAZARD_TILE = 23; // caves: `spikes_up`, flagged hazard
const GROUND_ROW = 20;
const FLOOR_TOP = GROUND_ROW * 8; // 160: the y of the floor's top pixel
const STAND_Y = FLOOR_TOP - PH; // where a body at rest on that floor sits

function flatWorld(): Machine {
  const m = boot();
  clearMap(m);
  clearPool(m);
  for (let tx = 0; tx < MAP_W_TILES; tx++) {
    for (let ty = GROUND_ROW; ty < MAP_H_TILES; ty++) setTile(m, tx, ty, SOLID_TILE);
  }
  return m;
}

// ===========================================================================

describe("the platformer engine as a cart", () => {
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
    expect(unset, "required knobs examples/cave-runner/recipe.toml does not set").toEqual([]);
  });

  it("passes the build gate: no forbidden names, inside the token budget", () => {
    const result = lintCartSource(SOURCE);
    expect(result.findings.map((f) => `${f.rule} ${f.identifier ?? ""} @${f.line}`)).toEqual([]);
    expect(result.tokens).toBeLessThan(TOKEN_BUDGET);
    // Reported so a change that costs a thousand tokens is visible in the log.
    console.log(
      `platformer: engine ${countTokens(ENGINE_SRC)} tokens, ` +
        `stamped cart ${result.tokens} of ${TOKEN_BUDGET}`,
    );
  });

  it("boots and ticks without throwing", () => {
    const m = boot();
    expect(() => run(m, 120)).not.toThrow();
    expect(m.ram[ent(0) + E_KIND]).toBe(1); // the player is entity 0, always
  });

  it("builds a level and fills part of the entity pool", () => {
    const m = boot();
    let solidTiles = 0;
    for (let i = 0; i < 8192; i++) {
      if (m.ram[ADDR.MAP + i]! !== 0) solidTiles++;
    }
    expect(solidTiles).toBeGreaterThan(500);

    let used = 0;
    for (let i = 1; i < N; i++) if (m.ram[ent(i) + E_KIND]! !== 0) used++;
    expect(used).toBeGreaterThan(0);
  });

  it("leaves the spawn point clear, and a floor under it", () => {
    // Regression. Ledges were generated in every chunk including the first, so
    // a seed that put one across column 2 spawned the player inside a solid
    // tile. The first two chunks are now floor and nothing else.
    const m = boot();
    const sx = VALUES.get("start_tile_x") as number;
    const sy = VALUES.get("start_tile_y") as number;
    const flagsOf = (tx: number, ty: number): number =>
      m.ram[ADDR.SPRITE_FLAGS + m.ram[ADDR.MAP + ty * 128 + tx]!]!;

    for (let ty = sy; ty < sy + Math.ceil(PH / 8) + 1; ty++) {
      for (let tx = sx; tx < sx + 2; tx++) {
        expect(flagsOf(tx, ty) & 0x03, `tile at (${tx}, ${ty}) is not clear`).toBe(0);
      }
    }

    // And the fall from the spawn ends on solid ground rather than in a pit.
    run(m, 60);
    expect(m.ram[G_DEATHS]).toBe(0);
    expect(py(m)).toBeGreaterThan(sy * 8);
  });

  it("is the same level every time, from the same seed", () => {
    const a = boot();
    const b = boot();
    expect(a.ram.subarray(ADDR.MAP, ADDR.MAP + 8192)).toEqual(b.ram.subarray(ADDR.MAP, ADDR.MAP + 8192));
  });
});

describe("gravity and tile collision", () => {
  it("falls, and falls faster each frame", () => {
    const m = boot();
    clearMap(m);
    clearPool(m);
    place(m, 64, 16);

    const y0 = py(m);
    run(m, 1);
    const v1 = vy(m);
    const y1 = py(m);
    run(m, 1);
    const v2 = vy(m);

    expect(y1).toBeGreaterThanOrEqual(y0);
    expect(v1).toBeGreaterThan(0);
    expect(v2).toBeGreaterThan(v1);
    run(m, 20);
    expect(py(m)).toBeGreaterThan(y1);
  });

  it("lands on a solid tile and stops there", () => {
    const m = flatWorld();
    place(m, 64, 96);
    run(m, 60);

    expect(py(m)).toBe(STAND_Y);

    // And STAYS there: gravity is still added every frame, so a landing that
    // only worked once would show up as a slow sink.
    for (let i = 0; i < 30; i++) {
      run(m, 1);
      expect(py(m)).toBe(STAND_Y);
    }
  });

  it("stops against a wall instead of passing through it", () => {
    const m = flatWorld();
    for (let ty = GROUND_ROW - 4; ty < GROUND_ROW; ty++) setTile(m, 12, ty, SOLID_TILE);
    place(m, 64, STAND_Y); // tile column 8, four columns left of the wall
    run(m, 120, BTN_RIGHT);

    // The wall's left face is at x = 96; a PW-wide box stops with its right
    // edge there.
    expect(px(m) + PW).toBe(12 * 8);
  });

  it("does not fling a body that is already inside a wall", () => {
    // Regression. Resolving against the leading edge alone snaps an embedded
    // body to the far face of the tile it is standing in -- a whole body-width
    // outward -- and then does it again from there. A body spawned one tile
    // inside a wall walked itself hundreds of pixels off the map in under a
    // second, which is how this was found. The answer is that a resolution may
    // never move a body backwards; a body in a wall simply does not move.
    const m = flatWorld();
    for (let ty = GROUND_ROW - 4; ty < GROUND_ROW; ty++) setTile(m, 10, ty, SOLID_TILE);
    place(m, 10 * 8, (GROUND_ROW - 4) * 8);

    run(m, 90, BTN_RIGHT);
    expect(px(m)).toBe(10 * 8);
    expect(py(m)).toBe((GROUND_ROW - 4) * 8);

    // Pushed the other way there IS somewhere to go -- the wall is one column
    // wide and its left side is open -- so the body walks out of it and then
    // stops at the edge of the world. Leaving a wall the way that is open is
    // right; leaving it through the solid side is the bug.
    run(m, 90, BTN_LEFT);
    expect(px(m)).toBeGreaterThanOrEqual(0);
    expect(px(m)).toBeLessThanOrEqual(10 * 8);
  });

  it("resolves X and Y separately, so a run along a flat floor never snags", () => {
    const m = flatWorld();
    place(m, 32, STAND_Y);
    for (let i = 0; i < 200; i++) {
      run(m, 1, BTN_RIGHT);
      expect(py(m)).toBe(STAND_Y); // never lifted, never sunk, at any x
    }
    expect(px(m)).toBeGreaterThan(100); // and it actually got somewhere
  });
});

describe("jumping", () => {
  it("rises and then falls", () => {
    const m = flatWorld();
    place(m, 64, STAND_Y);
    run(m, 4); // settle on the floor

    // btnp is "set now, clear previously", so the press has to be new.
    m.tick(NO_INPUT);
    const start = py(m);
    run(m, 1, BTN_A);
    expect(vy(m)).toBeLessThan(0);

    let top = start;
    for (let i = 0; i < 20; i++) {
      run(m, 1, BTN_A);
      if (py(m) < top) top = py(m);
    }
    expect(top).toBeLessThan(start - 8); // it cleared at least a tile

    run(m, 60, BTN_A);
    expect(py(m)).toBe(STAND_Y); // and came back down to the same floor
  });

  it("cuts the rise short when A is released early", () => {
    /** The highest the player gets over `frames`, holding `buttons` throughout. */
    function apex(hold: boolean): number {
      const m = flatWorld();
      place(m, 64, STAND_Y);
      run(m, 4);
      m.tick(NO_INPUT);
      run(m, 1, BTN_A);
      let top = py(m);
      for (let i = 0; i < 30; i++) {
        run(m, 1, hold ? BTN_A : 0);
        if (py(m) < top) top = py(m);
      }
      return top;
    }
    // Smaller y is higher. Holding A must get further off the floor than
    // letting go on the frame after the press.
    expect(apex(true)).toBeLessThan(apex(false));
  });

  it("buffers a jump pressed just before landing", () => {
    const buffer = VALUES.get("jump_buffer_frames") as number;
    expect(buffer).toBeGreaterThan(0);

    /**
     * Fall onto the floor, pressing A exactly once when the player is `lead`
     * pixels above it, and report whether a jump came out of the landing.
     *
     * `lead` is the whole experiment: a press a couple of pixels up is inside
     * the buffer window and must be spent on the landing, and a press taken
     * near the top of a forty-pixel drop is not and must be forgotten. A buffer
     * that never expired would be indistinguishable from no input handling at
     * all.
     */
    function pressAt(lead: number): boolean {
      const m = flatWorld();
      place(m, 64, STAND_Y - 40);
      let pressed = false;
      for (let i = 0; i < 60; i++) {
        let b = 0;
        if (!pressed && STAND_Y - py(m) <= lead) {
          b = BTN_A;
          pressed = true;
        }
        run(m, 1, b);
        if (vy(m) < 0) return true; // rising: the jump fired
      }
      expect(pressed, `never got within ${lead}px of the floor`).toBe(true);
      return false;
    }

    expect(pressAt(4), "a press just above the floor is buffered").toBe(true);
    expect(pressAt(40), "a press a whole drop early is forgotten").toBe(false);
  });
});

describe("coyote time", () => {
  /**
   * Walk off the end of a five-tile ledge and jump N frames later.
   *
   * The engine keeps the coyote counter in the player's own RAM at E_COY, and
   * it is refilled to `coyote_frames` on every grounded frame -- so the first
   * frame the counter reads LESS than that is the first airborne frame, and
   * counting from there is exact rather than approximate.
   */
  function walkOffAndJumpAfter(delay: number): { rose: boolean; drop: number } {
    const m = boot();
    clearMap(m);
    clearPool(m);
    for (let tx = 8; tx <= 12; tx++) setTile(m, tx, GROUND_ROW, SOLID_TILE);
    place(m, 8 * 8, STAND_Y);
    run(m, 4); // settle, so the counter is full

    // Walk right until the counter starts to run down.
    let guard = 0;
    while (m.ram[ent(0) + E_COY]! === COYOTE && guard++ < 200) run(m, 1, BTN_RIGHT);
    expect(guard).toBeLessThan(200);
    expect(m.ram[ent(0) + E_COY]).toBe(COYOTE - 1); // airborne, one frame in

    for (let i = 0; i < delay; i++) run(m, 1, BTN_RIGHT);

    const before = py(m);
    run(m, 1, BTN_RIGHT | BTN_A); // A is new this frame: btnp fires
    const rose = vy(m) < 0;
    run(m, 6, BTN_RIGHT | BTN_A);
    return { rose, drop: py(m) - before };
  }

  it("lets a jump pressed inside the window rise", () => {
    const { rose, drop } = walkOffAndJumpAfter(1);
    expect(rose).toBe(true);
    expect(drop).toBeLessThan(0); // higher six frames later than when it jumped
  });

  it("does not let a jump pressed after the window rise", () => {
    const { rose, drop } = walkOffAndJumpAfter(COYOTE + 2);
    expect(rose).toBe(false);
    expect(drop).toBeGreaterThan(0); // still falling, as it should be
  });
});

describe("hazards", () => {
  it("kills on a hazard tile and respawns at the start", () => {
    const startX = (VALUES.get("start_tile_x") as number) * 8;
    const startY = (VALUES.get("start_tile_y") as number) * 8;
    const deathFrames = VALUES.get("death_frames") as number;

    const m = flatWorld();
    setTile(m, 10, GROUND_ROW - 1, HAZARD_TILE);
    place(m, 10 * 8, STAND_Y);
    expect(m.ram[G_DEATHS]).toBe(0);

    run(m, 1);
    expect(m.ram[G_DEAD]).toBe(deathFrames);
    expect(m.ram[G_DEATHS]).toBe(1);

    // The timer runs down and the respawn happens exactly once.
    let guard = 0;
    while (m.ram[G_DEAD]! !== 0 && guard++ < deathFrames * 4) run(m, 1);
    expect(guard).toBeLessThan(deathFrames * 4);
    expect(px(m)).toBe(startX);
    expect(py(m)).toBe(startY);
    expect(m.ram[G_DEATHS]).toBe(1);
  });

  it("kills on falling out of the bottom of the world", () => {
    const m = boot();
    clearMap(m);
    clearPool(m);
    place(m, 64, MAP_H_TILES * 8 - 8);
    run(m, 30);
    expect(m.ram[G_DEATHS]).toBeGreaterThan(0);
  });

  it("collects a gem it touches", () => {
    const m = flatWorld();
    const g = ent(1);
    m.ram[g + E_KIND] = 3;
    w32(m, g + E_X, 64 * SUB);
    w32(m, g + E_Y, STAND_Y * SUB);
    place(m, 64, STAND_Y);

    expect(m.ram[G_GEMS]).toBe(0);
    run(m, 2);
    expect(m.ram[G_GEMS]).toBe(1);
    expect(m.ram[g + E_KIND]).toBe(0); // and it is gone, not collected twice
    run(m, 10);
    expect(m.ram[G_GEMS]).toBe(1);
  });
});

describe("the camera", () => {
  it("clamps at the left edge instead of showing outside the map", () => {
    const m = flatWorld();
    place(m, 0, STAND_Y);
    run(m, 60);
    expect(r32(m, G_CAMX) >> 8).toBe(0);
  });

  it("clamps at the right edge", () => {
    const m = flatWorld();
    place(m, (MAP_W_TILES - 1) * 8, STAND_Y);
    run(m, 60);
    expect(r32(m, G_CAMX) >> 8).toBe(MAP_W_TILES * 8 - 128);
  });

  it("clamps at the bottom edge", () => {
    // A floor two rows from the bottom of the map, so the player can stand low
    // enough that the camera's target is below the last full screen.
    const m = boot();
    clearMap(m);
    clearPool(m);
    const row = MAP_H_TILES - 2;
    for (let tx = 0; tx < MAP_W_TILES; tx++) setTile(m, tx, row, SOLID_TILE);
    place(m, 64, row * 8 - PH);
    run(m, 60);
    expect(r32(m, G_CAMY) >> 8).toBe(MAP_H_TILES * 8 - 128);
  });

  it("follows the player away from an edge", () => {
    const m = flatWorld();
    place(m, 400, STAND_Y);
    run(m, 60);
    const cam = r32(m, G_CAMX) >> 8;
    expect(cam).toBeGreaterThan(0);
    expect(cam).toBeLessThan(MAP_W_TILES * 8 - 128);
    // Centred on the player, give or take the look-ahead.
    const look = VALUES.get("camera_lookahead") as number;
    expect(cam).toBe(400 + (PW >> 1) - 64 + look);
  });
});

describe("state containment", () => {
  /**
   * The input script. Deliberately varied -- runs, turns, jumps, releases
   * mid-rise -- so that sixty frames of it visit the acceleration, friction,
   * jump-cut, coyote, buffer, collision, camera and animation paths rather than
   * one straight line of falling.
   */
  function scripted(i: number): number {
    let b = 0;
    if (i % 40 < 24) b |= BTN_RIGHT;
    else b |= BTN_LEFT;
    if (i % 13 === 0 || i % 13 === 1 || i % 13 === 2) b |= BTN_A;
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

  it("rewinds to a frame in the middle of a death, too", () => {
    const m = flatWorld();
    setTile(m, 10, GROUND_ROW - 1, HAZARD_TILE);
    place(m, 10 * 8, STAND_Y);
    run(m, 2); // dying
    expect(m.ram[G_DEAD]).toBeGreaterThan(0);

    const snap = m.snapshot();
    play(m, 0, 60);
    const a = m.snapshot();
    m.restore(snap);
    play(m, 0, 60);
    expect(m.snapshot()).toEqual(a);
  });

  it("keeps nothing on the ABI objects", () => {
    // The machine freezes gfx/inp/snd/sys precisely so a cart cannot stash a
    // field on one. Two machines from the same source must therefore start
    // identically, which they would not if the engine had smuggled anything
    // into a shared object.
    const a = boot();
    const b = boot();
    run(a, 30);
    run(b, 30);
    expect(a.snapshot()).toEqual(b.snapshot());
  });
});
