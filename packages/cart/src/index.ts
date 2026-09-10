// @sq1/cart -- the cart container: chunk codec, canonical serialization, cart id.
//
// A cart is a file that arrives from a stranger on the internet. `decode` in
// codec.ts is the one place in Square One where hostile bytes meet parsing
// code, and it is written to a single rule: it NEVER throws. Every failure
// leaves as a typed `CartError`, and a 10,000-iteration fuzzer holds that down.
//
// Zero runtime dependencies beyond @sq1/core, and nothing here touches the file
// system, the network, `Buffer`, `process` or any `node:` module -- the same
// code runs in a browser, in a Worker, and in the CLI.

// --- the format's vocabulary ----------------------------------------------
export {
  MAGIC,
  HEADER_BYTES,
  DIRECTORY_ENTRY_BYTES,
  SPEC_MAJOR,
  SPEC_MINOR,
  MAX_CART_BYTES,
  CRITICAL_CHUNKS,
  ANCILLARY_CHUNKS,
  REQUIRED_CHUNKS,
  CANONICAL_ORDER,
  SIGN_CHUNK,
  isCritical,
  isValidChunkType,
  isKnown,
  paddedLength,
} from "./chunks";
export type { Chunk } from "./chunks";

// --- typed failures --------------------------------------------------------
export { cartError, hexOffset, CART_ERROR_CODES } from "./errors";
export type { CartError, CartErrorCode } from "./errors";

// --- the codec -------------------------------------------------------------
export { encode, decode, canonicalize, getChunk } from "./codec";
export type { CartFile, DecodeResult } from "./codec";

// --- the META chunk --------------------------------------------------------
export {
  encodeMeta,
  decodeMeta,
  defaultMeta,
  encodeUtf8,
  decodeUtf8,
  MAX_TITLE_BYTES,
  MAX_AUTHOR_BYTES,
  PROFILES,
  PAYLOADS,
} from "./meta";
export type { Meta } from "./meta";

// --- identity --------------------------------------------------------------
export { ID_BYTES, cartId, cartIdOf, cartIdBytes, formatId, base32Encode, base32Decode } from "./id";

// --- the static gate -------------------------------------------------------
// What a cart may not name, checked before a cart is written. The list here is
// the sandbox's shadow list: a name on one must be on the other, or an author
// gets a cart that builds and then dies on load.
export { lintCartSource, forbiddenMessage, FORBIDDEN_IDENTIFIERS, TOKEN_BUDGET } from "./lint";
export type { LintFinding, LintResult, LintRule } from "./lint";
