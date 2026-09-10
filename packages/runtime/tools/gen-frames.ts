/**
 * Generator for the reference-frames conformance case: ten PNGs a person can
 * look at, and the frame-hash chain a machine has to reproduce.
 *
 * Run:
 *   npx vite-node packages/runtime/tools/gen-frames.ts
 *   npx vite-node packages/runtime/tools/gen-frames.ts -- --check
 *
 * `vite-node` rather than bare `node`, for the reason gen-golden.ts gives at
 * length: the modules here import their neighbours without file extensions, and
 * a generator that resolved modules differently from the runtime could mint an
 * artifact the runtime cannot reproduce.
 *
 * WHAT IT WRITES, AND WHY BOTH
 * ----------------------------
 *   conformance/cases/reference-frames/seed.txt   the boot seed
 *   conformance/cases/reference-frames/000.png    frame 0, as a picture
 *   ...                                           through 009.png
 *   conformance/cases/reference-frames/chain.txt  the golden file (see hash.ts)
 *
 * The chain is the machine-level contract: 8192 packed bytes per frame, hashed.
 * The PNGs are the same ten frames after the palette, and they exist for the
 * moment the chain goes red -- which is the moment a hash stops being useful and
 * a picture starts. reference-frames.test.ts checks BOTH, so the pictures can
 * never quietly stop being pictures of the frames they are named after.
 *
 * REGENERATION IS BYTE-IDENTICAL. The cart takes no input, the encoder has no
 * timestamps and no compression heuristics, and the frames are written in order.
 * `--check` re-renders and compares without writing, which is what CI runs.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createMachine } from "../src/machine";
import { referenceCart } from "../src/carts/reference";
import { ChainHasher, formatGolden, parseGolden, firstDivergence } from "../src/hash";
import { SCREEN_H, SCREEN_W } from "../src/memory";
import { encodePng } from "./png";

/** The case, fixed. Ten frames is enough to catch an animation that stalls. */
const NAME = "reference-frames";
const SEED = 1;
const FRAMES = 10;

/** The repository root, three directories above this file. */
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/** `3` -> `003.png`. Fixed width so the directory sorts the way it reads. */
function frameFile(i: number): string {
  return `${String(i).padStart(3, "0")}.png`;
}

interface Rendered {
  chainText: string;
  pngs: Uint8Array[];
}

function render(): Rendered {
  const machine = createMachine(referenceCart);
  machine.boot(SEED);

  const chain = new ChainHasher();
  const frameHashes: string[] = [];
  const pngs: Uint8Array[] = [];
  const input = new Uint8Array(4); // the cart reads no input; this stays zero

  for (let f = 0; f < FRAMES; f++) {
    machine.tick(input);
    machine.present();
    frameHashes.push(chain.push(machine.ram));
    pngs.push(encodePng(machine.rgba, SCREEN_W, SCREEN_H));
  }

  return {
    chainText: formatGolden({
      name: NAME,
      seed: SEED,
      frames: FRAMES,
      frameHashes,
      chain: chain.digest,
    }),
    pngs,
  };
}

function sameBytes(a: Uint8Array, b: Uint8Array): number {
  if (a.length !== b.length) return Math.min(a.length, b.length);
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return i;
  return -1;
}

function main(): void {
  const check = process.argv.includes("--check");
  const dir = join(ROOT, "conformance", "cases", NAME);
  const result = render();

  if (check) {
    const chainPath = join(dir, "chain.txt");
    if (!existsSync(chainPath)) {
      process.stderr.write(`no golden file at ${chainPath}; run without --check to create it\n`);
      process.exit(1);
    }
    const expected = parseGolden(readFileSync(chainPath, "utf8"));
    const actual = parseGolden(result.chainText);
    const at = firstDivergence(expected.frameHashes, actual.frameHashes);
    if (at !== -1 || expected.chain !== actual.chain) {
      process.stderr.write(
        `${NAME}: DIVERGED at frame ${at}\n` +
          `  expected ${expected.frameHashes[at] ?? "(no such frame)"}\n` +
          `  actual   ${actual.frameHashes[at] ?? "(no such frame)"}\n` +
          `  look at ${join(dir, frameFile(at < 0 ? 0 : at))}\n`,
      );
      process.exit(1);
    }
    for (let f = 0; f < FRAMES; f++) {
      const path = join(dir, frameFile(f));
      const onDisk = new Uint8Array(readFileSync(path));
      const differsAt = sameBytes(onDisk, result.pngs[f] as Uint8Array);
      if (differsAt !== -1) {
        process.stderr.write(`${NAME}: ${frameFile(f)} differs at byte ${differsAt}\n`);
        process.exit(1);
      }
    }
    process.stdout.write(`${NAME}: ${FRAMES} frames and ${FRAMES} PNGs match\n`);
    return;
  }

  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "seed.txt"), `${SEED}\n`, "utf8");
  for (let f = 0; f < FRAMES; f++) {
    writeFileSync(join(dir, frameFile(f)), result.pngs[f] as Uint8Array);
  }
  writeFileSync(join(dir, "chain.txt"), result.chainText, "utf8");
  process.stdout.write(`${NAME}: wrote ${FRAMES} frames and ${FRAMES} PNGs to ${dir}\n`);
}

try {
  main();
} catch (e) {
  process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
}
