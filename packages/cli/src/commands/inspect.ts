/**
 * `sq1 inspect <file>` -- everything the container knows about a cart, laid
 * out to be read.
 *
 * This is the command someone reaches for when a cart will not load, which
 * sets the bar: the answer has to be visible without counting characters. So
 * columns are aligned to their contents, offsets are hex because the format is
 * binary, sizes are decimal because budgets are decimal, and an unknown chunk
 * is labelled in words rather than left for the reader to notice by absence.
 *
 * WHERE THE OFFSETS COME FROM
 * ---------------------------
 * The header carries a chunk directory -- that is what `index_offset` points
 * at -- so the offsets printed here are read out of the file itself rather
 * than recomputed from the decoded chunks. A file whose directory disagreed
 * with its contents is exactly the file someone is inspecting, and a column of
 * numbers this tool had derived from the cart it wished it had would hide
 * that. When the directory cannot be read, the column says so instead of
 * guessing.
 */

import { countTokens, TokenizeError } from "@sq1/core";
import {
  decodeMeta,
  isCritical,
  isKnown,
  DIRECTORY_ENTRY_BYTES,
  HEADER_BYTES,
  MAGIC,
  MAX_CART_BYTES,
} from "@sq1/cart";

import type { CommandIO, ParsedArgs } from "../args";
import { operand } from "../args";
import { TOKEN_BUDGET } from "./build";
import { hex, idOf, loadCart, showType } from "./validate";

/** One directory entry as it is written in the file. */
interface DirEntry {
  readonly type: string;
  readonly offset: number;
  readonly length: number;
}

const decoder = new TextDecoder("utf-8", { fatal: false });

/**
 * Read the chunk directory the header points at.
 *
 * Returns null rather than throwing for anything that does not add up. This
 * runs on a file that has already decoded, so a failure here means the layout
 * is one this version of the tool does not lay out the same way -- worth a
 * softer column, not a crash.
 */
export function readDirectory(bytes: Uint8Array): DirEntry[] | null {
  if (bytes.length < HEADER_BYTES) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint32(8, true);
  const index = view.getUint32(12, true);
  const end = index + count * DIRECTORY_ENTRY_BYTES;
  if (count > MAX_CART_BYTES / DIRECTORY_ENTRY_BYTES) return null;
  if (index < HEADER_BYTES || end > bytes.length) return null;

  const entries: DirEntry[] = [];
  for (let i = 0; i < count; i++) {
    const at = index + i * DIRECTORY_ENTRY_BYTES;
    let type = "";
    for (let k = 0; k < 4; k++) type += String.fromCharCode(bytes[at + k] as number);
    entries.push({ type, offset: view.getUint32(at + 4, true), length: view.getUint32(at + 8, true) });
  }
  return entries;
}

/** Right-pad every cell in a column to the width of its widest member. */
function table(rows: readonly string[][], align: readonly ("l" | "r")[]): string[] {
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, cell.length);
    });
  }
  return rows.map((row) =>
    row
      .map((cell, i) => {
        const w = widths[i] ?? 0;
        return (align[i] ?? "l") === "r" ? cell.padStart(w) : cell.padEnd(w);
      })
      .join("  ")
      .trimEnd(),
  );
}

export function inspectCommand(args: ParsedArgs, io: CommandIO): number {
  const path = operand(args, "inspect", "<file>");
  const result = loadCart(io, path);
  if (!result.ok) {
    io.err(result.report);
    return 1;
  }
  const { bytes, cart } = result.loaded;
  const lines: string[] = [];

  lines.push(
    ...table(
      [
        ["file", path],
        ["size", `${bytes.length} of ${MAX_CART_BYTES} bytes`],
        // The magic and the spec version are the first eight bytes of the
        // file, printed so this dump can be read next to a hex editor.
        ["magic", MAGIC],
        ["spec", `${cart.specMajor}.${cart.specMinor}`],
        ["id", idOf(result.loaded)],
      ],
      ["l", "l"],
    ),
  );

  // --- chunks --------------------------------------------------------------
  const dir = readDirectory(bytes);
  const usable =
    dir !== null &&
    dir.length === cart.chunks.length &&
    dir.every((e, i) => e.type === cart.chunks[i]?.type);

  lines.push("", `chunks  ${cart.chunks.length}`);
  const rows: string[][] = [["", "type", "offset", "bytes", "class", ""]];
  cart.chunks.forEach((c, i) => {
    rows.push([
      `${i}`,
      showType(c.type),
      usable ? hex((dir as DirEntry[])[i]?.offset ?? 0) : "-",
      `${c.data.length}`,
      isCritical(c.type) ? "critical" : "ancillary",
      isKnown(c.type)
        ? ""
        : isCritical(c.type)
          ? "UNKNOWN - a player refuses this cart"
          : "UNKNOWN - a player skips this chunk and runs the cart",
    ]);
  });
  lines.push(...table(rows, ["r", "l", "r", "r", "l", "l"]).map((l) => `  ${l}`));
  if (!usable) {
    lines.push(
      "  offsets are unavailable: this file's chunk directory does not describe its chunks.",
    );
  }

  // --- meta ----------------------------------------------------------------
  const metaChunk = cart.chunks.find((c) => c.type === "META");
  lines.push("", "meta");
  if (metaChunk === undefined) {
    lines.push("  (no META chunk)");
  } else {
    const decoded = decodeMeta(metaChunk.data);
    if (!decoded.ok) {
      lines.push(`  unreadable  ${decoded.error.code}: ${decoded.error.message}`);
    } else {
      const meta = decoded.meta;
      lines.push(
        ...table(
          [
            ["title", meta.title],
            ["author", meta.author],
            ["profile", meta.profile],
            ["payload", meta.payload],
            ["abi", `minor ${meta.abiMinor}`],
            ["spec", `${meta.specMajor}.${meta.specMinor}`],
          ],
          ["l", "l"],
        ).map((l) => `  ${l}`),
      );
    }
  }

  // --- code ----------------------------------------------------------------
  const codeChunk = cart.chunks.find((c) => c.type === "CODE");
  lines.push("", "code");
  if (codeChunk === undefined) {
    lines.push("  (no CODE chunk)");
  } else {
    let tokens: string;
    try {
      const count = countTokens(decoder.decode(codeChunk.data));
      tokens =
        count > TOKEN_BUDGET
          ? `${count} of ${TOKEN_BUDGET}  OVER BUDGET by ${count - TOKEN_BUDGET}`
          : `${count} of ${TOKEN_BUDGET}`;
    } catch (e) {
      tokens =
        e instanceof TokenizeError
          ? `uncountable: ${e.message}`
          : `uncountable: ${e instanceof Error ? e.message : String(e)}`;
    }
    lines.push(
      ...table(
        [
          ["bytes", `${codeChunk.data.length}`],
          ["tokens", tokens],
        ],
        ["l", "l"],
      ).map((l) => `  ${l}`),
    );
  }

  io.out(lines.join("\n") + "\n");
  return 0;
}
