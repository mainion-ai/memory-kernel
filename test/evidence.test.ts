/**
 * Evidence store tests — content-addressed blob storage.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';

import { initMemoryDir } from '../src/index.js';
import {
  hashEvidence,
  writeEvidence,
  readEvidence,
  evidenceExists,
  listEvidence,
  assertValidHash,
} from '../src/evidence.js';

let testDir: string;

beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-evidence-'));
  initMemoryDir(testDir);
});

afterEach(() => {
  fs.rmSync(testDir, { recursive: true, force: true });
});

describe('hashEvidence', () => {
  it('returns a 64-char lowercase hex string', () => {
    const hash = hashEvidence(Buffer.from('hello'));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic', () => {
    const data = Buffer.from('test data');
    expect(hashEvidence(data)).toBe(hashEvidence(data));
  });

  it('matches Node.js crypto SHA-256', () => {
    const data = Buffer.from('verify against crypto');
    const expected = crypto.createHash('sha256').update(data).digest('hex');
    expect(hashEvidence(data)).toBe(expected);
  });

  it('produces different hashes for different data', () => {
    const h1 = hashEvidence(Buffer.from('alpha'));
    const h2 = hashEvidence(Buffer.from('beta'));
    expect(h1).not.toBe(h2);
  });
});

describe('writeEvidence', () => {
  it('returns a 64-char hex hash', () => {
    const hash = writeEvidence(testDir, Buffer.from('content'));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('creates a .blob file in EVIDENCE/', () => {
    const hash = writeEvidence(testDir, Buffer.from('content'));
    const blobPath = path.join(testDir, 'EVIDENCE', `${hash}.blob`);
    expect(fs.existsSync(blobPath)).toBe(true);
  });

  it('is idempotent — same data returns same hash, single file', () => {
    const data = Buffer.from('idempotent test');
    const h1 = writeEvidence(testDir, data);
    const h2 = writeEvidence(testDir, data);
    expect(h1).toBe(h2);

    // Only one blob file
    const files = fs.readdirSync(path.join(testDir, 'EVIDENCE')).filter((f) => f.endsWith('.blob'));
    expect(files).toHaveLength(1);
  });

  it('stores different data as separate blobs', () => {
    writeEvidence(testDir, Buffer.from('data-1'));
    writeEvidence(testDir, Buffer.from('data-2'));

    const files = fs.readdirSync(path.join(testDir, 'EVIDENCE')).filter((f) => f.endsWith('.blob'));
    expect(files).toHaveLength(2);
  });

  it('handles empty buffer', () => {
    const hash = writeEvidence(testDir, Buffer.alloc(0));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(evidenceExists(testDir, hash)).toBe(true);
  });

  it('handles large buffer (1 MB)', () => {
    const data = Buffer.alloc(1024 * 1024, 0x42);
    const hash = writeEvidence(testDir, data);
    const read = readEvidence(testDir, hash);
    expect(read.length).toBe(1024 * 1024);
    expect(read.equals(data)).toBe(true);
  });
});

describe('readEvidence', () => {
  it('returns exact bytes that were written', () => {
    const data = Buffer.from('round trip test');
    const hash = writeEvidence(testDir, data);
    const read = readEvidence(testDir, hash);
    expect(read.equals(data)).toBe(true);
  });

  it('throws for nonexistent hash', () => {
    const fakeHash = 'a'.repeat(64);
    expect(() => readEvidence(testDir, fakeHash)).toThrow('Evidence not found');
  });

  it('rejects invalid hash format', () => {
    expect(() => readEvidence(testDir, 'bad-hash')).toThrow('Invalid evidence hash');
  });

  it('rejects path traversal attempts', () => {
    expect(() => readEvidence(testDir, '../../../etc/passwd' + 'x'.repeat(46))).toThrow(
      'Invalid evidence hash',
    );
  });

  it('round-trips binary data (non-UTF8)', () => {
    const data = Buffer.from([0x00, 0xff, 0x80, 0x7f, 0xfe, 0x01]);
    const hash = writeEvidence(testDir, data);
    const read = readEvidence(testDir, hash);
    expect(read.equals(data)).toBe(true);
  });
});

describe('evidenceExists', () => {
  it('returns true for stored evidence', () => {
    const hash = writeEvidence(testDir, Buffer.from('exists'));
    expect(evidenceExists(testDir, hash)).toBe(true);
  });

  it('returns false for missing evidence', () => {
    const fakeHash = 'b'.repeat(64);
    expect(evidenceExists(testDir, fakeHash)).toBe(false);
  });

  it('rejects invalid hash format', () => {
    expect(() => evidenceExists(testDir, 'not-a-hash')).toThrow('Invalid evidence hash');
  });
});

describe('listEvidence', () => {
  it('returns empty array for empty store', () => {
    expect(listEvidence(testDir)).toEqual([]);
  });

  it('returns all stored hashes', () => {
    const h1 = writeEvidence(testDir, Buffer.from('one'));
    const h2 = writeEvidence(testDir, Buffer.from('two'));
    const h3 = writeEvidence(testDir, Buffer.from('three'));

    const list = listEvidence(testDir);
    expect(list).toHaveLength(3);
    expect(list).toContain(h1);
    expect(list).toContain(h2);
    expect(list).toContain(h3);
  });

  it('returns sorted hashes', () => {
    writeEvidence(testDir, Buffer.from('z'));
    writeEvidence(testDir, Buffer.from('a'));
    writeEvidence(testDir, Buffer.from('m'));

    const list = listEvidence(testDir);
    expect(list).toEqual([...list].sort());
  });

  it('excludes temp files', () => {
    writeEvidence(testDir, Buffer.from('real'));
    // Create a fake temp file
    fs.writeFileSync(path.join(testDir, 'EVIDENCE', 'fake.blob.tmp.12345'), 'junk');

    const list = listEvidence(testDir);
    expect(list).toHaveLength(1);
  });

  it('returns empty array when EVIDENCE/ dir missing', () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-noevidence-'));
    try {
      expect(listEvidence(emptyDir)).toEqual([]);
    } finally {
      fs.rmSync(emptyDir, { recursive: true, force: true });
    }
  });
});

describe('assertValidHash', () => {
  it('accepts valid 64-char hex hash', () => {
    expect(() => assertValidHash('a'.repeat(64))).not.toThrow();
    expect(() => assertValidHash('0123456789abcdef'.repeat(4))).not.toThrow();
  });

  it('rejects too-short hash', () => {
    expect(() => assertValidHash('abc')).toThrow('Invalid evidence hash');
  });

  it('rejects too-long hash', () => {
    expect(() => assertValidHash('a'.repeat(65))).toThrow('Invalid evidence hash');
  });

  it('rejects uppercase hex', () => {
    expect(() => assertValidHash('A'.repeat(64))).toThrow('Invalid evidence hash');
  });

  it('rejects non-hex characters', () => {
    expect(() => assertValidHash('g'.repeat(64))).toThrow('Invalid evidence hash');
  });

  it('rejects path traversal characters', () => {
    expect(() => assertValidHash('../' + 'a'.repeat(61))).toThrow('Invalid evidence hash');
  });
});
