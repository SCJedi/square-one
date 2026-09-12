# Prime ABI — the contract three packages build against

Written before any of them. `packages/prime` implements it, the renderer consumes the display
list it produces, and the first cart is written against it. Nobody owns it; this file does.

Scope: the vertical slice that makes Red Breaker playable on Prime. Not the whole console.
Where this narrows the specification in `square-one-prime-spec.html`, it says so.

## The shape of a cart

```ts
export interface PrimeCart {
  /** Once. The arena is zeroed; install initial state here. */
  boot(sim: Sim, snd: Snd): void;
  /** Exactly once per simulated tick, at a fixed 60 Hz. MAY write the arena. */
  tick(sim: Sim, input: InputFrame, snd: Snd): void;
  /** Zero or more times per tick, on the presentation clock. MUST NOT write the arena. */
  render(sim: SimRead, draw: Draw, alpha: number): void;
}
```

**`snd` is passed to `tick` and never to `render`.** Audio is emitted by the simulation, at the
simulation's rate. `render` runs on the presentation clock — two to four times per tick on a
fast display — so a sound emitted there fires two to four times per event. It is not a style
preference; it is the difference between a game that sounds right and one that machine-guns
every impact on exactly the hardware that was supposed to make it better.

That `render` cannot make a sound is the same rule as `render` cannot write the arena, for the
same reason: everything that happens, happens in `tick`.

```ts
```

`alpha` is the fraction between the last two ticks, in `[0, 1)`. It is how a 144 Hz display gets
smooth motion from a 60 Hz simulation, and it is the reason a cart keeps **both** the previous
and current position of anything that moves: `render` lerps, `tick` does not.

**`render` receives a read-only view.** In development the runtime hashes the arena before and
after and faults on a change. A value computed for smoothing that leaks into the next tick is
the single most common way a deterministic engine stops being one.

## `sim` — the normative half

```ts
interface Sim {
  readonly tick: bigint;            // u64, the only clock
  readonly mem: DataView;           // the arena. All mutable state lives here.

  rnd(n: number): number;           // integer in [0, n), n in [1, 2^31)
  rndf(): number;                   // f64 in [0, 1)

  // The normative math library. NEVER the platform's.
  sin(x: number): number;
  cos(x: number): number;
  atan2(y: number, x: number): number;
  sqrt(x: number): number;          // IEEE-exact, so this one IS the platform's
}
```

**`SimRead` is `Sim` minus `mem`'s writability AND minus `rnd`/`rndf`.**

Dropping the generator from the read-only view is not tidiness. The PRNG's state lives in the
arena, so *drawing a number is a write* — a `render` that called `sim.rnd()` would advance the
simulation and the arena seal would fault. An interface that offers a method which always faults
is an interface that invites the bug and then punishes it.

A cart that wants jitter in `render` derives it from `sim.tick` and the value it is drawing,
which is deterministic, free, and cannot desync anything.

**`sim.mem` starts 64 bytes into the arena.** Those bytes are the machine header: the u64 tick
counter, the 32-byte PCG state, and reserved space. They are simulation state and they are
hashed — but they are not reachable from a cart, because a cart that could rewind the clock by
poking eight bytes would make `sim.tick` a suggestion rather than the only clock.

**Everything handed to a cart is non-extensible**, `mem` and the input arrays included. A
`DataView` and a `Uint16Array` are ordinary objects; without this, `sim.mem.cache = x` survives a
tick and a rewind restores the arena but not the cache. That is the same defect the small console
found when an unfrozen `sys` let a cart write `sys.carry = 1`, one level down and with a bigger
buffer behind it.

**Only `+ - * / sqrt` come from the platform.** They are exactly specified by IEEE 754 and
identical everywhere. `sin`, `cos` and `atan2` are not, and differ between libms and CPU
vendors, so Prime ships its own — the same reason the small console ships a committed sine
table rather than a formula.

### A committed float must be written in 17 digits, not 100

ECMAScript only guarantees correct rounding for a decimal literal with **at most 20 significant
digits**. Past that an implementation may round either way, so an "exact" 40-digit decimal for a
double is *not* guaranteed to parse back to that double on every engine — and a coefficient that
differs by one ULP between two runtimes is a silent desync in the one place this console cannot
afford one.

Write committed constants with the shortest round-tripping form (`String(d)`, at most 17
digits), and assert both properties where they are generated. The intuition that more digits is
safer is exactly backwards here.

For this slice the library is `sin`, `cos`, `atan2`, `sqrt`. `exp`, `log` and `pow` are not
needed by a breakout game and are deferred rather than guessed at.

## `inp` — quantized before the simulation sees it

```ts
interface InputFrame {
  readonly buttons: Uint16Array;    // 8 players, 16 bits each
  readonly axes: Int16Array;        // 8 players x 4 axes, full i16 range
  readonly triggers: Uint8Array;    // 8 players x 2
  readonly present: number;         // bitmask of populated slots
}
```

Quantization happens in the runtime, before `tick`. A stick's true position differs between
controllers, drivers and polling rates; what reaches the cart is an integer, and integers
replay.

Buttons, by bit: `0 up, 1 down, 2 left, 3 right, 4 A, 5 B, 6 X, 7 Y, 8 L, 9 R, 10 L2, 11 R2,
12 L3, 13 R3, 14 SELECT, 15 START`. Pause and menu are the console's and are not in this list.

## `draw` — a display list, not a GPU

The cart describes a scene; the runtime draws it. A cart never touches a driver — which is what
keeps the sandbox small and what lets a headless conformance runner execute a million ticks
without a display.

**Coordinates are floats in a 1920 x 1080 logical space.** The runtime presents at whatever the
display is. Colours are packed `0xRRGGBBAA` as a u32.

```ts
interface Draw {
  clear(color: number): void;

  // Shapes. `color` may be a gradient handle; see below.
  rect(x: number, y: number, w: number, h: number, color: number): void;
  roundRect(x: number, y: number, w: number, h: number, r: number, color: number): void;
  circle(x: number, y: number, r: number, color: number): void;
  line(x0: number, y0: number, x1: number, y1: number, w: number, color: number): void;
  tri(x0: number, y0: number, x1: number, y1: number,
      x2: number, y2: number, color: number): void;

  // Text. One built-in face at this stage; a cart-supplied face is later.
  // `y` is the BASELINE, not the top. A cart written against the other reading
  // draws every string one line out, which is the kind of thing that is obvious
  // on screen and invisible in a test.
  text(s: string, x: number, y: number, size: number, color: number): void;
  measure(s: string, size: number): number;

  // Transform stack. Cheap; a particle system leans on it.
  push(): void;
  pop(): void;
  translate(x: number, y: number): void;
  rotate(a: number): void;
  scale(x: number, y: number): void;

  // Blending and layers.
  blend(mode: 0 | 1): void;         // 0 normal, 1 ADDITIVE -- additive is the glow
  layer(n: number): void;           // 0..7, drawn low to high, each a separate pass

  // Post stages, declared per layer. Non-normative, and a cart must render
  // correctly with all of them ignored.
  bloom(strength: number, threshold: number): void;
  shake(amount: number): void;      // screen offset; the runtime decides the curve
}
```

### Why additive blending is called out

Glow is what separates a 1990s look from a modern one, and additive blending is the whole of
it. A ball drawn twice — once solid, once larger and additive at low alpha — reads as *lit*
rather than *coloured*. It costs nothing and it is most of the visual budget on a game made of
rectangles and circles.

### Post stages are non-normative and must be optional

`bloom` and `shake` are presentation. A runtime may ignore both, and the cart must still be
playable and readable. Never put information in a post stage — if a thing must be noticed, it
goes in the geometry.

**How they accumulate within a frame**, which is not obvious and matters:

- `bloom` is **last-writer-wins, per layer**. It describes how that layer is lit, and the last
  description is the one that meant it.
- `shake` takes the **maximum** over the frame. Several systems request shake independently in
  one tick — a footstep, a block breaking, a paddle destroyed — and last-writer would let the
  footstep cancel the explosion.

### Frame state, and where `clear` sits

Every frame begins at: **layer 0, blend normal, identity transform, empty stack, post stages
cleared.** A cart may rely on that and need not reset anything itself.

`clear` is recorded as an ordinary command so the list stays an in-order record, but it is
**screen-space**: it fills the whole logical viewport and ignores the transform in force when it
was called. `clear` after a `translate` still clears the frame, which is the only behaviour that
is ever wanted.

### `measure` is the single source of truth for layout

A cart centres a score with `measure` and must get an answer headlessly, before any glyph
exists. So `measure` is authoritative: the renderer **scales each drawn string to the width
`measure` promised.** Cart layout is therefore reproduced exactly on every runtime; the glyph
shapes are the platform's, which is fine, because pixels are not normative. If a face is ever
pinned to the format, this is the one hook that changes.

## `snd`

```ts
interface Snd {
  play(id: number, opts?: { gain?: number; pitch?: number; pan?: number }): void;
  music(id: number, fade?: number): void;
  stopMusic(fade?: number): void;
}
```

Same one-way street as everywhere else: the simulation emits, the mixer consumes, nothing flows
back. A cart cannot read a playback position or an audio clock.

## The arena, and the rule that makes rollback affordable

All mutable simulation state is in `sim.mem`. Nothing else. No state on the cart object, no
state in a module-level variable that is not derived from the arena, no state in a closure.

**Assets are not in the arena.** They are immutable, identical on every machine running the same
cart, and therefore do not need saving — only being the same, which the cart hash already
guarantees. A snapshot copies the arena and nothing else. That is what makes eight frames of
rollback affordable on a machine holding gigabytes.

For this slice the arena is **1 MB**, which is far more than a breakout game needs and small
enough that the state-hash chain is fast. The specification's cap is 64 MB.

## Conformance for this slice

The chain hashes **simulation state**, never pixels:

```
stateHash_i = sha256( the arena at the end of tick i )
chain_i     = sha256( chain_{i-1} || stateHash_i )
```

Identical to the small console's frame-hash chain in shape and for the same reasons — per-tick
hashes so a divergence reports its first tick, a chain so a whole run compares as one value —
with the framebuffer swapped for the arena. That swap is the entire Prime thesis in one line.

A conformance case is a seed, a replay, and the chain.

## What this slice deliberately leaves out

Stated so nobody mistakes absence for a decision: wasm payload and the cart container (the first
cart is in-tree TypeScript, exactly as `gradient.ts` is on the small console), Merkle identity
and streaming, textures and meshes, cart-supplied shaders and fonts, rollback netplay, the
stamper, and the extension mechanism. Each is in the specification and none is needed to find
out whether the architecture holds.
