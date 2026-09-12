/**
 * PCG64-DXSM -- Prime's only source of randomness.
 *
 * The small console uses xoshiro128** because JavaScript has no 64-bit integers
 * and a 64-bit multiply there is a correctness hazard sitting in the most
 * determinism-critical function in the machine. Prime's payload is WebAssembly,
 * which has i64 natively, so the constraint is gone and the better generator is
 * simply available (specification, section 2.4). What survives the change is the
 * lesson that produced it: pick the generator the runtime can express exactly,
 * and write the choice down to the last constant.
 *
 * WHY 32-BIT LIMBS AND NOT BigInt
 * ------------------------------
 * The reference host for this slice is a JavaScript runtime, where the only
 * exact 64-bit integer is a BigInt and every BigInt operation allocates. A
 * generator called a few thousand times a tick cannot allocate a few thousand
 * times a tick. So the whole generator is written in 32-bit limbs with
 * `Math.imul`, the one exact 32-bit multiply JavaScript has, and every claim it
 * makes about those limbs is proved against a BigInt reference in
 * test/prng.test.ts -- the same arrangement, and for the same reason, as
 * packages/core/test/fixed.test.ts proving `fmul`.
 *
 * THE ALGORITHM, PINNED
 * ---------------------
 * State is 128 bits; the increment is a further 128 bits and is odd. One step is
 *
 *     state = state * CHEAP_MULTIPLIER + inc          (mod 2^128)
 *
 * with CHEAP_MULTIPLIER = 0xda942042e4dd58b5, a 64-bit multiplier applied to the
 * 128-bit state. The output is DXSM, computed from the state BEFORE the step:
 *
 *     hi = state >> 64
 *     lo = state | 1                                  (low 64 bits, forced odd)
 *     hi ^= hi >> 32
 *     hi *= CHEAP_MULTIPLIER                          (mod 2^64)
 *     hi ^= hi >> 48
 *     hi *= lo                                        (mod 2^64)
 *     output = hi
 *
 * Output-before-step, `| 1` on the low half rather than the whole word, and the
 * 48-bit second xorshift are all load-bearing: change any of them and this is a
 * different generator producing a different sequence, and every replay ever
 * recorded is wrong. They are written out here so there is nothing to infer.
 *
 * SEEDING
 * -------
 * A cart is booted with a u64. The generator wants 256 bits of well-separated
 * initial material, so the seed is expanded by SplitMix64 -- four draws, two for
 * the initial state and two for the sequence selector -- and then installed with
 * PCG's own seeding routine. Seeding the state directly with (seed, 0, 0, 0)
 * would leave the first few outputs visibly correlated with the seed, which on a
 * console means two carts booted with adjacent seeds look related.
 *
 * WHERE THE STATE LIVES
 * ---------------------
 * In the arena, always. `rngSave`/`rngLoad` are the 32-byte serialisation used
 * there and in every save state, and a replay that resumes mid-run restores
 * those 32 bytes and must then produce a bit-identical continuation. Read it
 * out, use it, write it back -- the rule the small machine follows, for the same
 * reason.
 */

/**
 * Eight 32-bit words, little-endian within each 128-bit half:
 * `w[0..3]` is the state (w[0] least significant), `w[4..7]` is the increment.
 */
export type RngState = Uint32Array;

/** The generator's state and increment together, in bytes. */
export const RNG_BYTES = 32;

/** 0xda942042e4dd58b5, PCG's "cheap" 64-bit multiplier, as two 32-bit limbs. */
const CM_LO = 0xe4dd58b5;
const CM_HI = 0xda942042;

const TWO32 = 4294967296;

// --- 32-bit limb primitives -------------------------------------------------

/*
 * Scratch for the wide primitives below. Module-level so a draw allocates
 * nothing. This is NOT machine state: every variable is written before it is
 * read on every call, nothing survives between calls, and the simulation is
 * single-threaded by specification. A snapshot does not need to capture it,
 * which is the only property that matters.
 */
let mLo = 0;
let mHi = 0;

/**
 * The full 64-bit product of two u32, into (mLo, mHi).
 *
 * Split into 16-bit halves so every partial product is below 2^32 and therefore
 * an exact double. The obvious `a * b` is wrong above 2^53 and silently so.
 */
function umul32(a: number, b: number): void {
  const al = a & 0xffff;
  const ah = a >>> 16;
  const bl = b & 0xffff;
  const bh = b >>> 16;
  const ll = al * bl;
  const lh = al * bh;
  const hl = ah * bl;
  const hh = ah * bh;
  const mid = (ll >>> 16) + (lh & 0xffff) + (hl & 0xffff); // < 2^18
  mLo = (((mid & 0xffff) << 16) | (ll & 0xffff)) >>> 0;
  mHi = (hh + (lh >>> 16) + (hl >>> 16) + (mid >>> 16)) >>> 0;
}

/** The LOW 64 bits of a 64x64 product, into (mLo, mHi). */
function umul64Low(aLo: number, aHi: number, bLo: number, bHi: number): void {
  umul32(aLo, bLo);
  const lo = mLo;
  const hi = (mHi + Math.imul(aLo, bHi) + Math.imul(aHi, bLo)) >>> 0;
  mLo = lo;
  mHi = hi;
}

// --- the generator ----------------------------------------------------------

/**
 * One LCG step: state = state * CHEAP_MULTIPLIER + inc, mod 2^128.
 *
 * Schoolbook, four state limbs by two multiplier limbs, with the partial
 * products accumulated before any carry is propagated. Each accumulator takes at
 * most five values below 2^32 plus a carry, so it stays under 2^35 and every
 * intermediate is an exact integer in a double. Products whose weight is 2^128
 * or more are simply not computed: they vanish modulo 2^128.
 */
function step(s: RngState): void {
  const s0 = s[0] as number;
  const s1 = s[1] as number;
  const s2 = s[2] as number;
  const s3 = s[3] as number;

  let a0 = s[4] as number;
  let a1 = s[5] as number;
  let a2 = s[6] as number;
  let a3 = s[7] as number;

  umul32(s0, CM_LO);
  a0 += mLo;
  a1 += mHi;
  umul32(s1, CM_LO);
  a1 += mLo;
  a2 += mHi;
  umul32(s2, CM_LO);
  a2 += mLo;
  a3 += mHi;
  umul32(s3, CM_LO);
  a3 += mLo;

  umul32(s0, CM_HI);
  a1 += mLo;
  a2 += mHi;
  umul32(s1, CM_HI);
  a2 += mLo;
  a3 += mHi;
  umul32(s2, CM_HI);
  a3 += mLo;

  let v = a0;
  s[0] = v >>> 0;
  v = a1 + Math.floor(v / TWO32);
  s[1] = v >>> 0;
  v = a2 + Math.floor(v / TWO32);
  s[2] = v >>> 0;
  v = a3 + Math.floor(v / TWO32);
  s[3] = v >>> 0;
}

/**
 * The DXSM output of the CURRENT state, into (mLo, mHi), then one step.
 *
 * The order matters and is part of the definition: the word returned belongs to
 * the state that was there when the call began.
 */
function next64(s: RngState): void {
  const sLo = ((s[0] as number) | 1) >>> 0;
  const sHi = s[1] as number;
  let hLo = s[2] as number;
  const hHi = s[3] as number;

  hLo = (hLo ^ hHi) >>> 0; // hi ^= hi >> 32
  umul64Low(hLo, hHi, CM_LO, CM_HI);
  const tLo = (mLo ^ (mHi >>> 16)) >>> 0; // hi ^= hi >> 48
  const tHi = mHi;
  umul64Low(tLo, tHi, sLo, sHi);

  // `step` runs the same limb multiplier and so overwrites (mLo, mHi). Hold the
  // output across it: the word belongs to the state as it was on entry, and
  // advancing must not be able to change what was already produced.
  const oLo = mLo;
  const oHi = mHi;
  step(s);
  mLo = oLo;
  mHi = oHi;
}

/** SplitMix64, used only to expand the boot seed. Writes into (mLo, mHi). */
function splitmix64(zLo: number, zHi: number): void {
  // z ^= z >> 30; z *= 0xBF58476D1CE4E5B9
  let lo = (zLo >>> 30) | (zHi << 2);
  let hi = zHi >>> 30;
  lo = (zLo ^ lo) >>> 0;
  hi = (zHi ^ hi) >>> 0;
  umul64Low(lo, hi, 0x1ce4e5b9, 0xbf58476d);

  // z ^= z >> 27; z *= 0x94D049BB133111EB
  lo = (mLo >>> 27) | (mHi << 5);
  hi = mHi >>> 27;
  lo = (mLo ^ lo) >>> 0;
  hi = (mHi ^ hi) >>> 0;
  umul64Low(lo, hi, 0x133111eb, 0x94d049bb);

  // z ^= z >> 31
  lo = (mLo >>> 31) | (mHi << 1);
  hi = mHi >>> 31;
  mLo = (mLo ^ lo) >>> 0;
  mHi = (mHi ^ hi) >>> 0;
}

/**
 * Seed a generator from a u64.
 *
 * Any bigint is accepted and reduced modulo 2^64, so a cart cannot be handed a
 * seed the machine would have to reject at boot. The expansion is:
 *
 *   four SplitMix64 draws from the seed give initstate (128 bits) and
 *   initseq (128 bits);
 *   inc   = (initseq << 1) | 1          -- odd, as PCG requires
 *   state = 0; step; state += initstate; step
 *
 * which is PCG's own `srandom` routine, unchanged.
 */
export function rngCreate(seed: bigint): RngState {
  const u = BigInt.asUintN(64, seed);
  let zLo = Number(u & 0xffffffffn);
  let zHi = Number((u >> 32n) & 0xffffffffn);

  const draw = (): [number, number] => {
    // z += 0x9E3779B97F4A7C15
    const lo = zLo + 0x7f4a7c15;
    const carry = lo >= TWO32 ? 1 : 0;
    zLo = lo >>> 0;
    zHi = (zHi + 0x9e3779b9 + carry) >>> 0;
    splitmix64(zLo, zHi);
    return [mLo, mHi];
  };

  const [is0, is1] = draw();
  const [is2, is3] = draw();
  const [iq0, iq1] = draw();
  const [iq2, iq3] = draw();

  const s = new Uint32Array(8);
  // inc = (initseq << 1) | 1
  s[4] = ((iq0 << 1) | 1) >>> 0;
  s[5] = ((iq1 << 1) | (iq0 >>> 31)) >>> 0;
  s[6] = ((iq2 << 1) | (iq1 >>> 31)) >>> 0;
  s[7] = ((iq3 << 1) | (iq2 >>> 31)) >>> 0;

  step(s); // state was 0
  let v = (s[0] as number) + is0;
  s[0] = v >>> 0;
  v = (s[1] as number) + is1 + Math.floor(v / TWO32);
  s[1] = v >>> 0;
  v = (s[2] as number) + is2 + Math.floor(v / TWO32);
  s[2] = v >>> 0;
  v = (s[3] as number) + is3 + Math.floor(v / TWO32);
  s[3] = v >>> 0;
  step(s);

  return s;
}

/**
 * The next uniform 32-bit word, in [0, 2^32).
 *
 * One draw is one full 64-bit output, of which the HIGH half is returned and the
 * low half is discarded. Buffering the low half for the next call would waste
 * nothing, and would also put a half-consumed word and a "is one pending" flag
 * into the machine's state -- state that a save file would have to carry and
 * that a hand-written save could set inconsistently. The generator's state is
 * exactly the generator's state, and a draw is a draw. Thirty-two bits are a
 * cheap price for that.
 */
export function rngNext(s: RngState): number {
  next64(s);
  return mHi;
}

/**
 * A uniform integer in [0, n), with NO bias.
 *
 * Lemire's method: take the 64-bit draw x, form the 128-bit product x*n, and
 * return its high 64 bits. That is floor(x*n / 2^64), which is uniform except
 * that the 2^64 mod n draws at the bottom of the range map one value too often.
 * Those are rejected -- the `l < n` test is true with probability n/2^64, so the
 * threshold is essentially never even computed, let alone the loop entered.
 *
 * The small console deliberately accepts the bias instead, because rejection
 * would consume a variable number of words and it wanted a fixed cost. Prime
 * does not need that trade: the generator's state is in the arena either way, so
 * a replay resumes correctly however many words a draw took, and an unbiased
 * integer is worth more than a predictable one.
 *
 * Since n < 2^31, x*n fits in 95 bits and is computed as three 32-bit limbs.
 *
 * @param n integer in [1, 2^31). Anything else throws.
 */
export function rnd(s: RngState, n: number): number {
  if (!Number.isInteger(n) || n < 1 || n > 2147483647) {
    throw new Error(`rnd: n must be an integer in [1, 2^31), got ${n}`);
  }
  for (;;) {
    next64(s);
    const xLo = mLo;
    const xHi = mHi;
    umul32(xLo, n);
    const p0Lo = mLo;
    const p0Hi = mHi;
    umul32(xHi, n);
    const mid = p0Hi + mLo;
    const carry = mid >= TWO32 ? 1 : 0;
    const l1 = mid >>> 0;
    const hiOut = mHi + carry; // floor(x*n / 2^64), which is the answer

    // l = the low 64 bits of x*n = (l1, p0Lo).
    if (l1 !== 0 || p0Lo >= n) return hiOut;

    // Only here, and only about once in 2^33 draws for a typical n, does the
    // threshold get computed at all.
    let t = 1 % n;
    for (let i = 0; i < 64; i++) {
      t *= 2;
      if (t >= n) t -= n;
    }
    if (p0Lo >= t) return hiOut;
  }
}

/** 2^-53, built by halving so it is exact by construction rather than by a literal. */
const TWO_POW_M53 = ((): number => {
  let v = 1;
  for (let i = 0; i < 53; i++) v /= 2;
  return v;
})();

/**
 * A uniform double in [0, 1).
 *
 * The top 53 bits of the draw, scaled by 2^-53: the result is k/2^53 for a
 * uniform k in [0, 2^53), so every value it can produce is exactly
 * representable, it can equal 0 and it can never equal 1. Both the integer
 * assembly and the scaling are exact -- k stays below 2^53 and 2^-53 is a power
 * of two -- so this is the same double on every machine.
 */
export function rndf(s: RngState): number {
  next64(s);
  return (mHi * 2097152 + (mLo >>> 11)) * TWO_POW_M53;
}

// --- serialisation ----------------------------------------------------------

/**
 * Write the 32-byte state at `dst[off .. off+32)`, little-endian.
 *
 * Little-endian because that is how the arena is read everywhere else, and
 * because a save state written on one machine must load on any other.
 */
export function rngSave(s: RngState, dst: DataView, off: number): void {
  if (!Number.isInteger(off) || off < 0 || off + RNG_BYTES > dst.byteLength) {
    throw new Error(`rngSave: ${RNG_BYTES} bytes at ${off} do not fit in ${dst.byteLength}`);
  }
  for (let i = 0; i < 8; i++) dst.setUint32(off + i * 4, s[i] as number, true);
}

/**
 * Read a state back. Verbatim, with no repair of any kind.
 *
 * `rngSave`/`rngLoad` has to be an exact round trip: quietly normalising a
 * loaded state -- forcing the increment odd, say -- would make a resumed replay
 * diverge from the run that produced it, which is the one thing a save state
 * exists to prevent. Validating a hand-written save belongs to whoever parses
 * the save file.
 */
export function rngLoad(src: DataView, off: number): RngState {
  const s = new Uint32Array(8);
  rngLoadInto(s, src, off);
  return s;
}

/**
 * `rngLoad` without the allocation, for the tick loop.
 *
 * A machine pulls the state out of the arena, draws, and pushes it back, many
 * times per tick. `rngLoad` returning a fresh array is right for a save-file
 * reader and wrong for something on that path.
 */
export function rngLoadInto(s: RngState, src: DataView, off: number): void {
  if (!Number.isInteger(off) || off < 0 || off + RNG_BYTES > src.byteLength) {
    throw new Error(`rngLoad: ${RNG_BYTES} bytes at ${off} do not fit in ${src.byteLength}`);
  }
  for (let i = 0; i < 8; i++) s[i] = src.getUint32(off + i * 4, true);
}
