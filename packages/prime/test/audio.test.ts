/**
 * The bank, the recording backend, and the autoplay contract.
 *
 * NOBODY WHO WROTE THIS COULD HEAR IT, AND NEITHER CAN THIS FILE. So it tests
 * the two things a test can honestly hold an opinion about: the SHAPE of the
 * bank -- which effect is louder than which, which is shorter, which claims
 * which channel, which waveform carries which -- and the BEHAVIOUR of the
 * backends around it. Whether the alarm is alarming is a question for ears, and
 * the handoff that ships this says what they heard.
 *
 * The numbers asserted below are the ones `modules/redsound/README.md` measured
 * on the small console. They are the brief, not the implementation: this
 * synthesiser is not a four-channel chip and does not pretend to be one, but a
 * port in which the wall bounce is louder than the alarm is a port that lost the
 * game, and that is a thing a test CAN catch.
 */

import { describe, expect, it } from "vitest";

import {
  BANK_INFO,
  SFX,
  SFX_COUNT,
  audioAvailable,
  createPrimeAudio,
  createRecordingSnd,
  noteHz,
} from "../src/audio";
import { createMachine, emptyInput, nullSnd } from "../src/sim";
import type { PrimeCart } from "../src/sim";

/** The three that fire constantly, and are what ninety seconds is made of. */
const CONSTANT: readonly number[] = [SFX.HIT, SFX.PADDLE, SFX.WALL];

describe("the bank's numbering", () => {
  it("is the seventeen effects the format fixes, without a gap or a repeat", () => {
    const ids = Object.values(SFX);
    expect(ids.length).toBe(SFX_COUNT);
    expect([...ids].sort((a, b) => a - b)).toEqual(
      Array.from({ length: SFX_COUNT }, (_, i) => i),
    );
    expect(BANK_INFO.length).toBe(SFX_COUNT);
    for (let i = 0; i < SFX_COUNT; i++) expect(BANK_INFO[i]?.id).toBe(i);
  });

  it("puts every effect on a channel in 0..3", () => {
    for (const e of BANK_INFO) {
      expect(e.ch).toBeGreaterThanOrEqual(0);
      expect(e.ch).toBeLessThanOrEqual(3);
    }
  });

  it("shares one channel between the alarm, the deflection and the losses", () => {
    // This is a MECHANIC. The deflection cutting the alarm off mid-warble is the
    // sound of relief interrupting the sound of danger, and it only happens
    // because they are on the same channel. So is "life lost" being heard on
    // every life except the last, when game over takes the channel from it.
    const ch = BANK_INFO[SFX.RED]?.ch;
    expect(ch).toBe(3);
    for (const id of [SFX.DEFLECT, SFX.SMASH, SFX.LOSE, SFX.CLEAR, SFX.OVER]) {
      expect(BANK_INFO[id]?.ch).toBe(ch);
    }
  });
});

describe("rule one: the three that fire constantly", () => {
  it("makes them the quietest things in the bank", () => {
    const loudestConstant = Math.max(...CONSTANT.map((i) => BANK_INFO[i]?.peak ?? 0));
    const others = BANK_INFO.filter((e) => !CONSTANT.includes(e.id));
    const quietestOther = Math.min(...others.map((e) => e.peak));
    expect(loudestConstant).toBeLessThan(quietestOther);
  });

  it("makes them the shortest things in the bank", () => {
    const longestConstant = Math.max(...CONSTANT.map((i) => BANK_INFO[i]?.ms ?? 0));
    const others = BANK_INFO.filter((e) => !CONSTANT.includes(e.id));
    expect(longestConstant).toBeLessThanOrEqual(Math.min(...others.map((e) => e.ms)));
    // And short in absolute terms: a fifth of a second of blip, sixty times a
    // minute, is the difference between texture and tinnitus.
    expect(longestConstant).toBeLessThan(120);
  });

  it("separates them on register, timbre and direction at once", () => {
    // Three blips differing only in volume are one blip. A player has to hear
    // WHICH of the three fired without looking, so no two of them agree on more
    // than one axis.
    const block = BANK_INFO[SFX.HIT];
    const paddle = BANK_INFO[SFX.PADDLE];
    const wall = BANK_INFO[SFX.WALL];
    // Timbre: the wall is the only one that is not a pulse.
    expect(block?.waves).toEqual(["pulse"]);
    expect(paddle?.waves).toEqual(["pulse"]);
    expect(wall?.waves).toEqual(["triangle"]);
    // Register: the block is highest, the paddle an octave below it, the wall
    // between them -- and direction: the wall is the one that falls.
    const first = (id: number): number => noteHz(BANK_NOTES[id]?.[0] ?? 0);
    const last = (id: number): number => {
      const ns = BANK_NOTES[id] ?? [];
      return noteHz(ns[ns.length - 1] ?? 0);
    };
    expect(first(SFX.HIT)).toBeGreaterThan(first(SFX.WALL));
    expect(first(SFX.WALL)).toBeGreaterThan(first(SFX.PADDLE));
    expect(last(SFX.HIT)).toBeGreaterThan(first(SFX.HIT));
    expect(last(SFX.PADDLE)).toBeGreaterThan(first(SFX.PADDLE));
    expect(last(SFX.WALL)).toBeLessThan(first(SFX.WALL));
  });
});

describe("rule two: the alarm is unlike everything else", () => {
  it("is the loudest thing in the bank", () => {
    const alarm = BANK_INFO[SFX.RED]?.peak ?? 0;
    for (const e of BANK_INFO) {
      if (e.id !== SFX.RED) expect(e.peak).toBeLessThan(alarm);
    }
  });

  it("is the only saw, effects and all", () => {
    for (const e of BANK_INFO) {
      const saws = e.waves.filter((w) => w === "sawtooth").length;
      if (e.id === SFX.RED) expect(saws).toBeGreaterThan(0);
      else if (e.id !== SFX.SMASH) expect(saws).toBe(0);
    }
    // The paddle's destruction is the one other place a saw appears, buried
    // under noise two octaves lower -- it is the body of a collapse, not a
    // pitched voice, and it shares no register with the alarm at all.
    expect(Math.max(...(BANK_NOTES[SFX.SMASH] ?? [0]))).toBeLessThan(
      Math.min(...(BANK_NOTES[SFX.RED] ?? [0])),
    );
  });

  it("oscillates around a centre that does not move, rather than climbing", () => {
    const notes = BANK_NOTES[SFX.RED] ?? [];
    expect(notes.length).toBe(24);

    // The mean pitch of the first half and of the last half are the SAME note:
    // F#6. That is why it correlates with nothing that rises and nothing that
    // falls -- the pair widens instead of moving.
    const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
    const firstHalf = mean(notes.slice(0, 12));
    const lastHalf = mean(notes.slice(12));
    expect(firstHalf).toBeCloseTo(78, 6);
    expect(lastHalf).toBeCloseTo(78, 6);

    // It turns round on nearly every step. Nothing else in the bank turns more
    // than twice.
    expect(turns(notes)).toBeGreaterThan(20);
    for (const e of BANK_INFO) {
      if (e.id !== SFX.RED) expect(turns(BANK_NOTES[e.id] ?? [])).toBeLessThanOrEqual(2);
    }
  });

  it("keeps its whole range above B5, where nothing else in the game lives", () => {
    const notes = BANK_NOTES[SFX.RED] ?? [];
    expect(Math.min(...notes)).toBeGreaterThanOrEqual(71);
    expect(Math.max(...notes)).toBeLessThanOrEqual(85);
  });

  it("gives the player about a second to react", () => {
    const ms = BANK_INFO[SFX.RED]?.ms ?? 0;
    expect(ms).toBeGreaterThan(700);
    expect(ms).toBeLessThan(1100);
  });
});

describe("the deflection lands and the smash does not", () => {
  it("holds the deflection's last note while the smash is still falling", () => {
    // The two cues that must never be confused, and the shape metric cannot
    // tell them apart: both are long downward glides. What separates them is
    // that EFFECT 11 LANDS -- it stops on A2 and holds it for the last quarter
    // of its length -- while effect 12 is still descending on its final step.
    const deflect = BANK_NOTES[SFX.DEFLECT] ?? [];
    const tail = deflect.slice(-4);
    expect(new Set(tail).size).toBe(1);
    expect(tail[0]).toBe(33); // A2, the root the whole game sits on

    const smash = BANK_NOTES[SFX.SMASH] ?? [];
    expect(smash[smash.length - 1]).toBeLessThan(smash[smash.length - 2] as number);
    // And the smash is the longer of the two, as the worst thing that can
    // happen should be.
    expect(BANK_INFO[SFX.SMASH]?.ms ?? 0).toBeGreaterThan(BANK_INFO[SFX.DEFLECT]?.ms ?? 0);
  });

  it("makes the paddle's destruction the biggest thing in the bank after the alarm", () => {
    const smash = BANK_INFO[SFX.SMASH]?.peak ?? 0;
    for (const e of BANK_INFO) {
      if (e.id !== SFX.SMASH && e.id !== SFX.RED) expect(e.peak).toBeLessThan(smash);
    }
  });
});

describe("noteHz", () => {
  it("agrees with the numbering the measurements use: 60 is C5", () => {
    expect(noteHz(60)).toBeCloseTo(523.2511, 3);
    expect(noteHz(72)).toBeCloseTo(1046.5023, 3);
    expect(noteHz(33)).toBeCloseTo(110, 6); // A2
    // A4 is 57 in this numbering, NOT 69: the table counts semitones from C0,
    // so it sits twelve below the MIDI number for the same note. Getting that
    // wrong transposes the whole bank an octave and nothing else complains.
    expect(noteHz(57)).toBeCloseTo(440, 6);
    expect(noteHz(69)).toBeCloseTo(880, 6); // A5, the music's ceiling
  });

  it("takes a fractional note, because the alarm's pair widens by half steps", () => {
    expect(noteHz(78.5)).toBeGreaterThan(noteHz(78));
    expect(noteHz(78.5)).toBeLessThan(noteHz(79));
  });
});

describe("the recording backend", () => {
  it("records what was played, in order, with the tick that played it", () => {
    const seen: number[] = [];
    let m: ReturnType<typeof createMachine> | undefined;
    const snd = createRecordingSnd(() => m?.tick ?? -1n);
    const cart: PrimeCart = {
      boot: (_s, s2) => s2.play(SFX.CLEAR),
      tick(sim, _i, s2) {
        if (sim.tick % 2n === 0n) s2.play(SFX.HIT, { gain: 0.5 });
        seen.push(Number(sim.tick));
      },
      render: () => {},
    };
    m = createMachine(cart, snd);
    m.boot(1n);
    for (let i = 0; i < 4; i++) m.step(emptyInput());

    expect(seen).toEqual([0, 1, 2, 3]);
    expect(snd.ids).toEqual([SFX.CLEAR, SFX.HIT, SFX.HIT]);
    expect(snd.calls.map((c) => c.tick)).toEqual([0n, 0n, 2n]);
    expect(snd.calls[1]?.opts).toEqual({ gain: 0.5 });
    expect(snd.played(SFX.HIT)).toBe(true);
    expect(snd.played(SFX.SMASH)).toBe(false);

    snd.clear();
    expect(snd.calls).toEqual([]);
    expect(snd.played(SFX.HIT)).toBe(false);
  });

  it("records music calls apart from effects", () => {
    const snd = createRecordingSnd();
    snd.music(2, 30);
    snd.play(1);
    snd.stopMusic();
    expect(snd.ids).toEqual([1]);
    expect(snd.calls.map((c) => c.kind)).toEqual(["music", "play", "stopMusic"]);
    // No clock, so no lie about one.
    expect(snd.calls.every((c) => c.tick === -1n)).toBe(true);
  });

  it("works without a clock, which is what a machine-less unit test has", () => {
    const snd = createRecordingSnd(() => {
      throw new Error("no machine yet");
    });
    expect(() => snd.play(SFX.WALL)).not.toThrow();
    expect(snd.calls[0]?.tick).toBe(-1n);
  });
});

describe("the null backend", () => {
  it("accepts every call and does nothing, so a headless run needs no mixer", () => {
    const s = nullSnd();
    expect(() => {
      s.play(SFX.RED);
      s.play(SFX.RED, { gain: 2, pitch: 0.5, pan: -1 });
      s.music(0, 30);
      s.stopMusic(30);
    }).not.toThrow();
    // Frozen, like everything else a cart can reach: a backend a cart could
    // hang a property off is a place to remember something outside the arena.
    expect(Object.isFrozen(s)).toBe(true);
  });
});

describe("the WebAudio backend, where there is no WebAudio", () => {
  it("says so rather than pretending", () => {
    // Node has no AudioContext. This is the environment a headless conformance
    // run lives in, and the honest behaviour there is a mixer that refuses to
    // start and never claims to be running.
    expect(audioAvailable()).toBe(false);

    const a = createPrimeAudio();
    expect(a.state).toBe("stopped");
    expect(a.running).toBe(false);
  });

  it("is safe to call from a cart before -- and instead of -- starting", () => {
    const a = createPrimeAudio();
    expect(() => {
      a.play(SFX.RED);
      a.play(SFX.HIT, { gain: 0.5, pitch: 1.2, pan: 0.5 });
      a.music(0);
      a.stopMusic();
      a.muted = true;
      a.stop();
    }).not.toThrow();
    expect(a.muted).toBe(true);
  });

  it("rejects start() and stays honest about being stopped", async () => {
    const a = createPrimeAudio();
    await expect(a.start()).rejects.toThrow(/AudioContext/);
    expect(a.running).toBe(false);
    expect(a.state).toBe("stopped");
  });

  it("drives a real machine to silence without the cart knowing", () => {
    // The property that matters for the shipped player: the same cart, the same
    // seed and the same inputs produce the same arena whether the mixer exists
    // or not.
    const cart: PrimeCart = {
      boot: (sim) => sim.mem.setFloat64(0, 1, true),
      tick: (sim, _i, snd) => {
        snd.play(SFX.HIT);
        sim.mem.setFloat64(0, sim.mem.getFloat64(0, true) + sim.rndf(), true);
      },
      render: () => {},
    };
    const run = (snd: Parameters<typeof createMachine>[1]): Uint8Array => {
      const m = createMachine(cart, snd);
      m.boot(5n);
      for (let i = 0; i < 50; i++) m.step(emptyInput());
      return m.snapshot();
    };
    expect(run(createPrimeAudio())).toEqual(run(undefined));
  });
});

// ---------------------------------------------------------------------------
// The note lists, transcribed from the bank so the assertions above can read
// them. Kept HERE rather than exported from `audio.ts`: they are the bank's
// internals, and a test that copies them is a test that notices when they move.
// ---------------------------------------------------------------------------

const BANK_NOTES: Readonly<Record<number, number[]>> = {
  [SFX.HIT]: [72, 74],
  [SFX.BREAK]: [76, 69, 64, 58, 54],
  [SFX.PADDLE]: [60, 62],
  [SFX.WALL]: [67, 66],
  [SFX.SPAWN]: [69, 72, 76],
  [SFX.DROP]: [72, 76, 79, 84],
  [SFX.LIFE]: [60, 64, 67, 72, 76, 79, 84, 84, 84, 72, 79, 84, 84, 84, 84, 84, 84, 84],
  [SFX.SHOOT]: [88, 82, 74, 67],
  [SFX.PING]: [91, 89],
  [SFX.SHIELD]: [84, 70, 58, 52],
  [SFX.RED]: [
    76.5, 79.5, 76.5, 79.5, 75, 81, 75, 81, 74, 82, 74, 82, 73, 83, 73, 83, 72, 84, 72, 84, 71, 85,
    71, 85,
  ],
  [SFX.DEFLECT]: [84, 78, 72, 66, 60, 54, 48, 43, 38, 33, 33, 33, 33, 33],
  [SFX.SMASH]: [60, 50, 42, 36, 30, 24],
  [SFX.LOSE]: [67, 62, 55],
  [SFX.CLEAR]: [60, 64, 67, 72, 76, 79, 84, 84, 84, 84, 84, 84],
  [SFX.OVER]: [60, 58, 55, 53, 51, 48, 48, 48],
  [SFX.CHARGE]: [79, 84],
};

/** How many times a note list changes direction. The alarm's identity. */
function turns(notes: readonly number[]): number {
  let n = 0;
  let dir = 0;
  for (let i = 1; i < notes.length; i++) {
    const d = Math.sign((notes[i] as number) - (notes[i - 1] as number));
    if (d === 0) continue;
    if (dir !== 0 && d !== dir) n++;
    dir = d;
  }
  return n;
}
