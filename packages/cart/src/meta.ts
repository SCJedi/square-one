/**
 * The META chunk: who made this cart, what shape its payload is, what it needs.
 *
 * DETERMINISM IS THE WHOLE JOB
 * ----------------------------
 * The cart id is a hash of the canonical encoding, and META is inside it. So
 * two machines building the same cart must produce byte-identical META, or
 * reproducible builds mean nothing and the same game gets two addresses.
 *
 * The classic way that fails quietly is object key iteration order:
 * `JSON.stringify(obj)` emits keys in insertion order, which depends on how the
 * object was built, not on what it contains. So this file NEVER stringifies an
 * object. It emits the seven fields by hand, in a fixed sorted key order, and
 * uses `JSON.stringify` only on individual strings and integers -- where the
 * language specification pins the output exactly.
 *
 * There are no timestamps, no floating point and no paths in META, for the same
 * reason: each of them is a way for the build machine to leak into the artifact.
 *
 * UTF-8 IS HAND-ROLLED
 * --------------------
 * `TextEncoder`/`TextDecoder` are not guaranteed present in the scrubbed Worker
 * realm a cart is inspected inside, and a lenient decoder that silently
 * substitutes U+FFFD for malformed input would let two different byte strings
 * decode to the same metadata -- another way to get one game at two addresses,
 * or two games at one. The codecs below are strict: overlong encodings,
 * surrogates and truncated sequences are rejected, not repaired.
 */

import { SPEC_MAJOR, SPEC_MINOR } from "./chunks";
import type { CartError } from "./errors";
import { cartError } from "./errors";

export interface Meta {
  title: string;
  author: string;
  profile: "up";
  payload: "script/js1" | "wasm/1";
  abiMinor: number;
  specMajor: number;
  specMinor: number;
}

/** Longest permitted title, in UTF-8 BYTES (not characters). */
export const MAX_TITLE_BYTES = 64;
/** Longest permitted author, in UTF-8 BYTES (not characters). */
export const MAX_AUTHOR_BYTES = 32;

export const PROFILES: readonly string[] = ["up"];
export const PAYLOADS: readonly string[] = ["script/js1", "wasm/1"];

/**
 * The exact key set of a META document, in the fixed order it is emitted.
 *
 * Sorted by ASCII. A decoder requires this set EXACTLY -- an unrecognised key
 * is refused rather than ignored, because ignoring it would mean re-encoding
 * drops it, which silently changes the cart id of a cart that round-tripped
 * through a tool. New fields ride a spec_minor bump.
 */
const META_KEYS: readonly string[] = [
  "abiMinor",
  "author",
  "payload",
  "profile",
  "specMajor",
  "specMinor",
  "title",
];

// --- strict UTF-8 ----------------------------------------------------------

/**
 * Encode a JavaScript string as UTF-8. Returns null for a lone surrogate,
 * which has no UTF-8 representation and must not be silently replaced.
 */
export function encodeUtf8(s: string): Uint8Array | null {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    let cp = s.charCodeAt(i);
    if (cp >= 0xd800 && cp <= 0xdbff) {
      const lo = i + 1 < s.length ? s.charCodeAt(i + 1) : -1;
      if (lo < 0xdc00 || lo > 0xdfff) return null; // high surrogate with no pair
      cp = 0x10000 + ((cp - 0xd800) << 10) + (lo - 0xdc00);
      i++;
    } else if (cp >= 0xdc00 && cp <= 0xdfff) {
      return null; // stray low surrogate
    }
    if (cp < 0x80) {
      out.push(cp);
    } else if (cp < 0x800) {
      out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    } else if (cp < 0x10000) {
      out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    } else {
      out.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 0x3f),
        0x80 | ((cp >> 6) & 0x3f),
        0x80 | (cp & 0x3f),
      );
    }
  }
  return new Uint8Array(out);
}

/**
 * Decode UTF-8 strictly. Returns null on anything a conforming encoder would
 * never produce: a truncated sequence, a bad continuation byte, an overlong
 * form, a surrogate code point, or a value above U+10FFFF.
 *
 * Lead bytes 0xc0 and 0xc1 are rejected by construction (they can only begin an
 * overlong two-byte form), as are 0xf5-0xff (above the Unicode range).
 */
export function decodeUtf8(b: Uint8Array): string | null {
  let out = "";
  let i = 0;
  while (i < b.length) {
    const b0 = b[i] ?? 0;
    let cp: number;
    let n: number;
    if (b0 < 0x80) {
      cp = b0;
      n = 1;
    } else if (b0 >= 0xc2 && b0 <= 0xdf) {
      cp = b0 & 0x1f;
      n = 2;
    } else if (b0 >= 0xe0 && b0 <= 0xef) {
      cp = b0 & 0x0f;
      n = 3;
    } else if (b0 >= 0xf0 && b0 <= 0xf4) {
      cp = b0 & 0x07;
      n = 4;
    } else {
      return null;
    }
    if (i + n > b.length) return null;
    for (let k = 1; k < n; k++) {
      const bk = b[i + k] ?? 0;
      if ((bk & 0xc0) !== 0x80) return null;
      cp = (cp << 6) | (bk & 0x3f);
    }
    if (n === 3 && cp < 0x800) return null; // overlong
    if (n === 4 && cp < 0x10000) return null; // overlong
    if (cp >= 0xd800 && cp <= 0xdfff) return null; // surrogate
    if (cp > 0x10ffff) return null;
    out += String.fromCodePoint(cp);
    i += n;
  }
  return out;
}

/**
 * True if the string contains a C0 control, DEL, or a C1 control.
 *
 * Titles and author names are rendered in a shell, in a terminal, and in HTML.
 * A newline or an ANSI escape in a title from a stranger is a display-spoofing
 * primitive, so it is rejected at the format boundary rather than escaped at
 * every one of the places that shows it.
 */
function hasControlChars(s: string): boolean {
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp < 0x20 || cp === 0x7f || (cp >= 0x80 && cp <= 0x9f)) return true;
  }
  return false;
}

// --- encode ----------------------------------------------------------------

function requireField(ok: boolean, message: string): void {
  if (!ok) throw new Error(`encodeMeta: ${message}`);
}

/**
 * Serialise META to canonical UTF-8 JSON.
 *
 * Throws on invalid metadata, for the same reason `encode` does: this consumes
 * a structure the build process just made, so a bad value is a bug worth
 * stopping on, not hostile input to be tolerated. `decodeMeta` is the tolerant
 * half of the pair.
 */
export function encodeMeta(m: Meta): Uint8Array {
  const titleBytes = encodeUtf8(m.title);
  requireField(titleBytes !== null, `title is not valid text (it contains an unpaired surrogate)`);
  requireField(
    (titleBytes as Uint8Array).length <= MAX_TITLE_BYTES,
    `title is ${(titleBytes as Uint8Array).length} UTF-8 bytes; the limit is ${MAX_TITLE_BYTES}`,
  );
  requireField(!hasControlChars(m.title), `title contains a control character`);

  const authorBytes = encodeUtf8(m.author);
  requireField(authorBytes !== null, `author is not valid text (it contains an unpaired surrogate)`);
  requireField(
    (authorBytes as Uint8Array).length <= MAX_AUTHOR_BYTES,
    `author is ${(authorBytes as Uint8Array).length} UTF-8 bytes; the limit is ${MAX_AUTHOR_BYTES}`,
  );
  requireField(!hasControlChars(m.author), `author contains a control character`);

  requireField(
    PROFILES.indexOf(m.profile) !== -1,
    `profile is "${m.profile}"; it must be one of ${PROFILES.join(", ")}`,
  );
  requireField(
    PAYLOADS.indexOf(m.payload) !== -1,
    `payload is "${m.payload}"; it must be one of ${PAYLOADS.join(", ")}`,
  );
  requireField(
    Number.isInteger(m.abiMinor) && m.abiMinor >= 0 && m.abiMinor <= 0xffff,
    `abiMinor is ${m.abiMinor}; it must be an integer in [0, 65535]`,
  );
  requireField(
    Number.isInteger(m.specMajor) && m.specMajor >= 0 && m.specMajor <= 0xffff,
    `specMajor is ${m.specMajor}; it must be an integer in [0, 65535]`,
  );
  requireField(
    Number.isInteger(m.specMinor) && m.specMinor >= 0 && m.specMinor <= 0xffff,
    `specMinor is ${m.specMinor}; it must be an integer in [0, 65535]`,
  );

  // Emitted by hand, in META_KEYS order. JSON.stringify is applied only to
  // individual strings and integers, where its output is fully specified.
  const json =
    "{" +
    `"abiMinor":${String(m.abiMinor)},` +
    `"author":${JSON.stringify(m.author)},` +
    `"payload":${JSON.stringify(m.payload)},` +
    `"profile":${JSON.stringify(m.profile)},` +
    `"specMajor":${String(m.specMajor)},` +
    `"specMinor":${String(m.specMinor)},` +
    `"title":${JSON.stringify(m.title)}` +
    "}";

  const bytes = encodeUtf8(json);
  // Unreachable: every string in `json` already round-tripped through
  // encodeUtf8 above. Kept so the null branch is not a cast.
  if (bytes === null) throw new Error("encodeMeta: metadata is not encodable as UTF-8");
  return bytes;
}

/** A meta with this implementation's container version filled in. */
export function defaultMeta(title: string, author: string): Meta {
  return {
    title,
    author,
    profile: "up",
    payload: "script/js1",
    abiMinor: 0,
    specMajor: SPEC_MAJOR,
    specMinor: SPEC_MINOR,
  };
}

// --- decode ----------------------------------------------------------------

function bad(message: string): { ok: false; error: CartError } {
  return { ok: false, error: cartError("bad-meta", message) };
}

/**
 * Parse and validate a META payload. Never throws -- malformed JSON, malformed
 * UTF-8 and hostile values all leave as a `bad-meta` CartError.
 */
export function decodeMeta(b: Uint8Array): { ok: true; meta: Meta } | { ok: false; error: CartError } {
  const text = decodeUtf8(b);
  if (text === null) {
    return bad(
      `META is not valid UTF-8; it must be a UTF-8 JSON object with the keys ` +
        `${META_KEYS.join(", ")}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    return bad(`META is not valid JSON (${why}); it must be a UTF-8 JSON object`);
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return bad(`META is ${parsed === null ? "null" : typeof parsed}; it must be a JSON object`);
  }

  const o = parsed as Record<string, unknown>;
  const keys = Object.keys(o).slice().sort();
  if (keys.length !== META_KEYS.length || keys.some((k, i) => k !== META_KEYS[i])) {
    return bad(
      `META has keys [${keys.join(", ")}]; it must have exactly [${META_KEYS.join(", ")}]. ` +
        `An unrecognised key is refused rather than ignored, because ignoring it would drop ` +
        `it on re-encode and silently change the cart id`,
    );
  }

  const title = o["title"];
  if (typeof title !== "string") return bad(`META.title is ${typeof title}; it must be a string`);
  const titleBytes = encodeUtf8(title);
  if (titleBytes === null) return bad(`META.title contains an unpaired surrogate`);
  if (titleBytes.length > MAX_TITLE_BYTES) {
    return bad(
      `META.title is ${titleBytes.length} UTF-8 bytes; the limit is ${MAX_TITLE_BYTES} bytes`,
    );
  }
  if (hasControlChars(title)) {
    return bad(
      `META.title contains a control character; titles are shown in terminals and in HTML, ` +
        `so they must be printable text only`,
    );
  }

  const author = o["author"];
  if (typeof author !== "string") return bad(`META.author is ${typeof author}; it must be a string`);
  const authorBytes = encodeUtf8(author);
  if (authorBytes === null) return bad(`META.author contains an unpaired surrogate`);
  if (authorBytes.length > MAX_AUTHOR_BYTES) {
    return bad(
      `META.author is ${authorBytes.length} UTF-8 bytes; the limit is ${MAX_AUTHOR_BYTES} bytes`,
    );
  }
  if (hasControlChars(author)) {
    return bad(
      `META.author contains a control character; author names are shown in terminals and in ` +
        `HTML, so they must be printable text only`,
    );
  }

  const profile = o["profile"];
  if (typeof profile !== "string" || PROFILES.indexOf(profile) === -1) {
    return bad(
      `META.profile is ${JSON.stringify(profile)}; it must be one of ` +
        `${PROFILES.map((p) => JSON.stringify(p)).join(", ")}`,
    );
  }

  const payload = o["payload"];
  if (typeof payload !== "string" || PAYLOADS.indexOf(payload) === -1) {
    return bad(
      `META.payload is ${JSON.stringify(payload)}; it must be one of ` +
        `${PAYLOADS.map((p) => JSON.stringify(p)).join(", ")}`,
    );
  }

  const abiMinor = o["abiMinor"];
  if (typeof abiMinor !== "number" || !Number.isInteger(abiMinor) || abiMinor < 0 || abiMinor > 0xffff) {
    return bad(
      `META.abiMinor is ${JSON.stringify(abiMinor)}; it must be a non-negative integer in ` +
        `[0, 65535]`,
    );
  }

  const specMajorV = o["specMajor"];
  if (
    typeof specMajorV !== "number" ||
    !Number.isInteger(specMajorV) ||
    specMajorV < 0 ||
    specMajorV > 0xffff
  ) {
    return bad(
      `META.specMajor is ${JSON.stringify(specMajorV)}; it must be a non-negative integer in ` +
        `[0, 65535]`,
    );
  }

  const specMinorV = o["specMinor"];
  if (
    typeof specMinorV !== "number" ||
    !Number.isInteger(specMinorV) ||
    specMinorV < 0 ||
    specMinorV > 0xffff
  ) {
    return bad(
      `META.specMinor is ${JSON.stringify(specMinorV)}; it must be a non-negative integer in ` +
        `[0, 65535]`,
    );
  }

  return {
    ok: true,
    meta: {
      title,
      author,
      profile: profile as "up",
      payload: payload as "script/js1" | "wasm/1",
      abiMinor,
      specMajor: specMajorV,
      specMinor: specMinorV,
    },
  };
}
