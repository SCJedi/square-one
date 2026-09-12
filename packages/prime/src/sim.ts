/**
 * The machine: a tick loop, the ABI a cart sees, and the wall between `tick`
 * and `render`.
 *
 * Everything here implements `spec/PRIME-ABI.md`. Where this file narrows the
 * ABI, it says so and says why -- twice, both times because the ABI's literal
 * wording would let a cart write the arena from `render`, which is the one
 * thing the whole architecture exists to prevent.
 */

import { ARENA_BYTES, createArena } from "./arena";
import type { Arena } from "./arena";
import { atan2, cos, sin, sqrt } from "./math";
import { RNG_BYTES, rnd, rndf, rngCreate, rngLoadInto, rngSave } from "./prng";
import type { RngState } from "./prng";

// ---------------------------------------------------------------------------
// The arena's machine header
// ---------------------------------------------------------------------------

/**
 * The first 64 bytes of the arena belong to the machine, not to the cart.
 *
 *     0x00  u64   tick counter, little-endian
 *     0x08  32 B  PCG64-DXSM state and increment
 *     0x28  24 B  reserved, always zero
 *     0x40  the cart's region begins
 *
 * The tick counter and the generator are simulation state in exactly the sense
 * section 2.6 means, so they live in the arena and travel inside every snapshot.
 * They are NOT reachable through `sim.mem`, which is a view starting at 0x40:
 * the ABI says "all mutable state lives here" and it does, but a cart that could
 * rewind the clock by poking eight bytes would make `sim.tick` a suggestion.
 *
 * They ARE inside the state hash, because they are part of the state. Two
 * machines whose generators have drifted have diverged, whether or not the
 * difference has reached anything a player can see -- that is the whole content
 * of moving the normative line off the framebuffer.
 */
export const ARENA_HEADER = 0x40;

/** Byte offset of the u64 tick counter. */
const OFF_TICK = 0x00;

/** Byte offset of the 32-byte generator state. */
const OFF_RNG = 0x08;

/** Bytes of arena a cart can address through `sim.mem`. */
export const CART_BYTES = ARENA_BYTES - ARENA_HEADER;

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

/** Player slots. */
export const MAX_PLAYERS = 8;

/**
 * Button bits, as fixed by the ABI. Pause and menu are the console's and are
 * deliberately absent: a cart must not be able to observe or suppress them.
 */
export const BUTTON = Object.freeze({
  UP: 0,
  DOWN: 1,
  LEFT: 2,
  RIGHT: 3,
  A: 4,
  B: 5,
  X: 6,
  Y: 7,
  L: 8,
  R: 9,
  L2: 10,
  R2: 11,
  L3: 12,
  R3: 13,
  SELECT: 14,
  START: 15,
});

/**
 * One tick of input for every player slot, ALREADY QUANTIZED.
 *
 * A stick's true position is an analog signal that differs between controllers,
 * driver stacks and polling rates. What reaches a cart is an integer, because
 * integers replay. The quantization happens in the runtime, before `tick`, and
 * `step` below re-does it by copying through typed arrays of exactly these
 * widths -- so a host that hands over something wider still produces the frame
 * the cart would have seen.
 */
export interface InputFrame {
  /** 8 players, 16 bits each. */
  readonly buttons: Uint16Array;
  /** 8 players x 4 axes, full i16 range. */
  readonly axes: Int16Array;
  /** 8 players x 2 triggers. */
  readonly triggers: Uint8Array;
  /** Bitmask of populated slots. */
  readonly present: number;
}

/** A zero input frame, for booting and for tests. */
export function emptyInput(): InputFrame {
  return Object.freeze({
    buttons: new Uint16Array(MAX_PLAYERS),
    axes: new Int16Array(MAX_PLAYERS * 4),
    triggers: new Uint8Array(MAX_PLAYERS * 2),
    present: 0,
  });
}

// ---------------------------------------------------------------------------
// Draw
// ---------------------------------------------------------------------------

/**
 * The display list a cart writes into. Declared HERE, structurally, so this
 * package compiles and tests without the renderer: the renderer owns the real
 * implementation and this is only the shape the ABI fixes.
 *
 * Coordinates are floats in a 1920 x 1080 logical space; colours are packed
 * 0xRRGGBBAA as a u32. `bloom` and `shake` are presentation and a runtime may
 * ignore both, so a cart must render correctly with them doing nothing -- never
 * put information in a post stage.
 */
export interface Draw {
  clear(color: number): void;
  rect(x: number, y: number, w: number, h: number, color: number): void;
  roundRect(x: number, y: number, w: number, h: number, r: number, color: number): void;
  circle(x: number, y: number, r: number, color: number): void;
  line(x0: number, y0: number, x1: number, y1: number, w: number, color: number): void;
  tri(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    color: number,
  ): void;
  text(s: string, x: number, y: number, size: number, color: number): void;
  measure(s: string, size: number): number;
  push(): void;
  pop(): void;
  translate(x: number, y: number): void;
  rotate(a: number): void;
  scale(x: number, y: number): void;
  blend(mode: 0 | 1): void;
  layer(n: number): void;
  bloom(strength: number, threshold: number): void;
  shake(amount: number): void;
}

// ---------------------------------------------------------------------------
// Snd
// ---------------------------------------------------------------------------

/** Per-shot modifiers. All optional; a backend that ignores them is conformant. */
export interface SndOpts {
  /** Linear gain multiplier. 1 is the effect's own level. */
  readonly gain?: number;
  /** Playback-rate multiplier. 1 is the effect's own pitch. */
  readonly pitch?: number;
  /** -1 hard left, 0 centre, 1 hard right. */
  readonly pan?: number;
}

/**
 * What a cart emits sound through.
 *
 * THE SAME ONE-WAY STREET AS EVERYWHERE ELSE: the simulation emits, the mixer
 * consumes, nothing flows back. There is no playback position to read and no
 * audio clock to sample -- an `AudioContext` runs on its own oscillator and
 * drifts against the frame clock, so a simulation that could hear it would
 * replay differently on different hardware.
 *
 * `snd` is handed to `boot` and `tick` and NEVER to `render`. `render` runs on
 * the presentation clock -- two to four times per tick on a fast display -- so a
 * sound emitted there fires two to four times per event. It is the same rule as
 * `render` cannot write the arena, for the same reason: everything that happens,
 * happens in `tick`.
 *
 * Audio is NON-NORMATIVE. Nothing a backend does can move the state hash, which
 * is why `createMachine` accepts any `Snd` -- silent, recording, or a real
 * mixer -- and produces the same arena from all three.
 */
export interface Snd {
  /** Fire a one-shot effect. `id` is a cart-defined effect number. */
  play(id: number, opts?: SndOpts): void;
  /** Start a music track, cross-fading over `fade` frames. */
  music(id: number, fade?: number): void;
  /** Stop the music, fading over `fade` frames. */
  stopMusic(fade?: number): void;
}

/**
 * A backend that plays nothing.
 *
 * The default for `createMachine`, so a headless conformance run never needs a
 * mixer and never has to be told that it is headless. A cart calls `snd` the
 * same way whether anything is listening.
 */
export function nullSnd(): Snd {
  return Object.freeze({
    play(): void {},
    music(): void {},
    stopMusic(): void {},
  });
}

// ---------------------------------------------------------------------------
// Sim
// ---------------------------------------------------------------------------

/** The normative half of the ABI, as `tick` and `boot` see it. */
export interface Sim {
  /** u64, the only clock a cart can see. No wall clock exists. */
  readonly tick: bigint;
  /** The cart's region of the arena. All mutable state lives here. */
  readonly mem: DataView;

  /** An unbiased integer in [0, n), n in [1, 2^31). */
  rnd(n: number): number;
  /** A double in [0, 1). */
  rndf(): number;

  /** The normative math library. NEVER the platform's -- see math.ts. */
  sin(x: number): number;
  cos(x: number): number;
  atan2(y: number, x: number): number;
  /** IEEE 754 specifies this one exactly, so it IS the platform's. */
  sqrt(x: number): number;
}

/**
 * What `render` gets.
 *
 * The ABI says "SimRead is the same minus `mem` being writable". This narrows
 * that in one way, and REPORTING it is part of shipping this file: `rnd` and
 * `rndf` are NOT here.
 *
 * They cannot be. The generator's state lives in the arena, so a draw is a
 * write, and a write from `render` is precisely the defect the read-only rule
 * exists to catch -- a cart that called `sim.rnd()` for a sparkle would fault
 * the arena check in development and desync in production. Leaving them on the
 * read-only interface would be an ABI that invites the bug and then punishes it.
 * If a renderer wants jitter, it derives it from the tick and the entity index,
 * which is reproducible and costs nothing.
 *
 * `mem` is a DataView, and JavaScript has no read-only DataView. The
 * specification anticipates exactly this: where the hardware cannot map the
 * arena read-only, the runtime MUST hash it before and after `render` and fault
 * on a change. That is what `present` does.
 */
export interface SimRead {
  readonly tick: bigint;
  readonly mem: DataView;
  sin(x: number): number;
  cos(x: number): number;
  atan2(y: number, x: number): number;
  sqrt(x: number): number;
}

/**
 * A cart. Three entry points and no others.
 *
 * Two of them get `snd` and the third does not. See {@link Snd}: `render` runs
 * on the presentation clock, so a sound emitted from it fires once per PRESENTED
 * FRAME rather than once per event -- two to four times per impact on a fast
 * display, on exactly the hardware that was supposed to make the game better.
 */
export interface PrimeCart {
  /** Once. The arena is zeroed; install initial state here. */
  boot(sim: Sim, snd: Snd): void;
  /** Exactly once per simulated tick, at a fixed 60 Hz. MAY write the arena. */
  tick(sim: Sim, input: InputFrame, snd: Snd): void;
  /** Zero or more times per tick, on the presentation clock. MUST NOT write the arena. */
  render(sim: SimRead, draw: Draw, alpha: number): void;
}

// ---------------------------------------------------------------------------
// Development checks
// ---------------------------------------------------------------------------

let devChecks = true;

/**
 * Turn the arena write-check around `render` on or off. On by default.
 *
 * It defaults to ON because the check is what makes the read-only rule real, and
 * a guard that has to be switched on is a guard that is off in the build where
 * it mattered. A shipping runtime turns it off once, deliberately, having run
 * its conformance cases with it on.
 *
 * This is a host-level switch, not simulation state: it changes whether a fault
 * is raised, never what the simulation computes.
 */
export function setDevChecks(on: boolean): void {
  devChecks = on;
}

/** Whether the arena write-check around `render` is armed. */
export function devChecksEnabled(): boolean {
  return devChecks;
}

// ---------------------------------------------------------------------------
// The machine
// ---------------------------------------------------------------------------

export interface Machine {
  readonly arena: Arena;
  /** The index of the NEXT tick to run; after N steps this reads N. */
  readonly tick: bigint;
  boot(seed: bigint): void;
  /** Exactly one simulated tick. */
  step(input: InputFrame): void;
  present(draw: Draw, alpha: number): void;
  snapshot(): Uint8Array;
  restore(snap: Uint8Array): void;
}

/**
 * Build a machine around a cart, and optionally around a mixer.
 *
 * `snd` defaults to {@link nullSnd}, so a conformance runner constructs a
 * machine exactly as it always did and hears nothing. THE ARENA IS THE SAME
 * EITHER WAY -- a backend cannot write the arena, cannot be read by the cart,
 * and cannot move the state hash. `sim.test.ts` asserts that with two machines
 * whose only difference is the backend.
 */
export function createMachine(cart: PrimeCart, snd: Snd = nullSnd()): Machine {
  const arena = createArena();
  const view = arena.view;

  /**
   * The cart's window on the arena. Starts past the machine header.
   *
   * FROZEN, which is not the same as read-only and is not meant to be: a
   * DataView has no own data properties, so freezing it stops `sim.mem.cache = x`
   * while leaving `setFloat64` working exactly as before. Without that freeze the
   * ABI has a hole the shape of the one the small console found -- a place a cart
   * can remember something that no snapshot contains.
   */
  const mem = Object.freeze(new DataView(arena.buf, ARENA_HEADER, CART_BYTES));

  /**
   * Scratch for the generator. The authoritative copy is the 32 bytes at
   * OFF_RNG; this array only ever holds them for the duration of one draw.
   *
   * Caching the state here between draws would be faster and would be the exact
   * defect this package is built to prevent: a `restore` would put the old bytes
   * in the arena and leave the new ones in this array, and the run would
   * continue from a state that is in no snapshot. Read it out, use it, write it
   * back.
   */
  const rngScratch: RngState = new Uint32Array(8);

  /**
   * Machine-owned input, so a cart cannot retain a reference to host memory.
   *
   * Made non-extensible for the same reason `mem` is frozen: these three arrays
   * are the same objects on every tick, so `input.buttons.lastFrame = ...` would
   * be state outside the arena that survives a rewind. A typed array holding
   * elements cannot be frozen or sealed -- its indices must stay configurable --
   * but it can be made non-extensible, which is the half of the job that matters.
   */
  const inButtons = Object.preventExtensions(new Uint16Array(MAX_PLAYERS));
  const inAxes = Object.preventExtensions(new Int16Array(MAX_PLAYERS * 4));
  const inTriggers = Object.preventExtensions(new Uint8Array(MAX_PLAYERS * 2));
  let inPresent = 0;

  const frame: InputFrame = Object.freeze({
    buttons: inButtons,
    axes: inAxes,
    triggers: inTriggers,
    get present(): number {
      return inPresent;
    },
  });

  function readTick(): bigint {
    return view.getBigUint64(OFF_TICK, true);
  }

  function draw(n: number): number {
    rngLoadInto(rngScratch, view, OFF_RNG);
    const v = rnd(rngScratch, n);
    rngSave(rngScratch, view, OFF_RNG);
    return v;
  }

  function drawF(): number {
    rngLoadInto(rngScratch, view, OFF_RNG);
    const v = rndf(rngScratch);
    rngSave(rngScratch, view, OFF_RNG);
    return v;
  }

  /**
   * The ABI object, frozen.
   *
   * The small console shipped this unfrozen once, and `sys.carry = 1` survived
   * a tick and survived a `restore` -- a determinism defect wearing a security
   * costume. The danger was never that a cart could REACH something; it was that
   * a cart could REMEMBER something outside the buffer. Same defect, same fix,
   * bigger arena. See packages/runtime/test/state-containment.test.ts.
   *
   * The freeze is shallow by intent: `mem` must stay writable, because writing
   * it is the entire point.
   */
  const sim: Sim = Object.freeze({
    get tick(): bigint {
      return readTick();
    },
    mem,
    rnd: draw,
    rndf: drawF,
    sin,
    cos,
    atan2,
    sqrt,
  });

  /**
   * The mixer, behind a frozen facade.
   *
   * FORWARDING RATHER THAN HANDING THE OBJECT OVER, for the same reason `sim`
   * is frozen: a cart must not be able to REMEMBER anything outside the arena,
   * and `snd.lastId = 4` on a host object would survive a tick and survive a
   * `restore`. Freezing the host's own backend instead would be the machine
   * reaching into somebody else's object -- a mixer has controls of its own
   * (mute, start, stop) and they belong to whoever built it.
   */
  const cartSnd: Snd = Object.freeze({
    play(id: number, opts?: SndOpts): void {
      snd.play(id, opts);
    },
    music(id: number, fade?: number): void {
      snd.music(id, fade);
    },
    stopMusic(fade?: number): void {
      snd.stopMusic(fade);
    },
  });

  /** The same object minus the two methods that write. Frozen for the same reason. */
  const simRead: SimRead = Object.freeze({
    get tick(): bigint {
      return readTick();
    },
    mem,
    sin,
    cos,
    atan2,
    sqrt,
  });

  return Object.freeze({
    arena,

    get tick(): bigint {
      return readTick();
    },

    boot(seed: bigint): void {
      arena.bytes.fill(0);
      view.setBigUint64(OFF_TICK, 0n, true);
      rngSave(rngCreate(seed), view, OFF_RNG);
      cart.boot(sim, cartSnd);
    },

    /**
     * One tick, in an order that is part of the contract:
     *
     *   1. The input frame is copied into machine-owned arrays, which is where
     *      the quantization becomes final.
     *   2. The cart runs. `sim.tick` during the call is the index of the tick
     *      that is running, so the first tick after boot sees 0.
     *   3. The counter increments, LAST. If it incremented first, tick 0 would
     *      never be observable and every replay index would be off by one.
     *
     * There is no clamping here and no catch-up: a `step` is one tick. Clamping
     * presentation catch-up to five ticks per frame (section 2.2) belongs to the
     * host loop that decides how many times to call this.
     */
    step(input: InputFrame): void {
      if (input.buttons.length !== MAX_PLAYERS) {
        throw new Error(`step: buttons must have ${MAX_PLAYERS} entries`);
      }
      if (input.axes.length !== MAX_PLAYERS * 4) {
        throw new Error(`step: axes must have ${MAX_PLAYERS * 4} entries`);
      }
      if (input.triggers.length !== MAX_PLAYERS * 2) {
        throw new Error(`step: triggers must have ${MAX_PLAYERS * 2} entries`);
      }
      if (!Number.isInteger(input.present) || input.present < 0 || input.present > 0xff) {
        throw new Error(`step: present must be an 8-bit mask, got ${input.present}`);
      }
      inButtons.set(input.buttons);
      inAxes.set(input.axes);
      inTriggers.set(input.triggers);
      inPresent = input.present;

      cart.tick(sim, frame, cartSnd);

      view.setBigUint64(OFF_TICK, readTick() + 1n, true);
    },

    /**
     * Present one frame. NOT part of the simulation.
     *
     * In development the arena is sealed before `render` and verified after, and
     * a write faults. That enforcement is not decoration. A value computed for
     * smoothing that reaches the next tick is the single most common way a
     * deterministic engine stops being one, and it is invisible until a replay
     * recorded on a 60 Hz display is played back on a 144 Hz one and ends
     * somewhere else.
     *
     * The seal is a rolling hash over the whole 1 MB: 0.33 ms measured on this
     * repository's Windows/Node runner, so an armed `present` costs about
     * 0.65 ms. At 60 Hz that is 4 per cent of one core and at 144 Hz about 9 --
     * the right price for the guarantee during development, and
     * `setDevChecks(false)` is how a shipping runtime stops paying it.
     */
    present(drawList: Draw, alpha: number): void {
      if (!(alpha >= 0 && alpha < 1)) {
        throw new Error(`present: alpha must be in [0, 1), got ${alpha}`);
      }
      if (!devChecks) {
        cart.render(simRead, drawList, alpha);
        return;
      }
      const token = arena.seal();
      cart.render(simRead, drawList, alpha);
      if (!arena.verify(token)) {
        throw new Error(
          "present: render wrote to the arena. `render` MUST NOT write simulation " +
            "state -- a value computed for interpolation that survives into the next " +
            "tick is the classic way a deterministic engine stops being one.",
        );
      }
    },

    snapshot(): Uint8Array {
      return arena.snapshot();
    },

    restore(snap: Uint8Array): void {
      arena.restore(snap);
    },
  });
}

/** The generator's footprint in the header, re-exported for anyone laying out saves. */
export { RNG_BYTES };
