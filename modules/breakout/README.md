# `breakout` — the Red Breaker engine

A paddle, a ball, a grid of blocks, three lives and ten levels. It is the third
engine module and the first that is a **specific game** rather than a genre
kernel, and that difference is the whole point of it.

`platformer` and `topdown` generate their worlds: give them a seed and a handful
of chances and they build a cave or an overworld. **This engine generates
nothing.** Every level parameter is a byte in the `DATA` headers at `0x7800` and
every block is a byte in the `MAP ` chunk, both laid out by
[`../FORMATS-breakout.md`](../FORMATS-breakout.md), which neither this module nor
the level pack owns. Point a recipe at a different pack and it is a different
game running the same mechanics.

So the rule this module follows is sharper than "no magic numbers":

| a number that describes | lives in |
|---|---|
| **a level** — ball speed, paddle width, drop chance, how many balls serve, which mechanics are on | a header byte, read at run time |
| **the game** — how fast the paddle slides, how a bounce angles, how long a power-up lasts, what colour a tough block is | a knob in `module.toml` |

There is no `generate()` in `engine.js` and there must never be one.

---

## The red ball, which is the game

The ball is `NORMAL` or `RED` — bit 1 of its flags byte.

1. Breaking a **type-4 block** sets the ball `RED`.
2. While `RED`, and only then, a red beam is drawn **below the paddle**.
3. `RED` ball touches the **paddle** → paddle destroyed, life lost, ball `NORMAL`.
4. `RED` ball touches **anything else** — wall, ceiling, block, the beam, a shot
   → it bounces normally and returns to `NORMAL`.

The player has to do the opposite of everything the rest of the game teaches and
**get the paddle out of the way for one contact.**

**Rules 3 and 4 are one rule in the code, not two.** Every contact that is not
the paddle goes through `bounce()`, whose last act is to clear bit 1; the paddle
is the one contact that never calls `bounce()` at all. They cannot drift apart,
because they are a check and its complement.

**The beam is not a floor.** `contact()` tests the beam only when bit 1 is set,
so a normal ball falls straight through it and is lost. Softening that would
remove the only way to die, and `engine.test.ts` asserts it from both sides — the
red ball deflects, the normal ball does not.

---

## The ten mechanics

One per level, each kept afterwards, selected by the header's `MECHANIC` byte.
The engine tests `MECHANIC >= knob`, and the seven `mech_*` knobs are the mapping
between the pack's curriculum and the engine's behaviour — so a pack that wants
drops from level one moves one number in a recipe rather than editing code.

| level | `MECHANIC` | introduces | gate |
|---|---|---|---|
| 1 | 0 | plain breakout | — |
| 2 | 1 | red blocks | `mech_red` |
| 3 | 2 | drops | `mech_drops` |
| 4 | 3 | tough blocks | `mech_tough` |
| 5 | 4 | side pads | `mech_pads` |
| 6 | 5 | drifting rows | `mech_drift` |
| 7 | 6 | multiball | `mech_multi` |
| 8 | 7 | shielded blocks | `mech_shield` |
| 9 | 8 | solid blocks | — (a type-5 block is always solid) |
| 10 | 9 | everything, four red blocks | — |

Below its gate a block behaves as the player has already been taught: a type-4
block is an ordinary one-hit block, a type-2 takes one hit, a type-6 breaks to a
ball. That lets a pack place a shape early without teaching the wrong lesson.

**Drops** fall at `DROP_RATE`/256 from a broken block (a type-8 block always
drops), with the kind chosen from the set bits of `DROP_MASK`: wide, slow, gun,
multi, life, catch. A `RED` ball does not stop them falling.

**Shooting** exists two ways. The `gun` drop grants `gun_shots`, and where the
header sets `SIDE_PADS` the paddle charges one shot each time it arrives at a
side pad — arriving, not parking. A type-6 block breaks only to a shot, so on
those levels shooting is required rather than optional, and a shot also clears a
`RED` ball, which is the skilled way out of the panic window.

---

## What it draws with

**Two paths, chosen at boot by reading the sheet.**

| the recipe pairs | the engine draws |
|---|---|
| a spriteset | every block, the paddle, the ball, the drops, the shots, the beam and the effects, off the sheet at `sprite_base` |
| no spriteset | the same game in filled rectangles, in the live palette slots the `*_color` knobs name |

`art()` reads the 8 x 8 cell at `sprite_base` at boot and answers whether any
pixel of it is set; the answer lives in one RAM byte and `draw()` branches on it.
**The test is the sheet, not the knob** — a base of 0 is a perfectly good base,
and the first pack to sit at cell 0 would otherwise be invisible. It runs once,
because the sheet is installed before `boot()` and never changes after.

**A cart whose art pack went missing draws plainly. It does not draw nothing**,
and every colour knob still means exactly what it meant.

The layout is [`../FORMATS-breakout-art.md`](../FORMATS-breakout-art.md)'s and
not this module's: cell `N` of that table is `sprite_base + N`, so the engine
holds **one number** and that document holds the sheet. A knob per cell would let
a recipe move one of them and leave the other sixty-three behind.

**A block is 8 x 6 and a sheet cell is 8 x 8**, so a block is lifted out of the
top of its cell with `sspr` and the bottom two rows go unused. `block_h = 8`
would fit the cells and push the bottom row of blocks to y=105 against a paddle
at y=110, cutting the reaction gap from 28 pixels to 4 and killing the red-block
mechanic. **Art must never cost the game a mechanic.** Everything that is not a
block uses a whole cell, centred by `sprc` on the small box the physics uses — a
three-pixel ball keeps its centre rather than hanging down and right of itself.

**Where the engine puts each cell**, which is what a pack drawing against
`FORMATS-breakout-art.md` needs to know and is the one thing that document
leaves to the engine:

| cell | drawn at | so the art wants |
|---|---|---|
| blocks 0..15 | the block's own corner, top `block_w` x `block_h` of the cell | the block in the **top 6 rows**; the bottom two are never read |
| paddle 16..21, 48..51 | `(paddle_x, paddle_y)`, tiled every 8 across the paddle's width | the paddle along the **top** of the cell, since `paddle_y` is the row the ball bounces off |
| side pads 28, 29 | `(0, paddle_y)` and `(120, paddle_y)` | the same top alignment |
| beam 25, 26 | `(0, beam_y)` and every 8 across | the beam along the **top** of the cell |
| ball 22..24, drops 32..43, shot 27, spark 52..54 | **centred** on the collision box | the object near the **middle** of the cell |

Two things follow, and both are worth stating because they were the opposite
before there was any art:

- **Exactly one knob carries `indexes`, and it is `sprite_base`.**
  `../README.md` states the test exactly: it is whether `engine.js` hands the
  value to `gfx.spr` or to `setTile`. This one goes to both `spr` and `sspr`.
  Nothing else here does: `max_fx` is a count, `fx_frames` a duration,
  `red_flash` / `beam_flow` / `drop_spin` are periods in frames, every `*_color`
  is a live palette slot, every `sfx_*` a soundbank effect id and `music_a` /
  `music_b` / `music_c` soundbank **pattern** ids — the near-miss table's own
  second column, every one of them. A pattern is a bar of music, not a cell.
- **No knob is required.** A required knob is the right shape for something an
  engine cannot draw without, and this one can always draw. All 90 have a
  defensible default, and a recipe may set as few as none.

---

## Sound

**Seventeen events, seventeen `sfx_*` knobs**, and each knob defaults to the
effect number [`../FORMATS-breakout-art.md`](../FORMATS-breakout-art.md) gives
that event. Pair this engine with [`../redsound`](../redsound) and set nothing:
every event already points at the effect written for it.

| effect | knob | fires when | channel |
|---|---|---|---|
| 0 | `sfx_hit` | a block is hit and survives | 1 |
| 1 | `sfx_break` | a block breaks | 1 |
| 2 | `sfx_paddle` | the paddle returns a ball | 0 |
| 3 | `sfx_wall` | a side wall or the ceiling | 1 |
| 4 | `sfx_spawn` | a drop appears | 2 |
| 5 | `sfx_drop` | a drop is caught | 2 |
| 6 | `sfx_life` | the **extra life** is caught | 2 |
| 7 | `sfx_shoot` | a shot is fired | 2 |
| 8 | `sfx_ping` | a shielded block holds | 2 |
| 9 | `sfx_shield` | a shielded block breaks | 2 |
| 10 | `sfx_red` | **the ball turns RED** | 3 |
| 11 | `sfx_deflect` | the beam catches it | 3 |
| 12 | `sfx_smash` | the paddle is destroyed | 3 |
| 13 | `sfx_lose` | a ball falls out of the world | 3 |
| 14 | `sfx_clear` | a level is cleared, the last one included | 3 |
| 15 | `sfx_over` | the last life goes | 3 |
| 16 | `sfx_charge` | a side pad charges a shot | 2 |

**The channel is the engine's and not the recipe's**, because a channel plays one
thing at a time and therefore *which cue may interrupt which* is a mechanic:

- **0 and 1** carry the effects that fire many times a second. A song claims 2
  and 3 and leaves these two alone, because a song under a rally would be
  shredded.
- **2** carries drops, shots, shields and the pads. It costs the song its lead
  voice until the pattern turns over, which is the right trade for a cue the
  player has to act on.
- **3 is the important one.** `sfx_red` and `sfx_deflect` share it *on purpose*:
  the deflection cuts the alarm off mid-warble, so the player hears the warning
  **stop**. The same rule hands `sfx_over` the channel a frame after the loss cue
  took it, which is why "life lost" is heard on every life except the last — on
  the last one, what the player needs to know is that it is over.

**A lost ball and a destroyed paddle are different events.** They shared
`sfx_lose` once, and the sound could not tell the player which had happened.
Effect 12 is now the paddle and effect 13 the ball.

**The wall cue is not inside `bounce()`.** Every contact in the game passes
through `bounce` — a block, the beam, both walls, the ceiling — so a cue placed
there would play the wall on top of every block hit and every deflection. `edge()`
is the wall-and-ceiling half, and it is the only caller that sounds effect 3.
Effects 0, 2 and 3 separate on register, waveform and direction precisely so a
player knows *which* of the three fired; doubling them up throws that away.

With no soundbank in the recipe every one of these is silent, which is not an
error.

### The song

**Three bands, one per difficulty step, and the band is the whole of the
difficulty curve in the music.** A bank ships a short loop per band and plays it
faster as the game gets harder, so what the engine holds is *when* to change
band — never what a band sounds like.

| knob | default | what it says |
|---|---|---|
| `music_a` | 0 | the pattern the first band starts at; `-1` plays nothing |
| `music_b` | 2 | the second band's pattern |
| `music_c` | 4 | the last band's pattern |
| `music_level_b` | 4 | the level the second band takes over on, counted as the HUD counts levels |
| `music_level_c` | 8 | the level the last band takes over on |
| `music_mask` | 12 | the channels the song may use: 2 and 3 |
| `music_fade` | 30 | frames the band takes to come up to full volume |

Those defaults are [`../redsound`](../redsound)'s own table — patterns 0, 2 and 4
over levels 1–3, 4–7 and 8–10 — so a recipe pairing that bank sets none of them,
exactly as it sets none of the `sfx_*` knobs.

Three things about it are decisions rather than mechanics, and each is a decision
the other way round would have been defensible:

- **It starts at boot**, in `loadLevel`, which `boot()` calls last. This cart has
  no attract screen: the field is up, the paddle already slides and the first
  ball is sitting on it waiting for A. A game that draws on frame one should
  sound on frame one, and `music_fade` lets the theme arrive under the serve
  rather than cutting in.
- **It restarts only when the band changes.** A band is two bars. Clipping it at
  every level would say nothing the level number in the HUD has not already said,
  three times over on the way to level 4. "Which band is playing" is therefore
  state, so it is one byte of RAM at `0x7914` — a rewind that restored the game
  and not the band would be a determinism hole with a soundtrack.
- **It keeps playing through a lost life and through game over.** `music_mask`
  hands the song channels 2 and 3, and an effect that claims a music channel
  **takes** it: the song drops that voice until the pattern turns over. So
  `sfx_lose`, `sfx_smash` and `sfx_over` — all on channel 3 — play over a
  continuing melody with the bass out from under it for their length, which is
  the mix `redsound` is written for and is the sound of the floor going. Stopping
  the song instead would put a second of silence exactly where the cue is, and
  the player presses A into a track that never stopped.

---

## Animation

Two kinds, told apart by whether the animation belongs to the **world** or to a
**thing that happened**.

**Free-running**, and costing no state at all: the red ball's two frames every
`red_flash` frames, the beam's two segments stepping along the row every
`beam_flow`, a falling drop tumbling every `drop_spin`, and the red *block*
pulsing. All of it is `anim()`, a function of `sys.frame()` — and FRAME is
machine state at `0x20FC`, so a rewind restores the animation with everything
else.

**Event-driven**, and therefore state: a block break (three frames where the
block was), a ball's impact spark, a shielded block's flash. These have a
position and a life, so they are a pool of `max_fx` three-byte slots at `G_FX` —
`x`, `y`, and `kind << 4 | life`. `fx()` spawns, `timers()` ages, `fxDraw()`
draws. The life packs into a nibble beside the kind, which is the whole reason
`fx_frames` is capped at 5.

**The paddle's destruction is the one that stops the game.** A red ball on the
paddle takes the life *immediately* — `redHit` is unchanged and the engine test
still asserts it on the frame of the contact — and additionally sets `G_DEAD`.
While `G_DEAD` runs, `tick` skips the whole simulation and only draws: the four
frames play, the paddle cannot slide out from under them, and the serve cannot
be launched through them. **The bookkeeping does not wait; only the beat does.**

---

## The memory map

`DATA` fills `0x7800..0x789F` with the ten headers, so **this engine's own state
starts at `0x7900`** and never writes below it. `engine.test.ts` asserts that
directly: two hundred frames of scripted play, and the 256 bytes from
`USER_RAM` to `0x7900` come back byte-identical.

```
0x7900 + 0    LEVEL, LIVES, STATE
       + 4    PADX (i16 subpixels), PADW, AMMO
       + 8    WIDE, SLOW, CATCH timers
       + 12   DRIFT (i16 subpixels), DDIR, PADT
       + 16   ROWS  (i16 bitmask: row r drifts when bit r is set)
       + 18   DEAD  frames of the paddle's destruction left to play
       + 19   ART   1 when the sheet holds a picture at sprite_base
       + 20   BAND  the music band playing, + 1; 0 is a machine that is silent
       + 24   balls   max_balls x 10 bytes: x, y, vx, vy (i16), flags
       + ...  drops   max_drops x 4:  x, y (i16), kind + 1
       + ...  shots   max_shots x 3:  x, y, live
       + ...  blocks  grid_w * grid_h x 1: type | hits << 4
       + ...  fx      max_fx    x 3:  x, y, kind << 4 | life
```

316 bytes at the default knobs. Everything mutable is in there; the module-level
`var`s in `engine.js` are address constants and values derived from `KNOB`, which
is frozen at stamp time. That is what makes the rewind test a real claim.

**Positions are in sixteenths of a pixel**, because that is the unit
`BALL_SPEED` and `DRIFT_SPEED` already speak: 16 is one pixel per frame.

---

## Collision

**X and Y are resolved separately**, in that order. Resolving both at once has to
choose an axis to push out of, and the wrong choice is exactly how a ball snags
on a block's corner. A resolution never moves the ball backwards, so a ball that
starts inside a block stops rather than being flung across the field.

**A ball can never tunnel through a block.** `move()` splits a frame into

```
n = 1 + (m / (step_max * 16)) | 0
```

substeps, where `m` is the larger velocity component **or twice the level's ball
speed, whichever is bigger** — a bounce partway through a frame can raise a
component to `BALL_SPEED`, and the bound has to survive that. Each substep
therefore moves at most `step_max` pixels on either axis, and `step_max` (3) is
smaller than both block dimensions (8 x 6). At the fastest legal header,
`BALL_SPEED = 255` — just under sixteen pixels a frame — that is eleven substeps.
The engine test drives exactly that case and checks that a wall of blocks stops
the ball.

---

## Two things the format leaves the engine to decide

Both are stated here because a level pack has to know them.

1. **What counts as "cleared".** The engine advances when no block of a type
   other than 0 or 5 is left. **Solid blocks are scenery and never count;
   shielded blocks do**, which is what makes shooting required on level 8 rather
   than optional. A pack that wants a shielded block to be pure decoration should
   use a solid one instead.
2. **`RED_COUNT` (header offset 3) is not read.** It describes the grid the pack
   authored rather than anything the engine has to do; the engine finds the
   type-4 blocks in the map. It is still worth filling in — it is how a reader of
   the pack knows a level is a four-red level without counting bytes.

---

## Running the tests

```bash
npx vitest run modules/breakout
```

The suite builds the `MAP `, `DATA`, `GFX ` **and `SFX `** chunks **in memory**
from `FORMATS-breakout.md` and `FORMATS-breakout-art.md` rather than reading a
pack off disk, so it is green on its own and what it pins is the format rather
than one pack's choices.

The fixture sheet's cells **encode their own cell numbers** — cell `n` carries
`n` in the first three pixels of its top row, offset by two so that nothing
drawn cannot be mistaken for cell 0 — which is the one property a test of "did it
blit the right cell" needs, and it needs no art to exist yet. `cellDrawn()` reads
a blit straight back out of the framebuffer, so the block table, the red ball's
two frames, the gun paddle, the beam's scroll, the tumbling drop, the break
effect and the four frames of the paddle coming apart are all assertions about
pixels rather than about intentions.

**The fixture sound bank is 32 identical long effects**, because what a test of
"did it play the right effect on the right channel" needs is only that a sound be
*observable*: `snd.sfx(n, ch)` writes `n + 1` into channel `ch`'s `SEQ_SFX`
register at `0x2110 + ch * 16 + 0xC`, and a 32-step effect at 255 frames a step
leaves it there for longer than any test runs. So a channel's `SEQ_SFX` is
exactly "the last effect started here", and `playing(m, ch)` reads a sound back
out of RAM the way `cellDrawn()` reads a blit out of the framebuffer. **An empty
bank would not do**: a zero-length effect is released by the very next
`tickAudio`, so every sound assertion would pass on an engine that played
nothing.

**The fixture music bank is six patterns shaped the way `redsound` shapes its
own** — two bars a band, a voice on channels 2 and 3, `LOOP_START` on the first
bar and `LOOP_END` on the second — built out of those same long effects, so the
pattern the sequencer sits on stands still for the length of a test. The
sequencer's position is eight bytes of RAM at `0x77F8`, so `musicPattern()` reads
the song back out of the machine exactly as `playing()` reads an effect and
`cellDrawn()` reads a blit, and `songTick()` — the lead voice's countdown inside
its step — is how a test hears the difference between a band that **kept
playing** and one that was restarted under it.

**Music shipped once with no test that could hear it.** Seventeen effects were
wired and asserted; nothing called `snd.music`, and every test passed, because no
test can hear silence. That is why "the song" is a describe block of its own and
why its first assertion is simply that *something is playing after boot*.

Both paths are tested, and one test runs the same scenario down each of them and
demands the same outcome: **the art is a skin and must never be a rule.**
