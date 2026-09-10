// ATTEMPT: keep state on the ABI objects, and replace an ABI method.
// WHY IT MATTERS: this is not an escape from the realm -- gfx, inp and sys
// belong to the cart's own machine and tampering with them can only hurt the
// cart. It is a DETERMINISM hole. Everything a running game is, is supposed to
// be inside RAM: that is what makes snapshot() a memcpy and a rewind bit-exact.
// A counter parked on `sys` survives a restore, because restore copies RAM and
// cannot see a property on an object.
// EXPECTED: harmless. NOTE is set when the parked value survived to the next
// tick, which is the finding: machine.ts should freeze the api objects.

var FLAG = 0x7800;
var REACH = 0x7801;
var NOTE = 0x7802;

function tick() {
  if (sys.smuggled !== undefined) sys.poke(NOTE, 1);
  try {
    sys.smuggled = (sys.smuggled || 0) + 1;
  } catch (e) {
    // Frozen ABI: the right answer.
  }

  // Replacing a method affects this machine only; a cart cannot reach another.
  try {
    var realCls = gfx.cls;
    gfx.cls = function () {};
    gfx.cls(0);
    gfx.cls = realCls;
  } catch (e) {
    // Frozen ABI: also the right answer.
  }
  sys.poke(REACH, 1);
}
