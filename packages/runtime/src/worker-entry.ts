/**
 * THE production worker bootstrap: cart bytes in, a serving worker out.
 *
 * This is the module a real Worker loads, and the only place in the repository
 * where the four steps are expressed in the one order that works.
 *
 * ===========================================================================
 * THE ORDER, AND WHY IT IS NOT GUESSABLE FROM THE OUTSIDE
 * ===========================================================================
 *
 *   1. RECEIVE the cart bytes.
 *   2. COMPILE the cart          -- `loadCartBytes`
 *   3. HARDEN the realm          -- `scrubRealm`
 *   4. INSTALL the message loop  -- `installWorker`
 *
 * COMPILE BEFORE SCRUB, because compiling needs the `Function` constructor and
 * step 3 deletes the global binding. `sandbox.ts` survives that by capturing
 * `Function` at module load (see THE BOOTSTRAP in its header), so compiling
 * after a scrub does in fact still work -- but only through that one captured
 * reference, and only for as long as nobody removes it. Compiling first means
 * the ordering is correct by construction rather than by a subtlety two files
 * away, and it means a cart that will not compile is refused while the realm
 * still has everything a diagnostic needs.
 *
 * SCRUB BEFORE INSTALL, because between the scrub and the first `step` message
 * nothing of the cart's has run yet: `loadCartBytes` compiles without
 * instantiating, and `createMachine` is not called until a `load` message
 * arrives. So the cart's top-level code executes for the first time in an
 * already-hardened realm. Install first and the window between "serving" and
 * "hardened" is a window in which a `load` message runs a stranger's cart on
 * Layers 0+1 alone -- which `conformance/canaries/` documents as escapable.
 *
 * A FAILED LOAD SCRUBS NOTHING AND INSTALLS NOTHING. A worker that hardened
 * itself and then served no cart is a worker whose realm has been destroyed for
 * no reason and which now cannot say why: `console` survives the scrub but the
 * diagnostic paths around it do not all survive being frozen, and there is
 * nothing to protect. The bootstrap reports the `LoadError` and stops, leaving
 * the host with an intact worker it can question.
 *
 * NO SIDE EFFECTS ON IMPORT. Importing this module attaches nothing to the
 * global scope and hardens nothing, for the reason worker.ts gives about
 * `installWorker`: this file is reachable from the package barrel, which the
 * CLI, the tests and the host all load in Node. Starting a worker is a call.
 */

import { createMachine } from "./machine";
import { loadCartBytes } from "./load";
import type { LoadError } from "./load";
import { scrubRealm } from "./sandbox";
import type { ScrubReport } from "./sandbox";
import { installWorker, isWorkerScope } from "./worker";
import type { WorkerScope } from "./worker";

export interface BootstrapOptions {
  /**
   * Harden the realm before serving. DEFAULTS TO TRUE, and true is the only
   * value a shipping player should ever pass.
   *
   * `scrub: false` asks for an UNHARDENED realm: Layers 0 and 1 still apply, so
   * the cart is denied every dangerous name and stays deterministic, but the
   * six escapes listed in `conformance/canaries/README.md` are open -- a cart
   * reaches the real global object through `(function(){}).constructor` in one
   * line. It exists for in-process tests and for nothing else, because
   * `scrubRealm` cannot run in a realm that hosts anything besides one cart: it
   * deletes `Math` and freezes the intrinsics, which would break the test
   * runner that called it.
   */
  readonly scrub?: boolean;
  /**
   * The realm this bootstrap operates on. Defaults to the worker's own global
   * scope, which is what a real Worker wants and the only thing that can
   * actually be hardened.
   *
   * It is passed to `scrubRealm`, and -- when it looks like a dedicated worker
   * global -- it is also what the message loop attaches to. A fake object
   * scrubs nothing real and reports honestly rather than pretending (see the
   * SCOPE section of `scrubRealm`).
   */
  readonly scope?: object;
}

/**
 * What the bootstrap actually did. Every field is an observation, in the shape
 * of the `ScrubReport` it carries: a host reads this to learn which realm its
 * worker ended up in, and a run that reports `scrub: null` with
 * `installed: true` is a worker serving a cart on Layer 1 alone.
 */
export interface BootstrapResult {
  /** True when the message loop is attached and the worker will answer. */
  readonly installed: boolean;
  /** The realm-hardening report, or null when hardening was skipped or not reached. */
  readonly scrub: ScrubReport | null;
  /** Why the cart did not load, or null. Non-null implies nothing was scrubbed or installed. */
  readonly error: LoadError | null;
}

/**
 * Start serving a cart in this realm.
 *
 * The whole of a real worker entry point is:
 *
 *     import { startCartWorker } from "@sq1/runtime";
 *     startCartWorker(cartBytes);
 *
 * Returns rather than throws, on the same terms as `loadCartBytes`: a worker
 * that died during its own bootstrap tells the host nothing, and the host is
 * sitting on the other side of a message port waiting for a reply that a thrown
 * exception will never produce.
 */
export function startCartWorker(bytes: Uint8Array, opts?: BootstrapOptions): BootstrapResult {
  // 2 -- COMPILE. Before the scrub, and before anything is attached.
  const loaded = loadCartBytes(bytes);
  if (!loaded.ok) {
    return { installed: false, scrub: null, error: loaded.error };
  }
  const program = loaded.program;
  // The cart's static data travels with its program, and this line is why the
  // type carries it: a worker that compiled the CODE chunk and dropped the
  // `GFX ` chunk would serve a cart that draws a blank sheet, while the same
  // cart in-process looked perfect. That divergence is invisible from the host
  // side -- the worker answers every message correctly -- so it would be found
  // by a player, on a game, in the dark.
  const data = loaded.data;

  // 3 -- HARDEN. After this line nothing may be compiled from a string.
  const scope = opts?.scope;
  const scrub = (opts?.scrub ?? true) ? scrubRealm(scope) : null;

  // 4 -- SERVE. `createMachine` runs on the `load` message, not now, so the
  // cart's own code executes for the first time in the realm step 3 just made.
  const target: WorkerScope | undefined =
    scope !== undefined && isWorkerScope(scope) ? scope : undefined;
  const installed = installWorker(() => createMachine(program, { data }), target);

  return { installed, scrub, error: null };
}
