// Derivation. `=>` is one token and `...` is one token.
//
//   const f = (a, ...rest) => a + rest.length;
//     [const] [f] [=] [(] [a] [,] [...] [rest] [)] [=>] [a] [+] [rest]
//     [.] [length] [;]                                                 = 16
//   const g = x => ({ x });
//     [const] [g] [=] [x] [=>] [(] [{] [x] [}] [)] [;]                 = 11
//   const arr = [...a, ...b];
//     [const] [arr] [=] [[] [...] [a] [,] [...] [b] []] [;]            = 11
//   h(...args);
//     [h] [(] [...] [args] [)] [;]                                     =  6
//
// Total: 44.
const f = (a, ...rest) => a + rest.length;
const g = x => ({ x });
const arr = [...a, ...b];
h(...args);
