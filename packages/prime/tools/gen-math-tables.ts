/**
 * Generator for the normative constants in packages/prime/src/math.ts.
 *
 * Run:  npx vite-node packages/prime/tools/gen-math-tables.ts
 *
 * It prints a TypeScript block. The block is pasted into `math.ts` between the
 * BEGIN/END GENERATED markers and committed, exactly as the small console
 * commits `sin-table.ts`. Nothing here runs at simulation time.
 *
 * WHY EVERY NUMBER BELOW IS COMPUTED IN BigInt
 * --------------------------------------------
 * ECMAScript does not specify `Math.sin`, `Math.atan`, `Math.PI`-derived
 * expressions or `**` to the last bit: the spec calls them
 * implementation-approximated, and V8 and SpiderMonkey genuinely differ in the
 * final ulp. A constant produced by one of them would make "regenerating the
 * table is byte-identical" a claim that happens to hold on one machine. So pi
 * is derived from Machin's formula in exact BigInt fixed point, and every
 * coefficient is the correctly-rounded double nearest an exact rational.
 *
 * `Math.sin` appears nowhere in this file, not even as a cross-check; the
 * cross-check lives in test/math.test.ts, where a disagreement is a test
 * failure rather than a silently-blessed constant.
 *
 * WHY THE LITERALS ARE PRINTED WITH String(d)
 * -------------------------------------------
 * A decimal numeric literal with MORE THAN 20 significant digits may be rounded
 * either of two ways by a conforming implementation (ECMAScript, Static
 * Semantics: MV of NumericLiteral). That is a real determinism hazard hiding in
 * plain sight: a 30-digit "exact" decimal for a double is NOT guaranteed to
 * parse back to that double on every engine. `Number.prototype.toString` is
 * exactly specified and yields the shortest decimal that round-trips, which is
 * at most 17 significant digits -- comfortably inside the 20-digit window where
 * rounding IS mandated. Every literal printed here is checked to round-trip and
 * to carry at most 20 significant digits before it is emitted.
 */

/** Working precision. Everything is an integer representing value * 2^P. */
const P = 1600n;
const S = 1n << P;

/** 24-bit limbs of 2/pi to commit. 56 covers every finite f64 argument; see math.ts. */
const TWO_OVER_PI_LIMBS = 56;

/** Breakpoints for atan: atan(k/32) for k in [0, 32]. */
const ATAN_STEPS = 32;

// --- exact helpers ---------------------------------------------------------

const DV = new DataView(new ArrayBuffer(8));

function f64FromBits(bits: bigint): number {
  DV.setBigUint64(0, bits);
  return DV.getFloat64(0);
}

function bitsOfF64(d: number): bigint {
  DV.setFloat64(0, d);
  return DV.getBigUint64(0);
}

function bitLength(v: bigint): bigint {
  return BigInt(v.toString(2).length);
}

/** Integer square root, Newton. Exact: returns floor(sqrt(n)). */
function isqrt(n: bigint): bigint {
  if (n < 0n) throw new Error("isqrt: negative");
  if (n < 2n) return n;
  let x = 1n << ((bitLength(n) + 1n) >> 1n);
  for (;;) {
    const y = (x + n / x) >> 1n;
    if (y >= x) return x;
    x = y;
  }
}

/**
 * The double nearest v/2^P, ties to even. Throws rather than returning a
 * subnormal or an infinity: every constant this file emits is comfortably
 * normal, and a silent underflow would be a wrong constant.
 */
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
  if (be <= 0n) throw new Error(`roundToDouble: underflows to subnormal (be=${be})`);
  if (be >= 2047n) throw new Error(`roundToDouble: overflows (be=${be})`);
  const bits = (neg ? 1n << 63n : 0n) | (be << 52n) | (q - (1n << 52n));
  return f64FromBits(bits);
}

/** The EXACT value of a double, as an integer representing value * 2^P. */
function exactFixed(d: number): bigint {
  if (d === 0) return 0n;
  if (!Number.isFinite(d)) throw new Error("exactFixed: not finite");
  const bits = bitsOfF64(d);
  const neg = bits >> 63n === 1n;
  const be = (bits >> 52n) & 0x7ffn;
  const frac = bits & ((1n << 52n) - 1n);
  const m = be === 0n ? frac : frac | (1n << 52n);
  const e = be === 0n ? -1074n : be - 1075n;
  // e + P >= -1074 + 1600 > 0, so this is a left shift and therefore exact.
  const v = m << (e + P);
  return neg ? -v : v;
}

/** Split an exact value into `n` doubles whose sum reproduces it to ~53n bits. */
function splitDoubles(v: bigint, n: number): number[] {
  const out: number[] = [];
  let rest = v;
  for (let i = 0; i < n; i++) {
    const d = roundToDouble(rest);
    out.push(d);
    rest -= exactFixed(d);
  }
  return out;
}

// --- pi, from Machin's formula ---------------------------------------------

/** round(atan(1/x) * 2^P) by the alternating series, integer x >= 2. */
function atanInvInt(x: bigint): bigint {
  const x2 = x * x;
  let pow = x; // x^(2k+1)
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

/** pi/4 = 4*atan(1/5) - atan(1/239). Checkable in two lines; no magic digits. */
const PI = 16n * atanInvInt(5n) - 4n * atanInvInt(239n);
const PIO2 = PI / 2n;

// --- atan of a rational, to full working precision --------------------------

/**
 * atan(num/den) * 2^P, for 0 <= num/den <= 1.
 *
 * The Taylor series for atan converges like z^2 per term, which is useless at
 * z = 1. So the half-angle identity
 *
 *     atan(z) = 2 * atan( z / (1 + sqrt(1 + z^2)) )
 *
 * is applied six times first, which drives any z <= 1 below 2^-5, and the
 * series then needs about 160 terms for 1600 bits.
 */
function atanRational(num: bigint, den: bigint): bigint {
  let z = (num * S) / den;
  const HALVINGS = 6;
  for (let i = 0; i < HALVINGS; i++) {
    const one_plus_z2 = S + (z * z) / S;
    const root = isqrt(one_plus_z2 * S);
    z = (z * S) / (S + root);
  }
  // series
  const zz = (z * z) / S;
  let term = z;
  let acc = z;
  let k = 1n;
  for (;;) {
    term = (term * zz) / S;
    const t = term / (2n * k + 1n);
    if (t === 0n) break;
    acc += k % 2n === 0n ? t : -t;
    k += 1n;
  }
  return acc << BigInt(HALVINGS);
}

// --- coefficient rationals --------------------------------------------------

function factorial(n: number): bigint {
  let f = 1n;
  for (let i = 2; i <= n; i++) f *= BigInt(i);
  return f;
}

/** The double nearest sign * num/den. */
function ratioToDouble(sign: number, num: bigint, den: bigint): number {
  const v = (num * S) / den;
  return roundToDouble(sign < 0 ? -v : v);
}

// --- emission ---------------------------------------------------------------

function lit(d: number): string {
  const s = String(d);
  if (Number(s) !== d) throw new Error(`literal ${s} does not round-trip`);
  const digits = s.replace(/[-+.]/g, "").replace(/e.*$/i, "").replace(/^0+/, "");
  if (digits.length > 20) {
    throw new Error(`literal ${s} has ${digits.length} significant digits; >20 is engine-dependent`);
  }
  return s;
}

const out: string[] = [];
const w = (s = ""): void => {
  out.push(s);
};

w("// --- BEGIN GENERATED: packages/prime/tools/gen-math-tables.ts ---------------");
w("// Do not hand-edit. test/math.test.ts recomputes every number below in BigInt");
w("// and fails if one of them moves by a single unit in the last place.");
w();

// 2/pi limbs.
const TWO_OVER_PI = (2n * S * S) / PI; // (2/pi) * 2^P, an integer below 2^P
const limbs: number[] = [];
for (let j = 0; j < TWO_OVER_PI_LIMBS; j++) {
  const sh = P - 24n * BigInt(j + 1);
  if (sh < 0n) throw new Error("working precision too small for the 2/pi table");
  limbs.push(Number((TWO_OVER_PI >> sh) & 0xffffffn));
}
w("/**");
w(" * The first 1344 fraction bits of 2/pi, in 24-bit limbs, most significant first:");
w(" *");
w(" *     2/pi = sum_j TWO_OVER_PI[j] * 2^(-24*(j+1))");
w(" *");
w(" * 24 bits per limb because a limb times a 24-bit slice of the mantissa is below");
w(" * 2^48 and therefore an EXACT f64 product -- the whole Payne-Hanek reduction is");
w(" * integer arithmetic carried in doubles, with no BigInt and no rounding.");
w(" */");
w(`export const TWO_OVER_PI: readonly number[] = [`);
for (let i = 0; i < limbs.length; i += 8) {
  w("  " + limbs.slice(i, i + 8).map((x) => String(x)).join(", ") + ",");
}
w("];");
w();

// pi/2 as a three-double expansion, pi as two.
const pio2Parts = splitDoubles(PIO2, 3);
const piParts = splitDoubles(PI, 2);
const pio4Parts = splitDoubles(PI / 4n, 2);
w("/** pi/2 as an exact three-double expansion: PIO2_H + PIO2_M + PIO2_L, ~159 bits. */");
w(`export const PIO2_H = ${lit(pio2Parts[0]!)};`);
w(`export const PIO2_M = ${lit(pio2Parts[1]!)};`);
w(`export const PIO2_L = ${lit(pio2Parts[2]!)};`);
w();
w("/** pi and pi/4 as double-doubles, for assembling atan2 quadrants without cancellation. */");
w(`export const PI_H = ${lit(piParts[0]!)};`);
w(`export const PI_L = ${lit(piParts[1]!)};`);
w(`export const PIO4_H = ${lit(pio4Parts[0]!)};`);
w(`export const PIO4_L = ${lit(pio4Parts[1]!)};`);
w();
w("/** 3*pi/4, correctly rounded. atan2(+-inf, -inf) is exactly this and nothing else. */");
w(`export const PI3O4 = ${lit(roundToDouble((3n * PI) / 4n))};`);
w();

// sin coefficients: S_k = (-1)^k / (2k+1)!, k = 1..8  (x^3 .. x^17)
w("/** sin(x) = x + x^3*(S1 + z*(S2 + ...)), z = x*x. S_k = (-1)^k / (2k+1)!. */");
for (let k = 1; k <= 8; k++) {
  const sign = k % 2 === 0 ? 1 : -1;
  const d = ratioToDouble(sign, 1n, factorial(2 * k + 1));
  w(`export const S${k} = ${lit(d)};`);
}
w();

// cos coefficients: C_k = (-1)^(k+1) / (2k+2)!, k = 1..8  (x^4 .. x^18)
w("/** cos(x) = 1 - z/2 + z^2*(C1 + z*(C2 + ...)), z = x*x. C_k = (-1)^(k+1) / (2k+2)!. */");
for (let k = 1; k <= 8; k++) {
  const sign = k % 2 === 1 ? 1 : -1;
  const d = ratioToDouble(sign, 1n, factorial(2 * k + 2));
  w(`export const C${k} = ${lit(d)};`);
}
w();

// atan coefficients: A_k = (-1)^k / (2k+1), k = 1..6  (u^3 .. u^13)
w("/** atan(u) = u + u^3*(A1 + z*(A2 + ...)), z = u*u, |u| <= 1/64. A_k = (-1)^k/(2k+1). */");
for (let k = 1; k <= 6; k++) {
  const sign = k % 2 === 0 ? 1 : -1;
  const d = ratioToDouble(sign, 1n, BigInt(2 * k + 1));
  w(`export const A${k} = ${lit(d)};`);
}
w();

// atan breakpoints.
const hiT: number[] = [];
const loT: number[] = [];
for (let k = 0; k <= ATAN_STEPS; k++) {
  const v = k === 0 ? 0n : atanRational(BigInt(k), BigInt(ATAN_STEPS));
  const parts = k === 0 ? [0, 0] : splitDoubles(v, 2);
  hiT.push(parts[0]!);
  loT.push(parts[1]!);
}
w("/**");
w(" * atan(k/32) for k in [0, 32], as a double-double: ATAN_HI[k] + ATAN_LO[k].");
w(" *");
w(" * The breakpoints are what keep the atan polynomial short. Reducing an argument");
w(" * t in [0,1] to u = (t - k/32)/(1 + t*k/32) leaves |u| <= 1/64, where a degree-13");
w(" * Taylor series is already far below one ulp -- and Taylor coefficients are exact");
w(" * rationals, so no Remez implementation has to be trusted.");
w(" */");
w(`export const ATAN_HI: readonly number[] = [`);
for (let i = 0; i <= ATAN_STEPS; i += 4) {
  w("  " + hiT.slice(i, i + 4).map(lit).join(", ") + ",");
}
w("];");
w(`export const ATAN_LO: readonly number[] = [`);
for (let i = 0; i <= ATAN_STEPS; i += 4) {
  w("  " + loT.slice(i, i + 4).map(lit).join(", ") + ",");
}
w("];");
w();
w("// --- END GENERATED ----------------------------------------------------------");

console.log(out.join("\n"));
