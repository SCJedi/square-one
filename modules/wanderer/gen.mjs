// The `wanderer` spriteset, drawn here and packed into sprites.bin.
//
//     node modules/wanderer/gen.mjs
//
// Run it from the repository root. Same contract as modules/caves/gen.mjs and
// modules/hero/gen.mjs: the art below is the source, sprites.bin is output, and
// regenerating it must produce identical bytes anywhere.
//
// THE OUTPUT FORMAT (the spriteset pack format; module.toml repeats it)
// --------------------------------------------------------------------
//     bytes 0..1023     pixels: 16 rows of 64 bytes, the console's sheet
//                       layout. 2 sheet rows of 16 cells = 32 cells of 8x8.
//     bytes 1024..1055  flags: one byte per cell. All zero -- these are entity
//                       sprites, and the flag byte is what a TILESET uses.
//
// The stamper copies the pixels to the sheet starting at cell `base` (64 for
// this pack, the start of sheet row 4) and the flags to SPRITE_FLAGS + base.
//
// EVERY SPRITE HERE IS ONE CELL, AND THAT IS THE GENRE
// ---------------------------------------------------
// `hero` is 8 x 16 because a side-on runner is taller than it is wide. A walker
// seen from above is as wide as it is deep, so a wanderer is 8 x 8 and the
// engine draws it with the console's default `gfx.spr(n, x, y)`.
//
// THE FRAME ORDER IS A CONTRACT WITH THE ENGINE, AND NOTHING CHECKS IT
// -------------------------------------------------------------------
// The walk block is FOUR DIRECTIONS of TWO FRAMES, in the order the engine
// numbers its facings: down, up, left, right. `topdown` is told the first cell
// (`sprite_walk`) and the stride between directions (`sprite_dir_stride`), and
// it counts from there -- so this pack must lay the eight cells out in exactly
// that order or the walker faces the wrong way, and no part of the manifest
// format can say so. See modules/topdown/INTERFACE-NOTES.md, which is partly
// about this sentence.
//
// The four slash cells follow in the same direction order, one cell each.
//
// PALETTE DIGITS are `sweetie16`'s, read the way modules/overworld reads them:
//
//     0 void (transparent)   4 stone body       8 grass          c wood / flame
//     1 deep shadow          5 stone light      9 grass light    d gold / sand
//     2 dark navy            6 highlight        a bark / iron    e water deep
//     3 stone shadow         7 grass dark       b bramble red    f water bright
//
// The wanderer reads as a small figure in a green cloak: `8`/`9` cloak, `a`
// hair and `d` face, `2` eyes, `3` boots. Unlike `hero` it is drawn in all four
// directions rather than mirrored, because a walker seen from above showing its
// face while walking north is the single thing that makes a top-down game read
// wrongly, and a flip cannot fix it.

import { writeFileSync } from "node:fs";

/**
 * The 8 x 8 cells, in order. Local index here; add `base` (64) for the sheet
 * cell an engine knob names.
 *
 *      0,1   walk down          cells 64, 65
 *      2,3   walk up            cells 66, 67
 *      4,5   walk left          cells 68, 69
 *      6,7   walk right         cells 70, 71
 *      8     slash down         cell  72
 *      9     slash up           cell  73
 *     10     slash left         cell  74
 *     11     slash right        cell  75
 *     12,13  chaser             cells 76, 77
 *     14,15  patroller          cells 78, 79
 *     16     coin               cell  80
 *     17     key                cell  81
 *     18     heart              cell  82
 *     19     pot                cell  83
 */
const CELLS = [
  // --- 0,1: walking toward the viewer. The face is visible; the feet swap. ---
  ["00aaaa00", "0aaaaaa0", "0d2dd2d0", "0dddddd0", "09888890", "98888889", "08888880", "03300330"],
  ["00aaaa00", "0aaaaaa0", "0d2dd2d0", "0dddddd0", "09888890", "98888889", "08888880", "00333300"],

  // --- 2,3: walking away. No face at all -- the back of the head. -----------
  ["00aaaa00", "0aaaaaa0", "0aaaaaa0", "09888890", "98888889", "08888880", "08888880", "03300330"],
  ["00aaaa00", "0aaaaaa0", "0aaaaaa0", "09888890", "98888889", "08888880", "08888880", "00333300"],

  // --- 4,5: walking west. One eye, and the feet lead left. ------------------
  ["00aaaa00", "0aaaaaa0", "0d2dddd0", "0dddddd0", "09888890", "98888880", "08888800", "03330000"],
  ["00aaaa00", "0aaaaaa0", "0d2dddd0", "0dddddd0", "09888890", "98888880", "08888800", "00333000"],

  // --- 6,7: walking east ----------------------------------------------------
  ["00aaaa00", "0aaaaaa0", "0dddd2d0", "0dddddd0", "09888890", "08888889", "00888880", "00003330"],
  ["00aaaa00", "0aaaaaa0", "0dddd2d0", "0dddddd0", "09888890", "08888889", "00888880", "00033300"],

  // --- 8..11: the swing. A crescent of blade, drawn BESIDE the walker -------
  // The engine offsets it by attack_reach in the facing direction, so each of
  // these is the arc as seen from the walker looking that way.
  // 8 slash down
  ["00000000", "06000060", "06600660", "06666660", "05666650", "00555500", "00000000", "00000000"],
  // 9 slash up
  ["00000000", "00000000", "00555500", "05666650", "06666660", "06600660", "06000060", "00000000"],
  // 10 slash left
  ["00000600", "00005600", "00065600", "00666500", "00666500", "00065600", "00005600", "00000600"],
  // 11 slash right
  ["06000000", "06500000", "06560000", "05666000", "05666000", "06560000", "06500000", "06000000"],

  // --- 12,13: the chaser. A red wisp; the wings beat, the body hangs. -------
  ["00000000", "0b0000b0", "0bb00bb0", "0bbbbbb0", "0b2bb2b0", "0bbbbbb0", "00b00b00", "00000000"],
  ["00000000", "00000000", "0bb00bb0", "0bbbbbb0", "0b2bb2b0", "0bbbbbb0", "0b0000b0", "00b00b00"],

  // --- 14,15: the patroller. An armoured beetle; the legs shuffle. ----------
  ["00000000", "00effe00", "0effffe0", "ef2ff2fe", "0effffe0", "00effe00", "0e0000e0", "00000000"],
  ["00000000", "00effe00", "0effffe0", "ef2ff2fe", "0effffe0", "00effe00", "00e00e00", "0e0000e0"],

  // --- 16..19: things on the ground ----------------------------------------
  // 16 coin
  ["00000000", "000dd000", "00d66d00", "0d6dd6d0", "0d6dd6d0", "00d66d00", "000dd000", "00000000"],
  // 17 key -- ring at the top, teeth at the bottom, so it reads at 8 pixels
  ["00ddd000", "0d000d00", "0d000d00", "00ddd000", "000d0000", "000d0000", "000ddd00", "000d0d00"],
  // 18 heart
  ["00000000", "0bb00bb0", "bbbbbbbb", "bbbbbbbb", "0bbbbbb0", "00bbbb00", "000bb000", "00000000"],
  // 19 pot
  ["00000000", "00cccc00", "0cccccc0", "caaaaaac", "caaaaaac", "0cccccc0", "00cccc00", "00000000"],
];

/** Sheet bytes per pixel row, and cells across. Fixed by the console. */
const STRIDE = 64;
const COLS = 16;

/** Two sheet rows: the pack is 32 cells, whether or not every one is drawn. */
const ROWS_OF_CELLS = 2;
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

if (CELLS.length > ROWS_OF_CELLS * COLS) {
  throw new Error(`${CELLS.length} cells, and the pack is ${ROWS_OF_CELLS * COLS}`);
}
for (let k = 0; k < CELLS.length; k++) {
  if (CELLS[k].length !== 8) throw new Error(`cell ${k}: ${CELLS[k].length} rows, expected 8`);
  draw(k, CELLS[k]);
}

const out = new Uint8Array(pixels.length + flags.length);
out.set(pixels, 0);
out.set(flags, pixels.length);

writeFileSync(new URL("./sprites.bin", import.meta.url), out);
console.log(
  `wanderer: ${CELLS.length} cells drawn of ${ROWS_OF_CELLS * COLS}, ` +
    `${pixels.length} bytes of pixels + ${flags.length} flags = ${out.length} bytes`,
);
