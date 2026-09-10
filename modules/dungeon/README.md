# `dungeon`

64 tiles of cut stone, flagstone, iron, water and torchlight, for the
`platformer` engine.

```bash
node modules/dungeon/gen.mjs     # rewrites tiles.bin
npm run sq1 -- stamp examples/deep-run
```

`tiles.bin` is **output**. The art is `gen.mjs`, one hex digit per pixel and one
string per row; edit it there and regenerate, so a changed pixel is a changed
character in a diff someone can read.

---

## What it is for

`caves` was the only tileset, so nothing had ever tested the claim the module
system is built on: that an engine and an art pack are separable, and that a
recipe can swap one pack for another without touching a line of code.

This pack is the swap. It declares the interface the engine asks for —

```toml
[requires]
tileset = { min_tiles = 64, flags = ["solid", "hazard"] }
```

— and draws a different world behind it. `examples/deep-run/recipe.toml` is
`cave-runner` with `dungeon` in the tileset slot, different tile indices bound
to the same knobs, and a heavier `[tuning]` table.

## What the swap measured

Both carts were stamped from the same `platformer@1.0.0`, whose content hash is
identical in both `rcpe` chunks.

| | `cave-runner` | `deep-run` |
|---|---|---|
| id | `7TB4CCKJ-JVJ6VNTP-H41H1ZFM-XRZ71B3A` | `19YQ00SM-Y0E22PW6-H58YK6GB-X4WNEXYT` |
| size | 33,708 bytes | 34,416 bytes |
| tokens | 4,180 | 4,180 |
| chain | `5e6ce7e5…` | `b7d4e910…` |

- **The CODE chunk differs in one line of 635**: line 2, the `const KNOB = {…}`
  preamble, 1,325 bytes against 1,324. Twenty-eight of the seventy-one knobs
  hold different values. The 22,862 bytes of engine source below it are
  byte-identical, as are the banner and the engine marker.
- **The `GFX ` chunk differs in 1,139 of 3,300 bytes**: 1,136 in the tileset's
  half of the sheet, 3 in the flags block — this pack marks its crate, barrel
  and grate `solid` where `caves` leaves the equivalent indices walkable. The
  996 bytes belonging to `hero` are untouched, because the spriteset did not
  change.
- **The proof chains differ**, so the art reached the machine rather than
  sitting in a chunk nobody installed.

## The two things a second pack has to agree with the first about

Both are contracts the stamper does **not** check (see the gap list in
`packages/stamper/test/contract.test.ts`), so they are stated here instead.

**The flag bits.** `solid` is bit 1 and `hazard` is bit 2, in both packs,
because the engine reads them through the `solid_flag` and `hazard_flag` knobs
and a recipe swapping packs should not have to touch those. A pack that chose
other bits would build a cart whose walls are not walls.

**The palette.** Both packs are drawn for `sweetie16`; their hex digits *are*
its live slot numbers. A pack drawn for a different sixteen colours still draws
— it just stops being a dungeon.

## The tile indices

`[names]` in `module.toml` is the whole list and is what a recipe reads. The
structure deliberately matches `caves` index for index — solids at 1–22,
hazards at 23–30, clutter at 31–46, background at 47–56 — so a recipe can be
ported between the two by changing the numbers rather than the shape.
