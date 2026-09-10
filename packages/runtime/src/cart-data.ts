/**
 * A cart's static data, and where it lands in RAM.
 *
 * The specification has always said this (section 3.3): "The 64 KB is RAM. A
 * cart's static data initializes 0x2000 through 0x77FF at boot; code is the cart
 * payload and is budgeted separately." Until M5 nothing implemented it --
 * `boot()` zeroed RAM, `load` compiled only the CODE chunk, and a cart's art had
 * no route into the machine at all.
 *
 * That absence was found by trying to ship an engine: the first module that
 * needed a tileset had to smuggle its sprite sheet through the generated source
 * as a hex string, because a string literal costs ONE token where an 8 KB array
 * of numbers would cost more than the entire 8192-token budget. Clever, and
 * exactly the wrong trade -- it spends the cart's code budget on bytes that are
 * already sitting in a chunk built to hold them, and it spends TWO cart bytes
 * per data byte doing it.
 *
 * WHY EACH CHUNK LANDS WHERE IT DOES
 * ----------------------------------
 * The map is a reading of the memory map rather than a design: every region a
 * cart would want to preload is contiguous, and the chunk names already match
 * them.
 *
 *     PAL    0x2000  224    PALETTE_HW, PALETTE_LIVE and DRAW_REMAP
 *     GFX    0x2200  8448   SPRITES and SPRITE_FLAGS
 *     MAP    0x4300  8192   MAP
 *     SFX    0x6300  3328   SFX
 *     MUS    0x7000  2048   MUSIC
 *     DATA   0x7800  34560  USER_RAM
 *
 * A chunk SHORTER than its region fills from the start and leaves the rest as
 * `boot` left it, so a cart with forty tiles does not have to pad to 8192. A
 * chunk LONGER than its region is a load error and never a truncation: silently
 * dropping the tail of someone's level data would produce a cart that runs and
 * is wrong, which is the worst of the three possible behaviours.
 *
 * Installation happens after RAM is zeroed AND after `boot` has written its
 * defaults, and BEFORE the cart's own `boot()` runs. Both halves of that are
 * load-bearing: install before the defaults and the identity live palette
 * overwrites the cart's own colours; install after `program.boot` and a cart
 * cannot read its own tiles on the frame it starts on.
 *
 * WHY `GFX ` CARRIES ITS FLAGS FIRST
 * ----------------------------------
 * SPRITES (8192 at 0x2200) and SPRITE_FLAGS (256 at 0x4200) are adjacent in
 * RAM, and a sheet without its flags is half a tileset, so one chunk carries
 * both. It does NOT carry them in address order.
 *
 * A chunk that were a flat image of 0x2200..0x42FF would have to be at least
 * 8193 bytes long to say anything at all about a flag, because the flags start
 * at offset 8192 -- so a cart using 96 of the 256 sheet cells would ship 3,072
 * bytes of pixels, then 5,120 bytes of zeroes to reach the flags, then 96 bytes
 * of flags. Measured on `cave-runner` that hole is 5,120 bytes of a 65,536-byte
 * budget: it cancels the entire saving this file exists to make.
 *
 * So the chunk is THE 256 FLAG BYTES, THEN THE SHEET. The fixed-size part goes
 * first, which is what lets the split be a constant instead of a header, and it
 * leaves the variable-length part at the end where trailing zeroes can be
 * trimmed off. A `GFX ` chunk of 300 bytes is 256 flags and 44 bytes of sheet;
 * one of 100 bytes is 100 flag bytes and no pixels at all.
 *
 * THE SEGMENT RULE, WHICH IS GENERAL
 * ----------------------------------
 * A region is a list of segments. EVERY SEGMENT BUT THE LAST IS FIXED-SIZE; the
 * last one takes whatever is left, up to its own cap. One segment is the plain
 * case -- the chunk is an image of the region -- and `GFX ` is the only region
 * with two today.
 */

import { ADDR, LEN } from "./memory";

/** One span of RAM a chunk fills, and the most of it that span may take. */
export interface DataSegment {
  readonly addr: number;
  /** Exactly this many bytes for every segment but the last, at most this many for the last. */
  readonly len: number;
}

/** Where a data chunk is installed, and the most it may carry. */
export interface DataRegion {
  readonly chunk: string;
  /** In the order the chunk carries them. All but the last are fixed-size. */
  readonly segments: readonly DataSegment[];
  /** The sum of the segment lengths: a chunk longer than this does not fit. */
  readonly max: number;
}

function region(chunk: string, segments: readonly DataSegment[]): DataRegion {
  let max = 0;
  for (const s of segments) max += s.len;
  return Object.freeze({ chunk, segments: Object.freeze(segments), max });
}

/**
 * The six installable chunks.
 *
 * `PAL ` covers the three colour tables in one span, because they are
 * contiguous (0x2000..0x20DF) and because a cart whose live slots index a
 * hardware palette it did not choose is a cart that looks different on a player
 * that ships a different reference table. The specification's static-data window
 * starts at exactly 0x2000, which is the same observation from the other side.
 *
 * NOTHING MAPS TO 0x20E0..0x21FF, and nothing may: CLIP, CAMERA, the input
 * bytes, FRAME, RNG_STATE and the audio registers live there, and `boot` writes
 * them immediately before this installation runs. A chunk reaching them would
 * overwrite the seed the machine was booted with, which would make a cart's
 * replay a function of its own data file.
 *
 * `DATA` lands in USER_RAM. NOTE THE TENSION: section 3.3 scopes a cart's static
 * data to 0x2000..0x77FF and the memory-map table annotates USER_RAM "zeroed at
 * boot", so on a strict reading USER_RAM is not a legal destination for a chunk
 * at all -- but `DATA` is the container's chunk for "arbitrary cart data" and
 * USER_RAM is the only region the machine has no opinion about, so the
 * alternative is a critical chunk type with nowhere to go. It is mapped here,
 * and the sentence to change is the specification's rather than this table's.
 */
export const DATA_REGIONS: readonly DataRegion[] = Object.freeze([
  region("PAL ", [
    { addr: ADDR.PALETTE_HW, len: LEN.PALETTE_HW + LEN.PALETTE_LIVE + LEN.DRAW_REMAP },
  ]),
  // The flags come FIRST inside the chunk. See the header: fixed-size part
  // first is what makes the split a constant rather than a header.
  region("GFX ", [
    { addr: ADDR.SPRITE_FLAGS, len: LEN.SPRITE_FLAGS },
    { addr: ADDR.SPRITES, len: LEN.SPRITES },
  ]),
  region("MAP ", [{ addr: ADDR.MAP, len: LEN.MAP }]),
  region("SFX ", [{ addr: ADDR.SFX, len: LEN.SFX }]),
  region("MUS ", [{ addr: ADDR.MUSIC, len: LEN.MUSIC }]),
  region("DATA", [{ addr: ADDR.USER_RAM, len: LEN.USER_RAM }]),
]);

/** Where the sheet half of a `GFX ` chunk begins. The flags are before it. */
export const GFX_SHEET_OFFSET = LEN.SPRITE_FLAGS;

/** One span of a chunk's payload, already matched to the address it installs at. */
export interface CartDatum {
  readonly addr: number;
  /** A VIEW of the chunk, cut at plan time so installing allocates nothing. */
  readonly bytes: Uint8Array;
}

/** Everything a cart preloads. Empty is normal: most carts draw everything. */
export type CartData = readonly CartDatum[];

/** A cart that preloads nothing, shared so a caller need not allocate one. */
export const NO_CART_DATA: CartData = Object.freeze([]);

export interface OversizeChunk {
  readonly chunk: string;
  readonly bytes: number;
  readonly max: number;
}

/**
 * Match chunks to regions, and cut each one into the spans it installs as.
 *
 * Returns the data to install and any chunk too large for its region. The caller
 * decides what an oversize chunk means -- `load` turns it into a `LoadError`,
 * and a build tool may want to say it differently -- so this function does not
 * throw and does not truncate.
 *
 * EVERY `subarray` HAPPENS HERE, which is the point of the function existing
 * separately from `installCartData`: planning runs once, when a cart is loaded,
 * and installing runs on every boot -- including the boot inside a rewind. See
 * `installCartData`.
 */
export function planCartData(
  chunks: readonly { readonly type: string; readonly data: Uint8Array }[],
): { data: CartData; oversize: OversizeChunk[] } {
  const data: CartDatum[] = [];
  const oversize: OversizeChunk[] = [];

  // Iterate the regions rather than the chunks, so installation order is fixed
  // by this file and not by the order chunks happen to appear in a file.
  for (const r of DATA_REGIONS) {
    const chunk = chunks.find((c) => c.type === r.chunk);
    if (chunk === undefined || chunk.data.length === 0) continue;
    if (chunk.data.length > r.max) {
      oversize.push({ chunk: r.chunk, bytes: chunk.data.length, max: r.max });
      continue;
    }

    let off = 0;
    for (let i = 0; i < r.segments.length; i++) {
      const seg = r.segments[i] as DataSegment;
      const left = chunk.data.length - off;
      if (left <= 0) break;
      // Every segment but the last is fixed-size, so a chunk that stops inside
      // one simply fills part of it and there is nothing after. The chunk has
      // already been checked against `r.max`, so the last segment's `min` can
      // only bite on a region whose segments were mis-summed.
      const take = Math.min(left, seg.len);
      data.push({ addr: seg.addr, bytes: chunk.data.subarray(off, off + take) });
      off += take;
    }
  }

  return { data, oversize };
}

/**
 * Write a cart's data into RAM.
 *
 * Called by `boot()` after the machine's own defaults and before the cart's own
 * `boot`. ALLOCATES NOTHING: every datum is already a view onto the cart's
 * bytes, so this is a loop of `set` into the existing buffer. `boot` runs on
 * every restart and on the far side of a rewind, so an allocation here would be
 * an allocation on a path a player takes at speed.
 */
export function installCartData(ram: Uint8Array, data: CartData): void {
  for (let i = 0; i < data.length; i++) {
    const d = data[i] as CartDatum;
    ram.set(d.bytes, d.addr);
  }
}
