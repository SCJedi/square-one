/**
 * A PNG writer and a matching reader, in about 150 lines and with no
 * dependencies.
 *
 * WHY WRITE ONE AT ALL
 * --------------------
 * The conformance frames exist so a HUMAN can look at them. A hash tells you
 * that frame 4 changed; a picture tells you that the arrow sprite stopped
 * flipping. That is worth a file format, and PNG is the only lossless one every
 * viewer, browser, diff tool and pull request already understands.
 *
 * It is written here rather than pulled from npm because this repository ships
 * no third-party runtime code, and because a generator with a dependency can
 * mint an artifact that a later version of that dependency will not reproduce.
 * The committed frames must regenerate byte-for-byte forever, so the encoder has
 * to be as frozen as the machine is.
 *
 * WHY DEFLATE IS "STORED"
 * -----------------------
 * The zlib stream uses stored (uncompressed) blocks: type 00, a length and its
 * complement, then the bytes. That is a legal deflate stream -- every decoder
 * reads it, including the browser's -- and it needs no Huffman coder, no
 * matcher, and no tuning constants that a future rewrite could get subtly
 * different. A 128 x 128 RGBA frame lands at about 66 KB instead of about 3 KB.
 * Ten of them is 660 KB in the repository, once, for an encoder nobody will ever
 * have to debug. That is the trade, made on purpose.
 *
 * The reader below decodes exactly what the writer emits -- 8-bit RGBA, filter 0
 * on every row, stored blocks -- and is used by reference-frames.test.ts to
 * prove that the pictures on disk really are the frames the machine renders,
 * rather than merely being files that sit next to a hash.
 */

/** CRC-32 (IEEE), the polynomial PNG chunks use. Table built once. */
const CRC_TABLE: Uint32Array = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array, start: number, end: number): number {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) {
    c = ((CRC_TABLE[(c ^ (bytes[i] as number)) & 0xff] as number) ^ (c >>> 8)) >>> 0;
  }
  return (c ^ 0xffffffff) >>> 0;
}

/** Adler-32, the checksum that terminates a zlib stream. */
function adler32(bytes: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (let i = 0; i < bytes.length; i++) {
    a = (a + (bytes[i] as number)) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

/** The eight bytes every PNG starts with. */
const SIGNATURE: readonly number[] = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Largest payload a single stored deflate block may carry. */
const STORED_MAX = 0xffff;

function writeU32(out: Uint8Array, at: number, v: number): void {
  out[at + 0] = (v >>> 24) & 0xff;
  out[at + 1] = (v >>> 16) & 0xff;
  out[at + 2] = (v >>> 8) & 0xff;
  out[at + 3] = v & 0xff;
}

/**
 * Encode a 128 x 128 (or any w x h) RGBA buffer as a PNG.
 *
 * `rgba` is one packed pixel per element, in the machine's own byte order --
 * exactly what `machine.rgba` holds. It is unpacked here through a byte view so
 * the file is identical on a big-endian machine, which is the one place this
 * tool must not inherit the host's endianness.
 */
export function encodePng(rgba: Uint32Array, w: number, h: number): Uint8Array {
  if (rgba.length !== w * h) {
    throw new Error(`encodePng: ${rgba.length} pixels for a ${w}x${h} image`);
  }

  // Raw scanlines: a filter byte (0, "None") then w RGBA quadruples.
  const stride = 1 + w * 4;
  const raw = new Uint8Array(stride * h);
  const probe = new Uint8Array(4);
  const probeWord = new Uint32Array(probe.buffer);
  let o = 0;
  for (let y = 0; y < h; y++) {
    raw[o++] = 0;
    for (let x = 0; x < w; x++) {
      probeWord[0] = rgba[y * w + x] as number;
      raw[o++] = probe[0] as number;
      raw[o++] = probe[1] as number;
      raw[o++] = probe[2] as number;
      raw[o++] = probe[3] as number;
    }
  }

  // zlib: 0x78 0x01 (deflate, 32K window, no dictionary, fastest), stored
  // blocks, then the Adler-32 of the raw data.
  const blocks = Math.max(1, Math.ceil(raw.length / STORED_MAX));
  const zlib = new Uint8Array(2 + blocks * 5 + raw.length + 4);
  zlib[0] = 0x78;
  zlib[1] = 0x01;
  let z = 2;
  let p = 0;
  for (let b = 0; b < blocks; b++) {
    const n = Math.min(STORED_MAX, raw.length - p);
    zlib[z++] = b === blocks - 1 ? 1 : 0; // BFINAL, BTYPE = 00
    zlib[z++] = n & 0xff;
    zlib[z++] = (n >>> 8) & 0xff;
    zlib[z++] = ~n & 0xff;
    zlib[z++] = (~n >>> 8) & 0xff;
    zlib.set(raw.subarray(p, p + n), z);
    z += n;
    p += n;
  }
  writeU32(zlib, z, adler32(raw));
  z += 4;

  // IHDR: 8-bit depth, colour type 6 (truecolour with alpha), no interlace.
  const ihdr = new Uint8Array(13);
  writeU32(ihdr, 0, w);
  writeU32(ihdr, 4, h);
  ihdr[8] = 8;
  ihdr[9] = 6;

  const chunks: readonly [string, Uint8Array][] = [
    ["IHDR", ihdr],
    ["IDAT", zlib.subarray(0, z)],
    ["IEND", new Uint8Array(0)],
  ];

  let total = SIGNATURE.length;
  for (const [, data] of chunks) total += 12 + data.length;

  const out = new Uint8Array(total);
  out.set(SIGNATURE, 0);
  let at = SIGNATURE.length;
  for (const [type, data] of chunks) {
    writeU32(out, at, data.length);
    for (let i = 0; i < 4; i++) out[at + 4 + i] = type.charCodeAt(i);
    out.set(data, at + 8);
    writeU32(out, at + 8 + data.length, crc32(out, at + 4, at + 8 + data.length));
    at += 12 + data.length;
  }
  return out;
}

/** What `decodePng` gives back. */
export interface DecodedPng {
  width: number;
  height: number;
  /** One packed pixel per element, in the same order `encodePng` accepted. */
  rgba: Uint32Array;
}

/**
 * Decode what `encodePng` produced. Deliberately narrow: 8-bit RGBA, no
 * interlace, filter 0 on every row, stored deflate blocks.
 *
 * It throws with a reason on anything else rather than guessing, because its
 * only job is to read this repository's own frames back and say whether they are
 * the frames the machine renders now.
 */
export function decodePng(bytes: Uint8Array): DecodedPng {
  for (let i = 0; i < SIGNATURE.length; i++) {
    if (bytes[i] !== SIGNATURE[i]) throw new Error("decodePng: not a PNG");
  }
  const u32 = (at: number): number =>
    (((bytes[at] as number) << 24) |
      ((bytes[at + 1] as number) << 16) |
      ((bytes[at + 2] as number) << 8) |
      (bytes[at + 3] as number)) >>>
    0;

  let at = SIGNATURE.length;
  let width = 0;
  let height = 0;
  let idatLen = 0;
  const idatParts: Uint8Array[] = [];

  while (at < bytes.length) {
    const len = u32(at);
    const type = String.fromCharCode(
      bytes[at + 4] as number,
      bytes[at + 5] as number,
      bytes[at + 6] as number,
      bytes[at + 7] as number,
    );
    const body = bytes.subarray(at + 8, at + 8 + len);
    if (type === "IHDR") {
      width = u32(at + 8);
      height = u32(at + 12);
      if (body[8] !== 8 || body[9] !== 6 || body[12] !== 0) {
        throw new Error("decodePng: only 8-bit RGBA, non-interlaced is supported");
      }
    } else if (type === "IDAT") {
      idatParts.push(body);
      idatLen += len;
    } else if (type === "IEND") {
      break;
    }
    at += 12 + len;
  }

  const z = new Uint8Array(idatLen);
  let zo = 0;
  for (const part of idatParts) {
    z.set(part, zo);
    zo += part.length;
  }
  if ((z[0] as number) !== 0x78) throw new Error("decodePng: not a zlib stream");

  const stride = 1 + width * 4;
  const raw = new Uint8Array(stride * height);
  let ro = 0;
  let p = 2;
  for (;;) {
    const header = z[p] as number;
    if ((header & 0x06) !== 0) throw new Error("decodePng: only stored deflate blocks");
    const n = (z[p + 1] as number) | ((z[p + 2] as number) << 8);
    raw.set(z.subarray(p + 5, p + 5 + n), ro);
    ro += n;
    p += 5 + n;
    if ((header & 1) === 1) break;
  }
  if (ro !== raw.length) throw new Error(`decodePng: ${ro} raw bytes, expected ${raw.length}`);

  const rgba = new Uint32Array(width * height);
  const probe = new Uint8Array(4);
  const probeWord = new Uint32Array(probe.buffer);
  for (let y = 0; y < height; y++) {
    const base = y * stride;
    if (raw[base] !== 0) throw new Error(`decodePng: row ${y} uses filter ${raw[base]}`);
    for (let x = 0; x < width; x++) {
      const i = base + 1 + x * 4;
      probe[0] = raw[i] as number;
      probe[1] = raw[i + 1] as number;
      probe[2] = raw[i + 2] as number;
      probe[3] = raw[i + 3] as number;
      rgba[y * width + x] = probeWord[0] as number;
    }
  }
  return { width, height, rgba };
}
