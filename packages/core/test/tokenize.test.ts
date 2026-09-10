import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { TokenizeError, countTokens, tokenize } from "../src/tokenize";
import type { Token } from "../src/tokenize";

const FIXTURE_DIR = fileURLToPath(new URL("../../../conformance/tokens/", import.meta.url));

function read(name: string): string {
  return readFileSync(FIXTURE_DIR + name, "utf8");
}

const fixtureNames: string[] = readdirSync(FIXTURE_DIR)
  .filter((n: string) => n.endsWith(".js"))
  .sort();

const expected: Record<string, number> = JSON.parse(read("expected.json")) as Record<
  string,
  number
>;

// --------------------------------------------------------------------------
// Conformance: every fixture matches expected.json, in both directions.
// --------------------------------------------------------------------------

describe("conformance fixtures", () => {
  it("has at least 20 fixtures", () => {
    expect(fixtureNames.length).toBeGreaterThanOrEqual(20);
  });

  it("expected.json and the directory agree", () => {
    expect(fixtureNames).toEqual(Object.keys(expected).sort());
  });

  for (const name of fixtureNames) {
    it(`${name} matches its expected count`, () => {
      const want = expected[name];
      expect(want, `${name} has no entry in expected.json`).toBeTypeOf("number");
      expect(countTokens(read(name))).toBe(want);
    });
  }

  it("fixture counts are stable across CRLF line endings", () => {
    // Checkouts on Windows may normalise line endings. That must not move the
    // budget, so every fixture is re-counted with CRLF forced on.
    for (const name of fixtureNames) {
      const crlf = read(name).replace(/\r\n/g, "\n").replace(/\n/g, "\r\n");
      expect(countTokens(crlf), name).toBe(expected[name]);
    }
  });
});

// --------------------------------------------------------------------------
// Positions
// --------------------------------------------------------------------------

function shape(tokens: Token[]): Array<[string, number, number, number, number]> {
  return tokens.map((t) => [t.value, t.start, t.end, t.line, t.col]);
}

describe("token positions", () => {
  it("reports exact start/end/line/col across a line break", () => {
    // "let a = 1;\nb.c;"
    //  0123456789 (\n is offset 10)
    const src = "let a = 1;\nb.c;";
    expect(shape(tokenize(src).tokens)).toEqual([
      ["let", 0, 3, 1, 1],
      ["a", 4, 5, 1, 5],
      ["=", 6, 7, 1, 7],
      ["1", 8, 9, 1, 9],
      [";", 9, 10, 1, 10],
      ["b", 11, 12, 2, 1],
      [".", 12, 13, 2, 2],
      ["c", 13, 14, 2, 3],
      [";", 14, 15, 2, 4],
    ]);
  });

  it("splits a template into chunk / ${ / substitution / } / chunk", () => {
    // "`a${b}c`"
    //  01234567
    expect(shape(tokenize("`a${b}c`").tokens)).toEqual([
      ["`a", 0, 2, 1, 1],
      ["${", 2, 4, 1, 3],
      ["b", 4, 5, 1, 5],
      ["}", 5, 6, 1, 6],
      ["c`", 6, 8, 1, 7],
    ]);
  });

  it("counts a multi-line template's interior lines", () => {
    const src = "`a\nb${\nx\n}c`;";
    const lines = tokenize(src).tokens.map((t) => [t.value, t.line]);
    expect(lines).toEqual([
      ["`a\nb", 1],
      ["${", 2],
      ["x", 3],
      ["}", 4],
      ["c`", 4],
      [";", 4],
    ]);
  });

  it("skips comments and whitespace without disturbing positions", () => {
    const src = "  /* c */ a // trailing\n\tb";
    expect(shape(tokenize(src).tokens)).toEqual([
      ["a", 10, 11, 1, 11],
      ["b", 25, 26, 2, 2],
    ]);
  });

  it("does not count the hashbang but keeps line 2 correct", () => {
    const src = "#!/usr/bin/env node\nx;";
    expect(shape(tokenize(src).tokens)).toEqual([
      ["x", 20, 21, 2, 1],
      [";", 21, 22, 2, 2],
    ]);
  });

  it("treats CRLF as one line terminator", () => {
    const src = "a;\r\nb;";
    expect(tokenize(src).tokens.map((t) => [t.value, t.line, t.col])).toEqual([
      ["a", 1, 1],
      [";", 1, 2],
      ["b", 2, 1],
      [";", 2, 2],
    ]);
  });
});

// --------------------------------------------------------------------------
// Structural invariants
// --------------------------------------------------------------------------

describe("structural invariants", () => {
  const sources = fixtureNames.map((n) => [n, read(n)] as const);

  it("tokens tile the source: values are exact slices and gaps are inert", () => {
    for (const [name, src] of sources) {
      const { tokens } = tokenize(src);
      let prevEnd = 0;
      for (const t of tokens) {
        expect(src.slice(t.start, t.end), `${name}: value is not its own slice`).toBe(t.value);
        expect(t.end, `${name}: empty or reversed token`).toBeGreaterThan(t.start);
        expect(t.start, `${name}: tokens overlap or go backwards`).toBeGreaterThanOrEqual(prevEnd);
        // Everything skipped between two tokens must itself cost zero.
        expect(countTokens(src.slice(prevEnd, t.start)), `${name}: gap was not inert`).toBe(0);
        prevEnd = t.end;
      }
      expect(countTokens(src.slice(prevEnd)), `${name}: trailing text was not inert`).toBe(0);
    }
  });

  it("count is exactly tokens.length", () => {
    for (const [name, src] of sources) {
      const r = tokenize(src);
      expect(r.count, name).toBe(r.tokens.length);
    }
  });

  it("round-trips: re-tokenizing the joined token values gives the same count", () => {
    // Whitespace and comments are gone, so the tokens are joined with a single
    // space. Inserting whitespace between two tokens can never merge them and
    // never changes the regex-versus-division decision, so the count must hold.
    for (const [name, src] of sources) {
      const first = tokenize(src);
      const rebuilt = first.tokens.map((t) => t.value).join(" ");
      expect(countTokens(rebuilt), `${name}: not idempotent`).toBe(first.count);
      // ...and it is stable under a second pass.
      const second = tokenize(rebuilt);
      expect(countTokens(second.tokens.map((t) => t.value).join(" ")), name).toBe(first.count);
    }
  });
});

// --------------------------------------------------------------------------
// Errors
// --------------------------------------------------------------------------

function failure(src: string): TokenizeError {
  let caught: unknown;
  try {
    tokenize(src);
  } catch (e) {
    caught = e;
  }
  expect(caught, `expected ${JSON.stringify(src)} to throw`).toBeInstanceOf(TokenizeError);
  return caught as TokenizeError;
}

describe("errors", () => {
  it("unterminated string literal", () => {
    const e = failure("let a = 1;\nlet s = 'oops;\n");
    expect(e.message).toContain("unterminated string literal");
    expect([e.line, e.col]).toEqual([2, 9]);
    expect(e.offset).toBe(19);
  });

  it("unterminated string literal at end of file", () => {
    expect(failure('"no closing quote').message).toContain("unterminated string literal");
  });

  it("a newline terminates a string literal with an error, not silently", () => {
    const e = failure("'a\nb'");
    expect([e.line, e.col]).toEqual([1, 1]);
  });

  it("unterminated block comment", () => {
    const e = failure("a;\n/* opened\n   never closed\n");
    expect(e.message).toContain("unterminated block comment");
    expect([e.line, e.col]).toEqual([2, 1]);
  });

  it("unterminated template literal", () => {
    const e = failure("let t = `abc\n");
    expect(e.message).toContain("unterminated template literal");
    expect([e.line, e.col]).toEqual([1, 9]);
  });

  it("unterminated template literal with an open substitution", () => {
    const e = failure("let t = `abc${ 1 + 2 ");
    expect(e.message).toContain("unterminated template literal");
    expect([e.line, e.col]).toEqual([1, 9]);
  });

  it("unterminated regular expression", () => {
    const e = failure("const r = /abc\n");
    expect(e.message).toContain("unterminated regular expression literal");
    expect([e.line, e.col]).toEqual([1, 11]);
  });

  it("unterminated regular expression character class", () => {
    const e = failure("const r = /[abc/;\n");
    expect(e.message).toContain("unterminated regular expression literal");
  });

  it("a bare `#` is an error", () => {
    const e = failure("x = # ;");
    expect(e.message).toContain("expected an identifier after '#'");
    expect([e.line, e.col]).toEqual([1, 5]);
  });

  it("a hashbang is only recognised at offset 0", () => {
    expect(failure("\n#!/bin/sh\n").message).toContain("expected an identifier after '#'");
  });

  it("identifier unicode escapes are rejected (documented limitation L2)", () => {
    const e = failure("let \\u0061 = 1;");
    expect(e.message).toContain("unicode escape sequences in identifiers are not supported");
    expect([e.line, e.col]).toEqual([1, 5]);
  });

  it("a radix literal with no digits is an error", () => {
    expect(failure("0x;").message).toContain("invalid hexadecimal literal");
    expect(failure("0b;").message).toContain("invalid binary literal");
    expect(failure("0o;").message).toContain("invalid octal literal");
  });

  it("an un-lexable character is an error", () => {
    const e = failure("a @ b");
    expect(e.message).toContain("unexpected character");
    expect([e.line, e.col]).toEqual([1, 3]);
  });

  it("none of the error inputs hang", () => {
    const nasty = [
      "'",
      '"',
      "`",
      "`${",
      "`${`",
      "`${}",
      "/*",
      "/**",
      "/",
      "= /",
      "= /[",
      "= /\\",
      "0x",
      "#",
      "\\",
      "@",
      "`".repeat(1000) + "${",
      "/*".repeat(1000),
    ];
    const started = Date.now();
    for (const src of nasty) {
      try {
        tokenize(src);
      } catch (e) {
        expect(e).toBeInstanceOf(TokenizeError);
      }
    }
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

// --------------------------------------------------------------------------
// Behaviour that the fixtures assert as counts, asserted here as token types
// --------------------------------------------------------------------------

describe("lexing details", () => {
  it("a regex literal is one token including its flags", () => {
    const { tokens } = tokenize("x = /a[/]b\\/c/gimsuy;");
    expect(tokens[2]?.type).toBe("regexp");
    expect(tokens[2]?.value).toBe("/a[/]b\\/c/gimsuy");
  });

  it("a comment is never mistaken for a regex or a division", () => {
    expect(countTokens("a /* not division */ b")).toBe(2);
    expect(countTokens("a = /* c */ 1")).toBe(3);
    expect(countTokens("a // not a regex\nb")).toBe(2);
  });

  it("`?.` before a digit is `?` then a number", () => {
    const { tokens } = tokenize("a?.5:b");
    expect(tokens.map((t) => t.value)).toEqual(["a", "?", ".5", ":", "b"]);
  });

  it("numeric edge cases lex as single number tokens", () => {
    for (const n of ["0", ".5", "5.", "1e3", "1E-3", "0x1F", "0o17", "0b1", "1_000n", "0xFFn"]) {
      const { tokens } = tokenize(n);
      expect(tokens.length, n).toBe(1);
      expect(tokens[0]?.type, n).toBe("number");
      expect(tokens[0]?.value, n).toBe(n);
    }
  });

  it("a property access on a number does not swallow the dot", () => {
    expect(tokenize("0.5.toFixed(1)").tokens.map((t) => t.value)).toEqual([
      "0.5",
      ".",
      "toFixed",
      "(",
      "1",
      ")",
    ]);
  });

  it("a template inside a substitution inside a template nests correctly", () => {
    expect(tokenize("`a${`b${c}d`}e`").tokens.map((t) => t.value)).toEqual([
      "`a",
      "${",
      "`b",
      "${",
      "c",
      "}",
      "d`",
      "}",
      "e`",
    ]);
  });

  it("an object literal inside a substitution does not close the template", () => {
    expect(tokenize("`${ {a: 1} }`").tokens.map((t) => t.value)).toEqual([
      "`",
      "${",
      "{",
      "a",
      ":",
      "1",
      "}",
      "}",
      "`",
    ]);
  });
});

// --------------------------------------------------------------------------
// Performance
// --------------------------------------------------------------------------

describe("performance", () => {
  it("tokenizes ~200KB in well under a second", () => {
    const unit =
      "if (world.hazardAt(px, py)) { alive = false; } // guard\n" +
      "vy = clamp(vy + GRAVITY, -MAX_FALL, MAX_FALL);\n" +
      "gfx.text(2, 2, `coins ${coins} of ${total}`);\n" +
      "const re = /a[/]b/g, q = n / 2;\n";
    const reps = Math.ceil(200_000 / unit.length);
    const src = unit.repeat(reps);
    expect(src.length).toBeGreaterThan(200_000);

    const started = Date.now();
    const { count } = tokenize(src);
    const elapsed = Date.now() - started;

    expect(count).toBe(countTokens(unit) * reps);
    expect(elapsed, `took ${elapsed}ms`).toBeLessThan(1000);
  });

  it("is linear, not quadratic, in the length of one huge template", () => {
    const small = "`" + "x".repeat(10_000) + "`";
    const big = "`" + "x".repeat(400_000) + "`";
    const t0 = Date.now();
    expect(countTokens(small)).toBe(1);
    const tSmall = Date.now() - t0;
    const t1 = Date.now();
    expect(countTokens(big)).toBe(1);
    const tBig = Date.now() - t1;
    expect(tBig, `small ${tSmall}ms, big ${tBig}ms`).toBeLessThan(1000);
  });
});
