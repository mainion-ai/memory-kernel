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
  DEFAULT_FILL_TYPE_RESERVATIONS,
  MUTATION_ACTIONS,
  isMutationAction,
} from './schema.js';

// Budget (two-pass type-aware token allocator shared by recall + render fill)
export {
  selectAtomsWithReservations,
  estimateTokens,
  MAX_RESERVATION_RATIO,
} from './budget.js';
export type { Pass2Mode } from './budget.js';

// Format
export {
  serializeAtom,
  serializeFrontmatter,
  parseAtom,
  normalizeTimestamp,
  normalizeTags,
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
export { createAtom, updateAtom, archiveAtom, resolveConflict, snapshotAtom } from './retain.js';
export {
  seedLifecycle,
  loadLifecycleManifest,
  canonicalLifecycleSlugs,
  canonicalLifecycleSet,
  resolveSeedDir,
  extractIdSlug,
  normalizeSlug,
} from './seed.js';
export type { LifecycleSeedEntry, SeedResult, SeedSlugResult, SeedAction, SeedLifecycleOptions } from './seed.js';
export { runUpgrade } from './upgrade.js';
export type { UpgradeOptions, UpgradeResult, UpgradeStep } from './upgrade.js';
export { markExecuted } from './execute.js';
export type { ExecuteOptions, ExecuteResult } from './execute.js';
export { editAtom } from './edit.js';
export type { EditOptions, EditResult, EditorRunner } from './edit.js';
export { detectUnprovenancedWrites, backfillHumanEdits } from './provenance.js';
export type {
  UnprovenancedWrite,
  DetectionConfidence,
  BackfillOptions,
  BackfillResult,
} from './provenance.js';
export type {
  RetainOptions,
  ResolveConflictOptions,
  ResolveConflictResult,
} from './retain.js';
export { recall, recallWithEmbeddings, computeLengthFactors, computeCoverageBoosts, computeTextSimilarity, applyMMR } from './recall.js';
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
export { renderClaudeMd, renderAgentClaudeMd } from './render.js';
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
  normalizeVector,
  dotProduct,
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
  extractConceptReferences,
  buildConceptMap,
  compileConceptPatterns,
  deduplicateRefs,
  inferRelationType,
  createAtomIdPattern,
  RELATION_CONTEXT,
} from './relink.js';
export type { ProposedRelation, RelinkResult, CompiledConceptPattern } from './relink.js';

// Citations (concept-name citation extraction)
export {
  extractCitations,
  indexCitations,
  deriveConceptNames,
} from './citations.js';
export type { CitationEntry, CitationResult } from './citations.js';

// Closure (operational closure metrics)
export { closure } from './closure.js';
export type { ClosureResult, TrajectoryPoint, ToolPrediction } from './closure.js';

// Enrich relations (LLM-based relation reclassification)
export { enrichRelations } from './enrich-relations.js';
export type { EnrichmentProposal, EnrichResult } from './enrich-relations.js';

// Isolated recall (agent + shared union)
export { recallIsolated, recallIsolatedWithEmbeddings } from './isolation-recall.js';
export type { IsolatedRecallOptions } from './isolation-recall.js';

// Share/unshare (per-agent isolation)
export { shareAtom, unshareAtom, listSharedAtoms } from './share.js';
export type { ShareResult, ShareOptions } from './share.js';

// Per-agent isolation
export {
  loadConfig,
  writeConfig,
  isIsolated,
  assertValidAgentId,
  resolveAgentDir,
  getSharedDir,
  listAgents,
  initAgentStore,
  initSharedStore,
  initIsolatedBase,
  loadRenderConfig,
  writeRenderConfig,
  DEFAULT_ISOLATION_CONFIG,
  DEFAULT_RENDER_CONFIG,
} from './isolation.js';
export type {
  IsolationConfig,
  RenderConfig,
  RenderMode,
} from './types.js';

// Lint (semantic health checking)
export { lintMemoryStore } from './lint.js';
export type { LintFinding, LintOptions, LintResult } from './lint.js';

// Grounding (confidence-vs-usage reconciliation — advisory/read-only, #245)
export {
  computeGrounding,
  classifyQuadrant,
  DEFAULT_HALF_LIVES,
  DEFAULT_HALF_LIFE,
  DEFAULT_ACCESS_HALF_SATURATION,
  DEFAULT_CONFLICT_DECAY,
  DEFAULT_PRIOR_THRESHOLD,
  DEFAULT_GROUNDING_THRESHOLD,
  DEFAULT_PROMOTE_MIN_SESSIONS,
  DEFAULT_NOISE_SESSIONS,
} from './grounding.js';
export type {
  GroundingQuadrant,
  GroundingOptions,
  GroundingInputs,
  GroundingReport,
  GroundingResult,
  ClassifyContext,
  QuadrantVerdict,
} from './grounding.js';

// Confidence write-back from grounding (Phase 2 — mutating, gated on #247) (#364)
export {
  reconcileGrounding,
  reconciledConfidence,
  DEFAULT_ALPHA_NEG,
  DEFAULT_ALPHA_POS,
  DEFAULT_MIN_DELTA,
} from './reconcile.js';
export type { ReconcileOptions, ReconcileResult, ReconcileChange } from './reconcile.js';

// Eval — golden-query recall runner (#300)
export { loadFixtures, runFixture, runEval, resolveEmbed, exitCodeForEval, EvalError, DEFAULT_TOP_K, DEFAULT_THRESHOLD } from './eval.js';
export type { EvalQuery, EvalFixture, EvalQueryResult, EvalResult, EmbedMode, RunEvalOptions } from './eval.js';

// Migration (shared → isolated)
export { migrate } from './migrate.js';
export type { MigrateStrategy, MigrateOptions, MigrateResult } from './migrate.js';

// Extract (automatic atom extraction from conversation logs)
export {
  extractFromLog,
  planExtractInput,
  ExtractInputTooLargeError,
  DEFAULT_MAX_INPUT_CHARS,
} from './extract.js';
export type { ExtractInputPlan } from './extract.js';
export type { ExtractOptions, ExtractResult, ExtractedAtomResult, CandidateAtom } from './types.js';

// LLM abstraction — runtime helpers (callLLM, resolveProvider) became internal
// in v1.19.0; types stay public for advanced consumers wiring custom providers.
export type { LLMProvider, CallLLMOptions } from './llm.js';

// Observe (extract compressed observations from conversation logs)
export { observeConversation } from './observe.js';
export type { ObserveOptions, ObserveResult } from './observe.js';

// Query classification (lightweight routing for recall strategies)
export { classifyQuery } from './classify-query.js';
export type { QueryRoute, ClassifyResult } from './classify-query.js';

// Consolidate (lifecycle pipeline for promoting draft atoms)
export { consolidateAtoms } from './consolidate.js';
export type { ConsolidateOptions, ConsolidateResult, ConsolidateAtomResult, ConsolidateAtomStatus } from './types.js';

// Triples (entity-relation store for Tier-1 semantic conflict detection)
export { insertTriples, getTriplesForAtom, findCandidateConflicts } from './triples.js';
export type { EntityTriple, TripleInput } from './types.js';
export type { ConflictCandidate } from './triples.js';

// Conflict detection (Tier-2 LLM confirmation + auto-supersede orchestration)
export { detectAndResolveConflicts, confirmConflictWithLLM } from './conflict-detect.js';
export type {
  ConflictResolution, ConflictAction,
  DetectAndResolveOptions, DetectAndResolveResult,
  ConfirmConflictInput, ConfirmConflictResult,
} from './conflict-detect.js';

// Obsidian-native compatibility
export {
  RELATIONS_SENTINEL,
  TYPE_COLORS,
  renderRelationsSection,
  stripRelationsSection,
  generateGraphConfig,
} from './obsidian.js';

// Machine-verifiable Zod schemas for `mk --json` command outputs (#301).
export {
  AtomOutputSchema,
  RecallOutputSchema,
  DoctorCheckResultSchema,
  DoctorOutputSchema,
  RememberOutputSchema,
  EvalQueryResultSchema,
  EvalResultSchema,
  EvalOutputSchema,
} from './schemas.js';
export type { RecallOutput, DoctorOutput, RememberOutput, EvalOutput } from './schemas.js';
