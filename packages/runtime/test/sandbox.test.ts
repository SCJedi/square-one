/**
 * The sandbox, tested from the outside.
 *
 * Two rules govern this file, and both exist because the thing under test is a
 * realm and the test runner lives in one too:
 *
 *   1. NOTHING HERE PERMANENTLY MUTATES THE RUNNER'S REALM. `scrubRealm` is
 *      exercised against a FAKE scope object carrying FAKE intrinsics. The one
 *      test that must touch the real realm -- proving that Layer 2 closes the
 *      Function-constructor hole -- neuters with `sealed: false`, runs the cart
 *      with no assertion inside the window, and restores in a `finally`.
 *   2. THE ASSERTIONS ARE ABOUT OUTCOMES. "It threw" is not evidence that a
 *      cart failed to escape; a typo throws too. Where an escape is being
 *      denied, the cart writes to RAM when it believes it succeeded and the test
 *      reads RAM.
 */

import { afterEach, describe, expect, it } from "vitest";

import { createMachine } from "../src/machine";
import type { CartApi } from "../src/machine";
import { ADDR, RAM_SIZE } from "../src/memory";
import {
  CartCompileError,
  REALM_KEEP,
  SCRUBBED_NAMES,
  SHADOWED_NAMES,
  compileCart,
  neuterCodeConstructors,
  scrubRealm,
} from "../src/sandbox";

/** Where a cart under test reports what it managed to do. */
const FLAG = ADDR.USER_RAM;
const NO_INPUT = new Uint8Array(4);

function run(source: string, frames = 1): Uint8Array {
  const machine = createMachine(compileCart(source, { name: "test" }));
  machine.boot(1);
  for (let f = 0; f < frames; f++) machine.tick(NO_INPUT);
  return machine.ram;
}

describe("compileCart: the bootstrap", () => {
  it("compiles a cart that declares boot and tick, and runs both", () => {
    const ram = run(`
      function boot() { sys.poke(0x7800, 11); }
      function tick() { sys.poke(0x7801, sys.peek(0x7801) + 1); }
    `);
    expect(ram[0x7800]).toBe(11);
    expect(ram[0x7801]).toBe(1);
  });

  it("accepts a cart with no boot -- boot is optional, tick is not", () => {
    const ram = run(`function tick() { sys.poke(0x7800, 5); }`);
    expect(ram[0x7800]).toBe(5);
  });

  it("runs the cart's top level exactly once, before boot", () => {
    // The top level is where a cart's `var`s live (see examples/hello/main.js),
    // so it has to run before boot and never again.
    const ram = run(
      `
      sys.poke(0x7802, sys.peek(0x7802) + 1);
      function boot() { sys.poke(0x7800, sys.peek(0x7802)); }
      function tick() { sys.poke(0x7801, sys.peek(0x7802)); }
    `,
      3,
    );
    expect(ram[0x7802]).toBe(1); // top level ran once
    expect(ram[0x7800]).toBe(1); // and had already run when boot was called
    expect(ram[0x7801]).toBe(1);
  });

  it("compiles with the Function constructor captured at module load, not at call time", () => {
    // The bootstrap order claim, tested the only way it can be: take `Function`
    // away from the realm the way `scrubRealm` does, and compile anyway.
    //
    // The window is synchronous and the descriptor is restored in a `finally`.
    // No `expect` runs inside it -- assertion machinery is exactly the kind of
    // code that might want a Function constructor.
    const desc = Object.getOwnPropertyDescriptor(globalThis, "Function");
    let ram: Uint8Array | null = null;
    let failure: unknown = null;
    try {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete (globalThis as Record<string, unknown>)["Function"];
      ram = run(`function tick() { sys.poke(0x7800, 42); }`);
    } catch (e) {
      failure = e;
    } finally {
      if (desc !== undefined) Object.defineProperty(globalThis, "Function", desc);
    }
    expect(failure).toBeNull();
    expect(ram?.[0x7800]).toBe(42);
    expect(typeof Function).toBe("function"); // the realm is as we found it
  });
});

describe("compileCart: Layer 1 shadowing", () => {
  it("every name in SHADOWED_NAMES is undefined inside a cart", () => {
    // Generated from the list itself, so a name added to SHADOWED_NAMES is
    // covered the moment it is added and a name that stops being shadowed fails
    // here rather than in someone's replay.
    const probes = SHADOWED_NAMES.map(
      (n, i) => `if (typeof ${n} !== "undefined") sys.poke(0x7800 + ${i}, 1);`,
    ).join("\n");
    const ram = run(`function tick() {\n${probes}\n}`);

    const leaked = SHADOWED_NAMES.filter((_n, i) => ram[0x7800 + i] !== 0);
    expect(leaked).toEqual([]);
  });

  it("shadows the names the console's own carts are told not to use", () => {
    // examples/hello/main.js promises authors that these are gone. If one of
    // them came back, that comment would be a lie and a cart could go
    // non-deterministic without its author noticing.
    for (const n of ["Math", "Date", "fetch", "globalThis", "eval", "Function"]) {
      expect(SHADOWED_NAMES).toContain(n);
    }
  });

  it("lists every shadowed name exactly once", () => {
    // The outer function is sloppy, and a sloppy function accepts duplicate
    // parameter names silently. A name listed twice would still be shadowed, so
    // nothing would fail -- but the list is documentation as much as it is code,
    // and a duplicate is how a list stops being read.
    expect(new Set(SHADOWED_NAMES).size).toBe(SHADOWED_NAMES.length);
    for (const n of SHADOWED_NAMES) expect(n).toMatch(/^[A-Za-z_$][A-Za-z0-9_$]*$/);
  });

  it("shadows eval, which cannot be a strict-mode parameter", () => {
    // The nested-function bootstrap exists for this one name. If the wrapper is
    // ever flattened, this test is what says why it cannot be.
    const ram = run(`
      function tick() {
        if (typeof eval !== "undefined") sys.poke(0x7800, 1);
        try { eval("sys.poke(0x7801, 1)"); } catch (e) { sys.poke(0x7802, 1); }
      }
    `);
    expect(ram[0x7800]).toBe(0); // eval is not visible
    expect(ram[0x7801]).toBe(0); // and nothing it was asked to do happened
    expect(ram[0x7802]).toBe(1); // calling undefined threw, as it should
  });

  it("runs cart code in strict mode: no implicit globals, no callee, this is undefined", () => {
    const ram = run(`
      function tick() {
        try { undeclaredGlobal = 1; } catch (e) { sys.poke(0x7800, 1); }
        try { (function () { return arguments.callee; })(); } catch (e) { sys.poke(0x7801, 1); }
        if (this === undefined) sys.poke(0x7802, 1);
        if ((function () { return this; })() === undefined) sys.poke(0x7803, 1);
      }
    `);
    expect(ram[0x7800]).toBe(1);
    expect(ram[0x7801]).toBe(1);
    expect(ram[0x7802]).toBe(1);
    expect(ram[0x7803]).toBe(1);
  });
});

describe("compileCart: failures the host must never see raw", () => {
  it("turns a syntax error into a CartCompileError, never a SyntaxError", () => {
    let thrown: unknown = null;
    try {
      compileCart("function tick( { gfx.cls(0)", { name: "broken" });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(CartCompileError);
    expect(thrown).not.toBeInstanceOf(SyntaxError);
    expect((thrown as CartCompileError).phase).toBe("compile");
    expect((thrown as CartCompileError).message).toContain("broken");
  });

  it("reports the cart's own line and column when the engine gives one", () => {
    // Lexical failures come from the console's own tokenizer, which always has
    // a position. Parse failures depend on the engine: V8 attaches nothing to a
    // Function-constructor SyntaxError, so `line` is absent there rather than
    // guessed. Both outcomes are acceptable; a WRONG line is not.
    let thrown: CartCompileError | null = null;
    try {
      compileCart("function tick() {}\nvar s = 'unterminated;\n");
    } catch (e) {
      thrown = e as CartCompileError;
    }
    expect(thrown).toBeInstanceOf(CartCompileError);
    expect(thrown?.line).toBe(2);
    expect(thrown?.column).toBeGreaterThan(0);
  });

  it("never reports a position outside the cart source", () => {
    const source = "function tick() {\n\n";
    let thrown: CartCompileError | null = null;
    try {
      compileCart(source);
    } catch (e) {
      thrown = e as CartCompileError;
    }
    expect(thrown).toBeInstanceOf(CartCompileError);
    if (thrown?.line !== undefined) {
      expect(thrown.line).toBeGreaterThanOrEqual(1);
      expect(thrown.line).toBeLessThanOrEqual(source.split("\n").length);
    }
  });

  it("a cart with no tick is a shape error that names the problem", () => {
    const program = compileCart("function boot() { gfx.cls(0); }", { name: "no-tick" });
    const machine = createMachine(program);
    let thrown: unknown = null;
    try {
      machine.boot(0);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(CartCompileError);
    expect((thrown as CartCompileError).phase).toBe("shape");
    expect((thrown as CartCompileError).message).toContain("tick");
    expect((thrown as CartCompileError).message).toContain("no-tick");
  });

  it("does not give a cart whose top level threw a second attempt", () => {
    // The first attempt already had its side effects on RAM. Running the top
    // level again would put the machine in a state the cart's author never
    // wrote, which is the same reason worker.ts drops a machine on any fault.
    const machine = createMachine(
      compileCart(`
        sys.poke(0x7800, sys.peek(0x7800) + 1);
        throw new Error("top level says no");
        function tick() {}
      `),
    );
    expect(() => machine.boot(0)).toThrow(/top level says no/);
    expect(machine.ram[0x7800]).toBe(1);
    expect(() => machine.tick(NO_INPUT)).toThrow(/top level says no/);
    expect(machine.ram[0x7800]).toBe(1); // and it did not run again
  });

  it("rejects the import keyword at compile time (Layer 0)", () => {
    // `import()` reads no scope chain, so no parameter can shadow it, and inside
    // a Function-constructed body it resolves. Source rejection is the only
    // portable answer.
    let thrown: CartCompileError | null = null;
    try {
      compileCart('function tick() {\n  import("node:fs");\n}');
    } catch (e) {
      thrown = e as CartCompileError;
    }
    expect(thrown).toBeInstanceOf(CartCompileError);
    expect(thrown?.phase).toBe("compile");
    expect(thrown?.line).toBe(2);
    expect(thrown?.message).toContain("import");
  });

  it("does not reject the word import inside a string or a comment", () => {
    // Token level, not a regex. A cart that draws the word must still compile.
    const ram = run(`
      // this cart does not import anything
      function tick() { var s = "import"; if (s.length === 6) sys.poke(0x7800, 1); }
    `);
    expect(ram[0x7800]).toBe(1);
  });

  it("refuses source that would break out of the wrapper text", () => {
    // A cart is pasted between two strings, so it is template injection waiting
    // to happen. This source closes the strict inner function and continues the
    // outer `return` as a comma expression -- and the outer function is sloppy,
    // where a plain call's `this` is the real global object. No Function
    // constructor is involved, so Layer 2 would not have closed it.
    //
    // compileCart compiles every source on its own as a strict function body
    // first. This one is not one, so it never reaches the wrapper.
    const injection =
      "}, (__sq1_leak = (function () { return this; })()), function () {\n" +
      "function tick() { if (__sq1_leak) sys.poke(0x7800, 1); }\n";

    let thrown: unknown = null;
    try {
      compileCart(injection, { name: "injection" });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(CartCompileError);
    expect((thrown as CartCompileError).phase).toBe("compile");
    // And nothing leaked into the realm on the way past.
    expect("__sq1_leak" in globalThis).toBe(false);
  });

  it("refuses source that leaves a brace open", () => {
    expect(() => compileCart("function tick() { gfx.cls(0);")).toThrow(CartCompileError);
    expect(() => compileCart("function tick() {} }")).toThrow(CartCompileError);
  });

  it("refuses source that is only valid in sloppy mode", () => {
    // The validation parse carries the same "use strict" the cart will run
    // under, so a cart is judged by the strictness it gets.
    expect(() => compileCart("var eval = 1;\nfunction tick() {}")).toThrow(CartCompileError);
    expect(() => compileCart("function tick() { with (gfx) { cls(0); } }")).toThrow(
      CartCompileError,
    );
  });

  it("refuses to bind one compiled cart to two machines", () => {
    // A compiled cart closes over the ABI of the machine that first ran it. A
    // second machine would still be poking the first machine's RAM.
    const program = compileCart("function tick() { sys.poke(0x7800, 1); }");
    const a = createMachine(program);
    const b = createMachine(program);
    a.boot(0);
    a.tick(NO_INPUT);
    expect(() => b.boot(0)).toThrow(/identity/);
  });
});

describe("compileCart: driving a real machine", () => {
  it("produces a framebuffer through createMachine", () => {
    const machine = createMachine(
      compileCart(`
        function boot() { gfx.cls(0); }
        function tick() {
          gfx.cls(3);
          gfx.rect(4, 4, 8, 8, 7, true);
          sys.poke(0x7800, sys.frame() + 1);
        }
      `),
    );
    machine.boot(7);
    machine.tick(NO_INPUT);
    machine.present();

    // Two pixels per byte, both colour 3 outside the rect.
    expect(machine.ram[ADDR.FRAMEBUFFER + 63]).toBe(0x33);
    // Inside the rect: row 4, x = 4..11 -> byte offset (4 << 6) + 2.
    expect(machine.ram[ADDR.FRAMEBUFFER + (4 << 6) + 2]).toBe(0x77);
    // The cart saw frame 0 on its first tick.
    expect(machine.ram[0x7800]).toBe(1);
    // And the presented image is not blank.
    expect(machine.rgba.some((p) => p !== 0)).toBe(true);
  });

  it("keeps all cart-visible state inside RAM, so a snapshot round-trips", () => {
    const machine = createMachine(
      compileCart(`function tick() { sys.poke(0x7800, sys.peek(0x7800) + 1); }`),
    );
    machine.boot(3);
    machine.tick(NO_INPUT);
    machine.tick(NO_INPUT);
    const snap = machine.snapshot();
    machine.tick(NO_INPUT);
    expect(machine.ram[0x7800]).toBe(3);
    machine.restore(snap);
    expect(machine.ram[0x7800]).toBe(2);
    machine.tick(NO_INPUT);
    expect(machine.ram[0x7800]).toBe(3);
    expect(snap.length).toBe(RAM_SIZE);
  });
});

describe("scrubRealm", () => {
  it("deletes what it can from a scope and reports what it cannot", () => {
    // A FAKE scope. Deleting from the real global would take Math away from
    // prng.ts and the runner would stop mid-suite.
    const fake: Record<string, unknown> = {
      fetch: () => undefined,
      XMLHttpRequest: function XHR() {},
      importScripts: () => undefined,
      keepMe: 7,
    };
    Object.defineProperty(fake, "WebSocket", {
      value: function WS() {},
      configurable: false,
      writable: false,
    });

    const report = scrubRealm(fake);

    expect(report.deleted).toContain("fetch");
    expect(report.deleted).toContain("XMLHttpRequest");
    expect(report.deleted).toContain("importScripts");
    expect(report.failed).toContain("WebSocket");
    expect("fetch" in fake).toBe(false);
    expect("WebSocket" in fake).toBe(true); // still there, and said so
    expect(fake["keepMe"]).toBe(7); // untouched: not on the list

    // A name that was never present is neither a success nor a failure.
    expect(report.deleted).not.toContain("localStorage");
    expect(report.failed).not.toContain("localStorage");

    // The runner's own realm is exactly as it was.
    expect(typeof Math.imul).toBe("function");
    expect(typeof globalThis).toBe("object");
  });

  it("never deletes what the machine itself calls at run time", () => {
    // prng.ts:38 calls Math.imul on every sys.rnd; worker.ts:48 reads
    // `performance` per frame. A scrub that took those would kill the machine it
    // is protecting.
    for (const n of REALM_KEEP) expect(SCRUBBED_NAMES).not.toContain(n);
    expect(SCRUBBED_NAMES).toContain("fetch");
    expect(SCRUBBED_NAMES).toContain("Function");
  });

  it("freezes the intrinsics reachable through the scope it is given", () => {
    // Fake constructors, so the freeze pass is real and its blast radius is this
    // object literal.
    class FakeArray {
      push(): number {
        return 0;
      }
    }
    class FakeObject {}
    const fake: Record<string, unknown> = { Array: FakeArray, Object: FakeObject };

    const report = scrubRealm(fake);

    expect(report.frozen).toBeGreaterThanOrEqual(4); // two constructors, two prototypes
    expect(Object.isFrozen(FakeArray.prototype)).toBe(true);
    expect(Object.isFrozen(FakeObject)).toBe(true);
    expect(Object.isFrozen(Array.prototype)).toBe(false); // the real one, untouched
  });

  it("reports no neutering when it is handed a fake scope", () => {
    // There is no way to reach a fake realm's Function.prototype, and saying
    // "neutered" when nothing was would be the report lying.
    const report = scrubRealm({ fetch: () => undefined });
    expect(report.neutered).toEqual([]);
  });

  it("is total: a hostile scope makes it report, not throw", () => {
    const hostile = new Proxy(
      {},
      {
        has(): boolean {
          throw new Error("nope");
        },
        get(): never {
          throw new Error("nope");
        },
        deleteProperty(): never {
          throw new Error("nope");
        },
      },
    );
    const report = scrubRealm(hostile);
    expect(report.failed.length).toBe(SCRUBBED_NAMES.length);
    expect(report.deleted).toEqual([]);
  });
});

describe("Layer 2 closes what Layer 1 cannot", () => {
  // These two tests touch the real realm on purpose, restore it in a `finally`,
  // and make no assertion while it is modified.
  let handle: { restore(): void } | null = null;
  afterEach(() => {
    handle?.restore();
    handle = null;
  });

  it("neutering the code constructors closes the (function(){}).constructor route", () => {
    const source = `
      function tick() {
        try {
          var g = (function () {}).constructor("return this")();
          if (g) sys.poke(0x7800, 1);
        } catch (e) {
          sys.poke(0x7801, 1);
        }
      }
    `;

    // First: the hole is real. This is the control for the control -- if the
    // escape did not work here, the next assertion would prove nothing.
    const open = run(source);
    expect(open[FLAG]).toBe(1);

    // Then: with the constructors neutered, the same cart gets nothing.
    let closed: Uint8Array | null = null;
    handle = neuterCodeConstructors({ sealed: false });
    try {
      closed = run(source);
    } finally {
      handle.restore();
      handle = null;
    }
    expect(closed?.[FLAG]).toBe(0);
    expect(closed?.[0x7801]).toBe(1); // it threw where it used to succeed

    // And the realm came back.
    expect(typeof (function () {}).constructor).toBe("function");
    expect(new Function("return 1")()).toBe(1);
  });

  it("neutering also closes the async and generator constructor routes", () => {
    const source = `
      function tick() {
        var probes = [
          function () { return (function () {}).constructor; },
          function () { return Object.getPrototypeOf(function () {}).constructor; },
          function () { return [].constructor.constructor; },
          function () { return "".constructor.constructor; },
          function () { return Object.constructor; }
        ];
        for (var i = 0; i < probes.length; i++) {
          try {
            var C = probes[i]();
            var f = new C("return this");
            if (f()) sys.poke(0x7800 + i, 1);
          } catch (e) { /* denied */ }
        }
      }
    `;

    const open = run(source);
    const openCount = [0, 1, 2, 3, 4].filter((i) => open[0x7800 + i] === 1).length;

    let closed: Uint8Array | null = null;
    handle = neuterCodeConstructors({ sealed: false });
    try {
      closed = run(source);
    } finally {
      handle.restore();
      handle = null;
    }
    const closedCount = [0, 1, 2, 3, 4].filter((i) => closed?.[0x7800 + i] === 1).length;

    expect(openCount).toBe(5); // all five spellings work on Layer 1 alone
    expect(closedCount).toBe(0); // and all five end at the same neutered property
  });
});

describe("the ABI a cart is handed", () => {
  it("gives a cart gfx, snd, inp and sys, and every one of them is frozen", () => {
    // M4 filled `snd` in. The parameter list already carried it, which is why
    // this is a changed expectation rather than a changed sandbox.
    const ram = run(`
      function tick() {
        if (typeof gfx === "object") sys.poke(0x7800, 1);
        if (typeof inp === "object") sys.poke(0x7801, 1);
        if (typeof sys === "object") sys.poke(0x7802, 1);
        if (typeof snd === "object" && typeof snd.sfx === "function") sys.poke(0x7803, 1);
        if (Object.isFrozen(gfx) && Object.isFrozen(snd)) sys.poke(0x7804, 1);
      }
    `);
    expect([ram[0x7800], ram[0x7801], ram[0x7802], ram[0x7803], ram[0x7804]]).toEqual([
      1, 1, 1, 1, 1,
    ]);
  });

  it("hands the same api object to boot and to every tick", () => {
    // Asserted from outside the cart: the identity check inside compileCart is
    // what would throw, and it does not.
    const seen: CartApi[] = [];
    const program = compileCart("function boot(){} function tick(){}");
    const wrapper = {
      boot(api: CartApi): void {
        seen.push(api);
        program.boot(api);
      },
      tick(api: CartApi): void {
        seen.push(api);
        program.tick(api);
      },
    };
    const machine = createMachine(wrapper);
    machine.boot(0);
    machine.tick(NO_INPUT);
    machine.tick(NO_INPUT);
    expect(seen.length).toBe(3);
    expect(seen[1]).toBe(seen[0]);
    expect(seen[2]).toBe(seen[0]);
  });
});
