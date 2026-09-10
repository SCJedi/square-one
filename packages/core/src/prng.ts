/**
 * xoshiro128** -- the console's only source of randomness.
 *
 * Four 32-bit words of state and nothing but 32-bit operations, so the whole
 * generator is exactly reproducible on any engine. There is no BigInt and no
 * 64-bit arithmetic anywhere in this file, deliberately: a 64-bit generator
 * would either need BigInt (slow, and a different code path per engine) or a
 * hi/lo emulation that is easy to get subtly wrong.
 *
 * The state is 16 bytes and lives at machine address 0x2100. rngSave and
 * rngLoad are the serialisation used there and in save states; a replay that
 * resumes mid-run restores those 16 bytes and must then produce a bit-identical
 * continuation of the sequence.
 *
 * Algorithm: David Blackman and Sebastiano Vigna, "xoshiro/xoroshiro
 * generators", https://prng.di.unimi.it/ -- xoshiro128starstar.c.
 */

/** Rotate a 32-bit word left by k, k in [1, 31]. */
function rotl(x: number, k: number): number {
  return ((x << k) | (x >>> (32 - k))) >>> 0;
}

/**
 * One step of the generator. Reads the four words into locals first: a typed
 * array element is `number | undefined` under noUncheckedIndexedAccess, and
 * naming the words also makes the state update readable as the published
 * reference writes it.
 */
function next(s: Uint32Array): number {
  const s0 = s[0] as number;
  const s1 = s[1] as number;
  const s2 = s[2] as number;
  const s3 = s[3] as number;

  // result = rotl(s1 * 5, 7) * 9, all mod 2^32. Math.imul is the only exact
  // 32-bit multiply in JavaScript; `*` would overflow into double rounding.
  const r = Math.imul(rotl(Math.imul(s1, 5) >>> 0, 7), 9) >>> 0;

  const t = (s1 << 9) >>> 0;

  // The reference does these five xors in place and in this order, so each
  // later line sees the already-updated word. Written out:
  const n2 = (s2 ^ s0) >>> 0;
  const n3 = (s3 ^ s1) >>> 0;
  const n1 = (s1 ^ n2) >>> 0;
  const n0 = (s0 ^ n3) >>> 0;

  s[0] = n0;
  s[1] = n1;
  s[2] = (n2 ^ t) >>> 0;
  s[3] = rotl(n3, 11);

  return r;
}

/**
 * SplitMix32 finaliser. Used only to expand a single seed word into four
 * state words: xoshiro wants a well-mixed state, and seeding it with
 * (seed, 0, 0, 0) would leave the first few outputs visibly correlated with
 * the seed.
 */
function splitmix32(z: number): number {
  let t = z >>> 0;
  t = Math.imul(t ^ (t >>> 16), 0x21f0aaad) >>> 0;
  t = Math.imul(t ^ (t >>> 15), 0x735a2d97) >>> 0;
  return (t ^ (t >>> 15)) >>> 0;
}

/**
 * Expand a 32-bit seed into a valid four-word state.
 *
 * All-zero state is a fixed point of xoshiro: the xors and rotates of zero are
 * zero, so the generator would return 0 forever. SplitMix32 never maps four
 * consecutive counter values to four zeros in practice, but "in practice" is
 * not a guarantee, and a generator that silently dies is exactly the kind of
 * bug that shows up ten thousand frames into a replay. The guard below is
 * cheap and deterministic.
 */
export function rngCreate(seed: number): Uint32Array {
  const s = new Uint32Array(4);
  let z = seed >>> 0;
  for (let i = 0; i < 4; i++) {
    z = (z + 0x9e3779b9) >>> 0; // golden-ratio increment, the SplitMix counter
    s[i] = splitmix32(z);
  }
  if (((s[0] as number) | (s[1] as number) | (s[2] as number) | (s[3] as number)) === 0) {
    // Fixed, documented fallback so this branch is itself deterministic.
    s[0] = 0x9e3779b9;
    s[1] = 0x243f6a88;
    s[2] = 0xb7e15162;
    s[3] = 0x85a308d3;
  }
  return s;
}

/** Advance the state and return the next uniform 32-bit word, in [0, 2^32). */
export function rngNext(s: Uint32Array): number {
  return next(s);
}

/**
 * A uniform integer in [0, n).
 *
 * This is floor(r * n / 2^32) computed exactly, where r is the next raw word.
 * The obvious `Math.floor(r * n / 4294967296)` is NOT exact: r * n reaches
 * 2^63, and doubles stop representing every integer at 2^53, so the product is
 * rounded before the division ever happens.
 *
 * The split below keeps every intermediate below 2^48. Write r = rhi*2^16 + rlo
 * with rhi = r >>> 16 and rlo = r & 0xffff, both under 2^16. Then
 *
 *     r * n = rhi*n * 2^16 + rlo*n
 *           = (q*2^16 + rem) * 2^16 + rlo*n        where q = floor(rhi*n / 2^16)
 *           = q * 2^32 + (rem * 2^16 + rlo*n)
 *
 * so floor(r*n / 2^32) = q + floor((rem*2^16 + rlo*n) / 2^32).
 *
 * Magnitudes: rhi*n and rlo*n are each below 2^16 * 2^31 = 2^47; rem < 2^16 so
 * rem*2^16 + rlo*n < 2^32 + 2^47. All exact. Both divisions are by powers of
 * two, which in binary floating point only adjusts the exponent and so loses
 * nothing, making both Math.floor calls exact as well.
 *
 * Note this is a plain modulo-free scaling, so it carries the usual tiny bias
 * when n does not divide 2^32 -- at most one part in 2^32 / n. That bias is
 * part of the console's specified behaviour: rejection sampling would consume
 * a variable number of words and make replays depend on rejection counts.
 *
 * @param n integer in [1, 2^31). Anything else throws.
 */
export function rnd(s: Uint32Array, n: number): number {
  if (!Number.isInteger(n) || n < 1 || n > 2147483647) {
    throw new Error(`rnd: n must be an integer in [1, 2^31), got ${n}`);
  }
  const r = next(s);
  const hi = (r >>> 16) * n; // < 2^47
  const lo = (r & 0xffff) * n; // < 2^47
  const q = Math.floor(hi / 65536);
  const rem = hi - q * 65536; // < 65536
  return q + Math.floor((rem * 65536 + lo) / 4294967296);
}

/**
 * A uniform 16.16 fixed-point value in [0.0, 1.0).
 *
 * The top 16 bits of the raw word are the fractional part, so the result is
 * k/65536 for a uniform k in [0, 65536) -- it can equal 0.0 and can never
 * equal 1.0.
 */
export function rndf(s: Uint32Array): number {
  return rngNext(s) >>> 16;
}

/**
 * Serialise the state as 16 little-endian bytes at dst[off .. off+16).
 * Little-endian because that is how the console's memory is read everywhere
 * else; a save state written on one machine must load on any other.
 */
export function rngSave(s: Uint32Array, dst: Uint8Array, off: number): void {
  if (!Number.isInteger(off) || off < 0 || off + 16 > dst.length) {
    throw new Error(`rngSave: 16 bytes at offset ${off} do not fit in a ${dst.length}-byte buffer`);
  }
  for (let i = 0; i < 4; i++) {
    const w = s[i] as number;
    dst[off + i * 4 + 0] = w & 0xff;
    dst[off + i * 4 + 1] = (w >>> 8) & 0xff;
    dst[off + i * 4 + 2] = (w >>> 16) & 0xff;
    dst[off + i * 4 + 3] = (w >>> 24) & 0xff;
  }
}

/**
 * Read 16 little-endian bytes back into a state.
 *
 * The bytes are restored verbatim, with no all-zero guard: rngSave/rngLoad has
 * to be an exact round trip, and quietly rewriting a loaded state would make a
 * resumed replay diverge from the run that produced it. A state that is all
 * zeros can only come from a corrupt or hand-written save; validating that
 * belongs to whoever parses the save file.
 */
export function rngLoad(src: Uint8Array, off: number): Uint32Array {
  if (!Number.isInteger(off) || off < 0 || off + 16 > src.length) {
    throw new Error(`rngLoad: 16 bytes at offset ${off} do not fit in a ${src.length}-byte buffer`);
  }
  const s = new Uint32Array(4);
  for (let i = 0; i < 4; i++) {
    const b0 = src[off + i * 4 + 0] as number;
    const b1 = src[off + i * 4 + 1] as number;
    const b2 = src[off + i * 4 + 2] as number;
    const b3 = src[off + i * 4 + 3] as number;
    s[i] = (b0 | (b1 << 8) | (b2 << 16) | (b3 << 24)) >>> 0;
  }
  return s;
}
