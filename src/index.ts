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
  KernelConfig,
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
} from './event-log.js';

// SQLite index
export {
  openIndex,
  indexExists,
  reindex,
  indexAtom,
  removeFromIndex,
  queryIndex,
  indexStats,
} from './index-db.js';
export type { IndexQueryResult } from './index-db.js';

// Operations
export { createAtom, updateAtom, archiveAtom } from './retain.js';
export { recall } from './recall.js';
export { reflect } from './reflect.js';
