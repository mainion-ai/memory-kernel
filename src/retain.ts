/**
 * Retain operation — capture events and create/update atoms.
 * "Something meaningful happened. Remember it."
 */

import fs from 'fs';
import path from 'path';
import { appendEvent } from './event-log.js';
import { normalizeTimestamp, serializeAtom } from './format.js';
import {
  DEFAULT_TTLS,
  generateAtomId,
  validateAtomFrontmatter,
} from './schema.js';
import { assertWithinDir, atomFilePath, readAtom, writeAtom } from './store.js';
import { indexAtom, indexExists, removeFromIndex, getAllAtomIds } from './index-db.js';
import { encryptAtomWithCredential } from './crypto.js';
import { extractBodyReferences, extractConceptReferences, buildConceptMap, deduplicateRefs } from './relink.js';
import type { Atom, AtomFrontmatter, AtomStatus, AtomType, Classification, Relation } from './types.js';

/**
 * Serialize an atom snapshot, encrypting it if the atom is SECRET and a key is available.
 * Keeps the event log free of plaintext content for SECRET atoms.
 */
export function snapshotAtom(atom: Atom): string {
  const raw = serializeAtom(atom);
  if (atom.frontmatter.classification === 'SECRET') {
    const cred = process.env.MEMORY_ENCRYPTION_KEY;
    if (cred) return encryptAtomWithCredential(raw, cred);
  }
  return raw;
}

export interface RetainOptions {
  agent_id: string;
  session_id: string;
  memoryDir: string;
}

/**
 * Create a new atom and emit an event.
 */
export function createAtom(
  opts: RetainOptions & {
    type: AtomType;
    slug: string;
    body: string;
    confidence?: number;
    ttl_days?: number | null;
    classification?: Classification;
    scope?: AtomFrontmatter['scope'];
    provenance?: AtomFrontmatter['provenance'];
    links?: AtomFrontmatter['links'];
    relations?: Relation[];
    status?: AtomStatus;
  },
): Atom {
  const now = normalizeTimestamp();
  const id = generateAtomId(opts.type, opts.slug);

  const frontmatter: AtomFrontmatter = {
    id,
    type: opts.type,
    status: opts.status ?? (opts.type === 'belief' ? 'draft' : 'active'),
    confidence: opts.confidence ?? (opts.type === 'belief' ? 0.5 : 0.8),
    created_at: now,
    updated_at: now,
    ttl_days: opts.ttl_days !== undefined ? opts.ttl_days : (DEFAULT_TTLS[opts.type] ?? null),
    scope: opts.scope,
    classification: opts.classification ?? 'TEAM',
    provenance: opts.provenance,
    links: opts.links,
    relations: opts.relations,
  };

  // Validate
  const result = validateAtomFrontmatter(frontmatter);
  if (!result.success) {
    throw new Error(
      `Invalid atom frontmatter: ${JSON.stringify(result.error.issues)}`,
    );
  }

  const atom: Atom = {
    frontmatter,
    body: opts.body,
  };
  const fp = atomFilePath(opts.memoryDir, id, opts.type);

  // Auto-relink BEFORE event emission so the snapshot captures extracted
  // relations. Skips if the caller already provided explicit relations.
  // Querying the index here is safe — it only contains OTHER atoms (this one
  // hasn't been indexed yet), and self-references are filtered by `id`.
  if (!opts.relations?.length) {
    const knownIds = getAllAtomIds(opts.memoryDir);
    const idRefs = extractBodyReferences(atom.body, id, knownIds);

    // Concept-name references: build map from atom IDs (cheap SQLite query)
    const conceptMap = buildConceptMap(knownIds);
    const conceptRefs = extractConceptReferences(atom.body, id, conceptMap);

    // Merge and deduplicate (atom-ID refs take priority since they come first)
    const allRefs = deduplicateRefs([...idRefs, ...conceptRefs]);

    if (allRefs.length > 0) {
      atom.frontmatter.relations = [
        ...(atom.frontmatter.relations ?? []),
        ...allRefs.map((r) => ({ target: r.targetId, type: r.type })),
      ];
    }
  }

  // Event-first (#84): emit the v2 event with full snapshot BEFORE mutating
  // disk/index. On crash between this point and the mutation steps, replay
  // can reconstruct the atom from the event-log snapshot.
  appendEvent(opts.memoryDir, 'atom_created', {
    agent_id: opts.agent_id,
    session_id: opts.session_id,
    atom_refs: [id],
    touched_paths: opts.scope?.paths,
    schema_version: 2,
    atom_snapshot: snapshotAtom(atom),
  });

  // Mutation: write file, then index. openIndex() creates the DB on demand.
  writeAtom(atom, fp);
  atom.filePath = fp;
  indexAtom(opts.memoryDir, atom);

  return atom;
}

/**
 * Update an existing atom's body and/or frontmatter fields.
 */
export function updateAtom(
  opts: RetainOptions & {
    filePath: string;
    updates: Partial<Pick<AtomFrontmatter, 'status' | 'confidence' | 'scope' | 'links' | 'provenance' | 'relations'>>;
    body?: string;
  },
): Atom {
  assertWithinDir(opts.memoryDir, opts.filePath);

  // Early return if nothing to change
  const hasUpdates = Object.keys(opts.updates).length > 0;
  if (!hasUpdates && opts.body === undefined) {
    return readAtom(opts.filePath);
  }

  const atom = readAtom(opts.filePath);
  const now = normalizeTimestamp();

  // Apply updates (use 'in' checks to allow clearing optional fields with undefined)
  if (opts.updates.status !== undefined) atom.frontmatter.status = opts.updates.status;
  if (opts.updates.confidence !== undefined)
    atom.frontmatter.confidence = opts.updates.confidence;
  if ('scope' in opts.updates) atom.frontmatter.scope = opts.updates.scope;
  if ('links' in opts.updates) atom.frontmatter.links = opts.updates.links;
  if ('provenance' in opts.updates)
    atom.frontmatter.provenance = opts.updates.provenance;
  if ('relations' in opts.updates) atom.frontmatter.relations = opts.updates.relations;
  if (opts.body !== undefined) atom.body = opts.body;

  atom.frontmatter.updated_at = now;

  // Validate
  const result = validateAtomFrontmatter(atom.frontmatter);
  if (!result.success) {
    throw new Error(
      `Invalid atom frontmatter after update: ${JSON.stringify(result.error.issues)}`,
    );
  }

  // Event-first (#84): durable record before disk/index mutation.
  appendEvent(opts.memoryDir, 'atom_updated', {
    agent_id: opts.agent_id,
    session_id: opts.session_id,
    atom_refs: [atom.frontmatter.id],
    touched_paths: atom.frontmatter.scope?.paths,
    schema_version: 2,
    atom_snapshot: snapshotAtom(atom),
  });

  // Mutation: write file, then keep index in sync if it exists.
  writeAtom(atom, opts.filePath);
  if (indexExists(opts.memoryDir)) {
    indexAtom(opts.memoryDir, atom);
  }

  return atom;
}

export interface ResolveConflictOptions extends RetainOptions {
  filePath: string;
  resolutionNote?: string;
}

export interface ResolveConflictResult {
  atom: Atom;
  event_id: string;
}

/**
 * Resolve a conflict atom — set status to 'resolved', archive it, emit conflict_resolved event.
 * Idempotent: already-archived atoms return early.
 */
export function resolveConflict(opts: ResolveConflictOptions): ResolveConflictResult {
  assertWithinDir(opts.memoryDir, opts.filePath);
  const atom = readAtom(opts.filePath);

  if (atom.frontmatter.type !== 'conflict') {
    throw new Error(`Atom is not a conflict type: ${atom.frontmatter.id}`);
  }

  // Idempotent: already archived
  if (atom.frontmatter.status === 'archived') {
    return { atom, event_id: '' };
  }

  atom.frontmatter.status = 'resolved';
  atom.frontmatter.updated_at = normalizeTimestamp();
  if (opts.resolutionNote) {
    atom.body = `${atom.body}\n\n### Resolution Note\n\n${opts.resolutionNote}`;
  }

  const archivePath = path.join(
    opts.memoryDir,
    'ARCHIVE',
    path.basename(opts.filePath),
  );
  assertWithinDir(opts.memoryDir, archivePath);

  // Event-first (#84): emit the conflict_resolved event with full snapshot
  // BEFORE moving/deleting files. On crash the event log alone is enough.
  const event = appendEvent(opts.memoryDir, 'conflict_resolved', {
    agent_id: opts.agent_id,
    session_id: opts.session_id,
    atom_refs: [atom.frontmatter.id],
    schema_version: 2,
    atom_snapshot: snapshotAtom(atom),
    meta: opts.resolutionNote ? { resolution_note: opts.resolutionNote } : undefined,
  });

  // Mutation: write archive copy, unlink source, drop from index.
  writeAtom(atom, archivePath);
  if (fs.existsSync(opts.filePath)) fs.unlinkSync(opts.filePath);
  if (indexExists(opts.memoryDir)) {
    removeFromIndex(opts.memoryDir, atom.frontmatter.id);
  }

  return { atom, event_id: event.event_id };
}

/**
 * Archive an atom (move to ARCHIVE/, emit event).
 */
export function archiveAtom(
  opts: RetainOptions & { filePath: string },
): Atom {
  assertWithinDir(opts.memoryDir, opts.filePath);
  const atom = readAtom(opts.filePath);

  // Guard: already archived — idempotent no-op to prevent data loss
  // (writing to ARCHIVE/ then unlinking the same path would delete the atom)
  if (atom.frontmatter.status === 'archived') {
    return atom;
  }

  atom.frontmatter.status = 'archived';
  atom.frontmatter.updated_at = normalizeTimestamp();

  // Write to archive location (with traversal guard)
  const archivePath = path.join(
    opts.memoryDir,
    'ARCHIVE',
    path.basename(opts.filePath),
  );
  assertWithinDir(opts.memoryDir, archivePath);

  // Event-first (#84): the previous order unlinkSync'd the source BEFORE the
  // event was appended. A crash there destroyed atom data with no replay
  // path. Now: emit the event (with full snapshot) first, then mutate disk.
  appendEvent(opts.memoryDir, 'atom_archived', {
    agent_id: opts.agent_id,
    session_id: opts.session_id,
    atom_refs: [atom.frontmatter.id],
    schema_version: 2,
    atom_snapshot: snapshotAtom(atom),
  });

  // Mutation: write archive copy, unlink source, drop from index.
  writeAtom(atom, archivePath);
  if (fs.existsSync(opts.filePath)) {
    fs.unlinkSync(opts.filePath);
  }
  if (indexExists(opts.memoryDir)) {
    removeFromIndex(opts.memoryDir, atom.frontmatter.id);
  }

  return atom;
}
