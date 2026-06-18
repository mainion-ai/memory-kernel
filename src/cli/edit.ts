import fs from 'fs';
import type { Command } from 'commander';
import { resolveDir } from './resolve-dir.js';
import { editAtom, type EditResult } from '../edit.js';
import { exitWithError } from './cli-util.js';

export function registerEditCommand(program: Command): void {
  program
    .command('edit')
    .description(
      'Open an atom in $EDITOR and record a provenanced human_edit event on change.\n' +
        'A human directly correcting an atom is the strongest signal in the store —\n' +
        'this closes the gap where filesystem edits bypassed the event log (#247).\n' +
        'No-op (no event) when the file is saved unchanged. Encrypted (SECRET) atoms\n' +
        'are not editable this way.',
    )
    .argument('<atom-id>', 'The atom to edit')
    .option('-d, --dir <dir>', 'Memory directory', './memory')
    .option('--agent-id <id>', 'Agent ID recorded on the emitted event', 'cli')
    .option('--session-id <id>', 'Session ID recorded on the emitted event', 'mk-edit')
    .option('--dry-run', 'Resolve the atom without launching the editor or emitting events')
    .option('--json', 'Output as JSON')
    .action((
      atomId: string,
      opts: { dir: string; agentId: string; sessionId: string; dryRun?: boolean; json?: boolean },
    ) => {
      const memoryDir = resolveDir(opts.dir, program.opts().agent);
      if (!fs.existsSync(memoryDir)) {
        exitWithError(`Memory directory not found: ${memoryDir}`, opts.json);
      }

      let result: EditResult;
      try {
        result = editAtom({
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

      if (!result.changed) {
        console.log(`✓ ${result.atom_id} unchanged (${result.reason ?? 'no changes'})`);
      } else {
        console.log(
          `✓ ${result.atom_id} edited → human_edit recorded ` +
            `(+${result.lines_added}/-${result.lines_removed}, updated_at ${result.updated_at})`,
        );
      }
    });
}
