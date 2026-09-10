// The `redsound` bank -- Red Breaker's 29 effects and its three level themes,
// written here and packed into sfx.bin and music.bin.
//
//     node modules/redsound/gen.mjs
//
// Run it from the repository root. It rewrites both files and prints a summary.
// Regenerating produces identical bytes on any machine: there is no clock, no
// randomness and no floating point below this line.
//
// WHY THE TRACKER TEXT IS SOURCE AND THE .bin IS OUTPUT
// ----------------------------------------------------
// A .bin is unreviewable. A pull request that raises the volume of the alarm by
// one step should read as one changed character, and it does, because every
// step below is one line of tracker text: note, volume, waveform, effect. The
// packing at the bottom is the only part that knows about nibbles.
//
// THE MACHINE THIS IS WRITTEN FOR is documented in
// packages/runtime/src/audio.ts. The short version, because every number below
// is one of these:
//
//     NOTE   0..95 semitones from C0, note 57 = A4 = 440 Hz. 255 = rest.
//     MIX    b7..4 volume 0..15 (the channel gets volume * 17), b3..0 waveform.
//     FX     b7..4 effect, b3..0 parameter.
//            0 NONE retriggers the envelope, 1 LEGATO changes pitch/volume/
//            waveform without retriggering, 2 DUTY also sets the channel's
//            pulse duty to (param << 4) | 8.
//     header SPEED frames per step, LENGTH steps, LOOP_START, LOOP_END,
//            then the four envelope bytes the effect installs on the channel.
//            ENV_A/D/R are in units of 4 ms; a frame is 16.67 ms.
//
// THE TRACKER FORMAT USED BELOW
// -----------------------------
//     "C-6 5 P d3"     note C6, volume 5/15, PULSE, set duty to 0x38
//     "A#2 4 T -"      note A#2, volume 4/15, TRIANGLE, retrigger
//     "C-7 e T L"      note C7, volume 14/15, TRIANGLE, legato (no retrigger)
//     "--- 0 P -"      a rest: the gate opens and the envelope releases
//
// Volume is one hex digit. Waveforms are P pulse, T triangle, S saw, N noise.
// There is no W: the WAVETABLE waveform reads the master block at 0x2150, which
// is a REGISTER and not a cart chunk, so a soundbank cannot fill it. A cart that
// wants the fifth waveform has to write those sixteen bytes itself.
//
// THE TWO RULES THIS BANK IS BUILT AROUND
// ---------------------------------------
// From modules/FORMATS-breakout-art.md, and they outrank every individual
// effect:
//
//   1. Effects 0, 2 and 3 fire constantly -- block hit, paddle hit, wall hit.
//      They are two frames long, they are the three quietest effects in the
//      bank, and they separate on three axes at once so the player hears WHICH
//      one fired without looking: register, waveform and direction.
//         0 block  C6 -> D6   pulse, 22% duty, volume 5   rising, highest
//         2 paddle C5 -> D5   pulse, 53% duty, volume 4   rising, an octave down
//         3 wall   G5 -> F#5  triangle,        volume 3   falling, and softest
//      A triangle at volume 3 is the least fatiguing thing this chip can make,
//      and the wall is the one that fires most.
//
//   2. Effect 10 must not resemble anything else in the bank. It is the only
//      warning the player gets. So it is the only effect that uses the SAW
//      waveform, the only one that oscillates rather than sweeps, the only one
//      whose amplitude holds flat rather than decaying, the loudest effect in
//      the bank, and every note in it is above every note in the music.
//      README.md carries the measured distance to its nearest neighbour.
//
// WHY THE MUSIC IS QUIETER THAN EVERYTHING ELSE
// ---------------------------------------------
// The song is two voices at volume 3 and 4 out of 15. Effect 10 is volume 15.
// So the alarm alone is louder than the entire music bed, on a channel the song
// gives up the moment the alarm claims it, in a register that begins where the
// melody's ceiling ends and reaches an octave and a half above it, on a waveform
// the song never uses. Four independent reasons the track cannot bury the
// warning, three of them still true after a mixing desk has had its say.

import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// ---------------------------------------------------------------------------
// The format's own numbers. Repeated here rather than imported because gen.mjs
// is plain Node run from a shell and the runtime is TypeScript -- but the test
// beside this file imports both and pins them against each other.
// ---------------------------------------------------------------------------

const SFX_COUNT = 32;
const SFX_STRIDE = 104;
const SFX_STEPS = 32;
const SFX_STEPS_OFFSET = 8;
const SFX_REST = 255;

const MUSIC_PATTERN_BYTES = 8;

const WAVE = { P: 0, T: 1, S: 2, N: 3 };
const FX_NONE = 0;
const FX_LEGATO = 1;
const FX_DUTY = 2;

const PAT_LOOP_START = 0x01;
const PAT_LOOP_END = 0x02;

/** Semitones above C within an octave, for the tracker's note names. */
const SEMI = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/**
 * "C-6" -> 72, "A#2" -> 34, "---" -> 255.
 *
 * Three characters always, so a column of steps lines up in the source and a
 * changed note is a changed character rather than a changed line length.
 */
function note(text) {
  if (text === "---") return SFX_REST;
  if (text.length !== 3) throw new Error(`note ${JSON.stringify(text)} is not 3 characters`);
  const base = SEMI[text[0]];
  if (base === undefined) throw new Error(`note ${JSON.stringify(text)}: no such letter`);
  const accidental = text[1] === "#" ? 1 : text[1] === "-" ? 0 : null;
  if (accidental === null) throw new Error(`note ${JSON.stringify(text)}: want '-' or '#'`);
  const octave = Number.parseInt(text[2], 10);
  if (!Number.isInteger(octave) || octave < 0 || octave > 7) {
    throw new Error(`note ${JSON.stringify(text)}: octave out of range`);
  }
  const n = octave * 12 + base + accidental;
  if (n > 95) throw new Error(`note ${JSON.stringify(text)} is above B7`);
  return n;
}

/** One tracker line -> the three bytes NOTE, MIX, FX. */
function step(line) {
  const parts = line.split(/\s+/);
  if (parts.length !== 4) throw new Error(`step ${JSON.stringify(line)}: want 4 fields`);
  const [noteText, volText, waveText, fxText] = parts;

  const vol = Number.parseInt(volText, 16);
  if (!Number.isInteger(vol) || vol < 0 || vol > 15) {
    throw new Error(`step ${JSON.stringify(line)}: volume must be one hex digit`);
  }
  const wave = WAVE[waveText];
  if (wave === undefined) throw new Error(`step ${JSON.stringify(line)}: waveform must be P, T, S or N`);

  let fx;
  if (fxText === "-") fx = FX_NONE << 4;
  else if (fxText === "L") fx = FX_LEGATO << 4;
  else if (fxText[0] === "d" && fxText.length === 2) {
    const p = Number.parseInt(fxText[1], 16);
    if (!Number.isInteger(p)) throw new Error(`step ${JSON.stringify(line)}: bad duty parameter`);
    fx = (FX_DUTY << 4) | p;
  } else throw new Error(`step ${JSON.stringify(line)}: effect must be -, L or dN`);

  return [note(noteText), (vol << 4) | wave, fx];
}

// ===========================================================================
// THE EFFECTS
//
// `speed` is frames per step at 60 Hz; `env` is [attack, decay, sustain,
// release] in the channel's own units. The comment above each one is the row
// modules/FORMATS-breakout-art.md gives it.
// ===========================================================================

const EFFECTS = [
  // --- 0: ball hits a block -------------------------------------------------
  // "very short blip, up two semitones, pulse". Two frames, 33 ms of gate and
  // 12 ms of release. It is the highest of the three constant effects because a
  // block is the thing furthest up the screen.
  {
    id: 0,
    name: "block hit",
    speed: 1,
    env: [0, 2, 60, 3],
    steps: ["C-6 5 P d3", "D-6 5 P -"],
  },

  // --- 1: block breaks ------------------------------------------------------
  // "short down-sweep with a noise tail". Four pulse steps falling a tritone at
  // a time, then two noise steps: the sweep is the break and the noise is the
  // debris. Louder than a hit, because a hit that broke something should read
  // as a bigger event than one that did not.
  {
    id: 1,
    name: "block breaks",
    speed: 1,
    env: [0, 4, 120, 5],
    steps: ["E-6 9 P d3", "B-5 9 P -", "F#5 8 P -", "C#5 7 P -", "C-5 6 N -", "F#4 4 N -"],
  },

  // --- 2: ball hits the paddle ---------------------------------------------
  // "lower, softer blip than a block". An octave below effect 0 and on a full
  // square rather than a narrow pulse, so it is rounder as well as lower.
  {
    id: 2,
    name: "paddle hit",
    speed: 1,
    env: [0, 3, 40, 4],
    steps: ["C-5 4 P d8", "D-5 4 P -"],
  },

  // --- 3: ball hits a wall --------------------------------------------------
  // "the quietest of the three; it happens most". Triangle, volume 3, and the
  // only one of the three that falls. A wall is not an event; it is punctuation.
  {
    id: 3,
    name: "wall hit",
    speed: 1,
    env: [0, 2, 40, 2],
    steps: ["G-5 3 T -", "F#5 3 T -"],
  },

  // --- 4: drop appears ------------------------------------------------------
  // "two quick rising notes". A tritone up and stop -- it is a question, and
  // the answer is effect 5 when the paddle gets there.
  {
    id: 4,
    name: "drop appears",
    speed: 3,
    env: [0, 4, 110, 4],
    steps: ["A-5 7 P d3", "E-6 7 P -"],
  },

  // --- 5: drop caught -------------------------------------------------------
  // "bright four-note arpeggio up". A major triad plus the octave: the plainest
  // "you gained something" a chip can play, which is why it is the right one.
  {
    id: 5,
    name: "drop caught",
    speed: 3,
    env: [0, 5, 140, 6],
    steps: ["C-6 a P d8", "E-6 a P -", "G-6 a P -", "C-7 a P -"],
  },

  // --- 6: extra life --------------------------------------------------------
  // "the longest, warmest cue in the bank. It should be the best sound in the
  // game." 32 steps at 3 frames -- 1.6 seconds, the full length the format
  // allows, and nothing else in the bank is close.
  //
  // It is a TRIANGLE, which is the warm waveform here: no odd-harmonic buzz, no
  // duty to argue with, and it stays soft at a volume that would make a pulse
  // shrill. The shape is a two-octave run up the C major triad, a held C7, then
  // a second, shorter climb that lands on the same C7 and stays there for half a
  // second on a 160 ms release. Two arrivals at the same note: the first says
  // it happened, the second says it is yours.
  {
    id: 6,
    name: "extra life",
    speed: 3,
    env: [2, 25, 200, 40],
    steps: [
      "C-5 a T -", "E-5 b T -", "G-5 c T -", "C-6 d T -",
      "E-6 d T -", "G-6 e T -", "C-7 e T -",
      "C-7 e T L", "C-7 e T L", "C-7 e T L", "C-7 e T L", "C-7 e T L",
      "E-6 d T -", "G-6 d T -", "C-7 e T -",
      "C-7 e T L", "C-7 e T L", "C-7 e T L", "C-7 e T L", "C-7 e T L",
      "C-7 e T L", "C-7 e T L", "C-7 e T L", "C-7 e T L", "C-7 e T L",
      "C-7 e T L", "C-7 e T L", "C-7 e T L", "C-7 e T L", "C-7 e T L",
      "C-7 e T L", "C-7 e T L",
    ],
  },

  // --- 7: shot fired --------------------------------------------------------
  // "fast down-sweep, short". A 9% duty pulse is the thinnest voice this chip
  // has, and four frames of it falling three octaves is a laser. Volume 7: the
  // gun fires often enough to matter.
  {
    id: 7,
    name: "shot fired",
    speed: 1,
    env: [0, 3, 80, 3],
    steps: ["E-7 7 P d1", "A-6 7 P -", "D-6 6 P -", "G-5 5 P -"],
  },

  // --- 8: shot hits a shield ------------------------------------------------
  // "metallic tick, high pulse, very short". Two frames near the top of the note
  // table. It says "that did nothing", so it must not sound like progress.
  {
    id: 8,
    name: "shot hits shield",
    speed: 1,
    env: [0, 2, 60, 2],
    steps: ["G-7 6 P d1", "F-7 6 P -"],
  },

  // --- 9: shield breaks -----------------------------------------------------
  // "noise burst with a down-sweep". Noise pitch is the LFSR clock, so a falling
  // note on the noise waveform is a bright hiss collapsing into a rattle -- the
  // sound of glass, in five frames.
  {
    id: 9,
    name: "shield breaks",
    speed: 1,
    env: [0, 6, 100, 8],
    steps: ["C-7 b N -", "E-6 a N -", "G#5 9 N -", "C-5 8 N -", "E-4 7 N -"],
  },

  // --- 10: THE BALL TURNS RED ----------------------------------------------
  // "an alarm. Rising, urgent, unmistakable, and unlike everything else."
  //
  // Everything else in this bank is a SWEEP: one direction, one envelope, done.
  // This is the one effect that OSCILLATES. Two notes alternated eight times a
  // second for 48 frames -- 0.8 s, about how long the player has.
  //
  // THE PAIR OPENS OUTWARD RATHER THAN CLIMBING, and that is the whole design.
  // An alarm that ramps upward is a rising contour, and a rising contour is what
  // the drop, the arpeggio, the extra life and the level fanfare all are: the
  // first draft of this effect climbed a semitone every four steps and measured
  // 0.50 against effect 14, which is far too close for the only warning in the
  // game. So the two notes stay centred on F#6 and widen instead -- a minor
  // third, then a tritone, then a minor sixth, a minor seventh, an octave, a
  // major ninth. The mean pitch never moves, so the effect correlates with
  // nothing that rises and nothing that falls, while the top voice climbs and
  // the interval turns from a wobble into a scream.
  //
  // Five things separate it from the rest of the bank, and test/sound.test.ts
  // measures each rather than taking this comment's word for it:
  //   * SAW. No other effect in the bank uses it, and no music voice does.
  //   * It oscillates. Everything else sweeps one way.
  //   * A flat amplitude, not a decaying one: ENV_D is 0, so the level holds
  //     while the gate is open and the throb comes from the volume column.
  //     Every other effect in the bank fades.
  //   * B5..C#7, entirely above the melody's A5 ceiling.
  //   * Volume 15. It is the loudest effect in the bank, by one step over the
  //     extra life, and nothing else is allowed to reach it.
  {
    id: 10,
    name: "ball turns RED",
    speed: 2,
    env: [0, 0, 0, 6],
    steps: [
      "E-6 f S -", "G#6 c S -", "E-6 f S -", "G#6 c S -",
      "D#6 f S -", "A-6 c S -", "D#6 f S -", "A-6 c S -",
      "D-6 f S -", "A#6 c S -", "D-6 f S -", "A#6 c S -",
      "C#6 f S -", "B-6 c S -", "C#6 f S -", "B-6 c S -",
      "C-6 f S -", "C-7 c S -", "C-6 f S -", "C-7 c S -",
      "B-5 f S -", "C#7 c S -", "B-5 f S -", "C#7 c S -",
    ],
  },

  // --- 11: the beam deflects the red ball -----------------------------------
  // "a hard down-sweep -- relief, and the player must know it worked."
  //
  // The exact opposite gesture to effect 10, deliberately: where the alarm
  // oscillates on a saw, this falls in one continuous line on a square. Every
  // step after the first is LEGATO, so the pitch glides rather than stepping --
  // twelve retriggered notes would be a scale, and a scale is not relief.
  //
  // IT LANDS. The fall is a tritone a step from C7 down to C4 and a fourth a
  // step below that, and then it STOPS and holds A2 for three steps, which is a
  // quarter of the effect. That plateau
  // is the difference between "something is falling" and "something was caught",
  // and it is also what separates this from effect 12 -- the paddle being
  // destroyed is the same downward gesture and must never be mistaken for it.
  // A2 is the root the whole soundtrack is built on, so the catch lands on home.
  //
  // Play it on the same channel as effect 10 and it cuts the alarm off, which is
  // exactly what happened.
  {
    id: 11,
    name: "beam deflect",
    speed: 2,
    env: [0, 40, 180, 20],
    steps: [
      "C-7 c P d8", "F#6 c P L", "C-6 c P L", "F#5 c P L",
      "C-5 b P L", "F#4 b P L", "C-4 b P L", "G-3 a P L",
      "D-3 a P L", "A-2 a P L", "A-2 a P L", "A-2 9 P L",
    ],
  },

  // --- 12: paddle destroyed -------------------------------------------------
  // "the worst sound in the game. Noise, low, slow decay."
  //
  // One noise voice, retriggered once and then dragged down four octaves by
  // legato over 48 frames: the LFSR clock falls with it, so a bright hiss
  // collapses into a low rumble without ever restarting. 240 ms of release on
  // the end. It is the only effect longer than half a second with no pitch in it
  // at all.
  //
  // The first two steps HOLD at the top before the collapse begins. That is the
  // impact -- the paddle breaking -- and the fifty frames after it are the
  // wreckage. It is also what keeps this from measuring the same as effect 11:
  // both are long downward glides, and they are the two cues in this game that
  // must never be confused, because one of them means the player got away with
  // it and the other means they did not.
  {
    id: 12,
    name: "paddle destroyed",
    speed: 3,
    env: [0, 60, 170, 60],
    steps: [
      "C-5 d N -", "C-5 d N L", "A-4 d N L", "F#4 c N L",
      "D#4 c N L", "C-4 c N L", "A-3 b N L", "F#3 b N L",
      "D#3 b N L", "C#3 a N L", "B-2 a N L", "A-2 a N L",
      "G-2 9 N L", "F-2 9 N L", "D#2 8 N L", "C-2 8 N L",
    ],
  },

  // --- 13: life lost, ball out of play --------------------------------------
  // "short falling three-note". Slow enough to land -- five frames a note -- but
  // it is not the paddle being destroyed, so it is a third the length of 12 and
  // it has pitch. Losing a ball is a setback; losing the paddle is a disaster.
  {
    id: 13,
    name: "life lost",
    speed: 5,
    env: [0, 8, 120, 10],
    steps: ["G-5 9 P d8", "C-5 9 P -", "G-4 8 P -"],
  },

  // --- 14: level cleared ----------------------------------------------------
  // "rising fanfare". The same C major climb as the extra life, on a bright 22%
  // pulse instead of a triangle, with a dip to G6 before the final C7 so the
  // arrival is earned. Shorter and harder than effect 6: clearing a level is an
  // achievement, an extra life is a gift.
  {
    id: 14,
    name: "level cleared",
    speed: 4,
    env: [0, 20, 190, 25],
    steps: [
      "C-5 b P d3", "E-5 b P -", "G-5 c P -", "C-6 c P -",
      "E-6 d P -", "G-6 d P -", "C-7 d P -", "G-6 c P -",
      "C-7 d P -", "C-7 d P L", "C-7 d P L", "C-7 d P L",
      "C-7 d P L", "C-7 d P L",
    ],
  },

  // --- 15: game over --------------------------------------------------------
  // "slow falling four-note". Ten frames a step is the slowest thing in the
  // bank, on a triangle, down a C minor outline to C4 held for two more steps.
  // One second, and every note lower than the last.
  {
    id: 15,
    name: "game over",
    speed: 10,
    env: [0, 30, 150, 50],
    steps: ["C-5 b T -", "G#4 a T -", "F-4 a T -", "C-4 9 T -", "C-4 9 T L", "C-4 8 T L"],
  },

  // --- 16: side pad charged -------------------------------------------------
  // "two-note tick up". Four frames. A fourth up, quiet, and out of the way --
  // the pads charge on contact and a player brushing one repeatedly must not be
  // punished for it.
  {
    id: 16,
    name: "side pad charged",
    speed: 2,
    env: [0, 3, 90, 3],
    steps: ["G-6 7 P d3", "C-7 7 P -"],
  },

  // =========================================================================
  // 17..28: THE MUSIC VOICES
  //
  // Patterns do not hold notes; they hold effect ids. So a song on this machine
  // is written as effects, and these twelve are the ones the patterns at the
  // foot of this file point at. They are numbered above 16 because
  // FORMATS-breakout-art.md ends its table at 16 and leaves 17..31 spare, and
  // this is what that space is for.
  //
  // THREE BANDS, TWO BARS EACH, TWO VOICES A BAR. A pattern ends when every
  // channel it claimed has finished, so the two voices of one bar MUST be the
  // same length: 32 steps each, at the band's own speed.
  //
  //     band A  levels 1-3    speed 6   3.2 s a bar   A minor, on the beat
  //     band B  levels 4-7    speed 5   2.7 s a bar   eighth-note bass, thin lead
  //     band C  levels 8-10   speed 4   2.1 s a bar   harmonic minor, pedal bass
  //
  // The band gets faster as the game gets harder, and that is the whole of the
  // difficulty curve in the music. It is not a key change or a new melody,
  // because a player on level 9 is not listening.
  //
  // THE LEAD IS VOLUME 3 AND THE BASS IS VOLUME 4, out of 15. Both together
  // reach 7/15 of one channel -- less than half of effect 10 on its own. The
  // lead sits on channel 2 and the bass on channel 3, so a recipe that wants the
  // song to keep out of the way of the important cues entirely can pass mask
  // 0b0100 and lose only the bass. Nothing here goes above A5 and nothing here
  // uses saw or noise: the top two octaves and both of those waveforms belong to
  // the effects.
  // =========================================================================

  // --- 17: band A, bar 1, lead ---------------------------------------------
  {
    id: 17,
    name: "A1 lead",
    speed: 6,
    env: [0, 6, 90, 4],
    steps: [
      "A-4 3 P d3", "A-4 3 P L", "C-5 3 P -", "C-5 3 P L",
      "E-5 3 P -", "E-5 3 P L", "C-5 3 P -", "C-5 3 P L",
      "B-4 3 P -", "B-4 3 P L", "D-5 3 P -", "D-5 3 P L",
      "E-5 3 P -", "E-5 3 P L", "--- 0 P -", "--- 0 P -",
      "A-4 3 P -", "A-4 3 P L", "C-5 3 P -", "C-5 3 P L",
      "F-5 3 P -", "F-5 3 P L", "E-5 3 P -", "E-5 3 P L",
      "D-5 3 P -", "D-5 3 P L", "B-4 3 P -", "B-4 3 P L",
      "G-4 3 P -", "G-4 3 P L", "--- 0 P -", "--- 0 P -",
    ],
  },

  // --- 18: band A, bar 1, bass ---------------------------------------------
  {
    id: 18,
    name: "A1 bass",
    speed: 6,
    env: [0, 8, 120, 6],
    steps: [
      "A-2 4 T -", "--- 0 T -", "A-2 4 T -", "--- 0 T -",
      "A-2 4 T -", "--- 0 T -", "E-3 4 T -", "--- 0 T -",
      "A-2 4 T -", "--- 0 T -", "A-2 4 T -", "--- 0 T -",
      "E-2 4 T -", "--- 0 T -", "E-2 4 T -", "--- 0 T -",
      "F-2 4 T -", "--- 0 T -", "F-2 4 T -", "--- 0 T -",
      "F-2 4 T -", "--- 0 T -", "C-3 4 T -", "--- 0 T -",
      "G-2 4 T -", "--- 0 T -", "G-2 4 T -", "--- 0 T -",
      "G-2 4 T -", "--- 0 T -", "D-3 4 T -", "--- 0 T -",
    ],
  },

  // --- 19: band A, bar 2, lead ---------------------------------------------
  {
    id: 19,
    name: "A2 lead",
    speed: 6,
    env: [0, 6, 90, 4],
    steps: [
      "E-5 3 P d3", "E-5 3 P L", "A-5 3 P -", "A-5 3 P L",
      "G-5 3 P -", "G-5 3 P L", "E-5 3 P -", "E-5 3 P L",
      "G-5 3 P -", "G-5 3 P L", "E-5 3 P -", "E-5 3 P L",
      "C-5 3 P -", "C-5 3 P L", "--- 0 P -", "--- 0 P -",
      "D-5 3 P -", "D-5 3 P L", "G-5 3 P -", "G-5 3 P L",
      "B-4 3 P -", "B-4 3 P L", "D-5 3 P -", "D-5 3 P L",
      "E-5 3 P -", "E-5 3 P L", "B-4 3 P -", "B-4 3 P L",
      "G#4 3 P -", "G#4 3 P L", "--- 0 P -", "--- 0 P -",
    ],
  },

  // --- 20: band A, bar 2, bass ---------------------------------------------
  {
    id: 20,
    name: "A2 bass",
    speed: 6,
    env: [0, 8, 120, 6],
    steps: [
      "A-2 4 T -", "--- 0 T -", "A-2 4 T -", "--- 0 T -",
      "A-2 4 T -", "--- 0 T -", "E-3 4 T -", "--- 0 T -",
      "C-3 4 T -", "--- 0 T -", "C-3 4 T -", "--- 0 T -",
      "G-2 4 T -", "--- 0 T -", "G-2 4 T -", "--- 0 T -",
      "G-2 4 T -", "--- 0 T -", "G-2 4 T -", "--- 0 T -",
      "D-3 4 T -", "--- 0 T -", "D-3 4 T -", "--- 0 T -",
      "E-2 4 T -", "--- 0 T -", "E-2 4 T -", "--- 0 T -",
      "E-2 4 T -", "--- 0 T -", "B-2 4 T -", "--- 0 T -",
    ],
  },

  // --- 21: band B, bar 1, lead ---------------------------------------------
  {
    id: 21,
    name: "B1 lead",
    speed: 5,
    env: [0, 5, 80, 4],
    steps: [
      "A-4 3 P d1", "C-5 3 P -", "E-5 3 P -", "C-5 3 P -",
      "A-4 3 P -", "C-5 3 P -", "E-5 3 P -", "G-5 3 P -",
      "F-5 3 P -", "E-5 3 P -", "C-5 3 P -", "A-4 3 P -",
      "B-4 3 P -", "C-5 3 P -", "D-5 3 P -", "--- 0 P -",
      "E-5 3 P -", "D-5 3 P -", "C-5 3 P -", "B-4 3 P -",
      "A-4 3 P -", "C-5 3 P -", "E-5 3 P -", "A-5 3 P -",
      "G-5 3 P -", "E-5 3 P -", "D-5 3 P -", "B-4 3 P -",
      "A-4 3 P -", "--- 0 P -", "E-5 3 P -", "--- 0 P -",
    ],
  },

  // --- 22: band B, bar 1, bass ---------------------------------------------
  {
    id: 22,
    name: "B1 bass",
    speed: 5,
    env: [0, 7, 110, 5],
    steps: [
      "A-2 4 T -", "A-2 4 T -", "--- 0 T -", "A-2 4 T -",
      "E-3 4 T -", "--- 0 T -", "A-2 4 T -", "--- 0 T -",
      "F-2 4 T -", "F-2 4 T -", "--- 0 T -", "F-2 4 T -",
      "C-3 4 T -", "--- 0 T -", "F-2 4 T -", "--- 0 T -",
      "G-2 4 T -", "G-2 4 T -", "--- 0 T -", "G-2 4 T -",
      "D-3 4 T -", "--- 0 T -", "G-2 4 T -", "--- 0 T -",
      "A-2 4 T -", "A-2 4 T -", "--- 0 T -", "A-2 4 T -",
      "E-3 4 T -", "--- 0 T -", "E-2 4 T -", "--- 0 T -",
    ],
  },

  // --- 23: band B, bar 2, lead ---------------------------------------------
  {
    id: 23,
    name: "B2 lead",
    speed: 5,
    env: [0, 5, 80, 4],
    steps: [
      "C-5 3 P d1", "E-5 3 P -", "G-5 3 P -", "E-5 3 P -",
      "C-5 3 P -", "E-5 3 P -", "A-5 3 P -", "G-5 3 P -",
      "F-5 3 P -", "D-5 3 P -", "B-4 3 P -", "D-5 3 P -",
      "G-5 3 P -", "F-5 3 P -", "D-5 3 P -", "--- 0 P -",
      "E-5 3 P -", "G-5 3 P -", "B-4 3 P -", "G-5 3 P -",
      "E-5 3 P -", "C-5 3 P -", "A-4 3 P -", "C-5 3 P -",
      "E-5 3 P -", "A-4 3 P -", "G#4 3 P -", "B-4 3 P -",
      "A-4 3 P -", "--- 0 P -", "A-4 3 P -", "--- 0 P -",
    ],
  },

  // --- 24: band B, bar 2, bass ---------------------------------------------
  {
    id: 24,
    name: "B2 bass",
    speed: 5,
    env: [0, 7, 110, 5],
    steps: [
      "C-3 4 T -", "C-3 4 T -", "--- 0 T -", "C-3 4 T -",
      "G-2 4 T -", "--- 0 T -", "C-3 4 T -", "--- 0 T -",
      "G-2 4 T -", "G-2 4 T -", "--- 0 T -", "G-2 4 T -",
      "D-3 4 T -", "--- 0 T -", "G-2 4 T -", "--- 0 T -",
      "E-2 4 T -", "E-2 4 T -", "--- 0 T -", "E-2 4 T -",
      "B-2 4 T -", "--- 0 T -", "E-2 4 T -", "--- 0 T -",
      "A-2 4 T -", "A-2 4 T -", "--- 0 T -", "A-2 4 T -",
      "E-3 4 T -", "--- 0 T -", "A-2 4 T -", "--- 0 T -",
    ],
  },

  // --- 25: band C, bar 1, lead ---------------------------------------------
  {
    id: 25,
    name: "C1 lead",
    speed: 4,
    env: [0, 5, 80, 3],
    steps: [
      "A-4 3 P d8", "B-4 3 P -", "C-5 3 P -", "B-4 3 P -",
      "A-4 3 P -", "G#4 3 P -", "A-4 3 P -", "C-5 3 P -",
      "E-5 3 P -", "D-5 3 P -", "C-5 3 P -", "B-4 3 P -",
      "A-4 3 P -", "G#4 3 P -", "E-4 3 P -", "--- 0 P -",
      "F-5 3 P -", "E-5 3 P -", "D-5 3 P -", "C-5 3 P -",
      "B-4 3 P -", "A-4 3 P -", "G#4 3 P -", "A-4 3 P -",
      "C-5 3 P -", "E-5 3 P -", "A-5 3 P -", "G#5 3 P -",
      "E-5 3 P -", "C-5 3 P -", "A-4 3 P -", "--- 0 P -",
    ],
  },

  // --- 26: band C, bar 1, bass ---------------------------------------------
  {
    id: 26,
    name: "C1 bass",
    speed: 4,
    env: [0, 6, 100, 4],
    steps: [
      "A-2 4 T -", "A-2 4 T -", "A-2 4 T -", "A-2 4 T -",
      "A-2 4 T -", "A-2 4 T -", "E-3 4 T -", "E-3 4 T -",
      "A-2 4 T -", "A-2 4 T -", "A-2 4 T -", "A-2 4 T -",
      "G#2 4 T -", "G#2 4 T -", "G#2 4 T -", "G#2 4 T -",
      "F-2 4 T -", "F-2 4 T -", "F-2 4 T -", "F-2 4 T -",
      "E-2 4 T -", "E-2 4 T -", "E-2 4 T -", "E-2 4 T -",
      "A-2 4 T -", "A-2 4 T -", "C-3 4 T -", "C-3 4 T -",
      "E-3 4 T -", "E-3 4 T -", "E-2 4 T -", "E-2 4 T -",
    ],
  },

  // --- 27: band C, bar 2, lead ---------------------------------------------
  {
    id: 27,
    name: "C2 lead",
    speed: 4,
    env: [0, 5, 80, 3],
    steps: [
      "E-5 3 P d8", "F-5 3 P -", "E-5 3 P -", "D-5 3 P -",
      "C-5 3 P -", "B-4 3 P -", "A-4 3 P -", "B-4 3 P -",
      "C-5 3 P -", "D-5 3 P -", "E-5 3 P -", "F-5 3 P -",
      "E-5 3 P -", "D-5 3 P -", "C-5 3 P -", "--- 0 P -",
      "A-5 3 P -", "G#5 3 P -", "A-5 3 P -", "E-5 3 P -",
      "C-5 3 P -", "A-4 3 P -", "G#4 3 P -", "B-4 3 P -",
      "A-4 3 P -", "C-5 3 P -", "E-5 3 P -", "A-5 3 P -",
      "G#5 3 P -", "E-5 3 P -", "A-4 3 P -", "--- 0 P -",
    ],
  },

  // --- 28: band C, bar 2, bass ---------------------------------------------
  {
    id: 28,
    name: "C2 bass",
    speed: 4,
    env: [0, 6, 100, 4],
    steps: [
      "F-2 4 T -", "F-2 4 T -", "F-2 4 T -", "F-2 4 T -",
      "C-3 4 T -", "C-3 4 T -", "C-3 4 T -", "C-3 4 T -",
      "G-2 4 T -", "G-2 4 T -", "G-2 4 T -", "G-2 4 T -",
      "D-3 4 T -", "D-3 4 T -", "D-3 4 T -", "D-3 4 T -",
      "E-2 4 T -", "E-2 4 T -", "E-2 4 T -", "E-2 4 T -",
      "E-2 4 T -", "E-2 4 T -", "B-2 4 T -", "B-2 4 T -",
      "A-2 4 T -", "A-2 4 T -", "A-2 4 T -", "A-2 4 T -",
      "E-3 4 T -", "E-3 4 T -", "E-2 4 T -", "E-2 4 T -",
    ],
  },
];

// ===========================================================================
// THE PATTERNS
//
// Byte c of a pattern is "effect id + 1 on channel c", or 0 to leave that
// channel alone. Channel 2 takes the lead and channel 3 the bass; channels 0
// and 1 are left to the engine, which fires the block, break and paddle effects
// there many times a second.
//
// Each band is a LOOP_START pattern followed by a LOOP_END pattern, so
// `snd.music(0)`, `snd.music(2)` and `snd.music(4)` each start a two-bar loop
// that repeats until something stops it.
// ===========================================================================

const BANDS = [
  { name: "band A (levels 1-3)", start: 0, bars: [[17, 18], [19, 20]] },
  { name: "band B (levels 4-7)", start: 2, bars: [[21, 22], [23, 24]] },
  { name: "band C (levels 8-10)", start: 4, bars: [[25, 26], [27, 28]] },
];

// ---------------------------------------------------------------------------
// Packing. The only part of this file that knows about nibbles and offsets.
// ---------------------------------------------------------------------------

/** The SFX bank: 32 slots of 104 bytes, exactly the region at 0x6300. */
export function buildSfx() {
  const out = new Uint8Array(SFX_COUNT * SFX_STRIDE);
  const seen = new Set();

  for (const fx of EFFECTS) {
    if (!Number.isInteger(fx.id) || fx.id < 0 || fx.id >= SFX_COUNT) {
      throw new Error(`${fx.name}: id ${fx.id} is outside the bank`);
    }
    if (seen.has(fx.id)) throw new Error(`two effects claim id ${fx.id}`);
    seen.add(fx.id);
    if (fx.steps.length < 1 || fx.steps.length > SFX_STEPS) {
      throw new Error(`${fx.name}: ${fx.steps.length} steps, want 1..${SFX_STEPS}`);
    }
    if (fx.speed < 1 || fx.speed > 255) throw new Error(`${fx.name}: speed ${fx.speed}`);
    for (const v of fx.env) {
      if (!Number.isInteger(v) || v < 0 || v > 255) throw new Error(`${fx.name}: bad envelope`);
    }

    const base = fx.id * SFX_STRIDE;
    out[base + 0] = fx.speed;
    out[base + 1] = fx.steps.length;
    out[base + 2] = 0; // LOOP_START -- nothing in this bank loops. An effect
    out[base + 3] = 0; // LOOP_END      that loops never ends on its own, and
    //                                  the engine has no way to stop one.
    out[base + 4] = fx.env[0];
    out[base + 5] = fx.env[1];
    out[base + 6] = fx.env[2];
    out[base + 7] = fx.env[3];

    for (let s = 0; s < fx.steps.length; s++) {
      let bytes;
      try {
        bytes = step(fx.steps[s]);
      } catch (e) {
        throw new Error(`${fx.name} step ${s}: ${e.message}`);
      }
      const so = base + SFX_STEPS_OFFSET + s * 3;
      out[so + 0] = bytes[0];
      out[so + 1] = bytes[1];
      out[so + 2] = bytes[2];
    }
  }
  return out;
}

/** The pattern table: six patterns of eight bytes, bound for 0x7000. */
export function buildMusic() {
  const patterns = [];
  for (const band of BANDS) {
    for (let b = 0; b < band.bars.length; b++) {
      const [lead, bass] = band.bars[b];
      const first = b === 0;
      const last = b === band.bars.length - 1;
      patterns.push({
        index: band.start + b,
        ch2: lead + 1,
        ch3: bass + 1,
        flags: (first ? PAT_LOOP_START : 0) | (last ? PAT_LOOP_END : 0),
      });
    }
  }

  const out = new Uint8Array(patterns.length * MUSIC_PATTERN_BYTES);
  for (const p of patterns) {
    if (p.index * MUSIC_PATTERN_BYTES >= out.length) {
      throw new Error(`pattern ${p.index} is past the end of the table`);
    }
    const base = p.index * MUSIC_PATTERN_BYTES;
    out[base + 0] = 0; // channel 0: the engine's paddle effect lives here
    out[base + 1] = 0; // channel 1: the engine's block and break effects
    out[base + 2] = p.ch2;
    out[base + 3] = p.ch3;
    out[base + 4] = p.flags;
  }
  return out;
}

/**
 * Every voice a pattern names must be the same length as the other voice in
 * that pattern, or the bar ends ragged.
 *
 * A pattern is over when every channel it claimed has finished its effect, so
 * two voices of different lengths do not truncate -- the short one falls silent
 * and the bar drags on until the long one is done. That is a bug you hear once
 * every loop and cannot find, which is why it is a build failure instead.
 */
function checkBars() {
  const byId = new Map(EFFECTS.map((f) => [f.id, f]));
  for (const band of BANDS) {
    for (const [lead, bass] of band.bars) {
      const a = byId.get(lead);
      const b = byId.get(bass);
      if (a === undefined || b === undefined) throw new Error(`${band.name}: missing a voice`);
      const fa = a.speed * a.steps.length;
      const fb = b.speed * b.steps.length;
      if (fa !== fb) {
        throw new Error(`${band.name}: ${a.name} is ${fa} frames and ${b.name} is ${fb}`);
      }
    }
  }
}

/**
 * The saw waveform belongs to effect 10 alone, and so does the top of the note
 * table.
 *
 * This is the second of the two rules at the head of this file, checked at
 * build time so it cannot be broken by adding an effect. The measurement that
 * proves the alarm is distinctive lives in test/sound.test.ts; this is the
 * cheap half, and it is the half that would be silently violated first.
 */
function checkAlarmIsAlone() {
  /** The music's ceiling, and the alarm's floor. A5. */
  const CEILING = 69;
  let quietest = 16;
  for (const fx of EFFECTS) {
    for (let s = 0; s < fx.steps.length; s++) {
      const [n, mix] = step(fx.steps[s]);
      const wave = mix & 0x0f;
      const vol = (mix >> 4) & 0x0f;
      if (wave === WAVE.S && fx.id !== 10) {
        throw new Error(`${fx.name} step ${s} uses saw, which belongs to effect 10`);
      }
      if (fx.id === 10) {
        if (n !== SFX_REST && n <= CEILING) {
          throw new Error(`the alarm's step ${s} reaches down into the music's register`);
        }
        quietest = Math.min(quietest, vol);
      } else if (vol >= 15) {
        throw new Error(`${fx.name} step ${s} is at volume 15, which belongs to effect 10`);
      }
      if (fx.id >= 17) {
        if (n !== SFX_REST && n > CEILING) {
          throw new Error(`music voice ${fx.name} step ${s} reaches above A5`);
        }
        if (wave === WAVE.N || wave === WAVE.S) {
          throw new Error(`music voice ${fx.name} step ${s} uses a waveform reserved for effects`);
        }
        if (vol > 4) throw new Error(`music voice ${fx.name} step ${s} is louder than 4/15`);
      }
    }
  }
  if (quietest < 12) throw new Error("the alarm dips below volume 12 and stops cutting through");
}

// ---------------------------------------------------------------------------

checkBars();
checkAlarmIsAlone();

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const sfx = buildSfx();
  const mus = buildMusic();
  writeFileSync(new URL("./sfx.bin", import.meta.url), sfx);
  writeFileSync(new URL("./music.bin", import.meta.url), mus);

  const game = EFFECTS.filter((f) => f.id <= 16);
  const music = EFFECTS.filter((f) => f.id >= 17);
  console.log(
    `redsound: ${game.length} game effects + ${music.length} music voices = ${sfx.length} bytes of sfx.bin`,
  );
  for (const fx of game) {
    const frames = fx.speed * fx.steps.length;
    console.log(
      `  ${String(fx.id).padStart(2)} ${fx.name.padEnd(18)} ` +
        `${String(fx.steps.length).padStart(2)} steps x ${fx.speed} = ${String(frames).padStart(3)} frames`,
    );
  }
  console.log(`redsound: ${mus.length / MUSIC_PATTERN_BYTES} patterns = ${mus.length} bytes of music.bin`);
  for (const band of BANDS) {
    const bars = band.bars.map(([l, b]) => `${l}+${b}`).join(", ");
    console.log(`  patterns ${band.start}..${band.start + band.bars.length - 1}  ${band.name}: ${bars}`);
  }
}

export { EFFECTS, BANDS, note, step, SFX_COUNT, SFX_STRIDE, SFX_STEPS_OFFSET, MUSIC_PATTERN_BYTES };
