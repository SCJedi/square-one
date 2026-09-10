/**
 * Presentation, proved in Node against an injected document.
 *
 * `createScreen({ document })` exists for exactly this. The interesting claims
 * -- the ImageData is allocated once, the frame is copied word for word, the
 * upscale is an integer and smoothing is off, and a resize that changes nothing
 * does not clear the canvas -- are all about the SEQUENCE OF CALLS the screen
 * makes, and a fake canvas records that sequence exactly where a real one hides
 * it behind a compositor.
 *
 * WHAT THIS DOES NOT PROVE. That a real browser's `putImageData` honours the
 * byte order, and that `image-rendering: pixelated` actually produces
 * nearest-neighbour sampling. Both are engine behaviour rather than this file's
 * logic, and both are visible the instant the demo page in `examples/player`
 * is opened.
 */

import { describe, expect, it } from "vitest";

import { computeLayout } from "../src/layout";
import { createScreen } from "../src/screen";

interface Call {
  name: string;
  args: unknown[];
}

interface FakeCanvas {
  width: number;
  height: number;
  style: Record<string, string>;
  attrs: Record<string, string>;
  ctx: FakeContext;
  setAttribute(k: string, v: string): void;
  getContext(kind: string): FakeContext | null;
}

interface FakeContext {
  imageSmoothingEnabled: boolean;
  calls: Call[];
  createImageData(w: number, h: number): { data: Uint8ClampedArray; width: number; height: number };
  putImageData(...args: unknown[]): void;
  drawImage(...args: unknown[]): void;
}

function fakeContext(): FakeContext {
  const calls: Call[] = [];
  return {
    imageSmoothingEnabled: true,
    calls,
    createImageData(w: number, h: number) {
      calls.push({ name: "createImageData", args: [w, h] });
      return { data: new Uint8ClampedArray(w * h * 4), width: w, height: h };
    },
    putImageData(...args: unknown[]) {
      calls.push({ name: "putImageData", args });
    },
    drawImage(...args: unknown[]) {
      calls.push({ name: "drawImage", args });
    },
  };
}

function fakeDocument(): { doc: Document; canvases: FakeCanvas[] } {
  const canvases: FakeCanvas[] = [];
  const doc = {
    createElement(tag: string): FakeCanvas {
      if (tag !== "canvas") throw new Error(`unexpected element ${tag}`);
      const ctx = fakeContext();
      const c: FakeCanvas = {
        width: 300,
        height: 150,
        style: {},
        attrs: {},
        ctx,
        setAttribute(k: string, v: string) {
          c.attrs[k] = v;
        },
        getContext() {
          return ctx;
        },
      };
      canvases.push(c);
      return c;
    },
  };
  return { doc: doc as unknown as Document, canvases };
}

function build(pixelRatio = 1): {
  screen: ReturnType<typeof createScreen>;
  back: FakeCanvas;
  front: FakeCanvas;
} {
  const { doc, canvases } = fakeDocument();
  const screen = createScreen({ document: doc, pixelRatio });
  expect(canvases.length).toBe(2);
  return { screen, back: canvases[0] as FakeCanvas, front: canvases[1] as FakeCanvas };
}

function checker(): Uint32Array {
  const rgba = new Uint32Array(128 * 128);
  for (let i = 0; i < rgba.length; i++) rgba[i] = (0xff000000 | (i * 2654435761)) >>> 0;
  return rgba;
}

describe("createScreen", () => {
  it("builds a backing canvas of exactly one cart frame", () => {
    const { back } = build();
    expect(back.width).toBe(128);
    expect(back.height).toBe(128);
  });

  it("turns smoothing off on the front canvas and asks for pixelated rendering", () => {
    const { front } = build();
    expect(front.ctx.imageSmoothingEnabled).toBe(false);
    expect(front.style["imageRendering"]).toBe("pixelated");
  });

  it("gives the canvas an accessible name, because it is the whole game", () => {
    const { front } = build();
    expect(front.attrs["aria-label"]).toBe("Square One screen");
    expect(front.attrs["role"]).toBe("img");
  });

  it("refuses to run without a document rather than failing later and quietly", () => {
    expect(() => createScreen({ document: undefined as unknown as Document })).toThrow(
      /no document/,
    );
  });
});

describe("present", () => {
  it("allocates the ImageData exactly once, however many frames go through", () => {
    const { screen, back } = build();
    const rgba = checker();
    for (let i = 0; i < 200; i++) screen.present(rgba);
    const allocations = back.ctx.calls.filter((c) => c.name === "createImageData");
    expect(allocations.length).toBe(1);
    expect(allocations[0]?.args).toEqual([128, 128]);
  });

  it("copies the frame word for word into the ImageData", () => {
    const { screen, back } = build();
    const rgba = checker();
    screen.present(rgba);
    const put = back.ctx.calls.find((c) => c.name === "putImageData");
    const image = put?.args[0] as { data: Uint8ClampedArray };
    // The runtime already packs for a Uint32Array view over a canvas buffer,
    // so a straight copy is the whole of the conversion. Reading it back as
    // words is the assertion that no channel arithmetic sneaked in.
    expect(Array.from(new Uint32Array(image.data.buffer).slice(0, 8))).toEqual(
      Array.from(rgba.slice(0, 8)),
    );
    expect(new Uint32Array(image.data.buffer)).toEqual(rgba);
  });

  it("puts the image at the origin and scales with drawImage, not with putImageData", () => {
    const { screen, back, front } = build();
    screen.resize(computeLayout(1920, 1080));
    screen.present(checker());
    const put = back.ctx.calls.find((c) => c.name === "putImageData");
    expect(put?.args.slice(1)).toEqual([0, 0]);
    const draw = front.ctx.calls.find((c) => c.name === "drawImage");
    // src 0,0,128,128 -> dst 0,0,1024,1024 at scale 8.
    expect(draw?.args.slice(1)).toEqual([0, 0, 128, 128, 0, 0, 1024, 1024]);
  });

  it("re-asserts smoothing off on every frame", () => {
    const { screen, front } = build();
    front.ctx.imageSmoothingEnabled = true;
    screen.present(checker());
    expect(front.ctx.imageSmoothingEnabled).toBe(false);
  });

  it("refuses a frame of the wrong size instead of drawing garbage", () => {
    const { screen } = build();
    expect(() => screen.present(new Uint32Array(100))).toThrow(/expected 16384 pixels/);
  });

  it("names a detached buffer for what it is", () => {
    const { screen } = build();
    expect(() => screen.present(new Uint32Array(0))).toThrow(/detached/);
  });
});

describe("resize", () => {
  it("matches the layout exactly, in CSS pixels and in device pixels", () => {
    const { screen, front } = build(1);
    const l = computeLayout(1920, 1080);
    screen.resize(l);
    expect(front.width).toBe(l.screen.w);
    expect(front.height).toBe(l.screen.h);
    expect(front.style["width"]).toBe(`${l.screen.w}px`);
    expect(front.style["left"]).toBe(`${l.screen.x}px`);
    expect(front.style["top"]).toBe(`${l.screen.y}px`);
  });

  it("allocates device pixels at the ratio but keeps the CSS box in CSS pixels", () => {
    const { screen, front } = build(2);
    const l = computeLayout(800, 600);
    screen.resize(l);
    expect(l.scale).toBe(3);
    expect(front.width).toBe(384 * 2);
    expect(front.style["width"]).toBe("384px");
  });

  it("floors a fractional device ratio, so the device grid stays whole too", () => {
    const { screen, front } = build(2.625);
    screen.resize(computeLayout(800, 600));
    expect(front.width).toBe(384 * 2);
  });

  it("never allocates fewer device pixels than CSS pixels", () => {
    const { screen, front } = build(0.5);
    screen.resize(computeLayout(800, 600));
    expect(front.width).toBe(384);
  });

  it("does not reassign the size when nothing changed, because that clears the canvas", () => {
    const { screen, front } = build();
    const l = computeLayout(800, 600);
    screen.resize(l);
    front.ctx.imageSmoothingEnabled = false;
    const before = front.width;
    // A canvas whose width is written is a canvas that just went black. Writing
    // it on every resize event would flash the screen during a window drag.
    let writes = 0;
    Object.defineProperty(front, "width", {
      configurable: true,
      get: () => before,
      set: () => {
        writes++;
      },
    });
    screen.resize(l);
    expect(writes).toBe(0);
  });

  it("keeps the presented size in step with the layout after a rotation", () => {
    const { screen, front } = build();
    screen.resize(computeLayout(390, 844));
    screen.present(checker());
    screen.resize(computeLayout(844, 390));
    front.ctx.calls.length = 0;
    screen.present(checker());
    const draw = front.ctx.calls.find((c) => c.name === "drawImage");
    const l = computeLayout(844, 390);
    expect(draw?.args.slice(5)).toEqual([0, 0, l.screen.w, l.screen.h]);
  });
});
