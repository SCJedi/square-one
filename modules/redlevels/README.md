# `redlevels`

The ten levels of Red Breaker. A `content` module: no code, no art, just the two
chunks `modules/FORMATS-breakout.md` describes.

```bash
node modules/redlevels/gen.mjs   # checks every level, then rewrites both files
```

`levels.map` and `levels.dat` are **output**. The levels are twelve strings of
sixteen characters each in `gen.mjs`, one character per block, so a change to a
level is a change to one character in a reviewable diff.

## The ten

Each level introduces one mechanic and keeps the ones before it. Difficulty
rises on three axes independently of the curriculum: the ball gets faster, the
paddle narrower, and `RED_COUNT` climbs from 0 to 4.

| L | mechanic | speed | paddle | red | blocks | shielded | ammo |
|---|---|---|---|---|---|---|---|
| 1 | plain | 22 | 32 | 0 | 48 | – | – |
| 2 | **red blocks** | 24 | 30 | 1 | 56 | – | – |
| 3 | **drops** | 26 | 30 | 1 | 70 | – | – |
| 4 | **tough blocks** | 28 | 28 | 1 | 44 | – | – |
| 5 | **side pads** | 30 | 28 | 2 | 50 | – | 0 |
| 6 | **drifting rows** | 32 | 26 | 2 | 50 | – | 0 |
| 7 | **multiball** | 34 | 26 | 3 | 49 | – | 0 |
| 8 | **shielded** | 36 | 24 | 3 | 51 | 12 | 16 |
| 9 | **solid** | 39 | 22 | 4 | 50 | 4 | 8 |
| 10 | everything | 44 | 20 | 4 | 54 | 6 | 12 |

`gen.mjs` prints this table, plus the frames each red block gives the player.

## Where the red blocks sit, and why it is the pack's central decision

Breaking a type-4 block turns the ball red, and a red ball that touches the
**paddle** costs a life — so for one contact the player has to do the opposite of
everything else the game has taught them and get the paddle **out of the way**.
The beam under the paddle catches it if they do.

Whether that is a mechanic or a mugging comes down to two distances.

**Height is reaction time.** A red block in row 1 is about 90 pixels above the
paddle; at level two's ball speed, a little over a second. The same block in row
8 is a third of a second, which is under human reaction time for a choice and
would be a coin flip rather than a decision.

**An open fall path is whether it happens at all.** Rule 4 of the format says a
red ball that touches *anything* but the paddle returns to normal — so a red
block buried in a wall is nearly harmless, because the ball clips a neighbour on
the way out and the red is gone before it matters. A red block with air below it
is the one the player has to answer.

So every red block in this pack has at least one face open to a large empty
region and a clear fall to the paddle row, and they descend the field level by
level — row 2 on level two, row 5 on level ten. They move inward as well: the
early ones sit at the screen edges where the paddle usually is not, and only
levels eight, nine and ten put one near the middle.

| L | red blocks | frames to the paddle |
|---|---|---|
| 2 | row 2, col 2 | 58 |
| 3 | row 1, col 13 | 58 |
| 4 | row 3, col 3 | 46 |
| 5 | row 3, cols 1 and 14 | 43 |
| 6 | row 3, cols 5 and 10 | 40 |
| 7 | row 0 col 7; row 5, cols 1 and 14 | 47, 32 |
| 8 | row 5, cols 1, 4 and 14 | 30 |
| 9 | row 5, cols 1, 6, 9, 14 | 28 |
| 10 | row 1, cols 1 and 14; row 5, cols 4 and 11 | 34, 25 |

**Level two is the one that had to be right**, because it is the only
explanation the mechanic ever gets. The single red block is the left shoulder of
the wall, with its left face open to a channel that runs the full height of the
screen and nothing above it. The ball can only take it from the left or from
above, so it leaves moving left and down into empty air — it does not clip a
neighbour, and the red survives to mean something. It falls at x = 8..24, and
the paddle spends that level near the middle returning a wall of plain blocks.
The player is already forty pixels away when it happens. **The first red ball
they ever see is one they survive by doing nothing** — and only then do they
find out what the beam is for.

The wall is a stepped trapezoid so the shoulder is exposed early rather than
being the last block standing. A lesson delivered once, at the end, is not a
lesson.

## Every level is completable, and `gen.mjs` refuses to write one that is not

The engine clears a level when **no block remains except type 0 and type 5**.
Type 6 shielded blocks *count*: that is what makes shooting required rather than
decorative. Every one of these runs before either file is written:

- a grid that is not 12 rows of 16, or holds a character that is not a type
- a `MECHANIC` that is not the level's own index
- a level with no block that counts toward the clear
- `RED_COUNT` above 4, or lower than the level before it — and it is *counted
  from the grid*, never written by hand, so the header cannot disagree with the
  art
- `BALL_SPEED` that does not rise, or `PADDLE_W` that does not narrow
- a shielded block without `AMMO_START` above the shielded count, `SIDE_PADS`,
  **and** `gun` in `DROP_MASK` — three independent guarantees that the gun
  exists, because a softlock is not the kind of bug you leave one guard against
- a **solid block anywhere below a shielded one**, which would block the shot
  that is the only way to break it
- **any counting block a flood fill from the open field below cannot reach**,
  treating type 5 as the only wall. Every other block is passable because every
  other block eventually becomes empty: a plain block in the way is a delay, a
  solid block in the way is forever. This is the softlock check.
- a drifting row reaching a column that slides off the screen edge. A block
  drifted past x = 127 cannot be hit and cannot be cleared; every drifting row
  here runs columns 2..13 and stays on screen at twice `drift_range`.
- a header switching on a mechanic the level has not reached, or setting
  `DRIFT_SPEED` with no drifter in the grid

All ten pass. Beyond the checks, all ten were rendered by the stamped cart
itself — level `L` swapped into slot 0 of a copy of the `MAP ` and `DATA` chunks
— and looked at.

## The engine defaults this pack is tuned against

`field_top = 10`, `block_h = 6`, `paddle_y = 110`, `drift_range = 8`. The first
three decide how much reaction time a red block in a given row gives, which is
the pack's central design number; the fourth decides whether level six's gap
genuinely closes. `gen.mjs` repeats all four at the top of its check section and
`examples/red-breaker/recipe.toml` sets them explicitly for the same reason. If
one changes, re-read the frame table `gen.mjs` prints.
