/**
 * The system font.
 *
 * Two kinds of claim are checked here. The METRIC claims -- every code point has
 * a glyph, nothing overflows its cell, column 3 is always the gap -- are what
 * make `print` a fixed-advance loop, and they are properties of the data rather
 * than of the code, so they are checked by walking the table rather than by
 * spot-reading it. The DRAWING claims are about `raster.print`, which is where
 * the glyphs meet the framebuffer.
 *
 * The legibility claim ("is it readable at 1x?") is the one a test cannot make.
 * It is answered by the committed reference frames, which print a line of each
 * case and a line of punctuation at real size.
 */

import { describe, expect, it } from "vitest";

import {
  FONT,
  FONT_ADVANCE,
  FONT_BYTES_PER_GLYPH,
  FONT_FALLBACK,
  FONT_FIRST,
  FONT_GLYPHS,
  FONT_H,
  FONT_LAST,
  FONT_W,
  glyphRowBits,
  measure,
  measureLines,
} from "../src/font";
import { ADDR, LEN, RAM_SIZE, SCREEN_H, SCREEN_W } from "../src/memory";
import { clipReset, cls, paltReset, palt, pget, print, camera } from "../src/raster";

function freshRam(): Uint8Array {
  const ram = new Uint8Array(RAM_SIZE);
  clipReset(ram);
  paltReset(ram);
  return ram;
}

/** How many pixels of the given glyph are ink. */
function inkOf(code: number): number {
  let n = 0;
  for (let r = 0; r < FONT_H; r++) {
    const bits = glyphRowBits(code, r);
    for (let c = 0; c < FONT_W; c++) if (((bits >>> c) & 1) === 1) n++;
  }
  return n;
}

describe("the font table", () => {
  it("is 3 bytes per glyph for the whole printable range", () => {
    expect(FONT_FIRST).toBe(32);
    expect(FONT_LAST).toBe(126);
    expect(FONT_GLYPHS).toBe(95);
    expect(FONT.length).toBe(FONT_GLYPHS * FONT_BYTES_PER_GLYPH);
    expect(FONT_BYTES_PER_GLYPH * 8).toBe(FONT_W * FONT_H);
  });

  it("gives every code point in 32..126 a glyph", () => {
    for (let cp = FONT_FIRST; cp <= FONT_LAST; cp++) {
      // The space is the one glyph that is legitimately blank.
      const ink = inkOf(cp);
      if (cp === 32) expect(ink, "space must be blank").toBe(0);
      else expect(ink, `U+${cp.toString(16)} (${String.fromCharCode(cp)}) has no ink`).toBeGreaterThan(0);
    }
  });

  it("keeps every glyph inside its 4 x 6 cell", () => {
    for (let cp = FONT_FIRST; cp <= FONT_LAST; cp++) {
      for (let r = 0; r < FONT_H; r++) {
        const bits = glyphRowBits(cp, r);
        expect(bits, `${String.fromCharCode(cp)} row ${r}`).toBeLessThan(1 << FONT_W);
      }
      // Rows outside the cell read 0 rather than off the end of the table.
      expect(glyphRowBits(cp, FONT_H)).toBe(0);
      expect(glyphRowBits(cp, -1)).toBe(0);
    }
  });

  it("leaves column 3 empty in every glyph -- that column IS the advance", () => {
    for (let cp = FONT_FIRST; cp <= FONT_LAST; cp++) {
      for (let r = 0; r < FONT_H; r++) {
        expect(
          (glyphRowBits(cp, r) >>> 3) & 1,
          `${String.fromCharCode(cp)} row ${r} writes into the gap column`,
        ).toBe(0);
      }
    }
  });

  it("uses row 5 only for the characters that hang below the baseline", () => {
    const descenders = new Set("gjpqy,;_|".split("").map((s) => s.charCodeAt(0)));
    for (let cp = FONT_FIRST; cp <= FONT_LAST; cp++) {
      const below = glyphRowBits(cp, 5) !== 0;
      expect(below, `${String.fromCharCode(cp)} row 5`).toBe(descenders.has(cp));
    }
  });

  it("draws a distinct shape for upper and lower case", () => {
    for (let cp = 65; cp <= 90; cp++) {
      let same = true;
      for (let r = 0; r < FONT_H; r++) {
        if (glyphRowBits(cp, r) !== glyphRowBits(cp + 32, r)) same = false;
      }
      expect(same, `${String.fromCharCode(cp)} and its lower case are the same glyph`).toBe(false);
    }
  });

  it("falls back to '?' outside the range, and never reads off the table", () => {
    for (const cp of [0, 31, 127, 255, 0x2603, -5, 1e9]) {
      for (let r = 0; r < FONT_H; r++) {
        expect(glyphRowBits(cp, r)).toBe(glyphRowBits(FONT_FALLBACK, r));
      }
    }
  });

  it("measures a string as its widest line, and counts its lines", () => {
    expect(measure("")).toBe(0);
    expect(measure("A")).toBe(FONT_ADVANCE);
    expect(measure("ABCD")).toBe(4 * FONT_ADVANCE);
    expect(measure("AB\nABCD\nA")).toBe(4 * FONT_ADVANCE);
    expect(measureLines("")).toBe(1);
    expect(measureLines("a\nb\nc")).toBe(3);
  });
});

describe("print", () => {
  it("returns the x advance, so x + print(...) is the next pen position", () => {
    const ram = freshRam();
    expect(print(ram, "", 0, 0, 6)).toBe(0);
    expect(print(ram, "A", 0, 0, 6)).toBe(FONT_ADVANCE);
    expect(print(ram, "HELLO", 0, 8, 6)).toBe(5 * FONT_ADVANCE);
  });

  it("puts a glyph exactly where the table says, at the given colour", () => {
    const ram = freshRam();
    cls(ram, 0);
    print(ram, "A", 10, 20, 9);
    for (let r = 0; r < FONT_H; r++) {
      const bits = glyphRowBits(65, r);
      for (let c = 0; c < FONT_W; c++) {
        const want = ((bits >>> c) & 1) === 1 ? 9 : 0;
        expect(pget(ram, 10 + c, 20 + r), `pixel ${c},${r}`).toBe(want);
      }
    }
  });

  it("starts a new line on \\n and returns the LAST line's advance", () => {
    const ram = freshRam();
    cls(ram, 0);
    const adv = print(ram, "AB\nC", 4, 4, 7);
    expect(adv).toBe(1 * FONT_ADVANCE);
    // 'A' and 'B' are on the first line and 'C' is FONT_H below them, counted
    // by ink so the assertion does not depend on any one glyph's shape.
    let firstLine = 0;
    let secondLine = 0;
    for (let x = 0; x < SCREEN_W; x++) {
      for (let y = 0; y < FONT_H; y++) {
        if (pget(ram, x, 4 + y) === 7) firstLine++;
        if (pget(ram, x, 4 + FONT_H + y) === 7) secondLine++;
      }
    }
    expect(firstLine).toBe(inkOf(65) + inkOf(66));
    expect(secondLine).toBe(inkOf(67));
  });

  it("leaves the paper alone by default and paints it once colour 0 is opaque", () => {
    const ram = freshRam();
    cls(ram, 5);
    print(ram, "A", 0, 0, 9);
    let untouched = 0;
    for (let r = 0; r < FONT_H; r++) {
      for (let c = 0; c < FONT_W; c++) if (pget(ram, c, r) === 5) untouched++;
    }
    expect(untouched).toBe(FONT_W * FONT_H - inkOf(65));

    palt(ram, 0, false);
    print(ram, "A", 0, 0, 9);
    for (let r = 0; r < FONT_H; r++) {
      for (let c = 0; c < FONT_W; c++) {
        expect(pget(ram, c, r)).toBe(((glyphRowBits(65, r) >>> c) & 1) === 1 ? 9 : 0);
      }
    }
  });

  it("clips rather than corrupting memory, at every edge", () => {
    const guard = 0x5a;
    for (const [x, y] of [
      [-100, 10],
      [SCREEN_W + 10, 10],
      [10, -100],
      [10, SCREEN_H + 10],
      [-2, -2],
      [SCREEN_W - 1, SCREEN_H - 1],
      [-1000000, -1000000],
      [1000000, 1000000],
    ] as readonly (readonly [number, number])[]) {
      const ram = freshRam();
      cls(ram, 0);
      ram.fill(guard, LEN.FRAMEBUFFER, LEN.FRAMEBUFFER + 64);
      expect(() => print(ram, "THE QUICK BROWN FOX", x, y, 6)).not.toThrow();
      for (let i = LEN.FRAMEBUFFER; i < LEN.FRAMEBUFFER + 64; i++) {
        expect(ram[i], `byte ${i} past the framebuffer, printing at ${x},${y}`).toBe(guard);
      }
    }
  });

  it("draws nothing at all when a long string starts off the left edge", () => {
    const ram = freshRam();
    cls(ram, 0);
    print(ram, "AAAA", -FONT_ADVANCE * 4, 10, 6);
    let lit = 0;
    for (let y = 0; y < SCREEN_H; y++) for (let x = 0; x < SCREEN_W; x++) if (pget(ram, x, y) !== 0) lit++;
    expect(lit).toBe(0);
  });

  it("shows the tail of a string that starts off the left edge", () => {
    const ram = freshRam();
    cls(ram, 0);
    // Four characters, three of them entirely off screen.
    print(ram, "AAAB", -FONT_ADVANCE * 3, 10, 6);
    let lit = 0;
    for (let y = 0; y < SCREEN_H; y++) for (let x = 0; x < SCREEN_W; x++) if (pget(ram, x, y) !== 0) lit++;
    expect(lit).toBe(inkOf(66));
  });

  it("honours CAMERA like every other positional call", () => {
    const a = freshRam();
    cls(a, 0);
    print(a, "XY", 40, 40, 6);

    const b = freshRam();
    cls(b, 0);
    camera(b, 10, -5);
    print(b, "XY", 50, 35, 6);

    for (let i = 0; i < LEN.FRAMEBUFFER; i++) expect(b[i], `byte ${i}`).toBe(a[i]);
  });

  it("prints an out-of-range code point as '?'", () => {
    const a = freshRam();
    cls(a, 0);
    print(a, "☃", 0, 0, 6);
    const b = freshRam();
    cls(b, 0);
    print(b, "?", 0, 0, 6);
    for (let i = 0; i < LEN.FRAMEBUFFER; i++) expect(b[i]).toBe(a[i]);
  });

  it("draws nothing through an empty clip rectangle", () => {
    const ram = freshRam();
    cls(ram, 0);
    ram[ADDR.CLIP + 0] = 1;
    ram[ADDR.CLIP + 2] = 0;
    expect(print(ram, "HELLO", 0, 0, 6)).toBe(5 * FONT_ADVANCE);
    for (let i = 0; i < LEN.FRAMEBUFFER; i++) expect(ram[i]).toBe(0);
  });
});
