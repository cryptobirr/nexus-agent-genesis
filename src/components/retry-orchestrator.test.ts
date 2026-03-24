import { describe, it, expect, beforeEach, vi } from 'vitest'
import { RetryOrchestrator } from './retry-orchestrator.js'
import { FailureClassifier } from '../primitives/failure-classifier.js'
import { ExecutionMemoryStore } from '../primitives/execution-memory-store.js'
import { EvalPipeline } from './eval-pipeline.js'
import type { ToolRegistry } from '../primitives/tool-registry.js'
import type {
  FailureType,
  FailedStrategy,
  SuccessfulPattern,
  ExecutionMemory,
  Tool
} from '../primitives/types.js'

describe('RetryOrchestrator - C-07', () => {
  let retryOrchestrator: RetryOrchestrator
  let failureClassifier: FailureClassifier
  let executionMemoryStore: ExecutionMemoryStore
  let mockEvalPipeline: EvalPipeline
  let mockToolRegistry: ToolRegistry

  beforeEach(() => {
    failureClassifier = new FailureClassifier()
    executionMemoryStore = new ExecutionMemoryStore({ max_retries: 3 })
    mockEvalPipeline = {} as EvalPipeline
    mockToolRegistry = {
      get: vi.fn((tool_id: string) => {
        if (tool_id === 'destructive_tool') {
          return { tool_id, side_effect_class: 'destructive' } as Tool
        }
        return { tool_id, side_effect_class: 'read_only' } as Tool
      }),
      has: vi.fn(() => true)
    } as unknown as ToolRegistry

    retryOrchestrator = new RetryOrchestrator(
      failureClassifier,
      executionMemoryStore,
      mockEvalPipeline,
      mockToolRegistry
    )
  })

  describe('Retry budget management', () => {
    it('infrastructure_failure does NOT decrement retry counter', () => {
      executionMemoryStore.init('agent1', 'run1')

      const decision = retryOrchestrator.decideRetry({
        agent_id: 'agent1',
        failure_type: 'infrastructure_failure',
        gate: 1,
        gap: 'Infrastructure error',
        attempt: 1
      })

      expect(decision.retry_count_consumed).toBe(false)
      expect(decision.should_retry).toBe(true)
    })

    it('blob_write_failure does NOT decrement retry counter', () => {
      executionMemoryStore.init('agent1', 'run1')

      const decision = retryOrchestrator.decideRetry({
        agent_id: 'agent1',
        failure_type: 'blob_write_failure',
        gate: 2,
        gap: 'Blob write failed',
        attempt: 1
      })

      expect(decision.retry_count_consumed).toBe(false)
      expect(decision.should_retry).toBe(true)
      expect(decision.backoff_ms).toBeGreaterThan(0)
    })

    it('reasoning_failure DOES decrement retry counter', () => {
      executionMemoryStore.init('agent1', 'run1')

      const decision = retryOrchestrator.decideRetry({
        agent_id: 'agent1',
        failure_type: 'reasoning_failure',
        gate: 2,
        gap: 'Reasoning insufficient',
        attempt: 1
      })

      expect(decision.retry_count_consumed).toBe(true)
      expect(decision.should_retry).toBe(true)
    })
  })

  describe('Blob write failure handling', () => {
    it('retries with exponential backoff up to blob_write_retry_max', () => {
      executionMemoryStore.init('agent1', 'run1')

      // Attempt 1: backoff = 100ms * 2^0 = 100ms
      const decision1 = retryOrchestrator.decideRetry({
        agent_id: 'agent1',
        failure_type: 'blob_write_failure',
        gate: 2,
        gap: 'Blob write failed',
        attempt: 1
      })
      expect(decision1.backoff_ms).toBe(100)
      expect(decision1.should_retry).toBe(true)

      // Attempt 2: backoff = 100ms * 2^1 = 200ms
      const decision2 = retryOrchestrator.decideRetry({
        agent_id: 'agent1',
        failure_type: 'blob_write_failure',
        gate: 2,
        gap: 'Blob write failed',
        attempt: 2
      })
      expect(decision2.backoff_ms).toBe(200)
      expect(decision2.should_retry).toBe(true)

      // Attempt 3: backoff = 100ms * 2^2 = 400ms
      const decision3 = retryOrchestrator.decideRetry({
        agent_id: 'agent1',
        failure_type: 'blob_write_failure',
        gate: 2,
        gap: 'Blob write failed',
        attempt: 3
      })
      expect(decision3.backoff_ms).toBe(400)
      expect(decision3.should_retry).toBe(true)
    })

    it('after blob_write_retry_max attempts, escalates as infrastructure_failure', () => {
      executionMemoryStore.init('agent1', 'run1')

      // After 3 attempts, should escalate
      const decision = retryOrchestrator.decideRetry({
        agent_id: 'agent1',
        failure_type: 'blob_write_failure',
        gate: 2,
        gap: 'Blob write failed',
        attempt: 4  // Exceeds blob_write_retry_max=3
      })

      expect(decision.should_retry).toBe(false)
      expect(decision.should_escalate).toBe(true)
      expect(decision.retry_count_consumed).toBe(false)  // Still exempt
    })
  })

  describe('Retry prompt composition', () => {
    it('includes FailedStrategy summary in correct format', () => {
      const memory: ExecutionMemory = executionMemoryStore.init('agent1', 'run1')
      memory.failed_strategies = [
        {
          attempt: 1,
          failure_type: 'reasoning_failure',
          gate: 2,
          gap: 'Insufficient evidence',
          output: 'Previous output'
        }
      ]

      const decision = retryOrchestrator.decideRetry({
        agent_id: 'agent1',
        failure_type: 'reasoning_failure',
        gate: 2,
        gap: 'Still insufficient',
        attempt: 2
      })

      expect(decision.retry_prompt).toContain('On attempt 1')
      expect(decision.retry_prompt).toContain('reasoning_failure')
      expect(decision.retry_prompt).toContain('gate 2')
      expect(decision.retry_prompt).toContain('Insufficient evidence')
      expect(decision.retry_prompt).toContain('Do not repeat this approach')
    })

    it('injects successful pattern scaffold if above similarity_threshold', () => {
      const memory: ExecutionMemory = executionMemoryStore.init('agent1', 'run1')
      memory.successful_patterns = [
        {
          pattern_id: 'pattern1',
          type: 'plan_decomposition',
          objective_cluster: 'test_cluster',
          domain: 'test_domain',
          strategy: null,
          embedding: [0.1, 0.2, 0.3],
          embedding_model_id: 'test-model',
          embedding_dimension: 3,
          artifact: 'Successful pattern scaffold',
          created_at: '2026-03-24T00:00:00Z',
          run_id: 'run1'
        }
      ]

      // Mock high similarity (above threshold 0.75)
      const decision = retryOrchestrator.decideRetry({
        agent_id: 'agent1',
        failure_type: 'planning_failure',
        gate: 1,
        gap: 'Planning failed',
        attempt: 1,
        current_objective: 'test_cluster'  // Matches pattern
      })

      // Pattern should be injected when objective matches
      expect(decision.retry_prompt).toContain('Successful pattern scaffold')
    })

    it('does NOT inject pattern if below similarity_threshold', () => {
      const memory: ExecutionMemory = executionMemoryStore.init('agent1', 'run1')
      memory.successful_patterns = [
        {
          pattern_id: 'pattern1',
          type: 'plan_decomposition',
          objective_cluster: 'completely_different_cluster',
          domain: null,
          strategy: null,
          embedding: [0.1, 0.2, 0.3],
          embedding_model_id: 'test-model',
          embedding_dimension: 3,
          artifact: 'Successful pattern scaffold',
          created_at: '2026-03-24T00:00:00Z',
          run_id: 'run1'
        }
      ]

      const decision = retryOrchestrator.decideRetry({
        agent_id: 'agent1',
        failure_type: 'planning_failure',
        gate: 1,
        gap: 'Planning failed',
        attempt: 1,
        current_objective: 'unrelated_objective'
      })

      // Pattern should NOT be injected
      expect(decision.retry_prompt).not.toContain('Successful pattern scaffold')
    })
  })

  describe('Destructive tool no-retry rule', () => {
    it('tool_failure from destructive tool → immediate escalation, no retry', () => {
      executionMemoryStore.init('agent1', 'run1')

      const decision = retryOrchestrator.decideRetry({
        agent_id: 'agent1',
        failure_type: 'tool_failure',
        gate: 1,
        gap: 'Tool execution failed',
        attempt: 1,
        tool_id: 'destructive_tool'
      })

      expect(decision.should_retry).toBe(false)
      expect(decision.should_escalate).toBe(true)
      expect(decision.retry_count_consumed).toBe(false)
      expect(decision.retry_prompt).toBeNull()
    })

    it('tool_failure from non-destructive tool → normal retry', () => {
      executionMemoryStore.init('agent1', 'run1')

      const decision = retryOrchestrator.decideRetry({
        agent_id: 'agent1',
        failure_type: 'tool_failure',
        gate: 1,
        gap: 'Tool execution failed',
        attempt: 1,
        tool_id: 'safe_tool'
      })

      expect(decision.should_retry).toBe(true)
      expect(decision.should_escalate).toBe(false)
      expect(decision.retry_count_consumed).toBe(true)
      expect(decision.retry_prompt).not.toBeNull()
    })
  })

  describe('ExecutionMemory integration', () => {
    it('appends failed strategy to ExecutionMemory after decision', () => {
      const memory: ExecutionMemory = executionMemoryStore.init('agent1', 'run1')

      retryOrchestrator.recordFailedAttempt({
        agent_id: 'agent1',
        failure_type: 'reasoning_failure',
        gate: 2,
        gap: 'Reasoning insufficient',
        attempt: 1,
        output: 'Failed output'
      })

      expect(memory.failed_strategies.length).toBe(1)
      expect(memory.failed_strategies[0]).toEqual({
        attempt: 1,
        failure_type: 'reasoning_failure',
        gate: 2,
        gap: 'Reasoning insufficient',
        output: 'Failed output'
      })
    })

    it('respects max_retries cap (FIFO eviction)', () => {
      const memory: ExecutionMemory = executionMemoryStore.init('agent1', 'run1')

      // Add 4 failed strategies (max_retries = 3)
      retryOrchestrator.recordFailedAttempt({
        agent_id: 'agent1',
        failure_type: 'reasoning_failure',
        gate: 2,
        gap: 'Attempt 1',
        attempt: 1
      })
      retryOrchestrator.recordFailedAttempt({
        agent_id: 'agent1',
        failure_type: 'reasoning_failure',
        gate: 2,
        gap: 'Attempt 2',
        attempt: 2
      })
      retryOrchestrator.recordFailedAttempt({
        agent_id: 'agent1',
        failure_type: 'reasoning_failure',
        gate: 2,
        gap: 'Attempt 3',
        attempt: 3
      })
      retryOrchestrator.recordFailedAttempt({
        agent_id: 'agent1',
        failure_type: 'reasoning_failure',
        gate: 2,
        gap: 'Attempt 4',
        attempt: 4
      })

      // Should only have 3 strategies (oldest evicted)
      expect(memory.failed_strategies.length).toBe(3)
      expect(memory.failed_strategies[0].attempt).toBe(2)  // Attempt 1 evicted
      expect(memory.failed_strategies[2].attempt).toBe(4)
    })
  })

  describe('Max retries exceeded', () => {
    it('stops retrying after max_retries attempts consumed', () => {
      executionMemoryStore.init('agent1', 'run1')

      // Simulate 3 failed attempts (max_retries = 3)
      retryOrchestrator.recordFailedAttempt({
        agent_id: 'agent1',
        failure_type: 'reasoning_failure',
        gate: 2,
        gap: 'Attempt 1',
        attempt: 1
      })
      retryOrchestrator.recordFailedAttempt({
        agent_id: 'agent1',
        failure_type: 'reasoning_failure',
        gate: 2,
        gap: 'Attempt 2',
        attempt: 2
      })
      retryOrchestrator.recordFailedAttempt({
        agent_id: 'agent1',
        failure_type: 'reasoning_failure',
        gate: 2,
        gap: 'Attempt 3',
        attempt: 3
      })

      // Attempt 4 should escalate (budget exhausted)
      const decision = retryOrchestrator.decideRetry({
        agent_id: 'agent1',
        failure_type: 'reasoning_failure',
        gate: 2,
        gap: 'Attempt 4',
        attempt: 4
      })

      expect(decision.should_retry).toBe(false)
      expect(decision.should_escalate).toBe(true)
    })
  })
})
