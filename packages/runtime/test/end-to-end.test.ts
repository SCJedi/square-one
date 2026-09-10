/**
 * THE SEAM, END TO END: a real cart file, a real machine, a real hardened worker.
 *
 * Every piece of Square One was tested before this file existed and no test
 * joined them. `sq1 build` wrote `.cart` files that nothing in the repository
 * could open; `compileCart` ran source strings that never came from a container;
 * `scrubRealm` was proved against a real worker global that was never serving a
 * cart file. The milestone claim -- "hand-written JavaScript carts now run" --
 * was true of source text in test files and had never been demonstrated of a
 * cart.
 *
 * Two tests, and neither stubs anything:
 *
 *   (a) THE REAL FILE. `examples/hello/main.js`, the example the documentation
 *       tells an author to copy, packed into real cart bytes with the real
 *       encoder, opened by `loadCartBytes`, and run for 60 frames on a real
 *       machine. If the example does not run, the documented contract is wrong
 *       and this test says which half.
 *
 *   (b) THE REAL WORKER, HARDENED. The same cart bytes handed to
 *       `startCartWorker` inside a real `node:worker_threads` Worker with
 *       scrubbing ON, driven through the real `load`/`step`/`snapshot`
 *       protocol, and its pixels compared with the in-process run. A cart that
 *       runs correctly in a hardened worker is the claim this milestone was
 *       supposed to establish; nothing before this file established it.
 *
 * HOW THE SOURCE ARRIVES. Through Vite's `?raw`, the way golden.test.ts loads
 * its fixture, so this file needs no filesystem and takes the same code path in
 * Node and in a browser. A harness that branched on platform could not tell
 * "the machine diverged" from "the harness diverged".
 *
 * HOW THE WORKER GETS THE REAL RUNTIME. `packages/runtime/src/index.ts` bundled
 * by esbuild at test time, exactly as scrub-realm.test.ts does it -- one
 * approach, not two. The bytes in the worker are the bytes in `src/`, with the
 * types stripped and the imports resolved, and nothing else.
 */

import { describe, expect, it } from "vitest";

import {
  MAX_CART_BYTES,
  SPEC_MAJOR,
  SPEC_MINOR,
  defaultMeta,
  encode,
  encodeMeta,
  encodeUtf8,
} from "@sq1/cart";
import type { CartFile } from "@sq1/cart";

import { createMachine } from "../src/machine";
import type { Machine } from "../src/machine";
import { loadCartBytes } from "../src/load";
import type { LoadError } from "../src/load";
import type { ScrubReport } from "../src/sandbox";

import helloSource from "../../../examples/hello/main.js?raw";

const inNode = typeof process !== "undefined" && process.versions?.node !== undefined;

const FRAMES = 60;
const SEED = 4242;
const SCREEN_PIXELS = 128 * 128;
const RGBA_BYTES = SCREEN_PIXELS * 4;

/**
 * The title and author from `examples/hello/cart.json`.
 *
 * Repeated here rather than read, because a browser has no filesystem and
 * because the point of the test is the CODE chunk. If these drift from
 * cart.json the cart still loads; nothing downstream depends on them.
 */
const HELLO_TITLE = "Hello";
const HELLO_AUTHOR = "square one";

/**
 * Pack source into cart bytes exactly as `sq1 build` does: META then CODE,
 * through the same `encodeMeta` and `encode`.
 */
function buildHelloCart(): Uint8Array {
  const code = encodeUtf8(helloSource);
  expect(code, "examples/hello/main.js is not encodable as UTF-8").not.toBeNull();
  const cart: CartFile = {
    specMajor: SPEC_MAJOR,
    specMinor: SPEC_MINOR,
    chunks: [
      { type: "META", data: encodeMeta(defaultMeta(HELLO_TITLE, HELLO_AUTHOR)) },
      { type: "CODE", data: code as Uint8Array },
    ],
  };
  return encode(cart);
}

/**
 * One frame's input bytes, derived from the frame number and nothing else.
 *
 * A deterministic pattern rather than an empty one: `examples/hello` steers on
 * held LEFT/RIGHT and recolours on a fresh press of A, so a run with no input
 * would exercise neither `btn` nor `btnp` and would agree between two engines
 * for reasons that have nothing to do with the input path.
 */
function inputAt(frame: number): Uint8Array {
  const bytes = new Uint8Array(4);
  bytes[0] = (frame * 37 + 11) & 0x3f;
  return bytes;
}

/** Run a loaded program for `frames` frames and report everything observable. */
function runInProcess(machine: Machine, frames: number): {
  rgba: Uint32Array;
  ram: Uint8Array;
} {
  machine.boot(SEED);
  for (let f = 0; f < frames; f++) {
    machine.tick(inputAt(f));
    machine.present();
  }
  return { rgba: machine.rgba.slice(), ram: machine.snapshot() };
}

/** True when the framebuffer holds more than one colour: something was drawn. */
function isBlank(rgba: Uint32Array): boolean {
  const first = rgba[0];
  for (let i = 1; i < rgba.length; i++) {
    if (rgba[i] !== first) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// (a) The real file
// ---------------------------------------------------------------------------

describe("end to end: examples/hello, from cart bytes to pixels", () => {
  it("is the example the documentation describes", () => {
    // A cheap guard on the fixture itself. If `?raw` ever resolves to something
    // else -- a transformed module, an empty string, the wrong file -- every
    // assertion below would be about the wrong bytes.
    expect(helloSource.length).toBeGreaterThan(1000);
    expect(helloSource).toContain("function boot()");
    expect(helloSource).toContain("function tick()");
  });

  it("packs into a cart the container accepts and the budget allows", () => {
    const bytes = buildHelloCart();
    expect(bytes.length).toBeLessThanOrEqual(MAX_CART_BYTES);
    // "SQ1C", the four bytes every cart begins with.
    expect(Array.from(bytes.slice(0, 4))).toEqual([0x53, 0x51, 0x31, 0x43]);
  });

  it("LOADS FROM CART BYTES AND DRAWS", () => {
    // The assertion this whole task exists for: a cart FILE, opened by the
    // runtime, running on the machine.
    const result = loadCartBytes(buildHelloCart());
    expect(result.ok, result.ok ? "" : `${result.error.code}: ${result.error.message}`).toBe(true);
    if (!result.ok) return;

    expect(result.meta.title).toBe(HELLO_TITLE);
    expect(result.meta.author).toBe(HELLO_AUTHOR);
    expect(result.meta.payload).toBe("script/js1");
    expect(result.tokens).toBeGreaterThan(100);

    const run = runInProcess(createMachine(result.program), FRAMES);

    // NOT BLANK. A cart that compiled, booted, ticked 60 times and drew nothing
    // would pass every other test in this repository.
    expect(isBlank(run.rgba)).toBe(false);
    expect(new Set(run.rgba).size).toBeGreaterThan(2);

    // The example's own state, at the addresses its source names. The block
    // starts at (58, 40) and moves one pixel per frame, so after 60 frames it
    // has bounced off the bottom of its 84-pixel field at least once.
    const USER_RAM = 0x7800;
    expect(run.ram[USER_RAM + 0]).toBeGreaterThan(0); // X
    expect(run.ram[USER_RAM + 1]).toBeGreaterThan(0); // Y
    expect(run.ram[USER_RAM + 4]).toBeGreaterThan(0); // COLOR
  });

  it("is reproducible: the same cart bytes twice give the same bytes", () => {
    // Two independent loads of two independently encoded copies. Same pixels,
    // same RAM, or the console is not deterministic and nothing else it claims
    // means anything.
    const first = loadCartBytes(buildHelloCart());
    const second = loadCartBytes(buildHelloCart());
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    const a = runInProcess(createMachine(first.program), FRAMES);
    const b = runInProcess(createMachine(second.program), FRAMES);

    expect(Array.from(a.rgba)).toEqual(Array.from(b.rgba));
    expect(Array.from(a.ram)).toEqual(Array.from(b.ram));
  });

  it("would notice a divergence: changed input changes the pixels and the RAM", () => {
    // Guard the guard. A reproducibility test that passes no matter what the
    // machine does reads as coverage and is worse than nothing.
    //
    // The tampering has to be a change this cart can actually observe. Flipping
    // one bit is not enough: `examples/hello` reads RIGHT after LEFT, so on a
    // frame where both are held, clearing both leaves `dx` exactly where it
    // was and the run is bit-identical -- correctly. Holding LEFT alone for
    // twenty frames reverses the block, which nothing can absorb.
    const machine = createMachine(loadOrThrow());
    machine.boot(SEED);
    for (let f = 0; f < FRAMES; f++) {
      const input = inputAt(f);
      if (f >= 10 && f < 30) input[0] = 0x04; // LEFT, held, alone
      machine.tick(input);
      machine.present();
    }

    const straight = runInProcess(createMachine(loadOrThrow()), FRAMES);
    expect(Array.from(machine.ram)).not.toEqual(Array.from(straight.ram));
    expect(Array.from(machine.rgba)).not.toEqual(Array.from(straight.rgba));
  });
});

/** The hello program, or a failure that names why. Used where `ok` is not the subject. */
function loadOrThrow() {
  const result = loadCartBytes(buildHelloCart());
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.program;
}

// ---------------------------------------------------------------------------
// (b) The real worker, hardened
// ---------------------------------------------------------------------------

/** The bootstrap's own report, sent back before any protocol message. */
interface BootstrapMessage {
  t: "bootstrap";
  installed: boolean;
  scrub: ScrubReport | null;
  error: LoadError | null;
  threw: string | null;
  after: {
    hasFunction: string;
    hasEval: string;
    hasProcess: string;
    onmessageInstalled: boolean;
  };
}

/**
 * The worker's program, appended to the bundled runtime.
 *
 * ES5-ish and free of template literals, because it lives inside one.
 *
 * WHAT THE FIRST TEN LINES ARE FOR. `installWorker` attaches to a DEDICATED
 * WORKER GLOBAL, which it recognises by `postMessage` + `onmessage` + no
 * `window`. A `node:worker_threads` global has none of that -- it talks through
 * `parentPort` -- so this harness gives it the two names and bridges them to the
 * port. That is the whole adaptation: `startCartWorker(bytes)` is then called
 * with no options at all, exactly as a browser bootstrap calls it, and takes
 * exactly the path a player takes. Both names are set BEFORE the scrub;
 * `postMessage` is in REALM_KEEP and `onmessage` is not a scrubbed name, so the
 * bridge survives the hardening it is about to witness.
 */
const HARNESS = `
;(function () {
  var wt = require("node:worker_threads");
  var parentPort = wt.parentPort;
  var workerData = wt.workerData;
  var G = globalThis;

  function describe(e) {
    if (e && typeof e === "object" && typeof e.name === "string") return e.name + ": " + e.message;
    return String(e);
  }

  function send(m, transfer) {
    if (transfer && transfer.length > 0) parentPort.postMessage(m, transfer);
    else parentPort.postMessage(m);
  }

  G.postMessage = function (m, transfer) { send(m, transfer); };
  G.onmessage = null;

  parentPort.on("message", function (m) {
    var handler = G.onmessage;
    if (typeof handler !== "function") {
      send({ t: "no-handler", saw: m && m.t });
      return;
    }
    handler({ data: m });
  });

  var bytes = new Uint8Array(workerData.cart);
  var result = null;
  var threw = null;
  try {
    // THE LINE THIS FILE EXISTS FOR: cart bytes in, hardened serving worker out.
    result = SQ1.startCartWorker(bytes);
  } catch (e) {
    threw = describe(e);
  }

  send({
    t: "bootstrap",
    installed: result === null ? false : result.installed,
    scrub: result === null ? null : result.scrub,
    error: result === null ? null : result.error,
    threw: threw,
    after: {
      hasFunction: typeof G.Function,
      hasEval: typeof G.eval,
      hasProcess: typeof G.process,
      onmessageInstalled: typeof G.onmessage === "function"
    }
  });
})();
`;

/** The bundled runtime, built once and reused. Same recipe as scrub-realm.test.ts. */
let bundling: Promise<string> | null = null;

async function getBundle(): Promise<string> {
  if (bundling === null) {
    bundling = (async (): Promise<string> => {
      const esbuild = await import("esbuild");
      const { fileURLToPath } = await import("node:url");
      const built = await esbuild.build({
        entryPoints: [fileURLToPath(new URL("../src/index.ts", import.meta.url))],
        bundle: true,
        format: "iife",
        globalName: "SQ1",
        platform: "node",
        target: "node20",
        write: false,
      });
      const text = built.outputFiles?.[0]?.text ?? "";
      if (text.length < 1000) throw new Error("the runtime did not bundle");
      return `${text}\n`;
    })();
  }
  return bundling;
}

/** How long any single reply may take before the run is declared stuck. */
const REPLY_TIMEOUT_MS = 20_000;

/**
 * A worker plus an inbox, so a test can `await next()` one message at a time.
 *
 * A dead worker rejects rather than hangs: a protocol test that hangs tells you
 * only that something is wrong, and the vitest timeout that eventually stops it
 * names the test rather than the message that never came.
 */
interface Driven {
  next(): Promise<Record<string, unknown>>;
  post(msg: unknown, transfer?: ArrayBuffer[]): void;
  stop(): Promise<void>;
}

async function driveWorker(cart: Uint8Array): Promise<Driven> {
  const { Worker } = await import("node:worker_threads");
  const w = new Worker((await getBundle()) + HARNESS, {
    eval: true,
    workerData: { cart },
  });

  const queue: Record<string, unknown>[] = [];
  let waiting: ((m: Record<string, unknown>) => void) | null = null;
  let failure: Error | null = null;
  let failWaiter: ((e: Error) => void) | null = null;

  const die = (e: Error): void => {
    failure = e;
    const f = failWaiter;
    failWaiter = null;
    waiting = null;
    if (f !== null) f(e);
  };

  w.on("message", (m: Record<string, unknown>) => {
    const f = waiting;
    if (f !== null) {
      waiting = null;
      failWaiter = null;
      f(m);
    } else {
      queue.push(m);
    }
  });
  w.on("error", (e: Error) => die(e));
  w.on("exit", (code: number) => {
    if (code !== 0) die(new Error(`worker exited with ${code}`));
  });

  return {
    next(): Promise<Record<string, unknown>> {
      const queued = queue.shift();
      if (queued !== undefined) return Promise.resolve(queued);
      if (failure !== null) return Promise.reject(failure);
      return new Promise<Record<string, unknown>>((resolve, reject) => {
        waiting = resolve;
        failWaiter = reject;
        setTimeout(() => {
          if (waiting !== null) {
            waiting = null;
            failWaiter = null;
            reject(new Error(`the worker sent nothing for ${REPLY_TIMEOUT_MS} ms`));
          }
        }, REPLY_TIMEOUT_MS).unref?.();
      });
    },
    post(msg: unknown, transfer?: ArrayBuffer[]): void {
      if (transfer !== undefined && transfer.length > 0) w.postMessage(msg, transfer);
      else w.postMessage(msg);
    },
    async stop(): Promise<void> {
      await w.terminate();
    },
  };
}

describe.skipIf(!inNode)("end to end: examples/hello in a REAL HARDENED WORKER", () => {
  it("loads a cart file, hardens the realm, and serves frames that match in-process", async () => {
    const cart = buildHelloCart();

    // The in-process reference. Same bytes, same loader, same seed, same input
    // pattern -- and an UNSCRUBBED realm, because `scrubRealm` cannot run in
    // the test runner's own realm without breaking the runner.
    const reference = loadCartBytes(cart);
    expect(reference.ok, reference.ok ? "" : reference.error.message).toBe(true);
    if (!reference.ok) return;
    const here = runInProcess(createMachine(reference.program), FRAMES);

    const worker = await driveWorker(cart);
    try {
      // --- the bootstrap ----------------------------------------------------
      const boot = (await worker.next()) as unknown as BootstrapMessage;
      expect(boot.t).toBe("bootstrap");
      expect(boot.threw, "startCartWorker threw during its own bootstrap").toBeNull();
      expect(boot.error, `the cart did not load: ${JSON.stringify(boot.error)}`).toBeNull();
      expect(boot.installed, "the bootstrap did not attach a message loop").toBe(true);
      expect(boot.after.onmessageInstalled).toBe(true);

      // THE SCRUB REPORT IS A DELIVERABLE. Printed so a reader of the run can
      // see that the realm this cart ran in was actually hardened, rather than
      // taking a green tick for it.
      const scrub = boot.scrub;
      expect(scrub, "scrubbing is on by default and this worker reported none").not.toBeNull();
      if (scrub === null) return;
      // eslint-disable-next-line no-console
      console.log(
        "startCartWorker hardened the realm:",
        JSON.stringify({
          deleted: scrub.deleted.length,
          failed: scrub.failed,
          frozen: scrub.frozen,
          neutered: scrub.neutered,
        }),
      );

      // A global that refused to be deleted is a FACT to record, not a crash --
      // but it is also a capability still reachable, so it fails this test
      // until somebody writes down what it exposes.
      expect(scrub.failed, "a global refused to be deleted -- record it, do not hide it").toEqual(
        [],
      );
      for (const name of ["Function", "eval", "process", "require", "fetch", "Reflect"]) {
        expect(scrub.deleted, `${name} survived the scrub`).toContain(name);
      }
      expect([...scrub.neutered].sort()).toEqual(
        [
          "AsyncFunction.prototype.constructor",
          "AsyncGeneratorFunction.prototype.constructor",
          "Error.stackTraceLimit",
          "Function.prototype.constructor",
          "GeneratorFunction.prototype.constructor",
        ].sort(),
      );
      expect(scrub.frozen).toBeGreaterThan(50);
      // Read from inside the realm, after the fact.
      expect(boot.after.hasFunction).toBe("undefined");
      expect(boot.after.hasEval).toBe("undefined");
      expect(boot.after.hasProcess).toBe("undefined");

      // --- load -------------------------------------------------------------
      // The cart's own code runs here for the first time, in the realm the
      // scrub just made. Not before it.
      worker.post({ t: "load", seed: SEED });
      const ready = await worker.next();
      expect(ready, `load faulted: ${JSON.stringify(ready)}`).toEqual({ t: "ready" });

      // --- step, sixty times ------------------------------------------------
      let lastRgba: Uint32Array | null = null;
      for (let f = 0; f < FRAMES; f++) {
        const out = new ArrayBuffer(RGBA_BYTES);
        worker.post({ t: "step", frame: f, input: inputAt(f), out }, [out]);
        const reply = await worker.next();
        expect(reply["t"], `frame ${f}: ${JSON.stringify(reply)}`).toBe("frame");
        expect(reply["frame"]).toBe(f);
        const back = reply["out"] as ArrayBuffer;
        expect(back.byteLength).toBe(RGBA_BYTES);
        lastRgba = new Uint32Array(back);
      }

      expect(lastRgba).not.toBeNull();
      if (lastRgba === null) return;

      // THE CLAIM. A cart file, in a hardened worker, produced the same pixels
      // as the same cart file in this process.
      expect(isBlank(lastRgba), "the hardened worker served a blank screen").toBe(false);
      expect(Array.from(lastRgba)).toEqual(Array.from(here.rgba));

      // --- snapshot ---------------------------------------------------------
      worker.post({ t: "snapshot" });
      const snap = await worker.next();
      expect(snap["t"], JSON.stringify(snap)).toBe("snapshot");
      const ram = new Uint8Array(snap["ram"] as ArrayBuffer);
      expect(ram.length).toBe(here.ram.length);
      // Byte for byte: the whole machine is one buffer, so this is the strongest
      // statement available that the two runs are the same run.
      expect(Array.from(ram)).toEqual(Array.from(here.ram));
    } finally {
      await worker.stop();
    }
  });

  it("refuses a damaged cart without hardening or serving anything", async () => {
    // A worker that hardened itself and then served nothing is harder to
    // diagnose than one that reports the load error with its realm intact --
    // and it has destroyed a realm to protect a cart that does not exist.
    const damaged = buildHelloCart();
    damaged[17] = (damaged[17] ?? 0) ^ 0xff;

    const worker = await driveWorker(damaged);
    try {
      const boot = (await worker.next()) as unknown as BootstrapMessage;
      expect(boot.t).toBe("bootstrap");
      expect(boot.threw).toBeNull();
      expect(boot.installed).toBe(false);
      expect(boot.scrub, "a failed load must not scrub the realm").toBeNull();
      expect(boot.error).not.toBeNull();
      expect(boot.error?.code).toBe("bad-container");
      // The realm is intact, which is what makes the worker questionable.
      expect(boot.after.hasFunction).toBe("function");
      expect(boot.after.onmessageInstalled).toBe(false);
    } finally {
      await worker.stop();
    }
  });
});
