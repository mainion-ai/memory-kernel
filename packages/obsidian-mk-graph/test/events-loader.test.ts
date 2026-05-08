import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, existsSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readEvents, watchEvents } from '../src/events-loader.js';

const ev = (id: string, ts: string, action = 'atom_created') =>
  JSON.stringify({
    event_id: id,
    timestamp: ts,
    agent_id: 'a',
    session_id: 's',
    action,
    schema_version: 2,
    atom_snapshot: `---\nid: ${id}\ntype: fact\nstatus: active\ncreated_at: "${ts}"\nupdated_at: "${ts}"\nttl_days: null\n---\n\nbody\n`,
  });

describe('readEvents', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'mk-graph-events-'));
  });
  afterEach(() => {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  it('returns [] when events.ndjson is missing', async () => {
    expect(await readEvents(dir)).toEqual([]);
  });

  it('parses lines in file order', async () => {
    const lines = [ev('E1', '2026-04-01T10:00:00Z'), ev('E2', '2026-04-02T10:00:00Z')];
    writeFileSync(path.join(dir, 'events.ndjson'), lines.join('\n') + '\n');
    const out = await readEvents(dir);
    expect(out.map((e) => e.event_id)).toEqual(['E1', 'E2']);
  });

  it('skips malformed lines but keeps valid ones', async () => {
    const lines = [ev('E1', '2026-04-01T10:00:00Z'), 'not json', ev('E2', '2026-04-02T10:00:00Z')];
    writeFileSync(path.join(dir, 'events.ndjson'), lines.join('\n') + '\n');
    const out = await readEvents(dir);
    expect(out.map((e) => e.event_id)).toEqual(['E1', 'E2']);
  });
});

describe('watchEvents', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'mk-graph-events-watch-'));
    writeFileSync(path.join(dir, 'events.ndjson'), '');
  });
  afterEach(() => {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  it('fires onChange after a debounced append', async () => {
    let calls = 0;
    const w = watchEvents(dir, () => { calls++; }, 50);
    appendFileSync(path.join(dir, 'events.ndjson'), ev('E1', '2026-04-01T10:00:00Z') + '\n');
    appendFileSync(path.join(dir, 'events.ndjson'), ev('E2', '2026-04-02T10:00:00Z') + '\n');
    await new Promise((r) => setTimeout(r, 200));
    w.close();
    expect(calls).toBeGreaterThanOrEqual(1);
  });

  it('returns a no-op watcher when events.ndjson is absent', () => {
    rmSync(path.join(dir, 'events.ndjson'));
    const w = watchEvents(dir, () => {}, 50);
    // No throw, .close() safe.
    w.close();
    expect(true).toBe(true);
  });
});
