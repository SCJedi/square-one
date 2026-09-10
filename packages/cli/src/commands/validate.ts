/**
 * `sq1 validate <file>` -- decode a cart and say what is wrong with it.
 *
 * This command also owns the step every other reading command starts with:
 * turn a path into either a decoded cart or a diagnosis a human can act on.
 * `hash` and `inspect` are that step plus a presentation, and they import
 * `loadCart` from here rather than growing their own copy of it -- three
 * copies of a decoder's error rendering is three chances for them to disagree
 * about what a `truncated` cart looks like.
 *
 * WHAT AN UNKNOWN ANCILLARY CHUNK MEANS HERE
 * ------------------------------------------
 * It is reported, and it is not a failure. The container's uppercase/lowercase
 * rule exists precisely so that a cart carrying something this version has
 * never heard of still plays; a tool that printed WARNING over it would teach
 * authors to fear the mechanism that keeps their carts loadable in 2032. So
 * the line says the chunk was skipped, and the exit code stays 0.
 */

import { cartIdOf, decode, isKnown } from "@sq1/cart";
import type { CartFile } from "@sq1/cart";

import type { CommandIO, ParsedArgs } from "../args";
import { operand } from "../args";

/** What a chunk type is called in a report, with the padding made visible. */
export function showType(type: string): string {
  return type === type.trim() ? type : `"${type}"`;
}

/** `0x0040`. Offsets are always hex, because the format is binary. */
export function hex(n: number): string {
  const v = Math.max(0, Math.floor(n));
  return "0x" + v.toString(16).toUpperCase().padStart(4, "0");
}

/** A decoded cart, with the bytes it came from -- the id is a hash of those. */
export interface LoadedCart {
  readonly bytes: Uint8Array;
  readonly cart: CartFile;
}

export type LoadResult =
  | { readonly ok: true; readonly loaded: LoadedCart }
  /** `report` is the whole message, newline-terminated, ready for stderr. */
  | { readonly ok: false; readonly report: string };

/**
 * Read a path and decode it.
 *
 * Missing files are answered before reading, so the message is "no file at
 * hello.cart" rather than whatever the platform calls errno 2.
 */
export function loadCart(io: CommandIO, path: string): LoadResult {
  if (!io.exists(path)) {
    return {
      ok: false,
      report: `no file at ${path}\nBuild one first: sq1 build <dir> --out ${path}\n`,
    };
  }
  const bytes = io.readFile(path);
  const result = decode(bytes);
  if (!result.ok) {
    const at = result.error.offset === undefined ? "" : ` at ${hex(result.error.offset)}`;
    return {
      ok: false,
      report: `${path}: ${result.error.code}${at}\n  ${result.error.message}\n`,
    };
  }
  return { ok: true, loaded: { bytes, cart: result.cart } };
}

/**
 * The id of a cart that was read from disk.
 *
 * `cartIdOf` rather than `cartId`: the file has already been decoded, and the
 * identity is defined over the canonical re-encoding, so a file whose chunks
 * arrived in an odd order still answers with the id of the cart it holds. It
 * also excludes the `sign` chunk, which cannot cover itself.
 */
export function idOf(loaded: LoadedCart): string {
  return cartIdOf(loaded.cart);
}

export function validateCommand(args: ParsedArgs, io: CommandIO): number {
  const path = operand(args, "validate", "<file>");
  const result = loadCart(io, path);
  if (!result.ok) {
    io.err(result.report);
    return 1;
  }

  const { bytes, cart } = result.loaded;
  const lines = [
    `${path}: ok`,
    `  spec    ${cart.specMajor}.${cart.specMinor}`,
    `  size    ${bytes.length} bytes`,
    `  chunks  ${cart.chunks.length}`,
  ];

  // Not a warning. A cart carrying a chunk this version has never heard of is
  // exactly the case the ancillary rule was written for, and it plays.
  const unknown = cart.chunks.filter((c) => !isKnown(c.type));
  for (const c of unknown) {
    lines.push(
      `  skipped ${showType(c.type)}, ${c.data.length} bytes: a chunk this version does not know.`,
      `          Ancillary, so a player ignores it and runs the cart.`,
    );
  }

  io.out(lines.join("\n") + "\n");
  return 0;
}
