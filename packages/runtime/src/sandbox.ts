/**
 * The sandbox: turning a stranger's JavaScript into a `CartProgram`.
 *
 * A cart is source text written by someone you will never meet, and this file is
 * the whole of what stands between that text and the machine running it. It is
 * therefore written to be read sceptically. Where a defence is partial, the
 * comment says so; a sandbox whose documentation overstates it is worse than one
 * that is plainly labelled, because the overstatement is what stops the next
 * person adding the layer that was actually missing.
 *
 * ===========================================================================
 * THREE LAYERS, AND THEY ARE NOT THE SAME
 * ===========================================================================
 *
 * LAYER 0 - SOURCE REJECTION.  Portable, always on, `rejectForbiddenSyntax`.
 *   Some capabilities are syntax, not names, and a name cannot shadow syntax.
 *   `import("node:fs")` is the one that matters: it is a keyword expression, it
 *   ignores every binding in scope, and inside a Function-constructed body it
 *   RESOLVES -- in Node it hands the cart the filesystem, in a browser it is a
 *   network fetch. So the source is tokenized with the console's own normative
 *   tokenizer and any `import` or `export` keyword is a compile error. Token
 *   level, not a regex: a regex would fire on the word in a comment and miss
 *   nothing that matters. The known tokenizer limitation (regex-versus-division,
 *   see tokenize.ts L1) can only make this check FIRE WHEN IT NEED NOT, never
 *   miss, because in all three wrong cases it lexes more code, not less.
 *
 * LAYER 1 - PARAMETER SHADOWING.  Portable, always on, applied by `compileCart`.
 *   Every dangerous global is a PARAMETER of the compiled function, passed
 *   `undefined`. Inside the cart the name resolves to the parameter, so `Math`
 *   is `undefined` no matter what the realm holds. This is the layer that works
 *   identically in Node, in a browser, in a Worker and under a test runner, and
 *   it is the layer that makes carts DETERMINISTIC: no clock, no entropy, no
 *   platform.
 *
 *   WHAT LAYER 1 DOES NOT BUY, EVER:
 *   It hides names. It cannot hide the object graph. `(function(){}).constructor`
 *   is the real `Function` constructor no matter what is in scope, and from it a
 *   cart re-acquires the real global object in one line. `[].constructor`,
 *   `"".constructor`, `Object.constructor` and `Object.getPrototypeOf(f)` are the
 *   same route with more steps. Shadowing `Object` and `Array` too would change
 *   nothing, because `({}).constructor.constructor` needs no global at all.
 *   `eval` is worse still: a strict-mode function may not have a parameter named
 *   `eval`, so it is shadowed by a trick (see BOOTSTRAP below) that works -- but
 *   the general lesson stands. ON LAYER 1 ALONE, A HOSTILE CART GETS OUT. Layer 1
 *   is a determinism boundary and an honest-mistake boundary. It is not a
 *   security boundary by itself.
 *
 * LAYER 2 - REALM HARDENING.  Worker-only, applied by `scrubRealm`.
 *   Deletes the globals, neuters the four `Function`-constructor re-acquisition
 *   paths, and freezes the intrinsics. This is the layer that closes what Layer 1
 *   cannot, and it CANNOT run in-process: deleting `Math` or neutering
 *   `Function.prototype.constructor` in the test runner's own realm would break
 *   the runner. It belongs in the worker entry, where the realm hosts exactly one
 *   cart and nothing else:
 *
 *       import { installWorker, compileCart, scrubRealm } from "@sq1/runtime";
 *       const program = compileCart(source);   // compiles: needs Function
 *       scrubRealm();                          // then, and only then, harden
 *       installWorker(() => createMachine(program));
 *
 *   `conformance/canaries/` records which escapes each layer closes. The ones
 *   marked `known-hole` are open under Layers 0+1 and closed by Layer 2; that is
 *   not a bug list, it is the specification of why Layer 2 exists.
 *
 * ===========================================================================
 * THE BOOTSTRAP, AND WHY THE ORDER IS THE ORDER
 * ===========================================================================
 *
 *   1. Capture `Function` at module load, BEFORE anything is scrubbed. You
 *      cannot scrub first and compile after, because compiling needs `Function`,
 *      and Layer 2 deletes the global binding. The captured reference survives.
 *   2. Reject forbidden syntax (Layer 0).
 *   3. Validate the source ON ITS OWN as a strict function body, so that
 *      embedding it in the wrapper cannot be an injection (see below).
 *   4. Compile with every dangerous name as a shadowing parameter (Layer 1).
 *   5. Instantiate with `undefined` for each shadowed name and the real ABI.
 *   6. Verify the shape: `tick` MUST be a function; `boot` MAY be absent.
 *
 * Steps 1-4 happen in `compileCart`, so a syntax error is a compile error and
 * not a mystery at frame 900. Steps 5-6 happen on the first `boot`/`tick`,
 * because instantiation binds the ABI and the ABI does not exist until a machine
 * hands it over.
 *
 * WHY THE COMPILED FUNCTION IS NESTED
 * The obvious shape -- one strict function whose parameters are the shadowed
 * names -- does not compile. `new Function("eval", '"use strict"; ...')` is a
 * SyntaxError in every engine: a directive prologue makes the PARAMETER LIST
 * strict too, and strict code may not bind the name `eval`. So the outer
 * function is sloppy and holds the parameters, and the cart source lives in a
 * strict inner function that closes over them:
 *
 *     function outer(Math, ..., eval, gfx, snd, inp, sys) {   // sloppy
 *       return function () { "use strict"; <cart source> };   // strict
 *     }
 *
 * The cart is strict (no `with`, no accidental globals, `this` is `undefined`,
 * `arguments.callee` throws) AND `eval` is shadowed. No cart code ever runs in
 * the sloppy scope: the only sloppy statement is the `return` above.
 *
 * THE SLOPPY OUTER SCOPE IS SAFE ONLY BECAUSE OF THE VALIDATION STEP.
 * A cart is source text being pasted between two strings, so it is template
 * injection waiting to happen. Source beginning `}, evil(), function () {` closes
 * the inner function and continues the outer `return` as a comma expression --
 * and `evil()` then runs in the SLOPPY scope, where a plain function call's
 * `this` is the real global object. That escape needs no `Function` constructor,
 * so Layer 2 would not close it: it would hand a hostile cart the hardened
 * global, which still carries `postMessage`, `console` and `Date` by design
 * (see REALM_KEEP).
 *
 * `validateStandaloneBody` closes it, provably rather than by pattern-matching:
 * the source is first compiled ON ITS OWN as a function body. Source that parses
 * as a complete FunctionBody has balanced braces by definition, so once embedded
 * it cannot terminate the function it is inside, nor leave one open. The engine's
 * own parser is the check.
 *
 * IF YOU EVER REMOVE THAT VALIDATION, you must also make the outer function
 * strict -- and then `eval` cannot be shadowed at all and becomes a hole that
 * only Layer 2 closes. The two decisions are one decision.
 */

import { TokenizeError, tokenize } from "@sq1/core";

import type { CartApi, CartProgram } from "./machine";

/**
 * The real `Function` constructor, captured at module load.
 *
 * THIS LINE IS THE BOOTSTRAP. It runs when the module is evaluated, which is
 * before any worker entry has had a chance to call `scrubRealm`, so it holds the
 * only reference that survives the scrub. Compiling a cart after hardening is
 * possible only because of it.
 */
const CapturedFunction: FunctionConstructor = Function;

/** Compile-time knobs. `name` appears in error messages and nowhere else. */
export interface CompileOptions {
  readonly name?: string;
}

/**
 * A cart that will not compile, or will not run.
 *
 * `phase` says which: `"compile"` is the source (forbidden syntax, or the engine
 * refused to parse it), `"shape"` is the contract (no top-level `tick`).
 *
 * `line`/`column` are 1-based and refer to the CART SOURCE, not to the wrapper.
 * They are present when the engine gave a position that could be translated
 * with confidence and absent otherwise -- see `positionOf`. Absent beats wrong:
 * a position that points at the wrong line sends the author hunting in the wrong
 * place, which is worse than sending them to read their whole file.
 *
 * (`| undefined` on the optional fields is required by `exactOptionalPropertyTypes`,
 * which otherwise forbids assigning `undefined` to an optional property.)
 */
export class CartCompileError extends Error {
  readonly phase: "compile" | "shape";
  readonly line?: number | undefined;
  readonly column?: number | undefined;

  constructor(message: string, phase: "compile" | "shape", line?: number, column?: number) {
    super(message);
    this.name = "CartCompileError";
    this.phase = phase;
    this.line = line;
    this.column = column;
    // Keeps `instanceof` working if this file is ever downlevelled, matching
    // TokenizeError in core.
    Object.setPrototypeOf(this, CartCompileError.prototype);
  }
}

/**
 * Every global name a cart may not see, shadowed as a parameter of the compiled
 * function (Layer 1).
 *
 * The list is grouped by WHY, because a name with no reason attached is a name
 * nobody dares remove. Two different reasons are mixed in here on purpose:
 *
 *   CAPABILITY   the name reaches something outside the machine (network, disk,
 *                other threads, the host page). Removing it is security.
 *   DETERMINISM  the name reaches something that differs between two runs or two
 *                engines (clocks, entropy, locale, GC, scheduling). Removing it
 *                is what makes a replay recorded in Chrome play back in Firefox.
 *
 * A name that is only a determinism risk still belongs here: a cart that reads
 * `Date.now()` is not malicious, it is broken, and it breaks silently months
 * later in someone else's replay. Better it is `undefined` on line one.
 *
 * `Reflect` and `Proxy` are here because they are RE-ACQUISITION tools, not
 * because they are dangerous alone: `Reflect.get(globalThis, "fetch")` needs
 * `globalThis` to be reachable, and a `Proxy` around an ABI object is a way to
 * watch or forge calls into the machine. Shadowing them raises the cost of the
 * routes Layer 2 closes properly.
 *
 * WHAT IS DELIBERATELY *NOT* HERE: `Object`, `Array`, `String`, `Number`,
 * `JSON`, `Symbol`, `Error`, `RegExp`, `Map`, `Set`. They are the language, a
 * cart needs them, and hiding them would buy exactly nothing -- `({}).constructor`
 * reaches `Object` with no global binding involved. Their re-acquisition routes
 * are closed at Layer 2 or not at all.
 */
export const SHADOWED_NAMES: readonly string[] = Object.freeze([
  // --- determinism: clocks, entropy, locale, GC, scheduling -----------------
  "Math", // CAPABILITY-free but fatal: Math.random, and Math.sin is not bit-specified
  "Date",
  "performance",
  "crypto",
  "Intl",
  "WeakRef", // observing GC is observing the host's memory pressure
  "FinalizationRegistry",
  "Atomics", // with SharedArrayBuffer, a high-resolution timer
  "SharedArrayBuffer",
  "Promise", // a cart is synchronous; microtasks are ordering the machine cannot replay
  "setTimeout",
  "setInterval",
  "clearTimeout",
  "clearInterval",
  "setImmediate",
  "queueMicrotask",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "requestIdleCallback",

  // --- capability: the network ---------------------------------------------
  "fetch",
  "XMLHttpRequest",
  "WebSocket",
  "EventSource",
  "Request",
  "Response",
  "Headers",
  "navigator", // sendBeacon, userAgent, connection - fingerprint and exfiltration

  // --- capability: other code, other threads --------------------------------
  "importScripts", // a worker's own loader: pulls arbitrary code into this realm
  "Worker",
  "SharedWorker",
  "BroadcastChannel",
  "MessageChannel",
  "MessagePort",
  "postMessage", // the host protocol channel: a cart must not speak on it
  "WebAssembly", // another compiler, reachable from a string

  // --- capability: storage that outlives the machine ------------------------
  "localStorage",
  "sessionStorage",
  "indexedDB",
  "caches",
  "Blob",
  "File",
  "FileReader",
  "URL", // createObjectURL is a way to mint code and data URLs
  "Notification",

  // --- the realm itself, and the tools for getting back to it ---------------
  "globalThis",
  "self",
  "window",
  "document",
  "location",
  "parent",
  "top",
  "frames",
  "eval", // shadowed via the sloppy outer function; see the header
  "Function",
  "Reflect",
  "Proxy",

  // --- Node, when a cart is being run by a tool rather than a player --------
  "process",
  "require",
  "module",
  "exports",
  "global",
  "Buffer",
  "__dirname",
  "__filename",

  // --- host I/O -------------------------------------------------------------
  // A cart has no output but the framebuffer and no input but `inp`. `console`
  // is a side channel into the host's logs and a way to make a player's browser
  // unusable; if carts ever need diagnostics it will be a `sys.` call that the
  // machine can see, count and record.
  "console",
  "alert",
  "confirm",
  "prompt",
  "structuredClone",
  "atob",
  "btoa",
  "close", // in a worker scope, terminates the worker
  "addEventListener",
  "removeEventListener",
  "dispatchEvent",
]);

/**
 * Names `scrubRealm` must NOT delete, and why. Each one is load-bearing for the
 * runtime ITSELF, which lives in the same realm as the cart it is hardening
 * against. Deleting these does not stop a cart -- Layer 1 already denies the
 * cart the names -- it stops the machine.
 *
 *   Math         prng.ts:38 `Math.imul`, fixed.ts:111 `Math.floor`,
 *                hash.ts:278 `Math.min`. Called on every `sys.rnd`.
 *   Date         worker.ts:49, the fallback clock for the `tookMs` diagnostic.
 *   performance  worker.ts:48, the same clock, resolved at CALL time.
 *   globalThis   worker.ts:197,208 - how `installWorker` finds the worker scope.
 *   self         the same object under its worker name.
 *   postMessage  worker.ts:211 - the only channel back to the host.
 *   console      the last resort for diagnosing a worker that will not start.
 *   Promise      module machinery and any future async host call; not a
 *                capability, and a cart cannot name it anyway.
 *
 * This is the tuning knob. If a bundle stops working after a scrub, the fix is a
 * documented entry here with a file:line, never a silent widening.
 */
export const REALM_KEEP: readonly string[] = Object.freeze([
  "Math",
  "Date",
  "performance",
  "globalThis",
  "self",
  "postMessage",
  "console",
  "Promise",
]);

/** What `scrubRealm` attempts to delete: the shadow list minus what the machine needs. */
export const SCRUBBED_NAMES: readonly string[] = Object.freeze(
  SHADOWED_NAMES.filter((n) => !REALM_KEEP.includes(n)),
);

/**
 * Intrinsics `scrubRealm` freezes, resolved THROUGH THE SCOPE it was given.
 *
 * Freezing is defence in depth for the case where a cart has already re-acquired
 * the realm: it stops `Array.prototype.push` being replaced under the runtime's
 * feet. It is not a boundary on its own.
 */
const INTRINSIC_NAMES: readonly string[] = Object.freeze([
  "Object",
  "Function",
  "Array",
  "String",
  "Number",
  "Boolean",
  "Symbol",
  "BigInt",
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "ReferenceError",
  "EvalError",
  "URIError",
  "RegExp",
  "Map",
  "Set",
  "WeakMap",
  "WeakSet",
  "Promise",
  "Date",
  "ArrayBuffer",
  "DataView",
  "Uint8Array",
  "Int8Array",
  "Uint8ClampedArray",
  "Int16Array",
  "Uint16Array",
  "Int32Array",
  "Uint32Array",
  "Float32Array",
  "Float64Array",
  "JSON",
  "Math",
  "Reflect",
]);

/** Keywords a cart source may not contain at all. See LAYER 0 in the header. */
const FORBIDDEN_KEYWORDS: readonly string[] = Object.freeze(["import", "export"]);

// ---------------------------------------------------------------------------
// Layer 0: source rejection
// ---------------------------------------------------------------------------

/**
 * Reject source containing syntax no binding can shadow.
 *
 * `import(...)` is a keyword expression: it does not read the scope chain, so
 * every parameter in `SHADOWED_NAMES` is irrelevant to it, and inside a
 * Function-constructed body it works. `export` cannot appear in a function body
 * at all, so rejecting it here only replaces an engine SyntaxError with a
 * sentence that says why.
 *
 * @throws {CartCompileError} phase `"compile"`, with the token's line and column.
 */
function rejectForbiddenSyntax(source: string, name: string): void {
  let tokens;
  try {
    tokens = tokenize(source).tokens;
  } catch (e) {
    if (e instanceof TokenizeError) {
      throw new CartCompileError(
        `cart "${name}": ${e.message}`,
        "compile",
        e.line,
        e.col,
      );
    }
    throw e;
  }

  for (const t of tokens) {
    if (t.type === "keyword" && FORBIDDEN_KEYWORDS.includes(t.value)) {
      const why =
        t.value === "import"
          ? "dynamic import reads no scope chain, so no binding can shadow it, and " +
            "it would reach the filesystem in Node and the network in a browser"
          : "a cart is a script, not a module: it declares boot and tick and is " +
            "given gfx, snd, inp and sys";
      throw new CartCompileError(
        `cart "${name}": the \`${t.value}\` keyword is not allowed in a cart (${why})`,
        "compile",
        t.line,
        t.col,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Layer 1: compile
// ---------------------------------------------------------------------------

/** The ABI namespaces, in the order they are appended to the parameter list. */
const ABI_NAMES: readonly string[] = Object.freeze(["gfx", "snd", "inp", "sys"]);

/**
 * The wrapper around the cart source. Two lines before the source, which is what
 * `PROLOGUE_LINES` counts -- derived from the string rather than typed as a
 * number, so editing the wrapper cannot silently move every reported line.
 */
const PROLOGUE = 'return function () {\n"use strict";\n';
const EPILOGUE =
  '\n;return { boot: typeof boot === "function" ? boot : undefined,' +
  ' tick: typeof tick === "function" ? tick : undefined };\n}';
const PROLOGUE_LINES = PROLOGUE.split("\n").length - 1;

/**
 * The strictness prologue used when validating the source on its own. One line,
 * so a reported position maps back with the same arithmetic.
 */
const VALIDATE_PROLOGUE = '"use strict";\n';
const VALIDATE_PROLOGUE_LINES = 1;

/**
 * Compile the source ON ITS OWN, as a strict function body, and throw it away.
 *
 * This is the step that makes the wrapper safe to build by string concatenation
 * (see THE SLOPPY OUTER SCOPE in the header). A source that parses as a complete
 * FunctionBody cannot contain an unmatched brace, so embedding it cannot close
 * the function around it or leave one hanging open.
 *
 * It also means a cart author gets a position from the tokenizer or from the
 * engine for the source they actually wrote, before any wrapper text is involved,
 * and that the strictness a cart is judged by is the strictness it will run
 * under: `var eval = 1` and octal literals are refused here rather than in the
 * second, harder-to-map compile.
 *
 * The cost is one extra parse of the cart at load time. A cart is at most a few
 * thousand tokens and this happens once.
 */
function validateStandaloneBody(source: string, name: string): void {
  try {
    new CapturedFunction(VALIDATE_PROLOGUE + source);
  } catch (e) {
    throw compileErrorFrom(e, source, name, VALIDATE_PROLOGUE_LINES);
  }
}

/** What the compiled outer function returns: the strict inner, uncalled. */
type CartFactory = (...args: unknown[]) => () => unknown;

/** The shape the inner function returns once the cart's top level has run. */
interface CartExports {
  boot?: unknown;
  tick?: unknown;
}

/**
 * Compile cart source into something `createMachine` accepts.
 *
 * Layer 0, the standalone validation and Layer 1 are applied here, in that
 * order, and none of them is optional. Instantiation is lazy: the returned
 * program compiles now and binds the ABI on the first `boot` or `tick`, because
 * the ABI belongs to a machine that may not exist yet.
 *
 * WHAT THIS DOES NOT DO: harden the realm. A cart compiled here and run in this
 * process is denied every dangerous NAME and nothing else -- it can still reach
 * the realm through `(function(){}).constructor`. Running an untrusted cart means
 * running it in a worker that has called `scrubRealm`.
 *
 * @throws {CartCompileError} phase `"compile"` for forbidden syntax or a parse
 *   failure. A raw `SyntaxError` never escapes into the host.
 */
export function compileCart(source: string, opts?: CompileOptions): CartProgram {
  const name = opts?.name ?? "cart";

  rejectForbiddenSyntax(source, name);
  validateStandaloneBody(source, name);

  const params = [...SHADOWED_NAMES, ...ABI_NAMES];
  const body = PROLOGUE + source + EPILOGUE;

  let factory: CartFactory;
  try {
    factory = new CapturedFunction(...params, body) as unknown as CartFactory;
  } catch (e) {
    // Reached only for something the standalone parse accepted and the wrapped
    // one did not. Nothing known does that; if a cart ever lands here, the
    // wrapper and the validation have drifted apart and that is worth knowing.
    throw compileErrorFrom(e, source, name, PROLOGUE_LINES);
  }

  // Bound on first contact with a machine and never rebound.
  let boundApi: CartApi | null = null;
  let cartBoot: ((...a: never[]) => unknown) | null = null;
  let cartTick: ((...a: never[]) => unknown) | null = null;
  /**
   * Set when instantiation failed, and rethrown on every later call.
   *
   * A cart's top level runs exactly once, so a top level that threw must not get
   * a second attempt: the first attempt already had its side effects on RAM, and
   * running it again would put the machine in a state the cart's own author
   * never wrote. worker.ts drops a machine on any fault for the same reason.
   */
  let instantiationError: unknown = null;

  function instantiate(api: CartApi): void {
    if (instantiationError !== null) throw instantiationError;

    if (boundApi !== null) {
      // The api object is stable for the life of a machine (machine.ts builds it
      // once, in `createMachine`). A different object means this program is being
      // driven by a second machine while still holding the first machine's RAM
      // through its bound `sys` -- every poke would land in the wrong 64 KB.
      // Compile a second program instead; compiling is cheap and sharing is not.
      if (api !== boundApi) {
        throw new Error(
          `cart "${name}": the ABI changed identity between calls. ` +
            `A compiled cart binds to one machine; compile it again for another.`,
        );
      }
      return;
    }

    // Step 5: undefined for every shadowed name, the real objects for the ABI.
    // `snd` does not exist on CartApi yet (M4 adds it); reading it through an
    // optional lookup means it starts flowing the day it appears, with no edit
    // here.
    const shadows = SHADOWED_NAMES.map(() => undefined);
    const withSnd = api as CartApi & { snd?: unknown };

    let exportsObj: CartExports | null | undefined;
    try {
      const inner = factory(...shadows, api.gfx, withSnd.snd, api.inp, api.sys);
      exportsObj = inner() as CartExports | null | undefined;
    } catch (e) {
      instantiationError = e;
      throw e;
    }

    // Step 6: verify the shape.
    const tick = exportsObj?.tick;
    const boot = exportsObj?.boot;
    if (typeof tick !== "function") {
      instantiationError = new CartCompileError(
        `cart "${name}": no top-level \`function tick()\`. ` +
          `A cart must declare \`function tick() { ... }\`; \`function boot()\` is optional.`,
        "shape",
      );
      throw instantiationError;
    }

    boundApi = api;
    cartTick = tick as (...a: never[]) => unknown;
    cartBoot = typeof boot === "function" ? (boot as (...a: never[]) => unknown) : null;
  }

  return {
    boot(api: CartApi): void {
      instantiate(api);
      // A cart without `boot` is legal: its top level already ran during
      // instantiation, which is the only thing `boot` was going to do anyway.
      if (cartBoot !== null) cartBoot();
    },
    tick(api: CartApi): void {
      instantiate(api);
      // Non-null after a successful instantiate; the cast documents that rather
      // than adding a per-frame branch to the hot path.
      (cartTick as () => unknown)();
    },
  };
}

// ---------------------------------------------------------------------------
// Turning an engine's parse failure into a CartCompileError
// ---------------------------------------------------------------------------

/**
 * A raw position as the engine reported it, in the coordinates of the WRAPPER.
 *
 * The engines genuinely differ and neither is wrong:
 *   SpiderMonkey  puts `lineNumber` and `columnNumber` on the SyntaxError.
 *   V8            puts nothing at all on a Function-constructor SyntaxError.
 *                 Its stack reads `at new Function (<anonymous>)` and then the
 *                 CALLER's frames -- `at file.ts:12:9`. Parsing the first
 *                 `:line:col` out of that stack would report the position of
 *                 this file, confidently and wrongly, for every broken cart.
 *                 So the stack is only consulted for the `<anonymous>:L:C` form,
 *                 which V8 emits for code that ran inside a constructed function
 *                 and never for one that failed to parse.
 */
function rawPosition(e: unknown): { line: number; column: number } | null {
  if (e === null || typeof e !== "object") return null;
  const o = e as { lineNumber?: unknown; columnNumber?: unknown; stack?: unknown };

  if (typeof o.lineNumber === "number" && isFinite(o.lineNumber) && o.lineNumber > 0) {
    const col = typeof o.columnNumber === "number" && isFinite(o.columnNumber) ? o.columnNumber : 1;
    return { line: o.lineNumber, column: col };
  }

  if (typeof o.stack === "string") {
    const m = /<anonymous>:(\d+):(\d+)/.exec(o.stack);
    if (m !== null && m[1] !== undefined && m[2] !== undefined) {
      return { line: Number(m[1]), column: Number(m[2]) };
    }
  }
  return null;
}

/**
 * How many lines the ENGINE's own `function anonymous(...) {` header adds on top
 * of the body we handed it, measured rather than assumed.
 *
 * V8 and SpiderMonkey both wrap a Function-constructed body in a header, and
 * they do not agree on its shape, so a hard-coded offset would be right on one
 * engine and one line out on the other. Instead: compile a probe whose only
 * error sits on a known body line and subtract. Memoised, computed at most once,
 * and only ever reached when a cart has already failed to parse.
 *
 * `null` means the engine reported no position for the probe either, in which
 * case it will not report one for a real cart and there is nothing to translate.
 */
let offsetProbed = false;
let engineOffset: number | null = null;

const PROBE_ERROR_LINE = 3; // the `)` below sits on line 3 of the probe body

function engineLineOffset(): number | null {
  if (offsetProbed) return engineOffset;
  offsetProbed = true;
  try {
    new CapturedFunction("\n\n)");
  } catch (e) {
    const p = rawPosition(e);
    if (p !== null) engineOffset = p.line - PROBE_ERROR_LINE;
  }
  return engineOffset;
}

/**
 * Map a thrown parse failure onto a `CartCompileError` in CART coordinates.
 *
 * Every translation is guarded: if the arithmetic lands outside the source, the
 * position is dropped rather than reported. There is no guess here that can
 * point an author at a line they did not write.
 */
function compileErrorFrom(
  e: unknown,
  source: string,
  name: string,
  prologueLines: number,
): CartCompileError {
  const message = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  const text = `cart "${name}" did not compile -- ${message}`;

  const raw = rawPosition(e);
  const offset = raw === null ? null : engineLineOffset();
  if (raw === null || offset === null) return new CartCompileError(text, "compile");

  const line = raw.line - offset - prologueLines;
  const lineCount = source.split("\n").length;
  if (line < 1 || line > lineCount) return new CartCompileError(text, "compile");

  // The prologue ends in a newline, so the cart's first line starts at column 1
  // of its own line and columns pass through untranslated.
  return new CartCompileError(`${text} (${line}:${raw.column})`, "compile", line, raw.column);
}

// ---------------------------------------------------------------------------
// Layer 2: realm hardening
// ---------------------------------------------------------------------------

/** What `scrubRealm` actually managed to do. Every field is an observation. */
export interface ScrubReport {
  /** Names that were present and are now gone. */
  deleted: string[];
  /** Names that were present and are STILL present. A fact, not a crash. */
  failed: string[];
  /** Objects verified frozen by this call. */
  frozen: number;
  /** Re-acquisition paths closed, by dotted name. */
  neutered: string[];
}

/** The stand-in for a code constructor. Calling it is the escape attempt. */
function deniedConstructor(): never {
  throw new TypeError("Square One: constructing code from a string is disabled in this realm");
}

/** One neutering, and how to put it back. */
export interface NeuterHandle {
  neutered: string[];
  restore(): void;
}

/**
 * Replace the four code-constructor paths with a function that throws.
 *
 * These are the routes Layer 1 provably cannot close:
 *
 *     (function(){}).constructor("return this")()
 *     Object.getPrototypeOf(async function(){}).constructor
 *     Object.getPrototypeOf(function*(){}).constructor
 *     Object.getPrototypeOf(async function*(){}).constructor
 *
 * Each is the `constructor` property of an intrinsic prototype, and each is
 * reachable from any function value in the realm. Neutering the property closes
 * every spelling of the route at once -- `[].constructor.constructor`,
 * `"".constructor.constructor` and `Object.constructor` all end at the same
 * property.
 *
 * `Error.stackTraceLimit = 0` is here for a smaller reason: on V8, `new
 * Error().stack` read from cart code contains the HOST's frames, including
 * absolute file paths. A cart cannot phone home, but it can draw what it read on
 * the screen or write it to the SAVE region, which the host persists.
 *
 * THIS IS BEST EFFORT, NOT A PROOF. It closes the routes that are known and
 * enumerable. Nobody can promise there is no fifth path in an engine that ships
 * next year -- which is exactly why `conformance/canaries/` exists and why it is
 * run again on every engine update.
 *
 * @param opts `sealed` (default true) makes the replacements non-configurable so
 *   a cart cannot put them back. Tests pass `sealed: false` so that `restore()`
 *   can undo the change and leave the runner's realm as it found it.
 */
export function neuterCodeConstructors(opts?: { sealed?: boolean }): NeuterHandle {
  const sealed = opts?.sealed ?? true;
  const neutered: string[] = [];
  const undo: Array<() => void> = [];

  // `CapturedFunction`, not the global `Function`. `scrubRealm` deletes the
  // `Function` binding from the global object BEFORE it calls this, so naming
  // the global here is a ReferenceError on a real worker realm -- thrown while
  // building this array, outside every try/catch below, so the whole scrub dies
  // and Layer 2 silently does nothing. That is not hypothetical: it is what a
  // real `node:worker_threads` global did, and the in-process tests could not
  // see it because they never delete the binding first.
  // See packages/runtime/test/scrub-realm.test.ts.
  const targets: Array<{ label: string; proto: object }> = [
    { label: "Function.prototype.constructor", proto: CapturedFunction.prototype },
    {
      label: "AsyncFunction.prototype.constructor",
      proto: Object.getPrototypeOf(async function (): Promise<void> {}) as object,
    },
    {
      label: "GeneratorFunction.prototype.constructor",
      proto: Object.getPrototypeOf(function* (): Generator<never> {}) as object,
    },
    {
      label: "AsyncGeneratorFunction.prototype.constructor",
      proto: Object.getPrototypeOf(async function* (): AsyncGenerator<never> {}) as object,
    },
  ];

  for (const { label, proto } of targets) {
    try {
      const prev = Object.getOwnPropertyDescriptor(proto, "constructor");
      if (prev === undefined) continue;
      Object.defineProperty(proto, "constructor", {
        value: deniedConstructor,
        writable: false,
        enumerable: false,
        configurable: !sealed,
      });
      neutered.push(label);
      if (!sealed) undo.push(() => Object.defineProperty(proto, "constructor", prev));
    } catch {
      // Already sealed by an earlier call, or frozen by an earlier freeze pass.
      // Reported by absence from `neutered`, never by a throw.
    }
  }

  try {
    const ErrCtor = Error as unknown as { stackTraceLimit?: number };
    if (typeof ErrCtor.stackTraceLimit === "number") {
      const prev = ErrCtor.stackTraceLimit;
      ErrCtor.stackTraceLimit = 0;
      neutered.push("Error.stackTraceLimit");
      if (!sealed) undo.push(() => (ErrCtor.stackTraceLimit = prev));
    }
  } catch {
    /* V8-only knob; its absence is not a failure. */
  }

  return {
    neutered,
    restore(): void {
      for (const f of undo) {
        try {
          f();
        } catch {
          /* nothing left to do but leave it as it is */
        }
      }
    },
  };
}

/**
 * Worker-only realm hardening. Returns what it actually managed to do.
 *
 * TOTAL BY CONSTRUCTION: every delete, every neuter and every freeze is in its
 * own try/catch. A non-configurable global that will not delete is a fact to
 * report, not a crash -- a worker that died while hardening itself is a worker
 * that never runs the cart, and the report is how the host learns which realm it
 * ended up with.
 *
 * SCOPE, AND WHY IT IS A PARAMETER
 * `scope` defaults to `globalThis`, which is what a real worker entry wants.
 * Tests pass a FAKE object so the delete pass can be exercised without deleting
 * anything from the runner's realm. Two consequences worth knowing:
 *
 *   - The intrinsics that get frozen are resolved THROUGH `scope`
 *     (`scope.Array.prototype`, not the ambient `Array.prototype`). Passing a
 *     fake scope that carries REAL intrinsics will freeze the real ones. Tests
 *     must hand it fakes.
 *   - The code-constructor neutering is realm-wide by nature -- there is no way
 *     to reach a fake realm's `Function.prototype` -- so it runs only when
 *     `scope` IS the real global. With a fake scope, `neutered` comes back
 *     empty, and that is the honest answer rather than a pretend one.
 *   - The delete pass follows the PROTOTYPE CHAIN, because on a web global that
 *     is where most of these names live (see `deleteThroughPrototypeChain`). A
 *     fake scope therefore has its own prototypes edited too. The walk stops at
 *     `Object.prototype`, so a plain object literal is safe.
 *
 * Call it AFTER `compileCart` and after every module has been imported. It is
 * one-way.
 */
export function scrubRealm(scope?: object): ScrubReport {
  const isRealGlobal = scope === undefined || scope === (globalThis as unknown as object);
  const target = (scope ?? globalThis) as Record<string, unknown>;
  const report: ScrubReport = { deleted: [], failed: [], frozen: 0, neutered: [] };

  // --- delete ---------------------------------------------------------------
  for (const key of SCRUBBED_NAMES) {
    let present: boolean;
    try {
      present = key in target;
    } catch {
      report.failed.push(key);
      continue;
    }
    // A name that was never there is neither deleted nor failed. `window` in
    // Node and `require` in a browser are absences, not victories.
    if (!present) continue;

    try {
      deleteThroughPrototypeChain(target, key);
      if (key in target) report.failed.push(key);
      else report.deleted.push(key);
    } catch {
      report.failed.push(key);
    }
  }

  // --- neuter ---------------------------------------------------------------
  // Before the freeze: a frozen Function.prototype cannot have its constructor
  // replaced afterwards.
  if (isRealGlobal) {
    report.neutered.push(...neuterCodeConstructors().neutered);

    // `Function` has just been deleted from the global object, so the freeze
    // pass below cannot find it there. Freeze it through the reference captured
    // at module load -- the same reference `compileCart` compiles with, which is
    // why freezing it is safe: a frozen constructor is still a callable one.
    if (freeze(CapturedFunction.prototype)) report.frozen++;
    if (freeze(CapturedFunction)) report.frozen++;
  }

  // --- freeze ---------------------------------------------------------------
  for (const key of INTRINSIC_NAMES) {
    let value: unknown;
    try {
      value = target[key];
    } catch {
      continue;
    }
    if (value === null || (typeof value !== "object" && typeof value !== "function")) continue;

    if (typeof value === "function") {
      const proto = (value as { prototype?: unknown }).prototype;
      if (proto !== null && (typeof proto === "object" || typeof proto === "function")) {
        if (freeze(proto)) report.frozen++;
      }
    }
    if (freeze(value)) report.frozen++;
  }

  return report;
}

/**
 * Remove `key` from `scope` AND from every prototype it inherits it through.
 *
 * WHY THE CHAIN, AND WHY NODE COULD NEVER HAVE SHOWN THIS.
 * On a `node:worker_threads` global, every scrubbable name is an OWN property of
 * the global object, so `delete target[key]` removes it and `key in target` goes
 * false. On a WEB global it is not. WebIDL puts an interface's OPERATIONS and
 * ATTRIBUTES on the interface prototype -- `fetch`, `importScripts`, `atob`,
 * `btoa`, `structuredClone`, `setTimeout`, `queueMicrotask`, `crypto`,
 * `navigator`, `location`, `indexedDB`, `caches`, `addEventListener` all live on
 * `DedicatedWorkerGlobalScope.prototype`, `WorkerGlobalScope.prototype` or
 * `EventTarget.prototype` -- and only INTERFACE OBJECTS (`Worker`, `Blob`,
 * `WebSocket`, `Request`, ...) as own properties of the global itself.
 *
 * `delete globalThis.fetch` therefore deleted nothing, returned `true`, and left
 * `fetch` one prototype hop away. Measured on a real browser Worker, 18 of the
 * 67 scrubbable names came back in `failed` for exactly this reason -- among
 * them the network (`fetch`), this realm's own code loader (`importScripts`),
 * persistent storage (`indexedDB`, `caches`), entropy (`crypto`) and the
 * fingerprint surface (`navigator`, `location`). The delete pass was largely
 * inert in the only environment that ships, and every Node test was green.
 * See packages/runtime/test/scrub-realm.browser.test.ts.
 *
 * That is the same failure this function has already produced once before, in a
 * different disguise: a Layer 2 that no in-process, single-platform test can
 * see. THE RULE IT TEACHES: Layer 2 is a claim about a REALM, and a realm can
 * only be tested by hardening a real one, on every engine that runs a cart.
 *
 * The walk stops at `Object.prototype`. Nothing in `SCRUBBED_NAMES` lives there,
 * and a test that hands `scrubRealm` a fake scope must not have the runner's own
 * object prototype edited underneath it.
 *
 * NOT total by itself: a `delete` of a non-configurable property throws in
 * strict mode, and that throw is how the caller learns the name survived. It is
 * called inside the caller's try/catch, which records the name in `failed`.
 */
function deleteThroughPrototypeChain(scope: object, key: string): void {
  let o: object | null = scope;
  while (o !== null && o !== (Object.prototype as object)) {
    if (Object.prototype.hasOwnProperty.call(o, key)) {
      delete (o as Record<string, unknown>)[key];
    }
    o = Object.getPrototypeOf(o) as object | null;
  }
}

/** Freeze one object, reporting rather than throwing. */
function freeze(o: unknown): boolean {
  try {
    Object.freeze(o);
    return Object.isFrozen(o);
  } catch {
    return false;
  }
}
