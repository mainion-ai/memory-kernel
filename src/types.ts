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
}

// --- Relation types (Phase 3) ---

export const RELATION_TYPES = [
  'extends',
  'contradicts',
  'supports',
  'caused_by',
  'supersedes',
  'related',
] as const;

export type RelationType = (typeof RELATION_TYPES)[number];

export interface Relation {
  target: string; // Atom ID
  type: RelationType;
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
  'atom_read',
  'checkpoint_created',
  'conflict_detected',
  'conflict_resolved',
  'human_edit',
  'reflect_completed',
  'gc_completed',
  'session_started',
  'session_ended',
  'merge_completed',
] as const;

export type EventAction = (typeof EVENT_ACTIONS)[number];

export interface MemoryEvent {
  event_id: string; // ULID or UUID
  timestamp: string; // ISO8601 UTC
  agent_id: string;
  session_id: string;
  action: EventAction;
  atom_refs?: string[]; // Atom IDs affected
  touched_paths?: string[]; // File/scope paths
  evidence?: string[]; // Evidence pointers (hashes, file refs)
  meta?: Record<string, unknown>; // Extra context
  // V2 fields (optional for backward compat with v1 events)
  schema_version?: 2; // Present on v2 events
  atom_snapshot?: string; // Serialized atom (frontmatter+body markdown)
  atom_snapshot_hash?: string; // SHA-256 hash if snapshot stored in evidence
}

// --- Recall query ---

export interface RecallQuery {
  task?: string; // Natural language task — used for FTS-based re-ranking
  paths?: string[]; // Scope paths to match
  types?: AtomType[]; // Filter by atom type
  statuses?: AtomStatus[]; // Filter by status
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
}

// --- Reflect result ---

export interface ReflectResult {
  deduped: number;
  expired: number;
  promoted: number;
  archived: number;
  conflicts_found: number;
  events_emitted: number;
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
