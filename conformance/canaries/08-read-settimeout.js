// ATTEMPT: schedule work off the tick, with setTimeout and friends.
// WHY IT MUST FAIL: a callback that runs between ticks writes to RAM at a
// moment no replay can reproduce, and the frame-hash chain would diverge for
// reasons no bisect could find. A cart gets exactly one entry point per frame.
// CLOSED BY: Layer 1.

var FLAG = 0x7800;
var REACH = 0x7801;

function tick() {
  if (typeof setTimeout !== "undefined") sys.poke(FLAG, 1);
  if (typeof setInterval !== "undefined") sys.poke(FLAG, 1);
  if (typeof queueMicrotask !== "undefined") sys.poke(FLAG, 1);
  if (typeof requestAnimationFrame !== "undefined") sys.poke(FLAG, 1);
  if (typeof Promise !== "undefined") sys.poke(FLAG, 1);
  sys.poke(REACH, 1);
}
