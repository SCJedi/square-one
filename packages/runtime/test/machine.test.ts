import { rnd as coreRnd, rngCreate, rngLoad, rngSave } from "@sq1/core";
import { describe, expect, it } from "vitest";

import {
  AUDIO_REGS_BYTES,
  AUDIO_REGS_START,
  createSndApi,
  readAudioRegs,
  tickAudio,
} from "../src/audio";
import { gradientCart } from "../src/carts/gradient";
import { referenceCart } from "../src/carts/reference";
import { createMachine } from "../src/machine";
import type { CartApi, CartProgram } from "../src/machine";
import { ADDR, BTN, LEN, RAM_SIZE, SCREEN_H, SCREEN_W } from "../src/memory";
import { HW_PALETTE } from "../src/palette";
import { ADDR_PALT, PALT_DEFAULT, paltMask, pget } from "../src/raster";

/** A cart that does nothing, for testing the machine rather than a cart. */
const nullCart: CartProgram = {
  boot(): void {},
  tick(): void {},
};

/** A cart built from two callbacks, so a test can say what a tick does. */
function cartOf(tick: (api: CartApi) => void, boot?: (api: CartApi) => void): CartProgram {
  return {
    boot(api: CartApi): void {
      if (boot) boot(api);
    },
    tick,
  };
}

const NO_INPUT = new Uint8Array(4);

/** FNV-1a over the packed framebuffer. A local stand-in for the frame hash. */
function fbHash(ram: Uint8Array): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < LEN.FRAMEBUFFER; i++) {
    h ^= ram[ADDR.FRAMEBUFFER + i] as number;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function readU32(ram: Uint8Array, off: number): number {
  return (
    (((ram[off] as number) |
      ((ram[off + 1] as number) << 8) |
      ((ram[off + 2] as number) << 16) |
      ((ram[off + 3] as number) << 24)) >>>
    0)
  );
}

describe("boot", () => {
  it("gives a 65536-byte RAM and a 16384-pixel output", () => {
    const m = createMachine(nullCart);
    expect(m.ram.length).toBe(RAM_SIZE);
    expect(m.rgba.length).toBe(SCREEN_W * SCREEN_H);
  });

  it("zeroes RAM before installing anything", () => {
    const m = createMachine(nullCart);
    m.boot(1);
    m.ram[ADDR.USER_RAM] = 0xaa;
    m.ram[ADDR.SAVE] = 0xbb;
    m.boot(1);
    expect(m.ram[ADDR.USER_RAM]).toBe(0);
    expect(m.ram[ADDR.SAVE]).toBe(0);
  });

  it("installs the hardware palette as a copy a cart cannot corrupt", () => {
    const m = createMachine(nullCart);
    m.boot(7);
    for (let i = 0; i < LEN.PALETTE_HW; i++) {
      expect(m.ram[ADDR.PALETTE_HW + i], `hw byte ${i}`).toBe(HW_PALETTE[i]);
    }
    m.ram[ADDR.PALETTE_HW] = 0x42;
    expect(HW_PALETTE[0]).not.toBe(0x42);
  });

  it("installs the identity live palette and identity draw remap", () => {
    const m = createMachine(nullCart);
    m.boot(7);
    for (let i = 0; i < 16; i++) {
      expect(m.ram[ADDR.PALETTE_LIVE + i]).toBe(i);
      expect(m.ram[ADDR.DRAW_REMAP + i]).toBe(i);
    }
  });

  it("opens the clip rectangle to the whole screen", () => {
    const m = createMachine(nullCart);
    m.boot(7);
    expect(Array.from(m.ram.subarray(ADDR.CLIP, ADDR.CLIP + 4))).toEqual([0, 0, 127, 127]);
  });

  it("seeds the PRNG into RNG_STATE, and a different seed gives a different state", () => {
    const m = createMachine(nullCart);
    m.boot(12345);
    const expected = new Uint8Array(16);
    rngSave(rngCreate(12345), expected, 0);
    expect(Array.from(m.ram.subarray(ADDR.RNG_STATE, ADDR.RNG_STATE + 16))).toEqual(
      Array.from(expected),
    );

    const other = createMachine(nullCart);
    other.boot(12346);
    expect(Array.from(other.ram.subarray(ADDR.RNG_STATE, ADDR.RNG_STATE + 16))).not.toEqual(
      Array.from(expected),
    );
  });

  it("starts FRAME at 0 and calls the cart's boot exactly once", () => {
    let boots = 0;
    const m = createMachine(cartOf(() => {}, () => boots++));
    m.boot(1);
    expect(boots).toBe(1);
    expect(readU32(m.ram, ADDR.FRAME)).toBe(0);
    m.tick(NO_INPUT);
    expect(boots).toBe(1);
  });

  it("lets the cart draw during boot", () => {
    const m = createMachine(cartOf(() => {}, (api) => api.gfx.cls(3)));
    m.boot(1);
    expect(pget(m.ram, 64, 64)).toBe(3);
  });
});

describe("tick ordering", () => {
  it("increments FRAME after the cart runs, so the cart sees the running index", () => {
    const seen: number[] = [];
    const m = createMachine(cartOf((api) => seen.push(api.sys.frame())));
    m.boot(1);
    m.tick(NO_INPUT);
    m.tick(NO_INPUT);
    m.tick(NO_INPUT);
    expect(seen).toEqual([0, 1, 2]);
    expect(readU32(m.ram, ADDR.FRAME)).toBe(3);
  });

  it("copies NOW into PREV before the new input lands", () => {
    const m = createMachine(nullCart);
    m.boot(1);
    const a = new Uint8Array([0b0001, 0, 0, 0]);
    const b = new Uint8Array([0b0010, 0, 0, 0]);
    m.tick(a);
    expect(m.ram[ADDR.INPUT_PREV]).toBe(0);
    expect(m.ram[ADDR.INPUT_NOW]).toBe(0b0001);
    m.tick(b);
    expect(m.ram[ADDR.INPUT_PREV]).toBe(0b0001);
    expect(m.ram[ADDR.INPUT_NOW]).toBe(0b0010);
  });

  it("btn is held and btnp is only the tick of the press", () => {
    const held: boolean[] = [];
    const pressed: boolean[] = [];
    const m = createMachine(
      cartOf((api) => {
        held.push(api.inp.btn(BTN.A));
        pressed.push(api.inp.btnp(BTN.A));
      }),
    );
    m.boot(1);
    const none = new Uint8Array(4);
    const aDown = new Uint8Array([1 << BTN.A, 0, 0, 0]);
    m.tick(none);
    m.tick(aDown);
    m.tick(aDown);
    m.tick(none);
    m.tick(aDown);
    expect(held).toEqual([false, true, true, false, true]);
    expect(pressed).toEqual([false, true, false, false, true]);
  });

  it("keeps the four player slots independent", () => {
    let p0 = false;
    let p2 = false;
    const m = createMachine(
      cartOf((api) => {
        p0 = api.inp.btn(BTN.B, 0);
        p2 = api.inp.btn(BTN.B, 2);
      }),
    );
    m.boot(1);
    m.tick(new Uint8Array([0, 0, 1 << BTN.B, 0]));
    expect(p0).toBe(false);
    expect(p2).toBe(true);
  });

  it("treats a short input array as zeroes rather than throwing", () => {
    const m = createMachine(nullCart);
    m.boot(1);
    m.tick(new Uint8Array([0xff]));
    expect(m.ram[ADDR.INPUT_NOW]).toBe(0xff);
    expect(m.ram[ADDR.INPUT_NOW + 1]).toBe(0);
  });
});

describe("the API surface", () => {
  it("routes every drawn colour through DRAW_REMAP", () => {
    const m = createMachine(
      cartOf((api) => {
        api.gfx.pal(1, 9);
        api.gfx.cls(1);
        api.gfx.pset(0, 0, 1);
        api.gfx.rect(2, 0, 2, 1, 1, true);
      }),
    );
    m.boot(1);
    m.tick(NO_INPUT);
    expect(m.ram[ADDR.DRAW_REMAP + 1]).toBe(9);
    expect(pget(m.ram, 0, 0)).toBe(9);
    expect(pget(m.ram, 2, 0)).toBe(9);
    expect(pget(m.ram, 64, 64)).toBe(9);
  });

  it("clips pset at the API layer, including off-screen coordinates", () => {
    const m = createMachine(
      cartOf((api) => {
        api.gfx.cls(0);
        api.gfx.clip(10, 10, 4, 4);
        api.gfx.pset(9, 10, 5);
        api.gfx.pset(10, 10, 5);
        api.gfx.pset(-1, -1, 5);
        api.gfx.pset(200, 200, 5);
      }),
    );
    m.boot(1);
    m.tick(NO_INPUT);
    expect(pget(m.ram, 10, 10)).toBe(5);
    expect(pget(m.ram, 9, 10)).toBe(0);
    let lit = 0;
    for (let y = 0; y < SCREEN_H; y++) for (let x = 0; x < SCREEN_W; x++) if (pget(m.ram, x, y) === 5) lit++;
    expect(lit).toBe(1);
  });

  it("pget reads back what the cart drew", () => {
    let got = -1;
    const m = createMachine(
      cartOf((api) => {
        api.gfx.pset(3, 4, 12);
        got = api.gfx.pget(3, 4);
      }),
    );
    m.boot(1);
    m.tick(NO_INPUT);
    expect(got).toBe(12);
  });

  it("peek and poke are bounds-checked and never throw", () => {
    let low = -1;
    let high = -1;
    let inside = -1;
    const m = createMachine(
      cartOf((api) => {
        api.sys.poke(-1, 0xff);
        api.sys.poke(RAM_SIZE, 0xff);
        api.sys.poke(RAM_SIZE * 4, 0xff);
        api.sys.poke(ADDR.USER_RAM, 0x123); // masked to a byte
        low = api.sys.peek(-1);
        high = api.sys.peek(RAM_SIZE);
        inside = api.sys.peek(ADDR.USER_RAM);
      }),
    );
    m.boot(1);
    expect(() => m.tick(NO_INPUT)).not.toThrow();
    expect(low).toBe(0);
    expect(high).toBe(0);
    expect(inside).toBe(0x23);
  });

  it("routes every NEW primitive's colour through DRAW_REMAP too", () => {
    // A remap the rasterizer knows nothing about: it is applied once, where the
    // cart's colour enters the machine, so every primitive gets it for free.
    const m = createMachine(
      cartOf((api) => {
        api.gfx.cls(0);
        api.gfx.pal(1, 9);
        api.gfx.line(0, 0, 10, 0, 1);
        api.gfx.circ(0, 10, 0, 1, false);
        api.gfx.print("A", 0, 20, 1);
      }),
    );
    m.boot(1);
    m.tick(NO_INPUT);
    expect(pget(m.ram, 5, 0)).toBe(9);
    expect(pget(m.ram, 0, 10)).toBe(9);
    let inked = 0;
    for (let y = 20; y < 26; y++) for (let x = 0; x < 4; x++) if (pget(m.ram, x, y) === 9) inked++;
    expect(inked).toBeGreaterThan(0);
  });

  it("gives spr, sspr and map their defaults", () => {
    const m = createMachine(
      cartOf((api) => {
        api.gfx.cls(0);
        api.gfx.palt(0, false);
        api.sys.poke(ADDR.SPRITES, 0x77); // sprite 0, pixels (0,0) and (1,0)
        api.sys.poke(ADDR.MAP, 1);
        // Sprite 1 starts at sheet pixel (8, 0), which is byte 4 of the sheet.
        api.sys.poke(ADDR.SPRITES + 4, 0x55);
        api.gfx.spr(0, 0, 0); // w, h, fx, fy all defaulted
        api.gfx.sspr(0, 0, 8, 8, 0, 16); // dw, dh default to sw, sh
        api.gfx.map(0, 0, 0, 32, 1, 1); // layer defaults to 0 = every tile
      }),
    );
    m.boot(1);
    m.tick(NO_INPUT);
    expect(pget(m.ram, 0, 0)).toBe(7);
    expect(pget(m.ram, 1, 0)).toBe(7);
    expect(pget(m.ram, 0, 16)).toBe(7);
    expect(pget(m.ram, 0, 32)).toBe(5);
  });

  it("exposes palt, and boot installs colour 0 transparent", () => {
    const m = createMachine(nullCart);
    m.boot(1);
    expect(paltMask(m.ram)).toBe(PALT_DEFAULT);
    expect(m.ram[ADDR_PALT]).toBe(1);

    const m2 = createMachine(
      cartOf((api) => {
        api.gfx.palt(7, true);
        api.gfx.palt(0, false);
      }),
    );
    m2.boot(1);
    m2.tick(NO_INPUT);
    expect(paltMask(m2.ram)).toBe(0x0080);

    const m3 = createMachine(
      cartOf((api) => {
        api.gfx.palt(7, true);
        api.gfx.palt(); // no arguments resets
      }),
    );
    m3.boot(1);
    m3.tick(NO_INPUT);
    expect(paltMask(m3.ram)).toBe(PALT_DEFAULT);
  });

  it("moves pset, pget and every shape by the camera, but not cls or clip", () => {
    const m = createMachine(
      cartOf((api) => {
        api.gfx.cls(0);
        api.gfx.camera(10, 20);
        api.gfx.pset(30, 40, 5);
        api.gfx.rect(50, 40, 2, 2, 6, true);
        api.gfx.line(60, 40, 62, 40, 7);
      }),
    );
    m.boot(1);
    m.tick(NO_INPUT);
    expect(pget(m.ram, 20, 20)).toBe(5);
    expect(pget(m.ram, 30, 40)).toBe(0);
    expect(pget(m.ram, 40, 20)).toBe(6);
    expect(pget(m.ram, 50, 20)).toBe(7);
    expect(Array.from(m.ram.subarray(ADDR.CAMERA, ADDR.CAMERA + 4))).toEqual([10, 0, 20, 0]);

    // pget mirrors pset, so a cart reads back what it wrote at the same address.
    let got = -1;
    const m2 = createMachine(
      cartOf((api) => {
        api.gfx.camera(10, 20);
        api.gfx.pset(30, 40, 5);
        got = api.gfx.pget(30, 40);
      }),
    );
    m2.boot(1);
    m2.tick(NO_INPUT);
    expect(got).toBe(5);
  });

  it("refuses to coerce a non-string to print, rather than calling its toString", () => {
    let toStringCalls = 0;
    const hostile = {
      toString(): string {
        toStringCalls++;
        return "AAAA";
      },
    };
    let ret = -1;
    const m = createMachine(
      cartOf((api) => {
        api.gfx.cls(0);
        ret = (api.gfx.print as unknown as (s: unknown, x: number, y: number, c: number) => number)(
          hostile,
          0,
          0,
          6,
        );
      }),
    );
    m.boot(1);
    m.tick(NO_INPUT);
    expect(toStringCalls).toBe(0);
    expect(ret).toBe(0);
    for (let i = 0; i < LEN.FRAMEBUFFER; i++) expect(m.ram[i]).toBe(0);
  });

  it("sin and cos come from the core table, 1024 steps per turn", () => {
    let s0 = 0;
    let s256 = 0;
    let c0 = 0;
    let wrap = 0;
    const m = createMachine(
      cartOf((api) => {
        s0 = api.sys.sin(0);
        s256 = api.sys.sin(256);
        c0 = api.sys.cos(0);
        wrap = api.sys.sin(1024);
      }),
    );
    m.boot(1);
    m.tick(NO_INPUT);
    expect(s0).toBe(0);
    expect(s256).toBe(65536); // 1.0 in 16.16
    expect(c0).toBe(65536);
    expect(wrap).toBe(s0);
  });
});

describe("memcpy and memset", () => {
  it("copies and fills exactly the requested bytes", () => {
    const m = createMachine(
      cartOf((api) => {
        api.sys.memset(ADDR.USER_RAM, 0xab, 4);
        api.sys.memcpy(ADDR.USER_RAM + 8, ADDR.USER_RAM, 4);
      }),
    );
    m.boot(1);
    m.tick(NO_INPUT);
    expect(Array.from(m.ram.subarray(ADDR.USER_RAM, ADDR.USER_RAM + 5))).toEqual([
      0xab, 0xab, 0xab, 0xab, 0,
    ]);
    expect(Array.from(m.ram.subarray(ADDR.USER_RAM + 8, ADDR.USER_RAM + 13))).toEqual([
      0xab, 0xab, 0xab, 0xab, 0,
    ]);
  });

  it("has memmove semantics on an overlap, in BOTH directions", () => {
    const base = ADDR.USER_RAM;
    const m = createMachine(
      cartOf((api) => {
        for (let i = 0; i < 8; i++) api.sys.poke(base + i, i + 1);
        api.sys.memcpy(base + 2, base, 6); // upward: must not smear
        for (let i = 0; i < 8; i++) api.sys.poke(base + 32 + i, i + 1);
        api.sys.memcpy(base + 32, base + 34, 6); // downward
      }),
    );
    m.boot(1);
    m.tick(NO_INPUT);
    expect(Array.from(m.ram.subarray(base, base + 8))).toEqual([1, 2, 1, 2, 3, 4, 5, 6]);
    expect(Array.from(m.ram.subarray(base + 32, base + 40))).toEqual([3, 4, 5, 6, 7, 8, 7, 8]);
  });

  it("clamps at the top of RAM instead of throwing or wrapping", () => {
    const m = createMachine(
      cartOf((api) => {
        api.sys.memset(RAM_SIZE - 4, 0xcd, 1000);
        api.sys.memcpy(RAM_SIZE - 2, RAM_SIZE - 4, 1000);
        // Every one of these is out of bounds and must do nothing at all.
        api.sys.memset(-100, 0xff, 100);
        api.sys.memset(RAM_SIZE, 0xff, 100);
        api.sys.memcpy(-1, 0, 100);
        api.sys.memcpy(0, -1, 100);
        api.sys.memcpy(RAM_SIZE, 0, 100);
        api.sys.memset(ADDR.USER_RAM, 0xff, -5);
        api.sys.memcpy(ADDR.USER_RAM, 0, 0);
      }),
    );
    m.boot(1);
    expect(() => m.tick(NO_INPUT)).not.toThrow();
    expect(Array.from(m.ram.subarray(RAM_SIZE - 4, RAM_SIZE))).toEqual([0xcd, 0xcd, 0xcd, 0xcd]);
    expect(m.ram[ADDR.USER_RAM]).toBe(0);
    expect(m.ram[0]).toBe(0);
  });

  it("masks the fill byte", () => {
    const m = createMachine(cartOf((api) => api.sys.memset(ADDR.USER_RAM, 0x1234, 2)));
    m.boot(1);
    m.tick(NO_INPUT);
    expect(m.ram[ADDR.USER_RAM]).toBe(0x34);
  });
});

describe("save, load and trace are host hooks", () => {
  it("are no-ops, and silent ones, when the machine was built without them", () => {
    let ret: unknown = "not undefined";
    const m = createMachine(
      cartOf((api) => {
        api.sys.poke(ADDR.SAVE, 0x11);
        api.sys.save();
        api.sys.load();
        ret = api.sys.trace("hello", 1);
      }),
    );
    m.boot(1);
    expect(() => m.tick(NO_INPUT)).not.toThrow();
    expect(ret).toBeUndefined();
    expect(m.ram[ADDR.SAVE]).toBe(0x11);
  });

  it("hands save a live view of exactly the 256-byte SAVE region", () => {
    let seenLength = -1;
    let seenFirst = -1;
    const m = createMachine(
      cartOf((api) => {
        api.sys.poke(ADDR.SAVE, 0x42);
        api.sys.poke(ADDR.SAVE + LEN.SAVE - 1, 0x43);
        api.sys.save();
      }),
      {
        save(save: Uint8Array): void {
          seenLength = save.length;
          seenFirst = save[0] as number;
        },
      },
    );
    m.boot(1);
    m.tick(NO_INPUT);
    expect(seenLength).toBe(LEN.SAVE);
    expect(seenLength).toBe(256);
    expect(seenFirst).toBe(0x42);
  });

  it("lets load write straight into RAM through that view", () => {
    const m = createMachine(cartOf((api) => api.sys.load()), {
      load(save: Uint8Array): void {
        save[0] = 0xaa;
        save[255] = 0xbb;
      },
    });
    m.boot(1);
    m.tick(NO_INPUT);
    expect(m.ram[ADDR.SAVE]).toBe(0xaa);
    expect(m.ram[ADDR.SAVE + 255]).toBe(0xbb);
    expect(m.ram[ADDR.SAVE - 1]).toBe(0); // the view stops where the region does
  });

  it("swallows a throwing hook, so a cart cannot detect one", () => {
    let withHook: unknown = null;
    const m = createMachine(
      cartOf((api) => {
        withHook = api.sys.save();
      }),
      {
        save(): void {
          throw new Error("host exploded");
        },
      },
    );
    m.boot(1);
    expect(() => m.tick(NO_INPUT)).not.toThrow();
    expect(withHook).toBeUndefined();
  });

  it("gives trace only numbers and strings, and never calls a cart's toString", () => {
    const seen: unknown[][] = [];
    let toStringCalls = 0;
    const hostile = {
      toString(): string {
        toStringCalls++;
        return "leaked";
      },
    };
    const m = createMachine(
      cartOf((api) => {
        const t = api.sys.trace as unknown as (...a: unknown[]) => void;
        t("n=", 42, hostile, null, undefined, true, () => 1);
      }),
      { trace: (...args) => seen.push(args) },
    );
    m.boot(1);
    m.tick(NO_INPUT);
    expect(toStringCalls).toBe(0);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual(["n=", 42, "[object]", "[object]", "[undefined]", "[boolean]", "[function]"]);
  });

  it("caps trace's argument count and string length", () => {
    const seen: unknown[][] = [];
    const m = createMachine(
      cartOf((api) => {
        const t = api.sys.trace as unknown as (...a: unknown[]) => void;
        t(1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12);
        t("x".repeat(10_000));
      }),
      { trace: (...args) => seen.push(args) },
    );
    m.boot(1);
    m.tick(NO_INPUT);
    expect(seen[0]).toHaveLength(8);
    expect(seen[0]?.[7]).toBe(8);
    expect((seen[1]?.[0] as string).length).toBe(256);
  });

  it("keeps the sink out of a cart's reach", () => {
    // The only reference to the sink is a closure variable of createMachine.
    // Nothing enumerable on the api leads to it.
    const sink = (): void => {};
    const m = createMachine(
      cartOf((api) => {
        const found: string[] = [];
        const walk = (o: object, depth: number): void => {
          if (depth > 2) return;
          for (const k of Object.getOwnPropertyNames(o)) {
            const v = (o as Record<string, unknown>)[k];
            if (v === sink) found.push(k);
            if (typeof v === "object" && v !== null) walk(v, depth + 1);
          }
        };
        walk(api, 0);
        api.sys.poke(ADDR.USER_RAM, found.length);
      }),
      { trace: sink },
    );
    m.boot(1);
    m.tick(NO_INPUT);
    expect(m.ram[ADDR.USER_RAM]).toBe(0);
  });
});

/**
 * The `snd` wiring. What the register layout MEANS is audio.ts's business and
 * audio.ts's tests; what is checked here is that the namespace is on the api,
 * that it is frozen like the rest of it, and that everything it does lands
 * inside the 64 KB buffer -- which is the property the whole machine rests on.
 */
describe("the snd namespace", () => {
  function regsOf(m: ReturnType<typeof createMachine>): Uint8Array {
    const out = new Uint8Array(AUDIO_REGS_BYTES);
    readAudioRegs(m.ram, out);
    return out;
  }

  it("is on the api, is frozen, and is the same object on every tick", () => {
    const seen = new Set<unknown>();
    let frozen = true;
    const m = createMachine(
      cartOf((api) => {
        seen.add(api.snd);
        frozen = frozen && Object.isFrozen(api.snd);
        expect(typeof api.snd.sfx).toBe("function");
        expect(typeof api.snd.music).toBe("function");
      }),
    );
    m.boot(1);
    for (let i = 0; i < 5; i++) m.tick(NO_INPUT);
    expect(frozen).toBe(true);
    expect(seen.size).toBe(1);
  });

  it("writes into the audio register block and nowhere else in RAM", () => {
    const m = createMachine(cartOf((api) => api.snd.sfx(3, 2)));
    m.boot(1);
    const before = m.snapshot();
    m.tick(NO_INPUT);

    expect(Array.from(regsOf(m))).not.toEqual(
      Array.from(before.subarray(AUDIO_REGS_START, AUDIO_REGS_START + AUDIO_REGS_BYTES)),
    );
    // Everything below AUDIO_CH is untouched except FRAME, which the tick owns.
    for (let i = 0; i < ADDR.AUDIO_CH; i++) {
      if (i >= ADDR.FRAME && i < ADDR.FRAME + LEN.FRAME) continue;
      expect(m.ram[i], `byte ${i}`).toBe(before[i]);
    }
  });

  it("puts its state inside RAM, so a rewind takes the audio registers with it", () => {
    // A sound on a different channel each tick, so the register block after one
    // tick and after nine are demonstrably different states.
    const m = createMachine(cartOf((api) => api.snd.sfx(0, api.sys.frame() & 3)));
    m.boot(1);
    m.tick(NO_INPUT);
    const snap = m.snapshot();
    const atOne = regsOf(m);
    for (let i = 0; i < 8; i++) m.tick(NO_INPUT);
    expect(Array.from(regsOf(m))).not.toEqual(Array.from(atOne));
    m.restore(snap);
    expect(Array.from(regsOf(m))).toEqual(Array.from(atOne));
  });

  /**
   * WHERE `tickAudio` SITS IN THE TICK.
   *
   * It runs after the cart and before FRAME. Driving the same sequence by hand
   * pins that exactly: a machine that advanced the audio BEFORE the cart would
   * miss tick 0's `sfx` by one frame, and one that advanced it twice, or not at
   * all, would land somewhere else again. Comparing register blocks rather than
   * naming registers keeps this a test of the MACHINE, not of the synth.
   */
  it("advances the audio registers once per tick, after the cart", () => {
    const m = createMachine(
      cartOf((api) => {
        if (api.sys.frame() === 0) api.snd.sfx(0, 0);
      }),
    );
    m.boot(1);
    for (let i = 0; i < 4; i++) m.tick(NO_INPUT);

    const ref = createMachine(nullCart);
    ref.boot(1);
    createSndApi(ref.ram).sfx(0, 0); // what the cart did on tick 0 ...
    for (let i = 0; i < 4; i++) tickAudio(ref.ram); // ... then four advances

    expect(Array.from(regsOf(m))).toEqual(Array.from(regsOf(ref)));
  });

  it("leaves a silent machine's audio registers at zero", () => {
    const m = createMachine(nullCart);
    m.boot(1);
    for (let i = 0; i < 30; i++) m.tick(NO_INPUT);
    for (const b of regsOf(m)) expect(b).toBe(0);
  });
});

describe("the reference cart", () => {
  it("draws every panel: no row of the screen is left at the clear colour", () => {
    const m = createMachine(referenceCart);
    m.boot(1);
    m.tick(NO_INPUT);
    for (let y = 0; y < SCREEN_H; y++) {
      let painted = 0;
      for (let x = 0; x < SCREEN_W; x++) if (pget(m.ram, x, y) !== 1) painted++;
      expect(painted, `row ${y} is empty`).toBeGreaterThan(0);
    }
  });

  it("animates: ten consecutive frames are ten different pictures", () => {
    const m = createMachine(referenceCart);
    m.boot(1);
    const hashes = new Set<number>();
    for (let f = 0; f < 10; f++) {
      m.tick(NO_INPUT);
      hashes.add(fbHash(m.ram));
    }
    expect(hashes.size).toBe(10);
  });

  it("is reproducible, and rewinds bit-exactly", () => {
    const run = (): Uint8Array => {
      const m = createMachine(referenceCart);
      m.boot(1);
      for (let f = 0; f < 20; f++) m.tick(NO_INPUT);
      return m.snapshot();
    };
    expect(Array.from(run())).toEqual(Array.from(run()));

    const m = createMachine(referenceCart);
    m.boot(1);
    for (let f = 0; f < 10; f++) m.tick(NO_INPUT);
    const snap = m.snapshot();
    for (let f = 0; f < 10; f++) m.tick(NO_INPUT);
    const after = m.snapshot();
    m.restore(snap);
    for (let f = 0; f < 10; f++) m.tick(NO_INPUT);
    expect(Array.from(m.snapshot())).toEqual(Array.from(after));
  });

  it("builds its sprite sheet and its map during boot", () => {
    const m = createMachine(referenceCart);
    m.boot(1);
    let sheetInk = 0;
    for (let i = 0; i < LEN.SPRITES; i++) if (m.ram[ADDR.SPRITES + i] !== 0) sheetInk++;
    expect(sheetInk).toBeGreaterThan(200);
    let tiles = 0;
    for (let i = 0; i < LEN.MAP; i++) if (m.ram[ADDR.MAP + i] !== 0) tiles++;
    expect(tiles).toBeGreaterThan(100);
    expect(m.ram[ADDR.SPRITE_FLAGS + 5]).toBe(0x01);
    expect(m.ram[ADDR.SPRITE_FLAGS + 7]).toBe(0x02);
  });
});

describe("the PRNG lives in RAM", () => {
  it("uses exactly the state at RNG_STATE, decoded the way rngLoad decodes it", () => {
    let got = -1;
    const m = createMachine(cartOf((api) => (got = api.sys.rnd(1000))));
    m.boot(99);

    // Reference: read the same 16 bytes with core's own loader.
    const ref = coreRnd(rngLoad(m.ram, ADDR.RNG_STATE), 1000);
    m.tick(NO_INPUT);
    expect(got).toBe(ref);
  });

  it("writes the advanced state back to RAM on every call", () => {
    const m = createMachine(cartOf((api) => api.sys.rnd(256)));
    m.boot(5);
    const before = Array.from(m.ram.subarray(ADDR.RNG_STATE, ADDR.RNG_STATE + 16));
    m.tick(NO_INPUT);
    const after = Array.from(m.ram.subarray(ADDR.RNG_STATE, ADDR.RNG_STATE + 16));
    expect(after).not.toEqual(before);

    // And the sequence continues from RAM alone: a machine on a different seed,
    // handed those 16 bytes, takes the same step.
    const m2 = createMachine(cartOf((api) => api.sys.rnd(256)));
    m2.boot(999);
    m2.ram.set(Uint8Array.from(before), ADDR.RNG_STATE);
    m2.tick(NO_INPUT);
    expect(Array.from(m2.ram.subarray(ADDR.RNG_STATE, ADDR.RNG_STATE + 16))).toEqual(after);
  });

  it("honours a cart that pokes RNG_STATE mid-tick", () => {
    const seen: number[] = [];
    const m = createMachine(
      cartOf((api) => {
        seen.push(api.sys.rnd(1 << 20));
        for (let i = 0; i < 16; i++) api.sys.poke(ADDR.RNG_STATE + i, 0);
        api.sys.poke(ADDR.RNG_STATE, 1); // a state that is not all-zero
        seen.push(api.sys.rnd(1 << 20));
      }),
    );
    m.boot(1);
    m.tick(NO_INPUT);
    const probe = new Uint8Array(16);
    probe[0] = 1;
    expect(seen[1]).toBe(coreRnd(rngLoad(probe, 0), 1 << 20));
  });

  it("rndf stays a 16.16 fraction below 1.0", () => {
    const vals: number[] = [];
    const m = createMachine(
      cartOf((api) => {
        for (let i = 0; i < 64; i++) vals.push(api.sys.rndf());
      }),
    );
    m.boot(3);
    m.tick(NO_INPUT);
    for (const v of vals) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(65536);
      expect(Number.isInteger(v)).toBe(true);
    }
  });
});

describe("snapshot and restore", () => {
  it("takes a copy, not a view", () => {
    const m = createMachine(nullCart);
    m.boot(1);
    const snap = m.snapshot();
    m.ram[ADDR.USER_RAM] = 0x5a;
    expect(snap[ADDR.USER_RAM]).toBe(0);
    expect(snap.length).toBe(RAM_SIZE);
  });

  it("rejects a snapshot of the wrong size", () => {
    const m = createMachine(nullCart);
    m.boot(1);
    expect(() => m.restore(new Uint8Array(100))).toThrow();
  });

  it("rewinds the gradient cart exactly: 50 ticks, restore, 50 ticks again", () => {
    const m = createMachine(gradientCart);
    m.boot(0xc0ffee);

    const input = new Uint8Array(4);
    const script = (f: number): void => {
      // Enough motion and enough fresh A presses to exercise btn and btnp.
      input[0] =
        (f % 7 < 3 ? 1 << BTN.RIGHT : 0) |
        (f % 11 < 4 ? 1 << BTN.DOWN : 0) |
        (f % 5 === 0 ? 1 << BTN.A : 0);
    };

    for (let f = 0; f < 20; f++) {
      script(f);
      m.tick(input);
    }

    const snap = m.snapshot();

    for (let f = 20; f < 70; f++) {
      script(f);
      m.tick(input);
    }
    const firstHash = fbHash(m.ram);
    const firstRam = m.snapshot();

    m.restore(snap);
    for (let f = 20; f < 70; f++) {
      script(f);
      m.tick(input);
    }

    expect(fbHash(m.ram)).toBe(firstHash);
    expect(Array.from(m.ram)).toEqual(Array.from(firstRam));
  });

  it("rewinds the cart's own state, which is why the cart keeps it in RAM", () => {
    const m = createMachine(gradientCart);
    m.boot(4);
    const right = new Uint8Array([1 << BTN.RIGHT, 0, 0, 0]);
    for (let i = 0; i < 10; i++) m.tick(right);
    const snap = m.snapshot();
    const cursorAt10 = m.ram[ADDR.USER_RAM] as number;
    for (let i = 0; i < 10; i++) m.tick(right);
    expect(m.ram[ADDR.USER_RAM]).not.toBe(cursorAt10);
    m.restore(snap);
    expect(m.ram[ADDR.USER_RAM]).toBe(cursorAt10);
  });
});

describe("the gradient cart exercises the determinism-critical paths", () => {
  function run(seed: number, ticks: number, drive: boolean): number {
    const m = createMachine(gradientCart);
    m.boot(seed);
    const input = new Uint8Array(4);
    for (let f = 0; f < ticks; f++) {
      input[0] = drive ? (1 << BTN.RIGHT) | (f % 4 === 0 ? 1 << BTN.A : 0) : 0;
      m.tick(input);
    }
    return fbHash(m.ram);
  }

  it("is reproducible: the same seed, cart and inputs give the same framebuffer", () => {
    expect(run(1, 30, false)).toBe(run(1, 30, false));
    expect(run(1, 30, true)).toBe(run(1, 30, true));
  });

  it("depends on the seed (so it is really using the PRNG)", () => {
    expect(run(1, 30, false)).not.toBe(run(2, 30, false));
  });

  it("depends on the input (so it is really reading the buttons)", () => {
    expect(run(1, 30, false)).not.toBe(run(1, 30, true));
  });

  it("depends on the frame counter (so it is really animating)", () => {
    expect(run(1, 30, false)).not.toBe(run(1, 31, false));
  });

  it("presents a full screen of opaque pixels", () => {
    const m = createMachine(gradientCart);
    m.boot(1);
    m.tick(NO_INPUT);
    m.present();
    expect(m.rgba.length).toBe(16384);
    let nonZero = 0;
    const seen = new Set<number>();
    for (let i = 0; i < m.rgba.length; i++) {
      const p = m.rgba[i] as number;
      if (p !== 0) nonZero++;
      seen.add(p);
    }
    expect(nonZero).toBe(16384);
    expect(seen.size).toBeGreaterThan(3); // a gradient, not a flat fill
  });
});

/**
 * Allocation.
 *
 * A heap sample is NOT a usable detector here, and that was measured rather
 * than assumed: with --expose-gc, a forced collection either side of 1000 ticks
 * that each allocated a deliberate 2 KB buffer showed a heap delta well inside
 * any sane threshold, because a short-lived allocation is exactly what a
 * generational collector makes free. A test that green-lights the bug it exists
 * to catch is worse than no test, so it is not shipped.
 *
 * What is shipped is a counter. Every constructor a hot path could plausibly
 * reach for is wrapped for the duration of the loop, and the assertion is zero
 * constructions -- deterministic, and it fails the moment someone adds a
 * `new Uint8Array` to a primitive.
 *
 * What it does not see: object literals, array literals and closures, none of
 * which route through a global constructor. Those are held to by the two tests
 * after it and by reading the code.
 */
const COUNTED_CTORS = [
  "Array",
  "ArrayBuffer",
  "DataView",
  "Float32Array",
  "Float64Array",
  "Int8Array",
  "Int16Array",
  "Int32Array",
  "Map",
  "Set",
  "Uint8Array",
  "Uint16Array",
  "Uint32Array",
  "WeakMap",
] as const;

type Ctor = new (...args: never[]) => unknown;

function countingConstructions(body: () => void): number {
  const g = globalThis as unknown as Record<string, Ctor>;
  const saved = new Map<string, Ctor>();
  let count = 0;
  for (const name of COUNTED_CTORS) {
    const orig = g[name] as Ctor;
    saved.set(name, orig);
    g[name] = new Proxy(orig, {
      construct(target, args, newTarget): object {
        count++;
        return Reflect.construct(target, args, newTarget) as object;
      },
    }) as Ctor;
  }
  try {
    body();
  } finally {
    for (const [name, orig] of saved) g[name] = orig;
  }
  return count;
}

describe("allocation discipline", () => {
  it("1000 ticks and 1000 presents construct nothing", () => {
    const m = createMachine(gradientCart);
    m.boot(1);
    const input = new Uint8Array(4);
    for (let i = 0; i < 10; i++) m.tick(input); // warm up outside the probe

    const constructions = countingConstructions(() => {
      for (let i = 0; i < 1000; i++) {
        input[0] = i & 0xff;
        m.tick(input);
        m.present();
      }
    });

    expect(constructions).toBe(0);
  });

  /**
   * The same probe over the M4 primitives.
   *
   * The reference cart calls every one of them every frame -- lines, circles,
   * sprites, stretched sprites, the tile map, text, camera, palt and the memory
   * block calls in boot -- so one loop covers the whole new surface. If someone
   * adds a `new Uint8Array` to a blit or a scratch array to `print`, this is what
   * goes red, and it goes red deterministically rather than depending on when a
   * generational collector felt like running.
   */
  it("1000 ticks of the reference cart construct nothing", () => {
    const m = createMachine(referenceCart);
    m.boot(1);
    const input = new Uint8Array(4);
    for (let i = 0; i < 10; i++) m.tick(input);

    const constructions = countingConstructions(() => {
      for (let i = 0; i < 1000; i++) {
        m.tick(input);
        m.present();
      }
    });

    expect(constructions).toBe(0);
  });

  it("constructs nothing in the primitives a cart can call directly", () => {
    // Belt and braces: the reference cart above exercises them through the ABI,
    // this exercises the edges it does not -- flips, empty clips, off-screen
    // coordinates and the paths that take the general blit rather than the fast
    // one.
    const m = createMachine(
      cartOf((api) => {
        const { gfx, sys } = api;
        gfx.camera(sys.frame() & 7, 3);
        gfx.palt(4, (sys.frame() & 1) === 0);
        gfx.clip(1, 1, 120, 120);
        gfx.cls(2);
        gfx.line(-300, -300, 400, 500, 3);
        gfx.line(400, 500, -300, -300, 3);
        gfx.circ(-10, -10, 90, 4, true);
        gfx.circ(200, 200, 90, 4, false);
        gfx.spr(9, -3, -3, 3, 3, true, true);
        gfx.spr(9, 121, 121, 3, 3, false, true);
        gfx.sspr(0, 0, 16, 16, -5, -5, 40, 7, true, false);
        gfx.map(0, 0, -9, -9, 40, 20, 1);
        gfx.print("The quick brown fox, 0123456789!\nsecond line", -6, 100, 7);
        gfx.clip(0, 0, 0, 0);
        gfx.rect(0, 0, 128, 128, 9, true);
        gfx.clip(0, 0, 128, 128);
        sys.memcpy(ADDR.USER_RAM, ADDR.SPRITES, 512);
        sys.memset(ADDR.USER_RAM + 512, 7, 512);
        sys.trace("no sink", 1);
      }),
    );
    m.boot(1);
    for (let i = 0; i < 10; i++) m.tick(NO_INPUT);

    const constructions = countingConstructions(() => {
      for (let i = 0; i < 300; i++) {
        m.tick(NO_INPUT);
        m.present();
      }
    });

    expect(constructions).toBe(0);
  });

  it("the allocation probe actually detects an allocation", () => {
    // Guards the guard: if the wrapping ever stops working, this goes red first.
    const n = countingConstructions(() => {
      for (let i = 0; i < 5; i++) new Uint8Array(8);
    });
    expect(n).toBe(5);
  });

  it("holds no per-tick references: RAM and rgba are the same objects throughout", () => {
    const m = createMachine(gradientCart);
    m.boot(1);
    const ram = m.ram;
    const rgba = m.rgba;
    for (let i = 0; i < 100; i++) {
      m.tick(NO_INPUT);
      m.present();
    }
    expect(m.ram).toBe(ram);
    expect(m.rgba).toBe(rgba);
  });

  it("hands the cart the identical api object on every tick", () => {
    const seen = new Set<unknown>();
    const m = createMachine(cartOf((api) => seen.add(api), (api) => seen.add(api)));
    m.boot(1);
    for (let i = 0; i < 10; i++) m.tick(NO_INPUT);
    expect(seen.size).toBe(1);
  });
});
