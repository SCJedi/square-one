/**
 * `sq1 build <dir> [--out <file>]` -- turn a directory of source files into a
 * cart.
 *
 * THE SOURCE DIRECTORY
 * --------------------
 *   main.js     REQUIRED  the cart's code            -> CODE
 *   cart.json   REQUIRED  title, author, payload     -> META
 *   gfx.bin     optional  sprite sheet               -> "GFX "
 *   map.bin     optional  tile map                   -> "MAP "
 *   sfx.bin     optional  effect bank                -> "SFX "
 *   mus.bin     optional  pattern data               -> "MUS "
 *   data.bin    optional  anything the cart wants    -> DATA
 *   label.bin   optional  128x128 label image        -> labl
 *
 * Files that are not on that list are ignored, deliberately: an author keeps a
 * README, a .gitignore and a scratch sprite sheet next to their cart, and a
 * build that refused to run because of a README would be a build nobody uses.
 *
 * WHY THE OUTPUT CANNOT DEPEND ON WHERE IT WAS BUILT
 * --------------------------------------------------
 * A cart's identity is the hash of its bytes, so anything environmental
 * reaching those bytes -- a timestamp, an absolute path, a username, the
 * platform's directory separator -- would give the same source two identities
 * on two machines and make every published id unverifiable. Nothing here reads
 * a clock or an environment variable, no path is ever written into a chunk,
 * and the optional files are collected in the fixed order listed above rather
 * than in directory order, which differs by filesystem. `commands.test.ts`
 * pins this by building the same source twice from two different directories
 * and comparing the bytes.
 *
 * THE TWO BUDGETS
 * ---------------
 * The token count is checked BEFORE encoding, because "your cart is 900 tokens
 * over" is a message about main.js, and the author should get it without
 * waiting for a cart to be assembled. The size cap is checked after, because
 * it is a property of the assembled file.
 *
 * THE STATIC GATE
 * ---------------
 * `lintCartSource` in @sq1/cart holds the rule about what a cart may name, and
 * this command holds nothing but the decision to obey it: any finding refuses
 * the build, prints as `path:line:column  message`, and exits non-zero. The
 * split matters because the same rule has to be checkable by a tool that is not
 * this one -- a web editor, a CI job, a second implementation -- and a rule
 * living inside a CLI command is a rule only that CLI can apply.
 *
 * The token budget is a lint finding too, but it is reported here in its own
 * words and on its own: an author 900 tokens over does not also want a list of
 * everything else, and the count is the only number that tells them how far.
 */

import { TokenizeError } from "@sq1/core";
import {
  cartIdOf,
  encode,
  encodeMeta,
  formatId,
  lintCartSource,
  MAX_CART_BYTES,
  SPEC_MAJOR,
  SPEC_MINOR,
  TOKEN_BUDGET as CART_TOKEN_BUDGET,
} from "@sq1/cart";
import type { CartFile, LintResult } from "@sq1/cart";

import type { CommandIO, ParsedArgs } from "../args";
import { operand } from "../args";

/**
 * The Universal Profile cart budget, in tokens, from the specification's
 * section 10. Every token counts as one; the counter in `@sq1/core` is the
 * normative definition of what a token is.
 *
 * Re-exported from `@sq1/cart` rather than written again here: two constants
 * with the same name and different values is a bug nobody finds until a cart
 * builds in one tool and is refused by the other.
 */
export const TOKEN_BUDGET = CART_TOKEN_BUDGET;

/** The payload types META may declare. `wasm/1` is reserved, not implemented. */
const PAYLOADS = ["script/js1", "wasm/1"] as const;

/** Optional source files, in the order they are collected. Never directory order. */
const OPTIONAL: readonly { readonly file: string; readonly type: string }[] = [
  { file: "gfx.bin", type: "GFX " },
  { file: "map.bin", type: "MAP " },
  { file: "sfx.bin", type: "SFX " },
  { file: "mus.bin", type: "MUS " },
  { file: "data.bin", type: "DATA" },
  { file: "label.bin", type: "labl" },
];

/** Something an author can fix, phrased for an author. */
export class BuildError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BuildError";
    Object.setPrototypeOf(this, BuildError.prototype);
  }
}

/**
 * Join a directory and a file name with a forward slash.
 *
 * Written by hand rather than with `node:path` so this file stays free of
 * anything that behaves differently on two platforms -- and so the paths in
 * messages read the same in a Windows terminal as in the documentation.
 * Forward slashes are accepted by every filesystem call on every platform this
 * tool runs on.
 */
function join(dir: string, file: string): string {
  return `${dir.replace(/[\\/]+$/, "")}/${file}`;
}

/** `examples/hello` -> `examples/hello.cart`: the default output path. */
function defaultOut(dir: string): string {
  return `${dir.replace(/[\\/]+$/, "")}.cart`;
}

const decoder = new TextDecoder("utf-8", { fatal: false });
const encoder = new TextEncoder();

/** What `cart.json` is allowed to say. */
interface CartJson {
  readonly title: string;
  readonly author: string;
  readonly payload: (typeof PAYLOADS)[number];
  readonly abiMinor: number;
}

/** The shape of a valid cart.json, quoted in three different error messages. */
const EXAMPLE_JSON = '{ "title": "Hello", "author": "your name" }';

function parseCartJson(path: string, bytes: Uint8Array): CartJson {
  let value: unknown;
  try {
    value = JSON.parse(decoder.decode(bytes)) as unknown;
  } catch (e) {
    throw new BuildError(
      `${path} is not valid JSON: ${e instanceof Error ? e.message : String(e)}\n` +
        `A cart.json is one object, like ${EXAMPLE_JSON}`,
    );
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new BuildError(
      `${path} holds ${Array.isArray(value) ? "an array" : `a ${typeof value}`}, not an object.\n` +
        `A cart.json is one object, like ${EXAMPLE_JSON}`,
    );
  }
  const o = value as Record<string, unknown>;

  const text = (key: "title" | "author"): string => {
    const v = o[key];
    if (v === undefined) {
      throw new BuildError(`${path} has no "${key}". Add one, like ${EXAMPLE_JSON}`);
    }
    if (typeof v !== "string" || v.trim() === "") {
      throw new BuildError(
        `${path}: "${key}" must be a non-empty string, but is ${JSON.stringify(v)}.`,
      );
    }
    return v;
  };

  const title = text("title");
  const author = text("author");

  const rawPayload = o["payload"];
  if (rawPayload !== undefined && !(PAYLOADS as readonly unknown[]).includes(rawPayload)) {
    throw new BuildError(
      `${path}: "payload" must be ${PAYLOADS.map((p) => `"${p}"`).join(" or ")}, ` +
        `but is ${JSON.stringify(rawPayload)}.\n` +
        `Leave it out to get "script/js1", which is the one that runs today.`,
    );
  }
  const payload = (rawPayload ?? "script/js1") as CartJson["payload"];

  const rawAbi = o["abiMinor"];
  if (
    rawAbi !== undefined &&
    (typeof rawAbi !== "number" || !Number.isInteger(rawAbi) || rawAbi < 0 || rawAbi > 0xffff)
  ) {
    throw new BuildError(
      `${path}: "abiMinor" must be a whole number from 0 to 65535, ` +
        `but is ${JSON.stringify(rawAbi)}.\n` +
        `It is the lowest ABI minor version this cart needs a player to implement.`,
    );
  }
  const abiMinor = (rawAbi ?? 0) as number;

  return { title, author, payload, abiMinor };
}

/**
 * Lint main.js and count its tokens, or explain where it stopped being
 * JavaScript.
 *
 * The gate reads the whole file before anything is written, so a refusal costs
 * the author nothing to recover from: there is no half-built cart to delete.
 */
function lintCode(path: string, source: string): LintResult {
  try {
    return lintCartSource(source);
  } catch (e) {
    if (e instanceof TokenizeError) {
      throw new BuildError(
        `${path} is not valid JavaScript: ${e.message}\n` +
          `The token counter reads the whole file, so this stops the build before a cart is written.`,
      );
    }
    throw e;
  }
}

export function buildCommand(args: ParsedArgs, io: CommandIO): number {
  const dir = operand(args, "build", "<dir>");
  const outFlag = args.flags.get("out");
  const out = typeof outFlag === "string" ? outFlag : defaultOut(dir);

  try {
    if (!io.exists(dir)) {
      throw new BuildError(
        `no directory at ${dir}\n` +
          `sq1 build takes the directory holding main.js and cart.json, not the file itself.`,
      );
    }

    const codePath = join(dir, "main.js");
    const metaPath = join(dir, "cart.json");
    for (const required of [codePath, metaPath]) {
      if (!io.exists(required)) {
        throw new BuildError(
          `${required} not found\n` +
            `A cart source directory needs main.js (the code) and cart.json (the title and author).\n` +
            `${dir} holds: ${describeDir(io, dir)}`,
        );
      }
    }

    const codeBytes = io.readFile(codePath);
    const source = decoder.decode(codeBytes);
    const { findings, tokens } = lintCode(codePath, source);

    // The budget speaks alone, in its own words: it is the one finding that is
    // about how much of the cart there is rather than about what is in it.
    if (findings.some((f) => f.rule === "token-budget")) {
      throw new BuildError(
        `${codePath} is ${tokens} tokens, which is ${tokens - TOKEN_BUDGET} over the ` +
          `${TOKEN_BUDGET}-token budget.\n` +
          `Every token counts as one, including punctuation. Shorten the cart, or move ` +
          `table-shaped data out of main.js and into data.bin.`,
      );
    }

    // Every other finding, one per line, in the shape an editor can jump to:
    // path:line:column, two spaces, then the message and nothing else.
    if (findings.length > 0) {
      throw new BuildError(
        findings.map((f) => `${codePath}:${f.line}:${f.column}  ${f.message}`).join("\n"),
      );
    }

    const meta = parseCartJson(metaPath, io.readFile(metaPath));

    // `encodeMeta` throws on a title or author the container cannot hold --
    // it consumes a structure this process just built, so a bad value there is
    // a build failure, not hostile input. Re-phrased as a BuildError, because
    // the value came out of the author's cart.json and that is where they will
    // fix it.
    let metaBytes: Uint8Array;
    try {
      metaBytes = encodeMeta({
        title: meta.title,
        author: meta.author,
        profile: "up",
        payload: meta.payload,
        abiMinor: meta.abiMinor,
        specMajor: SPEC_MAJOR,
        specMinor: SPEC_MINOR,
      });
    } catch (e) {
      const why = (e instanceof Error ? e.message : String(e)).replace(/^encodeMeta: /, "");
      throw new BuildError(`${metaPath}: ${why}`);
    }

    // Chunk order here is the canonical order; `encode` fixes it regardless,
    // and building the list in that order keeps the two agreeing by eye.
    const chunks: { type: string; data: Uint8Array }[] = [
      { type: "META", data: metaBytes },
      { type: "CODE", data: codeBytes },
    ];
    for (const { file, type } of OPTIONAL) {
      const p = join(dir, file);
      if (io.exists(p)) chunks.push({ type, data: io.readFile(p) });
    }

    const cart: CartFile = { specMajor: SPEC_MAJOR, specMinor: SPEC_MINOR, chunks };
    let bytes: Uint8Array;
    try {
      bytes = encode(cart);
    } catch (e) {
      throw new BuildError(
        `${dir} could not be packed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    if (bytes.length > MAX_CART_BYTES) {
      throw new BuildError(
        `the cart is ${bytes.length} bytes, which is ${bytes.length - MAX_CART_BYTES} over the ` +
          `${MAX_CART_BYTES}-byte cart budget.\n` +
          `The largest inputs are usually gfx.bin and map.bin.`,
      );
    }

    try {
      io.writeFile(out, bytes);
    } catch (e) {
      throw new BuildError(
        `could not write ${out}: ${e instanceof Error ? e.message : String(e)}\n` +
          `The cart was built; only writing it failed. Try --out somewhere writable.`,
      );
    }

    // Three path-free lines, then the path. Everything above the last line is
    // a property of the cart itself and is identical wherever it was built.
    io.out(
      [
        `    id  ${formatId(cartIdOf(cart))}`,
        `  size  ${bytes.length} of ${MAX_CART_BYTES} bytes`,
        `tokens  ${tokens} of ${TOKEN_BUDGET}`,
        ` wrote  ${out}`,
        "",
      ].join("\n"),
    );
    return 0;
  } catch (e) {
    if (e instanceof BuildError) {
      io.err(`${e.message}\n`);
      return 1;
    }
    throw e;
  }
}

/** "main.js, README.md" -- what is actually in the directory, for a not-found message. */
function describeDir(io: CommandIO, dir: string): string {
  let names: string[];
  try {
    names = io.readDir(dir);
  } catch {
    return "(unreadable)";
  }
  if (names.length === 0) return "(nothing)";
  const shown = [...names].sort();
  return shown.length > 8 ? `${shown.slice(0, 8).join(", ")}, and ${shown.length - 8} more` : shown.join(", ");
}

/** Exported for the encoder-agnostic tests: unused by anything else. */
export { defaultOut, join };
