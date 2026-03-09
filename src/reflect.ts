/**
 * Reflect operation — consolidate, TTL/GC, promotion, dedup, conflict detection.
 * "Clean up, organize, and surface issues."
 *
 * v0.1: Deterministic only (no LLM calls). Rules-based processing.
 */

import fs from 'fs';
import path from 'path';
import { appendEvent } from './event-log.js';
import { normalizeTimestamp } from './format.js';
import { listAtoms, readAtom, writeAtom, atomFilePath, writeView, readView } from './store.js';
import type { Atom, ReflectResult } from './types.js';

export interface ReflectOptions {
  agent_id: string;
  session_id: string;
  memoryDir: string;
}

/**
 * Run a full reflect cycle.
 */
export function reflect(opts: ReflectOptions): ReflectResult {
  const result: ReflectResult = {
    deduped: 0,
    expired: 0,
    promoted: 0,
    archived: 0,
    conflicts_found: 0,
    events_emitted: 0,
  };

  const atoms = listAtoms(opts.memoryDir);

  // 1. TTL/Expiry check
  const { expired, archived } = processExpiry(opts, atoms);
  result.expired = expired;
  result.archived = archived;

  // 2. Dedup (same type + very similar ID prefix = likely duplicate)
  result.deduped = dedup(opts, atoms);

  // 3. Auto-promotion (high confidence beliefs → facts)
  result.promoted = autoPromote(opts, atoms);

  // 4. Conflict detection (same scope, contradicting statuses)
  result.conflicts_found = detectConflicts(opts, atoms);

  // 5. Regenerate views
  regenerateViews(opts);

  // Emit reflect event
  appendEvent(opts.memoryDir, 'reflect_completed', {
    agent_id: opts.agent_id,
    session_id: opts.session_id,
    meta: { ...result },
  });
  result.events_emitted++;

  return result;
}

/**
 * Process TTL expiry — archive atoms past their TTL.
 */
function processExpiry(
  opts: ReflectOptions,
  atoms: Atom[],
): { expired: number; archived: number } {
  let expired = 0;
  let archived = 0;
  const now = Date.now();

  for (const atom of atoms) {
    const fm = atom.frontmatter;
    if (fm.status === 'archived' || fm.status === 'expired') continue;
    if (fm.ttl_days === null || fm.ttl_days === undefined) continue;

    const createdAt = new Date(fm.created_at).getTime();
    const expiresAt = createdAt + fm.ttl_days * 24 * 60 * 60 * 1000;

    if (now > expiresAt && atom.filePath) {
      // Move to archive
      const archivePath = path.join(
        opts.memoryDir,
        'ARCHIVE',
        path.basename(atom.filePath),
      );
      atom.frontmatter.status = 'expired';
      atom.frontmatter.updated_at = normalizeTimestamp();
      writeAtom(atom, archivePath);

      if (fs.existsSync(atom.filePath)) {
        fs.unlinkSync(atom.filePath);
      }

      appendEvent(opts.memoryDir, 'atom_expired', {
        agent_id: opts.agent_id,
        session_id: opts.session_id,
        atom_refs: [fm.id],
      });

      expired++;
      archived++;
    }
  }

  return { expired, archived };
}

/**
 * Simple dedup: if two atoms of same type have identical body content, archive the older one.
 */
function dedup(opts: ReflectOptions, atoms: Atom[]): number {
  let count = 0;
  const seen = new Map<string, Atom>();

  for (const atom of atoms) {
    if (atom.frontmatter.status === 'archived' || atom.frontmatter.status === 'expired') continue;

    const key = `${atom.frontmatter.type}::${atom.body.trim()}`;
    const existing = seen.get(key);

    if (existing && existing.filePath && atom.filePath) {
      // Keep the newer one, archive the older
      const existingDate = new Date(existing.frontmatter.updated_at).getTime();
      const atomDate = new Date(atom.frontmatter.updated_at).getTime();

      const toArchive = existingDate < atomDate ? existing : atom;
      const toKeep = existingDate < atomDate ? atom : existing;

      if (toArchive.filePath) {
        const archivePath = path.join(
          opts.memoryDir,
          'ARCHIVE',
          path.basename(toArchive.filePath),
        );
        toArchive.frontmatter.status = 'archived';
        toArchive.frontmatter.updated_at = normalizeTimestamp();
        writeAtom(toArchive, archivePath);
        if (fs.existsSync(toArchive.filePath)) {
          fs.unlinkSync(toArchive.filePath);
        }
        count++;
      }

      seen.set(key, toKeep);
    } else {
      seen.set(key, atom);
    }
  }

  return count;
}

/**
 * Auto-promote beliefs with high confidence to facts.
 */
function autoPromote(opts: ReflectOptions, atoms: Atom[]): number {
  let count = 0;

  for (const atom of atoms) {
    if (
      atom.frontmatter.type === 'belief' &&
      atom.frontmatter.status === 'draft' &&
      atom.frontmatter.confidence >= 0.9 &&
      atom.filePath
    ) {
      atom.frontmatter.type = 'fact';
      atom.frontmatter.status = 'active';
      atom.frontmatter.updated_at = normalizeTimestamp();
      atom.frontmatter.ttl_days = null; // Facts don't expire

      writeAtom(atom, atom.filePath);

      appendEvent(opts.memoryDir, 'atom_promoted', {
        agent_id: opts.agent_id,
        session_id: opts.session_id,
        atom_refs: [atom.frontmatter.id],
        meta: { from_type: 'belief', to_type: 'fact' },
      });

      count++;
    }
  }

  return count;
}

/**
 * Detect potential conflicts: atoms of same type with overlapping scope
 * that have contradicting statuses or recently updated by different agents.
 */
function detectConflicts(_opts: ReflectOptions, atoms: Atom[]): number {
  // v0.1: Simple — just count active conflicts
  return atoms.filter(
    (a) => a.frontmatter.type === 'conflict' && a.frontmatter.status === 'active',
  ).length;
}

/**
 * Regenerate INDEX.md and other views from current atoms.
 */
function regenerateViews(opts: ReflectOptions): void {
  const atoms = listAtoms(opts.memoryDir);
  const active = atoms.filter(
    (a) => a.frontmatter.status !== 'archived' && a.frontmatter.status !== 'expired',
  );

  // Group by type
  const decisions = active.filter((a) => a.frontmatter.type === 'decision');
  const constraints = active.filter((a) => a.frontmatter.type === 'constraint');
  const openQuestions = active.filter((a) => a.frontmatter.type === 'open_question');
  const entities = active.filter((a) => a.frontmatter.type === 'entity_summary');
  const conflicts = active.filter((a) => a.frontmatter.type === 'conflict');

  // Regenerate INDEX.md
  const indexLines = [
    '---',
    'type: index',
    `updated_at: ${normalizeTimestamp()}`,
    '---',
    '',
    '# Memory Index',
    '',
    '> Routing map. Kept under 200 lines. Details in ENTITIES/ and EPISODES/.',
    '',
  ];

  if (conflicts.length > 0) {
    indexLines.push(`## ⚠ Active Conflicts (${conflicts.length})`, '');
    for (const c of conflicts) {
      indexLines.push(`- **${c.frontmatter.id}**: ${c.body.split('\n')[0]}`);
    }
    indexLines.push('');
  }

  indexLines.push(`## Decisions (${decisions.length})`, '');
  for (const d of decisions) {
    indexLines.push(`- [${d.frontmatter.status}] **${d.frontmatter.id}** (confidence: ${d.frontmatter.confidence})`);
  }
  indexLines.push('');

  indexLines.push(`## Constraints (${constraints.length})`, '');
  for (const c of constraints) {
    indexLines.push(`- **${c.frontmatter.id}**: ${c.body.split('\n')[0]}`);
  }
  indexLines.push('');

  indexLines.push(`## Open Questions (${openQuestions.length})`, '');
  for (const q of openQuestions) {
    indexLines.push(`- **${q.frontmatter.id}**: ${q.body.split('\n')[0]}`);
  }
  indexLines.push('');

  indexLines.push(`## Entities (${entities.length})`, '');
  for (const e of entities) {
    indexLines.push(`- **${e.frontmatter.id}**`);
  }
  indexLines.push('');

  writeView(opts.memoryDir, 'INDEX.md', indexLines.join('\n') + '\n');
}
