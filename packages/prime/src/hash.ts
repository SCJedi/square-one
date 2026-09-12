/**
 * The state-hash chain: how a Prime run is compared across engines.
 *
 * THE CONTRACT (normative)
 * ------------------------
 * For a run of N ticks, with `arena` the simulation's memory at the END of each
 * tick -- after `tick()` has returned, before `present` runs, and before
 * anything the host does with the result:
 *
 *     stateHash_i = SHA-256( the whole arena )                 // ARENA_BYTES
 *     chain_0     = SHA-256( ZERO32 || stateHash_0 )
 *     chain_i     = SHA-256( chain_{i-1} || stateHash_i )      // i >= 1
 *
 * where `||` is byte concatenation, ZERO32 is 32 zero bytes, and every hash is
 * the raw 32-byte digest -- never its hex form. The chain of an empty run is
 * ZERO32 itself.
 *
 * THE ONE LINE THAT IS THE WHOLE PRIME THESIS
 * -------------------------------------------
 * The small console hashes the FRAMEBUFFER. That works because a 128 x 128
 * software rasterizer is deterministic by construction, and it is the right
 * choice there: the framebuffer is downstream of everything, so a divergence
 * that never reaches a pixel has, by definition, not changed the game.
 *
 * Put a GPU under it and that collapses. Drivers differ, vendors differ, the
 * same driver differs across a version bump, and a specification demanding
 * identical pixels from a modern renderer is one nobody could implement twice.
 * So the line moves to where the small console already put one for audio: the
 * simulation emits, the presentation consumes, nothing flows back.
 *
 * The consequence is that this chain hashes the ARENA -- every byte, including
 * scratch and padding. That is a stronger commitment than the small console's,
 * and it is deliberate: on Prime the arena IS the normative object, so a byte
 * in it that two implementations disagree about is a real disagreement even if
 * nothing ever reads it. A cart that leaves a struct's padding uninitialised
 * has a bug on this machine, and this is what finds it.
 *
 * WHY BOTH A PER-TICK LIST AND A SINGLE CHAIN
 * -------------------------------------------
 * The chain answers "did this run match?" in one comparison, which is what a CI
 * gate wants. The per-tick list answers "where did it stop matching?", which is
 * the only question worth asking once the answer to the first is no. Determinism
 * drift is silent and cumulative; the tick number of the first divergence is
 * what turns a red build into a bisectable bug.
 *
 * The chain is a chain rather than a hash of the concatenated list because a
 * chain is prefix-committing: chain_i depends on every tick up to i, so a
 * partial run compares against a prefix of a golden file with no recomputation.
 *
 * THE ON-DISK FORMAT
 * ------------------
 * Line-oriented ASCII, LF only, one trailing newline -- the same shape as the
 * small console's `sq1-golden`, deliberately, so the two consoles' conformance
 * tooling is recognisably one thing. CRLF is not permitted: a case generated on
 * Windows and on Linux must be byte-equal.
 *
 *     sq1p-golden 1
 *     name red-breaker-600
 *     seed 1
 *     ticks 600
 *     tick 0 <64 lowercase hex>
 *     tick 1 <64 lowercase hex>
 *     ...
 *     tick 599 <64 lowercase hex>
 *     chain <64 lowercase hex>
 *
 * The tick index is written out rather than implied by line position so a diff
 * hunk in the middle of a 600-tick file still says which tick it is.
 * `parseGolden` requires the indices to be 0..ticks-1 in order, so the
 * redundancy is checked rather than decorative.
 *
 * The seed is a u64 and is carried as a `bigint`, because a u64 does not fit in
 * a double and a seed that silently rounds is a case that silently tests
 * something else.
 */

import { sha256, toHex } from "@sq1/core";

import { ARENA_BYTES } from "./arena";

/** 32 zero bytes: the seed of the chain, and the chain value of an empty run. */
const ZERO32 = new Uint8Array(32);

/**
 * SHA-256 of the whole arena. Returns the raw 32-byte digest.
 *
 * Takes the bytes rather than an Arena so a conformance runner can hash a
 * snapshot it loaded from disk without building a machine around it.
 */
export function stateHash(arena: Uint8Array): Uint8Array {
  if (arena.length !== ARENA_BYTES) {
    throw new Error(`stateHash: arena is ${arena.length} bytes, expected ${ARENA_BYTES}`);
  }
  return sha256(arena);
}

/**
 * The running chain over a sequence of ticks.
 *
 * Feed it the arena at the end of each tick, in order. `digest` is the chain
 * value after everything pushed so far, so it is meaningful mid-run: a host can
 * compare it against the same prefix of a golden file and stop at the first tick
 * that disagrees rather than running to the end.
 */
export class ChainHasher {
  /** Current chain value, 32 raw bytes. Starts at ZERO32. */
  #chain: Uint8Array = ZERO32.slice();
  #count = 0;
  /** Scratch for `chain_{i-1} || stateHash_i`, reused to avoid per-tick garbage. */
  readonly #pair = new Uint8Array(64);

  /**
   * Hash one tick and advance the chain.
   *
   * @param arena the simulation's memory at the end of the tick
   * @returns that tick's state hash, as 64 lowercase hex characters
   */
  push(arena: Uint8Array): string {
    const sh = stateHash(arena);
    this.#pair.set(this.#chain, 0);
    this.#pair.set(sh, 32);
    this.#chain = sha256(this.#pair);
    this.#count++;
    return toHex(sh);
  }

  /** The chain value over every tick pushed so far, as 64 lowercase hex characters. */
  get digest(): string {
    return toHex(this.#chain);
  }

  /** How many ticks have been pushed. */
  get count(): number {
    return this.#count;
  }
}

/**
 * The chain value implied by a list of per-tick hex hashes.
 *
 * Exists so a parsed golden file can be checked for internal consistency: its
 * `chain` field must be exactly this. A golden whose chain and tick list
 * disagree has been hand-edited, and silently trusting either half of it would
 * be worse than failing.
 */
export function chainOf(stateHashes: readonly string[]): string {
  let chain: Uint8Array = ZERO32.slice();
  const pair = new Uint8Array(64);
  for (const hex of stateHashes) {
    pair.set(chain, 0);
    pair.set(parseDigest(hex), 32);
    chain = sha256(pair);
  }
  return toHex(chain);
}

/** One conformance case: a named run and the hashes it must produce. */
export interface GoldenCase {
  /** Case name, matching its directory under the conformance tree. */
  name: string;
  /** The u64 seed the machine was booted with. */
  seed: bigint;
  /** Tick count; always equal to `stateHashes.length`. */
  ticks: number;
  /** One 64-character lowercase hex digest per tick, in order. */
  stateHashes: string[];
  /** The chain value over all ticks, 64 lowercase hex characters. */
  chain: string;
}

const FORMAT = "sq1p-golden";
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
  if (c.seed < 0n || c.seed > 0xffffffffffffffffn) {
    throw new Error(`formatGolden: seed must be a u64, got ${c.seed}`);
  }
  if (c.ticks !== c.stateHashes.length) {
    throw new Error(
      `formatGolden: ticks says ${c.ticks} but there are ${c.stateHashes.length} hashes`,
    );
  }
  const lines: string[] = [
    `${FORMAT} ${FORMAT_VERSION}`,
    `name ${c.name}`,
    `seed ${c.seed.toString()}`,
    `ticks ${c.ticks}`,
  ];
  for (let i = 0; i < c.stateHashes.length; i++) {
    lines.push(`tick ${i} ${requireHex(c.stateHashes[i], `stateHashes[${i}]`)}`);
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
  const seed = BigInt(seedText);
  if (seed > 0xffffffffffffffffn) throw new Error(`parseGolden: seed ${seed} exceeds u64`);

  const ticksText = field(next("ticks"), "ticks");
  if (!/^(0|[1-9][0-9]*)$/.test(ticksText)) {
    throw new Error(`parseGolden: bad ticks ${JSON.stringify(ticksText)}`);
  }
  const ticks = Number(ticksText);

  const stateHashes: string[] = [];
  for (let t = 0; t < ticks; t++) {
    const parts = next(`tick ${t}`).split(" ");
    if (parts.length !== 3 || parts[0] !== "tick") {
      throw new Error(`parseGolden: line ${i} is not a tick line`);
    }
    if (parts[1] !== String(t)) {
      throw new Error(`parseGolden: expected tick ${t}, found tick ${parts[1]}`);
    }
    stateHashes.push(requireHex(parts[2], `tick ${t}`));
  }

  const chain = requireHex(field(next("chain"), "chain"), "chain");
  if (i !== lines.length) {
    throw new Error(`parseGolden: ${lines.length - i} unexpected trailing line(s)`);
  }
  const recomputed = chainOf(stateHashes);
  if (recomputed !== chain) {
    throw new Error(
      `parseGolden: chain ${chain} does not match the tick list, which chains to ${recomputed}`,
    );
  }

  return { name, seed, ticks, stateHashes, chain };
}

/**
 * Index of the first tick at which two hash lists disagree, or -1 if they are
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
