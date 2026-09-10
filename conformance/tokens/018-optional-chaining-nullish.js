// Derivation. `?.`, `??` and `??=` are each ONE token. But `?.` followed by a
// decimal digit is NOT the `?.` token: `c?.5:1` is `?` `.5` `:` `1`.
//
//   const v = a?.b?.[0]?.(1) ?? d;
//     [const] [v] [=] [a] [?.] [b] [?.] [[] [0] []] [?.] [(] [1] [)]
//     [??] [d] [;]                                                     = 17
//   x ??= 3;
//     [x] [??=] [3] [;]                                                =  4
//   const t = c ? .5 : 1;
//     [const] [t] [=] [c] [?] [.5] [:] [1] [;]                         =  9
//   const u = c?.5:1;
//     [const] [u] [=] [c] [?] [.5] [:] [1] [;]                         =  9
//
// Total: 39.
const v = a?.b?.[0]?.(1) ?? d;
x ??= 3;
const t = c ? .5 : 1;
const u = c?.5:1;
