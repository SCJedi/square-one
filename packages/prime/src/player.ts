/**
 * The Prime shell: the clock, the hands and the glass.
 *
 * =========================================================================
 * THE PLAYER OWNS THE CLOCK
 * =========================================================================
 * The simulation runs at a fixed 60 Hz and has no timer of its own. Real time
 * arrives in irregular lumps, so this file banks elapsed milliseconds and spends
 * them one fixed step at a time, with the two clamps
 * `packages/runtime/src/host.ts` argues for and the same numbers:
 *
 *     dt   = min(now - last, MAX_DT)                    // a lump is worth <= 100 ms
 *     acc += dt
 *     while (acc >= STEP_MS && steps < MAX_CATCH_UP) { tick; acc -= STEP_MS }
 *
 * Clamp 1 exists because a backgrounded tab returns after minutes and an
 * unclamped `dt` would ask for tens of thousands of ticks at once. Clamp 2
 * exists because catching up is itself work: a machine that cannot keep up gets
 * slower the harder it tries, and the loop never exits. Both let the simulation
 * fall behind wall-clock time rather than let the frame loop become unbounded.
 * A console that drops frames is playable; one that death-spirals is not. The
 * spec fixes the catch-up limit at 5 (section 2.2).
 *
 * =========================================================================
 * INTERPOLATION IS THE POINT
 * =========================================================================
 * `render(sim, draw, alpha)` runs once per PRESENTED frame, not once per tick,
 * and `alpha` is the fraction between the last two ticks -- `acc / STEP_MS`, in
 * [0, 1). That single number is how a 144 Hz display gets smooth motion out of a
 * 60 Hz simulation, and it is why the ABI tells a cart to keep both the previous
 * and the current position of anything that moves.
 *
 * Get it wrong and the symptom is not "slightly worse": at 144 Hz, presenting
 * the same simulated position for two or three frames and then jumping produces
 * a visible judder that reads as a performance problem no profiler will find.
 * Presenting every frame with the correct fraction is most of what "modern"
 * feels like.
 *
 * `render` MUST NOT write the arena. The machine is the half that enforces it
 * (the ABI has the runtime hash the arena around `render` in development
 * builds); this file's contribution is simply never to hand a cart anything else
 * to write to.
 *
 * =========================================================================
 * INPUT IS QUANTIZED BEFORE THE SIMULATION SEES IT
 * =========================================================================
 * A stick's true position differs between controllers, driver stacks and polling
 * rates. What reaches the cart is an integer -- i16 axes, u8 triggers, one bit
 * per button, in the layout `spec/PRIME-ABI.md` fixes -- because integers
 * replay. The frame is sampled ONCE per `advance` and every catch-up tick in
 * that wake-up sees the same frame: no time passed for the human in between, so
 * that is the honest reading, and it keeps the input trace a function of tick
 * number alone.
 *
 * NO DEADZONE IS APPLIED. Quantizing is the runtime's job; deciding that a stick
 * at 3% counts as centred is the game's, and a runtime that made that choice
 * would have made it for every cart that ever runs on it, irreversibly.
 *
 * =========================================================================
 * ACCESSIBILITY, ON THE CONSOLE'S SIDE OF THE LINE
 * =========================================================================
 * Pause is a real `<button>` with an accessible name, in the tab order, operable
 * by Enter and Space -- not a styled `<div>`, which is invisible to a screen
 * reader and unreachable from a keyboard, and pause is the control a player
 * needs most when something has gone wrong. Focus is visibly ringed.
 *
 * `prefers-reduced-motion` DISABLES SHAKE, and that is exactly why the ABI makes
 * post stages non-normative: a runtime may drop them, so a cart may never put
 * information in one, so a runtime may drop them for a player who asked for less
 * motion without taking anything away from the game. The preference is watched,
 * not merely read once, because a player can change it while the console runs.
 *
 * =========================================================================
 * THE MACHINE IS THE CORE'S, AND THIS FILE ADAPTS TO IT
 * =========================================================================
 * `createMachine` in `sim.ts` is the normative half: it owns the arena, the
 * generator, the tick counter and the seal around `render`. THE SHELL ADAPTS TO
 * IT rather than declaring its own shape of machine -- it imports `Machine` and
 * drives it: `boot(seed)`, `step(input)`, `present(draw, alpha)`.
 *
 * Anything machine-shaped that is not the core belongs somewhere else, or
 * nowhere. A stand-in has the right SHAPE and none of the guarantees, so a
 * replay recorded against it proves nothing while looking exactly like proof --
 * and in a package whose entire subject is determinism that is a trap for
 * whoever reads it next.
 *
 * Presenting THROUGH the machine rather than calling `cart.render` directly is
 * part of that: `present` is what hashes the arena around `render` and faults on
 * a write, and a guard that only the tests run is a guard that is off in the
 * build where it mattered.
 *
 * =========================================================================
 * SOUND COMES FROM `tick`, WHICH MEANS IT COMES FROM HERE
 * =========================================================================
 * The cart is handed `snd` by the machine, on `boot` and on every `tick`, and
 * never on `render`. This file's contribution is to own the backend: it builds
 * the real mixer when the environment has WebAudio, hands it to the machine, and
 * ARMS THE FIRST USER GESTURE TO START IT. A browser refuses to run an
 * `AudioContext` outside a gesture and refuses quietly, so `start()` is
 * attempted immediately, expected to fail, and retried from the first key or
 * pointer the player produces -- and until it succeeds the status line says so
 * rather than pretending.
 */

import { createPrimeAudio, audioAvailable } from "./audio";
import type { PrimeAudio } from "./audio";
import { createDraw } from "./draw";
import type { DrawList } from "./draw";
import { createRenderer } from "./render";
import type { Renderer } from "./render";
import { MAX_PLAYERS, createMachine, nullSnd } from "./sim";
import type { InputFrame, Machine, PrimeCart, Sim, SimRead, Snd } from "./sim";

export { MAX_PLAYERS };
export type { InputFrame, Machine, PrimeCart, Sim, SimRead, Snd };

/** Analog axes per player: two sticks. */
export const AXES_PER_PLAYER = 4;

/** Analog triggers per player. */
export const TRIGGERS_PER_PLAYER = 2;

/** The simulation step. 60 Hz, fixed, and not an option. */
const STEP_MS = 1000 / 60;

/** The largest elapsed time one wake-up will honour, in milliseconds. */
const MAX_DT = 100;

/** Ticks one presented frame may catch up by. The spec's number (2.2). */
const MAX_CATCH_UP = 5;

/** Button bits, exactly as `spec/PRIME-ABI.md` lists them. */
export const BTN = {
  UP: 0,
  DOWN: 1,
  LEFT: 2,
  RIGHT: 3,
  A: 4,
  B: 5,
  X: 6,
  Y: 7,
  L: 8,
  R: 9,
  L2: 10,
  R2: 11,
  L3: 12,
  R3: 13,
  SELECT: 14,
  START: 15,
} as const;

export interface PrimePlayerOptions {
  /** The element the console fills. Its box drives the presentation size. */
  mount: HTMLElement;
  /** The cart to run. */
  cart: PrimeCart;
  /** Boot seed. Default 0n. The same cart and seed is the same run, always. */
  seed?: bigint;
  /**
   * The mixer the cart emits through.
   *
   * Omitted, the shell builds the real one where the environment has WebAudio
   * and installs silence where it does not -- so a cart is never handed
   * `undefined` and never has to ask whether anybody is listening. Pass a
   * recording backend here to capture what a run played.
   */
  snd?: Snd;
  /**
   * Build the machine. Defaults to the real `createMachine` from `sim.ts`.
   *
   * The hook exists for a host that wants its own instrumentation around the
   * core, not for a substitute for it: whatever comes back must be a `Machine`,
   * which means a real arena, a real PCG64-DXSM and a real seal around `render`.
   */
  machine?: (cart: PrimeCart, snd: Snd) => Machine;
  /** Draw with this renderer instead of a fresh one. For tests and for a GPU backend. */
  renderer?: Renderer;
  /** The document to build in. Defaults to `mount.ownerDocument`. */
  document?: Document;
}

export interface PrimePlayer {
  start(): void;
  pause(): void;
  resume(): void;
  stop(): void;
  /** The simulation's tick counter: the only clock a cart can see. */
  readonly tick: bigint;
  readonly paused: boolean;
  /** The machine, for a host that wants to snapshot, restore or hash it. */
  readonly machine: Machine;
  /** The mixer the cart is emitting through. */
  readonly snd: Snd;
  /**
   * The WebAudio backend, when this shell built one.
   *
   * Null when the host supplied its own `snd` or the environment has no
   * `AudioContext`. Its `state` is the honest one, "suspended" included.
   */
  readonly audio: PrimeAudio | null;
  /** Silence the output without stopping the simulation. */
  muted: boolean;
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

/**
 * `KeyboardEvent.code` -> button bit, for player slot 0.
 *
 * Keyed on `code` rather than `key`, so bindings are POSITIONS on the board: a
 * French AZERTY player's Z key is where a US player's W key is, and `code` gives
 * both of them the same physical control.
 *
 * The face buttons are on J K U I rather than on Z X A S because A and S are the
 * WASD d-pad -- the small console learned that one the hard way, and a single
 * key that sets two unrelated bits is indistinguishable from the player
 * genuinely doing both.
 */
export const KEYMAP: Readonly<Record<string, number>> = Object.freeze({
  ArrowUp: BTN.UP,
  ArrowDown: BTN.DOWN,
  ArrowLeft: BTN.LEFT,
  ArrowRight: BTN.RIGHT,
  KeyW: BTN.UP,
  KeyS: BTN.DOWN,
  KeyA: BTN.LEFT,
  KeyD: BTN.RIGHT,
  KeyJ: BTN.A,
  KeyZ: BTN.A,
  Space: BTN.A,
  KeyK: BTN.B,
  KeyX: BTN.B,
  KeyU: BTN.X,
  KeyI: BTN.Y,
  KeyQ: BTN.L,
  KeyE: BTN.R,
  Digit1: BTN.L2,
  Digit3: BTN.R2,
  ShiftLeft: BTN.L3,
  ShiftRight: BTN.R3,
  Backquote: BTN.SELECT,
  Enter: BTN.START,
});

/** Keys the CONSOLE takes. A cart never sees them -- the ABI says pause is not its business. */
const CONSOLE_KEYS: Readonly<Record<string, "pause">> = Object.freeze({
  Escape: "pause",
  KeyP: "pause",
});

/**
 * Standard-mapping gamepad button index -> ABI button bit.
 *
 * Only `mapping === "standard"` pads are read. A pad that reports anything else
 * is skipped rather than guessed at: guessing produces a controller whose
 * buttons are wrong in a way the player can neither fix nor describe.
 */
const PAD_BUTTONS: readonly number[] = [
  BTN.A, // 0
  BTN.B, // 1
  BTN.X, // 2
  BTN.Y, // 3
  BTN.L, // 4
  BTN.R, // 5
  BTN.L2, // 6
  BTN.R2, // 7
  BTN.SELECT, // 8
  BTN.START, // 9
  BTN.L3, // 10
  BTN.R3, // 11
  BTN.UP, // 12
  BTN.DOWN, // 13
  BTN.LEFT, // 14
  BTN.RIGHT, // 15
];

/** Standard-mapping indices of the analog triggers. */
const PAD_TRIGGERS: readonly number[] = [6, 7];

/** Quantize an axis in [-1, 1] to the ABI's i16. */
export function quantizeAxis(v: number): number {
  if (!Number.isFinite(v)) return 0;
  const c = v < -1 ? -1 : v > 1 ? 1 : v;
  const q = Math.round(c * 32767);
  return q < -32768 ? -32768 : q > 32767 ? 32767 : q;
}

/** Quantize a trigger in [0, 1] to the ABI's u8. */
export function quantizeTrigger(v: number): number {
  if (!Number.isFinite(v)) return 0;
  const c = v < 0 ? 0 : v > 1 ? 1 : v;
  return Math.round(c * 255);
}

/** A mutable {@link InputFrame} plus the three ways a human fills it in. */
export interface InputReader {
  /** Rebuild the frame from the keyboard state and the gamepads. Allocates nothing but the Gamepad API's own array. */
  sample(): InputFrame;
  /** Apply a key transition. The seam `attach` drives, and the one tests use. */
  key(code: string, down: boolean): void;
  /** Forget every held key, so a key held through an alt-tab does not stick. */
  releaseAll(): void;
  attach(target: EventTarget): void;
  detach(): void;
  /** Called for a console event the cart must never observe. */
  onConsole(cb: (e: "pause") => void): void;
  readonly frame: InputFrame;
}

export function createInputReader(): InputReader {
  const buttons = new Uint16Array(MAX_PLAYERS);
  const axes = new Int16Array(MAX_PLAYERS * AXES_PER_PLAYER);
  const triggers = new Uint8Array(MAX_PLAYERS * TRIGGERS_PER_PLAYER);
  let present = 1; // Slot 0 is the keyboard, always there.

  /** Keyboard-held bits for slot 0, kept apart so a gamepad cannot clear them. */
  let keyBits = 0;
  let listener: ((e: "pause") => void) | null = null;
  let attached: EventTarget | null = null;

  // One object, reused. See InputFrame.
  const frame: InputFrame = {
    buttons,
    axes,
    triggers,
    get present(): number {
      return present;
    },
  };

  function key(code: string, down: boolean): void {
    const c = CONSOLE_KEYS[code];
    if (c !== undefined) {
      if (down && listener !== null) listener(c);
      return;
    }
    const bit = KEYMAP[code];
    if (bit === undefined) return;
    if (down) keyBits |= 1 << bit;
    else keyBits &= ~(1 << bit) & 0xffff;
  }

  function handled(code: string): boolean {
    return code in KEYMAP || code in CONSOLE_KEYS;
  }

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
  const onBlur = (): void => {
    keyBits = 0;
  };

  return {
    frame,
    key,

    releaseAll(): void {
      keyBits = 0;
    },

    sample(): InputFrame {
      buttons.fill(0);
      axes.fill(0);
      triggers.fill(0);
      present = 1;
      buttons[0] = keyBits;

      const nav = (globalThis as { navigator?: Navigator }).navigator;
      if (nav === undefined || typeof nav.getGamepads !== "function") return frame;
      // The one allocation on this path that cannot be avoided: the Gamepad API
      // is specified to return a fresh array on every call, and there is no
      // allocation-free way to poll a pad from JavaScript.
      const pads = nav.getGamepads();
      const n = Math.min(pads.length, MAX_PLAYERS);
      for (let i = 0; i < n; i++) {
        const pad = pads[i];
        if (pad === null || pad === undefined || !pad.connected) continue;
        present |= 1 << i;
        if (pad.mapping !== "standard") continue;

        let bits = buttons[i] as number;
        const pb = pad.buttons;
        for (let k = 0; k < PAD_BUTTONS.length; k++) {
          const b = pb[k];
          if (b !== undefined && b.pressed) bits |= 1 << (PAD_BUTTONS[k] as number);
        }
        buttons[i] = bits;

        const ao = i * AXES_PER_PLAYER;
        for (let k = 0; k < AXES_PER_PLAYER; k++) {
          axes[ao + k] = quantizeAxis(pad.axes[k] ?? 0);
        }

        const to = i * TRIGGERS_PER_PLAYER;
        for (let k = 0; k < TRIGGERS_PER_PLAYER; k++) {
          const b = pb[PAD_TRIGGERS[k] as number];
          triggers[to + k] = quantizeTrigger(b === undefined ? 0 : b.value);
        }
      }
      return frame;
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
      keyBits = 0;
    },

    onConsole(cb: (e: "pause") => void): void {
      listener = cb;
    },
  };
}

// ---------------------------------------------------------------------------
// The shell
// ---------------------------------------------------------------------------

const NS = "sq1p";
const STYLE_ID = "sq1p-shell-style";

/**
 * The console's own sheet.
 *
 * One injected stylesheet rather than inline styles, because `:focus-visible`
 * and `prefers-reduced-motion` cannot be expressed inline -- and dropping them
 * would mean an invisible focus ring and animation for a player who asked for
 * none.
 */
const SHEET = `
.${NS}-root {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
  background: #000;
  color: #e8e6f2;
  font: 500 13px/1.3 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  touch-action: none;
  user-select: none;
  -webkit-user-select: none;
}
.${NS}-canvas { position: absolute; left: 0; top: 0; display: block; }
.${NS}-bar {
  position: absolute;
  right: 12px;
  top: 12px;
  display: flex;
  gap: 10px;
  align-items: center;
}
.${NS}-status {
  font-size: 12px;
  letter-spacing: .06em;
  text-transform: uppercase;
  color: #b9b3d6;
  text-shadow: 0 1px 2px #000;
}
.${NS}-pause {
  width: 44px;
  height: 44px;
  display: grid;
  place-items: center;
  box-sizing: border-box;
  margin: 0;
  padding: 0;
  border: 1px solid rgba(255,255,255,.28);
  border-radius: 10px;
  background: rgba(18,16,34,.72);
  color: #e8e6f2;
  font: inherit;
  font-size: 15px;
  cursor: pointer;
}
.${NS}-pause:hover { background: rgba(40,36,70,.85); }
.${NS}-root :focus-visible { outline: 3px solid #8ab4ff; outline-offset: 2px; }
.${NS}-root * { transition: background-color 90ms linear; }
@media (prefers-reduced-motion: reduce) {
  .${NS}-root * { transition: none !important; animation: none !important; }
}
`;

function ensureSheet(doc: Document): void {
  if (doc.getElementById(STYLE_ID) !== null) return;
  const style = doc.createElement("style");
  style.id = STYLE_ID;
  style.textContent = SHEET;
  (doc.head ?? doc.documentElement).appendChild(style);
}

/** True when the player has asked for less motion. Null when the query cannot be run. */
function reducedMotionQuery(win: Window): MediaQueryList | null {
  if (typeof win.matchMedia !== "function") return null;
  try {
    return win.matchMedia("(prefers-reduced-motion: reduce)");
  } catch {
    return null;
  }
}

export function createPrimePlayer(opts: PrimePlayerOptions): PrimePlayer {
  const mount = opts.mount;
  const doc = opts.document ?? mount.ownerDocument;
  const view = doc.defaultView;
  if (view === null) {
    throw new Error("createPrimePlayer: the mount element is not in a rendered document.");
  }
  // Re-bound with a non-nullable type: every hoisted function below reads it,
  // and TypeScript will not carry a control-flow narrowing into one.
  const win: Window = view;

  ensureSheet(doc);

  const root = doc.createElement("div");
  root.className = `${NS}-root`;

  const bar = doc.createElement("div");
  bar.className = `${NS}-bar`;

  const status = doc.createElement("span");
  status.className = `${NS}-status`;
  // Announced when it changes: it carries "paused", which is the thing a player
  // who cannot see the screen most needs told.
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");

  // A REAL BUTTON. See the file header.
  const pauseBtn = doc.createElement("button");
  pauseBtn.type = "button";
  pauseBtn.className = `${NS}-pause`;
  pauseBtn.textContent = "II";
  pauseBtn.setAttribute("aria-label", "Pause");
  pauseBtn.setAttribute("aria-pressed", "false");

  bar.append(status, pauseBtn);

  const renderer: Renderer = opts.renderer ?? createRenderer({ document: doc });
  const canvas = renderer.canvas;
  canvas.className = `${NS}-canvas`;
  canvas.setAttribute("role", "img");
  canvas.setAttribute("aria-label", "Square One Prime screen");

  root.append(canvas, bar);
  mount.appendChild(root);

  const draw: DrawList = createDraw();
  const input = createInputReader();

  // --- the mixer ------------------------------------------------------------
  // Built before the machine, because the machine is what hands it to the cart.
  const audio: PrimeAudio | null =
    opts.snd === undefined && audioAvailable() ? createPrimeAudio() : null;
  const snd: Snd = opts.snd ?? audio ?? nullSnd();

  const machine: Machine = (opts.machine ?? createMachine)(opts.cart, snd);

  // --- reduced motion -------------------------------------------------------
  const motion = reducedMotionQuery(win);
  function applyMotion(): void {
    // Shake only. Bloom does not move anything, and a player who asked for less
    // motion did not ask for a duller picture.
    renderer.setPost({ shake: !(motion?.matches ?? false) });
  }
  const onMotionChange = (): void => applyMotion();
  applyMotion();
  motion?.addEventListener?.("change", onMotionChange);

  // --- presentation size ----------------------------------------------------
  function relayout(): void {
    const w = mount.clientWidth;
    const h = mount.clientHeight;
    if (w === 0 && h === 0) return;
    const dpr = (globalThis as { devicePixelRatio?: number }).devicePixelRatio ?? 1;
    renderer.resize(w, h, dpr);
  }

  let observer: ResizeObserver | null = null;
  const onWindowResize = (): void => relayout();
  const RO = (win as unknown as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;
  if (typeof RO === "function") {
    const ro = new RO(() => relayout());
    ro.observe(mount);
    observer = ro;
  } else {
    win.addEventListener("resize", onWindowResize);
  }

  // --- the loop -------------------------------------------------------------
  let raf = 0;
  let running = false;
  let paused = false;
  let booted = false;

  /** Unspent simulated time, in milliseconds. */
  let acc = 0;
  /** Timestamp of the previous wake-up, or null before the first. */
  let last: number | null = null;

  /**
   * Spend elapsed real time as whole ticks, then present once.
   *
   * Exactly one accumulator, and it is here. See the file header.
   */
  function advance(nowMs: number): void {
    if (last === null) {
      last = nowMs;
    } else {
      const dt = Math.min(nowMs - last, MAX_DT);
      last = nowMs;
      if (dt > 0) acc += dt;

      // Sampled ONCE per wake-up, not once per tick. See the file header.
      const frame = input.sample();
      let steps = 0;
      while (acc >= STEP_MS && steps < MAX_CATCH_UP) {
        machine.step(frame);
        acc -= STEP_MS;
        steps++;
      }
      // The catch-up clamp can leave more than a step banked. `alpha` is a
      // fraction in [0, 1) by contract, so it is clamped rather than allowed to
      // hand a cart an extrapolation it was never promised.
      if (acc > STEP_MS) acc = STEP_MS;
    }
    present();
  }

  /**
   * Build this frame's scene and draw it. Runs once per PRESENTED frame.
   *
   * Through `machine.present` rather than `cart.render`, so the arena is sealed
   * and verified around the call in exactly the shipped path -- and so the cart
   * is handed `SimRead`, which has no `rnd`, no `rndf`, and no `snd`.
   */
  function present(): void {
    const alpha = Math.min(acc / STEP_MS, 0.999999);
    draw.begin();
    machine.present(draw, alpha);
    renderer.draw(draw.list);
  }

  function loop(nowMs: number): void {
    if (!running) return;
    raf = win.requestAnimationFrame(loop);
    if (paused) return;
    advance(nowMs);
  }

  function togglePause(): void {
    if (paused) api.resume();
    else api.pause();
  }

  // --- sound, and the gesture that is allowed to start it -------------------
  /**
   * The status line, composed rather than assigned.
   *
   * "paused" is the thing a player who cannot see the screen most needs told, so
   * it wins; below it sits the autoplay notice, which is the second. Two writers
   * each setting `textContent` directly is how one of them ends up silently
   * erasing the other.
   */
  function refreshStatus(): void {
    if (paused) {
      status.textContent = "paused";
      return;
    }
    status.textContent = audio !== null && audio.state !== "running" && !audio.muted
      ? "press a key for sound"
      : "";
  }

  let gestureArmed = false;

  function tryStartAudio(): void {
    if (audio === null || audio.state === "running") return;
    audio
      .start()
      .then(() => {
        disarmGesture();
        refreshStatus();
      })
      .catch(() => {
        // Autoplay policy, almost always. The context is kept, so the next
        // gesture is one resume() away; say so on screen and wait.
        refreshStatus();
      });
  }

  const onGesture = (): void => tryStartAudio();

  function armGesture(): void {
    if (audio === null || gestureArmed) return;
    gestureArmed = true;
    win.addEventListener("pointerdown", onGesture);
    win.addEventListener("keydown", onGesture);
    win.addEventListener("touchend", onGesture);
  }

  function disarmGesture(): void {
    if (!gestureArmed) return;
    gestureArmed = false;
    win.removeEventListener("pointerdown", onGesture);
    win.removeEventListener("keydown", onGesture);
    win.removeEventListener("touchend", onGesture);
  }

  const onPauseClick = (e: Event): void => {
    e.preventDefault();
    togglePause();
  };
  pauseBtn.addEventListener("click", onPauseClick);
  input.onConsole(() => togglePause());
  input.attach(win);

  const api: PrimePlayer = {
    start(): void {
      if (running) return;
      running = true;
      relayout();
      if (!booted) {
        machine.boot(opts.seed ?? 0n);
        booted = true;
      }
      // Attempted now and expected to fail: `start()` is usually called from
      // page load rather than from a gesture. The arm is what actually gets the
      // sound on, and the status line carries the difference in the meantime.
      armGesture();
      tryStartAudio();
      refreshStatus();
      last = null;
      acc = 0;
      raf = win.requestAnimationFrame(loop);
    },

    pause(): void {
      if (paused) return;
      paused = true;
      pauseBtn.setAttribute("aria-pressed", "true");
      pauseBtn.setAttribute("aria-label", "Resume");
      pauseBtn.textContent = "▶";
      refreshStatus();
      // Buttons held when the game stopped must not still be held when it starts
      // again: the player's hands have moved in between.
      input.releaseAll();
    },

    resume(): void {
      if (!paused) return;
      paused = false;
      pauseBtn.setAttribute("aria-pressed", "false");
      pauseBtn.setAttribute("aria-label", "Pause");
      pauseBtn.textContent = "II";
      refreshStatus();
      // Re-baseline: the wall clock ran while the simulation did not, and an
      // unreset accumulator would spend the whole pause as catch-up ticks.
      last = null;
      acc = 0;
    },

    stop(): void {
      running = false;
      if (raf !== 0) win.cancelAnimationFrame(raf);
      raf = 0;
      observer?.disconnect();
      win.removeEventListener("resize", onWindowResize);
      motion?.removeEventListener?.("change", onMotionChange);
      pauseBtn.removeEventListener("click", onPauseClick);
      disarmGesture();
      // Only a mixer this shell built. A host that passed its own `snd` owns it,
      // and a console that closed somebody else's AudioContext on the way out
      // would be reaching into another object's lifetime.
      audio?.stop();
      input.detach();
      root.remove();
    },

    get tick(): bigint {
      return machine.tick;
    },

    get paused(): boolean {
      return paused;
    },

    machine,
    snd,
    audio,

    get muted(): boolean {
      return audio?.muted ?? true;
    },

    set muted(v: boolean) {
      if (audio !== null) audio.muted = v;
      refreshStatus();
    },
  };

  relayout();
  return api;
}
