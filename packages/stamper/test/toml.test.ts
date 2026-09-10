import { describe, it, expect } from "vitest";

import { parseToml, tableEntries, tableGet, formatValue, describeKind } from "../src/toml";
import type { TomlTable, TomlValue } from "../src/toml";

/*
 * The parser exists to keep POSITIONS, so most of what is asserted here is a
 * line and a column. A parser that produced the right values and the wrong
 * positions would pass a value-only suite and fail the only job it has.
 */

function ok(text: string): TomlTable {
  const r = parseToml(text);
  if (!r.ok) throw new Error(`expected a parse, got ${r.error.line}:${r.error.column} ${r.error.message}`);
  return r.root;
}

function bad(text: string): { message: string; line: number; column: number; suggestion?: string } {
  const r = parseToml(text);
  if (r.ok) throw new Error("expected a refusal, got a parse");
  return r.error;
}

/** The value at a dotted path, or a thrown error naming the path. */
function at(root: TomlTable, path: string): TomlValue {
  let cur: TomlValue = root;
  for (const part of path.split(".")) {
    if (cur.kind !== "table") throw new Error(`${path}: ${part} is not under a table`);
    const e = tableGet(cur, part);
    if (e === undefined) throw new Error(`${path}: no ${part}`);
    cur = e.value;
  }
  return cur;
}

describe("toml: what it accepts", () => {
  it("parses a module manifest and positions every value", () => {
    const root = ok(
      [
        "[module]",
        'kind    = "engine"',
        'name    = "platformer"',
        'version = "1.0.0"',
        "",
        "[provides]",
        "entities = 64",
        "",
        "[requires]",
        "palette = true",
        'tileset = { min_tiles = 64, flags = ["solid", "hazard"] }',
        "",
        "[knobs.gravity]",
        'type    = "fixed"',
        "default = 0.42",
        "min     = 0.0",
        "max     = 4.0",
      ].join("\n"),
    );

    const kind = at(root, "module.kind");
    expect(kind).toMatchObject({ kind: "string", value: "engine" });
    expect(kind.pos).toEqual({ line: 2, column: 11 });

    expect(at(root, "provides.entities")).toMatchObject({ kind: "integer", value: 64, raw: "64" });
    expect(at(root, "requires.palette")).toMatchObject({ kind: "boolean", value: true });

    const tileset = at(root, "requires.tileset");
    expect(tileset.kind).toBe("table");
    expect(at(root, "requires.tileset.min_tiles")).toMatchObject({ value: 64 });
    const flags = at(root, "requires.tileset.flags");
    if (flags.kind !== "array") throw new Error("flags is not an array");
    expect(flags.items.map((i) => (i.kind === "string" ? i.value : null))).toEqual([
      "solid",
      "hazard",
    ]);

    // The dotted header creates `knobs`, and `[knobs.gravity]` is positioned at
    // its own `[`, which is where an unbound-knob message points.
    const gravity = at(root, "knobs.gravity");
    expect(gravity.kind).toBe("table");
    expect(gravity.pos).toEqual({ line: 13, column: 1 });
    expect(at(root, "knobs.gravity.default")).toMatchObject({ kind: "float", value: 0.42, raw: "0.42" });
    expect(at(root, "knobs.gravity.min")).toMatchObject({ kind: "float", value: 0, raw: "0.0" });
  });

  it("keeps declared order, because layers merge in it", () => {
    const root = ok(['[modules]', 'tileset = "b@1"', 'palette = "a@1"', 'shell = "c@1"'].join("\n"));
    const modules = at(root, "modules");
    if (modules.kind !== "table") throw new Error("not a table");
    expect(tableEntries(modules).map((e) => e.key)).toEqual(["tileset", "palette", "shell"]);
  });

  it("reads every value form the two formats need", () => {
    const root = ok(
      [
        "# a comment, and a blank line follow",
        "",
        "i = -7          # negative",
        "big = 1_000_000",
        "f = 6.02e23",
        "nf = -3.1",
        "t = true",
        "fa = false",
        's = "a \\"quoted\\" \\u0041\\tvalue"',
        "arr = [1, 2, 3,]",
        "nested = [[1], [2, 3]]",
        "multiline = [",
        "  1,   # comments inside",
        "  2,",
        "]",
        "inline = { a = 1, b = \"x\" }",
        'empty_inline = {}',
        "empty_arr = []",
      ].join("\n"),
    );
    expect(at(root, "i")).toMatchObject({ kind: "integer", value: -7 });
    expect(at(root, "big")).toMatchObject({ kind: "integer", value: 1000000, raw: "1_000_000" });
    expect(at(root, "f")).toMatchObject({ kind: "float", value: 6.02e23 });
    expect(at(root, "nf")).toMatchObject({ kind: "float", value: -3.1 });
    expect(at(root, "t")).toMatchObject({ kind: "boolean", value: true });
    expect(at(root, "fa")).toMatchObject({ kind: "boolean", value: false });
    expect(at(root, "s")).toMatchObject({ kind: "string", value: 'a "quoted" A\tvalue' });

    const arr = at(root, "arr");
    if (arr.kind !== "array") throw new Error("not an array");
    expect(arr.items).toHaveLength(3);

    const nested = at(root, "nested");
    if (nested.kind !== "array") throw new Error("not an array");
    expect(nested.items).toHaveLength(2);

    const multi = at(root, "multiline");
    if (multi.kind !== "array") throw new Error("not an array");
    expect(multi.items).toHaveLength(2);

    expect(at(root, "inline.a")).toMatchObject({ value: 1 });
    expect(at(root, "inline.b")).toMatchObject({ value: "x" });

    const emptyInline = at(root, "empty_inline");
    if (emptyInline.kind !== "table") throw new Error("not a table");
    expect(tableEntries(emptyInline)).toHaveLength(0);

    const emptyArr = at(root, "empty_arr");
    if (emptyArr.kind !== "array") throw new Error("not an array");
    expect(emptyArr.items).toHaveLength(0);
  });

  it("accepts quoted keys and dotted key assignments", () => {
    const root = ok(['"a key" = 1', "outer.inner = 2"].join("\n"));
    expect(at(root, "a key")).toMatchObject({ value: 1 });
    expect(at(root, "outer.inner")).toMatchObject({ value: 2 });
  });

  it("treats CRLF exactly as LF, so a Windows checkout parses the same", () => {
    const lf = ok('[cart]\ntitle = "x"\n');
    const crlf = ok('[cart]\r\ntitle = "x"\r\n');
    expect(at(crlf, "cart.title").pos).toEqual(at(lf, "cart.title").pos);
  });

  it("an empty document is an empty table, not an error", () => {
    expect(tableEntries(ok("# nothing but a comment\n"))).toHaveLength(0);
  });
});

describe("toml: what it refuses, and where", () => {
  it("refuses a literal string and names the supported spelling", () => {
    const e = bad("a = 'x'\n");
    expect(e.message).toContain("single-quoted literal string");
    expect(e).toMatchObject({ line: 1, column: 5 });
    expect(e.suggestion).toContain("double-quoted string");
  });

  it("refuses a multi-line string", () => {
    const e = bad('a = """\nx\n"""\n');
    expect(e.message).toContain("multi-line string");
    expect(e).toMatchObject({ line: 1, column: 5 });
  });

  it("refuses an array of tables", () => {
    const e = bad("[[bin]]\nname = 1\n");
    expect(e.message).toContain("array of tables");
    expect(e).toMatchObject({ line: 1, column: 1 });
  });

  it("refuses a date, and says it is a date", () => {
    const e = bad("when = 1979-05-27\n");
    expect(e.message).toContain("a date or a time");
    expect(e).toMatchObject({ line: 1, column: 8 });
  });

  it("refuses hexadecimal, octal and binary integers", () => {
    for (const [text, col] of [
      ["a = 0xff\n", 5],
      ["a = 0o777\n", 5],
      ["a = 0b1010\n", 5],
    ] as const) {
      const e = bad(text);
      expect(e.message).toContain("hexadecimal, octal or binary");
      expect(e.column).toBe(col);
    }
  });

  it("refuses inf and nan, which a knob can never be", () => {
    expect(bad("a = inf\n").message).toContain("inf");
    expect(bad("a = nan\n").message).toContain("nan");
  });

  it("refuses a leading zero", () => {
    const e = bad("a = 007\n");
    expect(e.message).toContain("leading zero");
  });

  it("refuses an unquoted word and offers the quoted form", () => {
    const e = bad("kind = engine\n");
    expect(e.message).toContain('"engine" is not a value');
    expect(e.suggestion).toContain('"\\"engine\\""');
    expect(e).toMatchObject({ line: 1, column: 8 });
  });

  it("refuses a duplicate key inside one table", () => {
    const e = bad("[a]\nx = 1\nx = 2\n");
    expect(e.message).toContain('key "x" is set twice');
    expect(e).toMatchObject({ line: 3, column: 1 });
  });

  it("refuses a table defined twice", () => {
    const e = bad("[a]\nx = 1\n[a]\ny = 2\n");
    expect(e.message).toContain("[a] is defined twice");
    expect(e).toMatchObject({ line: 3, column: 1 });
  });

  it("allows a parent table implied by a dotted header to be written later", () => {
    const root = ok("[knobs.gravity]\ntype = \"fixed\"\n[knobs]\n");
    expect(at(root, "knobs.gravity.type")).toMatchObject({ value: "fixed" });
  });

  it("refuses a missing =", () => {
    const e = bad("[a]\nkey\n");
    expect(e.message).toContain('where "=" was expected');
    expect(e).toMatchObject({ line: 2, column: 4 });
  });

  it("refuses two statements on one line", () => {
    const e = bad("a = 1 b = 2\n");
    expect(e.message).toContain("unexpected");
    expect(e.suggestion).toContain("One key = value per line");
  });

  it("refuses an unterminated string, pointing at where it opened", () => {
    const e = bad('a = "no end\n');
    expect(e.message).toContain("newline inside a string");
    expect(e).toMatchObject({ line: 1, column: 5 });
  });

  it("refuses an unknown escape and lists the real ones", () => {
    const e = bad('a = "\\q"\n');
    expect(e.message).toContain("\\q is not an escape sequence");
  });

  it("refuses a newline inside an inline table", () => {
    const e = bad("a = { x = 1,\n y = 2 }\n");
    expect(e.message).toContain("newline inside an inline table");
  });

  it("refuses a trailing comma inside an inline table", () => {
    const e = bad("a = { x = 1, }\n");
    expect(e.message).toContain("trailing comma");
  });

  it("refuses redefining a scalar as a table", () => {
    const e = bad("[a]\nb = 1\n[a.b]\nc = 2\n");
    expect(e.message).toContain('would redefine "b"');
  });

  it("refuses adding to a closed inline table", () => {
    const e = bad("a = { x = 1 }\na.y = 2\n");
    expect(e.message).toContain("inline table");
  });

  it("refuses an integer too large to be exact", () => {
    const e = bad("a = 99999999999999999999\n");
    expect(e.message).toContain("too large to be an exact integer");
  });

  it("never throws, whatever it is handed", () => {
    for (const text of ["", "[", "]", "=", "a =", '"', "\u0000", "[a\n", "a = [", "a = {"]) {
      expect(() => parseToml(text)).not.toThrow();
    }
  });
});

describe("toml: the helpers messages are built from", () => {
  it("describes a kind in English", () => {
    const root = ok('s = "x"\ni = 1\nf = 1.5\nb = true\narr = []\ntab = {}\n');
    expect(describeKind(at(root, "s"))).toBe("a string");
    expect(describeKind(at(root, "i"))).toBe("an integer");
    expect(describeKind(at(root, "f"))).toBe("a float");
    expect(describeKind(at(root, "b"))).toBe("a boolean");
    expect(describeKind(at(root, "arr"))).toBe("an array");
    expect(describeKind(at(root, "tab"))).toBe("a table");
  });

  it("writes a value back the way an author would type it", () => {
    const root = ok('s = "x"\nf = 0.42\narr = [1, "a"]\ntab = { a = 1 }\nb = false\n');
    expect(formatValue(at(root, "s"))).toBe('"x"');
    // The AUTHOR'S spelling, not a reformat of the parsed double.
    expect(formatValue(at(root, "f"))).toBe("0.42");
    expect(formatValue(at(root, "arr"))).toBe('[1, "a"]');
    expect(formatValue(at(root, "tab"))).toBe("{ a = 1 }");
    expect(formatValue(at(root, "b"))).toBe("false");
  });
});
