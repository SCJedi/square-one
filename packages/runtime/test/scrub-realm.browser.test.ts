/**
 * Layer 2, against a REAL BROWSER WORKER global.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `scrub-realm.test.ts` proves Layer 2 on a real `node:worker_threads` global.
 * That proof cost something to get: the first run of it found that `scrubRealm()`
 * THREW on a real global -- it deleted the `Function` binding and then
 * `neuterCodeConstructors` named `Function` by identifier -- so Layer 2 did
 * nothing at all while every in-process test stayed green.
 *
 * Node is not the deployment target. A browser is. And a browser realm differs
 * from a Node worker realm in exactly the places Layer 2 operates on:
 *
 *   - WHICH GLOBALS EXIST. `self`, `postMessage`, `location`, `navigator`,
 *     `caches`, `indexedDB`, `Notification`, `importScripts`, `XMLHttpRequest`
 *     are browser-worker names. Node has none of them, so the delete pass has
 *     never been run against a single one of them.
 *   - WHICH ARE CONFIGURABLE. A WebIDL global carries interface properties the
 *     engine installs itself. Whether `delete` works on them is an engine fact,
 *     not a spec-reading exercise, and `ScrubReport.failed` is where it shows up.
 *   - WHICH INTRINSICS CAN BE REDEFINED, and whether `Error.stackTraceLimit`
 *     exists at all (it is a V8 knob; SpiderMonkey has no such property).
 *
 * So this file is the same claim as the Node one, made where the claim actually
 * has to hold. It is browser-only and skips itself in Node, which also means the
 * Node suite picks it up (vitest.config.ts globs every test file) and reports it
 * skipped rather than failing.
 *
 * HOW THE WORKER GETS THE REAL `scrubRealm`
 * -----------------------------------------
 * A copy of the function would test nothing, so the worker runs the real one.
 * Vitest's browser mode is a Vite dev server, so every module in `src/` already
 * has a URL that serves it compiled: `new URL("../src/sandbox.ts",
 * import.meta.url)` is the address of THE source file, and Vite's transform
 * pipeline hands the browser the same JavaScript the rest of the suite imports.
 * The worker is a Blob module whose only job is to `import` those URLs and drive
 * them, so the bytes running inside it are the bytes in `src/`, with the types
 * stripped and the bare specifiers resolved, and nothing else.
 *
 * The job (canary sources, the smoke cart, the seed) is embedded in that source
 * as JSON rather than posted in, so the worker never has to keep a message
 * channel alive across a scrub that deletes `addEventListener`.
 */

import { beforeAll, describe, expect, it } from "vitest";

import { ChainHasher } from "../src/hash";
import { createMachine } from "../src/machine";
import { REALM_KEEP, SCRUBBED_NAMES, compileCart } from "../src/sandbox";

const inBrowser =
  typeof window !== "undefined" &&
  typeof (globalThis as { Worker?: unknown }).Worker === "function" &&
  typeof Blob === "function" &&
  typeof URL !== "undefined" &&
  typeof URL.createObjectURL === "function";

/**
 * The six canaries that get out on Layers 0+1. Spelled out rather than filtered
 * out of the manifest, for the same reason `canaries.test.ts` spells them out:
 * a hole must not be able to leave this list by accident.
 */
const KNOWN_HOLES: readonly string[] = [
  "25-function-constructor.js",
  "26-intrinsic-constructor-walk.js",
  "27-getprototypeof-walk.js",
  "28-async-generator-constructors.js",
  "29-constructed-dynamic-import.js",
  "30-intrinsic-mutation.js",
];

// Enumerated through Vite, exactly as canaries.test.ts does it, so all three
// files are reading the same directory the same way.
declare global {
  interface ImportMeta {
    glob(
      pattern: string,
      options: { query: string; import: string; eager: true },
    ): Record<string, string>;
  }
}

const canarySources = import.meta.glob("../../../conformance/canaries/*.js", {
  query: "?raw",
  import: "default",
  eager: true,
});

const canaries = new Map<string, string>(
  Object.entries(canarySources).map(([path, src]) => [path.slice(path.lastIndexOf("/") + 1), src]),
);

/**
 * The cart the determinism check runs on both sides of the scrub. Identical to
 * the one in `scrub-realm.test.ts`, deliberately: the same cart, the same seed
 * and the same frame count in Node, Chromium and Firefox means the three chains
 * are directly comparable and a divergence names its engine.
 *
 * It has to TOUCH the things a scrubbed realm might have broken, so it draws
 * from `sys.rnd` (`Math.imul` in prng.ts, and `Math` is kept), from `sys.sin`
 * (`Math.floor` in fixed.ts), through `gfx.rect` into the framebuffer, and pokes
 * RAM outside it.
 */
const SMOKE_CART = `
function boot() {
  gfx.cls(0);
}
function tick() {
  var f = sys.frame();
  for (var i = 0; i < 8; i++) {
    var s = sys.sin((f * 13 + i * 128) & 1023);
    var x = 64 + (s >> 13);
    var y = (i * 15 + sys.rnd(9)) % 120;
    gfx.rect(x, y, 6, 5, (i + f) & 15, (i % 2) === 0);
  }
  sys.poke(0x7900, sys.rnd(256));
  sys.poke(0x7901, sys.cos(f & 1023) & 0xff);
}
`;

const SMOKE_SEED = 7;
const SMOKE_FRAMES = 12;

/** What one worker sends back. Every field is an observation, never a verdict. */
interface WorkerResult {
  /** `navigator.userAgent`, read BEFORE the scrub deletes `navigator`. */
  ua: string;
  /** `SCRUBBED_NAMES` that were actually on this global before the scrub. */
  scrubbedPresentBefore: string[];
  /**
   * Of those, the ones that are NOT own properties of the global object -- they
   * are inherited from `DedicatedWorkerGlobalScope.prototype`,
   * `WorkerGlobalScope.prototype` or `EventTarget.prototype`. A plain
   * `delete globalThis[key]` cannot remove these. Node has none.
   */
  inheritedOnly: string[];
  /** `REALM_KEEP` names present before the scrub. */
  keepPresentBefore: string[];
  /** `REALM_KEEP` names present after it. */
  keepPresentAfter: string[];
  /** The real `ScrubReport`, verbatim. */
  report: { deleted: string[]; failed: string[]; frozen: number; neutered: string[] } | null;
  /** For each `failed` name: is it still configurable, and what does it hold? */
  failedDetail: { name: string; configurable: unknown; type: string; value: string }[];
  /** Spot checks on the freeze pass, read from inside the scrubbed realm. */
  frozenSpot: {
    objectPrototype?: boolean;
    arrayPrototype?: boolean;
    functionPrototype?: boolean;
    stackTraceLimit?: unknown;
  };
  /** One entry per known-hole canary, compiled and run AFTER the scrub. */
  canaries: {
    name: string;
    compileError: string | null;
    threw: string | null;
    flag: number | null;
    reach: number | null;
    note: number | null;
  }[];
  /** The smoke cart's per-frame hashes, its chain, and a checksum of `present()`. */
  frames: string[];
  chain: string | null;
  rgbaSum: number;
  /** What `installWorker(factory)` returned against the real scrubbed global. */
  installedOnGlobal: boolean | null;
  /** Of `deleteExtra`, the names the probe actually managed to remove. */
  deletedExtra: string[];
  /** Did the runtime still run after the scrub (plus any extra deletions)? */
  probe: { ok: boolean; error: string | null } | null;
  /** Set only when the harness itself fell over, which is a finding in itself. */
  fatal: string | null;
}

interface Job {
  mode: "full" | "probe";
  /** Names deleted from the global AFTER the scrub, for the REALM_KEEP probe. */
  deleteExtra: string[];
  canaries: [string, string][];
  smoke: string;
  seed: number;
  frames: number;
}

/**
 * The address of a real source module, as this browser can fetch it.
 *
 * `import.meta.url` is the test file's own URL on the Vite dev server, so a
 * relative resolve against it names the neighbouring source file. Nothing here
 * is a copy: the worker imports the same URL the main thread's own
 * `import "../src/sandbox"` above resolves to.
 */
const srcUrl = (rel: string): string => new URL(rel, import.meta.url).href;

/**
 * The worker's program: a module that imports the real runtime and drives it.
 *
 * `send` is bound from `self.postMessage` on the first line, before anything is
 * scrubbed, the way a real bootstrap must -- the result has to get out even from
 * a realm where the probe has just deleted `postMessage` on purpose.
 */
function harnessSource(job: Job): string {
  return `
import { REALM_KEEP, SCRUBBED_NAMES, compileCart, scrubRealm } from ${JSON.stringify(srcUrl("../src/sandbox.ts"))};
import { createMachine } from ${JSON.stringify(srcUrl("../src/machine.ts"))};
import { ChainHasher } from ${JSON.stringify(srcUrl("../src/hash.ts"))};
import { installWorker } from ${JSON.stringify(srcUrl("../src/worker.ts"))};

const JOB = ${JSON.stringify(job)};
const G = globalThis;
const send = self.postMessage.bind(self);
const NO_INPUT = new Uint8Array(4);
const RGBA_BYTES = 128 * 128 * 4;

function why(e) {
  if (e && typeof e === "object" && typeof e.name === "string") {
    return e.name + ": " + String(e.message);
  }
  return String(e);
}

const out = {
  ua: "",
  scrubbedPresentBefore: [],
  inheritedOnly: [],
  keepPresentBefore: [],
  keepPresentAfter: [],
  report: null,
  failedDetail: [],
  frozenSpot: {},
  canaries: [],
  frames: [],
  chain: null,
  rgbaSum: 0,
  installedOnGlobal: null,
  deletedExtra: [],
  probe: null,
  fatal: null,
};

function present(n) {
  try { return n in G; } catch (e) { return false; }
}

// The REALM_KEEP probe's own delete, and it has to follow the prototype chain
// for the same reason scrubRealm's does: \`performance\`, \`console\` and
// \`postMessage\` are WebIDL members of WorkerGlobalScope, so they live on a
// prototype and \`delete globalThis.performance\` removes nothing at all. A
// probe that used a plain delete would report every one of them as "not
// load-bearing" because it never actually took it away.
function hardDelete(n) {
  let o = G;
  while (o !== null && o !== Object.prototype) {
    if (Object.prototype.hasOwnProperty.call(o, n)) {
      try { delete o[n]; } catch (e) { /* non-configurable; presence reports it */ }
    }
    o = Object.getPrototypeOf(o);
  }
  return !(n in G);
}

function runSmoke() {
  const prog = compileCart(JOB.smoke, { name: "smoke" });
  const m = createMachine(prog);
  const h = new ChainHasher();
  m.boot(JOB.seed);
  for (let f = 0; f < JOB.frames; f++) {
    m.tick(NO_INPUT);
    out.frames.push(h.push(m.ram));
  }
  m.present();
  let s = 0;
  for (let i = 0; i < m.rgba.length; i++) s = (s + m.rgba[i]) >>> 0;
  out.rgbaSum = s;
  out.chain = h.digest;
}

// The worker plumbing, driven the way host.ts drives it. Two calls, and they
// answer different questions:
//   installWorker(factory)        does the SCRUBBED REAL GLOBAL still look like
//                                 a worker scope? This is the call Node could
//                                 never make -- a Node worker global has no
//                                 postMessage, so isWorkerScope() is false there
//                                 for reasons that have nothing to do with Layer 2.
//   installWorker(factory, fake)  does a load/step/snapshot round trip still work?
function runPlumbing() {
  const factory = () => createMachine(compileCart(JOB.smoke, { name: "plumbing" }));

  out.installedOnGlobal = installWorker(factory);

  const sent = [];
  const fake = { onmessage: null, postMessage: (m) => { sent.push(m); } };
  if (installWorker(factory, fake) !== true) throw new Error("installWorker refused a scope");
  fake.onmessage({ data: { t: "load", seed: 1 } });
  fake.onmessage({ data: { t: "step", frame: 0, input: NO_INPUT, out: new ArrayBuffer(RGBA_BYTES) } });
  fake.onmessage({ data: { t: "snapshot" } });
  const kinds = sent.map((m) => m.t + (m.t === "fault" ? "(" + m.message + ")" : ""));
  if (kinds.join(",") !== "ready,frame,snapshot") {
    throw new Error("worker plumbing replied " + kinds.join(","));
  }
  if (out.installedOnGlobal !== true) {
    throw new Error("installWorker did not recognise the scrubbed worker global");
  }
}

try {
  try {
    out.ua = String(navigator.userAgent);
  } catch (e) { out.ua = why(e); }

  out.scrubbedPresentBefore = SCRUBBED_NAMES.filter(present);
  out.keepPresentBefore = REALM_KEEP.filter(present);

  // The structural fact that makes a web global different from a Node one, read
  // BEFORE anything is deleted: which scrubbable names are reachable but are
  // NOT own properties of the global object. WebIDL puts interface operations
  // and attributes on the interface prototype, so these are the names a plain
  // \`delete globalThis[key]\` cannot touch.
  out.inheritedOnly = out.scrubbedPresentBefore.filter(
    (n) => !Object.prototype.hasOwnProperty.call(G, n),
  );

  // THE LINE THIS FILE EXISTS FOR.
  out.report = scrubRealm();

  out.keepPresentAfter = REALM_KEEP.filter(present);

  // A name that would not delete is a fact that needs a cause attached, and the
  // cause is its property descriptor. Read it here, inside the realm, because
  // it cannot be structured-cloned out.
  for (const n of out.report.failed) {
    let d = null;
    try { d = Object.getOwnPropertyDescriptor(G, n); } catch (e) { /* reported below */ }
    let v = "";
    try { v = String(G[n]); } catch (e) { v = why(e); }
    out.failedDetail.push({
      name: n,
      configurable: d === undefined ? "no own descriptor" : d.configurable,
      type: typeof G[n],
      value: v.length > 120 ? v.slice(0, 120) + "..." : v,
    });
  }

  out.frozenSpot = {
    objectPrototype: Object.isFrozen(Object.prototype),
    arrayPrototype: Object.isFrozen(Array.prototype),
    functionPrototype: Object.isFrozen(Object.getPrototypeOf(function () {})),
    stackTraceLimit: Error.stackTraceLimit,
  };

  out.deletedExtra = JOB.deleteExtra.filter(hardDelete);

  if (JOB.mode === "full") {
    for (const pair of JOB.canaries) {
      const name = pair[0];
      const src = pair[1];
      const entry = { name: name, compileError: null, threw: null, flag: null, reach: null, note: null };
      try {
        const m = createMachine(compileCart(src, { name: name }));
        try {
          m.boot(1);
          m.tick(NO_INPUT);
          m.tick(NO_INPUT);
        } catch (e2) {
          entry.threw = why(e2);
        }
        entry.flag = m.ram[0x7800];
        entry.reach = m.ram[0x7801];
        entry.note = m.ram[0x7802];
      } catch (e3) {
        entry.compileError = why(e3);
      }
      out.canaries.push(entry);
    }
  }

  try {
    runSmoke();
    runPlumbing();
    out.probe = { ok: true, error: null };
  } catch (e4) {
    out.probe = { ok: false, error: why(e4) };
  }
} catch (e5) {
  out.fatal = why(e5);
}

send(out);
`;
}

/** Run one job in a fresh browser Worker. Rejects only if the worker never answers. */
async function runWorker(job: Job): Promise<WorkerResult> {
  const blob = new Blob([harnessSource(job)], { type: "text/javascript" });
  const url = URL.createObjectURL(blob);
  const w = new Worker(url, { type: "module" });
  try {
    return await new Promise<WorkerResult>((resolve, reject) => {
      w.onmessage = (e: MessageEvent): void => resolve(e.data as WorkerResult);
      // A module worker that fails to load reports through `onerror` with an
      // empty message in some engines, so the URL is included: a 404 from the
      // dev server is the likeliest cause and it is otherwise invisible.
      w.onerror = (e: ErrorEvent): void =>
        reject(new Error(`worker error: ${e.message || "(no message)"} @ ${e.filename || url}`));
      w.onmessageerror = (): void => reject(new Error("worker result would not clone"));
    });
  } finally {
    w.terminate();
    URL.revokeObjectURL(url);
  }
}

/** The same smoke cart, in this page's realm, which nobody has scrubbed. */
function unscrubbedRun(): { frames: string[]; chain: string; rgbaSum: number } {
  const m = createMachine(compileCart(SMOKE_CART, { name: "smoke" }));
  const h = new ChainHasher();
  const frames: string[] = [];
  m.boot(SMOKE_SEED);
  for (let f = 0; f < SMOKE_FRAMES; f++) {
    m.tick(new Uint8Array(4));
    frames.push(h.push(m.ram));
  }
  m.present();
  let s = 0;
  for (let i = 0; i < m.rgba.length; i++) s = (s + (m.rgba[i] as number)) >>> 0;
  return { frames, chain: h.digest, rgbaSum: s };
}

const baseJob = (mode: "full" | "probe", deleteExtra: string[] = []): Job => ({
  mode,
  deleteExtra,
  canaries: KNOWN_HOLES.map((n) => [n, canaries.get(n) as string]),
  smoke: SMOKE_CART,
  seed: SMOKE_SEED,
  frames: SMOKE_FRAMES,
});

/**
 * Globals this realm may refuse to delete, with what each one leaves reachable.
 *
 * FILLED IN FROM OBSERVATION, NEVER TO GET A GREEN TICK. A name arrives here
 * only after someone has read its property descriptor (the worker reports it in
 * `failedDetail`) and written down what a cart could do with it. An empty list
 * is the strongest possible result and is what both engines currently give.
 *
 * Layer 1 still shadows every one of these names inside a cart, so a survivor
 * here is not automatically an escape -- it is a name that a cart which has
 * ALREADY re-acquired the global object could read. That is the threat model
 * `failed` describes.
 */
const EXPLAINED_FAILURES: Readonly<Record<string, string>> = Object.freeze({});

describe.skipIf(!inBrowser)("scrubRealm on a real browser worker global", () => {
  let full: WorkerResult;

  beforeAll(async () => {
    full = await runWorker(baseJob("full"));

    // The observed report is the deliverable. It goes to the console so that a
    // `failed` list which grows on a future Chrome or Firefox is on the screen
    // rather than buried in a green build.
    // eslint-disable-next-line no-console
    console.log(
      "scrubRealm on a real browser worker global:",
      full.ua,
      JSON.stringify(full.report),
      "inherited-only:",
      JSON.stringify(full.inheritedOnly),
      "failed-detail:",
      JSON.stringify(full.failedDetail),
    );
  });

  it("completes without throwing, on a realm it has just deleted `Function` from", () => {
    // THE REGRESSION GUARD FOR THE DEFECT THE NODE RUN FOUND, re-asked in the
    // engine that actually ships. `scrubRealm` deletes the global `Function`
    // before it neuters the code constructors; anything in the neuter or freeze
    // pass that names a scrubbed global by identifier is a ReferenceError that
    // kills the entire scrub.
    expect(full.fatal, "scrubRealm threw on a real browser global").toBeNull();
    expect(full.report).not.toBeNull();
    expect(full.report?.deleted).toContain("Function");
  });

  it("deletes every scrubbed name that was there, and explains anything that survived", () => {
    const report = full.report as NonNullable<WorkerResult["report"]>;

    // `failed` is a FACT, not a crash. Any name here must be in
    // EXPLAINED_FAILURES with a written reason -- see the comment there.
    // `hasOwnProperty`, not `in`: `in` would count `constructor` and `toString`
    // as explained, and the point of the list is that a name gets in by being
    // written down.
    const unexplained = report.failed.filter(
      (n) => !Object.prototype.hasOwnProperty.call(EXPLAINED_FAILURES, n),
    );
    expect(
      unexplained,
      `a global refused to be deleted in this browser and nobody has said what it leaves reachable: ` +
        JSON.stringify(full.failedDetail),
    ).toEqual([]);

    // Everything present before is either deleted or failed, and nothing else.
    expect([...report.deleted, ...report.failed].sort()).toEqual(
      [...full.scrubbedPresentBefore].sort(),
    );

    // The names that matter most, called out so a silent narrowing of
    // SCRUBBED_NAMES cannot pass. `importScripts` is the browser-only one: it is
    // a worker's own code loader and Node has never exercised its deletion.
    for (const n of ["Function", "eval", "fetch", "Reflect", "Proxy", "XMLHttpRequest", "Worker"]) {
      expect(report.deleted, `${n} survived the scrub`).toContain(n);
    }
    // And nothing the machine needs went with them.
    for (const n of REALM_KEEP) expect(report.deleted).not.toContain(n);
    expect(SCRUBBED_NAMES).not.toContain("Math");
  });

  it("deletes the names that only a PROTOTYPE-CHAIN delete can reach", () => {
    // THE REGRESSION GUARD FOR THE DEFECT THIS FILE FOUND.
    //
    // On a Node worker global every scrubbable name is an own property, so a
    // plain `delete globalThis[key]` works and the Node suite was green. On a
    // web global it is not: WebIDL puts interface OPERATIONS and ATTRIBUTES on
    // the interface prototype and only interface OBJECTS on the global itself.
    // `delete globalThis.fetch` therefore deleted nothing, returned true, and
    // left `fetch` one hop up the chain. Eighteen names were in that state,
    // including the network, this realm's own code loader, persistent storage,
    // entropy and the fingerprint surface.
    //
    // If this test fails with these names in `failed`, `scrubRealm`'s delete
    // pass has stopped walking the prototype chain and Layer 2 is once again
    // mostly inert in the only environment that ships.
    const report = full.report as NonNullable<WorkerResult["report"]>;

    // A web global has plenty of these. If this ever hits zero, the harness has
    // stopped measuring what it thinks it is measuring.
    expect(
      full.inheritedOnly.length,
      "no scrubbable name is inherited -- is this really a browser worker global?",
    ).toBeGreaterThan(10);

    for (const n of full.inheritedOnly) {
      expect(
        report.deleted,
        `${n} is inherited from a prototype of the global, not an own property. ` +
          `A plain delete cannot remove it, and it is still reachable in the ` +
          `hardened realm.`,
      ).toContain(n);
    }

    // Spelled out as well as generated, because these are the ones whose
    // survival would matter most and a generated list can quietly shrink.
    for (const n of ["fetch", "importScripts", "indexedDB", "caches", "crypto", "navigator"]) {
      expect(full.inheritedOnly, `${n} is no longer inherited in this engine`).toContain(n);
      expect(report.deleted, `${n} survived the scrub`).toContain(n);
    }
  });

  it("neuters all four code constructors", () => {
    const report = full.report as NonNullable<WorkerResult["report"]>;
    // The four constructors are the load-bearing part and are required on every
    // engine. `Error.stackTraceLimit` is a V8 knob: it is present in Chromium
    // and absent in SpiderMonkey, so it is asserted conditionally rather than
    // pinned to a list that could only be right on one engine.
    for (const n of [
      "Function.prototype.constructor",
      "AsyncFunction.prototype.constructor",
      "GeneratorFunction.prototype.constructor",
      "AsyncGeneratorFunction.prototype.constructor",
    ]) {
      expect(report.neutered, `${n} was not neutered`).toContain(n);
    }

    if (report.neutered.includes("Error.stackTraceLimit")) {
      expect(full.frozenSpot.stackTraceLimit).toBe(0);
    } else {
      // No knob to turn. Recorded rather than asserted away: on this engine
      // `new Error().stack` from cart code is whatever the engine gives, and
      // 22-error-stack-sniff.js is the canary that watches it.
      expect(full.frozenSpot.stackTraceLimit).toBeUndefined();
    }
  });

  it("freezes the intrinsics, including the prototypes a cart can reach", () => {
    const report = full.report as NonNullable<WorkerResult["report"]>;
    expect(report.frozen).toBeGreaterThan(50);
    expect(full.frozenSpot.objectPrototype).toBe(true);
    expect(full.frozenSpot.arrayPrototype).toBe(true);
    expect(full.frozenSpot.functionPrototype).toBe(true);
  });

  it("CLOSES ALL SIX KNOWN HOLES, IN A REAL BROWSER", () => {
    // The claim this whole file was written to test. Each canary is compiled by
    // the real `compileCart` (which still works, because it holds the Function
    // constructor captured at module load) and run on a real machine, inside the
    // scrubbed realm of a real Worker in a real engine.
    const byName = new Map(full.canaries.map((c) => [c.name, c]));
    expect([...byName.keys()].sort()).toEqual([...KNOWN_HOLES].sort());

    const stillEscaping: string[] = [];
    for (const name of KNOWN_HOLES) {
      const c = byName.get(name) as WorkerResult["canaries"][number];
      expect(c.compileError, `${name} did not compile after the scrub`).toBeNull();
      // Every one of these canaries catches its own failures and pokes REACH, so
      // reaching the end is how we know it ran rather than died on line one.
      expect(c.reach, `${name} did not run to completion`).toBe(1);
      if (c.flag === 1) stillEscaping.push(name);
    }
    expect(
      stillEscaping,
      "A KNOWN HOLE IS STILL OPEN AFTER A REAL BROWSER SCRUB. Do not weaken this " +
        "assertion: the browser is the deployment target, and a hole that is closed " +
        "in Node and open here is an open hole.",
    ).toEqual([]);

    // 30-intrinsic-mutation reports through NOTE whether Array.prototype was
    // frozen when it looked. That is the positive half of the same fact.
    expect(byName.get("30-intrinsic-mutation.js")?.note).toBe(1);
  });

  it("leaves the runtime running, bit-for-bit, after the scrub", () => {
    // THE IMPORTANT ONE. Hardening must not move a pixel. A scrub that quietly
    // changed behaviour -- a frozen intrinsic taking a different path, a deleted
    // global falling back to something else -- would break determinism in the
    // only realm carts are ever supposed to run in, and it would do it silently.
    expect(full.probe?.error).toBeNull();
    expect(full.probe?.ok).toBe(true);

    const here = unscrubbedRun();
    expect(full.frames).toHaveLength(SMOKE_FRAMES);
    expect(full.frames).toEqual(here.frames);
    expect(full.chain).toBe(here.chain);
    // `present()` too: the frame hash covers the framebuffer, the RGBA sum
    // covers the palette resolution that turns it into pixels.
    expect(full.rgbaSum).toBe(here.rgbaSum);
  });

  it("keeps every REALM_KEEP name that this realm had", () => {
    // Unlike Node, a browser worker global has ALL EIGHT: `self` and
    // `postMessage` exist here, so this is the first realm in which the whole
    // list is actually under test.
    expect([...full.keepPresentAfter].sort()).toEqual([...full.keepPresentBefore].sort());
    for (const n of REALM_KEEP) {
      expect(full.keepPresentAfter, `${n} was scrubbed and the runtime needs it`).toContain(n);
    }
  });

  it("still looks like a worker scope to `installWorker` after the scrub", () => {
    // Node cannot ask this: `isWorkerScope` wants a global `postMessage` and an
    // `onmessage`, which a `node:worker_threads` global does not have. Here the
    // scrub has just run over the real thing, and the runtime's own bootstrap
    // has to survive it -- `postMessage` is in REALM_KEEP precisely for this.
    expect(full.installedOnGlobal).toBe(true);
  });
});

/**
 * Is each name in `REALM_KEEP` actually load-bearing IN A BROWSER?
 *
 * One worker per name: scrub, delete that one name as well, then drive the
 * runtime -- compile, boot, twelve frames, `present()`, `installWorker` against
 * the real global, and a load/step/snapshot round trip through
 * `createMessageHandler`. If that still works, nothing in the exercised paths
 * needed the name.
 *
 * This is the run Node explicitly could not make for two of the eight names.
 * `self` and `postMessage` do not exist on a `node:worker_threads` global, so
 * `scrub-realm.test.ts` records them as "this platform cannot judge them". This
 * platform can.
 */
describe.skipIf(!inBrowser)("REALM_KEEP in a browser worker, one name at a time", () => {
  /**
   * What the probe is expected to show, and why. Anything not listed here is
   * expected to be NEEDED -- so adding a name to REALM_KEEP without a reason
   * fails this test rather than passing it quietly.
   *
   *   Date         worker.ts picks its clock ONCE, at module load: `performance`
   *                exists in a browser worker, so `Date` is the fallback that was
   *                not taken. It is load-bearing only in a realm without
   *                `performance` -- which is why it stays in the list.
   *   console      deliberately a last resort for diagnosing a worker that will
   *                not start. Nothing on the happy path calls it.
   *   Promise      module machinery and future async host calls. The machine is
   *                synchronous, so no path here touches it.
   *   self         the worker's alias for the global object. The runtime reads
   *                `globalThis`, never `self`, so deleting it changes nothing --
   *                and this is the platform that can say so, because `self`
   *                exists here. It stays in REALM_KEEP because a bootstrap
   *                written to the WorkerGlobalScope idiom will reach for it, and
   *                because it costs nothing: it aliases an object `globalThis`
   *                already hands out.
   *
   * `postMessage` is NOT in this list, and that is the browser's answer to a
   * question Node had to leave open: `isWorkerScope` requires it, so deleting it
   * makes `installWorker(factory)` return false and the runtime has no channel
   * to the host at all.
   */
  const NOT_OBSERVED_NEEDED: readonly string[] = ["Date", "console", "Promise", "self"];

  it("has a stated expectation for every name in the list", () => {
    for (const n of NOT_OBSERVED_NEEDED) expect(REALM_KEEP).toContain(n);
  });

  for (const name of REALM_KEEP) {
    it(`${name}: ${NOT_OBSERVED_NEEDED.includes(name) ? "kept, but nothing here reads it" : "the runtime breaks without it"}`, async () => {
      const r = await runWorker(baseJob("probe", [name]));
      expect(r.fatal, "the scrub itself failed").toBeNull();
      // Without this the whole probe is worthless: a `delete` that removed
      // nothing would make every name look "not load-bearing". That is not
      // hypothetical -- it is precisely the defect this file found in the scrub
      // itself, so the probe is pinned against making the same mistake.
      expect(r.deletedExtra, `${name} could not actually be removed from this realm`).toContain(
        name,
      );
      const broke = r.probe?.ok !== true;
      if (NOT_OBSERVED_NEEDED.includes(name)) {
        // If this fails, the name IS needed after all and the table above is
        // wrong -- which is good news for REALM_KEEP and bad news for the
        // comment. Move it out of the list and say what read it.
        expect(broke, `${name} turned out to be load-bearing: ${String(r.probe?.error)}`).toBe(
          false,
        );
      } else {
        // If this fails, a name in REALM_KEEP is not needed by anything the
        // probe drives in a browser. That is attack surface: either widen the
        // probe to cover the path that needs it, or take the name out.
        expect(broke, `${name} was deleted and the runtime carried on regardless`).toBe(true);
      }
    });
  }

  it("the probe passes when nothing extra is deleted", async () => {
    // The control. Without it, every "needed" verdict above could be a probe
    // that is simply broken in a scrubbed realm.
    const r = await runWorker(baseJob("probe", []));
    expect(r.fatal).toBeNull();
    expect(r.probe).toEqual({ ok: true, error: null });
  });
});
