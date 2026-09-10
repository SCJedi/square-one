// Derivation. After an identifier or a number a `/` is division, so each `/`
// is its own punctuator token.
//
//   const a = b / c;
//     [const] [a] [=] [b] [/] [c] [;]                                  = 7
//   const d = 10 / 2 / 5;
//     [const] [d] [=] [10] [/] [2] [/] [5] [;]                         = 9
//   e /= 2;
//     [e] [/=] [2] [;]                                                 = 4
//
// Total: 20.
const a = b / c;
const d = 10 / 2 / 5;
e /= 2;
