import { describe, it, expect } from "vitest";

import {
  parseArgs,
  operand,
  usage,
  commandUsage,
  findCommand,
  UsageError,
  COMMANDS,
} from "../src/args";

/*
 * The parser is the tool's contract with the fingers typing at it. These tests
 * pin the accepted FORMS, and they pin the TEXT of the refusals -- because an
 * error message is the only documentation anyone reads at the moment they need
 * it, and "unknown flag" without the list of known ones sends the reader to a
 * README they do not have open.
 */

/** parseArgs, expecting it to throw, returning the message. */
function refuse(argv: readonly string[]): string {
  try {
    parseArgs(argv);
  } catch (e) {
    expect(e).toBeInstanceOf(UsageError);
    return (e as UsageError).message;
  }
  throw new Error(`parseArgs(${JSON.stringify(argv)}) was accepted, and should not have been`);
}

describe("parseArgs: operands", () => {
  it("takes the first operand as the command and leaves it out of the rest", () => {
    const a = parseArgs(["build", "examples/hello"]);
    expect(a.command).toBe("build");
    expect(a.positionals).toEqual(["examples/hello"]);
    expect(a.flags.size).toBe(0);
  });

  it("has no command when there are no words at all", () => {
    const a = parseArgs([]);
    expect(a.command).toBeNull();
    expect(a.positionals).toEqual([]);
  });

  it("keeps every operand after the first, in order", () => {
    expect(parseArgs(["hash", "a.cart", "b.cart"]).positionals).toEqual(["a.cart", "b.cart"]);
  });

  it("treats a lone dash as an operand, not a flag", () => {
    expect(parseArgs(["hash", "-"]).positionals).toEqual(["-"]);
  });
});

describe("parseArgs: flag forms", () => {
  it("accepts --flag value", () => {
    expect(parseArgs(["build", "src", "--out", "x.cart"]).flags.get("out")).toBe("x.cart");
  });

  it("accepts --flag=value", () => {
    expect(parseArgs(["build", "src", "--out=x.cart"]).flags.get("out")).toBe("x.cart");
  });

  it("keeps an = that is part of the value", () => {
    expect(parseArgs(["build", "src", "--out=a=b.cart"]).flags.get("out")).toBe("a=b.cart");
  });

  it("accepts a switch as true", () => {
    expect(parseArgs(["build", "--help"]).flags.get("help")).toBe(true);
  });

  it("accepts the short alias", () => {
    expect(parseArgs(["-h"]).flags.get("help")).toBe(true);
  });

  it("accepts a cluster of switches", () => {
    expect(parseArgs(["-hh"]).flags.get("help")).toBe(true);
  });

  it("keys flags by their long name whichever form was written", () => {
    expect([...parseArgs(["-h"]).flags.keys()]).toEqual(["help"]);
  });

  it("accepts flags written before the command", () => {
    const a = parseArgs(["--out", "x.cart", "build", "src"]);
    expect(a.command).toBe("build");
    expect(a.positionals).toEqual(["src"]);
    expect(a.flags.get("out")).toBe("x.cart");
  });

  it("lets a later flag win", () => {
    expect(parseArgs(["build", "src", "--out", "a", "--out", "b"]).flags.get("out")).toBe("b");
  });
});

describe("parseArgs: --", () => {
  it("makes every following word an operand", () => {
    const a = parseArgs(["build", "--", "--out", "-h"]);
    expect(a.command).toBe("build");
    expect(a.positionals).toEqual(["--out", "-h"]);
    expect(a.flags.size).toBe(0);
  });

  it("can supply the command itself", () => {
    expect(parseArgs(["--", "build", "src"]).command).toBe("build");
  });

  it("is not an operand", () => {
    expect(parseArgs(["build", "src", "--"]).positionals).toEqual(["src"]);
  });
});

describe("parseArgs: refusals", () => {
  it("names an unknown flag and lists what the command accepts", () => {
    expect(refuse(["build", "src", "--outt", "x"])).toBe(
      "unknown flag --outt for `sq1 build`.\n" +
        "accepted for `sq1 build`: --out <file>, -h, --help",
    );
  });

  it("lists only the global flags when there is no command", () => {
    expect(refuse(["--outt"])).toBe("unknown flag --outt.\naccepted: -h, --help");
  });

  it("refuses a flag that belongs to a different command", () => {
    expect(refuse(["validate", "a.cart", "--out", "x"])).toBe(
      "unknown flag --out for `sq1 validate`.\naccepted for `sq1 validate`: -h, --help",
    );
  });

  it("says nothing about flags when the command itself is unknown", () => {
    // `sq1 frobnicate --out x` has exactly one thing wrong with it, and a
    // complaint about --out would bury it. bin.ts reports the command.
    const a = parseArgs(["frobnicate", "--out", "x"]);
    expect(a.command).toBe("frobnicate");
    expect(a.flags.get("out")).toBe("x");
  });

  it("names an unknown short flag", () => {
    expect(refuse(["-q"])).toBe("unknown flag -q.\naccepted: -h, --help");
  });

  it("says which letter of a cluster is unknown", () => {
    expect(refuse(["-hq"])).toBe('unknown flag -q in "-hq".\naccepted: -h, --help');
  });

  it("refuses a flag with no name", () => {
    expect(refuse(["--=x"])).toBe(
      '"--=x" is not a flag: there is no name after the dashes.\naccepted: -h, --help',
    );
  });

  it("refuses a missing value at the end of the line, and shows both forms", () => {
    expect(refuse(["build", "src", "--out"])).toBe(
      "--out needs a value.\nWrite it as `--out <file>` or `--out=<file>`.",
    );
  });

  it("treats an empty value as a missing one", () => {
    expect(refuse(["build", "src", "--out="])).toBe(
      "--out needs a value.\nWrite it as `--out <file>` or `--out=<file>`.",
    );
  });

  it("refuses a value given to a switch", () => {
    expect(refuse(["build", "--help=1"])).toBe(
      '--help takes no value, but was given "1".\nWrite it as --help on its own.',
    );
  });

  it("takes the word after --out literally, even one shaped like a flag", () => {
    // The alternative -- refusing any value that starts with a dash -- makes
    // paths the tool simply cannot express, and hides the typo it was meant to
    // catch behind a second, wronger message.
    expect(parseArgs(["build", "src", "--out", "-x.cart"]).flags.get("out")).toBe("-x.cart");
  });
});

describe("operand", () => {
  it("returns the single operand", () => {
    expect(operand(parseArgs(["build", "src"]), "build", "<dir>")).toBe("src");
  });

  it("says what is missing and how to write it", () => {
    let message = "";
    try {
      operand(parseArgs(["build"]), "build", "<dir>");
    } catch (e) {
      expect(e).toBeInstanceOf(UsageError);
      message = (e as UsageError).message;
    }
    expect(message).toBe("sq1 build needs <dir>.\nUsage: sq1 build <dir>");
  });

  it("suspects an unquoted path when there are two", () => {
    let message = "";
    try {
      operand(parseArgs(["build", "my", "cart"]), "build", "<dir>");
    } catch (e) {
      message = (e as UsageError).message;
    }
    expect(message).toBe(
      'sq1 build takes one <dir>, but was given 2: "my", "cart".\n' +
        "If the path contains a space, quote it.",
    );
  });
});

describe("usage", () => {
  it("lists every command with a description", () => {
    const text = usage();
    for (const c of COMMANDS) {
      expect(text).toContain(c.name);
      expect(text).toContain(c.describe);
    }
  });

  it("shows one command's own flags", () => {
    expect(commandUsage("build")).toContain("--out <file>");
    expect(commandUsage("hash")).toContain("--format <short|long>");
    // A command's usage always offers the global flags too.
    expect(commandUsage("validate")).toContain("--help");
  });

  it("falls back to full usage for a command that does not exist", () => {
    expect(commandUsage("frobnicate")).toBe(usage());
  });

  it("finds commands by name and only by name", () => {
    expect(findCommand("build")?.name).toBe("build");
    expect(findCommand("Build")).toBeUndefined();
    expect(findCommand(null)).toBeUndefined();
  });
});
