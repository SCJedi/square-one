# `platformer`

A side-scrolling platformer core, as a Square One cart body. It ships no art and
no level data: everything it draws comes from the packs a recipe pairs it with,
and everything it feels like comes from the 71 knobs in `module.toml` — 19 of
which are required, because there is no sensible default for "which tile is the
floor".

```
engine.js     the cart source. ~4000 tokens of the 8192 a cart may spend.
module.toml   what it provides, what it requires, and every knob.
test/         27 tests against a real machine, including the rewind.
```

Paired with `sweetie16`, `caves` and `hero` it is
`examples/cave-runner/recipe.toml`.

---

## What it does

- **An entity pool of 24** in USER_RAM. Entity 0 is the player; the rest are
  crawlers and gems placed by the level generator. Crawlers run through the same
  integrator and the same collision routine as the player, which is the point of
  having an entity model: one place a physics bug can be.
- **Gravity, acceleration, friction, terminal velocity** — separate ground and
  air constants for the first two.
- **Coyote time and a jump buffer.** See below; they are what the file is for.
- **Variable jump height**: release A while rising and the rise is cut by
  `jump_cut`.
- **Tile collision, resolved separately on X and Y**, reading `solid` and
  `hazard` out of SPRITE_FLAGS.
- **A camera** that follows the player, leads in the direction they face, eases
  in, and clamps to the map edge.
- **Death and respawn** on a hazard tile, on touching a crawler, and on falling
  out of the bottom of the world.
- **A level generated from a seed**, so the cart carries no map and every player
  gets the same cave.

---

## Coyote time and the jump buffer

These are the two counters that separate a platformer that works from one that
feels right, and they are symmetrical:

- **Coyote time** forgives a jump pressed slightly **late** — you already walked
  off the ledge, and for `coyote_frames` afterwards the jump still works.
- **The jump buffer** forgives one pressed slightly **early** — you are still a
  few frames above the floor, and the press is remembered for
  `jump_buffer_frames` and spent on the landing rather than thrown away.

A jump fires when both counters are non-zero, and consumes both. Both are frame
counts in the player's own RAM, so both survive a rewind.

Set `coyote_frames = 0` and the game is the one players describe as
unresponsive without being able to say why.

---

## Where the state lives

All of it is in RAM. The module-level `var`s in `engine.js` are of two kinds and
neither is machine state: address constants, and values derived from `KNOB`,
which is frozen at stamp time and cannot change while the cart runs.

Positions and velocities are in **subpixels, 256 to the pixel**, stored as signed
32-bit little-endian. Integers only — `>> 8` converts to pixels and floors
correctly for negatives, which is what a collision routine wants at the left edge
of the world.

```
0x7800  +0    death timer, 0 when alive          u8
        +1    deaths this run                    u8
        +2    gems collected                     u8
        +4    camera x, subpixels                i32
        +8    camera y, subpixels                i32
        +16   the entity pool, 20 bytes each

one entity:
        +0    x   i32 subpixels        +16  kind  u8  0 free, 1 player,
        +4    y   i32 subpixels                       2 crawler, 3 gem
        +8    vx  i32 subpixels        +17  flags u8  bit 1: facing left
        +12   vy  i32 subpixels        +18  coyote frames left   u8
                                       +19  jump-buffer frames left u8
```

The test asserts the containment claim directly rather than trusting it:
snapshot, run sixty frames, restore, run the same sixty frames, and both the
framebuffer and the whole 64 KB must come out identical byte for byte.

---

## Two things the collision code is careful about

**X and Y are resolved separately.** Resolving a diagonal move in one step has to
choose which axis to push out of, and the choice is wrong often enough that a
body running along a flat floor catches on the seam between two floor tiles.
Moving X against the old Y and then Y against the new X has no such choice to
make.

**A resolution never moves a body backwards.** If a body is somehow already
inside a wall, the tile its leading edge is in is the tile it is standing in, and
snapping to that tile's far face throws it a whole body-width *away* from the
wall — then further, next frame, from there. A body spawned one tile inside a
wall walked itself off the map in under a second, which is how this was found.
Clamping the result against the position before the step makes the answer the
only sensible one: a body in a wall does not move.

**"Grounded" is a probe, not a flag.** A body standing still still has gravity
added every frame, and most frames that is not enough subpixels to push it into
the floor tile — so a flag set by the landing collision flickers off between
landings and takes coyote time, the jump and the run animation with it. The
engine reads the tile row immediately below the body's bottom pixel instead,
which is stable for as long as the body rests there.

---

## The level generator

Terrain is decided per **four-column chunk** from a hash of
`(level_seed, chunk)`, so ground height, pits and ledges come in pieces a runner
can land on rather than as one-column noise. Every chunk gets a ground row, a
roof depth, and rolls for a pit, a spike, a ledge, a crawler and a gem.

It is a pure function of the seed and the column, which is what makes the cave
the same on every machine and lets the cart carry no map at all. It must not use
`sys.rnd`: that generator is seeded per *run* and advances with every call, so a
level built from it would differ between two plays and would move under a rewind.

**The first two chunks are floor and nothing else** — no pit, no step in the
ground, no spike, no ledge. A level that can kill you before you have pressed
anything is not a level, and a ledge generated across the spawn point puts the
player inside a solid tile on frame one.

---

## Pairing it with art

**The art is already in RAM when `boot()` runs, and the engine does nothing to
put it there.** The player installs a cart's `PAL `, `GFX ` and `MAP ` chunks
between zeroing RAM and calling `boot()` (specification 3.3), so the sprite sheet
is at `0x2200`, the sprite flags at `0x4200` and the live palette at `0x20C0`
before the engine's first line. `solid()` reads a flag byte while the level is
being generated because the flag byte is simply there.

This is a change from the first draft, which carried the sheet as a hex string
in the cart's own preamble and unpacked it in `boot`. That cost two cart bytes
per data byte and a decoder in every engine, to reach a region the machine
initializes for free; there is no `ART` declaration any more, and nothing above
`engine.js` except `KNOB`.

The engine knows nothing about any particular pack. Sixteen required knobs are
the entire binding, and they come in two groups:

```toml
tile_rock       = 1    # solid: the ceiling and the shallow underground
tile_ceiling    = 8    # solid: the shaded underside of the roof
tile_rock_top   = 3    # solid: the floor's top row, the one with moss on it
tile_dirt       = 13   # solid: everything deeper than two rows
tile_lava       = 27   # hazard: the bottom of a pit
tile_spike      = 23   # hazard: grows on the floor
tile_platform   = 20   # solid: the middle of a floating ledge
tile_platform_l = 19   # solid: its left end cap
tile_platform_r = 21   # solid: its right end cap

sprite_idle     = 64   # and 65: the engine alternates them
sprite_run      = 66   # and the next sprite_run_frames - 1
sprite_jump     = 70
sprite_fall     = 71
sprite_hurt     = 72
sprite_crawler  = 73   # and 74
sprite_gem      = 75
```

Plus `level_seed`, `start_tile_y` and `bg_color`. Everything else has a default.

Which `SPRITE_FLAGS` bit means `solid` and which means `hazard` are themselves
knobs (`solid_flag`, `hazard_flag`), so a tileset that numbers its flags
differently needs a recipe line rather than an engine change.

---

## Testing it

```bash
npx vitest run modules/
```

`vitest.config.ts` collects `modules/*/test/**`, so `npm test` runs these too.

`test/engine.test.ts` stands in for the stamper. It reads `module.toml` the way
the stamper does, builds the same `KNOB` preamble, composes the same `PAL ` and
`GFX ` chunks out of the same art packs, and hands the source to `compileCart`
and the chunks to `createMachine` — so it pins the whole contract, and a knob
added to the engine and not to the manifest fails there. Its float-to-fixed
conversion is `fromFloat` from `@sq1/core`, the same function the stamper's
`bind` uses: there is one such conversion in the repository, and a test with its
own copy is a test that keeps asserting the old rounding rule.

The scenario tests build their own maps by poking the MAP region after boot. The
generated cave is a fine thing to look at and a terrible thing to assert against;
a three-tile ledge in a known place is not.
