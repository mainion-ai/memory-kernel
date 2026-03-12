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

// Schema & validation
export {
  AtomFrontmatterSchema,
  MemoryEventSchema,
  validateAtomFrontmatter,
  validateEvent,
  generateAtomId,
  generateEventId,
  DEFAULT_TTLS,
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
} from './index-db.js';
export type { IndexQueryResult } from './index-db.js';

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
export { recall } from './recall.js';
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
