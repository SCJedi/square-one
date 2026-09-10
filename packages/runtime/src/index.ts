// @sq1/runtime - the machine, and the harness that proves it is deterministic.
//
// The dependency direction inside this package is one-way, and the order below
// follows it: memory is the address space, palette and raster read and write it,
// the machine owns it, a cart drives the machine, and the protocol, hash and
// host layers surround the machine without knowing what it computes.
//
// Nothing here reaches the network or the filesystem. The runtime is designed
// to be loadable inside a scrubbed Worker realm, which is also why the worker
// bootstrap is a function you call rather than a side effect of importing this
// module: importing the package must not attach anything to the global scope.

// --- The address space -----------------------------------------------------
// 64 KiB, every byte of it accounted for. The framebuffer is 0x0000..0x1FFF:
// 128 x 128 pixels at 4 bits each, two pixels per byte, low nibble on the left.
export * from "./memory";

// --- Colour ----------------------------------------------------------------
// A fixed 64-entry hardware palette and a 16-entry live palette, resolved into
// an RGBA lookup table once per present.
export * from "./palette";

// --- Drawing ---------------------------------------------------------------
export * from "./raster";

// --- The system font --------------------------------------------------------
// 4x6 glyphs, ASCII 32..126, sized to stay legible at 1x on a 128px screen.
export * from "./font";

// --- Sound ------------------------------------------------------------------
// The `snd` ABI, the register block the mixer reads, and the synth that reads
// it. One-way street: the simulation writes registers, the mixer consumes them,
// and nothing flows back -- which is what keeps audio non-normative and keeps
// an AudioContext's own drifting clock out of the simulation.
export * from "./audio";

// --- A cart's static data ---------------------------------------------------
// Which chunk fills which region of RAM, and when. Specification 3.3: a cart's
// static data initializes 0x2000 through 0x77FF at boot. Exported above the
// machine because the machine's boot order depends on it.
export * from "./cart-data";

// --- The machine ------------------------------------------------------------
// Everything a run depends on lives in RAM, so a snapshot is a copy of RAM and
// nothing else.
export * from "./machine";

// --- Carts that ship with the runtime ---------------------------------------
// `gradient` is the golden-master cart; `reference` exercises every gfx call in
// its own region of the screen, so a broken primitive is visible in a PNG
// rather than only as a changed hash.
export * from "./carts/gradient";
export * from "./carts/reference";

// --- Host <-> worker protocol ----------------------------------------------
// Types only: there is nothing to emit, and naming them explicitly keeps the
// barrel honest under isolatedModules.
export type { ToWorker, FromWorker } from "./protocol";

// --- The frame-hash chain ---------------------------------------------------
// The measuring instrument for the determinism claim, and the format the
// conformance cases are stored in.
export * from "./hash";

// --- The main-thread driver -------------------------------------------------
// Owns the clock and the framebuffer hand-off.
export * from "./host";

// --- The watchdog -----------------------------------------------------------
// A synchronous infinite loop cannot be interrupted from inside its own thread,
// so the deadline lives on the host and the cure is terminating the worker. The
// clock is injectable because a test that sleeps is a test that flakes.
export * from "./watchdog";

// --- The sandbox ------------------------------------------------------------
// Three layers, and only two of them are portable. Parameter shadowing applies
// everywhere; realm hardening can only run in a worker that hosts exactly one
// cart. Layer 1 alone is NOT a security boundary -- see the file header and
// conformance/canaries/README.md for the six escapes it does not close.
export * from "./sandbox";

// --- The worker side --------------------------------------------------------
export * from "./worker";

// --- The seam: a cart FILE becomes a running program -------------------------
// `@sq1/cart` parses the container and the sandbox compiles the source; this is
// the one place that joins them, so every host answers "is this a cart I can
// run?" the same way, including for the carts it refuses. It never throws.
export * from "./load";

// --- The production worker bootstrap ----------------------------------------
// Compile, then harden, then serve -- in that order, for the reasons its header
// gives. Importing it attaches nothing; starting a worker is a call.
export * from "./worker-entry";
