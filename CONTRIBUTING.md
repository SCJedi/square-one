# Contributing

Read this before your first change. Most of it is not style — it is a short list of the
specific ways this project can be broken silently, each of which has already happened once.

## Start here

```bash
npm install
npm test          # 1478 tests
npm run typecheck
```

`spec/square-one-console-spec-v1.html` says what the machine is. `spec/square-one-engineering-guide.html`
says how it is built. Both open directly in a browser. When code and specification disagree,
one of them is wrong and the disagreement is the bug — do not quietly implement the other.

## The rules that are not negotiable

### Never regenerate a golden to make a test pass

`conformance/cases/gradient-60` and `conformance/cases/reference-frames` are the frame-hash
chains that prove the machine is deterministic. If your change moves one of them, **your change
altered behaviour**. That may be correct and intended — but it is a decision to make on purpose
and explain in the commit message, never a file to regenerate on the way past.

```bash
npm run check:golden
npx vite-node packages/runtime/tools/gen-frames.ts -- --check
```

Both must pass before you open a pull request.

### Never weaken a canary

`conformance/canaries/` holds 33 real attempts to escape the sandbox. Six of them **succeed**
under parameter shadowing alone and are marked `known-hole`, with the suite asserting the hole
is still exactly where it was. That is not a bug in the tests; it is the record that the hole
exists and which layer closes it. Deleting or softening one removes the only evidence anyone
ever considered it.

If you close a hole, invert the assertion into a regression guard rather than deleting it. If
you find a new one, add a canary. **The suite only ever grows.**

### Test the consequence, not the code path

Twice, a security layer has silently done nothing while a green suite agreed it worked. Once
because `scrubRealm` named a global it had just deleted; once because `delete globalThis.fetch`
removes nothing on a web global, where WebIDL puts operations on the interface prototype.

Neither was findable by reading the code, and neither was visible in-process. So: do not assert
that hardening is *called*. Assert that a cart *cannot reach `Function`*. **A step that reports
success is not evidence it did anything** — have it return what it actually did, and assert on
that.

### A component that only runs in an environment your tests do not create is not tested

It has a stand-in that shares its name. Worker-only code needs a real worker. Browser-only code
needs a real browser, on **both** engines — the Firefox defect above was invisible on Node and
the Node one was invisible everywhere else.

```bash
npx playwright install chromium firefox
npx vitest run --config vitest.browser.config.ts
$env:SQ1_BROWSER = "firefox"; npx vitest run --config vitest.browser.config.ts
```

### Determinism is the product

Everything — replays, rewind, rollback netplay, the conformance chains, verifiable scores —
rests on one claim: **the whole machine is one 64 KB buffer.** Any state a cart can reach that
is not in that buffer silently falsifies it.

That is why the ABI objects are frozen. Not for security: a writable property on `sys` is
machine state outside RAM, so a rewind restores the framebuffer to frame N while leaving the
cart's smuggled value at frame N+300, and the divergence appears far from its cause.

Concretely, in cart and engine code: no `Math`, no `Date`, no wall clock. Use `sys.rnd`,
`sys.sin`, `sys.frame()`. Keep engine state in RAM, not in a closure.

### One implementation of anything that must agree

`fromFloat` is the only float-to-fixed conversion in the repository. It became the only one
after the stamper and an engine's own test used different rounding, disagreed by one ULP on
three knobs, and the engine suite passed the whole time — **because it was testing a cart the
stamper did not produce.**

Two implementations that happen to agree today is the drift this project keeps finding. If
something must agree, derive it rather than duplicating it.

### A manifest is a claim; verify claims against bytes

The stamper used to type-check manifest text against manifest text. A tileset declaring
`flags = ["solid","hazard"]` satisfied the requirement on the sentence alone, so a pack whose
flag bytes were all zero produced a stamped, proved game where nothing was solid and nothing was
fatal.

New checks belong on the bytes, not on the declaration.

## Working on a module

`modules/README.md` has the manifest format. Two things bite newcomers:

- **The `indexes` field is explicit, not inferred from a name.** `tile_floor` indexes a tileset;
  `sprite_offset_x` is a pixel offset that merely shares a prefix. Annotating the second one
  would bound an offset against a cell count — a check that refuses a correct manifest, which is
  worse than the absent check it replaced.
- **A generator commits its output.** `gen.mjs` must regenerate its `.bin` byte-identically.
  CI checks.

## Drawing and sound

`modules/FORMATS-breakout-art.md` documents what works at this size, and it is mostly what to
leave out. **No dithering below about 16 x 16** — there is no room for the pattern to read and
it becomes noise. Silhouette before detail. One light source, top-left.

Nobody involved can hear the sound bank, so `modules/redsound/README.md` carries a table of
measured numbers — duration, peak, pitch contour, and how far the alarm sits from its nearest
neighbour. If you change an effect, update the table. Someone with ears will eventually check
it, and the table is what they will check against.

## Pull requests

- Say what you changed and **why**, especially if a number moved.
- If a cart id changed, say so. Ids move when a module's bytes move, which is the hashing rule
  working — but an unexplained id change is indistinguishable from an accident.
- Run `npm test`, `npm run typecheck`, and both conformance checks.
- New behaviour gets a test that fails without it. Break your own change on purpose and confirm
  the suite goes red; a test that cannot detect the defect it was written for is worse than none,
  because it reads as coverage.
