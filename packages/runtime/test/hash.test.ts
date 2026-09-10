import { describe, it, expect } from "vitest";
import { sha256, toHex } from "@sq1/core";
import {
  frameHash,
  ChainHasher,
  chainOf,
  formatGolden,
  parseGolden,
  firstDivergence,
  type GoldenCase,
} from "../src/hash";

/*
 * These tests pin the chain definition, not just the code that implements it.
 *
 * The chain is the acceptance criterion for the whole milestone: Node, Chrome
 * and Firefox agree when they produce the same 60 numbers. That only means
 * anything if the numbers are fixed by something other than "whatever this
 * implementation currently returns", so the first two constants below are
 * written out in full. They were computed independently, with `node:crypto`,
 * from the definition in the header of hash.ts. If a refactor changes them, it
 * has changed the format of every golden file ever recorded.
 */

/** SHA-256 of 8192 zero bytes: the frame hash of a blank framebuffer. */
const BLANK_FRAME = "9f1dcbc35c350d6027f98be0f5c8b43b42ca52b7604459c0c42be3aa88913d47";

/** chain_0 for a run whose first frame is blank. */
const BLANK_CHAIN_1 = "94068caf52f63da8451530b482790e2dbb5c7a69acb1d2bcc263203e367ef849";

/** chain_1 for a run whose first two frames are blank. */
const BLANK_CHAIN_2 = "b25ae340d18bb950e2836926312263ecacdcf9cecd597bf8fb9e0444fb955beb";

/** 64 zero characters: the chain of a run with no frames. */
const ZERO_CHAIN = "0".repeat(64);

/** A machine-sized RAM with a recognisable pattern in it. */
function ram(fill: (i: number) => number, size = 0x4000): Uint8Array {
  const r = new Uint8Array(size);
  for (let i = 0; i < size; i++) r[i] = fill(i) & 0xff;
  return r;
}

describe("frameHash", () => {
  it("matches the published definition for a blank framebuffer", () => {
    expect(toHex(frameHash(new Uint8Array(0x4000)))).toBe(BLANK_FRAME);
  });

  it("is exactly SHA-256 of bytes 0x0000..0x1FFF", () => {
    const r = ram((i) => i * 31 + 7);
    expect(toHex(frameHash(r))).toBe(toHex(sha256(r.subarray(0, 0x2000))));
  });

  it("ignores everything above 0x1FFF", () => {
    const a = ram((i) => (i < 0x2000 ? i : 0x00));
    const b = ram((i) => (i < 0x2000 ? i : 0xff));
    expect(toHex(frameHash(a))).toBe(toHex(frameHash(b)));
  });

  it("notices the last framebuffer byte", () => {
    const a = new Uint8Array(0x4000);
    const b = new Uint8Array(0x4000);
    b[0x1fff] = 1;
    expect(toHex(frameHash(a))).not.toBe(toHex(frameHash(b)));
  });

  it("notices the first framebuffer byte", () => {
    const a = new Uint8Array(0x4000);
    const b = new Uint8Array(0x4000);
    b[0] = 1;
    expect(toHex(frameHash(a))).not.toBe(toHex(frameHash(b)));
  });

  it("accepts a RAM that is exactly the framebuffer", () => {
    expect(toHex(frameHash(new Uint8Array(0x2000)))).toBe(BLANK_FRAME);
  });

  it("refuses a RAM too small to hold a framebuffer", () => {
    expect(() => frameHash(new Uint8Array(0x1fff))).toThrow(/at least 8192/);
  });
});

describe("ChainHasher", () => {
  it("starts at the zero chain with no frames", () => {
    const h = new ChainHasher();
    expect(h.count).toBe(0);
    expect(h.digest).toBe(ZERO_CHAIN);
  });

  it("matches the published chain values for blank frames", () => {
    const h = new ChainHasher();
    const blank = new Uint8Array(0x4000);
    expect(h.push(blank)).toBe(BLANK_FRAME);
    expect(h.count).toBe(1);
    expect(h.digest).toBe(BLANK_CHAIN_1);
    expect(h.push(blank)).toBe(BLANK_FRAME);
    expect(h.count).toBe(2);
    expect(h.digest).toBe(BLANK_CHAIN_2);
  });

  it("returns the per-frame hash, which is not the chain", () => {
    const h = new ChainHasher();
    const fh = h.push(new Uint8Array(0x2000));
    expect(fh).toBe(BLANK_FRAME);
    expect(h.digest).not.toBe(fh);
  });

  it("is order-sensitive: the same frames in a different order chain differently", () => {
    const a = ram((i) => i);
    const b = ram((i) => i * 3);
    const ab = new ChainHasher();
    ab.push(a);
    ab.push(b);
    const ba = new ChainHasher();
    ba.push(b);
    ba.push(a);
    expect(ab.digest).not.toBe(ba.digest);
  });

  it("is prefix-committing: a prefix run matches the prefix of a longer one", () => {
    const frames = [ram((i) => i), ram((i) => i * 5), ram((i) => i ^ 0x5a)];
    const short = new ChainHasher();
    short.push(frames[0] as Uint8Array);
    short.push(frames[1] as Uint8Array);
    const long = new ChainHasher();
    const digestsAlong: string[] = [];
    for (const f of frames) {
      long.push(f);
      digestsAlong.push(long.digest);
    }
    expect(digestsAlong[1]).toBe(short.digest);
  });

  it("agrees with chainOf over the hashes it emitted", () => {
    const h = new ChainHasher();
    const hashes: string[] = [];
    for (let f = 0; f < 12; f++) hashes.push(h.push(ram((i) => i + f * 17)));
    expect(chainOf(hashes)).toBe(h.digest);
  });

  it("does not retain a reference to the RAM it was given", () => {
    const h1 = new ChainHasher();
    const r = ram((i) => i);
    const first = h1.push(r);
    r[0] = (r[0] as number) ^ 0xff; // mutate after pushing
    const h2 = new ChainHasher();
    const second = h2.push(r);
    expect(first).not.toBe(second);
  });

  it("chainOf of nothing is the zero chain", () => {
    expect(chainOf([])).toBe(ZERO_CHAIN);
  });

  it("chainOf rejects a malformed digest", () => {
    expect(() => chainOf(["nope"])).toThrow();
    expect(() => chainOf([BLANK_FRAME.toUpperCase()])).toThrow();
  });
});

/** A small but structurally complete case, built the way gen-golden builds one. */
function sampleCase(frames = 4, name = "sample-4", seed = 7): GoldenCase {
  const h = new ChainHasher();
  const frameHashes: string[] = [];
  for (let f = 0; f < frames; f++) frameHashes.push(h.push(ram((i) => i + f * 29 + seed)));
  return { name, seed, frames, frameHashes, chain: h.digest };
}

describe("golden file format", () => {
  it("round-trips a case through text and back", () => {
    const c = sampleCase();
    const parsed = parseGolden(formatGolden(c));
    expect(parsed).toEqual(c);
  });

  it("round-trips the text form byte for byte", () => {
    const text = formatGolden(sampleCase());
    expect(formatGolden(parseGolden(text))).toBe(text);
  });

  it("round-trips a zero-frame case", () => {
    const c: GoldenCase = { name: "empty", seed: 0, frames: 0, frameHashes: [], chain: ZERO_CHAIN };
    expect(parseGolden(formatGolden(c))).toEqual(c);
  });

  it("round-trips a 60-frame case, which is the acceptance size", () => {
    const c = sampleCase(60, "gradient-60", 1);
    const text = formatGolden(c);
    expect(text.split("\n")).toHaveLength(60 + 5 + 1); // header, name, seed, frames, 60, chain, ""
    expect(parseGolden(text)).toEqual(c);
  });

  it("writes LF-only text ending in a newline", () => {
    const text = formatGolden(sampleCase());
    expect(text).not.toContain("\r");
    expect(text.endsWith("\n")).toBe(true);
  });

  it("has a readable, greppable shape", () => {
    const lines = formatGolden(sampleCase(2, "shape-2", 3)).split("\n");
    expect(lines[0]).toBe("sq1-golden 1");
    expect(lines[1]).toBe("name shape-2");
    expect(lines[2]).toBe("seed 3");
    expect(lines[3]).toBe("frames 2");
    expect(lines[4]).toMatch(/^frame 0 [0-9a-f]{64}$/);
    expect(lines[5]).toMatch(/^frame 1 [0-9a-f]{64}$/);
    expect(lines[6]).toMatch(/^chain [0-9a-f]{64}$/);
    expect(lines[7]).toBe("");
  });

  it("refuses to format a case whose frame count disagrees with its list", () => {
    const c = sampleCase();
    expect(() => formatGolden({ ...c, frames: 3 })).toThrow(/frames says 3/);
  });

  it("refuses to format a bad name or seed", () => {
    const c = sampleCase();
    expect(() => formatGolden({ ...c, name: "has space" })).toThrow(/bad name/);
    expect(() => formatGolden({ ...c, seed: -1 })).toThrow(/uint32/);
    expect(() => formatGolden({ ...c, seed: 1.5 })).toThrow(/uint32/);
  });

  it("refuses to format a non-hex digest", () => {
    const c = sampleCase();
    expect(() => formatGolden({ ...c, chain: "xyz" })).toThrow(/hex/);
  });
});

describe("parseGolden rejects a damaged file", () => {
  const good = formatGolden(sampleCase());

  it("rejects a missing trailing newline", () => {
    expect(() => parseGolden(good.trimEnd())).toThrow(/end with a newline/);
  });

  it("rejects CRLF", () => {
    expect(() => parseGolden(good.replace(/\n/g, "\r\n"))).toThrow(/LF only/);
  });

  it("rejects a wrong header", () => {
    expect(() => parseGolden(good.replace("sq1-golden 1", "sq1-golden 2"))).toThrow(/bad header/);
  });

  it("rejects a frame index out of order", () => {
    expect(() => parseGolden(good.replace("frame 2 ", "frame 3 "))).toThrow(/expected frame 2/);
  });

  it("rejects a truncated file", () => {
    const lines = good.split("\n");
    lines.splice(5, 1);
    expect(() => parseGolden(lines.join("\n"))).toThrow();
  });

  it("rejects trailing junk", () => {
    expect(() => parseGolden(good + "extra\n")).toThrow(/trailing line/);
  });

  it("rejects a chain that does not match its frame list", () => {
    const c = sampleCase();
    const wrong = formatGolden({ ...c, chain: chainOf([...c.frameHashes].reverse()) });
    expect(() => parseGolden(wrong)).toThrow(/does not match the frame list/);
  });

  it("rejects a tampered frame hash, because the chain no longer follows", () => {
    const bad = good.replace(/^frame 1 .*$/m, `frame 1 ${BLANK_FRAME}`);
    expect(bad).not.toBe(good);
    expect(() => parseGolden(bad)).toThrow(/does not match the frame list/);
  });

  it("rejects an uppercase digest", () => {
    const c = sampleCase();
    const text = formatGolden(c).replace(c.chain, c.chain.toUpperCase());
    expect(() => parseGolden(text)).toThrow(/lowercase hex/);
  });
});

describe("firstDivergence", () => {
  const a = ["00", "11", "22", "33"];

  it("is -1 when the lists are identical", () => {
    expect(firstDivergence(a, [...a])).toBe(-1);
  });

  it("is -1 for two empty lists", () => {
    expect(firstDivergence([], [])).toBe(-1);
  });

  it("finds the first differing frame, not the last", () => {
    expect(firstDivergence(a, ["00", "11", "xx", "yy"])).toBe(2);
  });

  it("finds a difference at frame 0", () => {
    expect(firstDivergence(a, ["zz", "11", "22", "33"])).toBe(0);
  });

  it("treats a short run as diverging at its own length", () => {
    expect(firstDivergence(a, a.slice(0, 2))).toBe(2);
    expect(firstDivergence(a.slice(0, 2), a)).toBe(2);
  });

  it("treats an empty run against a non-empty one as diverging at 0", () => {
    expect(firstDivergence([], a)).toBe(0);
  });

  it("reports the real first divergence of two runs of a fake machine", () => {
    // Two runs that agree for 5 frames and then do not: exactly the shape of a
    // determinism bug, and the number the failure message has to print.
    const left = new ChainHasher();
    const right = new ChainHasher();
    const lh: string[] = [];
    const rh: string[] = [];
    for (let f = 0; f < 10; f++) {
      lh.push(left.push(ram((i) => i + f)));
      rh.push(right.push(ram((i) => i + f + (f >= 5 ? 1 : 0))));
    }
    expect(firstDivergence(lh, rh)).toBe(5);
    expect(left.digest).not.toBe(right.digest);
  });
});
