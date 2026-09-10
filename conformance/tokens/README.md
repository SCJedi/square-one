# Token conformance fixtures

These files define the Square One token budget. A cart may spend 8192 tokens;
`packages/core/src/tokenize.ts` decides what a token is, and this directory is
how a second implementation proves it agrees.

**A second implementation is conformant when `countTokens(source)` returns the
number in `expected.json` for every file here.** Nothing else is required of it,
and nothing here may be skipped.

## Layout

```
NNN-short-name.js   a fixture source, UTF-8, one focused construct
expected.json       { "NNN-short-name.js": <token count>, ... }
```

`001-empty.js` is intentionally a zero-byte file, which is why it carries no
header comment. Every other fixture starts with a comment deriving its count
token by token; those comments cost zero, so they never change the answer.

`packages/core/test/tokenize.test.ts` reads this directory rather than a
hardcoded list. A fixture with no entry in `expected.json`, or an entry with no
fixture, fails the suite.

## What the current set covers

| fixture | pins |
| --- | --- |
| 001, 003 | empty input; comments and whitespace cost zero |
| 002 | a lone identifier |
| 004 | `#!` hashbang, line 1 only, costs zero |
| 005, 006 | every numeric form: decimal, leading/trailing dot, exponents, hex, octal, binary, BigInt `n`, `_` separators |
| 007 | quotes, escapes, a line continuation |
| 008, 009, 010 | template chunk counting, including the EMPTY-CHUNK rule and a template nested two deep |
| 011, 012 | regex after `=`, `(`, `,` and `return` |
| 013, 014 | division after an identifier, a number, `)` and `]`; and `/=` |
| 015 | a `/` inside a character class and an escaped `\/` |
| 016 | ASI inserts nothing countable |
| 017 | private names `#n`, including `#n in o` |
| 018 | `?.`, `??`, `??=`, and `c?.5:1` lexing as `?` `.5` `:` `1` |
| 019 | `=>` and `...` |
| 020 | every compound assignment operator |
| 021 | keywords cost the same as anything else |
| 022 | a realistic ~40 line tick/draw pair (309 tokens) |
| 023 | exactly 100 tokens, so budget arithmetic is checkable by eye |
| 024 | the three documented regex-versus-division limitations |
| 025 | non-ASCII and astral identifiers |

## Adding a fixture

1. Name it `NNN-short-name.js`, taking the next free `NNN`.
2. Keep it small and about ONE thing. A fixture that fails should say what broke.
3. **Derive the count by hand** and write the derivation as a header comment,
   token by token, the way the existing files do. Do not paste what the
   tokenizer printed - a fixture whose expected value came from the
   implementation tests nothing.
4. Add the entry to `expected.json`.
5. Run `npx vitest run packages/core/test/tokenize.test.ts`. If the tokenizer
   disagrees, recount by hand before you decide which one is wrong.

A fixture may pin a documented limitation (024 does). Say so in its header, and
say what a real parser would have counted, so the next reader knows the number
is deliberate rather than a bug that got blessed.
