/**
 * Typed cart errors.
 *
 * The decoder is the one place in Square One where bytes written by a stranger
 * meet parsing code, so it never throws: every failure leaves through a
 * `CartError` that a player can render, a CLI can exit on, and a fuzzer can
 * assert against. A thrown exception crossing that boundary would be an
 * unhandled rejection somewhere in a host we do not control.
 *
 * Messages name BOTH what is wrong and what would have been right. "invalid
 * chunk" tells an author nothing; `chunk "CODE" at 0x0040 declares 70000 bytes
 * but the file has 4096 left` tells them the file is truncated and roughly
 * where. Diagnostics are part of the format's usability, not decoration.
 */

export type CartErrorCode =
  | "bad-magic"
  | "short-header"
  | "spec-too-new"
  | "truncated"
  | "unknown-critical-chunk"
  | "duplicate-chunk"
  | "bad-chunk-type"
  | "bad-padding"
  | "chunk-too-large"
  | "cart-too-large"
  | "index-mismatch"
  | "bad-index"
  | "missing-required-chunk"
  | "bad-meta"
  | "trailing-garbage";

/** Every code the decoder can produce, for exhaustiveness checks in tests. */
export const CART_ERROR_CODES: readonly CartErrorCode[] = [
  "bad-magic",
  "short-header",
  "spec-too-new",
  "truncated",
  "unknown-critical-chunk",
  "duplicate-chunk",
  "bad-chunk-type",
  "bad-padding",
  "chunk-too-large",
  "cart-too-large",
  "index-mismatch",
  "bad-index",
  "missing-required-chunk",
  "bad-meta",
  "trailing-garbage",
];

export interface CartError {
  /** Stable machine-readable code. Never localise or reword these. */
  readonly code: CartErrorCode;
  /** Human message naming what is wrong and what would be right. */
  readonly message: string;
  /** Byte offset the problem was found at, when there is a meaningful one. */
  readonly offset?: number;
}

/**
 * Build a CartError.
 *
 * `offset` is omitted from the object rather than set to `undefined`, because
 * `exactOptionalPropertyTypes` is on and `{ offset: undefined }` is not a
 * `{ offset?: number }`.
 */
export function cartError(code: CartErrorCode, message: string, offset?: number): CartError {
  return offset === undefined ? { code, message } : { code, message, offset };
}

/** `0x0040` -- offsets are always shown in hex, because the format is binary. */
export function hexOffset(n: number): string {
  const v = Math.max(0, Math.floor(n));
  return "0x" + v.toString(16).toUpperCase().padStart(4, "0");
}
