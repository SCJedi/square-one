// ATTEMPT: modify a shared intrinsic prototype.
// WHY IT MATTERS: the runtime and the cart share one realm. A cart that can add
// to or replace something on Array.prototype is editing the machine's own
// standard library while the machine is running on it -- and in a player that
// runs several carts in one session, it is editing the next cart's too.
//
// THE PROPERTY NAME IS A UNIQUE MARKER AND THE HARNESS DELETES IT AFTERWARDS.
// A canary that overwrote Array.prototype.push for real would take the test
// runner down with it, and a suite that cannot run proves nothing. What is
// measured is whether the prototype is FROZEN, which is the property that
// matters; the marker is only the evidence that it is not.
//
// CLOSED BY: Layer 2, which freezes the intrinsics reachable through the scope.
// EXPECTED: known-hole.

var FLAG = 0x7800;
var REACH = 0x7801;
var NOTE = 0x7802;

function tick() {
  var proto = [].constructor.prototype;
  if (Object.isFrozen(proto)) sys.poke(NOTE, 1);
  try {
    proto.__sq1_canary__ = 1;
    if ([].__sq1_canary__ === 1) sys.poke(FLAG, 1);
  } catch (e) {
    // Frozen, and strict mode turned the silent failure into a throw.
  }
  sys.poke(REACH, 1);
}
