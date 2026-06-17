/**
 * Unit tests for src/cron-template.ts — canonical memory-sync wrapper
 * generation (#143).
 *
 * Tests are deterministic: kernelVersion and generatedAt are injected, so
 * snapshot diffs aren't sensitive to clock or release cadence.
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

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

  it('is fail-soft: set -uo pipefail (no bare -e) so one step cannot silently kill the sync (#303)', () => {
    const out = generateCronWrapper(baseOpts);
    expect(out).toContain('set -uo pipefail');
    // The bare `set -e` foot-gun is gone — it aborted the whole nightly sync on a
    // non-fatal grep exit-1 (the 6-day silent death). Steps are guarded instead.
    expect(out).not.toContain('set -euo pipefail');
    expect(out).not.toMatch(/^set -e\b/m);
    expect(out).toContain('step()'); // the per-step non-fatal guard helper
  });

  it('self-adds PATH so cron can find mk (#303)', () => {
    const out = generateCronWrapper(baseOpts);
    expect(out).toContain('export PATH=');
    expect(out).toContain('command -v node');
    expect(out).toContain('$HOME/.local/bin');
  });

  it('bakes MK_BIN as a runtime-overridable default and prepends its dir to PATH (#345)', () => {
    const out = generateCronWrapper({ ...baseOpts, mkBin: '/grp/npm/node_modules/.bin/mk' });
    // Baked default (so a clean cron env still resolves), runtime-overridable.
    expect(out).toContain('MK_BIN="${MK_BIN:-/grp/npm/node_modules/.bin/mk}"');
    expect(out).toContain('[ -n "$MK_BIN" ] && export PATH="$(dirname "$MK_BIN"):$PATH"');
    // Round-trips through the machine header so `--update` preserves it.
    expect(out).toContain('# mk:mk-bin=/grp/npm/node_modules/.bin/mk');
    expect(parseGeneratedHeader(out)?.mkBin).toBe('/grp/npm/node_modules/.bin/mk');
    // The MK_BIN prepend must come AFTER the node-dir/local-bin fallback so it wins.
    const lines = out.split('\n');
    const fallbackIdx = lines.findIndex((l) => l.includes('command -v node') && l.startsWith('export PATH='));
    const mkbinIdx = lines.findIndex((l) => l.startsWith('[ -n "$MK_BIN" ] && export PATH='));
    expect(fallbackIdx).toBeGreaterThanOrEqual(0);
    expect(mkbinIdx).toBeGreaterThan(fallbackIdx);
  });

  it('omits the mk-bin baking when no MK_BIN is known (no regression, inert line)', () => {
    const out = generateCronWrapper(baseOpts); // no mkBin
    expect(out).not.toContain('# mk:mk-bin=');
    expect(out).toContain('MK_BIN="${MK_BIN:-}"'); // empty default → inert unless runtime MK_BIN set
    expect(parseGeneratedHeader(out)?.mkBin).toBeNull();
  });

  // Run the generated PATH-setup block under a stripped PATH and resolve bare `mk`.
  function resolveMkUnderStrippedPath(out: string, root: string, runtimeMkBin?: string): string {
    const lines = out.split('\n');
    const start = lines.findIndex((l) => l.includes('command -v node') && l.startsWith('export PATH='));
    const end = lines.findIndex((l) => l.startsWith('[ -n "$MK_BIN" ] && export PATH='));
    const block = lines.slice(start, end + 1).join('\n');
    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin', HOME: root };
    if (runtimeMkBin !== undefined) env.MK_BIN = runtimeMkBin;
    return execFileSync('bash', ['-c', `set -uo pipefail\n${block}\ncommand -v mk`], { encoding: 'utf8', env }).trim();
  }

  function fakeGroupNpmMk(): { root: string; mkBin: string } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-cron-mkbin-'));
    const binDir = path.join(root, 'npm', 'node_modules', '.bin');
    fs.mkdirSync(binDir, { recursive: true });
    const mkBin = path.join(binDir, 'mk');
    fs.writeFileSync(mkBin, '#!/usr/bin/env bash\necho fake-mk-ok\n');
    fs.chmodSync(mkBin, 0o755);
    return { root, mkBin };
  }

  it('group-npm layout: BAKED MK_BIN finds mk under a stripped PATH with NO runtime MK_BIN (#345 — the real cron case)', () => {
    const { root, mkBin } = fakeGroupNpmMk();
    try {
      // Wrapper generated in the agent env (MK_BIN baked); cron then runs it with
      // a clean env that does NOT export MK_BIN. The baked value must still resolve.
      const out = generateCronWrapper({ ...baseOpts, mkBin });
      const resolved = resolveMkUnderStrippedPath(out, root /* no runtime MK_BIN */);
      expect(resolved).toBe(mkBin);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('group-npm layout: a runtime MK_BIN overrides the baked default (#345)', () => {
    const { root, mkBin } = fakeGroupNpmMk();
    try {
      const out = generateCronWrapper({ ...baseOpts, mkBin: '/stale/old/.bin/mk' });
      const resolved = resolveMkUnderStrippedPath(out, root, mkBin); // runtime MK_BIN wins
      expect(resolved).toBe(mkBin);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('includes the KNOWLEDGE auto-observe step before reflect (#256)', () => {
    const out = generateCronWrapper(baseOpts);
    expect(out).toContain('KNOWLEDGE_DIR="$MEMORY_DIR/KNOWLEDGE"');
    expect(out).toContain('.knowledge-manifest');
    expect(out).toContain('mk observe "$doc" --mode document -d "$MEMORY_DIR"');
    expect(out).toContain('"$KNOWLEDGE_DIR"/draft/*) continue ;;'); // skip work-in-progress
    expect(out).toContain('"$KNOWLEDGE_DIR"/README.md) continue ;;'); // skip scaffolded doc
    // Must run BEFORE reflect (so reflect turns the observations into atoms).
    const lines = out.split('\n');
    const knowledgeIdx = lines.findIndex((l) => l.includes('KNOWLEDGE_DIR="$MEMORY_DIR/KNOWLEDGE"'));
    const reflectIdx = lines.findIndex((l) => l.includes('mk reflect -d "$MEMORY_DIR"'));
    expect(knowledgeIdx).toBeGreaterThanOrEqual(0);
    expect(reflectIdx).toBeGreaterThan(knowledgeIdx);
  });

  it('KNOWLEDGE scan: observes changed docs, skips draft/ + README, idempotent (#256 smoke)', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-cron-knowledge-'));
    try {
      const kernel = path.join(root, 'kernel');
      const kdir = path.join(kernel, 'KNOWLEDGE');
      fs.mkdirSync(path.join(kdir, 'draft'), { recursive: true });
      fs.writeFileSync(path.join(kdir, 'paper.md'), '# A finished research doc');
      fs.writeFileSync(path.join(kdir, 'draft', 'wip.md'), '# work in progress');
      fs.writeFileSync(path.join(kdir, 'README.md'), '# KNOWLEDGE convention');

      // Fake `mk`: log `observe` targets, no-op everything else.
      const fakeBin = path.join(root, 'bin');
      fs.mkdirSync(fakeBin);
      const mkBin = path.join(fakeBin, 'mk');
      const observeLog = path.join(root, 'observe.log');
      fs.writeFileSync(mkBin, `#!/usr/bin/env bash\nif [ "$1" = "observe" ]; then echo "$2" >> "${observeLog}"; fi\nexit 0\n`);
      fs.chmodSync(mkBin, 0o755);

      const wrapper = path.join(root, 'sync.sh');
      fs.writeFileSync(wrapper, generateCronWrapper({
        memoryDir: kernel, claudeMd: path.join(root, 'CLAUDE.md'), memoryRepo: root,
        kernelVersion: '1.34.0', generatedAt: '2026-06-14T00:00:00Z',
      }));

      // MK_BIN set to the fake → the wrapper's own PATH logic resolves `mk` to it.
      const env = { PATH: '/usr/bin:/bin', HOME: root, MK_BIN: mkBin };
      const observed = () => (fs.existsSync(observeLog) ? fs.readFileSync(observeLog, 'utf8').trim().split('\n').filter(Boolean) : []);

      // Run 1: paper.md observed; draft/wip.md + README.md skipped.
      execFileSync('bash', [wrapper], { env, encoding: 'utf8' });
      let log = observed();
      expect(log).toContain(path.join(kdir, 'paper.md'));
      expect(log.some((l) => l.includes('/draft/'))).toBe(false);
      expect(log.some((l) => l.endsWith('README.md'))).toBe(false);

      // The per-host manifest is auto-gitignored (not committed → no cross-host churn).
      expect(fs.readFileSync(path.join(root, '.gitignore'), 'utf8')).toContain('.knowledge-manifest');

      // Run 2: nothing changed → no new observe (idempotent via manifest).
      fs.rmSync(observeLog, { force: true });
      execFileSync('bash', [wrapper], { env, encoding: 'utf8' });
      expect(observed()).toEqual([]);

      // Run 3: paper.md modified (mtime bumped) → re-observed.
      const future = Date.now() / 1000 + 60;
      fs.utimesSync(path.join(kdir, 'paper.md'), future, future);
      fs.rmSync(observeLog, { force: true });
      execFileSync('bash', [wrapper], { env, encoding: 'utf8' });
      expect(observed()).toContain(path.join(kdir, 'paper.md'));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('reindexes WITH embeddings before render so new atoms get vectors (#303/#305)', () => {
    const out = generateCronWrapper(baseOpts);
    expect(out).toContain('mk reindex -d "$MEMORY_DIR" --embed');
    const reindexIdx = out.indexOf('mk reindex ');
    const renderIdx = out.indexOf('mk render ');
    const reflectIdx = out.indexOf('mk reflect ');
    expect(reflectIdx).toBeGreaterThan(0);
    expect(reindexIdx).toBeGreaterThan(reflectIdx); // reflect → reindex → render
    expect(renderIdx).toBeGreaterThan(reindexIdx);
  });

  it('runs a non-fatal mk doctor self-canary after sync (#303)', () => {
    const out = generateCronWrapper(baseOpts);
    expect(out).toContain('mk doctor -d "$MEMORY_DIR"');
    expect(out).toMatch(/canary/i);
    // The canary must come after the commit step (it verifies the post-sync state).
    expect(out.indexOf('mk doctor ')).toBeGreaterThan(out.indexOf('git commit'));
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
