/**
 * THE PLAYER'S WORKER ENTRY: the module a real `Worker` actually loads.
 *
 * `packages/runtime/src/worker-entry.ts` holds the four steps and the one order
 * that works -- receive, compile, harden, serve. This file is the other half of
 * that sentence: the part that owns a real `DedicatedWorkerGlobalScope`, decides
 * when the cart bytes have arrived, and calls it. It is deliberately thin.
 * Nothing here re-implements the bootstrap; if a rule about ordering is in
 * question, `worker-entry.ts` is where the answer lives.
 *
 * ===========================================================================
 * WHY THE CART ARRIVES IN A MESSAGE
 * ===========================================================================
 * A worker module cannot be handed constructor arguments, and the cart is a
 * byte array the page fetched. So the bytes arrive as the FIRST message, and
 * the whole of this file's own protocol is that one message:
 *
 *     { t: "sq1:cart", bytes: Uint8Array }
 *
 * It is tagged out of the `ToWorker` namespace on purpose. `"sq1:cart"` can
 * never collide with `"load"`, `"step"`, `"snapshot"` or `"restore"`, so the
 * bootstrap message and the machine protocol cannot be confused for one another
 * by either side -- and a `ToWorker` message that arrives before the cart does
 * gets an honest fault instead of being mistaken for a cart.
 *
 * THE HAND-OFF NEEDS NO ACKNOWLEDGEMENT, and that is a property of the event
 * loop rather than luck. `onmessage` is read at DISPATCH time, once per message.
 * The host posts the cart bytes and then, later, `load`. Message 1 runs this
 * file's handler, which calls `startCartWorker`, which calls `installWorker`,
 * which REPLACES `onmessage`. Message 2 is therefore dispatched to the machine's
 * handler. There is no window in which a `load` can reach an uninstalled worker,
 * so there is nothing for an ack to protect and no round trip to wait for.
 *
 * A FAILED BOOTSTRAP KEEPS ANSWERING. `startCartWorker` returns its errors
 * rather than throwing them, because a worker that died during its own bootstrap
 * leaves the host waiting on a reply that will never come. This file finishes
 * that thought: when the cart will not load, the bootstrap handler STAYS
 * installed and answers every subsequent message with a `fault`, so the host's
 * `load()` rejects with the reason instead of hanging until a deadline that
 * only `step` can arm. Every message gets exactly one reply, which is the same
 * contract `createMessageHandler` keeps.
 *
 * ===========================================================================
 * NO SIDE EFFECTS ON IMPORT, IN EVERY REALM BUT THE ONE THIS IS FOR
 * ===========================================================================
 * Importing this module attaches nothing and hardens nothing unless it is being
 * loaded AS a worker entry -- the self-install at the bottom is guarded by
 * `isWorkerScope`, so in Node, in a test, or on a page's main thread it is inert
 * for the reason `worker.ts` gives about `installWorker`. That is load-bearing
 * rather than tidy: `player.ts` imports `CART_MESSAGE` from here, on the main
 * thread, so that the tag has ONE definition instead of two spellings that can
 * drift -- and it must be able to do that without starting anything. Inside a dedicated
 * worker it installs one `onmessage` handler, which is the least a worker entry
 * can do and still be one. It does NOT scrub on import: hardening happens when a
 * cart arrives, because a realm destroyed for a worker that then serves nothing
 * is a realm that can no longer say why.
 *
 * ===========================================================================
 * HOW IT IS BUILT
 * ===========================================================================
 * The player constructs it as
 *
 *     new Worker(new URL("./cart-worker.ts", import.meta.url), { type: "module" })
 *
 * which is the form every modern bundler recognises: Vite rewrites it to the
 * emitted worker chunk, and in dev the browser loads this file straight off the
 * dev server. `type: "module"` is not optional -- this file has imports.
 */

import { isWorkerScope, startCartWorker } from "@sq1/runtime";
import type { BootstrapResult, FromWorker } from "@sq1/runtime";

/** The tag on the one message this file's own protocol has. */
export const CART_MESSAGE = "sq1:cart" as const;

/** Start serving this cart. The first thing the host posts to a fresh worker. */
export interface CartMessage {
  readonly t: typeof CART_MESSAGE;
  /** The `.cart` file's bytes. Cloned across, never transferred: see player.ts. */
  readonly bytes: Uint8Array;
}

/**
 * The bits of a worker global this file needs.
 *
 * Structural, and `data: unknown` rather than `data: ToWorker`, because the
 * bootstrap message is deliberately NOT a `ToWorker` -- this handler is the one
 * place that sees both kinds and has to tell them apart itself.
 */
export interface CartWorkerScope {
  onmessage: ((e: { data: unknown }) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
}

/** Is `m` the bootstrap message, with bytes that are really bytes? */
function isCartMessage(m: unknown): m is CartMessage {
  if (m === null || typeof m !== "object") return false;
  const o = m as Record<string, unknown>;
  return o["t"] === CART_MESSAGE && o["bytes"] instanceof Uint8Array;
}

/** Message of a thrown value, without assuming it is an Error. */
function why(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}

/**
 * Install the bootstrap handler on `scope`, or on this worker's own global.
 *
 * Returns false and changes nothing when there is no worker scope to attach to,
 * on the same terms as `installWorker`, so calling it unconditionally from a
 * module that also loads in Node is safe.
 *
 * @param scope the realm to serve in. Defaults to the worker's own global,
 *   which is the only thing `scrubRealm` can genuinely harden. A test may pass
 *   a stand-in: `scrubRealm` reports honestly about one rather than pretending,
 *   and hardening a plain object deletes and freezes nothing, so a test that
 *   passes one is testing the WIRING and must not be read as testing Layer 2.
 */
export function installCartBootstrap(scope?: CartWorkerScope): boolean {
  const target: CartWorkerScope | null =
    scope ?? (isWorkerScope(globalThis) ? (globalThis as unknown as CartWorkerScope) : null);
  if (target === null) return false;

  /** Why the cart is not being served, or null while it still might be. */
  let failure: string | null = null;

  const fault = (message: string): void => {
    const m: FromWorker = { t: "fault", phase: "load", message };
    target.postMessage(m);
  };

  target.onmessage = (e: { data: unknown }): void => {
    const data = e.data;

    if (failure === null && isCartMessage(data)) {
      let result: BootstrapResult;
      try {
        // THE CALL THIS FILE EXISTS TO MAKE. Compile, harden, serve, in that
        // order, and after it returns `target.onmessage` is the machine's.
        result = startCartWorker(data.bytes, scope === undefined ? undefined : { scope });
      } catch (err) {
        // `startCartWorker` returns its load errors, so reaching here means the
        // scrub or the install threw -- a realm defect, not a bad cart. It is
        // caught anyway: an uncaught throw in a worker reaches the host as an
        // `onerror` that `Host` is not listening for, which reads as a hang.
        failure = `cart worker: the bootstrap threw -- ${why(err)}`;
        fault(failure);
        return;
      }

      if (result.error !== null) {
        failure = `${result.error.code} -- ${result.error.message}`;
      } else if (!result.installed) {
        // Hardened, but with nothing listening: the host would wait forever.
        failure =
          "cart worker: the realm is not a dedicated worker scope, so no message " +
          "loop was installed";
      }
      if (failure !== null) fault(failure);
      return;
    }

    // Either the cart never loaded, or something arrived before it did. Both
    // are answered rather than dropped, because the host is waiting on a reply.
    fault(
      failure ??
        "cart worker: a machine message arrived before the cart bytes did, so " +
          "there is nothing to run",
    );
  };

  return true;
}

// The one line that makes this a worker ENTRY rather than a library. Inert
// everywhere that is not a dedicated worker global -- see the header.
installCartBootstrap();
