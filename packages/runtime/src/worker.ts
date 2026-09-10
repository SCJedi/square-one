/**
 * The worker side of the protocol: turn `ToWorker` messages into machine calls.
 *
 * The message handling is a plain function over a plain machine, built by
 * `createMessageHandler`, and knows nothing about `self`, `postMessage` or
 * Worker at all. That is what makes it testable without a real Worker, and it is
 * also what lets the host run the identical logic in-process (see
 * `inProcessChannel` in host.ts). One code path drives the machine whether the
 * run is threaded or not, so an in-process conformance run and a browser one
 * cannot disagree because of the plumbing.
 *
 * `installWorker` is the thin wiring on top, and it is a function you call
 * rather than a side effect of importing this module. Importing must stay inert
 * because this file is pulled in by the package barrel, which the CLI, the tests
 * and the host all load in Node where there is no `self` to attach to. The
 * bootstrap that a real Worker starts from is three lines and belongs to
 * whoever assembles the worker bundle, because it is the only place that
 * decides which machine gets built:
 *
 *     import { installWorker } from "@sq1/runtime";
 *     import { Machine } from "@sq1/runtime";
 *     installWorker(() => new Machine(cart));
 *
 * FAULTS ARE TERMINAL. Every catch below drops the machine reference. A tick
 * that threw halfway leaves memory in a state no cart author ever wrote and no
 * replay can reproduce; continuing from it would turn a crash into a silent
 * desync, which is strictly worse. The host reloads or gives up.
 */

import { AUDIO_REGS_BYTES, readAudioRegs } from "./audio";
import type { FromWorker, ToWorker } from "./protocol";
import type { MachineLike } from "./host";

/** How the handler emits a reply. `transfer` moves buffers instead of copying them. */
export type PostFn = (m: FromWorker, transfer?: Transferable[]) => void;

/** Builds the machine a `load` message asks for. */
export type MachineFactory = () => MachineLike;

/**
 * Wall clock, for the diagnostic `tookMs` field only.
 *
 * Nothing this returns ever reaches the machine. A timing value is the one
 * quantity guaranteed to differ between two runs of the same cart, so it is
 * kept strictly on the reporting side of the boundary.
 */
const now: () => number =
  typeof performance !== "undefined" && typeof performance.now === "function"
    ? () => performance.now()
    : () => Date.now();

/**
 * Message of a thrown value, without assuming it is an Error.
 *
 * `Error.prototype.stack` is not standardised, and the engines genuinely differ:
 * V8 prefixes it with "Name: message", SpiderMonkey emits frames only. Returning
 * the raw stack therefore looks correct on Node and Chrome while giving every
 * Firefox user a fault report that says where it broke and never what broke.
 *
 * So always lead with the message, and append the stack only when it is not
 * already carrying it. Caught by the cross-engine conformance run, which is what
 * that job exists for.
 */
function errMsg(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  const head = `${e.name}: ${e.message}`;
  const stack = e.stack;
  if (stack === undefined || stack === "") return head;
  return stack.startsWith(e.name) ? stack : `${head}\n${stack}`;
}

/**
 * Build the worker's message handler.
 *
 * The returned function is synchronous and total: every message produces
 * exactly one reply, including the failures. A message that produced no reply
 * would strand the host, which is waiting on one.
 */
export function createMessageHandler(factory: MachineFactory, post: PostFn): (m: ToWorker) => void {
  let machine: MachineLike | null = null;

  /**
   * The audio register block that rides out on every `frame`, allocated once.
   *
   * Reused rather than freshly allocated because the step path may not allocate
   * -- a collection pause inside a frame is a dropped frame -- and reusing it is
   * safe for the same reason `audio-graph.ts` reuses its own: `postMessage`
   * copies synchronously, so by the time this function returns the receiver
   * already has its own bytes and nothing points here.
   */
  const audio = new Uint8Array(AUDIO_REGS_BYTES);

  return (m: ToWorker): void => {
    switch (m.t) {
      case "load": {
        try {
          machine = factory();
        } catch (e) {
          machine = null;
          post({ t: "fault", phase: "load", message: errMsg(e) });
          return;
        }
        try {
          machine.boot(m.seed);
        } catch (e) {
          machine = null;
          post({ t: "fault", phase: "boot", message: errMsg(e) });
          return;
        }
        post({ t: "ready" });
        return;
      }

      case "step": {
        if (machine === null) {
          post({ t: "fault", phase: "tick", frame: m.frame, message: "step before load" });
          return;
        }
        const t0 = now();
        try {
          machine.tick(m.input);
          machine.present();
        } catch (e) {
          machine = null;
          post({ t: "fault", phase: "tick", frame: m.frame, message: errMsg(e) });
          return;
        }
        const pixels = machine.rgba;
        if (m.out.byteLength !== pixels.length * 4) {
          machine = null;
          post({
            t: "fault",
            phase: "tick",
            frame: m.frame,
            message: `out buffer is ${m.out.byteLength} bytes, machine presents ${pixels.length * 4}`,
          });
          return;
        }
        new Uint32Array(m.out).set(pixels);
        // AFTER the tick, so the registers are the ones this frame's `snd`
        // calls and this frame's sequencer left behind. Reading before would
        // hand the mixer the previous frame's sound, one frame late, forever.
        readAudioRegs(machine.ram, audio);
        post({ t: "frame", frame: m.frame, out: m.out, tookMs: now() - t0, audio }, [m.out]);
        return;
      }

      case "snapshot": {
        if (machine === null) {
          post({ t: "fault", phase: "load", message: "snapshot before load" });
          return;
        }
        try {
          // Copy before transferring. `snapshot()` may hand back a view onto
          // live machine memory, and transferring that would detach the RAM the
          // machine is still running on.
          const copy = machine.snapshot().slice();
          post({ t: "snapshot", ram: copy.buffer as ArrayBuffer }, [copy.buffer as ArrayBuffer]);
        } catch (e) {
          machine = null;
          post({ t: "fault", phase: "tick", message: errMsg(e) });
        }
        return;
      }

      case "restore": {
        try {
          if (machine === null) machine = factory();
          machine.restore(new Uint8Array(m.ram));
        } catch (e) {
          machine = null;
          post({ t: "fault", phase: "load", message: errMsg(e) });
          return;
        }
        post({ t: "ready" });
        return;
      }

      default: {
        const never: never = m;
        post({ t: "fault", phase: "load", message: `unknown message ${JSON.stringify(never)}` });
        return;
      }
    }
  };
}

/**
 * The bits of a worker global this module needs, named structurally so nothing
 * here depends on the DOM lib being present.
 */
export interface WorkerScope {
  onmessage: ((e: { data: ToWorker }) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
}

/**
 * Is `g` a dedicated worker global scope?
 *
 * Duck-typed rather than an `instanceof DedicatedWorkerGlobalScope`, for two
 * reasons: that constructor is declared by the WebWorker lib, which this package
 * does not compile against, and naming it at all would be a ReferenceError in
 * Node, where this predicate has to be safe to call from a test. The shape it
 * checks for -- a `postMessage` and no `window` -- is what actually
 * distinguishes a worker global from the main thread.
 */
export function isWorkerScope(g: unknown): g is WorkerScope {
  if (g === null || typeof g !== "object") return false;
  const o = g as Record<string, unknown>;
  if (typeof o["postMessage"] !== "function") return false;
  if (!("onmessage" in o)) return false;
  // A `window` means the browser main thread, which also has postMessage.
  return typeof (globalThis as Record<string, unknown>)["window"] === "undefined";
}

/**
 * Wire `scope.onmessage` (default: the global scope) to a handler built from
 * `factory`.
 *
 * Returns false and changes nothing when there is no worker scope to attach to,
 * so calling it unconditionally from a bundle that also loads in Node is safe.
 */
export function installWorker(factory: MachineFactory, scope?: WorkerScope): boolean {
  const target = scope ?? (isWorkerScope(globalThis) ? (globalThis as unknown as WorkerScope) : null);
  if (target === null) return false;
  const handler = createMessageHandler(factory, (m, transfer) => {
    if (transfer !== undefined && transfer.length > 0) target.postMessage(m, transfer);
    else target.postMessage(m);
  });
  target.onmessage = (e: { data: ToWorker }) => handler(e.data);
  return true;
}
