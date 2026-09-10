# `topdown`

A top-down action-adventure engine: a walker with a facing, a sword, a key ring
and a scrolling overworld to spend them in. It is the second engine in this
repository, and it exists to find out whether the module interface designed for
`platformer` describes anything other than a platformer.

The answer, and every place the answer was uncomfortable, is in
[INTERFACE-NOTES.md](INTERFACE-NOTES.md). Read that one if you are here about the
module system rather than about the game.

```bash
node modules/overworld/gen.mjs        # the tileset art
node modules/wanderer/gen.mjs         # the spriteset art
npx vitest run modules/topdown        # 47 tests
npm run sq1 -- stamp examples/moss-keep
```

---

## What it does

| | |
|---|---|
| **movement** | eight-directional, with a facing that survives letting go of the stick |
| **collision** | two axes resolved separately, on a map with no notion of ground and no bottom to fall out of |
| **camera** | eases toward the walker on both axes, leads in the facing direction, clamps on all four map edges |
| **structure** | a scrolling overworld with a minimap, rather than room transitions -- see below |
| **combat** | a swing with a rectangular hitbox in the facing direction; enemies take damage, flash, and are knocked back through the collision routine |
| **enemies** | a **chaser** that closes on the walker inside `chase_range`, and a **patroller** that ignores you entirely and reverses at walls |
| **items** | coins, keys, and one locked door per keep that a key opens permanently |
| **state** | all of it in USER_RAM. Snapshot, sixty frames, restore, sixty frames: byte-identical framebuffers |

Controls are the d-pad, **A** to swing and **B** to open what you are facing.

---

## Why a scrolling overworld and not room transitions

Both are classic top-down structures and the brief allowed either. The scrolling
one was chosen because it is the harder claim to make good on: a camera that eases
on two axes and clamps on four edges is a thing an engine can be **wrong** about,
and a room-flip camera is a constant per room, so "clamped to the map on both
axes" would have been vacuously true and the test asserting it would have proved
nothing.

The cost is that a scrolling world does not give you the sense of place a room
grid gives you for free, so the engine draws a minimap -- one pixel per sampled
tile, walls in one colour and everything else in another, plus a dot for you. That
is the trade stated as code: `minimap()` in `engine.js`, and `minimap_show` for
anyone who wants a game about being lost.

---

## How it is not a platformer with gravity set to zero

Four differences, each of which shows up as different code rather than a different
constant:

**The facing is a whole direction and it persists.** A platformer derives facing
from the sign of horizontal velocity, and it means nothing while standing still.
Here it is one of four codes in RAM at `G_FACE`, it survives releasing every
button, and the swing, the door and the camera all read it. On a diagonal, one
axis has to name the direction and which one is a design choice --
`face_prefer_x` is that choice.

**There is no ground.** No gravity, no terminal velocity, no coyote time, no jump
buffer, no `grounded()` probe. `moveX` and `moveY` are mirror images of each
other, which a platformer's are not, because neither axis is down.

**The map is bounded on four sides.** A platformer must let a body leave through
the bottom, because that is what makes a pit a pit. `edge_solid` here is one rule
for four edges: a walker who leaves the map has walked off a table.

**The pool does something.** Two behaviours that are not each other, both running
through the same `moveX`/`moveY` as the walker. A chaser reads the walker's
position; a patroller has never heard of the walker. Plus pickups, plus a hitbox
that damages them.

The one thing that transferred **verbatim** from `platformer` is the collision
resolution -- separate axes, and a resolution that may never move a body backwards.
That routine turned out to be about bodies and tiles rather than about a genre,
which is a pleasant thing to discover by trying to write it again.

---

## The world it generates

Deterministically, from `level_seed`, in four-tile chunks:

- each chunk rolls once and becomes **rock**, a **pond**, or **open ground**;
- rock and water fill only a chunk's inner 3x3, so **column 0 and row 0 of every
  chunk stay open** -- a connected overworld guaranteed by the loop bounds rather
  than by a maze algorithm and a flood fill;
- open chunks grow trees, flowers and brambles, and may spawn a coin, a key, a
  chaser or a patroller;
- the **home chunk and its eight neighbours** are forced to plain ground, so
  nothing the seed rolls can spawn the walker inside a wall;
- the rim of the map is wall;
- the **keep** is written last, over whatever was there: a walled rectangle with a
  floor, one locked door in the middle of its south wall, a coin inside and its
  key a few tiles outside.

A spawned entity **picks its pool slot from the hash** rather than taking the next
free one. Filling in order would put every enemy in the top-left corner of a
4,096-tile map and leave the rest of the world empty, because the pool runs out
long before the map does. Choosing `1 + h % (entities - 1)` scatters the pool
across the whole world, at the price of later chunks overwriting earlier ones --
which is the right price, because what a player notices is an empty world, not an
enemy that was never there.

---

## RAM layout

Everything the engine is, lives here. Nothing is kept in a closure.

```
0x7800  G_FACE    u8   0 down, 1 up, 2 left, 3 right
0x7801  G_ATK     u8   frames left in the swing
0x7802  G_HP      u8
0x7803  G_INV     u8   invulnerability frames left
0x7804  G_KEYS    u8
0x7805  G_COINS   u8
0x7806  G_HURT    u8   times hurt this run, for the HUD
0x7807  G_STEP    u8   walk-cycle phase; 0 whenever the walker is still
0x7808  G_CAMX    i32  camera, in subpixels
0x780C  G_CAMY    i32
0x7810  entity 0 ...   32 entities of 20 bytes, ending at 0x7A50
```

One entity is `x:i32 y:i32 vx:i32 vy:i32 kind:u8 face:u8 hp:u8 hit:u8`. Entity 0
is always the walker; slots 1 and 2 are reserved for the keep's coin and key.

The **map itself is state**, and that is a genre difference worth naming: an
opened door is a changed tile, so "which doors are open" needs no bookkeeping and
rewinds for free.

---

## What it needs from its neighbours

```toml
[requires]
palette   = true
tileset   = { min_tiles = 64, flags = ["solid", "hazard", "door"] }
spriteset = { min_sprites = 20 }
soundbank = false
```

`door` is the flag a platformer never asks for: it marks a tile the engine can
**operate**, replacing it in the map with `tile_door_open`. `modules/overworld`
provides it.

The spriteset must lay its walk cells out as four directions of two frames in the
order **down, up, left, right**. Nothing in the manifest format can say that, which
is [Finding 3](INTERFACE-NOTES.md).

There are 86 knobs and 24 of them are required. Seventeen of the required ones
exist only to name an index in somebody else's art pack. That number is a
measurement rather than a complaint, and it is what INTERFACE-NOTES.md is mostly
about.

---

## Numbers

| | |
|---|---|
| engine source | 5,034 tokens |
| stamped cart | 5,399 of 8,192 |
| `examples/moss-keep.cart` | 43,912 of 65,536 bytes |
| tests | 47, including the byte-identical rewind |
