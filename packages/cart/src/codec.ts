/**
 * The cart container codec. `decode` is the adversarial surface.
 *
 * A cart arrives from a stranger on the internet. This file is the only place
 * in Square One where bytes nobody vouched for meet parsing code, so it is
 * written to one absolute rule:
 *
 *      decode() NEVER THROWS.
 *
 * Not on zero bytes, not on a truncated header, not on a chunk that declares
 * 0xffffffff bytes, not on an index that points into the middle of another
 * chunk, not on 64 MB of 0xff. Every failure is a returned `CartError`. That is
 * the M2 acceptance criterion and it is held down by a 10,000-iteration fuzzer
 * in test/fuzz.test.ts.
 *
 * LAYOUT (normative for this implementation)
 * ------------------------------------------
 *   [0, 16)                          header
 *   [16, index_offset)               the chunk stream, 4-byte aligned throughout
 *   [index_offset, EOF)              the directory, chunk_count * 12 bytes
 *
 * The directory sits at the END, after the chunks, and its last byte is the
 * last byte of the file. A range-request player fetches the 16-byte header,
 * learns `index_offset` and `chunk_count`, fetches the directory, and then
 * range-requests only the chunks it wants -- which is the whole reason the
 * directory exists as a separate structure. Fixing it at the end means a cart
 * has exactly ONE valid byte layout for a given set of chunks in a given order,
 * and "exactly one" is what makes an id hash meaningful. Any other placement of
 * the directory is rejected as `bad-index`.
 *
 * TRUST DISCIPLINE
 * ----------------
 * Never trust a length field twice. Every value read out of the file is
 * range-checked against the ACTUAL file length at the moment it is read, and
 * the checked value is what the code then uses -- there is no path where a
 * field is validated and a different expression is used for the access.
 *
 * Chunk payloads are COPIED out of the input, never `subarray`d. A view would
 * pin the entire hostile buffer alive behind a 12-byte chunk and would let a
 * later mutation of the caller's array change a cart that was already decoded.
 */

import type { Chunk } from "./chunks";
import {
  ANCILLARY_CHUNKS,
  CANONICAL_ORDER,
  CRITICAL_CHUNKS,
  DIRECTORY_ENTRY_BYTES,
  HEADER_BYTES,
  MAGIC,
  MAX_CART_BYTES,
  REQUIRED_CHUNKS,
  SIGN_CHUNK,
  SPEC_MAJOR,
  SPEC_MINOR,
  isCritical,
  isKnown,
  isValidChunkType,
  paddedLength,
} from "./chunks";
import type { CartError } from "./errors";
import { cartError, hexOffset } from "./errors";

export interface CartFile {
  specMajor: number;
  specMinor: number;
  chunks: Chunk[];
}

export type DecodeResult = { ok: true; cart: CartFile } | { ok: false; error: CartError };

// --- byte access -----------------------------------------------------------
// Every reader below is TOTAL: an out-of-range index yields 0 rather than
// `undefined`. `noUncheckedIndexedAccess` makes that explicit at the type
// level, and making the readers total means a bounds bug can only produce a
// wrong answer, never a `Cannot read properties of undefined` thrown at a host.

function u8(b: Uint8Array, i: number): number {
  return b[i] ?? 0;
}

function u16le(b: Uint8Array, i: number): number {
  return (u8(b, i) | (u8(b, i + 1) << 8)) >>> 0;
}

function u32le(b: Uint8Array, i: number): number {
  return (u8(b, i) | (u8(b, i + 1) << 8) | (u8(b, i + 2) << 16) | (u8(b, i + 3) << 24)) >>> 0;
}

function writeU16le(b: Uint8Array, i: number, v: number): void {
  b[i] = v & 0xff;
  b[i + 1] = (v >>> 8) & 0xff;
}

function writeU32le(b: Uint8Array, i: number, v: number): void {
  b[i] = v & 0xff;
  b[i + 1] = (v >>> 8) & 0xff;
  b[i + 2] = (v >>> 16) & 0xff;
  b[i + 3] = (v >>> 24) & 0xff;
}

/** Read four bytes as a type string. Bytes 0x00-0xff map 1:1 to code units. */
function readType(b: Uint8Array, i: number): string {
  return String.fromCharCode(u8(b, i), u8(b, i + 1), u8(b, i + 2), u8(b, i + 3));
}

function writeType(b: Uint8Array, i: number, type: string): void {
  for (let k = 0; k < 4; k++) b[i + k] = type.charCodeAt(k) & 0xff;
}

/** A type rendered safely for an error message: no control bytes reach a terminal. */
function showType(type: string): string {
  let out = "";
  for (let i = 0; i < type.length; i++) {
    const c = type.charCodeAt(i);
    out += c >= 0x20 && c <= 0x7e ? type.charAt(i) : "\\x" + c.toString(16).padStart(2, "0");
  }
  return '"' + out + '"';
}

// --- canonical ordering ----------------------------------------------------

/**
 * Reorder a cart's chunks into the canonical emission order and copy the
 * payloads, so the result shares no memory with the input.
 *
 * Order: the known types in `CANONICAL_ORDER` (minus `sign`), then any type
 * this version does not know, sorted by type, then `sign` last. `sign` covers
 * every preceding byte, so nothing may follow it.
 *
 * This is a pure reordering. It does not drop duplicates, invent chunks, or
 * validate -- `encode` does the validating, and canonicalize stays total so it
 * can be applied to anything.
 */
export function canonicalize(cart: CartFile): CartFile {
  const remaining = cart.chunks.slice();
  const out: Chunk[] = [];

  const take = (pred: (c: Chunk) => boolean): Chunk[] => {
    const hit: Chunk[] = [];
    for (let i = 0; i < remaining.length; ) {
      const c = remaining[i];
      if (c !== undefined && pred(c)) {
        hit.push(c);
        remaining.splice(i, 1);
      } else {
        i++;
      }
    }
    return hit;
  };

  for (const type of CANONICAL_ORDER) {
    if (type === SIGN_CHUNK) continue;
    out.push(...take((c) => c.type === type));
  }

  // Unknown types keep the cart valid for a future reader; sorted by type so
  // the ordering is a function of the content and nothing else.
  const unknown = take((c) => c.type !== SIGN_CHUNK);
  unknown.sort((a, b) => (a.type < b.type ? -1 : a.type > b.type ? 1 : 0));
  out.push(...unknown);

  out.push(...take((c) => c.type === SIGN_CHUNK));

  return {
    specMajor: cart.specMajor,
    specMinor: cart.specMinor,
    chunks: out.map((c) => ({ type: c.type, data: c.data.slice() })),
  };
}

/** The payload of the first chunk of `type`, or undefined if there is none. */
export function getChunk(cart: CartFile, type: string): Uint8Array | undefined {
  for (const c of cart.chunks) {
    if (c.type === type) return c.data;
  }
  return undefined;
}

// --- encode ----------------------------------------------------------------

/**
 * Serialise a cart to CANONICAL bytes: chunks in canonical order, padding
 * zeroed, directory rebuilt from what was actually written.
 *
 * `encode` THROWS on malformed input, unlike `decode`. That asymmetry is the
 * point: `decode` consumes bytes from a stranger and must degrade gracefully,
 * while `encode` consumes a structure this process built, so a bad chunk type
 * or a duplicated chunk is a bug in the caller and should stop the build loudly
 * rather than produce a cart that will not load.
 *
 * `encode` does NOT enforce `MAX_CART_BYTES`. The budget is a profile rule the
 * decoder and the validator apply; letting the encoder produce an oversize
 * buffer is what makes "one byte over the limit is refused" a testable claim
 * rather than an unreachable branch.
 */
export function encode(cart: CartFile): Uint8Array {
  const c = canonicalize(cart);

  if (!Number.isInteger(cart.specMajor) || cart.specMajor < 0 || cart.specMajor > 0xffff) {
    throw new Error(`encode: specMajor must be an integer in [0, 65535], got ${cart.specMajor}`);
  }
  if (!Number.isInteger(cart.specMinor) || cart.specMinor < 0 || cart.specMinor > 0xffff) {
    throw new Error(`encode: specMinor must be an integer in [0, 65535], got ${cart.specMinor}`);
  }

  const seen = new Set<string>();
  for (const ch of c.chunks) {
    if (!isValidChunkType(ch.type)) {
      throw new Error(
        `encode: chunk type ${showType(ch.type)} is not four printable ASCII characters ` +
          `beginning with a letter (for example "DATA" or "labl")`,
      );
    }
    if (seen.has(ch.type)) {
      throw new Error(
        `encode: chunk ${showType(ch.type)} appears more than once; a cart carries at most ` +
          `one chunk of each type`,
      );
    }
    seen.add(ch.type);
  }

  let streamBytes = 0;
  for (const ch of c.chunks) streamBytes += 8 + paddedLength(ch.data.length);

  const indexOffset = HEADER_BYTES + streamBytes;
  const total = indexOffset + DIRECTORY_ENTRY_BYTES * c.chunks.length;

  const out = new Uint8Array(total);
  writeType(out, 0, MAGIC);
  writeU16le(out, 4, cart.specMajor);
  writeU16le(out, 6, cart.specMinor);
  writeU32le(out, 8, c.chunks.length);
  writeU32le(out, 12, indexOffset);

  const offsets: number[] = [];
  let p = HEADER_BYTES;
  for (const ch of c.chunks) {
    offsets.push(p);
    writeType(out, p, ch.type);
    writeU32le(out, p + 4, ch.data.length);
    out.set(ch.data, p + 8);
    // Padding stays zero: `new Uint8Array` is zero-filled and nothing writes
    // over the tail. Non-zero padding is a covert channel that changes no
    // behaviour and changes the cart id, so the decoder rejects it.
    p += 8 + paddedLength(ch.data.length);
  }

  let d = indexOffset;
  for (let i = 0; i < c.chunks.length; i++) {
    const ch = c.chunks[i] as Chunk;
    writeType(out, d, ch.type);
    writeU32le(out, d + 4, offsets[i] as number);
    writeU32le(out, d + 8, ch.data.length);
    d += DIRECTORY_ENTRY_BYTES;
  }

  return out;
}

// --- decode ----------------------------------------------------------------

interface WalkedChunk {
  readonly type: string;
  readonly offset: number;
  readonly length: number;
  readonly data: Uint8Array;
}

/**
 * Parse cart bytes. Never throws; every failure is `{ ok: false, error }`.
 *
 * The checks run in a fixed order, cheapest and most structural first, so that
 * a hostile file is rejected before anything is allocated on its behalf:
 *
 *   1. the file is at least a header
 *   2. the magic matches
 *   3. spec_major is one we understand
 *   4. the file is within the cart budget      <- BEFORE any allocation
 *   5. chunk_count and index_offset are sane against the real file length
 *   6. the chunk stream walks cleanly, bounds-checked at every step
 *   7. every padding byte is zero
 *   8. the directory agrees with the walk
 *   9. no duplicates, no unknown critical chunks, no trailing bytes
 *  10. META and CODE are present
 */
export function decode(bytes: Uint8Array): DecodeResult {
  const len = bytes.length;

  // 1 -------------------------------------------------------------------
  if (len < HEADER_BYTES) {
    return {
      ok: false,
      error: cartError(
        "short-header",
        `file is ${len} bytes; a cart begins with a ${HEADER_BYTES}-byte header`,
        0,
      ),
    };
  }

  // 2 -------------------------------------------------------------------
  const magic = readType(bytes, 0);
  if (magic !== MAGIC) {
    return {
      ok: false,
      error: cartError(
        "bad-magic",
        `file begins with ${showType(magic)}; a cart begins with "${MAGIC}"`,
        0,
      ),
    };
  }

  // 3 -------------------------------------------------------------------
  const specMajor = u16le(bytes, 4);
  const specMinor = u16le(bytes, 6);
  if (specMajor > SPEC_MAJOR) {
    return {
      ok: false,
      error: cartError(
        "spec-too-new",
        `cart declares container version ${specMajor}.${specMinor}; this player understands ` +
          `major version ${SPEC_MAJOR} and below (${SPEC_MAJOR}.${SPEC_MINOR}). A newer major ` +
          `version changes the layout itself, so it is refused rather than guessed at`,
        4,
      ),
    };
  }

  // 4 -------------------------------------------------------------------
  // Before this line nothing has been allocated and nothing has been looped
  // over, so a 64 MB file costs four reads to reject.
  if (len > MAX_CART_BYTES) {
    return {
      ok: false,
      error: cartError(
        "cart-too-large",
        `file is ${len} bytes; the Universal Profile budget is ${MAX_CART_BYTES} bytes`,
        MAX_CART_BYTES,
      ),
    };
  }

  // 5 -------------------------------------------------------------------
  const chunkCount = u32le(bytes, 8);
  const indexOffset = u32le(bytes, 12);

  if (indexOffset < HEADER_BYTES) {
    return {
      ok: false,
      error: cartError(
        "bad-index",
        `index_offset is ${hexOffset(indexOffset)}, inside the ${HEADER_BYTES}-byte header; ` +
          `the chunk directory follows the chunk stream, so index_offset must be at least ` +
          `${hexOffset(HEADER_BYTES)}`,
        12,
      ),
    };
  }
  if (indexOffset % 4 !== 0) {
    return {
      ok: false,
      error: cartError(
        "bad-index",
        `index_offset is ${hexOffset(indexOffset)}, which is not a multiple of 4; every chunk ` +
          `is padded to a 4-byte boundary, so the directory always starts 4-byte aligned`,
        12,
      ),
    };
  }
  if (indexOffset > len) {
    return {
      ok: false,
      error: cartError(
        "bad-index",
        `index_offset is ${hexOffset(indexOffset)} but the file is only ${len} bytes`,
        12,
      ),
    };
  }

  // chunkCount is a u32, so this product is at most ~5.15e10 -- far below 2^53
  // and therefore exact as a double. It is computed, not iterated.
  const directoryBytes = chunkCount * DIRECTORY_ENTRY_BYTES;
  const directoryEnd = indexOffset + directoryBytes;
  if (directoryEnd > len) {
    return {
      ok: false,
      error: cartError(
        "bad-index",
        `directory at ${hexOffset(indexOffset)} declares ${chunkCount} entries ` +
          `(${directoryBytes} bytes) but the file has only ${len - indexOffset} bytes left`,
        12,
      ),
    };
  }
  if (directoryEnd !== len) {
    return {
      ok: false,
      error: cartError(
        "trailing-garbage",
        `${len - directoryEnd} bytes follow the chunk directory, which ends at ` +
          `${hexOffset(directoryEnd)}; a cart ends with its directory`,
        directoryEnd,
      ),
    };
  }

  // 6 and 7 --------------------------------------------------------------
  const walked: WalkedChunk[] = [];
  let p = HEADER_BYTES;
  while (p < indexOffset) {
    // Every step re-checks against `indexOffset`, the already-validated end of
    // the chunk stream. Nothing is derived from a length field that was not
    // itself checked on this iteration.
    if (p + 8 > indexOffset) {
      return {
        ok: false,
        error: cartError(
          "truncated",
          `chunk header at ${hexOffset(p)} needs 8 bytes but the chunk stream ends at ` +
            `${hexOffset(indexOffset)}, ${indexOffset - p} bytes away`,
          p,
        ),
      };
    }

    const type = readType(bytes, p);
    if (!isValidChunkType(type)) {
      return {
        ok: false,
        error: cartError(
          "bad-chunk-type",
          `chunk type ${showType(type)} at ${hexOffset(p)} is not four printable ASCII ` +
            `characters beginning with a letter (for example "DATA" or "labl")`,
          p,
        ),
      };
    }

    const length = u32le(bytes, p + 4);
    if (length > MAX_CART_BYTES) {
      return {
        ok: false,
        error: cartError(
          "chunk-too-large",
          `chunk ${showType(type)} at ${hexOffset(p)} declares ${length} bytes; no chunk may ` +
            `exceed the ${MAX_CART_BYTES}-byte cart budget`,
          p + 4,
        ),
      };
    }

    const payloadStart = p + 8;
    if (payloadStart + length > indexOffset) {
      return {
        ok: false,
        error: cartError(
          "truncated",
          `chunk ${showType(type)} at ${hexOffset(p)} declares ${length} bytes but the file ` +
            `has ${indexOffset - payloadStart} left before the chunk directory`,
          p + 4,
        ),
      };
    }

    // These two guards -- payload-fits and payload-plus-padding-fits -- are
    // mutually redundant while the stream stays 4-byte aligned, and a mutation
    // test proved it: disabling either one alone changed no observable
    // behaviour, and only disabling BOTH let an overrunning chunk through
    // (caught by test/fuzz.test.ts, generator "consistent-length", which is
    // there for exactly this reason). They both stay. The first gives the
    // accurate diagnostic, the second is the one that still holds if a future
    // change ever relaxes alignment.
    const padded = paddedLength(length);
    if (payloadStart + padded > indexOffset) {
      return {
        ok: false,
        error: cartError(
          "truncated",
          `chunk ${showType(type)} at ${hexOffset(p)} needs ${padded - length} padding bytes ` +
            `to reach the next 4-byte boundary but the chunk stream ends at ` +
            `${hexOffset(indexOffset)}`,
          payloadStart + length,
        ),
      };
    }

    for (let q = payloadStart + length; q < payloadStart + padded; q++) {
      if (u8(bytes, q) !== 0) {
        return {
          ok: false,
          error: cartError(
            "bad-padding",
            `padding byte at ${hexOffset(q)} after chunk ${showType(type)} is ` +
              `0x${u8(bytes, q).toString(16).padStart(2, "0")}; padding must be zero. ` +
              `Non-zero padding changes no behaviour and changes the cart id, which makes ` +
              `it a covert channel`,
            q,
          ),
        };
      }
    }

    walked.push({
      type,
      offset: p,
      length,
      // Copied, not a view: a view would keep the whole hostile buffer alive
      // and would alias the caller's memory.
      data: bytes.slice(payloadStart, payloadStart + length),
    });

    p = payloadStart + padded;
  }

  // 8 -------------------------------------------------------------------
  if (chunkCount !== walked.length) {
    return {
      ok: false,
      error: cartError(
        "index-mismatch",
        `header declares ${chunkCount} chunks but the chunk stream from ` +
          `${hexOffset(HEADER_BYTES)} to ${hexOffset(indexOffset)} contains ${walked.length}`,
        8,
      ),
    };
  }
  for (let i = 0; i < walked.length; i++) {
    const w = walked[i] as WalkedChunk;
    const e = indexOffset + i * DIRECTORY_ENTRY_BYTES;
    const dType = readType(bytes, e);
    const dOffset = u32le(bytes, e + 4);
    const dLength = u32le(bytes, e + 8);
    if (dType !== w.type || dOffset !== w.offset || dLength !== w.length) {
      return {
        ok: false,
        error: cartError(
          "index-mismatch",
          `directory entry ${i} at ${hexOffset(e)} says ${showType(dType)} at ` +
            `${hexOffset(dOffset)} with ${dLength} bytes, but the chunk actually there is ` +
            `${showType(w.type)} at ${hexOffset(w.offset)} with ${w.length} bytes`,
          e,
        ),
      };
    }
  }

  // 9 -------------------------------------------------------------------
  const seen = new Set<string>();
  for (const w of walked) {
    if (seen.has(w.type)) {
      return {
        ok: false,
        error: cartError(
          "duplicate-chunk",
          `chunk ${showType(w.type)} at ${hexOffset(w.offset)} is the second of its type; ` +
            `a cart carries at most one chunk of each type`,
          w.offset,
        ),
      };
    }
    seen.add(w.type);
  }
  for (const w of walked) {
    if (!isKnown(w.type) && isCritical(w.type)) {
      return {
        ok: false,
        error: cartError(
          "unknown-critical-chunk",
          `chunk ${showType(w.type)} at ${hexOffset(w.offset)} is critical (its first ` +
            `character is uppercase) and unknown to this player, so the cart cannot be run ` +
            `correctly. Known critical chunks: ${CRITICAL_CHUNKS.map(showType).join(", ")}. ` +
            `A forward-compatible extension belongs in a lowercase ancillary chunk, which ` +
            `this player would skip: ${ANCILLARY_CHUNKS.map(showType).join(", ")}`,
          w.offset,
        ),
      };
    }
  }

  // 10 ------------------------------------------------------------------
  for (const req of REQUIRED_CHUNKS) {
    if (!seen.has(req)) {
      return {
        ok: false,
        error: cartError(
          "missing-required-chunk",
          `cart has no ${showType(req)} chunk; every cart must carry ` +
            `${REQUIRED_CHUNKS.map(showType).join(" and ")}`,
        ),
      };
    }
  }

  return {
    ok: true,
    cart: {
      specMajor,
      specMinor,
      chunks: walked.map((w) => ({ type: w.type, data: w.data })),
    },
  };
}
