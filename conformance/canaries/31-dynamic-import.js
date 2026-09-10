// ATTEMPT: import a module from cart source.
// WHY IT MUST FAIL AT COMPILE TIME: `import()` is syntax, not a name. It does
// not consult the scope chain, so no parameter can shadow it, and inside a
// Function-constructed body it RESOLVES -- it hands a cart the filesystem under
// Node and a network fetch in a browser. The only portable answer is to refuse
// the source, which sandbox.ts does at token level with the console's own
// normative tokenizer, so the word in a comment or a string is not mistaken for
// the keyword.
// EXPECTED: compile-error. This cart never runs, so it has no flags to set.

function tick() {
  import("node:fs").then(function (fs) {
    sys.poke(0x7800, 1);
    return fs;
  });
}
