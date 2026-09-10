import { describe, it, expect } from "vitest";

import { decode, getChunk, decodeMeta, MAX_CART_BYTES } from "@sq1/cart";

import { formatDiagnostic, formatDiagnostics, sortDiagnostics } from "../src/diagnostics";
import type { Diagnostic } from "../src/diagnostics";
import { camelCase, parseManifest, parseRef } from "../src/manifest";
import { parseRecipe } from "../src/recipe";
import { stamp, stampSource } from "../src/index";
import {
  bind,
  buildRecipeChunk,
  compile,
  GENERATED_BANNER,
  GFX_SHEET_OFFSET,
  merge,
  moduleHash,
  pack,
  parseRecipeChunk,
  prove,
  resolve,
  validate,
} from "../src/stages";
import type { StamperIO } from "../src/stages";

/*
 * EVERY TEST HERE RUNS AGAINST FIXTURE MODULES HELD IN A Map.
 *
 * No temporary directory, nothing left behind, and -- the part that matters --
 * no dependence on `modules/platformer` existing. The real engine is being
 * authored in parallel with this package; a suite that waited for it would be a
 * suite that could not say whether the stamper worked.
 *
 * The reproducibility tests get their teeth from the same place: two builds
 * from "/one" and "/two/deeper" are two different working directories as far as
 * every path in this package is concerned, and the cart bytes have to come out
 * identical.
 */

const enc = new TextEncoder();
const dec = new TextDecoder();

interface Harness {
  readonly io: StamperIO;
  readonly files: Map<string, Uint8Array>;
}

function harness(seed: Record<string, string | Uint8Array>): Harness {
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

// --- the fixture module set ------------------------------------------------

const ENGINE_TOML = `[module]
kind    = "engine"
name    = "platformer"
version = "1.0.0"

[provides]
entities = 64

[requires]
palette = true
tileset = { min_tiles = 64, flags = ["solid", "hazard"] }

[knobs.gravity]
type    = "fixed"
default = 0.42
min     = 0.0
max     = 4.0
doc     = "Downward acceleration per frame, in pixels."

[knobs.jump_velocity]
type = "fixed"
min  = -8.0
max  = 0.0
doc  = "upward speed of a jump."

[knobs.coyote_frames]
type    = "int"
default = 6
min     = 0
max     = 30

[knobs.show_hud]
type    = "bool"
default = true
`;

/**
 * The fixture engine. Deliberately touches gfx, inp and sys, reads every knob,
 * and keeps all of its state in RAM -- so a knob that failed to reach it, or a
 * machine that failed to restore, changes the proof chain rather than nothing.
 */
const ENGINE_JS = `var Y = 0x7800;

function boot() {
  sys.poke(Y, 60);
}

function tick() {
  var f = sys.frame();
  gfx.cls(0);
  var y = sys.peek(Y);
  if (inp.btn(3) && y < 118) y = y + 1;
  if (inp.btn(2) && y > 1) y = y - 1;
  sys.poke(Y, y);
  gfx.rect(8, y, 8, 8, 9, true);
  gfx.rect(0, 120, 128, 8, 3, true);
  gfx.pset((f + ((KNOB.gravity * 64) | 0)) & 127, (y + KNOB.coyoteFrames) & 127, 7);
  gfx.pset(64, ((KNOB.jumpVelocity * -8) | 0) & 127, 5);
  if (KNOB.showHud) gfx.print("hp", 2, 2, 7);
}
`;

const PALETTE_TOML = `[module]
kind    = "palette"
name    = "sweetie16"
version = "1.0.0"

[provides]
colors = 16
`;

const TILESET_TOML = `[module]
kind    = "tileset"
name    = "caves"
version = "1.0.0"

[provides]
tiles = 128
flags = ["solid", "hazard", "ladder"]
`;

/*
 * The same tileset, shipping data through `[files]`.
 *
 * Kept apart from the fixture every other test uses, because a cart carrying
 * chunks is a cart `prove` has an opinion about: its data has to be installed
 * into RAM before the run, or the frame-hash chain is a hash of a blank sprite
 * sheet. Tests that are about resolving, binding and packing should not be
 * gated on that, so they use a tileset that ships no bytes.
 */
const TILESET_WITH_FILES = `${TILESET_TOML}
[files]
gfx = "tiles.bin"
map = "world.bin"
`;

const RECIPE = `[cart]
title   = "Cave Runner"
author  = "eric"
profile = "up"
spec    = 1

[engine]
use = "platformer@1.0.0"

[modules]
palette = "sweetie16@1.0.0"
tileset = "caves@1.0.0"

[tuning]
gravity       = 0.42
jump_velocity = -3.1
`;

const TILES = new Uint8Array(64).map((_, i) => (i * 7) & 0xff);
const WORLD = new Uint8Array(32).map((_, i) => (i * 3) & 0xff);

/** The whole fixture tree, rooted wherever the caller wants it. */
function tree(
  root: string,
  overrides: Record<string, string | Uint8Array> = {},
): Record<string, string | Uint8Array> {
  return {
    [`${root}/modules/platformer/module.toml`]: ENGINE_TOML,
    [`${root}/modules/platformer/engine.js`]: ENGINE_JS,
    [`${root}/modules/sweetie16/module.toml`]: PALETTE_TOML,
    [`${root}/modules/caves/module.toml`]: TILESET_TOML,
    [`${root}/modules/caves/tiles.bin`]: TILES,
    [`${root}/modules/caves/world.bin`]: WORLD,
    [`${root}/recipe.toml`]: RECIPE,
    ...overrides,
  };
}

/** Stamp the fixture tree, with `frames` kept small unless a test wants 600. */
function stampFixture(
  overrides: Record<string, string | Uint8Array> = {},
  frames = 24,
  root = "/proj",
) {
  const h = harness(tree(root, overrides));
  const result = stamp(`${root}/recipe.toml`, h.io, {
    modulesRoot: `${root}/modules`,
    frames,
  });
  return { h, result };
}

/** The codes of everything reported, sorted, for a compact assertion. */
function codes(ds: readonly Diagnostic[]): string[] {
  return sortDiagnostics(ds).map((d) => d.code);
}

// ===========================================================================

describe("the happy path", () => {
  it("stamps a recipe into a cart, and proves it before returning it", () => {
    const { result } = stampFixture({}, 600);
    if (!result.ok) throw new Error(formatDiagnostics(result.diagnostics));

    expect(result.diagnostics).toEqual([]);
    expect(result.id).toMatch(/^[0-9A-Z]{32}$/);
    expect(result.bytes.length).toBeLessThan(MAX_CART_BYTES);
    expect(result.tokens).toBeGreaterThan(0);
    expect(result.proof.frames).toBe(600);
    expect(result.proof.seed).toBe(1);
    expect(result.proof.chain).toMatch(/^[0-9a-f]{64}$/);
  });

  it("writes a cart that decodes, with the chunks the modules supplied", () => {
    const { result } = stampFixture();
    if (!result.ok) throw new Error(formatDiagnostics(result.diagnostics));

    const decoded = decode(result.bytes);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    // No module here ships bytes, so the cart is code and its recipe.
    expect(decoded.cart.chunks.map((c) => c.type)).toEqual(["META", "CODE", "rcpe"]);

    const meta = decodeMeta(getChunk(decoded.cart, "META") as Uint8Array);
    expect(meta.ok).toBe(true);
    if (!meta.ok) return;
    expect(meta.meta.title).toBe("Cave Runner");
    expect(meta.meta.author).toBe("eric");
    expect(meta.meta.profile).toBe("up");
  });

  it("carries a module's [files] bytes into the chunks they name", () => {
    const { result } = stampFixture({
      "/proj/modules/caves/module.toml": TILESET_WITH_FILES,
    });
    // The runtime installs cart chunks into RAM at boot. Until that lands,
    // `prove` refuses to certify a cart whose data would not be there -- so
    // this test asserts the packing either way and says which world it is in.
    if (!result.ok) {
      expect(codes(result.diagnostics)).toEqual(["prove-failed"]);
      expect((result.diagnostics[0] as Diagnostic).message).toContain(
        "does not install cart chunks into RAM at boot",
      );
      return;
    }
    const decoded = decode(result.bytes);
    if (!decoded.ok) throw new Error("did not decode");
    expect(decoded.cart.chunks.map((c) => c.type)).toEqual(["META", "CODE", "GFX ", "MAP ", "rcpe"]);
    expect([...(getChunk(decoded.cart, "GFX ") as Uint8Array)]).toEqual([...TILES]);
    expect([...(getChunk(decoded.cart, "MAP ") as Uint8Array)]).toEqual([...WORLD]);
  });

  it("emits the preamble the format specifies, with knobs sorted and fixed as 16.16", () => {
    const { result } = stampFixture();
    if (!result.ok) throw new Error(formatDiagnostics(result.diagnostics));

    const lines = result.source.split("\n");
    expect(lines[0]).toBe(GENERATED_BANNER);
    // Sorted BY KNOB NAME (coyote_frames, gravity, jump_velocity, show_hud), so
    // the bytes do not depend on how a Map happened to be filled in.
    expect(lines[1]).toBe(
      "const KNOB = { coyoteFrames: 6, gravity: 27525 / 65536, " +
        "jumpVelocity: -203162 / 65536, showHud: true };",
    );
    expect(lines[2]).toBe("// ---- engine: platformer@1.0.0 ----");
    expect(result.source.slice(result.source.indexOf("\n", result.source.indexOf("----\n")) + 1)).toBe(
      ENGINE_JS,
    );

    // NO DECIMAL STRING ANYWHERE in the generated preamble: every fixed knob is
    // an integer over a power of two, which is exact on every engine.
    expect(lines[1]).not.toMatch(/[0-9]\.[0-9]/);
  });

  it("records the recipe and every module's content hash in the rcpe chunk", () => {
    const { result } = stampFixture();
    if (!result.ok) throw new Error(formatDiagnostics(result.diagnostics));

    const decoded = decode(result.bytes);
    if (!decoded.ok) throw new Error("cart did not decode");
    const chunk = parseRecipeChunk(getChunk(decoded.cart, "rcpe") as Uint8Array);
    expect(chunk).not.toBeNull();
    if (chunk === null) return;

    expect(chunk.engine.ref).toBe("platformer@1.0.0");
    expect(chunk.engine.hash).toMatch(/^[0-9a-f]{64}$/);
    // Sorted by kind then name, so the chunk is a function of the build.
    expect(chunk.modules).toEqual([
      { kind: "palette", ref: "sweetie16@1.0.0", hash: expect.stringMatching(/^[0-9a-f]{64}$/) },
      { kind: "tileset", ref: "caves@1.0.0", hash: expect.stringMatching(/^[0-9a-f]{64}$/) },
    ]);
    expect(chunk.knobs).toEqual([
      { name: "coyote_frames", type: "int", raw: 6 },
      { name: "gravity", type: "fixed", raw: 27525 },
      { name: "jump_velocity", type: "fixed", raw: -203162 },
      { name: "show_hud", type: "bool", raw: 1 },
    ]);
    expect(chunk.proof).toEqual(result.proof);
    // The cart decompiles back to the editable recipe it was built from.
    expect(chunk.recipe).toBe(RECIPE);
  });
});

// ===========================================================================

describe("reproducibility: the acceptance criterion", () => {
  it("is byte-identical from two different directories", () => {
    const a = stampFixture({}, 24, "/one");
    const b = stampFixture({}, 24, "/two/deeper/elsewhere");
    if (!a.result.ok) throw new Error(formatDiagnostics(a.result.diagnostics));
    if (!b.result.ok) throw new Error(formatDiagnostics(b.result.diagnostics));
    expect([...b.result.bytes]).toEqual([...a.result.bytes]);
    expect(b.result.id).toBe(a.result.id);
    expect(b.result.proof.chain).toBe(a.result.proof.chain);
  });

  it("is byte-identical on a second run, so nothing environmental leaked in", () => {
    const a = stampFixture();
    const b = stampFixture();
    if (!a.result.ok || !b.result.ok) throw new Error("a fixture stamp failed");
    expect([...b.result.bytes]).toEqual([...a.result.bytes]);
  });

  it("puts no path and no timestamp anywhere in the cart", () => {
    const root = "/a/very/distinctive/directory";
    const { result } = stampFixture({}, 24, root);
    if (!result.ok) throw new Error(formatDiagnostics(result.diagnostics));

    // The whole cart, read as text. A path or a date would show up here.
    const asText = dec.decode(result.bytes);
    expect(asText).not.toContain("distinctive");
    expect(asText).not.toContain("/modules/");
    expect(asText).not.toContain(root);
    expect(asText).not.toMatch(/20[0-9]{2}-[0-9]{2}-[0-9]{2}/);
    expect(asText).not.toMatch(/GMT|UTC|T[0-9]{2}:[0-9]{2}:[0-9]{2}/);
  });

  it("gives the same module the same hash from two roots, and a changed byte a different one", () => {
    const files = new Map<string, Uint8Array>([
      ["module.toml", enc.encode(TILESET_TOML)],
      ["tiles.bin", TILES],
    ]);
    const same = new Map(files);
    const one = moduleHash("caves", "1.0.0", "tileset", files);
    expect(moduleHash("caves", "1.0.0", "tileset", same)).toBe(one);

    // Insertion order must not matter: the hash sorts file names.
    const reordered = new Map<string, Uint8Array>([
      ["tiles.bin", TILES],
      ["module.toml", enc.encode(TILESET_TOML)],
    ]);
    expect(moduleHash("caves", "1.0.0", "tileset", reordered)).toBe(one);

    const changed = new Map(files);
    changed.set("tiles.bin", TILES.map((b) => b ^ 1));
    expect(moduleHash("caves", "1.0.0", "tileset", changed)).not.toBe(one);
    // The manifest is hashed like any other file.
    expect(moduleHash("caves", "1.0.1", "tileset", files)).not.toBe(one);
  });

  it("a knob change changes the cart, and the same knob written twice does not", () => {
    const a = stampFixture();
    const b = stampFixture({ "/proj/recipe.toml": RECIPE.replace("0.42", "0.43") });
    if (!a.result.ok || !b.result.ok) throw new Error("a fixture stamp failed");
    expect(b.result.id).not.toBe(a.result.id);

    // The same numbers, differently spelled, are the same 16.16 integers, and
    // therefore the same cart: the emitted source holds no decimal text.
    const respelled = RECIPE.replace("gravity       = 0.42", "gravity=0.42   # same value");
    const c = stampFixture({ "/proj/recipe.toml": respelled });
    if (!c.result.ok) throw new Error("respelled stamp failed");
    expect(c.result.source).toBe(a.result.source);
  });

  it("the second pack cannot change the chain the first one proved", () => {
    // `prove` gates `pack`, and the proof lands in `rcpe` -- so pack runs twice.
    // The chain is a function of CODE, the seed and the input, and `rcpe` is
    // none of those. If that ever stopped being true, this fails.
    const h = harness(tree("/proj"));
    const parsed = parseRecipe("/proj/recipe.toml", RECIPE);
    if (!parsed.ok) throw new Error("recipe did not parse");
    const bound = bind(merge(resolve(parsed.recipe, h.io, { modulesRoot: "/proj/modules" })));
    const payload = compile(bound);

    const draft = pack(payload, bound, null);
    const first = prove(draft.bytes, { file: "/proj/recipe.toml", pos: { line: 1, column: 1 }, frames: 30 });
    expect(first.ok).toBe(true);

    const final = pack(payload, bound, {
      seed: first.seed,
      frames: first.frames,
      chain: first.chain,
    });
    const second = prove(final.bytes, { file: "/proj/recipe.toml", pos: { line: 1, column: 1 }, frames: 30 });
    expect(second.chain).toBe(first.chain);
    expect(second.frameHashes).toEqual(first.frameHashes);
    // And the two packs differ only in the rcpe chunk.
    expect(final.bytes.length).toBeGreaterThan(draft.bytes.length);
  });
});

// ===========================================================================

describe("diagnostics: the product", () => {
  it("names the file, the line and the fix for an unbound required knob", () => {
    const recipe = RECIPE.replace("jump_velocity = -3.1\n", "");
    const { result } = stampFixture({ "/proj/recipe.toml": recipe });
    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(codes(result.diagnostics)).toEqual(["unbound-knob"]);
    expect(formatDiagnostic(result.diagnostics[0] as Diagnostic)).toBe(
      "/proj/recipe.toml:14:1  error[unbound-knob]  engine platformer@1.0.0 requires knob `jump_velocity`,\n" +
        "                  which the [tuning] table does not set.\n" +
        "                  Add:  jump_velocity = -4.0   # -8.0 .. 0.0, upward speed of a jump",
    );
  });

  it("reports MANY unbound knobs as one paste-ready block, not a wall", () => {
    // An engine may require nineteen knobs, and a recipe that has not been
    // filled in is missing all of them at once. Nineteen separate errors --
    // same file, same line, same wording, one identifier apart -- is something
    // an author scrolls past. One block, with the `=` in a column, is the thing
    // they actually need: they paste it and edit the numbers.
    const engine = ENGINE_TOML.replace("default = 0.42\n", "").replace("default = 6\n", "");
    const recipe = RECIPE.replace("gravity       = 0.42\n", "").replace(
      "jump_velocity = -3.1\n",
      "",
    );
    const { result } = stampFixture({
      "/proj/modules/platformer/module.toml": engine,
      "/proj/recipe.toml": recipe,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;

    // ONE diagnostic, not three.
    expect(codes(result.diagnostics)).toEqual(["unbound-knob"]);
    expect(formatDiagnostic(result.diagnostics[0] as Diagnostic)).toBe(
      "/proj/recipe.toml:14:1  error[unbound-knob]  engine platformer@1.0.0 requires 3 knobs which the [tuning] table does not set:\n" +
        "                  coyote_frames, gravity, jump_velocity\n" +
        "                  Add to [tuning] -- the values below are starting points, not answers:\n" +
        "                    coyote_frames = 15     # 0 .. 30\n" +
        "                    gravity       = 2.0    # 0.0 .. 4.0, Downward acceleration per frame, in pixels\n" +
        "                    jump_velocity = -4.0   # -8.0 .. 0.0, upward speed of a jump",
    );
  });

  it("catches a misspelt knob and offers the name that was meant", () => {
    const recipe = RECIPE.replace("gravity       =", "graviti       =");
    const { result } = stampFixture({ "/proj/recipe.toml": recipe });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const d = result.diagnostics.find((x) => x.code === "unknown-knob") as Diagnostic;
    expect(d.message).toContain("no module in this recipe declares a knob `graviti`");
    expect(d.file).toBe("/proj/recipe.toml");
    expect(d.line).toBe(15);
    expect(d.suggestion).toContain("Did you mean `gravity`?");
    expect(d.suggestion).toContain("coyote_frames, gravity, jump_velocity, show_hud");
  });

  it("catches a knob outside its range, and quotes the range", () => {
    const { result } = stampFixture({
      "/proj/recipe.toml": RECIPE.replace("gravity       = 0.42", "gravity       = 9.5"),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const d = result.diagnostics[0] as Diagnostic;
    expect(d.code).toBe("knob-out-of-range");
    expect(d.message).toBe("knob `gravity` is 9.5, above its maximum of 4.0.");
    expect(d.line).toBe(15);
    expect(d.suggestion).toContain("The range is 0.0 .. 4.0.");
    expect(d.suggestion).toContain("Downward acceleration per frame");
  });

  it("catches a value of the wrong type for its knob", () => {
    const { result } = stampFixture({
      "/proj/recipe.toml": RECIPE + 'coyote_frames = "six"\n',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const d = result.diagnostics[0] as Diagnostic;
    expect(d.code).toBe("knob-type");
    expect(d.message).toBe('knob `coyote_frames` is `int`, and "six" is a string.');
    expect(d.suggestion).toContain("a whole number, with no decimal point");
  });

  it("refuses a float for an int knob, because 6.0 frames is not a frame count", () => {
    const { result } = stampFixture({
      "/proj/recipe.toml": RECIPE + "coyote_frames = 6.0\n",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect((result.diagnostics[0] as Diagnostic).code).toBe("knob-type");
  });

  it("accepts an integer for a fixed knob, because 1 is a perfectly good 1.0", () => {
    const { result } = stampFixture({
      "/proj/recipe.toml": RECIPE.replace("gravity       = 0.42", "gravity       = 1"),
    });
    if (!result.ok) throw new Error(formatDiagnostics(result.diagnostics));
    expect(result.source).toContain("gravity: 65536 / 65536");
  });

  it("names a module that is not there, and says what is", () => {
    const { result } = stampFixture({
      "/proj/recipe.toml": RECIPE.replace("caves@1.0.0", "cavez@1.0.0"),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const d = result.diagnostics[0] as Diagnostic;
    expect(d.code).toBe("missing-module");
    expect(d.message).toBe(
      "there is no module `cavez@1.0.0`: /proj/modules/cavez/module.toml is not there.",
    );
    expect(d.line).toBe(12);
    expect(d.suggestion).toContain("caves, platformer, sweetie16");
  });

  it("catches a module used as the wrong kind", () => {
    const { result } = stampFixture({
      "/proj/recipe.toml": RECIPE.replace('palette = "sweetie16@1.0.0"', 'palette = "caves@1.0.0"'),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const d = result.diagnostics.find((x) => x.code === "module-kind-mismatch") as Diagnostic;
    expect(d.message).toBe("`caves@1.0.0` is a tileset module, and this recipe uses it as a palette.");
  });

  it("catches a manifest whose name does not match the reference", () => {
    const { result } = stampFixture({
      "/proj/modules/caves/module.toml": TILESET_TOML.replace('version = "1.0.0"', 'version = "2.0.0"'),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const d = result.diagnostics[0] as Diagnostic;
    expect(d.code).toBe("module-version-mismatch");
    expect(d.suggestion).toBe('Write  tileset = "caves@2.0.0"');
  });

  it("catches an unsatisfied `requires`: a tileset with too few tiles", () => {
    const { result } = stampFixture({
      "/proj/modules/caves/module.toml": TILESET_TOML.replace("tiles = 128", "tiles = 32"),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const d = result.diagnostics[0] as Diagnostic;
    expect(d.code).toBe("unsatisfied-requires");
    expect(d.message).toBe(
      "engine `platformer@1.0.0` requires tileset min_tiles = 64, and `caves@1.0.0` declares tiles = 32.",
    );
    expect(d.suggestion).toContain("tiles = 32, flags = [\"solid\", \"hazard\", \"ladder\"]");
  });

  it("catches an unsatisfied `requires`: a tileset missing a flag", () => {
    const { result } = stampFixture({
      "/proj/modules/caves/module.toml": TILESET_TOML.replace(
        'flags = ["solid", "hazard", "ladder"]',
        'flags = ["solid"]',
      ),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const d = result.diagnostics[0] as Diagnostic;
    expect(d.code).toBe("unsatisfied-requires");
    expect(d.message).toContain('declares flags [solid] and is missing "hazard"');
  });

  it("catches a `requires` with nothing to satisfy it at all", () => {
    const { result } = stampFixture({
      "/proj/recipe.toml": RECIPE.replace('palette = "sweetie16@1.0.0"\n', ""),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const d = result.diagnostics[0] as Diagnostic;
    expect(d.code).toBe("unsatisfied-requires");
    expect(d.message).toBe(
      "engine `platformer@1.0.0` requires a palette module, and this recipe sets none.",
    );
    expect(d.suggestion).toContain('palette = "somename@1.0.0"');
  });

  it("refuses an engine that names Math, at the engine's own line", () => {
    const { result } = stampFixture({
      "/proj/modules/platformer/engine.js": ENGINE_JS.replace(
        "var f = sys.frame();",
        "var f = Math.floor(sys.frame());",
      ),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const d = result.diagnostics[0] as Diagnostic;
    expect(d.code).toBe("forbidden-identifier");
    expect(d.file).toBe("/proj/modules/platformer/engine.js");
    // Line 8 of engine.js -- NOT line 11 of the compiled source, which is what
    // an unmapped position would report.
    expect(d.line).toBe(8);
    expect(d.message).toContain("Math is not available in a cart");
  });

  it("refuses an engine with no top-level tick", () => {
    const { result } = stampFixture({
      "/proj/modules/platformer/engine.js": "var x = 1;\n",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(codes(result.diagnostics)).toEqual(["missing-tick"]);
    expect((result.diagnostics[0] as Diagnostic).file).toBe("/proj/modules/platformer/engine.js");
  });

  it("refuses an engine over the token budget, and says how far over", () => {
    // Well over 8192 tokens: three tokens per line, 4000 lines.
    const fat = ENGINE_JS + Array.from({ length: 4000 }, (_, i) => `var v${i};`).join("\n") + "\n";
    const { result } = stampFixture({ "/proj/modules/platformer/engine.js": fat });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const d = result.diagnostics.find((x) => x.code === "token-budget") as Diagnostic;
    expect(d.message).toContain("over the 8192-token budget");
    expect(d.file).toBe("/proj/modules/platformer/engine.js");
  });

  it("refuses a cart over the byte budget, and names the biggest input", () => {
    // Through `labl`, the cart's own picture: it is never installed into RAM,
    // so it has no region cap to trip before the cart budget does.
    const { result } = stampFixture({
      "/proj/modules/caves/module.toml": `${TILESET_TOML}
[files]
labl = "big.bin"
`,
      "/proj/modules/caves/big.bin": new Uint8Array(MAX_CART_BYTES).fill(7),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const d = result.diagnostics[0] as Diagnostic;
    expect(d.code).toBe("cart-budget");
    expect(d.message).toContain(`over the ${MAX_CART_BYTES}-byte cart budget`);
    expect(d.suggestion).toContain("The largest input is labl from `caves@1.0.0`");
  });

  it("refuses a chunk larger than the RAM region it installs into", () => {
    const { result } = stampFixture({
      "/proj/modules/caves/module.toml": TILESET_WITH_FILES,
      "/proj/modules/caves/world.bin": new Uint8Array(9000).fill(3),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const d = result.diagnostics.find((x) => x.code === "chunk-too-large") as Diagnostic;
    expect(d.message).toBe(
      "the map data is 9000 bytes, and the MAP region at 0x4300 holds 8192.",
    );
    expect(d.suggestion).toContain("`caves@1.0.0` supplies it");
  });

  it("reports malformed TOML in a recipe with a line and a column", () => {
    const { result } = stampFixture({ "/proj/recipe.toml": "[cart\ntitle = 1\n" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const d = result.diagnostics[0] as Diagnostic;
    expect(d.code).toBe("malformed-toml");
    expect(d.file).toBe("/proj/recipe.toml");
    // The `[cart` header runs into the newline; that is where it stopped being TOML.
    expect(d.line).toBe(1);
    expect(d.column).toBe(6);
  });

  it("reports malformed TOML in a manifest against the manifest", () => {
    const { result } = stampFixture({
      "/proj/modules/caves/module.toml": TILESET_TOML.replace('name    = "caves"', "name = caves"),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const d = result.diagnostics[0] as Diagnostic;
    expect(d.code).toBe("malformed-toml");
    expect(d.file).toBe("/proj/modules/caves/module.toml");
  });

  it("refuses a path where a module reference belongs, and explains why", () => {
    const { result } = stampFixture({
      "/proj/recipe.toml": RECIPE.replace('"caves@1.0.0"', '"./art/caves.toml"'),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const d = result.diagnostics[0] as Diagnostic;
    expect(d.code).toBe("bad-module-ref");
    expect(d.suggestion).toContain("never as a path");
  });

  it("refuses a profile this specification version does not define", () => {
    const { result } = stampFixture({
      "/proj/recipe.toml": RECIPE.replace('profile = "up"', 'profile = "xp"'),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(codes(result.diagnostics)).toEqual(["unsupported-profile"]);
  });

  it("refuses a recipe with no engine", () => {
    const { result } = stampFixture({
      "/proj/recipe.toml": RECIPE.replace('[engine]\nuse = "platformer@1.0.0"\n', ""),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(codes(result.diagnostics)).toContain("missing-engine");
  });

  it("refuses an engine module with no engine.js", () => {
    const h = harness(tree("/proj"));
    h.files.delete("/proj/modules/platformer/engine.js");
    const result = stamp("/proj/recipe.toml", h.io, { modulesRoot: "/proj/modules", frames: 4 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(codes(result.diagnostics)).toEqual(["missing-module-file"]);
  });

  it("refuses a manifest naming a data file that is not in the module", () => {
    const h = harness(tree("/proj", { "/proj/modules/caves/module.toml": TILESET_WITH_FILES }));
    h.files.delete("/proj/modules/caves/world.bin");
    const result = stamp("/proj/recipe.toml", h.io, { modulesRoot: "/proj/modules", frames: 4 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const d = result.diagnostics[0] as Diagnostic;
    expect(d.code).toBe("missing-module-file");
    expect(d.message).toContain('[files] map names "world.bin"');
  });

  it("says there is no recipe when there is no recipe", () => {
    const h = harness(tree("/proj"));
    const result = stamp("/proj/nope.toml", h.io, { modulesRoot: "/proj/modules" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(codes(result.diagnostics)).toEqual(["missing-recipe"]);
  });

  it("prints diagnostics in file, line, column order whatever order they were found in", () => {
    const ds: Diagnostic[] = [
      { severity: "error", code: "b", message: "m", file: "z.toml", line: 1, column: 1 },
      { severity: "error", code: "a", message: "m", file: "a.toml", line: 9, column: 1 },
      { severity: "error", code: "a", message: "m", file: "a.toml", line: 2, column: 5 },
      { severity: "error", code: "a", message: "m", file: "a.toml", line: 2, column: 1 },
    ];
    expect(sortDiagnostics(ds).map((d) => `${d.file}:${d.line}:${d.column}`)).toEqual([
      "a.toml:2:1",
      "a.toml:2:5",
      "a.toml:9:1",
      "z.toml:1:1",
    ]);
  });
});

// ===========================================================================

describe("the stages, one at a time", () => {
  function pipeline(root = "/proj") {
    const h = harness(tree(root));
    const parsed = parseRecipe(`${root}/recipe.toml`, RECIPE);
    if (!parsed.ok) throw new Error("recipe did not parse");
    const resolved = resolve(parsed.recipe, h.io, { modulesRoot: `${root}/modules` });
    return { h, recipe: parsed.recipe, resolved };
  }

  it("[1] resolve reads bytes and hashes content, and keeps the path out of the result", () => {
    const { resolved } = pipeline();
    expect(resolved.diagnostics).toEqual([]);
    expect(resolved.engine?.ref.text).toBe("platformer@1.0.0");
    expect(resolved.engine?.files.get("engine.js")).toBeDefined();
    expect(resolved.modules.map((m) => m.slot)).toEqual(["palette", "tileset"]);
    expect(resolved.engine?.hash).toMatch(/^[0-9a-f]{64}$/);
    // The same module from another root hashes the same.
    const other = pipeline("/elsewhere");
    expect(other.resolved.engine?.hash).toBe(resolved.engine?.hash);
  });

  it("[2] merge layers in declared order, and the recipe's tuning wins over a module's", () => {
    const tuningModule = `[module]
kind    = "tuning"
name    = "floaty"
version = "1.0.0"

[tuning]
gravity       = 0.10
coyote_frames = 12
`;
    const recipe = RECIPE.replace(
      'tileset = "caves@1.0.0"',
      'tileset = "caves@1.0.0"\ntuning  = "floaty@1.0.0"',
    );
    const { result } = stampFixture({
      "/proj/modules/floaty/module.toml": tuningModule,
      "/proj/recipe.toml": recipe,
    });
    if (!result.ok) throw new Error(formatDiagnostics(result.diagnostics));
    // The tuning module set coyote_frames (nothing else did) and gravity (which
    // the recipe's own [tuning] then overrode).
    expect(result.source).toContain("coyoteFrames: 12");
    expect(result.source).toContain("gravity: 27525 / 65536");
  });

  it("[3] bind turns fixed knobs into 16.16 through the console's own conversion", () => {
    const { h, recipe } = pipeline();
    const bound = bind(merge(resolve(recipe, h.io, { modulesRoot: "/proj/modules" })));
    expect(bound.diagnostics).toEqual([]);
    expect(bound.knobs.map((k) => [k.name, k.jsName, k.type, k.raw])).toEqual([
      ["coyote_frames", "coyoteFrames", "int", 6],
      ["gravity", "gravity", "fixed", 27525],
      ["jump_velocity", "jumpVelocity", "fixed", -203162],
      ["show_hud", "showHud", "bool", 1],
    ]);
  });

  it("[4] validate is clean on a recipe whose interfaces line up", () => {
    const { h, recipe } = pipeline();
    const bound = bind(merge(resolve(recipe, h.io, { modulesRoot: "/proj/modules" })));
    expect(validate(bound)).toEqual([]);
  });

  it("[5] compile counts the tokens of what it emitted, not of engine.js alone", () => {
    const { h, recipe } = pipeline();
    const bound = bind(merge(resolve(recipe, h.io, { modulesRoot: "/proj/modules" })));
    const payload = compile(bound);
    expect(payload.diagnostics).toEqual([]);
    expect(payload.preambleLines).toBe(3);
    expect(payload.tokens).toBeGreaterThan(60);
    expect(payload.source.split("\n")).toHaveLength(ENGINE_JS.split("\n").length + 3);
  });

  it("[6] pack orders chunks canonically and hands back a decodable cart", () => {
    const { h, recipe } = pipeline();
    const bound = bind(merge(resolve(recipe, h.io, { modulesRoot: "/proj/modules" })));
    const packed = pack(compile(bound), bound, null);
    expect(packed.diagnostics).toEqual([]);
    expect(decode(packed.bytes).ok).toBe(true);
    expect(packed.id).toMatch(/^[0-9A-Z]{32}$/);
  });

  it("[7] prove runs the cart and returns a chain, and the same run happens again", () => {
    const { h, recipe } = pipeline();
    const bound = bind(merge(resolve(recipe, h.io, { modulesRoot: "/proj/modules" })));
    const packed = pack(compile(bound), bound, null);
    const opts = { file: "/proj/recipe.toml", pos: { line: 1, column: 1 }, frames: 40 };
    const a = prove(packed.bytes, opts);
    const b = prove(packed.bytes, opts);
    expect(a.ok).toBe(true);
    expect(a.frameHashes).toHaveLength(40);
    expect(b.chain).toBe(a.chain);
    // A prefix of the same run chains to the same first hashes: the chain is
    // prefix-committing, which is what makes a divergence bisectable.
    const short = prove(packed.bytes, { ...opts, frames: 10 });
    expect(short.frameHashes).toEqual(a.frameHashes.slice(0, 10));
  });

  it("[7] prove reports an engine that throws, and names the frame", () => {
    const throwing = ENGINE_JS.replace(
      "function tick() {",
      "function tick() {\n  if (sys.frame() === 5) { null.x = 1; }",
    );
    const { result } = stampFixture({ "/proj/modules/platformer/engine.js": throwing }, 30);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const d = result.diagnostics[0] as Diagnostic;
    expect(d.code).toBe("prove-failed");
    expect(d.message).toContain("threw on frame 5 of 30");
  });

  it("[7] prove reports an engine that throws while booting", () => {
    const throwing = ENGINE_JS.replace("sys.poke(Y, 60);", "null.x = 1;");
    const { result } = stampFixture({ "/proj/modules/platformer/engine.js": throwing }, 10);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect((result.diagnostics[0] as Diagnostic).message).toContain("threw while booting");
  });
});

// ===========================================================================

describe("manifests and references", () => {
  it("parses the fixture engine manifest", () => {
    const r = parseManifest("/m/module.toml", ENGINE_TOML);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.manifest).toMatchObject({ kind: "engine", name: "platformer", version: "1.0.0" });
    expect(r.manifest.knobs.map((k) => k.name)).toEqual([
      "gravity",
      "jump_velocity",
      "coyote_frames",
      "show_hud",
    ]);
    // A knob with no `default` is REQUIRED, and that is the only way to say so.
    expect(r.manifest.knobs.find((k) => k.name === "jump_velocity")?.default).toBeUndefined();
    expect(r.manifest.knobs.find((k) => k.name === "gravity")?.default).toBeDefined();
    expect(r.manifest.requires.map((q) => q.kind)).toEqual(["palette", "tileset"]);
  });

  it("refuses a knob name that cannot become a JavaScript property", () => {
    const r = parseManifest("/m/module.toml", ENGINE_TOML.replace("[knobs.gravity]", "[knobs.Gravity]"));
    expect(r.ok).toBe(false);
    expect(r.diagnostics.map((d) => d.code)).toContain("bad-knob-name");
  });

  it("refuses a knob with no type, and a type that is not one of the three", () => {
    expect(
      parseManifest("/m/module.toml", ENGINE_TOML.replace('type    = "fixed"\ndefault = 0.42', "default = 0.42"))
        .ok,
    ).toBe(false);
    expect(
      parseManifest("/m/module.toml", ENGINE_TOML.replace('type    = "fixed"', 'type    = "double"')).ok,
    ).toBe(false);
  });

  it("refuses a default whose type disagrees with the knob's", () => {
    const r = parseManifest("/m/module.toml", ENGINE_TOML.replace("default = 6", 'default = "six"'));
    expect(r.ok).toBe(false);
    expect(r.diagnostics.some((d) => d.message.includes("declared `int` but its default is a string"))).toBe(
      true,
    );
  });

  it("refuses a kind that is not a module kind, and lists the ones that are", () => {
    const r = parseManifest("/m/module.toml", PALETTE_TOML.replace('"palette"', '"paletts"'));
    expect(r.ok).toBe(false);
    expect(r.diagnostics[0]?.suggestion).toContain("engine, palette, tileset");
  });

  it("refuses a [files] entry that is not a plain name beside the manifest", () => {
    for (const bad of ["../secrets.bin", "sub/dir.bin", ".hidden"]) {
      const r = parseManifest("/m/module.toml", TILESET_WITH_FILES.replace('"tiles.bin"', `"${bad}"`));
      expect(r.ok).toBe(false);
      expect(r.diagnostics.some((d) => d.message.includes("not a plain file name"))).toBe(true);
    }
  });

  it("parses a module reference, and refuses everything that is not one", () => {
    expect(parseRef("platformer@1.0.0")).toEqual({
      name: "platformer",
      version: "1.0.0",
      text: "platformer@1.0.0",
    });
    expect(parseRef("caves-8x8@3")).toMatchObject({ name: "caves-8x8", version: "3" });
    expect(parseRef("x@2.1.0-rc1")).toMatchObject({ version: "2.1.0-rc1" });
    for (const bad of ["platformer", "./x.toml", "Platformer@1", "x@", "@1", "x@v1", "a b@1"]) {
      expect(parseRef(bad)).toBeNull();
    }
  });

  it("maps snake_case to camelCase, and only that", () => {
    expect(camelCase("jump_velocity")).toBe("jumpVelocity");
    expect(camelCase("gravity")).toBe("gravity");
    expect(camelCase("run_2x_accel")).toBe("run2xAccel");
    expect(camelCase("a_b_c")).toBe("aBC");
  });
});

// ===========================================================================

describe("the rcpe chunk reads back", () => {
  it("round-trips everything it was given", () => {
    const h = harness(tree("/proj"));
    const parsed = parseRecipe("/proj/recipe.toml", RECIPE);
    if (!parsed.ok) throw new Error("recipe did not parse");
    const merged = merge(resolve(parsed.recipe, h.io, { modulesRoot: "/proj/modules" }));
    const bound = bind(merged);
    const proof = { seed: 1, frames: 600, chain: "a".repeat(64) };
    const chunk = buildRecipeChunk(merged, bound.knobs, proof);

    const back = parseRecipeChunk(chunk);
    expect(back).not.toBeNull();
    if (back === null) return;
    expect(back.recipe).toBe(RECIPE);
    expect(back.proof).toEqual(proof);
    expect(back.engine.ref).toBe("platformer@1.0.0");
    expect(back.knobs).toHaveLength(4);
  });

  it("survives a recipe that itself contains a line beginning `recipe `", () => {
    // The body length is stated for exactly this reason: a scan for the marker
    // would stop inside the recipe rather than in front of it.
    const tricky = RECIPE + '\n# recipe 4\n# sq1-recipe 1\n';
    const { result } = stampFixture({ "/proj/recipe.toml": tricky });
    if (!result.ok) throw new Error(formatDiagnostics(result.diagnostics));
    const decoded = decode(result.bytes);
    if (!decoded.ok) throw new Error("did not decode");
    const back = parseRecipeChunk(getChunk(decoded.cart, "rcpe") as Uint8Array);
    expect(back?.recipe).toBe(tricky);
  });

  it("returns null rather than throwing for bytes that are not an rcpe chunk", () => {
    for (const bytes of [
      new Uint8Array(0),
      enc.encode("nonsense\n"),
      enc.encode("sq1-recipe 1\nrecipe 5\nabc"),
      new Uint8Array([0xff, 0xfe, 0xfd]),
    ]) {
      expect(() => parseRecipeChunk(bytes)).not.toThrow();
      expect(parseRecipeChunk(bytes)).toBeNull();
    }
  });
});

// ===========================================================================

describe("stampSource: the same pipeline without a file", () => {
  it("stamps a recipe held in memory, identically to one on disk", () => {
    const h = harness(tree("/proj"));
    const fromDisk = stamp("/proj/recipe.toml", h.io, { modulesRoot: "/proj/modules", frames: 12 });
    const fromBuffer = stampSource("/proj/recipe.toml", RECIPE, h.io, {
      modulesRoot: "/proj/modules",
      frames: 12,
    });
    if (!fromDisk.ok || !fromBuffer.ok) throw new Error("a stamp failed");
    expect([...fromBuffer.bytes]).toEqual([...fromDisk.bytes]);
  });

  it("refuses an unpaired surrogate at the door rather than five stages later", () => {
    const h = harness(tree("/proj"));
    const result = stampSource("/buf.toml", `${RECIPE}\n# \uD800\n`, h.io, {
      modulesRoot: "/proj/modules",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect((result.diagnostics[0] as Diagnostic).message).toContain("unpaired surrogate");
  });
});

// ===========================================================================

/*
 * THE SWAP: one engine, two art packs, and what has to differ between them.
 *
 * The module system's whole claim is that art and code are separable, and the
 * cheapest way to state that as a measurement rather than a slogan is to build
 * the same recipe twice with a different tileset in it and look at which BYTES
 * moved. Two things have to be true at once, and neither is interesting alone:
 *
 *   the CODE chunk differs ONLY in the knob preamble -- so no engine source was
 *   edited, and nothing about the art leaked into the cart's source;
 *
 *   the GFX chunk differs -- so the art actually reached the machine. A swap
 *   that produced identical bytes would mean the pack was never installed and
 *   the game was running on whatever happened to be in RAM.
 *
 * `modules/dungeon` and `examples/deep-run` are the same experiment against the
 * real packs. This is the fixture-level version, which is the one that fails on
 * a Tuesday when somebody changes the emitter.
 */

/** A tileset pack: 64 cells of its own pixels and its own flags. */
function artPack(name: string, pixelSeed: number, flagByte: number) {
  const cells = 64;
  const data = new Uint8Array(cells * 33);
  for (let i = 0; i < cells * 32; i++) data[i] = ((pixelSeed + i * 3) & 0xfe) | 1;
  for (let i = 0; i < cells; i++) data[cells * 32 + i] = flagByte;
  return {
    toml: `[module]
kind    = "tileset"
name    = "${name}"
version = "1.0.0"

[provides]
tiles = 64
base  = 0
data  = "tiles.bin"
flags = ["solid", "hazard"]
`,
    data,
  };
}

describe("the swap: the same engine with a different art pack in it", () => {
  const CAVES = artPack("caves", 0x10, 0x01);
  const DUNGEON = artPack("dungeon", 0x92, 0x03);

  /** The fixture recipe with `tileset` pointed at `name`, and knobs from `tuning`. */
  function swapRecipe(name: string, tuning: string): string {
    return RECIPE.replace('tileset = "caves@1.0.0"', `tileset = "${name}@1.0.0"`).replace(
      "gravity       = 0.42",
      tuning,
    );
  }

  function build(name: string, pack: { toml: string; data: Uint8Array }, tuning: string) {
    const h = harness(
      tree("/proj", {
        [`/proj/modules/${name}/module.toml`]: pack.toml,
        [`/proj/modules/${name}/tiles.bin`]: pack.data,
        "/proj/recipe.toml": swapRecipe(name, tuning),
      }),
    );
    const result = stamp("/proj/recipe.toml", h.io, { modulesRoot: "/proj/modules", frames: 16 });
    if (!result.ok) throw new Error(formatDiagnostics(result.diagnostics));
    const decoded = decode(result.bytes);
    if (!decoded.ok) throw new Error(`${name}: cart did not decode`);
    return {
      result,
      code: dec.decode(getChunk(decoded.cart, "CODE") as Uint8Array),
      gfx: getChunk(decoded.cart, "GFX ") as Uint8Array,
    };
  }

  const a = build("caves", CAVES, "gravity       = 0.42");
  const b = build("dungeon", DUNGEON, "gravity       = 0.75");

  it("compiles CODE that differs from the other cart's ONLY in the knob preamble", () => {
    const la = a.code.split("\n");
    const lb = b.code.split("\n");
    expect(la).toHaveLength(lb.length);

    // Line 1 is the banner, line 3 the engine marker, and everything from line 4
    // on is engine.js verbatim. ONE line may differ, and it is line 2.
    const differing = la.map((line, i) => (line === lb[i] ? -1 : i)).filter((i) => i >= 0);
    expect(differing).toEqual([1]);

    expect(la[0]).toBe(GENERATED_BANNER);
    expect(la[2]).toBe("// ---- engine: platformer@1.0.0 ----");
    expect(la.slice(3).join("\n")).toBe(lb.slice(3).join("\n"));
    expect(la.slice(3).join("\n")).toBe(ENGINE_JS);

    // And the one line that moved moved for the one reason it may: a knob.
    expect(la[1]).toContain("gravity: 27525 / 65536");
    expect(lb[1]).toContain("gravity: 49152 / 65536");
  });

  it("packs GFX chunks that differ, so the art reached the machine", () => {
    // Same length -- both packs fill cells 0..63 -- and different content. If
    // these were equal, the CODE test above would be measuring nothing: a swap
    // that changes no bytes is a swap that never happened.
    expect(b.gfx.length).toBe(a.gfx.length);
    expect([...b.gfx]).not.toEqual([...a.gfx]);

    // The flags block comes first and the sheet after it, and BOTH halves moved:
    // the pack's own flag bytes travel with its pixels.
    expect([...b.gfx.subarray(0, 64)]).not.toEqual([...a.gfx.subarray(0, 64)]);
    expect([...b.gfx.subarray(GFX_SHEET_OFFSET)]).not.toEqual([
      ...a.gfx.subarray(GFX_SHEET_OFFSET),
    ]);
  });

  it("produces a different cart id and a different proof chain", () => {
    // The chain is over the FRAMEBUFFER, so it moves only if the swap changed
    // what is on screen. Two packs whose bytes differ but that nothing draws
    // would share a chain, and this fixture's engine draws with its knobs.
    expect(b.result.id).not.toBe(a.result.id);
    expect(b.result.proof.chain).not.toBe(a.result.proof.chain);
    expect(a.result.proof.chain).toMatch(/^[0-9a-f]{64}$/);
  });

  it("records the swap in the rcpe chunk: one engine hash, two tileset hashes", () => {
    // The engine is the SAME module -- same content hash -- in both carts. That
    // is the claim "not one line of engine code changed", stated as a number a
    // registry could check rather than as a promise in a commit message.
    const chunkOf = (bytes: Uint8Array) => {
      const decoded = decode(bytes);
      if (!decoded.ok) throw new Error("cart did not decode");
      return parseRecipeChunk(getChunk(decoded.cart, "rcpe") as Uint8Array);
    };
    const ra = chunkOf(a.result.bytes);
    const rb = chunkOf(b.result.bytes);
    expect(ra?.engine.hash).toBe(rb?.engine.hash);
    expect(ra?.engine.ref).toBe("platformer@1.0.0");

    const tilesetOf = (c: typeof ra) => c?.modules.find((m) => m.kind === "tileset");
    expect(tilesetOf(ra)?.ref).toBe("caves@1.0.0");
    expect(tilesetOf(rb)?.ref).toBe("dungeon@1.0.0");
    expect(tilesetOf(ra)?.hash).not.toBe(tilesetOf(rb)?.hash);
  });
});

// ===========================================================================

/*
 * `indexes` -- THE ONE ADDITION M6 MAKES TO THE MANIFEST CONTRACT.
 *
 * It exists so an `int` knob can say what it is an index INTO, and `validate`
 * can bound it against the resolved pack's `base` and cell count instead of
 * against a `min`/`max` that cannot know how much art the recipe supplied. The
 * checking half is asserted in test/contract.test.ts, against a whole recipe.
 * These are the PARSING half, and the property that matters most is the last
 * one: the field is optional, so every manifest written before it existed is
 * read exactly as it was.
 */
describe("the `indexes` knob field", () => {
  const withIndexes = (body: string) =>
    parseManifest("/m/module.toml", `${ENGINE_TOML}\n[knobs.tile_floor]\n${body}`);

  it("is read onto the knob, and names the pack the knob indexes", () => {
    const r = withIndexes('type = "int"\nindexes = "tileset"\n');
    if (!r.ok) throw new Error(formatDiagnostics(r.diagnostics));
    expect(r.manifest.knobs.find((k) => k.name === "tile_floor")?.indexes).toBe("tileset");
  });

  it("is ABSENT on every knob that does not declare it, which is every old manifest", () => {
    // The compatibility claim, stated as an assertion rather than as a promise
    // in a comment: the fixture engine above predates the field entirely and
    // parses unchanged, with `indexes` undefined on all four of its knobs.
    const r = parseManifest("/m/module.toml", ENGINE_TOML);
    if (!r.ok) throw new Error(formatDiagnostics(r.diagnostics));
    expect(r.manifest.knobs).toHaveLength(4);
    expect(r.manifest.knobs.every((k) => k.indexes === undefined)).toBe(true);
  });

  it("refuses a kind that has no cells to index into", () => {
    const r = withIndexes('type = "int"\nindexes = "palette"\n');
    expect(r.ok).toBe(false);
    const d = r.diagnostics[0] as Diagnostic;
    expect(d.code).toBe("bad-manifest");
    expect(d.message).toBe(
      'knob `tile_floor` has indexes "palette", which is not one of "tileset", "spriteset".',
    );
    expect(d.suggestion).toContain('indexes = "tileset"');
  });

  it("refuses it on a knob that is not an `int`, because a sheet cell is whole", () => {
    const r = withIndexes('type = "fixed"\nindexes = "tileset"\n');
    expect(r.ok).toBe(false);
    const d = r.diagnostics[0] as Diagnostic;
    expect(d.code).toBe("bad-manifest");
    expect(d.message).toBe(
      "knob `tile_floor` is declared `fixed` and also indexes a tileset, and a sheet cell is a " +
        "whole number.",
    );
    expect(d.suggestion).toContain('Write  type = "int"');
  });
});

describe("an `int` knob's range is made of whole numbers", () => {
  it("refuses a fractional min, and offers the whole number that was meant", () => {
    // GAP 5. `min = 1.5` parsed, and then every number the author was shown was
    // a lie: the printed range, and the midpoint `suggestedValue` offers for an
    // unset knob, could both be values the knob's own type then refused.
    const r = parseManifest(
      "/m/module.toml",
      ENGINE_TOML.replace("min     = 0\nmax     = 30", "min     = 0.5\nmax     = 30"),
    );
    expect(r.ok).toBe(false);
    const d = r.diagnostics[0] as Diagnostic;
    expect(d.code).toBe("bad-manifest");
    expect(d.message).toBe(
      "knob `coyote_frames` is declared `int`, and its min is 0.5, which is not a whole number.",
    );
    expect(d.suggestion).toContain("Write  min = 1");
  });

  it("leaves a `fixed` knob's fractional range alone, which is what it is for", () => {
    // The negative control. `gravity` is `fixed` with min 0.0 and max 4.0, and
    // a check that refused those would have refused every engine in the repo.
    const r = parseManifest("/m/module.toml", ENGINE_TOML);
    if (!r.ok) throw new Error(formatDiagnostics(r.diagnostics));
    const gravity = r.manifest.knobs.find((k) => k.name === "gravity");
    expect(gravity?.min).toBe(0);
    expect(gravity?.max).toBe(4);
  });
});

// ===========================================================================

/*
 * `indexes` APPLIED: THE WHOLE PIPELINE, NOT THE PARSER.
 *
 * The block above asserts that the field is READ. This one asserts that it
 * BITES: a recipe naming a cell its pack does not have is refused, and the same
 * recipe naming one it does have stamps a cart. Both halves are needed, and the
 * second half is the one that keeps the check honest -- a validator that refuses
 * everything passes every test about refusal.
 *
 * The three knobs the fixture engine gains here are the three shapes
 * `modules/platformer` and `modules/topdown` are made of:
 *
 *   tile_floor       indexes a tileset, which sits at base 0;
 *   sprite_idle      indexes a spriteset, which sits at base 64 -- so a sprite
 *                    knob set to 3 is a TILE, and the player character is drawn
 *                    as a piece of scenery;
 *   sprite_offset_x  a pixel offset that shares the `sprite_` prefix, is
 *                    NEGATIVE, and is not annotated. It is the near miss the
 *                    field exists to be explicit about, and it is here as a
 *                    negative control: a check that bounded it against the
 *                    spriteset would refuse a correct manifest.
 */
describe("an annotated index knob is bounded by the pack, not by the byte", () => {
  /** A spriteset at base 64: sheet row 4, leaving rows 0..3 to the tileset. */
  const SPRITESET_TOML = `[module]
kind    = "spriteset"
name    = "hero"
version = "1.0.0"

[provides]
sprites = 32
base    = 64
`;

  const INDEXED_ENGINE = `${ENGINE_TOML}
[knobs.tile_floor]
type    = "int"
indexes = "tileset"
min     = 0
max     = 255
doc     = "Which cell of the tileset the floor is."

[knobs.sprite_idle]
type    = "int"
indexes = "spriteset"
min     = 0
max     = 255

[knobs.sprite_offset_x]
type    = "int"
default = -1
min     = -16
max     = 16
`;

  /** The fixture recipe with a spriteset added, and `tuning` appended. */
  function build(tuning: string) {
    return stampFixture({
      "/proj/modules/platformer/module.toml": INDEXED_ENGINE,
      "/proj/modules/hero/module.toml": SPRITESET_TOML,
      "/proj/recipe.toml": `${RECIPE.replace(
        'tileset = "caves@1.0.0"',
        'tileset   = "caves@1.0.0"\nspriteset = "hero@1.0.0"',
      )}${tuning}`,
    });
  }

  it("stamps a cart when every index names a cell its pack draws", () => {
    // `caves` declares 128 tiles at base 0; `hero` 32 sprites at base 64. Both
    // values below are inside their own pack and outside the other's, which is
    // what a correct recipe looks like.
    const { result } = build("tile_floor = 100\nsprite_idle = 70\n");
    if (!result.ok) throw new Error(formatDiagnostics(result.diagnostics));
    expect(result.diagnostics).toEqual([]);
    expect(result.proof.frames).toBe(24);
  });

  it("refuses a tile index past the end of the tileset", () => {
    const { result } = build("tile_floor = 200\nsprite_idle = 70\n");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(codes(result.diagnostics)).toEqual(["index-out-of-pack"]);
    const d = result.diagnostics[0] as Diagnostic;
    expect(d.message).toBe(
      "knob `tile_floor` is 200, and tileset `caves@1.0.0` fills sheet cells 0 .. 127.",
    );
    // The diagnostic points at the RECIPE line the author has to edit, not at
    // the manifest that declared the knob.
    expect(d.file).toBe("/proj/recipe.toml");
    expect(d.suggestion).toContain("Choose a number from 0 to 127");
  });

  it("refuses a sprite index that lands in the tileset's half of the sheet", () => {
    // `sprite_idle = 3` is the failure INTERFACE-NOTES.md finding 2 measured
    // against the real modules: inside 0 .. 255, inside the sheet, and drawn as
    // whatever the tileset put in cell 3.
    const { result } = build("tile_floor = 100\nsprite_idle = 3\n");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(codes(result.diagnostics)).toEqual(["index-out-of-pack"]);
    expect((result.diagnostics[0] as Diagnostic).message).toBe(
      "knob `sprite_idle` is 3, and spriteset `hero@1.0.0` fills sheet cells 64 .. 95.",
    );
  });

  it("leaves an unannotated near miss alone, negative value and all", () => {
    // THE NEGATIVE CONTROL. `sprite_offset_x` is a pixel offset wearing an
    // index's prefix. Bounded against `hero` it could never be satisfied -- the
    // pack starts at cell 64 and this knob's whole range is -16 .. 16 -- so a
    // check inferred from the name would refuse a correct engine outright.
    const { result } = build("tile_floor = 100\nsprite_idle = 70\nsprite_offset_x = -16\n");
    if (!result.ok) throw new Error(formatDiagnostics(result.diagnostics));
    expect(result.diagnostics).toEqual([]);
  });
});
