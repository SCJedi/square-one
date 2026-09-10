import { defineConfig } from "vitest/config";

// Browser conformance. The same source, in real engines.
//
// This is the M1 acceptance gate: a 60-frame run of the gradient cart must
// produce an identical SHA-256 frame-hash chain on Node, Chrome and Firefox.
// Running the suite under both V8 and SpiderMonkey is a real test rather than a
// formality, because engine math libraries differ in the last unit in the last
// place, and that is exactly the divergence that would desync a replay in the
// field without anyone noticing for months.
//
//   npx playwright install chromium firefox
//   npx vitest run --config vitest.browser.config.ts                  # chromium
//   SQ1_BROWSER=firefox npx vitest run --config vitest.browser.config.ts
//
// WHY THE INCLUDE LIST IS EXPLICIT
// --------------------------------
// Two suites legitimately need a filesystem and are Node-only by nature:
//   sin.test.ts       regenerates the table through the generator and diffs bytes
//   tokenize.test.ts  enumerates the fixture directory
// Neither tests engine-dependent behaviour - the sine table is a committed blob
// and the tokenizer is pure string work - so excluding them costs no coverage of
// the property this job exists to check. Everything whose result could plausibly
// differ between engines runs here.
export default defineConfig({
  define: {
    // Forward the slow-run flag into the browser bundle. See tools/browser-setup.ts.
    __SQ1_SLOW__: JSON.stringify(process.env["SQ1_SLOW"] ?? ""),
  },
  test: {
    setupFiles: ["./tools/browser-setup.ts"],
    include: [
      "packages/runtime/test/golden.test.ts", // the acceptance criterion
      "packages/runtime/test/machine.test.ts",
      "packages/runtime/test/raster.test.ts",
      "packages/runtime/test/memory.test.ts",
      "packages/runtime/test/hash.test.ts",
      "packages/runtime/test/host.test.ts",
      "packages/core/test/fixed.test.ts",
      "packages/core/test/prng.test.ts",
      "packages/core/test/sha256.test.ts",
      // The container ships to players, so a cart must decode to the same bytes
      // and hash to the same id under both engines. The decoder is also the one
      // place hostile input meets parsing code, and "never throws" has to hold
      // in the engine the player is actually running.
      "packages/cart/test/codec.test.ts",
      "packages/cart/test/id.test.ts",
      "packages/cart/test/meta.test.ts",
      "packages/cart/test/fuzz.test.ts",
      // The watchdog runs on the player's main thread, so its deadline logic
      // has to behave the same under both engines. Its real-Worker proof is
      // Node-only and skips itself here.
      "packages/runtime/test/watchdog.test.ts",
      // The gate is a build-time tool, but it lives in a package that ships,
      // and an author may well run it in a browser-based editor.
      "packages/cart/test/lint.test.ts",
      // The sandbox is the whole reason a browser can be trusted to run a
      // stranger's cart, so it and the escape attempts belong here more than
      // anything else in this list. Engines differ in exactly the places that
      // matter: SyntaxError shape, the code-constructor paths, and which
      // intrinsics can be redefined.
      "packages/runtime/test/sandbox.test.ts",
      "packages/runtime/test/canaries.test.ts",
      // Layer 2 in the engine that ships. scrub-realm.test.ts proves the same
      // claim on a `node:worker_threads` global, and Node is not the deployment
      // target: a browser realm differs in which globals exist, which of them
      // are configurable, and whether `Error.stackTraceLimit` exists at all.
      // This one spawns a real browser Worker, runs the real scrubRealm on its
      // real global, and reruns all six known holes inside it. It skips itself
      // in Node, so the Node config picking it up costs nothing.
      "packages/runtime/test/scrub-realm.browser.test.ts",
      // The seam where a cart FILE becomes a running program. It is the surface
      // a stranger's bytes reach first, and decoding plus compiling is exactly
      // the pair whose behaviour differs between engines.
      "packages/runtime/test/load.test.ts",
      // The font is pure bit-twiddling over a committed glyph table, so it is
      // engine-independent by construction -- which is exactly why running it
      // in both engines is cheap and why there is no reason not to.
      "packages/runtime/test/font.test.ts",
      // The synth is a pure function of registers and state. It has to produce
      // identical samples everywhere or a recorded cart would sound different
      // per browser, which is not what "non-normative" was meant to license.
      "packages/runtime/test/audio.test.ts",
      // The player's default path. `Worker` is a browser construct, so this is
      // the only place the claim "a stranger's cart runs hardened by default"
      // can actually be observed rather than inferred from a code path.
      "packages/player/test/player.test.ts",
    ],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    browser: {
      enabled: true,
      provider: "playwright",
      headless: true,
      name: process.env["SQ1_BROWSER"] ?? "chromium",
      screenshotFailures: false,
    },
  },
});
