# `redsound`

Red Breaker's sound: seventeen effects, twelve music voices and three level
themes, for the four-channel chip synth in `packages/runtime/src/audio.ts`.

```bash
node modules/redsound/gen.mjs   # checks the bank, then rewrites both files
```

`sfx.bin` and `music.bin` are **output**. The bank is tracker text in `gen.mjs`,
one line per step — note, volume, waveform, effect — so a changed sound is a
changed character in a reviewable diff.

## Nobody who made this could hear it

Neither can the test suite. So every claim below is a number that
`test/sound.test.ts` produces by running the real sequencer and the real mixer
over the real bytes, and the table is checked against the bank on every test run.
If you have ears, this table is what to check against; if a row disagrees with
what you hear, the row is a bug and the suite will tell you which.

Measurements are at 48 kHz, 60 frames a second, one effect alone on one channel.
**Peak is out of 1.0, where one channel at full volume is 0.25** — the mixer sums
four channels at quarter scale, which is what leaves the rail clear.

| # | effect | steps x speed | seq | audible | ms | peak | start | end | direction | voice |
|---|---|---|---|---|---|---|---|---|---|---|
| 0 | ball hits a block | 2x1 | 2 | 3 | 50 | 0.083 | 72 | 74 | up | pulse 22% |
| 1 | block breaks | 6x1 | 6 | 7 | 117 | 0.150 | 76 | 54 | down | pulse then noise |
| 2 | ball hits the paddle | 2x1 | 2 | 3 | 50 | 0.067 | 60 | 62 | up | pulse 53% |
| 3 | ball hits a wall | 2x1 | 2 | 3 | 50 | 0.047 | 67 | 66 | down | triangle |
| 4 | drop appears | 2x3 | 6 | 7 | 117 | 0.117 | 69 | 76 | up | pulse 22% |
| 5 | drop caught | 4x3 | 12 | 13 | 217 | 0.167 | 72 | 84 | up | pulse 53% |
| 6 | **extra life** | 32x3 | 96 | 104 | 1733 | 0.232 | 60 | 84 | up | triangle |
| 7 | shot fired | 4x1 | 4 | 5 | 83 | 0.117 | 88 | 67 | down | pulse 9% |
| 8 | shot hits a shield | 2x1 | 2 | 3 | 50 | 0.100 | 91 | 89 | down | pulse 9% |
| 9 | shield breaks | 5x1 | 5 | 7 | 117 | 0.183 | 84 | 52 | down | noise |
| 10 | **ball turns RED** | 24x2 | 48 | 50 | 833 | 0.250 | 76 | 85 | oscillating | **saw** |
| 11 | **beam deflects it** | 12x2 | 24 | 28 | 467 | 0.200 | 84 | 33 | down, then holds | pulse 53% |
| 12 | paddle destroyed | 16x3 | 48 | 58 | 967 | 0.217 | 60 | 24 | down | noise |
| 13 | life lost | 3x5 | 15 | 17 | 283 | 0.150 | 67 | 55 | down | pulse 53% |
| 14 | level cleared | 14x4 | 56 | 61 | 1017 | 0.217 | 60 | 84 | up | pulse 22% |
| 15 | game over | 6x10 | 60 | 68 | 1133 | 0.182 | 60 | 48 | down | triangle |
| 16 | side pad charged | 2x2 | 4 | 5 | 83 | 0.117 | 79 | 84 | up | pulse 22% |

`seq` is the frames the sequencer holds the channel; `audible` adds the release
tail, and is what a player hears. Notes are semitones from C0, so 60 is C5, 72 is
C6 and 84 is C7. `direction` for effect 10 is *oscillating* because that is the
one thing it does that nothing else does — see below.

## Rule one: the three that fire constantly

Effects 0, 2 and 3 are the block hit, the paddle hit and the wall hit. They are
what ninety seconds of a rally is made of, and a bank that is tiring after ninety
seconds has failed however good the fanfare is.

| | measured |
|---|---|
| loudest of 0, 2, 3 | **0.083** |
| quietest of the other fourteen | 0.100 |
| mean peak of 0, 2, 3 | 0.066 |
| mean peak of the other fourteen | 0.171 |
| length of each of 0, 2, 3 | 3 frames, 50 ms |
| mean length of the other fourteen | 30.9 frames |

They are strictly the three quietest effects in the bank, by a 17% margin over
the next one up, and nothing in the bank is shorter than they are.

**They separate on three axes at once**, because a player has to know *which* of
the three fired and three blips differing only in volume are one blip:

| | register | waveform | direction |
|---|---|---|---|
| 0 block | C6, the highest of the three | pulse, 22% | rises |
| 2 paddle | C5, an octave below | pulse, 53% — rounder | rises |
| 3 wall | G5, between them | triangle — the softest voice the chip has | falls |

Rendering ninety real seconds of a plausible rally — a wall bounce every 24
frames, a paddle return every 72, a block hit every 48, a break every 96, over
the level 1–3 theme — gives a **peak of 0.258 and an RMS of 0.036**, with
something sounding in 26% of frames. The alarm's peak is 6.9x that RMS.

## Rule two: effect 10 is unlike everything else

The ball turning red is the only warning the player gets, it arrives without
notice, and they have about a second to do the opposite of everything the game
has taught them. So it is measured against the rest of the bank rather than
asserted to be different.

**The metric.** Each effect gets a pitch contour (one note per step, a rest
holding the note before it) and a loudness contour (per-frame RMS over the
sequenced frames — the release tail is excluded because every effect has one and
a shared fade says nothing about identity). Both are squashed to 32 bins by
averaging, and correlated. `shape` is the mean of the two correlations.

`shape` is deliberately blind to timbre and to absolute register, so it is
multiplied by a `voice` term — waveforms in common, plus register shared — to get
`confusable`. Two effects can only be mistaken for each other if they are the
same gesture *and* the same instrument in the same part of the keyboard.

| | effect 10's nearest neighbour | the closest pair among the other sixteen | median pair |
|---|---|---|---|
| shape | **0.096** (effect 15, game over) | 0.982 (effects 11 and 12) | 0.000 |
| confusable | **0.036** (effect 5, drop caught) | 0.567 (effects 1 and 9) | 0.000 |

The alarm's nearest neighbour is **ten times further away than the bank's closest
pair** on shape and **sixteen times further** on confusability. Five independent
things put it there:

1. **It is the only saw in the bank**, effects and music alike.
2. **It oscillates.** Its pitch contour turns round 11 times; no other effect
   turns more than twice.
3. **Its mean pitch does not move.** The two notes are centred on F#6 and *widen*
   — a minor third, then a tritone, a minor sixth, a minor seventh, an octave, a
   major ninth — rather than climbing. That is why it correlates with nothing
   that rises and nothing that falls.
4. **Its loudness is flat.** `ENV_D` is 0, so the level holds while the gate is
   open and the throb comes from the volume column. Every other effect in the
   bank decays.
5. **It is the loudest effect in the bank** at 0.250, and the highest: B5 to C#7,
   entirely above the melody's A5 ceiling.

The first draft climbed a semitone every four steps and measured **0.50** against
the level-clear fanfare, which is far too close for the only warning in the game.
Widening a fixed-centre interval instead is what took it to 0.096. `gen.mjs`
refuses to build a bank that puts a saw, a volume-15 step, or a note at or below
A5 into effect 10's neighbours.

### The one pair that does measure close, and why it is fine

Effects 11 and 12 — the beam catching the red ball, and the paddle being
destroyed — measure **0.982 on shape**. They are both long downward glides, so
the shape metric, which cannot hear timbre, puts them almost on top of each
other. They are also the two cues in the game that must never be confused.

Their `voice` overlap is **0.225** and their confusability is **0.221**, because
one is a pitched square wave and the other is unpitched noise. And they differ in
gesture where it counts: **effect 11 lands.** It falls a tritone a step from C7
down to C4, then three fourths down to A2, and then it stops — holding A2 for a
quarter of its length. That plateau is the difference between "something is
falling" and "something was caught", and A2 is the root the whole soundtrack is
built on. Effect 12 is still descending on its last step and runs twice as long.

## Effect 6, the extra life

The longest and warmest thing in the bank, and the only effect that uses all 32
steps the format allows: 96 sequenced frames, 104 audible, **1.73 seconds** —
about 15x the bank's median effect. A triangle throughout, because it is the
waveform with no odd-harmonic buzz and no duty to argue with, and it stays soft
at a volume that would make a pulse shrill.

It is a two-octave run up the C major triad to C7, a held C7, then a second
shorter climb that arrives at the same C7 and stays there for half a second on a
160 ms release. **Two arrivals at the same note**: the first says it happened,
the second says it is yours. It is the second loudest effect in the bank at 0.232,
behind only the alarm.

## Headroom

The mixer sums four channels and multiplies by 0.25, so nothing needs a limiter —
but only if the bank stays inside that budget.

| mix | peak |
|---|---|
| the four loudest effects at once (10, 6, 14, 12) | 0.787 |
| the engine's busiest realistic frame (paddle, break, drop, alarm) | 0.498 |
| the pathological case: effect 10 on all four channels, phase-locked | 1.000 |
| ninety seconds of a rally with the theme playing | 0.258 |

Nothing clips. The clamp in `renderAudio` never fires, including in the
pathological case, which lands exactly at the rail and which the engine cannot
produce anyway — it never plays the same effect on more than one channel.

## The music

Three level bands, two bars each, two voices a bar. A bar is one pattern; the
first pattern of a band carries `LOOP_START` and the second `LOOP_END`, so each
band is a self-contained loop started with one call.

| band | levels | patterns | start it with | speed | a bar | key |
|---|---|---|---|---|---|---|
| A | 1–3 | 0, 1 | `snd.music(0, fade, 0b1100)` | 6 frames a step | 3.2 s | A minor, on the beat |
| B | 4–7 | 2, 3 | `snd.music(2, fade, 0b1100)` | 5 | 2.7 s | A minor, eighth-note bass |
| C | 8–10 | 4, 5 | `snd.music(4, fade, 0b1100)` | 4 | 2.1 s | A harmonic minor, pedal bass |

The band gets faster as the game gets harder and that is the whole of the
difficulty curve in the music — not a key change and not a new melody, because a
player on level 9 is not listening to the music.

### How the mix stays clear

The track must never bury effect 10, and four independent things stop it:

| | measured |
|---|---|
| peak of each band, alone | 0.109, 0.114, 0.106 |
| RMS of each band, alone | 0.0247, 0.0266, 0.0294 |
| effect 10's RMS | 0.1306 |
| **alarm RMS over the loudest band's RMS** | **4.4x** |

1. **Level.** The lead is volume 3/15 and the bass 4/15. Together they are under
   half of effect 10 on its own, and every band's peak is below every effect's
   peak in the table above. RMS — loudness over time — is the number that matters
   here, because a quiet track that sits on a warning continuously still masks
   it; the alarm is 4.4x the loudest band on that measure.
2. **Register.** No music voice goes above A5. Every note of the alarm is above
   B5. They do not share a single semitone, so there is nothing for the song to
   mask the alarm *with*.
3. **Timbre.** The music is pulse and triangle only. Saw and noise belong to the
   effects, and the alarm is the only saw anywhere.
4. **Channels.** The song claims channels 2 and 3 and leaves 0 and 1 to the
   engine, which fires the block, break and paddle effects there many times a
   second — a song on those channels would be shredded. An effect claiming a
   music channel takes it, and the song simply drops that voice until the pattern
   turns over. Put the alarm on channel 3 and it silences the bass for 800 ms,
   which is the right trade and the right channel.

`gen.mjs` refuses to build a music voice above A5, above volume 4, or on saw or
noise.

## Wiring it to the engine

The effect numbering is the one `modules/FORMATS-breakout-art.md` fixes, and that
file owns it. **`breakout@1.0.0` now defaults every one of its seventeen `sfx_*`
knobs to that table**, so a recipe pairing these two modules sets none of them
and hears the right effect for every event. The defaults were once a straight run
0..5, which lined up with nothing — `sfx_drop` pointed at the wall hit — and a
default that is a plausible number rather than the right number is worse than no
default, because nothing is wrong enough to notice.

| effect | knob | fires when | channel |
|---|---|---|---|
| 0 | `sfx_hit` | a block is hit and survives | 1 |
| 1 | `sfx_break` | a block breaks | 1 |
| 2 | `sfx_paddle` | the paddle returns a ball | 0 |
| 3 | `sfx_wall` | a side wall or the ceiling — `edge()`, not `bounce()` | 1 |
| 4 | `sfx_spawn` | a drop appears out of a broken block | 2 |
| 5 | `sfx_drop` | a drop is caught | 2 |
| 6 | `sfx_life` | the **extra life** is caught | 2 |
| 7 | `sfx_shoot` | a shot is fired | 2 |
| 8 | `sfx_ping` | a shielded block holds | 2 |
| 9 | `sfx_shield` | a shielded block breaks | 2 |
| **10** | `sfx_red` | **the ball turns RED**, in `damage()` | 3 |
| **11** | `sfx_deflect` | the beam catches it | 3 |
| **12** | `sfx_smash` | the paddle is destroyed, in `redHit()` | 3 |
| 13 | `sfx_lose` | a ball falls out of the world | 3 |
| 14 | `sfx_clear` | a level is cleared, the last one included | 3 |
| 15 | `sfx_over` | the last life goes | 3 |
| 16 | `sfx_charge` | a side pad charges a shot | 2 |

**Channel 3 is the important channel.** Putting the alarm and the deflection both
on it is deliberate: the deflection cuts the alarm off mid-warble, which is
exactly what happened. Effect 12 and effect 13 belong there for the same reason —
whatever is playing, the player needs to hear that they lost — and effect 15
takes the channel from effect 13 a frame later, which is why a player hears "life
lost" on every life except the last.

### The song, and the three knobs that place its bands

The engine starts the music in `loadLevel`, so it begins under level one's serve,
and **it changes band and only changes band**: a two-bar loop restarted at every
level would be clipped three times on the way to level 4. `breakout`'s seven
music knobs default to this module's own table, so again a recipe sets none of
them:

```toml
music_a       = 0     # band A, levels 1-3
music_b       = 2     # band B, levels 4-7
music_c       = 4     # band C, levels 8-10
music_level_b = 4     # the level band B takes over on, as the HUD counts levels
music_level_c = 8     # and band C
music_mask    = 12    # channels 2 and 3, the `music_mask` in module.toml
music_fade    = 30    # half a second of fade-in when a band starts
```

`music_a = -1` is a bank that ships effects and no music; the engine reads that
straight through to `snd.music(-1, ...)`, which plays nothing.

**The song is never stopped**, not for a lost life and not for game over, because
this bank is mixed for exactly that: an effect claiming a music channel takes it
and the song drops that voice until the pattern turns over. Effects 13, 12 and 15
are all on channel 3, so each plays over a continuing melody with the bass out
from under it for its length — 800 ms for the alarm, about a second for the game
over. Silencing the track under the cue would cost the mix the thing that makes
the cue land.

## What this machine cannot do

Two things the design asks for that a four-channel chip cannot give, stated
plainly rather than fudged:

- **"Pitch rises with the row so a rally builds"** (effect 0). One effect id is
  one fixed step list, and `snd.sfx(n, ch)` carries no transpose. A rally that
  climbs needs one effect per row band — slots 29..31 are free, and 17..28 could
  move up — plus an engine that picks between them from the row it just hit.
  Nothing in the bank or the format can do it from a single id.
- **The fifth waveform.** `WAVE.WAVETABLE` reads the 16-byte master block at
  0x2150. That is a *register*, not a cart chunk, so a soundbank cannot ship it:
  a cart that wants a custom waveform has to write those bytes itself at boot.
  Nothing in this bank uses it, and the suite pins that.

## Layout

| file | bytes | what |
|---|---|---|
| `sfx.bin` | 3328 | the whole `SFX ` region at 0x6300 — 32 slots of 104. Effects 0–16 are the game, 17–28 are the music voices, 29–31 are silent |
| `music.bin` | 48 | the first six patterns of `MUS ` at 0x7000. Patterns 6–254 stay zero and no band reaches them |
