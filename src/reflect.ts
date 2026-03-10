/**
 * Reflect operation — consolidate, TTL/GC, promotion, dedup, conflict detection.
 * "Clean up, organize, and surface issues."
 *
 * v0.1: Deterministic only (no LLM calls). Rules-based processing.
 */

import fs from 'fs';
import path from 'path';
import { appendEvent, readEvents } from './event-log.js';
import { normalizeTimestamp, serializeAtom } from './format.js';
import {
  renderIndex,
  renderDecisions,
  renderConstraints,
  renderOpenQuestions,
  renderHandoff,
} from './renderers.js';
import { assertWithinDir, listAtoms, readAtom, writeAtom, atomFilePath, writeView, readView } from './store.js';
import { indexExists, indexAtom, removeFromIndex } from './index-db.js';
import type { Atom, ReflectResult } from './types.js';

export interface ReflectOptions {
  agent_id: string;
  session_id: string;
  memoryDir: string;
}

/**
 * Run a full reflect cycle.
 *
 * Uses a single `listAtoms()` call and filters the in-memory list between
 * phases, avoiding redundant filesystem scans. Views are regenerated from
 * a final disk read to capture all mutations.
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

  // Single disk read for all phases
  let atoms = listAtoms(opts.memoryDir);

  // 1. TTL/Expiry check
  const expiryResult = processExpiry(opts, atoms);
  result.expired = expiryResult.expired;
  result.archived = expiryResult.archived;

  // Filter out expired atoms for subsequent phases (avoid re-reading disk)
  if (expiryResult.expiredIds.size > 0) {
    atoms = atoms.filter((a) => !expiryResult.expiredIds.has(a.frontmatter.id));
  }

  // 2. Dedup
  const dedupResult = dedup(opts, atoms);
  result.deduped = dedupResult.count;
  result.archived += dedupResult.archivedIds.size; // dedup also archives atoms

  // Filter out deduped atoms
  if (dedupResult.archivedIds.size > 0) {
    atoms = atoms.filter((a) => !dedupResult.archivedIds.has(a.frontmatter.id));
  }

  // 3. Auto-promotion (modifies atoms in-place, no filtering needed)
  result.promoted = autoPromote(opts, atoms);

  // 4. Conflict detection
  result.conflicts_found = detectConflicts(opts, atoms);

  // 5. Regenerate views — re-read from disk for accuracy
  // (views need the absolute latest state including file renames from promotion)
  regenerateViews(opts);

  // Count per-atom events emitted by sub-phases
  // Each expired/deduped/promoted atom generates one event
  result.events_emitted = result.expired + result.deduped + result.promoted;

  // Emit reflect event
  appendEvent(opts.memoryDir, 'reflect_completed', {
    agent_id: opts.agent_id,
    session_id: opts.session_id,
    meta: { ...result },
  });
  result.events_emitted++; // +1 for reflect_completed itself

  return result;
}

/**
 * Process TTL expiry — archive atoms past their TTL.
 * Returns counts and the set of expired atom IDs (for filtering in the caller).
 */
function processExpiry(
  opts: ReflectOptions,
  atoms: Atom[],
): { expired: number; archived: number; expiredIds: Set<string> } {
  let expired = 0;
  let archived = 0;
  const expiredIds = new Set<string>();
  const now = Date.now();

  for (const atom of atoms) {
    const fm = atom.frontmatter;
    if (fm.status === 'archived' || fm.status === 'expired') continue;
    if (fm.ttl_days === null || fm.ttl_days === undefined) continue;

    const createdAt = new Date(fm.created_at).getTime();
    const expiresAt = createdAt + fm.ttl_days * 24 * 60 * 60 * 1000;

    if (now > expiresAt && atom.filePath) {
      // Validate paths before file operations
      assertWithinDir(opts.memoryDir, atom.filePath);

      // Move to archive (with traversal guard)
      const archivePath = path.join(
        opts.memoryDir,
        'ARCHIVE',
        path.basename(atom.filePath),
      );
      assertWithinDir(opts.memoryDir, archivePath);
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
        schema_version: 2,
        atom_snapshot: serializeAtom(atom),
      });

      // Keep index in sync
      if (indexExists(opts.memoryDir)) {
        removeFromIndex(opts.memoryDir, fm.id);
      }

      expiredIds.add(fm.id);
      expired++;
      archived++;
    }
  }

  return { expired, archived, expiredIds };
}

/**
 * Simple dedup: if two atoms of same type have identical body content, archive the older one.
 * Returns the count of deduped atoms and the set of archived atom IDs (for filtering in the caller).
 */
function dedup(opts: ReflectOptions, atoms: Atom[]): { count: number; archivedIds: Set<string> } {
  let count = 0;
  const archivedIds = new Set<string>();
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
        // Validate paths before file operations
        assertWithinDir(opts.memoryDir, toArchive.filePath);

        // Clone before mutation to avoid corrupting shared references
        // (critical when 3+ duplicates exist — the same atom object may
        //  appear in the `seen` map and be compared again later)
        const archiveCopy: Atom = {
          frontmatter: { ...toArchive.frontmatter },
          body: toArchive.body,
          filePath: toArchive.filePath,
        };

        const archivePath = path.join(
          opts.memoryDir,
          'ARCHIVE',
          path.basename(archiveCopy.filePath!),
        );
        assertWithinDir(opts.memoryDir, archivePath);
        archiveCopy.frontmatter.status = 'archived';
        archiveCopy.frontmatter.updated_at = normalizeTimestamp();
        writeAtom(archiveCopy, archivePath);
        if (fs.existsSync(archiveCopy.filePath!)) {
          fs.unlinkSync(archiveCopy.filePath!);
        }

        appendEvent(opts.memoryDir, 'atom_archived', {
          agent_id: opts.agent_id,
          session_id: opts.session_id,
          atom_refs: [archiveCopy.frontmatter.id],
          schema_version: 2,
          atom_snapshot: serializeAtom(archiveCopy),
          meta: { reason: 'dedup' },
        });

        // Keep index in sync
        if (indexExists(opts.memoryDir)) {
          removeFromIndex(opts.memoryDir, archiveCopy.frontmatter.id);
        }

        archivedIds.add(archiveCopy.frontmatter.id);
        count++;
      }

      seen.set(key, toKeep);
    } else {
      seen.set(key, atom);
    }
  }

  return { count, archivedIds };
}

/**
 * Auto-promote beliefs with high confidence to facts.
 * Renames the file to match the new type for consistency.
 *
 * Note: The atom ID retains its original `BELI-` prefix after promotion.
 * This is intentional — IDs are immutable identifiers that trace an atom's
 * origin. The `type` field and file path change to reflect the promotion,
 * but the ID serves as a permanent reference across event log entries.
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
      const oldPath = atom.filePath;

      atom.frontmatter.type = 'fact';
      atom.frontmatter.status = 'active';
      atom.frontmatter.updated_at = normalizeTimestamp();
      atom.frontmatter.ttl_days = null; // Facts don't expire

      // Write to new path matching the promoted type
      const newPath = atomFilePath(opts.memoryDir, atom.frontmatter.id, 'fact');
      writeAtom(atom, newPath);

      // Remove old file (if different path)
      if (oldPath !== newPath && fs.existsSync(oldPath)) {
        fs.unlinkSync(oldPath);
      }

      appendEvent(opts.memoryDir, 'atom_promoted', {
        agent_id: opts.agent_id,
        session_id: opts.session_id,
        atom_refs: [atom.frontmatter.id],
        schema_version: 2,
        atom_snapshot: serializeAtom(atom),
        meta: { from_type: 'belief', to_type: 'fact' },
      });

      // Keep index in sync (update with new type/status)
      if (indexExists(opts.memoryDir)) {
        indexAtom(opts.memoryDir, atom);
      }

      count++;
    }
  }

  return count;
}

/**
 * Detect potential conflicts: atoms of same type with overlapping scope
 * that have contradicting statuses or recently updated by different agents.
 *
 * @todo v0.2 — Implement actual conflict detection (scope overlap analysis,
 * contradicting statuses, multi-agent divergence). Currently only counts
 * pre-existing conflict atoms; does not detect or emit new conflicts.
 */
function detectConflicts(_opts: ReflectOptions, atoms: Atom[]): number {
  // v0.1: Only counts existing conflict atoms — does not detect new ones
  return atoms.filter(
    (a) => a.frontmatter.type === 'conflict' && a.frontmatter.status === 'active',
  ).length;
}

/**
 * Regenerate all views from current atoms and events.
 * Produces: INDEX.md, DECISIONS.md, CONSTRAINTS.md, OPEN_QUESTIONS.md, HANDOFF.md.
 */
function regenerateViews(opts: ReflectOptions): void {
  const atoms = listAtoms(opts.memoryDir);
  const events = readEvents(opts.memoryDir);

  writeView(opts.memoryDir, 'INDEX.md', renderIndex(atoms));
  writeView(opts.memoryDir, 'DECISIONS.md', renderDecisions(atoms));
  writeView(opts.memoryDir, 'CONSTRAINTS.md', renderConstraints(atoms));
  writeView(opts.memoryDir, 'OPEN_QUESTIONS.md', renderOpenQuestions(atoms));
  writeView(opts.memoryDir, 'HANDOFF.md', renderHandoff(atoms, events));
}
