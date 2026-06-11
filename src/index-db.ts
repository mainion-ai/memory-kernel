/**
 * SQLite index for fast atom lookups.
 *
 * Files remain the source of truth for most of this index — it is a derived
 * cache. If the index is stale or missing, fall back to file scan (listAtoms).
 * Rebuild with `mk reindex`.
 *
 * Exception: `entity_triples` (#75, Tier-1 semantic conflict detection) is
 * LLM-extracted at atom-write time and is NOT serialized into the atom
 * markdown body, so reindex has no on-disk source to rebuild it from. The
 * reindex routine preserves triples by snapshotting the existing
 * `entity_triples` rows into a `_saved_triples` TEMP table, rebuilding the
 * schema, and restoring the snapshot at the end (see `reindex()` below).
 * Embeddings (`atom_embeddings`) are preserved the same way for a different
 * reason: they are derivable from atom bodies but expensive to recompute.
 *
 * Failure mode: deleting `.memory-index.db` (the only way to force a
 * from-scratch rebuild today — there is no `mk reindex --force`) discards
 * entity triples permanently for any atom that has not since been
 * re-extracted.
 *
 * The project-wide statement of this invariant (files are truth, index is
 * derived cache, `entity_triples` is the exception) lives in
 * `docs/invariants.md`. Update both this header and that document together.
 */

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import type { Atom, AtomType, AtomStatus, Classification, RecallQuery } from './types.js';
import { AUTO_EXTRACTED_TAG } from './types.js';
import { listAtoms } from './store.js';
import { listEpisodes } from './episodes.js';

const DB_FILENAME = '.memory-index.db';
const SCHEMA_VERSION = 8; // Bump when schema changes to trigger auto-rebuild

// --- Schema ---

const CREATE_ATOMS_TABLE = `
CREATE TABLE IF NOT EXISTS atoms (
  atom_id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  confidence REAL NOT NULL,
  classification TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  ttl_days INTEGER,
  file_path TEXT NOT NULL,
  body_hash TEXT NOT NULL
)`;

const CREATE_TAGS_TABLE = `
CREATE TABLE IF NOT EXISTS atom_tags (
  atom_id TEXT NOT NULL,
  tag TEXT NOT NULL,
  PRIMARY KEY (atom_id, tag),
  FOREIGN KEY (atom_id) REFERENCES atoms(atom_id) ON DELETE CASCADE
)`;

const CREATE_PATHS_TABLE = `
CREATE TABLE IF NOT EXISTS atom_paths (
  atom_id TEXT NOT NULL,
  path TEXT NOT NULL,
  PRIMARY KEY (atom_id, path),
  FOREIGN KEY (atom_id) REFERENCES atoms(atom_id) ON DELETE CASCADE
)`;

const CREATE_INDEXES = [
  'CREATE INDEX IF NOT EXISTS idx_atoms_type ON atoms(type)',
  'CREATE INDEX IF NOT EXISTS idx_atoms_status ON atoms(status)',
  'CREATE INDEX IF NOT EXISTS idx_atoms_confidence ON atoms(confidence)',
  'CREATE INDEX IF NOT EXISTS idx_atoms_updated ON atoms(updated_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_tags_tag ON atom_tags(tag)',
  'CREATE INDEX IF NOT EXISTS idx_paths_path ON atom_paths(path)',
];

// FTS5 virtual table for full-text search over atom title + body.
// Stores its own content (no content= param) so standard DELETE works.
// porter tokenizer enables stemming (run/runs/running all match).
const CREATE_FTS_TABLE = `
CREATE VIRTUAL TABLE IF NOT EXISTS atom_fts USING fts5(
  atom_id UNINDEXED,
  title,
  body,
  tokenize='porter unicode61'
)`;

// FTS5 virtual table for full-text search over episode summaries.
// Same tokenizer as atom_fts (porter stemming + unicode61).
const CREATE_EPISODE_FTS_TABLE = `
CREATE VIRTUAL TABLE IF NOT EXISTS episode_fts USING fts5(
  episode_id UNINDEXED,
  body,
  tokenize='porter unicode61'
)`;

// Embeddings table for semantic search (KNN via cosine similarity).
// Vectors stored as BLOBs (Float32Array). Provider/model tracked for cache invalidation.
const CREATE_EMBEDDINGS_TABLE = `
CREATE TABLE IF NOT EXISTS atom_embeddings (
  atom_id TEXT PRIMARY KEY,
  embedding BLOB NOT NULL,
  model TEXT NOT NULL,
  dimensions INTEGER NOT NULL,
  body_hash TEXT NOT NULL,
  FOREIGN KEY (atom_id) REFERENCES atoms(atom_id) ON DELETE CASCADE
)`;

// Relations table for typed graph edges between atoms (Phase 3).
// Both FKs use ON DELETE CASCADE:
//   source deleted → its outbound edges are removed (atom no longer exists as a source)
//   target deleted → inbound edges pointing to it are removed (broken refs cleaned up)
const CREATE_RELATIONS_TABLE = `
CREATE TABLE IF NOT EXISTS atom_relations (
  source_id     TEXT NOT NULL,
  target_id     TEXT NOT NULL,
  relation_type TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (source_id, target_id, relation_type),
  FOREIGN KEY (source_id) REFERENCES atoms(atom_id) ON DELETE CASCADE,
  FOREIGN KEY (target_id) REFERENCES atoms(atom_id) ON DELETE CASCADE
)`;

const CREATE_RELATIONS_INDEXES = [
  'CREATE INDEX IF NOT EXISTS idx_relations_target ON atom_relations(target_id)',
  'CREATE INDEX IF NOT EXISTS idx_relations_type ON atom_relations(relation_type)',
];

// Entity-triple table for Tier-1 semantic conflict detection (#75).
// Each row is a (subject, predicate, object) triple extracted from an atom body
// at ingestion time. Conflict detection queries: same (subject, predicate),
// different object → candidate conflict (then Tier 2 LLM confirms).
// Strings are stored lower-cased for case-insensitive matching.
const CREATE_TRIPLES_TABLE = `
CREATE TABLE IF NOT EXISTS entity_triples (
  triple_id   INTEGER PRIMARY KEY AUTOINCREMENT,
  atom_id     TEXT NOT NULL,
  subject     TEXT NOT NULL,
  predicate   TEXT NOT NULL,
  object      TEXT NOT NULL,
  confidence  REAL NOT NULL DEFAULT 1.0,
  created_at  TEXT NOT NULL,
  FOREIGN KEY (atom_id) REFERENCES atoms(atom_id) ON DELETE CASCADE
)`;

const CREATE_TRIPLES_INDEXES = [
  'CREATE INDEX IF NOT EXISTS idx_triples_atom ON entity_triples(atom_id)',
  'CREATE INDEX IF NOT EXISTS idx_triples_sp ON entity_triples(subject, predicate)',
];

// Citations table for concept-name and atom-ID citation counts (ACT-R frequency).
// Populated by `mk citations` or `indexCitations()`. Used by wander for base_activation.
const CREATE_CITATIONS_TABLE = `
CREATE TABLE IF NOT EXISTS atom_citations (
  source_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 1,
  type TEXT NOT NULL DEFAULT 'concept_name',
  PRIMARY KEY (source_id, target_id, type),
  FOREIGN KEY (source_id) REFERENCES atoms(atom_id) ON DELETE CASCADE,
  FOREIGN KEY (target_id) REFERENCES atoms(atom_id) ON DELETE CASCADE
)`;

const CREATE_CITATIONS_INDEXES = [
  'CREATE INDEX IF NOT EXISTS idx_citations_target ON atom_citations(target_id)',
];

// --- Connection cache ---

const connectionCache = new Map<string, Database.Database>();

/**
 * Get or create a cached database connection for a memory directory.
 * DDL only runs on first open — subsequent calls return the cached connection.
 */
function getCachedDb(memoryDir: string): Database.Database {
  const resolvedDir = path.resolve(memoryDir);
  const existing = connectionCache.get(resolvedDir);
  if (existing) {
    try {
      // Verify connection is still valid
      existing.pragma('journal_mode');
      return existing;
    } catch {
      // Connection invalid — remove from cache and re-open
      connectionCache.delete(resolvedDir);
    }
  }

  const db = openIndexRaw(resolvedDir);
  connectionCache.set(resolvedDir, db);
  return db;
}

/**
 * Close a cached connection (useful for tests and cleanup).
 *
 * @internal Not part of the documented public API. Prefer `closeAllIndexes()`
 * in test teardown; this is exposed only for finer-grained internal usage.
 */
export function closeIndex(memoryDir: string): void {
  const resolvedDir = path.resolve(memoryDir);
  const db = connectionCache.get(resolvedDir);
  if (db) {
    try { db.close(); } catch { /* best-effort */ }
    connectionCache.delete(resolvedDir);
  }
}

/**
 * Close all cached connections (for process cleanup).
 */
export function closeAllIndexes(): void {
  for (const [key, db] of connectionCache) {
    try { db.close(); } catch { /* best-effort */ }
    connectionCache.delete(key);
  }
}

// --- DB lifecycle ---

/**
 * Open the index database directly (no caching). Used internally.
 * Checks schema version and rebuilds if stale.
 */
function openIndexRaw(resolvedDir: string): Database.Database {
  const dbPath = path.join(resolvedDir, DB_FILENAME);
  const db = new Database(dbPath);

  // SECRET-aware permissions: the index denormalizes tags and IDs that may
  // reference SECRET atoms. Restrict to owner-only (0o600).
  try {
    fs.chmodSync(dbPath, 0o600);
  } catch {
    // Best-effort: on Windows the chmod may be a no-op; on Linux the file
    // exists after Database() so this should succeed.
  }
  // WAL and SHM sidecars are created lazily. Chmod them opportunistically
  // if they already exist on this open call.
  for (const suffix of ['-wal', '-shm']) {
    const sidecar = dbPath + suffix;
    if (fs.existsSync(sidecar)) {
      try { fs.chmodSync(sidecar, 0o600); } catch { /* best-effort */ }
    }
  }

  // WAL mode for better concurrent read performance
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000'); // Wait up to 5s for locks

  // Check schema version — auto-rebuild if stale
  const currentVersion = (db.pragma('user_version', { simple: true }) as number) ?? 0;

  // Wrap DROP + CREATE + user_version assignment in a single transaction so a
  // fault anywhere in the block rolls back to the prior schema state. Without
  // this, a crash between `DROP TABLE` and the final `user_version` pragma
  // leaves a partial schema with the old user_version, and the next open
  // re-enters the upgrade path and DROPs the half-built tables again — wiping
  // any rows the application inserted in the partial-success window.
  // user_version is a value pragma stored in the file header, safe inside a
  // transaction (unlike journal_mode / foreign_keys / busy_timeout above,
  // which are configuration pragmas and run outside any transaction).
  const upgradeTx = db.transaction(() => {
    if (currentVersion !== SCHEMA_VERSION) {
      // Drop and recreate all tables for clean schema upgrade.
      // Drop order: dependent tables first (FK CASCADE), then atoms last.
      db.exec('DROP TABLE IF EXISTS entity_triples');
      db.exec('DROP TABLE IF EXISTS atom_citations');
      db.exec('DROP TABLE IF EXISTS atom_relations');
      db.exec('DROP TABLE IF EXISTS atom_embeddings');
      db.exec('DROP TABLE IF EXISTS episode_fts');
      db.exec('DROP TABLE IF EXISTS atom_fts');
      db.exec('DROP TABLE IF EXISTS atom_paths');
      db.exec('DROP TABLE IF EXISTS atom_tags');
      db.exec('DROP TABLE IF EXISTS atoms');
    }

    // Create schema (idempotent — IF NOT EXISTS)
    db.exec(CREATE_ATOMS_TABLE);
    db.exec(CREATE_TAGS_TABLE);
    db.exec(CREATE_PATHS_TABLE);
    for (const idx of CREATE_INDEXES) {
      db.exec(idx);
    }
    db.exec(CREATE_FTS_TABLE);
    db.exec(CREATE_EPISODE_FTS_TABLE);
    db.exec(CREATE_EMBEDDINGS_TABLE);
    db.exec(CREATE_RELATIONS_TABLE);
    for (const idx of CREATE_RELATIONS_INDEXES) {
      db.exec(idx);
    }
    db.exec(CREATE_CITATIONS_TABLE);
    for (const idx of CREATE_CITATIONS_INDEXES) {
      db.exec(idx);
    }
    db.exec(CREATE_TRIPLES_TABLE);
    for (const idx of CREATE_TRIPLES_INDEXES) {
      db.exec(idx);
    }

    // Set schema version atomically with the schema mutations above.
    db.pragma(`user_version = ${SCHEMA_VERSION}`);
  });
  upgradeTx();

  // Lazy column extension: add atom_embeddings.normalized for KNN
  // pre-normalization (PR-11 / #95). SQLite ALTER TABLE ADD COLUMN has
  // no IF NOT EXISTS, so we introspect first. Idempotent on subsequent
  // opens — additive only, no schema-version bump required.
  //
  // Race guard: another process may add the column between our PRAGMA
  // check and our ALTER. SQLite serializes the writes; the loser sees
  // "duplicate column name" which is a benign no-op for our purposes.
  const embedCols = db.prepare('PRAGMA table_info(atom_embeddings)').all() as { name: string }[];
  if (!embedCols.find(c => c.name === 'normalized')) {
    try {
      db.prepare('ALTER TABLE atom_embeddings ADD COLUMN normalized INTEGER NOT NULL DEFAULT 0').run();
    } catch (e) {
      if (!/duplicate column name/i.test((e as Error).message)) throw e;
    }
  }

  return db;
}

/**
 * Open (or create) the index database for a memory directory.
 * Uses connection cache — DDL only runs on first open.
 *
 * @internal Not part of the documented public API. Higher-level kernel
 * operations open the index transparently; external callers normally don't
 * need to handle the SQLite handle directly.
 */
export function openIndex(memoryDir: string): Database.Database {
  return getCachedDb(memoryDir);
}

/**
 * Check if an index exists for a memory directory.
 */
export function indexExists(memoryDir: string): boolean {
  return fs.existsSync(path.join(memoryDir, DB_FILENAME));
}

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

// --- Helpers ---

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
    // Preserve entity triples — LLM-extracted at ingestion and not serialized in
    // atom markdown, so reindex has no source of truth to rebuild from.
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

// --- Embedding operations ---

/**
 * Store an embedding vector for an atom.
 */
export function storeEmbedding(
  memoryDir: string,
  atomId: string,
  embedding: Buffer,
  model: string,
  dimensions: number,
  bodyHash: string,
  normalized: boolean = true,
): void {
  const db = openIndex(memoryDir);
  db.prepare(`
    INSERT OR REPLACE INTO atom_embeddings (atom_id, embedding, model, dimensions, body_hash, normalized)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(atomId, embedding, model, dimensions, bodyHash, normalized ? 1 : 0);
}

/** Maximum embeddings to load for in-memory KNN. Beyond this, warn and truncate. */
const MAX_EMBEDDINGS_FOR_KNN = 10_000;

/**
 * Get all embeddings for semantic search.
 * Returns atom_id + raw embedding buffer for KNN.
 *
 * NOTE: Loads vectors into memory. At 512-dim (2KB/vector), 10K atoms ≈ 20MB.
 * For 1536-dim (OpenAI), 10K atoms ≈ 60MB. Capped at MAX_EMBEDDINGS_FOR_KNN
 * to prevent memory issues. Consider sqlite-vss for larger stores.
 */
export function getAllEmbeddings(memoryDir: string): { atom_id: string; embedding: Buffer; normalized: boolean }[] | null {
  if (!indexExists(memoryDir)) return null;

  try {
    const db = openIndex(memoryDir);
    const count = (db.prepare('SELECT COUNT(*) as c FROM atom_embeddings').get() as { c: number }).c;
    if (count === 0) return null;

    if (count > MAX_EMBEDDINGS_FOR_KNN) {
      console.warn(
        `⚠ ${count} embeddings exceed KNN limit (${MAX_EMBEDDINGS_FOR_KNN}). ` +
        `Only the ${MAX_EMBEDDINGS_FOR_KNN} most recent will be used for semantic search. ` +
        `Consider sqlite-vss for larger stores.`,
      );
    }

    // Exclude SECRET/PERSONAL atoms from the graph-boost / KNN candidate set,
    // mirroring the same filter applied in queryIndex. NULL classification
    // (pre-classification atoms) stays visible. The COUNT(*) above is
    // intentionally unfiltered — it warns on total index size, not on
    // visible-result size.
    const rows = db.prepare(
      `SELECT e.atom_id, e.embedding, e.normalized
       FROM atom_embeddings e
       JOIN atoms a ON a.atom_id = e.atom_id
       WHERE a.classification IS NULL OR a.classification NOT IN ('SECRET', 'PERSONAL')
       ORDER BY e.rowid DESC
       LIMIT ${MAX_EMBEDDINGS_FOR_KNN}`,
    ).all() as { atom_id: string; embedding: Buffer; normalized: number }[];

    // Lazy migration: normalize any row with normalized=0 and write back.
    // This pays a one-time cost per legacy vector and lets the KNN hot loop
    // in src/recall.ts assume unit-norm storage going forward.
    const update = db.prepare('UPDATE atom_embeddings SET embedding = ?, normalized = 1 WHERE atom_id = ?');
    const out: { atom_id: string; embedding: Buffer; normalized: boolean }[] = [];
    const writeBacks: { id: string; buf: Buffer }[] = [];

    for (const r of rows) {
      if (r.normalized === 1) {
        out.push({ atom_id: r.atom_id, embedding: r.embedding, normalized: true });
        continue;
      }
      const f32 = new Float32Array(r.embedding.buffer, r.embedding.byteOffset, r.embedding.byteLength / 4);
      let norm = 0;
      for (let i = 0; i < f32.length; i++) norm += f32[i] * f32[i];
      norm = Math.sqrt(norm);
      const normalized = new Float32Array(f32.length);
      if (norm > 0) {
        for (let i = 0; i < f32.length; i++) normalized[i] = f32[i] / norm;
      }
      const buf = Buffer.from(normalized.buffer);
      out.push({ atom_id: r.atom_id, embedding: buf, normalized: true });
      writeBacks.push({ id: r.atom_id, buf });
    }

    if (writeBacks.length > 0) {
      const tx = db.transaction(() => {
        for (const w of writeBacks) update.run(w.buf, w.id);
      });
      tx();
    }

    return out;
  } catch {
    return null;
  }
}

/**
 * Check if an atom's embedding is stale (body changed since embedding was computed).
 */
export function isEmbeddingStale(memoryDir: string, atomId: string, currentBodyHash: string): boolean {
  if (!indexExists(memoryDir)) return true;

  try {
    const db = openIndex(memoryDir);
    const row = db.prepare('SELECT body_hash FROM atom_embeddings WHERE atom_id = ?').get(atomId) as {
      body_hash: string;
    } | undefined;
    if (!row) return true;
    return row.body_hash !== currentBodyHash;
  } catch {
    return true;
  }
}

/**
 * Bulk-load all (atom_id, body_hash) pairs for staleness detection.
 * Returns a Map for O(1) lookup in tight loops.
 *
 * Use this in batch paths (mk reindex --embed, embedAllAtoms) instead of
 * calling isEmbeddingStale once per atom — the per-atom path issues N
 * SELECT round-trips; this issues one.
 */
export function getAllEmbeddingHashes(memoryDir: string): Map<string, string> | null {
  if (!indexExists(memoryDir)) return null;

  try {
    const db = openIndex(memoryDir);
    const rows = db.prepare('SELECT atom_id, body_hash FROM atom_embeddings').all() as {
      atom_id: string;
      body_hash: string;
    }[];
    const map = new Map<string, string>();
    for (const r of rows) map.set(r.atom_id, r.body_hash);
    return map;
  } catch {
    return null;
  }
}

/**
 * Get embedding stats.
 */
export function embeddingStats(memoryDir: string): { count: number; model: string | null } | null {
  if (!indexExists(memoryDir)) return null;

  try {
    const db = openIndex(memoryDir);
    const count = (db.prepare('SELECT COUNT(*) as c FROM atom_embeddings').get() as { c: number }).c;
    const modelRow = db.prepare('SELECT model, COUNT(*) as cnt FROM atom_embeddings GROUP BY model ORDER BY cnt DESC LIMIT 1').get() as { model: string; cnt: number } | undefined;
    return { count, model: modelRow?.model ?? null };
  } catch {
    return null;
  }
}

/**
 * Full-text search over atom titles and bodies using SQLite FTS5 + BM25 ranking.
 *
 * Returns atom IDs ordered by relevance (best match first).
 * Returns null if the FTS table is unavailable (caller should fall back to unranked results).
 *
 * The query string is sanitised — FTS5 special chars are stripped so arbitrary
 * natural-language task descriptions are safe to pass directly.
 */
export function searchFts(
  memoryDir: string,
  queryText: string,
  limit = 50,
): { atom_id: string; rank: number }[] | null {
  if (!indexExists(memoryDir)) return null;

  try {
    const db = openIndex(memoryDir);

    // Strip FTS5 special characters and build an implicit-AND token query.
    // Each word becomes a separate token — FTS5 default is implicit AND,
    // so "notation erasure" matches documents containing both words (in any order).
    // Previously used a quoted phrase query which required exact token sequence,
    // causing most multi-word task queries to return 0 results.
    //
    // The character class also strips dots (.) and basic punctuation
    // (,;?!) — these aren't FTS5 syntax characters per se, but unicode61
    // treats them as token boundaries and the parser rejects them mid-token
    // with `fts5: syntax error near "."` for inputs like "192.168.1.136".
    // Stripping turns dotted/punctuated queries into clean OR-token queries
    // that match against the (already similarly-tokenised) atom body.
    // See issue #214.
    const sanitised = queryText
      .replace(/["*()^:\-./,;?!]/g, ' ')  // remove FTS5 syntax chars + tokenizer-boundary punctuation
      .replace(/\b(AND|OR|NOT|NEAR)\b/g, ' ') // remove boolean operators
      .replace(/\s+/g, ' ')
      .trim();

    if (!sanitised) return [];

    // OR token query: documents matching ANY term are returned.
    // BM25 naturally ranks documents matching more terms higher, and the
    // coverage boost multiplier (Phase 7) explicitly penalizes partial matches.
    // Previously used implicit AND which excluded partial-match documents entirely,
    // making coverage boost a no-op.
    const tokens = sanitised.split(/\s+/).filter(Boolean);
    const ftsQuery = tokens.length > 1 ? tokens.join(' OR ') : sanitised;

    // Exclude SECRET/PERSONAL atoms from the FTS result set so they cannot
    // shift BM25 rank-span normalization, IDF damping, or coverage-boost
    // computations downstream in recall.ts. Mirrors the same predicate
    // applied in queryIndex and getAllEmbeddings. NULL classification
    // (pre-classification rows) stays visible. See #135.
    const rows = db.prepare(
      `SELECT e.atom_id, e.rank
       FROM atom_fts e
       JOIN atoms a ON a.atom_id = e.atom_id
       WHERE atom_fts MATCH ?
         AND (a.classification IS NULL OR a.classification NOT IN ('SECRET', 'PERSONAL'))
       ORDER BY e.rank
       LIMIT ?`,
    ).all(ftsQuery, limit) as { atom_id: string; rank: number }[];

    return rows;
  } catch {
    // FTS table missing or query error — degrade gracefully
    return null;
  }
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

// --- Relation operations (Phase 3) ---

export interface AtomRelation {
  source_id: string;
  target_id: string;
  relation_type: string;
  created_at: string;
}

/**
 * Get all inbound and outbound relations for an atom.
 */
export function getRelationsForAtom(
  memoryDir: string,
  atomId: string,
): { outbound: AtomRelation[]; inbound: AtomRelation[] } {
  if (!indexExists(memoryDir)) return { outbound: [], inbound: [] };
  try {
    const db = openIndex(memoryDir);
    const outbound = db.prepare(
      'SELECT * FROM atom_relations WHERE source_id = ? ORDER BY relation_type',
    ).all(atomId) as AtomRelation[];
    const inbound = db.prepare(
      'SELECT * FROM atom_relations WHERE target_id = ? ORDER BY relation_type',
    ).all(atomId) as AtomRelation[];
    return { outbound, inbound };
  } catch {
    return { outbound: [], inbound: [] };
  }
}

/**
 * Insert a relation edge into the index.
 * Idempotent — duplicate (source, target, type) triples are silently ignored.
 */
export function addRelation(
  memoryDir: string,
  sourceId: string,
  targetId: string,
  relationType: string,
): void {
  const db = openIndex(memoryDir);
  db.prepare(`
    INSERT OR IGNORE INTO atom_relations (source_id, target_id, relation_type)
    VALUES (?, ?, ?)
  `).run(sourceId, targetId, relationType);
}

/**
 * Get all relation edges from the index (used for graph-walk boost in recall).
 * Returns empty array if index doesn't exist or table is absent.
 */
export function getAllRelations(memoryDir: string): AtomRelation[] {
  if (!indexExists(memoryDir)) return [];
  try {
    const db = openIndex(memoryDir);
    return db.prepare('SELECT * FROM atom_relations').all() as AtomRelation[];
  } catch {
    return [];
  }
}

/**
 * Get document frequency for each query term in the FTS index.
 * Returns a map of term → number of atoms containing that term.
 * Returns null if FTS index is unavailable.
 *
 * Uses the same sanitisation as searchFts (porter-tokenized stems match).
 */
export function getTermDocumentFrequencies(
  memoryDir: string,
  terms: string[],
): Map<string, number> | null {
  if (!indexExists(memoryDir)) return null;

  try {
    const db = openIndex(memoryDir);
    const result = new Map<string, number>();
    // DF over the visible corpus only — SECRET/PERSONAL rows must not
    // contribute to IDF damping for visible atoms. See #135.
    const stmt = db.prepare(
      `SELECT count(*) as cnt
       FROM atom_fts e
       JOIN atoms a ON a.atom_id = e.atom_id
       WHERE atom_fts MATCH ?
         AND (a.classification IS NULL OR a.classification NOT IN ('SECRET', 'PERSONAL'))`,
    );

    for (const term of terms) {
      // Sanitise the same way searchFts does
      const sanitised = term
        .replace(/["*()^:\-]/g, ' ')
        .replace(/\b(AND|OR|NOT|NEAR)\b/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (!sanitised) {
        result.set(term, 0);
        continue;
      }
      try {
        const row = stmt.get(sanitised) as { cnt: number };
        result.set(term, row.cnt);
      } catch {
        result.set(term, 0);
      }
    }
    return result;
  } catch {
    return null;
  }
}

/**
 * Return the set of atom_ids whose FTS entry matches the given term
 * (porter-stemmed, same sanitisation as searchFts / getTermDocumentFrequencies).
 * Returns an empty set on any error or missing index.
 */
export function getAtomsMatchingTerm(
  memoryDir: string,
  term: string,
): Set<string> {
  if (!indexExists(memoryDir)) return new Set();

  try {
    const db = openIndex(memoryDir);
    const sanitised = term
      .replace(/["*()^:\-]/g, ' ')
      .replace(/\b(AND|OR|NOT|NEAR)\b/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!sanitised) return new Set();

    // Visible-corpus only — SECRET/PERSONAL hits must not feed the
    // coverage-boost computation in recall.ts. See #135.
    const rows = db
      .prepare(
        `SELECT e.atom_id
         FROM atom_fts e
         JOIN atoms a ON a.atom_id = e.atom_id
         WHERE atom_fts MATCH ?
           AND (a.classification IS NULL OR a.classification NOT IN ('SECRET', 'PERSONAL'))`,
      )
      .all(sanitised) as { atom_id: string }[];
    return new Set(rows.map((r) => r.atom_id));
  } catch {
    return new Set();
  }
}

/**
 * Get total number of rows in the FTS index (corpus size).
 * Returns 0 if FTS index is unavailable.
 */
export function getCorpusSize(memoryDir: string): number {
  if (!indexExists(memoryDir)) return 0;

  try {
    const db = openIndex(memoryDir);
    const row = db.prepare('SELECT count(*) as cnt FROM atom_fts').get() as { cnt: number };
    return row.cnt;
  } catch {
    return 0;
  }
}

// --- Episode FTS operations ---

/**
 * Upsert a single episode into the episode_fts index.
 * Call after writeEpisode().
 */
export function indexEpisode(memoryDir: string, episodeId: string, body: string): void {
  try {
    const db = openIndex(memoryDir);
    const tx = db.transaction(() => {
      db.prepare('DELETE FROM episode_fts WHERE episode_id = ?').run(episodeId);
      db.prepare('INSERT INTO episode_fts(episode_id, body) VALUES (?, ?)').run(episodeId, body);
    });
    tx();
  } catch {
    // Best-effort — episode FTS is an optimization, not critical.
    // The transaction rolled back automatically on throw; the outer catch
    // only suppresses the throw so callers keep working.
  }
}

/**
 * Remove an episode from the FTS index.
 */
export function removeEpisodeFromIndex(memoryDir: string, episodeId: string): void {
  try {
    const db = openIndex(memoryDir);
    db.prepare('DELETE FROM episode_fts WHERE episode_id = ?').run(episodeId);
  } catch {
    // Best-effort
  }
}

/**
 * Full-text search over episode summaries using SQLite FTS5 + BM25 ranking.
 *
 * Returns episode IDs ordered by relevance (best match first).
 * Returns null if the FTS table is unavailable (caller should fall back to term-overlap).
 *
 * Uses the same sanitisation as searchFts for atoms.
 */
export function searchEpisodeFts(
  memoryDir: string,
  queryText: string,
  limit = 50,
): { episode_id: string; rank: number }[] | null {
  if (!indexExists(memoryDir)) return null;

  try {
    const db = openIndex(memoryDir);

    // Same sanitisation as searchFts for atoms
    const sanitised = queryText
      .replace(/["*()^:\-]/g, ' ')
      .replace(/\b(AND|OR|NOT|NEAR)\b/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (!sanitised) return [];

    const tokens = sanitised.split(/\s+/).filter(Boolean);
    const ftsQuery = tokens.length > 1 ? tokens.join(' OR ') : sanitised;

    const rows = db.prepare(
      `SELECT episode_id, rank FROM episode_fts WHERE episode_fts MATCH ? ORDER BY rank LIMIT ?`,
    ).all(ftsQuery, limit) as { episode_id: string; rank: number }[];

    return rows;
  } catch {
    // FTS table missing or query error — degrade gracefully
    return null;
  }
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
