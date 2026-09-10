/**
 * Input, proved without a browser.
 *
 * The bit packing and the hit testing are pure, and they are the parts that can
 * be wrong in a way nobody notices for a month: a d-pad whose corners set one
 * bit instead of two feels like the game dropping inputs, and a keyboard that
 * lets pause reach the cart is a specification violation that no cart will ever
 * report. Both are assertions here.
 *
 * The DOM edges -- `addEventListener` and `getBoundingClientRect` -- are the
 * only part not covered, by design: `attach` does nothing except forward to the
 * seams below, so there is very little left in it to be wrong.
 */

import { afterEach, describe, expect, it } from "vitest";

import { BTN, MAX_PLAYERS } from "@sq1/runtime";

import { computeLayout } from "../src/layout";
import type { ShellLayout } from "../src/layout";
import {
  INPUT_BYTES,
  KEYMAP_ARROWS,
  KEYMAP_WASD,
  combineInputs,
  createGamepadInput,
  createKeyboardInput,
  createTouchInput,
  hitControls,
} from "../src/input";
import type { ConsoleEvent, InputSource } from "../src/input";

const M = {
  UP: 1 << BTN.UP,
  DOWN: 1 << BTN.DOWN,
  LEFT: 1 << BTN.LEFT,
  RIGHT: 1 << BTN.RIGHT,
  A: 1 << BTN.A,
  B: 1 << BTN.B,
  X: 1 << BTN.X,
  Y: 1 << BTN.Y,
};

/** A fresh, zeroed input frame -- what the player hands `sample` every frame. */
function frame(): Uint8Array {
  return new Uint8Array(INPUT_BYTES);
}

function sampled(src: InputSource): Uint8Array {
  const out = frame();
  src.sample(out);
  return out;
}

/** A phone-shaped layout that definitely has a controller on it. */
const TOUCH_LAYOUT: ShellLayout = computeLayout(390, 844, { touch: true });

describe("the input frame", () => {
  it("is one byte per player slot, and the console has four", () => {
    expect(INPUT_BYTES).toBe(MAX_PLAYERS);
    expect(INPUT_BYTES).toBe(4);
  });

  it("packs all eight buttons into one byte with no bit left over", () => {
    const bits = Object.values(BTN);
    expect(new Set(bits).size).toBe(8);
    expect(Math.max(...bits)).toBe(7);
  });
});

describe("keyboard", () => {
  it("maps the arrows and the ZXAS cluster", () => {
    const kb = createKeyboardInput();
    const cases: [string, number][] = [
      ["ArrowUp", M.UP],
      ["ArrowDown", M.DOWN],
      ["ArrowLeft", M.LEFT],
      ["ArrowRight", M.RIGHT],
      ["KeyZ", M.A],
      ["KeyX", M.B],
      ["KeyA", M.X],
      ["KeyS", M.Y],
    ];
    for (const [code, mask] of cases) {
      kb.key(code, true);
      expect(sampled(kb)[0], code).toBe(mask);
      kb.key(code, false);
      expect(sampled(kb)[0], `${code} released`).toBe(0);
    }
  });

  it("holds several keys at once", () => {
    const kb = createKeyboardInput();
    kb.key("ArrowLeft", true);
    kb.key("ArrowUp", true);
    kb.key("KeyZ", true);
    expect(sampled(kb)[0]).toBe(M.LEFT | M.UP | M.A);
    kb.key("ArrowUp", false);
    expect(sampled(kb)[0]).toBe(M.LEFT | M.A);
  });

  it("ignores keys it does not know", () => {
    const kb = createKeyboardInput();
    kb.key("KeyQ", true);
    kb.key("F13", true);
    expect(sampled(kb)[0]).toBe(0);
  });

  it("keeps the WASD scheme free of the ZXAS collision", () => {
    // KeyA and KeyS are the d-pad in one scheme and face buttons in the other.
    // If the two maps were merged, one key press would set two unrelated bits.
    expect(KEYMAP_ARROWS["KeyA"]).toBe(M.X);
    expect(KEYMAP_WASD["KeyA"]).toBe(M.LEFT);
    expect(KEYMAP_ARROWS["KeyS"]).toBe(M.Y);
    expect(KEYMAP_WASD["KeyS"]).toBe(M.DOWN);
    // The schemes disagree on those two keys, which is exactly why they are two
    // maps. Inside either one, no key may ever set more than a single bit: a key
    // that sets two is indistinguishable to a cart from a player doing two
    // things, and that is the bug merging the maps would have produced.
    for (const map of [KEYMAP_ARROWS, KEYMAP_WASD]) {
      for (const code of Object.keys(map)) {
        const mask = map[code] as number;
        expect(mask & (mask - 1), `${code} sets more than one bit`).toBe(0);
        expect(mask, code).toBeGreaterThan(0);
      }
    }
  });

  it("drives the d-pad from WASD when asked", () => {
    const kb = createKeyboardInput({ wasd: true });
    kb.key("KeyW", true);
    kb.key("KeyD", true);
    expect(sampled(kb)[0]).toBe(M.UP | M.RIGHT);
    kb.key("KeyJ", true);
    expect(sampled(kb)[0]).toBe(M.UP | M.RIGHT | M.A);
  });

  it("can drive a player slot other than the first", () => {
    const kb = createKeyboardInput({ player: 2 });
    kb.key("ArrowUp", true);
    const out = sampled(kb);
    expect(out[0]).toBe(0);
    expect(out[2]).toBe(M.UP);
  });

  it("clamps an out-of-range slot instead of writing past the frame", () => {
    const kb = createKeyboardInput({ player: 99 });
    kb.key("ArrowUp", true);
    expect(sampled(kb)[MAX_PLAYERS - 1]).toBe(M.UP);
  });

  it("forgets everything on releaseAll, so an alt-tabbed key does not stick", () => {
    const kb = createKeyboardInput();
    kb.key("ArrowLeft", true);
    kb.key("KeyZ", true);
    kb.releaseAll();
    expect(sampled(kb)[0]).toBe(0);
  });

  // --- pause is a console function, not a button ---------------------------

  it("raises pause as a console event and NEVER as a button bit", () => {
    const kb = createKeyboardInput();
    const seen: ConsoleEvent[] = [];
    kb.onConsole((e) => seen.push(e));
    for (const code of ["Escape", "KeyP", "Enter"]) {
      kb.key(code, true);
      kb.key(code, false);
    }
    expect(seen).toEqual(["pause", "pause", "pause"]);
    // The whole frame, every slot: nothing about pause reached the cart.
    expect(Array.from(sampled(kb))).toEqual([0, 0, 0, 0]);
  });

  it("fires pause on press only, not on release", () => {
    const kb = createKeyboardInput();
    let n = 0;
    kb.onConsole(() => n++);
    kb.key("Escape", true);
    expect(n).toBe(1);
    kb.key("Escape", false);
    expect(n).toBe(1);
  });
});

describe("sample ORs and never clears", () => {
  it("leaves bits another source already set", () => {
    const kb = createKeyboardInput();
    kb.key("ArrowUp", true);
    const out = frame();
    out[0] = M.B;
    kb.sample(out);
    expect(out[0]).toBe(M.B | M.UP);
  });

  it("does not touch slots it has nothing to say about", () => {
    const kb = createKeyboardInput();
    kb.key("ArrowUp", true);
    const out = frame();
    out[1] = 0xff;
    kb.sample(out);
    expect(out[1]).toBe(0xff);
  });
});

describe("combineInputs", () => {
  it("unions every source", () => {
    const a = createKeyboardInput();
    const b = createKeyboardInput({ wasd: true });
    a.key("ArrowUp", true);
    b.key("KeyJ", true);
    const both = combineInputs([a, b]);
    expect(sampled(both)[0]).toBe(M.UP | M.A);
  });

  it("forwards console events from every source that has them", () => {
    const a = createKeyboardInput();
    const b = createKeyboardInput();
    const both = combineInputs([a, b]);
    const seen: ConsoleEvent[] = [];
    both.onConsole((e) => seen.push(e));
    a.key("Escape", true);
    b.key("KeyP", true);
    expect(seen).toEqual(["pause", "pause"]);
  });

  it("nests, because an inner combiner does not clear the frame", () => {
    const a = createKeyboardInput();
    const b = createKeyboardInput();
    const c = createKeyboardInput();
    a.key("ArrowUp", true);
    b.key("ArrowDown", true);
    c.key("ArrowLeft", true);
    const nested = combineInputs([combineInputs([a, b]), c]);
    expect(sampled(nested)[0]).toBe(M.UP | M.DOWN | M.LEFT);
  });

  it("copies the source list, so a later push cannot smuggle a source in", () => {
    const a = createKeyboardInput();
    const list: InputSource[] = [a];
    const combined = combineInputs(list);
    const b = createKeyboardInput();
    b.key("ArrowUp", true);
    list.push(b);
    expect(sampled(combined)[0]).toBe(0);
  });

  it("is safe with no sources at all", () => {
    expect(Array.from(sampled(combineInputs([])))).toEqual([0, 0, 0, 0]);
  });
});

describe("hitControls", () => {
  const dpad = { x: 0, y: 0, w: 150, h: 150 };
  const buttons = {
    a: { x: 200, y: 0, w: 50, h: 50 },
    b: { x: 260, y: 0, w: 50, h: 50 },
    x: { x: 200, y: 60, w: 50, h: 50 },
    y: { x: 260, y: 60, w: 50, h: 50 },
  };

  it("reads the d-pad as a 3x3 grid", () => {
    expect(hitControls(dpad, null, 75, 25)).toBe(M.UP);
    expect(hitControls(dpad, null, 75, 125)).toBe(M.DOWN);
    expect(hitControls(dpad, null, 25, 75)).toBe(M.LEFT);
    expect(hitControls(dpad, null, 125, 75)).toBe(M.RIGHT);
  });

  it("gives the corners BOTH bits, because diagonals are how games are played", () => {
    expect(hitControls(dpad, null, 25, 25)).toBe(M.UP | M.LEFT);
    expect(hitControls(dpad, null, 125, 25)).toBe(M.UP | M.RIGHT);
    expect(hitControls(dpad, null, 25, 125)).toBe(M.DOWN | M.LEFT);
    expect(hitControls(dpad, null, 125, 125)).toBe(M.DOWN | M.RIGHT);
  });

  it("leaves the centre cell dead: it is the rest position", () => {
    expect(hitControls(dpad, null, 75, 75)).toBe(0);
  });

  it("stays inside the rect at its far edge rather than reading a fourth column", () => {
    expect(hitControls(dpad, null, 149, 149)).toBe(M.DOWN | M.RIGHT);
    expect(hitControls(dpad, null, 150, 149)).toBe(0);
  });

  it("maps each face button to its own bit", () => {
    expect(hitControls(null, buttons, 210, 10)).toBe(M.A);
    expect(hitControls(null, buttons, 270, 10)).toBe(M.B);
    expect(hitControls(null, buttons, 210, 70)).toBe(M.X);
    expect(hitControls(null, buttons, 270, 70)).toBe(M.Y);
  });

  it("returns nothing for the bezel between controls", () => {
    expect(hitControls(dpad, buttons, 175, 30)).toBe(0);
  });

  it("returns nothing when there are no controls", () => {
    expect(hitControls(null, null, 10, 10)).toBe(0);
  });
});

describe("touch", () => {
  const dpad = TOUCH_LAYOUT.dpad;
  const buttons = TOUCH_LAYOUT.buttons;

  function mid(r: { x: number; y: number; w: number; h: number }): [number, number] {
    return [r.x + r.w / 2, r.y + r.h / 2];
  }
  /** A point in the d-pad's left cell. */
  function leftCell(): [number, number] {
    const d = dpad as NonNullable<typeof dpad>;
    return [d.x + d.w / 6, d.y + d.h / 2];
  }

  it("has a controller to test against", () => {
    expect(dpad).not.toBeNull();
    expect(buttons).not.toBeNull();
  });

  it("holds LEFT and A at the same time, from two fingers", () => {
    const t = createTouchInput(TOUCH_LAYOUT);
    const [lx, ly] = leftCell();
    const [ax, ay] = mid((buttons as NonNullable<typeof buttons>).a);
    t.pointerDown(1, lx, ly);
    t.pointerDown(2, ax, ay);
    expect(t.held).toBe(2);
    expect(sampled(t)[0]).toBe(M.LEFT | M.A);
  });

  it("releases one finger without releasing the other", () => {
    const t = createTouchInput(TOUCH_LAYOUT);
    const [lx, ly] = leftCell();
    const [ax, ay] = mid((buttons as NonNullable<typeof buttons>).a);
    t.pointerDown(1, lx, ly);
    t.pointerDown(2, ax, ay);
    t.pointerUp(2);
    expect(t.held).toBe(1);
    expect(sampled(t)[0]).toBe(M.LEFT);
    t.pointerUp(1);
    expect(t.held).toBe(0);
    expect(sampled(t)[0]).toBe(0);
  });

  it("follows a thumb sliding from LEFT into UP-LEFT", () => {
    const t = createTouchInput(TOUCH_LAYOUT);
    const d = dpad as NonNullable<typeof dpad>;
    t.pointerDown(7, d.x + d.w / 6, d.y + d.h / 2);
    expect(sampled(t)[0]).toBe(M.LEFT);
    t.pointerMove(7, d.x + d.w / 6, d.y + d.h / 6);
    expect(sampled(t)[0]).toBe(M.UP | M.LEFT);
  });

  it("goes quiet when a thumb slides off the controller, rather than sticking", () => {
    const t = createTouchInput(TOUCH_LAYOUT);
    const [lx, ly] = leftCell();
    t.pointerDown(3, lx, ly);
    t.pointerMove(3, -500, -500);
    expect(sampled(t)[0]).toBe(0);
  });

  it("ignores a touch that started on the bezel, and does not track it", () => {
    const t = createTouchInput(TOUCH_LAYOUT);
    t.pointerDown(9, 0, 0);
    expect(t.held).toBe(0);
    t.pointerMove(9, ...leftCell());
    expect(sampled(t)[0]).toBe(0);
  });

  it("ignores an unknown pointer id on move and on up", () => {
    const t = createTouchInput(TOUCH_LAYOUT);
    t.pointerMove(404, ...leftCell());
    t.pointerUp(404);
    expect(t.held).toBe(0);
  });

  it("tracks a hand's worth of fingers and drops the palm", () => {
    const t = createTouchInput(TOUCH_LAYOUT);
    const [lx, ly] = leftCell();
    for (let i = 0; i < 20; i++) t.pointerDown(i, lx, ly);
    expect(t.held).toBe(10);
    expect(sampled(t)[0]).toBe(M.LEFT);
  });

  it("lets every finger go when the layout changes under them", () => {
    const t = createTouchInput(TOUCH_LAYOUT);
    t.pointerDown(1, ...leftCell());
    expect(t.held).toBe(1);
    t.setLayout(computeLayout(844, 390, { touch: true }));
    expect(t.held).toBe(0);
    expect(sampled(t)[0]).toBe(0);
  });

  it("hit-tests against the new layout after a rotation", () => {
    const land = computeLayout(844, 390, { touch: true });
    const t = createTouchInput(TOUCH_LAYOUT);
    t.setLayout(land);
    const d = land.dpad as NonNullable<typeof land.dpad>;
    t.pointerDown(1, d.x + d.w / 6, d.y + d.h / 2);
    expect(sampled(t)[0]).toBe(M.LEFT);
  });

  it("is silent on a layout with no controller", () => {
    const t = createTouchInput(computeLayout(128, 128, { touch: true }));
    t.pointerDown(1, 10, 10);
    expect(t.held).toBe(0);
    expect(sampled(t)[0]).toBe(0);
  });

  it("can drive a player slot other than the first", () => {
    const t = createTouchInput(TOUCH_LAYOUT, { player: 1 });
    t.pointerDown(1, ...leftCell());
    const out = sampled(t);
    expect(out[0]).toBe(0);
    expect(out[1]).toBe(M.LEFT);
  });

  it("never produces a pause: the pause control is a real button, not a rect", () => {
    const t = createTouchInput(TOUCH_LAYOUT);
    const p = TOUCH_LAYOUT.pause;
    t.pointerDown(1, p.x + p.w / 2, p.y + p.h / 2);
    expect(t.held).toBe(0);
    expect(Array.from(sampled(t))).toEqual([0, 0, 0, 0]);
  });
});

// ---------------------------------------------------------------------------
// Gamepad. Stubbed, because there is no pad plugged into CI.
// ---------------------------------------------------------------------------

interface FakeButton {
  pressed: boolean;
}

function pad(pressed: number[], axes: number[] = [0, 0], mapping = "standard"): unknown {
  const buttons: FakeButton[] = [];
  for (let i = 0; i < 17; i++) buttons.push({ pressed: pressed.includes(i) });
  return { connected: true, mapping, buttons, axes };
}

const realNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");

function stubPads(pads: unknown[]): void {
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { getGamepads: () => pads },
  });
}

afterEach(() => {
  if (realNavigator === undefined) {
    Reflect.deleteProperty(globalThis, "navigator");
  } else {
    Object.defineProperty(globalThis, "navigator", realNavigator);
  }
});

describe("gamepad", () => {
  it("does nothing at all when there is no Gamepad API", () => {
    Reflect.deleteProperty(globalThis, "navigator");
    const gp = createGamepadInput();
    expect(Array.from(sampled(gp))).toEqual([0, 0, 0, 0]);
  });

  it("reads the standard mapping's four faces and d-pad", () => {
    stubPads([pad([0, 1, 2, 3, 12, 13, 14, 15])]);
    const gp = createGamepadInput();
    expect(sampled(gp)[0]).toBe(M.A | M.B | M.X | M.Y | M.UP | M.DOWN | M.LEFT | M.RIGHT);
  });

  it("reads the left stick past the deadzone and ignores it inside", () => {
    stubPads([pad([], [-1, 0])]);
    expect(sampled(createGamepadInput())[0]).toBe(M.LEFT);
    stubPads([pad([], [0, 1])]);
    expect(sampled(createGamepadInput())[0]).toBe(M.DOWN);
    stubPads([pad([], [0.3, -0.3])]);
    expect(sampled(createGamepadInput())[0]).toBe(0);
  });

  it("gives pad i player slot i, and stops at four", () => {
    stubPads([pad([0]), pad([1]), pad([2]), pad([3]), pad([0])]);
    const out = sampled(createGamepadInput());
    expect(Array.from(out)).toEqual([M.A, M.B, M.X, M.Y]);
  });

  it("skips a pad that is not standard rather than guessing its buttons", () => {
    stubPads([pad([0], [0, 0], "")]);
    expect(sampled(createGamepadInput())[0]).toBe(0);
  });

  it("skips an empty slot", () => {
    stubPads([null, pad([0])]);
    const out = sampled(createGamepadInput());
    expect(out[0]).toBe(0);
    expect(out[1]).toBe(M.A);
  });

  it("raises Start as pause, on the edge, and never as a button bit", () => {
    let pressed = false;
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { getGamepads: () => [pad(pressed ? [9] : [])] },
    });
    const gp = createGamepadInput();
    const seen: ConsoleEvent[] = [];
    gp.onConsole((e) => seen.push(e));

    expect(Array.from(sampled(gp))).toEqual([0, 0, 0, 0]);
    pressed = true;
    expect(Array.from(sampled(gp))).toEqual([0, 0, 0, 0]);
    expect(seen).toEqual(["pause"]);
    // Held, not re-pressed: one event, not sixty a second.
    expect(Array.from(sampled(gp))).toEqual([0, 0, 0, 0]);
    expect(seen).toEqual(["pause"]);
    pressed = false;
    sampled(gp);
    pressed = true;
    sampled(gp);
    expect(seen).toEqual(["pause", "pause"]);
  });
});
