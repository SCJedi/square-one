/**
 * The display list: a cart describes a scene, and this records it.
 *
 * =========================================================================
 * IT RECORDS. IT DOES NOT DRAW.
 * =========================================================================
 * `Draw` is the whole visual surface a Prime cart has, and every call on it
 * appends a fixed-width record to a flat buffer. Nothing here touches a canvas,
 * a context, a driver or the DOM -- which is what lets `render` be exercised in
 * Node, lets a headless conformance runner execute a million ticks with no
 * display, and keeps a stranger's cart an arm's length from a GPU. The spec puts
 * it plainly (4.1): "a cart that submits a scene needs nothing but memory."
 *
 * That separation is also why this file is the one a test can be strict with.
 * The picture is non-normative and a renderer may draw it differently on every
 * machine -- but the LIST is exact, so "did the cart describe the right scene"
 * is a question with a yes-or-no answer.
 *
 * =========================================================================
 * ZERO ALLOCATION WHILE RECORDING
 * =========================================================================
 * A particle system calls `circle` a thousand times a frame. If each call
 * allocated, the garbage collector would decide the frame time, and it would
 * decide it during the busiest frames -- the explosion, the boss, the moment the
 * player is most likely to notice. So:
 *
 *   - every command lands in a preallocated `Float64Array` at a fixed stride;
 *   - the transform stack is a preallocated `Float64Array`, not an array of
 *     objects;
 *   - the buffer grows by DOUBLING, which is amortised O(1) and, after one warm
 *     frame, never happens again;
 *   - `measure` walks a table with `charCodeAt` and builds no string;
 *   - `text` stores the caller's string by reference into a slot it already has.
 *
 * `packages/prime/test/draw.test.ts` proves it with the counting-Proxy probe
 * from `packages/runtime/test/machine.test.ts`: every global constructor is
 * wrapped, ten thousand commands are recorded, and the count must be zero.
 *
 * =========================================================================
 * THE TRANSFORM IS BAKED IN, SO THE RENDERER HAS NO STACK
 * =========================================================================
 * `push`/`pop`/`translate`/`rotate`/`scale` maintain a current 2x3 matrix here,
 * and every command carries a COPY of that matrix. A renderer therefore replays
 * the list as a flat sequence -- `setTransform`, draw, `setTransform`, draw --
 * and never needs a matrix stack of its own, never needs the commands in their
 * original order to be correct, and can bucket them by layer freely. Layer
 * passes are only possible because of this: reordering commands would be
 * nonsense if a command's position depended on a `push` three commands earlier.
 *
 * Six numbers per command is the price. It is the right one: a matrix stack in
 * the renderer is a second implementation of the same thing, and two of them is
 * how the picture and the list start disagreeing.
 *
 * UNBALANCED `pop` THROWS. A cart that pops more than it pushed has a bug, and
 * the alternative to throwing is a transform that silently stays wrong for the
 * rest of the frame -- which shows up as a sprite in the wrong place three
 * systems away from the code that caused it. `push` past `MAX_DEPTH` throws for
 * the same reason: the stack is preallocated on purpose, and growing it silently
 * would hide a runaway recursion.
 *
 * COORDINATES ARE FLOATS IN 1920 x 1080 (spec 3.1). Colours are packed
 * `0xRRGGBBAA` as a u32. Neither is a resolution: the runtime presents the
 * logical space at whatever the display actually is.
 *
 * `rotate` uses the platform's `Math.sin`/`Math.cos` rather than the console's
 * normative library, and that is correct rather than an oversight: the display
 * list is presentation, presentation is non-normative (spec 0), and a value
 * computed here can never reach the simulation because `render` is handed a
 * read-only arena. The normative library exists for the numbers a cart's `tick`
 * depends on.
 */

/** The logical render target. Not a resolution -- see spec 3.1. */
export const LOGICAL_W = 1920;

/** The logical render target's height. 16:9, because a letterbox is the cart's decision. */
export const LOGICAL_H = 1080;

/** Layers, drawn low to high, each a separate pass. */
export const LAYERS = 8;

/** How deep `push` may nest. Preallocated; exceeding it is a cart bug, not a resize. */
export const MAX_DEPTH = 64;

/** Commands the list holds before its first growth. One doubling covers most scenes. */
const DEFAULT_CAPACITY = 4096;

/** Numbers per command record. */
export const STRIDE = 16;

/** Command opcodes, as they appear at `FIELD.OP` of each record. */
export const OP = {
  CLEAR: 0,
  RECT: 1,
  ROUND_RECT: 2,
  CIRCLE: 3,
  LINE: 4,
  TRI: 5,
  TEXT: 6,
} as const;

export type Op = (typeof OP)[keyof typeof OP];

/**
 * Offsets within one command record.
 *
 * `A..F` are the baked transform in Canvas2D's own order, so a renderer can hand
 * them to `setTransform` unchanged: `x' = A*x + C*y + E`, `y' = B*x + D*y + F`.
 * `P0..P5` are the command's geometry in LOCAL space, which is what makes the
 * matrix useful -- a rotated rect stays a rect plus a matrix rather than
 * becoming four baked corners nothing can reason about.
 */
export const FIELD = {
  OP: 0,
  A: 1,
  B: 2,
  C: 3,
  D: 4,
  E: 5,
  F: 6,
  P0: 7,
  P1: 8,
  P2: 9,
  P3: 10,
  P4: 11,
  P5: 12,
  COLOR: 13,
  LAYER: 14,
  BLEND: 15,
} as const;

/** Blend modes. `1` is additive, and additive is the glow -- see the ABI. */
export const BLEND = { NORMAL: 0, ADDITIVE: 1 } as const;

/**
 * What a cart may do to the screen. Implemented exactly as `spec/PRIME-ABI.md`
 * declares it; nothing is added, because a cart written against the ABI must
 * compile against any conformant runtime.
 */
export interface Draw {
  clear(color: number): void;

  rect(x: number, y: number, w: number, h: number, color: number): void;
  roundRect(x: number, y: number, w: number, h: number, r: number, color: number): void;
  circle(x: number, y: number, r: number, color: number): void;
  line(x0: number, y0: number, x1: number, y1: number, w: number, color: number): void;
  tri(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    color: number,
  ): void;

  /** `y` is the TEXT BASELINE, as it is everywhere else text is drawn. */
  text(s: string, x: number, y: number, size: number, color: number): void;
  /** Advance width of `s` at `size`, in logical units. See {@link measureText}. */
  measure(s: string, size: number): number;

  push(): void;
  pop(): void;
  translate(x: number, y: number): void;
  rotate(a: number): void;
  scale(x: number, y: number): void;

  blend(mode: 0 | 1): void;
  layer(n: number): void;

  bloom(strength: number, threshold: number): void;
  shake(amount: number): void;
}

/**
 * One frame's scene, as flat memory.
 *
 * `data` holds `count * STRIDE` numbers and is REUSED between frames: a consumer
 * that keeps it must copy. That is the same contract `Host.latestRgba` states on
 * the small console, and for the same reason -- a display list allocated per
 * frame is the allocation this whole file exists to avoid, so it cannot be
 * handed out as if it were owned.
 */
export interface DisplayList {
  /** `count * STRIDE` numbers. Longer than that; read `count`, not `length`. */
  readonly data: Float64Array;
  /** How many commands are live. */
  readonly count: number;
  /** Numbers per command. Always {@link STRIDE}; present so a consumer need not import it. */
  readonly stride: number;
  /** Strings referenced by `TEXT` commands, indexed by their `P3`. */
  readonly strings: readonly string[];
  /** Commands per layer, so a renderer can skip an empty pass without scanning. */
  readonly layerCount: Uint32Array;
  /** Per layer: `[strength, threshold]`. Non-normative; a runtime MAY ignore it. */
  readonly bloom: Float64Array;
  /** Screen shake in logical units. Non-normative; a runtime MAY ignore it. */
  readonly shake: number;
}

/** The recorder: a {@link Draw} plus the frame control only the runtime touches. */
export interface DrawList extends Draw {
  /** Start a frame. Clears the list, the transform, the stack and the post stages. */
  begin(): void;
  /** The scene recorded so far. The same object every frame; see {@link DisplayList}. */
  readonly list: DisplayList;
  /** Commands recorded this frame. */
  readonly count: number;
  /** Transform-stack depth. 0 at the start of a frame, and 0 again if a cart balanced. */
  readonly depth: number;
  /** How many commands fit before the next doubling. Diagnostic. */
  readonly capacity: number;
  /** Buffers ever allocated. Must stop rising after one warm frame. */
  readonly growths: number;
}

export interface DrawOptions {
  /** Commands to preallocate. Default 4096. */
  capacity?: number;
}

// ---------------------------------------------------------------------------
// Text metrics
// ---------------------------------------------------------------------------

/**
 * Advance widths for the built-in face, as a fraction of `size`.
 *
 * The ABI gives a cart `measure`, and a cart lays out menus and scores with it,
 * so `measure` has to answer without a canvas -- it is called from `render`,
 * which must run headless. A table is the only honest way to do that.
 *
 * The renderer's job is then to make the drawn text MATCH this table rather than
 * the other way round: it measures the platform face it actually got and scales
 * the string horizontally to the width promised here. So a centred score is
 * centred on every machine even though the glyphs differ, which is exactly the
 * trade the spec's non-normative boundary allows -- pixels may differ, layout
 * decisions a cart made may not.
 *
 * The proportions are a condensed grotesque, the shape of face a console UI
 * wants. Built once at module load, never in the hot path.
 */
const ADVANCE = buildAdvance();

function buildAdvance(): Float64Array {
  const w = new Float64Array(128);
  // Everything not named below, including every non-ASCII code point.
  w.fill(0.55);
  const set = (chars: string, v: number): void => {
    for (let i = 0; i < chars.length; i++) w[chars.charCodeAt(i)] = v;
  };
  set(" ", 0.3);
  set("!'|.,:;il", 0.26);
  set("()[]{}/\\`\"tfrjI", 0.34);
  set("-", 0.38);
  set("abcdeghknopqsuvxyz", 0.52);
  set("0123456789", 0.56);
  set("ABCDEFGHJKLNOPQRSTUVXYZ", 0.62);
  set("mw", 0.82);
  set("MW@", 0.86);
  return w;
}

/**
 * Advance width of `s` at `size`, in logical units.
 *
 * Exported separately from the `Draw` method so the renderer can call it without
 * holding a recorder -- the two MUST agree, and the only way to guarantee that
 * is for there to be one function.
 *
 * Allocates nothing: `charCodeAt` returns a number and the loop keeps none of it.
 */
export function measureText(s: string, size: number): number {
  let units = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    units += c < 128 ? (ADVANCE[c] as number) : 0.55;
  }
  return units * size;
}

// ---------------------------------------------------------------------------
// The recorder
// ---------------------------------------------------------------------------

export function createDraw(opts?: DrawOptions): DrawList {
  const wanted = opts?.capacity ?? DEFAULT_CAPACITY;
  let capacity = Math.max(16, Math.floor(Number.isFinite(wanted) ? wanted : DEFAULT_CAPACITY));

  let data = new Float64Array(capacity * STRIDE);
  let growths = 0;

  /**
   * Strings referenced by `TEXT` commands.
   *
   * A plain array because a string cannot live in a typed array. It is
   * preallocated and its slots are REUSED -- `strings[n] = s` stores a reference
   * and constructs nothing, which is what keeps `text` allocation-free. `begin`
   * blanks the used slots so a frame's strings are not held alive by the next
   * one; a menu's worth of text is nothing, but a cart that formats a debug dump
   * every frame would otherwise keep the last one forever.
   */
  let strings: string[] = new Array<string>(256).fill("");
  let stringCount = 0;

  const layerCount = new Uint32Array(LAYERS);
  const bloomParams = new Float64Array(LAYERS * 2);
  let shakeAmount = 0;

  let count = 0;

  // The current transform, as six scalars. Scalars rather than an array because
  // this is read and written on every single command and a typed-array index is
  // a bounds check the engine cannot always remove.
  let ma = 1;
  let mb = 0;
  let mc = 0;
  let md = 1;
  let me = 0;
  let mf = 0;

  /** The transform stack: six numbers per level, preallocated. */
  const stack = new Float64Array(MAX_DEPTH * 6);
  let depth = 0;

  let curLayer = 0;
  let curBlend: 0 | 1 = 0;

  const list: DisplayList = {
    get data(): Float64Array {
      return data;
    },
    get count(): number {
      return count;
    },
    stride: STRIDE,
    get strings(): readonly string[] {
      return strings;
    },
    layerCount,
    bloom: bloomParams,
    get shake(): number {
      return shakeAmount;
    },
  };

  /**
   * Double the command buffer.
   *
   * Deliberately NOT on the hot path: it runs at most log2(N) times for the life
   * of a recorder, and after the first frame at a given scene complexity it never
   * runs again. `growths` is the observable that says so, and the allocation test
   * warms up before it probes for exactly that reason.
   */
  function grow(): void {
    capacity *= 2;
    const next = new Float64Array(capacity * STRIDE);
    next.set(data);
    data = next;
    growths++;
  }

  function growStrings(): void {
    const next = new Array<string>(strings.length * 2).fill("");
    for (let i = 0; i < stringCount; i++) next[i] = strings[i] as string;
    strings = next;
    growths++;
  }

  /**
   * Reserve one record and stamp everything every command carries.
   *
   * Returns the record's base offset. One function so that the transform, the
   * colour, the layer and the blend mode cannot be forgotten by a command added
   * later -- the mistake that would otherwise show up as one shape ignoring the
   * camera.
   */
  function open(op: number, color: number): number {
    if (count === capacity) grow();
    const o = count * STRIDE;
    count++;
    data[o + FIELD.OP] = op;
    data[o + FIELD.A] = ma;
    data[o + FIELD.B] = mb;
    data[o + FIELD.C] = mc;
    data[o + FIELD.D] = md;
    data[o + FIELD.E] = me;
    data[o + FIELD.F] = mf;
    // `>>> 0` so a colour written as a signed literal (0xff0000ff | 0 is
    // negative in JS) still reads back as the u32 the ABI specifies.
    data[o + FIELD.COLOR] = color >>> 0;
    data[o + FIELD.LAYER] = curLayer;
    data[o + FIELD.BLEND] = curBlend;
    layerCount[curLayer] = (layerCount[curLayer] as number) + 1;
    return o;
  }

  return {
    list,

    get count(): number {
      return count;
    },
    get depth(): number {
      return depth;
    },
    get capacity(): number {
      return capacity;
    },
    get growths(): number {
      return growths;
    },

    begin(): void {
      count = 0;
      for (let i = 0; i < stringCount; i++) strings[i] = "";
      stringCount = 0;
      layerCount.fill(0);
      bloomParams.fill(0);
      shakeAmount = 0;
      depth = 0;
      curLayer = 0;
      curBlend = 0;
      ma = 1;
      mb = 0;
      mc = 0;
      md = 1;
      me = 0;
      mf = 0;
    },

    // --- shapes -------------------------------------------------------------

    clear(color: number): void {
      open(OP.CLEAR, color);
    },

    rect(x: number, y: number, w: number, h: number, color: number): void {
      const o = open(OP.RECT, color);
      data[o + FIELD.P0] = x;
      data[o + FIELD.P1] = y;
      data[o + FIELD.P2] = w;
      data[o + FIELD.P3] = h;
    },

    roundRect(x: number, y: number, w: number, h: number, r: number, color: number): void {
      const o = open(OP.ROUND_RECT, color);
      data[o + FIELD.P0] = x;
      data[o + FIELD.P1] = y;
      data[o + FIELD.P2] = w;
      data[o + FIELD.P3] = h;
      data[o + FIELD.P4] = r;
    },

    circle(x: number, y: number, r: number, color: number): void {
      const o = open(OP.CIRCLE, color);
      data[o + FIELD.P0] = x;
      data[o + FIELD.P1] = y;
      data[o + FIELD.P2] = r;
    },

    line(x0: number, y0: number, x1: number, y1: number, w: number, color: number): void {
      const o = open(OP.LINE, color);
      data[o + FIELD.P0] = x0;
      data[o + FIELD.P1] = y0;
      data[o + FIELD.P2] = x1;
      data[o + FIELD.P3] = y1;
      data[o + FIELD.P4] = w;
    },

    tri(
      x0: number,
      y0: number,
      x1: number,
      y1: number,
      x2: number,
      y2: number,
      color: number,
    ): void {
      const o = open(OP.TRI, color);
      data[o + FIELD.P0] = x0;
      data[o + FIELD.P1] = y0;
      data[o + FIELD.P2] = x1;
      data[o + FIELD.P3] = y1;
      data[o + FIELD.P4] = x2;
      data[o + FIELD.P5] = y2;
    },

    text(s: string, x: number, y: number, size: number, color: number): void {
      if (stringCount === strings.length) growStrings();
      const at = stringCount;
      strings[at] = s;
      stringCount++;
      const o = open(OP.TEXT, color);
      data[o + FIELD.P0] = x;
      data[o + FIELD.P1] = y;
      data[o + FIELD.P2] = size;
      data[o + FIELD.P3] = at;
    },

    measure(s: string, size: number): number {
      return measureText(s, size);
    },

    // --- transform ----------------------------------------------------------

    push(): void {
      if (depth === MAX_DEPTH) {
        throw new Error(
          `Draw.push: transform stack is ${MAX_DEPTH} deep. A cart that nests this far ` +
            "is recursing, not drawing; the stack is preallocated and does not grow.",
        );
      }
      const o = depth * 6;
      stack[o] = ma;
      stack[o + 1] = mb;
      stack[o + 2] = mc;
      stack[o + 3] = md;
      stack[o + 4] = me;
      stack[o + 5] = mf;
      depth++;
    },

    pop(): void {
      if (depth === 0) {
        throw new Error(
          "Draw.pop: the transform stack is empty. More pops than pushes leaves the " +
            "transform wrong for the rest of the frame, which shows up as a shape in the " +
            "wrong place far away from the code that caused it -- so it throws here instead.",
        );
      }
      depth--;
      const o = depth * 6;
      ma = stack[o] as number;
      mb = stack[o + 1] as number;
      mc = stack[o + 2] as number;
      md = stack[o + 3] as number;
      me = stack[o + 4] as number;
      mf = stack[o + 5] as number;
    },

    translate(x: number, y: number): void {
      me += ma * x + mc * y;
      mf += mb * x + md * y;
    },

    rotate(a: number): void {
      // Platform trig, on purpose. See the file header: this is presentation.
      const cs = Math.cos(a);
      const sn = Math.sin(a);
      const na = ma * cs + mc * sn;
      const nb = mb * cs + md * sn;
      const nc = mc * cs - ma * sn;
      const nd = md * cs - mb * sn;
      ma = na;
      mb = nb;
      mc = nc;
      md = nd;
    },

    scale(x: number, y: number): void {
      ma *= x;
      mb *= x;
      mc *= y;
      md *= y;
    },

    // --- state --------------------------------------------------------------

    blend(mode: 0 | 1): void {
      curBlend = mode === 1 ? 1 : 0;
    },

    layer(n: number): void {
      // Clamped rather than thrown: a layer out of range is a cart drawing in
      // the wrong place, which is visible and recoverable. Throwing would stop a
      // game over a decoration.
      curLayer = n < 0 ? 0 : n >= LAYERS ? LAYERS - 1 : n | 0;
    },

    // --- post stages, declared per layer ------------------------------------

    bloom(strength: number, threshold: number): void {
      const o = curLayer * 2;
      bloomParams[o] = clamp01(strength);
      bloomParams[o + 1] = clamp01(threshold);
    },

    /**
     * Ask for screen shake.
     *
     * The STRONGEST request in a frame wins rather than the last one, because
     * several systems ask independently -- a hit, an explosion and a landing all
     * call it -- and "last writer" would mean a gentle footstep cancelling the
     * explosion that happened in the same tick.
     */
    shake(amount: number): void {
      const a = Number.isFinite(amount) ? amount : 0;
      if (a > shakeAmount) shakeAmount = a;
    },
  };
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

// ---------------------------------------------------------------------------
// Reading a list back
// ---------------------------------------------------------------------------

/** Unpack a packed `0xRRGGBBAA` colour into 0..255 components and 0..1 alpha. */
export function unpackColor(c: number): { r: number; g: number; b: number; a: number } {
  const u = c >>> 0;
  return {
    r: (u >>> 24) & 0xff,
    g: (u >>> 16) & 0xff,
    b: (u >>> 8) & 0xff,
    a: (u & 0xff) / 255,
  };
}

/**
 * The CSS colour string for a packed colour.
 *
 * Here rather than in the renderer because it is the one place the ABI's byte
 * order is interpreted, and a red-and-blue swap is the kind of bug that looks
 * deliberate until someone draws a flag.
 */
export function cssColor(c: number): string {
  const u = c >>> 0;
  const r = (u >>> 24) & 0xff;
  const g = (u >>> 16) & 0xff;
  const b = (u >>> 8) & 0xff;
  const a = u & 0xff;
  return a === 255 ? `rgb(${r},${g},${b})` : `rgba(${r},${g},${b},${(a / 255).toFixed(4)})`;
}
