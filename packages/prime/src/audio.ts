/**
 * The sound of Red Breaker on Prime: seventeen effects, synthesised.
 *
 * =========================================================================
 * REPRODUCE THE CHARACTER, NOT THE CHIP
 * =========================================================================
 * `modules/redsound/README.md` measures every effect the small console makes --
 * duration, peak, the note it starts on, the note it ends on, which way it
 * moves, which waveform carries it. Those numbers are the brief for this file
 * and they are honoured row for row. What is NOT honoured is the machine: Prime
 * is not four channels of a 4-bit volume column, so nothing here is quantised to
 * one, and an effect the chip had to imply with a single square wave is built
 * here out of as many voices as it takes.
 *
 * The rule that decides every case: **the game must sound like the same game,
 * better.** A block hit is still the highest of the three constant blips, still
 * the thinnest, still rising -- it simply has a filter on it now.
 *
 * =========================================================================
 * RULE ONE: THE THREE THAT FIRE CONSTANTLY
 * =========================================================================
 * Effects 0, 2 and 3 -- block hit, paddle hit, wall hit -- are what ninety
 * seconds of a rally is made of. They are the three quietest things in the bank
 * and the three shortest, and they separate on THREE AXES AT ONCE, because a
 * player has to hear WHICH of them fired and three blips differing only in
 * volume are one blip:
 *
 *   0 block   C6, the highest    a 22% pulse, thin    rises
 *   2 paddle  C5, an octave down a 50% pulse, round   rises
 *   3 wall    G5, between them   a triangle, softest  falls
 *
 * A bank that is annoying after ninety seconds has failed however good the
 * fanfare is, so these three are the numbers to be most careful with.
 *
 * =========================================================================
 * RULE TWO: EFFECT 10 IS UNLIKE EVERYTHING ELSE
 * =========================================================================
 * The ball turning RED is the only warning the player gets and they have about a
 * second to do the opposite of everything the game has taught them. The chip
 * version earns its distance from the rest of the bank five independent ways,
 * and all five are kept:
 *
 *   1. It is the only SAW here, effects and all.
 *   2. It OSCILLATES -- it alternates between two notes rather than moving.
 *   3. Its mean pitch DOES NOT MOVE. The pair is centred on F#6 and WIDENS, a
 *      minor third out to a major ninth, so it correlates with nothing that
 *      rises and nothing that falls.
 *   4. Its loudness is FLAT while the gate is open. Everything else decays.
 *   5. It is the loudest and the highest thing in the bank: B5 to C#7.
 *
 * What Prime's headroom buys on top of that is body -- a second saw detuned nine
 * cents against the first, and a resonant lowpass -- so it is not just louder
 * than the chip's alarm but genuinely nastier.
 *
 * =========================================================================
 * CHANNELS, WHICH ARE A MECHANIC AND NOT A BUDGET
 * =========================================================================
 * This file has no voice limit, so the four channels are not here to ration
 * anything. They are here because WHICH EFFECT INTERRUPTS WHICH IS PART OF THE
 * GAME:
 *
 *   - The beam deflection (11) and the alarm (10) share channel 3, so the
 *     deflection CUTS THE ALARM OFF MID-WARBLE. The sound of relief interrupts
 *     the sound of danger, and the player hears the warning stop. That is the
 *     whole message and it is the reason the beam feels like a rescue.
 *   - Game over (15) takes the channel from the lost life (13) a frame later,
 *     which is why a player hears "life lost" on every life except the last.
 *   - The paddle destroyed (12) is there too: whatever is playing, the player
 *     needs to hear that they lost.
 *
 * A new effect on a busy channel fades the old one out over 8 ms rather than
 * cutting it, because an oscillator stopped mid-cycle is a click and a click is
 * the one sound in here nobody designed.
 *
 * =========================================================================
 * AUTOPLAY, HONESTLY
 * =========================================================================
 * A browser will not start an `AudioContext` outside a user gesture, and the
 * refusal is quiet: `resume()` resolves, `state` stays "suspended", and the page
 * plays nothing while looking fine. So, exactly as
 * `packages/player/src/audio-graph.ts` does it, `start()` RESOLVES ONLY WHEN THE
 * CONTEXT IS ACTUALLY RUNNING and rejects otherwise, `state` reports
 * "suspended" rather than "running" so a shell can say so on screen, and the
 * context and its graph are kept so a later gesture is one `resume()` away. A
 * mixer that claims to be playing while it is not is worse than one that admits
 * it.
 *
 * =========================================================================
 * AND IT MUST BE SAFE TO CALL FROM A HEADLESS TEST
 * =========================================================================
 * {@link createRecordingSnd} is a backend that records calls instead of making
 * them audible -- the same role the small console's tests get by reading the
 * audio registers out of RAM. The cart's suite asserts that the right effect
 * fires on the right tick through it, and `sim.test.ts` asserts that the arena
 * is byte-identical whichever backend is installed. Audio is not simulation.
 */

import type { Snd, SndOpts } from "./sim";

// ===========================================================================
// The bank's numbering
// ===========================================================================

/**
 * The seventeen effects, numbered exactly as `modules/FORMATS-breakout-art.md`
 * fixes them and `modules/redsound/README.md` measures them.
 *
 * The numbering is shared vocabulary: the cart names an event, the bank below
 * says what it sounds like, and the recording backend records the number. A
 * renumbering here is a renumbering of the game's sound, which is why it is one
 * table and not two.
 */
export const SFX = Object.freeze({
  /** A block is hit and survives. */
  HIT: 0,
  /** A block breaks. */
  BREAK: 1,
  /** The paddle returns a ball. */
  PADDLE: 2,
  /** A side wall or the ceiling -- `edge()`, never `bounce()`. */
  WALL: 3,
  /** A drop appears out of a broken block. */
  SPAWN: 4,
  /** A drop is caught. */
  DROP: 5,
  /** The extra life is caught. */
  LIFE: 6,
  /** A shot is fired. */
  SHOOT: 7,
  /** A shielded block holds. */
  PING: 8,
  /** A shielded block breaks. */
  SHIELD: 9,
  /** THE BALL TURNS RED. The only warning the player gets. */
  RED: 10,
  /** The beam catches it. */
  DEFLECT: 11,
  /** The paddle is destroyed. */
  SMASH: 12,
  /** A ball falls out of the world. */
  LOSE: 13,
  /** A level is cleared, the last one included. */
  CLEAR: 14,
  /** The last life goes. */
  OVER: 15,
  /** A side pad charges a shot. */
  CHARGE: 16,
});

/** How many effects the bank holds. */
export const SFX_COUNT = 17;

// ===========================================================================
// The recording backend -- the one a headless test uses
// ===========================================================================

/** One call a cart made, as the recording backend saw it. */
export interface SndCall {
  /** The tick the call was made on, or -1n when the backend has no clock. */
  readonly tick: bigint;
  /** `play` carries the effect id; `music` carries the track; `stopMusic` is -1. */
  readonly id: number;
  readonly kind: "play" | "music" | "stopMusic";
  readonly opts?: SndOpts;
}

export interface RecordingSnd extends Snd {
  /** Every call since the last {@link RecordingSnd.clear}, in order. */
  readonly calls: readonly SndCall[];
  /** Just the effect ids from `play`, for the common assertion. */
  readonly ids: readonly number[];
  /** True when `play(id)` was called since the last clear. */
  played(id: number): boolean;
  clear(): void;
}

/**
 * A backend that records instead of playing.
 *
 * Pass a `clock` -- `() => machine.tick` -- and every call is stamped with the
 * tick that made it, which is what turns "the alarm fires" into "the alarm fires
 * on the same tick the RED bit is set". The machine runs the cart before it
 * increments the counter, so the stamp is the index of the tick that was
 * running, exactly as `sim.tick` reads inside `tick`.
 */
export function createRecordingSnd(clock?: () => bigint): RecordingSnd {
  const calls: SndCall[] = [];
  const now = (): bigint => {
    if (clock === undefined) return -1n;
    try {
      return clock();
    } catch {
      return -1n;
    }
  };
  return {
    calls,
    get ids(): readonly number[] {
      return calls.filter((c) => c.kind === "play").map((c) => c.id);
    },
    played(id: number): boolean {
      return calls.some((c) => c.kind === "play" && c.id === id);
    },
    clear(): void {
      calls.length = 0;
    },
    play(id: number, opts?: SndOpts): void {
      calls.push(opts === undefined
        ? { tick: now(), id, kind: "play" }
        : { tick: now(), id, kind: "play", opts });
    },
    music(id: number): void {
      calls.push({ tick: now(), id, kind: "music" });
    },
    stopMusic(): void {
      calls.push({ tick: now(), id: -1, kind: "stopMusic" });
    },
  };
}

// ===========================================================================
// The bank, as data
// ===========================================================================

/**
 * Semitones from C0 to hertz. The numbering `modules/redsound/README.md` uses:
 * 60 is C5, 72 is C6, 84 is C7.
 *
 * Fractional notes are legal and effect 10 depends on them -- its pair widens
 * around F#6 in half-semitone steps, which is how the mean pitch stays put.
 */
export function noteHz(n: number): number {
  return 16.351597831287414 * 2 ** (n / 12);
}

/** A pitched voice: a waveform, a list of notes, and an envelope. */
interface ToneSpec {
  readonly kind: "tone";
  readonly wave: "sine" | "square" | "sawtooth" | "triangle" | "pulse";
  /** Duty for `pulse`, in (0, 1). Ignored otherwise. */
  readonly duty?: number;
  /** Notes in semitones from C0, each held `step` milliseconds. */
  readonly notes: readonly number[];
  /** Milliseconds per note. */
  readonly step: number;
  /** Peak linear gain. See the header on the three that fire constantly. */
  readonly gain: number;
  /** Milliseconds of attack. Short, but never zero: zero is a click. */
  readonly attack?: number;
  /** Milliseconds of release after the last note. */
  readonly release?: number;
  /** Level at the end of the gate, as a fraction of peak. 1 holds flat. */
  readonly sustain?: number;
  /** Ramp between notes instead of stepping to them. */
  readonly glide?: boolean;
  /** Detune in cents. Two copies of a voice a few cents apart is thickness. */
  readonly detune?: number;
  /** Lowpass corner in hertz. 0 or absent leaves the voice unfiltered. */
  readonly cutoff?: number;
  /** Resonance at the corner. */
  readonly q?: number;
  /** Tremolo rate in hertz. Effect 10's throb. */
  readonly trem?: number;
  /** How deep the tremolo cuts, 0..1. */
  readonly tremDepth?: number;
  /** Milliseconds to wait before this part starts. */
  readonly delay?: number;
}

/** An unpitched voice: noise through a sweeping filter. */
interface NoiseSpec {
  readonly kind: "noise";
  readonly filter: "lowpass" | "bandpass" | "highpass";
  /** Filter corner at the start, in hertz. */
  readonly from: number;
  /** Filter corner at the end. */
  readonly to: number;
  readonly ms: number;
  readonly gain: number;
  readonly q?: number;
  readonly attack?: number;
  readonly release?: number;
  readonly sustain?: number;
  readonly delay?: number;
}

type PartSpec = ToneSpec | NoiseSpec;

/** One effect: which channel it claims, and the voices it is made of. */
interface SfxSpec {
  /** 0..3. Channels are an interruption rule, not a voice budget -- see header. */
  readonly ch: number;
  readonly parts: readonly PartSpec[];
}

/**
 * THE BANK.
 *
 * One entry per effect, in the numbering above, each a few lines of data --
 * kept that way on purpose, because a changed sound should be a changed number
 * in a reviewable diff, exactly as the small console's tracker text is.
 *
 * The channel column is the one in `modules/redsound/README.md`'s wiring table
 * and it is load-bearing: 10, 11, 12, 13, 14 and 15 all share channel 3.
 */
const BANK: readonly SfxSpec[] = [
  // 0 -- BLOCK HIT. Highest of the three constants, thinnest, rises, quietest.
  {
    ch: 1,
    parts: [
      {
        kind: "tone",
        wave: "pulse",
        duty: 0.22,
        notes: [72, 74],
        step: 22,
        gain: 0.078,
        attack: 1,
        release: 34,
        sustain: 0.5,
        cutoff: 6500,
      },
    ],
  },
  // 1 -- BLOCK BREAKS. A pitched fall and then noise, 117 ms.
  {
    ch: 1,
    parts: [
      {
        kind: "tone",
        wave: "pulse",
        duty: 0.3,
        notes: [76, 69, 64, 58, 54],
        step: 21,
        gain: 0.1,
        attack: 1,
        release: 45,
        sustain: 0.45,
        cutoff: 5200,
      },
      {
        kind: "noise",
        filter: "bandpass",
        from: 2800,
        to: 700,
        ms: 105,
        gain: 0.085,
        q: 1.1,
        attack: 2,
        release: 60,
        sustain: 0.2,
        delay: 10,
      },
    ],
  },
  // 2 -- PADDLE. An octave below the block, rounder, rises.
  {
    ch: 0,
    parts: [
      {
        kind: "tone",
        wave: "pulse",
        duty: 0.5,
        notes: [60, 62],
        step: 25,
        gain: 0.064,
        attack: 1,
        release: 38,
        sustain: 0.45,
        cutoff: 2400,
      },
    ],
  },
  // 3 -- WALL. Between the other two, the softest voice here, and it FALLS.
  {
    ch: 1,
    parts: [
      {
        kind: "tone",
        wave: "triangle",
        notes: [67, 66],
        step: 25,
        gain: 0.05,
        attack: 1,
        release: 40,
        sustain: 0.4,
        cutoff: 3200,
      },
    ],
  },
  // 4 -- A DROP APPEARS. Rising, so it reads as something arriving.
  {
    ch: 2,
    parts: [
      {
        kind: "tone",
        wave: "pulse",
        duty: 0.22,
        notes: [69, 72, 76],
        step: 39,
        gain: 0.092,
        attack: 2,
        release: 50,
        sustain: 0.6,
        cutoff: 5200,
      },
    ],
  },
  // 5 -- A DROP IS CAUGHT. The same gesture, further, and it arrives.
  {
    ch: 2,
    parts: [
      {
        kind: "tone",
        wave: "pulse",
        duty: 0.5,
        notes: [72, 76, 79, 84],
        step: 54,
        gain: 0.105,
        attack: 2,
        release: 95,
        sustain: 0.7,
        cutoff: 4200,
      },
    ],
  },
  // 6 -- THE EXTRA LIFE. The longest and warmest thing in the bank: a run up
  // the C major triad to C7, a held C7, then a second shorter climb arriving at
  // the SAME C7 and staying. Two arrivals at one note -- the first says it
  // happened, the second says it is yours.
  {
    ch: 2,
    parts: [
      {
        kind: "tone",
        wave: "triangle",
        notes: [60, 64, 67, 72, 76, 79, 84, 84, 84, 72, 79, 84, 84, 84, 84, 84, 84, 84],
        step: 88,
        gain: 0.125,
        attack: 6,
        release: 190,
        sustain: 1,
        cutoff: 6000,
      },
      {
        kind: "tone",
        wave: "sine",
        notes: [48, 52, 55, 60, 64, 67, 72, 72, 72, 60, 67, 72, 72, 72, 72, 72, 72, 72],
        step: 88,
        gain: 0.042,
        attack: 6,
        release: 190,
        sustain: 1,
      },
    ],
  },
  // 7 -- A SHOT. The thinnest pulse in the bank, high and falling fast.
  {
    ch: 2,
    parts: [
      {
        kind: "tone",
        wave: "pulse",
        duty: 0.12,
        notes: [88, 82, 74, 67],
        step: 20,
        gain: 0.095,
        attack: 1,
        release: 34,
        sustain: 0.4,
        cutoff: 7500,
        glide: true,
      },
    ],
  },
  // 8 -- A SHIELD HOLDS. Almost the top of the keyboard and almost nothing: the
  // sound of a shot that did not work.
  {
    ch: 2,
    parts: [
      {
        kind: "tone",
        wave: "pulse",
        duty: 0.12,
        notes: [91, 89],
        step: 25,
        gain: 0.09,
        attack: 1,
        release: 62,
        sustain: 0.35,
        cutoff: 9000,
      },
    ],
  },
  // 9 -- A SHIELD BREAKS. Noise, with a metal ghost over it so it reads as a
  // shield rather than as any other break.
  {
    ch: 2,
    parts: [
      {
        kind: "noise",
        filter: "bandpass",
        from: 3200,
        to: 420,
        ms: 118,
        gain: 0.14,
        q: 1.4,
        attack: 1,
        release: 70,
        sustain: 0.25,
      },
      {
        kind: "tone",
        wave: "triangle",
        notes: [84, 70, 58, 52],
        step: 30,
        gain: 0.06,
        attack: 1,
        release: 70,
        sustain: 0.3,
      },
    ],
  },
  // 10 -- THE ALARM. See the header: the only saw, the only oscillating
  // contour, a fixed centre that WIDENS from a minor third to a major ninth,
  // flat while the gate is open, and the loudest thing here. Twenty-four steps
  // of 35 ms is 840 ms -- about a second to react, which is the whole design.
  {
    ch: 3,
    parts: [
      {
        kind: "tone",
        wave: "sawtooth",
        notes: [
          76.5, 79.5, 76.5, 79.5, // a minor third around F#6
          75, 81, 75, 81, // a tritone
          74, 82, 74, 82, // a minor sixth
          73, 83, 73, 83, // a minor seventh
          72, 84, 72, 84, // an octave
          71, 85, 71, 85, // a major ninth: B5 to C#7
        ],
        step: 35,
        gain: 0.3,
        attack: 3,
        release: 70,
        sustain: 1,
        cutoff: 7000,
        q: 1.6,
        trem: 13,
        tremDepth: 0.34,
      },
      {
        kind: "tone",
        wave: "sawtooth",
        detune: 9,
        notes: [
          76.5, 79.5, 76.5, 79.5, 75, 81, 75, 81, 74, 82, 74, 82, 73, 83, 73, 83, 72, 84, 72, 84,
          71, 85, 71, 85,
        ],
        step: 35,
        gain: 0.15,
        attack: 3,
        release: 70,
        sustain: 1,
        cutoff: 5200,
        trem: 13,
        tremDepth: 0.34,
      },
    ],
  },
  // 11 -- THE BEAM CATCHES IT. Relief, and it INTERRUPTS THE ALARM: same
  // channel, so the warning stops where it stands.
  //
  // A tritone a step from C7 down to C4, then three fourths down to A2, and
  // then IT STOPS -- holding A2 for a quarter of its length. That plateau is
  // the difference between "something is falling" and "something was caught",
  // and the sine underneath it is what makes the landing land.
  {
    ch: 3,
    parts: [
      {
        kind: "tone",
        wave: "pulse",
        duty: 0.5,
        notes: [84, 78, 72, 66, 60, 54, 48, 43, 38, 33, 33, 33, 33, 33],
        step: 35,
        gain: 0.115,
        attack: 2,
        release: 120,
        sustain: 0.85,
        cutoff: 3600,
      },
      {
        kind: "tone",
        wave: "sine",
        notes: [33],
        step: 150,
        gain: 0.075,
        attack: 8,
        release: 220,
        sustain: 0.8,
        delay: 340,
      },
    ],
  },
  // 12 -- THE PADDLE IS DESTROYED. The worst sound in the game, and it should
  // be: a crack, a long noise body collapsing from 3.5 kHz to 90 Hz, and a saw
  // falling two and a half octaves under it. Nothing else here is this big.
  {
    ch: 3,
    parts: [
      {
        kind: "noise",
        filter: "highpass",
        from: 4200,
        to: 1800,
        ms: 70,
        gain: 0.12,
        q: 0.7,
        attack: 1,
        release: 40,
        sustain: 0.2,
      },
      {
        kind: "noise",
        filter: "lowpass",
        from: 3500,
        to: 300,
        ms: 900,
        gain: 0.23,
        q: 1.5,
        attack: 3,
        release: 180,
        sustain: 0.35,
      },
      {
        kind: "tone",
        wave: "sawtooth",
        notes: [60, 50, 42, 36, 30, 24],
        step: 155,
        gain: 0.09,
        attack: 4,
        release: 260,
        sustain: 0.4,
        cutoff: 2500,
        glide: true,
      },
    ],
  },
  // 13 -- A BALL IS LOST. NOT the paddle being destroyed: a different event
  // gets a different sound, or the player cannot tell which one happened.
  {
    ch: 3,
    parts: [
      {
        kind: "tone",
        wave: "pulse",
        duty: 0.5,
        notes: [67, 62, 55],
        step: 80,
        gain: 0.115,
        attack: 3,
        release: 110,
        sustain: 0.5,
        cutoff: 2600,
      },
    ],
  },
  // 14 -- A LEVEL IS CLEARED. The only fanfare, and it arrives on C7 with a
  // fifth over it.
  {
    ch: 3,
    parts: [
      {
        kind: "tone",
        wave: "pulse",
        duty: 0.22,
        notes: [60, 64, 67, 72, 76, 79, 84, 84, 84, 84, 84, 84],
        step: 85,
        gain: 0.115,
        attack: 3,
        release: 150,
        sustain: 0.9,
        cutoff: 6000,
      },
      {
        kind: "tone",
        wave: "pulse",
        duty: 0.5,
        notes: [67, 71, 74, 79, 83, 86, 91, 91, 91, 91, 91, 91],
        step: 85,
        gain: 0.038,
        attack: 3,
        release: 150,
        sustain: 0.9,
        cutoff: 6000,
      },
    ],
  },
  // 15 -- GAME OVER. Triangle, falling, with an octave under it for weight. It
  // takes channel 3 from the lost life a frame earlier, which is why "life
  // lost" is heard on every life except the last.
  {
    ch: 3,
    parts: [
      {
        kind: "tone",
        wave: "triangle",
        notes: [60, 58, 55, 53, 51, 48, 48, 48],
        step: 140,
        gain: 0.13,
        attack: 6,
        release: 280,
        sustain: 0.85,
        cutoff: 2600,
      },
      {
        kind: "tone",
        wave: "triangle",
        notes: [48, 46, 43, 41, 39, 36, 36, 36],
        step: 140,
        gain: 0.06,
        attack: 6,
        release: 280,
        sustain: 0.85,
        cutoff: 1400,
      },
    ],
  },
  // 16 -- A SIDE PAD CHARGES A SHOT. Short, rising, and clearly the gun's
  // colour rather than the ball's.
  {
    ch: 2,
    parts: [
      {
        kind: "tone",
        wave: "pulse",
        duty: 0.22,
        notes: [79, 84],
        step: 40,
        gain: 0.092,
        attack: 2,
        release: 44,
        sustain: 0.5,
        cutoff: 6500,
      },
    ],
  },
];

/** Total milliseconds an effect occupies, release included. */
function spanMs(spec: SfxSpec): number {
  let end = 0;
  for (const p of spec.parts) {
    const delay = p.delay ?? 0;
    const gate = p.kind === "tone" ? p.notes.length * p.step : p.ms;
    const rel = p.release ?? 40;
    const t = delay + gate + rel;
    if (t > end) end = t;
  }
  return end;
}

/**
 * The bank's shape, published so a test can assert on it without an
 * `AudioContext`.
 *
 * Every claim the header makes about the three constant effects is checkable
 * from this: their peak gain, their length, and the channel each one claims.
 */
export const BANK_INFO: readonly {
  readonly id: number;
  readonly ch: number;
  readonly ms: number;
  readonly peak: number;
  readonly waves: readonly string[];
}[] = Object.freeze(
  BANK.map((spec, id) => {
    let peak = 0;
    const waves: string[] = [];
    for (const p of spec.parts) {
      peak += p.gain;
      waves.push(p.kind === "noise" ? "noise" : p.wave);
    }
    return Object.freeze({ id, ch: spec.ch, ms: spanMs(spec), peak, waves: Object.freeze(waves) });
  }),
);

// ===========================================================================
// The WebAudio backend
// ===========================================================================

export type PrimeAudioState = "stopped" | "starting" | "suspended" | "running";

export interface PrimeAudio extends Snd {
  /**
   * Bring the mixer up. MUST be called from a user gesture: it resolves only
   * when the context is genuinely running, and rejects -- leaving `state` at
   * "suspended" -- when the browser is holding it back.
   */
  start(): Promise<void>;
  stop(): void;
  /** The honest state, "suspended" included. */
  readonly state: PrimeAudioState;
  readonly running: boolean;
  /** Silences the output without stopping the context or the simulation. */
  muted: boolean;
}

/** Master level. Leaves room for the busiest frame the game can produce. */
const MASTER_GAIN = 0.9;

/** Milliseconds an interrupted voice gets to fade. Long enough not to click. */
const STEAL_MS = 8;

/** How far ahead of `currentTime` a voice is scheduled, in seconds. */
const LOOKAHEAD = 0.004;

type Ctor = new (options?: AudioContextOptions) => AudioContext;

function audioContextCtor(): Ctor | null {
  const g = globalThis as unknown as Record<string, unknown>;
  for (const n of ["AudioContext", "webkitAudioContext"]) {
    const c = g[n];
    if (typeof c === "function") return c as Ctor;
  }
  return null;
}

/** True when this environment could make a sound at all. */
export function audioAvailable(): boolean {
  return audioContextCtor() !== null;
}

/**
 * The real mixer.
 *
 * Nothing is constructed until {@link PrimeAudio.start}: importing this module
 * in a test, or on a page that never gets a gesture, allocates no context and
 * makes no noise. Until then `play` is a no-op, deliberately WITHOUT a queue --
 * a sound held over from before the mixer existed would arrive attached to an
 * event that is already several seconds in the past, which is worse than
 * silence.
 */
export function createPrimeAudio(opts?: {
  master?: number;
  /**
   * A context to build into instead of creating one.
   *
   * Give it an `OfflineAudioContext` and the bank becomes MEASURABLE: play the
   * effects, render, and read the samples back. That is how
   * `modules/redsound/README.md` can state a peak and a duration for every
   * effect instead of asserting one, and nobody who works on this can hear it
   * either -- so the ability to measure it is not a convenience.
   *
   * A supplied context is the caller's: it is treated as already running, so
   * there is no gesture to wait for (nothing is connected to a speaker), and
   * `stop()` does not close it.
   */
  context?: BaseAudioContext;
}): PrimeAudio {
  const master = opts?.master !== undefined && opts.master >= 0 ? opts.master : MASTER_GAIN;
  const borrowed = opts?.context ?? null;

  /** Whatever we are building into: ours, or the caller's. */
  let ctx: BaseAudioContext | null = null;
  /** The one WE made, and therefore the only one we may resume or close. */
  let owned: AudioContext | null = null;
  let out: GainNode | null = null;
  let phase: PrimeAudioState = "stopped";
  let starting: Promise<void> | null = null;
  let mute = false;

  /** One noise buffer for the whole session. Deterministic, because it can be. */
  let noiseBuf: AudioBuffer | null = null;
  /** Pulse waves are expensive to build and there are three duties in the bank. */
  const waves = new Map<number, PeriodicWave>();
  /** What is sounding on each channel, so a new effect can take it. */
  const busy = new Map<number, { gain: GainNode; stop: (t: number) => void }>();

  function noise(c: BaseAudioContext): AudioBuffer {
    if (noiseBuf !== null) return noiseBuf;
    const n = Math.floor(c.sampleRate * 1.2);
    const buf = c.createBuffer(1, n, c.sampleRate);
    const d = buf.getChannelData(0);
    // A fixed sequence rather than Math.random: the noise is then the same on
    // every run, which costs nothing and makes a recording reproducible.
    let s = 0x2f6e2b1 >>> 0;
    for (let i = 0; i < n; i++) {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      d[i] = (s / 2147483648 - 1) * 0.85;
    }
    noiseBuf = buf;
    return buf;
  }

  /**
   * A pulse wave of the given duty, from its Fourier series.
   *
   * `OscillatorNode` has square and sawtooth and nothing between them, and the
   * difference between a 22% pulse and a 50% one is most of what separates the
   * block hit from the paddle hit. Thirty-two partials is past where the
   * difference stops being audible at these pitches.
   */
  function pulse(c: BaseAudioContext, duty: number): PeriodicWave {
    const key = Math.round(duty * 1000);
    const cached = waves.get(key);
    if (cached !== undefined) return cached;
    const N = 32;
    const real = new Float32Array(N + 1);
    const imag = new Float32Array(N + 1);
    for (let n = 1; n <= N; n++) {
      real[n] = (2 / (n * Math.PI)) * Math.sin(n * Math.PI * duty);
    }
    const w = c.createPeriodicWave(real, imag, { disableNormalization: false });
    waves.set(key, w);
    return w;
  }

  /** The gain envelope every part shares: attack, gate, release. */
  function envelope(
    g: AudioParam,
    t0: number,
    peak: number,
    attackMs: number,
    gateMs: number,
    sustain: number,
    releaseMs: number,
  ): number {
    const atk = Math.max(0.001, attackMs / 1000);
    const gate = Math.max(atk, gateMs / 1000);
    const rel = Math.max(0.004, releaseMs / 1000);
    g.setValueAtTime(0, t0);
    g.linearRampToValueAtTime(peak, t0 + atk);
    g.linearRampToValueAtTime(peak * sustain, t0 + gate);
    g.linearRampToValueAtTime(0, t0 + gate + rel);
    return t0 + gate + rel;
  }

  /**
   * Build one part, file its sources in `live` so a steal can stop them, and
   * return the time it finishes.
   */
  function buildPart(
    c: BaseAudioContext,
    dest: AudioNode,
    p: PartSpec,
    at: number,
    pitch: number,
    live: AudioScheduledSourceNode[],
  ): number {
    const t0 = at + (p.delay ?? 0) / 1000;
    const amp = c.createGain();
    amp.gain.value = 0;

    let tail: AudioNode = amp;

    // Tremolo, which exists for exactly one effect and is what makes the alarm
    // throb rather than merely sound.
    let lfo: OscillatorNode | null = null;
    if (p.kind === "tone" && p.trem !== undefined && p.trem > 0) {
      const depth = p.tremDepth ?? 0.3;
      const tg = c.createGain();
      tg.gain.value = 1 - depth;
      const l = c.createOscillator();
      l.type = "sine";
      l.frequency.value = p.trem;
      const ld = c.createGain();
      ld.gain.value = depth;
      l.connect(ld).connect(tg.gain);
      amp.connect(tg);
      tail = tg;
      lfo = l;
    }

    let filter: BiquadFilterNode | null = null;
    if (p.kind === "noise") {
      filter = c.createBiquadFilter();
      filter.type = p.filter;
      filter.Q.value = p.q ?? 1;
      filter.frequency.setValueAtTime(p.from, t0);
      filter.frequency.exponentialRampToValueAtTime(Math.max(30, p.to), t0 + p.ms / 1000);
    } else if (p.cutoff !== undefined && p.cutoff > 0) {
      filter = c.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.value = p.cutoff;
      filter.Q.value = p.q ?? 0.7;
    }

    let src: AudioScheduledSourceNode;
    let end: number;

    if (p.kind === "noise") {
      const s = c.createBufferSource();
      s.buffer = noise(c);
      s.loop = true;
      src = s;
      end = envelope(amp.gain, t0, p.gain, p.attack ?? 2, p.ms, p.sustain ?? 0.3, p.release ?? 60);
    } else {
      const o = c.createOscillator();
      if (p.wave === "pulse") o.setPeriodicWave(pulse(c, p.duty ?? 0.5));
      else o.type = p.wave;
      if (p.detune !== undefined) o.detune.value = p.detune;
      const stepS = p.step / 1000;
      for (let i = 0; i < p.notes.length; i++) {
        const hz = noteHz(p.notes[i] as number) * pitch;
        const t = t0 + i * stepS;
        if (p.glide === true && i > 0) o.frequency.exponentialRampToValueAtTime(hz, t);
        else o.frequency.setValueAtTime(hz, t);
      }
      src = o;
      end = envelope(
        amp.gain,
        t0,
        p.gain,
        p.attack ?? 1,
        p.notes.length * p.step,
        p.sustain ?? 0.35,
        p.release ?? 40,
      );
    }

    if (filter !== null) src.connect(filter).connect(amp);
    else src.connect(amp);
    tail.connect(dest);

    src.start(t0);
    src.stop(end + 0.02);
    live.push(src);
    if (lfo !== null) {
      lfo.start(t0);
      lfo.stop(end + 0.02);
      live.push(lfo);
    }
    return end;
  }

  /** Fade whatever owns this channel and let the new effect have it. */
  function steal(ch: number, at: number): void {
    const held = busy.get(ch);
    if (held === undefined) return;
    busy.delete(ch);
    const fade = STEAL_MS / 1000;
    try {
      held.gain.gain.cancelScheduledValues(at);
      held.gain.gain.setValueAtTime(held.gain.gain.value, at);
      held.gain.gain.linearRampToValueAtTime(0, at + fade);
    } catch {
      // A node whose context went away. There is nothing to fade.
    }
    held.stop(at + fade + 0.01);
  }

  /**
   * The master chain: one gain, one limiter, the destination.
   *
   * A LIMITER, NOT A COMPRESSOR. Everything in the bank is short and transient
   * and the only job is that four effects landing on one frame cannot reach the
   * rail; the threshold is high enough that ordinary play never touches it, so
   * nothing is pumping the mix to pay for a case that does not happen.
   */
  function mount(c: BaseAudioContext): GainNode {
    const g = c.createGain();
    g.gain.value = mute ? 0 : master;
    const lim = c.createDynamicsCompressor();
    lim.threshold.value = -3;
    lim.knee.value = 0;
    lim.ratio.value = 20;
    lim.attack.value = 0.003;
    lim.release.value = 0.18;
    g.connect(lim).connect(c.destination);
    return g;
  }

  function teardown(): void {
    busy.clear();
    // A borrowed context is the caller's: its nodes, its lifetime, its close.
    if (borrowed !== null) return;
    noiseBuf = null;
    waves.clear();
    out = null;
    ctx = null;
    if (owned !== null) {
      const c = owned;
      owned = null;
      void c.close().catch(() => {});
    }
  }

  async function begin(): Promise<void> {
    if (borrowed !== null) {
      // Nothing to wait for: a context handed in is already whatever it is, and
      // an offline one has no speaker and therefore no autoplay policy.
      if (out === null) {
        ctx = borrowed;
        out = mount(borrowed);
      }
      phase = "running";
      return;
    }
    const Ctx = audioContextCtor();
    if (Ctx === null) {
      phase = "stopped";
      throw new Error("prime audio: this environment has no AudioContext");
    }
    try {
      if (owned === null) {
        const c = new Ctx();
        out = mount(c);
        owned = c;
        ctx = c;
      }
      await owned.resume();
    } catch (e) {
      teardown();
      phase = "stopped";
      throw e;
    }
    if (owned.state !== "running") {
      // Autoplay policy. Keep the context and the graph: a later start() from a
      // real gesture is then one resume() away.
      phase = "suspended";
      throw new Error(
        "prime audio: the AudioContext is suspended. start() must be called from a user gesture.",
      );
    }
    phase = "running";
  }

  return {
    start(): Promise<void> {
      if (phase === "running") return Promise.resolve();
      if (starting !== null) return starting;
      phase = "starting";
      const p = begin().finally(() => {
        starting = null;
      });
      starting = p;
      return p;
    },

    stop(): void {
      teardown();
      phase = "stopped";
    },

    play(id: number, o?: SndOpts): void {
      const c = ctx;
      const dest = out;
      if (c === null || dest === null || phase !== "running") return;
      const spec = BANK[id | 0];
      if (spec === undefined) return;
      const at = c.currentTime + LOOKAHEAD;
      steal(spec.ch, at);

      const voice = c.createGain();
      voice.gain.value = o?.gain !== undefined && o.gain >= 0 ? o.gain : 1;

      let node: AudioNode = voice;
      const pan = o?.pan;
      if (pan !== undefined && typeof c.createStereoPanner === "function") {
        const sp = c.createStereoPanner();
        sp.pan.value = pan < -1 ? -1 : pan > 1 ? 1 : pan;
        voice.connect(sp);
        node = sp;
      }
      node.connect(dest);

      const pitch = o?.pitch !== undefined && o.pitch > 0 ? o.pitch : 1;
      let end = at;
      const live: AudioScheduledSourceNode[] = [];
      for (const part of spec.parts) {
        const t = buildPart(c, voice, part, at, pitch, live);
        if (t > end) end = t;
      }

      const entry = {
        gain: voice,
        stop: (t: number): void => {
          for (const s of live) {
            try {
              s.stop(t);
            } catch {
              // Already stopped, or its context closed. Either way it is quiet.
            }
          }
        },
      };
      busy.set(spec.ch, entry);
      // Let go of the channel when the effect finishes on its own, so a later
      // effect on the same channel does not fade a voice that is already gone.
      globalThis.setTimeout(
        () => {
          if (busy.get(spec.ch) === entry) busy.delete(spec.ch);
          try {
            voice.disconnect();
          } catch {
            // The context closed underneath it.
          }
        },
        Math.max(0, (end - c.currentTime) * 1000 + 60),
      );
    },

    /**
     * Prime ships no music bank in this slice.
     *
     * The method exists because the ABI has it and a cart may call it; it is a
     * no-op rather than a stub that logs, because the honest statement is "this
     * console has no music yet", and `modules/redsound`'s three bands are
     * written for a four-channel chip rather than for this synthesiser. The
     * recording backend still records the call, so a cart that starts music can
     * be tested before there is anything to hear.
     */
    music(): void {},
    stopMusic(): void {},

    get state(): PrimeAudioState {
      return phase;
    },

    get running(): boolean {
      return phase === "running";
    },

    get muted(): boolean {
      return mute;
    },

    set muted(v: boolean) {
      mute = v;
      if (out !== null && ctx !== null) {
        const t = ctx.currentTime;
        out.gain.cancelScheduledValues(t);
        out.gain.setValueAtTime(out.gain.value, t);
        out.gain.linearRampToValueAtTime(v ? 0 : master, t + 0.02);
      }
    },
  };
}
