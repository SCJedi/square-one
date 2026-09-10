// Derivation. After `)` and after `]` a `/` is division.
//
//   const a = (x + y) / 2;
//     [const] [a] [=] [(] [x] [+] [y] [)] [/] [2] [;]                  = 11
//   const b = arr[0] / 2;
//     [const] [b] [=] [arr] [[] [0] []] [/] [2] [;]                    = 10
//   const c = f(1) / g(2);
//     [const] [c] [=] [f] [(] [1] [)] [/] [g] [(] [2] [)] [;]          = 13
//
// Total: 34.
const a = (x + y) / 2;
const b = arr[0] / 2;
const c = f(1) / g(2);
