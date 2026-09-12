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
3. RED ball touches the **paddle** → the paddle is destroyed, a life is lost, the ball returns to
   normal.
4. RED ball touches **anything else** — wall, ceiling, block, the beam, a shot → it bounces and
   returns to normal.

So a red ball is dangerous for exactly one contact, and the player has to do the opposite of
everything the rest of the game teaches: **get the paddle out of the way.** The beam is the
safety net under it; a shot is the skilled way out once the gun exists.

Rules 3 and 4 are **not two checks**. Every contact that is not the paddle runs through
`bounce()`, which clears the RED bit as its last act; the paddle is the one contact that never
calls it. Written that way the two rules cannot drift apart, and a contact added later gets rule
4 for free by bouncing like everything else.

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
