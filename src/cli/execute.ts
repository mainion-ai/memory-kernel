import fs from 'fs';
import type { Command } from 'commander';
import { resolveDir } from './resolve-dir.js';
import { markExecuted, type ExecuteResult } from '../execute.js';
import { exitWithError } from './cli-util.js';

export function registerExecuteCommand(program: Command): void {
  program
    .command('execute')
    .description(
      'Mark an atom as executed (stamps executed_at). For draft procedures this is\n' +
      'the auto-promotion signal — `mk reflect` promotes executed procedures at\n' +
      'confidence ≥ 0.7. Idempotent: preserves the first execution time.',
    )
    .argument('<atom-id>', 'The atom that was executed')
    .option('-d, --dir <dir>', 'Memory directory', './memory')
    .option('--agent-id <id>', 'Agent ID recorded on the emitted event', 'cli')
    .option('--session-id <id>', 'Session ID recorded on the emitted event', 'mk-execute')
    .option('--dry-run', 'Preview without writing files or emitting events')
    .option('--json', 'Output as JSON')
    .action((
      atomId: string,
      opts: { dir: string; agentId: string; sessionId: string; dryRun?: boolean; json?: boolean },
    ) => {
      const memoryDir = resolveDir(opts.dir, program.opts().agent);
      if (!fs.existsSync(memoryDir)) {
        exitWithError(`Memory directory not found: ${memoryDir}`, opts.json);
      }

      let result: ExecuteResult;
      try {
        result = markExecuted({
          memoryDir,
          atomId,
          agent_id: opts.agentId,
          session_id: opts.sessionId,
          dryRun: opts.dryRun,
        });
      } catch (err) {
        exitWithError(err instanceof Error ? err.message : String(err), opts.json);
        return; // unreachable
      }

      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      const prefix = opts.dryRun ? '[dry-run] ' : '';
      if (!result.changed) {
        console.log(`✓ ${result.atom_id} already executed (${result.executed_at})`);
      } else {
        console.log(`✓ ${prefix}${result.atom_id} → executed_at ${result.executed_at}`);
        if (result.type === 'procedure') {
          console.log('  procedure draft is now promote-eligible (confidence ≥ 0.7) on the next `mk reflect`');
        }
      }
    });
}
