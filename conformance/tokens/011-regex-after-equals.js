// Derivation. A regular expression literal is ONE token, flags included.
// After `=` (a punctuator that cannot end an expression) a `/` starts a regex.
//
//   const re = /ab+c/gi;
//     [const] [re] [=] [/ab+c/gi] [;]                                 = 5
//   x = /a/.test(s);
//     [x] [=] [/a/] [.] [test] [(] [s] [)] [;]                        = 9
//   const empty = /(?:)/;
//     [const] [empty] [=] [/(?:)/] [;]                                = 5
//
// Total: 19.
const re = /ab+c/gi;
x = /a/.test(s);
const empty = /(?:)/;
