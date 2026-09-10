// ATTEMPT: reach the network with fetch.
// WHY IT MUST FAIL: the whole claim of the cart format is that a game is
// structurally incapable of reaching the network. One live fetch and a cart can
// exfiltrate whatever it can see and phone home for new code.
// CLOSED BY: Layer 1, and again by Layer 2 (the global is deleted).

var FLAG = 0x7800;
var REACH = 0x7801;

function tick() {
  if (typeof fetch !== "undefined") sys.poke(FLAG, 1);
  sys.poke(REACH, 1);
}
