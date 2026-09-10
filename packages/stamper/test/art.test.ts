import { describe, it, expect } from "vitest";

import { decode, decodeMeta, getChunk } from "@sq1/cart";
import { ADDR, HW_PALETTE, createMachine, loadCartBytes } from "@sq1/runtime";

import { formatDiagnostics } from "../src/diagnostics";
import type { Diagnostic } from "../src/diagnostics";
import { parseManifest } from "../src/manifest";
import { parseRecipe } from "../src/recipe";
import { stamp } from "../src/index";
import {
  bind,
  compile,
  merge,
  pack,
  resolve,
  trimTrailingZeroes,
  CHUNK_REGIONS,
  GFX_SHEET_OFFSET,
  SHEET_BYTES,
  SHEET_CELLS,
} from "../src/stages";
import type { StamperIO } from "../src/stages";

/*
 * THE ART CONTRACT.
 *
 * An art pack's bytes become a CART CHUNK, and the player installs that chunk
 * into RAM at boot -- after RAM is zeroed, after the machine's own defaults, and
 * before the cart's own `boot()` runs (specification 3.3). The `GFX ` chunk
 * covers SPRITE_FLAGS and SPRITES; the `PAL ` chunk covers PALETTE_HW and
 * PALETTE_LIVE.
 *
 * Art is data. Carrying it in the cart's SOURCE instead would spend the byte
 * budget twice over, spend tokens on a decoder in every engine, and reach a
 * region the machine already initializes for free.
 *
 * THE `GFX ` CHUNK CARRIES ITS FLAGS FIRST, which is the one thing about the
 * layout that is not guessable. The flags block is a fixed 256 bytes and the
 * sheet is not, so the fixed part goes first and the split is a constant rather
 * than a header -- and the sheet, at the end, can have its trailing zeroes
 * trimmed. Sheet-first, a chunk would have to be 8,193 bytes long before it
 * could say anything about a flag.
 *
 * MOST OF THIS FILE DRIVES THE STAGES DIRECTLY rather than `stamp`, because
 * composing and packing art is settled by `merge` and `pack` and should not be
 * gated on `prove`. The end-to-end test at the bottom is the one that runs the
 * whole pipeline, and it is where installation is actually checked.
 *
 * This file also covers the parts of the recipe and manifest surface the real
 * module packs use and the first draft of the format did not: the engine named
 * inside `[modules]`, `payload` in `[cart]`, and the advisory `[names]` and
 * `[sizes]` tables an art pack documents its indices with.
 */

const enc = new TextEncoder();

function harness(seed: Record<string, string | Uint8Array>): {
  io: StamperIO;
  files: Map<string, Uint8Array>;
} {
  const files = new Map<string, Uint8Array>();
  for (const [path, content] of Object.entries(seed)) {
    files.set(path, typeof content === "string" ? enc.encode(content) : content);
  }
  const dirs = new Set<string>();
  for (const path of files.keys()) {
    let cut = path.lastIndexOf("/");
    while (cut > 0) {
      dirs.add(path.slice(0, cut));
      cut = path.slice(0, cut).lastIndexOf("/");
    }
  }
  const io: StamperIO = {
    readFile(p) {
      const b = files.get(p);
      if (b === undefined) throw new Error(`test io: nothing at ${p}`);
      return b;
    },
    readDir(p) {
      const prefix = `${p.replace(/\/+$/, "")}/`;
      const names = new Set<string>();
      for (const path of files.keys()) {
        if (path.startsWith(prefix)) names.add(path.slice(prefix.length).split("/")[0] as string);
      }
      return [...names];
    },
    exists(p) {
      return files.has(p) || dirs.has(p.replace(/\/+$/, ""));
    },
  };
  return { io, files };
}

/**
 * A pack's data file: `cells * 32` pixel bytes, then `cells` flag bytes.
 *
 * Every byte is non-zero, so nothing this test asserts about placement can pass
 * by accident against the zeroes a trimmed chunk leaves behind.
 */
function packData(cells: number, pixelSeed: number, flagSeed: number): Uint8Array {
  const out = new Uint8Array(cells * 33);
  for (let i = 0; i < cells * 32; i++) out[i] = ((pixelSeed + i) & 0xfe) | 1;
  for (let i = 0; i < cells; i++) out[cells * 32 + i] = ((flagSeed + i) & 0xfe) | 1;
  return out;
}

const ENGINE_TOML = `[module]
kind    = "engine"
name    = "art"
version = "1.0.0"

[knobs.n]
type    = "int"
default = 1
`;

const ENGINE_JS = "function tick() { gfx.cls(KNOB.n); }\n";

const PALETTE = `[module]
kind    = "palette"
name    = "pal"
version = "1.0.0"

[provides]
colors  = 16
entries = [0, 17, 1, 2, 3, 4, 5, 27, 11, 12, 23, 8, 9, 10, 13, 14]
`;

const TILES = `[module]
kind    = "tileset"
name    = "tiles16"
version = "1.0.0"

[provides]
tiles = 16
base  = 0
data  = "t.bin"
flags = ["solid"]

[names]
empty = 0
`;

const SPRITES = `[module]
kind    = "spriteset"
name    = "sprites16"
version = "1.0.0"

[provides]
sprites = 16
base    = 16
data    = "s.bin"

[sizes]
hero = { w = 8, h = 8 }
`;

const RECIPE = `[cart]
title   = "Art"
author  = "eric"
payload = "script/js1"

[modules]
engine    = "art@1.0.0"
palette   = "pal@1.0.0"
tileset   = "tiles16@1.0.0"
spriteset = "sprites16@1.0.0"
`;

const TILE_DATA = packData(16, 0x10, 0x81);
const SPRITE_DATA = packData(16, 0x40, 0xc1);

function tree(overrides: Record<string, string | Uint8Array> = {}) {
  return {
    "/p/modules/art/module.toml": ENGINE_TOML,
    "/p/modules/art/engine.js": ENGINE_JS,
    "/p/modules/pal/module.toml": PALETTE,
    "/p/modules/tiles16/module.toml": TILES,
    "/p/modules/tiles16/t.bin": TILE_DATA,
    "/p/modules/sprites16/module.toml": SPRITES,
    "/p/modules/sprites16/s.bin": SPRITE_DATA,
    "/p/recipe.toml": RECIPE,
    ...overrides,
  };
}

/**
 * Everything up to and including `pack`, with no `prove`.
 *
 * The stages are pure functions of the previous stage's output, so running six
 * of the seven is not a compromise -- it is the split the design is for.
 */
function packFixture(overrides: Record<string, string | Uint8Array> = {}) {
  const h = harness(tree(overrides));
  const recipeText = new TextDecoder().decode(h.files.get("/p/recipe.toml") as Uint8Array);
  const parsed = parseRecipe("/p/recipe.toml", recipeText);
  if (!parsed.ok) return { diagnostics: parsed.diagnostics, packed: null, source: null };

  const resolved = resolve(parsed.recipe, h.io, { modulesRoot: "/p/modules" });
  if (resolved.engine === null || resolved.diagnostics.some((d) => d.severity === "error")) {
    return { diagnostics: resolved.diagnostics, packed: null, source: null };
  }
  const merged = merge(resolved);
  const bound = bind(merged);
  const errors = [...merged.diagnostics, ...bound.diagnostics];
  if (errors.some((d) => d.severity === "error")) {
    return { diagnostics: errors, packed: null, source: null };
  }
  const payload = compile(bound);
  const packed = pack(payload, bound, null);
  return {
    diagnostics: [...errors, ...payload.diagnostics, ...packed.diagnostics],
    packed,
    source: payload.source,
  };
}

/** The `GFX ` chunk of a packed cart. */
function gfxOf(bytes: Uint8Array): Uint8Array {
  const decoded = decode(bytes);
  if (!decoded.ok) throw new Error("cart did not decode");
  const gfx = getChunk(decoded.cart, "GFX ");
  if (gfx === undefined) throw new Error("no GFX chunk");
  return gfx;
}

describe("art packs merge into one GFX chunk", () => {
  it("puts the 256 flag bytes first and the sheet after them", () => {
    const r = packFixture();
    if (r.packed === null) throw new Error(formatDiagnostics(r.diagnostics));
    const gfx = gfxOf(r.packed.bytes);

    // The flags block is fixed-size and comes first, so the sheet starts at a
    // constant offset and its tail can be trimmed. Two packs of sixteen cells
    // fill two sheet rows: 256 + 1024, and no more.
    expect(GFX_SHEET_OFFSET).toBe(SHEET_CELLS);
    expect(gfx.length).toBe(SHEET_CELLS + 1024);
    expect(gfx.length).toBeLessThanOrEqual((CHUNK_REGIONS["GFX "] as { bytes: number }).bytes);

    // THE SAVING THIS LAYOUT EXISTS FOR. Sheet-first, this chunk would be
    // 8192 + 32 bytes: 1024 of pixels, 7168 of nothing, and 32 of flags.
    expect(gfx.length).toBeLessThan(SHEET_BYTES);

    expect([...gfx.subarray(0, 16)]).toEqual([...TILE_DATA.subarray(512, 528)]);
    expect([...gfx.subarray(16, 32)]).toEqual([...SPRITE_DATA.subarray(512, 528)]);
    // Flags 32..255 were never set and are zero, and they are still THERE:
    // the fixed-size half is what makes the split a constant.
    expect([...gfx.subarray(32, SHEET_CELLS)].every((b) => b === 0)).toBe(true);

    // Cell 0 is the tileset's first cell; cell 16 is the start of sheet row 1,
    // which is where the spriteset's base puts it. A `base` read as a byte
    // offset rather than a cell is the classic art-pack bug, and it looks like
    // a game whose tiles are also its characters.
    const sheet = gfx.subarray(GFX_SHEET_OFFSET);
    expect([...sheet.subarray(0, 512)]).toEqual([...TILE_DATA.subarray(0, 512)]);
    expect([...sheet.subarray(512, 1024)]).toEqual([...SPRITE_DATA.subarray(0, 512)]);
  });

  it("puts nothing in the cart's source: the preamble is knobs and the engine", () => {
    const r = packFixture();
    if (r.source === null) throw new Error(formatDiagnostics(r.diagnostics));
    const lines = r.source.split("\n");
    expect(lines[0]).toBe("// generated by @sq1/stamper - do not edit");
    expect(lines[1]).toBe("const KNOB = { n: 1 };");
    expect(lines[2]).toBe("// ---- engine: art@1.0.0 ----");
    expect(r.source).not.toContain("ART");
    // 16 kilobytes of hex would show up here, and does not.
    expect(r.source.length).toBeLessThan(400);
  });

  it("emits no GFX or PAL chunk at all when no pack supplied any", () => {
    const r = packFixture({
      "/p/recipe.toml": '[cart]\ntitle = "Bare"\nauthor = "e"\n\n[modules]\nengine = "art@1.0.0"\n',
    });
    if (r.packed === null) throw new Error(formatDiagnostics(r.diagnostics));
    expect(r.packed.cart.chunks.map((c) => c.type)).toEqual(["META", "CODE", "rcpe"]);
  });

  it("is byte-identical on a second pack, art and all", () => {
    const a = packFixture();
    const b = packFixture();
    if (a.packed === null || b.packed === null) throw new Error("a pack failed");
    expect([...b.packed.bytes]).toEqual([...a.packed.bytes]);
    expect(b.packed.id).toBe(a.packed.id);
  });

  it("ships a palette pack's colours in a PAL chunk, hardware table and all", () => {
    // PALETTE_LIVE is at 0x20C0 and PALETTE_HW is the 192 bytes below it, so a
    // chunk that fills its region from the start carries both. That is the
    // point rather than the price: sixteen live slots indexing a hardware
    // palette the cart did not choose are sixteen colours that mean whatever
    // the player says they mean.
    const r = packFixture();
    if (r.packed === null) throw new Error(formatDiagnostics(r.diagnostics));
    expect(r.diagnostics.filter((d) => d.severity === "error")).toEqual([]);

    const decoded = decode(r.packed.bytes);
    if (!decoded.ok) throw new Error("cart did not decode");
    const pal = getChunk(decoded.cart, "PAL ") as Uint8Array;
    expect(pal).toBeDefined();
    expect(pal.length).toBe(HW_PALETTE.length + 16);
    expect([...pal.subarray(0, HW_PALETTE.length)]).toEqual([...HW_PALETTE]);
    expect([...pal.subarray(HW_PALETTE.length)]).toEqual([
      0, 17, 1, 2, 3, 4, 5, 27, 11, 12, 23, 8, 9, 10, 13, 14,
    ]);

    // NOT trimmed, unlike every other data chunk. Boot leaves the hardware
    // palette and an identity live table at 0x2000 rather than zeroes, so a
    // trimmed tail would install as identity and not as the colour that was
    // trimmed. `trimTrailingZeroes` is only safe over a region boot zeroes.
    expect(pal.length).toBe((CHUNK_REGIONS["PAL "] as { bytes: number }).bytes - 16);
  });

  it("installs that palette: a booted machine shows the pack's live slots", () => {
    const r = packFixture();
    if (r.packed === null) throw new Error(formatDiagnostics(r.diagnostics));
    const loaded = loadCartBytes(r.packed.bytes);
    if (!loaded.ok) throw new Error(loaded.error.message);

    const m = createMachine(loaded.program, { data: loaded.data });
    m.boot(1);
    expect([...m.ram.subarray(ADDR.PALETTE_LIVE, ADDR.PALETTE_LIVE + 16)]).toEqual([
      0, 17, 1, 2, 3, 4, 5, 27, 11, 12, 23, 8, 9, 10, 13, 14,
    ]);
    // And the identity live palette the machine boots with is gone, which is
    // the ordering this depends on: defaults first, then the cart's data.
    expect([...m.ram.subarray(ADDR.PALETTE_LIVE, ADDR.PALETTE_LIVE + 16)]).not.toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
    ]);
  });

  it("refuses a data file whose length disagrees with the declared cell count", () => {
    const r = packFixture({ "/p/modules/tiles16/t.bin": packData(15, 1, 1) });
    expect(r.packed).toBeNull();
    const d = r.diagnostics.find((x) => x.severity === "error") as Diagnostic;
    // The file is present, readable and exactly where the manifest said it
    // would be, so this is NOT a `missing-module-file` -- it used to report one,
    // and an author told their data file was missing went looking for a file
    // that was sitting right there. The count is what is wrong.
    expect(d.code).toBe("data-size-mismatch");
    expect(d.message).toBe(
      "t.bin is 495 bytes, and 16 cells is 528: 512 of pixels then 16 of flags.",
    );
    expect(d.suggestion).toContain("`tiles16@1.0.0` declares 16 cells");
  });

  it("refuses a pack that runs off the end of the sheet", () => {
    const r = packFixture({
      "/p/modules/sprites16/module.toml": SPRITES.replace("base    = 16", "base    = 250"),
    });
    expect(r.packed).toBeNull();
    const d = r.diagnostics.find((x) => x.severity === "error") as Diagnostic;
    expect(d.message).toContain("runs past the sheet's 256 cells");
  });

  it("warns, and lets the later pack win, when two packs claim the same cells", () => {
    const r = packFixture({
      "/p/modules/sprites16/module.toml": SPRITES.replace("base    = 16", "base    = 0"),
    });
    if (r.packed === null) throw new Error(formatDiagnostics(r.diagnostics));
    const warning = r.diagnostics.find((d) => d.message.includes("draws over sheet cell 0"));
    expect(warning).toBeDefined();
    // Later modules win: the spriteset is listed after the tileset.
    const sheet = gfxOf(r.packed.bytes).subarray(GFX_SHEET_OFFSET);
    expect([...sheet.subarray(0, 512)]).toEqual([...SPRITE_DATA.subarray(0, 512)]);
  });

  it("refuses a palette entry outside the console's 64 hardware colours", () => {
    const r = packFixture({
      "/p/modules/pal/module.toml": PALETTE.replace("entries = [0, 17", "entries = [0, 99"),
    });
    expect(r.packed).toBeNull();
    const d = r.diagnostics.find((x) => x.severity === "error") as Diagnostic;
    expect(d.message).toContain("a live slot names one of the console's 64 hardware colours");
  });

  it("refuses a palette with more than sixteen entries", () => {
    const r = packFixture({
      "/p/modules/pal/module.toml": PALETTE.replace("13, 14]", "13, 14, 15]"),
    });
    expect(r.packed).toBeNull();
    const d = r.diagnostics.find((x) => x.severity === "error") as Diagnostic;
    expect(d.message).toContain("17 colours, and the console has 16 live slots");
  });

  it("refuses a [provides] data file that is not in the module", () => {
    const h = harness(tree());
    h.files.delete("/p/modules/tiles16/t.bin");
    const result = stamp("/p/recipe.toml", h.io, { modulesRoot: "/p/modules", frames: 4 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect((result.diagnostics[0] as Diagnostic).message).toContain('[provides] data names "t.bin"');
  });

  it("trims trailing zeroes, because a short chunk installs the same as a padded one", () => {
    expect([...trimTrailingZeroes(new Uint8Array([1, 2, 0, 0]))]).toEqual([1, 2]);
    expect([...trimTrailingZeroes(new Uint8Array([0, 0, 0]))]).toEqual([]);
    expect([...trimTrailingZeroes(new Uint8Array([0, 1]))]).toEqual([0, 1]);
    expect([...trimTrailingZeroes(new Uint8Array(0))]).toEqual([]);
  });

  it("maps every installable chunk to the region the specification gives it", () => {
    // DERIVED from the runtime's own `DATA_REGIONS` rather than restated, so
    // the two cannot drift into a stamper that packs a cart the player refuses.
    // The literal below is here to make a move of the map visible in a diff.
    expect(CHUNK_REGIONS).toEqual({
      "PAL ": { address: 0x2000, bytes: 224 },
      "GFX ": { address: 0x2200, bytes: 8448 },
      "MAP ": { address: 0x4300, bytes: 8192 },
      "SFX ": { address: 0x6300, bytes: 3328 },
      "MUS ": { address: 0x7000, bytes: 2048 },
      DATA: { address: 0x7800, bytes: 34560 },
    });
    // `labl` is a cart's picture and is never installed, so it has no region.
    expect(CHUNK_REGIONS["labl"]).toBeUndefined();
  });
});

describe("prove will not certify a cart whose data is not in RAM", () => {
  it("proves a cart with art, with that art actually in RAM", () => {
    // The whole pipeline, ending in a run. `prove` refuses to record a chain
    // for a cart whose chunks did not reach RAM -- a chain hashed against a
    // blank sprite sheet looks exactly like a real one, goes into `rcpe` as the
    // cart's proof, and is reproduced by no player anywhere.
    const h = harness(tree());
    const result = stamp("/p/recipe.toml", h.io, { modulesRoot: "/p/modules", frames: 16 });
    if (!result.ok) throw new Error(formatDiagnostics(result.diagnostics));

    expect(result.proof.frames).toBe(16);
    expect(result.proof.chain).toMatch(/^[0-9a-f]{64}$/);
    expect([...gfxOf(result.bytes).subarray(GFX_SHEET_OFFSET, GFX_SHEET_OFFSET + 512)]).toEqual([
      ...TILE_DATA.subarray(0, 512),
    ]);

    // And the bytes are where the engine would read them: SPRITES at 0x2200 and
    // SPRITE_FLAGS at 0x4200, on a machine booted from the cart file.
    const loaded = loadCartBytes(result.bytes);
    if (!loaded.ok) throw new Error(loaded.error.message);
    const m = createMachine(loaded.program, { data: loaded.data });
    m.boot(1);
    expect([...m.ram.subarray(ADDR.SPRITES, ADDR.SPRITES + 512)]).toEqual([
      ...TILE_DATA.subarray(0, 512),
    ]);
    expect([...m.ram.subarray(ADDR.SPRITE_FLAGS, ADDR.SPRITE_FLAGS + 16)]).toEqual([
      ...TILE_DATA.subarray(512, 528),
    ]);
  });

  it("discriminates on CONTENT, so it is not just refusing every cart with a chunk", () => {
    // A negative control. The check asks whether each chunk's bytes are in RAM,
    // not whether a chunk exists -- so a pack whose cells are entirely zero
    // installs zeroes over zeroes, is unobservable, and has nothing to prove.
    // Without this, "refuse every cart carrying data" would pass the test above
    // and would be useless the day installation lands.
    const blank = new Uint8Array(16 * 33);
    const h = harness(
      tree({
        // A pack that marks nothing may not CLAIM to mark something: a declared
        // flag is checked against the flag bytes shipped (`checkFlagBytes` in
        // stages.ts), and this fixture's whole point is that its bytes are zero.
        // Dropping the claim is what makes it an honest blank pack rather than a
        // broken one, and leaves the negative control it is here to be intact.
        "/p/modules/tiles16/module.toml": TILES.replace('flags = ["solid"]\n', ""),
        "/p/modules/tiles16/t.bin": blank,
        "/p/modules/sprites16/s.bin": blank,
        "/p/modules/pal/module.toml": PALETTE.replace(/entries = \[[^\]]*\]/, "entries = []"),
      }),
    );
    const result = stamp("/p/recipe.toml", h.io, { modulesRoot: "/p/modules", frames: 8 });
    if (!result.ok) throw new Error(formatDiagnostics(result.diagnostics));
    expect(result.proof.frames).toBe(8);
    // An all-zero sheet trims away entirely, so there is no chunk to install.
    expect(decode(result.bytes).ok).toBe(true);
  });
});

describe("the two spellings of the engine, and the rest of the recipe surface", () => {
  it('accepts `[modules] engine = "..."`, which the module packs are written against', () => {
    const r = packFixture();
    if (r.source === null) throw new Error(formatDiagnostics(r.diagnostics));
    expect(r.source).toContain("// ---- engine: art@1.0.0 ----");
  });

  it("accepts the specification's `[engine] use` spelling, and compiles the same code", () => {
    const viaTable = RECIPE.replace(
      '[modules]\nengine    = "art@1.0.0"\n',
      '[engine]\nuse = "art@1.0.0"\n\n[modules]\n',
    );
    const a = packFixture();
    const b = packFixture({ "/p/recipe.toml": viaTable });
    if (a.source === null || b.source === null) throw new Error("a pack failed");
    // The recipe TEXT differs, so the rcpe chunk differs and so does the id.
    // The CODE is what has to be identical: the two spellings mean one thing.
    expect(b.source).toBe(a.source);
  });

  it("refuses a recipe that names an engine twice", () => {
    const both = RECIPE.replace("[modules]", '[engine]\nuse = "art@1.0.0"\n\n[modules]');
    const r = packFixture({ "/p/recipe.toml": both });
    expect(r.packed).toBeNull();
    const d = r.diagnostics.find((x) => x.severity === "error") as Diagnostic;
    expect(d.message).toContain("names an engine twice");
  });

  it("carries [cart] payload into META, and refuses the reserved one", () => {
    const r = packFixture();
    if (r.packed === null) throw new Error(formatDiagnostics(r.diagnostics));
    const decoded = decode(r.packed.bytes);
    if (!decoded.ok) throw new Error("did not decode");
    const meta = decodeMeta(getChunk(decoded.cart, "META") as Uint8Array);
    expect(meta.ok && meta.meta.payload).toBe("script/js1");

    const wasm = packFixture({ "/p/recipe.toml": RECIPE.replace('"script/js1"', '"wasm/1"') });
    expect(wasm.packed).toBeNull();
    const d = wasm.diagnostics.find((x) => x.severity === "error") as Diagnostic;
    expect(d.message).toContain("reserved");
  });

  it("reads [names] and [sizes] as advisory, and warns about a section it does not know", () => {
    const clean = parseManifest("/m/module.toml", TILES);
    expect(clean.ok).toBe(true);
    expect(clean.diagnostics).toEqual([]);

    const odd = parseManifest("/m/module.toml", `${TILES}\n[colours]\nx = 1\n`);
    expect(odd.ok).toBe(true);
    expect(odd.diagnostics).toHaveLength(1);
    expect(odd.diagnostics[0]).toMatchObject({
      severity: "warning",
      message: "this manifest has a [colours] section, which the stamper does not read.",
    });
  });
});
