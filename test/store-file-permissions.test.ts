/**
 * Store-file permissions (#138).
 *
 * PR-7 (#137) chmoded SECRET atom files and the SQLite index to 0o600. The
 * remaining plaintext store files (events.ndjson, views, observations) kept
 * platform-default mode (typically 0o644). events.ndjson is the highest-
 * bandwidth surface: even though SECRET atom *bodies* are encrypted via
 * snapshotAtom, the event envelope (atom_refs, agent_id, session_id,
 * touched_paths) is plaintext and leaks the *existence and names* of
 * SECRET atoms to any local reader.
 *
 * This test pins the post-fix invariant: events.ndjson is 0o600 across the
 * three write paths (init, append, compact) and views written via writeView
 * are 0o600 too. Tests skip on Windows because fs.chmodSync is a no-op there.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { initMemoryDir, writeView } from '../src/store.js';
import { appendEvent, compactLog } from '../src/event-log.js';
import { createAtom } from '../src/retain.js';
import { closeAllIndexes } from '../src/index-db.js';

const isPosix = process.platform !== 'win32';
const itPosix = isPosix ? it : it.skip;

let memoryDir: string;

beforeEach(() => {
  memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-store-perms-'));
  initMemoryDir(memoryDir);
});

afterEach(() => {
  closeAllIndexes();
  fs.rmSync(memoryDir, { recursive: true, force: true });
});

const mode = (p: string) => fs.statSync(p).mode & 0o777;

describe('Store file 0o600 permissions (#138)', () => {
  itPosix('events.ndjson is created with 0o600 by initMemoryDir', () => {
    const logPath = path.join(memoryDir, 'events.ndjson');
    expect(fs.existsSync(logPath)).toBe(true);
    expect(mode(logPath)).toBe(0o600);
  });

  itPosix('events.ndjson stays 0o600 after appendEvent', () => {
    const logPath = path.join(memoryDir, 'events.ndjson');
    // Pre-condition: file exists at 0o600 from init. Now mutate it to 0o644
    // and verify appendEvent re-chmods to 0o600 — covers the upgrade path
    // for stores created before PR-12.
    fs.chmodSync(logPath, 0o644);
    expect(mode(logPath)).toBe(0o644);

    appendEvent(memoryDir, 'session_started', {
      agent_id: 'test',
      session_id: 'test-session',
    });
    expect(mode(logPath)).toBe(0o600);
  });

  itPosix('events.ndjson stays 0o600 after compactLog rewrites the file', () => {
    // Generate enough events for compactLog to actually rewrite the file
    // (compactLog short-circuits when no events would be removed). Two
    // creates against the same atom_id leaves one redundant atom_imported
    // event, which compactLog removes.
    const atom = createAtom({
      memoryDir,
      agent_id: 'test',
      session_id: 'test-session',
      type: 'fact',
      slug: 'compact-test',
      body: 'first body',
    });
    // Force a second mutation event referencing the same atom so compactLog
    // has something to compact away.
    appendEvent(memoryDir, 'atom_updated', {
      agent_id: 'test',
      session_id: 'test-session',
      atom_refs: [atom.frontmatter.id],
    });
    appendEvent(memoryDir, 'atom_updated', {
      agent_id: 'test',
      session_id: 'test-session',
      atom_refs: [atom.frontmatter.id],
    });

    const logPath = path.join(memoryDir, 'events.ndjson');
    // Sanity: tamper with mode to make sure compactLog actually re-applies it.
    fs.chmodSync(logPath, 0o644);
    const result = compactLog(memoryDir);
    expect(result.removed).toBeGreaterThan(0);
    expect(mode(logPath)).toBe(0o600);
  });

  itPosix('writeView writes view files with 0o600', () => {
    writeView(memoryDir, 'INDEX.md', '# test view\n');
    const viewPath = path.join(memoryDir, 'INDEX.md');
    expect(mode(viewPath)).toBe(0o600);
  });

  itPosix('initMemoryDir writes its initial view files with 0o600', () => {
    // initMemoryDir runs in beforeEach; verify the view files it created on
    // first call are 0o600 (regression guard for the call path through
    // writeFileAtomic without an explicit mode arg).
    const viewFiles = ['INDEX.md', 'HANDOFF.md', 'CONSTRAINTS.md', 'DECISIONS.md', 'OPEN_QUESTIONS.md'];
    for (const v of viewFiles) {
      const p = path.join(memoryDir, v);
      if (!fs.existsSync(p)) continue; // some templates are optional
      expect({ file: v, mode: mode(p).toString(8) }).toEqual({ file: v, mode: '600' });
    }
  });
});
