import { describe, it, expect, beforeEach, vi } from 'vitest'
import { AdaptiveDepthController } from './adaptive-depth-controller.js'
import type { RecursionGuard } from '../components/recursion-guard.js'
import type { RequirementExtractor } from '../primitives/requirement-extractor.js'
import type { BudgetLedger } from '../primitives/budget-ledger.js'
import type { EmbeddingEngine } from '../primitives/embedding-engine.js'
import type { MessageBus } from '../primitives/message-bus.js'
import type { TicketSystem } from '../primitives/ticket-system.js'
import type {
  RequirementMap,
  RequirementRecord,
  AgentNode,
  BudgetState,
  BudgetLimits
} from '../primitives/types.js'

describe('AdaptiveDepthController - F-09', () => {
  let controller: AdaptiveDepthController
  let mockRecursionGuard: RecursionGuard
  let mockRequirementExtractor: RequirementExtractor
  let mockBudgetLedger: BudgetLedger
  let mockEmbeddingEngine: EmbeddingEngine
  let mockMessageBus: MessageBus
  let mockTicketSystem: TicketSystem

  beforeEach(() => {
    // Mock dependencies
    mockRecursionGuard = {
      check: vi.fn()
    } as any

    mockRequirementExtractor = {
      checkCoverage: vi.fn()
    } as any

    mockBudgetLedger = {
      check: vi.fn()
    } as any

    mockEmbeddingEngine = {
      embed: vi.fn(),
      cosineSimilarity: vi.fn()
    } as any

    mockMessageBus = {
      emit: vi.fn()
    } as any

    mockTicketSystem = {
      createTicket: vi.fn()
    } as any

    // Create controller with default config
    controller = new AdaptiveDepthController(
      mockRecursionGuard,
      mockRequirementExtractor,
      mockBudgetLedger,
      mockEmbeddingEngine,
      mockMessageBus,
      mockTicketSystem
    )
  })

  describe('Configuration', () => {
    it('uses default config when not provided', () => {
      expect(controller).toBeDefined()
    })

    it('accepts partial config overrides', () => {
      const customController = new AdaptiveDepthController(
        mockRecursionGuard,
        mockRequirementExtractor,
        mockBudgetLedger,
        mockEmbeddingEngine,
        mockMessageBus,
        mockTicketSystem,
        {
          expansion_cost_reserve: 0.3,
          max_depth: 15
        }
      )

      expect(customController).toBeDefined()
    })
  })

  describe('Expansion Budget Checks', () => {
    it('suppresses expansion when remaining budget < expansion_cost_reserve (20%)', () => {
      const run_id = 'test-run-1'
      const requirement_map: RequirementMap = new Map([
        ['req1', { id: 'req1', description: 'Test', priority: 'high', coverage_score: 0 }]
      ])
      const agent_nodes: AgentNode[] = []

      // Budget state: 15% remaining (below 20% threshold)
      const budget_state: BudgetState = {
        remaining: { tokens: 1500, calls: 15, wall_ms: 15000 },
        exceeded: false,
        warning_threshold_hit: true
      }

      vi.mocked(mockBudgetLedger.check).mockReturnValue(budget_state)
      vi.mocked(mockRequirementExtractor.checkCoverage).mockReturnValue({
        covered_count: 0,
        uncovered_count: 1,
        covered_ids: [],
        uncovered_ids: ['req1']
      })

      const result = controller.checkExpansion(run_id, requirement_map, agent_nodes, 5, {
        tokens: 10000,
        calls: 100,
        wall_ms: 100000,
        warning_threshold: 0.8
      })

      expect(result.should_expand).toBe(false)
      expect(result.suppressed).toBe(true)
      expect(result.suppression_reason).toContain('budget')
      expect(result.coverage_gap_detected).toBe(true)
    })

    it('allows expansion when remaining budget >= expansion_cost_reserve', () => {
      const run_id = 'test-run-2'
      const requirement_map: RequirementMap = new Map([
        ['req1', { id: 'req1', description: 'Test', priority: 'high', coverage_score: 0 }]
      ])
      const agent_nodes: AgentNode[] = []

      // Budget state: 30% remaining (above 20% threshold)
      const budget_state: BudgetState = {
        remaining: { tokens: 3000, calls: 30, wall_ms: 30000 },
        exceeded: false,
        warning_threshold_hit: false
      }

      vi.mocked(mockBudgetLedger.check).mockReturnValue(budget_state)
      vi.mocked(mockRequirementExtractor.checkCoverage).mockReturnValue({
        covered_count: 0,
        uncovered_count: 1,
        covered_ids: [],
        uncovered_ids: ['req1']
      })

      const result = controller.checkExpansion(run_id, requirement_map, agent_nodes, 5, {
        tokens: 10000,
        calls: 100,
        wall_ms: 100000,
        warning_threshold: 0.8
      })

      expect(result.should_expand).toBe(true)
      expect(result.suppressed).toBe(false)
      expect(result.coverage_gap_detected).toBe(true)
    })

    it('logs depth_expansion_suppressed event when suppressed', () => {
      const run_id = 'test-run-3'
      const requirement_map: RequirementMap = new Map([
        ['req1', { id: 'req1', description: 'Test', priority: 'high', coverage_score: 0 }]
      ])
      const agent_nodes: AgentNode[] = []

      const budget_state: BudgetState = {
        remaining: { tokens: 1500, calls: 15, wall_ms: 15000 },
        exceeded: false,
        warning_threshold_hit: true
      }

      vi.mocked(mockBudgetLedger.check).mockReturnValue(budget_state)
      vi.mocked(mockRequirementExtractor.checkCoverage).mockReturnValue({
        covered_count: 0,
        uncovered_count: 1,
        covered_ids: [],
        uncovered_ids: ['req1']
      })

      controller.checkExpansion(run_id, requirement_map, agent_nodes, 5, {
        tokens: 10000,
        calls: 100,
        wall_ms: 100000,
        warning_threshold: 0.8
      })

      expect(mockMessageBus.emit).toHaveBeenCalledWith(
        run_id,
        'depth_expansion_suppressed',
        expect.objectContaining({
          reason: expect.stringContaining('budget'),
          current_depth: 5,
          coverage_gap: true
        })
      )
    })

    it('creates minor ticket when expansion suppressed', () => {
      const run_id = 'test-run-4'
      const requirement_map: RequirementMap = new Map([
        ['req1', { id: 'req1', description: 'Test', priority: 'high', coverage_score: 0 }]
      ])
      const agent_nodes: AgentNode[] = []

      const budget_state: BudgetState = {
        remaining: { tokens: 1500, calls: 15, wall_ms: 15000 },
        exceeded: false,
        warning_threshold_hit: true
      }

      vi.mocked(mockBudgetLedger.check).mockReturnValue(budget_state)
      vi.mocked(mockRequirementExtractor.checkCoverage).mockReturnValue({
        covered_count: 0,
        uncovered_count: 1,
        covered_ids: [],
        uncovered_ids: ['req1']
      })

      controller.checkExpansion(run_id, requirement_map, agent_nodes, 5, {
        tokens: 10000,
        calls: 100,
        wall_ms: 100000,
        warning_threshold: 0.8
      })

      expect(mockTicketSystem.createTicket).toHaveBeenCalledWith(
        run_id,
        expect.objectContaining({
          severity: 'minor',
          category: 'depth_expansion_suppressed'
        })
      )
    })
  })

  describe('Hard Depth Cap', () => {
    it('enforces max_depth cap regardless of budget and coverage', () => {
      const run_id = 'test-run-5'
      const requirement_map: RequirementMap = new Map([
        ['req1', { id: 'req1', description: 'Test', priority: 'high', coverage_score: 0 }]
      ])
      const agent_nodes: AgentNode[] = []

      // Budget is good (50% remaining)
      const budget_state: BudgetState = {
        remaining: { tokens: 5000, calls: 50, wall_ms: 50000 },
        exceeded: false,
        warning_threshold_hit: false
      }

      vi.mocked(mockBudgetLedger.check).mockReturnValue(budget_state)
      vi.mocked(mockRequirementExtractor.checkCoverage).mockReturnValue({
        covered_count: 0,
        uncovered_count: 1,
        covered_ids: [],
        uncovered_ids: ['req1']
      })

      // Current depth = max_depth (10)
      const result = controller.checkExpansion(run_id, requirement_map, agent_nodes, 10, {
        tokens: 10000,
        calls: 100,
        wall_ms: 100000,
        warning_threshold: 0.8
      })

      expect(result.should_expand).toBe(false)
      expect(result.suppressed).toBe(true)
      expect(result.suppression_reason).toContain('max_depth')
    })

    it('logs max_depth_reached event', () => {
      const run_id = 'test-run-6'
      const requirement_map: RequirementMap = new Map([
        ['req1', { id: 'req1', description: 'Test', priority: 'high', coverage_score: 0 }]
      ])
      const agent_nodes: AgentNode[] = []

      const budget_state: BudgetState = {
        remaining: { tokens: 5000, calls: 50, wall_ms: 50000 },
        exceeded: false,
        warning_threshold_hit: false
      }

      vi.mocked(mockBudgetLedger.check).mockReturnValue(budget_state)
      vi.mocked(mockRequirementExtractor.checkCoverage).mockReturnValue({
        covered_count: 0,
        uncovered_count: 1,
        covered_ids: [],
        uncovered_ids: ['req1']
      })

      controller.checkExpansion(run_id, requirement_map, agent_nodes, 10, {
        tokens: 10000,
        calls: 100,
        wall_ms: 100000,
        warning_threshold: 0.8
      })

      expect(mockMessageBus.emit).toHaveBeenCalledWith(
        run_id,
        'max_depth_reached',
        expect.objectContaining({
          current_depth: 10,
          max_depth: 10
        })
      )
    })
  })

  describe('Coverage Gap Detection', () => {
    it('detects uncovered requirement after Executor COMPLETE', () => {
      const run_id = 'test-run-7'
      const requirement_map: RequirementMap = new Map([
        ['req1', { id: 'req1', description: 'Test 1', priority: 'high', coverage_score: 1.0 }],
        ['req2', { id: 'req2', description: 'Test 2', priority: 'medium', coverage_score: 0 }]
      ])
      const agent_nodes: AgentNode[] = [
        { node_id: 'node1', requirements_covered: ['req1'] }
      ]

      const budget_state: BudgetState = {
        remaining: { tokens: 5000, calls: 50, wall_ms: 50000 },
        exceeded: false,
        warning_threshold_hit: false
      }

      vi.mocked(mockBudgetLedger.check).mockReturnValue(budget_state)
      vi.mocked(mockRequirementExtractor.checkCoverage).mockReturnValue({
        covered_count: 1,
        uncovered_count: 1,
        covered_ids: ['req1'],
        uncovered_ids: ['req2']
      })

      const result = controller.checkExpansion(run_id, requirement_map, agent_nodes, 5, {
        tokens: 10000,
        calls: 100,
        wall_ms: 100000,
        warning_threshold: 0.8
      })

      expect(result.coverage_gap_detected).toBe(true)
      expect(result.should_expand).toBe(true)
    })

    it('does not detect coverage gap when all requirements covered', () => {
      const run_id = 'test-run-8'
      const requirement_map: RequirementMap = new Map([
        ['req1', { id: 'req1', description: 'Test 1', priority: 'high', coverage_score: 1.0 }]
      ])
      const agent_nodes: AgentNode[] = [
        { node_id: 'node1', requirements_covered: ['req1'] }
      ]

      const budget_state: BudgetState = {
        remaining: { tokens: 5000, calls: 50, wall_ms: 50000 },
        exceeded: false,
        warning_threshold_hit: false
      }

      vi.mocked(mockBudgetLedger.check).mockReturnValue(budget_state)
      vi.mocked(mockRequirementExtractor.checkCoverage).mockReturnValue({
        covered_count: 1,
        uncovered_count: 0,
        covered_ids: ['req1'],
        uncovered_ids: []
      })

      const result = controller.checkExpansion(run_id, requirement_map, agent_nodes, 5, {
        tokens: 10000,
        calls: 100,
        wall_ms: 100000,
        warning_threshold: 0.8
      })

      expect(result.coverage_gap_detected).toBe(false)
      expect(result.should_expand).toBe(false)
    })
  })

  describe('Low-Entropy Shrinkage', () => {
    it('detects near-identical children via embedding similarity >= threshold', () => {
      const run_id = 'test-run-9'
      const agent_id = 'agent-9'
      const children = ['task A', 'task A with minor variation']

      vi.mocked(mockEmbeddingEngine.embed).mockReturnValueOnce([1, 0, 0])
      vi.mocked(mockEmbeddingEngine.embed).mockReturnValueOnce([0.98, 0.02, 0])
      vi.mocked(mockEmbeddingEngine.cosineSimilarity).mockReturnValue(0.96)

      const result = controller.checkShrinkage(run_id, agent_id, children, 5)

      expect(result.low_entropy_detected).toBe(true)
      expect(result.should_shrink).toBe(true)
      expect(result.similarity_score).toBeGreaterThanOrEqual(0.95)
    })

    it('allows recursion when entropy sufficient (similarity < threshold)', () => {
      const run_id = 'test-run-10'
      const agent_id = 'agent-10'
      const children = ['task A', 'task B completely different']

      vi.mocked(mockEmbeddingEngine.embed).mockReturnValueOnce([1, 0, 0])
      vi.mocked(mockEmbeddingEngine.embed).mockReturnValueOnce([0, 1, 0])
      vi.mocked(mockEmbeddingEngine.cosineSimilarity).mockReturnValue(0.3)

      const result = controller.checkShrinkage(run_id, agent_id, children, 5)

      expect(result.low_entropy_detected).toBe(false)
      expect(result.should_shrink).toBe(false)
    })

    it('logs low_entropy_shrinkage_triggered event when detected', () => {
      const run_id = 'test-run-11'
      const agent_id = 'agent-11'
      const children = ['task A', 'task A with minor variation']

      vi.mocked(mockEmbeddingEngine.embed).mockReturnValueOnce([1, 0, 0])
      vi.mocked(mockEmbeddingEngine.embed).mockReturnValueOnce([0.98, 0.02, 0])
      vi.mocked(mockEmbeddingEngine.cosineSimilarity).mockReturnValue(0.96)

      controller.checkShrinkage(run_id, agent_id, children, 5)

      expect(mockMessageBus.emit).toHaveBeenCalledWith(
        run_id,
        'low_entropy_shrinkage_triggered',
        expect.objectContaining({
          agent_id: 'agent-11',
          similarity_score: 0.96,
          threshold: 0.95
        })
      )
    })

    it('handles single child (no shrinkage needed)', () => {
      const run_id = 'test-run-12'
      const agent_id = 'agent-12'
      const children = ['task A']

      const result = controller.checkShrinkage(run_id, agent_id, children, 5)

      expect(result.low_entropy_detected).toBe(false)
      expect(result.should_shrink).toBe(false)
    })

    it('handles empty children array', () => {
      const run_id = 'test-run-13'
      const agent_id = 'agent-13'
      const children: string[] = []

      const result = controller.checkShrinkage(run_id, agent_id, children, 5)

      expect(result.low_entropy_detected).toBe(false)
      expect(result.should_shrink).toBe(false)
    })
  })
})
