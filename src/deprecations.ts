/**
 * deprecations — stderr warnings for changed or removed CLI flags (#141).
 *
 * Goal: when an old wrapper script (cron job, shell script, agent skill) calls
 * `mk` with a flag that has been removed or renamed, the user sees a single
 * actionable line on stderr explaining the migration — instead of either a
 * silent behavior change or a bare commander "unknown option" error.
 *
 * Scope: argv-level only. This module does not detect deprecated *behavior*
 * (e.g. a still-supported flag whose default changed without renaming) — for
 * that, prefer `mk doctor` (#140).
 */

export type DeprecationKind = 'removed' | 'renamed' | 'changed-default';

export interface FlagDeprecation {
  /** The deprecated flag, exactly as the user types it (e.g. `--fill`). */
  flag: string;
  /** Version in which the flag was removed, renamed, or had its default changed. */
  since: string;
  /**
   * `removed`         — flag is gone; we warn and strip it from argv so
   *                     commander doesn't bail with "unknown option".
   * `renamed`         — flag was renamed; we warn and rewrite to the new name
   *                     in place (preserving any `=value` suffix).
   * `changed-default` — flag still parses but its default changed; we warn and
   *                     pass it through unchanged.
   */
  kind: DeprecationKind;
  /** Migration hint shown after the headline. */
  hint: string;
  /** Required when `kind === 'renamed'`. */
  renamedTo?: string;
}

/**
 * Registry of deprecated flags. Add an entry here when removing or renaming
 * a flag from the CLI. Order doesn't matter — lookup is by exact prefix match.
 *
 * Constraint: every argv token is checked independently, so a registered flag
 * is stripped/rewritten regardless of whether it sits in flag position or
 * value/positional position. Two real-world footguns to keep in mind when
 * adding an entry:
 *
 *   1. A literal value that happens to equal the deprecated flag. Example:
 *      `mk remember "--fill is no longer needed"` (body is a positional arg).
 *      The scanner sees `--fill` as its own token and strips it, mangling the
 *      body. Workaround: callers pass the literal via `--body=--fill ...` or
 *      quote-prefix it so the token doesn't equal the flag exactly.
 *
 *   2. A value that follows another flag and equals the deprecated flag.
 *      Example: a hypothetical `mk foo --label --fill`. Same outcome.
 *      Workaround: same `--label=--fill` form, which the scanner does not
 *      touch.
 *
 * In short: only add entries for flags whose literal text is implausible as a
 * user-supplied value. The default registry (`--fill`) meets that bar — the
 * existing test `does not match a positional that happens to equal a flag
 * name` in `test/deprecations.test.ts` pins this trade-off so it doesn't
 * silently drift.
 */
export const DEPRECATED_FLAGS: readonly FlagDeprecation[] = [
  {
    flag: '--fill',
    since: '1.18.9',
    kind: 'removed',
    hint: 'Fill mode is now the default. Remove --fill from your command, or use --no-fill to opt out.',
  },
];

function suppressWarnings(env: NodeJS.ProcessEnv): boolean {
  const flag = env.MK_NO_DEPRECATION_WARNINGS ?? env.MK_QUIET ?? '';
  return flag === '1' || flag.toLowerCase() === 'true';
}

/** Format a single deprecation warning line. Exported for testing. */
export function formatWarning(d: FlagDeprecation): string {
  let headline: string;
  switch (d.kind) {
    case 'removed':
      headline = `${d.flag} has been removed in ${d.since}.`;
      break;
    case 'renamed':
      headline = `${d.flag} was renamed to ${d.renamedTo} in ${d.since}.`;
      break;
    case 'changed-default':
      headline = `${d.flag} default changed in ${d.since}.`;
      break;
  }
  return `mk: warning: ${headline} ${d.hint}`;
}

export interface ProcessOptions {
  registry?: readonly FlagDeprecation[];
  stderr?: NodeJS.WritableStream;
  env?: NodeJS.ProcessEnv;
}

/**
 * Scan argv for deprecated flags and return a (possibly rewritten) copy.
 *
 * Side effect: writes one warning per match to stderr, unless suppressed via
 * `MK_NO_DEPRECATION_WARNINGS=1` or `MK_QUIET=1` (warnings only — the argv
 * rewrite still happens so existing scripts keep working).
 *
 * Matches both `--flag` and `--flag=value` forms. Does not interpret
 * positional args that happen to look like flag values.
 */
export function processDeprecatedFlags(
  argv: readonly string[],
  opts: ProcessOptions = {},
): string[] {
  const registry = opts.registry ?? DEPRECATED_FLAGS;
  const stderr = opts.stderr ?? process.stderr;
  const env = opts.env ?? process.env;
  const suppress = suppressWarnings(env);

  const out: string[] = [];
  for (const arg of argv) {
    const match = registry.find(
      (d) => arg === d.flag || arg.startsWith(d.flag + '='),
    );
    if (!match) {
      out.push(arg);
      continue;
    }

    if (!suppress) {
      stderr.write(formatWarning(match) + '\n');
    }

    switch (match.kind) {
      case 'removed':
        // Drop entirely so commander doesn't see it.
        continue;
      case 'renamed': {
        if (!match.renamedTo) {
          // Misconfigured entry — pass through unchanged rather than dropping.
          out.push(arg);
          continue;
        }
        const eqIdx = arg.indexOf('=');
        out.push(eqIdx >= 0 ? match.renamedTo + arg.slice(eqIdx) : match.renamedTo);
        continue;
      }
      case 'changed-default':
        out.push(arg);
        continue;
    }
  }
  return out;
}

/**
 * Stats derived from a rendered CLAUDE.md string. Used by the render command
 * to detect degenerate output (0 atoms, monoculture-by-type) and emit a
 * stderr warning.
 *
 * Keeping this here (rather than coupling it to render.ts) lets the warnings
 * be evolved without touching the public render API.
 */
export interface RenderOutputStats {
  totalAtoms: number;
  /** Section name → atom count, e.g. {'Key Facts': 3, 'Beliefs': 25}. */
  bySection: Record<string, number>;
}

/**
 * Parse a rendered CLAUDE.md string for atom and section counts.
 *
 * Recognises every `## ` section emitted by `src/render.ts` and counts atom
 * rows inside each. Two atom-row formats are matched:
 *   1. `### <atom-id>` — the original heading-per-atom layout used by most
 *      sections.
 *   2. `**<ATOM-ID>**` (optionally preceded by indentation and a `→ ` arrow)
 *      — the bullet layout used by belief developmental arcs and standalone
 *      beliefs inside the `## Beliefs (developmental arcs)` section.
 *
 * Structural subheadings inside arc sections are skipped (not counted as
 * atoms): `### Arc: ...` (one per arc) and `### Standalone beliefs` (the
 * separator between arc-attached and standalone beliefs).
 *
 * Robust to the bootstrap "Getting Started" block (no `### ` headers within).
 */
export function parseRenderStats(content: string): RenderOutputStats {
  const bySection: Record<string, number> = {};
  let currentSection: string | null = null;
  let totalAtoms = 0;

  // Recognise two atom-row formats inside a `## Section` block:
  //   1. `### <atom-id>` — the original heading-per-atom layout used by every
  //      section except belief developmental arcs.
  //   2. `**<ATOM-ID>**` (optionally preceded by indentation and a `→ ` arrow)
  //      — the bullet layout used by belief developmental arcs and standalone
  //      beliefs inside the `## Beliefs (developmental arcs)` section.
  //
  // The arc section contains two structural `### ` subheadings that must NOT
  // be counted as atoms: `### Arc: ...` (one per arc) and `### Standalone
  // beliefs` (separator). We skip those by exact prefix before considering
  // the line as an atom.
  const ARC_HEADING_RE = /^### Arc:/;
  const STANDALONE_HEADING_RE = /^### Standalone beliefs\b/;
  // If src/render.ts ever adds a new structural `### ` subheading inside any
  // `## ` section, add it to the skip list above so it isn't counted as an
  // atom.
  const HASH_ATOM_RE = /^### \S+/;
  // Optional leading whitespace (indented arc children) and optional `→ `
  // prefix, then `**<id>**` where <id> matches the generateAtomId() shape:
  // uppercase type prefix, ISO date, then arbitrary suffix. The strict shape
  // prevents bold body emphasis like `**Note**:` from inflating the count.
  const BULLET_ATOM_RE = /^\s*(?:→\s+)?\*\*([A-Z][A-Z_]*-\d{4}-\d{2}-\d{2}-\S+?)\*\*/;

  for (const line of content.split('\n')) {
    if (line.startsWith('## ')) {
      // Strip the leading "## " and any leading non-word glyph (e.g. "⚠ ").
      currentSection = line.slice(3).replace(/^[^\w]+/, '').trim();
      if (currentSection && !(currentSection in bySection)) {
        bySection[currentSection] = 0;
      }
      continue;
    }
    if (!currentSection) continue;

    // Non-atom subheadings inside a section (arc header, standalone marker).
    if (ARC_HEADING_RE.test(line) || STANDALONE_HEADING_RE.test(line)) continue;

    if (HASH_ATOM_RE.test(line) || BULLET_ATOM_RE.test(line)) {
      bySection[currentSection] = (bySection[currentSection] ?? 0) + 1;
      totalAtoms += 1;
    }
  }

  // Drop section buckets that ended up with zero entries (e.g. "Getting Started").
  for (const k of Object.keys(bySection)) {
    if (bySection[k] === 0) delete bySection[k];
  }

  return { totalAtoms, bySection };
}

/**
 * Decide whether to emit a degenerate-output warning, and what to say.
 *
 * Cases:
 *   - 0 atoms          → silent-success footgun (Taj's 30-day empty CLAUDE.md).
 *   - single section   → monoculture (e.g. only `Beliefs` populated when other
 *                        types are starved by budget or recall config).
 *
 * Returns the warning string, or `null` if the output looks healthy. The
 * caller is responsible for writing it to stderr (kept pure for testability).
 */
export function degenerateOutputWarning(stats: RenderOutputStats): string | null {
  if (stats.totalAtoms === 0) {
    return 'mk: warning: render produced 0 atoms. Check that the memory directory contains active atoms and that the recall budget / render config are not filtering them all out.';
  }
  const sections = Object.keys(stats.bySection);
  if (sections.length === 1 && stats.totalAtoms >= 5) {
    const only = sections[0];
    return `mk: warning: render produced ${stats.totalAtoms} atoms but all are '${only}'. Other atom types may be starved by budget or render.yaml type_weights.`;
  }
  return null;
}
