/**
 * The arena: the complete mutable state of a running simulation, in one
 * contiguous buffer.
 *
 * The rule the specification states in section 2.6 is absolute -- no state in
 * host objects, no state in the renderer, no state on the audio thread, no
 * state in a closure that outlives a snapshot. This file is what makes that
 * rule mechanical rather than aspirational: a snapshot is a copy of this buffer
 * and nothing else, so anything a cart can remember that is NOT in here is a
 * silent lie about what a rewind restores. The small console learned that at
 * 64 KB (see packages/runtime/test/state-containment.test.ts); the defect does
 * not get smaller at 1 MB, it just takes longer to notice.
 *
 * WHY ASSETS ARE NOT IN HERE
 * --------------------------
 * Immutable data does not need saving. It needs only to be the same, which the
 * cart hash already guarantees. Keeping textures and audio out of the arena is
 * the change that makes eight frames of rollback affordable on a machine
 * holding gigabytes -- the copy cost tracks the mutable state, not the game.
 *
 * SIZE
 * ----
 * 1 MB for this slice, against the specification's 64 MB cap. A breakout game
 * needs a few kilobytes; the size is chosen so the state-hash chain is cheap
 * enough to run on every tick of a million-tick conformance case, which is what
 * makes the chain worth having.
 */

/** The arena is 1 MB for this slice. The specification's cap is 64 MB. */
export const ARENA_BYTES = 1 << 20;

/** The arena is viewed 32 bits at a time by `seal`, so its size must divide by 4. */
const SEAL_WORDS = ARENA_BYTES >>> 2;

export interface Arena {
  /** The one buffer. Everything mutable in the simulation is a view on this. */
  readonly buf: ArrayBuffer;
  /** Endian-explicit access, for the machine header and for carts. */
  readonly view: DataView;
  /** Byte access, for snapshots and for hashing. */
  readonly bytes: Uint8Array;

  /** A copy of every byte. This IS the save state. */
  snapshot(): Uint8Array;

  /** Overwrite every byte. The snapshot must be exactly ARENA_BYTES long. */
  restore(snap: Uint8Array): void;

  /**
   * A checksum of the whole arena, for detecting a write between two points.
   * Development only: this is a guard, not a hash, and nothing normative
   * depends on its value.
   */
  seal(): number;

  /** True if the arena is byte-for-byte what it was when `token` was taken. */
  verify(token: number): boolean;
}

/**
 * Create a zeroed arena.
 *
 * `boot` zeroes it again before installing a cart's initial state; a fresh
 * ArrayBuffer is already zero, and the second pass exists so that rebooting an
 * existing machine starts from the same place a new one does.
 */
export function createArena(): Arena {
  const buf = new ArrayBuffer(ARENA_BYTES);
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);
  const words = new Uint32Array(buf);

  /**
   * The seal.
   *
   * Every step is a bijection: xor with a word, multiply by an ODD constant
   * (invertible modulo 2^32), rotate. So for a fixed prefix the map from one
   * word to the resulting state is injective, and every later step is injective
   * in the state -- which means two arenas that differ in exactly ONE 32-bit
   * word can never seal to the same number. That is stronger than a
   * probabilistic guarantee, and single-word differences are the case that
   * matters: a render function that leaks one value writes one word.
   *
   * Two or more differing words collide with probability about 2^-32, which is
   * the right trade for a check that runs twice per presented frame.
   *
   * `Math.imul` is the only exact 32-bit multiply in JavaScript; `*` would
   * overflow into double rounding and make the seal engine-dependent, which
   * would be a strange bug to introduce into the thing that guards determinism.
   */
  const seal = (): number => {
    let h = 0x811c9dc5 | 0;
    for (let i = 0; i < SEAL_WORDS; i++) {
      h = Math.imul(h ^ (words[i] as number), 0x01000193);
      h = (h << 13) | (h >>> 19);
    }
    return h >>> 0;
  };

  return Object.freeze({
    buf,
    view,
    bytes,

    snapshot(): Uint8Array {
      return bytes.slice();
    },

    restore(snap: Uint8Array): void {
      if (snap.length !== ARENA_BYTES) {
        throw new Error(`restore: snapshot is ${snap.length} bytes, expected ${ARENA_BYTES}`);
      }
      bytes.set(snap);
    },

    seal,

    verify(token: number): boolean {
      return seal() === (token >>> 0);
    },
  });
}
