// Derivation. Inside a character class a `/` is an ordinary character and does
// not end the literal; an escaped `\/` does not end it either. Each regex is
// one token.
//
//   const p = /[/]/;
//     [const] [p] [=] [/[/]/] [;]                                      = 5
//   const q = /a\/b[^/]*/g;
//     [const] [q] [=] [/a\/b[^/]*/g] [;]                               = 5
//   const r = /[\]/]+/;
//     [const] [r] [=] [/[\]/]+/] [;]                                   = 5
//
// Total: 15.
const p = /[/]/;
const q = /a\/b[^/]*/g;
const r = /[\]/]+/;
