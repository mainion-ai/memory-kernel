/**
 * classify-query — lightweight query classifier for recall routing.
 *
 * Classifies incoming queries into retrieval strategies WITHOUT an LLM call.
 * Uses keyword patterns and structural heuristics to determine whether a query
 * is best answered by:
 *   - "observer"   → observations.md (personal facts, preferences, temporal, multi-session)
 *   - "retrieval"  → mk recall against atoms (knowledge-update, assistant-level detail)
 *   - "hybrid"     → both sources combined (default fallback)
 *
 * Based on LongMemEval R15b per-type performance analysis:
 *   observer-dominant: single-session-user (94%), single-session-assistant (66%),
 *                      multi-session (52%), single-session-preference (50%),
 *                      temporal-reasoning (46%)
 *   retrieval-dominant: knowledge-update (72%)
 *
 * In production there are no ground-truth question types — this classifier
 * infers the likely type from the query text itself.
 */

// ── Types ───────────────────────────────────────────────────────────────────

export type QueryRoute = 'observer' | 'retrieval' | 'hybrid';

export interface ClassifyResult {
  /** Recommended retrieval route. */
  route: QueryRoute;
  /** Confidence in the classification (0.0–1.0). */
  confidence: number;
  /** Detected signals that influenced the classification. */
  signals: string[];
  /** Inferred question category (informational, not used for routing). */
  inferredType?: string;
}

// ── Pattern Definitions ─────────────────────────────────────────────────────

/**
 * Temporal signal patterns — queries about WHEN things happened,
 * temporal ordering, or state changes over time.
 * Maps to: temporal-reasoning type → observer route.
 */
const TEMPORAL_PATTERNS: RegExp[] = [
  /\bwhen\s+did\b/i,
  /\bhow\s+long\s+(?:ago|since|has)\b/i,
  /\bbefore\s+or\s+after\b/i,
  /\bfirst\s+(?:time|mention)\b/i,
  /\blast\s+(?:time|mention)\b/i,
  /\bwhat\s+(?:month|year|date|day)\b/i,
  /\bchronolog/i,
  /\btimeline\b/i,
  /\bsequence\s+of\b/i,
  /\bhistory\s+of\b/i,
  /\bover\s+time\b/i,
  /\brecently\b/i,
  /\bearlier\s+(?:this|last)\b/i,
  /\bchanged?\s+(?:from|since|over)\b/i,
  /\bused\s+to\b/i,
  /\bstill\b.*\?/i,
];

/**
 * Personal/identity signal patterns — queries about the user's
 * personal facts, identity, relationships, or life details.
 * Maps to: single-session-user type → observer route.
 */
const PERSONAL_PATTERNS: RegExp[] = [
  /\b(?:my|the\s+user(?:'s)?)\s+(?:name|job|work|company|family|wife|husband|partner|child|kid|pet|dog|cat)\b/i,
  /\bwhere\s+(?:do\s+I|does\s+(?:the\s+user|he|she))\s+(?:live|work|study)\b/i,
  /\bwhat\s+(?:do\s+I|does\s+(?:the\s+user|he|she))\s+do\b/i,
  /\bwho\s+(?:is|am)\b/i,
  /\bhow\s+old\b/i,
  /\b(?:user|my)\s+(?:age|birthday|birth\s*date)\b/i,
  /\b(?:allergic|allergy|allergies|health\s+condition)\b/i,
  /\beducation|(?:went|go)\s+to\s+(?:school|university|college)\b/i,
  /\bmarried|engaged|relationship\b/i,
];

/**
 * Preference signal patterns — queries about what the user likes,
 * prefers, or habitually chooses.
 * Maps to: single-session-preference type → observer route.
 */
const PREFERENCE_PATTERNS: RegExp[] = [
  /\b(?:favorite|favourite|preferred|prefer)\b/i,
  /\bwhat\s+(?:do\s+I|does\s+(?:the\s+user|he|she))\s+(?:like|enjoy|prefer|love)\b/i,
  /\b(?:like|enjoy|prefer|love)\s+(?:to\s+)?(?:eat|drink|watch|read|listen|play|use|cook|travel)\b/i,
  /\bgo-to\b/i,
  /\busually\s+(?:eat|drink|order|choose|pick|use)\b/i,
  /\b(?:hobby|hobbies|interest|interests)\b/i,
  /\bmusic\s+taste\b/i,
  /\bfood\s+(?:preference|choice)\b/i,
];

/**
 * Multi-session signal patterns — queries requiring synthesis
 * across multiple conversations.
 * Maps to: multi-session type → observer route.
 */
const MULTI_SESSION_PATTERNS: RegExp[] = [
  /\bhave\s+(?:I|we)\s+(?:ever|before)\s+(?:discussed|talked|mentioned)\b/i,
  /\bprevious\s+(?:conversation|session|chat|discussion)\b/i,
  /\blast\s+(?:conversation|session|chat|time\s+we\s+(?:talked|chatted|spoke))\b/i,
  /\bdo\s+you\s+remember\b/i,
  /\bwe\s+(?:talked|discussed|mentioned)\s+(?:about|before)\b/i,
  /\bacross\s+(?:our\s+)?conversations\b/i,
  /\bin\s+(?:a\s+)?(?:previous|earlier|past)\b/i,
];

/**
 * Knowledge-update signal patterns — queries about specific technical
 * details, how-to information, or assistant-provided content.
 * Maps to: knowledge-update type → retrieval route.
 */
const RETRIEVAL_PATTERNS: RegExp[] = [
  /\bhow\s+(?:to|do\s+(?:I|you))\b/i,
  /\bwhat\s+(?:is|are)\s+(?:the\s+)?(?:command|syntax|api|endpoint|url|port|password|config)\b/i,
  /\bcode\s+(?:for|to|that)\b/i,
  /\bstep(?:s|\-by\-step)\b/i,
  /\bexplain\s+(?:how|what|the)\b/i,
  /\bwhat\s+(?:did\s+(?:you|the\s+assistant))\s+(?:say|suggest|recommend|explain)\b/i,
  /\bthe\s+(?:assistant|you)\s+(?:said|mentioned|explained|suggested|recommended)\b/i,
  /\bspecific\s+(?:detail|instruction|recommendation)\b/i,
  /\bexact\s+(?:words|quote|response)\b/i,
  /\baccording\s+to\b/i,
];

// ── Classifier ──────────────────────────────────────────────────────────────

function countMatches(query: string, patterns: RegExp[]): number {
  let count = 0;
  for (const p of patterns) {
    if (p.test(query)) count++;
  }
  return count;
}

/**
 * Classify a query into a retrieval route.
 *
 * Uses keyword pattern matching to infer the likely question type
 * and recommend the best retrieval strategy. No LLM call required.
 */
export function classifyQuery(query: string): ClassifyResult {
  const signals: string[] = [];

  const temporalScore = countMatches(query, TEMPORAL_PATTERNS);
  const personalScore = countMatches(query, PERSONAL_PATTERNS);
  const preferenceScore = countMatches(query, PREFERENCE_PATTERNS);
  const multiSessionScore = countMatches(query, MULTI_SESSION_PATTERNS);
  const retrievalScore = countMatches(query, RETRIEVAL_PATTERNS);

  if (temporalScore > 0) signals.push(`temporal:${temporalScore}`);
  if (personalScore > 0) signals.push(`personal:${personalScore}`);
  if (preferenceScore > 0) signals.push(`preference:${preferenceScore}`);
  if (multiSessionScore > 0) signals.push(`multi-session:${multiSessionScore}`);
  if (retrievalScore > 0) signals.push(`retrieval:${retrievalScore}`);

  const observerScore = temporalScore + personalScore + preferenceScore + multiSessionScore;

  // Determine route and inferred type
  let route: QueryRoute;
  let confidence: number;
  let inferredType: string | undefined;

  if (observerScore === 0 && retrievalScore === 0) {
    // No strong signal — default to hybrid
    route = 'hybrid';
    confidence = 0.3;
    inferredType = undefined;
  } else if (retrievalScore > observerScore) {
    // Retrieval-dominant signal
    route = 'retrieval';
    confidence = Math.min(0.9, 0.4 + retrievalScore * 0.15);
    inferredType = 'knowledge-update';
  } else if (observerScore > retrievalScore) {
    // Observer-dominant
    route = 'observer';

    // Determine specific inferred type
    const maxObserverCategory = Math.max(temporalScore, personalScore, preferenceScore, multiSessionScore);
    if (temporalScore === maxObserverCategory) inferredType = 'temporal-reasoning';
    else if (personalScore === maxObserverCategory) inferredType = 'single-session-user';
    else if (preferenceScore === maxObserverCategory) inferredType = 'single-session-preference';
    else if (multiSessionScore === maxObserverCategory) inferredType = 'multi-session';

    confidence = Math.min(0.9, 0.5 + observerScore * 0.1);
  } else {
    // Tied or weak signals — hybrid
    route = 'hybrid';
    confidence = 0.4;
    inferredType = undefined;
  }

  return { route, confidence, signals, inferredType };
}
