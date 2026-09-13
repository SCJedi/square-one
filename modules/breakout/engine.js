// The `breakout` engine: Red Breaker, as a Square One cart body.
//
// This file is CART SOURCE. It is not compiled, not bundled and not typed --
// the stamper writes `const KNOB = { ... }` above it and the result is the
// .cart's CODE chunk.
//
// WHAT MAKES THIS THE THIRD MODULE AND NOT THE THIRD GENRE KERNEL
// ---------------------------------------------------------------
// `platformer` and `topdown` are kernels: they generate their own world from a
// seed and a handful of chances. This one generates nothing. Every level
// parameter is a byte in the DATA headers at 0x7800 and every block is a byte
// in the MAP chunk, laid out by modules/FORMATS-breakout.md, which neither this
// module nor the level pack owns. Swap the pack and it is a different game with
// the same mechanics; that split is the whole point of the module system, and
// this is the first module that actually exercises it.
//
// So there is no `generate()` here, and there must never be one. A number that
// describes A LEVEL is read from the header. A number that describes THE GAME
// -- how fast the paddle slides, how a bounce angles, how long a power-up lasts
// -- is a knob.
//
// THE RED BALL, WHICH IS THE GAME
// -------------------------------
// The ball is NORMAL or RED (bit 1 of its flags byte).
//
//   1. Breaking a type-4 block sets the ball RED.
//   2. While RED, and only then, a red beam is drawn BELOW the paddle.
//   3. RED ball touches the PADDLE -> paddle destroyed, life lost, ball gone.
//   4. RED ball PASSES THROUGH a BREAKABLE block -- 1, 2, 3, 4, 8 -- destroying
//      it outright whatever it had left, without deflecting, STAYING RED.
//   5. Walls and the ceiling bounce it; it STAYS RED.
//   6. SOLID and SHIELDED bounce it; it STAYS RED. They are structure: a red
//      ball that ate them would clear level eight, which REQUIRES the gun.
//   7. RED ball touches the BEAM -> it deflects AND returns to NORMAL. THAT IS
//      THE ONLY THING THAT CLEARS IT; a shot no longer does.
//
// A WRECKING BALL clearing the level for you: keep it alive, keep it away from
// the paddle. README.md has the rest of the argument.
//
// THE CLEAR IS ONE FUNCTION WITH ONE CALLER: `deflect()` masks bit 1 off a live
// ball, the beam branch of `contact()` is its only caller, and `bounce()` never
// touches the bit. A contact added later gets rule 5 free and cannot clear by
// accident; the test counts the mask; a THIRD STATE would go in `deflect()`.
//
// THE BEAM IS NOT A FLOOR. `contact()` tests the beam only when bit 1 is set,
// so a normal ball falls straight through it and is lost. Softening that would
// remove the only way to die, and the engine test asserts it directly.
//
// WHERE STATE LIVES
// -----------------
// In RAM, above the headers. `DATA` fills 0x7800..0x789F with ten 16-byte level
// headers, so this engine's own mutable state starts at 0x7900 and never writes
// below it. The module-level `var`s are of two kinds and NEITHER is machine
// state: address constants, which are literals, and values derived from KNOB
// alone, which cannot change because KNOB is frozen at stamp time.
//
// THE COORDINATE SYSTEM
// ---------------------
// Positions and velocities are in SIXTEENTHS OF A PIXEL, stored as signed
// 16-bit little-endian, because that is the unit the header's `BALL_SPEED` and
// `DRIFT_SPEED` are already in: 16 is one pixel per frame. `>> 4` converts to
// pixels and floors correctly for negatives.
//
// WHAT IT DRAWS WITH, AND WHY THERE ARE STILL RECTANGLES IN HERE
// --------------------------------------------------------------
// Two draw paths, chosen once at boot and held in one RAM byte, G_ART.
//
//   SPRITES. Every cell is `sprite_base + N` with N fixed by the table in
//   modules/FORMATS-breakout-art.md. ONE knob holds the base; the format
//   document holds the layout, so a cell moving is a change to that file and
//   not to sixty knobs.
//
//   RECTANGLES. Exactly what this engine drew before there was any art: filled
//   bars in live palette slots. Every `*_color` knob still works and still
//   means what it meant.
//
// `art()` decides between them by LOOKING AT THE SHEET: it reads the 8 x 8 cell
// at `sprite_base` and answers whether any pixel of it is set. With no
// spriteset in the recipe the GFX region is zero, the answer is no, and the
// cart draws bars. That is the test rather than "is `sprite_base` non-zero"
// because a base of 0 is a perfectly good base -- the first pack to sit at cell
// 0 would otherwise be invisible -- and it is done at boot rather than per frame
// because the sheet is installed before `boot()` runs and never changes after.
//
// A cart whose art pack went missing draws plainly. It does not draw nothing.
//
// A BLOCK IS 8 x 6 AND A CELL IS 8 x 8
// ------------------------------------
// So a block is lifted out of the TOP of its cell with `sspr`, and the bottom
// two rows of those cells are unused. That is 25% of thirteen cells and it is
// the right trade: `block_h` 8 would push the bottom row of blocks to y=105
// against a paddle at y=110, cutting the reaction gap from 28 pixels to 4 and
// killing the red-block mechanic outright. ART MUST NEVER COST THE GAME A
// MECHANIC. Everything that is not a block -- ball, drops, shot, paddle caps,
// beam, effects -- uses a whole 8 x 8 cell, and `sprc` centres that cell on the
// small box the physics actually uses, so a 3-pixel ball keeps its centre.
//
// ANIMATION, WHICH IS STATE, WHICH LIVES IN RAM
// ---------------------------------------------
// Two kinds, and they are told apart by whether the animation belongs to the
// WORLD or to a THING that happened.
//
//   Free-running: the red ball's two frames, the beam's scroll, a drop's
//   tumble. These are a function of `sys.frame()` and cost no state at all --
//   and FRAME is machine state inside the 64 KB, so a rewind restores the
//   animation with everything else.
//
//   Event-driven: a block breaking, a ball's impact spark, a shielded block
//   flashing. These have a position and a life, so they are a pool of
//   `max_fx` three-byte slots at G_FX -- x, y, and `kind << 4 | life`. `fx()`
//   spawns, `timers()` ages, `fxDraw()` draws; life packs into a nibble, which
//   is why `fx_frames` is capped at 5.
//
// THE PADDLE'S DESTRUCTION IS THE ONE THAT PAUSES THE GAME. A red ball on the
// paddle costs the life IMMEDIATELY -- `redHit` is unchanged -- and additionally
// sets G_DEAD, and while G_DEAD runs `tick` skips the whole simulation and only
// draws. So the four frames play, the player cannot move, the serve cannot be
// launched, and the moment lands before the next ball exists. The life was
// already gone; what the pause holds is the beat, not the bookkeeping.
//
// WHAT IT SOUNDS LIKE, AND WHY THE CHANNELS ARE FIXED HERE
// --------------------------------------------------------
// Seventeen events, seventeen `sfx_*` knobs, and the number a knob defaults to
// is the effect number modules/FORMATS-breakout-art.md gives that event. The
// engine chooses the CHANNEL, because which effect may interrupt which is a
// mechanic and not a preference:
//
//   0, 1  the ones that fire many times a second -- block hit, break, paddle
//         return, wall. A song claims 2 and 3 and leaves these to the engine.
//   2     drops, shots, shields, the side pads.
//   3     THE IMPORTANT ONE. The alarm, the deflection, the paddle's
//         destruction, a lost ball, the level clear and the game over.
//
// PUTTING THE ALARM AND THE DEFLECTION ON THE SAME CHANNEL IS THE POINT. A
// channel plays one thing, so `sfx_deflect` cuts `sfx_red` off where it stands
// and the player hears the warning STOP. The same rule gives the game-over cue
// the channel a frame after the loss cue took it, which is why "life lost" is
// heard on every life except the last.
//
// A lost ball and a destroyed paddle are DIFFERENT EVENTS with different
// effects -- `sfx_lose` and `sfx_smash`. They shared one knob once, and the
// player could not tell from the sound which of the two had happened.
//
// AND THERE IS A SONG. `song()` starts it, from `loadLevel`, so it begins under
// level one's serve rather than waiting for a launch: this cart has no attract
// screen, the field is up and the paddle already moves, and a game that draws
// on frame one should sound on frame one. It plays ONE BAND PER DIFFICULTY
// STEP -- `music_a` up to `music_level_b`, `music_b` up to `music_level_c`,
// `music_c` after -- and restarts only WHEN THE BAND CHANGES, because a bank's
// band is a short loop and clipping it every level says nothing the HUD's level
// number has not said already.
//
// IT KEEPS PLAYING THROUGH A LOST LIFE AND THROUGH GAME OVER, and that is the
// mix the bank is written for: `music_mask` hands the song channels 2 and 3, an
// effect that claims one TAKES it, and the song simply drops that voice until
// the pattern turns over. So `sfx_lose`, `sfx_smash` and `sfx_over` -- all on
// channel 3 -- play over a continuing melody with the bass out from under it
// for their length, which is the sound of the floor going. Stopping the song
// instead would cost a second of silence where the cue is, and the player
// presses A into a track that never stopped.
//
// HOW TUNNELLING IS BOUNDED
// -------------------------
// `move()` splits one frame into `n = 1 + (m / (step_max * 16)) | 0` substeps,
// where `m` is the larger of the two velocity components -- or twice the level's
// ball speed, whichever is bigger, because a bounce inside a substep can raise a
// component to `BALL_SPEED` and the bound has to survive that. Each substep
// therefore moves at most `step_max` pixels on either axis, and `step_max` (3)
// is smaller than both block dimensions (8 x 6), so a ball can never cross a
// block without a substep landing inside it. At the fastest legal header --
// BALL_SPEED 255, just under 16 px/frame -- that is 11 substeps.

// --- the machine's own addresses --------------------------------------------
var A_MAP = 0x4300;
var A_HDR = 0x7800; // ten 16-byte level headers, installed by the DATA chunk
var A_GFX = 0x2200; // the sprite sheet: one 128 x 128 picture, 64 bytes a row
var SUB = 16; // subpixels per pixel; the header's own unit

// --- the level header, field by field (FORMATS-breakout.md) -----------------
var H_MECH = 0; // which mechanics are live on this level, 0..9
var H_SPEED = 1; // ball speed, 1/16 px per frame
var H_PADW = 2; // paddle width in pixels
var H_DROPR = 4; // chance in 256 that a broken block drops something
var H_DROPM = 5; // which drop kinds may appear, one bit each
var H_COUNT = 6; // balls in play at serve
var H_DRIFT = 7; // sideways speed of drifter rows, 1/16 px per frame
var H_PADS = 8; // 1 if the side charge pads exist
var H_AMMO = 9; // shots the player begins the level with
// Offset 3 is RED_COUNT, which describes the grid the pack authored rather than
// anything the engine has to do, so nothing here reads it.

// --- this cart's own RAM, which starts ABOVE the headers ---------------------
var S = 0x7900;
var G_LEVEL = S + 0;
var G_LIVES = S + 1;
var G_STATE = S + 2; // 0 playing, 1 game over, 2 every level cleared
var G_PADX = S + 4; // i16, subpixels
var G_PADW = S + 6; // current width, which `wide` grows and a lost life resets
var G_AMMO = S + 7;
var G_WIDE = S + 8; // frames of the wide paddle left
var G_SLOW = S + 9;
var G_CATCH = S + 10;
var G_DRIFT = S + 12; // i16, the drifting rows' shared offset in subpixels
var G_DDIR = S + 14; // 1 while that offset is travelling west
var G_PADT = S + 15; // which side pads the paddle was touching last frame
var G_ROWS = S + 16; // i16 bitmask: row r drifts when bit r is set
var G_DEAD = S + 18; // frames of the paddle's destruction left to play
var G_ART = S + 19; // 1 when the sheet holds a picture at sprite_base
var G_BAND = S + 20; // the music band playing, + 1; 0 is a machine that is silent
var G_BALLS = S + 24;

// One ball is 10 bytes. FLAGS is bit 0 alive, bit 1 RED, bit 2 stuck to the
// paddle -- which is how both the serve and the `catch` power-up are spelled.
var B_X = 0;
var B_Y = 2;
var B_VX = 4;
var B_VY = 6;
var B_F = 8;

var BTN_L = 2;
var BTN_R = 3;
var BTN_A = 4;
var BTN_B = 5;

// --- constants derived from the knobs ---------------------------------------
var MB = KNOB.maxBalls;
var MD = KNOB.maxDrops;
var MS = KNOB.maxShots;
var GW = KNOB.gridW;
var GH = KNOB.gridH;
var BW = KNOB.blockW;
var BH = KNOB.blockH;
var TOP = KNOB.fieldTop;
var BS = KNOB.ballSize;
var CELLS = GW * GH;
var PADV = (KNOB.paddleSpeed * SUB) | 0;
var DROPV = (KNOB.dropSpeed * SUB) | 0;
var SB = KNOB.spriteBase; // cell N of the art table is SB + N
var MF = KNOB.maxFx;
var FXL = KNOB.fxFrames * 3; // one effect's life: three frames of art
var DEADF = KNOB.fxFrames * 4; // the pause: four frames of a paddle coming apart

var G_DROPS = G_BALLS + MB * 10; // 4 bytes each: x, i16 y, kind + 1
var G_SHOTS = G_DROPS + MD * 4; // 3 bytes each: x, y, live
var G_BLOCKS = G_SHOTS + MS * 3; // one byte per cell: type | hits << 4
var G_FX = G_BLOCKS + CELLS; // 3 bytes each: x, y, kind << 4 | life
var G_END = G_FX + MF * 3;

// ============================================================================
// RAM helpers
// ============================================================================

/** Signed 16-bit little-endian read. */
function r16(a) {
  var v = sys.peek(a) | (sys.peek(a + 1) << 8);
  return v > 32767 ? v - 65536 : v;
}

function w16(a, v) {
  sys.poke(a, v);
  sys.poke(a + 1, v >> 8);
}

/** Field `i` of the CURRENT level's header. The engine's only level data. */
function hd(i) {
  return sys.peek(A_HDR + sys.peek(G_LEVEL) * 16 + i);
}

/**
 * Is the mechanic introduced at level `m` live yet?
 *
 * Each level keeps everything the levels before it introduced, so the test is
 * `>=` and not `===`. The header byte SELECTS, and the knob says which value
 * turns a given mechanic on -- so a pack that wants drops from level one moves
 * one number in a recipe rather than editing this file.
 */
function mech(m) {
  return hd(H_MECH) >= m;
}

function ball(i) {
  return G_BALLS + i * 10;
}

/** This level's ball speed, in subpixels per frame, after the `slow` drop. */
function speed() {
  var s = hd(H_SPEED);
  return sys.peek(G_SLOW) ? (s * KNOB.slowScale) | 0 : s;
}

// ============================================================================
// Art and animation
// ============================================================================

/**
 * Is there a picture at `sprite_base`? Answered ONCE, at boot, by reading the
 * sheet -- see the note at the top of this file about why it is not a knob test.
 *
 * A cell is 8 pixels wide, two pixels to a byte, so it is 4 bytes across and 8
 * rows down out of a sheet 64 bytes to the row.
 */
function art() {
  var x = (SB & 15) * 4;
  var y = (SB >> 4) * 8;
  for (var r = 0; r < 8; r++) {
    for (var i = 0; i < 4; i++) if (sys.peek(A_GFX + (y + r) * 64 + x + i)) return 1;
  }
  return 0;
}

/**
 * The free-running animation clock: 0 or 1, flipping every `r` frames, offset
 * by `i` so a row of beam segments alternates ALONG the row and scrolls rather
 * than blinking on and off together.
 *
 * FRAME is machine state at 0x20FC, so this survives a rewind for free and
 * costs the engine no RAM of its own.
 */
function anim(i, r) {
  return (i + ((sys.frame() / r) | 0)) & 1;
}

/**
 * Start an effect at (x, y). Kinds: 0 block break, 1 impact spark, 2 shield.
 *
 * The position is a byte, so a drifting row that has slid off the west edge is
 * clamped rather than wrapped to the far side of the screen -- the same clamp
 * and the same reason as `drop`.
 */
function fx(k, x, y) {
  if (x < 0) x = 0;
  for (var i = 0; i < MF; i++) {
    var a = G_FX + i * 3;
    if (sys.peek(a + 2) & 15) continue;
    sys.poke(a, x);
    sys.poke(a + 1, y);
    sys.poke(a + 2, (k << 4) | (k === 2 ? KNOB.fxFrames : FXL));
    return;
  }
}

/** Where block `i` is on the screen, drift included. */
function blockX(i) {
  return (i % GW) * BW + drift((i / GW) | 0);
}

function blockY(i) {
  return TOP + ((i / GW) | 0) * BH;
}

// ============================================================================
// The block grid
// ============================================================================

/** How far row `r` has drifted, in whole pixels. Rows that do not drift: 0. */
function drift(r) {
  return (sys.peek(G_ROWS + (r >> 3)) >> (r & 7)) & 1 ? r16(G_DRIFT) >> 4 : 0;
}

/**
 * The index of the block covering pixel (x, y), or -1.
 *
 * The row's drift is subtracted from x rather than added to the grid, so one
 * lookup serves a still row and a sliding one and collision cannot disagree
 * with drawing about where a drifter is.
 */
function at(x, y) {
  if (y < TOP) return -1;
  var r = ((y - TOP) / BH) | 0;
  if (r >= GH) return -1;
  var cx = x - drift(r);
  if (cx < 0) return -1;
  var c = (cx / BW) | 0;
  if (c >= GW) return -1;
  var i = r * GW + c;
  return sys.peek(G_BLOCKS + i) ? i : -1;
}

/** The first block the ball's square overlaps, tested at its four corners. */
function cellAt(x, y) {
  var c = at(x, y);
  if (c < 0) c = at(x + BS - 1, y);
  if (c < 0) c = at(x, y + BS - 1);
  if (c < 0) c = at(x + BS - 1, y + BS - 1);
  return c;
}

/**
 * How many hits a fresh block of type `t` takes.
 *
 * Types 2 and 3 take 2 and 3 -- the value IS the count, which is the one place
 * the format's numbering pays for itself. Before the tough-block mechanic is
 * live they take one hit like anything else, so a pack may put a type-2 block
 * on level two and have it behave as the player has been taught.
 */
function hits(t) {
  return (t === 2 || t === 3) && mech(KNOB.mechTough) ? t : 1;
}

/**
 * Take a hit off block `i`. `b` is the ball that did it, or 0 for a shot.
 *
 * ANSWERS WHETHER THE BALL MUST BOUNCE: what is left of a block and whether it
 * stopped you are one decision and may not become two. SOLID never breaks and
 * SHIELDED breaks only to a shot, which makes shooting required; both deflect
 * anything, red or not (rule 6). Everything else BREAKS to a RED ball in one
 * pass and lets it through (rule 4).
 */
function damage(i, b, shot) {
  var a = G_BLOCKS + i;
  var v = sys.peek(a);
  var t = v & 15;
  // The spark goes where the BALL is, because that is where the contact looked
  // like it happened; the break goes where the BLOCK was.
  if (b) fx(1, r16(b + B_X) >> 4, r16(b + B_Y) >> 4);
  if (t === 5) return 1;
  if (t === 6 && !shot && mech(KNOB.mechShield)) {
    fx(2, blockX(i), blockY(i));
    snd.sfx(KNOB.sfxPing, 2);
    return 1;
  }
  var red = b && sys.peek(b + B_F) & 2;
  var h = red ? 0 : (v >> 4) - 1;
  if (h > 0) {
    sys.poke(a, t | (h << 4));
    snd.sfx(KNOB.sfxHit, 1);
    return 1;
  }
  sys.poke(a, 0);
  // A shielded block is the one a ball cannot touch, so its break is not the
  // ordinary break: it is the payoff for having brought a gun.
  if (t === 6) snd.sfx(KNOB.sfxShield, 2);
  else snd.sfx(KNOB.sfxBreak, 1);
  // Rule 1, and the only place in the engine that sets RED. The alarm goes with
  // it, on channel 3, because the picture and the sound are one warning and the
  // player has about a second to act on them.
  if (t === 4 && b && mech(KNOB.mechRed)) {
    sys.poke(b + B_F, sys.peek(b + B_F) | 2);
    snd.sfx(KNOB.sfxRed, 3);
  }
  fx(0, blockX(i), blockY(i));
  drop(i, t);
  return !red;
}

/** Every breakable block gone. Solid blocks are scenery and never count. */
function cleared() {
  for (var i = 0; i < CELLS; i++) {
    var t = sys.peek(G_BLOCKS + i) & 15;
    if (t && t !== 5) return false;
  }
  return true;
}

// ============================================================================
// The ball
// ============================================================================

/**
 * Reverse one axis. IT DOES NOT TOUCH THE BALL'S COLOUR and must never grow a
 * write to the flags byte: rule 5 says a red ball survives every deflection.
 */
function bounce(b, axis) {
  var a = b + (axis ? B_VY : B_VX);
  w16(a, -r16(a));
}

/** Rule 7: what the BEAM does to a ball. The engine's one clear. */
function deflect(b) {
  sys.poke(b + B_F, sys.peek(b + B_F) & 253);
}

/**
 * A bounce off the edge of the field: the two side walls and the ceiling.
 *
 * The SOUND is why this is not just `bounce`. Every deflection comes through
 * `bounce`, and three -- a block, the beam, the paddle's miss -- have a cue
 * already; the wall over those is what the bank's effects exist to keep apart.
 */
function edge(b, axis) {
  bounce(b, axis);
  snd.sfx(KNOB.sfxWall, 1);
}

/**
 * The paddle, the beam and the floor, in that order -- which is also top to
 * bottom, so a ball meets them the way it falls past them.
 *
 * Returns false when the ball is gone. The paddle test does NOT look at the
 * ball's direction while it is RED: rule 3 says "touches", and a red ball
 * clipping the paddle's shoulder on the way up has still touched it.
 */
function contact(b) {
  var f = sys.peek(b + B_F);
  var x = r16(b + B_X) >> 4;
  var y = r16(b + B_Y) >> 4;
  var pw = sys.peek(G_PADW);
  var px = r16(G_PADX) >> 4;
  if (
    y + BS > KNOB.paddleY &&
    y < KNOB.paddleY + KNOB.paddleH &&
    x + BS > px &&
    x < px + pw
  ) {
    if (f & 2) {
      redHit();
      return false;
    }
    if (r16(b + B_VY) > 0) {
      w16(b + B_Y, (KNOB.paddleY - BS) * SUB);
      if (sys.peek(G_CATCH)) {
        sys.poke(b + B_F, f | 4);
        w16(b + B_VX, 0);
        w16(b + B_VY, 0);
        return true;
      }
      var spd = speed();
      var mn = (spd * KNOB.minAngle) | 0;
      if (mn < 1) mn = 1;
      var half = pw >> 1;
      if (half < 1) half = 1;
      var rel = x + (BS >> 1) - px - half;
      // Where on the paddle it landed decides the angle. A dead-centre hit
      // would send the ball straight up forever, so `min_angle` is a floor as
      // well as the serve angle.
      var vx = ((rel * spd * KNOB.spread) / half) | 0;
      if (vx < mn && vx > -mn) vx = rel < 0 ? -mn : mn;
      w16(b + B_VX, vx);
      w16(b + B_VY, -spd);
      snd.sfx(KNOB.sfxPaddle, 0);
    }
    return true;
  }
  // THE BEAM DEFLECTS A RED BALL AND NOTHING ELSE. Drop the `f & 2` and it
  // becomes a floor, and the game stops being able to end.
  if (
    f & 2 &&
    r16(b + B_VY) > 0 &&
    y + BS > KNOB.beamY &&
    y < KNOB.beamY + KNOB.beamH
  ) {
    w16(b + B_Y, (KNOB.beamY - BS) * SUB);
    bounce(b, 1);
    deflect(b); // rule 7, at its one call site
    // Channel 3 is the alarm's channel, so this CUTS THE ALARM OFF where it
    // stands. The player hears the warning stop, which is the whole message.
    snd.sfx(KNOB.sfxDeflect, 3);
    return true;
  }
  if (y >= 128) {
    sys.poke(b + B_F, 0);
    snd.sfx(KNOB.sfxLose, 3);
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
 * stops -- or, having PLOUGHED, is not put back at all.
 */
function sub(b, dx, dy) {
  var x0 = r16(b + B_X);
  var x = x0 + dx;
  if (x < 0) {
    x = 0;
    edge(b, 0);
  } else if ((x >> 4) + BS > 128) {
    x = (128 - BS) * SUB;
    edge(b, 0);
  } else {
    var cx = cellAt(x >> 4, r16(b + B_Y) >> 4);
    if (cx >= 0 && damage(cx, b, 0)) {
      x = x0;
      bounce(b, 0);
    }
  }
  w16(b + B_X, x);

  var y0 = r16(b + B_Y);
  var y = y0 + dy;
  if ((y >> 4) < KNOB.ceilingY) {
    y = KNOB.ceilingY * SUB;
    edge(b, 1);
  } else {
    var cy = cellAt(x >> 4, y >> 4);
    if (cy >= 0 && damage(cy, b, 0)) {
      y = y0;
      bounce(b, 1);
    }
  }
  w16(b + B_Y, y);
  return contact(b);
}

/** One frame of one ball, in substeps small enough never to skip a block. */
function move(b) {
  var vx = r16(b + B_VX);
  var vy = r16(b + B_VY);
  var ax = vx < 0 ? -vx : vx;
  var ay = vy < 0 ? -vy : vy;
  var m = ax > ay ? ax : ay;
  // A bounce inside a substep can set a component to BALL_SPEED, so the bound
  // is taken over what the velocity may BECOME this frame, not only what it is.
  var cap = speed() * 2;
  if (cap > m) m = cap;
  var n = 1 + ((m / (KNOB.stepMax * SUB)) | 0);
  for (var s = 0; s < n; s++) {
    // Re-read every substep: a bounce partway through changes the direction of
    // the rest of the frame, which is the whole reason for substepping.
    if (!sub(b, (r16(b + B_VX) / n) | 0, (r16(b + B_VY) / n) | 0)) return;
  }
}

function ballsAlive() {
  var n = 0;
  for (var i = 0; i < MB; i++) if (sys.peek(ball(i) + B_F) & 1) n++;
  return n;
}

function anyRed() {
  for (var i = 0; i < MB; i++) if ((sys.peek(ball(i) + B_F) & 3) === 3) return true;
  return false;
}

/** A ball waiting on the paddle: the serve, and what `catch` turns a hit into. */
function stick(b, f) {
  w16(b + B_X, r16(G_PADX) + ((sys.peek(G_PADW) - BS) >> 1) * SUB);
  w16(b + B_Y, (KNOB.paddleY - BS) * SUB);
  if (inp.btnp(BTN_A)) launch(b, f);
}

function launch(b, f) {
  var spd = speed();
  var mn = (spd * KNOB.minAngle) | 0;
  if (mn < 1) mn = 1;
  w16(b + B_VX, sys.rnd(2) ? mn : -mn);
  w16(b + B_VY, -spd);
  sys.poke(b + B_F, f & 251); // it is no longer stuck
  // BALL_COUNT belongs to the SERVE, and a serve is the one launch where
  // nothing else is in play and no `catch` is running -- `loadLevel` and
  // `loseLife` both clear that timer, and a catch-release cannot happen without
  // it. Without both tests a player holding the last ball on a caught paddle
  // would mint a fresh BALL_COUNT every time they let go.
  if (ballsAlive() === 1 && !sys.peek(G_CATCH) && mech(KNOB.mechMulti)) {
    for (var i = 1; i < hd(H_COUNT); i++) split();
  }
}

/** Copy a live ball into a free slot, mirrored on X. The `multi` drop. */
function split() {
  for (var i = 0; i < MB; i++) {
    var b = ball(i);
    var f = sys.peek(b + B_F);
    if ((f & 5) !== 1) continue;
    for (var j = 0; j < MB; j++) {
      var o = ball(j);
      if (sys.peek(o + B_F) & 1) continue;
      w16(o + B_X, r16(b + B_X));
      w16(o + B_Y, r16(b + B_Y));
      w16(o + B_VX, -r16(b + B_VX));
      w16(o + B_VY, r16(b + B_VY));
      sys.poke(o + B_F, f);
      return;
    }
    return;
  }
}

function spawnBall() {
  for (var i = 0; i < MB; i++) {
    var b = ball(i);
    if (sys.peek(b + B_F) & 1) continue;
    w16(b + B_VX, 0);
    w16(b + B_VY, 0);
    sys.poke(b + B_F, 5); // alive and stuck
    return;
  }
}

/**
 * Rule 3: the paddle is destroyed and a life goes with it.
 *
 * The life is taken HERE, on the frame of the contact, and G_DEAD only holds
 * the beat afterwards -- see the note at the top of this file. Bookkeeping and
 * theatre are separable and the bookkeeping does not get to wait.
 */
function redHit() {
  for (var i = 0; i < MB; i++) sys.poke(ball(i) + B_F, 0);
  // NOT `sfx_lose`. A ball rolling off the bottom of the screen and a red ball
  // taking the paddle apart are different events, and the bank gives them
  // different sounds; sharing one was the engine losing information the player
  // needs. `loseLife` may fire the game-over cue over the top of this, on the
  // same channel, and on the last life that is the right ending.
  snd.sfx(KNOB.sfxSmash, 3);
  loseLife();
  sys.poke(G_DEAD, DEADF);
}

function loseLife() {
  var l = sys.peek(G_LIVES);
  if (l < 2) {
    sys.poke(G_LIVES, 0);
    sys.poke(G_STATE, 1);
    snd.sfx(KNOB.sfxOver, 3);
    return;
  }
  sys.poke(G_LIVES, l - 1);
  sys.poke(G_PADW, hd(H_PADW));
  sys.poke(G_WIDE, 0);
  sys.poke(G_SLOW, 0);
  sys.poke(G_CATCH, 0);
  spawnBall();
}

function balls() {
  for (var i = 0; i < MB; i++) {
    var b = ball(i);
    var f = sys.peek(b + B_F);
    if (!(f & 1)) continue;
    if (f & 4) stick(b, f);
    else move(b);
  }
  if (ballsAlive() === 0) loseLife();
}

// ============================================================================
// The paddle, the pads and the gun
// ============================================================================

function paddle() {
  var x = r16(G_PADX);
  if (inp.btn(BTN_L)) x -= PADV;
  if (inp.btn(BTN_R)) x += PADV;
  var w = sys.peek(G_PADW);
  var hi = (128 - w) * SUB;
  if (x < 0) x = 0;
  if (x > hi) x = hi;
  w16(G_PADX, x);

  // The side pads: touch one with the paddle and a shot is charged. The
  // previous frame's touch is remembered so that parking on a pad charges once
  // rather than sixty times a second.
  if (hd(H_PADS) && mech(KNOB.mechPads)) {
    var t = 0;
    var p = x >> 4;
    if (p < KNOB.padZone) t = 1;
    if (p + w > 128 - KNOB.padZone) t |= 2;
    if (t & ~sys.peek(G_PADT)) {
      sys.poke(G_AMMO, sys.peek(G_AMMO) + 1);
      snd.sfx(KNOB.sfxCharge, 2);
    }
    sys.poke(G_PADT, t);
  }
  if (inp.btnp(BTN_B) && sys.peek(G_AMMO)) fire();
}

function fire() {
  for (var i = 0; i < MS; i++) {
    var s = G_SHOTS + i * 3;
    if (sys.peek(s + 2)) continue;
    sys.poke(s, (r16(G_PADX) >> 4) + (sys.peek(G_PADW) >> 1));
    sys.poke(s + 1, KNOB.paddleY - KNOB.shotH);
    sys.poke(s + 2, 1);
    sys.poke(G_AMMO, sys.peek(G_AMMO) - 1);
    snd.sfx(KNOB.sfxShoot, 2);
    return;
  }
}

/**
 * Shots break blocks, and in particular the shielded ones a ball cannot. One
 * used to clear a red ball too; rule 7 made the beam the only clear.
 */
function shots() {
  for (var i = 0; i < MS; i++) {
    var s = G_SHOTS + i * 3;
    if (!sys.peek(s + 2)) continue;
    var y = sys.peek(s + 1) - KNOB.shotSpeed;
    var x = sys.peek(s);
    if (y < KNOB.ceilingY) {
      sys.poke(s + 2, 0);
      continue;
    }
    sys.poke(s + 1, y);
    var c = at(x, y);
    if (c < 0) c = at(x + KNOB.shotW - 1, y);
    if (c >= 0) {
      damage(c, 0, 1);
      sys.poke(s + 2, 0);
    }
  }
}

// ============================================================================
// Drops
// ============================================================================

/**
 * Maybe drop something from the block that just broke.
 *
 * The kind is chosen from DROP_MASK by counting its set bits and picking one,
 * so a pack decides what a level may produce without the engine holding a table
 * of level contents. A type-8 block always drops.
 */
function drop(i, t) {
  if (!mech(KNOB.mechDrops)) return;
  var mask = hd(H_DROPM);
  if (!mask) return;
  if (t !== 8 && sys.rnd(256) >= hd(H_DROPR)) return;
  var n = 0;
  var k;
  for (k = 0; k < 6; k++) if ((mask >> k) & 1) n++;
  if (!n) return;
  var p = sys.rnd(n);
  var kind = 0;
  for (k = 0; k < 6; k++) {
    if (!((mask >> k) & 1)) continue;
    if (!p) {
      kind = k;
      break;
    }
    p--;
  }
  var x = blockX(i);
  if (x < 0) x = 0;
  for (k = 0; k < MD; k++) {
    var d = G_DROPS + k * 4;
    if (sys.peek(d + 3)) continue;
    sys.poke(d, x);
    w16(d + 1, blockY(i) * SUB);
    sys.poke(d + 3, kind + 1);
    // Only a drop that FOUND A SLOT makes a sound, so the cue means "there is
    // something falling" and never "there nearly was".
    snd.sfx(KNOB.sfxSpawn, 2);
    return;
  }
}

/**
 * The six drop kinds, in DROP_MASK's own bit order.
 *
 * The extra life gets its own cue rather than the generic catch: it is the only
 * drop that gives back what the game takes, and the bank's longest and warmest
 * effect exists for exactly this moment.
 */
function apply(k) {
  snd.sfx(k === 4 ? KNOB.sfxLife : KNOB.sfxDrop, 2);
  if (k === 0) {
    var w = sys.peek(G_PADW) + KNOB.wideGrow;
    sys.poke(G_PADW, w > KNOB.paddleMaxW ? KNOB.paddleMaxW : w);
    sys.poke(G_WIDE, KNOB.powerFrames);
  } else if (k === 1) sys.poke(G_SLOW, KNOB.powerFrames);
  else if (k === 2) sys.poke(G_AMMO, sys.peek(G_AMMO) + KNOB.gunShots);
  else if (k === 3) split();
  else if (k === 4) sys.poke(G_LIVES, sys.peek(G_LIVES) + 1);
  else sys.poke(G_CATCH, KNOB.powerFrames);
}

/** Drops fall whatever the ball is doing; a RED ball does not stop them. */
function drops() {
  for (var i = 0; i < MD; i++) {
    var d = G_DROPS + i * 4;
    var k = sys.peek(d + 3);
    if (!k) continue;
    var y = r16(d + 1) + DROPV;
    w16(d + 1, y);
    y = y >> 4;
    if (y >= 128) {
      sys.poke(d + 3, 0);
      continue;
    }
    var px = r16(G_PADX) >> 4;
    var x = sys.peek(d);
    if (
      y + KNOB.dropH > KNOB.paddleY &&
      y < KNOB.paddleY + KNOB.paddleH &&
      x + KNOB.dropW > px &&
      x < px + sys.peek(G_PADW)
    ) {
      sys.poke(d + 3, 0);
      apply(k - 1);
    }
  }
}

// ============================================================================
// Timers, drift, and loading a level
// ============================================================================

function timers() {
  var w = sys.peek(G_WIDE);
  if (w) {
    sys.poke(G_WIDE, w - 1);
    if (w === 1) sys.poke(G_PADW, hd(H_PADW));
  }
  var s = sys.peek(G_SLOW);
  if (s) sys.poke(G_SLOW, s - 1);
  var c = sys.peek(G_CATCH);
  if (c) sys.poke(G_CATCH, c - 1);
  // Effects age here rather than in `draw`, so that drawing stays a pure
  // reading of RAM and a frame drawn twice is the same frame twice.
  for (var i = 0; i < MF; i++) {
    var a = G_FX + i * 3;
    var s = sys.peek(a + 2);
    if (s & 15) sys.poke(a + 2, s - 1);
  }
}

/** One shared offset slides every drifter row, out to `drift_range` and back. */
function driftStep() {
  var s = hd(H_DRIFT);
  if (!s || !mech(KNOB.mechDrift)) return;
  var d = r16(G_DRIFT) + (sys.peek(G_DDIR) ? -s : s);
  var lim = KNOB.driftRange * SUB;
  if (d > lim) {
    d = lim;
    sys.poke(G_DDIR, 1);
  }
  if (d < -lim) {
    d = -lim;
    sys.poke(G_DDIR, 0);
  }
  w16(G_DRIFT, d);
}

/**
 * Play the band this level belongs to, AND ONLY WHEN THE BAND CHANGES.
 *
 * A bank ships one short loop per band and gets FASTER as the game gets harder
 * -- that is the whole difficulty curve in the music -- so the engine holds
 * WHEN to change band and never what a band sounds like. Three pattern ids and
 * two level numbers are knobs for the same reason the `mech_*` numbers are: a
 * different bank numbers its patterns differently and a different pack has a
 * different curriculum.
 *
 * Restarting on every level would clip a two-bar loop three times in a row to
 * say something the level number in the HUD has already said. The band is what
 * changed, so the band is what restarts -- and G_BAND is RAM like everything
 * else, so a rewind puts the song back where the game is.
 */
function song() {
  var L = sys.peek(G_LEVEL) + 1;
  var b = L >= KNOB.musicLevelC ? 3 : L >= KNOB.musicLevelB ? 2 : 1;
  if (sys.peek(G_BAND) === b) return;
  sys.poke(G_BAND, b);
  snd.music(
    b === 1 ? KNOB.musicA : b === 2 ? KNOB.musicB : KNOB.musicC,
    KNOB.musicFade,
    KNOB.musicMask,
  );
}

/**
 * Read one level out of the DATA header and the MAP chunk. Nothing about a
 * level is generated, and nothing about it is hard-coded here.
 *
 * `level L -> column (L % map_band) * grid_w, row (L / map_band) * grid_h`, out
 * of FORMATS-breakout.md. A block byte becomes `type | hits << 4`, so one byte
 * carries what it is and how much of it is left.
 */
function loadLevel() {
  var L = sys.peek(G_LEVEL);
  var bx = (L % KNOB.mapBand) * GW;
  var by = ((L / KNOB.mapBand) | 0) * GH;
  var rows = 0;
  for (var r = 0; r < GH; r++) {
    for (var c = 0; c < GW; c++) {
      var t = sys.peek(A_MAP + (by + r) * 128 + bx + c) & 15;
      if (t === 7) rows |= 1 << r;
      sys.poke(G_BLOCKS + r * GW + c, t ? t | (hits(t) << 4) : 0);
    }
  }
  w16(G_ROWS, rows);
  sys.memset(G_BALLS, 0, G_BLOCKS - G_BALLS); // balls, drops and shots at once
  sys.memset(G_FX, 0, MF * 3); // and no spark outlives the level it happened on
  sys.poke(G_PADW, hd(H_PADW));
  w16(G_PADX, (64 - (hd(H_PADW) >> 1)) * SUB);
  sys.poke(G_AMMO, hd(H_AMMO));
  sys.poke(G_WIDE, 0);
  sys.poke(G_SLOW, 0);
  sys.poke(G_CATCH, 0);
  sys.poke(G_PADT, 0);
  sys.poke(G_DDIR, 0);
  w16(G_DRIFT, 0);
  spawnBall();
  // Every level starts here, boot's included, so this is the one call site the
  // song needs: it begins under level one's serve and changes band from level
  // to level. A life lost and a game over are both left alone -- see the note
  // at the top of this file.
  song();
}

// ============================================================================
// Drawing
// ============================================================================

/**
 * A block's colour.
 *
 * Types 2 and 3 both take more than one hit, and they get DIFFERENT colours.
 * Sharing one would leave a player unable to tell a two-hit block from a
 * three-hit block until they had spent a ball finding out, which turns a wall
 * of mixed blocks into a wall of one colour with an invisible hard core -- the
 * player cannot plan a route through something they cannot see the shape of.
 *
 * Damage is shown by falling back to `colorDamaged` once a block has taken a
 * hit but is still standing, which is what `h < t` means for exactly these two.
 * A damaged three-hit block therefore reads as "hit, still there" rather than
 * as a two-hit block, because the full-health colours differ.
 */
function color(t, h) {
  if (t === 2 || t === 3) {
    return h < t ? KNOB.colorDamaged : t === 2 ? KNOB.colorTough : KNOB.colorHard;
  }
  return t === 1
    ? KNOB.colorPlain
    : t === 4
      ? KNOB.colorRed
      : t === 5
        ? KNOB.colorSolid
        : t === 6
          ? KNOB.colorShield
          : t === 7
            ? KNOB.colorDrift
            : KNOB.colorPrize;
}

/**
 * The sheet cell for a block of type `t` with `h` hits left, out of the table
 * in FORMATS-breakout-art.md. It mirrors `color` above, damage state and all:
 * `h < t` is what "hit and still standing" means for exactly types 2 and 3, and
 * the art gives that state a cell of its own instead of a second colour.
 *
 * The red block is the one that animates on its own, because it is the only
 * warning the player gets and it has to be alarming before anyone has hit one.
 */
function cell(t, h) {
  if (t === 2) return h < 2 ? 2 : 1;
  if (t === 3) return h < 2 ? 5 : h < 3 ? 4 : 3;
  if (t === 4) return 6 + anim(0, KNOB.redFlash);
  return t === 1 ? 0 : t === 5 ? 8 : t === 6 ? 9 : t === 7 ? 11 : 12;
}

/** The top BW x BH of cell `n`: a block is 8 x 6 and a sheet cell is 8 x 8. */
function blk(n, x, y) {
  gfx.sspr((n & 15) * 8, (n >> 4) * 8, BW, BH, x, y);
}

/**
 * A whole cell centred on a `w` x `h` box. The ball is three pixels and its
 * cell is eight, so drawing at the box's corner would hang the ball down and
 * right of the thing that is actually colliding.
 */
function sprc(n, x, y, w, h) {
  gfx.spr(n, x + (w >> 1) - 4, y + (h >> 1) - 4);
}

/**
 * Left cap, middle tiled to whatever width the paddle is, right cap. `n` is 16
 * for the bare paddle and 19 for the gun, so THE PADDLE VISIBLY CHANGES WHEN IT
 * CAN SHOOT and the player never has to read the ammunition counter to know.
 *
 * The right cap is drawn last, so the final middle tile's overhang is covered
 * rather than clipped.
 */
function pad(x, w, n) {
  gfx.spr(SB + n, x, KNOB.paddleY);
  for (var i = 8; i < w - 8; i += 8) gfx.spr(SB + n + 1, x + i, KNOB.paddleY);
  gfx.spr(SB + n + 2, x + w - 8, KNOB.paddleY);
}

/** Every live effect. `l` counts down as one ages, so its cell counts up. */
function fxDraw() {
  for (var i = 0; i < MF; i++) {
    var a = G_FX + i * 3;
    var s = sys.peek(a + 2);
    var l = s & 15;
    if (!l) continue;
    var f = ((l - 1) / KNOB.fxFrames) | 0;
    var k = s >> 4;
    var x = sys.peek(a);
    var y = sys.peek(a + 1);
    // A spark is stored at the BALL's corner and drawn centred on it, the way
    // the ball itself is, so the two sit on top of each other.
    if (k === 1) sprc(SB + 54 - f, x, y, BS, BS);
    else if (k === 2) blk(SB + 10, x, y);
    else blk(SB + 15 - f, x, y);
  }
}

function draw() {
  var i;
  var sp = sys.peek(G_ART); // which of the two paths this cart is drawing on
  var dead = sys.peek(G_DEAD);
  gfx.camera(0, 0);
  gfx.cls(KNOB.bgColor);

  for (var r = 0; r < GH; r++) {
    var ox = drift(r);
    for (var c = 0; c < GW; c++) {
      var v = sys.peek(G_BLOCKS + r * GW + c);
      if (v) {
        var vx = c * BW + ox;
        var vy = TOP + r * BH;
        if (sp) blk(SB + cell(v & 15, v >> 4), vx, vy);
        else gfx.rect(vx, vy, BW - 1, BH - 1, color(v & 15, v >> 4), true);
      }
    }
  }

  if (hd(H_PADS) && mech(KNOB.mechPads)) {
    // A pad lights the frame it charges a shot, which is the only feedback that
    // says the touch counted -- G_PADT is exactly "which pad is being touched".
    var t = sys.peek(G_PADT);
    if (sp) {
      gfx.spr(SB + 28 + (t & 1), 0, KNOB.paddleY);
      gfx.spr(SB + 28 + ((t >> 1) & 1), 128 - 8, KNOB.paddleY);
    } else {
      gfx.rect(0, KNOB.paddleY, KNOB.padZone, KNOB.paddleH, KNOB.padColor, true);
      gfx.rect(128 - KNOB.padZone, KNOB.paddleY, KNOB.padZone, KNOB.paddleH, KNOB.padColor, true);
    }
  }

  var pw = sys.peek(G_PADW);
  var px = r16(G_PADX) >> 4;
  if (dead) {
    // Four frames of a paddle coming apart, across its own width. On the
    // rectangle path there is nothing to draw and the paddle is simply gone,
    // which reads as what happened.
    if (sp) {
      var df = 3 - (((dead - 1) / KNOB.fxFrames) | 0);
      for (i = 0; i < pw; i += 8) gfx.spr(SB + 48 + df, px + i, KNOB.paddleY);
    }
  } else if (sp) pad(px, pw, sys.peek(G_AMMO) ? 19 : 16);
  else gfx.rect(px, KNOB.paddleY, pw, KNOB.paddleH, KNOB.paddleColor, true);

  for (i = 0; i < MD; i++) {
    var d = G_DROPS + i * 4;
    var k = sys.peek(d + 3);
    // `drop_color` is the first of six consecutive live slots, one per kind, so
    // a player can learn what is falling without the engine holding six knobs.
    // The sheet says the same thing in two frames each, tumbling as they fall.
    if (k) {
      var dy = r16(d + 1) >> 4;
      if (sp) sprc(SB + 30 + k * 2 + anim(0, KNOB.dropSpin), sys.peek(d), dy, KNOB.dropW, KNOB.dropH);
      else gfx.rect(sys.peek(d), dy, KNOB.dropW, KNOB.dropH, KNOB.dropColor + k - 1, true);
    }
  }

  for (i = 0; i < MS; i++) {
    var s = G_SHOTS + i * 3;
    if (sys.peek(s + 2)) {
      if (sp) sprc(SB + 27, sys.peek(s), sys.peek(s + 1), KNOB.shotW, KNOB.shotH);
      else gfx.rect(sys.peek(s), sys.peek(s + 1), KNOB.shotW, KNOB.shotH, KNOB.shotColor, true);
    }
  }

  for (i = 0; i < MB; i++) {
    var b = ball(i);
    var f = sys.peek(b + B_F);
    if (f & 1) {
      var bx = r16(b + B_X) >> 4;
      var by = r16(b + B_Y) >> 4;
      // A RED ball alternates two frames fast, because the player has under a
      // second to notice it and a still picture is not a warning.
      if (sp) sprc(SB + (f & 2 ? 23 + anim(0, KNOB.redFlash) : 22), bx, by, BS, BS);
      else gfx.rect(bx, by, BS, BS, f & 2 ? KNOB.ballRedColor : KNOB.ballColor, true);
    }
  }

  if (sp) fxDraw();

  // The beam exists only while a ball is RED. It is drawn last of the field so
  // it reads as an alarm, and it is the only thing under the paddle. Its two
  // segments alternate ALONG the row and step every `beam_flow` frames, so it
  // scrolls and reads as live rather than painted.
  if (anyRed()) {
    if (sp) for (i = 0; i < 128; i += 8) gfx.spr(SB + 25 + anim(i >> 3, KNOB.beamFlow), i, KNOB.beamY);
    else gfx.rect(0, KNOB.beamY, 128, KNOB.beamH, KNOB.beamColor, true);
  }

  if (gfx.print) {
    gfx.print(
      "L" + (sys.peek(G_LEVEL) + 1) + " O" + sys.peek(G_LIVES) + " A" + sys.peek(G_AMMO),
      2,
      KNOB.hudY,
      KNOB.hudColor,
    );
  }
}

// ============================================================================
// The two entry points
// ============================================================================

function boot() {
  sys.memset(S, 0, G_END - S);
  sys.poke(G_LIVES, KNOB.lives);
  // The sheet is installed before this runs and never changes after, so which
  // of the two draw paths this cart is on is decided once, here.
  sys.poke(G_ART, art());
  loadLevel();
}

function tick() {
  if (sys.peek(G_STATE)) {
    if (inp.btnp(BTN_A)) boot();
    draw();
    return;
  }
  // The beat after a red ball takes the paddle. The life is already gone; what
  // this holds is the moment. Nothing simulates, so the serve cannot be
  // launched out from under the animation and the paddle cannot slide away.
  var dead = sys.peek(G_DEAD);
  if (dead) {
    sys.poke(G_DEAD, dead - 1);
    draw();
    return;
  }
  paddle();
  timers();
  driftStep();
  balls();
  drops();
  shots();
  if (cleared()) {
    var L = sys.peek(G_LEVEL) + 1;
    // Before the branch, so the LAST level cleared sounds like a level cleared
    // and winning the game is not the one clear the player never hears.
    snd.sfx(KNOB.sfxClear, 3);
    if (L >= KNOB.levelCount) sys.poke(G_STATE, 2);
    else {
      sys.poke(G_LEVEL, L);
      loadLevel();
    }
  }
  draw();
}
