// ATTEMPT: (function(){}).constructor("return this")()
// THIS ONE WORKS ON LAYER 1 ALONE. It is the canonical escape and it is why
// scrubRealm exists.
//
// WHY NO AMOUNT OF SHADOWING CLOSES IT: parameter shadowing hides NAMES. This
// expression uses no names at all -- it makes a function value, reads its
// prototype's `constructor` property, and calls it. The result is compiled in
// the GLOBAL scope, where nothing is shadowed, so `this` is the real global
// object and every deleted-by-name capability is one property lookup away.
//
// CLOSED BY: Layer 2 only. scrubRealm replaces Function.prototype.constructor
// with a function that throws, and the property is non-configurable afterwards.
// EXPECTED: known-hole. The harness asserts the FLAG IS SET, which is what makes
// this file a control as well as a canary: if it ever stops being set while
// scrubRealm has not run, the harness has stopped detecting real escapes.

var FLAG = 0x7800;
var REACH = 0x7801;

// Proof that what came back is THE REALM rather than merely some object.
function isRealm(g) {
  return !!g && typeof g === "object" && g.Object === Object;
}

function tick() {
  try {
    var C = (function () {}).constructor;
    var g = C("return this")();
    if (isRealm(g)) sys.poke(FLAG, 1);
  } catch (e) {
    // Denied. This is what a hardened realm looks like from the inside.
  }
  sys.poke(REACH, 1);
}
