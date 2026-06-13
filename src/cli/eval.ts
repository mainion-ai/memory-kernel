/**
 * CLI command for `mk eval` (#300) — golden-query recall eval with pass/fail
 * exit codes, so it can gate CI and serve as a post-sync canary.
 *
 * Exit codes:
 *   0 — all fixtures passed (pass_rate >= threshold)
 *   1 — one or more fixtures below threshold
 *   2 — runner error (missing store/dir, malformed fixture)
 */

import fs from 'fs';
import path from 'path';
import type { Command } from 'commander';
import { resolveDir } from './resolve-dir.js';
import {
  loadFixtures,
  runEval,
  exitCodeForEval,
  EvalError,
  type EmbedMode,
  type EvalResult,
} from '../eval.js';

/** Runner-error exit (code 2): malformed fixture, missing store/dir. */
function runnerError(message: string, json?: boolean): never {
  if (json) {
    console.log(JSON.stringify({ error: message, exit_code: 2 }, null, 2));
  } else {
    console.error(`✗ ${message}`);
  }
  process.exit(2);
}

export function registerEvalCommand(program: Command): void {
  program
    .command('eval')
    .description('Run golden-query recall fixtures with pass/fail exit codes')
    .option('-d, --dir <dir>', 'Memory directory', './memory')
    .option('--fixture <path>', 'Fixture file or directory (default: <dir>/eval)')
    .option('--top-k <n>', 'Top-K cutoff for the recall match', parseInt)
    .option('--threshold <n>', 'Pass-rate threshold 0..1 (overrides fixture)', parseFloat)
    .option('--no-embed', 'Force FTS-only recall (skip embeddings even if configured)')
    .option('--json', 'Output as JSON')
    .action(async (opts: {
      dir: string;
      fixture?: string;
      topK?: number;
      threshold?: number;
      embed?: boolean; // commander: true by default, false when --no-embed
      json?: boolean;
    }) => {
      const memoryDir = resolveDir(opts.dir, program.opts().agent);
      if (!fs.existsSync(memoryDir)) {
        runnerError(`Memory directory not found: ${memoryDir}\n  Run "mk init" first.`, opts.json);
      }

      if (opts.topK !== undefined && (isNaN(opts.topK) || opts.topK < 1)) {
        runnerError('--top-k must be a positive integer', opts.json);
      }
      if (opts.threshold !== undefined && (isNaN(opts.threshold) || opts.threshold < 0 || opts.threshold > 1)) {
        runnerError('--threshold must be between 0 and 1', opts.json);
      }

      // Default fixture location: <store>/eval
      const fixturePath = opts.fixture ?? path.join(memoryDir, 'eval');
      if (!fs.existsSync(fixturePath)) {
        runnerError(
          `No fixtures at ${fixturePath}.\n  Create <store>/eval/*.yaml or pass --fixture <path>.`,
          opts.json,
        );
      }

      // Default-true unless --no-embed; we never force 'on' — 'auto' engages
      // embeddings only when a key + vectors exist (keeps CI deterministic).
      const embed: EmbedMode = opts.embed === false ? 'off' : 'auto';

      let results: EvalResult[];
      try {
        const fixtures = loadFixtures(fixturePath);
        results = await runEval(memoryDir, fixtures, {
          topK: opts.topK,
          threshold: opts.threshold,
          embed,
        });
      } catch (err) {
        // Any runner-side failure (malformed fixture, corrupt/locked index, fs
        // error) is exit 2 — never let it surface as Node's default exit 1,
        // which the contract reserves for "below threshold" (#300 review).
        runnerError(err instanceof EvalError ? err.message : `eval runner error: ${String(err)}`, opts.json);
      }

      const exitCode = exitCodeForEval(results);

      if (opts.json) {
        console.log(JSON.stringify({ fixtures: results, ok: exitCode === 0, exit_code: exitCode }, null, 2));
        process.exit(exitCode);
      }

      // Human-readable
      for (const r of results) {
        const head = `${r.ok ? '✓' : '✗'} ${r.fixture}: ${r.passed}/${r.total} (${Math.round(r.pass_rate * 100)}%) ` +
          `— threshold ${Math.round(r.threshold * 100)}%, top-${r.top_k}, ${r.embed_used ? 'embed' : 'FTS'}`;
        console.log(head);
        for (const q of r.results) {
          console.log(`    ${q.passed ? 'PASS' : 'FAIL'} ${q.cat ? `[${q.cat}] ` : ''}${q.task.slice(0, 50)}  ${q.detail}`);
        }
      }
      const failed = results.filter((r) => !r.ok).length;
      console.log(
        failed === 0
          ? `\n✓ All ${results.length} fixture(s) passed.`
          : `\n✗ ${failed}/${results.length} fixture(s) below threshold.`,
      );
      process.exit(exitCode);
    });
}
