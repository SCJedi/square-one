/**
 * Red Breaker's ten levels, as data.
 *
 * =========================================================================
 * THIS IS THE CONTENT PACK, AND IT IS NOT THE ENGINE
 * =========================================================================
 * `modules/redlevels/gen.mjs` draws these ten grids for the small console and
 * packs them into a `MAP ` chunk and a `DATA` chunk. Prime's first cart has no
 * chunk loader yet, so the same grids and the same headers live here instead --
 * the same numbers, in the same order, with the same names.
 *
 * The split they express survives the port unchanged and is the reason this is
 * a separate file: `breakout.ts` holds MECHANICS and reads every level
 * parameter from here. It generates nothing. Swap this file and it is a
 * different game with the same rules, which is the whole point of the module
 * system the small console proved.
 *
 * =========================================================================
 * ASSETS ARE NOT IN THE ARENA
 * =========================================================================
 * Everything here is immutable and identical on every machine running this
 * cart, so by `spec/PRIME-ABI.md` it does not belong in `sim.mem`: a snapshot
 * copies the arena and nothing else, because immutable data does not need
 * saving, only being the same. `GRIDS` below is built once at module load and
 * never written again. The cart READS it and copies what it needs into the
 * arena at `loadLevel`, which is the one direction that is allowed.
 *
 * =========================================================================
 * A TILE BYTE IS A BLOCK TYPE
 * =========================================================================
 * 0 empty, 1 plain, 2 tough, 3 hard, 4 red, 5 solid, 6 shielded, 7 drifter,
 * 8 prize -- `modules/FORMATS-breakout.md`, which neither module owns. The
 * grids are written with `.` for 0 so an empty cell reads as empty, exactly as
 * they are written in `gen.mjs`, so the two can be diffed line for line.
 *
 * A level clears when NO BLOCK REMAINS EXCEPT TYPE 0 AND TYPE 5. Type 6 counts,
 * which is what makes the gun a correctness requirement on level eight rather
 * than a power-up.
 *
 * =========================================================================
 * WHERE THE RED BLOCKS SIT
 * =========================================================================
 * Two distances decide whether the red ball is a mechanic or a mugging, and
 * both are properties of these grids rather than of the engine:
 *
 *   HEIGHT is reaction time. A red block in row 1 is about 90 field units above
 *   the paddle; at level two's ball speed that is a little over a second. The
 *   same block in row 8 is a third of a second, which is under human reaction
 *   time for a choice.
 *
 *   AN OPEN FALL PATH is whether it happens at all. A red ball that touches
 *   anything but the paddle returns to normal, so a red block buried in a wall
 *   is nearly harmless -- the ball clips a neighbour on the way out and the red
 *   is gone before it matters.
 *
 * So every red block here has a face open to a large empty region and a clear
 * fall to the paddle row, and they descend the field level by level: row 2 on
 * level two, row 5 on level ten. Moving one is a change to the difficulty
 * curve, not a cosmetic edit.
 */

/** Blocks across one level, and the stride of the block grid. */
export const GRID_W = 16;

/** Rows of blocks in one level. */
export const GRID_H = 12;

/** Cells in one level's grid. */
export const CELLS = GRID_W * GRID_H;

/** Drop kinds, one bit each in `dropMask`. The order is the format's. */
export const DROP = {
  WIDE: 1,
  SLOW: 2,
  GUN: 4,
  MULTI: 8,
  LIFE: 16,
  CATCH: 32,
} as const;

/**
 * One level's header, field for field as `modules/FORMATS-breakout.md` lays it
 * out at `0x7800 + L * 16`. The names are the format's.
 */
export interface LevelHeader {
  /** Which mechanic this level introduces, 0..9. The engine tests `>=`. */
  readonly mechanic: number;
  /** Ball speed, in field units per frame. (`BALL_SPEED / 16` on the small machine.) */
  readonly ballSpeed: number;
  /** Paddle width, in field units. */
  readonly paddleW: number;
  /** Chance in 256 that a broken block drops something. */
  readonly dropRate: number;
  /** Which drop kinds this level may produce, one bit each. */
  readonly dropMask: number;
  /** Balls in play at serve. */
  readonly ballCount: number;
  /** Sideways speed of drifter rows, in field units per frame. 0 for none. */
  readonly driftSpeed: number;
  /** 1 if the side charge pads exist on this level. */
  readonly sidePads: number;
  /** Shots the player begins the level holding. */
  readonly ammoStart: number;
  /** Twelve strings of sixteen characters, top row first. `.` is empty. */
  readonly grid: readonly string[];
  /** A name for the HUD. Presentation only; the engine never reads it. */
  readonly name: string;
}

/**
 * The ten levels.
 *
 * `ballSpeed` and `driftSpeed` are in FIELD UNITS PER FRAME here, where the
 * small console's header stores sixteenths of a pixel. The number is the same
 * quantity divided by 16 and the division is done once, here, rather than in
 * every expression that reads it -- Prime simulates in floats, so the
 * sixteenths were only ever a way of spelling a fraction on a machine without
 * them. Every value below is an exact binary fraction, so no rounding is
 * introduced by the change of unit.
 */
export const LEVELS: readonly LevelHeader[] = [
  // ==========================================================================
  // 1 -- PLAIN. Learn the paddle and the ball, and nothing else.
  //
  // Four rows, twelve wide, no gaps and no surprises: 48 blocks that all behave
  // the same way. The paddle is the widest it will ever be and the ball the
  // slowest, and there is no red block anywhere -- the only level of the ten
  // where that is true, because a player who has not yet learned to RETURN the
  // ball cannot be asked to learn to dodge it.
  // ==========================================================================
  {
    mechanic: 0,
    ballSpeed: 22 / 16,
    paddleW: 32,
    dropRate: 0,
    dropMask: 0,
    ballCount: 1,
    driftSpeed: 0,
    sidePads: 0,
    ammoStart: 0,
    name: "PLAIN",
    grid: [
      "................",
      "................",
      "..111111111111..",
      "..111111111111..",
      "..111111111111..",
      "..111111111111..",
      "................",
      "................",
      "................",
      "................",
      "................",
      "................",
    ],
  },

  // ==========================================================================
  // 2 -- RED BLOCKS. One of them, and the whole level is built around it.
  //
  // The red block is the LEFT SHOULDER of the wall: row 2, column 2, with its
  // left face open to a channel that runs the full height of the screen and
  // nothing above it. The ball can only take it from the left or from above, so
  // it leaves moving LEFT AND DOWN into the empty channel and the red survives
  // to mean something. It is 88 units above the paddle -- about 1.05 seconds at
  // this level's ball speed -- and it falls at x = 8..24, where the paddle is
  // not, so the first red ball a player ever sees is one they survive by doing
  // nothing. THEN they understand what the beam is for.
  // ==========================================================================
  {
    mechanic: 1,
    ballSpeed: 24 / 16,
    paddleW: 30,
    dropRate: 0,
    dropMask: 0,
    ballCount: 1,
    driftSpeed: 0,
    sidePads: 0,
    ammoStart: 0,
    name: "RED BLOCKS",
    grid: [
      "................",
      "...1111111111...",
      "..411111111111..",
      "..111111111111..",
      "..111111111111..",
      "...1111111111...",
      "................",
      "................",
      "................",
      "................",
      "................",
      "................",
    ],
  },

  // ==========================================================================
  // 3 -- DROPS. Enough breakables that they actually appear, and a life among
  // them. 70 blocks at DROP_RATE 90/256 is about 24 drops, plus four PRIZE
  // blocks that drop whatever happens -- one in each quarter of the wall.
  // The mask is wide, slow, LIFE and catch: four kinds, all of them plainly
  // good, because the first level with things falling out of the ceiling should
  // not also be the level where catching one can hurt.
  //
  // The red block moves to the RIGHT shoulder, so the lesson is not learned as
  // "the danger is on the left".
  // ==========================================================================
  {
    mechanic: 2,
    ballSpeed: 26 / 16,
    paddleW: 30,
    dropRate: 90,
    dropMask: DROP.WIDE | DROP.SLOW | DROP.LIFE | DROP.CATCH,
    ballCount: 1,
    driftSpeed: 0,
    sidePads: 0,
    ammoStart: 0,
    name: "DROPS",
    grid: [
      "................",
      "..111111111114..",
      "..118111181111..",
      "..111111111111..",
      "..811111111118..",
      "..111111111111..",
      "...1111111111...",
      "................",
      "................",
      "................",
      "................",
      "................",
    ],
  },

  // ==========================================================================
  // 4 -- TOUGH BLOCKS. A wall that does not fall down as fast as you hit it.
  //
  // Ten HARD blocks (three hits) cased in TOUGH ones (two), over a course of
  // plain blocks that still goes in one. 85 hits for 33 blocks: the rhythm
  // changes from "clear a wall" to "wear one down".
  //
  // The red block is the left END of the tough course, not inside it -- an end
  // block has an open face, and a red block without one never fires.
  // ==========================================================================
  {
    mechanic: 3,
    ballSpeed: 28 / 16,
    paddleW: 28,
    dropRate: 72,
    dropMask: DROP.WIDE | DROP.SLOW | DROP.LIFE | DROP.CATCH,
    ballCount: 1,
    driftSpeed: 0,
    sidePads: 0,
    ammoStart: 0,
    name: "TOUGH BLOCKS",
    grid: [
      "................",
      "................",
      "................",
      "...4222222222...",
      "..233333333332..",
      "...2222222222...",
      "..111111111111..",
      "................",
      "................",
      "................",
      "................",
      "................",
    ],
  },

  // ==========================================================================
  // 5 -- SIDE PADS. Two towers, a valley between them, and a reason to go to
  // the wall.
  //
  // AMMO_START is 0 and SIDE_PADS is 1: every shot here is one the player went
  // and got. The pads sit in the outer eight units, which is exactly under the
  // towers' feet -- and those feet are four PRIZE blocks. "Touch the wall, then
  // fire straight up" is worth a guaranteed drop, and that is the whole
  // tutorial, built out of geometry rather than text.
  //
  // The two red blocks hang in the outer channels at row 3, eight units from
  // the wall -- which is where the paddle has to be to charge a shot. Going for
  // ammunition costs you the position you want when a red block breaks, and
  // that trade is the level.
  // ==========================================================================
  {
    mechanic: 4,
    ballSpeed: 30 / 16,
    paddleW: 28,
    dropRate: 64,
    dropMask: DROP.WIDE | DROP.SLOW | DROP.GUN | DROP.LIFE,
    ballCount: 1,
    driftSpeed: 0,
    sidePads: 1,
    ammoStart: 0,
    name: "SIDE PADS",
    grid: [
      "................",
      "..3333....3333..",
      "..2222....2222..",
      ".42222....22224.",
      "..1111....1111..",
      "..1111....1111..",
      "..8811....1188..",
      "................",
      "................",
      "................",
      "................",
      "................",
    ],
  },

  // ==========================================================================
  // 6 -- DRIFTING ROWS. A gap that opens and closes, with something behind it.
  //
  // Two drifter rows slide together on one shared offset. Row 2's gap is four
  // columns wide in the middle; row 4's is two columns wide in each of two
  // places. BETWEEN THEM, IN THE EMPTY ROW 3, SIT THE TWO RED BLOCKS --
  // directly above row 4's two gaps at their home position. So the ball reaches
  // them only while the gap is where they are, and it leaves the same way. Aim
  // at a red block on the wrong beat and the ball comes back off a drifter
  // instead: the mechanic and the red-block placement are the same decision.
  //
  // Both drifter rows run from column 2 to column 13, so at full drift they
  // reach columns 1 and 14 and never leave the field.
  // ==========================================================================
  {
    mechanic: 5,
    ballSpeed: 32 / 16,
    paddleW: 26,
    dropRate: 64,
    dropMask: DROP.WIDE | DROP.SLOW | DROP.GUN | DROP.CATCH,
    ballCount: 1,
    driftSpeed: 6 / 16,
    sidePads: 1,
    ammoStart: 0,
    name: "DRIFTING ROWS",
    grid: [
      "................",
      "..111111111111..",
      "..7777....7777..",
      ".....4....4.....",
      "..77..7777..77..",
      "..111111111111..",
      "....18111181....",
      "................",
      "................",
      "................",
      "................",
      "................",
    ],
  },

  // ==========================================================================
  // 7 -- MULTIBALL. Two balls, and a field with two of everything.
  //
  // BALL_COUNT is 2 and the layout is symmetrical about a chimney. One ball
  // cannot work both towers at once and two balls can, which is the reward the
  // header is asking for.
  //
  // Three red blocks. Two hang in the outer channels at row 5 -- low, but at
  // the extreme edges. The third is at the TOP OF THE CHIMNEY: the ball threads
  // four rows of empty column, takes it from below, and falls back down the
  // same shaft into the middle of the screen. It is 95 units up, which is the
  // trade -- the one that lands where you are standing gives you the most time
  // to move.
  // ==========================================================================
  {
    mechanic: 6,
    ballSpeed: 34 / 16,
    paddleW: 26,
    dropRate: 60,
    dropMask: DROP.WIDE | DROP.SLOW | DROP.MULTI | DROP.LIFE,
    ballCount: 2,
    driftSpeed: 6 / 16,
    sidePads: 1,
    ammoStart: 0,
    name: "MULTIBALL",
    grid: [
      "..1111.4..1111..",
      "..1881....1881..",
      "..1111....1111..",
      "..2222....2222..",
      "..7777....7777..",
      ".4...222222...4.",
      "................",
      "................",
      "................",
      "................",
      "................",
      "................",
    ],
  },

  // ==========================================================================
  // 8 -- SHIELDED BLOCKS. The level you cannot finish with the ball alone.
  //
  // Twelve type-6 blocks in an unbroken course at row 3. A ball bounces off
  // every one of them; only a shot breaks one; and a level is not clear while
  // one stands. So this level is UNCOMPLETABLE without the gun, which is the
  // point of it -- and that is guaranteed three separate ways: AMMO_START 16
  // against 12 shielded blocks, SIDE_PADS to recharge without limit, and `gun`
  // in the drop mask. A softlock is not the kind of bug you leave one guard
  // against.
  //
  // The shielded course is a ROOF, not a barrier: the channels at columns 0..1
  // and 14..15 are open the whole height, so the ball reaches the loot above it
  // by going round. The player clears the level with the ball and then has to
  // come back and shoot the roof out, which is the order that teaches what the
  // gun is for.
  // ==========================================================================
  {
    mechanic: 7,
    ballSpeed: 36 / 16,
    paddleW: 24,
    dropRate: 80,
    dropMask: DROP.WIDE | DROP.SLOW | DROP.GUN | DROP.MULTI | DROP.LIFE | DROP.CATCH,
    ballCount: 1,
    driftSpeed: 0,
    sidePads: 1,
    ammoStart: 16,
    name: "SHIELDED",
    grid: [
      "..111111111111..",
      "..118111181111..",
      "..222222222222..",
      "..666666666666..",
      "................",
      ".4..4.........4.",
      "................",
      "................",
      "................",
      "................",
      "................",
      "................",
    ],
  },

  // ==========================================================================
  // 9 -- SOLID BLOCKS. Two walls, three lanes, and a ball that can only be in
  // one of them.
  //
  // The type-5 columns at 4 and 11 run from row 0 to row 5 and never break, so
  // the top of the field is three separate rooms. A ball works one lane at a
  // time and has to be brought back down and sent up another; the whole level
  // is about choosing which room to be in.
  //
  // Four red blocks now, one per lane and one spare, all in the open at row 5.
  // Two of them are near the middle, which is new: this is the level where the
  // dodge stops being free.
  // ==========================================================================
  {
    mechanic: 8,
    ballSpeed: 39 / 16,
    paddleW: 22,
    dropRate: 60,
    dropMask: DROP.WIDE | DROP.SLOW | DROP.GUN | DROP.MULTI | DROP.CATCH,
    ballCount: 1,
    driftSpeed: 0,
    sidePads: 1,
    ammoStart: 8,
    name: "SOLID WALLS",
    grid: [
      "1111511111151111",
      "2222522222252222",
      "1111511111151111",
      "..6.5..66..5.6..",
      "....5......5....",
      ".4..5.4..4.5..4.",
      "................",
      "................",
      "................",
      "................",
      "................",
      "................",
    ],
  },

  // ==========================================================================
  // 10 -- EVERYTHING. All eight block types on one screen, and four red blocks.
  //
  // Read top to bottom it is the whole game in six rows: a hard cap, a tough
  // course flanked by two red blocks in the open channels, prize blocks in the
  // plain course, a row that alternates shielded and solid so half of it must
  // be shot and the other half never falls at all, a full drifter row sliding
  // under all of it, and two more red blocks below everything with nothing in
  // their way.
  //
  // The hardest header in the pack on every axis. The two red blocks at row 5
  // are 65 units up -- about four tenths of a second -- and that is deliberately
  // at the edge of what is fair, which is where a tenth level belongs.
  // ==========================================================================
  {
    mechanic: 9,
    ballSpeed: 44 / 16,
    paddleW: 20,
    dropRate: 70,
    dropMask: DROP.WIDE | DROP.SLOW | DROP.GUN | DROP.MULTI | DROP.LIFE | DROP.CATCH,
    ballCount: 2,
    driftSpeed: 9 / 16,
    sidePads: 1,
    ammoStart: 12,
    name: "EVERYTHING",
    grid: [
      "....33333333....",
      ".42222222222224.",
      "..118111118111..",
      "..665566556655..",
      "..777777777777..",
      "....4......4....",
      "................",
      "................",
      "................",
      "................",
      "................",
      "................",
    ],
  },
];

/** How many levels the pack holds. Clearing the last one wins the run. */
export const LEVEL_COUNT = LEVELS.length;

/**
 * Every level's grid, decoded once, as `LEVEL_COUNT` arrays of `CELLS` bytes.
 *
 * Built at module load and never written again -- see the note at the top of
 * this file about assets not living in the arena. `loadLevel` copies the row it
 * needs into `sim.mem`, which is the one direction the ABI allows.
 */
export const GRIDS: readonly Uint8Array[] = LEVELS.map((lv) => {
  const out = new Uint8Array(CELLS);
  for (let r = 0; r < GRID_H; r++) {
    const row = lv.grid[r] as string;
    for (let c = 0; c < GRID_W; c++) {
      const ch = row.charAt(c);
      out[r * GRID_W + c] = ch === "." ? 0 : ch.charCodeAt(0) - 48;
    }
  }
  return out;
});

/**
 * How many type-4 blocks a level's grid holds -- the format's `RED_COUNT`.
 *
 * DERIVED rather than written down, on the principle `gen.mjs` states: a number
 * that can be counted from the art should be counted from the art, so the two
 * cannot disagree. Nothing in the simulation reads it; the HUD does.
 */
export const RED_COUNT: readonly number[] = GRIDS.map((g) => {
  let n = 0;
  for (let i = 0; i < g.length; i++) if (g[i] === 4) n++;
  return n;
});

/**
 * How many blocks of a level COUNT toward the clear: everything except empty
 * and type 5. Type 6 is in here, and that is the rule that makes the gun a
 * correctness requirement on level eight.
 */
export const COUNTING_BLOCKS: readonly number[] = GRIDS.map((g) => {
  let n = 0;
  for (let i = 0; i < g.length; i++) {
    const t = g[i] as number;
    if (t !== 0 && t !== 5) n++;
  }
  return n;
});
