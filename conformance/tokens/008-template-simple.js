// Derivation: a template with no substitutions is one literal chunk.
//   `hello`   -> [chunk] = 1, plus [;]            = 2
//   ``        -> [chunk (empty)] = 1, plus [;]    = 2
//   `two
//   lines`    -> [chunk] = 1, plus [;]            = 2
// Total: 6.
`hello`;
``;
`two
lines`;
