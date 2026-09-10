import { describe, it, expect } from "vitest";

import { Host, type Channel } from "../src/host";
import type { FromWorker, ToWorker } from "../src/protocol";
import { DEFAULT_DEADLINE_MS, ManualClock, Watchdog, systemClock } from "../src/watchdog";

/*
 * THE WATCHDOG, IN ITS TWO SEPARABLE PIECES.
 *
 * Piece A is everything below except the last describe: the host's deadline
 * logic, driven by a channel that never answers and a clock the test moves by
 * hand. No threads, no sleeping, no real timers -- "one millisecond before the
 * deadline" and "one millisecond after it" are two exact states rather than two
 * races, so these tests mean the same thing on an idle laptop and on a CI box
 * running eight jobs at once.
 *
 * Piece B is the last describe: one real `node:worker_threads` Worker running a
 * cart whose tick is `while (true) {}`. It is the only test here that can prove
 * the thing Piece A assumes -- that terminating a worker genuinely stops a
 * genuinely stuck loop -- and it is the only one that uses real time, because
 * the acceptance criterion is itself a wall-clock claim.
 */

const RGBA_BYTES = 128 * 128 * 4;
const input = (k = 0): Uint8Array => new Uint8Array([k, 0, 0, 0]);

/**
 * A channel that boots instantly and then answers a step only when the test
 * says so. This is a worker stuck in `tick`, with the stuck part removed: from
 * the host's side, "looping forever" and "not replying" are the same event.
 */
class FakeChannel implements Channel {
  #cb: ((m: FromWorker) => void) | null = null;
  /** Steps posted and not yet answered, oldest first. */
  readonly outstanding: { frame: number; out: ArrayBuffer }[] = [];
  terminations = 0;
  posts = 0;

  post(msg: ToWorker): void {
    this.posts++;
    if (msg.t === "load" || msg.t === "restore") {
      this.#cb?.({ t: "ready" });
      return;
    }
    if (msg.t === "step") this.outstanding.push({ frame: msg.frame, out: msg.out });
  }

  onMessage(cb: (m: FromWorker) => void): void {
    this.#cb = cb;
  }

  terminate(): void {
    this.terminations++;
  }

  /** Answer the oldest outstanding step, the way a worker that finished would. */
  answer(): void {
    const s = this.outstanding.shift();
    if (s === undefined) throw new Error("FakeChannel: nothing to answer");
    this.#cb?.({ t: "frame", frame: s.frame, out: s.out, tookMs: 1 });
  }
}

/** A loaded host over a stalled channel and a hand-driven clock. */
async function stalled(deadlineMs = 12) {
  const ch = new FakeChannel();
  const clock = new ManualClock();
  const host = new Host(ch, { deadlineMs, clock });
  await host.load(1);
  return { ch, clock, host };
}

describe("ManualClock", () => {
  it("fires a timer when time reaches it, and not before", () => {
    const c = new ManualClock();
    let fired = 0;
    c.setTimer(10, () => fired++);
    c.advance(9);
    expect(fired).toBe(0);
    c.advance(1);
    expect(fired).toBe(1);
    expect(c.now()).toBe(10);
  });

  it("fires timers in due order and sets now() to each due time", () => {
    const c = new ManualClock();
    const seen: number[] = [];
    c.setTimer(30, () => seen.push(c.now()));
    c.setTimer(10, () => seen.push(c.now()));
    c.setTimer(20, () => seen.push(c.now()));
    c.advance(100);
    expect(seen).toEqual([10, 20, 30]);
    expect(c.now()).toBe(100);
  });

  it("measures a timer armed inside a callback from when that callback was due", () => {
    const c = new ManualClock();
    let inner = -1;
    c.setTimer(10, () => {
      c.setTimer(5, () => {
        inner = c.now();
      });
    });
    c.advance(100);
    expect(inner).toBe(15);
  });

  it("forgets a cancelled timer", () => {
    const c = new ManualClock();
    let fired = 0;
    const id = c.setTimer(10, () => fired++);
    c.clearTimer(id);
    expect(c.pending).toBe(0);
    c.advance(100);
    expect(fired).toBe(0);
  });
});

describe("Watchdog", () => {
  it("arms, expires once, and reports itself disarmed afterwards", () => {
    const c = new ManualClock();
    const w = new Watchdog(c, 12);
    let expired = 0;
    w.arm(() => expired++);
    expect(w.armed).toBe(true);
    c.advance(12);
    expect(expired).toBe(1);
    expect(w.armed).toBe(false);
    expect(w.expiries).toBe(1);
    c.advance(1000);
    expect(expired).toBe(1);
  });

  it("does not extend a running deadline when armed again", () => {
    const c = new ManualClock();
    const w = new Watchdog(c, 12);
    let expired = 0;
    w.arm(() => expired++);
    c.advance(6);
    w.arm(() => expired++); // must not push the deadline out to 18
    c.advance(6);
    expect(expired).toBe(1);
  });

  it("restart begins a fresh deadline", () => {
    const c = new ManualClock();
    const w = new Watchdog(c, 12);
    let expired = 0;
    w.restart(() => expired++);
    c.advance(6);
    w.restart(() => expired++);
    c.advance(11);
    expect(expired).toBe(0);
    c.advance(1);
    expect(expired).toBe(1);
  });

  it("leaves nothing pending after disarm", () => {
    const c = new ManualClock();
    const w = new Watchdog(c, 12);
    w.arm(() => {
      throw new Error("must not fire");
    });
    w.disarm();
    expect(c.pending).toBe(0);
    expect(w.armed).toBe(false);
    c.advance(1000);
  });

  it("refuses a deadline that is not a positive number of milliseconds", () => {
    expect(() => new Watchdog(new ManualClock(), 0)).toThrow(/must be positive/);
    expect(() => new Watchdog(new ManualClock(), -1)).toThrow(/must be positive/);
    expect(() => new Watchdog(new ManualClock(), Number.NaN)).toThrow(/must be positive/);
  });

  it("defaults to the real clock and the spec's 12 ms budget", () => {
    const w = new Watchdog();
    expect(w.deadlineMs).toBe(DEFAULT_DEADLINE_MS);
    expect(DEFAULT_DEADLINE_MS).toBe(12);
    expect(typeof systemClock.now()).toBe("number");
  });
});

describe("Host - the deadline (no threads, no real timers)", () => {
  it("defaults to a 12 ms deadline", async () => {
    const { host } = await stalled(DEFAULT_DEADLINE_MS);
    expect(host.deadlineMs).toBe(12);
  });

  it("faults with message \"deadline\" when a step goes unanswered", async () => {
    const { ch, clock, host } = await stalled();
    host.stepOnce(input());
    expect(host.deadlineArmed).toBe(true);
    expect(host.fault).toBeNull();

    clock.advance(12);

    expect(host.fault).toEqual({ phase: "tick", frame: 0, message: "deadline" });
    expect(host.loaded).toBe(false);
    expect(host.deadlineArmed).toBe(false);
    expect(ch.terminations).toBe(1);
    expect(host.channelLive).toBe(false);
  });

  it("does not fault when the reply lands just under the deadline", async () => {
    const { ch, clock, host } = await stalled();
    host.stepOnce(input());
    clock.advance(11);
    ch.answer();
    clock.advance(1000);
    expect(host.fault).toBeNull();
    expect(host.framesConfirmed).toBe(1);
    expect(ch.terminations).toBe(0);
    expect(host.deadlineArmed).toBe(false);
    expect(clock.pending).toBe(0);
  });

  it("gives each outstanding step its own deadline", async () => {
    const { ch, clock, host } = await stalled();
    host.stepOnce(input());
    host.stepOnce(input());
    clock.advance(11);
    ch.answer(); // frame 0 lands at 11 ms; frame 1's clock starts there
    clock.advance(11);
    expect(host.fault).toBeNull();
    clock.advance(1);
    expect(host.fault).toEqual({ phase: "tick", frame: 1, message: "deadline" });
  });

  it("terminates the channel exactly once, however long the clock runs on", async () => {
    const { ch, clock, host } = await stalled();
    host.stepOnce(input());
    clock.advance(1000);
    expect(ch.terminations).toBe(1);
    host.terminate(); // the owner shutting down a host that already died
    expect(ch.terminations).toBe(1);
  });

  it("refuses a second step after the deadline fault", async () => {
    const { clock, host } = await stalled();
    host.stepOnce(input());
    clock.advance(12);
    expect(() => host.stepOnce(input())).toThrow(/cannot step after a fault: deadline/);
    expect(host.advance(1e6, input())).toBe(0);
  });

  it("rejects a load on the terminated channel, and says to reload instead", async () => {
    const { clock, host } = await stalled();
    host.stepOnce(input());
    clock.advance(12);
    await expect(host.load(1)).rejects.toThrow(/reload\(seed\)/);
  });

  it("cannot reload without a respawn, and says exactly what is missing", async () => {
    const { clock, host } = await stalled();
    host.stepOnce(input());
    clock.advance(12);
    await expect(host.reload(1)).rejects.toThrow(/without a `respawn` option/);
  });

  it("recovers on reload: a fresh channel, no fault, and frames flowing again", async () => {
    const first = new FakeChannel();
    const spawned: FakeChannel[] = [];
    const clock = new ManualClock();
    const host = new Host(first, {
      deadlineMs: 12,
      clock,
      respawn: () => {
        const ch = new FakeChannel();
        spawned.push(ch);
        return ch;
      },
    });
    await host.load(1);
    host.stepOnce(input());
    clock.advance(12);
    expect(host.fault?.message).toBe("deadline");

    await host.reload(7);

    expect(host.fault).toBeNull();
    expect(host.loaded).toBe(true);
    expect(host.channelLive).toBe(true);
    expect(host.frame).toBe(0);
    expect(host.framesConfirmed).toBe(0);
    expect(spawned).toHaveLength(1);

    const fresh = spawned[0] as FakeChannel;
    host.stepOnce(input(3));
    fresh.answer();
    expect(host.framesConfirmed).toBe(1);
    expect(host.latestRgba?.length).toBe(RGBA_BYTES / 4);

    // And the recovered host is still watched: the next stall faults too.
    host.stepOnce(input());
    clock.advance(12);
    expect(host.fault).toEqual({ phase: "tick", frame: 1, message: "deadline" });
    expect(fresh.terminations).toBe(1);
    expect(first.terminations).toBe(1);
  });

  it("reload without a fault is just a reload", async () => {
    const { ch, host } = await stalled();
    await host.reload(4);
    expect(host.loaded).toBe(true);
    expect(ch.terminations).toBe(0);
    host.stepOnce(input());
    ch.answer();
    expect(host.framesConfirmed).toBe(1);
  });

  it("honours a deadline other than the default", async () => {
    const { clock, host } = await stalled(50);
    host.stepOnce(input());
    clock.advance(49);
    expect(host.fault).toBeNull();
    clock.advance(1);
    expect(host.fault?.message).toBe("deadline");
  });

  it("arms nothing when the channel answers synchronously", async () => {
    // The conformance run drives thousands of frames through the in-process
    // channel, which replies from inside `post`. Arming and cancelling a timer
    // for every one of them would be pure waste, so the host arms only when a
    // step is actually outstanding.
    const ch = new FakeChannel();
    const clock = new ManualClock();
    const host = new Host(ch, { clock });
    await host.load(1);
    for (let f = 0; f < 50; f++) {
      host.stepOnce(input(f));
      ch.answer();
    }
    expect(host.framesConfirmed).toBe(50);
    expect(host.deadlineArmed).toBe(false);
    expect(clock.pending).toBe(0);
  });

  it("does not arm a deadline for a load", async () => {
    // Booting is allowed to take longer than a frame: a real worker is being
    // spawned and a cart compiled. Only a step is on the clock.
    const ch = new FakeChannel();
    const clock = new ManualClock();
    const host = new Host(ch, { clock });
    const p = host.load(1);
    expect(host.deadlineArmed).toBe(false);
    expect(clock.pending).toBe(0);
    await p;
  });
});

/*
 * PIECE B: the criterion itself.
 *
 * Node-only, and guarded rather than assumed: this file is not in the browser
 * config's include list, but a guard costs one line and a `ReferenceError` in a
 * browser run costs an afternoon.
 */
const inNode = typeof process !== "undefined" && process.versions?.node !== undefined;

/**
 * The worker's whole program, as source, because `new Worker(src, { eval: true })`
 * needs no build step and no file on disk -- and because a bundled worker entry
 * would be testing the bundler as much as the watchdog.
 *
 * It is the protocol and nothing else: `load` builds the cart's `tick` from
 * source the way a real bootstrap does, `step` calls it and answers. With the
 * stuck cart, `step` never gets as far as answering.
 */
const WORKER_SRC = `
const { parentPort, workerData } = require("node:worker_threads");
let tick = null;
parentPort.on("message", (m) => {
  if (m.t === "load") {
    tick = new Function(workerData.cart + "; return tick;")();
    parentPort.postMessage({ t: "ready" });
    return;
  }
  if (m.t === "step") {
    tick();
    parentPort.postMessage({ t: "frame", frame: m.frame, out: m.out, tookMs: 0 }, [m.out]);
  }
});
`;

const STUCK_CART = "function tick() { while (true) {} }";
const LIVE_CART = "function tick() {}";

/** Poll until `p` holds, or give up after `limitMs`. Real time: this is the integration test. */
async function until(p: () => boolean, limitMs = 5000): Promise<void> {
  const t0 = performance.now();
  while (!p()) {
    if (performance.now() - t0 > limitMs) throw new Error("timed out waiting for the host");
    await new Promise((r) => setTimeout(r, 1));
  }
}

describe.skipIf(!inNode)("Host - a real Worker in a real infinite loop", () => {
  it("faults and serves frames from a fresh worker inside 200 ms", async () => {
    const { Worker } = await import("node:worker_threads");
    type NodeWorker = InstanceType<typeof Worker>;

    const alive: NodeWorker[] = [];
    const spawn = (cart: string): Channel => {
      const w = new Worker(WORKER_SRC, { eval: true, workerData: { cart } });
      alive.push(w);
      return {
        post(msg: ToWorker, transfer?: Transferable[]): void {
          // Node types its transfer list as its own `TransferListItem[]`, the
          // DOM types it as `Transferable[]`, and the objects travelling in it
          // are the same ArrayBuffers either way. The cast is the price of one
          // Channel interface serving both worlds.
          const port = w as unknown as { postMessage(value: unknown, transfer?: unknown[]): void };
          if (transfer !== undefined && transfer.length > 0) port.postMessage(msg, [...transfer]);
          else port.postMessage(msg);
        },
        onMessage(cb: (m: FromWorker) => void): void {
          w.removeAllListeners("message");
          w.on("message", (m: FromWorker) => cb(m));
        },
        terminate(): void {
          void w.terminate();
        },
      };
    };

    let spawns = 0;
    const host = new Host(spawn(STUCK_CART), {
      deadlineMs: 12,
      respawn: () => {
        spawns++;
        return spawn(LIVE_CART);
      },
    });

    try {
      await host.load(1);
      expect(host.loaded).toBe(true);

      // From here on the clock is the criterion: post a step into a cart that
      // will never return, and be playing again within 200 ms.
      const t0 = performance.now();
      host.stepOnce(input());

      await until(() => host.fault !== null);
      const faulted = performance.now() - t0;
      expect(host.fault).toEqual({ phase: "tick", frame: 0, message: "deadline" });

      await host.reload(1);
      host.stepOnce(input());
      await until(() => host.framesConfirmed === 1);
      const recovered = performance.now() - t0;

      expect(spawns).toBe(1);
      expect(host.fault).toBeNull();
      expect(host.latestRgba?.length).toBe(RGBA_BYTES / 4);
      // The criterion is a measured number, so the run prints the number it
      // measured. A margin that quietly shrinks over a year is worth seeing.
      // eslint-disable-next-line no-console
      console.log(
        `watchdog: faulted in ${faulted.toFixed(1)} ms, playing again in ${recovered.toFixed(1)} ms (budget 200)`,
      );
      expect(faulted).toBeGreaterThanOrEqual(12); // not early: the deadline decided this
      expect(recovered).toBeLessThan(200);
    } finally {
      host.terminate();
      for (const w of alive) await w.terminate();
    }
  });

  it("the stuck cart really does hang a worker that is not terminated", async () => {
    // The control for the test above: without the watchdog, the reply never
    // comes. If this ever passes quickly, the "infinite loop" stopped being one
    // and the criterion above stopped meaning anything.
    const { Worker } = await import("node:worker_threads");
    const w = new Worker(WORKER_SRC, { eval: true, workerData: { cart: STUCK_CART } });
    try {
      const ready = new Promise<void>((resolve) => {
        w.on("message", (m: FromWorker) => {
          if (m.t === "ready") resolve();
        });
      });
      w.postMessage({ t: "load", seed: 1 });
      await ready;

      let replied = false;
      w.on("message", (m: FromWorker) => {
        if (m.t === "frame") replied = true;
      });
      const out = new ArrayBuffer(RGBA_BYTES);
      w.postMessage({ t: "step", frame: 0, input: input(), out }, [out]);
      await new Promise((r) => setTimeout(r, 100));
      expect(replied).toBe(false);
    } finally {
      await w.terminate();
    }
  });
});
