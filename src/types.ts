/**
 * Core types for the Memory Kernel.
 *
 * Memory Atom = the fundamental unit of durable memory.
 * Event = what happened (append-only log).
 * View = derived, human-readable state (INDEX, HANDOFF, etc.).
 */

// --- Atom types ---

export const ATOM_TYPES = [
  'decision',
  'constraint',
  'open_question',
  'belief',
  'fact',
  'procedure',
  'entity_summary',
  'preference',
  'conflict',
] as const;

export type AtomType = (typeof ATOM_TYPES)[number];

export const ATOM_STATUSES = [
  'draft',
  'active',
  'accepted',
  'rejected',
  'superseded',
  'resolved',
  'archived',
  'expired',
] as const;

export type AtomStatus = (typeof ATOM_STATUSES)[number];

export const CLASSIFICATIONS = [
  'PUBLIC',
  'TEAM',
  'PERSONAL',
  'SECRET',
] as const;

export type Classification = (typeof CLASSIFICATIONS)[number];

// --- Atom frontmatter (YAML) ---

export interface AtomFrontmatter {
  id: string;
  type: AtomType;
  status: AtomStatus;
  confidence: number; // 0.0 - 1.0
  created_at: string; // ISO8601 UTC
  updated_at: string; // ISO8601 UTC
  ttl_days: number | null; // null = no expiry
  scope?: {
    paths?: string[];
    tags?: string[];
    domains?: string[];
  };
  classification?: Classification;
  provenance?: {
    episodes?: string[];
    evidence?: string[];
  };
  links?: {
    related?: string[];
    supersedes?: string[];
    blocked_by?: string[];
  };
  relations?: Relation[]; // Phase 3: typed graph edges to other atoms
  /**
   * When this atom was first confirmed executed (ISO-8601 UTC), set by
   * `mk execute` or the session-end extractor (#309). For `procedure` drafts
   * this is the auto-promotion signal — a procedure is only trustworthy once
   * it has actually run, not as it was aspirationally written.
   */
  executed_at?: string;
}

// --- Relation types (Phase 3) ---

export const RELATION_TYPES = [
  'extends',
  'contradicts',
  'supports',
  'caused_by',
  'supersedes',
  'applied_to',
  'related',
] as const;

export type RelationType = (typeof RELATION_TYPES)[number];

/**
 * Tag stamped by `mk extract` on every draft atom it produces (session-end
 * extract, #268). The single source of truth for the literal — the producer
 * (extract), the promoter (consolidate), and the recall/render visibility gates
 * (#274 Gap 1) all reference this so a typo can't silently disable one site.
 */
export const AUTO_EXTRACTED_TAG = 'auto-extracted';

export interface Relation {
  target: string; // Atom ID
  type: RelationType;
}

// --- Entity Triple (Tier 1: semantic conflict detection) ---

/**
 * An entity-relation triple extracted from an atom body.
 *
 * Used by the conflict-detection layer (Tier 1) to find atoms that share a
 * (subject, predicate) but disagree on the object. Triples are extracted at
 * ingestion time by the LLM and persisted in the `entity_triples` SQLite table.
 */
export interface EntityTriple {
  /** Atom this triple was extracted from. */
  atom_id: string;
  /** Entity that the predicate applies to (e.g. "France"). Lower-cased on insert. */
  subject: string;
  /** Relation type / predicate (e.g. "has_capital"). Lower-cased on insert. */
  predicate: string;
  /** Value of the predicate for the subject (e.g. "Paris"). Lower-cased on insert. */
  object: string;
  /** LLM-reported confidence in the extraction (0..1). */
  confidence: number;
  /** ISO8601 UTC timestamp when the triple was inserted. */
  created_at: string;
}

/** Input form accepted from LLM candidates — no atom_id/created_at yet. */
export interface TripleInput {
  subject: string;
  predicate: string;
  object: string;
  confidence?: number;
}

// --- Atom (frontmatter + body) ---

export interface Atom {
  frontmatter: AtomFrontmatter;
  body: string; // Markdown content after frontmatter
  filePath?: string; // Where this atom lives on disk
}

// --- Event types ---

export const EVENT_ACTIONS = [
  'atom_created',
  'atom_updated',
  'atom_archived',
  'atom_promoted',
  'atom_expired',
  'atom_imported',
  'atom_shared',
  'atom_unshared',
  'atom_read',
  'checkpoint_created',
  'conflict_detected',
  'conflict_resolved',
  'human_edit',
  // #364: confidence write-back from the grounding reconciliation pass — one
  // event per atom whose confidence was nudged toward its usage-grounded value.
  'atom_reconciled',
  'reflect_completed',
  'gc_completed',
  'session_started',
  'session_ended',
  'merge_completed',
] as const;

export type EventAction = (typeof EVENT_ACTIONS)[number];

/**
 * Fields common to every memory event, regardless of schema version.
 *
 * #111: MemoryEvent is a discriminated union on `schema_version`, so
 * consumers can narrow on `event.schema_version === 2` and gain typed
 * access to `atom_snapshot` / `atom_snapshot_hash`.
 */
interface MemoryEventBase {
  event_id: string; // ULID or UUID
  timestamp: string; // ISO8601 UTC
  agent_id: string;
  session_id: string;
  action: EventAction;
  atom_refs?: string[]; // Atom IDs affected
  touched_paths?: string[]; // File/scope paths
  evidence?: string[]; // Evidence pointers (hashes, file refs)
  meta?: Record<string, unknown>; // Extra context
}

/** V1 event (no schema_version, no inline atom snapshot). */
export interface MemoryEventV1 extends MemoryEventBase {
  schema_version?: undefined;
  atom_snapshot?: undefined;
  atom_snapshot_hash?: undefined;
}

/** V2 event — carries an inline atom_snapshot (or hash) for replay. */
export interface MemoryEventV2 extends MemoryEventBase {
  schema_version: 2;
  atom_snapshot?: string; // Serialized atom (frontmatter+body markdown)
  atom_snapshot_hash?: string; // SHA-256 hash if snapshot stored in evidence
}

/**
 * Discriminated union over `schema_version`. To narrow:
 *
 * ```ts
 * if (event.schema_version === 2) {
 *   event.atom_snapshot; // typed string | undefined, no widening
 * }
 * ```
 */
export type MemoryEvent = MemoryEventV1 | MemoryEventV2;

// --- Recall query ---

export interface RecallQuery {
  task?: string; // Natural language task — used for FTS-based re-ranking
  paths?: string[]; // Scope paths to match
  types?: AtomType[]; // Filter by atom type
  statuses?: AtomStatus[]; // Filter by status
  include_drafts?: boolean; // Opt-in to surface status:draft atoms (default: excluded — #274 Gap 1)
  tags?: string[]; // Filter by tags
  include_episodes?: boolean; // Include EPISODES/ session summaries in context bundle
  max_tokens?: number; // Budget for context
  // Read audit: if both set, an 'atom_read' event is emitted after recall completes
  agent_id?: string;
  session_id?: string;
  // Phase 1: Temporal decay (overrides RECALL_DECAY_HALF_LIFE / RECALL_DECAY_WEIGHT env vars)
  decay_half_life?: number; // Half-life in days (default 30)
  decay_weight?: number; // Weight of recency in final score 0-1 (default 0.2)
  // Phase 2: Type-aware weighting (overrides RECALL_TYPE_WEIGHTS / RECALL_TYPE_RESERVATIONS env vars)
  type_weights?: Partial<Record<AtomType, number>>; // Per-type score multipliers
  type_reservations?: Partial<Record<AtomType, number>>; // Min token slots per type
  // Phase 3: Graph-walk boost
  graph_boost?: boolean; // Enable/disable neighbor boost (default true)
  // Phase 4: Reservation override
  no_reservations?: boolean; // Disable type reservations entirely (useful for task-focused recall)
  // Phase 5: IDF hub damping — penalizes atoms matching only ubiquitous query terms
  idf_damping?: number; // 0 = disabled, 1 = full damping (default from RECALL_IDF_DAMPING env or 1.0)
  // Phase 6: Content-length normalization — penalizes long atoms that get inflated BM25 scores
  length_norm_k?: number; // 0 = disabled, 0.5 = moderate (default), 1.0 = aggressive
  // Phase 7: Query-term coverage boost — penalizes atoms matching few query terms
  coverage_boost?: number; // Exponent P: 0 = disabled, 0.5 = moderate (default), 2.0 = aggressive
  // Phase 8: MMR result diversity — re-ranks to prevent redundant atoms filling token budget
  mmr_lambda?: number; // 0 = pure diversity, 0.7 = moderate (default), 1.0 = disabled (pure relevance)
  // Episode budget ratio — fraction of max_tokens reserved for episodes (default 0.2)
  episode_budget_ratio?: number; // 0 = no episodes, 0.2 = default, 1.0 = all episodes
}

// --- Episode types ---

export interface EpisodeMetadata {
  session_id: string;
  agent_id?: string;
  started_at?: string; // ISO8601 UTC
  ended_at?: string; // ISO8601 UTC
  tags?: string[];
  provenance_atoms?: string[]; // atom IDs linked to this episode
}

export interface Episode {
  id: string; // e.g. "EP-session-17"
  metadata: EpisodeMetadata;
  summary: string; // Markdown body
  filePath: string; // EPISODES/{id}.md on disk
}

// --- Context bundle (recall output) ---

export interface ContextBundle {
  index: string; // INDEX.md content
  handoff: string; // HANDOFF.md content
  constraints: string; // CONSTRAINTS.md content
  atoms: Atom[]; // Relevant atoms
  episodes?: string[]; // Episode summaries (if requested via include_episodes)
  token_estimate: number; // Rough token count
  // Outcome signal for task-driven recall. Set only when `task` was passed.
  // - "match"           — at least one FTS or semantic hit; `atoms` is the match set.
  // - "no_match"        — FTS + semantic both came back empty; `atoms` is [] by design
  //                       (issue #214 — no more confidently-irrelevant fallback).
  // - "fts_unavailable" — `searchFts()` returned null (FTS table missing or query crashed
  //                       beyond the sanitisation layer). Falls back to file-scan semantics.
  recall_status?: 'match' | 'no_match' | 'fts_unavailable';
}

// --- Reflect result ---

export interface ReflectResult {
  deduped: number;
  expired: number;
  promoted: number;
  archived: number;
  conflicts_found: number;
  events_emitted: number;
  // #247: only present when reflect runs with `backfillHumanEdits`. Optional so
  // the default reflect result shape is unchanged.
  unprovenanced_writes?: number; // candidates detected (all confidences)
  human_edits_backfilled?: number; // synthetic human_edit events emitted (scattered, non-cluster)
}

// --- Replay result ---

export interface ReplayResult {
  atoms: Map<string, Atom>;
  views: {
    index: string;
    decisions: string;
    constraints: string;
    open_questions: string;
    handoff: string;
  };
  events_processed: number;
  errors: string[];
}

// --- Bootstrap result ---

export interface BootstrapResult {
  imported: number;
  skipped: number;
  events_written: number;
  backup_path: string;
}

// --- Compact result ---

export interface CompactResult {
  events_before: number;
  events_after: number;
  removed: number;
  backup_path: string;
}

// --- Merge result ---

export interface MergeResult {
  events_imported: number; // new remote events added to local
  events_skipped: number; // remote events already present (dedup by event_id)
  conflicts_created: number; // conflict atoms created for concurrent updates
  atoms_updated: number; // atoms written to disk from replay
  backup_path: string; // timestamped backup of events.ndjson before merge
}

// --- Memory Kernel config ---

export interface KernelConfig {
  memory_dir: string; // Root directory for memory
  agent_id: string;
  default_classification: Classification;
  ttl_defaults: Record<AtomType, number | null>;
  index_budget_lines: number; // Max lines for INDEX.md (default 200)
  handoff_budget_lines: number; // Max lines for HANDOFF.md
}

// --- Per-agent isolation ---

export interface IsolationConfig {
  isolation: 'shared' | 'per-agent';
}

export type RenderMode = 'operational' | 'constitutive' | 'balanced';

export interface RenderConfig {
  /** Render mode: operational (fact-heavy), constitutive (belief-heavy), balanced (default). */
  mode: RenderMode;
  /** Token budget for recall during render. */
  max_tokens: number;
  /** Whether to include shared namespace atoms in render. */
  include_shared: boolean;
  /** Per-type score multipliers for recall ranking. */
  type_weights: Partial<Record<AtomType, number>>;
  /**
   * Per-type token reservations for fill-mode render. Each entry guarantees
   * a minimum token budget for atoms of that type so beliefs (or any single
   * type) cannot monopolise the output. Empty object → use defaults from
   * src/schema.ts DEFAULT_FILL_TYPE_RESERVATIONS at render time.
   */
  type_reservations: Partial<Record<AtomType, number>>;
}

// --- Extract types ---

/** A candidate atom extracted by the LLM from a conversation log. */
export interface CandidateAtom {
  type: string; // AtomType, validated at runtime
  slug: string;
  title: string;
  body: string;
  tags?: string[];
  confidence?: number;
  rationale?: string;
  /** For preference atoms: the subject of the preference (e.g. "coffee", "programming languages"). */
  subject?: string;
  /** For preference atoms: the preference statement (e.g. "prefers oat milk lattes"). */
  preference?: string;
  /** For preference atoms: context when/why the preference was expressed. */
  context?: string;
  /** Optional entity-relation triples extracted by the LLM (#75 conflict detection). */
  triples?: TripleInput[];
}

/** Result for a single extracted atom candidate. */
export interface ExtractedAtomResult {
  atom_id: string | null; // null if skipped/dry-run with no ID
  slug: string;
  type: string;
  /** 'new' | 'skipped' | 'possible_duplicate' */
  status: 'new' | 'skipped' | 'possible_duplicate';
  reason?: string;
  possible_duplicate_of?: string;
  /** Conflict resolutions produced by Tier-1+Tier-2 on this atom (only when conflictDetect ran). */
  conflicts?: import('./conflict-detect.js').ConflictResolution[];
}

/** Options for extractFromLog. */
export interface ExtractOptions {
  logPath: string;
  memoryDir: string;
  agentId?: string;
  sessionId?: string;
  dryRun?: boolean;
  json?: boolean;
  /** Model name: omit for claude -p (default), or Ollama model e.g. "qwen2.5:14b" */
  model?: string;
  maxAtoms?: number;
  skipLines?: number;
  /** When true (default), run Tier-1 + Tier-2 conflict detection on every newly-created atom that has triples. Atoms without triples are not eligible (Tier-1 needs triples). */
  conflictDetect?: boolean;
  /** Model override for the Tier-2 LLM call. Falls back to `model` if omitted. */
  conflictConfirmModel?: string;
  /** When true, run a dedicated second LLM pass focused exclusively on preference extraction, using a prompt that enforces specific vocabulary preservation. Preferences found only in this pass are merged into the result. */
  preferencePass?: boolean;
  /** Max characters for the assembled prompt (system + user). Defaults to DEFAULT_MAX_INPUT_CHARS. Over-budget input fails pre-flight with ExtractInputTooLargeError unless `truncate` is set. */
  maxInputChars?: number;
  /** When true, an over-budget input is head-truncated (oldest content dropped, a visible marker appended) instead of throwing. Reported in ExtractResult.truncation. */
  truncate?: boolean;
}

/** Result returned by extractFromLog. */
export interface ExtractResult {
  extracted: number;
  skipped: number;
  possible_duplicates: number;
  /** Total auto-supersede actions across all atoms (action === 'superseded'). */
  conflicts: number;
  atoms: ExtractedAtomResult[];
  /** Present only when the input was head-truncated to fit the size budget (`truncate`). */
  truncation?: { original_chars: number; sent_chars: number; omitted_chars: number };
}

// --- Consolidate types ---

/** Options for consolidateAtoms. */
export interface ConsolidateOptions {
  memoryDir: string;
  agentId?: string;
  sessionId?: string;
  dryRun?: boolean;
  /** Include all draft atoms, not just auto-extracted ones. */
  all?: boolean;
  /** Only process drafts of this atom type. */
  type?: AtomType;
  /** Max atoms to process (default: 50). */
  limit?: number;
  /** BM25 rank threshold for duplicate detection (default: -2.0). */
  duplicateThreshold?: number;
}

export type ConsolidateAtomStatus = 'promoted' | 'skipped' | 'error' | 'would_promote' | 'would_skip';

/** Result for a single atom processed during consolidation. */
export interface ConsolidateAtomResult {
  atom_id: string;
  slug: string;
  type: string;
  status: ConsolidateAtomStatus;
  title: string;
  reason?: string;
  possible_duplicate_of?: string;
}

/** Result returned by consolidateAtoms. */
export interface ConsolidateResult {
  processed: number;
  promoted: number;
  skipped: number;
  errors: number;
  dry_run: boolean;
  atoms: ConsolidateAtomResult[];
}
