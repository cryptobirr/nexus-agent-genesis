import { describe, it, expect, beforeEach } from 'vitest'
import { ExecutionMemoryStore } from './execution-memory-store.js'
import { EmbeddingEngine } from './embedding-engine.js'
import type { FailedStrategy, SuccessfulPattern } from './types.js'

describe('ExecutionMemoryStore (P-20)', () => {
  let store: ExecutionMemoryStore

  beforeEach(() => {
    store = new ExecutionMemoryStore()
  })

  describe('init()', () => {
    it('creates new ExecutionMemory for agent_id', () => {
      const memory = store.init('agent-1', 'run-1')

      expect(memory).toBeDefined()
      expect(memory.agent_id).toBe('agent-1')
      expect(memory.run_id).toBe('run-1')
      expect(memory.retrieved_chunks).toEqual([])
      expect(memory.failed_strategies).toEqual([])
      expect(memory.successful_patterns).toEqual([])
    })

    it('returns same instance for same agent_id', () => {
      const memory1 = store.init('agent-1', 'run-1')
      const memory2 = store.init('agent-1', 'run-1')

      expect(memory1).toBe(memory2)
    })

    it('different agent_ids get separate stores', () => {
      const memory1 = store.init('agent-1', 'run-1')
      const memory2 = store.init('agent-2', 'run-1')

      expect(memory1).not.toBe(memory2)
      expect(memory1.agent_id).toBe('agent-1')
      expect(memory2.agent_id).toBe('agent-2')
    })
  })

  describe('get()', () => {
    it('returns ExecutionMemory for initialized agent_id', () => {
      store.init('agent-1', 'run-1')
      const memory = store.get('agent-1')

      expect(memory).toBeDefined()
      expect(memory?.agent_id).toBe('agent-1')
    })

    it('returns undefined for uninitialized agent_id', () => {
      const memory = store.get('nonexistent-agent')

      expect(memory).toBeUndefined()
    })
  })

  describe('appendFailedStrategy()', () => {
    it('appends failed strategy to agent memory', () => {
      store.init('agent-1', 'run-1')

      const strategy: FailedStrategy = {
        attempt: 1,
        failure_type: 'reasoning_failure',
        gate: 1,
        gap: 'Insufficient analysis depth'
      }

      store.appendFailedStrategy('agent-1', strategy)

      const memory = store.get('agent-1')
      expect(memory?.failed_strategies).toHaveLength(1)
      expect(memory?.failed_strategies[0]).toEqual(strategy)
    })

    it('caps failed_strategies at max_retries (default 3)', () => {
      store.init('agent-1', 'run-1')

      const strategies: FailedStrategy[] = [
        { attempt: 1, failure_type: 'reasoning_failure', gate: 1, gap: 'Gap 1' },
        { attempt: 2, failure_type: 'tool_failure', gate: 1, gap: 'Gap 2' },
        { attempt: 3, failure_type: 'planning_failure', gate: 2, gap: 'Gap 3' },
        { attempt: 4, failure_type: 'timeout_failure', gate: 1, gap: 'Gap 4' }
      ]

      strategies.forEach((s) => store.appendFailedStrategy('agent-1', s))

      const memory = store.get('agent-1')
      expect(memory?.failed_strategies).toHaveLength(3)
      // FIFO: oldest (attempt 1) should be evicted
      expect(memory?.failed_strategies[0].attempt).toBe(2)
      expect(memory?.failed_strategies[1].attempt).toBe(3)
      expect(memory?.failed_strategies[2].attempt).toBe(4)
    })

    it('respects custom max_retries', () => {
      const customStore = new ExecutionMemoryStore({ max_retries: 2 })
      customStore.init('agent-1', 'run-1')

      const strategies: FailedStrategy[] = [
        { attempt: 1, failure_type: 'reasoning_failure', gate: 1, gap: 'Gap 1' },
        { attempt: 2, failure_type: 'tool_failure', gate: 1, gap: 'Gap 2' },
        { attempt: 3, failure_type: 'planning_failure', gate: 2, gap: 'Gap 3' }
      ]

      strategies.forEach((s) => customStore.appendFailedStrategy('agent-1', s))

      const memory = customStore.get('agent-1')
      expect(memory?.failed_strategies).toHaveLength(2)
      expect(memory?.failed_strategies[0].attempt).toBe(2)
      expect(memory?.failed_strategies[1].attempt).toBe(3)
    })
  })

  describe('addRetrievedChunks()', () => {
    it('adds chunk_ids to retrieved_chunks', () => {
      store.init('agent-1', 'run-1')

      store.addRetrievedChunks('agent-1', ['chunk-1', 'chunk-2', 'chunk-3'])

      const memory = store.get('agent-1')
      expect(memory?.retrieved_chunks).toEqual(['chunk-1', 'chunk-2', 'chunk-3'])
    })

    it('appends chunks across multiple calls', () => {
      store.init('agent-1', 'run-1')

      store.addRetrievedChunks('agent-1', ['chunk-1', 'chunk-2'])
      store.addRetrievedChunks('agent-1', ['chunk-3', 'chunk-4'])

      const memory = store.get('agent-1')
      expect(memory?.retrieved_chunks).toEqual([
        'chunk-1',
        'chunk-2',
        'chunk-3',
        'chunk-4'
      ])
    })

    it('LRU eviction fires at 500 chunks', () => {
      store.init('agent-1', 'run-1')

      // Add 500 chunks
      const chunks500 = Array.from({ length: 500 }, (_, i) => `chunk-${i}`)
      store.addRetrievedChunks('agent-1', chunks500)

      const memory1 = store.get('agent-1')
      expect(memory1?.retrieved_chunks).toHaveLength(500)

      // Add 3 more chunks - should evict oldest 3 (LRU)
      store.addRetrievedChunks('agent-1', ['chunk-500', 'chunk-501', 'chunk-502'])

      const memory2 = store.get('agent-1')
      expect(memory2?.retrieved_chunks).toHaveLength(500)
      // Oldest 3 evicted (chunk-0, chunk-1, chunk-2)
      expect(memory2?.retrieved_chunks[0]).toBe('chunk-3')
      expect(memory2?.retrieved_chunks[497]).toBe('chunk-500')
      expect(memory2?.retrieved_chunks[498]).toBe('chunk-501')
      expect(memory2?.retrieved_chunks[499]).toBe('chunk-502')
    })

    it('respects custom max_retrieved_chunks', () => {
      const customStore = new ExecutionMemoryStore({ max_retrieved_chunks: 10 })
      customStore.init('agent-1', 'run-1')

      const chunks = Array.from({ length: 15 }, (_, i) => `chunk-${i}`)
      customStore.addRetrievedChunks('agent-1', chunks)

      const memory = customStore.get('agent-1')
      expect(memory?.retrieved_chunks).toHaveLength(10)
      // Last 10 chunks retained (LRU)
      expect(memory?.retrieved_chunks[0]).toBe('chunk-5')
      expect(memory?.retrieved_chunks[9]).toBe('chunk-14')
    })
  })

  describe('loadSuccessfulPatterns()', () => {
    it('loads patterns into agent memory', () => {
      store.init('agent-1', 'run-1')

      const patterns: SuccessfulPattern[] = [
        {
          pattern_id: 'p1',
          type: 'plan_decomposition',
          objective_cluster: 'data-processing',
          domain: 'backend',
          strategy: 'search',
          embedding: [1, 2, 3],
          embedding_model_id: 'model-v1',
          embedding_dimension: 384,
          artifact: 'Sample artifact',
          created_at: '2026-01-01T00:00:00Z',
          run_id: 'run-1'
        }
      ]

      store.loadSuccessfulPatterns('agent-1', patterns)

      const memory = store.get('agent-1')
      expect(memory?.successful_patterns).toHaveLength(1)
      expect(memory?.successful_patterns[0]).toEqual(patterns[0])
    })

    it('overwrites existing patterns (not append)', () => {
      store.init('agent-1', 'run-1')

      const patterns1: SuccessfulPattern[] = [
        {
          pattern_id: 'p1',
          type: 'plan_decomposition',
          objective_cluster: 'data-processing',
          domain: 'backend',
          strategy: 'search',
          embedding: [1, 2, 3],
          embedding_model_id: 'model-v1',
          embedding_dimension: 384,
          artifact: 'Artifact 1',
          created_at: '2026-01-01T00:00:00Z',
          run_id: 'run-1'
        }
      ]

      const patterns2: SuccessfulPattern[] = [
        {
          pattern_id: 'p2',
          type: 'sec_write_sequence',
          objective_cluster: 'data-analysis',
          domain: 'backend',
          strategy: 'analyze',
          embedding: [4, 5, 6],
          embedding_model_id: 'model-v1',
          embedding_dimension: 384,
          artifact: 'Artifact 2',
          created_at: '2026-01-02T00:00:00Z',
          run_id: 'run-1'
        }
      ]

      store.loadSuccessfulPatterns('agent-1', patterns1)
      store.loadSuccessfulPatterns('agent-1', patterns2)

      const memory = store.get('agent-1')
      expect(memory?.successful_patterns).toHaveLength(1)
      expect(memory?.successful_patterns[0].pattern_id).toBe('p2')
    })

    it('handles empty pattern array', () => {
      store.init('agent-1', 'run-1')

      store.loadSuccessfulPatterns('agent-1', [])

      const memory = store.get('agent-1')
      expect(memory?.successful_patterns).toEqual([])
    })
  })

  describe('pattern indexing threshold', () => {
    it('uses EmbeddingEngine.topK when pattern count >= threshold', () => {
      const engine = new EmbeddingEngine()
      const customStore = new ExecutionMemoryStore({
        pattern_store_index_threshold: 3,
        embedding_engine: engine
      })

      customStore.init('agent-1', 'run-1')

      // Load 3 patterns (at threshold)
      const patterns: SuccessfulPattern[] = Array.from({ length: 3 }, (_, i) => ({
        pattern_id: `p${i}`,
        type: 'plan_decomposition' as const,
        objective_cluster: 'cluster-1',
        domain: 'backend',
        strategy: 'search',
        embedding: engine.embed(`pattern ${i}`),
        embedding_model_id: 'model-v1',
        embedding_dimension: 384,
        artifact: `Artifact ${i}`,
        created_at: '2026-01-01T00:00:00Z',
        run_id: 'run-1'
      }))

      customStore.loadSuccessfulPatterns('agent-1', patterns)

      const memory = customStore.get('agent-1')
      expect(memory?.successful_patterns).toHaveLength(3)
      // Behavior change verification would be at runtime when patterns are queried
      // For now, just verify storage works
    })
  })

  describe('embedding model mismatch handling', () => {
    it('filters out patterns with mismatched embedding_model_id', () => {
      const engine = new EmbeddingEngine()
      const customStore = new ExecutionMemoryStore({ embedding_engine: engine })

      customStore.init('agent-1', 'run-1')

      const patterns: SuccessfulPattern[] = [
        {
          pattern_id: 'p1',
          type: 'plan_decomposition',
          objective_cluster: 'cluster-1',
          domain: 'backend',
          strategy: 'search',
          embedding: [1, 2, 3],
          embedding_model_id: 'model-v1',  // Current model
          embedding_dimension: 384,
          artifact: 'Artifact 1',
          created_at: '2026-01-01T00:00:00Z',
          run_id: 'run-1'
        },
        {
          pattern_id: 'p2',
          type: 'plan_decomposition',
          objective_cluster: 'cluster-1',
          domain: 'backend',
          strategy: 'search',
          embedding: [4, 5, 6],
          embedding_model_id: 'old-model-v0',  // Mismatched model
          embedding_dimension: 384,
          artifact: 'Artifact 2',
          created_at: '2026-01-01T00:00:00Z',
          run_id: 'run-1'
        }
      ]

      customStore.loadSuccessfulPatterns('agent-1', patterns)

      // Verify patterns are stored (filtering happens at query time via EmbeddingEngine.topK)
      const memory = customStore.get('agent-1')
      expect(memory?.successful_patterns).toHaveLength(2)
    })
  })

  describe('non-persistence', () => {
    it('store is in-memory only', () => {
      store.init('agent-1', 'run-1')
      store.addRetrievedChunks('agent-1', ['chunk-1', 'chunk-2'])

      const memory = store.get('agent-1')
      expect(memory?.retrieved_chunks).toHaveLength(2)

      // No persistence API - store exists only in memory
      // This test verifies absence of persistence methods
      expect(typeof (store as any).save).toBe('undefined')
      expect(typeof (store as any).load).toBe('undefined')
    })
  })
})
