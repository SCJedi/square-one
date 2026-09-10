// The `dungeon` tileset, drawn here and packed into tiles.bin.
//
//     node modules/dungeon/gen.mjs
//
// Run it from the repository root. It rewrites modules/dungeon/tiles.bin and
// prints a byte count. Regenerating must produce identical bytes on any machine
// -- there is no clock, no randomness and no floating point in this file.
//
// WHAT THIS PACK IS FOR
// ---------------------
// A SECOND tileset for the same `platformer` engine that `caves` runs on. It
// declares the same interface -- 64 tiles, `solid` and `hazard`, base 0 -- and
// draws a different world: cut stone and mortar instead of raw rock, blue water
// instead of lava, iron and torchlight instead of moss and crystal. Nothing in
// the engine knows either pack exists; a recipe names one of them and binds the
// indices, which is the whole claim the module system makes.
//
// THE OUTPUT FORMAT (identical to `caves`; the manifest repeats it)
// -----------------------------------------------------------------
//     bytes 0..2047     pixels: 32 rows of 64 bytes, the console's own sheet
//                       layout -- 128 pixels per row at 4bpp, EVEN x in the LOW
//                       nibble. 4 sheet rows of 16 cells = 64 tiles of 8x8.
//     bytes 2048..2111  flags: one byte per tile, in tile order.
//
// TILE 0 IS EMPTY, ALWAYS. `gfx.map` never draws it, whatever the sheet holds
// there, so it is left blank and given no flags.
//
// THE PALETTE THIS ART IS DRAWN FOR is `sweetie16`, the same sixteen `caves`
// uses -- which is the point: two packs against one palette are swappable in a
// recipe without touching the palette line. The digits mean:
//
//     0 void (transparent)   4 stone body       8 sludge         c torch flame
//     1 deep shadow          5 stone light      9 sludge light   d gold / brass
//     2 mortar, dark navy    6 iron highlight   a dark wood      e water deep
//     3 stone shadow         7 sludge dark      b banner red     f water bright
//
// The neutral ramp 2..6 is doing different work here than in `caves`: there the
// rock is a noisy 4 with a mossy 9 cap, here every solid tile is bounded by a
// mortar line at 2 and capped in 6. That one rule is what makes a screen of
// this pack read as masonry at a glance rather than as a cave with new colours.

import { writeFileSync } from "node:fs";

/** solid: the player cannot pass through it. */
const SOLID = 0x01;
/** hazard: touching it kills. */
const HAZARD = 0x02;

/**
 * The 64 tiles, in order. Eight strings of eight hex digits each.
 *
 * Light falls from the top left throughout, as it does in `caves`: a top edge
 * and a left edge catch 5 or 6, a right edge and a bottom edge fall away
 * through 3, 2, 1. Courses run in a running bond -- mortar across rows 0 and 4,
 * and the vertical joint alternates between column 0 and column 4 -- so a wall
 * of tile 1 tiles seamlessly in both directions.
 */
const TILES = [
  // --- 0: nothing -----------------------------------------------------------
  ["00000000", "00000000", "00000000", "00000000", "00000000", "00000000", "00000000", "00000000"],

  // --- 1..12: cut stone -----------------------------------------------------
  // 1 brick fill
  ["22222222", "25555555", "24444444", "23333333", "22222222", "55552555", "44442444", "33332333"],
  // 2 brick fill, cracked
  ["22222222", "25555255", "24444244", "23332333", "22222222", "55522555", "44442444", "33332333"],
  // 3 brick top -- the dressed capstone course, which is the floor you land on
  ["66566665", "55555555", "22222222", "25555555", "24444444", "23333333", "22222222", "55552555"],
  // 4 brick top-left corner
  ["56666666", "55555555", "52222222", "55555555", "54444444", "53333333", "52222222", "55552555"],
  // 5 brick top-right corner
  ["66666665", "55555553", "22222232", "55555532", "44444432", "33333332", "22222232", "55552532"],
  // 6 brick left edge
  ["52222222", "55555555", "54444444", "53333333", "52222222", "55552555", "54442444", "53332333"],
  // 7 brick right edge
  ["22222232", "55555532", "44444432", "33333332", "22222232", "55552532", "44442432", "33332332"],
  // 8 brick bottom edge -- the roof seen from underneath
  ["22222222", "25555555", "24444444", "23333333", "22222222", "33333333", "22222222", "11111111"],
  // 9 brick bottom-left
  ["52222222", "55555555", "54444444", "53333333", "53333333", "32222222", "21111111", "11111111"],
  // 10 brick bottom-right
  ["22222232", "55555532", "44444432", "33333332", "33333322", "22222221", "11111111", "11111111"],
  // 11 pillar block -- lit on every side, for a one-tile block
  ["56666665", "55555553", "52222232", "55555532", "54444432", "53333332", "52222232", "32222221"],
  // 12 brick top, worn
  ["66666666", "55535555", "22222222", "25555455", "24444444", "23333333", "22222222", "55552555"],

  // --- 13..18: flagstone, the deep masonry under the floor -------------------
  // 13 flagstone fill
  ["22222222", "23333333", "23333433", "23333333", "22222222", "33332333", "33332333", "43332333"],
  // 14 flagstone, cracked
  ["22222222", "23332333", "23322333", "23333333", "22222222", "33332333", "32332333", "33332333"],
  // 15 flagstone top
  ["44444444", "22222222", "23333333", "23333333", "22222222", "33332333", "33332333", "33332333"],
  // 16 flagstone left edge
  ["42222222", "43333333", "43333333", "43333333", "42222222", "43332333", "43332333", "43332333"],
  // 17 flagstone right edge
  ["22222232", "33333332", "33333332", "33333332", "22222232", "33332332", "33332332", "33332332"],
  // 18 flagstone bottom edge
  ["22222222", "23333333", "23333333", "22222222", "33332333", "22222222", "11111111", "11111111"],

  // --- 19..22: iron-capped slabs (the ledges) -------------------------------
  // 19 slab left end
  ["06666666", "65555555", "64444444", "32222222", "00000000", "00000000", "00000000", "00000000"],
  // 20 slab middle
  ["66666666", "55555555", "44444444", "22222222", "00000000", "00000000", "00000000", "00000000"],
  // 21 slab right end
  ["66666660", "55555556", "44444446", "22222223", "00000000", "00000000", "00000000", "00000000"],
  // 22 slab, one tile wide
  ["06666660", "65555556", "64444446", "32222223", "00000000", "00000000", "00000000", "00000000"],

  // --- 23..26: iron spikes --------------------------------------------------
  // 23 spikes up
  ["00000000", "00000000", "00600060", "06500650", "65506550", "65506550", "66666666", "22222222"],
  // 24 spikes down
  ["22222222", "66666666", "65506550", "65506550", "06500650", "00600060", "00000000", "00000000"],
  // 25 spikes left
  ["00000062", "00066662", "00665562", "00006662", "00000062", "00066662", "00665562", "00006662"],
  // 26 spikes right
  ["26000000", "26666000", "26555660", "26660000", "26000000", "26666000", "26555660", "26660000"],

  // --- 27..30: flooded and fouled water -------------------------------------
  // 27 water surface
  ["0ff00ff0", "ffffffff", "feffefff", "eeeeeeee", "efeeeeef", "eeeeeeee", "eeefeeee", "eeeeeeee"],
  // 28 water body
  ["eeeeeeee", "efeeeeee", "eeeeefee", "eeeeeeee", "eefeeeee", "eeeeeeee", "eeeeeefe", "eeeeeeee"],
  // 29 sludge surface
  ["07700770", "77777777", "78777877", "88888888", "87888878", "88888888", "88878888", "88888888"],
  // 30 sludge body
  ["77777777", "78777777", "77777877", "77777777", "77877777", "77777777", "77777778", "77777777"],

  // --- 31..36: what a dungeon has instead of minerals ------------------------
  // 31 rune, small
  ["00000000", "00d00d00", "00dddd00", "000dd000", "00dddd00", "00d00d00", "00000000", "00000000"],
  // 32 rune, large
  ["00dddd00", "0d0000d0", "d00dd00d", "d0d66d0d", "d0d66d0d", "d00dd00d", "0d0000d0", "00dddd00"],
  // 33 spilled coin, a heap of it
  ["00000000", "00000000", "000d0000", "00ddd000", "0dd6dd00", "ddddddd0", "0dddddd0", "00000000"],
  // 34 iron vein in the stone
  ["44444444", "44644444", "46644444", "44444644", "44444466", "44444444", "46444444", "44444444"],
  // 35 hook on a chain, hanging from the roof
  ["00060000", "00060000", "00060000", "00060000", "00060000", "00066000", "00060600", "00000000"],
  // 36 rubble, heaped on the floor
  ["00000000", "00000000", "00000000", "00040000", "00344000", "03444300", "34443443", "44444444"],

  // --- 37..46: fittings and clutter -----------------------------------------
  // 37 crate
  ["00000000", "0aaaaaa0", "0adddda0", "0adaada0", "0adaada0", "0adddda0", "0aaaaaa0", "00000000"],
  // 38 barrel
  ["00000000", "00aaaa00", "0adddda0", "0aaaaaa0", "0adddda0", "0aaaaaa0", "0adddda0", "00aaaa00"],
  // 39 chain
  ["00066000", "00600600", "00600600", "00066000", "00066000", "00600600", "00600600", "00066000"],
  // 40 chain, ending in a shackle
  ["00066000", "00600600", "00600600", "00066000", "00666600", "06600660", "06600660", "00666600"],
  // 41 skull
  ["00000000", "00666600", "06666660", "06166160", "06666660", "00666600", "00606060", "00000000"],
  // 42 gravel
  ["00000000", "00000000", "00000000", "00000000", "00030000", "00343000", "30003430", "00000000"],
  // 43 torch, lit, in its bracket
  ["0006c000", "00cdc000", "0cddc000", "00cdc000", "000c0000", "00066000", "00666000", "00066000"],
  // 44 sconce, cold
  ["00000000", "00000000", "06666000", "06000600", "06000600", "00666000", "00060000", "00060000"],
  // 45 ladder, iron
  ["06000060", "06000060", "06666660", "06000060", "06000060", "06666660", "06000060", "06000060"],
  // 46 floor grate
  ["00000000", "66666666", "60606060", "66666666", "60606060", "66666666", "00000000", "00000000"],

  // --- 47..56: background ---------------------------------------------------
  // 47 wall tile -- big blocks, so the back wall does not compete with the floor
  ["22222222", "21111111", "21111111", "21111111", "22222222", "11112111", "11112111", "11112111"],
  // 48 wall tile, cracked
  ["22222222", "21111111", "21121111", "21111111", "22222222", "11112111", "11122111", "11112111"],
  // 49 dark
  ["11111111", "11111111", "11211111", "11111111", "11111121", "11111111", "12111111", "11111111"],
  // 50 dark, flecked
  ["11111111", "11211111", "11111111", "11111211", "12111111", "11111111", "11111121", "11111111"],
  // 51 column, left half
  ["22111111", "22111111", "23111111", "22111111", "22111111", "23111111", "22111111", "22111111"],
  // 52 column, right half
  ["11111122", "11111122", "11111132", "11111122", "11111122", "11111132", "11111122", "11111122"],
  // 53 arch springing from the wall
  ["11122111", "12222211", "22111122", "21111112", "11111111", "11111111", "11111111", "11111111"],
  // 54 rubble against the back wall
  ["11111111", "11111111", "11111111", "11111111", "11211111", "12212121", "22222222", "22222222"],
  // 55 banner
  ["22222222", "2bbbbbb2", "2bdbbdb2", "2bbddbb2", "2bdbbdb2", "2bbbbbb2", "02b00b20", "00b00b00"],
  // 56 cobweb in the corner
  ["31111113", "13111131", "11311311", "11131311", "11113111", "11111111", "11111111", "11111111"],

  // --- 57..63: the rest -----------------------------------------------------
  // 57 brick with a rune cut into it
  ["22222222", "25555555", "244dd444", "243dd344", "22dddd22", "55552555", "44442444", "33332333"],
  // 58 brick the damp has got into
  ["22999992", "25588555", "24448444", "23333333", "22222222", "55552555", "44442444", "33332333"],
  // 59 stone, sloping away to the left
  ["00000066", "00006644", "00664444", "06444444", "64444444", "44444444", "44444444", "33333333"],
  // 60 stone, sloping away to the right
  ["66000000", "44660000", "44446600", "44444460", "44444446", "44444444", "44444444", "33333333"],
  // 61 rune cluster, lit from inside
  ["000dd000", "00d66d00", "0d6ff6d0", "d6f00f6d", "d6f00f6d", "0d6ff6d0", "00d66d00", "000dd000"],
  // 62 marker post
  ["00000000", "0dddddd0", "0d6666d0", "0d6bb6d0", "0d6666d0", "0dddddd0", "00060000", "00060000"],
  // 63 checker -- the tile you place when you want to see where a tile went
  ["f2f2f2f2", "2f2f2f2f", "f2f2f2f2", "2f2f2f2f", "f2f2f2f2", "2f2f2f2f", "f2f2f2f2", "2f2f2f2f"],
];

/**
 * What each tile does, by index. Anything not named here is decoration: drawn,
 * walked through, harmless.
 *
 * The BIT ASSIGNMENT is the same as `caves` -- solid is 1, hazard is 2 -- and
 * has to be, because `solid_flag` and `hazard_flag` are engine knobs a recipe
 * sets and the two packs are meant to be swappable without touching them.
 */
const FLAGS = new Uint8Array(64);
for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]) FLAGS[n] = SOLID; // cut stone
for (const n of [13, 14, 15, 16, 17, 18]) FLAGS[n] = SOLID; // flagstone
for (const n of [19, 20, 21, 22]) FLAGS[n] = SOLID; // slabs
for (const n of [23, 24, 25, 26]) FLAGS[n] = HAZARD; // iron spikes
for (const n of [27, 28, 29, 30]) FLAGS[n] = HAZARD; // water and sludge
for (const n of [34, 57, 58, 59, 60, 63]) FLAGS[n] = SOLID; // stone variants
// Where this pack disagrees with `caves` about what a thing IS. The equivalent
// indices there -- mushrooms, a torch -- are decoration you walk through; a
// crate, a barrel and a floor grate are things you stand on. The engine reads
// the same bit and needs to know nothing about either decision.
for (const n of [37, 38, 46]) FLAGS[n] = SOLID; // crate, barrel, grate

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
  `dungeon: ${TILES.length} tiles, ${pixels.length} bytes of pixels + ${FLAGS.length} flags = ${out.length} bytes`,
);
