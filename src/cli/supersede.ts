import fs from 'fs';
import type { Command } from 'commander';
import { resolveDir } from './resolve-dir.js';
import { supersedeAtoms, type SupersedeResult } from '../supersede.js';
import { exitWithError } from './cli-util.js';

// Superseded atoms are excluded from default recall/render — the durable
// invariant callers rely on after invoking this command.
export function registerSupersedeCommand(program: Command): void {
  program
    .command('supersede')
    .description(
      'Mark an atom as superseded by a newer atom.\n' +
      'Sets old atom status to "superseded" and adds a "supersedes" relation on the new atom.',
    )
    .argument('<old-atom-id>', 'The atom being replaced (will be marked superseded)')
    .argument('<new-atom-id>', 'The atom that replaces it (gets the supersedes relation)')
    .option('-d, --dir <dir>', 'Memory directory', './memory')
    .option('--agent-id <id>', 'Agent ID recorded on emitted events', 'cli')
    .option('--session-id <id>', 'Session ID recorded on emitted events', 'mk-supersede')
    .option('--dry-run', 'Preview changes without writing files or emitting events')
    .option('--json', 'Output as JSON')
    .action((
      oldAtomId: string,
      newAtomId: string,
      opts: {
        dir: string;
        agentId: string;
        sessionId: string;
        dryRun?: boolean;
        json?: boolean;
      },
    ) => {
      const memoryDir = resolveDir(opts.dir, program.opts().agent);
      if (!fs.existsSync(memoryDir)) {
        exitWithError(`Memory directory not found: ${memoryDir}`, opts.json);
      }

      let result: SupersedeResult;
      try {
        result = supersedeAtoms({
          memoryDir,
          oldAtomId,
          newAtomId,
          agent_id: opts.agentId,
          session_id: opts.sessionId,
          dryRun: opts.dryRun,
        });
      } catch (err) {
        exitWithError(err instanceof Error ? err.message : String(err), opts.json);
      }

      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      if (!result.changed) {
        console.log(`✓ Already superseded: ${oldAtomId}`);
        return;
      }

      const prefix = opts.dryRun ? '[dry-run] ' : '';
      if (result.old_status_changed) {
        console.log(`✓ ${prefix}${oldAtomId} → superseded`);
      }
      if (result.relation_added) {
        console.log(`✓ ${prefix}${newAtomId} --[supersedes]--> ${oldAtomId}`);
      }
    });
}
