/**
 * schema check — validates every atom's frontmatter against the Zod schema.
 *
 * Phase 1 (#157) extracted this from the inline `mk doctor` logic for the
 * registry refactor (#140). Phase 2 (#191) splits it into a structured
 * `probe()` + `run()` + `fix()` trio that matches the other auto-fixable
 * checks. Commit 1 exposed the failing values via a survey-only fix; this
 * commit wires those values into a migrations table and applies the
 * registered normalisations, with a `.bak` written before each modified
 * atom so the operator can `git diff` (or restore) the original.
 */

import fs from 'fs';
import { listAtoms, validateAtomFrontmatter } from '../../index.js';
import { serializeAtom } from '../../format.js';
import { readAtom, writeAtom } from '../../store.js';
import type { Atom, AtomFrontmatter } from '../../types.js';
import type { Check, CheckResult, DoctorContext, FixOpts, FixOutcome } from '../types.js';
import { lookupMigration, migrationKey } from './schema-migrations.js';

/**
 * One Zod-flagged failure on a single atom. The `path` is the Zod issue path
 * (already array form). `actualValue` is whatever currently sits at that
 * path in the atom's raw frontmatter — the migrations table keys off this
 * value, not off Zod's message string.
 */
export interface SchemaFailure {
  path: (string | number)[];
  actualValue: unknown;
  code: string;
  /** Present for `invalid_enum_value` / `invalid_value` issues. */
  expected?: readonly unknown[];
  /** Raw Zod issue, kept for diagnostic fidelity. */
  raw: unknown;
}

export interface SchemaProbe {
  atomId: string;
  /** Absolute path on disk, or undefined if the atom was loaded without one. */
  atomPath?: string;
  failures: SchemaFailure[];
}

interface ZodIssueShape {
  path: (string | number)[];
  code: string;
  message?: string;
  options?: readonly unknown[];
  expected?: unknown;
}

function extractValueAtPath(root: unknown, p: (string | number)[]): unknown {
  let cur: unknown = root;
  for (const seg of p) {
    if (cur == null) return undefined;
    if (typeof cur === 'object') {
      cur = (cur as Record<string | number, unknown>)[seg];
    } else {
      return undefined;
    }
  }
  return cur;
}

function probe(memoryDir: string): SchemaProbe[] {
  const probes: SchemaProbe[] = [];
  const atoms = listAtoms(memoryDir);
  for (const atom of atoms) {
    const result = validateAtomFrontmatter(atom.frontmatter);
    if (result.success) continue;
    const failures: SchemaFailure[] = [];
    for (const issue of result.error.issues as ZodIssueShape[]) {
      const path = issue.path ?? [];
      failures.push({
        path,
        actualValue: extractValueAtPath(atom.frontmatter, path),
        code: issue.code,
        expected: Array.isArray(issue.options) ? issue.options : undefined,
        raw: issue,
      });
    }
    probes.push({
      atomId: (atom.frontmatter as { id?: string }).id ?? '<no-id>',
      atomPath: atom.filePath,
      failures,
    });
  }
  return probes;
}

function joinPath(p: (string | number)[]): string {
  return p.length === 0 ? '(root)' : p.join('.');
}

function formatActual(v: unknown): string {
  if (v === undefined) return '<undefined>';
  return JSON.stringify(v);
}

/**
 * Resolve the .bak path for an atom: prefer the canonical `<path>.bak`, but
 * fall back to a timestamped suffix if a prior fix run already created one.
 * Never overwrite a pre-existing backup.
 *
 * Note: the existsSync / copyFileSync pair is intentionally non-atomic.
 * `mk doctor` is a single-user CLI invoked serially — two concurrent
 * `--fix` passes on the same store are not a supported workload. If this
 * pattern is ever lifted into a daemon or concurrent codepath, switch to
 * `open(..., O_CREAT | O_EXCL)` for the canonical name and retry with a
 * timestamped name on EEXIST.
 */
function resolveBakPath(atomPath: string): string {
  const canonical = atomPath + '.bak';
  if (!fs.existsSync(canonical)) return canonical;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `${atomPath}.bak.${stamp}`;
}

/**
 * Mutate a copy of `fm` by writing `value` at the given Zod path.
 *
 * Returns `null` if any intermediate path segment is absent or non-object,
 * so the caller can route the failure into `remaining[]`/`errors[]`
 * instead of throwing an uncaught runtime error. In normal flow `probe()`
 * only surfaces paths that produced a Zod issue, which means they exist
 * at least to the failing depth — but a future migration that targets a
 * deeper field on a partially-missing nested object would hit this guard.
 */
function applyAtPath(fm: AtomFrontmatter, path: (string | number)[], value: string): AtomFrontmatter | null {
  if (path.length === 0) return null;
  const next = JSON.parse(JSON.stringify(fm)) as AtomFrontmatter;
  let cur: Record<string | number, unknown> = next as unknown as Record<string | number, unknown>;
  for (let i = 0; i < path.length - 1; i++) {
    const step = cur[path[i]];
    if (step == null || typeof step !== 'object') return null;
    cur = step as Record<string | number, unknown>;
  }
  cur[path[path.length - 1]] = value;
  return next;
}

interface PlannedMigration {
  failure: SchemaFailure;
  /** Canonical replacement value. */
  to: string;
}

interface UnplannedReason {
  failure: SchemaFailure;
  reason: 'unknown' | 'manual-review' | 'non-string-value';
}

interface AtomPlan {
  probe: SchemaProbe;
  planned: PlannedMigration[];
  unplanned: UnplannedReason[];
}

function planAtom(p: SchemaProbe): AtomPlan {
  const planned: PlannedMigration[] = [];
  const unplanned: UnplannedReason[] = [];
  for (const f of p.failures) {
    if (typeof f.actualValue !== 'string') {
      unplanned.push({ failure: f, reason: 'non-string-value' });
      continue;
    }
    const key = migrationKey(f.path);
    const target = lookupMigration(key, f.actualValue);
    if (target === undefined) {
      unplanned.push({ failure: f, reason: 'unknown' });
    } else if (target === null) {
      unplanned.push({ failure: f, reason: 'manual-review' });
    } else {
      planned.push({ failure: f, to: target });
    }
  }
  return { probe: p, planned, unplanned };
}

function formatUnplanned(p: SchemaProbe, u: UnplannedReason): string {
  const head = `${p.atomId}.${joinPath(u.failure.path)}: ${formatActual(u.failure.actualValue)}`;
  switch (u.reason) {
    case 'unknown':
      return `${head} — no migration registered`;
    case 'manual-review':
      return `${head} — known legacy value, manual review required`;
    case 'non-string-value':
      return `${head} — structural failure (manual edit required)`;
  }
}

function formatPlanned(p: SchemaProbe, m: PlannedMigration, dryRun: boolean): string {
  const verb = dryRun ? 'would migrate' : 'migrated';
  return `[migration] ${verb} ${p.atomId}.${joinPath(m.failure.path)}: ${formatActual(m.failure.actualValue)} → ${JSON.stringify(m.to)}`;
}

/**
 * Detect canonical-serialization side effects an atom's first write would
 * trigger. Each `--fix` rewrite re-runs the atom through `serializeAtom()`,
 * which normalises legacy formatting beyond the requested enum migration
 * (e.g. comma-joined `scope.tags` get split into separate items, the
 * Obsidian `<!-- mk:relations -->` section gets appended). These changes
 * are reported as `[normalization]` lines so operators can distinguish
 * migration intent from incidental cleanup without opening the `.bak`.
 *
 * Detection uses byte-level signals on the original on-disk content vs.
 * the post-normalisation canonical form — both available at fix time
 * (apply mode) and computable in dry-run mode (by serialising the parsed
 * atom without applying the migration).
 *
 * **Fragility contract.** The specific-pattern regexes below are tightly
 * coupled to `serializeAtom`'s current YAML indentation and key shape.
 * If the serializer ever changes (e.g. switches indent width or quoting),
 * these regexes silently stop firing. The generic fallback at the bottom
 * always catches "bytes differ but I can't name why" so we never claim a
 * write was a pure migration when in fact something else also changed.
 * Worst case is a less-precise label, never a missed normalisation.
 *
 * If the serializer or atom shape changes, audit the regexes against the
 * test fixtures in `test/doctor-schema-fix.test.ts` and update them in
 * lockstep — the "comma-joined tags" and "mk:relations appended" tests
 * pin the recognised cases.
 */
function detectNormalizations(originalBytes: Buffer | string, canonicalBytes: string): string[] {
  const orig = typeof originalBytes === 'string' ? originalBytes : originalBytes.toString('utf-8');
  if (orig === canonicalBytes) return [];

  const notes: string[] = [];

  // Matches `scope:\n  tags:\n    - a,b,c` — a single list entry that itself
  // contains commas (i.e. an accidentally comma-joined tag string).
  const commaJoinedScopeTag = /scope:\s*\n(?:\s*[a-z_]+:[^\n]*\n)*\s*tags:\s*\n\s*-\s*[^\n"']*,[^\n]+/;
  if (commaJoinedScopeTag.test(orig)) {
    notes.push('scope.tags comma-joined string split into separate items');
  }

  const origHasTopTags = /^tags:\s/m.test(orig);
  const canonicalHasTopTags = /^tags:\s/m.test(canonicalBytes);
  if (!origHasTopTags && canonicalHasTopTags) {
    notes.push('top-level `tags:` promoted from scope.tags');
  }

  const origHasMkRel = orig.includes('<!-- mk:relations -->');
  const canonicalHasMkRel = canonicalBytes.includes('<!-- mk:relations -->');
  if (!origHasMkRel && canonicalHasMkRel) {
    notes.push('Obsidian relations section appended (<!-- mk:relations -->)');
  }

  if (notes.length === 0) {
    // Bytes differ but no specific pattern recognised — surface generically
    // so the operator knows something normalised even if we can't name it.
    notes.push('frontmatter re-serialised to canonical key order / formatting');
  }
  return notes;
}

function formatNormalization(atomId: string, note: string, dryRun: boolean): string {
  const verb = dryRun ? 'would normalize' : 'normalized';
  return `[normalization] ${verb} ${atomId}: ${note}`;
}

export const schemaCheck: Check = {
  name: 'atom-schema',
  category: 'memory',
  defaultSeverity: 'error',
  run(ctx: DoctorContext): CheckResult {
    // Preserve the existing back-compat issue-string shape: one line per
    // atom, JSON blob of Zod issues. Tests downstream depend on this.
    const probes = probe(ctx.memoryDir);
    const issues: string[] = probes.map(
      (p) => `${p.atomId}: ${JSON.stringify(p.failures.map((f) => f.raw))}`,
    );
    return {
      name: schemaCheck.name,
      category: schemaCheck.category,
      severity: 'error',
      ok: issues.length === 0,
      issues,
    };
  },
  fix(ctx: DoctorContext, _result: CheckResult, opts: FixOpts): FixOutcome {
    const probes = probe(ctx.memoryDir);
    const applied: string[] = [];
    const remaining: string[] = [];
    const errors: string[] = [];

    for (const p of probes) {
      const plan = planAtom(p);

      for (const u of plan.unplanned) {
        remaining.push(formatUnplanned(p, u));
      }

      if (plan.planned.length === 0) continue;

      // Both dry-run and apply paths need the parsed atom + the canonical
      // byte form to detect normalisations. Read once, predict once, then
      // either commit the write or skip it.
      if (!p.atomPath) {
        if (opts.dryRun) {
          for (const m of plan.planned) applied.push(formatPlanned(p, m, true));
          continue;
        }
        errors.push(`${p.atomId}: cannot apply migrations — atom has no on-disk path`);
        for (const m of plan.planned) {
          remaining.push(formatUnplanned(p, { failure: m.failure, reason: 'unknown' }));
        }
        continue;
      }

      let originalBytes: Buffer;
      let atom: Atom;
      try {
        originalBytes = fs.readFileSync(p.atomPath);
        atom = readAtom(p.atomPath);
      } catch (err) {
        if (opts.dryRun) {
          // In dry-run we can still report the migration intent even if the
          // file is unreadable — the operator will see it on the next run.
          for (const m of plan.planned) applied.push(formatPlanned(p, m, true));
          continue;
        }
        errors.push(`${p.atomId}: failed to read atom — ${String(err)}`);
        for (const m of plan.planned) {
          remaining.push(formatUnplanned(p, { failure: m.failure, reason: 'unknown' }));
        }
        continue;
      }

      let nextFm: AtomFrontmatter | null = atom.frontmatter;
      let traversalFailed = false;
      for (const m of plan.planned) {
        const stepped = applyAtPath(nextFm as AtomFrontmatter, m.failure.path, m.to);
        if (stepped === null) {
          errors.push(
            `${p.atomId}: cannot apply migration at path ${joinPath(m.failure.path)} — intermediate segment missing`,
          );
          remaining.push(formatUnplanned(p, { failure: m.failure, reason: 'unknown' }));
          traversalFailed = true;
          break;
        }
        nextFm = stepped;
      }
      if (traversalFailed) continue;
      const migratedAtom: Atom = { ...atom, frontmatter: nextFm as AtomFrontmatter };
      // Detect normalisations by comparing the original bytes against the
      // *pre-migration* canonical form — that isolates serializer-only
      // changes from the enum-migration delta. Atoms that round-trip
      // byte-identically through readAtom + serializeAtom produce no
      // normalisation lines.
      const preMigrationCanonical = serializeAtom(atom);
      const normalizations = detectNormalizations(originalBytes, preMigrationCanonical);

      if (opts.dryRun) {
        for (const m of plan.planned) applied.push(formatPlanned(p, m, true));
        for (const note of normalizations) applied.push(formatNormalization(p.atomId, note, true));
        continue;
      }

      const bakPath = resolveBakPath(p.atomPath);
      try {
        fs.copyFileSync(p.atomPath, bakPath);
      } catch (err) {
        errors.push(`${p.atomId}: failed to write .bak — ${String(err)}`);
        for (const m of plan.planned) {
          remaining.push(formatUnplanned(p, { failure: m.failure, reason: 'unknown' }));
        }
        continue;
      }

      try {
        writeAtom(migratedAtom, p.atomPath);
      } catch (err) {
        errors.push(`${p.atomId}: failed to write migrated atom — ${String(err)}`);
        // Best-effort restore from .bak (we just wrote it).
        try { fs.copyFileSync(bakPath, p.atomPath); } catch { /* best-effort */ }
        for (const m of plan.planned) {
          remaining.push(formatUnplanned(p, { failure: m.failure, reason: 'unknown' }));
        }
        continue;
      }

      for (const m of plan.planned) applied.push(formatPlanned(p, m, false));
      for (const note of normalizations) applied.push(formatNormalization(p.atomId, note, false));
    }

    return errors.length > 0 ? { applied, remaining, errors } : { applied, remaining };
  },
};
