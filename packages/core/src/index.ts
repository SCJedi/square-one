// @sq1/core - the primitives every other package is built on.
//
// Zero runtime dependencies, and no file or network I/O anywhere in this
// package: it runs inside a scrubbed Worker realm where `fetch`, `Math` and
// the module loader's usual conveniences do not exist.
//
// Everything here is normative. If two implementations of Square One disagree
// about any value produced below, they disagree about what a game does, and
// every replay recorded on one of them is wrong on the other.

// --- Signed 16.16 fixed point ----------------------------------------------
// Rounding is floor (arithmetic shift), never truncate-toward-zero.
// Overflow saturates, never wraps.
export {
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
} from "./fixed";

// --- xoshiro128** ----------------------------------------------------------
// The machine's only source of entropy. State is four 32-bit words, living at
// address 0x2100 and travelling inside every snapshot.
export {
  rngCreate,
  rngNext,
  rnd,
  rndf,
  rngSave,
  rngLoad,
} from "./prng";

// --- Trigonometry ----------------------------------------------------------
// 1024 steps per turn, read from a committed table. Never computed at runtime:
// Math.sin is not specified to bit precision, so a formula would let engines
// disagree in the last unit in the last place and desync replays.
export { SIN_STEPS, SIN_TABLE, fsin, fcos } from "./sin";

// --- The normative token counter -------------------------------------------
// Defines the 8192-token cart budget. Every token counts as one.
export { tokenize, countTokens, TokenizeError } from "./tokenize";
export type { Token, TokenType, TokenizeResult } from "./tokenize";

// --- SHA-256 ---------------------------------------------------------------
// The measuring instrument for the determinism claim, and later the cart id.
// Pure 32-bit JavaScript with no platform branch, because a hash that took a
// different code path on Node and in a browser could not tell "the machine
// diverged" from "the hash diverged".
export { sha256, sha256Hex, toHex, fromHex, SHA256_BYTES } from "./sha256";
