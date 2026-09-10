// ATTEMPT: read a global through Reflect, which does not care about scope.
// WHY IT MUST FAIL: Reflect.get(globalThis, "fetch") needs no binding for
// `fetch` at all -- it needs a reference to the global object and a string. It
// is the reason `Reflect` is on the shadow list even though Reflect on its own
// is harmless: it is a re-acquisition tool.
// CLOSED BY: Layer 1 shadows both halves, so the expression cannot even be
// written. Layer 2 deletes Reflect outright.

var FLAG = 0x7800;
var REACH = 0x7801;

function tick() {
  if (typeof Reflect !== "undefined") sys.poke(FLAG, 1);
  // Throws: Reflect is undefined.
  var f = Reflect.get(globalThis, "fetch");
  if (f) sys.poke(FLAG, 1);
  sys.poke(REACH, 1);
}
