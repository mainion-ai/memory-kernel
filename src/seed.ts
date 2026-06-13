/**
 * Lifecycle seed engine (#329).
 *
 * Re-seeding the canonical lifecycle atoms must be IDEMPOTENT: `generateAtomId`
 * always appends a unique counter+nonce, so `mk remember --slug <s>` is not an
 * upsert — blind re-seeding produces duplicates (the v1.32.0 fleet-adoption
 * incident: 8 stale + 11 new = 19 active). This module reconciles a store to
 * the canonical set by matching on the stable SLUG segment of each atom id
 * (present on legacy atoms too — no new frontmatter field) and superseding
 * stale/duplicate atoms in place.
 *
 * The canonical set is described by `lifecycle/manifest.json` — the single
 * source of truth shared by `mk seed`, `seed-lifecycle.sh`, and the doctor
 * seed-set-freshness check (#330).
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createAtom } from './retain.js';
import { listAtoms } from './store.js';
import { supersedeAtoms } from './cli/supersede.js';
import type { Atom, AtomType } from './types.js';

/** One canonical seed atom: a body file, its type, stable slug, and tags. */
export interface LifecycleSeedEntry {
  file: string;
  type: AtomType;
  slug: string;
  tags: string[];
}

interface LifecycleManifest {
  version: number;
  description?: string;
  atoms: LifecycleSeedEntry[];
}

export type SeedAction = 'created' | 'updated' | 'unchanged' | 'deduped';

export interface SeedSlugResult {
  slug: string;
  type: AtomType;
  action: SeedAction;
  /** id of the active canonical atom after reconciliation (null in dry-run create). */
  active_id: string | null;
  /** ids superseded by this reconciliation (stale dupes / replaced versions). */
  superseded_ids: string[];
}

export interface SeedResult {
  dry_run: boolean;
  seed_dir: string;
  results: SeedSlugResult[];
  created: number;
  updated: number;
  unchanged: number;
  deduped: number;
  superseded: number;
}

/**
 * Resolve the shipped `lifecycle/` seed directory relative to this module.
 * In dev the module runs from `src/`, in a published install from `dist/` —
 * both are siblings under the package root, so a single `..` reaches the root
 * in either case. Tests override this with an explicit `seedDir`.
 */
export function resolveSeedDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.join(here, '..', 'skills', 'mk-memory-setup', 'seed-atoms', 'lifecycle');
}

/** Load and lightly validate the lifecycle manifest from a seed directory. */
export function loadLifecycleManifest(seedDir: string): LifecycleSeedEntry[] {
  const manifestPath = path.join(seedDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Lifecycle manifest not found: ${manifestPath}`);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as LifecycleManifest;
  if (!manifest || !Array.isArray(manifest.atoms) || manifest.atoms.length === 0) {
    throw new Error(`Lifecycle manifest is empty or malformed: ${manifestPath}`);
  }
  for (const e of manifest.atoms) {
    if (!e.file || !e.type || !e.slug || !Array.isArray(e.tags)) {
      throw new Error(`Malformed manifest entry: ${JSON.stringify(e)}`);
    }
  }
  return manifest.atoms;
}

/** The canonical set of lifecycle slugs (normalized) shipped with this version. */
export function canonicalLifecycleSlugs(seedDir = resolveSeedDir()): string[] {
  return loadLifecycleManifest(seedDir).map((e) => normalizeSlug(e.slug));
}

/**
 * The canonical lifecycle set as `{slug, type}` pairs (normalized slug). This is
 * the precise identity the seeder reconciles on — `seedLifecycle` matches and
 * dedups per (slug, type), so the doctor seed-set-freshness check (#330) must
 * compare on the same key, not slug alone.
 */
export function canonicalLifecycleSet(seedDir = resolveSeedDir()): Array<{ slug: string; type: AtomType }> {
  return loadLifecycleManifest(seedDir).map((e) => ({ slug: normalizeSlug(e.slug), type: e.type }));
}

/**
 * Normalize a slug the same way `generateAtomId` cleans it (so a manifest slug
 * compares equal to the slug segment extracted from an id it produced).
 */
export function normalizeSlug(slug: string): string {
  return slug
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40)
    .toLowerCase();
}

/**
 * Extract the stable slug segment from an atom id of the form
 * `TYPE-YYYY-MM-DD-SLUG-<counter>`. Returns the lowercased slug, or null when
 * the id is too short or carries no slug (e.g. `TYPE-YYYY-MM-DD-<counter>`).
 */
export function extractIdSlug(id: string): string | null {
  const parts = id.split('-');
  // TYPE(1) + YYYY(1) MM(1) DD(1) + slug(>=1) + counter(1) => at least 6 parts.
  if (parts.length < 6) return null;
  const slugParts = parts.slice(4, -1);
  if (slugParts.length === 0) return null;
  return slugParts.join('-').toLowerCase();
}

/** True when an existing atom already matches the canonical content for an entry. */
function contentMatches(atom: Atom, entry: LifecycleSeedEntry, body: string): boolean {
  if (atom.frontmatter.type !== entry.type) return false;
  if ((atom.body ?? '').trim() !== body.trim()) return false;
  const have = new Set(atom.frontmatter.scope?.tags ?? []);
  return entry.tags.length === have.size && entry.tags.every((t) => have.has(t));
}

export interface SeedLifecycleOptions {
  memoryDir: string;
  seedDir?: string;
  dryRun?: boolean;
  agent_id?: string;
  session_id?: string;
}

/**
 * Reconcile a store to the canonical lifecycle set. Idempotent: running twice
 * leaves exactly one active atom per canonical slug with no duplicates.
 */
export function seedLifecycle(opts: SeedLifecycleOptions): SeedResult {
  const seedDir = opts.seedDir ?? resolveSeedDir();
  const agentId = opts.agent_id ?? 'cli';
  const sessionId = opts.session_id ?? 'mk-seed';
  const dryRun = opts.dryRun ?? false;
  const entries = loadLifecycleManifest(seedDir);

  // Active atoms grouped by their (normalized) slug segment.
  const activeBySlug = new Map<string, Atom[]>();
  for (const atom of listAtoms(opts.memoryDir)) {
    if (atom.frontmatter.status !== 'active') continue;
    const slug = extractIdSlug(atom.frontmatter.id);
    if (!slug) continue;
    const list = activeBySlug.get(slug) ?? [];
    list.push(atom);
    activeBySlug.set(slug, list);
  }

  const results: SeedSlugResult[] = [];

  for (const entry of entries) {
    const bodyPath = path.join(seedDir, entry.file);
    if (!fs.existsSync(bodyPath)) {
      throw new Error(`Missing seed body file: ${bodyPath}`);
    }
    const body = fs.readFileSync(bodyPath, 'utf-8');
    const norm = normalizeSlug(entry.slug);
    // Scope to the entry's type: a slug segment alone is not enough to claim an
    // atom as "this canonical seed" — an unrelated user atom of a different type
    // that happens to share the slug must never be superseded by re-seeding.
    const matches = (activeBySlug.get(norm) ?? []).filter((m) => m.frontmatter.type === entry.type);

    // Identical existing atom we can keep as the survivor (no rewrite needed).
    const identical = matches.find((m) => contentMatches(m, entry, body));

    if (matches.length === 0) {
      // Create.
      if (dryRun) {
        results.push({ slug: norm, type: entry.type, action: 'created', active_id: null, superseded_ids: [] });
        continue;
      }
      const atom = createAtom({
        memoryDir: opts.memoryDir,
        type: entry.type,
        slug: entry.slug,
        body,
        scope: { tags: entry.tags },
        // Seeds are canonical operating-manual atoms — always active, never a
        // draft awaiting promotion. Without this a belief/open_question seed
        // would land as 'draft', never re-match (we only scan active atoms),
        // and duplicate on every run (the exact incident this prevents).
        status: 'active',
        agent_id: agentId,
        session_id: sessionId,
      });
      results.push({ slug: norm, type: entry.type, action: 'created', active_id: atom.frontmatter.id, superseded_ids: [] });
      continue;
    }

    if (identical && matches.length === 1) {
      // No-op.
      results.push({ slug: norm, type: entry.type, action: 'unchanged', active_id: identical.frontmatter.id, superseded_ids: [] });
      continue;
    }

    // Either content drifted, or there are duplicates. Pick a survivor and
    // supersede every other active match onto it.
    if (identical) {
      // Dedup onto the already-correct survivor.
      const survivor = identical;
      const stale = matches.filter((m) => m.frontmatter.id !== survivor.frontmatter.id);
      if (dryRun) {
        results.push({ slug: norm, type: entry.type, action: 'deduped', active_id: survivor.frontmatter.id, superseded_ids: stale.map((m) => m.frontmatter.id) });
        continue;
      }
      for (const m of stale) {
        supersedeAtoms({ memoryDir: opts.memoryDir, oldAtomId: m.frontmatter.id, newAtomId: survivor.frontmatter.id, agent_id: agentId, session_id: sessionId });
      }
      results.push({ slug: norm, type: entry.type, action: 'deduped', active_id: survivor.frontmatter.id, superseded_ids: stale.map((m) => m.frontmatter.id) });
      continue;
    }

    // Content drifted: create the canonical atom, supersede all stale matches.
    const action: SeedAction = matches.length > 1 ? 'deduped' : 'updated';
    if (dryRun) {
      results.push({ slug: norm, type: entry.type, action, active_id: null, superseded_ids: matches.map((m) => m.frontmatter.id) });
      continue;
    }
    const fresh = createAtom({
      memoryDir: opts.memoryDir,
      type: entry.type,
      slug: entry.slug,
      body,
      scope: { tags: entry.tags },
      agent_id: agentId,
      session_id: sessionId,
    });
    for (const m of matches) {
      supersedeAtoms({ memoryDir: opts.memoryDir, oldAtomId: m.frontmatter.id, newAtomId: fresh.frontmatter.id, agent_id: agentId, session_id: sessionId });
    }
    results.push({ slug: norm, type: entry.type, action, active_id: fresh.frontmatter.id, superseded_ids: matches.map((m) => m.frontmatter.id) });
  }

  const tally = (a: SeedAction) => results.filter((r) => r.action === a).length;
  return {
    dry_run: dryRun,
    seed_dir: seedDir,
    results,
    created: tally('created'),
    updated: tally('updated'),
    unchanged: tally('unchanged'),
    deduped: tally('deduped'),
    superseded: results.reduce((n, r) => n + r.superseded_ids.length, 0),
  };
}
