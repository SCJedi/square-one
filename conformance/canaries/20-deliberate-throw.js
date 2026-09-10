// ATTEMPT: nothing. This cart is simply broken, on purpose.
// WHY IT IS HERE: the harness has to be able to tell "the sandbox denied it"
// from "the cart fell over", and a fault has to stay a fault. worker.ts drops
// the machine on any throw, because a tick that died halfway leaves memory no
// replay can reproduce -- continuing would turn a crash into a silent desync.
// EXPECTED: a throw, no flag, and a machine the host can discard.

var FLAG = 0x7800;
var REACH = 0x7801;

function tick() {
  var n = sys.frame();
  if (n >= 0) throw new Error("this cart is meant to fail");
  sys.poke(REACH, 1);
}
