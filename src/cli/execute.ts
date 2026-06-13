import fs from 'fs';
import type { Command } from 'commander';
import { resolveDir } from './resolve-dir.js';
import { readAtom, writeAtom, indexExists, snapshotAtom } from '../index.js';
import { indexAtom } from '../index-db.js';
import { assertWithinDir } from '../store.js';
import { appendEvent } from '../event-log.js';
import { normalizeTimestamp } from '../format.js';
import { exitWithError } from './cli-util.js';
import { findAtomFile } from './atom-lookup.js';

export interface ExecuteOptions {
  memoryDir: string;
  atomId: string;
  agent_id?: string;
  session_id?: string;
  dryRun?: boolean;
}

export interface ExecuteResult {
  atom_id: string;
  type: string;
  changed: boolean;
  executed_at: string;
  reason?: string;
}

/**
 * Stamp an atom's first-confirmed-execution timestamp (#309). For `procedure`
 * drafts this is the auto-promotion signal (a procedure is only trustworthy
 * once it has actually run — `autoPromote` in reflect.ts promotes executed
 * procedures at confidence ≥ 0.7). Idempotent: re-running preserves the FIRST
 * execution time, since "has it ever run" is the signal we care about.
 */
export function markExecuted(opts: ExecuteOptions): ExecuteResult {
  const { memoryDir, atomId } = opts;
  const agentId = opts.agent_id ?? 'cli';
  const sessionId = opts.session_id ?? 'mk-execute';

  const file = findAtomFile(memoryDir, atomId);
  if (!file) {
    throw new Error(`Atom not found: ${atomId}`);
  }
  // Path-traversal guard: the path is keyed off a user-supplied atom ID.
  assertWithinDir(memoryDir, file);

  const atom = readAtom(file);

  // Idempotent: keep the first execution timestamp.
  if (atom.frontmatter.executed_at) {
    return {
      atom_id: atomId,
      type: atom.frontmatter.type,
      changed: false,
      executed_at: atom.frontmatter.executed_at,
      reason: 'already marked executed',
    };
  }

  const now = normalizeTimestamp();
  if (opts.dryRun) {
    return { atom_id: atomId, type: atom.frontmatter.type, changed: true, executed_at: now, reason: 'dry-run' };
  }

  atom.frontmatter.executed_at = now;
  atom.frontmatter.updated_at = now;
  writeAtom(atom, file);

  appendEvent(memoryDir, 'atom_updated', {
    agent_id: agentId,
    session_id: sessionId,
    atom_refs: [atomId],
    touched_paths: [file],
    evidence: [`Marked executed at ${now}`],
    meta: { operation: 'execute' },
    schema_version: 2,
    atom_snapshot: snapshotAtom(atom),
  });

  if (indexExists(memoryDir)) {
    atom.filePath = file;
    indexAtom(memoryDir, atom);
  }

  return { atom_id: atomId, type: atom.frontmatter.type, changed: true, executed_at: now };
}

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
