// Derivation. Non-ASCII identifiers are supported (limitation L3): an
// IdentifierStart is ID_Start plus `$` and `_`, an IdentifierPart is
// ID_Continue plus `$`, ZWNJ and ZWJ. Astral code points count as one token,
// though they advance `col` by two UTF-16 code units (limitation L6).
//
//   const café = 1;   [const] [café] [=] [1] [;]                        = 5
//   const _π = 2;     [const] [_π] [=] [2] [;]                          = 5
//   const $x0 = 3;    [const] [$x0] [=] [3] [;]                         = 5
//   const 𝑥 = 4;      [const] [𝑥] [=] [4] [;]                           = 5
//
// Total: 20. This file must be read as UTF-8.
const café = 1;
const _π = 2;
const $x0 = 3;
const 𝑥 = 4;
