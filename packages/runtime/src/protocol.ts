/**
 * The host <-> worker message protocol.
 *
 * Two rules shape it.
 *
 * THE HOST OWNS THE CLOCK. There is no "run" or "start" message and no way for
 * the worker to schedule its own next frame. Every tick happens because the host
 * sent a `step`, and the worker's only job is to answer. A worker that drove
 * itself with its own timer would make the frame count depend on how long each
 * frame took, which is exactly the dependency a deterministic console must not
 * have: the same cart and the same inputs would then produce a different run on
 * a slow machine.
 *
 * FRAMEBUFFERS TRAVEL, THEY ARE NOT COPIED. `step` carries an `out` ArrayBuffer
 * that the worker fills and hands back on `frame`. Both directions transfer it,
 * so the 64 KiB of pixels is never cloned -- but a transferred ArrayBuffer is
 * DETACHED in the sender, and reading a detached buffer yields nothing. That is
 * why `out` makes the round trip explicitly instead of the worker keeping one:
 * the buffer's ownership is visible in the message type.
 *
 * AUDIO IS CLONED, NOT TRANSFERRED, AND THAT IS THE CHEAP OPTION. The `frame`
 * reply carries the 80 bytes of audio registers the mixer reads
 * (`AUDIO_REGS_BYTES`) as a plain `Uint8Array`, which structured-clone copies.
 * Eighty bytes at sixty frames is 4.8 KB/s -- less than the `input` array
 * already crossing the other way -- and a copy costs nothing a transfer would
 * save. A transfer WOULD cost something: a second ping-pong pool on the host,
 * a second detach hazard beside the one the framebuffer already has, and an
 * extra required field on `step` that every existing caller would have to
 * supply. The framebuffer is transferred because 64 KiB per frame is worth the
 * ownership bookkeeping; the register block is not.
 *
 * Nor is the register block folded into the `out` buffer. Widening `out` would
 * make "an RGBA staging buffer" and "a frame packet" the same object, so
 * `Host`'s size assertion -- the one thing standing between a detach bug and a
 * silently black screen -- would stop meaning "these are the pixels".
 *
 * Every payload here is either a plain number, a string, or a structured-clone
 * primitive. Nothing carries a function, a class instance, or a reference to
 * host state, so the same messages work over a real Worker and over the
 * in-process channel the tests use.
 */

/** Messages the host sends to the worker. */
export type ToWorker =
  /** Boot the machine with `seed`. Answered with `ready`, or `fault` at phase "load" or "boot". */
  | { t: "load"; seed: number }
  /**
   * Advance exactly one frame.
   *
   * `frame` is the host's frame counter, echoed back so a late or dropped reply
   * is detectable rather than silently mistaken for the current frame.
   * `input` is the frame's input bytes. `out` is an RGBA buffer, transferred to
   * the worker, that comes back on `frame`.
   */
  | { t: "step"; frame: number; input: Uint8Array; out: ArrayBuffer }
  /** Ask for a copy of machine RAM. Answered with `snapshot`. */
  | { t: "snapshot" }
  /** Replace machine RAM with `ram`. Answered with `ready`. */
  | { t: "restore"; ram: ArrayBuffer };

/** Messages the worker sends to the host. */
export type FromWorker =
  /** The machine is booted (or restored) and will accept `step`. */
  | { t: "ready" }
  /**
   * One frame is done. `out` is the same memory the matching `step` sent,
   * transferred back and now filled with RGBA pixels. `tookMs` is wall-clock
   * cost, for diagnostics only -- it is never an input to the machine, because
   * a value that varies between runs must not be able to reach one.
   *
   * `audio` is that frame's audio register block, `AUDIO_REGS_BYTES` of it,
   * copied out of RAM by `readAudioRegs`. It is the ONLY thing the mixer ever
   * sees, and it travels here because this is the only message that happens
   * once per frame. Cloned rather than transferred -- see the header. The
   * worker reuses one scratch array for it, which structured clone makes safe:
   * the copy is taken synchronously, inside `postMessage`.
   *
   * It is a reply, never a request. Nothing the mixer does can reach back into
   * the simulation, so a frame that produced no sound and a frame nobody
   * listened to are the same frame.
   *
   * OPTIONAL IN THE TYPE, ALWAYS SENT BY `createMessageHandler`. Audio is
   * non-normative: a frame whose registers did not arrive is a frame that
   * sounded wrong, and refusing it would turn a mixing defect into a dead
   * console. So the field is one a peer may omit -- a hand-written test channel,
   * a host talking to an older worker -- and `Host` reads a missing block as
   * silence rather than as an error. It is NOT optional for the runtime's own
   * worker, which fills it on every frame.
   */
  | { t: "frame"; frame: number; out: ArrayBuffer; tookMs: number; audio?: Uint8Array }
  /** The requested RAM copy. */
  | { t: "snapshot"; ram: ArrayBuffer }
  /**
   * Something threw. `phase` says where, `frame` is present only for "tick".
   * A fault is terminal for the current run: the machine's state after a
   * half-executed tick is not defined, so the host must reload rather than
   * carry on.
   */
  | { t: "fault"; phase: "load" | "boot" | "tick"; frame?: number; message: string };
