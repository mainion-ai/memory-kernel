/**
 * Tests for the memory-store doctor checks (#140): store-schema, store-
 * permissions, render-config. Drive each against a real but throwaway
 * memory directory.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

import { initMemoryDir, createAtom, closeAllIndexes, openIndex, reindex, bootstrapEvents } from '../src/index.js';
import { initIsolatedBase, initAgentStore } from '../src/isolation.js';
import { storeSchemaCheck } from '../src/doctor/checks/store-schema.js';
import { storePermissionsCheck } from '../src/doctor/checks/store-permissions.js';
import { renderConfigCheck } from '../src/doctor/checks/render-config.js';
import type { DoctorContext } from '../src/doctor/types.js';

let testDir: string;

function ctx(): DoctorContext {
  return {
    memoryDir: testDir,
    kernelVersion: '1.19.4',
    skipCategories: new Set(),
    env: {},
  };
}

beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-doctor-store-'));
});

afterEach(() => {
  closeAllIndexes();
  fs.rmSync(testDir, { recursive: true, force: true });
});

describe('storeSchemaCheck', () => {
  it('passes when events.ndjson and a current-schema index.db are present', () => {
    initMemoryDir(testDir);
    // Open + close to materialize the index.db with current schema version.
    openIndex(testDir);
    closeAllIndexes();

    const result = storeSchemaCheck.run(ctx()) as Awaited<ReturnType<typeof storeSchemaCheck.run>>;
    expect(result.ok).toBe(true);
  });

  it('flags missing events.ndjson', () => {
    // Build a barely-there memory dir without the events file.
    fs.mkdirSync(testDir, { recursive: true });
    const result = storeSchemaCheck.run(ctx()) as Awaited<ReturnType<typeof storeSchemaCheck.run>>;
    expect(result.ok).toBe(false);
    expect(result.issues.join('\n')).toContain('events.ndjson missing');
  });
});

describe('storePermissionsCheck', () => {
  it('passes when index.db is 0o600 and there are no SECRET atoms', () => {
    if (process.platform === 'win32') return; // chmod is a no-op on win32
    initMemoryDir(testDir);
    reindex(testDir);
    closeAllIndexes();

    const result = storePermissionsCheck.run(ctx()) as Awaited<ReturnType<typeof storePermissionsCheck.run>>;
    expect(result.ok).toBe(true);
  });

  it('flags index.db with a permissive mode', () => {
    if (process.platform === 'win32') return;
    initMemoryDir(testDir);
    reindex(testDir);
    closeAllIndexes();
    const dbPath = path.join(testDir, '.memory-index.db');
    fs.chmodSync(dbPath, 0o644);

    const result = storePermissionsCheck.run(ctx()) as Awaited<ReturnType<typeof storePermissionsCheck.run>>;
    expect(result.ok).toBe(false);
    expect(result.issues.join('\n')).toContain('.memory-index.db has mode 644');
  });

  // #389 — the NDJSON sidecars hold SECRET-derived content and are written 0o600;
  // the audit must catch a drifted mode on them too.
  it('flags a permissive events.ndjson sidecar', () => {
    if (process.platform === 'win32') return;
    initMemoryDir(testDir);
    reindex(testDir);
    closeAllIndexes();
    const eventsPath = path.join(testDir, 'events.ndjson');
    fs.writeFileSync(eventsPath, '{"action":"x"}\n');
    fs.chmodSync(eventsPath, 0o644);

    const result = storePermissionsCheck.run(ctx()) as Awaited<ReturnType<typeof storePermissionsCheck.run>>;
    expect(result.ok).toBe(false);
    expect(result.issues.join('\n')).toContain('events.ndjson has mode 644');
  });

  it('flags a permissive triples.ndjson sidecar', () => {
    if (process.platform === 'win32') return;
    initMemoryDir(testDir);
    reindex(testDir);
    closeAllIndexes();
    const triplesPath = path.join(testDir, 'triples.ndjson');
    fs.writeFileSync(triplesPath, '{"atom_id":"A","subject":"s","predicate":"p","object":"o"}\n');
    fs.chmodSync(triplesPath, 0o600); // start clean
    let result = storePermissionsCheck.run(ctx()) as Awaited<ReturnType<typeof storePermissionsCheck.run>>;
    expect(result.ok).toBe(true); // a 0o600 sidecar must not be flagged

    fs.chmodSync(triplesPath, 0o640);
    result = storePermissionsCheck.run(ctx()) as Awaited<ReturnType<typeof storePermissionsCheck.run>>;
    expect(result.ok).toBe(false);
    expect(result.issues.join('\n')).toContain('triples.ndjson has mode 640');
  });

  // #389 regression: bootstrapEvents rewrites events.ndjson via writeFileAtomic.
  // Without an explicit 0o600 it landed at the umask default (0o644) and the
  // sidecar check would false-positive a healthy post-bootstrap store. Exercise
  // the real write path, not a hand-set mode.
  it('keeps events.ndjson 0o600 after bootstrapEvents (no false positive)', () => {
    if (process.platform === 'win32') return;
    initMemoryDir(testDir);
    createAtom({ memoryDir: testDir, agent_id: 'a', session_id: 's', type: 'fact', slug: 'paris', body: 'Capital is Paris.' });
    closeAllIndexes();
    bootstrapEvents({ memoryDir: testDir, agent_id: 'a', session_id: 's' });

    expect(fs.statSync(path.join(testDir, 'events.ndjson')).mode & 0o777).toBe(0o600);
    const result = storePermissionsCheck.run(ctx()) as Awaited<ReturnType<typeof storePermissionsCheck.run>>;
    expect(result.ok).toBe(true);
  });
});

describe('renderConfigCheck', () => {
  it('is a no-op (skipped) in shared (non-isolated) mode', () => {
    initMemoryDir(testDir);
    const result = renderConfigCheck.run(ctx()) as Awaited<ReturnType<typeof renderConfigCheck.run>>;
    expect(result.ok).toBe(true);
    expect(result.skipped).toBeDefined();
  });

  it('passes when an isolated memory dir has valid render.yaml per agent', () => {
    initIsolatedBase(testDir, 'huston');
    initAgentStore(testDir, 'mai');
    const result = renderConfigCheck.run(ctx()) as Awaited<ReturnType<typeof renderConfigCheck.run>>;
    expect(result.ok).toBe(true);
    expect(result.skipped).toBeUndefined();
  });

  it('flags missing render.yaml in an agent dir', () => {
    initIsolatedBase(testDir, 'huston');
    initAgentStore(testDir, 'mai');
    fs.unlinkSync(path.join(testDir, 'agents', 'mai', 'render.yaml'));

    const result = renderConfigCheck.run(ctx()) as Awaited<ReturnType<typeof renderConfigCheck.run>>;
    expect(result.ok).toBe(false);
    expect(result.issues.join('\n')).toContain('mai');
    expect(result.issues.join('\n')).toContain('render.yaml missing');
  });

  it('flags an invalid render.yaml', () => {
    initIsolatedBase(testDir, 'huston');
    initAgentStore(testDir, 'mai');
    const renderPath = path.join(testDir, 'agents', 'mai', 'render.yaml');
    // Truly broken: unbalanced flow-style mapping.
    fs.writeFileSync(renderPath, '{ broken: [unbalanced\n');

    const result = renderConfigCheck.run(ctx()) as Awaited<ReturnType<typeof renderConfigCheck.run>>;
    expect(result.ok).toBe(false);
    expect(result.issues.join('\n')).toContain('mai');
    expect(result.issues.join('\n')).toContain('invalid');
  });
});
