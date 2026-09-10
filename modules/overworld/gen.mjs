// The `overworld` tileset, drawn here and packed into tiles.bin.
//
//     node modules/overworld/gen.mjs
//
// Run it from the repository root. It rewrites modules/overworld/tiles.bin and
// prints a byte count. Regenerating must produce identical bytes on any machine:
// there is no clock, no randomness and no floating point in this file.
//
// WHY THE ART IS SOURCE AND THE .bin IS OUTPUT
// -------------------------------------------
// Same contract as modules/caves/gen.mjs. A .bin cannot be reviewed; the art
// below is one hex digit per pixel, and the digit IS the live palette slot the
// pixel shows. Only the packing at the bottom knows about nibbles.
//
// THE OUTPUT FORMAT (the tileset pack format; module.toml repeats it)
// ------------------------------------------------------------------
//     bytes 0..2047     pixels: 32 rows of 64 bytes, the console's own sheet
//                       layout -- 128 pixels per row at 4bpp, EVEN x in the LOW
//                       nibble. 4 sheet rows of 16 cells = 64 tiles of 8x8.
//     bytes 2048..2111  flags: one byte per tile, in tile order.
//
// TILE 0 IS EMPTY, ALWAYS. `gfx.map` never draws it, whatever the sheet holds
// there, so it is left blank and given no flags.
//
// THE PALETTE THIS ART IS DRAWN FOR is `sweetie16`, the same sixteen the caves
// use. An overworld wants different things from them, so the digits are read
// differently -- the moss ramp becomes grass, the rock ramp becomes masonry,
// and the crystal blues become water:
//
//     0 void (transparent)   4 stone body       8 grass          c wood / flame
//     1 deep shadow          5 stone light      9 grass light    d gold / sand
//     2 dark navy            6 highlight        a bark / iron    e water deep
//     3 stone shadow         7 grass dark       b bramble red    f water bright
//
// LIGHT FALLS FROM THE TOP LEFT throughout, exactly as in `caves`: a top edge
// and a left edge catch 5 or 6, a right edge and a bottom edge fall away through
// 3, 2, 1. One rule, and tiles cut from different groups still look like one
// world.
//
// WHAT A TOP-DOWN TILESET NEEDS THAT A PLATFORMER ONE DOES NOT
// -----------------------------------------------------------
// Three flags rather than two, and the third one is the interesting one:
//
//     solid   the walker cannot pass through it
//     hazard  standing on it costs health
//     door    it opens, once, if the walker is carrying a key
//
// `door` is a flag that changes the MAP: the engine writes `tile_door_open` over
// it. A platformer tileset never has to say that a tile is a thing you can
// operate. See modules/topdown/INTERFACE-NOTES.md for what the manifest could
// and could not say about that.

import { writeFileSync } from "node:fs";

/** solid: the walker cannot pass through it. */
const SOLID = 0x01;
/** hazard: standing on it costs health. */
const HAZARD = 0x02;
/** door: a key opens it, and the engine replaces it with tile_door_open. */
const DOOR = 0x04;

/**
 * The 64 tiles, in order. Eight strings of eight hex digits each.
 *
 * Grouped so a recipe author reading `[names]` in module.toml can find a whole
 * family at once: ground, masonry, water, hazards, doors, keep interior, props.
 */
const TILES = [
  // --- 0: nothing -----------------------------------------------------------
  ["00000000", "00000000", "00000000", "00000000", "00000000", "00000000", "00000000", "00000000"],

  // --- 1..10: ground you can walk on ---------------------------------------
  // 1 grass -- the default floor of the whole map
  ["88888888", "89888988", "88888888", "88788878", "88888888", "98889888", "88888888", "88788878"],
  // 2 grass, tufted: the same green, different noise, so a field is not a screen door
  ["88888888", "88988898", "89989989", "88888888", "98888889", "88888888", "88989888", "88888888"],
  // 3 grass with flowers -- pure decoration, no flag
  ["88888888", "88d88888", "8ddd8888", "88d88b88", "888bbb88", "888b8888", "88888888", "88888888"],
  // 4 grass with pebbles
  ["88888888", "88888888", "88558888", "85558888", "88588888", "88888858", "88888555", "88888888"],
  // 5 path -- packed stone, the road between places
  ["44444444", "45444454", "44454444", "44444444", "54444445", "44445444", "44444444", "44544444"],
  // 6 path, worn darker
  ["44344444", "44444344", "43444444", "44444443", "44344444", "44444344", "43444444", "44444434"],
  // 7 sand
  ["dddddddd", "ddcddddd", "dddddcdd", "dddddddd", "dcdddddd", "ddddddcd", "dddddddd", "ddddcddd"],
  // 8 sand, rippled
  ["dddddddd", "dddcdddd", "ddcccddd", "dddcdddd", "dddddddd", "dcdddddd", "dddddddd", "ddddddcd"],
  // 9 deep moss
  ["77777777", "78777877", "77777777", "77877787", "77777777", "87778777", "77777777", "77877787"],
  // 10 deep moss, clumped
  ["77777777", "77877877", "78878887", "77777777", "87777778", "77777777", "77878777", "77777777"],

  // --- 11..22: masonry and rock. SOLID. ------------------------------------
  // 11 wall -- coursed stone, the joint offset every other course
  ["55555555", "54444443", "54444443", "33333333", "55555555", "44435444", "44435444", "33333333"],
  // 12 wall top -- the lit cap, for the row a wall is seen from above
  ["66666666", "66666666", "55555555", "54444443", "54444443", "33333333", "55555555", "44435444"],
  // 13 wall, left edge lit
  ["55555555", "55444443", "55444443", "53333332", "55555555", "55435444", "55435444", "53333332"],
  // 14 wall, right edge falling away
  ["55555555", "54444433", "54444433", "33333322", "55555555", "44435433", "44435433", "33333322"],
  // 15 wall, bottom edge -- the shadow a wall casts on itself
  ["55555555", "54444443", "54444443", "33333333", "44444444", "33333333", "22222222", "11111111"],
  // 16 wall, top-left corner
  ["66666666", "65555555", "55555555", "55444443", "55444443", "53333332", "55555555", "55435444"],
  // 17 wall, top-right corner
  ["66666666", "55555556", "55555555", "54444433", "54444433", "33333322", "55555555", "44435433"],
  // 18 wall, ruined: the courses break up
  ["53355335", "54453443", "54444443", "33333333", "55355355", "44435444", "44435443", "33333333"],
  // 19 boulder -- grass in the corners, so it sits ON the field
  ["88344388", "83555438", "35555543", "45555554", "45555554", "34555543", "83444438", "88333388"],
  // 20 small rock
  ["88888888", "88344388", "83555438", "35555543", "34555443", "88344388", "88888888", "88888888"],
  // 21 cliff face -- the edge of the world, read from above
  ["55555555", "44444444", "33333333", "32323232", "22222222", "21212121", "11111111", "11111111"],
  // 22 pillar
  ["85555558", "85444458", "85444458", "85444458", "85444458", "85444458", "83333338", "82222228"],

  // --- 23..28: water. SOLID -- a moat is a wall you can see the bottom of. --
  // 23 open water
  ["eeeeeeee", "eefeeeee", "eeeeeeee", "eeeeefee", "efeeeeee", "eeeeeeee", "eeefeeee", "eeeeeeee"],
  // 24 open water, rippling
  ["eeeeeeee", "effeeffe", "eeeeeeee", "eeeffeee", "effeeeee", "eeeeeffe", "eeeeeeee", "effeeeee"],
  // 25 shore, grass to the north
  ["88888888", "88888888", "e8ee8eee", "eeeeeeee", "eefeeeee", "eeeeeeee", "eeeeefee", "eeeeeeee"],
  // 26 shore, grass to the south
  ["eeeeeeee", "eefeeeee", "eeeeeeee", "eeeeefee", "eeeeeeee", "ee8ee8ee", "88888888", "88888888"],
  // 27 shore, grass to the west
  ["88eeeeee", "88eefeee", "8eeeeeee", "88eeeeee", "8eeeeeee", "88eeefee", "8eeeeeee", "88eeeeee"],
  // 28 shore, grass to the east
  ["eeeeee88", "eefeee88", "eeeeeee8", "eeeeee88", "eeeeeee8", "eefeee88", "eeeeeee8", "eeeeee88"],

  // --- 29..33: hazards. HAZARD, and NOT solid -- you may walk in and regret it
  // 29 brambles
  ["87888878", "78b88b87", "87bbbb78", "8bb88bb8", "87bbbb78", "78b88b87", "87888878", "88788788"],
  // 30 brambles, dense
  ["88788788", "87b88b78", "8bbbbbb8", "87b88b78", "8bbbbbb8", "87b88b78", "88788788", "88888888"],
  // 31 iron spikes, set in the ground
  ["88888888", "88688688", "86668668", "86668668", "66666666", "33333333", "88888888", "88888888"],
  // 32 fire
  ["88888888", "888b8888", "88bcb888", "8bcdcb88", "bcddcbc8", "8cdddc88", "88ccc888", "88888888"],
  // 33 bog -- dark ground with something in it
  ["77a77777", "77777a77", "7a777777", "77777777", "777a7777", "77777777", "7a7777a7", "77777777"],

  // --- 34..37: doors. DOOR + SOLID, and their opened forms, which are neither
  // 34 wooden door, locked -- the gold is the lock plate
  ["33333333", "3cccccc3", "3cacacc3", "3ccdccc3", "3ccdccc3", "3cacacc3", "3cccccc3", "33333333"],
  // 35 the same doorway, open: a dark threshold you walk through
  ["33333333", "32222223", "31111113", "31111113", "31111113", "31111113", "32222223", "33333333"],
  // 36 iron gate, locked
  ["33333333", "35353533", "35353533", "35555553", "35353533", "35353533", "35555553", "33333333"],
  // 37 iron gate, open
  ["33333333", "32222223", "32111123", "32111123", "32111123", "32111123", "32222223", "33333333"],

  // --- 38..45: the inside of the keep ---------------------------------------
  // 38 flagstone floor
  ["44444443", "43333332", "43333332", "43333332", "43333332", "43333332", "43333332", "32222221"],
  // 39 flagstone, cracked
  ["44444443", "43333332", "43323332", "43233332", "43332332", "43333232", "43333332", "32222221"],
  // 40 checked floor
  ["44443333", "44443333", "44443333", "44443333", "33334444", "33334444", "33334444", "33334444"],
  // 41 rug
  ["33333333", "3bbbbbb3", "3bddddb3", "3bdbbdb3", "3bdbbdb3", "3bddddb3", "3bbbbbb3", "33333333"],
  // 42 stair
  ["66666666", "55555555", "44444444", "66666666", "55555555", "44444444", "66666666", "55555555"],
  // 43 chest. SOLID -- furniture is a wall
  ["44444443", "43cccc32", "4cddddc2", "4cdddcc2", "4c6666c2", "4cccccc2", "43333332", "32222221"],
  // 44 altar. SOLID
  ["44444443", "43555532", "45666654", "45666654", "43555532", "43444432", "43333332", "32222221"],
  // 45 brazier. SOLID
  ["44444443", "433bc332", "43bdcb32", "433cc332", "43355332", "43355332", "43333332", "32222221"],

  // --- 46..55: things standing on the field ---------------------------------
  // 46 tree. SOLID
  ["88799788", "87999978", "79999997", "79988997", "79999997", "87999978", "888aa888", "888aa888"],
  // 47 pine. SOLID
  ["88898888", "88999888", "89999988", "99999998", "88899888", "89999988", "888aa888", "888aa888"],
  // 48 stump -- walkable, it is only knee high
  ["88888888", "888aa888", "88aaaa88", "8acccca8", "8acccca8", "88aaaa88", "888aa888", "88888888"],
  // 49 bush -- walkable, and hides what is under it from nobody
  ["88888888", "88799788", "87999978", "79999997", "79999997", "87999978", "88799788", "88888888"],
  // 50 signpost. SOLID
  ["88888888", "8dddddd8", "8d6666d8", "8d6666d8", "8dddddd8", "888aa888", "888aa888", "88888888"],
  // 51 fence, running east-west. SOLID
  ["88888888", "88888888", "cccccccc", "88888888", "cccccccc", "88a888a8", "88a888a8", "88888888"],
  // 52 fence, running north-south. SOLID
  ["888cc888", "888cc888", "88cccc88", "888cc888", "888cc888", "88cccc88", "888cc888", "888cc888"],
  // 53 well. SOLID
  ["88888888", "85555558", "54eeee45", "54eeee45", "54444445", "85444458", "88555588", "88888888"],
  // 54 statue. SOLID
  ["88866888", "88656688", "88666688", "88866888", "88566588", "88566588", "85555558", "85555558"],
  // 55 barrel. SOLID
  ["88888888", "8cccccc8", "8caaaac8", "8cccccc8", "8caaaac8", "8cccccc8", "8caaaac8", "88888888"],

  // --- 56..63: the rest -----------------------------------------------------
  // 56 bridge, east-west
  ["aaaaaaaa", "cccccccc", "caccccac", "cccccccc", "cccccccc", "caccccac", "cccccccc", "aaaaaaaa"],
  // 57 bridge, north-south
  ["acccccca", "acccccca", "aaccccaa", "acccccca", "acccccca", "aaccccaa", "acccccca", "acccccca"],
  // 58 tall grass
  ["88988988", "89998998", "89998998", "88988988", "89998998", "89998998", "88988988", "88888888"],
  // 59 mushrooms
  ["88888888", "88bbbb88", "8bb66bb8", "bbb66bbb", "8bbbbbb8", "888dd888", "888dd888", "88888888"],
  // 60 crystal. SOLID
  ["88888888", "888f8888", "88fff888", "8ffefff8", "8feeeef8", "88feef88", "888ee888", "88888888"],
  // 61 gravestone. SOLID
  ["88888888", "88555588", "85666658", "85666658", "85655658", "85555558", "88555588", "88888888"],
  // 62 marker -- a tile you can see from a mile off, for finding a bug in a map
  ["66666666", "6bbbbbb6", "6b6666b6", "6b6dd6b6", "6b6dd6b6", "6b6666b6", "6bbbbbb6", "66666666"],
  // 63 checker -- the other one
  ["ffff0000", "ffff0000", "ffff0000", "ffff0000", "0000ffff", "0000ffff", "0000ffff", "0000ffff"],
];

/**
 * Which tiles carry which flags.
 *
 * Written as a list of (flag, tiles) rather than a byte per tile, because the
 * question a reader has is "what is solid?" and not "what is tile 44?".
 */
const FLAGGED = [
  // masonry, rock, water, furniture, trees, fences and props
  [SOLID, [11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22,
           23, 24, 25, 26, 27, 28,
           43, 44, 45,
           46, 47, 50, 51, 52, 53, 54, 55,
           60, 61]],
  [HAZARD, [29, 30, 31, 32, 33]],
  // A door is solid until it is opened, and it is the DOOR flag that tells an
  // engine it can be opened at all.
  [SOLID | DOOR, [34, 36]],
];

/** Sheet bytes per pixel row, and cells across. Fixed by the console. */
const STRIDE = 64;
const COLS = 16;

/** Four sheet rows: 64 tiles, whether or not every one is drawn. */
const ROWS_OF_CELLS = 4;
const pixels = new Uint8Array(ROWS_OF_CELLS * 8 * STRIDE);
const flags = new Uint8Array(ROWS_OF_CELLS * COLS);

/** Draw one 8x8 cell of art at local cell `cell`. */
function draw(cell, art) {
  const ox = (cell % COLS) * 8;
  const oy = Math.floor(cell / COLS) * 8;
  for (let r = 0; r < art.length; r++) {
    const line = art[r];
    if (line.length !== 8) throw new Error(`cell ${cell} row ${r}: "${line}" is not 8 characters`);
    for (let c = 0; c < 8; c++) {
      const v = parseInt(line[c], 16);
      if (Number.isNaN(v)) throw new Error(`cell ${cell} row ${r}: "${line[c]}" is not a hex digit`);
      const px = ox + c;
      const i = (oy + r) * STRIDE + (px >> 1);
      pixels[i] = (px & 1) === 0 ? (pixels[i] & 0xf0) | v : (pixels[i] & 0x0f) | (v << 4);
    }
  }
}

if (TILES.length !== ROWS_OF_CELLS * COLS) {
  throw new Error(`${TILES.length} tiles, expected ${ROWS_OF_CELLS * COLS}`);
}
for (let k = 0; k < TILES.length; k++) {
  if (TILES[k].length !== 8) throw new Error(`tile ${k}: ${TILES[k].length} rows, expected 8`);
  draw(k, TILES[k]);
}

for (const [bits, list] of FLAGGED) {
  for (const t of list) {
    if (t <= 0 || t >= TILES.length) throw new Error(`flagged tile ${t} is not in the pack`);
    flags[t] |= bits;
  }
}

const out = new Uint8Array(pixels.length + flags.length);
out.set(pixels, 0);
out.set(flags, pixels.length);

writeFileSync(new URL("./tiles.bin", import.meta.url), out);

let solid = 0;
let hazard = 0;
let door = 0;
for (const f of flags) {
  if (f & SOLID) solid++;
  if (f & HAZARD) hazard++;
  if (f & DOOR) door++;
}
console.log(
  `overworld: ${TILES.length} tiles (${solid} solid, ${hazard} hazard, ${door} door), ` +
    `${pixels.length} bytes of pixels + ${flags.length} flags = ${out.length} bytes`,
);
