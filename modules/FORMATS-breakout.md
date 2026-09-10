# Red Breaker — the shared data formats

Two modules have to agree on these bytes: `breakout` (the engine, which reads them) and
`redlevels` (the content pack, which writes them). Neither owns the format; this file does.

Written before either was built, for the reason M4 and M5 both taught: a format two agents
discover separately is a format they will disagree about.

## Where the level data lives

| Chunk | Address | What it carries |
|---|---|---|
| `MAP ` | `0x4300` | The block grid for all ten levels |
| `DATA` | `0x7800` | Ten 16-byte level headers, then the engine's own state |

Both are installed into RAM before the cart's `boot()` runs. See
`packages/runtime/src/cart-data.ts`.

## The block grid — `MAP ` at `0x4300`

The map is 128 tiles wide and 64 tall. A level is a **16 x 12** block of it.

```
level L  ->  column (L % 8) * 16 , row (L / 8) * 12
```

So levels 0..7 sit along the top of the map and levels 8..9 begin the second band. Ten levels
use 24 of the 64 rows; there is room for thirty more without changing anything.

Tile byte = block type:

| Value | Block | Behaviour |
|---|---|---|
| `0` | empty | nothing |
| `1` | plain | one hit, breaks |
| `2` | tough | two hits; shows damage after the first |
| `3` | hard | three hits |
| `4` | **red** | one hit, breaks, **and turns the ball red** |
| `5` | solid | never breaks; a wall inside the field |
| `6` | shielded | must be shot; a ball bounces off it |
| `7` | drifter | moves sideways with its row |
| `8` | prize | one hit, breaks, and always drops something |

### What counts as cleared

**A level clears when no block remains except type 0 and type 5.**

Note what that includes: **type 6 shielded blocks DO count** — a level is not clear while one
stands. That is deliberate, and it is what makes shooting *required* rather than decorative on
level 8. The consequence is a design constraint on the level pack:

> **Every shielded block in a level must be reachable by a shot the player can obtain in that
> level.** A shielded block placed as unreachable decoration is a softlock. Use type 5 for
> decoration; it never counts.

Type 5 solid blocks are scenery and obstacles, never objectives.

An earlier draft of this file said "a grid of only 5s and 6s would be uncompletable", which read
as though type 6 should not count. It was ambiguous, the engine had to choose, and it chose the
reading the game needs. This is the rule.

## The level headers — `DATA` at `0x7800`

Ten headers of 16 bytes: level `L` at `0x7800 + L * 16`.

| Offset | Name | Meaning |
|---|---|---|
| `0` | `MECHANIC` | which mechanic this level introduces, 0..9. See the table below. |
| `1` | `BALL_SPEED` | ball speed in 1/16 pixels per frame; 16 = one pixel |
| `2` | `PADDLE_W` | paddle width in pixels |
| `3` | `RED_COUNT` | how many type-4 blocks the grid holds, **1..4**; 0 for level 1 |
| `4` | `DROP_RATE` | chance in 256 that a broken block drops something |
| `5` | `DROP_MASK` | which drop kinds this level may produce, one bit each (see below) |
| `6` | `BALL_COUNT` | balls in play at serve; 1 except where a mechanic says otherwise |
| `7` | `DRIFT_SPEED` | sideways speed of drifter rows, 1/16 px per frame; 0 for none |
| `8` | `SIDE_PADS` | `1` if the side charge pads exist on this level |
| `9` | `AMMO_START` | shots the player begins the level holding |
| `10..15` | reserved | must be zero |

Drop kinds, one bit each in `DROP_MASK` and the same numbering in the engine:

| Bit | Drop | Effect |
|---|---|---|
| `0` | wide | paddle grows |
| `1` | slow | ball slows for a while |
| `2` | gun | grants shots |
| `3` | multi | splits the ball in two |
| `4` | life | **an extra life** |
| `5` | catch | paddle holds the ball until the button is pressed |

## The ten mechanics, one per level

Each level introduces one and keeps everything before it.

| L | `MECHANIC` | Introduces |
|---|---|---|
| 1 | 0 | plain breakout — learn the paddle and the ball |
| 2 | 1 | **red blocks**, one of them |
| 3 | 2 | **drops** — power-ups and extra lives fall from broken blocks |
| 4 | 3 | **tough blocks** that take more than one hit |
| 5 | 4 | **side pads** — touch one to charge a shot |
| 6 | 5 | **drifting rows** that slide sideways |
| 7 | 6 | **multiball** |
| 8 | 7 | **shielded blocks** that only a shot can break |
| 9 | 8 | **solid blocks** rearranging the field into lanes |
| 10 | 9 | everything at once, and **four red blocks** |

Difficulty rises across the ten independently of the mechanics: the ball gets faster, the
paddle narrower, and `RED_COUNT` climbs from 1 to 4.

## The red ball — the rule both modules must implement identically

The ball is `NORMAL` or `RED`.

1. Breaking a **type-4 block** sets the ball `RED`.
2. While `RED`, a red beam is drawn across the screen **below the paddle**, and only then.
3. `RED` ball touches the **paddle** -> the paddle is destroyed, a life is lost, the ball
   resets to `NORMAL`.
4. `RED` ball touches **anything else** — a wall, the ceiling, another block, the beam, a shot
   — -> it bounces as normal and the ball returns to `NORMAL`.

So a red ball is dangerous for exactly one contact, and the player has to do the opposite of
everything the rest of the game teaches: **get the paddle out of the way.** The beam is the
safety net under it, and a shot is the way to clear it early once the gun exists.

The beam is not a floor. It deflects only a `RED` ball; a normal ball falls straight past it
and is lost. Otherwise it would remove the only way to die.
