/**
 * The system font: 4 x 6, ASCII 32..126.
 *
 * WHY 4 x 6 AND NOT SOMETHING PRETTIER
 * ------------------------------------
 * The screen is 128 pixels wide. At a 4-pixel advance a line holds 32
 * characters, which is enough for a score, a name, a menu row and a line of
 * dialogue -- and it is the largest cell that still gives 32 columns. Inside the
 * 4 x 6 cell the ink lives in a 3 x 5 box: column 3 is the inter-character gap
 * and row 5 is the descender row, used only by `g j p q y , ; _ |`. So capitals
 * are 5 pixels tall, lower case is 3 with ascenders reaching 5, and nothing ever
 * touches its neighbour. That is the whole metric system; there is no kerning
 * and no variable width, because a fixed cell is what makes `print` a loop with
 * no state.
 *
 * WHY THE SOURCE IS A PICTURE AND THE RUNTIME FORM IS BITS
 * -------------------------------------------------------
 * `GLYPH_ART` below is the font. Each entry is six rows of four cells separated
 * by `/`, `#` for ink and `.` for paper, in code-point order starting at 32.
 * `packGlyphs` turns that into 3 bytes per glyph once, at module load, and every
 * draw reads the packed form.
 *
 * TO EDIT A GLYPH: change its row strings. Nothing else. The packer validates
 * shape (six groups, four cells, only `#` and `.`) and throws on a typo rather
 * than shipping a font with a hole in it, and font.test.ts checks the metrics --
 * that column 3 is empty in every glyph, that row 5 is empty except in the
 * characters listed above, and that the table covers 32..126 with no gaps.
 *
 * WHY THERE IS NO `print` IN THIS FILE
 * ------------------------------------
 * Drawing needs CLIP, CAMERA and the packed-nibble framebuffer, all of which
 * live in `raster.ts`. If this module imported them the two files would import
 * each other. So this one owns the glyphs and the metrics, `raster.print` owns
 * the pixels, and the dependency runs one way: raster -> font.
 */

/** Cell width in pixels. Column 3 is the gap, so ink occupies columns 0..2. */
export const FONT_W = 4;

/** Cell height in pixels. Row 5 is the descender row. */
export const FONT_H = 6;

/** Pixels the pen moves per character. Equal to the cell width: no kerning. */
export const FONT_ADVANCE = 4;

/** First code point with a glyph. */
export const FONT_FIRST = 32;

/** Last code point with a glyph. */
export const FONT_LAST = 126;

/** Glyphs in the table. */
export const FONT_GLYPHS = FONT_LAST - FONT_FIRST + 1;

/** Bytes per glyph: six rows of four bits, two rows per byte. */
export const FONT_BYTES_PER_GLYPH = 3;

/**
 * What a code point outside FONT_FIRST..FONT_LAST is drawn as.
 *
 * A question mark rather than nothing: a cart that prints a string it did not
 * expect should see that it did, not silently lose characters.
 */
export const FONT_FALLBACK = 0x3f; // '?'

/**
 * The font, as pictures. One entry per code point from 32 upward.
 *
 * Six groups of four, `/`-separated, top row first. `#` is ink.
 */
const GLYPH_ART: readonly string[] = [
  "..../..../..../..../..../....", // 32  space
  ".#../.#../.#../..../.#../....", // 33  !
  "#.#./#.#./..../..../..../....", // 34  "
  "#.#./###./#.#./###./#.#./....", // 35  #
  ".##./##../.#../.##./##../....", // 36  $
  "#.#./..#./.#../#.../#.#./....", // 37  %
  ".#../#.#./.#../#.#./.##./....", // 38  &
  ".#../.#../..../..../..../....", // 39  '
  "..#./.#../.#../.#../..#./....", // 40  (
  ".#../..#./..#./..#./.#../....", // 41  )
  "..../#.#./.#../#.#./..../....", // 42  *
  "..../.#../###./.#../..../....", // 43  +
  "..../..../..../..../.#../#...", // 44  ,
  "..../..../###./..../..../....", // 45  -
  "..../..../..../..../.#../....", // 46  .
  "..#./..#./.#../#.../#.../....", // 47  /
  "###./#.#./#.#./#.#./###./....", // 48  0
  ".#../##../.#../.#../###./....", // 49  1
  "###./..#./###./#.../###./....", // 50  2
  "###./..#./.##./..#./###./....", // 51  3
  "#.#./#.#./###./..#./..#./....", // 52  4
  "###./#.../###./..#./###./....", // 53  5
  "###./#.../###./#.#./###./....", // 54  6
  "###./..#./..#./.#../.#../....", // 55  7
  "###./#.#./###./#.#./###./....", // 56  8
  "###./#.#./###./..#./###./....", // 57  9
  "..../.#../..../.#../..../....", // 58  :
  "..../.#../..../..../.#../#...", // 59  ;  (the tail matches the comma exactly)
  "..#./.#../#.../.#../..#./....", // 60  <
  "..../###./..../###./..../....", // 61  =
  "#.../.#../..#./.#../#.../....", // 62  >
  "###./..#./.##./..../.#../....", // 63  ?
  ".##./#.#./###./#.../.##./....", // 64  @
  ".#../#.#./###./#.#./#.#./....", // 65  A
  "##../#.#./##../#.#./##../....", // 66  B
  ".##./#.../#.../#.../.##./....", // 67  C
  "##../#.#./#.#./#.#./##../....", // 68  D
  "###./#.../##../#.../###./....", // 69  E
  "###./#.../##../#.../#.../....", // 70  F
  ".##./#.../#.#./#.#./.##./....", // 71  G
  "#.#./#.#./###./#.#./#.#./....", // 72  H
  "###./.#../.#../.#../###./....", // 73  I
  "..#./..#./..#./#.#./.#../....", // 74  J
  "#.#./#.#./##../#.#./#.#./....", // 75  K
  "#.../#.../#.../#.../###./....", // 76  L
  "#.#./###./###./#.#./#.#./....", // 77  M
  "#.#./###./###./###./#.#./....", // 78  N
  ".#../#.#./#.#./#.#./.#../....", // 79  O
  "##../#.#./##../#.../#.../....", // 80  P
  ".#../#.#./#.#./##../.##./....", // 81  Q
  "##../#.#./##../#.#./#.#./....", // 82  R
  ".##./#.../.#../..#./##../....", // 83  S
  "###./.#../.#../.#../.#../....", // 84  T
  "#.#./#.#./#.#./#.#./###./....", // 85  U
  "#.#./#.#./#.#./#.#./.#../....", // 86  V
  "#.#./#.#./###./###./#.#./....", // 87  W
  "#.#./#.#./.#../#.#./#.#./....", // 88  X
  "#.#./#.#./.#../.#../.#../....", // 89  Y
  "###./..#./.#../#.../###./....", // 90  Z
  ".##./.#../.#../.#../.##./....", // 91  [
  "#.../#.../.#../..#./..#./....", // 92  \
  ".##./..#./..#./..#./.##./....", // 93  ]
  ".#../#.#./..../..../..../....", // 94  ^
  "..../..../..../..../..../###.", // 95  _
  "#.../.#../..../..../..../....", // 96  `
  "..../..../##../#.#./.##./....", // 97  a
  "#.../#.../##../#.#./##../....", // 98  b
  "..../..../.##./#.../.##./....", // 99  c
  "..#./..#./.##./#.#./.##./....", // 100 d
  "..../..../.##./##../.##./....", // 101 e
  "..#./.#../###./.#../.#../....", // 102 f
  "..../..../.##./#.#./.##./##..", // 103 g
  "#.../#.../##../#.#./#.#./....", // 104 h
  ".#../..../.#../.#../.#../....", // 105 i
  "..#./..../..#./..#./..#./##..", // 106 j
  "#.../#.../#.#./##../#.#./....", // 107 k
  ".#../.#../.#../.#../.#../....", // 108 l
  "..../..../###./###./#.#./....", // 109 m
  "..../..../##../#.#./#.#./....", // 110 n
  "..../..../.#../#.#./.#../....", // 111 o
  "..../..../##../#.#./##../#...", // 112 p
  "..../..../.##./#.#./.##./..#.", // 113 q
  "..../..../.##./#.../#.../....", // 114 r
  "..../..../.##./.#../##../....", // 115 s
  ".#../###./.#../.#../.##./....", // 116 t
  "..../..../#.#./#.#./.##./....", // 117 u
  "..../..../#.#./#.#./.#../....", // 118 v
  "..../..../#.#./###./###./....", // 119 w
  "..../..../#.#./.#../#.#./....", // 120 x
  "..../..../#.#./#.#./.##./##..", // 121 y
  "..../..../###./.#../###./....", // 122 z
  ".##./.#../#.../.#../.##./....", // 123 {
  ".#../.#../.#../.#../.#../.#..", // 124 |
  "##../.#../..#./.#../##../....", // 125 }
  "..../..../.##./##../..../....", // 126 ~
];

/**
 * Pack the pictures into bits.
 *
 * Three bytes per glyph. Row r lands in the low nibble of byte `r >> 1` when r
 * is even and the high nibble when it is odd; inside a nibble, bit 0 is column
 * 0. That layout means `glyphRowBits` is a shift and a mask with no branch on
 * the column, which is what the inner loop of `print` wants.
 *
 * Throws on a malformed entry. A font with a silently dropped row would show up
 * as one ugly character in one cart, months later.
 */
function packGlyphs(art: readonly string[]): Uint8Array {
  if (art.length !== FONT_GLYPHS) {
    throw new Error(`font: ${art.length} glyphs, expected ${FONT_GLYPHS} for ${FONT_FIRST}..${FONT_LAST}`);
  }
  const out = new Uint8Array(FONT_GLYPHS * FONT_BYTES_PER_GLYPH);
  for (let g = 0; g < art.length; g++) {
    const rows = (art[g] as string).split("/");
    if (rows.length !== FONT_H) {
      throw new Error(`font: glyph ${g + FONT_FIRST} has ${rows.length} rows, expected ${FONT_H}`);
    }
    for (let r = 0; r < FONT_H; r++) {
      const row = rows[r] as string;
      if (row.length !== FONT_W) {
        throw new Error(`font: glyph ${g + FONT_FIRST} row ${r} is ${row.length} wide, expected ${FONT_W}`);
      }
      let bits = 0;
      for (let cIdx = 0; cIdx < FONT_W; cIdx++) {
        const ch = row.charAt(cIdx);
        if (ch === "#") bits |= 1 << cIdx;
        else if (ch !== ".") {
          throw new Error(`font: glyph ${g + FONT_FIRST} row ${r} has ${JSON.stringify(ch)}; only # and . are allowed`);
        }
      }
      const i = g * FONT_BYTES_PER_GLYPH + (r >> 1);
      out[i] = (out[i] as number) | (r & 1 ? bits << 4 : bits);
    }
  }
  return out;
}

/**
 * The font in its runtime form: 285 bytes, three per glyph.
 *
 * Read-only by convention. It is module data rather than machine state on
 * purpose -- a font that lived in RAM would be 285 bytes of every snapshot for
 * a table no cart can change.
 */
export const FONT: Uint8Array = packGlyphs(GLYPH_ART);

/**
 * The four ink bits of one row of one glyph, bit 0 being the leftmost column.
 *
 * A code point outside the table draws FONT_FALLBACK, and a row outside 0..5
 * reads 0. Allocation-free and total: `print` calls this once per row per
 * character and must never be able to throw out of a cart's draw call.
 */
export function glyphRowBits(code: number, row: number): number {
  if (row < 0 || row >= FONT_H) return 0;
  const cp = code >= FONT_FIRST && code <= FONT_LAST ? code : FONT_FALLBACK;
  const i = (cp - FONT_FIRST) * FONT_BYTES_PER_GLYPH + (row >> 1);
  const b = FONT[i] as number;
  return (row & 1 ? b >>> 4 : b) & 0x0f;
}

/**
 * Width in pixels a string would occupy on its widest line.
 *
 * `\n` starts a new line, matching `print`. Exists so a cart can centre a label
 * without drawing it first.
 */
export function measure(s: string): number {
  let widest = 0;
  let run = 0;
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) === 10) {
      if (run > widest) widest = run;
      run = 0;
      continue;
    }
    run += FONT_ADVANCE;
  }
  return run > widest ? run : widest;
}

/** Lines a string would occupy: one more than the number of `\n` in it. */
export function measureLines(s: string): number {
  let lines = 1;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) lines++;
  return lines;
}
