# @sq1/prime

**Square One Prime** — a deterministic 60 Hz simulation core, a display list, a reference
renderer, and the first cart written against them: *Red Breaker*, ported from the 128 x 128
console.

You do not need to know the rest of this repository to read this file.

---

## The one idea

The small Square One console guarantees **pixels**: two machines running the same cart with the
same inputs produce the same 128 x 128 framebuffer, and its conformance suite hashes that
framebuffer every frame. That works because a small software rasterizer is deterministic by
construction.

Put a GPU under it and the guarantee collapses. Drivers differ, vendors differ, the same driver
differs across a version bump. So Prime moves the line:

> **The simulation is normative. The picture is not.**

Two conformant Prime machines given the same cart, the same seed and the same inputs MUST reach
identical *simulation state* on every tick. They are under no obligation to produce identical
pixels, and on real hardware they will not.

Everything else follows. Replays, rollback netplay, save states, verifiable scores and
time-travel debugging are all the same mechanism, and that mechanism now survives a renderer
rewrite, a new backend, or a port to hardware that did not exist when the cart shipped.

---

## What is in this package

| File | What it is |
|---|---|
| `src/arena.ts` | The arena: one 1 MB buffer holding the complete mutable state of a simulation. A snapshot is a copy of it and nothing else. |
| `src/prng.ts` | PCG64-DXSM, the machine's only source of entropy. Its state lives **in the arena**, so it travels inside every snapshot. |
| `src/math.ts` | `sin`, `cos`, `atan2` — the console's own, because IEEE 754 does not specify them and libms differ. `sqrt` is the platform's, because IEEE 754 *does*. |
| `src/sim.ts` | The machine: `boot`, one `step` per tick, `present`, `snapshot`, `restore`, and the wall that stops `render` writing the arena. |
| `src/hash.ts` | The conformance chain — SHA-256 of the arena per tick, chained. |
| `src/draw.ts` | The display list a cart writes into: shapes, a transform stack, eight layers, additive blending, bloom and shake. |
| `src/render.ts` | The reference renderer. Non-normative by definition. |
| `src/player.ts` | The browser shell: the fixed-step clock, quantized input, pause, and `prefers-reduced-motion`. |
| `src/audio.ts` | The mixer: seventeen effects synthesised from oscillators, filters and envelopes, four channels of interruption, and the autoplay contract. |
| `src/music.ts` | The song: three bands, two bars each, and the scheduler that loops them. |
| `src/carts/breakout.ts` | **Red Breaker.** The cart. |
| `src/carts/levels.ts` | Its ten levels, as data. |

Only `src/index.ts`'s exports are normative. The display list, the renderer and the carts are
presentation and are deliberately not exported from it.

---

## Running it

From the repository root:

```sh
npm install

npx vitest run packages/prime/test/     # the suite
npx vite                                # then open /examples/prime/index.html
```

Vite serves the TypeScript directly, so there is no build step. The example page mounts a cart
in the shell and is there to be **looked at** — a renderer that passes every unit test and still
looks wrong is the normal failure, and the only instrument that catches it is a pair of eyes.

---

## The cart: Red Breaker

Ten levels, eight block types, drops, side charge pads, a gun, three lives — and one rule the
whole game is built on.

### The red ball

1. Breaking a **type-4 block** sets the ball **RED**.
2. While RED, and only then, a red beam exists **below the paddle**.
3. RED ball touches the **paddle** → the paddle is destroyed, a life is lost, the ball goes
   with it.
4. RED ball meets a **breakable block** — types 1, 2, 3, 4, 8 — and **passes through it**,
   destroying it outright whatever it had left, without deflecting. It keeps going and it
   **stays RED**.
5. Walls and the ceiling bounce it, and it **stays RED**.
6. **Solid and shielded blocks bounce it**, and it **stays RED**. Those two are the level
   designer's structure rather than his contents, and a red ball that ate them would clear level
   8's shielded wall — the one level built to *require* the gun.
7. RED ball touches the **beam** → it deflects **and** returns to normal. **That is the only
   thing that clears it**; a shot passes through a red ball and does nothing.

So a red ball is a **wrecking ball, and it is clearing the level for you.** The player wants it
alive and wants it nowhere near the paddle — still the opposite of everything the rest of the
game teaches, but the other way round: you steer away from your own ball, and the beam under the
paddle is where you finally catch it.

**The clear is one function with one caller.** `deflect()` is the only code in the cart that
masks bit 1 off a live ball and the beam branch of `contact()` is its only caller, while
`bounce()` — every wall, every ceiling, every deflecting block — does not touch the flags byte at
all. A contact added later therefore keeps rule 5 for free and *cannot* clear a red ball by
accident. It is the same argument the old rule made in its old shape: one writer, and everything
else structurally unable to be a second. A **third state**, if a deflection is ever to leave the
ball as something other than normal, is written in `deflect()` and nowhere else.

Rules 4 and 6 are **one decision** as well: `damage()` answers *whether the ball must bounce*,
because what is left of a block and whether it stopped you cannot be two checks that disagree if
they are one return value. Solid and shielded answer "bounce" before the red test is reached, so
rule 6 wins without rule 4 having to know about it.

**The beam is not a floor.** It deflects a RED ball and nothing else — a normal ball falls
straight through and is lost. Softening that would remove the only way to die, so
`test/breakout.test.ts` asserts it directly, under a heading that says so.

### What the port changed, and what it deliberately did not

The simulation runs in a **128 x 128 field of f64 units** — the small console's own geometry,
block for block — and `render` maps that onto the ABI's 1920 x 1080 logical space at scale 8.

That is the one thing the port must not get wrong. The gap between the lowest block and the
paddle *is* the reaction time the game gives you, and it is why a block is 8 x 6 rather than
8 x 8 on the small machine: a taller block would cut the gap from 28 units to 4 and kill the red
mechanic outright. Rescaling by a single factor preserves every such ratio exactly, so the level
pack's reaction-time table — about a second on level two, about four tenths on level ten — stays
true without being recomputed.

What the floats buy is everything *below* a unit: the ball moves in fractions, the paddle
accelerates into a direction change, and `render` interpolates by `alpha`, so a 144 Hz display
shows 144 distinct positions of a 60 Hz ball.

### Where the fidelity went

| Layer | What it holds |
|---|---|
| 0 | the room: backdrop, cabinet, the field's floor and its grid |
| 1 | underglow: additive haloes beneath the blocks and the paddle, bloomed |
| 2 | geometry: blocks, paddle, side pads, drops, shots — solid, never additive |
| 3 | particles: debris first (normal), then sparks (additive), bloomed |
| 4 | the light: the ball's halo and trail, the shots' glow, the beam's glow |
| 5 | cores and rings: the ball's solid centre, the beam's, the shock rings |
| 6 | alarm and panels: the red-ball edge wash, GAME OVER, the serve prompt |
| 7 | HUD: level, lives, ammunition, progress, the legend |

The ball is **lit, not coloured**: a solid core under a wide additive halo, with a trail of
fading discs along its own recorded path. A block breaks into sixteen particles carrying the
ball's velocity. The red block pulses before anyone has hit one, and the moment the ball turns
red the alarm rises, a shock ring leaves the ball, the beam snaps on beneath the paddle, the
field's frame goes red and the screen shakes.

**Every warning is in the geometry.** `bloom` and `shake` are non-normative — a runtime may
ignore both — so nothing the player has to notice lives in one.

---

## The music

Three bands over the ten levels, two bars each, a lead and a bass — the same score
`modules/redsound` writes for the small console's four-channel chip, transcribed note for note
and voiced for a machine that has polyphony, real filters and a stereo field.

| band | levels | speed | a bar | a loop | key |
|---|---|---|---|---|---|
| A | 1–3 | 6 frames a step | 3.2 s | 6.4 s | A minor, tied pairs over a staccato bass |
| B | 4–7 | 5 | 2.7 s | 5.3 s | A minor, sixteenth lead on a 9% pulse, eighth-note bass |
| C | 8–10 | 4 | 2.1 s | 4.3 s | A harmonic minor, pedal bass on every step |

**The band gets faster as the game gets harder, and that is the whole of the difficulty curve in
the music.** Not a key change and not a new melody, because a player on level 9 is not listening
to the music — they are listening *through* it, for the alarm.

The step is measured in **frames**, as the chip's `speed` column is. At 48 kHz a frame is exactly
800 samples, so every bar boundary lands on a whole sample and a loop that has run for a minute
is still on the grid it started on. The scheduler computes bar *i* as `anchor + i * barSeconds`
rather than accumulating, so there is nothing to drift.

### The rule that matters more than the tune

**The music must never bury the alarm.** Effect 10 is the only warning a player gets that a red
ball will destroy their paddle, and they have about a second to act. The small console kept clear
of it four ways at once; all four are kept here, and all four are *measured* — `test/music.test.ts`
renders the real mixer through an `OfflineAudioContext` and reads the samples back.

1. **Level.** The score's summed peak gain is **0.10** against the alarm's **0.45**, before a
   filter has touched either.
2. **Register.** Nothing in the score goes above **A5 (69)**; every note of the alarm is at or
   above **B5 (71)**. They do not share a semitone. Prime adds a **four-pole** lowpass at 2 kHz on
   the lead, so a pulse's harmonics are 24 dB down an octave above the corner rather than 12 —
   the alarm's octave is cleared rather than merely quietened.
3. **Timbre.** The music is pulse, triangle and sine. **Saw and noise belong to the effects**, and
   the alarm is the only saw anywhere in the console.
4. **Interruption.** An effect that claims a music channel **takes that voice** for exactly as long
   as it sounds, and gives it back. Channel 3 is the bass and channel 2 is the lead — so the alarm,
   the deflection and every loss drop the floor out from under themselves for their whole length,
   over a melody that never stops. Channels 0 and 1 are the engine's: the block, paddle and wall
   hits fire many times a second and never touch the song.

A fifth thing Prime can do that the chip could not: the lead is panned off centre and the alarm
is not, so they are not even in the same place.

### The measurements

At 48 kHz, master gain 1, each band over two full loops and the alarm over its own 900 ms. **In
band** is the RMS inside a second-order bandpass over 900 Hz–2.4 kHz, which is where the alarm's
notes live and therefore the number that actually decides masking; broadband RMS flatters a bed
whose energy is all in the bass, and a bass an octave below the warning masks nothing.

| | band A | band B | band C |
|---|---|---|---|
| peak, alone | 0.0890 | 0.0717 | 0.0799 |
| RMS, alone | 0.0184 | 0.0139 | 0.0185 |
| **alarm RMS ÷ band RMS** | **6.5x** | **8.7x** | **6.5x** |
| **the same, in the alarm's octave** | **11.9x** | **24.8x** | **10.5x** |
| alarm peak with the band under it | 0.5296 | 0.5242 | 0.5305 |
| limiter gain reduction | 0.000 dB | 0.000 dB | 0.000 dB |
| bass left under the alarm | 1.9% | 0.9% | 8.4% |
| bed left under the alarm | 58% | 39% | 85% |

The alarm alone measures **0.5231 peak, 0.1203 RMS, 0.0920 in band**. Every band clears the small
console's 4.4x margin on broadband RMS and is between ten and twenty-five times clear where it
counts. The alarm's peak is *higher* with music under it than without, not lower — the limiter
never fires, so a busy mix costs the warning nothing. And the last two rows are the interruption
rule happening: the bass is twenty to forty decibels down while the alarm holds, and the melody
is still there when it stops.

`SQ1_MUSIC_TABLE=1 npx vitest run packages/prime/test/music.test.ts` prints this table. **It is
the only way it should ever be updated** — a number typed by hand is a number nothing produced,
and every value above is asserted, so if one moves the suite fails.

### Three judgement calls

`modules/breakout/README.md` argues all three for the small console. Two are kept and one differs.

- **It starts on the first tick, not at boot.** The small console starts the song in `loadLevel`,
  which `boot()` calls last. Prime differs by one sixtieth of a second and gains the ABI's own
  rule: sound is emitted in `tick` and nowhere else, so `boot` stays silent and the band byte is
  written by the code that owns it. Nothing is lost, because **the mixer latches the request**: a
  browser will not start an `AudioContext` before a gesture, and the cart only calls again when
  the band *changes* — which on levels 1–3 is never. A dropped first call would be a console whose
  music never begins.
- **It restarts only when the band changes.** A band is a two-bar loop; clipping it at every level
  would say nothing the HUD's level number has not already said, three times over on the way to
  level 4. So **which band is playing is simulation state** — one arena slot, `G.BAND`, holding the
  band plus one — and a rewind restores the band with the game. Asking for the band that is already
  playing does nothing, which is what lets the cart assert it every tick instead of tracking edges.
- **It plays through a lost life and through game over.** The interruption rule is written for
  exactly this: the loss, the smash and the game over are all on channel 3, so each lands on a
  continuing melody with the bass gone from under it. Stopping the song would put a second of
  silence precisely where the cue is, and the player would press A into a track that never
  restarted.

### Music is not simulation

`snd.music` is a command emitted from `tick`. The scheduler lives in the mixer, outside the arena;
no cart can read a bar number, a playback position or an audio clock. The suite pins the
consequence directly: **the conformance chain is identical across a silent machine, a recording
one and a real WebAudio mixer**, and a snapshot taken after a band switch restores byte-identical.

---

## The rules a cart is held to

- **All mutable state is in the arena.** Nothing on the cart object, nothing in a module-level
  variable that is not a constant, nothing in a closure. Level grids are *assets*: immutable,
  identical on every machine, and therefore outside the arena by the ABI's own rule.
- **`render` may not write.** It gets a read-only view; the machine seals the arena around it and
  faults on a change. Anything that moves keeps a previous and a current value and `render` lerps
  between them.
- **Particles are simulation state.** They are the largest thing in this cart's arena, they use a
  fixed pool with no per-frame allocation, and they are deterministic — a rollback that restored
  the game but not the explosion would show a frame nobody ever simulated.
- **No `Math.sin`, `Math.cos` or `Math.atan2`.** `sim.sin/cos/atan2` are the normative library.
  `+ - * /` and `Math.sqrt` are exactly specified by IEEE 754 and are used freely.
- **No wall clock.** `sim.tick` is the only clock in the machine.

## What the tests prove

`test/breakout.test.ts` drives the real machine and asserts on the **arena** — never on a pixel,
never on a display-list entry. Beyond the mechanics it pins down three things:

- **`render` writes nothing.** Six hundred presented frames of real play, every one of them
  sealed and verified.
- **Snapshot, 300 ticks, restore, 300 ticks — byte-identical arenas.** The cart draws random
  numbers for every drop and every particle, so a generator whose state had escaped the arena
  would show up here immediately.
- **A conformance chain.** A fixed seed and a fixed replay, hashed per tick and chained, stable
  across two runs. The per-tick list is kept as well as the chain, because the chain answers "did
  this run match" and only the list answers "where did it stop matching".
