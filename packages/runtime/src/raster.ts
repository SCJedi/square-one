/**
 * The rasterizer. Writes straight into the packed 4bpp framebuffer inside
 * `ram` -- there is no shadow buffer and no "flush" step, because the
 * framebuffer IS the machine state and a snapshot has to catch it mid-frame.
 *
 * Two rules hold everywhere in this file.
 *
 * CLIP ONCE PER PRIMITIVE. The bounds test happens when a primitive works out
 * which rows and columns it will touch, never inside the loop that writes
 * pixels. A branch per pixel costs more than the entire rest of a fill.
 *
 * NO ALLOCATION. Nothing here constructs an object, an array or a closure. The
 * one cached typed-array view (see `u32ViewOf`) is created at most once per
 * distinct backing buffer, which in practice means once per machine.
 *
 * Colour remapping is NOT done here. A colour arriving at `pset` has already
 * been through DRAW_REMAP; the machine's API layer does that, so this file
 * stays a dumb fast path with no palette knowledge at all. See machine.ts.
 *
 * THE SPRITE SHEET IS A 128 x 128 PICTURE (normative, and permanent)
 * -----------------------------------------------------------------
 * SPRITES is 8192 bytes and it is addressed as ONE 128 x 128 pixel image at
 * 4bpp -- a 16 x 16 grid of 8 x 8 sprites -- NOT as 256 independent 32-byte
 * tiles. Sprite n lives at grid cell (n & 15, n >> 4), so its top-left pixel is
 * ((n & 15) * 8, (n >> 4) * 8), and the byte holding sheet pixel (px, py) is
 *
 *     ADDR.SPRITES + py * SHEET_STRIDE + (px >> 1)      even px = LOW nibble
 *
 * which is the framebuffer's own addressing with a different base. Three things
 * follow, and they are the reason for the choice:
 *
 *   - `sspr` needs pixel coordinates into a sheet. A linear tile array has no
 *     such coordinate system, so `sspr` would have to be defined in terms of
 *     tile boundaries and would stop being able to lift a 12 x 20 region out of
 *     the middle of a drawing.
 *   - a sprite wider than one cell is contiguous in x, so `spr(n, x, y, 2, 2)`
 *     reads the four cells that LOOK adjacent in an editor.
 *   - source and destination share a stride and a nibble order, which is what
 *     makes the whole-byte blit below possible at all.
 *
 * Carts depend on this forever. It is a format decision, not an implementation
 * detail.
 *
 * TRANSPARENCY LIVES IN RAM AT 0x20E8
 * -----------------------------------
 * `spr`, `sspr`, `map` and `print` skip pixels whose colour is marked
 * transparent. The mark is a 16-bit little-endian mask at ADDR_PALT (0x20E8),
 * bit c set meaning "colour c is transparent". It sits in the reserved gap
 * between CAMERA and INPUT_NOW, which is exactly why it is there: the mask is
 * machine state, and machine state that is not inside the 64 KB buffer is not
 * captured by `snapshot()`. Boot writes 0x0001 -- colour 0 transparent, nothing
 * else -- and `palt` edits it.
 *
 * CAMERA IS A DRAW OFFSET
 * -----------------------
 * CAMERA holds i16 x and y, little endian. Every primitive that takes a
 * position subtracts it, so world point (x, y) is drawn at screen point
 * (x - camX, y - camY). `rect`, `line`, `circ`, `spr`, `sspr`, `map` and
 * `print` read it here; `pset` and `pget` are the RAW screen-space accessors
 * this file uses internally and do not (the machine's `gfx.pset` / `gfx.pget`
 * apply it at the API layer, so the ABI stays consistent). `cls`, `clip` and
 * `present` are screen operations and ignore it by definition.
 *
 * DRAW_REMAP applies to a COLOUR ARGUMENT, never to sprite pixels. Sprite,
 * tile-map and blit pixels are copied through untouched. Remapping them would
 * put a table lookup in the per-pixel path of every blit and would make the
 * whole-byte copy below impossible, which is a high price for an effect a cart
 * can get by rewriting PALETTE_LIVE instead.
 */

import { FONT_ADVANCE, FONT_H, FONT_W, glyphRowBits } from "./font";
import { ADDR, LEN, MAP_H, MAP_W, SCREEN_H, SCREEN_W } from "./memory";

/**
 * Write one pixel. The caller has already clipped and already remapped the
 * colour; this does neither.
 *
 * EVEN x is the LOW nibble of its byte. Two pixels per byte, x pairs left to
 * right, so pixel (0,0) is the low nibble of byte 0 and pixel (1,0) is the
 * high nibble of the same byte.
 */
export function pset(ram: Uint8Array, x: number, y: number, c: number): void {
  const i = ADDR.FRAMEBUFFER + (y << 6) + (x >> 1);
  const b = ram[i] as number;
  ram[i] = (x & 1) === 0 ? (b & 0xf0) | (c & 0x0f) : (b & 0x0f) | ((c & 0x0f) << 4);
}

/**
 * Read one pixel. Out-of-screen reads return 0 rather than throwing: `pget` is
 * reachable from a cart, and a cart must not be able to crash the machine.
 */
export function pget(ram: Uint8Array, x: number, y: number): number {
  if (x < 0 || y < 0 || x >= SCREEN_W || y >= SCREEN_H) return 0;
  const b = ram[ADDR.FRAMEBUFFER + (y << 6) + (x >> 1)] as number;
  return (x & 1) === 0 ? b & 0x0f : b >>> 4;
}

/**
 * A cached 32-bit view over a machine's RAM, for the wide fill in `cls`.
 *
 * Keyed on the backing buffer, so passing the same machine's RAM twice reuses
 * the view and allocates nothing. A different machine (a test, a rewind buffer)
 * replaces the cache; that costs one allocation on the first call and none
 * after, and the alternative -- constructing a view per frame -- would allocate
 * inside the frame loop, which is the thing this package refuses to do.
 *
 * Returns null when RAM is not 4-byte aligned or not 4-byte sized, in which
 * case `cls` falls back to a byte loop. That never happens for a real machine
 * (65536 bytes at offset 0) but a test may hand us a subarray.
 */
let cachedBuffer: ArrayBufferLike | null = null;
let cachedOffset = -1;
let cachedU32: Uint32Array | null = null;

function u32ViewOf(ram: Uint8Array): Uint32Array | null {
  if (ram.buffer === cachedBuffer && ram.byteOffset === cachedOffset) return cachedU32;
  cachedBuffer = ram.buffer;
  cachedOffset = ram.byteOffset;
  cachedU32 =
    ram.byteOffset % 4 === 0 && ram.byteLength >= LEN.FRAMEBUFFER
      ? new Uint32Array(ram.buffer, ram.byteOffset, ram.byteLength >>> 2)
      : null;
  return cachedU32;
}

/**
 * Clear the whole screen to colour c.
 *
 * `cls` ignores CLIP. That is the console's defined behaviour and it matches
 * every machine of this shape: clip is a drawing restriction, and clearing the
 * screen is not drawing. A cart that wants a clipped clear draws a filled rect.
 *
 * The fill is 32 bits wide: 8192 bytes is 2048 words, and one word carries
 * eight pixels of the same colour.
 */
export function cls(ram: Uint8Array, c: number): void {
  const n = c & 0x0f;
  const byte = n | (n << 4);
  const u32 = u32ViewOf(ram);
  if (u32 !== null) {
    const word = (byte | (byte << 8) | (byte << 16) | (byte << 24)) >>> 0;
    const start = ADDR.FRAMEBUFFER >>> 2;
    const end = start + (LEN.FRAMEBUFFER >>> 2);
    u32.fill(word, start, end);
    return;
  }
  ram.fill(byte, ADDR.FRAMEBUFFER, ADDR.FRAMEBUFFER + LEN.FRAMEBUFFER);
}

/**
 * Set the clipping rectangle from a position and a size, clamped to the screen.
 *
 * Stored as INCLUSIVE bounds x0, y0, x1, y1. An empty rectangle (w or h at or
 * below zero, or a rectangle entirely off screen) is stored as x0=1, x1=0 --
 * x1 < x0, which every primitive already reads as "nothing passes". Encoding
 * emptiness inside the same four bytes means there is no separate "clip
 * enabled" flag to keep in sync, and a snapshot carries it for free.
 */
export function clip(ram: Uint8Array, x: number, y: number, w: number, h: number): void {
  let x0 = x;
  let y0 = y;
  let x1 = x + w - 1;
  let y1 = y + h - 1;

  if (x0 < 0) x0 = 0;
  if (y0 < 0) y0 = 0;
  if (x1 > SCREEN_W - 1) x1 = SCREEN_W - 1;
  if (y1 > SCREEN_H - 1) y1 = SCREEN_H - 1;

  if (w <= 0 || h <= 0 || x1 < x0 || y1 < y0) {
    ram[ADDR.CLIP + 0] = 1;
    ram[ADDR.CLIP + 1] = 1;
    ram[ADDR.CLIP + 2] = 0;
    ram[ADDR.CLIP + 3] = 0;
    return;
  }

  ram[ADDR.CLIP + 0] = x0;
  ram[ADDR.CLIP + 1] = y0;
  ram[ADDR.CLIP + 2] = x1;
  ram[ADDR.CLIP + 3] = y1;
}

/** Reset CLIP to the whole screen. Used by boot. */
export function clipReset(ram: Uint8Array): void {
  ram[ADDR.CLIP + 0] = 0;
  ram[ADDR.CLIP + 1] = 0;
  ram[ADDR.CLIP + 2] = SCREEN_W - 1;
  ram[ADDR.CLIP + 3] = SCREEN_H - 1;
}

/** True when (x, y) is inside the current clip rectangle. */
export function inClip(ram: Uint8Array, x: number, y: number): boolean {
  return (
    x >= (ram[ADDR.CLIP + 0] as number) &&
    y >= (ram[ADDR.CLIP + 1] as number) &&
    x <= (ram[ADDR.CLIP + 2] as number) &&
    y <= (ram[ADDR.CLIP + 3] as number)
  );
}

/**
 * A horizontal run of pixels, already clipped, from x0 to x1 inclusive.
 *
 * The odd first pixel and the odd last pixel are written as nibbles; everything
 * between them is written a whole byte -- two pixels -- at a time. That is the
 * whole reason a 4bpp fill is worth writing out rather than looping `pset`.
 */
function hline(ram: Uint8Array, x0: number, x1: number, y: number, c: number): void {
  const n = c & 0x0f;
  const row = ADDR.FRAMEBUFFER + (y << 6);
  let x = x0;

  if ((x & 1) === 1) {
    const i = row + (x >> 1);
    ram[i] = ((ram[i] as number) & 0x0f) | (n << 4);
    x++;
  }

  const both = n | (n << 4);
  const lastPair = (x1 & 1) === 1 ? x1 : x1 - 1;
  for (; x < lastPair; x += 2) {
    ram[row + (x >> 1)] = both;
  }

  if (x <= x1) {
    // One pixel left over: x is even and equals x1.
    const i = row + (x >> 1);
    ram[i] = ((ram[i] as number) & 0xf0) | n;
  }
}

/**
 * Rectangle, filled or outline, in machine coordinates.
 *
 * The clip test happens exactly once, here, by intersecting the rectangle with
 * the CLIP region before any pixel is touched. After that intersection every
 * write is known to be in bounds, so the inner loops have no branches.
 *
 * An outline rectangle draws each of its four edges clipped independently, so a
 * box that hangs off the left of the clip region still shows its right edge.
 *
 * `x` and `y` are world coordinates: CAMERA is subtracted here. It reads zero
 * until a cart moves it, so this is the same rectangle it always was.
 */
export function rect(
  ram: Uint8Array,
  x: number,
  y: number,
  w: number,
  h: number,
  c: number,
  fill: boolean,
): void {
  if (w <= 0 || h <= 0) return;

  const cx0 = ram[ADDR.CLIP + 0] as number;
  const cy0 = ram[ADDR.CLIP + 1] as number;
  const cx1 = ram[ADDR.CLIP + 2] as number;
  const cy1 = ram[ADDR.CLIP + 3] as number;
  if (cx1 < cx0 || cy1 < cy0) return;

  const rx0 = x - camX(ram);
  const ry0 = y - camY(ram);
  const rx1 = rx0 + w - 1;
  const ry1 = ry0 + h - 1;

  const x0 = rx0 > cx0 ? rx0 : cx0;
  const y0 = ry0 > cy0 ? ry0 : cy0;
  const x1 = rx1 < cx1 ? rx1 : cx1;
  const y1 = ry1 < cy1 ? ry1 : cy1;
  if (x1 < x0 || y1 < y0) return;

  if (fill) {
    for (let yy = y0; yy <= y1; yy++) hline(ram, x0, x1, yy, c);
    return;
  }

  // Outline: top and bottom edges, then the two side columns between them.
  if (ry0 >= y0 && ry0 <= y1) hline(ram, x0, x1, ry0, c);
  if (ry1 !== ry0 && ry1 >= y0 && ry1 <= y1) hline(ram, x0, x1, ry1, c);

  const sy0 = ry0 + 1 > y0 ? ry0 + 1 : y0;
  const sy1 = ry1 - 1 < y1 ? ry1 - 1 : y1;
  const leftIn = rx0 >= x0 && rx0 <= x1;
  const rightIn = rx1 !== rx0 && rx1 >= x0 && rx1 <= x1;
  for (let yy = sy0; yy <= sy1; yy++) {
    if (leftIn) pset(ram, rx0, yy, c);
    if (rightIn) pset(ram, rx1, yy, c);
  }
}

/**
 * The palette expand. 8192 packed bytes in, 16384 RGBA words out, one pass and
 * no branches -- the low nibble is the even pixel, so it is emitted first.
 *
 * `out` and `lut` are preallocated by the caller; this allocates nothing and is
 * the only place the framebuffer is read for display.
 */
export function present(ram: Uint8Array, out: Uint32Array, lut: Uint32Array): void {
  const base = ADDR.FRAMEBUFFER;
  let o = 0;
  for (let i = 0; i < LEN.FRAMEBUFFER; i++) {
    const b = ram[base + i] as number;
    out[o++] = lut[b & 0x0f] as number;
    out[o++] = lut[b >>> 4] as number;
  }
}

// ---------------------------------------------------------------------------
// CAMERA
// ---------------------------------------------------------------------------

/**
 * The camera offset, i16 little endian at ADDR.CAMERA.
 *
 * Sign-extended by shifting left 16 and arithmetic-shifting back, which is the
 * cheapest exact i16 decode and has no branch.
 */
export function camX(ram: Uint8Array): number {
  return (((ram[ADDR.CAMERA + 0] as number) | ((ram[ADDR.CAMERA + 1] as number) << 8)) << 16) >> 16;
}

/** See `camX`. */
export function camY(ram: Uint8Array): number {
  return (((ram[ADDR.CAMERA + 2] as number) | ((ram[ADDR.CAMERA + 3] as number) << 8)) << 16) >> 16;
}

/** Set CAMERA. Coordinates are clamped to i16, which is the width of the field. */
export function camera(ram: Uint8Array, x: number, y: number): void {
  const cx = clampI16(x);
  const cy = clampI16(y);
  ram[ADDR.CAMERA + 0] = cx & 0xff;
  ram[ADDR.CAMERA + 1] = (cx >> 8) & 0xff;
  ram[ADDR.CAMERA + 2] = cy & 0xff;
  ram[ADDR.CAMERA + 3] = (cy >> 8) & 0xff;
}

/**
 * Clamp to the i16 range.
 *
 * Every primitive runs its inputs through this before doing arithmetic on them.
 * It is not decoration: a `line` from 0 to 2^31 would otherwise be a loop with
 * two billion iterations, and a cart must not be able to wedge the machine with
 * an arithmetic bug. Clamping changes the picture only for coordinates 256
 * screens away, and it makes every intermediate below exact in a double.
 */
function clampI16(v: number): number {
  const n = v | 0;
  return n < -32768 ? -32768 : n > 32767 ? 32767 : n;
}

// ---------------------------------------------------------------------------
// TRANSPARENCY
// ---------------------------------------------------------------------------

/**
 * The transparency mask: u16 little endian, bit c set means colour c is
 * transparent. See the file header for why the address is 0x20E8.
 */
export const ADDR_PALT = 0x20e8;

/** Bytes at ADDR_PALT. */
export const LEN_PALT = 2;

/** The boot mask: colour 0 transparent, every other colour opaque. */
export const PALT_DEFAULT = 0x0001;

/** Read the transparency mask. */
export function paltMask(ram: Uint8Array): number {
  return ((ram[ADDR_PALT] as number) | ((ram[ADDR_PALT + 1] as number) << 8)) & 0xffff;
}

/** Mark colour `c` transparent or opaque. */
export function palt(ram: Uint8Array, c: number, on: boolean): void {
  const bit = 1 << (c & 0x0f);
  const next = on ? paltMask(ram) | bit : paltMask(ram) & ~bit;
  ram[ADDR_PALT] = next & 0xff;
  ram[ADDR_PALT + 1] = (next >>> 8) & 0xff;
}

/** Restore the boot mask. Used by boot, and by `palt` with no arguments. */
export function paltReset(ram: Uint8Array): void {
  ram[ADDR_PALT] = PALT_DEFAULT & 0xff;
  ram[ADDR_PALT + 1] = (PALT_DEFAULT >>> 8) & 0xff;
}

// ---------------------------------------------------------------------------
// THE SPRITE SHEET
// ---------------------------------------------------------------------------

/** The sheet is one 128 x 128 picture. See the file header. */
export const SHEET_W = 128;
export const SHEET_H = 128;

/** Bytes per sheet row: 128 pixels at two per byte. Identical to FB_STRIDE. */
export const SHEET_STRIDE = 64;

/** Sheet pixel at (px, py). Out of the sheet reads 0, so it is total. */
export function sheetPixel(ram: Uint8Array, px: number, py: number): number {
  if (px < 0 || py < 0 || px >= SHEET_W || py >= SHEET_H) return 0;
  const b = ram[ADDR.SPRITES + py * SHEET_STRIDE + (px >> 1)] as number;
  return (px & 1) === 0 ? b & 0x0f : b >>> 4;
}

/** Write a sheet pixel. Out of the sheet is a no-op. Used by tools and tests. */
export function setSheetPixel(ram: Uint8Array, px: number, py: number, c: number): void {
  if (px < 0 || py < 0 || px >= SHEET_W || py >= SHEET_H) return;
  const i = ADDR.SPRITES + py * SHEET_STRIDE + (px >> 1);
  const b = ram[i] as number;
  ram[i] = (px & 1) === 0 ? (b & 0xf0) | (c & 0x0f) : (b & 0x0f) | ((c & 0x0f) << 4);
}

/**
 * The 1:1 blit, and the only place sprite pixels reach the framebuffer.
 *
 * `sx, sy, sw, sh` are sheet pixels and are ALREADY clamped inside the sheet by
 * the caller. `dx, dy` are screen pixels -- CAMERA has already been subtracted.
 * Nothing here allocates and nothing here reads CLIP more than once.
 *
 * THE WHOLE-BYTE PATH
 * -------------------
 * A framebuffer byte holds two horizontally adjacent pixels, and so does a sheet
 * byte, in the same nibble order. So when
 *
 *     nothing is transparent   AND   there is no flip   AND
 *     the source and destination x have the same parity
 *
 * a whole byte can be assigned straight across, moving two pixels per write
 * instead of a read-modify-write per pixel. Tiles land on an 8-pixel grid, and 8
 * is even, so a tile map drawn at an even x hits this path for every byte of
 * every tile -- which is most of the pixels most carts push. The odd leading
 * pixel is written on its own first, after which both cursors are even and stay
 * even together.
 *
 * The decision is made once, before the row loop, because the parities and the
 * mask cannot change inside it. spr/sspr/map/blit agree pixel-for-pixel across
 * both paths, and raster.test.ts proves it by drawing the same sprite at an odd
 * and an even x and comparing.
 */
export function blit(
  ram: Uint8Array,
  sx: number,
  sy: number,
  sw: number,
  sh: number,
  dx: number,
  dy: number,
  fx: boolean,
  fy: boolean,
): void {
  if (sw <= 0 || sh <= 0) return;

  const cx0 = ram[ADDR.CLIP + 0] as number;
  const cy0 = ram[ADDR.CLIP + 1] as number;
  const cx1 = ram[ADDR.CLIP + 2] as number;
  const cy1 = ram[ADDR.CLIP + 3] as number;
  if (cx1 < cx0 || cy1 < cy0) return;

  const x0 = dx > cx0 ? dx : cx0;
  const y0 = dy > cy0 ? dy : cy0;
  const xe = dx + sw - 1;
  const ye = dy + sh - 1;
  const x1 = xe < cx1 ? xe : cx1;
  const y1 = ye < cy1 ? ye : cy1;
  if (x1 < x0 || y1 < y0) return;

  const mask = paltMask(ram);

  // Source column for the first drawn destination column, and the step.
  const startS = fx ? sx + sw - 1 - (x0 - dx) : sx + (x0 - dx);
  const stepS = fx ? -1 : 1;
  const fast = mask === 0 && !fx && ((x0 ^ startS) & 1) === 0;

  for (let y = y0; y <= y1; y++) {
    const srcRow = fy ? sy + sh - 1 - (y - dy) : sy + (y - dy);
    const srcBase = ADDR.SPRITES + srcRow * SHEET_STRIDE;
    const dstBase = ADDR.FRAMEBUFFER + (y << 6);

    if (fast) {
      let x = x0;
      let s = startS;
      if ((x & 1) === 1) {
        const b = ram[srcBase + (s >> 1)] as number;
        const p = (s & 1) === 0 ? b & 0x0f : b >>> 4;
        const i = dstBase + (x >> 1);
        ram[i] = ((ram[i] as number) & 0x0f) | (p << 4);
        x++;
        s++;
      }
      for (; x < x1; x += 2, s += 2) {
        ram[dstBase + (x >> 1)] = ram[srcBase + (s >> 1)] as number;
      }
      if (x === x1) {
        const b = ram[srcBase + (s >> 1)] as number;
        const p = (s & 1) === 0 ? b & 0x0f : b >>> 4;
        const i = dstBase + (x >> 1);
        ram[i] = ((ram[i] as number) & 0xf0) | p;
      }
      continue;
    }

    let s = startS;
    for (let x = x0; x <= x1; x++, s += stepS) {
      const b = ram[srcBase + (s >> 1)] as number;
      const p = (s & 1) === 0 ? b & 0x0f : b >>> 4;
      if (((mask >>> p) & 1) === 0) {
        const i = dstBase + (x >> 1);
        ram[i] =
          (x & 1) === 0 ? ((ram[i] as number) & 0xf0) | p : ((ram[i] as number) & 0x0f) | (p << 4);
      }
    }
  }
}

/**
 * Draw sprite `n`, `w` x `h` cells of 8 x 8, at (x, y) in world coordinates.
 *
 * A region that runs off the right or bottom edge of the sheet is TRUNCATED
 * there rather than wrapping to the next row of cells. Wrapping would make
 * `spr(15, x, y, 2, 1)` read the left edge of the sheet, which is never what
 * anybody drew.
 */
export function spr(
  ram: Uint8Array,
  n: number,
  x: number,
  y: number,
  w: number,
  h: number,
  fx: boolean,
  fy: boolean,
): void {
  const idx = (n | 0) & 0xff;
  const sx = (idx & 15) * 8;
  const sy = (idx >> 4) * 8;
  let sw = (w | 0) * 8;
  let sh = (h | 0) * 8;
  if (sw <= 0 || sh <= 0) return;
  if (sx + sw > SHEET_W) sw = SHEET_W - sx;
  if (sy + sh > SHEET_H) sh = SHEET_H - sy;
  blit(ram, sx, sy, sw, sh, clampI16(x) - camX(ram), clampI16(y) - camY(ram), fx, fy);
}

/** The largest destination a stretched blit may claim, in pixels. */
const SSPR_MAX = 4096;

/**
 * Stretched blit: an sw x sh rectangle of the sheet into a dw x dh rectangle of
 * the screen, nearest neighbour.
 *
 * The source rectangle is CLAMPED into the sheet before scaling; a caller that
 * asks for pixels the sheet does not have gets the part it does have, stretched.
 * That keeps every source read in bounds without a test per pixel.
 *
 * Source column for destination column i is `sx + (i * sw / dw | 0)` -- integer
 * division of exact integers, so it is bit-identical on every engine. At a 1:1
 * scale the whole thing hands off to `blit`, so a cart that uses `sspr` for an
 * unscaled sub-rectangle still gets the whole-byte path.
 */
export function sspr(
  ram: Uint8Array,
  sx: number,
  sy: number,
  sw: number,
  sh: number,
  dx: number,
  dy: number,
  dw: number,
  dh: number,
  fx: boolean,
  fy: boolean,
): void {
  let sx0 = sx | 0;
  let sy0 = sy | 0;
  let sw0 = sw | 0;
  let sh0 = sh | 0;
  let dw0 = dw | 0;
  let dh0 = dh | 0;
  if (sw0 <= 0 || sh0 <= 0 || dw0 <= 0 || dh0 <= 0) return;
  if (dw0 > SSPR_MAX) dw0 = SSPR_MAX;
  if (dh0 > SSPR_MAX) dh0 = SSPR_MAX;

  if (sx0 < 0) {
    sw0 += sx0;
    sx0 = 0;
  }
  if (sy0 < 0) {
    sh0 += sy0;
    sy0 = 0;
  }
  if (sx0 >= SHEET_W || sy0 >= SHEET_H) return;
  if (sx0 + sw0 > SHEET_W) sw0 = SHEET_W - sx0;
  if (sy0 + sh0 > SHEET_H) sh0 = SHEET_H - sy0;
  if (sw0 <= 0 || sh0 <= 0) return;

  const px = clampI16(dx) - camX(ram);
  const py = clampI16(dy) - camY(ram);

  if (dw0 === sw0 && dh0 === sh0) {
    blit(ram, sx0, sy0, sw0, sh0, px, py, fx, fy);
    return;
  }

  const cx0 = ram[ADDR.CLIP + 0] as number;
  const cy0 = ram[ADDR.CLIP + 1] as number;
  const cx1 = ram[ADDR.CLIP + 2] as number;
  const cy1 = ram[ADDR.CLIP + 3] as number;
  if (cx1 < cx0 || cy1 < cy0) return;

  const x0 = px > cx0 ? px : cx0;
  const y0 = py > cy0 ? py : cy0;
  const xe = px + dw0 - 1;
  const ye = py + dh0 - 1;
  const x1 = xe < cx1 ? xe : cx1;
  const y1 = ye < cy1 ? ye : cy1;
  if (x1 < x0 || y1 < y0) return;

  const mask = paltMask(ram);

  for (let y = y0; y <= y1; y++) {
    const j = (((y - py) * sh0) / dh0) | 0;
    const srcRow = sy0 + (fy ? sh0 - 1 - j : j);
    const srcBase = ADDR.SPRITES + srcRow * SHEET_STRIDE;
    const dstBase = ADDR.FRAMEBUFFER + (y << 6);
    for (let x = x0; x <= x1; x++) {
      const i = (((x - px) * sw0) / dw0) | 0;
      const s = sx0 + (fx ? sw0 - 1 - i : i);
      const b = ram[srcBase + (s >> 1)] as number;
      const p = (s & 1) === 0 ? b & 0x0f : b >>> 4;
      if (((mask >>> p) & 1) === 0) {
        const o = dstBase + (x >> 1);
        ram[o] =
          (x & 1) === 0 ? ((ram[o] as number) & 0xf0) | p : ((ram[o] as number) & 0x0f) | (p << 4);
      }
    }
  }
}

/**
 * Draw a `cw` x `ch` region of the tile map, its top-left tile being map cell
 * (cx, cy), with that tile's top-left pixel landing at world (sx, sy).
 *
 * `layer` filters by SPRITE_FLAGS: a tile is drawn when `layer` is 0, or when
 * `SPRITE_FLAGS[tile] & layer` is non-zero. That is what lets one map hold a
 * background and a foreground and be drawn in two passes with entities between
 * them, without a second map.
 *
 * TILE 0 IS EMPTY. It is never drawn, whatever the sheet holds at sprite 0.
 * A map is mostly nothing, and a console that blits 8 x 8 of transparent pixels
 * for every nothing spends most of a frame doing it. The convention costs
 * sprite 0 as a drawable tile and buys an empty map for free.
 *
 * Tiles outside the 128 x 64 map are skipped rather than wrapping, and the tile
 * loop is clamped to the CLIP rectangle before it starts, so drawing a 128 x 64
 * map through an 8 x 8 clip visits four tiles.
 */
export function map(
  ram: Uint8Array,
  cx: number,
  cy: number,
  sx: number,
  sy: number,
  cw: number,
  ch: number,
  layer: number,
): void {
  const cw0 = cw | 0;
  const ch0 = ch | 0;
  if (cw0 <= 0 || ch0 <= 0) return;

  const clx0 = ram[ADDR.CLIP + 0] as number;
  const cly0 = ram[ADDR.CLIP + 1] as number;
  const clx1 = ram[ADDR.CLIP + 2] as number;
  const cly1 = ram[ADDR.CLIP + 3] as number;
  if (clx1 < clx0 || cly1 < cly0) return;

  const px = clampI16(sx) - camX(ram);
  const py = clampI16(sy) - camY(ram);
  const cx00 = cx | 0;
  const cy00 = cy | 0;
  const lay = layer & 0xff;

  // Column j covers screen x [px + j*8, px + j*8 + 7]. Solve for the j range
  // that can touch the clip rectangle, with a floor division that is correct
  // for negatives (>> 3 on a possibly-negative numerator is exactly that).
  let j0 = (clx0 - px - 7) >> 3;
  let j1 = (clx1 - px) >> 3;
  if (j0 < 0) j0 = 0;
  if (j1 > cw0 - 1) j1 = cw0 - 1;
  let i0 = (cly0 - py - 7) >> 3;
  let i1 = (cly1 - py) >> 3;
  if (i0 < 0) i0 = 0;
  if (i1 > ch0 - 1) i1 = ch0 - 1;

  for (let i = i0; i <= i1; i++) {
    const my = cy00 + i;
    if (my < 0 || my >= MAP_H) continue;
    const rowBase = ADDR.MAP + my * MAP_W;
    for (let j = j0; j <= j1; j++) {
      const mx = cx00 + j;
      if (mx < 0 || mx >= MAP_W) continue;
      const tile = ram[rowBase + mx] as number;
      if (tile === 0) continue;
      if (lay !== 0 && ((ram[ADDR.SPRITE_FLAGS + tile] as number) & lay) === 0) continue;
      blit(ram, (tile & 15) * 8, (tile >> 4) * 8, 8, 8, px + j * 8, py + i * 8, false, false);
    }
  }
}

// ---------------------------------------------------------------------------
// LINES AND CIRCLES
// ---------------------------------------------------------------------------

/**
 * A line, endpoints inclusive, and EXACTLY symmetric.
 *
 * WHY THE ENDPOINTS ARE SORTED FIRST
 * ----------------------------------
 * `line(a, b)` must light the same pixels as `line(b, a)`. Bresenham run from
 * either end does not: at a half-step tie the error term breaks the same way
 * relative to the direction of travel, so the two runs disagree on the pixels
 * either side of the middle. Sorting the endpoints into a canonical order --
 * smaller x first, ties broken by smaller y -- makes the two calls literally
 * the same call, so symmetry is structural rather than something the arithmetic
 * has to be lucky enough to give. raster.test.ts checks it over a fan of
 * several hundred pairs.
 *
 * THE RULE (normative)
 * --------------------
 * With (ax, ay) the canonical first endpoint, adx = |dx|, ady = |dy| and
 * sy = sign(dy), for a line with adx >= ady:
 *
 *     x(i) = ax + i,   y(i) = ay + sy * floor((2*i*ady + adx) / (2*adx))
 *
 * for i in 0..adx, and the mirror image with the axes swapped otherwise. That
 * is the midpoint line with ties rounded up, it hits both endpoints exactly, and
 * it is closed form -- which is what lets the loop start at the first i inside
 * the clip rectangle instead of stepping there.
 *
 * CLIPPING
 * --------
 * The major-axis range is clamped to the clip rectangle before the loop, which
 * both clips and bounds the work at 128 iterations however far away the
 * endpoints are. The minor axis is handled by a single test made BEFORE the
 * loop: when the segment's bounding box is inside the clip rectangle -- the
 * common case -- the loop has no bounds branch at all. When it is not, the
 * fallback loop tests the minor coordinate per pixel, over at most 128 pixels.
 */
export function line(
  ram: Uint8Array,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  c: number,
): void {
  const ox = camX(ram);
  const oy = camY(ram);
  let ax = clampI16(x0) - ox;
  let ay = clampI16(y0) - oy;
  let bx = clampI16(x1) - ox;
  let by = clampI16(y1) - oy;

  if (bx < ax || (bx === ax && by < ay)) {
    const tx = ax;
    ax = bx;
    bx = tx;
    const ty = ay;
    ay = by;
    by = ty;
  }

  const cx0 = ram[ADDR.CLIP + 0] as number;
  const cy0 = ram[ADDR.CLIP + 1] as number;
  const cx1 = ram[ADDR.CLIP + 2] as number;
  const cy1 = ram[ADDR.CLIP + 3] as number;
  if (cx1 < cx0 || cy1 < cy0) return;

  const loy = ay < by ? ay : by;
  const hiy = ay < by ? by : ay;
  if (bx < cx0 || ax > cx1 || hiy < cy0 || loy > cy1) return;
  const whollyInside = ax >= cx0 && bx <= cx1 && loy >= cy0 && hiy <= cy1;

  const n = c & 0x0f;
  const adx = bx - ax;
  const ady = by >= ay ? by - ay : ay - by;
  const sy = by >= ay ? 1 : -1;

  if (adx === 0 && ady === 0) {
    if (ax >= cx0 && ax <= cx1 && ay >= cy0 && ay <= cy1) pset(ram, ax, ay, n);
    return;
  }

  if (adx >= ady) {
    let i0 = cx0 - ax;
    let i1 = cx1 - ax;
    if (i0 < 0) i0 = 0;
    if (i1 > adx) i1 = adx;
    const den = 2 * adx;
    if (whollyInside) {
      for (let i = i0; i <= i1; i++) {
        pset(ram, ax + i, ay + sy * Math.floor((2 * i * ady + adx) / den), n);
      }
    } else {
      for (let i = i0; i <= i1; i++) {
        const yy = ay + sy * Math.floor((2 * i * ady + adx) / den);
        if (yy >= cy0 && yy <= cy1) pset(ram, ax + i, yy, n);
      }
    }
    return;
  }

  let j0: number;
  let j1: number;
  if (sy === 1) {
    j0 = cy0 - ay;
    j1 = cy1 - ay;
  } else {
    j0 = ay - cy1;
    j1 = ay - cy0;
  }
  if (j0 < 0) j0 = 0;
  if (j1 > ady) j1 = ady;
  const den = 2 * ady;
  if (whollyInside) {
    for (let j = j0; j <= j1; j++) {
      pset(ram, ax + Math.floor((2 * j * adx + ady) / den), ay + sy * j, n);
    }
  } else {
    for (let j = j0; j <= j1; j++) {
      const xx = ax + Math.floor((2 * j * adx + ady) / den);
      if (xx >= cx0 && xx <= cx1) pset(ram, xx, ay + sy * j, n);
    }
  }
}

/** One horizontal span, clamped to the clip rectangle. Used by the circle fill. */
function hspan(
  ram: Uint8Array,
  y: number,
  x0: number,
  x1: number,
  cx0: number,
  cy0: number,
  cx1: number,
  cy1: number,
  c: number,
): void {
  if (y < cy0 || y > cy1) return;
  const a = x0 > cx0 ? x0 : cx0;
  const b = x1 < cx1 ? x1 : cx1;
  if (b < a) return;
  hline(ram, a, b, y, c);
}

/**
 * A circle, outline or filled, by the midpoint algorithm.
 *
 * r = 0 is a single pixel, which is the limit the arithmetic already gives and
 * the thing a cart drawing a shrinking explosion wants on the last frame.
 *
 * The fill is drawn as spans from the SAME octant walk that draws the outline,
 * so `circ(x, y, r, c, true)` fills exactly the disc `circ(x, y, r, c, false)`
 * outlines -- no separate distance test that could disagree with it by a pixel.
 * Some rows are covered twice; with an opaque colour that is invisible and costs
 * about 40% more spans than the minimum, which is cheaper than the bookkeeping
 * to avoid it.
 *
 * As with `line`, the "is the bounding box inside the clip rectangle" test is
 * made once, before the walk.
 */
export function circ(
  ram: Uint8Array,
  x: number,
  y: number,
  r: number,
  c: number,
  fill: boolean,
): void {
  const px = clampI16(x) - camX(ram);
  const py = clampI16(y) - camY(ram);
  let rr = r | 0;
  if (rr < 0) return;
  if (rr > 32767) rr = 32767;

  const cx0 = ram[ADDR.CLIP + 0] as number;
  const cy0 = ram[ADDR.CLIP + 1] as number;
  const cx1 = ram[ADDR.CLIP + 2] as number;
  const cy1 = ram[ADDR.CLIP + 3] as number;
  if (cx1 < cx0 || cy1 < cy0) return;
  if (px + rr < cx0 || px - rr > cx1 || py + rr < cy0 || py - rr > cy1) return;

  const n = c & 0x0f;
  if (rr === 0) {
    if (px >= cx0 && px <= cx1 && py >= cy0 && py <= cy1) pset(ram, px, py, n);
    return;
  }

  const inside = px - rr >= cx0 && px + rr <= cx1 && py - rr >= cy0 && py + rr <= cy1;

  let xx = rr;
  let yy = 0;
  let err = 0;
  while (xx >= yy) {
    if (fill) {
      hspan(ram, py + yy, px - xx, px + xx, cx0, cy0, cx1, cy1, n);
      hspan(ram, py - yy, px - xx, px + xx, cx0, cy0, cx1, cy1, n);
      hspan(ram, py + xx, px - yy, px + yy, cx0, cy0, cx1, cy1, n);
      hspan(ram, py - xx, px - yy, px + yy, cx0, cy0, cx1, cy1, n);
    } else if (inside) {
      pset(ram, px + xx, py + yy, n);
      pset(ram, px - xx, py + yy, n);
      pset(ram, px + xx, py - yy, n);
      pset(ram, px - xx, py - yy, n);
      pset(ram, px + yy, py + xx, n);
      pset(ram, px - yy, py + xx, n);
      pset(ram, px + yy, py - xx, n);
      pset(ram, px - yy, py - xx, n);
    } else {
      psetClipped(ram, px + xx, py + yy, cx0, cy0, cx1, cy1, n);
      psetClipped(ram, px - xx, py + yy, cx0, cy0, cx1, cy1, n);
      psetClipped(ram, px + xx, py - yy, cx0, cy0, cx1, cy1, n);
      psetClipped(ram, px - xx, py - yy, cx0, cy0, cx1, cy1, n);
      psetClipped(ram, px + yy, py + xx, cx0, cy0, cx1, cy1, n);
      psetClipped(ram, px - yy, py + xx, cx0, cy0, cx1, cy1, n);
      psetClipped(ram, px + yy, py - xx, cx0, cy0, cx1, cy1, n);
      psetClipped(ram, px - yy, py - xx, cx0, cy0, cx1, cy1, n);
    }

    yy++;
    err += 1 + 2 * yy;
    if (2 * (err - xx) + 1 > 0) {
      xx--;
      err += 1 - 2 * xx;
    }
  }
}

/** `pset` with an explicit bounds test, for the partially-clipped circle walk. */
function psetClipped(
  ram: Uint8Array,
  x: number,
  y: number,
  cx0: number,
  cy0: number,
  cx1: number,
  cy1: number,
  c: number,
): void {
  if (x >= cx0 && x <= cx1 && y >= cy0 && y <= cy1) pset(ram, x, y, c);
}

// ---------------------------------------------------------------------------
// TEXT
// ---------------------------------------------------------------------------

/**
 * Draw `s` at world (x, y) in colour `c`, and return the x ADVANCE -- the number
 * of pixels the pen moved along the last line, so `x + print(...)` is where the
 * next character would go.
 *
 * `\n` returns the pen to the starting x and drops it FONT_H pixels. Every other
 * code point outside the font's range draws '?'.
 *
 * BACKGROUND. The glyphs are one bit deep, so an unset pixel is colour 0 and
 * follows the same transparency rule as a sprite: transparent by default, and
 * painted as colour 0 once a cart calls `palt(0, false)`. That is how a cart
 * gets legible text over a busy background without drawing a rectangle first,
 * and it costs nothing, because the choice is read from the mask once per call.
 *
 * Each character's 4 x 6 cell is rejected or intersected against CLIP once,
 * before its rows are touched -- so a 200-character string that runs off the
 * screen costs a comparison per character and nothing else.
 */
export function print(ram: Uint8Array, s: string, x: number, y: number, c: number): number {
  const cx0 = ram[ADDR.CLIP + 0] as number;
  const cy0 = ram[ADDR.CLIP + 1] as number;
  const cx1 = ram[ADDR.CLIP + 2] as number;
  const cy1 = ram[ADDR.CLIP + 3] as number;

  const startX = clampI16(x) - camX(ram);
  let penX = startX;
  let penY = clampI16(y) - camY(ram);
  const n = c & 0x0f;
  const paper = (paltMask(ram) & 1) === 0; // colour 0 opaque -> fill the cell
  const drawable = cx1 >= cx0 && cy1 >= cy0;

  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code === 10) {
      penX = startX;
      penY += FONT_H;
      continue;
    }
    if (drawable) glyph(ram, code, penX, penY, n, paper, cx0, cy0, cx1, cy1);
    penX += FONT_ADVANCE;
  }
  return penX - startX;
}

/** One character cell. Clipped once, then a bit walk. */
function glyph(
  ram: Uint8Array,
  code: number,
  gx: number,
  gy: number,
  n: number,
  paper: boolean,
  cx0: number,
  cy0: number,
  cx1: number,
  cy1: number,
): void {
  if (gx > cx1 || gx + FONT_W - 1 < cx0 || gy > cy1 || gy + FONT_H - 1 < cy0) return;
  const x0 = gx > cx0 ? gx : cx0;
  const y0 = gy > cy0 ? gy : cy0;
  const xe = gx + FONT_W - 1;
  const ye = gy + FONT_H - 1;
  const x1 = xe < cx1 ? xe : cx1;
  const y1 = ye < cy1 ? ye : cy1;

  for (let y = y0; y <= y1; y++) {
    const bits = glyphRowBits(code, y - gy);
    if (bits === 0 && !paper) continue;
    for (let x = x0; x <= x1; x++) {
      if (((bits >>> (x - gx)) & 1) === 1) pset(ram, x, y, n);
      else if (paper) pset(ram, x, y, 0);
    }
  }
}
