/**
 * Crypto module tests — AES-256-GCM encryption utilities.
 */

import { describe, it, expect } from 'vitest';
import { isEncrypted, encryptAtom, decryptAtom, resolveKey } from '../src/crypto.js';

const HEX_KEY = 'a'.repeat(64); // Valid 64-char hex key
const PASSPHRASE = 'my-test-passphrase';
const PLAINTEXT = '---\nid: FACT-2026-01-01-TEST-abc1\ntype: fact\n---\n\nTest body.';

describe('isEncrypted', () => {
  it('returns true for MKENC:v1: prefixed strings', () => {
    expect(isEncrypted('MKENC:v1:abc:def')).toBe(true);
  });

  it('returns false for plaintext atom content', () => {
    expect(isEncrypted('---\nid: FACT-2026-01-01-TEST\n---\n')).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(isEncrypted('')).toBe(false);
  });
});

describe('resolveKey', () => {
  it('returns null for undefined', () => {
    expect(resolveKey(undefined)).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(resolveKey('')).toBeNull();
  });

  it('parses a 64-char hex string to a 32-byte Buffer', () => {
    const key = resolveKey(HEX_KEY);
    expect(key).not.toBeNull();
    expect(key!.length).toBe(32);
  });

  it('derives a 32-byte key from a passphrase', () => {
    const key = resolveKey(PASSPHRASE);
    expect(key).not.toBeNull();
    expect(key!.length).toBe(32);
  });

  it('produces the same key from the same passphrase (deterministic)', () => {
    const key1 = resolveKey(PASSPHRASE);
    const key2 = resolveKey(PASSPHRASE);
    expect(key1!.equals(key2!)).toBe(true);
  });

  it('produces different keys from different passphrases', () => {
    const key1 = resolveKey('passphrase-one');
    const key2 = resolveKey('passphrase-two');
    expect(key1!.equals(key2!)).toBe(false);
  });
});

describe('encryptAtom / decryptAtom round-trip', () => {
  it('produces a MKENC:v1: prefixed string', () => {
    const key = resolveKey(HEX_KEY)!;
    const encrypted = encryptAtom(PLAINTEXT, key);
    expect(isEncrypted(encrypted)).toBe(true);
  });

  it('decrypts back to the original plaintext (hex key)', () => {
    const key = resolveKey(HEX_KEY)!;
    const encrypted = encryptAtom(PLAINTEXT, key);
    const decrypted = decryptAtom(encrypted, key);
    expect(decrypted).toBe(PLAINTEXT);
  });

  it('decrypts back to the original plaintext (passphrase key)', () => {
    const key = resolveKey(PASSPHRASE)!;
    const encrypted = encryptAtom(PLAINTEXT, key);
    const decrypted = decryptAtom(encrypted, key);
    expect(decrypted).toBe(PLAINTEXT);
  });

  it('produces different ciphertext each call (random IV)', () => {
    const key = resolveKey(HEX_KEY)!;
    const enc1 = encryptAtom(PLAINTEXT, key);
    const enc2 = encryptAtom(PLAINTEXT, key);
    expect(enc1).not.toBe(enc2);
    // But both decrypt correctly
    expect(decryptAtom(enc1, key)).toBe(PLAINTEXT);
    expect(decryptAtom(enc2, key)).toBe(PLAINTEXT);
  });

  it('throws on wrong key', () => {
    const key1 = resolveKey(HEX_KEY)!;
    const key2 = resolveKey('b'.repeat(64))!;
    const encrypted = encryptAtom(PLAINTEXT, key1);
    expect(() => decryptAtom(encrypted, key2)).toThrow();
  });

  it('throws on tampered ciphertext', () => {
    const key = resolveKey(HEX_KEY)!;
    const encrypted = encryptAtom(PLAINTEXT, key);
    // Flip the last character of the payload
    const tampered = encrypted.slice(0, -2) + (encrypted.endsWith('==') ? 'AB' : '==');
    expect(() => decryptAtom(tampered, key)).toThrow();
  });

  it('throws when called with non-MKENC content', () => {
    const key = resolveKey(HEX_KEY)!;
    expect(() => decryptAtom(PLAINTEXT, key)).toThrow('MKENC:v1');
  });

  it('handles multi-line content with special characters', () => {
    const content = '---\nid: FACT-2026-01-01-SPECIAL\n---\n\nLine 1\nLine 2\n特殊文字 🔑\n```code block```\n';
    const key = resolveKey(HEX_KEY)!;
    expect(decryptAtom(encryptAtom(content, key), key)).toBe(content);
  });
});
