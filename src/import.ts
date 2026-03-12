/**
 * Import operation — parse markdown files into memory atoms.
 * "I have some notes. Extract what's worth remembering."
 *
 * Strategy: split by H2/H3 headings → one atom per section.
 * Fallback: extract bullet list items if no headings found.
 * Short chunks (< 20 chars) are skipped.
 */

import fs from 'fs';
import { createAtom } from './retain.js';
import type { AtomType, Classification } from './types.js';

export interface ImportFromFileOpts {
  filePath: string; // Absolute path to source markdown file
  memoryDir: string;
  agent_id: string;
  session_id: string;
  defaultType?: AtomType; // If set, overrides type auto-detection for all chunks
  defaultClassification?: Classification; // Default: 'TEAM'
}

export interface ImportResult {
  atoms_created: number;
  atoms_skipped: number;
  atom_ids: string[];
  source_file: string;
}

interface Chunk {
  heading?: string;
  body: string;
}

const MIN_CHUNK_LENGTH = 20;

/**
 * Preview what would be imported from a file without creating atoms.
 * Returns the list of extracted chunks.
 */
export function previewImport(filePath: string): Chunk[] {
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    throw new Error(`Cannot read import file: ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
  }
  return extractChunks(content);
}

/**
 * Import a markdown file as atoms.
 * Creates one atom per extracted chunk.
 */
export function importFromFile(opts: ImportFromFileOpts): ImportResult {
  let content: string;
  try {
    content = fs.readFileSync(opts.filePath, 'utf-8');
  } catch (err) {
    throw new Error(`Cannot read import file: ${opts.filePath}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const chunks = extractChunks(content);

  const atomIds: string[] = [];
  let skipped = 0;

  for (const chunk of chunks) {
    if (!chunk.body.trim() || chunk.body.trim().length < MIN_CHUNK_LENGTH) {
      skipped++;
      continue;
    }

    const type = opts.defaultType ?? inferType(chunk.body);
    const confidence = inferConfidence(chunk.body);

    // Derive a slug from the heading or first few words of the body
    const slugSource = chunk.heading ?? chunk.body;
    const slug = slugSource
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40) || `imported-${Date.now()}`;

    const atom = createAtom({
      memoryDir: opts.memoryDir,
      agent_id: opts.agent_id,
      session_id: opts.session_id,
      type,
      slug,
      body: chunk.body.trim(),
      confidence,
      classification: opts.defaultClassification ?? 'TEAM',
    });

    atomIds.push(atom.frontmatter.id);
  }

  return {
    atoms_created: atomIds.length,
    atoms_skipped: skipped,
    atom_ids: atomIds,
    source_file: opts.filePath,
  };
}

/**
 * Extract chunks from markdown content.
 * Priority: H2/H3 heading sections → bullet list items → single body chunk.
 */
export function extractChunks(content: string): Chunk[] {
  // Try heading-based extraction first
  const headingChunks = extractHeadingChunks(content);
  if (headingChunks.length > 0) {
    // For sections whose body is too short, fall back to bullet extraction within that section
    const result: Chunk[] = [];
    for (const chunk of headingChunks) {
      if (chunk.body.trim().length >= MIN_CHUNK_LENGTH) {
        result.push(chunk);
      } else {
        const bullets = extractBullets(chunk.body);
        result.push(...bullets.map((b) => ({ body: b })));
      }
    }
    return result;
  }

  // No headings: try bullet extraction on the whole content
  const bullets = extractBullets(content);
  if (bullets.length > 0) {
    return bullets.map((b) => ({ body: b }));
  }

  // Last resort: treat the whole content as one chunk
  const trimmed = content.trim();
  return trimmed.length >= MIN_CHUNK_LENGTH ? [{ body: trimmed }] : [];
}

function extractHeadingChunks(content: string): Chunk[] {
  const chunks: Chunk[] = [];
  // Match H2 or H3 headings and capture everything until the next heading of same/higher level
  const sectionRegex = /^#{2,3}\s+(.+)$/gm;
  const lines = content.split('\n');
  const headingIndices: Array<{ index: number; heading: string }> = [];

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^#{2,3}\s+(.+)$/);
    if (match) {
      headingIndices.push({ index: i, heading: match[1].trim() });
    }
  }

  // Silence unused import warning
  void sectionRegex;

  for (let h = 0; h < headingIndices.length; h++) {
    const start = headingIndices[h].index + 1;
    const end = h + 1 < headingIndices.length ? headingIndices[h + 1].index : lines.length;
    const body = lines.slice(start, end).join('\n').trim();
    chunks.push({ heading: headingIndices[h].heading, body });
  }

  return chunks;
}

function extractBullets(content: string): string[] {
  const bullets: string[] = [];
  const lines = content.split('\n');
  let current = '';

  for (const line of lines) {
    const bulletMatch = line.match(/^[-*]\s+(.*)/);
    if (bulletMatch) {
      if (current) bullets.push(current.trim());
      current = bulletMatch[1];
    } else if (current && /^\s{2,}/.test(line)) {
      // Continuation line (indented)
      current += ' ' + line.trim();
    } else {
      if (current) {
        bullets.push(current.trim());
        current = '';
      }
    }
  }
  if (current) bullets.push(current.trim());

  return bullets.filter((b) => b.length >= MIN_CHUNK_LENGTH);
}

/**
 * Infer atom type from body content using keyword heuristics.
 */
function inferType(body: string): AtomType {
  if (/\b(decided|decision|chose|use|adopt|selected)\b/i.test(body)) return 'decision';
  if (/\b(must|never|always|constraint|forbidden|required|do not|shall not)\b/i.test(body)) return 'constraint';
  if (/\b(question|unknown|unclear|open|unresolved|why|how do)\b/i.test(body)) return 'open_question';
  if (/\b(believe|think|assume|probably|should be|might be)\b/i.test(body)) return 'belief';
  return 'fact';
}

/**
 * Infer confidence from body content.
 * Higher confidence for specific, code-like, or URL-containing content.
 */
function inferConfidence(body: string): number {
  if (/\b(believe|think|probably|might|should be)\b/i.test(body)) return 0.5;
  if (/https?:\/\//.test(body)) return 0.9;
  if (/`[^`]+`/.test(body)) return 0.9; // Contains inline code
  if (/\d{4}/.test(body)) return 0.85; // Contains years or version numbers
  return 0.75; // Default prose
}
