/**
 * wrapper-memory-dir check (#347) — flags a generated cron wrapper whose baked
 * `# mk:memory-dir` does not exist on the host where the wrapper is installed.
 *
 * `mk init --cron` bakes the memory-dir into the wrapper. If it was generated
 * with a CONTAINER path but the systemd/cron timer fires on the HOST (where
 * that path doesn't exist), every `mk reflect/reindex/render -d "$MEMORY_DIR"`
 * fails "Memory directory not found" and the nightly silently goes dark (the
 * other half of the Taj incident — the PATH half was #345). This check makes
 * that loud: doctor, run on the host, verifies the wrapper renders to a real
 * path here.
 */
import fs from 'fs';
import { discoverWrappers, type DiscoveredWrapper, type DiscoverOptions } from '../discover-wrappers.js';
import { parseGeneratedHeader } from '../../cron-template.js';
import type { Check, CheckResult, DoctorContext } from '../types.js';

export interface WrapperMemoryDirCheckOptions {
  /** Override discoverWrappers options (e.g. for tests). */
  discoverOptions?: DiscoverOptions;
}

export function makeWrapperMemoryDirCheck(opts: WrapperMemoryDirCheckOptions = {}): Check {
  return {
    name: 'wrapper-memory-dir',
    category: 'wrappers',
    defaultSeverity: 'warn',
    skipWhen: ['wrappers', 'cron'],
    run(ctx: DoctorContext): CheckResult {
      const wrappers = discoverWrappers(opts.discoverOptions);
      const issues: string[] = [];

      // The wrapper resolves `MEMORY_DIR="${MK_MEMORY_DIR:-<baked>}"`, so a
      // runtime MK_MEMORY_DIR override wins over the baked literal. Mirror that
      // here — checking the baked path alone would false-flag the deliberate
      // placeholder-plus-override pattern on every nightly canary run.
      const override = ctx.env?.MK_MEMORY_DIR;

      for (const w of wrappers as readonly DiscoveredWrapper[]) {
        // The user crontab itself isn't a wrapper file; only inspect generated wrappers.
        if (w.source === 'crontab -l' || !w.isMkGenerated) continue;
        const header = parseGeneratedHeader(w.content);
        if (!header || !header.memoryDir) continue;

        const effective = override || header.memoryDir;
        if (!fs.existsSync(effective)) {
          const via = override ? ` (MK_MEMORY_DIR override: ${override})` : '';
          issues.push(
            `${w.source}: memory-dir ${effective}${via} does not exist on this host — the nightly renders to a path that isn't here (host-vs-container mismatch?). Regenerate ON THE HOST with the host store path: \`mk init --cron --update --output ${w.source} --dir <host-memory-dir>\``,
          );
        }
      }

      return {
        name: 'wrapper-memory-dir',
        category: 'wrappers',
        severity: 'warn',
        ok: issues.length === 0,
        issues,
      };
    },
  };
}

export const wrapperMemoryDirCheck: Check = makeWrapperMemoryDirCheck();
