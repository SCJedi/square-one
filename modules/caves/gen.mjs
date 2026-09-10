// The `caves` tileset, drawn here and packed into tiles.bin.
//
//     node modules/caves/gen.mjs
//
// Run it from the repository root. It rewrites modules/caves/tiles.bin and
// prints a byte count. Regenerating must produce identical bytes on any machine
// -- there is no clock, no randomness and no floating point in this file.
//
// WHY THE ART IS SOURCE AND THE .bin IS OUTPUT
// -------------------------------------------
// A .bin is unreviewable. A pull request that changes one pixel of tile 27
// should read as one changed character, and it does, because the art below is
// one hex digit per pixel: the digit IS the live palette slot the pixel shows.
// The packing at the bottom is the only part that knows about nibbles.
//
// THE OUTPUT FORMAT (this is the tileset pack format, and the manifest repeats it)
// -------------------------------------------------------------------------------
//     bytes 0..2047     pixels: 32 rows of 64 bytes, the console's own sheet
//                       layout -- 128 pixels per row at 4bpp, EVEN x in the LOW
//                       nibble. 4 sheet rows of 16 cells = 64 tiles of 8x8.
//     bytes 2048..2111  flags: one byte per tile, in tile order.
//
// The stamper copies the pixels to ADDR.SPRITES + base*... and the flags to
// ADDR.SPRITE_FLAGS + base. `base` is the sheet cell this pack starts at and is
// declared in module.toml; for `caves` it is 0, so the copy is a straight one.
//
// TILE 0 IS EMPTY, ALWAYS. `gfx.map` never draws it, whatever the sheet holds
// there, so it is left blank and given no flags.
//
// THE PALETTE THIS ART IS DRAWN FOR is `sweetie16`. The digits mean:
//
//     0 void (transparent)   4 rock body        8 moss           c lava orange
//     1 deep shadow          5 rock light       9 moss light     d gold
//     2 dark navy            6 highlight        a ember dark     e crystal deep
//     3 rock shadow          7 moss dark        b danger red     f crystal bright
//
// An art pack targets a palette the way a font targets a size. Pair `caves`
// with a different 16 colours and it still draws; it just stops being a cave.

import { writeFileSync } from "node:fs";

/** solid: the player cannot pass through it. */
const SOLID = 0x01;
/** hazard: touching it kills. */
const HAZARD = 0x02;

/**
 * The 64 tiles, in order. Eight strings of eight hex digits each.
 *
 * Light falls from the top left throughout: a top edge and a left edge catch
 * colour 5, a right edge and a bottom edge fall away through 3, 2, 1. That one
 * rule is what makes tiles cut from different groups still look like one cave.
 */
const TILES = [
  // --- 0: nothing -----------------------------------------------------------
  ["00000000", "00000000", "00000000", "00000000", "00000000", "00000000", "00000000", "00000000"],

  // --- 1..12: rock -----------------------------------------------------------
  // 1 rock fill
  ["44444444", "43444434", "44444444", "44434444", "44444444", "34444443", "44444444", "44444344"],
  // 2 rock fill, cracked
  ["44444444", "44434444", "44344444", "43444444", "44344444", "44434444", "44444344", "44444444"],
  // 3 rock top -- moss cap and a lit rim
  ["99899989", "88788878", "55545554", "44444444", "44434444", "44444444", "43444434", "44444444"],
  // 4 rock top-left corner
  ["59989998", "58878887", "55554554", "54444444", "54444344", "54444444", "54443444", "54444444"],
  // 5 rock top-right corner
  ["99899995", "88788853", "45545432", "44444432", "44344432", "44444432", "44444432", "44443432"],
  // 6 rock left edge
  ["54444444", "54444434", "54444444", "55444444", "54443444", "54444444", "54444444", "54444434"],
  // 7 rock right edge
  ["44444432", "44344432", "44444432", "44444422", "44443432", "44444432", "44444432", "44344432"],
  // 8 rock bottom edge -- an overhang seen from underneath
  ["44444444", "44434444", "44444444", "44344444", "44444444", "33333333", "22222222", "11111111"],
  // 9 rock bottom-left
  ["54444444", "54444434", "54444444", "54444444", "54344444", "53333333", "32222222", "21111111"],
  // 10 rock bottom-right
  ["44444432", "44344432", "44444432", "44444432", "44444332", "33333322", "22222221", "11111111"],
  // 11 rock pillar -- lit on every side, for a one-tile block
  ["59999995", "58888853", "55545432", "54444432", "54344432", "54444432", "53333332", "32222221"],
  // 12 rock top, worn
  ["99859989", "88788878", "55545554", "44444444", "44434444", "45444444", "43444434", "44444444"],

  // --- 13..18: dirt ----------------------------------------------------------
  // 13 dirt fill
  ["33333333", "33233333", "33333323", "32333333", "33333332", "33323333", "33333333", "32333333"],
  // 14 dirt with stones
  ["33333333", "33433333", "33443333", "33333333", "33333433", "33333443", "33333333", "34333333"],
  // 15 dirt top
  ["44344434", "33333333", "33233333", "33333333", "33333233", "33333333", "32333333", "33333333"],
  // 16 dirt left edge
  ["43333333", "43333333", "43323333", "43333333", "43333333", "43333233", "43333333", "43233333"],
  // 17 dirt right edge
  ["33333332", "33233332", "33333332", "33333332", "32333332", "33333332", "33333232", "33333332"],
  // 18 dirt bottom edge
  ["33333333", "33233333", "33333333", "33333233", "33333333", "22222222", "11111111", "11111111"],

  // --- 19..22: ledges -------------------------------------------------------
  // 19 ledge left end
  ["05555555", "54444444", "53333333", "32222222", "00000000", "00000000", "00000000", "00000000"],
  // 20 ledge middle
  ["55555555", "44444444", "33333333", "22222222", "00000000", "00000000", "00000000", "00000000"],
  // 21 ledge right end
  ["55555550", "44444445", "33333335", "22222223", "00000000", "00000000", "00000000", "00000000"],
  // 22 ledge, one tile wide
  ["05555550", "54444445", "53333335", "32222223", "00000000", "00000000", "00000000", "00000000"],

  // --- 23..26: spikes -------------------------------------------------------
  // 23 spikes up
  ["00000000", "00000000", "06000600", "06500650", "65506550", "65506550", "55555555", "44444444"],
  // 24 spikes down
  ["44444444", "55555555", "65506550", "65506550", "06500650", "06000600", "00000000", "00000000"],
  // 25 spikes left
  ["00000054", "00055554", "00665554", "00006654", "00000054", "00055554", "00665554", "00006654"],
  // 26 spikes right
  ["45000000", "45555000", "45555660", "45660000", "45000000", "45555000", "45555660", "45660000"],

  // --- 27..30: liquids ------------------------------------------------------
  // 27 lava surface
  ["0cc00cc0", "cccccccc", "cdcccdcc", "cccccccc", "ccdcccdc", "cccccccc", "cbccccbc", "cccccccc"],
  // 28 lava body
  ["cccccccc", "cbcccbcc", "cccccccc", "cccbcccb", "cccccccc", "cbcccccc", "cccccbcc", "cccccccc"],
  // 29 acid surface
  ["09900990", "99999999", "98999899", "99999999", "99899989", "99999999", "97999979", "99999999"],
  // 30 acid body
  ["88888888", "87888788", "88888888", "88878888", "88888888", "87888888", "88888788", "88888888"],

  // --- 31..36: minerals -----------------------------------------------------
  // 31 crystal, small
  ["00000000", "000ff000", "00feef00", "00feef00", "00feef00", "000ee000", "00000000", "00000000"],
  // 32 crystal, large
  ["0000f000", "000fef00", "00feeef0", "00feeef0", "0ffeeeef", "0feeeeef", "00eeee00", "000ee000"],
  // 33 crystal, gold
  ["00000000", "000dd000", "00d66d00", "00d66d00", "00dccd00", "000cc000", "00000000", "00000000"],
  // 34 ore vein in rock
  ["44444444", "44d44444", "4dd44444", "44444d44", "444444dd", "44444444", "4d444444", "44444444"],
  // 35 stalactite
  ["44444444", "54444443", "34444432", "03444320", "00344300", "00034300", "00003000", "00000000"],
  // 36 stalagmite
  ["00000000", "00003000", "00034300", "00344300", "03444320", "34444432", "54444443", "44444444"],

  // --- 37..46: growth and clutter -------------------------------------------
  // 37 mushroom, small
  ["00000000", "00000000", "00bbb000", "0bb6bb00", "00bbb000", "000d0000", "000d0000", "00ddd000"],
  // 38 mushroom, large
  ["00000000", "00bbbb00", "0bb66bb0", "bbbbbbbb", "0bbbbbb0", "000dd000", "000dd000", "00dddd00"],
  // 39 vine
  ["00090000", "00089000", "00098000", "00089000", "00098000", "00089000", "00098000", "00089000"],
  // 40 vine, end
  ["00089000", "00098000", "09089900", "09998000", "00089000", "00090000", "00000000", "00000000"],
  // 41 skull
  ["00000000", "00555500", "05555550", "05255250", "05555550", "00555500", "00505050", "00000000"],
  // 42 pebbles
  ["00000000", "00000000", "00000000", "00000000", "00050000", "00454000", "40004540", "00000000"],
  // 43 torch
  ["00060000", "000d6000", "00dcd000", "00dcd000", "000c0000", "00034000", "00034000", "00034000"],
  // 44 chain
  ["00055000", "00500500", "00500500", "00055000", "00055000", "00500500", "00500500", "00055000"],
  // 45 ladder
  ["05000050", "05000050", "05555550", "05000050", "05000050", "05555550", "05000050", "05000050"],
  // 46 moss patch
  ["00000000", "00000000", "00900000", "09800900", "89889880", "08888800", "00888000", "00000000"],

  // --- 47..56: background ---------------------------------------------------
  // 47 brick
  ["22222222", "11121112", "11121112", "22222222", "21112111", "21112111", "22222222", "11121112"],
  // 48 brick, cracked
  ["22222222", "11121112", "11221112", "22122222", "21112111", "21112111", "22222222", "11121112"],
  // 49 dark
  ["11111111", "11111111", "11211111", "11111111", "11111121", "11111111", "12111111", "11111111"],
  // 50 dark, flecked
  ["11111111", "11311111", "11111111", "11111311", "13111111", "11111111", "11111131", "11111111"],
  // 51 pillar, left half
  ["22111111", "22111111", "22111111", "22111111", "22111111", "22111111", "22111111", "22111111"],
  // 52 pillar, right half
  ["11111122", "11111122", "11111122", "11111122", "11111122", "11111122", "11111122", "11111122"],
  // 53 conduit
  ["11111111", "22222222", "23333332", "22222222", "11111111", "11111111", "11111111", "11111111"],
  // 54 rubble
  ["11111111", "11111111", "11111111", "11111111", "11211111", "12212121", "22222222", "22222222"],
  // 55 moss on the wall
  ["11111111", "11711111", "17711711", "11111111", "11117111", "11771111", "11111111", "11711111"],
  // 56 mist
  ["11111111", "21111112", "11111111", "11122111", "11111111", "21111112", "11111111", "11111111"],

  // --- 57..63: the rest -----------------------------------------------------
  // 57 rock with a crystal in it
  ["44444444", "444f4444", "44feef44", "44feef44", "444ee444", "44444444", "44444444", "44444444"],
  // 58 rock with moss on it
  ["44444444", "49444944", "44988944", "44888444", "44444444", "44444444", "44444444", "44444444"],
  // 59 rock, sloping away to the left
  ["00000055", "00005544", "00554444", "05444444", "54444444", "44444444", "44444444", "44444444"],
  // 60 rock, sloping away to the right
  ["55000000", "44550000", "44445500", "44444450", "44444445", "44444444", "44444444", "44444444"],
  // 61 crystal cluster
  ["000f0000", "00fef0f0", "0feeefef", "0feeefef", "ffeeeeef", "0feeeeef", "00eeee00", "000ee000"],
  // 62 marker post
  ["00000000", "0dddddd0", "0d6666d0", "0d6226d0", "0d6666d0", "0dddddd0", "00030000", "00030000"],
  // 63 checker -- the tile you place when you want to see where a tile went
  ["b2b2b2b2", "2b2b2b2b", "b2b2b2b2", "2b2b2b2b", "b2b2b2b2", "2b2b2b2b", "b2b2b2b2", "2b2b2b2b"],
];

/**
 * What each tile does, by index. Anything not named here is decoration: drawn,
 * walked through, harmless.
 */
const FLAGS = new Uint8Array(64);
for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]) FLAGS[n] = SOLID; // rock
for (const n of [13, 14, 15, 16, 17, 18]) FLAGS[n] = SOLID; // dirt
for (const n of [19, 20, 21, 22]) FLAGS[n] = SOLID; // ledges
for (const n of [23, 24, 25, 26]) FLAGS[n] = HAZARD; // spikes
for (const n of [27, 28, 29, 30]) FLAGS[n] = HAZARD; // lava and acid
for (const n of [34, 57, 58, 59, 60, 63]) FLAGS[n] = SOLID; // rock variants

/** Sheet bytes per pixel row: 128 pixels at two per byte. */
const STRIDE = 64;
/** Sheet cells across. */
const COLS = 16;

const rows = Math.ceil(TILES.length / COLS) * 8;
const pixels = new Uint8Array(rows * STRIDE);

for (let n = 0; n < TILES.length; n++) {
  const art = TILES[n];
  if (art.length !== 8) throw new Error(`tile ${n}: ${art.length} rows, expected 8`);
  const ox = (n % COLS) * 8;
  const oy = Math.floor(n / COLS) * 8;
  for (let r = 0; r < 8; r++) {
    const line = art[r];
    if (line.length !== 8) throw new Error(`tile ${n} row ${r}: "${line}" is not 8 characters`);
    for (let c = 0; c < 8; c++) {
      const v = parseInt(line[c], 16);
      if (Number.isNaN(v)) throw new Error(`tile ${n} row ${r}: "${line[c]}" is not a hex digit`);
      const px = ox + c;
      const i = (oy + r) * STRIDE + (px >> 1);
      pixels[i] = (px & 1) === 0 ? (pixels[i] & 0xf0) | v : (pixels[i] & 0x0f) | (v << 4);
    }
  }
}

const out = new Uint8Array(pixels.length + FLAGS.length);
out.set(pixels, 0);
out.set(FLAGS, pixels.length);

writeFileSync(new URL("./tiles.bin", import.meta.url), out);
console.log(
  `caves: ${TILES.length} tiles, ${pixels.length} bytes of pixels + ${FLAGS.length} flags = ${out.length} bytes`,
);
