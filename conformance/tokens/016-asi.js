// Derivation. Automatic semicolon insertion inserts nothing countable, so a
// line that relies on ASI costs exactly what is written.
//
//   let a = 1        [let] [a] [=] [1]                                  = 4
//   let b = 2        [let] [b] [=] [2]                                  = 4
//   a = a + b        [a] [=] [a] [+] [b]                                = 5
//   let c = a        [let] [c] [=] [a]                                  = 4
//   ++b              [++] [b]                                           = 2
//   function f() {   [function] [f] [(] [)] [{]                         = 5
//     return         [return]                                           = 1
//     1              [1]                                                = 1
//   }                [}]                                                = 1
//
// Total: 27.
let a = 1
let b = 2
a = a + b
let c = a
++b
function f() {
  return
  1
}
