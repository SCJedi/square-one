import { describe, expect, it } from "vitest";

import {
  RNG_BYTES,
  rnd,
  rndf,
  rngCreate,
  rngLoad,
  rngLoadInto,
  rngNext,
  rngSave,
} from "../src/prng";
import type { RngState } from "../src/prng";

/*
 * THE REFERENCE.
 *
 * prng.ts computes a 128-bit LCG and a 64-bit output function in 32-bit limbs,
 * and argues at every step that its partial products stay exact. This file does
 * not argue: it recomputes the same generator in BigInt, where 128-bit
 * arithmetic is one operator, and demands that every word agree.
 *
 * This is the highest-value test in the package. A limb carry that is wrong once
 * in 2^20 draws produces a generator that looks perfectly random, passes every
 * statistical test anyone would think to run, and desyncs a netplay session
 * twenty minutes in.
 */

const M64 = (1n << 64n) - 1n;
const M128 = (1n << 128n) - 1n;
const CM = 0xda942042e4dd58b5n;

class RefPcg {
  state: bigint;
  inc: bigint;

  constructor(state: bigint, inc: bigint) {
    this.state = state & M128;
    this.inc = inc & M128;
  }

  step(): void {
    this.state = (this.state * CM + this.inc) & M128;
  }

  /** DXSM, from the state BEFORE the step. */
  next64(): bigint {
    let hi = this.state >> 64n;
    const lo = this.state & M64 & M64 | 1n;
    hi ^= hi >> 32n;
    hi = (hi * CM) & M64;
    hi ^= hi >> 48n;
    hi = (hi * (lo & M64)) & M64;
    this.step();
    return hi;
  }
}

function refSplitmix64(z0: bigint): bigint {
  let z = z0 & M64;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & M64;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & M64;
  return (z ^ (z >> 31n)) & M64;
}

/** PCG's own srandom, seeded the way rngCreate documents. */
function refCreate(seed: bigint): RefPcg {
  let z = BigInt.asUintN(64, seed);
  const draw = (): bigint => {
    z = (z + 0x9e3779b97f4a7c15n) & M64;
    return refSplitmix64(z);
  };
  const a = draw();
  const b = draw();
  const c = draw();
  const d = draw();
  const initstate = (b << 64n) | a;
  const initseq = (d << 64n) | c;

  const r = new RefPcg(0n, ((initseq << 1n) | 1n) & M128);
  r.step();
  r.state = (r.state + initstate) & M128;
  r.step();
  return r;
}

/** Lemire's unbiased bounded draw, in BigInt. */
function refRnd(r: RefPcg, n: number): number {
  const N = BigInt(n);
  for (;;) {
    const x = r.next64();
    const m = x * N;
    const l = m & M64;
    if (l >= N) return Number(m >> 64n);
    const t = (1n << 64n) % N;
    if (l >= t) return Number(m >> 64n);
  }
}

function refRndf(r: RefPcg): number {
  return Number(r.next64() >> 11n) / 9007199254740992;
}

/** The reference's state as the eight little-endian words the arena holds. */
function refWords(r: RefPcg): number[] {
  const out: number[] = [];
  for (let i = 0; i < 4; i++) out.push(Number((r.state >> BigInt(32 * i)) & 0xffffffffn));
  for (let i = 0; i < 4; i++) out.push(Number((r.inc >> BigInt(32 * i)) & 0xffffffffn));
  return out;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1) >>> 0;
    t = (t ^ (t + Math.imul(t ^ (t >>> 7), t | 61))) >>> 0;
    return (t ^ (t >>> 14)) >>> 0;
  };
}

const SLOW = process.env["SQ1_SLOW"] === "1";

// ---------------------------------------------------------------------------

describe("rngCreate against a BigInt reference", () => {
  it("installs exactly the state PCG's srandom would", () => {
    const seeds: bigint[] = [
      0n,
      1n,
      2n,
      0xffffffffffffffffn,
      0x8000000000000000n,
      0x0123456789abcdefn,
      0xdeadbeefcafebaben,
    ];
    for (const seed of seeds) {
      expect(Array.from(rngCreate(seed))).toEqual(refWords(refCreate(seed)));
    }
  });

  it("reduces any bigint modulo 2^64 rather than rejecting it", () => {
    // A cart is booted with a u64; a host holding a wider or negative bigint must
    // get a defined answer, not a throw halfway through boot.
    expect(Array.from(rngCreate(-1n))).toEqual(Array.from(rngCreate(0xffffffffffffffffn)));
    expect(Array.from(rngCreate((1n << 64n) + 7n))).toEqual(Array.from(rngCreate(7n)));
  });

  it("gives unrelated streams to adjacent seeds", () => {
    // The point of the SplitMix64 expansion. Seeding (seed, 0, 0, 0) directly
    // would make these two sequences visibly related.
    const a = rngCreate(1n);
    const b = rngCreate(2n);
    let same = 0;
    for (let i = 0; i < 64; i++) if (rngNext(a) === rngNext(b)) same++;
    expect(same).toBe(0);
  });
});

describe("rngNext against a BigInt reference", () => {
  it("reproduces the DXSM output word for word, and the state with it", () => {
    const draws = SLOW ? 500_000 : 50_000;
    const s = rngCreate(0xa5a5a5a5n);
    const r = refCreate(0xa5a5a5a5n);
    for (let i = 0; i < draws; i++) {
      const got = rngNext(s);
      const want = Number(r.next64() >> 32n);
      if (got !== want) {
        throw new Error(`draw ${i}: got ${got}, reference says ${want}`);
      }
    }
    // The state has to match too, not only the outputs: a generator that happens
    // to agree on 500,000 words while drifting in its state is worse than one
    // that disagrees immediately, because it fails later and further away.
    expect(Array.from(s)).toEqual(refWords(r));
  });

  it("agrees from many different seeds, not one lucky one", () => {
    const seeds = SLOW ? 400 : 60;
    const perSeed = SLOW ? 500 : 200;
    const rng = mulberry32(0x1234);
    for (let k = 0; k < seeds; k++) {
      const seed = (BigInt(rng()) << 32n) | BigInt(rng());
      const s = rngCreate(seed);
      const r = refCreate(seed);
      for (let i = 0; i < perSeed; i++) {
        expect(rngNext(s)).toBe(Number(r.next64() >> 32n));
      }
    }
  });
});

describe("rnd against a BigInt reference", () => {
  it("matches Lemire's unbiased draw over many (state, n) pairs", () => {
    const pairs = SLOW ? 500_000 : 50_000;
    const s = rngCreate(99n);
    const r = refCreate(99n);
    const rng = mulberry32(0xbeef);
    // Bounds that exercise the interesting shapes: powers of two (where the
    // rejection region is empty), primes, one, and the top of the range.
    const bounds = [1, 2, 3, 6, 7, 10, 52, 100, 255, 256, 257, 1000, 65536, 1 << 20, 2147483647];
    for (let i = 0; i < pairs; i++) {
      const n = i % 40 === 0 ? (bounds[rng() % bounds.length] as number) : (rng() % 4096) + 1;
      const got = rnd(s, n);
      const want = refRnd(r, n);
      if (got !== want) throw new Error(`pair ${i} (n=${n}): got ${got}, reference says ${want}`);
    }
    expect(Array.from(s)).toEqual(refWords(r));
  });

  it("never returns a value outside [0, n)", () => {
    const s = rngCreate(5n);
    for (let i = 0; i < 20000; i++) {
      const n = (i % 1000) + 1;
      const v = rnd(s, n);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(n);
    }
  });

  it("is unbiased where the biased scaling would visibly fail", () => {
    // n = 3 * 2^62 does not divide 2^64, so plain scaling would over-represent
    // the low third by one part in three. A million draws distinguishes that
    // easily; this checks the rejection is actually wired up.
    const s = rngCreate(0x5eedn);
    const counts = [0, 0, 0];
    const N = SLOW ? 3_000_000 : 300_000;
    for (let i = 0; i < N; i++) {
      const k = rnd(s, 3);
      counts[k] = (counts[k] as number) + 1;
    }
    for (const c of counts) {
      expect(Math.abs(c / N - 1 / 3)).toBeLessThan(0.01);
    }
  });

  it("rejects an n outside [1, 2^31)", () => {
    const s = rngCreate(1n);
    expect(() => rnd(s, 0)).toThrow(/must be an integer/);
    expect(() => rnd(s, -1)).toThrow(/must be an integer/);
    expect(() => rnd(s, 2147483648)).toThrow(/must be an integer/);
    expect(() => rnd(s, 1.5)).toThrow(/must be an integer/);
    expect(() => rnd(s, NaN)).toThrow(/must be an integer/);
  });

  it("returns 0 for n = 1 and still consumes exactly one draw", () => {
    const a = rngCreate(4n);
    const b = rngCreate(4n);
    expect(rnd(a, 1)).toBe(0);
    rngNext(b);
    expect(Array.from(a)).toEqual(Array.from(b));
  });
});

describe("rndf against a BigInt reference", () => {
  it("matches the reference exactly", () => {
    const n = SLOW ? 500_000 : 50_000;
    const s = rngCreate(0x1234n);
    const r = refCreate(0x1234n);
    for (let i = 0; i < n; i++) {
      expect(rndf(s)).toBe(refRndf(r));
    }
  });

  it("stays in [0, 1) and lands on a multiple of 2^-53", () => {
    const s = rngCreate(8n);
    for (let i = 0; i < 20000; i++) {
      const v = rndf(s);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
      expect(Number.isInteger(v * 9007199254740992)).toBe(true);
    }
  });
});

describe("serialisation", () => {
  const arena = new DataView(new ArrayBuffer(256));

  it("round-trips every state exactly", () => {
    const rng = mulberry32(77);
    for (let k = 0; k < 200; k++) {
      const s = rngCreate((BigInt(rng()) << 32n) | BigInt(rng()));
      for (let i = 0; i < rng() % 50; i++) rngNext(s);
      rngSave(s, arena, 64);
      expect(Array.from(rngLoad(arena, 64))).toEqual(Array.from(s));
    }
  });

  it("writes little-endian, so a save moves between machines", () => {
    const s = rngCreate(0n);
    s.set([0x03020100, 0x07060504, 0x0b0a0908, 0x0f0e0d0c, 0, 0, 0, 0]);
    rngSave(s, arena, 0);
    const bytes = new Uint8Array(arena.buffer, 0, 16);
    expect(Array.from(bytes)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
  });

  it("resumes a bit-identical continuation after a restore", () => {
    const s = rngCreate(0xfeedn);
    for (let i = 0; i < 100; i++) rngNext(s);
    rngSave(s, arena, 32);
    const after = [];
    for (let i = 0; i < 100; i++) after.push(rngNext(s));

    const t = rngLoad(arena, 32);
    const again = [];
    for (let i = 0; i < 100; i++) again.push(rngNext(t));
    expect(again).toEqual(after);
  });

  it("does NOT repair a loaded state", () => {
    // An even increment is not a state PCG would ever produce, and quietly
    // fixing it would make a resumed replay diverge from the run that wrote it.
    const s: RngState = new Uint32Array(8);
    s.set([1, 2, 3, 4, 8, 0, 0, 0]); // inc is even
    rngSave(s, arena, 96);
    expect(Array.from(rngLoad(arena, 96))).toEqual([1, 2, 3, 4, 8, 0, 0, 0]);
  });

  it("refuses an offset that does not fit", () => {
    const s = rngCreate(1n);
    expect(() => rngSave(s, arena, 256 - RNG_BYTES + 1)).toThrow(/do not fit/);
    expect(() => rngSave(s, arena, -1)).toThrow(/do not fit/);
    expect(() => rngLoad(arena, 256)).toThrow(/do not fit/);
  });

  it("loads into an existing state without allocating a new one", () => {
    const dst: RngState = new Uint32Array(8);
    const s = rngCreate(0xabcn);
    rngSave(s, arena, 128);
    rngLoadInto(dst, arena, 128);
    expect(Array.from(dst)).toEqual(Array.from(s));
  });
});

describe("determinism", () => {
  it("gives two generators with the same seed the same stream, forever", () => {
    const a = rngCreate(0x1122334455667788n);
    const b = rngCreate(0x1122334455667788n);
    for (let i = 0; i < 10000; i++) {
      expect(rnd(a, 1000)).toBe(rnd(b, 1000));
      expect(rndf(a)).toBe(rndf(b));
      expect(rngNext(a)).toBe(rngNext(b));
    }
  });

  it("keeps every draw a pure function of the 32 bytes of state", () => {
    // The limb primitives use module-level scratch. If any of it leaked between
    // calls, interleaving two generators would change their outputs.
    const a = rngCreate(1n);
    const solo: number[] = [];
    for (let i = 0; i < 500; i++) solo.push(rngNext(a));

    const b = rngCreate(1n);
    const noise = rngCreate(999n);
    const woven: number[] = [];
    for (let i = 0; i < 500; i++) {
      rnd(noise, 37);
      rndf(noise);
      woven.push(rngNext(b));
      rngNext(noise);
    }
    expect(woven).toEqual(solo);
  });
});
