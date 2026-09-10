/**
 * The console around the screen: bezel, cart title, player lights, pause, and
 * the virtual controller.
 *
 * =========================================================================
 * THE SHELL IS A SECURITY BOUNDARY, NOT DECORATION
 * =========================================================================
 * Everything this file builds is console-owned and cart-invisible. A cart gets
 * one canvas of 128 x 128 pixels and no other handle on the page: no element,
 * no style, no font, no text node, no event. That is what makes the frame
 * around the game meaningful -- a cart can draw a perfect replica of a login
 * box, and it will still be sitting visibly inside a game screen, inside a
 * console, with no address bar and nowhere to submit. The chrome a browser puts
 * around a page works for exactly the same reason.
 *
 * The one string that crosses from cart to chrome is the TITLE, out of the
 * container's validated META. It is written with `textContent`, never
 * `innerHTML`, so it is text and can never become markup; the container already
 * caps it at 64 UTF-8 bytes and refuses control characters. It is still the one
 * place a hostile cart gets to put words in the console's mouth, so it is
 * rendered in the shell's own font at the shell's own size, next to the word
 * CART, and never anywhere a system message would appear.
 *
 * TOUCH CONTROLS ARE HARDWARE. The d-pad and the four faces are drawn here, hit
 * tested in `input.ts`, and never mentioned in a cart. Every cart therefore has
 * working touch input the moment it loads, and no author ever writes a line
 * about it -- which is the point of putting them on the console side.
 *
 * PAUSE IS A REAL BUTTON. `<button type="button">` with an accessible name, in
 * the tab order, operable by Enter and Space because that is what a button
 * does. Not a styled `<div>` with a click handler: a div is invisible to a
 * screen reader and unreachable from a keyboard, and pause is the control a
 * player needs most when something has gone wrong.
 *
 * STYLE LIVES IN ONE INJECTED SHEET. Not inline styles on every node, because
 * `:focus-visible`, `:active` and the two `prefers-*` media queries cannot be
 * expressed inline -- and dropping them would mean an invisible focus ring, no
 * dark mode, and animation for people who asked for none. Geometry stays inline
 * (it comes from `ShellLayout` and changes on resize); appearance is in the
 * sheet.
 */

import { MAX_PLAYERS } from "@sq1/runtime";

import type { ButtonRects, Rect, ShellLayout } from "./layout";

/** Prefix for every class this file emits, so nothing collides with a host page. */
const NS = "sq1";

const STYLE_ID = "sq1-shell-style";

/**
 * The sheet.
 *
 * Colours are custom properties defined light-first and overridden under
 * `prefers-color-scheme: dark`, so a console embedded in someone's page follows
 * the reader's choice rather than shouting over it.
 */
const SHEET = `
.${NS}-root {
  --sq1-bezel: #d9d5cc;
  --sq1-bezel-edge: #b6b0a4;
  --sq1-ink: #2b2822;
  --sq1-ink-dim: #6d675c;
  --sq1-key: #efece5;
  --sq1-key-edge: #b6b0a4;
  --sq1-key-down: #c8c2b5;
  --sq1-lit: #3fbf6f;
  --sq1-unlit: #b6b0a4;
  --sq1-focus: #1a6ef5;
  position: relative;
  overflow: hidden;
  background: var(--sq1-bezel);
  color: var(--sq1-ink);
  font: 500 13px/1.25 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  -webkit-font-smoothing: antialiased;
  touch-action: none;
  user-select: none;
  -webkit-user-select: none;
  -webkit-tap-highlight-color: transparent;
}
@media (prefers-color-scheme: dark) {
  .${NS}-root {
    --sq1-bezel: #1c1b19;
    --sq1-bezel-edge: #000;
    --sq1-ink: #e9e5dc;
    --sq1-ink-dim: #8d8779;
    --sq1-key: #2e2c28;
    --sq1-key-edge: #000;
    --sq1-key-down: #45423c;
    --sq1-lit: #4fd684;
    --sq1-unlit: #423f3a;
    --sq1-focus: #8ab4ff;
  }
}
.${NS}-panel {
  position: absolute;
  display: flex;
  gap: 10px;
  align-items: center;
  box-sizing: border-box;
  overflow: hidden;
}
.${NS}-panel.${NS}-rail {
  flex-direction: column;
  align-items: flex-start;
  justify-content: flex-start;
  gap: 8px;
}
/* In a column, a growing title would push the lights and the status line to the
   bottom of a rail that is a thousand pixels tall. The information block reads
   as one object only if it stays one object. */
.${NS}-panel.${NS}-rail > * { flex: none; }
.${NS}-panel.${NS}-rail .${NS}-title { width: 100%; }
.${NS}-mark {
  font-size: 10px;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--sq1-ink-dim);
  white-space: nowrap;
  flex: none;
}
.${NS}-title {
  font-size: 14px;
  font-weight: 650;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
  flex: 1 1 auto;
}
.${NS}-lights { display: flex; gap: 6px; flex: none; align-items: center; }
.${NS}-light {
  width: 8px; height: 8px; border-radius: 50%;
  background: var(--sq1-unlit);
  box-shadow: inset 0 0 0 1px rgba(0,0,0,0.18);
}
.${NS}-light[data-on="1"] { background: var(--sq1-lit); }
.${NS}-status { font-size: 11px; color: var(--sq1-ink-dim); white-space: nowrap; flex: none; }
.${NS}-pause {
  position: absolute;
  display: grid;
  place-items: center;
  box-sizing: border-box;
  margin: 0;
  padding: 0;
  border: 1px solid var(--sq1-key-edge);
  border-radius: 10px;
  background: var(--sq1-key);
  color: var(--sq1-ink);
  font: inherit;
  font-size: 15px;
  cursor: pointer;
}
.${NS}-pause:active { background: var(--sq1-key-down); }
.${NS}-key {
  position: absolute;
  box-sizing: border-box;
  border: 1px solid var(--sq1-key-edge);
  background: var(--sq1-key);
  color: var(--sq1-ink-dim);
  display: grid;
  place-items: center;
  font: 600 15px/1 ui-sans-serif, system-ui, sans-serif;
}
.${NS}-face { border-radius: 50%; }
.${NS}-dpad {
  position: absolute;
  /* A plus, cut from one box, so the d-pad is a single element whose drawn
     shape is exactly the rect input.ts hit tests as a 3 x 3 grid. */
  clip-path: polygon(33.34% 0, 66.66% 0, 66.66% 33.34%, 100% 33.34%, 100% 66.66%,
                     66.66% 66.66%, 66.66% 100%, 33.34% 100%, 33.34% 66.66%,
                     0 66.66%, 0 33.34%, 33.34% 33.34%);
  background: var(--sq1-key);
  box-shadow: inset 0 0 0 1px var(--sq1-key-edge);
}
.${NS}-root :focus-visible {
  outline: 3px solid var(--sq1-focus);
  outline-offset: 2px;
}
.${NS}-root * { transition: background-color 90ms linear; }
@media (prefers-reduced-motion: reduce) {
  .${NS}-root * { transition: none !important; animation: none !important; }
}
`;

export interface ShellOptions {
  /** Where the console goes. Its size drives the layout. */
  mount: HTMLElement;
  /** The cart's validated META title. Rendered as text, never as markup. */
  title: string;
  /** The document to build in. Defaults to `mount.ownerDocument`. */
  document?: Document;
  /** Called when the player asks to pause. A console function; no cart sees it. */
  onPause?: () => void;
}

export interface Shell {
  /** The console's own root element, added to the mount. */
  readonly root: HTMLElement;
  /** Move every part to match a layout. Called on construction and on every resize. */
  apply(l: ShellLayout): void;
  /** Reflect paused state in the button's label and pressed state. */
  setPaused(paused: boolean): void;
  /** Light the player indicators from a `PLAYERS_PRESENT`-shaped bitmask. */
  setPlayers(mask: number): void;
  /** A short console message: "paused", "fault: deadline", "". Never cart text. */
  setStatus(text: string): void;
  /** Put the canvas in the shell. Called once by the player. */
  mountScreen(canvas: HTMLCanvasElement): void;
  destroy(): void;
}

function ensureSheet(doc: Document): void {
  if (doc.getElementById(STYLE_ID) !== null) return;
  const style = doc.createElement("style");
  style.id = STYLE_ID;
  style.textContent = SHEET;
  (doc.head ?? doc.documentElement).appendChild(style);
}

function place(el: HTMLElement, r: Rect): void {
  el.style.left = `${r.x}px`;
  el.style.top = `${r.y}px`;
  el.style.width = `${r.w}px`;
  el.style.height = `${r.h}px`;
}

function hide(el: HTMLElement, hidden: boolean): void {
  el.hidden = hidden;
  el.style.display = hidden ? "none" : "";
}

export function createShell(opts: ShellOptions): Shell {
  const doc = opts.document ?? opts.mount.ownerDocument;
  ensureSheet(doc);

  const root = doc.createElement("div");
  root.className = `${NS}-root`;
  root.style.width = "100%";
  root.style.height = "100%";

  // --- the information panel ------------------------------------------------
  const panel = doc.createElement("div");
  panel.className = `${NS}-panel`;

  const mark = doc.createElement("span");
  mark.className = `${NS}-mark`;
  mark.textContent = "Square One";

  const title = doc.createElement("span");
  title.className = `${NS}-title`;
  // textContent, never innerHTML. The title is the only cart-authored string in
  // the chrome; as text it can style nothing and script nothing.
  title.textContent = opts.title === "" ? "untitled cart" : opts.title;

  const lights = doc.createElement("div");
  lights.className = `${NS}-lights`;
  lights.setAttribute("role", "group");
  lights.setAttribute("aria-label", "player slots");
  const lamps: HTMLElement[] = [];
  for (let i = 0; i < MAX_PLAYERS; i++) {
    const lamp = doc.createElement("span");
    lamp.className = `${NS}-light`;
    lamp.dataset["on"] = "0";
    lamp.title = `player ${i + 1}`;
    lights.appendChild(lamp);
    lamps.push(lamp);
  }

  const status = doc.createElement("span");
  status.className = `${NS}-status`;
  // Announced when it changes, because it carries "paused" and fault text --
  // the two things a player who cannot see the screen most needs told.
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");

  panel.append(mark, title, lights, status);

  // --- pause ----------------------------------------------------------------
  const pause = doc.createElement("button");
  pause.type = "button";
  pause.className = `${NS}-pause`;
  pause.textContent = "II";
  pause.setAttribute("aria-label", "Pause");
  pause.setAttribute("aria-pressed", "false");
  pause.style.touchAction = "manipulation";
  const onPauseClick = (e: Event): void => {
    e.preventDefault();
    opts.onPause?.();
  };
  pause.addEventListener("click", onPauseClick);

  // --- the virtual controller ----------------------------------------------
  const dpad = doc.createElement("div");
  dpad.className = `${NS}-dpad`;
  dpad.setAttribute("aria-hidden", "true");

  const faceNames = ["a", "b", "x", "y"] as const;
  const faces: Record<(typeof faceNames)[number], HTMLElement> = {
    a: doc.createElement("div"),
    b: doc.createElement("div"),
    x: doc.createElement("div"),
    y: doc.createElement("div"),
  };
  for (const n of faceNames) {
    const el = faces[n];
    el.className = `${NS}-key ${NS}-face`;
    el.textContent = n.toUpperCase();
    // Hidden from assistive technology on purpose: they are a picture of the
    // hardware, not controls. A screen-reader user drives the console from the
    // keyboard, which reaches the same eight bits.
    el.setAttribute("aria-hidden", "true");
  }

  root.append(panel, pause, dpad, faces.a, faces.b, faces.x, faces.y);
  opts.mount.appendChild(root);

  function applyButtons(b: ButtonRects | null): void {
    const off = b === null;
    for (const n of faceNames) hide(faces[n], off);
    if (b === null) return;
    place(faces.a, b.a);
    place(faces.b, b.b);
    place(faces.x, b.x);
    place(faces.y, b.y);
  }

  return {
    root,

    apply(l: ShellLayout): void {
      // THE PAUSE BUTTON IS PLACED FIRST AND THE PANEL GETS OUT OF ITS WAY.
      // Pause is absolutely positioned from the layout, and the panel is normal
      // flow, so without this the flow content -- title, then lights, then the
      // status line -- runs straight underneath it and the player indicators
      // disappear behind the one control that must never be obscured.
      const rail = l.orientation === "landscape";
      panel.classList.toggle(`${NS}-rail`, rail);
      if (rail) {
        // The rail simply stops where the button starts.
        const h = Math.max(0, l.pause.y - l.chrome.y - 10);
        place(panel, { x: l.chrome.x, y: l.chrome.y, w: l.chrome.w, h });
        panel.style.paddingRight = "0px";
      } else {
        // The bar keeps its full width and reserves the button's column.
        place(panel, l.chrome);
        const reserve = Math.max(0, l.chrome.x + l.chrome.w - l.pause.x) + 10;
        panel.style.paddingRight = `${reserve}px`;
      }
      hide(panel, l.chrome.w <= 0 || l.chrome.h <= 0);

      place(pause, l.pause);
      // Radius scales with the key so a 44px pause and a 52px pause look like
      // the same object at two sizes rather than two different objects.
      pause.style.borderRadius = `${Math.max(6, Math.round(l.pause.w * 0.22))}px`;

      const showDpad = l.dpad !== null;
      hide(dpad, !showDpad);
      if (l.dpad !== null) place(dpad, l.dpad);
      applyButtons(l.buttons);
    },

    setPaused(p: boolean): void {
      pause.setAttribute("aria-pressed", p ? "true" : "false");
      pause.setAttribute("aria-label", p ? "Resume" : "Pause");
      pause.textContent = p ? "▶" : "II";
    },

    setPlayers(mask: number): void {
      for (let i = 0; i < lamps.length; i++) {
        (lamps[i] as HTMLElement).dataset["on"] = (mask >> i) & 1 ? "1" : "0";
      }
    },

    setStatus(text: string): void {
      status.textContent = text;
    },

    mountScreen(canvas: HTMLCanvasElement): void {
      // First child, so the console furniture paints over the cart window and
      // never under it. The stacking order is the boundary: the pause button
      // must be reachable even if a cart fills its 128 x 128 with a picture of
      // a pause button.
      root.insertBefore(canvas, root.firstChild);
    },

    destroy(): void {
      pause.removeEventListener("click", onPauseClick);
      root.remove();
    },
  };
}
