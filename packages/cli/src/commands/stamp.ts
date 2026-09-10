/**
 * `sq1 stamp <recipe> [--out <file>] [--frames N] [--modules <dir>]` -- turn a
 * recipe into a proved cart.
 *
 * WHERE `build` ENDS AND `stamp` BEGINS
 * -------------------------------------
 * `sq1 build` compiles a directory an author wrote by hand: main.js, cart.json,
 * some .bin files. `sq1 stamp` assembles a cart out of MODULES, from forty
 * lines of validated data. Both write a .cart and both are reproducible; the
 * difference is that one of them type-checks the game before it exists.
 *
 * THIS FILE HOLDS NO POLICY
 * -------------------------
 * Every decision lives in `@sq1/stamper`: what a recipe is, what a knob is,
 * what makes a build fail. This command reads a path, calls `stamp`, prints
 * what came back, and writes the bytes if there are any. That split is the same
 * one `build.ts` makes with `lintCartSource`, and for the same reason -- the
 * rules have to be applicable by a tool that is not this one (a web editor, a
 * CI job, a second implementation), and a rule living inside a CLI command is a
 * rule only that CLI can apply.
 *
 * WHY THE CART IS WRITTEN LAST
 * ----------------------------
 * `stamp` proves the cart before it returns it: a headless run of 600 frames
 * against a deterministic replay, with the frame-hash chain recorded into the
 * `rcpe` chunk. Nothing is written until that has passed, so a failed stamp
 * leaves no half-built cart to delete.
 */

import { formatDiagnostics, stamp, type StampOptions } from "@sq1/stamper";
import { formatId, MAX_CART_BYTES, TOKEN_BUDGET } from "@sq1/cart";

import type { CommandIO, ParsedArgs } from "../args";
import { operand, UsageError } from "../args";

/** The file name a recipe directory is expected to hold. */
export const RECIPE_FILE = "recipe.toml";

/** `examples/cave.toml` -> `examples/cave.cart`: the default output path. */
export function defaultOut(recipe: string): string {
  return `${recipe.replace(/[\\/]+$/, "").replace(/\.toml$/i, "")}.cart`;
}

/**
 * The recipe file the operand names.
 *
 * A recipe may be given as the file itself or as the DIRECTORY holding it, the
 * way `sq1 build` takes a source directory. `examples/cave-runner` is what a
 * game is called; `examples/cave-runner/recipe.toml` is where its text happens
 * to live, and an author should not have to type the second to mean the first.
 * The output name follows the operand either way, so
 * `sq1 stamp examples/cave-runner` writes `examples/cave-runner.cart`.
 */
export function resolveRecipePath(io: CommandIO, operandPath: string): string {
  const trimmed = operandPath.replace(/[\\/]+$/, "");
  const inside = `${trimmed}/${RECIPE_FILE}`;
  return io.exists(inside) ? inside : trimmed;
}

/** Everything before the last slash, or "" when there is none. */
function dirOf(path: string): string {
  const cut = path.replace(/\\/g, "/").lastIndexOf("/");
  return cut < 0 ? "" : path.replace(/\\/g, "/").slice(0, cut);
}

/**
 * The module root: the nearest `modules/` at or above the recipe.
 *
 * Recipes live next to the module tree they draw on, and asking every author to
 * pass `--modules` on every invocation would be ceremony. Walking upward finds
 * it from anywhere inside a project, and `--modules` overrides when the tree is
 * somewhere else.
 *
 * NONE OF THIS REACHES THE CART. A module is recorded as `name@version` plus a
 * content hash, never as a path, so where the root was found cannot change a
 * single byte of the output -- which is what lets this be a convenience rather
 * than a reproducibility hazard.
 */
export function findModulesRoot(io: CommandIO, recipe: string): string {
  let dir = dirOf(recipe);
  for (let up = 0; up < 8; up++) {
    const candidate = dir === "" ? "modules" : `${dir}/modules`;
    if (io.exists(candidate)) return candidate;
    if (dir === "") break;
    const cut = dir.lastIndexOf("/");
    dir = cut <= 0 ? "" : dir.slice(0, cut);
  }
  return "modules";
}

/** A positive whole number from a flag, or a UsageError naming the flag. */
function positiveInt(flag: string, raw: string): number {
  if (!/^[0-9]+$/.test(raw)) {
    throw new UsageError(
      `--${flag} must be a whole number, but is "${raw}".\n` + `Write it as \`--${flag} 600\`.`,
    );
  }
  const n = Number(raw);
  if (n < 1) {
    throw new UsageError(
      `--${flag} must be at least 1, but is ${n}.\n` +
        `A cart is proved by running it; zero frames prove nothing.`,
    );
  }
  return n;
}

export function stampCommand(args: ParsedArgs, io: CommandIO): number {
  const named = operand(args, "stamp", "<recipe>");
  const recipe = resolveRecipePath(io, named);
  const outFlag = args.flags.get("out");
  const out = typeof outFlag === "string" ? outFlag : defaultOut(named);

  const modulesFlag = args.flags.get("modules");
  const modulesRoot =
    typeof modulesFlag === "string" ? modulesFlag : findModulesRoot(io, recipe);

  const framesFlag = args.flags.get("frames");
  const options: StampOptions =
    typeof framesFlag === "string"
      ? { modulesRoot, frames: positiveInt("frames", framesFlag) }
      : { modulesRoot };

  const result = stamp(recipe, io, options);

  if (!result.ok) {
    // One block per diagnostic, in file/line/column order, each naming the file
    // to open and the fix to make. Nothing was written.
    io.err(formatDiagnostics(result.diagnostics));
    return 1;
  }

  // Warnings do not refuse the build, and they still have to be seen.
  if (result.diagnostics.length > 0) io.err(formatDiagnostics(result.diagnostics));

  try {
    io.writeFile(out, result.bytes);
  } catch (e) {
    io.err(
      `could not write ${out}: ${e instanceof Error ? e.message : String(e)}\n` +
        `The cart was built and proved; only writing it failed. Try --out somewhere writable.\n`,
    );
    return 1;
  }

  // Four path-free lines, then the path. Everything above the last line is a
  // property of the cart itself and is identical wherever it was stamped.
  io.out(
    [
      `    id  ${formatId(result.id)}`,
      `  size  ${result.bytes.length} of ${MAX_CART_BYTES} bytes`,
      `tokens  ${result.tokens} of ${TOKEN_BUDGET}`,
      `proved  ${result.proof.frames} frames, chain ${result.proof.chain}`,
      ` wrote  ${out}`,
      "",
    ].join("\n"),
  );
  return 0;
}
