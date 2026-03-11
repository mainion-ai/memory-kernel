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
import { writeFileAtomic, assertWithinDir } from './store.js';
import { normalizeTimestamp } from './format.js';
import { appendEvent } from './event-log.js';
import type { Episode } from './types.js';

export type { Episode } from './types.js';

export interface WriteEpisodeOpts {
  tags?: string[];
  started_at?: string; // ISO8601 UTC — defaults to write time
  ended_at?: string;   // ISO8601 UTC — optional
  agent_id?: string;   // Convenience: also accepted here (operationOpts.agent_id takes precedence)
}

export interface WriteOperationOpts {
  agent_id?: string;
}

export interface ListEpisodesOptions {
  limit?: number; // Max episodes to return (0 = empty array)
  tags?: string[]; // Filter: only episodes with at least one matching tag
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
 * Emits a session_ended event to the event log.
 */
export function writeEpisode(
  memoryDir: string,
  sessionId: string,
  summary: string,
  opts: WriteEpisodeOpts = {},
  operationOpts: WriteOperationOpts = {},
): string {
  const kebab = sanitizeSessionId(sessionId);
  const episodeId = `EP-${kebab}`;
  const episodesDir = path.join(memoryDir, 'EPISODES');
  fs.mkdirSync(episodesDir, { recursive: true });

  const filePath = path.join(episodesDir, `${episodeId}.md`);

  // Preserve created_at from an existing episode — only set fresh on first write.
  let createdAt = normalizeTimestamp();
  if (fs.existsSync(filePath)) {
    try {
      const existing = matter(fs.readFileSync(filePath, 'utf-8'));
      if (existing.data.created_at) createdAt = existing.data.created_at as string;
    } catch { /* ignore — fall back to current timestamp */ }
  }

  const startedAt = opts.started_at ?? normalizeTimestamp();

  const frontmatter: Record<string, unknown> = {
    id: episodeId,
    session_id: kebab,
    created_at: createdAt,
    started_at: startedAt,
  };

  const agentId = operationOpts.agent_id ?? opts.agent_id;
  if (opts.ended_at) frontmatter.ended_at = opts.ended_at;
  if (agentId) frontmatter.agent_id = agentId;
  if (opts.tags && opts.tags.length > 0) frontmatter.tags = opts.tags;

  const fm = (yaml.dump(frontmatter, {
    sortKeys: false,
    lineWidth: -1,
    noRefs: true,
    quotingType: '"',
    forceQuotes: false,
  }) as string).trim();

  const content = `---\n${fm}\n---\n\n${summary.trim()}\n`;
  writeFileAtomic(filePath, content);

  // Emit a session_ended event so the episode is traceable in the event log.
  appendEvent(memoryDir, 'session_ended', {
    agent_id: agentId ?? 'episodestore',
    session_id: kebab,
    meta: { episode_id: episodeId },
  });

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
    const d = parsed.data as Record<string, unknown>;
    return {
      id: (d.id as string) ?? episodeId,
      metadata: {
        session_id: (d.session_id as string) ?? '',
        agent_id: d.agent_id as string | undefined,
        tags: d.tags as string[] | undefined,
        started_at: (d.started_at as string) || (d.created_at as string) || '',
        ended_at: d.ended_at as string | undefined,
      },
      summary: parsed.content.trim(),
      filePath,
    };
  } catch {
    return null;
  }
}

/**
 * List episodes, newest first (by started_at).
 * Pass { limit: 0 } to get an empty array.
 * Pass { tags: [...] } to filter to episodes with at least one matching tag.
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
      const d = parsed.data as Record<string, unknown>;
      episodes.push({
        id: (d.id as string) ?? path.basename(filePath, '.md'),
        metadata: {
          session_id: (d.session_id as string) ?? '',
          agent_id: d.agent_id as string | undefined,
          tags: d.tags as string[] | undefined,
          started_at: (d.started_at as string) || (d.created_at as string) || '',
          ended_at: d.ended_at as string | undefined,
        },
        summary: parsed.content.trim(),
        filePath,
      });
    } catch {
      // Skip malformed episode files
    }
  }

  // Filter by tags if specified (any-match semantics)
  const filtered = opts.tags?.length
    ? episodes.filter((ep) => ep.metadata.tags?.some((t) => opts.tags!.includes(t)))
    : episodes;

  // Sort newest first by started_at
  filtered.sort((a, b) => b.metadata.started_at.localeCompare(a.metadata.started_at));

  return opts.limit !== undefined ? filtered.slice(0, opts.limit) : filtered;
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
  assertWithinDir(memoryDir, atomFilePath);
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
