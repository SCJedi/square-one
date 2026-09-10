// ATTEMPT: name the global object directly.
// WHY IT MUST FAIL: globalThis is every other escape at once. If a cart holds
// it, nothing else on this list matters.
// CLOSED BY: Layer 1.

var FLAG = 0x7800;
var REACH = 0x7801;

function tick() {
  if (typeof globalThis !== "undefined") sys.poke(FLAG, 1);
  sys.poke(REACH, 1);
}
