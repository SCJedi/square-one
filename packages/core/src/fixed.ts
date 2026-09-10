/**
 * Signed 16.16 fixed point, held in a JavaScript number that is always an
 * exact int32. 1.0 is FP_ONE (65536).
 *
 * Two rules hold everywhere in this module, and every game replay depends on
 * both of them:
 *
 *   ROUNDING IS FLOOR. Never truncate-toward-zero. fmul(-1, 1) is -1, not 0.
 *     Floor is what an arithmetic right shift does in two's complement, so
 *     the shift and the mathematical definition agree for free.
 *
 *   OVERFLOW SATURATES. Never wraps. A value that leaves [FP_MIN, FP_MAX]
 *     clamps to the nearest endpoint. Wrapping would turn a big positive
 *     velocity into a big negative one and desynchronise a replay silently;
 *     saturation at least stays monotone.
 */

export const FP_SHIFT = 16 as const;

/** 1.0 in 16.16. */
export const FP_ONE = 65536 as const;

/** Most negative int32, -2^31. */
export const FP_MIN = -2147483648 as const;

/** Most positive int32, 2^31 - 1. */
export const FP_MAX = 2147483647 as const;

/**
 * Clamp an exact integer-valued double to the int32 range.
 *
 * `r` MUST already be an integer (or a non-finite value). The final `| 0`
 * only re-tags an in-range value as int32; it is not a rounding step, and
 * handing this function a fractional value would truncate toward zero and
 * break the floor rule. Every caller in this file floors before it saturates.
 *
 * +-Infinity clamp to the endpoints. NaN falls through to `NaN | 0` === 0.
 */
export function sat(r: number): number {
  if (r >= FP_MAX) return FP_MAX;
  if (r <= FP_MIN) return FP_MIN;
  return r | 0;
}

/**
 * Fixed multiply: floor(a * b / 65536), saturated.
 *
 * The naive `(a * b) >> 16` is wrong in JavaScript. Two int32 operands make a
 * product up to 2^62, and doubles stop being exact integers at 2^53, so the
 * product is already rounded before the shift ever runs.
 *
 * The 16-bit split below keeps every intermediate exact. Write
 *
 *     a = ah * 2^16 + al      ah = a >> 16   in [-2^15, 2^15)
 *                             al = a & 0xffff in [0, 2^16)
 *
 * (that decomposition is exact for negative `a` too: `>>` is an arithmetic
 * shift, i.e. floor(a / 2^16), and `& 0xffff` is the matching non-negative
 * remainder). Then
 *
 *     a * b / 2^16 = ah*bh * 2^16  +  (ah*bl + al*bh)  +  al*bl / 2^16
 *
 * The first two terms are exact integers, so the floor of the whole is the
 * sum of those two plus floor(al*bl / 2^16) -- which is what `lo` computes.
 *
 * Magnitudes, all far below 2^53:
 *   hi  = ah*bh            <= 2^30
 *   mid = ah*bl + al*bh    <  2^32   (each product < 2^31)
 *   lo  = al*bl >>> 16     <  2^16
 *   hi*65536 + mid + lo    <  2^47
 *
 * `lo` uses `>>> 16` rather than `/ 65536`. al*bl is at most
 * 65535 * 65535 = 4294836225, which is below 2^32, so ToUint32 leaves it
 * alone and the logical shift is an exact floor. That headroom is only
 * 131071 wide -- do not widen the split without redoing this argument.
 */
export function fmul(a: number, b: number): number {
  const ah = a >> 16;
  const al = a & 0xffff;
  const bh = b >> 16;
  const bl = b & 0xffff;
  const hi = ah * bh;
  const mid = ah * bl + al * bh;
  const lo = (al * bl) >>> 16;
  return sat(hi * 65536 + mid + lo);
}

/**
 * Fixed divide: floor(a * 65536 / b), saturated. Division by zero is defined,
 * not a trap: it saturates by the sign of the numerator.
 *
 * Why `Math.floor((a * 65536) / b)` is exact, given |a| <= 2^31 and b an int32:
 *
 *   N = a * 65536 has |N| <= 2^47, so N itself is an exact double.
 *   The true quotient is q = N / b, with |q| <= 2^47 / |b|.
 *   IEEE division returns the double nearest q, so the absolute error is at
 *   most half an ulp, i.e. <= |q| * 2^-53 <= 2^-6 / |b|.
 *
 *   If q is an integer it is exactly representable (|q| <= 2^47) and the
 *   division returns it exactly, so the floor is right.
 *
 *   If q is not an integer, its fractional part is a nonzero multiple of
 *   1 / |b|, so q sits at least 1/|b| away from BOTH neighbouring integers.
 *   The error 2^-6 / |b| is 64x smaller than that gap, so the rounded value
 *   cannot cross an integer boundary and the floor is again right.
 *
 * The margin is a factor of 64, not a hair, but it does depend on |a| <= 2^31.
 */
export function fdiv(a: number, b: number): number {
  if (b === 0) return a >= 0 ? FP_MAX : FP_MIN;
  return sat(Math.floor((a * 65536) / b));
}

/**
 * Integer -> 16.16, saturating. fromInt(32768) saturates to FP_MAX because
 * 32768.0 is one step past the top of the format.
 *
 * A fractional argument is floored first, so the floor rule holds here too.
 */
export function fromInt(n: number): number {
  return sat(Math.floor(n) * 65536);
}

/** 16.16 -> integer, flooring. -1 (i.e. -0.0000152) becomes -1, not 0. */
export function toInt(a: number): number {
  return a >> 16;
}

/**
 * Float -> 16.16, rounding to nearest and saturating.
 *
 * BUILD-TIME AND TOOLING ONLY. Never call this from console or cart code:
 * it drags a double into the deterministic path, and doubles are exactly the
 * thing this format exists to avoid. Table generators, recipe compilers and
 * test fixtures may use it; the runtime may not.
 *
 * WHY THIS ROUNDS WHEN THE ARITHMETIC FLOORS
 * ------------------------------------------
 * `fmul` and `fdiv` floor, because floor is what an arithmetic shift does and
 * making them round would put a branch on the hottest path in the machine. That
 * rule is about ARITHMETIC, where the input is already fixed point and the only
 * question is what to do with bits falling off the end.
 *
 * This function answers a different question: which representable value did a
 * person mean when they wrote `0.94` in a recipe? The nearest one. Flooring here
 * biases every hand-written number in the same direction -- 0.94 became 61603
 * where 61604 is nearer -- and a designer who types a number and gets back
 * something measurably below it has been quietly lied to.
 *
 * Ties go toward positive infinity (`Math.round`'s rule), which matters for
 * exactly one input in 65536 and is written down here so a second implementation
 * does not have to guess.
 */
export function fromFloat(f: number): number {
  return sat(Math.round(f * 65536));
}

/**
 * 16.16 -> float.
 *
 * DEBUG AND DISPLAY ONLY. The result is a double and must never flow back
 * into a computation whose output is observable by a replay.
 */
export function toFloat(a: number): number {
  return a / 65536;
}
