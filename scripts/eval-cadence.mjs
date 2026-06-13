#!/usr/bin/env node
/**
 * eval-cadence.mjs — delta-only post-sync alert + weekly digest over `mk eval` runs (#266).
 *
 * Pipeline (host-side, wired by the operator — see docs/eval-cadence.md):
 *   mk eval -d <store> --json > latest.json
 *   node scripts/eval-cadence.mjs --history <baseline.jsonl> --latest latest.json
 *
 * Appends the latest run (timestamped now) to the rolling JSONL history, then
 * compares the latest per-category pass rate against the rolling N-day baseline.
 * Prints the weekly digest always; on a fired alert prints ALERT lines and exits
 * non-zero so a post-sync hook can gate. `--digest` prints the rolling summary
 * without appending.
 *
 * Decision logic lives in the tested engine (src/eval-cadence.ts → dist).
 */
import fs from 'fs';
import { summarizeEvalRun, decideCadence } from '../dist/eval-cadence.js';

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
function flag(name) {
  return process.argv.includes(`--${name}`);
}

const historyPath = arg('history');
const latestPath = arg('latest');
const digestOnly = flag('digest');
const days = Number(arg('days', '7'));
const drop = Number(arg('drop', '0.10'));
const improve = Number(arg('improve', '0.15'));

if (!historyPath) {
  console.error('usage: eval-cadence.mjs --history <baseline.jsonl> [--latest <eval.json>] [--digest] [--days N] [--drop N] [--improve N]');
  process.exit(2);
}

function readHistory(p) {
  if (!fs.existsSync(p)) return [];
  const out = [];
  const lines = fs.readFileSync(p, 'utf-8').split('\n');
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // A truncated/corrupt line (e.g. a crash mid-append) must not take down
      // every subsequent run — warn and skip it.
      console.error(`warning: skipping malformed history line in ${p}`);
    }
  }
  return out;
}

const history = readHistory(historyPath);

// --digest: report over the existing history only (no new run ingested).
if (!digestOnly) {
  if (!latestPath) {
    console.error('--latest <eval.json> is required unless --digest is set');
    process.exit(2);
  }
  const raw = JSON.parse(fs.readFileSync(latestPath, 'utf-8'));
  const fixtures = Array.isArray(raw) ? raw : raw.fixtures;
  if (!Array.isArray(fixtures)) {
    console.error(`--latest must be \`mk eval --json\` output (an object with a "fixtures" array)`);
    process.exit(2);
  }
  const snapshot = summarizeEvalRun(fixtures, new Date().toISOString());
  history.push(snapshot);
  fs.appendFileSync(historyPath, JSON.stringify(snapshot) + '\n');
}

const result = decideCadence(history, { baselineDays: days, dropThreshold: drop, improveThreshold: improve });
console.log(result.digest);

if (result.fired) {
  console.error(`\nALERT — ${result.alerts.length} category change(s) past threshold (drop>${drop * 100}pp / improve>${improve * 100}pp)`);
  process.exit(1);
}
