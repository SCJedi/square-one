/**
 * The reference renderer: a display list onto glass, in Canvas2D.
 *
 * =========================================================================
 * THIS IS THE REFERENCE, AND THAT IS WHY IT IS NOT WEBGL
 * =========================================================================
 * A GPU backend will be faster and will look better. It will also be a thousand
 * lines of pipeline state, shader compilation and driver quirks, and the only
 * way to know whether it draws the RIGHT scene is to have something simpler to
 * check it against. That is this file, and simplicity is therefore its
 * specification rather than a compromise: every command is a handful of Canvas2D
 * calls a person can read and agree with, there is no batching, no atlas, no
 * cache that can go stale, and no state that survives a frame.
 *
 * The spec's build order (section 12, phase 3) says it outright: reference
 * first, "because it is the thing a GPU backend is later checked against for
 * scene correctness".
 *
 * Pixels are NON-NORMATIVE (spec 0). Nothing here affects conformance; two
 * runtimes drawing the same list are expected to differ. What must not differ is
 * the list, which is `draw.ts`'s problem and is exact.
 *
 * =========================================================================
 * RESOLUTION INDEPENDENCE -- AND WHY THIS ONE IS NOT INTEGER-SCALED
 * =========================================================================
 * The small console integer-scales because a 128-pixel image at 2.7x gives some
 * source pixels three destination pixels and others two, and the eye reads that
 * as a texture crawling over the picture. Prime has no source pixels: a cart
 * draws floats in a 1920 x 1080 LOGICAL space (spec 3.1), and the whole point of
 * a logical space is that it is resolved at the display's real resolution. So
 * the scale here is fractional, deliberately, and `1440p` gets 1440 lines of
 * actual geometry rather than 1080 lines stretched.
 *
 * 16:9 is preserved by LETTERBOXING, and the bars are painted black and clipped
 * to, so a cart can never draw outside its own frame no matter what coordinates
 * it submits.
 *
 * =========================================================================
 * LAYERS ARE PASSES; ADDITIVE IS THE GLOW
 * =========================================================================
 * Layers 0..7 are drawn low to high, each a full pass over the list. `blend(1)`
 * maps to `globalCompositeOperation = "lighter"`, which is most of the visual
 * budget in a game made of rectangles and circles: a shape drawn solid, then
 * again larger and additive at low alpha, reads as LIT rather than coloured.
 * The mode is tracked per span and put back to `source-over` at the end of every
 * pass, so a layer can never leak its blend state into the next one.
 *
 * =========================================================================
 * BLOOM AND SHAKE ARE NON-NORMATIVE AND MAY BE SWITCHED OFF
 * =========================================================================
 * The ABI is explicit that a runtime MAY ignore both and that a cart must stay
 * playable without them. `setPost` is that switch, and `render.test.ts` asserts
 * that turning it off changes NOTHING about the geometry -- same commands, same
 * coordinates, same order -- because if a post stage could move a shape it would
 * be carrying information, and information belongs in the geometry.
 *
 * The player turns shake off under `prefers-reduced-motion`, which is exactly
 * the kind of thing a non-normative post stage exists to allow.
 *
 * Bloom is a downscaled additive pass: the layer is re-drawn into a small opaque
 * scratch canvas, multiplied by itself (which squares every channel and so
 * crushes darks far faster than brights -- a soft threshold with no per-pixel
 * loop), attenuated by `1 - threshold`, and composited back with `lighter`. It
 * is an approximation of a real bloom and is labelled one.
 *
 * =========================================================================
 * TEXT IS THE PLATFORM'S, AND THAT IS FINE BECAUSE PIXELS ARE
 * =========================================================================
 * `fillText` in a system UI stack. The glyphs differ between machines, which
 * would be fatal if pixels were normative and is harmless because they are not.
 * What a cart DOES depend on is `draw.measure` -- it centres scores with it --
 * so every string is scaled horizontally to the width `measureText` promised.
 * Layout decisions the cart made are reproduced exactly; the glyphs that fill
 * them are whatever the machine has.
 */

import {
  BLEND,
  FIELD,
  LAYERS,
  LOGICAL_H,
  LOGICAL_W,
  OP,
  cssColor,
  measureText,
} from "./draw";
import type { DisplayList } from "./draw";

/** The face. Purely presentational; see the file header. */
const FONT_STACK =
  '"Inter", "Segoe UI", system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif';

/** How far down the bloom pass renders. 4 is a visible glow at a sixteenth of the cost. */
const BLOOM_DIV = 4;

const TAU = Math.PI * 2;

/** Where the 16:9 logical frame landed, in DEVICE pixels. */
export interface Viewport {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  /** Device pixels per logical unit. */
  readonly scale: number;
}

/** Which non-normative post stages are running. */
export interface PostState {
  readonly bloom: boolean;
  readonly shake: boolean;
}

export interface Renderer {
  /** Size the surface. `cssW`/`cssH` are the element's box; `dpr` is device pixels per CSS pixel. */
  resize(cssW: number, cssH: number, dpr: number): void;
  /** Draw one frame. */
  draw(list: DisplayList): void;
  /** Turn the non-normative post stages on or off. Geometry is unaffected. */
  setPost(p: { bloom?: boolean; shake?: boolean }): void;
  readonly post: PostState;
  readonly viewport: Viewport;
  readonly canvas: HTMLCanvasElement;
}

export interface RendererOptions {
  /** Draw into this canvas instead of a fresh one. */
  canvas?: HTMLCanvasElement;
  /** The document to build canvases in. Defaults to the global `document`. */
  document?: Document;
  /** Start with a post stage disabled. Both default to on. */
  post?: { bloom?: boolean; shake?: boolean };
}

/**
 * The 2D context surface this renderer actually uses.
 *
 * Written out rather than taken as `CanvasRenderingContext2D` so a test can hand
 * in a recorder and assert the exact call sequence. A renderer whose only proof
 * is a screenshot is a renderer whose regressions are found by eye, one at a
 * time, months later.
 */
export interface Ctx2D {
  fillStyle: string;
  strokeStyle: string;
  lineWidth: number;
  lineJoin: string;
  lineCap: string;
  globalAlpha: number;
  globalCompositeOperation: string;
  font: string;
  textBaseline: string;
  imageSmoothingEnabled: boolean;
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void;
  save(): void;
  restore(): void;
  translate(x: number, y: number): void;
  scale(x: number, y: number): void;
  beginPath(): void;
  closePath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  arc(x: number, y: number, r: number, a0: number, a1: number): void;
  arcTo(x1: number, y1: number, x2: number, y2: number, r: number): void;
  rect(x: number, y: number, w: number, h: number): void;
  clip(): void;
  fill(): void;
  stroke(): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  fillText(s: string, x: number, y: number): void;
  measureText(s: string): { width: number };
  drawImage(image: unknown, ...args: number[]): void;
}

function context2d(canvas: HTMLCanvasElement, alpha: boolean): Ctx2D {
  const ctx = (canvas as unknown as {
    getContext(id: string, o?: { alpha: boolean }): unknown;
  }).getContext("2d", { alpha });
  if (ctx === null || ctx === undefined) {
    throw new Error(
      "Square One Prime: this environment refused a 2D canvas context. There is no " +
        "fallback -- the reference renderer has nowhere to draw.",
    );
  }
  return ctx as Ctx2D;
}

export function createRenderer(opts?: RendererOptions): Renderer {
  const doc =
    opts?.document ??
    opts?.canvas?.ownerDocument ??
    (globalThis as { document?: Document }).document;
  if (doc === undefined) {
    throw new Error(
      "createRenderer: no document. Pass one via `createRenderer({ document })` when " +
        "running outside a browser.",
    );
  }

  // Re-bound with a non-nullable type rather than relying on the narrowing
  // above: the functions below are hoisted declarations, and TypeScript will not
  // carry a control-flow narrowing into one.
  const ownerDoc: Document = doc;

  const canvas = opts?.canvas ?? ownerDoc.createElement("canvas");
  // `alpha: false` because the renderer paints every device pixel itself,
  // letterbox bars included, and an opaque canvas skips a whole compositing
  // step on every frame for a surface that is never transparent.
  const ctx = context2d(canvas, false);

  /** The bloom scratch. Built on first use, so a scene with no bloom never allocates it. */
  let scratch: HTMLCanvasElement | null = null;
  let sctx: Ctx2D | null = null;

  let postBloom = opts?.post?.bloom ?? true;
  let postShake = opts?.post?.shake ?? true;

  let deviceW = 1;
  let deviceH = 1;
  let vp: Viewport = { x: 0, y: 0, w: 1, h: 1, scale: 1 / LOGICAL_W };

  /**
   * Frames drawn, which is the only thing the shake curve is a function of.
   *
   * The simulation never sees it. Shake is presentation, so a counter here is a
   * counter that cannot reach the arena -- which is the difference between a
   * post stage and a determinism hole.
   */
  let frame = 0;

  /**
   * Packed colour -> CSS string, because `fillStyle` takes a string and a
   * thousand particles a frame in the same colour should build one.
   *
   * Bounded: a scene that genuinely uses more than `COLOR_CACHE_MAX` distinct
   * colours clears and starts again rather than growing without limit, since the
   * cache exists to serve repetition and a list with no repetition gains nothing
   * from remembering it.
   */
  const colorCache = new Map<number, string>();
  const COLOR_CACHE_MAX = 4096;

  function color(c: number): string {
    const hit = colorCache.get(c);
    if (hit !== undefined) return hit;
    if (colorCache.size >= COLOR_CACHE_MAX) colorCache.clear();
    const s = cssColor(c);
    colorCache.set(c, s);
    return s;
  }

  function relayout(): void {
    // The largest 16:9 box that fits, centred. Fractional on purpose: see the
    // header on why this console is not integer-scaled.
    const scale = Math.min(deviceW / LOGICAL_W, deviceH / LOGICAL_H);
    const w = LOGICAL_W * scale;
    const h = LOGICAL_H * scale;
    vp = { x: (deviceW - w) / 2, y: (deviceH - h) / 2, w, h, scale };
  }

  /**
   * A bounded pseudo-random wobble. Deterministic in `n`, so the same frame
   * number shakes the same way and a screenshot is reproducible.
   */
  function wobble(n: number): number {
    const s = Math.sin(n * 127.1) * 43758.5453;
    return (s - Math.floor(s)) * 2 - 1;
  }

  /**
   * Replay every command on one layer.
   *
   * `ba..bf` is the base matrix -- logical space to whatever surface is being
   * drawn into -- and each command's own matrix is composed onto it. The command
   * matrix was baked at record time (see `draw.ts`), which is why this function
   * can walk the list in any order it likes and why there is no matrix stack
   * anywhere in this file.
   */
  function drawLayer(
    g: Ctx2D,
    list: DisplayList,
    layer: number,
    ba: number,
    bb: number,
    bc: number,
    bd: number,
    be: number,
    bf: number,
  ): void {
    const d = list.data;
    const stride = list.stride;
    const n = list.count;
    let blend = BLEND.NORMAL as number;
    g.globalCompositeOperation = "source-over";
    g.globalAlpha = 1;

    for (let i = 0; i < n; i++) {
      const o = i * stride;
      if (d[o + FIELD.LAYER] !== layer) continue;

      const want = d[o + FIELD.BLEND] as number;
      if (want !== blend) {
        blend = want;
        g.globalCompositeOperation = want === BLEND.ADDITIVE ? "lighter" : "source-over";
      }

      // base * command, in Canvas2D's own a,b,c,d,e,f order.
      const ma = d[o + FIELD.A] as number;
      const mb = d[o + FIELD.B] as number;
      const mc = d[o + FIELD.C] as number;
      const md = d[o + FIELD.D] as number;
      const me = d[o + FIELD.E] as number;
      const mf = d[o + FIELD.F] as number;
      const a = ba * ma + bc * mb;
      const b = bb * ma + bd * mb;
      const c = ba * mc + bc * md;
      const dd = bb * mc + bd * md;
      const e = ba * me + bc * mf + be;
      const f = bb * me + bd * mf + bf;

      const fill = color(d[o + FIELD.COLOR] as number);
      const op = d[o + FIELD.OP] as number;

      switch (op) {
        case OP.CLEAR: {
          // Screen space: `clear` means the frame, so the command's own matrix
          // is deliberately ignored. A cart that translated before clearing
          // still clears the whole logical viewport, which is the only reading
          // of "clear" that is ever what was meant.
          g.setTransform(ba, bb, bc, bd, be, bf);
          g.fillStyle = fill;
          g.fillRect(0, 0, LOGICAL_W, LOGICAL_H);
          break;
        }

        case OP.RECT: {
          g.setTransform(a, b, c, dd, e, f);
          g.fillStyle = fill;
          g.fillRect(
            d[o + FIELD.P0] as number,
            d[o + FIELD.P1] as number,
            d[o + FIELD.P2] as number,
            d[o + FIELD.P3] as number,
          );
          break;
        }

        case OP.ROUND_RECT: {
          g.setTransform(a, b, c, dd, e, f);
          g.fillStyle = fill;
          const x = d[o + FIELD.P0] as number;
          const y = d[o + FIELD.P1] as number;
          const w = d[o + FIELD.P2] as number;
          const h = d[o + FIELD.P3] as number;
          // Clamped to half the shorter side: a radius larger than that has no
          // meaning, and `arcTo` draws something arbitrary rather than refusing.
          const r = Math.min(d[o + FIELD.P4] as number, Math.abs(w) / 2, Math.abs(h) / 2);
          g.beginPath();
          g.moveTo(x + r, y);
          g.arcTo(x + w, y, x + w, y + h, r);
          g.arcTo(x + w, y + h, x, y + h, r);
          g.arcTo(x, y + h, x, y, r);
          g.arcTo(x, y, x + w, y, r);
          g.closePath();
          g.fill();
          break;
        }

        case OP.CIRCLE: {
          g.setTransform(a, b, c, dd, e, f);
          g.fillStyle = fill;
          g.beginPath();
          g.arc(
            d[o + FIELD.P0] as number,
            d[o + FIELD.P1] as number,
            Math.abs(d[o + FIELD.P2] as number),
            0,
            TAU,
          );
          g.fill();
          break;
        }

        case OP.LINE: {
          g.setTransform(a, b, c, dd, e, f);
          g.strokeStyle = fill;
          g.lineWidth = d[o + FIELD.P4] as number;
          g.lineCap = "round";
          g.lineJoin = "round";
          g.beginPath();
          g.moveTo(d[o + FIELD.P0] as number, d[o + FIELD.P1] as number);
          g.lineTo(d[o + FIELD.P2] as number, d[o + FIELD.P3] as number);
          g.stroke();
          break;
        }

        case OP.TRI: {
          g.setTransform(a, b, c, dd, e, f);
          g.fillStyle = fill;
          g.beginPath();
          g.moveTo(d[o + FIELD.P0] as number, d[o + FIELD.P1] as number);
          g.lineTo(d[o + FIELD.P2] as number, d[o + FIELD.P3] as number);
          g.lineTo(d[o + FIELD.P4] as number, d[o + FIELD.P5] as number);
          g.closePath();
          g.fill();
          break;
        }

        case OP.TEXT: {
          const s = list.strings[d[o + FIELD.P3] as number] ?? "";
          const size = d[o + FIELD.P2] as number;
          g.setTransform(a, b, c, dd, e, f);
          g.fillStyle = fill;
          g.font = `${size}px ${FONT_STACK}`;
          g.textBaseline = "alphabetic";
          // Make the platform's glyphs occupy the width `draw.measure` promised.
          // See the header: the cart's layout is reproduced, the glyphs are not.
          const want = measureText(s, size);
          const got = g.measureText(s).width;
          const sx = got > 0 ? want / got : 1;
          g.translate(d[o + FIELD.P0] as number, d[o + FIELD.P1] as number);
          g.scale(sx, 1);
          g.fillText(s, 0, 0);
          break;
        }

        default:
          break;
      }
    }

    // Never leave a pass in additive: the next layer starts from normal, and a
    // renderer that leaked this would make a layer's appearance depend on the
    // last command of the layer below it.
    g.globalCompositeOperation = "source-over";
    g.globalAlpha = 1;
  }

  /** Ensure the scratch canvas exists and is `w` x `h`. */
  function ensureScratch(w: number, h: number): Ctx2D {
    if (scratch === null) {
      scratch = ownerDoc.createElement("canvas");
      sctx = context2d(scratch, false);
    }
    if (scratch.width !== w || scratch.height !== h) {
      scratch.width = w;
      scratch.height = h;
    }
    return sctx as Ctx2D;
  }

  /**
   * One layer's bloom: re-draw it small, square it, add it back.
   *
   * Re-drawing rather than copying the framebuffer is what makes bloom PER
   * LAYER, as the ABI declares it -- a copy would glow everything underneath as
   * well, and a cart could not then put a lit layer over an unlit one.
   */
  function bloomPass(
    list: DisplayList,
    layer: number,
    strength: number,
    threshold: number,
    shakeX: number,
    shakeY: number,
  ): void {
    const bw = Math.max(1, Math.round(vp.w / BLOOM_DIV));
    const bh = Math.max(1, Math.round(vp.h / BLOOM_DIV));
    const g = ensureScratch(bw, bh);

    const s = vp.scale / BLOOM_DIV;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalCompositeOperation = "source-over";
    g.globalAlpha = 1;
    g.fillStyle = "#000";
    g.fillRect(0, 0, bw, bh);
    drawLayer(g, list, layer, s, 0, 0, s, shakeX / BLOOM_DIV, shakeY / BLOOM_DIV);

    // The soft knee. Multiplying the scratch by itself squares every channel, so
    // a value of 0.2 becomes 0.04 and a value of 0.9 becomes 0.81 -- darks fall
    // away much faster than brights, which is what a threshold is for, with no
    // per-pixel pass. `1 - threshold` then sets how much of what survived is
    // kept. An approximation, and named as one.
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalCompositeOperation = "multiply";
    g.drawImage(scratch as HTMLCanvasElement, 0, 0);
    if (threshold > 0) {
      const k = Math.round((1 - threshold) * 255);
      g.fillStyle = `rgb(${k},${k},${k})`;
      g.fillRect(0, 0, bw, bh);
    }
    g.globalCompositeOperation = "source-over";

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = "lighter";
    ctx.globalAlpha = strength;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(scratch as HTMLCanvasElement, 0, 0, bw, bh, vp.x, vp.y, vp.w, vp.h);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
  }

  const api: Renderer = {
    canvas,

    get post(): PostState {
      return { bloom: postBloom, shake: postShake };
    },

    get viewport(): Viewport {
      return vp;
    },

    setPost(p: { bloom?: boolean; shake?: boolean }): void {
      postBloom = p.bloom ?? postBloom;
      postShake = p.shake ?? postShake;
    },

    resize(cssW: number, cssH: number, dpr: number): void {
      const ratio = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
      // Not floored to a whole number, unlike the small console's screen.ts:
      // there are no source pixels to align, so a fractional ratio costs nothing
      // and rounding it away would throw real resolution off a 2.625x phone.
      const w = Math.max(1, Math.round((Number.isFinite(cssW) ? cssW : 0) * ratio));
      const h = Math.max(1, Math.round((Number.isFinite(cssH) ? cssH : 0) * ratio));
      if (canvas.width !== w || canvas.height !== h) {
        // Assigning either dimension clears the canvas and resets context state,
        // so it is done only when the size genuinely changed.
        canvas.width = w;
        canvas.height = h;
      }
      const style = (canvas as unknown as { style?: Record<string, string> }).style;
      if (style !== undefined) {
        style["width"] = `${Math.max(0, cssW)}px`;
        style["height"] = `${Math.max(0, cssH)}px`;
      }
      deviceW = w;
      deviceH = h;
      relayout();
    },

    draw(list: DisplayList): void {
      frame++;

      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
      // The letterbox bars, repainted every frame. Black rather than left alone
      // because a resize can leave the previous frame's geometry in the margin.
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, deviceW, deviceH);

      // Clip to the frame before anything else. The cart's coordinates are its
      // own; the console's frame is not, and a cart must not be able to paint
      // over the bars by submitting a rect at -500.
      ctx.save();
      ctx.beginPath();
      ctx.rect(vp.x, vp.y, vp.w, vp.h);
      ctx.clip();

      const amount = postShake ? list.shake : 0;
      const shakeX = amount > 0 ? wobble(frame * 2) * amount * vp.scale : 0;
      const shakeY = amount > 0 ? wobble(frame * 2 + 1) * amount * vp.scale : 0;

      const ba = vp.scale;
      const bd = vp.scale;
      const be = vp.x + shakeX;
      const bf = vp.y + shakeY;

      for (let layer = 0; layer < LAYERS; layer++) {
        if (list.layerCount[layer] === 0) continue;
        drawLayer(ctx, list, layer, ba, 0, 0, bd, be, bf);
        const strength = list.bloom[layer * 2] as number;
        if (postBloom && strength > 0) {
          bloomPass(list, layer, strength, list.bloom[layer * 2 + 1] as number, shakeX, shakeY);
        }
      }

      ctx.restore();
    },
  };

  api.resize(LOGICAL_W, LOGICAL_H, 1);
  return api;
}
