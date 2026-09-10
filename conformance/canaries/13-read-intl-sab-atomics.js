// ATTEMPT: locale, shared memory, and a timer built out of them.
// WHY IT MUST FAIL: Intl differs by machine and by ICU version -- a cart that
// formats a number gets different bytes in Berlin. SharedArrayBuffer plus
// Atomics is a high-resolution clock and a channel to any other thread that
// holds the same buffer.
// CLOSED BY: Layer 1.

var FLAG = 0x7800;
var REACH = 0x7801;

function tick() {
  if (typeof Intl !== "undefined") sys.poke(FLAG, 1);
  if (typeof SharedArrayBuffer !== "undefined") sys.poke(FLAG, 1);
  if (typeof Atomics !== "undefined") sys.poke(FLAG, 1);
  sys.poke(REACH, 1);
}
