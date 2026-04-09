/**
 * Enrich relations — LLM-based reclassification of "related" edges.
 *
 * Reads all `related`-type edges from the SQLite index, sends pairs of
 * atom bodies to an Ollama endpoint for classification, and optionally
 * writes the reclassified relation type back to frontmatter + index.
 */

import {
  getAllRelations,
  listAtoms,
  writeAtom,
  indexAtom,
  indexExists,
} from './index.js';
import type { Atom } from './types.js';
import type { AtomRelation } from './index-db.js';
import type { RelationType } from './types.js';
import { RELATION_TYPES } from './types.js';

export interface EnrichmentProposal {
  sourceId: string;
  targetId: string;
  oldType: string;
  newType: RelationType;
  confidence: number;
  reasoning: string;
}

export interface EnrichResult {
  total_related: number;
  proposals: EnrichmentProposal[];
  kept_related: number;
  errors: number;
  applied?: number;
}

interface OllamaResponse {
  type: string;
  confidence: number;
  reasoning: string;
}

const DEFAULT_OLLAMA_URL = 'http://192.168.1.213:11434';
const DEFAULT_MODEL = 'qwen2.5:14b-instruct-q4_K_M';
const DEFAULT_MIN_CONFIDENCE = 0.7;
const DEFAULT_BATCH_SIZE = 5;

function buildPrompt(sourceId: string, sourceBody: string, targetId: string, targetBody: string): string {
  const srcSnippet = sourceBody.slice(0, 500);
  const tgtSnippet = targetBody.slice(0, 500);

  return `You are classifying the relationship between two memory atoms.

Source atom (ID: ${sourceId}):
${srcSnippet}

Target atom (ID: ${targetId}):
${tgtSnippet}

The current relationship type is "related" (generic). Classify it as one of:
- extends: source builds on, elaborates, or generalizes the target
- supports: source provides evidence for or confirms the target
- contradicts: source disagrees with, opposes, or conflicts with the target
- caused_by: source was caused by or triggered by the target
- supersedes: source replaces or obsoletes the target
- related: keep as generic if none of the above clearly applies

Respond with ONLY a JSON object (no markdown, no explanation):
{"type": "<relation_type>", "confidence": <0.0-1.0>, "reasoning": "<one sentence>"}`;
}

function parseOllamaResponse(raw: string): OllamaResponse | null {
  try {
    const parsed = JSON.parse(raw.trim());
    if (
      typeof parsed.type !== 'string' ||
      typeof parsed.confidence !== 'number' ||
      typeof parsed.reasoning !== 'string'
    ) {
      return null;
    }
    if (!(RELATION_TYPES as readonly string[]).includes(parsed.type)) {
      return null;
    }
    return parsed as OllamaResponse;
  } catch {
    return null;
  }
}

async function classifyEdge(
  sourceId: string,
  sourceBody: string,
  targetId: string,
  targetBody: string,
  ollamaUrl: string,
  model: string,
): Promise<OllamaResponse | null> {
  const prompt = buildPrompt(sourceId, sourceBody, targetId, targetBody);

  const resp = await fetch(`${ollamaUrl}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, prompt, stream: false }),
  });

  if (!resp.ok) {
    return null;
  }

  const data = (await resp.json()) as { response?: string };
  if (!data.response) return null;

  return parseOllamaResponse(data.response);
}

export async function enrichRelations(
  memoryDir: string,
  options: {
    dryRun: boolean;
    ollamaUrl?: string;
    model?: string;
    minConfidence?: number;
    batchSize?: number;
  },
): Promise<EnrichResult> {
  const ollamaUrl = options.ollamaUrl ?? DEFAULT_OLLAMA_URL;
  const model = options.model ?? DEFAULT_MODEL;
  const minConfidence = options.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;

  const allEdges = getAllRelations(memoryDir);
  const relatedEdges = allEdges.filter((e: AtomRelation) => e.relation_type === 'related');

  if (relatedEdges.length === 0) {
    return { total_related: 0, proposals: [], kept_related: 0, errors: 0 };
  }

  // Build ID → Atom map for body lookups
  const atoms = listAtoms(memoryDir);
  const atomMap = new Map<string, Atom>();
  for (const atom of atoms) {
    atomMap.set(atom.frontmatter.id, atom);
  }

  const proposals: EnrichmentProposal[] = [];
  let errors = 0;
  let keptRelated = 0;

  // Process in batches
  for (let i = 0; i < relatedEdges.length; i += batchSize) {
    const batch = relatedEdges.slice(i, i + batchSize);

    // Progress on stderr so stdout stays clean for piping
    process.stderr.write(`Processing ${i + 1}-${Math.min(i + batchSize, relatedEdges.length)}/${relatedEdges.length}...\n`);

    const results = await Promise.allSettled(
      batch.map(async (edge: AtomRelation) => {
        const sourceAtom = atomMap.get(edge.source_id);
        const targetAtom = atomMap.get(edge.target_id);
        if (!sourceAtom) throw new Error(`Cannot read source atom: ${edge.source_id}`);
        if (!targetAtom) throw new Error(`Cannot read target atom: ${edge.target_id}`);

        const classification = await classifyEdge(
          edge.source_id, sourceAtom.body,
          edge.target_id, targetAtom.body,
          ollamaUrl, model,
        );

        if (!classification) {
          throw new Error(`Invalid response for ${edge.source_id} -> ${edge.target_id}`);
        }

        return { edge, classification };
      }),
    );

    for (const result of results) {
      if (result.status === 'rejected') {
        errors++;
        continue;
      }

      const { edge, classification } = result.value;

      if (classification.type === 'related' || classification.confidence < minConfidence) {
        keptRelated++;
        continue;
      }

      proposals.push({
        sourceId: edge.source_id,
        targetId: edge.target_id,
        oldType: 'related',
        newType: classification.type as RelationType,
        confidence: classification.confidence,
        reasoning: classification.reasoning,
      });
    }
  }

  const enrichResult: EnrichResult = {
    total_related: relatedEdges.length,
    proposals,
    kept_related: keptRelated,
    errors,
  };

  // Apply mode: update frontmatter and reindex
  if (!options.dryRun && proposals.length > 0) {
    let applied = 0;

    for (const proposal of proposals) {
      try {
        const atom = atomMap.get(proposal.sourceId);
        if (!atom?.filePath || !atom.frontmatter.relations) continue;

        const rel = atom.frontmatter.relations.find(
          (r) => r.target === proposal.targetId && r.type === 'related',
        );
        if (rel) {
          rel.type = proposal.newType;
          writeAtom(atom, atom.filePath);
          if (indexExists(memoryDir)) {
            indexAtom(memoryDir, atom);
          }
          applied++;
        }
      } catch {
        process.stderr.write(`Warning: failed to apply ${proposal.sourceId} -> ${proposal.targetId}\n`);
      }
    }

    enrichResult.applied = applied;
  }

  return enrichResult;
}
