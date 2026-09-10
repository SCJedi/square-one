// ATTEMPT: find entropy and a high-resolution clock.
// WHY IT MUST FAIL: crypto.getRandomValues is unreproducible by construction,
// and performance.now() is both a non-deterministic input and the timer half of
// every timing side channel.
// CLOSED BY: Layer 1. Layer 2 deletes crypto but KEEPS performance, because
// worker.ts:48 reads it once per frame for the tookMs diagnostic -- which never
// reaches the machine.

var FLAG = 0x7800;
var REACH = 0x7801;

function tick() {
  if (typeof crypto !== "undefined") sys.poke(FLAG, 1);
  if (typeof performance !== "undefined") sys.poke(FLAG, 1);
  sys.poke(REACH, 1);
}
