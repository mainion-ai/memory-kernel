import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

import { initMemoryDir, createAtom, closeAllIndexes } from '../src/index.js';

const MK_BIN = path.resolve('dist/cli/mk.js');

let testDir: string;

beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-cli-timeline-'));
  initMemoryDir(testDir);
  createAtom({
    memoryDir: testDir, agent_id: 'a', session_id: 's',
    type: 'fact', slug: 'one', body: 'One.',
  });
  createAtom({
    memoryDir: testDir, agent_id: 'a', session_id: 's',
    type: 'belief', slug: 'two', body: 'Two.',
  });
});

afterEach(() => {
  closeAllIndexes();
  fs.rmSync(testDir, { recursive: true, force: true });
});

describe('mk timeline --json', () => {
  it('outputs a JSON document with an events array', () => {
    if (!fs.existsSync(MK_BIN)) {
      // Skip silently when build not present — CI runs `npm run build` first
      return;
    }
    const out = execFileSync('node', [MK_BIN, 'timeline', '-d', testDir, '--json'], { encoding: 'utf-8' });
    const parsed = JSON.parse(out);
    expect(parsed).toHaveProperty('events');
    expect(Array.isArray(parsed.events)).toBe(true);
    expect(parsed.events.length).toBeGreaterThanOrEqual(2);
    expect(parsed.events[0]).toMatchObject({
      event_id: expect.any(String),
      timestamp: expect.any(String),
      action: expect.any(String),
    });
  });

  it('respects --from and --to filters', () => {
    if (!fs.existsSync(MK_BIN)) return;
    const out = execFileSync(
      'node',
      [MK_BIN, 'timeline', '-d', testDir, '--from', '2020-01-01T00:00:00Z', '--to', '2020-12-31T00:00:00Z', '--json'],
      { encoding: 'utf-8' },
    );
    const parsed = JSON.parse(out);
    expect(parsed.events).toEqual([]);
  });

  it('outputs a human-readable summary when --json is omitted', () => {
    if (!fs.existsSync(MK_BIN)) return;
    const out = execFileSync('node', [MK_BIN, 'timeline', '-d', testDir], { encoding: 'utf-8' });
    // Must NOT be JSON (no leading `{`)
    expect(out.trim().startsWith('{')).toBe(false);
    // Must mention event count
    expect(out).toMatch(/\d+ event/);
  });

  it('rejects an invalid --from timestamp', () => {
    if (!fs.existsSync(MK_BIN)) return;
    let threw = false;
    try {
      execFileSync(
        'node',
        [MK_BIN, 'timeline', '-d', testDir, '--from', 'not-a-date', '--json'],
        { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
      );
    } catch (e) {
      threw = true;
      const err = e as { stdout?: Buffer; stderr?: Buffer };
      // With --json, exitWithError writes the JSON error to stdout; without, to stderr.
      const msg = String(err.stdout ?? '') + String(err.stderr ?? '');
      expect(msg).toMatch(/--from/);
    }
    expect(threw).toBe(true);
  });
});
