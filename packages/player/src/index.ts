// @sq1/player - the console a person actually looks at and touches.
//
// Main thread only. Nothing in this package runs cart code; the machine lives
// behind a `Channel` and the player never sees inside it. The dependency
// direction is the same one-way arrangement the repository uses everywhere:
// layout knows nothing, screen and input know layout, shell knows layout, and
// player is the only file that knows all of them plus the runtime.
//
// THE SHELL IS CART-INVISIBLE. A cart gets a 128 x 128 canvas and no other
// handle on the page -- no element, no style, no font, no event. That is why a
// cart can draw a convincing fake login box and it will still visibly sit
// inside a game screen, inside a console, with nowhere to submit. See the
// headers of shell.ts and input.ts for how each half of that is enforced.

// --- Geometry ---------------------------------------------------------------
// Pure arithmetic, no DOM, therefore provable in a Node test: integer scale,
// 44px touch targets, and a degradation ladder for viewports that cannot hold
// the full console.
export * from "./layout";

// --- Presentation -----------------------------------------------------------
// A 128 x 128 backing canvas, one ImageData allocated once, and an integer
// upscale with smoothing off.
export * from "./screen";

// --- Input ------------------------------------------------------------------
// Keyboard, gamepad and the virtual controller, all filling in the same four
// bytes. `sample` ORs and never allocates. Pause is NOT one of the eight bits.
export * from "./input";

// --- The chrome -------------------------------------------------------------
export * from "./shell";

// --- The mixer --------------------------------------------------------------
// The register block crosses one way: the simulation writes it, the mixer reads
// it, and nothing flows back -- an AudioContext runs on its own hardware clock
// and anything derived from it would be nondeterministic.
export * from "./audio-graph";

// --- It all wired together --------------------------------------------------
// `Host` owns the clock. This package's animation frame takes a timestamp and
// hands it over; it never decides how many frames that timestamp is worth.
export * from "./player";
