/**
 * The M2 acceptance test: decode() never throws.
 *
 * Not on truncation, not on absurd lengths, not on an index that points into
 * the middle of a chunk, not on zero bytes, not on a wall of 0xff. Every
 * failure is a returned CartError with a code from the known set.
 *
 * The driver is @sq1/core's xoshiro128**, seeded from a constant printed in
 * every failure message, so a failing iteration is reproducible exactly: set
 * SEED to the printed value, run again, and the same bytes come back.
 *
 * Most of the iterations are STRUCTURE-AWARE. Pure noise almost never gets past
 * the four-byte magic check -- the odds are one in four billion -- so a fuzzer
 * built only from random bytes would test the first `if` in the file ten
 * thousand times and nothing else. The generators below build a real cart and
 * then damage it, which is what actually reaches the chunk walk, the padding
 * check and the directory comparison.
 */

import { describe, expect, it } from "vitest";
import { rnd, rngCreate, rngNext } from "@sq1/core";
import {
  CART_ERROR_CODES,
  DIRECTORY_ENTRY_BYTES,
  HEADER_BYTES,
  MAGIC,
  canonicalize,
  decode,
  encode,
  getChunk,
  paddedLength,
} from "../src/index";
import type { CartErrorCode, CartFile, Chunk } from "../src/index";
import { encodeMeta } from "../src/meta";

const SEED = 0x5109c0de;
// 12,000 every commit keeps the everyday suite under a second. The nightly job
// runs with SQ1_SLOW=1, and a fuzzer that ignored the flag would spend that job
// re-running the exact same 12,000 inputs it already ran on every push.
const ITERATIONS =
  (typeof process !== "undefined" && process.env["SQ1_SLOW"] === "1") ? 200_000 : 12_000;
/** The whole run must finish inside this. An O(n^2) walk or a stuck loop fails here. */
const TIME_BUDGET_MS = 60_000;

const KNOWN_CODES = new Set<string>(CART_ERROR_CODES);

// --- fixtures --------------------------------------------------------------

const META = encodeMeta({
  title: "Fuzz",
  author: "sq1",
  profile: "up",
  payload: "script/js1",
  abiMinor: 0,
  specMajor: 1,
  specMinor: 0,
});

function chunk(type: string, data: Uint8Array): Chunk {
  return { type, data };
}

function validCart(extra: Chunk[] = []): CartFile {
  return {
    specMajor: 1,
    specMinor: 0,
    chunks: [
      chunk("META", META),
      chunk("CODE", new Uint8Array([0x74, 0x69, 0x63, 0x6b, 0x28, 0x29])), // "tick()"
      ...extra,
    ],
  };
}

const VALID = encode(
  validCart([
    chunk("GFX ", new Uint8Array(32).fill(0x11)),
    chunk("DATA", new Uint8Array([1, 2, 3])),
    chunk("labl", new Uint8Array(17).fill(0x22)),
    chunk("wxyz", new Uint8Array([9])),
    chunk("sign", new Uint8Array(64).fill(0x33)),
  ]),
);

function writeU32le(b: Uint8Array, i: number, v: number): void {
  b[i] = v & 0xff;
  b[i + 1] = (v >>> 8) & 0xff;
  b[i + 2] = (v >>> 16) & 0xff;
  b[i + 3] = (v >>> 24) & 0xff;
}
function u32le(b: Uint8Array, i: number): number {
  return (
    ((b[i] ?? 0) | ((b[i + 1] ?? 0) << 8) | ((b[i + 2] ?? 0) << 16) | ((b[i + 3] ?? 0) << 24)) >>> 0
  );
}

/** Byte offsets of every chunk record in VALID, for targeted damage. */
function chunkRecordOffsets(bytes: Uint8Array): number[] {
  const idx = u32le(bytes, 12);
  const out: number[] = [];
  let p = HEADER_BYTES;
  while (p + 8 <= idx) {
    out.push(p);
    const len = u32le(bytes, p + 4);
    const step = 8 + paddedLength(len);
    if (step <= 0) break;
    p += step;
  }
  return out;
}
const RECORDS = chunkRecordOffsets(VALID);

// --- generators ------------------------------------------------------------
// Each takes the PRNG state and returns bytes. They are pure functions of the
// state, so the whole corpus is a function of SEED alone.

type Gen = (s: Uint32Array) => Uint8Array;

const gNoise: Gen = (s) => {
  const n = rnd(s, 4097); // 0..4096
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = rnd(s, 256);
  return b;
};

const gCorruptValid: Gen = (s) => {
  const b = VALID.slice();
  const hits = 1 + rnd(s, 8); // 1..8 corrupted bytes
  for (let i = 0; i < hits; i++) {
    const at = rnd(s, b.length);
    // XOR rather than assign, so the byte is always actually changed.
    b[at] = ((b[at] ?? 0) ^ (1 + rnd(s, 255))) & 0xff;
  }
  return b;
};

const gValidHeaderThenGarbage: Gen = (s) => {
  const n = HEADER_BYTES + rnd(s, 512);
  const b = new Uint8Array(n);
  b.set(VALID.subarray(0, Math.min(HEADER_BYTES, n)), 0);
  for (let i = HEADER_BYTES; i < n; i++) b[i] = rnd(s, 256);
  return b;
};

const ABSURD_LENGTHS = [
  0xffffffff, 0xfffffffe, 0x80000000, 0x7fffffff, 0x00010000, 0x00010001, 0x0000ffff, 0, 1, 3, 4, 5,
];

const gAbsurdLength: Gen = (s) => {
  const b = VALID.slice();
  const rec = RECORDS[rnd(s, RECORDS.length)] as number;
  const idx = u32le(b, 12);
  const choice = rnd(s, ABSURD_LENGTHS.length + 3);
  let v: number;
  if (choice < ABSURD_LENGTHS.length) {
    v = ABSURD_LENGTHS[choice] as number;
  } else if (choice === ABSURD_LENGTHS.length) {
    v = idx - (rec + 8); // exactly to the end of the stream
  } else if (choice === ABSURD_LENGTHS.length + 1) {
    v = idx - (rec + 8) + 1; // one past
  } else {
    v = (idx - (rec + 8) - 1) >>> 0; // one short
  }
  writeU32le(b, rec + 4, v >>> 0);
  return b;
};

const gIndexOffset: Gen = (s) => {
  const b = VALID.slice();
  const idx = u32le(b, 12);
  const choice = rnd(s, 9);
  const values = [
    0,
    HEADER_BYTES,
    HEADER_BYTES - 1,
    idx - 4,
    idx + 4,
    idx - 1,
    b.length,
    b.length + 1,
    0xffffffff,
  ];
  writeU32le(b, 12, (values[choice] as number) >>> 0);
  return b;
};

const gChunkCount: Gen = (s) => {
  const b = VALID.slice();
  const values = [0, 1, 2, 5, 6, 0xffff, 0xffffffff, rnd(s, 0x7fffffff)];
  writeU32le(b, 8, (values[rnd(s, values.length)] as number) >>> 0);
  return b;
};

const gTruncated: Gen = (s) => VALID.slice(0, rnd(s, VALID.length + 1));

const gBadPadding: Gen = (s) => {
  const b = VALID.slice();
  const idx = u32le(b, 12);
  // The labl chunk is 17 bytes, so it has three padding bytes.
  let p = HEADER_BYTES;
  const pads: number[] = [];
  while (p + 8 <= idx) {
    const len = u32le(b, p + 4);
    for (let q = p + 8 + len; q < p + 8 + paddedLength(len); q++) pads.push(q);
    p += 8 + paddedLength(len);
  }
  if (pads.length > 0) {
    const at = pads[rnd(s, pads.length)] as number;
    b[at] = 1 + rnd(s, 255);
  }
  return b;
};

const gDirectoryDamage: Gen = (s) => {
  const b = VALID.slice();
  const idx = u32le(b, 12);
  const entries = Math.floor((b.length - idx) / DIRECTORY_ENTRY_BYTES);
  if (entries > 0) {
    const e = idx + rnd(s, entries) * DIRECTORY_ENTRY_BYTES;
    const at = e + rnd(s, DIRECTORY_ENTRY_BYTES);
    b[at] = ((b[at] ?? 0) ^ (1 + rnd(s, 255))) & 0xff;
  }
  return b;
};

/**
 * Damage a chunk's declared length AND the matching directory entry, so the two
 * still agree.
 *
 * This generator exists because of a mutation test. Deleting the chunk-payload
 * bounds check in the walk changed NOTHING that the fuzzer could see: every
 * input that the missing check would have caught was caught a few lines later
 * by the directory cross-check instead. A corpus that can only reach a bounds
 * check through a second, redundant check is not testing the bounds check. This
 * one keeps the directory honest so the walk has to do the work itself.
 */
const gConsistentLength: Gen = (s) => {
  const b = VALID.slice();
  const idx = u32le(b, 12);
  const i = rnd(s, RECORDS.length);
  const rec = RECORDS[i] as number;
  const remaining = idx - (rec + 8);
  const choices = [
    remaining + 1,
    remaining + 4,
    remaining + 1000,
    idx,
    0x00010000,
    0xffffffff,
    remaining,
  ];
  const v = (choices[rnd(s, choices.length)] as number) >>> 0;
  writeU32le(b, rec + 4, v);
  writeU32le(b, idx + i * DIRECTORY_ENTRY_BYTES + 8, v);
  return b;
};

const gCartLikePrefix: Gen = (s) => {
  // A cart-shaped file built entirely from random field values: magic is right,
  // everything after it is a coin flip. This is the generator that reaches the
  // sanity checks in step 5 with values no structured mutation would produce.
  const n = HEADER_BYTES + rnd(s, 256) * 4;
  const b = new Uint8Array(n);
  for (let i = 0; i < 4; i++) b[i] = MAGIC.charCodeAt(i);
  b[4] = rnd(s, 2); // spec_major 0 or 1, so the file gets past the version gate
  writeU32le(b, 8, rngNext(s) >>> (rnd(s, 3) * 8));
  writeU32le(b, 12, rngNext(s) >>> (rnd(s, 3) * 8));
  for (let i = HEADER_BYTES; i < n; i++) b[i] = rnd(s, 256);
  return b;
};

const GENERATORS: readonly { name: string; gen: Gen }[] = [
  { name: "noise", gen: gNoise },
  { name: "corrupt-valid", gen: gCorruptValid },
  { name: "corrupt-valid", gen: gCorruptValid }, // weighted: it finds the most
  { name: "valid-header-then-garbage", gen: gValidHeaderThenGarbage },
  { name: "absurd-length", gen: gAbsurdLength },
  { name: "index-offset", gen: gIndexOffset },
  { name: "chunk-count", gen: gChunkCount },
  { name: "truncated", gen: gTruncated },
  { name: "bad-padding", gen: gBadPadding },
  { name: "directory-damage", gen: gDirectoryDamage },
  { name: "consistent-length", gen: gConsistentLength },
  { name: "cart-like-prefix", gen: gCartLikePrefix },
];

// --- the check -------------------------------------------------------------

/**
 * Everything asserted about one input. Returns a description of the failure,
 * or null. Throwing here would lose the seed, so the caller reports.
 */
function checkOne(bytes: Uint8Array): string | null {
  let r: ReturnType<typeof decode>;
  try {
    r = decode(bytes);
  } catch (e) {
    return `decode THREW: ${e instanceof Error ? e.stack ?? e.message : String(e)}`;
  }
  if (r.ok) {
    try {
      const re = encode(r.cart);

      // INVARIANT 1: an accepted cart accounts for EVERY byte of the file.
      // The canonical size is 16 + the chunk stream + 12 per directory entry,
      // and for an accepted cart that must be exactly the file size. Any byte
      // the decoder failed to account for is a place to hide data that changes
      // no behaviour and changes the cart id.
      if (re.length !== bytes.length) {
        return `accepted a ${bytes.length}-byte file whose canonical size is ${re.length}`;
      }

      // INVARIANT 2: if the accepted cart's chunks are ALREADY in canonical
      // order, then the file must already BE its canonical encoding, byte for
      // byte. Chunk order is the only freedom a valid cart has; everything else
      // -- padding, alignment, the directory, the header counts -- is fixed. So
      // this is the check that turns "the decoder validated it" into "there is
      // nothing else in here".
      const asIs = r.cart.chunks.map((c) => c.type).join(",");
      const canon = canonicalize(r.cart).chunks.map((c) => c.type).join(",");
      if (asIs === canon) {
        for (let i = 0; i < re.length; i++) {
          if (re[i] !== bytes[i]) {
            return (
              `accepted a canonically-ordered cart that is not its own canonical ` +
              `encoding: byte ${i} is 0x${(bytes[i] ?? 0).toString(16)} in the file but ` +
              `0x${(re[i] ?? 0).toString(16)} when re-encoded`
            );
          }
        }
      }

      // INVARIANT 3: re-encoding is a fixed point.
      const r2 = decode(re);
      if (!r2.ok) return `re-decode of an accepted cart failed: ${r2.error.code}`;
      const re2 = encode(r2.cart);
      if (re.length !== re2.length) return `re-encode is not a fixed point (length)`;
      for (let i = 0; i < re.length; i++) {
        if (re[i] !== re2[i]) return `re-encode is not a fixed point at byte ${i}`;
      }
    } catch (e) {
      return `re-encode of an accepted cart threw: ${e instanceof Error ? e.message : String(e)}`;
    }
    return null;
  }
  const code: string = r.error.code;
  if (!KNOWN_CODES.has(code)) return `unknown error code ${JSON.stringify(code)}`;
  if (typeof r.error.message !== "string" || r.error.message.length === 0) {
    return `error ${code} carries no message`;
  }
  if (r.error.offset !== undefined && !Number.isFinite(r.error.offset)) {
    return `error ${code} carries a non-finite offset ${r.error.offset}`;
  }
  return null;
}

function hexdump(b: Uint8Array, max = 96): string {
  const n = Math.min(b.length, max);
  let out = "";
  for (let i = 0; i < n; i++) out += (b[i] ?? 0).toString(16).padStart(2, "0");
  return `${b.length} bytes: ${out}${b.length > max ? "..." : ""}`;
}

// --- the run ---------------------------------------------------------------

describe("decode never throws", () => {
  it(`survives ${ITERATIONS} seeded fuzz iterations inside ${TIME_BUDGET_MS} ms`, () => {
    const started = Date.now();
    const s = rngCreate(SEED);
    const codeHistogram = new Map<string, number>();
    let accepted = 0;

    for (let i = 0; i < ITERATIONS; i++) {
      const pick = GENERATORS[rnd(s, GENERATORS.length)] as { name: string; gen: Gen };
      let bytes: Uint8Array;
      try {
        bytes = pick.gen(s);
      } catch (e) {
        throw new Error(
          `generator "${pick.name}" threw at iteration ${i} (SEED=0x${SEED.toString(16)}): ` +
            `${e instanceof Error ? e.message : String(e)}`,
        );
      }
      const failure = checkOne(bytes);
      if (failure !== null) {
        throw new Error(
          `FUZZ FAILURE\n` +
            `  SEED       0x${SEED.toString(16)}\n` +
            `  iteration  ${i}\n` +
            `  generator  ${pick.name}\n` +
            `  problem    ${failure}\n` +
            `  input      ${hexdump(bytes)}\n` +
            `  reproduce  set SEED to 0x${SEED.toString(16)} and run to iteration ${i}`,
        );
      }
      const r = decode(bytes);
      if (r.ok) accepted++;
      else codeHistogram.set(r.error.code, (codeHistogram.get(r.error.code) ?? 0) + 1);
    }

    const elapsed = Date.now() - started;

    // The corpus must actually exercise the decoder rather than bouncing off
    // the magic check. If a refactor made every input fail at step 1 or 2, this
    // is what would notice.
    const structural =
      (codeHistogram.get("truncated") ?? 0) +
      (codeHistogram.get("bad-index") ?? 0) +
      (codeHistogram.get("index-mismatch") ?? 0) +
      (codeHistogram.get("bad-padding") ?? 0) +
      (codeHistogram.get("chunk-too-large") ?? 0) +
      (codeHistogram.get("bad-chunk-type") ?? 0);
    expect(structural, `histogram: ${JSON.stringify([...codeHistogram])}`).toBeGreaterThan(1000);
    expect(accepted, "some mutations must still produce a valid cart").toBeGreaterThan(0);
    expect(elapsed, `fuzz run took ${elapsed} ms`).toBeLessThan(TIME_BUDGET_MS);
  });

  it("survives every prefix of a real cart", () => {
    for (let n = 0; n <= VALID.length; n++) {
      const failure = checkOne(VALID.subarray(0, n));
      expect(failure, `prefix length ${n}`).toBeNull();
    }
    // Only the full length is a cart.
    expect(decode(VALID).ok).toBe(true);
    expect(decode(VALID.subarray(0, VALID.length - 1)).ok).toBe(false);
  });

  it("survives single-byte damage at every offset of a real cart", () => {
    for (let at = 0; at < VALID.length; at++) {
      for (const mask of [0x01, 0x80, 0xff]) {
        const b = VALID.slice();
        b[at] = ((b[at] ?? 0) ^ mask) & 0xff;
        const failure = checkOne(b);
        expect(failure, `offset ${at} mask 0x${mask.toString(16)}`).toBeNull();
      }
    }
  });

  it("survives pathological sizes without allocating on the file's say-so", () => {
    const cases: Uint8Array[] = [
      new Uint8Array(0),
      new Uint8Array(1),
      new Uint8Array(HEADER_BYTES),
      new Uint8Array(HEADER_BYTES).fill(0xff),
      new Uint8Array(4 * 1024 * 1024).fill(0xff),
    ];
    // 64 MB with a valid header: the budget check must fire before any walk.
    const huge = new Uint8Array(64 * 1024 * 1024);
    for (let i = 0; i < 4; i++) huge[i] = MAGIC.charCodeAt(i);
    huge[4] = 1;
    writeU32le(huge, 8, 0xffffffff);
    writeU32le(huge, 12, 0xffffffff);
    cases.push(huge);

    const started = Date.now();
    for (const b of cases) expect(checkOne(b), hexdump(b, 16)).toBeNull();
    expect(Date.now() - started, "pathological sizes must be rejected in constant time").toBeLessThan(
      5000,
    );
  });
});

// --- the named acceptance cases -------------------------------------------

describe("M2 acceptance", () => {
  it("an unknown ancillary chunk decodes fine and round-trips byte for byte", () => {
    const payload = new Uint8Array([0x11, 0x22, 0x33]);
    const first = encode(validCart([chunk("zzzz", payload)]));
    const r = decode(first);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(getChunk(r.cart, "zzzz")).toEqual(payload);
    expect(encode(r.cart)).toEqual(first);
  });

  it("an unknown critical chunk is refused with a named error", () => {
    const r = decode(encode(validCart([chunk("ZZZZ", new Uint8Array([1]))])));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const code: CartErrorCode = r.error.code;
      expect(code).toBe("unknown-critical-chunk");
    }
  });
});
