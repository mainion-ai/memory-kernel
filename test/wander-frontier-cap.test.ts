/**
 * tagDistance BFS frontier cap (#102) — performance cliff regression.
 *
 * tagDistance() in src/wander.ts does an unbounded BFS through the tag
 * co-occurrence graph. A single hub tag shared by thousands of atoms can pull
 * all of them into the frontier in one step, causing O(N^2) blowup. This
 * suite verifies the 500-node frontier cap, the one-shot stderr warning,
 * and that small graphs are unaffected.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

import {
  initMemoryDir,
  createAtom,
  reindex,
  closeAllIndexes,
} from '../src/index.js';
import { wander } from '../src/wander.js';

let testDir: string;
let stderrSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-wander-frontier-cap-'));
  initMemoryDir(testDir);
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  stderrSpy.mockRestore();
  closeAllIndexes();
  fs.rmSync(testDir, { recursive: true, force: true });
});

const base = (dir: string) => ({
  memoryDir: dir,
  agent_id: 'test',
  session_id: 'test-session',
});

/**
 * Bulk-create N hub atoms by writing atom files directly + a single reindex,
 * instead of N `createAtom()` calls (each does a file write + event append +
 * incremental index). The BFS cap needs a >500-atom hub; building that via
 * createAtom made setup slow enough to time out under parallel-worker I/O
 * contention — the #319 flake (it always passed in isolation). Direct writes
 * keep setup well under a second. Returns the created ids.
 */
function bulkHubAtoms(dir: string, n: number, slugPrefix: string, tags: string[]): string[] {
  const entities = path.join(dir, 'ENTITIES');
  const ts = '2026-06-13T00:00:00Z';
  const tagBlock = tags.map((t) => `  - ${t}`).join('\n');
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const id = `FACT-2026-06-13-${slugPrefix.toUpperCase()}-${i}`;
    fs.writeFileSync(
      path.join(entities, `${id}.md`),
      `---\nid: ${id}\ntype: fact\nstatus: active\nconfidence: 0.8\n` +
        `created_at: "${ts}"\nupdated_at: "${ts}"\nttl_days: null\n` +
        `tags:\n${tagBlock}\nscope:\n  tags:\n${tagBlock}\nclassification: TEAM\n---\n\nHub atom ${i}.\n`,
    );
    ids.push(id);
  }
  return ids;
}

/** Count stderr writes whose payload string contains the marker. */
function countWarnings(spy: ReturnType<typeof vi.spyOn>, marker: string): number {
  let count = 0;
  for (const call of spy.mock.calls) {
    const arg = call[0];
    if (typeof arg === 'string' && arg.includes(marker)) count++;
  }
  return count;
}

const BFS_CAP_MARKER = 'BFS frontier capped at 500 nodes';

describe('tagDistance — BFS frontier cap (#102)', () => {
  it(
    '600-atom hub graph: bounded time + stderr warning + sensible result',
    // Hub built via bulkHubAtoms (direct writes + one reindex) so setup is sub-second
    // even under parallel-worker contention (#319). The elapsedMs < 1000 assertion below
    // still pins `tagDistance` performance. 15s is ample headroom.
    { timeout: 15000 },
    () => {
      // 600 atoms all share the same hub-tag. They form a fully-connected
      // BFS layer of 600 — without a cap, expanding the frontier through
      // hub-tag pulls all 600 in at once.
      const hubIds = bulkHubAtoms(testDir, 600, 'hub', ['hub-tag']);

      // One outlier with totally disjoint tags — high dissimilarity ensures
      // collision detection will invoke tagDistance(hub-atom, outlier).
      // No bridge atom: BFS from a hub atom can never reach the outlier,
      // so tagDistance fully explores the hub-tag fanout before bailing —
      // and the cap fires at 500.
      const outlier = createAtom({
        ...base(testDir),
        type: 'belief',
        slug: 'outlier',
        body: 'Outlier with no shared tags.',
        scope: { tags: ['outer-tag', 'beacon-tag'] },
      });

      reindex(testDir);

      // Seed both a hub atom and the outlier so collision detection is
      // guaranteed to pair them across the activated top-K.
      const t0 = Date.now();
      const result = wander({
        memoryDir: testDir,
        seeds: [hubIds[0], outlier.frontmatter.id],
        steps: 2,
        topK: 20,
        threshold: 0.001,
        maxCollisions: 5,
      });
      const elapsedMs = Date.now() - t0;

      // Bounded time: pre-fix this scenario can take seconds; post-fix < 200ms
      // is typical, with 1000ms margin for CI variance.
      expect(elapsedMs).toBeLessThan(1000);

      // Warning fires when the BFS expansion is capped.
      expect(countWarnings(stderrSpy, BFS_CAP_MARKER)).toBeGreaterThanOrEqual(1);

      // Result is still well-formed.
      expect(result.activated.length).toBeGreaterThan(0);
      expect(Array.isArray(result.collisions)).toBe(true);
    },
  );

  it(
    'small graph (<500 atoms): no warning, no spam, identical pre-cap behavior',
    { timeout: 15000 },
    () => {
      // Mixed-tag graph well under the 500-frontier cap.
      const DOMAINS = ['philosophy', 'accounting', 'music', 'design'];
      const SUBTAGS = ['notation', 'tier-1', 'tier-2', 'corrections'];
      for (let i = 0; i < 50; i++) {
        createAtom({
          ...base(testDir),
          type: 'fact',
          slug: `small-${i}`,
          body: `Small graph atom ${i}`,
          scope: {
            tags: [DOMAINS[i % DOMAINS.length], SUBTAGS[i % SUBTAGS.length]],
          },
        });
      }
      reindex(testDir);

      const result = wander({
        memoryDir: testDir,
        steps: 3,
        topK: 15,
        threshold: 0.01,
        maxCollisions: 10,
      });

      // No BFS frontier warning should ever fire on a small graph.
      expect(countWarnings(stderrSpy, BFS_CAP_MARKER)).toBe(0);

      // Result is sane.
      expect(result.activated.length).toBeGreaterThan(0);
      expect(Array.isArray(result.collisions)).toBe(true);

      // Distance values are bounded by the BFS maxDepth (4) + 1 sentinel.
      for (const c of result.collisions) {
        expect(c.distance).toBeGreaterThanOrEqual(1);
        expect(c.distance).toBeLessThanOrEqual(5);
      }
    },
  );

  it(
    'warning fires at most once per tagDistance call (no per-step spam)',
    // Hub built via bulkHubAtoms (direct writes + one reindex), so setup stays
    // sub-second under parallel-worker contention (#319). 15s is ample for a
    // normal run; raised to 30s so the 1200-atom hub build + reindex + wander
    // also clears the bar under v8 coverage instrumentation (`test:coverage`,
    // #390), which adds significant per-call overhead.
    { timeout: 30000 },
    () => {
      // Build a hub of 1200 atoms so multiple BFS steps would each exceed
      // the cap if the warning were per-step rather than per-call. We
      // assert: total stderr writes is bounded (one per tagDistance call
      // that hit the cap), not multiplied by depth.
      const hubIds = bulkHubAtoms(testDir, 1200, 'mega', ['hub-tag']);
      const outlier = createAtom({
        ...base(testDir),
        type: 'belief',
        slug: 'outlier-2',
        body: 'Outlier 2.',
        scope: { tags: ['outer-tag', 'beacon-tag'] },
      });
      reindex(testDir);

      const result = wander({
        memoryDir: testDir,
        seeds: [hubIds[0], outlier.frontmatter.id],
        steps: 2,
        topK: 20,
        threshold: 0.001,
        maxCollisions: 5,
      });

      const warnCount = countWarnings(stderrSpy, BFS_CAP_MARKER);

      // tagDistance is called O(topK^2 / 2) times in collision detection.
      // With topK=20, that's up to 190 calls. The cap fires per call (not
      // per step), so warnCount must be <= 190 — and crucially, it must
      // NOT be multiplied by BFS depth (which would be 4× higher with a
      // per-step warning). We assert a reasonable upper bound.
      expect(warnCount).toBeGreaterThanOrEqual(1);
      expect(warnCount).toBeLessThanOrEqual(200);

      // Result is still well-formed.
      expect(result.activated.length).toBeGreaterThan(0);
    },
  );
});
