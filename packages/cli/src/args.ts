/**
 * The `sq1` argument parser, and the two declarations the rest of the CLI is
 * built on: what a command may be given, and how a command touches the world.
 *
 * THIS FILE IS PURE. No `node:fs`, no `process`, no clock, no environment. It
 * turns one array of strings into one plain object, and it says what the tool
 * accepts. That is what lets `args.test.ts` cover every flag form without a
 * temporary directory, and it is why `CommandIO` lives here as an interface
 * and is *implemented* only in `bin.ts`.
 *
 * WHY THE ACCEPTED FLAGS LIVE NEXT TO THE PARSER
 * ----------------------------------------------
 * An unknown flag is an error, never a silent ignore -- `sq1 build src --outt
 * x.cart` must not write to the default path and leave the author wondering
 * why their `--outt` did nothing. To refuse a flag the parser has to know the
 * accepted set, and to name the alternatives it has to know their shapes. So
 * the table below is the single description of the command line, used by the
 * parser to validate, by `usage()` to print, and by the tests to enumerate.
 */

/** A flag the tool accepts. `value` names the placeholder, or is null for a switch. */
export interface FlagSpec {
  /** Long name, without the leading dashes. `flags` keys by this. */
  readonly name: string;
  /** Single-character alias, without the dash, or null. */
  readonly alias: string | null;
  /** Placeholder shown in usage (`<file>`), or null when the flag takes no value. */
  readonly value: string | null;
  /** One line, lower case, no trailing period. */
  readonly describe: string;
}

/** A command the tool accepts. */
export interface CommandSpec {
  readonly name: string;
  /** Operand shape shown in usage, e.g. `<dir>`. */
  readonly operands: string;
  /** One line, lower case, no trailing period. */
  readonly describe: string;
  readonly flags: readonly FlagSpec[];
}

const HELP: FlagSpec = {
  name: "help",
  alias: "h",
  value: null,
  describe: "print this usage and exit",
};

const OUT: FlagSpec = {
  name: "out",
  alias: null,
  value: "<file>",
  describe: "where to write the cart (default: the source directory plus .cart)",
};

/**
 * `--out` for `stamp`.
 *
 * The same NAME and the same SHAPE as build's, which is what the table's
 * one-name-one-meaning check is about, and its own sentence -- a recipe's
 * default output is named after the recipe, not after a source directory.
 */
const STAMP_OUT: FlagSpec = {
  name: "out",
  alias: null,
  value: "<file>",
  describe: "where to write the cart (default: the recipe's own name plus .cart)",
};

const FRAMES: FlagSpec = {
  name: "frames",
  alias: null,
  value: "<n>",
  describe: "frames to prove the cart for before writing it (default: 600)",
};

const MODULES: FlagSpec = {
  name: "modules",
  alias: null,
  value: "<dir>",
  describe: "the module root (default: the nearest modules/ at or above the recipe)",
};

const FORMAT: FlagSpec = {
  name: "format",
  alias: null,
  value: "<short|long>",
  describe: "short is 32 characters, long is the four groups of eight (default: short)",
};

/** Flags every command accepts, including no command at all. */
export const GLOBAL_FLAGS: readonly FlagSpec[] = [HELP];

/** Every command, in the order usage lists them. */
export const COMMANDS: readonly CommandSpec[] = [
  {
    name: "build",
    operands: "<dir>",
    describe: "compile a cart source directory into a .cart file",
    flags: [OUT],
  },
  {
    name: "stamp",
    operands: "<recipe>",
    describe: "resolve a recipe into a proved cart",
    flags: [STAMP_OUT, FRAMES, MODULES],
  },
  {
    name: "validate",
    operands: "<file>",
    describe: "decode a cart and report what is wrong with it, if anything",
    flags: [],
  },
  {
    name: "hash",
    operands: "<file>",
    describe: "print a cart's id and nothing else",
    flags: [FORMAT],
  },
  {
    name: "inspect",
    operands: "<file>",
    describe: "dump a cart's header, chunks, metadata and budgets",
    flags: [],
  },
];

/**
 * How a command touches the world: eight functions, all of them injected.
 *
 * Every command takes one of these and returns an exit code. The real one is
 * built in `bin.ts` over `node:fs`; the tests build one over a `Map`. Nothing
 * in `commands/` imports `node:fs`, so nothing in `commands/` needs a
 * temporary directory to be tested, and no test leaves anything behind.
 */
export interface CommandIO {
  /** Read a whole file. Throws if it is not there; call `exists` first. */
  readFile(p: string): Uint8Array;
  writeFile(p: string, b: Uint8Array): void;
  /** Entry names directly inside `p`, not recursive, not sorted. */
  readDir(p: string): string[];
  exists(p: string): boolean;
  /** Write to standard output. The string carries its own newlines. */
  out(s: string): void;
  /** Write to standard error. The string carries its own newlines. */
  err(s: string): void;
}

export interface ParsedArgs {
  /** The first operand, which selects the command. Null when there is none. */
  command: string | null;
  /** Every other operand, in order. The command itself is not in here. */
  positionals: string[];
  /** Keyed by long name without dashes. `true` for a flag that takes no value. */
  flags: Map<string, string | true>;
}

/**
 * A command line that cannot be obeyed. Its message is the whole diagnosis and
 * is written to stderr verbatim; callers add nothing to it.
 */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
    // Keep `instanceof` working when this file is downlevelled.
    Object.setPrototypeOf(this, UsageError.prototype);
  }
}

/** The command spec by name, or undefined for a name the tool does not have. */
export function findCommand(name: string | null): CommandSpec | undefined {
  if (name === null) return undefined;
  return COMMANDS.find((c) => c.name === name);
}

/** `--out <file>`, the form used in every message that lists a flag. */
function flagForm(f: FlagSpec): string {
  const dashed = f.alias === null ? `--${f.name}` : `-${f.alias}, --${f.name}`;
  return f.value === null ? dashed : `${dashed} ${f.value}`;
}

/** Every flag accepted for a command, globals last. */
function acceptedFlags(command: string | null): readonly FlagSpec[] {
  const spec = findCommand(command);
  return spec === undefined ? GLOBAL_FLAGS : [...spec.flags, ...GLOBAL_FLAGS];
}

/**
 * The union of every flag in the table, keyed by long name and by alias.
 *
 * The parser needs a flag's arity (`--out x` consumes the next word, `--help`
 * does not) *before* it knows which command was asked for, because flags may
 * come first: `sq1 --help build` is a legal thing to type. A name that meant
 * different things in different commands would make that impossible, so the
 * table is checked for exactly that at module load.
 */
const BY_TOKEN = new Map<string, FlagSpec>();
{
  const all: FlagSpec[] = [...GLOBAL_FLAGS];
  for (const c of COMMANDS) all.push(...c.flags);
  for (const f of all) {
    const seen = BY_TOKEN.get(f.name);
    if (seen !== undefined && seen.value !== f.value) {
      throw new Error(
        `flag --${f.name} is declared with two different shapes; one name must mean one thing`,
      );
    }
    BY_TOKEN.set(f.name, f);
    if (f.alias !== null) BY_TOKEN.set(f.alias, f);
  }
}

/** Full usage: what the tool is, every command, the global flags. */
export function usage(): string {
  const width = Math.max(...COMMANDS.map((c) => `${c.name} ${c.operands}`.length));
  const lines = [
    "sq1 - the Square One cart tool",
    "",
    "Usage: sq1 <command> [options]",
    "",
    "Commands:",
  ];
  for (const c of COMMANDS) {
    lines.push(`  ${`${c.name} ${c.operands}`.padEnd(width)}   ${c.describe}`);
  }
  lines.push("", "Options:");
  for (const f of GLOBAL_FLAGS) lines.push(`  ${flagForm(f).padEnd(width)}   ${f.describe}`);
  lines.push(
    "",
    "Run `sq1 <command> --help` for one command.",
    "",
  );
  return lines.join("\n");
}

/** Usage for one command: its operands, its flags, and the globals. */
export function commandUsage(name: string): string {
  const spec = findCommand(name);
  if (spec === undefined) return usage();
  const flags = acceptedFlags(name);
  const width = Math.max(...flags.map((f) => flagForm(f).length));
  const lines = [
    `sq1 ${spec.name} ${spec.operands} - ${spec.describe}`,
    "",
    `Usage: sq1 ${spec.name} ${spec.operands} [options]`,
    "",
    "Options:",
  ];
  for (const f of flags) lines.push(`  ${flagForm(f).padEnd(width)}   ${f.describe}`);
  lines.push("");
  return lines.join("\n");
}

/** "accepted here: --out <file>, -h, --help" -- the second line of every flag error. */
function acceptedLine(command: string | null): string {
  const flags = acceptedFlags(command);
  const where = command === null ? "accepted" : `accepted for \`sq1 ${command}\``;
  return `${where}: ${flags.map(flagForm).join(", ")}`;
}

/**
 * The single operand a command needs, or a `UsageError` explaining the shape.
 *
 * Every command in the tool takes exactly one path, so "you gave me none" and
 * "you gave me three" are both worth catching here rather than in four places.
 * Two paths usually means an unquoted path with a space in it, which the second
 * message says out loud.
 */
export function operand(args: ParsedArgs, command: string, placeholder: string): string {
  const first = args.positionals[0];
  if (first === undefined) {
    throw new UsageError(
      `sq1 ${command} needs ${placeholder}.\n` + `Usage: sq1 ${command} ${placeholder}`,
    );
  }
  if (args.positionals.length > 1) {
    throw new UsageError(
      `sq1 ${command} takes one ${placeholder}, but was given ${args.positionals.length}: ` +
        `${args.positionals.map((p) => `"${p}"`).join(", ")}.\n` +
        `If the path contains a space, quote it.`,
    );
  }
  return first;
}

/**
 * Turn a command line into a `ParsedArgs`, or throw a `UsageError` saying
 * exactly which word could not be obeyed and what could have been written
 * instead.
 *
 * Accepted forms:
 *   --flag            a switch
 *   --flag value      a flag and its value as two words
 *   --flag=value      a flag and its value as one word
 *   -h                a single-character alias
 *   -abc              a cluster of aliases, each of which must be a switch
 *   --                end of flags; every word after it is an operand
 *   -                 an operand, by the usual convention for standard input
 *
 * The first operand becomes `command` and is not repeated in `positionals`.
 *
 * A flag on a command the tool does not have is NOT reported here. `sq1
 * frobnicate --out x` has one thing wrong with it -- `frobnicate` -- and
 * saying so is the caller's job; a complaint about `--out` would bury it.
 */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  const parsed: ParsedArgs = { command: null, positionals: [], flags: new Map() };
  /** Flags in the order they were written, so the error names the first bad one. */
  const written: string[] = [];
  let endOfFlags = false;

  const operand = (w: string): void => {
    if (parsed.command === null) parsed.command = w;
    else parsed.positionals.push(w);
  };

  const set = (token: string, spec: FlagSpec | undefined, value: string | null): void => {
    const name = spec === undefined ? token.replace(/^--?/, "") : spec.name;
    if (spec !== undefined) {
      if (spec.value === null && value !== null) {
        throw new UsageError(
          `${token} takes no value, but was given "${value}".\n` +
            `Write it as ${token} on its own.`,
        );
      }
      // An empty value is a missing value: `--out=` is a typo, not a request
      // to write to a file with no name.
      if (spec.value !== null && (value === null || value === "")) {
        throw new UsageError(
          `${token} needs a value.\n` +
            `Write it as \`${token} ${spec.value}\` or \`${token}=${spec.value}\`.`,
        );
      }
    }
    if (!written.includes(name)) written.push(name);
    parsed.flags.set(name, value === null ? true : value);
  };

  for (let i = 0; i < argv.length; i++) {
    const word = argv[i] as string;

    if (endOfFlags) {
      operand(word);
      continue;
    }
    if (word === "--") {
      endOfFlags = true;
      continue;
    }
    if (word === "-" || !word.startsWith("-")) {
      operand(word);
      continue;
    }

    if (word.startsWith("--")) {
      const eq = word.indexOf("=");
      const token = eq === -1 ? word : word.slice(0, eq);
      const inline = eq === -1 ? null : word.slice(eq + 1);
      const name = token.slice(2);
      if (name === "") {
        throw new UsageError(
          `"${word}" is not a flag: there is no name after the dashes.\n` +
            `${acceptedLine(parsed.command)}`,
        );
      }
      const spec = BY_TOKEN.get(name);
      // A flag the table has never heard of has no arity, so it cannot eat the
      // next word. It is recorded as a switch and refused by the check below.
      if (spec !== undefined && spec.value !== null && inline === null) {
        const next = argv[++i];
        if (next === undefined) {
          throw new UsageError(
            `${token} needs a value.\n` +
              `Write it as \`${token} ${spec.value}\` or \`${token}=${spec.value}\`.`,
          );
        }
        set(token, spec, next);
      } else {
        set(token, spec, inline);
      }
      continue;
    }

    // A short cluster: -h, or -abc for three switches. A short flag that takes
    // a value may only be written on its own, where it behaves like its long
    // form.
    const cluster = word.slice(1);
    for (let k = 0; k < cluster.length; k++) {
      const ch = cluster[k] as string;
      const spec = BY_TOKEN.get(ch);
      if (spec === undefined) {
        throw new UsageError(
          `unknown flag -${ch}${cluster.length > 1 ? ` in "${word}"` : ""}.\n` +
            `${acceptedLine(parsed.command)}`,
        );
      }
      if (spec.value !== null) {
        if (cluster.length > 1) {
          throw new UsageError(
            `-${ch} needs a value, so it cannot be bundled into "${word}".\n` +
              `Write it as \`-${ch} ${spec.value}\`.`,
          );
        }
        const next = argv[++i];
        if (next === undefined) {
          throw new UsageError(
            `-${ch} needs a value.\n` + `Write it as \`-${ch} ${spec.value}\`.`,
          );
        }
        set(`-${ch}`, spec, next);
      } else {
        set(`-${ch}`, spec, null);
      }
    }
  }

  // Validation happens last, because the accepted set depends on the command
  // and the command may have been typed after the flags.
  const spec = findCommand(parsed.command);
  if (parsed.command === null || spec !== undefined) {
    const allowed = new Set(acceptedFlags(parsed.command).map((f) => f.name));
    for (const name of written) {
      if (!allowed.has(name)) {
        throw new UsageError(
          `unknown flag --${name}${parsed.command === null ? "" : ` for \`sq1 ${parsed.command}\``}.\n` +
            `${acceptedLine(parsed.command)}`,
        );
      }
    }
  }

  return parsed;
}
