/**
 * THE SHIPPING PLAYER, AND THE TWO CLAIMS THAT MAKE IT ONE.
 *
 *   1. A cart handed to `createPlayer` with no options runs in a realm where the
 *      code constructors are neutered -- so the six escapes in
 *      `conformance/canaries/README.md` are closed.
 *   2. Its audio registers reach the mixer anyway.
 *
 * Those two are one claim wearing two faces. Audio used to be readable only from
 * a machine object on this thread, so hardening the player would have shipped a
 * silent console, and a console that has to choose between sound and a sandbox
 * chooses sound. Both had to move together, so both are tested together.
 *
 * ===========================================================================
 * WHY THE HARDENING TEST DOES NOT MENTION `scrubRealm`
 * ===========================================================================
 * This project has twice found Layer 2 doing NOTHING while a green suite said
 * otherwise -- once because `scrubRealm` threw on a real global, once because
 * its delete pass could not reach a web global's inherited properties. Both
 * times the tests that passed were tests of the CODE PATH. So nothing here
 * asserts that a function was called. A cart is run, and the cart reports what
 * it managed to obtain, the way `canaries.test.ts` does: three bytes in USER
 * RAM, read back out through `player.snapshot()`.
 *
 * The probe cart cannot simply ask `typeof fetch`. Layer 1 shadows NAMES, so
 * `fetch` is `undefined` inside every cart whether the realm was hardened or
 * not, and a test built on that would pass on an unhardened player. The cart
 * therefore has to ESCAPE first -- `(function(){}).constructor("return this")()`
 * and two other spellings of it -- and look at the realm it got. The same bytes
 * of the same cart answer 1 in `unsafeInProcess` and 0 in the default, which is
 * what makes the 0 mean something.
 *
 * ===========================================================================
 * WHAT IS NODE-VERIFIABLE HERE AND WHAT IS NOT
 * ===========================================================================
 * `Worker` and `document` are browser constructs, so everything about the
 * DEFAULT player -- the hardening, the audio crossing, the loud failure when
 * there is no `Worker` -- runs only in the browser suite and skips itself in
 * Node. Node can verify the bootstrap WIRING in `cart-worker.ts` against a
 * stand-in scope, and that is all it can honestly verify: `scrubRealm` on a
 * plain object deletes and freezes nothing, so those tests are about message
 * discipline and must never be read as evidence about Layer 2.
 *
 * Run the browser half with:
 *   SQ1_BROWSER=chromium npx vitest run --config vitest.browser.config.ts
 *   SQ1_BROWSER=firefox  npx vitest run --config vitest.browser.config.ts
 */

import { afterEach, describe, expect, it } from "vitest";

import { ADDR, AUDIO_REGS_BYTES, LEN, readAudioRegs } from "@sq1/runtime";
import type { FromWorker, ToWorker } from "@sq1/runtime";
import { SPEC_MAJOR, SPEC_MINOR, defaultMeta, encode, encodeMeta } from "@sq1/cart";

import { CART_MESSAGE, installCartBootstrap } from "../src/cart-worker";
import type { CartWorkerScope } from "../src/cart-worker";
import { createPlayer } from "../src/player";
import type { Player } from "../src/player";
import type { AudioGraph, AudioGraphState } from "../src/audio-graph";

const inBrowser = typeof window !== "undefined" && typeof document !== "undefined";
const hasWorker = typeof (globalThis as { Worker?: unknown }).Worker === "function";
/** The default player needs both a DOM to mount in and a Worker to hide in. */
const canRunPlayer = inBrowser && hasWorker;

// ---------------------------------------------------------------------------
// Carts
// ---------------------------------------------------------------------------

/** Where the probe cart writes what it found. Same three bytes canaries use. */
const FLAG = ADDR.USER_RAM + 0;
const REACH = ADDR.USER_RAM + 1;
const SAW_FUNCTION = ADDR.USER_RAM + 2;
const SAW_EVAL = ADDR.USER_RAM + 3;
const SAW_FETCH = ADDR.USER_RAM + 4;

/**
 * A cart that tries to get out, and writes down how far it got.
 *
 * It uses no forbidden name, so Layer 0 and Layer 1 have nothing to catch: it
 * makes a function value and asks that value's prototype for its constructor.
 * The result is compiled in the GLOBAL scope, where nothing is shadowed. Only
 * Layer 2 -- `scrubRealm` neutering `Function.prototype.constructor` -- stops
 * it, and stopping it is the whole of what a hardened realm means here.
 *
 * `g.Object === Object` is the proof that what came back is THE REALM and not
 * merely some object, exactly as `25-function-constructor.js` does it.
 */
const PROBE_CART = `
var FLAG = ${FLAG};
var REACH = ${REACH};
var SAW_FUNCTION = ${SAW_FUNCTION};
var SAW_EVAL = ${SAW_EVAL};
var SAW_FETCH = ${SAW_FETCH};

function grab() {
  var g = null;
  try { g = (function () {}).constructor("return this")(); } catch (e) {}
  if (!g) { try { g = [].constructor.constructor("return this")(); } catch (e) {} }
  if (!g) { try { g = ({}).constructor.constructor("return this")(); } catch (e) {} }
  return g;
}

function tick() {
  var g = grab();
  if (g && typeof g === "object" && g.Object === Object) {
    sys.poke(FLAG, 1);
    if (typeof g.Function !== "undefined") sys.poke(SAW_FUNCTION, 1);
    if (typeof g.eval !== "undefined") sys.poke(SAW_EVAL, 1);
    if (typeof g.fetch !== "undefined") sys.poke(SAW_FETCH, 1);
  }
  sys.poke(REACH, 1);
}
`;

/**
 * A cart with a voice, whose registers are a known function of the frame index.
 *
 * PITCH_LO carries the frame number itself, so every block the mixer receives
 * SAYS which frame it is, and a block that arrived stale, duplicated or one
 * frame late cannot be mistaken for a fresh one. It writes into the master
 * block as well as into channel 0, so a boundary that carried only the channel
 * registers would fail rather than sound thin.
 */
const AUDIO_CART = `
var A = ${ADDR.AUDIO_CH};
var M = ${ADDR.AUDIO_MASTER};
function tick() {
  var f = sys.frame() & 0xff;
  sys.poke(A + 0, 0xc0);
  sys.poke(A + 2, (f * 7) & 0xff);
  sys.poke(A + 4, f);
  sys.poke(A + 5, 1);
  sys.poke(M + 3, (f * 13) & 0xff);
}
`;

/** The 80 register bytes AUDIO_CART leaves behind on frame `f`. */
const WAVETABLE_OFFSET = ADDR.AUDIO_MASTER - ADDR.AUDIO_CH;
function expectedAudio(f: number): Uint8Array {
  const out = new Uint8Array(AUDIO_REGS_BYTES);
  out[0] = 0xc0;
  out[2] = (f * 7) & 0xff;
  out[4] = f & 0xff;
  out[5] = 1;
  out[WAVETABLE_OFFSET + 3] = (f * 13) & 0xff;
  return out;
}

/** A cart file, packed the way the demo page packs one. */
function packCart(source: string, title = "probe"): Uint8Array {
  return encode({
    specMajor: SPEC_MAJOR,
    specMinor: SPEC_MINOR,
    chunks: [
      { type: "META", data: encodeMeta(defaultMeta(title, "square one")) },
      { type: "CODE", data: new TextEncoder().encode(source) },
    ],
  });
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const players: Player[] = [];
const mounts: HTMLElement[] = [];

afterEach(() => {
  // Every player owns a Worker and two window listeners. A test that left one
  // running would leak a thread into the next test and, eventually, into a
  // timeout nobody can explain.
  while (players.length > 0) {
    try {
      players.pop()?.stop();
    } catch {
      /* already stopped */
    }
  }
  while (mounts.length > 0) mounts.pop()?.remove();
});

function makeMount(): HTMLElement {
  const el = document.createElement("div");
  el.style.width = "512px";
  el.style.height = "512px";
  document.body.appendChild(el);
  mounts.push(el);
  return el;
}

function keep(p: Player): Player {
  players.push(p);
  return p;
}

/** Poll until `p` holds. Real time, because a real Worker answers in real time. */
async function until(p: () => boolean, what: string, limitMs = 20_000): Promise<void> {
  const t0 = Date.now();
  while (!p()) {
    if (Date.now() - t0 > limitMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 8));
  }
}

/**
 * A mixer that records what it is handed.
 *
 * It COPIES on the way in, because `Host.latestAudio` is one reused array: a
 * recorder that kept the reference would end up with N pointers to the newest
 * frame and would agree with itself no matter what crossed the boundary.
 *
 * It also reports `running` as soon as `start()` is called, which a real graph
 * cannot do here -- a headless browser leaves its AudioContext suspended
 * without a user gesture, so a real graph would never be handed anything at all.
 */
interface RecordingGraph extends AudioGraph {
  readonly pushes: Uint8Array[];
}

function recordingGraph(): RecordingGraph {
  const pushes: Uint8Array[] = [];
  let live = false;
  return {
    pushes,
    start(): Promise<void> {
      live = true;
      return Promise.resolve();
    },
    stop(): void {
      live = false;
    },
    push(regs: Uint8Array): void {
      pushes.push(regs.slice());
    },
    get running(): boolean {
      return live;
    },
    get sampleRate(): number {
      return 48_000;
    },
    get state(): AudioGraphState {
      return live ? "running" : "stopped";
    },
  };
}

// ---------------------------------------------------------------------------
// The claim: the DEFAULT player is hardened.
// ---------------------------------------------------------------------------

describe.skipIf(!canRunPlayer)("createPlayer, by default, runs the cart in a hardened realm", () => {
  it("DENIES THE ESCAPE: the cart cannot reach Function, eval or fetch", async () => {
    // THE TEST THIS FILE EXISTS FOR. No option is passed. This is what a page
    // that says `createPlayer({ mount, cart })` actually gets.
    const player = keep(createPlayer({ mount: makeMount(), cart: packCart(PROBE_CART), audio: false }));
    player.start();
    await until(() => player.framesConfirmed >= 3, "three frames from the worker");

    const ram = await player.snapshot();

    // REACH first. Without it, every zero below could be a cart that died on
    // line one -- which looks exactly like a cart that was denied.
    expect(ram[REACH], "the probe cart never ran to completion").toBe(1);

    expect(
      ram[FLAG],
      "THE DEFAULT PLAYER HANDED A CART THE REAL GLOBAL OBJECT. Layer 2 is not " +
        "running: `(function(){}).constructor` still compiles in the global " +
        "scope, and every escape in conformance/canaries/README.md is open.",
    ).toBe(0);
    expect(ram[SAW_FUNCTION], "the cart found Function in its realm").toBe(0);
    expect(ram[SAW_EVAL], "the cart found eval in its realm").toBe(0);
    expect(ram[SAW_FETCH], "the cart found fetch in its realm").toBe(0);
  });

  it("keeps running the cart normally while it is denied", async () => {
    // A sandbox that also stopped the machine would pass the test above for the
    // wrong reason. Frames have to keep arriving.
    const player = keep(createPlayer({ mount: makeMount(), cart: packCart(PROBE_CART), audio: false }));
    player.start();
    await until(() => player.framesConfirmed >= 10, "ten frames");
    const seen = player.framesConfirmed;
    await until(() => player.framesConfirmed > seen + 5, "the clock still running");
  });

  it("survives the round trip: snapshot returns real RAM, not an empty buffer", async () => {
    const player = keep(createPlayer({ mount: makeMount(), cart: packCart(AUDIO_CART), audio: false }));
    player.start();
    await until(() => player.framesConfirmed >= 5, "five frames");
    const ram = await player.snapshot();
    // 64 KiB, and the machine's own frame counter in it. A short or zeroed
    // buffer would make every assertion in this file vacuous.
    expect(ram.length).toBe(ADDR.SAVE + LEN.SAVE);
    expect(ram[ADDR.FRAME]).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// The claim: the opt-in is real, and it is honest about being Layer 1.
// ---------------------------------------------------------------------------

describe.skipIf(!canRunPlayer)("unsafeInProcess", () => {
  it("RUNS -- it is a real path, not a stub", async () => {
    const player = keep(
      createPlayer({
        mount: makeMount(),
        cart: packCart(AUDIO_CART),
        audio: false,
        unsafeInProcess: true,
      }),
    );
    player.start();
    await until(() => player.framesConfirmed >= 5, "five in-process frames");
    const ram = await player.snapshot();
    expect(ram[ADDR.AUDIO_CH]).toBe(0xc0);
  });

  it("IS STILL LAYER 1: the same cart that is denied by default gets out here", async () => {
    // The control for the test above, and the honesty check on the option's
    // doc comment. If this ever comes back FLAG 0, either the in-process path
    // has quietly acquired a sandbox -- good news, say so -- or the probe cart
    // has stopped probing, in which case the default-player test is measuring
    // nothing and its green tick means nothing either.
    const player = keep(
      createPlayer({
        mount: makeMount(),
        cart: packCart(PROBE_CART),
        audio: false,
        unsafeInProcess: true,
      }),
    );
    player.start();
    await until(() => player.framesConfirmed >= 3, "three in-process frames");
    const ram = await player.snapshot();

    expect(ram[REACH]).toBe(1);
    expect(
      ram[FLAG],
      "the probe cart no longer escapes an UNHARDENED realm, so it can no " +
        "longer prove that a hardened one denied it",
    ).toBe(1);
    // The page's own realm, which is what "Layer 1 only" costs.
    expect(ram[SAW_FUNCTION]).toBe(1);
    expect(ram[SAW_EVAL]).toBe(1);
    expect(ram[SAW_FETCH]).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// The claim: no silent fallback.
// ---------------------------------------------------------------------------

describe.skipIf(!inBrowser)("an environment without Worker", () => {
  it("throws, rather than quietly running the cart on the page's thread", () => {
    const g = globalThis as { Worker?: unknown };
    const real = g.Worker;
    try {
      g.Worker = undefined;
      let built: Player | null = null;
      expect(() => {
        built = createPlayer({ mount: makeMount(), cart: packCart(PROBE_CART), audio: false });
      }).toThrow(/Worker/);
      // Nothing was built. A fallback here would be the exact bug this default
      // exists to fix, delivered to whichever browsers are least able to notice.
      expect(built).toBeNull();
    } finally {
      g.Worker = real;
    }
  });

  it("says how to opt in, so the failure is actionable rather than a dead end", () => {
    const g = globalThis as { Worker?: unknown };
    const real = g.Worker;
    try {
      g.Worker = undefined;
      expect(() =>
        createPlayer({ mount: makeMount(), cart: packCart(PROBE_CART), audio: false }),
      ).toThrow(/unsafeInProcess/);
    } finally {
      g.Worker = real;
    }
  });
});

// ---------------------------------------------------------------------------
// The claim: audio registers cross the worker boundary.
// ---------------------------------------------------------------------------

describe.skipIf(!canRunPlayer)("audio through a real Worker", () => {
  it("hands the mixer exactly the registers the machine wrote for that frame", async () => {
    const graph = recordingGraph();
    const player = keep(
      createPlayer({ mount: makeMount(), cart: packCart(AUDIO_CART), audio: graph }),
    );
    player.start();
    // Started directly rather than through a gesture: `armAudio` waits for a
    // pointerdown or keydown, and a synthetic one is one more thing to be
    // flaky about in two engines.
    await graph.start();

    await until(() => graph.pushes.length >= 8, "eight frames of registers at the mixer");
    player.pause();

    expect(graph.pushes.length).toBeGreaterThanOrEqual(8);
    for (const regs of graph.pushes) {
      expect(regs.length, "the mixer was handed a short register block").toBe(AUDIO_REGS_BYTES);
      // Each block names its own frame in PITCH_LO, so this compares it against
      // what the machine wrote on THAT frame rather than on any frame.
      const f = regs[4] as number;
      expect(Array.from(regs), `the block naming frame ${f}`).toEqual(
        Array.from(expectedAudio(f)),
      );
    }

    // The blocks advance. Identical registers every frame would satisfy the
    // loop above and would also be what a boundary that carried one frame and
    // then repeated it forever looks like.
    const named = graph.pushes.map((r) => r[4] as number);
    expect(Math.max(...named)).toBeGreaterThan(Math.min(...named));
  });

  it("is READ FROM RAM: the same bytes come back through snapshot", async () => {
    // Anchors `expectedAudio` to the machine rather than to arithmetic in this
    // file. Everything above compares the mixer's input to a formula; this
    // compares the formula to `readAudioRegs` of real machine RAM, taken over
    // the same channel, for a frame identified by number.
    const graph = recordingGraph();
    const player = keep(
      createPlayer({ mount: makeMount(), cart: packCart(AUDIO_CART), audio: graph }),
    );
    player.start();
    await graph.start();
    await until(() => graph.pushes.length >= 6, "six frames of registers");
    player.pause();
    await until(() => player.framesConfirmed === player.frame, "every issued frame answered");

    const ram = await player.snapshot();
    const fromRam = new Uint8Array(AUDIO_REGS_BYTES);
    readAudioRegs(ram, fromRam);

    // The machine has run `player.frame` ticks, so the last one saw frame index
    // frame - 1, and the registers in RAM are the ones it left.
    const last = (player.frame - 1) & 0xff;
    expect(Array.from(fromRam)).toEqual(Array.from(expectedAudio(last)));
    expect(fromRam[4], "PITCH_LO should carry the last frame index").toBe(last);
  });

  it("pushes nothing before the first frame, so a run starts silent", async () => {
    const graph = recordingGraph();
    const player = keep(
      createPlayer({ mount: makeMount(), cart: packCart(AUDIO_CART), audio: graph }),
    );
    await graph.start();
    player.start();
    // The worker has to boot before it can answer, so there is a real window
    // here in which the loop is running and there is no frame yet. Nothing may
    // be handed to the mixer during it -- a zero-filled block would be a click.
    await until(() => graph.pushes.length > 0, "the first frame");
    for (const regs of graph.pushes) {
      expect(Array.from(regs).every((b) => b === 0)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// The bootstrap wiring in cart-worker.ts. Node can see this much.
// ---------------------------------------------------------------------------

/** A stand-in worker global: it records what was posted and holds a handler. */
interface FakeScope extends CartWorkerScope {
  readonly sent: unknown[];
}

function fakeScope(): FakeScope {
  const sent: unknown[] = [];
  return {
    sent,
    onmessage: null,
    postMessage(m: unknown): void {
      sent.push(m);
    },
  };
}

/** Hand a message to whatever handler is installed right now. */
function deliver(scope: CartWorkerScope, data: unknown): void {
  const h = scope.onmessage;
  if (h === null) throw new Error("cart-worker installed no handler");
  h({ data });
}

/**
 * `installWorker` -- and therefore the bootstrap's install step -- refuses any
 * realm that has a `window`, because that is the page's own thread and a cart
 * must not be served from it. So the stand-in scope below installs a machine
 * loop in Node and is refused in a browser, and both are asserted.
 */
const standInInstalls = typeof (globalThis as { window?: unknown }).window === "undefined";

describe("cart-worker: the bootstrap message", () => {
  it("attaches nothing merely by being imported", () => {
    // The property `worker.ts` documents about `installWorker`, re-asked here:
    // this module is imported by `player.ts`, which runs on the page's thread.
    expect((globalThis as Record<string, unknown>)["onmessage"] ?? null).toBeNull();
    expect(installCartBootstrap()).toBe(false);
  });

  it("faults, rather than hanging, when a machine message arrives before the cart", () => {
    const scope = fakeScope();
    expect(installCartBootstrap(scope)).toBe(true);
    deliver(scope, { t: "load", seed: 0 } satisfies ToWorker);
    expect(scope.sent).toHaveLength(1);
    const m = scope.sent[0] as FromWorker;
    expect(m.t).toBe("fault");
    expect((m as { message: string }).message).toMatch(/before the cart bytes/);
  });

  it("faults on every later message when the cart will not load", () => {
    const scope = fakeScope();
    installCartBootstrap(scope);
    // Not a cart file: no magic, no chunks, nothing `decode` will accept.
    deliver(scope, { t: CART_MESSAGE, bytes: new Uint8Array([1, 2, 3, 4]) });
    deliver(scope, { t: "load", seed: 0 } satisfies ToWorker);
    deliver(scope, { t: "snapshot" } satisfies ToWorker);

    // One reply for the failed bootstrap, then one for each message after it.
    // A worker that answered nothing would strand the host on a `load` that has
    // no deadline to rescue it.
    expect(scope.sent).toHaveLength(3);
    for (const m of scope.sent) expect((m as FromWorker).t).toBe("fault");
  });

  it("ignores a bootstrap message that is not one", () => {
    const scope = fakeScope();
    installCartBootstrap(scope);
    // Right tag, wrong payload: `bytes` is not a Uint8Array, so it is not a
    // cart message and must not be fed to the loader.
    deliver(scope, { t: CART_MESSAGE, bytes: "not bytes" });
    expect(scope.sent).toHaveLength(1);
    expect((scope.sent[0] as FromWorker).t).toBe("fault");
  });

  it.skipIf(!standInInstalls)("hands the realm over to the machine loop once the cart arrives", () => {
    const scope = fakeScope();
    installCartBootstrap(scope);
    deliver(scope, { t: CART_MESSAGE, bytes: packCart(AUDIO_CART) });
    // Nothing is said on success: the next message belongs to the machine.
    expect(scope.sent).toHaveLength(0);

    deliver(scope, { t: "load", seed: 0 } satisfies ToWorker);
    expect((scope.sent[0] as FromWorker).t).toBe("ready");

    const out = new ArrayBuffer(128 * 128 * 4);
    deliver(scope, { t: "step", frame: 0, input: new Uint8Array(4), out } satisfies ToWorker);
    const frame = scope.sent[1] as FromWorker & { audio?: Uint8Array };
    expect(frame.t).toBe("frame");
    // And the audio is on it, from the machine the bootstrap built.
    expect(Array.from(frame.audio as Uint8Array)).toEqual(Array.from(expectedAudio(0)));
  });

  it.skipIf(standInInstalls)("refuses to serve a cart from a realm with a window", () => {
    // On the page's own thread there is no message loop to install, and the
    // bootstrap says so rather than hardening a realm and serving nothing.
    const scope = fakeScope();
    installCartBootstrap(scope);
    deliver(scope, { t: CART_MESSAGE, bytes: packCart(AUDIO_CART) });
    expect(scope.sent).toHaveLength(1);
    const m = scope.sent[0] as FromWorker;
    expect(m.t).toBe("fault");
    expect((m as { message: string }).message).toMatch(/dedicated worker scope/);
  });
});
