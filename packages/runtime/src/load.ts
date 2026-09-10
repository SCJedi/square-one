/**
 * The seam: cart BYTES to a `CartProgram`.
 *
 * `@sq1/cart` knows how to parse a container and `sandbox.ts` knows how to
 * compile source text. Until this file existed, nothing joined them: `sq1 build`
 * could write a `.cart` that no code in this repository could open, and the
 * milestone claim "hand-written JavaScript carts now run" was only ever true of
 * source strings sitting in test files.
 *
 * WHAT THIS FILE IS RESPONSIBLE FOR
 * --------------------------------
 * One decision, made once, in one place: given bytes from a stranger, either a
 * program the machine can run, or a typed reason why not. Every host -- the
 * worker bootstrap, the CLI, a future player page -- asks this question, and
 * every one of them must get the same answer, including for the carts it
 * refuses. A second loader written somewhere else would be a second definition
 * of what a cart is.
 *
 * IT NEVER THROWS, AND THAT IS THE WHOLE CONTRACT
 * -----------------------------------------------
 * `decode` in @sq1/cart never throws, for the reason its header gives: it is
 * where hostile bytes meet parsing code. This function sits directly on top of
 * it and inherits the same duty -- it is now part of that same surface, and it
 * additionally hands a stranger's source to a compiler, which is the one thing
 * `decode` never had to do. So every failure below leaves as a `LoadError`, the
 * body is wrapped in a catch-all, and `load.test.ts` asserts the property
 * directly for every failure it exercises.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 * --------------------------------
 * IT DOES NOT RUN THE CART. Compiling is not instantiating: `compileCart`
 * returns a program whose top level has not executed yet, and the cart's own
 * code runs on the first `boot`/`tick` against a real machine (see the
 * BOOTSTRAP section of sandbox.ts). That is why "this cart declares no `tick`"
 * is NOT a load error -- discovering it would mean running the cart's top level,
 * and in the worker bootstrap loading happens BEFORE `scrubRealm`, so a shape
 * check here would run a stranger's code in an unhardened realm to find out
 * whether it was worth hardening for. The shape check stays where the sandbox
 * put it: on the first boot, which in a worker is after the scrub. A cart with
 * no `tick` therefore loads and then faults at `load` phase, which the host
 * already reports.
 *
 * IT DOES NOT LINT. `lintCartSource` is the BUILD-time gate: it tells an author
 * their cart names `Date` before they ship it. At load time the same cart is
 * simply a cart that will see `undefined` there, which is exactly what Layer 1
 * promises, and refusing to play a published cart because a build-time rule has
 * since tightened would be a player that stops opening old carts. The token
 * count comes back as a diagnostic (`tokens`) and is never a reason to refuse.
 */

import { countTokens } from "@sq1/core";
import { decode, decodeMeta, decodeUtf8, defaultMeta, encodeMeta, getChunk } from "@sq1/cart";
import type { Meta } from "@sq1/cart";

import { NO_CART_DATA, planCartData } from "./cart-data";
import type { CartData } from "./cart-data";
import type { CartProgram } from "./machine";
import { CartCompileError, compileCart } from "./sandbox";

/** The one META payload this runtime can execute. `wasm/1` is reserved. */
export const RUNNABLE_PAYLOAD = "script/js1";

/**
 * Why a cart would not load.
 *
 * The codes are structural, not cosmetic: a host branches on them (a player
 * shows "this cart needs a newer player" for `unsupported-payload` and "this
 * file is damaged" for `bad-container`), so they are stable and never reworded.
 *
 *   bad-container       the container itself is wrong -- `decode` refused it.
 *                       The underlying `CartError` code and message are carried
 *                       through verbatim, because they name the byte offset.
 *   bad-meta            the container is fine and the META chunk is not.
 *   unsupported-payload META declares a payload this runtime cannot execute.
 *   missing-code        a decoded cart with no CODE chunk. See the note on
 *                       `loadCartBytes`: today `decode` refuses these first.
 *   chunk-too-large     a data chunk is longer than the RAM region it installs
 *                       into. A REFUSAL, never a truncation: a cart whose level
 *                       data lost its tail would run, and be wrong, and nobody
 *                       would find out from the machine. See cart-data.ts.
 *   compile-failed      the CODE chunk is not source this console will compile.
 *
 * `line`/`column` are 1-based positions IN THE CART SOURCE, present only when
 * the engine gave one that could be translated with confidence -- see
 * `positionOf` in sandbox.ts. They are never invented: an absent position sends
 * an author to read their file, a wrong one sends them to the wrong line.
 */
export interface LoadError {
  readonly code:
    | "bad-container"
    | "bad-meta"
    | "unsupported-payload"
    | "missing-code"
    | "chunk-too-large"
    | "compile-failed";
  readonly message: string;
  readonly line?: number;
  readonly column?: number;
}

/**
 * A loaded cart, or the reason there is not one.
 *
 * `program` is ready for `createMachine` and has bound to nothing yet, so the
 * caller chooses which machine it belongs to. `meta` is the VALIDATED metadata,
 * not the raw chunk -- a host that wants a title should read it from here
 * rather than parse META a second time. `tokens` is the cart's size in the
 * console's own token units, for diagnostics only.
 *
 * `data` is the cart's static data, already matched to the RAM spans it
 * installs into, and it travels WITH the program because it is half of what a
 * cart is: `createMachine(program, { data })` is the whole of running one.
 * Every host in this repository does exactly that, so that a cart cannot look
 * right in one and blank in another -- which is what would happen if the worker
 * bootstrap forgot to pass it on and nothing in the type system noticed.
 */
export type LoadResult =
  | { ok: true; program: CartProgram; meta: Meta; data: CartData; tokens?: number }
  | { ok: false; error: LoadError };

/**
 * Build a `LoadError`, omitting the position fields rather than setting them to
 * `undefined` -- `exactOptionalPropertyTypes` is on, and `{ line: undefined }`
 * is not a `{ line?: number }`.
 */
function loadError(
  code: LoadError["code"],
  message: string,
  line?: number,
  column?: number,
): LoadError {
  if (line === undefined) return { code, message };
  if (column === undefined) return { code, message, line };
  return { code, message, line, column };
}

function fail(
  code: LoadError["code"],
  message: string,
  line?: number,
  column?: number,
): LoadResult {
  return { ok: false, error: loadError(code, message, line, column) };
}

/** The message of a thrown value, without assuming it is an Error. */
function describe(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}

/**
 * Compile validated source against validated metadata.
 *
 * The half `loadCartBytes` and `loadCartSource` share, so the two can never
 * disagree about what compiling means or what a compile failure looks like.
 */
function compileProgram(source: string, meta: Meta, data: CartData): LoadResult {
  let program: CartProgram;
  try {
    program = compileCart(source, { name: meta.title === "" ? "cart" : meta.title });
  } catch (e) {
    if (e instanceof CartCompileError) {
      // Carried through, never re-derived. The sandbox already did the
      // engine-specific arithmetic that turns a wrapper position into a cart
      // position, and it drops the position rather than report a wrong one.
      return fail("compile-failed", e.message, e.line, e.column);
    }
    return fail("compile-failed", `cart "${meta.title}" did not compile -- ${describe(e)}`);
  }

  // Diagnostic only, and never a reason to refuse. `compileCart` has already
  // tokenized this source successfully, so the catch is unreachable defence
  // rather than a real branch.
  let tokens: number | undefined;
  try {
    tokens = countTokens(source);
  } catch {
    tokens = undefined;
  }

  return tokens === undefined
    ? { ok: true, program, meta, data }
    : { ok: true, program, meta, data, tokens };
}

/** Validate metadata, and refuse a payload this runtime cannot execute. */
function checkPayload(meta: Meta): LoadError | null {
  if (meta.payload === RUNNABLE_PAYLOAD) return null;
  if (meta.payload === "wasm/1") {
    // Named, not lumped in with "some other payload". `wasm/1` is a RESERVED
    // value in the container spec that no player implements yet, so a cart
    // declaring it is not damaged and its author has not made a mistake -- it
    // is a cart from a future this runtime has not reached. A generic refusal
    // would send that author hunting for a corruption that is not there.
    return loadError(
      "unsupported-payload",
      `this cart declares payload "wasm/1", which is reserved in the container ` +
        `specification and not implemented by this runtime. This player runs ` +
        `"${RUNNABLE_PAYLOAD}" carts only.`,
    );
  }
  return loadError(
    "unsupported-payload",
    `this cart declares payload ${JSON.stringify(meta.payload)}, which this runtime ` +
      `cannot execute. This player runs "${RUNNABLE_PAYLOAD}" carts only.`,
  );
}

/**
 * Turn cart bytes into a program, or say exactly why not.
 *
 * The order is the order of trust, cheapest and most structural first, and it
 * matches the order `decode` itself uses:
 *
 *   1. the container parses                     -> bad-container
 *   2. META parses and validates                -> bad-meta
 *   3. the payload is one this runtime runs     -> unsupported-payload
 *   4. there is a CODE chunk                    -> missing-code
 *   5. every data chunk fits its RAM region     -> chunk-too-large
 *   6. CODE is valid UTF-8, and compiles        -> compile-failed
 *
 * STEP 5 COMES BEFORE STEP 6 because it is the cheaper and more structural
 * question -- it reads four numbers out of a directory that has already been
 * parsed, where compiling hands a stranger's text to an engine.
 *
 * A NOTE ON STEP 4. `decode` lists CODE in `REQUIRED_CHUNKS`, so it refuses a
 * cart with no CODE chunk at step 1 and the `missing-code` branch is not
 * reachable from real bytes today. It stays because the code is part of this
 * function's contract with its callers and because the container's required-
 * chunk set is a container decision that could be relaxed (an ancillary-only
 * cart, a stub for a payload type this player does not run) without anyone
 * remembering to add a check here. A cart with no CODE therefore comes back as
 * `bad-container` whose message names the missing chunk, and load.test.ts pins
 * that as the observed behaviour rather than asserting the branch it does not
 * reach.
 *
 * NEVER THROWS. The whole body is guarded; an escaping exception here would be
 * an unhandled rejection inside a host nobody in this repository controls.
 */
export function loadCartBytes(bytes: Uint8Array): LoadResult {
  try {
    return loadBytesInner(bytes);
  } catch (e) {
    // Not reachable by any known input. If it ever fires, the guarantee this
    // function is built on has been broken somewhere below and the message is
    // what says where to look.
    return fail(
      "bad-container",
      `loading this cart threw, which loadCartBytes must never do: ${describe(e)}`,
    );
  }
}

function loadBytesInner(bytes: Uint8Array): LoadResult {
  // 1 ---------------------------------------------------------------------
  const decoded = decode(bytes);
  if (!decoded.ok) {
    const { code, message, offset } = decoded.error;
    return fail(
      "bad-container",
      `this file is not a valid cart (${code}): ${message}` +
        (offset === undefined ? "" : ` [byte ${offset}]`),
    );
  }
  const cart = decoded.cart;

  // 2 ---------------------------------------------------------------------
  const metaBytes = getChunk(cart, "META");
  if (metaBytes === undefined) {
    return fail("bad-meta", `this cart has no META chunk, so there is nothing describing it`);
  }
  const metaResult = decodeMeta(metaBytes);
  if (!metaResult.ok) {
    return fail("bad-meta", `this cart's META chunk is invalid: ${metaResult.error.message}`);
  }
  const meta = metaResult.meta;

  // 3 ---------------------------------------------------------------------
  const payloadError = checkPayload(meta);
  if (payloadError !== null) return { ok: false, error: payloadError };

  // 4 ---------------------------------------------------------------------
  const codeBytes = getChunk(cart, "CODE");
  if (codeBytes === undefined) {
    return fail(
      "missing-code",
      `this cart has no CODE chunk, so there is nothing to run. A ` +
        `"${RUNNABLE_PAYLOAD}" cart carries its source in CODE.`,
    );
  }

  // 5 ---------------------------------------------------------------------
  // The cart's static data, matched to the RAM spans it installs into. An
  // oversize chunk is refused and NEVER trimmed to fit: a cart missing the tail
  // of its map would still run, still draw, and be wrong in a way the machine
  // could not report. See the header of cart-data.ts.
  const planned = planCartData(cart.chunks);
  const tooBig = planned.oversize[0];
  if (tooBig !== undefined) {
    const others = planned.oversize.length - 1;
    return fail(
      "chunk-too-large",
      `this cart's ${tooBig.chunk.trim()} chunk is ${tooBig.bytes} bytes, and the region it ` +
        `installs into holds ${tooBig.max}. A player installs a cart's data into RAM at boot ` +
        `and refuses a chunk that does not fit, rather than installing part of it.` +
        (others > 0 ? ` ${others} other chunk${others === 1 ? " does" : "s do"} not fit either.` : ""),
    );
  }

  // 6 ---------------------------------------------------------------------
  // The container's own strict decoder, not `TextDecoder`: it is guaranteed to
  // exist inside a scrubbed worker realm, and it REFUSES malformed input rather
  // than repairing it with U+FFFD. A lenient decode would let two different
  // CODE chunks compile to the same program, which is one game at two cart ids.
  const source = decodeUtf8(codeBytes);
  if (source === null) {
    return fail(
      "compile-failed",
      `this cart's CODE chunk is not valid UTF-8, so it is not source text. A ` +
        `"${RUNNABLE_PAYLOAD}" cart's CODE chunk is its JavaScript, encoded as UTF-8.`,
    );
  }

  return compileProgram(source, meta, planned.data);
}

/**
 * Load a cart from source text, with no container in the middle.
 *
 * For a host that already has the source: an editor previewing an unsaved
 * buffer, a test, a tool that generates a cart. `meta` fills in over
 * `defaultMeta`, so the common call is `loadCartSource(src)`.
 *
 * The metadata still goes through `encodeMeta`/`decodeMeta` rather than being
 * used as given. It costs one round trip and it buys the thing that matters:
 * source-loading and byte-loading cannot drift apart about what a valid META
 * is, so a cart that previews in an editor is a cart that will build, and a
 * title this refuses is a title `sq1 build` would have refused too.
 *
 * NEVER THROWS, on the same terms as `loadCartBytes`.
 */
export function loadCartSource(source: string, meta?: Partial<Meta>): LoadResult {
  try {
    const merged: Meta = { ...defaultMeta("untitled", "unknown"), ...meta };

    let encoded: Uint8Array;
    try {
      encoded = encodeMeta(merged);
    } catch (e) {
      return fail("bad-meta", `this cart's metadata is invalid: ${describe(e)}`);
    }
    const round = decodeMeta(encoded);
    if (!round.ok) {
      return fail("bad-meta", `this cart's metadata is invalid: ${round.error.message}`);
    }

    const payloadError = checkPayload(round.meta);
    if (payloadError !== null) return { ok: false, error: payloadError };

    // No container, so no chunks and no static data: a source-loaded cart boots
    // into the zeroed machine `boot` leaves behind. A caller that wants art
    // with its source builds the chunks and goes through `loadCartBytes`.
    return compileProgram(source, round.meta, NO_CART_DATA);
  } catch (e) {
    return fail(
      "compile-failed",
      `loading this source threw, which loadCartSource must never do: ${describe(e)}`,
    );
  }
}
