/**
 * Embedding provider abstraction for semantic search.
 *
 * Supports multiple providers:
 * - voyage: Voyage AI voyage-3-lite (free, default)
 * - openai: OpenAI text-embedding-3-small ($0.02/MTok)
 * - none: Disabled (tag-based recall only)
 *
 * Configuration via environment variables:
 *   EMBEDDING_PROVIDER=voyage|openai|none  (default: none)
 *   EMBEDDING_API_KEY=...                  (required for voyage/openai)
 *   EMBEDDING_MODEL=...                    (optional override)
 *
 * Vectors are stored in the SQLite index alongside other atom metadata.
 * Dimensions: voyage-3-lite=512, text-embedding-3-small=1536.
 */

import https from 'https';
import http from 'http';

// --- Types ---

export type EmbeddingProvider = 'voyage' | 'openai' | 'none';

export interface EmbeddingConfig {
  provider: EmbeddingProvider;
  apiKey: string;
  model: string;
  dimensions: number;
}

export interface EmbedResult {
  vector: number[];
  model: string;
  tokens_used: number;
}

// --- Provider defaults ---

const PROVIDER_DEFAULTS: Record<Exclude<EmbeddingProvider, 'none'>, { model: string; dimensions: number; endpoint: string }> = {
  voyage: {
    model: 'voyage-3-lite',
    dimensions: 512,
    endpoint: 'https://api.voyageai.com/v1/embeddings',
  },
  openai: {
    model: 'text-embedding-3-small',
    dimensions: 1536,
    endpoint: 'https://api.openai.com/v1/embeddings',
  },
};

// --- Configuration ---

/**
 * Resolve embedding configuration from environment variables.
 * Returns null if provider is 'none' or not configured.
 */
export function getEmbeddingConfig(): EmbeddingConfig | null {
  const provider = (process.env.EMBEDDING_PROVIDER || 'none') as EmbeddingProvider;

  if (provider === 'none') return null;

  const defaults = PROVIDER_DEFAULTS[provider];
  if (!defaults) return null;

  const apiKey = process.env.EMBEDDING_API_KEY || '';
  if (!apiKey) {
    // Silently degrade — no key means no embeddings
    return null;
  }

  const dimensionsOverride = parseInt(process.env.EMBEDDING_DIMENSIONS || '', 10);
  return {
    provider,
    apiKey,
    model: process.env.EMBEDDING_MODEL || defaults.model,
    dimensions: Number.isFinite(dimensionsOverride) && dimensionsOverride > 0
      ? dimensionsOverride
      : defaults.dimensions,
  };
}

// --- Embedding API ---

/**
 * Embed a single text string. Returns the vector and metadata.
 * Throws on API errors (caller should catch and degrade gracefully).
 */
export async function embedText(text: string, config: EmbeddingConfig): Promise<EmbedResult> {
  const results = await embedBatch([text], config);
  return results[0];
}

/**
 * Embed multiple texts in a single API call (batch).
 * More efficient than calling embedText() in a loop.
 */
export async function embedBatch(texts: string[], config: EmbeddingConfig): Promise<EmbedResult[]> {
  if (texts.length === 0) return [];

  if (config.provider === 'none') throw new Error('Cannot embed with provider "none"');
  const defaults = PROVIDER_DEFAULTS[config.provider];

  const body = buildRequestBody(texts, config);
  const response = await httpPost(defaults.endpoint, body, {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${config.apiKey}`,
  });

  return parseResponse(response, config, texts.length);
}

// --- Request/Response ---

interface EmbeddingApiResponse {
  data: Array<{
    embedding: number[];
    index: number;
  }>;
  usage?: {
    total_tokens?: number;
    prompt_tokens?: number;
  };
  model: string;
}

function buildRequestBody(texts: string[], config: EmbeddingConfig): string {
  if (config.provider === 'voyage') {
    return JSON.stringify({
      input: texts,
      model: config.model,
      input_type: 'document',
    });
  }

  // OpenAI format
  return JSON.stringify({
    input: texts,
    model: config.model,
  });
}

function parseResponse(raw: string, config: EmbeddingConfig, inputCount: number): EmbedResult[] {
  const response: EmbeddingApiResponse = JSON.parse(raw);

  if (!response.data || !Array.isArray(response.data)) {
    throw new Error(`Invalid embedding response: missing data array`);
  }

  // Sort by index to maintain input order
  const sorted = [...response.data].sort((a, b) => a.index - b.index);
  const totalTokens = response.usage?.total_tokens ?? response.usage?.prompt_tokens ?? 0;
  const tokensPerItem = inputCount > 0 ? Math.ceil(totalTokens / inputCount) : 0;

  return sorted.map((item) => ({
    vector: item.embedding,
    model: response.model || config.model,
    tokens_used: tokensPerItem,
  }));
}

// --- HTTP helper ---

const HTTP_TIMEOUT_MS = 30_000; // 30s timeout for embedding API calls

function httpPost(url: string, body: string, headers: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const lib = parsedUrl.protocol === 'https:' ? https : http;

    const req = lib.request(
      {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
        path: parsedUrl.pathname,
        method: 'POST',
        headers: {
          ...headers,
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: HTTP_TIMEOUT_MS,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const responseBody = Buffer.concat(chunks).toString('utf-8');
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolve(responseBody);
          } else {
            reject(new Error(`Embedding API error ${res.statusCode}: ${responseBody.slice(0, 500)}`));
          }
        });
      },
    );

    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Embedding API timeout after ${HTTP_TIMEOUT_MS}ms: ${url}`));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// --- Vector math (for KNN in SQLite) ---

/**
 * Cosine similarity between two vectors.
 * Returns a value between -1 and 1 (1 = identical, 0 = orthogonal, -1 = opposite).
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 0;
  return dot / denom;
}

/**
 * Serialize a vector to a compact binary buffer for SQLite BLOB storage.
 * Uses Float32Array (4 bytes per dimension) — 512-dim = 2KB, 1536-dim = 6KB.
 */
export function serializeVector(vector: number[]): Buffer {
  const float32 = new Float32Array(vector);
  return Buffer.from(float32.buffer);
}

/**
 * Deserialize a vector from a SQLite BLOB buffer.
 */
export function deserializeVector(buf: Buffer): number[] {
  const float32 = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  return Array.from(float32);
}

/**
 * Prepare atom text for embedding — combine frontmatter metadata with body content.
 * Keeps it concise to minimize token usage.
 */
export function atomToEmbeddingText(body: string, tags?: string[], type?: string): string {
  const parts: string[] = [];
  if (type) parts.push(`[${type}]`);
  if (tags && tags.length > 0) parts.push(`tags: ${tags.join(', ')}`);
  parts.push(body.trim());
  return parts.join('\n');
}
