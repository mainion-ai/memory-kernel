import { describe, it, expect } from 'vitest';
import { encryptAtom, resolveKey, decryptAtomWithCredential } from '../src/crypto.js';

const PASSPHRASE = 'old-passphrase-from-2025';
const HEX_KEY = 'b'.repeat(64);
const PLAINTEXT = '---\nid: LEGACY-TEST\n---\nlegacy body';

describe('decryptAtomWithCredential — v1 envelope back-compat', () => {
  it('decrypts a v1 envelope produced by the legacy passphrase path', () => {
    const legacyKey = resolveKey(PASSPHRASE)!;
    const v1Envelope = encryptAtom(PLAINTEXT, legacyKey);
    expect(v1Envelope).toMatch(/^MKENC:v1:/);
    expect(decryptAtomWithCredential(v1Envelope, PASSPHRASE)).toBe(PLAINTEXT);
  });

  it('decrypts a v1 envelope produced by the legacy hex-key path', () => {
    const legacyKey = resolveKey(HEX_KEY)!;
    const v1Envelope = encryptAtom(PLAINTEXT, legacyKey);
    expect(v1Envelope).toMatch(/^MKENC:v1:/);
    expect(decryptAtomWithCredential(v1Envelope, HEX_KEY)).toBe(PLAINTEXT);
  });

  it('throws on a v1 envelope with the wrong credential', () => {
    const legacyKey = resolveKey(PASSPHRASE)!;
    const v1Envelope = encryptAtom(PLAINTEXT, legacyKey);
    expect(() => decryptAtomWithCredential(v1Envelope, 'wrong-passphrase')).toThrow();
  });

  it('throws on content that is neither v1 nor v2', () => {
    expect(() => decryptAtomWithCredential('plain text not encrypted', PASSPHRASE)).toThrow();
  });
});
