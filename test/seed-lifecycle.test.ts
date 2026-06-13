import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  initMemoryDir,
  createAtom,
  listAtoms,
  closeAllIndexes,
  seedLifecycle,
  loadLifecycleManifest,
  canonicalLifecycleSlugs,
  extractIdSlug,
  normalizeSlug,
} from '../src/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const SEED_DIR = path.join(REPO_ROOT, 'skills/mk-memory-setup/seed-atoms/lifecycle');

let testDir: string;

/** Count active atoms carrying the session-loop tag, grouped by canonical slug. */
function activeLifecycleBySlug(dir: string): Map<string, string[]> {
  const m = new Map<string, string[]>();
  for (const a of listAtoms(dir)) {
    if (a.frontmatter.status !== 'active') continue;
    if (!a.frontmatter.scope?.tags?.includes('session-loop')) continue;
    const slug = extractIdSlug(a.frontmatter.id);
    if (!slug) continue;
    const list = m.get(slug) ?? [];
    list.push(a.frontmatter.id);
    m.set(slug, list);
  }
  return m;
}

beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-seed-lifecycle-'));
  initMemoryDir(testDir);
});

afterEach(() => {
  closeAllIndexes();
  fs.rmSync(testDir, { recursive: true, force: true });
});

describe('extractIdSlug / normalizeSlug (#329)', () => {
  it('extracts the stable slug segment from a generated id', () => {
    expect(extractIdSlug('PROC-2026-06-13-SESSION-START-PROCEDURE-1abcd')).toBe('session-start-procedure');
    expect(extractIdSlug('CONS-2026-01-02-SESSION-LOOP-PITFALLS-9zzzz')).toBe('session-loop-pitfalls');
  });

  it('returns null for ids with no slug or too few segments', () => {
    expect(extractIdSlug('PROC-2026-06-13-1abcd')).toBeNull(); // no slug segment
    expect(extractIdSlug('not-an-id')).toBeNull();
  });

  it('round-trips: extractIdSlug(generated) === normalizeSlug(input)', () => {
    const atom = createAtom({
      memoryDir: testDir,
      type: 'procedure',
      slug: 'My Fancy Slug!',
      body: 'x',
      agent_id: 't',
      session_id: 't',
    });
    expect(extractIdSlug(atom.frontmatter.id)).toBe(normalizeSlug('My Fancy Slug!'));
  });
});

describe('lifecycle manifest (#329)', () => {
  it('loads and exactly mirrors the lifecycle/*.md body files', () => {
    const entries = loadLifecycleManifest(SEED_DIR);
    expect(entries.length).toBeGreaterThanOrEqual(11);

    // Every manifest body file exists.
    for (const e of entries) {
      expect(fs.existsSync(path.join(SEED_DIR, e.file)), `missing body: ${e.file}`).toBe(true);
    }

    // Every lifecycle/*.md (except README) is named in the manifest — no orphan seeds.
    const onDisk = fs.readdirSync(SEED_DIR).filter((f) => f.endsWith('.md') && f !== 'README.md');
    const named = new Set(entries.map((e) => e.file));
    for (const f of onDisk) {
      expect(named.has(f), `body not in manifest: ${f}`).toBe(true);
    }
    expect(named.size).toBe(onDisk.length);
  });

  it('canonicalLifecycleSlugs returns the normalized slug set', () => {
    const slugs = canonicalLifecycleSlugs(SEED_DIR);
    expect(slugs).toContain('session-start-procedure');
    expect(slugs).toContain('session-loop-pitfalls');
    expect(new Set(slugs).size).toBe(slugs.length); // no dupes in the canonical set
  });
});

describe('seedLifecycle idempotency (#329)', () => {
  it('seeds the canonical set on a fresh store with no duplicates', () => {
    const res = seedLifecycle({ memoryDir: testDir, seedDir: SEED_DIR, agent_id: 't', session_id: 't' });
    const expected = loadLifecycleManifest(SEED_DIR).length;
    expect(res.created).toBe(expected);
    expect(res.updated + res.deduped + res.unchanged).toBe(0);

    const bySlug = activeLifecycleBySlug(testDir);
    expect(bySlug.size).toBe(expected);
    for (const [, ids] of bySlug) expect(ids.length).toBe(1); // exactly one active per slug
  });

  it('re-seeding is a no-op: second run reports all unchanged, still no duplicates', () => {
    seedLifecycle({ memoryDir: testDir, seedDir: SEED_DIR, agent_id: 't', session_id: 't' });
    const res2 = seedLifecycle({ memoryDir: testDir, seedDir: SEED_DIR, agent_id: 't', session_id: 't' });
    const expected = loadLifecycleManifest(SEED_DIR).length;

    expect(res2.unchanged).toBe(expected);
    expect(res2.created + res2.updated + res2.deduped).toBe(0);

    const bySlug = activeLifecycleBySlug(testDir);
    expect(bySlug.size).toBe(expected);
    for (const [, ids] of bySlug) expect(ids.length).toBe(1);
  });

  it('dedups pre-existing stale duplicates of a canonical slug to one active', () => {
    // Simulate the v1.32.0 incident: two divergent atoms share a canonical slug.
    createAtom({ memoryDir: testDir, type: 'procedure', slug: 'session-start-procedure', body: 'STALE A', scope: { tags: ['session-loop'] }, agent_id: 't', session_id: 't' });
    createAtom({ memoryDir: testDir, type: 'procedure', slug: 'session-start-procedure', body: 'STALE B', scope: { tags: ['session-loop'] }, agent_id: 't', session_id: 't' });
    expect(activeLifecycleBySlug(testDir).get('session-start-procedure')?.length).toBe(2);

    const res = seedLifecycle({ memoryDir: testDir, seedDir: SEED_DIR, agent_id: 't', session_id: 't' });
    const startResult = res.results.find((r) => r.slug === 'session-start-procedure');
    expect(startResult?.action).toBe('deduped');
    expect(startResult?.superseded_ids.length).toBe(2);

    const ids = activeLifecycleBySlug(testDir).get('session-start-procedure');
    expect(ids?.length).toBe(1); // exactly one active survivor
  });

  it('supersedes + recreates a single drifted atom (action=updated), leaving one active', () => {
    createAtom({ memoryDir: testDir, type: 'procedure', slug: 'diagnostics-procedure', body: 'OLD DIAGNOSTICS BODY', scope: { tags: ['session-loop', 'lifecycle', 'agent-setup'] }, agent_id: 't', session_id: 't' });

    const res = seedLifecycle({ memoryDir: testDir, seedDir: SEED_DIR, agent_id: 't', session_id: 't' });
    const diag = res.results.find((r) => r.slug === 'diagnostics-procedure');
    expect(diag?.action).toBe('updated');
    expect(diag?.superseded_ids.length).toBe(1);

    expect(activeLifecycleBySlug(testDir).get('diagnostics-procedure')?.length).toBe(1);
  });

  it('seeds a draft-default type (belief) as active so it stays idempotent (#329 review)', () => {
    // Custom manifest whose only entry is a belief — createAtom would normally
    // stamp this 'draft', which would never re-match and duplicate every run.
    const customSeed = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-seed-belief-'));
    fs.writeFileSync(path.join(customSeed, 'belief.md'), 'A canonical belief seed body.');
    fs.writeFileSync(
      path.join(customSeed, 'manifest.json'),
      JSON.stringify({ version: 1, atoms: [{ file: 'belief.md', type: 'belief', slug: 'canonical-belief-seed', tags: ['session-loop'] }] }),
    );

    const r1 = seedLifecycle({ memoryDir: testDir, seedDir: customSeed, agent_id: 't', session_id: 't' });
    expect(r1.created).toBe(1);
    const active = listAtoms(testDir).filter((a) => a.frontmatter.status === 'active' && extractIdSlug(a.frontmatter.id) === 'canonical-belief-seed');
    expect(active.length).toBe(1); // created active, not draft

    const r2 = seedLifecycle({ memoryDir: testDir, seedDir: customSeed, agent_id: 't', session_id: 't' });
    expect(r2.unchanged).toBe(1); // re-matched → no-op, not a duplicate
    expect(r2.created).toBe(0);

    fs.rmSync(customSeed, { recursive: true, force: true });
  });

  it('--dry-run writes nothing', () => {
    const before = listAtoms(testDir).length;
    const res = seedLifecycle({ memoryDir: testDir, seedDir: SEED_DIR, dryRun: true, agent_id: 't', session_id: 't' });
    expect(res.dry_run).toBe(true);
    expect(res.created).toBeGreaterThan(0);
    expect(listAtoms(testDir).length).toBe(before); // no atoms actually written
  });
});

describe('seed-atoms ship in the package (#329 B2)', () => {
  it('package.json files includes the seed-atoms dir and the canonical assets exist', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf-8'));
    expect(pkg.files).toContain('skills/mk-memory-setup/seed-atoms');

    const base = path.join(REPO_ROOT, 'skills/mk-memory-setup/seed-atoms');
    expect(fs.existsSync(path.join(base, 'seed-lifecycle.sh'))).toBe(true);
    expect(fs.existsSync(path.join(base, 'lifecycle/manifest.json'))).toBe(true);
    expect(fs.existsSync(path.join(base, 'lifecycle/01-session-start.md'))).toBe(true);
  });
});
