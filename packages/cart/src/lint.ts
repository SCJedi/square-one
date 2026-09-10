/**
 * The build-time static gate: what a cart is not allowed to name.
 *
 * A cart runs in a scrubbed realm. `Math`, `Date`, `fetch` and the rest are
 * deleted from the global scope before the cart's code runs, so a cart that
 * mentions them does not fail at build time by accident -- it fails at run time,
 * on someone else's machine, three levels into a game. This gate moves that
 * failure to the one moment where it is cheap and where the author is looking:
 * `sq1 build`.
 *
 * THE RULE, STATED ONCE AND EXACTLY
 * ---------------------------------
 * An identifier token is forbidden when
 *
 *     its name is in FORBIDDEN_IDENTIFIERS
 *     AND the immediately preceding token is neither `.` nor `?.`
 *
 * and nothing else. That is the whole rule, and it is deliberately blunt so a
 * second implementation reproduces it on the first attempt:
 *
 *   `Math.floor(x)`     flagged      -- bare `Math`
 *   `new Date()`        flagged      -- bare `Date`
 *   `obj.Math`          accepted     -- previous token is `.`
 *   `x?.Date`           accepted     -- previous token is `?.`
 *   `"Math"`            accepted     -- a string is not an identifier token
 *   `// Math`           accepted     -- a comment emits no tokens at all
 *   `{ Math: 1 }`       FLAGGED      -- see below
 *
 * A property KEY in an object literal is an identifier token whose previous
 * token is `{` or `,`, so `{ Math: 1 }` is flagged even though it is harmless.
 * That is a knowing false positive, kept because the alternative is a rule that
 * has to know whether a `{` opened a block or an object literal -- which needs a
 * parser, and a parser is the thing this file exists not to need. The workaround
 * is one character: quote the key, `{ "Math": 1 }`. Pinned by a test.
 *
 * The list itself must stay identical to the sandbox's shadow list. Two lists
 * that drift give an author a cart that builds and then dies on load, which is
 * the exact failure this gate was written to remove.
 *
 * WHAT ELSE IS REPORTED
 * ---------------------
 *   token-budget   over 8192 tokens, with the count and the overage
 *   empty-source   no tokens at all
 *   missing-tick   no top-level `tick`, by the heuristic documented below
 *
 * Findings come back in a fixed order: `empty-source` alone if the source has no
 * tokens, otherwise every `forbidden-identifier` in source order, then
 * `missing-tick`, then `token-budget`.
 */

import { tokenize } from "@sq1/core";
import type { Token } from "@sq1/core";

/** Which check produced a finding. */
export type LintRule = "forbidden-identifier" | "token-budget" | "empty-source" | "missing-tick";

/** One thing wrong with a cart's source, positioned so an editor can jump to it. */
export interface LintFinding {
  readonly rule: LintRule;
  /**
   * The whole diagnosis, phrased for a cart author and naming the replacement
   * where there is one. This message is the first thing an author ever learns
   * about the sandbox, so it teaches rather than scolds.
   */
  readonly message: string;
  /** 1-based line. */
  readonly line: number;
  /** 1-based column, in UTF-16 code units, matching the tokenizer's `col`. */
  readonly column: number;
  /** The offending name, for `forbidden-identifier` only. */
  readonly identifier?: string;
}

export interface LintResult {
  readonly findings: LintFinding[];
  /** The normative token count, whether or not it is over budget. */
  readonly tokens: number;
}

/**
 * The Universal Profile cart budget, in tokens (specification section 10).
 * `@sq1/core`'s counter is the normative definition of what a token is.
 */
export const TOKEN_BUDGET: 8192 = 8192;

/**
 * Every forbidden name, and what to do instead.
 *
 * The keys are the sandbox's shadow list, in the sandbox's order, and
 * FORBIDDEN_IDENTIFIERS is derived from them -- so a name can never be on one
 * list and missing from the other.
 */
const MESSAGES: Readonly<Record<string, string>> = {
  Math:
    "Math is not available in a cart. Use sys.sin, sys.cos, sys.rnd, or fixed-point arithmetic.",
  Date: "Date is not available in a cart. Time is sys.frame(), an integer frame counter.",
  fetch: "fetch is not available in a cart. A cart cannot reach the network by design.",
  XMLHttpRequest:
    "XMLHttpRequest is not available in a cart. A cart cannot reach the network by design; " +
    "everything it needs travels inside the .cart file.",
  WebSocket: "WebSocket is not available in a cart. A cart cannot reach the network by design.",
  importScripts:
    "importScripts is not available in a cart. A cart is one file: keep the code in main.js, " +
    "and put table-shaped data in data.bin.",
  Worker:
    "Worker is not available in a cart. A cart runs on one thread, so that a replay recorded " +
    "on any machine plays back the same on every other.",
  SharedArrayBuffer:
    "SharedArrayBuffer is not available in a cart. Shared memory makes timing observable, and " +
    "observable timing desyncs replays. Cart state lives in RAM, through sys.peek and sys.poke.",
  crypto:
    "crypto is not available in a cart. Randomness is sys.rnd, seeded once per run and " +
    "recorded in the replay so the same run happens again.",
  performance:
    "performance is not available in a cart. Time is sys.frame(); wall-clock time differs " +
    "between machines and would make the same cart behave two ways.",
  Intl:
    "Intl is not available in a cart. Its output depends on the host's locale data, which is " +
    "not the same on two machines. Format numbers and text yourself.",
  eval:
    "eval is not available in a cart. A cart's code is fixed when it is built, so that anyone " +
    "who plays it can read exactly what will run.",
  Function:
    "Function is not available in a cart. The Function constructor compiles new code at run " +
    "time; a cart's code is fixed at build time. Ordinary `function` declarations are fine.",
  WeakRef:
    "WeakRef is not available in a cart. What it observes depends on when the garbage " +
    "collector runs, which differs between engines and between two runs of the same cart.",
  FinalizationRegistry:
    "FinalizationRegistry is not available in a cart. It fires when the garbage collector " +
    "decides to, which is not the same twice, and a cart must be the same twice.",
  globalThis:
    "globalThis is not available in a cart. The cart's realm is scrubbed; reaching for the " +
    "global object would only find what is already named here: sys, gfx, inp and snd.",
  self: "self is not available in a cart. There is no worker global to reach: use sys, gfx, inp and snd.",
  window: "window is not available in a cart. There is no page and no DOM; a cart draws through gfx.",
  document:
    "document is not available in a cart. A cart draws through gfx onto the 128x128 " +
    "framebuffer; there is no DOM behind it.",
  process:
    "process is not available in a cart. There is no Node process behind a cart, and no " +
    "environment for it to read.",
  require: "require is not available in a cart. A cart is one file; there is nothing to load.",
  module: "module is not available in a cart. A cart is a script, not a module.",
  exports:
    "exports is not available in a cart. A cart exposes boot() and tick() as top-level " +
    "functions, not as exports.",
  setTimeout:
    "setTimeout is not available in a cart. The host owns the clock: your code runs when " +
    "tick() is called, once per frame.",
  setInterval:
    "setInterval is not available in a cart. The host owns the clock: your code runs when " +
    "tick() is called, once per frame.",
  queueMicrotask:
    "queueMicrotask is not available in a cart. Everything a frame does happens inside " +
    "tick(); nothing may be scheduled to run between frames.",
  Reflect:
    "Reflect is not available in a cart. It reaches an object's internals whatever the realm " +
    "did to hide them, which is exactly what the sandbox is for.",
  Proxy:
    "Proxy is not available in a cart. A proxy can make the same object read differently every " +
    "time it is touched, and a cart has to be readable to be trusted.",
};

/**
 * The shadow list, in the sandbox's order. Must equal the set of names the
 * scrubbed realm deletes; a test pins the exact array.
 */
export const FORBIDDEN_IDENTIFIERS: readonly string[] = Object.keys(MESSAGES);

const FORBIDDEN: ReadonlySet<string> = new Set(FORBIDDEN_IDENTIFIERS);

/** True when `t` is the member-access punctuation that makes a name a property. */
function isMemberAccess(t: Token | undefined): boolean {
  return t !== undefined && t.type === "punct" && (t.value === "." || t.value === "?.");
}

/** The message for a forbidden name. Every name in the list has one. */
export function forbiddenMessage(name: string): string {
  const m = MESSAGES[name];
  return m ?? `${name} is not available in a cart.`;
}

/**
 * Does the source declare a top-level `tick`?
 *
 * THIS IS A HEURISTIC AND CANNOT BE EXACT WITHOUT A PARSER. It answers yes when
 * a token named `tick` appears at brace depth zero directly after `function`,
 * `var`, `let` or `const` -- which covers `function tick() {}` and
 * `var tick = function () {}`, the two shapes a cart is written in.
 *
 * It therefore says no to a `tick` installed some other way (assigned from a
 * factory, or built by name), and it says yes to a `function tick` at depth zero
 * that some conditional never reaches. Both are the price of not carrying a
 * parser into the build. The failure mode is a build refused with a message that
 * names the shape it wanted, never a cart that ships broken.
 *
 * Depth counts every bracket the tokenizer emits, INCLUDING the `${` that opens
 * a template substitution -- its closing `}` is an ordinary `}` token, so a
 * `${` that did not raise the depth would drop it below zero and make everything
 * after a template look top-level.
 */
function declaresTick(tokens: readonly Token[]): boolean {
  let depth = 0;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === undefined) continue;
    if (t.type === "punct") {
      if (t.value === "{" || t.value === "(" || t.value === "[" || t.value === "${") depth++;
      else if (t.value === "}" || t.value === ")" || t.value === "]") depth--;
      continue;
    }
    if (depth !== 0) continue;
    if (t.type !== "ident" || t.value !== "tick") continue;
    const prev = tokens[i - 1];
    if (prev === undefined || prev.type !== "keyword") continue;
    if (prev.value === "function" || prev.value === "var" || prev.value === "let" || prev.value === "const") {
      return true;
    }
  }
  return false;
}

/**
 * Check one cart's source.
 *
 * @throws {TokenizeError} when the source cannot be lexed -- the same error
 * `countTokens` raises, because this function counts the same tokens. A caller
 * that means to report it as a build failure catches it there; there is nothing
 * useful this function could say about a file that is not JavaScript.
 */
export function lintCartSource(source: string): LintResult {
  const { tokens, count } = tokenize(source);
  const findings: LintFinding[] = [];

  if (count === 0) {
    findings.push({
      rule: "empty-source",
      message:
        "This cart has no code. A cart needs a top-level tick() function, which the console " +
        "calls once per frame; see examples/hello/main.js for the smallest complete one.",
      line: 1,
      column: 1,
    });
    return { findings, tokens: count };
  }

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === undefined || t.type !== "ident") continue;
    if (!FORBIDDEN.has(t.value)) continue;
    if (isMemberAccess(tokens[i - 1])) continue;
    findings.push({
      rule: "forbidden-identifier",
      message: forbiddenMessage(t.value),
      line: t.line,
      column: t.col,
      identifier: t.value,
    });
  }

  if (!declaresTick(tokens)) {
    findings.push({
      rule: "missing-tick",
      message:
        "This cart has no top-level tick(). The console calls tick() once per frame, and a " +
        "cart without one draws nothing. Write `function tick() { ... }` at the top level.",
      line: 1,
      column: 1,
    });
  }

  if (count > TOKEN_BUDGET) {
    // Point at the token that broke the budget, not at line 1: an author
    // trimming a cart wants to know where the ceiling is.
    const at = tokens[TOKEN_BUDGET];
    findings.push({
      rule: "token-budget",
      message:
        `This cart is ${count} tokens, which is ${count - TOKEN_BUDGET} over the ` +
        `${TOKEN_BUDGET}-token budget. Every token counts as one, including punctuation. ` +
        "Shorten the cart, or move table-shaped data out of main.js and into data.bin.",
      line: at?.line ?? 1,
      column: at?.col ?? 1,
    });
  }

  return { findings, tokens: count };
}
