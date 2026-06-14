/**
 * End-to-end tests for `mk init --cron` (#143).
 *
 * Spawns the real dist/cli/mk.js so we cover the option parsing path, file
 * system writes, chmod, and the --install-cron MK_CRONTAB_FILE override.
 * No real crontab is ever mutated — tests point MK_CRONTAB_FILE at a temp
 * file.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

const CLI = path.resolve('dist/cli/mk.js');

let workDir: string;
let outputScript: string;
let crontabFile: string;

interface Run {
  stdout: string;
  stderr: string;
  status: number;
}

function mk(args: string[], extraEnv: Record<string, string> = {}): Run {
  const result = spawnSync('node', [CLI, ...args], {
    encoding: 'utf-8',
    timeout: 10000,
    env: { ...process.env, NODE_NO_WARNINGS: '1', ...extraEnv },
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status ?? 1,
  };
}

beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-init-cron-'));
  outputScript = path.join(workDir, 'memory-sync.sh');
  crontabFile = path.join(workDir, 'crontab.txt');
});

afterEach(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

describe('mk init --cron (happy path)', () => {
  it('writes an executable script at --output with the embedded paths', () => {
    const memoryDir = path.join(workDir, 'kernel');
    const claudeMd = path.join(workDir, 'CLAUDE.md');
    fs.mkdirSync(memoryDir);

    const { stdout, status } = mk([
      'init', '--cron',
      '--dir', memoryDir,
      '--claude-md', claudeMd,
      '--output', outputScript,
    ]);

    expect(status).toBe(0);
    expect(stdout).toContain(`Wrote ${outputScript}`);

    expect(fs.existsSync(outputScript)).toBe(true);
    const mode = fs.statSync(outputScript).mode & 0o777;
    expect(mode).toBe(0o755);

    const content = fs.readFileSync(outputScript, 'utf-8');
    expect(content).toContain('#!/usr/bin/env bash');
    expect(content).toContain(`# mk:memory-dir=${memoryDir}`);
    expect(content).toContain(`# mk:claude-md=${claudeMd}`);
  });

  it('warns (non-fatal) when the baked memory-dir does not exist on this host (#347)', () => {
    const missingDir = path.join(workDir, 'does-not-exist', 'kernel'); // not created
    const { stderr, status } = mk([
      'init', '--cron',
      '--dir', missingDir,
      '--claude-md', path.join(workDir, 'CLAUDE.md'),
      '--output', outputScript,
    ]);

    expect(status).toBe(0); // non-fatal — wrapper is still generated
    expect(stderr).toContain('does not exist on this host');
    expect(stderr).toContain('container'); // host-vs-container hint
    expect(fs.existsSync(outputScript)).toBe(true);
    expect(fs.readFileSync(outputScript, 'utf-8')).toContain(`# mk:memory-dir=${missingDir}`);
  });

  it('refuses to overwrite an existing file without --force or --update', () => {
    fs.writeFileSync(outputScript, '# pre-existing\n');

    const { stderr, status } = mk([
      'init', '--cron',
      '--dir', workDir,
      '--claude-md', path.join(workDir, 'CLAUDE.md'),
      '--output', outputScript,
    ]);

    expect(status).not.toBe(0);
    expect(stderr).toContain('already exists');
    expect(fs.readFileSync(outputScript, 'utf-8')).toBe('# pre-existing\n');
  });

  it('overwrites with --force', () => {
    fs.writeFileSync(outputScript, '# pre-existing\n');
    const memoryDir = path.join(workDir, 'kernel');
    fs.mkdirSync(memoryDir);

    const { status } = mk([
      'init', '--cron',
      '--dir', memoryDir,
      '--claude-md', path.join(workDir, 'CLAUDE.md'),
      '--output', outputScript,
      '--force',
    ]);
    expect(status).toBe(0);
    expect(fs.readFileSync(outputScript, 'utf-8')).toContain('#!/usr/bin/env bash');
  });
});

describe('mk init --cron required flags', () => {
  it('errors when --output is missing', () => {
    const { stderr, status } = mk(['init', '--cron', '--dir', workDir, '--claude-md', '/tmp/x']);
    expect(status).not.toBe(0);
    expect(stderr).toContain('--output');
  });

  it('errors when --dir is missing (and not in --update mode)', () => {
    const { stderr, status } = mk([
      'init', '--cron',
      '--claude-md', path.join(workDir, 'CLAUDE.md'),
      '--output', outputScript,
    ]);
    expect(status).not.toBe(0);
    expect(stderr).toContain('--dir');
  });

  it('errors when --claude-md is missing', () => {
    const { stderr, status } = mk([
      'init', '--cron',
      '--dir', workDir,
      '--output', outputScript,
    ]);
    expect(status).not.toBe(0);
    expect(stderr).toContain('--claude-md');
  });
});

describe('mk init --cron --update', () => {
  it('preserves paths from the existing wrapper header', () => {
    const originalMemoryDir = path.join(workDir, 'kernel');
    const originalClaudeMd = path.join(workDir, 'CLAUDE.md');
    fs.mkdirSync(originalMemoryDir);

    // First generation seeds the file with paths in its header.
    const first = mk([
      'init', '--cron',
      '--dir', originalMemoryDir,
      '--claude-md', originalClaudeMd,
      '--output', outputScript,
      '--max-tokens', '8000',
    ]);
    expect(first.status).toBe(0);

    // --update with NO --dir / --claude-md should inherit from the header.
    const second = mk([
      'init', '--cron',
      '--update',
      '--output', outputScript,
    ]);
    expect(second.status).toBe(0);

    const regenerated = fs.readFileSync(outputScript, 'utf-8');
    expect(regenerated).toContain(`# mk:memory-dir=${originalMemoryDir}`);
    expect(regenerated).toContain(`# mk:claude-md=${originalClaudeMd}`);
    expect(regenerated).toContain('# mk:max-tokens=8000');
  });

  it('lets explicit flags override inherited values', () => {
    const originalMemoryDir = path.join(workDir, 'kernel');
    fs.mkdirSync(originalMemoryDir);

    mk([
      'init', '--cron',
      '--dir', originalMemoryDir,
      '--claude-md', path.join(workDir, 'CLAUDE.md'),
      '--output', outputScript,
      '--max-tokens', '8000',
    ]);

    const update = mk([
      'init', '--cron',
      '--update',
      '--output', outputScript,
      '--max-tokens', '32000',
    ]);
    expect(update.status).toBe(0);

    const regenerated = fs.readFileSync(outputScript, 'utf-8');
    expect(regenerated).toContain('# mk:max-tokens=32000');
  });

  it('errors when --update is passed but the file does not exist', () => {
    const { stderr, status } = mk([
      'init', '--cron',
      '--update',
      '--output', outputScript,
    ]);
    expect(status).not.toBe(0);
    expect(stderr).toContain('requires an existing file');
  });
});

describe('mk init --cron --install-cron', () => {
  it('writes a crontab line to MK_CRONTAB_FILE idempotently', () => {
    const memoryDir = path.join(workDir, 'kernel');
    fs.mkdirSync(memoryDir);

    const baseArgs = [
      'init', '--cron',
      '--dir', memoryDir,
      '--claude-md', path.join(workDir, 'CLAUDE.md'),
      '--output', outputScript,
      '--install-cron', '0 23 * * *',
      '--force',
    ];

    const first = mk(baseArgs, { MK_CRONTAB_FILE: crontabFile });
    expect(first.status).toBe(0);
    expect(first.stdout).toContain('Installed crontab entry');

    const afterFirst = fs.readFileSync(crontabFile, 'utf-8');
    expect(afterFirst).toContain(`0 23 * * * ${outputScript}`);

    // Run again — must not duplicate.
    const second = mk(baseArgs, { MK_CRONTAB_FILE: crontabFile });
    expect(second.status).toBe(0);

    const afterSecond = fs.readFileSync(crontabFile, 'utf-8');
    const matches = afterSecond.match(new RegExp(outputScript.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'));
    expect(matches?.length).toBe(1);
  });

  it('does NOT mutate the crontab when --install-cron is omitted', () => {
    const memoryDir = path.join(workDir, 'kernel');
    fs.mkdirSync(memoryDir);

    fs.writeFileSync(crontabFile, '# existing\n');

    const { status, stdout } = mk(
      [
        'init', '--cron',
        '--dir', memoryDir,
        '--claude-md', path.join(workDir, 'CLAUDE.md'),
        '--output', outputScript,
      ],
      { MK_CRONTAB_FILE: crontabFile },
    );

    expect(status).toBe(0);
    // No "Installed crontab entry" line; the helper message is printed instead.
    expect(stdout).not.toContain('Installed crontab entry');
    expect(stdout).toContain('To install on a 23:00 daily schedule');
    expect(fs.readFileSync(crontabFile, 'utf-8')).toBe('# existing\n');
  });
});

describe('mk init --cron gitignore hint', () => {
  it('warns when --output is inside --memory-repo', () => {
    const memoryDir = path.join(workDir, 'kernel');
    fs.mkdirSync(memoryDir);
    // Script inside the same repo dir = the footgun Mai flagged.
    const inRepoScript = path.join(workDir, 'memory-sync.sh');

    const { stderr, status } = mk([
      'init', '--cron',
      '--dir', memoryDir,
      '--claude-md', path.join(workDir, 'CLAUDE.md'),
      '--output', inRepoScript,
      '--memory-repo', workDir,
    ]);
    expect(status).toBe(0);
    expect(stderr).toContain('mk: note:');
    expect(stderr).toContain('memory-sync.sh');
    expect(stderr).toContain('.gitignore');
  });

  it('does NOT warn when --output is outside --memory-repo', () => {
    const memoryDir = path.join(workDir, 'kernel');
    fs.mkdirSync(memoryDir);
    const elsewhereDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-init-cron-elsewhere-'));
    try {
      const outsideScript = path.join(elsewhereDir, 'memory-sync.sh');

      const { stderr, status } = mk([
        'init', '--cron',
        '--dir', memoryDir,
        '--claude-md', path.join(workDir, 'CLAUDE.md'),
        '--output', outsideScript,
        '--memory-repo', workDir,
      ]);
      expect(status).toBe(0);
      expect(stderr).not.toContain('mk: note:');
    } finally {
      fs.rmSync(elsewhereDir, { recursive: true, force: true });
    }
  });
});

describe('mk init (backward compatibility)', () => {
  it('still initializes a memory directory when --cron is not passed', () => {
    const memDir = path.join(workDir, 'mem');
    const { status, stdout } = mk(['init', memDir]);
    expect(status).toBe(0);
    expect(stdout).toContain('Memory initialized at');
    expect(fs.existsSync(path.join(memDir, 'events.ndjson'))).toBe(true);
  });
});
