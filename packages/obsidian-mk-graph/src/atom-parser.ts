import matter from 'gray-matter';

/** Atom shape used by the plugin — flatter than mk-core's AtomFrontmatter for renderer ergonomics. */
export interface ParsedAtom {
  id: string;
  type: string;             // atom type — never validated; encoding falls back to grey on unknown
  status: string;           // atom status — same, falls back to opacity 1.0
  classification: string;   // PUBLIC | TEAM | PERSONAL | SECRET; defaults to TEAM (F2 spec §5.2)
  confidence: number;       // 0..1; default 1.0
  createdAt: string;        // ISO8601
  updatedAt: string;        // ISO8601
  ttlDays: number | null;   // null = no expiry
  tags: string[];           // flattened from scope.tags
  relations: ParsedRelation[];
  body: string;             // body with the `## Relations` section stripped
  filePath?: string;
}

export interface ParsedRelation {
  target: string;
  type: string;             // never validated; renderer falls back to grey
  createdAt?: string;
  confidence?: number;
  weight?: number;
  source?: string;          // manual | extracted | enriched | unknown — falls back to 'unknown'
  evidence?: string[];
}

const RELATIONS_SECTION_RE = /(?:^|\n)##\s+Relations\s*\n[\s\S]*$/m;

/**
 * Parse a memory-kernel atom markdown file into a renderer-friendly shape.
 * Returns null if the file is malformed or missing required fields — the
 * loader silently skips nulls so a single bad file doesn't break the graph.
 */
export function parseAtomFile(content: string, filePath?: string): ParsedAtom | null {
  let parsed: ReturnType<typeof matter>;
  try {
    parsed = matter(content);
  } catch {
    return null;
  }

  const fm = parsed.data as Record<string, unknown>;
  if (typeof fm.id !== 'string' || !fm.id) return null;
  if (typeof fm.type !== 'string' || !fm.type) return null;
  if (typeof fm.status !== 'string' || !fm.status) return null;

  const scope = (fm.scope ?? {}) as { tags?: unknown };
  const rawTags = Array.isArray(scope.tags) ? scope.tags : [];
  const tags = rawTags.filter((t): t is string => typeof t === 'string');

  const rawRelations = Array.isArray(fm.relations) ? fm.relations : [];
  const relations: ParsedRelation[] = [];
  for (const r of rawRelations) {
    if (!r || typeof r !== 'object') continue;
    const rec = r as Record<string, unknown>;
    if (typeof rec.target !== 'string' || typeof rec.type !== 'string') continue;
    const rel: ParsedRelation = { target: rec.target, type: rec.type };
    if (typeof rec.created_at === 'string') rel.createdAt = rec.created_at;
    if (typeof rec.confidence === 'number') rel.confidence = rec.confidence;
    if (typeof rec.weight === 'number') rel.weight = rec.weight;
    if (typeof rec.source === 'string') rel.source = rec.source;
    if (Array.isArray(rec.evidence)) {
      rel.evidence = rec.evidence.filter((e): e is string => typeof e === 'string');
    }
    relations.push(rel);
  }

  const body = parsed.content.replace(RELATIONS_SECTION_RE, '').trim();

  return {
    id: fm.id,
    type: fm.type,
    status: fm.status,
    classification: typeof fm.classification === 'string' ? fm.classification : 'TEAM',
    confidence: typeof fm.confidence === 'number' ? fm.confidence : 1.0,
    createdAt: typeof fm.created_at === 'string' ? fm.created_at : '',
    updatedAt: typeof fm.updated_at === 'string' ? fm.updated_at : '',
    ttlDays: typeof fm.ttl_days === 'number' ? fm.ttl_days : null,
    tags,
    relations,
    body,
    filePath,
  };
}
