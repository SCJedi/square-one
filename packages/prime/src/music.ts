/**
 * Red Breaker's music on Prime: three bands, two bars each, synthesised.
 *
 * =========================================================================
 * THE SAME SONG, NOT THE SAME CHIP
 * =========================================================================
 * `modules/redsound/README.md` writes the soundtrack as twelve tracker voices
 * for a four-channel machine: three bands over levels 1-3, 4-7 and 8-10, each
 * two bars of thirty-two steps, a lead on channel 2 and a bass on channel 3.
 * Every note below is that score, transcribed step for step -- A minor, the
 * same melody, the same bass, the same harmonic-minor turn in band C. What is
 * NOT transcribed is the machine: Prime has polyphony, real filters and a
 * stereo field, so each of the two voices is built here out of as many
 * oscillators as it takes.
 *
 * **The band gets faster as the game gets harder, and that is the whole of the
 * difficulty curve in the music.** Not a key change and not a new melody,
 * because a player on level 9 is not listening to the music -- they are
 * listening THROUGH it, for the alarm. Six frames a step, then five, then four.
 *
 * The step is measured in FRAMES, exactly as the chip's `speed` column is, and
 * that is worth keeping rather than rounding to milliseconds: at 48 kHz a frame
 * is exactly 800 samples, so every bar boundary in this file lands on a whole
 * sample and a loop that has run for a minute is still on the grid it started
 * on. See {@link createMusicScheduler} on why that is a property and not luck.
 *
 * =========================================================================
 * THE RULE THAT OUTRANKS THE TUNE: NEVER BURY THE ALARM
 * =========================================================================
 * Effect 10 is the only warning a player gets that a red ball will destroy
 * their paddle, and they have about a second to act. A soundtrack that sits on
 * top of it has cost the game its one piece of information, however good it is.
 * The small console kept clear of it four ways at once; all four transfer, and
 * `test/music.test.ts` measures every one of them rather than asserting it.
 *
 *   1. **LEVEL.** The score's summed peak gain is 0.10 against the alarm's
 *      0.45, and the number that matters is RMS rather than peak -- a quiet
 *      track sitting on a warning continuously still masks it. Measured, the
 *      alarm is six to nine times the loudest band on broadband RMS and ten to
 *      twenty-five times inside its own octave. `packages/prime/README.md`
 *      carries the table and the test fails if a number in it moves.
 *   2. **REGISTER.** Nothing in this file goes above A5 (69). Every note of the
 *      alarm is at or above B5 (71). They do not share a semitone, so there is
 *      nothing for the song to mask the alarm WITH -- and Prime adds a lowpass
 *      on top, so the lead's harmonics are rolled off before they reach the
 *      alarm's octave rather than merely being quieter there.
 *   3. **TIMBRE.** The music is pulse, triangle and sine. **Saw and noise
 *      belong to the effects**, and the alarm is the only saw anywhere in the
 *      console. A waveform nobody else uses is a channel of its own.
 *   4. **INTERRUPTION.** The chip gave the song channels 2 and 3 and let an
 *      effect that claimed one TAKE it. Prime has no voice budget, so the rule
 *      is kept deliberately rather than by accident: {@link MusicScheduler.duck}
 *      pulls the matching voice down for exactly the length of the effect --
 *      channel 3 silences the BASS, channel 2 silences the LEAD. Put the alarm
 *      on channel 3, as the bank does, and the floor drops out from under it
 *      for the whole 900 ms. That is the right trade and it is the sound of the
 *      floor going; stopping the whole song instead would put a second of
 *      silence exactly where the cue is.
 *
 * A fifth thing Prime can do that the chip could not: the lead is panned off
 * centre and the alarm is not, so they are not even in the same place.
 *
 * =========================================================================
 * WHICH BAND IS PLAYING IS SIMULATION STATE. THIS FILE IS NOT.
 * =========================================================================
 * The cart holds the band in the arena (`G.BAND`) and calls `snd.music` from
 * `tick` when it changes, so a rewind restores the band with the game. The
 * scheduler below lives in the mixer, outside the arena, and nothing it does
 * can reach simulation state -- no cart can read a bar number, a playback
 * position or an audio clock. `test/breakout.test.ts` pins that the conformance
 * chain is identical with music on and off.
 */

import { noteHz } from "./audio";

// ===========================================================================
// The bands, and where they change
// ===========================================================================

/**
 * The three tracks, as `snd.music` ids.
 *
 * The chip numbered its bands 0, 2 and 4 because a music id there was a PATTERN
 * index and a band was two patterns. Prime's track is the whole band -- the
 * scheduler owns the bar order -- so the ids are 0, 1, 2 and there is no gap
 * standing in for a machine this console does not have. Any other id, `-1`
 * included, is a console with effects and no music: it stops the song, exactly
 * as `music_a = -1` does on the small one.
 */
export const MUSIC = Object.freeze({
  /** Levels 1-3. Six frames a step. A minor, on the beat. */
  A: 0,
  /** Levels 4-7. Five frames a step. Eighth-note bass, thin lead. */
  B: 1,
  /** Levels 8-10. Four frames a step. Harmonic minor, pedal bass. */
  C: 2,
});

/** How many bands there are. */
export const MUSIC_COUNT = 3;

/**
 * Frames a band takes to come up to full volume. The chip's `music_fade`.
 *
 * Half a second, so the theme arrives UNDER the serve rather than cutting in on
 * top of it, and so a band change on the way to level 4 is a crossfade rather
 * than a splice.
 */
export const MUSIC_FADE_FRAMES = 30;

/**
 * The first cart level each band owns, counted from ZERO as `G.LEVEL` counts.
 *
 * The chip's knobs are `music_level_b = 4` and `music_level_c = 8` as the HUD
 * counts levels, and the HUD counts from one. Same boundaries, one subtraction.
 */
export const BAND_FIRST_LEVEL: readonly number[] = Object.freeze([0, 3, 7]);

/**
 * Which band a level belongs to.
 *
 * This is the only place the boundaries live. The cart asks; it does not decide
 * -- the engine holds WHEN to change band and never what a band sounds like.
 */
export function bandForLevel(level: number): number {
  const l = level | 0;
  if (l >= (BAND_FIRST_LEVEL[2] as number)) return MUSIC.C;
  if (l >= (BAND_FIRST_LEVEL[1] as number)) return MUSIC.B;
  return MUSIC.A;
}

// ===========================================================================
// The score, as data
// ===========================================================================

/** A step with no note. The tracker's `---`. */
export const REST = -1;

/** Steps in a bar. Thirty-two, as the format fixes and every band uses. */
export const BAR_STEPS = 32;

/** Ticks a second. The step is quoted in frames, so this is where it becomes time. */
const HZ = 60;

/** One of the two parts a band is written in. */
export type MusicVoice = "lead" | "bass";

/** How one part of a band is voiced. Relative gains; {@link MUSIC_LEVEL} scales. */
export interface VoiceSpec {
  readonly wave: "pulse" | "triangle" | "sine";
  /** Duty for `pulse`, in (0, 1). The chip's `d` parameter, as n/256. */
  readonly duty?: number;
  /** Cents of detune on a second copy of the voice. Thickness the chip had none of. */
  readonly detune?: number;
  /** Gain of that second copy, relative to the first. */
  readonly doubleGain?: number;
  /** Semitones below the note for a sine underneath it. 0 for none. */
  readonly sub?: number;
  readonly subGain?: number;
  /** Peak gain within the bed, before {@link MUSIC_LEVEL}. */
  readonly gain: number;
  /** Lowpass corner in hertz. The alarm's octave is above every one of these. */
  readonly cutoff: number;
  /**
   * Poles of lowpass, 2 or 4. FOUR IS THE REGISTER RULE'S TEETH.
   *
   * A two-pole corner at 2 kHz still leaves a pulse's fifth and seventh
   * harmonics audible an octave above it, which is exactly where the alarm
   * lives. Cascading a second biquad doubles the slope without moving the
   * corner, so the melody keeps its body and loses what was in the warning's
   * way. The chip had one waveform and no filter at all and had to buy this
   * with volume instead.
   */
  readonly poles: number;
  readonly q: number;
  /** Where in the stereo field. The alarm is centred; the lead is not. */
  readonly pan: number;
  readonly attack: number;
  readonly release: number;
  readonly sustain: number;
  /** Fraction of its slot a note sounds for. 1 is legato, 0.5 is staccato. */
  readonly gate: number;
  /** Steps per note slot. 2 is the chip's tied pairs; 1 is one note a step. */
  readonly div: number;
}

/** One band: a speed, two voices, and the bars they play. */
export interface BandSpec {
  readonly id: number;
  readonly name: string;
  /** The HUD levels this band owns, for the documentation. */
  readonly levels: string;
  /** Frames per step. SIX, FIVE, FOUR -- the difficulty curve. */
  readonly stepFrames: number;
  readonly lead: VoiceSpec;
  readonly bass: VoiceSpec;
  readonly bars: readonly {
    readonly lead: readonly number[];
    readonly bass: readonly number[];
  }[];
}

/**
 * The lead, band by band.
 *
 * The duties are the chip's, which are not the curve anyone would guess: band A
 * is a 22% pulse, band B a 9% one -- the thinnest voice on the machine, and the
 * reason band B reads as nervous -- and band C a 53% square, round enough to
 * carry a harmonic-minor line at four frames a step without turning into hiss.
 *
 * WHAT PRIME ADDS: a second copy eight cents sharp, and a lowpass. The detune
 * is body; the lowpass is the register rule made physical. A 9% pulse is nearly
 * all upper harmonics, and upper harmonics of an A5 land exactly where the
 * alarm lives -- so they are taken off rather than turned down.
 */
const LEAD = (duty: number): VoiceSpec =>
  Object.freeze({
    wave: "pulse",
    duty,
    detune: 8,
    doubleGain: 0.5,
    sub: 0,
    subGain: 0,
    gain: 0.55,
    cutoff: 2000,
    poles: 4,
    q: 0.7,
    pan: -0.2,
    attack: 4,
    release: 40,
    sustain: 0.75,
    // Band A's default: the chip ties its lead in pairs, so a slot is two steps
    // and the note is held right across it. Bands B and C step once a note.
    gate: 1,
    div: 2,
  });

/**
 * The bass: a triangle, as on the chip, with a sine an octave under it.
 *
 * The triangle is the waveform with no odd-harmonic buzz and nothing to argue
 * with, which is why the chip chose it and why it is still right. The sine
 * below is weight -- it lives between 40 and 85 Hz, four octaves under the
 * alarm, where nothing else in this console makes a sound at all.
 */
const BASS: VoiceSpec = Object.freeze({
  wave: "triangle",
  detune: 0,
  doubleGain: 0,
  sub: 12,
  subGain: 0.45,
  gain: 0.7,
  cutoff: 760,
  poles: 2,
  q: 0.7,
  pan: 0,
  attack: 3,
  release: 55,
  sustain: 0.6,
  gate: 0.5,
  div: 2,
});

/**
 * THE SCORE.
 *
 * Note numbers are semitones from C0, the numbering the whole console uses: 57
 * is A4, 60 is C5, 69 is A5, 28 is E2. `REST` is a step with nothing on it.
 *
 * Read a row as a bar of the tracker: band A's lead is sixteen tied pairs
 * (`div: 2`), band B's and band C's are thirty-two single steps. The bass is
 * sixteen staccato halves in band A and band B's own eighth-note pattern in B,
 * and in band C it is a pedal -- one note every step, which is most of why band
 * C feels like being chased.
 *
 * **Nothing here is above 69.** `test/music.test.ts` refuses a score that is.
 */
export const SCORE: readonly BandSpec[] = Object.freeze([
  {
    id: MUSIC.A,
    name: "band A",
    levels: "1-3",
    stepFrames: 6,
    lead: LEAD(0.22),
    bass: BASS,
    bars: [
      {
        // A4 C5 E5 C5 | B4 D5 E5 -- | A4 C5 F5 E5 | D5 B4 G4 --
        lead: [57, 60, 64, 60, 59, 62, 64, REST, 57, 60, 65, 64, 62, 59, 55, REST],
        // A2 A2 A2 E3 | A2 A2 E2 E2 | F2 F2 F2 C3 | G2 G2 G2 D3
        bass: [33, 33, 33, 40, 33, 33, 28, 28, 29, 29, 29, 36, 31, 31, 31, 38],
      },
      {
        // E5 A5 G5 E5 | G5 E5 C5 -- | D5 G5 B4 D5 | E5 B4 G#4 --
        lead: [64, 69, 67, 64, 67, 64, 60, REST, 62, 67, 59, 62, 64, 59, 56, REST],
        // A2 A2 A2 E3 | C3 C3 G2 G2 | G2 G2 D3 D3 | E2 E2 E2 B2
        bass: [33, 33, 33, 40, 36, 36, 31, 31, 31, 31, 38, 38, 28, 28, 28, 35],
      },
    ],
  },
  {
    id: MUSIC.B,
    name: "band B",
    levels: "4-7",
    stepFrames: 5,
    lead: { ...LEAD(0.09), div: 1, gate: 0.9 },
    bass: { ...BASS, div: 1, gate: 0.9, release: 40 },
    bars: [
      {
        lead: [
          57, 60, 64, 60, 57, 60, 64, 67,
          65, 64, 60, 57, 59, 60, 62, REST,
          64, 62, 60, 59, 57, 60, 64, 69,
          67, 64, 62, 59, 57, REST, 64, REST,
        ],
        bass: [
          33, 33, REST, 33, 40, REST, 33, REST,
          29, 29, REST, 29, 36, REST, 29, REST,
          31, 31, REST, 31, 38, REST, 31, REST,
          33, 33, REST, 33, 40, REST, 28, REST,
        ],
      },
      {
        lead: [
          60, 64, 67, 64, 60, 64, 69, 67,
          65, 62, 59, 62, 67, 65, 62, REST,
          64, 67, 59, 67, 64, 60, 57, 60,
          64, 57, 56, 59, 57, REST, 57, REST,
        ],
        bass: [
          36, 36, REST, 36, 31, REST, 36, REST,
          31, 31, REST, 31, 38, REST, 31, REST,
          28, 28, REST, 28, 35, REST, 28, REST,
          33, 33, REST, 33, 40, REST, 33, REST,
        ],
      },
    ],
  },
  {
    id: MUSIC.C,
    name: "band C",
    levels: "8-10",
    stepFrames: 4,
    lead: { ...LEAD(0.53), div: 1, gate: 0.9 },
    // The pedal. One note a step, articulated at 0.8 so it drives rather than drones.
    bass: { ...BASS, div: 1, gate: 0.8, release: 30, sustain: 0.5 },
    bars: [
      {
        lead: [
          57, 59, 60, 59, 57, 56, 57, 60,
          64, 62, 60, 59, 57, 56, 52, REST,
          65, 64, 62, 60, 59, 57, 56, 57,
          60, 64, 69, 68, 64, 60, 57, REST,
        ],
        bass: [
          33, 33, 33, 33, 33, 33, 40, 40,
          33, 33, 33, 33, 32, 32, 32, 32,
          29, 29, 29, 29, 28, 28, 28, 28,
          33, 33, 36, 36, 40, 40, 28, 28,
        ],
      },
      {
        lead: [
          64, 65, 64, 62, 60, 59, 57, 59,
          60, 62, 64, 65, 64, 62, 60, REST,
          69, 68, 69, 64, 60, 57, 56, 59,
          57, 60, 64, 69, 68, 64, 57, REST,
        ],
        bass: [
          29, 29, 29, 29, 36, 36, 36, 36,
          31, 31, 31, 31, 38, 38, 38, 38,
          28, 28, 28, 28, 28, 28, 35, 35,
          33, 33, 33, 33, 40, 40, 28, 28,
        ],
      },
    ],
  },
]);

/**
 * The level of the whole bed, as a linear gain on top of the voice gains.
 *
 * THIS IS THE NUMBER THE ALARM'S MARGIN IS MADE OF, and it is the one to move
 * if the mix is ever wrong -- never the alarm, which is already the loudest
 * thing in the bank and cannot be raised without shouting at the player on
 * every red ball. `packages/prime/README.md` carries the measured margin and
 * `test/music.test.ts` fails if it moves.
 */
export const MUSIC_LEVEL = 0.055;

/** Seconds in one bar of a band. Exactly `32 * frames / 60`. */
export function barSeconds(band: BandSpec): number {
  return (BAR_STEPS * band.stepFrames) / HZ;
}

/** Seconds in one full loop of a band -- its two bars. */
export function loopSeconds(band: BandSpec): number {
  return barSeconds(band) * band.bars.length;
}

/**
 * One note the score asks for: which voice, when within its bar, how long.
 *
 * Published because the interesting claims about this file -- the ceiling, the
 * waveforms, the speeds, the closest approach to the alarm -- are claims about
 * the NOTES, and a test should be able to check them without an audio context.
 */
export interface MusicEvent {
  readonly voice: MusicVoice;
  readonly note: number;
  /** Seconds from the start of the bar. */
  readonly at: number;
  /** Seconds the gate is open. The release runs on past this. */
  readonly gate: number;
}

/** Every note in one bar of a band, in time order within each voice. */
export function barEvents(band: BandSpec, bar: number): readonly MusicEvent[] {
  const out: MusicEvent[] = [];
  const step = band.stepFrames / HZ;
  const src = band.bars[bar % band.bars.length] as BandSpec["bars"][number];
  for (const voice of ["lead", "bass"] as const) {
    const spec = band[voice];
    const notes = src[voice];
    const slot = step * spec.div;
    for (let i = 0; i < notes.length; i++) {
      const n = notes[i] as number;
      if (n < 0) continue;
      out.push({ voice, note: n, at: i * slot, gate: slot * spec.gate });
    }
  }
  return out;
}

/**
 * The score's shape, published so a test can assert on it with no `AudioContext`
 * at all -- which is the only kind of test this repository can run in Node.
 */
export const SCORE_INFO: readonly {
  readonly id: number;
  readonly name: string;
  readonly levels: string;
  readonly stepFrames: number;
  readonly stepMs: number;
  readonly barSeconds: number;
  readonly loopSeconds: number;
  readonly bars: number;
  readonly notes: number;
  readonly lowest: number;
  readonly highest: number;
  readonly waves: readonly string[];
  readonly peak: number;
}[] = Object.freeze(
  SCORE.map((band) => {
    let notes = 0;
    let lowest = Infinity;
    let highest = -Infinity;
    for (let b = 0; b < band.bars.length; b++) {
      for (const e of barEvents(band, b)) {
        notes++;
        if (e.note < lowest) lowest = e.note;
        if (e.note > highest) highest = e.note;
      }
    }
    const waves = new Set<string>();
    let peak = 0;
    for (const v of [band.lead, band.bass]) {
      waves.add(v.wave);
      if ((v.subGain ?? 0) > 0) waves.add("sine");
      peak += v.gain * (1 + (v.doubleGain ?? 0) + (v.subGain ?? 0));
    }
    return Object.freeze({
      id: band.id,
      name: band.name,
      levels: band.levels,
      stepFrames: band.stepFrames,
      stepMs: (band.stepFrames * 1000) / HZ,
      barSeconds: barSeconds(band),
      loopSeconds: loopSeconds(band),
      bars: band.bars.length,
      notes,
      lowest,
      highest,
      waves: Object.freeze([...waves].sort()),
      peak: peak * MUSIC_LEVEL,
    });
  }),
);

/** The highest note anywhere in the score. The register rule's whole content. */
export const MUSIC_CEILING = Math.max(...SCORE_INFO.map((b) => b.highest));

// ===========================================================================
// The scheduler
// ===========================================================================

/** Milliseconds a ducked voice takes to get out of the way. Never zero: a click. */
const DUCK_MS = 8;

/** Milliseconds a ducked voice takes to come back. Slower than it left. */
const UNDUCK_MS = 90;

/** How far past a bar's last release its nodes are held before being dropped. */
const TAIL_S = 0.35;

/**
 * How far ahead {@link MusicScheduler.pump} is driven on a live context, in
 * seconds, and how often the mixer drives it.
 *
 * A bar is two to three seconds long and the whole bar is built in one go, so
 * the horizon only has to clear the gap between two pumps with room for a
 * scheduler that was late. Half a second of horizon against a pump every eighth
 * of a second is four chances to be on time.
 */
export const MUSIC_LOOKAHEAD_S = 0.5;

/** Milliseconds between pumps on a live context. */
export const MUSIC_PUMP_MS = 125;

/** One part's persistent bus: the thing an effect ducks. */
interface Bus {
  readonly gain: GainNode;
  readonly input: AudioNode;
  /** Context time this bus is next scheduled to be fully open. */
  openAt: number;
}

/** One band, playing. A band change crossfades between two of these. */
interface Deck {
  readonly track: number;
  readonly band: BandSpec;
  readonly gain: GainNode;
  readonly lead: Bus;
  readonly bass: Bus;
  /** Context time bar 0 starts. Every later bar is `anchor + i * barSeconds`. */
  readonly anchor: number;
  /** The next bar index to build. Counts up forever; the bar list wraps. */
  next: number;
  /** Sources still scheduled, with the time they finish. */
  live: { endsAt: number; sources: AudioScheduledSourceNode[] }[];
  dying: boolean;
}

export interface MusicScheduler {
  /** The track playing, or -1 for silence. */
  readonly track: number;
  readonly playing: boolean;
  /**
   * Start a band, crossfading over `fadeFrames`.
   *
   * **Calling it again with the band that is already playing does nothing.**
   * That is the whole reason the cart may call it every tick: `song()` asserts
   * which band SHOULD be playing and this decides whether anything has to
   * happen, so a two-bar loop is never clipped mid-bar by a level that did not
   * change the band.
   */
  play(track: number, fadeFrames?: number): void;
  /** Stop, fading over `fadeFrames`. */
  stop(fadeFrames?: number): void;
  /**
   * Build every bar that starts before `horizon`, in context seconds.
   *
   * Bar `i` starts at `anchor + i * barSeconds` -- computed, never accumulated.
   * An accumulated clock gathers one rounding per bar and is audibly behind
   * after a few minutes; this one is a single multiply and is exact to within
   * the width of a double for as long as anybody will ever play.
   */
  pump(horizon: number): void;
  /**
   * Take a voice away from the song for the length of an effect.
   *
   * The interruption rule, kept deliberately. `from` and `to` are context
   * seconds; overlapping ducks extend rather than fight.
   */
  duck(voice: MusicVoice, from: number, to: number): void;
  /** Every bar start scheduled so far, in order. The drift proof reads it. */
  readonly barTimes: readonly number[];
  dispose(): void;
}

/**
 * Build the scheduler.
 *
 * `dest` is the mixer's master gain, so the song goes through the same limiter
 * and the same mute as the effects: one bed under one bank, not a second mixer
 * beside the first.
 */
export function createMusicScheduler(
  ctx: BaseAudioContext,
  dest: AudioNode,
  opts?: { level?: number },
): MusicScheduler {
  const level = opts?.level ?? MUSIC_LEVEL;
  const waves = new Map<number, PeriodicWave>();
  const bars: number[] = [];
  let deck: Deck | null = null;
  let fading: Deck[] = [];
  let disposed = false;

  /**
   * A pulse wave of the given duty, from its Fourier series.
   *
   * The same construction `audio.ts` uses for the effects, and deliberately the
   * same: the difference between a 9% lead and a 53% one is most of what
   * separates band B from band C, and `OscillatorNode` has square and sawtooth
   * and nothing between them.
   */
  function pulse(duty: number): PeriodicWave {
    const key = Math.round(duty * 1000);
    const cached = waves.get(key);
    if (cached !== undefined) return cached;
    const N = 32;
    const real = new Float32Array(N + 1);
    const imag = new Float32Array(N + 1);
    for (let n = 1; n <= N; n++) real[n] = (2 / (n * Math.PI)) * Math.sin(n * Math.PI * duty);
    const w = ctx.createPeriodicWave(real, imag, { disableNormalization: false });
    waves.set(key, w);
    return w;
  }

  function osc(spec: VoiceSpec, detune: number): OscillatorNode {
    const o = ctx.createOscillator();
    if (spec.wave === "pulse") o.setPeriodicWave(pulse(spec.duty ?? 0.5));
    else o.type = spec.wave === "sine" ? "sine" : "triangle";
    if (detune !== 0) o.detune.value = detune;
    return o;
  }

  /**
   * A persistent, duckable bus for one voice of one deck.
   *
   * The filter and the panner live HERE rather than on each bar, so a bar
   * boundary is not a discontinuity in either, and so a duck applies to the
   * voice rather than to whichever bar happened to be sounding.
   */
  function bus(spec: VoiceSpec, out: AudioNode): Bus {
    const g = ctx.createGain();
    g.gain.value = 1;
    // One biquad per two poles, in series. The corner does not move; the slope
    // past it doubles.
    const stages: BiquadFilterNode[] = [];
    for (let i = 0; i < Math.max(1, Math.round(spec.poles / 2)); i++) {
      const f = ctx.createBiquadFilter();
      f.type = "lowpass";
      f.frequency.value = spec.cutoff;
      f.Q.value = spec.q;
      stages.push(f);
    }
    for (let i = 0; i + 1 < stages.length; i++) {
      (stages[i] as BiquadFilterNode).connect(stages[i + 1] as BiquadFilterNode);
    }
    (stages[stages.length - 1] as BiquadFilterNode).connect(g);
    const head = stages[0] as BiquadFilterNode;
    if (spec.pan !== 0 && typeof ctx.createStereoPanner === "function") {
      const p = ctx.createStereoPanner();
      p.pan.value = spec.pan;
      g.connect(p).connect(out);
    } else {
      g.connect(out);
    }
    return { gain: g, input: head, openAt: -Infinity };
  }

  /**
   * Build one voice of one bar: one envelope, and as many oscillators as the
   * voice is thick.
   *
   * ONE OSCILLATOR PER BAR, NOT ONE PER NOTE. The pitch is stepped with
   * `setValueAtTime` exactly as the effect bank steps its note lists, and the
   * gain envelope carries the articulation -- which is both far fewer nodes and
   * a truer reading of a tracker, where a channel is a continuous voice being
   * retriggered rather than thirty-two separate sounds.
   */
  function buildVoice(
    band: BandSpec,
    voice: MusicVoice,
    bar: number,
    at: number,
    target: Bus,
    live: AudioScheduledSourceNode[],
  ): number {
    const spec = band[voice];
    const notes = (band.bars[bar] as BandSpec["bars"][number])[voice];
    const step = band.stepFrames / HZ;
    const slot = step * spec.div;
    const barLen = barSeconds(band);

    const amp = ctx.createGain();
    amp.gain.value = 0;
    amp.connect(target.input);

    const voices: OscillatorNode[] = [];
    const main = osc(spec, 0);
    main.connect(amp);
    voices.push(main);

    let doubled: OscillatorNode | null = null;
    if ((spec.detune ?? 0) !== 0 && (spec.doubleGain ?? 0) > 0) {
      doubled = osc(spec, spec.detune ?? 0);
      const g = ctx.createGain();
      g.gain.value = spec.doubleGain ?? 0;
      doubled.connect(g).connect(amp);
      voices.push(doubled);
    }

    let sub: OscillatorNode | null = null;
    if ((spec.sub ?? 0) > 0 && (spec.subGain ?? 0) > 0) {
      sub = ctx.createOscillator();
      sub.type = "sine";
      const g = ctx.createGain();
      g.gain.value = spec.subGain ?? 0;
      sub.connect(g).connect(amp);
      voices.push(sub);
    }

    const peak = spec.gain * level;
    const atk = Math.max(0.001, spec.attack / 1000);
    // The release may never run into the next slot: two overlapping envelopes on
    // one param is a note that never closes and a bed that creeps upward.
    const rel = Math.min(Math.max(0.004, spec.release / 1000), slot * (1 - spec.gate) + 0.004);
    let end = at;

    amp.gain.setValueAtTime(0, at);
    for (let i = 0; i < notes.length; i++) {
      const n = notes[i] as number;
      if (n < 0) continue;
      const t = at + i * slot;
      const hz = noteHz(n);
      main.frequency.setValueAtTime(hz, t);
      if (doubled !== null) doubled.frequency.setValueAtTime(hz, t);
      if (sub !== null) sub.frequency.setValueAtTime(noteHz(n - (spec.sub ?? 12)), t);
      const gate = Math.max(atk + 0.001, slot * spec.gate);
      amp.gain.setValueAtTime(0, t);
      amp.gain.linearRampToValueAtTime(peak, t + atk);
      amp.gain.linearRampToValueAtTime(peak * spec.sustain, t + gate);
      amp.gain.linearRampToValueAtTime(0, t + gate + rel);
      if (t + gate + rel > end) end = t + gate + rel;
    }

    const stopAt = Math.max(end, at + barLen) + 0.02;
    for (const v of voices) {
      v.start(at);
      v.stop(stopAt);
      live.push(v);
    }
    return end;
  }

  function makeDeck(track: number, band: BandSpec, anchor: number, fade: number): Deck {
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, anchor);
    g.gain.linearRampToValueAtTime(1, anchor + Math.max(0.001, fade));
    g.connect(dest);
    return {
      track,
      band,
      gain: g,
      lead: bus(band.lead, g),
      bass: bus(band.bass, g),
      anchor,
      next: 0,
      live: [],
      dying: false,
    };
  }

  function buildBar(d: Deck): void {
    const i = d.next++;
    const at = d.anchor + i * barSeconds(d.band);
    const bar = i % d.band.bars.length;
    const sources: AudioScheduledSourceNode[] = [];
    let end = at;
    for (const voice of ["lead", "bass"] as const) {
      const e = buildVoice(d.band, voice, bar, at, voice === "lead" ? d.lead : d.bass, sources);
      if (e > end) end = e;
    }
    d.live.push({ endsAt: end + TAIL_S, sources });
    bars.push(at);
  }

  function retire(d: Deck, fade: number): void {
    if (d.dying) return;
    d.dying = true;
    const t = ctx.currentTime;
    try {
      d.gain.gain.cancelScheduledValues(t);
      d.gain.gain.setValueAtTime(d.gain.gain.value, t);
      d.gain.gain.linearRampToValueAtTime(0, t + Math.max(0.004, fade));
    } catch {
      // A node whose context went away. There is nothing left to fade.
    }
    const off = t + Math.max(0.004, fade) + 0.02;
    for (const b of d.live) {
      for (const s of b.sources) {
        try {
          s.stop(off);
        } catch {
          // Already stopped, or its context closed. Either way it is quiet.
        }
      }
    }
    fading.push(d);
  }

  /** Drop the nodes of bars that have finished, so a long run does not grow. */
  function sweep(now: number): void {
    for (const d of [deck, ...fading]) {
      if (d === null) continue;
      d.live = d.live.filter((b) => b.endsAt > now);
    }
    for (const d of fading) {
      if (d.live.length > 0) continue;
      try {
        d.gain.disconnect();
      } catch {
        // The context closed underneath it.
      }
    }
    fading = fading.filter((d) => d.live.length > 0);
  }

  return {
    get track(): number {
      return deck !== null && !deck.dying ? deck.track : -1;
    },
    get playing(): boolean {
      return deck !== null && !deck.dying;
    },
    get barTimes(): readonly number[] {
      return bars;
    },

    play(track: number, fadeFrames?: number): void {
      if (disposed) return;
      const band = SCORE[track | 0];
      const fade = Math.max(0, fadeFrames ?? MUSIC_FADE_FRAMES) / HZ;
      if (band === undefined) {
        // An id this console has no band for. The honest answer is silence --
        // the same answer `music_a = -1` gets on the small machine.
        if (deck !== null) retire(deck, fade);
        deck = null;
        return;
      }
      // The whole reason a cart may call this every tick.
      if (deck !== null && !deck.dying && deck.track === (track | 0)) return;
      if (deck !== null) retire(deck, fade);
      deck = makeDeck(track | 0, band, ctx.currentTime + 0.01, fade);
    },

    stop(fadeFrames?: number): void {
      if (deck !== null) retire(deck, Math.max(0, fadeFrames ?? MUSIC_FADE_FRAMES) / HZ);
      deck = null;
    },

    pump(horizon: number): void {
      if (disposed) return;
      const d = deck;
      if (d !== null && !d.dying) {
        const bar = barSeconds(d.band);
        const now = ctx.currentTime;
        // Bounded, so a horizon handed in by mistake cannot build an hour of
        // music in one tick and stall the page that asked for four bars.
        let guard = 512;
        while (d.anchor + d.next * bar < horizon && guard-- > 0) {
          // A BAR WHOSE TIME HAS PASSED IS SKIPPED, NOT BUILT LATE. A
          // backgrounded tab stops firing timers, and a pump that woke up a
          // minute behind would hand the context twenty-eight bars all dated in
          // the past -- which WebAudio starts at once, on top of each other.
          // Skipping puts the song back on its own grid at the next real bar,
          // which is the only place it was ever going to be.
          if (d.anchor + d.next * bar < now) {
            d.next++;
            continue;
          }
          buildBar(d);
        }
      }
      sweep(ctx.currentTime);
    },

    duck(voice: MusicVoice, from: number, to: number): void {
      const d = deck;
      if (d === null || d.dying) return;
      const b = voice === "lead" ? d.lead : d.bass;
      const down = DUCK_MS / 1000;
      const up = UNDUCK_MS / 1000;
      const g = b.gain.gain;
      try {
        g.cancelScheduledValues(from);
        if (from < b.openAt) {
          // Already out of the way for something else. Hold it down and extend.
          g.setValueAtTime(0, from);
        } else {
          g.setValueAtTime(1, from);
          g.linearRampToValueAtTime(0, from + down);
        }
        const back = Math.max(to, from + down);
        g.setValueAtTime(0, back);
        g.linearRampToValueAtTime(1, back + up);
        b.openAt = back + up;
      } catch {
        // A node whose context went away.
      }
    },

    dispose(): void {
      disposed = true;
      const t = ctx.currentTime;
      for (const d of [deck, ...fading]) {
        if (d === null) continue;
        for (const b of d.live) {
          for (const s of b.sources) {
            try {
              s.stop(t);
            } catch {
              // Already stopped, or its context closed.
            }
          }
        }
        try {
          d.gain.disconnect();
        } catch {
          // The context closed underneath it.
        }
      }
      deck = null;
      fading = [];
      waves.clear();
    },
  };
}
