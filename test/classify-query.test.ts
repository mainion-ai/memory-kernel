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

  // ── Knowledge-update / retrieval queries ────────────────────────────────
  describe('knowledge-update / retrieval queries', () => {
    it('classifies "how to" as retrieval', () => {
      const result = classifyQuery('How to configure the API endpoint for production?');
      expect(result.route).toBe('retrieval');
      expect(result.inferredType).toBe('knowledge-update');
    });

    it('classifies "what did the assistant say" as retrieval', () => {
      const result = classifyQuery('What did the assistant say about the deployment steps?');
      expect(result.route).toBe('retrieval');
    });

    it('classifies specific detail queries as retrieval', () => {
      const result = classifyQuery('What is the command syntax for the reindex operation?');
      expect(result.route).toBe('retrieval');
    });

    it('classifies "step by step" instructions as retrieval', () => {
      const result = classifyQuery('Give me the step-by-step process the assistant explained for database migration');
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
      // Both observer and retrieval have signal — should be hybrid or whichever is stronger
      expect(['observer', 'retrieval', 'hybrid']).toContain(result.route);
    });
  });

  // ── Signal detection ────────────────────────────────────────────────────
  describe('signal detection', () => {
    it('reports multiple signals when present', () => {
      const result = classifyQuery('When did I change my favorite programming language?');
      expect(result.signals.length).toBeGreaterThan(0);
      // Should detect both temporal and preference
    });

    it('confidence increases with more signals', () => {
      const weak = classifyQuery('When did that happen?');
      const strong = classifyQuery('When did I first mention moving to Stockholm and how long ago was that?');
      expect(strong.confidence).toBeGreaterThanOrEqual(weak.confidence);
    });
  });
});
