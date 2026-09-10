// ATTEMPT: reach dynamic import through a constructed function.
// WHY IT IS THE WORST ONE HERE: sandbox.ts rejects the `import` keyword in cart
// SOURCE (Layer 0), because no binding can shadow syntax. A string handed to the
// Function constructor is not cart source and never passes through that check,
// and the function it builds is compiled in the global scope, where `import()`
// resolves. Under Node that reaches the filesystem. In a browser worker it
// reaches the network.
//
// THIS CANARY DELIBERATELY DOES NOT CALL WHAT IT BUILDS. Obtaining the compiler
// is the finding; actually importing something during a test run would make the
// suite reach the network in order to prove that it can. The module specifier is
// assembled from pieces for the same reason the call is omitted -- so that no
// reader, and no tool, mistakes this file for something that performs the
// import.
//
// CLOSED BY: Layer 2 -- the constructor is neutered, so the string is never
// compiled. Layer 0 alone does not close it, and that is the point.
// EXPECTED: known-hole.

var FLAG = 0x7800;
var REACH = 0x7801;

function tick() {
  try {
    var C = (function () {}).constructor;
    var f = C("return " + "imp" + "ort('data:text/javascript,export default 1')");
    if (typeof f === "function") sys.poke(FLAG, 1);
  } catch (e) {
    // Denied.
  }
  sys.poke(REACH, 1);
}
