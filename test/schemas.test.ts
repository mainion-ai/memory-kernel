/**
 * #301 — the exported Zod schemas are the authoritative oracle for each
 * `mk --json` output: we run the REAL CLI and assert the output validates.
 * If a command's output drifts from its schema, this fails.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import {
  RecallOutputSchema,
  DoctorOutputSchema,
  RememberOutputSchema,
  EvalOutputSchema,
} from '../src/schemas.js';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist/cli/mk.js');
let dir: string;

function run(args: string[]) {
  return spawnSync('node', [CLI, ...args], { encoding: 'utf8' });
}
function json(args: string[]): unknown {
  const r = run(args);
  // --json output is on stdout regardless of exit code (doctor/eval may exit 1).
  return JSON.parse(r.stdout);
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-schemas-'));
  run(['init', dir]);
  run(['remember', 'The API rate limit is 1000 req/min', '-d', dir, '-t', 'fact', '--tags', 'api']);
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('#301 exported --json schemas validate real CLI output', () => {
  it('RememberOutputSchema ⟵ mk remember --json', () => {
    const out = json(['remember', 'Prefer pnpm', '-d', dir, '-t', 'preference', '--json']);
    expect(() => RememberOutputSchema.parse(out)).not.toThrow();
  });

  it('RecallOutputSchema ⟵ mk recall --json', () => {
    const out = json(['recall', '-d', dir, '--task', 'rate limit', '--json']);
    expect(() => RecallOutputSchema.parse(out)).not.toThrow();
  });

  it('DoctorOutputSchema ⟵ mk doctor --json', () => {
    const out = json(['doctor', '-d', dir, '--json']);
    expect(() => DoctorOutputSchema.parse(out)).not.toThrow();
  });

  it('DoctorOutputSchema ⟵ mk doctor --fix --dry-run --json (fixes[] branch)', () => {
    const out = json(['doctor', '-d', dir, '--fix', '--dry-run', '--json']);
    const parsed = DoctorOutputSchema.parse(out);
    expect(Array.isArray(parsed.fixes)).toBe(true);
  });

  it('EvalOutputSchema ⟵ mk eval --json', () => {
    const fixture = path.join(dir, 'recall.yaml');
    fs.writeFileSync(fixture, 'threshold: 0\nqueries:\n  - task: rate limit\n    expect:\n      - FACT-NONE\n');
    const out = json(['eval', '-d', dir, '--fixture', fixture, '--json']);
    expect(() => EvalOutputSchema.parse(out)).not.toThrow();
  });
});
