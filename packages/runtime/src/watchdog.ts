/**
 * The runtime watchdog: how a cart that stops answering is stopped.
 *
 * WHY THIS IS TWO PIECES AND NOT ONE
 * ----------------------------------
 * A synchronous infinite loop in JavaScript cannot be interrupted from inside
 * its own thread. There is no yield point in `while (true) {}` -- no timer
 * fires, no message is delivered, no flag is read -- so a watchdog that lived in
 * the same thread as the cart would be the one thing guaranteed never to run.
 * The only thing that stops it is terminating the thread from outside.
 *
 * So the mechanism splits cleanly in two, and conflating them is the classic
 * mistake:
 *
 *   A. THE DEADLINE, on the host thread. Post a `step`, start a timer, and if no
 *      `frame` comes back in time, declare the run faulted and kill the channel.
 *      This is ordinary bookkeeping over a clock -- no threads, no races -- and
 *      it is what {@link Watchdog} is. Because the clock is injected, every one
 *      of its behaviours is testable without a real timer and therefore without
 *      a test that sleeps. A test that sleeps is a test that fails on a loaded
 *      CI box for reasons that have nothing to do with the code.
 *
 *   B. THE KILL, in the channel. `Channel.terminate()` has to genuinely stop a
 *      genuinely stuck worker. Nothing in this file can prove that; only running
 *      a real Worker can, which is what the integration test does.
 *
 * WHY THE CLOCK IS AN INTERFACE
 * -----------------------------
 * `setTimeout` is a global whose behaviour under test is either real time (slow
 * and flaky) or a framework's fake timers (a global mutation that leaks between
 * tests). An injected clock is neither: the manual clock below is an ordinary
 * object, it is created per test, and "3 ms before the deadline" and "1 ms after
 * it" are two exact, repeatable states rather than two races.
 */

/** Whatever the clock's `setTimer` hands back. Opaque to every caller. */
export type TimerId = number;

/**
 * The two things a deadline needs from the world: what time it is, and a way to
 * be woken later. Nothing else, so a fake is four short methods.
 */
export interface Clock {
  /** A monotonic reading, in milliseconds. */
  now(): number;
  /** Call `fn` no earlier than `delayMs` from now. */
  setTimer(delayMs: number, fn: () => void): TimerId;
  /** Cancel a timer. Cancelling one that already fired, or twice, does nothing. */
  clearTimer(id: TimerId): void;
}

/** `performance.now()` where it exists, `Date.now()` otherwise. Diagnostic-grade either way. */
const nowMs: () => number =
  typeof performance !== "undefined" && typeof performance.now === "function"
    ? () => performance.now()
    : () => Date.now();

/**
 * The real clock: `setTimeout` and a monotonic reading.
 *
 * This is the only place in the runtime that schedules anything, and it lives on
 * the HOST side of the boundary. The machine still has no timer of its own: a
 * deadline decides how long the host waits, and never how many frames happen.
 */
export const systemClock: Clock = {
  now: nowMs,
  setTimer(delayMs: number, fn: () => void): TimerId {
    return setTimeout(fn, delayMs) as unknown as TimerId;
  },
  clearTimer(id: TimerId): void {
    clearTimeout(id as unknown as ReturnType<typeof setTimeout>);
  },
};

/**
 * A clock that only moves when a test moves it.
 *
 * Timers fire in due order, and `now()` is set to each timer's due time before
 * its callback runs -- so a timer armed from inside a callback measures its
 * delay from when it was due, exactly as a real one would, rather than from
 * wherever the test was heading.
 */
export class ManualClock implements Clock {
  #now: number;
  #next: TimerId = 1;
  readonly #timers = new Map<TimerId, { at: number; fn: () => void }>();

  constructor(startMs = 0) {
    this.#now = startMs;
  }

  now(): number {
    return this.#now;
  }

  setTimer(delayMs: number, fn: () => void): TimerId {
    const id = this.#next++;
    this.#timers.set(id, { at: this.#now + delayMs, fn });
    return id;
  }

  clearTimer(id: TimerId): void {
    this.#timers.delete(id);
  }

  /** Timers armed and not yet fired or cancelled. A leak shows up here. */
  get pending(): number {
    return this.#timers.size;
  }

  /** Move time to `t`, firing everything due at or before it. */
  advanceTo(t: number): void {
    for (;;) {
      let dueId: TimerId | null = null;
      let dueAt = Infinity;
      for (const [id, timer] of this.#timers) {
        if (timer.at <= t && timer.at < dueAt) {
          dueAt = timer.at;
          dueId = id;
        }
      }
      if (dueId === null) {
        if (t > this.#now) this.#now = t;
        return;
      }
      const timer = this.#timers.get(dueId) as { at: number; fn: () => void };
      this.#timers.delete(dueId);
      this.#now = timer.at;
      timer.fn();
    }
  }

  /** Move time forward by `ms`, firing everything that becomes due. */
  advance(ms: number): void {
    this.advanceTo(this.#now + ms);
  }
}

/**
 * The spec's per-frame budget, in milliseconds: a frame that has not answered in
 * this long is not late, it is stuck.
 *
 * 12 ms is deliberately under the 16.6 ms a 60 Hz frame is worth. A cart that
 * cannot finish inside it is already failing to hold the frame rate, and the
 * console would rather stop a runaway cart one frame early than let a browser
 * tab lock up -- which the player reads as the console crashing, not the cart.
 */
export const DEFAULT_DEADLINE_MS = 12;

/**
 * One deadline at a time.
 *
 * `arm` on an already-armed watchdog does nothing, so a caller that arms
 * defensively cannot accidentally extend a deadline that is already running;
 * `restart` is the explicit way to begin a new one. The expiry callback is
 * handed to `arm` rather than to the constructor so the watchdog carries no
 * state about what it is watching.
 */
export class Watchdog {
  readonly #clock: Clock;
  readonly #deadlineMs: number;
  #timer: TimerId | null = null;
  /** Deadlines that have expired. Diagnostic, and what "exactly once" is checked against. */
  #expiries = 0;

  constructor(clock: Clock = systemClock, deadlineMs: number = DEFAULT_DEADLINE_MS) {
    if (!(deadlineMs > 0)) {
      throw new Error(`Watchdog: deadlineMs must be positive, got ${deadlineMs}`);
    }
    this.#clock = clock;
    this.#deadlineMs = deadlineMs;
  }

  get deadlineMs(): number {
    return this.#deadlineMs;
  }

  get armed(): boolean {
    return this.#timer !== null;
  }

  get expiries(): number {
    return this.#expiries;
  }

  /** Start a deadline, unless one is already running. */
  arm(onExpire: () => void): void {
    if (this.#timer !== null) return;
    this.#timer = this.#clock.setTimer(this.#deadlineMs, () => {
      // Disarm BEFORE the callback: the handler is entitled to arm the next
      // deadline, and it must not be refused by the one that just fired.
      this.#timer = null;
      this.#expiries++;
      onExpire();
    });
  }

  /** Cancel the running deadline, if any. */
  disarm(): void {
    if (this.#timer === null) return;
    this.#clock.clearTimer(this.#timer);
    this.#timer = null;
  }

  /** Cancel whatever was running and start a fresh deadline. */
  restart(onExpire: () => void): void {
    this.disarm();
    this.arm(onExpire);
  }
}
