// ATTEMPT: climb the prototype chain with Object.getPrototypeOf, starting from
// objects the machine itself handed the cart.
// WHY IT MATTERS SEPARATELY FROM 25 AND 26: it starts from a value the cart was
// GIVEN. `gfx.cls` is a function, its prototype is Function.prototype, and
// Function.prototype.constructor is Function. A sandbox that hands a cart any
// function at all hands it this route, which is why the ABI cannot be made safe
// by being careful about what it contains.
// CLOSED BY: Layer 2.
// EXPECTED: known-hole.

var FLAG = 0x7800;
var REACH = 0x7801;

// Proof that what came back is THE REALM and not just some object. Walking a
// prototype chain runs into Array and Object as constructors too, and calling
// those returns an array or a boxed string -- objects, but not the global one.
// A canary that counted those as an escape would cry wolf, and a canary that
// cries wolf gets weakened by the next person to read it.
function isRealm(g) {
  return !!g && typeof g === "object" && g.Object === Object;
}

function tick() {
  var starts = [function () {}, gfx.cls, sys.peek, {}, []];
  for (var i = 0; i < starts.length; i++) {
    try {
      var p = Object.getPrototypeOf(starts[i]);
      while (p !== null) {
        var C = p.constructor;
        if (typeof C === "function") {
          try {
            var g = C("return this")();
            if (isRealm(g)) sys.poke(FLAG, 1);
          } catch (e) {
            // Not the Function constructor, or denied.
          }
        }
        p = Object.getPrototypeOf(p);
      }
    } catch (e) {
      // Denied.
    }
  }
  sys.poke(REACH, 1);
}
