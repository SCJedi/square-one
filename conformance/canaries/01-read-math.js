// ATTEMPT: read the Math namespace.
// WHY IT MUST FAIL: Math.random is entropy the machine cannot replay, and
// Math.sin is not specified to the last bit -- two engines disagree, and every
// replay recorded on one is wrong on the other. sys.rnd, sys.sin and sys.cos
// are the console's answers and they come out of RAM and a committed table.
// CLOSED BY: Layer 1 (Math is a shadowing parameter, bound to undefined).

var FLAG = 0x7800;
var REACH = 0x7801;

function tick() {
  if (typeof Math !== "undefined") sys.poke(FLAG, 1);
  if (typeof Math === "object" && Math !== null && typeof Math.random === "function") {
    sys.poke(FLAG, 1);
  }
  sys.poke(REACH, 1);
}
