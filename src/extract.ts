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
import { callLLM } from './llm.js';
import { createAtom } from './retain.js';
import { insertTriples } from './triples.js';
import { indexExists, searchFts } from './index-db.js';
import { generateAtomId, DEFAULT_TTLS } from './schema.js';
import { detectAndResolveConflicts } from './conflict-detect.js';
import type { ConflictResolution } from './conflict-detect.js';
import type { AtomType, AtomFrontmatter } from './types.js';
import type { ExtractOptions, ExtractResult, ExtractedAtomResult, CandidateAtom } from './types.js';

export type { ExtractOptions, ExtractResult, ExtractedAtomResult, CandidateAtom };

const DEFAULT_MAX_ATOMS = 20;

// FTS rank threshold for possible_duplicate detection.
// BM25 ranks are negative; more negative = better match.
// A rank < -2.0 indicates a strong match.
const DUPLICATE_RANK_THRESHOLD = -2.0;

const EXTRACTION_SYSTEM_PROMPT = `You are a memory extraction assistant. Read the following conversation log and extract facts, decisions, preferences, beliefs, and assistant-generated content worth remembering long-term.

Pay special attention to the assistant's contributions:
- Recommendations and suggestions the assistant made
- Advice or explanations the assistant provided
- Facts, data, or information the assistant shared
- Creative outputs or solutions the assistant generated
- Specific answers to user questions

These should be extracted as "fact" type atoms with a tag "role:assistant" to distinguish them from user-provided information.

For each item, output a JSON object with:
- type: "fact" | "decision" | "preference" | "belief" | "open_question"
- slug: kebab-case unique identifier (e.g. "api-rate-limit-1000-rpm")
- title: short human-readable title
- body: markdown content (use ## Fact / ## Decision / ## Preference / ## Belief / ## Open Question heading, then the content)
- tags: string[] of relevant tags (use "role:assistant" for assistant-generated content, "role:user" for user-provided content)
- confidence: number 0-1 (for beliefs; use 1.0 for facts/decisions)
- rationale: one sentence explaining why this is worth remembering
- triples (optional): array of {subject, predicate, object} entity-relation triples extracted from the body. Use stable lower-cased predicates like "has_capital", "born_in", "works_at", "is_a". Triples enable semantic conflict detection so newer facts can supersede older ones.

For PREFERENCE atoms specifically:
- Set type to "preference"
- Add three extra fields: "subject", "preference", and "context"
  - subject: the topic of the preference (e.g. "coffee", "programming languages", "music")
  - preference: the preference statement (e.g. "prefers oat milk lattes", "favors TypeScript over Python")
  - context: when/why the preference was expressed (e.g. "mentioned during morning routine discussion")
- Add a tag "subject:<topic>" where <topic> is the subject in lowercase kebab-case
- Use this body template:
  ## Preference
  **Subject:** <subject>
  **Preference:** <preference statement>
  **Context:** <when/why expressed>

Look for preference signals: "I prefer", "I like", "I always", "I never", "my favorite", "I tend to",
expressions of taste, habitual choices, strong opinions about tools/foods/workflows, or any statement
where the user indicates a personal inclination or aversion. Also look for PREFERENCE: markers in
observer output.

Rules:
- Only extract things that are genuinely worth remembering across sessions
- Skip small talk, status updates, and transient information
- Prefer specific, actionable facts over vague observations
- For facts: include the specific value/detail
- For decisions: include why the decision was made
- For assistant responses: capture the specific recommendation, advice, or information shared
- Tag assistant-generated atoms with "role:assistant"
- Max {{max_atoms}} atoms

Output a JSON array of atom objects. If nothing is worth extracting, output [].`;

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
 * Collapse control characters (newlines, tabs) so an LLM-supplied field can't
 * inject extra Markdown structure into the preference body template.
 */
function sanitizeField(value: string | undefined): string {
  if (!value) return '';
  return value.replace(/[\r\n\t]+/g, ' ').trim();
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
      conflicts: 0,
      atoms: [],
    };
  }

  // --- Call LLM ---
  const systemPrompt = EXTRACTION_SYSTEM_PROMPT.replace('{{max_atoms}}', String(maxAtoms));
  const userPrompt = `Here is the conversation log to extract atoms from:\n\n${logContent}`;
  let candidates: CandidateAtom[];
  try {
    const raw = await callLLM(systemPrompt, userPrompt, { model });
    candidates = parseLLMResponse(raw);
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

    // Build scope with auto-extracted tag and extraction metadata
    const tags: string[] = [
      'auto-extracted',
      ...(candidate.tags ?? []),
    ];

    // Preference enrichment: structured body + subject tag
    let body = candidate.body;
    if (type === 'preference') {
      const subj = sanitizeField(candidate.subject);
      const pref = sanitizeField(candidate.preference);
      const ctx = sanitizeField(candidate.context);
      if (subj && pref) {
        body = `## Preference\n**Subject:** ${subj}\n**Preference:** ${pref}\n**Context:** ${ctx || 'not specified'}`;
        const subjectSlug = subj.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        if (subjectSlug) {
          const subjectTag = `subject:${subjectSlug}`;
          if (!tags.includes(subjectTag)) {
            tags.push(subjectTag);
          }
        }
      }
    }

    // Check FTS for possible duplicates against the body that will be stored
    const duplicateId = checkPossibleDuplicate(memoryDir, body);
    const isPossibleDuplicate = duplicateId !== null;

    if (isPossibleDuplicate) {
      possibleDuplicates++;
    }

    const scope: AtomFrontmatter['scope'] = { tags };

    if (!dryRun) {
      // Write atom as draft using createAtom (canonical creation path).
      // All extracted atoms are always written as draft regardless of type.
      const atom = createAtom({
        memoryDir,
        agent_id: agentId,
        session_id: sessionId,
        type,
        slug,
        body,
        confidence: candidate.confidence ?? (type === 'belief' ? 0.5 : 1.0),
        ttl_days: DEFAULT_TTLS[type] ?? null,
        scope,
        status: 'draft',
      });

      if (candidate.triples && candidate.triples.length > 0) {
        insertTriples(memoryDir, atom.frontmatter.id, candidate.triples);
      }

      let perAtomConflicts: ConflictResolution[] | undefined;
      if (opts.conflictDetect !== false && candidate.triples && candidate.triples.length > 0) {
        const dr = await detectAndResolveConflicts({
          memoryDir,
          newAtomId: atom.frontmatter.id,
          model: opts.conflictConfirmModel ?? model,
          agent_id: agentId,
          session_id: sessionId,
        });
        perAtomConflicts = dr.resolutions;
      }

      extracted++;
      atomResults.push({
        atom_id: atom.frontmatter.id,
        slug,
        type,
        status: isPossibleDuplicate ? 'possible_duplicate' : 'new',
        reason: isPossibleDuplicate ? `similar to ${duplicateId}` : undefined,
        possible_duplicate_of: isPossibleDuplicate ? (duplicateId ?? undefined) : undefined,
        conflicts: perAtomConflicts,
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

  const conflicts = atomResults.reduce(
    (acc, a) => acc + (a.conflicts?.filter((c) => c.action === 'superseded').length ?? 0),
    0,
  );

  return {
    extracted,
    skipped,
    possible_duplicates: possibleDuplicates,
    conflicts,
    atoms: atomResults,
  };
}
