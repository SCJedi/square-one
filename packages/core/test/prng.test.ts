import { describe, it, expect } from "vitest";
import { rngCreate, rngNext, rnd, rndf, rngSave, rngLoad } from "../src/prng";

/*
 * No authoritative test vectors exist for xoshiro128**.
 *
 * The canonical source (https://prng.di.unimi.it/xoshiro128starstar.c, Blackman
 * and Vigna 2018) is a bare implementation and publishes no expected outputs,
 * and the third-party ports that do carry vectors carry their own seeding, so
 * agreeing with one of them would prove nothing about ours.
 *
 * So the reference here is an independent reimplementation in BigInt: the same
 * algorithm written a completely different way. It uses no Math.imul, no >>> 0,
 * no rotl helper built from shifts on int32 -- every operation is exact BigInt
 * arithmetic masked to 32 bits, so the two implementations share no primitive
 * that could be wrong in the same direction. If prng.ts and this disagree, one
 * of them is wrong; they cannot be wrong together by accident.
 */

const M32 = 0xffffffffn;

/** Rotate left within 32 bits, in exact BigInt arithmetic. */
function refRotl(x: bigint, k: bigint): bigint {
  return ((x << k) | (x >> (32n - k))) & M32;
}

type RefState = [bigint, bigint, bigint, bigint];

/** xoshiro128** next(), transcribed from the C reference. */
function refNext(s: RefState): bigint {
  const result = (refRotl((s[1] * 5n) & M32, 7n) * 9n) & M32;
  const t = (s[1] << 9n) & M32;
  s[2] = (s[2] ^ s[0]) & M32;
  s[3] = (s[3] ^ s[1]) & M32;
  s[1] = (s[1] ^ s[2]) & M32;
  s[0] = (s[0] ^ s[3]) & M32;
  s[2] = (s[2] ^ t) & M32;
  s[3] = refRotl(s[3], 11n);
  return result;
}

/** SplitMix32 finaliser, in BigInt. */
function refSplitmix32(z: bigint): bigint {
  let t = z & M32;
  t = ((t ^ (t >> 16n)) * 0x21f0aaadn) & M32;
  t = ((t ^ (t >> 15n)) * 0x735a2d97n) & M32;
  return (t ^ (t >> 15n)) & M32;
}

/** The seed expansion, in BigInt. */
function refCreate(seed: number): RefState {
  let z = BigInt(seed >>> 0);
  const out: bigint[] = [];
  for (let i = 0; i < 4; i++) {
    z = (z + 0x9e3779b9n) & M32;
    out.push(refSplitmix32(z));
  }
  return [out[0] as bigint, out[1] as bigint, out[2] as bigint, out[3] as bigint];
}

function toRefState(s: Uint32Array): RefState {
  return [
    BigInt(s[0] as number),
    BigInt(s[1] as number),
    BigInt(s[2] as number),
    BigInt(s[3] as number),
  ];
}

function clone(s: Uint32Array): Uint32Array {
  return Uint32Array.from(s);
}

describe("prng: rngCreate", () => {
  it("expands the seed exactly as the BigInt SplitMix32 reference does", () => {
    const seeds = [0, 1, 2, 42, 0x7fffffff, 0xffffffff, 0x9e3779b9, 123456789, -1, -42];
    for (const seed of seeds) {
      const got = rngCreate(seed);
      const want = refCreate(seed);
      for (let i = 0; i < 4; i++) {
        expect(BigInt(got[i] as number), `seed ${seed}, word ${i}`).toBe(want[i]);
      }
    }
  });

  it("never produces the all-zero state, which is xoshiro's fixed point", () => {
    for (const seed of [0, 1, 0xffffffff]) {
      const s = rngCreate(seed);
      expect(s.length).toBe(4);
      const anySet = (s[0] as number) | (s[1] as number) | (s[2] as number) | (s[3] as number);
      expect(anySet, `seed ${seed} produced an all-zero state`).not.toBe(0);
    }
    // And over a wide sweep of seeds, not just the three named ones.
    for (let seed = 0; seed < 20000; seed++) {
      const s = rngCreate(seed);
      if (((s[0] as number) | (s[1] as number) | (s[2] as number) | (s[3] as number)) === 0) {
        throw new Error(`rngCreate(${seed}) produced an all-zero state`);
      }
    }
  });

  it("a zero state would in fact be a fixed point (why the guard exists)", () => {
    const dead = new Uint32Array(4); // all zeros
    for (let i = 0; i < 10; i++) expect(rngNext(dead)).toBe(0);
  });

  it("gives independent generators the same sequence from the same seed", () => {
    const a = rngCreate(0xdeadbeef);
    const b = rngCreate(0xdeadbeef);
    for (let i = 0; i < 1000; i++) expect(rngNext(a)).toBe(rngNext(b));
  });

  it("gives different sequences for adjacent seeds", () => {
    const a = rngCreate(1);
    const b = rngCreate(2);
    let same = 0;
    for (let i = 0; i < 64; i++) if (rngNext(a) === rngNext(b)) same++;
    expect(same).toBeLessThan(4);
  });
});

describe("prng: rngNext", () => {
  it("matches the independent BigInt reference for 10,000 outputs", () => {
    for (const seed of [0, 1, 0xffffffff, 0x12345678]) {
      const s = rngCreate(seed);
      const ref = toRefState(s);
      for (let i = 0; i < 10000; i++) {
        const got = rngNext(s);
        const want = Number(refNext(ref));
        if (got !== want) {
          throw new Error(`seed ${seed}, output ${i}: rngNext = ${got}, reference = ${want}`);
        }
        // The state must track too, not just the output stream.
        for (let w = 0; w < 4; w++) {
          if (BigInt(s[w] as number) !== ref[w]) {
            throw new Error(
              `seed ${seed}, after output ${i}: state word ${w} = ${s[w]}, reference = ${ref[w]}`,
            );
          }
        }
      }
    }
  });

  it("returns unsigned 32-bit integers", () => {
    const s = rngCreate(7);
    for (let i = 0; i < 100000; i++) {
      const r = rngNext(s);
      if (!Number.isInteger(r) || r < 0 || r > 0xffffffff) {
        throw new Error(`rngNext returned ${r}, which is not a u32`);
      }
    }
  });

  it("sets every bit position at least once and clears it at least once", () => {
    const s = rngCreate(99);
    let ones = 0;
    let zeros = 0;
    for (let i = 0; i < 200; i++) {
      const r = rngNext(s);
      ones |= r;
      zeros |= ~r;
    }
    expect(ones >>> 0).toBe(0xffffffff);
    expect(zeros >>> 0).toBe(0xffffffff);
  });
});

describe("prng: rnd", () => {
  const PAIRS = process.env["SQ1_SLOW"] === "1" ? 500_000 : 50_000;

  it(`is exactly floor(r * n / 2^32) over ${PAIRS.toLocaleString("en-US")} (r, n) pairs`, () => {
    // n values chosen to include the extremes, powers of two (where the
    // scaling is exact and unbiased), and awkward primes near 2^31 where the
    // naive double formula loses bits.
    const FIXED_N = [
      1, 2, 3, 4, 5, 6, 7, 10, 16, 100, 255, 256, 1000, 65535, 65536, 65537,
      1000000, 0x40000000, 0x7ffffffe, 0x7fffffff, 2147483629, 1073741789,
    ];
    const s = rngCreate(0xc0ffee);
    const nPicker = rngCreate(0x5eed);
    let checked = 0;
    for (let i = 0; i < PAIRS; i++) {
      const n =
        i % 2 === 0
          ? // (i >> 1), not i: FIXED_N has an even length, so indexing it by an
            // always-even i would silently only ever reach its even entries.
            (FIXED_N[(i >> 1) % FIXED_N.length] as number)
          : // A uniform n in [1, 2^31): take 31 bits, force nonzero.
            ((rngNext(nPicker) >>> 1) || 1);

      // Peek at the word rnd is about to consume by running a clone one step.
      const peek = clone(s);
      const r = rngNext(peek);

      const got = rnd(s, n);
      const want = Number((BigInt(r) * BigInt(n)) >> 32n);
      if (got !== want) {
        throw new Error(
          `iteration ${i}: rnd(state, ${n}) = ${got} for r = ${r}, reference = ${want}`,
        );
      }
      // rnd must consume exactly one word, no more and no fewer.
      for (let w = 0; w < 4; w++) {
        if (s[w] !== peek[w]) {
          throw new Error(`iteration ${i}: rnd did not advance the state by exactly one step`);
        }
      }
      checked++;
    }
    expect(checked).toBe(PAIRS);
  });

  it("stays in [0, n) and never returns n or a negative", () => {
    const s = rngCreate(1234);
    for (const n of [1, 2, 3, 5, 6, 7, 128, 1000, 0x7fffffff]) {
      for (let i = 0; i < 20000; i++) {
        const v = rnd(s, n);
        if (!Number.isInteger(v) || v < 0 || v >= n) {
          throw new Error(`rnd(state, ${n}) returned ${v}, outside [0, ${n})`);
        }
      }
    }
  });

  it("rnd(s, 1) is always 0", () => {
    const s = rngCreate(5);
    for (let i = 0; i < 1000; i++) expect(rnd(s, 1)).toBe(0);
  });

  it("covers the full range for small n", () => {
    for (const n of [2, 3, 4, 5, 6, 7, 13]) {
      const s = rngCreate(0xabcdef);
      const seen = new Set<number>();
      for (let i = 0; i < 20000; i++) seen.add(rnd(s, n));
      expect(seen.size, `n = ${n} did not cover [0, ${n})`).toBe(n);
    }
  });

  it("is roughly uniform for a small n (a smoke test, not a battery)", () => {
    const n = 6;
    const draws = 600000;
    const counts = new Int32Array(n);
    const s = rngCreate(31337);
    for (let i = 0; i < draws; i++) {
      const v = rnd(s, n);
      counts[v] = (counts[v] as number) + 1;
    }
    const expected = draws / n;
    for (let k = 0; k < n; k++) {
      // +-2% is many standard deviations wide for 100k samples per bucket.
      expect(Math.abs((counts[k] as number) - expected) / expected).toBeLessThan(0.02);
    }
  });

  it("rejects an n outside [1, 2^31)", () => {
    const s = rngCreate(1);
    for (const bad of [0, -1, -100, 2147483648, 4294967296, 1.5, NaN, Infinity, -Infinity]) {
      expect(() => rnd(s, bad), `n = ${bad} should have thrown`).toThrow(/rnd: n must be an integer/);
    }
    // A rejected call must not have consumed a word.
    const before = clone(s);
    expect(() => rnd(s, 0)).toThrow();
    expect(Array.from(s)).toEqual(Array.from(before));
  });
});

describe("prng: rndf", () => {
  it("is the top 16 bits of the raw word, i.e. 16.16 in [0.0, 1.0)", () => {
    const s = rngCreate(0x1234);
    const peek = clone(s);
    for (let i = 0; i < 10000; i++) {
      const r = rngNext(peek);
      const f = rndf(s);
      expect(f).toBe(r >>> 16);
      // 16.16: 0 is 0.0 and 65536 would be 1.0, which must never appear.
      expect(f).toBeGreaterThanOrEqual(0);
      expect(f).toBeLessThan(65536);
    }
  });

  it("reaches both ends of [0.0, 1.0) over enough draws", () => {
    const s = rngCreate(2024);
    let lo = 65536;
    let hi = -1;
    for (let i = 0; i < 400000; i++) {
      const f = rndf(s);
      if (f < lo) lo = f;
      if (f > hi) hi = f;
    }
    expect(lo).toBeLessThan(64);
    expect(hi).toBeGreaterThan(65536 - 64);
  });
});

describe("prng: rngSave / rngLoad", () => {
  it("round-trips the state exactly", () => {
    const s = rngCreate(0xfeedface);
    for (let i = 0; i < 37; i++) rngNext(s); // land on an arbitrary state
    const buf = new Uint8Array(32);
    rngSave(s, buf, 0);
    const back = rngLoad(buf, 0);
    expect(Array.from(back)).toEqual(Array.from(s));
  });

  it("writes exactly 16 little-endian bytes and touches nothing else", () => {
    const s = rngLoad(new Uint8Array(16), 0);
    s[0] = 0x01020304;
    s[1] = 0x05060708;
    s[2] = 0x090a0b0c;
    s[3] = 0xfffefdfc;
    const buf = new Uint8Array(24).fill(0xaa);
    rngSave(s, buf, 4);
    expect(Array.from(buf.subarray(0, 4))).toEqual([0xaa, 0xaa, 0xaa, 0xaa]);
    expect(Array.from(buf.subarray(4, 20))).toEqual([
      0x04, 0x03, 0x02, 0x01, 0x08, 0x07, 0x06, 0x05, 0x0c, 0x0b, 0x0a, 0x09, 0xfc, 0xfd, 0xfe,
      0xff,
    ]);
    expect(Array.from(buf.subarray(20, 24))).toEqual([0xaa, 0xaa, 0xaa, 0xaa]);
    expect(Array.from(rngLoad(buf, 4))).toEqual(Array.from(s));
  });

  it("a restored state continues the identical sequence", () => {
    const s = rngCreate(2718281);
    for (let i = 0; i < 500; i++) rngNext(s);

    const buf = new Uint8Array(16);
    rngSave(s, buf, 0);

    const expected: number[] = [];
    for (let i = 0; i < 1000; i++) expected.push(rngNext(s));

    const restored = rngLoad(buf, 0);
    const actual: number[] = [];
    for (let i = 0; i < 1000; i++) actual.push(rngNext(restored));

    expect(actual).toEqual(expected);
  });

  it("round-trips at a nonzero offset, e.g. the state's home at 0x2100", () => {
    const mem = new Uint8Array(0x2200);
    const s = rngCreate(4242);
    rngSave(s, mem, 0x2100);
    expect(Array.from(rngLoad(mem, 0x2100))).toEqual(Array.from(s));
    for (let i = 0; i < 0x2100; i++) expect(mem[i]).toBe(0);
  });

  it("rejects offsets that would run off the end of the buffer", () => {
    const s = rngCreate(1);
    expect(() => rngSave(s, new Uint8Array(15), 0)).toThrow(/rngSave/);
    expect(() => rngSave(s, new Uint8Array(16), 1)).toThrow(/rngSave/);
    expect(() => rngSave(s, new Uint8Array(16), -1)).toThrow(/rngSave/);
    expect(() => rngLoad(new Uint8Array(15), 0)).toThrow(/rngLoad/);
    expect(() => rngLoad(new Uint8Array(16), 1)).toThrow(/rngLoad/);
    expect(() => rngLoad(new Uint8Array(16), -1)).toThrow(/rngLoad/);
  });
});
