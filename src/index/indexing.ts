/**
 * Atoms-table indexing: write ops (reindex / indexAtom / removeFromIndex) and the
 * core read/query ops (queryIndex / indexStats / getAllAtomIds) (#368).
 * All handles come from the shared connection cache in `./connection.js`.
 *
 * `entity_triples` (#75) is LLM-extracted at atom-write time and is NOT serialized
 * into the atom markdown body, so it has no source in the markdown to rebuild
 * from. Its durable source of truth is the `triples.ndjson` sidecar
 * (`src/triples-sidecar.ts`, #370): `insertTriples` mirrors every row there, and
 * `reindex()` rebuilds the table from it — so deleting `.memory-index.db` no
 * longer loses triples. Within a single reindex the existing rows are still
 * snapshotted into a `_saved_triples` TEMP table for speed; the sidecar is then
 * reconciled to match (and recovered from when the snapshot is empty because the
 * DB was deleted). See `reindex()`. The project-wide invariant lives in
 * `docs/invariants.md`.
 */

import type { Atom, AtomType, AtomStatus, Classification, RecallQuery, EntityTriple } from '../types.js';
import { AUTO_EXTRACTED_TAG } from '../types.js';
import { listAtoms } from '../store.js';
import { listEpisodes } from '../episodes.js';
import { readTriplesSidecar, writeTriplesSidecar } from '../triples-sidecar.js';
import { openIndex, closeIndex, indexExists } from './connection.js';

/**
 * Simple hash for change detection (not cryptographic).
 */
function bodyHash(body: string): string {
  let hash = 0;
  for (let i = 0; i < body.length; i++) {
    const ch = body.charCodeAt(i);
    hash = ((hash << 5) - hash + ch) | 0;
  }
  return hash.toString(36);
}

/**
 * Extract a short title from atom body markdown for FTS indexing.
 * Prefers the text of the first H1/H2 heading; falls back to first 80 chars stripped of markdown.
 */
function extractTitle(body: string): string {
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    const match = trimmed.match(/^#{1,2}\s+(.+)/);
    if (match) return match[1].trim();
    if (trimmed.length > 0) {
      // First non-empty non-heading line — strip markdown syntax
      return trimmed.replace(/[*_`#[\]]/g, '').slice(0, 80);
    }
  }
  return '';
}

// --- Index operations ---

/**
 * Rebuild the entire index from files. Drops existing data.
 */
export function reindex(memoryDir: string): { indexed: number; timeMs: number } {
  const start = Date.now();
  // Close cached connection before reindex to ensure clean state
  closeIndex(memoryDir);
  const db = openIndex(memoryDir);

  const atoms = listAtoms(memoryDir);

  const tx = db.transaction(() => {
    // Preserve embeddings across reindex — they are expensive to recompute (API calls).
    // Save to temp table before clearing atoms (FK cascade would wipe them).
    db.exec('CREATE TEMP TABLE IF NOT EXISTS _saved_embeddings AS SELECT * FROM atom_embeddings');
    // Snapshot entity triples for the in-reindex restore (fast path). Their
    // durable source of truth is the triples.ndjson sidecar (#370); this temp
    // table just avoids re-reading the sidecar when the table is already intact.
    // The sidecar is reconciled/recovered after the transaction (see below).
    db.exec('CREATE TEMP TABLE IF NOT EXISTS _saved_triples AS SELECT * FROM entity_triples');

    // Disable FK enforcement during the batch delete so that the explicit DELETE FROM
    // atom_relations (below) isn't redundantly cascade-fired again when atoms are deleted.
    // Re-enabled in finally to ensure the connection is never left with FKs off on error.
    db.pragma('foreign_keys = OFF');
    try {
      // Clear existing data
      db.exec('DELETE FROM entity_triples');
      db.exec('DELETE FROM atom_citations');
      db.exec('DELETE FROM atom_relations');
      db.exec('DELETE FROM episode_fts');
      db.exec('DELETE FROM atom_fts');
      db.exec('DELETE FROM atom_paths');
      db.exec('DELETE FROM atom_tags');
      db.exec('DELETE FROM atoms'); // atom_embeddings cascade-deleted once FKs re-enabled
    } finally {
      db.pragma('foreign_keys = ON');
    }

    const insertAtom = db.prepare(`
      INSERT OR REPLACE INTO atoms (atom_id, type, status, confidence, classification, created_at, updated_at, ttl_days, file_path, body_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertTag = db.prepare(`
      INSERT OR IGNORE INTO atom_tags (atom_id, tag) VALUES (?, ?)
    `);

    const insertPath = db.prepare(`
      INSERT OR IGNORE INTO atom_paths (atom_id, path) VALUES (?, ?)
    `);

    const insertFts = db.prepare(
      'INSERT INTO atom_fts(atom_id, title, body) VALUES (?, ?, ?)',
    );

    const insertRelation = db.prepare(`
      INSERT OR IGNORE INTO atom_relations (source_id, target_id, relation_type)
      VALUES (?, ?, ?)
    `);

    for (const atom of atoms) {
      const fm = atom.frontmatter;

      insertAtom.run(
        fm.id,
        fm.type,
        fm.status,
        fm.confidence,
        fm.classification ?? null,
        fm.created_at,
        fm.updated_at,
        fm.ttl_days,
        atom.filePath ?? '',
        bodyHash(atom.body),
      );

      // Index tags
      if (fm.scope?.tags) {
        for (const tag of fm.scope.tags) {
          insertTag.run(fm.id, tag);
        }
      }

      // Index paths
      if (fm.scope?.paths) {
        for (const p of fm.scope.paths) {
          insertPath.run(fm.id, p);
        }
      }

      // FTS index
      insertFts.run(fm.id, extractTitle(atom.body), atom.body);
    }

    // Second pass: insert all relations (all atoms are now indexed, so FK targets exist)
    for (const atom of atoms) {
      const fm = atom.frontmatter;
      if (fm.relations && fm.relations.length > 0) {
        for (const rel of fm.relations) {
          try {
            insertRelation.run(fm.id, rel.target, rel.type);
          } catch {
            // Target atom not in this reindex batch — silently skip
          }
        }
      }
    }

    // Index episodes into episode_fts
    const insertEpisodeFts = db.prepare(
      'INSERT INTO episode_fts(episode_id, body) VALUES (?, ?)',
    );
    const episodes = listEpisodes(memoryDir);
    for (const ep of episodes) {
      insertEpisodeFts.run(ep.id, ep.summary);
    }

    // Restore preserved embeddings (only for atoms that still exist).
    // Include `normalized` so PR-11's unit-norm flag survives a reindex —
    // otherwise every row reverts to DEFAULT 0 and the next getAllEmbeddings
    // re-runs the lazy migration unnecessarily.
    db.exec(`
      INSERT OR IGNORE INTO atom_embeddings (atom_id, embedding, model, dimensions, body_hash, normalized)
      SELECT atom_id, embedding, model, dimensions, body_hash, normalized
      FROM _saved_embeddings
      WHERE atom_id IN (SELECT atom_id FROM atoms)
    `);
    db.exec('DROP TABLE IF EXISTS _saved_embeddings');

    // Restore preserved triples (only for atoms that still exist — orphans are dropped)
    db.exec(`
      INSERT INTO entity_triples (atom_id, subject, predicate, object, confidence, created_at)
      SELECT atom_id, subject, predicate, object, confidence, created_at
      FROM _saved_triples
      WHERE atom_id IN (SELECT atom_id FROM atoms)
    `);
    db.exec('DROP TABLE IF EXISTS _saved_triples');
  });

  tx();

  // #370/#379 — reconcile the durable triples sidecar with the rebuilt table as
  // a UNION over still-existing atoms, not all-or-nothing. After the transaction
  // entity_triples holds triples only for atoms that still exist (restored from
  // the in-DB snapshot). The sidecar is the durable source of truth, so the
  // rebuilt table may legitimately be a SUBSET of it — e.g. partial DB row
  // loss/corruption, or an atom file transiently missing during the snapshot
  // restore. Gating recovery on an empty table (the original #370 behaviour)
  // skipped recovery in that case AND truncated the sidecar to the smaller table
  // set — silent loss from the layer we promised is durable.
  //
  // Now: take the union of (table rows) ∪ (sidecar rows for existing atoms),
  // deduped by (atom_id, subject, predicate, object) keeping the earliest
  // created_at, and rewrite BOTH stores to that deduped union. Orphans are pruned
  // by the existingIds filter; latent duplicates (append-only sidecar + no UNIQUE
  // on entity_triples) collapse. This is safe because there is no intentional
  // per-atom triple deletion anywhere — the only removal is FK ON DELETE CASCADE
  // when an atom is deleted, already handled by the existingIds filter — so
  // unioning never resurrects intentionally-removed data.
  const existingIds = new Set(
    (db.prepare('SELECT atom_id FROM atoms').all() as { atom_id: string }[]).map((r) => r.atom_id),
  );
  const tableRows = db
    .prepare('SELECT atom_id, subject, predicate, object, confidence, created_at FROM entity_triples')
    .all() as EntityTriple[];
  const sidecarRows = readTriplesSidecar(memoryDir).filter((r) => existingIds.has(r.atom_id));

  const tripleKey = (r: EntityTriple) => JSON.stringify([r.atom_id, r.subject, r.predicate, r.object]);
  const union = new Map<string, EntityTriple>();
  for (const r of [...tableRows, ...sidecarRows]) {
    const k = tripleKey(r);
    const prev = union.get(k);
    // Deterministic collision resolution: keep the earliest created_at.
    if (!prev || r.created_at < prev.created_at) union.set(k, r);
  }
  const reconciled = [...union.values()];

  // Rewrite the table to exactly the deduped union (delete + reinsert) so the
  // table, the sidecar, and the union all agree and any duplicates are collapsed.
  const rewriteTx = db.transaction((rows: EntityTriple[]) => {
    db.exec('DELETE FROM entity_triples');
    const ins = db.prepare(
      `INSERT INTO entity_triples (atom_id, subject, predicate, object, confidence, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const r of rows) {
      ins.run(r.atom_id, r.subject, r.predicate, r.object, r.confidence, r.created_at);
    }
  });
  rewriteTx(reconciled);
  writeTriplesSidecar(memoryDir, reconciled);

  const timeMs = Date.now() - start;
  return { indexed: atoms.length, timeMs };
}

/**
 * Upsert a single atom into the index.
 * Call after createAtom/updateAtom.
 */
export function indexAtom(memoryDir: string, atom: Atom): void {
  const db = openIndex(memoryDir);
  const fm = atom.frontmatter;

  const tx = db.transaction(() => {
    // Remove old data for this atom (FTS first, relations second)
    db.prepare('DELETE FROM atom_fts WHERE atom_id = ?').run(fm.id);
    db.prepare('DELETE FROM atom_tags WHERE atom_id = ?').run(fm.id);
    db.prepare('DELETE FROM atom_paths WHERE atom_id = ?').run(fm.id);
    db.prepare('DELETE FROM atom_relations WHERE source_id = ?').run(fm.id);

    db.prepare(`
      INSERT OR REPLACE INTO atoms (atom_id, type, status, confidence, classification, created_at, updated_at, ttl_days, file_path, body_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      fm.id,
      fm.type,
      fm.status,
      fm.confidence,
      fm.classification ?? null,
      fm.created_at,
      fm.updated_at,
      fm.ttl_days,
      atom.filePath ?? '',
      bodyHash(atom.body),
    );

    if (fm.scope?.tags) {
      const insertTag = db.prepare('INSERT OR IGNORE INTO atom_tags (atom_id, tag) VALUES (?, ?)');
      for (const tag of fm.scope.tags) {
        insertTag.run(fm.id, tag);
      }
    }

    if (fm.scope?.paths) {
      const insertPath = db.prepare('INSERT OR IGNORE INTO atom_paths (atom_id, path) VALUES (?, ?)');
      for (const p of fm.scope.paths) {
        insertPath.run(fm.id, p);
      }
    }

    // FTS index — upsert (delete above, insert fresh)
    db.prepare('INSERT INTO atom_fts(atom_id, title, body) VALUES (?, ?, ?)').run(
      fm.id,
      extractTitle(atom.body),
      atom.body,
    );

    // Relations — insert outbound edges; skip target-not-found FK errors silently
    if (fm.relations && fm.relations.length > 0) {
      const insertRelation = db.prepare(`
        INSERT OR IGNORE INTO atom_relations (source_id, target_id, relation_type)
        VALUES (?, ?, ?)
      `);
      for (const rel of fm.relations) {
        try {
          insertRelation.run(fm.id, rel.target, rel.type);
        } catch {
          // Target atom not yet indexed — silently skip; reindex will fix
        }
      }
    }
  });

  tx();
}

/**
 * Remove an atom from the index (after archive/delete).
 */
export function removeFromIndex(memoryDir: string, atomId: string): void {
  const db = openIndex(memoryDir);
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM atoms WHERE atom_id = ?').run(atomId);
    db.prepare('DELETE FROM atom_fts WHERE atom_id = ?').run(atomId);
    db.prepare('DELETE FROM atom_embeddings WHERE atom_id = ?').run(atomId);
    // atom_tags and atom_paths cascade-deleted via FK on atoms table
  });
  tx();
}

// --- Query interface ---

export interface IndexQueryResult {
  atom_id: string;
  type: AtomType;
  status: AtomStatus;
  confidence: number;
  classification: Classification | null;
  created_at: string;
  updated_at: string;
  ttl_days: number | null;
  file_path: string;
}

/**
 * Query atoms from the index using RecallQuery filters.
 * Returns matching atom IDs and metadata — caller loads full atoms from files.
 *
 * Falls back to null if index doesn't exist (caller should use listAtoms).
 */
export function queryIndex(memoryDir: string, query: RecallQuery = {}, opts?: { limit?: number }): IndexQueryResult[] | null {
  if (!indexExists(memoryDir)) return null;

  const db = openIndex(memoryDir);
  const conditions: string[] = [];
  const params: unknown[] = [];

    // Exclude archived/expired/superseded by default — only when no explicit status filter is given
    if (!query.statuses || query.statuses.length === 0) {
      conditions.push("a.status NOT IN ('archived', 'expired', 'superseded')");
      // Auto-extracted drafts (session-end extract output, #268 — tagged
      // `auto-extracted` by mk extract) are unvetted — exclude from the
      // candidate pool by default so they can't enter live context before
      // reflect promotes them (#274 Gap 1). Scoped to the auto-extracted tag,
      // NOT all drafts, so hand-authored draft beliefs still surface. Opt in
      // via include_drafts; an explicit `statuses` filter (below) still surfaces
      // them. Mirrors the file-scan path in recall.ts filterAtoms.
      if (!query.include_drafts) {
        // AUTO_EXTRACTED_TAG is a trusted compile-time constant (no injection risk).
        conditions.push(
          `NOT (a.status = 'draft' AND a.atom_id IN (SELECT atom_id FROM atom_tags WHERE tag = '${AUTO_EXTRACTED_TAG}'))`,
        );
      }
    }

    // Exclude SECRET and PERSONAL by default
    conditions.push("(a.classification IS NULL OR a.classification NOT IN ('SECRET', 'PERSONAL'))");

    // Filter by type
    if (query.types && query.types.length > 0) {
      const placeholders = query.types.map(() => '?').join(', ');
      conditions.push(`a.type IN (${placeholders})`);
      params.push(...query.types);
    }

    // Filter by status (explicit filter overrides the default exclusion above)
    if (query.statuses && query.statuses.length > 0) {
      const placeholders = query.statuses.map(() => '?').join(', ');
      conditions.push(`a.status IN (${placeholders})`);
      params.push(...query.statuses);
    }

    // Filter by tags (any match)
    if (query.tags && query.tags.length > 0) {
      const placeholders = query.tags.map(() => '?').join(', ');
      conditions.push(`a.atom_id IN (SELECT atom_id FROM atom_tags WHERE tag IN (${placeholders}))`);
      params.push(...query.tags);
    }

    // Filter by paths (prefix overlap using separator-boundary matching)
    if (query.paths && query.paths.length > 0) {
      // First arm: atom path starts with query path (LIKE with escaped wildcards)
      // Second arm: query path starts with atom path (INSTR-based, avoids unescaped column as LIKE pattern)
      // Boundary-aware prefix matching (mirrors pathOverlaps() in recall.ts):
      //   Arm 1: atom path starts with query path + '/' (directory boundary)
      //   Arm 2: exact match
      //   Arm 3: query path starts with atom path + '/' (reverse containment)
      // This prevents 'src/comp' from matching 'src/components/Button'.
      const pathConditions = query.paths.map(() =>
        `a.atom_id IN (SELECT atom_id FROM atom_paths WHERE path = ? OR path LIKE ? || '/%' ESCAPE '\\' OR INSTR(? || '/', path || '/') = 1)`,
      );
      // Unscoped atoms (no paths) always match
      conditions.push(
        `(a.atom_id NOT IN (SELECT atom_id FROM atom_paths) OR ${pathConditions.join(' OR ')})`,
      );
      for (const p of query.paths) {
        // Escape LIKE wildcards in path values (only for the LIKE arm)
        const escaped = p.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
        params.push(p, escaped, p);
      }
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const sql = `
      SELECT a.atom_id, a.type, a.status, a.confidence, a.classification,
             a.created_at, a.updated_at, a.ttl_days, a.file_path
      FROM atoms a
      ${where}
      ORDER BY
        CASE a.status
          WHEN 'active' THEN 0
          WHEN 'draft' THEN 1
          WHEN 'accepted' THEN 2
          WHEN 'resolved' THEN 3
          WHEN 'rejected' THEN 4
          WHEN 'superseded' THEN 5
          WHEN 'archived' THEN 6
          WHEN 'expired' THEN 7
          ELSE 99
        END,
        a.updated_at DESC
    ${(opts?.limit != null && Number.isFinite(opts.limit) && opts.limit > 0) ? `LIMIT ${Math.floor(opts.limit)}` : ''}
    `;

  return db.prepare(sql).all(...params) as IndexQueryResult[];
}

/**
 * Get index stats.
 */
export function indexStats(memoryDir: string): { atoms: number; tags: number; paths: number; embeddings: number; relations: number; citations: number } | null {
  if (!indexExists(memoryDir)) return null;

  const db = openIndex(memoryDir);
  const atoms = (db.prepare('SELECT COUNT(*) as c FROM atoms').get() as { c: number }).c;
  const tags = (db.prepare('SELECT COUNT(*) as c FROM atom_tags').get() as { c: number }).c;
  const paths = (db.prepare('SELECT COUNT(*) as c FROM atom_paths').get() as { c: number }).c;
  let embeddings = 0;
  try {
    embeddings = (db.prepare('SELECT COUNT(*) as c FROM atom_embeddings').get() as { c: number }).c;
  } catch { /* table may not exist in older schema */ }
  let relations = 0;
  try {
    relations = (db.prepare('SELECT COUNT(*) as c FROM atom_relations').get() as { c: number }).c;
  } catch { /* table may not exist in older schema */ }
  let citations = 0;
  try {
    citations = (db.prepare('SELECT COUNT(*) as c FROM atom_citations').get() as { c: number }).c;
  } catch { /* table may not exist in older schema */ }
  return { atoms, tags, paths, embeddings, relations, citations };
}

/**
 * Return all atom IDs from the index. Fast: single SQL query.
 */
export function getAllAtomIds(memoryDir: string): Set<string> {
  if (!indexExists(memoryDir)) return new Set();
  try {
    const db = openIndex(memoryDir);
    const rows = db.prepare('SELECT atom_id FROM atoms').all() as { atom_id: string }[];
    return new Set(rows.map((r) => r.atom_id));
  } catch {
    return new Set();
  }
}
