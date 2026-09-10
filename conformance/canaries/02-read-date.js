// ATTEMPT: read Date, for a wall clock.
// WHY IT MUST FAIL: a cart that branches on the time of day plays differently
// on Tuesday. sys.frame() is the only clock the console has, and it lives in
// RAM so a rewind rewinds it too.
// CLOSED BY: Layer 1.

var FLAG = 0x7800;
var REACH = 0x7801;

function tick() {
  if (typeof Date !== "undefined") sys.poke(FLAG, 1);
  try {
    var t = Date.now();
    if (t > 0) sys.poke(FLAG, 1);
  } catch (e) {
    // Date is undefined; reading .now off it throws. That is the expected path.
  }
  sys.poke(REACH, 1);
}
