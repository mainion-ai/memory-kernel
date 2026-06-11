/**
 * Render memory kernel state as a CLAUDE.md context file.
 * Used by `mk render <memory-dir> <output-path>`.
 */

import { recall, isUnvettedDraft } from './recall.js';
import { recallIsolated } from './isolation-recall.js';
import { countEvents } from './event-log.js';
import { getAllRelations } from './index-db.js';
import { isIsolated, resolveAgentDir, loadRenderConfig } from './isolation.js';
import { listAtoms } from './store.js';
import { selectAtomsWithReservations, estimateTokens } from './budget.js';
import { DEFAULT_FILL_TYPE_RESERVATIONS } from './schema.js';
import type { Atom, AtomType, RenderConfig } from './types.js';

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
  /** Token budget for recall. Default: 16000. Override via MK_RENDER_BUDGET env var. */
  maxTokens?: number;
  /** Per-type score multipliers for recall ranking. */
  typeWeights?: Partial<Record<AtomType, number>>;
  /**
   * Per-type token reservations for fill mode. Empty/undefined → use
   * DEFAULT_FILL_TYPE_RESERVATIONS from src/schema.ts.
   */
  typeReservations?: Partial<Record<AtomType, number>>;
  /** Fill mode: bypass recall(), load all active atoms sorted by recency up to budget. */
  fill?: boolean;
}

/**
 * Render active memory atoms as a CLAUDE.md markdown string.
 * Returns the rendered content — caller is responsible for writing to disk.
 */
export function renderClaudeMd(memoryDir: string, opts: RenderClaudeMdOptions = {}): string {
  const maxTokens = opts.maxTokens
    ?? (parseInt(process.env.MK_RENDER_BUDGET || '0', 10) || 16000);

  // Default to fill mode when no task/tags/scope query is provided.
  // Task-driven recall returns 0 atoms without a query — a silent footgun
  // that caused both Mai and Taj to run with empty CLAUDE.md for weeks.
  if (opts.fill !== false) {
    return renderFill(memoryDir, maxTokens, opts.typeReservations);
  }

  // Explicit fill=false: use task-driven recall (requires a query to find atoms).
  const bundle = recall(memoryDir, {
    max_tokens: maxTokens,
    type_weights: opts.typeWeights,
  });

  return renderFromAtoms(memoryDir, bundle.atoms);
}

/**
 * Fill mode: load all active atoms and route them through the two-pass
 * type-aware budget helper (`selectAtomsWithReservations`, Pass 2 = recency).
 * Does NOT require a task query — suitable for unconditional CLAUDE.md
 * renders (cron, sync).
 *
 * Per-type reservations come from `DEFAULT_FILL_TYPE_RESERVATIONS` unless
 * overridden by the caller (programmatic) or `render.yaml`'s
 * `type_reservations` field (per-agent).
 */
export function renderFill(
  memoryDir: string,
  maxTokens: number,
  typeReservations?: Partial<Record<AtomType, number>>,
): string {
  const atoms = listAtoms(memoryDir);
  const candidates = atoms.filter((a) =>
    a.frontmatter.status !== 'archived'
    && a.frontmatter.status !== 'expired'
    && a.frontmatter.status !== 'superseded'
    && !isUnvettedDraft(a.frontmatter)         // #274 Gap 1: never render unvetted auto-extracted drafts (#268)
    && a.frontmatter.classification !== 'SECRET'
    && a.frontmatter.classification !== 'PERSONAL',
  );

  // Empty object from caller (e.g. render.yaml `type_reservations: {}`) means
  // "use defaults"; explicit non-empty object means "use exactly these".
  const reservations = typeReservations && Object.keys(typeReservations).length > 0
    ? typeReservations
    : DEFAULT_FILL_TYPE_RESERVATIONS;

  const active = selectAtomsWithReservations(
    candidates,
    maxTokens,
    reservations,
    { mode: 'recency' },
  );

  const usedTokens = active.reduce(
    (s, a) => s + estimateTokens(a.body + JSON.stringify(a.frontmatter)),
    0,
  );

  const content = renderFromAtoms(memoryDir, active);
  const banner = `> Auto-generated from memory-kernel. ${active.length} of ${candidates.length} atoms, ${countEvents(memoryDir)} events. (budget ${maxTokens} tokens, used ~${usedTokens})`;
  const lines = content.split('\n');
  const bannerIdx = lines.findIndex(l => l.startsWith('> Auto-generated'));
  if (bannerIdx >= 0) {
    lines[bannerIdx] = banner;
    return lines.join('\n');
  }
  return `${banner}\n${content}`;
}

/**
 * Render CLAUDE.md for a specific agent in isolated mode.
 * Loads the agent's render.yaml config and uses recallIsolated for union recall.
 *
 * @param baseDir - Root memory directory
 * @param agentId - Agent ID
 * @param opts - Override options (take precedence over render.yaml)
 */
export function renderAgentClaudeMd(
  baseDir: string,
  agentId: string,
  opts: RenderClaudeMdOptions = {},
): string {
  const agentDir = resolveAgentDir(baseDir, agentId);
  const renderConfig = loadRenderConfig(agentDir);

  // Merge: explicit opts override render.yaml
  const maxTokens = opts.maxTokens ?? renderConfig.max_tokens;
  const typeWeights = opts.typeWeights ?? (
    Object.keys(renderConfig.type_weights).length > 0 ? renderConfig.type_weights : undefined
  );
  const typeReservations = opts.typeReservations ?? (
    Object.keys(renderConfig.type_reservations).length > 0
      ? renderConfig.type_reservations
      : undefined
  );

  if (renderConfig.include_shared && isIsolated(baseDir)) {
    // Use isolated recall (agent + shared union), then render from the merged bundle.
    // Note: this path is task-driven recall — typeReservations applies only to
    // fill mode (renderFill) and is intentionally not forwarded here.
    const bundle = recallIsolated(agentDir, baseDir, {
      max_tokens: maxTokens,
      type_weights: typeWeights,
    });

    // Render directly from the bundle's atoms (bypass recall in renderClaudeMd)
    return renderFromAtoms(agentDir, bundle.atoms);
  }

  // No shared inclusion or not isolated — use standard render.
  // Forward opts.fill so `--no-fill` reaches the inner call; otherwise the
  // opt-out semantics (`opts.fill !== false`) would silently re-enable fill.
  return renderClaudeMd(agentDir, {
    maxTokens,
    typeWeights,
    typeReservations,
    fill: opts.fill,
  });
}

/**
 * Render CLAUDE.md from a pre-fetched atom list.
 * Used by renderAgentClaudeMd when atoms come from recallIsolated.
 */
function renderFromAtoms(memoryDir: string, active: Atom[]): string {
  const eventCount = countEvents(memoryDir);

  const facts = active.filter((a) => a.frontmatter.type === 'fact');
  const decisions = active.filter((a) => a.frontmatter.type === 'decision');
  const constraints = active.filter((a) => a.frontmatter.type === 'constraint');
  const openQuestions = active.filter((a) => a.frontmatter.type === 'open_question');
  const preferences = active.filter((a) => a.frontmatter.type === 'preference');
  const beliefs = active.filter((a) => a.frontmatter.type === 'belief');
  const conflicts = active.filter((a) => a.frontmatter.type === 'conflict');
  const procedures = active.filter((a) => a.frontmatter.type === 'procedure');

  // Catch-all: any atom type not explicitly handled above (future-proofing)
  const knownTypes = new Set(['fact', 'decision', 'constraint', 'open_question', 'preference', 'belief', 'conflict', 'procedure']);
  const other = active.filter((a) => !knownTypes.has(a.frontmatter.type));

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
      const confSuffix = d.frontmatter.confidence !== undefined ? ` (confidence: ${d.frontmatter.confidence})` : '';
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

  if (procedures.length > 0) {
    lines.push('## Procedures');
    lines.push('');
    for (const p of procedures) {
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
        lines.push(`### Arc: ${arc.rootSlug} \u2192 ${arc.leafSlug} (${arc.entries.length} nodes, ${dateStr})`);
        lines.push('');
        for (const { atom, depth } of arc.entries) {
          const conf = atom.frontmatter.confidence !== undefined ? ` (${atom.frontmatter.confidence})` : '';
          const indent = '  '.repeat(depth);
          const arrow = depth > 0 ? '\u2192 ' : '';
          lines.push(`${indent}${arrow}**${atom.frontmatter.id}**${conf}`);
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
          const confSuffix = b.frontmatter.confidence !== undefined ? ` (confidence: ${b.frontmatter.confidence})` : '';
          lines.push(`**${b.frontmatter.id}**${confSuffix}`);
          lines.push(b.body.trim());
          lines.push('');
        }
      }
    } else {
      lines.push('## Beliefs (unverified)');
      lines.push('');
      for (const b of beliefs) {
        const confSuffix = b.frontmatter.confidence !== undefined ? ` (confidence: ${b.frontmatter.confidence})` : '';
        lines.push(`### ${b.frontmatter.id}${confSuffix}`);
        lines.push(b.body.trim());
        lines.push('');
      }
    }
  }

  if (other.length > 0) {
    lines.push('## Other');
    lines.push('');
    for (const o of other) {
      const confSuffix = o.frontmatter.confidence !== undefined ? ` (confidence: ${o.frontmatter.confidence})` : '';
      lines.push(`### ${o.frontmatter.id}${confSuffix}`);
      lines.push(o.body.trim());
      lines.push('');
    }
  }

  return lines.join('\n') + '\n';
}
