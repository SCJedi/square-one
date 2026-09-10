// The `platformer` engine: a side-scrolling platformer core, as a Square One
// cart body.
//
// This file is CART SOURCE. It is not compiled, not bundled and not typed --
// the stamper writes a preamble above it and the result is the .cart's CODE
// chunk, readable forever by anyone who plays the game.
//
// WHAT THE STAMPER PUTS ABOVE THIS FILE
// -------------------------------------
// One declaration, and nothing else:
//
//     const KNOB = { gravity: 27524 / 65536, jumpVelocity: -203161 / 65536, ... };
//
// KNOB is every knob this file names, snake_case in module.toml becoming
// camelCase here. A `fixed` knob arrives as an exact power-of-two division, so
// it is the same double on every engine; `int` and `bool` arrive as themselves.
//
// WHERE THE ART COMES FROM
// ------------------------
// It is already in RAM. The player installs a cart's `PAL `, `GFX ` and `MAP `
// chunks between zeroing RAM and calling this file's `boot()` (specification
// 3.3), so the sprite sheet is at 0x2200, the sprite flags at 0x4200 and the
// live palette at 0x20C0 before the first line of `boot` runs. There is nothing
// to decode and nothing to install: `solid()` reads a flag byte on the frame the
// level is generated because the flag byte is simply there.
//
// This file used to carry the sheet as a hex string in its own preamble and
// unpack it in `boot`. That cost two cart bytes per data byte and a decoder in
// every engine, to reach a region the machine initializes for free.
//
// WHERE STATE LIVES
// -----------------
// In RAM. Every entity, the camera, the death timer and the score are bytes in
// USER_RAM, read and written through sys.peek and sys.poke. The module-level
// `var`s below are of two kinds and NEITHER is machine state:
//
//   - address and field constants, which are literals;
//   - values derived from KNOB alone (GRAV, MAXRUN, ...), computed once because
//     KNOB is frozen at stamp time and cannot change while the cart runs.
//
// Nothing else is kept outside RAM, which is what makes `snapshot()` complete:
// restore RAM to frame N and the next frame is byte-identical to the one that
// followed frame N the first time. The engine test asserts exactly that.
//
// THE COORDINATE SYSTEM
// ---------------------
// Positions and velocities are in SUBPIXELS, 256 to the pixel, stored as signed
// 32-bit little-endian in RAM. Integers only: `>> 8` converts to pixels and
// floors correctly for negative values, which is what a collision routine wants
// at the left edge of the world. The map is 1024 pixels wide at most, so a
// position is at most 262144 -- comfortably inside int32.

// --- the machine's own addresses -------------------------------------------
var SUB = 256;
var TILE = 8;
// SPRITES (0x2200) and PALETTE_LIVE (0x20C0) are not named here, because this
// engine never touches them: the player fills both from the cart's chunks
// before `boot`, and `gfx.spr` and `present` read them without being told.
var A_FLAGS = 0x4200;
var A_MAP = 0x4300;
var A_USER = 0x7800;
var MAP_STRIDE = 128;

// --- this cart's own RAM ----------------------------------------------------
var G_DEAD = A_USER + 0; // frames left in the death animation, 0 when alive
var G_DEATHS = A_USER + 1; // deaths this run, for the HUD
var G_GEMS = A_USER + 2; // gems collected
var G_CAMX = A_USER + 4; // camera, in subpixels, i32
var G_CAMY = A_USER + 8;
var E_BASE = A_USER + 16; // the entity pool starts here

// One entity is 20 bytes. Entity 0 is always the player.
var E_SIZE = 20;
var E_X = 0;
var E_Y = 4;
var E_VX = 8;
var E_VY = 12;
var E_KIND = 16; // 0 free, 1 player, 2 crawler, 3 gem
var E_FLG = 17; // bit 1: facing left
var E_COY = 18; // coyote frames left  (player only)
var E_BUF = 19; // jump-buffer frames left (player only)
var F_FACE = 2;

var BTN_L = 2;
var BTN_R = 3;
var BTN_A = 4;

// --- constants derived from the knobs ---------------------------------------
// Computed once at cart top level. KNOB is fixed at stamp time, so these are
// literals that happen to be spelled as arithmetic: re-deriving them every
// frame would cost tokens and change nothing.
var GRAV = (KNOB.gravity * SUB) | 0;
var MAXFALL = (KNOB.maxFallSpeed * SUB) | 0;
var RUNACC = (KNOB.runAccel * SUB) | 0;
var AIRACC = (KNOB.airAccel * SUB) | 0;
var MAXRUN = (KNOB.maxRunSpeed * SUB) | 0;
var JUMPV = (KNOB.jumpVelocity * SUB) | 0;
var POP = (KNOB.deathPop * SUB) | 0;
var CRAWLV = (KNOB.crawlerSpeed * SUB) | 0;
var IDLEV = (KNOB.idleSpeed * SUB) | 0;
var PW = KNOB.playerWidth;
var PH = KNOB.playerHeight;
var CW = KNOB.crawlerWidth;
var CH = KNOB.crawlerHeight;
var MW = KNOB.mapWidth;
var MH = KNOB.mapHeight;

// ============================================================================
// RAM helpers
// ============================================================================

/** Signed 32-bit little-endian read. The `<< 24` sign-extends for free. */
function r32(a) {
  return (sys.peek(a) | (sys.peek(a + 1) << 8) | (sys.peek(a + 2) << 16) | (sys.peek(a + 3) << 24)) | 0;
}

function w32(a, v) {
  sys.poke(a, v);
  sys.poke(a + 1, v >> 8);
  sys.poke(a + 2, v >> 16);
  sys.poke(a + 3, v >> 24);
}

/** The base address of entity `i`. */
function ent(i) {
  return E_BASE + i * E_SIZE;
}

// ============================================================================
// The map
// ============================================================================

/**
 * A 32-bit integer hash -- Thomas Wang's, written with `| 0` after every step.
 *
 * The level is a pure function of (level_seed, column), so it is the same level
 * on every machine and needs no data in the cart. It must not be `sys.rnd`:
 * that generator is seeded per RUN and advances with every call, so a level
 * built from it would differ between two plays and would move under a rewind.
 */
function hash(a) {
  a = (a + 0x7ed55d16 + (a << 12)) | 0;
  a = (a ^ 0xc761c23c ^ (a >>> 19)) | 0;
  a = (a + 0x165667b1 + (a << 5)) | 0;
  a = (a ^ 0xd3a2646c ^ (a << 9)) | 0;
  a = (a + 0xfd7046c5 + (a << 3)) | 0;
  a = (a ^ 0xb55a4f09 ^ (a >>> 16)) | 0;
  return a >>> 0;
}

function tileAt(tx, ty) {
  return sys.peek(A_MAP + ty * MAP_STRIDE + tx);
}

function setTile(tx, ty, t) {
  if (tx >= 0 && tx < MW && ty >= 0 && ty < MH) sys.poke(A_MAP + ty * MAP_STRIDE + tx, t);
}

/**
 * Is the tile at (tx, ty) solid?
 *
 * Outside the map horizontally or above it, the answer is `edge_solid` -- an
 * invisible wall at the ends of the level, which is what stops a runner walking
 * off into blank space. BELOW the map is never solid: falling out of the world
 * has to be possible, because that is what makes a pit a pit.
 */
function solid(tx, ty) {
  if (tx < 0 || tx >= MW || ty < 0) return KNOB.edgeSolid;
  if (ty >= MH) return false;
  return (sys.peek(A_FLAGS + tileAt(tx, ty)) & KNOB.solidFlag) !== 0;
}

function hazard(tx, ty) {
  if (tx < 0 || tx >= MW || ty < 0 || ty >= MH) return false;
  return (sys.peek(A_FLAGS + tileAt(tx, ty)) & KNOB.hazardFlag) !== 0;
}

/**
 * Build the level.
 *
 * Terrain is decided per FOUR-COLUMN CHUNK, so ground height, pits and ledges
 * come in pieces a runner can land on rather than one-column noise.
 *
 * THE FIRST TWO CHUNKS ARE EMPTY of everything except floor: no pit, no step in
 * the ground, no spike and no ledge. A level that can kill you before you have
 * pressed anything is not a level, and a ledge generated across the spawn point
 * puts the player inside a solid tile on frame one -- which is a fine way to
 * find out whether the collision code is robust and a terrible way to open a
 * game.
 */
function generate() {
  var seed = KNOB.levelSeed;
  var next = 1; // entity 0 is the player; the pool fills from 1
  sys.memset(A_MAP, 0, 8192);

  for (var tx = 0; tx < MW; tx++) {
    var c = tx >> 2;
    var h = hash((seed ^ (c * 7919)) | 0);
    var ground = KNOB.groundRow + (h % KNOB.groundVary);
    var roof = KNOB.ceilingRows + ((h >>> 16) % 2);
    var pit = c > 1 && (h >>> 8) % 100 < KNOB.pitChance;
    if (c < 2) ground = KNOB.groundRow;

    for (var ty = 0; ty < MH; ty++) {
      var t = KNOB.tileBg;
      if (ty < roof) t = ty === roof - 1 ? KNOB.tileCeiling : KNOB.tileRock;
      else if (pit) {
        if (ty >= MH - 2) t = KNOB.tileLava;
      } else if (ty === ground) t = KNOB.tileRockTop;
      else if (ty > ground) t = ty > ground + 2 ? KNOB.tileDirt : KNOB.tileRock;
      sys.poke(A_MAP + ty * MAP_STRIDE + tx, t);
    }

    // A spike patch, one column wide, on the third column of a chunk.
    if (c > 1 && !pit && (tx & 3) === 2 && (h >>> 20) % 100 < KNOB.spikeChance) {
      setTile(tx, ground - 1, KNOB.tileSpike);
    }

    // A floating ledge, three columns wide, drawn with its end caps so it reads
    // as a ledge rather than as three loose blocks.
    if (c > 1 && (h >>> 12) % 100 < KNOB.platformChance && (tx & 3) < 3) {
      var ly = ground - KNOB.platformHeight - ((h >>> 24) % 3);
      // A ledge is placed above ITS OWN chunk's floor, and the floor next door
      // may be six rows higher. Without this clamp a ledge over a deep chunk
      // lands at chest height beside a shallow one, which reads as an invisible
      // wall you cannot walk past and cannot see the reason for. The ceiling of
      // the whole level -- platform_height above the BASE ground row -- is the
      // highest a ledge is ever allowed to sit low.
      var top = KNOB.groundRow - KNOB.platformHeight;
      if (ly > top) ly = top;
      var lt = (tx & 3) === 0 ? KNOB.tilePlatformL : (tx & 3) === 2 ? KNOB.tilePlatformR : KNOB.tilePlatform;
      if (ly > roof + 1) setTile(tx, ly, lt);
    }

    // One spawn roll per chunk, on its second column. Chunks 0 and 1 are the
    // opening and stay empty: a crawler standing where the player lands is a
    // death before the first input.
    if (c > 1 && !pit && (tx & 3) === 1) {
      if ((h >>> 5) % 100 < KNOB.crawlerChance) next = spawn(next, 2, tx, ground - 1);
      if ((h >>> 17) % 100 < KNOB.gemChance) next = spawn(next, 3, tx + 1, ground - 3);
    }
  }
}

/** Put entity `kind` in the first free slot at tile (tx, ty). Returns the next slot. */
function spawn(i, kind, tx, ty) {
  if (i >= KNOB.entities) return i;
  var e = ent(i);
  w32(e + E_X, tx * TILE * SUB);
  w32(e + E_Y, ty * TILE * SUB);
  w32(e + E_VX, 0);
  w32(e + E_VY, 0);
  sys.poke(e + E_KIND, kind);
  sys.poke(e + E_FLG, 0);
  return i + 1;
}

// ============================================================================
// Movement
// ============================================================================

/**
 * Move one entity along X, then stop it against the first solid tile it meets.
 *
 * X AND Y ARE RESOLVED SEPARATELY, and that is not an optimisation. Resolving a
 * diagonal move in one step has to choose which axis to push out of, and the
 * choice is wrong often enough that a body running along a flat floor catches on
 * the seam between two floor tiles. Moving X against the OLD Y and then Y
 * against the NEW X has no such choice to make.
 *
 * A RESOLUTION NEVER MOVES A BODY BACKWARDS. If a body is somehow already
 * inside a wall -- spawned there, or dropped there by a level edited at run
 * time -- then the tile its leading edge is in is the tile it is standing in,
 * and snapping to that tile's far face throws it a whole body-width AWAY from
 * the wall. Next frame it does it again from further out, and a body that
 * started one tile inside a wall ends up hundreds of pixels outside the map.
 * Clamping the result against the position before the step turns that runaway
 * into the only sensible answer: a body in a wall cannot move, and stays where
 * it is until something frees it.
 */
function moveX(e, w, h) {
  var vx = r32(e + E_VX);
  if (vx === 0) return;
  var was = r32(e + E_X);
  var x = was + vx;
  var py = r32(e + E_Y) >> 8;
  var px = x >> 8;
  var t0 = py >> 3;
  var t1 = (py + h - 1) >> 3;
  var tx = vx > 0 ? (px + w - 1) >> 3 : px >> 3;
  for (var ty = t0; ty <= t1; ty++) {
    if (solid(tx, ty)) {
      x = (vx > 0 ? tx * TILE - w : tx * TILE + TILE) * SUB;
      if (vx > 0 ? x < was : x > was) x = was;
      vx = 0;
      break;
    }
  }
  w32(e + E_X, x);
  w32(e + E_VX, vx);
}

function moveY(e, w, h) {
  var vy = r32(e + E_VY);
  if (vy === 0) return;
  var was = r32(e + E_Y);
  var y = was + vy;
  var px = r32(e + E_X) >> 8;
  var py = y >> 8;
  var t0 = px >> 3;
  var t1 = (px + w - 1) >> 3;
  var ty = vy > 0 ? (py + h - 1) >> 3 : py >> 3;
  for (var tx = t0; tx <= t1; tx++) {
    if (solid(tx, ty)) {
      y = (vy > 0 ? ty * TILE - h : ty * TILE + TILE) * SUB;
      if (vy > 0 ? y < was : y > was) y = was;
      vy = 0;
      break;
    }
  }
  w32(e + E_Y, y);
  w32(e + E_VY, vy);
}

/**
 * Is there solid ground directly under this body?
 *
 * The probe, not the collision, is what "grounded" means here. A body standing
 * still still has gravity added every frame, and most frames that is not enough
 * subpixels to push it into the floor tile -- so a flag set by the landing
 * collision would flicker off between landings and take coyote time, the jump
 * and the run animation with it. The probe reads the tile row immediately below
 * the body's bottom pixel and is stable for as long as the body rests there.
 */
function grounded(e, w, h) {
  var px = r32(e + E_X) >> 8;
  var ty = ((r32(e + E_Y) >> 8) + h) >> 3;
  for (var tx = px >> 3; tx <= (px + w - 1) >> 3; tx++) {
    if (solid(tx, ty)) return true;
  }
  return false;
}

/** Does this body overlap a hazard tile? */
function inHazard(e, w, h) {
  var px = r32(e + E_X) >> 8;
  var py = r32(e + E_Y) >> 8;
  for (var ty = py >> 3; ty <= (py + h - 1) >> 3; ty++) {
    for (var tx = px >> 3; tx <= (px + w - 1) >> 3; tx++) {
      if (hazard(tx, ty)) return true;
    }
  }
  return false;
}

/** Axis-aligned overlap of two entities, in pixels. */
function touching(a, aw, ah, b, bw, bh) {
  var ax = r32(a + E_X) >> 8;
  var ay = r32(a + E_Y) >> 8;
  var bx = r32(b + E_X) >> 8;
  var by = r32(b + E_Y) >> 8;
  return ax < bx + bw && bx < ax + aw && ay < by + bh && by < ay + ah;
}

// ============================================================================
// The player
// ============================================================================

function respawn() {
  var e = ent(0);
  w32(e + E_X, KNOB.startTileX * TILE * SUB);
  w32(e + E_Y, KNOB.startTileY * TILE * SUB);
  w32(e + E_VX, 0);
  w32(e + E_VY, 0);
  sys.poke(e + E_KIND, 1);
  sys.poke(e + E_FLG, 0);
  sys.poke(e + E_COY, 0);
  sys.poke(e + E_BUF, 0);
  sys.poke(G_DEAD, 0);
  camera(true);
}

/**
 * One frame of the player.
 *
 * COYOTE TIME and the JUMP BUFFER are the two counters that separate a
 * platformer that works from one that feels right, and they are symmetrical:
 * coyote time forgives a jump pressed slightly LATE (you already walked off the
 * ledge), the buffer forgives one pressed slightly EARLY (you are still a few
 * frames above the floor). Both are frame counts in RAM, so both survive a
 * rewind. A jump happens when both are non-zero, and consumes both.
 */
function player() {
  var e = ent(0);
  var dead = sys.peek(G_DEAD);
  var vx = r32(e + E_VX);
  var vy = r32(e + E_VY);
  var flg = sys.peek(e + E_FLG);
  var ground = grounded(e, PW, PH);

  if (dead === 0) {
    var dir = (inp.btn(BTN_R) ? 1 : 0) - (inp.btn(BTN_L) ? 1 : 0);
    if (dir !== 0) {
      vx = vx + dir * (ground ? RUNACC : AIRACC);
      if (vx > MAXRUN) vx = MAXRUN;
      if (vx < -MAXRUN) vx = -MAXRUN;
      flg = dir < 0 ? flg | F_FACE : flg & ~F_FACE;
    } else {
      vx = (vx * (ground ? KNOB.groundFriction : KNOB.airFriction)) | 0;
    }

    var coy = sys.peek(e + E_COY);
    var buf = sys.peek(e + E_BUF);
    coy = ground ? KNOB.coyoteFrames : coy > 0 ? coy - 1 : 0;
    buf = inp.btnp(BTN_A) ? KNOB.jumpBufferFrames : buf > 0 ? buf - 1 : 0;
    if (buf > 0 && coy > 0) {
      vy = JUMPV;
      coy = 0;
      buf = 0;
      ground = false;
      snd.sfx(KNOB.sfxJump, 0);
    }
    sys.poke(e + E_COY, coy);
    sys.poke(e + E_BUF, buf);

    // Let go of A on the way up and the rise is cut short. One line, and it is
    // the difference between a jump with one height and a jump with a range.
    if (vy < 0 && !inp.btn(BTN_A)) vy = (vy * KNOB.jumpCut) | 0;
  } else {
    vx = (vx * KNOB.airFriction) | 0;
  }

  vy = vy + GRAV;
  if (vy > MAXFALL) vy = MAXFALL;

  w32(e + E_VX, vx);
  w32(e + E_VY, vy);
  sys.poke(e + E_FLG, flg);
  moveX(e, PW, PH);
  moveY(e, PW, PH);

  if (dead > 0) {
    sys.poke(G_DEAD, dead - 1);
    if (dead === 1) respawn();
    return;
  }

  // Death: a hazard tile, a crawler, or the bottom of the world.
  var kill = inHazard(e, PW, PH) || (r32(e + E_Y) >> 8) > MH * TILE;
  for (var i = 1; i < KNOB.entities && !kill; i++) {
    var o = ent(i);
    if (sys.peek(o + E_KIND) === 2 && touching(e, PW, PH, o, CW, CH)) kill = true;
  }
  if (kill) {
    sys.poke(G_DEAD, KNOB.deathFrames);
    sys.poke(G_DEATHS, sys.peek(G_DEATHS) + 1);
    w32(e + E_VY, POP);
    snd.sfx(KNOB.sfxHurt, 1);
  }
}

// ============================================================================
// The pool
// ============================================================================

/**
 * Crawlers walk, fall, and turn around at a wall or at the edge of a drop. They
 * run through the same moveX/moveY as the player, which is the point of having
 * an entity model at all: one integrator, one collision routine, one place a
 * physics bug can be.
 */
function pool() {
  var p = ent(0);
  var alive = sys.peek(G_DEAD) === 0;
  for (var i = 1; i < KNOB.entities; i++) {
    var e = ent(i);
    var kind = sys.peek(e + E_KIND);

    if (kind === 2) {
      var flg = sys.peek(e + E_FLG);
      var dir = (flg & F_FACE) !== 0 ? -1 : 1;
      var vy = r32(e + E_VY) + GRAV;
      w32(e + E_VX, dir * CRAWLV);
      w32(e + E_VY, vy > MAXFALL ? MAXFALL : vy);
      moveX(e, CW, CH);
      moveY(e, CW, CH);
      // Blocked, or about to step off a ledge: turn around.
      var px = r32(e + E_X) >> 8;
      var ahead = (dir > 0 ? px + CW : px - 1) >> 3;
      var below = ((r32(e + E_Y) >> 8) + CH) >> 3;
      if (r32(e + E_VX) === 0 || !solid(ahead, below)) sys.poke(e + E_FLG, flg ^ F_FACE);
    } else if (kind === 3 && alive && touching(p, PW, PH, e, TILE, TILE)) {
      sys.poke(e + E_KIND, 0);
      sys.poke(G_GEMS, sys.peek(G_GEMS) + 1);
      snd.sfx(KNOB.sfxGem, 2);
    }
  }
}

// ============================================================================
// The camera
// ============================================================================

/**
 * Move `cur` a `camera_smooth` fraction of the way toward `to`, and ARRIVE.
 *
 * The `| 0` truncates toward zero, so once the gap is small enough that a
 * quarter of it rounds to nothing, a plain lerp stops -- up to three subpixels
 * short, which is a whole pixel of framing error that never goes away and looks
 * like the camera being slightly wrong about where the player is. Stepping one
 * subpixel when the fraction underflows costs one branch and converges exactly.
 */
function approach(cur, to) {
  var d = ((to - cur) * KNOB.cameraSmooth) | 0;
  if (d === 0) d = to > cur ? 1 : to < cur ? -1 : 0;
  return cur + d;
}

/**
 * Follow the player, look ahead in the direction they face, and CLAMP TO THE
 * MAP so the world never shows its edge. `snap` puts the camera on its target
 * at once, which is what a respawn wants; otherwise it eases in.
 *
 * A map narrower than the screen has a negative maximum, so the limits are
 * clamped at zero before they are used -- otherwise the low bound would be
 * above the high one and the camera would sit wherever the last comparison left
 * it.
 */
function camera(snap) {
  var e = ent(0);
  var look = (sys.peek(e + E_FLG) & F_FACE) !== 0 ? -KNOB.cameraLookahead : KNOB.cameraLookahead;
  var tx = ((r32(e + E_X) >> 8) + (PW >> 1) - 64 + look) * SUB;
  var ty = ((r32(e + E_Y) >> 8) + (PH >> 1) - 64 + KNOB.cameraOffsetY) * SUB;
  var cx = snap ? tx : approach(r32(G_CAMX), tx);
  var cy = snap ? ty : approach(r32(G_CAMY), ty);
  var hx = (MW * TILE - 128) * SUB;
  var hy = (MH * TILE - 128) * SUB;
  if (hx < 0) hx = 0;
  if (hy < 0) hy = 0;
  if (cx < 0) cx = 0;
  if (cx > hx) cx = hx;
  if (cy < 0) cy = 0;
  if (cy > hy) cy = hy;
  w32(G_CAMX, cx);
  w32(G_CAMY, cy);
}

// ============================================================================
// Drawing
// ============================================================================

/** Which frame of the runner to show, from the state it is already in. */
function playerSprite(e, ground, vy) {
  var f = sys.frame();
  if (sys.peek(G_DEAD) > 0) return KNOB.spriteHurt;
  if (!ground) return vy < 0 ? KNOB.spriteJump : KNOB.spriteFall;
  var vx = r32(e + E_VX);
  if (vx > IDLEV || vx < -IDLEV) {
    return KNOB.spriteRun + ((f >> KNOB.runFrameShift) % KNOB.spriteRunFrames);
  }
  return KNOB.spriteIdle + ((f >> KNOB.idleFrameShift) & 1);
}

function draw() {
  var e = ent(0);
  var camx = r32(G_CAMX) >> 8;
  var camy = r32(G_CAMY) >> 8;

  gfx.camera(0, 0);
  gfx.cls(KNOB.bgColor);

  // The map is drawn from the first visible cell, 18 x 18 cells -- sixteen to
  // fill the screen plus one on each side for the partial cells at the edges.
  gfx.camera(camx, camy);
  var mx = camx >> 3;
  var my = camy >> 3;
  gfx.map(mx, my, mx * TILE, my * TILE, 18, 18, KNOB.drawLayer);

  for (var i = 1; i < KNOB.entities; i++) {
    var o = ent(i);
    var kind = sys.peek(o + E_KIND);
    if (kind === 2) {
      gfx.spr(
        KNOB.spriteCrawler + ((sys.frame() >> KNOB.crawlerFrameShift) & 1),
        r32(o + E_X) >> 8,
        r32(o + E_Y) >> 8,
        1,
        1,
        (sys.peek(o + E_FLG) & F_FACE) !== 0,
        false,
      );
    } else if (kind === 3) {
      gfx.spr(KNOB.spriteGem, r32(o + E_X) >> 8, (r32(o + E_Y) >> 8) + (sys.sin(sys.frame() * 8) >> 14), 1, 1);
    }
  }

  var ground = grounded(e, PW, PH);
  gfx.spr(
    playerSprite(e, ground, r32(e + E_VY)),
    (r32(e + E_X) >> 8) + KNOB.spriteOffsetX,
    (r32(e + E_Y) >> 8) + KNOB.spriteOffsetY,
    KNOB.spriteCellsW,
    KNOB.spriteCellsH,
    (sys.peek(e + E_FLG) & F_FACE) !== 0,
    false,
  );

  // The HUD is screen space, so the camera goes back to the origin first.
  gfx.camera(0, 0);
  if (gfx.print) {
    gfx.print("GEM " + sys.peek(G_GEMS), 2, 2, KNOB.hudColor);
    gfx.print("X " + sys.peek(G_DEATHS), 100, 2, KNOB.hudColor);
  }
}

// ============================================================================
// The two entry points
// ============================================================================

function boot() {
  sys.memset(A_USER, 0, 16 + KNOB.entities * E_SIZE);
  generate();
  respawn();
}

function tick() {
  player();
  pool();
  camera(false);
  draw();
}
