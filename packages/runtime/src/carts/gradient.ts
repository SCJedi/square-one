/**
 * The golden-master demo cart.
 *
 * Its job is not to be a game. Its job is to be WRONG VISIBLY and to touch
 * every path whose determinism the frame-hash chain is meant to protect:
 *
 *   the frame counter  -- the gradient's phase advances with it, so a machine
 *                         that increments FRAME at the wrong moment draws a
 *                         picture one band out of step from the golden master
 *   sys.sin            -- the bands are warped by the sine table, so a wrong
 *                         table entry bends the stripes
 *   sys.rnd            -- sparkles, so a PRNG that is not restored exactly by a
 *                         rewind lights up different pixels
 *   input              -- a cursor moved by the d-pad and recoloured by A, so a
 *                         replay that misaligns input by one tick drifts
 *
 * ALL cart state lives in RAM, at USER_RAM. A cart that kept its cursor in a
 * module variable would look fine until the first rewind and then quietly
 * disagree with its own snapshot.
 */

import type { CartApi, CartProgram } from "../machine";
import { ADDR, BTN, SCREEN_H, SCREEN_W } from "../memory";

const CURSOR_X = ADDR.USER_RAM + 0;
const CURSOR_Y = ADDR.USER_RAM + 1;
const CURSOR_C = ADDR.USER_RAM + 2;

export const gradientCart: CartProgram = {
  boot(api: CartApi): void {
    api.sys.poke(CURSOR_X, 60);
    api.sys.poke(CURSOR_Y, 60);
    api.sys.poke(CURSOR_C, 8);
  },

  tick(api: CartApi): void {
    const { gfx, inp, sys } = api;
    const f = sys.frame();

    // One horizontal band per row. The band index is the row plus a phase that
    // advances every other frame, warped by a sine whose argument depends on
    // both the row and the frame -- so the stripes ripple rather than scroll.
    for (let y = 0; y < SCREEN_H; y++) {
      const warp = sys.sin(f * 3 + y * 8) >> 13; // 16.16 in [-1,1] -> [-8, 8]
      gfx.rect(0, y, SCREEN_W, 1, ((y + (f >> 1) + warp) >> 3) & 0x0f, true);
    }

    // Sparkles: twelve pixels per frame, placed by the PRNG. Their positions
    // are a direct read-out of the generator's state, which is what makes a
    // botched snapshot/restore obvious rather than subtle.
    for (let i = 0; i < 12; i++) {
      gfx.pset(sys.rnd(SCREEN_W), sys.rnd(SCREEN_H), 6);
    }

    // The cursor. Held buttons move it, a fresh press of A recolours it.
    let cx = sys.peek(CURSOR_X);
    let cy = sys.peek(CURSOR_Y);
    if (inp.btn(BTN.LEFT) && cx > 0) cx--;
    if (inp.btn(BTN.RIGHT) && cx < SCREEN_W - 8) cx++;
    if (inp.btn(BTN.UP) && cy > 0) cy--;
    if (inp.btn(BTN.DOWN) && cy < SCREEN_H - 8) cy++;
    sys.poke(CURSOR_X, cx);
    sys.poke(CURSOR_Y, cy);

    let cc = sys.peek(CURSOR_C);
    if (inp.btnp(BTN.A)) cc = cc === 0x0f ? 1 : cc + 1;
    sys.poke(CURSOR_C, cc);

    gfx.rect(cx, cy, 8, 8, cc, true);
    gfx.rect(cx - 1, cy - 1, 10, 10, 0, false);
  },
};
