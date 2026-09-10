import { describe, expect, it } from "vitest";
import {
  MAX_AUTHOR_BYTES,
  MAX_TITLE_BYTES,
  decodeMeta,
  decodeUtf8,
  encodeMeta,
  encodeUtf8,
} from "../src/meta";
import type { Meta } from "../src/meta";

const BASE: Meta = {
  title: "Test Cart",
  author: "sq1",
  profile: "up",
  payload: "script/js1",
  abiMinor: 0,
  specMajor: 1,
  specMinor: 0,
};

function text(b: Uint8Array): string {
  return decodeUtf8(b) as string;
}
function bytes(s: string): Uint8Array {
  return encodeUtf8(s) as Uint8Array;
}

describe("META serialization is deterministic", () => {
  it("emits keys in a fixed sorted order, whatever order the object was built in", () => {
    // Two objects with identical content and opposite insertion order. Plain
    // JSON.stringify would emit these differently; encodeMeta must not.
    const a: Meta = {
      title: "T",
      author: "A",
      profile: "up",
      payload: "script/js1",
      abiMinor: 3,
      specMajor: 1,
      specMinor: 0,
    };
    const b = {} as Meta;
    b.specMinor = 0;
    b.specMajor = 1;
    b.abiMinor = 3;
    b.payload = "script/js1";
    b.profile = "up";
    b.author = "A";
    b.title = "T";

    expect(text(encodeMeta(a))).toBe(text(encodeMeta(b)));
    expect(text(encodeMeta(a))).toBe(
      '{"abiMinor":3,"author":"A","payload":"script/js1","profile":"up",' +
        '"specMajor":1,"specMinor":0,"title":"T"}',
    );
  });

  it("carries no timestamp, no float and no path", () => {
    const s = text(encodeMeta(BASE));
    expect(s).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(s).not.toMatch(/\d\.\d/);
    expect(s).not.toMatch(/[A-Za-z]:\\|\/home\/|\/Users\//);
  });

  it("round-trips through decodeMeta", () => {
    const m: Meta = { ...BASE, title: "Sokoban éà 日本", author: "kim", abiMinor: 7 };
    const r = decodeMeta(encodeMeta(m));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.meta).toEqual(m);
    // And is a fixed point: re-encoding the decoded meta gives the same bytes.
    expect(text(encodeMeta(r.meta))).toBe(text(encodeMeta(m)));
  });
});

describe("strict UTF-8", () => {
  it("round-trips ASCII, BMP and astral text", () => {
    for (const s of ["", "abc", "éàü", "日本語", "🎮 ok"]) {
      expect(decodeUtf8(bytes(s))).toBe(s);
    }
  });

  it("refuses a lone surrogate on encode", () => {
    expect(encodeUtf8("\ud800")).toBeNull();
    expect(encodeUtf8("a\udc00b")).toBeNull();
    expect(encodeUtf8("\ud83c")).toBeNull();
  });

  it("refuses overlong forms, surrogates, truncation and out-of-range on decode", () => {
    const cases: [string, number[]][] = [
      ["overlong two-byte NUL", [0xc0, 0x80]],
      ["overlong slash", [0xc1, 0xaf]],
      ["overlong three-byte", [0xe0, 0x80, 0x80]],
      ["overlong four-byte", [0xf0, 0x80, 0x80, 0x80]],
      ["surrogate U+D800", [0xed, 0xa0, 0x80]],
      ["truncated two-byte", [0xc3]],
      ["truncated three-byte", [0xe2, 0x82]],
      ["bad continuation", [0xc3, 0x28]],
      ["above U+10FFFF", [0xf5, 0x80, 0x80, 0x80]],
      ["stray continuation", [0x80]],
      ["0xff", [0xff]],
    ];
    for (const [name, b] of cases) {
      expect(decodeUtf8(new Uint8Array(b)), name).toBeNull();
    }
  });
});

describe("decodeMeta validates and never throws", () => {
  function meta(json: string): ReturnType<typeof decodeMeta> {
    return decodeMeta(bytes(json));
  }
  function expectBad(json: string, needle?: string): void {
    const r = meta(json);
    expect(r.ok, json).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("bad-meta");
      if (needle !== undefined) expect(r.error.message).toContain(needle);
    }
  }

  it("refuses malformed JSON without throwing", () => {
    for (const s of ["", "{", "null", "[]", '"a string"', "42", "{,}", '{"a":}', "{'a':1}"]) {
      const r = meta(s);
      expect(r.ok, JSON.stringify(s)).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("bad-meta");
    }
  });

  it("refuses malformed UTF-8 without throwing", () => {
    const r = decodeMeta(new Uint8Array([0x7b, 0xff, 0x7d]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toContain("UTF-8");
  });

  it("requires exactly the seven documented keys", () => {
    const full = text(encodeMeta(BASE));
    expectBad(full.replace('"title":"Test Cart"', '"title":"Test Cart","extra":1'), "exactly");
    expectBad(full.replace(',"specMinor":0', ""), "exactly");
  });

  it("caps title at 64 UTF-8 bytes and author at 32", () => {
    expect(decodeMeta(encodeMeta({ ...BASE, title: "x".repeat(MAX_TITLE_BYTES) })).ok).toBe(true);
    expect(() => encodeMeta({ ...BASE, title: "x".repeat(MAX_TITLE_BYTES + 1) })).toThrow(/limit/);
    expect(decodeMeta(encodeMeta({ ...BASE, author: "y".repeat(MAX_AUTHOR_BYTES) })).ok).toBe(true);
    expect(() => encodeMeta({ ...BASE, author: "y".repeat(MAX_AUTHOR_BYTES + 1) })).toThrow(/limit/);

    // The cap is bytes, not characters: 22 three-byte characters is 66 bytes.
    const wide = "日".repeat(22);
    expect(bytes(wide).length).toBe(66);
    expect(() => encodeMeta({ ...BASE, title: wide })).toThrow(/limit/);
    const handBuilt = text(encodeMeta(BASE)).replace('"Test Cart"', JSON.stringify(wide));
    expectBad(handBuilt, "UTF-8 bytes");
  });

  it("refuses control characters in title and author", () => {
    const full = text(encodeMeta(BASE));
    expectBad(full.replace('"Test Cart"', '"line\\u000aone"'), "control character");
    expectBad(full.replace('"Test Cart"', '"esc\\u001b[31m"'), "control character");
    expectBad(full.replace('"Test Cart"', '"del\\u007f"'), "control character");
    expectBad(full.replace('"sq1"', '"bad\\u0000name"'), "control character");
    expect(() => encodeMeta({ ...BASE, title: "a\nb" })).toThrow(/control character/);
  });

  it("refuses a profile or payload outside the fixed sets", () => {
    const full = text(encodeMeta(BASE));
    expectBad(full.replace('"profile":"up"', '"profile":"pro"'), "profile");
    expectBad(full.replace('"profile":"up"', '"profile":1'), "profile");
    expectBad(full.replace('"payload":"script/js1"', '"payload":"script/js2"'), "payload");
    expectBad(full.replace('"payload":"script/js1"', '"payload":null'), "payload");
    // wasm/1 is reserved but valid.
    expect(decodeMeta(encodeMeta({ ...BASE, payload: "wasm/1" })).ok).toBe(true);
  });

  it("refuses a non-integer, negative or absurd abiMinor", () => {
    const full = text(encodeMeta(BASE));
    for (const v of ["-1", "1.5", '"3"', "null", "70000", "1e400"]) {
      expectBad(full.replace('"abiMinor":0', `"abiMinor":${v}`), "abiMinor");
    }
    expect(() => encodeMeta({ ...BASE, abiMinor: -1 })).toThrow(/abiMinor/);
    expect(() => encodeMeta({ ...BASE, abiMinor: 1.5 })).toThrow(/abiMinor/);
  });

  it("refuses a non-integer spec version", () => {
    const full = text(encodeMeta(BASE));
    expectBad(full.replace('"specMajor":1', '"specMajor":-1'), "specMajor");
    expectBad(full.replace('"specMinor":0', '"specMinor":"0"'), "specMinor");
  });

  it("refuses a __proto__ key rather than letting it through", () => {
    const full = text(encodeMeta(BASE));
    expectBad(full.replace("{", '{"__proto__":{"x":1},'));
  });
});
