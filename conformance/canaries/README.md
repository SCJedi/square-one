# Canaries

Carts that try to get out.

Each file in this directory is a small, real escape attempt against the sandbox
in `packages/runtime/src/sandbox.ts`. `packages/runtime/test/canaries.test.ts`
compiles every one of them with `compileCart`, runs it on a real machine through
`createMachine`, and reads the outcome out of RAM.

## This suite only ever grows

A canary is never deleted and never weakened to make it pass. If an escape
genuinely works, that is the finding: the manifest records it as a `known-hole`
with the reason and the layer that closes it, and the harness asserts that the
hole is still exactly where it was. Removing a canary removes the only evidence
that the hole was ever considered.

**Every browser engine update is a reason to run this suite.** The escapes here
are not bugs in a library that gets patched; they are properties of a JavaScript
realm, and a new engine version ships new intrinsics, new prototypes and new
spellings of the same reachability. A canary that passed in Chrome 140 proves
nothing about Chrome 141. Run it on Node, Chromium and Firefox, and run it again
when any of the three moves:

```
npx vitest run packages/runtime/test/canaries.test.ts packages/runtime/test/scrub-realm.test.ts
npx playwright install chromium firefox
SQ1_BROWSER=chromium npx vitest run --config vitest.browser.config.ts
SQ1_BROWSER=firefox  npx vitest run --config vitest.browser.config.ts
```

The browser run is the one that decides. Everything a cart is protected from at
Layer 2 is a property of the realm the browser gives the worker, and that realm
is not the one Node gives it.

## How a canary reports

A cart has no output but the framebuffer and RAM. So a canary writes what it
managed to do into three bytes at the bottom of USER RAM, and the harness reads
them:

| address | name | meaning |
|---|---|---|
| `0x7800` | `FLAG` | the cart believes it obtained a live reference to something outside the machine. **Must be 0**, except where the manifest says `known-hole` or `control`. |
| `0x7801` | `REACH` | the attempt ran to completion without throwing. |
| `0x7802` | `NOTE` | a canary-specific observation. Never a pass or a fail on its own — it is there so a finding has somewhere to go. |

The assertion is about the OUTCOME, not about a thrown message. "It threw" is not
evidence that an escape was denied — a typo throws too, and a canary that fails
because of a typo looks exactly like a canary that passed. That is what
`32-control-live-global.js` is for: it is handed a live global through a doctored
ABI, and the harness asserts that it is caught. If the control ever comes back
clean, no other result in this directory means anything.

## The manifest

`manifest.json` maps each filename to `{ attempt, expect }`, plus an optional
`note` and `closedBy`. The harness fails if a `.js` file has no manifest entry or
a manifest entry has no `.js` file, so neither can be added quietly.

| `expect` | what the harness asserts |
|---|---|
| `undefined` | ran to completion, obtained nothing: `FLAG` 0, `REACH` 1, no throw. |
| `throws` | the attempt threw while being made, and `FLAG` is 0. |
| `harmless` | ran to completion and obtained nothing, but the attempt is not simply "the name was undefined" — it did something, and what it did was defined behaviour. |
| `known-hole` | **the escape works.** `FLAG` is 1, and `closedBy` names the layer that closes it. These double as controls: if one stops setting `FLAG` while its layer has not been applied, the harness has stopped detecting escapes. |
| `compile-error` | `compileCart` refuses the source; the cart never runs. |
| `control` | not an escape attempt — the harness's own self-test. |

## What the canaries currently establish

**Layer 1 alone is not a security boundary.** Parameter shadowing hides names,
and six canaries here get out without using a name:
`(function(){}).constructor` and its four other spellings, the three non-Function
code constructors, the prototype walk that starts from `gfx.cls`, dynamic import
through a constructed function, and intrinsic mutation. All six are closed by
`scrubRealm`, which is worker-only. Three tests establish that, and they are not
the same claim:

- `packages/runtime/test/canaries.test.ts` neuters the code constructors in the
  test runner's own realm, reruns five of the six, and restores the realm in a
  `finally`. It proves the neutering.
- `packages/runtime/test/scrub-realm.test.ts` spawns a real
  `node:worker_threads` Worker, runs the real `scrubRealm()` on its real global
  object, and reruns all six inside it. It proves **Layer 2 on Node**, which is a
  different thing: the delete pass, the freeze pass, and the order of the three
  passes only exist on a real global.
- `packages/runtime/test/scrub-realm.browser.test.ts` does the same in a real
  browser `Worker`, in Chromium and in Firefox. It proves **Layer 2 where carts
  actually run**, which is a third thing again — and it is not a formality. Each
  of the three tests above found a defect the one before it could not see.

### Layer 2, measured on a real worker global

Read the report, not the summary. Observed on Node 24.13.1, `node:worker_threads`:

```
deleted   40  crypto, Intl, WeakRef, FinalizationRegistry, Atomics,
              SharedArrayBuffer, setTimeout, setInterval, clearTimeout,
              clearInterval, setImmediate, queueMicrotask, fetch, WebSocket,
              Request, Response, Headers, navigator, BroadcastChannel,
              MessageChannel, MessagePort, WebAssembly, Blob, File, URL, eval,
              Function, Reflect, Proxy, process, require, module, exports,
              global, Buffer, __dirname, __filename, structuredClone, atob, btoa
failed     []
frozen     68
neutered   Function.prototype.constructor,
           AsyncFunction.prototype.constructor,
           GeneratorFunction.prototype.constructor,
           AsyncGeneratorFunction.prototype.constructor,
           Error.stackTraceLimit
```

`failed` is empty: all 40 of the 67 scrubbable names that this realm actually
had were configurable and went. (`SHADOWED_NAMES` is 75 long; `REALM_KEEP` holds
8 of them back, leaving 67 in `SCRUBBED_NAMES`.) The remaining names — `Math`, `Date`,
`performance`, `window`, `document`, `location`, `parent`, `top`, `frames`,
`localStorage`, `sessionStorage`, `indexedDB`, `caches`, `FileReader`,
`Notification`, `EventSource`, `XMLHttpRequest`, `Worker`, `SharedWorker`,
`importScripts`, `postMessage`, `self`, `globalThis`, `console`, `Promise`,
`alert`, `confirm`, `prompt`, `close`, `addEventListener`, `removeEventListener`,
`dispatchEvent`, `requestAnimationFrame`, `cancelAnimationFrame`,
`requestIdleCallback` — are either in `REALM_KEEP` or simply not present on a
Node worker global. An absence is not a victory, so the report does not count it
as one.

All six known holes come back `FLAG` 0, `REACH` 1 after that scrub, and
`30-intrinsic-mutation.js` reports `NOTE` 1 — it found `Array.prototype` frozen.
The same cart, run for 12 frames inside the scrubbed worker and in an unscrubbed
in-process realm, produces an identical per-frame hash list, an identical chain,
and an identical checksum over `present()`. **Hardening the realm does not move
a single pixel.**

**The defect this found, which every in-process test was blind to.** Before
2026-09-08, `scrubRealm()` did not do any of the above on a real global: it
**threw**, with `ReferenceError: Function is not defined`, and Layer 2 did
nothing at all. The delete pass removes the global `Function` binding, and
`neuterCodeConstructors` then named `Function` while building its target list —
outside every `try`/`catch` — so the scrub died before neutering or freezing
anything. Nothing in-process could see it, because a test runner's realm still
has `Function`. The fix is one identifier: the target list now uses
`CapturedFunction`, the module-load reference the rest of the file already
relies on. The lesson generalises, and it is worth checking against any future
edit to `scrubRealm`: **after the delete pass, no code in that function may name
a scrubbed global by identifier.**

### Layer 2, measured on a real BROWSER worker global

A browser is the deployment target and a Node worker is not, so the same report
is taken again in a real `Worker`, in both engines, by
`packages/runtime/test/scrub-realm.browser.test.ts`. The worker is a Blob module
that imports the real `src/` modules through the Vite dev server, so the bytes
running in it are the bytes in `src/`.

Observed on HeadlessChrome 153.0.8010.12 and Firefox 155.0, Windows:

```
deleted   45  crypto, Intl, WeakRef, FinalizationRegistry, Atomics, setTimeout,
              setInterval, clearTimeout, clearInterval, queueMicrotask,
              requestAnimationFrame, cancelAnimationFrame, fetch,
              XMLHttpRequest, WebSocket, EventSource, Request, Response,
              Headers, navigator, importScripts, Worker, BroadcastChannel,
              MessageChannel, MessagePort, WebAssembly, indexedDB, caches,
              Blob, File, FileReader, URL, Notification, location, eval,
              Function, Reflect, Proxy, structuredClone, atob, btoa, close,
              addEventListener, removeEventListener, dispatchEvent
failed     []
frozen     68
neutered   Function.prototype.constructor,
           AsyncFunction.prototype.constructor,
           GeneratorFunction.prototype.constructor,
           AsyncGeneratorFunction.prototype.constructor,
           Error.stackTraceLimit
```

**Chromium and Firefox agree on every field, byte for byte.** All six known holes
come back `FLAG` 0, `REACH` 1 in both, and `30-intrinsic-mutation.js` reports
`NOTE` 1 — it found `Array.prototype` frozen. The smoke cart run for 12 frames
inside each scrubbed browser worker produces the same per-frame hash list, the
same chain and the same `present()` checksum as the same cart in an unscrubbed
in-process realm. **Hardening the realm does not move a single pixel, in either
engine.**

### The three realms, side by side

| | Node 24 worker | Chromium 153 worker | Firefox 155 worker |
|---|---|---|---|
| `SCRUBBED_NAMES` present | 40 of 67 | 45 of 67 | 45 of 67 |
| `deleted` | 40 | 45 | 45 |
| `failed` | `[]` | `[]` | `[]` |
| inherited, not own | 0 | 18 | 18 |
| `frozen` | 68 | 68 | 68 |
| `neutered` | 5 | 5 | 5 |
| `Error.stackTraceLimit` | present | present | **present** |
| `REALM_KEEP` names in this realm | 6 of 8 | 8 of 8 | 8 of 8 |

The realms differ in *which* names they have, not in how the scrub treats them.
Node has `process`, `require`, `module`, `exports`, `global`, `Buffer`,
`__dirname`, `__filename`, `SharedArrayBuffer` and `setImmediate`; a browser
worker has `navigator`, `location`, `importScripts`, `indexedDB`, `caches`,
`XMLHttpRequest`, `EventSource`, `FileReader`, `Notification`, `close`,
`requestAnimationFrame`, `addEventListener`, `removeEventListener` and
`dispatchEvent`. Neither has `window`, `document`, `localStorage`,
`sessionStorage`, `alert`, `SharedWorker` or `requestIdleCallback`.

Two smaller engine facts worth having written down: `SharedArrayBuffer` is
**absent** from a browser worker that is not cross-origin isolated, so the
delete pass never sees it and its absence is not a victory — a cart shipped
behind COOP/COEP headers would have it, and that is a realm this suite has not
measured. And `Error.stackTraceLimit`, historically a V8-only knob, **now exists
in SpiderMonkey too** (Firefox 155), so the stack-trace neutering that was
written for Chrome applies in Firefox as well. The browser test asserts that
conditionally rather than pinning a five-name list that could only be right on
one engine.

**THE DEFECT THIS FOUND, WHICH EVERY NODE TEST WAS BLIND TO.** Before this run,
`scrubRealm`'s delete pass **removed nothing at all** for 18 of the 45 names a
browser worker carries — among them `fetch`, `importScripts` (this realm's own
code loader), `indexedDB`, `caches`, `crypto`, `navigator`, `location`,
`structuredClone`, `atob`, `btoa`, the four timer functions, `queueMicrotask`
and the three `EventTarget` methods. The first browser report read
`deleted 27, failed 18`.

The cause is a structural difference between the two kinds of global, and it is
worth knowing for any future edit:

> On a Node worker global, every one of these names is an **own property** of the
> global object, so `delete globalThis[key]` removes it. On a **web** global it is
> not. WebIDL puts an interface's *operations and attributes* on the interface
> **prototype** — `DedicatedWorkerGlobalScope.prototype`,
> `WorkerGlobalScope.prototype`, `EventTarget.prototype` — and only *interface
> objects* (`Worker`, `Blob`, `WebSocket`, `Request`, …) as own properties of the
> global itself. `delete globalThis.fetch` therefore deletes nothing, returns
> `true`, and leaves `fetch` one prototype hop away.

The fix is `deleteThroughPrototypeChain` in `sandbox.ts`: the delete pass now
walks the prototype chain, stopping at `Object.prototype`, and removes the own
property wherever it actually lives. On Node the walk finds everything on the
first object and the report is unchanged. In both browsers `failed` is now empty
and `deleted` is 45.

This is the **second** time Layer 2 has been found doing nothing while a green
suite said otherwise (the first is below). Both had the same shape, and it is
the shape to watch for: *Layer 2 is a claim about a realm, and a realm can only
be tested by hardening a real one — on every engine that runs a cart.* An
in-process test, and a single-platform test, are both structurally incapable of
seeing this class of failure.

`scrub-realm.browser.test.ts` pins it: the worker reports which scrubbable names
are reachable but not own properties, and the test asserts every one of them
ends up in `deleted`. If the chain walk is ever removed, that test names the
capabilities it hands back.

**What `REALM_KEEP` actually earns.** `scrub-realm.test.ts` deletes each kept
name individually from an already-scrubbed worker and then drives the runtime —
compile, boot, twelve frames, `present()`, `installWorker`, and a
load/step/snapshot round trip. Three names break it and are therefore load-bearing
on this platform: `Math` (the PRNG and fixed-point maths), `performance`
(`worker.ts`'s `tookMs` clock, resolved at call time), and `globalThis`
(`installWorker` finding the worker scope). Five do not: `Date` is the clock
`worker.ts` did *not* choose, because `performance` existed when the module
loaded; `console` is a deliberate last resort; `Promise` is module machinery the
synchronous machine never touches; and `self` and `postMessage` are
browser-worker names that a Node worker global does not have at all, so this
platform cannot judge them. They stay in the list — a realm without
`performance` needs `Date`, and a browser worker needs `self` and `postMessage`
— but the probe is pinned, so if one of them ever becomes load-bearing here the
test says so.

`scrub-realm.browser.test.ts` runs the same probe in a browser worker, which has
all eight names, and answers the two questions Node had to leave open:

- **`postMessage` IS load-bearing.** Deleting it makes `isWorkerScope(globalThis)`
  false, so `installWorker(factory)` returns false and the runtime has no channel
  to the host at all. It moves from "cannot judge" to "needed" — on the platform
  that matters.
- **`self` is not.** The runtime reads `globalThis` and never `self`, so deleting
  it changes nothing even in the realm where it exists. It stays in `REALM_KEEP`
  because it is an alias for an object `globalThis` already hands out, so keeping
  it costs no reachability, and because a worker bootstrap written to the
  `WorkerGlobalScope` idiom will reach for it.

`Math`, `performance` and `globalThis` break the runtime in a browser exactly as
they do in Node. Note that the browser probe deletes through the prototype chain
too: a plain `delete globalThis.performance` on a web global removes nothing, so
a probe using one would report every WebIDL name as "not load-bearing" — the same
mistake the scrub itself was making.

**The wrapper itself was injectable, and is not any more.** A cart is source text
pasted between two strings, and `33-wrapper-injection.js` is the escape that
follows from that: source beginning `}, evil(), function () {` closes the strict
inner function and continues the wrapper's outer `return` as a comma expression.
The outer function is deliberately sloppy — a strict function may not have a
parameter named `eval` — and in sloppy code a plain call's `this` is the real
global object. No `Function` constructor is involved, so **Layer 2 would not have
closed it**: a hardened realm would have been handed over intact, `postMessage`
and all. `compileCart` now compiles every source on its own as a strict function
body before embedding it; source that parses as a complete FunctionBody has
balanced braces and cannot close one it did not open. The canary is kept as the
tripwire: if it ever compiles, that validation has been removed.

The practical consequence: **a cart must never be run outside a worker that has
called `scrubRealm`.** An in-process `createMachine(compileCart(source))` — which
is what the CLI and these tests do — runs unsandboxed source with only its
determinism guaranteed. That is fine for a cart you wrote and unacceptable for
one you downloaded.

**One smaller finding, recorded rather than fixed:**

- `22-error-stack-sniff.js` — on V8, `new Error().stack` read from cart code
  carries the runtime's frames and, in a development build, absolute file paths.
  A cart cannot phone home, but it can draw what it read or write it into the
  SAVE region, which the host persists. `scrubRealm` sets
  `Error.stackTraceLimit = 0`, and as of Firefox 155 that knob exists in
  SpiderMonkey too, so the mitigation now applies in both browser engines.

**One finding that was fixed, and is now guarded against regression:**

- `23-abi-tamper.js` — the `gfx`, `inp` and `sys` objects were not frozen, so a
  cart could park state on them, and that state survived `restore()`: a restore
  copies RAM and cannot see a property hanging off an object. `createMachine`
  now freezes the three method groups and the api object.

  Worth keeping in mind for the next one of these, because the shape recurs: the
  danger was never that a cart could *reach* something. It was that a cart could
  *remember* something. Rewind, save states, rollback netplay and every
  conformance chain rest on "the whole machine is one buffer", and a single
  writable property is enough to make that false — silently, and far from where
  the divergence eventually shows up.

  The canary is kept and its assertion inverted, so the fix cannot quietly come
  undone. `packages/runtime/test/state-containment.test.ts` covers the property
  end to end.

## Adding one

1. Write the `.js` file. Start with a comment saying what it tries and why it
   should fail — a canary whose intent is not written down decays into a test of
   whatever it happens to do now.
2. Make it report through `FLAG` / `REACH` / `NOTE`. Set `FLAG` only when the
   cart genuinely believes it obtained something live.
3. Add a manifest entry.
4. Run `npx vitest run packages/runtime/test/canaries.test.ts`.
5. If it escapes, do not weaken it. Record it as a `known-hole`, say what closes
   it, and raise it.
