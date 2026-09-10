/**
 * Every way a human reaches the machine, reduced to four bytes.
 *
 * The console's whole input surface is eight bits per player slot and four
 * slots, which is one `Uint8Array(4)` per frame. Keyboard, gamepad and the
 * shell's virtual controller are three ways of filling in the same four bytes,
 * so they are three implementations of one interface and the player does not
 * know which of them is plugged in.
 *
 * =========================================================================
 * `sample` ORs. IT DOES NOT OVERWRITE.
 * =========================================================================
 * Every source ORs its own contribution into `out` and the CALLER zeroes `out`
 * first. That one decision is what makes `combineInputs` a loop with no scratch
 * buffer and no allocation, and it is what lets combined sources nest without
 * an inner combiner silently erasing an outer one's work. A player holding the
 * d-pad on a gamepad while stabbing A on the touch panel is one player pressing
 * two things, and the union is the honest answer.
 *
 * ZERO ALLOCATION PER FRAME. `sample` runs sixty times a second forever, so
 * nothing in it may allocate: no closures, no iterators, no temporary arrays.
 * The touch source therefore keeps its live pointers in two preallocated
 * parallel arrays and scans them linearly rather than in a `Map`, because
 * `map.values()` mints an iterator object on every call and sixty of those a
 * second is a garbage collection during someone's boss fight. The ONE
 * unavoidable exception is `navigator.getGamepads()`, which the Gamepad API
 * specifies as returning a fresh array; there is no allocation-free way to poll
 * a gamepad from JavaScript, and it is noted here so nobody later mistakes it
 * for an oversight.
 *
 * =========================================================================
 * PAUSE IS NOT ONE OF THE EIGHT BITS
 * =========================================================================
 * The spec is explicit: pause, menu and reset are console functions, and a cart
 * MUST NOT be able to observe or suppress them. So they never touch `out`. They
 * arrive through `onConsole`, which the player wires to its own pause handling
 * and which the cart has no way to read, because nothing the cart can see ever
 * carries them. That is also why the shell's pause control is a real `<button>`
 * rather than a rect this file hit-tests: the console's own DOM handles it, and
 * cart input and console input never travel the same path.
 *
 * MULTI-TOUCH IS THE NORMAL CASE. Holding left while pressing A is how every
 * action game is played, and a handler that tracks one touch breaks all of them.
 * Each pointer id owns its own bitmask; the sample is the union. Up to
 * `MAX_POINTERS` fingers are tracked, which is more than a pair of thumbs and a
 * palm resting on the glass.
 */

import { BTN, MAX_PLAYERS } from "@sq1/runtime";

import type { ButtonRects, Rect, ShellLayout } from "./layout";
import { hitRect } from "./layout";

/** Bytes in one input frame: one per player slot. */
export const INPUT_BYTES = MAX_PLAYERS;

/** How many simultaneous touches the virtual controller tracks. */
const MAX_POINTERS = 10;

/** Stick deflection past which an analogue axis counts as a d-pad press. */
const STICK_DEADZONE = 0.5;

const M_UP = 1 << BTN.UP;
const M_DOWN = 1 << BTN.DOWN;
const M_LEFT = 1 << BTN.LEFT;
const M_RIGHT = 1 << BTN.RIGHT;
const M_A = 1 << BTN.A;
const M_B = 1 << BTN.B;
const M_X = 1 << BTN.X;
const M_Y = 1 << BTN.Y;

/**
 * Console-level events. Deliberately a closed set of strings: it is the whole
 * vocabulary of things the console does that the cart may not know about.
 */
export type ConsoleEvent = "pause" | "reset" | "menu";

export type ConsoleListener = (e: ConsoleEvent) => void;

/**
 * Anything that can fill in an input frame.
 *
 * `attach` is given whatever element or window the events should come from;
 * a source with nothing to listen to (the gamepad) ignores it.
 */
export interface InputSource {
  /** OR this source's current state into `out`. Never clears it. Never allocates. */
  sample(out: Uint8Array): void;
  attach(target: EventTarget): void;
  detach(): void;
}

/** A source that can also raise console events the cart cannot see. */
export interface ConsoleInputSource extends InputSource {
  onConsole(cb: ConsoleListener): void;
}

// ---------------------------------------------------------------------------
// Keyboard
// ---------------------------------------------------------------------------

/**
 * `KeyboardEvent.code` -> button mask, for player slot 0.
 *
 * Keyed on `code` and not on `key`, so the bindings are positions on the board
 * rather than letters: a French AZERTY player's Z key is where a US player's W
 * key is, and `code` gives both of them the same physical control. `key` would
 * hand one of them a d-pad and the other nonsense.
 */
export const KEYMAP_ARROWS: Readonly<Record<string, number>> = Object.freeze({
  ArrowUp: M_UP,
  ArrowDown: M_DOWN,
  ArrowLeft: M_LEFT,
  ArrowRight: M_RIGHT,
  KeyZ: M_A,
  KeyX: M_B,
  KeyA: M_X,
  KeyS: M_Y,
});

/**
 * The WASD alternative, and why it is a separate map rather than extra entries
 * in the one above.
 *
 * `KeyA` and `KeyS` are the d-pad's left and down in WASD, and the X and Y face
 * buttons in the ZXAS cluster. Merging the two maps would make one key press
 * set two unrelated bits, which no cart can distinguish from the player
 * genuinely doing both -- a walk-left that also fires. So WASD moves the faces
 * to the right hand, where a WASD player's right hand already is, and the two
 * schemes stay internally consistent. `createKeyboardInput({ wasd: true })`
 * selects it.
 */
export const KEYMAP_WASD: Readonly<Record<string, number>> = Object.freeze({
  ArrowUp: M_UP,
  ArrowDown: M_DOWN,
  ArrowLeft: M_LEFT,
  ArrowRight: M_RIGHT,
  KeyW: M_UP,
  KeyS: M_DOWN,
  KeyA: M_LEFT,
  KeyD: M_RIGHT,
  KeyJ: M_A,
  KeyK: M_B,
  KeyU: M_X,
  KeyI: M_Y,
});

/** Keys that raise a console event instead of a button bit. */
const CONSOLE_KEYS: Readonly<Record<string, ConsoleEvent>> = Object.freeze({
  Escape: "pause",
  KeyP: "pause",
  Enter: "pause",
});

export interface KeyboardInputOptions {
  /** Use {@link KEYMAP_WASD} instead of {@link KEYMAP_ARROWS}. */
  wasd?: boolean;
  /** Which player slot the keyboard drives. Default 0. */
  player?: number;
}

/**
 * A keyboard, with a seam that does not need a DOM.
 *
 * `key(code, down)` is the whole of the logic; `attach` is nothing but two
 * `addEventListener` calls that forward to it. That split is what makes the
 * bindings testable in Node, and it means a test failure names a wrong mapping
 * rather than a wrong event listener.
 */
export interface KeyboardInput extends ConsoleInputSource {
  /** Apply a key transition directly. The seam `attach` drives, and the one tests use. */
  key(code: string, down: boolean): void;
  /** Forget every held key. Called on blur, so a key held during an alt-tab does not stick. */
  releaseAll(): void;
}

export function createKeyboardInput(opts?: KeyboardInputOptions): KeyboardInput {
  const map = opts?.wasd === true ? KEYMAP_WASD : KEYMAP_ARROWS;
  const slot = Math.min(Math.max(opts?.player ?? 0, 0), MAX_PLAYERS - 1);
  const state = new Uint8Array(INPUT_BYTES);
  let listener: ConsoleListener | null = null;
  let attached: EventTarget | null = null;

  const onKeyDown = (e: Event): void => {
    const ke = e as KeyboardEvent;
    if (ke.repeat) return;
    if (handled(ke.code)) ke.preventDefault();
    key(ke.code, true);
  };
  const onKeyUp = (e: Event): void => {
    const ke = e as KeyboardEvent;
    if (handled(ke.code)) ke.preventDefault();
    key(ke.code, false);
  };
  const onBlur = (): void => releaseAll();

  function handled(code: string): boolean {
    return code in map || code in CONSOLE_KEYS;
  }

  function key(code: string, down: boolean): void {
    const c = CONSOLE_KEYS[code];
    if (c !== undefined) {
      // Console events fire on press only, and never reach `state`. See the
      // header: a cart must not be able to observe pause.
      if (down && listener !== null) listener(c);
      return;
    }
    const mask = map[code];
    if (mask === undefined) return;
    if (down) state[slot] = (state[slot] as number) | mask;
    else state[slot] = (state[slot] as number) & ~mask & 0xff;
  }

  function releaseAll(): void {
    state.fill(0);
  }

  return {
    key,
    releaseAll,
    sample(out: Uint8Array): void {
      for (let i = 0; i < INPUT_BYTES; i++) out[i] = (out[i] as number) | (state[i] as number);
    },
    attach(target: EventTarget): void {
      if (attached !== null) return;
      attached = target;
      target.addEventListener("keydown", onKeyDown);
      target.addEventListener("keyup", onKeyUp);
      target.addEventListener("blur", onBlur);
    },
    detach(): void {
      if (attached === null) return;
      attached.removeEventListener("keydown", onKeyDown);
      attached.removeEventListener("keyup", onKeyUp);
      attached.removeEventListener("blur", onBlur);
      attached = null;
      releaseAll();
    },
    onConsole(cb: ConsoleListener): void {
      listener = cb;
    },
  };
}

// ---------------------------------------------------------------------------
// Gamepad
// ---------------------------------------------------------------------------

/**
 * The W3C standard mapping, and only that mapping.
 *
 * A pad that reports `mapping !== "standard"` is skipped rather than guessed
 * at. Guessing produces a controller whose buttons are wrong in a way the
 * player cannot fix and cannot report clearly; skipping produces a controller
 * that visibly does nothing, which is at least diagnosable.
 */
const PAD_BUTTONS: readonly [number, number][] = [
  [0, M_A],
  [1, M_B],
  [2, M_X],
  [3, M_Y],
  [12, M_UP],
  [13, M_DOWN],
  [14, M_LEFT],
  [15, M_RIGHT],
];

/** Standard-mapping index of Start. Raises pause; never becomes a button bit. */
const PAD_START = 9;

export interface GamepadInput extends ConsoleInputSource {}

/**
 * Poll every connected standard gamepad, pad `i` driving player slot `i`.
 *
 * Polled rather than event-driven because the Gamepad API has no button events:
 * `navigator.getGamepads()` is the only way to read one, and it must be read
 * fresh each frame or the values are stale. Reading it inside `sample` is
 * therefore correct -- the read happens exactly once per simulated frame,
 * which is also exactly the rate the console samples input.
 */
export function createGamepadInput(): GamepadInput {
  let listener: ConsoleListener | null = null;
  /** Start's previous state per pad, so pause fires on the edge and not every frame. */
  const startPrev = new Uint8Array(MAX_PLAYERS);

  return {
    sample(out: Uint8Array): void {
      const nav = (globalThis as { navigator?: Navigator }).navigator;
      if (nav === undefined || typeof nav.getGamepads !== "function") return;
      // The one allocation this file cannot avoid: the Gamepad API mints a new
      // array on every call. See the file header.
      const pads = nav.getGamepads();
      const n = Math.min(pads.length, MAX_PLAYERS);
      for (let i = 0; i < n; i++) {
        const pad = pads[i];
        if (pad === null || pad === undefined || !pad.connected) {
          startPrev[i] = 0;
          continue;
        }
        if (pad.mapping !== "standard") continue;

        let mask = 0;
        const buttons = pad.buttons;
        for (let k = 0; k < PAD_BUTTONS.length; k++) {
          const entry = PAD_BUTTONS[k] as [number, number];
          const b = buttons[entry[0]];
          if (b !== undefined && b.pressed) mask |= entry[1];
        }

        const ax = pad.axes[0];
        const ay = pad.axes[1];
        if (ax !== undefined) {
          if (ax <= -STICK_DEADZONE) mask |= M_LEFT;
          else if (ax >= STICK_DEADZONE) mask |= M_RIGHT;
        }
        if (ay !== undefined) {
          if (ay <= -STICK_DEADZONE) mask |= M_UP;
          else if (ay >= STICK_DEADZONE) mask |= M_DOWN;
        }

        out[i] = (out[i] as number) | mask;

        const start = buttons[PAD_START];
        const down = start !== undefined && start.pressed ? 1 : 0;
        if (down === 1 && startPrev[i] === 0 && listener !== null) listener("pause");
        startPrev[i] = down;
      }
    },
    attach(): void {
      /* Nothing to listen to: the Gamepad API is poll-only. */
    },
    detach(): void {
      startPrev.fill(0);
    },
    onConsole(cb: ConsoleListener): void {
      listener = cb;
    },
  };
}

// ---------------------------------------------------------------------------
// Touch
// ---------------------------------------------------------------------------

/**
 * The virtual controller: console hardware, not cart code.
 *
 * The rects come from `computeLayout`, so the thing drawn and the thing
 * hit-tested are the same geometry rather than two descriptions of it that can
 * drift apart. `setLayout` is called on every resize.
 */
export interface TouchInput extends InputSource {
  setLayout(l: ShellLayout): void;
  /** Press or move a pointer. The seam `attach` drives, and the one tests use. */
  pointerDown(id: number, x: number, y: number): void;
  pointerMove(id: number, x: number, y: number): void;
  pointerUp(id: number): void;
  /** Lift every finger. Used when the layout changes under the player's thumbs. */
  releaseAll(): void;
  /** How many pointers are currently held. Diagnostic, and what the tests assert on. */
  readonly held: number;
}

/**
 * Which bits a point on the controller presses.
 *
 * The d-pad is its rect divided into a 3 x 3 grid: the four edge cells are the
 * cardinals and THE FOUR CORNER CELLS SET BOTH NEIGHBOURING BITS. Diagonals are
 * not a bonus feature -- a d-pad whose corners do nothing forces a player to
 * cross a dead centre cell to change direction, which feels like the game
 * dropping inputs. The centre cell is deliberately empty: it is the rest
 * position.
 *
 * Exported and pure, so every case is a Node test.
 */
export function hitControls(dpad: Rect | null, buttons: ButtonRects | null, px: number, py: number): number {
  let mask = 0;
  if (dpad !== null && hitRect(dpad, px, py)) {
    const col = Math.min(2, Math.floor(((px - dpad.x) * 3) / dpad.w));
    const row = Math.min(2, Math.floor(((py - dpad.y) * 3) / dpad.h));
    if (row === 0) mask |= M_UP;
    else if (row === 2) mask |= M_DOWN;
    if (col === 0) mask |= M_LEFT;
    else if (col === 2) mask |= M_RIGHT;
  }
  if (buttons !== null) {
    if (hitRect(buttons.a, px, py)) mask |= M_A;
    else if (hitRect(buttons.b, px, py)) mask |= M_B;
    else if (hitRect(buttons.x, px, py)) mask |= M_X;
    else if (hitRect(buttons.y, px, py)) mask |= M_Y;
  }
  return mask;
}

export interface TouchInputOptions {
  /** Which player slot the virtual controller drives. Default 0. */
  player?: number;
}

export function createTouchInput(layout: ShellLayout, opts?: TouchInputOptions): TouchInput {
  const slot = Math.min(Math.max(opts?.player ?? 0, 0), MAX_PLAYERS - 1);
  let dpad = layout.dpad;
  let buttons = layout.buttons;

  // Parallel fixed arrays instead of a Map: see the header on allocation.
  // `ids[i] === EMPTY` marks a free slot.
  const EMPTY = -1;
  const ids = new Int32Array(MAX_POINTERS).fill(EMPTY);
  const masks = new Uint8Array(MAX_POINTERS);
  let count = 0;

  let element: EventTarget | null = null;
  let root: EventTarget | null = null;

  /** The offset used when there is no element to measure -- in tests, and in Node. */
  const ORIGIN = { left: 0, top: 0 };

  function indexOf(id: number): number {
    for (let i = 0; i < MAX_POINTERS; i++) if (ids[i] === id) return i;
    return -1;
  }

  function set(id: number, mask: number): void {
    const at = indexOf(id);
    if (at >= 0) {
      masks[at] = mask;
      return;
    }
    for (let i = 0; i < MAX_POINTERS; i++) {
      if (ids[i] === EMPTY) {
        ids[i] = id;
        masks[i] = mask;
        count++;
        return;
      }
    }
    // More than MAX_POINTERS fingers. Dropped rather than grown: the array is
    // preallocated on purpose, and an eleventh simultaneous touch is a palm.
  }

  function clear(id: number): void {
    const at = indexOf(id);
    if (at < 0) return;
    ids[at] = EMPTY;
    masks[at] = 0;
    count--;
  }

  const onDown = (e: Event): void => {
    const pe = e as PointerEvent;
    const r = rootRect();
    pointerDown(pe.pointerId, pe.clientX - r.left, pe.clientY - r.top);
    // Only swallow the event when it actually landed on a control; a touch on
    // the bezel must still be able to focus, scroll or dismiss a keyboard.
    if (indexOf(pe.pointerId) >= 0) e.preventDefault();
  };
  const onMove = (e: Event): void => {
    const pe = e as PointerEvent;
    if (indexOf(pe.pointerId) < 0) return;
    const r = rootRect();
    pointerMove(pe.pointerId, pe.clientX - r.left, pe.clientY - r.top);
    e.preventDefault();
  };
  const onUp = (e: Event): void => {
    pointerUp((e as PointerEvent).pointerId);
  };

  /**
   * Where the controller's coordinate origin is on screen.
   *
   * The layout rects are relative to the mount element, and pointer events are
   * in client coordinates, so every hit test needs this offset. It is read per
   * event rather than cached because the page can scroll between two touches
   * and a cached origin would put the d-pad somewhere the player is not.
   * Events are not frames: this is not on the per-frame path.
   */
  function rootRect(): { left: number; top: number } {
    const el = element as { getBoundingClientRect?: () => DOMRect } | null;
    if (el === null || typeof el.getBoundingClientRect !== "function") return ORIGIN;
    return el.getBoundingClientRect();
  }

  function pointerDown(id: number, x: number, y: number): void {
    const mask = hitControls(dpad, buttons, x, y);
    if (mask === 0) return;
    set(id, mask);
  }

  function pointerMove(id: number, x: number, y: number): void {
    if (indexOf(id) < 0) return;
    // A thumb that slides from LEFT into UP-LEFT is one continuous press, so a
    // tracked pointer keeps updating -- but a thumb that slides off the
    // controller entirely goes to zero rather than sticking on its last cell.
    set(id, hitControls(dpad, buttons, x, y));
  }

  function pointerUp(id: number): void {
    clear(id);
  }

  function releaseAll(): void {
    ids.fill(EMPTY);
    masks.fill(0);
    count = 0;
  }

  return {
    get held(): number {
      return count;
    },
    setLayout(l: ShellLayout): void {
      dpad = l.dpad;
      buttons = l.buttons;
      // The furniture moved; whatever was held is no longer held there.
      releaseAll();
    },
    pointerDown,
    pointerMove,
    pointerUp,
    releaseAll,
    sample(out: Uint8Array): void {
      let mask = 0;
      for (let i = 0; i < MAX_POINTERS; i++) mask |= masks[i] as number;
      out[slot] = (out[slot] as number) | mask;
    },
    attach(target: EventTarget): void {
      if (element !== null) return;
      element = target;
      target.addEventListener("pointerdown", onDown);
      target.addEventListener("pointermove", onMove);
      // Releases are taken from the window as well: a finger that lifts after
      // sliding off the element never sends `pointerup` to the element, and the
      // button would stay held forever.
      root = (globalThis as { addEventListener?: unknown }).addEventListener !== undefined
        ? (globalThis as unknown as EventTarget)
        : target;
      root.addEventListener("pointerup", onUp);
      root.addEventListener("pointercancel", onUp);
    },
    detach(): void {
      if (element === null) return;
      element.removeEventListener("pointerdown", onDown);
      element.removeEventListener("pointermove", onMove);
      root?.removeEventListener("pointerup", onUp);
      root?.removeEventListener("pointercancel", onUp);
      element = null;
      root = null;
      releaseAll();
    },
  };
}

// ---------------------------------------------------------------------------
// Combination
// ---------------------------------------------------------------------------

/**
 * One source that is the union of several.
 *
 * No scratch buffer and no allocation, which is only possible because `sample`
 * ORs rather than overwrites -- see the header. `attach` and `detach` fan out,
 * so the player wires and unwires every device with one call and cannot leak a
 * listener by forgetting one.
 */
export function combineInputs(sources: InputSource[]): ConsoleInputSource {
  const list = sources.slice();
  let listener: ConsoleListener | null = null;
  const forward: ConsoleListener = (e) => {
    if (listener !== null) listener(e);
  };
  for (let i = 0; i < list.length; i++) {
    const s = list[i] as InputSource & { onConsole?: (cb: ConsoleListener) => void };
    if (typeof s.onConsole === "function") s.onConsole(forward);
  }
  return {
    sample(out: Uint8Array): void {
      for (let i = 0; i < list.length; i++) (list[i] as InputSource).sample(out);
    },
    attach(target: EventTarget): void {
      for (let i = 0; i < list.length; i++) (list[i] as InputSource).attach(target);
    },
    detach(): void {
      for (let i = 0; i < list.length; i++) (list[i] as InputSource).detach();
    },
    onConsole(cb: ConsoleListener): void {
      listener = cb;
    },
  };
}
