/**
 * Layer 2, against a REAL global object.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `canaries.test.ts` proves five of the six known holes are closed by calling
 * `neuterCodeConstructors()` on the TEST RUNNER's realm and putting it back in a
 * `finally`. That is a useful proof of the neutering, and it is not a proof of
 * `scrubRealm`: the runner's realm still has every global it started with, so
 * the delete pass is never exercised, the freeze pass is never exercised, and
 * the ORDER of the three passes is never exercised. `REALM_KEEP` was likewise
 * derived by reading code.
 *
 * The gap was not academic. The first run of this file against a real
 * `node:worker_threads` global found that `scrubRealm()` THREW -- it deleted the
 * `Function` binding from the global object and then `neuterCodeConstructors`
 * named `Function` while building its target list, outside every try/catch, so
 * the whole scrub died before neutering or freezing anything. Layer 2 did
 * nothing at all, and every in-process test was green. See the fix and its
 * comment at `neuterCodeConstructors` in src/sandbox.ts.
 *
 * HOW THE WORKER GETS THE REAL `scrubRealm`
 * -----------------------------------------
 * A copy of the function would test nothing, so the worker runs the real one.
 * `watchdog.test.ts` builds its worker from a source string and `eval: true`,
 * which needs no build step and no file on disk; this file does the same, and
 * the source string is `packages/runtime/src/index.ts` BUNDLED BY ESBUILD at
 * test time (esbuild is what Vite -- and therefore Vitest -- already compiles
 * this repo's TypeScript with). So the bytes in the worker are the bytes in
 * src/, with the types stripped and the imports resolved, and nothing else.
 *
 * The bundle is an IIFE assigned to `SQ1`, and the harness text below is
 * appended to it, so the harness sees the package the way any worker bootstrap
 * would. `require` still works inside the harness because `new Worker(src,
 * { eval: true })` wraps the source in a CommonJS module, where `require` is a
 * local binding rather than a global property -- deleting the global `require`
 * does not take it away.
 *
 * NODE-ONLY, AND THAT IS THE POINT. Layer 2 is worker-only by design and this
 * test spawns a real one. It is not in `vitest.browser.config.ts`'s include list
 * (that list is explicit), and it guards on `process.versions.node` anyway.
 * No config change is needed for it.
 */

import { beforeAll, describe, expect, it } from "vitest";

import { ChainHasher } from "../src/hash";
import { createMachine } from "../src/machine";
import { REALM_KEEP, SCRUBBED_NAMES, compileCart } from "../src/sandbox";

const inNode = typeof process !== "undefined" && process.versions?.node !== undefined;

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

// Enumerated through Vite, exactly as canaries.test.ts does it, so both files
// are reading the same directory the same way.
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
 * The cart the determinism check runs on both sides of the scrub.
 *
 * It has to TOUCH the things a scrubbed realm might have broken, so it draws
 * from `sys.rnd` (which is `Math.imul` in prng.ts, and `Math` is kept), from
 * `sys.sin` (the fixed-point table, `Math.floor` in fixed.ts), through
 * `gfx.rect` into the framebuffer, and pokes RAM outside it. A cart that only
 * cleared the screen would agree across a broken scrub as easily as an intact
 * one.
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
  /** `SCRUBBED_NAMES` that were actually on this global before the scrub. */
  scrubbedPresentBefore: string[];
  /** `REALM_KEEP` names present before the scrub. Not every name exists in Node. */
  keepPresentBefore: string[];
  /** `REALM_KEEP` names present after it. */
  keepPresentAfter: string[];
  /** The real `ScrubReport`, verbatim. */
  report: { deleted: string[]; failed: string[]; frozen: number; neutered: string[] } | null;
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
 * The worker's program, appended to the bundle.
 *
 * Written in ES5-ish style with no template literals, because it is embedded in
 * one here and the nesting is not worth the escaping. It captures `parentPort`
 * and its own `postMessage` BEFORE the scrub, the way a real bootstrap must.
 */
const HARNESS = `
;(function () {
  var wt = require("node:worker_threads");
  var parentPort = wt.parentPort;
  var workerData = wt.workerData;
  var G = globalThis;
  var send = parentPort.postMessage.bind(parentPort);
  var NO_INPUT = new Uint8Array(4);
  var RGBA_BYTES = 128 * 128 * 4;

  function describe(e) {
    if (e && typeof e === "object" && typeof e.name === "string") return e.name + ": " + e.message;
    return String(e);
  }

  var out = {
    scrubbedPresentBefore: [],
    keepPresentBefore: [],
    keepPresentAfter: [],
    report: null,
    frozenSpot: {},
    canaries: [],
    frames: [],
    chain: null,
    rgbaSum: 0,
    probe: null,
    fatal: null,
  };

  function present(n) { return n in G; }

  function runSmoke() {
    var prog = SQ1.compileCart(workerData.smoke, { name: "smoke" });
    var m = SQ1.createMachine(prog);
    var h = new SQ1.ChainHasher();
    m.boot(workerData.seed);
    for (var f = 0; f < workerData.frames; f++) {
      m.tick(NO_INPUT);
      out.frames.push(h.push(m.ram));
    }
    m.present();
    var s = 0;
    for (var i = 0; i < m.rgba.length; i++) s = (s + m.rgba[i]) >>> 0;
    out.rgbaSum = s;
    out.chain = h.digest;
  }

  // The worker plumbing, driven the way host.ts drives it. This is what makes
  // the REALM_KEEP probe mean something: installWorker reads the globalThis
  // binding, and the step path reads performance at CALL time.
  function runPlumbing() {
    var factory = function () {
      return SQ1.createMachine(SQ1.compileCart(workerData.smoke, { name: "plumbing" }));
    };
    // No scope argument: this is the call that needs the globalThis binding.
    SQ1.installWorker(factory);

    var sent = [];
    var fake = { onmessage: null, postMessage: function (m) { sent.push(m); } };
    if (SQ1.installWorker(factory, fake) !== true) throw new Error("installWorker refused a scope");
    fake.onmessage({ data: { t: "load", seed: 1 } });
    fake.onmessage({ data: { t: "step", frame: 0, input: NO_INPUT, out: new ArrayBuffer(RGBA_BYTES) } });
    fake.onmessage({ data: { t: "snapshot" } });
    var kinds = [];
    for (var i = 0; i < sent.length; i++) {
      kinds.push(sent[i].t + (sent[i].t === "fault" ? "(" + sent[i].message + ")" : ""));
    }
    if (kinds.join(",") !== "ready,frame,snapshot") {
      throw new Error("worker plumbing replied " + kinds.join(","));
    }
  }

  try {
    out.scrubbedPresentBefore = SQ1.SCRUBBED_NAMES.filter(present);
    out.keepPresentBefore = SQ1.REALM_KEEP.filter(present);

    // THE LINE THIS FILE EXISTS FOR.
    out.report = SQ1.scrubRealm();

    out.keepPresentAfter = SQ1.REALM_KEEP.filter(present);
    out.frozenSpot = {
      objectPrototype: Object.isFrozen(Object.prototype),
      arrayPrototype: Object.isFrozen(Array.prototype),
      functionPrototype: Object.isFrozen(Object.getPrototypeOf(function () {})),
      stackTraceLimit: Error.stackTraceLimit,
    };

    for (var d = 0; d < workerData.deleteExtra.length; d++) {
      try { delete G[workerData.deleteExtra[d]]; } catch (e) { /* reported by presence */ }
    }

    if (workerData.mode === "full") {
      for (var c = 0; c < workerData.canaries.length; c++) {
        var name = workerData.canaries[c][0];
        var src = workerData.canaries[c][1];
        var entry = { name: name, compileError: null, threw: null, flag: null, reach: null, note: null };
        try {
          var m = SQ1.createMachine(SQ1.compileCart(src, { name: name }));
          try {
            m.boot(1);
            m.tick(NO_INPUT);
            m.tick(NO_INPUT);
          } catch (e2) {
            entry.threw = describe(e2);
          }
          entry.flag = m.ram[0x7800];
          entry.reach = m.ram[0x7801];
          entry.note = m.ram[0x7802];
        } catch (e3) {
          entry.compileError = describe(e3);
        }
        out.canaries.push(entry);
      }
    }

    try {
      runSmoke();
      runPlumbing();
      out.probe = { ok: true, error: null };
    } catch (e4) {
      out.probe = { ok: false, error: describe(e4) };
    }
  } catch (e5) {
    out.fatal = describe(e5);
  }

  send(out);
})();
`;

/**
 * The bundled runtime: built once, on first use, and reused by every worker in
 * this file. Lazy rather than a `beforeAll` so that no describe block in here
 * depends on another one having run first.
 */
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

/** Run one job in a fresh worker. Rejects only if the worker never answers. */
async function runWorker(job: Job): Promise<WorkerResult> {
  const { Worker } = await import("node:worker_threads");
  const w = new Worker((await getBundle()) + HARNESS, { eval: true, workerData: job });
  try {
    return await new Promise<WorkerResult>((resolve, reject) => {
      w.on("message", (m: WorkerResult) => resolve(m));
      w.on("error", (e: Error) => reject(e));
      w.on("exit", (code: number) => reject(new Error(`worker exited with ${code}`)));
    });
  } finally {
    await w.terminate();
  }
}

/** The same smoke cart, in this process, in a realm nobody has scrubbed. */
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

describe.skipIf(!inNode)("scrubRealm on a real worker global", () => {
  let full: WorkerResult;

  beforeAll(async () => {
    full = await runWorker(baseJob("full"));

    // The observed report is a deliverable in its own right, so the run prints
    // it. A `failed` list that grows on a future Node is the kind of thing
    // nobody notices in a green build unless it is on the screen.
    // eslint-disable-next-line no-console
    console.log("scrubRealm on a real worker global:", JSON.stringify(full.report));
  });

  it("completes without throwing, on a realm it has just deleted `Function` from", () => {
    // THE REGRESSION GUARD FOR THE DEFECT THIS FILE FOUND. `scrubRealm` deletes
    // the global `Function` before it neuters the code constructors; anything in
    // the neuter or freeze pass that names a scrubbed global by identifier is a
    // ReferenceError that kills the entire scrub. In-process tests cannot see
    // this, because they never delete the binding.
    expect(full.fatal, "scrubRealm threw on a real global").toBeNull();
    expect(full.report).not.toBeNull();
    expect(full.report?.deleted).toContain("Function");
  });

  it("deletes every scrubbed name that was there, and fails on none of them", () => {
    const report = full.report as NonNullable<WorkerResult["report"]>;

    // `failed` is a FACT, not a crash: a non-configurable global that will not
    // delete would belong here, and the right response is to record it and say
    // which capability it leaves reachable. On Node 24's worker global the list
    // is empty -- every one of the 40 scrubbable names present was configurable.
    // If this ever fails, do not delete the assertion: add the name to a
    // documented allowlist here and write down what it exposes.
    expect(report.failed, "a global refused to be deleted -- record it, do not hide it").toEqual(
      [],
    );

    // Everything present before is either deleted or failed, and nothing else.
    expect([...report.deleted].sort()).toEqual([...full.scrubbedPresentBefore].sort());

    // The names that matter most, called out so a silent narrowing of
    // SCRUBBED_NAMES cannot pass.
    for (const n of ["Function", "eval", "process", "require", "fetch", "Reflect", "Proxy"]) {
      expect(report.deleted, `${n} survived the scrub`).toContain(n);
    }
    // And nothing the machine needs went with them.
    for (const n of REALM_KEEP) expect(report.deleted).not.toContain(n);
    expect(SCRUBBED_NAMES).not.toContain("Math");
  });

  it("neuters all four code constructors and the stack-trace leak", () => {
    const report = full.report as NonNullable<WorkerResult["report"]>;
    expect([...report.neutered].sort()).toEqual(
      [
        "AsyncFunction.prototype.constructor",
        "AsyncGeneratorFunction.prototype.constructor",
        "Error.stackTraceLimit",
        "Function.prototype.constructor",
        "GeneratorFunction.prototype.constructor",
      ].sort(),
    );
    expect(full.frozenSpot.stackTraceLimit).toBe(0);
  });

  it("freezes the intrinsics, including the prototypes a cart can reach", () => {
    const report = full.report as NonNullable<WorkerResult["report"]>;
    expect(report.frozen).toBeGreaterThan(50);
    expect(full.frozenSpot.objectPrototype).toBe(true);
    expect(full.frozenSpot.arrayPrototype).toBe(true);
    expect(full.frozenSpot.functionPrototype).toBe(true);
  });

  it("CLOSES ALL SIX KNOWN HOLES", () => {
    // The claim this whole file was written to test. Each canary is compiled by
    // the real `compileCart` (which still works, because it holds the Function
    // constructor captured at module load) and run on a real machine, inside the
    // scrubbed realm.
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
    expect(stillEscaping, "a known hole is STILL OPEN after a real scrub").toEqual([]);

    // 30-intrinsic-mutation reports through NOTE whether Array.prototype was
    // frozen when it looked. That is the positive half of the same fact.
    expect(byName.get("30-intrinsic-mutation.js")?.note).toBe(1);
  });

  it("leaves the runtime running, bit-for-bit, after the scrub", () => {
    // THE IMPORTANT ONE. A scrub that quietly changed behaviour -- a frozen
    // intrinsic taking a different path, a deleted global falling back to
    // something else -- would break determinism everywhere, and it would do it
    // silently, in the only realm carts are ever supposed to run in.
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
    // `self` and `postMessage` are browser-worker names: a Node worker global
    // has neither, so they are absent BEFORE the scrub and their absence
    // afterwards is not a deletion. Compare against what was actually there.
    expect(full.keepPresentAfter.sort()).toEqual([...full.keepPresentBefore].sort());
    for (const n of ["Math", "Date", "performance", "globalThis", "console", "Promise"]) {
      expect(full.keepPresentAfter, `${n} was scrubbed and the runtime needs it`).toContain(n);
    }
  });
});

/**
 * Is each name in `REALM_KEEP` actually load-bearing?
 *
 * One worker per name: scrub, then delete that one name as well, then drive the
 * runtime -- compile, boot, twelve frames, `present()`, `installWorker` with no
 * scope argument, and a load/step/snapshot round trip through
 * `createMessageHandler`. If that still works, nothing in the exercised paths
 * needed the name.
 *
 * This can only ever prove NEEDED. "Not observed needed" is the honest reading
 * of the other outcome, and the table below records which is which, because a
 * name kept for no reason is attack surface and a name kept for a reason that is
 * only true on another platform is a fact worth writing down rather than acting
 * on.
 */
describe.skipIf(!inNode)("REALM_KEEP, one name at a time", () => {
  /**
   * What the probe is expected to show, and why. Anything not listed here is
   * expected to be NEEDED -- so adding a name to REALM_KEEP without a reason
   * fails this test rather than passing it quietly.
   *
   *   Date         worker.ts picks its clock ONCE, at module load: `performance`
   *                exists in a Node worker, so `Date` is the fallback that was
   *                not taken. It is load-bearing only in a realm without
   *                `performance`, which is exactly why it stays in the list --
   *                but on this platform nothing reads it.
   *   console      deliberately a last resort for diagnosing a worker that will
   *                not start. Nothing on the happy path calls it.
   *   Promise      module machinery and future async host calls. The machine is
   *                synchronous, so no path here touches it.
   *   self         a browser-worker alias for the global. Absent in Node, so
   *                deleting it is a no-op and this platform cannot judge it.
   *   postMessage  the same: a Node worker talks through `parentPort`, not
   *                through a global `postMessage`, so it is absent here.
   */
  const NOT_OBSERVED_NEEDED: readonly string[] = ["Date", "console", "Promise", "self", "postMessage"];

  it("has a stated expectation for every name in the list", () => {
    for (const n of NOT_OBSERVED_NEEDED) expect(REALM_KEEP).toContain(n);
  });

  for (const name of REALM_KEEP) {
    it(`${name}: ${NOT_OBSERVED_NEEDED.includes(name) ? "kept, but nothing here reads it" : "the runtime breaks without it"}`, async () => {
      const r = await runWorker(baseJob("probe", [name]));
      expect(r.fatal, "the scrub itself failed").toBeNull();
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
        // probe drives. That is attack surface: either widen the probe to cover
        // the path that needs it, or take the name out of REALM_KEEP.
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
