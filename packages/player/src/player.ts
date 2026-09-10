/**
 * The whole console, assembled: cart bytes in, a playable machine out.
 *
 * =========================================================================
 * THERE IS ONE CLOCK AND IT IS NOT HERE
 * =========================================================================
 * `Host` owns the frame clock. This file's animation frame does exactly two
 * things -- take a timestamp and hand it to `host.advance` -- and never decides
 * how many frames that timestamp is worth. Writing a second accumulator here
 * would be the classic way to get a console that runs at a different speed on a
 * 120 Hz display than on a 60 Hz one, and worse, a replay that only reproduces
 * on the machine that recorded it. The accumulator, both its clamps and the
 * catch-up limit live in `host.ts`, in code a test can hand fake timestamps to.
 *
 * INPUT IS SAMPLED ONCE PER `advance`, not once per animation frame and not
 * once per step. `advance` may spend one wake-up on two or three simulated
 * frames when the display stuttered; every one of them sees the input as it was
 * when the wake-up began. That is the honest reading -- there was no new human
 * input in between, because no time passed for the human -- and it keeps the
 * input trace a function of frame number alone, which is what makes a recorded
 * input stream replayable.
 *
 * =========================================================================
 * WHERE THE CART RUNS: A REAL WORKER, WITH THE REALM SCRUBBED
 * =========================================================================
 * A player runs a stranger's code. By default this one runs it in a real
 * `Worker` whose realm `scrubRealm` has hardened -- Layers 0, 1 AND 2 -- because
 * Layer 1 alone is not a security boundary and `conformance/canaries/README.md`
 * lists the six escapes it does not close, each of them one line of cart source.
 *
 * That default is not a preference, it is the only configuration in which the
 * sandbox is a sandbox. `scrubRealm` deletes `Function`, deletes `eval`, deletes
 * `fetch` and freezes the intrinsics, and it CANNOT run on a realm shared with a
 * page: it would take those away from the host application too. So "hardened"
 * and "on the main thread" are mutually exclusive, and the choice this file
 * makes is hardened.
 *
 * `cart-worker.ts` is the module that worker loads; `startCartWorker` in the
 * runtime is what it calls. The cart bytes are posted to it as its first
 * message and it hardens the realm before installing the message loop, so the
 * cart's own top-level code runs for the first time in an already-scrubbed
 * realm. The bytes ARE compiled once here on the main thread first, by
 * `loadCartBytes` below -- compiling is not running (`loadCartBytes` compiles
 * without instantiating), and doing it up front means a corrupt or unparseable
 * cart is reported before any DOM is built.
 *
 * THE CHANNEL IS A FACTORY, not a `Worker`, because a terminated worker cannot
 * be restarted. Recovering from the watchdog's deadline means BUILDING A NEW
 * ONE, and a host handed an instance has no way to.
 *
 * NO SILENT FALLBACK. In an environment without `Worker`, `createPlayer`
 * THROWS. Quietly dropping to the in-process path would hand a stranger's cart
 * the page, on exactly the machines least able to notice -- which is the
 * failure this default exists to prevent. The caller has to say what it wants.
 *
 * THE IN-PROCESS PATH IS STILL HERE, and it is `unsafeInProcess: true`: opt-in,
 * named for what it costs, and documented on the option itself. It is for tests
 * and for authoring tools -- for a cart you wrote -- and not for one you
 * downloaded.
 *
 * AUDIO CROSSES WITH THE PIXELS. `FromWorker.frame` carries the 80-byte audio
 * register block, so `host.latestAudio` is the mixer's input on both paths and
 * this file no longer needs a machine reference to make sound. That coupling is
 * why the two things changed together: while audio could only be read from a
 * machine object on this thread, defaulting to a Worker would have shipped a
 * silent console.
 */

import {
  Host,
  MAX_PLAYERS,
  createMachine,
  inProcessChannel,
  loadCartBytes,
  workerChannel,
} from "@sq1/runtime";
import type { Channel } from "@sq1/runtime";

import { createAudioGraph } from "./audio-graph";
import type { AudioGraph } from "./audio-graph";
import { CART_MESSAGE } from "./cart-worker";
import type { CartMessage } from "./cart-worker";
import { computeLayout } from "./layout";
import type { ShellLayout } from "./layout";
import {
  INPUT_BYTES,
  combineInputs,
  createGamepadInput,
  createKeyboardInput,
  createTouchInput,
} from "./input";
import type { ConsoleInputSource, TouchInput } from "./input";
import { createScreen } from "./screen";
import { createShell } from "./shell";

/** How often to re-poll which gamepads are plugged in, in frames. */
const PRESENCE_POLL = 30;

/**
 * How long a step may go unanswered when the cart is in a WORKER, in ms.
 *
 * `Host`'s own default is 12 -- the spec's per-frame budget -- and that is the
 * right number for a machine on this thread, where the reply is produced
 * synchronously inside `post` and any delay at all really is a hang. Across a
 * thread boundary it is the wrong number, because it stops measuring liveness
 * and starts measuring latency: worker start-up, a message the main thread has
 * not got round to reading, one garbage collection, and a perfectly healthy cart
 * is declared dead and its worker killed.
 *
 * A deadline is a LIVENESS check, not a performance budget. The cost of setting
 * it high is that `while (true) {}` shows a frozen picture for up to a second
 * before the console says so -- and only a picture, because the loop is in
 * another thread and this one is still drawing. The cost of setting it too low
 * is killing working carts at random, which is strictly worse.
 */
const WORKER_DEADLINE_MS = 1000;

export interface PlayerOptions {
  /** The element the console fills. Its box drives every layout decision. */
  mount: HTMLElement;
  /** A `.cart` file's bytes. */
  cart: Uint8Array;
  /** Boot seed. Default 0. The same cart and seed is the same run, always. */
  seed?: number;
  /**
   * The mixer. Default: a real `AudioGraph` over an AudioWorklet. `false` for
   * no sound at all.
   *
   * A graph may also be passed in. That is how a test sees what the mixer is
   * actually handed: a headless browser never leaves its `AudioContext`
   * suspended state without a user gesture, so a real graph would never be
   * `running` and would therefore never be given a single frame of registers --
   * a test built on one would pass while proving nothing.
   */
  audio?: boolean | AudioGraph;
  /**
   * RUN THE CART ON THIS THREAD. **Layer 1 only. Not a sandbox.**
   *
   * `scrubRealm` cannot run on a realm shared with a page, so a cart on this
   * thread gets the deny-list and parameter shadowing and NOTHING ELSE. The six
   * escapes in `conformance/canaries/README.md` are wide open: one of them is
   * `(function(){}).constructor("return this")()`, which hands the cart the real
   * global object, and from there the page -- its DOM, its cookies, its network.
   * A cart that runs here can do anything the page can do.
   *
   * It exists for tests, for conformance runs and for authoring tools, where the
   * cart is one you just wrote and the machine object has to be reachable. It is
   * not a performance option and it is not a compatibility shim. **Never set it
   * for a cart you did not write.**
   */
  unsafeInProcess?: boolean;
  /**
   * Build the channel the machine runs behind yourself.
   *
   * Overrides both the default worker and `unsafeInProcess`; pass it when the
   * machine lives somewhere this file does not know how to reach -- a worker you
   * built with different options, a remote runner, a replay harness. You then
   * own the sandbox: nothing here can tell whether what you returned hardened
   * anything.
   *
   * Called again to recover from a watchdog deadline, which is why it is a
   * factory and not a channel.
   */
  channel?: () => Channel;
  /**
   * Show the virtual controller. Default: whatever the device says, via
   * `(pointer: coarse)`. Forceable for testing and for handheld builds.
   */
  touch?: boolean;
}

export interface Player {
  start(): void;
  pause(): void;
  resume(): void;
  stop(): void;
  /**
   * A copy of machine RAM, asked for over the channel.
   *
   * The ONLY way to observe the machine, and deliberately the only way: once
   * the cart is behind a hardened Worker there is no machine object on this
   * thread to reach for, and a player that kept one would be a player that had
   * not really moved the cart. It is a copy, so writing to it changes nothing.
   *
   * Rejects if the run has faulted or the channel is gone.
   */
  snapshot(): Promise<Uint8Array>;
  /** Frames issued to the machine. */
  readonly frame: number;
  /** Frames the machine has actually answered. Trails `frame` behind a Worker. */
  readonly framesConfirmed: number;
  readonly paused: boolean;
}

/** True when the device's primary pointer is a finger. */
function looksLikeTouch(): boolean {
  const g = globalThis as {
    matchMedia?: (q: string) => { matches: boolean };
    navigator?: { maxTouchPoints?: number };
  };
  if (typeof g.matchMedia === "function") {
    try {
      if (g.matchMedia("(pointer: coarse)").matches) return true;
    } catch {
      /* A browser too old to parse the query is a browser without a touch screen. */
    }
  }
  return (g.navigator?.maxTouchPoints ?? 0) > 0;
}

export function createPlayer(opts: PlayerOptions): Player {
  const mount = opts.mount;
  const doc = mount.ownerDocument;
  const view = doc.defaultView;
  if (view === null) {
    throw new Error("createPlayer: the mount element is not in a rendered document.");
  }
  // Re-bound with a non-nullable type rather than relying on the narrowing
  // above: every function below is a hoisted declaration, and TypeScript will
  // not carry a control-flow narrowing into one, because a hoisted function
  // could in principle be called before the check ran.
  const win: Window = view;

  // --- the cart -------------------------------------------------------------
  // Decoded and compiled BEFORE any DOM is built, so a cart that will not load
  // produces an error instead of a half-built console with an empty screen.
  const loaded = loadCartBytes(opts.cart);
  if (!loaded.ok) {
    throw new Error(`Square One: ${loaded.error.code} -- ${loaded.error.message}`);
  }
  // Re-bound out of the narrowed union for the same reason `win` is above: the
  // functions that read it are hoisted declarations, and TypeScript will not
  // carry a control-flow narrowing into one.
  const program = loaded.program;
  const title = loaded.meta.title;

  /**
   * A fresh hardened Worker, already holding the cart bytes.
   *
   * The bytes are CLONED into the message, never transferred: a transfer would
   * detach `opts.cart` in the caller's hands, and this function is called again
   * on every respawn -- the second worker would be handed an empty array and the
   * console would come back from a deadline with a cart that will not load.
   */
  function hardenedWorkerChannel(): Channel {
    if (typeof (globalThis as { Worker?: unknown }).Worker !== "function") {
      throw new Error(
        "createPlayer: this environment has no Worker, and a cart must not run " +
          "unsandboxed on the page's own thread. Pass `unsafeInProcess: true` if " +
          "you wrote the cart yourself and accept that it gets Layer 1 only, or " +
          "pass `channel` to run it somewhere else.",
      );
    }
    // Written as one literal expression on purpose: this exact shape is what
    // Vite, Rollup and webpack all recognise as "emit that module as a worker".
    const w = new Worker(new URL("./cart-worker.ts", import.meta.url), { type: "module" });
    const start: CartMessage = { t: CART_MESSAGE, bytes: opts.cart };
    // Before the Host posts anything. `cart-worker.ts` explains why no ack is
    // needed: the worker's onmessage is replaced while this message is being
    // handled, so `load` is dispatched to the machine's handler.
    w.postMessage(start);
    return workerChannel(w);
  }

  /** The cart on this thread, with no realm hardening. See `unsafeInProcess`. */
  function inProcessUnsafeChannel(): Channel {
    return inProcessChannel(createMachine(program));
  }

  const onThisThread = opts.channel === undefined && opts.unsafeInProcess === true;
  const makeChannel: () => Channel =
    opts.channel ?? (opts.unsafeInProcess === true ? inProcessUnsafeChannel : hardenedWorkerChannel);

  const host = new Host(makeChannel(), {
    respawn: makeChannel,
    // See WORKER_DEADLINE_MS. In process a reply is synchronous, so `Host`'s own
    // 12 ms is a true liveness check; off this thread it would be a latency
    // measurement wearing a liveness check's clothes.
    ...(onThisThread ? {} : { deadlineMs: WORKER_DEADLINE_MS }),
  });

  // --- presentation ---------------------------------------------------------
  const useTouch = opts.touch ?? looksLikeTouch();
  let layout: ShellLayout = computeLayout(mount.clientWidth, mount.clientHeight, {
    touch: useTouch,
  });

  const screen = createScreen({ document: doc });
  const shell = createShell({
    mount,
    title,
    document: doc,
    onPause: () => togglePause(),
  });
  shell.mountScreen(screen.canvas);

  // --- input ----------------------------------------------------------------
  const keyboard = createKeyboardInput();
  const gamepad = createGamepadInput();
  const touch: TouchInput | null = useTouch ? createTouchInput(layout) : null;

  const sources = touch === null ? [keyboard, gamepad] : [keyboard, gamepad, touch];
  const input: ConsoleInputSource = combineInputs(sources);
  input.onConsole((e) => {
    if (e === "pause") togglePause();
  });

  // Attached individually rather than through the combiner: the keyboard listens
  // to the window (a game must respond to keys wherever focus is), the touch
  // panel listens to the console's own element (it must NOT claim touches
  // elsewhere on the host's page).
  keyboard.attach(win);
  touch?.attach(shell.root);

  /** Allocated once. `advance` copies it, so one array serves every frame. */
  const frameInput = new Uint8Array(INPUT_BYTES);

  const audio: AudioGraph | null =
    opts.audio === false
      ? null
      : typeof opts.audio === "object"
        ? opts.audio
        : createAudioGraph();

  // --- layout ---------------------------------------------------------------
  function relayout(): void {
    const w = mount.clientWidth;
    const h = mount.clientHeight;
    if (w === 0 && h === 0) return;
    layout = computeLayout(w, h, { touch: useTouch });
    screen.resize(layout);
    shell.apply(layout);
    touch?.setLayout(layout);
  }

  let observer: ResizeObserver | null = null;
  const onWindowResize = (): void => relayout();
  // The mount can change size without the window doing so -- a sidebar opening,
  // a flex sibling growing -- and a window `resize` listener never hears about
  // it. `ResizeObserver` watches the element itself, which is the thing the
  // layout is actually a function of; the window listener is the fallback for
  // browsers too old to have it.
  const RO = (win as unknown as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;
  if (typeof RO === "function") {
    const ro = new RO(() => relayout());
    ro.observe(mount);
    observer = ro;
  } else {
    win.addEventListener("resize", onWindowResize);
  }

  // --- the loop -------------------------------------------------------------
  let raf = 0;
  let running = false;
  let paused = false;
  let lastConfirmed = -1;
  let presenceTick = 0;
  let reportedFault = "";

  /**
   * Start audio on the first gesture, not on `start()`.
   *
   * Every browser refuses to run an `AudioContext` that was not created or
   * resumed inside a user gesture, and refuses SILENTLY -- the context sits in
   * "suspended" and the game simply has no sound. So the mixer is armed by the
   * first press of anything and the listener removes itself.
   */
  let disarmAudio: (() => void) | null = null;

  function armAudio(): void {
    if (audio === null || disarmAudio !== null) return;
    const go = (): void => {
      disarm();
      void audio.start().catch(() => {
        shell.setStatus("audio unavailable");
      });
    };
    // Held so `stop()` can take the listeners back off a player that was never
    // touched. A console removed from the page while still waiting for its
    // first gesture would otherwise keep two window listeners alive, and with
    // them the whole player and its 64 KiB of machine.
    const disarm = (): void => {
      win.removeEventListener("pointerdown", go);
      win.removeEventListener("keydown", go);
      disarmAudio = null;
    };
    disarmAudio = disarm;
    win.addEventListener("pointerdown", go);
    win.addEventListener("keydown", go);
  }

  /**
   * Hand the mixer the frame's registers.
   *
   * Through the protocol, so it works the same whether the cart is in a worker
   * or on this thread -- the machine object is not reachable from here and does
   * not need to be. `latestAudio` is null before the first frame of a run, which
   * is the honest answer while there is nothing yet to play; `push` copies, so
   * the reused array crossing the boundary is safe to hand straight over.
   */
  function pushAudio(): void {
    if (audio === null || !audio.running) return;
    const regs = host.latestAudio;
    if (regs !== null) audio.push(regs);
  }

  /** Light a lamp per attached controller. Slot 0 is the keyboard, always there. */
  function refreshPresence(): void {
    let mask = 1;
    const nav = (globalThis as { navigator?: Navigator }).navigator;
    if (nav !== undefined && typeof nav.getGamepads === "function") {
      const pads = nav.getGamepads();
      const n = Math.min(pads.length, MAX_PLAYERS);
      for (let i = 0; i < n; i++) {
        const pad = pads[i];
        if (pad !== null && pad !== undefined && pad.connected) mask |= 1 << i;
      }
    }
    shell.setPlayers(mask);
  }

  function tick(nowMs: number): void {
    if (!running) return;
    raf = win.requestAnimationFrame(tick);

    if (presenceTick-- <= 0) {
      presenceTick = PRESENCE_POLL;
      refreshPresence();
    }

    if (!paused) {
      // Zero first: every source ORs into this. See input.ts.
      frameInput.fill(0);
      input.sample(frameInput);
      host.advance(nowMs, frameInput);
      pushAudio();
    }

    const fault = host.fault;
    if (fault !== null && fault.message !== reportedFault) {
      reportedFault = fault.message;
      shell.setStatus(
        fault.message === "deadline"
          ? "the cart stopped responding"
          : `fault: ${fault.message}`,
      );
    }

    // Only when the picture actually changed. Redrawing an unchanged frame is
    // pure heat on a display faster than the console.
    const confirmed = host.framesConfirmed;
    if (confirmed !== lastConfirmed) {
      const rgba = host.latestRgba;
      if (rgba !== null) {
        screen.present(rgba);
        lastConfirmed = confirmed;
      }
    }
  }

  function togglePause(): void {
    if (paused) api.resume();
    else api.pause();
  }

  const api: Player = {
    start(): void {
      if (running) return;
      running = true;
      relayout();
      armAudio();
      void host
        .load(opts.seed ?? 0)
        .then(() => {
          shell.setStatus("");
        })
        .catch((e: unknown) => {
          shell.setStatus(`fault: ${e instanceof Error ? e.message : String(e)}`);
        });
      raf = win.requestAnimationFrame(tick);
    },

    pause(): void {
      if (paused) return;
      paused = true;
      shell.setPaused(true);
      shell.setStatus("paused");
      // Buttons held when the game stopped must not still be held when it
      // starts again -- the player's hands have moved in between.
      keyboard.releaseAll();
      touch?.releaseAll();
      audio?.stop();
    },

    resume(): void {
      if (!paused) return;
      paused = false;
      shell.setPaused(false);
      shell.setStatus("");
      void audio?.start().catch(() => undefined);
    },

    stop(): void {
      running = false;
      if (raf !== 0) win.cancelAnimationFrame(raf);
      raf = 0;
      observer?.disconnect();
      win.removeEventListener("resize", onWindowResize);
      disarmAudio?.();
      keyboard.detach();
      gamepad.detach();
      touch?.detach();
      audio?.stop();
      host.terminate();
      shell.destroy();
    },

    snapshot(): Promise<Uint8Array> {
      return host.snapshot();
    },

    get frame(): number {
      return host.frame;
    },

    get framesConfirmed(): number {
      return host.framesConfirmed;
    },

    get paused(): boolean {
      return paused;
    },
  };

  relayout();
  return api;
}
