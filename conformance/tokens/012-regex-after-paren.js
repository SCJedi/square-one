// Derivation. A `(` cannot end an expression, so a `/` after it starts a regex.
// Same for `,` and for the keyword `return`.
//
//   f(/a/);
//     [f] [(] [/a/] [)] [;]                                            = 5
//   g(1, /b/i);
//     [g] [(] [1] [,] [/b/i] [)] [;]                                   = 7
//   function h() { return /c/; }
//     [function] [h] [(] [)] [{] [return] [/c/] [;] [}]                = 9
//
// Total: 21.
f(/a/);
g(1, /b/i);
function h() { return /c/; }
