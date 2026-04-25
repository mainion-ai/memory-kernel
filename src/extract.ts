/**
 * extract — automatic atom extraction from conversation logs.
 *
 * Reads a conversation log file, calls an LLM to extract candidate atoms,
 * reconciles against existing store, and writes drafts.
 *
 * LLM providers:
 *   - Default: claude -p subprocess (Claude Code CLI at /usr/bin/claude)
 *   - If --model contains ':' or is a known Ollama model name: Ollama HTTP API
 */

import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { createAtom } from './retain.js';
import { indexExists, searchFts } from './index-db.js';
import { generateAtomId, DEFAULT_TTLS } from './schema.js';
import type { AtomType, AtomFrontmatter } from './types.js';
import type { ExtractOptions, ExtractResult, ExtractedAtomResult, CandidateAtom } from './types.js';

export type { ExtractOptions, ExtractResult, ExtractedAtomResult, CandidateAtom };

const DEFAULT_MODEL_CLAUDE = 'claude';
const DEFAULT_MAX_ATOMS = 20;

// FTS rank threshold for possible_duplicate detection.
// BM25 ranks are negative; more negative = better match.
// A rank < -2.0 indicates a strong match.
const DUPLICATE_RANK_THRESHOLD = -2.0;

const SYSTEM_PROMPT = `You are a memory extraction assistant. Read the following conversation log and extract facts, decisions, preferences, and beliefs worth remembering long-term.

For each item, output a JSON object with:
- type: "fact" | "decision" | "preference" | "belief" | "open_question"
- slug: kebab-case unique identifier (e.g. "api-rate-limit-1000-rpm")
- title: short human-readable title
- body: markdown content (use ## Fact / ## Decision / ## Preference / ## Belief / ## Open Question heading, then the content)
- tags: string[] of relevant tags
- confidence: number 0-1 (for beliefs; use 1.0 for facts/decisions)
- rationale: one sentence explaining why this is worth remembering

Rules:
- Only extract things that are genuinely worth remembering across sessions
- Skip small talk, status updates, and transient information
- Prefer specific, actionable facts over vague observations
- For facts: include the specific value/detail
- For decisions: include why the decision was made
- Max {{max_atoms}} atoms

Output a JSON array of atom objects. If nothing is worth extracting, output [].`;

/**
 * Detect if a model string refers to an Ollama model.
 * Ollama models typically have the form "name:tag" (e.g. "qwen2.5:14b").
 */
function isOllamaModel(model: string): boolean {
  return model.includes(':');
}

/**
 * Parse LLM response — strips code fences, returns array of CandidateAtom.
 */
function parseLLMResponse(raw: string): CandidateAtom[] {
  let cleaned = raw.trim();

  // Strip markdown code fences
  const fenceMatch = cleaned.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?\s*```$/);
  if (fenceMatch) {
    cleaned = fenceMatch[1].trim();
  }

  // Find the first '[' and last ']' to extract just the JSON array
  const arrStart = cleaned.indexOf('[');
  const arrEnd = cleaned.lastIndexOf(']');
  if (arrStart !== -1 && arrEnd !== -1 && arrEnd > arrStart) {
    cleaned = cleaned.slice(arrStart, arrEnd + 1);
  }

  const parsed = JSON.parse(cleaned);
  if (!Array.isArray(parsed)) {
    throw new Error(`LLM returned non-array: ${typeof parsed}`);
  }
  return parsed as CandidateAtom[];
}

/**
 * Call claude -p subprocess for extraction.
 */
function callClaude(
  logContent: string,
  opts: { maxAtoms: number },
): CandidateAtom[] {
  const systemPrompt = SYSTEM_PROMPT.replace('{{max_atoms}}', String(opts.maxAtoms));
  const userPrompt = `Here is the conversation log to extract atoms from:\n\n${logContent}`;

  const claudeBin = process.env.CLAUDE_PATH ?? 'claude';
  const output = execFileSync(
    claudeBin,
    ['-p', '--system-prompt', systemPrompt],
    { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024, timeout: 120_000, input: userPrompt },
  );

  return parseLLMResponse(output);
}

/**
 * Call Ollama HTTP API for extraction.
 */
async function callOllama(
  logContent: string,
  opts: { model: string; maxAtoms: number; ollamaUrl?: string },
): Promise<CandidateAtom[]> {
  const systemPrompt = SYSTEM_PROMPT.replace('{{max_atoms}}', String(opts.maxAtoms));
  const prompt = `${systemPrompt}\n\nHere is the conversation log to extract atoms from:\n\n${logContent}`;
  const ollamaUrl = opts.ollamaUrl ?? 'http://localhost:11434';

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120_000);

  let resp: Response;
  try {
    resp = await fetch(`${ollamaUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: opts.model, prompt, stream: false }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!resp.ok) {
    throw new Error(`Ollama API error: ${resp.status} ${resp.statusText}`);
  }

  const data = (await resp.json()) as { response?: string };
  if (!data.response) {
    throw new Error('Ollama returned no response');
  }

  return parseLLMResponse(data.response);
}

/**
 * Check if an atom with the given slug already exists on disk.
 */
function slugExists(memoryDir: string, type: AtomType, slug: string): boolean {
  const entitiesDir = path.join(memoryDir, 'ENTITIES');
  if (!fs.existsSync(entitiesDir)) return false;

  const slugUpper = slug.toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  const typePrefix = type.toUpperCase().slice(0, 4);
  const files = fs.readdirSync(entitiesDir);

  for (const file of files) {
    if (file.startsWith(`${typePrefix}-`) && file.includes(`-${slugUpper}-`)) {
      return true;
    }
  }
  return false;
}

/**
 * Check FTS for possible duplicates.
 * Returns the ID of the closest match if above threshold, else null.
 */
function checkPossibleDuplicate(memoryDir: string, body: string): string | null {
  if (!indexExists(memoryDir)) return null;

  const query = body.slice(0, 200);
  const results = searchFts(memoryDir, query, 1);
  if (!results || results.length === 0) return null;

  const top = results[0];
  if (top.rank < DUPLICATE_RANK_THRESHOLD) {
    return top.atom_id;
  }
  return null;
}

/**
 * Main extraction function.
 */
export async function extractFromLog(opts: ExtractOptions): Promise<ExtractResult> {
  const {
    logPath,
    memoryDir,
    agentId = 'extract',
    sessionId = `extract-${Date.now()}`,
    dryRun = false,
    model,
    maxAtoms = DEFAULT_MAX_ATOMS,
    skipLines = 0,
  } = opts;

  // --- Read log file ---
  if (!fs.existsSync(logPath)) {
    throw new Error(`Log file not found: ${logPath}`);
  }

  let logContent = fs.readFileSync(logPath, 'utf-8');

  // Skip first N lines (e.g. to skip CLAUDE.md preamble)
  if (skipLines > 0) {
    const lines = logContent.split('\n');
    logContent = lines.slice(skipLines).join('\n');
  }

  if (!logContent.trim()) {
    return {
      extracted: 0,
      skipped: 0,
      possible_duplicates: 0,
      atoms: [],
    };
  }

  // --- Call LLM ---
  let candidates: CandidateAtom[];
  try {
    if (model && isOllamaModel(model)) {
      candidates = await callOllama(logContent, { model, maxAtoms });
    } else {
      // Use claude -p subprocess (synchronous)
      candidates = callClaude(logContent, { maxAtoms });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`LLM extraction failed: ${msg}`);
  }

  // --- Reconcile and write ---
  const atomResults: ExtractedAtomResult[] = [];
  let extracted = 0;
  let skipped = 0;
  let possibleDuplicates = 0;

  const validTypes: AtomType[] = [
    'fact',
    'decision',
    'preference',
    'belief',
    'open_question',
  ];

  for (const candidate of candidates) {
    const type = candidate.type as AtomType;
    const slug = candidate.slug;

    // Validate type
    if (!validTypes.includes(type)) {
      skipped++;
      atomResults.push({
        atom_id: null,
        slug,
        type,
        status: 'skipped',
        reason: `Invalid atom type: ${type}`,
      });
      continue;
    }

    // Check slug collision
    if (slugExists(memoryDir, type, slug)) {
      skipped++;
      atomResults.push({
        atom_id: null,
        slug,
        type,
        status: 'skipped',
        reason: 'slug exists',
      });
      continue;
    }

    // Check FTS for possible duplicates
    const duplicateId = checkPossibleDuplicate(memoryDir, candidate.body);
    const isPossibleDuplicate = duplicateId !== null;

    if (isPossibleDuplicate) {
      possibleDuplicates++;
    }

    // Build scope with auto-extracted tag and extraction metadata
    const scope: AtomFrontmatter['scope'] = {
      tags: [
        'auto-extracted',
        ...(candidate.tags ?? []),
      ],
    };

    if (!dryRun) {
      // Write atom as draft using createAtom (canonical creation path).
      // All extracted atoms are always written as draft regardless of type.
      const atom = createAtom({
        memoryDir,
        agent_id: agentId,
        session_id: sessionId,
        type,
        slug,
        body: candidate.body,
        confidence: candidate.confidence ?? (type === 'belief' ? 0.5 : 1.0),
        ttl_days: DEFAULT_TTLS[type] ?? null,
        scope,
        status: 'draft',
      });

      extracted++;
      atomResults.push({
        atom_id: atom.frontmatter.id,
        slug,
        type,
        status: isPossibleDuplicate ? 'possible_duplicate' : 'new',
        reason: isPossibleDuplicate ? `similar to ${duplicateId}` : undefined,
        possible_duplicate_of: isPossibleDuplicate ? (duplicateId ?? undefined) : undefined,
      });
    } else {
      // Dry run: generate a placeholder ID for display
      const previewId = generateAtomId(type, slug);
      extracted++;
      atomResults.push({
        atom_id: previewId,
        slug,
        type,
        status: isPossibleDuplicate ? 'possible_duplicate' : 'new',
        reason: isPossibleDuplicate ? `similar to ${duplicateId}` : undefined,
        possible_duplicate_of: isPossibleDuplicate ? (duplicateId ?? undefined) : undefined,
      });
    }
  }

  return {
    extracted,
    skipped,
    possible_duplicates: possibleDuplicates,
    atoms: atomResults,
  };
}
