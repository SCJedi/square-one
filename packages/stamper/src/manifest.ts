/**
 * `modules/<name>/module.toml` -- what a module IS, what it OFFERS and what it
 * NEEDS.
 *
 * This is the decision the whole stamping system turns on (specification 8.1).
 * Because an engine states what it needs and a tileset states what it offers, a
 * recipe is type-checked before anything is built -- which is the difference
 * between a template system that stamps working carts and one that stamps
 * plausible-looking broken ones.
 *
 * THE FORMAT
 * ----------
 *     [module]
 *     kind    = "engine"      # engine|palette|tileset|spriteset|soundbank|content|tuning|shell
 *     name    = "platformer"
 *     version = "1.0.0"
 *     abi_minor = 0           # optional; the lowest ABI minor this module needs
 *
 *     [provides]
 *     entities = 64           # free-form; what `requires` elsewhere is checked against
 *     flags    = ["solid", "hazard"]
 *
 *     [requires]
 *     palette = true
 *     tileset = { min_tiles = 64, flags = ["solid", "hazard"] }
 *     knobs   = ["gravity"]   # optional: names that must have a [knobs.*] table here
 *
 *     [knobs.gravity]
 *     type    = "fixed"       # fixed | int | bool
 *     default = 0.42          # OMIT to make the knob REQUIRED
 *     min     = 0.0
 *     max     = 4.0
 *     doc     = "Downward acceleration per frame, in pixels."
 *
 *     [knobs.tile_floor]
 *     type    = "int"
 *     indexes = "tileset"     # optional: this int names a cell of the resolved
 *                             # tileset, so bound it against that pack's size
 *
 *     [files]                 # every kind except `engine`; see below
 *     gfx = "tiles.bin"
 *
 *     [tuning]                # `tuning` modules only: knob values, layered like a recipe's
 *     gravity = 0.30
 *
 * An `engine` module carries `engine.js` beside its manifest and needs no
 * `[files]`. Every other kind names its data files in `[files]`, keyed by the
 * cart chunk they become: gfx, map, sfx, mus, data, labl. That key set is the
 * container's, not an invention here -- a module that shipped a file the cart
 * format has no chunk for would have nowhere to put it.
 *
 * HOW `requires` IS CHECKED AGAINST `provides`
 * --------------------------------------------
 * One rule, applied to every key of a requirement's inline table:
 *
 *     min_<x> = n     the providing module's `provides.<x>` must be >= n
 *     max_<x> = n     the providing module's `provides.<x>` must be <= n
 *     flags   = [..]  `provides.flags` must contain every listed flag
 *     <k>     = v     `provides.<k>` must equal v
 *
 * `kind = true` is the whole requirement in one word: a module of that kind
 * must be present, and nothing more is asked of it.
 *
 * A MANIFEST IS A CLAIM. THE STAMPER'S JOB IS TO VERIFY CLAIMS AGAINST BYTES.
 * ------------------------------------------------------------------------
 * Every rule above compares manifest text with manifest text, and text agreeing
 * with text is not a working cart. A tileset saying `flags = ["solid"]` while
 * every flag byte in its `data` file is zero satisfies `requires` on the
 * sentence alone, and stamps a game where nothing is solid. So three of the
 * checks in this package read the bytes rather than the sentence, and they live
 * in `validate` (stages.ts) where the resolved packs and the bound knob values
 * are both in hand:
 *
 *   - a declared flag must appear in the flag bytes the pack ships;
 *   - a `[provides] <name>_flag` bit and the engine's `<name>_flag` knob are one
 *     number written in two files, and must agree;
 *   - an `int` knob declaring `indexes` must name a cell the pack it indexes has.
 *
 * `indexes` IS THE ONE ADDITION THIS MILESTONE MAKES TO THE FORMAT, and it is
 * OPTIONAL: a manifest that does not use it is read exactly as before, and the
 * index check applies only where the word appears. It exists because there is
 * otherwise no way to tell `tile_floor` -- a sheet cell -- from `tile_bg` ... or
 * from `sprite_cells_w`, `sprite_run_frames` and `sprite_offset_x`, which are a
 * width, a count and a pixel offset. Guessing from the name would bound three
 * knobs that are not indices at all, so the manifest says it instead.
 */

import { diag, type Diagnostic } from "./diagnostics";
import {
  describeKind,
  formatValue,
  parseToml,
  tableEntries,
  tableGet,
  type Pos,
  type TomlTable,
  type TomlValue,
} from "./toml";

/** The eight module kinds (specification 8.1), in the order layers merge. */
export const MODULE_KINDS = [
  "engine",
  "palette",
  "tileset",
  "spriteset",
  "soundbank",
  "content",
  "tuning",
  "shell",
] as const;

export type ModuleKind = (typeof MODULE_KINDS)[number];

/** A knob's type, which decides how its value is bound and emitted. */
export const KNOB_TYPES = ["fixed", "int", "bool"] as const;
export type KnobType = (typeof KNOB_TYPES)[number];

/**
 * What an `int` knob may declare itself an index INTO.
 *
 * The two art kinds and nothing else, because these are the two that place
 * cells on the sprite sheet: a `[provides] base` and a cell count are what a
 * bound index is checked against, and no other kind has them.
 */
export const KNOB_INDEX_KINDS = ["tileset", "spriteset"] as const;
export type KnobIndexKind = (typeof KNOB_INDEX_KINDS)[number];

/**
 * `[files]` keys and the cart chunks they become.
 *
 * Fixed here rather than derived, because the chunk type carries a trailing
 * space for the three-letter names ("GFX ") and a manifest author should never
 * have to know that.
 *
 * THERE IS NO `pal` ROLE, and that is deliberate. The `PAL ` chunk carries the
 * console's colour tables, and a palette pack chooses them by naming sixteen
 * hardware colours in `[provides] entries` -- sixteen numbers a reader can see,
 * rather than a binary file they cannot. `mergeArt` builds the chunk.
 */
export const FILE_ROLES: Readonly<Record<string, string>> = {
  gfx: "GFX ",
  map: "MAP ",
  sfx: "SFX ",
  mus: "MUS ",
  data: "DATA",
  labl: "labl",
};

/**
 * A knob name is snake_case and nothing else.
 *
 * It has to survive the trip to a JavaScript identifier (`jump_velocity` ->
 * `jumpVelocity`), and the conversion is only reversible and only collision-free
 * if the input is constrained. `runAccel` and `run_accel` would both become
 * `runAccel`; refusing the first at manifest-parse time is how the second stays
 * unambiguous.
 */
export const KNOB_NAME = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/;

export interface KnobSpec {
  /** As written in the manifest, snake_case. */
  readonly name: string;
  readonly type: KnobType;
  /** Absent when the knob is REQUIRED -- a recipe must set it. */
  readonly default?: TomlValue;
  readonly min?: number;
  readonly max?: number;
  readonly doc?: string;
  /**
   * The pack this `int` names a cell of, when the manifest says so.
   *
   * OPTIONAL, and absent on every knob that does not declare it -- which is
   * every knob written before this field existed. `validate` bounds a knob that
   * carries it against the resolved pack's `base` and cell count; a knob
   * without it is bounded by `min`/`max` alone, exactly as before.
   */
  readonly indexes?: KnobIndexKind;
  /** The `[knobs.<name>]` header, which is where an author fixes it. */
  readonly pos: Pos;
}

/** One entry of a manifest's `[requires]` table. */
export interface Requirement {
  /** The module kind that must be present. */
  readonly kind: ModuleKind;
  /** The constraints, empty for `kind = true`. */
  readonly constraints: readonly { key: string; value: TomlValue }[];
  readonly pos: Pos;
}

export interface Manifest {
  readonly kind: ModuleKind;
  readonly name: string;
  readonly version: string;
  /** The lowest ABI minor a player must implement to run a cart using this module. */
  readonly abiMinor: number;
  /** Free-form declarations, checked against other modules' `requires`. */
  readonly provides: TomlTable | null;
  readonly requires: readonly Requirement[];
  /** In manifest order; the merger sorts what it needs sorted. */
  readonly knobs: readonly KnobSpec[];
  /** `[files]` role -> file name, relative to the module directory. */
  readonly files: ReadonlyMap<string, { name: string; pos: Pos }>;
  /**
   * `[provides] data = "tiles.bin"` -- an art pack's own sheet data.
   *
   * Separate from `[files]` because it is not a cart chunk of its own: `merge`
   * composes every pack's data into ONE sprite sheet and one flags block, and
   * THAT becomes the cart's single `GFX ` chunk. So a pack's file is an input
   * to a merge rather than a chunk. See `mergeArt` in stages.ts.
   */
  readonly dataFile: { name: string; pos: Pos } | null;
  /** `[tuning]` values a `tuning` module layers in. Null when absent. */
  readonly tuning: TomlTable | null;
  /** The path the manifest was read from, for diagnostics. */
  readonly file: string;
}

export type ManifestResult =
  | { ok: true; manifest: Manifest; diagnostics: readonly Diagnostic[] }
  | { ok: false; diagnostics: readonly Diagnostic[] };

/** `name@version`, the only way a recipe may name a module. */
export interface ModuleRef {
  readonly name: string;
  readonly version: string;
  /** `name@version`, rebuilt, so it is written one way everywhere. */
  readonly text: string;
}

const REF = /^([a-z0-9][a-z0-9-]*)@([0-9]+(?:\.[0-9]+)*(?:-[0-9A-Za-z.-]+)?)$/;

/**
 * Parse `platformer@1.0.0`.
 *
 * A path is deliberately NOT accepted. A cart records the modules it was built
 * from so anyone can rebuild it and compare the id; a path is a fact about one
 * machine's disk and would make that impossible. See `resolve` in stages.ts.
 */
export function parseRef(text: string): ModuleRef | null {
  const m = REF.exec(text);
  if (m === null) return null;
  const name = m[1] as string;
  const version = m[2] as string;
  return { name, version, text: `${name}@${version}` };
}

/** `jump_velocity` -> `jumpVelocity`. The one mapping, documented in one place. */
export function camelCase(snake: string): string {
  return snake.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

/** Collect a diagnostic and keep going, so one bad manifest reports everything. */
class Sink {
  readonly items: Diagnostic[] = [];
  #errors = 0;

  constructor(readonly file: string) {}

  error(code: Parameters<typeof diag>[0]["code"], message: string, pos: Pos, suggestion?: string): void {
    this.#errors++;
    this.items.push(
      diag(
        suggestion === undefined
          ? { code, message, file: this.file, line: pos.line, column: pos.column }
          : { code, message, file: this.file, line: pos.line, column: pos.column, suggestion },
      ),
    );
  }

  get failed(): boolean {
    return this.#errors > 0;
  }
}

/** A required string field of a table, or a diagnostic saying which and where. */
function stringField(
  s: Sink,
  t: TomlTable,
  key: string,
  what: string,
  example: string,
): string | null {
  const e = tableGet(t, key);
  if (e === undefined) {
    s.error("bad-manifest", `[module] has no \`${key}\`. ${what}`, t.pos, `Add:  ${example}`);
    return null;
  }
  if (e.value.kind !== "string") {
    s.error(
      "bad-manifest",
      `\`${key}\` must be a string, but is ${describeKind(e.value)}.`,
      e.keyPos,
      `Write it as  ${example}`,
    );
    return null;
  }
  return e.value.value;
}

function optionalNumber(s: Sink, t: TomlTable, key: string): number | null {
  const e = tableGet(t, key);
  if (e === undefined) return null;
  if (e.value.kind !== "integer" && e.value.kind !== "float") {
    s.error(
      "bad-manifest",
      `\`${key}\` must be a number, but is ${describeKind(e.value)}.`,
      e.keyPos,
    );
    return null;
  }
  return e.value.value;
}

function parseKnob(s: Sink, name: string, t: TomlTable): KnobSpec | null {
  if (!KNOB_NAME.test(name)) {
    s.error(
      "bad-knob-name",
      `\`${name}\` is not a usable knob name.`,
      t.pos,
      "A knob name is lower-case snake_case: letters and digits, words joined by _.\n" +
        "It becomes a JavaScript property, so `jump_velocity` reaches the engine as `jumpVelocity`.",
    );
    return null;
  }

  const typeEntry = tableGet(t, "type");
  if (typeEntry === undefined) {
    s.error(
      "bad-manifest",
      `knob \`${name}\` has no \`type\`.`,
      t.pos,
      `Add:  type = "fixed"    # one of ${KNOB_TYPES.join(", ")}`,
    );
    return null;
  }
  if (
    typeEntry.value.kind !== "string" ||
    !(KNOB_TYPES as readonly string[]).includes(typeEntry.value.value)
  ) {
    s.error(
      "bad-manifest",
      `knob \`${name}\` has type ${formatValue(typeEntry.value)}, which is not one of ` +
        `${KNOB_TYPES.map((k) => `"${k}"`).join(", ")}.`,
      typeEntry.keyPos,
    );
    return null;
  }
  const type = typeEntry.value.value as KnobType;

  const min = optionalNumber(s, t, "min");
  const max = optionalNumber(s, t, "max");
  if (min !== null && max !== null && min > max) {
    s.error(
      "bad-manifest",
      `knob \`${name}\` has min ${min} above max ${max}, so no value can satisfy it.`,
      t.pos,
    );
  }

  // AN `int` KNOB'S RANGE IS MADE OF WHOLE NUMBERS.
  //
  // `min = 1.5` parses, and then every number the author is ever shown is a lie:
  // the range printed on an out-of-range error reads `1.5 .. 255.5`, and the
  // midpoint `suggestedValue` offers for an unset knob is rounded to an integer
  // that the range then has to be re-read to justify. Worse, a bound of 1.5
  // describes a knob whose real minimum is 2 -- so the manifest states a limit
  // that its own type refuses. Refuse the manifest instead of the value.
  if (type === "int") {
    for (const key of ["min", "max"] as const) {
      const bound = key === "min" ? min : max;
      if (bound === null || Number.isInteger(bound)) continue;
      const whole = key === "min" ? Math.ceil(bound) : Math.floor(bound);
      s.error(
        "bad-manifest",
        `knob \`${name}\` is declared \`int\`, and its ${key} is ${bound}, which is not a whole number.`,
        (tableGet(t, key) as { keyPos: Pos }).keyPos,
        `An \`int\` knob only ever holds whole numbers, so ${bound} is a limit this knob's own ` +
          `type refuses.\nWrite  ${key} = ${whole}`,
      );
    }
  }

  // `indexes` -- the one optional addition. See the header of this file.
  const indexesEntry = tableGet(t, "indexes");
  let indexes: KnobIndexKind | null = null;
  if (indexesEntry !== undefined) {
    if (
      indexesEntry.value.kind !== "string" ||
      !(KNOB_INDEX_KINDS as readonly string[]).includes(indexesEntry.value.value)
    ) {
      s.error(
        "bad-manifest",
        `knob \`${name}\` has indexes ${formatValue(indexesEntry.value)}, which is not one of ` +
          `${KNOB_INDEX_KINDS.map((k) => `"${k}"`).join(", ")}.`,
        indexesEntry.keyPos,
        `\`indexes\` says which pack a knob names a cell of, so the stamper can check the ` +
          `number against that pack's size:\n  indexes = "tileset"`,
      );
    } else if (type !== "int") {
      s.error(
        "bad-manifest",
        `knob \`${name}\` is declared \`${type}\` and also indexes a ${indexesEntry.value.value}, ` +
          `and a sheet cell is a whole number.`,
        indexesEntry.keyPos,
        `Write  type = "int"  on [knobs.${name}], or drop its \`indexes\` line.`,
      );
    } else {
      indexes = indexesEntry.value.value as KnobIndexKind;
    }
  }

  const docEntry = tableGet(t, "doc");
  if (docEntry !== undefined && docEntry.value.kind !== "string") {
    s.error("bad-manifest", `knob \`${name}\`'s \`doc\` must be a string.`, docEntry.keyPos);
  }

  const defaultEntry = tableGet(t, "default");
  if (defaultEntry !== undefined && !valueFitsType(defaultEntry.value, type)) {
    s.error(
      "bad-manifest",
      `knob \`${name}\` is declared \`${type}\` but its default is ${describeKind(defaultEntry.value)}.`,
      defaultEntry.keyPos,
    );
    return null;
  }

  for (const e of tableEntries(t)) {
    if (!["type", "default", "min", "max", "doc", "indexes"].includes(e.key)) {
      s.error(
        "bad-manifest",
        `knob \`${name}\` has no field \`${e.key}\`.`,
        e.keyPos,
        "A knob declares type, default, min, max, doc and indexes.",
      );
    }
  }

  const spec: {
    name: string;
    type: KnobType;
    default?: TomlValue;
    min?: number;
    max?: number;
    doc?: string;
    indexes?: KnobIndexKind;
    pos: Pos;
  } = { name, type, pos: t.pos };
  if (defaultEntry !== undefined) spec.default = defaultEntry.value;
  if (min !== null) spec.min = min;
  if (max !== null) spec.max = max;
  if (docEntry !== undefined && docEntry.value.kind === "string") spec.doc = docEntry.value.value;
  if (indexes !== null) spec.indexes = indexes;
  return spec;
}

/**
 * A file name a module may name: no directory, no leading dot.
 *
 * A module's files live inside its own directory, full stop. A `..` or an
 * absolute path in a manifest would let a published module read a file its
 * author never shipped, and would put a machine-specific path into a build that
 * is supposed to be reproducible anywhere.
 */
function isPlainFileName(name: string): boolean {
  return name !== "" && !/[\\/]/.test(name) && !name.startsWith(".");
}

/** Whether a TOML value can be a value of a knob of this type. */
export function valueFitsType(v: TomlValue, type: KnobType): boolean {
  switch (type) {
    // `fixed` accepts an integer too: `gravity = 1` is a perfectly good 1.0, and
    // refusing it would make an author write `1.0` to satisfy a distinction the
    // console does not have.
    case "fixed":
      return v.kind === "float" || v.kind === "integer";
    case "int":
      return v.kind === "integer";
    case "bool":
      return v.kind === "boolean";
  }
}

/**
 * Parse one `module.toml`.
 *
 * Reports as much as it can before giving up: an author fixing a manifest wants
 * every complaint at once, not one per run.
 */
export function parseManifest(file: string, text: string): ManifestResult {
  const s = new Sink(file);
  const parsed = parseToml(text);
  if (!parsed.ok) {
    const { message, line, column, suggestion } = parsed.error;
    return {
      ok: false,
      diagnostics: [
        diag(
          suggestion === undefined
            ? { code: "malformed-toml", message: `this manifest is not valid TOML: ${message}`, file, line, column }
            : {
                code: "malformed-toml",
                message: `this manifest is not valid TOML: ${message}`,
                file,
                line,
                column,
                suggestion,
              },
        ),
      ],
    };
  }
  const root = parsed.root;

  const moduleEntry = tableGet(root, "module");
  if (moduleEntry === undefined || moduleEntry.value.kind !== "table") {
    s.error(
      "bad-manifest",
      "a manifest starts with a [module] table saying what this module is.",
      moduleEntry?.keyPos ?? root.pos,
      'Add:\n  [module]\n  kind    = "engine"\n  name    = "platformer"\n  version = "1.0.0"',
    );
    return { ok: false, diagnostics: s.items };
  }
  const mod = moduleEntry.value;

  const kindText = stringField(s, mod, "kind", "It says what this module is.", 'kind = "engine"');
  const name = stringField(s, mod, "name", "It is how a recipe refers to this module.", 'name = "platformer"');
  const version = stringField(s, mod, "version", "A recipe pins a version, forever.", 'version = "1.0.0"');

  let kind: ModuleKind | null = null;
  if (kindText !== null) {
    if (!(MODULE_KINDS as readonly string[]).includes(kindText)) {
      s.error(
        "bad-manifest",
        `kind "${kindText}" is not a module kind.`,
        (tableGet(mod, "kind") as { keyPos: Pos }).keyPos,
        `The kinds are ${MODULE_KINDS.join(", ")}.`,
      );
    } else {
      kind = kindText as ModuleKind;
    }
  }
  if (name !== null && parseRef(`${name}@0`) === null) {
    s.error(
      "bad-manifest",
      `name "${name}" cannot be used in a recipe reference.`,
      (tableGet(mod, "name") as { keyPos: Pos }).keyPos,
      "A module name is lower-case letters, digits and hyphens, starting with a letter or digit.",
    );
  }
  if (version !== null && name !== null && parseRef(`${name}@${version}`) === null) {
    s.error(
      "bad-manifest",
      `version "${version}" cannot be used in a recipe reference.`,
      (tableGet(mod, "version") as { keyPos: Pos }).keyPos,
      "A version is dotted numbers, optionally followed by -something: 1, 1.0, 1.0.0, 2.1.0-rc1.",
    );
  }

  const abiEntry = tableGet(mod, "abi_minor");
  let abiMinor = 0;
  if (abiEntry !== undefined) {
    if (
      abiEntry.value.kind !== "integer" ||
      abiEntry.value.value < 0 ||
      abiEntry.value.value > 0xffff
    ) {
      s.error(
        "bad-manifest",
        "`abi_minor` must be a whole number from 0 to 65535.",
        abiEntry.keyPos,
      );
    } else {
      abiMinor = abiEntry.value.value;
    }
  }

  // --- [provides] ---------------------------------------------------------
  const providesEntry = tableGet(root, "provides");
  let provides: TomlTable | null = null;
  let dataFile: { name: string; pos: Pos } | null = null;
  if (providesEntry !== undefined) {
    if (providesEntry.value.kind !== "table") {
      s.error("bad-manifest", "[provides] must be a table.", providesEntry.keyPos);
    } else {
      provides = providesEntry.value;
      const data = tableGet(provides, "data");
      if (data !== undefined) {
        if (data.value.kind !== "string") {
          s.error("bad-manifest", "[provides] `data` must be a file name.", data.keyPos);
        } else if (!isPlainFileName(data.value.value)) {
          s.error(
            "bad-manifest",
            `[provides] data is ${JSON.stringify(data.value.value)}, which is not a plain file name.`,
            data.value.pos,
            "A module's files sit beside its manifest: no directories, no leading dot.",
          );
        } else {
          dataFile = { name: data.value.value, pos: data.value.pos };
        }
      }
    }
  }

  // --- [requires] ---------------------------------------------------------
  const requires: Requirement[] = [];
  const requiredKnobNames: { name: string; pos: Pos }[] = [];
  const requiresEntry = tableGet(root, "requires");
  if (requiresEntry !== undefined) {
    if (requiresEntry.value.kind !== "table") {
      s.error("bad-manifest", "[requires] must be a table.", requiresEntry.keyPos);
    } else {
      for (const e of tableEntries(requiresEntry.value)) {
        if (e.key === "knobs") {
          if (e.value.kind !== "array") {
            s.error(
              "bad-manifest",
              "`knobs` in [requires] must be an array of knob names.",
              e.keyPos,
            );
            continue;
          }
          for (const item of e.value.items) {
            if (item.kind !== "string") {
              s.error("bad-manifest", "every entry of `knobs` must be a string.", item.pos);
              continue;
            }
            requiredKnobNames.push({ name: item.value, pos: item.pos });
          }
          continue;
        }
        if (!(MODULE_KINDS as readonly string[]).includes(e.key)) {
          s.error(
            "bad-manifest",
            `[requires] names "${e.key}", which is not a module kind.`,
            e.keyPos,
            `The kinds are ${MODULE_KINDS.join(", ")}.`,
          );
          continue;
        }
        const reqKind = e.key as ModuleKind;
        if (e.value.kind === "boolean") {
          if (e.value.value) requires.push({ kind: reqKind, constraints: [], pos: e.keyPos });
          continue;
        }
        if (e.value.kind !== "table") {
          s.error(
            "bad-manifest",
            `[requires] ${e.key} must be \`true\` or an inline table of constraints, ` +
              `but is ${describeKind(e.value)}.`,
            e.keyPos,
            `Write it as  ${e.key} = true   or   ${e.key} = { min_tiles = 64 }`,
          );
          continue;
        }
        requires.push({
          kind: reqKind,
          constraints: tableEntries(e.value).map((c) => ({ key: c.key, value: c.value })),
          pos: e.keyPos,
        });
      }
    }
  }

  // --- [knobs.*] ----------------------------------------------------------
  const knobs: KnobSpec[] = [];
  const knobsEntry = tableGet(root, "knobs");
  if (knobsEntry !== undefined) {
    if (knobsEntry.value.kind !== "table") {
      s.error("bad-manifest", "[knobs] must hold one [knobs.<name>] table per knob.", knobsEntry.keyPos);
    } else {
      for (const e of tableEntries(knobsEntry.value)) {
        if (e.value.kind !== "table") {
          s.error(
            "bad-manifest",
            `knob \`${e.key}\` must be a table, but is ${describeKind(e.value)}.`,
            e.keyPos,
            `Write it as  [knobs.${e.key}]  with type, default, min, max and doc under it.`,
          );
          continue;
        }
        const knob = parseKnob(s, e.key, e.value);
        if (knob !== null) knobs.push(knob);
      }
    }
  }
  for (const wanted of requiredKnobNames) {
    if (!knobs.some((k) => k.name === wanted.name)) {
      s.error(
        "bad-manifest",
        `[requires] lists knob \`${wanted.name}\`, which this manifest does not declare.`,
        wanted.pos,
        `Add a [knobs.${wanted.name}] table, or remove it from [requires].`,
      );
    }
  }

  // --- [files] ------------------------------------------------------------
  const files = new Map<string, { name: string; pos: Pos }>();
  const filesEntry = tableGet(root, "files");
  if (filesEntry !== undefined) {
    if (filesEntry.value.kind !== "table") {
      s.error("bad-manifest", "[files] must be a table.", filesEntry.keyPos);
    } else {
      for (const e of tableEntries(filesEntry.value)) {
        if (FILE_ROLES[e.key] === undefined) {
          s.error(
            "bad-manifest",
            `[files] names "${e.key}", which is not a cart chunk this container has.`,
            e.keyPos,
            `The roles are ${Object.keys(FILE_ROLES).sort().join(", ")}.`,
          );
          continue;
        }
        if (e.value.kind !== "string") {
          s.error("bad-manifest", `[files] ${e.key} must be a file name.`, e.keyPos);
          continue;
        }
        const fileName = e.value.value;
        if (!isPlainFileName(fileName)) {
          s.error(
            "bad-manifest",
            `[files] ${e.key} is ${JSON.stringify(fileName)}, which is not a plain file name.`,
            e.value.pos,
            "A module's files sit beside its manifest: no directories, no leading dot.",
          );
          continue;
        }
        files.set(e.key, { name: fileName, pos: e.value.pos });
      }
    }
  }

  // --- [tuning] -----------------------------------------------------------
  const tuningEntry = tableGet(root, "tuning");
  let tuning: TomlTable | null = null;
  if (tuningEntry !== undefined) {
    if (tuningEntry.value.kind !== "table") {
      s.error("bad-manifest", "[tuning] must be a table of knob values.", tuningEntry.keyPos);
    } else {
      tuning = tuningEntry.value;
    }
  }

  // --- other top-level tables --------------------------------------------
  // `[names]` and `[sizes]` are ADVISORY: an art pack lists what each tile or
  // sprite index is so a person writing a recipe -- or a tool completing one --
  // does not have to open the art to find out which tile is the floor. The
  // stamper reads neither, and refusing them would refuse every real pack.
  //
  // Anything else is a WARNING rather than an error. A section this tool does
  // not know is most often a manifest from a later version of the format, and a
  // build refused for a section nobody reads would be the wrong trade -- but a
  // mistyped `[knob.gravity]` silently doing nothing would be worse, so it is
  // said out loud.
  const KNOWN = ["module", "provides", "requires", "knobs", "files", "tuning"];
  const ADVISORY = ["names", "sizes"];
  for (const e of tableEntries(root)) {
    if (KNOWN.includes(e.key) || ADVISORY.includes(e.key)) continue;
    s.items.push(
      diag({
        severity: "warning",
        code: "bad-manifest",
        message: `this manifest has a [${e.key}] section, which the stamper does not read.`,
        file,
        line: e.keyPos.line,
        column: e.keyPos.column,
        suggestion:
          `The sections it reads are ${KNOWN.map((k) => `[${k}]`).join(", ")}; ` +
          `[names] and [sizes] are advisory.`,
      }),
    );
  }

  if (s.failed || kind === null || name === null || version === null) {
    return { ok: false, diagnostics: s.items };
  }

  return {
    ok: true,
    manifest: {
      kind,
      name,
      version,
      abiMinor,
      provides,
      requires,
      knobs,
      files,
      dataFile,
      tuning,
      file,
    },
    diagnostics: s.items,
  };
}
