/**
 * The cart id: 160 bits of hash, written as 32 Crockford base32 characters.
 *
 * SPEC AMENDMENT (approved): SHA-256 truncated to 20 bytes, not BLAKE3
 * --------------------------------------------------------------------
 * Section 5.4 of the specification says the id is BLAKE3 truncated to 160 bits.
 * This implementation uses **SHA-256, first 20 bytes** instead.
 *
 * BLAKE3 in portable JavaScript is a few hundred lines of tree hashing, and it
 * would be a SECOND hash function to get bit-exact and keep bit-exact forever,
 * bought for a speed win that does not exist at this scale -- a cart is at most
 * 64 KB, where SHA-256 costs about a millisecond. `@sq1/core` already ships
 * SHA-256 verified against the NIST vectors: pure 32-bit JavaScript, no
 * platform branch, and the same instrument the frame-hash chain uses. One hash
 * function in the system beats two.
 *
 * WHAT THE ID COVERS
 * ------------------
 * Every byte of the CANONICAL encoding except the `sign` chunk. Canonical
 * because the hash must be a function of the cart's content and not of whatever
 * byte layout happened to arrive: chunks in fixed order, padding zeroed, the
 * directory rebuilt. Two byte-different files with identical content must get
 * identical ids, or reproducible builds mean nothing.
 *
 * `sign` is excluded because a signature cannot cover itself. NOTHING ELSE is
 * excluded -- in particular the id DOES cover `labl` and `rcpe`. The tempting
 * design leaves ancillary chunks out so a cart can be re-labelled without
 * changing identity, and that is a scam vector: swap the screenshot on a
 * well-known cart and you have a different game wearing its face at the same
 * address.
 *
 * The exclusion is structural, not a splice: the sign chunk is REMOVED and the
 * remaining cart is re-encoded, so the header's chunk_count and the directory
 * describe the signed-over bytes exactly.
 */

import { sha256 } from "@sq1/core";
import type { CartFile } from "./codec";
import { decode, encode } from "./codec";
import { SIGN_CHUNK } from "./chunks";

/** 160 bits. Long enough that a collision is not a threat model; short enough to read aloud. */
export const ID_BYTES = 20;

/**
 * Crockford base32. No I, L, O or U: I/L are confusable with 1, O with 0, and U
 * is left out so a random id cannot spell an obscenity.
 */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * Encode bytes as Crockford base32, most significant bit first.
 *
 * 20 bytes is 160 bits, which is exactly 32 symbols with no remainder, so a
 * cart id never carries padding.
 */
export function base32Encode(b: Uint8Array): string {
  let out = "";
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < b.length; i++) {
    acc = ((acc << 8) | (b[i] ?? 0)) >>> 0;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += ALPHABET.charAt((acc >>> bits) & 31);
    }
  }
  if (bits > 0) out += ALPHABET.charAt((acc << (5 - bits)) & 31);
  return out;
}

/**
 * The value of one input symbol, or -1.
 *
 * Crockford's decoding rules, which are the reason to use his alphabet at all:
 * case is ignored, `I`, `i`, `L` and `l` all read as 1, and `O` and `o` read as
 * 0. Someone reading an id off a screen and typing it into a box gets it right.
 * `U` is not in the alphabet and is not remapped -- it is simply invalid.
 */
function symbolValue(ch: string): number {
  const c = ch.charCodeAt(0);
  if (c >= 0x30 && c <= 0x39) return c - 0x30; // 0-9
  let u = c;
  if (u >= 0x61 && u <= 0x7a) u -= 32; // to upper
  if (u === 0x4f) return 0; // O -> 0
  if (u === 0x49 || u === 0x4c) return 1; // I, L -> 1
  const idx = ALPHABET.indexOf(String.fromCharCode(u));
  return idx; // -1 for U and for anything else
}

/**
 * Decode Crockford base32. Returns null on any invalid input -- NEVER throws,
 * because ids arrive from URLs, QR codes and people typing.
 *
 * Hyphens are ignored, so `formatId`'s grouped display decodes as-is. The
 * trailing bits of the final symbol must be zero: otherwise two different
 * strings would decode to the same bytes, and an id would have more than one
 * spelling.
 */
export function base32Decode(s: string): Uint8Array | null {
  const out: number[] = [];
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charAt(i);
    if (ch === "-") continue;
    const v = symbolValue(ch);
    if (v < 0) return null;
    acc = ((acc << 5) | v) >>> 0;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >>> bits) & 0xff);
    }
  }
  // 5, 6 or 7 leftover bits means a symbol that contributes to no byte.
  if (bits >= 5) return null;
  if ((acc & ((1 << bits) - 1)) !== 0) return null; // leftover bits must be zero
  return new Uint8Array(out);
}

/** The 20 raw id bytes of an already-parsed cart. */
export function cartIdBytes(cart: CartFile): Uint8Array {
  const withoutSign: CartFile = {
    specMajor: cart.specMajor,
    specMinor: cart.specMinor,
    chunks: cart.chunks.filter((c) => c.type !== SIGN_CHUNK),
  };
  // encode() canonicalizes: fixed order, zeroed padding, rebuilt directory.
  return sha256(encode(withoutSign)).slice(0, ID_BYTES);
}

/** The id of an already-parsed cart, as 32 Crockford base32 characters. */
export function cartIdOf(cart: CartFile): string {
  return base32Encode(cartIdBytes(cart));
}

/**
 * The id of a cart file.
 *
 * The bytes are decoded first, so the id is computed over the canonical
 * re-encoding rather than over whatever arrived. THIS FUNCTION THROWS if the
 * bytes are not a valid cart -- deliberately, and it is the only function in
 * this package that does so on cart input. `decode` is the adversarial surface;
 * asking for the identity of something that is not a cart is a caller bug, and
 * a caller holding hostile bytes must call `decode` first and handle the
 * `CartError`. Use `cartIdOf` when you already have a `CartFile`.
 */
export function cartId(bytes: Uint8Array): string {
  const r = decode(bytes);
  if (!r.ok) {
    throw new Error(
      `cartId: these bytes are not a valid cart (${r.error.code}: ${r.error.message}). ` +
        `Call decode() first and handle the error, or call cartIdOf() on a decoded cart`,
    );
  }
  return cartIdOf(r.cart);
}

/**
 * `K3PQ7W2M-N0XR8T4V-...` -- four groups of eight, joined by hyphens.
 *
 * Grouping is display only. `base32Decode` ignores the hyphens, so a formatted
 * id and a bare id are the same id.
 */
export function formatId(id: string): string {
  const groups: string[] = [];
  for (let i = 0; i < id.length; i += 8) groups.push(id.slice(i, i + 8));
  return groups.join("-");
}
