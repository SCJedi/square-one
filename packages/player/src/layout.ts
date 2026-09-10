/**
 * Where the console's parts go, as pure arithmetic.
 *
 * THE SCREEN SHAPE IS WHAT MAKES THE DEVICE SHAPE POSSIBLE. A 128 x 128 window
 * on a phone held in portrait occupies the top of the display and leaves a
 * rectangle underneath. That leftover is not waste to be filled with letterbox
 * black -- it is exactly where a console goes: bezel, cart title, player lights,
 * pause, and a d-pad your thumb can actually reach. Rotate to landscape and the
 * same leftover becomes a rail beside the screen. One square, two devices.
 *
 * NO DOM IN THIS FILE, ON PURPOSE. Everything below is numbers in, numbers out.
 * That is what lets the awkward viewports -- a 320 x 480 phone, a 100 x 2000
 * sliver, exactly 128 x 128 -- be asserted in a Node test rather than eyeballed
 * in a browser, and it is why a layout regression is a failing test instead of a
 * bug report with a screenshot attached.
 *
 * =========================================================================
 * INTEGER SCALE IS NOT A PREFERENCE
 * =========================================================================
 * A 128-pixel image drawn at 2.7x gives some source pixels three destination
 * pixels and others two. The eye reads that as a texture crawling over the
 * image whenever anything moves, and no amount of filtering fixes it, because
 * the error is in the sampling grid rather than in the interpolation. So the
 * scale is the largest whole number that fits, floored at 1, and the space that
 * does not divide evenly is given to the shell instead. A slightly smaller
 * screen inside a real console reads as deliberate; a slightly larger screen
 * with uneven pixels reads as broken.
 *
 * THE 44-PIXEL FLOOR. Touch targets are never smaller than 44 CSS px in either
 * direction -- the accessibility floor for an adult thumb, and the number both
 * Apple and Google converged on independently. A layout that cannot afford 44px
 * controls does not shrink them; it reports `dpad: null` and `buttons: null`,
 * and the shell draws no touch controls at all. Controls too small to hit are
 * worse than no controls, because they also cover the screen.
 *
 * DEGRADATION IS A LADDER, NOT A FORMULA. `BUDGETS` below lists the furniture
 * from generous to austere, and the first rung whose leftovers still admit a 1x
 * screen wins. That beats solving for the padding algebraically: each rung is a
 * design someone can look at, and the order states plainly what gets sacrificed
 * first (padding, then the touch controls, then the information bar).
 *
 * ONE VIEWPORT CANNOT BE SATISFIED. Below 128 CSS px in either direction there
 * is no integer scale that both fits and is at least 1. The scale stays 1 and
 * the screen overflows, because the alternative -- a fractional scale -- breaks
 * the thing the console is for. `screenFits` states the property honestly, and
 * the shell clips.
 */

/** The cart window, in cart pixels. Square, and not negotiable. */
export const SCREEN_SIZE = 128;

/** The smallest touch target this shell will ever emit, in CSS pixels. */
export const MIN_TOUCH = 44;

/** Gap between the four face buttons, in CSS pixels. */
const BUTTON_GAP = 10;

/** A d-pad is three cells across, so this is its smallest usable side. */
const MIN_DPAD = MIN_TOUCH * 3;

/** Two buttons plus the gap between them. */
const MIN_BUTTONS = MIN_TOUCH * 2 + BUTTON_GAP;

/** Inset of furniture from the edge of the panel that holds it. */
const INSET = 12;

/**
 * Height the landscape rail reserves for the wordmark, cart title and player
 * lights before anything else is placed under them.
 *
 * A number rather than a measurement because this file has no DOM to measure
 * with -- and that is the trade being made deliberately: the layout is testable
 * precisely because it never asks the browser anything. The shell's own sheet
 * fixes those three lines at 10px, 14px and 8px, so 64 is the block plus its
 * gaps with room to spare, and the panel is `overflow: hidden` if a translation
 * ever makes a title taller than expected.
 */
const INFO_H = 64;

export type Orientation = "portrait" | "landscape";

/** An axis-aligned box in CSS pixels, relative to the player's mount element. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The four face buttons, named as the spec's diagram arranges them: A B over X Y. */
export interface ButtonRects {
  a: Rect;
  b: Rect;
  x: Rect;
  y: Rect;
}

export interface ShellLayout {
  orientation: Orientation;
  /** Always a whole number, always at least 1. */
  scale: number;
  /** The 128 x 128 cart window. `w` and `h` are exactly `SCREEN_SIZE * scale`. */
  screen: Rect;
  /**
   * The information panel: cart title, player lights, pause. In portrait it is
   * the bar directly under the screen; in landscape it is the rail beside it.
   * Height or width may be 0 on a viewport with nothing to spare.
   */
  chrome: Rect;
  /** The virtual d-pad, or null when touch controls are off or will not fit. */
  dpad: Rect | null;
  /** The four face buttons, or null on the same terms as `dpad`. */
  buttons: ButtonRects | null;
  /** The pause button. Always present: pause is a console function, not a cart one. */
  pause: Rect;
}

export interface LayoutOptions {
  /** Draw the virtual controller. The caller decides; this file has no DOM to ask. */
  touch?: boolean;
}

/** One rung of the degradation ladder. */
interface Budget {
  /** Outer padding around everything. */
  readonly pad: number;
  /** Portrait: height of the information bar. Landscape: width of the rail. */
  readonly panel: number;
  /**
   * Portrait: height of the touch-control band across the bottom.
   * Landscape: width of the face-button rail on the right. 0 means no controls.
   */
  readonly ctrl: number;
}

const PORTRAIT_BUDGETS: readonly Budget[] = [
  { pad: 12, panel: 52, ctrl: 190 },
  { pad: 10, panel: 46, ctrl: 160 },
  { pad: 8, panel: 44, ctrl: 140 },
  { pad: 6, panel: 40, ctrl: 0 },
  { pad: 4, panel: 32, ctrl: 0 },
  { pad: 0, panel: 0, ctrl: 0 },
];

const LANDSCAPE_BUDGETS: readonly Budget[] = [
  { pad: 16, panel: 260, ctrl: 200 },
  { pad: 12, panel: 200, ctrl: 168 },
  { pad: 10, panel: 168, ctrl: 140 },
  { pad: 8, panel: 150, ctrl: 0 },
  { pad: 6, panel: 110, ctrl: 0 },
  { pad: 4, panel: 72, ctrl: 0 },
  { pad: 0, panel: 0, ctrl: 0 },
];

function clampNonNegative(n: number): number {
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function rect(x: number, y: number, w: number, h: number): Rect {
  return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
}

/**
 * Does the whole 128 x 128 window sit inside the viewport?
 *
 * False only when the viewport is itself smaller than 128 CSS px, where no
 * integer scale can help. Exported so a caller can decide to scroll or clip
 * rather than discover the overflow visually.
 */
export function screenFits(l: ShellLayout, viewportW: number, viewportH: number): boolean {
  return (
    l.screen.x >= 0 &&
    l.screen.y >= 0 &&
    l.screen.x + l.screen.w <= viewportW &&
    l.screen.y + l.screen.h <= viewportH
  );
}

/**
 * Split a square control area into a d-pad, or report that it will not fit.
 *
 * The d-pad rect is the whole cross: the shell divides it into a 3 x 3 grid and
 * lights the four edge cells. Hit testing does the same division (see
 * `input.ts`), so the two agree by both deriving from this one rect.
 */
function dpadIn(area: Rect): Rect | null {
  const side = Math.min(area.w, area.h);
  if (side < MIN_DPAD) return null;
  return rect(area.x + (area.w - side) / 2, area.y + (area.h - side) / 2, side, side);
}

/** Split a square control area into four face buttons, or report that it will not fit. */
function buttonsIn(area: Rect): ButtonRects | null {
  const side = Math.min(area.w, area.h);
  if (side < MIN_BUTTONS) return null;
  const cell = Math.floor((side - BUTTON_GAP) / 2);
  if (cell < MIN_TOUCH) return null;
  const grid = cell * 2 + BUTTON_GAP;
  const gx = area.x + (area.w - grid) / 2;
  const gy = area.y + (area.h - grid) / 2;
  const far = cell + BUTTON_GAP;
  return {
    a: rect(gx, gy, cell, cell),
    b: rect(gx + far, gy, cell, cell),
    x: rect(gx, gy + far, cell, cell),
    y: rect(gx + far, gy + far, cell, cell),
  };
}

/**
 * The pause button when there is no panel to put it in.
 *
 * It ends up over the top-right corner of the cart window, which is allowed and
 * is the direction that matters: the console may draw over the cart, and the
 * cart can never draw over the console. A player on a 128 x 128 viewport can
 * still pause, which is the requirement.
 */
function orphanPause(vw: number, vh: number): Rect {
  const side = Math.max(1, Math.min(MIN_TOUCH, vw, vh));
  return rect(Math.max(0, vw - side), 0, side, side);
}

/**
 * Lay the console out for a viewport.
 *
 * @param viewportW available width in CSS pixels
 * @param viewportH available height in CSS pixels
 * @param opts `touch` asks for the virtual controller; it may still be refused
 *   when the leftover space cannot hold 44px targets.
 */
export function computeLayout(
  viewportW: number,
  viewportH: number,
  opts?: LayoutOptions,
): ShellLayout {
  const vw = clampNonNegative(viewportW);
  const vh = clampNonNegative(viewportH);
  const touch = opts?.touch ?? false;
  const orientation: Orientation = vh >= vw ? "portrait" : "landscape";
  return orientation === "portrait" ? portrait(vw, vh, touch) : landscape(vw, vh, touch);
}

/**
 * Pick the richest budget whose leftovers still admit a 1x screen.
 *
 * Returns the chosen budget and the scale it affords. When no rung fits, the
 * last (bare) rung is used at scale 1 and the screen overflows -- see the file
 * header on viewports below 128px.
 */
function choose(
  budgets: readonly Budget[],
  touch: boolean,
  avail: (b: Budget) => { w: number; h: number },
): { budget: Budget; scale: number } {
  let last: Budget = budgets[budgets.length - 1] as Budget;
  for (const raw of budgets) {
    const b: Budget = touch ? raw : { pad: raw.pad, panel: raw.panel, ctrl: 0 };
    last = b;
    const { w, h } = avail(b);
    const s = Math.min(Math.floor(w / SCREEN_SIZE), Math.floor(h / SCREEN_SIZE));
    if (s >= 1) return { budget: b, scale: s };
  }
  return { budget: last, scale: 1 };
}

/**
 * Portrait: the square on top, the console underneath.
 *
 * Vertical order is screen, information bar, then -- pinned to the very bottom
 * edge, where thumbs are -- the control band. The slack goes between the bar and
 * the controls rather than under the screen, because a d-pad floating in the
 * middle of a tall phone is a d-pad nobody can reach.
 */
function portrait(vw: number, vh: number, touch: boolean): ShellLayout {
  const { budget, scale } = choose(PORTRAIT_BUDGETS, touch, (b) => ({
    w: vw - 2 * b.pad,
    h: vh - 2 * b.pad - b.panel - b.ctrl,
  }));

  const side = SCREEN_SIZE * scale;
  const pad = budget.pad;

  // The band across the bottom, if any, and then the region left above it.
  const ctrlH = budget.ctrl;
  const upperH = Math.max(0, ctrlH > 0 ? vh - pad - ctrlH : vh);

  // Screen plus bar, centred in the upper region but never above the padding.
  const blockH = side + pad + budget.panel;
  const screenY = Math.max(pad, Math.floor((upperH - blockH) / 2));
  const screenX = Math.max(0, Math.floor((vw - side) / 2));
  const screen = rect(screenX, screenY, side, side);

  const chromeY = screenY + side + pad;
  const chromeH = Math.max(0, Math.min(budget.panel, vh - chromeY));
  const chrome = rect(pad, chromeY, Math.max(0, vw - 2 * pad), chromeH);

  const pause =
    chrome.h >= MIN_TOUCH && chrome.w >= MIN_TOUCH
      ? rect(chrome.x + chrome.w - chrome.h, chrome.y, chrome.h, chrome.h)
      : orphanPause(vw, vh);

  let dpad: Rect | null = null;
  let buttons: ButtonRects | null = null;
  if (ctrlH > 0) {
    const bandY = vh - pad - ctrlH;
    const bandW = Math.max(0, vw - 2 * pad);
    // Split the band in half: d-pad on the left thumb, faces on the right.
    const half = Math.floor((bandW - INSET) / 2);
    dpad = dpadIn(rect(pad, bandY, half, ctrlH));
    buttons = buttonsIn(rect(pad + half + INSET, bandY, half, ctrlH));
    // All or nothing. Half a controller is a controller that lies about itself.
    if (dpad === null || buttons === null) {
      dpad = null;
      buttons = null;
    }
  }

  return { orientation: "portrait", scale, screen, chrome, dpad, buttons, pause };
}

/**
 * Landscape: an information rail on the left, the square beside it, face
 * buttons on the far right when the controller is showing.
 *
 * The d-pad lives at the bottom of the left rail rather than in a band of its
 * own, because in landscape the hands are at the two ends of the device and the
 * middle is where the screen has to be.
 */
function landscape(vw: number, vh: number, touch: boolean): ShellLayout {
  const { budget, scale } = choose(LANDSCAPE_BUDGETS, touch, (b) => ({
    w: vw - 2 * b.pad - b.panel - b.ctrl,
    h: vh - 2 * b.pad,
  }));

  const side = SCREEN_SIZE * scale;
  const pad = budget.pad;
  const railW = Math.max(0, Math.min(budget.panel, vw - 2 * pad));
  const rightW = budget.ctrl;

  const innerX = pad + railW;
  const innerW = Math.max(0, vw - 2 * pad - railW - rightW);
  const screenX = Math.max(0, innerX + Math.floor((innerW - side) / 2));
  const screenY = Math.max(0, Math.floor((vh - side) / 2));
  const screen = rect(screenX, screenY, side, side);

  const chrome = rect(pad, pad, railW, Math.max(0, vh - 2 * pad));

  let dpad: Rect | null = null;
  let buttons: ButtonRects | null = null;
  if (rightW > 0) {
    const dpadArea = rect(
      chrome.x + INSET,
      chrome.y + chrome.h - INSET - Math.min(chrome.h, chrome.w - 2 * INSET),
      Math.max(0, chrome.w - 2 * INSET),
      Math.min(chrome.h, Math.max(0, chrome.w - 2 * INSET)),
    );
    dpad = dpadIn(dpadArea);
    const btnSide = Math.min(rightW - INSET, vh - 2 * pad);
    buttons = buttonsIn(rect(vw - pad - rightW, vh - pad - btnSide - INSET, rightW, btnSide));
    if (dpad === null || buttons === null) {
      dpad = null;
      buttons = null;
    }
  }

  // Pause sits in the rail: directly under the information block when the rail
  // holds nothing else, and immediately above the d-pad when it does -- next to
  // the thumb that is already there rather than at the far end of the device.
  let pause: Rect;
  if (chrome.w >= MIN_TOUCH + 2 * INSET && chrome.h >= MIN_TOUCH + 2 * INSET) {
    const pSide = Math.max(MIN_TOUCH, Math.min(52, chrome.w - 2 * INSET));
    const want = dpad === null ? chrome.y + INSET + INFO_H : dpad.y - INSET - pSide;
    const py = Math.min(
      Math.max(chrome.y + INSET, want),
      chrome.y + chrome.h - INSET - pSide,
    );
    pause = rect(chrome.x + INSET, py, pSide, pSide);
  } else {
    pause = orphanPause(vw, vh);
  }

  return { orientation: "landscape", scale, screen, chrome, dpad, buttons, pause };
}

/** Is `(px, py)` inside `r`? Edges on the left/top are inside, right/bottom are not. */
export function hitRect(r: Rect, px: number, py: number): boolean {
  return px >= r.x && px < r.x + r.w && py >= r.y && py < r.y + r.h;
}
