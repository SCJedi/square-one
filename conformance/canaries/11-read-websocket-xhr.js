// ATTEMPT: the network again, by its other names.
// WHY IT MUST FAIL: blocking `fetch` and leaving XMLHttpRequest is not a
// boundary, it is a checklist with a gap. A canary per spelling is the only way
// the list stays honest.
// CLOSED BY: Layer 1, and Layer 2 deletes each of them.

var FLAG = 0x7800;
var REACH = 0x7801;

function tick() {
  if (typeof XMLHttpRequest !== "undefined") sys.poke(FLAG, 1);
  if (typeof WebSocket !== "undefined") sys.poke(FLAG, 1);
  if (typeof EventSource !== "undefined") sys.poke(FLAG, 1);
  if (typeof Request !== "undefined") sys.poke(FLAG, 1);
  if (typeof Response !== "undefined") sys.poke(FLAG, 1);
  sys.poke(REACH, 1);
}
