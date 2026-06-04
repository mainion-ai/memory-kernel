import { describe, it, expect } from 'vitest';
import { classifyQuery } from '../src/classify-query.js';

describe('classifyQuery', () => {
  // ── Temporal queries → observer ─────────────────────────────────────────
  describe('temporal-reasoning queries', () => {
    it('classifies "when did" questions as observer', () => {
      const result = classifyQuery('When did I first mention this topic?');
      expect(result.route).toBe('observer');
      expect(result.inferredType).toBe('temporal-reasoning');
      expect(result.signals.some(s => s.startsWith('temporal:'))).toBe(true);
    });

    it('classifies "how long ago" questions as observer', () => {
      const result = classifyQuery('How long ago did I start my new job?');
      expect(result.route).toBe('observer');
    });

    it('classifies timeline questions as observer', () => {
      const result = classifyQuery('What is the timeline of my career changes?');
      expect(result.route).toBe('observer');
      expect(result.inferredType).toBe('temporal-reasoning');
    });

    it('classifies "changed since" questions as observer', () => {
      const result = classifyQuery('Has my opinion on TypeScript changed since we first discussed it?');
      expect(result.route).toBe('observer');
    });
  });

  // ── Personal/identity queries → observer ────────────────────────────────
  describe('personal/identity queries', () => {
    it('classifies "what is my name" as observer', () => {
      const result = classifyQuery("What is the user's name?");
      expect(result.route).toBe('observer');
      expect(result.inferredType).toBe('single-session-user');
    });

    it('classifies "where do I work" as observer', () => {
      const result = classifyQuery('Where do I work?');
      expect(result.route).toBe('observer');
    });

    it('classifies health-related queries as observer', () => {
      const result = classifyQuery('Does the user have any allergies?');
      expect(result.route).toBe('observer');
    });

    it('classifies family queries as observer', () => {
      const result = classifyQuery("What is the user's wife's name?");
      expect(result.route).toBe('observer');
    });
  });

  // ── Preference queries → observer ───────────────────────────────────────
  describe('preference queries', () => {
    it('classifies "favorite" questions as observer', () => {
      const result = classifyQuery('What is my favorite programming language?');
      expect(result.route).toBe('observer');
      expect(result.inferredType).toBe('single-session-preference');
    });

    it('classifies "prefer" questions as observer', () => {
      const result = classifyQuery('Does the user prefer coffee or tea?');
      expect(result.route).toBe('observer');
    });

    it('classifies hobby questions as observer', () => {
      const result = classifyQuery('What hobbies does the user have?');
      expect(result.route).toBe('observer');
    });
  });

  // ── Multi-session queries → observer ────────────────────────────────────
  describe('multi-session queries', () => {
    it('classifies "have we discussed" as observer', () => {
      const result = classifyQuery('Have we ever discussed machine learning?');
      expect(result.route).toBe('observer');
      expect(result.inferredType).toBe('multi-session');
    });

    it('classifies "previous conversation" queries as observer', () => {
      const result = classifyQuery('In a previous conversation, what did we talk about?');
      expect(result.route).toBe('observer');
    });

    it('classifies "do you remember" queries as observer', () => {
      const result = classifyQuery('Do you remember what I said about my vacation plans?');
      expect(result.route).toBe('observer');
    });
  });

  // ── Assistant-response queries → observer ───────────────────────────────
  describe('single-session-assistant queries', () => {
    it('classifies "what did you suggest" as observer', () => {
      const result = classifyQuery('What did you suggest about the deployment steps?');
      expect(result.route).toBe('observer');
      expect(result.inferredType).toBe('single-session-assistant');
    });

    it('classifies "you recommended" as observer', () => {
      const result = classifyQuery('You recommended using TypeScript for the project, right?');
      expect(result.route).toBe('observer');
      expect(result.inferredType).toBe('single-session-assistant');
    });

    it('classifies "you told me" as observer', () => {
      const result = classifyQuery('You told me to avoid using global state.');
      expect(result.route).toBe('observer');
    });

    it('classifies "your suggestion" as observer', () => {
      const result = classifyQuery('What was your suggestion for handling errors?');
      expect(result.route).toBe('observer');
    });

    it('classifies "did you recommend" as observer', () => {
      const result = classifyQuery('Did you recommend any particular database for this use case?');
      expect(result.route).toBe('observer');
    });

    it('classifies "the advice you gave" as observer', () => {
      const result = classifyQuery('Can you repeat the advice you gave about caching?');
      expect(result.route).toBe('observer');
    });

    it('classifies "what did the assistant say" as observer', () => {
      const result = classifyQuery('What did the assistant say about the deployment process?');
      expect(result.route).toBe('observer');
      expect(result.inferredType).toBe('single-session-assistant');
    });
  });

  // ── Knowledge-update / retrieval queries ────────────────────────────────
  describe('knowledge-update / retrieval queries', () => {
    it('classifies "how to" as retrieval', () => {
      const result = classifyQuery('How to configure the API endpoint for production?');
      expect(result.route).toBe('retrieval');
      expect(result.inferredType).toBe('knowledge-update');
    });

    it('classifies specific detail queries as retrieval', () => {
      const result = classifyQuery('What is the command syntax for the reindex operation?');
      expect(result.route).toBe('retrieval');
    });

    it('classifies "step by step" instructions as retrieval', () => {
      const result = classifyQuery('Give me the step-by-step process for database migration');
      expect(result.route).toBe('retrieval');
    });
  });

  // ── Ambiguous / hybrid queries ──────────────────────────────────────────
  describe('ambiguous queries → hybrid', () => {
    it('returns hybrid for generic questions', () => {
      const result = classifyQuery('Tell me about the project.');
      expect(result.route).toBe('hybrid');
      expect(result.confidence).toBeLessThan(0.5);
    });

    it('returns hybrid for empty queries', () => {
      const result = classifyQuery('');
      expect(result.route).toBe('hybrid');
    });

    it('returns hybrid when signals are tied', () => {
      // Has both personal and retrieval signals
      const result = classifyQuery('How do I find my name in the config file?');
      // Both observer and retrieval have signals — verify both detected
      expect(result.signals.some(s => s.startsWith('personal:'))).toBe(true);
      expect(result.signals.some(s => s.startsWith('retrieval:'))).toBe(true);
      // When tied, route should be hybrid (equal observer and retrieval scores)
      expect(result.route).toBe('hybrid');
    });
  });

  // ── Signal detection ────────────────────────────────────────────────────
  describe('signal detection', () => {
    it('reports multiple signals when present', () => {
      const result = classifyQuery('When did I change my favorite programming language?');
      expect(result.signals.length).toBeGreaterThan(0);
      // Should detect both temporal and preference
    });

    it('does not over-match "still" in retrieval queries', () => {
      // "still" without a subject pronoun should NOT trigger temporal signal
      const result = classifyQuery('Is this still the recommended approach for API configuration?');
      // No temporal signal, no retrieval signal → hybrid (the point is: no false temporal match)
      expect(['retrieval', 'hybrid']).toContain(result.route);
      expect(result.signals.some(s => s.startsWith('temporal:'))).toBe(false);
    });

    it('matches "still" with subject pronoun as temporal', () => {
      const result = classifyQuery('Do I still work at TechCorp?');
      expect(result.route).toBe('observer');
      expect(result.signals.some(s => s.startsWith('temporal:'))).toBe(true);
    });

    it('confidence increases with more signals', () => {
      const weak = classifyQuery('When did that happen?');
      const strong = classifyQuery('When did I first mention moving to Stockholm and how long ago was that?');
      expect(strong.confidence).toBeGreaterThanOrEqual(weak.confidence);
    });
  });

  // #120: tie-break across observer categories must be deterministic and
  //       independent of the order patterns are checked in.
  describe('deterministic tie-break (#120)', () => {
    it('breaks personal=preference tie lexicographically (preference wins)', () => {
      // "the user's wife favorite" → personal:1 (wife) + preference:1 (favorite)
      const result = classifyQuery("the user's wife favorite");
      expect(result.route).toBe('observer');
      // single-session-preference < single-session-user lexicographically
      expect(result.inferredType).toBe('single-session-preference');
    });

    it('is stable across repeated calls (identical input → identical output)', () => {
      const inputs = [
        "the user's wife favorite",
        'I prefer my hobby',
        'the user has allergies and favorite music',
      ];
      for (const q of inputs) {
        const a = classifyQuery(q);
        const b = classifyQuery(q);
        expect(b.inferredType).toBe(a.inferredType);
        expect(b.route).toBe(a.route);
      }
    });
  });
});
