/**
 * `mk eval` — golden-query recall eval (#300).
 *
 * Promotes the host-side `mk-golden-eval.py` runner to a first-class, typed
 * engine with pass/fail semantics so it can gate CI and serve as a post-sync
 * canary. Pure engine — no process.exit, no console (the CLI layer owns those).
 *
 * A fixture is a YAML file of queries; each query either recalls atoms and
 * checks an expected atom surfaces in the top-K, or (for KNOWLEDGE docs, which
 * aren't atoms) greps the KNOWLEDGE/ dir for expected content. Score is the
 * fraction of passing queries; a fixture passes when score >= threshold.
 */

import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { recall, recallWithEmbeddings } from './recall.js';
import { getEmbeddingConfig } from './embeddings.js';
import { indexStats } from './index-db.js';

/** Thrown on malformed fixtures / unreadable inputs — the CLI maps this to exit 2. */
export class EvalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EvalError';
  }
}

export interface EvalQuery {
  /** The recall task string. `q` is accepted as a back-compat alias. */
  task?: string;
  q?: string;
  /** Expected atom IDs — pass if any surfaces in the top-K (suffix-drift tolerant). */
  expect?: string[];
  /** For KNOWLEDGE docs (not atoms): substring to grep in KNOWLEDGE/**. */
  expect_content?: string;
  /** Optional category label for grouped output. */
  cat?: string;
}

export interface EvalFixture {
  /** Display name (defaults to the file basename). */
  name: string;
  queries: EvalQuery[];
  /** Pass when pass_rate >= threshold (0..1). CLI --threshold overrides; default 1.0. */
  threshold?: number;
  /** Top-K cutoff for the recall match. CLI --top-k overrides; default 5. */
  top_k?: number;
}

export interface EvalQueryResult {
  task: string;
  cat?: string;
  passed: boolean;
  detail: string;
}

export interface EvalResult {
  fixture: string;
  total: number;
  passed: number;
  pass_rate: number;
  threshold: number;
  top_k: number;
  embed_used: boolean;
  ok: boolean;
  results: EvalQueryResult[];
}

export type EmbedMode = 'auto' | 'on' | 'off';

export interface RunEvalOptions {
  /** Top-K cutoff (overrides fixture.top_k). */
  topK?: number;
  /** Pass-rate threshold 0..1 (overrides fixture.threshold). */
  threshold?: number;
  /** Embedding mode: auto (key+vectors), on (force), off (FTS-only). Default auto. */
  embed?: EmbedMode;
}

export const DEFAULT_TOP_K = 5;
export const DEFAULT_THRESHOLD = 1.0;

// --- Fixture loading -------------------------------------------------------

/**
 * Load fixtures from a YAML file, or every `*.yaml`/`*.yml` in a directory.
 * Throws {@link EvalError} on a missing path or malformed fixture.
 */
export function loadFixtures(fixturePath: string): EvalFixture[] {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(fixturePath);
  } catch {
    throw new EvalError(`fixture path not found: ${fixturePath}`);
  }

  const files: string[] = stat.isDirectory()
    ? fs.readdirSync(fixturePath)
        .filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))
        .sort()
        .map((f) => path.join(fixturePath, f))
    : [fixturePath];

  if (files.length === 0) {
    throw new EvalError(`no .yaml fixtures found in ${fixturePath}`);
  }

  return files.map((file) => parseFixture(file));
}

function parseFixture(file: string): EvalFixture {
  let raw: unknown;
  try {
    raw = yaml.load(fs.readFileSync(file, 'utf-8'));
  } catch (err) {
    throw new EvalError(`malformed YAML in ${file}: ${String(err)}`);
  }
  if (!raw || typeof raw !== 'object') {
    throw new EvalError(`fixture ${file} is not a YAML mapping`);
  }
  const obj = raw as Record<string, unknown>;
  const queries = obj.queries;
  if (!Array.isArray(queries) || queries.length === 0) {
    throw new EvalError(`fixture ${file} must have a non-empty 'queries' list`);
  }
  for (const q of queries as EvalQuery[]) {
    const task = q.task ?? q.q;
    if (!task && !q.expect_content) {
      throw new EvalError(`fixture ${file}: every query needs a 'task' (and 'expect') or an 'expect_content'`);
    }
    if (!q.expect_content) {
      if (!Array.isArray(q.expect) || q.expect.length === 0) {
        throw new EvalError(`fixture ${file}: query "${task}" needs a non-empty 'expect' list (or use 'expect_content')`);
      }
      if (q.expect.some((e) => typeof e !== 'string' || e.trim() === '')) {
        throw new EvalError(`fixture ${file}: query "${task}" has an empty/blank 'expect' entry (would match any atom)`);
      }
    }
  }
  const threshold = typeof obj.threshold === 'number' ? obj.threshold : undefined;
  const topK = typeof obj.top_k === 'number' ? obj.top_k : undefined;
  return {
    name: path.basename(file).replace(/\.(ya?ml)$/, ''),
    queries: queries as EvalQuery[],
    threshold,
    top_k: topK,
  };
}

// --- Embed-mode resolution -------------------------------------------------

/**
 * Resolve whether to use the embedding recall path. `auto` (default) engages
 * embeddings only when a provider key is configured AND the store has vectors
 * — so CI / keyless runs are deterministically FTS-only.
 */
export function resolveEmbed(memoryDir: string, mode: EmbedMode = 'auto'): boolean {
  if (mode === 'off') return false;
  if (mode === 'on') return true;
  const hasKey = getEmbeddingConfig() !== null;
  const vectors = indexStats(memoryDir)?.embeddings ?? 0;
  return hasKey && vectors > 0;
}

// --- Scoring ---------------------------------------------------------------

/**
 * Hyphen-boundary id match — tolerant to atom-id *suffix* drift (stored
 * `FACT-…-SLUG-1a2b3` vs expected `FACT-…-SLUG`) but NOT to degenerate
 * prefixes: `id` matches `e` only if they're equal or one is the other plus a
 * `-<suffix>`. This kills the old substring footgun where `expect: ["FACT-"]`
 * matched every fact (#300 review). Empty tokens never match.
 */
function idMatch(id: string, e: string): boolean {
  if (!id || !e) return false;
  return id === e || id.startsWith(`${e}-`) || e.startsWith(`${id}-`);
}

function matchesExpected(topIds: string[], expect: string[]): boolean {
  return expect.some((e) => topIds.some((id) => idMatch(id, e)));
}

/** Grep KNOWLEDGE/**.md for a substring (content or filename) — docs aren't atoms. */
function knowledgeGrep(memoryDir: string, match: string): string | null {
  const root = path.join(memoryDir, 'KNOWLEDGE');
  const needle = match.toLowerCase();
  const walk = (dir: string): string | null => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        const hit = walk(full);
        if (hit) return hit;
      } else if (e.name.endsWith('.md')) {
        if (full.toLowerCase().includes(needle)) return full;
        try {
          if (fs.readFileSync(full, 'utf-8').toLowerCase().includes(needle)) return full;
        } catch { /* unreadable — skip */ }
      }
    }
    return null;
  };
  return walk(root);
}

async function recallTopIds(
  memoryDir: string,
  task: string,
  topK: number,
  embed: boolean,
): Promise<{ ids: string[]; status: string }> {
  // Large budget so the token cap never truncates ranked atoms before the
  // top-K slice — recall subtracts the INDEX/HANDOFF/CONSTRAINTS view tokens
  // from max_tokens first, which on a real store could squeeze the expected
  // atom out of a small budget and cause a store-state-dependent false FAIL
  // (#300 review). We only need ranking here, not a context-window fit.
  const query = { task, max_tokens: 1_000_000 };
  const bundle = embed
    ? await recallWithEmbeddings(memoryDir, query)
    : recall(memoryDir, query);
  const ids = (bundle.atoms ?? []).slice(0, topK).map((a) => a.frontmatter?.id ?? '');
  return { ids, status: bundle.recall_status ?? 'ok' };
}

/**
 * Run one fixture against a store. Pure: returns the scored {@link EvalResult},
 * never exits or prints.
 */
export async function runFixture(
  memoryDir: string,
  fixture: EvalFixture,
  opts: RunEvalOptions = {},
): Promise<EvalResult> {
  const topK = opts.topK ?? fixture.top_k ?? DEFAULT_TOP_K;
  const threshold = opts.threshold ?? fixture.threshold ?? DEFAULT_THRESHOLD;
  // `callEmbed` decides which recall fn to call; `embedUsed` is what we report —
  // honest even under mode 'on', since recallWithEmbeddings silently falls back
  // to FTS when no key is configured (#300 review).
  const callEmbed = resolveEmbed(memoryDir, opts.embed ?? 'auto');
  const embedUsed = callEmbed && getEmbeddingConfig() !== null;

  const results: EvalQueryResult[] = [];
  for (const q of fixture.queries) {
    const task = q.task ?? q.q ?? '';
    if (q.expect_content) {
      const hit = knowledgeGrep(memoryDir, q.expect_content);
      results.push({
        task: task || `KNOWLEDGE:${q.expect_content}`,
        cat: q.cat,
        passed: hit !== null,
        detail: `KNOWLEDGE grep '${q.expect_content}' → ${hit ? path.basename(hit) : 'MISS'}`,
      });
      continue;
    }
    const { ids, status } = await recallTopIds(memoryDir, task, topK, callEmbed);
    const passed = matchesExpected(ids, q.expect ?? []);
    results.push({
      task,
      cat: q.cat,
      passed,
      detail: `[${status}] top-${topK}: ${ids.slice(0, 3).map((i) => i.slice(0, 42)).join(', ')}`,
    });
  }

  const passed = results.filter((r) => r.passed).length;
  const total = results.length;
  const pass_rate = total > 0 ? passed / total : 0;
  return {
    fixture: fixture.name,
    total,
    passed,
    pass_rate,
    threshold,
    top_k: topK,
    embed_used: embedUsed,
    ok: pass_rate >= threshold,
    results,
  };
}

/** Run every fixture. Returns one {@link EvalResult} per fixture. */
export async function runEval(
  memoryDir: string,
  fixtures: EvalFixture[],
  opts: RunEvalOptions = {},
): Promise<EvalResult[]> {
  const out: EvalResult[] = [];
  for (const f of fixtures) out.push(await runFixture(memoryDir, f, opts));
  return out;
}

/** Exit code from results: 0 = all fixtures pass, 1 = one or more below threshold. */
export function exitCodeForEval(results: EvalResult[]): 0 | 1 {
  return results.every((r) => r.ok) ? 0 : 1;
}
