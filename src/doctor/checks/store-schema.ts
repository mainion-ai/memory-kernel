/**
 * store-schema check — confirms the on-disk store is consistent with the
 * binary's expectations: events.ndjson exists, and the SQLite index's
 * `user_version` matches the kernel's compile-time SCHEMA_VERSION.
 *
 * A mismatch usually means a stale index — recoverable via `mk reindex`.
 * We surface it as a warn (not error) since the index will rebuild itself
 * on next open anyway, but the user wants to know now rather than
 * discover it via a slow query.
 */

import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { reindex } from '../../index-db.js';
import type { Check, CheckResult, DoctorContext, FixOpts, FixOutcome } from '../types.js';

/**
 * Kept in sync with src/index-db.ts. We don't import the constant to avoid
 * pulling the whole index-db module just for one number; if it drifts, the
 * test in test/doctor-store-schema.test.ts will catch it.
 */
const EXPECTED_SCHEMA_VERSION = 8;

interface StoreSchemaProbe {
  eventsMissing: string | null;     // path to missing events file, or null
  staleUserVersion: number | null;  // current user_version if stale, or null
  unreadable: string | null;        // error message if DB unreadable, or null
}

function probe(memoryDir: string): StoreSchemaProbe {
  const out: StoreSchemaProbe = { eventsMissing: null, staleUserVersion: null, unreadable: null };
  const eventsPath = path.join(memoryDir, 'events.ndjson');
  if (!fs.existsSync(eventsPath)) out.eventsMissing = eventsPath;

  const indexDbPath = path.join(memoryDir, '.memory-index.db');
  if (fs.existsSync(indexDbPath)) {
    try {
      const db = new Database(indexDbPath, { readonly: true });
      try {
        const v = db.pragma('user_version', { simple: true }) as number;
        if (v !== EXPECTED_SCHEMA_VERSION) out.staleUserVersion = v;
      } finally {
        db.close();
      }
    } catch (err) {
      out.unreadable = String(err);
    }
  }
  return out;
}

export const storeSchemaCheck: Check = {
  name: 'store-schema',
  category: 'memory',
  defaultSeverity: 'warn',
  skipWhen: ['store'],
  run(ctx: DoctorContext): CheckResult {
    const p = probe(ctx.memoryDir);
    const issues: string[] = [];
    if (p.eventsMissing) issues.push(`events.ndjson missing at ${p.eventsMissing}`);
    if (p.staleUserVersion !== null) {
      issues.push(
        `.memory-index.db schema version ${p.staleUserVersion}, expected ${EXPECTED_SCHEMA_VERSION} — run \`mk reindex\``,
      );
    }
    if (p.unreadable) issues.push(`.memory-index.db unreadable: ${p.unreadable}`);

    return {
      name: storeSchemaCheck.name,
      category: storeSchemaCheck.category,
      severity: 'warn',
      ok: issues.length === 0,
      issues,
    };
  },
  fix(ctx: DoctorContext, _result: CheckResult, opts: FixOpts): FixOutcome {
    const p = probe(ctx.memoryDir);
    const applied: string[] = [];
    const remaining: string[] = [];

    if (p.eventsMissing) {
      // Data loss — not auto-fixable.
      remaining.push(`events.ndjson missing at ${p.eventsMissing} (cannot auto-restore)`);
    }

    if (p.staleUserVersion !== null) {
      if (opts.dryRun) {
        applied.push(
          `would reindex (.memory-index.db at v${p.staleUserVersion}, target v${EXPECTED_SCHEMA_VERSION})`,
        );
      } else {
        const { indexed, timeMs } = reindex(ctx.memoryDir);
        applied.push(
          `reindexed ${indexed} atom(s) in ${timeMs}ms (v${p.staleUserVersion} → v${EXPECTED_SCHEMA_VERSION})`,
        );
      }
    }

    if (p.unreadable) {
      remaining.push(`.memory-index.db unreadable — manual review required: ${p.unreadable}`);
    }

    return { applied, remaining };
  },
};
