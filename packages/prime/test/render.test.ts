/**
 * The reference renderer, driven against a fake 2D context.
 *
 * A renderer whose only proof is a screenshot is a renderer whose regressions
 * are found by eye, one at a time, months later. Pixels are non-normative, so
 * there is nothing here to hash -- but the CALL SEQUENCE is a faithful
 * description of the scene, and it is exact: layer order, blend spans, letterbox
 * geometry and the local coordinates of every shape.
 *
 * The one thing eyes are still needed for is whether the result looks right, and
 * `examples/prime/index.html` is where that happens. These tests catch the other
 * kind of wrong.
 */

import { describe, expect, it } from "vitest";

import { LOGICAL_H, LOGICAL_W, createDraw } from "../src/draw";
import type { DisplayList } from "../src/draw";
import { createRenderer } from "../src/render";
import type { Ctx2D } from "../src/render";

// ---------------------------------------------------------------------------
// A recording 2D context
// ---------------------------------------------------------------------------

interface Call {
  k: string;
  a: readonly unknown[];
}

interface FakeCtx extends Ctx2D {
  readonly calls: Call[];
}

/** Property assignments are recorded too: `fillStyle` is as much a draw call as `fill`. */
function fakeCtx(): FakeCtx {
  const calls: Call[] = [];
  const rec =
    (k: string) =>
    (...a: unknown[]): void => {
      calls.push({ k, a });
    };
  const prop = <T>(k: string, initial: T): { get(): T; set(v: T): void } => {
    let v = initial;
    return {
      get: () => v,
      set: (next: T) => {
        v = next;
        calls.push({ k: `=${k}`, a: [next] });
      },
    };
  };

  const ctx = {
    calls,
    setTransform: rec("setTransform"),
    save: rec("save"),
    restore: rec("restore"),
    translate: rec("translate"),
    scale: rec("scale"),
    beginPath: rec("beginPath"),
    closePath: rec("closePath"),
    moveTo: rec("moveTo"),
    lineTo: rec("lineTo"),
    arc: rec("arc"),
    arcTo: rec("arcTo"),
    rect: rec("rect"),
    clip: rec("clip"),
    fill: rec("fill"),
    stroke: rec("stroke"),
    fillRect: rec("fillRect"),
    fillText: rec("fillText"),
    drawImage: rec("drawImage"),
    /**
     * A fixed advance per character, so the renderer's "scale the string to the
     * width `measure` promised" step has something to disagree with -- which is
     * the whole point of it. No real face has these metrics either.
     */
    measureText: (s: string): { width: number } => ({ width: s.length * 10 }),
  } as unknown as FakeCtx;

  for (const [k, v] of [
    ["fillStyle", ""],
    ["strokeStyle", ""],
    ["lineJoin", ""],
    ["lineCap", ""],
    ["font", ""],
    ["textBaseline", ""],
    ["globalCompositeOperation", "source-over"],
  ] as const) {
    Object.defineProperty(ctx, k, prop(k, v as string));
  }
  Object.defineProperty(ctx, "lineWidth", prop("lineWidth", 1));
  Object.defineProperty(ctx, "globalAlpha", prop("globalAlpha", 1));
  Object.defineProperty(ctx, "imageSmoothingEnabled", prop("imageSmoothingEnabled", true));
  return ctx;
}

interface FakeCanvas {
  width: number;
  height: number;
  style: Record<string, string>;
  ctx: FakeCtx;
  className: string;
  getContext(): FakeCtx;
  setAttribute(): void;
}

interface Harness {
  document: Document;
  /** Every canvas built, in creation order. `[0]` is the front buffer. */
  canvases: FakeCanvas[];
}

function harness(): Harness {
  const canvases: FakeCanvas[] = [];
  const document = {
    createElement(tag: string): FakeCanvas {
      if (tag !== "canvas") throw new Error(`unexpected element ${tag}`);
      const ctx = fakeCtx();
      const c: FakeCanvas = {
        width: 0,
        height: 0,
        style: {},
        ctx,
        className: "",
        getContext: () => ctx,
        setAttribute: () => undefined,
      };
      canvases.push(c);
      return c;
    },
  } as unknown as Document;
  return { document, canvases };
}

/** Only the calls that describe a shape. Transform and state are asserted separately. */
const SHAPE_CALLS = new Set([
  "fillRect",
  "beginPath",
  "closePath",
  "moveTo",
  "lineTo",
  "arc",
  "arcTo",
  "fill",
  "stroke",
  "fillText",
]);

function shapes(ctx: FakeCtx): Call[] {
  return ctx.calls.filter((c) => SHAPE_CALLS.has(c.k));
}

function only(ctx: FakeCtx, k: string): Call[] {
  return ctx.calls.filter((c) => c.k === k);
}

// ---------------------------------------------------------------------------

describe("letterboxing", () => {
  it("fills a 16:9 display exactly", () => {
    const h = harness();
    const r = createRenderer({ document: h.document });
    r.resize(1920, 1080, 1);
    expect(r.viewport).toEqual({ x: 0, y: 0, w: 1920, h: 1080, scale: 1 });
  });

  it("scales fractionally rather than in whole steps -- there are no source pixels", () => {
    const h = harness();
    const r = createRenderer({ document: h.document });
    r.resize(1280, 720, 2); // 2560 x 1440 device pixels
    expect(r.viewport.scale).toBeCloseTo(2560 / 1920, 12);
    expect(r.viewport.w).toBeCloseTo(2560, 9);
    expect(r.viewport.h).toBeCloseTo(1440, 9);
    expect(r.viewport.x).toBeCloseTo(0, 9);
    expect(r.viewport.y).toBeCloseTo(0, 9);
  });

  it("bars the top and bottom on 4:3", () => {
    const h = harness();
    const r = createRenderer({ document: h.document });
    r.resize(1024, 768, 1);
    expect(r.viewport.scale).toBeCloseTo(1024 / 1920, 12);
    expect(r.viewport.w).toBeCloseTo(1024, 9);
    expect(r.viewport.h).toBeCloseTo(576, 9);
    expect(r.viewport.x).toBeCloseTo(0, 9);
    expect(r.viewport.y).toBeCloseTo(96, 9);
  });

  it("bars the sides on ultrawide", () => {
    const h = harness();
    const r = createRenderer({ document: h.document });
    r.resize(2560, 1080, 1);
    expect(r.viewport.scale).toBeCloseTo(1, 12);
    expect(r.viewport.w).toBeCloseTo(1920, 9);
    expect(r.viewport.h).toBeCloseTo(1080, 9);
    expect(r.viewport.x).toBeCloseTo(320, 9);
    expect(r.viewport.y).toBeCloseTo(0, 9);
  });

  it("survives a degenerate box instead of dividing by zero", () => {
    const h = harness();
    const r = createRenderer({ document: h.document });
    r.resize(0, 0, 1);
    expect(Number.isFinite(r.viewport.scale)).toBe(true);
    expect(r.viewport.w).toBeGreaterThan(0);
  });

  it("paints the bars and clips the frame before a cart draws anything", () => {
    const h = harness();
    const r = createRenderer({ document: h.document });
    r.resize(2560, 1080, 1);
    const ctx = h.canvases[0]!.ctx;
    ctx.calls.length = 0;

    const d = createDraw();
    d.begin();
    // A cart asking to paint far outside its own frame. It must not reach the bars.
    d.rect(-5000, -5000, 20000, 20000, 0xff0000ff);
    r.draw(d.list);

    // The whole surface is blacked first...
    const first = ctx.calls.findIndex((c) => c.k === "fillRect");
    expect(ctx.calls[first]!.a).toEqual([0, 0, 2560, 1080]);
    // ...then the frame is clipped, and the clip is the viewport.
    expect(only(ctx, "rect")[0]!.a).toEqual([320, 0, 1920, 1080]);
    expect(only(ctx, "clip")).toHaveLength(1);
    expect(only(ctx, "save")).toHaveLength(1);
    expect(only(ctx, "restore")).toHaveLength(1);
  });
});

describe("layers", () => {
  it("draws low to high, whatever order the cart recorded them in", () => {
    const h = harness();
    const r = createRenderer({ document: h.document });
    r.resize(1920, 1080, 1);
    const ctx = h.canvases[0]!.ctx;

    const d = createDraw();
    d.begin();
    d.layer(5);
    d.rect(50, 0, 1, 1, 0);
    d.layer(0);
    d.rect(0, 0, 1, 1, 0);
    d.layer(3);
    d.rect(30, 0, 1, 1, 0);

    ctx.calls.length = 0;
    r.draw(d.list);
    // The first fillRect is the letterbox wipe; the cart's three follow, sorted.
    const xs = only(ctx, "fillRect")
      .slice(1)
      .map((c) => c.a[0]);
    expect(xs).toEqual([0, 30, 50]);
  });

  it("skips an empty layer without touching the context", () => {
    const h = harness();
    const r = createRenderer({ document: h.document });
    r.resize(1920, 1080, 1);
    const ctx = h.canvases[0]!.ctx;

    const d = createDraw();
    d.begin();
    d.layer(7);
    d.rect(0, 0, 1, 1, 0);

    ctx.calls.length = 0;
    r.draw(d.list);
    // One pass ran, not eight: the composite-operation resets bracket exactly
    // one layer.
    expect(only(ctx, "=globalCompositeOperation").map((c) => c.a[0])).toEqual([
      "source-over", // the frame prologue
      "source-over", // layer 7 opens
      "source-over", // layer 7 closes
    ]);
  });
});

describe("blending", () => {
  it("sets `lighter` for an additive span and puts it back afterwards", () => {
    const h = harness();
    const r = createRenderer({ document: h.document });
    r.resize(1920, 1080, 1);
    const ctx = h.canvases[0]!.ctx;

    const d = createDraw();
    d.begin();
    d.rect(0, 0, 1, 1, 0xffffffff); // normal
    d.blend(1);
    d.circle(10, 10, 5, 0xff8800ff); // additive
    d.circle(20, 20, 5, 0xff8800ff); // still additive -- one state change, not two
    d.blend(0);
    d.rect(1, 1, 1, 1, 0xffffffff); // normal again

    ctx.calls.length = 0;
    r.draw(d.list);

    expect(only(ctx, "=globalCompositeOperation").map((c) => c.a[0])).toEqual([
      "source-over", // the frame prologue
      "source-over", // the layer opens
      "lighter", // the additive span
      "source-over", // back to normal for the last rect
      "source-over", // the layer closes
    ]);
  });

  it("never leaves a pass in additive, so the next layer starts clean", () => {
    const h = harness();
    const r = createRenderer({ document: h.document });
    r.resize(1920, 1080, 1);
    const ctx = h.canvases[0]!.ctx;

    const d = createDraw();
    d.begin();
    d.blend(1);
    d.rect(0, 0, 1, 1, 0); // layer 0 ends additive
    d.layer(1);
    d.blend(1);
    d.rect(0, 0, 1, 1, 0);

    ctx.calls.length = 0;
    r.draw(d.list);
    const ops = only(ctx, "=globalCompositeOperation").map((c) => c.a[0]);
    expect(ops[ops.length - 1]).toBe("source-over");
    // Each layer sets `lighter` for itself rather than inheriting it.
    expect(ops.filter((o) => o === "lighter")).toHaveLength(2);
  });
});

describe("shapes", () => {
  it("maps a command through base * baked transform", () => {
    const h = harness();
    const r = createRenderer({ document: h.document });
    r.resize(2560, 1080, 1); // scale 1, frame offset x = 320

    const d = createDraw();
    d.begin();
    d.translate(100, 50);
    d.scale(2, 2);
    d.rect(0, 0, 10, 10, 0xffffffff);

    const ctx = h.canvases[0]!.ctx;
    ctx.calls.length = 0;
    r.draw(d.list);

    const t = only(ctx, "setTransform");
    // [0] is the prologue's identity; [1] is the rect.
    expect(t[1]!.a).toEqual([2, 0, 0, 2, 420, 50]);
    // The geometry stays LOCAL. That is what lets the matrix be the only thing
    // a resolution change touches.
    expect(only(ctx, "fillRect")[1]!.a).toEqual([0, 0, 10, 10]);
  });

  it("draws a clear as the whole logical frame, ignoring the cart's transform", () => {
    const h = harness();
    const r = createRenderer({ document: h.document });
    r.resize(1920, 1080, 1);

    const d = createDraw();
    d.begin();
    d.translate(500, 500);
    d.clear(0x102030ff);

    const ctx = h.canvases[0]!.ctx;
    ctx.calls.length = 0;
    r.draw(d.list);

    const fills = only(ctx, "fillRect");
    expect(fills[1]!.a).toEqual([0, 0, LOGICAL_W, LOGICAL_H]);
    expect(only(ctx, "setTransform")[1]!.a).toEqual([1, 0, 0, 1, 0, 0]);
    expect(only(ctx, "=fillStyle").map((c) => c.a[0])).toContain("rgb(16,32,48)");
  });

  it("emits an arc for a circle, a closed path for a triangle, a stroke for a line", () => {
    const h = harness();
    const r = createRenderer({ document: h.document });
    r.resize(1920, 1080, 1);

    const d = createDraw();
    d.begin();
    d.circle(10, 20, 30, 0xff0000ff);
    d.tri(0, 0, 10, 0, 5, 8, 0x00ff00ff);
    d.line(1, 2, 3, 4, 6, 0x0000ffff);

    const ctx = h.canvases[0]!.ctx;
    ctx.calls.length = 0;
    r.draw(d.list);

    expect(only(ctx, "arc")[0]!.a.slice(0, 3)).toEqual([10, 20, 30]);
    expect(only(ctx, "moveTo").map((c) => c.a)).toEqual([
      [0, 0],
      [1, 2],
    ]);
    expect(only(ctx, "lineTo").map((c) => c.a)).toEqual([
      [10, 0],
      [5, 8],
      [3, 4],
    ]);
    expect(only(ctx, "stroke")).toHaveLength(1);
    expect(only(ctx, "=lineWidth").map((c) => c.a[0])).toEqual([6]);
  });

  it("clamps a round rect's radius to half its shorter side", () => {
    const h = harness();
    const r = createRenderer({ document: h.document });
    r.resize(1920, 1080, 1);

    const d = createDraw();
    d.begin();
    d.roundRect(0, 0, 40, 20, 999, 0xffffffff);

    const ctx = h.canvases[0]!.ctx;
    ctx.calls.length = 0;
    r.draw(d.list);

    const arcs = only(ctx, "arcTo");
    expect(arcs).toHaveLength(4);
    for (const a of arcs) expect(a.a[4]).toBe(10);
  });

  it("scales text to the width `draw.measure` promised", () => {
    const h = harness();
    const r = createRenderer({ document: h.document });
    r.resize(1920, 1080, 1);

    const d = createDraw();
    d.begin();
    const want = d.measure("SCORE", 40);
    d.text("SCORE", 100, 200, 40, 0xffffffff);

    const ctx = h.canvases[0]!.ctx;
    ctx.calls.length = 0;
    r.draw(d.list);

    // The fake face reports 10 px per character, which is nothing like the
    // table -- so the correction has to be real, not an accidental 1.
    const got = 5 * 10;
    expect(only(ctx, "translate")[0]!.a).toEqual([100, 200]);
    expect(only(ctx, "scale")[0]!.a[0]).toBeCloseTo(want / got, 12);
    expect(only(ctx, "fillText")[0]!.a).toEqual(["SCORE", 0, 0]);
    expect(only(ctx, "=textBaseline")[0]!.a[0]).toBe("alphabetic");
  });
});

describe("the non-normative post stages", () => {
  /** A scene that declares both post stages, and the same scene declaring neither. */
  function scenes(): { withPost: DisplayList; without: DisplayList } {
    const a = createDraw();
    a.begin();
    a.clear(0x06060cff);
    a.layer(1);
    a.bloom(0.8, 0.4);
    a.shake(24);
    a.blend(1);
    a.circle(960, 540, 40, 0xff8800ff);
    a.rect(100, 100, 50, 50, 0x00ffccff);

    const b = createDraw();
    b.begin();
    b.clear(0x06060cff);
    b.layer(1);
    b.blend(1);
    b.circle(960, 540, 40, 0xff8800ff);
    b.rect(100, 100, 50, 50, 0x00ffccff);

    return { withPost: a.list, without: b.list };
  }

  it("leaves the scene identical when both are switched off", () => {
    const s = scenes();

    const on = harness();
    const rOn = createRenderer({ document: on.document });
    rOn.resize(1920, 1080, 1);
    on.canvases[0]!.ctx.calls.length = 0;
    rOn.draw(s.without); // no bloom, no shake declared: post has nothing to do

    const off = harness();
    const rOff = createRenderer({ document: off.document, post: { bloom: false, shake: false } });
    rOff.resize(1920, 1080, 1);
    off.canvases[0]!.ctx.calls.length = 0;
    rOff.draw(s.withPost); // both declared, both ignored

    expect(off.canvases[0]!.ctx.calls).toEqual(on.canvases[0]!.ctx.calls);
    // And no scratch canvas was ever built.
    expect(off.canvases).toHaveLength(1);
  });

  it("moves the frame but never the geometry when shake is on", () => {
    const s = scenes();

    const off = harness();
    const rOff = createRenderer({ document: off.document, post: { bloom: false, shake: false } });
    rOff.resize(1920, 1080, 1);
    off.canvases[0]!.ctx.calls.length = 0;
    rOff.draw(s.withPost);

    const on = harness();
    const rOn = createRenderer({ document: on.document, post: { bloom: false, shake: true } });
    rOn.resize(1920, 1080, 1);
    on.canvases[0]!.ctx.calls.length = 0;
    rOn.draw(s.withPost);

    // Every shape is described in exactly the same local coordinates...
    expect(shapes(on.canvases[0]!.ctx)).toEqual(shapes(off.canvases[0]!.ctx));
    // ...and only the frame's own matrix moved.
    const tOn = only(on.canvases[0]!.ctx, "setTransform").map((c) => c.a.slice(4));
    const tOff = only(off.canvases[0]!.ctx, "setTransform").map((c) => c.a.slice(4));
    expect(tOn).not.toEqual(tOff);
  });

  it("re-draws the layer into a downscaled scratch and composites it additively", () => {
    const h = harness();
    const r = createRenderer({ document: h.document, post: { bloom: true, shake: false } });
    r.resize(1920, 1080, 1);
    const main = h.canvases[0]!.ctx;

    const d = createDraw();
    d.begin();
    d.layer(2);
    d.bloom(0.8, 0.4);
    d.circle(960, 540, 40, 0xff8800ff);

    main.calls.length = 0;
    r.draw(d.list);

    // A scratch canvas exists and is a quarter of the frame on each side.
    expect(h.canvases).toHaveLength(2);
    const scratch = h.canvases[1]!;
    expect(scratch.width).toBe(480);
    expect(scratch.height).toBe(270);

    // The layer really was re-drawn into it -- bloom is per layer, so it cannot
    // be a copy of the framebuffer.
    expect(only(scratch.ctx, "arc")).toHaveLength(1);

    // And it comes back with `lighter` at the declared strength, stretched over
    // the viewport.
    const blit = only(main, "drawImage");
    expect(blit).toHaveLength(1);
    expect(blit[0]!.a.slice(1)).toEqual([0, 0, 480, 270, 0, 0, 1920, 1080]);
    const ops = only(main, "=globalCompositeOperation").map((c) => c.a[0]);
    expect(ops).toContain("lighter");
    expect(ops[ops.length - 1]).toBe("source-over");
    expect(only(main, "=globalAlpha").map((c) => c.a[0])).toContain(0.8);
  });

  it("setPost switches a stage at runtime, which is what reduced motion needs", () => {
    const h = harness();
    const r = createRenderer({ document: h.document });
    expect(r.post).toEqual({ bloom: true, shake: true });
    r.setPost({ shake: false });
    expect(r.post).toEqual({ bloom: true, shake: false });
    r.setPost({ bloom: false });
    expect(r.post).toEqual({ bloom: false, shake: false });
  });
});
