# Square One

A 128x128 virtual console that runs in a browser, and the cart format that feeds it.

[![ci](https://github.com/SCJedi/square-one/actions/workflows/ci.yml/badge.svg)](https://github.com/SCJedi/square-one/actions/workflows/ci.yml)
MIT licensed. Contributions welcome — read [CONTRIBUTING.md](CONTRIBUTING.md) first; it is
short, and it is mostly a list of the specific ways this project can be broken silently.

One runtime, many carts. A game ships as a single `.cart` file that is deterministic,
content-addressed, signed, and structurally incapable of reaching the network.

## The two documents

Read these before changing anything. They are the contract.

| Document | What it settles |
|---|---|
| `spec/square-one-console-spec-v1.html` | **What the machine is.** Ordered by blast radius: the frozen core, the Universal Profile, the ABI, the cart container, profiles and downlevel, modules and recipes, the security model, conformance. Every number carries the reason it is that number. |
| `spec/square-one-engineering-guide.html` | **How it gets built.** Packages, thread topology, exact arithmetic, the sandbox bootstrap, test strategy, and seven milestones with binary acceptance criteria. |

Both open directly in a browser as local files.

## Layout

```
packages/
  core/          fixed point, PRNG, sine table, tokenizer.  Zero runtime deps.
  cart/          container encode/decode, cart id, png stego          (M2)
  runtime/       worker: cart host, rasterizer, synth, memory map     (M1, M3, M4)
  player/        main thread: shell, canvas, input, audio graph       (M4)
  stamper/       resolve, merge, bind, validate, compile, pack        (M5)
  cli/           sq1 build | run | validate | hash | prove            (M2)
modules/         engines, palettes, tilesets, soundbanks              (M5, M6)
conformance/     test carts, replays, hash chains, normative fixtures
spec/            the specification and the engineering guide
```

Dependency direction is one-way: `core` imports nothing, everything imports `core`, and
`stamper` never ships to a player.

## Running things

```bash
npm install
npm test            # the everyday suite
npm run typecheck
npm run gen:sin     # regenerate the normative sine table (must be byte-stable)
```

## Playing a cart

```bash
npm run sq1 -- build examples/hello
npx vite
# http://localhost:5173/examples/player/index.html
```

`createPlayer({ mount, cart })` runs the cart in a **real Worker with the realm scrubbed**, and
that is the default rather than an option. The in-process path still exists as
`unsafeInProcess: true`, named that way on purpose: it is Layer 1 only, the six escapes in
`conformance/canaries/README.md` are open on it, and it is for tests and authoring tools rather
than for loading a stranger's cart. If no `Worker` can be constructed the player **throws**
naming both opt-ins — silently falling back to the unhardened path would reintroduce exactly
the bug the default exists to prevent.

The difference is observable rather than architectural: the same probe cart reports finding
`Function`, `eval` and `fetch` in its realm under `unsafeInProcess`, and finds none of them on
the default. It reaches them through `(function(){}).constructor("return this")()` rather than
by name, because parameter shadowing makes `typeof fetch` read `undefined` on an unhardened
player too — testing the name would prove nothing.

## Recipes

A cart is a build artifact. The recipe is the source.

```bash
npm run sq1 -- stamp examples/cave-runner
#   id      7TB4CCKJ-JVJ6VNTP-H41H1ZFM-XRZ71B3A
#   size    33708 of 65536 bytes
#   tokens  4180 of 8192
#   proved  600 frames
```

`examples/cave-runner/recipe.toml` names an engine, three art packs and a `[tuning]` table.
Nothing in it is code. The stamper resolves the modules, layers them, binds the knobs,
type-checks the result against what each module declares it needs, compiles, packs and — only
then — **proves**: it runs the cart headless for 600 frames and records the frame-hash chain
before writing anything. A cart that has not been proved is never written.

The same recipe produces a byte-identical cart from any directory on any machine, which is what
makes the cart id a name for a cart rather than a name for one machine's copy of it.

When something is missing, the diagnostic is the product:

```
recipe.toml:28:1  error[unbound-knob]  engine platformer@1.0.0 requires knob `level_seed`,
                  which the [tuning] table does not set.
                  Add:  level_seed = 1073741824   # 0 .. 2147483647, The whole level is
                  a pure function of this number
```

See `modules/README.md` for the manifest format and how to add a module.

## The `sq1` command

```bash
npm run sq1 -- build examples/hello        # -> examples/hello.cart, prints id, size, tokens
npm run sq1 -- validate examples/hello.cart
npm run sq1 -- hash examples/hello.cart
npm run sq1 -- inspect examples/hello.cart # header, chunks, META, token count, id
```

`build` output is byte-identical regardless of the working directory it runs from — no
timestamps, no absolute paths, nothing environmental in the bytes. That is what makes the
cart id a meaningful name for a cart rather than a name for one machine's copy of it.

Tools run under `vite-node`, never bare `node`. Modules here import their neighbours without
file extensions, which Node's ESM loader will not resolve — and more importantly, `vite-node`
resolves modules exactly the way the runtime does, so a generator cannot mint an artifact the
runtime is unable to reproduce.

## Running things

The slow gate — one million random pairs of the fixed-point property test against a
BigInt reference, and 200,000 fuzz iterations against the cart decoder — runs with
`SQ1_SLOW=1` set in the environment. On Windows PowerShell:

```powershell
$env:SQ1_SLOW = "1"; npx vitest run
```

Browser conformance — the gate that proves the machine behaves identically under V8 and
SpiderMonkey. `@vitest/browser` and `playwright` are devDependencies; only the browser
binaries are fetched on demand:

```bash
npx playwright install chromium firefox
npx vitest run --config vitest.browser.config.ts                    # chromium
$env:SQ1_BROWSER = "firefox"; npx vitest run --config vitest.browser.config.ts
```

`@vitest/browser` must stay pinned to the same major as `vitest`. Installing it unpinned
resolves to the next major, and npm reports the peer conflict as
`Cannot read properties of null (reading 'explain')` — which names nothing useful.

## Milestone status

| | Milestone | State |
|---|---|---|
| **M0** | Core primitives — fixed point, PRNG, sine table, tokenizer | **complete** — 111 tests green, acceptance criteria met |
| **M1** | Runtime skeleton and the frame-hash golden master | **complete** — chain identical on Node, Chromium and Firefox |
| **M2** | Container and CLI | **complete** — round-trip stable, 200k-iteration fuzz, `sq1` builds reproducibly |
| **M3** | Real carts, scrubbed realm | **complete** — 33 canaries, all holes closed in real Node *and* browser workers, recovery in 44–75 ms |
| **M4** | Full rasterizer, audio, shell | **complete** — 10 reference PNGs pinned, hardened Worker by default, plays in Chromium and Firefox |
| **M5** | Stamper and the first engine | **complete** — recipe to proved cart, byte-identical from any directory |
| **M6** | The second engine | **complete** — a different genre shipped with no contract change |

Each milestone has a binary acceptance test in the engineering guide. "Looks right" is
not one of them.

## What the module system is, and what it is not

Three recipes ship: `cave-runner` and `deep-run` are the **same engine** with different art and
different tuning, and `moss-keep` is a different genre entirely. Between the first two, the
compiled code differs in **one line out of 635** — the knob preamble — and both carts record the
same `platformer@1.0.0` content hash. Art and code are separable, and that is measured in bytes
rather than claimed.

`topdown` was built against the module interface exactly as it stood, and needed **no change to
it**. But the interface has a shape worth knowing before you write a module:

> It can say that two modules *agree*. It cannot carry a *value* from one to the other.

A flag's name crosses the handshake; the bit it uses does not. A cell count crosses; which cell
is the door does not. Every one of those gaps is filled by a knob a person copies out of the
other module's manifest — which is why the platformer needs nineteen required knobs mostly to
name sprite cells. `modules/topdown/INTERFACE-NOTES.md` is the full log, written while building
against the contract rather than reasoning about it afterwards.

The stamper now verifies those hand-copied numbers rather than trusting them: a declared flag
must appear in the flag bytes a pack ships, a `<x>_flag` knob must match the bit the pack marks,
and an `indexes`-annotated knob must name a cell its pack actually draws. Before that, a
`tile_door = 200` on a 64-tile tileset stamped and proved a 600-frame chain, and a
`sprite_walk = 3` made the player character a tuft of grass.

## Two rules that are not negotiable

**Generated files are generated.** `packages/core/src/sin-table.ts` and
`conformance/fixtures/sin1024.bin` come from `packages/core/tools/gen-sin.ts`. Regenerating
them must produce byte-identical output on any machine and any engine — which is why the
generator computes sine in exact BigInt arithmetic and never calls `Math.sin`. CI fails if
regeneration changes a byte.

**Determinism is tested, not hoped for.** The fixed-point property suite checks against an
independent BigInt reference. From M1 onward, every conformance case carries a chain of
per-frame framebuffer hashes that must match on Node, Chrome and Firefox alike. Determinism
drift is silent and cumulative, and it is diagnosed by bisecting hash chains — which only
works if the chains predate the drift.

**The sandbox is proved where it runs, not where it is convenient.** `conformance/canaries/`
holds 33 real escape attempts, and the suite only ever grows — a canary is never deleted and
never weakened to make it pass. Six of them get out under parameter shadowing alone, which is
recorded rather than hidden: **Layer 1 is not a security boundary.** They are closed by
`scrubRealm`, and that claim is checked in a real `node:worker_threads` worker *and* in a real
browser `Worker` on Chromium and Firefox, each running the real scrub on its real global.

That is not belt-and-braces. Layer 2 has twice been caught doing nothing at all while a green
suite said otherwise — once because the scrub named a global it had just deleted, once because
`delete globalThis.fetch` removes nothing on a web global, where WebIDL puts operations on the
interface prototype rather than the global. Neither was visible in-process, and neither was
visible from the other realm. **A component that can only run in an environment your tests do
not create is not being tested.** See `conformance/canaries/README.md` for the three-realm
report.

## Known normative limitations

**The token counter's regex-versus-division rule is knowingly imperfect, and that is the
design.** Deciding whether `/` starts a regex literal or is a division operator cannot be
done correctly without a parser. `tokenize.ts` uses a one-token-lookback heuristic, which is
wrong in three enumerated cases — after `)`, after `}`, and for identifiers named `of`, `in`,
`yield` or `await` followed by division. Each is documented as limitation L1 in the file header
and pinned by `conformance/tokens/024-regex-division-limits.js`, recording both the count this
tokenizer produces and the count a real parser would.

These cases are now part of the normative definition. The failure mode is a slightly wrong
token *count*, never a wrong program — the engine still parses the cart correctly. The trade is
deliberate: a rule that never looks past one previous token is one a second implementation can
reproduce exactly on the first attempt, which is the entire point of having a normative counter.

## Deviations from the engineering guide

- **npm workspaces, not pnpm.** pnpm is not installed on the development machine and npm
  workspaces are equivalent for this repository's needs. Nothing depends on the choice.
- **`cross-env` is a devDependency.** The `test:slow` script sets an environment variable
  inline, which does not work in PowerShell. CI sets it properly; `cross-env` makes the script
  work on every developer machine.
