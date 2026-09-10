import { describe, expect, it } from "vitest";

import {
  ADDR,
  BPP,
  BTN,
  FB_STRIDE,
  HW_COLORS,
  LEN,
  LIVE_COLORS,
  MAP_H,
  MAP_W,
  MAX_PLAYERS,
  RAM_SIZE,
  REGION_ORDER,
  SCREEN_H,
  SCREEN_W,
  SPRITE_BYTES,
  SPRITE_COUNT,
  fbIndex,
} from "../src/memory";
import type { RegionName } from "../src/memory";
import { ADDR_PALT, LEN_PALT } from "../src/raster";

/**
 * The map is checked by walking the table, never by re-typing its numbers. Edit
 * any constant in memory.ts and something below goes red -- which is the only
 * way a normative table stays normative.
 */
const regions = REGION_ORDER.map((name) => ({
  name,
  start: ADDR[name],
  len: LEN[name],
  end: ADDR[name] + LEN[name],
}));

describe("memory map structure", () => {
  it("declares an address and a length for exactly the same regions", () => {
    const addrNames = Object.keys(ADDR).sort();
    const lenNames = Object.keys(LEN).sort();
    expect(lenNames).toEqual(addrNames);
    expect([...REGION_ORDER].sort()).toEqual(addrNames);
  });

  it("lists every region exactly once", () => {
    expect(new Set(REGION_ORDER).size).toBe(REGION_ORDER.length);
  });

  it("is in strictly ascending address order with no overlap", () => {
    for (let i = 1; i < regions.length; i++) {
      const prev = regions[i - 1] as (typeof regions)[number];
      const cur = regions[i] as (typeof regions)[number];
      expect(cur.start, `${cur.name} starts before ${prev.name}`).toBeGreaterThan(prev.start);
      expect(cur.start, `${prev.name} overlaps ${cur.name}`).toBeGreaterThanOrEqual(prev.end);
    }
  });

  it("has a positive length for every region and none escapes RAM", () => {
    for (const r of regions) {
      expect(r.len, `${r.name} length`).toBeGreaterThan(0);
      expect(r.start, `${r.name} start`).toBeGreaterThanOrEqual(0);
      expect(r.end, `${r.name} end`).toBeLessThanOrEqual(RAM_SIZE);
    }
  });

  it("starts at 0 and ends exactly at the top of RAM", () => {
    const first = regions[0] as (typeof regions)[number];
    const last = regions[regions.length - 1] as (typeof regions)[number];
    expect(first.start).toBe(0);
    expect(last.end).toBe(RAM_SIZE);
  });

  it("accounts for all 65536 bytes: declared lengths plus reserved gaps", () => {
    let declared = 0;
    let reserved = 0;
    let cursor = 0;
    for (const r of regions) {
      reserved += r.start - cursor; // the hole in front of this region
      declared += r.len;
      cursor = r.end;
    }
    reserved += RAM_SIZE - cursor;

    expect(declared + reserved).toBe(RAM_SIZE);
    // Gaps exist only to keep a following region on a readable boundary. If
    // this grows, a region has shrunk and its bytes have gone missing rather
    // than moved.
    expect(reserved).toBe(171);
    expect(declared).toBe(65365);
  });

  it("covers RAM contiguously when the gaps are filled in", () => {
    const covered = new Uint8Array(RAM_SIZE);
    for (const r of regions) covered.fill(1, r.start, r.end);
    let bytes = 0;
    for (let i = 0; i < RAM_SIZE; i++) bytes += covered[i] as number;
    expect(bytes).toBe(65365);
  });
});

describe("region lengths follow from what the region is", () => {
  it("framebuffer is 128x128 at 4bpp, and the stride agrees", () => {
    expect(FB_STRIDE).toBe((SCREEN_W * BPP) / 8);
    expect(LEN.FRAMEBUFFER).toBe(FB_STRIDE * SCREEN_H);
    expect(LEN.FRAMEBUFFER).toBe((SCREEN_W * SCREEN_H * BPP) / 8);
  });

  it("palettes are 64 x RGB and 16 x index", () => {
    expect(LEN.PALETTE_HW).toBe(HW_COLORS * 3);
    expect(LEN.PALETTE_LIVE).toBe(LIVE_COLORS);
    expect(LEN.DRAW_REMAP).toBe(LIVE_COLORS);
  });

  it("clip is four inclusive bounds and camera is two i16", () => {
    expect(LEN.CLIP).toBe(4);
    expect(LEN.CAMERA).toBe(2 * 2);
  });

  it("input is one byte per player slot, twice", () => {
    expect(LEN.INPUT_NOW).toBe(MAX_PLAYERS);
    expect(LEN.INPUT_PREV).toBe(MAX_PLAYERS);
    expect(LEN.PLAYERS_PRESENT * 8).toBeGreaterThanOrEqual(MAX_PLAYERS);
  });

  it("frame is a u32 and the PRNG is four of them", () => {
    expect(LEN.FRAME).toBe(4);
    expect(LEN.RNG_STATE).toBe(16);
  });

  it("sprites are 256 x 8x8 @ 4bpp with one flags byte each", () => {
    expect(SPRITE_BYTES).toBe(32);
    expect(LEN.SPRITES).toBe(SPRITE_COUNT * SPRITE_BYTES);
    expect(LEN.SPRITE_FLAGS).toBe(SPRITE_COUNT);
  });

  it("the map is 128x64 tiles at one byte each", () => {
    expect(LEN.MAP).toBe(MAP_W * MAP_H);
  });

  it("user RAM fills everything between MUSIC and SAVE", () => {
    expect(LEN.USER_RAM).toBe(ADDR.SAVE - ADDR.USER_RAM);
    expect(ADDR.SAVE + LEN.SAVE).toBe(RAM_SIZE);
  });

  it("pins the addresses a cart may hard-code", () => {
    // Not derivable -- these are the contract itself.
    const expected: Record<RegionName, number> = {
      FRAMEBUFFER: 0x0000,
      PALETTE_HW: 0x2000,
      PALETTE_LIVE: 0x20c0,
      DRAW_REMAP: 0x20d0,
      CLIP: 0x20e0,
      CAMERA: 0x20e4,
      INPUT_NOW: 0x20f0,
      INPUT_PREV: 0x20f4,
      PLAYERS_PRESENT: 0x20f8,
      FRAME: 0x20fc,
      RNG_STATE: 0x2100,
      AUDIO_CH: 0x2110,
      AUDIO_MASTER: 0x2150,
      SPRITES: 0x2200,
      SPRITE_FLAGS: 0x4200,
      MAP: 0x4300,
      SFX: 0x6300,
      MUSIC: 0x7000,
      USER_RAM: 0x7800,
      SAVE: 0xff00,
    };
    for (const name of REGION_ORDER) {
      expect(ADDR[name], name).toBe(expected[name]);
    }
  });
});

/**
 * The reserved gaps are not spare change.
 *
 * M4 put the transparency mask in one of them. It has to live in RAM -- a
 * snapshot that did not carry it would restore a machine whose sprites drew the
 * wrong colours -- and it has to live somewhere that no declared region will
 * ever want, or the memory map stops being the contract it says it is. So the
 * address is pinned here, next to the map it has to fit inside, rather than only
 * in the file that reads it.
 *
 * ADDR_PALT is exported from raster.ts and not from memory.ts, because memory.ts
 * is the M0-M3 normative table and adding a region to it would move the byte
 * accounting above. It is checked against that table here instead.
 */
describe("the transparency mask lives in a reserved gap", () => {
  it("sits between CAMERA and INPUT_NOW and overlaps no declared region", () => {
    expect(ADDR_PALT).toBe(0x20e8);
    expect(LEN_PALT).toBe(2);
    expect(ADDR_PALT).toBeGreaterThanOrEqual(ADDR.CAMERA + LEN.CAMERA);
    expect(ADDR_PALT + LEN_PALT).toBeLessThanOrEqual(ADDR.INPUT_NOW);

    for (const r of regions) {
      const overlaps = ADDR_PALT < r.end && ADDR_PALT + LEN_PALT > r.start;
      expect(overlaps, `PALT overlaps ${r.name}`).toBe(false);
    }
  });

  it("is inside RAM, so it travels inside a snapshot", () => {
    expect(ADDR_PALT).toBeGreaterThanOrEqual(0);
    expect(ADDR_PALT + LEN_PALT).toBeLessThanOrEqual(RAM_SIZE);
  });
});

describe("buttons", () => {
  it("are eight distinct bits in one byte", () => {
    const bits = Object.values(BTN);
    expect(new Set(bits).size).toBe(8);
    for (const b of bits) {
      expect(b).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThanOrEqual(7);
    }
  });

  it("assigns the d-pad to the low nibble and the faces to the high one", () => {
    expect(BTN.UP).toBe(0);
    expect(BTN.DOWN).toBe(1);
    expect(BTN.LEFT).toBe(2);
    expect(BTN.RIGHT).toBe(3);
    expect(BTN.A).toBe(4);
    expect(BTN.B).toBe(5);
    expect(BTN.X).toBe(6);
    expect(BTN.Y).toBe(7);
  });
});

describe("fbIndex", () => {
  it("packs two pixels per byte and steps one stride per row", () => {
    expect(fbIndex(0, 0)).toBe(ADDR.FRAMEBUFFER);
    expect(fbIndex(1, 0)).toBe(ADDR.FRAMEBUFFER);
    expect(fbIndex(2, 0)).toBe(ADDR.FRAMEBUFFER + 1);
    expect(fbIndex(0, 1)).toBe(ADDR.FRAMEBUFFER + FB_STRIDE);
    expect(fbIndex(127, 127)).toBe(ADDR.FRAMEBUFFER + LEN.FRAMEBUFFER - 1);
  });

  it("never leaves the framebuffer for any on-screen pixel", () => {
    for (let y = 0; y < SCREEN_H; y++) {
      for (let x = 0; x < SCREEN_W; x++) {
        const i = fbIndex(x, y);
        expect(i).toBeGreaterThanOrEqual(ADDR.FRAMEBUFFER);
        expect(i).toBeLessThan(ADDR.FRAMEBUFFER + LEN.FRAMEBUFFER);
      }
    }
  });
});
