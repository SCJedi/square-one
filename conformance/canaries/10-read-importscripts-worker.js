// ATTEMPT: load more code, or start another thread.
// WHY IT MUST FAIL: importScripts pulls arbitrary source into THIS realm, after
// the realm has been hardened -- it is the one call that undoes a scrub from the
// inside. Worker starts a fresh, unscrubbed realm and hands the cart a channel
// to it.
// CLOSED BY: Layer 1, and Layer 2 deletes both.

var FLAG = 0x7800;
var REACH = 0x7801;

function tick() {
  if (typeof importScripts !== "undefined") sys.poke(FLAG, 1);
  if (typeof Worker !== "undefined") sys.poke(FLAG, 1);
  if (typeof SharedWorker !== "undefined") sys.poke(FLAG, 1);
  if (typeof BroadcastChannel !== "undefined") sys.poke(FLAG, 1);
  if (typeof WebAssembly !== "undefined") sys.poke(FLAG, 1);
  sys.poke(REACH, 1);
}
