/**
 * Render memory kernel state as a CLAUDE.md context file.
 * Used by `mk render <memory-dir> <output-path>`.
 */

import { recall } from './recall.js';
import { countEvents } from './event-log.js';
import { getAllRelations } from './index-db.js';
import type { Atom } from './types.js';

// --- Belief arc helpers ---

interface BeliefArcEntry {
  atom: Atom;
  depth: number;
}

interface BeliefArc {
  entries: BeliefArcEntry[];
  rootSlug: string;
  leafSlug: string;
  dateRange: [string, string];
}

/** Extract human-readable slug from atom ID (TYPE-YYYY-MM-DD-SLUG-hash). */
function extractSlug(atomId: string): string {
  const parts = atomId.split('-');
  const dateIdx = parts.findIndex((p) => /^\d{4}$/.test(p));
  if (dateIdx < 0 || dateIdx + 3 >= parts.length) return atomId.toLowerCase();
  const slugParts = parts.slice(dateIdx + 3, -1);
  return slugParts.join('-').toLowerCase() || atomId.toLowerCase();
}

/** Format a date range as "Mon DD–Mon DD" or single date if same day. */
function formatDateRange(start: string, end: string): string {
  const fmt = (iso: string) => {
    const d = new Date(iso);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  };
  const s = fmt(start);
  const e = fmt(end);
  return s === e ? s : `${s}\u2013${e}`;
}

/**
 * Build developmental arcs from belief atoms using extends relations.
 * Returns arcs (chains of ≥2 nodes) and standalone beliefs.
 */
function buildBeliefArcs(
  beliefs: Atom[],
  memoryDir: string,
): { arcs: BeliefArc[]; standalone: Atom[] } {
  const beliefById = new Map<string, Atom>();
  for (const b of beliefs) beliefById.set(b.frontmatter.id, b);

  // Load extends edges only
  const allRelations = getAllRelations(memoryDir);
  const extendsEdges = allRelations.filter((r) => r.relation_type === 'extends');

  // Build child→parent and parent→children maps (only for beliefs in the recall set)
  const extendsTo = new Map<string, string>(); // child → parent
  const extendedBy = new Map<string, string[]>(); // parent → children

  for (const edge of extendsEdges) {
    const childId = edge.source_id;
    const parentId = edge.target_id;
    if (!beliefById.has(childId)) continue; // child must be a belief in recall set

    // If parent is not a belief in the set, the child becomes a root (handled below)
    extendsTo.set(childId, parentId);

    if (beliefById.has(parentId)) {
      const children = extendedBy.get(parentId) ?? [];
      children.push(childId);
      extendedBy.set(parentId, children);
    }
  }

  // Find roots: beliefs that are extended but don't extend anything (in-set),
  // plus beliefs whose parent is not in the belief set.
  const roots = new Set<string>();
  for (const [parentId] of extendedBy) {
    if (!extendsTo.has(parentId)) roots.add(parentId);
  }
  for (const [childId, parentId] of extendsTo) {
    if (!beliefById.has(parentId)) roots.add(childId);
  }

  // DFS walk from roots
  const visited = new Set<string>();
  const inArc = new Set<string>();

  function walkDfs(atomId: string, depth: number, entries: BeliefArcEntry[]): void {
    if (visited.has(atomId)) return;
    visited.add(atomId);
    const atom = beliefById.get(atomId);
    if (!atom) return;
    entries.push({ atom, depth });

    const children = (extendedBy.get(atomId) ?? [])
      .filter((cid) => !visited.has(cid) && beliefById.has(cid))
      .sort((a, b) => {
        const aDate = beliefById.get(a)!.frontmatter.created_at;
        const bDate = beliefById.get(b)!.frontmatter.created_at;
        return aDate < bDate ? -1 : aDate > bDate ? 1 : 0;
      });

    for (const childId of children) {
      walkDfs(childId, depth + 1, entries);
    }
  }

  const arcs: BeliefArc[] = [];
  // Sort roots chronologically
  const sortedRoots = [...roots].sort((a, b) => {
    const aDate = beliefById.get(a)?.frontmatter.created_at ?? '';
    const bDate = beliefById.get(b)?.frontmatter.created_at ?? '';
    return aDate < bDate ? -1 : aDate > bDate ? 1 : 0;
  });

  for (const rootId of sortedRoots) {
    const entries: BeliefArcEntry[] = [];
    walkDfs(rootId, 0, entries);
    if (entries.length >= 2) {
      for (const e of entries) inArc.add(e.atom.frontmatter.id);
      const dates = entries.map((e) => e.atom.frontmatter.created_at).sort();
      const lastEntry = entries[entries.length - 1];
      arcs.push({
        entries,
        rootSlug: extractSlug(entries[0].atom.frontmatter.id),
        leafSlug: extractSlug(lastEntry.atom.frontmatter.id),
        dateRange: [dates[0], dates[dates.length - 1]],
      });
    }
  }

  // Standalone: beliefs not in any arc
  const standalone = beliefs.filter((b) => !inArc.has(b.frontmatter.id));

  return { arcs, standalone };
}

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

  // Recall with token budget — applies privacy filtering (no SECRET/PERSONAL) and token cap.
  const bundle = recall(memoryDir, { max_tokens: maxTokens });
  const active = bundle.atoms;
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

  // Bootstrap guidance when memory is empty
  if (active.length === 0) {
    lines.push('## Getting Started');
    lines.push('');
    lines.push('This is a fresh memory. No atoms have been created yet.');
    lines.push('');
    lines.push('Start building memory by retaining what matters during this session:');
    lines.push('');
    lines.push('```bash');
    lines.push('# Remember facts, decisions, preferences, beliefs');
    lines.push('mk remember "text" -d <memory-dir> -t fact --tags tag1,tag2');
    lines.push('');
    lines.push('# Re-render so the next session picks up new knowledge');
    lines.push('mk render <memory-dir> <path-to-CLAUDE.md>');
    lines.push('```');
    lines.push('');
    lines.push('Good first atoms: identity (who am I), infrastructure (what system),');
    lines.push('preferences (how the user likes to work), key decisions (architecture choices).');
    lines.push('');
    lines.push('See: https://github.com/mainion-ai/memory-kernel#cli');
    lines.push('');
    return lines.join('\n') + '\n';
  }

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
    const { arcs, standalone } = buildBeliefArcs(beliefs, memoryDir);

    if (arcs.length > 0) {
      lines.push('## Beliefs (developmental arcs)');
      lines.push('');

      for (const arc of arcs) {
        const dateStr = formatDateRange(arc.dateRange[0], arc.dateRange[1]);
        lines.push(
          `### Arc: ${arc.rootSlug} \u2192 ${arc.leafSlug} (${arc.entries.length} nodes, ${dateStr})`,
        );
        lines.push('');

        for (const { atom, depth } of arc.entries) {
          const conf =
            atom.frontmatter.confidence !== undefined
              ? ` (${atom.frontmatter.confidence})`
              : '';
          const indent = '  '.repeat(depth);
          const arrow = depth > 0 ? '\u2192 ' : '';
          lines.push(`${indent}${arrow}**${atom.frontmatter.id}**${conf}`);
          // Indent body lines to match
          const bodyLines = atom.body.trim().split('\n');
          for (const line of bodyLines) {
            lines.push(`${indent}${line}`);
          }
          lines.push('');
        }
      }

      if (standalone.length > 0) {
        lines.push('### Standalone beliefs');
        lines.push('');
        for (const b of standalone) {
          const confSuffix =
            b.frontmatter.confidence !== undefined
              ? ` (confidence: ${b.frontmatter.confidence})`
              : '';
          lines.push(`**${b.frontmatter.id}**${confSuffix}`);
          lines.push(b.body.trim());
          lines.push('');
        }
      }
    } else {
      // No arcs — preserve original flat-list format
      lines.push('## Beliefs (unverified)');
      lines.push('');
      for (const b of beliefs) {
        const confSuffix =
          b.frontmatter.confidence !== undefined
            ? ` (confidence: ${b.frontmatter.confidence})`
            : '';
        lines.push(`### ${b.frontmatter.id}${confSuffix}`);
        lines.push(b.body.trim());
        lines.push('');
      }
    }
  }

  return lines.join('\n') + '\n';
}
