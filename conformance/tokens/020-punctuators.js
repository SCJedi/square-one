// Derivation. Every compound assignment operator is exactly one token, so
// each of the first 15 lines is [a] [op] [b] [;] = 4 tokens. 15 x 4 = 60.
// Note line 4: after the identifier `a` a `/` is division, so `/=` is the
// division-assignment punctuator and not the start of a regex.
//
// Then:
//   a ** b;         [a] [**] [b] [;]                                    =  4   (64)
//   a >>> b;        [a] [>>>] [b] [;]                                   =  4   (68)
//   a === b !== c;  [a] [===] [b] [!==] [c] [;]                         =  6   (74)
//
// Total: 74.
a += b;
a -= b;
a *= b;
a /= b;
a %= b;
a **= b;
a <<= b;
a >>= b;
a >>>= b;
a &= b;
a |= b;
a ^= b;
a &&= b;
a ||= b;
a ??= b;
a ** b;
a >>> b;
a === b !== c;
