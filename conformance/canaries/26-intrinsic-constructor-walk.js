// ATTEMPT: the same escape as 25, spelled four more ways.
//   [].constructor.constructor        Array   -> Function
//   "".constructor.constructor        String  -> Function
//   Object.constructor                        -> Function
//   ({}).constructor.constructor              -> Function, with no global at all
//
// WHY SHADOWING Object AND Array WOULD NOT HELP: the last spelling starts from
// an object literal. There is no name to take away. This is the concrete reason
// sandbox.ts leaves the data intrinsics visible to carts -- hiding them costs
// cart authors real convenience and buys nothing.
//
// CLOSED BY: Layer 2. All four spellings end at the same property,
// Function.prototype.constructor, so neutering it closes them together.
// EXPECTED: known-hole.

var FLAG = 0x7800;
var REACH = 0x7801;

// Proof that what came back is THE REALM rather than merely some object.
function isRealm(g) {
  return !!g && typeof g === "object" && g.Object === Object;
}

function tick() {
  var routes = [
    function () { return [].constructor.constructor; },
    function () { return "".constructor.constructor; },
    function () { return Object.constructor; },
    function () { return ({}).constructor.constructor; }
  ];
  for (var i = 0; i < routes.length; i++) {
    try {
      var C = routes[i]();
      var g = C("return this")();
      if (isRealm(g)) sys.poke(FLAG, 1);
    } catch (e) {
      // Denied.
    }
  }
  sys.poke(REACH, 1);
}
