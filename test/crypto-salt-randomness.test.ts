import { describe, it, expect } from 'vitest';
import { encryptAtomWithCredential, decryptAtomWithCredential } from '../src/crypto.js';

const PASSPHRASE = 'correct horse battery staple';
const HEX_KEY = 'a'.repeat(64);
const PLAINTEXT = '---\nid: TEST\n---\nhello';

describe('encryptAtomWithCredential — random salt per file', () => {
  it('produces a v2 envelope with a fresh salt on every call (passphrase)', () => {
    const enc1 = encryptAtomWithCredential(PLAINTEXT, PASSPHRASE);
    const enc2 = encryptAtomWithCredential(PLAINTEXT, PASSPHRASE);
    expect(enc1).toMatch(/^MKENC:v2:/);
    expect(enc2).toMatch(/^MKENC:v2:/);
    const saltOf = (e: string) => e.split(':')[2];
    expect(saltOf(enc1)).not.toBe(saltOf(enc2));
    expect(decryptAtomWithCredential(enc1, PASSPHRASE)).toBe(PLAINTEXT);
    expect(decryptAtomWithCredential(enc2, PASSPHRASE)).toBe(PLAINTEXT);
  });

  it('produces a v2 envelope for hex credentials too (uniform format)', () => {
    const enc = encryptAtomWithCredential(PLAINTEXT, HEX_KEY);
    expect(enc).toMatch(/^MKENC:v2:/);
    expect(decryptAtomWithCredential(enc, HEX_KEY)).toBe(PLAINTEXT);
  });

  it('rejects an empty credential on encrypt', () => {
    expect(() => encryptAtomWithCredential(PLAINTEXT, '')).toThrow();
  });

  it('rejects an empty credential on decrypt', () => {
    expect(() => decryptAtomWithCredential('MKENC:v2:aaa:bbb:ccc', '')).toThrow();
  });
});
