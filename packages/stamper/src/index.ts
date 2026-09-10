/**
 * @sq1/stamper -- a recipe in, a proved cart out.
 *
 * THE STAMPER IS NOT A CODE GENERATOR. It is a resolver and a merger, which is
 * a far more reliable class of program, and one whose failures are validation
 * errors with line numbers rather than crashes three minutes into a playtest
 * (specification section 9).
 *
 * The pipeline is seven pure functions in `stages.ts`, and this file is the
 * only thing that runs them in order:
 *
 *     resolve -> merge -> bind -> validate -> compile -> pack -> prove -> pack
 *
 * WHY `pack` APPEARS TWICE
 * ------------------------
 * `prove` gates `pack`: a cart is not written until it has been run headless
 * against a deterministic replay and its frame-hash chain recorded. The chain
 * goes into the `rcpe` chunk, so there is a chicken and an egg -- solved by
 * packing once to get bytes to run, and packing again to record what the run
 * produced. The second pack cannot change the chain, because a chain is a
 * function of CODE, the seed and the input, and `rcpe` is none of those. A test
 * pins exactly that.
 *
 * NOTHING HERE WRITES A FILE. `stamp` returns bytes; the caller decides whether
 * to write them, and only ever after this returned `ok`.
 *
 * THIS PACKAGE NEVER SHIPS TO A PLAYER. It reads manifests, hashes module
 * directories and compiles engines -- all build-time work. The dependency
 * direction in the repository is one-way and `stamper` is at the end of it.
 */

export * from "./toml";
export * from "./diagnostics";
export * from "./manifest";
export * from "./recipe";
export * from "./stages";

import { hasErrors, sortDiagnostics, diag, type Diagnostic } from "./diagnostics";
import { parseRecipe, type Recipe } from "./recipe";
import {
  bind,
  compile,
  merge,
  pack,
  prove,
  resolve,
  validate,
  DEFAULT_PROVE_FRAMES,
  DEFAULT_PROVE_SEED,
  type Payload,
  type Proof,
  type StamperIO,
} from "./stages";

export interface StampOptions {
  /** The directory holding `<name>/module.toml`. Required; never guessed. */
  readonly modulesRoot: string;
  /** Frames to prove. The specification's floor is 600, which is the default. */
  readonly frames?: number;
  /** The seed the prover boots with. Fixed, so the chain is reproducible. */
  readonly seed?: number;
}

export type StampResult =
  | {
      readonly ok: true;
      /** The cart. Not written anywhere; that is the caller's decision. */
      readonly bytes: Uint8Array;
      /** 32 Crockford base32 characters, unformatted. */
      readonly id: string;
      /** The compiled CODE, for a caller that wants to show or save it. */
      readonly source: string;
      readonly tokens: number;
      readonly proof: Proof;
      /** Warnings only -- an error would have made this `ok: false`. */
      readonly diagnostics: readonly Diagnostic[];
    }
  | { readonly ok: false; readonly diagnostics: readonly Diagnostic[] };

/** Everything found so far, sorted, as a failure. */
function stop(found: readonly Diagnostic[]): StampResult {
  return { ok: false, diagnostics: sortDiagnostics(found) };
}

/**
 * Read a recipe and stamp it.
 *
 * The one entry point. Every stage's diagnostics accumulate, and the first
 * stage that produces an ERROR is the last one that runs -- so an author gets
 * everything that stage found rather than the first thing, and no later stage
 * gets to complain about a consequence of a problem already reported.
 */
export function stamp(recipePath: string, io: StamperIO, opts: StampOptions): StampResult {
  if (!io.exists(recipePath)) {
    return stop([
      diag({
        code: "missing-recipe",
        message: `there is no recipe at ${recipePath}.`,
        file: recipePath,
        line: 1,
        column: 1,
        suggestion: "sq1 stamp takes the path of a recipe .toml file.",
      }),
    ]);
  }
  const text = new TextDecoder("utf-8", { fatal: false }).decode(io.readFile(recipePath));
  return stampSource(recipePath, text, io, opts);
}

/**
 * Stamp a recipe already in hand.
 *
 * Split out from `stamp` so a caller with an unsaved editor buffer -- or a test
 * -- can drive the whole pipeline without the recipe existing on disk. The
 * result is identical either way; `stamp` is this function plus one read.
 */
export function stampSource(
  recipePath: string,
  recipeText: string,
  io: StamperIO,
  opts: StampOptions,
): StampResult {
  const found: Diagnostic[] = [];

  const parsed = parseRecipe(recipePath, recipeText);
  found.push(...parsed.diagnostics);
  if (!parsed.ok) return stop(found);
  const recipe: Recipe = parsed.recipe;

  const resolved = resolve(recipe, io, { modulesRoot: opts.modulesRoot });
  found.push(...resolved.diagnostics);
  if (hasErrors(resolved.diagnostics) || resolved.engine === null) return stop(found);

  const merged = merge(resolved);
  found.push(...merged.diagnostics);
  if (hasErrors(merged.diagnostics)) return stop(found);

  const bound = bind(merged);
  found.push(...bound.diagnostics);
  if (hasErrors(bound.diagnostics)) return stop(found);

  const validated = validate(bound);
  found.push(...validated);
  if (hasErrors(validated)) return stop(found);

  const payload: Payload = compile(bound);
  found.push(...payload.diagnostics);
  if (hasErrors(payload.diagnostics)) return stop(found);

  // First pack: bytes to prove. Its `rcpe` carries no `prove` line yet.
  const draft = pack(payload, bound, null);
  found.push(...draft.diagnostics);
  if (hasErrors(draft.diagnostics)) return stop(found);

  const proveOpts = {
    file: recipe.file,
    pos: recipe.cart.pos,
    frames: opts.frames ?? DEFAULT_PROVE_FRAMES,
    seed: opts.seed ?? DEFAULT_PROVE_SEED,
  };
  const proved = prove(draft.bytes, proveOpts);
  found.push(...proved.diagnostics);
  if (!proved.ok) return stop(found);

  const proof: Proof = { seed: proved.seed, frames: proved.frames, chain: proved.chain };

  // Second pack: the same cart, with the proof recorded. The chain cannot have
  // changed, because `rcpe` is not part of what a chain is a function of.
  const final = pack(payload, bound, proof);
  found.push(...final.diagnostics);
  if (hasErrors(final.diagnostics)) return stop(found);

  return {
    ok: true,
    bytes: final.bytes,
    id: final.id,
    source: payload.source,
    tokens: payload.tokens,
    proof,
    diagnostics: sortDiagnostics(found),
  };
}
