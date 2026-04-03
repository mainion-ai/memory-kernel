/**
 * SQLite index for fast atom lookups.
 *
 * Files remain the source of truth — this is a derived cache.
 * If the index is stale or missing, fall back to file scan (listAtoms).
 * Rebuild with `mk reindex`.
 */

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import type { Atom, AtomType, AtomStatus, Classification, RecallQuery } from './types.js';
import { listAtoms } from './store.js';

const DB_FILENAME = '.memory-index.db';
const SCHEMA_VERSION = 5; // Bump when schema changes to trigger auto-rebuild

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

  // WAL mode for better concurrent read performance
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000'); // Wait up to 5s for locks

  // Check schema version — auto-rebuild if stale
  const currentVersion = (db.pragma('user_version', { simple: true }) as number) ?? 0;
  if (currentVersion !== SCHEMA_VERSION) {
    // Drop and recreate all tables for clean schema upgrade.
    // Drop order: relations first (FK source CASCADE, FK target RESTRICT — must go before atoms).
    db.exec('DROP TABLE IF EXISTS atom_relations');
    db.exec('DROP TABLE IF EXISTS atom_embeddings');
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
  db.exec(CREATE_EMBEDDINGS_TABLE);
  db.exec(CREATE_RELATIONS_TABLE);
  for (const idx of CREATE_RELATIONS_INDEXES) {
    db.exec(idx);
  }

  // Set schema version
  db.pragma(`user_version = ${SCHEMA_VERSION}`);

  return db;
}

/**
 * Open (or create) the index database for a memory directory.
 * Uses connection cache — DDL only runs on first open.
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

    // Disable FK enforcement during the batch delete so that the explicit DELETE FROM
    // atom_relations (below) isn't redundantly cascade-fired again when atoms are deleted.
    // Re-enabled in finally to ensure the connection is never left with FKs off on error.
    db.pragma('foreign_keys = OFF');
    try {
      // Clear existing data
      db.exec('DELETE FROM atom_relations');
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

    // Restore preserved embeddings (only for atoms that still exist)
    db.exec(`
      INSERT OR IGNORE INTO atom_embeddings (atom_id, embedding, model, dimensions, body_hash)
      SELECT atom_id, embedding, model, dimensions, body_hash
      FROM _saved_embeddings
      WHERE atom_id IN (SELECT atom_id FROM atoms)
    `);
    db.exec('DROP TABLE IF EXISTS _saved_embeddings');
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
  db.prepare('DELETE FROM atoms WHERE atom_id = ?').run(atomId);
  db.prepare('DELETE FROM atom_fts WHERE atom_id = ?').run(atomId);
  db.prepare('DELETE FROM atom_embeddings WHERE atom_id = ?').run(atomId);
  // atom_tags and atom_paths cascade-deleted via FK on atoms table
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
): void {
  const db = openIndex(memoryDir);
  db.prepare(`
    INSERT OR REPLACE INTO atom_embeddings (atom_id, embedding, model, dimensions, body_hash)
    VALUES (?, ?, ?, ?, ?)
  `).run(atomId, embedding, model, dimensions, bodyHash);
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
export function getAllEmbeddings(memoryDir: string): { atom_id: string; embedding: Buffer }[] | null {
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

    return db.prepare(
      `SELECT atom_id, embedding FROM atom_embeddings ORDER BY rowid DESC LIMIT ${MAX_EMBEDDINGS_FOR_KNN}`,
    ).all() as {
      atom_id: string;
      embedding: Buffer;
    }[];
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

    // Strip FTS5 special characters to treat the input as a plain phrase.
    // We wrap in double-quotes for a quoted phrase query (exact token sequence or stemmed match).
    const sanitised = queryText
      .replace(/["*()]/g, ' ')  // remove FTS5 operators/syntax chars
      .replace(/\b(AND|OR|NOT)\b/g, ' ') // remove boolean operators
      .replace(/\s+/g, ' ')
      .trim();

    if (!sanitised) return [];

    // Quoted phrase query: FTS5 matches documents containing all tokens in order (with stemming).
    const ftsQuery = `"${sanitised}"`;

    const rows = db.prepare(
      `SELECT atom_id, rank FROM atom_fts WHERE atom_fts MATCH ? ORDER BY rank LIMIT ?`,
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

    // Exclude archived/expired by default — only when no explicit status filter is given
    if (!query.statuses || query.statuses.length === 0) {
      conditions.push("a.status NOT IN ('archived', 'expired')");
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
      const pathConditions = query.paths.map(() =>
        `a.atom_id IN (SELECT atom_id FROM atom_paths WHERE path LIKE ? || '%' ESCAPE '\\' OR INSTR(? || '/', path || '/') = 1)`,
      );
      // Unscoped atoms (no paths) always match
      conditions.push(
        `(a.atom_id NOT IN (SELECT atom_id FROM atom_paths) OR ${pathConditions.join(' OR ')})`,
      );
      for (const p of query.paths) {
        // Escape LIKE wildcards in path values (only for the first LIKE arm)
        const escaped = p.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
        params.push(escaped, p);
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
export function indexStats(memoryDir: string): { atoms: number; tags: number; paths: number; embeddings: number; relations: number } | null {
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
  return { atoms, tags, paths, embeddings, relations };
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
