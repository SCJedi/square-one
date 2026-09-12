/**
 * The display list is the exact half of Prime's picture.
 *
 * Pixels are non-normative and two renderers may legitimately disagree about
 * every one of them. The LIST may not: it is what the cart said, and "did the
 * cart describe the right scene" has to be a question with a yes-or-no answer or
 * there is nothing between a rendering bug and a game bug.
 *
 * So these tests are strict, they run in Node with no DOM, and the last of them
 * is about garbage rather than geometry -- because a recorder that allocates
 * hands the frame clock to the collector, and it does it during the explosion.
 */

import { describe, expect, it } from "vitest";

import {
  BLEND,
  FIELD,
  LAYERS,
  LOGICAL_H,
  LOGICAL_W,
  MAX_DEPTH,
  OP,
  STRIDE,
  createDraw,
  cssColor,
  measureText,
  unpackColor,
} from "../src/draw";
import type { DisplayList } from "../src/draw";

/** One command, unpacked into something a failure message can describe. */
interface Cmd {
  op: number;
  m: [number, number, number, number, number, number];
  p: [number, number, number, number, number, number];
  color: number;
  layer: number;
  blend: number;
}

function cmd(list: DisplayList, i: number): Cmd {
  const d = list.data;
  const o = i * STRIDE;
  return {
    op: d[o + FIELD.OP] as number,
    m: [
      d[o + FIELD.A] as number,
      d[o + FIELD.B] as number,
      d[o + FIELD.C] as number,
      d[o + FIELD.D] as number,
      d[o + FIELD.E] as number,
      d[o + FIELD.F] as number,
    ],
    p: [
      d[o + FIELD.P0] as number,
      d[o + FIELD.P1] as number,
      d[o + FIELD.P2] as number,
      d[o + FIELD.P3] as number,
      d[o + FIELD.P4] as number,
      d[o + FIELD.P5] as number,
    ],
    color: d[o + FIELD.COLOR] as number,
    layer: d[o + FIELD.LAYER] as number,
    blend: d[o + FIELD.BLEND] as number,
  };
}

describe("the logical space", () => {
  it("is 1920 x 1080 and 16:9", () => {
    expect(LOGICAL_W).toBe(1920);
    expect(LOGICAL_H).toBe(1080);
    expect(LOGICAL_W / LOGICAL_H).toBeCloseTo(16 / 9, 12);
  });
});

describe("recording", () => {
  it("keeps commands in the order they were made", () => {
    const d = createDraw();
    d.begin();
    d.clear(0x101018ff);
    d.rect(1, 2, 3, 4, 0xff0000ff);
    d.circle(5, 6, 7, 0x00ff00ff);
    d.tri(1, 1, 2, 2, 3, 3, 0x0000ffff);
    d.line(0, 0, 10, 10, 2, 0xffffffff);
    d.roundRect(8, 9, 10, 11, 3, 0xff00ffff);
    d.text("hi", 12, 13, 24, 0x00ffffff);

    expect(d.count).toBe(7);
    expect([0, 1, 2, 3, 4, 5, 6].map((i) => cmd(d.list, i).op)).toEqual([
      OP.CLEAR,
      OP.RECT,
      OP.CIRCLE,
      OP.TRI,
      OP.LINE,
      OP.ROUND_RECT,
      OP.TEXT,
    ]);
  });

  it("stores each command's own geometry", () => {
    const d = createDraw();
    d.begin();
    d.rect(1, 2, 3, 4, 0);
    d.roundRect(8, 9, 10, 11, 3, 0);
    d.circle(5, 6, 7, 0);
    d.line(0, 1, 10, 11, 2, 0);
    d.tri(1, 2, 3, 4, 5, 6, 0);

    expect(cmd(d.list, 0).p.slice(0, 4)).toEqual([1, 2, 3, 4]);
    expect(cmd(d.list, 1).p.slice(0, 5)).toEqual([8, 9, 10, 11, 3]);
    expect(cmd(d.list, 2).p.slice(0, 3)).toEqual([5, 6, 7]);
    expect(cmd(d.list, 3).p.slice(0, 5)).toEqual([0, 1, 10, 11, 2]);
    expect(cmd(d.list, 4).p).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("holds a colour as the ABI's u32, even written as a signed literal", () => {
    const d = createDraw();
    d.begin();
    // 0xff0000ff as a bitwise expression is negative in JavaScript. What comes
    // back out must still be the colour the cart meant.
    d.rect(0, 0, 1, 1, 0xff0000ff | 0);
    expect(cmd(d.list, 0).color).toBe(0xff0000ff);
    expect(unpackColor(cmd(d.list, 0).color)).toEqual({ r: 255, g: 0, b: 0, a: 1 });
  });

  it("begin() clears the list, the transform, the layer, the blend and the post stages", () => {
    const d = createDraw();
    d.begin();
    d.layer(4);
    d.blend(1);
    d.translate(100, 100);
    d.bloom(0.8, 0.5);
    d.shake(20);
    d.rect(0, 0, 1, 1, 0);

    d.begin();
    d.rect(0, 0, 1, 1, 0);
    const c = cmd(d.list, 0);
    expect(d.count).toBe(1);
    expect(c.layer).toBe(0);
    expect(c.blend).toBe(BLEND.NORMAL);
    expect(c.m).toEqual([1, 0, 0, 1, 0, 0]);
    expect(d.list.shake).toBe(0);
    expect(Array.from(d.list.bloom)).toEqual(new Array<number>(LAYERS * 2).fill(0));
  });

  it("counts commands per layer so a renderer can skip an empty pass", () => {
    const d = createDraw();
    d.begin();
    d.rect(0, 0, 1, 1, 0);
    d.layer(3);
    d.rect(0, 0, 1, 1, 0);
    d.rect(0, 0, 1, 1, 0);
    expect(Array.from(d.list.layerCount)).toEqual([1, 0, 0, 2, 0, 0, 0, 0]);
  });

  it("grows by doubling and keeps everything already recorded", () => {
    const d = createDraw({ capacity: 16 });
    d.begin();
    for (let i = 0; i < 40; i++) d.rect(i, 0, 1, 1, 0);
    expect(d.count).toBe(40);
    expect(d.capacity).toBe(64);
    expect(d.growths).toBe(2);
    for (let i = 0; i < 40; i++) expect(cmd(d.list, i).p[0]).toBe(i);
  });
});

describe("the transform stack", () => {
  it("bakes the current transform into each command as it is recorded", () => {
    const d = createDraw();
    d.begin();
    d.rect(0, 0, 1, 1, 0);
    d.translate(10, 20);
    d.rect(0, 0, 1, 1, 0);
    d.scale(2, 3);
    d.rect(0, 0, 1, 1, 0);

    expect(cmd(d.list, 0).m).toEqual([1, 0, 0, 1, 0, 0]);
    expect(cmd(d.list, 1).m).toEqual([1, 0, 0, 1, 10, 20]);
    expect(cmd(d.list, 2).m).toEqual([2, 0, 0, 3, 10, 20]);
  });

  it("maps a point through the baked matrix the way Canvas2D would", () => {
    const d = createDraw();
    d.begin();
    d.translate(100, 50);
    d.rotate(Math.PI / 2);
    d.scale(2, 2);
    d.rect(0, 0, 1, 1, 0);

    const [a, b, c, dd, e, f] = cmd(d.list, 0).m;
    // The local point (3, 0): scaled to (6, 0), rotated a quarter turn to
    // (0, 6), translated to (100, 56).
    const x = a * 3 + c * 0 + e;
    const y = b * 3 + dd * 0 + f;
    expect(x).toBeCloseTo(100, 9);
    expect(y).toBeCloseTo(56, 9);
  });

  it("restores exactly on pop, and a balanced frame ends at depth 0", () => {
    const d = createDraw();
    d.begin();
    d.translate(5, 5);
    d.push();
    d.translate(100, 0);
    d.rotate(1.234);
    d.rect(0, 0, 1, 1, 0);
    d.pop();
    d.rect(0, 0, 1, 1, 0);

    expect(d.depth).toBe(0);
    expect(cmd(d.list, 1).m).toEqual([1, 0, 0, 1, 5, 5]);
  });

  it("nests", () => {
    const d = createDraw();
    d.begin();
    d.push();
    d.translate(1, 0);
    d.push();
    d.translate(2, 0);
    d.push();
    d.translate(4, 0);
    d.rect(0, 0, 1, 1, 0);
    d.pop();
    d.rect(0, 0, 1, 1, 0);
    d.pop();
    d.rect(0, 0, 1, 1, 0);
    d.pop();
    d.rect(0, 0, 1, 1, 0);

    expect([0, 1, 2, 3].map((i) => cmd(d.list, i).m[4])).toEqual([7, 3, 1, 0]);
    expect(d.depth).toBe(0);
  });

  it("throws on an unbalanced pop rather than corrupting the transform", () => {
    const d = createDraw();
    d.begin();
    d.push();
    d.pop();
    expect(() => d.pop()).toThrow(/transform stack is empty/);
  });

  it("throws rather than growing the stack past MAX_DEPTH", () => {
    const d = createDraw();
    d.begin();
    for (let i = 0; i < MAX_DEPTH; i++) d.push();
    expect(d.depth).toBe(MAX_DEPTH);
    expect(() => d.push()).toThrow(/deep/);
  });
});

describe("layers and blend modes", () => {
  it("captures both per command, not as commands of their own", () => {
    const d = createDraw();
    d.begin();
    d.rect(0, 0, 1, 1, 0);
    d.layer(2);
    d.blend(1);
    d.rect(0, 0, 1, 1, 0);
    d.blend(0);
    d.layer(7);
    d.rect(0, 0, 1, 1, 0);

    // Three shapes and three shapes only: `layer` and `blend` are state.
    expect(d.count).toBe(3);
    expect([0, 1, 2].map((i) => cmd(d.list, i).layer)).toEqual([0, 2, 7]);
    expect([0, 1, 2].map((i) => cmd(d.list, i).blend)).toEqual([
      BLEND.NORMAL,
      BLEND.ADDITIVE,
      BLEND.NORMAL,
    ]);
  });

  it("clamps a layer into range instead of throwing over a decoration", () => {
    const d = createDraw();
    d.begin();
    d.layer(-3);
    d.rect(0, 0, 1, 1, 0);
    d.layer(99);
    d.rect(0, 0, 1, 1, 0);
    expect([0, 1].map((i) => cmd(d.list, i).layer)).toEqual([0, LAYERS - 1]);
  });
});

describe("the post stages", () => {
  it("declares bloom per layer", () => {
    const d = createDraw();
    d.begin();
    d.layer(1);
    d.bloom(0.5, 0.25);
    d.layer(5);
    d.bloom(1, 0.75);
    expect(d.list.bloom[1 * 2]).toBe(0.5);
    expect(d.list.bloom[1 * 2 + 1]).toBe(0.25);
    expect(d.list.bloom[5 * 2]).toBe(1);
    expect(d.list.bloom[5 * 2 + 1]).toBe(0.75);
    expect(d.list.bloom[0]).toBe(0);
  });

  it("clamps bloom parameters to 0..1", () => {
    const d = createDraw();
    d.begin();
    d.bloom(9, -4);
    expect(d.list.bloom[0]).toBe(1);
    expect(d.list.bloom[1]).toBe(0);
  });

  it("takes the strongest shake of the frame, not the last one", () => {
    const d = createDraw();
    d.begin();
    d.shake(30);
    d.shake(2);
    expect(d.list.shake).toBe(30);
  });
});

describe("text", () => {
  it("keeps the string by reference and points the command at it", () => {
    const d = createDraw();
    d.begin();
    d.text("SCORE", 10, 20, 32, 0xffffffff);
    const c = cmd(d.list, 0);
    expect(c.op).toBe(OP.TEXT);
    expect(c.p.slice(0, 3)).toEqual([10, 20, 32]);
    expect(d.list.strings[c.p[3]]).toBe("SCORE");
  });

  it("measures without a canvas, and measure scales with size", () => {
    const d = createDraw();
    const one = d.measure("SCORE", 32);
    expect(one).toBeGreaterThan(0);
    expect(d.measure("SCORE", 64)).toBeCloseTo(one * 2, 9);
    expect(d.measure("", 32)).toBe(0);
    // `measure` and the renderer must be the same function, or a centred score
    // is centred differently on every machine.
    expect(measureText("SCORE", 32)).toBe(one);
  });

  it("gives a wide glyph more room than a narrow one", () => {
    expect(measureText("W", 100)).toBeGreaterThan(measureText("i", 100));
  });

  it("does not hold last frame's strings alive", () => {
    const d = createDraw();
    d.begin();
    d.text("first", 0, 0, 10, 0);
    d.begin();
    expect(d.list.strings[0]).toBe("");
  });
});

describe("colours", () => {
  it("reads 0xRRGGBBAA in that order", () => {
    expect(cssColor(0x112233ff)).toBe("rgb(17,34,51)");
    expect(cssColor(0xff000080)).toMatch(/^rgba\(255,0,0,0\.50/);
  });
});

// ---------------------------------------------------------------------------
// Allocation
// ---------------------------------------------------------------------------

/**
 * Every global constructor a recorder could plausibly reach for.
 *
 * The same probe `packages/runtime/test/machine.test.ts` uses, and with the same
 * blind spot stated plainly: it does not see object literals, array literals or
 * closures, because none of those route through a global constructor. Those are
 * held to by reading `draw.ts`, which builds none.
 */
const COUNTED_CTORS = [
  "Array",
  "ArrayBuffer",
  "DataView",
  "Float32Array",
  "Float64Array",
  "Int8Array",
  "Int16Array",
  "Int32Array",
  "Map",
  "Set",
  "Uint8Array",
  "Uint16Array",
  "Uint32Array",
  "WeakMap",
] as const;

type Ctor = new (...args: never[]) => unknown;

function countingConstructions(body: () => void): number {
  const g = globalThis as unknown as Record<string, Ctor>;
  const saved = new Map<string, Ctor>();
  let count = 0;
  for (const name of COUNTED_CTORS) {
    const orig = g[name] as Ctor;
    saved.set(name, orig);
    g[name] = new Proxy(orig, {
      construct(target, args, newTarget): object {
        count++;
        return Reflect.construct(target, args, newTarget) as object;
      },
    }) as Ctor;
  }
  try {
    body();
  } finally {
    for (const [name, orig] of saved) g[name] = orig;
  }
  return count;
}

describe("allocation discipline", () => {
  it("records ten thousand commands and constructs nothing", () => {
    const d = createDraw({ capacity: 16 });

    /** One frame's worth of the load this file exists to survive. */
    const frame = (): void => {
      d.begin();
      d.clear(0x06060cff);
      d.layer(1);
      d.bloom(0.7, 0.4);
      d.shake(3);
      for (let i = 0; i < 2000; i++) {
        d.push();
        d.translate(i % 1920, (i * 7) % 1080);
        d.rotate(i * 0.01);
        d.scale(1.5, 1.5);
        d.blend(i & 1 ? 1 : 0);
        d.circle(0, 0, 4, 0xff8800ff);
        d.rect(-2, -2, 4, 4, 0x00ffccff);
        d.roundRect(-3, -3, 6, 6, 1, 0x8844ffff);
        d.line(-4, 0, 4, 0, 1, 0xffffffff);
        d.tri(0, -4, 4, 4, -4, 4, 0xff00ffff);
        d.pop();
      }
      d.text("SCORE 0000", 40, 60, 48, 0xffffffff);
      d.measure("SCORE 0000", 48);
    };

    // Warm up OUTSIDE the probe, exactly as the machine's own test does: the
    // doubling growth is real allocation and it is supposed to happen, once.
    frame();
    frame();
    const grewBefore = d.growths;

    const constructions = countingConstructions(() => {
      for (let f = 0; f < 3; f++) frame();
    });

    expect(d.count).toBe(10002);
    expect(constructions).toBe(0);
    expect(d.growths).toBe(grewBefore);
  });

  it("measure() builds no string and no array", () => {
    const s = "a moderately long line of user interface text";
    measureText(s, 24); // warm
    const constructions = countingConstructions(() => {
      for (let i = 0; i < 10000; i++) measureText(s, 24);
    });
    expect(constructions).toBe(0);
  });
});
