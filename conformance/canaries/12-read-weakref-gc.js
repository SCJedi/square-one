// ATTEMPT: observe the garbage collector.
// WHY IT MUST FAIL: WeakRef and FinalizationRegistry turn the host's memory
// pressure into a value a cart can branch on. It is entropy with a respectable
// name, and it differs between engines, machines and runs.
// CLOSED BY: Layer 1.

var FLAG = 0x7800;
var REACH = 0x7801;

function tick() {
  if (typeof WeakRef !== "undefined") sys.poke(FLAG, 1);
  if (typeof FinalizationRegistry !== "undefined") sys.poke(FLAG, 1);
  sys.poke(REACH, 1);
}
