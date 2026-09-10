# Modules

A **module** is a reusable piece of a Square One cart. A **recipe** names four or
five of them and the numbers that bind them together, and the **stamper** turns
that into one `.cart` file.

The point is that neither half needs the other to exist yet. The `platformer`
engine has never heard of the `caves` tileset — it asks for "a tileset with at
least 64 tiles that marks `solid` and `hazard`", and a recipe says which of its
tiles is the floor. Swap in a different tileset, change eight numbers, and it is
a different game running the same engine.

```
modules/
  platformer/   engine     the code: physics, collision, camera, entities
  sweetie16/    palette    sixteen of the console's 64 hardware colours
  caves/        tileset    64 tiles of rock, spikes, lava and clutter
  hero/         spriteset  a runner, a crawler and a gem

examples/
  cave-runner/  recipe.toml   the four of them, tuned into one game
```

---

## The eight kinds

| kind | what it contributes | how it ships |
|---|---|---|
| `engine` | `boot()` and `tick()` — the cart's actual code | `engine.js` |
| `palette` | the sixteen live colour slots | numbers in the manifest |
| `tileset` | tile pixels plus a flags byte per tile | `tiles.bin` |
| `spriteset` | sprite pixels | `sprites.bin` |
| `soundbank` | SFX and music definitions | `sfx.bin` |
| `content` | a hand-authored level, dialogue, tables | `data.bin` |
| `tuning` | a named bundle of knob values — a difficulty preset, say | manifest only |
| `shell` | a title screen, a pause menu, a HUD wrapped around an engine | `shell.js` |

Exactly one `engine` per recipe. The rest are as many as the engine asks for.

---

## The manifest

Every module directory has a `module.toml`. It is the entire public face of the
module: what it is, what it provides, what it needs from its neighbours, and
every number a recipe is allowed to change.

```toml
[module]
kind    = "engine"          # one of the eight above
name    = "platformer"
version = "1.0.0"

[provides]
entities = 64               # whatever this kind of module contributes

[requires]
palette = true
tileset = { min_tiles = 64, flags = ["solid", "hazard"] }

[knobs.gravity]
type    = "fixed"           # fixed | int | bool
default = 0.42              # OMIT `default` to make the knob REQUIRED
min     = 0.0
max     = 4.0
doc     = "Downward acceleration per frame, in pixels."
```

**`[provides]`** is what the stamper type-checks a recipe against. A tileset
declares its tile count and its flag names; a palette declares that it is
sixteen colours; an engine declares the size of its entity pool. A recipe that
pairs an engine wanting 64 tiles with a tileset that has 32 is refused at stamp
time, not discovered in a playtest.

**`[requires]`** is the other half of the same handshake. `true` means "any pack
of this kind"; a table means "a pack of this kind that satisfies these
constraints"; `false` means the engine can use one and does not need one.

**`[knobs.*]`** is where the tuning lives, and the rule an engine follows is
blunt: **if a number in the source could reasonably be different in another
game, it is a knob.** A knob with no `default` is REQUIRED, and the stamper
refuses to build a recipe that leaves one unset. That is the right shape for
anything that binds an engine to a particular art pack — there is no sensible
default for "which tile is the floor".

Three knob types, and the types are about determinism rather than convenience:

- `int` and `bool` arrive in the cart as themselves.
- `fixed` arrives as an **exact power-of-two division** — `27524 / 65536`, never
  `0.42`. 0.42 is not representable as a double, and two tools that both write
  "0.42" can disagree in the last bit. Both writing the same 16.16 numerator
  cannot.

### `indexes` — an `int` that names a cell of somebody else's art

An `int` knob may declare which pack its value is an index **into**:

```toml
[knobs.tile_floor]
type    = "int"
indexes = "tileset"      # or "spriteset"
min     = 1
max     = 255
doc     = "The floor tile."
```

The two values are `"tileset"` and `"spriteset"` — the two kinds that place
cells on the sprite sheet — and the field is **optional**. A knob without it is
bounded by `min`/`max` alone, exactly as before, and a manifest that never uses
the word is read exactly as it was.

What it buys is a bound the knob's own range cannot express. `min`/`max` are
facts about the **engine**: a tile index is a byte, so `1 .. 255`. How much art
the recipe paired that engine with is not knowable when the engine is written.
So `tile_floor = 200` against a 64-tile tileset is inside the declared range and
outside the art entirely — it stamps, it proves a 600-frame chain, and the floor
is empty air. With `indexes` the stamper checks the bound value against the pack
the recipe actually chose:

```
error[index-out-of-pack]  knob `tile_lava` is 200, and tileset `caves@1.0.0`
    fills sheet cells 0 .. 63.
    `tile_lava` indexes the tileset, so it has to name a cell that pack draws:
    `caves@1.0.0` places 64 cells at [provides] base 0.
    Choose a number from 0 to 63, or use a tileset that reaches cell 200.
```

The range comes from the pack's `[provides] base` and its cell count, so a
spriteset at `base = 64` bounds its knobs to `64 .. 95` — which is how a sprite
knob set to `3` is caught. Three is a perfectly good sheet cell; it is a **tile**,
and a player character drawn as a tuft of grass is what the old build shipped.

**THE NEAR-MISS RULE, which is the part worth remembering.** The field is
written out rather than guessed from the knob's name, and the next manifest you
write will show you why. `platformer` has ten knobs starting `tile_` and twelve
starting `sprite_`, and annotates ten and seven of them. `topdown` has twelve and
ten, and annotates twelve and six:

| looks like an index | actually is | annotate? |
|---|---|---|
| `tile_lava`, `sprite_gem` | a sheet cell | **yes** |
| `sprite_run_frames` | a count of frames | no |
| `sprite_cells_w`, `sprite_cells_h` | a frame's size in cells | no |
| `sprite_offset_x`, `sprite_offset_y` | pixel offsets, and negative | no |
| `sprite_dir_stride` | cells *between* two blocks | no |
| `solid_flag`, `hazard_flag`, `door_flag` | SPRITE_FLAGS **bit** numbers | no |
| `draw_layer` | a bit **mask** | no |
| `bg_color`, `minimap_wall_color` | live palette slots | no |
| `sfx_jump` | a soundbank effect id | no |

Annotating one of the second column would bound a pixel offset against a tile
count: a check that refuses a **correct** manifest, which is worse than the
absent check it replaced. `sprite_offset_x` has the range `-16 .. 16` and every
spriteset in this repo starts at cell 64, so a name-based rule could never
satisfy it at all. **The test is not the prefix. It is whether `engine.js` hands
the value to `gfx.spr` or to `setTile`.** If it does, annotate it; if it is a
count, a width, an offset, a bit, a mask, a colour or an id, leave it alone.

Two things `indexes` does **not** do, and both are worth knowing before you rely
on it. Only the knob's own value is bounded, so a base whose consecutive frames
run off the end of the pack — `sprite_run` one cell inside a pack with
`sprite_run_frames = 4` to follow it — is not seen. And nothing checks that the
cell it names carries the right *flag*: `tile_door` must be a tile the tileset
marked `door`, and that is still on the author.

---

## The recipe

```toml
[cart]
title   = "Cave Runner"
author  = "square one"
payload = "script/js1"

[modules]
engine    = "platformer@1.0.0"
palette   = "sweetie16@1.0.0"
tileset   = "caves@1.0.0"
spriteset = "hero@1.0.0"

[tuning]
level_seed    = 20260909
gravity       = 0.38
tile_rock_top = 3
sprite_idle   = 64
# ...
```

`[tuning]` is one flat table of knob names. It must set every required knob and
may override any defaulted one. See `examples/cave-runner/recipe.toml` for a
complete one.

---

## What the stamper emits

The stamper writes a preamble above the engine's source and the result is the
cart's CODE chunk. **One declaration, and nothing else:**

```js
const KNOB = { gravity: 24903 / 65536, coyoteFrames: 8, edgeSolid: true, /* ... */ };
```

**Knob names are snake_case in the manifest and camelCase in JavaScript.**
`max_run_speed` in `module.toml` is `KNOB.maxRunSpeed` in `engine.js`.

**The art is not in the preamble. It is in chunks, and it is already in RAM.**
The merged art packs become the cart's `PAL `, `GFX ` and `MAP ` chunks, and the
player installs them between zeroing RAM and calling the engine's `boot()`
(specification 3.3). An engine reads the sprite sheet at `0x2200`, the sprite
flags at `0x4200` and the live palette at `0x20C0` without doing anything to put
them there.

An earlier draft carried the sheet through CODE as a hex string, because a
string literal is one token however long it is and eight kilobytes of art as an
array of numbers would have spent the entire 8192-token budget. It worked and it
was the wrong trade: hex costs **two cart bytes per data byte**, plus a decoder
in every engine, to reach a region the machine initializes for free. Moving
`cave-runner`'s art into its chunks took it from 37,148 bytes to 33,708.

### The chunk layouts, which are not guessable

| chunk | installs at | carries |
|---|---|---|
| `PAL ` | `0x2000`, 224 bytes | the hardware palette (192), then the sixteen live slots, then the draw remap |
| `GFX ` | `0x4200` and `0x2200` | **the 256 sprite-flag bytes FIRST**, then the sprite sheet |
| `MAP ` | `0x4300`, 8192 bytes | the tile map |
| `SFX ` / `MUS ` / `DATA` | `0x6300` / `0x7000` / `0x7800` | as the memory map has them |

`GFX ` carries its flags first even though `SPRITES` is the lower address. The
flags block is a fixed 256 bytes and the sheet is not, so putting the fixed half
first makes the split a constant rather than a header, and leaves the sheet at
the end where its trailing zeroes can be trimmed. Sheet-first, a chunk would
have to be 8,193 bytes long before it could say anything about a flag — 5,120
bytes of padding for a pack that fills 96 cells.

`PAL ` carries the hardware palette because a chunk fills its region from the
start and `PALETTE_LIVE` sits 192 bytes into it. That is the point rather than
the price: sixteen live slots indexing a hardware palette the cart did not
choose are sixteen colours that mean whatever the player says they mean. A
palette pack still declares only `[provides] entries`; there is no `pal` role in
`[files]`, and the hardware half comes from the console's own reference palette.

A chunk longer than the region it installs into is **refused**, at stamp time and
again at load time. It is never truncated: a cart missing the tail of its map
would run, and draw, and be wrong, and nothing afterwards could say so.

---

## Art packs, and why the `.bin` is not the source

`tiles.bin` and `sprites.bin` are **generated**. The art itself lives in
`gen.mjs` in each pack, one hex digit per pixel and one string per row:

```js
// 3 rock top -- moss cap and a lit rim
["99899989", "88788878", "55545554", "44444444", ...],
```

```bash
node modules/caves/gen.mjs      # rewrites tiles.bin
node modules/hero/gen.mjs       # rewrites sprites.bin
```

A change of one pixel is a change of one character in a reviewable diff. Nothing
in either generator reads a clock, calls a random number generator or uses a
float, so regenerating produces byte-identical output on any machine — the same
rule the console's sine table is held to.

**Never hand-edit a `.bin`.** It cannot be reviewed, and an edit made there and
not in `gen.mjs` is lost the next time anyone regenerates.

### The pack file formats

Both are the console's own sprite-sheet layout: the sheet is **one 128 x 128
picture** at 4 bits per pixel, 64 bytes per pixel row, **even x in the low
nibble**. A cell is 8 x 8 of it; cell *n* is at grid position `(n & 15, n >> 4)`.
`packages/runtime/src/raster.ts` is normative on this and explains why.

```
tiles.bin     0..2047      pixels: 32 rows x 64 bytes = 4 sheet rows = 64 tiles
              2048..2111   flags:  one byte per tile

sprites.bin   0..1023      pixels: 16 rows x 64 bytes = 2 sheet rows = 32 cells
              1024..1055   flags:  one byte per cell
```

`[provides] base` says which sheet cell the pack starts at, and the stamper
copies the pixels there and the flags to `SPRITE_FLAGS + base`. `caves` takes
base 0 (cells 0–63) and `hero` takes base 64 (cells 64–95), which is why they
fit on one sheet together.

Two things follow from the sheet being one picture rather than 256 tiles:

- **A tall sprite is two cells, stacked.** `gfx.spr(n, x, y, 1, 2)` draws cell
  *n* and cell *n + 16*. The runner is 8 x 16 and lives at cells 64–72 and
  80–88.
- **Tile 0 is empty and is never drawn**, whatever the sheet holds there. A map
  is mostly nothing, and the console refuses to blit 8 x 8 transparent pixels
  for every nothing.

### A note on palettes

A palette pack is not a list of RGB triples. The console has 64 hardware
colours, fixed and identical on every player, and sixteen live slots that each
point at one of them; the framebuffer stores a slot number. So a palette pack is
a **choice of sixteen from the 64**, and it is sixteen bytes in the manifest
rather than a file.

An art pack is therefore drawn *for* a palette, the way a font is drawn for a
size: `caves` and `hero` use `sweetie16`'s slot numbers as their hex digits.
Pair them with different sixteen colours and they still draw — they just stop
being a cave.

---

## Adding a module

1. `mkdir modules/<name>` and write `module.toml`. Start from the closest
   existing one; the four here cover four of the eight kinds.
2. For an engine, write `engine.js`. It is **cart source**: plain JavaScript,
   `boot()` and `tick()` at the top level, `gfx` / `inp` / `snd` / `sys` as
   ambient globals, no build step. `packages/runtime/src/machine.ts` has the
   complete list of what a cart may call.
3. For an art pack, write `gen.mjs` and run it.
4. Add a test under `modules/<name>/test/`.

### Three rules an engine does not get to break

**No `Math`, `Date`, `fetch`, `eval`, `Function`, `setTimeout`.** They are
deleted from the cart's global scope before it runs, and the build gate rejects
the *names* so the failure lands at build time rather than three levels into
somebody's game. `packages/cart/src/lint.ts` has the complete list and a
sentence about each saying what to use instead — `sys.sin`, `sys.cos`,
`sys.rnd`, `sys.frame()`. Ordinary `+ - * /` on JS numbers is fine; IEEE 754 is
exactly specified. Transcendentals are not, which is why `Math` is gone.

**All state in RAM.** The cart's entire state must be the 64 KB buffer, reached
through `sys.peek` and `sys.poke`, because a rewind restores RAM and cannot
restore a variable it cannot see. Module-level `var`s are allowed only when they
are constants — literals, or values derived from `KNOB`, which is frozen at
stamp time. Anything that changes during a frame belongs in USER_RAM (0x7800
and up). The engine test asserts this directly: snapshot, run sixty frames,
restore, run the same sixty frames, and the two framebuffers must be identical
byte for byte.

**8192 tokens, including the preamble.** Every token counts as one, punctuation
included. `platformer` is about 3900 and its stamped cart about 4200.

### Running the module tests

```bash
npx vitest run modules/
```

`vitest.config.ts` collects `modules/*/test/**`, so `npm test` runs them too.
