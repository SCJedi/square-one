import { describe, it, expect } from "vitest";

import { MAX_CART_BYTES } from "@sq1/cart";

import { sortDiagnostics } from "../src/diagnostics";
import type { Diagnostic } from "../src/diagnostics";
import { stamp } from "../src/index";
import type { StamperIO } from "../src/stages";

/*
 * THE REJECTION SUITE.
 *
 * A MANIFEST IS A CLAIM. THE STAMPER'S JOB IS TO VERIFY CLAIMS AGAINST BYTES.
 *
 * That sentence is what the gap list at the bottom of this file was about, and
 * six of its eight entries are now closed: a declared flag is checked against
 * the flag bytes a pack ships, a pack's flag BIT against the engine's knob of
 * the same name, an index knob against the size of the pack it indexes, an
 * `int` knob's range against its own type, and a later layer may no longer
 * redeclare an earlier layer's knob with a different type. The two that remain
 * are `it.fails` still, and both are deliberate -- see the notes on them.
 *
 * `manifest.ts` opens by claiming that because an engine states what it needs
 * and a tileset states what it offers, "a recipe is type-checked before
 * anything is built -- which is the difference between a template system that
 * stamps working carts and one that stamps plausible-looking broken ones."
 *
 * Everywhere else in this package the fixtures are recipes that BUILD. A
 * type-checker that has only ever been run on inputs that pass is not known to
 * check anything, so this file is the other half: one broken recipe per way the
 * contract can be broken, asserting the exact diagnostic code AND that the
 * message names the thing that is wrong. A diagnostic reading "invalid module"
 * is a failure of this file even when its code is right, because a vague
 * message is what sends an author back to hand-written carts.
 *
 * THE LAST DESCRIBE BLOCK IS THE IMPORTANT ONE.
 *
 * `WHAT THE CONTRACT DID NOT CHECK` holds the cases where a rejection SHOULD
 * happen. Each was written as the assertion that would pass the day the check
 * existed and marked `it.fails`, so the suite was green while the gap was open,
 * documented the gap in code rather than in a comment nobody reads, and turned
 * RED the moment somebody closed one and forgot to flip the marker. Six have
 * been closed and are plain `it` now; the two that remain are `it.fails` and
 * are deliberate, each with its reason written on it. A gap is closed by
 * writing the check, never by deleting the test.
 *
 * Fixtures live in a Map, as everywhere else in this package: no temporary
 * directory, no dependence on `modules/` existing, and every path in a message
 * is a path this file made up.
 */

const enc = new TextEncoder();

function harness(seed: Record<string, string | Uint8Array>): StamperIO {
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
  return {
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
}

/**
 * An art pack's data file: `cells * 32` pixel bytes then `cells` flag bytes.
 *
 * `flagByte` is what every cell is marked with. It matters here in a way it
 * does not in art.test.ts: several of the gaps below are about the relationship
 * between the flags a manifest CLAIMS and the flag bytes a pack SHIPS, and
 * those two are only distinguishable if a test can set the second one.
 */
function packData(cells: number, pixelSeed: number, flagByte: number): Uint8Array {
  const out = new Uint8Array(cells * 33);
  for (let i = 0; i < cells * 32; i++) out[i] = ((pixelSeed + i) & 0xfe) | 1;
  for (let i = 0; i < cells; i++) out[cells * 32 + i] = flagByte;
  return out;
}

/**
 * A TILESET's data for the fixture below: every cell marked `solid` on bit 1,
 * and the last one also marked `hazard` on bit 2.
 *
 * The control fixture USED TO SHIP `packData(64, 0x10, 0x01)` -- a pack whose
 * manifest declares `flags = ["solid", "hazard"]` and `hazard_flag = 2`, and
 * whose every flag byte leaves bit 2 clear. That is precisely GAP 1: a claim no
 * byte supports, satisfying an engine's `requires` on the sentence alone. The
 * control was itself an instance of the bug the gap list was written about, so
 * closing GAP 1 refuses it -- correctly -- and this function is the fix. It is
 * the ONLY fixture change this file needed to keep its controls building.
 */
function tilesetData(cells: number, pixelSeed = 0x10): Uint8Array {
  const out = packData(cells, pixelSeed, 0x01);
  out[cells * 33 - 1] = 0x02;
  return out;
}

// --- the fixture module set ------------------------------------------------
//
// Shaped like `platformer` and the packs it runs on -- an engine that asks for
// a palette, a tileset of at least 64 tiles marking `solid` and `hazard`, and a
// spriteset of at least twelve cells -- because the claims under test are about
// exactly that handshake.

const ENGINE_TOML = `[module]
kind    = "engine"
name    = "runner"
version = "1.0.0"

[provides]
entities = 24

[requires]
palette   = true
tileset   = { min_tiles = 64, flags = ["solid", "hazard"] }
spriteset = { min_sprites = 12 }
soundbank = false

[knobs.gravity]
type    = "fixed"
default = 0.42
min     = 0.0
max     = 4.0
doc     = "Downward acceleration per frame, in pixels."

[knobs.coyote_frames]
type    = "int"
default = 6
min     = 0
max     = 30

[knobs.edge_solid]
type    = "bool"
default = true

[knobs.tile_floor]
type = "int"
min  = 1
max  = 255
doc  = "Which tile is the floor."
indexes = "tileset"

[knobs.sprite_idle]
type = "int"
min  = 0
max  = 255
doc  = "Which sheet cell the runner idles on."
indexes = "spriteset"

[knobs.solid_flag]
type    = "int"
default = 1
min     = 1
max     = 255
doc     = "The SPRITE_FLAGS bit a tileset uses for \`solid\`."
`;

/** Reads every knob and keeps its state in RAM, so a knob that failed to arrive shows up in the chain. */
const ENGINE_JS = `var Y = 0x7800;

function boot() {
  sys.poke(Y, 60);
}

function tick() {
  var y = sys.peek(Y);
  gfx.cls(0);
  if (inp.btn(3) && y < 118) y = y + 1;
  if (inp.btn(2) && y > 1) y = y - 1;
  sys.poke(Y, y);
  gfx.rect(8, y, 8, 8, KNOB.tileFloor & 15, true);
  gfx.spr(KNOB.spriteIdle, 40, y, 1, 1);
  gfx.pset((sys.frame() + ((KNOB.gravity * 64) | 0)) & 127, (y + KNOB.coyoteFrames) & 127, 7);
  if (KNOB.edgeSolid) gfx.print("x", 2, 2, KNOB.solidFlag & 15);
}
`;

const PALETTE_TOML = `[module]
kind    = "palette"
name    = "sweet"
version = "1.0.0"

[provides]
colors  = 16
entries = [0, 17, 1, 2, 3, 4, 5, 27, 11, 12, 23, 8, 9, 10, 13, 14]
`;

const TILESET_TOML = `[module]
kind    = "tileset"
name    = "caverns"
version = "1.0.0"

[provides]
tiles = 64
base  = 0
data  = "tiles.bin"
flags = ["solid", "hazard"]
solid_flag  = 1
hazard_flag = 2
`;

const SPRITESET_TOML = `[module]
kind    = "spriteset"
name    = "runners"
version = "1.0.0"

[provides]
sprites = 16
base    = 64
data    = "sprites.bin"
`;

const RECIPE = `[cart]
title   = "Probe"
author  = "eric"
payload = "script/js1"

[modules]
engine    = "runner@1.0.0"
palette   = "sweet@1.0.0"
tileset   = "caverns@1.0.0"
spriteset = "runners@1.0.0"

[tuning]
tile_floor  = 3
sprite_idle = 64
gravity     = 0.5
`;

/** 64 tiles: every one marked `solid`, and the last one `hazard` too. */
const TILE_DATA = tilesetData(64);
const SPRITE_DATA = packData(16, 0x40, 0x00);

function tree(overrides: Record<string, string | Uint8Array> = {}) {
  return {
    "/p/modules/runner/module.toml": ENGINE_TOML,
    "/p/modules/runner/engine.js": ENGINE_JS,
    "/p/modules/sweet/module.toml": PALETTE_TOML,
    "/p/modules/caverns/module.toml": TILESET_TOML,
    "/p/modules/caverns/tiles.bin": TILE_DATA,
    "/p/modules/runners/module.toml": SPRITESET_TOML,
    "/p/modules/runners/sprites.bin": SPRITE_DATA,
    "/p/recipe.toml": RECIPE,
    ...overrides,
  };
}

function stampFixture(overrides: Record<string, string | Uint8Array> = {}, frames = 8) {
  return stamp("/p/recipe.toml", harness(tree(overrides)), {
    modulesRoot: "/p/modules",
    frames,
  });
}

/**
 * `text.replace(from, to)`, which THROWS when `from` is not in `text`.
 *
 * Every fixture in this file is a working input with one thing broken in it, so
 * a `replace` that quietly matched nothing would leave the input WORKING -- and
 * a test asserting a refusal would then be asserting nothing at all. That is
 * survivable in the tests above, which fail loudly when a build succeeds. It is
 * NOT survivable in the `it.fails` gap tests at the bottom, where a build that
 * succeeds is what the test expects: a stale search string there would look
 * exactly like a gap and would go on looking like one forever.
 */
function replaced(text: string, from: string, to: string): string {
  if (!text.includes(from)) {
    throw new Error(`fixture is stale: ${JSON.stringify(from)} is no longer in this text`);
  }
  return text.replace(from, to);
}

/**
 * Stamp something broken and hand back the FIRST error.
 *
 * Fails the test if the build succeeded, and says so in those words -- because
 * "the rejection did not happen" is the single most important result this file
 * can produce and it must never be mistaken for a passing assertion.
 */
function refusal(overrides: Record<string, string | Uint8Array>): Diagnostic {
  const result = stampFixture(overrides);
  if (result.ok) {
    throw new Error(
      "THE STAMPER ACCEPTED THIS RECIPE. It was built to be refused, so either the check " +
        `is missing or this fixture no longer breaks it. Cart id ${result.id}.`,
    );
  }
  const errors = sortDiagnostics(result.diagnostics).filter((d) => d.severity === "error");
  if (errors.length === 0) throw new Error("the build failed with no error diagnostic");
  return errors[0] as Diagnostic;
}

/** Every error code reported, sorted, for a compact assertion. */
function codes(ds: readonly Diagnostic[]): string[] {
  return sortDiagnostics(ds)
    .filter((d) => d.severity === "error")
    .map((d) => d.code);
}

// ===========================================================================

describe("the control: this fixture set builds, so every refusal below is the change", () => {
  it("stamps, proves and produces a cart", () => {
    const result = stampFixture({}, 16);
    if (!result.ok) {
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    }
    expect(result.diagnostics).toEqual([]);
    expect(result.id).toMatch(/^[0-9A-Z]{32}$/);
    expect(result.proof.frames).toBe(16);
  });
});

// ===========================================================================

describe("[requires] against [provides]: the handshake the module system is for", () => {
  it("refuses a tileset with fewer tiles than min_tiles, naming both numbers", () => {
    const d = refusal({
      "/p/modules/caverns/module.toml": TILESET_TOML.replace("tiles = 64", "tiles = 32"),
      "/p/modules/caverns/tiles.bin": tilesetData(32),
    });
    expect(d.code).toBe("unsatisfied-requires");
    expect(d.message).toBe(
      "engine `runner@1.0.0` requires tileset min_tiles = 64, and `caverns@1.0.0` declares tiles = 32.",
    );
    // The fix needs to know what the pack DOES offer, not only that it is wrong.
    expect(d.suggestion).toContain("tiles = 32");
    expect(d.file).toBe("/p/recipe.toml");
  });

  it("refuses a tileset missing a required flag, naming the flag", () => {
    const d = refusal({
      "/p/modules/caverns/module.toml": TILESET_TOML.replace(
        'flags = ["solid", "hazard"]',
        'flags = ["solid"]',
      ),
    });
    expect(d.code).toBe("unsatisfied-requires");
    expect(d.message).toContain('declares flags [solid] and is missing "hazard"');
    expect(d.message).toContain("caverns@1.0.0");
  });

  it("refuses a spriteset with fewer cells than min_sprites", () => {
    const d = refusal({
      "/p/modules/runners/module.toml": SPRITESET_TOML.replace("sprites = 16", "sprites = 8"),
      "/p/modules/runners/sprites.bin": packData(8, 0x40, 0x00),
    });
    expect(d.code).toBe("unsatisfied-requires");
    expect(d.message).toBe(
      "engine `runner@1.0.0` requires spriteset min_sprites = 12, and `runners@1.0.0` declares sprites = 8.",
    );
  });

  it("refuses a required kind the recipe supplies nothing for", () => {
    const d = refusal({ "/p/recipe.toml": RECIPE.replace('palette   = "sweet@1.0.0"\n', "") });
    expect(d.code).toBe("unsatisfied-requires");
    expect(d.message).toBe(
      "engine `runner@1.0.0` requires a palette module, and this recipe sets none.",
    );
    expect(d.suggestion).toContain('palette = "somename@1.0.0"');
  });

  it("refuses a pack whose [provides] does not declare the key at all", () => {
    const result = stampFixture({
      "/p/modules/caverns/module.toml":
        '[module]\nkind    = "tileset"\nname    = "caverns"\nversion = "1.0.0"\n',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // BOTH halves of the requirement are reported, not the first one only.
    expect(codes(result.diagnostics)).toEqual(["unsatisfied-requires", "unsatisfied-requires"]);
    const messages = result.diagnostics.map((x) => x.message).join("\n");
    expect(messages).toContain("declares no `tiles`");
    expect(messages).toContain("declares no flags");
  });

  it("refuses a pack that declares the key as the wrong sort of thing", () => {
    const d = refusal({
      "/p/modules/caverns/module.toml": TILESET_TOML.replace("tiles = 64", 'tiles = "sixty-four"'),
    });
    expect(d.code).toBe("unsatisfied-requires");
    expect(d.message).toContain("declares tiles as a string");
  });

  it("refuses an equality constraint the provider does not meet", () => {
    // `<k> = v` is the fourth form in the manifest's one rule, and the one no
    // real pack uses yet -- so it is the one most likely to have been written
    // and never run.
    const d = refusal({
      "/p/modules/runner/module.toml": ENGINE_TOML.replace(
        'tileset   = { min_tiles = 64, flags = ["solid", "hazard"] }',
        'tileset   = { min_tiles = 64, flags = ["solid", "hazard"], tile_w = 16 }',
      ),
      "/p/modules/caverns/module.toml": TILESET_TOML.replace("tiles = 64", "tiles = 64\ntile_w = 8"),
    });
    expect(d.code).toBe("unsatisfied-requires");
    expect(d.message).toBe(
      "engine `runner@1.0.0` requires tileset tile_w = 16, and `caverns@1.0.0` declares tile_w = 8.",
    );
  });
});

// ===========================================================================

describe("the modules a recipe names", () => {
  it("refuses a module that is not there, and says what is", () => {
    const d = refusal({ "/p/recipe.toml": RECIPE.replace("caverns@1.0.0", "cavernz@1.0.0") });
    expect(d.code).toBe("missing-module");
    expect(d.message).toBe(
      "there is no module `cavernz@1.0.0`: /p/modules/cavernz/module.toml is not there.",
    );
    expect(d.suggestion).toContain("caverns, runner, runners, sweet");
  });

  it("refuses a version the module on disk does not declare", () => {
    const d = refusal({ "/p/recipe.toml": RECIPE.replace("caverns@1.0.0", "caverns@2.0.0") });
    expect(d.code).toBe("module-version-mismatch");
    expect(d.message).toBe(
      "/p/modules/caverns/module.toml declares `caverns@1.0.0`, but this recipe asks for `caverns@2.0.0`.",
    );
    expect(d.suggestion).toBe('Write  tileset = "caverns@1.0.0"');
  });

  it("refuses a spriteset used in the tileset slot, naming both kinds", () => {
    const d = refusal({
      "/p/recipe.toml": RECIPE.replace('tileset   = "caverns@1.0.0"', 'tileset   = "runners@1.0.0"'),
    });
    expect(d.code).toBe("module-kind-mismatch");
    expect(d.message).toBe(
      "`runners@1.0.0` is a spriteset module, and this recipe uses it as a tileset.",
    );
    expect(d.suggestion).toContain('spriteset = "runners@1.0.0"');
  });

  it("refuses a tileset used as the engine", () => {
    const d = refusal({
      "/p/recipe.toml": RECIPE.replace('engine    = "runner@1.0.0"', 'engine    = "caverns@1.0.0"'),
    });
    expect(d.code).toBe("module-kind-mismatch");
    expect(d.message).toContain("is a tileset module, and this recipe uses it as a engine");
  });

  it("refuses a slot filled twice: the repeated key never reaches the stamper", () => {
    // TOML settles this before the recipe parser sees it, which is the right
    // place: "later keys do not override earlier ones inside a table" is a
    // property of the file format, not of recipes. `resolve` carries a
    // `bad-recipe` for the same situation and it is UNREACHABLE from a parsed
    // recipe -- see the gap list at the bottom of this file.
    const d = refusal({
      "/p/recipe.toml": RECIPE.replace(
        'tileset   = "caverns@1.0.0"',
        'tileset   = "caverns@1.0.0"\ntileset   = "caverns@1.0.0"',
      ),
    });
    expect(d.code).toBe("malformed-toml");
    expect(d.message).toContain('key "tileset" is set twice');
    expect(d.line).toBe(10);
  });

  it("warns, and does not refuse, when two art packs claim the same sheet cells", () => {
    // A WARNING BY DESIGN. Layers merge in declared order and later keys win
    // (specification 8.2), so overlapping packs are how an author overrides one
    // pack's cells with another's -- but doing it by accident is worth saying
    // out loud, which is what this is.
    const result = stampFixture({
      "/p/modules/runners/module.toml": SPRITESET_TOML.replace("base    = 64", "base    = 0"),
      // `sprite_idle` indexes the spriteset, and moving the pack to base 0 moves
      // its cells to 0..15 -- so the recipe's 64 would now be an index into
      // nothing and this test would be measuring THAT refusal instead of the
      // overlap it is about. Move the knob with the pack.
      "/p/recipe.toml": replaced(RECIPE, "sprite_idle = 64", "sprite_idle = 0"),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const warning = result.diagnostics.find((d) => d.message.includes("draws over sheet cell 0"));
    expect(warning).toBeDefined();
    expect(warning?.severity).toBe("warning");
    // It names BOTH packs, because either one of them could be the mistake.
    expect(warning?.message).toContain("runners@1.0.0");
    expect(warning?.message).toContain("caverns@1.0.0");
    // And it says what the author LOSES, because "warning" without a stated
    // consequence reads as cosmetic: the overwritten cell is gone from the cart.
    expect(warning?.message).toContain("is not in this cart at all -- nothing can draw it");
  });

  it("warns when a [files] chunk and the merged art packs both claim GFX", () => {
    const result = stampFixture({
      "/p/modules/caverns/module.toml": `${TILESET_TOML}\n[files]\ngfx = "tiles.bin"\n`,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const warning = result.diagnostics.find((d) => d.message.includes("a cart has one GFX chunk"));
    expect(warning?.severity).toBe("warning");
    expect(warning?.message).toContain("caverns@1.0.0");
  });

  it("refuses an engine module with no engine.js, so there is nothing to compile", () => {
    const files = tree();
    delete (files as Record<string, unknown>)["/p/modules/runner/engine.js"];
    const result = stamp("/p/recipe.toml", harness(files), {
      modulesRoot: "/p/modules",
      frames: 4,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const d = result.diagnostics[0] as Diagnostic;
    expect(d.code).toBe("missing-module-file");
    expect(d.message).toContain("engine `runner@1.0.0` has no engine.js");
  });

  it("refuses a pack whose data file is not the length its cell count implies", () => {
    // GAP 10, CLOSED. This used to report `missing-module-file` -- about a file
    // that is present, readable and exactly where the manifest said it would
    // be. The count is what is wrong, so the code says so and the message names
    // both numbers and which module claimed the count.
    const d = refusal({ "/p/modules/caverns/tiles.bin": tilesetData(32) });
    expect(d.code).toBe("data-size-mismatch");
    expect(d.message).toBe(
      "tiles.bin is 1056 bytes, and 64 cells is 2112: 2048 of pixels then 64 of flags.",
    );
    expect(d.suggestion).toContain("`caverns@1.0.0` declares 64 cells");
    expect(d.file).toBe("/p/modules/caverns/module.toml");
  });
});

// ===========================================================================

describe("knobs: the numbers that bind an engine to a pack", () => {
  it("refuses a knob no module in the recipe declares, and offers the name that was meant", () => {
    const d = refusal({ "/p/recipe.toml": `${RECIPE}gravitee = 0.5\n` });
    expect(d.code).toBe("unknown-knob");
    expect(d.message).toBe("no module in this recipe declares a knob `gravitee`.");
    expect(d.suggestion).toContain("Did you mean `gravity`?");
    expect(d.suggestion).toContain("coyote_frames, edge_solid, gravity, solid_flag");
  });

  it("refuses a string where a `fixed` belongs", () => {
    const d = refusal({ "/p/recipe.toml": RECIPE.replace("gravity     = 0.5", 'gravity     = "0.5"') });
    expect(d.code).toBe("knob-type");
    expect(d.message).toBe('knob `gravity` is `fixed`, and "0.5" is a string.');
    expect(d.suggestion).toContain("a number");
  });

  it("refuses a float where an `int` belongs, because 6.0 frames is not a frame count", () => {
    const d = refusal({ "/p/recipe.toml": `${RECIPE}coyote_frames = 6.0\n` });
    expect(d.code).toBe("knob-type");
    expect(d.message).toBe("knob `coyote_frames` is `int`, and 6.0 is a float.");
    expect(d.suggestion).toContain("a whole number, with no decimal point");
  });

  it("refuses a number where a `bool` belongs", () => {
    const d = refusal({ "/p/recipe.toml": `${RECIPE}edge_solid = 1\n` });
    expect(d.code).toBe("knob-type");
    expect(d.message).toBe("knob `edge_solid` is `bool`, and 1 is an integer.");
    expect(d.suggestion).toContain("edge_solid = true");
  });

  it("refuses a knob above its maximum, and quotes the range and the doc", () => {
    const d = refusal({ "/p/recipe.toml": RECIPE.replace("gravity     = 0.5", "gravity     = 9.5") });
    expect(d.code).toBe("knob-out-of-range");
    expect(d.message).toBe("knob `gravity` is 9.5, above its maximum of 4.0.");
    expect(d.suggestion).toContain("The range is 0.0 .. 4.0.");
    expect(d.suggestion).toContain("Downward acceleration per frame");
  });

  it("refuses a knob below its minimum", () => {
    const d = refusal({ "/p/recipe.toml": RECIPE.replace("tile_floor  = 3", "tile_floor  = 0") });
    expect(d.code).toBe("knob-out-of-range");
    expect(d.message).toBe("knob `tile_floor` is 0, below its minimum of 1.");
    expect(d.suggestion).toContain("The range is 1 .. 255.");
  });

  it("still refuses a required knob left unset, with a line to paste", () => {
    // Covered elsewhere, asserted here because it is the one check in this list
    // the format was designed around: there is no sensible default for "which
    // tile is the floor", so a knob with no `default` must be set or refused.
    const d = refusal({ "/p/recipe.toml": RECIPE.replace("tile_floor  = 3\n", "") });
    expect(d.code).toBe("unbound-knob");
    expect(d.message).toContain("requires knob `tile_floor`");
    expect(d.message).toContain("which the [tuning] table does not set");
    expect(d.suggestion).toContain("Add:  tile_floor = 128");
    expect(d.suggestion).toContain("Which tile is the floor");
  });

  it("refuses a manifest declaring a knob name that cannot become a JS property", () => {
    const d = refusal({
      "/p/modules/runner/module.toml": ENGINE_TOML.replace("[knobs.gravity]", "[knobs.Gravity]"),
    });
    expect(d.code).toBe("bad-knob-name");
    expect(d.message).toBe("`Gravity` is not a usable knob name.");
    expect(d.suggestion).toContain("jump_velocity");
  });

  it("refuses a manifest whose default disagrees with its own declared type", () => {
    const d = refusal({
      "/p/modules/runner/module.toml": ENGINE_TOML.replace("default = 6", 'default = "six"'),
    });
    expect(d.code).toBe("bad-manifest");
    expect(d.message).toBe(
      "knob `coyote_frames` is declared `int` but its default is a string.",
    );
  });

  it("refuses a manifest whose knob range cannot be satisfied by any value", () => {
    const d = refusal({
      "/p/modules/runner/module.toml": ENGINE_TOML.replace("min     = 0.0\nmax     = 4.0", "min     = 4.0\nmax     = 0.0"),
    });
    expect(d.code).toBe("bad-manifest");
    expect(d.message).toBe("knob `gravity` has min 4 above max 0, so no value can satisfy it.");
  });
});

// ===========================================================================

describe("[cart]: the fields the container needs", () => {
  it("refuses a [cart] with no title", () => {
    const d = refusal({ "/p/recipe.toml": RECIPE.replace('title   = "Probe"\n', "") });
    expect(d.code).toBe("bad-recipe");
    expect(d.message).toBe("[cart] has no `title`.");
    expect(d.suggestion).toContain('title = "Cave Runner"');
  });

  it("refuses a [cart] with no author", () => {
    const d = refusal({ "/p/recipe.toml": RECIPE.replace('author  = "eric"\n', "") });
    expect(d.code).toBe("bad-recipe");
    expect(d.message).toBe("[cart] has no `author`.");
  });

  it("refuses a [cart] field the container has nowhere to put", () => {
    const d = refusal({
      "/p/recipe.toml": RECIPE.replace('author  = "eric"', 'author  = "eric"\nlicence = "mit"'),
    });
    expect(d.code).toBe("bad-recipe");
    expect(d.message).toBe("[cart] has no `licence`.");
    expect(d.suggestion).toContain("title, author, profile, payload and spec");
  });

  it("refuses a title the META chunk cannot hold, and says how long it may be", () => {
    const d = refusal({
      "/p/recipe.toml": RECIPE.replace('title   = "Probe"', `title   = "${"x".repeat(400)}"`),
    });
    expect(d.code).toBe("bad-recipe");
    expect(d.message).toContain("title is 400 UTF-8 bytes; the limit is 64");
  });

  it("refuses a recipe with no engine at all", () => {
    const d = refusal({ "/p/recipe.toml": RECIPE.replace('engine    = "runner@1.0.0"\n', "") });
    expect(d.code).toBe("missing-engine");
    expect(d.message).toContain("names no engine");
  });

  it("refuses a profile this specification version does not define", () => {
    const d = refusal({
      "/p/recipe.toml": RECIPE.replace('author  = "eric"', 'author  = "eric"\nprofile = "xp"'),
    });
    expect(d.code).toBe("unsupported-profile");
    expect(d.message).toContain('profile "xp"');
  });

  it("refuses a section a recipe does not have", () => {
    const d = refusal({ "/p/recipe.toml": `${RECIPE}\n[extras]\nx = 1\n` });
    expect(d.code).toBe("bad-recipe");
    expect(d.message).toBe("a recipe has no [extras] section.");
    expect(d.suggestion).toContain("[cart], [engine], [modules], [tuning]");
  });
});

// ===========================================================================

describe("budgets, which are checked where their numbers exist", () => {
  it("refuses a cart over the byte budget, and names the biggest input", () => {
    const d = refusal({
      "/p/modules/caverns/module.toml": `${TILESET_TOML}\n[files]\nlabl = "big.bin"\n`,
      "/p/modules/caverns/big.bin": new Uint8Array(MAX_CART_BYTES).fill(7),
    });
    expect(d.code).toBe("cart-budget");
    expect(d.message).toContain(`over the ${MAX_CART_BYTES}-byte cart budget`);
    expect(d.suggestion).toContain("The largest input is labl from `caverns@1.0.0`");
  });

  it("refuses code over the token budget, against the engine's own file", () => {
    const fat = `${ENGINE_JS + Array.from({ length: 4000 }, (_, i) => `var v${i};`).join("\n")}\n`;
    const d = refusal({ "/p/modules/runner/engine.js": fat });
    expect(d.code).toBe("token-budget");
    expect(d.message).toContain("over the 8192-token budget");
    expect(d.file).toBe("/p/modules/runner/engine.js");
  });

  it("refuses a chunk larger than the RAM region it installs into", () => {
    const d = refusal({
      "/p/modules/caverns/module.toml": `${TILESET_TOML}\n[files]\nmap = "world.bin"\n`,
      "/p/modules/caverns/world.bin": new Uint8Array(9000).fill(3),
    });
    expect(d.code).toBe("chunk-too-large");
    expect(d.message).toBe("the map data is 9000 bytes, and the MAP region at 0x4300 holds 8192.");
    expect(d.suggestion).toContain("`caverns@1.0.0` supplies it");
  });
});

// ===========================================================================

describe("malformed input, at a line and a column", () => {
  it("points at the character where a recipe stopped being TOML", () => {
    const d = refusal({ "/p/recipe.toml": "[cart\ntitle = 1\n" });
    expect(d.code).toBe("malformed-toml");
    expect(d.file).toBe("/p/recipe.toml");
    expect(d.line).toBe(1);
    expect(d.column).toBe(6);
    expect(d.message).toContain('"\\n" where "]" was expected');
    expect(d.suggestion).toContain("A table header is [name] or [outer.inner].");
  });

  it("points into the manifest, not the recipe, when a manifest is the broken file", () => {
    const d = refusal({
      "/p/modules/caverns/module.toml": TILESET_TOML.replace('name    = "caverns"', "name = caverns"),
    });
    expect(d.code).toBe("malformed-toml");
    expect(d.file).toBe("/p/modules/caverns/module.toml");
    expect(d.line).toBe(3);
    expect(d.column).toBe(8);
    expect(d.message).toContain('"caverns" is not a value');
  });

  it("refuses a path where a module reference belongs", () => {
    const d = refusal({ "/p/recipe.toml": RECIPE.replace('"caverns@1.0.0"', '"./art/caverns.toml"') });
    expect(d.code).toBe("bad-module-ref");
    expect(d.message).toBe('"./art/caverns.toml" is not a module reference.');
    expect(d.suggestion).toContain("never as a path");
  });
});

// ===========================================================================
//
// WHAT THE CONTRACT DID NOT CHECK
//
// Each test below was written as the assertion that would pass the day the
// check existed, and marked `it.fails` so the suite turned RED the moment one
// landed. Six have landed and are plain `it` now, each asserting the code and
// the wording of the diagnostic rather than only `ok === false` -- because a
// refusal with a vague message is the failure this file exists to catch.
//
// The shape of every gap here was the same, and it is worth naming: the stamper
// type-checked MANIFEST TEXT AGAINST MANIFEST TEXT. It never read an art pack's
// bytes to see whether they agreed with what the manifest said about them, and
// never checked an index knob against the size of the pack it indexes into.
// Both produce a cart that builds, proves a 600-frame chain, and is wrong.
//
// TWO ARE STILL `it.fails`, AND BOTH ARE DELIBERATE. GAP 7 is the layering rule
// working -- later packs win, and refusing an overlap would remove the
// mechanism -- with the warning now saying what the author loses. GAP 8 needs a
// grammar for constraints on an OPTIONAL requirement, which is a change to
// `[requires]` rather than a missing call. Neither is closed by pretending; do
// not delete either one to make a suite green.
//
// ===========================================================================

/*
 * The gap fixtures, built HERE rather than inside the tests.
 *
 * `replaced` throws when its search string has gone stale, and a throw at
 * module scope fails the whole file loudly. A throw INSIDE an `it.fails` body
 * would be swallowed as the expected failure, which is exactly how a gap test
 * rots into a test of nothing.
 */
const FLAGS_ALL_ZERO = packData(64, 0x10, 0x00);
const TILESET_SOLID_BIT_4 = replaced(TILESET_TOML, "solid_flag  = 1", "solid_flag  = 4");
const RECIPE_TILE_200 = replaced(RECIPE, "tile_floor  = 3", "tile_floor  = 200");
const RECIPE_SPRITE_200 = replaced(RECIPE, "sprite_idle = 64", "sprite_idle = 200");
const ENGINE_FRACTIONAL_INT_RANGE = replaced(
  ENGINE_TOML,
  'type = "int"\nmin  = 1\nmax  = 255\ndoc  = "Which tile is the floor."',
  'type = "int"\nmin  = 1.5\nmax  = 255.5\ndoc  = "Which tile is the floor."',
);
const TILESET_HIJACKING_GRAVITY = `${TILESET_TOML}\n[knobs.gravity]\ntype = "int"\ndefault = 3\n`;
const RECIPE_WITHOUT_GRAVITY = replaced(RECIPE, "gravity     = 0.5\n", "");
const SPRITESET_AT_BASE_0 = replaced(SPRITESET_TOML, "base    = 64", "base    = 0");
const RECIPE_SPRITE_0 = replaced(RECIPE, "sprite_idle = 64", "sprite_idle = 0");
const TILESET_NARROWING_GRAVITY = `${TILESET_TOML}\n[knobs.gravity]\ntype = "fixed"\nmax  = 1.0\ndefault = 0.9\n`;
const TILESET_WIDENING_GRAVITY = `${TILESET_TOML}\n[knobs.gravity]\ntype = "fixed"\nmax  = 40.0\n`;
const RECIPE_WITH_SOUNDBANK = replaced(
  RECIPE,
  'spriteset = "runners@1.0.0"',
  'spriteset = "runners@1.0.0"\nsoundbank = "quiet@1.0.0"',
);

describe("WHAT THE CONTRACT DID NOT CHECK -- six closed, two open by design", () => {
  it("GAP 1, CLOSED: a tileset's declared flags are checked against the bytes it ships", () => {
    // The manifest says `flags = ["solid", "hazard"]` and the engine's
    // `requires` was satisfied by that sentence alone. Ship a tiles.bin whose
    // every flag byte is zero and the recipe used to stamp -- and the game ran
    // with nothing solid and nothing fatal, which is exactly the
    // plausible-looking broken cart the type-check is advertised against.
    const result = stampFixture({ "/p/modules/caverns/tiles.bin": FLAGS_ALL_ZERO });
    expect(result.ok).toBe(false);
    if (result.ok) return;

    // BOTH claims are reported, not the first one: the pack says it marks two
    // things and marks neither.
    expect(codes(result.diagnostics)).toEqual(["flag-not-in-data", "flag-not-in-data"]);
    const d = sortDiagnostics(result.diagnostics)[0] as Diagnostic;
    expect(d.message).toBe(
      "`caverns@1.0.0` declares flag `hazard` on bit 2, and no cell of tiles.bin carries it: " +
        "all 64 flag bytes leave bit 2 clear.",
    );
    // It points at the MANIFEST -- the file holding the claim that is false --
    // and the fix names both ways out.
    expect(d.file).toBe("/p/modules/caverns/module.toml");
    expect(d.suggestion).toContain("Regenerate tiles.bin with at least one cell marked");
    expect(d.suggestion).toContain('drop "hazard" from [provides] flags');
  });

  it("GAP 2, CLOSED: a pack's solid_flag bit is checked against the engine's knob", () => {
    // `caverns` says solid is bit 4; the recipe leaves the engine's
    // `solid_flag` knob at its default of 1. Two numbers that must agree, in
    // two files, and nothing compared them. The cart built, proved a chain, and
    // the player walked through every wall.
    const result = stampFixture({ "/p/modules/caverns/module.toml": TILESET_SOLID_BIT_4 });
    expect(result.ok).toBe(false);
    if (result.ok) return;

    const d = result.diagnostics.find((x) => x.code === "flag-bit-mismatch") as Diagnostic;
    expect(d).toBeDefined();
    expect(d.message).toBe(
      "`caverns@1.0.0` marks `solid` on bit 4, and knob `solid_flag` is 1: the engine would " +
        "read bit 1 out of SPRITE_FLAGS and this tileset writes bit 4.",
    );
    // The fix is a line to paste, and it says where the losing number came from.
    expect(d.suggestion).toContain("Set  solid_flag = 4  in [tuning]");
    expect(d.suggestion).toContain("The value in force is 1, from runner@1.0.0 default.");
    expect(d.file).toBe("/p/recipe.toml");
  });

  it("GAP 3, CLOSED: a tile index knob is checked against the tileset's tile count", () => {
    // `caverns` has 64 tiles, indices 0..63. The recipe binds the floor to tile
    // 200, which is inside the knob's own 1..255 range and outside the pack
    // entirely. Nothing consulted `[provides] tiles` when binding an index --
    // the same shape as the flags gap above: manifest text checked against
    // manifest text, and never against a size the pack actually has.
    const d = refusal({ "/p/recipe.toml": RECIPE_TILE_200 });
    expect(d.code).toBe("index-out-of-pack");
    expect(d.message).toBe(
      "knob `tile_floor` is 200, and tileset `caverns@1.0.0` fills sheet cells 0 .. 63.",
    );
    expect(d.suggestion).toContain("places 64 cells at [provides] base 0");
    expect(d.suggestion).toContain("Choose a number from 0 to 63");
    // The knob's own doc, because an author choosing a replacement needs to
    // know what the number is FOR.
    expect(d.suggestion).toContain("Which tile is the floor.");
    // And it points at the line in the recipe that holds the wrong number.
    expect(d.file).toBe("/p/recipe.toml");
    expect(d.line).toBe(13);
  });

  it("GAP 4, CLOSED: a sprite index knob is checked against the spriteset's cells", () => {
    // `runners` occupies sheet cells 64..79. Cell 200 belongs to nobody.
    const d = refusal({ "/p/recipe.toml": RECIPE_SPRITE_200 });
    expect(d.code).toBe("index-out-of-pack");
    expect(d.message).toBe(
      "knob `sprite_idle` is 200, and spriteset `runners@1.0.0` fills sheet cells 64 .. 79.",
    );
    // `base` is part of the answer for a spriteset, and the message and the fix
    // both carry it: 0..15 would be the wrong advice for a pack starting at 64.
    expect(d.suggestion).toContain("places 16 cells at [provides] base 64");
    expect(d.suggestion).toContain("Choose a number from 64 to 79");
  });

  it("GAP 5, CLOSED: an `int` knob may not declare a fractional min or max", () => {
    // `min = 1.5` on an `int` knob was accepted by `parseManifest`, so the range
    // an author is shown -- and the midpoint the unbound-knob suggestion offers
    // them to paste -- could be a value the knob's own type then refuses.
    const result = stampFixture({ "/p/modules/runner/module.toml": ENGINE_FRACTIONAL_INT_RANGE });
    expect(result.ok).toBe(false);
    if (result.ok) return;

    // Both bounds are reported at once: an author fixing a manifest wants every
    // complaint in one run.
    expect(codes(result.diagnostics)).toEqual(["bad-manifest", "bad-manifest"]);
    const d = sortDiagnostics(result.diagnostics)[0] as Diagnostic;
    expect(d.message).toBe(
      "knob `tile_floor` is declared `int`, and its min is 1.5, which is not a whole number.",
    );
    expect(d.suggestion).toContain("Write  min = 2");
    expect(d.file).toBe("/p/modules/runner/module.toml");
    const max = sortDiagnostics(result.diagnostics)[1] as Diagnostic;
    expect(max.message).toContain("its max is 255.5");
    expect(max.suggestion).toContain("Write  max = 255");
  });

  it("GAP 6, CLOSED: a later module may not redeclare an engine's knob with another type", () => {
    // THE WORST OF THESE. `merge` did `knobs.set(name, ...)` per layer, so a
    // TILESET declaring `[knobs.gravity]` as an `int` REPLACED the engine's
    // `fixed` declaration -- silently, with no diagnostic at any severity. The
    // cart built and the preamble read `gravity: 3`, a bare integer, where the
    // engine's arithmetic expects the 16.16 fraction `27525 / 65536`.
    const d = refusal({
      "/p/modules/caverns/module.toml": TILESET_HIJACKING_GRAVITY,
      "/p/recipe.toml": RECIPE_WITHOUT_GRAVITY,
    });
    expect(d.code).toBe("knob-redeclared");
    expect(d.message).toBe(
      "`caverns@1.0.0` redeclares knob `gravity` as `int`, and engine `runner@1.0.0` declares " +
        "it `fixed`.",
    );
    // The message names both modules and both types; the fix says which of the
    // two an art pack was probably reaching for.
    expect(d.suggestion).toContain("wrong by 65536");
    expect(d.suggestion).toContain("set the value in [tuning]");
    expect(d.file).toBe("/p/modules/caverns/module.toml");
  });

  it("GAP 6, the other half: the hijacked knob no longer reaches the engine", () => {
    // This test used to assert the DAMAGE -- `ok: true`, no diagnostics, and a
    // preamble reading `gravity: 3` where the engine expects a 16.16 fraction.
    // It is kept, inverted, because the fact it recorded is the reason the check
    // exists: nothing is built, so nothing wrong is shipped.
    const result = stampFixture({
      "/p/modules/caverns/module.toml": TILESET_HIJACKING_GRAVITY,
      "/p/recipe.toml": RECIPE_WITHOUT_GRAVITY,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(codes(result.diagnostics)).toEqual(["knob-redeclared"]);
  });

  it("GAP 6, the rule: a later layer may narrow a knob it did not declare", () => {
    // The decision, asserted rather than described. A restatement of the SAME
    // type is editorial -- "in this game gravity never exceeds 1.0, and starts
    // at 0.9" -- so it is allowed and it takes effect, and the knob's owner for
    // diagnostics stays the engine that has to run the number.
    const result = stampFixture({
      "/p/modules/caverns/module.toml": TILESET_NARROWING_GRAVITY,
      "/p/recipe.toml": RECIPE_WITHOUT_GRAVITY,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.diagnostics).toEqual([]);
    // The later default is in force, still emitted as a 16.16 fraction: the
    // type is the engine's, the value is the pack's.
    expect(result.source.split("\n")[1]).toContain(`gravity: ${(0.9 * 65536) | 0} / 65536`);

    // And the narrowed maximum is really in force: 2.0 was legal under the
    // engine's own 0.0 .. 4.0 and is not legal now.
    const d = refusal({
      "/p/modules/caverns/module.toml": TILESET_NARROWING_GRAVITY,
      "/p/recipe.toml": replaced(RECIPE, "gravity     = 0.5", "gravity     = 2.0"),
    });
    expect(d.code).toBe("knob-out-of-range");
    expect(d.message).toBe("knob `gravity` is 2.0, above its maximum of 1.0.");

    // And the layer that supplied the default in force owns the position, so a
    // pack whose own default no longer fits the range it just narrowed is
    // reported against ITS line -- not against the engine's, which would be
    // correct and useless.
    const own = refusal({
      "/p/modules/caverns/module.toml": replaced(
        TILESET_NARROWING_GRAVITY,
        "default = 0.9",
        "default = 3.0",
      ),
      "/p/recipe.toml": RECIPE_WITHOUT_GRAVITY,
    });
    expect(own.code).toBe("knob-out-of-range");
    expect(own.message).toBe("knob `gravity` is 3.0, above its maximum of 1.0.");
    expect(own.file).toBe("/p/modules/caverns/module.toml");
  });

  it("GAP 6, the rule: a later layer may NOT widen one, and is told the bound was kept", () => {
    // Widening would let a recipe set a value the declaring engine said its own
    // arithmetic could not survive -- the same silent override one field along.
    // The narrower bound wins, and the warning names both numbers rather than
    // leaving an author to wonder why their 20.0 was refused.
    const result = stampFixture({
      "/p/modules/caverns/module.toml": TILESET_WIDENING_GRAVITY,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const warning = result.diagnostics.find((x) => x.code === "knob-redeclared") as Diagnostic;
    expect(warning.severity).toBe("warning");
    expect(warning.message).toBe(
      "`caverns@1.0.0` widens knob `gravity`'s max to 40.0, and engine `runner@1.0.0` declares " +
        "max 4.0. The narrower bound is kept.",
    );

    // Kept, not merely complained about.
    const d = refusal({
      "/p/modules/caverns/module.toml": TILESET_WIDENING_GRAVITY,
      "/p/recipe.toml": replaced(RECIPE, "gravity     = 0.5", "gravity     = 20.0"),
    });
    expect(d.code).toBe("knob-out-of-range");
    expect(d.message).toBe("knob `gravity` is 20.0, above its maximum of 4.0.");
  });

  it.fails("GAP 7: two art packs claiming the same sheet cells is a warning, not a refusal", () => {
    // STILL OPEN, AND DELIBERATELY. Layers merge in declared order and later
    // keys win, so overriding one pack's cells with another's is a supported
    // edit and refusing it would remove the mechanism. It stays listed because
    // "a recipe is type-checked" is read as "a wrong recipe is refused", and
    // this one is not: the cart builds with one pack's art gone. What DID change
    // is the warning, which now says the overwritten art is not in the cart at
    // all -- see the overlap test above, which asserts that sentence.
    const result = stampFixture({
      "/p/modules/runners/module.toml": SPRITESET_AT_BASE_0,
      "/p/recipe.toml": RECIPE_SPRITE_0,
    });
    expect(result.ok).toBe(false);
  });

  it.fails("GAP 8: nothing checks what an optional module actually offers", () => {
    // STILL OPEN, AND DELIBERATELY -- but for a different reason than GAP 7.
    // `soundbank = false` means "may be used, is not needed", so a recipe may
    // supply ANY soundbank -- including one declaring no effects at all, while
    // the engine's sfx_* knobs name ids 0, 1 and 2. Same shape as GAP 3, one
    // kind over: the requirement is satisfied by the module's KIND and nothing
    // is asked of its contents.
    //
    // Closing it needs a way to write constraints that apply ONLY IF the kind is
    // present -- `soundbank = { optional = true, min_effects = 3 }` or similar --
    // which is a change to the `[requires]` grammar rather than a missing call,
    // and it is a bigger change than the six above put together. Left open, with
    // the shape of the fix written down. A silent effect is a silent effect; it
    // is not a cart that plays wrong.
    const result = stampFixture({
      "/p/recipe.toml": RECIPE_WITH_SOUNDBANK,
      "/p/modules/quiet/module.toml":
        '[module]\nkind    = "soundbank"\nname    = "quiet"\nversion = "1.0.0"\n\n[provides]\neffects = 0\n',
    });
    expect(result.ok).toBe(false);
  });
});

// ===========================================================================

/*
 * GAP 9, CLOSED BY DELETION, and this note is the record of the decision.
 *
 * `resolve` used to report `bad-recipe` -- "[modules] sets tileset twice: `a`
 * and `b`" -- when two entries of `recipe.modules` shared a kind. NOTHING COULD
 * PUT THEM THERE. `[modules]` is a TOML table whose keys ARE the kinds,
 * `parseToml` refuses a repeated key as `malformed-toml` at a line and a column,
 * and `parseRecipe` builds that list one entry per surviving key. The branch was
 * unreachable through every door an author can open, and a test asserting its
 * absence was a test of nothing.
 *
 * It is DELETED rather than made reachable, because there is no input that
 * should reach it: the rule "one module per kind" is a property of the file
 * format and is enforced where the format is parsed. Two enforcement points for
 * one rule, one of which never runs, is worse than one that always does. A
 * caller hand-building a `Recipe` in memory is a caller error, and this package
 * answers those the way `merge` does -- by throwing -- not by inventing an
 * author-facing diagnostic about a file nobody wrote.
 *
 * Nothing is lost by deleting the test with it: the assertion it made, that a
 * repeated key is `malformed-toml` at the right line, is made in full by
 * "refuses a slot filled twice: the repeated key never reaches the stamper"
 * above, which also pins the line number.
 */
