/**
 * The machine: one 64 KB buffer, a cart, and a tick.
 *
 * Everything a running game is, is inside `ram`. There is no state in a
 * closure, no state on the API objects, and above all no PRNG living in a
 * variable somewhere -- the generator's four words are read out of RAM, used,
 * and written back on every call. That is the difference between a rewind that
 * looks right and a rewind that is byte-identical, and it is the reason
 * `snapshot()` can be a plain copy.
 *
 * Allocation discipline: everything the frame loop needs is allocated once, in
 * `createMachine`. `tick()` and `present()` allocate nothing -- no object
 * literals, no closures per call, no strings. The API object and its six method
 * groups are built once and handed to the cart unchanged forever.
 */

import { fcos, fsin, rnd as coreRnd, rndf as coreRndf, rngCreate, rngSave } from "@sq1/core";

import { createSndApi, tickAudio } from "./audio";
import type { SndApi } from "./audio";
import { installCartData, NO_CART_DATA } from "./cart-data";
import type { CartData } from "./cart-data";
import { ADDR, LEN, LIVE_COLORS, MAX_PLAYERS, RAM_SIZE, SCREEN_H, SCREEN_W } from "./memory";
import { HW_PALETTE, writeLut } from "./palette";
import {
  camera as rCamera,
  circ as rCirc,
  cls as rCls,
  clip as rClip,
  clipReset,
  inClip,
  line as rLine,
  map as rMap,
  palt as rPalt,
  paltReset,
  present as rPresent,
  print as rPrint,
  pset as rPset,
  pget as rPget,
  rect as rRect,
  camX,
  camY,
  spr as rSpr,
  sspr as rSspr,
} from "./raster";

/** What a cart can do. Nothing else is reachable from cart code. */
export interface CartApi {
  gfx: {
    cls(c: number): void;
    pset(x: number, y: number, c: number): void;
    pget(x: number, y: number): number;
    rect(x: number, y: number, w: number, h: number, c: number, fill: boolean): void;
    /** Endpoints inclusive, and symmetric: line(a,b) lights line(b,a)'s pixels. */
    line(x0: number, y0: number, x1: number, y1: number, c: number): void;
    /** Midpoint circle. r = 0 is one pixel. `fill` defaults to false. */
    circ(x: number, y: number, r: number, c: number, fill?: boolean): void;
    /** Sprite `n`, `w` x `h` cells of 8x8, optionally mirrored. Defaults 1,1,false,false. */
    spr(n: number, x: number, y: number, w?: number, h?: number, fx?: boolean, fy?: boolean): void;
    /** Stretched blit from the sheet. `dw`/`dh` default to `sw`/`sh`. */
    sspr(
      sx: number,
      sy: number,
      sw: number,
      sh: number,
      dx: number,
      dy: number,
      dw?: number,
      dh?: number,
      fx?: boolean,
      fy?: boolean,
    ): void;
    /** A region of the tile map. `layer` 0 draws every tile; see raster.map. */
    map(cx: number, cy: number, sx: number, sy: number, cw: number, ch: number, layer?: number): void;
    /** System font, 4x6. Returns the x advance. */
    print(s: string, x: number, y: number, c: number): number;
    /** Write DRAW_REMAP: colour `from` written by the cart is stored as `to`. */
    pal(from: number, to: number): void;
    /** Mark a colour transparent for spr/sspr/map/print. No arguments resets. */
    palt(c?: number, on?: boolean): void;
    clip(x: number, y: number, w: number, h: number): void;
    /** The draw offset. Everything positional is drawn at (x - camx, y - camy). */
    camera(x: number, y: number): void;
  };
  inp: {
    /** Held this tick. `p` defaults to player slot 0. */
    btn(b: number, p?: number): boolean;
    /** Newly pressed this tick: set in INPUT_NOW and clear in INPUT_PREV. */
    btnp(b: number, p?: number): boolean;
  };
  snd: SndApi;
  sys: {
    rnd(n: number): number;
    rndf(): number;
    /** 1024 steps per turn, 16.16 out. */
    sin(a: number): number;
    cos(a: number): number;
    frame(): number;
    peek(a: number): number;
    poke(a: number, v: number): void;
    /** Bounds-clamped block copy with memmove semantics. Returns nothing. */
    memcpy(dst: number, src: number, len: number): void;
    /** Bounds-clamped block fill. */
    memset(dst: number, v: number, len: number): void;
    /** Ask the host to persist the 256-byte SAVE region. */
    save(): void;
    /** Ask the host to refill the SAVE region from wherever it put it. */
    load(): void;
    /** Developer console. Numbers and strings only; a no-op without a sink. */
    trace(...args: (number | string)[]): void;
  };
}

/**
 * What the HOST supplies, and the cart cannot see.
 *
 * `save` and `load` exist because persistence is the host's problem: the machine
 * has no storage and must not acquire any, or it stops being a pure function of
 * (cart, seed, inputs) and the conformance chains stop meaning anything. The
 * machine hands the hook a live view of the SAVE region and lets the host decide
 * what a "file" is -- localStorage, a database row, a directory, nothing at all.
 *
 * `trace` is the developer console. It is a hook rather than a global for the
 * same reason, and it is sanitised at the boundary: see `sys.trace`.
 */
export interface MachineHooks {
  /** Called by `sys.save` with a live view of the 256-byte SAVE region. */
  save?(save: Uint8Array): void;
  /** Called by `sys.load` with the same view, for the host to fill. */
  load?(save: Uint8Array): void;
  /** Called by `sys.trace` with already-sanitised numbers and strings. */
  trace?(...args: (number | string)[]): void;
  /**
   * The cart's static data, installed by `boot` after RAM is zeroed and the
   * machine's own defaults are written, and BEFORE the cart's `boot()` runs.
   *
   * It is a HOOK rather than an argument to `boot` because it belongs to the
   * cart file and not to the run: `loadCartBytes` plans it once, and every boot
   * and every rewind of that cart installs the same bytes. Read once here, so a
   * host cannot change what a machine boots with after it has been created --
   * two boots of one machine must be two identical boots.
   *
   * `loadCartBytes` produces it. A host that builds a `CartProgram` some other
   * way and passes nothing gets the old behaviour, which is a zeroed machine.
   */
  data?: CartData;
}

/**
 * Caps on `sys.trace`. A developer console is not a channel for a cart to push
 * a megabyte through, and a bound here is one fewer thing for a host to defend.
 */
const TRACE_MAX_ARGS = 8;
const TRACE_MAX_CHARS = 256;

/** A cart is two functions. Boot once, tick forever. */
export interface CartProgram {
  boot(api: CartApi): void;
  tick(api: CartApi): void;
}

export interface Machine {
  /** 65536 bytes. THE ENTIRE MACHINE STATE. */
  readonly ram: Uint8Array;
  /** 16384 RGBA pixels, filled by `present()`. */
  readonly rgba: Uint32Array;
  boot(seed: number): void;
  /** `input` is 4 bytes, one per player slot. */
  tick(input: Uint8Array): void;
  present(): void;
  snapshot(): Uint8Array;
  restore(snap: Uint8Array): void;
}

export function createMachine(program: CartProgram, hooks?: MachineHooks): Machine {
  const ram = new Uint8Array(RAM_SIZE);
  const rgba = new Uint32Array(SCREEN_W * SCREEN_H);
  const lut = new Uint32Array(LIVE_COLORS);

  /**
   * The SAVE region as a view, built once.
   *
   * `sys.save` and `sys.load` hand this to the host. A view rather than a copy,
   * so a load writes straight into RAM and a save reads the live bytes; built
   * here rather than per call, because a subarray is an allocation and these are
   * reachable from a cart's tick.
   */
  const saveView = ram.subarray(ADDR.SAVE, ADDR.SAVE + LEN.SAVE);

  /**
   * Scratch for the PRNG. The authoritative copy of the state is the 16 bytes
   * at ADDR.RNG_STATE; this array only ever holds them for the duration of one
   * call. It exists so a random number costs no allocation: `rngLoad` from core
   * returns a fresh Uint32Array, which is right for a save-file reader and
   * wrong for something called a hundred times a frame.
   */
  const rngScratch = new Uint32Array(4);

  /**
   * The cart's static data, read ONCE.
   *
   * Captured at construction rather than read out of `hooks` on every boot, for
   * the reason `MachineHooks.data` gives: a machine must boot the same way
   * twice, and a field a host can reassign between two boots is machine state
   * living outside the 64 KB buffer. It is also one fewer property read on the
   * path a rewind takes.
   */
  const cartData: CartData = hooks?.data ?? NO_CART_DATA;

  /**
   * RAM -> scratch. Byte-for-byte the decode `rngLoad` performs (four u32,
   * little endian) written into a preallocated array. machine.test.ts pins the
   * equivalence against core's `rngLoad` so the two can never drift.
   */
  function rngPull(): void {
    for (let i = 0; i < 4; i++) {
      const o = ADDR.RNG_STATE + i * 4;
      rngScratch[i] =
        (((ram[o] as number) |
          ((ram[o + 1] as number) << 8) |
          ((ram[o + 2] as number) << 16) |
          ((ram[o + 3] as number) << 24)) >>>
        0);
    }
  }

  /** scratch -> RAM, via core's own serialiser. */
  function rngPush(): void {
    rngSave(rngScratch, ram, ADDR.RNG_STATE);
  }

  /**
   * DRAW_REMAP is applied HERE, in the API layer, and nowhere else.
   *
   * The alternative -- remapping inside the rasterizer -- puts a table lookup
   * in the per-pixel path of every fill, to implement a feature whose whole
   * point is that it is free. Doing it once where a cart's colour enters the
   * machine keeps `raster.ts` a dumb fast path with no palette knowledge, and
   * means a filled rect pays for the remap once rather than 16384 times.
   */
  function remap(c: number): number {
    return (ram[ADDR.DRAW_REMAP + (c & 0x0f)] as number) & 0x0f;
  }

  const gfx: CartApi["gfx"] = {
    cls(c: number): void {
      rCls(ram, remap(c));
    },
    // `pset` and `pget` are camera-relative HERE, at the ABI, so a cart sees one
    // coordinate system across every drawing call. raster.pset/pget stay raw
    // screen-space accessors, because they are what the rasterizer's own inner
    // loops call after they have already done the offset once.
    pset(x: number, y: number, c: number): void {
      const xi = (x | 0) - camX(ram);
      const yi = (y | 0) - camY(ram);
      // The only bounds test in the pixel path, and it is the clip test: the
      // clip rectangle is itself clamped to the screen, so passing it means the
      // address is in the framebuffer.
      if (inClip(ram, xi, yi)) rPset(ram, xi, yi, remap(c));
    },
    pget(x: number, y: number): number {
      return rPget(ram, (x | 0) - camX(ram), (y | 0) - camY(ram));
    },
    rect(x: number, y: number, w: number, h: number, c: number, fill: boolean): void {
      rRect(ram, x | 0, y | 0, w | 0, h | 0, remap(c), fill);
    },
    line(x0: number, y0: number, x1: number, y1: number, c: number): void {
      rLine(ram, x0 | 0, y0 | 0, x1 | 0, y1 | 0, remap(c));
    },
    circ(x: number, y: number, r: number, c: number, fill?: boolean): void {
      rCirc(ram, x | 0, y | 0, r | 0, remap(c), fill === true);
    },
    spr(n: number, x: number, y: number, w?: number, h?: number, fx?: boolean, fy?: boolean): void {
      rSpr(
        ram,
        n | 0,
        x | 0,
        y | 0,
        w === undefined ? 1 : w | 0,
        h === undefined ? 1 : h | 0,
        fx === true,
        fy === true,
      );
    },
    sspr(
      sx: number,
      sy: number,
      sw: number,
      sh: number,
      dx: number,
      dy: number,
      dw?: number,
      dh?: number,
      fx?: boolean,
      fy?: boolean,
    ): void {
      const w = sw | 0;
      const h = sh | 0;
      rSspr(
        ram,
        sx | 0,
        sy | 0,
        w,
        h,
        dx | 0,
        dy | 0,
        dw === undefined ? w : dw | 0,
        dh === undefined ? h : dh | 0,
        fx === true,
        fy === true,
      );
    },
    map(cx: number, cy: number, sx: number, sy: number, cw: number, ch: number, layer?: number): void {
      rMap(ram, cx | 0, cy | 0, sx | 0, sy | 0, cw | 0, ch | 0, layer === undefined ? 0 : layer | 0);
    },
    print(s: string, x: number, y: number, c: number): number {
      // Never coerce: `String(s)` would call a cart-supplied toString, which is
      // cart code running inside a draw call and an allocation besides.
      return typeof s === "string" ? rPrint(ram, s, x | 0, y | 0, remap(c)) : 0;
    },
    pal(from: number, to: number): void {
      ram[ADDR.DRAW_REMAP + (from & 0x0f)] = to & 0x0f;
    },
    palt(c?: number, on?: boolean): void {
      if (c === undefined) paltReset(ram);
      else rPalt(ram, c | 0, on !== false);
    },
    clip(x: number, y: number, w: number, h: number): void {
      rClip(ram, x | 0, y | 0, w | 0, h | 0);
    },
    camera(x: number, y: number): void {
      rCamera(ram, x | 0, y | 0);
    },
  };

  const inp: CartApi["inp"] = {
    btn(b: number, p?: number): boolean {
      const slot = (p === undefined ? 0 : p | 0) & (MAX_PLAYERS - 1);
      return (((ram[ADDR.INPUT_NOW + slot] as number) >>> (b & 7)) & 1) === 1;
    },
    btnp(b: number, p?: number): boolean {
      const slot = (p === undefined ? 0 : p | 0) & (MAX_PLAYERS - 1);
      const bit = b & 7;
      const now = ((ram[ADDR.INPUT_NOW + slot] as number) >>> bit) & 1;
      const prev = ((ram[ADDR.INPUT_PREV + slot] as number) >>> bit) & 1;
      return now === 1 && prev === 0;
    },
  };

  const sys: CartApi["sys"] = {
    rnd(n: number): number {
      rngPull();
      const v = coreRnd(rngScratch, n);
      rngPush();
      return v;
    },
    rndf(): number {
      rngPull();
      const v = coreRndf(rngScratch);
      rngPush();
      return v;
    },
    sin(a: number): number {
      return fsin(a | 0);
    },
    cos(a: number): number {
      return fcos(a | 0);
    },
    frame(): number {
      return readFrame();
    },
    peek(a: number): number {
      const i = a | 0;
      // Defined behaviour outside RAM: 0. Never a throw -- a cart with an
      // arithmetic bug must produce a wrong picture, not kill the machine.
      return i >= 0 && i < RAM_SIZE ? (ram[i] as number) : 0;
    },
    poke(a: number, v: number): void {
      const i = a | 0;
      if (i >= 0 && i < RAM_SIZE) ram[i] = v & 0xff;
    },

    /**
     * Block copy, CLAMPED and never throwing.
     *
     * OVERLAP IS DEFINED AS memmove, not memcpy: the result is as if the source
     * had been read in full before the destination was written, so a downward
     * copy does not smear its own first byte across the range. `copyWithin` is
     * specified that way and does it without a temporary, so the safe answer is
     * also the free one. The alternative -- "overlap is undefined" -- would put
     * a nondeterminism in the ABI, and every byte of this machine is normative.
     *
     * A range that runs off the end of RAM is shortened, not rejected. A cart
     * with an arithmetic bug should copy fewer bytes than it meant to, not stop.
     */
    memcpy(dst: number, src: number, len: number): void {
      const d = dst | 0;
      const s = src | 0;
      let n = len | 0;
      if (n <= 0 || d < 0 || s < 0 || d >= RAM_SIZE || s >= RAM_SIZE) return;
      if (n > RAM_SIZE - d) n = RAM_SIZE - d;
      if (n > RAM_SIZE - s) n = RAM_SIZE - s;
      ram.copyWithin(d, s, s + n);
    },

    /** Block fill, clamped the same way as `memcpy`. */
    memset(dst: number, v: number, len: number): void {
      const d = dst | 0;
      let n = len | 0;
      if (n <= 0 || d < 0 || d >= RAM_SIZE) return;
      if (n > RAM_SIZE - d) n = RAM_SIZE - d;
      ram.fill(v & 0xff, d, d + n);
    },

    /**
     * Persistence. The machine does not have any, and asks.
     *
     * With no hook these are no-ops that return nothing, which is also exactly
     * what they look like from a cart when the hook exists -- there is no return
     * value and no exception either way, so a cart cannot detect the host.
     */
    save(): void {
      const h = hooks?.save;
      if (h === undefined) return;
      try {
        h(saveView);
      } catch {
        /* a host that throws is the host's problem, not the cart's */
      }
    },
    load(): void {
      const h = hooks?.load;
      if (h === undefined) return;
      try {
        h(saveView);
      } catch {
        /* see save */
      }
    },

    /**
     * The developer console -- and NOT a hole.
     *
     * Three properties hold, and each one is a thing a naive trace would give
     * away:
     *
     *   1. The sink is unreachable. It is a closure variable of `createMachine`,
     *      never a property of anything the cart is handed.
     *   2. Only numbers and strings cross. Anything else becomes its `typeof`,
     *      decided by `typeof` alone -- which runs no cart code. Passing an
     *      object with a `toString` that the sink would call is how a cart would
     *      otherwise get a callback out of the machine, and how it would learn
     *      whether a sink exists at all.
     *   3. Nothing comes back. No return value, no exception, whether or not a
     *      sink is installed and whether or not it throws. A cart cannot tell
     *      the two cases apart, so `trace` cannot become a side channel or a
     *      "am I being debugged?" test that changes a replay.
     *
     * Sanitising in place, then spreading, keeps this to the one array the rest
     * parameter already made. `trace` is a developer facility and is the one
     * thing in the ABI that allocates; a shipping cart should not call it in a
     * frame, and a cart that does pays one small array per call.
     */
    trace(...args: (number | string)[]): void {
      const h = hooks?.trace;
      if (h === undefined) return;
      const n = args.length < TRACE_MAX_ARGS ? args.length : TRACE_MAX_ARGS;
      for (let i = 0; i < n; i++) {
        const v: unknown = args[i];
        if (typeof v === "number") args[i] = v;
        else if (typeof v === "string") args[i] = v.length > TRACE_MAX_CHARS ? v.slice(0, TRACE_MAX_CHARS) : v;
        else args[i] = `[${typeof v}]`;
      }
      args.length = n;
      try {
        h(...args);
      } catch {
        /* invisible to the cart, by design */
      }
    },
  };

  // The ABI objects are frozen, and this is a determinism requirement rather
  // than a security one.
  //
  // An unfrozen `sys` lets a cart write `sys.carry = 1` and read it back on a
  // later tick. That property is machine state living OUTSIDE the 64 KB buffer,
  // so it is not captured by `snapshot()` and not cleared by `restore()` -- a
  // rewind would return the framebuffer to frame N while leaving the cart's
  // smuggled field at frame N+300. Rewind, save states and rollback netplay all
  // rest on "the whole machine is one buffer", and a single writable property
  // on an ABI object is enough to make that false.
  //
  // Freezing is shallow by intent: the method groups and the api itself. The
  // typed arrays behind them are the machine and stay writable.
  //
  // `snd` comes from audio.ts already frozen; freezing it again is harmless and
  // says at this site that every namespace on the api is frozen, which is the
  // property state-containment.test.ts checks by name.
  const api: CartApi = Object.freeze({
    gfx: Object.freeze(gfx),
    inp: Object.freeze(inp),
    snd: Object.freeze(createSndApi(ram)),
    sys: Object.freeze(sys),
  });

  function readFrame(): number {
    const o = ADDR.FRAME;
    return (
      (((ram[o] as number) |
        ((ram[o + 1] as number) << 8) |
        ((ram[o + 2] as number) << 16) |
        ((ram[o + 3] as number) << 24)) >>>
      0)
    );
  }

  function writeFrame(v: number): void {
    const o = ADDR.FRAME;
    const w = v >>> 0;
    ram[o + 0] = w & 0xff;
    ram[o + 1] = (w >>> 8) & 0xff;
    ram[o + 2] = (w >>> 16) & 0xff;
    ram[o + 3] = (w >>> 24) & 0xff;
  }

  return {
    ram,
    rgba,

    boot(seed: number): void {
      ram.fill(0);

      // The hardware palette is copied in, not referenced: a cart may poke it,
      // and poking it must not change what the next machine boots with.
      ram.set(HW_PALETTE, ADDR.PALETTE_HW);

      for (let i = 0; i < LIVE_COLORS; i++) {
        ram[ADDR.PALETTE_LIVE + i] = i; // identity live palette
        ram[ADDR.DRAW_REMAP + i] = i; // identity draw remap
      }

      clipReset(ram);
      // Colour 0 transparent, everything else opaque. Two bytes at 0x20E8, so
      // it travels inside a snapshot like the rest of the machine.
      paltReset(ram);
      rngSave(rngCreate(seed), ram, ADDR.RNG_STATE);
      writeFrame(0);

      // THE CART'S STATIC DATA, and the position of this line is the contract.
      //
      // AFTER the defaults above, because a `PAL ` chunk's whole purpose is to
      // replace the identity live palette written six lines up, and installing
      // first would mean the machine overwrote the cart's colours with its own.
      //
      // BEFORE `program.boot`, because a cart reads and writes its own data:
      // the platformer reads sprite flags to decide which tiles are solid while
      // it generates its level, on the boot that installs them. Installing after
      // would hand every cart a blank sheet for exactly one frame, which is the
      // kind of bug that only shows up as a wrong first frame in a replay.
      //
      // Allocates nothing: see `installCartData`.
      installCartData(ram, cartData);

      program.boot(api);
    },

    /**
     * One tick, in an order that is part of the contract:
     *
     *   1. INPUT_NOW -> INPUT_PREV. Last tick's buttons become the past before
     *      the new ones land, because `btnp` is defined as "set now, clear
     *      previously" and would answer about the wrong pair of bytes if the
     *      copy happened after the write, or if it happened after the cart ran.
     *   2. The new input bytes land in INPUT_NOW, so the cart sees this tick's
     *      buttons -- not last tick's.
     *   3. The cart runs. Everything it reads about input and frame refers to
     *      the tick it is in.
     *   4. The audio registers advance one frame, AFTER the cart and BEFORE the
     *      counter. An `sfx()` issued on tick N has to be audible on tick N: if
     *      the mixer state advanced before the cart ran, every sound would start
     *      a frame late, and if it advanced after FRAME it would be attributed
     *      to the wrong tick in a replay. It writes only RAM.
     *   5. FRAME increments, LAST. During the cart's tick, FRAME is the index
     *      of the tick that is running: the first tick after boot sees 0, and
     *      after N ticks FRAME reads N. If it incremented first, tick 0 would
     *      never be observable and every replay index would be off by one.
     */
    tick(input: Uint8Array): void {
      for (let i = 0; i < MAX_PLAYERS; i++) {
        ram[ADDR.INPUT_PREV + i] = ram[ADDR.INPUT_NOW + i] as number;
      }
      for (let i = 0; i < MAX_PLAYERS; i++) {
        const v = input[i];
        ram[ADDR.INPUT_NOW + i] = v === undefined ? 0 : v & 0xff;
      }

      program.tick(api);

      tickAudio(ram);

      writeFrame(readFrame() + 1);
    },

    /** Expand the packed framebuffer into `rgba` through the live palette. */
    present(): void {
      writeLut(ram, lut);
      rPresent(ram, rgba, lut);
    },

    /** A copy of RAM. Includes the PRNG, so a restore resumes the sequence. */
    snapshot(): Uint8Array {
      return new Uint8Array(ram);
    },

    restore(snap: Uint8Array): void {
      if (snap.length !== RAM_SIZE) {
        throw new Error(`restore: snapshot is ${snap.length} bytes, expected ${RAM_SIZE}`);
      }
      ram.set(snap);
    },
  };
}
