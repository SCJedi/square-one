import { describe, it, expect } from "vitest";
import { sha256, sha256Hex, toHex, fromHex, SHA256_BYTES } from "../src/sha256";

/*
 * SHA-256 has authoritative published vectors, so unlike the PRNG this file
 * does not need an independent reimplementation to have something to compare
 * against. The vectors below are the ones NIST publishes with FIPS 180-4 and
 * RFC 6234 republishes, quoted verbatim.
 *
 * The vectors alone are not enough, though: they exercise three message lengths
 * out of the infinitely many, and the bugs that actually occur in a hand-written
 * SHA-256 are padding-boundary bugs -- the block that is exactly full, the block
 * with 55 bytes, the block with 56, the length field that straddles two blocks.
 * So the second half of this file walks every length from 0 to 200 bytes and
 * compares against `node:crypto` as an oracle.
 *
 * Using node:crypto HERE is fine and is not the thing sha256.ts refuses to do.
 * The shipping code must be one implementation on every platform; a test may use
 * whatever independent authority the platform offers, and skips itself where the
 * authority is absent.
 */

const enc = new TextEncoder();
const bytes = (s: string): Uint8Array => enc.encode(s);

/** Is there a Node `crypto` module to compare against? */
const hasNodeCrypto =
  typeof process !== "undefined" && typeof process.versions?.node === "string";

/**
 * Import `node:crypto` without letting a browser bundler see the specifier.
 * The browser conformance run loads this same file, and a static specifier
 * would be resolved at transform time and fail the build before the skip could
 * take effect.
 */
interface NodeHash {
  update(d: Uint8Array): NodeHash;
  digest(encoding: string): string;
}

async function nodeCreateHash(): Promise<(d: Uint8Array) => string> {
  const id = "node:" + "crypto";
  const mod = (await import(/* @vite-ignore */ id)) as {
    createHash(alg: string): NodeHash;
  };
  return (d: Uint8Array) => mod.createHash("sha256").update(d).digest("hex");
}

describe("sha256 - published vectors", () => {
  it("hashes the empty message", () => {
    expect(sha256Hex(new Uint8Array(0))).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("hashes 'abc' (FIPS 180-4 B.1, one block)", () => {
    expect(sha256Hex(bytes("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("hashes the 448-bit two-block vector (FIPS 180-4 B.2)", () => {
    expect(sha256Hex(bytes("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"))).toBe(
      "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
    );
  });

  it("hashes the 896-bit vector (RFC 6234, three blocks)", () => {
    const m =
      "abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmno" +
      "ijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu";
    expect(m.length).toBe(112);
    expect(sha256Hex(bytes(m))).toBe(
      "cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1",
    );
  });

  it("hashes the pangram", () => {
    expect(sha256Hex(bytes("The quick brown fox jumps over the lazy dog"))).toBe(
      "d7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592",
    );
    // One-bit-of-input difference, to show the avalanche is real.
    expect(sha256Hex(bytes("The quick brown fox jumps over the lazy dog."))).toBe(
      "ef537f25c895bfa782526529a9b63d97aa631564d5d789c2b765448c8635fb6c",
    );
  });

  it.skipIf(process.env["SQ1_SLOW"] !== "1")(
    "hashes one million 'a' (FIPS 180-4 B.3) [slow]",
    () => {
      const m = new Uint8Array(1_000_000).fill(0x61);
      expect(sha256Hex(m)).toBe(
        "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0",
      );
    },
    120_000,
  );
});

describe("sha256 - shape", () => {
  it("returns 32 bytes", () => {
    const d = sha256(bytes("abc"));
    expect(d).toBeInstanceOf(Uint8Array);
    expect(d.length).toBe(SHA256_BYTES);
    expect(SHA256_BYTES).toBe(32);
  });

  it("returns 64 lowercase hex characters", () => {
    const h = sha256Hex(bytes("abc"));
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it("does not modify its input", () => {
    const m = bytes("abcdefghij");
    const copy = m.slice();
    sha256(m);
    expect(m).toEqual(copy);
  });

  it("hashes a view into a larger buffer, not the whole buffer", () => {
    const big = new Uint8Array(64);
    big.fill(0xff);
    big.set(bytes("abc"), 16);
    const view = big.subarray(16, 19);
    expect(sha256Hex(view)).toBe(sha256Hex(bytes("abc")));
  });

  it("returns a fresh array each call", () => {
    const a = sha256(bytes("abc"));
    const b = sha256(bytes("abc"));
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });
});

describe("toHex / fromHex", () => {
  it("round-trips every byte value", () => {
    const all = new Uint8Array(256);
    for (let i = 0; i < 256; i++) all[i] = i;
    const hex = toHex(all);
    expect(hex.length).toBe(512);
    expect(hex.slice(0, 8)).toBe("00010203");
    expect(hex.slice(-8)).toBe("fcfdfeff");
    expect(fromHex(hex)).toEqual(all);
  });

  it("round-trips the empty array", () => {
    expect(toHex(new Uint8Array(0))).toBe("");
    expect(fromHex("")).toEqual(new Uint8Array(0));
  });

  it("accepts uppercase on the way in", () => {
    expect(fromHex("DEADbeef")).toEqual(new Uint8Array([0xde, 0xad, 0xbe, 0xef]));
  });

  it("rejects odd length", () => {
    expect(() => fromHex("abc")).toThrow(/odd length/);
  });

  it("rejects non-hex characters", () => {
    expect(() => fromHex("zz")).toThrow(/bad hex/);
    expect(() => fromHex("ab cd")).toThrow();
    expect(() => fromHex("00g0")).toThrow(/bad hex/);
  });
});

describe.skipIf(!hasNodeCrypto)("sha256 - differential against node:crypto", () => {
  it("agrees at every length from 0 to 200 bytes", async () => {
    const oracle = await nodeCreateHash();
    const mismatches: number[] = [];
    for (let n = 0; n <= 200; n++) {
      const m = new Uint8Array(n);
      // A deterministic non-trivial fill: consecutive lengths must not be
      // prefixes of one another in a way that hides an off-by-one.
      for (let i = 0; i < n; i++) m[i] = (i * 37 + n * 11) & 0xff;
      if (sha256Hex(m) !== oracle(m)) mismatches.push(n);
    }
    expect(mismatches).toEqual([]);
  });

  it("agrees at the padding boundaries and across many blocks", async () => {
    const oracle = await nodeCreateHash();
    const lengths = [
      0, 1, 54, 55, 56, 57, 63, 64, 65, 111, 112, 119, 120, 127, 128, 129, 1000, 4096, 8192,
      8193, 65536,
    ];
    for (const n of lengths) {
      const m = new Uint8Array(n);
      for (let i = 0; i < n; i++) m[i] = (i ^ (i >>> 8)) & 0xff;
      expect(`${n}:${sha256Hex(m)}`).toBe(`${n}:${oracle(m)}`);
    }
  });

  it("agrees on a framebuffer-sized block of zeros", async () => {
    const oracle = await nodeCreateHash();
    const fb = new Uint8Array(0x2000);
    expect(sha256Hex(fb)).toBe(oracle(fb));
  });
});
