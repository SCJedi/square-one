import { describe, expect, it } from "vitest";

import { sha256, toHex } from "@sq1/core";

import { ARENA_BYTES } from "../src/arena";
import {
  ChainHasher,
  chainOf,
  firstDivergence,
  formatGolden,
  parseGolden,
  stateHash,
} from "../src/hash";
import type { GoldenCase } from "../src/hash";
import { MAX_PLAYERS, createMachine, emptyInput } from "../src/sim";
import type { InputFrame, PrimeCart } from "../src/sim";

/**
 * A cart with enough state to notice a divergence: a position integrated with
 * the normative trigonometry, a counter drawn from the generator, and a
 * dependence on input. Every one of those is a different way for two machines to
 * disagree, and the chain has to catch all of them.
 */
const CART: PrimeCart = {
  boot(sim) {
    sim.mem.setFloat64(0, 1.25, true);
    sim.mem.setFloat64(8, 0.5, true);
  },
  tick(sim, input) {
    const x = sim.mem.getFloat64(0, true);
    const v = sim.mem.getFloat64(8, true);
    const a = sim.atan2(v, x);
    const push = ((input.buttons[0] as number) & 1) === 1 ? 0.125 : 0;
    sim.mem.setFloat64(0, x + sim.cos(a) * v + push, true);
    sim.mem.setFloat64(8, v + sim.sin(x) * 0.03125, true);
    sim.mem.setUint32(16, sim.rnd(1 << 24), true);
    sim.mem.setFloat64(24, sim.rndf(), true);
  },
  render() {},
};

function inputAt(i: number): InputFrame {
  const f = {
    buttons: new Uint16Array(MAX_PLAYERS),
    axes: new Int16Array(MAX_PLAYERS * 4),
    triggers: new Uint8Array(MAX_PLAYERS * 2),
    present: 1,
  };
  f.buttons[0] = i % 11 === 0 ? 1 : 0;
  f.axes[0] = (i * 997) % 32768;
  return f;
}

/** Run a case and return its per-tick hashes and chain. */
function run(seed: bigint, inputs: readonly InputFrame[]): { hashes: string[]; chain: string } {
  const m = createMachine(CART);
  m.boot(seed);
  const h = new ChainHasher();
  const hashes: string[] = [];
  for (const inp of inputs) {
    m.step(inp);
    hashes.push(h.push(m.arena.bytes));
  }
  return { hashes, chain: h.digest };
}

const ZERO32_HEX = "0".repeat(64);

// ---------------------------------------------------------------------------

describe("stateHash", () => {
  it("is SHA-256 of the whole arena, with nothing left out", () => {
    const a = new Uint8Array(ARENA_BYTES);
    a[ARENA_BYTES - 1] = 1;
    expect(toHex(stateHash(a))).toBe(toHex(sha256(a)));
  });

  it("refuses anything that is not an arena", () => {
    expect(() => stateHash(new Uint8Array(ARENA_BYTES - 1))).toThrow(/expected 1048576/);
    expect(() => stateHash(new Uint8Array(ARENA_BYTES + 1))).toThrow(/expected 1048576/);
  });

  it("notices a byte nothing will ever read", () => {
    // On Prime the arena IS the normative object, so scratch and padding count.
    // This is a stronger commitment than the small console's framebuffer hash,
    // and it is the commitment that makes an uninitialised struct field a bug
    // the conformance runner finds rather than one a player finds.
    const a = new Uint8Array(ARENA_BYTES);
    const b = new Uint8Array(ARENA_BYTES);
    b[ARENA_BYTES >> 1] = 1;
    expect(toHex(stateHash(a))).not.toBe(toHex(stateHash(b)));
  });
});

describe("the chain", () => {
  it("is ZERO32 for an empty run", () => {
    expect(new ChainHasher().digest).toBe(ZERO32_HEX);
    expect(chainOf([])).toBe(ZERO32_HEX);
    expect(new ChainHasher().count).toBe(0);
  });

  it("is prefix-committing, so a partial run compares against a prefix", () => {
    const h = new ChainHasher();
    const a = new Uint8Array(ARENA_BYTES);
    const partials: string[] = [];
    const hashes: string[] = [];
    for (let i = 0; i < 8; i++) {
      a[i] = i + 1;
      hashes.push(h.push(a));
      partials.push(h.digest);
    }
    for (let i = 0; i < 8; i++) {
      expect(chainOf(hashes.slice(0, i + 1))).toBe(partials[i]);
    }
    expect(h.count).toBe(8);
  });

  it("gives identical seeds and inputs identical chains", () => {
    const inputs = Array.from({ length: 120 }, (_, i) => inputAt(i));
    const a = run(1n, inputs);
    const b = run(1n, inputs);
    expect(a.chain).toBe(b.chain);
    expect(a.hashes).toEqual(b.hashes);
    expect(firstDivergence(a.hashes, b.hashes)).toBe(-1);
  });

  it("gives different seeds different chains", () => {
    const inputs = Array.from({ length: 60 }, (_, i) => inputAt(i));
    expect(run(1n, inputs).chain).not.toBe(run(2n, inputs).chain);
  });

  it("ignores an input byte the simulation never reads", () => {
    const base = Array.from({ length: 120 }, (_, i) => inputAt(i));
    const flipped = base.map((f, i) => {
      if (i !== 73) return f;
      const g = {
        buttons: f.buttons.slice(),
        axes: f.axes.slice(),
        triggers: f.triggers.slice(),
        present: f.present,
      };
      g.axes[0] = (g.axes[0] as number) ^ 1; // one bit, in one axis, on one tick
      return g as InputFrame;
    });

    const a = run(5n, base);
    const b = run(5n, flipped);
    // This cart never reads an axis, so the chain does NOT move -- and that is
    // the right answer, not a gap. The chain commits to simulation STATE, so an
    // input no simulation ever observes cannot change it. A conformance case
    // still replays the inputs it was recorded with; what this pins is that the
    // hash is not secretly a hash of the replay file.
    expect(a.chain).toBe(b.chain);
    expect(firstDivergence(a.hashes, b.hashes)).toBe(-1);
  });

  it("changes at exactly the tick an observed input changes", () => {
    const base = Array.from({ length: 120 }, (_, i) => inputAt(i));
    const flipped = base.map((f, i) => {
      if (i !== 73) return f;
      const g = {
        buttons: f.buttons.slice(),
        axes: f.axes.slice(),
        triggers: f.triggers.slice(),
        present: f.present,
      };
      g.buttons[0] = (g.buttons[0] as number) ^ 1; // the bit the cart DOES read
      return g as InputFrame;
    });

    const a = run(5n, base);
    const b = run(5n, flipped);
    expect(a.chain).not.toBe(b.chain);
    expect(firstDivergence(a.hashes, b.hashes)).toBe(73);
    // Everything before it is byte-identical: the divergence has one cause and
    // the chain says where.
    expect(a.hashes.slice(0, 73)).toEqual(b.hashes.slice(0, 73));
  });

  it("reports a run that stopped early as diverging at its own length", () => {
    const inputs = Array.from({ length: 60 }, (_, i) => inputAt(i));
    const full = run(9n, inputs).hashes;
    expect(firstDivergence(full, full.slice(0, 40))).toBe(40);
    expect(firstDivergence(full.slice(0, 40), full)).toBe(40);
  });

  it("notices a divergence the picture would have hidden", () => {
    // The generator drifts but the position does not. On the small console,
    // hashing the framebuffer, this run and its twin would agree. Here they do
    // not, because on Prime the simulation is the normative object.
    const quiet: PrimeCart = {
      boot: (sim) => sim.mem.setFloat64(0, 1, true),
      tick: (sim) => void sim.rnd(1000), // draws, writes nothing a renderer reads
      render() {},
    };
    const m1 = createMachine(quiet);
    const m2 = createMachine(quiet);
    m1.boot(1n);
    m2.boot(2n);
    const h1 = new ChainHasher();
    const h2 = new ChainHasher();
    for (let i = 0; i < 10; i++) {
      m1.step(emptyInput());
      m2.step(emptyInput());
      h1.push(m1.arena.bytes);
      h2.push(m2.arena.bytes);
    }
    expect(m1.arena.view.getFloat64(0x40, true)).toBe(m2.arena.view.getFloat64(0x40, true));
    expect(h1.digest).not.toBe(h2.digest);
  });
});

describe("the golden file format", () => {
  function caseOf(n: number): GoldenCase {
    const inputs = Array.from({ length: n }, (_, i) => inputAt(i));
    const r = run(42n, inputs);
    return { name: "prime-demo", seed: 42n, ticks: n, stateHashes: r.hashes, chain: r.chain };
  }

  it("round-trips exactly", () => {
    const c = caseOf(12);
    const text = formatGolden(c);
    expect(formatGolden(parseGolden(text))).toBe(text);
    expect(parseGolden(text)).toEqual(c);
  });

  it("looks the way the header says it does", () => {
    const text = formatGolden(caseOf(2));
    const lines = text.split("\n");
    expect(lines[0]).toBe("sq1p-golden 1");
    expect(lines[1]).toBe("name prime-demo");
    expect(lines[2]).toBe("seed 42");
    expect(lines[3]).toBe("ticks 2");
    expect(lines[4]).toMatch(/^tick 0 [0-9a-f]{64}$/);
    expect(lines[5]).toMatch(/^tick 1 [0-9a-f]{64}$/);
    expect(lines[6]).toMatch(/^chain [0-9a-f]{64}$/);
    expect(lines[7]).toBe("");
    expect(text.includes("\r")).toBe(false);
  });

  it("carries a u64 seed without rounding it", () => {
    // A seed past 2^53 is exactly where a number-typed field silently lies.
    const seed = 18446744073709551615n;
    const r = run(seed, [inputAt(0)]);
    const text = formatGolden({
      name: "big",
      seed,
      ticks: 1,
      stateHashes: r.hashes,
      chain: r.chain,
    });
    expect(text).toContain("seed 18446744073709551615");
    expect(parseGolden(text).seed).toBe(seed);
  });

  it("supports an empty run", () => {
    const text = formatGolden({
      name: "empty",
      seed: 0n,
      ticks: 0,
      stateHashes: [],
      chain: ZERO32_HEX,
    });
    expect(parseGolden(text).ticks).toBe(0);
  });

  it("refuses to emit a file that would not parse back", () => {
    const c = caseOf(3);
    expect(() => formatGolden({ ...c, name: "has space" })).toThrow(/bad name/);
    expect(() => formatGolden({ ...c, seed: -1n })).toThrow(/must be a u64/);
    expect(() => formatGolden({ ...c, seed: 1n << 64n })).toThrow(/must be a u64/);
    expect(() => formatGolden({ ...c, ticks: 2 })).toThrow(/ticks says 2/);
    expect(() => formatGolden({ ...c, chain: "nope" })).toThrow(/not a 64-character/);
  });

  it("refuses a golden whose chain and tick list disagree", () => {
    // A hand-edited assertion is worse than a failing one, because it passes.
    const c = caseOf(4);
    const text = formatGolden(c);
    const bad = text.replace(/^chain .*$/m, `chain ${"a".repeat(64)}`);
    expect(() => parseGolden(bad)).toThrow(/does not match the tick list/);
  });

  it("refuses CRLF, so a case generated on Windows equals one from Linux", () => {
    const text = formatGolden(caseOf(2)).replace(/\n/g, "\r\n");
    expect(() => parseGolden(text)).toThrow(/LF only/);
  });

  it("checks the redundant tick indices rather than trusting them", () => {
    const text = formatGolden(caseOf(4));
    expect(() => parseGolden(text.replace("tick 2 ", "tick 9 "))).toThrow(/expected tick 2/);
  });

  it("rejects a missing trailing newline, trailing junk and a bad header", () => {
    const text = formatGolden(caseOf(2));
    expect(() => parseGolden(text.slice(0, -1))).toThrow(/must end with a newline/);
    expect(() => parseGolden(text + "extra\n")).toThrow(/unexpected trailing line/);
    expect(() => parseGolden("sq1p-golden 2\n")).toThrow(/bad header/);
    expect(() => parseGolden("sq1-golden 1\n")).toThrow(/bad header/);
  });

  it("rejects a truncated file rather than reporting a short run", () => {
    const text = formatGolden(caseOf(4));
    const lines = text.split("\n");
    lines.splice(5, 2); // drop two tick lines, leave `ticks 4`
    expect(() => parseGolden(lines.join("\n"))).toThrow();
  });
});
