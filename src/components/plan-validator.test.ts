import { describe, it, expect, beforeEach } from 'vitest'
import { PlanValidator } from './plan-validator.js'
import { DependencyGraphManager } from './dependency-graph-manager.js'
import { RequirementExtractor } from '../primitives/requirement-extractor.js'
import { ContractRegistry } from '../primitives/contract-registry.js'
import { MessageBus } from '../primitives/message-bus.js'
import { TicketSystem } from '../primitives/ticket-system.js'
import type {
  DependencyGraph,
  RequirementMap,
  AgentNode,
  PlanValidationResult,
  Contract
} from '../primitives/types.js'

describe('PlanValidator', () => {
  let validator: PlanValidator
  let dgm: DependencyGraphManager
  let extractor: RequirementExtractor
  let registry: ContractRegistry

  beforeEach(() => {
    const messageBus = new MessageBus()
    const ticketSystem = new TicketSystem(messageBus, { provider: 'InMemory' })
    dgm = new DependencyGraphManager(messageBus, ticketSystem)
    extractor = new RequirementExtractor()
    registry = new ContractRegistry()

    validator = new PlanValidator(dgm, extractor, registry)
  })

  describe('Constructor and Config', () => {
    it('should initialize with dependencies', () => {
      expect(validator).toBeDefined()
    })

    it('should accept partial config with defaults', () => {
      const customValidator = new PlanValidator(
        dgm,
        extractor,
        registry,
        { max_plan_cost: 500 }
      )
      expect(customValidator).toBeDefined()
    })
  })

  describe('AC1: All 6 checks run independently', () => {
    describe('Acyclicity Check (Fatal)', () => {
      it('should detect cycle and return fatal failure', () => {
        const graph: DependencyGraph = {
          run_id: 'run-1',
          nodes: ['A', 'B', 'C'],
          edges: [
            { from_node_id: 'A', to_node_id: 'B', edge_type: 'data', timeout_ms: null, on_timeout: null },
            { from_node_id: 'B', to_node_id: 'C', edge_type: 'data', timeout_ms: null, on_timeout: null },
            { from_node_id: 'C', to_node_id: 'A', edge_type: 'data', timeout_ms: null, on_timeout: null }
          ]
        }

        const requirementMap: RequirementMap = new Map()
        const agentNodes: AgentNode[] = []

        const result = validator.validate(graph, requirementMap, agentNodes, 0, 0)

        expect(result.valid).toBe(false)
        expect(result.retryable).toBe(false)
        expect(result.failures.length).toBeGreaterThan(0)

        const acyclicFailure = result.failures.find(f => f.check === 'acyclicity')
        expect(acyclicFailure).toBeDefined()
        expect(acyclicFailure?.severity).toBe('fatal')
        expect(acyclicFailure?.message).toContain('cycle')
      })

      it('should pass for acyclic graph', () => {
        const graph: DependencyGraph = {
          run_id: 'run-2',
          nodes: ['A', 'B', 'C'],
          edges: [
            { from_node_id: 'A', to_node_id: 'B', edge_type: 'data', timeout_ms: null, on_timeout: null },
            { from_node_id: 'B', to_node_id: 'C', edge_type: 'data', timeout_ms: null, on_timeout: null }
          ]
        }

        const requirementMap: RequirementMap = new Map()
        const agentNodes: AgentNode[] = []

        const result = validator.validate(graph, requirementMap, agentNodes, 0, 0)

        const acyclicFailure = result.failures.find(f => f.check === 'acyclicity')
        expect(acyclicFailure).toBeUndefined()
      })
    })

    describe('Orphan Detection (Fatal)', () => {
      it('should detect orphan node and return fatal failure', () => {
        const graph: DependencyGraph = {
          run_id: 'run-3',
          nodes: ['A', 'B', 'C', 'D'],
          edges: [
            { from_node_id: 'A', to_node_id: 'B', edge_type: 'data', timeout_ms: null, on_timeout: null },
            { from_node_id: 'B', to_node_id: 'C', edge_type: 'data', timeout_ms: null, on_timeout: null }
            // D is orphan - no path from A
          ]
        }

        const requirementMap: RequirementMap = new Map()
        const agentNodes: AgentNode[] = []

        const result = validator.validate(graph, requirementMap, agentNodes, 0, 0, 'A')

        expect(result.valid).toBe(false)
        expect(result.retryable).toBe(false)

        const orphanFailure = result.failures.find(f => f.check === 'orphan_detection')
        expect(orphanFailure).toBeDefined()
        expect(orphanFailure?.severity).toBe('fatal')
        expect(orphanFailure?.details.orphans).toContain('D')
      })

      it('should skip orphan check if no root_id provided', () => {
        const graph: DependencyGraph = {
          run_id: 'run-4',
          nodes: ['A', 'B', 'C', 'D'],
          edges: [
            { from_node_id: 'A', to_node_id: 'B', edge_type: 'data', timeout_ms: null, on_timeout: null }
          ]
        }

        const requirementMap: RequirementMap = new Map()
        const agentNodes: AgentNode[] = []

        // No root_id provided - should skip orphan check
        const result = validator.validate(graph, requirementMap, agentNodes, 0, 0)

        const orphanFailure = result.failures.find(f => f.check === 'orphan_detection')
        expect(orphanFailure).toBeUndefined()
      })
    })

    describe('Output Contract Satisfiability (Fatal)', () => {
      it('should detect missing contract and return fatal failure', () => {
        const graph: DependencyGraph = {
          run_id: 'run-5',
          nodes: ['A'],
          edges: []
        }

        const requirementMap: RequirementMap = new Map()
        const agentNodes: AgentNode[] = [
          {
            node_id: 'A',
            requirements_covered: [],
            agent_type: 'executor',
            output_spec: {
              type: 'json',
              schema: '{}',
              required_fields: [],
              max_tokens: null,
              max_normalization_bytes: 1000,
              normalization_mode: 'strict'
            }
          }
        ]

        // No contract registered for 'executor'
        const result = validator.validate(graph, requirementMap, agentNodes, 0, 0)

        expect(result.valid).toBe(false)
        expect(result.retryable).toBe(false)

        const contractFailure = result.failures.find(f => f.check === 'output_contract_satisfiability')
        expect(contractFailure).toBeDefined()
        expect(contractFailure?.severity).toBe('fatal')
        expect(contractFailure?.message).toContain('No contract found')
      })

      it('should pass if contract exists', () => {
        const graph: DependencyGraph = {
          run_id: 'run-6',
          nodes: ['A'],
          edges: []
        }

        const executorContract: Contract = {
          agent_type: 'executor',
          dimensions: [
            { dimension_id: 'correctness', weight: 1.0, is_binary: false, gate: 1 }
          ]
        }
        registry.register(executorContract)

        const requirementMap: RequirementMap = new Map()
        const agentNodes: AgentNode[] = [
          {
            node_id: 'A',
            requirements_covered: [],
            agent_type: 'executor',
            output_spec: {
              type: 'json',
              schema: '{}',
              required_fields: [],
              max_tokens: null,
              max_normalization_bytes: 1000,
              normalization_mode: 'strict'
            }
          }
        ]

        const result = validator.validate(graph, requirementMap, agentNodes, 0, 0)

        const contractFailure = result.failures.find(f => f.check === 'output_contract_satisfiability')
        expect(contractFailure).toBeUndefined()
      })
    })

    describe('Coverage Completeness (Fatal)', () => {
      it('should detect uncovered high-priority requirement and return fatal failure', () => {
        const graph: DependencyGraph = {
          run_id: 'run-7',
          nodes: ['A'],
          edges: []
        }

        const requirementMap: RequirementMap = new Map([
          ['req-1', { id: 'req-1', description: 'High priority req', priority: 'high', coverage_score: 0 }],
          ['req-2', { id: 'req-2', description: 'Low priority req', priority: 'low', coverage_score: 0 }]
        ])

        const agentNodes: AgentNode[] = [
          {
            node_id: 'A',
            requirements_covered: ['req-2']  // Only covers low-priority
          }
        ]

        const result = validator.validate(graph, requirementMap, agentNodes, 0, 0)

        expect(result.valid).toBe(false)
        expect(result.retryable).toBe(false)

        const coverageFailure = result.failures.find(f => f.check === 'coverage_completeness')
        expect(coverageFailure).toBeDefined()
        expect(coverageFailure?.severity).toBe('fatal')
        expect(coverageFailure?.details.uncovered_ids).toContain('req-1')
      })

      it('should pass if all requirements covered', () => {
        const graph: DependencyGraph = {
          run_id: 'run-8',
          nodes: ['A'],
          edges: []
        }

        const requirementMap: RequirementMap = new Map([
          ['req-1', { id: 'req-1', description: 'Requirement 1', priority: 'high', coverage_score: 0 }]
        ])

        const agentNodes: AgentNode[] = [
          {
            node_id: 'A',
            requirements_covered: ['req-1']
          }
        ]

        const result = validator.validate(graph, requirementMap, agentNodes, 0, 0)

        const coverageFailure = result.failures.find(f => f.check === 'coverage_completeness')
        expect(coverageFailure).toBeUndefined()
      })
    })

    describe('Cost Bounds (Fixable)', () => {
      it('should detect cost slightly exceeded and return fixable failure', () => {
        const graph: DependencyGraph = {
          run_id: 'run-9',
          nodes: [],
          edges: []
        }

        const requirementMap: RequirementMap = new Map()
        const agentNodes: AgentNode[] = []
        const planCost = 110  // 10% over default 100, within 20% tolerance

        const customValidator = new PlanValidator(
          dgm,
          extractor,
          registry,
          { max_plan_cost: 100, cost_tolerance: 1.2, max_depth: 5, allow_decomposable_depth: true }
        )

        const result = customValidator.validate(graph, requirementMap, agentNodes, planCost, 0)

        expect(result.valid).toBe(false)
        expect(result.retryable).toBe(true)  // Fixable

        const costFailure = result.failures.find(f => f.check === 'cost_bounds')
        expect(costFailure).toBeDefined()
        expect(costFailure?.severity).toBe('fixable')
      })

      it('should detect cost far exceeded and return fatal failure', () => {
        const graph: DependencyGraph = {
          run_id: 'run-10',
          nodes: [],
          edges: []
        }

        const requirementMap: RequirementMap = new Map()
        const agentNodes: AgentNode[] = []
        const planCost = 200  // 100% over, exceeds tolerance

        const customValidator = new PlanValidator(
          dgm,
          extractor,
          registry,
          { max_plan_cost: 100, cost_tolerance: 1.2, max_depth: 5, allow_decomposable_depth: true }
        )

        const result = customValidator.validate(graph, requirementMap, agentNodes, planCost, 0)

        expect(result.valid).toBe(false)
        expect(result.retryable).toBe(false)  // Fatal

        const costFailure = result.failures.find(f => f.check === 'cost_bounds')
        expect(costFailure).toBeDefined()
        expect(costFailure?.severity).toBe('fatal')
      })

      it('should pass if cost within bounds', () => {
        const graph: DependencyGraph = {
          run_id: 'run-11',
          nodes: [],
          edges: []
        }

        const requirementMap: RequirementMap = new Map()
        const agentNodes: AgentNode[] = []
        const planCost = 90

        const result = validator.validate(graph, requirementMap, agentNodes, planCost, 0)

        const costFailure = result.failures.find(f => f.check === 'cost_bounds')
        expect(costFailure).toBeUndefined()
      })
    })

    describe('Depth Cap (Fixable)', () => {
      it('should detect depth exceeded and return fixable failure if decomposable', () => {
        const graph: DependencyGraph = {
          run_id: 'run-12',
          nodes: [],
          edges: []
        }

        const requirementMap: RequirementMap = new Map()
        const agentNodes: AgentNode[] = []
        const depthHint = 6  // Exceeds default max 5

        const result = validator.validate(graph, requirementMap, agentNodes, 0, depthHint)

        expect(result.valid).toBe(false)
        expect(result.retryable).toBe(true)  // Fixable if decomposable

        const depthFailure = result.failures.find(f => f.check === 'depth_cap')
        expect(depthFailure).toBeDefined()
        expect(depthFailure?.severity).toBe('fixable')
      })

      it('should detect depth exceeded and return fatal failure if not decomposable', () => {
        const graph: DependencyGraph = {
          run_id: 'run-13',
          nodes: [],
          edges: []
        }

        const requirementMap: RequirementMap = new Map()
        const agentNodes: AgentNode[] = []
        const depthHint = 6

        const customValidator = new PlanValidator(
          dgm,
          extractor,
          registry,
          { max_plan_cost: 1000, cost_tolerance: 1.2, max_depth: 5, allow_decomposable_depth: false }
        )

        const result = customValidator.validate(graph, requirementMap, agentNodes, 0, depthHint)

        expect(result.valid).toBe(false)
        expect(result.retryable).toBe(false)  // Fatal if not decomposable

        const depthFailure = result.failures.find(f => f.check === 'depth_cap')
        expect(depthFailure).toBeDefined()
        expect(depthFailure?.severity).toBe('fatal')
      })

      it('should pass if depth within cap', () => {
        const graph: DependencyGraph = {
          run_id: 'run-14',
          nodes: [],
          edges: []
        }

        const requirementMap: RequirementMap = new Map()
        const agentNodes: AgentNode[] = []
        const depthHint = 3

        const result = validator.validate(graph, requirementMap, agentNodes, 0, depthHint)

        const depthFailure = result.failures.find(f => f.check === 'depth_cap')
        expect(depthFailure).toBeUndefined()
      })
    })
  })

  describe('AC2 & AC3: Fatal vs Fixable classification', () => {
    it('should return retryable=false for fatal failures', () => {
      const graph: DependencyGraph = {
        run_id: 'run-15',
        nodes: ['A', 'B'],
        edges: [
          { from_node_id: 'A', to_node_id: 'B', edge_type: 'data', timeout_ms: null, on_timeout: null },
          { from_node_id: 'B', to_node_id: 'A', edge_type: 'data', timeout_ms: null, on_timeout: null }
        ]
      }

      const result = validator.validate(graph, new Map(), [], 0, 0)

      expect(result.valid).toBe(false)
      expect(result.retryable).toBe(false)  // Has fatal failure
    })

    it('should return retryable=true for only fixable failures', () => {
      const graph: DependencyGraph = {
        run_id: 'run-16',
        nodes: [],
        edges: []
      }

      const customValidator = new PlanValidator(
        dgm,
        extractor,
        registry,
        { max_plan_cost: 100, cost_tolerance: 1.2, max_depth: 5, allow_decomposable_depth: true }
      )

      const result = customValidator.validate(graph, new Map(), [], 110, 6)

      expect(result.valid).toBe(false)
      expect(result.retryable).toBe(true)  // Only fixable failures
      expect(result.failures.every(f => f.severity === 'fixable')).toBe(true)
    })

    it('should return retryable=false for mixed fatal+fixable failures', () => {
      const graph: DependencyGraph = {
        run_id: 'run-17',
        nodes: ['A', 'B'],
        edges: [
          { from_node_id: 'A', to_node_id: 'B', edge_type: 'data', timeout_ms: null, on_timeout: null },
          { from_node_id: 'B', to_node_id: 'A', edge_type: 'data', timeout_ms: null, on_timeout: null }
        ]
      }

      const customValidator = new PlanValidator(
        dgm,
        extractor,
        registry,
        { max_plan_cost: 100, cost_tolerance: 1.2, max_depth: 5, allow_decomposable_depth: true }
      )

      const result = customValidator.validate(graph, new Map(), [], 110, 0)

      expect(result.valid).toBe(false)
      expect(result.retryable).toBe(false)  // Fatal wins over fixable
      expect(result.failures.some(f => f.severity === 'fatal')).toBe(true)
      expect(result.failures.some(f => f.severity === 'fixable')).toBe(true)
    })
  })

  describe('Edge Cases', () => {
    it('should pass for empty valid graph', () => {
      const graph: DependencyGraph = {
        run_id: 'run-18',
        nodes: [],
        edges: []
      }

      const result = validator.validate(graph, new Map(), [], 0, 0)

      expect(result.valid).toBe(true)
      expect(result.failures).toEqual([])
      expect(result.retryable).toBe(true)  // No failures, so trivially all fixable
    })

    it('should pass with no requirements', () => {
      const graph: DependencyGraph = {
        run_id: 'run-19',
        nodes: ['A'],
        edges: []
      }

      const requirementMap: RequirementMap = new Map()
      const agentNodes: AgentNode[] = [{ node_id: 'A', requirements_covered: [] }]

      const result = validator.validate(graph, requirementMap, agentNodes, 0, 0)

      const coverageFailure = result.failures.find(f => f.check === 'coverage_completeness')
      expect(coverageFailure).toBeUndefined()
    })

    it('should skip contract check for nodes without output_spec', () => {
      const graph: DependencyGraph = {
        run_id: 'run-20',
        nodes: ['A'],
        edges: []
      }

      const agentNodes: AgentNode[] = [
        { node_id: 'A', requirements_covered: [] }  // No output_spec
      ]

      const result = validator.validate(graph, new Map(), agentNodes, 0, 0)

      const contractFailure = result.failures.find(f => f.check === 'output_contract_satisfiability')
      expect(contractFailure).toBeUndefined()
    })
  })
})
