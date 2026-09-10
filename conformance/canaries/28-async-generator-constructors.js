// ATTEMPT: the three code constructors that are NOT Function.
//   Object.getPrototypeOf(async function(){}).constructor      AsyncFunction
//   Object.getPrototypeOf(function*(){}).constructor           GeneratorFunction
//   Object.getPrototypeOf(async function*(){}).constructor     AsyncGeneratorFunction
//
// WHY THEY ARE A SEPARATE CANARY: they are three more compilers, each reachable
// without naming anything, and each living on its own prototype object. A
// sandbox that neuters only Function.prototype.constructor has closed one door
// of four and will report itself secure.
//
// WHAT IS ASSERTED: that a compiler was OBTAINED. A generator's body does not
// run until the generator is iterated and an async function returns a promise
// rather than a value, so dereferencing the result would prove less, not more.
// Holding the compiler is the escape.
//
// CLOSED BY: Layer 2, which neuters all four.
// EXPECTED: known-hole.

var FLAG = 0x7800;
var REACH = 0x7801;

function tick() {
  var makers = [
    function () { return Object.getPrototypeOf(async function () {}).constructor; },
    function () { return Object.getPrototypeOf(function* () {}).constructor; },
    function () { return Object.getPrototypeOf(async function* () {}).constructor; }
  ];
  for (var i = 0; i < makers.length; i++) {
    try {
      var C = makers[i]();
      var f = new C("return 1");
      if (typeof f === "function") sys.poke(FLAG, 1);
    } catch (e) {
      // Denied.
    }
  }
  sys.poke(REACH, 1);
}
