// Minimal `process` shim for browser test runs.
//
// Several suites read `process.env.SQ1_SLOW` at module scope to size their
// property runs. That is a Node-ism in the *test harness*, not in the code under
// test, so shimming it here is honest: nothing about the machine's behaviour
// changes, and the suites stay a single source that runs in both environments.
//
// `versions` is deliberately left empty. Every Node-detection guard in the suite
// checks `process.versions?.node`, so those keep resolving to "not Node" and the
// filesystem-backed oracles stay correctly skipped. A shim that made the suite
// *think* it was in Node would be far worse than no shim at all.
//
// __SQ1_SLOW__ is injected by vitest.browser.config.ts at build time, so the
// flag can still be forwarded from the shell into a browser run.
declare const __SQ1_SLOW__: string;

if (typeof (globalThis as { process?: unknown }).process === "undefined") {
  (globalThis as { process?: unknown }).process = {
    env: { SQ1_SLOW: typeof __SQ1_SLOW__ === "string" ? __SQ1_SLOW__ : "" },
    versions: {},
  };
}

export {};
