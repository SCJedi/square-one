/**
 * The Square One memory map -- normative.
 *
 * The entire machine is one 64 KB buffer. Nothing about a running game lives
 * outside it: not the framebuffer, not the palette, not the input, and above
 * all not the PRNG state. That is what makes `snapshot()` a memcpy and makes a
 * rewind bit-exact rather than approximately right.
 *
 * Every address and length below is part of the contract. A second
 * implementation that puts CLIP one byte later is a different console, because
 * a cart may `peek` and `poke` anything here.
 *
 * Addresses are named. If you find yourself writing 0x20E0 in another file,
 * import ADDR.CLIP instead -- the constant is the documentation.
 */

/** The whole machine. 64 KB, no more, no less. */
export const RAM_SIZE = 65536;

/** Screen is square and small on purpose: 128x128 at 4 bits per pixel. */
export const SCREEN_W = 128;
export const SCREEN_H = 128;

/**
 * Bytes per framebuffer row. 128 pixels at two pixels per byte.
 * A power of two, so `y * FB_STRIDE` is a shift and the address of a pixel is
 * `(y << 6) + (x >> 1)`.
 */
export const FB_STRIDE = 64;

/** Bits per pixel in the framebuffer and in sprite data. */
export const BPP = 4;

/** Colours addressable at once. The low nibble of every framebuffer byte. */
export const LIVE_COLORS = 16;

/** Entries in the hardware palette a live slot may point at. */
export const HW_COLORS = 64;

/** Player slots. Four, fixed -- the input regions are sized from this. */
export const MAX_PLAYERS = 4;

/** Sprites in the sprite sheet, each 8x8 at 4bpp = 32 bytes. */
export const SPRITE_COUNT = 256;
export const SPRITE_W = 8;
export const SPRITE_H = 8;
export const SPRITE_BYTES = (SPRITE_W * SPRITE_H * BPP) / 8;

/** The tile map: 128 wide, 64 tall, one byte per tile. */
export const MAP_W = 128;
export const MAP_H = 64;

/**
 * Region start addresses. Ascending, non-overlapping, and covering [0, 65536)
 * apart from three small reserved gaps that exist only to keep the regions
 * after them on a readable boundary (0x20F0, 0x20FC, 0x2200).
 */
export const ADDR = {
  /** 128x128 @ 4bpp, row-major. EVEN x is the LOW nibble of its byte. */
  FRAMEBUFFER: 0x0000,
  /** 64 entries x RGB888, the colours the console can physically produce. */
  PALETTE_HW: 0x2000,
  /** 16 x u8: for each live slot, which hardware entry it shows. */
  PALETTE_LIVE: 0x20c0,
  /** 16 x u8: colour written by a cart -> colour actually stored. Identity at boot. */
  DRAW_REMAP: 0x20d0,
  /** x0, y0, x1, y1 as u8, INCLUSIVE bounds. x1 < x0 means "clip everything". */
  CLIP: 0x20e0,
  /** i16 x, i16 y, little endian. */
  CAMERA: 0x20e4,
  /** One byte of buttons per player slot, this tick. */
  INPUT_NOW: 0x20f0,
  /** The same four bytes as they were on the previous tick. btnp reads both. */
  INPUT_PREV: 0x20f4,
  /** Bitmask of which player slots have a controller attached. */
  PLAYERS_PRESENT: 0x20f8,
  /** u32 LE. The index of the tick that just ran. Read-only to the cart. */
  FRAME: 0x20fc,
  /** xoshiro128** state: four u32 LE. In RAM so it travels inside a snapshot. */
  RNG_STATE: 0x2100,
  /** Per-channel audio state. */
  AUDIO_CH: 0x2110,
  /** Master audio state. */
  AUDIO_MASTER: 0x2150,
  /** 256 sprites, 8x8 @ 4bpp. */
  SPRITES: 0x2200,
  /** One flags byte per sprite. */
  SPRITE_FLAGS: 0x4200,
  /** 128x64 tiles, one byte each. */
  MAP: 0x4300,
  /** Sound effect definitions. */
  SFX: 0x6300,
  /** Music patterns. */
  MUSIC: 0x7000,
  /** Everything the cart wants for itself. */
  USER_RAM: 0x7800,
  /** Persisted across runs by the host. The only region that outlives a boot. */
  SAVE: 0xff00,
} as const;

/** Region lengths in bytes, keyed identically to ADDR. */
export const LEN = {
  FRAMEBUFFER: 8192,
  PALETTE_HW: 192,
  PALETTE_LIVE: 16,
  DRAW_REMAP: 16,
  CLIP: 4,
  CAMERA: 4,
  INPUT_NOW: 4,
  INPUT_PREV: 4,
  PLAYERS_PRESENT: 1,
  FRAME: 4,
  RNG_STATE: 16,
  AUDIO_CH: 64,
  AUDIO_MASTER: 16,
  SPRITES: 8192,
  SPRITE_FLAGS: 256,
  MAP: 8192,
  SFX: 3328,
  MUSIC: 2048,
  USER_RAM: 34560,
  SAVE: 256,
} as const;

/** The name of every region, in address order. */
export type RegionName = keyof typeof ADDR;

/**
 * Regions in address order. Exported so tests can walk the map rather than
 * re-typing it, and so a tool can print it.
 */
export const REGION_ORDER: readonly RegionName[] = [
  "FRAMEBUFFER",
  "PALETTE_HW",
  "PALETTE_LIVE",
  "DRAW_REMAP",
  "CLIP",
  "CAMERA",
  "INPUT_NOW",
  "INPUT_PREV",
  "PLAYERS_PRESENT",
  "FRAME",
  "RNG_STATE",
  "AUDIO_CH",
  "AUDIO_MASTER",
  "SPRITES",
  "SPRITE_FLAGS",
  "MAP",
  "SFX",
  "MUSIC",
  "USER_RAM",
  "SAVE",
] as const;

/**
 * Button bit positions inside an input byte. A d-pad and four faces fit in one
 * byte per player, which is why the input regions are four bytes and not
 * sixteen.
 */
export const BTN = {
  UP: 0,
  DOWN: 1,
  LEFT: 2,
  RIGHT: 3,
  A: 4,
  B: 5,
  X: 6,
  Y: 7,
} as const;

/** The address of the framebuffer byte holding pixel (x, y). */
export function fbIndex(x: number, y: number): number {
  return ADDR.FRAMEBUFFER + (y << 6) + (x >> 1);
}
