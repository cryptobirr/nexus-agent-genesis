import { describe, it, expect, beforeEach } from 'vitest'
import { PlanCache } from './plan-cache.js'
import { EmbeddingEngine } from './embedding-engine.js'
import type { PlanCacheEntry, RequirementMap } from './types.js'

describe('PlanCache', () => {
  let cache: PlanCache
  let embeddingEngine: EmbeddingEngine
  const DEFAULT_THRESHOLD = 0.90

  beforeEach(() => {
    embeddingEngine = new EmbeddingEngine(384)
    cache = new PlanCache(embeddingEngine, DEFAULT_THRESHOLD)
  })

  describe('Basic cache operations', () => {
    it('returns null on empty cache', () => {
      const embedding = embeddingEngine.embed('test objective')
      const result = cache.lookup(embedding, 'config-hash-1')
      expect(result).toBeNull()
    })

    it('stores and retrieves exact match', () => {
      const objectiveText = 'Implement user authentication'
      const embedding = embeddingEngine.embed(objectiveText)
      const configHash = 'config-hash-1'
      const requirementMap: RequirementMap = new Map()

      cache.write(
        'run-123',
        objectiveText,
        embedding,
        'model-v1',
        { plan: 'test plan' },
        { nodes: [] },
        requirementMap,
        configHash,
      )

      const result = cache.lookup(embedding, configHash)
      expect(result).not.toBeNull()
      expect(result?.run_id).toBe('run-123')
      expect(result?.objective_text).toBe(objectiveText)
      expect(result?.run_config_hash).toBe(configHash)
      expect(result?.router_output).toEqual({ plan: 'test plan' })
      expect(result?.similarity_score).toBe(1.0)
    })
  })

  describe('Similarity threshold tests', () => {
    it('returns hit when similarity >= threshold and config matches', () => {
      const objective1 = 'Implement user authentication system'
      const objective2 = 'Implement user authentication'  // Very similar
      const embedding1 = embeddingEngine.embed(objective1)
      const embedding2 = embeddingEngine.embed(objective2)
      const configHash = 'config-hash-1'
      const requirementMap: RequirementMap = new Map()

      cache.write(
        'run-123',
        objective1,
        embedding1,
        'model-v1',
        { plan: 'auth plan' },
        { nodes: [] },
        requirementMap,
        configHash,
      )

      const result = cache.lookup(embedding2, configHash)
      const similarity = embeddingEngine.cosineSimilarity(embedding1, embedding2)

      // Verify similarity is actually high enough
      expect(similarity).toBeGreaterThanOrEqual(DEFAULT_THRESHOLD)
      expect(result).not.toBeNull()
      expect(result?.similarity_score).toBeGreaterThanOrEqual(DEFAULT_THRESHOLD)
    })

    it('returns null when similarity < threshold even if config matches', () => {
      const objective1 = 'Implement user authentication'
      const objective2 = 'Create a payment processing system'  // Very different
      const embedding1 = embeddingEngine.embed(objective1)
      const embedding2 = embeddingEngine.embed(objective2)
      const configHash = 'config-hash-1'
      const requirementMap: RequirementMap = new Map()

      cache.write(
        'run-123',
        objective1,
        embedding1,
        'model-v1',
        { plan: 'auth plan' },
        { nodes: [] },
        requirementMap,
        configHash,
      )

      const result = cache.lookup(embedding2, configHash)
      const similarity = embeddingEngine.cosineSimilarity(embedding1, embedding2)

      // Verify similarity is actually below threshold
      expect(similarity).toBeLessThan(DEFAULT_THRESHOLD)
      expect(result).toBeNull()
    })

    it('returns best match when multiple candidates above threshold', () => {
      const configHash = 'config-hash-1'
      const requirementMap: RequirementMap = new Map()

      // Cache two similar objectives
      const obj1 = 'Implement authentication'
      const obj2 = 'Implement authentication system with JWT'
      const queryObj = 'Implement authentication system'

      const emb1 = embeddingEngine.embed(obj1)
      const emb2 = embeddingEngine.embed(obj2)
      const queryEmbedding = embeddingEngine.embed(queryObj)

      cache.write(
        'run-1',
        obj1,
        emb1,
        'model-v1',
        { plan: 'plan-1' },
        { nodes: [] },
        requirementMap,
        configHash,
      )

      cache.write(
        'run-2',
        obj2,
        emb2,
        'model-v1',
        { plan: 'plan-2' },
        { nodes: [] },
        requirementMap,
        configHash,
      )

      const result = cache.lookup(queryEmbedding, configHash)

      // Should return whichever has higher similarity
      const sim1 = embeddingEngine.cosineSimilarity(queryEmbedding, emb1)
      const sim2 = embeddingEngine.cosineSimilarity(queryEmbedding, emb2)
      const expectedRunId = sim1 > sim2 ? 'run-1' : 'run-2'

      expect(result).not.toBeNull()
      expect(result?.run_id).toBe(expectedRunId)
      expect(result?.similarity_score).toBe(Math.max(sim1, sim2))
    })
  })

  describe('Config hash filtering', () => {
    it('returns null when config hash differs even if similarity = 1.0', () => {
      const objectiveText = 'Implement user authentication'
      const embedding = embeddingEngine.embed(objectiveText)
      const requirementMap: RequirementMap = new Map()

      cache.write(
        'run-123',
        objectiveText,
        embedding,
        'model-v1',
        { plan: 'auth plan' },
        { nodes: [] },
        requirementMap,
        'config-hash-1',
      )

      // Lookup with different config hash
      const result = cache.lookup(embedding, 'config-hash-2')
      expect(result).toBeNull()
    })

    it('only searches entries matching config hash', () => {
      const objectiveText = 'Implement authentication'
      const embedding = embeddingEngine.embed(objectiveText)
      const requirementMap: RequirementMap = new Map()

      // Store with config-hash-1
      cache.write(
        'run-1',
        objectiveText,
        embedding,
        'model-v1',
        { plan: 'plan-1' },
        { nodes: [] },
        requirementMap,
        'config-hash-1',
      )

      // Store with config-hash-2
      cache.write(
        'run-2',
        objectiveText,
        embedding,
        'model-v1',
        { plan: 'plan-2' },
        { nodes: [] },
        requirementMap,
        'config-hash-2',
      )

      // Lookup with config-hash-2 should only find run-2
      const result = cache.lookup(embedding, 'config-hash-2')
      expect(result).not.toBeNull()
      expect(result?.run_id).toBe('run-2')
    })
  })

  describe('Embedding model mismatch', () => {
    it('returns null when embedding_model_id differs', () => {
      const objectiveText = 'Implement user authentication'
      const embedding = embeddingEngine.embed(objectiveText)
      const configHash = 'config-hash-1'
      const requirementMap: RequirementMap = new Map()

      // Store with model-v1
      cache.write(
        'run-123',
        objectiveText,
        embedding,
        'model-v1',
        { plan: 'auth plan' },
        { nodes: [] },
        requirementMap,
        configHash,
      )

      // Lookup with different embedding_model_id
      const result = cache.lookup(embedding, configHash, 'model-v2')
      expect(result).toBeNull()
    })

    it('returns hit when embedding_model_id matches', () => {
      const objectiveText = 'Implement user authentication'
      const embedding = embeddingEngine.embed(objectiveText)
      const configHash = 'config-hash-1'
      const requirementMap: RequirementMap = new Map()

      cache.write(
        'run-123',
        objectiveText,
        embedding,
        'model-v1',
        { plan: 'auth plan' },
        { nodes: [] },
        requirementMap,
        configHash,
      )

      const result = cache.lookup(embedding, configHash, 'model-v1')
      expect(result).not.toBeNull()
      expect(result?.embedding_model_id).toBe('model-v1')
    })
  })

  describe('Invalidation', () => {
    it('removes all entries with matching config hash', () => {
      const requirementMap: RequirementMap = new Map()
      const configHash = 'config-hash-1'

      // Store multiple entries with same config hash
      cache.write(
        'run-1',
        'Objective 1',
        embeddingEngine.embed('Objective 1'),
        'model-v1',
        { plan: 'plan-1' },
        { nodes: [] },
        requirementMap,
        configHash,
      )

      cache.write(
        'run-2',
        'Objective 2',
        embeddingEngine.embed('Objective 2'),
        'model-v1',
        { plan: 'plan-2' },
        { nodes: [] },
        requirementMap,
        configHash,
      )

      // Invalidate
      cache.invalidate(configHash)

      // Both should be gone
      const result1 = cache.lookup(embeddingEngine.embed('Objective 1'), configHash)
      const result2 = cache.lookup(embeddingEngine.embed('Objective 2'), configHash)

      expect(result1).toBeNull()
      expect(result2).toBeNull()
    })

    it('preserves entries with different config hashes', () => {
      const requirementMap: RequirementMap = new Map()
      const objectiveText = 'Implement authentication'
      const embedding = embeddingEngine.embed(objectiveText)

      cache.write(
        'run-1',
        objectiveText,
        embedding,
        'model-v1',
        { plan: 'plan-1' },
        { nodes: [] },
        requirementMap,
        'config-hash-1',
      )

      cache.write(
        'run-2',
        objectiveText,
        embedding,
        'model-v1',
        { plan: 'plan-2' },
        { nodes: [] },
        requirementMap,
        'config-hash-2',
      )

      // Invalidate config-hash-1 only
      cache.invalidate('config-hash-1')

      // config-hash-1 should be gone
      const result1 = cache.lookup(embedding, 'config-hash-1')
      expect(result1).toBeNull()

      // config-hash-2 should still exist
      const result2 = cache.lookup(embedding, 'config-hash-2')
      expect(result2).not.toBeNull()
      expect(result2?.run_id).toBe('run-2')
    })
  })

  describe('Hit metadata', () => {
    it('surfaces similarity_score, run_id, and objective_text on cache hit', () => {
      const objectiveText = 'Implement user authentication'
      const embedding = embeddingEngine.embed(objectiveText)
      const configHash = 'config-hash-1'
      const requirementMap: RequirementMap = new Map()

      cache.write(
        'run-123',
        objectiveText,
        embedding,
        'model-v1',
        { plan: 'auth plan' },
        { nodes: [] },
        requirementMap,
        configHash,
      )

      const result = cache.lookup(embedding, configHash)

      expect(result).not.toBeNull()
      expect(result?.similarity_score).toBe(1.0)
      expect(result?.run_id).toBe('run-123')
      expect(result?.objective_text).toBe(objectiveText)
    })
  })
})
