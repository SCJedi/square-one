/**
 * Square One - the normative token counter.
 *
 * A cart's budget is 8192 TOKENS, not bytes. This file defines what a token is.
 * If a second implementation disagrees with this one about any fixture in
 * `conformance/tokens/`, that implementation is wrong, not this one.
 *
 * ===========================================================================
 * COUNTING RULES (normative)
 * ===========================================================================
 *
 * R1. Tokenize per the ECMAScript lexical grammar (InputElementDiv /
 *     InputElementRegExp goals - i.e. `/` is resolved as division or as the
 *     start of a regular expression by the rule in R7).
 *
 * R2. EVERY emitted token counts as one. No exceptions, no free punctuation,
 *     no discounted keywords. `count === tokens.length`, always. Simple rules
 *     survive; clever ones drift.
 *
 * R3. Whitespace, line terminators and comments count as ZERO. They are not
 *     emitted as tokens at all. A `#!` hashbang - only on line 1, only at
 *     offset 0 - also counts as zero.
 *
 * R4. TEMPLATE LITERALS. A template is counted structurally:
 *
 *       one token per literal chunk        (always substitutions + 1 chunks,
 *                                           EVEN WHEN A CHUNK IS EMPTY)
 *     + one token per `${`
 *     + one token per `}` that closes a substitution
 *     + the tokens of each substitution expression
 *
 *     Worked examples (the fixtures pin all of these):
 *       `abc`          -> 1                  (1 chunk)
 *       ``             -> 1                  (1 chunk, empty)
 *       `a${x}b`       -> 5                  (2 chunks + ${ + } + x)
 *       `${x}`         -> 5                  (2 EMPTY chunks + ${ + } + x)
 *       `a${`b${c}d`}e`-> 9                  (outer 2 chunks + ${ + } = 4,
 *                                             inner `b${c}d` = 5)
 *
 *     The empty-chunk rule is the ambiguous part of the spec's wording and it
 *     is resolved here in favour of the STRUCTURAL count: a template with N
 *     substitutions always contributes N+1 chunk tokens. It is simpler to
 *     state, simpler to re-implement, and it never depends on the content of
 *     the literal. Pinned by 009-template-substitution.js.
 *
 *     Token boundaries are chosen so the tokens tile the source exactly:
 *       `a${x}b`  ->  [`a] [${] [x] [}] [b`]
 *     i.e. the head chunk carries the opening backtick, the tail chunk carries
 *     the closing backtick, and `${` / `}` are their own punctuator tokens.
 *
 * R5. A regular expression literal counts as ONE token - the whole literal,
 *     body and flags together.
 *
 * R6. Automatic semicolon insertion inserts nothing countable. This tokenizer
 *     is purely lexical; it never invents a `;`.
 *
 * R7. REGEX VERSUS DIVISION. Decided from the previous significant token only
 *     (comments and whitespace are not significant). A `/` begins a regular
 *     expression when:
 *       - there is no previous token; or
 *       - the previous token is a punctuator OTHER than `)` `]` `}` `++` `--`; or
 *       - the previous token is one of these keywords:
 *             case default delete do else in instanceof new of
 *             return throw typeof void await yield
 *     Otherwise `/` is division (`/` or `/=`). In particular it is division
 *     after an identifier, a number, a string, a template chunk, a regexp,
 *     a private name, and after `)` `]` `}` `++` `--`.
 *
 *     `//` and `/ *` are checked BEFORE this rule, so a comment can never be
 *     mistaken for a regex or a division.
 *
 * ===========================================================================
 * KNOWN LIMITATIONS - deliberate, documented, and pinned by fixtures
 * ===========================================================================
 *
 * L1. The R7 heuristic is the standard previous-token heuristic and it is not
 *     perfect. Real ECMAScript needs a parser to be exactly right. The three
 *     places it is knowingly wrong (all pinned by 024-regex-division-limits.js):
 *
 *       a) after `)`  - `if (a) /re/.test(b)` lexes `/` as division.
 *          We do not track whether a `)` closed an `if`/`while`/`for` head.
 *       b) after `}`  - `if (a) {} /re/.test(b)` lexes `/` as division.
 *          We do not track whether a `}` closed a block or an object literal.
 *       c) `of`, `in`, `yield`, `await` are treated as keywords unconditionally,
 *          so a variable literally named `of` followed by `/` mis-lexes:
 *          `of / 2 / 3` becomes `of` + one regexp + `3`, not five tokens.
 *
 *     These affect the COUNT, so they are part of the normative definition: a
 *     second implementation must reproduce them. They are cheap to reproduce
 *     precisely because the rule is "look at one token and nothing else".
 *
 *     `default` is included in the regex-allowing keyword set even though it
 *     cannot be reached by rule (b)/(c) reasoning, because `export default /re/g`
 *     is ordinary code and getting it wrong for no gain would be indefensible.
 *
 * L2. `\uXXXX` and `\u{...}` escape sequences INSIDE IDENTIFIERS are NOT
 *     SUPPORTED. A `\` outside a string, template, regex or comment raises a
 *     TokenizeError. Rationale: they let one identifier have two spellings, no
 *     cart needs them, and rejecting them keeps a second implementation honest.
 *     Pinned by the error tests.
 *
 * L3. Non-ASCII identifiers ARE supported, using the ECMAScript definition
 *     directly: IdentifierStart = ID_Start plus `$` and `_`; IdentifierPart =
 *     ID_Continue plus `$`, ZWNJ (U+200C) and ZWJ (U+200D). Astral code points
 *     (surrogate pairs) are handled. Pinned by 025-unicode-identifiers.js.
 *
 * L4. This is a lexer, not a validator. Syntactically impossible token
 *     sequences are counted, not rejected: `}` with nothing open, `3in`, a
 *     legacy octal `0755`, a BigInt with a fraction. Only genuinely
 *     unterminatable input raises TokenizeError (see below).
 *
 * L5. Annex B HTML-like comments (`<!--`, `-->`) are NOT treated as comments.
 *     They lex as ordinary operators. Module and script sources agree here.
 *
 * L6. `col` is 1-based and counted in UTF-16 code units (JavaScript string
 *     indices), which is also what `start`/`end` are. An astral character
 *     therefore advances the column by 2.
 *
 * ===========================================================================
 * ERRORS
 * ===========================================================================
 * TokenizeError is raised, with the line/col/offset of where the construct
 * STARTED, for: an unterminated string, an unterminated template, an
 * unterminated block comment, an unterminated regular expression, a `#` not
 * followed by an identifier, a radix literal with no digits, a `\` outside a
 * literal (see L2), and any character that cannot begin a token. The scanner
 * always makes forward progress, so it can never hang.
 */

export type TokenType =
  | "ident"
  | "keyword"
  | "number"
  | "string"
  | "template"
  | "regexp"
  | "punct"
  | "private";

export interface Token {
  /** Lexical class. Informational only - every type counts exactly one. */
  type: TokenType;
  /** Offset into `src`, in UTF-16 code units, inclusive. */
  start: number;
  /** Offset into `src`, in UTF-16 code units, exclusive. */
  end: number;
  /** 1-based line of `start`. */
  line: number;
  /** 1-based column of `start`, in UTF-16 code units. */
  col: number;
  /** The raw source slice `src.slice(start, end)`. */
  value: string;
}

export interface TokenizeResult {
  tokens: Token[];
  /** Always `tokens.length` (rule R2). This is the number that the budget uses. */
  count: number;
}

export class TokenizeError extends Error {
  readonly line: number;
  readonly col: number;
  readonly offset: number;

  constructor(message: string, line: number, col: number, offset: number) {
    super(`${message} (${line}:${col})`);
    this.name = "TokenizeError";
    this.line = line;
    this.col = col;
    this.offset = offset;
    // Keep `instanceof` working when this file is downlevelled.
    Object.setPrototypeOf(this, TokenizeError.prototype);
  }
}

// --------------------------------------------------------------------------
// Character classes
// --------------------------------------------------------------------------

const CH_TAB = 0x09;
const CH_LF = 0x0a;
const CH_VT = 0x0b;
const CH_FF = 0x0c;
const CH_CR = 0x0d;
const CH_SPACE = 0x20;
const CH_BANG = 0x21;
const CH_DQUOTE = 0x22;
const CH_HASH = 0x23;
const CH_DOLLAR = 0x24;
const CH_SQUOTE = 0x27;
const CH_STAR = 0x2a;
const CH_PLUS = 0x2b;
const CH_MINUS = 0x2d;
const CH_DOT = 0x2e;
const CH_SLASH = 0x2f;
const CH_0 = 0x30;
const CH_9 = 0x39;
const CH_A_UPPER = 0x41;
const CH_Z_UPPER = 0x5a;
const CH_LBRACKET = 0x5b;
const CH_BACKSLASH = 0x5c;
const CH_RBRACKET = 0x5d;
const CH_UNDERSCORE = 0x5f;
const CH_BACKTICK = 0x60;
const CH_A_LOWER = 0x61;
const CH_B_LOWER = 0x62;
const CH_E_LOWER = 0x65;
const CH_N_LOWER = 0x6e;
const CH_O_LOWER = 0x6f;
const CH_X_LOWER = 0x78;
const CH_Z_LOWER = 0x7a;
const CH_LBRACE = 0x7b;
const CH_RBRACE = 0x7d;
const CH_NBSP = 0x00a0;
const CH_LS = 0x2028;
const CH_PS = 0x2029;
const CH_BOM = 0xfeff;

const ZS_RE = /\p{Zs}/u;
const ID_START_RE = /[$_\p{ID_Start}]/u;
// `_` is ID_Continue already; ZWNJ/ZWJ are spelled as escapes on purpose.
const ID_PART_RE = /[$\u200C\u200D\p{ID_Continue}]/u;

function isLineTerminator(c: number): boolean {
  return c === CH_LF || c === CH_CR || c === CH_LS || c === CH_PS;
}

function isWhiteSpace(c: number): boolean {
  if (c === CH_SPACE || c === CH_TAB || c === CH_VT || c === CH_FF) return true;
  if (c < 0x80) return false;
  if (c === CH_NBSP || c === CH_BOM) return true;
  return ZS_RE.test(String.fromCharCode(c));
}

function isDigit(c: number): boolean {
  return c >= CH_0 && c <= CH_9;
}

/** A decimal digit or a numeric separator `_`. Separator placement is not validated (L4). */
function isDigitOrSep(c: number): boolean {
  return isDigit(c) || c === CH_UNDERSCORE;
}

function isHexDigit(c: number): boolean {
  if (isDigit(c)) return true;
  const lower = c | 0x20;
  return lower >= CH_A_LOWER && lower <= 0x66; // a..f
}

function isOctalDigit(c: number): boolean {
  return c >= CH_0 && c <= 0x37;
}

function isBinaryDigit(c: number): boolean {
  return c === CH_0 || c === 0x31;
}

// --------------------------------------------------------------------------
// Keywords
// --------------------------------------------------------------------------

/**
 * Words classified as `type: "keyword"`. Classification is informational, EXCEPT
 * that it feeds the regex-versus-division rule (R7) via REGEX_ALLOWED_KEYWORDS.
 * The only contextual keyword in this set whose classification can change a
 * COUNT is `of` (see limitation L1c).
 */
const KEYWORDS: ReadonlySet<string> = new Set([
  // ReservedWord
  "await", "break", "case", "catch", "class", "const", "continue", "debugger",
  "default", "delete", "do", "else", "enum", "export", "extends", "false",
  "finally", "for", "function", "if", "import", "in", "instanceof", "new",
  "null", "return", "super", "switch", "this", "throw", "true", "try",
  "typeof", "var", "void", "while", "with", "yield",
  // strict-mode reserved / contextual words that behave as keywords here
  "let", "static", "implements", "interface", "package", "private",
  "protected", "public", "async", "of",
]);

/** Keywords after which a `/` starts a regular expression (rule R7). */
const REGEX_ALLOWED_KEYWORDS: ReadonlySet<string> = new Set([
  "case", "default", "delete", "do", "else", "in", "instanceof", "new", "of",
  "return", "throw", "typeof", "void", "await", "yield",
]);

/** Punctuators after which a `/` is DIVISION, not a regex (rule R7). */
const EXPR_ENDING_PUNCT: ReadonlySet<string> = new Set([")", "]", "}", "++", "--"]);

// Punctuators, longest first. `${` is produced by the template scanner, not here.
const PUNCT_4: readonly string[] = [">>>="];
const PUNCT_3: readonly string[] = [
  "...", "===", "!==", "**=", "<<=", ">>=", ">>>", "&&=", "||=", "??=",
];
const PUNCT_2: readonly string[] = [
  "=>", "==", "!=", "<=", ">=", "&&", "||", "??", "?.", "++", "--",
  "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "<<", ">>", "**",
];
const PUNCT_1 = "{}()[];,<>+-*/%&|^!~?:=.";

// --------------------------------------------------------------------------
// The scanner
// --------------------------------------------------------------------------

type BraceFrame = { kind: "block" } | { kind: "template"; start: number };

/**
 * Tokenize `src` per the rules at the top of this file.
 * @throws {TokenizeError} on unterminated or un-lexable input.
 */
export function tokenize(src: string): TokenizeResult {
  const tokens: Token[] = [];
  const braces: BraceFrame[] = [];
  const len = src.length;

  let i = 0;

  // Monotonic line/column cursor. `sync` only ever moves forward, which keeps
  // position tracking O(n) over the whole file.
  let line = 1;
  let lineStart = 0;
  let cursor = 0;

  function sync(to: number): void {
    while (cursor < to) {
      const c = src.charCodeAt(cursor);
      cursor++;
      if (c === CH_LF) {
        // A CRLF pair is one line terminator sequence; the CR already counted.
        if (cursor >= 2 && src.charCodeAt(cursor - 2) === CH_CR) lineStart = cursor;
        else {
          line++;
          lineStart = cursor;
        }
      } else if (c === CH_CR || c === CH_LS || c === CH_PS) {
        line++;
        lineStart = cursor;
      }
    }
  }

  /** Position of an arbitrary offset, computed from scratch (error paths only). */
  function locate(off: number): { line: number; col: number } {
    let ln = 1;
    let ls = 0;
    const stop = off < len ? off : len;
    for (let k = 0; k < stop; k++) {
      const c = src.charCodeAt(k);
      if (c === CH_LF) {
        if (k > 0 && src.charCodeAt(k - 1) === CH_CR) ls = k + 1;
        else {
          ln++;
          ls = k + 1;
        }
      } else if (c === CH_CR || c === CH_LS || c === CH_PS) {
        ln++;
        ls = k + 1;
      }
    }
    return { line: ln, col: off - ls + 1 };
  }

  function fail(message: string, at: number): never {
    const p = locate(at);
    throw new TokenizeError(message, p.line, p.col, at);
  }

  function push(type: TokenType, start: number, end: number): void {
    sync(start);
    tokens.push({
      type,
      start,
      end,
      line,
      col: start - lineStart + 1,
      value: src.slice(start, end),
    });
  }

  // ---- identifier helpers (surrogate-pair aware) --------------------------

  function charSizeAt(k: number): number {
    const c = src.charCodeAt(k);
    if (c >= 0xd800 && c <= 0xdbff && k + 1 < len) {
      const d = src.charCodeAt(k + 1);
      if (d >= 0xdc00 && d <= 0xdfff) return 2;
    }
    return 1;
  }

  function isIdentStartAt(k: number): boolean {
    if (k >= len) return false;
    const c = src.charCodeAt(k);
    if (c < 0x80) {
      return (
        (c >= CH_A_LOWER && c <= CH_Z_LOWER) ||
        (c >= CH_A_UPPER && c <= CH_Z_UPPER) ||
        c === CH_DOLLAR ||
        c === CH_UNDERSCORE
      );
    }
    const cp = src.codePointAt(k);
    if (cp === undefined) return false;
    return ID_START_RE.test(String.fromCodePoint(cp));
  }

  function isIdentPartAt(k: number): boolean {
    if (k >= len) return false;
    const c = src.charCodeAt(k);
    if (c < 0x80) {
      return (
        (c >= CH_A_LOWER && c <= CH_Z_LOWER) ||
        (c >= CH_A_UPPER && c <= CH_Z_UPPER) ||
        isDigit(c) ||
        c === CH_DOLLAR ||
        c === CH_UNDERSCORE
      );
    }
    const cp = src.codePointAt(k);
    if (cp === undefined) return false;
    return ID_PART_RE.test(String.fromCodePoint(cp));
  }

  // ---- rule R7 ------------------------------------------------------------

  function regexAllowed(): boolean {
    const prev = tokens[tokens.length - 1];
    if (prev === undefined) return true;
    if (prev.type === "punct") return !EXPR_ENDING_PUNCT.has(prev.value);
    if (prev.type === "keyword") return REGEX_ALLOWED_KEYWORDS.has(prev.value);
    // ident, number, string, template chunk, regexp, private name: division.
    return false;
  }

  // ---- literal scanners ---------------------------------------------------

  function readString(quote: number): void {
    const start = i;
    let j = i + 1;
    for (;;) {
      if (j >= len) fail("unterminated string literal", start);
      const c = src.charCodeAt(j);
      if (c === CH_BACKSLASH) {
        j++;
        if (j >= len) fail("unterminated string literal", start);
        // A LineContinuation consumes the whole terminator sequence, CRLF included.
        if (src.charCodeAt(j) === CH_CR && src.charCodeAt(j + 1) === CH_LF) j += 2;
        else j++;
        continue;
      }
      // U+2028/U+2029 are legal inside string literals (ES2019); LF and CR are not.
      if (c === CH_LF || c === CH_CR) fail("unterminated string literal", start);
      if (c === quote) {
        j++;
        break;
      }
      j++;
    }
    push("string", start, j);
    i = j;
  }

  /**
   * Scan one template chunk and everything that terminates it.
   * `valueStart` is the first code unit of the chunk token (the opening backtick
   * for a head chunk, the code unit after `}` for a middle/tail chunk).
   * `scanFrom` is where chunk CONTENT begins.
   */
  function scanTemplateChunk(valueStart: number, scanFrom: number, templateStart: number): void {
    let j = scanFrom;
    for (;;) {
      if (j >= len) fail("unterminated template literal", templateStart);
      const c = src.charCodeAt(j);
      if (c === CH_BACKSLASH) {
        j += 2;
        continue;
      }
      if (c === CH_BACKTICK) {
        push("template", valueStart, j + 1);
        i = j + 1;
        return;
      }
      if (c === CH_DOLLAR && src.charCodeAt(j + 1) === CH_LBRACE) {
        push("template", valueStart, j);
        push("punct", j, j + 2);
        braces.push({ kind: "template", start: templateStart });
        i = j + 2;
        return;
      }
      j++;
    }
  }

  function readRegExp(): void {
    const start = i;
    let j = i + 1;
    let inClass = false;
    for (;;) {
      if (j >= len) fail("unterminated regular expression literal", start);
      const c = src.charCodeAt(j);
      if (isLineTerminator(c)) fail("unterminated regular expression literal", start);
      if (c === CH_BACKSLASH) {
        if (j + 1 >= len || isLineTerminator(src.charCodeAt(j + 1))) {
          fail("unterminated regular expression literal", start);
        }
        j += 2;
        continue;
      }
      if (c === CH_LBRACKET) {
        inClass = true;
        j++;
        continue;
      }
      if (c === CH_RBRACKET) {
        inClass = false;
        j++;
        continue;
      }
      // Inside a character class a `/` is an ordinary character: /[/]/ is legal.
      if (c === CH_SLASH && !inClass) {
        j++;
        break;
      }
      j++;
    }
    while (j < len && isIdentPartAt(j)) j += charSizeAt(j);
    push("regexp", start, j);
    i = j;
  }

  function readNumber(): void {
    const start = i;
    let j = i;

    if (src.charCodeAt(j) === CH_0 && j + 1 < len) {
      const marker = src.charCodeAt(j + 1) | 0x20;
      if (marker === CH_X_LOWER || marker === CH_O_LOWER || marker === CH_B_LOWER) {
        const name =
          marker === CH_X_LOWER ? "hexadecimal" : marker === CH_O_LOWER ? "octal" : "binary";
        const test =
          marker === CH_X_LOWER ? isHexDigit : marker === CH_O_LOWER ? isOctalDigit : isBinaryDigit;
        j += 2;
        const digitsStart = j;
        while (j < len) {
          const c = src.charCodeAt(j);
          if (test(c) || c === CH_UNDERSCORE) j++;
          else break;
        }
        if (j === digitsStart) fail(`invalid ${name} literal`, start);
        if (j < len && src.charCodeAt(j) === CH_N_LOWER) j++; // BigInt suffix
        push("number", start, j);
        i = j;
        return;
      }
    }

    while (j < len && isDigitOrSep(src.charCodeAt(j))) j++;

    if (j < len && src.charCodeAt(j) === CH_N_LOWER) {
      j++; // BigInt suffix
      push("number", start, j);
      i = j;
      return;
    }

    if (j < len && src.charCodeAt(j) === CH_DOT) {
      j++; // `5.` and `.5` and `1.5`
      while (j < len && isDigitOrSep(src.charCodeAt(j))) j++;
    }

    if (j < len && (src.charCodeAt(j) | 0x20) === CH_E_LOWER) {
      let k = j + 1;
      if (k < len) {
        const sign = src.charCodeAt(k);
        if (sign === CH_PLUS || sign === CH_MINUS) k++;
      }
      if (k < len && isDigit(src.charCodeAt(k))) {
        k++;
        while (k < len && isDigitOrSep(src.charCodeAt(k))) k++;
        j = k;
      }
      // Otherwise the `e` is not an exponent; leave it to the identifier scanner.
    }

    push("number", start, j);
    i = j;
  }

  function readIdentifier(): void {
    const start = i;
    let j = i + charSizeAt(i);
    while (j < len && isIdentPartAt(j)) j += charSizeAt(j);
    const value = src.slice(start, j);
    push(KEYWORDS.has(value) ? "keyword" : "ident", start, j);
    i = j;
  }

  function readPrivateName(): void {
    const start = i;
    if (!isIdentStartAt(i + 1)) fail("expected an identifier after '#'", i);
    let j = i + 1 + charSizeAt(i + 1);
    while (j < len && isIdentPartAt(j)) j += charSizeAt(j);
    push("private", start, j);
    i = j;
  }

  function emitPunct(start: number, end: number): void {
    const value = src.slice(start, end);
    if (value === "{") {
      braces.push({ kind: "block" });
    } else if (value === "}") {
      const top = braces.pop();
      if (top !== undefined && top.kind === "template") {
        // This `}` closes a substitution: emit it, then resume the template.
        push("punct", start, end);
        i = end;
        scanTemplateChunk(end, end, top.start);
        return;
      }
    }
    push("punct", start, end);
    i = end;
  }

  function readPunct(): void {
    for (const p of PUNCT_4) {
      if (src.startsWith(p, i)) return emitPunct(i, i + p.length);
    }
    for (const p of PUNCT_3) {
      if (src.startsWith(p, i)) return emitPunct(i, i + p.length);
    }
    for (const p of PUNCT_2) {
      if (src.startsWith(p, i)) {
        // `a?.5:b` is `?` `.5` `:` `b`, not `?.` - the spec's one lookahead-2 rule.
        if (p === "?." && isDigit(src.charCodeAt(i + 2))) break;
        return emitPunct(i, i + p.length);
      }
    }
    const c = src[i];
    if (c !== undefined && PUNCT_1.includes(c)) return emitPunct(i, i + 1);
    fail(`unexpected character ${JSON.stringify(c ?? "")}`, i);
  }

  // ---- hashbang (rule R3): line 1 only, offset 0 only ---------------------

  if (src.charCodeAt(0) === CH_HASH && src.charCodeAt(1) === CH_BANG) {
    i = 2;
    while (i < len && !isLineTerminator(src.charCodeAt(i))) i++;
  }

  // ---- main loop ----------------------------------------------------------

  while (i < len) {
    const c = src.charCodeAt(i);

    if (isWhiteSpace(c) || isLineTerminator(c)) {
      i++;
      continue;
    }

    if (c === CH_SLASH) {
      const next = src.charCodeAt(i + 1);
      if (next === CH_SLASH) {
        i += 2;
        while (i < len && !isLineTerminator(src.charCodeAt(i))) i++;
        continue;
      }
      if (next === CH_STAR) {
        const start = i;
        i += 2;
        for (;;) {
          if (i >= len) fail("unterminated block comment", start);
          if (src.charCodeAt(i) === CH_STAR && src.charCodeAt(i + 1) === CH_SLASH) {
            i += 2;
            break;
          }
          i++;
        }
        continue;
      }
      if (regexAllowed()) {
        readRegExp();
        continue;
      }
      readPunct(); // `/=` or `/`
      continue;
    }

    if (c === CH_DQUOTE || c === CH_SQUOTE) {
      readString(c);
      continue;
    }

    if (c === CH_BACKTICK) {
      scanTemplateChunk(i, i + 1, i);
      continue;
    }

    if (isDigit(c) || (c === CH_DOT && isDigit(src.charCodeAt(i + 1)))) {
      readNumber();
      continue;
    }

    if (c === CH_HASH) {
      readPrivateName();
      continue;
    }

    if (c === CH_BACKSLASH) {
      // Limitation L2.
      fail("unicode escape sequences in identifiers are not supported", i);
    }

    if (isIdentStartAt(i)) {
      readIdentifier();
      continue;
    }

    readPunct();
  }

  for (let k = braces.length - 1; k >= 0; k--) {
    const frame = braces[k];
    if (frame !== undefined && frame.kind === "template") {
      fail("unterminated template literal", frame.start);
    }
  }

  return { tokens, count: tokens.length };
}

/** The budget number: how many tokens `src` costs. */
export function countTokens(src: string): number {
  return tokenize(src).count;
}
