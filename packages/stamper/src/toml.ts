/**
 * A TOML SUBSET, parsed WITH POSITIONS.
 *
 * WHY THIS IS HAND-WRITTEN AND NOT A DEPENDENCY
 * ---------------------------------------------
 * The acceptance criterion for the stamper is the diagnostic, not the parse. A
 * recipe with an unbound knob has to fail like a compiler:
 *
 *     recipe.toml:14:1  error[unbound-knob]  ...
 *
 * Every third-party TOML parser in reach returns plain JavaScript objects and
 * throws the line and column away the moment a value is built. Once that
 * information is gone there is no way to get it back short of re-scanning the
 * file and guessing, and a guessed position sends an author to the wrong line --
 * which is worse than no position at all. So every value this parser produces
 * carries `{ line, column }`, and that is the whole reason the file exists.
 *
 * WHAT IS SUPPORTED
 * -----------------
 *   [table]                 and [a.b] dotted headers
 *   key = value             bare or quoted keys, dotted key paths
 *   "strings"               basic strings with \b \t \n \f \r \" \\ \uXXXX \UXXXXXXXX
 *   123  -7  1_000          decimal integers, underscores between digits
 *   0.42  -3.1  6.02e23     floats
 *   true  false             booleans
 *   [1, 2, 3]               arrays, newlines and a trailing comma allowed inside
 *   { a = 1, b = "x" }      inline tables, one line, no trailing comma
 *   # comments              to end of line
 *
 * That covers both formats the stamper reads -- a module manifest and a recipe --
 * with nothing left over.
 *
 * WHAT IS REFUSED, AND WHY REFUSAL RATHER THAN TOLERANCE
 * ------------------------------------------------------
 * Everything else: literal strings, multi-line strings, arrays of tables,
 * dates and times, hexadecimal/octal/binary integers, `inf` and `nan`. Each
 * comes back as a POSITIONED error naming the construct and, where there is one,
 * the supported spelling.
 *
 * The alternative -- accept the file and ignore the part that was not
 * understood -- is the dangerous one. A recipe whose `[tuning]` table was
 * silently half-read builds a cart with the wrong physics and no message
 * anywhere. A refusal costs the author ten seconds; a silent misread costs them
 * an afternoon and a shipped build.
 *
 * IT NEVER THROWS. `parseToml` returns a result, because every one of its
 * callers is turning the failure into a `Diagnostic` and none of them wants a
 * try/catch around a parse.
 */

/** A 1-based position in a source file. Columns count UTF-16 code units. */
export interface Pos {
  readonly line: number;
  readonly column: number;
}

export interface TomlString {
  readonly kind: "string";
  readonly value: string;
  readonly pos: Pos;
}
export interface TomlInteger {
  readonly kind: "integer";
  readonly value: number;
  /** Exactly the characters the author wrote, for messages that quote them back. */
  readonly raw: string;
  readonly pos: Pos;
}
export interface TomlFloat {
  readonly kind: "float";
  readonly value: number;
  readonly raw: string;
  readonly pos: Pos;
}
export interface TomlBoolean {
  readonly kind: "boolean";
  readonly value: boolean;
  readonly pos: Pos;
}
export interface TomlArray {
  readonly kind: "array";
  readonly items: readonly TomlValue[];
  readonly pos: Pos;
}
export interface TomlTable {
  readonly kind: "table";
  /** Insertion-ordered, which IS the declared order the merger layers in. */
  readonly entries: ReadonlyMap<string, TomlEntry>;
  /** The `[` of the header, the `{` of an inline table, or 1:1 for the root. */
  readonly pos: Pos;
  readonly inline: boolean;
}

/** One `key = value`, positioned at the KEY -- which is what a message points at. */
export interface TomlEntry {
  readonly key: string;
  readonly keyPos: Pos;
  readonly value: TomlValue;
}

export type TomlValue =
  | TomlString
  | TomlInteger
  | TomlFloat
  | TomlBoolean
  | TomlArray
  | TomlTable;

/** A file that is not this subset of TOML, and where it stopped being it. */
export interface TomlError {
  readonly message: string;
  readonly line: number;
  readonly column: number;
  readonly suggestion?: string;
}

export type TomlParse = { ok: true; root: TomlTable } | { ok: false; error: TomlError };

/** Mutable during construction; handed out as the readonly interface above. */
interface MutableTable {
  kind: "table";
  entries: Map<string, TomlEntry>;
  pos: Pos;
  inline: boolean;
}

/** Thrown inside the parser only. `parseToml` converts it and never lets it out. */
class Bail extends Error {
  readonly at: TomlError;
  constructor(at: TomlError) {
    super(at.message);
    this.at = at;
    Object.setPrototypeOf(this, Bail.prototype);
  }
}

const BARE_KEY = /^[A-Za-z0-9_-]$/;

/** English for a value's type, for "expected X, found Y" messages. */
export function describeKind(v: TomlValue): string {
  switch (v.kind) {
    case "string":
      return "a string";
    case "integer":
      return "an integer";
    case "float":
      return "a float";
    case "boolean":
      return "a boolean";
    case "array":
      return "an array";
    case "table":
      return "a table";
  }
}

/** A value written back the way an author would type it, for messages. */
export function formatValue(v: TomlValue): string {
  switch (v.kind) {
    case "string":
      return JSON.stringify(v.value);
    case "integer":
    case "float":
      return v.raw;
    case "boolean":
      return v.value ? "true" : "false";
    case "array":
      return `[${v.items.map(formatValue).join(", ")}]`;
    case "table":
      return `{ ${[...v.entries.values()].map((e) => `${e.key} = ${formatValue(e.value)}`).join(", ")} }`;
  }
}

/** The entry for `key`, or undefined. Present so callers never touch the Map. */
export function tableGet(t: TomlTable, key: string): TomlEntry | undefined {
  return t.entries.get(key);
}

/** Every entry, in DECLARED order. The merger depends on this being source order. */
export function tableEntries(t: TomlTable): readonly TomlEntry[] {
  return [...t.entries.values()];
}

class Scanner {
  readonly #text: string;
  #i = 0;
  #line = 1;
  #col = 1;

  /**
   * Explicitly written `[header]` paths, so a second `[cart]` is a duplicate
   * while the `[a]` implied by an earlier `[a.b]` is not.
   */
  readonly #declared = new Set<string>();

  constructor(text: string) {
    // A lone CR is a line ending nothing else in this repository produces and a
    // source of positions that are right in one editor and wrong in another.
    // CRLF is normalised; a bare CR is refused below by `charAt`'s scan.
    this.#text = text.replace(/\r\n/g, "\n");
  }

  /** The character `k` ahead, or "" past the end. Never undefined. */
  peek(k = 0): string {
    return this.#text.charAt(this.#i + k);
  }

  get pos(): Pos {
    return { line: this.#line, column: this.#col };
  }

  get eof(): boolean {
    return this.#i >= this.#text.length;
  }

  /** Consume one character, tracking the position. */
  take(): string {
    const c = this.#text.charAt(this.#i);
    this.#i++;
    if (c === "\n") {
      this.#line++;
      this.#col = 1;
    } else {
      this.#col++;
    }
    return c;
  }

  fail(message: string, suggestion?: string, at?: Pos): never {
    const p = at ?? this.pos;
    throw new Bail(
      suggestion === undefined
        ? { message, line: p.line, column: p.column }
        : { message, line: p.line, column: p.column, suggestion },
    );
  }

  /** Spaces and tabs only. Newlines are significant and are never eaten here. */
  skipSpace(): void {
    for (;;) {
      const c = this.peek();
      if (c === " " || c === "\t") this.take();
      else return;
    }
  }

  /** A `#` comment runs to the end of the line; the newline itself stays. */
  skipComment(): void {
    if (this.peek() !== "#") return;
    while (!this.eof && this.peek() !== "\n") this.take();
  }

  /** Space, comments and blank lines: the gaps between statements. */
  skipGaps(): void {
    for (;;) {
      const c = this.peek();
      if (c === " " || c === "\t" || c === "\n") {
        this.take();
        continue;
      }
      if (c === "#") {
        this.skipComment();
        continue;
      }
      if (c === "\r") {
        this.fail(
          "a carriage return that is not part of a CRLF line ending",
          "Save the file with LF or CRLF line endings.",
        );
      }
      return;
    }
  }

  /** After a statement: only space, a comment, and then a newline or the end. */
  endOfLine(what: string): void {
    this.skipSpace();
    this.skipComment();
    if (this.eof) return;
    if (this.peek() === "\n") {
      this.take();
      return;
    }
    this.fail(
      `unexpected ${JSON.stringify(this.peek())} after ${what}`,
      "One key = value per line, and nothing after it but a # comment.",
    );
  }

  declare(path: string, at: Pos): void {
    if (this.#declared.has(path)) {
      this.fail(`table [${path}] is defined twice`, "Merge the two into one table.", at);
    }
    this.#declared.add(path);
  }

  // --- keys ---------------------------------------------------------------

  /** One bare or quoted key. */
  key(): { name: string; pos: Pos } {
    const pos = this.pos;
    if (this.peek() === '"') return { name: this.basicString().value, pos };
    if (this.peek() === "'") {
      this.fail(
        "a single-quoted key",
        'Keys are bare (gravity) or double-quoted ("gravity"); literal strings are not supported.',
      );
    }
    let name = "";
    while (BARE_KEY.test(this.peek())) name += this.take();
    if (name === "") {
      this.fail(
        this.eof ? "a key was expected, and the file ended" : `${JSON.stringify(this.peek())} cannot start a key`,
        "A key is letters, digits, underscores and hyphens, or a double-quoted string.",
      );
    }
    return { name, pos };
  }

  /** A dotted key path: `a`, or `a.b.c`. */
  keyPath(): { parts: { name: string; pos: Pos }[]; pos: Pos } {
    const pos = this.pos;
    const parts = [this.key()];
    for (;;) {
      this.skipSpace();
      if (this.peek() !== ".") return { parts, pos };
      this.take();
      this.skipSpace();
      parts.push(this.key());
    }
  }

  // --- values -------------------------------------------------------------

  basicString(): TomlString {
    const pos = this.pos;
    this.take(); // the opening quote
    if (this.peek() === '"' && this.peek(1) === '"') {
      this.fail(
        "a multi-line string",
        'Multi-line strings ("""...""") are not supported. Write the value on one line.',
        pos,
      );
    }
    let out = "";
    for (;;) {
      if (this.eof) this.fail("the file ended inside a string", undefined, pos);
      const c = this.take();
      if (c === '"') return { kind: "string", value: out, pos };
      if (c === "\n") this.fail("a newline inside a string", undefined, pos);
      if (c !== "\\") {
        const code = c.charCodeAt(0);
        if (code < 0x20 || code === 0x7f) {
          this.fail(
            `a control character (U+${code.toString(16).toUpperCase().padStart(4, "0")}) inside a string`,
            "Write it as an escape, for example \\n or \\u0009.",
          );
        }
        out += c;
        continue;
      }
      const e = this.take();
      switch (e) {
        case '"':
        case "\\":
        case "/":
          out += e;
          break;
        case "b":
          out += "\b";
          break;
        case "t":
          out += "\t";
          break;
        case "n":
          out += "\n";
          break;
        case "f":
          out += "\f";
          break;
        case "r":
          out += "\r";
          break;
        case "u":
          out += this.codepoint(4);
          break;
        case "U":
          out += this.codepoint(8);
          break;
        default:
          this.fail(
            `\\${e} is not an escape sequence`,
            'The escapes are \\b \\t \\n \\f \\r \\" \\\\ \\uXXXX and \\UXXXXXXXX.',
          );
      }
    }
  }

  codepoint(digits: number): string {
    let hex = "";
    for (let k = 0; k < digits; k++) {
      const c = this.peek();
      if (!/^[0-9A-Fa-f]$/.test(c)) {
        this.fail(
          `\\${digits === 4 ? "u" : "U"} needs ${digits} hexadecimal digits, and found ${JSON.stringify(hex + c)}`,
        );
      }
      hex += this.take();
    }
    const n = Number.parseInt(hex, 16);
    if (n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) {
      this.fail(`U+${hex.toUpperCase()} is not a Unicode scalar value`);
    }
    return String.fromCodePoint(n);
  }

  number(): TomlInteger | TomlFloat {
    const pos = this.pos;
    let raw = "";
    if (this.peek() === "+" || this.peek() === "-") raw += this.take();

    if (this.peek() === "0" && /^[xob]$/.test(this.peek(1))) {
      this.fail(
        `${this.peek()}${this.peek(1)} starts a hexadecimal, octal or binary integer`,
        "Only decimal integers are supported. Write the value in base ten.",
        pos,
      );
    }

    // Underscores are KEPT in what this returns: `raw` is the author's own
    // spelling, quoted back verbatim in messages, and the numeric value is
    // taken from `raw` with the separators stripped once, below.
    const digits = (what: string): string => {
      let d = "";
      for (;;) {
        const c = this.peek();
        if (/^[0-9]$/.test(c)) {
          d += this.take();
          continue;
        }
        // An underscore is a digit separator, and must sit between two digits.
        if (c === "_" && d !== "" && /^[0-9]$/.test(this.peek(1))) {
          d += this.take();
          continue;
        }
        break;
      }
      if (d === "") this.fail(`${what} was expected`, undefined, pos);
      return d;
    };

    const whole = digits("a digit");
    if (whole.length > 1 && whole.startsWith("0")) {
      this.fail(
        `${whole} has a leading zero`,
        "Write the number without leading zeros.",
        pos,
      );
    }
    raw += whole;

    let isFloat = false;
    if (this.peek() === "." && /^[0-9]$/.test(this.peek(1))) {
      isFloat = true;
      raw += this.take();
      raw += digits("a digit after the decimal point");
    }
    if (this.peek() === "e" || this.peek() === "E") {
      isFloat = true;
      raw += this.take();
      if (this.peek() === "+" || this.peek() === "-") raw += this.take();
      raw += digits("a digit in the exponent");
    }

    // `1979-05-27` and `07:32:00` both begin as a number. Say what they are
    // rather than complaining about the character after a perfectly good 1979.
    if (this.peek() === "-" || this.peek() === ":" || (this.peek() === "T" && !isFloat)) {
      this.fail(
        "a date or a time",
        "Dates and times are not supported. Write the value as a number or a string.",
        pos,
      );
    }

    const value = Number(raw.replace(/_/g, ""));
    if (!Number.isFinite(value)) {
      this.fail(`${raw} is not a finite number`, undefined, pos);
    }
    if (!isFloat && !Number.isSafeInteger(value)) {
      this.fail(
        `${raw} is too large to be an exact integer`,
        "Integers must be between -9007199254740991 and 9007199254740991.",
        pos,
      );
    }
    return isFloat
      ? { kind: "float", value, raw, pos }
      : { kind: "integer", value, raw, pos };
  }

  array(): TomlArray {
    const pos = this.pos;
    this.take(); // [
    const items: TomlValue[] = [];
    for (;;) {
      this.skipGaps();
      if (this.eof) this.fail("the file ended inside an array", undefined, pos);
      if (this.peek() === "]") {
        this.take();
        return { kind: "array", items, pos };
      }
      items.push(this.value());
      this.skipGaps();
      if (this.peek() === ",") {
        this.take();
        continue;
      }
      if (this.peek() === "]") continue;
      this.fail(
        `unexpected ${JSON.stringify(this.peek() === "" ? "end of file" : this.peek())} in an array`,
        "Array elements are separated by commas: [1, 2, 3].",
      );
    }
  }

  inlineTable(): TomlTable {
    const pos = this.pos;
    this.take(); // {
    const entries = new Map<string, TomlEntry>();
    this.skipSpace();
    if (this.peek() === "}") {
      this.take();
      return { kind: "table", entries, pos, inline: true };
    }
    for (;;) {
      this.skipSpace();
      if (this.peek() === "\n" || this.eof) {
        this.fail(
          "a newline inside an inline table",
          "An inline table is written on one line: { a = 1, b = \"x\" }.",
          pos,
        );
      }
      const k = this.key();
      if (entries.has(k.name)) {
        this.fail(`key "${k.name}" appears twice in this inline table`, undefined, k.pos);
      }
      this.skipSpace();
      if (this.peek() !== "=") {
        this.fail(
          `${JSON.stringify(this.peek() === "" ? "end of file" : this.peek())} where "=" was expected`,
          `Write it as ${k.name} = <value>.`,
        );
      }
      this.take();
      this.skipSpace();
      entries.set(k.name, { key: k.name, keyPos: k.pos, value: this.value() });
      this.skipSpace();
      if (this.peek() === ",") {
        this.take();
        this.skipSpace();
        if (this.peek() === "}") {
          this.fail(
            "a trailing comma in an inline table",
            "Inline tables do not allow a trailing comma; remove it.",
          );
        }
        continue;
      }
      if (this.peek() === "}") {
        this.take();
        return { kind: "table", entries, pos, inline: true };
      }
      this.fail(
        `unexpected ${JSON.stringify(this.peek() === "" ? "end of file" : this.peek())} in an inline table`,
        'Pairs are separated by commas: { a = 1, b = "x" }.',
      );
    }
  }

  value(): TomlValue {
    const c = this.peek();
    if (c === '"') return this.basicString();
    if (c === "'") {
      this.fail(
        "a single-quoted literal string",
        'Literal strings are not supported. Use a double-quoted string and escape what needs it.',
      );
    }
    if (c === "[") return this.array();
    if (c === "{") return this.inlineTable();
    if (c === "+" || c === "-" || /^[0-9]$/.test(c)) return this.number();
    if (/^[A-Za-z]$/.test(c)) {
      const pos = this.pos;
      let word = "";
      while (/^[A-Za-z0-9_+-]$/.test(this.peek())) word += this.take();
      if (word === "true") return { kind: "boolean", value: true, pos };
      if (word === "false") return { kind: "boolean", value: false, pos };
      if (word === "inf" || word === "nan" || word === "-inf" || word === "+inf") {
        this.fail(
          `${word} is not a value this format accepts`,
          "Infinities and NaN are not supported; a knob has to be a finite number.",
          pos,
        );
      }
      this.fail(
        `${JSON.stringify(word)} is not a value`,
        `Strings must be quoted. Did you mean ${JSON.stringify(`"${word}"`)}?`,
        pos,
      );
    }
    this.fail(
      c === ""
        ? "a value was expected, and the file ended"
        : `${JSON.stringify(c)} cannot start a value`,
      'A value is a string, a number, true, false, an array, or an inline table.',
    );
  }
}

/**
 * Walk (and create) the table at a dotted path, from `root`.
 *
 * `create` is what `[a.b]` does to `a`: it comes into existence implicitly and
 * is NOT a duplicate if `[a]` is written later. A path segment that already
 * holds something other than a table is a hard error -- silently replacing it
 * would drop whatever the author wrote there.
 */
function descend(
  s: Scanner,
  root: MutableTable,
  parts: readonly { name: string; pos: Pos }[],
  what: string,
): MutableTable {
  let cur = root;
  for (const part of parts) {
    const existing = cur.entries.get(part.name);
    if (existing === undefined) {
      const made: MutableTable = {
        kind: "table",
        entries: new Map(),
        pos: part.pos,
        inline: false,
      };
      cur.entries.set(part.name, { key: part.name, keyPos: part.pos, value: made });
      cur = made;
      continue;
    }
    if (existing.value.kind !== "table") {
      s.fail(
        `${what} would redefine "${part.name}", which is already ${describeKind(existing.value)}`,
        undefined,
        part.pos,
      );
    }
    if (existing.value.inline) {
      s.fail(
        `${what} would add to the inline table "${part.name}", which is closed`,
        "An inline table holds everything it will ever hold; write it as a [table] instead.",
        part.pos,
      );
    }
    cur = existing.value as unknown as MutableTable;
  }
  return cur;
}

/**
 * Parse a TOML document.
 *
 * Never throws: a file that is not this subset comes back as
 * `{ ok: false, error }` with a line and a column, because every caller is on
 * its way to producing a `Diagnostic` and none of them wants a try/catch.
 */
export function parseToml(text: string): TomlParse {
  const s = new Scanner(text);
  const root: MutableTable = {
    kind: "table",
    entries: new Map(),
    pos: { line: 1, column: 1 },
    inline: false,
  };

  try {
    let current = root;
    for (;;) {
      s.skipGaps();
      if (s.eof) break;

      if (s.peek() === "[") {
        const at = s.pos;
        s.take();
        if (s.peek() === "[") {
          s.fail(
            "an array of tables ([[name]])",
            "Arrays of tables are not supported. Use a [table] or an array value.",
            at,
          );
        }
        s.skipSpace();
        const path = s.keyPath();
        s.skipSpace();
        if (s.peek() !== "]") {
          s.fail(
            `${JSON.stringify(s.peek() === "" ? "end of file" : s.peek())} where "]" was expected`,
            "A table header is [name] or [outer.inner].",
          );
        }
        s.take();
        s.declare(path.parts.map((p) => p.name).join("."), at);
        current = descend(s, root, path.parts, "this table header");
        current.pos = at;
        s.endOfLine("a table header");
        continue;
      }

      const path = s.keyPath();
      s.skipSpace();
      if (s.peek() !== "=") {
        s.fail(
          `${JSON.stringify(s.peek() === "" ? "end of file" : s.peek())} where "=" was expected`,
          `Write it as ${path.parts.map((p) => p.name).join(".")} = <value>.`,
        );
      }
      s.take();
      s.skipSpace();

      const last = path.parts[path.parts.length - 1] as { name: string; pos: Pos };
      const holder = descend(s, current, path.parts.slice(0, -1), "this key");
      if (holder.entries.has(last.name)) {
        s.fail(
          `key "${last.name}" is set twice`,
          "Delete one of them; later keys do not override earlier ones inside a table.",
          last.pos,
        );
      }
      holder.entries.set(last.name, {
        key: last.name,
        keyPos: last.pos,
        value: s.value(),
      });
      s.endOfLine("a value");
    }
  } catch (e) {
    if (e instanceof Bail) return { ok: false, error: e.at };
    // Unreachable for any input: everything above fails through `Scanner.fail`.
    // If it ever fires, the position is the only thing worth keeping.
    return {
      ok: false,
      error: {
        message: `the parser failed: ${e instanceof Error ? e.message : String(e)}`,
        line: 1,
        column: 1,
      },
    };
  }

  return { ok: true, root };
}
