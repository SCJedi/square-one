/**
 * The main-thread driver.
 *
 * THE HOST OWNS THE CLOCK. The machine has no timer of its own and no way to
 * schedule work: every frame happens because `advance` decided one was due. A
 * console whose worker drove itself would produce a different number of frames
 * on a fast machine than on a slow one, and a replay recorded on either would be
 * wrong on the other -- so the clock lives here, in one place, in code that a
 * test can hand fake timestamps to.
 *
 * THE ACCUMULATOR AND ITS TWO CLAMPS. Real time arrives in irregular lumps, so
 * `advance` banks elapsed milliseconds and spends them one fixed step at a time:
 *
 *     dt   = min(now - last, MAX_DT)      // 1: a lump is worth at most 100 ms
 *     acc += dt
 *     while (acc >= stepMs && steps < maxCatchUp) { step; acc -= stepMs }   // 2
 *
 * Clamp 1 exists because a backgrounded tab returns after minutes, and an
 * unclamped `dt` would ask for tens of thousands of frames at once -- the tab
 * would freeze on the way back, which users read as a crash. Clamp 2 exists
 * because catching up is itself work: if the machine cannot keep up, running
 * more frames per wake-up makes it slower still, and the loop never exits. Both
 * clamps deliberately let the simulation fall behind wall-clock time rather than
 * let the frame loop become unbounded. A console that drops frames is playable;
 * one that death-spirals is not.
 *
 * TWO FRAMEBUFFERS, NOT ONE. Pixels move by transfer, not by copy, and a
 * transferred ArrayBuffer is DETACHED in the sender -- its byteLength becomes 0
 * and every view over it reads as empty. So a single shared buffer cannot work:
 * the instant the host posts it, the host cannot read it. Two buffers ping-pong
 * -- one in flight to the worker, one holding the frame currently on screen --
 * and `latestRgba` always points at the second. Every hand-off asserts the
 * buffer it received is live, because a detached buffer produces black pixels
 * rather than an exception, and silent black is the worst possible symptom.
 *
 * AUDIO COMES BACK THE SAME WAY PIXELS DO, and for the same reason: it is the
 * only route that exists when the cart is behind a real Worker. `latestAudio`
 * is the 80 register bytes of the most recent frame, copied out of the `frame`
 * reply into a buffer this host owns. Before this existed, a player could read
 * the register block only by holding the machine object -- which meant only by
 * running the cart on its own thread, which meant only by giving up Layer 2. A
 * player that has to choose between sound and a sandbox will choose sound.
 *
 * THE DEADLINE. A step that is not answered within `deadlineMs` is not a slow
 * frame, it is a cart that is never coming back -- most often `while (true) {}`,
 * which no code inside that thread can interrupt. The host therefore does the
 * only thing that works: it kills the channel, records a fault whose message is
 * "deadline", and waits to be told to `reload`. The deadline lives here, on the
 * side of the boundary that is still running, and it is driven by an injected
 * clock so every one of its cases is a test that does not sleep. See watchdog.ts
 * for why the mechanism is in two pieces.
 */

import { AUDIO_REGS_BYTES } from "./audio";
import type { FromWorker, ToWorker } from "./protocol";
import { createMessageHandler } from "./worker";
import { DEFAULT_DEADLINE_MS, systemClock, Watchdog } from "./watchdog";
import type { Clock } from "./watchdog";

/** Framebuffer geometry, as the RGBA staging buffers see it. */
const SCREEN_PIXELS = 128 * 128;

/** Bytes in one RGBA staging buffer. */
const RGBA_BYTES = SCREEN_PIXELS * 4;

/**
 * How many staging buffers the pool keeps. Two is the whole design: one in
 * flight, one presented. Bursts may allocate beyond this; the extras are
 * dropped on return rather than retained, so the steady state is exactly two.
 */
const POOL_MAX = 2;

/** The largest elapsed time one `advance` will honour, in milliseconds. */
const MAX_DT = 100;

/** The default step: 60 frames per second. */
const DEFAULT_STEP_MS = 1000 / 60;

/** The default catch-up limit, in steps per `advance`. */
const DEFAULT_MAX_CATCH_UP = 5;

/**
 * What the host needs from a machine, declared structurally.
 *
 * This is a shape, not an import of the machine class, so the driver, the
 * worker handler and every test can be written and run against a fake. The real
 * `Machine` satisfies it by having the right members, not by being told to.
 */
export interface MachineLike {
  /**
   * The full address space. The framebuffer is bytes 0x0000..0x1FFF: 128 x 128
   * pixels at 4 bits each, two pixels per byte, low nibble on the left.
   */
  readonly ram: Uint8Array;
  /** Presented pixels, 128 x 128, one packed RGBA word each. */
  readonly rgba: Uint32Array;
  /** Reset to the start of a run. */
  boot(seed: number): void;
  /** Advance exactly one frame with this frame's input. */
  tick(input: Uint8Array): void;
  /** Convert the framebuffer to `rgba`. Separate from `tick` so a headless run can skip it. */
  present(): void;
  /** A copy of everything a run needs to resume. */
  snapshot(): Uint8Array;
  /** Resume from a `snapshot`. */
  restore(snap: Uint8Array): void;
}

/**
 * A message channel to whatever is running the machine.
 *
 * Abstracting this is what lets one Host drive a real `Worker`, an in-process
 * machine in a Node test, and (later) a machine in a different realm. The
 * conformance run and the shipping player then differ in exactly one object.
 */
export interface Channel {
  post(msg: ToWorker, transfer?: Transferable[]): void;
  onMessage(cb: (m: FromWorker) => void): void;
  terminate(): void;
}

/**
 * Clone a message the way `postMessage` would, honouring `transfer` so the
 * sender's buffers are genuinely detached.
 *
 * The in-process channel could simply pass the object through, and that would
 * be faster and wrong: the detach semantics are the part of the Worker boundary
 * most likely to be got wrong in host code, so the in-process path reproduces
 * them exactly. A bug that only appears with a real Worker is a bug that only
 * appears in the browser, which is where it is hardest to see.
 */
function cloneAcross<T>(msg: T, transfer?: Transferable[]): T {
  if (typeof structuredClone !== "function") return msg;
  return transfer !== undefined && transfer.length > 0
    ? structuredClone(msg, { transfer })
    : structuredClone(msg);
}

/**
 * Run the machine on this thread, behind the same message protocol a Worker
 * uses. Replies are delivered synchronously, during `post`.
 */
export function inProcessChannel(machine: MachineLike): Channel {
  let cb: ((m: FromWorker) => void) | null = null;
  let alive = true;

  const handler = createMessageHandler(
    () => machine,
    (m, transfer) => {
      if (!alive) return;
      const delivered = cloneAcross(m, transfer);
      if (cb !== null) cb(delivered);
    },
  );

  return {
    post(msg: ToWorker, transfer?: Transferable[]): void {
      if (!alive) return;
      handler(cloneAcross(msg, transfer));
    },
    onMessage(f: (m: FromWorker) => void): void {
      cb = f;
    },
    terminate(): void {
      alive = false;
      cb = null;
    },
  };
}

/** Drive a real dedicated Worker. */
export function workerChannel(w: Worker): Channel {
  return {
    post(msg: ToWorker, transfer?: Transferable[]): void {
      if (transfer !== undefined && transfer.length > 0) w.postMessage(msg, transfer);
      else w.postMessage(msg);
    },
    onMessage(cb: (m: FromWorker) => void): void {
      w.onmessage = (e: MessageEvent) => cb(e.data as FromWorker);
    },
    terminate(): void {
      w.onmessage = null;
      w.terminate();
    },
  };
}

/** Tuning for {@link Host}. Every option has a default that matches the console spec. */
export interface HostOptions {
  /** Milliseconds of simulated time per frame. Default 1000/60. */
  stepMs?: number;
  /** Most steps one `advance` will run. Default 5. */
  maxCatchUp?: number;
  /**
   * How long a posted `step` may go unanswered before the run is declared
   * stuck, in milliseconds. Default 12, the spec's per-frame budget.
   */
  deadlineMs?: number;
  /**
   * Where the deadline's notion of time comes from. Default: real timers. A
   * test injects a manual clock and never sleeps.
   */
  clock?: Clock;
  /**
   * Build a replacement channel, for `reload` after the deadline killed the old
   * one. A terminated Worker cannot be restarted -- recovery is a NEW worker --
   * so recovery is possible only for a host that was told how to make one.
   */
  respawn?: () => Channel;
}

/**
 * A fault that stopped the run, kept for the host to show or log.
 *
 * `message` is "deadline" exactly when the watchdog fired: the cart never
 * answered, so there is no thrown value to report and nothing more specific
 * that could honestly be said.
 */
export interface HostFault {
  phase: "load" | "boot" | "tick";
  frame?: number;
  message: string;
}

/** The main-thread driver: owns the clock, the staging buffers and the frame counter. */
export class Host {
  #ch: Channel;
  readonly #stepMs: number;
  readonly #maxCatchUp: number;
  readonly #watchdog: Watchdog;
  readonly #respawn: (() => Channel) | null;
  /** False once the channel has been terminated, by the deadline or by `terminate`. */
  #channelLive = true;

  /** Unspent simulated time, in milliseconds. */
  #acc = 0;
  /** Timestamp of the previous `advance`, or null before the first one. */
  #last: number | null = null;
  /** Frames issued. Also the frame number the next `step` will carry. */
  #frame = 0;
  /** Frames the worker has answered. */
  #confirmed = 0;

  #loaded = false;
  #fault: HostFault | null = null;

  /** Free staging buffers. */
  readonly #pool: ArrayBuffer[] = [];
  /** Frame numbers posted and not yet answered, oldest first. */
  readonly #inFlight: number[] = [];
  /** The buffer `#latest` views. Held until the next frame replaces it. */
  #presented: ArrayBuffer | null = null;
  #latest: Uint32Array | null = null;
  /**
   * The most recent frame's audio registers, in a buffer this host owns.
   *
   * Allocated once and overwritten per frame. The message's own array is a
   * fresh clone every time, and handing that out would leak one 80-byte object
   * per frame into whatever the caller does with it; copying into a stable
   * array keeps the mixer's input at one allocation for the life of the host.
   */
  readonly #audio = new Uint8Array(AUDIO_REGS_BYTES);
  /** False until the first `frame` reply lands, so `latestAudio` can say "no frame yet". */
  #audioSeen = false;
  /** Wall-clock cost the worker reported for the most recent frame. */
  #lastTookMs = 0;
  /** Staging buffers ever allocated. Diagnostic: it must stop rising after warm-up. */
  #allocated = 0;

  #pendingLoad: { resolve: () => void; reject: (e: Error) => void } | null = null;
  #pendingSnapshot: { resolve: (r: Uint8Array) => void; reject: (e: Error) => void } | null = null;

  constructor(ch: Channel, opts?: HostOptions) {
    this.#ch = ch;
    this.#stepMs = opts?.stepMs ?? DEFAULT_STEP_MS;
    this.#maxCatchUp = opts?.maxCatchUp ?? DEFAULT_MAX_CATCH_UP;
    this.#respawn = opts?.respawn ?? null;
    this.#watchdog = new Watchdog(opts?.clock ?? systemClock, opts?.deadlineMs ?? DEFAULT_DEADLINE_MS);
    if (!(this.#stepMs > 0)) throw new Error(`Host: stepMs must be positive, got ${this.#stepMs}`);
    if (!(this.#maxCatchUp >= 1)) {
      throw new Error(`Host: maxCatchUp must be at least 1, got ${this.#maxCatchUp}`);
    }
    for (let i = 0; i < POOL_MAX; i++) {
      this.#pool.push(new ArrayBuffer(RGBA_BYTES));
      this.#allocated++;
    }
    this.#ch.onMessage((m) => this.#onMessage(m));
  }

  /** Frames issued so far; the frame number the next `step` will carry. */
  get frame(): number {
    return this.#frame;
  }

  /** Frames the worker has answered. Equals `frame` once every reply is in. */
  get framesConfirmed(): number {
    return this.#confirmed;
  }

  /**
   * The most recently presented frame, as 128*128 packed RGBA words, or null
   * before the first frame arrives.
   *
   * The view stays valid until the frame after next: it is backed by the
   * presented buffer, which is not returned to the pool until a newer frame
   * takes its place. Callers that keep it across frames should copy.
   */
  get latestRgba(): Uint32Array | null {
    if (this.#latest !== null && this.#latest.length !== SCREEN_PIXELS) {
      throw new Error("Host: latestRgba is backed by a detached buffer");
    }
    return this.#latest;
  }

  /** Wall-clock milliseconds the worker spent on the most recent frame. Diagnostic only. */
  get lastTookMs(): number {
    return this.#lastTookMs;
  }

  /**
   * The most recent frame's audio registers -- `AUDIO_REGS_BYTES` of them --
   * or null before the first frame arrives.
   *
   * This is what a mixer is given, and it is the whole of what a mixer may
   * ever see. It is a COPY: the machine cannot be reached through it and
   * writing to it changes nothing, which is the one-way street audio.ts
   * describes, enforced by the shape of the API rather than by a convention.
   *
   * The array is reused, so its CONTENTS are only valid until the next frame
   * lands. A caller that keeps it across frames must copy -- but the mixer does
   * not: `AudioGraph.push` copies on the way in, so the intended use is to hand
   * this straight over and forget it.
   */
  get latestAudio(): Uint8Array | null {
    return this.#audioSeen ? this.#audio : null;
  }

  /**
   * How many 64 KiB staging buffers this host has ever allocated.
   *
   * Object identity cannot answer "is it reusing them?": a transfer hands the
   * receiver a NEW ArrayBuffer object over the SAME memory, so every hop looks
   * like a different buffer even though nothing was copied. This counter is the
   * observable that matters -- it should reach two and stay there.
   */
  get buffersAllocated(): number {
    return this.#allocated;
  }

  /** The fault that stopped the run, or null. */
  get fault(): HostFault | null {
    return this.#fault;
  }

  /** Has a `load` completed with no fault since? */
  get loaded(): boolean {
    return this.#loaded;
  }

  /** How long a step may go unanswered before the run is declared stuck. */
  get deadlineMs(): number {
    return this.#watchdog.deadlineMs;
  }

  /** Is a deadline currently running? True exactly while a step is unanswered. */
  get deadlineArmed(): boolean {
    return this.#watchdog.armed;
  }

  /** Is the channel still usable? False once the deadline or `terminate` killed it. */
  get channelLive(): boolean {
    return this.#channelLive;
  }

  /**
   * Boot the machine and wait for it to report ready.
   *
   * Resets the clock and the frame counter, so a reload starts a genuinely new
   * run rather than inheriting the previous one's accumulated time.
   */
  load(seed: number): Promise<void> {
    if (!this.#channelLive) {
      return Promise.reject(
        new Error(
          "Host: load after the channel was terminated. A terminated worker cannot be " +
            "restarted; call reload(seed) on a host built with a `respawn` option.",
        ),
      );
    }
    this.#watchdog.disarm();
    this.#loaded = false;
    this.#fault = null;
    this.#acc = 0;
    this.#last = null;
    this.#frame = 0;
    this.#confirmed = 0;
    this.#inFlight.length = 0;
    // A new run starts silent. Registers left over from the previous one would
    // otherwise hold a note straight through the reload -- the picture may
    // safely linger for a frame, but a sound cannot.
    this.#audioSeen = false;
    this.#audio.fill(0);
    return new Promise<void>((resolve, reject) => {
      // Set the pending record BEFORE posting: the in-process channel replies
      // synchronously from inside `post`, so a reply can arrive before `post`
      // returns.
      this.#pendingLoad = { resolve, reject };
      this.#ch.post({ t: "load", seed });
    });
  }

  /**
   * Recover from a fault: get a live channel, then boot again.
   *
   * This is the other half of the watchdog. Stopping a stuck cart costs the
   * worker its life -- terminate is the only thing that interrupts a
   * synchronous loop -- so recovery cannot mean "carry on", it means a fresh
   * worker and a fresh run. `respawn` is what makes the fresh one; without it a
   * host can still detect the fault and report it, it simply cannot come back.
   *
   * Safe to call when nothing died: then it is exactly `load`.
   */
  async reload(seed: number): Promise<void> {
    if (!this.#channelLive) {
      const respawn = this.#respawn;
      if (respawn === null) {
        throw new Error(
          "Host: cannot reload, because the channel is terminated and this host was built " +
            "without a `respawn` option. Pass one to recover from a deadline fault.",
        );
      }
      this.#ch = respawn();
      this.#channelLive = true;
      this.#ch.onMessage((m) => this.#onMessage(m));
    }
    this.#fault = null;
    await this.load(seed);
  }

  /**
   * Spend elapsed real time as whole frames.
   *
   * @param nowMs a monotonic clock reading, typically `performance.now()`
   * @param input this frame's input bytes; copied on the way out, so the caller
   *   may reuse the array
   * @returns how many steps were issued
   */
  advance(nowMs: number, input: Uint8Array): number {
    if (this.#fault !== null) return 0;
    if (!this.#loaded) {
      // Not booted yet. Re-baseline the clock so the first real advance does not
      // charge the run for however long loading took.
      this.#last = nowMs;
      return 0;
    }
    if (this.#last === null) {
      this.#last = nowMs;
      return 0;
    }

    const dt = Math.min(nowMs - this.#last, MAX_DT);
    this.#last = nowMs;
    if (dt > 0) this.#acc += dt;

    let steps = 0;
    while (this.#acc >= this.#stepMs && steps < this.#maxCatchUp) {
      this.#step(input);
      this.#acc -= this.#stepMs;
      steps++;
    }
    return steps;
  }

  /**
   * Issue exactly one step, ignoring the clock.
   *
   * This is how a conformance run is driven: a golden case is N frames, not N
   * frames' worth of wall-clock time, and letting real time decide would make
   * the hash chain depend on how busy the machine was.
   */
  stepOnce(input: Uint8Array): void {
    if (this.#fault !== null) throw new Error(`Host: cannot step after a fault: ${this.#fault.message}`);
    if (!this.#loaded) throw new Error("Host: stepOnce before load");
    this.#step(input);
  }

  /** Ask the worker for a copy of machine RAM. */
  snapshot(): Promise<Uint8Array> {
    return new Promise<Uint8Array>((resolve, reject) => {
      this.#pendingSnapshot = { resolve, reject };
      this.#ch.post({ t: "snapshot" });
    });
  }

  /**
   * Replace machine RAM and wait for ready. The clock resets; the frame counter
   * does not, because the frame number is the host's own bookkeeping and a
   * restore mid-run should not renumber the frames already recorded.
   */
  restore(ram: Uint8Array): Promise<void> {
    const copy = ram.slice();
    this.#acc = 0;
    this.#last = null;
    return new Promise<void>((resolve, reject) => {
      this.#pendingLoad = { resolve, reject };
      this.#ch.post({ t: "restore", ram: copy.buffer as ArrayBuffer }, [copy.buffer as ArrayBuffer]);
    });
  }

  /** Shut the channel down. Pending promises reject. */
  terminate(): void {
    const err = new Error("Host: terminated");
    this.#pendingLoad?.reject(err);
    this.#pendingSnapshot?.reject(err);
    this.#pendingLoad = null;
    this.#pendingSnapshot = null;
    this.#loaded = false;
    this.#kill();
  }

  /**
   * Terminate the channel at most once.
   *
   * Twice would be a real bug, not a harmless repeat: `Worker.terminate` on an
   * already-dead worker is fine, but a second call from a path that believed it
   * was the first means the host lost track of what is alive, and the next thing
   * it does is post to a corpse and wait forever for the reply.
   */
  #kill(): void {
    if (!this.#channelLive) return;
    this.#channelLive = false;
    this.#watchdog.disarm();
    this.#ch.terminate();
  }

  /** Post one step with a live staging buffer, then start its deadline. */
  #step(input: Uint8Array): void {
    const out = this.#take();
    const frame = this.#frame;
    this.#frame++;
    this.#inFlight.push(frame);
    this.#ch.post({ t: "step", frame, input, out }, [out]);
    // AFTER the post, and only if the reply has not already landed. The
    // in-process channel answers synchronously from inside `post`, so arming
    // first would start a deadline for a frame that is already done -- and the
    // conformance run, which drives thousands of frames that way, would arm and
    // cancel a timer for every one of them.
    this.#armDeadline();
  }

  /** Start a deadline if a step is outstanding and none is running. */
  #armDeadline(): void {
    if (this.#inFlight.length === 0) return;
    this.#watchdog.arm(() => this.#onDeadline());
  }

  /**
   * A step went unanswered. The cart is not slow, it is gone.
   *
   * Killing the channel is not a choice between options: a synchronous loop
   * cannot be interrupted any other way, and the worker holds the staging buffer
   * that was transferred to it, which dies with it. The pool allocates a
   * replacement on demand, which is why `buffersAllocated` may rise by one per
   * fault and is not evidence of a leak.
   */
  #onDeadline(): void {
    if (this.#fault !== null) return;
    const frame = this.#inFlight[0];
    this.#kill();
    this.#raiseFault(
      frame === undefined
        ? { phase: "tick", message: "deadline" }
        : { phase: "tick", frame, message: "deadline" },
    );
  }

  /** A live staging buffer, from the pool or freshly allocated. */
  #take(): ArrayBuffer {
    const b = this.#pool.pop();
    if (b === undefined) {
      this.#allocated++;
      return new ArrayBuffer(RGBA_BYTES);
    }
    this.#assertLive(b, "a pooled staging buffer");
    return b;
  }

  /** Return a staging buffer, keeping the pool at its ping-pong size. */
  #release(b: ArrayBuffer): void {
    this.#assertLive(b, "a released staging buffer");
    if (this.#pool.length < POOL_MAX) this.#pool.push(b);
  }

  /**
   * Throw unless `b` is a staging buffer of the expected size.
   *
   * A detached ArrayBuffer has byteLength 0 and reads as zeros rather than
   * throwing, so without this check a transfer bug shows up as a black screen
   * and a passing test. The check is two comparisons per frame; the failure it
   * catches would cost a day.
   */
  #assertLive(b: ArrayBuffer, what: string): void {
    if (b.byteLength !== RGBA_BYTES) {
      throw new Error(
        `Host: ${what} is ${b.byteLength} bytes, expected ${RGBA_BYTES}` +
          (b.byteLength === 0 ? " (detached: it was transferred and not handed back)" : ""),
      );
    }
  }

  /**
   * Copy a frame's audio registers into the host's own buffer.
   *
   * Length-tolerant on purpose, and quietly so. Audio is non-normative: a
   * channel that delivered a short or absent block is a channel that produced
   * the wrong SOUND, and refusing the frame over it would turn a mixing defect
   * into a dead console. A short block is zero-filled to the end, which is
   * silence, and `renderAudio` treats a short one as silence too -- so the two
   * halves of the boundary already agree on what "not enough registers" means.
   */
  #takeAudio(regs: Uint8Array | undefined): void {
    const src = regs ?? null;
    const n = src === null ? 0 : Math.min(src.length, AUDIO_REGS_BYTES);
    for (let i = 0; i < n; i++) this.#audio[i] = (src as Uint8Array)[i] as number;
    for (let i = n; i < AUDIO_REGS_BYTES; i++) this.#audio[i] = 0;
    this.#audioSeen = true;
  }

  #onMessage(m: FromWorker): void {
    switch (m.t) {
      case "ready": {
        this.#loaded = true;
        this.#fault = null;
        const p = this.#pendingLoad;
        this.#pendingLoad = null;
        p?.resolve();
        return;
      }

      case "frame": {
        const expected = this.#inFlight.shift();
        if (expected !== m.frame) {
          throw new Error(`Host: frame ${m.frame} arrived out of order, expected ${expected}`);
        }
        this.#assertLive(m.out, `the buffer returned for frame ${m.frame}`);
        this.#confirmed++;
        this.#lastTookMs = m.tookMs;
        this.#takeAudio(m.audio);
        // This frame answered, so its deadline is spent. Anything still in
        // flight gets a fresh one: each step is judged on its own time, not on
        // however long the queue in front of it took.
        this.#watchdog.disarm();
        this.#armDeadline();
        // Retire the previous frame only now: `latestRgba` handed out for it
        // stays readable until this point, which is what makes the two-buffer
        // ping-pong safe for a caller that renders asynchronously.
        if (this.#presented !== null) this.#release(this.#presented);
        this.#presented = m.out;
        this.#latest = new Uint32Array(m.out);
        return;
      }

      case "snapshot": {
        const p = this.#pendingSnapshot;
        this.#pendingSnapshot = null;
        p?.resolve(new Uint8Array(m.ram));
        return;
      }

      case "fault": {
        this.#raiseFault(
          m.frame === undefined
            ? { phase: m.phase, message: m.message }
            : { phase: m.phase, frame: m.frame, message: m.message },
        );
        return;
      }

      default: {
        const never: never = m;
        throw new Error(`Host: unknown message ${JSON.stringify(never)}`);
      }
    }
  }

  /**
   * Record a fault and settle everything waiting on the run.
   *
   * One path for a fault the worker reported and a fault the host declared,
   * because a caller must not be able to tell them apart by how the host
   * behaves afterwards: both are terminal, both stop the clock, and both leave
   * exactly one thing to do next, which is `reload`.
   */
  #raiseFault(fault: HostFault): void {
    this.#fault = fault;
    this.#loaded = false;
    this.#inFlight.length = 0;
    this.#watchdog.disarm();
    const err = new Error(
      `Square One fault during ${fault.phase}` +
        (fault.frame === undefined ? "" : ` at frame ${fault.frame}`) +
        `: ${fault.message}`,
    );
    const pl = this.#pendingLoad;
    const ps = this.#pendingSnapshot;
    this.#pendingLoad = null;
    this.#pendingSnapshot = null;
    pl?.reject(err);
    ps?.reject(err);
  }
}
