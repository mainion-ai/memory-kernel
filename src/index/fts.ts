/**
 * Full-text search (FTS5) over atom title/body and episode summaries, plus the
 * term-frequency / corpus helpers recall uses for IDF damping + coverage (#368).
 * All handles come from the shared connection cache in `./connection.js`.
 */

import { openIndex, indexExists } from './connection.js';

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
    //
    // The apostrophe (') is the FTS5 string-literal delimiter: an unbalanced
    // one (e.g. "Taj's role") makes FTS5 read an unterminated string and raise
    // `fts5: syntax error`, which the catch below turns into null —
    // indistinguishable from "index absent" and surfaced as recall_status:
    // fts_unavailable. We strip the ASCII apostrophe and the two common
    // typographic variants (’ U+2019, ‘ U+2018) so possessive/contraction
    // queries stay reachable. See issue #283. Remaining FTS5 query-syntax
    // characters (" * ( ) : ^ -) are all already in the class below.
    const sanitised = queryText
      .replace(/["'’‘*()^:\-./,;?!]/g, ' ')  // remove FTS5 syntax chars (incl. apostrophe) + tokenizer-boundary punctuation
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
