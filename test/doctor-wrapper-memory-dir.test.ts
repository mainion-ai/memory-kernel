/**
 * Tests for the wrapper-memory-dir doctor check (#347): flags a generated cron
 * wrapper whose baked `# mk:memory-dir` doesn't exist on the host.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

import { makeWrapperMemoryDirCheck } from '../src/doctor/checks/wrapper-memory-dir.js';
import type { DoctorContext } from '../src/doctor/types.js';

let workDir: string;
let scriptPath: string;
let crontabFile: string;

beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-doctor-memdir-'));
  scriptPath = path.join(workDir, 'memory-sync.sh');
  crontabFile = path.join(workDir, 'crontab.txt');
});
afterEach(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

function writeWrapper(memoryDir: string, mkGenerated = true): void {
  const lines = mkGenerated
    ? [
        '#!/usr/bin/env bash',
        '# mk:generator-version=1.33.2',
        `# mk:memory-dir=${memoryDir}`,
        `# mk:claude-md=${memoryDir}/CLAUDE.md`,
        `# mk:memory-repo=${memoryDir}`,
        '# mk:max-tokens=16000',
        '# mk:agent-id=$(hostname -s)',
        `mk render -d "${memoryDir}" -o /tmp/CLAUDE.md`,
      ]
    : ['#!/usr/bin/env bash', `mk render -d "${memoryDir}"`]; // hand-rolled, no header
  fs.writeFileSync(scriptPath, lines.join('\n'));
  fs.writeFileSync(crontabFile, `0 23 * * * ${scriptPath}\n`);
}

function ctx(): DoctorContext {
  return { memoryDir: workDir, kernelVersion: '1.33.2', skipCategories: new Set(), env: { MK_CRONTAB_FILE: crontabFile } };
}
function check() {
  return makeWrapperMemoryDirCheck({ discoverOptions: { home: workDir, userCrontabFile: crontabFile, skipSystem: true } });
}

describe('wrapper-memory-dir (#347)', () => {
  it('passes when the baked memory-dir exists on this host', () => {
    const dir = path.join(workDir, 'kernel');
    fs.mkdirSync(dir, { recursive: true });
    writeWrapper(dir);
    const r = check().run(ctx()) as { ok: boolean; issues: string[] };
    expect(r.ok).toBe(true);
    expect(r.issues).toEqual([]);
  });

  it('flags a wrapper whose baked memory-dir does not exist (container-vs-host)', () => {
    writeWrapper('/workspace/extra/memory/kernel'); // container path, absent on host
    const r = check().run(ctx()) as { ok: boolean; issues: string[]; severity: string };
    expect(r.ok).toBe(false);
    expect(r.severity).toBe('warn');
    expect(r.issues.join(' ')).toContain('/workspace/extra/memory/kernel');
    expect(r.issues.join(' ')).toContain('does not exist on this host');
  });

  it('honors the MK_MEMORY_DIR runtime override (no false-flag on the placeholder-plus-override pattern)', () => {
    const hostDir = path.join(workDir, 'host-kernel');
    fs.mkdirSync(hostDir, { recursive: true });
    writeWrapper('/workspace/extra/memory/kernel'); // baked container placeholder (absent here)
    // Timer/canary env overrides to the real host store via MK_MEMORY_DIR.
    const ctxWithOverride: DoctorContext = {
      memoryDir: workDir, kernelVersion: '1.33.2', skipCategories: new Set(),
      env: { MK_CRONTAB_FILE: crontabFile, MK_MEMORY_DIR: hostDir },
    };
    const r = check().run(ctxWithOverride) as { ok: boolean; issues: string[] };
    expect(r.ok).toBe(true); // effective dir (the override) exists → not flagged
  });

  it('flags when even the MK_MEMORY_DIR override points at a missing dir', () => {
    writeWrapper(path.join(workDir, 'kernel')); // baked, also absent
    const ctxBadOverride: DoctorContext = {
      memoryDir: workDir, kernelVersion: '1.33.2', skipCategories: new Set(),
      env: { MK_CRONTAB_FILE: crontabFile, MK_MEMORY_DIR: '/also/missing' },
    };
    const r = check().run(ctxBadOverride) as { ok: boolean; issues: string[] };
    expect(r.ok).toBe(false);
    expect(r.issues.join(' ')).toContain('/also/missing');
  });

  it('ignores hand-rolled wrappers with no mk: header', () => {
    writeWrapper('/nonexistent/path', false);
    const r = check().run(ctx()) as { ok: boolean };
    expect(r.ok).toBe(true); // no header → not our concern (wrapper-drift surfaces untracked wrappers)
  });
});
