/**
 * Issue #113: recall.ts must reject NaN values in query.type_weights.
 *
 * A NaN weight silently corrupts the score comparator (`scoreB - scoreA` →
 * `NaN`), producing a non-deterministic sort. Validate at entry and throw a
 * clear error rather than degrade silently.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  initMemoryDir,
  createAtom,
  closeAllIndexes,
  openIndex,
} from '../src/index.js';
import { recall } from '../src/recall.js';

const AGENT = 'test-agent';
const SESSION = 'test-session';
let testDir: string;

beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-issue-113-'));
  initMemoryDir(testDir);
  openIndex(testDir);
});

afterEach(() => {
  closeAllIndexes();
  fs.rmSync(testDir, { recursive: true, force: true });
});

const base = () => ({
  memoryDir: testDir,
  agent_id: AGENT,
  session_id: SESSION,
});

describe('recall: NaN in type_weights (issue #113)', () => {
  it('throws when query.type_weights contains NaN', () => {
    createAtom({ ...base(), type: 'fact', slug: 'a', body: 'alpha' });
    createAtom({ ...base(), type: 'belief', slug: 'b', body: 'beta' });

    expect(() =>
      recall(testDir, {
        task: 'alpha',
        type_weights: { fact: NaN },
      }),
    ).toThrow(/type_weights.*(finite|NaN)/i);
  });

  it('throws when query.type_weights contains Infinity', () => {
    createAtom({ ...base(), type: 'fact', slug: 'a', body: 'alpha' });

    expect(() =>
      recall(testDir, {
        task: 'alpha',
        type_weights: { fact: Infinity },
      }),
    ).toThrow(/type_weights.*finite/i);
  });

  it('accepts finite type_weights normally', () => {
    createAtom({ ...base(), type: 'fact', slug: 'a', body: 'alpha' });
    expect(() =>
      recall(testDir, {
        task: 'alpha',
        type_weights: { fact: 2.5 },
      }),
    ).not.toThrow();
  });

  it('throws when RECALL_TYPE_WEIGHTS env contains NaN', () => {
    createAtom({ ...base(), type: 'fact', slug: 'a', body: 'alpha' });
    const prev = process.env.RECALL_TYPE_WEIGHTS;
    process.env.RECALL_TYPE_WEIGHTS = JSON.stringify({ fact: null });
    try {
      // null coerces to 0 via Number? Actually JSON.parse keeps it null,
      // Object.assign overrides. Number.isFinite(null) === false.
      expect(() => recall(testDir, { task: 'alpha' })).toThrow(/type_weights.*finite/i);
    } finally {
      if (prev === undefined) delete process.env.RECALL_TYPE_WEIGHTS;
      else process.env.RECALL_TYPE_WEIGHTS = prev;
    }
  });
});
