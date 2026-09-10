/**
 * The `sq1` entry point: the only file in this package that touches a
 * filesystem, a process, or a stream.
 *
 * Run it as:
 *
 *   npx vite-node packages/cli/src/bin.ts -- build examples/hello
 *   npx vite-node packages/cli/src/bin.ts -- inspect examples/hello.cart
 *
 * WHY vite-node AND NOT `node --experimental-strip-types`
 * -------------------------------------------------------
 * Every module in this repository imports its neighbours without a file
 * extension, which is what TypeScript's `bundler` module resolution wants and
 * what the whole source tree already does. Node's ESM loader does not resolve
 * extensionless specifiers, with or without type stripping, so bare Node cannot
 * load `./commands/build` no matter how the import here is written -- and the
 * failure happens two modules deep, inside `@sq1/cart`'s own imports. `vite-node`
 * applies the same resolution the tests and the player build use, so the tool
 * runs the exact code the test suite runs. The same reasoning is written out at
 * greater length in `packages/runtime/tools/gen-golden.ts`.
 *
 * WHY THE FILESYSTEM IS INJECTED
 * ------------------------------
 * `CommandIO` is built here and passed down. Nothing under `commands/` imports
 * `node:fs`, so every command is driven in `commands.test.ts` against an
 * in-memory implementation: exact output, no temporary directories, nothing to
 * clean up, and no test that passes only on the machine that wrote it.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { CommandIO, ParsedArgs } from "./args";
import { commandUsage, findCommand, parseArgs, usage, UsageError } from "./args";
import { buildCommand } from "./commands/build";
import { hashCommand } from "./commands/hash";
import { inspectCommand } from "./commands/inspect";
import { stampCommand } from "./commands/stamp";
import { validateCommand } from "./commands/validate";

type Command = (args: ParsedArgs, io: CommandIO) => number;

const RUN: Readonly<Record<string, Command>> = {
  build: buildCommand,
  stamp: stampCommand,
  validate: validateCommand,
  hash: hashCommand,
  inspect: inspectCommand,
};

/** The real world, behind the six functions a command is allowed to use. */
const realIO: CommandIO = {
  readFile(p: string): Uint8Array {
    const buf = readFileSync(p);
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  },
  writeFile(p: string, b: Uint8Array): void {
    // Create the parent directory, so `--out build/hello.cart` works the first
    // time rather than failing on a directory the author was not asked for.
    const parent = dirname(p);
    if (parent !== "" && parent !== "." && !existsSync(parent)) {
      mkdirSync(parent, { recursive: true });
    }
    writeFileSync(p, b);
  },
  readDir(p: string): string[] {
    return readdirSync(p);
  },
  exists(p: string): boolean {
    return existsSync(p);
  },
  out(s: string): void {
    process.stdout.write(s);
  },
  err(s: string): void {
    process.stderr.write(s);
  },
};

/**
 * Strip what a launcher leaves in front of the real arguments.
 *
 * `vite-node path/to/bin.ts -- build x` can arrive with the script path and a
 * bare `--` still attached. Only LEADING ones are removed: a `--` later in the
 * line is the author's own end-of-flags marker and means something.
 */
export function scriptArgs(argv: readonly string[]): string[] {
  const args = [...argv];
  while (args.length > 0 && /(^|[\\/])bin\.ts$/.test(args[0] as string)) args.shift();
  if (args[0] === "--") args.shift();
  return args;
}

/** The whole tool, minus the process. Exported so a test can drive it. */
export function main(argv: readonly string[], io: CommandIO): number {
  let args: ParsedArgs;
  try {
    args = parseArgs(scriptArgs(argv));
  } catch (e) {
    if (e instanceof UsageError) {
      io.err(`${e.message}\n`);
      return 1;
    }
    throw e;
  }

  if (args.command === null) {
    // `sq1` and `sq1 --help` are the same request, and neither is a mistake.
    io.out(usage());
    return 0;
  }

  const spec = findCommand(args.command);
  if (spec === undefined) {
    io.err(`sq1: there is no command "${args.command}".\n\n${usage()}`);
    return 1;
  }

  if (args.flags.get("help") === true) {
    io.out(commandUsage(spec.name));
    return 0;
  }

  const run = RUN[spec.name] as Command;
  try {
    return run(args, io);
  } catch (e) {
    if (e instanceof UsageError) {
      io.err(`${e.message}\n`);
      return 1;
    }
    // Anything left is the world refusing: a permission, a full disk, a path
    // that stopped existing between `exists` and `readFile`. Say what happened;
    // never print a stack at someone building a cart.
    io.err(`sq1 ${spec.name}: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
}

process.exitCode = main(process.argv.slice(2), realIO);
