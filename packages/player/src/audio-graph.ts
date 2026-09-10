/**
 * The main-thread audio host: an AudioWorklet running the runtime's synth.
 *
 * THE STREET IS ONE WAY, AND THIS IS THE DOWNHILL END. The simulation writes
 * audio registers; `push()` hands a frame of them to the worklet; the worklet
 * renders at the sound card's rate. Nothing here ever answers back. There is no
 * "the mixer needs another frame" message, no callback into the sim, no clock
 * read that could reach a cart. An `AudioContext` runs on its own oscillator,
 * drifts against `requestAnimationFrame`, and differs per device — so if the
 * simulation could hear it, a replay would diverge on some hardware and not on
 * others, which is the worst kind of bug this project can have.
 *
 * Because of that, audio is NON-NORMATIVE. The number of samples this file
 * produces, the quantisation of register updates to render quanta, whether the
 * device runs at 44100 or 48000 — none of it can move a frame hash.
 *
 * ===========================================================================
 * HOW THE WORKLET STAYS IN SYNC WITH `renderAudio`
 * ===========================================================================
 * An AudioWorklet is a separate realm loaded from a URL, so its code has to
 * arrive as text. The obvious way to do that is to transcribe the synth into a
 * template literal, and the obvious way is wrong: two copies of an oscillator
 * drift, and the drift is silent.
 *
 * So nothing is transcribed. `buildWorkletSource()` assembles the module out of
 * `Function.prototype.toString()` of the REAL functions:
 *
 *     createSynthState   from @sq1/runtime  — the synth's state
 *     renderAudio        from @sq1/runtime  — the synth itself
 *     createRegisterRing from this file     — the frame buffer
 *     createMixerCore    from this file     — pacing and starvation
 *
 * There is one implementation of each in the repository and the worklet is
 * literally made of it. The price is a rule those four functions must keep:
 * **they may not name anything outside themselves** except each other, because
 * a free variable serialises into a `ReferenceError` in the other realm. That is
 * why `createMixerCore` takes its collaborators as a `deps` argument instead of
 * closing over the imports, and why `audio-graph.test.ts` evaluates the whole
 * assembled source — processor class included — and demands sample-for-sample
 * agreement with the main-thread objects.
 *
 * The only code here that is genuinely worklet-only is the ~15-line
 * `AudioWorkletProcessor` subclass, which cannot exist outside a worklet realm
 * and therefore cannot be shared with one. It is glue, it holds no DSP, and the
 * test above executes it against a stand-in base class.
 *
 * ===========================================================================
 * AUTOPLAY, HONESTLY
 * ===========================================================================
 * Browsers refuse to start an `AudioContext` outside a user gesture, and the
 * refusal is quiet: `resume()` resolves, `state` stays "suspended", and the
 * page plays nothing while looking fine. `start()` therefore resolves only when
 * `ctx.state === "running"` and rejects otherwise, and `state` reports
 * "suspended" rather than "running" so a shell can say so on screen. A graph
 * that says it is playing while it is not is worse than one that admits it.
 *
 * ===========================================================================
 * STARVATION
 * ===========================================================================
 * If the simulation stalls, the worklet does not stall with it: it keeps
 * rendering the registers it last received, so a held note holds and a released
 * one finishes its release. It never asks for more, never blocks, and never
 * lets the audio clock become the frame clock. If the simulation instead runs
 * ahead, the ring drops its oldest frame rather than growing latency — a
 * dropped frame of registers is a missed note, and unbounded latency is every
 * note late forever.
 */

import {
  AUDIO_REGS_BYTES,
  createSynthState,
  renderAudio,
  type SynthState,
} from "../../runtime/src/audio";

/** The name the worklet registers itself under. */
export const PROCESSOR_NAME = "square-one-synth";

/** Register frames the ring holds before it starts dropping the oldest. */
export const DEFAULT_RING_DEPTH = 4;

/** How many register frames the mixer expects per second of audio. */
export const DEFAULT_FRAME_HZ = 60;

// ---------------------------------------------------------------------------
// The two pieces that are serialised into the worklet realm along with the
// runtime's synth. CLOSURE-FREE: they may name nothing but their own
// parameters, their own locals, and each other.
// ---------------------------------------------------------------------------

/** A bounded queue of register frames, preallocated, with no allocation in use. */
export interface RegisterRing {
  /** The frame the mixer is rendering right now. Survives starvation. */
  readonly current: Uint8Array;
  /** Frames waiting to be taken. */
  readonly pending: number;
  /** How many times `advance()` found the queue empty and repeated itself. */
  readonly starved: number;
  /** How many frames were dropped because the simulation ran ahead. */
  readonly dropped: number;
  push(src: Uint8Array): void;
  advance(): void;
}

/**
 * Build a register ring of `capacity` frames of `bytes` bytes.
 *
 * CLOSURE-FREE: serialised into the AudioWorklet realm verbatim.
 */
export function createRegisterRing(capacity: number, bytes: number): RegisterRing {
  const cap = capacity > 0 ? capacity | 0 : 1;
  const size = bytes > 0 ? bytes | 0 : 1;
  const slots: Uint8Array[] = [];
  for (let i = 0; i < cap; i++) slots.push(new Uint8Array(size));
  const current = new Uint8Array(size);
  let head = 0;
  let tail = 0;
  let count = 0;
  let starvedCount = 0;
  let droppedCount = 0;

  return {
    current,
    get pending(): number {
      return count;
    },
    get starved(): number {
      return starvedCount;
    },
    get dropped(): number {
      return droppedCount;
    },
    push(src: Uint8Array): void {
      const dst = slots[head] as Uint8Array;
      const n = src.length < size ? src.length : size;
      for (let i = 0; i < n; i++) dst[i] = src[i] as number;
      for (let i = n; i < size; i++) dst[i] = 0;
      head = head + 1 === cap ? 0 : head + 1;
      if (count === cap) {
        // The oldest frame has just been overwritten: a late frame of registers
        // is worth less than the latency of keeping it.
        tail = tail + 1 === cap ? 0 : tail + 1;
        droppedCount++;
      } else {
        count++;
      }
    },
    advance(): void {
      if (count === 0) {
        // Starved. Keep the last registers: the note holds, the envelope keeps
        // running, and nothing upstream is asked for anything.
        starvedCount++;
        return;
      }
      current.set(slots[tail] as Uint8Array);
      tail = tail + 1 === cap ? 0 : tail + 1;
      count--;
    },
  };
}

/** The synth pieces `createMixerCore` needs, injected so it stays closure-free. */
export interface SynthDeps {
  createSynthState: () => SynthState;
  renderAudio: (regs: Uint8Array, state: SynthState, out: Float32Array, sampleRate: number) => void;
  createRegisterRing: (capacity: number, bytes: number) => RegisterRing;
}

/** Everything the audio callback does, with no audio API in sight. */
export interface MixerCore {
  push(regs: Uint8Array): void;
  /** Fill one render quantum. Allocates nothing. */
  render(out: Float32Array): void;
  readonly pending: number;
  readonly starved: number;
  readonly dropped: number;
}

/**
 * The mixer: a ring of register frames, one synth state, and the pacing rule.
 *
 * A whole render quantum is rendered from a single frame of registers. At 48 kHz
 * a quantum is 128 samples — 2.7 ms — against a 16.7 ms frame, so a register
 * write lands at most one quantum late. That quantisation is inaudible, it is
 * non-normative, and it buys the callback a body with no subarrays in it: a
 * `subarray` is an allocation, and an allocation in an audio callback is a click.
 *
 * CLOSURE-FREE: serialised into the AudioWorklet realm verbatim, which is why
 * the synth arrives as `deps` rather than as an import.
 */
export function createMixerCore(
  deps: SynthDeps,
  sampleRate: number,
  regBytes: number,
  framesPerSecond: number,
  depth: number,
): MixerCore {
  const sr = sampleRate > 0 ? sampleRate : 44100;
  const fps = framesPerSecond > 0 ? framesPerSecond : 60;
  const samplesPerFrame = sr / fps;
  const ring = deps.createRegisterRing(depth > 0 ? depth : 4, regBytes);
  const state = deps.createSynthState();
  // Primed, so the very first callback takes the frame that is waiting instead
  // of opening with a frame's worth of silence.
  let acc = samplesPerFrame;

  return {
    push(regs: Uint8Array): void {
      ring.push(regs);
    },
    render(out: Float32Array): void {
      acc += out.length;
      if (acc >= samplesPerFrame) {
        acc -= samplesPerFrame;
        // Never carry a whole frame of debt. If the callback has been starved
        // of CPU, catching up by racing through the queue would replay the song
        // at the wrong speed; forgetting the debt keeps it in time and costs
        // only the frames that were already too late to matter.
        if (acc >= samplesPerFrame) acc = 0;
        ring.advance();
      }
      deps.renderAudio(ring.current, state, out, sr);
    },
    get pending(): number {
      return ring.pending;
    },
    get starved(): number {
      return ring.starved;
    },
    get dropped(): number {
      return ring.dropped;
    },
  };
}

/**
 * Assemble the worklet module's source text.
 *
 * Everything but the processor class is the real function, serialised. See the
 * file header for why, and `audio-graph.test.ts` for the test that keeps it
 * true.
 */
export function buildWorkletSource(
  regBytes: number = AUDIO_REGS_BYTES,
  framesPerSecond: number = DEFAULT_FRAME_HZ,
  depth: number = DEFAULT_RING_DEPTH,
): string {
  return [
    "'use strict';",
    createSynthState.toString(),
    renderAudio.toString(),
    createRegisterRing.toString(),
    createMixerCore.toString(),
    "class SquareOneProcessor extends AudioWorkletProcessor {",
    "  constructor() {",
    "    super();",
    "    this.core = createMixerCore(",
    "      { createSynthState: createSynthState, renderAudio: renderAudio,",
    "        createRegisterRing: createRegisterRing },",
    `      sampleRate, ${regBytes | 0}, ${framesPerSecond | 0}, ${depth | 0});`,
    "    this.port.onmessage = (e) => { this.core.push(e.data); };",
    "  }",
    "  process(inputs, outputs) {",
    "    const out = outputs[0];",
    "    if (!out || out.length === 0) return true;",
    "    const mono = out[0];",
    "    this.core.render(mono);",
    "    for (let c = 1; c < out.length; c++) out[c].set(mono);",
    // ALWAYS true. Returning false lets the browser garbage-collect the node,
    // and a mixer that stops existing because the cart happened to be silent is
    // a mixer that never comes back.
    "    return true;",
    "  }",
    "}",
    `registerProcessor(${JSON.stringify(PROCESSOR_NAME)}, SquareOneProcessor);`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// The main-thread graph.
// ---------------------------------------------------------------------------

/**
 * What the graph is actually doing, as opposed to what it was asked to do.
 *
 * "suspended" is the autoplay case: a context exists, the worklet is loaded,
 * and the browser is refusing to run it until a user gesture arrives.
 */
export type AudioGraphState = "stopped" | "starting" | "suspended" | "running";

export interface AudioGraph {
  /** Must be called from a user gesture. Resolves only when truly running. */
  start(): Promise<void>;
  stop(): void;
  /** One frame's audio registers. Never blocks, never fails, never answers. */
  push(regs: Uint8Array): void;
  readonly running: boolean;
  readonly sampleRate: number;
  /** The honest state, including "suspended". */
  readonly state: AudioGraphState;
}

type AudioContextCtor = new (options?: AudioContextOptions) => AudioContext;
type WorkletNodeCtor = new (
  ctx: BaseAudioContext,
  name: string,
  options?: AudioWorkletNodeOptions,
) => AudioWorkletNode;

function globalCtor<T>(...names: string[]): T | null {
  const g = globalThis as unknown as Record<string, unknown>;
  for (const n of names) {
    const c = g[n];
    if (typeof c === "function") return c as T;
  }
  return null;
}

/**
 * A URL the worklet loader will accept.
 *
 * A blob URL is the right answer and is what every browser gets. The data-URL
 * fallback exists for environments without `URL.createObjectURL`; some content
 * security policies reject it, which is a better failure than no sound and no
 * message.
 */
function moduleUrl(source: string): { url: string; revoke: () => void } {
  const u = globalThis.URL as unknown as {
    createObjectURL?: (b: Blob) => string;
    revokeObjectURL?: (u: string) => void;
  };
  if (typeof u?.createObjectURL === "function" && typeof globalThis.Blob === "function") {
    const url = u.createObjectURL(new Blob([source], { type: "text/javascript" }));
    return {
      url,
      revoke: () => {
        if (typeof u.revokeObjectURL === "function") u.revokeObjectURL(url);
      },
    };
  }
  return {
    url: `data:text/javascript,${encodeURIComponent(source)}`,
    revoke: () => {},
  };
}

export function createAudioGraph(opts?: { sampleRate?: number }): AudioGraph {
  const requested = opts?.sampleRate !== undefined && opts.sampleRate > 0 ? opts.sampleRate : 0;

  let ctx: AudioContext | null = null;
  let node: AudioWorkletNode | null = null;
  let revoke: (() => void) | null = null;
  let phase: AudioGraphState = "stopped";
  let starting: Promise<void> | null = null;

  /**
   * The last registers the simulation pushed.
   *
   * Reused on every push so the main thread allocates nothing per frame:
   * `postMessage` copies synchronously, so handing it the same array every time
   * is safe. The worklet side does allocate one 80-byte clone per frame, which
   * is what a MessagePort costs and is the reason the ring copies it out and
   * drops the reference immediately.
   */
  const latest = new Uint8Array(AUDIO_REGS_BYTES);
  let everPushed = false;

  function teardown(): void {
    if (node !== null) {
      try {
        node.disconnect();
      } catch {
        // A node on a closed context throws here on some engines. Nothing to do.
      }
      node = null;
    }
    if (ctx !== null) {
      void ctx.close().catch(() => {});
      ctx = null;
    }
    if (revoke !== null) {
      revoke();
      revoke = null;
    }
  }

  async function begin(): Promise<void> {
    const Ctx = globalCtor<AudioContextCtor>("AudioContext", "webkitAudioContext");
    const Node = globalCtor<WorkletNodeCtor>("AudioWorkletNode");
    if (Ctx === null || Node === null) {
      phase = "stopped";
      throw new Error("audio-graph: this environment has no AudioWorklet");
    }

    try {
      if (ctx === null) {
        ctx = requested > 0 ? new Ctx({ sampleRate: requested }) : new Ctx();
        const m = moduleUrl(buildWorkletSource());
        revoke = m.revoke;
        await ctx.audioWorklet.addModule(m.url);
        node = new Node(ctx, PROCESSOR_NAME, {
          numberOfInputs: 0,
          numberOfOutputs: 1,
          outputChannelCount: [1],
        });
        node.connect(ctx.destination);
      }

      await ctx.resume();
    } catch (e) {
      teardown();
      phase = "stopped";
      throw e;
    }

    if (ctx.state !== "running") {
      // Autoplay policy. The context and the worklet are kept: a later start()
      // from a real gesture is then a single resume() away.
      phase = "suspended";
      throw new Error(
        "audio-graph: the AudioContext is suspended. start() must be called from a user gesture.",
      );
    }

    phase = "running";
    // Begin from the registers as they are now rather than from silence.
    if (everPushed && node !== null) node.port.postMessage(latest);
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

    push(regs: Uint8Array): void {
      const n = regs.length < AUDIO_REGS_BYTES ? regs.length : AUDIO_REGS_BYTES;
      for (let i = 0; i < n; i++) latest[i] = regs[i] as number;
      for (let i = n; i < AUDIO_REGS_BYTES; i++) latest[i] = 0;
      everPushed = true;
      // While stopped or suspended the frame is simply remembered. The
      // simulation is never told and never waits: it owns the clock.
      if (phase === "running" && node !== null) node.port.postMessage(latest);
    },

    get running(): boolean {
      return phase === "running";
    },

    get sampleRate(): number {
      return ctx !== null ? ctx.sampleRate : requested;
    },

    get state(): AudioGraphState {
      return phase;
    },
  };
}
