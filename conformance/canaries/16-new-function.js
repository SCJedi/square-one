// ATTEMPT: compile a string with the Function constructor, named directly.
// WHY IT MUST FAIL: a function built by `new Function` has the GLOBAL scope as
// its outer scope, not the cart's. Every shadowed parameter is invisible to it,
// so one successful call undoes all of Layer 1 at once.
// CLOSED BY: Layer 1 for this spelling only. The constructor is still reachable
// as a property of any function -- see 25-function-constructor.js, which is a
// known hole until Layer 2 runs.

var FLAG = 0x7800;
var REACH = 0x7801;

function tick() {
  if (typeof Function !== "undefined") sys.poke(FLAG, 1);
  var f = new Function("return this");
  if (f()) sys.poke(FLAG, 1);
  sys.poke(REACH, 1);
}
