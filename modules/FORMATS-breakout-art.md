# Red Breaker — the sprite sheet and the sound bank

Three modules have to agree on these: `breakout` (draws them), `arcade` (draws the art), and
`redsound` (writes the effects). Neither owns the layout; this file does.

Written before any of them, for the reason M4 and M5 both taught.

## The geometry problem, and the answer

A block is **8 wide and 6 tall**. A sheet cell is **8 x 8**. They do not match, and the
mismatch is why the first version of this game drew rectangles.

**The answer is `sspr`, not a geometry change.** The engine lifts an 8 x 6 region out of the top
of an 8 x 8 cell:

```js
gfx.sspr(cx, cy, 8, 6, x, y)      // 8x6 out of the cell at (cx, cy)
```

The bottom two rows of a block cell are unused. That is 25% of those cells wasted and it is the
right trade: raising `block_h` to 8 pushes the bottom block row to y=105 against a paddle at
y=110, collapsing reaction space from 28 pixels to 4 and killing the red-block mechanic. Art
must never cost the game a mechanic.

Everything that is not a block — the ball, the drops, the paddle caps — uses the full 8 x 8.

## Drawing rules for this size

From how the arcade originals held up at this scale, and it is mostly about what to leave out:

- **No dithering.** Below about 16 x 16 there is no room for a pattern to read; it reads as
  noise and muddies the silhouette. Blocks are 8 x 6. Use flat fills.
- **Silhouette first.** At 8 pixels a shape is recognised by its outline before any interior
  detail. If two block types have the same silhouette they must differ in hue, not in detail.
- **One light source, top-left, always.** A one-pixel highlight on the top and left edges and a
  one-pixel shade on the bottom and right is the whole of the bevel, and it is what makes a
  block read as a solid object rather than a coloured rectangle.
- **Outlines where a thing must pop.** The ball and the drops sit on top of everything and get a
  dark edge. Blocks sit in a grid against a dark field and do not need one.
- **Two hues per object, three at most.** Sixteen live colours across eight block types, a
  paddle, a ball, six drops and the effects means nothing gets a ramp.

## The sheet — cells are `sprite_base + N`

`sprite_base` is one knob; every cell below is a fixed offset from it, so the engine holds one
number and this table holds the layout. Cell `n` sits at sheet pixel
`((n & 15) * 8, (n >> 4) * 8)`.

### Row 0 — blocks (8 x 6 used, bottom two rows ignored)

| N | What |
|---|---|
| 0 | type 1 plain |
| 1 | type 2 tough, full health |
| 2 | type 2 tough, one hit taken |
| 3 | type 3 hard, full health |
| 4 | type 3 hard, one hit taken |
| 5 | type 3 hard, two hits taken |
| 6 | **type 4 RED**, and it must look dangerous before anyone has hit one |
| 7 | type 4 RED, bright pulse frame |
| 8 | type 5 solid — structure, visibly not a target |
| 9 | type 6 shielded — glass over something |
| 10 | type 6 shielded, struck by a ball and unhurt (one frame of flash) |
| 11 | type 7 drifter |
| 12 | type 8 prize |
| 13..15 | block break, three frames |

### Row 1 — paddle, ball, beam, shot

| N | What |
|---|---|
| 16 | paddle left cap |
| 17 | paddle middle, tiled to whatever width the paddle is |
| 18 | paddle right cap |
| 19..21 | the same three with the gun fitted |
| 22 | ball |
| 23 | **red ball**, frame A |
| 24 | **red ball**, frame B — it alternates, because the player has under a second to notice |
| 25 | beam segment, frame A |
| 26 | beam segment, frame B — it scrolls, so the beam reads as live rather than painted |
| 27 | shot in flight |
| 28 | side pad, idle |
| 29 | side pad, charged |
| 30..31 | spare |

### Row 2 — drops, two frames each so they tumble

| N | Drop |
|---|---|
| 32, 33 | wide |
| 34, 35 | slow |
| 36, 37 | gun |
| 38, 39 | multi |
| 40, 41 | **life** — the one a player most wants to recognise mid-fall |
| 42, 43 | catch |
| 44..47 | spare |

### Row 3 — effects

| N | What |
|---|---|
| 48..51 | paddle destroyed, four frames. This is what a red ball does to you; make it hurt. |
| 52..54 | ball impact spark, three frames |
| 55 | ball trail |
| 56..63 | spare |

Sixty-four cells used of 256. The rest is room to grow.

## The sound bank — 32 effects at `0x6300`

Format is in `FORMATS-breakout.md`: an 8-byte header then 32 steps of NOTE, MIX, FX.

**A pitch sweep is what makes one of these read as a sound rather than a beep.** A step list
climbing in semitones is a coin; falling is a drop; falling fast on the noise waveform is an
explosion. Almost every effect below is a sweep, a short envelope, and nothing else.

| # | Effect | Shape |
|---|---|---|
| 0 | ball hits a block | very short blip, up two semitones, pulse. Pitch rises with the row so a rally builds. |
| 1 | block breaks | short down-sweep with a noise tail |
| 2 | ball hits the paddle | lower, softer blip than a block — the player hears the difference without looking |
| 3 | ball hits a wall | quietest of the three; it happens most |
| 4 | drop appears | two quick rising notes |
| 5 | **drop caught** | bright four-note arpeggio up |
| 6 | **extra life** | the longest, warmest cue in the bank. It should be the best sound in the game. |
| 7 | shot fired | fast down-sweep, short |
| 8 | shot hits a shield | metallic tick, high pulse, very short |
| 9 | shield breaks | noise burst with a down-sweep |
| 10 | **ball turns RED** | an alarm. Rising, urgent, unmistakable, and unlike everything else in the bank. |
| 11 | **beam deflects the red ball** | a hard down-sweep — relief, and the player must know it worked |
| 12 | **paddle destroyed** | the worst sound in the game. Noise, low, slow decay. |
| 13 | life lost, ball out of play | short falling three-note |
| 14 | level cleared | rising fanfare |
| 15 | game over | slow falling four-note |
| 16 | side pad charged | two-note tick up |
| 17..31 | spare |

Two rules that matter more than the individual effects:

1. **Effects 0, 2 and 3 fire constantly.** They must be short, quiet and low-fatigue. A game
   that is annoying after ninety seconds has failed regardless of how good the fanfare is.
2. **Effect 10 must not resemble anything else in the bank.** It is the only warning the player
   gets, it arrives without notice, and they have about a second to act on it. It is the audio
   half of the red block being the only warm colour on screen.

## Music — patterns at `0x7000`

One short loop per level band is enough; the format holds 255 patterns. Keep it under the
effects in volume: this is a game where sound carries information, and the track must not bury
effect 10.
