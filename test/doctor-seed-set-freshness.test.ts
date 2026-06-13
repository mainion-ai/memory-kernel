import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  initMemoryDir,
  createAtom,
  listAtoms,
  readAtom,
  writeAtom,
  closeAllIndexes,
  seedLifecycle,
  canonicalLifecycleSlugs,
} from '../src/index.js';
import { seedSetFreshnessCheck, diagnoseSeedSet, seedKey } from '../src/doctor/checks/seed-set-freshness.js';
import type { DoctorContext } from '../src/doctor/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SEED_DIR = path.resolve(__dirname, '../skills/mk-memory-setup/seed-atoms/lifecycle');

let testDir: string;

function ctx(): DoctorContext {
  return { memoryDir: testDir, kernelVersion: '1.33.0', skipCategories: new Set(), env: {} };
}

beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-seed-freshness-'));
  initMemoryDir(testDir);
});

afterEach(() => {
  closeAllIndexes();
  fs.rmSync(testDir, { recursive: true, force: true });
});

describe('diagnoseSeedSet (pure) (#330)', () => {
  const canonical = [
    { slug: 'session-start-procedure', type: 'procedure' },
    { slug: 'diagnostics-procedure', type: 'procedure' },
    { slug: 'session-loop-pitfalls', type: 'constraint' },
  ];
  const fullCounts = () => new Map(canonical.map((e) => [seedKey(e.type, e.slug), 1]));

  it('empty store → info, not a hard failure', () => {
    const r = diagnoseSeedSet(canonical, new Map());
    expect(r.ok).toBe(true);
    expect(r.severity).toBe('info');
  });

  it('exact set → info ok', () => {
    const r = diagnoseSeedSet(canonical, fullCounts());
    expect(r.ok).toBe(true);
    expect(r.severity).toBe('info');
    expect(r.issues[0]).toContain('3/3');
  });

  it('missing slug → error naming it', () => {
    const counts = new Map([
      [seedKey('procedure', 'session-start-procedure'), 1],
      [seedKey('procedure', 'diagnostics-procedure'), 1],
    ]);
    const r = diagnoseSeedSet(canonical, counts);
    expect(r.ok).toBe(false);
    expect(r.severity).toBe('error');
    expect(r.issues.join(' ')).toContain('session-loop-pitfalls');
  });

  it('duplicate slug → error (count-passes-but-wrong case)', () => {
    // 2 stale + others = a count check would pass; the set check must not.
    const counts = fullCounts();
    counts.set(seedKey('procedure', 'session-start-procedure'), 2);
    const r = diagnoseSeedSet(canonical, counts);
    expect(r.ok).toBe(false);
    expect(r.severity).toBe('error');
    expect(r.issues.join(' ')).toContain('duplicate');
  });

  it('extra slug only → info (advisory; session-loop is an unreserved tag, must not flip exit code)', () => {
    const counts = fullCounts();
    counts.set(seedKey('procedure', 'old-removed-procedure'), 1);
    const r = diagnoseSeedSet(canonical, counts);
    expect(r.ok).toBe(true);
    expect(r.severity).toBe('info');
    expect(r.issues.join(' ')).toContain('old-removed-procedure');
  });

  it('off-type same-slug entry is "extra", not a duplicate of the canonical proc (mirrors seeder slug+type identity)', () => {
    const counts = fullCounts();
    // A belief sharing the slug of a canonical procedure — the seeder leaves it
    // in place (it dedups per slug+type), so the checker must not call it a dup.
    counts.set(seedKey('belief', 'diagnostics-procedure'), 1);
    const r = diagnoseSeedSet(canonical, counts);
    expect(r.ok).toBe(true); // not an error
    expect(r.severity).toBe('info');
    expect(r.issues.join(' ')).not.toContain('duplicate');
  });
});

describe('seedSetFreshnessCheck (integration) (#330)', () => {
  it('a freshly-seeded store passes (info, N/N)', () => {
    seedLifecycle({ memoryDir: testDir, seedDir: SEED_DIR, agent_id: 't', session_id: 't' });
    const r = seedSetFreshnessCheck.run(ctx()) as { ok: boolean; severity: string; issues: string[] };
    expect(r.ok).toBe(true);
    expect(r.severity).toBe('info');
    expect(r.issues[0]).toContain(`${canonicalLifecycleSlugs(SEED_DIR).length}/`);
  });

  it('a partial set fails with an error naming the missing slug', () => {
    seedLifecycle({ memoryDir: testDir, seedDir: SEED_DIR, agent_id: 't', session_id: 't' });
    // Remove one canonical slug by marking its atom superseded (no longer active).
    const target = listAtoms(testDir).find(
      (a) => a.frontmatter.status === 'active' && a.frontmatter.id.includes('DIAGNOSTICS-PROCEDURE'),
    );
    expect(target).toBeDefined();
    const atom = readAtom(target!.filePath!);
    atom.frontmatter.status = 'superseded';
    writeAtom(atom, target!.filePath!);

    const r = seedSetFreshnessCheck.run(ctx()) as { ok: boolean; severity: string; issues: string[] };
    expect(r.ok).toBe(false);
    expect(r.severity).toBe('error');
    expect(r.issues.join(' ')).toContain('diagnostics-procedure');
  });

  it('a duplicate active slug fails with an error', () => {
    seedLifecycle({ memoryDir: testDir, seedDir: SEED_DIR, agent_id: 't', session_id: 't' });
    // Inject a second active atom for an existing canonical slug.
    createAtom({
      memoryDir: testDir, type: 'procedure', slug: 'diagnostics-procedure',
      body: 'a stale duplicate', scope: { tags: ['session-loop'] }, status: 'active',
      agent_id: 't', session_id: 't',
    });
    const r = seedSetFreshnessCheck.run(ctx()) as { ok: boolean; severity: string; issues: string[] };
    expect(r.ok).toBe(false);
    expect(r.severity).toBe('error');
    expect(r.issues.join(' ')).toContain('duplicate');
  });

  it('an empty (non-agent) store is not hard-failed', () => {
    const r = seedSetFreshnessCheck.run(ctx()) as { ok: boolean; severity: string };
    expect(r.ok).toBe(true);
    expect(r.severity).toBe('info');
  });

  it('a user-authored session-loop atom is surfaced as info, never a hard fail (review finding #1)', () => {
    seedLifecycle({ memoryDir: testDir, seedDir: SEED_DIR, agent_id: 't', session_id: 't' });
    createAtom({
      memoryDir: testDir, type: 'procedure', slug: 'my-own-custom-loop-step',
      body: 'a procedure the operator tagged for their own loop', scope: { tags: ['session-loop'] },
      status: 'active', agent_id: 't', session_id: 't',
    });
    const r = seedSetFreshnessCheck.run(ctx()) as { ok: boolean; severity: string; issues: string[] };
    expect(r.ok).toBe(true); // extra → info, exit code not flipped
    expect(r.severity).toBe('info');
    expect(r.issues.join(' ')).toContain('my-own-custom-loop-step');
  });

  it('an off-type atom sharing a canonical slug does not false-flag a duplicate (review finding #2)', () => {
    seedLifecycle({ memoryDir: testDir, seedDir: SEED_DIR, agent_id: 't', session_id: 't' });
    // A belief sharing a canonical proc's slug — seedLifecycle (slug+type scoped)
    // leaves it in place, so a clean re-seed must still pass doctor.
    createAtom({
      memoryDir: testDir, type: 'belief', slug: 'diagnostics-procedure',
      body: 'unrelated belief that happens to share a slug', scope: { tags: ['session-loop'] },
      status: 'active', agent_id: 't', session_id: 't',
    });
    const r = seedSetFreshnessCheck.run(ctx()) as { ok: boolean; severity: string; issues: string[] };
    expect(r.ok).toBe(true);
    expect(r.issues.join(' ')).not.toContain('duplicate');
  });
});
