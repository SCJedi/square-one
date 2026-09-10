/**
 * Generator for a conformance case: a replay, and the frame-hash chain the
 * machine must produce from it.
 *
 * Run:
 *   npx vite-node packages/runtime/tools/gen-golden.ts
 *   npx vite-node packages/runtime/tools/gen-golden.ts -- --frames 120 --name gradient-120
 *   npx vite-node packages/runtime/tools/gen-golden.ts -- --check
 *
 * WHY vite-node AND NOT `node --experimental-strip-types`
 * -------------------------------------------------------
 * Every module in this repository imports its neighbours without a file
 * extension, which is what TypeScript's `bundler` module resolution wants and
 * what the whole source tree already does. Node's ESM loader does not resolve
 * extensionless specifiers, with or without type stripping, so bare Node cannot
 * load `../src/index` no matter how the import here is written -- the failure
 * is two modules deep, inside the machine's own imports. `vite-node` applies the
 * same resolution the tests and the player build use, so the tool runs the
 * exact code the conformance suite runs. That matters more than the launcher:
 * a generator that resolved modules differently from the runtime could mint a
 * golden file no runtime can reproduce.
 *
 * WHAT IT WRITES
 * --------------
 *   conformance/cases/<name>/seed.txt     the boot seed, decimal, one line
 *   conformance/cases/<name>/replay.bin   4 bytes per frame, one per player slot
 *   conformance/cases/<name>/chain.txt    the golden file (see hash.ts)
 *
 * The replay is a separate file from the chain because it is an INPUT, and an
 * input that lived inside the file recording the expected output could be
 * regenerated to match a broken run without anyone noticing. Keeping them apart
 * means `--check` compares a fixed input against a fixed expectation.
 *
 * WHERE THE DEFAULT INPUT COMES FROM
 * ----------------------------------
 * The console's own PRNG, seeded with the case seed: one 32-bit word per frame,
 * the low six bits of which become player 0's button mask. It is written to
 * replay.bin, so from then on the file is the contract and how it was produced
 * stops mattering. A hand-authored replay can be supplied with --replay.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { rngCreate, rngNext } from "@sq1/core";
import { createMachine } from "../src/machine";
import { gradientCart } from "../src/carts/gradient";
import { ChainHasher, formatGolden, parseGolden, firstDivergence } from "../src/hash";
import type { GoldenCase } from "../src/hash";

/** Bytes of input per frame: one button mask per player slot. */
const INPUT_BYTES = 4;

/** The six buttons a slot can hold: left, right, up, down, A, B. */
const BUTTON_MASK = 0x3f;

interface Options {
  name: string;
  seed: number;
  frames: number;
  replay: string | null;
  out: string | null;
  check: boolean;
}

/** The repository root, three directories above this file. */
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

function usage(): string {
  return [
    "Usage: vite-node packages/runtime/tools/gen-golden.ts -- [options]",
    "",
    "  --name <name>     case name and default directory  (default gradient-60)",
    "  --seed <n>        boot seed, uint32                 (default 1)",
    "  --frames <n>      frames to run                     (default 60)",
    "  --replay <path>   read input from this file instead of generating it",
    "  --out <dir>       output directory                  (default conformance/cases/<name>)",
    "  --check           compare against what is on disk; write nothing; exit 1 on mismatch",
    "",
  ].join("\n");
}

function parseArgs(argv: readonly string[]): Options {
  const o: Options = { name: "gradient-60", seed: 1, frames: 60, replay: null, out: null, check: false };
  // vite-node may leave the script path and a bare "--" in argv; neither is an
  // option, and dropping them here keeps the tool launcher-agnostic.
  const args = argv.filter((a) => a !== "--" && !a.endsWith("gen-golden.ts"));
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    const value = (): string => {
      const v = args[++i];
      if (v === undefined) throw new Error(`${a} needs a value\n\n${usage()}`);
      return v;
    };
    switch (a) {
      case "--name":
        o.name = value();
        break;
      case "--seed":
        o.seed = Number(value());
        break;
      case "--frames":
        o.frames = Number(value());
        break;
      case "--replay":
        o.replay = value();
        break;
      case "--out":
        o.out = value();
        break;
      case "--check":
        o.check = true;
        break;
      case "--help":
      case "-h":
        process.stdout.write(usage());
        process.exit(0);
      // eslint-disable-next-line no-fallthrough
      default:
        throw new Error(`unknown option ${JSON.stringify(a)}\n\n${usage()}`);
    }
  }
  if (!Number.isInteger(o.seed) || o.seed < 0 || o.seed > 0xffffffff) {
    throw new Error(`--seed must be a uint32, got ${o.seed}`);
  }
  if (!Number.isInteger(o.frames) || o.frames < 0) {
    throw new Error(`--frames must be a non-negative integer, got ${o.frames}`);
  }
  return o;
}

/**
 * The default replay: one PRNG word per frame, its low six bits driving player
 * slot 0. Slots 1..3 stay idle, because a one-player replay is the case every
 * cart supports and a four-player one would only be testing the input plumbing.
 */
function generateReplay(seed: number, frames: number): Uint8Array {
  const rng = rngCreate(seed);
  const bytes = new Uint8Array(frames * INPUT_BYTES);
  for (let f = 0; f < frames; f++) {
    bytes[f * INPUT_BYTES] = rngNext(rng) & BUTTON_MASK;
  }
  return bytes;
}

/** Read a replay file and check it covers exactly `frames` frames. */
function loadReplay(path: string, frames: number): Uint8Array {
  const buf = readFileSync(path);
  const bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  if (bytes.length !== frames * INPUT_BYTES) {
    throw new Error(
      `${path} holds ${bytes.length} bytes, which is ${bytes.length / INPUT_BYTES} frames, ` +
        `but --frames says ${frames}`,
    );
  }
  return bytes;
}

/** Run the cart and collect the chain. */
function runCase(opts: Options, replay: Uint8Array): GoldenCase {
  const machine = createMachine(gradientCart);
  machine.boot(opts.seed);

  const chain = new ChainHasher();
  const frameHashes: string[] = [];
  const input = new Uint8Array(INPUT_BYTES);

  for (let f = 0; f < opts.frames; f++) {
    input.set(replay.subarray(f * INPUT_BYTES, (f + 1) * INPUT_BYTES));
    machine.tick(input);
    // `present` is called even though the hash only covers RAM. It is a pure
    // read of the framebuffer, and running it here means a present() that
    // illegally wrote to RAM would change the golden chain and be caught, rather
    // than diverging only in the player.
    machine.present();
    frameHashes.push(chain.push(machine.ram));
  }

  return {
    name: opts.name,
    seed: opts.seed,
    frames: opts.frames,
    frameHashes,
    chain: chain.digest,
  };
}

function main(): void {
  const opts = parseArgs(process.argv.slice(2));
  const dir = opts.out ?? join(ROOT, "conformance", "cases", opts.name);

  const replay =
    opts.replay === null
      ? generateReplay(opts.seed, opts.frames)
      : loadReplay(opts.replay, opts.frames);

  const result = runCase(opts, replay);
  const text = formatGolden(result);

  if (opts.check) {
    const chainPath = join(dir, "chain.txt");
    if (!existsSync(chainPath)) {
      process.stderr.write(`no golden file at ${chainPath}; run without --check to create it\n`);
      process.exit(1);
    }
    const expected = parseGolden(readFileSync(chainPath, "utf8"));
    const at = firstDivergence(expected.frameHashes, result.frameHashes);
    if (at === -1 && expected.chain === result.chain) {
      process.stdout.write(`${opts.name}: ${result.frames} frames match, chain ${result.chain}\n`);
      return;
    }
    process.stderr.write(
      `${opts.name}: DIVERGED at frame ${at}\n` +
        `  expected ${expected.frameHashes[at] ?? "(no such frame)"}\n` +
        `  actual   ${result.frameHashes[at] ?? "(no such frame)"}\n` +
        `  expected chain ${expected.chain}\n` +
        `  actual chain   ${result.chain}\n`,
    );
    process.exit(1);
  }

  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "seed.txt"), `${opts.seed}\n`, "utf8");
  writeFileSync(join(dir, "replay.bin"), replay);
  writeFileSync(join(dir, "chain.txt"), text, "utf8");

  process.stdout.write(
    `${opts.name}: wrote ${result.frames} frames to ${dir}\n  chain ${result.chain}\n`,
  );
}

try {
  main();
} catch (e) {
  process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
}
