// The `hero` spriteset, drawn here and packed into sprites.bin.
//
//     node modules/hero/gen.mjs
//
// Run it from the repository root. Same contract as modules/caves/gen.mjs: the
// art below is the source, sprites.bin is output, and regenerating it must
// produce identical bytes anywhere.
//
// THE OUTPUT FORMAT (the spriteset pack format; module.toml repeats it)
// --------------------------------------------------------------------
//     bytes 0..1023     pixels: 16 rows of 64 bytes, the console's sheet
//                       layout. 2 sheet rows of 16 cells = 32 cells of 8x8.
//     bytes 1024..1055  flags: one byte per cell, in cell order.
//
// The stamper copies the pixels to the sheet starting at cell `base` (declared
// in module.toml -- 64 for this pack, the start of sheet row 4) and the flags to
// ADDR.SPRITE_FLAGS + base.
//
// A TALL SPRITE IS TWO CELLS, STACKED
// -----------------------------------
// The runner is 8 wide and 16 tall, which on this console is `gfx.spr(n, x, y,
// 1, 2)`: cell n and cell n + 16, because the sheet is one 128-wide picture and
// the cell below n is 16 indices later. So frame k of the runner occupies cells
// 64 + k and 80 + k, and the engine is told the first index by a knob. The 8x8
// sprites -- the crawler and the gem -- sit in the cells after the runner's
// frames and use only the upper row.
//
// Palette digits are `sweetie16`'s, the same as the caves pack:
//
//     0 void (transparent)   4 rock body        8 moss           c lava orange
//     1 deep shadow          5 rock light       9 moss light     d gold
//     2 dark navy            6 highlight        a ember dark     e crystal deep
//     3 rock shadow          7 moss dark        b danger red     f crystal bright
//
// The runner reads as a small figure in a bright blue coat: `f` coat, `e` hood
// and legs, `d` face and hands, `2` eyes, `3` boots. It is drawn facing right;
// the engine mirrors it with `gfx.spr`'s flip argument rather than carrying a
// second set of frames.

import { writeFileSync } from "node:fs";

/**
 * The runner, 8 x 16, one entry per frame. Order matters: the engine is given
 * the index of the first frame of each group and counts forward from it.
 *
 *     0  idle, breathing out      cells 64 / 80
 *     1  idle, breathing in       cells 65 / 81
 *     2  run, contact             cells 66 / 82
 *     3  run, passing             cells 67 / 83
 *     4  run, contact (opposite)  cells 68 / 84
 *     5  run, passing (opposite)  cells 69 / 85
 *     6  jump, rising             cells 70 / 86
 *     7  fall                     cells 71 / 87
 *     8  hurt                     cells 72 / 88
 */
const TALL = [
  // 0 -- idle, arms down
  [
    "00000000", "00eeee00", "0effffe0", "0edddde0", "0e2dd2e0", "0edddde0", "00dddd00", "00ffff00",
    "0ffffff0", "dffffffd", "dffffffd", "0ffffff0", "0dddddd0", "00eeee00", "00e00e00", "03300330",
  ],
  // 1 -- idle, one pixel lower: the whole figure settles, which is all a breath is
  [
    "00000000", "00000000", "00eeee00", "0effffe0", "0edddde0", "0e2dd2e0", "0edddde0", "00dddd00",
    "00ffff00", "0ffffff0", "dffffffd", "0ffffff0", "0dddddd0", "00eeee00", "00e00e00", "03300330",
  ],
  // 2 -- run, contact: legs apart, right arm forward
  [
    "00000000", "00eeee00", "0effffe0", "0edddde0", "0e2dd2e0", "0edddde0", "00dddd00", "00ffff00",
    "0ffffff0", "0fffffff", "dffffff0", "0ffffff0", "0dddddd0", "00eeee00", "0ee00ee0", "33000033",
  ],
  // 3 -- run, passing: body lifts a pixel, legs come together under it
  [
    "00eeee00", "0effffe0", "0edddde0", "0e2dd2e0", "0edddde0", "00dddd00", "00ffff00", "0ffffff0",
    "dffffffd", "0ffffff0", "0dddddd0", "00eeee00", "000ee000", "000ee000", "00333300", "00000000",
  ],
  // 4 -- run, contact: the other foot, the other arm
  [
    "00000000", "00eeee00", "0effffe0", "0edddde0", "0e2dd2e0", "0edddde0", "00dddd00", "00ffff00",
    "0ffffff0", "fffffff0", "0ffffffd", "0ffffff0", "0dddddd0", "00eeee00", "0ee00ee0", "33000033",
  ],
  // 5 -- run, passing: knee crossing forward
  [
    "00eeee00", "0effffe0", "0edddde0", "0e2dd2e0", "0edddde0", "00dddd00", "00ffff00", "0ffffff0",
    "dffffffd", "0ffffff0", "0dddddd0", "00eeee00", "00eee000", "00e00e00", "03300330", "00000000",
  ],
  // 6 -- jump: arms up, knees tucked
  [
    "00000000", "00eeee00", "0effffe0", "0edddde0", "0e2dd2e0", "0edddde0", "d0dddd0d", "d0ffff0d",
    "0ffffff0", "0ffffff0", "0ffffff0", "0dddddd0", "00eeee00", "0ee00ee0", "03300330", "00000000",
  ],
  // 7 -- fall: arms out, legs spread, reaching for the floor
  [
    "00000000", "00eeee00", "0effffe0", "0edddde0", "0e2dd2e0", "0edddde0", "00dddd00", "d0ffff0d",
    "dffffffd", "0ffffff0", "0ffffff0", "0dddddd0", "0ee00ee0", "0e0000e0", "33000033", "00000000",
  ],
  // 8 -- hurt: the coat goes red, the eyes go shut, the figure folds
  [
    "00000000", "00000000", "00eeee00", "0effffe0", "0edddde0", "0e2222e0", "0edddde0", "00dddd00",
    "00bbbb00", "bbbbbbbb", "0bbbbbb0", "0bbbbbb0", "0dddddd0", "00eeee00", "0e0000e0", "33000033",
  ],
];

/**
 * The 8 x 8 sprites, placed in the cells after the runner's frames.
 *
 *     9   crawler, legs out     cell 73
 *     10  crawler, legs in      cell 74
 *     11  gem                   cell 75
 */
const SHORT = [
  // crawler, legs out
  ["00a00a00", "0abbbba0", "ab2bb2ba", "abbbbbba", "0abbbba0", "00a00a00", "0a0000a0", "00000000"],
  // crawler, legs in -- the body drops a pixel and the legs gather
  ["00000000", "00a00a00", "0abbbba0", "ab2bb2ba", "abbbbbba", "0abbbba0", "0a0000a0", "00a00a00"],
  // gem
  ["00000000", "000dd000", "00d66d00", "0d6666d0", "0d6666d0", "00dccd00", "000cc000", "00000000"],
];

/** Sheet bytes per pixel row, and cells across. Fixed by the console. */
const STRIDE = 64;
const COLS = 16;

/** Two sheet rows: the pack is 32 cells, whether or not every one is drawn. */
const ROWS_OF_CELLS = 2;
const pixels = new Uint8Array(ROWS_OF_CELLS * 8 * STRIDE);
const flags = new Uint8Array(ROWS_OF_CELLS * COLS);

/** Draw one column of art -- 8 wide, `art.length` tall -- at local cell `cell`. */
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

// A tall frame is written as one 8 x 16 column of pixels. Nothing here has to
// know that the console will read it back as two cells: the sheet is one
// picture, so the second cell IS the second eight rows.
for (let k = 0; k < TALL.length; k++) {
  if (TALL[k].length !== 16) throw new Error(`frame ${k}: ${TALL[k].length} rows, expected 16`);
  draw(k, TALL[k]);
}
for (let k = 0; k < SHORT.length; k++) {
  if (SHORT[k].length !== 8) throw new Error(`sprite ${k}: ${SHORT[k].length} rows, expected 8`);
  draw(TALL.length + k, SHORT[k]);
}

const out = new Uint8Array(pixels.length + flags.length);
out.set(pixels, 0);
out.set(flags, pixels.length);

writeFileSync(new URL("./sprites.bin", import.meta.url), out);
console.log(
  `hero: ${TALL.length} tall frames + ${SHORT.length} small sprites, ` +
    `${pixels.length} bytes of pixels + ${flags.length} flags = ${out.length} bytes`,
);
