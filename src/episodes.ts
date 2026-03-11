/**
 * Episode store — per-session summary artifacts in EPISODES/.
 *
 * Episodes are lightweight markdown files capturing what happened in a session.
 * They are excluded from normal atom recall but loadable via include_episodes.
 */

import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import matter from 'gray-matter';
import { writeFileAtomic } from './store.js';
import { normalizeTimestamp } from './format.js';

export interface Episode {
  id: string;         // EP-{kebab-session-id}
  session_id: string; // sanitized session ID
  created_at: string; // ISO8601 UTC
  summary: string;    // Markdown body content
  filePath: string;   // Full path to episode file
}

export interface ListEpisodesOptions {
  limit?: number; // Max episodes to return (0 = empty array)
}

/**
 * Sanitize a session ID to kebab-case for use as a filename.
 * Replaces spaces, slashes, and other non-alphanumeric chars with dashes.
 */
function sanitizeSessionId(sessionId: string): string {
  const clean = sessionId
    .toLowerCase()
    .replace(/[\s/\\]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return clean || 'unnamed';
}

/**
 * Write (or overwrite) an episode summary for a session.
 * Returns the episode ID (EP-{sanitized-session-id}).
 */
export function writeEpisode(
  memoryDir: string,
  sessionId: string,
  summary: string,
): string {
  const kebab = sanitizeSessionId(sessionId);
  const episodeId = `EP-${kebab}`;
  const episodesDir = path.join(memoryDir, 'EPISODES');
  fs.mkdirSync(episodesDir, { recursive: true });

  const now = normalizeTimestamp();
  const frontmatter = {
    id: episodeId,
    session_id: kebab,
    created_at: now,
  };

  const fm = (yaml.dump(frontmatter, {
    sortKeys: false,
    lineWidth: -1,
    noRefs: true,
    quotingType: '"',
    forceQuotes: false,
  }) as string).trim();

  const content = `---\n${fm}\n---\n\n${summary.trim()}\n`;
  const filePath = path.join(episodesDir, `${episodeId}.md`);
  writeFileAtomic(filePath, content);
  return episodeId;
}

/**
 * Read an episode by ID. Returns null if not found or parse fails.
 */
export function readEpisode(memoryDir: string, episodeId: string): Episode | null {
  const filePath = path.join(memoryDir, 'EPISODES', `${episodeId}.md`);
  if (!fs.existsSync(filePath)) return null;

  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const parsed = matter(content);
    return {
      id: (parsed.data.id as string) ?? episodeId,
      session_id: (parsed.data.session_id as string) ?? '',
      created_at: (parsed.data.created_at as string) ?? '',
      summary: parsed.content.trim(),
      filePath,
    };
  } catch {
    return null;
  }
}

/**
 * List episodes, newest first.
 * Pass { limit: 0 } to get an empty array.
 */
export function listEpisodes(
  memoryDir: string,
  opts: ListEpisodesOptions = {},
): Episode[] {
  if (opts.limit === 0) return [];

  const episodesDir = path.join(memoryDir, 'EPISODES');
  if (!fs.existsSync(episodesDir)) return [];

  const files = fs
    .readdirSync(episodesDir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => path.join(episodesDir, f));

  const episodes: Episode[] = [];
  for (const filePath of files) {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const parsed = matter(content);
      episodes.push({
        id: (parsed.data.id as string) ?? path.basename(filePath, '.md'),
        session_id: (parsed.data.session_id as string) ?? '',
        created_at: (parsed.data.created_at as string) ?? '',
        summary: parsed.content.trim(),
        filePath,
      });
    } catch {
      // Skip malformed episode files
    }
  }

  // Sort newest first by created_at
  episodes.sort((a, b) => b.created_at.localeCompare(a.created_at));

  if (opts.limit != null && opts.limit > 0) {
    return episodes.slice(0, opts.limit);
  }

  return episodes;
}

/**
 * Link an episode to an atom by updating the atom's provenance.episodes list.
 * Does not throw if the atom file doesn't exist or is in an unusual location.
 */
export function linkEpisodeToAtom(
  memoryDir: string,
  atomFilePath: string,
  episodeId: string,
): void {
  void memoryDir; // path guard not needed — write is to the provided filePath
  if (!fs.existsSync(atomFilePath)) return;

  try {
    const content = fs.readFileSync(atomFilePath, 'utf-8');
    const parsed = matter(content);
    const data = parsed.data as Record<string, unknown>;

    // Update provenance.episodes
    if (!data.provenance || typeof data.provenance !== 'object') {
      data.provenance = {};
    }
    const prov = data.provenance as Record<string, unknown>;
    if (!Array.isArray(prov.episodes)) {
      prov.episodes = [];
    }
    if (!(prov.episodes as string[]).includes(episodeId)) {
      (prov.episodes as string[]).push(episodeId);
    }

    // Reconstruct the file content
    const fm = (yaml.dump(data, {
      sortKeys: false,
      lineWidth: -1,
      noRefs: true,
      quotingType: '"',
      forceQuotes: false,
    }) as string).trim();
    const newContent = `---\n${fm}\n---\n\n${parsed.content.trim()}\n`;
    writeFileAtomic(atomFilePath, newContent);
  } catch {
    // Best-effort — do not throw
  }
}
