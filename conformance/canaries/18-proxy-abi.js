// ATTEMPT: wrap an ABI object in a Proxy.
// WHY IT MUST FAIL: a Proxy around `sys` would let a cart observe and rewrite
// every call the machine makes through it, including calls the machine itself
// makes on the cart's behalf. It is not an escape from the realm; it is a way
// to make the ABI lie, and a machine whose ABI lies cannot be replayed.
// CLOSED BY: Layer 1.

var FLAG = 0x7800;
var REACH = 0x7801;

function tick() {
  if (typeof Proxy !== "undefined") sys.poke(FLAG, 1);
  // Throws: Proxy is undefined, so it is not a constructor.
  var fake = new Proxy(sys, {
    get: function (t, k) {
      return t[k];
    }
  });
  if (fake) sys.poke(FLAG, 1);
  sys.poke(REACH, 1);
}
