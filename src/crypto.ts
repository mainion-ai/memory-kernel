/**
 * Encryption utilities for SECRET-classified atoms.
 *
 * Algorithm: AES-256-GCM (authenticated encryption — detects tampering).
 * Key source: MEMORY_ENCRYPTION_KEY env var (64-char hex or passphrase).
 *
 * Encrypted file format (single-line, detectable by prefix):
 *   MKENC:v1:<base64(12-byte IV)>:<base64(ciphertext + 16-byte auth tag)>
 */

import crypto from 'crypto';

const MAGIC = 'MKENC:v1:';
const IV_LENGTH = 12; // bytes — recommended for GCM
const TAG_LENGTH = 16; // bytes — GCM auth tag
const KEY_LENGTH = 32; // bytes — AES-256
const PBKDF2_SALT = 'memory-kernel-v1';
const PBKDF2_ITERATIONS = 100_000;

/**
 * Returns true if the content was encrypted by encryptAtom.
 */
export function isEncrypted(content: string): boolean {
  return content.startsWith(MAGIC);
}

/**
 * Encrypt atom content (frontmatter + body markdown) with AES-256-GCM.
 * Returns a single-line MKENC:v1:... string.
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
 * Typed error for missing encryption key — allows instanceof checks
 * instead of fragile string matching.
 */
export class EncryptionKeyMissingError extends Error {
  constructor(detail: string) {
    super(`Encrypted atom requires MEMORY_ENCRYPTION_KEY to be set: ${detail}`);
    this.name = 'EncryptionKeyMissingError';
  }
}
