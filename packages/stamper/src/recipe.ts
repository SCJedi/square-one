/**
 * The recipe: THE SOURCE. The cart is the build artifact.
 *
 * Recipes go in git; carts go in the registry (specification 8.2). This file
 * turns forty lines of TOML into a checked structure, and refuses anything it
 * cannot check.
 *
 *     [cart]
 *     title   = "Cave Runner"
 *     author  = "eric"
 *     profile = "up"
 *     spec    = 1
 *
 *     [engine]
 *     use = "platformer@1.0.0"
 *
 *     [modules]
 *     palette = "sweetie16@1.0.0"
 *     tileset = "caves@1.0.0"
 *
 *     [tuning]
 *     gravity       = 0.42
 *     jump_velocity = -3.1
 *
 * WHY A MODULE REFERENCE IS `name@version` AND NEVER A PATH
 * ----------------------------------------------------------
 * A cart records what it was built from so that anyone can rebuild it and
 * compare the id -- that is what makes "this cart is what its recipe claims" a
 * fact rather than a promise. `./art/caves.toml` is a fact about one machine's
 * disk: it does not survive being published, it is not the same string on
 * Windows and on Linux, and it would put a directory layout inside a content
 * hash. So a reference is a name and a version, resolved against a module root
 * the tool is told about, and the recipe never learns where that root is.
 *
 * ORDER IS MEANING
 * ----------------
 * `[modules]` is read in SOURCE order, because layers merge in declared order
 * and later keys win (specification 8.2). Two recipes that list the same
 * modules in different orders are two different recipes, and this parser keeps
 * that distinction rather than sorting it away.
 */

import { diag, type Diagnostic } from "./diagnostics";
import { MODULE_KINDS, parseRef, type ModuleKind, type ModuleRef } from "./manifest";
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

/** The one profile this specification version defines. */
export const PROFILE = "up";

/** The one spec generation a recipe may declare. */
export const RECIPE_SPEC = 1;

/** The payload types META may declare. `wasm/1` is reserved, not implemented. */
export const PAYLOADS = ["script/js1", "wasm/1"] as const;

export interface RecipeCart {
  readonly title: string;
  readonly author: string;
  readonly profile: string;
  readonly payload: (typeof PAYLOADS)[number];
  readonly spec: number;
  readonly pos: Pos;
}

/** One `[modules]` entry, or the `[engine] use` line, in declared order. */
export interface RecipeModule {
  readonly kind: ModuleKind;
  readonly ref: ModuleRef;
  readonly pos: Pos;
}

/** One `[tuning]` line: a knob name and the value the author wrote. */
export interface RecipeTuning {
  readonly name: string;
  readonly value: TomlValue;
  readonly pos: Pos;
}

export interface Recipe {
  /** The path the recipe was read from. Appears in every diagnostic about it. */
  readonly file: string;
  /**
   * The recipe source, LF-normalised.
   *
   * Kept verbatim so the `rcpe` chunk can carry it and a cart decompiles back
   * to the editable recipe it was built from. Normalised because a CRLF
   * checkout and an LF checkout of the same recipe must build the same cart.
   */
  readonly text: string;
  readonly cart: RecipeCart;
  /** The engine, which every cart has exactly one of. */
  readonly engine: RecipeModule;
  /** `[modules]`, in SOURCE order, which is the order they layer in. */
  readonly modules: readonly RecipeModule[];
  /** `[tuning]`, in source order. */
  readonly tuning: readonly RecipeTuning[];
  /** Where `[tuning]` is, or where it would go -- an unbound knob points here. */
  readonly tuningPos: Pos;
}

export type RecipeResult =
  | { ok: true; recipe: Recipe; diagnostics: readonly Diagnostic[] }
  | { ok: false; diagnostics: readonly Diagnostic[] };

class Sink {
  readonly items: Diagnostic[] = [];
  #errors = 0;
  constructor(readonly file: string) {}
  error(
    code: Parameters<typeof diag>[0]["code"],
    message: string,
    pos: Pos,
    suggestion?: string,
  ): void {
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

/** A `name@version` string value, or a diagnostic naming the shape it wanted. */
function refValue(s: Sink, key: string, value: TomlValue): ModuleRef | null {
  if (value.kind !== "string") {
    s.error(
      "bad-module-ref",
      `\`${key}\` must be a module reference, but is ${describeKind(value)}.`,
      value.pos,
      `Write it as  ${key} = "somename@1.0.0"`,
    );
    return null;
  }
  const ref = parseRef(value.value);
  if (ref === null) {
    const looksLikePath = /[\\/]/.test(value.value) || value.value.startsWith(".");
    s.error(
      "bad-module-ref",
      `${formatValue(value)} is not a module reference.`,
      value.pos,
      looksLikePath
        ? "A recipe names modules as `name@version`, never as a path -- a path is a fact about\n" +
          "one machine's disk, and a cart has to be rebuildable on any of them.\n" +
          `Write it as  ${key} = "caves@1.0.0"  and put the module under the module root.`
        : `A module reference is name@version, like  ${key} = "caves@1.0.0"`,
    );
    return null;
  }
  return ref;
}

/**
 * Parse a recipe.
 *
 * Reports everything it can see before giving up. `ok: false` means the recipe
 * could not be understood well enough to resolve; the diagnostics say why, and
 * every one of them names a line.
 */
export function parseRecipe(file: string, rawText: string): RecipeResult {
  const text = rawText.replace(/\r\n/g, "\n");
  const s = new Sink(file);

  // The recipe text travels verbatim into the cart's `rcpe` chunk, and a lone
  // surrogate has no UTF-8 encoding at all -- so it is refused here, at the one
  // door every recipe comes through, rather than thrown five stages later where
  // the message would name a chunk instead of a file. A recipe read from disk
  // cannot contain one (`TextDecoder` never emits an unpaired surrogate); a
  // caller handing `stampSource` an editor buffer can.
  const stray = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.exec(text);
  if (stray !== null) {
    const before = text.slice(0, stray.index).split("\n");
    return {
      ok: false,
      diagnostics: [
        diag({
          code: "bad-recipe",
          message: "this recipe contains an unpaired surrogate, which is not text in any encoding.",
          file,
          line: before.length,
          column: (before[before.length - 1] as string).length + 1,
          suggestion: "Save the recipe as UTF-8.",
        }),
      ],
    };
  }

  const parsed = parseToml(text);
  if (!parsed.ok) {
    const { message, line, column, suggestion } = parsed.error;
    const init = {
      code: "malformed-toml" as const,
      message: `this recipe is not valid TOML: ${message}`,
      file,
      line,
      column,
    };
    return {
      ok: false,
      diagnostics: [diag(suggestion === undefined ? init : { ...init, suggestion })],
    };
  }
  const root = parsed.root;

  // --- [cart] -------------------------------------------------------------
  const cartEntry = tableGet(root, "cart");
  let cart: RecipeCart | null = null;
  if (cartEntry === undefined || cartEntry.value.kind !== "table") {
    s.error(
      "bad-recipe",
      "a recipe starts with a [cart] table saying what is being built.",
      cartEntry?.keyPos ?? root.pos,
      'Add:\n  [cart]\n  title   = "Cave Runner"\n  author  = "your name"\n  profile = "up"\n  spec    = 1',
    );
  } else {
    cart = readCart(s, cartEntry.value);
  }

  // --- the engine ---------------------------------------------------------
  // TWO SPELLINGS, ONE MEANING. The engine is a module like any other, so
  // `[modules] engine = "..."` is the natural way to name it and is what the
  // module packs in this repository are written against. `[engine] use = "..."`
  // is the spelling in specification 8.2, which gives the engine its own table
  // because it is the one module a cart cannot do without. Both are accepted
  // and mean exactly the same thing; writing BOTH is an error, because then
  // there are two answers to "which engine is this" and no way to pick.
  let engine: RecipeModule | null = null;
  const engineEntry = tableGet(root, "engine");
  if (engineEntry !== undefined) {
    if (engineEntry.value.kind !== "table") {
      s.error(
        "bad-recipe",
        "[engine] must be a table holding one line: use = \"name@version\".",
        engineEntry.keyPos,
      );
    } else {
      const use = tableGet(engineEntry.value, "use");
      if (use === undefined) {
        s.error(
          "missing-engine",
          "[engine] has no `use`, so there is nothing to run.",
          engineEntry.value.pos,
          'Add:  use = "platformer@1.0.0"',
        );
      } else {
        const ref = refValue(s, "use", use.value);
        if (ref !== null) engine = { kind: "engine", ref, pos: use.keyPos };
      }
      for (const e of tableEntries(engineEntry.value)) {
        if (e.key !== "use") {
          s.error(
            "bad-recipe",
            `[engine] has no \`${e.key}\`.`,
            e.keyPos,
            "[engine] holds one line: use = \"name@version\".",
          );
        }
      }
    }
  }

  // --- [modules] ----------------------------------------------------------
  const modules: RecipeModule[] = [];
  const modulesEntry = tableGet(root, "modules");
  if (modulesEntry !== undefined) {
    if (modulesEntry.value.kind !== "table") {
      s.error("bad-recipe", "[modules] must be a table.", modulesEntry.keyPos);
    } else {
      for (const e of tableEntries(modulesEntry.value)) {
        if (e.key === "engine") {
          const ref = refValue(s, "engine", e.value);
          if (ref === null) continue;
          if (engine !== null) {
            s.error(
              "bad-recipe",
              "this recipe names an engine twice: once in [engine] and once in [modules].",
              e.keyPos,
              "Keep one of them. Both spellings mean the same thing.",
            );
            continue;
          }
          engine = { kind: "engine", ref, pos: e.keyPos };
          continue;
        }
        if (!(MODULE_KINDS as readonly string[]).includes(e.key)) {
          s.error(
            "bad-recipe",
            `[modules] names "${e.key}", which is not a module kind.`,
            e.keyPos,
            `The kinds a recipe may set are ${MODULE_KINDS.filter((k) => k !== "engine").join(", ")}.`,
          );
          continue;
        }
        const ref = refValue(s, e.key, e.value);
        if (ref !== null) modules.push({ kind: e.key as ModuleKind, ref, pos: e.keyPos });
      }
    }
  }

  // --- [tuning] -----------------------------------------------------------
  const tuning: RecipeTuning[] = [];
  const tuningEntry = tableGet(root, "tuning");
  // With no [tuning] table, an unbound knob still needs somewhere to point. The
  // end of the file is where the author would type one, so that is where it
  // points.
  let tuningPos: Pos = { line: text.split("\n").length, column: 1 };
  if (tuningEntry !== undefined) {
    if (tuningEntry.value.kind !== "table") {
      s.error("bad-recipe", "[tuning] must be a table of knob values.", tuningEntry.keyPos);
    } else {
      tuningPos = tuningEntry.value.pos;
      for (const e of tableEntries(tuningEntry.value)) {
        tuning.push({ name: e.key, value: e.value, pos: e.keyPos });
      }
    }
  }

  if (engine === null && engineEntry === undefined) {
    s.error(
      "missing-engine",
      "this recipe names no engine, so there is nothing to run.",
      modulesEntry?.keyPos ?? root.pos,
      'Add to [modules]:\n  engine = "platformer@1.0.0"',
    );
  }

  // --- unknown top-level tables ------------------------------------------
  const KNOWN = ["cart", "engine", "modules", "tuning"];
  for (const e of tableEntries(root)) {
    if (!KNOWN.includes(e.key)) {
      s.error(
        "bad-recipe",
        `a recipe has no [${e.key}] section.`,
        e.keyPos,
        `The sections are ${KNOWN.map((k) => `[${k}]`).join(", ")}.`,
      );
    }
  }

  if (s.failed || cart === null || engine === null) {
    return { ok: false, diagnostics: s.items };
  }
  return {
    ok: true,
    recipe: { file, text, cart, engine, modules, tuning, tuningPos },
    diagnostics: s.items,
  };
}

function readCart(s: Sink, t: TomlTable): RecipeCart | null {
  const text = (key: string, example: string): string | null => {
    const e = tableGet(t, key);
    if (e === undefined) {
      s.error("bad-recipe", `[cart] has no \`${key}\`.`, t.pos, `Add:  ${example}`);
      return null;
    }
    if (e.value.kind !== "string") {
      s.error(
        "bad-recipe",
        `\`${key}\` must be a string, but is ${describeKind(e.value)}.`,
        e.keyPos,
        `Write it as  ${example}`,
      );
      return null;
    }
    return e.value.value;
  };

  const title = text("title", 'title = "Cave Runner"');
  const author = text("author", 'author = "your name"');

  // profile and spec are optional and default to the only values they may have.
  // Requiring an author to write `profile = "up"` in every recipe would be
  // ceremony with one legal spelling; refusing any OTHER value is the part that
  // matters, because it is how a recipe from a later specification is caught
  // rather than half-built.
  let profile = PROFILE;
  const profileEntry = tableGet(t, "profile");
  if (profileEntry !== undefined) {
    if (profileEntry.value.kind !== "string") {
      s.error("bad-recipe", "`profile` must be a string.", profileEntry.keyPos);
    } else if (profileEntry.value.value !== PROFILE) {
      s.error(
        "unsupported-profile",
        `profile ${formatValue(profileEntry.value)} is not one this stamper builds.`,
        profileEntry.value.pos,
        `The Universal Profile is the only one this specification version defines:  profile = "${PROFILE}"`,
      );
    } else {
      profile = profileEntry.value.value;
    }
  }

  // The payload defaults to the one that runs today. Stating it is allowed --
  // an author who has read the container specification will -- and stating a
  // payload this stamper cannot fill is refused rather than half-built.
  let payload: (typeof PAYLOADS)[number] = "script/js1";
  const payloadEntry = tableGet(t, "payload");
  if (payloadEntry !== undefined) {
    if (
      payloadEntry.value.kind !== "string" ||
      !(PAYLOADS as readonly string[]).includes(payloadEntry.value.value)
    ) {
      s.error(
        "bad-recipe",
        `\`payload\` must be ${PAYLOADS.map((p) => `"${p}"`).join(" or ")}, but is ` +
          `${formatValue(payloadEntry.value)}.`,
        payloadEntry.keyPos,
        'Leave it out to get "script/js1", which is the one that runs today.',
      );
    } else if (payloadEntry.value.value === "wasm/1") {
      s.error(
        "bad-recipe",
        'payload "wasm/1" is reserved in the container specification and no runtime implements it.',
        payloadEntry.value.pos,
        'This stamper compiles an engine into JavaScript:  payload = "script/js1"',
      );
    } else {
      payload = payloadEntry.value.value as (typeof PAYLOADS)[number];
    }
  }

  let spec = RECIPE_SPEC;
  const specEntry = tableGet(t, "spec");
  if (specEntry !== undefined) {
    if (specEntry.value.kind !== "integer") {
      s.error("bad-recipe", "`spec` must be a whole number.", specEntry.keyPos);
    } else if (specEntry.value.value !== RECIPE_SPEC) {
      s.error(
        "unsupported-spec",
        `this recipe declares spec ${specEntry.value.value}, and this stamper builds spec ${RECIPE_SPEC}.`,
        specEntry.value.pos,
        specEntry.value.value > RECIPE_SPEC
          ? "The recipe is newer than the tool. Update the stamper."
          : `Write  spec = ${RECIPE_SPEC}`,
      );
    } else {
      spec = specEntry.value.value;
    }
  }

  for (const e of tableEntries(t)) {
    if (!["title", "author", "profile", "payload", "spec"].includes(e.key)) {
      s.error(
        "bad-recipe",
        `[cart] has no \`${e.key}\`.`,
        e.keyPos,
        "[cart] holds title, author, profile, payload and spec.",
      );
    }
  }

  if (title === null || author === null) return null;
  return { title, author, profile, payload, spec, pos: t.pos };
}
