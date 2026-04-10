/**
 * Enrich Relations — LLM-based reclassification of 'related' edges.
 *
 * Reads atom pairs connected by 'related' edges, sends their content
 * to an LLM, and reclassifies the edge into a more specific type
 * (extends, supports, contradicts, caused_by, applied_to).
 *
 * Supports both Claude (via Anthropic API) and Ollama (local) backends.
 */

import {
  listAtoms,
  writeAtom,
  indexExists,
  indexAtom,
} from './index.js';
import type { Atom, Relation, RelationType } from './types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type EnrichBackend = 'claude' | 'ollama';

export interface EnrichOptions {
  memoryDir: string;
  backend: EnrichBackend;
  model?: string;
  ollamaUrl?: string;
  dryRun: boolean;
  /** Only enrich edges of this type (default: 'related') */
  sourceType?: RelationType;
  /** Also re-check existing typed edges, not just 'related' */
  recheck?: boolean;
  /** Callback for progress reporting */
  onProgress?: (done: number, total: number) => void;
}

export interface EnrichResult {
  total: number;
  changed: number;
  kept: number;
  errors: number;
  changes: Array<{
    sourceId: string;
    targetId: string;
    oldType: RelationType;
    newType: RelationType;
    reasoning: string;
  }>;
}

export interface ClassificationResult {
  type: RelationType;
  reasoning: string;
}

// ---------------------------------------------------------------------------
// Valid relation types for enrichment (includes applied_to)
// ---------------------------------------------------------------------------

const ENRICHMENT_TYPES: readonly string[] = [
  'extends',
  'contradicts',
  'supports',
  'caused_by',
  'supersedes',
  'applied_to',
  'related',
] as const;

// ---------------------------------------------------------------------------
// LLM classification prompt
// ---------------------------------------------------------------------------

function buildClassificationPrompt(
  sourceAtom: Atom,
  targetAtom: Atom,
  currentType: RelationType,
): string {
  const sourceTitle = sourceAtom.frontmatter.id;
  const targetTitle = targetAtom.frontmatter.id;

  // Truncate bodies to avoid excessive token usage
  const maxBody = 1500;
  const sourceBody = sourceAtom.body.length > maxBody
    ? sourceAtom.body.slice(0, maxBody) + '\n[...truncated]'
    : sourceAtom.body;
  const targetBody = targetAtom.body.length > maxBody
    ? targetAtom.body.slice(0, maxBody) + '\n[...truncated]'
    : targetAtom.body;

  return `Classify the relationship between two memory atoms.

## Source Atom
ID: ${sourceTitle}
Type: ${sourceAtom.frontmatter.type}
${sourceBody}

## Target Atom
ID: ${targetTitle}
Type: ${targetAtom.frontmatter.type}
${targetBody}

## Current Classification
${currentType}

## Relation Types
- extends: Source builds on, elaborates, or generalizes the target's idea
- contradicts: Source conflicts with, opposes, or inverts the target
- supports: Source provides evidence for, confirms, or validates the target
- caused_by: Source was triggered by, motivated by, or resulted from the target
- supersedes: Source replaces or obsoletes the target
- applied_to: Source applies the target's idea to a new domain or context
- related: Generic connection (use ONLY if none of the above fit)

## Instructions
Based on the content of both atoms, determine the most accurate relationship type from Source → Target.
Consider how the source references or builds upon the target.

Respond with EXACTLY this format (no extra text):
TYPE: <one of: extends, contradicts, supports, caused_by, supersedes, applied_to, related>
REASONING: <one sentence explaining why>`;
}

// ---------------------------------------------------------------------------
// LLM backends
// ---------------------------------------------------------------------------

function parseClassificationResponse(text: string): ClassificationResult {
  const typeMatch = text.match(/TYPE:\s*(\S+)/i);
  const reasoningMatch = text.match(/REASONING:\s*(.+)/i);

  const rawType = typeMatch?.[1]?.toLowerCase().trim() ?? 'related';
  const type = ENRICHMENT_TYPES.includes(rawType) ? rawType as RelationType : 'related';
  const reasoning = reasoningMatch?.[1]?.trim() ?? 'No reasoning provided';

  return { type, reasoning };
}

async function classifyWithClaude(
  prompt: string,
  model: string,
): Promise<ClassificationResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 150,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Claude API error ${response.status}: ${err}`);
  }

  const data = await response.json() as {
    content: Array<{ type: string; text: string }>;
  };
  const text = data.content?.[0]?.text ?? '';
  return parseClassificationResponse(text);
}

async function classifyWithOllama(
  prompt: string,
  model: string,
  ollamaUrl: string,
): Promise<ClassificationResult> {
  const response = await fetch(`${ollamaUrl}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      prompt,
      stream: false,
      options: { num_predict: 150, temperature: 0.1 },
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Ollama error ${response.status}: ${err}`);
  }

  const data = await response.json() as { response: string };
  return parseClassificationResponse(data.response ?? '');
}

async function classify(
  prompt: string,
  options: EnrichOptions,
): Promise<ClassificationResult> {
  const { backend, model, ollamaUrl } = options;

  if (backend === 'claude') {
    return classifyWithClaude(prompt, model ?? 'claude-sonnet-4-20250514');
  } else {
    return classifyWithOllama(
      prompt,
      model ?? 'llama3.2',
      ollamaUrl ?? 'http://localhost:11434',
    );
  }
}

// ---------------------------------------------------------------------------
// Core enrichment logic
// ---------------------------------------------------------------------------

/**
 * Find all edges that need enrichment.
 */
function findEdgesToEnrich(
  atoms: Atom[],
  options: EnrichOptions,
): Array<{ source: Atom; target: Atom; relation: Relation; relationIndex: number }> {
  const atomMap = new Map<string, Atom>();
  for (const a of atoms) atomMap.set(a.frontmatter.id, a);

  const edges: Array<{
    source: Atom;
    target: Atom;
    relation: Relation;
    relationIndex: number;
  }> = [];

  const filterType = options.sourceType ?? 'related';

  for (const atom of atoms) {
    const relations = atom.frontmatter.relations ?? [];
    for (let i = 0; i < relations.length; i++) {
      const rel = relations[i];
      const shouldEnrich = options.recheck || rel.type === filterType;
      if (!shouldEnrich) continue;

      const target = atomMap.get(rel.target);
      if (!target) continue; // Target doesn't exist

      edges.push({ source: atom, target, relation: rel, relationIndex: i });
    }
  }

  return edges;
}

/**
 * Enrich relations: reclassify 'related' edges using an LLM.
 */
export async function enrichRelations(
  options: EnrichOptions,
): Promise<EnrichResult> {
  const atoms = listAtoms(options.memoryDir);
  const edges = findEdgesToEnrich(atoms, options);

  const result: EnrichResult = {
    total: edges.length,
    changed: 0,
    kept: 0,
    errors: 0,
    changes: [],
  };

  if (edges.length === 0) return result;

  // Track which atoms need writing
  const dirtyAtoms = new Set<string>();

  for (let i = 0; i < edges.length; i++) {
    const { source, target, relation, relationIndex } = edges[i];

    try {
      const prompt = buildClassificationPrompt(source, target, relation.type);
      const classification = await classify(prompt, options);

      if (classification.type !== relation.type) {
        result.changed++;
        result.changes.push({
          sourceId: source.frontmatter.id,
          targetId: target.frontmatter.id,
          oldType: relation.type,
          newType: classification.type,
          reasoning: classification.reasoning,
        });

        if (!options.dryRun) {
          // Update the relation in-place
          const relations = source.frontmatter.relations!;
          relations[relationIndex] = {
            target: relation.target,
            type: classification.type,
          };
          dirtyAtoms.add(source.frontmatter.id);
        }
      } else {
        result.kept++;
      }
    } catch (err) {
      result.errors++;
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  ✗ Error classifying ${source.frontmatter.id} → ${target.frontmatter.id}: ${msg}`);
    }

    options.onProgress?.(i + 1, edges.length);
  }

  // Write dirty atoms to disk
  if (!options.dryRun) {
    const atomMap = new Map<string, Atom>();
    for (const a of atoms) atomMap.set(a.frontmatter.id, a);

    for (const id of dirtyAtoms) {
      const atom = atomMap.get(id);
      if (atom?.filePath) {
        writeAtom(atom, atom.filePath);
        if (indexExists(options.memoryDir)) {
          indexAtom(options.memoryDir, atom);
        }
      }
    }
  }

  return result;
}
