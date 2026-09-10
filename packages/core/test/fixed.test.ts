import { describe, it, expect } from "vitest";
import {
  FP_SHIFT,
  FP_ONE,
  FP_MIN,
  FP_MAX,
  sat,
  fmul,
  fdiv,
  fromInt,
  toInt,
  fromFloat,
  toFloat,
} from "../src/fixed";

/*
 * The reference implementation.
 *
 * fixed.ts computes in doubles and has to argue that every intermediate stays
 * exact. This file does not argue: it recomputes the same quantities in
 * BigInt, where exactness is free, and demands they agree. If fixed.ts is ever
 * "optimised", this is the thing that notices.
 */

/**
 * BigInt `/` truncates toward zero, which is NOT what 16.16 does. Floor and
 * truncate agree for non-negative results and differ by one everywhere else,
 * so a truncating reference would silently bless a broken fmul for exactly
 * the half of the input space that matters most.
 */
function floorDiv(n: bigint, d: bigint): bigint {
  const q = n / d;
  // Correct the truncation when the exact quotient is negative and inexact.
  if (n % d !== 0n && n < 0n !== d < 0n) return q - 1n;
  return q;
}

const BIG_MIN = BigInt(FP_MIN);
const BIG_MAX = BigInt(FP_MAX);

function saturate(x: bigint): number {
  if (x > BIG_MAX) return FP_MAX;
  if (x < BIG_MIN) return FP_MIN;
  return Number(x);
}

function refMul(a: number, b: number): number {
  return saturate(floorDiv(BigInt(a) * BigInt(b), 65536n));
}

function refDiv(a: number, b: number): number {
  if (b === 0) return a >= 0 ? FP_MAX : FP_MIN;
  return saturate(floorDiv(BigInt(a) * 65536n, BigInt(b)));
}

/*
 * A seeded generator, deliberately NOT the console PRNG: a bug in prng.ts must
 * not be able to hide a bug in fixed.ts, and a shared bug must not be able to
 * hide both. mulberry32, chosen only because it is short and reproducible.
 */
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

/**
 * Values that break naive implementations: the format's own landmarks, the
 * 2^15 / 2^16 boundaries where the 16-bit split in fmul changes limbs, and
 * the magnitudes whose products overflow int32 in both directions.
 */
const EDGES: readonly number[] = [
  0, 1, -1, 2, -2,
  FP_ONE, -FP_ONE, FP_ONE + 1, FP_ONE - 1, -FP_ONE + 1, -FP_ONE - 1,
  FP_MAX, FP_MIN, FP_MAX - 1, FP_MIN + 1,
  // around +-2^15
  32767, 32768, 32769, -32767, -32768, -32769,
  // around +-2^16
  65535, 65537, -65535, -65537,
  // limb boundaries and the top of the range
  0x7fff0000, -0x7fff0000, 0x00010000, 1 << 30, -(1 << 30), (1 << 30) + 1,
  // 2^24 is 256.0; 2^24 * 2^24 / 2^16 = 2^32, one bit past FP_MAX, so pairs
  // drawn from here force saturation in both directions.
  1 << 24, -(1 << 24), 1 << 23, -(1 << 23), (1 << 24) + 1, -((1 << 24) + 1),
  123456789, -123456789, 1000000, -1000000,
];

/**
 * fmul and fdiv are specified on int32 operands, and both start by
 * reinterpreting their arguments as int32 (`a >> 16` runs ToInt32 first).
 * Feeding them 2^31 would therefore test something other than what is
 * specified, so the table is held to the domain.
 */
for (const v of EDGES) {
  if ((v | 0) !== v) throw new Error(`EDGES entry ${v} is not an int32`);
}

describe("fixed: constants", () => {
  it("has the spec's values", () => {
    expect(FP_SHIFT).toBe(16);
    expect(FP_ONE).toBe(65536);
    expect(FP_ONE).toBe(1 << FP_SHIFT);
    expect(FP_MIN).toBe(-2147483648);
    expect(FP_MAX).toBe(2147483647);
  });
});

describe("fixed: sat", () => {
  it("clamps rather than wraps", () => {
    expect(sat(FP_MAX + 1)).toBe(FP_MAX);
    expect(sat(FP_MIN - 1)).toBe(FP_MIN);
    expect(sat(1e30)).toBe(FP_MAX);
    expect(sat(-1e30)).toBe(FP_MIN);
    expect(sat(Infinity)).toBe(FP_MAX);
    expect(sat(-Infinity)).toBe(FP_MIN);
    expect(sat(FP_MAX)).toBe(FP_MAX);
    expect(sat(FP_MIN)).toBe(FP_MIN);
    expect(sat(0)).toBe(0);
    expect(sat(-1)).toBe(-1);
  });

  it("never returns a value outside int32", () => {
    for (const v of EDGES) {
      const r = sat(v);
      expect(r).toBeGreaterThanOrEqual(FP_MIN);
      expect(r).toBeLessThanOrEqual(FP_MAX);
      expect(r | 0).toBe(r);
    }
  });
});

describe("fixed: fmul / fdiv against a BigInt reference", () => {
  it("agrees on the edge-case table (every ordered pair)", () => {
    let checked = 0;
    for (const a of EDGES) {
      for (const b of EDGES) {
        const gotM = fmul(a, b);
        const wantM = refMul(a, b);
        if (gotM !== wantM) {
          throw new Error(`fmul(${a}, ${b}) = ${gotM}, reference = ${wantM}`);
        }
        const gotD = fdiv(a, b);
        const wantD = refDiv(a, b);
        if (gotD !== wantD) {
          throw new Error(`fdiv(${a}, ${b}) = ${gotD}, reference = ${wantD}`);
        }
        checked++;
      }
    }
    expect(checked).toBe(EDGES.length * EDGES.length);
  });

  it("saturates in both directions", () => {
    // 256.0 * 256.0 = 65536.0, which needs 33 bits above the point.
    expect(fmul(1 << 24, 1 << 24)).toBe(FP_MAX);
    expect(fmul(1 << 24, -(1 << 24))).toBe(FP_MIN);
    expect(fmul(-(1 << 24), 1 << 24)).toBe(FP_MIN);
    expect(fmul(-(1 << 24), -(1 << 24))).toBe(FP_MAX);
    // One step below saturation still lands inside the range, so the clamp is
    // not simply firing on everything large.
    expect(fmul(1 << 23, 1 << 23)).toBe(1 << 30);
    expect(fmul(FP_MAX, FP_MAX)).toBe(FP_MAX);
    expect(fmul(FP_MIN, FP_MIN)).toBe(FP_MAX);
    expect(fmul(FP_MAX, FP_MIN)).toBe(FP_MIN);
    // Dividing by a small fraction blows up.
    expect(fdiv(FP_MAX, 1)).toBe(FP_MAX);
    expect(fdiv(FP_MIN, 1)).toBe(FP_MIN);
    expect(fdiv(FP_MAX, -1)).toBe(FP_MIN);
    // FP_MIN / -1 would be +2^31, one past the top.
    expect(fdiv(FP_MIN, -FP_ONE)).toBe(FP_MAX);
  });

  const PAIRS = process.env["SQ1_SLOW"] === "1" ? 1_000_000 : 100_000;

  it(`agrees on ${PAIRS.toLocaleString("en-US")} pseudorandom i32 pairs`, () => {
    const rnd = mulberry32(0x51ce0001);
    let checked = 0;
    for (let i = 0; i < PAIRS; i++) {
      // Every 4th operand is drawn from the edge table instead of the full
      // range, so the run also samples the boundaries densely and hits mixed
      // huge-vs-tiny pairs that pure uniform sampling almost never produces.
      const ra = rnd();
      const rb = rnd();
      const a = i % 4 === 0 ? (EDGES[ra % EDGES.length] as number) : ra | 0;
      const b = i % 4 === 1 ? (EDGES[rb % EDGES.length] as number) : rb | 0;

      const gotM = fmul(a, b);
      const wantM = refMul(a, b);
      if (gotM !== wantM) {
        throw new Error(
          `fmul mismatch at iteration ${i}: fmul(${a}, ${b}) = ${gotM}, reference = ${wantM}`,
        );
      }
      const gotD = fdiv(a, b);
      const wantD = refDiv(a, b);
      if (gotD !== wantD) {
        throw new Error(
          `fdiv mismatch at iteration ${i}: fdiv(${a}, ${b}) = ${gotD}, reference = ${wantD}`,
        );
      }
      checked++;
    }
    expect(checked).toBe(PAIRS);
  });

  it("agrees on small-magnitude pairs, exhaustively around zero", () => {
    for (let a = -300; a <= 300; a++) {
      for (let b = -300; b <= 300; b++) {
        if (fmul(a, b) !== refMul(a, b)) {
          throw new Error(`fmul(${a}, ${b}) = ${fmul(a, b)}, reference = ${refMul(a, b)}`);
        }
        if (fdiv(a, b) !== refDiv(a, b)) {
          throw new Error(`fdiv(${a}, ${b}) = ${fdiv(a, b)}, reference = ${refDiv(a, b)}`);
        }
      }
    }
  });
});

describe("fixed: rounding is floor, not truncation", () => {
  it("fmul rounds a negative product toward negative infinity", () => {
    // 0.5 * -1 (one raw unit) = -0.5 units -> floor is -1, truncation gives 0.
    expect(fmul(FP_ONE / 2, -1)).toBe(-1);
    expect(fmul(-1, FP_ONE / 2)).toBe(-1);
    // The positive mirror really does truncate to 0, which is also floor.
    expect(fmul(FP_ONE / 2, 1)).toBe(0);
    // -1/65536 * 1/65536 = -1/2^32 -> floor is -1.
    expect(fmul(-1, 1)).toBe(-1);
    // A quarter of a raw unit, negative.
    expect(fmul(-1, FP_ONE / 4)).toBe(-1);
    // Exact products are unaffected by the rounding rule.
    expect(fmul(-FP_ONE, FP_ONE)).toBe(-FP_ONE);
    expect(fmul(-3 * FP_ONE, 5 * FP_ONE)).toBe(-15 * FP_ONE);
  });

  it("fdiv rounds a negative quotient toward negative infinity", () => {
    // -1 raw unit / 2.0 = -0.5 raw units -> -1.
    expect(fdiv(-1, 2 * FP_ONE)).toBe(-1);
    expect(fdiv(1, 2 * FP_ONE)).toBe(0);
    // -1.0 / 3.0 = -21845.333... -> -21846, not -21845.
    expect(fdiv(-FP_ONE, 3 * FP_ONE)).toBe(-21846);
    expect(fdiv(FP_ONE, 3 * FP_ONE)).toBe(21845);
    expect(fdiv(-FP_ONE, 3 * FP_ONE)).toBe(-fdiv(FP_ONE, 3 * FP_ONE) - 1);
  });

  it("toInt floors", () => {
    expect(toInt(FP_ONE)).toBe(1);
    expect(toInt(FP_ONE + FP_ONE / 2)).toBe(1);
    expect(toInt(-1)).toBe(-1);
    expect(toInt(-FP_ONE)).toBe(-1);
    expect(toInt(-FP_ONE - 1)).toBe(-2);
    expect(toInt(-FP_ONE / 2)).toBe(-1);
    expect(toInt(0)).toBe(0);
    expect(toInt(FP_MAX)).toBe(32767);
    expect(toInt(FP_MIN)).toBe(-32768);
  });
});

describe("fixed: fdiv by zero is defined", () => {
  it("returns FP_MAX or FP_MIN by the sign of the numerator", () => {
    expect(fdiv(1, 0)).toBe(FP_MAX);
    expect(fdiv(FP_ONE, 0)).toBe(FP_MAX);
    expect(fdiv(FP_MAX, 0)).toBe(FP_MAX);
    expect(fdiv(0, 0)).toBe(FP_MAX);
    expect(fdiv(-1, 0)).toBe(FP_MIN);
    expect(fdiv(-FP_ONE, 0)).toBe(FP_MIN);
    expect(fdiv(FP_MIN, 0)).toBe(FP_MIN);
  });
});

describe("fixed: conversions", () => {
  it("fromInt saturates at the ends of the whole-number range", () => {
    expect(fromInt(0)).toBe(0);
    expect(fromInt(1)).toBe(FP_ONE);
    expect(fromInt(-1)).toBe(-FP_ONE);
    expect(fromInt(32767)).toBe(32767 * 65536);
    expect(fromInt(-32768)).toBe(FP_MIN);
    expect(fromInt(32768)).toBe(FP_MAX);
    expect(fromInt(-32769)).toBe(FP_MIN);
    expect(fromInt(1e9)).toBe(FP_MAX);
    expect(fromInt(-1e9)).toBe(FP_MIN);
  });

  it("fromInt / toInt round-trip over the representable whole numbers", () => {
    for (let n = -32768; n <= 32767; n++) {
      expect(toInt(fromInt(n))).toBe(n);
    }
  });

  it("fromFloat and toFloat agree on exact binary fractions", () => {
    expect(fromFloat(0)).toBe(0);
    expect(fromFloat(1)).toBe(FP_ONE);
    expect(fromFloat(-1)).toBe(-FP_ONE);
    expect(fromFloat(0.5)).toBe(FP_ONE / 2);
    expect(fromFloat(-0.5)).toBe(-FP_ONE / 2);
    expect(fromFloat(1e9)).toBe(FP_MAX);
    expect(fromFloat(-1e9)).toBe(FP_MIN);
    expect(toFloat(FP_ONE)).toBe(1);
    expect(toFloat(-FP_ONE)).toBe(-1);
    expect(toFloat(FP_ONE / 2)).toBe(0.5);
    expect(toFloat(0)).toBe(0);
  });

  /**
   * `fromFloat` ROUNDS while `fmul`/`fdiv` FLOOR, and the difference is
   * deliberate. The arithmetic floors because that is what an arithmetic shift
   * does and rounding would put a branch on the hottest path in the machine.
   * This function answers a different question -- which representable value did
   * a person mean when they typed `0.94` into a recipe -- and the answer is the
   * nearest one.
   *
   * Found the hard way: the stamper converted knobs with `fromFloat` while an
   * engine's own test built its preamble with `Math.round`, so three knobs
   * differed by one ULP and the engine suite passed while testing a cart the
   * stamper did not produce. One conversion, written down, or two that drift.
   */
  it("fromFloat rounds to nearest rather than flooring", () => {
    // The knobs that exposed the divergence. Flooring puts every one of them
    // one ULP below what the recipe asked for.
    expect(fromFloat(0.94)).toBe(61604); // 61603.84 -> nearest, not 61603
    expect(fromFloat(0.35)).toBe(22938); // 22937.60
    expect(fromFloat(0.38)).toBe(24904); // 24903.68
    expect(fromFloat(0.42)).toBe(27525); // 27525.12, below the halfway point
    expect(fromFloat(-3.1)).toBe(-203162); // -203161.6

    // Never further than half a ULP from the true value, which is the whole
    // property being claimed. Flooring fails this for most inputs.
    for (let i = 0; i < 2000; i++) {
      const v = (i - 1000) / 997; // a spread of values with long expansions
      expect(Math.abs(fromFloat(v) - v * 65536)).toBeLessThanOrEqual(0.5);
    }
  });

  it("breaks ties toward positive infinity, and says so", () => {
    // One input in 65536 lands exactly halfway. The rule is written down so a
    // second implementation does not have to guess, and pinned so this one
    // cannot drift away from what is written.
    expect(fromFloat(0.5 / 65536)).toBe(1); // +0.5 ULP -> up
    expect(fromFloat(-0.5 / 65536)).toBe(0); // -0.5 ULP -> toward +inf, i.e. 0
    expect(fromFloat(1.5 / 65536)).toBe(2);
    expect(fromFloat(-1.5 / 65536)).toBe(-1);
  });
});
