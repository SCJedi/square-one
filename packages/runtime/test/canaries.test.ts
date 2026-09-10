/**
 * The canary suite: every escape attempt in `conformance/canaries/`, run through
 * the real compiler and a real machine.
 *
 * WHAT THIS FILE ASSERTS, AND WHAT IT REFUSES TO ASSERT
 * ----------------------------------------------------
 * It asserts OUTCOMES read out of RAM: a canary sets `FLAG` when it believes it
 * obtained a live reference, and the assertion is about that byte. It does not
 * assert that an escape threw, or what the message said, because a canary with a
 * typo also throws -- and a canary that fails for the wrong reason looks exactly
 * like a canary that passed. `32-control-live-global.js` is the answer to that:
 * it is handed a live global through a doctored ABI, and the suite asserts that
 * the harness catches it. If the control ever comes back clean, nothing else
 * here means anything.
 *
 * The directory is enumerated rather than listed: a `.js` with no manifest entry
 * and a manifest entry with no `.js` are both failures, so neither can be added
 * quietly.
 *
 * SIX CANARIES ARE EXPECTED TO ESCAPE. They are the ones that reach the realm
 * through the `Function` constructor and its relatives, which parameter
 * shadowing provably cannot close -- see the header of sandbox.ts. They are
 * marked `known-hole`, the suite asserts the hole is STILL THERE, and a separate
 * test proves that `scrubRealm`'s neutering closes them. Weakening one to make
 * the suite green would delete the only record that the hole exists.
 */

import { afterAll, describe, expect, it } from "vitest";

import { createMachine } from "../src/machine";
import type { CartApi, CartProgram } from "../src/machine";
import { ADDR } from "../src/memory";
import { CartCompileError, compileCart, neuterCodeConstructors } from "../src/sandbox";

import manifestText from "../../../conformance/canaries/manifest.json?raw";

// `import.meta.glob` is Vite's, so the directory is enumerated identically in
// Node and in a browser -- the same reason golden.test.ts loads its fixture
// through `?raw`. A harness that read the disk in Node and a bundle in the
// browser could not tell "the engine differs" from "the harness differs".
declare global {
  interface ImportMeta {
    glob(
      pattern: string,
      options: { query: string; import: string; eager: true },
    ): Record<string, string>;
  }
}

const sources = import.meta.glob("../../../conformance/canaries/*.js", {
  query: "?raw",
  import: "default",
  eager: true,
});

/** The three bytes a canary reports through. Pinned against the memory map. */
const FLAG = ADDR.USER_RAM + 0;
const REACH = ADDR.USER_RAM + 1;
const NOTE = ADDR.USER_RAM + 2;

const NO_INPUT = new Uint8Array(4);
const FRAMES = 2;

type Expectation = "undefined" | "throws" | "harmless" | "known-hole" | "compile-error" | "control";

interface ManifestEntry {
  attempt: string;
  expect: Expectation;
  note?: string;
  closedBy?: string;
}

const manifest = JSON.parse(manifestText) as Record<string, ManifestEntry>;

/** filename -> source, keyed by basename rather than by glob path. */
const canaries = new Map<string, string>(
  Object.entries(sources).map(([path, src]) => [path.slice(path.lastIndexOf("/") + 1), src]),
);

/**
 * The holes that are open on Layers 0+1 today. Pinned as a list, not a count:
 * a new escape cannot be waved through by editing a number, and a hole that gets
 * closed has to be removed here deliberately.
 */
const KNOWN_HOLES: readonly string[] = [
  "25-function-constructor.js",
  "26-intrinsic-constructor-walk.js",
  "27-getprototypeof-walk.js",
  "28-async-generator-constructors.js",
  "29-constructed-dynamic-import.js",
  "30-intrinsic-mutation.js",
];

/** `30-intrinsic-mutation.js` leaves this on Array.prototype when it succeeds. */
const CANARY_MARKER = "__sq1_canary__";

interface Outcome {
  compileError: unknown;
  threw: unknown;
  ram: Uint8Array | null;
}

/** Compile and run one canary. Never throws: the outcome IS the result. */
function runCanary(name: string, source: string, doctor?: (api: CartApi) => CartApi): Outcome {
  let program: CartProgram;
  try {
    program = compileCart(source, { name });
  } catch (e) {
    return { compileError: e, threw: null, ram: null };
  }

  const machine = createMachine(doctor === undefined ? program : doctored(program, doctor));
  let threw: unknown = null;
  try {
    machine.boot(1);
    for (let f = 0; f < FRAMES; f++) machine.tick(NO_INPUT);
  } catch (e) {
    threw = e;
  }
  return { compileError: null, threw, ram: machine.ram };
}

/**
 * Wrap a program so the cart sees a modified ABI.
 *
 * The wrapper memoises, because `compileCart` refuses to bind one cart to two
 * api objects -- a changing api would mean the cart is poking a machine it is
 * not running on.
 */
function doctored(program: CartProgram, doctor: (api: CartApi) => CartApi): CartProgram {
  let patched: CartApi | null = null;
  const patch = (api: CartApi): CartApi => {
    if (patched === null) patched = doctor(api);
    return patched;
  };
  return {
    boot: (api: CartApi) => program.boot(patch(api)),
    tick: (api: CartApi) => program.tick(patch(api)),
  };
}

afterAll(() => {
  // 30-intrinsic-mutation.js writes a marker to Array.prototype when the realm
  // is not hardened, which it is not in a test runner. Leaving it behind would
  // put a stray enumerable property on every array in the process.
  delete (Array.prototype as unknown as Record<string, unknown>)[CANARY_MARKER];
  expect(CANARY_MARKER in Array.prototype).toBe(false);
});

describe("the canary directory", () => {
  it("has at least twenty escape attempts", () => {
    expect(canaries.size).toBeGreaterThanOrEqual(20);
  });

  it("has a manifest entry for every file and a file for every entry", () => {
    const files = [...canaries.keys()].sort();
    const entries = Object.keys(manifest).sort();
    expect(files.filter((f) => !entries.includes(f))).toEqual([]);
    expect(entries.filter((e) => !files.includes(e))).toEqual([]);
  });

  it("gives every entry an attempt and a known expectation", () => {
    const valid: Expectation[] = [
      "undefined",
      "throws",
      "harmless",
      "known-hole",
      "compile-error",
      "control",
    ];
    for (const [file, entry] of Object.entries(manifest)) {
      expect(entry.attempt, file).toBeTruthy();
      expect(valid, file).toContain(entry.expect);
      // A hole without a stated closer is a hole nobody has decided about.
      if (entry.expect === "known-hole") expect(entry.closedBy, file).toBeTruthy();
    }
  });

  it("reports through the addresses the memory map defines as the cart's own", () => {
    expect(FLAG).toBe(0x7800);
    expect(REACH).toBe(0x7801);
    expect(NOTE).toBe(0x7802);
    expect(ADDR.USER_RAM).toBe(0x7800);
  });
});

describe("every canary, run for real", () => {
  for (const [file, source] of [...canaries.entries()].sort()) {
    const entry = manifest[file];
    if (entry === undefined) continue; // reported by the directory test above

    it(`${file}: ${entry.attempt}`, () => {
      if (entry.expect === "control") {
        // The doctored ABI: a `sys.leak()` the real machine does not have,
        // handing the cart the actual global object.
        const out = runCanary(file, source, (api) => ({
          gfx: api.gfx,
          inp: api.inp,
          snd: api.snd,
          sys: Object.assign({}, api.sys, { leak: () => globalThis }),
        }));
        expect(out.compileError).toBeNull();
        expect(out.threw).toBeNull();
        // THE HARNESS SEES A REAL ESCAPE. If this line ever fails, every other
        // assertion in this file is worthless.
        expect(out.ram?.[FLAG], "the control canary was not detected").toBe(1);
        return;
      }

      const out = runCanary(file, source);

      if (entry.expect === "compile-error") {
        expect(out.compileError).toBeInstanceOf(CartCompileError);
        expect(out.ram).toBeNull();
        return;
      }

      expect(out.compileError, `${file} did not compile`).toBeNull();
      const ram = out.ram as Uint8Array;

      switch (entry.expect) {
        case "undefined":
        case "harmless":
          expect(out.threw, `${file} threw: ${String(out.threw)}`).toBeNull();
          expect(ram[REACH], `${file} did not run to completion`).toBe(1);
          expect(ram[FLAG], `${file} OBTAINED A LIVE REFERENCE`).toBe(0);
          break;

        case "throws":
          expect(out.threw, `${file} was expected to throw and did not`).not.toBeNull();
          expect(ram[FLAG], `${file} OBTAINED A LIVE REFERENCE`).toBe(0);
          break;

        case "known-hole":
          // Asserting the hole is still exactly where the manifest says it is.
          // A known-hole that stops escaping is either good news or a broken
          // canary, and the two are told apart by reading it, not by a green tick.
          expect(
            ram[FLAG],
            `${file} is recorded as a known hole (closed by ${String(entry.closedBy)}) ` +
              `but did not escape. Either it was fixed -- update the manifest and ` +
              `KNOWN_HOLES -- or the canary is broken.`,
          ).toBe(1);
          break;
      }
    });
  }
});

describe("the suite as a whole", () => {
  it("lets nothing but the recorded holes obtain a live reference", () => {
    const escaped: string[] = [];
    for (const [file, source] of canaries) {
      const entry = manifest[file];
      if (entry === undefined || entry.expect === "control" || entry.expect === "compile-error") {
        continue;
      }
      const out = runCanary(file, source);
      if (out.ram !== null && out.ram[FLAG] === 1) escaped.push(file);
    }
    expect(escaped.sort()).toEqual([...KNOWN_HOLES].sort());
  });

  it("keeps the known-hole list and the manifest saying the same thing", () => {
    const fromManifest = Object.entries(manifest)
      .filter(([, e]) => e.expect === "known-hole")
      .map(([f]) => f)
      .sort();
    expect(fromManifest).toEqual([...KNOWN_HOLES].sort());
  });

  it("pins the finding that is recorded rather than fixed", () => {
    // Not an escape, so it does not set FLAG. It is real and it is open, so it
    // is pinned here: a canary's NOTE byte is the only place a finding of this
    // kind can live where someone will trip over it.
    //
    // If this fails, the finding has been FIXED. That is good news, and the
    // thing to do is turn the assertion around into a regression guard and
    // update conformance/canaries/README.md -- not to relax it.
    const stack = runCanary("22", canaries.get("22-error-stack-sniff.js") as string);
    expect(
      stack.ram?.[NOTE],
      "Error().stack is no longer readable from cart code -- update the README",
    ).toBe(1);
  });

  it("keeps state parked on the ABI objects from surviving a tick", () => {
    // This was finding #2 and it is now FIXED, so the pin is inverted into a
    // regression guard rather than deleted.
    //
    // `createMachine` freezes gfx, inp, sys and the api object. That is a
    // DETERMINISM requirement, not a security one: a writable property on an
    // ABI object is machine state outside the 64 KB buffer, so it is not
    // captured by snapshot() and not cleared by restore(), and a rewind would
    // silently stop being bit-exact. See packages/runtime/test/state-containment.test.ts.
    const abi = runCanary("23", canaries.get("23-abi-tamper.js") as string);
    expect(
      abi.ram?.[NOTE],
      "state parked on an ABI object survived a tick again -- machine.ts has " +
        "stopped freezing the api, and rewind is no longer bit-exact",
    ).not.toBe(1);
  });

  it("records a note for every canary whose finding is not just `it was undefined`", () => {
    for (const file of KNOWN_HOLES) {
      expect(manifest[file]?.note, file).toBeTruthy();
    }
  });
});

describe("Layer 2 against the canaries that get out", () => {
  it("neutering the code constructors closes every escape that goes through them", () => {
    // The realm is modified for the duration of this test and restored in a
    // `finally`. No assertion runs inside the window: assertion machinery is
    // exactly the kind of code that might want a Function constructor.
    //
    // 30-intrinsic-mutation.js is excluded because freezing Array.prototype in
    // the runner's realm cannot be undone. sandbox.test.ts covers the freeze
    // path against fake intrinsics instead.
    const through = KNOWN_HOLES.filter((f) => f !== "30-intrinsic-mutation.js");
    const stillEscaping: string[] = [];

    const handle = neuterCodeConstructors({ sealed: false });
    try {
      for (const file of through) {
        const source = canaries.get(file);
        if (source === undefined) continue;
        const out = runCanary(file, source);
        if (out.ram !== null && out.ram[FLAG] === 1) stillEscaping.push(file);
      }
    } finally {
      handle.restore();
    }

    expect(stillEscaping).toEqual([]);
    expect(through.length).toBe(5);
    // The realm came back exactly as it was.
    expect(new Function("return 1")()).toBe(1);
    expect((function () {}).constructor).toBe(Function);
  });
});
