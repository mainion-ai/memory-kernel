/**
 * Content-addressed evidence store.
 * Stores artifacts (snapshots, diffs, tool outputs) as SHA-256 addressed blobs.
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const EVIDENCE_DIR = 'EVIDENCE';
const HASH_PATTERN = /^[0-9a-f]{64}$/;

/** Monotonic counter for unique tmp file names. */
let tmpCounter = 0;

/**
 * Validate a hash string is a valid 64-char lowercase hex SHA-256.
 * Prevents path traversal and malformed lookups.
 */
export function assertValidHash(hash: string): void {
  if (!HASH_PATTERN.test(hash)) {
    throw new Error(`Invalid evidence hash: ${hash}`);
  }
}

/**
 * Compute SHA-256 hash of a Buffer.
 */
export function hashEvidence(data: Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/**
 * Write evidence to the content-addressed store.
 * Returns the SHA-256 hex hash. Idempotent: same bytes = same hash = no-op.
 */
export function writeEvidence(memoryDir: string, data: Buffer): string {
  const hash = hashEvidence(data);
  const dir = path.join(memoryDir, EVIDENCE_DIR);
  const blobPath = path.join(dir, `${hash}.blob`);

  if (fs.existsSync(blobPath)) {
    return hash; // Already stored — content-addressed dedup
  }

  // Ensure directory exists
  fs.mkdirSync(dir, { recursive: true });

  // Atomic write (tmp → fsync → rename)
  const tmpPath = blobPath + `.tmp.${process.pid}.${++tmpCounter}.${Math.random().toString(36).slice(2, 6)}`;
  const fd = fs.openSync(tmpPath, 'w');
  try {
    fs.writeSync(fd, data, 0, data.length);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(tmpPath, blobPath);
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch { /* ignored */ }
    throw err;
  }

  return hash;
}

/**
 * Read evidence by hash. Throws if not found.
 */
export function readEvidence(memoryDir: string, hash: string): Buffer {
  assertValidHash(hash);
  const blobPath = path.join(memoryDir, EVIDENCE_DIR, `${hash}.blob`);
  if (!fs.existsSync(blobPath)) {
    throw new Error(`Evidence not found: ${hash}`);
  }
  return fs.readFileSync(blobPath);
}

/**
 * Check if evidence exists in the store.
 */
export function evidenceExists(memoryDir: string, hash: string): boolean {
  assertValidHash(hash);
  return fs.existsSync(path.join(memoryDir, EVIDENCE_DIR, `${hash}.blob`));
}

/**
 * List all evidence hashes in the store.
 */
export function listEvidence(memoryDir: string): string[] {
  const dir = path.join(memoryDir, EVIDENCE_DIR);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.blob') && !f.includes('.tmp.'))
    .map((f) => f.replace('.blob', ''))
    .sort();
}
