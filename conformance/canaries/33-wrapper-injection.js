// ATTEMPT: escape the sandbox's own wrapper text.
//
// THIS FILE IS NOT VALID JAVASCRIPT ON ITS OWN, AND THAT IS THE POINT. A cart is
// source pasted between two strings, so it is template injection waiting to
// happen. sandbox.ts wraps a cart as
//
//     return function () { "use strict"; <SOURCE> ;return {boot, tick}; }
//
// and a SOURCE that begins by closing that inner function and continuing the
// outer `return` as a comma expression runs its own code in the OUTER scope --
// which is deliberately sloppy, because a strict function may not have a
// parameter named `eval`. In sloppy code a plain function call's `this` is the
// real global object, so the line below would obtain the realm without touching
// the Function constructor at all. Layer 2 would NOT close it: it would hand
// over the hardened global, which still carries postMessage, console and Date.
//
// The assignment with no `var` is the second half of the trick: in sloppy code
// it creates a property on the global object, which the strict inner function
// can then read by name.
//
// CLOSED BY: the validation step in compileCart, which compiles the source ON
// ITS OWN as a strict function body first. Source that parses as a complete
// FunctionBody has balanced braces, so it cannot close a brace it did not open.
// EXPECTED: compile-error. If this file ever compiles, the wrapper has become
// injectable and everything else in this directory is beside the point.

}, (__sq1_escaped = (function () { return this; })()), function () {

var FLAG = 0x7800;
var REACH = 0x7801;

function tick() {
  if (typeof __sq1_escaped === "object" && __sq1_escaped !== null) sys.poke(FLAG, 1);
  sys.poke(REACH, 1);
}
