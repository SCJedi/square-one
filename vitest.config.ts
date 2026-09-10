import { defineConfig } from "vitest/config";

// M0 runs in Node. Browser conformance (Chrome + Firefox) is wired in CI via
// .github/workflows/ci.yml and becomes an acceptance gate at M1, where the
// frame-hash chain has to agree across engines.
export default defineConfig({
  test: {
    include: [
      "packages/*/test/**/*.test.ts",
      // Modules ship their own tests. An engine is cart source rather than part
      // of the TypeScript build, so its suite is the only thing standing between
      // "the engine compiles" and "the engine plays" -- and a suite the runner
      // never collects is worse than no suite, because it reads as coverage.
      "modules/*/test/**/*.test.ts",
    ],
    // The 1e6-pair fixed-point property test is deliberately slow.
    testTimeout: 120_000,
    hookTimeout: 120_000,
    reporters: ["default"],
  },
});
