/**
 * Generator for the console's sine table.
 *
 * Run:  node --experimental-strip-types packages/core/tools/gen-sin.ts [outRoot]
 * or:   npm run gen:sin
 *
 * outRoot defaults to the project root. The test suite passes a temporary
 * directory instead so it can regenerate and diff without touching the
 * committed fixture.
 *
 * WHY THIS DOES NOT USE Math.sin
 * ------------------------------
 * ECMAScript does not specify Math.sin to the last bit. The spec permits an
 * implementation-approximated result, and V8 and SpiderMonkey genuinely differ
 * in the final ulp for some arguments. If this table were generated from
 * Math.sin, regenerating it on a different engine could produce a different
 * table, and "regeneration is byte-identical" -- a property the conformance
 * suite asserts -- would be a lie that happens to hold on one machine.
 *
 * So every number below is computed in exact BigInt fixed-point arithmetic,
 * which is bit-identical on every engine that implements BigInt at all.
 * Math.sin appears exactly once, at the end, as a CROSS-CHECK that fails
 * loudly. It is never the source of a value.
 *
 * WHERE PI COMES FROM
 * -------------------
 * Not from Math.PI, which carries only 53 bits. Pi is computed here from
 * Machin's formula
 *
 *     pi/4 = 4*arctan(1/5) - arctan(1/239)
 *
 * with each arctan evaluated by its alternating series
 *
 *     arctan(1/x) = sum_{k>=0} (-1)^k / ((2k+1) * x^(2k+1))
 *
 * in BigInt fixed point. Deriving pi rather than embedding a magic constant
 * means there is no digit string anyone has to take on trust: the identity is
 * checkable and the series is a dozen lines.
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Angles per full turn. */
const STEPS = 1024;

/**
 * Working precision: everything below is an integer representing
 * value * 2^GUARD. 192 guard bits against a 16-bit answer is wildly more than
 * needed -- the accumulated truncation error is a few hundred units at 2^-192,
 * i.e. under 2^-180 -- but BigInt is cheap at this size and the whole point of
 * the exercise is to leave no room for doubt about the last bit.
 */
const GUARD = 192n;
const S = 1n << GUARD;
const HALF = S >> 1n;

/**
 * round(arctan(1/x) * S) for integer x >= 2.
 *
 * `term` holds 1/x^(2k+1) scaled by S. Each step divides by x^2, so it shrinks
 * by at least 4x per term and the loop ends when it underflows to zero. Every
 * division truncates toward zero (term is positive, so truncation is floor),
 * losing under one unit per operation; with fewer than 100 terms the total
 * error is under 200 units at 2^-192.
 */
function arctanInv(x: bigint): bigint {
  const x2 = x * x;
  let term = S / x;
  let sum = 0n;
  let k = 0n;
  while (term !== 0n) {
    const t = term / (2n * k + 1n);
    sum += k % 2n === 0n ? t : -t;
    term = term / x2;
    k += 1n;
  }
  return sum;
}

/** round(pi * S), via Machin's formula. */
function computePi(): bigint {
  return 4n * (4n * arctanInv(5n) - arctanInv(239n));
}

const PI = computePi();

/**
 * round(sin(x) * S) for x scaled by S, with 0 <= x <= pi/2.
 *
 * Maclaurin series: sin x = x - x^3/3! + x^5/5! - ...
 *
 * `num` carries the magnitude x^(2k+1)/(2k+1)!, always positive, with the sign
 * applied separately. Because x <= pi/2 < 1.5708, the ratio between successive
 * magnitudes is x^2 / ((2k)(2k+1)) <= 2.4675/6 < 1 from the very first step, so
 * the terms decrease monotonically and the alternating series is bounded by its
 * first omitted term. Roughly 40 terms drive it to zero at this precision.
 *
 * Restricting the argument to a quarter wave is what keeps this short: over
 * the full turn the series would need hundreds of terms and lose far more to
 * cancellation.
 */
function sinFixed(x: bigint): bigint {
  let num = x;
  let sum = x;
  let sign = -1n;
  for (let k = 1n; ; k += 1n) {
    // num <- num * x^2 / S^2, in two steps so no intermediate exceeds ~S^2.
    num = (num * x) / S;
    num = (num * x) / S;
    num = num / (2n * k * (2n * k + 1n));
    if (num === 0n) break;
    sum += sign * num;
    sign = -sign;
  }
  return sum;
}

/**
 * Round a non-negative S-scaled magnitude to 16.16, half away from zero.
 *
 * Applying the sign afterwards (rather than rounding a signed value) is what
 * makes the table exactly antisymmetric: entry i and entry 1024-i are the same
 * magnitude with opposite signs, by construction and not by luck. fsin(-a) ===
 * -fsin(a) depends on it.
 */
function toFixed1616(mag: bigint): number {
  return Number((mag * 65536n + HALF) / S);
}

/**
 * Build the 1024-entry table.
 *
 * Only the first quarter wave is ever computed: magnitudes for j in [0, 256],
 * i.e. angles 0 to pi/2. Everything else is that quarter reflected, using
 *
 *   i in [0, 256]      sin = +m[i]
 *   i in (256, 512]    sin = +m[512 - i]     (mirror about pi/2)
 *   i in (512, 768]    sin = -m[i - 512]     (odd about pi)
 *   i in (768, 1024)   sin = -m[1024 - i]    (mirror about 3pi/2)
 */
function buildTable(): Int32Array {
  const quarter = new Array<number>(257);
  for (let j = 0; j <= 256; j++) {
    // angle = 2*pi*j/1024 = pi*j/512
    const x = (PI * BigInt(j)) / 512n;
    quarter[j] = toFixed1616(sinFixed(x));
  }

  const table = new Int32Array(STEPS);
  for (let i = 0; i < STEPS; i++) {
    let v: number;
    if (i <= 256) v = quarter[i] as number;
    else if (i <= 512) v = quarter[512 - i] as number;
    else if (i <= 768) v = -(quarter[i - 512] as number);
    else v = -(quarter[1024 - i] as number);
    table[i] = v;
  }
  return table;
}

/**
 * Checks that must hold before anything is written. Every one of these is a
 * property of sine that a broken series would violate, so a silent numerical
 * failure cannot reach the fixture.
 */
function validate(table: Int32Array): void {
  const fail = (msg: string): never => {
    throw new Error(`gen-sin: ${msg}`);
  };

  // Pi, sanity-checked against the double we refuse to derive it from.
  const piAsDouble = Number((PI * 100000000n) / S) / 1e8;
  if (Math.abs(piAsDouble - Math.PI) > 1e-7) {
    fail(`computed pi = ${piAsDouble} disagrees with Math.PI`);
  }

  // The cardinal angles must be exact.
  if (table[0] !== 0) fail(`sin(0) = ${table[0]}, expected 0`);
  if (table[256] !== 65536) fail(`sin(pi/2) = ${table[256]}, expected 65536`);
  if (table[512] !== 0) fail(`sin(pi) = ${table[512]}, expected 0`);
  if (table[768] !== -65536) fail(`sin(3pi/2) = ${table[768]}, expected -65536`);

  for (let i = 0; i < STEPS; i++) {
    const v = table[i] as number;
    if (!Number.isInteger(v)) fail(`entry ${i} = ${v} is not an integer`);
    if (v < -65536 || v > 65536) fail(`entry ${i} = ${v} is outside [-65536, 65536]`);
  }

  // Exact antisymmetry about the origin and about pi/2.
  for (let a = 1; a < STEPS; a++) {
    if (table[STEPS - a] !== -(table[a] as number)) {
      fail(`entry ${STEPS - a} (${table[STEPS - a]}) is not the negation of entry ${a} (${table[a]})`);
    }
  }
  for (let a = 0; a <= 256; a++) {
    if (table[512 - a] !== table[a]) {
      fail(`entry ${512 - a} is not the mirror of entry ${a}`);
    }
  }

  // CROSS-CHECK ONLY. Math.sin is the suspect being compared against, never
  // the source. A disagreement of more than 2 units in 16.16 means the BigInt
  // series is wrong, because Math.sin is good to far better than that.
  let worst = 0;
  let worstAt = -1;
  for (let i = 0; i < STEPS; i++) {
    const ref = Math.sin((2 * Math.PI * i) / STEPS) * 65536;
    const d = Math.abs((table[i] as number) - ref);
    if (d > worst) {
      worst = d;
      worstAt = i;
    }
  }
  if (worst > 2) {
    fail(
      `entry ${worstAt} differs from Math.sin by ${worst} units (limit 2). ` +
        `The BigInt series is wrong -- do NOT relax this check.`,
    );
  }
  process.stdout.write(`gen-sin: max deviation from Math.sin = ${worst.toFixed(6)} units\n`);
}

/** 1024 little-endian int32 = 4096 bytes. This file is the normative artifact. */
function toBytes(table: Int32Array): Uint8Array {
  const bytes = new Uint8Array(table.length * 4);
  for (let i = 0; i < table.length; i++) {
    const v = table[i] as number;
    bytes[i * 4 + 0] = v & 0xff;
    bytes[i * 4 + 1] = (v >>> 8) & 0xff;
    bytes[i * 4 + 2] = (v >>> 16) & 0xff;
    bytes[i * 4 + 3] = (v >>> 24) & 0xff;
  }
  return bytes;
}

const HEADER = `// GENERATED FILE -- DO NOT EDIT BY HAND.
//
// Produced by packages/core/tools/gen-sin.ts. Regenerate with:
//     npm run gen:sin
//
// The normative copy of these values is conformance/fixtures/sin1024.bin; this
// module exists only because packages/core does zero file I/O (it has to run in
// a browser worker). test/sin.test.ts asserts the two agree, and that
// regenerating reproduces both byte for byte.
//
// 1024 entries of 16.16 fixed point: sin(2*pi*i/1024) * 65536, rounded half
// away from zero. Stored as base64 of 1024 little-endian int32.
`;

function emitModule(bytes: Uint8Array): string {
  const b64 = Buffer.from(bytes).toString("base64");
  // Wrap so the generated file is diffable rather than one 5.4 KB line.
  const lines: string[] = [];
  for (let i = 0; i < b64.length; i += 76) lines.push(`  "${b64.slice(i, i + 76)}" +`);
  const last = lines.pop() as string;
  lines.push(last.slice(0, -2));

  return `${HEADER}
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

const PACKED =
${lines.join("\n")};

/**
 * Decode base64 to int32 without atob or Buffer, so this module depends on
 * nothing but the language itself and loads identically in a worker, in Node
 * and in a test runner.
 */
function unpack(s: string): Int32Array {
  const lut = new Uint8Array(128);
  for (let i = 0; i < B64.length; i++) lut[B64.charCodeAt(i)] = i;

  let len = s.length;
  while (len > 0 && s.charCodeAt(len - 1) === 61 /* '=' */) len--;

  const byteLen = (len * 3) >> 2;
  const bytes = new Uint8Array(byteLen);
  let acc = 0;
  let bits = 0;
  let o = 0;
  for (let i = 0; i < len; i++) {
    acc = (acc << 6) | (lut[s.charCodeAt(i)] as number);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[o++] = (acc >>> bits) & 0xff;
    }
  }

  const out = new Int32Array(byteLen >> 2);
  for (let i = 0; i < out.length; i++) {
    const b0 = bytes[i * 4 + 0] as number;
    const b1 = bytes[i * 4 + 1] as number;
    const b2 = bytes[i * 4 + 2] as number;
    const b3 = bytes[i * 4 + 3] as number;
    // \`|\` yields an int32, so the high byte lands as the sign bit.
    out[i] = b0 | (b1 << 8) | (b2 << 16) | (b3 << 24);
  }
  return out;
}

/** sin(2*pi*i/1024) in 16.16, for i in [0, 1024). */
export const SIN_TABLE_DATA: Int32Array = unpack(PACKED);
`;
}

function main(): void {
  const here = dirname(fileURLToPath(import.meta.url)); // packages/core/tools
  const projectRoot = join(here, "..", "..", "..");
  const outRoot = process.argv[2] ?? projectRoot;

  const table = buildTable();
  validate(table);
  const bytes = toBytes(table);

  const binPath = join(outRoot, "conformance", "fixtures", "sin1024.bin");
  const tsPath = join(outRoot, "packages", "core", "src", "sin-table.ts");

  mkdirSync(dirname(binPath), { recursive: true });
  mkdirSync(dirname(tsPath), { recursive: true });

  writeFileSync(binPath, bytes);
  // Explicit LF: the byte-identical regeneration test compares raw bytes, and
  // a platform-dependent line ending would make that test platform-dependent.
  writeFileSync(tsPath, emitModule(bytes), { encoding: "utf8" });

  process.stdout.write(`gen-sin: wrote ${binPath} (${bytes.length} bytes)\n`);
  process.stdout.write(`gen-sin: wrote ${tsPath}\n`);
}

main();
