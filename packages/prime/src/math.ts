/**
 * The normative math library. Bit-identical on every platform, forever.
 *
 * THE PROBLEM THIS FILE EXISTS TO SOLVE
 * -------------------------------------
 * IEEE 754 specifies `+ - * /` and `sqrt` exactly: every conformant machine
 * agrees on the last bit. It specifies nothing about `sin`, `cos` or `atan2`,
 * and ECMAScript explicitly calls `Math.sin` implementation-approximated. Two
 * machines that are both entirely correct can therefore disagree in the final
 * ulp of an angle -- and a ball whose velocity differs in the last bit arrives
 * on the other side of a paddle three thousand ticks later. That is the whole
 * failure mode Prime is built to make impossible, so `Math.sin`, `Math.cos`,
 * `Math.atan`, `Math.atan2`, `Math.PI` and `**` appear NOWHERE below.
 *
 * `Math.sqrt` DOES appear, and is the only transcendental-looking thing that
 * does, because IEEE 754 requires it to be correctly rounded. `Math.floor`,
 * `Math.round`, `Math.abs` and `Math.min/max` also appear: all four are exactly
 * specified in ECMAScript, with no approximation clause.
 *
 * WHAT THE RUNTIME IS ALLOWED TO DO
 * ---------------------------------
 * Only `+ - * /` on doubles, integer arithmetic that provably stays below 2^53,
 * and table lookups. Every constant is committed, and every committed constant
 * was produced by `tools/gen-math-tables.ts` in exact BigInt arithmetic.
 * `test/math.test.ts` recomputes all of them independently and fails if one moves
 * by a single ulp.
 *
 * POLYNOMIAL, NOT TABLE-PLUS-INTERPOLATION
 * ----------------------------------------
 * The small console uses a 1024-entry table because its result is 16.16 fixed
 * point: 16 fractional bits, and a table entry IS the answer. An f64 answer has
 * 53 significant bits, and hitting that from a table needs either ~2^27 entries
 * or an interpolation whose own error swamps the table's. A polynomial gets
 * there in eight multiply-adds from eight committed coefficients.
 *
 * The coefficients are the TAYLOR coefficients -- exact rationals 1/(2k+1)! --
 * carried to a degree where truncation is below 2^-70, rather than minimax
 * coefficients of a lower degree. Two reasons. First, a rational has an
 * unambiguous correctly-rounded double and a test can recompute it in twenty
 * lines of BigInt; a minimax coefficient is whatever a particular Remez
 * implementation converged to, which is a number nobody can re-derive
 * independently. Second, the saving is two multiplies on a path that is not the
 * bottleneck. Determinism is bought with exactly the currency this file has.
 *
 * RANGE REDUCTION -- READ THIS BEFORE CHANGING ANYTHING
 * ----------------------------------------------------
 * Range reduction is where real implementations diverge, because the naive
 * `x - round(x*2/pi) * pi/2` loses every bit of precision it cancels, and each
 * libm chooses a different point to give up. Prime does not give up: it reduces
 * with Payne-Hanek, in EXACT integer arithmetic, for every finite argument.
 *
 *   |x| = m * 2^e with m a 53-bit integer, read straight out of the bits.
 *   2/pi is committed as 1344 fraction bits in 24-bit limbs.
 *   m and 2/pi are multiplied as integers, keeping the 2 bits above the binary
 *   point (the quadrant, mod 4) and 192 bits below it.
 *   Every partial product is a 24-bit limb times a 24-bit limb -- below 2^48,
 *   and therefore an exact f64 product. No BigInt, no rounding, no cancellation.
 *
 * So there is no "large argument" behaviour to document beyond this: sin(2^900)
 * is as accurate as sin(0.5), and both are the same on every machine. The only
 * arguments without a reduction are the non-finite ones, which return NaN.
 *
 * The cost is about 50 multiplies and 60 adds for an argument outside
 * [-pi/4, pi/4]; inside it there is no reduction at all, which is the case a
 * game that keeps its angles wrapped will hit every time.
 */

// --- BEGIN GENERATED: packages/prime/tools/gen-math-tables.ts ---------------
// Do not hand-edit. test/math.test.ts recomputes every number below in BigInt
// and fails if one of them moves by a single unit in the last place.

/**
 * The first 1344 fraction bits of 2/pi, in 24-bit limbs, most significant first:
 *
 *     2/pi = sum_j TWO_OVER_PI[j] * 2^(-24*(j+1))
 *
 * 24 bits per limb because a limb times a 24-bit slice of the mantissa is below
 * 2^48 and therefore an EXACT f64 product -- the whole Payne-Hanek reduction is
 * integer arithmetic carried in doubles, with no BigInt and no rounding.
 */
export const TWO_OVER_PI: readonly number[] = [
  10680707, 7228996, 1387004, 2578385, 16069853, 12639074, 9804092, 4427841,
  16666979, 11263675, 12935607, 2387514, 4345298, 14681673, 3074569, 13734428,
  16653803, 1880361, 10960616, 8533493, 3062596, 8710556, 7349940, 6258241,
  3772886, 3769171, 3798172, 8675211, 12450088, 3874808, 9961438, 366607,
  15675153, 9132554, 7151469, 3571407, 2607881, 12013382, 4155038, 6285869,
  7677882, 13102053, 15825725, 473591, 9065106, 15363067, 6271263, 9264392,
  5636912, 4652155, 7056368, 13614112, 10155062, 1944035, 9527646, 15080200,
];

/** pi/2 as an exact three-double expansion: PIO2_H + PIO2_M + PIO2_L, ~159 bits. */
export const PIO2_H = 1.5707963267948966;
export const PIO2_M = 6.123233995736766e-17;
export const PIO2_L = -1.4973849048591698e-33;

/** pi and pi/4 as double-doubles, for assembling atan2 quadrants without cancellation. */
export const PI_H = 3.141592653589793;
export const PI_L = 1.2246467991473532e-16;
export const PIO4_H = 0.7853981633974483;
export const PIO4_L = 3.061616997868383e-17;

/** 3*pi/4, correctly rounded. atan2(+-inf, -inf) is exactly this and nothing else. */
export const PI3O4 = 2.356194490192345;

/** sin(x) = x + x^3*(S1 + z*(S2 + ...)), z = x*x. S_k = (-1)^k / (2k+1)!. */
export const S1 = -0.16666666666666666;
export const S2 = 0.008333333333333333;
export const S3 = -0.0001984126984126984;
export const S4 = 0.0000027557319223985893;
export const S5 = -2.505210838544172e-8;
export const S6 = 1.6059043836821613e-10;
export const S7 = -7.647163731819816e-13;
export const S8 = 2.8114572543455206e-15;

/** cos(x) = 1 - z/2 + z^2*(C1 + z*(C2 + ...)), z = x*x. C_k = (-1)^(k+1) / (2k+2)!. */
export const C1 = 0.041666666666666664;
export const C2 = -0.001388888888888889;
export const C3 = 0.0000248015873015873;
export const C4 = -2.755731922398589e-7;
export const C5 = 2.08767569878681e-9;
export const C6 = -1.1470745597729725e-11;
export const C7 = 4.779477332387385e-14;
export const C8 = -1.5619206968586225e-16;

/** atan(u) = u + u^3*(A1 + z*(A2 + ...)), z = u*u, |u| <= 1/64. A_k = (-1)^k/(2k+1). */
export const A1 = -0.3333333333333333;
export const A2 = 0.2;
export const A3 = -0.14285714285714285;
export const A4 = 0.1111111111111111;
export const A5 = -0.09090909090909091;
export const A6 = 0.07692307692307693;

/**
 * atan(k/32) for k in [0, 32], as a double-double: ATAN_HI[k] + ATAN_LO[k].
 *
 * The breakpoints are what keep the atan polynomial short. Reducing an argument
 * t in [0,1] to u = (t - k/32)/(1 + t*k/32) leaves |u| <= 1/64, where a degree-13
 * Taylor series is already far below one ulp -- and Taylor coefficients are exact
 * rationals, so no Remez implementation has to be trusted.
 */
export const ATAN_HI: readonly number[] = [
  0, 0.031239833430268277, 0.06241880999595735, 0.09347678115858947,
  0.12435499454676144, 0.15499674192394097, 0.18534794999569476, 0.21535769969773805,
  0.24497866312686414, 0.2741674511196588, 0.3028848683749714, 0.3310960767041321,
  0.35877067027057225, 0.38588266939807375, 0.4124104415973873, 0.43833655985795783,
  0.4636476090008061, 0.48833395105640554, 0.5123894603107377, 0.5358112379604637,
  0.5585993153435624, 0.5807563535676704, 0.6022873461349642, 0.6231993299340659,
  0.6435011087932844, 0.6632029927060933, 0.6823165548747481, 0.7008544078844502,
  0.7188299996216245, 0.7362574289814281, 0.7531512809621944, 0.7695264804056583,
  0.7853981633974483,
];
export const ATAN_LO: readonly number[] = [
  0, -1.188442711587748e-18, -1.5490756308295046e-18, -6.2844725995420954e-18,
  -3.1253241424539383e-18, 9.585415594114324e-18, 4.180692268843079e-18, 4.738160130078733e-19,
  1.0698755618734451e-17, 8.261353575163773e-18, -1.1010827903001369e-17, -7.952610375793799e-18,
  -2.4623815582638635e-17, 2.378822732491941e-17, -1.587652227770689e-17, -2.494277030626541e-17,
  2.2698777452961687e-17, -1.1373236189329585e-17, -2.5462781472855804e-17, -4.0637956834825575e-18,
  -5.4556305485916264e-18, -1.441464378193067e-17, 2.950430737228402e-17, 2.672403885140095e-17,
  1.5834785051444286e-17, -3.076054864429649e-17, 6.943223671560008e-18, -1.987626234335816e-17,
  -2.1478388444456983e-17, 3.473937648299457e-17, -2.4256934659182068e-17, -3.704991905602721e-17,
  3.061616997868383e-17,
];

// --- END GENERATED ----------------------------------------------------------

// ---------------------------------------------------------------------------
// Exact double primitives
// ---------------------------------------------------------------------------

/**
 * 2^27 + 1, Dekker's splitter. Multiplying by it and subtracting splits a double
 * into two halves of at most 26 significant bits each, whose product is
 * therefore exact. This is the only way to get an exact product of two doubles
 * without an FMA, and FMA is forbidden (section 2.3 of the specification: a
 * contracted multiply-add changes the result, so it must be asked for).
 *
 * Valid for |a| < 2^996; every argument passed below is bounded well inside that.
 */
const SPLITTER = 134217729;

/**
 * The exact error of the rounded product `p = fl(a*b)`, so that a*b = p + err
 * with no rounding anywhere. Uses only + - *.
 */
function prodErr(a: number, b: number, p: number): number {
  const ca = SPLITTER * a;
  const ah = ca - (ca - a);
  const al = a - ah;
  const cb = SPLITTER * b;
  const bh = cb - (cb - b);
  const bl = b - bh;
  return ah * bh - p + ah * bl + al * bh + al * bl;
}

/** Powers of two, built by repeated multiplication so they are exact by construction. */
function pow2(n: number): number {
  let v = 1;
  if (n >= 0) for (let i = 0; i < n; i++) v *= 2;
  else for (let i = 0; i < -n; i++) v /= 2;
  return v;
}

/** 2^-24*i for i in [0, 8]: the weight of each fraction limb of the reduction. */
const LIMB_WEIGHT: number[] = [];
for (let i = 0; i <= 8; i++) LIMB_WEIGHT.push(pow2(-24 * i));

const TWO24 = 16777216;
const TWO24M1 = 16777215;

/** 2^-27. Below this, sin(x) rounds to x and cos(x) rounds to 1. */
const TINY = pow2(-27);

/** Scaling guards that keep Dekker splitting inside its safe exponent range. */
const P256 = pow2(256);
const M256 = pow2(-256);

/** Reads the bit pattern of a double. Little-endian is irrelevant: both words are named. */
const BITS = new DataView(new ArrayBuffer(8));

// ---------------------------------------------------------------------------
// Payne-Hanek range reduction
// ---------------------------------------------------------------------------

/**
 * Scratch for the reduction. Nine 24-bit limbs: Q[0] is the integer part of
 * |x|*2/pi (mod 2^24, of which only the low 2 bits are used), Q[1..8] are 192
 * fraction bits.
 *
 * Module-level and reused so a call allocates nothing. This is NOT machine
 * state: every entry is written before it is read on every call, nothing
 * survives between calls, and the simulation is single-threaded by
 * specification (section 2.7), so there is no reentrancy to worry about. A
 * snapshot does not need to capture it, which is the property that matters.
 */
const Q = new Float64Array(9);

/** Output of `reduce`, for the same reason: three numbers, no allocation. */
let redQuad = 0;
let redHi = 0;
let redLo = 0;

/**
 * Reduce a positive finite `ax` greater than pi/4 to a quadrant and a remainder.
 *
 * Afterwards ax = redQuad*(pi/2) + r (mod 2*pi) where r = redHi + redLo and
 * |r| <= pi/4, with a relative accuracy of about 2^-100 -- enough that the
 * worst-case double, which lands within 2^-61 of a multiple of pi/2, still has
 * around 40 correct bits to spare.
 */
function reduce(ax: number): void {
  BITS.setFloat64(0, ax);
  const w0 = BITS.getUint32(0);
  const w1 = BITS.getUint32(4);
  const be = (w0 >>> 20) & 0x7ff;

  // |ax| > pi/4 > 2^-2, so the argument is always normal and the implicit
  // leading 1 is always there. Subnormals cannot reach this function.
  const mHi = (w0 & 0xfffff) | 0x100000; // bits 32..52 of the 53-bit mantissa
  const e = be - 1075; // |ax| = m * 2^e exactly

  // m as three 24-bit limbs, least significant first.
  const m0 = w1 & 0xffffff;
  const m1 = (w1 >>> 24) | ((mHi & 0xffff) << 8);
  const m2 = mHi >>> 16;

  // e = 24a + b with b in [0, 24), so every remaining shift is limb-aligned.
  const a = Math.floor(e / 24);
  const b = e - 24 * a;

  // m' = m * 2^b, four 24-bit limbs. Each t below is under 2^47, exact in f64.
  const shf = 1 << b;
  let t = m0 * shf;
  let c = Math.floor(t / TWO24);
  const p0 = t - c * TWO24;
  t = m1 * shf + c;
  c = Math.floor(t / TWO24);
  const p1 = t - c * TWO24;
  t = m2 * shf + c;
  c = Math.floor(t / TWO24);
  const p2 = t - c * TWO24;
  const p3 = c;

  for (let i = 0; i < 9; i++) Q[i] = 0;

  // |ax|*2/pi = sum_j m' * TWO_OVER_PI[j] * 2^(24*(a-j-1)), and limb u of m'
  // lands at output index j+1-a-u. Only indices 0..8 are kept: everything above
  // is a multiple of 2^24 and therefore vanishes mod 4, and everything below is
  // beyond 192 fraction bits.
  const jLo = a - 1 < 0 ? 0 : a - 1;
  const jHi = a + 10 < TWO_OVER_PI.length ? a + 10 : TWO_OVER_PI.length - 1;
  for (let j = jLo; j <= jHi; j++) {
    const tj = TWO_OVER_PI[j] as number;
    const base = j + 1 - a;
    let i = base;
    if (i >= 0 && i < 9) Q[i] = (Q[i] as number) + p0 * tj;
    i = base - 1;
    if (i >= 0 && i < 9) Q[i] = (Q[i] as number) + p1 * tj;
    i = base - 2;
    if (i >= 0 && i < 9) Q[i] = (Q[i] as number) + p2 * tj;
    i = base - 3;
    if (i >= 0 && i < 9) Q[i] = (Q[i] as number) + p3 * tj;
  }

  // Normalise. At most four products of at most 2^48 land in a limb, so nothing
  // here exceeds 2^51 and every value is an exact integer in a double.
  for (let i = 8; i >= 1; i--) {
    const v = Q[i] as number;
    const car = Math.floor(v / TWO24);
    Q[i] = v - car * TWO24;
    Q[i - 1] = (Q[i - 1] as number) + car;
  }

  const iv = Q[0] as number;
  let quad = (iv - 4 * Math.floor(iv / 4)) | 0;

  // Round to nearest: if the fraction is at least 1/2, take the next quadrant up
  // and carry a NEGATIVE remainder. The complement is taken on the LIMBS, not on
  // the assembled double: 1 - f loses every bit of f when f is close to 1, and f
  // close to 1 is exactly the case that produces a tiny sin and needs the bits.
  let sign = 1;
  if ((Q[1] as number) >= 8388608) {
    quad = (quad + 1) & 3;
    sign = -1;
    let borrow = 1;
    for (let i = 8; i >= 1; i--) {
      let v = TWO24M1 - (Q[i] as number) + borrow;
      if (v >= TWO24) {
        v -= TWO24;
        borrow = 1;
      } else {
        borrow = 0;
      }
      Q[i] = v;
    }
  }

  // Assemble the fraction as a double-double. Each term is an exact double (a
  // 24-bit integer times a power of two), so the only rounding is in the running
  // error sum, which is below 2^-103 relative.
  let s = 0;
  let err = 0;
  for (let i = 1; i <= 8; i++) {
    const term = (Q[i] as number) * (LIMB_WEIGHT[i] as number);
    const sum = s + term;
    const bb = sum - s;
    err += s - (sum - bb) + (term - bb);
    s = sum;
  }
  let fHi = s + err;
  let fLo = err - (fHi - s);
  if (sign < 0) {
    fHi = -fHi;
    fLo = -fLo;
  }

  // r = f * (pi/2), in double-double.
  const p = fHi * PIO2_H;
  const pe = prodErr(fHi, PIO2_H, p);
  const tail = pe + (fHi * PIO2_M + (fLo * PIO2_H + (fHi * PIO2_L + fLo * PIO2_M)));
  redHi = p + tail;
  redLo = tail - (redHi - p);
  redQuad = quad;
}

// ---------------------------------------------------------------------------
// Kernels, valid for |x| <= pi/4
// ---------------------------------------------------------------------------

/**
 * sin(x + y) for |x| <= pi/4 and |y| tiny, where x + y is the double-double
 * remainder from the reduction.
 *
 * The leading `x` is kept outside the polynomial so it contributes no rounding
 * at all: the polynomial only ever computes the correction x^3*(...), which is
 * at most 0.08 of the answer, so a rounding error there is worth an eighth of
 * what the same error would be worth in a bare Horner evaluation.
 */
function ksin(x: number, y: number): number {
  const z = x * x;
  const v = z * x;
  const r = S2 + z * (S3 + z * (S4 + z * (S5 + z * (S6 + z * (S7 + z * S8)))));
  if (y === 0) return x + v * (S1 + z * r);
  return x - (z * (0.5 * y - v * r) - y - v * S1);
}

/**
 * cos(x + y) for |x| <= pi/4.
 *
 * `1 - hz` rounds, and `(1 - w) - hz` is the EXACT error of that rounding --
 * both subtractions are exact by Sterbenz's lemma because w lies in [0.69, 1].
 * Adding it back is what keeps cos accurate near 1, where the naive form loses
 * a bit to a cancellation it never notices.
 */
function kcos(x: number, y: number): number {
  const z = x * x;
  const r = z * (C1 + z * (C2 + z * (C3 + z * (C4 + z * (C5 + z * (C6 + z * (C7 + z * C8)))))));
  const hz = 0.5 * z;
  const w = 1 - hz;
  return w + (1 - w - hz + (z * r - x * y));
}

// ---------------------------------------------------------------------------
// sin, cos
// ---------------------------------------------------------------------------

/**
 * Sine of an angle in radians. Normative: every Prime machine returns this
 * exact double for this exact argument.
 *
 * Non-finite arguments give NaN, matching IEEE 754 and `Math.sin`. Every finite
 * argument, including 2^1000, is fully reduced; there is no magnitude above
 * which accuracy quietly degrades.
 */
export function sin(x: number): number {
  const ax = x < 0 ? -x : x;
  if (!(ax < Infinity)) return NaN; // NaN and +-Infinity
  // Also the only path that returns -0, for sin(-0) = -0.
  if (ax < TINY) return x;
  if (ax <= PIO4_H) return ksin(x, 0);

  reduce(ax);
  let r: number;
  if (redQuad === 0) r = ksin(redHi, redLo);
  else if (redQuad === 1) r = kcos(redHi, redLo);
  else if (redQuad === 2) r = -ksin(redHi, redLo);
  else r = -kcos(redHi, redLo);
  return x < 0 ? -r : r;
}

/**
 * Cosine of an angle in radians. Normative.
 *
 * Reduced on |x| rather than x, because cosine is even and reducing the
 * magnitude means the quadrant table has four entries instead of eight.
 */
export function cos(x: number): number {
  const ax = x < 0 ? -x : x;
  if (!(ax < Infinity)) return NaN;
  if (ax < TINY) return 1;
  if (ax <= PIO4_H) return kcos(ax, 0);

  reduce(ax);
  if (redQuad === 0) return kcos(redHi, redLo);
  if (redQuad === 1) return -ksin(redHi, redLo);
  if (redQuad === 2) return -kcos(redHi, redLo);
  return ksin(redHi, redLo);
}

// ---------------------------------------------------------------------------
// atan2
// ---------------------------------------------------------------------------

/** Output of the atan helpers: atan of the reduced ratio, as a double-double. */
let atHi = 0;
let atLo = 0;

/**
 * atan(t) for t = tHi + tLo in [0, 1], into atHi/atLo.
 *
 * Reduction is by a breakpoint table: k = round(32t) picks c = k/32, and
 *
 *     atan(t) = atan(c) + atan( (t - c) / (1 + t*c) )
 *
 * leaves |u| <= 1/64. Two things follow, and both matter. The polynomial needs
 * only six terms, and -- more importantly -- the rounding error the reduction
 * itself introduces is proportional to u rather than to t, so it is worth a
 * fraction of an ulp of the answer instead of a whole one.
 *
 * `tHi - c` is EXACT: |t - c| <= 1/64 puts t within a factor of two of c for
 * every k >= 1, which is Sterbenz's condition, and k = 0 makes it a no-op.
 */
function atanUnit(tHi: number, tLo: number): void {
  const k = Math.round(tHi * 32);
  const c = k * 0.03125; // k/32, exact

  const nHi = tHi - c;
  const nLo = tLo;

  // d = 1 + t*c, double-double. |t*c| <= 1 so the fast two-sum is valid.
  const p = tHi * c;
  const pe = prodErr(tHi, c, p);
  const dHi = 1 + p;
  const dLo = p - (dHi - 1) + pe + tLo * c;

  // u = n/d, double-double: one division, then the exact residual divided again.
  const uHi = nHi / dHi;
  const qq = uHi * dHi;
  const qe = prodErr(uHi, dHi, qq);
  const uLo = (nHi - qq - qe + nLo - uHi * dLo) / dHi;

  const z = uHi * uHi;
  const poly = A1 + z * (A2 + z * (A3 + z * (A4 + z * (A5 + z * A6))));
  const corr = uHi * z * poly + uLo;

  const bh = ATAN_HI[k] as number;
  const bl = ATAN_LO[k] as number;
  const s = bh + uHi;
  const bb = s - bh;
  const lo = bh - (s - bb) + (uHi - bb) + bl + corr;
  atHi = s + lo;
  atLo = lo - (atHi - s);
}

/**
 * atan(num/den) for 0 < num <= den, both finite, into atHi/atLo.
 *
 * The quotient is taken as a double-double. A single rounded division would put
 * half an ulp of error into the argument before the polynomial ever runs, and
 * d(atan)/dt * t/atan(t) is close to 1 near zero, so that half ulp would survive
 * into the answer. The residual costs one exact product and one more division.
 *
 * Both operands are first scaled by a power of two into [2^-256, 2^256]. The
 * scaling is exact, cancels out of the quotient, and keeps Dekker's splitter
 * from overflowing on an operand near the top of the double range.
 */
function atanRatio(num: number, den: number): void {
  const qh0 = num / den;
  if (qh0 < TINY) {
    // atan(t) = t to within a quarter ulp here, and the double-double machinery
    // below would divide by a scaled operand for no gain.
    atHi = qh0;
    atLo = 0;
    return;
  }
  let sy = num;
  let sx = den;
  while (sx > P256) {
    sx *= M256;
    sy *= M256;
  }
  while (sx < M256) {
    sx *= P256;
    sy *= P256;
  }
  const qh = sy / sx;
  const p = qh * sx;
  const pe = prodErr(qh, sx, p);
  const ql = (sy - p - pe) / sx;
  atanUnit(qh, ql);
}

/** (aHi + aLo) - (bHi + bLo), renormalised into atHi/atLo. */
function ddSub(aHi: number, aLo: number, bHi: number, bLo: number): void {
  const s = aHi - bHi;
  const bb = s - aHi;
  const lo = aHi - (s - bb) + (-bHi - bb) + (aLo - bLo);
  atHi = s + lo;
  atLo = lo - (atHi - s);
}

/**
 * The angle of the vector (x, y), in radians, in (-pi, pi]. Normative.
 *
 * Special cases follow IEEE 754 / C99 exactly, including the ones that depend on
 * the sign of a zero: atan2(+0, -0) is +pi and atan2(-0, -0) is -pi. A game will
 * never hit those; a conformance runner comparing two implementations will, and
 * leaving them to chance would mean leaving them to differ.
 */
export function atan2(y: number, x: number): number {
  if (x !== x || y !== y) return NaN;

  const yNeg = y < 0 || (y === 0 && 1 / y < 0);
  const xNeg = x < 0 || (x === 0 && 1 / x < 0);
  const ay = y < 0 ? -y : y;
  const ax = x < 0 ? -x : x;

  if (ax === Infinity) {
    if (ay === Infinity) {
      const v = xNeg ? PI3O4 : PIO4_H;
      return yNeg ? -v : v;
    }
    if (xNeg) return yNeg ? -PI_H : PI_H;
    return yNeg ? -0 : 0;
  }
  if (ay === Infinity) return yNeg ? -PIO2_H : PIO2_H;
  if (y === 0) {
    if (xNeg) return yNeg ? -PI_H : PI_H;
    return yNeg ? -0 : 0;
  }
  if (x === 0) return yNeg ? -PIO2_H : PIO2_H;

  // atan(ay/ax) in [0, pi/2], as a double-double.
  if (ay <= ax) {
    atanRatio(ay, ax);
  } else {
    atanRatio(ax, ay);
    ddSub(PIO2_H, PIO2_M, atHi, atLo);
  }
  if (xNeg) ddSub(PI_H, PI_L, atHi, atLo);

  return yNeg ? -atHi : atHi;
}

// ---------------------------------------------------------------------------
// sqrt
// ---------------------------------------------------------------------------

/**
 * Square root. This one IS the platform's.
 *
 * IEEE 754 requires sqrt to be correctly rounded, in the same clause and with
 * the same force as + - * and /. Shipping a console implementation would be
 * strictly worse: slower, and no more identical. It is re-exported through this
 * file rather than left to the cart so that the ABI has one place where the
 * normative library lives, and so the line between "ours" and "the platform's"
 * is written down where someone reading the library will see it.
 *
 * Negative arguments give NaN, -0 gives -0, +Infinity gives +Infinity.
 */
export function sqrt(x: number): number {
  return Math.sqrt(x);
}
