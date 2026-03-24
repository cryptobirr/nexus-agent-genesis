import { describe, it, expect, beforeEach } from 'vitest'
import { ContextAssembler } from './context-assembler.js'
import { EmbeddingEngine } from './embedding-engine.js'
import type {
  ContextAssemblyPolicy,
  ContextChunk,
  ExecutionMemory,
} from './types.js'

describe('ContextAssembler (P-16)', () => {
  let assembler: ContextAssembler
  let embeddingEngine: EmbeddingEngine

  beforeEach(() => {
    embeddingEngine = new EmbeddingEngine(384)
    assembler = new ContextAssembler(embeddingEngine)
  })

  describe('assemble()', () => {
    it('should return ranked chunks when no cache exists', () => {
      const chunks: ContextChunk[] = [
        {
          chunk_id: 'chunk1',
          content: 'TypeScript is a typed superset of JavaScript',
          source: 'documentation',
        },
        {
          chunk_id: 'chunk2',
          content: 'Python is a high-level programming language',
          source: 'documentation',
        },
        {
          chunk_id: 'chunk3',
          content: 'TypeScript adds static typing to JavaScript',
          source: 'documentation',
        },
      ]

      const policy: ContextAssemblyPolicy = {
        ranking_model: 'embedding',
        diversity_penalty: 0,
        max_chunks: 3,
        relevance_threshold: 0,
        retrieval_sources: ['documentation'],
        available_chunks: chunks,
      }

      const scope = 'Explain TypeScript features'
      const execution_memory: ExecutionMemory = {
        attempts: 1,
        previous_outputs: [],
        context: '',
      }

      const result = assembler.assemble(policy, scope, execution_memory)

      expect(result.chunks).toHaveLength(3)
      expect(result.from_cache).toBe(false)
      // chunk1 and chunk3 should rank higher (more relevant to TypeScript)
    })

    it('should re-inject cached chunks without retrieval', () => {
      const cached_chunks: ContextChunk[] = [
        {
          chunk_id: 'cached1',
          content: 'Cached content 1',
          source: 'cache',
        },
        {
          chunk_id: 'cached2',
          content: 'Cached content 2',
          source: 'cache',
        },
      ]

      const policy: ContextAssemblyPolicy = {
        ranking_model: 'embedding',
        diversity_penalty: 0,
        max_chunks: 3,
        relevance_threshold: 0,
        retrieval_sources: ['documentation'],
        available_chunks: [], // No new chunks available
      }

      const execution_memory: ExecutionMemory = {
        attempts: 2,
        previous_outputs: ['previous output'],
        context: 'previous context',
        retrieved_chunks: cached_chunks,
      }

      const result = assembler.assemble(policy, 'any scope', execution_memory)

      expect(result.chunks).toEqual(cached_chunks)
      expect(result.from_cache).toBe(true)
    })

    it('should apply diversity penalty to remove near-duplicates', () => {
      const chunks: ContextChunk[] = [
        {
          chunk_id: 'chunk1',
          content: 'TypeScript is a typed superset of JavaScript',
          source: 'documentation',
        },
        {
          chunk_id: 'chunk2',
          content: 'TypeScript is a typed superset of JavaScript language',
          source: 'documentation',
        },
        {
          chunk_id: 'chunk3',
          content: 'Python is completely different',
          source: 'documentation',
        },
      ]

      const policy: ContextAssemblyPolicy = {
        ranking_model: 'embedding',
        diversity_penalty: 0.5,
        max_chunks: 3,
        relevance_threshold: 0,
        retrieval_sources: ['documentation'],
        available_chunks: chunks,
      }

      const scope = 'TypeScript'
      const execution_memory: ExecutionMemory = {
        attempts: 1,
        previous_outputs: [],
        context: '',
      }

      const result = assembler.assemble(policy, scope, execution_memory)

      // Should filter out chunk2 (near-duplicate of chunk1)
      expect(result.chunks.length).toBeLessThan(3)
      expect(result.from_cache).toBe(false)
    })

    it('should rank by embedding similarity', () => {
      const chunks: ContextChunk[] = [
        {
          chunk_id: 'chunk1',
          content: 'banana apple orange',
          source: 'documentation',
        },
        {
          chunk_id: 'chunk2',
          content: 'apple fruit red delicious',
          source: 'documentation',
        },
        {
          chunk_id: 'chunk3',
          content: 'car engine motor vehicle',
          source: 'documentation',
        },
      ]

      const policy: ContextAssemblyPolicy = {
        ranking_model: 'embedding',
        diversity_penalty: 0,
        max_chunks: 3,
        relevance_threshold: 0,
        retrieval_sources: ['documentation'],
        available_chunks: chunks,
      }

      const scope = 'apple fruit'
      const execution_memory: ExecutionMemory = {
        attempts: 1,
        previous_outputs: [],
        context: '',
      }

      const result = assembler.assemble(policy, scope, execution_memory)

      // chunk2 should rank highest (most similar to "apple fruit")
      expect(result.chunks[0].chunk_id).toBe('chunk2')
      expect(result.from_cache).toBe(false)
    })

    it('should skip assembly for transform strategy with no retrieval sources', () => {
      const policy: ContextAssemblyPolicy = {
        ranking_model: 'embedding',
        diversity_penalty: 0,
        max_chunks: 3,
        relevance_threshold: 0,
        retrieval_sources: [], // Empty sources
        strategy: 'transform',
        available_chunks: [
          {
            chunk_id: 'chunk1',
            content: 'some content',
            source: 'documentation',
          },
        ],
      }

      const execution_memory: ExecutionMemory = {
        attempts: 1,
        previous_outputs: [],
        context: '',
      }

      const result = assembler.assemble(policy, 'any scope', execution_memory)

      expect(result.chunks).toHaveLength(0)
      expect(result.from_cache).toBe(false)
    })
  })

  describe('recordFeedback()', () => {
    it('should update weights in order-independent manner (commutative)', () => {
      const chunk_ids = ['chunk1', 'chunk2']

      // Path A: chunk1 pass, chunk2 fail
      const assemblerA = new ContextAssembler(embeddingEngine)
      assemblerA.recordFeedback(['chunk1'], true)
      assemblerA.recordFeedback(['chunk2'], false)

      // Path B: chunk2 fail, chunk1 pass (reversed order)
      const assemblerB = new ContextAssembler(embeddingEngine)
      assemblerB.recordFeedback(['chunk2'], false)
      assemblerB.recordFeedback(['chunk1'], true)

      // Weights should be identical regardless of order
      const weightA1 = assemblerA.getFeedbackWeight('chunk1')
      const weightA2 = assemblerA.getFeedbackWeight('chunk2')
      const weightB1 = assemblerB.getFeedbackWeight('chunk1')
      const weightB2 = assemblerB.getFeedbackWeight('chunk2')

      expect(weightA1).toBe(weightB1)
      expect(weightA2).toBe(weightB2)
    })

    it('should clamp weights to [base×0.5, base×2.0]', () => {
      const chunk_id = 'chunk1'
      const base_weight = 1.0

      // Record many positive feedbacks to push above 2.0
      for (let i = 0; i < 20; i++) {
        assembler.recordFeedback([chunk_id], true)
      }

      const weight_after_positive = assembler.getFeedbackWeight(chunk_id)
      expect(weight_after_positive).toBeLessThanOrEqual(base_weight * 2.0)

      // Record many negative feedbacks to push below 0.5
      for (let i = 0; i < 50; i++) {
        assembler.recordFeedback([chunk_id], false)
      }

      const weight_after_negative = assembler.getFeedbackWeight(chunk_id)
      expect(weight_after_negative).toBeGreaterThanOrEqual(base_weight * 0.5)
    })

    it('should enforce TTL of 30 days (lazy deletion)', () => {
      const chunk_id = 'chunk1'

      // Record feedback
      assembler.recordFeedback([chunk_id], true)

      // Artificially age the feedback to 31 days ago
      const feedback_state = (assembler as any).feedbackWeights.get(chunk_id)
      if (feedback_state) {
        const thirty_one_days_ago = Date.now() - 31 * 24 * 60 * 60 * 1000
        feedback_state.timestamp = thirty_one_days_ago
      }

      // Access weight - should trigger TTL check and return base weight
      const weight = assembler.getFeedbackWeight(chunk_id)
      expect(weight).toBe(1.0) // Base weight (expired)

      // Verify feedback was deleted
      expect((assembler as any).feedbackWeights.has(chunk_id)).toBe(false)
    })
  })
})
