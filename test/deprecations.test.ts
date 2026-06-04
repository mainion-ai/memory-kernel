/**
 * Unit tests for src/deprecations.ts — CLI flag deprecation warnings (#141).
 *
 * Covers:
 *   - removed flag is stripped from argv + warning emitted
 *   - renamed flag is rewritten in place (with and without =value suffix)
 *   - changed-default flag passes through unchanged with warning
 *   - MK_NO_DEPRECATION_WARNINGS / MK_QUIET suppress warnings (but keep argv
 *     rewriting so existing scripts keep working)
 *   - unrelated argv tokens are untouched
 *   - parseRenderStats + degenerateOutputWarning helpers
 */

import { describe, it, expect } from 'vitest';

import {
  processDeprecatedFlags,
  formatWarning,
  parseRenderStats,
  degenerateOutputWarning,
  type FlagDeprecation,
} from '../src/deprecations.js';

class CaptureStream {
  chunks: string[] = [];
  write(s: string): boolean {
    this.chunks.push(s);
    return true;
  }
  get text(): string {
    return this.chunks.join('');
  }
}

describe('processDeprecatedFlags — removed', () => {
  const registry: FlagDeprecation[] = [
    { flag: '--fill', since: '1.18.9', kind: 'removed', hint: 'Fill is default now.' },
  ];

  it('strips removed flag from argv and warns on stderr', () => {
    const stderr = new CaptureStream();
    const out = processDeprecatedFlags(
      ['render', '/tmp/mem', '/tmp/out.md', '--fill'],
      { registry, stderr: stderr as unknown as NodeJS.WritableStream, env: {} },
    );
    expect(out).toEqual(['render', '/tmp/mem', '/tmp/out.md']);
    expect(stderr.text).toContain('mk: warning:');
    expect(stderr.text).toContain('--fill has been removed in 1.18.9');
    expect(stderr.text).toContain('Fill is default now.');
  });

  it('strips removed flag in --flag=value form too', () => {
    const stderr = new CaptureStream();
    const out = processDeprecatedFlags(
      ['render', '--fill=true'],
      { registry, stderr: stderr as unknown as NodeJS.WritableStream, env: {} },
    );
    expect(out).toEqual(['render']);
    expect(stderr.text).toContain('--fill has been removed');
  });

  it('emits one warning per occurrence', () => {
    const stderr = new CaptureStream();
    processDeprecatedFlags(
      ['--fill', '--fill'],
      { registry, stderr: stderr as unknown as NodeJS.WritableStream, env: {} },
    );
    const matches = stderr.text.match(/mk: warning:/g) ?? [];
    expect(matches.length).toBe(2);
  });
});

describe('processDeprecatedFlags — renamed', () => {
  const registry: FlagDeprecation[] = [
    {
      flag: '--recall-mode',
      renamedTo: '--mode',
      since: '1.19.0',
      kind: 'renamed',
      hint: 'Use --mode instead.',
    },
  ];

  it('rewrites bare renamed flag', () => {
    const stderr = new CaptureStream();
    const out = processDeprecatedFlags(
      ['--recall-mode', 'fill'],
      { registry, stderr: stderr as unknown as NodeJS.WritableStream, env: {} },
    );
    expect(out).toEqual(['--mode', 'fill']);
    expect(stderr.text).toContain('was renamed to --mode');
  });

  it('preserves =value suffix when rewriting', () => {
    const stderr = new CaptureStream();
    const out = processDeprecatedFlags(
      ['--recall-mode=fill'],
      { registry, stderr: stderr as unknown as NodeJS.WritableStream, env: {} },
    );
    expect(out).toEqual(['--mode=fill']);
  });
});

describe('processDeprecatedFlags — changed-default', () => {
  const registry: FlagDeprecation[] = [
    {
      flag: '--max-tokens',
      since: '1.18.0',
      kind: 'changed-default',
      hint: 'Default raised from 8000 to 16000.',
    },
  ];

  it('passes flag through unchanged but warns', () => {
    const stderr = new CaptureStream();
    const out = processDeprecatedFlags(
      ['--max-tokens', '4000'],
      { registry, stderr: stderr as unknown as NodeJS.WritableStream, env: {} },
    );
    expect(out).toEqual(['--max-tokens', '4000']);
    expect(stderr.text).toContain('--max-tokens default changed in 1.18.0');
  });
});

describe('processDeprecatedFlags — suppression', () => {
  const registry: FlagDeprecation[] = [
    { flag: '--fill', since: '1.18.9', kind: 'removed', hint: 'Fill is default.' },
  ];

  it('MK_NO_DEPRECATION_WARNINGS=1 silences stderr but still rewrites argv', () => {
    const stderr = new CaptureStream();
    const out = processDeprecatedFlags(['render', '--fill'], {
      registry,
      stderr: stderr as unknown as NodeJS.WritableStream,
      env: { MK_NO_DEPRECATION_WARNINGS: '1' },
    });
    expect(out).toEqual(['render']);
    expect(stderr.text).toBe('');
  });

  it('MK_QUIET=1 also silences', () => {
    const stderr = new CaptureStream();
    processDeprecatedFlags(['--fill'], {
      registry,
      stderr: stderr as unknown as NodeJS.WritableStream,
      env: { MK_QUIET: '1' },
    });
    expect(stderr.text).toBe('');
  });

  it('falsy env values do not suppress', () => {
    const stderr = new CaptureStream();
    processDeprecatedFlags(['--fill'], {
      registry,
      stderr: stderr as unknown as NodeJS.WritableStream,
      env: { MK_QUIET: '' },
    });
    expect(stderr.text).toContain('mk: warning:');
  });
});

describe('processDeprecatedFlags — pass-through', () => {
  it('leaves non-matching argv tokens alone', () => {
    const stderr = new CaptureStream();
    const out = processDeprecatedFlags(
      ['render', '-d', './memory', '--max-tokens', '8000'],
      {
        registry: [{ flag: '--fill', since: '1.18.9', kind: 'removed', hint: '' }],
        stderr: stderr as unknown as NodeJS.WritableStream,
        env: {},
      },
    );
    expect(out).toEqual(['render', '-d', './memory', '--max-tokens', '8000']);
    expect(stderr.text).toBe('');
  });

  it('does not match a positional that happens to equal a flag name', () => {
    // A value that follows a different flag and happens to be '--fill' literally
    // is not common, but we want predictable behavior: every token is checked
    // independently. This test pins the current behavior so it doesn't drift.
    const stderr = new CaptureStream();
    const out = processDeprecatedFlags(['remember', '--text', '--fill'], {
      registry: [{ flag: '--fill', since: '1.18.9', kind: 'removed', hint: '' }],
      stderr: stderr as unknown as NodeJS.WritableStream,
      env: {},
    });
    // Current behavior: --fill is stripped even when it follows another flag.
    // Callers that need to pass literal '--fill' as a value should use `--text=--fill`.
    expect(out).toEqual(['remember', '--text']);
  });
});

describe('formatWarning', () => {
  it('builds removed-flag warning', () => {
    const s = formatWarning({
      flag: '--fill',
      since: '1.18.9',
      kind: 'removed',
      hint: 'Remove it.',
    });
    expect(s).toBe('mk: warning: --fill has been removed in 1.18.9. Remove it.');
  });

  it('builds renamed-flag warning', () => {
    const s = formatWarning({
      flag: '--old',
      since: '1.19.0',
      kind: 'renamed',
      renamedTo: '--new',
      hint: 'Use --new.',
    });
    expect(s).toBe('mk: warning: --old was renamed to --new in 1.19.0. Use --new.');
  });
});

describe('parseRenderStats', () => {
  it('returns zero atoms for empty memory output', () => {
    const empty = `# Memory\n\n> Auto-generated from memory-kernel. 0 atoms, 0 events.\n\n## Getting Started\n\nThis is a fresh memory.\n`;
    const stats = parseRenderStats(empty);
    expect(stats.totalAtoms).toBe(0);
    expect(stats.bySection).toEqual({});
  });

  it('counts atoms per section', () => {
    const content = [
      '# Memory',
      '',
      '## Key Facts',
      '### fact-1',
      'body',
      '### fact-2',
      'body',
      '',
      '## Beliefs',
      '### belief-1',
      'body',
      '',
    ].join('\n');
    const stats = parseRenderStats(content);
    expect(stats.totalAtoms).toBe(3);
    expect(stats.bySection).toEqual({ 'Key Facts': 2, 'Beliefs': 1 });
  });

  it('strips warning glyph from "Active Conflicts" heading', () => {
    const content = ['## ⚠ Active Conflicts', '### conflict-1', ''].join('\n');
    const stats = parseRenderStats(content);
    expect(Object.keys(stats.bySection)).toEqual(['Active Conflicts']);
  });

  it('counts atoms in belief developmental arcs (rendered as **ID** bullets)', () => {
    const content = [
      '# Memory',
      '',
      '## Beliefs (developmental arcs)',
      '',
      '### Arc: root → leaf (3 nodes, May 1)',
      '',
      '**BELI-2026-05-01-ROOT-abc1**',
      'root body',
      '',
      '  → **BELI-2026-05-02-MID-abc2**',
      '  mid body',
      '',
      '    → **BELI-2026-05-03-LEAF-abc3**',
      '    leaf body',
      '',
    ].join('\n');
    const stats = parseRenderStats(content);
    expect(stats.totalAtoms).toBe(3);
    expect(stats.bySection).toEqual({ 'Beliefs (developmental arcs)': 3 });
  });

  it('counts standalone beliefs rendered as **ID** bullets', () => {
    const content = [
      '## Beliefs (developmental arcs)',
      '',
      '### Arc: a → b (2 nodes, May 1)',
      '',
      '**BELI-2026-05-01-A-aaa1**',
      'body',
      '  → **BELI-2026-05-02-B-aaa2**',
      '  body',
      '',
      '### Standalone beliefs',
      '',
      '**BELI-2026-05-03-C-aaa3**',
      'body',
      '**BELI-2026-05-04-D-aaa4**',
      'body',
      '',
    ].join('\n');
    const stats = parseRenderStats(content);
    expect(stats.totalAtoms).toBe(4);
    expect(stats.bySection).toEqual({ 'Beliefs (developmental arcs)': 4 });
  });

  it('does not count the literal "### Arc:" or "### Standalone beliefs" headings as atoms', () => {
    const content = [
      '## Beliefs (developmental arcs)',
      '',
      '### Arc: a → b (2 nodes, May 1)',
      '',
      '**BELI-2026-05-01-A-bbb1**',
      'body',
      '',
      '### Standalone beliefs',
      '',
      '**BELI-2026-05-02-B-bbb2**',
      'body',
      '',
    ].join('\n');
    const stats = parseRenderStats(content);
    expect(stats.totalAtoms).toBe(2);
  });

  it('does not count bold body lines (e.g. **Note**) inside an arc section', () => {
    const content = [
      '## Beliefs (developmental arcs)',
      '',
      '### Arc: a → b (2 nodes, May 1)',
      '',
      '**BELI-2026-05-01-A-abc1**',
      '**Note**: this is body emphasis, not an atom heading.',
      '**TODO**: also body emphasis.',
      '',
      '  → **BELI-2026-05-02-B-abc2**',
      '  **Update**: indented body emphasis too.',
      '',
    ].join('\n');
    const stats = parseRenderStats(content);
    expect(stats.totalAtoms).toBe(2);
    expect(stats.bySection).toEqual({ 'Beliefs (developmental arcs)': 2 });
  });

  it('still counts ### atom-id headings in non-arc sections', () => {
    const content = [
      '## Key Facts',
      '### FACT-2026-05-01-X-abc',
      'body',
      '## Beliefs (unverified)',
      '### BELI-2026-05-01-Y-def',
      'body',
      '',
    ].join('\n');
    const stats = parseRenderStats(content);
    expect(stats.totalAtoms).toBe(2);
    expect(stats.bySection).toEqual({ 'Key Facts': 1, 'Beliefs (unverified)': 1 });
  });
});

describe('degenerateOutputWarning', () => {
  it('warns on 0 atoms', () => {
    const w = degenerateOutputWarning({ totalAtoms: 0, bySection: {} });
    expect(w).toContain('0 atoms');
  });

  it('warns on monoculture when atom count ≥ 5', () => {
    const w = degenerateOutputWarning({
      totalAtoms: 28,
      bySection: { Beliefs: 28 },
    });
    expect(w).toContain('28 atoms');
    expect(w).toContain("all are 'Beliefs'");
  });

  it('does NOT warn on a single section with < 5 atoms (fresh memory not yet diverse)', () => {
    const w = degenerateOutputWarning({
      totalAtoms: 2,
      bySection: { 'Key Facts': 2 },
    });
    expect(w).toBeNull();
  });

  it('does NOT warn on multi-section output', () => {
    const w = degenerateOutputWarning({
      totalAtoms: 15,
      bySection: { 'Key Facts': 5, Beliefs: 10 },
    });
    expect(w).toBeNull();
  });
});
