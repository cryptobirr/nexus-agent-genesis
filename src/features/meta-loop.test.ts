import { describe, it, expect, beforeEach } from 'vitest'
import { MetaLoop } from './meta-loop.js'
import { EmbeddingEngine } from '../primitives/embedding-engine.js'
import type { SuccessfulPattern, ComplexityClassificationLogEntry } from '../primitives/types.js'

describe('MetaLoop - F-07', () => {
  let metaLoop: MetaLoop
  let embeddingEngine: EmbeddingEngine

  beforeEach(() => {
    embeddingEngine = new EmbeddingEngine()
    metaLoop = new MetaLoop({
      max_pattern_store_size: 10000,
      pattern_store_index_threshold: 1000,
      eviction_policy: 'lru',
      artifact_max_tokens: 512
    }, embeddingEngine)
  })

  describe('Pattern Store Eviction', () => {
    it('evicts pattern when max_pattern_store_size reached', () => {
      // Create MetaLoop with small max size for testing
      const smallMetaLoop = new MetaLoop({
        max_pattern_store_size: 3,
        pattern_store_index_threshold: 1000,
        eviction_policy: 'lru',
        artifact_max_tokens: 512
      }, embeddingEngine)

      // Add 3 patterns (should fit exactly)
      const pattern1: SuccessfulPattern = {
        pattern_id: '1',
        type: 'plan_decomposition',
        objective_cluster: 'fileops',
        domain: 'node',
        strategy: 'divide_by_file',
        embedding: embeddingEngine.embed('test1'),
        embedding_model_id: 'test-model',
        embedding_dimension: 384,
        artifact: 'artifact1',
        created_at: new Date('2024-01-01').toISOString(),
        run_id: 'run1'
      }
      const pattern2: SuccessfulPattern = {
        ...pattern1,
        pattern_id: '2',
        artifact: 'artifact2',
        created_at: new Date('2024-01-02').toISOString(),
        run_id: 'run2'
      }
      const pattern3: SuccessfulPattern = {
        ...pattern1,
        pattern_id: '3',
        artifact: 'artifact3',
        created_at: new Date('2024-01-03').toISOString(),
        run_id: 'run3'
      }

      smallMetaLoop.storePattern(pattern1)
      smallMetaLoop.storePattern(pattern2)
      smallMetaLoop.storePattern(pattern3)

      // Verify 3 patterns stored
      expect(smallMetaLoop.getPatternCount()).toBe(3)

      // Add 4th pattern - should evict oldest
      const pattern4: SuccessfulPattern = {
        ...pattern1,
        pattern_id: '4',
        artifact: 'artifact4',
        created_at: new Date('2024-01-04').toISOString(),
        run_id: 'run4'
      }
      smallMetaLoop.storePattern(pattern4)

      // Verify still 3 patterns (one evicted)
      expect(smallMetaLoop.getPatternCount()).toBe(3)

      // Verify pattern1 was evicted (LRU default)
      expect(smallMetaLoop.hasPattern('1')).toBe(false)
      expect(smallMetaLoop.hasPattern('2')).toBe(true)
      expect(smallMetaLoop.hasPattern('3')).toBe(true)
      expect(smallMetaLoop.hasPattern('4')).toBe(true)
    })

    it('evicts least-recently-accessed pattern with LRU policy', async () => {
      const smallMetaLoop = new MetaLoop({
        max_pattern_store_size: 3,
        pattern_store_index_threshold: 1000,
        eviction_policy: 'lru',
        artifact_max_tokens: 512
      }, embeddingEngine)

      const pattern1: SuccessfulPattern = {
        pattern_id: '1',
        type: 'plan_decomposition',
        objective_cluster: 'fileops',
        domain: 'node',
        strategy: 'divide_by_file',
        embedding: embeddingEngine.embed('test1'),
        embedding_model_id: 'test-model',
        embedding_dimension: 384,
        artifact: 'artifact1',
        created_at: new Date('2024-01-01').toISOString(),
        run_id: 'run1'
      }
      const pattern2: SuccessfulPattern = { ...pattern1, pattern_id: '2', run_id: 'run2' }
      const pattern3: SuccessfulPattern = { ...pattern1, pattern_id: '3', run_id: 'run3' }
      const pattern4: SuccessfulPattern = { ...pattern1, pattern_id: '4', run_id: 'run4' }

      // Add patterns 1, 2, 3 with delays to ensure distinct timestamps
      smallMetaLoop.storePattern(pattern1) // access time: T1
      await new Promise(resolve => setTimeout(resolve, 5))

      smallMetaLoop.storePattern(pattern2) // access time: T2
      await new Promise(resolve => setTimeout(resolve, 5))

      smallMetaLoop.storePattern(pattern3) // access time: T3
      await new Promise(resolve => setTimeout(resolve, 5))

      // Access pattern1 again (refresh its access time)
      smallMetaLoop.accessPattern('1') // access time: T4

      // Now order by LRU: pattern2 (T2) < pattern3 (T3) < pattern1 (T4)

      // Add pattern4 - should evict pattern2 (least recently accessed)
      await new Promise(resolve => setTimeout(resolve, 5))
      smallMetaLoop.storePattern(pattern4)

      expect(smallMetaLoop.hasPattern('1')).toBe(true)  // accessed recently
      expect(smallMetaLoop.hasPattern('2')).toBe(false) // evicted (LRU)
      expect(smallMetaLoop.hasPattern('3')).toBe(true)
      expect(smallMetaLoop.hasPattern('4')).toBe(true)
    })

    it('evicts oldest pattern with oldest_first policy', () => {
      const smallMetaLoop = new MetaLoop({
        max_pattern_store_size: 3,
        pattern_store_index_threshold: 1000,
        eviction_policy: 'oldest_first',
        artifact_max_tokens: 512
      }, embeddingEngine)

      const pattern1: SuccessfulPattern = {
        pattern_id: '1',
        type: 'plan_decomposition',
        objective_cluster: 'fileops',
        domain: 'node',
        strategy: 'divide_by_file',
        embedding: embeddingEngine.embed('test1'),
        embedding_model_id: 'test-model',
        embedding_dimension: 384,
        artifact: 'artifact1',
        created_at: new Date('2024-01-01T00:00:00Z').toISOString(), // oldest
        run_id: 'run1'
      }
      const pattern2: SuccessfulPattern = {
        ...pattern1,
        pattern_id: '2',
        created_at: new Date('2024-01-03T00:00:00Z').toISOString(),
        run_id: 'run2'
      }
      const pattern3: SuccessfulPattern = {
        ...pattern1,
        pattern_id: '3',
        created_at: new Date('2024-01-02T00:00:00Z').toISOString(),
        run_id: 'run3'
      }

      smallMetaLoop.storePattern(pattern1)
      smallMetaLoop.storePattern(pattern2)
      smallMetaLoop.storePattern(pattern3)

      // Access pattern1 to show oldest_first ignores access time
      smallMetaLoop.accessPattern('1')

      // Add 4th pattern - should evict pattern1 (oldest by created_at)
      const pattern4: SuccessfulPattern = {
        ...pattern1,
        pattern_id: '4',
        created_at: new Date('2024-01-04T00:00:00Z').toISOString(),
        run_id: 'run4'
      }
      smallMetaLoop.storePattern(pattern4)

      expect(smallMetaLoop.hasPattern('1')).toBe(false) // evicted (oldest)
      expect(smallMetaLoop.hasPattern('2')).toBe(true)
      expect(smallMetaLoop.hasPattern('3')).toBe(true)
      expect(smallMetaLoop.hasPattern('4')).toBe(true)
    })
  })

  describe('Complexity Classification Log', () => {
    it('appends entry after COMPLETE run', () => {
      const runResult = {
        run_id: 'run123',
        router_classification: 'simple' as const,
        actual_depth: 2,
        trace_eval_score: 0.95,
        status: 'COMPLETE'
      }

      metaLoop.logComplexityClassification(runResult)

      const log = metaLoop.getClassificationLog()
      expect(log).toHaveLength(1)
      expect(log[0].run_id).toBe('run123')
      expect(log[0].router_classification).toBe('simple')
      expect(log[0].actual_depth).toBe(2)
      expect(log[0].trace_eval_score).toBe(0.95)
      expect(log[0].timestamp).toBeDefined()
    })
  })

  describe('Classification Accuracy', () => {
    it('computes fraction of correct ordinal bucket classifications', () => {
      // Log 10 runs: 7 correct, 3 incorrect
      const correctRuns = [
        { run_id: 'r1', router_classification: 'atomic' as const, actual_depth: 0, trace_eval_score: 0.9, status: 'COMPLETE' },
        { run_id: 'r2', router_classification: 'simple' as const, actual_depth: 1, trace_eval_score: 0.9, status: 'COMPLETE' },
        { run_id: 'r3', router_classification: 'simple' as const, actual_depth: 2, trace_eval_score: 0.9, status: 'COMPLETE' },
        { run_id: 'r4', router_classification: 'moderate' as const, actual_depth: 3, trace_eval_score: 0.9, status: 'COMPLETE' },
        { run_id: 'r5', router_classification: 'moderate' as const, actual_depth: 4, trace_eval_score: 0.9, status: 'COMPLETE' },
        { run_id: 'r6', router_classification: 'complex' as const, actual_depth: 5, trace_eval_score: 0.9, status: 'COMPLETE' },
        { run_id: 'r7', router_classification: 'complex' as const, actual_depth: 6, trace_eval_score: 0.9, status: 'COMPLETE' },
      ]

      const incorrectRuns = [
        { run_id: 'r8', router_classification: 'simple' as const, actual_depth: 5, trace_eval_score: 0.9, status: 'COMPLETE' }, // should be complex
        { run_id: 'r9', router_classification: 'complex' as const, actual_depth: 1, trace_eval_score: 0.9, status: 'COMPLETE' }, // should be simple
        { run_id: 'r10', router_classification: 'atomic' as const, actual_depth: 3, trace_eval_score: 0.9, status: 'COMPLETE' }, // should be moderate
      ]

      ;[...correctRuns, ...incorrectRuns].forEach(run => {
        metaLoop.logComplexityClassification(run)
      })

      const accuracy = metaLoop.getClassificationAccuracy()
      expect(accuracy).toBe(0.7) // 7 / 10 = 0.7
    })

    it('returns 0 when no classifications logged', () => {
      expect(metaLoop.getClassificationAccuracy()).toBe(0)
    })

    it('returns 1.0 when all classifications correct', () => {
      const correctRuns = [
        { run_id: 'r1', router_classification: 'atomic' as const, actual_depth: 0, trace_eval_score: 0.9, status: 'COMPLETE' },
        { run_id: 'r2', router_classification: 'simple' as const, actual_depth: 1, trace_eval_score: 0.9, status: 'COMPLETE' },
        { run_id: 'r3', router_classification: 'moderate' as const, actual_depth: 3, trace_eval_score: 0.9, status: 'COMPLETE' },
      ]

      correctRuns.forEach(run => {
        metaLoop.logComplexityClassification(run)
      })

      expect(metaLoop.getClassificationAccuracy()).toBe(1.0)
    })
  })

  describe('ANN Index Threshold', () => {
    it('uses linear search below threshold', () => {
      // Create 999 patterns (below threshold of 1,000)
      for (let i = 0; i < 999; i++) {
        const pattern: SuccessfulPattern = {
          pattern_id: `pattern-${i}`,
          type: 'plan_decomposition',
          objective_cluster: 'fileops',
          domain: 'node',
          strategy: 'test',
          embedding: embeddingEngine.embed(`test ${i}`),
          embedding_model_id: 'test-model',
          embedding_dimension: 384,
          artifact: `artifact ${i}`,
          created_at: new Date().toISOString(),
          run_id: `run-${i}`
        }
        metaLoop.storePattern(pattern)
      }

      expect(metaLoop.getPatternCount()).toBe(999)

      // Lookup should use linear search (not ANN)
      const results = metaLoop.lookupPatterns('fileops', 'node', 5, 0.8)
      expect(metaLoop.isUsingANNIndex()).toBe(false)
    })

    it('uses ANN index at threshold', () => {
      // Create exactly 1,000 patterns
      for (let i = 0; i < 1000; i++) {
        const pattern: SuccessfulPattern = {
          pattern_id: `pattern-${i}`,
          type: 'plan_decomposition',
          objective_cluster: 'fileops',
          domain: 'node',
          strategy: 'test',
          embedding: embeddingEngine.embed(`test ${i}`),
          embedding_model_id: 'test-model',
          embedding_dimension: 384,
          artifact: `artifact ${i}`,
          created_at: new Date().toISOString(),
          run_id: `run-${i}`
        }
        metaLoop.storePattern(pattern)
      }

      expect(metaLoop.getPatternCount()).toBe(1000)

      // Lookup should use ANN (topK)
      const results = metaLoop.lookupPatterns('fileops', 'node', 5, 0.8)
      expect(metaLoop.isUsingANNIndex()).toBe(true)
    })
  })

  describe('Artifact Capping', () => {
    it('caps artifact to 512 tokens before storing', () => {
      // Create artifact with ~1000 tokens (assuming ~4 chars per token)
      const longArtifact = 'word '.repeat(1000) // ~5000 chars, ~1000 tokens

      const pattern: SuccessfulPattern = {
        pattern_id: 'long-pattern',
        type: 'plan_decomposition',
        objective_cluster: 'fileops',
        domain: 'node',
        strategy: 'test',
        embedding: embeddingEngine.embed('test'),
        embedding_model_id: 'test-model',
        embedding_dimension: 384,
        artifact: longArtifact,
        created_at: new Date().toISOString(),
        run_id: 'run-long'
      }

      metaLoop.storePattern(pattern)

      // Retrieve and verify artifact was capped
      const stored = metaLoop.getPattern('long-pattern')
      expect(stored).toBeDefined()

      // Estimate tokens (rough: 1 token ≈ 4 chars)
      const estimatedTokens = stored!.artifact.length / 4
      expect(estimatedTokens).toBeLessThanOrEqual(512)
      expect(stored!.artifact.length).toBeLessThan(longArtifact.length)
    })

    it('does not modify artifact under 512 tokens', () => {
      const shortArtifact = 'short artifact'

      const pattern: SuccessfulPattern = {
        pattern_id: 'short-pattern',
        type: 'plan_decomposition',
        objective_cluster: 'fileops',
        domain: 'node',
        strategy: 'test',
        embedding: embeddingEngine.embed('test'),
        embedding_model_id: 'test-model',
        embedding_dimension: 384,
        artifact: shortArtifact,
        created_at: new Date().toISOString(),
        run_id: 'run-short'
      }

      metaLoop.storePattern(pattern)

      const stored = metaLoop.getPattern('short-pattern')
      expect(stored?.artifact).toBe(shortArtifact)
    })
  })

  describe('Pattern Indexing by Cluster + Domain', () => {
    it('filters patterns by objective_cluster and domain', () => {
      const pattern1: SuccessfulPattern = {
        pattern_id: 'p1',
        type: 'plan_decomposition',
        objective_cluster: 'fileops',
        domain: 'node',
        strategy: 'test',
        embedding: embeddingEngine.embed('fileops node'),
        embedding_model_id: 'test-model',
        embedding_dimension: 384,
        artifact: 'artifact1',
        created_at: new Date().toISOString(),
        run_id: 'run1'
      }

      const pattern2: SuccessfulPattern = {
        ...pattern1,
        pattern_id: 'p2',
        domain: 'python',
        embedding: embeddingEngine.embed('fileops python'),
        run_id: 'run2'
      }

      const pattern3: SuccessfulPattern = {
        ...pattern1,
        pattern_id: 'p3',
        objective_cluster: 'dataops',
        embedding: embeddingEngine.embed('dataops node'),
        run_id: 'run3'
      }

      metaLoop.storePattern(pattern1)
      metaLoop.storePattern(pattern2)
      metaLoop.storePattern(pattern3)

      // Lookup fileops + node - should only return pattern1
      const results = metaLoop.lookupPatterns('fileops', 'node', 10, 0.0)
      expect(results).toHaveLength(1)
      expect(results[0].pattern_id).toBe('p1')
    })

    it('handles null domain correctly', () => {
      const pattern1: SuccessfulPattern = {
        pattern_id: 'p1',
        type: 'plan_decomposition',
        objective_cluster: 'fileops',
        domain: null,
        strategy: 'test',
        embedding: embeddingEngine.embed('fileops'),
        embedding_model_id: 'test-model',
        embedding_dimension: 384,
        artifact: 'artifact1',
        created_at: new Date().toISOString(),
        run_id: 'run1'
      }

      const pattern2: SuccessfulPattern = {
        ...pattern1,
        pattern_id: 'p2',
        domain: 'node',
        run_id: 'run2'
      }

      metaLoop.storePattern(pattern1)
      metaLoop.storePattern(pattern2)

      // Lookup with null domain
      const results = metaLoop.lookupPatterns('fileops', null, 10, 0.0)
      expect(results).toHaveLength(1)
      expect(results[0].pattern_id).toBe('p1')
      expect(results[0].domain).toBeNull()
    })
  })
})
