// ATTEMPT: persistent storage and host I/O.
// WHY IT MUST FAIL: localStorage and indexedDB outlive the machine and are
// shared with whatever else the origin runs, so they are both a channel and a
// place to hide state a replay cannot restore. console is a side channel into
// the host's logs and a way to make a browser unusable. The console's only
// persistent region is SAVE, at 0xFF00, which the host owns and can inspect.
// CLOSED BY: Layer 1.

var FLAG = 0x7800;
var REACH = 0x7801;

function tick() {
  if (typeof localStorage !== "undefined") sys.poke(FLAG, 1);
  if (typeof sessionStorage !== "undefined") sys.poke(FLAG, 1);
  if (typeof indexedDB !== "undefined") sys.poke(FLAG, 1);
  if (typeof caches !== "undefined") sys.poke(FLAG, 1);
  if (typeof console !== "undefined") sys.poke(FLAG, 1);
  if (typeof structuredClone !== "undefined") sys.poke(FLAG, 1);
  sys.poke(REACH, 1);
}
