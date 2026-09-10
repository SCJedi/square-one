// ATTEMPT: read the host's stack trace out of an Error.
// WHAT IT ACTUALLY GETS: on V8, `new Error().stack` read from cart code is a
// string containing the frames BELOW the cart -- the runtime's own functions and,
// in a development build, absolute file paths. That is an information leak, not
// a capability: a cart cannot phone home, but it can draw what it read on the
// screen, or write it into the SAVE region, which the host persists.
// EXPECTED: harmless -- no live reference is obtained, so FLAG stays 0. NOTE
// records whether a stack was readable at all.
// CLOSED BY: Layer 2 sets Error.stackTraceLimit = 0, after which the string
// carries no frames. Nothing at Layer 1 can close it: Error is the language.

var FLAG = 0x7800;
var REACH = 0x7801;
var NOTE = 0x7802;

function tick() {
  var s = "";
  try {
    s = new Error("probe").stack || "";
  } catch (e) {
    s = "";
  }
  if (typeof s === "string" && s.length > 0) sys.poke(NOTE, 1);
  // A stack is a string. If any of this ever yields an object with properties
  // to walk, that is a different finding entirely.
  if (typeof s === "object" && s !== null) sys.poke(FLAG, 1);
  sys.poke(REACH, 1);
}
