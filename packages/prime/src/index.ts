// @sq1/prime -- Square One Prime: the deterministic simulation core.
//
// Everything exported below is NORMATIVE. If two implementations of Prime
// disagree about any value produced here, they disagree about what a game does,
// and every replay and every netplay session recorded on one of them is wrong on
// the other. The failure is silent and it appears thousands of ticks after the
// mistake, which is why this package is tested against exact references rather
// than against itself.
//
// The presentation half -- the display list, the renderer, the mixer, the shell
// and the carts -- is NOT normative. It is exported below the normative block
// and under its own heading, because a page has to be able to import a console
// from one place, and because an export list that hides where the line is does
// not move the line -- it only makes it harder to see. Everything above
// "Sound" is a value two implementations must agree about; nothing below it is.

// --- The arena -------------------------------------------------------------
// One contiguous buffer holding the complete mutable state of a simulation.
// A snapshot is a copy of it and nothing else; that is what makes rollback
// affordable and what makes every claim about determinism checkable.
export { ARENA_BYTES, createArena } from "./arena";
export type { Arena } from "./arena";

// --- PCG64-DXSM ------------------------------------------------------------
// The machine's only source of entropy. 128 bits of state and a 128-bit odd
// increment, living in the arena and travelling inside every snapshot.
export { RNG_BYTES, rngCreate, rngNext, rnd, rndf, rngSave, rngLoad, rngLoadInto } from "./prng";
export type { RngState } from "./prng";

// --- The normative math library --------------------------------------------
// sin, cos and atan2 are ours: IEEE 754 does not specify them, libms differ,
// CPU vendors differ, and a game that computes an angle with the platform's
// Math.sin desyncs between two machines that are both "correct". sqrt is the
// platform's, because IEEE 754 does specify it, exactly.
export { sin, cos, atan2, sqrt } from "./math";

// --- The machine -----------------------------------------------------------
// A fixed 60 Hz tick loop, the ABI a cart sees, and the wall between `tick` and
// `render` that keeps interpolation out of the simulation.
export {
  ARENA_HEADER,
  CART_BYTES,
  MAX_PLAYERS,
  BUTTON,
  emptyInput,
  createMachine,
  nullSnd,
  defaultUi,
  setDevChecks,
  devChecksEnabled,
} from "./sim";
export type { Draw, InputFrame, Machine, PrimeCart, Sim, SimRead, Snd, SndOpts, Ui } from "./sim";

// --- Sound -----------------------------------------------------------------
// NON-NORMATIVE, and that is the whole reason it can be synthesised rather than
// shipped as bytes: no number this makes can move the state hash. `Snd` itself
// is part of the ABI, because WHEN a cart emits is simulation -- it happens in
// `tick`, on the tick it happened on, and it replays. WHAT it sounds like is
// the mixer's business.
export { SFX, SFX_COUNT, BANK_INFO, noteHz, createRecordingSnd, createPrimeAudio, audioAvailable } from "./audio";
export type { PrimeAudio, PrimeAudioState, RecordingSnd, SndCall } from "./audio";

// The song. Three bands over the ten levels, getting faster as the game gets
// harder -- and four independent reasons it can never bury the alarm, each of
// them measured in `test/music.test.ts` rather than asserted. Which band is
// playing IS simulation state and lives in the cart's arena; nothing below is.
export {
  MUSIC,
  MUSIC_COUNT,
  MUSIC_LEVEL,
  MUSIC_CEILING,
  MUSIC_FADE_FRAMES,
  BAND_FIRST_LEVEL,
  SCORE_INFO,
  bandForLevel,
  barSeconds,
  loopSeconds,
  createMusicScheduler,
} from "./music";
export type { BandSpec, MusicScheduler, MusicVoice, VoiceSpec } from "./music";

// --- The shell and the first cart ------------------------------------------
// The page half: a 60 Hz accumulator, quantized input, a real pause button, and
// the cart the whole slice exists to make playable.
// `keyboardUi` is the console's answer to "what is this button called": derived
// from KEYMAP, so a cart's prompt can never name a key that does something else.
export { createPrimePlayer, createInputReader, keyboardUi, KEYMAP, BTN } from "./player";
export type { PrimePlayer, PrimePlayerOptions, InputReader } from "./player";
export { breakoutCart } from "./carts/breakout";

// --- Conformance -----------------------------------------------------------
// The chain hashes simulation state, never pixels. That swap is the entire
// Prime thesis in one line.
export { stateHash, ChainHasher, chainOf, formatGolden, parseGolden, firstDivergence } from "./hash";
export type { GoldenCase } from "./hash";
