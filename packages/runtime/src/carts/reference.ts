/**
 * The graphics reference cart.
 *
 * The gradient cart proves the machine is DETERMINISTIC. This one proves the
 * rasterizer is CORRECT, and it does it in a way a person can check: the screen
 * is divided into seven labelled panels, each exercising one family of calls, so
 * a broken primitive shows up as one wrong panel in a PNG rather than as a
 * changed hash with no address.
 *
 *   y   0..31   line   -- a rotating fan, plus PRNG sparkles
 *   y  32..63   circ   -- filled and outline, including r = 0
 *   y  64..79   spr    -- flips, multi-cell sprites, odd and even x
 *   y  80..95   sspr   -- stretched up, stretched down, flipped
 *   y  96..111  map    -- two layers, scrolled with CAMERA
 *   y 112..119  print  -- both cases, digits, punctuation, opaque paper
 *   y 120..127  pset / rect / pal / clip
 *
 * Everything animates off the frame counter and the console's own PRNG, so ten
 * consecutive frames differ from each other and none of them depends on input.
 *
 * ALL of its state is in RAM. The sprite sheet, the sprite flags and the tile
 * map are written during `boot` through `poke`, which is also the point: it
 * shows a cart building its own assets out of nothing, and it means the
 * conformance frames depend on the sheet layout documented in raster.ts. Change
 * that layout and these frames change, which is exactly the alarm you want.
 */

import type { CartApi, CartProgram } from "../machine";
import { ADDR, MAP_W } from "../memory";

/** Sheet bytes per row. The sheet is one 128 x 128 picture; see raster.ts. */
const SHEET_STRIDE = 64;

/**
 * The sprites, as hex. One string per row, one hex digit per pixel, colour 0
 * being transparent. Sprite k of this list is installed as sprite INDEX[k].
 */
const SPRITE_ART: readonly (readonly string[])[] = [
  // 1 -- diamond, a shape whose flip is its own mirror so a flip bug is quiet
  //      here and loud in sprite 3.
  ["00088000", "00899800", "08999980", "89999998", "89999998", "08999980", "00899800", "00088000"],
  // 2 -- checkerboard. Every pixel differs from its neighbour, so a nibble-order
  //      mistake in the blit inverts it visibly.
  ["bcbcbcbc", "cbcbcbcb", "bcbcbcbc", "cbcbcbcb", "bcbcbcbc", "cbcbcbcb", "bcbcbcbc", "cbcbcbcb"],
  // 3 -- an arrow. Asymmetric in both axes: the flip test.
  ["000e0000", "00eee000", "0eeeee00", "eeeeeee0", "000e0000", "000e0000", "000e0000", "000e0000"],
  // 4 -- a face, for the bobbing sprite.
  ["00aaaa00", "0a0000a0", "a0a00a0a", "a000000a", "a000000a", "a00aa00a", "0a0000a0", "00aaaa00"],
  // 5 -- brick, map layer 1
  ["77777777", "70707070", "77777777", "07070707", "77777777", "70707070", "77777777", "07070707"],
  // 6 -- grass, map layer 1
  ["bbbbbbbb", "bcbbcbbb", "bbbbbbbb", "bbcbbbcb", "bbbbbbbb", "bcbbcbbb", "bbbbbbbb", "bbbbbbcb"],
  // 7 -- coin, map layer 2
  ["00aaaa00", "0aa00aa0", "aa0000aa", "a000000a", "a000000a", "aa0000aa", "0aa00aa0", "00aaaa00"],
  // 16, 17 -- a two-cell banner, drawn as one `spr(16, x, y, 2, 1)`. Its halves
  //           only line up if the sheet really is a 128-wide picture.
  ["33333333", "34444444", "35555555", "36666666", "36666666", "35555555", "34444444", "33333333"],
  ["33333333", "44444443", "55555553", "66666663", "66666663", "55555553", "44444443", "33333333"],
];

/** Where each entry of SPRITE_ART is installed. */
const SPRITE_INDEX: readonly number[] = [1, 2, 3, 4, 5, 6, 7, 16, 17];

/** Flags per sprite: bit 0 is the terrain layer, bit 1 the item layer. */
const SPRITE_LAYER: readonly number[] = [0x04, 0x04, 0x04, 0x04, 0x01, 0x01, 0x02, 0x04, 0x04];

/** Tiles the demo map is built from. */
const TILE_BRICK = 5;
const TILE_GRASS = 6;
const TILE_COIN = 7;

/** How many map cells the cart fills in. */
const MAP_COLS = 40;
const MAP_ROWS = 8;

/** Cart scratch. Kept in USER_RAM, like everything a cart remembers. */
const SPARKLE_SEEDED = ADDR.USER_RAM + 0;

/** Write one sheet pixel through the ABI, the way a cart with no tools would. */
function sset(api: CartApi, px: number, py: number, c: number): void {
  const a = ADDR.SPRITES + py * SHEET_STRIDE + (px >> 1);
  const b = api.sys.peek(a);
  api.sys.poke(a, (px & 1) === 0 ? (b & 0xf0) | (c & 0x0f) : (b & 0x0f) | ((c & 0x0f) << 4));
}

/** Hex digit to nibble. Only ever fed the characters in SPRITE_ART. */
function hex(ch: string): number {
  const c = ch.charCodeAt(0);
  if (c >= 48 && c <= 57) return c - 48;
  return c - 87; // 'a'..'f'
}

export const referenceCart: CartProgram = {
  boot(api: CartApi): void {
    const { gfx, sys } = api;

    // The sheet starts as 8192 bytes of colour 0. `memset` says so explicitly
    // rather than trusting boot's zero fill, which is also this cart's proof
    // that memset is bounds-clamped and lands where the map says it does.
    sys.memset(ADDR.SPRITES, 0x00, 8192);
    sys.memset(ADDR.SPRITE_FLAGS, 0x00, 256);
    sys.memset(ADDR.MAP, 0x00, 8192);

    for (let k = 0; k < SPRITE_ART.length; k++) {
      const art = SPRITE_ART[k] as readonly string[];
      const n = SPRITE_INDEX[k] as number;
      const ox = (n & 15) * 8;
      const oy = (n >> 4) * 8;
      for (let row = 0; row < 8; row++) {
        const line = art[row] as string;
        for (let col = 0; col < 8; col++) sset(api, ox + col, oy + row, hex(line.charAt(col)));
      }
      sys.poke(ADDR.SPRITE_FLAGS + n, SPRITE_LAYER[k] as number);
    }

    // The map: two rows of scenery over four rows of brick, with a coin every
    // fifth column on the last row. Every cell is a function of its position, so
    // it is the same map on every machine that ever runs this cart.
    for (let my = 0; my < MAP_ROWS; my++) {
      for (let mx = 0; mx < MAP_COLS; mx++) {
        let t = 0;
        if (my >= 3) t = TILE_BRICK;
        else if (my === 2 || ((mx * 7 + my * 3) & 7) < 3) t = TILE_GRASS;
        if (my === 1 && mx % 5 === 2) t = TILE_COIN;
        sys.poke(ADDR.MAP + my * MAP_W + mx, t);
      }
    }

    // memcpy with an overlapping range, so the frames depend on its memmove
    // semantics: shift the last map row one cell to the right in place.
    sys.memcpy(ADDR.MAP + 7 * MAP_W + 1, ADDR.MAP + 7 * MAP_W, MAP_COLS);

    sys.poke(SPARKLE_SEEDED, 1);
    gfx.cls(0);
  },

  tick(api: CartApi): void {
    const { gfx, snd, sys } = api;
    const f = sys.frame();

    gfx.camera(0, 0);
    gfx.clip(0, 0, 128, 128);
    gfx.palt();
    gfx.cls(1);

    // --- lines ------------------------------------------------------------
    gfx.clip(0, 0, 128, 32);
    gfx.rect(0, 0, 128, 32, 2, true);
    for (let i = 0; i < 12; i++) {
      const a = (i * 85 + f * 6) & 1023;
      const dx = sys.sin(a) >> 12; // 16.16 in [-1,1] -> [-16, 16]
      const dy = sys.cos(a) >> 12;
      // Drawn from the rim inward on odd spokes and outward on even ones: the
      // fan is only clean if `line` is symmetric under endpoint swap.
      if ((i & 1) === 0) gfx.line(30, 16, 30 + dx, 16 + dy, 4 + (i & 7));
      else gfx.line(30 + dx, 16 + dy, 30, 16, 4 + (i & 7));
    }
    gfx.line(56, 2, 56, 29, 6); // vertical
    gfx.line(60, 16, 124, 16, 6); // horizontal
    gfx.line(60, 2, 124, 29, 9); // shallow
    gfx.line(124, 2, 60, 29, 10); // its mirror
    for (let i = 0; i < 8; i++) gfx.pset(sys.rnd(128), sys.rnd(32), 6);

    // --- circles ----------------------------------------------------------
    gfx.clip(0, 32, 128, 32);
    gfx.rect(0, 32, 128, 32, 3, true);
    const r = 3 + ((f >> 2) % 11);
    gfx.circ(24, 48, r, 10, true);
    gfx.circ(24, 48, 14, 6, false);
    gfx.circ(64, 48, 14 - r, 8, false);
    gfx.circ(64, 48, 2, 5, true);
    gfx.circ(96, 48, 0, 6, false); // r = 0 is one pixel
    gfx.circ(100, 48, 1, 6, true);
    gfx.circ(120, 40, 12, 9, true); // hangs off the right edge and the panel top

    // --- sprites ----------------------------------------------------------
    gfx.clip(0, 64, 128, 16);
    gfx.rect(0, 64, 128, 16, 0, true);
    gfx.spr(1, 2, 68); // even x
    gfx.spr(1, 13, 68); // odd x -- must be the identical shape
    gfx.spr(3, 24, 68);
    gfx.spr(3, 34, 68, 1, 1, true, false); // mirrored
    gfx.spr(3, 44, 68, 1, 1, false, true); // flipped
    gfx.spr(3, 54, 68, 1, 1, true, true); // both
    gfx.spr(2, 65, 68); // the checkerboard, at an odd x
    gfx.spr(16, 76, 68, 2, 1); // two cells wide, at an odd x
    gfx.spr(4, 100 + (((f >> 2) & 7) - 4), 68); // bobbing

    // --- stretched blits --------------------------------------------------
    gfx.clip(0, 80, 128, 16);
    gfx.rect(0, 80, 128, 16, 2, true);
    const s = 4 + ((f >> 1) % 12);
    gfx.sspr(8, 0, 8, 8, 2, 81, s, s); // sprite 1, grown
    gfx.sspr(24, 0, 8, 8, 24, 81, 14, 14); // sprite 3, grown
    gfx.sspr(24, 0, 8, 8, 40, 81, 14, 14, true, true); // and flipped
    gfx.sspr(0, 8, 16, 8, 58, 84, 32, 8); // the banner, doubled in x only
    gfx.sspr(8, 0, 24, 8, 94, 84, 12, 4); // three sprites, shrunk
    gfx.sspr(8, 0, 8, 8, 110, 81, 8, 8); // 1:1 -- the whole-byte path

    // --- the tile map -----------------------------------------------------
    gfx.clip(0, 96, 128, 16);
    gfx.rect(0, 96, 128, 16, 1, true);
    const scroll = f % (MAP_COLS * 8);
    gfx.camera(scroll, 0);
    gfx.map(0, 0, 0, 96, MAP_COLS, 2, 0x01); // terrain only
    gfx.map(0, 0, 0, 96, MAP_COLS, 2, 0x02); // items over it
    gfx.camera(0, 0);

    // --- text -------------------------------------------------------------
    gfx.clip(0, 112, 128, 8);
    gfx.rect(0, 112, 128, 8, 0, true);
    const w = gfx.print("SQUARE ONE", 1, 113, 6);
    gfx.print("0123456789", 1 + w + 2, 113, 10);
    gfx.palt(0, false); // opaque paper: colour 0 stops being transparent
    gfx.print("gjpqy,;_|{}", 88, 113, 12);
    gfx.palt();

    // --- pixels, rectangles, the draw remap -------------------------------
    gfx.clip(0, 120, 128, 8);
    gfx.rect(0, 120, 128, 8, 2, true);
    for (let i = 0; i < 32; i++) {
      gfx.pset(i * 4 + 1, 121 + ((i + (f >> 1)) & 3), 5 + (i & 7));
    }
    gfx.pal(9, 12); // everything drawn as 9 is stored as 12
    gfx.rect(2, 125, 60, 2, 9, true);
    gfx.pal(9, 9);
    gfx.rect(66, 124, 60, 3, 9, false);

    gfx.clip(0, 0, 128, 128);

    // The audio registers are not in the frame hash, but the wiring is real and
    // a cart that never calls it would not prove `snd` reaches RAM at all.
    if (f % 16 === 0) snd.sfx(f % 8, (f >> 4) & 3);
  },
};
