// ATTEMPT: name the global object by its worker alias.
// WHY IT MUST FAIL: inside a Worker, `self` IS the global object, and it also
// carries postMessage -- the host protocol channel. A cart that can post
// messages can forge frames and faults at the host.
// CLOSED BY: Layer 1. Layer 2 deliberately KEEPS the real `self` and
// `postMessage` bindings, because worker.ts needs them to answer the host; the
// shadowing is what denies them to the cart.

var FLAG = 0x7800;
var REACH = 0x7801;

function tick() {
  if (typeof self !== "undefined") sys.poke(FLAG, 1);
  if (typeof postMessage !== "undefined") sys.poke(FLAG, 1);
  sys.poke(REACH, 1);
}
