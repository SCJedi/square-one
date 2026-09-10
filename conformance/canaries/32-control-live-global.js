// NOT AN ESCAPE ATTEMPT. THE CONTROL.
//
// This cart is run through a DOCTORED ABI that really does hand it a live
// global, via an extra `sys.leak()` the real machine does not have. It exists to
// answer the question every canary suite has to answer about itself: if a cart
// did get out, would this harness notice?
//
// A canary that fails because of a typo looks exactly like a canary that passed.
// This is the one file in the directory whose assertion fails when the HARNESS
// stops working rather than when the sandbox does.
//
// EXPECTED: control -- the harness asserts the FLAG IS SET. If this cart ever
// comes back clean, every other result in the suite is worthless until it is
// fixed.

var FLAG = 0x7800;
var REACH = 0x7801;

function tick() {
  var g = typeof sys.leak === "function" ? sys.leak() : undefined;
  if (g && typeof g === "object") sys.poke(FLAG, 1);
  sys.poke(REACH, 1);
}
