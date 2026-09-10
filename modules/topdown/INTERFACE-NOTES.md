# What the module interface could and could not say about a top-down engine

`packages/stamper/src/manifest.ts` was designed while building one platformer.
This file is the record of what happened when a second engine, in a different
genre, was written against it **exactly as it stands** -- no edit to the stamper,
no widening of the contract, no new knob type, no new `[requires]` vocabulary.

Everything below was found by writing `modules/topdown`, `modules/overworld`,
`modules/wanderer` and `examples/moss-keep`, and every claim about what the
stamper does or does not accept was **run**, not reasoned about. The command
outputs quoted here are real.

---

## The verdict, in one paragraph

**The interface held.** A top-down action-adventure engine -- eight-directional
movement with a persistent facing, two-axis collision on a map with no ground, a
camera that clamps on four edges, a directional hitbox, two enemy behaviours,
pickups, and a key that opens a door -- fits inside `[module]`, `[provides]`,
`[requires]` and `[knobs.*]` without a single change to any of them. It stamps, it
proves a 600-frame chain, and it does it in 5,399 of the 8,192 token budget. The
things that strained are all one thing wearing four hats: **the contract can say
that two modules agree, and cannot carry a value from one to the other.** A flag
name crosses the handshake; the bit it uses does not. A cell count crosses; which
cell is the door does not. What fills the gap is a knob a human sets by copying a
number out of the other module's manifest, and that is where every real risk in
this milestone now lives.

*Written before the stamper changed. Two of the findings below were then acted
on -- see the status boxes on findings 1 and 2, and* **What happened afterwards**
*at the foot of this file. The number is still copied by hand; copying it wrong
is no longer silent.*

---

## What held, and should be said out loud

A contract that survives a genre it was not designed for is a result, and silence
about it would be the wrong report.

**1. The engine/art separation is real, not aspirational.** `topdown` contains no
word about grass, water, keeps or doors -- only `tile_grass`, `tile_water`,
`tile_floor`, `tile_door`, which are integers a recipe sets. `overworld` contains
no word about walking, swinging or keys. They meet in
`examples/moss-keep/recipe.toml` and nowhere else. This is exactly the property
`modules/README.md` claims for `platformer` and `caves`, and it is the one that
would have been most likely to turn out to be an accident of the first engine. It
is not.

**2. Required knobs -- a `[knobs.x]` with no `default` -- are the right shape, and
the diagnostic is excellent.** Twenty-four of `topdown`'s eighty-six knobs are
required. Deleting one from the recipe gives:

```
error[unbound-knob]  engine topdown@1.0.0 requires knob `tile_door`,
                     which the [tuning] table does not set.
                     Add:  tile_door = 128   # 1 .. 255, The keep's locked door
```

That message writes the missing line for you and quotes the knob's own `doc` to
explain it. Nothing about this needed to change.

**3. `flags = [...]` in `[requires]` caught a real, non-hypothetical mismatch.**
`topdown` needs a third flag that no platformer tileset has. Pairing it with
`caves`:

```
error[unsatisfied-requires]  engine `topdown@1.0.0` requires tileset
    flags = ["solid", "hazard", "door"], and `caves@1.0.0` declares
    flags [solid, hazard] and is missing "door".
```

This is the handshake working. A new flag vocabulary was introduced by a new
genre, and the format absorbed it without being told what a door is.

**4. `soundbank = false` is a genuinely useful third state.** "May use one, does
not need one" is a real relationship and most requirement systems only have two
states. `topdown` calls `snd.sfx` five times and `moss-keep` ships no soundbank;
that is silence, not an error, and no code anywhere had to test for it.

**5. Equality constraints work, including on arrays, and nobody had noticed.**
`[requires]` compares `provides.<k>` to a literal, and `sameValue` handles arrays.
So an art pack CAN pin the exact palette it was drawn for:

```toml
# in modules/overworld/module.toml
[requires]
palette = { entries = [0, 17, 1, 2, 3, 4, 5, 27, 11, 12, 23, 8, 9, 10, 13, 14] }
```

Changing one entry produces `unsatisfied-requires` naming both arrays. This was
tried, it works, and it solves a problem `modules/README.md` currently describes
as unsolvable ("pair them with different sixteen colours and they still draw --
they just stop being a cave"). It is **not** adopted here, because pinning an
exact palette forbids the recolour that is half the point of a 16-slot indirection
-- but it is available, it is free, and the fact that no existing pack uses it is
worth knowing.

**6. The art-pack mechanism took a second tileset and a second spriteset with no
change at all.** `[provides] base`, `tiles`/`sprites`, `data = "*.bin"`, one
`gen.mjs` per pack, the flags-first `GFX ` chunk, cell 64 as sheet row 4 -- all of
it worked first time for a pack whose sprites are 8x8 rather than 8x16. The
sprite-sheet-is-one-picture decision in `raster.ts` paid off again: `wanderer`
needed no notion of tall sprites, and nothing had to be told that.

**7. `fixed | int | bool` represented every VALUE the engine needed.** Speeds,
scales, reaches, ranges, percentages, frame counts, indices, colours, toggles.
Not one number in `engine.js` wanted a type that does not exist. Every complaint
below is about **validation**, never about representation, and that distinction
matters when deciding what to change.

**8. The token budget held with room to spare.** `topdown` is a bigger engine than
`platformer` -- more state, more entity kinds, a minimap -- and stamps at 5,399 of
8,192 (`platformer` is about 4,200). The 86-knob preamble costs roughly 380 of
those. The budget is not the pressure point anyone expected it to be.

**9. The test file is the same shape as the platformer's.** `modules/topdown/test/
engine.test.ts` reads the manifest, builds the preamble, composes the chunks and
boots a machine using the same forty lines of scaffolding. If the interface had
been platformer-shaped, this file would have had to be structured differently. It
did not.

**10. Snapshot/restore is byte-identical.** No engine state escaped RAM. The map
is mutable state in this genre -- an opened door is a changed tile -- and because
the map IS RAM, "which doors are open" rewinds for free with no bookkeeping.

---

## Where it strained

### Finding 1 -- A flag's NAME crosses the handshake; its BIT does not

> **Status: half closed.** A `flag-bit-mismatch` check now compares the two
> numbers and refuses a build where they disagree. The bit is still hand-copied;
> what changed is that copying it wrong is no longer silent. What is still open,
> and what the check cannot see, is spelled out under **What the check catches**
> at the end of this finding. The observation below is left as it was written.

**What I needed to express.** "This engine reads three flags out of
`SPRITE_FLAGS`, and it needs to know which bit each one is."

**What the interface let me say.** `[requires] tileset = { flags = ["solid",
"hazard", "door"] }`, which checks the **names** and nothing else. The tileset
does declare the bits -- `modules/overworld/module.toml` has `solid_flag = 1`,
`hazard_flag = 2`, `door_flag = 4` in `[provides]` -- and an engine has no way to
read a value out of another module's `[provides]`. `[provides]` is only ever a
thing to be *checked against*, never a thing to be *read from*.

**What I did instead.** Three knobs (`solid_flag`, `hazard_flag`, `door_flag`)
whose values a human copies out of the tileset's manifest into the recipe:

```toml
# examples/moss-keep/recipe.toml
solid_flag  = 1
hazard_flag = 2
door_flag   = 4
```

This is exactly what `platformer` does, and it is the load-bearing weakness of the
whole system. **Both modules know the answer and the format has no way to pass
it.** The recipe comment says "if you change the pack, change them here too --
nothing will tell you", which is an accurate and unpleasant sentence to have to
write.

There is a **partial** workaround I found by experiment and did not adopt. An
equality constraint pins the bits at stamp time:

```toml
tileset = { min_tiles = 64, flags = ["solid", "hazard", "door"], door_flag = 4 }
```

and a tileset using a different bit is refused:

```
error[unsatisfied-requires]  engine `topdown@1.0.0` requires tileset door_flag = 8,
    and `overworld@1.0.0` declares door_flag = 4.
```

It is half a fix and the wrong half. It makes the ENGINE refuse a tileset it could
actually have used, in order to catch a mistake in the RECIPE -- and it still does
not stop a recipe from setting `door_flag = 8` in `[tuning]` while the constraint
says 4. The check and the value remain unconnected.

**Should the interface change?** Yes, and this is the highest-value change of
everything in this file. See proposal **P1**.

**What the check catches, exactly.** `checkFlagBits` in
`packages/stamper/src/stages.ts` takes every `[provides] <x>_flag` a module
declares, looks for a bound knob of the same name, and refuses the build if the
two numbers differ. Against `examples/moss-keep` with `door_flag = 8` in
`[tuning]`:

```
error[flag-bit-mismatch]  `overworld@1.0.0` marks `door` on bit 4, and knob
    `door_flag` is 8: the engine would read bit 8 out of SPRITE_FLAGS and this
    tileset writes bit 4.
    One number, written in two files. Set  door_flag = 4  in [tuning] to match
    `overworld@1.0.0`, or use a tileset that marks `door` on bit 8.
    The value in force is 8, from recipe.
```

It fires on the engine's DEFAULT as readily as on a recipe line, so the sentence
this finding complained about -- "if you change the pack, change them here too,
nothing will tell you" -- is no longer true: swapping in a tileset that marks
`door` on a different bit now stops the build.

**What it does not do, and none of this is a detail.**

- **It reports a disagreement; it does not carry the value.** The recipe still
  hand-copies three numbers out of the tileset's manifest. That is P3, and P3 is
  not done. The gap this finding is really about -- `[provides]` can be checked
  against and never read from -- is exactly as open as it was.
- **It matches by NAME.** The rule is `[provides] <x>_flag` against a knob called
  `<x>_flag`. An engine whose knob is `wall_bit`, or a pack that declares its
  flag names without their bits, is not compared at all -- `checkFlagBytes` then
  falls back to the much weaker "some flag byte somewhere is non-zero".
- **It says nothing about which TILES carry the bit.** `tile_door` must name a
  tile the tileset marked `door`; nothing checks that, and it is the half of P2
  that did not land. See finding 2.

---

### Finding 2 -- An index knob is not checked against the pack it indexes

> **Status: closed for the range; the flag half is still open.** An `int` knob
> may now declare `indexes = "tileset"` or `indexes = "spriteset"`, and the
> stamper bounds its value against that pack's `[provides] base` and cell count.
> Both builds quoted below are refused today. See **What closed it** at the end
> of this finding; the observation is left as it was written.

**What I needed to express.** "`tile_door` is a tile number in the tileset this
recipe chose, so it must be less than that tileset's `tiles`, and it had better
carry the `door` flag."

**What the interface let me say.** `type = "int"`, `min = 1`, `max = 255`. The
bounds are properties of a byte, not of the tileset.

**What I did instead.** Nothing. There is nothing to do. The consequence was
measured rather than guessed:

```
# tile_door = 200, in a tileset with 64 tiles
    id  XTFYZVNT-H095D6Y9-QY9D3NTC-7ZS2FTYY
  size  43460 of 65536 bytes
proved  600 frames
```

It stamps. It proves a 600-frame chain. The keep's door is an empty tile the
walker strolls through, and the B button will never open anything, and no tool
anywhere says a word. The same is true from the other side:

```
# sprite_walk = 3, which is a grass tile in the TILESET's half of the sheet
    id  4MJP4CBK-QQNRF1YX-HZAAFGA4-VM0ADBTJ
  proved  600 frames
```

The player character becomes a tuft of grass, and the build is clean. This is
precisely the failure mode `manifest.ts`'s own header says the system exists to
prevent: "the difference between a template system that stamps working carts and
one that stamps plausible-looking broken ones". For structural constraints it
does prevent it. For index knobs -- which are the majority of the required knobs
in both engines -- it does not.

**Should the interface change?** Yes. See **P2**.

**What closed it.** One optional field on an `int` knob, `indexes`, taking
`"tileset"` or `"spriteset"`. `modules/topdown/module.toml` carries it on
eighteen knobs -- the twelve `tile_*` that reach `setTile` and the six `sprite_*`
that reach `gfx.spr` -- and `modules/platformer/module.toml` on seventeen. The
two builds measured above now stop:

```
error[index-out-of-pack]  knob `tile_door` is 200, and tileset `overworld@1.0.0`
    fills sheet cells 0 .. 63.
    `tile_door` indexes the tileset, so it has to name a cell that pack draws:
    `overworld@1.0.0` places 64 cells at [provides] base 0.
    Choose a number from 0 to 63, or use a tileset that reaches cell 200.
    The keep's locked door. It must carry the tileset's `door` flag, or the B
    button will find nothing to open.
```

```
error[index-out-of-pack]  knob `sprite_walk` is 3, and spriteset
    `wanderer@1.0.0` fills sheet cells 64 .. 95.
    `sprite_walk` indexes the spriteset, so it has to name a cell that pack
    draws: `wanderer@1.0.0` places 32 cells at [provides] base 64.
    Choose a number from 64 to 95, or use a spriteset that reaches cell 3.
    The first cell of the walk block: direction 0 (down), frame 0.
```

The `base` half is what catches the second one: `wanderer` sits at sheet row 4,
so a sprite knob is bounded to `64 .. 95` and cell 3 is refused for being a
**tile** rather than for being out of the sheet.

**Three things this does NOT close, and the notes should not be read as saying
otherwise.**

- **The flag half of P2 is untouched.** "`tile_door` had better carry the `door`
  flag" is still unstatable and unchecked. The index is bounded; what is drawn
  at that index, and what flags it carries, is not.
- **Only the knob's own value is bounded.** `sprite_walk` is the base of
  `4 * sprite_dir_stride` cells and `sprite_run` the base of `sprite_run_frames`
  of them. A base one cell inside a pack whose block runs off the end of it
  builds cleanly. So does a walk block laid out in the wrong direction order,
  which is finding 3 and is not affected by any of this.
- **The number is still a number.** P2's better form -- `tile_door = "door"`,
  resolved through a normative `[names]` -- needs P1, and P1 has not been done.
  Re-numbering a tileset still silently re-points every recipe that uses it; the
  difference is that a re-numbering which shrinks the pack is now caught, and one
  that merely shuffles it is not.

---

### Finding 3 -- There is no way to require named frames, or any layout, from a spriteset

**What I needed to express.** "I need a spriteset with a four-direction walk cycle,
and I need to know the order the directions are in."

**What the interface let me say.** `spriteset = { min_sprites = 20 }`. That is the
entire vocabulary: a count.

**What I did instead.** Two things, and the second is worse than it looks.

First, I compressed eight sprite knobs into two: `sprite_walk` (the base cell) and
`sprite_dir_stride` (the gap between directions), so the engine computes
`sprite_walk + facing * dir_stride + frame`. That trade saved six required knobs
and **moved an unstatable contract into the art pack**: `wanderer` must lay its
walk cells out in the order down, up, left, right, or the walker faces the wrong
way, and nothing in either manifest can say so. `modules/wanderer/module.toml`
says it in a comment and in an advisory `[sizes.walk_block]` table that the
stamper does not read. The platformer's nineteen hand-named sprite knobs are the
honest version of the same problem; this is the compressed version, and it trades
knob count for a silent convention. Both are workarounds for the same missing
concept.

Second: `[names]` already exists in every art pack and is **exactly the table that
would fix this** -- `walk_down = 64`, `slash = 72`, `coin = 80`. `manifest.ts`
declares it advisory on purpose:

> `[names]` and `[sizes]` are ADVISORY: an art pack lists what each tile or sprite
> index is so a person writing a recipe -- or a tool completing one -- does not
> have to open the art to find out which tile is the floor. The stamper reads
> neither, and refusing them would refuse every real pack.

The reasoning for accepting unknown keys is right. The conclusion that the
stamper should not *read* them does not follow from it, and this is the single
place where the format is standing next to the answer.

**Should the interface change?** Yes. See **P1** and **P2**, which are the same
change seen from two sides.

---

### Finding 4 -- The knob types are about determinism, and validation has nowhere to go

`KNOB_TYPES` is `fixed | int | bool`, and a knob's fields are exactly `type`,
`default`, `min`, `max`, `doc`. Both are enforced:

```
error[bad-manifest]  knob `bg_color` has type "color", which is not one of
                     "fixed", "int", "bool".
error[bad-manifest]  knob `bg_color` has no field `choices`.
                     A knob declares type, default, min, max and doc.
```

Four things I wanted and could not say:

| wanted | what it would have been | what I wrote instead |
|---|---|---|
| an **enum** | `face_prefer_x` is really "which axis names a diagonal facing" -- a two-valued enum, and it wants to be three-valued (`x`, `y`, `keep`) | a `bool`, and a `doc` sentence explaining what true means |
| a **colour** | `bg_color`, `hud_color` and three minimap colours are live palette slots, bounded by the palette pack's `entries` | `int` with `min = 0`, `max = 15` hard-coded to the console rather than to the pack |
| a **tile / sprite index** | see Finding 2 | `int`, `min = 1`, `max = 255` |
| a **list** | the four direction bases as one array; a set of decoration tiles | one knob each, or the base+stride convention of Finding 3 |

The type list being short is **correct** and should stay short. `manifest.ts` is
explicit that the three types are about determinism -- a `fixed` knob crosses as an
exact 16.16 numerator so two tools cannot disagree in the last bit -- and adding
types that do not change how a value is *emitted* would dilute a list that
currently means one clear thing. The missing concept is not a type. It is a
**domain**: a way to say what a well-typed `int` must additionally be true of. See
**P2** and **P4**.

The `bool` standing in for a two-valued enum is genuinely fine and I would not
change it. The colour case is mildly annoying and the index case is Finding 2.

---

### Finding 5 -- One module cannot require another by name, which is right

```
error[bad-manifest]  [requires] names "overworld", which is not a module kind.
                     The kinds are engine, palette, tileset, spriteset, soundbank,
                     content, tuning, shell.
```

**This is the interface working and it should not change.** An engine that could
name `overworld@1.0.0` would be an engine you cannot swap art on, and the whole
system would collapse into four modules that only work with each other. Requiring
a *kind* plus a *capability* is the correct shape.

The problem is only that the capability vocabulary is thin: today a capability is a
count, a flag name, or an equality. Findings 1, 2 and 3 are all "the capability I
needed was not expressible", not "I needed to name a module". Widening
`[requires]` is the fix; module-to-module dependency is not, and I am recording
that as a deliberate non-proposal so nobody reads Findings 1-3 and reaches for it.

---

### Finding 6 -- `[provides]` on an engine is decoration

`topdown` declares `[provides] entities = 32`. Nothing reads it. Nothing can: a
recipe has exactly one engine, so no other module is ever in a position to
`[requires] engine = { min_entities = 8 }`. Meanwhile the number is **duplicated**
into `[knobs.entities] max = 32`, and if the two ever disagree, the manifest is
lying and no check exists to notice -- `platformer` has the same duplication at 24.

Small, real, and cheap to fix: a rule that an engine's `[knobs.entities].max` may
not exceed `[provides].entities` would be one comparison. Or `[provides]` on an
engine could be dropped as a concept. I would not spend much on either, but the
duplication should be written down somewhere and this is that somewhere.

---

### Finding 7 -- Nothing declares USER_RAM, and `shell` is one of the eight kinds

`topdown` owns `0x7800` upward: eight scalars, then a 32-entity pool of 20 bytes,
to `0x7A50`. `platformer` owns the same addresses for a different layout. That is
fine while a cart has exactly one engine -- but `shell` is a documented module kind
("a title screen, a pause menu, a HUD wrapped around an engine") and a shell needs
state, and the only region for it is the one the engine is already in.

There is no `[provides] user_ram = { base = 0x7800, len = 592 }`, no
`[requires] user_ram = ...`, and therefore no way for a shell and an engine to
discover that they overlap. The first person to ship a shell will find this by
watching a pause menu corrupt an entity. See **P5** -- though nothing in this
milestone forced it, so it is a prediction rather than a scar.

---

### Finding 8 -- `[requires] tileset` has no vocabulary for how a tile is solid

Two things a top-down engine wants from a tileset that a platformer does not:

- **Directional solidity.** A cliff edge you can step down off but not up onto; a
  ledge solid from the north only. This is one flags byte with four bits and a
  collision routine that tests the bit facing the direction of travel.
- **Layers.** Ground under object: grass with a barrel on it, floor under a rug.
  Today `tile_barrel` has to have grass drawn into its own corners (which
  `modules/overworld/gen.mjs` does, tile 19, so a boulder sits ON a field rather
  than on the background colour), and a barrel on sand is therefore impossible.

Neither is only a manifest problem: the console has ONE `MAP ` region and ONE
flags byte per tile, so a second layer has no home in RAM and directional
solidity would have to spend four of the eight flag bits. But the manifest could
not have described either even if the console supported them -- `[requires]` has
`min_x`, `max_x`, `flags` and equality, and `flags` is a flat set of names with no
structure. I designed around both: one layer, one solidity, and a tileset whose
props carry their own backdrop.

This is the one finding where I am not sure the interface is wrong. `flags` as a
flat name set is honest about what SPRITE_FLAGS is. Recording it because a third
engine -- an isometric one, a lighting one -- will hit the same wall harder.

---

### Finding 9 -- A knob cannot be constrained against another knob

`wall_chance` and `water_chance` are percentages rolled out of the same hundred,
so `wall_chance + water_chance` must stay under 100 or ponds stop appearing. The
manifest can bound each at `0..100` and cannot say the third thing. The doc string
says it in English:

> Rolled after wall_chance out of the same hundred, so the two together must stay
> under 100.

`keep_x + keep_w` must stay inside `map_width`; `start_tile_x` must be at least two
chunks from `keep_x`; `sprite_dir_stride` should be at least `sprite_walk_frames`.
All of these are prose in a `doc`, all of them are checkable arithmetic, and none
of them is expressible.

**Should the interface change?** Probably not, or not soon. A cross-knob
constraint language is a real language -- it needs expressions, evaluation order
and its own diagnostics -- and it would be the largest thing in the stamper by
some margin, to catch mistakes that produce a *dull* game rather than a *broken*
one. Findings 1 and 2 produce broken games and cost far less to fix. Recorded, and
explicitly deprioritised.

---

## What I would change, in the order I would change it

**P1 -- Let `[requires]` ask for names, and make `[names]` normative.**

```toml
# in an engine
[requires]
tileset   = { min_tiles = 64, flags = ["solid", "hazard", "door"] }
spriteset = { names = ["walk_down", "walk_up", "walk_left", "walk_right", "slash"] }
```

`[names]` stops being advisory and becomes the pack's index vocabulary; a pack
that does not declare a name an engine asks for is refused at stamp time with the
same message shape `flags` already produces. This fixes Finding 3 directly and is
the smallest change that fixes anything real. Keep unknown top-level sections as
warnings exactly as they are -- this is one table becoming normative, not a
tightening of the format.

**P2 -- Two knob domains, not two knob types: `tile` and `sprite`.**
**DONE, in its range half. The flag half is not.**

What was proposed:

```toml
[knobs.tile_door]
type   = "int"
domain = "tile"          # bounded by the chosen tileset's `tiles`
flag   = "door"          # ...and must carry this flag
```

What shipped is the first line of it, spelled `indexes` and naming the module
kind rather than a new vocabulary of domains:

```toml
[knobs.tile_door]
type    = "int"
indexes = "tileset"      # bounded by the chosen tileset's base and cell count
```

The knob stays an `int` and is emitted as an `int`, so the determinism argument for
the short type list is untouched, and the field is optional so no manifest written
before it had to change. `indexes = "spriteset"` does the same against
`base .. base + sprites - 1`, which is what catches `sprite_walk = 3`.

`flag = "door"` was **not** built. "This index must name a tile carrying that
flag" is still unstatable, and it is the remaining half of this proposal.

With P1 in place the natural form is a name rather than a number --
`tile_door = "door"` resolved through `[names]` -- which is better still, because
then re-numbering a tileset does not silently re-point every recipe that uses it.
`indexes` does not get there; it bounds the number, and a number is still what a
recipe writes.

**P3 -- Publish the required flags' bit values into `KNOB` automatically.**

An engine that writes `flags = ["solid", "hazard", "door"]` in `[requires]` is
already naming exactly the three values it needs. The stamper knows which tileset
the recipe chose and can read `solid_flag` out of its `[provides]`. Emitting
`KNOB.solidFlag`, `KNOB.hazardFlag`, `KNOB.doorFlag` from that, with the recipe
allowed to override, would delete Finding 1 and three hand-copied numbers from
every recipe, and would leave both existing engines' source unchanged -- they
already read `KNOB.solidFlag`.

This is the change I would most like and the one I am least sure of, because it
introduces a knob an author did not declare, and "every knob is declared in one
place" is a good property to be trading away. A more conservative version: keep
the knobs declared and required, and let the stamper **fill their defaults** from
the tileset's `[provides]`.

**P4 -- An `enum` type, if and only if something else needs it.**

`face_prefer_x` wants to be `face_prefer = "x" | "y" | "keep"`. One knob in one
engine is not enough evidence. If a third engine wants an enum, that is the moment;
until then a `bool` and a `doc` are fine and I am recording this as *not yet*.

**P5 -- `[provides] user_ram = { base, len }` before the first `shell` ships.**

Cheap, mechanical, and it turns Finding 7 from a mystery corruption into an
overlap diagnostic. Worth doing pre-emptively because the failure it prevents is
the kind nobody debugs quickly.

---

## What I did not do

I did not touch `packages/stamper/src/manifest.ts`, or anything else under
`packages/`. Every workaround above is inside `modules/topdown`,
`modules/overworld`, `modules/wanderer` and `examples/moss-keep`. Where the
contract could not express something, the engine bent and the contract did not --
which is the only way this milestone measures anything.

---

## What happened afterwards

The findings above were written before the stamper changed. Two of them were
acted on at the end of M6, and the status boxes on findings 1 and 2 say what
landed:

- **`indexes`** on an `int` knob, bounding it against the pack the recipe chose
  (finding 2, and P2's range half). Both engines are annotated: seventeen knobs
  in `platformer`, eighteen in `topdown`. `modules/README.md` documents the
  field and the near-miss rule that decides which knobs get it.
- **`flag-bit-mismatch`**, comparing a pack's `[provides] <x>_flag` against the
  knob of the same name (finding 1, partially).

Annotating a manifest changes its content hash and therefore the cart id --
`module.toml` is hashed like any other file -- so all three example carts have
new ids and byte-identical 600-frame chains. That is the hashing rule working:
the compiled code and the installed data did not move, and the manifest did.

Findings 3, 5, 6, 7, 8 and 9 are untouched, and P1, P3, P4 and P5 are unbuilt.
