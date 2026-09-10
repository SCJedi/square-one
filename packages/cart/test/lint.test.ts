import { describe, it, expect } from "vitest";

import { TokenizeError } from "@sq1/core";
import {
  lintCartSource,
  forbiddenMessage,
  FORBIDDEN_IDENTIFIERS,
  TOKEN_BUDGET,
} from "../src/lint";
import type { LintFinding } from "../src/lint";

// The real example on disk, loaded the one way that resolves identically in
// Node and in a browser. See "the example cart" at the foot of this file.
import helloSource from "../../../examples/hello/main.js?raw";

/*
 * The gate has one rule and it is stated in lint.ts. These tests pin the rule
 * itself -- including the two places it is knowingly blunt -- rather than the
 * wording of any particular message, except where the wording IS the promise:
 * a message that names the replacement is the whole reason the gate exists.
 */

/** Lint a snippet that already has a tick, so only the interesting rule fires. */
function lint(body: string): LintFinding[] {
  return lintCartSource(`function tick() {\n${body}\n}\n`).findings;
}

const forbidden = (fs: readonly LintFinding[]): string[] =>
  fs.filter((f) => f.rule === "forbidden-identifier").map((f) => f.identifier as string);

describe("the forbidden list", () => {
  it("is exactly the sandbox's shadow list, in the sandbox's order", () => {
    // Written out rather than derived: if the sandbox and the gate ever drift,
    // one of the two has to change and this is the line that says so.
    expect([...FORBIDDEN_IDENTIFIERS]).toEqual([
      "Math", "Date", "fetch", "XMLHttpRequest", "WebSocket", "importScripts", "Worker",
      "SharedArrayBuffer", "crypto", "performance", "Intl", "eval", "Function", "WeakRef",
      "FinalizationRegistry", "globalThis", "self", "window", "document", "process", "require",
      "module", "exports", "setTimeout", "setInterval", "queueMicrotask", "Reflect", "Proxy",
    ]);
  });

  it("gives every name a message that names it", () => {
    for (const name of FORBIDDEN_IDENTIFIERS) {
      const m = forbiddenMessage(name);
      expect(m.startsWith(`${name} is not available in a cart.`)).toBe(true);
      expect(m.length).toBeGreaterThan(`${name} is not available in a cart.`.length + 10);
    }
  });

  it("says what to use instead of Math, Date and fetch", () => {
    expect(forbiddenMessage("Math")).toBe(
      "Math is not available in a cart. Use sys.sin, sys.cos, sys.rnd, or fixed-point arithmetic.",
    );
    expect(forbiddenMessage("Date")).toBe(
      "Date is not available in a cart. Time is sys.frame(), an integer frame counter.",
    );
    expect(forbiddenMessage("fetch")).toBe(
      "fetch is not available in a cart. A cart cannot reach the network by design.",
    );
  });

  it("flags every name on the list when it is written bare", () => {
    for (const name of FORBIDDEN_IDENTIFIERS) {
      expect(forbidden(lint(`var x = ${name};`))).toEqual([name]);
    }
  });
});

describe("the rule: bare name yes, property no", () => {
  it("flags a bare Math", () => {
    const fs = lint("var y = Math.floor(1.5);");
    expect(forbidden(fs)).toEqual(["Math"]);
    expect(fs[0]?.message).toContain("sys.sin");
  });

  it("flags `new Date()`", () => {
    expect(forbidden(lint("var d = new Date();"))).toEqual(["Date"]);
  });

  it("accepts obj.Math -- the previous token is a dot", () => {
    expect(lint("var y = obj.Math;")).toEqual([]);
  });

  it("accepts x?.Date -- the previous token is an optional-chaining dot", () => {
    expect(lint("var y = x?.Date;")).toEqual([]);
  });

  it("accepts a deep member chain that ends in a forbidden name", () => {
    expect(lint("var y = a.b.c.fetch;")).toEqual([]);
  });

  it("flags the receiver but not the property when both are on the list", () => {
    // `Math.Date` is one bare name and one property.
    expect(forbidden(lint("var y = Math.Date;"))).toEqual(["Math"]);
  });

  it("accepts a forbidden name inside a string", () => {
    expect(lint('var s = "Math and fetch and Date";')).toEqual([]);
  });

  it("accepts a forbidden name inside a comment", () => {
    expect(lint("// Math, Date, fetch\n/* window.document */")).toEqual([]);
  });

  it("accepts a forbidden name inside a template chunk, and flags one in a substitution", () => {
    expect(lint("var s = `Math`;")).toEqual([]);
    expect(forbidden(lint("var s = `${Date}`;"))).toEqual(["Date"]);
  });

  it("does not flag a longer name that merely contains a forbidden one", () => {
    expect(lint("var myMath = 1; var dateOf = 2; var prefetch = 3;")).toEqual([]);
  });

  it("FLAGS an object-literal key, which is the rule's knowing false positive", () => {
    // Documented in lint.ts: telling a block from an object literal needs a
    // parser. Quote the key to get past it.
    expect(forbidden(lint("var o = { Math: 1 };"))).toEqual(["Math"]);
    expect(lint('var o = { "Math": 1 };')).toEqual([]);
  });

  it("flags a shadowing declaration too, because a cart cannot have one either", () => {
    expect(forbidden(lint("var Math = 1;"))).toEqual(["Math"]);
  });

  it("reports every occurrence, in source order", () => {
    expect(forbidden(lint("var a = Math; var b = fetch; var c = Math;"))).toEqual([
      "Math",
      "fetch",
      "Math",
    ]);
  });
});

describe("positions", () => {
  it("reports a 1-based line and column pointing at the name", () => {
    const src = "function tick() {\n  var x = 1;\n    var y = Math.floor(x);\n}\n";
    const fs = lintCartSource(src).findings;
    expect(fs).toHaveLength(1);
    expect(fs[0]?.line).toBe(3);
    expect(fs[0]?.column).toBe(13); // 1-based: `    var y = ` is twelve characters
    // And the column really is where the name starts.
    const line = src.split("\n")[2] as string;
    expect(line.slice((fs[0]?.column as number) - 1, (fs[0]?.column as number) - 1 + 4)).toBe("Math");
  });

  it("puts the first token of the file at 1:1", () => {
    const fs = lintCartSource("Math;\nfunction tick() {}\n").findings;
    expect(fs[0]).toMatchObject({ line: 1, column: 1, identifier: "Math" });
  });
});

describe("the other three rules", () => {
  it("reports empty source, and nothing else", () => {
    for (const src of ["", "   \n\t\n", "// just a comment\n", "/* nothing */"]) {
      const { findings, tokens } = lintCartSource(src);
      expect(tokens).toBe(0);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.rule).toBe("empty-source");
      expect(findings[0]).toMatchObject({ line: 1, column: 1 });
    }
  });

  it("reports a missing tick", () => {
    const fs = lintCartSource("function boot() { gfx.cls(1); }\n").findings;
    expect(fs.map((f) => f.rule)).toEqual(["missing-tick"]);
    expect(fs[0]?.message).toContain("function tick()");
  });

  it("accepts `function tick`, `var tick =`, `let` and `const`", () => {
    expect(lintCartSource("function tick() {}\n").findings).toEqual([]);
    expect(lintCartSource("var tick = function () {};\n").findings).toEqual([]);
    expect(lintCartSource("let tick = function () {};\n").findings).toEqual([]);
    expect(lintCartSource("const tick = () => {};\n").findings).toEqual([]);
  });

  it("does not count a tick nested inside another function", () => {
    const src = "function boot() { function tick() {} }\n";
    expect(lintCartSource(src).findings.map((f) => f.rule)).toEqual(["missing-tick"]);
  });

  it("still sees a top-level tick written after a template literal", () => {
    // `${` raises the depth and its closing `}` lowers it; a `${` that did not
    // count would leave every later token looking nested.
    const src = "var s = `a${1}b`;\nfunction tick() {}\n";
    expect(lintCartSource(src).findings).toEqual([]);
  });

  it("reports the token budget with the count and the overage", () => {
    // Five tokens a line: `var` `a` `=` `0` `;`.
    const lines = 2000;
    const src = "function tick() {}\n" + "var a = 0;\n".repeat(lines);
    const { findings, tokens } = lintCartSource(src);
    expect(tokens).toBe(6 + lines * 5);
    const budget = findings.find((f) => f.rule === "token-budget");
    expect(budget?.message).toContain(`This cart is ${tokens} tokens`);
    expect(budget?.message).toContain(`${tokens - TOKEN_BUDGET} over the ${TOKEN_BUDGET}-token budget`);
  });

  it("points the budget finding at the token that broke it", () => {
    const src = "function tick() {}\n" + "var a = 0;\n".repeat(2000);
    const budget = lintCartSource(src).findings.find((f) => f.rule === "token-budget");
    // Token 0..5 are line 1; from there five tokens a line.
    const expectedLine = 2 + Math.floor((TOKEN_BUDGET - 6) / 5);
    expect(budget?.line).toBe(expectedLine);
  });

  it("does not report the budget at exactly 8192 tokens", () => {
    // `function tick(){}` is 6 tokens; 8186 more at five a line is not divisible,
    // so pad with single `;` tokens to land exactly on the budget.
    const src = "function tick() {}\n" + ";".repeat(TOKEN_BUDGET - 6);
    const { tokens, findings } = lintCartSource(src);
    expect(tokens).toBe(TOKEN_BUDGET);
    expect(findings).toEqual([]);
  });

  it("counts tokens even when there is nothing to complain about", () => {
    expect(lintCartSource("function tick() { gfx.cls(1); }\n").tokens).toBe(13);
  });
});

describe("findings order", () => {
  it("puts forbidden identifiers first, then missing-tick", () => {
    const fs = lintCartSource("var a = Math;\nvar b = fetch;\n").findings;
    expect(fs.map((f) => f.rule)).toEqual([
      "forbidden-identifier",
      "forbidden-identifier",
      "missing-tick",
    ]);
  });
});

describe("source that is not JavaScript", () => {
  it("raises the tokenizer's error rather than guessing", () => {
    expect(() => lintCartSource('var s = "unterminated\n')).toThrow(TokenizeError);
  });
});

describe("the example cart", () => {
  it("passes the gate", () => {
    // The example is the shape the documentation tells authors to copy. If the
    // gate ever rejects it, one of the two is wrong and this test is where that
    // argument happens.
    //
    // Loaded through Vite's `?raw` rather than `node:fs` so this runs in a
    // browser too. An author may well meet the gate inside a browser-based
    // editor, and the file it validates should be the real one on disk, not a
    // copy that can drift from it.
    expect(lintCartSource(helloSource).findings).toEqual([]);
  });
});
