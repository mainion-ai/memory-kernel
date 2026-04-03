/**
 * Memory Kernel — public API
 */

// Types
export type {
  Atom,
  AtomFrontmatter,
  AtomType,
  AtomStatus,
  Classification,
  MemoryEvent,
  EventAction,
  RecallQuery,
  ContextBundle,
  ReflectResult,
  ReplayResult,
  BootstrapResult,
  CompactResult,
  KernelConfig,
  Episode,
  EpisodeMetadata,
} from './types.js';

// Re-export runtime constants so downstream integrations (e.g. schema builders)
// can stay in sync with the canonical atom type list.
export { ATOM_TYPES, ATOM_STATUSES, CLASSIFICATIONS, RELATION_TYPES } from './types.js';
export type { Relation, RelationType } from './types.js';

// Schema & validation
export {
  AtomFrontmatterSchema,
  MemoryEventSchema,
  validateAtomFrontmatter,
  validateEvent,
  generateAtomId,
  generateEventId,
  DEFAULT_TTLS,
  DEFAULT_TYPE_WEIGHTS,
  DEFAULT_CONFIDENCE_FLOOR,
  DEFAULT_TYPE_RESERVATIONS,
  MUTATION_ACTIONS,
  isMutationAction,
} from './schema.js';

// Format
export {
  serializeAtom,
  serializeFrontmatter,
  parseAtom,
  normalizeTimestamp,
} from './format.js';

// Store
export {
  initMemoryDir,
  writeFileAtomic,
  readAtom,
  writeAtom,
  listAtoms,
  listAtomFiles,
  atomFilePath,
  assertWithinDir,
  readView,
  writeView,
} from './store.js';

// Event log
export {
  appendEvent,
  readEvents,
  readEventsByAction,
  readEventsForAtoms,
  countEvents,
  compactLog,
  getLastEventId,
} from './event-log.js';

// SQLite index
export {
  openIndex,
  closeIndex,
  closeAllIndexes,
  indexExists,
  reindex,
  indexAtom,
  removeFromIndex,
  queryIndex,
  indexStats,
  searchFts,
  storeEmbedding,
  getAllEmbeddings,
  isEmbeddingStale,
  embeddingStats,
  getRelationsForAtom,
  addRelation,
  getAllRelations,
  getAllAtomIds,
} from './index-db.js';
export type { IndexQueryResult, AtomRelation } from './index-db.js';

// Renderers
export {
  renderIndex,
  renderDecisions,
  renderConstraints,
  renderOpenQuestions,
  renderHandoff,
} from './renderers.js';
export type { ViewBudget } from './renderers.js';

// Evidence store
export {
  hashEvidence,
  writeEvidence,
  readEvidence,
  evidenceExists,
  listEvidence,
  assertValidHash,
} from './evidence.js';

// Checkpoint
export { checkpoint } from './checkpoint.js';
export type { CheckpointOptions, CheckpointResult } from './checkpoint.js';

// Replay
export { replay, replayFromFile } from './replay.js';

// Bootstrap
export { bootstrapEvents } from './bootstrap.js';

// Operations
export { createAtom, updateAtom, archiveAtom, resolveConflict } from './retain.js';
export type {
  RetainOptions,
  ResolveConflictOptions,
  ResolveConflictResult,
} from './retain.js';
export { recall, recallWithEmbeddings } from './recall.js';
export { reflect } from './reflect.js';

// Merge
export { mergeEventLogs } from './merge.js';
export type { MergeOptions } from './merge.js';
export type { MergeResult } from './types.js';

// Episode store
export {
  writeEpisode,
  readEpisode,
  listEpisodes,
  linkEpisodeToAtom,
} from './episodes.js';
export type {
  WriteEpisodeOpts,
  WriteOperationOpts,
  ListEpisodesOptions,
} from './episodes.js';

// Import
export { importFromFile, previewImport } from './import.js';
export type { ImportFromFileOpts, ImportResult } from './import.js';

// Render
export { renderClaudeMd } from './render.js';
export type { RenderClaudeMdOptions } from './render.js';

// Wander (spreading activation)
export { wander, wanderFromFiles } from './wander.js';
export type { WanderOptions, WanderResult, Collision, ActivatedAtom } from './wander.js';

// Embeddings
export {
  getEmbeddingConfig,
  embedText,
  embedBatch,
  cosineSimilarity,
  serializeVector,
  deserializeVector,
  atomToEmbeddingText,
} from './embeddings.js';
export type { EmbeddingProvider, EmbeddingConfig, EmbedResult } from './embeddings.js';

// Embed sync (async embedding operations)
export { embedAtom, embedAllAtoms, semanticSearch, semanticSearchSync } from './embed-sync.js';

// Relink (body-text relation extraction)
export {
  relinkAll,
  relinkAtom,
  extractBodyReferences,
  inferRelationType,
  ATOM_ID_PATTERN,
  RELATION_CONTEXT,
} from './relink.js';
export type { ProposedRelation, RelinkResult } from './relink.js';
