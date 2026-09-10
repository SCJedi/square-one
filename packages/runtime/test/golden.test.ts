/**
 * The M1 acceptance test.
 *
 * Replays a committed conformance case through the real machine and asserts the
 * frame-hash chain matches, frame for frame. This is the test that has to pass
 * identically on Node, Chrome and Firefox -- the browser job in CI runs this
 * exact file, unmodified, in both engines.
 *
 * WHY THIS FILE READS NO BINARY FROM DISK
 * ---------------------------------------
 * A browser has no filesystem. Any `fs` call here would force a platform branch
 * into the harness, and a harness that runs different code on the engines it is
 * comparing cannot tell "the machine diverged" from "the harness diverged".
 *
 * So the fixture arrives two ways, both portable:
 *   - chain.txt through Vite's `?raw`, which resolves identically in both
 *   - the replay reconstructed from the seed, because gen-golden derives it from
 *     the console's own PRNG rather than from any outside entropy
 *
 * The committed replay.bin is still authoritative: a Node-only test below binds
 * the reconstruction to those bytes, so the two can never silently drift.
 */

import { describe, expect, it } from "vitest";

import { rngCreate, rngNext } from "@sq1/core";

import { createMachine } from "../src/machine";
import { gradientCart } from "../src/carts/gradient";
import { ChainHasher, firstDivergence, parseGolden } from "../src/hash";

import goldenText from "../../../conformance/cases/gradient-60/chain.txt?raw";

const INPUT_BYTES = 4;
const BUTTON_MASK = 0x3f;

/** Must stay identical to `generateReplay` in tools/gen-golden.ts. */
function reconstructReplay(seed: number, frames: number): Uint8Array {
  const rng = rngCreate(seed);
  const bytes = new Uint8Array(frames * INPUT_BYTES);
  for (let f = 0; f < frames; f++) {
    bytes[f * INPUT_BYTES] = rngNext(rng) & BUTTON_MASK;
  }
  return bytes;
}

function run(seed: number, frames: number, replay: Uint8Array) {
  const machine = createMachine(gradientCart);
  machine.boot(seed);

  const chain = new ChainHasher();
  const frameHashes: string[] = [];
  const input = new Uint8Array(INPUT_BYTES);

  for (let f = 0; f < frames; f++) {
    input.set(replay.subarray(f * INPUT_BYTES, (f + 1) * INPUT_BYTES));
    machine.tick(input);
    machine.present();
    frameHashes.push(chain.push(machine.ram));
  }
  return { frameHashes, chain: chain.digest };
}

const golden = parseGolden(goldenText);

describe("golden master: gradient-60", () => {
  it("parses the committed case", () => {
    expect(golden.name).toBe("gradient-60");
    expect(golden.frames).toBe(60);
    expect(golden.frameHashes).toHaveLength(60);
    expect(golden.chain).toMatch(/^[0-9a-f]{64}$/);
  });

  it("reproduces every frame hash and the chain", () => {
    const replay = reconstructReplay(golden.seed, golden.frames);
    const actual = run(golden.seed, golden.frames, replay);

    // Report the FIRST divergent frame rather than a wall of hashes. That number
    // plus the cart source is usually enough to find a desync in minutes.
    const at = firstDivergence(golden.frameHashes, actual.frameHashes);
    expect(
      at,
      at === -1
        ? ""
        : `diverged at frame ${at}\n` +
          `  expected ${golden.frameHashes[at]}\n` +
          `  actual   ${actual.frameHashes[at]}`,
    ).toBe(-1);

    expect(actual.chain).toBe(golden.chain);
  });

  it("is reproducible within a single engine: two runs agree", () => {
    const replay = reconstructReplay(golden.seed, golden.frames);
    const a = run(golden.seed, golden.frames, replay);
    const b = run(golden.seed, golden.frames, replay);
    expect(firstDivergence(a.frameHashes, b.frameHashes)).toBe(-1);
    expect(a.chain).toBe(b.chain);
  });

  it("would notice a desync: one flipped input byte changes the chain", () => {
    // Guard the guard. A golden test that passes no matter what the machine does
    // is worse than no test, because it reads as coverage.
    const replay = reconstructReplay(golden.seed, golden.frames);
    const tampered = replay.slice();
    const at30 = 30 * INPUT_BYTES;
    tampered[at30] = (tampered[at30] ?? 0) ^ 0x01;
    const actual = run(golden.seed, golden.frames, tampered);

    expect(actual.chain).not.toBe(golden.chain);
    const at = firstDivergence(golden.frameHashes, actual.frameHashes);
    expect(at).toBeGreaterThanOrEqual(0);
    expect(at).toBeLessThan(golden.frames);
  });
});

// The committed replay.bin is the contract; the reconstruction above is a
// convenience that must agree with it. Node only, because this is the one place
// the bytes on disk are the thing under test.
const isNode = typeof process !== "undefined" && process.versions?.node !== undefined;

describe.skipIf(!isNode)("golden master: committed replay.bin", () => {
  it("matches the seed-derived reconstruction byte for byte", async () => {
    const { readFileSync } = await import(/* @vite-ignore */ "node:fs");
    const { fileURLToPath } = await import(/* @vite-ignore */ "node:url");
    const path = fileURLToPath(
      new URL("../../../conformance/cases/gradient-60/replay.bin", import.meta.url),
    );
    const buf = readFileSync(path);
    const onDisk = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    const rebuilt = reconstructReplay(golden.seed, golden.frames);

    expect(onDisk.length).toBe(golden.frames * INPUT_BYTES);
    expect(Array.from(onDisk)).toEqual(Array.from(rebuilt));
  });
});
