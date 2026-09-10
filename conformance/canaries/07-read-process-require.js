// ATTEMPT: find Node. A cart is built and validated by tools that run under
// Node, so a cart that only escapes on a developer's machine still escapes.
// WHY IT MUST FAIL: process.env is credentials, require is the filesystem.
// CLOSED BY: Layer 1.

var FLAG = 0x7800;
var REACH = 0x7801;

function tick() {
  if (typeof process !== "undefined") sys.poke(FLAG, 1);
  if (typeof require !== "undefined") sys.poke(FLAG, 1);
  if (typeof module !== "undefined") sys.poke(FLAG, 1);
  if (typeof global !== "undefined") sys.poke(FLAG, 1);
  if (typeof Buffer !== "undefined") sys.poke(FLAG, 1);
  sys.poke(REACH, 1);
}
