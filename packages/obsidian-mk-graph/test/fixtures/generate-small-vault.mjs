import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, 'small-vault');
const ents = path.join(root, 'ENTITIES');
const eps = path.join(root, 'EPISODES');
mkdirSync(ents, { recursive: true });
mkdirSync(eps, { recursive: true });

const atomTypes = [
  'fact', 'belief', 'decision', 'open_question', 'preference',
  'constraint', 'procedure', 'entity_summary', 'conflict',
];
const statuses = [
  'active', 'active', 'active', 'active', 'accepted',
  'draft', 'rejected', 'superseded', 'archived', 'resolved',
];
const classifications = ['PUBLIC', 'TEAM', 'TEAM', 'TEAM', 'PERSONAL', 'SECRET'];
const relationTypes = ['extends', 'supports', 'contradicts', 'caused_by', 'related'];
const sources = ['manual', 'extracted', 'enriched', undefined];

const atoms = [];
for (let i = 0; i < 20; i++) {
  const type = atomTypes[i % atomTypes.length];
  const status = statuses[i % statuses.length];
  const classification = classifications[i % classifications.length];
  const day = (i % 27) + 1;
  const dd = String(day).padStart(2, '0');
  const id = `${type.toUpperCase().slice(0, 4)}-2026-04-${dd}-FIX${String(i).padStart(2, '0')}-aa${String(i).padStart(2, '0')}`;
  atoms.push({ id, type, status, classification, day });
}

for (let i = 0; i < atoms.length; i++) {
  const a = atoms[i];
  const linkCount = (i % 4) + (i < 5 ? 0 : 1);
  const rels = [];
  for (let r = 0; r < linkCount; r++) {
    const targetIdx = (i + r + 3) % atoms.length;
    if (targetIdx === i) continue;
    rels.push({
      target: atoms[targetIdx].id,
      type: relationTypes[(i + r) % relationTypes.length],
      confidence: 0.5 + ((i + r) % 5) * 0.1,
      weight: 0.6 + ((i + r) % 4) * 0.3,
      source: sources[(i + r) % sources.length],
    });
  }

  const lines = [];
  lines.push('---');
  lines.push(`id: ${a.id}`);
  lines.push(`type: ${a.type}`);
  lines.push(`status: ${a.status}`);
  lines.push(`confidence: 0.${8 + (i % 2)}`);
  lines.push(`created_at: "2026-04-${String(a.day).padStart(2, '0')}T10:00:00Z"`);
  lines.push(`updated_at: "2026-04-${String(a.day).padStart(2, '0')}T10:00:00Z"`);
  lines.push('ttl_days: null');
  lines.push(`classification: ${a.classification}`);
  lines.push('scope:');
  lines.push(`  tags: [fixture, ${a.type}]`);
  if (rels.length > 0) {
    lines.push('relations:');
    for (const r of rels) {
      lines.push(`  - target: ${r.target}`);
      lines.push(`    type: ${r.type}`);
      lines.push(`    confidence: ${r.confidence.toFixed(2)}`);
      lines.push(`    weight: ${r.weight.toFixed(2)}`);
      if (r.source) lines.push(`    source: ${r.source}`);
    }
  }
  lines.push('---');
  lines.push('');
  lines.push(`Body for fixture atom ${a.id}.`);
  lines.push('');
  writeFileSync(path.join(ents, `${a.id}.md`), lines.join('\n'));
}

const epBody = [
  '---',
  'session_id: EP-fixture-001',
  'started_at: "2026-04-15T09:00:00Z"',
  'ended_at: "2026-04-15T11:00:00Z"',
  'tags: [fixture]',
  'provenance_atoms:',
  ...atoms.slice(0, 4).map((a) => `  - ${a.id}`),
  '---',
  '',
  'Fixture episode for manual smoke testing.',
  '',
].join('\n');
writeFileSync(path.join(eps, 'EP-fixture-001.md'), epBody);

console.log(`Wrote ${atoms.length} atoms to ${ents}`);
console.log(`Wrote 1 episode to ${eps}`);

// --- events.ndjson ---
// Mirror the atoms array as a sequence of atom_created events at
// 2026-04-DD T 10:00:00Z (DD = atom.day). Add two archives at the end
// (atoms[2], atoms[5]) and one update for atoms[10]. Output is ordered
// by timestamp ascending so replay can stream-process line by line.

const events = [];
let evt = 0;
function evid() { return `EVT-${String(++evt).padStart(4, '0')}`; }

// Atom-created events, one per fixture atom.
for (const a of atoms) {
  const dd = String(a.day).padStart(2, '0');
  const ts = `2026-04-${dd}T10:00:00Z`;
  const file = path.join(ents, `${a.id}.md`);
  let snapshot;
  try {
    snapshot = readFileSync(file, 'utf-8');
  } catch {
    snapshot = `---\nid: ${a.id}\ntype: ${a.type}\nstatus: ${a.status}\nclassification: ${a.classification}\ncreated_at: "${ts}"\nupdated_at: "${ts}"\nttl_days: null\n---\n\n`;
  }
  events.push({
    event_id: evid(),
    timestamp: ts,
    agent_id: 'fixture',
    session_id: 'fixture-seed',
    action: 'atom_created',
    atom_refs: [a.id],
    schema_version: 2,
    atom_snapshot: snapshot,
  });
}

// One update event for atoms[10] (bumps its updated_at).
const updTarget = atoms[10];
if (updTarget) {
  const ts = `2026-04-25T10:00:00Z`;
  events.push({
    event_id: evid(),
    timestamp: ts,
    agent_id: 'fixture',
    session_id: 'fixture-seed',
    action: 'atom_updated',
    atom_refs: [updTarget.id],
    schema_version: 2,
    atom_snapshot: `---\nid: ${updTarget.id}\ntype: ${updTarget.type}\nstatus: ${updTarget.status}\nclassification: ${updTarget.classification}\ncreated_at: "2026-04-${String(updTarget.day).padStart(2, '0')}T10:00:00Z"\nupdated_at: "${ts}"\nttl_days: null\n---\n\nUpdated body for ${updTarget.id}.\n`,
  });
}

// Two archive events at the very end.
for (const idx of [2, 5]) {
  const a = atoms[idx];
  if (!a) continue;
  events.push({
    event_id: evid(),
    timestamp: `2026-04-26T10:00:00Z`,
    agent_id: 'fixture',
    session_id: 'fixture-seed',
    action: 'atom_archived',
    atom_refs: [a.id],
    schema_version: 2,
    // Archived events typically lack a snapshot — replay just removes.
  });
}

events.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
const ndjson = events.map((e) => JSON.stringify(e)).join('\n') + '\n';
writeFileSync(path.join(root, 'events.ndjson'), ndjson);
console.log(`wrote ${events.length} events to ${path.join(root, 'events.ndjson')}`);
