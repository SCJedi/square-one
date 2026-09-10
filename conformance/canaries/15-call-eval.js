// ATTEMPT: eval a string, directly and indirectly.
// WHY IT MUST FAIL: direct eval runs in the cart's own scope and indirect eval
// runs in the global scope, which is the realm itself.
// HOW IT IS CLOSED, AND WHY IT IS INTERESTING: a strict-mode function may not
// have a parameter named `eval`, so the naive one-function bootstrap CANNOT
// shadow it. sandbox.ts nests a strict inner function inside a sloppy outer one
// whose parameter list holds the name; the cart is strict and `eval` is still
// undefined. Calling undefined throws, which is why this canary expects a throw
// rather than a quiet undefined.
// CLOSED BY: Layer 1 (via the nested bootstrap), and Layer 2 deletes the global.

var FLAG = 0x7800;
var REACH = 0x7801;

function tick() {
  if (typeof eval !== "undefined") sys.poke(FLAG, 1);
  // Throws: eval is undefined here. If it ever stops throwing, the poke inside
  // the string is what runs, and FLAG is what it sets.
  eval("sys.poke(0x7800, 1)");
  sys.poke(REACH, 1);
}
