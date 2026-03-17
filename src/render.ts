/**
 * Render memory kernel state as a CLAUDE.md context file.
 * Used by `mk render <memory-dir> <output-path>`.
 */

import { recall } from './recall.js';
import { listAtoms } from './store.js';
import { countEvents } from './event-log.js';

export interface RenderClaudeMdOptions {
  /** Token budget for recall. Default: 8000 (~5% of a 200K context window, ~100 atoms). */
  maxTokens?: number;
}

/**
 * Render active memory atoms as a CLAUDE.md markdown string.
 * Returns the rendered content — caller is responsible for writing to disk.
 */
export function renderClaudeMd(memoryDir: string, opts: RenderClaudeMdOptions = {}): string {
  const maxTokens = opts.maxTokens ?? 8000;

  // Recall with token budget — keeps CLAUDE.md from bloating as atoms grow.
  recall(memoryDir, { max_tokens: maxTokens });

  const atoms = listAtoms(memoryDir);
  const active = atoms.filter(
    (a) => a.frontmatter.status !== 'archived' && a.frontmatter.status !== 'expired',
  );
  const eventCount = countEvents(memoryDir);

  // Group by type
  const facts = active.filter((a) => a.frontmatter.type === 'fact');
  const decisions = active.filter((a) => a.frontmatter.type === 'decision');
  const constraints = active.filter((a) => a.frontmatter.type === 'constraint');
  const openQuestions = active.filter((a) => a.frontmatter.type === 'open_question');
  const preferences = active.filter((a) => a.frontmatter.type === 'preference');
  const beliefs = active.filter((a) => a.frontmatter.type === 'belief');
  const conflicts = active.filter((a) => a.frontmatter.type === 'conflict');

  const lines: string[] = [];

  lines.push('# Memory');
  lines.push('');
  lines.push(
    `> Auto-generated from memory-kernel. ${active.length} atoms, ${eventCount} events.`,
  );
  lines.push(`> Last rendered: ${new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')}`);
  lines.push(`> Source: ${memoryDir}`);
  lines.push('');

  // Conflicts first (most urgent)
  if (conflicts.length > 0) {
    lines.push('## ⚠ Active Conflicts');
    lines.push('');
    for (const c of conflicts) {
      lines.push(`### ${c.frontmatter.id}`);
      lines.push(c.body.trim());
      lines.push('');
    }
  }

  if (facts.length > 0) {
    lines.push('## Key Facts');
    lines.push('');
    for (const f of facts) {
      lines.push(`### ${f.frontmatter.id}`);
      lines.push(f.body.trim());
      lines.push('');
    }
  }

  if (decisions.length > 0) {
    lines.push('## Decisions');
    lines.push('');
    for (const d of decisions) {
      const confSuffix =
        d.frontmatter.confidence !== undefined ? ` (confidence: ${d.frontmatter.confidence})` : '';
      lines.push(`### ${d.frontmatter.id}${confSuffix}`);
      lines.push(d.body.trim());
      lines.push('');
    }
  }

  if (constraints.length > 0) {
    lines.push('## Constraints');
    lines.push('');
    for (const c of constraints) {
      lines.push(`### ${c.frontmatter.id}`);
      lines.push(c.body.trim());
      lines.push('');
    }
  }

  if (openQuestions.length > 0) {
    lines.push('## Open Questions');
    lines.push('');
    for (const q of openQuestions) {
      lines.push(`### ${q.frontmatter.id}`);
      lines.push(q.body.trim());
      lines.push('');
    }
  }

  if (preferences.length > 0) {
    lines.push('## Preferences');
    lines.push('');
    for (const p of preferences) {
      lines.push(`### ${p.frontmatter.id}`);
      lines.push(p.body.trim());
      lines.push('');
    }
  }

  if (beliefs.length > 0) {
    lines.push('## Beliefs (unverified)');
    lines.push('');
    for (const b of beliefs) {
      const confSuffix =
        b.frontmatter.confidence !== undefined ? ` (confidence: ${b.frontmatter.confidence})` : '';
      lines.push(`### ${b.frontmatter.id}${confSuffix}`);
      lines.push(b.body.trim());
      lines.push('');
    }
  }

  return lines.join('\n') + '\n';
}
