/**
 * Event-log compactLog ↔ appendEvent race (#98).
 *
 * compactLog reads → filters → writes new file → renames. Before this PR,
 * any appendEvent that landed between compactLog's re-read and the rename
 * inside writeFileAtomic was silently lost: the rename clobbered the
 * post-append on-disk file with the pre-append `finalCompacted` content,
 * even though `fsync` had returned successfully.
 *
 * These tests pin the post-fix invariant via the `MK_COMPACT_LOG_TEST_HOOK_PATH`
 * env-var hook in src/event-log.ts. The hook runs a child-process script
 * between the re-read and the rename, forcing a foreign-process appendEvent
 * the in-process re-read cannot see. With the lock in place, the appendEvent
 * waits for compactLog's lock to release, and compactLog sees the appended
 * event on a subsequent read (or, in the parent-only assertion shape used
 * here, the appended event is still present in the final events.ndjson
 * because the lock-protected appender wrote AFTER the compactor's rename).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Worker } from 'worker_threads';
import { pathToFileURL } from 'node:url';
import { appendEvent, compactLog, readEvents } from '../src/event-log.js';
import { initMemoryDir } from '../src/store.js';

let testDir: string;
let hookScript: string;

beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-compact-race-'));
  initMemoryDir(testDir);

  // Write a small Node script that, given a memoryDir as its final arg,
  // appends a single 'session_started' event with a known meta marker
  // and touches a sentinel file when done. The hook in src/event-log.ts
  // spawns this script and continues holding the lock for ~250ms, so the
  // child's appendEvent must block on the lock until compactLog releases.
  // We use the compiled dist/ so the script runs without tsx. Written as
  // an .mjs file so the spawned Node process treats dist/event-log.js
  // (an ESM module under `"type": "module"`) as a normal import — pre-fix
  // this was a .cjs requiring an ESM file, which Node 18 rejects.
  hookScript = path.join(testDir, 'race-hook.mjs');
  const distEventLog = pathToFileURL(path.resolve('dist/event-log.js')).href;
  fs.writeFileSync(hookScript, `
    import fs from 'node:fs';
    import path from 'node:path';
    import { appendEvent } from '${distEventLog}';
    const memoryDir = process.argv[process.argv.length - 1];
    appendEvent(memoryDir, 'session_started', {
      agent_id: 'race-hook',
      session_id: 'race-hook-session',
      meta: { injected_by: 'race-hook' },
    });
    fs.writeFileSync(path.join(memoryDir, 'race-hook.done'), 'done');
  `);
});

afterEach(() => {
  delete process.env.MK_COMPACT_LOG_TEST_HOOK_PATH;
  fs.rmSync(testDir, { recursive: true, force: true });
});

/**
 * Seed N "compactable" mutation events for the same atom. compactLog will
 * remove all but the latest, ensuring the write path actually runs (it
 * short-circuits when removed === 0).
 */
function seedCompactableEvents(memoryDir: string, atomId: string, count: number): void {
  for (let i = 0; i < count; i++) {
    appendEvent(memoryDir, i === 0 ? 'atom_created' : 'atom_updated', {
      agent_id: 'seed',
      session_id: 'seed-session',
      atom_refs: [atomId],
      meta: { iteration: i },
    });
  }
}

describe('compactLog ↔ appendEvent race (#98)', () => {
  // 15s timeout — the hook spawns a Node subprocess + parent sleeps ~250ms
  // inside compactLog + sentinel polling can take a beat on slow CI runners.
  // vitest's default 5s default is insufficient on Node 18 + GitHub Actions.
  it('anchor: concurrent appendEvent during compactLog is durably persisted', async () => {
    const atomId = 'FACT-2026-05-19-RACE-test1';
    seedCompactableEvents(testDir, atomId, 5);

    const beforeEventIds = new Set(readEvents(testDir).map((e) => e.event_id));

    // Configure the hook: src/event-log.ts spawns this Node script and then
    // holds the lock for ~250ms. The child appendEvent must block on the
    // lock until compactLog releases — proving the lost-write race is closed.
    process.env.MK_COMPACT_LOG_TEST_HOOK_PATH = `${process.execPath} ${hookScript}`;

    const result = compactLog(testDir);
    expect(result.removed).toBeGreaterThan(0);

    // Wait for the spawned hook child to finish its appendEvent (sentinel
    // file is touched at the end of the hook script). Bounded poll: the
    // child should complete within ~1s once the lock releases.
    const sentinel = path.join(testDir, 'race-hook.done');
    const deadline = Date.now() + 5000;
    while (!fs.existsSync(sentinel) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(fs.existsSync(sentinel)).toBe(true);

    const afterEvents = readEvents(testDir);
    const afterIds = new Set(afterEvents.map((e) => e.event_id));
    const newEvents = afterEvents.filter((e) => !beforeEventIds.has(e.event_id));

    // The race-hook injected exactly one new event with meta.injected_by.
    const injectedEvents = afterEvents.filter(
      (e) => (e.meta as { injected_by?: string } | undefined)?.injected_by === 'race-hook',
    );

    // ANCHOR: the injected event must survive. Pre-fix this fails because
    // the rename inside writeFileAtomic clobbers the injected append.
    expect(injectedEvents.length).toBe(1);
    expect(newEvents.length).toBeGreaterThanOrEqual(1);

    // Sanity: post-rename file is intact NDJSON (no torn lines).
    expect(afterIds.size).toBe(afterEvents.length);
  }, 15000);

  it('quiescent log: compactLog still works on a single-process log (regression guard)', () => {
    const atomId = 'FACT-2026-05-19-RACE-test2';
    seedCompactableEvents(testDir, atomId, 4);

    // No hook → no race injection. Verifies the lock does not break the
    // single-writer path.
    const result = compactLog(testDir);
    expect(result.removed).toBeGreaterThan(0);
    expect(result.events_after).toBeGreaterThan(0);
    expect(result.backup_path).not.toBe('');
    expect(fs.existsSync(result.backup_path)).toBe(true);

    // The log is readable and parses cleanly.
    const events = readEvents(testDir);
    expect(events.length).toBe(result.events_after);
  });

  it('lock contention: two concurrent compactLogs both succeed without corruption', async () => {
    const atomId = 'FACT-2026-05-19-RACE-test3';
    seedCompactableEvents(testDir, atomId, 8);

    // .mjs worker so we can `import` the ESM dist/event-log.js — Node 18
    // refuses `require()` of ESM modules under "type": "module".
    const distEventLog = pathToFileURL(path.resolve('dist/event-log.js')).href;
    const workerSrc = `
      import { parentPort, workerData } from 'node:worker_threads';
      import { compactLog } from '${distEventLog}';
      try {
        const result = compactLog(workerData.testDir);
        parentPort.postMessage({ ok: true, result });
      } catch (err) {
        parentPort.postMessage({ ok: false, error: err && err.message });
      }
    `;
    const workerFile = path.join(testDir, 'compact-worker.mjs');
    fs.writeFileSync(workerFile, workerSrc);

    const spawn = (): Promise<{ ok: boolean; result?: unknown; error?: string }> =>
      new Promise((resolve, reject) => {
        const w = new Worker(workerFile, {
          workerData: { testDir },
        });
        w.on('message', (msg) => {
          w.terminate();
          resolve(msg);
        });
        w.on('error', reject);
      });

    const [a, b] = await Promise.all([spawn(), spawn()]);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);

    // The log file is still parseable as NDJSON and contains all the
    // non-mutation events + at least one mutation for the seeded atom.
    const events = readEvents(testDir);
    expect(events.length).toBeGreaterThan(0);
    const mutations = events.filter((e) => e.atom_refs?.includes(atomId));
    expect(mutations.length).toBeGreaterThan(0);
  });
});
