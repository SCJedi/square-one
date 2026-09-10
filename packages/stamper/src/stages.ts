/**
 * The seven stages. A recipe goes in one end; a proved cart comes out the other.
 *
 *   recipe.toml
 *       |
 *   [1] RESOLVE    name@version -> module dir -> bytes -> content hash
 *       |
 *   [2] MERGE      layer in declared order; later key wins
 *       |
 *   [3] BIND       knobs -> values; an unbound required knob is an error
 *       |
 *   [4] VALIDATE   interfaces, budgets, ABI minor, profile rules
 *       |
 *   [5] COMPILE    engine + knobs -> CODE source, canonical
 *       |
 *   [6] PACK       chunks -> bytes -> cart id
 *       |
 *   [7] PROVE      headless run, frame-hash chain
 *       v
 *   game.cart
 *
 * SEVEN PURE FUNCTIONS, NO SHARED MUTABLE STATE
 * ---------------------------------------------
 * Each takes the previous stage's output and returns a new value. Nothing is
 * threaded through a context object and nothing is written back into an input.
 * Two consequences, and both of them are the point:
 *
 *   - the build is reproducible, because there is no order-dependent state for
 *     a later stage to have perturbed;
 *   - every stage is independently testable, because constructing its input by
 *     hand is the same as receiving it from upstream.
 *
 * WHERE THE DIAGNOSTICS GO
 * ------------------------
 * A stage never throws for something an author can fix. It returns its output
 * with a `diagnostics` list attached, and the driver in index.ts stops at the
 * first stage that produced an error. That way a broken recipe reports
 * EVERYTHING that stage found rather than the first thing.
 *
 * FOUR WAYS TO BREAK A REPRODUCIBLE BUILD, AND WHERE EACH IS CLOSED
 * -----------------------------------------------------------------
 *   iteration order   every map is drained through an explicit sort before it
 *                     is serialised: `moduleHash`, `emitKnobs`, `buildRecipeChunk`.
 *   timestamps        nothing here reads a clock. Not the build time, not a
 *                     file's mtime -- `StamperIO` cannot even ask for one.
 *   absolute paths    a module is recorded as `name@version` plus a content
 *                     hash. `dir` exists for diagnostics and never reaches a
 *                     chunk. The `rcpe` chunk is checked against this by a test.
 *   float formatting  a `fixed` knob becomes a 16.16 INTEGER at bind time and is
 *                     emitted as `N / 65536`. Dividing by a power of two is
 *                     exact in IEEE doubles and identical on every engine, and
 *                     the emitted source contains no decimal string at all.
 */

import { fromFloat, rngCreate, rngNext, sha256Hex } from "@sq1/core";
import {
  cartIdOf,
  encode,
  encodeMeta,
  encodeUtf8,
  lintCartSource,
  MAX_CART_BYTES,
  SPEC_MAJOR,
  SPEC_MINOR,
} from "@sq1/cart";
import { decode } from "@sq1/cart";
import type { CartFile } from "@sq1/cart";
import {
  ChainHasher,
  createMachine,
  DATA_REGIONS,
  GFX_SHEET_OFFSET,
  HW_PALETTE,
  installCartData,
  loadCartBytes,
  planCartData,
} from "@sq1/runtime";
import type { MachineHooks } from "@sq1/runtime";

import { diag, nearest, type Diagnostic, type DiagnosticCode } from "./diagnostics";
import {
  camelCase,
  FILE_ROLES,
  MODULE_KINDS,
  parseManifest,
  valueFitsType,
  type Manifest,
  type ModuleKind,
  type ModuleRef,
  type KnobIndexKind,
  type KnobSpec,
  type KnobType,
  type Requirement,
} from "./manifest";
import { PROFILE, type Recipe, type RecipeModule } from "./recipe";
import { describeKind, formatValue, tableEntries, tableGet, type Pos, type TomlValue } from "./toml";

/**
 * How the stamper touches the world: three functions, all injected.
 *
 * Structurally a subset of the CLI's `CommandIO`, so `sq1 stamp` passes its own
 * `io` straight through and the whole stamper is driven in tests against a Map.
 * There is deliberately no `writeFile` here -- writing the cart is the caller's
 * decision, made only after `prove` has passed.
 */
export interface StamperIO {
  readFile(p: string): Uint8Array;
  exists(p: string): boolean;
  /** Entry names directly inside `p`. Used only to say what IS there when something is not. */
  readDir(p: string): string[];
}

/**
 * The highest ABI minor this stamper knows how to build against.
 *
 * A module declaring a higher one needs a runtime that does not exist yet, and
 * building the cart anyway would ship a game that faults on load.
 */
export const SUPPORTED_ABI_MINOR = 0;

/** How many frames `prove` runs by default (specification 9.2 says at least 600). */
export const DEFAULT_PROVE_FRAMES = 600;

/** The seed `prove` boots with, unless told otherwise. Fixed, so the chain is too. */
export const DEFAULT_PROVE_SEED = 1;

/** Bytes of replay input per frame: one button mask per player slot. */
const INPUT_BYTES = 4;

/** The six buttons a slot can hold: left, right, up, down, A, B. */
const BUTTON_MASK = 0x3f;

/** Forward slashes only, so a path reads the same in every message on every OS. */
function join(dir: string, file: string): string {
  return `${dir.replace(/[\\/]+$/, "")}/${file}`;
}

/**
 * UTF-8 bytes of a string that is known to be encodable.
 *
 * `encodeUtf8` returns null for a lone surrogate, which has no UTF-8 form and
 * must never be silently replaced. Nothing that reaches the calls below can
 * hold one: engine and manifest text arrives through `TextDecoder`, which
 * never emits an unpaired surrogate, and `parseRecipe` refuses a recipe string
 * containing one at the front door -- which is where a caller passing an
 * editor buffer to `stampSource` is caught. So this throws rather than
 * threading a null through three functions for a case that cannot arrive; if
 * it ever fires, the message says which string to look at.
 */
function utf8(s: string, what: string): Uint8Array {
  const bytes = encodeUtf8(s);
  if (bytes === null) {
    throw new Error(`${what} contains an unpaired surrogate, which has no UTF-8 encoding`);
  }
  return bytes;
}

/** Collects diagnostics without any stage having to carry an array around. */
class Sink {
  readonly items: Diagnostic[] = [];
  #errors = 0;

  error(code: DiagnosticCode, message: string, file: string, pos: Pos, suggestion?: string): void {
    this.#errors++;
    this.push("error", code, message, file, pos, suggestion);
  }

  warn(code: DiagnosticCode, message: string, file: string, pos: Pos, suggestion?: string): void {
    this.push("warning", code, message, file, pos, suggestion);
  }

  private push(
    severity: "error" | "warning",
    code: DiagnosticCode,
    message: string,
    file: string,
    pos: Pos,
    suggestion?: string,
  ): void {
    const init = { severity, code, message, file, line: pos.line, column: pos.column } as const;
    this.items.push(diag(suggestion === undefined ? init : { ...init, suggestion }));
  }

  add(ds: readonly Diagnostic[]): void {
    for (const d of ds) {
      if (d.severity === "error") this.#errors++;
      this.items.push(d);
    }
  }

  get failed(): boolean {
    return this.#errors > 0;
  }
}

// ===========================================================================
// [1] RESOLVE
// ===========================================================================

export interface ResolveOptions {
  /** The directory holding `<name>/module.toml`. Never recorded in the cart. */
  readonly modulesRoot: string;
}

export interface ResolvedModule {
  /** The kind the recipe asked for, which the manifest must agree with. */
  readonly slot: ModuleKind;
  readonly ref: ModuleRef;
  readonly manifest: Manifest;
  /** For diagnostics ONLY. Never hashed, never written into a chunk. */
  readonly dir: string;
  /** File name (relative to `dir`) -> bytes. Includes `module.toml` itself. */
  readonly files: ReadonlyMap<string, Uint8Array>;
  /** 64 lowercase hex. A function of the module's CONTENT and nothing else. */
  readonly hash: string;
  /** Where in the recipe this module was named, for a diagnostic about it. */
  readonly pos: Pos;
}

export interface ResolvedRecipe {
  readonly recipe: Recipe;
  readonly engine: ResolvedModule | null;
  /** `[modules]` in DECLARED order, which is the order they layer in. */
  readonly modules: readonly ResolvedModule[];
  readonly diagnostics: readonly Diagnostic[];
}

/**
 * A module's content hash: a function of its bytes, and of nothing else.
 *
 * The text hashed below contains the module's name, version and kind, then one
 * line per file with that file's own digest, WITH THE FILE NAMES SORTED. It
 * contains no directory, no module root, no timestamp and no iteration order --
 * so the same module resolves to the same hash from any checkout on any machine,
 * which is the whole reason a recipe may not name a module by path.
 *
 * `module.toml` is hashed like any other file, so editing a default or a
 * `requires` line changes the hash exactly as editing a sprite sheet does.
 */
export function moduleHash(
  name: string,
  version: string,
  kind: ModuleKind,
  files: ReadonlyMap<string, Uint8Array>,
): string {
  const lines = [`sq1-module 1`, `name ${name}`, `version ${version}`, `kind ${kind}`];
  for (const fileName of [...files.keys()].sort()) {
    lines.push(`file ${fileName} ${sha256Hex(files.get(fileName) as Uint8Array)}`);
  }
  return sha256Hex(utf8(lines.join("\n") + "\n", "a module hash line"));
}

/** What is actually under the module root, for a "no such module" message. */
function describeModules(io: StamperIO, root: string): string {
  let names: string[];
  try {
    names = io.readDir(root);
  } catch {
    return "(unreadable)";
  }
  const usable = [...names].sort();
  if (usable.length === 0) return "(nothing)";
  return usable.length > 10 ? `${usable.slice(0, 10).join(", ")}, and ${usable.length - 10} more` : usable.join(", ");
}

function resolveOne(
  s: Sink,
  io: StamperIO,
  opts: ResolveOptions,
  recipe: Recipe,
  want: RecipeModule,
): ResolvedModule | null {
  // The kind the RECIPE put it under. The manifest has to agree, and the
  // disagreement is the diagnostic below.
  const slot = want.kind;
  const dir = join(opts.modulesRoot, want.ref.name);
  const manifestPath = join(dir, "module.toml");

  if (!io.exists(manifestPath)) {
    s.error(
      "missing-module",
      `there is no module \`${want.ref.text}\`: ${manifestPath} is not there.`,
      recipe.file,
      want.pos,
      `The module root is ${opts.modulesRoot}, which holds: ${describeModules(io, opts.modulesRoot)}\n` +
        `Point --modules at another root, or add ${want.ref.name}/module.toml under this one.`,
    );
    return null;
  }

  const files = new Map<string, Uint8Array>();
  const manifestBytes = io.readFile(manifestPath);
  files.set("module.toml", manifestBytes);

  const decoded = new TextDecoder("utf-8", { fatal: false }).decode(manifestBytes);
  const parsed = parseManifest(manifestPath, decoded);
  if (!parsed.ok) {
    s.add(parsed.diagnostics);
    return null;
  }
  s.add(parsed.diagnostics.filter((d) => d.severity !== "error"));
  const manifest = parsed.manifest;

  if (manifest.name !== want.ref.name || manifest.version !== want.ref.version) {
    s.error(
      "module-version-mismatch",
      `${manifestPath} declares \`${manifest.name}@${manifest.version}\`, ` +
        `but this recipe asks for \`${want.ref.text}\`.`,
      recipe.file,
      want.pos,
      `Write  ${want.kind === "engine" ? "use" : want.kind} = "${manifest.name}@${manifest.version}"`,
    );
    return null;
  }

  if (manifest.kind !== slot) {
    s.error(
      "module-kind-mismatch",
      `\`${want.ref.text}\` is a ${manifest.kind} module, and this recipe uses it as a ${slot}.`,
      recipe.file,
      want.pos,
      slot === "engine"
        ? "[engine] use takes an engine module."
        : `Move it to  ${manifest.kind} = "${want.ref.text}"  in [modules], and set a real ` +
          `${slot} module here.`,
    );
    return null;
  }

  // The data files the manifest names, plus `engine.js` for an engine. Read in
  // a FIXED order -- the manifest's -- never a directory listing's, which
  // differs by filesystem.
  if (manifest.kind === "engine") {
    const enginePath = join(dir, "engine.js");
    if (!io.exists(enginePath)) {
      s.error(
        "missing-module-file",
        `engine \`${want.ref.text}\` has no engine.js, so there is no code to compile.`,
        manifestPath,
        { line: 1, column: 1 },
        `An engine module is a manifest and an engine.js beside it. Add ${enginePath}.`,
      );
      return null;
    }
    files.set("engine.js", io.readFile(enginePath));
  }

  if (manifest.dataFile !== null) {
    const path = join(dir, manifest.dataFile.name);
    if (!io.exists(path)) {
      s.error(
        "missing-module-file",
        `[provides] data names ${JSON.stringify(manifest.dataFile.name)}, which is not in this module.`,
        manifestPath,
        manifest.dataFile.pos,
        `${dir} holds: ${describeModules(io, dir)}`,
      );
      return null;
    }
    files.set(manifest.dataFile.name, io.readFile(path));
  }

  for (const role of [...manifest.files.keys()].sort()) {
    const declared = manifest.files.get(role) as { name: string; pos: Pos };
    const path = join(dir, declared.name);
    if (!io.exists(path)) {
      s.error(
        "missing-module-file",
        `[files] ${role} names ${JSON.stringify(declared.name)}, which is not in this module.`,
        manifestPath,
        declared.pos,
        `${dir} holds: ${describeModules(io, dir)}`,
      );
      return null;
    }
    files.set(declared.name, io.readFile(path));
  }

  return {
    slot,
    ref: want.ref,
    manifest,
    dir,
    files,
    hash: moduleHash(manifest.name, manifest.version, manifest.kind, files),
    pos: want.pos,
  };
}

/**
 * [1] RESOLVE: references to module directories to bytes to content hashes.
 *
 * The one stage that touches the world. Everything after it is a pure function
 * of what it returned, which is what makes stages 2 to 7 testable without a
 * filesystem at all.
 */
export function resolve(recipe: Recipe, io: StamperIO, opts: ResolveOptions): ResolvedRecipe {
  const s = new Sink();
  const engine = resolveOne(s, io, opts, recipe, recipe.engine);

  // ONE MODULE PER KIND IS SETTLED BEFORE THIS STAGE, and deliberately not here.
  // `[modules]` is a TOML table whose keys ARE the kinds, `parseToml` refuses a
  // repeated key as `malformed-toml` at line and column, and `parseRecipe` builds
  // this list one entry per surviving key -- so no parsed recipe can put two
  // modules of one kind in front of `resolve`. A `bad-recipe` guard here was
  // therefore unreachable from every input an author can write, and unreachable
  // code that reads like a check is worse than no check: it makes the rule look
  // enforced in two places when it is enforced in one. A caller hand-building a
  // `Recipe` in memory is a caller error rather than an author error, and this
  // package answers those the way `merge` does -- by throwing, not by inventing
  // a diagnostic about a file nobody wrote. See the recipe-slot test in
  // test/contract.test.ts, which pins the `malformed-toml` that really happens.
  const modules: ResolvedModule[] = [];
  for (const m of recipe.modules) {
    const resolved = resolveOne(s, io, opts, recipe, m);
    if (resolved !== null) modules.push(resolved);
  }

  return { recipe, engine, modules, diagnostics: s.items };
}

// ===========================================================================
// [2] MERGE
// ===========================================================================

/** One layer's contribution of a knob VALUE, with where it came from. */
export interface TuningValue {
  readonly name: string;
  readonly value: TomlValue;
  /** The file an author edits to change it. */
  readonly file: string;
  readonly pos: Pos;
  /** `platformer@1.0.0`, or `recipe` when the recipe's own [tuning] set it. */
  readonly from: string;
}

/** One knob DECLARATION, with the module that declared it. */
export interface MergedKnob {
  readonly spec: KnobSpec;
  readonly module: ResolvedModule;
}

/** One asset chunk contributed by a module. */
export interface MergedAsset {
  readonly chunkType: string;
  readonly role: string;
  readonly bytes: Uint8Array;
  readonly module: ResolvedModule;
}

// --- the art packs, merged into one sheet ---------------------------------

/** The console's sprite sheet: 256 cells of 8x8 at 4bpp, 128 pixels per row. */
export const SHEET_BYTES = 8192;
/** One flags byte per sheet cell. */
export const SHEET_CELLS = 256;
/** 32 bytes per 8x8 cell at 4bpp. */
export const CELL_BYTES = 32;
/** A sheet row is 16 cells: 8 pixel rows of 64 bytes. */
export const SHEET_ROW_BYTES = 512;
/** 16 live palette slots, each naming one of the console's 64 hardware colours. */
export const PALETTE_SLOTS = 16;
/** The hardware palette has 64 entries, so a live slot names 0..63. */
const HW_COLORS = 64;

/**
 * Where a cart's static data chunks land in RAM at boot (specification 3.3:
 * "A cart's static data initializes 0x2000 through 0x77FF at boot; code is the
 * cart payload and is budgeted separately").
 *
 * DERIVED FROM THE RUNTIME'S OWN `DATA_REGIONS`, and never written out again
 * here. A second copy of this table is a build tool that packs a cart the
 * player will refuse, and the two would drift the first time a region moved --
 * so the stamper reads the map from the thing that performs the installation.
 *
 * The player installs these AFTER RAM is zeroed and after its own boot defaults,
 * and BEFORE the cart's own `boot()` runs. A chunk shorter than its region fills
 * from the start and leaves the rest as `boot` left it, which is why the chunks
 * this stage builds for zeroed regions are trimmed of their trailing zeroes: the
 * bytes are already there. `PAL ` is NOT trimmed, because boot leaves the
 * hardware palette and an identity live palette there rather than zeroes.
 *
 * A chunk LONGER than its region is a load error rather than a truncation, so
 * `pack` refuses it here -- at stamp time, where the author is looking -- rather
 * than shipping a cart that will not open.
 *
 * `address` is the LOWEST address the chunk reaches, for a diagnostic to name.
 * `GFX ` reaches two spans and does not carry them in address order; cart-data.ts
 * says why.
 */
export const CHUNK_REGIONS: Readonly<Record<string, { address: number; bytes: number }>> =
  Object.freeze(
    Object.fromEntries(
      DATA_REGIONS.map((r) => {
        let address = Number.MAX_SAFE_INTEGER;
        for (const seg of r.segments) address = Math.min(address, seg.addr);
        return [r.chunk, Object.freeze({ address, bytes: r.max })] as const;
      }),
    ),
  );

/**
 * Where the SHEET half of a `GFX ` chunk starts: after the 256 flag bytes.
 *
 * Re-exported from the runtime rather than restated, for the same reason
 * `CHUNK_REGIONS` is derived: the chunk's layout is one fact, and the half of
 * the system that installs it owns it. The flags come FIRST inside the chunk
 * even though SPRITES is the lower address; cart-data.ts says why.
 */
export { GFX_SHEET_OFFSET };

/**
 * The merged art packs, as BYTES bound for real cart chunks.
 *
 * Art is data, and data belongs in a chunk the player installs into RAM -- not
 * in the cart's source. Carrying a sprite sheet as a string literal in CODE
 * would spend the cart's byte budget twice over (two hex characters per byte)
 * and put a decoder in every engine, to reach a region the machine already
 * initializes for free.
 */
export interface MergedArt {
  /** The 256 flag bytes then the sheet, trimmed of trailing zeroes. Null when no pack drew. */
  readonly gfx: Uint8Array | null;
  /** The hardware palette then the 16 live slots, for `PAL `. Null when no pack chose any. */
  readonly palette: Uint8Array | null;
}

export interface MergedSpec {
  readonly recipe: Recipe;
  readonly engine: ResolvedModule;
  /** Engine first, then `[modules]` in declared order. The layering order. */
  readonly layers: readonly ResolvedModule[];
  /** By knob name; a later layer's declaration wins. */
  readonly knobs: ReadonlyMap<string, MergedKnob>;
  /** By knob name; a later layer's value wins, and the recipe wins over all of them. */
  readonly values: ReadonlyMap<string, TuningValue>;
  /** By cart chunk type, so two tilesets cannot both claim "GFX ". */
  readonly assets: ReadonlyMap<string, MergedAsset>;
  /** Every art pack's data, composed into one sheet, one flags block and one palette. */
  readonly art: MergedArt;
  /** Every module present, by kind, for checking `requires` against. */
  readonly byKind: ReadonlyMap<ModuleKind, ResolvedModule>;
  /** Every requirement any layer declared, paired with the layer that declared it. */
  readonly requires: readonly { req: Requirement; module: ResolvedModule }[];
  /** The highest ABI minor any layer asks for. */
  readonly abiMinor: number;
  readonly diagnostics: readonly Diagnostic[];
}

/**
 * [2] MERGE: layer in declared order, later key wins.
 *
 * Exactly as CSS and container images do it (specification 8.2), and for the
 * same reason: a hundred carts using one tileset should store it once and ship
 * only their diffs. The order is engine, then `[modules]` in the order the
 * recipe writes them, then the recipe's own `[tuning]` last -- so a cart's own
 * tuning always beats a tuning module's, and a tuning module later in the list
 * always beats one earlier.
 *
 * Reordering two lines in `[modules]` is therefore a real edit that can change
 * the cart. That is the declared-order rule working, not a bug: it is what lets
 * an author put a "floaty jump" pack after a "heavy" one and get floaty.
 *
 * @throws when `resolved.engine` is null. That is a CALLER error, not an author
 * error: `resolve` already reported the missing engine as a diagnostic, and a
 * driver that ran this stage anyway has skipped the check every stage after it
 * also depends on. Nothing an author types reaches here.
 */
export function merge(resolved: ResolvedRecipe): MergedSpec {
  const s = new Sink();
  const recipe = resolved.recipe;
  const engine = resolved.engine;
  if (engine === null) {
    throw new Error("merge: the engine did not resolve; stop at the diagnostics resolve returned");
  }
  const layers: ResolvedModule[] = [engine, ...resolved.modules];

  const knobs = new Map<string, MergedKnob>();
  const values = new Map<string, TuningValue>();
  const assets = new Map<string, MergedAsset>();
  const byKind = new Map<ModuleKind, ResolvedModule>();
  const requires: { req: Requirement; module: ResolvedModule }[] = [];
  let abiMinor = 0;

  for (const layer of layers) {
    byKind.set(layer.slot, layer);
    abiMinor = Math.max(abiMinor, layer.manifest.abiMinor);

    for (const spec of layer.manifest.knobs) {
      const already = knobs.get(spec.name);
      knobs.set(
        spec.name,
        already === undefined ? { spec, module: layer } : redeclare(s, already, spec, layer),
      );
    }
    for (const req of layer.manifest.requires) requires.push({ req, module: layer });

    if (layer.manifest.tuning !== null) {
      for (const e of tableEntries(layer.manifest.tuning)) {
        values.set(e.key, {
          name: e.key,
          value: e.value,
          file: layer.manifest.file,
          pos: e.keyPos,
          from: layer.ref.text,
        });
      }
    }

    for (const role of [...layer.manifest.files.keys()].sort()) {
      const declared = layer.manifest.files.get(role) as { name: string; pos: Pos };
      const chunkType = FILE_ROLES[role] as string;
      const bytes = layer.files.get(declared.name);
      if (bytes === undefined) continue; // resolve already refused this module
      const previous = assets.get(chunkType);
      if (previous !== undefined) {
        s.warn(
          "bad-recipe",
          `\`${layer.ref.text}\` replaces the ${role} data \`${previous.module.ref.text}\` supplied; ` +
            `a cart has one ${chunkType.trim()} chunk.`,
          recipe.file,
          layer.pos,
          "Later modules win. Reorder [modules] if that is the wrong way round.",
        );
      }
      assets.set(chunkType, { chunkType, role, bytes, module: layer });
    }
  }

  // The art packs compose into ONE `GFX ` chunk, which therefore lands last and
  // wins over any `[files] gfx` a module supplied by hand -- with a warning,
  // because two things claiming one chunk is worth saying out loud.
  const art = mergeArt(s, recipe, layers);
  if (art.gfx !== null) {
    const previous = assets.get("GFX ");
    const drew = layers.filter((l) => l.manifest.dataFile !== null);
    if (previous !== undefined) {
      s.warn(
        "bad-recipe",
        `the merged art packs replace the gfx data \`${previous.module.ref.text}\` supplied ` +
          `through [files]; a cart has one GFX chunk.`,
        recipe.file,
        previous.module.pos,
        "Ship the sheet through [provides] data on an art pack, or through [files] gfx -- not both.",
      );
    }
    assets.set("GFX ", {
      chunkType: "GFX ",
      role: "gfx",
      bytes: art.gfx,
      module: drew[drew.length - 1] as ResolvedModule,
    });
  }

  // A palette pack's colours become the `PAL ` chunk, which the player installs
  // over PALETTE_HW and PALETTE_LIVE. There is no `[files] pal` role to collide
  // with: a palette is chosen in a manifest's `[provides] entries`, never
  // shipped as a file, because sixteen numbers a reader can see beat sixteen
  // bytes a reader cannot.
  if (art.palette !== null) {
    const chose = layers.filter((l) => l.manifest.provides !== null && tableGet(l.manifest.provides, "entries") !== undefined);
    assets.set("PAL ", {
      chunkType: "PAL ",
      role: "pal",
      bytes: art.palette,
      module: chose[chose.length - 1] as ResolvedModule,
    });
  }

  // The recipe's own [tuning] is the last layer, always.
  for (const t of recipe.tuning) {
    values.set(t.name, {
      name: t.name,
      value: t.value,
      file: recipe.file,
      pos: t.pos,
      from: "recipe",
    });
  }

  return {
    recipe,
    engine,
    layers,
    knobs,
    values,
    assets,
    art,
    byKind,
    requires,
    abiMinor,
    diagnostics: s.items,
  };
}

/**
 * A knob DECLARED twice, by two layers.
 *
 * LATER-WINS IS THE RULE FOR VALUES, NOT FOR DECLARATIONS, and the difference
 * is the whole of this function. A recipe's `[tuning]` beating a tuning module's
 * `gravity = 0.30` is the layering system working. An art pack's
 * `[knobs.gravity] type = "int"` REPLACING the engine's `fixed` declaration is
 * not layering at all: the engine's arithmetic was written against a 16.16
 * fraction, the preamble would hand it a bare `3`, and the cart builds, proves a
 * 600-frame chain and is wrong by four orders of magnitude with nothing said.
 * That is what `knobs.set(name, ...)` per layer used to do.
 *
 * THE RULE, and it is a decision rather than a discovery, so here is the case:
 *
 *   A knob's TYPE belongs to the layer that declared it first, because the type
 *   is not a fact about the number -- it is the calling convention between the
 *   preamble and the code that reads `KNOB.gravity`. Only the module carrying
 *   that code can know it. So a type change is an ERROR, always.
 *
 *   A knob's RANGE and DEFAULT may be restated by a later layer, because both
 *   are editorial: "in this game gravity is never above 1.0, and starts at 0.6"
 *   is exactly the sentence a `tuning` module exists to say. But a restatement
 *   may only NARROW. A later layer widening a bound would let a recipe set a
 *   value the declaring engine said it could not survive, which is the same
 *   silent-override failure one field along -- so the narrower bound is kept and
 *   the widening is reported as a warning naming both numbers.
 *
 * The first declarer also stays the knob's OWNER for diagnostics, so an unbound
 * required knob still reads "engine `platformer@1.0.0` requires knob ...": the
 * module that needs the number is the one an author has to satisfy.
 *
 * The alternative rule -- a later layer may replace a declaration wholesale, as
 * long as the type matches -- was rejected because it makes a knob's range a
 * property of `[modules]` ordering, and an author reading the engine's manifest
 * would be reading a range no longer in force with nothing on screen saying so.
 */
function redeclare(
  s: Sink,
  first: MergedKnob,
  later: KnobSpec,
  layer: ResolvedModule,
): MergedKnob {
  const name = first.spec.name;
  const owner = `${first.module.slot} \`${first.module.ref.text}\``;

  if (later.type !== first.spec.type) {
    s.error(
      "knob-redeclared",
      `\`${layer.ref.text}\` redeclares knob \`${name}\` as \`${later.type}\`, and ${owner} ` +
        `declares it \`${first.spec.type}\`.`,
      layer.manifest.file,
      later.pos,
      `A knob's type is how its value reaches the engine, not a fact about the number: a ` +
        `\`fixed\` knob arrives as N / 65536 and an \`int\` as the number itself, so an engine ` +
        `reading one where the cart wrote the other is wrong by 65536.\n` +
        `Delete [knobs.${name}] from ${layer.manifest.file}, or set the value in [tuning] -- a ` +
        `later layer may narrow a knob's range or change its default, never its type.`,
    );
    return first;
  }

  // Same type: narrow. `undefined` on either side means "no bound from there".
  const narrowed = (
    a: number | undefined,
    b: number | undefined,
    pick: (x: number, y: number) => number,
  ): number | undefined => (a === undefined ? b : b === undefined ? a : pick(a, b));

  const min = narrowed(first.spec.min, later.min, Math.max);
  const max = narrowed(first.spec.max, later.max, Math.min);

  for (const bound of ["min", "max"] as const) {
    const was = bound === "min" ? first.spec.min : first.spec.max;
    const now = bound === "min" ? later.min : later.max;
    if (was === undefined || now === undefined) continue;
    const widens = bound === "min" ? now < was : now > was;
    if (!widens) continue;
    s.warn(
      "knob-redeclared",
      `\`${layer.ref.text}\` widens knob \`${name}\`'s ${bound} to ` +
        `${showNumber(now, later.type)}, and ${owner} declares ${bound} ` +
        `${showNumber(was, first.spec.type)}. The narrower bound is kept.`,
      layer.manifest.file,
      later.pos,
      `A later layer may tighten a range and may not loosen one: the module that declared the ` +
        `knob is the one whose code has to survive the value.`,
    );
  }

  if (min !== undefined && max !== undefined && min > max) {
    s.error(
      "knob-redeclared",
      `\`${layer.ref.text}\` and ${owner} declare knob \`${name}\` over ranges that do not ` +
        `overlap: ${rangeText(later)} against ${rangeText(first.spec)}, so no value can ` +
        `satisfy both.`,
      layer.manifest.file,
      later.pos,
      `Widen [knobs.${name}] in ${layer.manifest.file} until it overlaps ${rangeText(first.spec)}, ` +
        `or remove it and set the value in [tuning].`,
    );
    return first;
  }

  // WHOEVER SUPPLIED THE DEFAULT IN FORCE OWNS THE POSITION. `bind` reports a
  // default that fails its own range against `spec.pos` in `module`'s manifest,
  // so a knob narrowed by a pack whose default no longer fits has to point at
  // THAT pack's line -- not at the engine's, which is correct and unhelpful.
  // The other use of `module` is the unbound-knob message, and a knob with a
  // default is never unbound, so the two cases cannot collide.
  const fromLater = later.default !== undefined;
  const ownerModule = fromLater ? layer : first.module;
  const ownerPos = fromLater ? later.pos : first.spec.pos;
  const spec: {
    name: string;
    type: KnobType;
    default?: TomlValue;
    min?: number;
    max?: number;
    doc?: string;
    indexes?: KnobIndexKind;
    pos: Pos;
  } = { name, type: first.spec.type, pos: ownerPos };
  const def = later.default ?? first.spec.default;
  if (def !== undefined) spec.default = def;
  if (min !== undefined) spec.min = min;
  if (max !== undefined) spec.max = max;
  const doc = later.doc ?? first.spec.doc;
  if (doc !== undefined) spec.doc = doc;
  const indexes = later.indexes ?? first.spec.indexes;
  if (indexes !== undefined) spec.indexes = indexes;
  return { spec, module: ownerModule };
}

/** A number from a module's `[provides]`, or null when it is absent or not a number. */
function providedNumber(m: ResolvedModule, key: string): number | null {
  if (m.manifest.provides === null) return null;
  const v = tableGet(m.manifest.provides, key)?.value;
  if (v === undefined || (v.kind !== "integer" && v.kind !== "float")) return null;
  return v.value;
}

/**
 * Compose every art pack into one sprite sheet, one flags block and one live
 * palette.
 *
 * WHAT A PACK DECLARES
 * --------------------
 *     [provides]
 *     tiles = 64            (or `sprites`, or `cells`) how many 8x8 cells it has
 *     base  = 0             the SHEET CELL it starts at
 *     data  = "tiles.bin"   pixels then flags, in that order
 *
 * and a palette pack declares `entries = [...]`, up to 16 hardware colours.
 *
 * A DATA FILE IS `cells * 32` PIXEL BYTES FOLLOWED BY `cells` FLAG BYTES. The
 * pixels are in the console's own sheet layout -- 128 pixels per row at 4bpp,
 * EVEN x in the low nibble -- so a pack is a contiguous prefix of a sheet and
 * placing it is a copy rather than a re-encoding.
 *
 * WHY `base` IS A CELL AND NOT A BYTE OFFSET
 * ------------------------------------------
 * The sheet is ONE 128-pixel-wide picture, so cell 64 is the start of sheet row
 * 4 -- pixel row 32, byte offset 32 * 64 = 2048 -- and not byte 64 * 32 by
 * accident of both being 2048. They agree only when `base` is a multiple of 16.
 * The copy below is written per cell so a pack starting mid-row lands where it
 * says it does; getting this wrong is the classic art-pack bug and it looks
 * like a game whose tiles are also its characters.
 *
 * WHERE THE RESULT GOES
 * ---------------------
 * Into the `GFX ` chunk, which the player installs across SPRITE_FLAGS and
 * SPRITES before the cart's own `boot()` runs. Art is data; it belongs in a
 * chunk, not in the cart's source. THE FLAGS COME FIRST INSIDE THE CHUNK: see
 * `GFX_SHEET_OFFSET`.
 *
 * AND THE PALETTE GOES INTO `PAL `, WHICH IS WHY IT IS 208 BYTES AND NOT 16.
 * PALETTE_LIVE is at 0x20C0 and PALETTE_HW is the 192 bytes immediately below
 * it, so a chunk that fills its region from the start has to carry the hardware
 * palette to reach the live slots. That is a cost worth paying rather than a
 * problem worked around: sixteen live slots that index a hardware palette the
 * cart did not choose are sixteen colours that mean whatever the player says
 * they mean, and a cart that carries both looks like itself everywhere. The
 * hardware half is the console's own reference palette unless a pack overrides
 * it, which nothing does yet.
 */
function mergeArt(s: Sink, recipe: Recipe, layers: readonly ResolvedModule[]): MergedArt {
  const sheet = new Uint8Array(SHEET_BYTES);
  const flags = new Uint8Array(SHEET_CELLS);
  // The whole `PAL ` region: the hardware palette, then the live slots. The
  // hardware half starts as the console's reference palette, so a cart that
  // only chooses live colours still carries a table its slots actually index.
  const palette = new Uint8Array(HW_PALETTE.length + PALETTE_SLOTS);
  palette.set(HW_PALETTE, 0);
  const live = palette.subarray(HW_PALETTE.length);
  /** Which cell each pack claimed, so an overlap can name both of them. */
  const owner = new Map<number, ResolvedModule>();
  let usedCells = 0;
  let havePixels = false;
  let havePalette = false;

  for (const layer of layers) {
    const provides = layer.manifest.provides;

    // --- a palette pack -------------------------------------------------
    if (provides !== null) {
      const entries = tableGet(provides, "entries")?.value;
      if (entries !== undefined) {
        if (entries.kind !== "array") {
          s.error(
            "bad-manifest",
            "[provides] `entries` must be an array of hardware colour numbers.",
            layer.manifest.file,
            entries.pos,
          );
        } else if (entries.items.length > PALETTE_SLOTS) {
          s.error(
            "bad-manifest",
            `[provides] entries has ${entries.items.length} colours, and the console has ` +
              `${PALETTE_SLOTS} live slots.`,
            layer.manifest.file,
            entries.pos,
          );
        } else {
          let bad = false;
          for (let i = 0; i < entries.items.length; i++) {
            const item = entries.items[i] as TomlValue;
            if (item.kind !== "integer" || item.value < 0 || item.value >= HW_COLORS) {
              s.error(
                "bad-manifest",
                `[provides] entries[${i}] is ${formatValue(item)}; a live slot names one of the ` +
                  `console's ${HW_COLORS} hardware colours, 0 to ${HW_COLORS - 1}.`,
                layer.manifest.file,
                item.pos,
              );
              bad = true;
              continue;
            }
            live[i] = item.value;
          }
          // A pack that named fewer than sixteen colours leaves the rest of the
          // live table at hardware colour 0. The alternative -- leaving them at
          // the identity the machine boots with -- would mean a cart's unnamed
          // slots showed a colour nobody chose, and it cannot be expressed in a
          // chunk that fills its region from the start anyway.
          if (!bad) havePalette = true;
        }
      }
    }

    // --- a pack with sheet data ------------------------------------------
    if (layer.manifest.dataFile === null) continue;
    const bytes = layer.files.get(layer.manifest.dataFile.name);
    if (bytes === undefined) continue; // resolve already refused this module

    const declared =
      providedNumber(layer, "tiles") ??
      providedNumber(layer, "sprites") ??
      providedNumber(layer, "cells");
    // With no count declared, the file's own length says how many cells it has:
    // 33 bytes each, 32 of pixels and one of flags.
    const cells = declared ?? Math.floor(bytes.length / (CELL_BYTES + 1));
    const base = providedNumber(layer, "base") ?? 0;

    if (!Number.isInteger(cells) || cells <= 0) {
      s.error(
        "bad-manifest",
        `\`${layer.ref.text}\` declares ${cells} cells, which is not a count.`,
        layer.manifest.file,
        layer.manifest.dataFile.pos,
      );
      continue;
    }
    if (!Number.isInteger(base) || base < 0 || base + cells > SHEET_CELLS) {
      s.error(
        "bad-manifest",
        `\`${layer.ref.text}\` places ${cells} cells at base ${base}, which runs past the ` +
          `sheet's ${SHEET_CELLS} cells.`,
        layer.manifest.file,
        layer.manifest.dataFile.pos,
        `Lower [provides] base, or ship fewer cells: base + cells must be at most ${SHEET_CELLS}.`,
      );
      continue;
    }
    // THE FILE IS PRESENT AND THE COUNT IS WHAT IS WRONG, so this is not a
    // `missing-module-file`: it used to be, and an author told their data file
    // was missing went looking for a file that was sitting right there. The
    // manifest claims `tiles = 64` and the bytes say otherwise; one of the two
    // is a typo and the message has to name both so the author can see which.
    const want = cells * (CELL_BYTES + 1);
    if (bytes.length !== want) {
      s.error(
        "data-size-mismatch",
        `${layer.manifest.dataFile.name} is ${bytes.length} bytes, and ${cells} cells is ` +
          `${want}: ${cells * CELL_BYTES} of pixels then ${cells} of flags.`,
        layer.manifest.file,
        layer.manifest.dataFile.pos,
        declared === null
          ? `\`${layer.ref.text}\` declares no cell count, so ${cells} was read from the file's ` +
            `own length and ${bytes.length - want} bytes are left over. Regenerate ` +
            `${layer.manifest.dataFile.name}, or state the count in [provides].`
          : `\`${layer.ref.text}\` declares ${cells} cells. Regenerate ` +
            `${layer.manifest.dataFile.name}, or correct the count in [provides].`,
      );
      continue;
    }

    for (let i = 0; i < cells; i++) {
      const dst = base + i;
      const previous = owner.get(dst);
      if (previous !== undefined && previous !== layer) {
        // A WARNING, ON PURPOSE -- and the second sentence is why it is not a
        // cosmetic one. Layers merge in declared order and later keys win
        // (specification 8.2), so overriding one pack's cells with another's is
        // a thing an author does on purpose and a refusal here would break it.
        // But "warning" with no consequence named reads as tidiness, and the
        // consequence is total: the earlier pack's art for this cell is NOT IN
        // THE CART. Nothing can draw it, at any index, ever. Say so.
        s.warn(
          "bad-recipe",
          `\`${layer.ref.text}\` draws over sheet cell ${dst}, which \`${previous.ref.text}\` ` +
            `already filled. \`${previous.ref.text}\`'s art for that cell is not in this cart ` +
            `at all -- nothing can draw it.`,
          recipe.file,
          layer.pos,
          "Later modules win. Give one pack a different [provides] base, or reorder [modules].",
        );
      }
      owner.set(dst, layer);

      const srcOff = (i >> 4) * SHEET_ROW_BYTES + (i & 15) * 4;
      const dstOff = (dst >> 4) * SHEET_ROW_BYTES + (dst & 15) * 4;
      for (let row = 0; row < 8; row++) {
        sheet.set(bytes.subarray(srcOff + row * 64, srcOff + row * 64 + 4), dstOff + row * 64);
      }
      flags[dst] = bytes[cells * CELL_BYTES + i] as number;
    }

    havePixels = true;
    usedCells = Math.max(usedCells, base + cells);
  }

  if (!havePixels) {
    return { gfx: null, palette: havePalette ? palette : null };
  }

  // One chunk: THE 256 FLAG BYTES, THEN THE SHEET. The fixed-size half goes
  // first so the split is a constant rather than a header, and so the half that
  // varies -- the sheet -- sits at the end where its trailing zeroes can be
  // trimmed off. A pack that fills 96 of the 256 cells therefore ships 256
  // flag bytes and 3,072 of pixels, not 3,072 of pixels, 5,120 of nothing, and
  // 96 flag bytes.
  const gfx = new Uint8Array(SHEET_CELLS + SHEET_BYTES);
  gfx.set(flags.subarray(0, usedCells), 0);
  gfx.set(sheet, GFX_SHEET_OFFSET);
  return { gfx: trimTrailingZeroes(gfx), palette: havePalette ? palette : null };
}

/**
 * A view of `bytes` with its trailing zeroes dropped.
 *
 * Safe for a region the machine ZEROES at boot -- `GFX `, `MAP `, `SFX `,
 * `MUS `, `DATA` -- because a short chunk fills from the start and the player
 * leaves the rest of the region as it found it, so a trimmed chunk and its
 * full-length original install to the same RAM. An all-zero block trims to
 * nothing, which is the correct chunk for "this pack drew nothing".
 *
 * NOT safe for `PAL `. Boot leaves the hardware palette and an identity live
 * palette at 0x2000, so a trimmed palette chunk would leave the tail of the
 * live table at identity rather than at the zeroes that were trimmed, and a
 * cart whose last colours happened to be hardware colour 0 would render them as
 * whatever the identity says. `mergeArt` ships the palette untrimmed.
 */
export function trimTrailingZeroes(bytes: Uint8Array): Uint8Array {
  let end = bytes.length;
  while (end > 0 && bytes[end - 1] === 0) end--;
  return bytes.subarray(0, end);
}

// ===========================================================================
// [3] BIND
// ===========================================================================

export interface BoundKnob {
  /** As the manifest declares it: snake_case. */
  readonly name: string;
  /** As the engine sees it on `KNOB`: camelCase. */
  readonly jsName: string;
  readonly type: KnobType;
  /**
   * The value, as an INTEGER: 16.16 for `fixed`, the number itself for `int`,
   * 0 or 1 for `bool`. There is no float anywhere downstream of here.
   */
  readonly raw: number;
  /** How it is written into the preamble: `27524 / 65536`, `6`, `true`. */
  readonly literal: string;
  /** Where the value came from, for the `rcpe` chunk and for a message. */
  readonly from: string;
}

export interface BoundSpec {
  readonly merged: MergedSpec;
  /** Sorted by knob name. Sorted, because it is about to be serialised. */
  readonly knobs: readonly BoundKnob[];
  readonly diagnostics: readonly Diagnostic[];
}

/** A number written the way a knob of this type is written, for messages. */
function showNumber(n: number, type: KnobType): string {
  if (type !== "fixed") return String(n);
  return Number.isInteger(n) ? `${n}.0` : String(n);
}

/** The `# -8.0 .. 0.0, upward speed of a jump` tail of an `Add:` suggestion. */
function knobComment(spec: KnobSpec): string {
  const bits: string[] = [];
  if (spec.min !== undefined && spec.max !== undefined) {
    bits.push(`${showNumber(spec.min, spec.type)} .. ${showNumber(spec.max, spec.type)}`);
  } else if (spec.min !== undefined) {
    bits.push(`at least ${showNumber(spec.min, spec.type)}`);
  } else if (spec.max !== undefined) {
    bits.push(`at most ${showNumber(spec.max, spec.type)}`);
  }
  // The FIRST SENTENCE of the doc, not all of it. A knob's doc is often a
  // paragraph -- what the number does, what it costs, what players call the
  // version with it set wrong -- and a paste-ready line has to stay one line.
  // The whole doc still appears on a range error, where there is room for it.
  if (spec.doc !== undefined) {
    const first = /^(.*?)\.(\s|$)/.exec(spec.doc);
    bits.push((first === null ? spec.doc : (first[1] as string)).trim());
  }
  return bits.length === 0 ? "" : `   # ${bits.join(", ")}`;
}

/** A value to put in front of an author who has to supply one. */
function suggestedValue(spec: KnobSpec): string {
  if (spec.type === "bool") return "false";
  if (spec.min !== undefined && spec.max !== undefined) {
    const mid = (spec.min + spec.max) / 2;
    if (spec.type === "int") return String(Math.round(mid));
    // Two decimals: enough to be a real starting value, few enough to read.
    return showNumber(Math.round(mid * 100) / 100, "fixed");
  }
  if (spec.min !== undefined) return showNumber(spec.min, spec.type);
  if (spec.max !== undefined) return showNumber(spec.max, spec.type);
  return spec.type === "int" ? "0" : "0.0";
}

/**
 * [3] BIND: knobs to values. An unbound REQUIRED knob is an error.
 *
 * `fixed` values become 16.16 integers HERE, once, through `@sq1/core`'s own
 * `fromFloat` -- the console's normative float-to-fixed conversion, floor and
 * saturating. Doing the conversion at bind time rather than in the emitter is
 * what removes decimal strings from the build entirely: from this point on a
 * knob is an integer, and integers serialise the same way everywhere.
 */
export function bind(merged: MergedSpec): BoundSpec {
  const s = new Sink();
  const recipe = merged.recipe;
  const bound: BoundKnob[] = [];
  /** Required knobs nobody set, gathered so they report as one block per module. */
  const unbound: { spec: KnobSpec; module: ResolvedModule }[] = [];

  // Values set for a knob nobody declared. Caught here rather than ignored: a
  // misspelt knob in [tuning] is silently no tuning at all, which is exactly
  // the failure the recipe format exists to make impossible.
  for (const [name, value] of merged.values) {
    if (merged.knobs.has(name)) continue;
    const known = [...merged.knobs.keys()].sort();
    const guess = nearest(name, known);
    s.error(
      "unknown-knob",
      `no module in this recipe declares a knob \`${name}\`.`,
      value.file,
      value.pos,
      guess === null
        ? known.length === 0
          ? "This recipe's modules declare no knobs at all."
          : `The knobs on offer are: ${known.join(", ")}`
        : `Did you mean \`${guess}\`?\n` + `The knobs on offer are: ${known.join(", ")}`,
    );
  }

  for (const name of [...merged.knobs.keys()].sort()) {
    const { spec, module } = merged.knobs.get(name) as MergedKnob;
    const set = merged.values.get(name);

    let value: TomlValue | undefined = set?.value;
    let from = set === undefined ? "" : set.from;
    let file = set === undefined ? recipe.file : set.file;
    let pos: Pos = set === undefined ? recipe.tuningPos : set.pos;

    if (value === undefined) {
      if (spec.default === undefined) {
        // Collected, not reported one at a time. An engine with nineteen
        // required knobs would otherwise produce nineteen near-identical
        // three-line errors, which is a wall rather than a diagnosis.
        unbound.push({ spec, module });
        continue;
      }
      value = spec.default;
      from = `${module.ref.text} default`;
      file = module.manifest.file;
      pos = spec.pos;
    }

    if (!valueFitsType(value, spec.type)) {
      s.error(
        "knob-type",
        `knob \`${name}\` is \`${spec.type}\`, and ${formatValue(value)} is ${describeKind(value)}.`,
        file,
        pos,
        spec.type === "bool"
          ? `Write it as  ${name} = true   or   ${name} = false`
          : spec.type === "int"
            ? `Write it as  ${name} = 6   -- a whole number, with no decimal point.`
            : `Write it as  ${name} = 0.42   -- a number.`,
      );
      continue;
    }

    if (value.kind === "boolean") {
      bound.push({
        name,
        jsName: camelCase(name),
        type: "bool",
        raw: value.value ? 1 : 0,
        literal: value.value ? "true" : "false",
        from,
      });
      continue;
    }

    // `valueFitsType` has already established this, and the boolean case left
    // above. The check is here because a narrowing the compiler can see is
    // worth more than a cast a reader has to trust.
    if (value.kind !== "integer" && value.kind !== "float") continue;
    const numeric = value.value;
    if (spec.min !== undefined && numeric < spec.min) {
      s.error(
        "knob-out-of-range",
        `knob \`${name}\` is ${formatValue(value)}, below its minimum of ${showNumber(spec.min, spec.type)}.`,
        file,
        pos,
        `The range is ${rangeText(spec)}.${spec.doc === undefined ? "" : `\n${spec.doc}`}`,
      );
      continue;
    }
    if (spec.max !== undefined && numeric > spec.max) {
      s.error(
        "knob-out-of-range",
        `knob \`${name}\` is ${formatValue(value)}, above its maximum of ${showNumber(spec.max, spec.type)}.`,
        file,
        pos,
        `The range is ${rangeText(spec)}.${spec.doc === undefined ? "" : `\n${spec.doc}`}`,
      );
      continue;
    }

    if (spec.type === "int") {
      bound.push({
        name,
        jsName: camelCase(name),
        type: "int",
        raw: numeric,
        literal: String(numeric),
        from,
      });
      continue;
    }

    // 16.16, through the console's own conversion, so the stamper and the
    // machine round a knob the same way. `fromFloat` is floor-and-saturate.
    const raw = fromFloat(numeric);
    bound.push({
      name,
      jsName: camelCase(name),
      type: "fixed",
      raw,
      literal: `${raw} / 65536`,
      from,
    });
  }

  reportUnbound(s, recipe, unbound);
  return { merged, knobs: bound, diagnostics: s.items };
}

/** Wrap a comma-separated list to `width` columns, for a message body. */
function wrapList(names: readonly string[], width: number): string {
  const lines: string[] = [];
  let line = "";
  for (let i = 0; i < names.length; i++) {
    const piece = (names[i] as string) + (i === names.length - 1 ? "" : ",");
    if (line !== "" && line.length + 1 + piece.length > width) {
      lines.push(line);
      line = piece;
    } else {
      line = line === "" ? piece : `${line} ${piece}`;
    }
  }
  if (line !== "") lines.push(line);
  return lines.join("\n");
}

/**
 * Report every unbound required knob: one diagnostic per module that declares
 * them, never one per knob.
 *
 * WHY THIS IS GROUPED. An engine may declare seventy knobs and require
 * nineteen of them, and a recipe that has not been filled in yet is missing all
 * nineteen at once. Nineteen separate errors -- same file, same line, same
 * wording, differing in one identifier -- is a wall an author scrolls past, and
 * the one thing they actually need is the block of lines to paste. So a single
 * missing knob keeps the sentence form, and two or more become one message with
 * a `=`-aligned, paste-ready `Add to [tuning]:` block.
 */
function reportUnbound(
  s: Sink,
  recipe: Recipe,
  unbound: readonly { spec: KnobSpec; module: ResolvedModule }[],
): void {
  const byModule = new Map<string, { module: ResolvedModule; specs: KnobSpec[] }>();
  for (const u of unbound) {
    const group = byModule.get(u.module.ref.text);
    if (group === undefined) byModule.set(u.module.ref.text, { module: u.module, specs: [u.spec] });
    else group.specs.push(u.spec);
  }

  for (const ref of [...byModule.keys()].sort()) {
    const { module, specs } = byModule.get(ref) as { module: ResolvedModule; specs: KnobSpec[] };
    specs.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    if (specs.length === 1) {
      const spec = specs[0] as KnobSpec;
      s.error(
        "unbound-knob",
        `${module.slot} ${module.ref.text} requires knob \`${spec.name}\`,\n` +
          `which the [tuning] table does not set.`,
        recipe.file,
        recipe.tuningPos,
        `Add:  ${spec.name} = ${suggestedValue(spec)}${knobComment(spec)}`,
      );
      continue;
    }

    // `=` in one column and `#` in another: the block is meant to be pasted,
    // and a column of aligned values is also the fastest way to read down it
    // looking for the one number you already know you want to change.
    const nameWidth = Math.max(...specs.map((k) => k.name.length));
    const values = specs.map((k) => suggestedValue(k));
    const valueWidth = Math.max(...values.map((v) => v.length));
    const lines = specs.map((k, i) => {
      const comment = knobComment(k).replace(/^ +/, "");
      const pair = `  ${k.name.padEnd(nameWidth)} = ${(values[i] as string).padEnd(valueWidth)}`;
      return comment === "" ? pair.trimEnd() : `${pair}   ${comment}`;
    });

    s.error(
      "unbound-knob",
      `${module.slot} ${module.ref.text} requires ${specs.length} knobs which the [tuning] ` +
        `table does not set:\n` +
        wrapList(
          specs.map((k) => k.name),
          72,
        ),
      recipe.file,
      recipe.tuningPos,
      `Add to [tuning] -- the values below are starting points, not answers:\n${lines.join("\n")}`,
    );
  }
}

function rangeText(spec: KnobSpec): string {
  if (spec.min !== undefined && spec.max !== undefined) {
    return `${showNumber(spec.min, spec.type)} .. ${showNumber(spec.max, spec.type)}`;
  }
  if (spec.min !== undefined) return `${showNumber(spec.min, spec.type)} and up`;
  return `up to ${showNumber(spec.max as number, spec.type)}`;
}

// ===========================================================================
// [4] VALIDATE
// ===========================================================================

/**
 * [4] VALIDATE: interfaces, ABI version, profile, AND THE CLAIMS AGAINST THE BYTES.
 *
 * A MANIFEST IS A CLAIM. THE STAMPER'S JOB IS TO VERIFY CLAIMS AGAINST BYTES.
 *
 * Everything above `checkFlagBytes` in this stage compares manifest text with
 * manifest text: `requires` against `provides`, one sentence against another.
 * That is necessary and it is not sufficient, because two files can agree
 * perfectly and still describe a pack that does not exist. A tileset declaring
 * `flags = ["solid", "hazard"]` satisfies an engine asking for exactly those
 * two, and if every flag byte in its `tiles.bin` is zero the cart stamps,
 * proves a 600-frame chain, and runs a game where nothing is solid and nothing
 * is fatal. That is the plausible-looking broken cart this whole format is
 * advertised against, and text-versus-text cannot see it.
 *
 * So three checks here read something other than manifest text. Each one is a
 * number stated in one place and observable in another:
 *
 *   checkFlagBytes   a declared flag against the flag bytes the pack SHIPS.
 *   checkFlagBits    `[provides] solid_flag` against the `solid_flag` KNOB --
 *                    one bit number written in two files, which nothing compared.
 *   checkIndexKnobs  an `int` knob declaring `indexes` against the SIZE of the
 *                    pack it indexes, so `tile_floor = 200` on a 64-tile pack
 *                    stops being a build.
 *
 * TWO GAPS ARE LEFT OPEN HERE ON PURPOSE, and they are written down rather than
 * quietly not implemented, because a checker's silence is read as approval:
 *
 *   TWO PACKS CLAIMING ONE SHEET CELL IS A WARNING, NOT A REFUSAL. Layers merge
 *   in declared order and later keys win, so overriding one pack's cells with
 *   another's is a supported edit; refusing it would remove the mechanism. The
 *   warning `mergeArt` emits now says what the author loses -- the earlier
 *   pack's art for that cell is not in the cart at all -- because "warning"
 *   without that sentence reads as cosmetic.
 *
 *   AN OPTIONAL REQUIREMENT IS SATISFIED BY KIND ALONE. `soundbank = false`
 *   means "may be used, is not needed", so any soundbank satisfies it --
 *   including one declaring no effects while the engine's `sfx_*` knobs name
 *   ids 0, 1 and 2. Closing it needs a way for an OPTIONAL requirement to carry
 *   constraints that apply only if the kind is present (`soundbank = { optional
 *   = true, min_effects = 3 }` or similar), which is a change to the `requires`
 *   grammar rather than a missing call, and it is not this milestone's. Until
 *   then a silent effect is a silent effect, not a broken cart.
 *
 * This is the stage the whole module system exists for. Because an engine
 * states what it needs and a tileset states what it offers, a recipe is
 * type-checked before anything is built -- which is the difference between a
 * stamper that produces working carts and one that produces plausible-looking
 * broken ones.
 *
 * The two BUDGETS are checked where their numbers exist and not here: the token
 * count in `compile`, once there is a compiled source to count, and the byte
 * size in `pack`, once there is a cart to measure. Checking them early would
 * mean guessing at them.
 */
export function validate(bound: BoundSpec): Diagnostic[] {
  const s = new Sink();
  const merged = bound.merged;
  const recipe = merged.recipe;

  if (recipe.cart.profile !== PROFILE) {
    s.error(
      "unsupported-profile",
      `this recipe builds profile "${recipe.cart.profile}", and this stamper builds "${PROFILE}".`,
      recipe.file,
      recipe.cart.pos,
    );
  }

  if (merged.abiMinor > SUPPORTED_ABI_MINOR) {
    const asking = merged.layers.filter((l) => l.manifest.abiMinor === merged.abiMinor);
    s.error(
      "bad-manifest",
      `${asking.map((l) => `\`${l.ref.text}\``).join(", ")} needs ABI minor ${merged.abiMinor}, ` +
        `and this stamper builds against ${SUPPORTED_ABI_MINOR}.`,
      recipe.file,
      (asking[0] as ResolvedModule).pos,
      "The module is newer than the tool. Update the stamper, or pin an older module version.",
    );
  }

  for (const { req, module } of merged.requires) {
    const provider = merged.byKind.get(req.kind);
    if (provider === undefined) {
      s.error(
        "unsatisfied-requires",
        `${module.slot} \`${module.ref.text}\` requires a ${req.kind} module, and this recipe sets none.`,
        recipe.file,
        module.pos,
        `Add to [modules]:\n  ${req.kind} = "somename@1.0.0"`,
      );
      continue;
    }
    for (const c of req.constraints) {
      const why = checkConstraint(provider, c.key, c.value);
      if (why === null) continue;
      s.error(
        "unsatisfied-requires",
        `${module.slot} \`${module.ref.text}\` requires ${req.kind} ` +
          `${c.key} = ${formatValue(c.value)}, and \`${provider.ref.text}\` ${why}.`,
        recipe.file,
        provider.pos,
        `Use a ${req.kind} module that satisfies it, or an engine that does not ask for it.\n` +
          `\`${provider.ref.text}\` declares: ${describeProvides(provider)}`,
      );
    }
  }

  // And now the same question asked of the bytes rather than of the sentences.
  checkFlagBytes(s, merged);
  checkFlagBits(s, bound);
  checkIndexKnobs(s, bound);

  return s.items;
}

/**
 * How many 8x8 cells a pack has: what it declares, or what its file's length
 * says when it declares nothing.
 *
 * The same rule `mergeArt` places art by, deliberately -- a check that measured
 * a pack differently from the code that copies it would be checking a pack that
 * does not exist. Null means "no count is knowable", which is the honest answer
 * for a module with neither a declared count nor a data file, and every caller
 * here treats it as "nothing to check against" rather than as an error.
 */
function packCells(layer: ResolvedModule): number | null {
  const declared =
    providedNumber(layer, "tiles") ??
    providedNumber(layer, "sprites") ??
    providedNumber(layer, "cells");
  if (declared !== null) return Number.isInteger(declared) && declared > 0 ? declared : null;
  if (layer.manifest.dataFile === null) return null;
  const bytes = layer.files.get(layer.manifest.dataFile.name);
  if (bytes === undefined) return null;
  const cells = Math.floor(bytes.length / (CELL_BYTES + 1));
  return cells > 0 ? cells : null;
}

/** The string items of a `[provides]` array, or an empty list. */
function providedNames(layer: ResolvedModule, key: string): string[] {
  const provides = layer.manifest.provides;
  if (provides === null) return [];
  const v = tableGet(provides, key)?.value;
  if (v === undefined || v.kind !== "array") return [];
  return v.items.filter((i) => i.kind === "string").map((i) => (i as { value: string }).value);
}

/**
 * GAP 1: A DECLARED FLAG MUST BE IN THE BYTES.
 *
 * `flags = ["solid", "hazard"]` is a claim about a `tiles.bin`, and until now
 * nothing opened the file. A pack whose every flag byte is zero satisfied an
 * engine's `requires` on the strength of the sentence, and shipped a game with
 * no walls and no lava in it.
 *
 * WHAT IS CHECKED. For every flag name the pack lists, if the pack also says
 * which BIT that name uses -- `solid_flag = 1`, the same key `checkFlagBits`
 * compares against the engine's knob -- then at least one of the pack's own
 * cells must carry that bit. A pack that lists flags without naming their bits
 * can only be checked weakly: all this can then say is that its flag bytes are
 * not uniformly zero, which is still the difference between a pack that marks
 * something and one that marks nothing.
 *
 * WHAT IS NOT CHECKED, and is worth knowing: a pack that ships NO data file at
 * all is out of reach here, because there are no bytes to disagree with. That
 * is a `[provides]` table describing a pack with no art in it, which every
 * other stage already treats as legitimate -- a tileset can be a declaration
 * that a later layer fills in.
 */
function checkFlagBytes(s: Sink, merged: MergedSpec): void {
  for (const layer of merged.layers) {
    const provides = layer.manifest.provides;
    if (provides === null || layer.manifest.dataFile === null) continue;
    const flagsEntry = tableGet(provides, "flags");
    if (flagsEntry === undefined || flagsEntry.value.kind !== "array") continue;
    const names = providedNames(layer, "flags");
    if (names.length === 0) continue;

    const file = layer.manifest.dataFile.name;
    const bytes = layer.files.get(file);
    const cells = packCells(layer);
    // A length that disagrees with the count is `data-size-mismatch`, reported
    // by `merge` against this same pack. Reading flags out of a file whose
    // layout is already known to be wrong would only add a second, wronger
    // complaint about the first one's cause.
    if (bytes === undefined || cells === null || bytes.length !== cells * (CELL_BYTES + 1)) {
      continue;
    }

    let marked = 0;
    for (let i = 0; i < cells; i++) marked |= bytes[cells * CELL_BYTES + i] as number;

    let mappedNames = 0;
    for (const flag of names) {
      const bit = providedNumber(layer, `${flag}_flag`);
      if (bit === null || !Number.isInteger(bit) || bit <= 0) continue;
      mappedNames++;
      if ((marked & bit) !== 0) continue;
      s.error(
        "flag-not-in-data",
        `\`${layer.ref.text}\` declares flag \`${flag}\` on bit ${bit}, and no cell of ${file} ` +
          `carries it: all ${cells} flag bytes leave bit ${bit} clear.`,
        layer.manifest.file,
        flagsEntry.keyPos,
        `A manifest is a claim and the bytes are the fact. An engine requiring \`${flag}\` is ` +
          `asking for cells marked with it, and this pack ships none -- so the cart would build ` +
          `and the flag would do nothing.\n` +
          `Regenerate ${file} with at least one cell marked, or drop "${flag}" from ` +
          `[provides] flags so an engine that needs it says so instead.`,
      );
    }

    if (mappedNames === 0 && marked === 0) {
      s.error(
        "flag-not-in-data",
        `\`${layer.ref.text}\` declares flags [${names.join(", ")}], and every one of its ` +
          `${cells} flag bytes in ${file} is zero: it marks nothing.`,
        layer.manifest.file,
        flagsEntry.keyPos,
        `A pack that also names its flags' bits -- \`${names[0] as string}_flag = 1\` in ` +
          `[provides] -- is checked one bit at a time; without them, all this can see is that ` +
          `nothing at all is marked.\n` +
          `Regenerate ${file}, or drop [provides] flags.`,
      );
    }
  }
}

/**
 * GAP 2: A PACK'S FLAG BIT AND THE ENGINE'S FLAG KNOB ARE ONE NUMBER.
 *
 * `caves` says `solid_flag = 1` in `[provides]`; `platformer` declares a knob
 * called `solid_flag` and reads that bit out of SPRITE_FLAGS. Two files, one
 * number, and nothing compared them -- so a pack marking solid on bit 4 against
 * an engine reading bit 1 stamped a cart, proved a chain, and let the player
 * walk through every wall.
 *
 * THE RULE IS GENERAL, not a pair of hard-coded names: any `[provides] <x>_flag`
 * whose name is also a bound knob must equal that knob's value. `solid_flag` and
 * `hazard_flag` are simply the two that exist. A pack declaring a bit no knob is
 * named after is not checked, because nothing reads it.
 */
function checkFlagBits(s: Sink, bound: BoundSpec): void {
  const merged = bound.merged;
  const boundByName = new Map(bound.knobs.map((k) => [k.name, k]));

  for (const layer of merged.layers) {
    const provides = layer.manifest.provides;
    if (provides === null) continue;
    for (const e of tableEntries(provides)) {
      if (!e.key.endsWith("_flag")) continue;
      const declared = providedNumber(layer, e.key);
      if (declared === null) continue;
      const knob = boundByName.get(e.key);
      // No knob of that name, or one that failed to bind and was already
      // reported. Either way there is no second number to disagree with.
      if (knob === undefined || knob.raw === declared) continue;

      const flag = e.key.slice(0, -"_flag".length);
      const set = merged.values.get(e.key);
      s.error(
        "flag-bit-mismatch",
        `\`${layer.ref.text}\` marks \`${flag}\` on bit ${declared}, and knob \`${e.key}\` is ` +
          `${knob.raw}: the engine would read bit ${knob.raw} out of SPRITE_FLAGS and this ` +
          `${layer.slot} writes bit ${declared}.`,
        set?.file ?? merged.recipe.file,
        set?.pos ?? merged.recipe.tuningPos,
        `One number, written in two files. Set  ${e.key} = ${declared}  in [tuning] to match ` +
          `\`${layer.ref.text}\`, or use a ${layer.slot} that marks \`${flag}\` on bit ` +
          `${knob.raw}.\n` +
          `The value in force is ${knob.raw}, from ${knob.from === "" ? "this recipe" : knob.from}.`,
      );
    }
  }
}

/**
 * GAPS 3 AND 4: AN INDEX KNOB MUST NAME A CELL THE PACK HAS.
 *
 * `tile_floor = 200` against a 64-tile pack is inside the knob's own `1 .. 255`
 * range and outside the art entirely, and `min`/`max` cannot see the difference
 * -- a knob's declared range is a fact about the engine, and how much art the
 * recipe paired it with is not knowable when the engine is written. So the
 * manifest says what the knob INDEXES and the size comes from the resolved pack.
 *
 * `indexes` IS OPTIONAL AND THIS CHECK APPLIES ONLY WHERE IT APPEARS. A knob
 * without it is bounded by `min`/`max` alone, exactly as before, and every
 * manifest written before the field existed is read unchanged.
 */
function checkIndexKnobs(s: Sink, bound: BoundSpec): void {
  const merged = bound.merged;

  for (const knob of bound.knobs) {
    const declared = merged.knobs.get(knob.name);
    if (declared === undefined) continue;
    const indexes = declared.spec.indexes;
    if (indexes === undefined) continue;

    const pack = merged.byKind.get(indexes);
    // No pack of that kind in the recipe. If the engine required one, the
    // `requires` check above has already said so in the author's own terms; if
    // it did not, there is nothing this knob can be checked against.
    if (pack === undefined) continue;
    const cells = packCells(pack);
    if (cells === null) continue;
    const base = providedNumber(pack, "base") ?? 0;
    if (!Number.isInteger(base) || base < 0) continue; // `mergeArt` reported it
    const last = base + cells - 1;
    if (knob.raw >= base && knob.raw <= last) continue;

    const set = merged.values.get(knob.name);
    s.error(
      "index-out-of-pack",
      `knob \`${knob.name}\` is ${knob.raw}, and ${indexes} \`${pack.ref.text}\` fills sheet ` +
        `cells ${base} .. ${last}.`,
      set?.file ?? merged.recipe.file,
      set?.pos ?? merged.recipe.tuningPos,
      `\`${knob.name}\` indexes the ${indexes}, so it has to name a cell that pack draws: ` +
        `\`${pack.ref.text}\` places ${cells} cells at [provides] base ${base}.\n` +
        `Choose a number from ${base} to ${last}, or use a ${indexes} that reaches cell ` +
        `${knob.raw}.${declared.spec.doc === undefined ? "" : `\n${declared.spec.doc}`}`,
    );
  }
}

/** What a module's `[provides]` says, on one line, for a message. */
function describeProvides(m: ResolvedModule): string {
  if (m.manifest.provides === null) return "(no [provides] table)";
  const entries = tableEntries(m.manifest.provides);
  if (entries.length === 0) return "(nothing)";
  return entries.map((e) => `${e.key} = ${formatValue(e.value)}`).join(", ");
}

/**
 * One `requires` constraint against one provider's `[provides]`.
 *
 * @returns null when satisfied, or the clause that completes
 * "`caves@1.0.0` <reason>" -- so the message reads as one sentence.
 */
export function checkConstraint(
  provider: ResolvedModule,
  key: string,
  want: TomlValue,
): string | null {
  const provides = provider.manifest.provides;
  const lookup = (name: string): TomlValue | undefined => {
    if (provides === null) return undefined;
    return tableGet(provides, name)?.value;
  };

  if (key === "flags") {
    if (want.kind !== "array") return `is asked for flags that are not an array`;
    const have = lookup("flags");
    if (have === undefined) return "declares no flags";
    if (have.kind !== "array") return `declares flags as ${describeKind(have)}`;
    const haveNames = have.items.filter((i) => i.kind === "string").map((i) => (i as { value: string }).value);
    const missing = want.items
      .filter((i) => i.kind === "string")
      .map((i) => (i as { value: string }).value)
      .filter((f) => !haveNames.includes(f));
    if (missing.length === 0) return null;
    return `declares flags [${haveNames.join(", ")}] and is missing ${missing.map((f) => `"${f}"`).join(", ")}`;
  }

  const limit = key.startsWith("min_") ? "min" : key.startsWith("max_") ? "max" : null;
  if (limit !== null) {
    const target = key.slice(4);
    if (want.kind !== "integer" && want.kind !== "float") {
      return `is asked for a ${limit}imum that is ${describeKind(want)}`;
    }
    const have = lookup(target);
    if (have === undefined) return `declares no \`${target}\``;
    if (have.kind !== "integer" && have.kind !== "float") {
      return `declares ${target} as ${describeKind(have)}`;
    }
    if (limit === "min" && have.value < want.value) return `declares ${target} = ${have.value}`;
    if (limit === "max" && have.value > want.value) return `declares ${target} = ${have.value}`;
    return null;
  }

  const have = lookup(key);
  if (have === undefined) return `declares no \`${key}\``;
  return sameValue(have, want) ? null : `declares ${key} = ${formatValue(have)}`;
}

/** Structural equality of two TOML values, ignoring position. */
function sameValue(a: TomlValue, b: TomlValue): boolean {
  if (a.kind === "array" || b.kind === "array") {
    if (a.kind !== "array" || b.kind !== "array") return false;
    return (
      a.items.length === b.items.length &&
      a.items.every((x, i) => sameValue(x, b.items[i] as TomlValue))
    );
  }
  // Two tables are never "the same value": nothing in `requires` compares them,
  // and an equality that quietly said yes would satisfy a constraint by accident.
  if (a.kind === "table" || b.kind === "table") return false;
  // An integer 64 and a float 64.0 ARE the same number, and a manifest author
  // should not have to guess which spelling a requirement used.
  if (
    (a.kind === "integer" || a.kind === "float") &&
    (b.kind === "integer" || b.kind === "float")
  ) {
    return a.value === b.value;
  }
  if (a.kind === "string" && b.kind === "string") return a.value === b.value;
  if (a.kind === "boolean" && b.kind === "boolean") return a.value === b.value;
  return false;
}

// ===========================================================================
// [5] COMPILE
// ===========================================================================

export interface Payload {
  /** The cart's CODE, exactly as it will be encoded. */
  readonly source: string;
  /** Lines of preamble before the engine's own first line. */
  readonly preambleLines: number;
  readonly tokens: number;
  readonly diagnostics: readonly Diagnostic[];
}

/** The first line of every compiled cart, so a reader knows not to edit it. */
export const GENERATED_BANNER = "// generated by @sq1/stamper - do not edit";

/**
 * [5] COMPILE: an engine plus its bound knobs becomes cart source.
 *
 *     // generated by @sq1/stamper - do not edit
 *     const KNOB = { coyoteFrames: 6, gravity: 27524 / 65536, jumpVelocity: -203162 / 65536 };
 *     // ---- engine: platformer@1.0.0 ----
 *     <engine.js verbatim>
 *
 * WHY `N / 65536` AND NOT `0.42`
 * ------------------------------
 * A `fixed` knob is already a 16.16 integer by the time it gets here (see
 * `bind`). Emitting it as an integer divided by a power of two means:
 *
 *   - the division is EXACT in IEEE doubles, and exact identically on every
 *     engine, so the engine's arithmetic starts from the same double everywhere;
 *   - the emitted source contains no decimal string, so there is no
 *     float-to-text-to-float round trip for a formatter to make a build depend
 *     on. `0.42` printed by two different `Number#toString` implementations
 *     would be a reproducibility bug that only ever showed up on someone
 *     else's machine.
 *
 * Knobs are emitted SORTED BY NAME. A map's iteration order is a property of
 * how it was built, and a cart's bytes must not be.
 *
 * THE STATIC GATE RUNS HERE
 * -------------------------
 * `lintCartSource` refuses a cart that names `Math`, `Date` or `fetch`. An
 * engine that does is refused at STAMP time with a position in engine.js, not
 * at load time on a player's machine three levels into a game.
 */
export function compile(bound: BoundSpec): Payload {
  const s = new Sink();
  const engine = bound.merged.engine;
  const recipe = bound.merged.recipe;

  const engineBytes = engine.files.get("engine.js") as Uint8Array;
  const engineSource = new TextDecoder("utf-8", { fatal: false })
    .decode(engineBytes)
    .replace(/\r\n/g, "\n");
  const enginePath = join(engine.dir, "engine.js");

  // THE PREAMBLE CARRIES KNOBS AND NOTHING ELSE. Art reaches the engine as
  // chunk bytes the player installs into RAM at boot, not as source: see
  // CHUNK_REGIONS. An engine reads its sprite sheet from 0x2200 because it is
  // already there.
  const pairs = bound.knobs.map((k) => `${k.jsName}: ${k.literal}`);
  const preamble = [
    GENERATED_BANNER,
    pairs.length === 0 ? "const KNOB = {};" : `const KNOB = { ${pairs.join(", ")} };`,
    `// ---- engine: ${engine.ref.text} ----`,
  ];
  const preambleLines = preamble.length;
  const source = `${preamble.join("\n")}\n${engineSource.endsWith("\n") ? engineSource : engineSource + "\n"}`;

  let tokens = 0;
  try {
    const lint = lintCartSource(source);
    tokens = lint.tokens;
    for (const f of lint.findings) {
      // `missing-tick` and `empty-source` are findings about the WHOLE source
      // and carry a synthetic 1:1. They belong to the engine either way -- the
      // preamble never declares a tick and never could -- so they are reported
      // against engine.js rather than against a preamble line nobody wrote.
      if (f.rule === "missing-tick" || f.rule === "empty-source") {
        s.error(f.rule, f.message, enginePath, { line: 1, column: 1 });
        continue;
      }
      // Everything else is positioned. A finding inside the engine's own text
      // is reported against engine.js at the engine's own line. A finding in
      // the preamble can only be a bug in this file, and says so by pointing at
      // the recipe instead of inventing a position in a file nobody wrote.
      const inEngine = f.line > preambleLines;
      const file = inEngine ? enginePath : recipe.file;
      const pos: Pos = inEngine
        ? { line: f.line - preambleLines, column: f.column }
        : recipe.engine.pos;
      s.error(f.rule as DiagnosticCode, f.message, file, pos);
    }
  } catch (e) {
    s.error(
      "engine-not-javascript",
      `${enginePath} is not valid JavaScript: ${e instanceof Error ? e.message : String(e)}`,
      enginePath,
      { line: 1, column: 1 },
      "The token counter reads the whole engine, so this stops the build before a cart is written.",
    );
  }

  return { source, preambleLines, tokens, diagnostics: s.items };
}

// ===========================================================================
// [6] PACK
// ===========================================================================

/** What `prove` found, once it has run. Absent on the pre-prove pack. */
export interface Proof {
  readonly seed: number;
  readonly frames: number;
  readonly chain: string;
}

export interface Packed {
  readonly cart: CartFile;
  readonly bytes: Uint8Array;
  /** 32 Crockford base32 characters, unformatted. */
  readonly id: string;
  readonly diagnostics: readonly Diagnostic[];
}

/** The `rcpe` chunk's format marker and version. */
export const RECIPE_CHUNK_FORMAT = "sq1-recipe 1";

/**
 * The `rcpe` chunk: the recipe, and the content hash of every module it used.
 *
 * A cart therefore decompiles back to the editable recipe it was built from,
 * and anyone can rebuild it and compare the id -- which is what makes "this
 * cart is what its recipe claims" a fact rather than a promise about the
 * publisher.
 *
 *     sq1-recipe 1
 *     engine platformer@1.0.0 <64 hex>
 *     module palette sweetie16@1.0.0 <64 hex>      (sorted by kind, then name)
 *     knob gravity fixed 27524                     (sorted by name)
 *     prove 1 600 <64 hex>
 *     recipe <byte length>
 *     <the recipe text, LF, verbatim>
 *
 * The recipe text is LAST and its byte length is stated, because a recipe may
 * itself contain a line beginning `recipe ` and a parser that scanned for the
 * marker would stop in the wrong place. Everything above it is sorted, so the
 * chunk is a function of the build and not of the order a map was filled in.
 */
export function buildRecipeChunk(
  merged: MergedSpec,
  knobs: readonly BoundKnob[],
  proof: Proof | null,
): Uint8Array {
  const lines: string[] = [RECIPE_CHUNK_FORMAT];
  lines.push(`engine ${merged.engine.ref.text} ${merged.engine.hash}`);

  const others = merged.layers.filter((l) => l !== merged.engine);
  const sorted = [...others].sort((a, b) => {
    if (a.slot !== b.slot) return MODULE_KINDS.indexOf(a.slot) - MODULE_KINDS.indexOf(b.slot);
    return a.ref.text < b.ref.text ? -1 : a.ref.text > b.ref.text ? 1 : 0;
  });
  for (const m of sorted) lines.push(`module ${m.slot} ${m.ref.text} ${m.hash}`);

  for (const k of [...knobs].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    lines.push(`knob ${k.name} ${k.type} ${k.raw}`);
  }

  if (proof !== null) lines.push(`prove ${proof.seed} ${proof.frames} ${proof.chain}`);

  const body = utf8(merged.recipe.text, "the recipe text");
  lines.push(`recipe ${body.length}`);

  const head = utf8(lines.join("\n") + "\n", "the rcpe header");
  const out = new Uint8Array(head.length + body.length);
  out.set(head, 0);
  out.set(body, head.length);
  return out;
}

/** What `parseRecipeChunk` recovers from a cart's `rcpe` chunk. */
export interface RecipeChunk {
  readonly engine: { ref: string; hash: string };
  readonly modules: readonly { kind: string; ref: string; hash: string }[];
  readonly knobs: readonly { name: string; type: string; raw: number }[];
  readonly proof: Proof | null;
  /** The recipe source, byte-for-byte what was built. */
  readonly recipe: string;
}

/**
 * Read an `rcpe` chunk back: the decompile half of the format above.
 *
 * A cart carrying its recipe is only a claim until something reads it, so this
 * exists and is round-tripped by a test. It is also the tool a registry needs
 * to answer "rebuild this cart and tell me whether the id matches".
 *
 * Returns null for anything it does not recognise, and never throws: an `rcpe`
 * chunk arrives inside a cart file, and a cart file arrives from a stranger.
 */
export function parseRecipeChunk(bytes: Uint8Array): RecipeChunk | null {
  // Find the `recipe <n>` line by scanning bytes, so the header can be decoded
  // as text without ever decoding the recipe body twice or assuming its length.
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let head: string;
  let headEnd = -1;
  try {
    for (let i = 0; i < bytes.length; i++) {
      if (bytes[i] !== 0x0a) continue;
      const line = decoder.decode(bytes.subarray(0, i + 1));
      const m = /(?:^|\n)recipe (\d+)\n$/.exec(line);
      if (m !== null) {
        headEnd = i + 1;
        break;
      }
    }
    if (headEnd === -1) return null;
    head = decoder.decode(bytes.subarray(0, headEnd));
  } catch {
    return null;
  }

  const lines = head.split("\n");
  lines.pop(); // the trailing empty piece after the final newline
  if (lines[0] !== RECIPE_CHUNK_FORMAT) return null;

  let engine: { ref: string; hash: string } | null = null;
  const modules: { kind: string; ref: string; hash: string }[] = [];
  const knobs: { name: string; type: string; raw: number }[] = [];
  let proof: Proof | null = null;
  let length = -1;

  for (const line of lines.slice(1)) {
    const p = line.split(" ");
    if (p[0] === "engine" && p.length === 3) {
      engine = { ref: p[1] as string, hash: p[2] as string };
    } else if (p[0] === "module" && p.length === 4) {
      modules.push({ kind: p[1] as string, ref: p[2] as string, hash: p[3] as string });
    } else if (p[0] === "knob" && p.length === 4) {
      knobs.push({ name: p[1] as string, type: p[2] as string, raw: Number(p[3]) });
    } else if (p[0] === "prove" && p.length === 4) {
      proof = { seed: Number(p[1]), frames: Number(p[2]), chain: p[3] as string };
    } else if (p[0] === "recipe" && p.length === 2) {
      length = Number(p[1]);
    } else {
      return null;
    }
  }

  if (engine === null || length < 0 || headEnd + length !== bytes.length) return null;
  let recipe: string;
  try {
    recipe = decoder.decode(bytes.subarray(headEnd));
  } catch {
    return null;
  }
  return { engine, modules, knobs, proof, recipe };
}

/**
 * [6] PACK: chunks to bytes to a cart id.
 *
 * Chunk order is built in the container's canonical order by eye; `encode`
 * enforces it regardless. Nothing environmental reaches these bytes: no clock,
 * no path, no directory listing. `assets` is drained in the container's fixed
 * chunk order rather than in map order, for the same reason.
 */
export function pack(payload: Payload, bound: BoundSpec, proof: Proof | null): Packed {
  const s = new Sink();
  const merged = bound.merged;
  const recipe = merged.recipe;

  let metaBytes: Uint8Array;
  try {
    metaBytes = encodeMeta({
      title: recipe.cart.title,
      author: recipe.cart.author,
      profile: "up",
      payload: recipe.cart.payload,
      abiMinor: merged.abiMinor,
      specMajor: SPEC_MAJOR,
      specMinor: SPEC_MINOR,
    });
  } catch (e) {
    const why = (e instanceof Error ? e.message : String(e)).replace(/^encodeMeta: /, "");
    s.error("bad-recipe", `[cart] cannot be written into the cart: ${why}`, recipe.file, recipe.cart.pos);
    return {
      cart: { specMajor: SPEC_MAJOR, specMinor: SPEC_MINOR, chunks: [] },
      bytes: new Uint8Array(0),
      id: "",
      diagnostics: s.items,
    };
  }

  const chunks: { type: string; data: Uint8Array }[] = [
    { type: "META", data: metaBytes },
    { type: "CODE", data: utf8(payload.source, "the compiled cart source") },
  ];
  // The container's own order, not the map's. Written as chunk TYPES rather
  // than `[files]` roles because `PAL ` has no role: a palette is chosen in a
  // manifest, never shipped as a file.
  for (const type of ["PAL ", "GFX ", "MAP ", "SFX ", "MUS ", "DATA", "labl"]) {
    const asset = merged.assets.get(type);
    if (asset === undefined) continue;
    const role = asset.role;

    // A chunk longer than the RAM region it installs into is a LOAD error, not
    // a truncation -- so it is caught here, at stamp time, where the author is
    // looking, rather than on a player's machine. `labl` has no region: it is
    // the cart's picture, never installed.
    const region = CHUNK_REGIONS[type];
    if (region !== undefined && asset.bytes.length > region.bytes) {
      s.error(
        "chunk-too-large",
        `the ${role} data is ${asset.bytes.length} bytes, and the ${type.trim()} region at ` +
          `0x${region.address.toString(16).toUpperCase().padStart(4, "0")} holds ${region.bytes}.`,
        recipe.file,
        asset.module.pos,
        `\`${asset.module.ref.text}\` supplies it. A player installs this chunk into RAM at ` +
          `boot and refuses a cart whose chunk does not fit.`,
      );
      continue;
    }
    chunks.push({ type, data: asset.bytes });
  }
  chunks.push({ type: "rcpe", data: buildRecipeChunk(merged, bound.knobs, proof) });

  const cart: CartFile = { specMajor: SPEC_MAJOR, specMinor: SPEC_MINOR, chunks };
  let bytes: Uint8Array;
  try {
    bytes = encode(cart);
  } catch (e) {
    s.error(
      "pack-failed",
      `this cart could not be packed: ${e instanceof Error ? e.message : String(e)}`,
      recipe.file,
      recipe.cart.pos,
    );
    return { cart, bytes: new Uint8Array(0), id: "", diagnostics: s.items };
  }

  if (bytes.length > MAX_CART_BYTES) {
    const biggest = [...merged.assets.values()].sort((a, b) => b.bytes.length - a.bytes.length)[0];
    s.error(
      "cart-budget",
      `this cart is ${bytes.length} bytes, which is ${bytes.length - MAX_CART_BYTES} over the ` +
        `${MAX_CART_BYTES}-byte cart budget.`,
      recipe.file,
      recipe.cart.pos,
      biggest === undefined
        ? "The engine's own code is the whole cart; there is nothing else to trim."
        : `The largest input is ${biggest.role} from \`${biggest.module.ref.text}\`, ` +
          `at ${biggest.bytes.length} bytes.`,
    );
  }

  return { cart, bytes, id: cartIdOf(cart), diagnostics: s.items };
}

// ===========================================================================
// [7] PROVE
// ===========================================================================

export interface ProveResult {
  readonly ok: boolean;
  readonly seed: number;
  readonly frames: number;
  /** The chain over every frame run. `chainOf([])` when nothing ran. */
  readonly chain: string;
  readonly frameHashes: readonly string[];
  readonly diagnostics: readonly Diagnostic[];
}

export interface ProveOptions {
  readonly frames?: number;
  readonly seed?: number;
  /** Where to point a failure. The recipe, normally. */
  readonly file: string;
  readonly pos: Pos;
}

/**
 * The replay `prove` runs against, derived from the seed.
 *
 * The console's own PRNG, one word per frame, its low six bits driving player
 * slot 0 -- byte for byte what `packages/runtime/tools/gen-golden.ts` generates
 * for a conformance case. Sharing the pattern means a cart's proof chain and a
 * conformance chain are the same kind of object and can be compared directly.
 */
export function proveReplay(seed: number, frames: number): Uint8Array {
  const rng = rngCreate(seed);
  const bytes = new Uint8Array(frames * INPUT_BYTES);
  for (let f = 0; f < frames; f++) bytes[f * INPUT_BYTES] = rngNext(rng) & BUTTON_MASK;
  return bytes;
}

/**
 * Which of a cart's data chunks did NOT reach RAM, BY LOOKING AT RAM.
 *
 * A POSITIVE CHECK rather than a guess at a signature. It boots a machine with
 * a do-nothing program and the same hooks the proof run will use, so RAM after
 * `boot` is exactly what the runtime put there and no cart code has touched it,
 * and then compares every span the cart's chunks should have installed against
 * what is actually at that address.
 *
 * WHY THIS SURVIVES BEING RIGHT. It would be simpler to delete this the day
 * installation landed, and it is here because the failure it guards is silent:
 * a `prove` that ran against a blank sprite sheet would record a frame-hash
 * chain that looks exactly like a real one, go into the `rcpe` chunk as the
 * cart's proof, and be reproduced by no player anywhere. There is no later
 * stage that would notice. So the check stays, phrased against the runtime's
 * own plan so that it keeps meaning the same thing if the map moves.
 *
 * `labl` is not checked: a cart's label picture is never installed.
 */
function uninstalledChunks(
  cartBytes: Uint8Array,
  seed: number,
  hooks: MachineHooks | undefined,
): string[] {
  const decoded = decode(cartBytes);
  if (!decoded.ok) return [];

  const planned = planCartData(decoded.cart.chunks);
  if (planned.data.length === 0) return [];

  // What the machine has to say for itself, against what it would look like if
  // nothing were installed at all. Comparing against the un-installed machine
  // rather than against zero is what makes this work for `PAL `, whose region
  // boot fills with the hardware palette and an identity live table.
  const probe = createMachine({ boot() {}, tick() {} }, hooks);
  probe.boot(seed);
  const bare = createMachine({ boot() {}, tick() {} });
  bare.boot(seed);
  const wanted = new Uint8Array(bare.ram);
  installCartData(wanted, planned.data);

  const missed = new Set<string>();
  for (const r of DATA_REGIONS) {
    const chunk = decoded.cart.chunks.find((c) => c.type === r.chunk);
    if (chunk === undefined) continue;
    for (const seg of r.segments) {
      for (let i = 0; i < seg.len; i++) {
        const a = seg.addr + i;
        // An all-zero span installs what boot already left and is unobservable,
        // so there is nothing it could prove and nothing to complain about.
        if (probe.ram[a] !== wanted[a]) missed.add(r.chunk.trim());
      }
    }
  }
  return [...missed];
}

/**
 * [7] PROVE: run the cart headless and record its frame-hash chain.
 *
 * A cart is not written until it has run (specification 9.2). This is the stage
 * that turns "the recipe validated" into "the cart starts, survives 600 frames
 * of input, and produces a chain anyone can reproduce". Everything upstream is
 * static analysis; this is the only stage that finds out whether the engine
 * throws on frame 137.
 *
 * The chain goes into `rcpe`, which is why `pack` runs twice: once to get bytes
 * to prove, and once more to record the proof. The second pack cannot change
 * the chain, because the chain is a function of CODE, the seed and the input --
 * none of which the `rcpe` chunk is part of. A test pins that.
 */
export function prove(cartBytes: Uint8Array, opts: ProveOptions): ProveResult {
  const s = new Sink();
  const frames = opts.frames ?? DEFAULT_PROVE_FRAMES;
  const seed = opts.seed ?? DEFAULT_PROVE_SEED;

  const loaded = loadCartBytes(cartBytes);
  if (!loaded.ok) {
    s.error(
      "prove-failed",
      `the cart this recipe built will not load: ${loaded.error.message}`,
      opts.file,
      opts.pos,
    );
    return { ok: false, seed, frames, chain: "", frameHashes: [], diagnostics: s.items };
  }

  // The cart's static data has to be in RAM before the run, or the chain below
  // is a hash of a blank sprite sheet -- a number that looks exactly like a
  // proof and that no player will ever reproduce.
  //
  // DO NOT DISABLE THIS CHECK. It is the only thing standing between a build
  // that says "proved 600 frames" and a chain that means nothing, and the
  // failure it prevents is invisible: the cart runs, the number is a valid
  // SHA-256, and no player reproduces it. If it is firing, the fix is in the
  // runtime's chunk installation, never here.
  const hooks: MachineHooks = { data: loaded.data };
  const notInstalled = uninstalledChunks(cartBytes, seed, hooks);
  if (notInstalled.length > 0) {
    s.error(
      "prove-failed",
      `this cart carries ${notInstalled.join(" and ")} data, and this runtime does not install ` +
        `cart chunks into RAM at boot.`,
      opts.file,
      opts.pos,
      "Proving it would run the engine against a blank sprite sheet and record a frame-hash\n" +
        "chain no player can reproduce, so the cart is refused instead. This needs the runtime's\n" +
        "chunk installation (specification 3.3); nothing in the recipe is wrong.",
    );
    return { ok: false, seed, frames, chain: "", frameHashes: [], diagnostics: s.items };
  }

  const replay = proveReplay(seed, frames);
  const machine = createMachine(loaded.program, hooks);
  const chain = new ChainHasher();
  const frameHashes: string[] = [];
  const input = new Uint8Array(INPUT_BYTES);

  try {
    machine.boot(seed);
  } catch (e) {
    s.error(
      "prove-failed",
      `the engine threw while booting: ${e instanceof Error ? e.message : String(e)}`,
      opts.file,
      opts.pos,
      "A cart is proved before it is written, so nothing was saved. Fix the engine or the knobs.",
    );
    return { ok: false, seed, frames, chain: chain.digest, frameHashes, diagnostics: s.items };
  }

  for (let f = 0; f < frames; f++) {
    input.set(replay.subarray(f * INPUT_BYTES, (f + 1) * INPUT_BYTES));
    try {
      machine.tick(input);
      // `present` is a pure read of the framebuffer, and running it here means a
      // present() that illegally wrote to RAM would change the chain and be
      // caught, rather than diverging only in the player.
      machine.present();
    } catch (e) {
      s.error(
        "prove-failed",
        `the engine threw on frame ${f} of ${frames}: ${e instanceof Error ? e.message : String(e)}`,
        opts.file,
        opts.pos,
        `The replay is the console's own PRNG from seed ${seed}; the same run happens again ` +
          `every time, so this is reproducible.`,
      );
      return { ok: false, seed, frames, chain: chain.digest, frameHashes, diagnostics: s.items };
    }
    frameHashes.push(chain.push(machine.ram));
  }

  return { ok: true, seed, frames, chain: chain.digest, frameHashes, diagnostics: s.items };
}
