import { describe, it, expect, beforeEach, vi } from 'vitest'
import { DependencyGraphManager } from './dependency-graph-manager.js'
import { MessageBus } from '../primitives/message-bus.js'
import { TicketSystem } from '../primitives/ticket-system.js'
import type {
  DependencyGraph,
  DependencyEdge,
  ValidationResult,
  TopologicalOrder
} from '../primitives/types.js'

describe('DependencyGraphManager', () => {
  let manager: DependencyGraphManager
  let messageBus: MessageBus
  let ticketSystem: TicketSystem

  beforeEach(() => {
    messageBus = new MessageBus()
    ticketSystem = new TicketSystem(messageBus, { provider: 'InMemory' })
    manager = new DependencyGraphManager(messageBus, ticketSystem)
  })

  describe('Constructor and Config', () => {
    it('should initialize with dependencies', () => {
      expect(manager).toBeDefined()
    })

    it('should accept partial config with defaults', () => {
      const customManager = new DependencyGraphManager(
        messageBus,
        ticketSystem,
        { enable_ttl_monitoring: false }
      )
      expect(customManager).toBeDefined()
    })
  })

  describe('Cycle Detection (AC1)', () => {
    it('should detect simple cycle A→B→C→A', () => {
      const graph: DependencyGraph = {
        run_id: 'run-1',
        nodes: ['A', 'B', 'C'],
        edges: [
          { from_node_id: 'A', to_node_id: 'B', edge_type: 'data', timeout_ms: null, on_timeout: null },
          { from_node_id: 'B', to_node_id: 'C', edge_type: 'data', timeout_ms: null, on_timeout: null },
          { from_node_id: 'C', to_node_id: 'A', edge_type: 'data', timeout_ms: null, on_timeout: null }
        ]
      }

      const cycles = manager.detectCycles(graph)
      expect(cycles.length).toBeGreaterThan(0)
      expect(cycles[0]).toContain('A')
      expect(cycles[0]).toContain('B')
      expect(cycles[0]).toContain('C')
    })

    it('should return empty array for acyclic graph', () => {
      const graph: DependencyGraph = {
        run_id: 'run-2',
        nodes: ['A', 'B', 'C'],
        edges: [
          { from_node_id: 'A', to_node_id: 'B', edge_type: 'data', timeout_ms: null, on_timeout: null },
          { from_node_id: 'B', to_node_id: 'C', edge_type: 'data', timeout_ms: null, on_timeout: null }
        ]
      }

      const cycles = manager.detectCycles(graph)
      expect(cycles).toEqual([])
    })

    it('should detect multiple cycles', () => {
      const graph: DependencyGraph = {
        run_id: 'run-3',
        nodes: ['A', 'B', 'C', 'D', 'E'],
        edges: [
          { from_node_id: 'A', to_node_id: 'B', edge_type: 'data', timeout_ms: null, on_timeout: null },
          { from_node_id: 'B', to_node_id: 'A', edge_type: 'data', timeout_ms: null, on_timeout: null },
          { from_node_id: 'C', to_node_id: 'D', edge_type: 'data', timeout_ms: null, on_timeout: null },
          { from_node_id: 'D', to_node_id: 'E', edge_type: 'data', timeout_ms: null, on_timeout: null },
          { from_node_id: 'E', to_node_id: 'C', edge_type: 'data', timeout_ms: null, on_timeout: null }
        ]
      }

      const cycles = manager.detectCycles(graph)
      expect(cycles.length).toBeGreaterThanOrEqual(2)
    })

    it('should emit cycle_detected event', () => {
      const eventSpy = vi.fn()
      const runId = 'run-4'
      messageBus.subscribe(runId, 'dependency_graph_cycle_detected', eventSpy)

      const graph: DependencyGraph = {
        run_id: runId,
        nodes: ['A', 'B'],
        edges: [
          { from_node_id: 'A', to_node_id: 'B', edge_type: 'data', timeout_ms: null, on_timeout: null },
          { from_node_id: 'B', to_node_id: 'A', edge_type: 'data', timeout_ms: null, on_timeout: null }
        ]
      }

      manager.validate(graph)
      expect(eventSpy).toHaveBeenCalled()
    })

    it('should file MAJOR ticket on cycle detection', () => {
      const graph: DependencyGraph = {
        run_id: 'run-5',
        nodes: ['A', 'B'],
        edges: [
          { from_node_id: 'A', to_node_id: 'B', edge_type: 'data', timeout_ms: null, on_timeout: null },
          { from_node_id: 'B', to_node_id: 'A', edge_type: 'data', timeout_ms: null, on_timeout: null }
        ]
      }

      manager.validate(graph)
      const tickets = ticketSystem.list('run-5')
      expect(tickets.some(t => t.severity === 'MAJOR')).toBe(true)
      expect(tickets.some(t => t.ticket_type === 'infrastructure_failure')).toBe(true)
    })
  })

  describe('Orphan Detection (AC2)', () => {
    it('should detect disconnected node as orphan', () => {
      const graph: DependencyGraph = {
        run_id: 'run-6',
        nodes: ['root', 'A', 'B', 'orphan'],
        edges: [
          { from_node_id: 'root', to_node_id: 'A', edge_type: 'data', timeout_ms: null, on_timeout: null },
          { from_node_id: 'root', to_node_id: 'B', edge_type: 'data', timeout_ms: null, on_timeout: null }
        ]
      }

      const orphans = manager.detectOrphans(graph, 'root')
      expect(orphans).toContain('orphan')
      expect(orphans.length).toBe(1)
    })

    it('should return empty array for fully connected graph', () => {
      const graph: DependencyGraph = {
        run_id: 'run-7',
        nodes: ['root', 'A', 'B'],
        edges: [
          { from_node_id: 'root', to_node_id: 'A', edge_type: 'data', timeout_ms: null, on_timeout: null },
          { from_node_id: 'root', to_node_id: 'B', edge_type: 'data', timeout_ms: null, on_timeout: null }
        ]
      }

      const orphans = manager.detectOrphans(graph, 'root')
      expect(orphans).toEqual([])
    })

    it('should emit orphan_detected event', () => {
      const eventSpy = vi.fn()
      const runId = 'run-8'
      messageBus.subscribe(runId, 'dependency_graph_orphan_detected', eventSpy)

      const graph: DependencyGraph = {
        run_id: runId,
        nodes: ['root', 'orphan'],
        edges: []
      }

      manager.validate(graph, 'root')
      expect(eventSpy).toHaveBeenCalled()
    })

    it('should file MAJOR ticket on orphan detection', () => {
      const graph: DependencyGraph = {
        run_id: 'run-9',
        nodes: ['root', 'orphan'],
        edges: []
      }

      manager.validate(graph, 'root')
      const tickets = ticketSystem.list('run-9')
      expect(tickets.some(t => t.severity === 'MAJOR')).toBe(true)
      expect(tickets.some(t => t.ticket_type === 'infrastructure_failure')).toBe(true)
    })
  })

  describe('Topological Sort (AC6, AC7)', () => {
    it('should produce correct order for linear graph A→B→C', () => {
      const graph: DependencyGraph = {
        run_id: 'run-10',
        nodes: ['A', 'B', 'C'],
        edges: [
          { from_node_id: 'A', to_node_id: 'B', edge_type: 'data', timeout_ms: null, on_timeout: null },
          { from_node_id: 'B', to_node_id: 'C', edge_type: 'data', timeout_ms: null, on_timeout: null }
        ]
      }

      const result = manager.topologicalSort(graph)
      expect(result.order).toEqual(['A', 'B', 'C'])
    })

    it('should produce valid order for complex DAG', () => {
      const graph: DependencyGraph = {
        run_id: 'run-11',
        nodes: ['A', 'B', 'C', 'D', 'E'],
        edges: [
          { from_node_id: 'A', to_node_id: 'B', edge_type: 'data', timeout_ms: null, on_timeout: null },
          { from_node_id: 'A', to_node_id: 'C', edge_type: 'data', timeout_ms: null, on_timeout: null },
          { from_node_id: 'B', to_node_id: 'D', edge_type: 'data', timeout_ms: null, on_timeout: null },
          { from_node_id: 'C', to_node_id: 'D', edge_type: 'data', timeout_ms: null, on_timeout: null },
          { from_node_id: 'D', to_node_id: 'E', edge_type: 'data', timeout_ms: null, on_timeout: null }
        ]
      }

      const result = manager.topologicalSort(graph)
      const aIndex = result.order.indexOf('A')
      const bIndex = result.order.indexOf('B')
      const cIndex = result.order.indexOf('C')
      const dIndex = result.order.indexOf('D')
      const eIndex = result.order.indexOf('E')

      // Verify ordering constraints
      expect(aIndex).toBeLessThan(bIndex)
      expect(aIndex).toBeLessThan(cIndex)
      expect(bIndex).toBeLessThan(dIndex)
      expect(cIndex).toBeLessThan(dIndex)
      expect(dIndex).toBeLessThan(eIndex)
    })

    it('should compute correct depth levels', () => {
      const graph: DependencyGraph = {
        run_id: 'run-12',
        nodes: ['A', 'B', 'C'],
        edges: [
          { from_node_id: 'A', to_node_id: 'B', edge_type: 'data', timeout_ms: null, on_timeout: null },
          { from_node_id: 'B', to_node_id: 'C', edge_type: 'data', timeout_ms: null, on_timeout: null }
        ]
      }

      const result = manager.topologicalSort(graph)
      expect(result.levels.get('A')).toBe(0)
      expect(result.levels.get('B')).toBe(1)
      expect(result.levels.get('C')).toBe(2)
    })

    it('should produce leaves-first cancellation order', () => {
      const graph: DependencyGraph = {
        run_id: 'run-13',
        nodes: ['A', 'B', 'C'],
        edges: [
          { from_node_id: 'A', to_node_id: 'B', edge_type: 'data', timeout_ms: null, on_timeout: null },
          { from_node_id: 'B', to_node_id: 'C', edge_type: 'data', timeout_ms: null, on_timeout: null }
        ]
      }

      const cancellationOrder = manager.getCancellationOrder(graph)
      expect(cancellationOrder).toEqual(['C', 'B', 'A'])
    })

    it('should emit cancellation_order_computed event', () => {
      const eventSpy = vi.fn()
      const runId = 'run-14'
      messageBus.subscribe(runId, 'dependency_graph_cancellation_order_computed', eventSpy)

      const graph: DependencyGraph = {
        run_id: runId,
        nodes: ['A', 'B'],
        edges: [
          { from_node_id: 'A', to_node_id: 'B', edge_type: 'data', timeout_ms: null, on_timeout: null }
        ]
      }

      manager.getCancellationOrder(graph)
      expect(eventSpy).toHaveBeenCalled()
    })
  })

  describe('Validation Orchestration', () => {
    it('should return valid=true for valid graph', () => {
      const graph: DependencyGraph = {
        run_id: 'run-15',
        nodes: ['root', 'A', 'B'],
        edges: [
          { from_node_id: 'root', to_node_id: 'A', edge_type: 'data', timeout_ms: null, on_timeout: null },
          { from_node_id: 'root', to_node_id: 'B', edge_type: 'data', timeout_ms: null, on_timeout: null }
        ]
      }

      const result = manager.validate(graph, 'root')
      expect(result.valid).toBe(true)
      expect(result.cycles).toEqual([])
      expect(result.orphans).toEqual([])
      expect(result.errors).toEqual([])
    })

    it('should return valid=false with cycles', () => {
      const graph: DependencyGraph = {
        run_id: 'run-16',
        nodes: ['A', 'B'],
        edges: [
          { from_node_id: 'A', to_node_id: 'B', edge_type: 'data', timeout_ms: null, on_timeout: null },
          { from_node_id: 'B', to_node_id: 'A', edge_type: 'data', timeout_ms: null, on_timeout: null }
        ]
      }

      const result = manager.validate(graph)
      expect(result.valid).toBe(false)
      expect(result.cycles.length).toBeGreaterThan(0)
      expect(result.errors.length).toBeGreaterThan(0)
    })

    it('should return valid=false with orphans', () => {
      const graph: DependencyGraph = {
        run_id: 'run-17',
        nodes: ['root', 'orphan'],
        edges: []
      }

      const result = manager.validate(graph, 'root')
      expect(result.valid).toBe(false)
      expect(result.orphans).toContain('orphan')
      expect(result.errors.length).toBeGreaterThan(0)
    })
  })

  describe('TTL Management (AC3, AC4, AC5)', () => {
    it('should detect TTL expiry after timeout_ms', () => {
      const edge: DependencyEdge = {
        from_node_id: 'A',
        to_node_id: 'B',
        edge_type: 'data',
        timeout_ms: 1000,
        on_timeout: 'fail'
      }

      const startTime = Date.now()
      const currentTime = startTime + 1001

      const expired = manager.checkTTLExpiry(edge, startTime, currentTime)
      expect(expired).toBe(true)
    })

    it('should not detect expiry before timeout_ms', () => {
      const edge: DependencyEdge = {
        from_node_id: 'A',
        to_node_id: 'B',
        edge_type: 'data',
        timeout_ms: 1000,
        on_timeout: 'fail'
      }

      const startTime = Date.now()
      const currentTime = startTime + 500

      const expired = manager.checkTTLExpiry(edge, startTime, currentTime)
      expect(expired).toBe(false)
    })

    it('should handle on_timeout="proceed_degraded" with fallback_payload', () => {
      const edge: DependencyEdge = {
        from_node_id: 'A',
        to_node_id: 'B',
        edge_type: 'data',
        timeout_ms: 1000,
        on_timeout: 'proceed_degraded',
        fallback_payload: { status: 'degraded', data: null }
      }

      const result = manager.fireTTLTimeout(edge)
      expect(result.behavior).toBe('proceed_degraded')
      expect(result.fallback_payload).toEqual({ status: 'degraded', data: null })
    })

    it('should emit ttl_expired event', () => {
      const eventSpy = vi.fn()
      const runId = 'run-ttl-1'
      messageBus.subscribe(runId, 'dependency_edge_ttl_expired', eventSpy)

      const edge: DependencyEdge = {
        from_node_id: 'A',
        to_node_id: 'B',
        edge_type: 'data',
        timeout_ms: 1000,
        on_timeout: 'fail'
      }

      manager.fireTTLTimeout(edge, runId)
      expect(eventSpy).toHaveBeenCalled()
    })

    it('should emit fallback_injected event for proceed_degraded', () => {
      const eventSpy = vi.fn()
      const runId = 'run-ttl-2'
      messageBus.subscribe(runId, 'dependency_edge_fallback_injected', eventSpy)

      const edge: DependencyEdge = {
        from_node_id: 'A',
        to_node_id: 'B',
        edge_type: 'data',
        timeout_ms: 1000,
        on_timeout: 'proceed_degraded',
        fallback_payload: { data: 'fallback' }
      }

      manager.fireTTLTimeout(edge, runId)
      expect(eventSpy).toHaveBeenCalled()
    })

    it('should preserve output_contract in output edges', () => {
      const outputSpec = {
        type: 'json' as const,
        schema: '{"type": "object"}',
        required_fields: ['result'],
        max_tokens: 1000,
        max_normalization_bytes: 10000,
        normalization_mode: 'strict' as const
      }

      const edge: DependencyEdge = {
        from_node_id: 'A',
        to_node_id: 'B',
        edge_type: 'output',
        timeout_ms: null,
        on_timeout: null,
        output_contract: outputSpec
      }

      expect(edge.output_contract).toEqual(outputSpec)
    })
  })

  describe('Edge Cases', () => {
    it('should handle empty graph', () => {
      const graph: DependencyGraph = {
        run_id: 'run-18',
        nodes: [],
        edges: []
      }

      const result = manager.validate(graph)
      expect(result.valid).toBe(true)
    })

    it('should handle single node graph', () => {
      const graph: DependencyGraph = {
        run_id: 'run-19',
        nodes: ['A'],
        edges: []
      }

      const result = manager.validate(graph, 'A')
      expect(result.valid).toBe(true)
    })

    it('should handle self-loop as cycle', () => {
      const graph: DependencyGraph = {
        run_id: 'run-20',
        nodes: ['A'],
        edges: [
          { from_node_id: 'A', to_node_id: 'A', edge_type: 'data', timeout_ms: null, on_timeout: null }
        ]
      }

      const cycles = manager.detectCycles(graph)
      expect(cycles.length).toBeGreaterThan(0)
    })
  })
})
