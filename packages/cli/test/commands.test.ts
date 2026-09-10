import { describe, it, expect } from "vitest";

import { encode, decode, MAX_CART_BYTES } from "@sq1/cart";

import { parseArgs, UsageError } from "../src/args";
import type { CommandIO } from "../src/args";
import { buildCommand, TOKEN_BUDGET } from "../src/commands/build";
import {
  stampCommand,
  defaultOut as defaultStampOut,
  resolveRecipePath,
} from "../src/commands/stamp";
import { validateCommand } from "../src/commands/validate";
import { hashCommand } from "../src/commands/hash";
import { inspectCommand } from "../src/commands/inspect";

/*
 * Every command runs against an in-memory `CommandIO`: a Map for files, two
 * arrays for the streams. No temporary directory, no cleanup, nothing left
 * behind, and no test that passes only on the machine that wrote it.
 *
 * The memory filesystem also buys the determinism test below its teeth. Two
 * builds of the same source from "/one/hello" and "/two/deeper/hello" are two
 * different working directories as far as every path in this tool is
 * concerned, and the cart bytes have to come out identical.
 */

const enc = new TextEncoder();

interface Harness {
  readonly io: CommandIO;
  readonly files: Map<string, Uint8Array>;
  stdout(): string;
  stderr(): string;
  /** Forget what has been printed so far, so the next command's output stands alone. */
  reset(): void;
}

function harness(seed: Record<string, string | Uint8Array>): Harness {
  const files = new Map<string, Uint8Array>();
  for (const [path, content] of Object.entries(seed)) {
    files.set(path, typeof content === "string" ? enc.encode(content) : content);
  }

  /** Every ancestor directory of every seeded file, so `exists` knows them. */
  const dirs = new Set<string>();
  for (const path of files.keys()) {
    let cut = path.lastIndexOf("/");
    while (cut > 0) {
      dirs.add(path.slice(0, cut));
      cut = path.slice(0, cut).lastIndexOf("/");
    }
  }

  const out: string[] = [];
  const err: string[] = [];

  const io: CommandIO = {
    readFile(p) {
      const b = files.get(p);
      if (b === undefined) throw new Error(`test io: nothing at ${p}`);
      return b;
    },
    writeFile(p, b) {
      files.set(p, b);
    },
    readDir(p) {
      const prefix = `${p.replace(/\/+$/, "")}/`;
      const names = new Set<string>();
      for (const path of files.keys()) {
        if (path.startsWith(prefix)) names.add(path.slice(prefix.length).split("/")[0] as string);
      }
      return [...names];
    },
    exists(p) {
      return files.has(p) || dirs.has(p.replace(/\/+$/, ""));
    },
    out(s) {
      out.push(s);
    },
    err(s) {
      err.push(s);
    },
  };

  return {
    io,
    files,
    stdout: () => out.join(""),
    stderr: () => err.join(""),
    reset: () => {
      out.length = 0;
      err.length = 0;
    },
  };
}

/** The token count of MAIN_JS, counted by hand against the normative rules. */
const MAIN_JS_TOKENS = 19;

const MAIN_JS = 'function boot() {}\nfunction tick() { gfx.cls(1); }\n';
const CART_JSON = '{ "title": "Hello", "author": "square one" }\n';

/** A source directory that builds. */
function source(dir: string): Record<string, string> {
  return { [`${dir}/main.js`]: MAIN_JS, [`${dir}/cart.json`]: CART_JSON };
}

/**
 * Build once and hand back the harness plus the bytes that were written, with
 * the streams cleared -- so a test of `hash` sees only what `hash` printed.
 */
function built(dir = "/src", out = "/src.cart"): { h: Harness; bytes: Uint8Array } {
  const h = harness(source(dir));
  const code = buildCommand(parseArgs(["build", dir, "--out", out]), h.io);
  expect(code).toBe(0);
  h.reset();
  return { h, bytes: h.files.get(out) as Uint8Array };
}

describe("build", () => {
  it("writes a cart and reports the id, the size and the token count", () => {
    const h = harness(source("/src"));
    expect(buildCommand(parseArgs(["build", "/src"]), h.io)).toBe(0);

    const bytes = h.files.get("/src.cart");
    expect(bytes).toBeDefined();
    expect(h.stderr()).toBe("");

    const lines = h.stdout().trimEnd().split("\n");
    expect(lines).toHaveLength(4);
    // The id is 32 Crockford base32 characters in four groups of eight.
    expect(lines[0]).toMatch(/^ {4}id {2}[0-9A-Z]{8}-[0-9A-Z]{8}-[0-9A-Z]{8}-[0-9A-Z]{8}$/);
    expect(lines[1]).toBe(`  size  ${(bytes as Uint8Array).length} of ${MAX_CART_BYTES} bytes`);
    expect(lines[2]).toBe(`tokens  ${MAIN_JS_TOKENS} of ${TOKEN_BUDGET}`);
    expect(lines[3]).toBe(" wrote  /src.cart");
  });

  it("writes a cart that decodes, with META and CODE in it", () => {
    const { bytes } = built();
    const result = decode(bytes);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cart.chunks.map((c) => c.type)).toEqual(["META", "CODE"]);
  });

  it("picks up every optional file, and ignores files that are not cart source", () => {
    const h = harness({
      ...source("/src"),
      "/src/gfx.bin": new Uint8Array([1, 2, 3]),
      "/src/map.bin": new Uint8Array([4]),
      "/src/sfx.bin": new Uint8Array([5]),
      "/src/mus.bin": new Uint8Array([6]),
      "/src/data.bin": new Uint8Array([7]),
      "/src/label.bin": new Uint8Array([8]),
      "/src/README.md": "not a chunk",
      "/src/scratch.png": "not a chunk either",
    });
    expect(buildCommand(parseArgs(["build", "/src"]), h.io)).toBe(0);

    const result = decode(h.files.get("/src.cart") as Uint8Array);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cart.chunks.map((c) => c.type)).toEqual([
      "META",
      "CODE",
      "GFX ",
      "MAP ",
      "SFX ",
      "MUS ",
      "DATA",
      "labl",
    ]);
  });

  it("is byte-identical from two different working directories", () => {
    // The same source, built from two different places, to two different
    // output paths. Anything environmental reaching the bytes -- a timestamp,
    // an absolute path, a directory listing order -- shows up here.
    const one = harness(source("/one/hello"));
    const two = harness({
      ...source("/two/deeper/hello"),
      "/two/deeper/hello/README.md": "ignored",
    });

    expect(buildCommand(parseArgs(["build", "/one/hello"]), one.io)).toBe(0);
    expect(
      buildCommand(parseArgs(["build", "/two/deeper/hello", "--out", "/elsewhere/x.cart"]), two.io),
    ).toBe(0);

    const a = one.files.get("/one/hello.cart") as Uint8Array;
    const b = two.files.get("/elsewhere/x.cart") as Uint8Array;
    expect([...b]).toEqual([...a]);

    // And so is everything printed above the line that names the file.
    const head = (s: string): string => s.split("\n").slice(0, 3).join("\n");
    expect(head(two.stdout())).toBe(head(one.stdout()));
  });

  it("refuses a directory with no main.js, and says what is in it instead", () => {
    const h = harness({ "/src/cart.json": CART_JSON, "/src/game.js": MAIN_JS });
    expect(buildCommand(parseArgs(["build", "/src"]), h.io)).toBe(1);
    expect(h.stdout()).toBe("");
    expect(h.stderr()).toBe(
      "/src/main.js not found\n" +
        "A cart source directory needs main.js (the code) and cart.json (the title and author).\n" +
        "/src holds: cart.json, game.js\n",
    );
    expect(h.files.has("/src.cart")).toBe(false);
  });

  it("refuses a directory with no cart.json", () => {
    const h = harness({ "/src/main.js": MAIN_JS });
    expect(buildCommand(parseArgs(["build", "/src"]), h.io)).toBe(1);
    expect(h.stderr()).toContain("/src/cart.json not found");
  });

  it("refuses a directory that is not there, without mentioning errno", () => {
    const h = harness(source("/src"));
    expect(buildCommand(parseArgs(["build", "/nope"]), h.io)).toBe(1);
    expect(h.stderr()).toBe(
      "no directory at /nope\n" +
        "sq1 build takes the directory holding main.js and cart.json, not the file itself.\n",
    );
  });

  it("refuses malformed cart.json and shows the shape it wanted", () => {
    const h = harness({ ...source("/src"), "/src/cart.json": '{ "title": "Hello", }' });
    expect(buildCommand(parseArgs(["build", "/src"]), h.io)).toBe(1);
    expect(h.stderr()).toContain("/src/cart.json is not valid JSON:");
    expect(h.stderr()).toContain('A cart.json is one object, like { "title": "Hello", "author": "your name" }');
    expect(h.files.has("/src.cart")).toBe(false);
  });

  it("refuses cart.json with no author", () => {
    const h = harness({ ...source("/src"), "/src/cart.json": '{ "title": "Hello" }' });
    expect(buildCommand(parseArgs(["build", "/src"]), h.io)).toBe(1);
    expect(h.stderr()).toContain('/src/cart.json has no "author"');
  });

  it("refuses a payload type that is not one of the two", () => {
    const h = harness({
      ...source("/src"),
      "/src/cart.json": '{ "title": "H", "author": "a", "payload": "script/js2" }',
    });
    expect(buildCommand(parseArgs(["build", "/src"]), h.io)).toBe(1);
    expect(h.stderr()).toContain('"payload" must be "script/js1" or "wasm/1"');
  });

  it("refuses a title the container cannot hold, naming the file it came from", () => {
    const h = harness({
      ...source("/src"),
      "/src/cart.json": JSON.stringify({ title: "x".repeat(100), author: "a" }),
    });
    expect(buildCommand(parseArgs(["build", "/src"]), h.io)).toBe(1);
    expect(h.stderr()).toContain("/src/cart.json: title is 100 UTF-8 bytes");
  });

  it("refuses a cart over the token budget, reporting the count and the overage", () => {
    // Generated rather than hand-written: five tokens a line (`var`, `a`, `=`,
    // `0`, `;`), so 2000 lines is 10000 tokens and the arithmetic below stays
    // true if the budget ever moves.
    const lines = 2000;
    const h = harness({ ...source("/src"), "/src/main.js": "var a = 0;\n".repeat(lines) });
    expect(buildCommand(parseArgs(["build", "/src"]), h.io)).toBe(1);
    expect(h.stderr()).toBe(
      `/src/main.js is ${lines * 5} tokens, which is ${lines * 5 - TOKEN_BUDGET} over the ` +
        `${TOKEN_BUDGET}-token budget.\n` +
        "Every token counts as one, including punctuation. Shorten the cart, or move " +
        "table-shaped data out of main.js and into data.bin.\n",
    );
    expect(h.files.has("/src.cart")).toBe(false);
  });

  it("refuses a cart over the size budget, reporting the overage", () => {
    const h = harness({ ...source("/src"), "/src/data.bin": new Uint8Array(MAX_CART_BYTES) });
    expect(buildCommand(parseArgs(["build", "/src"]), h.io)).toBe(1);
    expect(h.stderr()).toMatch(/^the cart is \d+ bytes, which is \d+ over the 65536-byte cart budget\./);
    expect(h.files.has("/src.cart")).toBe(false);
  });

  it("refuses main.js that is not JavaScript, before writing anything", () => {
    const h = harness({ ...source("/src"), "/src/main.js": 'var s = "unterminated\n' });
    expect(buildCommand(parseArgs(["build", "/src"]), h.io)).toBe(1);
    expect(h.stderr()).toContain("/src/main.js is not valid JavaScript:");
    expect(h.files.has("/src.cart")).toBe(false);
  });

  it("needs a directory", () => {
    const h = harness({});
    expect(() => buildCommand(parseArgs(["build"]), h.io)).toThrow(UsageError);
  });
});

describe("build - the static gate", () => {
  it("refuses a cart that names Math, pointing at the line and column", () => {
    const h = harness({
      ...source("/src"),
      "/src/main.js": "function tick() {\n  var x = 1;\n    var y = Math.floor(x);\n}\n",
    });
    expect(buildCommand(parseArgs(["build", "/src"]), h.io)).toBe(1);
    expect(h.stdout()).toBe("");
    expect(h.stderr()).toBe(
      "/src/main.js:3:13  Math is not available in a cart. " +
        "Use sys.sin, sys.cos, sys.rnd, or fixed-point arithmetic.\n",
    );
    expect(h.files.has("/src.cart")).toBe(false);
  });

  it("accepts obj.Math, which is a property and not the global", () => {
    const h = harness({
      ...source("/src"),
      "/src/main.js": "function tick() { var y = obj.Math; }\n",
    });
    expect(buildCommand(parseArgs(["build", "/src"]), h.io)).toBe(0);
    expect(h.stderr()).toBe("");
    expect(h.files.has("/src.cart")).toBe(true);
  });

  it("prints one line per finding, in source order", () => {
    const h = harness({
      ...source("/src"),
      "/src/main.js": "function tick() {\n  fetch(1);\n  var d = new Date();\n}\n",
    });
    expect(buildCommand(parseArgs(["build", "/src"]), h.io)).toBe(1);
    const lines = h.stderr().trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]?.startsWith("/src/main.js:2:3  fetch is not available in a cart.")).toBe(true);
    expect(lines[1]?.startsWith("/src/main.js:3:15  Date is not available in a cart.")).toBe(true);
  });

  it("refuses a cart with no tick, and says what to write", () => {
    const h = harness({ ...source("/src"), "/src/main.js": "function boot() { gfx.cls(1); }\n" });
    expect(buildCommand(parseArgs(["build", "/src"]), h.io)).toBe(1);
    expect(h.stderr()).toContain("/src/main.js:1:1  This cart has no top-level tick()");
    expect(h.files.has("/src.cart")).toBe(false);
  });

  it("refuses an empty main.js", () => {
    const h = harness({ ...source("/src"), "/src/main.js": "\n// nothing here yet\n" });
    expect(buildCommand(parseArgs(["build", "/src"]), h.io)).toBe(1);
    expect(h.stderr()).toContain("/src/main.js:1:1  This cart has no code.");
  });

  it("still reports the token budget in its own words, and alone", () => {
    // Over budget AND missing a tick: the count is the only thing the author
    // can act on, so it is the only thing printed.
    const h = harness({ ...source("/src"), "/src/main.js": "var a = Math;\n".repeat(2000) });
    expect(buildCommand(parseArgs(["build", "/src"]), h.io)).toBe(1);
    expect(h.stderr().split("\n")[0]).toMatch(/^\/src\/main\.js is \d+ tokens, which is \d+ over the/);
    expect(h.stderr()).not.toContain("sys.sin");
  });

  it("builds the example cart in the repository, unchanged", async () => {
    // examples/hello is what the documentation tells an author to copy. The
    // gate and the example have to agree, and this is where they are compared.
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const at = (name: string): string =>
      fileURLToPath(new URL(`../../../examples/hello/${name}`, import.meta.url));
    const h = harness({
      "/src/main.js": readFileSync(at("main.js"), "utf8"),
      "/src/cart.json": readFileSync(at("cart.json"), "utf8"),
    });
    expect(buildCommand(parseArgs(["build", "/src"]), h.io)).toBe(0);
    expect(h.stderr()).toBe("");
  });
});

describe("validate", () => {
  it("accepts a cart the tool just built", () => {
    const { h } = built();
    expect(validateCommand(parseArgs(["validate", "/src.cart"]), h.io)).toBe(0);
    expect(h.stderr()).toBe("");
    expect(h.stdout()).toContain("/src.cart: ok");
    expect(h.stdout()).toContain("chunks  2");
  });

  it("reports a corrupt cart with its code, its offset and a message", () => {
    const { h, bytes } = built();
    const corrupt = bytes.slice();
    corrupt[0] = 0x00; // "SQ1C" -> "\0Q1C"
    h.files.set("/corrupt.cart", corrupt);

    expect(validateCommand(parseArgs(["validate", "/corrupt.cart"]), h.io)).toBe(1);
    expect(h.stdout()).toBe("");
    expect(h.stderr()).toMatch(/^\/corrupt\.cart: bad-magic at 0x0000\n {2}\S/);
  });

  it("reports a truncated cart rather than throwing", () => {
    const { h, bytes } = built();
    h.files.set("/short.cart", bytes.slice(0, bytes.length - 8));
    expect(validateCommand(parseArgs(["validate", "/short.cart"]), h.io)).toBe(1);
    expect(h.stderr()).toContain("/short.cart: ");
  });

  it("says where to get a cart when the file is not there", () => {
    const h = harness({});
    expect(validateCommand(parseArgs(["validate", "/nope.cart"]), h.io)).toBe(1);
    expect(h.stderr()).toBe(
      "no file at /nope.cart\nBuild one first: sq1 build <dir> --out /nope.cart\n",
    );
  });

  it("passes a cart carrying an unknown ancillary chunk, and says it was skipped", () => {
    // The whole point of the lowercase rule. A cart from a later version of the
    // tools plays here, and the tool says so without calling it a warning.
    const { h, bytes } = built();
    const result = decode(bytes);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const extended = encode({
      specMajor: result.cart.specMajor,
      specMinor: result.cart.specMinor,
      chunks: [...result.cart.chunks, { type: "zzzz", data: enc.encode("from the future") }],
    });
    h.files.set("/future.cart", extended);

    expect(validateCommand(parseArgs(["validate", "/future.cart"]), h.io)).toBe(0);
    expect(h.stdout()).toContain("skipped zzzz, 15 bytes: a chunk this version does not know.");
    expect(h.stdout()).toContain("Ancillary, so a player ignores it and runs the cart.");
  });
});

describe("hash", () => {
  it("prints the id and nothing else", () => {
    const { h } = built();
    expect(hashCommand(parseArgs(["hash", "/src.cart"]), h.io)).toBe(0);
    expect(h.stderr()).toBe("");
    expect(h.stdout()).toMatch(/^[0-9A-Z]{32}\n$/);
  });

  it("groups the id with --format long", () => {
    const { h } = built();
    expect(hashCommand(parseArgs(["hash", "/src.cart", "--format", "long"]), h.io)).toBe(0);
    expect(h.stdout()).toMatch(/^[0-9A-Z]{8}-[0-9A-Z]{8}-[0-9A-Z]{8}-[0-9A-Z]{8}\n$/);
  });

  it("gives the same id to the same content built in two places", () => {
    const a = built("/one/hello", "/a.cart");
    const b = built("/two/deeper/hello", "/b.cart");
    expect(hashCommand(parseArgs(["hash", "/a.cart"]), a.h.io)).toBe(0);
    expect(hashCommand(parseArgs(["hash", "/b.cart"]), b.h.io)).toBe(0);
    expect(b.h.stdout()).toBe(a.h.stdout());
  });

  it("refuses a --format it does not have, naming both it accepts", () => {
    const { h } = built();
    expect(() => hashCommand(parseArgs(["hash", "/src.cart", "--format", "csv"]), h.io)).toThrow(
      /--format takes short or long, not "csv"\./,
    );
  });

  it("reports a bad file on stderr, leaving stdout empty for the pipe", () => {
    const h = harness({});
    expect(hashCommand(parseArgs(["hash", "/nope.cart"]), h.io)).toBe(1);
    expect(h.stdout()).toBe("");
    expect(h.stderr()).toContain("no file at /nope.cart");
  });
});

describe("inspect", () => {
  it("dumps the header, the chunks, the meta and the budgets", () => {
    const h = harness({
      ...source("/src"),
      "/src/gfx.bin": new Uint8Array(64),
      "/src/label.bin": new Uint8Array(32),
    });
    expect(buildCommand(parseArgs(["build", "/src"]), h.io)).toBe(0);
    expect(inspectCommand(parseArgs(["inspect", "/src.cart"]), h.io)).toBe(0);

    const text = h.stdout();
    expect(text).toContain("file   /src.cart");
    expect(text).toContain("magic  SQ1C");
    expect(text).toContain("spec   1.0");
    expect(text).toContain("chunks  4");
    // The header is 16 bytes, so the first chunk starts at 0x0010.
    expect(text).toContain("0x0010");
    expect(text).toContain('"GFX "'); // the trailing space is part of the type
    expect(text).toContain("critical");
    expect(text).toContain("ancillary");
    expect(text).toContain("title    Hello");
    expect(text).toContain("author   square one");
    expect(text).toContain("payload  script/js1");
    expect(text).toContain(`tokens  ${MAIN_JS_TOKENS} of ${TOKEN_BUDGET}`);
    expect(h.stderr()).toBe("");
  });

  it("marks an unknown chunk in words", () => {
    const { h, bytes } = built();
    const result = decode(bytes);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    h.files.set(
      "/future.cart",
      encode({
        specMajor: result.cart.specMajor,
        specMinor: result.cart.specMinor,
        chunks: [...result.cart.chunks, { type: "zzzz", data: new Uint8Array(4) }],
      }),
    );

    expect(inspectCommand(parseArgs(["inspect", "/future.cart"]), h.io)).toBe(0);
    expect(h.stdout()).toContain("UNKNOWN - a player skips this chunk and runs the cart");
  });

  it("aligns its columns", () => {
    const { h } = built();
    expect(inspectCommand(parseArgs(["inspect", "/src.cart"]), h.io)).toBe(0);
    const rows = h
      .stdout()
      .split("\n")
      .filter((l) => /^ {2}\d+ {2}(META|CODE)/.test(l));
    expect(rows).toHaveLength(2);
    // Both rows put their `critical` in the same column.
    expect(rows[0]?.indexOf("critical")).toBe(rows[1]?.indexOf("critical"));
  });

  it("reports a file it cannot decode instead of dumping half a cart", () => {
    const h = harness({ "/junk.cart": "this is not a cart" });
    expect(inspectCommand(parseArgs(["inspect", "/junk.cart"]), h.io)).toBe(1);
    expect(h.stdout()).toBe("");
    expect(h.stderr()).toContain("/junk.cart: bad-magic");
  });
});

/*
 * `sq1 stamp` -- the same in-memory harness, one command further along.
 *
 * The fixture modules live in the Map, so this suite does not wait on
 * `modules/platformer` being authored, and the reproducibility test gets its
 * teeth from the same place `build`'s does: two different working directories,
 * one set of bytes.
 */

const ENGINE_TOML = `[module]
kind    = "engine"
name    = "runner"
version = "1.0.0"

[requires]
palette = true

[knobs.gravity]
type    = "fixed"
default = 0.42
min     = 0.0
max     = 4.0

[knobs.jump_velocity]
type = "fixed"
min  = -8.0
max  = 0.0
doc  = "upward speed of a jump."
`;

const ENGINE_SRC = `function boot() { sys.poke(0x7800, 60); }
function tick() {
  gfx.cls(0);
  gfx.rect(8, sys.peek(0x7800), 8, 8, 9, true);
  gfx.pset((sys.frame() + ((KNOB.gravity * 64) | 0)) & 127, ((KNOB.jumpVelocity * -8) | 0) & 127, 7);
}
`;

const PALETTE = `[module]
kind    = "palette"
name    = "sweet"
version = "1.0.0"
`;

const RECIPE_TOML = `[cart]
title  = "Cave Runner"
author = "eric"

[engine]
use = "runner@1.0.0"

[modules]
palette = "sweet@1.0.0"

[tuning]
jump_velocity = -3.1
`;

/** The fixture project: a module root, and a recipe beside it. */
function project(root: string, extra: Record<string, string | Uint8Array> = {}) {
  return {
    [`${root}/modules/runner/module.toml`]: ENGINE_TOML,
    [`${root}/modules/runner/engine.js`]: ENGINE_SRC,
    [`${root}/modules/sweet/module.toml`]: PALETTE,
    [`${root}/recipe.toml`]: RECIPE_TOML,
    ...extra,
  };
}

describe("stamp", () => {
  it("writes a proved cart and reports the id, size, tokens and frames", () => {
    const h = harness(project("/proj"));
    expect(
      stampCommand(parseArgs(["stamp", "/proj/recipe.toml", "--frames", "24"]), h.io),
    ).toBe(0);
    expect(h.stderr()).toBe("");

    const bytes = h.files.get("/proj/recipe.cart");
    expect(bytes).toBeDefined();

    const lines = h.stdout().trimEnd().split("\n");
    expect(lines).toHaveLength(5);
    expect(lines[0]).toMatch(/^ {4}id {2}[0-9A-Z]{8}-[0-9A-Z]{8}-[0-9A-Z]{8}-[0-9A-Z]{8}$/);
    expect(lines[1]).toBe(`  size  ${(bytes as Uint8Array).length} of ${MAX_CART_BYTES} bytes`);
    expect(lines[2]).toMatch(/^tokens {2}\d+ of 8192$/);
    expect(lines[3]).toMatch(/^proved {2}24 frames, chain [0-9a-f]{64}$/);
    expect(lines[4]).toBe(" wrote  /proj/recipe.cart");
  });

  it("writes a cart the runtime can decode and the CLI can validate", () => {
    const h = harness(project("/proj"));
    expect(stampCommand(parseArgs(["stamp", "/proj/recipe.toml", "--frames", "8"]), h.io)).toBe(0);
    h.reset();
    expect(validateCommand(parseArgs(["validate", "/proj/recipe.cart"]), h.io)).toBe(0);
    expect(h.stderr()).toBe("");

    const decoded = decode(h.files.get("/proj/recipe.cart") as Uint8Array);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.cart.chunks.map((c) => c.type)).toEqual(["META", "CODE", "rcpe"]);
  });

  it("honours --out", () => {
    const h = harness(project("/proj"));
    expect(
      stampCommand(
        parseArgs(["stamp", "/proj/recipe.toml", "--out", "/build/game.cart", "--frames", "8"]),
        h.io,
      ),
    ).toBe(0);
    expect(h.files.has("/build/game.cart")).toBe(true);
    expect(h.files.has("/proj/recipe.cart")).toBe(false);
  });

  it("finds the module root by walking up from the recipe", () => {
    // The recipe is two directories below the module root, which is where a
    // recipe actually sits in a project. Nothing about where it was found
    // reaches the cart -- the next test is what pins that.
    const h = harness(project("/proj", { "/proj/games/deep/cave.toml": RECIPE_TOML }));
    expect(
      stampCommand(parseArgs(["stamp", "/proj/games/deep/cave.toml", "--frames", "8"]), h.io),
    ).toBe(0);
    expect(h.files.has("/proj/games/deep/cave.cart")).toBe(true);
  });

  it("is byte-identical from two different working directories", () => {
    const one = harness(project("/one"));
    const two = harness(project("/two/deeper", { "/two/deeper/games/x.toml": RECIPE_TOML }));

    expect(stampCommand(parseArgs(["stamp", "/one/recipe.toml", "--frames", "24"]), one.io)).toBe(0);
    expect(
      stampCommand(
        parseArgs(["stamp", "/two/deeper/games/x.toml", "--out", "/elsewhere/y.cart", "--frames", "24"]),
        two.io,
      ),
    ).toBe(0);

    const a = one.files.get("/one/recipe.cart") as Uint8Array;
    const b = two.files.get("/elsewhere/y.cart") as Uint8Array;
    expect([...b]).toEqual([...a]);

    // And so is everything printed above the line that names the file.
    const head = (s: string): string => s.split("\n").slice(0, 4).join("\n");
    expect(head(two.stdout())).toBe(head(one.stdout()));
  });

  it("takes an explicit --modules root", () => {
    const h = harness({
      ...project("/proj"),
      "/other/runner/module.toml": ENGINE_TOML,
      "/other/runner/engine.js": ENGINE_SRC,
      "/other/sweet/module.toml": PALETTE,
    });
    expect(
      stampCommand(
        parseArgs(["stamp", "/proj/recipe.toml", "--modules", "/other", "--frames", "8"]),
        h.io,
      ),
    ).toBe(0);
    expect(h.files.has("/proj/recipe.cart")).toBe(true);
  });

  it("prints a positioned diagnostic and writes nothing when a knob is unbound", () => {
    const h = harness(project("/proj", {
      "/proj/recipe.toml": RECIPE_TOML.replace("jump_velocity = -3.1\n", ""),
    }));
    expect(stampCommand(parseArgs(["stamp", "/proj/recipe.toml"]), h.io)).toBe(1);
    expect(h.stdout()).toBe("");
    expect(h.stderr()).toBe(
      "/proj/recipe.toml:11:1  error[unbound-knob]  engine runner@1.0.0 requires knob `jump_velocity`,\n" +
        "                  which the [tuning] table does not set.\n" +
        "                  Add:  jump_velocity = -4.0   # -8.0 .. 0.0, upward speed of a jump\n",
    );
    expect(h.files.has("/proj/recipe.cart")).toBe(false);
  });

  it("says there is no recipe, rather than an errno", () => {
    const h = harness(project("/proj"));
    expect(stampCommand(parseArgs(["stamp", "/proj/nope.toml"]), h.io)).toBe(1);
    expect(h.stderr()).toContain("error[missing-recipe]  there is no recipe at /proj/nope.toml.");
  });

  it("refuses a --frames that is not a positive whole number", () => {
    const h = harness(project("/proj"));
    for (const bad of ["zero", "-1", "1.5", "0"]) {
      expect(() =>
        stampCommand(parseArgs(["stamp", "/proj/recipe.toml", "--frames", bad]), h.io),
      ).toThrow(UsageError);
    }
  });

  it("needs a recipe path", () => {
    const h = harness({});
    expect(() => stampCommand(parseArgs(["stamp"]), h.io)).toThrow(/sq1 stamp needs <recipe>/);
  });

  it("turns recipe.toml into recipe.cart and leaves other names alone", () => {
    expect(defaultStampOut("games/cave.toml")).toBe("games/cave.cart");
    expect(defaultStampOut("games/cave.TOML")).toBe("games/cave.cart");
    expect(defaultStampOut("cave")).toBe("cave.cart");
    expect(defaultStampOut("games/cave-runner/")).toBe("games/cave-runner.cart");
  });

  it("takes the DIRECTORY holding a recipe, the way build takes a source directory", () => {
    // `examples/cave-runner` is what a game is called; the recipe.toml inside
    // it is where the text happens to live, and an author should not have to
    // type the second to mean the first. The output follows the operand.
    const h = harness({
      "/proj/modules/runner/module.toml": ENGINE_TOML,
      "/proj/modules/runner/engine.js": ENGINE_SRC,
      "/proj/modules/sweet/module.toml": PALETTE,
      "/proj/games/cave-runner/recipe.toml": RECIPE_TOML,
    });
    expect(
      stampCommand(parseArgs(["stamp", "/proj/games/cave-runner", "--frames", "8"]), h.io),
    ).toBe(0);
    expect(h.files.has("/proj/games/cave-runner.cart")).toBe(true);
    expect(h.stdout()).toContain(" wrote  /proj/games/cave-runner.cart");
  });

  it("resolves a directory to the recipe.toml inside it, and a file to itself", () => {
    const h = harness({ "/proj/game/recipe.toml": RECIPE_TOML, "/proj/other.toml": RECIPE_TOML });
    expect(resolveRecipePath(h.io, "/proj/game")).toBe("/proj/game/recipe.toml");
    expect(resolveRecipePath(h.io, "/proj/game/")).toBe("/proj/game/recipe.toml");
    expect(resolveRecipePath(h.io, "/proj/other.toml")).toBe("/proj/other.toml");
    // Nothing there at all resolves to what was typed, so the message names it.
    expect(resolveRecipePath(h.io, "/proj/nope")).toBe("/proj/nope");
  });

  it("names the engine inside [modules], the way the module packs do", () => {
    const viaModules = RECIPE_TOML.replace(
      '[engine]\nuse = "runner@1.0.0"\n\n[modules]\n',
      '[modules]\nengine  = "runner@1.0.0"\n',
    );
    const h = harness(project("/proj", { "/proj/recipe.toml": viaModules }));
    expect(stampCommand(parseArgs(["stamp", "/proj/recipe.toml", "--frames", "8"]), h.io)).toBe(0);
    expect(h.files.has("/proj/recipe.cart")).toBe(true);
  });
});
