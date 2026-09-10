// ATTEMPT: read and write outside the 64 KB.
// WHY IT MUST BE HARMLESS RATHER THAN FATAL: peek and poke take a number a cart
// computed, and cart arithmetic has bugs. machine.ts defines out-of-range peek
// as 0 and out-of-range poke as a no-op, deliberately: a cart with an off-by-one
// must draw a wrong picture, not kill the player's machine. What must never
// happen is a read that returns something from outside RAM.
// EXPECTED: harmless. NOTE is set if any out-of-range read returned non-zero,
// which would mean peek is reaching past the buffer.

var FLAG = 0x7800;
var REACH = 0x7801;
var NOTE = 0x7802;

function tick() {
  var probes = [-1, -65536, 65536, 65537, 1e9, -1e9, 0.5 + 65536];
  for (var i = 0; i < probes.length; i++) {
    if (sys.peek(probes[i]) !== 0) sys.poke(NOTE, 1);
    sys.poke(probes[i], 0xff);
  }
  // The framebuffer must be untouched by any of that.
  if (sys.peek(0) !== 0) sys.poke(NOTE, 1);
  sys.poke(REACH, 1);
}
