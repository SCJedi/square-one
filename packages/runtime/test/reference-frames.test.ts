/**
 * The M4 acceptance case: ten frames of the reference cart, checked two ways.
 *
 * WHICH COMPARISON, AND WHY BOTH
 * ------------------------------
 * The brief offered a choice -- decode the committed PNGs, or compare the hash
 * chain and keep the PNGs as the human-readable artifact. This file does both,
 * because each one alone leaves a hole the other closes:
 *
 *   THE CHAIN is the contract. It is 8192 packed bytes per frame, hashed with
 *   SHA-256 the way every other conformance case is, so a divergence here is
 *   comparable with a divergence anywhere else and bisects the same way. It is
 *   also the only comparison that would survive a change of palette format.
 *
 *   THE PIXELS are the point. A chain says "frame 4 changed" and stops. The
 *   whole reason ten PNGs are in the repository is that a person can open 004.png
 *   and SEE that the arrow sprite stopped flipping. That is only true while the
 *   PNGs really are pictures of the frames the machine renders -- and a PNG
 *   nobody decodes is a PNG that can rot into a picture of last month's
 *   rasterizer while a green chain says everything is fine.
 *
 * So: the chain proves the machine still computes the same frames, and the
 * decode proves the pictures still show them. The second is what makes the first
 * debuggable, and it costs one small reader for this repository's own encoder.
 *
 * Node only. A browser has no filesystem, and unlike the gradient case these
 * fixtures are binary, so there is no `?raw` path that would work in both. The
 * cross-engine claim is carried by golden.test.ts, which is where it belongs;
 * this case is about the rasterizer, not about the engine.
 */

import { describe, expect, it } from "vitest";

import { referenceCart } from "../src/carts/reference";
import { ChainHasher, firstDivergence, parseGolden } from "../src/hash";
import { createMachine } from "../src/machine";
import { SCREEN_H, SCREEN_W } from "../src/memory";
import { decodePng, encodePng } from "../tools/png";

const NAME = "reference-frames";
const SEED = 1;
const FRAMES = 10;

const isNode = typeof process !== "undefined" && process.versions?.node !== undefined;

/** `3` -> `003.png`. Must agree with tools/gen-frames.ts. */
function frameFile(i: number): string {
  return `${String(i).padStart(3, "0")}.png`;
}

interface Rendered {
  frameHashes: string[];
  chain: string;
  rgba: Uint32Array[];
  pngs: Uint8Array[];
}

/** Exactly what gen-frames.ts does, so the two cannot drift apart. */
function render(): Rendered {
  const machine = createMachine(referenceCart);
  machine.boot(SEED);

  const chain = new ChainHasher();
  const frameHashes: string[] = [];
  const rgba: Uint32Array[] = [];
  const pngs: Uint8Array[] = [];
  const input = new Uint8Array(4);

  for (let f = 0; f < FRAMES; f++) {
    machine.tick(input);
    machine.present();
    frameHashes.push(chain.push(machine.ram));
    rgba.push(machine.rgba.slice());
    pngs.push(encodePng(machine.rgba, SCREEN_W, SCREEN_H));
  }
  return { frameHashes, chain: chain.digest, rgba, pngs };
}

async function readCase(): Promise<{ chainText: string; files: Uint8Array[] }> {
  const { readFileSync } = await import(/* @vite-ignore */ "node:fs");
  const { fileURLToPath } = await import(/* @vite-ignore */ "node:url");
  const dir = fileURLToPath(new URL(`../../../conformance/cases/${NAME}/`, import.meta.url));
  const files: Uint8Array[] = [];
  for (let f = 0; f < FRAMES; f++) {
    files.push(new Uint8Array(readFileSync(dir + frameFile(f))));
  }
  return { chainText: readFileSync(dir + "chain.txt", "utf8"), files };
}

describe.skipIf(!isNode)("conformance: reference-frames", () => {
  it("reproduces the committed hash chain, frame for frame", async () => {
    const { chainText } = await readCase();
    const golden = parseGolden(chainText);
    expect(golden.name).toBe(NAME);
    expect(golden.seed).toBe(SEED);
    expect(golden.frames).toBe(FRAMES);

    const actual = render();
    const at = firstDivergence(golden.frameHashes, actual.frameHashes);
    expect(
      at,
      at === -1
        ? ""
        : `diverged at frame ${at}\n` +
          `  expected ${golden.frameHashes[at]}\n` +
          `  actual   ${actual.frameHashes[at]}\n` +
          `  open conformance/cases/${NAME}/${frameFile(at)} and compare it with the screen`,
    ).toBe(-1);
    expect(actual.chain).toBe(golden.chain);
  });

  it("regenerates the PNGs byte for byte", async () => {
    const { files } = await readCase();
    const actual = render();
    for (let f = 0; f < FRAMES; f++) {
      const want = files[f] as Uint8Array;
      const got = actual.pngs[f] as Uint8Array;
      expect(got.length, `${frameFile(f)} length`).toBe(want.length);
      let firstDiff = -1;
      for (let i = 0; i < want.length; i++) {
        if (want[i] !== got[i]) {
          firstDiff = i;
          break;
        }
      }
      expect(firstDiff, `${frameFile(f)} differs at byte ${firstDiff}`).toBe(-1);
    }
  });

  it("the committed PNGs really are pictures of those frames", async () => {
    // Decoded and compared pixel by pixel against what `present()` produces.
    // This is the assertion that keeps the images worth opening.
    const { files } = await readCase();
    const actual = render();
    for (let f = 0; f < FRAMES; f++) {
      const img = decodePng(files[f] as Uint8Array);
      expect(img.width).toBe(SCREEN_W);
      expect(img.height).toBe(SCREEN_H);
      const want = actual.rgba[f] as Uint32Array;
      expect(img.rgba.length).toBe(want.length);
      for (let i = 0; i < want.length; i++) {
        if (img.rgba[i] !== want[i]) {
          const x = i % SCREEN_W;
          const y = (i / SCREEN_W) | 0;
          throw new Error(
            `${frameFile(f)}: pixel ${x},${y} is ${(img.rgba[i] as number).toString(16)}, ` +
              `the machine renders ${(want[i] as number).toString(16)}`,
          );
        }
      }
    }
  });

  it("is ten DIFFERENT pictures, so a stalled animation cannot pass", () => {
    // Guard the guard. A cart that drew the same frame ten times would satisfy
    // every assertion above and prove nothing about `frame()`.
    const actual = render();
    expect(new Set(actual.frameHashes).size).toBe(FRAMES);
  });

  it("would notice a broken primitive: one changed pixel changes the chain", async () => {
    const { chainText } = await readCase();
    const golden = parseGolden(chainText);
    const machine = createMachine(referenceCart);
    machine.boot(SEED);
    const chain = new ChainHasher();
    const hashes: string[] = [];
    const input = new Uint8Array(4);
    for (let f = 0; f < FRAMES; f++) {
      machine.tick(input);
      // One nibble, on one frame. noUncheckedIndexedAccess makes `^=` on an
      // element an error, so the read is spelled out.
      if (f === 4) machine.ram[0x0400] = (machine.ram[0x0400] as number) ^ 0x01;
      hashes.push(chain.push(machine.ram));
    }
    expect(chain.digest).not.toBe(golden.chain);
    expect(firstDivergence(golden.frameHashes, hashes)).toBe(4);
  });

  it("round-trips any frame through the encoder and back unchanged", () => {
    // The reader is only trustworthy as a check on the writer if it is not the
    // same mistake twice; this at least pins that they agree on every pixel of
    // a real frame, including the 0x00 and 0xff channel values at the edges.
    const actual = render();
    for (let f = 0; f < FRAMES; f++) {
      const img = decodePng(actual.pngs[f] as Uint8Array);
      expect(Array.from(img.rgba)).toEqual(Array.from(actual.rgba[f] as Uint32Array));
    }
  });

  it("rejects a PNG it did not write, rather than misreading one", () => {
    expect(() => decodePng(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toThrow(/not a PNG/);
    const good = encodePng(new Uint32Array(4), 2, 2);
    const bad = good.slice();
    // IHDR body starts at byte 16; its 10th byte is the colour type. 6 -> 4
    // (greyscale with alpha) is a legal PNG this reader must refuse rather than
    // misread.
    bad[16 + 9] = 4;
    expect(() => decodePng(bad)).toThrow();
  });
});
