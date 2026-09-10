// ATTEMPT: get the global object out of `this`.
// WHY IT MUST FAIL: in sloppy mode, `this` inside a plain function call is the
// global object, and `this` at the top of a script is the global object too.
// That is the oldest escape in JavaScript and it needs no names at all.
// CLOSED BY: Layer 1 -- the cart body is a strict function, so top-level `this`
// is undefined and a plain call gets undefined rather than a boxed global.

var FLAG = 0x7800;
var REACH = 0x7801;
var TOP_THIS = this;

function tick() {
  if (TOP_THIS !== undefined) sys.poke(FLAG, 1);
  if (this !== undefined) sys.poke(FLAG, 1);

  var plain = function () {
    return this;
  };
  if (plain() !== undefined) sys.poke(FLAG, 1);

  // The same trick through a method that has been detached from its object.
  var detached = tick;
  if (typeof detached === "function" && detached.call === undefined) sys.poke(FLAG, 1);

  sys.poke(REACH, 1);
}
