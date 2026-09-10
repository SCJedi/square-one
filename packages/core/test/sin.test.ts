import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { SIN_STEPS, SIN_TABLE, fsin, fcos } from "../src/sin";

const PROJECT_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const FIXTURE = join(PROJECT_ROOT, "conformance", "fixtures", "sin1024.bin");
const GENERATOR = join(PROJECT_ROOT, "packages", "core", "tools", "gen-sin.ts");
const MODULE_TS = join(PROJECT_ROOT, "packages", "core", "src", "sin-table.ts");

/** Read a 1024 x int32 LE fixture. */
function readTable(path: string): Int32Array {
  const buf = readFileSync(path);
  expect(buf.length, `${path} should be 4096 bytes`).toBe(4096);
  const out = new Int32Array(1024);
  for (let i = 0; i < 1024; i++) out[i] = buf.readInt32LE(i * 4);
  return out;
}

describe("sin: the table and the fixture are the same table", () => {
  it("has 1024 entries", () => {
    expect(SIN_STEPS).toBe(1024);
    expect(SIN_TABLE.length).toBe(1024);
    expect(SIN_TABLE).toBeInstanceOf(Int32Array);
  });

  it("sin-table.ts decodes to exactly conformance/fixtures/sin1024.bin", () => {
    const fixture = readTable(FIXTURE);
    for (let i = 0; i < 1024; i++) {
      if (SIN_TABLE[i] !== fixture[i]) {
        throw new Error(
          `entry ${i}: sin-table.ts has ${SIN_TABLE[i]}, sin1024.bin has ${fixture[i]}`,
        );
      }
    }
  });
});

describe("sin: regeneration is byte-identical", () => {
  it("re-running the generator reproduces both committed artifacts", () => {
    // Generate into a scratch tree; the committed fixture is never touched.
    const tmp = join(PROJECT_ROOT, "packages", "core", ".tmp-gen-sin");
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(tmp, { recursive: true });
    try {
      execFileSync(process.execPath, ["--experimental-strip-types", GENERATOR, tmp], {
        stdio: "pipe",
      });

      const freshBin = readFileSync(join(tmp, "conformance", "fixtures", "sin1024.bin"));
      const committedBin = readFileSync(FIXTURE);
      // The .bin is the normative artifact: compare raw bytes, no leniency.
      expect(freshBin.length).toBe(committedBin.length);
      expect(Buffer.compare(freshBin, committedBin), "sin1024.bin changed on regeneration").toBe(0);

      // The .ts is a derived convenience file. Line endings are normalised
      // before comparing so that a CRLF checkout cannot fail a test about
      // numerical determinism; everything else must match exactly.
      const freshTs = readFileSync(
        join(tmp, "packages", "core", "src", "sin-table.ts"),
        "utf8",
      ).replace(/\r\n/g, "\n");
      const committedTs = readFileSync(MODULE_TS, "utf8").replace(/\r\n/g, "\n");
      expect(freshTs, "sin-table.ts changed on regeneration").toBe(committedTs);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 60_000);
});

describe("sin: exact values at the cardinal angles", () => {
  it("hits 0, 1, 0, -1 at the quarter turns", () => {
    expect(fsin(0)).toBe(0);
    expect(fsin(256)).toBe(65536);
    expect(fsin(512)).toBe(0);
    expect(fsin(768)).toBe(-65536);
    expect(fsin(1024)).toBe(0);
  });

  it("cosine hits 1, 0, -1, 0", () => {
    expect(fcos(0)).toBe(65536);
    expect(fcos(256)).toBe(0);
    expect(fcos(512)).toBe(-65536);
    expect(fcos(768)).toBe(0);
  });

  it("never leaves [-1.0, 1.0]", () => {
    for (let i = 0; i < 1024; i++) {
      const v = SIN_TABLE[i] as number;
      if (!Number.isInteger(v) || v < -65536 || v > 65536) {
        throw new Error(`entry ${i} = ${v} is outside [-65536, 65536]`);
      }
    }
  });
});

describe("sin: symmetry", () => {
  it("fsin(-a) === -fsin(a) for every angle in a turn", () => {
    for (let a = 0; a < 1024; a++) {
      // `!==` rather than toBe: fsin(0) is 0 and -fsin(0) is -0, which
      // Object.is (and therefore toBe) considers different numbers.
      if (fsin(-a) !== -fsin(a)) {
        throw new Error(`fsin(${-a}) = ${fsin(-a)}, but -fsin(${a}) = ${-fsin(a)}`);
      }
    }
  });

  it("fsin(-a) === -fsin(a) well outside a single turn too", () => {
    for (let a = -5000; a <= 5000; a += 7) {
      if (fsin(-a) !== -fsin(a)) {
        throw new Error(`fsin(${-a}) = ${fsin(-a)}, but -fsin(${a}) = ${-fsin(a)}`);
      }
    }
  });

  it("fcos(a) === fsin(a + 256) everywhere", () => {
    for (let a = -3000; a <= 3000; a++) {
      if (fcos(a) !== fsin(a + 256)) {
        throw new Error(`fcos(${a}) = ${fcos(a)}, fsin(${a + 256}) = ${fsin(a + 256)}`);
      }
    }
  });

  it("mirrors about a quarter turn: fsin(512 - a) === fsin(a)", () => {
    for (let a = 0; a <= 512; a++) {
      if (fsin(512 - a) !== fsin(a)) {
        throw new Error(`fsin(${512 - a}) = ${fsin(512 - a)}, fsin(${a}) = ${fsin(a)}`);
      }
    }
  });

  it("satisfies the Pythagorean identity to within table rounding", () => {
    // sin^2 + cos^2 = 1. Each entry carries up to half a unit of rounding
    // error, i.e. 0.5/65536 ~ 7.6e-6 in real terms, and d(s^2+c^2) is at most
    // 2|s|ds + 2|c|dc <= 4 * 7.6e-6 ~ 3.1e-5. 1e-4 is that with room to spare;
    // anything larger would mean a genuinely wrong entry, not rounding.
    for (let a = 0; a < 1024; a++) {
      const s = fsin(a) / 65536;
      const c = fcos(a) / 65536;
      expect(Math.abs(s * s + c * c - 1), `angle ${a}`).toBeLessThan(1e-4);
    }
  });
});

describe("sin: wrapping", () => {
  it("fsin(a) === fsin(a + 1024*k) for positive and negative k", () => {
    for (const k of [-1000, -64, -3, -2, -1, 1, 2, 3, 64, 1000]) {
      for (let a = 0; a < 1024; a++) {
        const shifted = a + 1024 * k;
        if (fsin(shifted) !== fsin(a)) {
          throw new Error(`fsin(${shifted}) = ${fsin(shifted)}, fsin(${a}) = ${fsin(a)} (k=${k})`);
        }
      }
    }
  });

  it("wraps correctly near the int32 limits", () => {
    // 1024 divides 2^32, so ToInt32 cannot change an angle modulo 1024.
    expect(fsin(2147483647)).toBe(fsin(1023));
    expect(fsin(-2147483648)).toBe(fsin(0));
    expect(fsin(2147483647 - 1023)).toBe(fsin(0));
    expect(fcos(2147483647)).toBe(fcos(1023));
  });

  it("negative angles index the table, never off the front of it", () => {
    expect(fsin(-1)).toBe(fsin(1023));
    expect(fsin(-256)).toBe(fsin(768));
    expect(fsin(-1024)).toBe(fsin(0));
    for (let a = -4096; a < 0; a++) {
      const v = fsin(a);
      if (typeof v !== "number" || Number.isNaN(v)) {
        throw new Error(`fsin(${a}) returned ${v}`);
      }
    }
  });
});

describe("sin: cross-check against Math.sin", () => {
  it("every entry is within 2 units of 16.16 of Math.sin", () => {
    // Math.sin is NOT the source of these values -- it is not specified to the
    // last bit, which is exactly why the generator computes in BigInt. It is a
    // good enough independent witness to catch a wrong series.
    let worst = 0;
    let worstAt = -1;
    for (let i = 0; i < 1024; i++) {
      const ref = Math.sin((2 * Math.PI * i) / 1024) * 65536;
      const d = Math.abs((SIN_TABLE[i] as number) - ref);
      if (d > worst) {
        worst = d;
        worstAt = i;
      }
    }
    expect(worst, `worst entry was ${worstAt}`).toBeLessThanOrEqual(2);
    // In fact correct rounding puts every entry within half a unit; if this
    // ever loosens, the series has drifted.
    expect(worst, `worst entry was ${worstAt}`).toBeLessThan(0.5001);
  });

  it("is monotonically increasing across the first quarter turn", () => {
    for (let i = 1; i <= 256; i++) {
      if ((SIN_TABLE[i] as number) <= (SIN_TABLE[i - 1] as number)) {
        throw new Error(`table is not increasing at ${i}: ${SIN_TABLE[i - 1]} -> ${SIN_TABLE[i]}`);
      }
    }
  });
});
