// The `topdown` engine: a top-down action-adventure core, as a Square One cart
// body.
//
// This file is CART SOURCE. It is not compiled, not bundled and not typed -- the
// stamper writes a preamble above it and the result is the .cart's CODE chunk,
// readable forever by anyone who plays the game.
//
// WHAT THE STAMPER PUTS ABOVE THIS FILE
// -------------------------------------
// One declaration, and nothing else:
//
//     const KNOB = { moveSpeed: 59578 / 65536, attackFrames: 12, ... };
//
// KNOB is every knob module.toml names, snake_case there becoming camelCase
// here. A `fixed` knob arrives as an exact power-of-two division, so it is the
// same double on every engine; `int` and `bool` arrive as themselves.
//
// WHERE THE ART COMES FROM
// ------------------------
// It is already in RAM. The player installs a cart's `PAL `, `GFX ` and `MAP `
// chunks between zeroing and calling this file's `boot()` (specification 3.3),
// so the sprite sheet is at 0x2200, the sprite flags at 0x4200 and the live
// palette at 0x20C0 before the first line of `boot` runs. There is nothing to
// decode and nothing to install.
//
// WHERE STATE LIVES
// -----------------
// In RAM. Every entity, the camera, the facing, the swing timer, the health and
// the keys are bytes in USER_RAM, read and written through sys.peek and
// sys.poke. The module-level `var`s below are of two kinds and NEITHER is
// machine state:
//
//   - address and field constants, which are literals;
//   - values derived from KNOB alone (MOVEV, DIAGV, ...), computed once because
//     KNOB is frozen at stamp time and cannot change while the cart runs.
//
// Nothing else is kept outside RAM, which is what makes `snapshot()` complete.
// The engine test asserts exactly that: snapshot, sixty frames, restore, the
// same sixty frames, and the framebuffers must match byte for byte.
//
// HOW THIS IS NOT A PLATFORMER WITH GRAVITY SET TO ZERO
// ----------------------------------------------------
// Four things, and each one is a place the two genres actually differ:
//
//   - MOVEMENT IS EIGHT-DIRECTIONAL and the FACING PERSISTS. A platformer's
//     facing is a bit, derived from horizontal velocity, and it is meaningless
//     while standing still. Here it is a whole direction, it survives letting go
//     of the stick, and it is what the swing, the door and the camera all read.
//   - THERE IS NO GROUND. `grounded()` has no meaning and does not exist; there
//     is no gravity, no terminal velocity, no coyote time and no jump. Both axes
//     are the same kind of axis, which is why `moveX` and `moveY` here are
//     symmetric where a platformer's are not.
//   - THE MAP IS BOUNDED ON FOUR SIDES. A platformer must let a body fall out of
//     the bottom of the world, because that is what makes a pit a pit. A walker
//     that leaves the map has walked off a table.
//   - THE ENTITY POOL DOES SOMETHING. Two behaviours that are not each other --
//     a chaser that closes on the player and a patroller that walks its line and
//     turns at a wall -- plus pickups, plus a swing that damages them.
//
// WHY A SCROLLING OVERWORLD AND NOT ROOM TRANSITIONS
// -------------------------------------------------
// Both are classic. The scrolling one is the harder claim to make good on and
// the one this milestone is actually measuring: a camera that eases in TWO axes
// and clamps on FOUR edges is a thing you can be wrong about, and a room-flip
// engine's camera is a constant per room, so "clamped to the map on both axes"
// would have been vacuously true. The minimap is what a room grid gives you for
// free and a scrolling world does not, so the engine draws one.
//
// THE COORDINATE SYSTEM
// ---------------------
// Positions and velocities are in SUBPIXELS, 256 to the pixel, stored as signed
// 32-bit little-endian in RAM. Integers only: `>> 8` converts to pixels and
// floors correctly for negative values, which is what a collision routine wants
// at the edge of the world.

// --- the machine's own addresses -------------------------------------------
var SUB = 256;
var TILE = 8;
var A_FLAGS = 0x4200;
var A_MAP = 0x4300;
var A_USER = 0x7800;
var MAP_STRIDE = 128;

// --- this cart's own RAM ----------------------------------------------------
// The walker's own state is here rather than in entity 0, because it is state
// about the PLAYER rather than about a body: an enemy has a position and a
// health, and does not have a key ring.
var G_FACE = A_USER + 0; // 0 down, 1 up, 2 left, 3 right. Persists when still.
var G_ATK = A_USER + 1; // frames left in the swing, 0 when not swinging
var G_HP = A_USER + 2;
var G_INV = A_USER + 3; // invulnerability frames left after a hit
var G_KEYS = A_USER + 4;
var G_COINS = A_USER + 5;
var G_HURT = A_USER + 6; // times hurt this run, for the HUD
var G_STEP = A_USER + 7; // walk-cycle phase; 0 whenever the walker is still
var G_CAMX = A_USER + 8; // camera, in subpixels, i32
var G_CAMY = A_USER + 12;
var E_BASE = A_USER + 16; // the entity pool starts here

// One entity is 20 bytes. Entity 0 is always the player.
var E_SIZE = 20;
var E_X = 0;
var E_Y = 4;
var E_VX = 8;
var E_VY = 12;
var E_KIND = 16; // 0 free, 1 player, 2 chaser, 3 patroller, 4 coin, 5 key
var E_FACE = 17; // a patroller's heading, in the same four codes as G_FACE
var E_HP = 18;
var E_HIT = 19; // hit-flash frames left; also the "already hit" gate

var BTN_U = 0;
var BTN_D = 1;
var BTN_L = 2;
var BTN_R = 3;
var BTN_A = 4;
var BTN_B = 5;

// --- constants derived from the knobs ---------------------------------------
// Computed once at cart top level. KNOB is fixed at stamp time, so these are
// literals that happen to be spelled as arithmetic.
var MOVEV = (KNOB.moveSpeed * SUB) | 0;
// A walker holding two directions covers 1.414 times the distance per frame
// unless something says otherwise, and the something is a knob rather than a
// hard-coded 0.7071 -- a game that WANTS diagonal running is a legitimate game.
var DIAGV = (KNOB.moveSpeed * KNOB.diagonalScale * SUB) | 0;
var CHASEV = (KNOB.chaserSpeed * SUB) | 0;
var PATV = (KNOB.patrolSpeed * SUB) | 0;
var KNOCKV = (KNOB.knockback * SUB) | 0;
var PW = KNOB.playerWidth;
var PH = KNOB.playerHeight;
var EW = KNOB.enemyWidth;
var EH = KNOB.enemyHeight;
var MW = KNOB.mapWidth;
var MH = KNOB.mapHeight;
var NM1 = KNOB.entities - 1; // usable pool slots; slot 0 is the player
// Minimap scale: map tiles per minimap pixel, and minimap pixels per world
// pixel. Floats, and deliberately so -- they are multiplied by an integer and
// truncated, which IEEE 754 specifies exactly.
var MMX = MW / KNOB.minimapSize;
var MMY = MH / KNOB.minimapSize;
var MMPX = KNOB.minimapSize / (MW * TILE);
var MMPY = KNOB.minimapSize / (MH * TILE);

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
// Directions
// ============================================================================

/**
 * The four facings, as unit steps. 0 down, 1 up, 2 left, 3 right.
 *
 * The codes are paired so that `f ^ 1` is the opposite direction, which is the
 * whole of a patroller's turn and costs one XOR.
 */
function dirX(f) {
  return f === 2 ? -1 : f === 3 ? 1 : 0;
}

function dirY(f) {
  return f === 1 ? -1 : f === 0 ? 1 : 0;
}

// ============================================================================
// The map
// ============================================================================

/**
 * A 32-bit integer hash -- Thomas Wang's, written with `| 0` after every step.
 *
 * The world is a pure function of (level_seed, chunk), so it is the same world
 * on every machine and needs no data in the cart. It must not be `sys.rnd`:
 * that generator is seeded per RUN and advances with every call, so a world
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

function setTile(tx, ty, t) {
  if (tx >= 0 && tx < MW && ty >= 0 && ty < MH) sys.poke(A_MAP + ty * MAP_STRIDE + tx, t);
}

/** The flags byte of the tile at (tx, ty). Outside the map there are none. */
function flagsAt(tx, ty) {
  if (tx < 0 || tx >= MW || ty < 0 || ty >= MH) return 0;
  return sys.peek(A_FLAGS + sys.peek(A_MAP + ty * MAP_STRIDE + tx));
}

/**
 * Is the tile at (tx, ty) solid?
 *
 * OUTSIDE THE MAP IS `edge_solid` ON ALL FOUR SIDES, and that is the genre
 * difference stated as code. A platformer has to make "below the map" passable,
 * because falling out of the world is what a pit is for; a walker who leaves the
 * map has walked off the edge of a table, so there is no side to make an
 * exception for.
 */
function solid(tx, ty) {
  if (tx < 0 || tx >= MW || ty < 0 || ty >= MH) return KNOB.edgeSolid;
  return (flagsAt(tx, ty) & KNOB.solidFlag) !== 0;
}

/**
 * Fill the inner 3 x 3 of a four-tile chunk, capping the top row.
 *
 * THE GUTTER IS THE POINT. Column 0 and row 0 of every chunk are left as they
 * were, so whatever a chunk decides to be, there is always an open lane along
 * its top and left edges. That is a connected overworld guaranteed by
 * arithmetic rather than by a maze algorithm and a flood fill, and it costs four
 * characters in the loop bounds.
 */
function block(bx, by, body, cap) {
  for (var y = 1; y < 4; y++) {
    for (var x = 1; x < 4; x++) setTile(bx + x, by + y, y === 1 ? cap : body);
  }
}

/** Put entity `i` at tile (tx, ty), facing `face`. Slot 0 is never a spawn. */
function place(i, kind, tx, ty, face) {
  var e = ent(i);
  w32(e + E_X, tx * TILE * SUB);
  w32(e + E_Y, ty * TILE * SUB);
  w32(e + E_VX, 0);
  w32(e + E_VY, 0);
  sys.poke(e + E_KIND, kind);
  sys.poke(e + E_FACE, face);
  sys.poke(e + E_HP, KNOB.enemyHp);
  sys.poke(e + E_HIT, 0);
}

/**
 * Build the world.
 *
 * Decided per FOUR-TILE CHUNK, the way the platformer decides per four columns,
 * because one-tile noise makes a field of confetti rather than a place. Each
 * chunk rolls once and becomes rock, water, or open ground with things on it.
 *
 * A SPAWNED ENTITY PICKS ITS SLOT FROM THE HASH rather than taking the next free
 * one. Filling the pool in order would put every enemy in the top-left corner of
 * a 4096-tile map and leave the rest of the world empty, because the pool runs
 * out long before the map does. Choosing `1 + h % (entities - 1)` scatters the
 * pool across the whole map instead, at the price of later chunks overwriting
 * earlier ones -- which is the right price, because what a player notices is an
 * empty world, not an enemy that was never there.
 *
 * THE HOME CHUNK AND ITS EIGHT NEIGHBOURS ARE LEFT AS PLAIN GROUND. A world that
 * can kill you before you have pressed anything is not a world, and a rock
 * generated over the spawn puts the walker inside a solid tile on frame one.
 */
function generate() {
  var seed = KNOB.levelSeed;
  var hx = KNOB.startTileX >> 2;
  var hy = KNOB.startTileY >> 2;
  sys.memset(A_MAP, 0, 8192);

  for (var cy = 0; cy < MH >> 2; cy++) {
    for (var cx = 0; cx < MW >> 2; cx++) {
      var h = hash((seed ^ ((cy * 97 + cx) * 7919)) | 0);
      var bx = cx << 2;
      var by = cy << 2;

      for (var y = 0; y < 4; y++) {
        for (var x = 0; x < 4; x++) {
          setTile(bx + x, by + y, (h >>> (x + y * 4)) & 1 ? KNOB.tileGrassAlt : KNOB.tileGrass);
        }
      }
      if (cx >= hx - 1 && cx <= hx + 1 && cy >= hy - 1 && cy <= hy + 1) continue;

      var r = h % 100;
      if (r < KNOB.wallChance) {
        block(bx, by, KNOB.tileWall, KNOB.tileWallTop);
      } else if (r < KNOB.wallChance + KNOB.waterChance) {
        block(bx, by, KNOB.tileWater, KNOB.tileShore);
      } else {
        if ((h >>> 7) % 100 < KNOB.treeChance) setTile(bx + 1, by + 1, KNOB.tileTree);
        if ((h >>> 11) % 100 < KNOB.flowerChance) setTile(bx + 2, by + 2, KNOB.tileFlower);
        if ((h >>> 15) % 100 < KNOB.brambleChance) setTile(bx + 3, by + 2, KNOB.tileBramble);
        if ((h >>> 19) % 100 < KNOB.coinChance) place(1 + (h % NM1), 4, bx + 2, by + 1, 0);
        if ((h >>> 23) % 100 < KNOB.keyChance) place(1 + ((h >>> 5) % NM1), 5, bx + 1, by + 2, 0);
        if ((h >>> 3) % 100 < KNOB.chaserChance) place(1 + ((h >>> 9) % NM1), 2, bx + 3, by + 3, 0);
        if ((h >>> 27) % 100 < KNOB.patrollerChance) {
          place(1 + ((h >>> 13) % NM1), 3, bx + 1, by + 3, (h >>> 17) & 3);
        }
      }
    }
  }

  // The rim of the world, so a walker cannot stand where there is no map even
  // with edge_solid off.
  for (var t = 0; t < MW; t++) {
    setTile(t, 0, KNOB.tileWallTop);
    setTile(t, MH - 1, KNOB.tileWall);
  }
  for (var u = 0; u < MH; u++) {
    setTile(0, u, KNOB.tileWall);
    setTile(MW - 1, u, KNOB.tileWall);
  }

  keep();
}

/**
 * The keep: a walled rectangle with one locked door and a coin behind it.
 *
 * Written LAST so it wins every chunk that generated under it, and it hands the
 * key/door interaction something to be for. Slots 1 and 2 are reserved for its
 * coin and its key, which is why they are placed here rather than rolled -- a
 * locked door whose key the pool happened not to have room for is a door that
 * never opens.
 */
function keep() {
  var kx = KNOB.keepX;
  var ky = KNOB.keepY;
  var kw = KNOB.keepW;
  var kh = KNOB.keepH;
  for (var y = 0; y < kh; y++) {
    for (var x = 0; x < kw; x++) {
      var edge = x === 0 || y === 0 || x === kw - 1 || y === kh - 1;
      setTile(kx + x, ky + y, edge ? (y === 0 ? KNOB.tileWallTop : KNOB.tileWall) : KNOB.tileFloor);
    }
  }
  setTile(kx + (kw >> 1), ky + kh - 1, KNOB.tileDoor);
  place(1, 4, kx + (kw >> 1), ky + 1, 0);
  place(2, 5, kx - 2, ky + kh + 2, 0);
}

// ============================================================================
// Movement
// ============================================================================

/**
 * Move one entity along X, then stop it against the first solid tile it meets.
 *
 * X AND Y ARE RESOLVED SEPARATELY, and in a top-down game that matters MORE than
 * it does side-on rather than less: every frame of diagonal movement is a
 * diagonal move, where a platformer only makes one at the top of a jump.
 * Resolving a diagonal in one step has to choose an axis to push out of, and the
 * choice is wrong often enough that a walker running along a wall catches on the
 * seam between two wall tiles.
 *
 * A RESOLUTION NEVER MOVES A BODY BACKWARDS. If a body is already inside a wall
 * -- spawned there, or left there by a door that closed -- then snapping to the
 * far face of the tile its leading edge is in throws it a whole body-width away,
 * and next frame it does it again from further out. Clamping the result against
 * the position before the step makes a body in a wall simply not move.
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

/** The same, along Y. The two are mirror images, because neither axis is down. */
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

/** Does this body overlap a hazard tile? */
function inHazard(e, w, h) {
  var px = r32(e + E_X) >> 8;
  var py = r32(e + E_Y) >> 8;
  for (var ty = py >> 3; ty <= (py + h - 1) >> 3; ty++) {
    for (var tx = px >> 3; tx <= (px + w - 1) >> 3; tx++) {
      if ((flagsAt(tx, ty) & KNOB.hazardFlag) !== 0) return true;
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
// The walker
// ============================================================================

function respawn() {
  var e = ent(0);
  w32(e + E_X, KNOB.startTileX * TILE * SUB);
  w32(e + E_Y, KNOB.startTileY * TILE * SUB);
  w32(e + E_VX, 0);
  w32(e + E_VY, 0);
  sys.poke(e + E_KIND, 1);
  sys.poke(G_FACE, 0);
  sys.poke(G_ATK, 0);
  sys.poke(G_STEP, 0);
  sys.poke(G_HP, KNOB.playerHp);
  sys.poke(G_INV, KNOB.hurtInvulnFrames);
  camera(true);
}

function hurt() {
  var hp = sys.peek(G_HP);
  hp = hp > 0 ? hp - 1 : 0;
  sys.poke(G_HP, hp);
  sys.poke(G_HURT, sys.peek(G_HURT) + 1);
  sys.poke(G_INV, KNOB.hurtInvulnFrames);
  snd.sfx(KNOB.sfxHurt, 1);
  if (hp === 0) respawn();
}

/**
 * One swing, resolved on the frame it is thrown.
 *
 * THE HITBOX IS A RECTANGLE IN THE FACING DIRECTION, `attack_reach` deep and
 * `attack_width` across, hung off the corresponding face of the walker's own
 * box. Behind the walker there is nothing, which is the whole point of a facing
 * that persists: a swing is a claim about a direction, and standing still has to
 * be able to make it.
 *
 * Damage lands ONCE PER SWING because this runs once, on the press. A hitbox
 * evaluated every frame of a twelve-frame animation would deal twelve times the
 * damage the knob says, and `attack_damage` would mean nothing.
 */
function swing(f) {
  var e = ent(0);
  var px = r32(e + E_X) >> 8;
  var py = r32(e + E_Y) >> 8;
  var aw = KNOB.attackWidth;
  var ar = KNOB.attackReach;
  var ax = px + ((PW - aw) >> 1);
  var ay = py + ((PH - aw) >> 1);
  var bw = aw;
  var bh = aw;
  if (f === 0) {
    ay = py + PH;
    bh = ar;
  } else if (f === 1) {
    ay = py - ar;
    bh = ar;
  } else if (f === 2) {
    ax = px - ar;
    bw = ar;
  } else {
    ax = px + PW;
    bw = ar;
  }

  for (var i = 1; i < KNOB.entities; i++) {
    var o = ent(i);
    var k = sys.peek(o + E_KIND);
    if ((k !== 2 && k !== 3) || sys.peek(o + E_HIT) !== 0) continue;
    var ox = r32(o + E_X) >> 8;
    var oy = r32(o + E_Y) >> 8;
    if (ax < ox + EW && ox < ax + bw && ay < oy + EH && oy < ay + bh) {
      var hp = sys.peek(o + E_HP);
      hp = hp > KNOB.attackDamage ? hp - KNOB.attackDamage : 0;
      sys.poke(o + E_HP, hp);
      sys.poke(o + E_HIT, KNOB.hitFlashFrames);
      snd.sfx(KNOB.sfxHit, 1);
      if (hp === 0) {
        sys.poke(o + E_KIND, 0);
      } else {
        // Knock it back THROUGH the collision routine rather than by moving it,
        // so a shove into a wall stops at the wall instead of embedding the
        // body in it -- from which `moveX` would never let it out again.
        w32(o + E_VX, dirX(f) * KNOCKV);
        w32(o + E_VY, dirY(f) * KNOCKV);
        moveX(o, EW, EH);
        moveY(o, EW, EH);
      }
    }
  }
}

/**
 * Use whatever is in front of the walker. Today that is exactly one thing: a
 * door, which a key opens, once, permanently.
 *
 * THE DOOR IS A TILE AND THE MAP IS RAM, so "this door is open" needs no
 * bookkeeping of its own -- the world remembers by being different. It also
 * rewinds for free, which a list of opened doors in USER_RAM would only do if
 * someone remembered to put it there.
 */
function use(f) {
  var e = ent(0);
  var tx = ((r32(e + E_X) >> 8) + (PW >> 1) + dirX(f) * KNOB.useReach) >> 3;
  var ty = ((r32(e + E_Y) >> 8) + (PH >> 1) + dirY(f) * KNOB.useReach) >> 3;
  if (sys.peek(G_KEYS) > 0 && (flagsAt(tx, ty) & KNOB.doorFlag) !== 0) {
    setTile(tx, ty, KNOB.tileDoorOpen);
    sys.poke(G_KEYS, sys.peek(G_KEYS) - 1);
    snd.sfx(KNOB.sfxDoor, 1);
  }
}

/**
 * One frame of the walker.
 *
 * THE FACING IS CHOSEN, NOT DERIVED. On a diagonal, one of the two axes has to
 * name the direction, and which one is a design decision rather than a fact --
 * `face_prefer_x` is that decision, and a game where holding up-right faces you
 * north is a different and perfectly good game.
 */
function player() {
  var e = ent(0);
  var f = sys.peek(G_FACE);
  var atk = sys.peek(G_ATK);
  var inv = sys.peek(G_INV);
  var dx = (inp.btn(BTN_R) ? 1 : 0) - (inp.btn(BTN_L) ? 1 : 0);
  var dy = (inp.btn(BTN_D) ? 1 : 0) - (inp.btn(BTN_U) ? 1 : 0);

  if (dx !== 0 || dy !== 0) {
    if (dx !== 0 && (dy === 0 || KNOB.facePreferX)) f = dx > 0 ? 3 : 2;
    else f = dy > 0 ? 0 : 1;
    // The walk cycle advances with the WALKING and not with the clock, so a
    // walker who stops mid-stride stands on both feet.
    sys.poke(G_STEP, sys.peek(G_STEP) + 1);
  } else {
    sys.poke(G_STEP, 0);
  }
  sys.poke(G_FACE, f);

  var sp = dx !== 0 && dy !== 0 ? DIAGV : MOVEV;
  if (atk > 0) sp = (sp * KNOB.attackMoveScale) | 0;
  w32(e + E_VX, dx * sp);
  w32(e + E_VY, dy * sp);
  moveX(e, PW, PH);
  moveY(e, PW, PH);

  if (atk > 0) {
    sys.poke(G_ATK, atk - 1);
  } else if (inp.btnp(BTN_A)) {
    sys.poke(G_ATK, KNOB.attackFrames);
    swing(f);
    snd.sfx(KNOB.sfxSlash, 0);
  }
  if (inp.btnp(BTN_B)) use(f);

  if (inv > 0) sys.poke(G_INV, inv - 1);
  else if (inHazard(e, PW, PH)) hurt();
}

// ============================================================================
// The pool
// ============================================================================

/**
 * Every other entity, one frame.
 *
 * TWO BEHAVIOURS THAT ARE NOT EACH OTHER, which is the point of having a pool
 * rather than a second player:
 *
 *   - a CHASER reads the walker's position, and while the walker is within
 *     `chase_range` (measured as |dx| + |dy|, which is a diamond and costs no
 *     multiply) it steps toward them on both axes at once. Out of range it
 *     stops, so a map full of chasers is not a map where everything converges on
 *     you from four screens away.
 *   - a PATROLLER knows nothing about the walker at all. It walks its heading
 *     until `moveX`/`moveY` zero its velocity -- which happens exactly when a
 *     wall stopped it -- and then reverses with `f ^ 1`.
 *
 * Both run through the same `moveX`/`moveY` as the walker. One integrator, one
 * collision routine, one place a movement bug can be.
 */
function pool() {
  var p = ent(0);
  var inv = sys.peek(G_INV);
  for (var i = 1; i < KNOB.entities; i++) {
    var e = ent(i);
    var k = sys.peek(e + E_KIND);
    if (k === 0) continue;
    var hit = sys.peek(e + E_HIT);
    if (hit > 0) sys.poke(e + E_HIT, hit - 1);

    if (k === 2) {
      var ddx = (r32(p + E_X) >> 8) - (r32(e + E_X) >> 8);
      var ddy = (r32(p + E_Y) >> 8) - (r32(e + E_Y) >> 8);
      var near = (ddx < 0 ? -ddx : ddx) + (ddy < 0 ? -ddy : ddy) < KNOB.chaseRange;
      w32(e + E_VX, near ? (ddx > 0 ? CHASEV : ddx < 0 ? -CHASEV : 0) : 0);
      w32(e + E_VY, near ? (ddy > 0 ? CHASEV : ddy < 0 ? -CHASEV : 0) : 0);
      moveX(e, EW, EH);
      moveY(e, EW, EH);
    } else if (k === 3) {
      var d = sys.peek(e + E_FACE);
      w32(e + E_VX, dirX(d) * PATV);
      w32(e + E_VY, dirY(d) * PATV);
      moveX(e, EW, EH);
      moveY(e, EW, EH);
      if (r32(e + E_VX) === 0 && r32(e + E_VY) === 0) sys.poke(e + E_FACE, d ^ 1);
    } else if (touching(p, PW, PH, e, KNOB.pickupSize, KNOB.pickupSize)) {
      sys.poke(e + E_KIND, 0);
      if (k === 4) sys.poke(G_COINS, sys.peek(G_COINS) + 1);
      else sys.poke(G_KEYS, sys.peek(G_KEYS) + 1);
      snd.sfx(KNOB.sfxPickup, 2);
      continue;
    }

    // Touching a live enemy costs a heart, once, and then buys a window of
    // invulnerability -- without which standing in a chaser would empty the bar
    // in six frames and no player would ever see what hit them.
    if ((k === 2 || k === 3) && inv === 0 && touching(p, PW, PH, e, EW, EH)) {
      hurt();
      inv = KNOB.hurtInvulnFrames;
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
 * quarter of it rounds to nothing, a plain lerp stops short -- a whole pixel of
 * framing error that never goes away. Stepping one subpixel when the fraction
 * underflows costs one branch and converges exactly.
 */
function approach(cur, to) {
  var d = ((to - cur) * KNOB.cameraSmooth) | 0;
  if (d === 0) d = to > cur ? 1 : to < cur ? -1 : 0;
  return cur + d;
}

/**
 * Follow the walker in BOTH axes, look ahead in the direction they face, and
 * clamp to the map on ALL FOUR EDGES so the world never shows its rim.
 *
 * A platformer's camera has one interesting axis and one that mostly tracks a
 * floor. Here they are the same axis twice, and the look-ahead is a facing
 * rather than a sign -- which is why `dirX`/`dirY` show up in a camera routine
 * at all.
 *
 * A map narrower or shorter than the screen has a negative maximum, so both
 * limits are clamped at zero before they are used; otherwise the low bound would
 * be above the high one and the camera would sit wherever the last comparison
 * left it.
 */
function camera(snap) {
  var e = ent(0);
  var f = sys.peek(G_FACE);
  var tx = ((r32(e + E_X) >> 8) + (PW >> 1) - 64 + dirX(f) * KNOB.cameraLookahead) * SUB;
  var ty = ((r32(e + E_Y) >> 8) + (PH >> 1) - 64 + dirY(f) * KNOB.cameraLookahead) * SUB;
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

/**
 * The minimap -- what a scrolling world owes the player in place of a room grid.
 *
 * A filled rectangle of floor colour, then one pixel per sampled tile that is
 * solid, then the walker. Sampling rather than averaging: at one minimap pixel
 * per two tiles the shape of a wall survives, and an average would turn the
 * whole thing into fog.
 *
 * EACH PIXEL SAMPLES THE CENTRE OF THE TILES IT COVERS, not their corner, and
 * that half is load-bearing rather than fussy. A minimap pixel here covers two
 * tiles each way, and the generator leaves the first column and first row of
 * every chunk open as a lane -- so a corner sample lands on the lane three times
 * in four and draws a world with almost no walls in it. Sampling the centre
 * reports what the chunk actually is.
 */
function minimap() {
  var s = KNOB.minimapSize;
  var mx = KNOB.minimapX;
  var my = KNOB.minimapY;
  gfx.rect(mx, my, s, s, KNOB.minimapFloorColor, true);
  for (var y = 0; y < s; y++) {
    var ty = ((y + 0.5) * MMY) | 0;
    for (var x = 0; x < s; x++) {
      if ((flagsAt(((x + 0.5) * MMX) | 0, ty) & KNOB.solidFlag) !== 0) {
        gfx.pset(mx + x, my + y, KNOB.minimapWallColor);
      }
    }
  }
  var e = ent(0);
  gfx.pset(
    mx + (((r32(e + E_X) >> 8) * MMPX) | 0),
    my + (((r32(e + E_Y) >> 8) * MMPY) | 0),
    KNOB.minimapPlayerColor,
  );
}

function draw() {
  var e = ent(0);
  var camx = r32(G_CAMX) >> 8;
  var camy = r32(G_CAMY) >> 8;
  var f = sys.peek(G_FACE);

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
    var k = sys.peek(o + E_KIND);
    if (k === 0) continue;
    // A struck enemy blinks. The counter is in RAM, so the blink rewinds.
    if (sys.peek(o + E_HIT) > 0 && (sys.frame() & 1) === 0) continue;
    var n =
      k === 4
        ? KNOB.spriteCoin
        : k === 5
          ? KNOB.spriteKey
          : (k === 2 ? KNOB.spriteChaser : KNOB.spritePatroller) +
            ((sys.frame() >> KNOB.enemyFrameShift) & 1);
    gfx.spr(n, r32(o + E_X) >> 8, r32(o + E_Y) >> 8);
  }

  var px = r32(e + E_X) >> 8;
  var py = r32(e + E_Y) >> 8;
  if (sys.peek(G_ATK) > 0) {
    gfx.spr(
      KNOB.spriteSlash + f,
      px + KNOB.spriteOffsetX + dirX(f) * KNOB.attackReach,
      py + KNOB.spriteOffsetY + dirY(f) * KNOB.attackReach,
    );
  }

  // Invulnerable means blinking, so a player can see the frames they are being
  // given. `inv & 2` is on for two frames of every four.
  var inv = sys.peek(G_INV);
  if (inv === 0 || (inv & 2) !== 0) {
    var step = sys.peek(G_STEP);
    var fr = step === 0 ? 0 : (step >> KNOB.walkFrameShift) % KNOB.spriteWalkFrames;
    gfx.spr(
      KNOB.spriteWalk + f * KNOB.spriteDirStride + fr,
      px + KNOB.spriteOffsetX,
      py + KNOB.spriteOffsetY,
    );
  }

  // The HUD is screen space, so the camera goes back to the origin first.
  gfx.camera(0, 0);
  if (gfx.print) {
    gfx.print("HP" + sys.peek(G_HP), 2, 2, KNOB.hudColor);
    gfx.print("K" + sys.peek(G_KEYS), 26, 2, KNOB.hudColor);
    gfx.print("C" + sys.peek(G_COINS), 46, 2, KNOB.hudColor);
    gfx.print("X" + sys.peek(G_HURT), 72, 2, KNOB.hudColor);
  }
  if (KNOB.minimapShow) minimap();
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
