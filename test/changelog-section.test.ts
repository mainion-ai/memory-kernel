/**
 * Tests for scripts/changelog-section.sh — the shared CHANGELOG-section
 * extractor used by release.yml (release notes) and sync-to-public.sh
 * (synthetic-commit message body). Mirrors the tmp-dir bash-script harness
 * used by test/docs-hygiene-check.test.ts and test/privacy-scan.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'changelog-section.sh');

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function run(args: string): RunResult {
  try {
    const stdout = execSync(`bash "${SCRIPT}" ${args}`, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { stdout, stderr: '', exitCode: 0 };
  } catch (err: unknown) {
    const e = err as { status?: number; stdout?: Buffer | string; stderr?: Buffer | string };
    return {
      stdout: e.stdout?.toString() ?? '',
      stderr: e.stderr?.toString() ?? '',
      exitCode: e.status ?? -1,
    };
  }
}

let dir: string;
let changelog: string;

const SAMPLE = `# Changelog

## [Unreleased]

### Fixed — something unreleased

Unreleased body line.

## [1.28.5] — 2026-06-09

### Fixed — the EPIPE thing

Body line one.
Body line two.

## [1.28.4] — 2026-06-09

### Added — older release

Should not appear when extracting 1.28.5.
`;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-changelog-section-'));
  changelog = path.join(dir, 'CHANGELOG.md');
  fs.writeFileSync(changelog, SAMPLE);
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('changelog-section.sh', () => {
  it('extracts the section WITH heading by default', () => {
    const r = run(`1.28.5 --file "${changelog}"`);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('## [1.28.5] — 2026-06-09');
    expect(r.stdout).toContain('Body line one.');
    expect(r.stdout).toContain('Body line two.');
  });

  it('--body-only omits the heading line', () => {
    const r = run(`1.28.5 --body-only --file "${changelog}"`);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).not.toContain('## [1.28.5]');
    expect(r.stdout).toContain('### Fixed — the EPIPE thing');
    expect(r.stdout).toContain('Body line two.');
  });

  it('stops at the next "## [" heading (no bleed into older versions)', () => {
    const r = run(`1.28.5 --file "${changelog}"`);
    expect(r.stdout).not.toContain('older release');
    expect(r.stdout).not.toContain('## [1.28.4]');
  });

  it('does not bleed the Unreleased section into the target version', () => {
    const r = run(`1.28.5 --file "${changelog}"`);
    expect(r.stdout).not.toContain('Unreleased body line.');
  });

  it('matches regardless of the date suffix on the heading', () => {
    const r = run(`1.28.4 --file "${changelog}"`);
    expect(r.stdout).toContain('## [1.28.4] — 2026-06-09');
    expect(r.stdout).toContain('older release');
  });

  it('prints nothing and exits 0 for an unknown version', () => {
    const r = run(`9.9.9 --file "${changelog}"`);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('');
  });

  it('exits 2 when no version argument is given', () => {
    const r = run(`--file "${changelog}"`);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('usage');
  });

  it('exits 2 when the CHANGELOG file does not exist', () => {
    const r = run(`1.28.5 --file "${path.join(dir, 'nope.md')}"`);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('not found');
  });

  it('exits 2 on an unknown option', () => {
    const r = run(`1.28.5 --bogus --file "${changelog}"`);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('unknown option');
  });
});
