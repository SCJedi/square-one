/**
 * The frame-hash chain: how a Square One run is compared across engines.
 *
 * THE CONTRACT (normative)
 * ------------------------
 * For a run of N frames, with `ram` the machine's memory at the END of each
 * tick -- after `tick()` has returned and before anything the host does with
 * the result:
 *
 *     frameHash_i = SHA-256( ram[0x0000 .. 0x1FFF] )        // 8192 bytes
 *     chain_0     = SHA-256( ZERO32 || frameHash_0 )
 *     chain_i     = SHA-256( chain_{i-1} || frameHash_i )   // i >= 1
 *
 * where `||` is byte concatenation, ZERO32 is 32 zero bytes, and every hash is
 * the raw 32-byte digest -- never its hex form. The chain of an empty run is
 * ZERO32 itself.
 *
 * Only the framebuffer is hashed, not the whole of RAM. The framebuffer is what
 * the player sees, and it is downstream of everything else: a divergence in the
 * PRNG state, a sprite table or an entity's position that never reaches a pixel
 * has, by definition, not changed the game. Hashing all of RAM would also make
 * every scratch byte and every uninitialised padding byte normative, which
 * would freeze implementation details that ought to stay free.
 *
 * WHY BOTH A PER-FRAME LIST AND A SINGLE CHAIN
 * --------------------------------------------
 * The chain answers "did this run match?" in one comparison, which is what a CI
 * gate wants. The per-frame list answers "where did it stop matching?", which is
 * the only question worth asking once the answer to the first is no. Determinism
 * drift is silent and cumulative; the frame number of the first divergence is
 * what turns a red build into a bisectable bug. Keeping only the chain would
 * save 60 lines of text per case and cost the ability to debug it.
 *
 * The chain is a chain rather than a hash of the concatenated list because a
 * chain is prefix-committing: chain_i depends on every frame up to i, so a
 * partial run can be compared against a prefix of a golden file without
 * recomputing anything.
 *
 * THE ON-DISK FORMAT
 * ------------------
 * Line-oriented ASCII, LF only, one trailing newline. A golden file is compared
 * and diffed by humans and by `git`, so it is text, and CRLF is not permitted
 * because the same case generated on Windows and on Linux must be byte-equal.
 *
 *     sq1-golden 1
 *     name gradient-60
 *     seed 1
 *     frames 60
 *     frame 0 <64 lowercase hex>
 *     frame 1 <64 lowercase hex>
 *     ...
 *     frame 59 <64 lowercase hex>
 *     chain <64 lowercase hex>
 *
 * The frame index is written out rather than implied by line position so that a
 * diff hunk in the middle of a 600-frame file still says which frame it is.
 * `parseGolden` requires the indices to be 0..frames-1 in order, so the
 * redundancy is checked rather than decorative.
 */

import { sha256, toHex } from "@sq1/core";

/** First byte of the framebuffer in the machine's address space. */
const FB_BASE = 0x0000;

/** Framebuffer size in bytes: 128 x 128 pixels at 4 bits each, two pixels per byte. */
const FB_BYTES = 0x2000;

/** 32 zero bytes: the seed of the chain, and the chain value of an empty run. */
const ZERO32 = new Uint8Array(32);

/**
 * SHA-256 of the framebuffer region of `ram`. Returns the raw 32-byte digest.
 *
 * Hashes a view, never a copy, so this stays cheap enough to run on every frame
 * of every conformance case.
 */
export function frameHash(ram: Uint8Array): Uint8Array {
  if (ram.length < FB_BASE + FB_BYTES) {
    throw new Error(
      `frameHash: ram is ${ram.length} bytes, needs at least ${FB_BASE + FB_BYTES}`,
    );
  }
  return sha256(ram.subarray(FB_BASE, FB_BASE + FB_BYTES));
}

/**
 * The running chain over a sequence of frames.
 *
 * Feed it the machine's RAM at the end of each tick, in order. `digest` is the
 * chain value after everything pushed so far, so it is meaningful mid-run: a
 * host can compare it against the same prefix of a golden file and stop at the
 * first frame that disagrees rather than running to the end.
 */
export class ChainHasher {
  /** Current chain value, 32 raw bytes. Starts at ZERO32. */
  #chain: Uint8Array = ZERO32.slice();
  #count = 0;
  /** Scratch for `chain_{i-1} || frameHash_i`, reused to avoid per-frame garbage. */
  readonly #pair = new Uint8Array(64);

  /**
   * Hash one frame and advance the chain.
   *
   * @param ram the machine's memory at the end of the tick
   * @returns that frame's hash, as 64 lowercase hex characters
   */
  push(ram: Uint8Array): string {
    const fh = frameHash(ram);
    this.#pair.set(this.#chain, 0);
    this.#pair.set(fh, 32);
    this.#chain = sha256(this.#pair);
    this.#count++;
    return toHex(fh);
  }

  /** The chain value over every frame pushed so far, as 64 lowercase hex characters. */
  get digest(): string {
    return toHex(this.#chain);
  }

  /** How many frames have been pushed. */
  get count(): number {
    return this.#count;
  }
}

/**
 * The chain value implied by a list of per-frame hex hashes.
 *
 * Exists so a parsed golden file can be checked for internal consistency: its
 * `chain` field must be exactly this. A golden whose chain and frame list
 * disagree has been hand-edited, and silently trusting either half of it would
 * be worse than failing.
 */
export function chainOf(frameHashes: readonly string[]): string {
  let chain: Uint8Array = ZERO32.slice();
  const pair = new Uint8Array(64);
  for (const hex of frameHashes) {
    pair.set(chain, 0);
    pair.set(parseDigest(hex), 32);
    chain = sha256(pair);
  }
  return toHex(chain);
}

/** One conformance case: a named run and the hashes it must produce. */
export interface GoldenCase {
  /** Case name, matching its directory under `conformance/cases/`. */
  name: string;
  /** The seed the machine was booted with. */
  seed: number;
  /** Frame count; always equal to `frameHashes.length`. */
  frames: number;
  /** One 64-character lowercase hex digest per frame, in order. */
  frameHashes: string[];
  /** The chain value over all frames, 64 lowercase hex characters. */
  chain: string;
}

/** Format version written as the first token of the first line. */
const FORMAT = "sq1-golden";
const FORMAT_VERSION = "1";

/**
 * Render a case in the on-disk text form documented at the top of this file.
 *
 * Throws rather than emitting a file that would not parse back: a golden file is
 * only useful if it is exactly what it claims to be.
 */
export function formatGolden(c: GoldenCase): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(c.name)) {
    throw new Error(`formatGolden: bad name ${JSON.stringify(c.name)}`);
  }
  if (!Number.isInteger(c.seed) || c.seed < 0 || c.seed > 0xffffffff) {
    throw new Error(`formatGolden: seed must be a uint32, got ${c.seed}`);
  }
  if (c.frames !== c.frameHashes.length) {
    throw new Error(
      `formatGolden: frames says ${c.frames} but there are ${c.frameHashes.length} hashes`,
    );
  }
  const lines: string[] = [
    `${FORMAT} ${FORMAT_VERSION}`,
    `name ${c.name}`,
    `seed ${c.seed}`,
    `frames ${c.frames}`,
  ];
  for (let i = 0; i < c.frameHashes.length; i++) {
    lines.push(`frame ${i} ${requireHex(c.frameHashes[i], `frameHashes[${i}]`)}`);
  }
  lines.push(`chain ${requireHex(c.chain, "chain")}`);
  return lines.join("\n") + "\n";
}

/**
 * Parse the on-disk text form. Round-trips exactly:
 * `formatGolden(parseGolden(t)) === t` for any `t` this accepts.
 *
 * Every field is checked, including the redundant ones. A golden file is an
 * assertion about the machine; a parser that repaired it quietly would let a
 * corrupted assertion pass as a passing test.
 */
export function parseGolden(text: string): GoldenCase {
  const lines = text.split("\n");
  if (lines[lines.length - 1] !== "") {
    throw new Error("parseGolden: file must end with a newline");
  }
  lines.pop();
  if (text.includes("\r")) throw new Error("parseGolden: CR found; golden files are LF only");

  let i = 0;
  const next = (what: string): string => {
    const l = lines[i];
    if (l === undefined) throw new Error(`parseGolden: unexpected end of file, wanted ${what}`);
    i++;
    return l;
  };

  const header = next("the format header");
  if (header !== `${FORMAT} ${FORMAT_VERSION}`) {
    throw new Error(`parseGolden: bad header ${JSON.stringify(header)}`);
  }

  const name = field(next("name"), "name");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
    throw new Error(`parseGolden: bad name ${JSON.stringify(name)}`);
  }

  const seedText = field(next("seed"), "seed");
  if (!/^(0|[1-9][0-9]*)$/.test(seedText)) {
    throw new Error(`parseGolden: bad seed ${JSON.stringify(seedText)}`);
  }
  const seed = Number(seedText);
  if (seed > 0xffffffff) throw new Error(`parseGolden: seed ${seed} exceeds uint32`);

  const framesText = field(next("frames"), "frames");
  if (!/^(0|[1-9][0-9]*)$/.test(framesText)) {
    throw new Error(`parseGolden: bad frames ${JSON.stringify(framesText)}`);
  }
  const frames = Number(framesText);

  const frameHashes: string[] = [];
  for (let f = 0; f < frames; f++) {
    const parts = next(`frame ${f}`).split(" ");
    if (parts.length !== 3 || parts[0] !== "frame") {
      throw new Error(`parseGolden: line ${i} is not a frame line`);
    }
    if (parts[1] !== String(f)) {
      throw new Error(`parseGolden: expected frame ${f}, found frame ${parts[1]}`);
    }
    frameHashes.push(requireHex(parts[2], `frame ${f}`));
  }

  const chain = requireHex(field(next("chain"), "chain"), "chain");
  if (i !== lines.length) {
    throw new Error(`parseGolden: ${lines.length - i} unexpected trailing line(s)`);
  }
  const recomputed = chainOf(frameHashes);
  if (recomputed !== chain) {
    throw new Error(
      `parseGolden: chain ${chain} does not match the frame list, which chains to ${recomputed}`,
    );
  }

  return { name, seed, frames, frameHashes, chain };
}

/**
 * Index of the first frame at which two hash lists disagree, or -1 if they are
 * identical. A list that is a strict prefix of the other diverges at its own
 * length: the run stopped early, and that is a difference.
 *
 * This is the number that gets printed when a conformance case fails, so it is
 * deliberately the smallest useful fact rather than a diff.
 */
export function firstDivergence(a: readonly string[], b: readonly string[]): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return i;
  }
  return a.length === b.length ? -1 : n;
}

/** Split `key value` and return the value, checking the key. */
function field(line: string, key: string): string {
  const sp = line.indexOf(" ");
  if (sp < 0 || line.slice(0, sp) !== key) {
    throw new Error(`parseGolden: expected a ${key} line, got ${JSON.stringify(line)}`);
  }
  return line.slice(sp + 1);
}

/** Assert a string is a 64-character lowercase hex digest and return it. */
function requireHex(s: string | undefined, what: string): string {
  if (s === undefined || !/^[0-9a-f]{64}$/.test(s)) {
    throw new Error(`${what}: not a 64-character lowercase hex digest: ${JSON.stringify(s)}`);
  }
  return s;
}

/** Hex digest to raw bytes, with the same strictness as `requireHex`. */
function parseDigest(s: string): Uint8Array {
  requireHex(s, "digest");
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = Number.parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}
