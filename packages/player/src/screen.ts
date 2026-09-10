/**
 * The 128 x 128 window: pixels from the runtime onto glass, and nothing else.
 *
 * This file is the entire visible surface a cart has. It draws a fixed-size
 * image into a fixed-size box and cannot be persuaded to draw anywhere else --
 * every coordinate here is a constant or comes from `ShellLayout`, and no value
 * that originated inside a cart reaches any of them. That is the shell's
 * security boundary expressed as code rather than as a rule someone remembers.
 *
 * =========================================================================
 * TWO CANVASES
 * =========================================================================
 * A 128 x 128 BACKING canvas receives the frame through `putImageData`, and the
 * FRONT canvas -- the one in the document -- scales it up with `drawImage` and
 * `imageSmoothingEnabled = false`.
 *
 * `putImageData` is used because it is the only call that writes raw RGBA
 * without going through the compositor's colour management, and it IGNORES the
 * canvas transform, so it cannot be made to draw scaled. That is exactly why it
 * cannot be used to present directly: it would put a 128px image in the corner
 * of a 512px canvas. Hence the pair.
 *
 * ALLOCATE THE IMAGEDATA ONCE. A frame is 64 KiB. Allocating one per frame is
 * 3.8 MB/s of garbage, which on a phone is a visible collection pause every few
 * seconds -- in a loop whose whole job is to not stutter. So the ImageData, its
 * `Uint32Array` view and both canvases are made in `createScreen` and never
 * again; `present` is `view.set(rgba)` plus two draw calls and allocates
 * nothing.
 *
 * WORD ORDER IS ALREADY RIGHT. `packRGBA` in the runtime's palette.ts packs for
 * a `Uint32Array` view over a canvas buffer, detecting endianness rather than
 * assuming it. So `view.set(rgba)` is a straight copy and this file performs no
 * channel arithmetic at all -- the one place a red-and-blue swap could be
 * introduced is the place that already proved it is not there.
 *
 * DEVICE PIXELS STAY INTEGERS. On a 2x display the front canvas is allocated at
 * `128 * scale * dpr` device pixels and shown at `128 * scale` CSS pixels. The
 * device-pixel ratio is floored to a whole number first: 2.625 (a common
 * Android value) would reintroduce the uneven-pixel problem the integer scale
 * exists to prevent, one layer further down where it is much harder to see.
 */

import { SCREEN_SIZE } from "./layout";
import type { ShellLayout } from "./layout";

/** Pixels in one frame. */
const PIXELS = SCREEN_SIZE * SCREEN_SIZE;

export interface Screen {
  /**
   * Put one frame on the glass. `rgba` is the runtime's `latestRgba`: 16384
   * packed words in canvas byte order. Allocates nothing.
   */
  present(rgba: Uint32Array): void;
  /** Move and resize the front canvas to match a layout. */
  resize(l: ShellLayout): void;
  readonly canvas: HTMLCanvasElement;
}

export interface ScreenOptions {
  /**
   * The document to build canvases in. Defaults to the global `document`.
   *
   * Injectable so the presentation logic can be exercised in Node against a
   * minimal fake, which is the difference between "the scaling maths is tested"
   * and "the scaling maths compiled".
   */
  document?: Document;
  /**
   * Device pixels per CSS pixel. Defaults to `devicePixelRatio` floored to a
   * whole number, minimum 1. See the header on why it is floored.
   */
  pixelRatio?: number;
}

/** `getContext("2d")` with the flags a pixel console wants, or a clear failure. */
function context2d(canvas: HTMLCanvasElement, alpha: boolean): CanvasRenderingContext2D {
  const ctx = canvas.getContext("2d", { alpha }) as CanvasRenderingContext2D | null;
  if (ctx === null) {
    throw new Error(
      "Square One: this browser refused a 2D canvas context. There is no fallback -- " +
        "the console has nowhere to draw.",
    );
  }
  return ctx;
}

export function createScreen(opts?: ScreenOptions): Screen {
  const doc = opts?.document ?? (globalThis as { document?: Document }).document;
  if (doc === undefined) {
    throw new Error(
      "createScreen: no document. Pass one via `createScreen({ document })` when running " +
        "outside a browser.",
    );
  }

  const rawRatio = opts?.pixelRatio ?? (globalThis as { devicePixelRatio?: number }).devicePixelRatio ?? 1;
  const dpr = Math.max(1, Math.floor(Number.isFinite(rawRatio) ? rawRatio : 1));

  // The backing store: exactly one cart frame, forever.
  const back = doc.createElement("canvas");
  back.width = SCREEN_SIZE;
  back.height = SCREEN_SIZE;
  const backCtx = context2d(back, false);

  // Allocated once. See the header.
  const image = backCtx.createImageData(SCREEN_SIZE, SCREEN_SIZE);
  const view = new Uint32Array(image.data.buffer);

  const canvas = doc.createElement("canvas");
  canvas.width = SCREEN_SIZE * dpr;
  canvas.height = SCREEN_SIZE * dpr;
  canvas.setAttribute("aria-label", "Square One screen");
  canvas.setAttribute("role", "img");
  // `position: absolute` because the layout is authoritative: the shell places
  // every part by rect, and a canvas participating in normal flow would let the
  // browser's box model disagree with `computeLayout` about where the screen is
  // -- which is exactly the disagreement that puts the d-pad's hit test a few
  // pixels away from the d-pad's drawing.
  canvas.style.position = "absolute";
  canvas.style.imageRendering = "pixelated";
  canvas.style.display = "block";
  canvas.style.background = "#000";
  const frontCtx = context2d(canvas, false);
  frontCtx.imageSmoothingEnabled = false;

  let outW = SCREEN_SIZE;
  let outH = SCREEN_SIZE;

  return {
    canvas,

    present(rgba: Uint32Array): void {
      if (rgba.length !== PIXELS) {
        throw new Error(
          `Screen.present: expected ${PIXELS} pixels, got ${rgba.length}` +
            (rgba.length === 0 ? " (a detached buffer: the frame was transferred away)" : ""),
        );
      }
      view.set(rgba);
      backCtx.putImageData(image, 0, 0);
      // Re-asserted every frame: some engines reset the flag when the canvas is
      // resized, and a single smoothed frame is a visible smear.
      frontCtx.imageSmoothingEnabled = false;
      frontCtx.drawImage(back, 0, 0, SCREEN_SIZE, SCREEN_SIZE, 0, 0, outW, outH);
    },

    resize(l: ShellLayout): void {
      const cssW = l.screen.w;
      const cssH = l.screen.h;
      outW = cssW * dpr;
      outH = cssH * dpr;
      // Assigning width/height clears the canvas and resets its context state,
      // so it is done only when the size actually changed -- otherwise every
      // resize event would flash the screen black.
      if (canvas.width !== outW || canvas.height !== outH) {
        canvas.width = outW;
        canvas.height = outH;
        frontCtx.imageSmoothingEnabled = false;
      }
      canvas.style.left = `${l.screen.x}px`;
      canvas.style.top = `${l.screen.y}px`;
      canvas.style.width = `${cssW}px`;
      canvas.style.height = `${cssH}px`;
    },
  };
}
