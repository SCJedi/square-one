/**
 * A cart's static data: the map, the plan, the install, and the boot order.
 *
 * Specification 3.3 has always said that a cart's static data initializes
 * 0x2000 through 0x77FF at boot. Nothing implemented it until M5, and what the
 * absence produced is worth writing down because it is what this file guards
 * against coming back: the first engine that needed a tileset carried its
 * sprite sheet through its own SOURCE as a hex string and unpacked it in
 * `boot()`. That works, and it costs two cart bytes per data byte plus a
 * decoder in every engine, to reach a region the machine initializes for free.
 *
 * FOUR THINGS ARE PINNED HERE, and each one is a way the feature can be present
 * and still wrong:
 *
 *   1. THE MAP. Every region a chunk installs into is inside the window the
 *      specification names, and none of them touches the live register block.
 *      A chunk that reached 0x2100 would overwrite the RNG seed the machine was
 *      booted with, and a cart's replay would become a function of its own data
 *      file.
 *   2. THE LAYOUT. `GFX ` carries its 256 flag bytes FIRST and its sheet after
 *      them. Get the two halves the wrong way round and a cart's tiles are its
 *      collision flags: it draws, it runs, and it is nonsense.
 *   3. THE ORDER. Data lands after the machine's own defaults and before the
 *      cart's `boot()`. Both edges are tested, because getting it wrong in
 *      either direction is silent -- one way the cart's palette is overwritten
 *      by the identity one, the other way a cart reads a blank sheet on the
 *      frame it starts on.
 *   4. THE HOSTS AGREE. The same cart, in-process and through
 *      `startCartWorker` in a real hardened worker, produces the same pixels.
 *      A worker that compiled the CODE chunk and dropped the `GFX ` chunk
 *      answers every message correctly and draws a blank sheet, so nothing but
 *      a comparison finds it.
 */

import { describe, expect, it } from "vitest";

import {
  SPEC_MAJOR,
  SPEC_MINOR,
  defaultMeta,
  encode,
  encodeMeta,
  encodeUtf8,
} from "@sq1/cart";
import type { CartFile } from "@sq1/cart";

import {
  DATA_REGIONS,
  GFX_SHEET_OFFSET,
  installCartData,
  planCartData,
} from "../src/cart-data";
import { loadCartBytes } from "../src/load";
import { createMachine } from "../src/machine";
import { ADDR, LEN, RAM_SIZE, REGION_ORDER } from "../src/memory";
import { HW_PALETTE } from "../src/palette";

const inNode = typeof process !== "undefined" && process.versions?.node !== undefined;

/** The window specification 3.3 gives a cart's static data, inclusive. */
const STATIC_DATA_FIRST = 0x2000;
const STATIC_DATA_LAST = 0x77ff;

/**
 * The regions a chunk may NEVER reach: everything the machine writes for itself
 * between the colour tables and the sprite sheet.
 */
const MACHINE_REGISTERS: readonly (keyof typeof ADDR)[] = [
  "CLIP",
  "CAMERA",
  "INPUT_NOW",
  "INPUT_PREV",
  "PLAYERS_PRESENT",
  "FRAME",
  "RNG_STATE",
  "AUDIO_CH",
  "AUDIO_MASTER",
];

// ---------------------------------------------------------------------------
// 1. The map
// ---------------------------------------------------------------------------

describe("DATA_REGIONS: where a chunk is allowed to land", () => {
  it("names a chunk type the container knows, once each", () => {
    const types = DATA_REGIONS.map((r) => r.chunk);
    expect(new Set(types).size).toBe(types.length);
    for (const t of types) expect(t.length, t).toBe(4);
  });

  it("sums each region's segments into its own `max`", () => {
    for (const r of DATA_REGIONS) {
      let sum = 0;
      for (const seg of r.segments) sum += seg.len;
      expect(sum, r.chunk).toBe(r.max);
      expect(r.segments.length, r.chunk).toBeGreaterThan(0);
    }
  });

  it("puts every segment inside a real region of the memory map", () => {
    // Each segment is exactly one named region, or a run of adjacent ones. A
    // segment that started mid-region would be a chunk whose bytes land at an
    // address nothing in memory.ts names.
    const starts = new Set<number>(REGION_ORDER.map((n) => ADDR[n]));
    const ends = new Set<number>(REGION_ORDER.map((n) => ADDR[n] + LEN[n]));
    for (const r of DATA_REGIONS) {
      for (const seg of r.segments) {
        expect(starts.has(seg.addr), `${r.chunk} starts at 0x${seg.addr.toString(16)}`).toBe(true);
        expect(ends.has(seg.addr + seg.len), `${r.chunk} ends at 0x${(seg.addr + seg.len).toString(16)}`).toBe(
          true,
        );
        expect(seg.addr + seg.len).toBeLessThanOrEqual(RAM_SIZE);
      }
    }
  });

  it("never overlaps the machine's own register block", () => {
    // The line this test defends: `boot` writes CLIP, the input bytes, FRAME
    // and the RNG seed immediately BEFORE installing a cart's data. A chunk
    // reaching them would overwrite the seed the machine was booted with.
    for (const name of MACHINE_REGISTERS) {
      const lo = ADDR[name];
      const hi = lo + LEN[name];
      for (const r of DATA_REGIONS) {
        for (const seg of r.segments) {
          const overlaps = seg.addr < hi && lo < seg.addr + seg.len;
          expect(overlaps, `${r.chunk} overlaps ${name}`).toBe(false);
        }
      }
    }
  });

  it("stays inside the specification's static-data window, except DATA", () => {
    // Specification 3.3: "A cart's static data initializes 0x2000 through
    // 0x77FF at boot." Every region honours that but `DATA`, which lands in
    // USER_RAM -- a region the same table annotates "zeroed at boot".
    //
    // That is a KNOWN TENSION and it is written down rather than smoothed over:
    // `DATA` is the container's chunk for arbitrary cart data and USER_RAM is
    // the only region the machine has no opinion about, so the alternative is a
    // critical chunk type with nowhere to go. If the specification is amended,
    // this test is where the decision is recorded.
    for (const r of DATA_REGIONS) {
      for (const seg of r.segments) {
        if (r.chunk === "DATA") {
          expect(seg.addr).toBe(ADDR.USER_RAM);
          continue;
        }
        expect(seg.addr, r.chunk).toBeGreaterThanOrEqual(STATIC_DATA_FIRST);
        expect(seg.addr + seg.len - 1, r.chunk).toBeLessThanOrEqual(STATIC_DATA_LAST);
      }
    }
  });

  it("gives `PAL ` the three colour tables and `GFX ` the two sprite regions", () => {
    const pal = DATA_REGIONS.find((r) => r.chunk === "PAL ");
    expect(pal?.segments).toEqual([
      { addr: ADDR.PALETTE_HW, len: LEN.PALETTE_HW + LEN.PALETTE_LIVE + LEN.DRAW_REMAP },
    ]);

    // Flags FIRST, sheet second -- not address order. cart-data.ts says why:
    // the fixed-size half goes first so the split is a constant rather than a
    // header, and the variable half goes last so it can be trimmed.
    const gfx = DATA_REGIONS.find((r) => r.chunk === "GFX ");
    expect(gfx?.segments).toEqual([
      { addr: ADDR.SPRITE_FLAGS, len: LEN.SPRITE_FLAGS },
      { addr: ADDR.SPRITES, len: LEN.SPRITES },
    ]);
    expect(GFX_SHEET_OFFSET).toBe(LEN.SPRITE_FLAGS);
  });
});

// ---------------------------------------------------------------------------
// 2. The plan
// ---------------------------------------------------------------------------

describe("planCartData", () => {
  it("ignores a chunk it has no region for, and an empty one", () => {
    const planned = planCartData([
      { type: "META", data: new Uint8Array([1, 2, 3]) },
      { type: "labl", data: new Uint8Array(64).fill(9) },
      { type: "MAP ", data: new Uint8Array(0) },
      { type: "XXXX", data: new Uint8Array([4]) },
    ]);
    expect(planned.data).toEqual([]);
    expect(planned.oversize).toEqual([]);
  });

  it("cuts a `GFX ` chunk at the flags/sheet boundary", () => {
    const chunk = new Uint8Array(GFX_SHEET_OFFSET + 10);
    chunk[0] = 0xa1;
    chunk[GFX_SHEET_OFFSET] = 0xb2;
    const { data } = planCartData([{ type: "GFX ", data: chunk }]);

    expect(data.map((d) => d.addr)).toEqual([ADDR.SPRITE_FLAGS, ADDR.SPRITES]);
    expect(data[0]?.bytes.length).toBe(GFX_SHEET_OFFSET);
    expect(data[1]?.bytes.length).toBe(10);
    expect(data[0]?.bytes[0]).toBe(0xa1);
    expect(data[1]?.bytes[0]).toBe(0xb2);
  });

  it("stops inside the first segment when a `GFX ` chunk is shorter than 256", () => {
    // A pack with flags and no pixels at all. Legal, and it must not produce a
    // second span pointing at SPRITES with nothing in it.
    const { data } = planCartData([{ type: "GFX ", data: new Uint8Array(100).fill(7) }]);
    expect(data.length).toBe(1);
    expect(data[0]?.addr).toBe(ADDR.SPRITE_FLAGS);
    expect(data[0]?.bytes.length).toBe(100);
  });

  it("installs regions in ITS OWN order, not the order the chunks arrive in", () => {
    // A cart file can list its chunks in any order the container permits, and
    // two carts with the same chunks in different orders must install the same
    // RAM. Fixing the order here rather than in the file is what guarantees it.
    const chunks = [
      { type: "MAP ", data: new Uint8Array(4).fill(2) },
      { type: "GFX ", data: new Uint8Array(4).fill(3) },
      { type: "PAL ", data: new Uint8Array(4).fill(4) },
    ];
    const forward = planCartData(chunks).data.map((d) => d.addr);
    const backward = planCartData([...chunks].reverse()).data.map((d) => d.addr);
    expect(backward).toEqual(forward);
    expect(forward).toEqual([ADDR.PALETTE_HW, ADDR.SPRITE_FLAGS, ADDR.MAP]);
  });

  it("reports an oversize chunk and NEVER truncates it", () => {
    const big = new Uint8Array(LEN.MUSIC + 5);
    const { data, oversize } = planCartData([
      { type: "MUS ", data: big },
      { type: "MAP ", data: new Uint8Array(3).fill(1) },
    ]);

    // The offending chunk is reported and produces no data at all. The others
    // are still planned: a caller that wanted to list every problem can.
    expect(oversize).toEqual([{ chunk: "MUS ", bytes: LEN.MUSIC + 5, max: LEN.MUSIC }]);
    expect(data.map((d) => d.addr)).toEqual([ADDR.MAP]);
  });

  it("accepts a chunk exactly as long as its region", () => {
    const exact = new Uint8Array(LEN.SPRITE_FLAGS + LEN.SPRITES);
    const { data, oversize } = planCartData([{ type: "GFX ", data: exact }]);
    expect(oversize).toEqual([]);
    expect(data[0]?.bytes.length).toBe(LEN.SPRITE_FLAGS);
    expect(data[1]?.bytes.length).toBe(LEN.SPRITES);
  });
});

// ---------------------------------------------------------------------------
// 3. The install, and the order
// ---------------------------------------------------------------------------

describe("installCartData", () => {
  it("writes each span at its own address and touches nothing else", () => {
    const ram = new Uint8Array(RAM_SIZE);
    const chunk = new Uint8Array(GFX_SHEET_OFFSET + 3);
    chunk[1] = 0x55;
    chunk[GFX_SHEET_OFFSET + 2] = 0x66;

    installCartData(ram, planCartData([{ type: "GFX ", data: chunk }]).data);

    expect(ram[ADDR.SPRITE_FLAGS + 1]).toBe(0x55);
    expect(ram[ADDR.SPRITES + 2]).toBe(0x66);

    // Everything outside the two spans is untouched. Counted rather than
    // spot-checked, because a `set` at the wrong address is exactly the bug
    // this function could have.
    let written = 0;
    for (let i = 0; i < RAM_SIZE; i++) if (ram[i] !== 0) written++;
    expect(written).toBe(2);
  });

  it("is idempotent, so a rewind installs the same bytes", () => {
    const a = new Uint8Array(RAM_SIZE);
    const b = new Uint8Array(RAM_SIZE);
    const data = planCartData([{ type: "MAP ", data: new Uint8Array([9, 8, 7]) }]).data;
    installCartData(a, data);
    installCartData(b, data);
    installCartData(b, data);
    expect([...a]).toEqual([...b]);
  });
});

// ---------------------------------------------------------------------------
// Building carts that carry data
// ---------------------------------------------------------------------------

function code(source: string): Uint8Array {
  const bytes = encodeUtf8(source);
  if (bytes === null) throw new Error("test source is not encodable as UTF-8");
  return bytes;
}

function buildCart(
  source: string,
  extra: readonly { type: string; data: Uint8Array }[],
): Uint8Array {
  const cart: CartFile = {
    specMajor: SPEC_MAJOR,
    specMinor: SPEC_MINOR,
    chunks: [
      { type: "META", data: encodeMeta(defaultMeta("Data Cart", "cart-data.test")) },
      { type: "CODE", data: code(source) },
      ...extra,
    ],
  };
  return encode(cart);
}

/** A `PAL ` chunk: the hardware palette, then sixteen live slots. */
function palChunk(live: readonly number[]): Uint8Array {
  const chunk = new Uint8Array(HW_PALETTE.length + LEN.PALETTE_LIVE);
  chunk.set(HW_PALETTE, 0);
  chunk.set(Uint8Array.from(live), HW_PALETTE.length);
  return chunk;
}

/** A `GFX ` chunk: `flags` then a sheet whose first cell is a solid colour. */
function gfxChunk(flags: readonly number[], cellColor: number): Uint8Array {
  const chunk = new Uint8Array(GFX_SHEET_OFFSET + 32);
  chunk.set(Uint8Array.from(flags), 0);
  // One 8x8 cell at 4bpp is 8 rows of 4 bytes, at a 64-byte sheet stride.
  const nibble = (cellColor & 0x0f) | ((cellColor & 0x0f) << 4);
  for (let row = 0; row < 8; row++) {
    for (let b = 0; b < 4; b++) chunk[GFX_SHEET_OFFSET + row * 64 + b] = nibble;
  }
  return chunk;
}

/**
 * A cart that PROVES THE ORDER from inside.
 *
 * `boot` reads the sprite flag and the live palette slot the chunks installed
 * and records them in USER_RAM. If installation happened after `boot`, both
 * reads return 0 and the cart cannot tell anyone; recording them is what makes
 * the failure visible from outside.
 */
const ORDER_CART = `
function boot() {
  sys.poke(0x7800, sys.peek(0x4200));   // the sprite flag for cell 0
  sys.poke(0x7801, sys.peek(0x20c0));   // live palette slot 0
  sys.poke(0x7802, sys.peek(0x20c3));   // live palette slot 3
}
function tick() {
  gfx.cls(0);
  gfx.spr(0, 20, 20);
  gfx.rect(60, 60, 30, 30, 3, true);
}
`;

describe("boot installs a cart's data, in the one order that works", () => {
  function bootOrderCart() {
    const bytes = buildCart(ORDER_CART, [
      { type: "PAL ", data: palChunk([40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55]) },
      { type: "GFX ", data: gfxChunk([0xab], 5) },
    ]);
    const loaded = loadCartBytes(bytes);
    if (!loaded.ok) throw new Error(`${loaded.error.code}: ${loaded.error.message}`);
    return loaded;
  }

  it("has the data in RAM BEFORE the cart's boot() runs", () => {
    const loaded = bootOrderCart();
    const m = createMachine(loaded.program, { data: loaded.data });
    m.boot(1);

    // Read by the cart itself, on the boot that installed them.
    expect(m.ram[ADDR.USER_RAM + 0], "the cart could not see its own sprite flags").toBe(0xab);
    expect(m.ram[ADDR.USER_RAM + 1], "the cart could not see its own palette").toBe(40);
    expect(m.ram[ADDR.USER_RAM + 2]).toBe(43);
  });

  it("has the data in RAM AFTER the machine's own defaults, not before", () => {
    // The other edge, and the one that is silent: install first and the
    // identity live palette the machine writes would erase the cart's colours.
    const loaded = bootOrderCart();
    const m = createMachine(loaded.program, { data: loaded.data });
    m.boot(1);

    expect([...m.ram.subarray(ADDR.PALETTE_LIVE, ADDR.PALETTE_LIVE + 4)]).toEqual([40, 41, 42, 43]);
    // DRAW_REMAP is past the end of this cart's `PAL ` chunk, so it is still
    // the identity the machine booted with -- a short chunk fills from the
    // start and leaves the rest alone.
    expect([...m.ram.subarray(ADDR.DRAW_REMAP, ADDR.DRAW_REMAP + 4)]).toEqual([0, 1, 2, 3]);
  });

  it("leaves the machine's registers alone: the seed still decides the run", () => {
    // Two loads, because a compiled program binds to one machine: the sandbox
    // refuses a second `boot` against a different ABI object by design.
    const loaded = bootOrderCart();
    const other = bootOrderCart();
    const withData = createMachine(loaded.program, { data: loaded.data });
    const without = createMachine(other.program);
    withData.boot(9);
    without.boot(9);
    expect([...withData.ram.subarray(ADDR.RNG_STATE, ADDR.RNG_STATE + LEN.RNG_STATE)]).toEqual([
      ...without.ram.subarray(ADDR.RNG_STATE, ADDR.RNG_STATE + LEN.RNG_STATE),
    ]);
    expect([...withData.ram.subarray(ADDR.CLIP, ADDR.CLIP + LEN.CLIP)]).toEqual([
      ...without.ram.subarray(ADDR.CLIP, ADDR.CLIP + LEN.CLIP),
    ]);
  });

  it("reinstalls on every boot, so a restart is a restart", () => {
    const loaded = bootOrderCart();
    const m = createMachine(loaded.program, { data: loaded.data });
    m.boot(1);
    m.ram.fill(0, ADDR.SPRITES, ADDR.SPRITES + 32); // the cart scribbles on its sheet
    m.boot(1);
    expect(m.ram[ADDR.SPRITES]).not.toBe(0);
  });

  it("changes what the cart DRAWS, which is the point of all of it", () => {
    // The whole feature, seen from the only place that matters. Same program,
    // same seed, same input -- one machine given the cart's data and one not.
    const loaded = bootOrderCart();
    const other = bootOrderCart();
    const withData = createMachine(loaded.program, { data: loaded.data });
    const without = createMachine(other.program);
    for (const m of [withData, without]) {
      m.boot(1);
      m.tick(new Uint8Array(4));
      m.present();
    }
    expect([...withData.rgba]).not.toEqual([...without.rgba]);
    // Specifically: the sprite drew, where without a sheet there is nothing.
    expect(withData.rgba[21 * 128 + 21]).not.toBe(without.rgba[21 * 128 + 21]);
  });
});

// ---------------------------------------------------------------------------
// 4. The hosts agree
// ---------------------------------------------------------------------------

/**
 * The runtime bundled for a worker, exactly as end-to-end.test.ts does it: one
 * recipe, not two. The bytes in the worker are the bytes in `src/`.
 */
let bundling: Promise<string> | null = null;

async function getBundle(): Promise<string> {
  if (bundling === null) {
    bundling = (async (): Promise<string> => {
      const esbuild = await import("esbuild");
      const { fileURLToPath } = await import("node:url");
      const built = await esbuild.build({
        entryPoints: [fileURLToPath(new URL("../src/index.ts", import.meta.url))],
        bundle: true,
        format: "iife",
        globalName: "SQ1",
        platform: "node",
        target: "node20",
        write: false,
      });
      const text = built.outputFiles?.[0]?.text ?? "";
      if (text.length < 1000) throw new Error("the runtime did not bundle");
      return `${text}\n`;
    })();
  }
  return bundling;
}

/**
 * The worker's program. A `node:worker_threads` global has no `postMessage` or
 * `onmessage`, so the first lines bridge its port to the two names
 * `installWorker` looks for, before the scrub -- and then call
 * `startCartWorker` with no options at all, the way a browser bootstrap does.
 */
const HARNESS = `
;(function () {
  var wt = require("node:worker_threads");
  var parentPort = wt.parentPort;
  var G = globalThis;
  function send(m, transfer) {
    if (transfer && transfer.length > 0) parentPort.postMessage(m, transfer);
    else parentPort.postMessage(m);
  }
  G.postMessage = function (m, transfer) { send(m, transfer); };
  G.onmessage = null;
  parentPort.on("message", function (m) {
    var handler = G.onmessage;
    if (typeof handler !== "function") { send({ t: "no-handler" }); return; }
    handler({ data: m });
  });
  var bytes = new Uint8Array(wt.workerData.cart);
  var threw = null;
  var result = null;
  try {
    result = SQ1.startCartWorker(bytes);
  } catch (e) {
    threw = String(e);
  }
  send({
    t: "bootstrap",
    installed: result === null ? false : result.installed,
    error: result === null ? null : result.error,
    threw: threw
  });
})();
`;

const RGBA_BYTES = 128 * 128 * 4;
const FRAMES = 20;
const SEED = 31337;

function inputAt(frame: number): Uint8Array {
  const bytes = new Uint8Array(4);
  bytes[0] = (frame * 37 + 11) & 0x3f;
  return bytes;
}

describe.skipIf(!inNode)("a cart's data reaches a REAL WORKER, or the two hosts diverge", () => {
  it("draws the same pixels in-process and through startCartWorker", async () => {
    // THE DIVERGENCE THIS TEST MAKES IMPOSSIBLE. `startCartWorker` compiles the
    // CODE chunk and, if it did not also carry `loaded.data` into
    // `createMachine`, would serve a cart with an empty sprite sheet and an
    // identity palette. It would answer every protocol message correctly. The
    // only symptom is the picture, and the only test that sees it is this one.
    const cart = buildCart(ORDER_CART, [
      { type: "PAL ", data: palChunk([40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55]) },
      { type: "GFX ", data: gfxChunk([0xab], 5) },
    ]);

    const reference = loadCartBytes(cart);
    expect(reference.ok, reference.ok ? "" : reference.error.message).toBe(true);
    if (!reference.ok) return;
    expect(reference.data.length, "the reference cart carries no data to diverge over").toBe(3);

    const here = createMachine(reference.program, { data: reference.data });
    here.boot(SEED);
    for (let f = 0; f < FRAMES; f++) {
      here.tick(inputAt(f));
      here.present();
    }

    const { Worker } = await import("node:worker_threads");
    const w = new Worker((await getBundle()) + HARNESS, { eval: true, workerData: { cart } });
    const queue: Record<string, unknown>[] = [];
    let waiting: ((m: Record<string, unknown>) => void) | null = null;
    w.on("message", (m: Record<string, unknown>) => {
      const f = waiting;
      if (f !== null) {
        waiting = null;
        f(m);
      } else {
        queue.push(m);
      }
    });
    const next = (): Promise<Record<string, unknown>> => {
      const queued = queue.shift();
      if (queued !== undefined) return Promise.resolve(queued);
      return new Promise((resolve, reject) => {
        waiting = resolve;
        setTimeout(() => {
          if (waiting !== null) {
            waiting = null;
            reject(new Error("the worker sent nothing for 20 s"));
          }
        }, 20_000).unref?.();
      });
    };

    try {
      const boot = await next();
      expect(boot["threw"], "startCartWorker threw during its own bootstrap").toBeNull();
      expect(boot["error"], JSON.stringify(boot["error"])).toBeNull();
      expect(boot["installed"]).toBe(true);

      w.postMessage({ t: "load", seed: SEED });
      expect(await next()).toEqual({ t: "ready" });

      let last: Uint32Array | null = null;
      for (let f = 0; f < FRAMES; f++) {
        const out = new ArrayBuffer(RGBA_BYTES);
        w.postMessage({ t: "step", frame: f, input: inputAt(f), out }, [out]);
        const reply = await next();
        expect(reply["t"], JSON.stringify(reply)).toBe("frame");
        last = new Uint32Array(reply["out"] as ArrayBuffer);
      }
      expect(last).not.toBeNull();
      if (last === null) return;

      // Not blank first: two blank screens agree for the wrong reason.
      expect(new Set(last).size, "the worker served one flat colour").toBeGreaterThan(1);
      expect([...last]).toEqual([...here.rgba]);

      // And RAM, which includes the installed sheet and palette themselves.
      w.postMessage({ t: "snapshot" });
      const snap = await next();
      expect(snap["t"], JSON.stringify(snap)).toBe("snapshot");
      const ram = new Uint8Array(snap["ram"] as ArrayBuffer);
      expect(ram[ADDR.SPRITE_FLAGS], "the worker's sprite flags are blank").toBe(0xab);
      expect(ram[ADDR.PALETTE_LIVE], "the worker's live palette is the identity one").toBe(40);
      expect([...ram]).toEqual([...here.snapshot()]);
    } finally {
      await w.terminate();
    }
  }, 60_000);
});
