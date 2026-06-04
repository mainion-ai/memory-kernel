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
  /\b(?:do|does|did|am|is|are|was|were)\s+(?:I|you|we|he|she|they|the\s+user)\s+still\b/i,
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
  /\b(?:education|(?:went|go)\s+to\s+(?:school|university|college))\b/i,
  /\b(?:married|engaged|relationship)\b/i,
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
 * Assistant-response signal patterns — queries about what the assistant
 * said, suggested, recommended, or explained in conversation.
 * Maps to: single-session-assistant type → observer route.
 */
const ASSISTANT_PATTERNS: RegExp[] = [
  /\bwhat\s+did\s+(?:you|the\s+assistant)\s+(?:say|suggest|recommend|advise|explain)\b/i,
  /\b(?:the\s+assistant|you)\s+(?:said|mentioned|explained|suggested|recommended|told\s+me|advised)\b/i,
  /\byou\s+told\s+me\b/i,
  /\byou\s+(?:said|mentioned)\s+(?:that|to|I\s+should)\b/i,
  /\byour\s+(?:suggestion|recommendation|advice)\b/i,
  /\bwhat\s+(?:you|the\s+assistant)\s+(?:suggested|recommended)\b/i,
  /\bdid\s+you\s+(?:suggest|recommend|advise|mention)\b/i,
  /\bthe\s+advice\s+you\s+gave\b/i,
  /\b(?:in\s+(?:our|the)\s+conversation)\s*,?\s*you\b/i,
];

/**
 * Knowledge-update signal patterns — queries about specific technical
 * details, how-to information, or factual content.
 * Maps to: knowledge-update type → retrieval route.
 */
const RETRIEVAL_PATTERNS: RegExp[] = [
  /\bhow\s+(?:to|do\s+(?:I|you))\b/i,
  /\bwhat\s+(?:is|are)\s+(?:the\s+)?(?:command|syntax|api|endpoint|url|port|password|config)\b/i,
  /\bcode\s+(?:for|to|that)\b/i,
  /\bstep(?:s|\-by\-step)\b/i,
  /\bexplain\s+(?:how|what|the)\b/i,
  /\bspecific\s+(?:detail|instruction|recommendation)\b/i,
  /\bexact\s+(?:words|quote|response)\b/i,
  /\baccording\s+to\b/i,
];

// ── Classifier ──────────────────────────────────────────────────────────────

/**
 * Hard upper bound on the query length the classifier will inspect. Queries
 * longer than this are truncated to the first MAX_QUERY_LENGTH characters
 * before any regex work. Real-world queries are well under 1000 chars; the
 * 10,000 ceiling exists purely as a defensive bound so a giant input can't
 * push the pattern loop into unbounded work, regardless of which patterns
 * are added later.
 */
const MAX_QUERY_LENGTH = 10_000;

function countMatches(query: string, patterns: RegExp[]): number {
  // Two-layer ReDoS defense:
  // 1. Cap input length BEFORE any regex work. Bounds total cost at O(N)
  //    regardless of pattern shape — also satisfies CodeQL's static
  //    polynomial-redos check (which can't dataflow-trace through the
  //    normalize step alone).
  // 2. Collapse runs of whitespace to a single space. Several patterns
  //    contain multiple \s+ (some inside alternations like `the\s+user`)
  //    that would backtrack polynomially on whitespace-heavy input. After
  //    normalization each \s+ matches exactly one character — no ambiguity.
  const bounded = query.length > MAX_QUERY_LENGTH ? query.slice(0, MAX_QUERY_LENGTH) : query;
  const normalized = bounded.replace(/\s+/g, ' ');
  let count = 0;
  for (const p of patterns) {
    if (p.test(normalized)) count++;
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
  const assistantScore = countMatches(query, ASSISTANT_PATTERNS);
  const retrievalScore = countMatches(query, RETRIEVAL_PATTERNS);

  if (temporalScore > 0) signals.push(`temporal:${temporalScore}`);
  if (personalScore > 0) signals.push(`personal:${personalScore}`);
  if (preferenceScore > 0) signals.push(`preference:${preferenceScore}`);
  if (multiSessionScore > 0) signals.push(`multi-session:${multiSessionScore}`);
  if (assistantScore > 0) signals.push(`assistant:${assistantScore}`);
  if (retrievalScore > 0) signals.push(`retrieval:${retrievalScore}`);

  const observerScore = temporalScore + personalScore + preferenceScore + multiSessionScore + assistantScore;

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

    // #120: tie-break across observer categories must be deterministic.
    //       Previously this was an if/else cascade in declaration order
    //       (temporal > personal > assistant > preference > multi-session),
    //       which made ties depend on positional accident. Now we collect
    //       (score, inferredType) tuples and pick the one with the highest
    //       score, breaking ties by lexicographic order on inferredType.
    const observerCandidates: Array<{ score: number; type: string }> = [
      { score: temporalScore, type: 'temporal-reasoning' },
      { score: personalScore, type: 'single-session-user' },
      { score: assistantScore, type: 'single-session-assistant' },
      { score: preferenceScore, type: 'single-session-preference' },
      { score: multiSessionScore, type: 'multi-session' },
    ];
    observerCandidates.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score; // higher score wins
      return a.type.localeCompare(b.type); // lex tie-break
    });
    inferredType = observerCandidates[0].type;

    confidence = Math.min(0.9, 0.5 + observerScore * 0.1);
  } else {
    // Tied or weak signals — hybrid
    route = 'hybrid';
    confidence = 0.4;
    inferredType = undefined;
  }

  return { route, confidence, signals, inferredType };
}
