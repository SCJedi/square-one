/**
 * Red Breaker on Prime: the mechanics, and the two guarantees underneath them.
 *
 * EVERY ASSERTION HERE IS ABOUT SIMULATION STATE. Not a pixel, not a display
 * list entry, not a colour. That is not a style preference: `spec/…-spec.html`
 * section 0 moves the normative boundary off the framebuffer and onto the
 * arena, so the arena is the thing a conformance test is allowed to have an
 * opinion about. A test that asserted on a drawn rectangle would be testing the
 * renderer while claiming to test the game, and it would start failing the day
 * somebody made the game look better.
 *
 * The suite drives the real machine -- `createMachine` from `sim.ts`, the real
 * PCG64-DXSM, the real normative sin/cos -- and reads `machine.arena` back. It
 * never reaches inside the cart.
 *
 * WHY `present` IS CALLED IN THE LONG RUNS. The machine seals the arena around
 * `render` and faults on a write. Presenting every tick of the determinism runs
 * therefore proves the read-only rule over 600 frames of real gameplay rather
 * than over one synthetic frame, and it costs about a millisecond a tick.
 */

import { describe, expect, it } from "vitest";

import { BANK_INFO, SFX, SFX_COUNT, createRecordingSnd } from "../src/audio";
import type { RecordingSnd } from "../src/audio";
import { createDraw } from "../src/draw";
import { MUSIC_COUNT } from "../src/music";
import { ChainHasher } from "../src/hash";
import { ARENA_HEADER, CART_BYTES, createMachine, emptyInput } from "../src/sim";
import type { InputFrame, Machine, Ui } from "../src/sim";
import { BTN, KEYMAP, keyboardUi } from "../src/player";
import {
  ADDR,
  BALL_SIZE,
  BEAM_Y,
  BLOCK_H,
  BLOCK_W,
  DEAD_FRAMES,
  FIELD,
  FIELD_TOP,
  MAX_BALLS,
  PADDLE_Y,
  START_LIVES,
  breakoutCart,
} from "../src/carts/breakout";
import { CELLS, GRID_W, LEVELS, LEVEL_COUNT } from "../src/carts/levels";

const { G } = ADDR;

// --- buttons, by the ABI's bit numbering -----------------------------------
const BIT_LEFT = 1 << 2;
const BIT_RIGHT = 1 << 3;
const BIT_A = 1 << 4;
const BIT_B = 1 << 5;

// --- flags, as the cart spells them ----------------------------------------
const ALIVE = 1;
const RED = 2;
const STUCK = 4;

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface Rig {
  machine: Machine;
  /** The cart's own window on the arena -- the same view the cart is handed. */
  mem: DataView;
  input: InputFrame;
  /**
   * Every sound the cart has asked for, stamped with the tick that asked.
   *
   * The same instrument the small console's suite gets by reading the audio
   * registers out of RAM, and it is installed on EVERY rig deliberately: if a
   * recording backend could change what the arena does, the determinism runs
   * below would be running against a different simulation than the silent ones,
   * and one of them would be lying. `sim.test.ts` pins that directly.
   */
  snd: RecordingSnd;
  /** Run `n` ticks with `bits` held throughout. */
  run(n: number, bits?: number): void;
  /** One tick with `bits` held. */
  step(bits?: number): void;
  /** One tick, returning only the effects it fired. */
  heard(bits?: number): number[];
}

function rig(seed = 1n): Rig {
  // The stamp has to be the tick that was running, and the machine does not
  // exist yet when the backend is built -- so the clock is a closure over the
  // binding rather than the value. The cart runs before the counter increments,
  // so a call made during tick 4 reads 4n, exactly as `sim.tick` does inside it.
  let m: Machine | undefined;
  const snd = createRecordingSnd(() => m?.tick ?? -1n);
  const machine = createMachine(breakoutCart, snd);
  m = machine;
  machine.boot(seed);
  const mem = new DataView(machine.arena.buf, ARENA_HEADER, CART_BYTES);
  const input = emptyInput();
  const step = (bits = 0): void => {
    input.buttons[0] = bits;
    machine.step(input);
  };
  return {
    machine,
    mem,
    input,
    snd,
    step,
    run(n: number, bits = 0): void {
      for (let i = 0; i < n; i++) step(bits);
    },
    heard(bits = 0): number[] {
      snd.clear();
      step(bits);
      return [...snd.ids];
    },
  };
}

const g = (m: DataView, slot: number): number => m.getFloat64(slot * 8, true);
const setG = (m: DataView, slot: number, v: number): void => m.setFloat64(slot * 8, v, true);

const ball = (i: number): number => ADDR.BALLS_OFF + i * ADDR.BALL_STRIDE;
const block = (i: number): number => ADDR.BLOCKS_OFF + i * ADDR.BLOCK_STRIDE;
const shot = (i: number): number => ADDR.SHOTS_OFF + i * ADDR.SHOT_STRIDE;

const f64 = (m: DataView, off: number): number => m.getFloat64(off, true);
const put = (m: DataView, off: number, v: number): void => m.setFloat64(off, v, true);

/** Cell index of grid row `r`, column `c`. */
const cell = (r: number, c: number): number => r * GRID_W + c;

/** Every block gone. The host may write the arena; only `render` may not. */
function clearBlocks(m: DataView): void {
  for (let i = 0; i < CELLS; i++) {
    put(m, block(i) + ADDR.K_TYPE, 0);
    put(m, block(i) + ADDR.K_HITS, 0);
  }
}

/**
 * A plain block in the top-left corner, kept alive so a scenario's level cannot
 * clear out from under it.
 *
 * Without it every isolation test is racing the real level-advance path: the
 * tick that breaks the last block also loads the next level, wipes the balls
 * and serves a fresh one, and the assertion afterwards reads the new level's
 * grid and a stationary ball. That is the game behaving correctly and the test
 * asking the wrong question. The corner is above and to the left of everything
 * these scenarios do.
 */
const SENTINEL = cell(0, 0);

function keepSentinel(m: DataView): void {
  put(m, block(SENTINEL) + ADDR.K_TYPE, 1);
  put(m, block(SENTINEL) + ADDR.K_HITS, 1);
}

/** An empty field that still cannot be cleared. */
function isolateField(m: DataView): void {
  clearBlocks(m);
  keepSentinel(m);
}

/** Leave one block standing, of the type and health it loaded with, plus the sentinel. */
function onlyBlock(m: DataView, keep: number): void {
  for (let i = 0; i < CELLS; i++) {
    if (i === keep) continue;
    put(m, block(i) + ADDR.K_TYPE, 0);
    put(m, block(i) + ADDR.K_HITS, 0);
  }
  if (keep !== SENTINEL) keepSentinel(m);
}

/** Kill every ball, so a scenario starts with only the one it places. */
function clearBalls(m: DataView): void {
  for (let i = 0; i < MAX_BALLS; i++) {
    put(m, ball(i) + ADDR.B_FLAGS, 0);
    put(m, ball(i) + ADDR.B_REDT, 0);
  }
}

/** Put a ball in slot 0 at a field position with a velocity and a flag word. */
function placeBall(
  m: DataView,
  x: number,
  y: number,
  vx: number,
  vy: number,
  flagWord = ALIVE,
): void {
  const b = ball(0);
  put(m, b + ADDR.B_X, x);
  put(m, b + ADDR.B_Y, y);
  put(m, b + ADDR.B_PX, x);
  put(m, b + ADDR.B_PY, y);
  put(m, b + ADDR.B_VX, vx);
  put(m, b + ADDR.B_VY, vy);
  put(m, b + ADDR.B_FLAGS, flagWord);
  put(m, b + ADDR.B_REDT, 0);
}

const ballFlagWord = (m: DataView, i = 0): number => f64(m, ball(i) + ADDR.B_FLAGS) | 0;
const isRed = (m: DataView, i = 0): boolean => (ballFlagWord(m, i) & (ALIVE | RED)) === (ALIVE | RED);

/**
 * Walk the real level-advance path until the run is on level `n`.
 *
 * Deliberately not a `setLevel` back door: clearing the grid and letting the
 * cart notice is the same code the game runs, so a test that reached level ten
 * has also proved that the nine advances before it work.
 */
function gotoLevel(r: Rig, n: number): void {
  while ((g(r.mem, G.LEVEL) | 0) < n) {
    clearBlocks(r.mem);
    r.step();
  }
  expect(g(r.mem, G.LEVEL) | 0).toBe(n);
}

/**
 * A hand-shaped input script: a function of the tick index and nothing else.
 *
 * It has to actually PLAY -- serve, sweep, fire -- because the properties under
 * test are about a simulation that is doing something. A script of zeroes would
 * snapshot and restore perfectly while proving nothing, since a ball that never
 * launched never touches the PRNG.
 */
function script(t: number): number {
  let bits = 0;
  if (t % 91 === 7) bits |= BIT_A;
  const phase = t % 173;
  if (phase < 64) bits |= BIT_LEFT;
  else if (phase < 140) bits |= BIT_RIGHT;
  if (t % 47 === 3) bits |= BIT_B;
  return bits;
}

// ---------------------------------------------------------------------------

describe("Red Breaker on Prime -- boot and the paddle", () => {
  it("boots into level one with a full set of lives and a served ball", () => {
    const r = rig();
    expect(g(r.mem, G.LEVEL) | 0).toBe(0);
    expect(g(r.mem, G.LIVES) | 0).toBe(START_LIVES);
    expect(g(r.mem, G.STATE) | 0).toBe(0);
    expect(g(r.mem, G.PAD_W)).toBe(LEVELS[0]!.paddleW);
    // Centred, and the ball is stuck to it waiting for A.
    expect(g(r.mem, G.PAD_X)).toBeCloseTo((FIELD - LEVELS[0]!.paddleW) / 2, 12);
    expect(ballFlagWord(r.mem) & (ALIVE | STUCK)).toBe(ALIVE | STUCK);
  });

  it("ticks without disturbing a waiting serve", () => {
    const r = rig();
    r.run(60);
    expect(r.machine.tick).toBe(60n);
    expect(ballFlagWord(r.mem) & STUCK).toBe(STUCK);
    expect(g(r.mem, G.LIVES) | 0).toBe(START_LIVES);
  });

  it("moves the paddle and clamps it to both walls", () => {
    const r = rig();
    const start = g(r.mem, G.PAD_X);

    r.run(10, BIT_RIGHT);
    expect(g(r.mem, G.PAD_X)).toBeGreaterThan(start);

    r.run(200, BIT_LEFT);
    expect(g(r.mem, G.PAD_X)).toBe(0);

    r.run(200, BIT_RIGHT);
    expect(g(r.mem, G.PAD_X)).toBe(FIELD - g(r.mem, G.PAD_W));
  });

  it("never exceeds the paddle's top speed, easing or not", () => {
    const r = rig();
    let last = g(r.mem, G.PAD_X);
    for (let i = 0; i < 120; i++) {
      r.step(BIT_RIGHT);
      const now = g(r.mem, G.PAD_X);
      expect(now - last).toBeLessThanOrEqual(1.75 + 1e-9);
      last = now;
    }
  });
});

describe("the ball", () => {
  it("bounces off the left wall, the right wall and the ceiling", () => {
    const r = rig();
    isolateField(r.mem);
    clearBalls(r.mem);

    placeBall(r.mem, 0.5, 60, -2, 0);
    r.step();
    expect(f64(r.mem, ball(0) + ADDR.B_VX)).toBeGreaterThan(0);
    expect(f64(r.mem, ball(0) + ADDR.B_X)).toBeGreaterThanOrEqual(0);

    placeBall(r.mem, FIELD - BALL_SIZE - 0.5, 60, 2, 0);
    r.step();
    expect(f64(r.mem, ball(0) + ADDR.B_VX)).toBeLessThan(0);
    expect(f64(r.mem, ball(0) + ADDR.B_X) + BALL_SIZE).toBeLessThanOrEqual(FIELD);

    placeBall(r.mem, 60, 9, 0, -2);
    r.step();
    expect(f64(r.mem, ball(0) + ADDR.B_VY)).toBeGreaterThan(0);
  });

  it("breaks a plain block and bounces off it", () => {
    const r = rig();
    // Level one is four rows of type 1. Keep one and take the rest away.
    const keep = cell(2, 4);
    onlyBlock(r.mem, keep);
    expect(f64(r.mem, block(keep) + ADDR.K_TYPE) | 0).toBe(1);
    clearBalls(r.mem);

    const bx = (keep % GRID_W) * BLOCK_W + 2;
    const by = FIELD_TOP + Math.floor(keep / GRID_W) * BLOCK_H + BLOCK_H + 1;
    placeBall(r.mem, bx, by, 0, -2);
    r.step();

    expect(f64(r.mem, block(keep) + ADDR.K_TYPE) | 0).toBe(0);
    expect(f64(r.mem, ball(0) + ADDR.B_VY)).toBeGreaterThan(0);
  });

  it("takes three hits to break a three-hit block, and shows two of them", () => {
    const r = rig();
    gotoLevel(r, 3); // level four: the one that introduces tough blocks
    expect(LEVELS[3]!.mechanic).toBeGreaterThanOrEqual(3);

    const tough = cell(4, 3); // a type-3 block in the hard course
    const spare = cell(6, 8); // something plain, so the level cannot clear
    expect(f64(r.mem, block(tough) + ADDR.K_TYPE) | 0).toBe(3);
    expect(f64(r.mem, block(tough) + ADDR.K_HITS)).toBe(3);

    for (let i = 0; i < CELLS; i++) {
      if (i === tough || i === spare) continue;
      put(r.mem, block(i) + ADDR.K_TYPE, 0);
      put(r.mem, block(i) + ADDR.K_HITS, 0);
    }
    clearBalls(r.mem);

    const bx = (tough % GRID_W) * BLOCK_W + 2;
    const by = FIELD_TOP + Math.floor(tough / GRID_W) * BLOCK_H + BLOCK_H + 1;

    placeBall(r.mem, bx, by, 0, -2);
    r.step();
    expect(f64(r.mem, block(tough) + ADDR.K_HITS)).toBe(2);
    expect(f64(r.mem, block(tough) + ADDR.K_TYPE) | 0).toBe(3);

    placeBall(r.mem, bx, by, 0, -2);
    r.step();
    expect(f64(r.mem, block(tough) + ADDR.K_HITS)).toBe(1);
    expect(f64(r.mem, block(tough) + ADDR.K_TYPE) | 0).toBe(3);

    placeBall(r.mem, bx, by, 0, -2);
    r.step();
    expect(f64(r.mem, block(tough) + ADDR.K_TYPE) | 0).toBe(0);
    // The spare kept the level alive, so this is still level four.
    expect(g(r.mem, G.LEVEL) | 0).toBe(3);
  });
});

// ===========================================================================
// THE RED BALL. The game is this section; everything above it is breakout.
// ===========================================================================

describe("the red ball", () => {
  /** Level two: the level built around a single type-4 block at row 2, col 2. */
  function levelTwoWithOnlyTheRedBlock(): { r: Rig; red: number } {
    const r = rig();
    gotoLevel(r, 1);
    const red = cell(2, 2);
    expect(f64(r.mem, block(red) + ADDR.K_TYPE) | 0).toBe(4);
    onlyBlock(r.mem, red);
    clearBalls(r.mem);
    return { r, red };
  }

  it("RULE 1: breaking a type-4 block turns the ball RED", () => {
    const { r, red } = levelTwoWithOnlyTheRedBlock();
    expect(LEVELS[1]!.mechanic).toBeGreaterThanOrEqual(1);

    const bx = (red % GRID_W) * BLOCK_W + 2;
    const by = FIELD_TOP + Math.floor(red / GRID_W) * BLOCK_H + BLOCK_H + 1;
    placeBall(r.mem, bx, by, 0, -2);
    expect(isRed(r.mem)).toBe(false);

    r.step();

    expect(f64(r.mem, block(red) + ADDR.K_TYPE) | 0).toBe(0);
    expect(isRed(r.mem)).toBe(true);
  });

  it("RULE 3: a RED ball on the PADDLE destroys it and costs a life", () => {
    const r = rig();
    gotoLevel(r, 1);
    clearBalls(r.mem);
    setG(r.mem, G.PAD_X, 40);
    const pw = g(r.mem, G.PAD_W);

    // Dropping onto the middle of the paddle.
    placeBall(r.mem, 40 + pw / 2, PADDLE_Y - BALL_SIZE - 1, 0, 2, ALIVE | RED);
    r.step();

    expect(g(r.mem, G.LIVES) | 0).toBe(START_LIVES - 1);
    expect(g(r.mem, G.DEAD_T)).toBe(DEAD_FRAMES);
    // The ball that did it is gone, and no ball anywhere is still RED.
    for (let i = 0; i < MAX_BALLS; i++) expect(isRed(r.mem, i)).toBe(false);
  });

  it("the destruction holds the whole simulation still for its own length", () => {
    const r = rig();
    gotoLevel(r, 1);
    clearBalls(r.mem);
    setG(r.mem, G.PAD_X, 40);
    placeBall(r.mem, 40 + g(r.mem, G.PAD_W) / 2, PADDLE_Y - BALL_SIZE - 1, 0, 2, ALIVE | RED);
    r.step();

    const parked = g(r.mem, G.PAD_X);
    // Full left for the whole pause: the paddle may not move, and A may not
    // serve, until the beat has landed.
    r.run(DEAD_FRAMES - 1, BIT_LEFT | BIT_A);
    expect(g(r.mem, G.PAD_X)).toBe(parked);
    expect(ballFlagWord(r.mem, 0) & STUCK).toBe(STUCK);

    r.step();
    expect(g(r.mem, G.DEAD_T)).toBe(0);
    r.run(3, BIT_LEFT);
    expect(g(r.mem, G.PAD_X)).toBeLessThan(parked);
  });

  // =======================================================================
  // RULE 4: THE WRECKING BALL. A red ball is not dangerous for one contact any
  // more -- it is CLEARING THE LEVEL, and the player wants it alive.
  // =======================================================================
  it("RULE 4: a RED ball PLOUGHS a block -- it breaks, and the ball does not turn", () => {
    const r = rig();
    gotoLevel(r, 1);
    const keep = cell(3, 6);
    onlyBlock(r.mem, keep);
    clearBalls(r.mem);

    const bx = (keep % GRID_W) * BLOCK_W + 2;
    const by = FIELD_TOP + Math.floor(keep / GRID_W) * BLOCK_H + BLOCK_H + 1;
    placeBall(r.mem, bx, by, 0, -2, ALIVE | RED);
    r.step();

    expect(f64(r.mem, block(keep) + ADDR.K_TYPE) | 0, "the block is gone").toBe(0);
    expect(f64(r.mem, ball(0) + ADDR.B_VY), "and the ball never turned").toBe(-2);
    expect(isRed(r.mem), "and it is still RED").toBe(true);
  });

  it("RULE 4: a three-hit block goes in ONE pass, whatever it had left", () => {
    // The hits are the block's defence against a NORMAL ball. A red ball does
    // not spend them one at a time; it takes the block.
    const r = rig();
    gotoLevel(r, 3); // MECH_TOUGH, so a type-3 block really does take three
    const keep = cell(3, 6);
    onlyBlock(r.mem, keep);
    put(r.mem, block(keep) + ADDR.K_TYPE, 3);
    put(r.mem, block(keep) + ADDR.K_HITS, 3);
    clearBalls(r.mem);

    const bx = (keep % GRID_W) * BLOCK_W + 2;
    const by = FIELD_TOP + Math.floor(keep / GRID_W) * BLOCK_H + BLOCK_H + 1;
    placeBall(r.mem, bx, by, 0, -2, ALIVE | RED);
    r.step();

    expect(f64(r.mem, block(keep) + ADDR.K_TYPE) | 0, "all three hits at once").toBe(0);
    expect(f64(r.mem, ball(0) + ADDR.B_VY), "and it kept going").toBe(-2);
    expect(isRed(r.mem)).toBe(true);
  });

  it("RULE 4: it stays RED through a whole column of blocks", () => {
    const r = rig();
    gotoLevel(r, 1);
    clearBlocks(r.mem);
    keepSentinel(r.mem);
    const col = 6;
    for (let row = 2; row <= 6; row++) {
      put(r.mem, block(cell(row, col)) + ADDR.K_TYPE, 1);
      put(r.mem, block(cell(row, col)) + ADDR.K_HITS, 1);
    }
    clearBalls(r.mem);
    placeBall(r.mem, col * BLOCK_W + 2, FIELD_TOP + 7 * BLOCK_H + 1, 0, -2, ALIVE | RED);
    r.run(30);

    for (let row = 2; row <= 6; row++) {
      const t = f64(r.mem, block(cell(row, col)) + ADDR.K_TYPE) | 0;
      expect(t, `row ${row} was ploughed`).toBe(0);
    }
    expect(isRed(r.mem), "and it came out the far side still RED").toBe(true);
  });

  it("RULE 5: a WALL and the CEILING bounce it, and it STAYS RED", () => {
    const r = rig();
    gotoLevel(r, 1);
    isolateField(r.mem);
    clearBalls(r.mem);

    placeBall(r.mem, 0.5, 60, -2, 0, ALIVE | RED);
    r.step();
    expect(f64(r.mem, ball(0) + ADDR.B_VX)).toBeGreaterThan(0);
    expect(isRed(r.mem), "still RED after a wall").toBe(true);
    expect(ballFlagWord(r.mem) & ALIVE).toBe(ALIVE);

    placeBall(r.mem, 60, 9, 0, -2, ALIVE | RED);
    r.step();
    expect(f64(r.mem, ball(0) + ADDR.B_VY)).toBeGreaterThan(0);
    expect(isRed(r.mem), "still RED after the ceiling").toBe(true);
  });

  it("RULE 6: a SOLID and a SHIELDED block bounce it, and it STAYS RED", () => {
    // This is what keeps level eight's shielded wall standing. A red ball that
    // ate those two would clear the one level built to REQUIRE the gun.
    for (const t of [5, 6]) {
      const r = rig();
      gotoLevel(r, 7); // MECH_SHIELD, so a type-6 block is really shielded
      const keep = cell(3, 6);
      onlyBlock(r.mem, keep);
      put(r.mem, block(keep) + ADDR.K_TYPE, t);
      put(r.mem, block(keep) + ADDR.K_HITS, 1);
      clearBalls(r.mem);

      const bx = (keep % GRID_W) * BLOCK_W + 2;
      const by = FIELD_TOP + Math.floor(keep / GRID_W) * BLOCK_H + BLOCK_H + 1;
      placeBall(r.mem, bx, by, 0, -2, ALIVE | RED);
      r.step();

      expect(f64(r.mem, block(keep) + ADDR.K_TYPE) | 0, `type ${t} still stands`).toBe(t);
      expect(f64(r.mem, ball(0) + ADDR.B_VY), "the ball came back down").toBeGreaterThan(0);
      expect(isRed(r.mem), `still RED off a type-${t} block`).toBe(true);
    }
  });

  it("RULE 7: the BEAM deflects a RED ball and returns it to normal", () => {
    const r = rig();
    gotoLevel(r, 1);
    isolateField(r.mem);
    clearBalls(r.mem);
    // The paddle is out of the way -- which is the whole point of the mechanic.
    setG(r.mem, G.PAD_X, 0);

    placeBall(r.mem, 60, BEAM_Y - 2, 0, 2, ALIVE | RED);
    r.step();

    expect(f64(r.mem, ball(0) + ADDR.B_VY)).toBeLessThan(0);
    // Snapped to the beam's top face and then carried away from it by the rest
    // of the frame's substeps, which is a deflection rather than a teleport.
    expect(f64(r.mem, ball(0) + ADDR.B_Y)).toBeLessThanOrEqual(BEAM_Y - BALL_SIZE);
    expect(isRed(r.mem)).toBe(false);
    expect(ballFlagWord(r.mem) & ALIVE).toBe(ALIVE);
  });

  it("a SHOT does nothing to a RED ball", () => {
    // A shot used to be the skilled way out of the panic window. Rule 7 made
    // the beam the only clear, so the gun is a gun and the shot goes past.
    const r = rig();
    gotoLevel(r, 1);
    isolateField(r.mem);
    clearBalls(r.mem);

    placeBall(r.mem, 60, 60, 0, 0, ALIVE | RED);
    const s = shot(0);
    put(r.mem, s + ADDR.S_X, 60);
    put(r.mem, s + ADDR.S_Y, 66);
    put(r.mem, s + ADDR.S_LIVE, 1);

    r.step();

    expect(isRed(r.mem), "still RED").toBe(true);
    expect(f64(r.mem, ball(0) + ADDR.B_VX), "and undeflected").toBe(0);
    expect(f64(r.mem, ball(0) + ADDR.B_VY)).toBe(0);
    expect(f64(r.mem, s + ADDR.S_LIVE), "the shot flew straight through").toBe(1);
  });

  it("THE BEAM IS THE ONLY CLEAR: every other contact leaves it RED", () => {
    // Rule 7 written as one run of assertions, because it is the rule the rest
    // of the cart has to keep out of the way of.
    const r = rig();
    gotoLevel(r, 1);
    setG(r.mem, G.PAD_X, 0);

    const keep = cell(3, 6);
    const bx = (keep % GRID_W) * BLOCK_W + 2;
    const by = FIELD_TOP + Math.floor(keep / GRID_W) * BLOCK_H + BLOCK_H + 1;

    onlyBlock(r.mem, keep);
    clearBalls(r.mem);
    placeBall(r.mem, bx, by, 0, -2, ALIVE | RED);
    r.step();
    expect(isRed(r.mem), "after ploughing a block").toBe(true);

    placeBall(r.mem, 0.5, 60, -2, 0, ALIVE | RED);
    r.step();
    expect(isRed(r.mem), "after a wall").toBe(true);

    placeBall(r.mem, 60, 9, 0, -2, ALIVE | RED);
    r.step();
    expect(isRed(r.mem), "after the ceiling").toBe(true);

    put(r.mem, block(keep) + ADDR.K_TYPE, 5);
    put(r.mem, block(keep) + ADDR.K_HITS, 1);
    placeBall(r.mem, bx, by, 0, -2, ALIVE | RED);
    r.step();
    expect(isRed(r.mem), "after a solid block").toBe(true);

    placeBall(r.mem, 60, BEAM_Y - 2, 0, 2, ALIVE | RED);
    r.step();
    expect(isRed(r.mem), "and ONLY the beam cleared it").toBe(false);
  });

  it("a RED ball stays dangerous until the beam takes it", () => {
    const r = rig();
    gotoLevel(r, 1);
    isolateField(r.mem);
    clearBalls(r.mem);
    setG(r.mem, G.PAD_X, 0);

    // It bounces off a wall -- and is STILL a paddle-killer afterwards, which
    // is the whole of what changed about the mechanic.
    placeBall(r.mem, 0.5, PADDLE_Y - BALL_SIZE - 6, -2, 2, ALIVE | RED);
    r.step();
    expect(isRed(r.mem)).toBe(true);

    const lives = g(r.mem, G.LIVES) | 0;
    placeBall(r.mem, 8, PADDLE_Y - BALL_SIZE - 1, 0, 2, ALIVE | RED);
    r.step();
    expect(g(r.mem, G.LIVES) | 0, "and the paddle went with it").toBe(lives - 1);
  });
});

// ===========================================================================

describe("levels", () => {
  it("advances when every breakable block is gone", () => {
    const r = rig();
    expect(g(r.mem, G.LEVEL) | 0).toBe(0);
    clearBlocks(r.mem);
    r.step();
    expect(g(r.mem, G.LEVEL) | 0).toBe(1);
    // The new level's grid is installed, not merely the counter bumped.
    let live = 0;
    for (let i = 0; i < CELLS; i++) if (f64(r.mem, block(i) + ADDR.K_TYPE) | 0) live++;
    expect(live).toBeGreaterThan(0);
  });

  it("a type-5 solid block is scenery and does not hold the level open", () => {
    const r = rig();
    clearBlocks(r.mem);
    put(r.mem, block(cell(3, 3)) + ADDR.K_TYPE, 5);
    put(r.mem, block(cell(3, 3)) + ADDR.K_HITS, 1);
    r.step();
    expect(g(r.mem, G.LEVEL) | 0).toBe(1);
  });

  it("a type-6 shielded block DOES count, which is what makes the gun required", () => {
    const r = rig();
    clearBlocks(r.mem);
    put(r.mem, block(cell(3, 3)) + ADDR.K_TYPE, 6);
    put(r.mem, block(cell(3, 3)) + ADDR.K_HITS, 1);
    r.run(5);
    expect(g(r.mem, G.LEVEL) | 0).toBe(0);
  });

  it("clearing the last level ends the run as a win rather than reading an eleventh header", () => {
    const r = rig();
    gotoLevel(r, LEVEL_COUNT - 1);
    clearBlocks(r.mem);
    r.step();
    expect(g(r.mem, G.STATE) | 0).toBe(2);
    expect(g(r.mem, G.LEVEL) | 0).toBe(LEVEL_COUNT - 1);
  });

  it("runs out of lives into GAME OVER, and A starts a fresh run", () => {
    const r = rig();
    for (let life = 0; life < START_LIVES; life++) {
      clearBalls(r.mem);
      r.step(); // no ball alive -> a life goes
    }
    expect(g(r.mem, G.STATE) | 0).toBe(1);
    expect(g(r.mem, G.LIVES) | 0).toBe(0);

    r.step(BIT_A);
    r.step();
    expect(g(r.mem, G.STATE) | 0).toBe(0);
    expect(g(r.mem, G.LIVES) | 0).toBe(START_LIVES);
    expect(g(r.mem, G.LEVEL) | 0).toBe(0);
  });
});

describe("the gun and the side pads", () => {
  it("charges a shot on ARRIVING at a pad, not for every frame parked on one", () => {
    const r = rig();
    gotoLevel(r, 4); // the level that introduces the pads
    expect(LEVELS[4]!.sidePads).toBe(1);
    setG(r.mem, G.AMMO, 0);
    setG(r.mem, G.PAD_TOUCH, 0);
    setG(r.mem, G.PAD_X, 40);

    r.run(120, BIT_LEFT); // slide into the left pad and sit on it
    expect(g(r.mem, G.PAD_X)).toBe(0);
    expect(g(r.mem, G.AMMO) | 0).toBe(1);
  });

  it("fires, spends a shot, and breaks a shielded block a ball cannot", () => {
    const r = rig();
    gotoLevel(r, 7); // the level that introduces shielded blocks
    const shield = cell(3, 6);
    expect(f64(r.mem, block(shield) + ADDR.K_TYPE) | 0).toBe(6);
    onlyBlock(r.mem, shield);
    clearBalls(r.mem);

    // A ball bounces off it and leaves it standing.
    const bx = (shield % GRID_W) * BLOCK_W + 2;
    const by = FIELD_TOP + Math.floor(shield / GRID_W) * BLOCK_H + BLOCK_H + 1;
    placeBall(r.mem, bx, by, 0, -2);
    r.step();
    expect(f64(r.mem, block(shield) + ADDR.K_TYPE) | 0).toBe(6);
    clearBalls(r.mem);

    // A shot does not.
    const s = shot(0);
    put(r.mem, s + ADDR.S_X, bx);
    put(r.mem, s + ADDR.S_Y, by);
    put(r.mem, s + ADDR.S_LIVE, 1);
    r.step();
    expect(f64(r.mem, block(shield) + ADDR.K_TYPE) | 0).toBe(0);
  });

  it("B fires only with ammunition, and spends exactly one", () => {
    const r = rig();
    gotoLevel(r, 7);
    setG(r.mem, G.AMMO, 2);
    r.step(BIT_B);
    expect(g(r.mem, G.AMMO) | 0).toBe(1);
    let live = 0;
    for (let i = 0; i < 4; i++) if (f64(r.mem, shot(i) + ADDR.S_LIVE)) live++;
    expect(live).toBe(1);

    setG(r.mem, G.AMMO, 0);
    r.step(); // release
    r.step(BIT_B);
    expect(g(r.mem, G.AMMO) | 0).toBe(0);
  });
});

// ===========================================================================
// The two guarantees
// ===========================================================================

describe("determinism", () => {
  it("render writes nothing: 600 presented frames of real play and no fault", () => {
    const r = rig(11n);
    const draw = createDraw();
    for (let t = 0; t < 600; t++) {
      r.step(script(Number(r.machine.tick)));
      draw.begin();
      // The machine seals the arena around this and throws if it changed.
      r.machine.present(draw, (t % 6) / 6);
    }
    expect(draw.count).toBeGreaterThan(0);
    // The scene actually uses the layers it claims to.
    let used = 0;
    for (let i = 0; i < draw.list.layerCount.length; i++) {
      if ((draw.list.layerCount[i] as number) > 0) used++;
    }
    expect(used).toBeGreaterThanOrEqual(6);
  });

  it("snapshot, 300 ticks, restore, 300 ticks -- byte-identical arenas", () => {
    const r = rig(1234n);
    const draw = createDraw();

    // Play far enough in that there is real state: a launched ball, broken
    // blocks, particles in flight, a PRNG that has been drawn from.
    for (let t = 0; t < 200; t++) r.step(script(Number(r.machine.tick)));

    const snap = r.machine.snapshot();

    const runThreeHundred = (): Uint8Array => {
      for (let t = 0; t < 300; t++) {
        r.step(script(Number(r.machine.tick)));
        draw.begin();
        r.machine.present(draw, 0.5);
      }
      return r.machine.snapshot();
    };

    const first = runThreeHundred();
    r.machine.restore(snap);
    const second = runThreeHundred();

    expect(second.length).toBe(first.length);
    // Report the first differing byte rather than "arrays are not equal": a
    // divergence is only actionable if you know where it is.
    let at = -1;
    for (let i = 0; i < first.length; i++) {
      if (first[i] !== second[i]) {
        at = i;
        break;
      }
    }
    expect(at).toBe(-1);
  });

  it("snapshot and restore stay byte-identical with a RED ball mid-plough", () => {
    // The wrecking ball moves the largest amount of state this cart has: the
    // block grid, the particle pool, the ring pool, the PRNG that feeds both,
    // and the ball's own flags -- all of it changing every tick. A snapshot
    // taken INSIDE the plough is the strongest form of the containment claim.
    const r = rig(77n);
    gotoLevel(r, 1);
    clearBlocks(r.mem);
    keepSentinel(r.mem);
    for (let row = 2; row <= 8; row++) {
      for (let c = 4; c <= 9; c++) {
        put(r.mem, block(cell(row, c)) + ADDR.K_TYPE, 1);
        put(r.mem, block(cell(row, c)) + ADDR.K_HITS, 1);
      }
    }
    clearBalls(r.mem);
    placeBall(r.mem, 6 * BLOCK_W + 2, FIELD_TOP + 9 * BLOCK_H, 0, -2, ALIVE | RED);
    r.run(4);
    expect(isRed(r.mem), "a RED ball, inside the wall").toBe(true);

    const snap = r.machine.snapshot();
    const draw = createDraw();
    const leg = (): Uint8Array => {
      for (let t = 0; t < 120; t++) {
        r.step(script(Number(r.machine.tick)));
        draw.begin();
        r.machine.present(draw, 0.5);
      }
      return r.machine.snapshot();
    };

    const first = leg();
    r.machine.restore(snap);
    const second = leg();

    expect(second.length).toBe(first.length);
    let at = -1;
    for (let i = 0; i < first.length; i++) {
      if (first[i] !== second[i]) {
        at = i;
        break;
      }
    }
    expect(at).toBe(-1);
  });

  it("two runs of the same seed and the same replay produce the same chain", () => {
    const TICKS = 240;
    const SEED = 0xbeefn;

    const run = (): { chain: string; hashes: string[] } => {
      const machine = createMachine(breakoutCart);
      machine.boot(SEED);
      const input = emptyInput();
      const hasher = new ChainHasher();
      const hashes: string[] = [];
      for (let t = 0; t < TICKS; t++) {
        input.buttons[0] = script(t);
        machine.step(input);
        hashes.push(hasher.push(machine.arena.bytes));
      }
      return { chain: hasher.digest, hashes };
    };

    const a = run();
    const b = run();

    expect(a.hashes.length).toBe(TICKS);
    expect(b.chain).toBe(a.chain);
    // Per tick as well, so a future divergence says WHICH tick.
    let firstDiff = -1;
    for (let i = 0; i < TICKS; i++) {
      if (a.hashes[i] !== b.hashes[i]) {
        firstDiff = i;
        break;
      }
    }
    expect(firstDiff).toBe(-1);
    // A chain over a run that actually did something is not the empty chain.
    expect(a.chain).not.toBe("0".repeat(64));
  });

  it("a different seed is a different run", () => {
    const chainFor = (seed: bigint): string => {
      const machine = createMachine(breakoutCart);
      machine.boot(seed);
      const input = emptyInput();
      const hasher = new ChainHasher();
      for (let t = 0; t < 90; t++) {
        input.buttons[0] = script(t);
        machine.step(input);
        hasher.push(machine.arena.bytes);
      }
      return hasher.digest;
    };
    expect(chainFor(2n)).not.toBe(chainFor(3n));
  });
});

// ===========================================================================
// SOUND
//
// Every assertion here reads the RECORDING BACKEND, which is the same
// instrument the small console's suite gets by reading the audio registers out
// of RAM: which effect, on which tick, in which order. Nothing here plays
// anything, and nothing here can: audio is non-normative, so the one property
// the simulation owns is WHEN a cart emits, and that is exactly what a recorded
// call is.
// ===========================================================================

describe("sound -- the seventeen events", () => {
  /** Level two, cleared down to the single type-4 block at row 2, col 2. */
  function redBlockRig(): { r: Rig; red: number } {
    const r = rig();
    gotoLevel(r, 1);
    const red = cell(2, 2);
    expect(f64(r.mem, block(red) + ADDR.K_TYPE) | 0).toBe(4);
    onlyBlock(r.mem, red);
    clearBalls(r.mem);
    return { r, red };
  }

  /** Which channel the bank puts an effect on -- the interruption rule. */
  const BANK_CH = (id: number): number => BANK_INFO[id]?.ch ?? -1;

  /** Put a ball just under block `i`, travelling up into it. */
  function underBlock(r: Rig, i: number, flagWord = ALIVE): void {
    const bx = (i % GRID_W) * BLOCK_W + 2;
    const by = FIELD_TOP + Math.floor(i / GRID_W) * BLOCK_H + BLOCK_H + 1;
    placeBall(r.mem, bx, by, 0, -2, flagWord);
  }

  // =========================================================================
  // THE ONE THIS WHOLE FILE EXISTS FOR
  // =========================================================================
  it("fires the alarm on the SAME TICK the RED bit is set", () => {
    const { r, red } = redBlockRig();
    underBlock(r, red);
    expect(isRed(r.mem)).toBe(false);

    const heard = r.heard();

    // Both, in one step. The sound and the state cannot have drifted apart,
    // because there is no tick in between them to drift in -- they are two
    // statements inside one `if`, and this is the assertion that keeps them
    // there. A cue fired from a later reading of the flag would pass a test
    // that only asked "does the alarm ever play".
    expect(isRed(r.mem)).toBe(true);
    expect(heard).toContain(SFX.RED);

    const alarm = r.snd.calls.find((c) => c.id === SFX.RED);
    expect(alarm?.tick).toBe(r.machine.tick - 1n);

    // And the break is heard first: the block came apart, and THEN the warning.
    expect(heard.indexOf(SFX.BREAK)).toBeLessThan(heard.indexOf(SFX.RED));
  });

  it("does not fire the alarm on a level where a red block is only a block", () => {
    // Level one's mechanic is 0, so breaking a type-4 block there turns nothing
    // red. The cue has to be absent for the same reason the bit is.
    const r = rig();
    const red = cell(2, 2);
    put(r.mem, block(red) + ADDR.K_TYPE, 4);
    put(r.mem, block(red) + ADDR.K_HITS, 1);
    onlyBlock(r.mem, red);
    clearBalls(r.mem);
    underBlock(r, red);

    const heard = r.heard();
    expect(isRed(r.mem)).toBe(false);
    expect(heard).toContain(SFX.BREAK);
    expect(heard).not.toContain(SFX.RED);
  });

  it("tells a block that survived from a block that broke", () => {
    const r = rig();
    gotoLevel(r, 3); // the level that makes type-2 and type-3 blocks tough
    const tough = cell(2, 4);
    put(r.mem, block(tough) + ADDR.K_TYPE, 3);
    put(r.mem, block(tough) + ADDR.K_HITS, 3);
    onlyBlock(r.mem, tough);
    clearBalls(r.mem);

    underBlock(r, tough);
    expect(r.heard()).toEqual([SFX.HIT]);
    expect(f64(r.mem, block(tough) + ADDR.K_HITS)).toBe(2);
  });

  it("fires the wall cue off a side wall and off the ceiling, and never off a block", () => {
    const r = rig();
    gotoLevel(r, 1);
    isolateField(r.mem);
    clearBalls(r.mem);

    placeBall(r.mem, 0.5, 60, -2, 0);
    expect(r.heard()).toEqual([SFX.WALL]);

    clearBalls(r.mem);
    placeBall(r.mem, 60, 9, 0, -2);
    expect(r.heard()).toEqual([SFX.WALL]);

    // A block is a contact too, and it comes through `bounce` rather than
    // `edge`. If the wall cue had been put inside `bounce` it would play here as
    // well, on top of every block hit in the game.
    const keep = cell(3, 6);
    onlyBlock(r.mem, keep);
    clearBalls(r.mem);
    underBlock(r, keep);
    expect(r.heard()).not.toContain(SFX.WALL);
  });

  it("fires the paddle cue on a return, and nothing at all on a catch", () => {
    const r = rig();
    gotoLevel(r, 1);
    isolateField(r.mem);
    clearBalls(r.mem);
    setG(r.mem, G.PAD_X, 40);
    const pw = g(r.mem, G.PAD_W);

    placeBall(r.mem, 40 + pw / 2, PADDLE_Y - BALL_SIZE - 1, 0, 2);
    expect(r.heard()).toEqual([SFX.PADDLE]);

    // With `catch` running the ball sticks instead of returning, and a stuck
    // ball was not returned: the cue means what it says.
    clearBalls(r.mem);
    setG(r.mem, G.CATCH_T, 60);
    placeBall(r.mem, 40 + pw / 2, PADDLE_Y - BALL_SIZE - 1, 0, 2);
    expect(r.heard()).toEqual([]);
    expect(ballFlagWord(r.mem) & STUCK).toBe(STUCK);
  });

  it("fires the deflection when the beam catches a RED ball", () => {
    const r = rig();
    gotoLevel(r, 1);
    isolateField(r.mem);
    clearBalls(r.mem);
    setG(r.mem, G.PAD_X, 0);

    placeBall(r.mem, 60, BEAM_Y - 2, 0, 2, ALIVE | RED);
    const heard = r.heard();

    expect(heard).toEqual([SFX.DEFLECT]);
    expect(isRed(r.mem)).toBe(false);
    // The deflection and the alarm share a channel on purpose, so this cue is
    // what interrupts the warning. See `audio.ts`.
    expect(BANK_CH(SFX.DEFLECT)).toBe(BANK_CH(SFX.RED));
  });

  // =========================================================================
  // TWO EVENTS THAT MUST NEVER SOUND THE SAME
  // =========================================================================
  it("gives the paddle being destroyed and a ball rolling out different cues", () => {
    const smash = rig();
    gotoLevel(smash, 1);
    clearBalls(smash.mem);
    setG(smash.mem, G.PAD_X, 40);
    placeBall(
      smash.mem,
      40 + g(smash.mem, G.PAD_W) / 2,
      PADDLE_Y - BALL_SIZE - 1,
      0,
      2,
      ALIVE | RED,
    );
    const onSmash = smash.heard();
    expect(onSmash).toContain(SFX.SMASH);
    expect(onSmash).not.toContain(SFX.LOSE);

    const lost = rig();
    gotoLevel(lost, 1);
    isolateField(lost.mem);
    clearBalls(lost.mem);
    setG(lost.mem, G.PAD_X, 0);
    placeBall(lost.mem, 60, FIELD - 1, 0, 2);
    const onLose = lost.heard();
    expect(onLose).toContain(SFX.LOSE);
    expect(onLose).not.toContain(SFX.SMASH);
  });

  it("plays the game-over cue on the last life and not on the others", () => {
    const r = rig();
    const overs: bigint[] = [];
    for (let life = 0; life < START_LIVES; life++) {
      clearBalls(r.mem);
      r.snd.clear();
      r.step();
      for (const c of r.snd.calls) if (c.id === SFX.OVER) overs.push(c.tick);
    }
    expect(g(r.mem, G.STATE) | 0).toBe(1);
    // Once, on the tick the last life went.
    expect(overs.length).toBe(1);
    expect(overs[0]).toBe(r.machine.tick - 1n);
  });

  it("fires the level-clear cue on every level INCLUDING the last", () => {
    const r = rig();
    clearBlocks(r.mem);
    expect(r.heard()).toContain(SFX.CLEAR);
    expect(g(r.mem, G.LEVEL) | 0).toBe(1);

    gotoLevel(r, LEVEL_COUNT - 1);
    clearBlocks(r.mem);
    const heard = r.heard();
    expect(g(r.mem, G.STATE) | 0).toBe(2);
    // Winning must not be the one clear a player never hears.
    expect(heard).toContain(SFX.CLEAR);
  });

  it("fires the gun's three cues: the shot, the shield holding, and the shield going", () => {
    const r = rig();
    gotoLevel(r, 7);
    const shield = cell(3, 6);
    expect(f64(r.mem, block(shield) + ADDR.K_TYPE) | 0).toBe(6);
    onlyBlock(r.mem, shield);
    clearBalls(r.mem);

    setG(r.mem, G.AMMO, 2);
    expect(r.heard(BIT_B)).toContain(SFX.SHOOT);

    clearBalls(r.mem);
    underBlock(r, shield);
    expect(r.heard()).toContain(SFX.PING);
    expect(f64(r.mem, block(shield) + ADDR.K_TYPE) | 0).toBe(6);

    clearBalls(r.mem);
    const s = shot(0);
    put(r.mem, s + ADDR.S_X, (shield % GRID_W) * BLOCK_W + 2);
    put(r.mem, s + ADDR.S_Y, FIELD_TOP + Math.floor(shield / GRID_W) * BLOCK_H + BLOCK_H + 1);
    put(r.mem, s + ADDR.S_LIVE, 1);
    const heard = r.heard();
    expect(heard).toContain(SFX.SHIELD);
    expect(heard).not.toContain(SFX.BREAK);
  });

  it("charges the side pad once per arrival, cue and ammunition together", () => {
    const r = rig();
    gotoLevel(r, 4);
    setG(r.mem, G.AMMO, 0);
    setG(r.mem, G.PAD_TOUCH, 0);
    setG(r.mem, G.PAD_X, 40);

    r.snd.clear();
    r.run(120, BIT_LEFT);
    const charges = r.snd.calls.filter((c) => c.id === SFX.CHARGE).length;
    expect(g(r.mem, G.AMMO) | 0).toBe(1);
    expect(charges).toBe(1);
  });

  it("announces a drop appearing, a drop caught, and an extra life separately", () => {
    const r = rig();
    gotoLevel(r, 2); // the level that turns drops on
    const prize = cell(2, 5);
    put(r.mem, block(prize) + ADDR.K_TYPE, 8); // a type-8 block always drops
    put(r.mem, block(prize) + ADDR.K_HITS, 1);
    onlyBlock(r.mem, prize);
    clearBalls(r.mem);
    underBlock(r, prize);

    const onBreak = r.heard();
    expect(onBreak).toContain(SFX.BREAK);
    expect(onBreak).toContain(SFX.SPAWN);

    // A drop arriving on the paddle, and then the one drop with a cue of its
    // own: catching a life is not catching a drop.
    const catchKind = (kind: number): number[] => {
      const d = ADDR.DROPS_OFF;
      put(r.mem, d + ADDR.D_KIND, kind + 1);
      put(r.mem, d + ADDR.D_X, g(r.mem, G.PAD_X) + 1);
      put(r.mem, d + ADDR.D_Y, PADDLE_Y - 1);
      return r.heard();
    };
    expect(catchKind(0)).toContain(SFX.DROP);
    const life = catchKind(4);
    expect(life).toContain(SFX.LIFE);
    expect(life).not.toContain(SFX.DROP);
  });

  it("is silent through the beat after the paddle is destroyed", () => {
    const r = rig();
    gotoLevel(r, 1);
    clearBalls(r.mem);
    setG(r.mem, G.PAD_X, 40);
    placeBall(r.mem, 40 + g(r.mem, G.PAD_W) / 2, PADDLE_Y - BALL_SIZE - 1, 0, 2, ALIVE | RED);
    r.step();

    // Nothing simulates while `DEAD_T` runs, so nothing may sound either: a cue
    // over the hold would be a cue for something that did not happen.
    r.snd.clear();
    r.run(DEAD_FRAMES - 1, BIT_LEFT | BIT_A);
    expect(r.snd.calls).toEqual([]);
  });

  it("fires only effects the bank has, over a long scripted run", () => {
    const r = rig(99n);
    for (let t = 0; t < 900; t++) r.step(script(Number(r.machine.tick)));
    // The script is a hand, not a bot: it serves every ninety-first tick and
    // loses the ball often, so this is a dozen-odd cues across several effects
    // rather than a torrent. Both numbers are the point -- the run really
    // played, and it played more than one thing.
    expect(r.snd.calls.length).toBeGreaterThan(10);
    expect(new Set(r.snd.ids).size).toBeGreaterThanOrEqual(4);
    for (const c of r.snd.calls) {
      // The song is the other thing a cart emits, and it is numbered in its own
      // table -- `MUSIC`, not `SFX`. Levels 1-3 are one band, so a run this
      // short makes exactly one of these; `music.test.ts` owns the rest.
      if (c.kind === "music") {
        expect(c.id).toBeGreaterThanOrEqual(0);
        expect(c.id).toBeLessThan(MUSIC_COUNT);
        continue;
      }
      expect(c.kind).toBe("play");
      expect(c.id).toBeGreaterThanOrEqual(0);
      expect(c.id).toBeLessThan(SFX_COUNT);
    }
  });
});

// ===========================================================================

describe("sound is not simulation", () => {
  it("gives `render` no way to make a sound", () => {
    // Four parameters: sim, draw, alpha, ui. There is no fifth, and NONE of the
    // four is a mixer -- `render` runs on the presentation clock, so a cue fired
    // from it would play two to four times per event on a fast display.
    //
    // `ui` is the fourth and it is safe precisely because of the two rules this
    // block is about: `render` cannot write the arena and cannot make a sound,
    // so a label that differs between a keyboard and a gamepad cannot reach the
    // simulation. A device-dependent string in `tick` would be a desync; here it
    // is a caption.
    expect(breakoutCart.render.length).toBe(4);
    expect(breakoutCart.tick.length).toBe(3);
    expect(breakoutCart.boot.length).toBe(2);
  });

  it("emits nothing across a full presented frame, at any alpha", () => {
    const r = rig(7n);
    const draw = createDraw();
    // Play far enough in that there is a ball, particles and a HUD to draw.
    for (let t = 0; t < 120; t++) r.step(script(Number(r.machine.tick)));

    r.snd.clear();
    for (let i = 0; i < 12; i++) {
      draw.begin();
      r.machine.present(draw, i / 12);
    }
    expect(draw.count).toBeGreaterThan(0);
    expect(r.snd.calls).toEqual([]);
  });

  it("leaves the conformance chain identical whether anything is listening", () => {
    // THE LOAD-BEARING ONE. A recording backend and a silent one must produce
    // the same arena on every tick of a real run -- otherwise a golden case
    // recorded with sound is not the case replayed without it, and audio has
    // quietly become part of the simulation.
    const TICKS = 300;
    const chainOf = (snd: Parameters<typeof createMachine>[1]): { chain: string; last: string } => {
      const machine = createMachine(breakoutCart, snd);
      machine.boot(0xa11n);
      const input = emptyInput();
      const hasher = new ChainHasher();
      let last = "";
      for (let t = 0; t < TICKS; t++) {
        input.buttons[0] = script(t);
        machine.step(input);
        last = hasher.push(machine.arena.bytes);
      }
      return { chain: hasher.digest, last };
    };

    const silent = chainOf(undefined);
    const recording = createRecordingSnd();
    const loud = chainOf(recording);

    expect(loud.chain).toBe(silent.chain);
    expect(loud.last).toBe(silent.last);
    // And the loud run really did make a noise, or the comparison proved
    // nothing at all.
    expect(recording.calls.length).toBeGreaterThan(3);
    expect(new Set(recording.ids).size).toBeGreaterThanOrEqual(2);
  });

  it("keeps snapshot and restore byte-identical with sounds firing", () => {
    const r = rig(31n);
    for (let t = 0; t < 200; t++) r.step(script(Number(r.machine.tick)));
    const snap = r.machine.snapshot();

    const playOn = (): { bytes: Uint8Array; ids: number[] } => {
      r.snd.clear();
      for (let t = 0; t < 200; t++) r.step(script(Number(r.machine.tick)));
      return { bytes: r.machine.snapshot(), ids: [...r.snd.ids] };
    };

    const first = playOn();
    r.machine.restore(snap);
    const second = playOn();

    expect(second.bytes).toEqual(first.bytes);
    // The same run makes the same sounds, in the same order: a restore rewinds
    // what the player hears as exactly as it rewinds what they see.
    expect(second.ids).toEqual(first.ids);
    expect(first.ids.length).toBeGreaterThan(0);
  });
});

describe("the level pack", () => {
  it("is ten levels whose mechanic is their own index", () => {
    expect(LEVEL_COUNT).toBe(10);
    for (let i = 0; i < LEVEL_COUNT; i++) expect(LEVELS[i]!.mechanic).toBe(i);
  });

  it("gets harder on both axes independently of the mechanics", () => {
    for (let i = 1; i < LEVEL_COUNT; i++) {
      expect(LEVELS[i]!.ballSpeed).toBeGreaterThan(LEVELS[i - 1]!.ballSpeed);
      expect(LEVELS[i]!.paddleW).toBeLessThanOrEqual(LEVELS[i - 1]!.paddleW);
    }
  });

  it("loads every level with something to break and a ball to break it with", () => {
    const r = rig();
    for (let n = 0; n < LEVEL_COUNT; n++) {
      gotoLevel(r, n);
      let counting = 0;
      for (let i = 0; i < CELLS; i++) {
        const t = f64(r.mem, block(i) + ADDR.K_TYPE) | 0;
        if (t !== 0 && t !== 5) counting++;
      }
      expect(counting).toBeGreaterThan(0);
      expect(ballFlagWord(r.mem) & (ALIVE | STUCK)).toBe(ALIVE | STUCK);
      expect(g(r.mem, G.PAD_W)).toBe(LEVELS[n]!.paddleW);
    }
  });
});

// ===========================================================================
// The prompts, which are the one place a cart is allowed to mention a device
// ===========================================================================

describe("the prompts name a button and ask the console what it is called", () => {
  /** A Ui that records what it was asked and answers with an unmistakable sentinel. */
  function spyUi(tag = "K"): { asked: number[]; ui: Ui } {
    const asked: number[] = [];
    return { asked, ui: { label: (b) => (asked.push(b), `<${tag}${b}>`) } };
  }

  /** Boot the real cart with a given Ui and collect one frame's text. */
  function frameText(ui: Ui, prepare?: (mem: DataView) => void): string[] {
    const machine = createMachine(breakoutCart, undefined, ui);
    machine.boot(4n);
    const mem = new DataView(machine.arena.buf, ARENA_HEADER, CART_BYTES);
    prepare?.(mem);
    const draw = createDraw();
    draw.begin();
    machine.present(draw, 0.5);
    return draw.list.strings.filter((s) => s !== "");
  }

  it("draws the SERVE prompt out of ui.label, not out of a literal", () => {
    // THE BUG A PLAYER HIT IN UNDER A MINUTE. The cart drew "PRESS A TO SERVE"
    // -- the ABI's logical button A -- on a keyboard whose serve is Z and whose
    // A key moves the paddle LEFT. It named the one key that does the opposite
    // of what the sentence says.
    const s = spyUi();
    const text = frameText(s.ui);
    expect(text).toContain("PRESS  <K4>  TO SERVE");
    expect(text).not.toContain("PRESS  A  TO SERVE");
    // It asked about the SAME bit `tick` reads for the serve.
    expect(s.asked).toContain(4);
  });

  it("draws the CONTROLS panel out of ui.label too", () => {
    const s = spyUi();
    const text = frameText(s.ui);
    expect(text).toContain("<K2> <K3>   MOVE");
    expect(text).toContain("<K4>     SERVE");
    expect(text).toContain("<K5>     FIRE");
    // The panel's old guesses, every one of them wrong on some device.
    expect(text).not.toContain("< >   MOVE");
    expect(text).not.toContain("Z     SERVE");
    expect(text).not.toContain("X     FIRE");
    // PAUSE IS GONE FROM THE CART. It is the console's control -- the ABI keeps
    // its bit out of the input frame so a cart can neither see nor suppress it
    // -- so a cart naming its key was naming a control it cannot read.
    expect(text.some((t) => t.includes("PAUSE"))).toBe(false);
  });

  it("draws the game-over prompt out of ui.label", () => {
    const s = spyUi();
    const text = frameText(s.ui, (mem) => setG(mem, G.STATE, 1));
    expect(text).toContain("PRESS  <K4>");
    expect(text).not.toContain("PRESS  A");
  });

  it("asks about buttons only, and only ones this cart reads", () => {
    const s = spyUi();
    frameText(s.ui);
    // Left, right, serve, fire. Nothing else, and no number that is not a bit.
    expect([...new Set(s.asked)].sort((a, b) => a - b)).toEqual([2, 3, 4, 5]);
  });

  it("changes what it draws when the console changes its labels", () => {
    // The property a literal cannot have. Same cart, same seed, same frame --
    // a keyboard and a gamepad, and the prompt is right on both.
    const keyboard = frameText({ label: (b) => (b === 4 ? "Z" : b === 5 ? "X" : "?") });
    const gamepad = frameText({ label: (b) => (b === 4 ? "(A)" : b === 5 ? "(X)" : "?") });
    expect(keyboard).toContain("PRESS  Z  TO SERVE");
    expect(gamepad).toContain("PRESS  (A)  TO SERVE");
    expect(keyboard).not.toEqual(gamepad);
  });

  it("says PRESS Z on the shell a player actually gets", () => {
    // End to end, with the console's real answer rather than a sentinel: this is
    // the sentence the player reads, and Z is the key that serves.
    const text = frameText(keyboardUi());
    expect(text).toContain("PRESS  Z  TO SERVE");
    expect(text).toContain("← →   MOVE");
    expect(text).toContain("Z     SERVE");
    expect(text).toContain("X     FIRE");
  });

  it("labels only keys that are really bound, so a prompt cannot lie", () => {
    // The label is DERIVED from KEYMAP. A second table beside it would be a
    // second place to rebind a key, and the two disagreeing IS this bug.
    const ui = keyboardUi();
    const shown: Record<string, string> = {
      Z: "KeyZ",
      X: "KeyX",
      "←": "ArrowLeft",
      "→": "ArrowRight",
    };
    for (const bit of [BTN.A, BTN.B, BTN.LEFT, BTN.RIGHT]) {
      const code = shown[ui.label(bit)];
      expect(code).toBeDefined();
      expect(KEYMAP[code as string]).toBe(bit);
    }
    // And the key the old prompt named is NOT the serve. It is LEFT.
    expect(KEYMAP["KeyA"]).toBe(BTN.LEFT);
    expect(ui.label(BTN.A)).not.toBe("A");
  });

  it("falls back to the ABI's own button name when nothing is bound", () => {
    // A console that cannot answer must still answer something true.
    const bare = keyboardUi({});
    expect(bare.label(BTN.A)).toBe("A");
    expect(bare.label(BTN.LEFT)).toBe("LEFT");
  });

  it("renders identically to a machine with different labels, in the arena", () => {
    // Sound is not simulation, and neither is a caption. Two consoles whose
    // buttons are called different things must produce the same bytes.
    const run = (ui: Ui): Uint8Array => {
      const machine = createMachine(breakoutCart, undefined, ui);
      machine.boot(0x5eedn);
      const draw = createDraw();
      const input = emptyInput();
      for (let t = 0; t < 240; t++) {
        input.buttons[0] = script(Number(machine.tick));
        machine.step(input);
        draw.begin();
        machine.present(draw, (t % 4) / 4);
      }
      return machine.snapshot();
    };
    expect(run(keyboardUi())).toEqual(run({ label: (b) => `PAD${b}` }));
  });
});
