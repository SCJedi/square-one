/**
 * The whole machine is one buffer.
 *
 * Rewind, save states, rollback netplay and the conformance chains all rest on
 * a single claim: everything a run depends on lives in the 64 KB of RAM, so a
 * snapshot is a copy of RAM and nothing else. Any state a cart can reach that
 * is NOT in that buffer silently falsifies the claim — a rewind would restore
 * the framebuffer to frame N while leaving the smuggled value at frame N+300,
 * and the divergence would appear far from its cause.
 *
 * This file exists to make that claim testable rather than aspirational.
 *
 * Found during the M3 sandbox review: the ABI objects were not frozen, so
 * `sys.carry = 1` persisted across ticks and survived `restore()`. That was a
 * determinism defect wearing a security costume — the danger was not that a
 * cart could reach something, it was that a cart could remember something.
 */

import { describe, expect, it } from "vitest";

import { createMachine } from "../src/machine";
import type { CartApi, CartProgram } from "../src/machine";
import { ADDR } from "../src/memory";

function cartOf(tick: (api: CartApi) => void): CartProgram {
  return { boot(): void {}, tick };
}

describe("machine state containment", () => {
  it("freezes every ABI group, so a cart cannot store state on them", () => {
    const seen: Record<string, boolean> = {};
    const m = createMachine(
      cartOf((api) => {
        seen["gfx"] = Object.isFrozen(api.gfx);
        seen["inp"] = Object.isFrozen(api.inp);
        seen["snd"] = Object.isFrozen(api.snd);
        seen["sys"] = Object.isFrozen(api.sys);
        seen["api"] = Object.isFrozen(api);
      }),
    );
    m.boot(1);
    m.tick(new Uint8Array(4));
    expect(seen).toEqual({ gfx: true, inp: true, snd: true, sys: true, api: true });
  });

  /**
   * The list above has to grow with the ABI, and a test that names namespaces
   * one at a time is a test that quietly stops covering the newest one. So this
   * enumerates instead: every own property of the api object must be a frozen
   * object, whatever it is called and whenever it was added.
   */
  it("freezes EVERY namespace on the api, including ones added later", () => {
    const names: string[] = [];
    const unfrozen: string[] = [];
    const m = createMachine(
      cartOf((api) => {
        for (const k of Object.getOwnPropertyNames(api)) {
          names.push(k);
          const v = (api as unknown as Record<string, unknown>)[k];
          if (typeof v !== "object" || v === null || !Object.isFrozen(v)) unfrozen.push(k);
        }
      }),
    );
    m.boot(1);
    m.tick(new Uint8Array(4));
    expect(unfrozen).toEqual([]);
    expect(names.sort()).toEqual(["gfx", "inp", "snd", "sys"]);
  });

  it("does not let a cart store state on `snd` either", () => {
    let observed: unknown = "never ran";
    const m = createMachine(
      cartOf((api) => {
        const snd = api.snd as unknown as Record<string, unknown>;
        try {
          snd["lastNote"] = 42;
        } catch {
          /* strict-mode TypeError is the preferred outcome */
        }
        observed = snd["lastNote"];
      }),
    );
    m.boot(1);
    m.tick(new Uint8Array(4));
    expect(observed).toBeUndefined();
  });

  it("does not let a written property survive to the next tick", () => {
    let observed: unknown = "never ran";
    const m = createMachine(
      cartOf((api) => {
        const sys = api.sys as unknown as Record<string, unknown>;
        // Sloppy mode swallows this; strict mode throws. A cart is compiled in
        // strict mode, so either outcome is acceptable — what must NOT happen
        // is the value being readable on a later tick.
        try {
          sys["carry"] = 1;
        } catch {
          /* strict-mode TypeError is the preferred outcome */
        }
        observed = sys["carry"];
      }),
    );
    m.boot(1);
    m.tick(new Uint8Array(4));
    expect(observed).toBeUndefined();
  });

  it("keeps the typed arrays behind the ABI writable — the freeze is shallow by intent", () => {
    const m = createMachine(
      cartOf((api) => {
        api.sys.poke(ADDR.USER_RAM, 0xab);
      }),
    );
    m.boot(1);
    m.tick(new Uint8Array(4));
    expect(m.ram[ADDR.USER_RAM]).toBe(0xab);
  });

  it("restores to a byte-identical machine after a cart tries to smuggle state", () => {
    // The end-to-end property. If anything a cart touched lives outside RAM,
    // these two framebuffers diverge.
    const build = (): ReturnType<typeof createMachine> =>
      createMachine(
        cartOf((api) => {
          const sys = api.sys as unknown as Record<string, unknown>;
          try {
            sys["counter"] = ((sys["counter"] as number) ?? 0) + 1;
          } catch {
            /* expected under a freeze */
          }
          const n = (sys["counter"] as number) ?? api.sys.frame();
          api.sys.poke(ADDR.USER_RAM, n & 0xff);
          api.gfx.rect(0, 0, 8, 8, n & 0x0f, true);
        }),
      );

    const m = build();
    m.boot(7);
    const input = new Uint8Array(4);
    for (let i = 0; i < 20; i++) m.tick(input);

    const snap = m.snapshot();
    for (let i = 0; i < 20; i++) m.tick(input);
    const afterFirst = m.snapshot();

    m.restore(snap);
    for (let i = 0; i < 20; i++) m.tick(input);
    const afterSecond = m.snapshot();

    expect(Array.from(afterSecond)).toEqual(Array.from(afterFirst));
  });
});
