/**
 * The cart container's vocabulary: header constants, chunk types, and the
 * predicates that classify a four-character type.
 *
 * The one rule that buys forward compatibility is stolen wholesale from PNG:
 * an UPPERCASE first character means the chunk is CRITICAL and a decoder that
 * does not know it MUST refuse the cart; a lowercase first character means the
 * chunk is ANCILLARY and an unknown one MUST be skipped in silence. That single
 * sentence is what lets a player written in 2026 open a cart written in 2032 --
 * ignoring the parts it was never told about, and refusing exactly the carts it
 * genuinely cannot run.
 *
 * Chunk types are always EXACTLY four bytes. The types with fewer letters are
 * padded with trailing spaces: "PAL ", "GFX ", "MAP ", "SFX ", "MUS ". The
 * space is part of the type, not decoration -- a decoder comparing against
 * "GFX" would never match anything.
 */

/** ASCII "SQ1C", the first four bytes of every cart. */
export const MAGIC = "SQ1C";

/** magic(4) + spec_major(2) + spec_minor(2) + chunk_count(4) + index_offset(4). */
export const HEADER_BYTES = 16;

/** One directory entry: type(4) + offset(4) + length(4). */
export const DIRECTORY_ENTRY_BYTES = 12;

/**
 * The container version this implementation writes and is willing to read.
 *
 * A cart declaring a HIGHER major is refused rather than guessed at: a major
 * bump means the layout itself changed, so "read what you recognise" would be
 * reading structure that is no longer there. A higher MINOR is fine -- minor
 * changes only ever add ancillary chunks or optional META fields.
 */
export const SPEC_MAJOR = 1;
export const SPEC_MINOR = 0;

/**
 * The Universal Profile cart budget: 64 KiB.
 *
 * This is a hard cap checked BEFORE the decoder allocates anything. A forty
 * byte file claiming a four gigabyte chunk must be rejected, not attempted.
 */
export const MAX_CART_BYTES = 65536;

/** Critical chunks this version knows. Uppercase first byte, all of them. */
export const CRITICAL_CHUNKS: readonly string[] = [
  "META", // title, author, profile, payload type, minimum ABI
  "CODE", // the payload
  // The colour tables: PALETTE_HW, PALETTE_LIVE and DRAW_REMAP, which are
  // contiguous at 0x2000..0x20DF. CRITICAL rather than ancillary, and that is
  // the whole reason the case convention exists: a player that did not
  // understand this chunk would skip it and render the cart through the
  // identity palette, so the game would open and look wrong. A cart whose
  // colours are part of what it is must be refused by such a player, not
  // approximated by it.
  "PAL ", // live palette, hardware palette and draw remap
  "GFX ", // sprite sheet and flags
  "MAP ", // tile map
  "SFX ", // effect bank
  "MUS ", // pattern data
  "DATA", // arbitrary cart data
];

/** Ancillary chunks this version knows. Lowercase first byte, all of them. */
export const ANCILLARY_CHUNKS: readonly string[] = [
  "labl", // 128x128 label image
  "rcpe", // the recipe and module hashes that produced this cart
  "rndr", // extended-profile renditions
  "sign", // ed25519 signature over every preceding byte
];

/** A cart without these is not a cart. */
export const REQUIRED_CHUNKS: readonly string[] = ["META", "CODE"];

/**
 * The fixed order `encode()` emits known chunks in.
 *
 * Chunk order has to be pinned because the cart id is a hash of the canonical
 * encoding: two builds of the same content that emitted chunks in different
 * orders would be two different carts, and reproducible builds would mean
 * nothing.
 *
 * `sign` is last and stays last -- it signs every preceding byte, so anything
 * placed after it would be unsigned. Unknown ancillary chunks are emitted after
 * the known ones and sorted by type, but still BEFORE `sign`, for that reason.
 */
export const CANONICAL_ORDER: readonly string[] = [...CRITICAL_CHUNKS, ...ANCILLARY_CHUNKS];

/** The signature chunk, excluded from the cart id because it cannot cover itself. */
export const SIGN_CHUNK = "sign";

export interface Chunk {
  readonly type: string;
  readonly data: Uint8Array;
}

/**
 * Critical iff the first character is A-Z.
 *
 * Deliberately does NOT validate the rest of the type: callers ask this only
 * about types that already passed `isValidChunkType`, and a predicate that
 * answered "false" for both "unknown critical" and "malformed" would let a
 * malformed critical chunk through as ancillary.
 */
export function isCritical(type: string): boolean {
  if (type.length === 0) return false;
  const c = type.charCodeAt(0);
  return c >= 0x41 && c <= 0x5a;
}

/**
 * Exactly four characters, each printable ASCII (0x20-0x7e), first one a
 * letter so the critical/ancillary bit is always defined.
 *
 * Printable-only matters because chunk types are shown to humans in error
 * messages and in `sq1 validate` output; a type containing a control character
 * or a byte above 0x7e could rewrite a terminal line.
 */
export function isValidChunkType(type: string): boolean {
  if (type.length !== 4) return false;
  for (let i = 0; i < 4; i++) {
    const c = type.charCodeAt(i);
    if (c < 0x20 || c > 0x7e) return false;
  }
  const f = type.charCodeAt(0);
  const isUpper = f >= 0x41 && f <= 0x5a;
  const isLower = f >= 0x61 && f <= 0x7a;
  return isUpper || isLower;
}

/** True for a chunk type this version of the container understands. */
export function isKnown(type: string): boolean {
  return CANONICAL_ORDER.indexOf(type) !== -1;
}

/**
 * A payload length rounded up to the next 4-byte boundary.
 *
 * Written with `%` rather than `(n + 3) & ~3` on purpose: the decoder reads
 * lengths straight out of a hostile u32, and the bitwise form coerces to a
 * SIGNED 32-bit integer, so 0xffffffff would round to -1 and every bounds check
 * downstream would compare against a negative number and pass.
 */
export function paddedLength(payloadLength: number): number {
  return payloadLength + ((4 - (payloadLength % 4)) % 4);
}
