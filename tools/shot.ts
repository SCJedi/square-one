/**
 * Render frames of a real cart to PNG, so a person can look at them.
 *
 *   npx vite-node tools/shot.ts -- examples/red-breaker.cart 1 60 120
 *
 * `conformance/README.md` says it plainly: a golden master locks in whatever the
 * code did on the day it was generated, including a bug, so generating a case is
 * an assertion that the output is CORRECT and not merely stable. That assertion
 * needs eyes. This is the shortest path from a cart file to something eyes can
 * be pointed at.
 *
 * It drives the cart exactly the way a player would be driven -- through
 * `loadCartBytes` and a real machine with its data chunks installed -- rather
 * than through any test scaffolding, so what comes out is what a player sees.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { createMachine, loadCartBytes } from "@sq1/runtime";
import { encodePng } from "../packages/runtime/tools/png";

const argv = process.argv.slice(2).filter((a) => a !== "--" && !a.endsWith("shot.ts"));
const cartPath = argv[0];
if (cartPath === undefined) {
  process.stderr.write("usage: vite-node tools/shot.ts -- <cart> [frame...]\n");
  process.exit(1);
}

const frames = argv.slice(1).map(Number).filter((n) => Number.isInteger(n) && n >= 0);
const wanted = new Set(frames.length > 0 ? frames : [1, 30, 60, 120]);
const last = Math.max(...wanted);

const bytes = new Uint8Array(readFileSync(cartPath));
const loaded = loadCartBytes(bytes);
if (!loaded.ok) {
  process.stderr.write(`${cartPath}: ${loaded.error.code} - ${loaded.error.message}\n`);
  process.exit(1);
}

const machine = createMachine(loaded.program, { data: loaded.data });
machine.boot(1);

// A held input so the paddle actually moves and the ball is served: without one
// a shot of frame 120 is the same picture as frame 1 and proves nothing.
const input = new Uint8Array(4);
const RIGHT = 1 << 3;
const A = 1 << 4;

const outDir = "shots";
mkdirSync(outDir, { recursive: true });

for (let f = 1; f <= last; f++) {
  input[0] = (f < 4 ? A : 0) | (((f >> 5) & 1) === 0 ? RIGHT : 0);
  machine.tick(input);
  machine.present();
  if (wanted.has(f)) {
    const name = join(outDir, `${String(f).padStart(4, "0")}.png`);
    writeFileSync(name, encodePng(machine.rgba, 128, 128));
    // Which live colours actually reached the screen, so a colour change that
    // is supposed to be visible can be checked without opening the file.
    const seen = new Set<number>();
    for (let i = 0; i < machine.ram.length && i < 0x2000; i++) {
      seen.add(machine.ram[i]! & 0x0f);
      seen.add(machine.ram[i]! >>> 4);
    }
    process.stdout.write(
      `${name}  live colours on screen: ${[...seen].sort((a, b) => a - b).join(",")}\n`,
    );
  }
}
