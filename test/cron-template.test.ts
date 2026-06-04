/**
 * Unit tests for src/cron-template.ts — canonical memory-sync wrapper
 * generation (#143).
 *
 * Tests are deterministic: kernelVersion and generatedAt are injected, so
 * snapshot diffs aren't sensitive to clock or release cadence.
 */

import { describe, it, expect } from 'vitest';

import {
  generateCronWrapper,
  parseGeneratedHeader,
  applyCrontabLine,
  DEFAULT_MAX_TOKENS,
  type CronWrapperOptions,
} from '../src/cron-template.js';

const baseOpts: CronWrapperOptions = {
  memoryDir: '/home/agent/mk-memory/kernel',
  claudeMd: '/home/agent/workspace/CLAUDE.md',
  kernelVersion: '1.19.3',
  generatedAt: '2026-05-18T09:57:25Z',
};

describe('generateCronWrapper', () => {
  it('returns a valid bash script with shebang and trailing newline', () => {
    const out = generateCronWrapper(baseOpts);
    expect(out.startsWith('#!/usr/bin/env bash\n')).toBe(true);
    expect(out.endsWith('\n')).toBe(true);
  });

  it('embeds machine-parseable header lines for every path it received', () => {
    const out = generateCronWrapper(baseOpts);
    expect(out).toContain('# mk:generator-version=1.19.3');
    expect(out).toContain('# mk:generated-at=2026-05-18T09:57:25Z');
    expect(out).toContain('# mk:memory-dir=/home/agent/mk-memory/kernel');
    expect(out).toContain('# mk:claude-md=/home/agent/workspace/CLAUDE.md');
    expect(out).toContain('# mk:memory-repo=/home/agent/mk-memory');
    expect(out).toContain(`# mk:max-tokens=${DEFAULT_MAX_TOKENS}`);
    expect(out).toContain('# mk:agent-id=$(hostname -s)');
  });

  it('includes reflect + render + git commit/push in that order', () => {
    const out = generateCronWrapper(baseOpts);
    const reflectIdx = out.indexOf('mk reflect ');
    const renderIdx = out.indexOf('mk render ');
    const commitIdx = out.indexOf('git commit ');
    expect(reflectIdx).toBeGreaterThan(0);
    expect(renderIdx).toBeGreaterThan(reflectIdx);
    expect(commitIdx).toBeGreaterThan(renderIdx);
  });

  it('renders with -d/-o flags, not the deprecated positional form (#123)', () => {
    const out = generateCronWrapper(baseOpts);
    // The wrapper must use `mk render -d <dir> -o <path>` because the
    // positional form prints a deprecation warning to stderr that pollutes
    // cron mail / logs. (#123)
    expect(out).toContain('mk render -d "$MEMORY_DIR" -o "$CLAUDE_MD" --max-tokens "$MAX_TOKENS"');
    expect(out).not.toMatch(/mk render "[^"]+" "[^"]+"/);
  });

  it('honors explicit memoryRepo override', () => {
    const out = generateCronWrapper({ ...baseOpts, memoryRepo: '/srv/memory-repo' });
    expect(out).toContain('# mk:memory-repo=/srv/memory-repo');
    expect(out).toContain('MEMORY_REPO="${MK_MEMORY_REPO:-/srv/memory-repo}"');
  });

  it('honors explicit maxTokens override', () => {
    const out = generateCronWrapper({ ...baseOpts, maxTokens: 8000 });
    expect(out).toContain('# mk:max-tokens=8000');
    expect(out).toContain('MAX_TOKENS="${MK_MAX_TOKENS:-8000}"');
  });

  it('honors explicit agentId override (bakes it into the script)', () => {
    const out = generateCronWrapper({ ...baseOpts, agentId: 'mai' });
    expect(out).toContain('# mk:agent-id=mai');
    expect(out).toContain('AGENT_ID="${MK_AGENT_ID:-mai}"');
    expect(out).not.toContain('$(hostname -s)');
  });

  it('writes set -euo pipefail so failures abort the script', () => {
    const out = generateCronWrapper(baseOpts);
    expect(out).toContain('set -euo pipefail');
  });

  it('exposes MK_* env vars so users can override paths without regenerating', () => {
    const out = generateCronWrapper(baseOpts);
    expect(out).toContain('MEMORY_DIR="${MK_MEMORY_DIR:-/home/agent/mk-memory/kernel}"');
    expect(out).toContain('CLAUDE_MD="${MK_CLAUDE_MD:-/home/agent/workspace/CLAUDE.md}"');
  });
});

describe('generateCronWrapper validation', () => {
  it('rejects relative memoryDir', () => {
    expect(() =>
      generateCronWrapper({ ...baseOpts, memoryDir: './memory' }),
    ).toThrow(/absolute path/);
  });

  it('rejects relative claudeMd', () => {
    expect(() =>
      generateCronWrapper({ ...baseOpts, claudeMd: 'CLAUDE.md' }),
    ).toThrow(/absolute path/);
  });

  it('rejects zero or negative maxTokens', () => {
    expect(() =>
      generateCronWrapper({ ...baseOpts, maxTokens: 0 }),
    ).toThrow(/positive integer/);
    expect(() =>
      generateCronWrapper({ ...baseOpts, maxTokens: -100 }),
    ).toThrow(/positive integer/);
  });

  it('rejects unparseable generatedAt', () => {
    expect(() =>
      generateCronWrapper({ ...baseOpts, generatedAt: 'not-a-timestamp' }),
    ).toThrow(/parseable ISO timestamp/);
  });
});

describe('parseGeneratedHeader', () => {
  it('roundtrips: parseGeneratedHeader(generateCronWrapper(x)) returns x', () => {
    const generated = generateCronWrapper({ ...baseOpts, agentId: 'mai', maxTokens: 12000 });
    const parsed = parseGeneratedHeader(generated);
    expect(parsed).not.toBeNull();
    expect(parsed!.memoryDir).toBe(baseOpts.memoryDir);
    expect(parsed!.claudeMd).toBe(baseOpts.claudeMd);
    expect(parsed!.memoryRepo).toBe('/home/agent/mk-memory');
    expect(parsed!.maxTokens).toBe(12000);
    expect(parsed!.agentId).toBe('mai');
    expect(parsed!.generatorVersion).toBe('1.19.3');
  });

  it('preserves the "hostname -s" sentinel as null (means "compute at run time")', () => {
    const generated = generateCronWrapper(baseOpts);
    const parsed = parseGeneratedHeader(generated);
    expect(parsed!.agentId).toBeNull();
  });

  it('returns null when no mk: header is present', () => {
    const notMine = '#!/usr/bin/env bash\necho hello\n';
    expect(parseGeneratedHeader(notMine)).toBeNull();
  });

  it('stops scanning at the first non-comment line so embedded "# mk:" in body does not leak in', () => {
    const file = [
      '#!/usr/bin/env bash',
      '# mk:generator-version=1.19.3',
      '# mk:memory-dir=/real/path',
      '# mk:claude-md=/real/claude.md',
      '',
      'echo "# mk:memory-dir=/spoofed"',
      '',
    ].join('\n');
    const parsed = parseGeneratedHeader(file);
    expect(parsed!.memoryDir).toBe('/real/path');
  });
});

describe('applyCrontabLine', () => {
  const SCRIPT = '/home/agent/.local/bin/memory-sync.sh';
  const LINE = `0 23 * * * ${SCRIPT}`;

  it('appends to an empty crontab', () => {
    const out = applyCrontabLine('', LINE, SCRIPT);
    expect(out).toContain(LINE);
  });

  it('appends to an existing crontab without disturbing other lines', () => {
    const before = '# user comment\n0 5 * * * /other/script.sh\n';
    const out = applyCrontabLine(before, LINE, SCRIPT);
    expect(out).toContain('# user comment');
    expect(out).toContain('0 5 * * * /other/script.sh');
    expect(out).toContain(LINE);
  });

  it('is idempotent — re-running with the same line does not duplicate', () => {
    const first = applyCrontabLine('', LINE, SCRIPT);
    const second = applyCrontabLine(first, LINE, SCRIPT);
    expect(second.match(new RegExp(SCRIPT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))?.length).toBe(1);
  });

  it('replaces an existing entry when the schedule changes', () => {
    const first = applyCrontabLine('', LINE, SCRIPT);
    const updated = applyCrontabLine(first, `30 4 * * * ${SCRIPT}`, SCRIPT);
    expect(updated).toContain(`30 4 * * * ${SCRIPT}`);
    expect(updated).not.toContain(`0 23 * * * ${SCRIPT}`);
  });

  it('leaves a comment line that contains the script path alone (does not treat it as the entry)', () => {
    const before = `# notes about ${SCRIPT}\n`;
    const out = applyCrontabLine(before, LINE, SCRIPT);
    expect(out).toContain(`# notes about ${SCRIPT}`);
    expect(out).toContain(LINE);
  });

  it('does not clobber an unrelated entry whose path is a superset of the new script path', () => {
    // Regression: previous .includes() substring match would treat
    // /home/agent/.local/bin/memory-sync.sh.bak as "the same entry" as
    // /home/agent/.local/bin/memory-sync.sh and silently overwrite it.
    const sibling = `${SCRIPT}.bak`;
    const siblingLine = `0 6 * * * ${sibling}`;
    const before = `${siblingLine}\n`;
    const out = applyCrontabLine(before, LINE, SCRIPT);
    expect(out).toContain(siblingLine);
    expect(out).toContain(LINE);
  });

  it('does not clobber an unrelated entry whose path is a hyphen-suffix of the new script path', () => {
    const sibling = `${SCRIPT}-disabled`;
    const siblingLine = `0 6 * * * ${sibling}`;
    const before = `${siblingLine}\n`;
    const out = applyCrontabLine(before, LINE, SCRIPT);
    expect(out).toContain(siblingLine);
    expect(out).toContain(LINE);
  });

  it('replaces an entry that quotes the script path', () => {
    const quotedLine = `0 23 * * * "${SCRIPT}"`;
    const before = `${quotedLine}\n`;
    const out = applyCrontabLine(before, LINE, SCRIPT);
    expect(out).toContain(LINE);
    expect(out).not.toContain(quotedLine);
  });

  it('matches the entry when followed by an argument or a chained command', () => {
    const before = `0 23 * * * ${SCRIPT} --quiet && echo done\n`;
    const out = applyCrontabLine(before, LINE, SCRIPT);
    expect(out).toContain(LINE);
    expect(out).not.toContain('--quiet');
  });
});
