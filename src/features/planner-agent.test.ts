import { describe, it, expect, beforeEach, vi } from 'vitest'
import { PlannerAgent } from './planner-agent.js'
import type { SECManager } from '../components/sec-manager.js'
import type { DependencyGraphManager } from '../components/dependency-graph-manager.js'
import type { RecursionGuard } from '../components/recursion-guard.js'
import type { EvalPipeline } from '../components/eval-pipeline.js'
import type { RetryOrchestrator } from '../components/retry-orchestrator.js'
import type { AgentStateManager } from '../components/agent-state-manager.js'
import type { HITLManager } from '../components/hitl-manager.js'
import type { ContextCompressor } from '../primitives/context-compressor.js'
import type { ExecutionMemoryStore } from '../primitives/execution-memory-store.js'
import type { MessageBus } from '../primitives/message-bus.js'
import type { TicketSystem } from '../primitives/ticket-system.js'
import type {
  ModelAdapter,
  PlannerConfig,
  RequirementMap,
  WriteResult
} from '../primitives/types.js'

describe('PlannerAgent (F-02)', () => {
  let planner: PlannerAgent
  let mockSECManager: SECManager
  let mockDependencyGraphManager: DependencyGraphManager
  let mockRecursionGuard: RecursionGuard
  let mockEvalPipeline: EvalPipeline
  let mockRetryOrchestrator: RetryOrchestrator
  let mockAgentStateManager: AgentStateManager
  let mockHITLManager: HITLManager
  let mockContextCompressor: ContextCompressor
  let mockExecutionMemoryStore: ExecutionMemoryStore
  let mockMessageBus: MessageBus
  let mockTicketSystem: TicketSystem
  let mockModelAdapter: ModelAdapter

  const baseConfig: PlannerConfig = {
    run_id: 'run-123',
    agent_id: 'planner-456',
    parent_scope: 'Build user authentication system',
    current_depth: 1,
    max_depth: 5,
    requirement_map: new Map([
      ['req-1', { id: 'req-1', description: 'User login', priority: 'high' as const, coverage_score: 0 }],
      ['req-2', { id: 'req-2', description: 'Password reset', priority: 'medium' as const, coverage_score: 0 }],
      ['req-3', { id: 'req-3', description: 'Session management', priority: 'high' as const, coverage_score: 0 }]
    ]),
    available_budget: 10000,
    max_retries: 2
  }

  beforeEach(() => {
    // Create mocks
    mockSECManager = {
      write: vi.fn(),
      read: vi.fn(),
      snapshot: vi.fn().mockReturnValue(new Map())
    } as any

    mockDependencyGraphManager = {
      addNode: vi.fn(),
      addEdge: vi.fn()
    } as any

    mockRecursionGuard = {
      shouldRecurse: vi.fn().mockReturnValue({ recurse: true, reason: null })
    } as any

    mockEvalPipeline = {
      evaluate: vi.fn().mockResolvedValue({ passed: true, scores: {} })
    } as any

    mockRetryOrchestrator = {
      shouldRetry: vi.fn()
    } as any

    mockAgentStateManager = {
      transition: vi.fn(),
      getState: vi.fn()
    } as any

    mockHITLManager = {
      checkCheckpoint: vi.fn().mockResolvedValue({ proceed: true })
    } as any

    mockContextCompressor = {
      compress: vi.fn()
    } as any

    mockExecutionMemoryStore = {
      get: vi.fn(),
      update: vi.fn()
    } as any

    mockMessageBus = {
      emit: vi.fn()
    } as any

    mockTicketSystem = {
      file: vi.fn()
    } as any

    mockModelAdapter = {
      call: vi.fn(),
      getContextWindowSize: vi.fn().mockReturnValue(128000),
      estimateTokens: vi.fn().mockReturnValue(100)
    } as any

    planner = new PlannerAgent(
      mockSECManager,
      mockDependencyGraphManager,
      mockRecursionGuard,
      mockEvalPipeline,
      mockRetryOrchestrator,
      mockAgentStateManager,
      mockHITLManager,
      mockContextCompressor,
      mockExecutionMemoryStore,
      mockMessageBus,
      mockTicketSystem,
      mockModelAdapter
    )
  })

  it('should decompose simple objective into MECE children with strategies', async () => {
    // Mock LLM response
    const llmResponse = JSON.stringify({
      decision: 'decompose',
      rationale: 'Auth system requires separate login, reset, and session components',
      plan: 'Decompose into 3 independent children covering all requirements',
      plan_cost_estimate: 5000,
      children: [
        {
          child_id: 'child-1',
          strategy: 'analyze',
          scope: 'Implement user login flow',
          covers_requirements: ['req-1'],
          output_spec: { type: 'code', schema: null, required_fields: [], max_tokens: 2000, max_normalization_bytes: 50000, normalization_mode: 'passthrough' },
          depends_on: []
        },
        {
          child_id: 'child-2',
          strategy: 'synthesize',
          scope: 'Implement password reset flow',
          covers_requirements: ['req-2'],
          output_spec: { type: 'code', schema: null, required_fields: [], max_tokens: 2000, max_normalization_bytes: 50000, normalization_mode: 'passthrough' },
          depends_on: []
        },
        {
          child_id: 'child-3',
          strategy: 'transform',
          scope: 'Implement session management',
          covers_requirements: ['req-3'],
          output_spec: { type: 'code', schema: null, required_fields: [], max_tokens: 2000, max_normalization_bytes: 50000, normalization_mode: 'passthrough' },
          depends_on: ['child-1']
        }
      ]
    })

    mockModelAdapter.call = vi.fn().mockResolvedValue(llmResponse)
    mockSECManager.write = vi.fn().mockReturnValue({ success: true, version_id: 1 } as WriteResult)

    const result = await planner.plan(baseConfig)

    expect(result.decision).toBe('decompose')
    expect(result.children).toHaveLength(3)
    expect(result.children[0].strategy).toBe('analyze')
    expect(result.children[1].strategy).toBe('synthesize')
    expect(result.children[2].strategy).toBe('transform')
    expect(result.plan_cost_estimate).toBe(5000)
    expect(mockSECManager.write).toHaveBeenCalled()
  })

  it('should retry decomposition on OCC conflict (max 2 cycles)', async () => {
    // First attempt: conflict
    const firstResponse = JSON.stringify({
      decision: 'decompose',
      rationale: 'First attempt',
      plan: 'First plan',
      plan_cost_estimate: 5000,
      children: [
        {
          child_id: 'child-1',
          strategy: 'analyze',
          scope: 'Child 1',
          covers_requirements: ['req-1', 'req-2', 'req-3'],
          output_spec: { type: 'text', schema: null, required_fields: [], max_tokens: 2000, max_normalization_bytes: 50000, normalization_mode: 'passthrough' },
          depends_on: []
        }
      ]
    })

    // Second attempt: success
    const secondResponse = JSON.stringify({
      decision: 'decompose',
      rationale: 'Adjusted for conflict',
      plan: 'Updated plan after conflict',
      plan_cost_estimate: 5500,
      children: [
        {
          child_id: 'child-1-v2',
          strategy: 'synthesize',
          scope: 'Adjusted Child 1',
          covers_requirements: ['req-1', 'req-2', 'req-3'],
          output_spec: { type: 'text', schema: null, required_fields: [], max_tokens: 2000, max_normalization_bytes: 50000, normalization_mode: 'passthrough' },
          depends_on: []
        }
      ]
    })

    mockModelAdapter.call = vi.fn()
      .mockResolvedValueOnce(firstResponse)
      .mockResolvedValueOnce(secondResponse)

    mockSECManager.write = vi.fn()
      .mockReturnValueOnce({
        success: false,
        conflict: { key: 'test-key', attempted_value: 'val1', current_value: 'val2', current_version_id: 1 }
      } as WriteResult)
      .mockReturnValueOnce({ success: true, version_id: 2 } as WriteResult)

    const result = await planner.plan(baseConfig)

    expect(result.decision).toBe('decompose')
    expect(result.rationale).toContain('conflict')
    expect(mockModelAdapter.call).toHaveBeenCalledTimes(2)
    expect(mockSECManager.write).toHaveBeenCalledTimes(2)
    expect(mockMessageBus.emit).toHaveBeenCalledWith(
      'run-123',
      'planner_occ_retry',
      expect.any(Object)
    )
  })

  it('should handle depth cap by returning execute_directly and filing warning ticket', async () => {
    const depthCapConfig = { ...baseConfig, current_depth: 5, max_depth: 5 }

    const result = await planner.plan(depthCapConfig)

    expect(result.decision).toBe('execute_directly')
    expect(result.children).toHaveLength(0)
    expect(mockTicketSystem.file).toHaveBeenCalledWith(
      'recursion_guard_triggered',
      expect.objectContaining({
        run_id: 'run-123',
        agent_id: 'planner-456'
      })
    )
    expect(mockMessageBus.emit).toHaveBeenCalledWith(
      'run-123',
      'planner_depth_cap_reached',
      expect.any(Object)
    )
  })

  it('should declare different strategies for different children', async () => {
    const llmResponse = JSON.stringify({
      decision: 'decompose',
      rationale: 'Multi-strategy decomposition',
      plan: 'Use different strategies for different aspects',
      plan_cost_estimate: 6000,
      children: [
        { child_id: 'c1', strategy: 'search', scope: 'Research auth patterns', covers_requirements: ['req-1'], output_spec: { type: 'text', schema: null, required_fields: [], max_tokens: 1000, max_normalization_bytes: 50000, normalization_mode: 'passthrough' }, depends_on: [] },
        { child_id: 'c2', strategy: 'synthesize', scope: 'Combine patterns', covers_requirements: ['req-2'], output_spec: { type: 'text', schema: null, required_fields: [], max_tokens: 1000, max_normalization_bytes: 50000, normalization_mode: 'passthrough' }, depends_on: ['c1'] },
        { child_id: 'c3', strategy: 'validate', scope: 'Validate implementation', covers_requirements: ['req-3'], output_spec: { type: 'json', schema: '{}', required_fields: ['valid'], max_tokens: 500, max_normalization_bytes: 50000, normalization_mode: 'strict' }, depends_on: ['c2'] }
      ]
    })

    mockModelAdapter.call = vi.fn().mockResolvedValue(llmResponse)
    mockSECManager.write = vi.fn().mockReturnValue({ success: true, version_id: 1 } as WriteResult)

    const result = await planner.plan(baseConfig)

    expect(result.children).toHaveLength(3)
    expect(result.children[0].strategy).toBe('search')
    expect(result.children[1].strategy).toBe('synthesize')
    expect(result.children[2].strategy).toBe('validate')
  })

  it('should emit plan_cost_estimate for every decomposition', async () => {
    const llmResponse = JSON.stringify({
      decision: 'decompose',
      rationale: 'Cost test',
      plan: 'Test cost estimation',
      plan_cost_estimate: 7500,
      children: [
        { child_id: 'c1', strategy: 'analyze', scope: 'Child', covers_requirements: ['req-1', 'req-2', 'req-3'], output_spec: { type: 'text', schema: null, required_fields: [], max_tokens: 1000, max_normalization_bytes: 50000, normalization_mode: 'passthrough' }, depends_on: [] }
      ]
    })

    mockModelAdapter.call = vi.fn().mockResolvedValue(llmResponse)
    mockSECManager.write = vi.fn().mockReturnValue({ success: true, version_id: 1 } as WriteResult)

    const result = await planner.plan(baseConfig)

    expect(result.plan_cost_estimate).toBe(7500)
    expect(typeof result.plan_cost_estimate).toBe('number')
    expect(result.plan_cost_estimate).toBeGreaterThan(0)
  })

  it('should validate MECE property of children', async () => {
    // Invalid: missing requirement coverage (not collectively exhaustive)
    const invalidResponse = JSON.stringify({
      decision: 'decompose',
      rationale: 'Invalid MECE',
      plan: 'Missing coverage',
      plan_cost_estimate: 3000,
      children: [
        {
          child_id: 'c1',
          strategy: 'analyze',
          scope: 'Partial coverage',
          covers_requirements: ['req-1'], // Missing req-2 and req-3
          output_spec: { type: 'text', schema: null, required_fields: [], max_tokens: 1000, max_normalization_bytes: 50000, normalization_mode: 'passthrough' },
          depends_on: []
        }
      ]
    })

    mockModelAdapter.call = vi.fn().mockResolvedValue(invalidResponse)
    mockSECManager.write = vi.fn().mockReturnValue({ success: true, version_id: 1 } as WriteResult)

    await expect(planner.plan(baseConfig)).rejects.toThrow('MECE')
  })
})
