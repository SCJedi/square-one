// Derivation. Rule R4: one per literal chunk (always substitutions + 1, EVEN
// WHEN EMPTY), one per `${`, one per closing `}`, plus the substitution tokens.
//
//   `a${x}b`;   chunks [`a] [b`] = 2, [${] = 1, [}] = 1, [x] = 1, [;] = 1 -> 6
//   `${y}`;     chunks [`] [`]   = 2 (both empty), [${] [}] [y] [;]       -> 6
//   `p${a}q${b}r`;
//               chunks [`p] [q] [r`] = 3, two [${] = 2, two [}] = 2,
//               [a] [b] = 2, [;] = 1                                      -> 10
// Total: 6 + 6 + 10 = 22.
`a${x}b`;
`${y}`;
`p${a}q${b}r`;
