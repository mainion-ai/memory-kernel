#!/usr/bin/env npx tsx
/**
 * Benchmark harness — PRD v1.2 §5.2, §12.4
 *
 * Measures recall p50/p95/p99, reflect time, and replay time at a realistic
 * 100-atom scale. Produces a JSON report to stdout.
 *
 * PRD target (§8): recall p95 < 50ms for common lookups (excluding embeddings).
 *
 * Usage:
 *   npm run bench                    — print report to stdout
 *   npm run bench:baseline           — save report to scripts/bench-baseline.json
 *
 * Compare against a pinned baseline:
 *   jq '.recall.p95_ms' scripts/bench-baseline.json
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

import {
  initMemoryDir,
  createAtom,
  updateAtom,
  reflect,
  recall,
  reindex,
  readEvents,
  closeAllIndexes,
  replay,
} from '../src/index.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface BenchReport {
  meta: {
    timestamp: string;
    version: string;
    node_version: string;
    platform: string;
    atom_count: number;
  };
  recall: {
    p50_ms: number;
    p95_ms: number;
    p99_ms: number;
    samples: number;
    target_p95_ms: 50;
    meets_target: boolean;
  };
  reflect: {
    elapsed_ms: number;
  };
  replay: {
    elapsed_ms: number;
    events_count: number;
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)]!;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ---------------------------------------------------------------------------
// Setup: populate a realistic memory workload
// ---------------------------------------------------------------------------

const ATOM_TYPES = ['fact', 'decision', 'constraint', 'belief', 'preference'] as const;
const AGENT = 'bench-agent';
const SESSION = 'bench-session';

function setupMemory(memDir: string, atomCount: number): void {
  initMemoryDir(memDir);
  const base = { memoryDir: memDir, agent_id: AGENT, session_id: SESSION };

  for (let i = 0; i < atomCount; i++) {
    const type = ATOM_TYPES[i % ATOM_TYPES.length]!;
    const a = createAtom({
      ...base,
      type,
      slug: `bench-${i}`,
      body: [
        `## ${type.charAt(0).toUpperCase() + type.slice(1)}`,
        `Content for atom ${i}. ` +
          'Uses cursor pagination with a 30s timeout. Token budget test for recall.',
        '',
        '## Numbers',
        `- Index: ${i}`,
        `- Port: ${8000 + (i % 100)}`,
      ].join('\n'),
      confidence: type === 'belief' ? 0.5 + (i % 5) * 0.08 : 0.9,
      scope: {
        tags: [`tag-${i % 10}`],
        paths: [`/service/${i % 5}`],
      },
    });

    // Update every other atom to add intermediate events to the log
    if (i % 2 === 0) {
      updateAtom({ ...base, filePath: a.filePath!, updates: { confidence: 0.95 } });
    }
  }
}

// ---------------------------------------------------------------------------
// Workload 1: recall p50/p95/p99
// ---------------------------------------------------------------------------

function benchRecall(
  memDir: string,
  iterations: number,
): { p50: number; p95: number; p99: number; samples: number } {
  // Pre-warm: ensure the SQLite index is built so we measure the common (indexed) path
  reindex(memDir);

  const samples: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    recall(memDir, { max_tokens: 4000 });
    samples.push(performance.now() - t0);
  }
  samples.sort((a, b) => a - b);

  return {
    p50: percentile(samples, 50),
    p95: percentile(samples, 95),
    p99: percentile(samples, 99),
    samples: samples.length,
  };
}

// ---------------------------------------------------------------------------
// Workload 2: single reflect call
// ---------------------------------------------------------------------------

function benchReflect(memDir: string): { elapsed: number } {
  const base = { memoryDir: memDir, agent_id: AGENT, session_id: SESSION };
  const t0 = performance.now();
  reflect(base);
  return { elapsed: performance.now() - t0 };
}

// ---------------------------------------------------------------------------
// Workload 3: full replay from event log
// ---------------------------------------------------------------------------

function benchReplay(memDir: string): { elapsed: number; events_count: number } {
  const events = readEvents(memDir);
  const t0 = performance.now();
  replay(events, { timestamp: '2026-01-01T00:00:00Z' });
  return { elapsed: performance.now() - t0, events_count: events.length };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const ATOM_COUNT = 100;
  const RECALL_ITERATIONS = 50;

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-bench-'));

  try {
    process.stderr.write(`Setting up ${ATOM_COUNT}-atom workload...\n`);
    setupMemory(tmpDir, ATOM_COUNT);

    process.stderr.write('Benchmarking recall...\n');
    const recallResult = benchRecall(tmpDir, RECALL_ITERATIONS);

    process.stderr.write('Benchmarking reflect...\n');
    const reflectResult = benchReflect(tmpDir);

    process.stderr.write('Benchmarking replay...\n');
    const replayResult = benchReplay(tmpDir);

    // Read version from package.json
    const pkgPath = path.resolve(fileURLToPath(import.meta.url), '../../package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as { version: string };

    const report: BenchReport = {
      meta: {
        timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
        version: pkg.version,
        node_version: process.version,
        platform: process.platform,
        atom_count: ATOM_COUNT,
      },
      recall: {
        p50_ms: round2(recallResult.p50),
        p95_ms: round2(recallResult.p95),
        p99_ms: round2(recallResult.p99),
        samples: recallResult.samples,
        target_p95_ms: 50,
        meets_target: recallResult.p95 <= 50,
      },
      reflect: {
        elapsed_ms: round2(reflectResult.elapsed),
      },
      replay: {
        elapsed_ms: round2(replayResult.elapsed),
        events_count: replayResult.events_count,
      },
    };

    process.stdout.write(JSON.stringify(report, null, 2) + '\n');

    // Emit a warning if the p95 target is exceeded
    if (!report.recall.meets_target) {
      process.stderr.write(
        `\nWARNING: recall p95 ${report.recall.p95_ms}ms exceeds PRD target of 50ms\n`,
      );
    } else {
      process.stderr.write(
        `\n✓ recall p95 ${report.recall.p95_ms}ms (target: 50ms)\n`,
      );
    }
  } finally {
    closeAllIndexes();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`Bench error: ${String(err)}\n`);
  process.exit(1);
});
