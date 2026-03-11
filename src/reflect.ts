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
import { generateAtomId } from './schema.js';
import type { Atom, AtomType, ReflectResult } from './types.js';

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

  // 2a. Dedup by ID — two files with the same atom ID, keep newer
  const dedupByIdResult = dedupById(opts, atoms);
  result.deduped += dedupByIdResult.count;
  result.archived += dedupByIdResult.count;
  if (dedupByIdResult.archivedIds.size > 0) {
    atoms = atoms.filter((a) => !dedupByIdResult.archivedIds.has(a.frontmatter.id));
  }

  // 2b. Dedup by content — same type + body, keep newer
  const dedupResult = dedup(opts, atoms);
  result.deduped += dedupResult.count;
  result.archived += dedupResult.archivedIds.size; // dedup also archives atoms

  // Filter out deduped atoms
  if (dedupResult.archivedIds.size > 0) {
    atoms = atoms.filter((a) => !dedupResult.archivedIds.has(a.frontmatter.id));
  }

  // 3. Auto-promotion (modifies atoms in-place, no filtering needed)
  result.promoted = autoPromote(opts, atoms);

  // 4. Conflict detection
  const conflictResult = detectConflicts(opts, atoms);
  result.conflicts_found = conflictResult.total;

  // 5. Regenerate views — re-read from disk for accuracy
  // (views need the absolute latest state including file renames from promotion)
  regenerateViews(opts);

  // Count per-atom events emitted by sub-phases
  // Each expired/deduped/promoted atom generates one event; only NEW conflicts emit events
  result.events_emitted = result.expired + result.deduped + result.promoted + conflictResult.newCount;

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
 * ID dedup: if two files share the same atom ID, archive the older one.
 * This handles files created externally or via copy that bypass normal retain APIs.
 */
function dedupById(opts: ReflectOptions, atoms: Atom[]): { count: number; archivedIds: Set<string> } {
  let count = 0;
  const archivedIds = new Set<string>();
  const seen = new Map<string, Atom>(); // id → newest atom

  for (const atom of atoms) {
    if (atom.frontmatter.status === 'archived' || atom.frontmatter.status === 'expired') continue;

    const id = atom.frontmatter.id;
    const existing = seen.get(id);

    if (existing && existing.filePath && atom.filePath) {
      const existingDate = new Date(existing.frontmatter.updated_at).getTime();
      const atomDate = new Date(atom.frontmatter.updated_at).getTime();

      const toArchive = existingDate < atomDate ? existing : atom;
      const toKeep = existingDate < atomDate ? atom : existing;

      if (toArchive.filePath) {
        assertWithinDir(opts.memoryDir, toArchive.filePath);

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
          meta: { reason: 'dedup-id' },
        });

        if (indexExists(opts.memoryDir)) {
          removeFromIndex(opts.memoryDir, archiveCopy.frontmatter.id);
          indexAtom(opts.memoryDir, toKeep);
        }

        archivedIds.add(archiveCopy.frontmatter.id);
        count++;
      }

      seen.set(id, toKeep);
    } else {
      seen.set(id, atom);
    }
  }

  return { count, archivedIds };
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
 * Types eligible for conflict detection: "factual" types where contradicting
 * claims between two active atoms are meaningful.
 */
const CONFLICT_ELIGIBLE_TYPES: AtomType[] = ['fact', 'decision', 'constraint'];

/**
 * Detect potential conflicts between atoms of the same eligible type.
 *
 * Heuristic: two active atoms of the same type with overlapping scope paths
 * and significantly different confidence values (>0.3 gap) are flagged as a
 * potential conflict. This catches cases like two active "fact" atoms about
 * the same scope that disagree in certainty — a common signal of divergence.
 *
 * When a conflict is detected:
 * - A `conflict` atom is created in CONFLICTS/ (if one doesn't already exist
 *   for this pair, identified by having both atom IDs in its body).
 * - A `conflict_detected` event is emitted.
 * - The new conflict atom is indexed if the index exists.
 *
 * Returns `{ total, newCount }` where `total` is all active conflict atoms
 * (pre-existing + newly created) and `newCount` is only those created this cycle.
 */
function detectConflicts(opts: ReflectOptions, atoms: Atom[]): { total: number; newCount: number } {
  const eligible = atoms.filter(
    (a) =>
      CONFLICT_ELIGIBLE_TYPES.includes(a.frontmatter.type) &&
      a.frontmatter.status === 'active',
  );

  // Count pre-existing active conflict atoms for the total return value
  const preExistingConflicts = atoms.filter(
    (a) => a.frontmatter.type === 'conflict' && a.frontmatter.status === 'active',
  );

  // Build existing conflict bodies so we don't create duplicates
  const existingConflictBodies = new Set(preExistingConflicts.map((a) => a.body));

  let newConflicts = 0;

  // Check all pairs of active eligible atoms of the same type
  for (let i = 0; i < eligible.length; i++) {
    for (let j = i + 1; j < eligible.length; j++) {
      const a = eligible[i];
      const b = eligible[j];

      // Must be the same type
      if (a.frontmatter.type !== b.frontmatter.type) continue;

      // Must have overlapping scope paths (if both have paths)
      const aPaths = a.frontmatter.scope?.paths ?? [];
      const bPaths = b.frontmatter.scope?.paths ?? [];
      if (aPaths.length > 0 && bPaths.length > 0) {
        const overlaps = aPaths.some((ap) => bPaths.some((bp) => pathOverlaps(ap, bp)));
        if (!overlaps) continue;
      }

      // Confidence gap > 0.3 signals potential disagreement
      const confidenceGap = Math.abs(a.frontmatter.confidence - b.frontmatter.confidence);
      if (confidenceGap <= 0.3) continue;

      // Check for duplicate — if both IDs already appear in an existing conflict body, skip
      const duplicate = [...existingConflictBodies].some(
        (body) => body.includes(a.frontmatter.id) && body.includes(b.frontmatter.id),
      );
      if (duplicate) continue;

      // Create a conflict atom
      const conflictBody = [
        `## Conflict`,
        ``,
        `Two active \`${a.frontmatter.type}\` atoms in the same scope disagree in confidence.`,
        ``,
        `### Atom A`,
        `- ID: ${a.frontmatter.id}`,
        `- Confidence: ${a.frontmatter.confidence}`,
        `- Scope paths: ${aPaths.join(', ') || '(unscoped)'}`,
        ``,
        `### Atom B`,
        `- ID: ${b.frontmatter.id}`,
        `- Confidence: ${b.frontmatter.confidence}`,
        `- Scope paths: ${bPaths.join(', ') || '(unscoped)'}`,
        ``,
        `### Resolution`,
        `Review both atoms and archive or update the one that is incorrect or outdated.`,
      ].join('\n');

      const conflictId = generateAtomId('conflict', `${a.frontmatter.id}-vs-${b.frontmatter.id}`);
      const now = normalizeTimestamp();

      const conflictAtom: Atom = {
        frontmatter: {
          id: conflictId,
          type: 'conflict',
          status: 'active',
          confidence: 1.0,
          created_at: now,
          updated_at: now,
          ttl_days: null,
          classification: a.frontmatter.classification ?? b.frontmatter.classification ?? 'TEAM',
          links: { related: [a.frontmatter.id, b.frontmatter.id] },
        },
        body: conflictBody,
      };

      const conflictPath = atomFilePath(opts.memoryDir, conflictId, 'conflict');
      assertWithinDir(opts.memoryDir, conflictPath);
      writeAtom(conflictAtom, conflictPath);
      conflictAtom.filePath = conflictPath;

      appendEvent(opts.memoryDir, 'conflict_detected', {
        agent_id: opts.agent_id,
        session_id: opts.session_id,
        atom_refs: [conflictId, a.frontmatter.id, b.frontmatter.id],
        schema_version: 2,
        atom_snapshot: JSON.stringify(conflictAtom.frontmatter),
        meta: { reason: 'confidence-gap', gap: confidenceGap },
      });

      if (indexExists(opts.memoryDir)) {
        indexAtom(opts.memoryDir, conflictAtom);
      }

      existingConflictBodies.add(conflictBody);
      newConflicts++;
    }
  }

  return { total: preExistingConflicts.length + newConflicts, newCount: newConflicts };
}

/**
 * Check if two scope paths overlap (directory-boundary prefix matching).
 */
function pathOverlaps(a: string, b: string): boolean {
  if (a === b) return true;
  const aSep = a.endsWith('/') ? a : a + '/';
  const bSep = b.endsWith('/') ? b : b + '/';
  return a.startsWith(bSep) || b.startsWith(aSep);
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
