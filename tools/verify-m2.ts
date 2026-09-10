/**
 * M2 acceptance check.
 *
 * The milestone's acceptance criteria, exercised directly against the shipping
 * API rather than through the unit suites, so the criteria stay checkable by
 * anyone at any time without reading a test file:
 *
 *   1. a cart round-trips byte-identically
 *   2. a cart with an unknown ANCILLARY chunk loads, and keeps it
 *   3. a cart with an unknown CRITICAL chunk is refused, with a named error
 *   4. the size budget is enforced exactly at the boundary
 *   5. the cart id covers the label, and ignores the signature
 *
 * The cross-directory determinism criterion is checked in the shell instead,
 * because "same bytes from a different working directory" is a property of the
 * process, not of the library.
 *
 * Run: npx vite-node tools/verify-m2.ts
 */

import {
  MAX_CART_BYTES,
  cartIdOf,
  decode,
  encode,
  formatId,
  getChunk,
} from "@sq1/cart";
import type { CartFile, Chunk } from "@sq1/cart";
import { encodeMeta } from "@sq1/cart";

let failures = 0;

function check(name: string, ok: boolean, detail = ""): void {
  const mark = ok ? "PASS" : "FAIL";
  if (!ok) failures++;
  process.stdout.write(`  ${mark}  ${name}${detail === "" ? "" : `\n        ${detail}`}\n`);
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

const meta = encodeMeta({
  title: "Acceptance",
  author: "sq1",
  profile: "up",
  payload: "script/js1",
  abiMinor: 0,
  specMajor: 1,
  specMinor: 0,
});

function cartWith(extra: Chunk[] = [], codeBytes = 64): CartFile {
  const code = new Uint8Array(codeBytes);
  for (let i = 0; i < code.length; i++) code[i] = 0x20 + (i % 60);
  return {
    specMajor: 1,
    specMinor: 0,
    chunks: [{ type: "META", data: meta }, { type: "CODE", data: code }, ...extra],
  };
}

process.stdout.write("\nM2 acceptance\n\n");

// --- 1. byte-identical round trip -------------------------------------------
{
  const bytes = encode(cartWith());
  const first = decode(bytes);
  check("decode accepts a freshly encoded cart", first.ok);
  if (first.ok) {
    const again = encode(first.cart);
    check("encode(decode(x)) === x, byte for byte", sameBytes(bytes, again),
      sameBytes(bytes, again) ? "" : `${bytes.length} bytes vs ${again.length}`);
    const third = decode(again);
    check("and it is stable on a second pass", third.ok && sameBytes(encode(third.cart), bytes));
  }
}

// --- 2. unknown ancillary chunk survives ------------------------------------
{
  const payload = new Uint8Array([9, 8, 7, 6, 5]);
  const bytes = encode(cartWith([{ type: "zzzz", data: payload }]));
  const r = decode(bytes);
  check('unknown ANCILLARY chunk "zzzz" loads', r.ok,
    r.ok ? "" : `refused: ${r.error.code} - ${r.error.message}`);
  if (r.ok) {
    const kept = getChunk(r.cart, "zzzz");
    check("and its payload is preserved intact", kept !== undefined && sameBytes(kept, payload));
    check("and it survives a re-encode", sameBytes(encode(r.cart), bytes));
  }
}

// --- 3. unknown critical chunk is refused, by name --------------------------
{
  const bytes = encode(cartWith([{ type: "ZZZZ", data: new Uint8Array([1, 2, 3, 4]) }]));
  const r = decode(bytes);
  check('unknown CRITICAL chunk "ZZZZ" is refused', !r.ok);
  if (!r.ok) {
    check('  ...with code "unknown-critical-chunk"',
      r.error.code === "unknown-critical-chunk", `got "${r.error.code}"`);
    check("  ...and a message that names the chunk",
      r.error.message.includes("ZZZZ"), r.error.message);
  }
}

// --- 4. the size budget, exactly at the boundary ----------------------------
{
  // Grow CODE until the encoding lands exactly on the budget.
  let codeBytes = MAX_CART_BYTES - encode(cartWith()).length + 64;
  let bytes = encode(cartWith([], codeBytes));
  while (bytes.length > MAX_CART_BYTES) bytes = encode(cartWith([], --codeBytes));
  while (bytes.length < MAX_CART_BYTES) bytes = encode(cartWith([], ++codeBytes));

  check(`a cart of exactly ${MAX_CART_BYTES} bytes is accepted`,
    bytes.length === MAX_CART_BYTES && decode(bytes).ok, `built ${bytes.length}`);

  const over = encode(cartWith([], codeBytes + 4));
  const r = decode(over);
  check(`${over.length} bytes (over budget) is refused`, !r.ok,
    r.ok ? "accepted an over-budget cart" : `code "${r.error.code}"`);
}

// --- 5. what the cart id covers ---------------------------------------------
{
  const base = cartWith();
  const withLabel = cartWith([{ type: "labl", data: new Uint8Array([1, 1, 1, 1]) }]);
  const otherLabel = cartWith([{ type: "labl", data: new Uint8Array([2, 2, 2, 2]) }]);
  const withSign = cartWith([{ type: "sign", data: new Uint8Array(64).fill(7) }]);
  const otherSign = cartWith([{ type: "sign", data: new Uint8Array(64).fill(9) }]);

  const idBase = cartIdOf(base);
  check("cart id is 32 Crockford base32 characters",
    /^[0-9A-HJKMNP-TV-Z]{32}$/.test(idBase), idBase);
  check("cart id groups into 4 blocks of 8", formatId(idBase).split("-").length === 4,
    formatId(idBase));
  check("changing the LABEL changes the id (no face-swapping a known cart)",
    cartIdOf(withLabel) !== cartIdOf(otherLabel));
  check("adding a label changes the id", idBase !== cartIdOf(withLabel));
  check("changing only the SIGNATURE does NOT change the id",
    cartIdOf(withSign) === cartIdOf(otherSign),
    `${cartIdOf(withSign)} vs ${cartIdOf(otherSign)}`);
  check("a signature does not change the id at all", idBase === cartIdOf(withSign));
}

process.stdout.write(
  failures === 0 ? "\nM2 acceptance: all criteria met\n\n" : `\nM2 acceptance: ${failures} FAILED\n\n`,
);
process.exit(failures === 0 ? 0 : 1);
