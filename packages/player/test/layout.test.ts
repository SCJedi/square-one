/**
 * The layout is pure arithmetic, so every claim about it is an assertion rather
 * than a screenshot.
 *
 * The viewports below are not decorative. 320 x 480 is the smallest phone still
 * in use; 390 x 844 is the modern one; 1920 x 1080 and 800 x 600 are the two
 * desktops; 128 x 128 is the degenerate case where the screen is the whole
 * device; 100 x 2000 is the sliver that proves the code does not divide by a
 * negative or emit a rect with negative width. A layout bug on any of them is a
 * console that is unusable on a real device, and none of them is discoverable
 * by looking at one browser window.
 */

import { describe, expect, it } from "vitest";

import {
  MIN_TOUCH,
  SCREEN_SIZE,
  computeLayout,
  hitRect,
  screenFits,
} from "../src/layout";
import type { Rect, ShellLayout } from "../src/layout";

/** Every viewport worth asserting on, with the touch flag both ways. */
const VIEWPORTS: readonly [number, number][] = [
  [320, 480],
  [390, 844],
  [414, 896],
  [360, 640],
  [1920, 1080],
  [1280, 800],
  [800, 600],
  [1024, 768],
  [128, 128],
  [100, 2000],
  [2000, 100],
  [1, 1],
  [0, 0],
  [667, 375],
  [844, 390],
];

function allRects(l: ShellLayout): Rect[] {
  const out: Rect[] = [l.screen, l.chrome, l.pause];
  if (l.dpad !== null) out.push(l.dpad);
  if (l.buttons !== null) out.push(l.buttons.a, l.buttons.b, l.buttons.x, l.buttons.y);
  return out;
}

describe("computeLayout", () => {
  for (const [w, h] of VIEWPORTS) {
    for (const touch of [false, true]) {
      const label = `${w}x${h} touch=${touch}`;

      it(`${label}: the scale is a whole number of at least 1`, () => {
        const l = computeLayout(w, h, { touch });
        expect(Number.isInteger(l.scale)).toBe(true);
        expect(l.scale).toBeGreaterThanOrEqual(1);
      });

      it(`${label}: the screen is exactly 128 * scale, square`, () => {
        const l = computeLayout(w, h, { touch });
        expect(l.screen.w).toBe(SCREEN_SIZE * l.scale);
        expect(l.screen.h).toBe(SCREEN_SIZE * l.scale);
      });

      it(`${label}: every rect is a whole number and never negative`, () => {
        const l = computeLayout(w, h, { touch });
        for (const r of allRects(l)) {
          expect(Number.isInteger(r.x)).toBe(true);
          expect(Number.isInteger(r.y)).toBe(true);
          expect(Number.isInteger(r.w)).toBe(true);
          expect(Number.isInteger(r.h)).toBe(true);
          expect(r.w).toBeGreaterThanOrEqual(0);
          expect(r.h).toBeGreaterThanOrEqual(0);
          expect(r.x).toBeGreaterThanOrEqual(0);
          expect(r.y).toBeGreaterThanOrEqual(0);
        }
      });

      it(`${label}: touch targets are never below the 44px floor`, () => {
        const l = computeLayout(w, h, { touch });
        if (l.dpad !== null) {
          // A d-pad is three cells across; each must clear the floor.
          expect(l.dpad.w / 3).toBeGreaterThanOrEqual(MIN_TOUCH);
          expect(l.dpad.h / 3).toBeGreaterThanOrEqual(MIN_TOUCH);
        }
        if (l.buttons !== null) {
          for (const b of [l.buttons.a, l.buttons.b, l.buttons.x, l.buttons.y]) {
            expect(b.w).toBeGreaterThanOrEqual(MIN_TOUCH);
            expect(b.h).toBeGreaterThanOrEqual(MIN_TOUCH);
          }
        }
      });

      it(`${label}: the controller is all or nothing`, () => {
        const l = computeLayout(w, h, { touch });
        expect(l.dpad === null).toBe(l.buttons === null);
      });

      it(`${label}: the pause button exists and is inside the viewport`, () => {
        const l = computeLayout(w, h, { touch });
        expect(l.pause.w).toBeGreaterThan(0);
        expect(l.pause.h).toBeGreaterThan(0);
        if (w >= MIN_TOUCH && h >= MIN_TOUCH) {
          expect(l.pause.w).toBeGreaterThanOrEqual(MIN_TOUCH);
          expect(l.pause.h).toBeGreaterThanOrEqual(MIN_TOUCH);
        }
        if (w > 0 && h > 0) {
          expect(l.pause.x + l.pause.w).toBeLessThanOrEqual(w);
          expect(l.pause.y + l.pause.h).toBeLessThanOrEqual(h);
        }
      });
    }
  }

  it("fits the screen inside every viewport that is at least 128 square", () => {
    for (const [w, h] of VIEWPORTS) {
      if (w < SCREEN_SIZE || h < SCREEN_SIZE) continue;
      for (const touch of [false, true]) {
        const l = computeLayout(w, h, { touch });
        expect(screenFits(l, w, h), `${w}x${h} touch=${touch}`).toBe(true);
      }
    }
  });

  it("below 128 px there is no honest integer scale, and the code says so", () => {
    // The one property that cannot be satisfied: scale >= 1 AND the screen
    // fits. The console keeps the integer scale and overflows, because a
    // fractional scale would destroy the pixel grid the whole machine is for.
    const l = computeLayout(100, 2000);
    expect(l.scale).toBe(1);
    expect(l.screen.w).toBe(128);
    expect(screenFits(l, 100, 2000)).toBe(false);
  });

  it("128x128 exactly: the screen is the whole device", () => {
    const l = computeLayout(128, 128, { touch: true });
    expect(l.scale).toBe(1);
    expect(l.screen).toEqual({ x: 0, y: 0, w: 128, h: 128 });
    expect(l.dpad).toBeNull();
    expect(l.buttons).toBeNull();
    expect(screenFits(l, 128, 128)).toBe(true);
  });

  it("calls a tall viewport portrait and a wide one landscape, with square counting as portrait", () => {
    expect(computeLayout(390, 844).orientation).toBe("portrait");
    expect(computeLayout(844, 390).orientation).toBe("landscape");
    expect(computeLayout(500, 500).orientation).toBe("portrait");
  });

  it("puts the console under the screen in portrait and beside it in landscape", () => {
    const p = computeLayout(390, 844, { touch: true });
    expect(p.chrome.y).toBeGreaterThanOrEqual(p.screen.y + p.screen.h);

    const l = computeLayout(844, 390, { touch: true });
    expect(l.chrome.x + l.chrome.w).toBeLessThanOrEqual(l.screen.x);
  });

  it("gives a modern phone a 2x screen and a full controller", () => {
    const l = computeLayout(390, 844, { touch: true });
    expect(l.scale).toBe(2);
    expect(l.dpad).not.toBeNull();
    expect(l.buttons).not.toBeNull();
  });

  it("never overlaps the cart window with the touch controls", () => {
    // The console may draw over the cart; the controls must not, because a
    // thumb resting on the d-pad would then be resting on the game.
    for (const [w, h] of VIEWPORTS) {
      const l = computeLayout(w, h, { touch: true });
      const parts = [l.dpad, l.buttons?.a, l.buttons?.b, l.buttons?.x, l.buttons?.y];
      for (const r of parts) {
        if (r === null || r === undefined) continue;
        const overlaps =
          r.x < l.screen.x + l.screen.w &&
          r.x + r.w > l.screen.x &&
          r.y < l.screen.y + l.screen.h &&
          r.y + r.h > l.screen.y;
        expect(overlaps, `${w}x${h}`).toBe(false);
      }
    }
  });

  it("keeps the d-pad and the buttons apart", () => {
    for (const [w, h] of VIEWPORTS) {
      const l = computeLayout(w, h, { touch: true });
      if (l.dpad === null || l.buttons === null) continue;
      for (const b of [l.buttons.a, l.buttons.b, l.buttons.x, l.buttons.y]) {
        const overlaps =
          b.x < l.dpad.x + l.dpad.w &&
          b.x + b.w > l.dpad.x &&
          b.y < l.dpad.y + l.dpad.h &&
          b.y + b.h > l.dpad.y;
        expect(overlaps, `${w}x${h}`).toBe(false);
      }
    }
  });

  it("arranges the faces as the spec diagram does: A B over X Y", () => {
    const l = computeLayout(390, 844, { touch: true });
    const b = l.buttons;
    expect(b).not.toBeNull();
    if (b === null) return;
    expect(b.a.y).toBe(b.b.y);
    expect(b.x.y).toBe(b.y.y);
    expect(b.a.y).toBeLessThan(b.x.y);
    expect(b.a.x).toBeLessThan(b.b.x);
    expect(b.x.x).toBeLessThan(b.y.x);
  });

  it("hides the controller when touch is off, at every size", () => {
    for (const [w, h] of VIEWPORTS) {
      const l = computeLayout(w, h, { touch: false });
      expect(l.dpad, `${w}x${h}`).toBeNull();
      expect(l.buttons, `${w}x${h}`).toBeNull();
    }
  });

  it("survives nonsense input rather than emitting NaN", () => {
    for (const [w, h] of [
      [Number.NaN, 100],
      [-50, -50],
      [Number.POSITIVE_INFINITY, 100],
      [100.7, 200.3],
    ] as const) {
      const l = computeLayout(w, h, { touch: true });
      expect(Number.isInteger(l.scale)).toBe(true);
      for (const r of allRects(l)) {
        expect(Number.isFinite(r.x) && Number.isFinite(r.y)).toBe(true);
        expect(Number.isFinite(r.w) && Number.isFinite(r.h)).toBe(true);
      }
    }
  });

  it("grows the scale monotonically as the viewport grows", () => {
    let prev = 0;
    for (let w = 200; w <= 4000; w += 37) {
      const s = computeLayout(w, w, { touch: false }).scale;
      expect(s).toBeGreaterThanOrEqual(prev);
      prev = s;
    }
  });

  it("gives a big desktop a big screen", () => {
    expect(computeLayout(1920, 1080).scale).toBe(8);
    expect(computeLayout(800, 600).scale).toBe(3);
  });
});

describe("hitRect", () => {
  const r: Rect = { x: 10, y: 20, w: 30, h: 40 };

  it("includes the left and top edges and excludes the right and bottom", () => {
    expect(hitRect(r, 10, 20)).toBe(true);
    expect(hitRect(r, 39, 59)).toBe(true);
    expect(hitRect(r, 40, 59)).toBe(false);
    expect(hitRect(r, 39, 60)).toBe(false);
    expect(hitRect(r, 9, 20)).toBe(false);
    expect(hitRect(r, 10, 19)).toBe(false);
  });

  it("misses a zero-sized rect from every direction", () => {
    const z: Rect = { x: 5, y: 5, w: 0, h: 0 };
    expect(hitRect(z, 5, 5)).toBe(false);
  });
});
