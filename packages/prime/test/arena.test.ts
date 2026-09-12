import { describe, expect, it } from "vitest";

import { ARENA_BYTES, createArena } from "../src/arena";

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

/** Fill an arena with reproducible noise, so a flipped byte has somewhere to hide. */
function noise(bytes: Uint8Array, seed: number): void {
  const rng = mulberry32(seed);
  const words = new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.length >>> 2);
  for (let i = 0; i < words.length; i++) words[i] = rng();
}

describe("the arena", () => {
  it("is one megabyte, and all three views are the same bytes", () => {
    expect(ARENA_BYTES).toBe(1 << 20);
    const a = createArena();
    expect(a.buf.byteLength).toBe(ARENA_BYTES);
    expect(a.bytes.length).toBe(ARENA_BYTES);
    expect(a.view.byteLength).toBe(ARENA_BYTES);

    a.view.setUint32(1024, 0xdeadbeef, false);
    expect(a.bytes[1024]).toBe(0xde);
    expect(a.bytes[1027]).toBe(0xef);
    a.bytes[4096] = 0x5a;
    expect(a.view.getUint8(4096)).toBe(0x5a);
  });

  it("starts zeroed", () => {
    const a = createArena();
    for (let i = 0; i < ARENA_BYTES; i++) {
      if (a.bytes[i] !== 0) throw new Error(`byte ${i} is ${a.bytes[i]}, expected 0`);
    }
  });

  it("is frozen, so nothing can park state on it", () => {
    const a = createArena();
    expect(Object.isFrozen(a)).toBe(true);
    const loose = a as unknown as Record<string, unknown>;
    try {
      loose["cache"] = 1;
    } catch {
      /* strict-mode TypeError is the preferred outcome */
    }
    expect(loose["cache"]).toBeUndefined();
  });
});

describe("snapshot and restore", () => {
  it("round-trips every byte", () => {
    const a = createArena();
    noise(a.bytes, 1);
    const snap = a.snapshot();
    noise(a.bytes, 2);
    a.restore(snap);
    expect(a.bytes).toEqual(snap);
  });

  it("takes a copy, not a view -- a later write must not reach a taken snapshot", () => {
    // The single most important property of a save state: it has to be the past.
    const a = createArena();
    a.bytes[7] = 1;
    const snap = a.snapshot();
    a.bytes[7] = 2;
    expect(snap[7]).toBe(1);
    expect(snap.buffer).not.toBe(a.buf);
  });

  it("restores into the same buffer, so every existing view stays valid", () => {
    const a = createArena();
    const held = a.view;
    const snap = a.snapshot();
    a.bytes[99] = 0xff;
    a.restore(snap);
    expect(held.getUint8(99)).toBe(0);
    expect(a.buf).toBe(held.buffer);
  });

  it("refuses a snapshot of the wrong length", () => {
    const a = createArena();
    expect(() => a.restore(new Uint8Array(ARENA_BYTES - 1))).toThrow(/expected 1048576/);
    expect(() => a.restore(new Uint8Array(ARENA_BYTES + 1))).toThrow(/expected 1048576/);
    expect(() => a.restore(new Uint8Array(0))).toThrow(/expected 1048576/);
  });
});

describe("seal and verify", () => {
  it("verifies an untouched arena", () => {
    const a = createArena();
    noise(a.bytes, 3);
    const t = a.seal();
    expect(a.verify(t)).toBe(true);
    expect(a.verify(t)).toBe(true); // and sealing is not destructive
  });

  it("catches a single flipped byte, anywhere, at any bit", () => {
    const a = createArena();
    noise(a.bytes, 4);
    const t = a.seal();
    const rng = mulberry32(5);
    // Every step of the seal is a bijection, so a difference in exactly one
    // 32-bit word can NEVER collide. These are samples of a guarantee, not a
    // probabilistic check.
    const offsets = [0, 1, 2, 3, 4, ARENA_BYTES - 1, ARENA_BYTES - 4, 1 << 19];
    for (let i = 0; i < 200; i++) offsets.push(rng() % ARENA_BYTES);
    for (const off of offsets) {
      const was = a.bytes[off] as number;
      for (let bit = 0; bit < 8; bit++) {
        a.bytes[off] = was ^ (1 << bit);
        if (a.verify(t)) throw new Error(`missed a flip of bit ${bit} at byte ${off}`);
      }
      a.bytes[off] = was;
      expect(a.verify(t)).toBe(true);
    }
  });

  it("catches the write a leaking render would make: one value, one word", () => {
    const a = createArena();
    const t = a.seal();
    a.view.setFloat64(4096, 0.5, true); // an interpolated position, smuggled out
    expect(a.verify(t)).toBe(false);
  });

  it("is a pure function of the bytes, not of how they got there", () => {
    const a = createArena();
    const b = createArena();
    noise(a.bytes, 6);
    b.restore(a.snapshot());
    expect(b.seal()).toBe(a.seal());
  });

  it("returns an unsigned 32-bit number", () => {
    const a = createArena();
    for (let i = 0; i < 32; i++) {
      noise(a.bytes, 100 + i);
      const t = a.seal();
      expect(Number.isInteger(t)).toBe(true);
      expect(t).toBeGreaterThanOrEqual(0);
      expect(t).toBeLessThanOrEqual(0xffffffff);
    }
  });

  it("costs a fraction of a millisecond on 1 MB", () => {
    // Measured at 0.33 ms per seal on this repository's Windows/Node runner, so
    // an armed `present` -- which seals twice -- costs about 0.65 ms: 4 per cent
    // of one core at 60 Hz, 9 at 144. The bound here is deliberately loose: this
    // is a budget check, not a benchmark, and a tight bound would be a flaky test
    // on a busy runner.
    const a = createArena();
    noise(a.bytes, 7);
    a.seal(); // warm the JIT
    const n = 20;
    const t0 = performance.now();
    for (let i = 0; i < n; i++) a.seal();
    const per = (performance.now() - t0) / n;
    expect(per).toBeLessThan(20);
  });
});
