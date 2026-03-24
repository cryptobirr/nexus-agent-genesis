import { describe, it, expect } from 'vitest'
import { EmbeddingEngine } from './embedding-engine.js'
import type { SuccessfulPattern } from './types.js'

describe('EmbeddingEngine (P-11)', () => {
  describe('embed()', () => {
    it('produces deterministic embeddings for same text', () => {
      const engine = new EmbeddingEngine()
      const text = 'Test plan for user authentication flow'

      const embedding1 = engine.embed(text)
      const embedding2 = engine.embed(text)

      expect(embedding1).toEqual(embedding2)
    })

    it('produces number[] with positive length', () => {
      const engine = new EmbeddingEngine()
      const embedding = engine.embed('Sample text')

      expect(Array.isArray(embedding)).toBe(true)
      expect(embedding.length).toBeGreaterThan(0)
      expect(embedding.every(n => typeof n === 'number')).toBe(true)
    })

    it('produces different embeddings for different text', () => {
      const engine = new EmbeddingEngine()
      const text1 = 'Plan A: search and retrieve'
      const text2 = 'Plan B: synthesize and transform'

      const embedding1 = engine.embed(text1)
      const embedding2 = engine.embed(text2)

      expect(embedding1).not.toEqual(embedding2)
    })

    it('handles empty string', () => {
      const engine = new EmbeddingEngine()
      const embedding = engine.embed('')

      expect(Array.isArray(embedding)).toBe(true)
      expect(embedding.length).toBeGreaterThan(0)
    })
  })

  describe('cosineSimilarity()', () => {
    it('returns exactly 1.0 for identical vectors', () => {
      const engine = new EmbeddingEngine()
      const vec = [1, 2, 3, 4, 5]

      const similarity = engine.cosineSimilarity(vec, vec)

      expect(similarity).toBe(1.0)
    })

    it('returns value in [-1, 1] range', () => {
      const engine = new EmbeddingEngine()
      const vec1 = [1, 2, 3]
      const vec2 = [4, 5, 6]
      const vec3 = [-1, -2, -3]

      expect(engine.cosineSimilarity(vec1, vec2)).toBeGreaterThanOrEqual(-1)
      expect(engine.cosineSimilarity(vec1, vec2)).toBeLessThanOrEqual(1)
      expect(engine.cosineSimilarity(vec1, vec3)).toBeGreaterThanOrEqual(-1)
      expect(engine.cosineSimilarity(vec1, vec3)).toBeLessThanOrEqual(1)
    })

    it('returns 0.0 for orthogonal vectors', () => {
      const engine = new EmbeddingEngine()
      const vec1 = [1, 0, 0]
      const vec2 = [0, 1, 0]

      const similarity = engine.cosineSimilarity(vec1, vec2)

      expect(similarity).toBeCloseTo(0.0, 5)
    })

    it('returns value between 0 and 1 for similar vectors', () => {
      const engine = new EmbeddingEngine()
      const vec1 = [1, 2, 3]
      const vec2 = [1, 2, 2.9]

      const similarity = engine.cosineSimilarity(vec1, vec2)

      expect(similarity).toBeGreaterThan(0)
      expect(similarity).toBeLessThan(1)
    })

    it('handles zero vectors gracefully', () => {
      const engine = new EmbeddingEngine()
      const vec1 = [0, 0, 0]
      const vec2 = [1, 2, 3]

      const similarity = engine.cosineSimilarity(vec1, vec2)

      expect(similarity).toBe(0.0)
    })

    it('returns exactly 1.0 for identical real embeddings', () => {
      const engine = new EmbeddingEngine()
      const text = 'Test plan for similarity'
      const embedding = engine.embed(text)

      const similarity = engine.cosineSimilarity(embedding, embedding)

      expect(similarity).toBe(1.0)
    })
  })

  describe('topK()', () => {
    const createPattern = (
      id: string,
      embedding: number[],
      model_id = 'default-model',
    ): SuccessfulPattern => ({
      pattern_id: id,
      type: 'plan_decomposition',
      objective_cluster: 'test-cluster',
      domain: null,
      strategy: null,
      embedding,
      embedding_model_id: model_id,
      embedding_dimension: embedding.length,
      artifact: 'test artifact',
      created_at: new Date().toISOString(),
      run_id: 'test-run',
    })

    it('returns at most k results', () => {
      const engine = new EmbeddingEngine()
      const query = [1, 0, 0]

      const candidates = [
        createPattern('p1', [1, 0, 0]),
        createPattern('p2', [0.9, 0.1, 0]),
        createPattern('p3', [0.8, 0.2, 0]),
        createPattern('p4', [0.7, 0.3, 0]),
      ]

      const results = engine.topK(query, candidates, 2, 0.5, 'default-model')

      expect(results.length).toBeLessThanOrEqual(2)
    })

    it('returns only results above threshold', () => {
      const engine = new EmbeddingEngine()
      const query = [1, 0, 0]

      const candidates = [
        createPattern('p1', [1, 0, 0]),       // similarity = 1.0
        createPattern('p2', [0, 1, 0]),       // similarity = 0.0
        createPattern('p3', [0.7, 0.3, 0]),   // similarity ~0.92
      ]

      const results = engine.topK(query, candidates, 10, 0.8, 'default-model')

      // Only p1 and p3 should pass threshold of 0.8
      expect(results.length).toBeLessThanOrEqual(2)
      expect(results.every(p => p.pattern_id !== 'p2')).toBe(true)
    })

    it('returns results sorted by similarity descending', () => {
      const engine = new EmbeddingEngine()
      const query = [1, 0, 0]

      const candidates = [
        createPattern('p1', [0.5, 0.5, 0]),
        createPattern('p2', [1, 0, 0]),
        createPattern('p3', [0.9, 0.1, 0]),
      ]

      const results = engine.topK(query, candidates, 10, 0.0, 'default-model')

      // p2 (similarity=1.0) should be first, p3 second, p1 third
      expect(results[0].pattern_id).toBe('p2')
      expect(results[1].pattern_id).toBe('p3')
    })

    it('returns empty array when no candidates above threshold', () => {
      const engine = new EmbeddingEngine()
      const query = [1, 0, 0]

      const candidates = [
        createPattern('p1', [0, 1, 0]),
        createPattern('p2', [0, 0, 1]),
      ]

      const results = engine.topK(query, candidates, 10, 0.9, 'default-model')

      expect(results).toEqual([])
    })

    it('filters out patterns with mismatched embedding_model_id', () => {
      const engine = new EmbeddingEngine()
      const query = [1, 0, 0]

      const candidates = [
        createPattern('p1', [1, 0, 0], 'model-a'),     // mismatch
        createPattern('p2', [0.9, 0.1, 0], 'model-b'), // match
        createPattern('p3', [0.8, 0.2, 0], 'model-c'), // mismatch
      ]

      const results = engine.topK(query, candidates, 10, 0.0, 'model-b')

      // Only p2 should be included (model-b matches)
      expect(results.length).toBe(1)
      expect(results[0].pattern_id).toBe('p2')
    })

    it('returns empty array when all patterns have mismatched model_id', () => {
      const engine = new EmbeddingEngine()
      const query = [1, 0, 0]

      const candidates = [
        createPattern('p1', [1, 0, 0], 'old-model'),
        createPattern('p2', [0.9, 0.1, 0], 'old-model'),
      ]

      const results = engine.topK(query, candidates, 10, 0.0, 'new-model')

      expect(results).toEqual([])
    })

    it('handles empty candidates array', () => {
      const engine = new EmbeddingEngine()
      const query = [1, 0, 0]

      const results = engine.topK(query, [], 10, 0.0, 'model')

      expect(results).toEqual([])
    })
  })
})
