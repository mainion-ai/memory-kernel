/**
 * Shared CLI helper for resolving memory directory with agent isolation support.
 */

import fs from 'fs';
import path from 'path';
import { resolveAgentDir, initAgentStore } from '../isolation.js';

/**
 * Resolve the effective memory directory, applying agent isolation when active.
 * In shared mode (or no agent), returns path.resolve(dir).
 * In isolated mode with agent, returns baseDir/agents/{agentId}/.
 * Auto-initializes agent store if it doesn't exist yet.
 */
export function resolveDir(dir: string, agent?: string): string {
  const baseDir = path.resolve(dir);
  if (!agent) return baseDir;
  const agentDir = resolveAgentDir(baseDir, agent);
  if (agentDir !== baseDir && !fs.existsSync(agentDir)) {
    initAgentStore(baseDir, agent);
  }
  return agentDir;
}
