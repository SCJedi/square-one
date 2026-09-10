/**
 * The audio graph, without an AudioContext.
 *
 * Everything worth testing here is either arithmetic (the ring, the pacing, the
 * starvation rule) or a state machine (autoplay), and none of it needs a sound
 * card. What it does need is the worklet's source to be the same synth the
 * runtime tests proved, so the centrepiece of this file evaluates the assembled
 * worklet module — processor class included — against a stand-in
 * `AudioWorkletProcessor` and demands sample-for-sample agreement with the
 * main-thread objects.
 *
 * What is NOT covered, and cannot be without a browser: that `addModule`
 * accepts a blob URL under a real content security policy, that the worklet's
 * 128-sample quantum arrives on time, that `resume()` behaves as the autoplay
 * spec says on each engine, and that the output is audible. Those belong to a
 * manual check or a browser conformance run, not to a unit test that would have
 * to fake the very thing it claims to verify.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  AUDIO_REGS_BYTES,
  CH,
  CH_STRIDE,
  CTRL_ENABLE,
  CTRL_GATE,
  WAVE,
  createSynthState,
  renderAudio,
} from "../../runtime/src/audio";
import {
  DEFAULT_FRAME_HZ,
  DEFAULT_RING_DEPTH,
  PROCESSOR_NAME,
  buildWorkletSource,
  createAudioGraph,
  createMixerCore,
  createRegisterRing,
  type SynthDeps,
} from "../src/audio-graph";

const SR = 48000;
const QUANTUM = 128;

const DEPS: SynthDeps = { createSynthState, renderAudio, createRegisterRing };

/** A register frame with channel `c` playing a gated square wave. */
function frameWith(c: number, hz: number, vol = 255): Uint8Array {
  const r = new Uint8Array(AUDIO_REGS_BYTES);
  const b = c * CH_STRIDE;
  r[b + CH.CTRL] = CTRL_ENABLE | CTRL_GATE;
  r[b + CH.WAVE] = WAVE.PULSE;
  r[b + CH.VOL] = vol;
  const p = Math.round(hz * 16);
  r[b + CH.PITCH_LO] = p & 0xff;
  r[b + CH.PITCH_HI] = (p >> 8) & 0xff;
  return r;
}

function isSilent(out: Float32Array): boolean {
  for (let i = 0; i < out.length; i++) if (out[i] !== 0) return false;
  return true;
}

// ---------------------------------------------------------------------------

describe("the register ring", () => {
  it("hands frames back in order", () => {
    const ring = createRegisterRing(4, 8);
    const a = new Uint8Array([1, 1, 1, 1, 1, 1, 1, 1]);
    const b = new Uint8Array([2, 2, 2, 2, 2, 2, 2, 2]);
    ring.push(a);
    ring.push(b);
    expect(ring.pending).toBe(2);

    ring.advance();
    expect(Array.from(ring.current)).toEqual(Array.from(a));
    ring.advance();
    expect(Array.from(ring.current)).toEqual(Array.from(b));
    expect(ring.pending).toBe(0);
  });

  it("copies rather than aliases, so the caller may reuse its buffer", () => {
    const ring = createRegisterRing(2, 4);
    const scratch = new Uint8Array([9, 9, 9, 9]);
    ring.push(scratch);
    scratch.fill(0);
    ring.advance();
    expect(Array.from(ring.current)).toEqual([9, 9, 9, 9]);
  });

  it("repeats the last frame when it is starved, and counts it", () => {
    const ring = createRegisterRing(2, 4);
    ring.push(new Uint8Array([7, 7, 7, 7]));
    ring.advance();
    expect(ring.starved).toBe(0);

    for (let i = 0; i < 5; i++) ring.advance();
    expect(ring.starved).toBe(5);
    expect(Array.from(ring.current)).toEqual([7, 7, 7, 7]);
  });

  it("drops the oldest frame rather than growing latency", () => {
    const ring = createRegisterRing(2, 1);
    ring.push(new Uint8Array([1]));
    ring.push(new Uint8Array([2]));
    ring.push(new Uint8Array([3]));
    expect(ring.dropped).toBe(1);
    expect(ring.pending).toBe(2);

    ring.advance();
    expect(ring.current[0]).toBe(2); // the 1 is gone, not queued behind
    ring.advance();
    expect(ring.current[0]).toBe(3);
  });

  it("clamps a short or long frame instead of reading past it", () => {
    const ring = createRegisterRing(1, 4);
    ring.push(new Uint8Array([5, 5]));
    ring.advance();
    expect(Array.from(ring.current)).toEqual([5, 5, 0, 0]);

    ring.push(new Uint8Array([1, 2, 3, 4, 5, 6]));
    ring.advance();
    expect(Array.from(ring.current)).toEqual([1, 2, 3, 4]);
  });
});

describe("the mixer core", () => {
  function core(): ReturnType<typeof createMixerCore> {
    return createMixerCore(DEPS, SR, AUDIO_REGS_BYTES, DEFAULT_FRAME_HZ, DEFAULT_RING_DEPTH);
  }

  it("takes 60 register frames per second of audio", () => {
    // A deep ring, so the count is about the pacing and not about dropping.
    const c = createMixerCore(DEPS, SR, AUDIO_REGS_BYTES, DEFAULT_FRAME_HZ, 256);
    for (let i = 0; i < 200; i++) c.push(new Uint8Array(AUDIO_REGS_BYTES));
    const before = c.pending;

    const out = new Float32Array(QUANTUM);
    for (let i = 0; i < SR / QUANTUM; i++) c.render(out);

    expect(before - c.pending).toBeGreaterThanOrEqual(DEFAULT_FRAME_HZ - 1);
    expect(before - c.pending).toBeLessThanOrEqual(DEFAULT_FRAME_HZ + 1);
    expect(c.starved).toBe(0);
  });

  it("takes the waiting frame on the very first callback", () => {
    const c = core();
    c.push(frameWith(0, 440));
    const out = new Float32Array(QUANTUM);
    c.render(out);
    expect(c.pending).toBe(0);
    expect(isSilent(out)).toBe(false); // no opening frame of silence
  });

  it("keeps rendering the last frame when the simulation stalls", () => {
    const c = core();
    c.push(frameWith(0, 440));

    const out = new Float32Array(QUANTUM);
    // Drain the one frame in, then run for a second of audio with nothing more.
    for (let i = 0; i < 8; i++) c.render(out);
    expect(isSilent(out)).toBe(false);

    let loud = 0;
    for (let i = 0; i < SR / QUANTUM; i++) {
      c.render(out);
      if (!isSilent(out)) loud++;
    }
    expect(loud).toBe(Math.floor(SR / QUANTUM));
    expect(c.starved).toBeGreaterThan(0);
    expect(c.pending).toBe(0);
  });

  it("renders silence before the first frame arrives, and never throws", () => {
    const c = core();
    const out = new Float32Array(QUANTUM);
    for (let i = 0; i < 32; i++) c.render(out);
    expect(isSilent(out)).toBe(true);
    expect(c.starved).toBeGreaterThan(0);
  });

  it("is exactly the runtime synth, driven one frame at a time", () => {
    const c = core();
    const regs = frameWith(1, 261.63);
    c.push(regs);

    const state = createSynthState();
    const mine = new Float32Array(QUANTUM);
    const theirs = new Float32Array(QUANTUM);
    for (let i = 0; i < 24; i++) {
      c.render(mine);
      renderAudio(regs, state, theirs, SR);
      expect(Array.from(mine)).toEqual(Array.from(theirs));
    }
  });

  it("does not build a backlog when the callback is starved of CPU", () => {
    const c = core();
    for (let i = 0; i < 4; i++) c.push(new Uint8Array(AUDIO_REGS_BYTES));
    // One enormous quantum: several frames' worth of samples in one call.
    const huge = new Float32Array(SR);
    c.render(huge);
    // Exactly one frame is taken, and no debt is carried into the next call.
    expect(c.pending).toBe(3);
    const out = new Float32Array(QUANTUM);
    c.render(out);
    expect(c.pending).toBe(3);
  });
});

/**
 * The drift guard.
 *
 * The worklet is assembled from `Function.prototype.toString()` of the real
 * synth, so this test evaluates the entire assembled module against a stand-in
 * `AudioWorkletProcessor` and compares it with the main-thread objects. If
 * anyone gives `renderAudio`, `createRegisterRing` or `createMixerCore` a free
 * variable, the evaluation throws a ReferenceError here rather than going
 * quiet in a browser.
 */
describe("the worklet source is the synth, not a copy of it", () => {
  class FakeProcessorBase {
    port: { onmessage: ((e: { data: unknown }) => void) | null; postMessage(m: unknown): void } = {
      onmessage: null,
      postMessage(): void {},
    };
  }

  interface FakeProcessor {
    port: { onmessage: ((e: { data: unknown }) => void) | null };
    process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
  }

  function loadWorklet(): { name: string; make: () => FakeProcessor } {
    let name = "";
    let Cls: (new () => FakeProcessor) | null = null;
    const load = new Function(
      "AudioWorkletProcessor",
      "registerProcessor",
      "sampleRate",
      buildWorkletSource(),
    ) as (base: unknown, reg: (n: string, c: unknown) => void, sr: number) => void;

    load(
      FakeProcessorBase,
      (n: string, c: unknown) => {
        name = n;
        Cls = c as new () => FakeProcessor;
      },
      SR,
    );
    const ctor = Cls as unknown as new () => FakeProcessor;
    return { name, make: () => new ctor() };
  }

  it("registers a processor under the name the graph asks for", () => {
    expect(loadWorklet().name).toBe(PROCESSOR_NAME);
  });

  it("renders sample for sample what the main thread renders", () => {
    const proc = loadWorklet().make();
    const core = createMixerCore(DEPS, SR, AUDIO_REGS_BYTES, DEFAULT_FRAME_HZ, DEFAULT_RING_DEPTH);

    const frames = [frameWith(0, 440), frameWith(0, 523.25), frameWith(2, 110, 128)];
    const mono = new Float32Array(QUANTUM);
    const mine = new Float32Array(QUANTUM);

    for (let i = 0; i < 40; i++) {
      if (i % 7 === 0) {
        const f = frames[(i / 7) % frames.length] as Uint8Array;
        proc.port.onmessage?.({ data: new Uint8Array(f) });
        core.push(f);
      }
      mono.fill(0);
      expect(proc.process([], [[mono]])).toBe(true);
      core.render(mine);
      expect(Array.from(mono)).toEqual(Array.from(mine));
    }
    // And it actually made a sound, so the comparison was not two silences.
    expect(isSilent(mine)).toBe(false);
  });

  it("copies the mono render into every output channel it is given", () => {
    const proc = loadWorklet().make();
    proc.port.onmessage?.({ data: frameWith(0, 440) });
    const l = new Float32Array(QUANTUM);
    const r = new Float32Array(QUANTUM);
    for (let i = 0; i < 8; i++) proc.process([], [[l, r]]);
    expect(Array.from(r)).toEqual(Array.from(l));
    expect(isSilent(l)).toBe(false);
  });

  it("survives a render call with no output at all", () => {
    const proc = loadWorklet().make();
    expect(proc.process([], [])).toBe(true);
    expect(proc.process([], [[]])).toBe(true);
  });

  it("names nothing outside itself", () => {
    const src = buildWorkletSource();
    // Vite's SSR transform rewrites imported bindings; a bundler renames them.
    // Either would be a ReferenceError inside the worklet realm.
    expect(src).not.toMatch(/__vite_ssr/);
    expect(src).toContain("function renderAudio(");
    expect(src).toContain("function createSynthState(");
    expect(src).toContain("function createRegisterRing(");
    expect(src).toContain("function createMixerCore(");
  });
});

// ---------------------------------------------------------------------------

/** A fake sound card: enough of the Web Audio API to drive the state machine. */
class FakePort {
  onmessage: ((e: { data: unknown }) => void) | null = null;
  readonly posted: Uint8Array[] = [];
  postMessage(m: Uint8Array): void {
    this.posted.push(new Uint8Array(m));
  }
}

class FakeNode {
  readonly port = new FakePort();
  connected = 0;
  constructor(
    readonly ctx: unknown,
    readonly name: string,
    readonly options: unknown,
  ) {
    FakeNode.made.push(this);
  }
  static made: FakeNode[] = [];
  connect(): void {
    this.connected++;
  }
  disconnect(): void {
    this.connected--;
  }
}

class FakeContext {
  static allowResume = true;
  static made: FakeContext[] = [];
  static modules: string[] = [];
  state = "suspended";
  readonly sampleRate: number;
  readonly destination = {};
  readonly audioWorklet = {
    addModule: async (url: string): Promise<void> => {
      FakeContext.modules.push(url);
    },
  };
  constructor(options?: { sampleRate?: number }) {
    this.sampleRate = options?.sampleRate ?? 44100;
    FakeContext.made.push(this);
  }
  async resume(): Promise<void> {
    if (FakeContext.allowResume) this.state = "running";
  }
  async close(): Promise<void> {
    this.state = "closed";
  }
}

describe("the audio graph's state machine", () => {
  const g = globalThis as unknown as Record<string, unknown>;
  let saved: Record<string, unknown> = {};

  beforeEach(() => {
    saved = {
      AudioContext: g["AudioContext"],
      AudioWorkletNode: g["AudioWorkletNode"],
    };
    g["AudioContext"] = FakeContext;
    g["AudioWorkletNode"] = FakeNode;
    FakeContext.allowResume = true;
    FakeContext.made = [];
    FakeContext.modules = [];
    FakeNode.made = [];
  });

  afterEach(() => {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete g[k];
      else g[k] = saved[k];
    }
  });

  it("starts stopped and claims no sample rate it does not have", () => {
    const graph = createAudioGraph();
    expect(graph.running).toBe(false);
    expect(graph.state).toBe("stopped");
    expect(graph.sampleRate).toBe(0);
  });

  it("resolves only once the context is really running", async () => {
    const graph = createAudioGraph({ sampleRate: SR });
    await graph.start();
    expect(graph.running).toBe(true);
    expect(graph.state).toBe("running");
    expect(graph.sampleRate).toBe(SR);
    expect(FakeContext.modules.length).toBe(1);
    expect(FakeNode.made[0]?.name).toBe(PROCESSOR_NAME);
    expect(FakeNode.made[0]?.connected).toBe(1);
  });

  it("reports suspended rather than pretending, when autoplay blocks it", async () => {
    FakeContext.allowResume = false;
    const graph = createAudioGraph();
    await expect(graph.start()).rejects.toThrow(/suspended/);
    expect(graph.running).toBe(false);
    expect(graph.state).toBe("suspended");
  });

  it("a gesture after a blocked start needs only a resume, not a new context", async () => {
    FakeContext.allowResume = false;
    const graph = createAudioGraph();
    await expect(graph.start()).rejects.toThrow();
    expect(FakeContext.made.length).toBe(1);

    FakeContext.allowResume = true;
    await graph.start();
    expect(graph.running).toBe(true);
    expect(FakeContext.made.length).toBe(1); // the same context, resumed
    expect(FakeContext.modules.length).toBe(1); // the module was not re-added
  });

  it("two overlapping starts share one attempt", async () => {
    const graph = createAudioGraph();
    const a = graph.start();
    const b = graph.start();
    await Promise.all([a, b]);
    expect(FakeContext.made.length).toBe(1);
  });

  it("starting an already-running graph is a no-op", async () => {
    const graph = createAudioGraph();
    await graph.start();
    await graph.start();
    expect(FakeContext.made.length).toBe(1);
  });

  it("says so plainly when the environment has no AudioWorklet", async () => {
    delete g["AudioWorkletNode"];
    const graph = createAudioGraph();
    await expect(graph.start()).rejects.toThrow(/no AudioWorklet/);
    expect(graph.state).toBe("stopped");
  });

  it("remembers pushes made while stopped and sends the latest on start", async () => {
    const graph = createAudioGraph();
    graph.push(frameWith(0, 440));
    graph.push(frameWith(0, 880));
    expect(FakeNode.made.length).toBe(0); // nothing to post to, nothing thrown

    await graph.start();
    const port = FakeNode.made[0]?.port as FakePort;
    expect(port.posted.length).toBe(1);
    const expected = frameWith(0, 880);
    expect(Array.from(port.posted[0] as Uint8Array)).toEqual(Array.from(expected));
  });

  it("posts one message per push once it is running", async () => {
    const graph = createAudioGraph();
    await graph.start();
    const port = FakeNode.made[0]?.port as FakePort;
    graph.push(frameWith(0, 440));
    graph.push(frameWith(1, 660));
    expect(port.posted.length).toBe(2);
  });

  it("copies each push, so the caller may reuse one buffer forever", async () => {
    const graph = createAudioGraph();
    await graph.start();
    const port = FakeNode.made[0]?.port as FakePort;

    const scratch = new Uint8Array(AUDIO_REGS_BYTES);
    scratch[CH.VOL] = 111;
    graph.push(scratch);
    scratch[CH.VOL] = 222;
    graph.push(scratch);

    expect((port.posted[0] as Uint8Array)[CH.VOL]).toBe(111);
    expect((port.posted[1] as Uint8Array)[CH.VOL]).toBe(222);
  });

  it("clamps a frame that is the wrong size instead of trusting it", async () => {
    const graph = createAudioGraph();
    await graph.start();
    const port = FakeNode.made[0]?.port as FakePort;

    graph.push(new Uint8Array(4).fill(3));
    const posted = port.posted[0] as Uint8Array;
    expect(posted.length).toBe(AUDIO_REGS_BYTES);
    expect(posted[3]).toBe(3);
    expect(posted[4]).toBe(0);

    graph.push(new Uint8Array(AUDIO_REGS_BYTES + 16).fill(5));
    expect((port.posted[1] as Uint8Array).length).toBe(AUDIO_REGS_BYTES);
  });

  it("stops, and stopping twice is not an error", async () => {
    const graph = createAudioGraph();
    await graph.start();
    const ctx = FakeContext.made[0] as FakeContext;
    graph.stop();
    expect(graph.running).toBe(false);
    expect(graph.state).toBe("stopped");
    expect(ctx.state).toBe("closed");
    graph.stop();
    expect(graph.state).toBe("stopped");
  });

  it("a push after stop is remembered, not thrown", async () => {
    const graph = createAudioGraph();
    await graph.start();
    graph.stop();
    graph.push(frameWith(0, 440));
    expect(graph.state).toBe("stopped");
  });
});
