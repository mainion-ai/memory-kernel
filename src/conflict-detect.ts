/**
 * conflict-detect — Tier-2 LLM confirmation and auto-supersede orchestration (#75).
 *
 * Tier 1 (in src/triples.ts) finds candidate conflicts via SQL: atoms that share
 * a (subject, predicate) but disagree on the object. Tier 2 here asks a cheap
 * LLM to confirm each candidate is a real semantic conflict. Confirmed conflicts
 * trigger the existing supersedeAtoms() kernel function.
 */

import { callLLM } from './llm.js';

const CONFIRM_SYSTEM_PROMPT = `You are a fact-conflict classifier. Given two factual statements about the world, decide whether they DIRECTLY CONTRADICT each other (i.e. cannot both be true at the same time about the same subject).

Reply with a single JSON object:
  {"conflict": true,  "reason": "<one short sentence>"}
or
  {"conflict": false, "reason": "<one short sentence>"}

Rules:
- "conflict" must be true ONLY if the two statements assert different values for the same property of the same entity.
- Different aspects, complementary details, or time-bounded updates of the same subject are NOT conflicts.
- Output JSON only. No prose, no code fences.`;

export interface ConfirmConflictInput {
  oldFact: string;
  newFact: string;
  model?: string;
}

export interface ConfirmConflictResult {
  conflict: boolean;
  reason: string;
}

/**
 * Strip optional ```json … ``` fences and surrounding whitespace.
 */
function stripFences(raw: string): string {
  const trimmed = raw.trim();
  const m = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?\s*```$/);
  return m ? m[1].trim() : trimmed;
}

/**
 * Ask the LLM to confirm whether two facts conflict.
 * Returns {conflict: false, reason: 'parse error'} on any failure — fail-safe
 * default avoids spurious supersedes when the model misbehaves.
 */
export async function confirmConflictWithLLM(
  input: ConfirmConflictInput,
): Promise<ConfirmConflictResult> {
  const userPrompt = `Old fact: ${input.oldFact}\nNew fact: ${input.newFact}\n\nDo these conflict?`;
  let raw: string;
  try {
    raw = await callLLM(CONFIRM_SYSTEM_PROMPT, userPrompt, {
      model: input.model,
      temperature: 0,
      maxTokens: 150,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { conflict: false, reason: `LLM call failed: ${msg}` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripFences(raw));
  } catch {
    return { conflict: false, reason: `parse error (raw: ${raw.slice(0, 60)})` };
  }

  if (
    typeof parsed === 'object' && parsed !== null &&
    'conflict' in parsed && typeof (parsed as Record<string, unknown>).conflict === 'boolean'
  ) {
    const p = parsed as { conflict: boolean; reason?: unknown };
    return {
      conflict: p.conflict,
      reason: typeof p.reason === 'string' ? p.reason : '',
    };
  }
  return { conflict: false, reason: 'malformed response (missing conflict field)' };
}
