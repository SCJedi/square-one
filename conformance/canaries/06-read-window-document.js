// ATTEMPT: reach the page the player is on.
// WHY IT MUST FAIL: a cart runs in a worker and must never see the DOM. If it
// could, a game embedded in someone's site could read their page, their forms
// and their cookies.
// CLOSED BY: Layer 1. Note these names do not exist in a worker or in Node
// either -- shadowing them means the cart gets `undefined` rather than a
// ReferenceError, which is the same answer in every host.

var FLAG = 0x7800;
var REACH = 0x7801;

function tick() {
  if (typeof window !== "undefined") sys.poke(FLAG, 1);
  if (typeof document !== "undefined") sys.poke(FLAG, 1);
  if (typeof location !== "undefined") sys.poke(FLAG, 1);
  if (typeof navigator !== "undefined") sys.poke(FLAG, 1);
  sys.poke(REACH, 1);
}
