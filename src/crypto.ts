/**
 * Encryption utilities for SECRET-classified atoms.
 *
 * Algorithm: AES-256-GCM (authenticated encryption — detects tampering).
 * Key source: MEMORY_ENCRYPTION_KEY env var (64-char hex or passphrase).
 *
 * Encrypted file formats (single-line, detectable by prefix):
 *   v1 (legacy, read-only via decryptAtomWithCredential):
 *     MKENC:v1:<base64(12-byte IV)>:<base64(ciphertext + 16-byte auth tag)>
 *   v2 (current — random per-file PBKDF2 salt):
 *     MKENC:v2:<base64(16-byte salt)>:<base64(12-byte IV)>:<base64(ciphertext + 16-byte auth tag)>
 */

import crypto from 'crypto';

const MAGIC = 'MKENC:v1:';
const MAGIC_V2 = 'MKENC:v2:';
const IV_LENGTH = 12; // bytes — recommended for GCM
const TAG_LENGTH = 16; // bytes — GCM auth tag
const KEY_LENGTH = 32; // bytes — AES-256
const PBKDF2_SALT = 'memory-kernel-v1';
const PBKDF2_SALT_LENGTH = 16; // bytes
const PBKDF2_ITERATIONS = 100_000;

/**
 * Returns true if the content was encrypted by encryptAtom or encryptAtomWithCredential.
 */
export function isEncrypted(content: string): boolean {
  return content.startsWith(MAGIC) || content.startsWith(MAGIC_V2);
}

/**
 * Encrypt atom content (frontmatter + body markdown) with AES-256-GCM.
 * Returns a single-line MKENC:v1:... string.
 *
 * @deprecated Use encryptAtomWithCredential / decryptAtomWithCredential instead.
 * Kept for backward compatibility with v1 envelopes.
 */
export function encryptAtom(plaintext: string, key: Buffer): string {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Concatenate ciphertext + auth tag for a single blob
  const payload = Buffer.concat([encrypted, tag]);
  return `${MAGIC}${iv.toString('base64')}:${payload.toString('base64')}`;
}

/**
 * Decrypt content produced by encryptAtom.
 * Throws if the key is wrong, the content is tampered, or the format is invalid.
 *
 * @deprecated Use encryptAtomWithCredential / decryptAtomWithCredential instead.
 * Kept for backward compatibility with v1 envelopes.
 */
export function decryptAtom(content: string, key: Buffer): string {
  if (!isEncrypted(content)) {
    throw new Error('Content is not in MKENC:v1 format');
  }
  const rest = content.slice(MAGIC.length);
  const colonIdx = rest.indexOf(':');
  if (colonIdx === -1) {
    throw new Error('Invalid MKENC:v1 format — missing IV/payload separator');
  }
  const iv = Buffer.from(rest.slice(0, colonIdx), 'base64');
  const payload = Buffer.from(rest.slice(colonIdx + 1), 'base64');
  if (iv.length !== IV_LENGTH) {
    throw new Error(`Invalid MKENC:v1 IV length: expected ${IV_LENGTH}, got ${iv.length}`);
  }
  if (payload.length < TAG_LENGTH) {
    throw new Error('Invalid MKENC:v1 payload — too short to contain auth tag');
  }
  const ciphertext = payload.subarray(0, payload.length - TAG_LENGTH);
  const tag = payload.subarray(payload.length - TAG_LENGTH);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  try {
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return decrypted.toString('utf8');
  } catch {
    throw new Error(
      'Decryption failed — wrong MEMORY_ENCRYPTION_KEY or tampered content',
    );
  }
}

/**
 * Resolve the encryption key from the environment value.
 *
 * - 64-char hex string → parsed directly as 32-byte key
 * - Any other non-empty string → PBKDF2 derivation (passphrase)
 * - undefined / empty → null (encryption disabled)
 *
 * @deprecated Use encryptAtomWithCredential / decryptAtomWithCredential instead.
 * Kept for backward compatibility with v1 envelopes.
 */
export function resolveKey(envValue: string | undefined): Buffer | null {
  if (!envValue) return null;
  if (/^[0-9a-fA-F]{64}$/.test(envValue)) {
    return Buffer.from(envValue, 'hex');
  }
  // Passphrase: deterministic PBKDF2 derivation
  return crypto.pbkdf2Sync(
    envValue,
    PBKDF2_SALT,
    PBKDF2_ITERATIONS,
    KEY_LENGTH,
    'sha256',
  );
}

/**
 * Derive an encryption key from a credential string and a salt.
 *
 * - If `envValue` is a 64-char hex string, return its raw bytes (salt ignored —
 *   pre-derived key has no PBKDF2 dependence on salt).
 * - Otherwise, treat `envValue` as a passphrase and derive via PBKDF2-SHA256
 *   with `salt` as the salt parameter.
 *
 * Internal; not exported.
 */
function deriveKey(envValue: string, salt: Buffer): Buffer {
  if (/^[0-9a-fA-F]{64}$/.test(envValue)) {
    return Buffer.from(envValue, 'hex');
  }
  return crypto.pbkdf2Sync(envValue, salt, PBKDF2_ITERATIONS, KEY_LENGTH, 'sha256');
}

/**
 * Encrypt atom content with a per-file random PBKDF2 salt.
 *
 * Emits a v2 envelope: `MKENC:v2:<base64(salt)>:<base64(iv)>:<base64(ciphertext+tag)>`.
 * For hex credentials, the salt is still emitted (random, ignored on decrypt) so
 * the format is uniform and the parser stays single-branch.
 *
 * Throws on empty credential.
 */
export function encryptAtomWithCredential(plaintext: string, envValue: string): string {
  if (!envValue) {
    throw new Error('encryptAtomWithCredential: credential is required');
  }
  const salt = crypto.randomBytes(PBKDF2_SALT_LENGTH);
  const iv = crypto.randomBytes(IV_LENGTH);
  const key = deriveKey(envValue, salt);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const payload = Buffer.concat([encrypted, tag]);
  return `${MAGIC_V2}${salt.toString('base64')}:${iv.toString('base64')}:${payload.toString('base64')}`;
}

/**
 * Decrypt content produced by encryptAtomWithCredential (v2) or
 * encryptAtom (v1, legacy). Routes by envelope prefix.
 *
 * Throws on invalid format, wrong credential, or tampered ciphertext.
 */
export function decryptAtomWithCredential(content: string, envValue: string): string {
  if (!envValue) {
    throw new Error('decryptAtomWithCredential: credential is required');
  }
  if (content.startsWith(MAGIC_V2)) {
    return decryptV2(content, envValue);
  }
  if (content.startsWith(MAGIC)) {
    // v1: legacy hardcoded salt for passphrase, raw bytes for hex
    const legacyKey = /^[0-9a-fA-F]{64}$/.test(envValue)
      ? Buffer.from(envValue, 'hex')
      : crypto.pbkdf2Sync(envValue, PBKDF2_SALT, PBKDF2_ITERATIONS, KEY_LENGTH, 'sha256');
    return decryptAtom(content, legacyKey);
  }
  throw new Error('Content is not in MKENC:v1 or MKENC:v2 format');
}

function decryptV2(content: string, envValue: string): string {
  const rest = content.slice(MAGIC_V2.length);
  const parts = rest.split(':');
  if (parts.length !== 3) {
    throw new Error('Invalid MKENC:v2 format — expected salt:iv:payload');
  }
  const [saltB64, ivB64, payloadB64] = parts;
  const salt = Buffer.from(saltB64, 'base64');
  const iv = Buffer.from(ivB64, 'base64');
  const payload = Buffer.from(payloadB64, 'base64');
  if (salt.length !== PBKDF2_SALT_LENGTH) {
    throw new Error(`Invalid MKENC:v2 salt length: expected ${PBKDF2_SALT_LENGTH}, got ${salt.length}`);
  }
  if (iv.length !== IV_LENGTH) {
    throw new Error(`Invalid MKENC:v2 IV length: expected ${IV_LENGTH}, got ${iv.length}`);
  }
  if (payload.length < TAG_LENGTH) {
    throw new Error('Invalid MKENC:v2 payload — too short to contain auth tag');
  }
  const ciphertext = payload.subarray(0, payload.length - TAG_LENGTH);
  const tag = payload.subarray(payload.length - TAG_LENGTH);
  const key = deriveKey(envValue, salt);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  try {
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return decrypted.toString('utf8');
  } catch {
    throw new Error(
      'Decryption failed — wrong MEMORY_ENCRYPTION_KEY or tampered content',
    );
  }
}

/**
 * Typed error for missing encryption key — allows instanceof checks
 * instead of fragile string matching.
 */
export class EncryptionKeyMissingError extends Error {
  constructor(detail: string) {
    super(`Encrypted atom requires MEMORY_ENCRYPTION_KEY to be set: ${detail}`);
    this.name = 'EncryptionKeyMissingError';
  }
}
