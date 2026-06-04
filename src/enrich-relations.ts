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
  indexExists,
  assertWithinDir,
} from './index.js';
import { indexAtom } from './index-db.js';
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

const DEFAULT_OLLAMA_URL = 'http://localhost:11434';
const DEFAULT_MODEL = 'qwen2.5:14b-instruct-q4_K_M';
const DEFAULT_MIN_CONFIDENCE = 0.7;
const DEFAULT_BATCH_SIZE = 5;

/**
 * Maximum number of characters retained from the LLM `reasoning` field.
 *
 * LLMs occasionally return verbose multi-paragraph reasoning even when asked
 * for "one sentence". Without a cap, this would inflate event-log snapshots
 * (rendered into atom YAML frontmatter via the apply path) and bloat any
 * downstream UI that surfaces proposals. 2000 chars is enough for a
 * paragraph or two — anything longer is noise.
 */
export const MAX_REASONING_LEN = 2000;

/** Marker appended to truncated reasoning so consumers can detect the cap was hit. */
const TRUNCATION_MARKER = ' …[truncated]';

/** Cap `reasoning` to MAX_REASONING_LEN, appending a marker when truncated. */
function capReasoning(reasoning: string): string {
  if (reasoning.length <= MAX_REASONING_LEN) return reasoning;
  return reasoning.slice(0, MAX_REASONING_LEN) + TRUNCATION_MARKER;
}

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
- applied_to: source applies the target's idea to a new domain or context
- related: keep as generic if none of the above clearly applies

Respond with ONLY a JSON object (no markdown, no explanation):
{"type": "<relation_type>", "confidence": <0.0-1.0>, "reasoning": "<one sentence>"}`;
}

function parseOllamaResponse(raw: string): OllamaResponse | null {
  try {
    // Strip markdown code fences (```json ... ```) that some models wrap around JSON
    let cleaned = raw.trim();
    const fenceMatch = cleaned.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?\s*```$/);
    if (fenceMatch) {
      cleaned = fenceMatch[1].trim();
    }
    const parsed = JSON.parse(cleaned);
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
    if (parsed.confidence < 0 || parsed.confidence > 1) {
      return null;
    }
    // Defensive cap: LLMs sometimes return verbose multi-paragraph reasoning
    // even when asked for one sentence. Truncate here so callers (and the
    // event-log snapshots that capture proposal text) never see runaway sizes.
    parsed.reasoning = capReasoning(parsed.reasoning);
    return parsed as OllamaResponse;
  } catch {
    return null;
  }
}

async function classifyEdgeOllama(
  sourceId: string,
  sourceBody: string,
  targetId: string,
  targetBody: string,
  ollamaUrl: string,
  model: string,
): Promise<OllamaResponse | null> {
  const prompt = buildPrompt(sourceId, sourceBody, targetId, targetBody);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);

  let resp: Response;
  try {
    resp = await fetch(`${ollamaUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, prompt, stream: false }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!resp.ok) {
    return null;
  }

  const data = (await resp.json()) as { response?: string };
  if (!data.response) return null;

  return parseOllamaResponse(data.response);
}

async function classifyEdgeAnthropic(
  sourceId: string,
  sourceBody: string,
  targetId: string,
  targetBody: string,
  model: string,
  apiKey: string,
  baseUrl?: string,
): Promise<OllamaResponse | null> {
  const prompt = buildPrompt(sourceId, sourceBody, targetId, targetBody);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);

  const url = `${baseUrl || 'https://api.anthropic.com'}/v1/messages`;

  let resp: Response;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: 256,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!resp.ok) {
    return null;
  }

  const data = (await resp.json()) as {
    content?: Array<{ type: string; text?: string }>;
  };
  const text = data.content?.find((b) => b.type === 'text')?.text;
  if (!text) return null;

  return parseOllamaResponse(text);
}

type Provider = 'ollama' | 'anthropic';

async function classifyEdge(
  sourceId: string,
  sourceBody: string,
  targetId: string,
  targetBody: string,
  ollamaUrl: string,
  model: string,
  provider: Provider = 'ollama',
  apiKey?: string,
  baseUrl?: string,
): Promise<OllamaResponse | null> {
  if (provider === 'anthropic') {
    if (!apiKey) return null;
    return classifyEdgeAnthropic(sourceId, sourceBody, targetId, targetBody, model, apiKey, baseUrl);
  }
  return classifyEdgeOllama(sourceId, sourceBody, targetId, targetBody, ollamaUrl, model);
}

export async function enrichRelations(
  memoryDir: string,
  options: {
    dryRun: boolean;
    ollamaUrl?: string;
    model?: string;
    minConfidence?: number;
    batchSize?: number;
    onProgress?: (current: number, total: number) => void;
    provider?: Provider;
    apiKey?: string;
    baseUrl?: string;
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

    if (options.onProgress) {
      options.onProgress(i + 1, relatedEdges.length);
    }

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
          options.provider ?? 'ollama',
          options.apiKey,
          options.baseUrl,
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
          assertWithinDir(memoryDir, atom.filePath);
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
