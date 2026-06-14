/**
 * Machine-verifiable Zod schemas for `mk --json` command outputs (#301).
 *
 * Every `--json` output is a contract integrators otherwise learn by trial and
 * error (the `seeds_used` mis-parse is the canonical cost). These schemas make
 * the contracts explicit, exported, and test-enforced (one CLI invocation is
 * validated against each, so the schema can't drift from reality).
 *
 * Derived from the actual CLI output shapes (`src/cli/mk.ts`, `src/cli/eval.ts`).
 * `.passthrough()` + optional fields keep them faithful-but-not-brittle: a new
 * additive field on an output doesn't break the schema, while the documented
 * core contract fields are enforced.
 */
import { z } from 'zod';

/** An atom as it appears in a `--json` ContextBundle (frontmatter + body). */
export const AtomOutputSchema = z
  .object({
    frontmatter: z
      .object({
        id: z.string(),
        type: z.string(),
        status: z.string(),
        confidence: z.number(),
      })
      .passthrough(),
    body: z.string(),
  })
  .passthrough();

/** `mk recall --json` / `mk_context_bundle` — the ContextBundle. */
export const RecallOutputSchema = z
  .object({
    index: z.string(),
    handoff: z.string(),
    constraints: z.string(),
    atoms: z.array(AtomOutputSchema),
    episodes: z.array(z.string()).optional(),
    token_estimate: z.number(),
    recall_status: z.enum(['match', 'no_match', 'fts_unavailable']).optional(),
  })
  .passthrough();
export type RecallOutput = z.infer<typeof RecallOutputSchema>;

/** A single doctor check result (entry of `checks[]`). */
export const DoctorCheckResultSchema = z
  .object({
    name: z.string(),
    category: z.string(),
    severity: z.enum(['error', 'warn', 'info']),
    ok: z.boolean(),
    issues: z.array(z.string()),
    skipped: z.object({ reason: z.string() }).passthrough().optional(),
  })
  .passthrough();

/** `mk doctor --json` (and `--fix`, which adds `fixes[]`). */
export const DoctorOutputSchema = z
  .object({
    healthy: z.boolean(),
    issue_count: z.number(),
    issues: z.array(z.string()),
    checks: z.array(DoctorCheckResultSchema),
    fixes: z
      .array(
        z
          .object({
            name: z.string(),
            applied: z.array(z.string()),
            remaining: z.array(z.string()),
            errors: z.array(z.string()).optional(),
            dry_run: z.boolean(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();
export type DoctorOutput = z.infer<typeof DoctorOutputSchema>;

/** `mk remember --json`. */
export const RememberOutputSchema = z
  .object({
    id: z.string(),
    type: z.string(),
    status: z.string(),
    confidence: z.number(),
    tags: z.array(z.string()),
    embedded: z.boolean(),
    embedding_warning: z.string().nullable(),
    tag_warning: z.string().nullable(),
  })
  .passthrough();
export type RememberOutput = z.infer<typeof RememberOutputSchema>;

/** One scored query within an eval fixture result. */
export const EvalQueryResultSchema = z
  .object({
    task: z.string(),
    cat: z.string().optional(),
    passed: z.boolean(),
    detail: z.string(),
  })
  .passthrough();

/** One fixture's scored result. */
export const EvalResultSchema = z
  .object({
    fixture: z.string(),
    total: z.number(),
    passed: z.number(),
    pass_rate: z.number(),
    threshold: z.number(),
    top_k: z.number(),
    embed_used: z.boolean(),
    ok: z.boolean(),
    results: z.array(EvalQueryResultSchema),
  })
  .passthrough();

/** `mk eval --json`. */
export const EvalOutputSchema = z
  .object({
    fixtures: z.array(EvalResultSchema),
    ok: z.boolean(),
    exit_code: z.number(),
  })
  .passthrough();
export type EvalOutput = z.infer<typeof EvalOutputSchema>;
