// `redlevels` -- the ten levels of Red Breaker, drawn here and packed into
// levels.map and levels.dat.
//
//     node modules/redlevels/gen.mjs
//
// Run it from the repository root. It rewrites both files, checks every level
// against the rules below, and prints a table. Regenerating must produce
// identical bytes on any machine -- there is no clock, no randomness and no
// floating point in this file.
//
// THE LEVELS ARE SOURCE AND THE .map / .dat ARE OUTPUT. A .bin cannot be
// reviewed; a level whose art is twelve strings of sixteen characters can be
// read, argued with and diffed one block at a time. Never hand-edit either
// output file: an edit made there and not here is lost the next time anyone
// regenerates.
//
// THE TWO FILE FORMATS, both fixed by modules/FORMATS-breakout.md
// ---------------------------------------------------------------
//   levels.map  the `MAP ` chunk, installed at 0x4300. The map is 128 tiles
//               wide; level L is the 16 x 12 block at column (L % 8) * 16, row
//               (L / 8) * 12. Ten levels reach map row 23, so this file is 24
//               rows of 128 bytes = 3072 of the region's 8192. The rest of the
//               map stays as boot left it.
//   levels.dat  the `DATA` chunk, installed at 0x7800. Ten 16-byte headers,
//               level L at offset L * 16. Bytes 10..15 are reserved and zero.
//
// A TILE BYTE IS A BLOCK TYPE. 0 empty, 1 plain, 2 tough, 3 hard, 4 red, 5
// solid, 6 shielded, 7 drifter, 8 prize. The grids below are written with `.`
// for 0 so an empty cell reads as empty.
//
// WHAT MAKES A LEVEL COMPLETABLE, which is the rule every grid here is checked
// against by `verify()` at the bottom
// ---------------------------------------------------------------------------
// The engine clears a level when NO BLOCK REMAINS EXCEPT TYPE 0 AND TYPE 5.
// Three things follow, and all three are enforced below rather than trusted:
//
//   1. TYPE 6 COUNTS. A shielded block a ball cannot break and a shot cannot
//      reach is a softlock, not decoration. Every level holding a type 6 sets
//      AMMO_START above its shielded count AND sets SIDE_PADS, so the player
//      begins with enough shots and can charge more without limit.
//   2. TYPE 5 IS THE ONLY DECORATION. It never counts, so a wall that is meant
//      to shape the field rather than be cleared is always a 5.
//   3. RED_COUNT IS THE GRID'S OWN COUNT of type-4 blocks. Two numbers that
//      must agree, so one is derived from the other and the header's is
//      checked against it.
//
// WHERE THE RED BLOCKS SIT, AND WHY IT IS THE MOST DELIBERATE THING HERE
// ----------------------------------------------------------------------
// Breaking a type-4 block turns the ball RED, and a red ball that touches the
// PADDLE costs a life -- so for one contact the player has to do the opposite
// of everything else the game has taught them and get the paddle OUT OF THE
// WAY. The beam under the paddle catches the ball if they do. What decides
// whether that is a mechanic or a mugging is two distances:
//
//   HEIGHT is reaction time. A red block in row 1 is about 90 pixels above the
//   paddle; at level two's ball speed that is a little over a second. The same
//   block in row 8 is a third of a second, which is under human reaction time
//   for a choice, and would be a coin flip rather than a decision.
//
//   AN OPEN FALL PATH is whether it happens at all. Rule 4 of the format says a
//   red ball that touches ANYTHING but the paddle returns to normal -- so a red
//   block buried in a wall is nearly harmless, because the ball clips a
//   neighbour on the way out and the red is gone before it matters. A red block
//   with air below it is the one the player has to answer.
//
// So every red block in this pack has at least one face open to a large empty
// region and a clear fall to the paddle row, and they descend the field level
// by level: row 2 on level two, row 5 on level ten. The horizontal placement
// moves outward as well -- the early ones are at the edges, where the paddle
// usually is not, and only levels eight, nine and ten put one near the middle.

import { writeFileSync } from "node:fs";

/** Drop kinds, one bit each in DROP_MASK. The order is the format's. */
const WIDE = 1;
const SLOW = 2;
const GUN = 4;
const MULTI = 8;
const LIFE = 16;
const CATCH = 32;

/**
 * The ten levels.
 *
 * `grid` is twelve strings of sixteen characters, one per block row, top row
 * first. Everything else is the header, and the names are the format's.
 *
 * RED_COUNT is not written here: it is counted from the grid and checked, on
 * the principle that a number derivable from the art should be derived from it.
 */
const LEVELS = [
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
    ballSpeed: 22,
    paddleW: 32,
    dropRate: 0,
    dropMask: 0,
    ballCount: 1,
    driftSpeed: 0,
    sidePads: 0,
    ammoStart: 0,
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
  // nothing above it. Three things follow, and they are the reason it is here
  // rather than anywhere else.
  //
  //   The ball can only take it from the left or from above, so it leaves
  //   moving LEFT AND DOWN, into the empty channel -- it does not clip a
  //   neighbour, and the red survives to mean something.
  //   It is 88 pixels above the paddle: about 1.05 seconds at this level's ball
  //   speed, which is time to think rather than time to twitch.
  //   It falls at x = 8..24, and the paddle spends this level near the middle
  //   returning a wall of plain blocks. The player is already 40 pixels away
  //   when it happens, so the first red ball they ever see is one they survive
  //   by doing nothing -- and THEN they understand what the beam is for.
  //
  // The wall is a stepped trapezoid so the shoulder is exposed early rather
  // than being the last block standing. A lesson delivered once, at the end, is
  // not a lesson.
  // ==========================================================================
  {
    mechanic: 1,
    ballSpeed: 24,
    paddleW: 30,
    dropRate: 0,
    dropMask: 0,
    ballCount: 1,
    driftSpeed: 0,
    sidePads: 0,
    ammoStart: 0,
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
  // them.
  //
  // 70 blocks at DROP_RATE 90/256 is about 24 drops, plus four PRIZE blocks
  // that drop whatever happens -- one in each quarter of the wall, so wherever
  // the player is working they meet one early. DROP_MASK is wide, slow, LIFE
  // and catch: four kinds, all of them plainly good, because the first level
  // with things falling out of the ceiling should not also be the level where
  // catching one can hurt.
  //
  // The red block moves to the RIGHT shoulder this time, so the lesson is not
  // learned as "the danger is on the left".
  // ==========================================================================
  {
    mechanic: 2,
    ballSpeed: 26,
    paddleW: 30,
    dropRate: 90,
    dropMask: WIDE | SLOW | LIFE | CATCH,
    ballCount: 1,
    driftSpeed: 0,
    sidePads: 0,
    ammoStart: 0,
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
  // changes from "clear a wall" to "wear one down", and the plain course at the
  // bottom is there so the level still opens the way the last three did.
  //
  // The red block is the left END of the tough course, not inside it -- an end
  // block has an open face, and a red block without one is a red block that
  // never fires.
  // ==========================================================================
  {
    mechanic: 3,
    ballSpeed: 28,
    paddleW: 28,
    dropRate: 72,
    dropMask: WIDE | SLOW | LIFE | CATCH,
    ballCount: 1,
    driftSpeed: 0,
    sidePads: 0,
    ammoStart: 0,
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
  // AMMO_START is 0 and SIDE_PADS is 1: every shot on this level is one the
  // player went and got. The pads sit in the outer eight pixels, which is
  // exactly under the towers' feet -- and the towers' feet are four PRIZE
  // blocks. A shot rises and breaks the LOWEST block in its column, so
  // "touch the wall, then fire straight up" is worth a guaranteed drop. That is
  // the whole tutorial, and it is built out of geometry rather than text.
  //
  // The two red blocks hang in the outer channels at row 3, one on each side,
  // where the ball rises to reach them and falls straight back down the same
  // shaft. They are 8 pixels from the wall -- which is where the paddle has to
  // be to charge a shot. Going for ammunition costs you the position you would
  // want when a red block breaks, and that trade is the level.
  // ==========================================================================
  {
    mechanic: 4,
    ballSpeed: 30,
    paddleW: 28,
    dropRate: 64,
    dropMask: WIDE | SLOW | GUN | LIFE,
    ballCount: 1,
    driftSpeed: 0,
    sidePads: 1,
    ammoStart: 0,
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
  // Two drifter rows slide together on one shared offset, out to `drift_range`
  // and back. Row 2's gap is four columns wide in the middle; row 4's is two
  // columns wide in each of two places. BETWEEN THEM, IN THE EMPTY ROW 3, SIT
  // THE TWO RED BLOCKS -- directly above row 4's two gaps at their home
  // position.
  //
  // So the ball reaches them only while the gap is where they are, and it
  // leaves the same way. The drift is a full block wide, which means the window
  // genuinely closes: aim at a red block on the wrong beat and the ball comes
  // back off a drifter instead. That is the mechanic and the level's red-block
  // placement being the same decision, which is what a level ought to be.
  //
  // Both drifter rows run from column 2 to column 13, so at full drift they
  // reach columns 1 and 14 and never leave the screen. A block that drifts past
  // the edge cannot be hit and cannot be cleared; the margin here is what stops
  // that being possible.
  // ==========================================================================
  {
    mechanic: 5,
    ballSpeed: 32,
    paddleW: 26,
    dropRate: 64,
    dropMask: WIDE | SLOW | GUN | CATCH,
    ballCount: 1,
    driftSpeed: 6,
    sidePads: 1,
    ammoStart: 0,
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
  // BALL_COUNT is 2 and the layout is symmetrical about a chimney: two towers,
  // each with its own prize blocks and its own tough course, and nothing in the
  // middle. One ball cannot work both towers at once and two balls can, which
  // is the reward the header is asking for.
  //
  // Three red blocks. Two hang in the outer channels at row 5 -- low, but at
  // the extreme edges. The third is at the TOP OF THE CHIMNEY: the ball threads
  // four rows of empty column, takes it from below, and falls back down the
  // same shaft into the middle of the screen. It is the most dangerous red
  // block in the pack so far and it is 95 pixels up, which is the trade -- the
  // one that lands where you are standing is the one that gives you the most
  // time to move.
  // ==========================================================================
  {
    mechanic: 6,
    ballSpeed: 34,
    paddleW: 26,
    dropRate: 60,
    dropMask: WIDE | SLOW | MULTI | LIFE,
    ballCount: 2,
    driftSpeed: 6,
    sidePads: 1,
    ammoStart: 0,
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
  // every one of them; only a shot breaks one; and the engine does not call a
  // level clear while one stands. So this level is UNCOMPLETABLE without the
  // gun, which is the point of it.
  //
  // WHICH MAKES THE GUN A CORRECTNESS REQUIREMENT AND NOT A POWER-UP, and it is
  // guaranteed three separate ways:
  //   AMMO_START is 16 against 12 shielded blocks -- enough on its own, before
  //   anything else happens.
  //   SIDE_PADS is 1, so a player who wastes every shot can charge more by
  //   touching a wall, without limit and without luck.
  //   DROP_MASK is all six kinds, so `gun` drops as well.
  // Any one of the three would do. A softlock is not the kind of bug you leave
  // one guard against.
  //
  // The shielded course is a ROOF, not a barrier: the channels at columns 0..1
  // and 14..15 are open the whole height, so the ball reaches the loot above it
  // by going round. The player therefore clears the level with the ball and
  // then has to come back and shoot the roof out, which is exactly the order
  // that teaches what the gun is for.
  // ==========================================================================
  {
    mechanic: 7,
    ballSpeed: 36,
    paddleW: 24,
    dropRate: 80,
    dropMask: WIDE | SLOW | GUN | MULTI | LIFE | CATCH,
    ballCount: 1,
    driftSpeed: 0,
    sidePads: 1,
    ammoStart: 16,
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
  // Every breakable is reachable from below inside its own lane -- there is no
  // block behind a solid wall, and `verify()` checks that no column is roofed
  // by one. The four shielded blocks sit at row 3 with nothing under them, so a
  // shot from directly below takes each one; AMMO_START is 8 against four of
  // them, with the pads and `gun` drops behind that.
  //
  // Four red blocks now, one per lane and one spare, all in the open at row 5.
  // Two of them are near the middle, which is new: this is the level where the
  // dodge stops being free.
  // ==========================================================================
  {
    mechanic: 8,
    ballSpeed: 39,
    paddleW: 22,
    dropRate: 60,
    dropMask: WIDE | SLOW | GUN | MULTI | CATCH,
    ballCount: 1,
    driftSpeed: 0,
    sidePads: 1,
    ammoStart: 8,
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
  // The hardest header in the pack on every axis: the ball at 2.75 pixels a
  // frame, a 20-pixel paddle, two balls at serve and the drifters at their
  // fastest. The two red blocks at row 5 are 65 pixels up -- about four tenths
  // of a second -- and that is deliberately at the edge of what is fair, which
  // is where a tenth level belongs. The two at row 1 are 89 pixels up and at
  // the screen edges, so the level opens with the version of the mechanic the
  // player has been surviving since level two and closes with the version it
  // has been building towards.
  //
  // Six shielded blocks against AMMO_START 12, SIDE_PADS and `gun` in the mask.
  // The drifter row sits under the shielded one, so those six cannot be shot
  // until the drifters are cleared -- an order of operations, not a lock.
  // ==========================================================================
  {
    mechanic: 9,
    ballSpeed: 44,
    paddleW: 20,
    dropRate: 70,
    dropMask: WIDE | SLOW | GUN | MULTI | LIFE | CATCH,
    ballCount: 2,
    driftSpeed: 9,
    sidePads: 1,
    ammoStart: 12,
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

// ============================================================================
// The checks
//
// Every rule the header of this file states is enforced here, because a rule
// stated in a comment is a rule that stops being true. `node gen.mjs` fails
// loudly rather than writing a pack that softlocks on level eight.
//
// The numbers the checks are written against are `breakout@1.0.0`'s knob
// DEFAULTS, and they are repeated here rather than read, because this module
// does not depend on that one. If a recipe overrides `field_top`, `block_h`,
// `paddle_y` or `mech_*`, the reaction-time table below stops being true and
// these are the numbers to change with it.
// ============================================================================

/** The field geometry `examples/red-breaker/recipe.toml` leaves at default. */
const GRID_W = 16;
const GRID_H = 12;
const BLOCK_H = 6;
const FIELD_TOP = 10;
const PADDLE_Y = 110;
/** drift_range: how far a drifting row slides each way, in pixels. */
const DRIFT_RANGE = 8;
/** The MECHANIC value each mechanic switches on at. */
const MECH_DROPS = 2;
const MECH_PADS = 4;
const MECH_DRIFT = 5;
const MECH_MULTI = 6;
const MECH_SHIELD = 7;

const problems = [];
function need(ok, level, why) {
  if (!ok) problems.push(`level ${level + 1}: ${why}`);
}

/** Every cell of a grid as {r, c, t}, skipping empties. */
function cells(grid) {
  const out = [];
  for (let r = 0; r < GRID_H; r++) {
    for (let c = 0; c < GRID_W; c++) {
      const ch = grid[r][c];
      const t = ch === "." ? 0 : Number(ch);
      if (t) out.push({ r, c, t });
    }
  }
  return out;
}

/**
 * Can the ball get to every block that has to be broken?
 *
 * A flood fill from below, with TYPE 5 AS THE ONLY WALL. Every other cell is
 * passable, because every other cell eventually becomes empty -- a plain block
 * in the way is a delay and a solid block in the way is forever. Any counting
 * block the flood does not reach is a softlock, and this is the check that
 * would have caught one.
 */
function unreachable(grid) {
  const seen = new Set();
  const queue = [];
  // The open field below the blocks is where the ball comes from. Row GRID_H is
  // virtual: the play area between the lowest block row and the paddle.
  for (let c = 0; c < GRID_W; c++) queue.push([GRID_H, c]);
  while (queue.length) {
    const [r, c] = queue.pop();
    if (r < 0 || r > GRID_H || c < 0 || c >= GRID_W) continue;
    const key = r * GRID_W + c;
    if (seen.has(key)) continue;
    if (r < GRID_H && grid[r][c] === "5") continue;
    seen.add(key);
    queue.push([r - 1, c], [r + 1, c], [r, c - 1], [r, c + 1]);
  }
  return cells(grid).filter((x) => x.t !== 5 && !seen.has(x.r * GRID_W + x.c));
}

/** Pixels a red block at row `r` gives the player, and frames at `speed`. */
function reaction(r, speed) {
  const fall = PADDLE_Y - (FIELD_TOP + r * BLOCK_H + BLOCK_H);
  // min_angle 0.35 caps the vertical share of the ball's speed at about 0.94.
  const frames = Math.round((fall * 16) / (speed * 0.94));
  return { fall, frames };
}

const report = [];
let previousReds = -1;
let previousSpeed = 0;
let previousWidth = 999;

for (let L = 0; L < LEVELS.length; L++) {
  const lv = LEVELS[L];
  const g = lv.grid;

  need(g.length === GRID_H, L, `grid has ${g.length} rows, expected ${GRID_H}`);
  for (let r = 0; r < g.length; r++) {
    need(g[r].length === GRID_W, L, `row ${r} is ${g[r].length} characters, expected ${GRID_W}`);
    need(/^[.1-8]+$/.test(g[r]), L, `row ${r} has a character that is not a block type: "${g[r]}"`);
  }

  const all = cells(g);
  const count = (t) => all.filter((x) => x.t === t).length;
  const reds = count(4);
  const shielded = count(6);
  const drifters = count(7);
  const counting = all.filter((x) => x.t !== 5).length;

  // The curriculum. MECHANIC is the level's index, by the format's own table.
  need(lv.mechanic === L, L, `MECHANIC is ${lv.mechanic}, and the format's table says ${L}`);

  // A level with nothing to break clears on frame one.
  need(counting > 0, L, "holds no block that counts toward the clear");

  // RED_COUNT is the grid's own count, and it may only ever climb.
  need(reds <= 4, L, `has ${reds} red blocks, and the format allows at most 4`);
  need(reds >= previousReds, L, `has ${reds} red blocks after a level with ${previousReds}`);
  previousReds = reds;

  // Difficulty rises on both axes independently of the mechanics.
  need(lv.ballSpeed > previousSpeed, L, `BALL_SPEED ${lv.ballSpeed} does not beat ${previousSpeed}`);
  need(lv.paddleW <= previousWidth, L, `PADDLE_W ${lv.paddleW} is wider than ${previousWidth}`);
  previousSpeed = lv.ballSpeed;
  previousWidth = lv.paddleW;

  // RULE 1: a shielded block must be breakable, which means a shot must exist.
  if (shielded && lv.mechanic >= MECH_SHIELD) {
    need(lv.ammoStart > shielded, L, `${shielded} shielded blocks and AMMO_START ${lv.ammoStart}`);
    need(lv.sidePads === 1, L, "has shielded blocks and no side pads to recharge at");
    need((lv.dropMask & GUN) !== 0, L, "has shielded blocks and no `gun` in DROP_MASK");
    // And nothing a shot cannot pass may sit under one, ever.
    for (const s of all.filter((x) => x.t === 6)) {
      for (let r = s.r + 1; r < GRID_H; r++) {
        need(g[r][s.c] !== "5", L, `shielded block at row ${s.r} column ${s.c} is roofed by a solid`);
      }
    }
  }

  // RULE 2: no counting block may be walled off from the ball.
  for (const u of unreachable(g)) {
    need(false, L, `the block at row ${u.r} column ${u.c} cannot be reached`);
  }

  // A drifting row must still be on screen at full drift, or its blocks become
  // unhittable and the level cannot be cleared.
  const driftCols = new Set();
  for (const d of all.filter((x) => x.t === 7)) {
    for (const x of all.filter((y) => y.r === d.r)) driftCols.add(x.c);
  }
  const margin = Math.ceil(DRIFT_RANGE / 8);
  for (const c of driftCols) {
    need(c >= margin, L, `a drifting row reaches column ${c}, which slides off the left edge`);
    need(c < GRID_W - margin, L, `a drifting row reaches column ${c}, which slides off the right`);
  }

  // A header may not switch on a mechanic the level has not reached, and may
  // not leave one on with nothing for it to act on.
  need(!(lv.dropRate > 0) || lv.mechanic >= MECH_DROPS, L, "DROP_RATE before the drops mechanic");
  need(!(lv.sidePads === 1) || lv.mechanic >= MECH_PADS, L, "SIDE_PADS before the pads mechanic");
  need(!(lv.driftSpeed > 0) || lv.mechanic >= MECH_DRIFT, L, "DRIFT_SPEED before the drift mechanic");
  need(!(lv.ballCount > 1) || lv.mechanic >= MECH_MULTI, L, "BALL_COUNT before the multi mechanic");
  need(!!drifters === lv.driftSpeed > 0, L, `${drifters} drifters against DRIFT_SPEED ${lv.driftSpeed}`);

  report.push({
    L: L + 1,
    mech: lv.mechanic,
    speed: lv.ballSpeed,
    pw: lv.paddleW,
    reds,
    blocks: counting,
    shielded,
    ammo: lv.ammoStart,
    react: all
      .filter((x) => x.t === 4)
      .map((x) => `r${x.r}c${x.c}:${reaction(x.r, lv.ballSpeed).frames}f`)
      .join(" "),
  });
}

if (problems.length) {
  for (const p of problems) console.error(`  ${p}`);
  throw new Error(`${problems.length} problem(s) in the level pack`);
}

// ============================================================================
// The output
// ============================================================================

/** The map is 128 tiles wide; ten levels reach map row 23. */
const MAP_W = 128;
const BAND = 8;
const MAP_ROWS = (Math.floor((LEVELS.length - 1) / BAND) + 1) * GRID_H;
const map = new Uint8Array(MAP_ROWS * MAP_W);

for (let L = 0; L < LEVELS.length; L++) {
  const ox = (L % BAND) * GRID_W;
  const oy = Math.floor(L / BAND) * GRID_H;
  const g = LEVELS[L].grid;
  for (let r = 0; r < GRID_H; r++) {
    for (let c = 0; c < GRID_W; c++) {
      const ch = g[r][c];
      map[(oy + r) * MAP_W + ox + c] = ch === "." ? 0 : Number(ch);
    }
  }
}

/** Ten 16-byte headers. Bytes 10..15 are reserved and stay zero. */
const dat = new Uint8Array(LEVELS.length * 16);
for (let L = 0; L < LEVELS.length; L++) {
  const lv = LEVELS[L];
  const o = L * 16;
  dat[o + 0] = lv.mechanic;
  dat[o + 1] = lv.ballSpeed;
  dat[o + 2] = lv.paddleW;
  dat[o + 3] = cells(lv.grid).filter((x) => x.t === 4).length; // RED_COUNT, derived
  dat[o + 4] = lv.dropRate;
  dat[o + 5] = lv.dropMask;
  dat[o + 6] = lv.ballCount;
  dat[o + 7] = lv.driftSpeed;
  dat[o + 8] = lv.sidePads;
  dat[o + 9] = lv.ammoStart;
}
for (const b of dat) {
  if (!Number.isInteger(b) || b < 0 || b > 255) throw new Error(`header byte ${b} is not 0..255`);
}

writeFileSync(new URL("./levels.map", import.meta.url), map);
writeFileSync(new URL("./levels.dat", import.meta.url), dat);

console.log(" L  mech speed  pw  red  blk  shld ammo   red-block reaction (frames to the paddle)");
for (const r of report) {
  console.log(
    `${String(r.L).padStart(2)}  ${String(r.mech).padStart(4)} ${String(r.speed).padStart(5)} ` +
      `${String(r.pw).padStart(3)} ${String(r.reds).padStart(4)} ${String(r.blocks).padStart(4)} ` +
      `${String(r.shielded).padStart(5)} ${String(r.ammo).padStart(4)}   ${r.react}`,
  );
}
console.log(
  `redlevels: ${LEVELS.length} levels, ${map.length} bytes of map + ${dat.length} bytes of headers`,
);

export { LEVELS };
