import fs from 'fs';
import type { Command } from 'commander';
import { resolveDir } from './resolve-dir.js';
import { exitWithError } from './cli-util.js';
import { seedLifecycle, type SeedResult } from '../seed.js';

/**
 * `mk seed --lifecycle` — idempotently reconcile a store to the canonical
 * lifecycle seed set (#329). Safe to re-run: existing atoms are matched on
 * their stable slug segment and superseded in place rather than duplicated.
 */
export function registerSeedCommand(program: Command): void {
  program
    .command('seed')
    .description('Seed canonical atoms into a store (idempotent — re-runnable without duplicates)')
    .option('--lifecycle', 'Seed the canonical lifecycle atom set (10 procedures + 1 constraint)')
    .option('-d, --dir <dir>', 'Memory directory', './memory')
    .option('--seed-dir <dir>', 'Override the shipped lifecycle seed directory (testing)')
    .option('--dry-run', 'Report planned actions without writing files or emitting events')
    .option('--agent-id <id>', 'Agent ID recorded on emitted events', 'cli')
    .option('--session-id <id>', 'Session ID recorded on emitted events', 'mk-seed')
    .option('--json', 'Output as JSON')
    .action((opts: {
      lifecycle?: boolean;
      dir: string;
      seedDir?: string;
      dryRun?: boolean;
      agentId: string;
      sessionId: string;
      json?: boolean;
    }) => {
      if (!opts.lifecycle) {
        exitWithError('Specify a seed set: --lifecycle', opts.json);
      }

      const memoryDir = resolveDir(opts.dir, program.opts().agent);
      if (!fs.existsSync(memoryDir)) {
        exitWithError(`Memory directory not found: ${memoryDir}`, opts.json);
      }

      let result: SeedResult;
      try {
        result = seedLifecycle({
          memoryDir,
          seedDir: opts.seedDir,
          dryRun: opts.dryRun,
          agent_id: opts.agentId,
          session_id: opts.sessionId,
        });
      } catch (err) {
        exitWithError(err instanceof Error ? err.message : String(err), opts.json);
        return; // unreachable — exitWithError throws/exits; satisfies TS narrowing
      }

      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      const prefix = result.dry_run ? '[dry-run] ' : '';
      console.log(`✓ ${prefix}Lifecycle seed reconciled (${result.results.length} canonical atoms):`);
      console.log(`  created: ${result.created}  updated: ${result.updated}  unchanged: ${result.unchanged}  deduped: ${result.deduped}`);
      if (result.superseded > 0) {
        console.log(`  superseded ${result.superseded} stale/duplicate atom(s) in place`);
      }
      for (const r of result.results) {
        if (r.action !== 'unchanged') {
          console.log(`  • ${r.action}: ${r.slug}${r.superseded_ids.length ? ` (superseded ${r.superseded_ids.length})` : ''}`);
        }
      }
    });
}
