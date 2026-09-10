/**
 * The hardware palette and the RGBA lookup the presenter uses.
 *
 * Two levels, deliberately:
 *
 *   PALETTE_HW    64 fixed RGB triples -- what the console can produce at all.
 *   PALETTE_LIVE  16 bytes, each an index into those 64 -- what it shows now.
 *
 * A cart that wants a fade, a hit flash, a night tint or a two-colour dissolve
 * rewrites 16 bytes of PALETTE_LIVE. It does not ship a palette, does not touch
 * the framebuffer, and the cost is the same whatever the effect. That is why
 * entries 16-63 exist and why they are derived rather than hand-picked: they
 * are the darker, lighter and greyer versions of the base 16, so every base
 * colour has somewhere to fade to.
 */

import { ADDR, HW_COLORS, LIVE_COLORS } from "./memory";

/**
 * The specification's reference palette, entries 0-15.
 *
 * 00 #0d0b12  01 #1c1a2b  02 #3a3550  03 #6b6486
 * 04 #a8a2bd  05 #e8e6f0  06 #ffffff  07 #7f2b4a
 * 08 #d94f5c  09 #f2934a  0a #f7d46b  0b #3f7d4e
 * 0c #6ec27a  0d #2c5f8a  0e #4a9dd4  0f #9b6fd4
 */
const BASE_16: readonly number[] = [
  0x0d, 0x0b, 0x12, 0x1c, 0x1a, 0x2b, 0x3a, 0x35, 0x50, 0x6b, 0x64, 0x86, 0xa8, 0xa2, 0xbd, 0xe8,
  0xe6, 0xf0, 0xff, 0xff, 0xff, 0x7f, 0x2b, 0x4a, 0xd9, 0x4f, 0x5c, 0xf2, 0x93, 0x4a, 0xf7, 0xd4,
  0x6b, 0x3f, 0x7d, 0x4e, 0x6e, 0xc2, 0x7a, 0x2c, 0x5f, 0x8a, 0x4a, 0x9d, 0xd4, 0x9b, 0x6f, 0xd4,
];

/**
 * Build the full 64-entry hardware palette.
 *
 * Entries 0-15 are BASE_16 verbatim. Entries 16-63 are three derived ramps,
 * computed with integer arithmetic only -- no floats anywhere, so regenerating
 * the table on any engine reproduces the same 192 bytes. For base colour
 * (r, g, b), with `>>` being an arithmetic shift on non-negative operands:
 *
 *   16 + i  DARK   channel -> (c * 5) >> 3
 *                  Five eighths of the original. A fade toward black that keeps
 *                  hue, because every channel is scaled by the same factor.
 *
 *   32 + i  LIGHT  channel -> c + (((255 - c) * 3) >> 3)
 *                  Three eighths of the way to white. Scaling the headroom
 *                  rather than the value keeps a channel that is already 255
 *                  at 255 and cannot overflow.
 *
 *   48 + i  GREY   y = (77*r + 150*g + 29*b) >> 8;  channel -> (c + y) >> 1
 *                  Halfway to that colour's luma. 77/150/29 are the Rec.601
 *                  weights scaled by 256 and rounded to integers; they sum to
 *                  256 exactly, so y lands in [0, 255] for every input.
 *
 * Every operation above is on integers in [0, 255] and every result is too, so
 * the ramps are exactly reproducible and the function is total.
 */
function buildHwPalette(): Uint8Array {
  const p = new Uint8Array(HW_COLORS * 3);

  for (let i = 0; i < BASE_16.length; i++) {
    p[i] = BASE_16[i] as number;
  }

  for (let i = 0; i < 16; i++) {
    const r = p[i * 3 + 0] as number;
    const g = p[i * 3 + 1] as number;
    const b = p[i * 3 + 2] as number;

    // 16..31 -- darkened ramp.
    p[(16 + i) * 3 + 0] = (r * 5) >> 3;
    p[(16 + i) * 3 + 1] = (g * 5) >> 3;
    p[(16 + i) * 3 + 2] = (b * 5) >> 3;

    // 32..47 -- lightened ramp.
    p[(32 + i) * 3 + 0] = r + (((255 - r) * 3) >> 3);
    p[(32 + i) * 3 + 1] = g + (((255 - g) * 3) >> 3);
    p[(32 + i) * 3 + 2] = b + (((255 - b) * 3) >> 3);

    // 48..63 -- desaturated ramp, halfway to luma.
    const y = (77 * r + 150 * g + 29 * b) >> 8;
    p[(48 + i) * 3 + 0] = (r + y) >> 1;
    p[(48 + i) * 3 + 1] = (g + y) >> 1;
    p[(48 + i) * 3 + 2] = (b + y) >> 1;
  }

  return p;
}

/**
 * The 192-byte hardware palette, 64 x RGB888.
 *
 * Shared and treated as read-only: `boot` copies it into RAM, and every write a
 * cart makes goes to its copy at ADDR.PALETTE_HW, never to this one.
 */
export const HW_PALETTE: Uint8Array = buildHwPalette();

/**
 * Regenerate the derived ramps from scratch. Exported for the test that proves
 * the formula above is the formula that produced HW_PALETTE.
 */
export function regenerateHwPalette(): Uint8Array {
  return buildHwPalette();
}

/** The boot live palette: slot i shows hardware entry i. */
export function defaultLive(): Uint8Array {
  const live = new Uint8Array(LIVE_COLORS);
  for (let i = 0; i < LIVE_COLORS; i++) live[i] = i;
  return live;
}

/**
 * True when this platform stores the low byte of a word first.
 *
 * Detected once with a two-byte probe rather than assumed. Every desktop and
 * mobile CPU that will ever run this is little-endian, so the big-endian branch
 * in the packing below is a branch never taken -- but "never taken" is a
 * property worth being able to state, and the alternative is a silent
 * red-and-blue swap on the one machine that is different. Four lines to turn a
 * class of port bug into a documented no-op.
 */
export const LITTLE_ENDIAN: boolean = (() => {
  const probe = new Uint16Array(1);
  probe[0] = 0x0102;
  const bytes = new Uint8Array(probe.buffer);
  return bytes[0] === 0x02;
})();

/**
 * Pack one RGB triple the way a Uint32Array view over an RGBA canvas buffer
 * wants it. On a little-endian machine the first byte in memory is the low byte
 * of the word, so R must sit in the low 8 bits: 0xAABBGGRR.
 */
function packRGBA(r: number, g: number, b: number): number {
  return LITTLE_ENDIAN
    ? (((0xff << 24) | (b << 16) | (g << 8) | r) >>> 0)
    : (((r << 24) | (g << 16) | (b << 8) | 0xff) >>> 0);
}

/**
 * Fill a preallocated 16-entry RGBA lookup from the palette regions of `ram`.
 *
 * Allocation-free, so `present()` can refresh the lookup every frame without
 * producing garbage. `buildLut` is the allocating convenience wrapper.
 *
 * For live slot i: hw = PALETTE_LIVE[i], then read the RGB triple at
 * PALETTE_HW + hw*3. `hw` is masked to 0..63 so a cart that pokes 200 into a
 * live slot gets a defined colour instead of reading into DRAW_REMAP.
 */
export function writeLut(ram: Uint8Array, lut: Uint32Array): void {
  for (let i = 0; i < LIVE_COLORS; i++) {
    const hw = (ram[ADDR.PALETTE_LIVE + i] as number) & (HW_COLORS - 1);
    const o = ADDR.PALETTE_HW + hw * 3;
    lut[i] = packRGBA(ram[o] as number, ram[o + 1] as number, ram[o + 2] as number);
  }
}

/** Allocate and fill a 16-entry RGBA lookup. See `writeLut`. */
export function buildLut(ram: Uint8Array): Uint32Array {
  const lut = new Uint32Array(LIVE_COLORS);
  writeLut(ram, lut);
  return lut;
}
