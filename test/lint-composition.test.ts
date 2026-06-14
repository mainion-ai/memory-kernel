/**
 * Store-composition skew check in mk lint (#316).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { initMemoryDir, createAtom, closeAllIndexes } from '../src/index.js';
import { lintMemoryStore } from '../src/lint.js';
import type { AtomType } from '../src/types.js';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist/cli/mk.js');

let testDir: string;

beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-lint-comp-'));
  initMemoryDir(testDir);
});
afterEach(() => {
  closeAllIndexes();
  fs.rmSync(testDir, { recursive: true, force: true });
});

function add(type: AtomType, n: number): void {
  for (let i = 0; i < n; i++) {
    createAtom({
      memoryDir: testDir, agent_id: 'a', session_id: 's',
      type, slug: `${type}-${i}`, body: `${type} atom ${i}`,
      status: 'active', // beliefs default to draft; force active so they count
    });
  }
}

function compositionFindings() {
  return lintMemoryStore(testDir).findings.filter((f) => f.category === 'composition');
}

describe('lint store-composition (#316)', () => {
  // The check only engages at >= 20 active atoms (MIN_ACTIVE_FOR_COMPOSITION).
  it('warns on belief monoculture (>80% of active atoms are beliefs)', () => {
    add('belief', 18);
    add('fact', 2); // 20 active, 90% belief
    const f = compositionFindings();
    const skew = f.find((x) => x.message.includes('belief monoculture'));
    expect(skew).toBeDefined();
    expect(skew!.severity).toBe('warning');
    expect(skew!.message).toContain('90%');
  });

  it('does not warn monoculture on a balanced store', () => {
    add('fact', 10); add('decision', 4); add('procedure', 3); add('preference', 3); // 20 active, 0 belief
    const f = compositionFindings();
    expect(f.find((x) => x.message.includes('belief monoculture'))).toBeUndefined();
  });

  it('warns on a composition gap (a core type has 0 active atoms)', () => {
    add('fact', 18); add('decision', 1); add('preference', 1); // 20 active, no procedure
    const gap = compositionFindings().find((x) => x.message.includes('composition gap'));
    expect(gap).toBeDefined();
    expect(gap!.message).toContain('procedure');
  });

  it('no composition findings on an empty store (no divide-by-zero)', () => {
    expect(compositionFindings()).toEqual([]);
  });

  it('skips the check on a small/fresh store below the min-active floor (#316 review)', () => {
    // A lifecycle-seed-only-sized store (well under 20 active) must not be flagged.
    add('procedure', 10); add('belief', 5); // 15 active — below floor; would otherwise flag a gap
    expect(compositionFindings()).toEqual([]);
  });

  it('counts only active atoms (draft beliefs do not trigger monoculture)', () => {
    // 22 draft beliefs (createAtom default) + 20 active facts → 20 active atoms, all facts.
    for (let i = 0; i < 22; i++) {
      createAtom({ memoryDir: testDir, agent_id: 'a', session_id: 's', type: 'belief', slug: `b-${i}`, body: `b${i}` });
    }
    add('fact', 20);
    expect(compositionFindings().find((x) => x.message.includes('belief monoculture'))).toBeUndefined();
  });
});

describe('mk lint --strict (#316)', () => {
  function runLint(strict: boolean): number {
    add('belief', 18); add('fact', 2); // 20 active, belief monoculture → a warning
    try {
      execFileSync('node', [CLI, 'lint', '-d', testDir, ...(strict ? ['--strict'] : [])], { encoding: 'utf8' });
      return 0;
    } catch (e: any) {
      return e.status ?? -1;
    }
  }

  it('exits 1 with --strict when warnings are present', () => {
    expect(runLint(true)).toBe(1);
  });

  it('exits 0 without --strict even when warnings are present', () => {
    expect(runLint(false)).toBe(0);
  });
});
