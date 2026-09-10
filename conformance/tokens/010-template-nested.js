// Derivation: a template inside a substitution inside a template.
//
//   `a${ `b${ c }d` }e`;
//     outer chunks [`a] [e`]        = 2
//     outer [${] and [}]            = 2
//     inner template `b${ c }d`:
//       chunks [`b] [d`]            = 2
//       [${] and [}]                = 2
//       [c]                         = 1      (inner subtotal 5)
//     [;]                           = 1
//   subtotal                        = 10
//
//   `${`${x}`}`;
//     outer chunks (both empty)     = 2
//     outer [${] [}]                = 2
//     inner template `${x}`:
//       chunks (both empty)         = 2
//       [${] [}]                    = 2
//       [x]                         = 1      (inner subtotal 5)
//     [;]                           = 1
//   subtotal                        = 10
//
// Total: 20.
`a${ `b${ c }d` }e`;
`${`${x}`}`;
