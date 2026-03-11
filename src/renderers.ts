/**
 * View renderers — pure functions that materialize atoms/events into markdown views.
 * Each renderer takes data in, returns a string. No filesystem I/O.
 */

import { normalizeTimestamp } from './format.js';
import type { Atom, MemoryEvent } from './types.js';

export interface ViewBudget {
  maxLines: number;
}

// --- Helpers ---

/** Sort atoms by updated_at descending (newest first) for deterministic output. */
function sortByUpdated(atoms: Atom[]): Atom[] {
  return atoms.slice().sort((a, b) =>
    b.frontmatter.updated_at.localeCompare(a.frontmatter.updated_at),
  );
}

/** First non-empty line of the body, truncated to maxLen, with markdown sanitization. */
function firstLine(body: string, maxLen = 80): string {
  const line = body.split('\n').find((l) => l.trim().length > 0)?.trim() ?? '';
  const truncated = line.length > maxLen ? line.slice(0, maxLen) + '...' : line;
  return sanitizeMarkdownLine(truncated);
}

/**
 * Sanitize a string for safe interpolation into markdown.
 * Escapes characters that could create unintended links or formatting.
 */
function sanitizeMarkdownLine(text: string): string {
  return text.replace(/[[\]()]/g, (ch) => `\\${ch}`);
}

/**
 * Sanitize an atom ID or ref for safe interpolation into bold/strikethrough markdown.
 * Also escapes `*`, `~`, and `|` which break bold, strikethrough, and table syntax.
 */
function sanitizeId(text: string): string {
  return text.replace(/[[\]()*~|]/g, (ch) => `\\${ch}`);
}

/** Enforce line budget: truncate and add overflow indicator. */
function enforceBudget(lines: string[], budget?: ViewBudget): string[] {
  if (!budget || lines.length <= budget.maxLines) return lines;
  const truncated = lines.slice(0, budget.maxLines - 2);
  truncated.push('');
  truncated.push(`_...truncated (${lines.length - budget.maxLines + 2} more lines)_`);
  return truncated;
}

/** Filter to non-archived, non-expired atoms. */
function activeAtoms(atoms: Atom[]): Atom[] {
  return atoms.filter(
    (a) => a.frontmatter.status !== 'archived' && a.frontmatter.status !== 'expired',
  );
}

// --- Renderers ---

/**
 * Render INDEX.md — routing map of all active atoms grouped by type.
 * Target: ≤ 200 lines.
 */
export function renderIndex(atoms: Atom[], timestamp?: string, budget?: ViewBudget): string {
  const active = activeAtoms(atoms);

  const conflicts = sortByUpdated(active.filter((a) => a.frontmatter.type === 'conflict'));
  const decisions = sortByUpdated(active.filter((a) => a.frontmatter.type === 'decision'));
  const constraints = sortByUpdated(active.filter((a) => a.frontmatter.type === 'constraint'));
  const openQuestions = sortByUpdated(active.filter((a) => a.frontmatter.type === 'open_question'));
  const entities = sortByUpdated(active.filter((a) => a.frontmatter.type === 'entity_summary'));
  const facts = sortByUpdated(active.filter((a) => a.frontmatter.type === 'fact'));
  const beliefs = sortByUpdated(active.filter((a) => a.frontmatter.type === 'belief'));
  const procedures = sortByUpdated(active.filter((a) => a.frontmatter.type === 'procedure'));
  const preferences = sortByUpdated(active.filter((a) => a.frontmatter.type === 'preference'));

  const lines: string[] = [
    '---',
    'type: index',
    `updated_at: ${timestamp ?? normalizeTimestamp()}`,
    '---',
    '',
    '# Memory Index',
    '',
    '> Routing map. Kept under 200 lines. Details in ENTITIES/ and EPISODES/.',
    '',
  ];

  if (conflicts.length > 0) {
    lines.push(`## Active Conflicts (${conflicts.length})`, '');
    for (const c of conflicts) {
      lines.push(`- **${sanitizeId(c.frontmatter.id)}**: ${firstLine(c.body)}`);
    }
    lines.push('');
  }

  lines.push(`## Decisions (${decisions.length})`, '');
  for (const d of decisions) {
    lines.push(`- [${d.frontmatter.status}] **${sanitizeId(d.frontmatter.id)}** (confidence: ${d.frontmatter.confidence})`);
  }
  lines.push('');

  lines.push(`## Constraints (${constraints.length})`, '');
  for (const c of constraints) {
    lines.push(`- **${sanitizeId(c.frontmatter.id)}**: ${firstLine(c.body)}`);
  }
  lines.push('');

  lines.push(`## Open Questions (${openQuestions.length})`, '');
  for (const q of openQuestions) {
    lines.push(`- **${sanitizeId(q.frontmatter.id)}**: ${firstLine(q.body)}`);
  }
  lines.push('');

  lines.push(`## Entities (${entities.length})`, '');
  for (const e of entities) {
    lines.push(`- **${sanitizeId(e.frontmatter.id)}**`);
  }
  lines.push('');

  // Additional types in summary
  const otherCounts: string[] = [];
  if (facts.length > 0) otherCounts.push(`${facts.length} facts`);
  if (beliefs.length > 0) otherCounts.push(`${beliefs.length} beliefs`);
  if (procedures.length > 0) otherCounts.push(`${procedures.length} procedures`);
  if (preferences.length > 0) otherCounts.push(`${preferences.length} preferences`);

  if (otherCounts.length > 0) {
    lines.push(`## Other (${otherCounts.join(', ')})`, '');
  }

  return enforceBudget(lines, budget ?? { maxLines: 200 }).join('\n') + '\n';
}

/**
 * Render DECISIONS.md — all non-archived decisions grouped by status.
 */
export function renderDecisions(atoms: Atom[], timestamp?: string, budget?: ViewBudget): string {
  const active = activeAtoms(atoms);
  const decisions = active.filter((a) => a.frontmatter.type === 'decision');

  const accepted = sortByUpdated(decisions.filter((a) => a.frontmatter.status === 'accepted'));
  const activeStatus = sortByUpdated(decisions.filter((a) => a.frontmatter.status === 'active'));
  const draft = sortByUpdated(decisions.filter((a) => a.frontmatter.status === 'draft'));
  const other = sortByUpdated(decisions.filter((a) =>
    !['accepted', 'active', 'draft'].includes(a.frontmatter.status),
  ));

  const lines: string[] = [
    '---',
    'type: view',
    `updated_at: ${timestamp ?? normalizeTimestamp()}`,
    '---',
    '',
    '# Decisions',
    '',
    '> All accepted and draft decisions. Each links to its atom for full detail.',
    '',
  ];

  if (decisions.length === 0) {
    lines.push('_No decisions recorded._', '');
    return lines.join('\n') + '\n';
  }

  const renderGroup = (title: string, group: Atom[]) => {
    if (group.length === 0) return;
    lines.push(`## ${title} (${group.length})`, '');
    for (const d of group) {
      lines.push(`- **${sanitizeId(d.frontmatter.id)}** (confidence: ${d.frontmatter.confidence})`);
      lines.push(`  ${firstLine(d.body)}`);
    }
    lines.push('');
  };

  renderGroup('Accepted', accepted);
  renderGroup('Active', activeStatus);
  renderGroup('Draft', draft);
  renderGroup('Other', other);

  return enforceBudget(lines, budget ?? { maxLines: 150 }).join('\n') + '\n';
}

/**
 * Render CONSTRAINTS.md — all non-archived constraints.
 */
export function renderConstraints(atoms: Atom[], timestamp?: string, budget?: ViewBudget): string {
  const active = activeAtoms(atoms);
  const constraints = sortByUpdated(active.filter((a) => a.frontmatter.type === 'constraint'));

  const lines: string[] = [
    '---',
    'type: view',
    `updated_at: ${timestamp ?? normalizeTimestamp()}`,
    '---',
    '',
    '# Constraints',
    '',
    '> Active constraints and rules. Referenced during recall.',
    '',
  ];

  if (constraints.length === 0) {
    lines.push('_No constraints recorded._', '');
    return lines.join('\n') + '\n';
  }

  lines.push(`## Active (${constraints.length})`, '');
  for (const c of constraints) {
    lines.push(`- **${sanitizeId(c.frontmatter.id)}** (confidence: ${c.frontmatter.confidence})`);
    lines.push(`  ${firstLine(c.body)}`);
  }
  lines.push('');

  return enforceBudget(lines, budget ?? { maxLines: 150 }).join('\n') + '\n';
}

/**
 * Render OPEN_QUESTIONS.md — open and resolved questions with age tracking.
 */
export function renderOpenQuestions(atoms: Atom[], timestamp?: string, budget?: ViewBudget, now?: number): string {
  const active = activeAtoms(atoms);
  const questions = active.filter((a) => a.frontmatter.type === 'open_question');

  const open = sortByUpdated(questions.filter((a) =>
    !['resolved', 'rejected'].includes(a.frontmatter.status),
  ));
  const resolved = sortByUpdated(questions.filter((a) =>
    a.frontmatter.status === 'resolved',
  ));
  const rejected = sortByUpdated(questions.filter((a) =>
    a.frontmatter.status === 'rejected',
  ));

  const lines: string[] = [
    '---',
    'type: view',
    `updated_at: ${timestamp ?? normalizeTimestamp()}`,
    '---',
    '',
    '# Open Questions',
    '',
    '> Unresolved questions that must remain visible until resolved.',
    '',
  ];

  if (questions.length === 0) {
    lines.push('_No open questions._', '');
    return lines.join('\n') + '\n';
  }

  if (open.length > 0) {
    lines.push(`## Open (${open.length})`, '');
    const currentTime = now ?? Date.now();
    for (const q of open) {
      const ageMs = currentTime - new Date(q.frontmatter.created_at).getTime();
      const ageDays = Math.max(0, Math.floor(ageMs / 86_400_000));
      lines.push(`- **${sanitizeId(q.frontmatter.id)}** (confidence: ${q.frontmatter.confidence}, age: ${ageDays}d)`);
      lines.push(`  ${firstLine(q.body)}`);
    }
    lines.push('');
  }

  if (resolved.length > 0) {
    lines.push(`## Resolved (${resolved.length})`, '');
    for (const q of resolved) {
      lines.push(`- ~~${sanitizeId(q.frontmatter.id)}~~ (resolved ${q.frontmatter.updated_at.split('T')[0]})`);
    }
    lines.push('');
  }

  if (rejected.length > 0) {
    lines.push(`## Rejected (${rejected.length})`, '');
    for (const q of rejected) {
      lines.push(`- ~~${sanitizeId(q.frontmatter.id)}~~ (rejected ${q.frontmatter.updated_at.split('T')[0]})`);
    }
    lines.push('');
  }

  return enforceBudget(lines, budget ?? { maxLines: 150 }).join('\n') + '\n';
}

/**
 * Render HANDOFF.md — cross-session context: status summary, recent activity,
 * conflicts, key decisions, open questions.
 */
export function renderHandoff(
  atoms: Atom[],
  events: MemoryEvent[],
  timestamp?: string,
  budget?: ViewBudget,
): string {
  const active = activeAtoms(atoms);

  // Count by type
  const typeCounts = new Map<string, number>();
  for (const a of active) {
    typeCounts.set(a.frontmatter.type, (typeCounts.get(a.frontmatter.type) ?? 0) + 1);
  }

  const conflicts = active.filter((a) => a.frontmatter.type === 'conflict');
  const decisions = sortByUpdated(active.filter((a) => a.frontmatter.type === 'decision'));
  const openQuestions = sortByUpdated(active.filter((a) =>
    a.frontmatter.type === 'open_question' &&
    !['resolved', 'rejected'].includes(a.frontmatter.status),
  ));

  // Find recent events (last session or last 20)
  let recentEvents: MemoryEvent[] = [];
  if (events.length > 0) {
    const lastSessionId = events[events.length - 1].session_id;
    const sessionEvents = events.filter((e) => e.session_id === lastSessionId);
    recentEvents = sessionEvents.length > 0 ? sessionEvents.slice(-20) : events.slice(-20);
  }

  const lines: string[] = [
    '---',
    'type: handoff',
    `updated_at: ${timestamp ?? normalizeTimestamp()}`,
    '---',
    '',
    '# Handoff',
    '',
    '> Current working state. What the next session needs to know.',
    '',
  ];

  // Status section
  lines.push('## Status', '');
  const countParts: string[] = [];
  for (const [type, count] of [...typeCounts.entries()].sort()) {
    countParts.push(`${count} ${type}${count !== 1 ? 's' : ''}`);
  }
  lines.push(`- ${active.length} active atoms${countParts.length > 0 ? ` (${countParts.join(', ')})` : ''}`);
  lines.push(`- ${conflicts.length} active conflict${conflicts.length !== 1 ? 's' : ''}`);
  if (events.length > 0) {
    lines.push(`- Last event: ${events[events.length - 1].timestamp}`);
  }
  lines.push('');

  // Recent Activity
  lines.push('## Recent Activity', '');
  if (recentEvents.length === 0) {
    lines.push('_No recent activity._');
  } else {
    for (const e of recentEvents) {
      const refs = (e.atom_refs ?? []).map(sanitizeId).join(', ');
      lines.push(`- **${e.action}**${refs ? `: ${refs}` : ''}`);
    }
  }
  lines.push('');

  // Active Conflicts
  lines.push('## Active Conflicts', '');
  if (conflicts.length === 0) {
    lines.push('_None._');
  } else {
    for (const c of conflicts) {
      lines.push(`- **${sanitizeId(c.frontmatter.id)}**: ${firstLine(c.body)}`);
    }
  }
  lines.push('');

  // Key Decisions (top 5)
  lines.push(`## Key Decisions (${Math.min(decisions.length, 5)} of ${decisions.length})`, '');
  if (decisions.length === 0) {
    lines.push('_None._');
  } else {
    for (const d of decisions.slice(0, 5)) {
      lines.push(`- **${sanitizeId(d.frontmatter.id)}**: ${firstLine(d.body)}`);
    }
  }
  lines.push('');

  // Open Questions
  lines.push(`## Open Questions (${openQuestions.length})`, '');
  if (openQuestions.length === 0) {
    lines.push('_None._');
  } else {
    for (const q of openQuestions.slice(0, 5)) {
      lines.push(`- **${sanitizeId(q.frontmatter.id)}**: ${firstLine(q.body)}`);
    }
  }
  lines.push('');

  return enforceBudget(lines, budget ?? { maxLines: 80 }).join('\n') + '\n';
}
