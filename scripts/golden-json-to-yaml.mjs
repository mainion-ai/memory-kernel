#!/usr/bin/env node
/**
 * One-shot migrator: the legacy golden-eval JSON (`[{q, expect[], cat}]`, or
 * `{expect_content, cat}` for KNOWLEDGE entries) → a `mk eval` YAML fixture
 * (#300). Maps `q → task`. Prints YAML to stdout.
 *
 *   node scripts/golden-json-to-yaml.mjs path/to/golden-queries.json > eval/recall.yaml
 *
 * Used once to migrate the live per-agent 12-query sets; not part of the CLI.
 */
import fs from 'fs';
import yaml from 'js-yaml';

const jsonPath = process.argv[2];
if (!jsonPath) {
  console.error('usage: golden-json-to-yaml.mjs <golden-queries.json>  > <fixture.yaml>');
  process.exit(1);
}

let arr;
try {
  arr = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
} catch (err) {
  console.error(`cannot read/parse ${jsonPath}: ${err.message}`);
  process.exit(1);
}
if (!Array.isArray(arr)) {
  console.error('expected a top-level JSON array of query objects');
  process.exit(1);
}

const queries = arr.map((item) => {
  const out = {};
  if (item.expect_content) {
    out.expect_content = item.expect_content;
  } else {
    out.task = item.q ?? item.task;
    out.expect = item.expect ?? [];
  }
  if (item.cat) out.cat = item.cat;
  return out;
});

// threshold/top_k intentionally omitted — set them per fixture to your baseline.
process.stdout.write(yaml.dump({ queries }, { lineWidth: 0 }));
