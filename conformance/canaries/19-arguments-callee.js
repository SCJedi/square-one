// ATTEMPT: walk out through arguments.callee and .caller.
// WHY IT MUST FAIL: in sloppy mode, `arguments.callee.caller` climbs the call
// stack into the machine's own frames, which hold the api object, the RAM view
// and everything else the cart is not supposed to reach.
// CLOSED BY: Layer 1 -- the cart body is strict, and strict functions poison
// `callee`, `caller` and `arguments` with a throwing accessor. The throw IS the
// defence, so this canary expects one.

var FLAG = 0x7800;
var REACH = 0x7801;

function tick() {
  var climber = function () {
    return arguments.callee;
  };
  var f = climber();
  if (f) sys.poke(FLAG, 1);
  sys.poke(REACH, 1);
}
