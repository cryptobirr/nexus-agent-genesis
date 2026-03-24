import { describe, it, expect, beforeEach, vi } from 'vitest'
import { EarlyTerminationController } from './early-termination-controller.js'
import type { RequirementExtractor } from '../primitives/requirement-extractor.js'
import type { DependencyGraphManager } from '../components/dependency-graph-manager.js'
import type { AgentStateManager } from '../components/agent-state-manager.js'
import type { MessageBus } from '../primitives/message-bus.js'
import type {
  RequirementMap,
  AgentNode,
  DependencyGraph,
  DependencyEdge,
  CoverageResult
} from '../primitives/types.js'

describe('EarlyTerminationController', () => {
  let controller: EarlyTerminationController
  let mockRequirementExtractor: RequirementExtractor
  let mockDependencyGraphManager: DependencyGraphManager
  let mockAgentStateManager: AgentStateManager
  let mockMessageBus: MessageBus

  beforeEach(() => {
    // Mock RequirementExtractor
    mockRequirementExtractor = {
      checkCoverage: vi.fn(),
      computeConfidence: vi.fn()
    } as any

    // Mock DependencyGraphManager
    mockDependencyGraphManager = {
      getCancellationOrder: vi.fn(),
      fireTTLTimeout: vi.fn()
    } as any

    // Mock AgentStateManager
    mockAgentStateManager = {
      getState: vi.fn(),
      transition: vi.fn()
    } as any

    // Mock MessageBus
    mockMessageBus = {
      emit: vi.fn()
    } as any

    controller = new EarlyTerminationController(
      mockRequirementExtractor,
      mockDependencyGraphManager,
      mockAgentStateManager,
      mockMessageBus
    )
  })

  describe('check', () => {
    it('should terminate and cancel QUEUED agents when all requirements covered and confidence >= threshold', () => {
      const requirementMap: RequirementMap = new Map([
        ['req1', { id: 'req1', description: 'Requirement 1', priority: 'medium', coverage_score: 1.0 }],
        ['req2', { id: 'req2', description: 'Requirement 2', priority: 'low', coverage_score: 1.0 }]
      ])

      const agentNodes: AgentNode[] = [
        { node_id: 'agent1', requirements_covered: ['req1'], agent_type: 'executor' },
        { node_id: 'agent2', requirements_covered: ['req2'], agent_type: 'executor' }
      ]

      const dependencyGraph: DependencyGraph = {
        run_id: 'run123',
        nodes: ['agent1', 'agent2', 'agent3', 'agent4'],
        edges: []
      }

      const coverageResult: CoverageResult = {
        covered_count: 2,
        uncovered_count: 0,
        covered_ids: ['req1', 'req2'],
        uncovered_ids: []
      }

      // Setup mocks
      vi.mocked(mockRequirementExtractor.checkCoverage).mockReturnValue(coverageResult)
      vi.mocked(mockRequirementExtractor.computeConfidence).mockReturnValue(0.9)
      vi.mocked(mockDependencyGraphManager.getCancellationOrder).mockReturnValue(['agent3', 'agent4'])
      vi.mocked(mockAgentStateManager.getState).mockImplementation((agentId) => {
        if (agentId === 'agent3' || agentId === 'agent4') return 'QUEUED'
        return 'COMPLETE'
      })
      vi.mocked(mockAgentStateManager.transition).mockReturnValue({ success: true, current_state: 'CANCELLED' })

      const result = controller.check('run123', requirementMap, agentNodes, dependencyGraph, 0.8)

      expect(result.terminated).toBe(true)
      expect(result.cancelled_agent_ids).toEqual(['agent3', 'agent4'])
      expect(result.coverage_state).toEqual({
        covered_count: 2,
        uncovered_count: 0,
        confidence: 0.9
      })

      // Verify cancellation
      expect(mockAgentStateManager.transition).toHaveBeenCalledTimes(2)
      expect(mockAgentStateManager.transition).toHaveBeenCalledWith(
        { agent_id: 'agent3', run_id: 'run123', reason: 'Early termination: coverage threshold met' },
        'CANCELLED'
      )

      // Verify event emitted
      expect(mockMessageBus.emit).toHaveBeenCalledWith('run123', 'early_termination_triggered', {
        coverage_state: {
          covered_count: 2,
          uncovered_count: 0,
          confidence: 0.9
        },
        cancelled_agent_ids: ['agent3', 'agent4']
      })
    })

    it('should NOT terminate when high-priority requirement is uncovered (guard)', () => {
      const requirementMap: RequirementMap = new Map([
        ['req1', { id: 'req1', description: 'High priority req', priority: 'high', coverage_score: 0.0 }],
        ['req2', { id: 'req2', description: 'Low priority req', priority: 'low', coverage_score: 1.0 }]
      ])

      const agentNodes: AgentNode[] = [
        { node_id: 'agent1', requirements_covered: ['req2'], agent_type: 'executor' }
      ]

      const dependencyGraph: DependencyGraph = {
        run_id: 'run123',
        nodes: ['agent1', 'agent2'],
        edges: []
      }

      const coverageResult: CoverageResult = {
        covered_count: 1,
        uncovered_count: 1,
        covered_ids: ['req2'],
        uncovered_ids: ['req1']
      }

      // Setup mocks - computeConfidence returns 0 when high-priority requirement uncovered
      vi.mocked(mockRequirementExtractor.checkCoverage).mockReturnValue(coverageResult)
      vi.mocked(mockRequirementExtractor.computeConfidence).mockReturnValue(0) // Guard blocks

      const result = controller.check('run123', requirementMap, agentNodes, dependencyGraph, 0.8)

      expect(result.terminated).toBe(false)
      expect(result.cancelled_agent_ids).toEqual([])
      expect(mockAgentStateManager.transition).not.toHaveBeenCalled()
      expect(mockMessageBus.emit).not.toHaveBeenCalled()
    })

    it('should cancel agents in topological order (leaves first)', () => {
      const requirementMap: RequirementMap = new Map([
        ['req1', { id: 'req1', description: 'Requirement 1', priority: 'medium', coverage_score: 1.0 }]
      ])

      const agentNodes: AgentNode[] = [
        { node_id: 'completed', requirements_covered: ['req1'], agent_type: 'executor' }
      ]

      const dependencyGraph: DependencyGraph = {
        run_id: 'run123',
        nodes: ['completed', 'agentA', 'agentB', 'agentC'],
        edges: [
          { from_node_id: 'agentA', to_node_id: 'agentB', edge_type: 'data', timeout_ms: null, on_timeout: null },
          { from_node_id: 'agentB', to_node_id: 'agentC', edge_type: 'data', timeout_ms: null, on_timeout: null }
        ]
      }

      const coverageResult: CoverageResult = {
        covered_count: 1,
        uncovered_count: 0,
        covered_ids: ['req1'],
        uncovered_ids: []
      }

      // Setup mocks - getCancellationOrder returns leaves first (reverse topo)
      vi.mocked(mockRequirementExtractor.checkCoverage).mockReturnValue(coverageResult)
      vi.mocked(mockRequirementExtractor.computeConfidence).mockReturnValue(0.9)
      vi.mocked(mockDependencyGraphManager.getCancellationOrder).mockReturnValue(['agentA', 'agentB', 'agentC'])
      vi.mocked(mockAgentStateManager.getState).mockReturnValue('QUEUED')
      vi.mocked(mockAgentStateManager.transition).mockReturnValue({ success: true, current_state: 'CANCELLED' })

      const result = controller.check('run123', requirementMap, agentNodes, dependencyGraph, 0.8)

      expect(result.cancelled_agent_ids).toEqual(['agentA', 'agentB', 'agentC'])

      // Verify cancellation order matches topological order (leaves first)
      const transitionCalls = vi.mocked(mockAgentStateManager.transition).mock.calls
      expect(transitionCalls[0][0].agent_id).toBe('agentA')
      expect(transitionCalls[1][0].agent_id).toBe('agentB')
      expect(transitionCalls[2][0].agent_id).toBe('agentC')
    })

    it('should allow GENERATING agents to complete (not cancel them)', () => {
      const requirementMap: RequirementMap = new Map([
        ['req1', { id: 'req1', description: 'Requirement 1', priority: 'medium', coverage_score: 1.0 }]
      ])

      const agentNodes: AgentNode[] = [
        { node_id: 'completed', requirements_covered: ['req1'], agent_type: 'executor' }
      ]

      const dependencyGraph: DependencyGraph = {
        run_id: 'run123',
        nodes: ['completed', 'queued1', 'generating', 'gate1_eval'],
        edges: []
      }

      const coverageResult: CoverageResult = {
        covered_count: 1,
        uncovered_count: 0,
        covered_ids: ['req1'],
        uncovered_ids: []
      }

      // Setup mocks
      vi.mocked(mockRequirementExtractor.checkCoverage).mockReturnValue(coverageResult)
      vi.mocked(mockRequirementExtractor.computeConfidence).mockReturnValue(0.9)
      vi.mocked(mockDependencyGraphManager.getCancellationOrder).mockReturnValue(['queued1', 'generating', 'gate1_eval'])
      vi.mocked(mockAgentStateManager.getState).mockImplementation((agentId) => {
        if (agentId === 'queued1') return 'QUEUED'
        if (agentId === 'generating') return 'GENERATING'
        if (agentId === 'gate1_eval') return 'GATE1_EVALUATING'
        return 'COMPLETE'
      })
      vi.mocked(mockAgentStateManager.transition).mockReturnValue({ success: true, current_state: 'CANCELLED' })

      const result = controller.check('run123', requirementMap, agentNodes, dependencyGraph, 0.8)

      // Only QUEUED agent should be cancelled
      expect(result.cancelled_agent_ids).toEqual(['queued1'])
      expect(mockAgentStateManager.transition).toHaveBeenCalledTimes(1)
      expect(mockAgentStateManager.transition).toHaveBeenCalledWith(
        { agent_id: 'queued1', run_id: 'run123', reason: 'Early termination: coverage threshold met' },
        'CANCELLED'
      )
    })

    it('should fire on_timeout on outbound edges of cancelled agents', () => {
      const requirementMap: RequirementMap = new Map([
        ['req1', { id: 'req1', description: 'Requirement 1', priority: 'medium', coverage_score: 1.0 }]
      ])

      const agentNodes: AgentNode[] = [
        { node_id: 'completed', requirements_covered: ['req1'], agent_type: 'executor' }
      ]

      const edge1: DependencyEdge = {
        from_node_id: 'queuedA',
        to_node_id: 'dependentB',
        edge_type: 'data',
        timeout_ms: 5000,
        on_timeout: 'fail'
      }

      const edge2: DependencyEdge = {
        from_node_id: 'queuedA',
        to_node_id: 'dependentC',
        edge_type: 'control',
        timeout_ms: null,
        on_timeout: 'proceed_degraded',
        fallback_payload: { default: 'value' }
      }

      const dependencyGraph: DependencyGraph = {
        run_id: 'run123',
        nodes: ['completed', 'queuedA', 'dependentB', 'dependentC'],
        edges: [edge1, edge2]
      }

      const coverageResult: CoverageResult = {
        covered_count: 1,
        uncovered_count: 0,
        covered_ids: ['req1'],
        uncovered_ids: []
      }

      // Setup mocks
      vi.mocked(mockRequirementExtractor.checkCoverage).mockReturnValue(coverageResult)
      vi.mocked(mockRequirementExtractor.computeConfidence).mockReturnValue(0.9)
      vi.mocked(mockDependencyGraphManager.getCancellationOrder).mockReturnValue(['queuedA'])
      vi.mocked(mockAgentStateManager.getState).mockReturnValue('QUEUED')
      vi.mocked(mockAgentStateManager.transition).mockReturnValue({ success: true, current_state: 'CANCELLED' })
      vi.mocked(mockDependencyGraphManager.fireTTLTimeout).mockReturnValue({ behavior: 'fail' })

      const result = controller.check('run123', requirementMap, agentNodes, dependencyGraph, 0.8)

      expect(result.cancelled_agent_ids).toEqual(['queuedA'])

      // Verify fireTTLTimeout called for each outbound edge
      expect(mockDependencyGraphManager.fireTTLTimeout).toHaveBeenCalledTimes(2)
      expect(mockDependencyGraphManager.fireTTLTimeout).toHaveBeenCalledWith(edge1, 'run123')
      expect(mockDependencyGraphManager.fireTTLTimeout).toHaveBeenCalledWith(edge2, 'run123')
    })

    it('should NOT terminate when confidence is below threshold', () => {
      const requirementMap: RequirementMap = new Map([
        ['req1', { id: 'req1', description: 'Requirement 1', priority: 'medium', coverage_score: 0.5 }],
        ['req2', { id: 'req2', description: 'Requirement 2', priority: 'low', coverage_score: 0.5 }]
      ])

      const agentNodes: AgentNode[] = [
        { node_id: 'agent1', requirements_covered: ['req1'], agent_type: 'executor' }
      ]

      const dependencyGraph: DependencyGraph = {
        run_id: 'run123',
        nodes: ['agent1', 'agent2'],
        edges: []
      }

      const coverageResult: CoverageResult = {
        covered_count: 0,
        uncovered_count: 2,
        covered_ids: [],
        uncovered_ids: ['req1', 'req2']
      }

      // Setup mocks - confidence below threshold
      vi.mocked(mockRequirementExtractor.checkCoverage).mockReturnValue(coverageResult)
      vi.mocked(mockRequirementExtractor.computeConfidence).mockReturnValue(0.5) // Below 0.8 threshold

      const result = controller.check('run123', requirementMap, agentNodes, dependencyGraph, 0.8)

      expect(result.terminated).toBe(false)
      expect(result.cancelled_agent_ids).toEqual([])
      expect(mockAgentStateManager.transition).not.toHaveBeenCalled()
      expect(mockMessageBus.emit).not.toHaveBeenCalled()
    })

    it('should include coverage state in event when termination triggered', () => {
      const requirementMap: RequirementMap = new Map([
        ['req1', { id: 'req1', description: 'Requirement 1', priority: 'medium', coverage_score: 1.0 }]
      ])

      const agentNodes: AgentNode[] = [
        { node_id: 'completed', requirements_covered: ['req1'], agent_type: 'executor' }
      ]

      const dependencyGraph: DependencyGraph = {
        run_id: 'run123',
        nodes: ['completed', 'queued'],
        edges: []
      }

      const coverageResult: CoverageResult = {
        covered_count: 1,
        uncovered_count: 0,
        covered_ids: ['req1'],
        uncovered_ids: []
      }

      // Setup mocks
      vi.mocked(mockRequirementExtractor.checkCoverage).mockReturnValue(coverageResult)
      vi.mocked(mockRequirementExtractor.computeConfidence).mockReturnValue(1.0)
      vi.mocked(mockDependencyGraphManager.getCancellationOrder).mockReturnValue(['queued'])
      vi.mocked(mockAgentStateManager.getState).mockReturnValue('QUEUED')
      vi.mocked(mockAgentStateManager.transition).mockReturnValue({ success: true, current_state: 'CANCELLED' })

      const result = controller.check('run123', requirementMap, agentNodes, dependencyGraph, 0.8)

      expect(result.coverage_state).toEqual({
        covered_count: 1,
        uncovered_count: 0,
        confidence: 1.0
      })

      expect(mockMessageBus.emit).toHaveBeenCalledWith('run123', 'early_termination_triggered', {
        coverage_state: {
          covered_count: 1,
          uncovered_count: 0,
          confidence: 1.0
        },
        cancelled_agent_ids: ['queued']
      })
    })
  })
})
