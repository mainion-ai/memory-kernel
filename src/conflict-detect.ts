/**
 * conflict-detect — Tier-2 LLM confirmation and auto-supersede orchestration (#75).
 *
 * Tier 1 (in src/triples.ts) finds candidate conflicts via SQL: atoms that share
 * a (subject, predicate) but disagree on the object. Tier 2 here asks a cheap
 * LLM to confirm each candidate is a real semantic conflict. Confirmed conflicts
 * trigger the existing supersedeAtoms() kernel function.
 */

import { callLLM } from './llm.js';
import { findCandidateConflicts } from './triples.js';
import { supersedeAtoms } from './cli/supersede.js';
import { openIndex } from './index-db.js';

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

export type ConflictAction =
  | 'superseded'              // newer atom auto-superseded the older one
  | 'would_supersede'         // dry-run; supersede would have fired
  | 'not_a_conflict'          // Tier 2 LLM said no
  | 'skipped_wrong_direction' // new atom is older than the candidate → skip
  | 'skipped_self'            // candidate is the same atom (defensive — Tier-1 SQL already excludes this; here for safety)
  | 'supersede_failed'        // Tier 2 confirmed but the supersede write threw (e.g. atom file deleted between detection and write)
  | 'stale_decision';         // Tier 2 confirmed but candidate status changed (e.g. concurrent supersede) between detection and write — CAS skip, no write attempted

export interface ConflictResolution {
  old_atom_id: string;
  new_atom_id: string;
  action: ConflictAction;
  reason: string;
  subject: string;
  predicate: string;
  old_object: string;
  new_object: string;
}

export interface DetectAndResolveOptions {
  memoryDir: string;
  newAtomId: string;
  /** Model to use for Tier 2 confirmation. Same provider auto-detection as extract. */
  model?: string;
  /** When true, log what *would* happen but make no writes. */
  dryRun?: boolean;
  agent_id?: string;
  session_id?: string;
}

export interface DetectAndResolveResult {
  resolutions: ConflictResolution[];
  llm_calls: number;
}

/** Read created_at directly from the index — avoids loading the markdown twice. */
function getCreatedAt(memoryDir: string, atomId: string): string | null {
  const db = openIndex(memoryDir);
  const row = db.prepare('SELECT created_at FROM atoms WHERE atom_id = ?').get(atomId) as
    | { created_at: string }
    | undefined;
  return row?.created_at ?? null;
}

/** Read status directly from the index — used for the CAS check before supersede. */
function getStatus(memoryDir: string, atomId: string): string | null {
  const db = openIndex(memoryDir);
  const row = db.prepare('SELECT status FROM atoms WHERE atom_id = ?').get(atomId) as
    | { status: string }
    | undefined;
  return row?.status ?? null;
}

/**
 * Detect Tier-1 candidate conflicts against `newAtomId`, run Tier-2 LLM
 * confirmation on each, and auto-supersede older atoms when a conflict is
 * confirmed and the new atom is strictly newer than the candidate.
 *
 * Failure-mode policy: any per-candidate error is recorded as `not_a_conflict`
 * with a reason; the whole batch never throws. Extraction shouldn't fail just
 * because conflict resolution had a hiccup.
 */
export async function detectAndResolveConflicts(
  opts: DetectAndResolveOptions,
): Promise<DetectAndResolveResult> {
  const { memoryDir, newAtomId, model, dryRun = false } = opts;
  const resolutions: ConflictResolution[] = [];
  let llmCalls = 0;

  const candidates = findCandidateConflicts(memoryDir, newAtomId);
  if (candidates.length === 0) {
    return { resolutions, llm_calls: 0 };
  }

  const newCreatedAt = getCreatedAt(memoryDir, newAtomId);
  if (!newCreatedAt) {
    return { resolutions, llm_calls: 0 };
  }

  for (const c of candidates) {
    const oldCreatedAt = getCreatedAt(memoryDir, c.old_atom_id);
    if (!oldCreatedAt) continue;

    const baseRes = {
      old_atom_id: c.old_atom_id,
      new_atom_id: newAtomId,
      subject: c.new_triple.subject,
      predicate: c.new_triple.predicate,
      old_object: c.old_triple.object,
      new_object: c.new_triple.object,
    };

    if (c.old_atom_id === newAtomId) {
      resolutions.push({ ...baseRes, action: 'skipped_self', reason: 'self' });
      continue;
    }
    if (oldCreatedAt >= newCreatedAt) {
      resolutions.push({
        ...baseRes,
        action: 'skipped_wrong_direction',
        reason: 'candidate atom is at least as new as the ingested atom',
      });
      continue;
    }

    const confirm = await confirmConflictWithLLM({
      oldFact: `${c.old_triple.subject} ${c.old_triple.predicate} ${c.old_triple.object}`,
      newFact: `${c.new_triple.subject} ${c.new_triple.predicate} ${c.new_triple.object}`,
      model,
    });
    llmCalls++;

    if (!confirm.conflict) {
      resolutions.push({ ...baseRes, action: 'not_a_conflict', reason: confirm.reason });
      continue;
    }

    if (dryRun) {
      resolutions.push({ ...baseRes, action: 'would_supersede', reason: confirm.reason });
      continue;
    }

    // CAS guard (#107): the candidate was 'active' when Tier-1 returned it, but
    // a concurrent extract may have superseded it during our Tier-2 LLM call.
    // Re-check status immediately before the write. Narrows the race window
    // from human-scale (LLM latency) to a single function-call gap.
    const currentStatus = getStatus(memoryDir, c.old_atom_id);
    if (currentStatus !== 'active') {
      resolutions.push({
        ...baseRes,
        action: 'stale_decision',
        reason: `candidate atom status changed to '${currentStatus ?? 'missing'}' between detection and supersede`,
      });
      continue;
    }

    try {
      supersedeAtoms({
        memoryDir,
        oldAtomId: c.old_atom_id,
        newAtomId,
        agent_id: opts.agent_id ?? 'extract',
        session_id: opts.session_id ?? 'mk-conflict-detect',
      });
      resolutions.push({ ...baseRes, action: 'superseded', reason: confirm.reason });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      resolutions.push({
        ...baseRes,
        action: 'supersede_failed',
        reason: `supersede failed: ${msg}`,
      });
    }
  }

  return { resolutions, llm_calls: llmCalls };
}
