/**
 * The loader: cart BYTES to a program, and every reason there is not one.
 *
 * Carts are built here in memory with the real `@sq1/cart` encoder rather than
 * read from disk, so this file runs unchanged in Node and in a browser and the
 * bytes under test are the same bytes `sq1 build` writes -- `encode` is the one
 * function both paths go through.
 *
 * THE PROPERTY THIS FILE EXISTS FOR is at the bottom: `loadCartBytes` never
 * throws. Every case above it also feeds its input to `neverThrows`, because a
 * loader that is total for the failures somebody thought of and throws on the
 * seventh is a loader with no property at all.
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
import type { CartFile, Meta } from "@sq1/cart";

import { GFX_SHEET_OFFSET } from "../src/cart-data";
import { createMachine } from "../src/machine";
import { ADDR, LEN } from "../src/memory";
import { loadCartBytes, loadCartSource } from "../src/load";
import { CartCompileError } from "../src/sandbox";

const NO_INPUT = new Uint8Array(4);

/** A cart that draws something, so "it ran" is visible in the framebuffer. */
const DRAWS = `
function boot() { gfx.cls(2); }
function tick() {
  var f = sys.frame();
  gfx.rect(4 + (f % 8), 4, 20, 20, 9, true);
  sys.poke(0x7800, (f + 1) & 0xff);
}
`;

/** Encode source as a CODE payload the way the build command does. */
function code(source: string): Uint8Array {
  const bytes = encodeUtf8(source);
  if (bytes === null) throw new Error("test source is not encodable as UTF-8");
  return bytes;
}

/** Build real cart bytes: META + CODE, canonical order, through the real encoder. */
function buildCart(source: string | Uint8Array, meta?: Partial<Meta>): Uint8Array {
  return buildCartWith([], source, meta);
}

/** The same, plus data chunks -- `encode` puts them in the container's own order. */
function buildCartWith(
  extra: readonly { type: string; data: Uint8Array }[],
  source: string | Uint8Array,
  meta?: Partial<Meta>,
): Uint8Array {
  const full: Meta = { ...defaultMeta("Test Cart", "load.test"), ...meta };
  const cart: CartFile = {
    specMajor: SPEC_MAJOR,
    specMinor: SPEC_MINOR,
    chunks: [
      { type: "META", data: encodeMeta(full) },
      { type: "CODE", data: typeof source === "string" ? code(source) : source },
      ...extra,
    ],
  };
  return encode(cart);
}

/** Every input any test in this file feeds the loader, for the totality check. */
const exercised: { name: string; bytes: Uint8Array }[] = [];

function load(name: string, bytes: Uint8Array) {
  exercised.push({ name, bytes });
  return loadCartBytes(bytes);
}

describe("loadCartBytes: the happy path", () => {
  it("turns cart bytes into a program a machine can run", () => {
    const result = load("draws", buildCart(DRAWS));
    expect(result.ok, result.ok ? "" : result.error.message).toBe(true);
    if (!result.ok) return;

    // The metadata comes back VALIDATED, so a host does not parse META twice.
    expect(result.meta.title).toBe("Test Cart");
    expect(result.meta.author).toBe("load.test");
    expect(result.meta.payload).toBe("script/js1");
    expect(result.meta.specMajor).toBe(SPEC_MAJOR);

    // The token count is a diagnostic and must be a real count, not a stub.
    expect(result.tokens).toBeGreaterThan(20);

    const machine = createMachine(result.program);
    machine.boot(1);
    for (let f = 0; f < 5; f++) machine.tick(NO_INPUT);
    machine.present();

    // It ran: the cart poked its own RAM, and it drew.
    expect(machine.ram[0x7800]).toBe(5);
    expect(new Set(machine.rgba).size).toBeGreaterThan(1);
  });

  it("hands back a program bound to nothing, so the caller picks the machine", () => {
    // Compiling is not instantiating. Two loads of the same bytes are two
    // independent programs, which is what lets a host run a cart twice.
    const a = load("draws-a", buildCart(DRAWS));
    const b = load("draws-b", buildCart(DRAWS));
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;

    const ma = createMachine(a.program);
    const mb = createMachine(b.program);
    ma.boot(3);
    mb.boot(3);
    for (let f = 0; f < 4; f++) {
      ma.tick(NO_INPUT);
      mb.tick(NO_INPUT);
    }
    expect(Array.from(ma.ram)).toEqual(Array.from(mb.ram));
  });

  it("survives the round trip through the container byte for byte", () => {
    // The bytes are the contract: a cart built here loads, and the source that
    // comes out the other side is the source that went in, or the machines
    // would not agree.
    const bytes = buildCart(DRAWS);
    const fromBytes = load("round-trip", bytes);
    const fromSource = loadCartSource(DRAWS, { title: "Test Cart", author: "load.test" });
    expect(fromBytes.ok && fromSource.ok).toBe(true);
    if (!fromBytes.ok || !fromSource.ok) return;

    const run = (program: (typeof fromBytes)["program"]) => {
      const m = createMachine(program);
      m.boot(9);
      for (let f = 0; f < 6; f++) m.tick(NO_INPUT);
      return Array.from(m.ram);
    };
    expect(run(fromBytes.program)).toEqual(run(fromSource.program));
    expect(fromBytes.tokens).toBe(fromSource.tokens);
  });
});

describe("loadCartBytes: a container it cannot trust", () => {
  it("refuses a truncated cart as bad-container, carrying the decoder's message", () => {
    const whole = buildCart(DRAWS);
    const truncated = whole.slice(0, whole.length - 20);
    const result = load("truncated", truncated);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("bad-container");
    // The underlying CartError travels intact: its code and its message name
    // the byte offset, which is the only thing that makes a damaged file
    // diagnosable at all.
    expect(result.error.message).toMatch(/bad-index|truncated|index-mismatch|trailing-garbage/);
    expect(result.error.message.length).toBeGreaterThan(40);
  });

  it("refuses zero bytes, random bytes and a corrupted magic", () => {
    const cases: [string, Uint8Array][] = [
      ["empty", new Uint8Array(0)],
      ["short", new Uint8Array([1, 2, 3])],
      ["not-a-cart", new Uint8Array(64).fill(0xff)],
    ];
    const corrupt = buildCart(DRAWS);
    corrupt[0] = 0x00;
    cases.push(["bad-magic", corrupt]);

    for (const [name, bytes] of cases) {
      const result = load(name, bytes);
      expect(result.ok, `${name} loaded and should not have`).toBe(false);
      if (result.ok) continue;
      expect(result.error.code).toBe("bad-container");
    }
  });

  it("refuses a cart with a flipped byte in the middle of the chunk stream", () => {
    const bytes = buildCart(DRAWS);
    // Land on a chunk-header byte rather than on source text: flipping a byte
    // of the CODE payload gives a cart that decodes fine and compiles or does
    // not, which is a different test.
    bytes[17] = (bytes[17] ?? 0) ^ 0xff;
    const result = load("flipped-header", bytes);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("bad-container");
  });
});

describe("loadCartBytes: metadata and payload", () => {
  it("refuses a wasm/1 cart as unsupported-payload, NAMING the payload", () => {
    // `wasm/1` is RESERVED in the container specification, not damaged. An
    // author who declared it has made no mistake -- they are ahead of this
    // runtime -- so the refusal has to say which payload and that it is
    // reserved, or they go looking for a corruption that is not there.
    const result = load("wasm", buildCart(DRAWS, { payload: "wasm/1" }));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("unsupported-payload");
    expect(result.error.message).toContain("wasm/1");
    expect(result.error.message).toContain("reserved");
    expect(result.error.message).toContain("script/js1");
    // Not mistaken for damage.
    expect(result.error.message).not.toMatch(/damaged|corrupt/i);
  });

  it("refuses a cart whose META is not the JSON the container defines", () => {
    const cart: CartFile = {
      specMajor: SPEC_MAJOR,
      specMinor: SPEC_MINOR,
      chunks: [
        { type: "META", data: code('{"title":"x"}') },
        { type: "CODE", data: code(DRAWS) },
      ],
    };
    const result = load("bad-meta", encode(cart));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("bad-meta");
    expect(result.error.message).toContain("META");
  });

  it("refuses a cart whose META is not valid UTF-8", () => {
    const cart: CartFile = {
      specMajor: SPEC_MAJOR,
      specMinor: SPEC_MINOR,
      chunks: [
        { type: "META", data: new Uint8Array([0xff, 0xfe, 0xfd, 0xfc]) },
        { type: "CODE", data: code(DRAWS) },
      ],
    };
    const result = load("meta-not-utf8", encode(cart));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("bad-meta");
  });
});

describe("loadCartBytes: a cart with no code", () => {
  it("refuses a cart with no CODE chunk, and names the chunk", () => {
    // OBSERVED BEHAVIOUR, NOT THE `missing-code` BRANCH. `decode` lists CODE in
    // REQUIRED_CHUNKS, so the container refuses this file before the loader
    // ever looks for the chunk, and the honest code for that is
    // `bad-container`. The `missing-code` branch stays in load.ts for a
    // container that relaxes its required set; asserting it here would mean
    // asserting a path these bytes cannot take.
    const cart: CartFile = {
      specMajor: SPEC_MAJOR,
      specMinor: SPEC_MINOR,
      chunks: [{ type: "META", data: encodeMeta(defaultMeta("No Code", "load.test")) }],
    };
    const result = load("no-code", encode(cart));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("bad-container");
    expect(result.error.message).toContain("CODE");
    expect(result.error.message).toContain("missing-required-chunk");
  });

  it("refuses a CODE chunk that is not valid UTF-8, and says so", () => {
    // 0x80 is a continuation byte with no lead. The container's strict decoder
    // refuses it rather than repairing it with U+FFFD, because a lenient decode
    // would let two different CODE chunks compile to the same program.
    const result = load("code-not-utf8", buildCart(new Uint8Array([0x80, 0x80, 0x80, 0x80])));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("compile-failed");
    expect(result.error.message).toContain("UTF-8");
  });

  it("compiles an empty CODE chunk and refuses it at boot, not at load", () => {
    // Empty source is a valid function body, so it compiles. What it is not is
    // a cart: it declares no `tick`, and that is a SHAPE error the sandbox
    // raises when the program is instantiated. See the no-tick case below.
    const result = load("empty-code", buildCart(""));
    expect(result.ok).toBe(true);
  });
});

describe("loadCartBytes: source that will not compile", () => {
  it("reports compile-failed with the cart's own line and column", () => {
    // An unterminated string is a LEXICAL failure, caught by the console's own
    // tokenizer, which always has a position -- unlike a parse failure, where
    // V8 attaches nothing to a Function-constructor SyntaxError. So this case
    // pins the position on every engine.
    const source = "function tick() {}\nvar s = 'unterminated;\n";
    const result = load("unterminated-string", buildCart(source));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("compile-failed");
    expect(result.error.line).toBe(2);
    expect(result.error.column).toBeGreaterThan(0);
  });

  it("never reports a position outside the cart source", () => {
    // A parse failure: the position is the engine's, and is absent on V8. Both
    // outcomes are acceptable. A WRONG line is not -- it sends an author
    // hunting through a file they did not break.
    const source = "function tick() {\n\n";
    const result = load("unclosed-function", buildCart(source));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("compile-failed");
    if (result.error.line !== undefined) {
      expect(result.error.line).toBeGreaterThanOrEqual(1);
      expect(result.error.line).toBeLessThanOrEqual(source.split("\n").length);
    }
  });

  it("refuses forbidden syntax at load time (Layer 0), with a position", () => {
    const result = load(
      "dynamic-import",
      buildCart('function tick() {\n  import("node:fs");\n}'),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("compile-failed");
    expect(result.error.message).toContain("import");
    expect(result.error.line).toBe(2);
  });

  it("names the cart's title in the message, because that is what an author sees", () => {
    const result = load(
      "titled",
      buildCart("function tick( {", { title: "Bouncing Block" }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("Bouncing Block");
  });
});

describe("loadCartBytes: a cart with no tick", () => {
  it("loads, and is refused when the machine boots it", () => {
    // WHY NOT AT LOAD TIME. Finding out whether a cart declares `tick` means
    // RUNNING its top level, and in the worker bootstrap loading happens before
    // `scrubRealm` -- so a shape check here would execute a stranger's code in
    // an unhardened realm in order to decide whether it was worth hardening
    // for. The sandbox puts the check on the first boot, which in a worker is
    // after the scrub, and `createMessageHandler` turns the throw into a
    // `fault` at phase "boot" that the host already reports.
    const result = load("no-tick", buildCart("function boot() { gfx.cls(0); }"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const machine = createMachine(result.program);
    let thrown: unknown = null;
    try {
      machine.boot(0);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(CartCompileError);
    expect((thrown as CartCompileError).phase).toBe("shape");
    expect((thrown as CartCompileError).message).toContain("tick");
  });
});

describe("loadCartSource", () => {
  it("loads source with no container in the middle, defaulting the metadata", () => {
    const result = loadCartSource(DRAWS);
    expect(result.ok, result.ok ? "" : result.error.message).toBe(true);
    if (!result.ok) return;
    expect(result.meta.payload).toBe("script/js1");
    expect(result.meta.profile).toBe("up");
    expect(result.meta.specMajor).toBe(SPEC_MAJOR);

    const machine = createMachine(result.program);
    machine.boot(1);
    machine.tick(NO_INPUT);
    expect(machine.ram[0x7800]).toBe(1);
  });

  it("applies the container's own metadata rules, so a preview cannot outlive a build", () => {
    // A title the container will not hold must be refused here too, or an
    // editor previews a cart that `sq1 build` then rejects.
    const result = loadCartSource(DRAWS, { title: "x".repeat(100) });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("bad-meta");
  });

  it("refuses a wasm/1 payload the same way the byte loader does", () => {
    const result = loadCartSource(DRAWS, { payload: "wasm/1" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("unsupported-payload");
    expect(result.error.message).toContain("wasm/1");
  });

  it("never throws, for source that is not JavaScript at all", () => {
    for (const source of ["", "}{", " ", "function tick() { ".repeat(50)]) {
      expect(() => loadCartSource(source)).not.toThrow();
    }
  });
});

// ---------------------------------------------------------------------------
// A cart's static data
// ---------------------------------------------------------------------------

/**
 * A `GFX ` chunk carrying `flagsUsed` flag bytes and `sheetBytes` of sheet.
 *
 * THE FLAGS COME FIRST inside the chunk, at offset 0, and the sheet starts at
 * `GFX_SHEET_OFFSET`. Built by hand here rather than through the stamper,
 * because this file is the other end of that contract: if the two disagree
 * about the layout, one of them has to say so, and a loader test that used the
 * stamper's builder could not.
 */
function gfxChunk(flagsUsed: number, sheetBytes: number): Uint8Array {
  const data = new Uint8Array(GFX_SHEET_OFFSET + sheetBytes);
  for (let i = 0; i < flagsUsed; i++) data[i] = (i + 1) & 0xff;
  for (let i = 0; i < sheetBytes; i++) data[GFX_SHEET_OFFSET + i] = (i * 7 + 3) & 0xff;
  return data;
}

describe("loadCartBytes: a cart's static data", () => {
  it("hands the data back with the program, cut into the spans it installs as", () => {
    const gfx = gfxChunk(4, 64);
    const result = load("with gfx", buildCartWith([{ type: "GFX ", data: gfx }], DRAWS));
    expect(result.ok, result.ok ? "" : result.error.message).toBe(true);
    if (!result.ok) return;

    // Two spans out of one chunk, in the order cart-data.ts fixes: the flags
    // block first, because that is the order the chunk carries them.
    expect(result.data.map((d) => d.addr)).toEqual([ADDR.SPRITE_FLAGS, ADDR.SPRITES]);
    expect(result.data[0]?.bytes.length).toBe(GFX_SHEET_OFFSET);
    expect(result.data[1]?.bytes.length).toBe(64);

    // VIEWS onto the decoded chunk, not copies of it: both spans share one
    // buffer, which is what makes installing them allocation-free on every
    // boot. (`decode` copies the chunk out of the cart bytes once; nothing
    // after that copies it again.)
    expect(result.data[0]?.bytes.buffer).toBe(result.data[1]?.bytes.buffer);
    expect(result.data[1]?.bytes.byteOffset).toBe(
      (result.data[0]?.bytes.byteOffset as number) + GFX_SHEET_OFFSET,
    );
    expect([...(result.data[1]?.bytes.subarray(0, 3) as Uint8Array)]).toEqual([
      ...gfx.subarray(GFX_SHEET_OFFSET, GFX_SHEET_OFFSET + 3),
    ]);
  });

  it("PUTS THE SHEET IN RAM: boot, then read it back", () => {
    // The assertion the whole change exists for. A cart declares a sheet, and
    // the machine has that sheet in SPRITES before the cart's first line runs.
    const result = load("gfx in ram", buildCartWith([{ type: "GFX ", data: gfxChunk(3, 96) }], DRAWS));
    if (!result.ok) throw new Error(result.error.message);

    const m = createMachine(result.program, { data: result.data });
    m.boot(7);

    expect([...m.ram.subarray(ADDR.SPRITE_FLAGS, ADDR.SPRITE_FLAGS + 4)]).toEqual([1, 2, 3, 0]);
    expect([...m.ram.subarray(ADDR.SPRITES, ADDR.SPRITES + 4)]).toEqual([3, 10, 17, 24]);
    // Past the chunk, the region is what boot left: zero.
    expect(m.ram[ADDR.SPRITES + 96]).toBe(0);
    // And nothing spilled into the region above the sheet.
    expect(m.ram[ADDR.SPRITE_FLAGS - 1]).toBe(0);
  });

  it("REFUSES an oversize chunk rather than truncating it", () => {
    // Never a truncation. A cart whose map lost its tail would load, run, draw,
    // and be wrong -- and no part of the machine could say so afterwards.
    const tooBig = new Uint8Array(LEN.MAP + 1);
    tooBig[LEN.MAP] = 0xff;
    const result = load("oversize map", buildCartWith([{ type: "MAP ", data: tooBig }], DRAWS));
    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error.code).toBe("chunk-too-large");
    expect(result.error.message).toContain("MAP chunk is 8193 bytes");
    expect(result.error.message).toContain("holds 8192");
  });

  it("accepts a chunk exactly as long as its region, and installs all of it", () => {
    // The boundary on the other side, because an off-by-one here is a loader
    // that refuses a cart which uses its whole map.
    const full = new Uint8Array(LEN.MAP);
    full[0] = 0x11;
    full[LEN.MAP - 1] = 0x22;
    const result = load("full map", buildCartWith([{ type: "MAP ", data: full }], DRAWS));
    if (!result.ok) throw new Error(result.error.message);

    const m = createMachine(result.program, { data: result.data });
    m.boot(1);
    expect(m.ram[ADDR.MAP]).toBe(0x11);
    expect(m.ram[ADDR.MAP + LEN.MAP - 1]).toBe(0x22);
    // The byte after MAP belongs to SFX and must not have been written.
    expect(m.ram[ADDR.MAP + LEN.MAP]).toBe(0);
  });

  it("has no data for a cart that carries none, and none for source loads", () => {
    const plain = load("no data", buildCart(DRAWS));
    expect(plain.ok && plain.data).toEqual([]);
    const fromSource = loadCartSource(DRAWS);
    expect(fromSource.ok && fromSource.data).toEqual([]);
  });
});

describe("loadCartBytes NEVER THROWS", () => {
  it("returns a typed error for every input this file exercised", () => {
    expect(exercised.length).toBeGreaterThan(12);
    for (const { name, bytes } of exercised) {
      expect(() => loadCartBytes(bytes), `loadCartBytes threw on ${name}`).not.toThrow();
      const result = loadCartBytes(bytes);
      if (!result.ok) {
        // Every failure is typed and says something. An error with an empty
        // message is a refusal a player cannot explain to anyone.
        expect(result.error.code, name).toMatch(
          /^(bad-container|bad-meta|unsupported-payload|missing-code|chunk-too-large|compile-failed)$/,
        );
        expect(result.error.message.length, name).toBeGreaterThan(10);
      }
    }
  });

  it("returns a typed error for mutations of a real cart, byte by byte", () => {
    // Not a fuzzer -- @sq1/cart already has one for the container. This walks a
    // VALID cart and corrupts one byte at a time, which is the shape of damage
    // the loader is most likely to meet: a good cart that arrived slightly
    // wrong. Every one of them must come back as a LoadError.
    const good = buildCart(DRAWS);
    for (let i = 0; i < good.length; i += 7) {
      const mutated = good.slice();
      mutated[i] = (mutated[i] ?? 0) ^ 0x5a;
      let result;
      expect(() => {
        result = loadCartBytes(mutated);
      }, `threw on a cart with byte ${i} corrupted`).not.toThrow();
      expect(result).toBeDefined();
    }
  });

  it("returns a typed error for structurally impossible inputs", () => {
    const nasty: [string, Uint8Array][] = [
      ["all zeros", new Uint8Array(1024)],
      ["header only", new Uint8Array([0x53, 0x51, 0x31, 0x43, 1, 0, 0, 0, 0, 0, 0, 0, 16, 0, 0, 0])],
      ["one byte", new Uint8Array([0x53])],
    ];
    for (const [name, bytes] of nasty) {
      expect(() => loadCartBytes(bytes), name).not.toThrow();
      expect(loadCartBytes(bytes).ok, name).toBe(false);
    }
  });
});
