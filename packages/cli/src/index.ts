/**
 * `@sq1/cli` -- the `sq1` tool, as a library.
 *
 * Everything the command line does is reachable from here without touching a
 * filesystem: `parseArgs` turns strings into a request, and each command takes
 * that request plus a `CommandIO` and returns an exit code. `bin.ts` is the
 * only file that supplies a real `CommandIO`, which is why the whole tool can
 * be tested in memory.
 *
 * This package is a build tool. It never ships to a player.
 */

export { parseArgs, operand, usage, commandUsage, findCommand, UsageError, COMMANDS, GLOBAL_FLAGS } from "./args";
export type { ParsedArgs, CommandIO, CommandSpec, FlagSpec } from "./args";

export { buildCommand, BuildError, TOKEN_BUDGET } from "./commands/build";
export { validateCommand, loadCart, idOf } from "./commands/validate";
export type { LoadedCart, LoadResult } from "./commands/validate";
export { hashCommand } from "./commands/hash";
export { inspectCommand } from "./commands/inspect";
