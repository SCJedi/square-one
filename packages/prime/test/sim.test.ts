import { afterEach, describe, expect, it } from "vitest";

import { ARENA_BYTES } from "../src/arena";
import {
  ARENA_HEADER,
  BUTTON,
  CART_BYTES,
  MAX_PLAYERS,
  createMachine,
  devChecksEnabled,
  emptyInput,
  nullSnd,
  setDevChecks,
} from "../src/sim";
import type { Draw, InputFrame, PrimeCart, Sim, SimRead, Snd } from "../src/sim";

/** A Draw that records nothing. `render` is non-normative; the calls do not matter. */
const NO_DRAW: Draw = {
  clear: () => {},
  rect: () => {},
  roundRect: () => {},
  circle: () => {},
  line: () => {},
  tri: () => {},
  text: () => {},
  measure: () => 0,
  push: () => {},
  pop: () => {},
  translate: () => {},
  rotate: () => {},
  scale: () => {},
  blend: () => {},
  layer: () => {},
  bloom: () => {},
  shake: () => {},
};

function cartOf(p: Partial<PrimeCart>): PrimeCart {
  return {
    boot: p.boot ?? ((): void => {}),
    tick: p.tick ?? ((): void => {}),
    render: p.render ?? ((): void => {}),
  };
}

type MutableInput = {
  buttons: Uint16Array;
  axes: Int16Array;
  triggers: Uint8Array;
  present: number;
};

function inputWith(mutate: (f: MutableInput) => void): InputFrame {
  const f = {
    buttons: new Uint16Array(MAX_PLAYERS),
    axes: new Int16Array(MAX_PLAYERS * 4),
    triggers: new Uint8Array(MAX_PLAYERS * 2),
    present: 0,
  };
  mutate(f);
  return f;
}

afterEach(() => {
  setDevChecks(true);
});

// ---------------------------------------------------------------------------

describe("boot and the clock", () => {
  it("zeroes the arena and installs a generator before the cart runs", () => {
    let sawTick = -1n;
    let rngWasSeeded = false;
    const m = createMachine(
      cartOf({
        boot(sim) {
          sawTick = sim.tick;
          // The generator lives in the arena header, which `sim.mem` cannot see.
          let any = 0;
          for (let i = 8; i < 40; i++) any |= m.arena.bytes[i] as number;
          rngWasSeeded = any !== 0;
        },
      }),
    );
    m.boot(1n);
    expect(sawTick).toBe(0n);
    expect(rngWasSeeded).toBe(true);
  });

  it("shows a cart the index of the tick it is in, and counts after it", () => {
    const seen: bigint[] = [];
    const m = createMachine(cartOf({ tick: (sim) => void seen.push(sim.tick) }));
    m.boot(1n);
    expect(m.tick).toBe(0n);
    const input = emptyInput();
    for (let i = 0; i < 5; i++) m.step(input);
    expect(seen).toEqual([0n, 1n, 2n, 3n, 4n]);
    expect(m.tick).toBe(5n);
  });

  it("keeps the clock a u64, past where a double stops counting", () => {
    const m = createMachine(cartOf({}));
    m.boot(1n);
    // Poke the counter to 2^53, the last integer a double represents exactly,
    // and step. A number-typed clock would stop advancing here.
    m.arena.view.setBigUint64(0, 9007199254740992n, true);
    m.step(emptyInput());
    expect(m.tick).toBe(9007199254740993n);
  });

  it("reboots to the same state it first booted to", () => {
    const m = createMachine(
      cartOf({
        boot: (sim) => sim.mem.setUint32(0, 0xcafe, true),
        tick: (sim) => sim.mem.setUint32(4, sim.rnd(1000), true),
      }),
    );
    m.boot(7n);
    for (let i = 0; i < 10; i++) m.step(emptyInput());
    const first = m.snapshot();
    m.boot(7n);
    for (let i = 0; i < 10; i++) m.step(emptyInput());
    expect(m.snapshot()).toEqual(first);
  });
});

describe("the cart's window on the arena", () => {
  it("starts past the machine header, so a cart cannot rewind its own clock", () => {
    const m = createMachine(cartOf({}));
    m.boot(1n);
    for (let i = 0; i < 3; i++) m.step(emptyInput());

    let mem: DataView | undefined;
    createMachine(cartOf({}));
    const m2 = createMachine(cartOf({ tick: (sim) => void (mem = sim.mem) }));
    m2.boot(1n);
    m2.step(emptyInput());
    expect(mem?.byteOffset).toBe(ARENA_HEADER);
    expect(mem?.byteLength).toBe(CART_BYTES);
    expect(ARENA_HEADER + CART_BYTES).toBe(ARENA_BYTES);

    // Writing the first byte the cart CAN reach leaves the counter alone.
    mem?.setUint8(0, 0xff);
    expect(m2.tick).toBe(1n);
  });
});

describe("state containment", () => {
  it("freezes the sim object", () => {
    let frozen = false;
    const m = createMachine(cartOf({ tick: (sim) => void (frozen = Object.isFrozen(sim)) }));
    m.boot(1n);
    m.step(emptyInput());
    expect(frozen).toBe(true);
  });

  it("closes EVERY object on the sim, including ones added later", () => {
    // The list has to grow with the ABI, and a test naming members one at a time
    // is a test that quietly stops covering the newest one. So this enumerates.
    //
    // The property asserted is NON-EXTENSIBILITY, not frozenness. `mem` must stay
    // writable -- writing it is the point -- but a cart must not be able to hang
    // a property off it, because that property would survive a rewind and be in
    // no snapshot. Frozen implies non-extensible, so this covers both cases.
    const names: string[] = [];
    const open: string[] = [];
    const m = createMachine(
      cartOf({
        tick(sim) {
          for (const k of Object.getOwnPropertyNames(sim)) {
            names.push(k);
            const v = (sim as unknown as Record<string, unknown>)[k];
            if (typeof v === "object" && v !== null && Object.isExtensible(v)) open.push(k);
          }
        },
      }),
    );
    m.boot(1n);
    m.step(emptyInput());
    expect(open).toEqual([]);
    expect(names.sort()).toEqual(["atan2", "cos", "mem", "rnd", "rndf", "sin", "sqrt", "tick"]);
  });

  it("does not let a cart hang a property off mem or off an input array", () => {
    const observed: Record<string, unknown> = {};
    const m = createMachine(
      cartOf({
        tick(sim, input) {
          const spots: [string, object][] = [
            ["mem", sim.mem],
            ["buttons", input.buttons],
            ["axes", input.axes],
            ["triggers", input.triggers],
            ["input", input],
          ];
          for (const [name, obj] of spots) {
            try {
              (obj as unknown as Record<string, unknown>)["smuggled"] = 1;
            } catch {
              /* strict-mode TypeError is the preferred outcome */
            }
            observed[name] = (obj as unknown as Record<string, unknown>)["smuggled"];
          }
        },
      }),
    );
    m.boot(1n);
    m.step(emptyInput());
    m.step(emptyInput());
    expect(observed).toEqual({
      mem: undefined,
      buttons: undefined,
      axes: undefined,
      triggers: undefined,
      input: undefined,
    });
  });

  it("does not let a cart park a property that survives a tick", () => {
    // The small console shipped this unfrozen once: `sys.carry = 1` persisted
    // across ticks and survived restore(). A cart must not be able to REMEMBER
    // anything outside the buffer.
    let observed: unknown = "never ran";
    const m = createMachine(
      cartOf({
        tick(sim) {
          const loose = sim as unknown as Record<string, unknown>;
          try {
            loose["carry"] = ((loose["carry"] as number) ?? 0) + 1;
          } catch {
            /* strict-mode TypeError is the preferred outcome */
          }
          observed = loose["carry"];
        },
      }),
    );
    m.boot(1n);
    m.step(emptyInput());
    m.step(emptyInput());
    expect(observed).toBeUndefined();
  });

  it("keeps mem writable -- the freeze is shallow by intent", () => {
    const m = createMachine(cartOf({ tick: (sim) => sim.mem.setUint32(16, 0xabcdef, true) }));
    m.boot(1n);
    m.step(emptyInput());
    expect(m.arena.view.getUint32(ARENA_HEADER + 16, true)).toBe(0xabcdef);
  });

  it("restores to a byte-identical machine after a cart tries to smuggle state", () => {
    // The end-to-end property. If anything a cart touched lives outside the
    // arena, these two snapshots diverge.
    const build = (): ReturnType<typeof createMachine> =>
      createMachine(
        cartOf({
          tick(sim) {
            const loose = sim as unknown as Record<string, unknown>;
            try {
              loose["counter"] = ((loose["counter"] as number) ?? 0) + 1;
            } catch {
              /* expected under a freeze */
            }
            const n = (loose["counter"] as number) ?? Number(sim.tick);
            sim.mem.setFloat64(0, sim.mem.getFloat64(0, true) + sim.sin(n), true);
            sim.mem.setUint32(8, sim.rnd(1 << 20), true);
          },
        }),
      );

    const m = build();
    m.boot(11n);
    for (let i = 0; i < 20; i++) m.step(emptyInput());
    const snap = m.snapshot();
    for (let i = 0; i < 20; i++) m.step(emptyInput());
    const afterFirst = m.snapshot();

    m.restore(snap);
    for (let i = 0; i < 20; i++) m.step(emptyInput());
    expect(m.snapshot()).toEqual(afterFirst);
  });

  it("puts the generator in the arena, so a rewind rewinds the sequence", () => {
    const drawn: number[] = [];
    const m = createMachine(cartOf({ tick: (sim) => void drawn.push(sim.rnd(1 << 30)) }));
    m.boot(3n);
    for (let i = 0; i < 5; i++) m.step(emptyInput());
    const snap = m.snapshot();
    const at5 = drawn.length;
    for (let i = 0; i < 5; i++) m.step(emptyInput());
    const after = drawn.slice(at5);

    m.restore(snap);
    drawn.length = at5;
    for (let i = 0; i < 5; i++) m.step(emptyInput());
    expect(drawn.slice(at5)).toEqual(after);
  });
});

describe("render must not write", () => {
  it("FAULTS when a cart writes the arena during render", () => {
    const m = createMachine(
      cartOf({
        // The classic bug: a value computed for smoothing, written where the next
        // tick will read it.
        render: (sim: SimRead, _d, alpha) => (sim.mem as DataView).setFloat64(0, alpha, true),
      }),
    );
    m.boot(1n);
    m.step(emptyInput());
    expect(() => m.present(NO_DRAW, 0.5)).toThrow(/render wrote to the arena/);
  });

  it("faults on a single byte, not just a big write", () => {
    const m = createMachine(
      cartOf({ render: (sim) => (sim.mem as DataView).setUint8(CART_BYTES - 1, 1) }),
    );
    m.boot(1n);
    expect(() => m.present(NO_DRAW, 0)).toThrow(/render wrote to the arena/);
  });

  it("does not fault when render only reads", () => {
    let sum = 0;
    const m = createMachine(
      cartOf({
        boot: (sim) => sim.mem.setFloat64(0, 2.5, true),
        render: (sim, _d, alpha) => void (sum += sim.mem.getFloat64(0, true) * alpha),
      }),
    );
    m.boot(1n);
    for (let i = 0; i < 5; i++) m.present(NO_DRAW, 0.5);
    expect(sum).toBe(6.25);
  });

  it("does not fault when render writes a value that was already there", () => {
    // Nothing changed, so nothing diverged. The check is about the bytes, not
    // about the call.
    const m = createMachine(cartOf({ render: (sim) => (sim.mem as DataView).setUint8(0, 0) }));
    m.boot(1n);
    expect(() => m.present(NO_DRAW, 0)).not.toThrow();
  });

  it("is armed by default and can be disarmed for a shipping runtime", () => {
    expect(devChecksEnabled()).toBe(true);
    // The write has to CHANGE something each time: the seal compares bytes, so
    // re-writing the value already there is correctly not a fault.
    const m = createMachine(
      cartOf({
        render: (sim) => (sim.mem as DataView).setUint8(0, (sim.mem.getUint8(0) + 1) & 0xff),
      }),
    );
    m.boot(1n);
    setDevChecks(false);
    expect(devChecksEnabled()).toBe(false);
    expect(() => m.present(NO_DRAW, 0)).not.toThrow();
    setDevChecks(true);
    expect(() => m.present(NO_DRAW, 0)).toThrow(/render wrote to the arena/);
  });

  it("gives render no way to draw a random number", () => {
    // rnd writes the arena, so it cannot exist on a read-only interface. A
    // renderer that wants jitter derives it from the tick, which reproduces.
    const m = createMachine(
      cartOf({
        render(sim) {
          expect((sim as unknown as Record<string, unknown>)["rnd"]).toBeUndefined();
          expect((sim as unknown as Record<string, unknown>)["rndf"]).toBeUndefined();
          expect(Object.isFrozen(sim)).toBe(true);
        },
      }),
    );
    m.boot(1n);
    m.present(NO_DRAW, 0);
  });

  it("rejects an alpha outside [0, 1)", () => {
    const m = createMachine(cartOf({}));
    m.boot(1n);
    expect(() => m.present(NO_DRAW, 1)).toThrow(/alpha must be in/);
    expect(() => m.present(NO_DRAW, -0.001)).toThrow(/alpha must be in/);
    expect(() => m.present(NO_DRAW, NaN)).toThrow(/alpha must be in/);
    expect(() => m.present(NO_DRAW, 0)).not.toThrow();
    expect(() => m.present(NO_DRAW, 0.999999)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------

describe("snd -- who gets it, and what it may not touch", () => {
  /** A backend that records, with no dependency on the audio package. */
  function spy(): { calls: string[]; snd: Snd } {
    const calls: string[] = [];
    return {
      calls,
      snd: {
        play: (id: number) => void calls.push(`play:${id}`),
        music: (id: number) => void calls.push(`music:${id}`),
        stopMusic: () => void calls.push("stopMusic"),
      },
    };
  }

  it("reaches boot and every tick", () => {
    const s = spy();
    const m = createMachine(
      cartOf({
        boot: (_sim, snd) => snd.play(1),
        tick: (sim, _i, snd) => snd.play(Number(sim.tick) + 10),
      }),
      s.snd,
    );
    m.boot(1n);
    for (let i = 0; i < 3; i++) m.step(emptyInput());
    expect(s.calls).toEqual(["play:1", "play:10", "play:11", "play:12"]);
  });

  it("NEVER reaches render, however many frames are presented", () => {
    // The rule that this whole parameter exists to express. `render` runs on the
    // presentation clock, two to four times per tick on a fast display, so a
    // sound emitted there fires two to four times per event -- on exactly the
    // hardware that was supposed to make the game sound better. There is no
    // fourth parameter, and this is the assertion that keeps it that way.
    const s = spy();
    let args = -1;
    let fourth: unknown = "never ran";
    const m = createMachine(
      cartOf({
        render(sim, draw, alpha) {
          args = arguments.length;
          // eslint-disable-next-line prefer-rest-params
          fourth = arguments[3];
          void sim.tick;
          void draw;
          void alpha;
        },
      }),
      s.snd,
    );
    m.boot(1n);
    m.step(emptyInput());
    for (let i = 0; i < 8; i++) m.present(NO_DRAW, i / 8);
    expect(args).toBe(3);
    expect(fourth).toBeUndefined();
    expect(s.calls).toEqual([]);
  });

  it("is a frozen facade, so a cart cannot remember anything on it", () => {
    // Same rule as `sim` and `mem`: a property hung off the mixer would survive
    // a tick and survive a restore, and no snapshot would contain it.
    const s = spy();
    let frozen = false;
    let smuggled: unknown = "never ran";
    let sameObject = true;
    const m = createMachine(
      cartOf({
        tick(_sim, _i, snd) {
          frozen = Object.isFrozen(snd);
          sameObject = (snd as unknown) === (s.snd as unknown);
          const loose = snd as unknown as Record<string, unknown>;
          try {
            loose["carry"] = ((loose["carry"] as number) ?? 0) + 1;
          } catch {
            /* strict-mode TypeError is the preferred outcome */
          }
          smuggled = loose["carry"];
        },
      }),
      s.snd,
    );
    m.boot(1n);
    m.step(emptyInput());
    m.step(emptyInput());
    expect(frozen).toBe(true);
    expect(smuggled).toBeUndefined();
    // And the host's own backend was not frozen on its behalf: a mixer has
    // controls of its own and they belong to whoever built it.
    expect(sameObject).toBe(false);
    expect(Object.isFrozen(s.snd)).toBe(false);
  });

  it("defaults to silence, so a headless run needs no mixer", () => {
    const m = createMachine(cartOf({ tick: (_s, _i, snd) => snd.play(3) }));
    m.boot(1n);
    expect(() => m.step(emptyInput())).not.toThrow();
    const s = nullSnd();
    expect(Object.isFrozen(s)).toBe(true);
    expect(() => {
      s.play(0);
      s.music(0, 30);
      s.stopMusic(30);
    }).not.toThrow();
  });

  it("cannot move the arena: the same run, silent and recorded, is the same bytes", () => {
    // AUDIO IS NOT SIMULATION. If a backend could change the arena, then a
    // golden case recorded with sound would not be the case replayed without
    // it, and the conformance chain would be measuring the mixer.
    const build = (snd?: Snd): ReturnType<typeof createMachine> =>
      createMachine(
        cartOf({
          boot: (sim, s) => {
            sim.mem.setFloat64(0, 3, true);
            s.play(1);
          },
          tick(sim, input, s) {
            s.play((Number(sim.tick) % 17) | 0, { gain: sim.rndf() });
            const x = sim.mem.getFloat64(0, true);
            sim.mem.setFloat64(0, x + sim.sin(x) + sim.rndf(), true);
            sim.mem.setUint32(16, sim.rnd(1 << 24) + ((input.buttons[0] as number) & 1), true);
          },
        }),
        snd,
      );

    const s = spy();
    const quiet = build();
    const loud = build(s.snd);
    quiet.boot(77n);
    loud.boot(77n);
    for (let i = 0; i < 120; i++) {
      const f = inputWith((x) => void (x.buttons[0] = i % 5 === 0 ? 1 : 0));
      quiet.step(f);
      loud.step(f);
    }
    expect(loud.snapshot()).toEqual(quiet.snapshot());
    expect(s.calls.length).toBe(121);
  });

  it("replays the same sounds after a restore, because it is driven by the arena", () => {
    const s = spy();
    const m = createMachine(
      cartOf({
        tick: (sim, _i, snd) => {
          const n = sim.rnd(5);
          sim.mem.setFloat64(0, sim.mem.getFloat64(0, true) + n, true);
          snd.play(n);
        },
      }),
      s.snd,
    );
    m.boot(9n);
    for (let i = 0; i < 10; i++) m.step(emptyInput());
    const snap = m.snapshot();

    s.calls.length = 0;
    for (let i = 0; i < 10; i++) m.step(emptyInput());
    const first = [...s.calls];

    m.restore(snap);
    s.calls.length = 0;
    for (let i = 0; i < 10; i++) m.step(emptyInput());
    expect(s.calls).toEqual(first);
    expect(first.length).toBe(10);
  });
});

describe("input", () => {
  it("reaches the cart for the tick it belongs to", () => {
    const seen: number[] = [];
    const m = createMachine(cartOf({ tick: (_s, i) => void seen.push(i.buttons[0] as number) }));
    m.boot(1n);
    m.step(inputWith((f) => void (f.buttons[0] = 1 << BUTTON.A)));
    m.step(inputWith((f) => void (f.buttons[0] = 1 << BUTTON.START)));
    expect(seen).toEqual([1 << BUTTON.A, 1 << 15]);
  });

  it("is copied, so a cart cannot hold a live reference to host memory", () => {
    let held: InputFrame | undefined;
    const m = createMachine(cartOf({ tick: (_s, i) => void (held = i) }));
    m.boot(1n);
    const hostFrame = inputWith((f) => void (f.axes[0] = 1000));
    m.step(hostFrame);
    hostFrame.axes[0] = -1000; // the host reuses its buffer, as a host will
    expect(held?.axes[0]).toBe(1000);
  });

  it("quantizes by construction: axes stay i16, triggers stay u8", () => {
    let axis = 0;
    let trig = 0;
    const m = createMachine(
      cartOf({
        tick(_s, i) {
          axis = i.axes[0] as number;
          trig = i.triggers[0] as number;
        },
      }),
    );
    m.boot(1n);
    const f = {
      buttons: new Uint16Array(MAX_PLAYERS),
      axes: new Int16Array(MAX_PLAYERS * 4),
      triggers: new Uint8Array(MAX_PLAYERS * 2),
      present: 0,
    };
    f.axes[0] = 40000; // wraps into i16, deterministically
    f.triggers[0] = 300; // wraps into u8
    m.step(f);
    expect(axis).toBe(40000 - 65536);
    expect(trig).toBe(300 - 256);
  });

  it("refuses a malformed frame rather than reading past the end", () => {
    const m = createMachine(cartOf({}));
    m.boot(1n);
    const bad = { ...emptyInput(), buttons: new Uint16Array(4) } as InputFrame;
    expect(() => m.step(bad)).toThrow(/buttons must have 8/);
    expect(() => m.step({ ...emptyInput(), axes: new Int16Array(8) } as InputFrame)).toThrow(
      /axes must have 32/,
    );
    expect(() =>
      m.step({ ...emptyInput(), triggers: new Uint8Array(3) } as InputFrame),
    ).toThrow(/triggers must have 16/);
    expect(() => m.step({ ...emptyInput(), present: 256 } as InputFrame)).toThrow(
      /present must be an 8-bit mask/,
    );
  });
});

describe("the normative library is on the sim, and it is ours", () => {
  it("hands the cart the console's sin, not the platform's", () => {
    let same = false;
    const m = createMachine(
      cartOf({ tick: (sim: Sim) => void (same = (sim.sin as unknown) === Math.sin) }),
    );
    m.boot(1n);
    m.step(emptyInput());
    expect(same).toBe(false);
  });

  it("hands the cart the platform's sqrt, because IEEE 754 specifies it", () => {
    let v = 0;
    const m = createMachine(cartOf({ tick: (sim) => void (v = sim.sqrt(2)) }));
    m.boot(1n);
    m.step(emptyInput());
    expect(v).toBe(Math.sqrt(2));
  });
});

describe("determinism end to end", () => {
  it("gives two machines with the same seed and inputs the same arena, byte for byte", () => {
    const build = (): ReturnType<typeof createMachine> =>
      createMachine(
        cartOf({
          boot: (sim) => sim.mem.setFloat64(0, 100, true),
          tick(sim, input) {
            const x = sim.mem.getFloat64(0, true);
            const a = sim.atan2(sim.sin(x), sim.cos(x * 1.5));
            const nudge = ((input.buttons[0] as number) & 1) === 1 ? 0.25 : 0;
            sim.mem.setFloat64(0, x + sim.sqrt(a * a + 1) + nudge + sim.rndf(), true);
            sim.mem.setUint32(16, sim.rnd(1 << 24), true);
          },
        }),
      );
    const a = build();
    const b = build();
    a.boot(0xdeadbeefn);
    b.boot(0xdeadbeefn);
    const inputs: InputFrame[] = [];
    for (let i = 0; i < 200; i++) {
      inputs.push(inputWith((f) => void (f.buttons[0] = i % 7 === 0 ? 1 : 0)));
    }
    for (const inp of inputs) {
      a.step(inp);
      b.step(inp);
    }
    expect(a.snapshot()).toEqual(b.snapshot());
  });

  it("is unaffected by how many times present was called in between", () => {
    // The whole point of the read-only rule: presentation cannot move the
    // simulation, however often the display asks for a frame.
    const build = (): ReturnType<typeof createMachine> =>
      createMachine(
        cartOf({
          tick: (sim) => sim.mem.setFloat64(0, sim.mem.getFloat64(0, true) + sim.rndf(), true),
          render: (sim, _d, alpha) => void (sim.mem.getFloat64(0, true) * alpha),
        }),
      );
    const a = build();
    const b = build();
    a.boot(5n);
    b.boot(5n);
    for (let i = 0; i < 50; i++) {
      a.step(emptyInput());
      b.step(emptyInput());
      for (let k = 0; k < (i % 5) + 1; k++) b.present(NO_DRAW, k / 8);
    }
    expect(a.snapshot()).toEqual(b.snapshot());
  });
});
