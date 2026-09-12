import { describe, expect, it } from "vitest";

import {
  ATAN_HI,
  ATAN_LO,
  A1,
  A2,
  A3,
  A4,
  A5,
  A6,
  C1,
  C2,
  C3,
  C4,
  C5,
  C6,
  C7,
  C8,
  PI3O4,
  PIO2_H,
  PIO2_L,
  PIO2_M,
  PIO4_H,
  PIO4_L,
  PI_H,
  PI_L,
  S1,
  S2,
  S3,
  S4,
  S5,
  S6,
  S7,
  S8,
  TWO_OVER_PI,
  atan2,
  cos,
  sin,
  sqrt,
} from "../src/math";

/*
 * THE REFERENCE.
 *
 * math.ts argues that every intermediate it computes in doubles stays exact, or
 * that the error it does incur is bounded. This file does not argue: it
 * recomputes pi, every committed coefficient, and sin/cos/atan of every test
 * argument in BigInt fixed point, where exactness is free, and then measures the
 * disagreement in units in the last place.
 *
 * It is deliberately written from the mathematics rather than from math.ts. The
 * series here are the textbook ones and the reduction here is a single BigInt
 * division -- nothing is shared with the implementation, so a bug in the
 * implementation's limb arithmetic cannot hide inside the thing that checks it.
 *
 * Math.sin appears exactly once, at the bottom, as a sanity check with a stated
 * tolerance. It is never the source of an expected value: it is the thing whose
 * disagreement with us across engines is the reason this package exists.
 */

/** Working precision: everything is an integer representing value * 2^P. */
const P = 1400n;
const S = 1n << P;

const DV = new DataView(new ArrayBuffer(8));

function bitsOf(d: number): bigint {
  DV.setFloat64(0, d);
  return DV.getBigUint64(0);
}

function fromBits(bits: bigint): number {
  DV.setBigUint64(0, bits);
  return DV.getFloat64(0);
}

function bitLength(v: bigint): bigint {
  return BigInt(v.toString(2).length);
}

function abs(v: bigint): bigint {
  return v < 0n ? -v : v;
}

/** The EXACT value of a double, as an integer representing value * 2^P. */
function exactFixed(d: number): bigint {
  if (d === 0) return 0n;
  const bits = bitsOf(d);
  const neg = bits >> 63n === 1n;
  const be = (bits >> 52n) & 0x7ffn;
  const frac = bits & ((1n << 52n) - 1n);
  const m = be === 0n ? frac : frac | (1n << 52n);
  const e = be === 0n ? -1074n : be - 1075n;
  const v = m << (e + P); // e + P > 0 for every finite double, so this is exact
  return neg ? -v : v;
}

/** The double nearest v * 2^-P, ties to even. */
function roundToDouble(v: bigint): number {
  if (v === 0n) return 0;
  const neg = v < 0n;
  const a = neg ? -v : v;
  const shift = bitLength(a) - 53n;
  let q: bigint;
  if (shift > 0n) {
    q = a >> shift;
    const r = a - (q << shift);
    const half = 1n << (shift - 1n);
    if (r > half || (r === half && (q & 1n) === 1n)) q += 1n;
  } else {
    q = a << -shift;
  }
  let e = shift - P;
  if (q === 1n << 53n) {
    q >>= 1n;
    e += 1n;
  }
  const be = e + 1075n;
  if (be <= 0n || be >= 2047n) throw new Error("roundToDouble: out of normal range");
  return fromBits((neg ? 1n << 63n : 0n) | (be << 52n) | (q - (1n << 52n)));
}

function isqrt(n: bigint): bigint {
  if (n < 2n) return n;
  let x = 1n << ((bitLength(n) + 1n) >> 1n);
  for (;;) {
    const y = (x + n / x) >> 1n;
    if (y >= x) return x;
    x = y;
  }
}

/** round(atan(1/x) * 2^P), integer x >= 2. */
function atanInvInt(x: bigint): bigint {
  const x2 = x * x;
  let pow = x;
  let sum = 0n;
  let k = 0n;
  for (;;) {
    const t = S / (pow * (2n * k + 1n));
    if (t === 0n) break;
    sum += k % 2n === 0n ? t : -t;
    pow *= x2;
    k += 1n;
  }
  return sum;
}

const PI = 16n * atanInvInt(5n) - 4n * atanInvInt(239n);
const PIO2 = PI / 2n;

/** sin of a non-negative fixed-point argument at most pi/4. */
function sinAbsFx(r: bigint): bigint {
  const rr = (r * r) / S;
  let term = r;
  let acc = r;
  let k = 1n;
  for (;;) {
    term = (term * rr) / S / (2n * k * (2n * k + 1n));
    if (term === 0n) break;
    acc += k % 2n === 1n ? -term : term;
    k += 1n;
  }
  return acc;
}

/** cos of a non-negative fixed-point argument at most pi/4. */
function cosAbsFx(r: bigint): bigint {
  const rr = (r * r) / S;
  let term = S;
  let acc = S;
  let k = 1n;
  for (;;) {
    term = (term * rr) / S / ((2n * k - 1n) * (2n * k));
    if (term === 0n) break;
    acc += k % 2n === 1n ? -term : term;
    k += 1n;
  }
  return acc;
}

/** Nearest integer to n/d, d > 0. */
function nearestDiv(n: bigint, d: bigint): bigint {
  if (n >= 0n) return (2n * n + d) / (2n * d);
  return -((2n * -n + d) / (2n * d));
}

/** sin(x) and cos(x) of a finite double, as exact fixed point. */
function sinCosRef(x: number): [bigint, bigint] {
  const xf = exactFixed(x);
  const n = nearestDiv(xf, PIO2);
  const r = xf - n * PIO2; // |r| <= PIO2/2
  const ar = abs(r);
  const sr = sinAbsFx(ar);
  const cr = cosAbsFx(ar);
  const sPos = r < 0n ? -sr : sr;
  const q = ((n % 4n) + 4n) % 4n;
  if (q === 0n) return [sPos, cr];
  if (q === 1n) return [cr, -sPos];
  if (q === 2n) return [-sPos, -cr];
  return [-cr, sPos];
}

/** atan of a non-negative fixed-point value, any magnitude. */
function atanFx(z: bigint): bigint {
  if (z > S) return PIO2 - atanFx((S * S) / z);
  const HALVINGS = 6;
  let w = z;
  for (let i = 0; i < HALVINGS; i++) {
    const root = isqrt((S + (w * w) / S) * S);
    w = (w * S) / (S + root);
  }
  const ww = (w * w) / S;
  let term = w;
  let acc = w;
  let k = 1n;
  for (;;) {
    term = (term * ww) / S;
    const t = term / (2n * k + 1n);
    if (t === 0n) break;
    acc += k % 2n === 0n ? t : -t;
    k += 1n;
  }
  return acc << BigInt(HALVINGS);
}

/** atan2(y, x) for finite non-zero y and x, as exact fixed point. */
function atan2Ref(y: number, x: number): bigint {
  const yf = exactFixed(y);
  const xf = exactFixed(x);
  const a = atanFx((abs(yf) * S) / abs(xf));
  const q = xf < 0n ? PI - a : a;
  return yf < 0n ? -q : q;
}

/**
 * The disagreement between a computed double and an exact value, in ulps of the
 * exact value. Half an ulp is the best any implementation can do; one ulp is the
 * usual libm claim.
 */
function ulps(got: number, exact: bigint): number {
  if (exact === 0n) return got === 0 ? 0 : Infinity;
  const bl = bitLength(abs(exact));
  const ulpFixed = bl >= 53n ? 1n << (bl - 53n) : 1n; // the spacing of doubles at `exact`
  const err = abs(exactFixed(got) - exact);
  return Number((err * 4096n) / ulpFixed) / 4096;
}

/* A seeded generator, deliberately not the console PRNG: a bug there must not
 * be able to hide a bug here. mulberry32, chosen for being short. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1) >>> 0;
    t = (t ^ (t + Math.imul(t ^ (t >>> 7), t | 61))) >>> 0;
    return (t ^ (t >>> 14)) >>> 0;
  };
}

/** A double with a chosen unbiased exponent and random mantissa. */
function randomDouble(rng: () => number, expo: number): number {
  const hi = rng();
  const lo = rng();
  const be = BigInt(expo + 1023);
  const frac = ((BigInt(hi) << 32n) | BigInt(lo)) & ((1n << 52n) - 1n);
  const sign = (hi & 0x80000000) !== 0 ? 1n << 63n : 0n;
  return fromBits(sign | (be << 52n) | frac);
}

const SLOW = process.env["SQ1_SLOW"] === "1";

// ---------------------------------------------------------------------------

describe("the committed constants", () => {
  it("recomputes 2/pi bit for bit", () => {
    const twoOverPi = (2n * S * S) / PI;
    for (let j = 0; j < TWO_OVER_PI.length; j++) {
      const sh = P - 24n * BigInt(j + 1);
      expect(TWO_OVER_PI[j]).toBe(Number((twoOverPi >> sh) & 0xffffffn));
    }
  });

  it("recomputes the pi expansions", () => {
    const split = (v: bigint, n: number): number[] => {
      const out: number[] = [];
      let rest = v;
      for (let i = 0; i < n; i++) {
        const d = roundToDouble(rest);
        out.push(d);
        rest -= exactFixed(d);
      }
      return out;
    };
    expect(split(PIO2, 3)).toEqual([PIO2_H, PIO2_M, PIO2_L]);
    expect(split(PI, 2)).toEqual([PI_H, PI_L]);
    expect(split(PI / 4n, 2)).toEqual([PIO4_H, PIO4_L]);
    expect(roundToDouble((3n * PI) / 4n)).toBe(PI3O4);
  });

  it("recomputes every polynomial coefficient from its exact rational", () => {
    const fact = (n: number): bigint => {
      let f = 1n;
      for (let i = 2; i <= n; i++) f *= BigInt(i);
      return f;
    };
    const ratio = (sign: number, num: bigint, den: bigint): number =>
      roundToDouble(sign < 0 ? -((num * S) / den) : (num * S) / den);

    // S_k = (-1)^k / (2k+1)!
    const sc = [S1, S2, S3, S4, S5, S6, S7, S8];
    for (let k = 1; k <= 8; k++) {
      expect(sc[k - 1]).toBe(ratio(k % 2 === 0 ? 1 : -1, 1n, fact(2 * k + 1)));
    }
    // C_k = (-1)^(k+1) / (2k+2)!
    const cc = [C1, C2, C3, C4, C5, C6, C7, C8];
    for (let k = 1; k <= 8; k++) {
      expect(cc[k - 1]).toBe(ratio(k % 2 === 1 ? 1 : -1, 1n, fact(2 * k + 2)));
    }
    // A_k = (-1)^k / (2k+1)
    const ac = [A1, A2, A3, A4, A5, A6];
    for (let k = 1; k <= 6; k++) {
      expect(ac[k - 1]).toBe(ratio(k % 2 === 0 ? 1 : -1, 1n, BigInt(2 * k + 1)));
    }
  });

  it("recomputes every atan breakpoint", () => {
    for (let k = 0; k <= 32; k++) {
      const v = k === 0 ? 0n : atanFx((BigInt(k) * S) / 32n);
      const hi = roundToDouble(v);
      const lo = k === 0 ? 0 : roundToDouble(v - exactFixed(hi));
      expect(ATAN_HI[k]).toBe(k === 0 ? 0 : hi);
      expect(ATAN_LO[k]).toBe(lo);
    }
  });

  it("writes every literal with at most 20 significant digits", () => {
    // A decimal literal with more than 20 significant digits may be rounded
    // either of two ways by a conforming implementation (ECMAScript, MV of
    // NumericLiteral). Inside 20 digits the rounding is mandated, so a literal
    // that round-trips here round-trips on every engine.
    const all: number[] = [
      PIO2_H, PIO2_M, PIO2_L, PI_H, PI_L, PIO4_H, PIO4_L, PI3O4,
      S1, S2, S3, S4, S5, S6, S7, S8,
      C1, C2, C3, C4, C5, C6, C7, C8,
      A1, A2, A3, A4, A5, A6,
      ...ATAN_HI, ...ATAN_LO,
    ];
    for (const d of all) {
      const s = String(d);
      expect(Number(s)).toBe(d);
      const digits = s.replace(/[-+.]/g, "").replace(/e.*$/i, "").replace(/^0+/, "");
      expect(digits.length).toBeLessThanOrEqual(20);
    }
  });
});

describe("sin and cos against a BigInt reference", () => {
  /** Runs a batch and returns the worst ulp error seen for sin and for cos. */
  function measure(args: readonly number[]): { sin: number; cos: number; at: number } {
    let ws = 0;
    let wc = 0;
    let at = 0;
    for (const x of args) {
      const [sRef, cRef] = sinCosRef(x);
      const es = ulps(sin(x), sRef);
      const ec = ulps(cos(x), cRef);
      if (es > ws) {
        ws = es;
        at = x;
      }
      if (ec > wc) wc = ec;
    }
    return { sin: ws, cos: wc, at };
  }

  it("is accurate on small arguments, where there is no reduction", () => {
    const rng = mulberry32(0x5eed);
    const args: number[] = [];
    for (let i = 0; i < (SLOW ? 40_000 : 4000); i++) {
      args.push(randomDouble(rng, -1 - (rng() % 40)));
    }
    const w = measure(args);
    expect(w.sin).toBeLessThan(1);
    expect(w.cos).toBeLessThan(1);
  });

  it("is accurate across the whole exponent range, up to 2^1000", () => {
    const rng = mulberry32(0xc0ffee);
    const args: number[] = [];
    for (let i = 0; i < (SLOW ? 40_000 : 3000); i++) {
      args.push(randomDouble(rng, (rng() % 1020) - 20));
    }
    const w = measure(args);
    expect(w.sin).toBeLessThan(1);
    expect(w.cos).toBeLessThan(1);
  });

  it("is accurate at the reduction boundaries, where sin is nearly zero", () => {
    // The doubles nearest k*pi/2 for many k. These are the arguments where the
    // remainder is tiny and every bit of the reduction has to be right; a
    // Cody-Waite implementation is worth hundreds of ulps here.
    const args: number[] = [];
    for (let k = 1; k <= (SLOW ? 20000 : 2000); k++) {
      const c = roundToDouble(BigInt(k) * PIO2);
      args.push(c);
      args.push(fromBits(bitsOf(c) + 1n));
      args.push(fromBits(bitsOf(c) - 1n));
      args.push(-c);
    }
    const w = measure(args);
    expect(w.sin).toBeLessThan(1);
    expect(w.cos).toBeLessThan(1);
  });

  it("is accurate on the known worst case for f64 argument reduction", () => {
    // 6381956970095103 * 2^797, the double closest to an odd multiple of pi/2 in
    // the whole binary64 range: the remainder is about 2^-61, so the reduction
    // has to be right to roughly 114 bits for the answer to have 53.
    const x = roundToDouble(6381956970095103n * (1n << 797n) * S);
    const [sRef, cRef] = sinCosRef(x);
    expect(ulps(sin(x), sRef)).toBeLessThan(1);
    expect(ulps(cos(x), cRef)).toBeLessThan(1);
    // The quadrant is odd, so it is COS that collapses -- to 4.7e-19, about
    // 2^-61. Getting that value right at all is the whole case for Payne-Hanek:
    // a Cody-Waite reduction has no bits left here and returns garbage.
    expect(Math.abs(cos(x))).toBeLessThan(1e-18);
    expect(Math.abs(sin(x))).toBe(1);
  });

  it("reports the worst ulp error it can find", () => {
    const rng = mulberry32(0xd15ea5e);
    const args: number[] = [];
    for (let i = 0; i < (SLOW ? 100_000 : 6000); i++) {
      args.push(randomDouble(rng, (rng() % 200) - 60));
    }
    for (let k = 1; k <= 400; k++) {
      const c = roundToDouble(BigInt(k) * PIO2);
      args.push(c, fromBits(bitsOf(c) + 1n), fromBits(bitsOf(c) - 1n));
    }
    const w = measure(args);
    // The measured worst case over 100k arguments under SQ1_SLOW=1 is 0.76 ulp
    // for sin and 0.74 for cos, so both are FAITHFULLY rounded: never more than
    // one ulp, and in practice never more than three quarters of one. The bound
    // is set just above that, not at some round number, so a regression that
    // costs a quarter of an ulp still turns the build red.
    expect(w.sin).toBeLessThan(0.8);
    expect(w.cos).toBeLessThan(0.8);
  });

  it("handles the exact special values", () => {
    expect(sin(0)).toBe(0);
    expect(1 / sin(0)).toBe(Infinity);
    expect(sin(-0)).toBe(-0);
    expect(1 / sin(-0)).toBe(-Infinity); // sin(-0) must be -0, not +0
    expect(cos(0)).toBe(1);
    expect(cos(-0)).toBe(1);
    expect(sin(NaN)).toBeNaN();
    expect(cos(NaN)).toBeNaN();
    expect(sin(Infinity)).toBeNaN();
    expect(sin(-Infinity)).toBeNaN();
    expect(cos(Infinity)).toBeNaN();
    expect(cos(-Infinity)).toBeNaN();
    expect(sin(5e-324)).toBe(5e-324); // subnormal passes straight through
    expect(cos(5e-324)).toBe(1);
  });

  it("is odd in sin and even in cos, exactly", () => {
    const rng = mulberry32(7);
    for (let i = 0; i < 2000; i++) {
      const x = randomDouble(rng, (rng() % 60) - 30);
      expect(sin(-x)).toBe(-sin(x));
      expect(cos(-x)).toBe(cos(x));
    }
  });

  it("is a pure function: the same argument always gives the same bits", () => {
    // The reduction writes to module-level scratch. If any of it survived a
    // call, an interleaved sequence would differ from an isolated one.
    const rng = mulberry32(11);
    const xs: number[] = [];
    for (let i = 0; i < 500; i++) xs.push(randomDouble(rng, (rng() % 900) - 30));
    const isolated = xs.map((x) => [sin(x), cos(x)]);
    // Interleave with unrelated calls, in a different order.
    const shuffled = [...xs].reverse();
    for (const x of shuffled) {
      sin(x * 3);
      cos(x / 7);
      atan2(x, 1.5);
    }
    for (let i = 0; i < xs.length; i++) {
      expect([sin(xs[i] as number), cos(xs[i] as number)]).toEqual(isolated[i]);
    }
  });
});

describe("atan2 against a BigInt reference", () => {
  it("is accurate over the whole plane", () => {
    const rng = mulberry32(0xa71a2);
    let worst = 0;
    const n = SLOW ? 60_000 : 5000;
    for (let i = 0; i < n; i++) {
      const y = randomDouble(rng, (rng() % 120) - 60);
      const x = randomDouble(rng, (rng() % 120) - 60);
      if (y === 0 || x === 0) continue;
      const e = ulps(atan2(y, x), atan2Ref(y, x));
      if (e > worst) worst = e;
    }
    expect(worst).toBeLessThan(0.7); // measured worst: 0.617 ulp
  });

  it("is accurate where the ratio is extreme", () => {
    const rng = mulberry32(0xb0a7);
    let worst = 0;
    for (let i = 0; i < (SLOW ? 40_000 : 3000); i++) {
      const y = randomDouble(rng, (rng() % 40) - 20);
      const x = randomDouble(rng, (rng() % 40) + 260); // |y/x| ~ 2^-300
      const e = ulps(atan2(y, x), atan2Ref(y, x));
      if (e > worst) worst = e;
      const e2 = ulps(atan2(x, y), atan2Ref(x, y));
      if (e2 > worst) worst = e2;
    }
    expect(worst).toBeLessThan(0.55); // measured worst: 0.4998 ulp
  });

  it("is accurate near every breakpoint of the reduction table", () => {
    let worst = 0;
    for (let k = 0; k <= 32; k++) {
      for (let d = -3; d <= 3; d++) {
        const t = k * 0.03125;
        const y = t === 0 ? 0 : fromBits(bitsOf(t) + BigInt(d));
        if (y === 0) continue;
        for (const x of [1, -1, 3, -7.25]) {
          const e = ulps(atan2(y, x), atan2Ref(y, x));
          if (e > worst) worst = e;
          const e2 = ulps(atan2(-y, x), atan2Ref(-y, x));
          if (e2 > worst) worst = e2;
        }
      }
    }
    expect(worst).toBeLessThan(0.55); // measured worst: 0.498 ulp
  });

  it("gets every IEEE special case exactly right", () => {
    const cases: [number, number, number][] = [
      [0, 1, 0],
      [-0, 1, -0],
      [0, -1, PI_H],
      [-0, -1, -PI_H],
      [0, 0, 0],
      [-0, 0, -0],
      [0, -0, PI_H],
      [-0, -0, -PI_H],
      [1, 0, PIO2_H],
      [-1, 0, -PIO2_H],
      [1, -0, PIO2_H],
      [-1, -0, -PIO2_H],
      [Infinity, 1, PIO2_H],
      [-Infinity, 1, -PIO2_H],
      [1, Infinity, 0],
      [-1, Infinity, -0],
      [1, -Infinity, PI_H],
      [-1, -Infinity, -PI_H],
      [Infinity, Infinity, PIO4_H],
      [-Infinity, Infinity, -PIO4_H],
      [Infinity, -Infinity, PI3O4],
      [-Infinity, -Infinity, -PI3O4],
    ];
    for (const [y, x, want] of cases) {
      const got = atan2(y, x);
      expect(got).toBe(want);
      // Signed zeros compare equal under toBe's Object.is, but be explicit.
      if (want === 0) expect(1 / got).toBe(1 / want);
      // And every one of them agrees with the platform, which IS specified here.
      expect(got).toBe(Math.atan2(y, x));
    }
    expect(atan2(NaN, 1)).toBeNaN();
    expect(atan2(1, NaN)).toBeNaN();
    expect(atan2(NaN, NaN)).toBeNaN();
  });
});

describe("sqrt is the platform's, and that is the point", () => {
  it("is correctly rounded, which IEEE 754 requires of it", () => {
    const rng = mulberry32(3);
    for (let i = 0; i < 3000; i++) {
      const x = randomDouble(rng, (rng() % 200) - 100);
      const ax = Math.abs(x);
      const got = sqrt(ax);
      // r = round(sqrt(ax)) checked by squaring in exact arithmetic: `got` must
      // be the closest double, i.e. no neighbour is closer to the true root.
      const exact = exactFixed(ax);
      const root = isqrt(exact << P); // sqrt(ax) * 2^P, floored
      expect(ulps(got, root)).toBeLessThanOrEqual(0.5);
    }
  });

  it("keeps the IEEE special cases", () => {
    expect(sqrt(0)).toBe(0);
    expect(1 / sqrt(-0)).toBe(-Infinity);
    expect(sqrt(-1)).toBeNaN();
    expect(sqrt(Infinity)).toBe(Infinity);
    expect(sqrt(4)).toBe(2);
  });
});

describe("cross-check against the platform library", () => {
  /*
   * Math.sin is NOT the reference -- it is implementation-approximated, and the
   * reason this package exists. But it is correct to about an ulp on every
   * engine anyone runs, so a large disagreement means we are wrong, not that the
   * platform is. This test is the smoke alarm, with the tolerance stated.
   */
  it("agrees with Math.sin, Math.cos and Math.atan2 to within 4 ulps", () => {
    const rng = mulberry32(0xfeed);
    for (let i = 0; i < 5000; i++) {
      const x = randomDouble(rng, (rng() % 30) - 10);
      const [sRef] = sinCosRef(x);
      expect(ulps(Math.sin(x), sRef)).toBeLessThan(4);
      expect(ulps(sin(x), sRef)).toBeLessThanOrEqual(ulps(Math.sin(x), sRef) + 1);
      const y = randomDouble(rng, (rng() % 30) - 10);
      if (x !== 0 && y !== 0) {
        expect(ulps(Math.atan2(y, x), atan2Ref(y, x))).toBeLessThan(4);
      }
    }
  });
});
