import { describe, it, expect } from "vitest";
import type { FromWorker, ToWorker } from "../src/protocol";
import {
  Host,
  inProcessChannel,
  workerChannel,
  type Channel,
  type MachineLike,
} from "../src/host";
import { createMessageHandler, isWorkerScope, installWorker, type WorkerScope } from "../src/worker";
import { AUDIO_REGS_BYTES, AUDIO_REGS_START, readAudioRegs } from "../src/audio";
import { ChainHasher } from "../src/hash";
import { ManualClock } from "../src/watchdog";

/*
 * Everything here runs against a fake machine defined in this file.
 *
 * That is deliberate and not a stopgap. The host's job is timing, buffer
 * ownership and message discipline; none of that is about what the machine
 * computes. A fake whose output is a known function of (frame, input) makes an
 * assertion like "the pixels on screen are the ones frame 7 produced" checkable,
 * which it would not be against a real cart. The real machine is exercised by
 * the conformance cases, which is the right place for it.
 */

const SCREEN_PIXELS = 128 * 128;
const RGBA_BYTES = SCREEN_PIXELS * 4;
const RAM_BYTES = 0x4000;
/** Framebuffer bytes: 4 bits per pixel, two pixels per byte, low nibble left. */
const FB_BYTES = SCREEN_PIXELS / 2;

/**
 * A machine whose entire state is a frame counter and the last input, and whose
 * framebuffer is a pure function of both. Deterministic, cheap, and wrong in a
 * loud way if the host ever mixes up a frame.
 */
class FakeMachine implements MachineLike {
  readonly ram = new Uint8Array(RAM_BYTES);
  readonly rgba = new Uint32Array(SCREEN_PIXELS);
  frames = 0;
  seed = 0;
  booted = 0;
  presented = 0;
  /** Set to a frame number to make `tick` throw on that frame. */
  throwOnFrame = -1;
  /** Set to make `boot` throw. */
  throwOnBoot = false;

  boot(seed: number): void {
    if (this.throwOnBoot) throw new Error("boot exploded");
    this.booted++;
    this.seed = seed;
    this.frames = 0;
    this.ram.fill(0);
    this.#paint(new Uint8Array(4));
  }

  tick(input: Uint8Array): void {
    if (this.frames === this.throwOnFrame) throw new Error(`tick exploded at ${this.frames}`);
    this.frames++;
    this.#paint(input);
  }

  present(): void {
    this.presented++;
    // 4 bits per pixel, low nibble is the left pixel, expanded to grey.
    for (let i = 0; i < SCREEN_PIXELS; i++) {
      const byte = this.ram[i >> 1] as number;
      const nib = (i & 1) === 0 ? byte & 0x0f : byte >> 4;
      const v = nib * 17; // 0x0 -> 0x00, 0xf -> 0xff
      this.rgba[i] = (0xff000000 | (v << 16) | (v << 8) | v) >>> 0;
    }
  }

  snapshot(): Uint8Array {
    // Deliberately a VIEW onto live RAM, not a copy: the worker must not
    // transfer this buffer away, and a fake that handed back a copy would hide
    // that bug rather than catch it.
    return this.ram.subarray(0, RAM_BYTES);
  }

  restore(snap: Uint8Array): void {
    this.ram.set(snap);
    this.frames = (this.ram[0x2000] as number) | ((this.ram[0x2001] as number) << 8);
  }

  #paint(input: Uint8Array): void {
    const k = (input[0] as number | undefined) ?? 0;
    for (let i = 0; i < FB_BYTES; i++) this.ram[i] = fbByte(i, this.frames, k);
    this.ram[0x2000] = this.frames & 0xff;
    this.ram[0x2001] = (this.frames >>> 8) & 0xff;
    // The audio register block, written every frame like a cart with a voice.
    // A fake whose registers stayed zero could not tell "the block crossed the
    // boundary" apart from "the block was never read", which is the whole
    // question the audio tests below ask.
    for (let i = 0; i < AUDIO_REGS_BYTES; i++) {
      this.ram[AUDIO_REGS_START + i] = audioByte(i, this.frames, k);
    }
  }
}

/** The audio register byte the fake writes at offset `i` on frame `f`, input `k`. */
function audioByte(i: number, f: number, k: number): number {
  return (i * 3 + f * 11 + k * 29 + 1) & 0xff;
}

/** The 80 register bytes `readAudioRegs` would take off a machine in that state. */
function expectRegs(f: number, k: number): Uint8Array {
  const out = new Uint8Array(AUDIO_REGS_BYTES);
  for (let i = 0; i < AUDIO_REGS_BYTES; i++) out[i] = audioByte(i, f, k);
  return out;
}

/** The framebuffer byte the fake paints at `b` on frame `f` with input byte `k`. */
function fbByte(b: number, f: number, k: number): number {
  return (b + f * 7 + k * 13) & 0xff;
}

/** The colour the fake presents for pixel `i` on frame `f` with input byte `k`. */
function expectPixel(i: number, f: number, k: number): number {
  const byte = fbByte(i >> 1, f, k);
  const nib = (i & 1) === 0 ? byte & 0x0f : byte >> 4;
  const v = nib * 17;
  return (0xff000000 | (v << 16) | (v << 8) | v) >>> 0;
}

const input = (k = 0): Uint8Array => new Uint8Array([k, 0, 0, 0]);

/** A booted host over an in-process fake. */
async function booted(opts?: { stepMs?: number; maxCatchUp?: number; seed?: number }) {
  const machine = new FakeMachine();
  const ch = inProcessChannel(machine);
  const host = new Host(
    ch,
    opts === undefined
      ? undefined
      : {
          ...(opts.stepMs === undefined ? {} : { stepMs: opts.stepMs }),
          ...(opts.maxCatchUp === undefined ? {} : { maxCatchUp: opts.maxCatchUp }),
        },
  );
  await host.load(opts?.seed ?? 1);
  return { machine, host, ch };
}

describe("the environment supports the transfer semantics these tests rely on", () => {
  it("structuredClone with transfer detaches the source buffer", () => {
    const b = new ArrayBuffer(16);
    expect(b.byteLength).toBe(16);
    const c = structuredClone(b, { transfer: [b] });
    expect(c.byteLength).toBe(16);
    expect(b.byteLength).toBe(0); // detached: this is what a real postMessage does
  });
});

describe("Host.load", () => {
  it("boots the machine and resolves", async () => {
    const { machine, host } = await booted({ seed: 42 });
    expect(machine.booted).toBe(1);
    expect(machine.seed).toBe(42);
    expect(host.loaded).toBe(true);
    expect(host.frame).toBe(0);
    expect(host.fault).toBeNull();
  });

  it("resets the frame counter on reload", async () => {
    const { host } = await booted();
    host.stepOnce(input());
    host.stepOnce(input());
    expect(host.frame).toBe(2);
    await host.load(9);
    expect(host.frame).toBe(0);
    expect(host.framesConfirmed).toBe(0);
  });

  it("rejects, and records a fault, when boot throws", async () => {
    const machine = new FakeMachine();
    machine.throwOnBoot = true;
    const host = new Host(inProcessChannel(machine));
    await expect(host.load(1)).rejects.toThrow(/boot exploded/);
    expect(host.loaded).toBe(false);
    expect(host.fault?.phase).toBe("boot");
  });
});

describe("Host.advance - the accumulator", () => {
  it("takes no step on the first call, which only baselines the clock", async () => {
    const { host } = await booted();
    expect(host.advance(1000, input())).toBe(0);
    expect(host.frame).toBe(0);
  });

  it("banks time and spends it a whole step at a time", async () => {
    const { host } = await booted({ stepMs: 10 });
    host.advance(0, input());
    expect(host.advance(9, input())).toBe(0); // acc 9
    expect(host.advance(11, input())).toBe(1); // acc 11 -> 1 step, 1 left
    expect(host.advance(20, input())).toBe(1); // acc 10 -> 1 step, 0 left
    expect(host.frame).toBe(2);
  });

  it("does not lose the remainder", async () => {
    const { host } = await booted({ stepMs: 10 });
    host.advance(0, input());
    // Nine 9 ms frames is 81 ms: eight steps' worth, with 1 ms banked.
    let steps = 0;
    for (let i = 1; i <= 9; i++) steps += host.advance(i * 9, input());
    expect(steps).toBe(8);
  });

  it("runs 60 steps for one second at the default rate", async () => {
    const { host } = await booted();
    host.advance(0, input());
    let steps = 0;
    // 16 ms of wall clock per call, which is what a display actually delivers.
    for (let i = 1; i <= 63; i++) steps += host.advance(i * 16, input());
    expect(steps).toBe(60);
  });

  it("clamps a 5000 ms jump to five steps, not three hundred", async () => {
    const { host } = await booted();
    host.advance(0, input());
    expect(host.advance(5000, input())).toBe(5);
    expect(host.frame).toBe(5);
  });

  it("caps catch-up even when the clamped time would afford more steps", async () => {
    // 100 ms of clamped dt is ten 10 ms steps, but maxCatchUp says five.
    const { host } = await booted({ stepMs: 10, maxCatchUp: 5 });
    host.advance(0, input());
    expect(host.advance(5000, input())).toBe(5);
  });

  it("honours a larger catch-up budget", async () => {
    const { host } = await booted({ stepMs: 10, maxCatchUp: 50 });
    host.advance(0, input());
    expect(host.advance(5000, input())).toBe(10); // dt clamped to 100, so ten steps
  });

  it("does not death-spiral over repeated long stalls", async () => {
    const { host } = await booted();
    host.advance(0, input());
    let steps = 0;
    for (let i = 1; i <= 10; i++) steps += host.advance(i * 60_000, input());
    expect(steps).toBe(50); // ten wake-ups, five steps each
  });

  it("ignores time that runs backwards", async () => {
    const { host } = await booted({ stepMs: 10 });
    host.advance(1000, input());
    expect(host.advance(900, input())).toBe(0);
    expect(host.advance(915, input())).toBe(1);
  });

  it("takes no step before load, but keeps the clock baselined", async () => {
    const machine = new FakeMachine();
    const host = new Host(inProcessChannel(machine), { stepMs: 10 });
    expect(host.advance(0, input())).toBe(0);
    expect(host.advance(10_000, input())).toBe(0);
    await host.load(1);
    expect(host.advance(10_050, input())).toBe(0); // first post-load call baselines
    expect(host.advance(10_075, input())).toBe(2);
  });
});

describe("Host - framebuffer ping-pong", () => {
  it("presents the pixels the machine painted for that frame", async () => {
    const { host } = await booted();
    host.stepOnce(input(3));
    const px = host.latestRgba;
    expect(px).not.toBeNull();
    expect(px?.length).toBe(SCREEN_PIXELS);
    expect(px?.[0]).toBe(expectPixel(0, 1, 3));
    expect(px?.[1234]).toBe(expectPixel(1234, 1, 3));
    expect(px?.[SCREEN_PIXELS - 1]).toBe(expectPixel(SCREEN_PIXELS - 1, 1, 3));
  });

  it("has no frame before the first step", async () => {
    const { host } = await booted();
    expect(host.latestRgba).toBeNull();
  });

  it("never reads a detached buffer across a long run", async () => {
    const { host } = await booted();
    for (let f = 1; f <= 240; f++) {
      host.stepOnce(input(f & 0xff));
      const px = host.latestRgba;
      // A detached buffer yields a zero-length view and reads as undefined,
      // rather than throwing, so both the length and a pixel are checked.
      expect(px?.length).toBe(SCREEN_PIXELS);
      expect(px?.[7]).toBe(expectPixel(7, f, f & 0xff));
    }
    expect(host.frame).toBe(240);
    expect(host.framesConfirmed).toBe(240);
  });

  it("keeps the previous frame readable until the next one lands", async () => {
    const { host } = await booted();
    host.stepOnce(input(1));
    const first = host.latestRgba as Uint32Array;
    expect(first[0]).toBe(expectPixel(0, 1, 1));
    host.stepOnce(input(2));
    // `first` is the retired buffer; it must not have been recycled out from
    // under a caller that was still rendering it.
    expect(first.length).toBe(SCREEN_PIXELS);
    expect(first[0]).toBe(expectPixel(0, 1, 1));
    expect((host.latestRgba as Uint32Array)[0]).toBe(expectPixel(0, 2, 2));
  });

  it("recycles two buffers rather than allocating one per frame", async () => {
    const { host } = await booted();
    expect(host.buffersAllocated).toBe(2);
    for (let f = 0; f < 500; f++) host.stepOnce(input());
    // Still two: 500 frames must not have cost 32 MiB of fresh ArrayBuffers.
    expect(host.buffersAllocated).toBe(2);
  });

  it("throws rather than silently showing black when a buffer comes back detached", () => {
    // A deliberately broken channel: it hands back a buffer it already gave
    // away. This is the failure the assertion exists for.
    let cb: ((m: FromWorker) => void) | null = null;
    const ch: Channel = {
      post(msg: ToWorker): void {
        if (msg.t === "load") cb?.({ t: "ready" });
        if (msg.t === "step") {
          const dead = msg.out;
          structuredClone(dead, { transfer: [dead] }); // detach it, then hand it back
          cb?.({ t: "frame", frame: msg.frame, out: dead, tookMs: 0 });
        }
      },
      onMessage(f): void {
        cb = f;
      },
      terminate(): void {},
    };
    const host = new Host(ch);
    void host.load(1);
    expect(() => host.stepOnce(input())).toThrow(/detached/);
  });

  it("throws when frames arrive out of order", () => {
    let cb: ((m: FromWorker) => void) | null = null;
    const ch: Channel = {
      post(msg: ToWorker): void {
        if (msg.t === "load") cb?.({ t: "ready" });
        if (msg.t === "step") {
          cb?.({ t: "frame", frame: msg.frame + 1, out: msg.out, tookMs: 0 });
        }
      },
      onMessage(f): void {
        cb = f;
      },
      terminate(): void {},
    };
    const host = new Host(ch);
    void host.load(1);
    expect(() => host.stepOnce(input())).toThrow(/out of order/);
  });
});

describe("Host - the audio register block crosses with the frame", () => {
  /*
   * THE CLAIM: the 80 bytes the mixer reads reach the main thread through the
   * PROTOCOL, not through a machine reference.
   *
   * Before this existed, a player could read the register block only by holding
   * the machine object -- which meant running the cart on its own thread, which
   * meant giving up Layer 2. Everything here is asserted against
   * `readAudioRegs` of the machine's own RAM for that frame, so a block that
   * arrives late, stale, truncated or zeroed fails rather than sounds wrong.
   */

  /** What `readAudioRegs` says the machine's registers are, right now. */
  const regsOf = (m: MachineLike): Uint8Array => {
    const out = new Uint8Array(AUDIO_REGS_BYTES);
    readAudioRegs(m.ram, out);
    return out;
  };

  it("has no registers before the first frame of a run", async () => {
    const { host } = await booted();
    expect(host.latestAudio).toBeNull();
  });

  it("delivers exactly readAudioRegs of the machine's RAM for that frame", async () => {
    const { host, machine } = await booted();
    host.stepOnce(input(3));
    const got = host.latestAudio;
    expect(got).not.toBeNull();
    expect(got?.length).toBe(AUDIO_REGS_BYTES);
    expect(Array.from(got as Uint8Array)).toEqual(Array.from(regsOf(machine)));
    // And that is the block the fake wrote for frame 1 with input byte 3 --
    // stated independently, so agreeing with a broken readAudioRegs is not a pass.
    expect(Array.from(got as Uint8Array)).toEqual(Array.from(expectRegs(1, 3)));
  });

  it("tracks the machine frame by frame, never a frame behind", async () => {
    const { host, machine } = await booted();
    for (let f = 1; f <= 30; f++) {
      const k = (f * 5) & 0xff;
      host.stepOnce(input(k));
      expect(Array.from(host.latestAudio as Uint8Array), `frame ${f}`).toEqual(
        Array.from(regsOf(machine)),
      );
      expect(Array.from(host.latestAudio as Uint8Array), `frame ${f}`).toEqual(
        Array.from(expectRegs(f, k)),
      );
    }
  });

  it("is a copy: the mixer cannot reach or scribble on machine RAM through it", async () => {
    const { host, machine } = await booted();
    host.stepOnce(input(1));
    const regs = host.latestAudio as Uint8Array;
    const before = machine.ram[AUDIO_REGS_START] as number;
    regs[0] = (before ^ 0xff) & 0xff;
    expect(machine.ram[AUDIO_REGS_START]).toBe(before);
    // The one-way street, from the other end: the machine's next frame must not
    // depend on what the mixer did with the last one.
    host.stepOnce(input(1));
    expect(Array.from(host.latestAudio as Uint8Array)).toEqual(Array.from(regsOf(machine)));
  });

  it("forgets the previous run's registers on load, so a note cannot hold across it", async () => {
    const { host } = await booted();
    host.stepOnce(input(7));
    expect(host.latestAudio).not.toBeNull();
    await host.load(2);
    expect(host.latestAudio).toBeNull();
    host.stepOnce(input(7));
    expect(Array.from(host.latestAudio as Uint8Array)).toEqual(Array.from(expectRegs(1, 7)));
  });

  it("reads a frame that carries no audio as silence, not as an error", () => {
    // A hand-written channel, an older worker, a peer that never learned about
    // the field: audio is non-normative, so a missing block must cost the sound
    // and nothing else.
    let cb: ((m: FromWorker) => void) | null = null;
    const ch: Channel = {
      post(msg: ToWorker): void {
        if (msg.t === "load") cb?.({ t: "ready" });
        if (msg.t === "step") cb?.({ t: "frame", frame: msg.frame, out: msg.out, tookMs: 0 });
      },
      onMessage(f): void {
        cb = f;
      },
      terminate(): void {},
    };
    const host = new Host(ch);
    void host.load(1);
    host.stepOnce(input());
    const regs = host.latestAudio;
    expect(regs?.length).toBe(AUDIO_REGS_BYTES);
    expect(Array.from(regs as Uint8Array).every((b) => b === 0)).toBe(true);
  });

  it("zero-fills a short block rather than leaving the previous frame's tail", () => {
    let cb: ((m: FromWorker) => void) | null = null;
    let short = false;
    const ch: Channel = {
      post(msg: ToWorker): void {
        if (msg.t === "load") cb?.({ t: "ready" });
        if (msg.t === "step") {
          const audio = short ? new Uint8Array(4).fill(9) : new Uint8Array(AUDIO_REGS_BYTES).fill(7);
          cb?.({ t: "frame", frame: msg.frame, out: msg.out, tookMs: 0, audio });
        }
      },
      onMessage(f): void {
        cb = f;
      },
      terminate(): void {},
    };
    const host = new Host(ch);
    void host.load(1);
    host.stepOnce(input());
    expect(Array.from(host.latestAudio as Uint8Array).every((b) => b === 7)).toBe(true);
    short = true;
    host.stepOnce(input());
    const regs = Array.from(host.latestAudio as Uint8Array);
    expect(regs.slice(0, 4)).toEqual([9, 9, 9, 9]);
    expect(regs.slice(4).every((b) => b === 0)).toBe(true);
  });

  it("costs one array for the life of the host, not one per frame", async () => {
    const { host } = await booted();
    host.stepOnce(input());
    const first = host.latestAudio;
    for (let f = 0; f < 200; f++) host.stepOnce(input(f & 0xff));
    // Identity, not contents: the host must be reusing its own buffer rather
    // than retaining the fresh clone each message arrives in.
    expect(host.latestAudio).toBe(first);
  });
});

describe("Host - faults", () => {
  it("records a tick fault and stops stepping", async () => {
    const machine = new FakeMachine();
    machine.throwOnFrame = 3;
    const host = new Host(inProcessChannel(machine));
    await host.load(1);
    for (let f = 0; f < 3; f++) host.stepOnce(input());
    expect(host.fault).toBeNull();
    host.stepOnce(input()); // frame 3 throws
    expect(host.fault?.phase).toBe("tick");
    expect(host.fault?.frame).toBe(3);
    expect(host.fault?.message).toMatch(/tick exploded/);
    expect(host.advance(1e6, input())).toBe(0);
    expect(() => host.stepOnce(input())).toThrow(/cannot step after a fault/);
  });

  it("faults when stepped before load", () => {
    const machine = new FakeMachine();
    const ch = inProcessChannel(machine);
    let seen: FromWorker | null = null;
    ch.onMessage((m) => {
      seen = m;
    });
    ch.post({ t: "step", frame: 0, input: new Uint8Array(4), out: new ArrayBuffer(RGBA_BYTES) }, []);
    expect((seen as FromWorker | null)?.t).toBe("fault");
  });
});

describe("Host - the deadline", () => {
  /*
   * The deadline in its own terms: a channel that boots and then goes quiet,
   * and a clock the test moves by hand. Terminating a real worker to stop a real
   * infinite loop is the other half, and it lives in watchdog.test.ts, which can
   * spawn a thread. Nothing here sleeps, so nothing here can flake.
   */
  const stalling = (): Channel & { terminations: number } => {
    let cb: ((m: FromWorker) => void) | null = null;
    return {
      terminations: 0,
      post(msg: ToWorker): void {
        if (msg.t === "load") cb?.({ t: "ready" });
        // A `step` is swallowed: from the host's side, a cart looping forever
        // and a worker not replying are the same event.
      },
      onMessage(f: (m: FromWorker) => void): void {
        cb = f;
      },
      terminate(): void {
        this.terminations++;
      },
    };
  };

  it("leaves the machine alone while frames keep arriving", async () => {
    const clock = new ManualClock();
    const machine = new FakeMachine();
    const host = new Host(inProcessChannel(machine), { clock });
    await host.load(1);
    for (let f = 0; f < 100; f++) host.stepOnce(input());
    clock.advance(10_000);
    expect(host.fault).toBeNull();
    expect(host.framesConfirmed).toBe(100);
    expect(clock.pending).toBe(0);
  });

  it("faults a step that is never answered, and kills the channel", async () => {
    const ch = stalling();
    const clock = new ManualClock();
    const host = new Host(ch, { clock, deadlineMs: 12 });
    await host.load(1);
    host.stepOnce(input());
    expect(host.fault).toBeNull();
    clock.advance(12);
    expect(host.fault).toEqual({ phase: "tick", frame: 0, message: "deadline" });
    expect(ch.terminations).toBe(1);
    expect(host.channelLive).toBe(false);
  });

  it("stops advancing after a deadline fault", async () => {
    const ch = stalling();
    const clock = new ManualClock();
    const host = new Host(ch, { clock, deadlineMs: 12 });
    await host.load(1);
    host.advance(0, input());
    host.advance(20, input());
    clock.advance(12);
    expect(host.fault?.message).toBe("deadline");
    expect(host.advance(1000, input())).toBe(0);
  });

  it("comes back on reload with a respawned channel", async () => {
    const dead = stalling();
    const clock = new ManualClock();
    const machine = new FakeMachine();
    const host = new Host(dead, {
      clock,
      deadlineMs: 12,
      respawn: () => inProcessChannel(machine),
    });
    await host.load(1);
    host.stepOnce(input());
    clock.advance(12);
    expect(host.fault?.message).toBe("deadline");

    await host.reload(2);
    expect(host.fault).toBeNull();
    host.stepOnce(input(5));
    expect(host.framesConfirmed).toBe(1);
    expect((host.latestRgba as Uint32Array)[0]).toBe(expectPixel(0, 1, 5));
  });

  it("reports the deadline it was built with", async () => {
    const { host } = await booted();
    expect(host.deadlineMs).toBe(12);
    const custom = new Host(inProcessChannel(new FakeMachine()), { deadlineMs: 40 });
    expect(custom.deadlineMs).toBe(40);
  });
});

describe("Host - snapshot and restore", () => {
  it("round-trips machine state", async () => {
    const { host, machine } = await booted();
    for (let f = 0; f < 5; f++) host.stepOnce(input(1));
    const snap = await host.snapshot();
    expect(snap.length).toBe(RAM_BYTES);
    expect(machine.frames).toBe(5);

    for (let f = 0; f < 3; f++) host.stepOnce(input(1));
    expect(machine.frames).toBe(8);

    await host.restore(snap);
    expect(machine.frames).toBe(5);
    host.stepOnce(input(1));
    expect((host.latestRgba as Uint32Array)[0]).toBe(expectPixel(0, 6, 1));
  });

  it("does not detach the machine's own RAM when snapshotting a view", async () => {
    const { host, machine } = await booted();
    host.stepOnce(input());
    await host.snapshot();
    // The fake returns a view onto live RAM. If the worker had transferred that
    // buffer, the machine would be running on detached memory from here on.
    expect(machine.ram.length).toBe(RAM_BYTES);
    host.stepOnce(input());
    expect(machine.ram[0]).toBeTypeOf("number");
    expect((host.latestRgba as Uint32Array)[0]).toBe(expectPixel(0, 2, 0));
  });

  it("gives back a copy, not a live view", async () => {
    const { host, machine } = await booted();
    host.stepOnce(input());
    const snap = await host.snapshot();
    const before = snap[0] as number;
    host.stepOnce(input());
    expect(machine.ram[0]).not.toBe(before);
    expect(snap[0]).toBe(before);
  });
});

describe("Host - determinism through the channel", () => {
  it("two runs of the same seed and inputs chain to the same digest", async () => {
    const run = async (): Promise<string> => {
      const { host, machine } = await booted({ seed: 5 });
      const chain = new ChainHasher();
      for (let f = 0; f < 60; f++) {
        host.stepOnce(input(f & 7));
        chain.push(machine.ram);
      }
      return chain.digest;
    };
    const a = await run();
    const b = await run();
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("a different seed is allowed to chain the same when the fake ignores it", async () => {
    // The fake's output does not depend on the seed, so this asserts the harness
    // is not accidentally mixing the seed in behind the machine's back.
    const run = async (seed: number): Promise<string> => {
      const { host, machine } = await booted({ seed });
      const chain = new ChainHasher();
      for (let f = 0; f < 10; f++) {
        host.stepOnce(input(1));
        chain.push(machine.ram);
      }
      return chain.digest;
    };
    expect(await run(1)).toBe(await run(2));
  });

  it("one different input byte changes the chain", async () => {
    const run = async (at: number): Promise<string> => {
      const { host, machine } = await booted();
      const chain = new ChainHasher();
      for (let f = 0; f < 10; f++) {
        host.stepOnce(input(f === at ? 9 : 0));
        chain.push(machine.ram);
      }
      return chain.digest;
    };
    expect(await run(4)).not.toBe(await run(5));
  });
});

describe("the worker message handler", () => {
  const sink = () => {
    const out: FromWorker[] = [];
    return { out, post: (m: FromWorker) => void out.push(m) };
  };

  it("answers load with ready", () => {
    const s = sink();
    const h = createMessageHandler(() => new FakeMachine(), s.post);
    h({ t: "load", seed: 3 });
    expect(s.out).toEqual([{ t: "ready" }]);
  });

  it("faults, rather than throwing, when the factory throws", () => {
    const s = sink();
    const h = createMessageHandler(() => {
      throw new Error("no cart");
    }, s.post);
    h({ t: "load", seed: 1 });
    expect(s.out[0]).toMatchObject({ t: "fault", phase: "load" });
    expect((s.out[0] as { message: string }).message).toMatch(/no cart/);
  });

  it("answers every message with exactly one reply", () => {
    const s = sink();
    const h = createMessageHandler(() => new FakeMachine(), s.post);
    h({ t: "load", seed: 1 });
    h({ t: "step", frame: 0, input: input(), out: new ArrayBuffer(RGBA_BYTES) });
    h({ t: "snapshot" });
    expect(s.out.map((m) => m.t)).toEqual(["ready", "frame", "snapshot"]);
  });

  it("faults when the out buffer is the wrong size", () => {
    const s = sink();
    const h = createMessageHandler(() => new FakeMachine(), s.post);
    h({ t: "load", seed: 1 });
    h({ t: "step", frame: 0, input: input(), out: new ArrayBuffer(16) });
    expect(s.out[1]).toMatchObject({ t: "fault", phase: "tick", frame: 0 });
  });

  it("reports tookMs without letting it reach the machine", () => {
    const s = sink();
    const h = createMessageHandler(() => new FakeMachine(), s.post);
    h({ t: "load", seed: 1 });
    h({ t: "step", frame: 7, input: input(), out: new ArrayBuffer(RGBA_BYTES) });
    const f = s.out[1] as { t: string; frame: number; tookMs: number };
    expect(f.t).toBe("frame");
    expect(f.frame).toBe(7);
    expect(f.tookMs).toBeGreaterThanOrEqual(0);
  });

  it("puts the frame's audio registers on the frame reply", () => {
    const s = sink();
    const m = new FakeMachine();
    const h = createMessageHandler(() => m, s.post);
    h({ t: "load", seed: 1 });
    h({ t: "step", frame: 0, input: input(4), out: new ArrayBuffer(RGBA_BYTES) });
    const f = s.out[1] as { t: string; audio?: Uint8Array };
    expect(f.t).toBe("frame");
    expect(f.audio?.length).toBe(AUDIO_REGS_BYTES);
    // Read off the machine AFTER the tick: a handler that sampled the registers
    // before calling tick would deliver every frame's sound one frame late.
    const live = new Uint8Array(AUDIO_REGS_BYTES);
    readAudioRegs(m.ram, live);
    expect(Array.from(f.audio as Uint8Array)).toEqual(Array.from(live));
    expect(Array.from(f.audio as Uint8Array)).toEqual(Array.from(expectRegs(1, 4)));
  });

  it("reuses one register array, so the step path allocates nothing for audio", () => {
    const s = sink();
    const h = createMessageHandler(() => new FakeMachine(), s.post);
    h({ t: "load", seed: 1 });
    for (let f = 0; f < 3; f++) {
      h({ t: "step", frame: f, input: input(), out: new ArrayBuffer(RGBA_BYTES) });
    }
    const audios = s.out.slice(1).map((m) => (m as { audio?: Uint8Array }).audio);
    expect(audios).toHaveLength(3);
    expect(audios[1]).toBe(audios[0]);
    expect(audios[2]).toBe(audios[0]);
    // Safe only because `postMessage` copies synchronously. The in-process
    // channel reproduces that with structuredClone, which is why `Host` never
    // sees one frame's registers overwritten by the next.
    expect(audios[0]?.length).toBe(AUDIO_REGS_BYTES);
  });

  it("drops the machine after a tick fault, so the next step also faults", () => {
    const s = sink();
    const m = new FakeMachine();
    m.throwOnFrame = 0;
    const h = createMessageHandler(() => m, s.post);
    h({ t: "load", seed: 1 });
    h({ t: "step", frame: 0, input: input(), out: new ArrayBuffer(RGBA_BYTES) });
    h({ t: "step", frame: 1, input: input(), out: new ArrayBuffer(RGBA_BYTES) });
    expect(s.out[1]).toMatchObject({ t: "fault", phase: "tick" });
    expect(s.out[2]).toMatchObject({ t: "fault", message: "step before load" });
  });
});

describe("channel plumbing", () => {
  it("workerChannel forwards posts, replies and terminate", () => {
    const posted: Array<{ msg: unknown; transfer: unknown }> = [];
    let onmessage: ((e: { data: FromWorker }) => void) | null = null;
    let terminated = 0;
    const fakeWorker = {
      postMessage(msg: unknown, transfer?: unknown) {
        posted.push({ msg, transfer });
      },
      set onmessage(f: unknown) {
        onmessage = f as typeof onmessage;
      },
      get onmessage() {
        return onmessage;
      },
      terminate() {
        terminated++;
      },
    };
    const ch = workerChannel(fakeWorker as unknown as Worker);
    const seen: FromWorker[] = [];
    ch.onMessage((m) => void seen.push(m));

    ch.post({ t: "load", seed: 1 });
    const buf = new ArrayBuffer(RGBA_BYTES);
    ch.post({ t: "step", frame: 0, input: input(), out: buf }, [buf]);
    expect(posted).toHaveLength(2);
    expect(posted[0]?.transfer).toBeUndefined();
    expect(posted[1]?.transfer).toEqual([buf]);

    // Read through a function so flow analysis does not still believe the
    // handler is the `null` it was initialised to.
    const handler = ((): ((e: { data: FromWorker }) => void) | null => onmessage)();
    if (handler === null) throw new Error("workerChannel installed no onmessage");
    handler({ data: { t: "ready" } });
    expect(seen).toEqual([{ t: "ready" }]);

    ch.terminate();
    expect(terminated).toBe(1);
  });

  it("inProcessChannel stops replying after terminate", () => {
    const ch = inProcessChannel(new FakeMachine());
    const seen: FromWorker[] = [];
    ch.onMessage((m) => void seen.push(m));
    ch.post({ t: "load", seed: 1 });
    expect(seen).toHaveLength(1);
    ch.terminate();
    ch.post({ t: "load", seed: 1 });
    expect(seen).toHaveLength(1);
  });

  it("inProcessChannel detaches transferred buffers, like a real Worker does", () => {
    const ch = inProcessChannel(new FakeMachine());
    ch.onMessage(() => {});
    ch.post({ t: "load", seed: 1 });
    const buf = new ArrayBuffer(RGBA_BYTES);
    ch.post({ t: "step", frame: 0, input: input(), out: buf }, [buf]);
    expect(buf.byteLength).toBe(0);
  });
});

/**
 * Hand a message to a scope's installed handler.
 *
 * Behind a function because the scope literal is initialised with
 * `onmessage: null`, and TypeScript's flow analysis would otherwise still
 * believe it is null after `installWorker` has replaced it.
 */
function deliver(scope: WorkerScope, m: ToWorker): void {
  const handler = scope.onmessage;
  if (handler === null) throw new Error("no handler installed");
  handler({ data: m });
}

describe("worker installation", () => {
  it("declines to install where there is no worker scope", () => {
    expect(isWorkerScope(globalThis)).toBe(false);
    expect(installWorker(() => new FakeMachine())).toBe(false);
  });

  it("installs onto an explicit scope and answers messages through it", () => {
    const sent: FromWorker[] = [];
    const scope: WorkerScope = {
      onmessage: null,
      postMessage(m: unknown) {
        sent.push(m as FromWorker);
      },
    };
    expect(installWorker(() => new FakeMachine(), scope)).toBe(true);
    deliver(scope, { t: "load", seed: 1 });
    expect(sent).toEqual([{ t: "ready" }]);
  });

  it("does not touch the global scope merely by being imported", () => {
    // Importing this module in Node must be inert; the assertion is that no
    // onmessage got attached anywhere by the import above.
    expect((globalThis as Record<string, unknown>)["onmessage"] ?? null).toBeNull();
  });
});
