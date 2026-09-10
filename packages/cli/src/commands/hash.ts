/**
 * `sq1 hash <file>` -- print a cart's id, and nothing else.
 *
 * Nothing else is the whole specification of this command's stdout. It exists
 * to be the right-hand side of a pipe:
 *
 *   test "$(sq1 hash a.cart)" = "$(sq1 hash b.cart)"
 *
 * so a size, a title, or a friendly "id:" prefix would each break every caller.
 * Diagnostics go to stderr; the id, one line, goes to stdout.
 *
 * The id is a hash of the CANONICAL encoding, not of the file as it arrived.
 * Two files whose bytes differ only in chunk order or padding hold the same
 * cart and must hash the same, otherwise reproducible builds mean nothing --
 * so `cartId` is handed the decoded cart's canonical bytes rather than the
 * bytes on disk.
 */

import { formatId } from "@sq1/cart";

import type { CommandIO, ParsedArgs } from "../args";
import { operand, UsageError } from "../args";
import { idOf, loadCart } from "./validate";

/** The two things `--format` may say. */
const FORMATS = ["short", "long"] as const;

export function hashCommand(args: ParsedArgs, io: CommandIO): number {
  const path = operand(args, "hash", "<file>");

  const raw = args.flags.get("format");
  const format = raw === undefined || raw === true ? "short" : raw;
  if (!(FORMATS as readonly string[]).includes(format)) {
    throw new UsageError(
      `--format takes ${FORMATS.join(" or ")}, not "${format}".\n` +
        `short is the 32 characters an id is; long is the four groups of eight it is read aloud as.`,
    );
  }

  const result = loadCart(io, path);
  if (!result.ok) {
    io.err(result.report);
    return 1;
  }

  const id = idOf(result.loaded);
  io.out(`${format === "long" ? formatId(id) : id}\n`);
  return 0;
}
