import { describe, expect, it } from "vitest";

import {
  ADDR,
  FB_STRIDE,
  HW_COLORS,
  LEN,
  LIVE_COLORS,
  MAP_W,
  RAM_SIZE,
  SCREEN_H,
  SCREEN_W,
} from "../src/memory";
import {
  HW_PALETTE,
  LITTLE_ENDIAN,
  buildLut,
  defaultLive,
  regenerateHwPalette,
  writeLut,
} from "../src/palette";
import {
  ADDR_PALT,
  PALT_DEFAULT,
  SHEET_H,
  SHEET_STRIDE,
  SHEET_W,
  blit,
  camX,
  camY,
  camera,
  circ,
  clip,
  clipReset,
  cls,
  inClip,
  line,
  map,
  palt,
  paltMask,
  paltReset,
  pget,
  present,
  print,
  pset,
  rect,
  setSheetPixel,
  sheetPixel,
  spr,
  sspr,
} from "../src/raster";

function freshRam(): Uint8Array {
  const ram = new Uint8Array(RAM_SIZE);
  clipReset(ram);
  return ram;
}

/** A machine with the boot transparency mask: colour 0 transparent. */
function spriteRam(): Uint8Array {
  const ram = freshRam();
  paltReset(ram);
  return ram;
}

/** A copy of the framebuffer, for the many "these two draws agree" assertions. */
function fbOf(ram: Uint8Array): Uint8Array {
  return ram.slice(ADDR.FRAMEBUFFER, ADDR.FRAMEBUFFER + LEN.FRAMEBUFFER);
}

function expectSameFb(a: Uint8Array, b: Uint8Array, why: string): void {
  const fa = fbOf(a);
  const fb = fbOf(b);
  for (let i = 0; i < fa.length; i++) {
    if (fa[i] !== fb[i]) {
      const x = ((i % FB_STRIDE) * 2) | 0;
      const y = (i / FB_STRIDE) | 0;
      throw new Error(`${why}: byte ${i} (around pixel ${x},${y}) is ${fb[i]}, expected ${fa[i]}`);
    }
  }
}

/** Every pixel of the framebuffer that is not `c`. */
function countNot(ram: Uint8Array, c: number): number {
  let n = 0;
  for (let y = 0; y < SCREEN_H; y++) {
    for (let x = 0; x < SCREEN_W; x++) if (pget(ram, x, y) !== c) n++;
  }
  return n;
}

/**
 * Fill the sprite sheet with a pattern in which every pixel is a function of its
 * position, so a blit that reads one pixel too far left, one row too high or
 * from the wrong cell produces a visibly wrong colour rather than a plausible
 * one. Colour 0 appears on a diagonal, so transparency is exercised too.
 */
function paintSheet(ram: Uint8Array): void {
  for (let py = 0; py < SHEET_H; py++) {
    for (let px = 0; px < SHEET_W; px++) {
      const v = px === py % SHEET_W ? 0 : ((px * 5 + py * 3) % 15) + 1;
      setSheetPixel(ram, px, py, v);
    }
  }
}

/** Sprite n's top-left pixel in the sheet, per the documented 16 x 16 grid. */
function spriteOrigin(n: number): readonly [number, number] {
  return [(n & 15) * 8, (n >> 4) * 8];
}

/** Count framebuffer pixels of a given colour. */
function countColor(ram: Uint8Array, c: number): number {
  let n = 0;
  for (let y = 0; y < SCREEN_H; y++) {
    for (let x = 0; x < SCREEN_W; x++) if (pget(ram, x, y) === c) n++;
  }
  return n;
}

describe("pixel packing", () => {
  it("puts an EVEN x in the low nibble and an odd x in the high nibble", () => {
    const ram = freshRam();
    pset(ram, 0, 0, 0x0a);
    expect(ram[ADDR.FRAMEBUFFER]).toBe(0x0a);
    pset(ram, 1, 0, 0x0b);
    expect(ram[ADDR.FRAMEBUFFER]).toBe(0xba);
  });

  it("writing one pixel never disturbs its neighbour in the same byte", () => {
    const ram = freshRam();
    pset(ram, 4, 3, 0x07);
    pset(ram, 5, 3, 0x03);
    expect(pget(ram, 4, 3)).toBe(0x07);
    expect(pget(ram, 5, 3)).toBe(0x03);
    pset(ram, 4, 3, 0x01);
    expect(pget(ram, 5, 3)).toBe(0x03);
    pset(ram, 5, 3, 0x0f);
    expect(pget(ram, 4, 3)).toBe(0x01);
  });

  it("steps one stride of 64 bytes per row", () => {
    const ram = freshRam();
    pset(ram, 0, 1, 0x05);
    expect(ram[ADDR.FRAMEBUFFER + FB_STRIDE]).toBe(0x05);
    expect(ram[ADDR.FRAMEBUFFER]).toBe(0);
    pset(ram, 127, 127, 0x09);
    expect(ram[ADDR.FRAMEBUFFER + LEN.FRAMEBUFFER - 1]).toBe(0x90);
  });

  it("round-trips every colour at every parity", () => {
    const ram = freshRam();
    for (let c = 0; c < 16; c++) {
      pset(ram, 10, 10, c);
      pset(ram, 11, 10, 15 - c);
      expect(pget(ram, 10, 10)).toBe(c);
      expect(pget(ram, 11, 10)).toBe(15 - c);
    }
  });

  it("pget outside the screen reads 0 and never throws", () => {
    const ram = freshRam();
    cls(ram, 0x0f);
    expect(pget(ram, -1, 0)).toBe(0);
    expect(pget(ram, 0, -1)).toBe(0);
    expect(pget(ram, SCREEN_W, 0)).toBe(0);
    expect(pget(ram, 0, SCREEN_H)).toBe(0);
  });
});

describe("cls", () => {
  it("fills all 8192 framebuffer bytes with the doubled nibble", () => {
    const ram = freshRam();
    cls(ram, 0x03);
    for (let i = 0; i < LEN.FRAMEBUFFER; i++) {
      expect(ram[ADDR.FRAMEBUFFER + i], `byte ${i}`).toBe(0x33);
    }
    expect(countColor(ram, 3)).toBe(SCREEN_W * SCREEN_H);
  });

  it("touches nothing past the framebuffer", () => {
    const ram = freshRam();
    ram[ADDR.PALETTE_HW] = 0x77;
    cls(ram, 0x0f);
    expect(ram[ADDR.PALETTE_HW]).toBe(0x77);
    expect(ram[LEN.FRAMEBUFFER]).toBe(0x77); // PALETTE_HW is the next byte along
  });

  it("ignores the clip rectangle, by design", () => {
    const ram = freshRam();
    clip(ram, 10, 10, 4, 4);
    cls(ram, 0x02);
    expect(countColor(ram, 2)).toBe(SCREEN_W * SCREEN_H);
  });

  it("works on an unaligned RAM view (byte fallback path)", () => {
    const backing = new Uint8Array(RAM_SIZE + 1);
    const ram = backing.subarray(1);
    cls(ram, 0x06);
    expect(ram[0]).toBe(0x66);
    expect(ram[LEN.FRAMEBUFFER - 1]).toBe(0x66);
    expect(backing[0]).toBe(0);
  });
});

describe("clip", () => {
  it("writes inclusive bounds into the CLIP region", () => {
    const ram = freshRam();
    clip(ram, 8, 16, 32, 64);
    expect(ram[ADDR.CLIP + 0]).toBe(8);
    expect(ram[ADDR.CLIP + 1]).toBe(16);
    expect(ram[ADDR.CLIP + 2]).toBe(39);
    expect(ram[ADDR.CLIP + 3]).toBe(79);
  });

  it("clamps to the screen", () => {
    const ram = freshRam();
    clip(ram, -10, -10, 1000, 1000);
    expect(Array.from(ram.subarray(ADDR.CLIP, ADDR.CLIP + 4))).toEqual([0, 0, 127, 127]);
  });

  it("encodes an empty rectangle as x1 < x0", () => {
    const ram = freshRam();
    clip(ram, 10, 10, 0, 5);
    expect(ram[ADDR.CLIP + 2] as number).toBeLessThan(ram[ADDR.CLIP + 0] as number);
    expect(inClip(ram, 10, 10)).toBe(false);
  });

  it("clipReset opens the whole screen", () => {
    const ram = freshRam();
    clip(ram, 4, 4, 4, 4);
    clipReset(ram);
    expect(inClip(ram, 0, 0)).toBe(true);
    expect(inClip(ram, 127, 127)).toBe(true);
    expect(inClip(ram, 128, 0)).toBe(false);
  });
});

describe("rect", () => {
  it("fills exactly w*h pixels and nothing else", () => {
    const ram = freshRam();
    rect(ram, 3, 5, 7, 11, 0x0c, true);
    expect(countColor(ram, 0x0c)).toBe(7 * 11);
    expect(pget(ram, 3, 5)).toBe(0x0c);
    expect(pget(ram, 9, 15)).toBe(0x0c);
    expect(pget(ram, 2, 5)).toBe(0);
    expect(pget(ram, 10, 5)).toBe(0);
    expect(pget(ram, 3, 4)).toBe(0);
    expect(pget(ram, 3, 16)).toBe(0);
  });

  it("fills correctly at every start/end parity", () => {
    for (const x of [0, 1, 2, 3]) {
      for (const w of [1, 2, 3, 4, 5]) {
        const ram = freshRam();
        rect(ram, x, 2, w, 1, 0x0d, true);
        expect(countColor(ram, 0x0d), `x=${x} w=${w}`).toBe(w);
        expect(pget(ram, x, 2)).toBe(0x0d);
        expect(pget(ram, x + w - 1, 2)).toBe(0x0d);
        if (x > 0) expect(pget(ram, x - 1, 2)).toBe(0);
        expect(pget(ram, x + w, 2)).toBe(0);
      }
    }
  });

  it("draws an outline as a hollow box", () => {
    const ram = freshRam();
    rect(ram, 10, 10, 6, 5, 0x08, false);
    expect(countColor(ram, 0x08)).toBe(6 * 2 + (5 - 2) * 2);
    expect(pget(ram, 10, 10)).toBe(0x08);
    expect(pget(ram, 15, 14)).toBe(0x08);
    expect(pget(ram, 12, 12)).toBe(0); // hollow middle
  });

  it("clips a rect that hangs off every edge of the screen", () => {
    const ram = freshRam();
    rect(ram, -5, -5, SCREEN_W + 10, SCREEN_H + 10, 0x04, true);
    expect(countColor(ram, 0x04)).toBe(SCREEN_W * SCREEN_H);
    for (let i = LEN.FRAMEBUFFER; i < LEN.FRAMEBUFFER + 16; i++) {
      expect(ram[i], `byte ${i} past the framebuffer`).toBe(0);
    }
  });

  it("honours the clip rectangle and corrupts no neighbouring pixel", () => {
    const ram = freshRam();
    cls(ram, 0x01);
    clip(ram, 20, 20, 8, 8);
    rect(ram, 0, 0, SCREEN_W, SCREEN_H, 0x0e, true);
    expect(countColor(ram, 0x0e)).toBe(64);
    expect(pget(ram, 20, 20)).toBe(0x0e);
    expect(pget(ram, 27, 27)).toBe(0x0e);
    expect(pget(ram, 19, 20)).toBe(0x01);
    expect(pget(ram, 28, 20)).toBe(0x01);
    expect(pget(ram, 20, 19)).toBe(0x01);
    expect(pget(ram, 20, 28)).toBe(0x01);
  });

  it("draws nothing at all through an empty clip", () => {
    const ram = freshRam();
    clip(ram, 0, 0, 0, 0);
    rect(ram, 0, 0, SCREEN_W, SCREEN_H, 0x0f, true);
    expect(countColor(ram, 0x0f)).toBe(0);
  });

  it("ignores non-positive sizes", () => {
    const ram = freshRam();
    rect(ram, 5, 5, 0, 10, 0x0f, true);
    rect(ram, 5, 5, 10, -1, 0x0f, true);
    expect(countColor(ram, 0x0f)).toBe(0);
  });
});

describe("hardware palette", () => {
  it("has 64 entries of RGB888", () => {
    expect(HW_PALETTE.length).toBe(HW_COLORS * 3);
    expect(HW_PALETTE.length).toBe(LEN.PALETTE_HW);
  });

  it("reproduces the specification's reference palette in entries 0-15", () => {
    const spec = [
      0x0d0b12, 0x1c1a2b, 0x3a3550, 0x6b6486, 0xa8a2bd, 0xe8e6f0, 0xffffff, 0x7f2b4a, 0xd94f5c,
      0xf2934a, 0xf7d46b, 0x3f7d4e, 0x6ec27a, 0x2c5f8a, 0x4a9dd4, 0x9b6fd4,
    ];
    for (let i = 0; i < 16; i++) {
      const rgb =
        ((HW_PALETTE[i * 3] as number) << 16) |
        ((HW_PALETTE[i * 3 + 1] as number) << 8) |
        (HW_PALETTE[i * 3 + 2] as number);
      expect(rgb.toString(16).padStart(6, "0")).toBe((spec[i] as number).toString(16).padStart(6, "0"));
    }
  });

  it("regenerates byte-identically from the documented integer formula", () => {
    const again = regenerateHwPalette();
    expect(again.length).toBe(HW_PALETTE.length);
    for (let i = 0; i < HW_PALETTE.length; i++) {
      expect(again[i], `byte ${i}`).toBe(HW_PALETTE[i]);
    }
  });

  it("derives entries 16-63 by the darken, lighten and grey formulas", () => {
    for (let i = 0; i < 16; i++) {
      const r = HW_PALETTE[i * 3 + 0] as number;
      const g = HW_PALETTE[i * 3 + 1] as number;
      const b = HW_PALETTE[i * 3 + 2] as number;
      const y = (77 * r + 150 * g + 29 * b) >> 8;

      expect(HW_PALETTE[(16 + i) * 3 + 0]).toBe((r * 5) >> 3);
      expect(HW_PALETTE[(16 + i) * 3 + 1]).toBe((g * 5) >> 3);
      expect(HW_PALETTE[(16 + i) * 3 + 2]).toBe((b * 5) >> 3);

      expect(HW_PALETTE[(32 + i) * 3 + 0]).toBe(r + (((255 - r) * 3) >> 3));
      expect(HW_PALETTE[(48 + i) * 3 + 2]).toBe((b + y) >> 1);
    }
  });

  it("keeps every channel a byte, and darkens/lightens in the right direction", () => {
    for (let i = 0; i < HW_PALETTE.length; i++) {
      const v = HW_PALETTE[i] as number;
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(255);
    }
    for (let i = 0; i < 48; i++) {
      const base = HW_PALETTE[i] as number;
      expect(HW_PALETTE[48 + i] as number).toBeLessThanOrEqual(base); // dark ramp
      expect(HW_PALETTE[96 + i] as number).toBeGreaterThanOrEqual(base); // light ramp
    }
  });

  it("defaultLive is the identity", () => {
    const live = defaultLive();
    expect(live.length).toBe(LIVE_COLORS);
    for (let i = 0; i < LIVE_COLORS; i++) expect(live[i]).toBe(i);
  });
});

describe("buildLut", () => {
  function ramWithPalette(): Uint8Array {
    const ram = freshRam();
    ram.set(HW_PALETTE, ADDR.PALETTE_HW);
    ram.set(defaultLive(), ADDR.PALETTE_LIVE);
    return ram;
  }

  it("packs RGBA in the platform's byte order with a full alpha", () => {
    const ram = ramWithPalette();
    const lut = buildLut(ram);
    expect(lut.length).toBe(LIVE_COLORS);

    // Entry 6 is #ffffff, so every channel and alpha is 0xff either way round.
    expect(lut[6]).toBe(0xffffffff >>> 0);

    // Entry 8 is #d94f5c.
    const expected8 = LITTLE_ENDIAN
      ? ((0xff << 24) | (0x5c << 16) | (0x4f << 8) | 0xd9) >>> 0
      : ((0xd9 << 24) | (0x4f << 16) | (0x5c << 8) | 0xff) >>> 0;
    expect(lut[8]).toBe(expected8);
  });

  it("follows PALETTE_LIVE into the hardware palette", () => {
    const ram = ramWithPalette();
    ram[ADDR.PALETTE_LIVE + 1] = 6; // slot 1 now shows white
    const lut = buildLut(ram);
    expect(lut[1]).toBe(0xffffffff >>> 0);
    expect(lut[0]).not.toBe(lut[1]);
  });

  it("masks an out-of-range live index instead of reading past the palette", () => {
    const ram = ramWithPalette();
    ram[ADDR.PALETTE_LIVE + 2] = 200; // 200 & 63 = 8
    const lut = buildLut(ram);
    const ref = buildLut(((): Uint8Array => {
      const r2 = ramWithPalette();
      r2[ADDR.PALETTE_LIVE + 2] = 8;
      return r2;
    })());
    expect(lut[2]).toBe(ref[2]);
  });

  it("writeLut fills a preallocated array identically", () => {
    const ram = ramWithPalette();
    const lut = new Uint32Array(LIVE_COLORS);
    writeLut(ram, lut);
    expect(Array.from(lut)).toEqual(Array.from(buildLut(ram)));
  });
});

describe("present", () => {
  it("expands 8192 packed bytes into 16384 RGBA pixels, low nibble first", () => {
    const ram = freshRam();
    ram.set(HW_PALETTE, ADDR.PALETTE_HW);
    ram.set(defaultLive(), ADDR.PALETTE_LIVE);
    cls(ram, 0);
    pset(ram, 0, 0, 6); // white, even x -> low nibble -> first pixel out
    pset(ram, 1, 0, 8);
    pset(ram, 127, 127, 6);

    const lut = buildLut(ram);
    const out = new Uint32Array(SCREEN_W * SCREEN_H);
    present(ram, out, lut);

    expect(out.length).toBe(16384);
    expect(out[0]).toBe(lut[6]);
    expect(out[1]).toBe(lut[8]);
    expect(out[2]).toBe(lut[0]);
    expect(out[SCREEN_W * SCREEN_H - 1]).toBe(lut[6]);
  });

  it("maps a full-screen clear to one repeated colour", () => {
    const ram = freshRam();
    ram.set(HW_PALETTE, ADDR.PALETTE_HW);
    ram.set(defaultLive(), ADDR.PALETTE_LIVE);
    cls(ram, 0x0b);
    const lut = buildLut(ram);
    const out = new Uint32Array(SCREEN_W * SCREEN_H);
    present(ram, out, lut);
    for (let i = 0; i < out.length; i++) expect(out[i]).toBe(lut[0x0b]);
  });

  it("reflects a live-palette swap without touching the framebuffer", () => {
    const ram = freshRam();
    ram.set(HW_PALETTE, ADDR.PALETTE_HW);
    ram.set(defaultLive(), ADDR.PALETTE_LIVE);
    cls(ram, 1);
    const out = new Uint32Array(SCREEN_W * SCREEN_H);
    const lut = new Uint32Array(LIVE_COLORS);

    writeLut(ram, lut);
    present(ram, out, lut);
    const before = out[0] as number;

    const fbCopy = ram.slice(ADDR.FRAMEBUFFER, ADDR.FRAMEBUFFER + LEN.FRAMEBUFFER);
    ram[ADDR.PALETTE_LIVE + 1] = 6;
    writeLut(ram, lut);
    present(ram, out, lut);

    expect(out[0]).not.toBe(before);
    expect(Array.from(ram.slice(ADDR.FRAMEBUFFER, ADDR.FRAMEBUFFER + LEN.FRAMEBUFFER))).toEqual(
      Array.from(fbCopy),
    );
  });
});

// ---------------------------------------------------------------------------
// CAMERA
// ---------------------------------------------------------------------------

describe("camera", () => {
  it("stores two i16 little-endian at ADDR.CAMERA", () => {
    const ram = freshRam();
    camera(ram, 258, -2);
    expect(ram[ADDR.CAMERA + 0]).toBe(0x02);
    expect(ram[ADDR.CAMERA + 1]).toBe(0x01);
    expect(ram[ADDR.CAMERA + 2]).toBe(0xfe);
    expect(ram[ADDR.CAMERA + 3]).toBe(0xff);
    expect(camX(ram)).toBe(258);
    expect(camY(ram)).toBe(-2);
  });

  it("round-trips the whole i16 range and clamps beyond it", () => {
    const ram = freshRam();
    for (const v of [-32768, -1, 0, 1, 32767]) {
      camera(ram, v, -v > 32767 ? 32767 : -v);
      expect(camX(ram)).toBe(v);
    }
    camera(ram, 1e9, -1e9);
    expect(camX(ram)).toBe(32767);
    expect(camY(ram)).toBe(-32768);
  });

  it("offsets every positional primitive by the same amount", () => {
    const draw = (ram: Uint8Array, ox: number, oy: number): void => {
      cls(ram, 0);
      rect(ram, 10 + ox, 12 + oy, 6, 5, 3, true);
      rect(ram, 30 + ox, 12 + oy, 6, 5, 4, false);
      line(ram, 8 + ox, 40 + oy, 60 + ox, 70 + oy, 5);
      circ(ram, 90 + ox, 40 + oy, 9, 6, false);
      circ(ram, 90 + ox, 70 + oy, 5, 7, true);
      print(ram, "Hi!", 4 + ox, 100 + oy, 8);
      spr(ram, 3, 70 + ox, 100 + oy, 1, 1, false, false);
      sspr(ram, 0, 0, 8, 8, 100 + ox, 100 + oy, 12, 12, false, false);
      map(ram, 0, 0, 2 + ox, 116 + oy, 4, 1, 0);
    };

    const a = spriteRam();
    paintSheet(a);
    a[ADDR.MAP + 0] = 5;
    a[ADDR.MAP + 1] = 6;
    draw(a, 0, 0);

    const b = spriteRam();
    paintSheet(b);
    b[ADDR.MAP + 0] = 5;
    b[ADDR.MAP + 1] = 6;
    camera(b, -7, 3);
    draw(b, -7, 3);

    expectSameFb(a, b, "camera offset");
  });

  it("does not move cls or the clip rectangle", () => {
    const ram = freshRam();
    camera(ram, 40, 40);
    cls(ram, 9);
    expect(countNot(ram, 9)).toBe(0);
    clip(ram, 10, 10, 4, 4);
    expect(Array.from(ram.subarray(ADDR.CLIP, ADDR.CLIP + 4))).toEqual([10, 10, 13, 13]);
  });
});

// ---------------------------------------------------------------------------
// TRANSPARENCY
// ---------------------------------------------------------------------------

describe("palt", () => {
  it("lives in the reserved gap at 0x20E8, as two little-endian bytes", () => {
    expect(ADDR_PALT).toBe(0x20e8);
    // Inside the reserved block between CAMERA and INPUT_NOW, so it collides
    // with no declared region and travels inside a snapshot.
    expect(ADDR_PALT).toBeGreaterThanOrEqual(ADDR.CAMERA + LEN.CAMERA);
    expect(ADDR_PALT + 2).toBeLessThanOrEqual(ADDR.INPUT_NOW);

    const ram = freshRam();
    paltReset(ram);
    expect(ram[ADDR_PALT]).toBe(0x01);
    expect(ram[ADDR_PALT + 1]).toBe(0x00);
    expect(paltMask(ram)).toBe(PALT_DEFAULT);

    palt(ram, 15, true);
    expect(ram[ADDR_PALT + 1]).toBe(0x80);
    expect(paltMask(ram)).toBe(0x8001);
  });

  it("sets and clears one colour at a time", () => {
    const ram = freshRam();
    paltReset(ram);
    palt(ram, 0, false);
    expect(paltMask(ram)).toBe(0);
    for (let c = 0; c < 16; c++) palt(ram, c, true);
    expect(paltMask(ram)).toBe(0xffff);
    palt(ram, 7, false);
    expect(paltMask(ram)).toBe(0xff7f);
    paltReset(ram);
    expect(paltMask(ram)).toBe(1);
  });

  it("decides which sprite pixels reach the screen", () => {
    const ram = spriteRam();
    for (let py = 0; py < 8; py++) for (let px = 0; px < 8; px++) setSheetPixel(ram, px, py, py & 1);
    cls(ram, 5);
    spr(ram, 0, 0, 0, 1, 1, false, false);
    // Odd rows are colour 1 and land; even rows are colour 0 and do not.
    expect(pget(ram, 0, 0)).toBe(5);
    expect(pget(ram, 0, 1)).toBe(1);

    palt(ram, 0, false);
    palt(ram, 1, true);
    cls(ram, 5);
    spr(ram, 0, 0, 0, 1, 1, false, false);
    expect(pget(ram, 0, 0)).toBe(0);
    expect(pget(ram, 0, 1)).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// THE SPRITE SHEET
// ---------------------------------------------------------------------------

describe("the sprite sheet is a 128x128 picture", () => {
  it("addresses a pixel the same way the framebuffer does, from a different base", () => {
    expect(SHEET_W).toBe(128);
    expect(SHEET_H).toBe(128);
    expect(SHEET_STRIDE).toBe(FB_STRIDE);
    // 8192 bytes at two pixels a byte is exactly one 128 x 128 picture.
    expect(SHEET_W * SHEET_H).toBe(LEN.SPRITES * 2);

    const ram = freshRam();
    setSheetPixel(ram, 0, 0, 0x0a);
    expect(ram[ADDR.SPRITES]).toBe(0x0a);
    setSheetPixel(ram, 1, 0, 0x0b);
    expect(ram[ADDR.SPRITES]).toBe(0xba);
    setSheetPixel(ram, 127, 127, 0x09);
    expect(ram[ADDR.SPRITES + LEN.SPRITES - 1]).toBe(0x90);
    expect(sheetPixel(ram, 127, 127)).toBe(9);
  });

  it("reads and writes nothing outside the sheet", () => {
    const ram = freshRam();
    ram.fill(0x77, ADDR.SPRITE_FLAGS, ADDR.SPRITE_FLAGS + 16);
    setSheetPixel(ram, 128, 0, 0x0f);
    setSheetPixel(ram, 0, 128, 0x0f);
    setSheetPixel(ram, -1, -1, 0x0f);
    expect(ram[ADDR.SPRITE_FLAGS]).toBe(0x77);
    expect(sheetPixel(ram, -1, 0)).toBe(0);
    expect(sheetPixel(ram, 0, 128)).toBe(0);
  });

  it("puts sprite n in grid cell (n & 15, n >> 4)", () => {
    for (const n of [0, 1, 15, 16, 17, 128, 255]) {
      const [ox, oy] = spriteOrigin(n);
      const ram = spriteRam();
      palt(ram, 0, false);
      // A single marker pixel at the sprite's own top-left.
      setSheetPixel(ram, ox, oy, 0x0e);
      cls(ram, 0);
      spr(ram, n, 20, 30, 1, 1, false, false);
      expect(pget(ram, 20, 30), `sprite ${n} origin`).toBe(0x0e);
    }
  });
});

describe("spr", () => {
  it("copies an 8x8 cell exactly, pixel for pixel", () => {
    const ram = spriteRam();
    paintSheet(ram);
    palt(ram, 0, false);
    cls(ram, 0);
    const n = 0x25;
    const [ox, oy] = spriteOrigin(n);
    spr(ram, n, 40, 50, 1, 1, false, false);
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        expect(pget(ram, 40 + x, 50 + y), `${x},${y}`).toBe(sheetPixel(ram, ox + x, oy + y));
      }
    }
  });

  it("draws w x h cells as one contiguous region of the sheet", () => {
    const ram = spriteRam();
    paintSheet(ram);
    palt(ram, 0, false);
    cls(ram, 0);
    spr(ram, 0x11, 8, 8, 3, 2, false, false);
    const [ox, oy] = spriteOrigin(0x11);
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 24; x++) {
        expect(pget(ram, 8 + x, 8 + y), `${x},${y}`).toBe(sheetPixel(ram, ox + x, oy + y));
      }
    }
  });

  it("truncates at the sheet edge instead of wrapping to the next row of cells", () => {
    const ram = spriteRam();
    paintSheet(ram);
    palt(ram, 0, false);
    cls(ram, 0);
    // Sprite 15 sits at x = 120, so a 2-cell-wide draw has only one cell of
    // sheet to read. The second cell must stay unpainted, not show column 0.
    spr(ram, 15, 0, 0, 2, 1, false, false);
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) expect(pget(ram, x, y)).toBe(sheetPixel(ram, 120 + x, y));
      for (let x = 8; x < 16; x++) expect(pget(ram, x, y), `${x},${y} should be untouched`).toBe(0);
    }
  });

  it("mirrors in x, in y and in both", () => {
    const ram = spriteRam();
    paintSheet(ram);
    palt(ram, 0, false);
    const [ox, oy] = spriteOrigin(7);
    cls(ram, 0);
    spr(ram, 7, 0, 0, 1, 1, true, false);
    spr(ram, 7, 16, 0, 1, 1, false, true);
    spr(ram, 7, 32, 0, 1, 1, true, true);
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        expect(pget(ram, x, y), `fx ${x},${y}`).toBe(sheetPixel(ram, ox + 7 - x, oy + y));
        expect(pget(ram, 16 + x, y), `fy ${x},${y}`).toBe(sheetPixel(ram, ox + x, oy + 7 - y));
        expect(pget(ram, 32 + x, y), `both ${x},${y}`).toBe(sheetPixel(ram, ox + 7 - x, oy + 7 - y));
      }
    }
  });

  it("draws the same shape at an odd x as at an even one", () => {
    const a = spriteRam();
    paintSheet(a);
    palt(a, 0, false);
    cls(a, 0);
    spr(a, 0x31, 20, 10, 2, 2, false, false);

    const b = spriteRam();
    paintSheet(b);
    palt(b, 0, false);
    cls(b, 0);
    spr(b, 0x31, 21, 10, 2, 2, false, false);

    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) {
        expect(pget(b, 21 + x, 10 + y), `${x},${y}`).toBe(pget(a, 20 + x, 10 + y));
      }
    }
  });

  /**
   * THE FAST PATH. Everything about the whole-byte blit is a claim that it
   * agrees with the general one, so the test forces both to run over the same
   * pixels and diffs the framebuffers.
   *
   * The slow path is provoked by marking a colour transparent that the sprite
   * does not contain: the mask is then non-zero, so `blit` takes the per-pixel
   * branch, but no pixel is actually skipped and the picture must be identical.
   */
  it("agrees pixel-for-pixel between the whole-byte path and the general one", () => {
    // A sheet with colour 1 scrubbed out of it, so marking colour 1 transparent
    // changes which PATH runs (the mask stops being zero) without changing a
    // single pixel of the result. Any difference is the fast path's fault.
    const scrub = (ram: Uint8Array): void => {
      paintSheet(ram);
      for (let py = 0; py < SHEET_H; py++) {
        for (let px = 0; px < SHEET_W; px++) {
          if (sheetPixel(ram, px, py) === 1) setSheetPixel(ram, px, py, 2);
          if (sheetPixel(ram, px, py) === 0) setSheetPixel(ram, px, py, 3);
        }
      }
    };

    for (const dx of [0, 1, 2, 3, 60, 61, -3, -4, 120, 121]) {
      for (const w of [1, 2, 3]) {
        const fast = spriteRam();
        scrub(fast);
        fast[ADDR_PALT] = 0; // nothing transparent -> the whole-byte path
        fast[ADDR_PALT + 1] = 0;
        cls(fast, 2);
        spr(fast, 0x42, dx, 30, w, 1, false, false);

        const slow = spriteRam();
        scrub(slow);
        palt(slow, 0, false);
        palt(slow, 1, true); // a non-zero mask over a colour that is not there
        cls(slow, 2);
        spr(slow, 0x42, dx, 30, w, 1, false, false);

        expect(paltMask(fast)).toBe(0);
        expect(paltMask(slow)).not.toBe(0);
        expectSameFb(fast, slow, `spr at x=${dx} w=${w}`);
      }
    }
  });

  it("clips against CLIP and never writes past the framebuffer", () => {
    const ram = spriteRam();
    paintSheet(ram);
    palt(ram, 0, false);
    ram.fill(0x5a, LEN.FRAMEBUFFER, LEN.FRAMEBUFFER + 64);
    cls(ram, 0);
    clip(ram, 40, 40, 8, 8);
    spr(ram, 1, 36, 36, 2, 2, false, false);
    let lit = 0;
    for (let y = 0; y < SCREEN_H; y++) {
      for (let x = 0; x < SCREEN_W; x++) {
        if (pget(ram, x, y) !== 0) {
          lit++;
          expect(x).toBeGreaterThanOrEqual(40);
          expect(x).toBeLessThanOrEqual(47);
          expect(y).toBeGreaterThanOrEqual(40);
          expect(y).toBeLessThanOrEqual(47);
        }
      }
    }
    expect(lit).toBeGreaterThan(0);
    for (let i = LEN.FRAMEBUFFER; i < LEN.FRAMEBUFFER + 64; i++) expect(ram[i]).toBe(0x5a);
  });

  it("survives absurd coordinates and sizes without touching anything", () => {
    const ram = spriteRam();
    paintSheet(ram);
    cls(ram, 3);
    expect(() => {
      spr(ram, 1, -1e9, -1e9, 40, 40, false, false);
      spr(ram, 1, 1e9, 1e9, 40, 40, true, true);
      spr(ram, 1, 0, 0, 0, 0, false, false);
      spr(ram, 1, 0, 0, -5, -5, false, false);
      blit(ram, 0, 0, 0, 0, 0, 0, false, false);
    }).not.toThrow();
    expect(countNot(ram, 3)).toBe(0);
  });

  it("masks a sprite index to a byte rather than reading past the sheet", () => {
    const a = spriteRam();
    paintSheet(a);
    palt(a, 0, false);
    cls(a, 0);
    spr(a, 0x142, 10, 10, 1, 1, false, false); // 0x142 & 0xff = 0x42

    const b = spriteRam();
    paintSheet(b);
    palt(b, 0, false);
    cls(b, 0);
    spr(b, 0x42, 10, 10, 1, 1, false, false);

    expectSameFb(a, b, "sprite index masking");
  });
});

describe("sspr", () => {
  it("is exactly `blit` at a 1:1 scale", () => {
    const a = spriteRam();
    paintSheet(a);
    palt(a, 0, false);
    cls(a, 0);
    spr(a, 0x23, 11, 17, 2, 2, false, false);

    const b = spriteRam();
    paintSheet(b);
    palt(b, 0, false);
    cls(b, 0);
    const [ox, oy] = spriteOrigin(0x23);
    sspr(b, ox, oy, 16, 16, 11, 17, 16, 16, false, false);

    expectSameFb(a, b, "sspr at 1:1");
  });

  it("doubles a sprite into four pixels per source pixel", () => {
    const ram = spriteRam();
    paintSheet(ram);
    palt(ram, 0, false);
    cls(ram, 0);
    sspr(ram, 0, 0, 8, 8, 20, 20, 16, 16, false, false);
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) {
        expect(pget(ram, 20 + x, 20 + y), `${x},${y}`).toBe(sheetPixel(ram, x >> 1, y >> 1));
      }
    }
  });

  it("shrinks by sampling, and hits both source edges", () => {
    const ram = spriteRam();
    paintSheet(ram);
    palt(ram, 0, false);
    cls(ram, 0);
    sspr(ram, 0, 0, 16, 16, 4, 4, 4, 4, false, false);
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 4; x++) {
        expect(pget(ram, 4 + x, 4 + y), `${x},${y}`).toBe(sheetPixel(ram, x * 4, y * 4));
      }
    }
  });

  it("mirrors a stretched blit in both axes", () => {
    const ram = spriteRam();
    paintSheet(ram);
    palt(ram, 0, false);
    cls(ram, 0);
    sspr(ram, 0, 0, 8, 8, 0, 0, 16, 16, true, true);
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) {
        expect(pget(ram, x, y), `${x},${y}`).toBe(sheetPixel(ram, 7 - (x >> 1), 7 - (y >> 1)));
      }
    }
  });

  it("clamps the source rectangle to the sheet and refuses degenerate sizes", () => {
    const ram = spriteRam();
    paintSheet(ram);
    cls(ram, 4);
    expect(() => {
      sspr(ram, 200, 200, 8, 8, 0, 0, 8, 8, false, false);
      sspr(ram, 0, 0, 0, 8, 0, 0, 8, 8, false, false);
      sspr(ram, 0, 0, 8, 8, 0, 0, 0, 0, false, false);
      sspr(ram, 0, 0, 8, 8, 0, 0, -4, -4, false, false);
      sspr(ram, -1e6, -1e6, 8, 8, 0, 0, 8, 8, false, false);
      sspr(ram, 0, 0, 1e6, 1e6, 0, 0, 1e6, 1e6, false, false);
    }).not.toThrow();
    // The last call is legal and enormous; it must have filled only the screen.
    for (let i = LEN.FRAMEBUFFER; i < LEN.FRAMEBUFFER + 64; i++) expect(ram[i]).toBe(0);
  });
});

describe("map", () => {
  function mapRam(): Uint8Array {
    const ram = spriteRam();
    paintSheet(ram);
    // Distinct flat colours per tile, so drawing the wrong tile is obvious.
    for (let n = 0; n < 8; n++) {
      const [ox, oy] = spriteOrigin(n);
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) setSheetPixel(ram, ox + x, oy + y, n);
    }
    return ram;
  }

  it("draws a tile per map cell on an 8-pixel grid", () => {
    const ram = mapRam();
    palt(ram, 0, false);
    cls(ram, 0);
    ram[ADDR.MAP + 0] = 1;
    ram[ADDR.MAP + 1] = 2;
    ram[ADDR.MAP + MAP_W + 0] = 3;
    ram[ADDR.MAP + MAP_W + 1] = 4;
    map(ram, 0, 0, 16, 24, 2, 2, 0);
    expect(pget(ram, 16, 24)).toBe(1);
    expect(pget(ram, 24, 24)).toBe(2);
    expect(pget(ram, 16, 32)).toBe(3);
    expect(pget(ram, 23, 31)).toBe(1);
    expect(pget(ram, 31, 39)).toBe(4);
    expect(pget(ram, 32, 24)).toBe(0); // one past the region
  });

  it("never draws tile 0, whatever the sheet holds there", () => {
    const ram = mapRam();
    palt(ram, 0, false);
    cls(ram, 5);
    // Sprite 0 is a solid block of colour 0 after mapRam, but even a repainted
    // sprite 0 must not appear: the rule is about the TILE index.
    const [ox, oy] = spriteOrigin(0);
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) setSheetPixel(ram, ox + x, oy + y, 9);
    ram.fill(0, ADDR.MAP, ADDR.MAP + 64);
    map(ram, 0, 0, 0, 0, 8, 8, 0);
    expect(countNot(ram, 5)).toBe(0);
  });

  it("selects tiles by SPRITE_FLAGS when a layer is given", () => {
    const ram = mapRam();
    palt(ram, 0, false);
    ram[ADDR.SPRITE_FLAGS + 1] = 0x01;
    ram[ADDR.SPRITE_FLAGS + 2] = 0x02;
    ram[ADDR.SPRITE_FLAGS + 3] = 0x03; // in both layers
    ram[ADDR.MAP + 0] = 1;
    ram[ADDR.MAP + 1] = 2;
    ram[ADDR.MAP + 2] = 3;

    cls(ram, 7);
    map(ram, 0, 0, 0, 0, 3, 1, 0x01);
    expect(pget(ram, 0, 0)).toBe(1);
    expect(pget(ram, 8, 0)).toBe(7); // tile 2 is not in layer 1
    expect(pget(ram, 16, 0)).toBe(3);

    cls(ram, 7);
    map(ram, 0, 0, 0, 0, 3, 1, 0x02);
    expect(pget(ram, 0, 0)).toBe(7);
    expect(pget(ram, 8, 0)).toBe(2);
    expect(pget(ram, 16, 0)).toBe(3);

    cls(ram, 7);
    map(ram, 0, 0, 0, 0, 3, 1, 0); // 0 means every tile
    expect(pget(ram, 0, 0)).toBe(1);
    expect(pget(ram, 8, 0)).toBe(2);
    expect(pget(ram, 16, 0)).toBe(3);
  });

  it("skips cells outside the 128x64 map rather than wrapping into the next row", () => {
    const ram = mapRam();
    palt(ram, 0, false);
    ram[ADDR.MAP + 0] = 1; // map cell (0, 0)
    cls(ram, 6);
    // Start one cell to the LEFT of the map: cell (-1, 0) must not read cell
    // (127, -1) or any other neighbour.
    map(ram, -1, 0, 0, 0, 2, 1, 0);
    expect(pget(ram, 0, 0)).toBe(6);
    expect(pget(ram, 8, 0)).toBe(1);
  });

  it("visits only the tiles the clip rectangle can show", () => {
    const ram = mapRam();
    palt(ram, 0, false);
    for (let i = 0; i < MAP_W * 8; i++) ram[ADDR.MAP + i] = 1;
    cls(ram, 0);
    clip(ram, 30, 30, 8, 8);
    map(ram, 0, 0, 0, 0, 128, 64, 0);
    let lit = 0;
    for (let y = 0; y < SCREEN_H; y++) for (let x = 0; x < SCREEN_W; x++) if (pget(ram, x, y) === 1) lit++;
    expect(lit).toBe(64);
  });

  it("takes absurd arguments without throwing or escaping the framebuffer", () => {
    const ram = mapRam();
    ram.fill(0x5a, LEN.FRAMEBUFFER, LEN.FRAMEBUFFER + 64);
    cls(ram, 3);
    expect(() => {
      map(ram, -1e9, -1e9, -1e9, -1e9, 1e6, 1e6, 0);
      map(ram, 0, 0, 0, 0, 0, 0, 0);
      map(ram, 0, 0, 0, 0, -1, -1, 0);
      map(ram, 1e9, 1e9, 0, 0, 4, 4, 0xff);
    }).not.toThrow();
    for (let i = LEN.FRAMEBUFFER; i < LEN.FRAMEBUFFER + 64; i++) expect(ram[i]).toBe(0x5a);
  });
});

// ---------------------------------------------------------------------------
// LINES
// ---------------------------------------------------------------------------

describe("line", () => {
  it("lights both endpoints, for every direction", () => {
    for (const [x0, y0, x1, y1] of [
      [10, 10, 10, 10],
      [0, 0, 127, 127],
      [127, 0, 0, 127],
      [5, 60, 120, 61],
      [60, 5, 61, 120],
      [30, 90, 90, 30],
    ] as readonly (readonly [number, number, number, number])[]) {
      const ram = freshRam();
      cls(ram, 0);
      line(ram, x0, y0, x1, y1, 9);
      expect(pget(ram, x0, y0), `start ${x0},${y0}`).toBe(9);
      expect(pget(ram, x1, y1), `end ${x1},${y1}`).toBe(9);
    }
  });

  it("is exactly symmetric: line(a,b) and line(b,a) light the same pixels", () => {
    // A fan through every octant, plus the ties that a naive Bresenham gets
    // wrong -- the half-integer slopes where the error term lands on zero.
    for (let ax = 0; ax < 128; ax += 9) {
      for (let ay = 0; ay < 128; ay += 11) {
        for (const [bx, by] of [
          [64, 64],
          [0, 127],
          [127, 0],
          [ax + 4, ay + 2],
          [ax + 2, ay + 4],
          [ax + 6, ay + 3],
          [ax + 3, ay + 6],
          [ax - 5, ay + 5],
        ] as readonly (readonly [number, number])[]) {
          const fwd = freshRam();
          cls(fwd, 0);
          line(fwd, ax, ay, bx, by, 7);
          const rev = freshRam();
          cls(rev, 0);
          line(rev, bx, by, ax, ay, 7);
          expectSameFb(fwd, rev, `line ${ax},${ay} -> ${bx},${by}`);
        }
      }
    }
  });

  it("draws an axis-aligned line as a solid run of the right length", () => {
    const ram = freshRam();
    cls(ram, 0);
    line(ram, 10, 20, 40, 20, 5);
    for (let x = 10; x <= 40; x++) expect(pget(ram, x, 20), `x=${x}`).toBe(5);
    expect(pget(ram, 9, 20)).toBe(0);
    expect(pget(ram, 41, 20)).toBe(0);

    cls(ram, 0);
    line(ram, 20, 10, 20, 40, 5);
    for (let y = 10; y <= 40; y++) expect(pget(ram, 20, y), `y=${y}`).toBe(5);
  });

  it("draws a 45-degree line as one pixel per step", () => {
    const ram = freshRam();
    cls(ram, 0);
    line(ram, 0, 0, 31, 31, 6);
    let lit = 0;
    for (let y = 0; y < SCREEN_H; y++) for (let x = 0; x < SCREEN_W; x++) if (pget(ram, x, y) === 6) lit++;
    expect(lit).toBe(32);
    for (let i = 0; i < 32; i++) expect(pget(ram, i, i)).toBe(6);
  });

  it("is connected: no step moves more than one pixel on the major axis", () => {
    for (const [x1, y1] of [
      [100, 37],
      [37, 100],
      [3, 120],
      [120, 3],
    ] as readonly (readonly [number, number])[]) {
      const ram = freshRam();
      cls(ram, 0);
      line(ram, 4, 4, x1, y1, 8);
      const major = Math.abs(x1 - 4) >= Math.abs(y1 - 4);
      const steps = major ? Math.abs(x1 - 4) + 1 : Math.abs(y1 - 4) + 1;
      let lit = 0;
      for (let y = 0; y < SCREEN_H; y++) for (let x = 0; x < SCREEN_W; x++) if (pget(ram, x, y) === 8) lit++;
      expect(lit, `${x1},${y1}`).toBe(steps);
    }
  });

  it("clips to the clip rectangle and paints nothing outside it", () => {
    const ram = freshRam();
    cls(ram, 1);
    clip(ram, 40, 40, 16, 16);
    line(ram, -50, -50, 200, 200, 9);
    let lit = 0;
    for (let y = 0; y < SCREEN_H; y++) {
      for (let x = 0; x < SCREEN_W; x++) {
        if (pget(ram, x, y) === 9) {
          lit++;
          expect(x >= 40 && x <= 55 && y >= 40 && y <= 55, `${x},${y}`).toBe(true);
        }
      }
    }
    expect(lit).toBe(16);
  });

  it("draws the same pixels clipped as it would unclipped", () => {
    const full = freshRam();
    cls(full, 0);
    line(full, 2, 5, 120, 90, 4);

    const clipped = freshRam();
    cls(clipped, 0);
    clip(clipped, 30, 30, 40, 40);
    line(clipped, 2, 5, 120, 90, 4);

    for (let y = 0; y < SCREEN_H; y++) {
      for (let x = 0; x < SCREEN_W; x++) {
        const inBox = x >= 30 && x <= 69 && y >= 30 && y <= 69;
        const want = inBox ? pget(full, x, y) : 0;
        expect(pget(clipped, x, y), `${x},${y}`).toBe(want);
      }
    }
  });

  it("bounds the work for endpoints far outside the screen", () => {
    const ram = freshRam();
    ram.fill(0x5a, LEN.FRAMEBUFFER, LEN.FRAMEBUFFER + 64);
    cls(ram, 0);
    // Two billion steps if the loop were not clamped. It returns immediately.
    expect(() => {
      line(ram, -2e9, -2e9, 2e9, 2e9, 3);
      line(ram, -2e9, 64, 2e9, 64, 3);
      line(ram, 64, -2e9, 64, 2e9, 3);
    }).not.toThrow();
    for (let x = 0; x < SCREEN_W; x++) expect(pget(ram, x, 64), `x=${x}`).toBe(3);
    for (let i = LEN.FRAMEBUFFER; i < LEN.FRAMEBUFFER + 64; i++) expect(ram[i]).toBe(0x5a);
  });

  it("draws nothing through an empty clip", () => {
    const ram = freshRam();
    cls(ram, 0);
    clip(ram, 0, 0, 0, 0);
    line(ram, 0, 0, 127, 127, 9);
    expect(countNot(ram, 0)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// CIRCLES
// ---------------------------------------------------------------------------

describe("circ", () => {
  it("draws exactly one pixel at r = 0, filled or not", () => {
    for (const fill of [false, true]) {
      const ram = freshRam();
      cls(ram, 0);
      circ(ram, 30, 40, 0, 6, fill);
      expect(pget(ram, 30, 40)).toBe(6);
      expect(countNot(ram, 0)).toBe(1);
    }
  });

  it("is symmetric about both axes and the diagonal", () => {
    const ram = freshRam();
    cls(ram, 0);
    circ(ram, 64, 64, 20, 5, false);
    for (let dy = -20; dy <= 20; dy++) {
      for (let dx = -20; dx <= 20; dx++) {
        const v = pget(ram, 64 + dx, 64 + dy);
        expect(pget(ram, 64 - dx, 64 + dy), `mirror x at ${dx},${dy}`).toBe(v);
        expect(pget(ram, 64 + dx, 64 - dy), `mirror y at ${dx},${dy}`).toBe(v);
        expect(pget(ram, 64 + dy, 64 + dx), `diagonal at ${dx},${dy}`).toBe(v);
      }
    }
  });

  it("touches the four cardinal points at radius r, and nothing beyond", () => {
    for (const r of [1, 2, 3, 7, 12, 30]) {
      const ram = freshRam();
      cls(ram, 0);
      circ(ram, 60, 60, r, 8, false);
      expect(pget(ram, 60 + r, 60), `r=${r} east`).toBe(8);
      expect(pget(ram, 60 - r, 60), `r=${r} west`).toBe(8);
      expect(pget(ram, 60, 60 + r), `r=${r} south`).toBe(8);
      expect(pget(ram, 60, 60 - r), `r=${r} north`).toBe(8);
      for (let y = 0; y < SCREEN_H; y++) {
        for (let x = 0; x < SCREEN_W; x++) {
          if (pget(ram, x, y) === 8) {
            const dx = x - 60;
            const dy = y - 60;
            expect(Math.max(Math.abs(dx), Math.abs(dy)), `r=${r} at ${x},${y}`).toBeLessThanOrEqual(r);
          }
        }
      }
    }
  });

  it("fills the disc its own outline bounds -- every outline pixel is filled", () => {
    for (const r of [1, 2, 5, 9, 16]) {
      const outline = freshRam();
      cls(outline, 0);
      circ(outline, 40, 40, r, 3, false);

      const filled = freshRam();
      cls(filled, 0);
      circ(filled, 40, 40, r, 3, true);

      let outlineCount = 0;
      let filledCount = 0;
      for (let y = 0; y < SCREEN_H; y++) {
        for (let x = 0; x < SCREEN_W; x++) {
          const o = pget(outline, x, y) === 3;
          const f = pget(filled, x, y) === 3;
          if (o) outlineCount++;
          if (f) filledCount++;
          if (o) expect(f, `r=${r}: outline pixel ${x},${y} is not in the fill`).toBe(true);
        }
      }
      expect(filledCount, `r=${r}`).toBeGreaterThanOrEqual(outlineCount);
    }
  });

  it("fills contiguous rows -- no holes inside the disc", () => {
    const ram = freshRam();
    cls(ram, 0);
    circ(ram, 64, 64, 15, 4, true);
    for (let y = 0; y < SCREEN_H; y++) {
      let first = -1;
      let last = -1;
      for (let x = 0; x < SCREEN_W; x++) {
        if (pget(ram, x, y) === 4) {
          if (first < 0) first = x;
          last = x;
        }
      }
      if (first < 0) continue;
      for (let x = first; x <= last; x++) expect(pget(ram, x, y), `hole at ${x},${y}`).toBe(4);
    }
  });

  it("clips against CLIP, filled and outline alike, at every edge", () => {
    for (const fill of [false, true]) {
      const ram = freshRam();
      ram.fill(0x5a, LEN.FRAMEBUFFER, LEN.FRAMEBUFFER + 64);
      cls(ram, 1);
      clip(ram, 50, 50, 20, 20);
      circ(ram, 50, 50, 40, 7, fill);
      for (let y = 0; y < SCREEN_H; y++) {
        for (let x = 0; x < SCREEN_W; x++) {
          if (pget(ram, x, y) === 7) {
            expect(x >= 50 && x <= 69 && y >= 50 && y <= 69, `${x},${y}`).toBe(true);
          }
        }
      }
      for (let i = LEN.FRAMEBUFFER; i < LEN.FRAMEBUFFER + 64; i++) expect(ram[i]).toBe(0x5a);
    }
  });

  it("draws the same pixels clipped as unclipped", () => {
    for (const fill of [false, true]) {
      const full = freshRam();
      cls(full, 0);
      circ(full, 64, 64, 30, 6, fill);

      const clipped = freshRam();
      cls(clipped, 0);
      clip(clipped, 50, 50, 30, 30);
      circ(clipped, 64, 64, 30, 6, fill);

      for (let y = 0; y < SCREEN_H; y++) {
        for (let x = 0; x < SCREEN_W; x++) {
          const inBox = x >= 50 && x <= 79 && y >= 50 && y <= 79;
          expect(pget(clipped, x, y), `fill=${fill} ${x},${y}`).toBe(inBox ? pget(full, x, y) : 0);
        }
      }
    }
  });

  it("ignores a negative radius and survives an enormous one", () => {
    const ram = freshRam();
    ram.fill(0x5a, LEN.FRAMEBUFFER, LEN.FRAMEBUFFER + 64);
    cls(ram, 0);
    circ(ram, 64, 64, -5, 9, true);
    expect(countNot(ram, 0)).toBe(0);
    expect(() => circ(ram, 64, 64, 2e9, 9, true)).not.toThrow();
    expect(countNot(ram, 9)).toBe(0); // the whole screen is inside it
    for (let i = LEN.FRAMEBUFFER; i < LEN.FRAMEBUFFER + 64; i++) expect(ram[i]).toBe(0x5a);
  });
});
