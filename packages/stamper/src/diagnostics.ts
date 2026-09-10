/**
 * Diagnostics: THE PRODUCT.
 *
 * The stamper's whole claim is that a recipe fails like a compiler rather than
 * like a crash. That claim is cashed here, in one shape used by every stage:
 *
 *     recipe.toml:14:1  error[unbound-knob]  engine platformer@1.0.0 requires knob
 *                       `jump_velocity`, which the [tuning] table does not set.
 *                       Add:  jump_velocity = -3.1   # -8.0 .. 0.0, upward speed of a jump
 *
 * If a diagnostic is vague, an author abandons the recipe format for the
 * inline-code escape hatch, and the module ecosystem never forms. That is the
 * entire ergonomic case for recipes, so a message that does not name the file,
 * the line and the fix is a bug in this package, not a rough edge.
 *
 * THE CODE IS A CONTRACT
 * ----------------------
 * `code` is stable, lower-case-with-hyphens, and greppable. A test asserts on
 * the code; a message is free to be reworded to teach better. Rewording a code
 * breaks somebody's CI filter, so codes are added rather than changed.
 *
 * ORDER IS DETERMINISTIC
 * ----------------------
 * `sortDiagnostics` puts them in file, line, column, code order, so two runs of
 * the same broken recipe print the same list in the same order -- for the same
 * reason the cart bytes are reproducible: a diff that changes when nothing
 * changed is a diff nobody reads.
 */

export type Severity = "error" | "warning";

export interface Diagnostic {
  readonly severity: Severity;
  /** Stable and greppable, e.g. "unbound-knob". Never reworded. */
  readonly code: string;
  /** The whole diagnosis, phrased for an author. May contain newlines. */
  readonly message: string;
  /** The file the author edits to fix it. Always a path they typed or a module path. */
  readonly file: string;
  /** 1-based. */
  readonly line: number;
  /** 1-based, in UTF-16 code units. */
  readonly column: number;
  /** The fix, spelled out. Usually a line they can paste. */
  readonly suggestion?: string;
}

/** Every code this package can emit, so a reader can see the whole surface at once. */
export const DIAGNOSTIC_CODES = [
  // reading files
  "malformed-toml",
  "missing-recipe",
  "missing-module",
  "missing-module-file",
  // manifests
  "bad-manifest",
  "bad-knob-name",
  "module-kind-mismatch",
  "module-version-mismatch",
  // A MANIFEST IS A CLAIM, AND THESE ARE THE CLAIMS CHECKED AGAINST BYTES.
  // Everything above this line is a manifest read against other manifest text.
  // These four are read against something outside the text: the flag bytes a
  // pack ships, the length of its data file, the size of the pack a knob
  // indexes into, and an earlier layer's declaration of the same knob.
  "flag-not-in-data",
  "flag-bit-mismatch",
  "data-size-mismatch",
  "index-out-of-pack",
  "knob-redeclared",
  // the recipe
  "bad-recipe",
  "bad-module-ref",
  "unsupported-profile",
  "unsupported-spec",
  // knobs
  "unbound-knob",
  "unknown-knob",
  "knob-out-of-range",
  "knob-type",
  // interfaces
  "unsatisfied-requires",
  "missing-engine",
  // budgets and the gate
  "token-budget",
  "cart-budget",
  "chunk-too-large",
  "palette-not-installed",
  "forbidden-identifier",
  "empty-source",
  "missing-tick",
  "engine-not-javascript",
  // proving
  "prove-failed",
  "pack-failed",
] as const;

export type DiagnosticCode = (typeof DIAGNOSTIC_CODES)[number];

/** What a diagnostic needs, with `suggestion` genuinely optional. */
export interface DiagnosticInit {
  readonly severity?: Severity;
  readonly code: DiagnosticCode;
  readonly message: string;
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly suggestion?: string;
}

/**
 * Build a diagnostic.
 *
 * The `suggestion` field is OMITTED rather than set to `undefined` when there
 * is none: `exactOptionalPropertyTypes` is on across this repository, and
 * `{ suggestion: undefined }` is not a `{ suggestion?: string }`.
 */
export function diag(init: DiagnosticInit): Diagnostic {
  const base = {
    severity: init.severity ?? "error",
    code: init.code,
    message: init.message,
    file: init.file,
    line: init.line,
    column: init.column,
  } as const;
  return init.suggestion === undefined ? base : { ...base, suggestion: init.suggestion };
}

/** True when anything in the list would refuse the build. */
export function hasErrors(ds: readonly Diagnostic[]): boolean {
  return ds.some((d) => d.severity === "error");
}

/**
 * File, then line, then column, then code, then message.
 *
 * A stable total order, so the printed list never depends on which stage
 * happened to notice a problem first.
 */
export function sortDiagnostics(ds: readonly Diagnostic[]): Diagnostic[] {
  return [...ds].sort((a, b) => {
    if (a.file !== b.file) return a.file < b.file ? -1 : 1;
    if (a.line !== b.line) return a.line - b.line;
    if (a.column !== b.column) return a.column - b.column;
    if (a.code !== b.code) return a.code < b.code ? -1 : 1;
    return a.message < b.message ? -1 : a.message > b.message ? 1 : 0;
  });
}

/**
 * The continuation indent, in spaces.
 *
 * Fixed rather than computed from the length of `file:line:column`, so a list
 * of diagnostics about several files stays in one column and reads as one
 * block. Every line after the first -- the rest of a multi-line message, and
 * the suggestion -- is indented by this much.
 */
export const CONTINUATION_INDENT = 18;

/**
 * One diagnostic, in the shape at the top of this file, with NO trailing
 * newline. The caller joins them, because a caller printing one diagnostic and
 * a caller printing twelve want different separators.
 */
export function formatDiagnostic(d: Diagnostic): string {
  const pad = " ".repeat(CONTINUATION_INDENT);
  const [head = "", ...rest] = d.message.split("\n");
  const lines = [`${d.file}:${d.line}:${d.column}  ${d.severity}[${d.code}]  ${head}`];
  for (const line of rest) lines.push(pad + line);
  if (d.suggestion !== undefined) {
    for (const line of d.suggestion.split("\n")) lines.push(pad + line);
  }
  return lines.join("\n");
}

/** A whole list, sorted, one diagnostic per block, with a trailing newline. */
export function formatDiagnostics(ds: readonly Diagnostic[]): string {
  if (ds.length === 0) return "";
  return sortDiagnostics(ds).map(formatDiagnostic).join("\n") + "\n";
}

/**
 * The closest name in `candidates` to `name`, or null when nothing is close.
 *
 * Used for "did you mean" on an unknown knob. The threshold is deliberately
 * tight -- a third of the length, at least one edit -- because a wrong
 * suggestion is worse than none: it sends an author to rename a knob that was
 * never the problem.
 */
export function nearest(name: string, candidates: readonly string[]): string | null {
  let best: string | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  const limit = Math.max(1, Math.floor(name.length / 3));
  for (const c of [...candidates].sort()) {
    const d = editDistance(name, c);
    if (d < bestDistance) {
      bestDistance = d;
      best = c;
    }
  }
  return bestDistance <= limit ? best : null;
}

/** Levenshtein distance, two rows. Small inputs; clarity over cleverness. */
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  let prev = new Array<number>(b.length + 1);
  let cur = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1;
      cur[j] = Math.min(
        (cur[j - 1] as number) + 1,
        (prev[j] as number) + 1,
        (prev[j - 1] as number) + cost,
      );
    }
    const swap = prev;
    prev = cur;
    cur = swap;
  }
  return prev[b.length] as number;
}
