# `arcade`

The sixteen colours Red Breaker is played in, and the sixty-four cells it is
drawn with.

```bash
node modules/arcade/gen.mjs      # prints the `entries` line, rewrites tiles.bin
```

## What this module is

One pack that ships two things: a **palette** — sixteen of the console's 64
hardware colours — and a **64-cell sprite sheet** laid out exactly as
`modules/FORMATS-breakout-art.md` specifies.

`[module] kind` is `palette` because a module occupies exactly one recipe slot
and the stamper refuses a `palette` used as a `spriteset`; `breakout`'s
`[requires] palette = true` is the slot this pack has to fill. The art comes with
it because `[provides] data` is read **without regard to kind**: `mergeArt`
copies every layer's cells onto the sheet at `[provides] base` and its flags to
`SPRITE_FLAGS + base`, whatever `kind` that layer declared. So
`examples/red-breaker/recipe.toml` gets the palette and the art from the one
`palette = "arcade@1.0.0"` line it already had.

Splitting the art into a second module so it could be a `spriteset` was the
alternative, and it is worse: the palette and the art drawn *for* that palette
would live in two manifests that must be edited together, which is the exact
arrangement `gen.mjs`'s `REMAP` table exists to avoid.

## The rule the whole thing is built around: the hot ramp is danger

Breaking a type-4 block turns the ball red, and the player has **one contact** to
get their own paddle out of the way. There is no warning text: the ball changes
colour, and that is the whole notice.

A palette where anything else on screen is red, orange or pink spends the
mechanic's only channel on a power-up icon. So:

- **Slots 11, 12 and 14 are the only warm colours the cart can show**, and they
  are one hue in three steps: dark blood, danger red, hot orange.
- The other thirteen are drawn from the cool half of the hardware palette —
  blue, green, purple, gold, mint, and four neutrals.
- Those three appear on **four things and nothing else**: the type-4 block, the
  red ball, the beam that saves you from it, and the four frames of the paddle
  being destroyed by it. That is not four decisions; it is one mechanic drawn
  four times.
- The `life` drop is a **white heart**, not the red one every instinct asks for.
  An extra life is the opposite of danger, and it is the one icon that most has
  to not be red.

| slot | hw | rgb | role | what it is |
|---|---|---|---|---|
| 0 | 0 | `#0d0b12` | `0` | void. The transparent slot. |
| 1 | 1 | `#1c1a2b` | `1` | the field — `bg_color` — and every outline drawn on top of it |
| 2 | 12 | `#6ec27a` | `3` | green — WIDE drop, TOUGH block |
| 3 | 14 | `#4a9dd4` | `5` | blue — SLOW drop, PLAIN block |
| 4 | 10 | `#f7d46b` | `c` | gold — GUN drop, PRIZE block, the shot, a charged pad |
| 5 | 15 | `#9b6fd4` | `7` | purple — MULTI drop, HARD block |
| 6 | 6 | `#ffffff` | `a` | white — LIFE drop, the paddle, the ball |
| 7 | 44 | `#a4d8ab` | `2` | pale mint — CATCH drop, DRIFTER block |
| 8 | 11 | `#3f7d4e` | `4` | deep green — a TOUGH block that has taken a hit |
| 9 | 3 | `#6b6486` | `8` | mid slate — SOLID block, and a spent HARD one |
| 10 | 4 | `#a8a2bd` | `9` | silver — a SHIELDED block's frame |
| 11 | 8 | `#d94f5c` | `d` | **DANGER RED** — the red block, the red ball, the beam |
| 12 | 9 | `#f2934a` | `e` | hot orange — the pulse, the flare, the blast |
| 13 | 13 | `#2c5f8a` | `6` | deep blue — the side pads, and blue's shadow |
| 14 | 24 | `#873139` | `f` | dark blood — the hazard tape, the red ball's rim |
| 15 | 5 | `#e8e6f0` | `b` | near-white — the HUD, and the paddle's second row |

**Why not `sweetie16`**, which every other art pack here uses. It is a fine cave
palette and it is wrong for this engine for a reason that is arithmetic rather
than taste. `breakout`'s `drop_color` names the **first of six consecutive
slots**, one per drop kind in `DROP_MASK`'s bit order. Against `sweetie16` the
natural start is slot 8, which lays wide, slow, gun, multi, life and catch across
slots 8..13 — and **slot 11 of `sweetie16` is its danger red**. The `multi`
power-up would fall through the field in exactly the colour the ball turns when
it is about to kill you. `arcade` starts the drops at slot 2 and puts danger red
at 11, which is where `color_red`, `ball_red_color` and `beam_color` already
default to.

## The sheet

`FORMATS-breakout-art.md` owns the layout and this pack draws it, cell for cell.
`[provides] base = 0`, so a cell number in that table is also its sprite index
and `sprite_base = 0`.

**Cell 0 has ink in it, and that matters.** The engine decides at boot whether to
blit or to fall back to filled rectangles by reading the bytes of the cell at
`sprite_base` — 0 is a legitimate base and a knob cannot be told apart from
"unset". An all-zero cell 0 would silently leave the game drawing bars.

### Where the art sits inside each cell

The engine draws one group at a fixed y and centres the other on a collision box,
so art in the wrong half of its cell lands one to three pixels off — which at
this size is the difference between crisp and wrong.

| cells | what | placement |
|---|---|---|
| 0..15 | blocks | **rows 0..5 only.** Rows 6 and 7 empty |
| 16..21 | paddle, plain and with the gun | rows 0..2, full 8 wide (`paddle_h = 3`) |
| 28, 29 | side pads, idle and charged | rows 0..2, full 8 wide, left-right symmetric |
| 25, 26 | beam segments A and B | rows 0..1, full 8 wide (`beam_h = 2`), tiles seamlessly |
| 48..51 | the paddle destroyed | from row 0 down, so frame 1 lands on the paddle |
| 22 | the ball | centred: 6 x 6 outline ring, 4 x 4 of white inside it |
| 23, 24 | the red ball, A and B | centred, and **the whole 8 x 8 cell** |
| 27 | the shot | centred: 2 x 4 at cols 3..4, plus one row of trail |
| 32..43 | the six drops, two frames each | centred, 6 to 8 wide, outlined |
| 52..54 | the impact spark | centred |

**A block is 8 x 6 and a cell is 8 x 8.** The engine lifts the block out of the
top with `gfx.sspr(cx, cy, 8, 6, x, y)`, so the bottom two rows of cells 0..15
are never drawn. `gen.mjs` refuses to write `tiles.bin` if one pixel strays into
them — a pixel drawn there is not clipped or warned about, it is simply absent
from the game, and the failure looks exactly like a mistake in the art.

Raising `block_h` to 8 instead would push the bottom block row to y=105 against a
paddle at y=110, collapsing the player's reaction space from 28 pixels to 4 and
killing the red-block mechanic. Art must never cost the game a mechanic.

### Thirteen cells are blank on purpose

44..47 and 56..63, which the format reserves as spare, and **55**, which it
reserves for a ball trail this engine does not draw — keeping a trail means
keeping trail state, and those tokens went to the red-ball mechanic instead. They
are blank rather than filled because a cell with art in it that nothing blits is
a thing a later reader has to disprove.

Cells 30 and 31 are spare in the format and are drawn anyway: a HUD life glyph (a
paddle, because a paddle is what you lose) and a HUD ammo glyph (the bolt
itself). An engine that does not want them never names them.

## The drawing rules, and what they cost

These are what works at eight pixels, not style preferences.

**No dithering.** A block's face is 6 x 4. A checker or a one-pixel hatch in
there is not a texture, it is noise, and it eats the silhouette. Every fill is
flat. The one striped face — the red block — uses **two-pixel** stripes, which is
a stripe; a one-pixel version greyed the whole block out to a muddy rose.

**Silhouette first.** The six drops differ in outline *and* hue: a wide bar, an
hourglass, a turret, three balls, a heart, a cup, in green, blue, gold, purple,
white and mint. The gun drop was a finned rocket first and read as a capital A at
this size; a turret — narrow barrel on a wide base — has a direction and keeps
it.

**One light source, top-left.** Every block is a lit row across the top and a lit
column down the left, a shaded column down the right and a shaded row along the
bottom. Blocks tile edge to edge with **no gap**, so that bevel *is* the mortar:
a block's shaded right column butts straight against its neighbour's lit left
column, and forty blocks read as a wall of objects rather than one striped
rectangle.

**Outlines on what sits on top.** The ball and the six drops carry a one-pixel
edge in role `1` — the field's own colour. It is invisible against the field and
a hard edge against a block: one pixel doing a drop shadow's work for free.
Blocks get none; they sit in a grid against a dark field and have the bevel.

**Two hues per object, three at most.** Sixteen slots do not stretch to ramps.

## The two cells that carry the game

**The type-4 block (6) has to look dangerous before anyone has hit one.** Three
things do that, meant to be read in this order: it is the only warm thing on a
screen of blue, green and purple; it is the only striped face, and hazard tape is
not a pattern anyone has to be taught; and it pulses.

Cell 7 is the pulse frame, and **the ground does not change colour**. 6 and 7 are
two frames of one block breathing, not two blocks — a face that swapped its whole
ground every other frame strobes, and a strobing block is one a player stops
looking at. The bevel, the ground and the geometry are identical; only the
**tape** moves and lights, from dark blood to hot orange, marching two pixels. In
a period-4 pattern that lands the tape on the pixels that were ground a frame
ago, so the face inverts and slides in one step. It costs the engine one `& 1`.

**The red ball (23, 24) has to be unmistakable in under a second.** It is not a
recolour of cell 22, because a recolour asks the eye to compare hues and the eye
compares shapes faster. Four differences stack:

- **Bigger** — 8 x 8 against the white ball's 6 x 6, and four times the ink.
- **Rounder** — an octagon, where the white ball is a 4 x 4 with the corners cut.
- **Cored** — a hot orange centre the white ball has no equivalent of.
- **Flaring** — frame B lights the rim and throws four spikes off the corners,
  and `red_flash = 2` alternates them every other frame.

The white ball is deliberately small. Keeping it honest at the size of its own
collision box is the cheapest way to buy the red ball a silhouette visible in
peripheral vision.

**The life drop (40, 41)** is the icon a player most wants to recognise mid-fall,
so it is the only drop that is not a machine part, and the only heart-shaped
thing in the game. Frame B does **not** tumble — a silhouette that valuable
should not deform — it brightens: the shading flushes out and four sparks come
off the corners. A heart that is shining rather than spinning, and exactly as
recognisable in both frames.

**The paddle destroyed (48..51)** starts on the paddle's own three rows, so frame
one lands where the paddle was and the player sees *their* paddle catch rather
than an explosion drawn over it. Both lit rows blow out to pure white — brighter
than the paddle has ever been, in the frame it stops existing — then the bar
splits, the fragments are thrown apart, and the last frame is blood-dark embers
going down into the gutter the ball just went out of. Every cell is left-to-right
symmetric so it tiles across a paddle of any width and still looks like one
event.

## Flags

`tiles.bin` carries a flag byte per cell, and `[provides] flags` declares six
names with their **bit values**. The stamper now opens the file and refuses a
name no cell carries, so the manifest and the bytes are checked against each
other at every build.

| flag | bit | on |
|---|---|---|
| `solid` | 1 | every block face, 0..12 |
| `breakable` | 2 | every block face but 8 — type 5 is the only one that never counts |
| `red` | 4 | 6 and 7 |
| `shield` | 8 | 9 and 10 |
| `drift` | 16 | 11 |
| `prize` | 32 | 12 |

Nothing else on the sheet carries any: everything else is a sprite the engine
places by hand, and a flag on a drop icon would be a claim nothing reads. An
engine that reads a block's behaviour out of `SPRITE_FLAGS` rather than out of
its map byte wants exactly this table, and a knob named `<x>_flag` must hold the
same number — the stamper compares those two directly.

## Changing it

The palette and the art are both in `gen.mjs`. Edit, run it, and paste the
printed `entries` line into `module.toml`.

The art is written in **roles, not slot numbers** — one hex digit per pixel,
where the digit names what the pixel *is* and `REMAP` turns it into the live slot
this pack puts that role on. It is why the palette could be redesigned mid-project
without repainting sixty-four cells, and it is why it could be again: move a role
to a different slot in `PALETTE` and `REMAP`, and every pixel that meant that
role follows. `REMAP` is a permutation here — all sixteen roles are in use, and
`gen.mjs` asserts that it stays one.

The digits are grouped so a row of art reads at a glance: `1` is dark, `2 3 4` is
the green ramp, `5 6` the blue, `7 8` the purple, `9 a b` the neutrals, `c` gold
— and `d e f`, the last three, are the three danger colours. The end of the
alphabet is the end of you.

**Never hand-edit `tiles.bin`.** It cannot be reviewed, and a pixel changed there
and not in `gen.mjs` is lost the next time anyone regenerates. Regeneration is
byte-identical: no clock, no randomness, no floating point.
