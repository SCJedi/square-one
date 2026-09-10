// Derivation. A private name `#n` is ONE token, including the `#`.
//
//   class C {                          [class] [C] [{]                  =  3
//     #n = 0;                          [#n] [=] [0] [;]                 =  4
//     inc() { this.#n++; return this.#n; }
//                                      [inc] [(] [)] [{] [this] [.] [#n]
//                                      [++] [;] [return] [this] [.] [#n]
//                                      [;] [}]                          = 15
//     static #s = 1;                   [static] [#s] [=] [1] [;]        =  5
//     has(o) { return #n in o; }       [has] [(] [o] [)] [{] [return]
//                                      [#n] [in] [o] [;] [}]            = 11
//   }                                  [}]                              =  1
//
// Total: 3 + 4 + 15 + 5 + 11 + 1 = 39.
class C {
  #n = 0;
  inc() { this.#n++; return this.#n; }
  static #s = 1;
  has(o) { return #n in o; }
}
