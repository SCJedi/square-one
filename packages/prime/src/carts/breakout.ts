/**
 * RED BREAKER, on Prime.
 *
 * The same game as `modules/breakout/engine.js`: the same ten levels, the same
 * eight block types, the same drops, the same side pads, the same gun, the same
 * lives -- and above all the same red ball. What changes is the machine under
 * it, and this file is the argument that the change was worth making.
 *
 * =========================================================================
 * THE RED BALL, WHICH IS THE GAME
 * =========================================================================
 * The ball is NORMAL or RED (bit 1 of its flags).
 *
 *   1. Breaking a type-4 block sets the ball RED.
 *   2. While RED, and only then, a red beam exists BELOW the paddle.
 *   3. RED ball touches the PADDLE -> paddle destroyed, life lost, ball gone.
 *   4. RED ball meets a BREAKABLE block -- types 1, 2, 3, 4 and 8 -- and PASSES
 *      THROUGH it, destroying it outright whatever it had left, WITHOUT
 *      deflecting. It keeps going and it STAYS RED.
 *   5. Walls and the ceiling bounce it, and it STAYS RED.
 *   6. SOLID and SHIELDED blocks bounce it, and it STAYS RED. Those two are the
 *      level designer's structure rather than his contents: a red ball that ate
 *      them would clear level eight's shielded wall, which is the one level
 *      built to REQUIRE the gun.
 *   7. RED ball touches the BEAM -> it deflects AND returns to NORMAL. THAT IS
 *      THE ONLY THING THAT CLEARS IT. A shot no longer does.
 *
 * A RED BALL IS A WRECKING BALL, and it is clearing the level for you. The
 * player wants it alive and wants it nowhere near the paddle, which is the
 * opposite of the panic the old rule created and the opposite of what the rest
 * of the game teaches: you steer away from your own ball, and the beam under
 * the paddle is where you finally catch it.
 *
 * THE CLEAR IS ONE FUNCTION WITH ONE CALLER. {@link deflect} is the only code
 * in this file that masks bit 1 off a live ball, and the beam branch of
 * {@link contact} is its only caller. {@link bounce} -- every wall, every
 * ceiling, every deflecting block -- does not touch the flags byte at all, so a
 * contact added later gets rule 5 for free and CANNOT clear a red ball by
 * accident. That structure is inherited from the small console deliberately,
 * exactly as the old one was, and it is the same argument in the new shape:
 * one writer, and everything else structurally unable to be a second.
 *
 * A THIRD STATE, if a deflection is ever to leave the ball as something other
 * than NORMAL, is written in `deflect` and nowhere else. It is the whole of
 * what the beam does to a ball, so nothing above it has to be restructured.
 *
 * And rule 4 is decided by {@link damage}, which ANSWERS WHETHER THE BALL MUST
 * BOUNCE: what is left of a block and whether it stopped you are one decision,
 * so they are one return value and cannot become two checks that disagree.
 *
 * THE BEAM IS NOT A FLOOR. {@link contact} tests it only when the RED bit is
 * set, so a normal ball falls straight through and is lost. Softening that
 * removes the only way to die, and `breakout.test.ts` asserts it directly --
 * because it is the first thing that will be tempting once the beam looks good.
 *
 * =========================================================================
 * SEVENTEEN SOUNDS, AND THE ONE THAT CANNOT DRIFT
 * =========================================================================
 * `snd` reaches `boot` and `tick` and NEVER `render`. `render` runs on the
 * presentation clock, so a sound emitted there fires once per PRESENTED FRAME
 * -- two to four times per impact on a fast display, which is machine-gunning
 * every contact on exactly the hardware that was supposed to make the game
 * sound better. It is the same rule as `render` may not write the arena, and it
 * is the same reason: everything that happens, happens in `tick`.
 *
 * THE ALARM FIRES FROM INSIDE THE BRANCH THAT SETS THE RED BIT. One `if`, two
 * statements: the bit and the sound. The small console does it that way and its
 * alarm has never been wrong -- a sound fired from a later check of the flag
 * would be a second reading of the same condition, and two readings can drift
 * apart. The same structure gives the beam its deflection cue inside the branch
 * that deflects, and `redHit` its smash inside the one contact that never
 * bounces.
 *
 * Which effect interrupts which is a mechanic; see `audio.ts`. The deflection
 * shares a channel with the alarm on purpose, so relief cuts danger off
 * mid-warble.
 *
 * =========================================================================
 * THE COORDINATE SYSTEM, AND WHY IT IS STILL 128 UNITS WIDE
 * =========================================================================
 * The simulation runs in a 128 x 128 FIELD of f64 units -- the small console's
 * own geometry, block for block. `render` maps that field onto the ABI's
 * 1920 x 1080 logical space at {@link SCALE} 8, centred, so a block is 64 x 48
 * screen units and the ball is 24.
 *
 * That is not laziness, it is the one thing the port must not get wrong. The
 * GAP BETWEEN THE LOWEST BLOCK AND THE PADDLE IS HOW LONG A PLAYER HAS TO
 * REACT, and it is the reason a block is 8 x 6 rather than 8 x 8 on the small
 * machine: `block_h` 8 would push the bottom row to y=105 against a paddle at
 * y=110 and cut the reaction gap from 28 units to 4, killing the red-block
 * mechanic outright. Rescaling the field by one factor preserves every one of
 * those ratios exactly, and the levels' own reaction-time table -- row 2 on
 * level two is about a second, row 5 on level ten about four tenths -- stays
 * true without being recomputed. ART MUST NEVER COST THE GAME A MECHANIC.
 *
 * What the floats buy is everything BELOW a unit: the ball moves in fractions,
 * the paddle accelerates, and `render` lerps by `alpha` so a 144 Hz display
 * shows 144 distinct positions of a 60 Hz ball. On the small console the ball
 * moved in sixteenths of a pixel because the header spoke that unit; here the
 * sixteenths are divided out once, in `levels.ts`, and never thought about
 * again.
 *
 * =========================================================================
 * ALL MUTABLE STATE IS IN THE ARENA
 * =========================================================================
 * Nothing on the cart object, nothing in a module-level variable that is not a
 * constant, nothing in a closure. The level grids in `levels.ts` are ASSETS --
 * immutable, identical on every machine running this cart, and therefore
 * outside the arena by the ABI's own rule, because a snapshot copies the arena
 * and immutable data does not need saving.
 *
 * PARTICLES ARE SIMULATION STATE. They are the largest thing in the arena and
 * they could have been a render-side effect system, which would have been
 * wrong twice over: `render` may not write, and a rollback that restored the
 * game but not the explosion would show a frame nobody ever simulated. They
 * live in a fixed-size pool, indexed by a round-robin cursor, with no
 * allocation per frame and no allocation per particle.
 *
 * `render` NEVER WRITES. Everything that moves keeps a previous and a current
 * value; `render` lerps between them and keeps the result on the stack. The
 * runtime hashes the arena around `render` and faults on a change, and that
 * fault is the wall that stops interpolation quietly becoming part of the
 * simulation -- the single most common way a deterministic engine stops being
 * one.
 *
 * =========================================================================
 * DETERMINISM
 * =========================================================================
 * `sim.sin`, `sim.cos` and `sim.atan2` are the normative library and the
 * platform's are never used: `Math.sin` differs between libms and CPU vendors,
 * and one of them in a physics path breaks a replay silently. `+ - * /` and
 * `Math.sqrt` are exactly specified by IEEE 754 and are used freely.
 * `Math.floor`, `Math.abs`, `Math.min` and `Math.max` are exact selections
 * among their inputs and introduce no rounding. `sim.tick` is the only clock.
 *
 * `sim.rnd` drives the drop table and every particle, so the PRNG stream is
 * part of the simulation and lives in the arena with everything else. That is
 * exactly why the snapshot test is worth running against this cart rather than
 * a quieter one: a cart that never draws a random number cannot detect a
 * generator whose state escaped.
 *
 * =========================================================================
 * WHAT EACH LAYER HOLDS
 * =========================================================================
 *   0  the room: the backdrop, the cabinet, the field's floor and its grid
 *   1  underglow: additive haloes beneath the blocks and the paddle, bloomed
 *   2  geometry: blocks, paddle, side pads, drops, shots -- solid, not additive
 *   3  particles: debris (normal) then sparks (additive), bloomed
 *   4  the light: the ball's halo, its trail, the beam's glow. Bloom lives here
 *   5  cores and rings: the ball's solid centre, the beam's, the shock rings
 *   6  alarm and panels: the red-ball edge wash, GAME OVER, the serve prompt
 *   7  HUD: level, lives, ammunition, progress, the legend
 *
 * Post stages are non-normative and this cart is readable with both ignored:
 * every warning it gives is in the geometry. `bloom` is last-writer-wins per
 * layer, so each layer that wants it declares it once; `shake` takes the
 * maximum over the frame, so the one call carries the largest request.
 */

import { SFX } from "../audio";
import { MUSIC_FADE_FRAMES, bandForLevel } from "../music";
import type { Draw, InputFrame, PrimeCart, Sim, SimRead, Snd, Ui } from "../sim";
import {
  CELLS,
  COUNTING_BLOCKS,
  GRID_H,
  GRID_W,
  GRIDS,
  LEVEL_COUNT,
  LEVELS,
  RED_COUNT,
} from "./levels";

// ===========================================================================
// The field. Every number here is the small console's knob default, in the
// field units that were its pixels. See the header on why they did not change.
// ===========================================================================

/** The field is this many units on a side. The small console's screen. */
export const FIELD = 128;

/** A block's width in field units. `GRID_W * BLOCK_W` fills the field. */
export const BLOCK_W = 8;

/** A block's height. SIX, not eight -- it is the reaction gap. See the header. */
export const BLOCK_H = 6;

/** The unit row the top row of blocks starts at. Above it is the ball's sky. */
export const FIELD_TOP = 10;

/** The unit row the ball bounces off instead of the top of the field. */
export const CEILING_Y = 8;

/** The unit row the paddle sits on. */
export const PADDLE_Y = 110;

/** The paddle's thickness, and the height of the side pads. */
export const PADDLE_H = 3;

/** Units the paddle may slide per frame at full speed. */
export const PADDLE_SPEED = 1.75;

/**
 * How quickly the paddle reaches full speed, per frame.
 *
 * The one addition to the paddle's dynamics, and it is deliberately small: top
 * speed is unchanged, so every reachability number in the level pack still
 * holds, and only the first three frames of a move differ. What it buys is
 * WEIGHT -- the paddle leans into a direction change instead of teleporting
 * into it -- and a tilt `render` can read straight off the velocity.
 */
export const PADDLE_EASE = 0.36;

/** Below this the paddle is simply stopped, so a dead stick settles exactly. */
const PADDLE_STOP = 1e-6;

/** The widest the `wide` drop may grow the paddle. */
export const PADDLE_MAX_W = 48;

/** Units one `wide` drop adds. */
export const WIDE_GROW = 10;

/** How much of the ball's speed a full-edge paddle hit puts into X. */
export const SPREAD = 0.75;

/** The smallest horizontal share a serve or a return may have. */
export const MIN_ANGLE = 0.35;

/** The ball is this many units square. Collision tests its four corners. */
export const BALL_SIZE = 3;

/**
 * The most units one collision substep may move the ball on either axis.
 *
 * THIS IS THE ANTI-TUNNELLING BOUND: 3 is smaller than both block dimensions
 * (8 x 6), so a ball can never cross a block without a substep landing inside
 * it. At the fastest header in the pack -- 2.75 units a frame -- that is two
 * substeps; the bound is taken over what a velocity may BECOME this frame
 * rather than what it is, because a bounce inside a substep can raise a
 * component to the full ball speed.
 */
export const STEP_MAX = 3;

/** Balls in play at once. The header's `ballCount` and `multi` both fill it. */
export const MAX_BALLS = 4;

/** Ball speed multiplier while the `slow` drop is running. */
export const SLOW_SCALE = 0.6;

/** The unit row of the red beam. BELOW `PADDLE_Y`; the mechanic depends on it. */
export const BEAM_Y = 118;

/** The beam's thickness. It deflects a RED ball and nothing else. */
export const BEAM_H = 2;

/** Drops falling at once. A block that finds no free slot drops nothing. */
export const MAX_DROPS = 6;

/** Units a drop falls per frame. */
export const DROP_SPEED = 0.5;

/** A drop's width, which is also the width it is caught within. */
export const DROP_W = 4;

/** A drop's height. */
export const DROP_H = 3;

/** How long `wide`, `slow` and `catch` last, in frames. */
export const POWER_FRAMES = 240;

/** Shots one `gun` drop grants. */
export const GUN_SHOTS = 5;

/** Shots in the air at once. */
export const MAX_SHOTS = 4;

/** Units a shot rises per frame. */
export const SHOT_SPEED = 4;

/** A shot's width. */
export const SHOT_W = 2;

/** A shot's height. */
export const SHOT_H = 4;

/** How far in from each field edge a side charge pad reaches. */
export const PAD_ZONE = 8;

/** How far a drifting row slides from its home column before it turns. */
export const DRIFT_RANGE = 6;

/** Lives a run starts with. */
export const START_LIVES = 3;

/** Frames the paddle's destruction holds the whole simulation still. */
export const DEAD_FRAMES = 46;

/** Points of the ball's path kept for its trail. Simulation state, like the ball. */
export const TRAIL_N = 10;

/** Particles the pool holds. A block break spends about sixteen of them. */
export const MAX_PARTICLES = 448;

/** Shock rings alive at once. */
export const MAX_RINGS = 8;

// --- which mechanic the header's `mechanic` byte turns on -------------------
// Each level keeps everything the levels before it introduced, so the test is
// `>=` and never `===`.

/** From this `mechanic` value, breaking a type-4 block turns the ball RED. */
export const MECH_RED = 1;
/** From here, broken blocks drop power-ups at `dropRate`/256. */
export const MECH_DROPS = 2;
/** From here, type-2 and type-3 blocks take two and three hits. */
export const MECH_TOUGH = 3;
/** From here, the side charge pads exist on levels whose header sets them. */
export const MECH_PADS = 4;
/** From here, rows holding a type-7 block slide sideways. */
export const MECH_DRIFT = 5;
/** From here, the header's `ballCount` serves more than one ball. */
export const MECH_MULTI = 6;
/** From here, a type-6 block ignores the ball and must be shot. */
export const MECH_SHIELD = 7;

// --- the screen ------------------------------------------------------------

/** Logical units per field unit. A power of two, so every mapping is exact. */
export const SCALE = 8;

/** Left edge of the field on screen: the 1024-wide field, centred in 1920. */
export const ORIGIN_X = (1920 - FIELD * SCALE) / 2;

/** Top edge of the field on screen, centred in 1080. */
export const ORIGIN_Y = (1080 - FIELD * SCALE) / 2;

/** Two turns. Named because `render` draws a good many circles. */
const TAU = 6.283185307179586;

/**
 * The width the box tests treat as exclusive.
 *
 * The small console compared integer pixels and wrote `x + BS - 1` for a
 * right edge. In floats the right edge is `x + BS` and it is EXCLUSIVE: a ball
 * whose edge lands exactly on a block's edge overlaps it by nothing and must
 * not count as a hit. Positions here are exact binary fractions, so that case
 * is reached rather than merely possible, and this is what keeps it correct.
 */
const EDGE_E = 1e-9;

// ===========================================================================
// The arena
//
// Byte offsets, all f64. One table, so nothing can disagree about a layout --
// and the whole of it is inside `sim.mem`, which is the whole of the state.
// ===========================================================================

/** Globals, as f64 slot indices. Byte offset is `slot * 8`. */
const G = {
  LEVEL: 0,
  LIVES: 1,
  /** 0 playing, 1 game over, 2 every level cleared. */
  STATE: 2,
  PAD_X: 3,
  PAD_PX: 4,
  PAD_W: 5,
  PAD_VX: 6,
  AMMO: 7,
  WIDE_T: 8,
  SLOW_T: 9,
  CATCH_T: 10,
  DRIFT: 11,
  DRIFT_PREV: 12,
  /** 1 while the shared drift offset is travelling west. */
  DRIFT_DIR: 13,
  /** Which side pads the paddle was touching last frame. */
  PAD_TOUCH: 14,
  /** Bitmask: row r drifts when bit r is set. */
  ROWS: 15,
  /** Frames of the paddle's destruction left to play. */
  DEAD_T: 16,
  DEAD_X: 17,
  DEAD_W: 18,
  SHAKE: 19,
  SHAKE_PREV: 20,
  /** The beam's energy, 0..1. Geometry follows the rule; this follows the eye. */
  BEAM: 21,
  BEAM_PREV: 22,
  /** The red alarm's intensity, 0..1. */
  ALARM: 23,
  ALARM_PREV: 24,
  CLEAR_T: 25,
  CLEAR_PREV: 26,
  /** Last frame's buttons, so a press can be told from a hold. */
  PREV_BTN: 27,
  PART_CUR: 28,
  RING_CUR: 29,
  LIFE_FLASH: 30,
  AMMO_FLASH: 31,
  PAD_SQUASH: 32,
  PAD_SQUASH_PREV: 33,
  PAD_TILT: 34,
  PAD_TILT_PREV: 35,
  /** Ticks a ball has been waiting on the paddle, for the serve prompt. */
  SERVE_T: 36,
  BLOOM: 37,
  BLOOM_PREV: 38,
  DEFLECT_T: 39,
  DEFLECT_PREV: 40,
  /** Ticks since the run ended, for the panel's entrance. */
  OVER_T: 41,
  /** Ticks since this level loaded, for its entrance. */
  LEVEL_T: 42,
  /**
   * The music band playing, PLUS ONE. 0 is a console that has not been told yet.
   *
   * WHICH BAND IS PLAYING IS SIMULATION STATE, so it is a slot in the arena like
   * everything else -- a rewind that restored the game and not the band would be
   * a determinism hole with a soundtrack. What the band SOUNDS like is the
   * mixer's business and is not here; see `../music.ts`.
   */
  BAND: 43,
} as const;

/** Slots reserved for globals. Generous; the arena is 1 MB and this is 512 B. */
const GLOBAL_SLOTS = 64;

const BALLS_OFF = GLOBAL_SLOTS * 8;
/** 232 bytes used of 256. Powers of two keep the offsets readable. */
const BALL_STRIDE = 256;

const B_X = 0;
const B_Y = 8;
const B_PX = 16;
const B_PY = 24;
const B_VX = 32;
const B_VY = 40;
/** bit 0 alive, bit 1 RED, bit 2 stuck to the paddle. */
const B_FLAGS = 48;
/** Ticks this ball has been RED. 0 when it is not. */
const B_REDT = 56;
const B_TRAIL_HEAD = 64;
/** `TRAIL_N` pairs of (x, y), oldest overwritten. */
const B_TRAIL = 72;

const DROPS_OFF = BALLS_OFF + MAX_BALLS * BALL_STRIDE;
const DROP_STRIDE = 64;
const D_X = 0;
const D_Y = 8;
const D_PX = 16;
const D_PY = 24;
/** 0 for a free slot, otherwise the drop kind plus one. */
const D_KIND = 32;
const D_AGE = 40;

const SHOTS_OFF = DROPS_OFF + MAX_DROPS * DROP_STRIDE;
const SHOT_STRIDE = 64;
const S_X = 0;
const S_Y = 8;
const S_PX = 16;
const S_PY = 24;
const S_LIVE = 32;
const S_AGE = 40;

const BLOCKS_OFF = SHOTS_OFF + MAX_SHOTS * SHOT_STRIDE;
const BLOCK_STRIDE = 32;
const K_TYPE = 0;
const K_HITS = 8;
/** 0..1, lit by a hit that did not break the block, decaying. */
const K_FLASH = 16;
const K_FLASH_PREV = 24;

const RINGS_OFF = BLOCKS_OFF + CELLS * BLOCK_STRIDE;
const RING_STRIDE = 64;
const R_X = 0;
const R_Y = 8;
const R_T = 16;
const R_MAX = 24;
const R_COL = 32;
const R_R0 = 40;
const R_R1 = 48;
const R_W = 56;

const PARTS_OFF = RINGS_OFF + MAX_RINGS * RING_STRIDE;
const PART_STRIDE = 96;
const P_X = 0;
const P_Y = 8;
const P_PX = 16;
const P_PY = 24;
const P_VX = 32;
const P_VY = 40;
const P_LIFE = 48;
const P_MAX = 56;
/** Packed 0xRRGGBB. Alpha comes from the particle's remaining life. */
const P_COL = 64;
const P_SIZE = 72;
/** 0 an additive spark, 1 solid debris. */
const P_KIND = 80;
const P_GRAV = 88;

/** Bytes of the arena this cart uses. The rest stays as the machine zeroed it. */
export const ARENA_USED = PARTS_OFF + MAX_PARTICLES * PART_STRIDE;

// ===========================================================================
// Arena access
// ===========================================================================

function gv(m: DataView, slot: number): number {
  return m.getFloat64(slot * 8, true);
}

function gs(m: DataView, slot: number, v: number): void {
  m.setFloat64(slot * 8, v, true);
}

function rv(m: DataView, off: number): number {
  return m.getFloat64(off, true);
}

function rs(m: DataView, off: number, v: number): void {
  m.setFloat64(off, v, true);
}

function ballOff(i: number): number {
  return BALLS_OFF + i * BALL_STRIDE;
}

function dropOff(i: number): number {
  return DROPS_OFF + i * DROP_STRIDE;
}

function shotOff(i: number): number {
  return SHOTS_OFF + i * SHOT_STRIDE;
}

function blockOff(i: number): number {
  return BLOCKS_OFF + i * BLOCK_STRIDE;
}

function ringOff(i: number): number {
  return RINGS_OFF + i * RING_STRIDE;
}

function partOff(i: number): number {
  return PARTS_OFF + i * PART_STRIDE;
}

/** Zero a byte range of the arena, eight bytes at a time. */
function wipe(m: DataView, from: number, to: number): void {
  for (let o = from; o < to; o += 8) m.setFloat64(o, 0, true);
}

// ===========================================================================
// The level, read from the pack and never generated
// ===========================================================================

/** The current level's header. Clamped, so a corrupt arena cannot index off it. */
function hdr(m: DataView): (typeof LEVELS)[number] {
  const l = gv(m, G.LEVEL) | 0;
  const i = l < 0 ? 0 : l >= LEVEL_COUNT ? LEVEL_COUNT - 1 : l;
  return LEVELS[i] as (typeof LEVELS)[number];
}

/** Is the mechanic introduced at `m` live on this level yet? */
function mech(mem: DataView, k: number): boolean {
  return hdr(mem).mechanic >= k;
}

/** This level's ball speed, after the `slow` drop. */
function speed(m: DataView): number {
  const s = hdr(m).ballSpeed;
  return gv(m, G.SLOW_T) > 0 ? s * SLOW_SCALE : s;
}

/** How many hits a fresh block of type `t` takes. The value IS the count. */
function hitsFor(m: DataView, t: number): number {
  return (t === 2 || t === 3) && mech(m, MECH_TOUGH) ? t : 1;
}

/** How far row `r` has drifted. Rows that do not drift: 0. */
function driftOf(m: DataView, r: number): number {
  return rowDrift(gv(m, G.ROWS) | 0, r, gv(m, G.DRIFT));
}

function blockType(m: DataView, i: number): number {
  return rv(m, blockOff(i) + K_TYPE) | 0;
}

/** Where block `i` is in the field, drift included. */
function blockX(m: DataView, i: number): number {
  return (i % GRID_W) * BLOCK_W + driftOf(m, (i / GRID_W) | 0);
}

function blockY(i: number): number {
  return FIELD_TOP + ((i / GRID_W) | 0) * BLOCK_H;
}

/**
 * The index of the block covering field point (x, y), or -1.
 *
 * The row's drift is subtracted from x rather than added to the grid, so one
 * lookup serves a still row and a sliding one and collision cannot disagree
 * with drawing about where a drifter is.
 */
function at(m: DataView, x: number, y: number): number {
  if (y < FIELD_TOP) return -1;
  const r = Math.floor((y - FIELD_TOP) / BLOCK_H);
  if (r < 0 || r >= GRID_H) return -1;
  const cx = x - driftOf(m, r);
  if (cx < 0) return -1;
  const c = Math.floor(cx / BLOCK_W);
  if (c < 0 || c >= GRID_W) return -1;
  const i = r * GRID_W + c;
  return blockType(m, i) ? i : -1;
}

/** The first block the ball's square overlaps, tested at its four corners. */
function cellAt(m: DataView, x: number, y: number): number {
  const hi = BALL_SIZE - EDGE_E;
  let c = at(m, x, y);
  if (c < 0) c = at(m, x + hi, y);
  if (c < 0) c = at(m, x, y + hi);
  if (c < 0) c = at(m, x + hi, y + hi);
  return c;
}

/** Every breakable block gone. Solid blocks are scenery and never count. */
function cleared(m: DataView): boolean {
  for (let i = 0; i < CELLS; i++) {
    const t = blockType(m, i);
    if (t !== 0 && t !== 5) return false;
  }
  return true;
}

/** Blocks that still count toward the clear. The HUD's progress bar. */
export function remaining(m: DataView): number {
  let n = 0;
  for (let i = 0; i < CELLS; i++) {
    const t = blockType(m, i);
    if (t !== 0 && t !== 5) n++;
  }
  return n;
}

// ===========================================================================
// Particles and rings -- simulation state, in the arena, deterministic
// ===========================================================================

/**
 * Put one particle in the pool.
 *
 * A round-robin cursor rather than a free-list scan: it is O(1), it never
 * allocates, and when the pool is full the OLDEST particle is the one that goes
 * -- which is the right one to lose, because the newest burst is the one the
 * player is looking at.
 */
function particle(
  m: DataView,
  x: number,
  y: number,
  vx: number,
  vy: number,
  life: number,
  colour: number,
  size: number,
  kind: number,
  grav: number,
): void {
  const c = gv(m, G.PART_CUR) | 0;
  const o = partOff(c % MAX_PARTICLES);
  gs(m, G.PART_CUR, (c + 1) % MAX_PARTICLES);
  rs(m, o + P_X, x);
  rs(m, o + P_Y, y);
  rs(m, o + P_PX, x);
  rs(m, o + P_PY, y);
  rs(m, o + P_VX, vx);
  rs(m, o + P_VY, vy);
  rs(m, o + P_LIFE, life);
  rs(m, o + P_MAX, life);
  rs(m, o + P_COL, colour);
  rs(m, o + P_SIZE, size);
  rs(m, o + P_KIND, kind);
  rs(m, o + P_GRAV, grav);
}

/** An expanding ring. Four of the game's moments are made of one. */
function ring(
  m: DataView,
  x: number,
  y: number,
  life: number,
  colour: number,
  r0: number,
  r1: number,
  w: number,
): void {
  const c = gv(m, G.RING_CUR) | 0;
  const o = ringOff(c % MAX_RINGS);
  gs(m, G.RING_CUR, (c + 1) % MAX_RINGS);
  rs(m, o + R_X, x);
  rs(m, o + R_Y, y);
  rs(m, o + R_T, life);
  rs(m, o + R_MAX, life);
  rs(m, o + R_COL, colour);
  rs(m, o + R_R0, r0);
  rs(m, o + R_R1, r1);
  rs(m, o + R_W, w);
}

/** Request screen shake. `draw.shake` takes the maximum, and so does this. */
function shake(m: DataView, amount: number): void {
  if (amount > gv(m, G.SHAKE)) gs(m, G.SHAKE, amount);
}

/** Request a bloom lift for the next few frames. Presentation only. */
function bloomUp(m: DataView, amount: number): void {
  if (amount > gv(m, G.BLOOM)) gs(m, G.BLOOM, amount);
}

function stepParticles(m: DataView): void {
  for (let i = 0; i < MAX_PARTICLES; i++) {
    const o = partOff(i);
    const life = rv(m, o + P_LIFE);
    if (life <= 0) continue;
    rs(m, o + P_PX, rv(m, o + P_X));
    rs(m, o + P_PY, rv(m, o + P_Y));
    const vy = rv(m, o + P_VY) + rv(m, o + P_GRAV);
    const vx = rv(m, o + P_VX) * 0.985;
    rs(m, o + P_VX, vx);
    rs(m, o + P_VY, vy * 0.985);
    rs(m, o + P_X, rv(m, o + P_X) + vx);
    rs(m, o + P_Y, rv(m, o + P_Y) + vy);
    rs(m, o + P_LIFE, life - 1);
  }
}

function stepRings(m: DataView): void {
  for (let i = 0; i < MAX_RINGS; i++) {
    const o = ringOff(i);
    const t = rv(m, o + R_T);
    if (t > 0) rs(m, o + R_T, t - 1);
  }
}

// --- the bursts, by event --------------------------------------------------

/** A block coming apart. Velocity is inherited from the ball that did it. */
function burstBlock(
  m: DataView,
  sim: Sim,
  x: number,
  y: number,
  colour: number,
  bvx: number,
  bvy: number,
): void {
  for (let k = 0; k < 16; k++) {
    const a = (k / 16) * TAU + sim.rndf() * 0.45;
    const sp = 0.22 + sim.rndf() * 0.85;
    particle(
      m,
      x + BLOCK_W * 0.5 + (sim.rndf() - 0.5) * BLOCK_W,
      y + BLOCK_H * 0.5 + (sim.rndf() - 0.5) * BLOCK_H,
      sim.cos(a) * sp + bvx * 0.32,
      sim.sin(a) * sp + bvy * 0.32,
      20 + (sim.rnd(20) | 0),
      colour,
      0.45 + sim.rndf() * 1.0,
      k < 5 ? 0 : 1,
      0.028,
    );
  }
  ring(m, x + BLOCK_W * 0.5, y + BLOCK_H * 0.5, 14, colour, 2, 8, 1.0);
}

/** A ball glancing off something without breaking it. */
function burstSpark(
  m: DataView,
  sim: Sim,
  x: number,
  y: number,
  colour: number,
  n: number,
  power: number,
): void {
  for (let k = 0; k < n; k++) {
    const a = sim.rndf() * TAU;
    const sp = (0.2 + sim.rndf() * 0.7) * power;
    particle(
      m,
      x,
      y,
      sim.cos(a) * sp,
      sim.sin(a) * sp,
      8 + (sim.rnd(10) | 0),
      colour,
      0.3 + sim.rndf() * 0.6,
      0,
      0.01,
    );
  }
}

// ===========================================================================
// The ball
// ===========================================================================

function flags(m: DataView, b: number): number {
  return rv(m, b + B_FLAGS) | 0;
}

function setFlags(m: DataView, b: number, f: number): void {
  rs(m, b + B_FLAGS, f);
}

/**
 * Reverse one axis. IT DOES NOT TOUCH THE BALL'S COLOUR.
 *
 * Every deflection in the game comes through here -- a wall, the ceiling, a
 * solid or shielded block, the beam -- and rule 5 says a red ball survives all
 * of them. So the one thing this function must never grow is a write to the
 * flags byte: that is what makes "the beam is the only clear" true by
 * construction rather than by everybody remembering it.
 */
function bounce(m: DataView, b: number, axis: number): void {
  const o = b + (axis ? B_VY : B_VX);
  rs(m, o, -rv(m, o));
}

/**
 * RULE 7: what a BEAM DEFLECTION does to a ball's state, and THE ONLY PLACE IN
 * THIS FILE THAT CLEARS THE RED BIT OFF A LIVE BALL.
 *
 * Two lines today, and a function of its own on purpose: a third state for the
 * beam to leave the ball in is written here, and not one caller of `bounce` is
 * affected, because none of them has an opinion about colour.
 */
function deflect(m: DataView, b: number): void {
  setFlags(m, b, flags(m, b) & ~2);
  rs(m, b + B_REDT, 0);
}

/**
 * A bounce off the edge of the field: the two side walls and the ceiling.
 *
 * Separate from `bounce` for the same reason the small console separates them:
 * this one is the contact with no other feedback of its own, so the spark
 * belongs here rather than inside `bounce`, where it would fire on top of every
 * block hit and every deflection as well.
 */
function edge(m: DataView, sim: Sim, snd: Snd, b: number, axis: number): void {
  const red = (flags(m, b) & 2) !== 0;
  bounce(m, b, axis);
  // The wall cue lives HERE and not in `bounce`, for the same reason the spark
  // does: `bounce` is every contact in the game, so a sound inside it would play
  // the wall on top of every block hit and every deflection -- which is the one
  // thing the three constant effects exist to keep apart.
  snd.play(SFX.WALL);
  burstSpark(
    m,
    sim,
    rv(m, b + B_X) + BALL_SIZE * 0.5,
    rv(m, b + B_Y) + BALL_SIZE * 0.5,
    red ? 0xff3355 : 0x9fd8ff,
    red ? 14 : 5,
    red ? 1.5 : 0.7,
  );
  if (red) shake(m, 5);
}

/** Push one point onto a ball's trail. The trail is state, like the ball. */
function pushTrail(m: DataView, b: number): void {
  const h = gvTrailHead(m, b);
  rs(m, b + B_TRAIL + h * 16, rv(m, b + B_X));
  rs(m, b + B_TRAIL + h * 16 + 8, rv(m, b + B_Y));
  rs(m, b + B_TRAIL_HEAD, (h + 1) % TRAIL_N);
}

function gvTrailHead(m: DataView, b: number): number {
  const h = rv(m, b + B_TRAIL_HEAD) | 0;
  return h < 0 || h >= TRAIL_N ? 0 : h;
}

/** Put a ball's whole trail where the ball is, so a serve does not streak. */
function resetTrail(m: DataView, b: number): void {
  const x = rv(m, b + B_X);
  const y = rv(m, b + B_Y);
  for (let k = 0; k < TRAIL_N; k++) {
    rs(m, b + B_TRAIL + k * 16, x);
    rs(m, b + B_TRAIL + k * 16 + 8, y);
  }
  rs(m, b + B_TRAIL_HEAD, 0);
}

/**
 * Take a hit off block `i`. `b` is the ball that did it, or -1 for a shot.
 * ANSWERS WHETHER THE BALL MUST BOUNCE OFF IT.
 *
 * Two rules, one return value, because they are one decision. SOLID never
 * breaks and SHIELDED breaks only to a shot -- which is what makes shooting
 * required rather than optional on the levels that use it -- and both deflect
 * anything that touches them, red or not: RULE 6. Every other block BREAKS TO A
 * RED BALL IN ONE PASS, whatever it had left, and lets it through: RULE 4.
 *
 * What is left of a block and whether it stopped you cannot be two checks that
 * disagree if they are one answer, which is the same argument `deflect` makes
 * about the red bit, one level down.
 */
function damage(
  m: DataView,
  sim: Sim,
  snd: Snd,
  i: number,
  b: number,
  shot: boolean,
): boolean {
  const o = blockOff(i);
  const t = blockType(m, i);
  if (t === 0) return true;

  // The spark goes where the BALL is, because that is where the contact looked
  // like it happened; the break goes where the BLOCK was.
  if (b >= 0) {
    burstSpark(
      m,
      sim,
      rv(m, b + B_X) + BALL_SIZE * 0.5,
      rv(m, b + B_Y) + BALL_SIZE * 0.5,
      blockRgb(t, rv(m, o + K_HITS)),
      4,
      0.6,
    );
  }

  if (t === 5) {
    rs(m, o + K_FLASH, 1);
    return true;
  }

  if (t === 6 && !shot && mech(m, MECH_SHIELD)) {
    rs(m, o + K_FLASH, 1);
    ring(m, blockX(m, i) + BLOCK_W * 0.5, blockY(i) + BLOCK_H * 0.5, 10, 0x2be8b0, 3, 7, 0.8);
    snd.play(SFX.PING);
    return true;
  }

  // RULE 4, and the whole of it: a RED ball spends every remaining hit at once
  // and is not deflected. It is tested AFTER the two structural types above, so
  // rule 6 wins without rule 4 having to know about it.
  const red = b >= 0 && (flags(m, b) & 2) !== 0;
  const h = red ? 0 : rv(m, o + K_HITS) - 1;
  if (h > 0) {
    rs(m, o + K_HITS, h);
    rs(m, o + K_FLASH, 1);
    shake(m, 2);
    snd.play(SFX.HIT);
    return true;
  }

  const bx = blockX(m, i);
  const by = blockY(i);
  const colour = blockRgb(t, 1);
  rs(m, o + K_TYPE, 0);
  rs(m, o + K_HITS, 0);
  rs(m, o + K_FLASH, 0);

  burstBlock(
    m,
    sim,
    bx,
    by,
    colour,
    b >= 0 ? rv(m, b + B_VX) : 0,
    b >= 0 ? rv(m, b + B_VY) : -SHOT_SPEED * 0.2,
  );
  shake(m, t === 6 ? 9 : 4);
  // A shielded block is the one a ball cannot touch, so its break is not the
  // ordinary break: it is the payoff for having brought a gun.
  snd.play(t === 6 ? SFX.SHIELD : SFX.BREAK);

  // RULE 1, and the only place in this file that sets RED. The whole screen
  // goes with it: the alarm rises, the beam snaps on beneath the paddle, a
  // shock ring leaves the ball and the bloom lifts. The player has about a
  // second, and every one of those is geometry except the bloom.
  //
  // THE ALARM IS FIRED HERE, INSIDE THE BRANCH THAT SETS THE BIT. Not from a
  // later test of the flag, not from `stepVisuals`, not from `render`: the
  // state and the warning are one statement apart and cannot drift.
  if (t === 4 && b >= 0 && mech(m, MECH_RED)) {
    setFlags(m, b, flags(m, b) | 2);
    snd.play(SFX.RED);
    rs(m, b + B_REDT, 0);
    gs(m, G.ALARM, 1);
    gs(m, G.BEAM, 1);
    const cx = rv(m, b + B_X) + BALL_SIZE * 0.5;
    const cy = rv(m, b + B_Y) + BALL_SIZE * 0.5;
    ring(m, cx, cy, 30, 0xff2e4d, 3, 22, 1.8);
    ring(m, cx, cy, 20, 0xffd9de, 2, 12, 1.0);
    burstSpark(m, sim, cx, cy, 0xff2e4d, 26, 2.1);
    shake(m, 20);
    bloomUp(m, 1);
  }

  dropFrom(m, sim, snd, t, bx, by);
  return !red;
}

/**
 * The paddle, the beam and the floor, in that order -- which is also top to
 * bottom, so a ball meets them the way it falls past them.
 *
 * Returns false when the ball is gone. The paddle test does NOT look at the
 * ball's direction while it is RED: rule 3 says "touches", and a red ball
 * clipping the paddle's shoulder on the way up has still touched it.
 */
function contact(m: DataView, sim: Sim, snd: Snd, b: number): boolean {
  const f = flags(m, b);
  const x = rv(m, b + B_X);
  const y = rv(m, b + B_Y);
  const pw = gv(m, G.PAD_W);
  const px = gv(m, G.PAD_X);

  if (
    y + BALL_SIZE > PADDLE_Y &&
    y < PADDLE_Y + PADDLE_H &&
    x + BALL_SIZE > px &&
    x < px + pw
  ) {
    // RULE 3. The one contact that does not call `bounce`, and therefore the
    // one contact that does not clear the RED bit -- `redHit` ends the ball.
    if (f & 2) {
      redHit(m, sim, snd);
      return false;
    }
    if (rv(m, b + B_VY) > 0) {
      rs(m, b + B_Y, PADDLE_Y - BALL_SIZE);
      gs(m, G.PAD_SQUASH, 1);
      burstSpark(m, sim, x + BALL_SIZE * 0.5, PADDLE_Y, 0xd8e8ff, 6, 0.8);
      if (gv(m, G.CATCH_T) > 0) {
        setFlags(m, b, f | 4);
        rs(m, b + B_VX, 0);
        rs(m, b + B_VY, 0);
        return true;
      }
      const spd = speed(m);
      const mn = spd * MIN_ANGLE;
      const half = pw * 0.5;
      const rel = x + BALL_SIZE * 0.5 - px - half;
      // Where on the paddle it landed decides the angle. A dead-centre hit
      // would send the ball straight up forever, so MIN_ANGLE is a floor as
      // well as the serve angle.
      let vx = (rel * spd * SPREAD) / half;
      if (vx < mn && vx > -mn) vx = rel < 0 ? -mn : mn;
      rs(m, b + B_VX, vx);
      rs(m, b + B_VY, -spd);
      // AFTER the `catch` return above, so a ball that sticks to the paddle is
      // silent: the paddle cue means "returned", and a caught ball was not.
      snd.play(SFX.PADDLE);
    }
    return true;
  }

  // THE BEAM DEFLECTS A RED BALL AND NOTHING ELSE. Drop the `f & 2` and it
  // becomes a floor, and the game stops being able to end.
  if (
    f & 2 &&
    rv(m, b + B_VY) > 0 &&
    y + BALL_SIZE > BEAM_Y &&
    y < BEAM_Y + BEAM_H
  ) {
    rs(m, b + B_Y, BEAM_Y - BALL_SIZE);
    bounce(m, b, 1);
    deflect(m, b); // RULE 7, at the cart's one call site
    // The relief beat. It lands as hard as the alarm did, in the same places --
    // and the cue shares the alarm's channel, so IT CUTS THE ALARM OFF WHERE IT
    // STANDS. The player hears the warning stop, which is the whole message.
    snd.play(SFX.DEFLECT);
    gs(m, G.DEFLECT_T, 1);
    ring(m, x + BALL_SIZE * 0.5, BEAM_Y, 24, 0xff6b80, 2, 17, 1.5);
    burstSpark(m, sim, x + BALL_SIZE * 0.5, BEAM_Y, 0xffc2cc, 22, 1.6);
    shake(m, 11);
    bloomUp(m, 0.7);
    return true;
  }

  if (y >= FIELD) {
    setFlags(m, b, 0);
    rs(m, b + B_REDT, 0);
    burstSpark(m, sim, x + BALL_SIZE * 0.5, FIELD - 1, 0x6a7ba8, 10, 1.0);
    // A BALL ROLLING OUT OF THE WORLD IS NOT A PADDLE BEING DESTROYED. They
    // shared one cue on the small console once and the player could not tell
    // from the sound which of the two had happened.
    snd.play(SFX.LOSE);
    return false;
  }
  return true;
}

/**
 * One substep. X and Y are resolved SEPARATELY, and in that order.
 *
 * Resolving both at once has to choose an axis to push out of, and the wrong
 * choice is exactly how a ball snags on a block's corner and how it tunnels
 * through the seam between two of them. Each axis moves, tests the cells its
 * new leading edge covers, and on a hit is put back where it was before that
 * axis moved -- never further, so a ball that starts inside a block simply
 * stops rather than being flung across the field.
 *
 * A BLOCK IS THE ONE CONTACT WITH TWO ANSWERS, and `damage` gives it. A ball
 * that PLOUGHED is not put back and does not bounce, so the position it already
 * moved to stands and the rest of the frame carries it on into the next block.
 * Everything else on both axes is unchanged, which is why rule 4 cost the
 * tunnelling bound nothing: a substep still moves at most `STEP_MAX`.
 */
function subStep(m: DataView, sim: Sim, snd: Snd, b: number, dx: number, dy: number): boolean {
  const x0 = rv(m, b + B_X);
  let x = x0 + dx;
  if (x < 0) {
    x = 0;
    edge(m, sim, snd, b, 0);
  } else if (x + BALL_SIZE > FIELD) {
    x = FIELD - BALL_SIZE;
    edge(m, sim, snd, b, 0);
  } else {
    const c = cellAt(m, x, rv(m, b + B_Y));
    if (c >= 0 && damage(m, sim, snd, c, b, false)) {
      x = x0;
      bounce(m, b, 0);
    }
  }
  rs(m, b + B_X, x);

  const y0 = rv(m, b + B_Y);
  let y = y0 + dy;
  if (y < CEILING_Y) {
    y = CEILING_Y;
    edge(m, sim, snd, b, 1);
  } else {
    const c = cellAt(m, x, y);
    if (c >= 0 && damage(m, sim, snd, c, b, false)) {
      y = y0;
      bounce(m, b, 1);
    }
  }
  rs(m, b + B_Y, y);
  return contact(m, sim, snd, b);
}

/** One frame of one ball, in substeps small enough never to skip a block. */
function move(m: DataView, sim: Sim, snd: Snd, b: number): void {
  const vx = rv(m, b + B_VX);
  const vy = rv(m, b + B_VY);
  let mx = Math.abs(vx) > Math.abs(vy) ? Math.abs(vx) : Math.abs(vy);
  // A bounce inside a substep can set a component to the full ball speed, so
  // the bound is taken over what the velocity may BECOME this frame.
  const cap = speed(m) * 2;
  if (cap > mx) mx = cap;
  const n = 1 + Math.floor(mx / STEP_MAX);
  for (let s = 0; s < n; s++) {
    // Re-read every substep: a bounce partway through changes the direction of
    // the rest of the frame, which is the whole reason for substepping.
    if (!subStep(m, sim, snd, b, rv(m, b + B_VX) / n, rv(m, b + B_VY) / n)) return;
  }
}

function ballsAlive(m: DataView): number {
  let n = 0;
  for (let i = 0; i < MAX_BALLS; i++) if (flags(m, ballOff(i)) & 1) n++;
  return n;
}

/** Is any ball RED? The beam exists exactly while this is true. */
export function anyRed(m: DataView): boolean {
  for (let i = 0; i < MAX_BALLS; i++) if ((flags(m, ballOff(i)) & 3) === 3) return true;
  return false;
}

/** A ball waiting on the paddle: the serve, and what `catch` turns a hit into. */
function stick(m: DataView, sim: Sim, b: number, f: number, pressed: number): void {
  rs(m, b + B_X, gv(m, G.PAD_X) + (gv(m, G.PAD_W) - BALL_SIZE) * 0.5);
  rs(m, b + B_Y, PADDLE_Y - BALL_SIZE);
  gs(m, G.SERVE_T, gv(m, G.SERVE_T) + 1);
  if (pressed & (1 << BTN_A)) launch(m, sim, b, f);
}

function launch(m: DataView, sim: Sim, b: number, f: number): void {
  const spd = speed(m);
  const mn = spd * MIN_ANGLE;
  rs(m, b + B_VX, sim.rnd(2) ? mn : -mn);
  rs(m, b + B_VY, -spd);
  setFlags(m, b, f & ~4);
  gs(m, G.SERVE_T, 0);
  resetTrail(m, b);
  // `ballCount` belongs to the SERVE, and a serve is the one launch where
  // nothing else is in play and no `catch` is running. Without both tests a
  // player holding the last ball on a caught paddle would mint a fresh
  // `ballCount` every time they let go.
  if (ballsAlive(m) === 1 && gv(m, G.CATCH_T) <= 0 && mech(m, MECH_MULTI)) {
    const n = hdr(m).ballCount;
    for (let i = 1; i < n; i++) split(m);
  }
}

/** Copy a live ball into a free slot, mirrored on X. The `multi` drop. */
function split(m: DataView): void {
  for (let i = 0; i < MAX_BALLS; i++) {
    const b = ballOff(i);
    const f = flags(m, b);
    if ((f & 5) !== 1) continue;
    for (let j = 0; j < MAX_BALLS; j++) {
      const o = ballOff(j);
      if (flags(m, o) & 1) continue;
      rs(m, o + B_X, rv(m, b + B_X));
      rs(m, o + B_Y, rv(m, b + B_Y));
      rs(m, o + B_PX, rv(m, b + B_X));
      rs(m, o + B_PY, rv(m, b + B_Y));
      rs(m, o + B_VX, -rv(m, b + B_VX));
      rs(m, o + B_VY, rv(m, b + B_VY));
      setFlags(m, o, f);
      rs(m, o + B_REDT, 0);
      resetTrail(m, o);
      return;
    }
    return;
  }
}

function spawnBall(m: DataView): void {
  for (let i = 0; i < MAX_BALLS; i++) {
    const b = ballOff(i);
    if (flags(m, b) & 1) continue;
    rs(m, b + B_VX, 0);
    rs(m, b + B_VY, 0);
    rs(m, b + B_REDT, 0);
    setFlags(m, b, 5); // alive and stuck
    rs(m, b + B_X, gv(m, G.PAD_X) + (gv(m, G.PAD_W) - BALL_SIZE) * 0.5);
    rs(m, b + B_Y, PADDLE_Y - BALL_SIZE);
    rs(m, b + B_PX, rv(m, b + B_X));
    rs(m, b + B_PY, rv(m, b + B_Y));
    resetTrail(m, b);
    gs(m, G.SERVE_T, 0);
    return;
  }
}

/**
 * RULE 3: the paddle is destroyed and a life goes with it.
 *
 * The life is taken HERE, on the frame of the contact; `DEAD_T` only holds the
 * beat afterwards. Bookkeeping and theatre are separable and the bookkeeping
 * does not get to wait -- while `DEAD_T` runs the simulation is skipped, so the
 * player cannot move, the serve cannot be launched, and the moment lands before
 * the next ball exists.
 */
function redHit(m: DataView, sim: Sim, snd: Snd): void {
  const px = gv(m, G.PAD_X);
  const pw = gv(m, G.PAD_W);
  // The worst sound in the game, in the one contact that never calls `bounce`.
  // `loseLife` may fire the game-over cue over the top of it on the same
  // channel, and on the last life that is the right ending.
  snd.play(SFX.SMASH);
  for (let i = 0; i < MAX_BALLS; i++) {
    setFlags(m, ballOff(i), 0);
    rs(m, ballOff(i) + B_REDT, 0);
  }

  // The paddle comes apart along its own width, upward and outward, with
  // gravity under it. This is the one burst the player is meant to watch.
  for (let k = 0; k < 72; k++) {
    const t = k / 71;
    const x = px + t * pw;
    const spread = (t - 0.5) * 2;
    particle(
      m,
      x,
      PADDLE_Y + sim.rndf() * PADDLE_H,
      spread * (0.5 + sim.rndf() * 1.3),
      -0.4 - sim.rndf() * 1.5,
      26 + (sim.rnd(26) | 0),
      k % 5 === 0 ? 0xffffff : k % 3 === 0 ? 0xff3355 : 0xd8e8ff,
      0.5 + sim.rndf() * 1.3,
      k % 5 === 0 ? 0 : 1,
      0.06,
    );
  }
  // Sized to stop AT the field's floor: the paddle sits 18 units above it, so a
  // ring that grew past 18 would leave the arena and read as a bug.
  ring(m, px + pw * 0.5, PADDLE_Y + PADDLE_H * 0.5, 36, 0xff2e4d, 3, 18, 2.2);
  ring(m, px + pw * 0.5, PADDLE_Y + PADDLE_H * 0.5, 24, 0xffffff, 2, 11, 1.2);
  gs(m, G.DEAD_X, px);
  gs(m, G.DEAD_W, pw);
  gs(m, G.ALARM, 1);
  shake(m, 34);
  bloomUp(m, 1.2);

  loseLife(m, snd);
  gs(m, G.DEAD_T, DEAD_FRAMES);
}

function loseLife(m: DataView, snd: Snd): void {
  const l = gv(m, G.LIVES);
  if (l < 2) {
    gs(m, G.LIVES, 0);
    gs(m, G.STATE, 1);
    gs(m, G.OVER_T, 0);
    snd.play(SFX.OVER);
    return;
  }
  gs(m, G.LIVES, l - 1);
  gs(m, G.LIFE_FLASH, 1);
  gs(m, G.PAD_W, hdr(m).paddleW);
  gs(m, G.WIDE_T, 0);
  gs(m, G.SLOW_T, 0);
  gs(m, G.CATCH_T, 0);
  spawnBall(m);
}

function balls(m: DataView, sim: Sim, snd: Snd, pressed: number): void {
  for (let i = 0; i < MAX_BALLS; i++) {
    const b = ballOff(i);
    const f = flags(m, b);
    if (!(f & 1)) continue;
    if (f & 4) stick(m, sim, b, f, pressed);
    else move(m, sim, snd, b);
    if (flags(m, b) & 1) {
      if (flags(m, b) & 2) rs(m, b + B_REDT, rv(m, b + B_REDT) + 1);
      pushTrail(m, b);
    }
  }
  if (ballsAlive(m) === 0) loseLife(m, snd);
}

// ===========================================================================
// The paddle, the pads and the gun
// ===========================================================================

function paddle(m: DataView, sim: Sim, snd: Snd, held: number, pressed: number): void {
  const left = (held >> BTN_LEFT) & 1;
  const right = (held >> BTN_RIGHT) & 1;
  const dir = right - left;

  // Easing, not teleporting. Top speed is unchanged; see PADDLE_EASE.
  let vx = gv(m, G.PAD_VX);
  vx += (dir * PADDLE_SPEED - vx) * PADDLE_EASE;
  if (dir === 0 && vx < PADDLE_STOP && vx > -PADDLE_STOP) vx = 0;

  let x = gv(m, G.PAD_X) + vx;
  const w = gv(m, G.PAD_W);
  const hi = FIELD - w;
  if (x < 0) {
    x = 0;
    vx = 0;
  }
  if (x > hi) {
    x = hi;
    vx = 0;
  }
  gs(m, G.PAD_X, x);
  gs(m, G.PAD_VX, vx);
  gs(m, G.PAD_TILT, vx / PADDLE_SPEED);

  // The side pads: touch one with the paddle and a shot is charged. The
  // previous frame's touch is remembered so that parking on a pad charges once
  // rather than sixty times a second.
  const h = hdr(m);
  if (h.sidePads && mech(m, MECH_PADS)) {
    let t = 0;
    if (x < PAD_ZONE) t = 1;
    if (x + w > FIELD - PAD_ZONE) t |= 2;
    if (t & ~(gv(m, G.PAD_TOUCH) | 0)) {
      gs(m, G.AMMO, gv(m, G.AMMO) + 1);
      gs(m, G.AMMO_FLASH, 1);
      burstSpark(m, sim, t & 1 ? 0 : FIELD, PADDLE_Y + PADDLE_H * 0.5, 0x2be8b0, 10, 1.1);
      // Inside the edge test, so parking on a pad charges once rather than
      // sixty times a second -- and the cue counts the same as the ammunition.
      snd.play(SFX.CHARGE);
    }
    gs(m, G.PAD_TOUCH, t);
  }
  if (pressed & (1 << BTN_B) && gv(m, G.AMMO) > 0) fire(m, sim, snd);
}

function fire(m: DataView, sim: Sim, snd: Snd): void {
  for (let i = 0; i < MAX_SHOTS; i++) {
    const s = shotOff(i);
    if (rv(m, s + S_LIVE)) continue;
    const x = gv(m, G.PAD_X) + gv(m, G.PAD_W) * 0.5 - SHOT_W * 0.5;
    rs(m, s + S_X, x);
    rs(m, s + S_Y, PADDLE_Y - SHOT_H);
    rs(m, s + S_PX, x);
    rs(m, s + S_PY, PADDLE_Y - SHOT_H);
    rs(m, s + S_LIVE, 1);
    rs(m, s + S_AGE, 0);
    gs(m, G.AMMO, gv(m, G.AMMO) - 1);
    gs(m, G.PAD_SQUASH, 0.6);
    burstSpark(m, sim, x + SHOT_W * 0.5, PADDLE_Y, 0xffd23f, 8, 0.9);
    // Only a shot that FOUND A SLOT makes a sound, so the cue means "something
    // left the paddle" and never "something nearly did".
    snd.play(SFX.SHOOT);
    return;
  }
}

/**
 * Shots, which do ONE job: they break blocks, and in particular the shielded
 * blocks a ball cannot.
 *
 * A shot used to clear a red ball as well. Rule 7 took that away -- the beam is
 * the only clear -- so a shot passes straight through a red ball and does
 * nothing to it, and nothing in this loop looks at a ball at all.
 */
function shots(m: DataView, sim: Sim, snd: Snd): void {
  for (let i = 0; i < MAX_SHOTS; i++) {
    const s = shotOff(i);
    if (!rv(m, s + S_LIVE)) continue;
    const y = rv(m, s + S_Y) - SHOT_SPEED;
    const x = rv(m, s + S_X);
    rs(m, s + S_AGE, rv(m, s + S_AGE) + 1);
    if (y < CEILING_Y) {
      rs(m, s + S_LIVE, 0);
      burstSpark(m, sim, x + SHOT_W * 0.5, CEILING_Y, 0xffd23f, 6, 0.8);
      continue;
    }
    rs(m, s + S_Y, y);

    let c = at(m, x, y);
    if (c < 0) c = at(m, x + SHOT_W - EDGE_E, y);
    if (c >= 0) {
      damage(m, sim, snd, c, -1, true);
      rs(m, s + S_LIVE, 0);
    }
  }
}

// ===========================================================================
// Drops
// ===========================================================================

/**
 * Maybe drop something from the block that just broke.
 *
 * The kind is chosen from the level's `dropMask` by counting its set bits and
 * picking one, so a pack decides what a level may produce without the engine
 * holding a table of level contents. A type-8 block always drops.
 */
function dropFrom(m: DataView, sim: Sim, snd: Snd, t: number, bx: number, by: number): void {
  if (!mech(m, MECH_DROPS)) return;
  const h = hdr(m);
  const mask = h.dropMask;
  if (!mask) return;
  if (t !== 8 && sim.rnd(256) >= h.dropRate) return;
  let n = 0;
  for (let k = 0; k < 6; k++) if ((mask >> k) & 1) n++;
  if (!n) return;
  let p = sim.rnd(n);
  let kind = 0;
  for (let k = 0; k < 6; k++) {
    if (!((mask >> k) & 1)) continue;
    if (!p) {
      kind = k;
      break;
    }
    p--;
  }
  let x = bx;
  if (x < 0) x = 0;
  if (x + DROP_W > FIELD) x = FIELD - DROP_W;
  for (let k = 0; k < MAX_DROPS; k++) {
    const d = dropOff(k);
    if (rv(m, d + D_KIND)) continue;
    rs(m, d + D_X, x + (BLOCK_W - DROP_W) * 0.5);
    rs(m, d + D_Y, by);
    rs(m, d + D_PX, x + (BLOCK_W - DROP_W) * 0.5);
    rs(m, d + D_PY, by);
    rs(m, d + D_KIND, kind + 1);
    rs(m, d + D_AGE, 0);
    // Only a drop that FOUND A SLOT makes a sound: the cue means "there is
    // something falling" and never "there nearly was".
    snd.play(SFX.SPAWN);
    return;
  }
}

/** The six drop kinds, in `dropMask`'s own bit order. */
function applyDrop(m: DataView, sim: Sim, snd: Snd, k: number, x: number, y: number): void {
  // The extra life is the longest and warmest thing in the bank, and it is the
  // only drop with a cue of its own: catching a life is not catching a drop.
  snd.play(k === 4 ? SFX.LIFE : SFX.DROP);
  if (k === 0) {
    const w = gv(m, G.PAD_W) + WIDE_GROW;
    gs(m, G.PAD_W, w > PADDLE_MAX_W ? PADDLE_MAX_W : w);
    gs(m, G.WIDE_T, POWER_FRAMES);
  } else if (k === 1) {
    gs(m, G.SLOW_T, POWER_FRAMES);
  } else if (k === 2) {
    gs(m, G.AMMO, gv(m, G.AMMO) + GUN_SHOTS);
    gs(m, G.AMMO_FLASH, 1);
  } else if (k === 3) {
    split(m);
  } else if (k === 4) {
    gs(m, G.LIVES, gv(m, G.LIVES) + 1);
    gs(m, G.LIFE_FLASH, 1);
  } else {
    gs(m, G.CATCH_T, POWER_FRAMES);
  }
  ring(m, x, y, 18, DROP_RGB[k] as number, 2, 10, 1.1);
  burstSpark(m, sim, x, y, DROP_RGB[k] as number, 14, 1.1);
  gs(m, G.PAD_SQUASH, 0.8);
}

/** Drops fall whatever the ball is doing; a RED ball does not stop them. */
function drops(m: DataView, sim: Sim, snd: Snd): void {
  for (let i = 0; i < MAX_DROPS; i++) {
    const d = dropOff(i);
    const k = rv(m, d + D_KIND) | 0;
    if (!k) continue;
    const y = rv(m, d + D_Y) + DROP_SPEED;
    rs(m, d + D_Y, y);
    rs(m, d + D_AGE, rv(m, d + D_AGE) + 1);
    if (y >= FIELD) {
      rs(m, d + D_KIND, 0);
      continue;
    }
    const px = gv(m, G.PAD_X);
    const x = rv(m, d + D_X);
    if (
      y + DROP_H > PADDLE_Y &&
      y < PADDLE_Y + PADDLE_H &&
      x + DROP_W > px &&
      x < px + gv(m, G.PAD_W)
    ) {
      rs(m, d + D_KIND, 0);
      applyDrop(m, sim, snd, k - 1, x + DROP_W * 0.5, PADDLE_Y);
    }
  }
}

// ===========================================================================
// Timers, drift, and loading a level
// ===========================================================================

function timers(m: DataView): void {
  const w = gv(m, G.WIDE_T);
  if (w > 0) {
    gs(m, G.WIDE_T, w - 1);
    if (w === 1) gs(m, G.PAD_W, hdr(m).paddleW);
  }
  const s = gv(m, G.SLOW_T);
  if (s > 0) gs(m, G.SLOW_T, s - 1);
  const c = gv(m, G.CATCH_T);
  if (c > 0) gs(m, G.CATCH_T, c - 1);
}

/** One shared offset slides every drifter row, out to `DRIFT_RANGE` and back. */
function driftStep(m: DataView): void {
  const s = hdr(m).driftSpeed;
  if (!s || !mech(m, MECH_DRIFT)) return;
  let d = gv(m, G.DRIFT) + (gv(m, G.DRIFT_DIR) ? -s : s);
  if (d > DRIFT_RANGE) {
    d = DRIFT_RANGE;
    gs(m, G.DRIFT_DIR, 1);
  }
  if (d < -DRIFT_RANGE) {
    d = -DRIFT_RANGE;
    gs(m, G.DRIFT_DIR, 0);
  }
  gs(m, G.DRIFT, d);
}

/**
 * Read one level out of the pack. Nothing about a level is generated, and
 * nothing about it is written here.
 *
 * A block cell carries what it is and how much of it is left, exactly as the
 * small console's one byte of `type | hits << 4` did.
 */
function loadLevel(m: DataView): void {
  const l = gv(m, G.LEVEL) | 0;
  const grid = GRIDS[l < 0 ? 0 : l >= LEVEL_COUNT ? LEVEL_COUNT - 1 : l] as Uint8Array;
  let rows = 0;
  for (let i = 0; i < CELLS; i++) {
    const t = grid[i] as number;
    const o = blockOff(i);
    if (t === 7) rows |= 1 << ((i / GRID_W) | 0);
    rs(m, o + K_TYPE, t);
    rs(m, o + K_HITS, t ? hitsFor(m, t) : 0);
    rs(m, o + K_FLASH, 0);
    rs(m, o + K_FLASH_PREV, 0);
  }
  gs(m, G.ROWS, rows);

  // Balls, drops and shots at once -- and no spark outlives the level it
  // happened on, which is why the pools go with them.
  wipe(m, BALLS_OFF, BLOCKS_OFF);
  wipe(m, RINGS_OFF, ARENA_USED);
  gs(m, G.PART_CUR, 0);
  gs(m, G.RING_CUR, 0);

  const h = hdr(m);
  gs(m, G.PAD_W, h.paddleW);
  gs(m, G.PAD_X, (FIELD - h.paddleW) * 0.5);
  gs(m, G.PAD_PX, (FIELD - h.paddleW) * 0.5);
  gs(m, G.PAD_VX, 0);
  gs(m, G.AMMO, h.ammoStart);
  gs(m, G.WIDE_T, 0);
  gs(m, G.SLOW_T, 0);
  gs(m, G.CATCH_T, 0);
  gs(m, G.PAD_TOUCH, 0);
  gs(m, G.DRIFT_DIR, 0);
  gs(m, G.DRIFT, 0);
  gs(m, G.DRIFT_PREV, 0);
  gs(m, G.BEAM, 0);
  gs(m, G.ALARM, 0);
  gs(m, G.LEVEL_T, 0);
  spawnBall(m);
}

/**
 * Play the band this level belongs to, AND ONLY WHEN THE BAND CHANGES.
 *
 * Three judgement calls, each of which could defensibly have gone the other way
 * and each of which `packages/prime/README.md` states with its reason:
 *
 *   - **It starts on the first tick**, not in `boot`. The small console starts
 *     it in `loadLevel`, which `boot` calls last; Prime differs by one sixtieth
 *     of a second and gains the rule that everything that happens, happens in
 *     `tick`. The mixer latches the request, so the theme arrives under the
 *     serve exactly as it does there -- `MUSIC_FADE_FRAMES` of it.
 *   - **It restarts only when the band changes.** A band is a two-bar loop;
 *     clipping it at every level would say nothing the HUD's level number has
 *     not already said, three times over on the way to level 4. That is why
 *     `G.BAND` exists and why it is in the arena.
 *   - **It plays through a lost life and through game over.** An effect on a
 *     music channel takes that voice for its length and gives it back, so the
 *     loss, the smash and the game over all land on a continuing melody with
 *     the floor gone from under them. Silencing the song would put a second of
 *     silence exactly where the cue is.
 *
 * Calling it every tick is the mechanism, not waste: this asserts which band
 * SHOULD be playing and the mixer decides whether anything has to happen.
 */
function song(m: DataView, snd: Snd): void {
  const want = bandForLevel(gv(m, G.LEVEL) | 0) + 1;
  if ((gv(m, G.BAND) | 0) === want) return;
  gs(m, G.BAND, want);
  snd.music(want - 1, MUSIC_FADE_FRAMES);
}

/** Start a run. Called from `boot`, and again when a finished run is restarted. */
function resetRun(m: DataView): void {
  wipe(m, 0, ARENA_USED);
  gs(m, G.LIVES, START_LIVES);
  gs(m, G.LEVEL, 0);
  gs(m, G.STATE, 0);
  loadLevel(m);
}

// ===========================================================================
// Presentation state that still lives in the arena
//
// Every one of these is a value `render` READS and never writes. They are eased
// in `tick` because that is the only place anything may be written, and they
// are in the arena because a rollback that restored the game but not the glow
// would show a frame nobody simulated.
// ===========================================================================

function savePrev(m: DataView): void {
  gs(m, G.PAD_PX, gv(m, G.PAD_X));
  gs(m, G.DRIFT_PREV, gv(m, G.DRIFT));
  gs(m, G.SHAKE_PREV, gv(m, G.SHAKE));
  gs(m, G.BEAM_PREV, gv(m, G.BEAM));
  gs(m, G.ALARM_PREV, gv(m, G.ALARM));
  gs(m, G.CLEAR_PREV, gv(m, G.CLEAR_T));
  gs(m, G.PAD_SQUASH_PREV, gv(m, G.PAD_SQUASH));
  gs(m, G.PAD_TILT_PREV, gv(m, G.PAD_TILT));
  gs(m, G.BLOOM_PREV, gv(m, G.BLOOM));
  gs(m, G.DEFLECT_PREV, gv(m, G.DEFLECT_T));
  for (let i = 0; i < MAX_BALLS; i++) {
    const b = ballOff(i);
    rs(m, b + B_PX, rv(m, b + B_X));
    rs(m, b + B_PY, rv(m, b + B_Y));
  }
  for (let i = 0; i < MAX_DROPS; i++) {
    const d = dropOff(i);
    rs(m, d + D_PX, rv(m, d + D_X));
    rs(m, d + D_PY, rv(m, d + D_Y));
  }
  for (let i = 0; i < MAX_SHOTS; i++) {
    const s = shotOff(i);
    rs(m, s + S_PX, rv(m, s + S_X));
    rs(m, s + S_PY, rv(m, s + S_Y));
  }
  for (let i = 0; i < CELLS; i++) {
    const o = blockOff(i);
    rs(m, o + K_FLASH_PREV, rv(m, o + K_FLASH));
  }
}

/**
 * Decay everything that glows.
 *
 * THE BEAM'S ENERGY FALLS FAST. It is an afterglow of an event that just ended,
 * and a beam that lingered would say "a red ball is out there" after the red
 * was gone -- which is information, and information may not live in a fade any
 * more than it may live in a post stage. Four frames is short enough to read as
 * the beam switching off and long enough not to pop.
 */
function stepVisuals(m: DataView): void {
  const red = anyRed(m);
  gs(m, G.BEAM, red ? 1 : gv(m, G.BEAM) * 0.45);
  gs(m, G.ALARM, red ? Math.min(1, gv(m, G.ALARM) * 0.9 + 0.12) : gv(m, G.ALARM) * 0.88);
  gs(m, G.SHAKE, gv(m, G.SHAKE) * 0.84);
  gs(m, G.BLOOM, gv(m, G.BLOOM) * 0.9);
  gs(m, G.CLEAR_T, gv(m, G.CLEAR_T) * 0.94);
  gs(m, G.DEFLECT_T, gv(m, G.DEFLECT_T) * 0.9);
  gs(m, G.PAD_SQUASH, gv(m, G.PAD_SQUASH) * 0.8);
  gs(m, G.LIFE_FLASH, gv(m, G.LIFE_FLASH) * 0.93);
  gs(m, G.AMMO_FLASH, gv(m, G.AMMO_FLASH) * 0.93);
  gs(m, G.LEVEL_T, gv(m, G.LEVEL_T) + 1);
  for (let i = 0; i < CELLS; i++) {
    const o = blockOff(i);
    const f = rv(m, o + K_FLASH);
    if (f > 0) rs(m, o + K_FLASH, f * 0.82);
  }
  stepParticles(m);
  stepRings(m);
}

// ===========================================================================
// Colour
// ===========================================================================

/** Pack `0xRRGGBB` and an alpha in [0, 1] into the ABI's `0xRRGGBBAA`. */
function col(rgb: number, a: number): number {
  const q = a <= 0 ? 0 : a >= 1 ? 255 : Math.round(a * 255);
  return (rgb * 256 + q) >>> 0;
}

/**
 * The eight block types, by the format's own numbering.
 *
 * Types 2 and 3 both take more than one hit and they get DIFFERENT colours: a
 * player who cannot tell a two-hit block from a three-hit one cannot plan a
 * route through a wall, and finds out only by spending a ball. Damage shows by
 * falling back to `DAMAGED_RGB` once a block has been hit and is still
 * standing, which is what `h < t` means for exactly those two -- so a damaged
 * three-hit block reads as "hit, still there" rather than as a two-hit block.
 */
const BLOCK_RGB: readonly number[] = [
  0x000000, // 0 empty
  0x5fd8ff, // 1 plain
  0xffb23f, // 2 tough
  0xb273ff, // 3 hard
  0xff2e4d, // 4 RED -- the most alarming colour here, and the only warning
  0x39405e, // 5 solid
  0x2be8b0, // 6 shielded
  0xffe066, // 7 drifter
  0xff6fc8, // 8 prize
];

const DAMAGED_RGB = 0x6c6489;

/** The six drop kinds, in `dropMask`'s bit order. */
const DROP_RGB: readonly number[] = [
  0x63e06b, // wide
  0x4fc3f7, // slow
  0xffd23f, // gun
  0xff8ae2, // multi
  0xff4d6d, // life
  0xb58cff, // catch
];

/** One letter each, so a falling drop says what it is without a legend. */
const DROP_LETTER: readonly string[] = ["W", "S", "G", "M", "L", "C"];

const BG_RGB = 0x05040c;
const FIELD_RGB = 0x0b0a18;
const GRID_RGB = 0x171432;
const BEZEL_RGB = 0x15122c;
const PADDLE_RGB = 0xd8e8ff;
const BALL_RGB = 0xffffff;
const BALL_GLOW_RGB = 0x9fd8ff;
const BALL_RED_RGB = 0xff3355;
const BEAM_RGB = 0xff2e4d;
const PAD_RGB = 0x2be8b0;
const SHOT_RGB = 0xffd23f;
const INK_RGB = 0xe6e2ff;
const DIM_RGB = 0x7d76a8;

function blockRgb(t: number, hitsLeft: number): number {
  if (t === 2 || t === 3) return hitsLeft < t ? DAMAGED_RGB : (BLOCK_RGB[t] as number);
  return BLOCK_RGB[t] as number;
}

/** How far row `r` has slid, given the drifting-row mask and the shared offset. */
function rowDrift(rows: number, r: number, drift: number): number {
  return (rows >> r) & 1 ? drift : 0;
}

// ===========================================================================
// The cart
// ===========================================================================

/**
 * The ABI button bits this cart reads, named.
 *
 * `render`'s prompts ask {@link Ui.label} about these same constants, so what
 * the screen names and what `tick` reads can never drift into being two
 * different buttons. The NUMBERS are the ABI's and are the same everywhere; what
 * they are CALLED is the console's and differs per device, which is the whole
 * reason the prompt has to ask.
 */
const BTN_LEFT = 2;
const BTN_RIGHT = 3;
const BTN_A = 4;
const BTN_B = 5;

/**
 * `snd` is accepted and not used.
 *
 * The signature is the ABI's and the parameter is real: a cart that wanted a
 * chord under its title screen would play it here. This one opens in silence
 * because the first sound Red Breaker makes should be the serve.
 */
function boot(sim: Sim, _snd: Snd): void {
  resetRun(sim.mem);
}

function tick(sim: Sim, input: InputFrame, snd: Snd): void {
  const m = sim.mem;
  const held = (input.buttons[0] ?? 0) & 0xffff;
  const prev = gv(m, G.PREV_BTN) | 0;
  const pressed = held & ~prev;
  gs(m, G.PREV_BTN, held);

  // Before anything moves. Every lerp `render` performs depends on this being
  // the first thing that happens in a tick, including the ticks that simulate
  // nothing.
  savePrev(m);

  // The difficulty curve, in the music. See `song`: this asserts the band every
  // tick and fires only when it changes, which is why a level that does not
  // change the band never clips the loop.
  song(m, snd);

  const state = gv(m, G.STATE) | 0;
  if (state) {
    gs(m, G.OVER_T, gv(m, G.OVER_T) + 1);
    // A finished run still animates: the debris of the paddle that ended it is
    // on screen and it has somewhere to fall.
    stepVisuals(m);
    if (pressed & (1 << BTN_A)) {
      resetRun(m);
      // `resetRun` zeroes the arena, which includes last frame's buttons. Put
      // them back, or the A that restarted the run is seen as a fresh press
      // next tick and serves the first ball out from under the player.
      gs(m, G.PREV_BTN, held);
    }
    return;
  }

  // The beat after a red ball takes the paddle. The life is already gone; what
  // this holds is the moment. Nothing simulates, so the serve cannot be
  // launched out from under the animation and the paddle cannot slide away.
  const dead = gv(m, G.DEAD_T);
  if (dead > 0) {
    gs(m, G.DEAD_T, dead - 1);
    stepVisuals(m);
    return;
  }

  paddle(m, sim, snd, held, pressed);
  timers(m);
  driftStep(m);
  balls(m, sim, snd, pressed);
  drops(m, sim, snd);
  shots(m, sim, snd);
  stepVisuals(m);

  if (cleared(m)) {
    const next = (gv(m, G.LEVEL) | 0) + 1;
    // BEFORE the branch, so the LAST level cleared sounds like a level cleared
    // and winning the game is not the one clear the player never hears.
    snd.play(SFX.CLEAR);
    gs(m, G.CLEAR_T, 1);
    shake(m, 14);
    bloomUp(m, 0.8);
    if (next >= LEVEL_COUNT) {
      gs(m, G.STATE, 2);
      gs(m, G.OVER_T, 0);
    } else {
      gs(m, G.LEVEL, next);
      loadLevel(m);
      // After the load, so the new level opens with the old one's applause.
      for (let k = 0; k < 40; k++) {
        const a = sim.rndf() * TAU;
        const sp = 0.5 + sim.rndf() * 1.8;
        particle(
          m,
          FIELD * 0.5,
          FIELD * 0.5,
          sim.cos(a) * sp,
          sim.sin(a) * sp * 0.6,
          30 + (sim.rnd(24) | 0),
          0x9fd8ff,
          0.5 + sim.rndf() * 1.1,
          0,
          -0.004,
        );
      }
      ring(m, FIELD * 0.5, FIELD * 0.5, 26, 0x9fd8ff, 4, 24, 1.6);
      gs(m, G.CLEAR_T, 1);
    }
  }
}

// ===========================================================================
// `render` -- reads the arena, writes nothing, and lerps everything that moves
// ===========================================================================

/** Field units to screen. Exact: `SCALE` is a power of two. */
function sx(x: number): number {
  return ORIGIN_X + x * SCALE;
}

function sy(y: number): number {
  return ORIGIN_Y + y * SCALE;
}

function lerp(p: number, c: number, a: number): number {
  return p + (c - p) * a;
}

/**
 * A ring, as a closed polygon of additive segments.
 *
 * `draw.circle` is filled, and an additive filled disc is a flash rather than a
 * ring. Forty segments is what it takes for the eye to stop seeing a polygon at
 * this scale -- twenty-four left visible corners on the larger rings, which is
 * the kind of thing no unit test has an opinion about and one screenshot
 * settles.
 */
function strokeRing(
  sim: SimRead,
  draw: Draw,
  cx: number,
  cy: number,
  r: number,
  w: number,
  rgb: number,
  fade: number,
): void {
  const N = 56;
  // OPAQUE, AND FADED BY DIMMING THE COLOUR RATHER THAN BY DROPPING THE ALPHA.
  //
  // The renderer gives every line a round cap, so a polyline paints each joint
  // twice. At alpha 1 that costs nothing -- the same colour laid down twice is
  // the same colour. At alpha 0.2 it does not: the joint composites to 0.36 and
  // the ring comes out as a string of beads, and the bloom pass then SQUARES
  // every channel, which turns a small difference into a large one. So the ring
  // is drawn opaque and dimmed toward the field's near-black, which fades it
  // without ever compositing partial coverage.
  const c = col(dimRgb(rgb, fade), 1);
  let px = cx + r;
  let py = cy;
  for (let i = 1; i <= N; i++) {
    const a = (i / N) * TAU;
    const nx = cx + sim.cos(a) * r;
    const ny = cy + sim.sin(a) * r;
    draw.line(px, py, nx, ny, w, c);
    px = nx;
    py = ny;
  }
}

/** Scale a packed `0xRRGGBB` toward black. See {@link strokeRing}. */
function dimRgb(rgb: number, k: number): number {
  const f = k <= 0 ? 0 : k >= 1 ? 1 : k;
  const r = Math.round(((rgb >> 16) & 255) * f);
  const g2 = Math.round(((rgb >> 8) & 255) * f);
  const b = Math.round((rgb & 255) * f);
  return (r << 16) | (g2 << 8) | b;
}

/** A pip: the small shapes the HUD counts lives and shots with. */
function pip(draw: Draw, x: number, y: number, w: number, h: number, colour: number): void {
  draw.roundRect(x, y, w, h, h * 0.5, colour);
}

/**
 * Every on-screen prompt names a BUTTON and asks the console what it is called.
 *
 * THE CART MUST NEVER TYPE A KEY NAME. It shipped once drawing "PRESS A TO
 * SERVE" -- the ABI's logical button A -- on a keyboard whose serve is Z and
 * whose A key moves the paddle LEFT, so the prompt told the player to press the
 * one key that does the opposite of what the sentence says. The same panel drew
 * `< >` for a d-pad that is on the arrows. A cart cannot know a binding: it
 * differs between keyboard, gamepad and touch, and a player may remap it.
 *
 * `ui.label` is safe to read here and only here, because `render` cannot write
 * the arena and cannot make a sound -- so a string that differs between devices
 * cannot reach the simulation. See {@link Ui}.
 */
function render(sim: SimRead, draw: Draw, alpha: number, ui: Ui): void {
  const m = sim.mem;
  const tickN = Number(sim.tick & 0xffffffn);

  const level = gv(m, G.LEVEL) | 0;
  const h = LEVELS[level < 0 ? 0 : level >= LEVEL_COUNT ? LEVEL_COUNT - 1 : level] as
    (typeof LEVELS)[number];
  const state = gv(m, G.STATE) | 0;
  const dead = gv(m, G.DEAD_T);

  const drift = lerp(gv(m, G.DRIFT_PREV), gv(m, G.DRIFT), alpha);
  const rows = gv(m, G.ROWS) | 0;
  const padX = lerp(gv(m, G.PAD_PX), gv(m, G.PAD_X), alpha);
  const padW = gv(m, G.PAD_W);
  const beam = lerp(gv(m, G.BEAM_PREV), gv(m, G.BEAM), alpha);
  const alarm = lerp(gv(m, G.ALARM_PREV), gv(m, G.ALARM), alpha);
  const shakeAmt = lerp(gv(m, G.SHAKE_PREV), gv(m, G.SHAKE), alpha);
  const clearT = lerp(gv(m, G.CLEAR_PREV), gv(m, G.CLEAR_T), alpha);
  const squash = lerp(gv(m, G.PAD_SQUASH_PREV), gv(m, G.PAD_SQUASH), alpha);
  const tilt = lerp(gv(m, G.PAD_TILT_PREV), gv(m, G.PAD_TILT), alpha);
  const bloomLift = lerp(gv(m, G.BLOOM_PREV), gv(m, G.BLOOM), alpha);
  const deflect = lerp(gv(m, G.DEFLECT_PREV), gv(m, G.DEFLECT_T), alpha);

  const FX = sx(0);
  const FY = sy(0);
  const FW = FIELD * SCALE;

  // A slow free-running phase for the things that breathe. `sim.tick` is the
  // only clock, exactly as it is in the simulation.
  const pulse = sim.sin(tickN * 0.09);
  const fastPulse = sim.sin(tickN * 0.3);

  // =========================================================================
  // Layer 0 -- the room
  // =========================================================================
  draw.layer(0);
  draw.blend(0);
  draw.clear(col(BG_RGB, 1));

  // The cabinet: two side panels with the field cut out between them.
  draw.rect(0, 0, ORIGIN_X - 16, 1080, col(BEZEL_RGB, 0.55));
  draw.rect(FX + FW + 16, 0, 1920 - (FX + FW + 16), 1080, col(BEZEL_RGB, 0.55));

  // The field's floor, its frame, and a grid that gives the eye a scale.
  draw.roundRect(FX - 14, FY - 14, FW + 28, FW + 28, 22, col(0x120f26, 1));
  draw.roundRect(FX - 6, FY - 6, FW + 12, FW + 12, 16, col(FIELD_RGB, 1));
  for (let c = 0; c <= GRID_W; c++) {
    draw.line(sx(c * BLOCK_W), sy(FIELD_TOP), sx(c * BLOCK_W), sy(FIELD_TOP + GRID_H * BLOCK_H), 1, col(GRID_RGB, 0.8));
  }
  for (let r = 0; r <= GRID_H; r++) {
    draw.line(FX, sy(FIELD_TOP + r * BLOCK_H), FX + FW, sy(FIELD_TOP + r * BLOCK_H), 1, col(GRID_RGB, 0.55));
  }
  // The ceiling the ball bounces off, and the floor it is lost through: both
  // are rules, so both are drawn.
  draw.rect(FX, sy(CEILING_Y) - 3, FW, 3, col(0x3a3566, 1));
  draw.rect(FX, sy(FIELD) - 2, FW, 2, col(0x2a2145, 1));

  // =========================================================================
  // Layer 1 -- underglow. Additive haloes beneath the solid geometry.
  // =========================================================================
  draw.layer(1);
  draw.bloom(0.6 + bloomLift * 0.5, 0.42);
  draw.blend(1);
  for (let i = 0; i < CELLS; i++) {
    const o = blockOff(i);
    const t = rv(m, o + K_TYPE) | 0;
    if (!t) continue;
    if (t === 5) continue; // solid blocks are dead weight and do not glow
    const hits = rv(m, o + K_HITS);
    const rgb = blockRgb(t, hits);
    const dx = rowDrift(rows, (i / GRID_W) | 0, drift);
    const x = sx((i % GRID_W) * BLOCK_W + dx);
    const y = sy(blockY(i));
    const w = BLOCK_W * SCALE;
    const hgt = BLOCK_H * SCALE;
    // The red block is frightening before anyone has hit one: it is the only
    // block that pulses, and it pulses in the colour of the thing it does.
    const lift = t === 4 ? 0.2 + 0.16 * (pulse + 1) : 0.075;
    const grow = t === 4 ? 16 + 7 * (pulse + 1) : 9;
    draw.roundRect(x - grow, y - grow, w + grow * 2, hgt + grow * 2, 18, col(rgb, lift));
  }
  // The paddle's own light, and the side pads'.
  if (!dead && state !== 1) {
    draw.roundRect(sx(padX) - 16, sy(PADDLE_Y) - 14, padW * SCALE + 32, PADDLE_H * SCALE + 28, 18, col(PADDLE_RGB, 0.16));
  }
  if (h.sidePads && h.mechanic >= MECH_PADS) {
    const touch = gv(m, G.PAD_TOUCH) | 0;
    draw.roundRect(FX - 6, sy(PADDLE_Y) - 10, PAD_ZONE * SCALE + 12, PADDLE_H * SCALE + 20, 12, col(PAD_RGB, touch & 1 ? 0.5 : 0.12));
    draw.roundRect(sx(FIELD - PAD_ZONE) - 6, sy(PADDLE_Y) - 10, PAD_ZONE * SCALE + 12, PADDLE_H * SCALE + 20, 12, col(PAD_RGB, touch & 2 ? 0.5 : 0.12));
  }

  // =========================================================================
  // Layer 2 -- geometry. Solid, never additive: it must read as objects in
  // front of the glow, which is how layer order is legible at a glance.
  // =========================================================================
  draw.layer(2);
  draw.blend(0);
  for (let i = 0; i < CELLS; i++) {
    const o = blockOff(i);
    const t = rv(m, o + K_TYPE) | 0;
    if (!t) continue;
    const hits = rv(m, o + K_HITS);
    const flash = lerp(rv(m, o + K_FLASH_PREV), rv(m, o + K_FLASH), alpha);
    const dx = rowDrift(rows, (i / GRID_W) | 0, drift);
    const x = sx((i % GRID_W) * BLOCK_W + dx) + 3;
    const y = sy(blockY(i)) + 3;
    const w = BLOCK_W * SCALE - 6;
    const hgt = BLOCK_H * SCALE - 6;
    const rgb = blockRgb(t, hits);

    draw.roundRect(x, y, w, hgt, 7, col(rgb, t === 5 ? 1 : 0.96));
    // The bevel the small console drew with two palette slots, as light.
    draw.roundRect(x + 3, y + 3, w - 6, hgt * 0.34, 5, col(0xffffff, t === 5 ? 0.06 : 0.24));
    draw.rect(x + 3, y + hgt - 5, w - 6, 3, col(0x000000, 0.28));

    if (t === 5) {
      // Scenery, and it says so: hatched, and never lit.
      for (let k = 0; k < 4; k++) {
        draw.line(x + 6 + k * 14, y + hgt - 5, x + 16 + k * 14, y + 5, 2, col(0x565f8c, 0.5));
      }
    } else if (t === 6) {
      // SHOOT THIS ONE. The shield is drawn as a shield, not as a colour.
      strokeRing(sim, draw, x + w * 0.5, y + hgt * 0.5, hgt * 0.42, 3, 0xdcfff4, 0.8);
      draw.tri(
        x + w * 0.5, y + hgt * 0.5 - 9,
        x + w * 0.5 + 8, y + hgt * 0.5 + 6,
        x + w * 0.5 - 8, y + hgt * 0.5 + 6,
        col(0x0b2b22, 0.9),
      );
    } else if (t === 7) {
      // A drifter carries its motion on its face.
      const d = dx >= 0 ? 1 : -1;
      draw.tri(
        x + w * 0.5 + 9 * d, y + hgt * 0.5,
        x + w * 0.5 - 5 * d, y + hgt * 0.5 - 9,
        x + w * 0.5 - 5 * d, y + hgt * 0.5 + 9,
        col(0x3a2f05, 0.55),
      );
    } else if (t === 8) {
      draw.tri(x + w * 0.5, y + 8, x + w * 0.5 + 11, y + hgt * 0.5, x + w * 0.5 - 11, y + hgt * 0.5, col(0x4a0b33, 0.55));
      draw.tri(x + w * 0.5, y + hgt - 8, x + w * 0.5 + 11, y + hgt * 0.5, x + w * 0.5 - 11, y + hgt * 0.5, col(0x4a0b33, 0.55));
    } else if (t === 4) {
      // A cross-hair on the one block that changes the rules.
      draw.rect(x + w * 0.5 - 2, y + 6, 4, hgt - 12, col(0x2a0009, 0.45));
      draw.rect(x + 8, y + hgt * 0.5 - 2, w - 16, 4, col(0x2a0009, 0.45));
    } else if ((t === 2 || t === 3) && hits < t) {
      // A crack, so damage is legible with the colour ignored as well.
      draw.line(x + 10, y + hgt - 8, x + w * 0.45, y + 8, 2, col(0x000000, 0.4));
      draw.line(x + w * 0.45, y + 8, x + w - 12, y + hgt - 10, 2, col(0x000000, 0.4));
    }
    if (flash > 0.01) {
      draw.roundRect(x, y, w, hgt, 7, col(0xffffff, flash * 0.75));
    }
  }

  // The side pads.
  if (h.sidePads && h.mechanic >= MECH_PADS) {
    const touch = gv(m, G.PAD_TOUCH) | 0;
    draw.roundRect(FX, sy(PADDLE_Y), PAD_ZONE * SCALE, PADDLE_H * SCALE, 5, col(PAD_RGB, touch & 1 ? 1 : 0.5));
    draw.roundRect(sx(FIELD - PAD_ZONE), sy(PADDLE_Y), PAD_ZONE * SCALE, PADDLE_H * SCALE, 5, col(PAD_RGB, touch & 2 ? 1 : 0.5));
  }

  // The paddle. Gone entirely while `DEAD_T` runs, which reads as what
  // happened -- the debris on layer 3 is all that is left of it.
  if (dead <= 0 && state === 0) {
    const pw = padW * SCALE;
    const ph = PADDLE_H * SCALE;
    const sq = 1 + squash * 0.5;
    draw.push();
    draw.translate(sx(padX) + pw * 0.5, sy(PADDLE_Y) + ph * 0.5);
    draw.rotate(tilt * 0.05);
    draw.scale(1 + squash * 0.06, 1 / sq);
    draw.roundRect(-pw * 0.5, -ph * 0.5, pw, ph, ph * 0.5, col(PADDLE_RGB, 1));
    draw.roundRect(-pw * 0.5 + 4, -ph * 0.5 + 3, pw - 8, ph * 0.4, ph * 0.2, col(0xffffff, 0.55));
    // THE PADDLE VISIBLY CHANGES WHEN IT CAN SHOOT, so the player never has to
    // read the ammunition counter to know.
    if (gv(m, G.AMMO) > 0) {
      draw.rect(-6, -ph * 0.5 - 7, 12, 8, col(SHOT_RGB, 1));
      draw.rect(-pw * 0.5 + 6, -ph * 0.5 - 3, 10, 4, col(SHOT_RGB, 0.8));
      draw.rect(pw * 0.5 - 16, -ph * 0.5 - 3, 10, 4, col(SHOT_RGB, 0.8));
    }
    if (gv(m, G.CATCH_T) > 0) {
      draw.rect(-pw * 0.5, -ph * 0.5 - 4, pw, 3, col(0xb58cff, 0.9));
    }
    draw.pop();
  }

  // Drops.
  for (let i = 0; i < MAX_DROPS; i++) {
    const d = dropOff(i);
    const k = rv(m, d + D_KIND) | 0;
    if (!k) continue;
    const x = sx(lerp(rv(m, d + D_PX), rv(m, d + D_X), alpha));
    const y = sy(lerp(rv(m, d + D_PY), rv(m, d + D_Y), alpha));
    const w = DROP_W * SCALE;
    const hh = DROP_H * SCALE;
    const rgb = DROP_RGB[k - 1] as number;
    draw.push();
    draw.translate(x + w * 0.5, y + hh * 0.5);
    draw.rotate(sim.sin(tickN * 0.08 + i) * 0.35);
    draw.roundRect(-w * 0.5, -hh * 0.7, w, hh * 1.4, 8, col(rgb, 1));
    draw.roundRect(-w * 0.5 + 3, -hh * 0.7 + 3, w - 6, hh * 0.5, 5, col(0xffffff, 0.35));
    const letter = DROP_LETTER[k - 1] as string;
    draw.text(letter, -draw.measure(letter, 20) * 0.5, 7, 20, col(0x120f26, 1));
    draw.pop();
  }

  // Shots.
  for (let i = 0; i < MAX_SHOTS; i++) {
    const s = shotOff(i);
    if (!rv(m, s + S_LIVE)) continue;
    const x = sx(lerp(rv(m, s + S_PX), rv(m, s + S_X), alpha));
    const y = sy(lerp(rv(m, s + S_PY), rv(m, s + S_Y), alpha));
    draw.roundRect(x, y, SHOT_W * SCALE, SHOT_H * SCALE, 7, col(SHOT_RGB, 1));
  }

  // =========================================================================
  // Layer 3 -- particles. Debris first (solid), then sparks (additive), so a
  // spark always lands on top of the thing it came off.
  // =========================================================================
  draw.layer(3);
  draw.bloom(0.5 + bloomLift * 0.4, 0.4);
  for (let pass = 0; pass < 2; pass++) {
    draw.blend(pass === 0 ? 0 : 1);
    for (let i = 0; i < MAX_PARTICLES; i++) {
      const o = partOff(i);
      const life = rv(m, o + P_LIFE);
      if (life <= 0) continue;
      const kind = rv(m, o + P_KIND) | 0;
      if ((pass === 0 ? 1 : 0) !== kind) continue;
      const max = rv(m, o + P_MAX);
      const t = max > 0 ? life / max : 0;
      const x = sx(lerp(rv(m, o + P_PX), rv(m, o + P_X), alpha));
      const y = sy(lerp(rv(m, o + P_PY), rv(m, o + P_Y), alpha));
      const r = rv(m, o + P_SIZE) * SCALE * (kind === 0 ? 0.5 + t * 0.9 : 0.4 + t * 0.6);
      draw.circle(x, y, r, col(rv(m, o + P_COL) | 0, kind === 0 ? t * t : t));
    }
  }

  // =========================================================================
  // Layer 4 -- the light. The ball is LIT, not coloured: a wide additive halo
  // under a solid core, with a trail of fading discs behind it.
  // =========================================================================
  draw.layer(4);
  draw.bloom(0.95 + bloomLift * 0.8, 0.3);
  draw.blend(1);

  // NOT WHILE THE PADDLE IS COMING APART. `loseLife` serves the next ball on
  // the frame of the contact -- the bookkeeping does not get to wait -- so it
  // exists during the pause, and drawing it would put a lit ball in the air
  // above a paddle that is not there. It arrives with the paddle instead.
  const hideBall = dead > 0 || state !== 0;
  for (let i = 0; i < MAX_BALLS && !hideBall; i++) {
    const b = ballOff(i);
    const f = flags(m, b);
    if (!(f & 1)) continue;
    const red = (f & 2) !== 0;
    const rgb = red ? BALL_RED_RGB : BALL_GLOW_RGB;
    const cx = sx(lerp(rv(m, b + B_PX), rv(m, b + B_X), alpha)) + (BALL_SIZE * SCALE) / 2;
    const cy = sy(lerp(rv(m, b + B_PY), rv(m, b + B_Y), alpha)) + (BALL_SIZE * SCALE) / 2;

    // The trail: the ball's own recorded path, which is why it survives a
    // bounce instead of smearing through the wall.
    const head = gvTrailHead(m, b);
    for (let k = 0; k < TRAIL_N; k++) {
      const idx = (head - 1 - k + TRAIL_N * 2) % TRAIL_N;
      const t = 1 - k / TRAIL_N;
      const tx = sx(rv(m, b + B_TRAIL + idx * 16)) + (BALL_SIZE * SCALE) / 2;
      const ty = sy(rv(m, b + B_TRAIL + idx * 16 + 8)) + (BALL_SIZE * SCALE) / 2;
      draw.circle(tx, ty, 4 + t * 11, col(rgb, t * t * (red ? 0.34 : 0.2)));
    }

    const flare = red ? 1 + 0.35 * (fastPulse + 1) : 1;
    draw.circle(cx, cy, 46 * flare, col(rgb, red ? 0.2 : 0.1));
    draw.circle(cx, cy, 26 * flare, col(rgb, red ? 0.36 : 0.2));
    draw.circle(cx, cy, 14 * flare, col(rgb, 0.55));
  }

  // Shots, lit. They are the answer to a red ball once the gun exists, so they
  // read as energy rather than as a yellow rectangle.
  for (let i = 0; i < MAX_SHOTS; i++) {
    const o = shotOff(i);
    if (!rv(m, o + S_LIVE)) continue;
    const cx = sx(lerp(rv(m, o + S_PX), rv(m, o + S_X), alpha)) + (SHOT_W * SCALE) / 2;
    const cy = sy(lerp(rv(m, o + S_PY), rv(m, o + S_Y), alpha)) + (SHOT_H * SCALE) / 2;
    draw.circle(cx, cy, 26, col(SHOT_RGB, 0.12));
    draw.circle(cx, cy, 14, col(SHOT_RGB, 0.26));
    draw.rect(cx - 3, cy, 6, 40, col(SHOT_RGB, 0.14));
  }

  // The beam's glow. It exists only while a ball is RED -- the energy falls to
  // nothing in four frames when the red clears, which is the beam switching
  // off rather than a fade that could be mistaken for a warning.
  if (beam > 0.01) {
    const by = sy(BEAM_Y) + (BEAM_H * SCALE) / 2;
    draw.rect(FX, by - 26, FW, 52, col(BEAM_RGB, 0.14 * beam));
    draw.rect(FX, by - 12, FW, 24, col(BEAM_RGB, 0.26 * beam));
    // The segments alternate ALONG the row and step every few frames, so the
    // beam scrolls and reads as live rather than painted.
    const step = (tickN / 3) | 0;
    for (let k = 0; k < 32; k++) {
      if ((k + step) & 1) continue;
      draw.rect(FX + k * (FW / 32), by - 18, FW / 32 - 4, 36, col(0xffb0bd, 0.2 * beam));
    }
  }

  // =========================================================================
  // Layer 5 -- cores and rings.
  // =========================================================================
  draw.layer(5);
  draw.bloom(0.55 + bloomLift * 0.5, 0.45);
  draw.blend(0);
  if (beam > 0.01) {
    const by = sy(BEAM_Y);
    draw.roundRect(FX, by, FW, BEAM_H * SCALE, 6, col(BEAM_RGB, 0.55 + 0.45 * beam));
    draw.rect(FX, by + 5, FW, 4, col(0xffe3e7, 0.7 * beam));
  }
  for (let i = 0; i < MAX_BALLS && !hideBall; i++) {
    const b = ballOff(i);
    const f = flags(m, b);
    if (!(f & 1)) continue;
    const red = (f & 2) !== 0;
    const cx = sx(lerp(rv(m, b + B_PX), rv(m, b + B_X), alpha)) + (BALL_SIZE * SCALE) / 2;
    const cy = sy(lerp(rv(m, b + B_PY), rv(m, b + B_Y), alpha)) + (BALL_SIZE * SCALE) / 2;
    draw.circle(cx, cy, (BALL_SIZE * SCALE) / 2 + 2, col(red ? BALL_RED_RGB : BALL_RGB, 1));
    draw.circle(cx, cy, (BALL_SIZE * SCALE) / 2 - 3, col(0xffffff, red ? 0.85 : 1));
  }
  // NORMAL, not additive. A ring is drawn as a polyline and the renderer gives
  // every segment a round cap, so under additive blending each joint is painted
  // twice and the ring comes out as a string of bright beads. Layer 5 is
  // bloomed instead, which is where the glow was wanted from in the first
  // place -- a thing no unit test has an opinion about and one screenshot
  // settles.
  for (let i = 0; i < MAX_RINGS; i++) {
    const o = ringOff(i);
    const t = rv(m, o + R_T);
    if (t <= 0) continue;
    const max = rv(m, o + R_MAX);
    const k = max > 0 ? 1 - t / max : 1;
    const ease = 1 - (1 - k) * (1 - k);
    const r = (rv(m, o + R_R0) + (rv(m, o + R_R1) - rv(m, o + R_R0)) * ease) * SCALE;
    strokeRing(
      sim,
      draw,
      sx(rv(m, o + R_X)),
      sy(rv(m, o + R_Y)),
      r,
      rv(m, o + R_W) * SCALE * (1 - ease * 0.45),
      rv(m, o + R_COL) | 0,
      (1 - ease) * (1 - ease * 0.4),
    );
  }

  // =========================================================================
  // Layer 6 -- alarm and panels
  // =========================================================================
  draw.layer(6);
  if (alarm > 0.01) {
    // The whole screen tells the player, and all of it is geometry: four
    // additive edge washes and a red frame around the field. A runtime that
    // ignores every post stage still shows every bit of this.
    draw.blend(1);
    const a = alarm * (0.55 + 0.45 * fastPulse);
    draw.rect(0, 0, 1920, 120, col(BEAM_RGB, 0.24 * a));
    draw.rect(0, 960, 1920, 120, col(BEAM_RGB, 0.24 * a));
    draw.rect(0, 0, 150, 1080, col(BEAM_RGB, 0.2 * a));
    draw.rect(1770, 0, 150, 1080, col(BEAM_RGB, 0.2 * a));
    draw.blend(0);
    const fr = 6;
    draw.rect(FX - 6, FY - 6, FW + 12, fr, col(BEAM_RGB, alarm));
    draw.rect(FX - 6, FY + FW + 6 - fr, FW + 12, fr, col(BEAM_RGB, alarm));
    draw.rect(FX - 6, FY - 6, fr, FW + 12, col(BEAM_RGB, alarm));
    draw.rect(FX + FW + 6 - fr, FY - 6, fr, FW + 12, col(BEAM_RGB, alarm));
  }
  if (deflect > 0.01) {
    draw.blend(1);
    draw.rect(FX, sy(BEAM_Y) - 40, FW, 100, col(0xffd0d8, 0.3 * deflect));
    draw.blend(0);
  }
  if (clearT > 0.01) {
    draw.blend(1);
    draw.rect(FX, FY, FW, FW, col(0x9fd8ff, 0.22 * clearT));
    draw.blend(0);
  }

  // The serve prompt, and the two end panels.
  draw.blend(0);
  let stuck = false;
  for (let i = 0; i < MAX_BALLS; i++) {
    if ((flags(m, ballOff(i)) & 5) === 5) stuck = true;
  }
  if (stuck && state === 0 && dead <= 0) {
    const s = `PRESS  ${ui.label(BTN_A)}  TO SERVE`;
    const w = draw.measure(s, 30);
    const a = 0.45 + 0.35 * (pulse + 1) * 0.5;
    draw.text(s, sx(FIELD * 0.5) - w * 0.5, sy(PADDLE_Y) - 40, 30, col(INK_RGB, a));
  }
  if (state !== 0) {
    const ent = Math.min(1, gv(m, G.OVER_T) / 24);
    const won = state === 2;
    const title = won ? "RUN COMPLETE" : "GAME OVER";
    const line = won ? "ALL TEN LEVELS CLEARED" : `REACHED LEVEL ${level + 1} OF ${LEVEL_COUNT}`;
    const rgb = won ? 0x6fe3a0 : BEAM_RGB;
    // A scrim over the WHOLE field, not a band across the middle of it: a panel
    // laid over live geometry reads as a bug, and the field it covers is a
    // field nobody is playing any more.
    draw.rect(FX, FY, FW, FW, col(0x05040c, 0.82 * ent));
    const top = FY + FW * 0.5 - 160;
    draw.rect(FX, top, FW, 320, col(0x0a0818, 0.88 * ent));
    draw.rect(FX, top, FW, 5, col(rgb, ent));
    draw.rect(FX, top + 315, FW, 5, col(rgb, ent));
    const cx = sx(FIELD * 0.5);
    draw.text(title, cx - draw.measure(title, 92) * 0.5, top + 140, 92, col(rgb, ent));
    draw.text(line, cx - draw.measure(line, 30) * 0.5, top + 196, 30, col(INK_RGB, ent * 0.85));
    const p = `PRESS  ${ui.label(BTN_A)}`;
    draw.text(p, cx - draw.measure(p, 34) * 0.5, top + 266, 34,
      col(INK_RGB, ent * (0.5 + 0.4 * (pulse + 1) * 0.5)));
  }

  // =========================================================================
  // Layer 7 -- the HUD. Legible rather than decorative: one number per thing
  // the player has to know, and a count of the ones they can see coming.
  // =========================================================================
  draw.layer(7);
  draw.blend(0);

  const LX = 46;
  const RX = FX + FW + 46;
  const lives = gv(m, G.LIVES) | 0;
  const ammo = gv(m, G.AMMO) | 0;
  const lifeFlash = gv(m, G.LIFE_FLASH);
  const ammoFlash = gv(m, G.AMMO_FLASH);

  draw.text("RED BREAKER", LX, 92, 40, col(INK_RGB, 0.95));
  draw.text("SQUARE ONE PRIME", LX, 124, 20, col(DIM_RGB, 1));

  draw.text("LEVEL", LX, 212, 22, col(DIM_RGB, 1));
  const ln = `${level + 1}`;
  draw.text(ln, LX, 288, 76, col(INK_RGB, 1));
  draw.text(`/ ${LEVEL_COUNT}`, LX + draw.measure(ln, 76) + 14, 288, 28, col(DIM_RGB, 1));
  draw.text(h.name, LX, 328, 26, col(0x5fd8ff, 1));

  draw.text("LIVES", LX, 408, 22, col(DIM_RGB, 1));
  for (let i = 0; i < 8; i++) {
    const on = i < lives;
    if (!on && i >= Math.max(3, lives)) break;
    pip(draw, LX + i * 40, 428, 30, 12, col(PADDLE_RGB, on ? 0.55 + lifeFlash * 0.45 : 0.14));
  }
  if (lives > 8) draw.text(`x${lives}`, LX + 330, 440, 24, col(INK_RGB, 1));

  // The gun exists on a level only if the level gives one; a row of empty
  // slots on a level with no gun is a counter for a thing that cannot happen.
  if (h.sidePads || h.ammoStart > 0 || ammo > 0) {
    draw.text("AMMO", LX, 508, 22, col(DIM_RGB, 1));
    const shown = ammo > 10 ? 10 : ammo;
    for (let i = 0; i < 10; i++) {
      pip(draw, LX + i * 22, 524, 10, 26, col(SHOT_RGB, i < shown ? 0.6 + ammoFlash * 0.4 : 0.1));
    }
    if (ammo > 10) draw.text(`+${ammo - 10}`, LX + 236, 546, 22, col(SHOT_RGB, 1));
  }

  // Progress: how much of this level is left, which is the one number the
  // original HUD could not afford the characters for.
  const total = COUNTING_BLOCKS[level] ?? 1;
  let left = 0;
  for (let i = 0; i < CELLS; i++) {
    const t = rv(m, blockOff(i) + K_TYPE) | 0;
    if (t !== 0 && t !== 5) left++;
  }
  const frac = total > 0 ? 1 - left / total : 1;
  draw.text("CLEARED", LX, 618, 22, col(DIM_RGB, 1));
  draw.roundRect(LX, 634, 300, 14, 7, col(0x1a1631, 1));
  draw.roundRect(LX, 634, 300 * frac, 14, 7, col(0x5fd8ff, 1));
  draw.text(`${total - left} / ${total}`, LX, 682, 24, col(INK_RGB, 0.85));

  // The right panel: what this level is made of, and how to play it.
  draw.text("MECHANIC", RX, 212, 22, col(DIM_RGB, 1));
  draw.text(h.name, RX, 254, 34, col(INK_RGB, 1));

  draw.text("RED BLOCKS", RX, 334, 22, col(DIM_RGB, 1));
  const reds = RED_COUNT[level] ?? 0;
  for (let i = 0; i < reds; i++) {
    const dx2 = RX + 18 + i * 44;
    draw.tri(dx2, 350, dx2 + 15, 372, dx2 - 15, 372, col(BEAM_RGB, 1));
    draw.tri(dx2, 394, dx2 + 15, 372, dx2 - 15, 372, col(BEAM_RGB, 1));
  }
  if (reds > 0) {
    draw.text("RED BALL KILLS THE PADDLE", RX, 436, 20, col(BEAM_RGB, 0.9));
    draw.text("LET IT PASS. THE BEAM CATCHES IT.", RX, 462, 20, col(DIM_RGB, 1));
  } else {
    draw.text("NO RED BLOCKS ON THIS LEVEL", RX, 436, 20, col(DIM_RGB, 1));
  }

  // Every line asks. The panel used to state `< >`, `Z` and `X` as facts, which
  // were three guesses about a device this cart cannot see -- and `< >` is what
  // a player reads as the comma and full-stop keys rather than as a d-pad.
  //
  // PAUSE IS NOT LISTED, and its absence is the same rule from the other side:
  // pause belongs to the console, the ABI keeps its bit out of the input frame
  // precisely so a cart can neither observe nor suppress it, and a cart that
  // cannot read a control has no business naming its key either. The console
  // puts a real pause button on the glass.
  const keys = `${ui.label(BTN_LEFT)} ${ui.label(BTN_RIGHT)}`;
  draw.text("CONTROLS", RX, 560, 22, col(DIM_RGB, 1));
  draw.text(`${keys}   MOVE`, RX, 598, 24, col(INK_RGB, 0.9));
  draw.text(`${ui.label(BTN_A)}     SERVE`, RX, 630, 24, col(INK_RGB, 0.9));
  draw.text(`${ui.label(BTN_B)}     FIRE`, RX, 662, 24, col(INK_RGB, 0.9));

  const tk = `TICK ${sim.tick}`;
  draw.text(tk, 1920 - 46 - draw.measure(tk, 20), 1040, 20, col(DIM_RGB, 1));

  // =========================================================================
  // The post stage. `shake` takes the maximum over the frame, so one call with
  // the largest request is the whole of it -- and nothing above depends on it.
  // =========================================================================
  if (shakeAmt > 0.3) draw.shake(shakeAmt);
}

/**
 * The arena's layout, published so a test can assert on STATE rather than on
 * pixels.
 *
 * That is the whole point of moving the normative line: the small console's
 * suite compares framebuffers because the framebuffer is what it guarantees;
 * Prime's guarantee is the arena, so Prime's suite reads the arena. Publishing
 * the offsets costs nothing -- they are constants, not state -- and the
 * alternative is a test that infers the ball's position from a display list,
 * which would be a test of the renderer wearing a cart's name.
 */
export const ADDR = Object.freeze({
  G,
  BALLS_OFF,
  BALL_STRIDE,
  B_X,
  B_Y,
  B_PX,
  B_PY,
  B_VX,
  B_VY,
  B_FLAGS,
  B_REDT,
  B_TRAIL_HEAD,
  B_TRAIL,
  DROPS_OFF,
  DROP_STRIDE,
  D_X,
  D_Y,
  D_KIND,
  SHOTS_OFF,
  SHOT_STRIDE,
  S_X,
  S_Y,
  S_LIVE,
  BLOCKS_OFF,
  BLOCK_STRIDE,
  K_TYPE,
  K_HITS,
  K_FLASH,
  RINGS_OFF,
  RING_STRIDE,
  R_T,
  PARTS_OFF,
  PART_STRIDE,
  P_LIFE,
  ARENA_USED,
});

export {
  gv as peekGlobal,
  gs as pokeGlobal,
  rv as peek,
  rs as poke,
  ballOff,
  blockOff,
  dropOff,
  shotOff,
  flags as ballFlags,
  ballsAlive,
  cleared,
};

/**
 * The cart.
 *
 * A plain object with three methods and NO FIELDS. Anything stored here would
 * be state outside the arena, and a snapshot would not carry it -- which is the
 * rule this whole file is arranged around.
 */
export const breakoutCart: PrimeCart = { boot, tick, render };

export default breakoutCart;
