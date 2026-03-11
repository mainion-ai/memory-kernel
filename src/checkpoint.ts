/**
 * Checkpoint — generate a handoff bundle for cross-session context transfer.
 * Combines reflect + recall + fresh views into a single markdown document.
 */

import { appendEvent } from './event-log.js';
import { recall } from './recall.js';
import { reflect } from './reflect.js';
import { readView } from './store.js';
import type { ContextBundle } from './types.js';

export interface CheckpointOptions {
  memoryDir: string;
  agent_id: string;
  session_id: string;
  task?: string;
  max_tokens?: number; // default: 4000
  skipReflect?: boolean;
}

export interface CheckpointResult {
  bundle: ContextBundle;
  markdown: string; // Concatenated INDEX + HANDOFF + CONSTRAINTS + atoms
  event_id: string;
  error?: string; // Present if reflect or recall failed (graceful degradation)
}

/**
 * Generate a checkpoint: reflect (optional), recall, and assemble a handoff document.
 * Wraps reflect/recall in try/catch for graceful degradation — a partial checkpoint
 * is better than no checkpoint at all.
 */
export function checkpoint(opts: CheckpointOptions): CheckpointResult {
  let reflectError: string | undefined;

  // 1. Run reflect to consolidate state (unless skipped)
  if (!opts.skipReflect) {
    try {
      reflect({
        memoryDir: opts.memoryDir,
        agent_id: opts.agent_id,
        session_id: opts.session_id,
      });
    } catch (err) {
      reflectError = `reflect failed: ${String(err)}`;
    }
  }

  // 2. Recall context with optional task/token budget
  let bundle: ContextBundle;
  try {
    bundle = recall(opts.memoryDir, {
      task: opts.task,
      max_tokens: opts.max_tokens ?? 4000,
    });
  } catch (err) {
    // If recall also fails, emit error event and return minimal checkpoint
    const errorMsg = reflectError
      ? `${reflectError}; recall failed: ${String(err)}`
      : `recall failed: ${String(err)}`;

    const event = appendEvent(opts.memoryDir, 'checkpoint_created', {
      agent_id: opts.agent_id,
      session_id: opts.session_id,
      meta: {
        error: errorMsg,
        task: opts.task,
      },
    });

    return {
      bundle: {
        index: '',
        handoff: '',
        constraints: '',
        atoms: [],
        token_estimate: 0,
      },
      markdown: `<!-- Memory Kernel Checkpoint (error) -->\n\nCheckpoint failed: ${errorMsg}\n`,
      event_id: event.event_id,
      error: errorMsg,
    };
  }

  // 3. Read fresh views (post-reflect) — guard against missing view files
  const safeReadView = (name: string): string => {
    try { return readView(opts.memoryDir, name); } catch { return ''; }
  };
  const index = safeReadView('INDEX.md');
  const handoff = safeReadView('HANDOFF.md');
  const constraints = safeReadView('CONSTRAINTS.md');

  // Update bundle with fresh views
  bundle.index = index;
  bundle.handoff = handoff;
  bundle.constraints = constraints;

  // 4. Assemble markdown
  const sections: string[] = [
    '<!-- Memory Kernel Checkpoint -->',
    '',
    index.trim(),
    '',
    '---',
    '',
    handoff.trim(),
    '',
    '---',
    '',
    constraints.trim(),
  ];

  if (bundle.atoms.length > 0) {
    sections.push('', '---', '', '## Scoped Atoms', '');
    for (const atom of bundle.atoms) {
      const fm = atom.frontmatter;
      sections.push(`### ${fm.id} (${fm.type}, ${fm.status}, confidence: ${fm.confidence})`);
      sections.push('');
      sections.push(atom.body.trim());
      sections.push('');
    }
  }

  const markdown = sections.join('\n') + '\n';

  // 5. Emit checkpoint event
  const event = appendEvent(opts.memoryDir, 'checkpoint_created', {
    agent_id: opts.agent_id,
    session_id: opts.session_id,
    meta: {
      token_estimate: bundle.token_estimate,
      atom_count: bundle.atoms.length,
      task: opts.task,
      ...(reflectError ? { reflect_error: reflectError } : {}),
    },
  });

  return {
    bundle,
    markdown,
    event_id: event.event_id,
    ...(reflectError ? { error: reflectError } : {}),
  };
}
