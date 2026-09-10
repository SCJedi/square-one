/**
 * SHA-256, FIPS 180-4, in plain 32-bit JavaScript.
 *
 * WHY THIS IS NOT `node:crypto` AND NOT WebCrypto
 * ----------------------------------------------
 * This hash is the measuring instrument for the console's determinism claim:
 * a conformance run is accepted when Node, Chrome and Firefox produce the same
 * chain of frame hashes. An instrument that takes a different code path on each
 * of those three platforms cannot distinguish "the machine diverged" from "the
 * hash diverged", which is the one distinction the whole exercise exists to
 * make.
 *
 * The two platform-provided options each fail that requirement in their own
 * way. `node:crypto` does not exist in a browser at all. WebCrypto's digest is
 * Promise-only, so every caller in the hot path would have to become async --
 * and it is absent from some worker realms, including the scrubbed one this
 * console boots its carts inside. A single pure implementation costs about a
 * hundred lines and removes the entire class of "the chains differ and we
 * cannot tell which side moved".
 *
 * It is also, deliberately, ordinary code: no BigInt, no 64-bit emulation, no
 * lookup tables beyond the round constants the standard itself publishes. Every
 * operation below is a 32-bit integer operation that every JavaScript engine
 * implements identically because the language specification leaves it no
 * freedom.
 *
 * Correctness is pinned by the published NIST/RFC 6234 vectors and, in the test
 * file only, by differential comparison against `node:crypto` over every input
 * length from 0 to 200 bytes -- the range where padding-boundary bugs live.
 */

/**
 * The first 32 bits of the fractional parts of the cube roots of the first 64
 * primes. FIPS 180-4 section 4.2.2. These are transcribed, not derived: the
 * standard publishes them as the definition.
 */
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/**
 * The first 32 bits of the fractional parts of the square roots of the first
 * eight primes. FIPS 180-4 section 5.3.3.
 */
const H0 = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);

/** Rotate a 32-bit word right by n, n in [1, 31]. */
function rotr(x: number, n: number): number {
  return ((x >>> n) | (x << (32 - n))) >>> 0;
}

/** The digest length, in bytes. */
export const SHA256_BYTES = 32;

/** The compression block size, in bytes. */
const BLOCK_BYTES = 64;

/**
 * SHA-256 of `data`. Returns a fresh 32-byte digest.
 *
 * `data` may be a view into a larger buffer (a framebuffer slice, typically);
 * only the bytes the view covers are hashed.
 */
export function sha256(data: Uint8Array): Uint8Array {
  const len = data.length;

  // Padding, FIPS 180-4 section 5.1.1: append 0x80, then the fewest zero bytes
  // that leave room for a 64-bit big-endian bit length at the end of the last
  // 64-byte block.
  const padded = (len + 1 + 8 + (BLOCK_BYTES - 1)) & ~(BLOCK_BYTES - 1);
  const buf = new Uint8Array(padded);
  buf.set(data);
  buf[len] = 0x80;

  // The bit length as two 32-bit halves. `len << 3` keeps the low 32 bits
  // exactly (a shift is defined on the ToInt32 of its operand), and dividing
  // by 2^29 recovers the high half without ever forming a number above 2^53.
  const bitsHi = Math.floor(len / 0x20000000);
  const bitsLo = (len << 3) >>> 0;
  buf[padded - 8] = (bitsHi >>> 24) & 0xff;
  buf[padded - 7] = (bitsHi >>> 16) & 0xff;
  buf[padded - 6] = (bitsHi >>> 8) & 0xff;
  buf[padded - 5] = bitsHi & 0xff;
  buf[padded - 4] = (bitsLo >>> 24) & 0xff;
  buf[padded - 3] = (bitsLo >>> 16) & 0xff;
  buf[padded - 2] = (bitsLo >>> 8) & 0xff;
  buf[padded - 1] = bitsLo & 0xff;

  const h = new Uint32Array(H0); // working state, copied so H0 stays constant
  const w = new Uint32Array(64); // message schedule, reused across blocks

  for (let off = 0; off < padded; off += BLOCK_BYTES) {
    // Schedule words 0..15 are the block itself, big-endian.
    for (let t = 0; t < 16; t++) {
      const i = off + (t << 2);
      w[t] =
        (((buf[i] as number) << 24) |
          ((buf[i + 1] as number) << 16) |
          ((buf[i + 2] as number) << 8) |
          (buf[i + 3] as number)) >>>
        0;
    }
    // Words 16..63 are derived. Sums of four 32-bit values reach at most 2^34,
    // which a double holds exactly, so `>>> 0` reduces them without loss.
    for (let t = 16; t < 64; t++) {
      const a = w[t - 15] as number;
      const b = w[t - 2] as number;
      const s0 = (rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3)) >>> 0;
      const s1 = (rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10)) >>> 0;
      w[t] = ((w[t - 16] as number) + s0 + (w[t - 7] as number) + s1) >>> 0;
    }

    let a = h[0] as number;
    let b = h[1] as number;
    let c = h[2] as number;
    let d = h[3] as number;
    let e = h[4] as number;
    let f = h[5] as number;
    let g = h[6] as number;
    let hh = h[7] as number;

    for (let t = 0; t < 64; t++) {
      const S1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) >>> 0;
      const ch = ((e & f) ^ (~e & g)) >>> 0;
      const t1 = (hh + S1 + ch + (K[t] as number) + (w[t] as number)) >>> 0;
      const S0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0;
      const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
      const t2 = (S0 + maj) >>> 0;

      hh = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }

    h[0] = ((h[0] as number) + a) >>> 0;
    h[1] = ((h[1] as number) + b) >>> 0;
    h[2] = ((h[2] as number) + c) >>> 0;
    h[3] = ((h[3] as number) + d) >>> 0;
    h[4] = ((h[4] as number) + e) >>> 0;
    h[5] = ((h[5] as number) + f) >>> 0;
    h[6] = ((h[6] as number) + g) >>> 0;
    h[7] = ((h[7] as number) + hh) >>> 0;
  }

  const out = new Uint8Array(SHA256_BYTES);
  for (let i = 0; i < 8; i++) {
    const v = h[i] as number;
    out[i * 4] = (v >>> 24) & 0xff;
    out[i * 4 + 1] = (v >>> 16) & 0xff;
    out[i * 4 + 2] = (v >>> 8) & 0xff;
    out[i * 4 + 3] = v & 0xff;
  }
  return out;
}

/** Two lowercase hex characters for every byte value, built once. */
const HEX: string[] = [];
for (let i = 0; i < 256; i++) HEX.push(i.toString(16).padStart(2, "0"));

/** Lowercase hex, two characters per byte, no separator and no prefix. */
export function toHex(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i++) s += HEX[b[i] as number];
  return s;
}

/**
 * Inverse of {@link toHex}. Accepts lowercase or uppercase; rejects anything
 * else, because a silently-wrong parse of a golden file would look exactly like
 * a determinism failure.
 */
export function fromHex(s: string): Uint8Array {
  if (s.length % 2 !== 0) throw new Error(`fromHex: odd length ${s.length}`);
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) {
    const hi = hexDigit(s.charCodeAt(i * 2));
    const lo = hexDigit(s.charCodeAt(i * 2 + 1));
    if (hi < 0 || lo < 0) throw new Error(`fromHex: bad hex at offset ${i * 2} in ${JSON.stringify(s)}`);
    out[i] = (hi << 4) | lo;
  }
  return out;
}

/** Value of one hex digit character code, or -1 if it is not one. */
function hexDigit(c: number): number {
  if (c >= 0x30 && c <= 0x39) return c - 0x30; // 0-9
  if (c >= 0x61 && c <= 0x66) return c - 0x61 + 10; // a-f
  if (c >= 0x41 && c <= 0x46) return c - 0x41 + 10; // A-F
  return -1;
}

/** SHA-256 of `data` as 64 lowercase hex characters. */
export function sha256Hex(data: Uint8Array): string {
  return toHex(sha256(data));
}
