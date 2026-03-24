import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ExecutionHarness } from './execution-harness.js'
import type { AgentStateManager } from '../components/agent-state-manager.js'
import type { DependencyGraphManager } from '../components/dependency-graph-manager.js'
import type { KillSwitchController } from '../features/kill-switch-controller.js'
import type { MessageBus } from '../primitives/message-bus.js'
import type { TicketSystem } from '../primitives/ticket-system.js'
import type { DependencyGraph, AgentState } from '../primitives/types.js'

describe('ExecutionHarness', () => {
  let harness: ExecutionHarness
  let mockStateManager: AgentStateManager
  let mockDepGraph: DependencyGraphManager
  let mockKillSwitch: KillSwitchController
  let mockBus: MessageBus
  let mockTickets: TicketSystem

  beforeEach(() => {
    // Mock AgentStateManager
    mockStateManager = {
      transition: vi.fn().mockResolvedValue({ success: true }),
      getState: vi.fn().mockReturnValue('QUEUED' as AgentState),
      initializeAgent: vi.fn()
    } as any

    // Mock DependencyGraphManager
    mockDepGraph = {
      getTopologicalOrder: vi.fn().mockReturnValue({
        order: ['agent1', 'agent2', 'agent3'],
        critical_path: ['agent1']
      }),
      getDependencies: vi.fn().mockReturnValue([]),
      areDependenciesSatisfied: vi.fn().mockReturnValue(true)
    } as any

    // Mock KillSwitchController
    mockKillSwitch = {
      abort: vi.fn()
    } as any

    // Mock MessageBus
    mockBus = {
      emit: vi.fn()
    } as any

    // Mock TicketSystem
    mockTickets = {
      fileTicket: vi.fn()
    } as any

    harness = new ExecutionHarness(
      mockStateManager,
      mockDepGraph,
      mockKillSwitch,
      mockBus,
      mockTickets,
      {
        parallelism_policy: { max_concurrent_agents: 2 },
        max_queued_agents: 4,
        latency_sla_policy: {
          budgets: { executor: 5000, planner: 3000, router: 1000 },
          on_violation: 'escalate'
        },
        run_wall_clock_sla_ms: 60000
      }
    )
  })

  describe('Parallelism Control', () => {
    it('should spawn concurrent siblings immediately up to max_concurrent_agents', async () => {
      const graph: DependencyGraph = {
        run_id: 'run1',
        nodes: new Map([
          ['agent1', { node_id: 'agent1', agent_type: 'executor', requirements_covered: [] }],
          ['agent2', { node_id: 'agent2', agent_type: 'executor', requirements_covered: [] }]
        ]),
        edges: []
      }

      mockDepGraph.getDependencies = vi.fn().mockReturnValue([])

      await harness.spawnAgent('run1', 'agent1', 'executor', graph)
      await harness.spawnAgent('run1', 'agent2', 'executor', graph)

      expect(mockStateManager.transition).toHaveBeenCalledTimes(2)
      expect(harness.getActiveCount('run1')).toBe(2)
    })

    it('should queue agents beyond max_concurrent_agents', async () => {
      const graph: DependencyGraph = {
        run_id: 'run1',
        nodes: new Map([
          ['agent1', { node_id: 'agent1', agent_type: 'executor', requirements_covered: [] }],
          ['agent2', { node_id: 'agent2', agent_type: 'executor', requirements_covered: [] }],
          ['agent3', { node_id: 'agent3', agent_type: 'executor', requirements_covered: [] }]
        ]),
        edges: []
      }

      mockDepGraph.getDependencies = vi.fn().mockReturnValue([])

      await harness.spawnAgent('run1', 'agent1', 'executor', graph)
      await harness.spawnAgent('run1', 'agent2', 'executor', graph)
      await harness.spawnAgent('run1', 'agent3', 'executor', graph)

      expect(mockStateManager.transition).toHaveBeenCalledTimes(2)
      expect(harness.getActiveCount('run1')).toBe(2)
      expect(harness.getQueuedCount('run1')).toBe(1)
    })

    it('should dequeue next agent when one completes', async () => {
      const graph: DependencyGraph = {
        run_id: 'run1',
        nodes: new Map([
          ['agent1', { node_id: 'agent1', agent_type: 'executor', requirements_covered: [] }],
          ['agent2', { node_id: 'agent2', agent_type: 'executor', requirements_covered: [] }],
          ['agent3', { node_id: 'agent3', agent_type: 'executor', requirements_covered: [] }]
        ]),
        edges: []
      }

      mockDepGraph.getDependencies = vi.fn().mockReturnValue([])

      await harness.spawnAgent('run1', 'agent1', 'executor', graph)
      await harness.spawnAgent('run1', 'agent2', 'executor', graph)
      await harness.spawnAgent('run1', 'agent3', 'executor', graph)

      expect(harness.getQueuedCount('run1')).toBe(1)

      await harness.onAgentComplete('run1', 'agent1')

      expect(harness.getActiveCount('run1')).toBe(2)
      expect(harness.getQueuedCount('run1')).toBe(0)
      expect(mockStateManager.transition).toHaveBeenCalledTimes(3)
    })

    it('should prioritize critical path agents', async () => {
      const graph: DependencyGraph = {
        run_id: 'run1',
        nodes: new Map([
          ['agent1', { node_id: 'agent1', agent_type: 'executor', requirements_covered: [] }],
          ['agent2', { node_id: 'agent2', agent_type: 'executor', requirements_covered: [] }],
          ['critical1', { node_id: 'critical1', agent_type: 'executor', requirements_covered: [] }]
        ]),
        edges: []
      }

      mockDepGraph.getTopologicalOrder = vi.fn().mockReturnValue({
        order: ['agent1', 'agent2', 'critical1'],
        critical_path: ['critical1']
      })
      mockDepGraph.getDependencies = vi.fn().mockReturnValue([])

      await harness.spawnAgent('run1', 'agent1', 'executor', graph)
      await harness.spawnAgent('run1', 'agent2', 'executor', graph)
      await harness.spawnAgent('run1', 'critical1', 'executor', graph)

      await harness.onAgentComplete('run1', 'agent1')

      const transitionCalls = (mockStateManager.transition as any).mock.calls
      const thirdCall = transitionCalls[2]
      expect(thirdCall[1]).toBe('critical1')
    })
  })

  describe('Backpressure', () => {
    it('should hold Planner in PRECHECKING when queue exceeds max_queued_agents', async () => {
      const graph: DependencyGraph = {
        run_id: 'run1',
        nodes: new Map([
          ['agent1', { node_id: 'agent1', agent_type: 'executor', requirements_covered: [] }],
          ['agent2', { node_id: 'agent2', agent_type: 'executor', requirements_covered: [] }],
          ['agent3', { node_id: 'agent3', agent_type: 'executor', requirements_covered: [] }],
          ['agent4', { node_id: 'agent4', agent_type: 'executor', requirements_covered: [] }],
          ['agent5', { node_id: 'agent5', agent_type: 'executor', requirements_covered: [] }],
          ['planner1', { node_id: 'planner1', agent_type: 'planner', requirements_covered: [] }]
        ]),
        edges: []
      }

      mockDepGraph.getDependencies = vi.fn().mockReturnValue([])

      // Fill queue: max_concurrent=2, max_queued=4, so 2 active + 4 queued = 6 total
      await harness.spawnAgent('run1', 'agent1', 'executor', graph)
      await harness.spawnAgent('run1', 'agent2', 'executor', graph)
      await harness.spawnAgent('run1', 'agent3', 'executor', graph)
      await harness.spawnAgent('run1', 'agent4', 'executor', graph)
      await harness.spawnAgent('run1', 'agent5', 'executor', graph)
      await harness.spawnAgent('run1', 'agent6', 'executor', graph)

      expect(harness.getQueuedCount('run1')).toBe(4)

      // Try to spawn planner - should be held
      const canSpawnPlanner = harness.canSpawnPlanner('run1')
      expect(canSpawnPlanner).toBe(false)
      expect(mockBus.emit).toHaveBeenCalledWith('run1', 'backpressure_triggered', expect.any(Object))
    })

    it('should resume Planner when queue drops below threshold', async () => {
      const graph: DependencyGraph = {
        run_id: 'run1',
        nodes: new Map([
          ['agent1', { node_id: 'agent1', agent_type: 'executor', requirements_covered: [] }],
          ['agent2', { node_id: 'agent2', agent_type: 'executor', requirements_covered: [] }],
          ['agent3', { node_id: 'agent3', agent_type: 'executor', requirements_covered: [] }]
        ]),
        edges: []
      }

      mockDepGraph.getDependencies = vi.fn().mockReturnValue([])

      await harness.spawnAgent('run1', 'agent1', 'executor', graph)
      await harness.spawnAgent('run1', 'agent2', 'executor', graph)
      await harness.spawnAgent('run1', 'agent3', 'executor', graph)

      await harness.onAgentComplete('run1', 'agent1')

      const canSpawnPlanner = harness.canSpawnPlanner('run1')
      expect(canSpawnPlanner).toBe(true)
    })
  })

  describe('Dependency Scheduling', () => {
    it('should wait for dependencies before spawning', async () => {
      const graph: DependencyGraph = {
        run_id: 'run1',
        nodes: new Map([
          ['agent1', { node_id: 'agent1', agent_type: 'executor', requirements_covered: [] }],
          ['agent2', { node_id: 'agent2', agent_type: 'executor', requirements_covered: [] }]
        ]),
        edges: [
          { from: 'agent1', to: 'agent2', edge_type: 'output' }
        ]
      }

      mockDepGraph.getDependencies = vi.fn()
        .mockReturnValueOnce([])
        .mockReturnValueOnce(['agent1'])

      mockDepGraph.areDependenciesSatisfied = vi.fn()
        .mockReturnValueOnce(true)
        .mockReturnValueOnce(false)

      await harness.spawnAgent('run1', 'agent1', 'executor', graph)
      await harness.spawnAgent('run1', 'agent2', 'executor', graph)

      expect(mockStateManager.transition).toHaveBeenCalledTimes(1)
      expect(harness.getActiveCount('run1')).toBe(1)
      expect(harness.getQueuedCount('run1')).toBe(1)
    })

    it('should spawn dependent agent when prerequisites complete', async () => {
      const graph: DependencyGraph = {
        run_id: 'run1',
        nodes: new Map([
          ['agent1', { node_id: 'agent1', agent_type: 'executor', requirements_covered: [] }],
          ['agent2', { node_id: 'agent2', agent_type: 'executor', requirements_covered: [] }]
        ]),
        edges: [
          { from: 'agent1', to: 'agent2', edge_type: 'output' }
        ]
      }

      mockDepGraph.getDependencies = vi.fn()
        .mockReturnValueOnce([])
        .mockReturnValueOnce(['agent1'])
        .mockReturnValueOnce(['agent1'])

      mockDepGraph.areDependenciesSatisfied = vi.fn()
        .mockReturnValueOnce(true)
        .mockReturnValueOnce(false)
        .mockReturnValueOnce(true)

      await harness.spawnAgent('run1', 'agent1', 'executor', graph)
      await harness.spawnAgent('run1', 'agent2', 'executor', graph)

      expect(mockStateManager.transition).toHaveBeenCalledTimes(1)

      await harness.onAgentComplete('run1', 'agent1')

      expect(mockStateManager.transition).toHaveBeenCalledTimes(2)
    })
  })

  describe('Latency SLA', () => {
    it('should track agent start time', async () => {
      const graph: DependencyGraph = {
        run_id: 'run1',
        nodes: new Map([
          ['agent1', { node_id: 'agent1', agent_type: 'executor', requirements_covered: [] }]
        ]),
        edges: []
      }

      mockDepGraph.getDependencies = vi.fn().mockReturnValue([])

      const startTime = Date.now()
      await harness.spawnAgent('run1', 'agent1', 'executor', graph)

      const agentStartTime = harness.getAgentStartTime('run1', 'agent1')
      expect(agentStartTime).toBeGreaterThanOrEqual(startTime)
    })

    it('should escalate agent on latency SLA violation (on_violation: escalate)', async () => {
      const graph: DependencyGraph = {
        run_id: 'run1',
        nodes: new Map([
          ['agent1', { node_id: 'agent1', agent_type: 'executor', requirements_covered: [] }]
        ]),
        edges: []
      }

      mockDepGraph.getDependencies = vi.fn().mockReturnValue([])

      await harness.spawnAgent('run1', 'agent1', 'executor', graph)

      // Manually set start time to past to simulate timeout
      harness.setAgentStartTime('run1', 'agent1', Date.now() - 10000)

      await harness.checkLatencySLA('run1', 'agent1', 'executor')

      expect(mockStateManager.transition).toHaveBeenCalledWith('run1', 'agent1', 'ESCALATED', expect.any(Object))
      expect(mockBus.emit).toHaveBeenCalledWith('run1', 'latency_sla_violation', expect.any(Object))
    })

    it('should degrade agent on latency SLA violation (on_violation: degrade)', async () => {
      harness = new ExecutionHarness(
        mockStateManager,
        mockDepGraph,
        mockKillSwitch,
        mockBus,
        mockTickets,
        {
          parallelism_policy: { max_concurrent_agents: 2 },
          max_queued_agents: 4,
          latency_sla_policy: {
            budgets: { executor: 5000, planner: 3000, router: 1000 },
            on_violation: 'degrade'
          },
          run_wall_clock_sla_ms: 60000
        }
      )

      const graph: DependencyGraph = {
        run_id: 'run1',
        nodes: new Map([
          ['agent1', { node_id: 'agent1', agent_type: 'executor', requirements_covered: [] }]
        ]),
        edges: []
      }

      mockDepGraph.getDependencies = vi.fn().mockReturnValue([])

      await harness.spawnAgent('run1', 'agent1', 'executor', graph)
      harness.setAgentStartTime('run1', 'agent1', Date.now() - 10000)

      await harness.checkLatencySLA('run1', 'agent1', 'executor')

      expect(mockStateManager.transition).toHaveBeenCalledWith('run1', 'agent1', 'ESCALATED', expect.objectContaining({
        degraded: true
      }))
    })
  })

  describe('Run Wall Clock SLA', () => {
    it('should track run start time', () => {
      const startTime = Date.now()
      harness.startRun('run1')

      const runStartTime = harness.getRunStartTime('run1')
      expect(runStartTime).toBeGreaterThanOrEqual(startTime)
    })

    it('should trigger KillSwitch abort when run wall clock SLA exceeded', async () => {
      harness.startRun('run1')
      harness.setRunStartTime('run1', Date.now() - 70000)

      await harness.checkRunWallClock('run1')

      expect(mockKillSwitch.abort).toHaveBeenCalledWith('run1', expect.objectContaining({
        reason: 'run_wall_clock_sla_exceeded'
      }))
      expect(mockBus.emit).toHaveBeenCalledWith('run1', 'run_wall_clock_sla_exceeded', expect.any(Object))
    })
  })

  describe('Integration with Components', () => {
    it('should emit events for key actions', async () => {
      const graph: DependencyGraph = {
        run_id: 'run1',
        nodes: new Map([
          ['agent1', { node_id: 'agent1', agent_type: 'executor', requirements_covered: [] }]
        ]),
        edges: []
      }

      mockDepGraph.getDependencies = vi.fn().mockReturnValue([])

      await harness.spawnAgent('run1', 'agent1', 'executor', graph)

      expect(mockBus.emit).toHaveBeenCalledWith('run1', 'agent_spawned', expect.objectContaining({
        agent_id: 'agent1'
      }))
    })

    it('should respect AgentStateManager transitions', async () => {
      const graph: DependencyGraph = {
        run_id: 'run1',
        nodes: new Map([
          ['agent1', { node_id: 'agent1', agent_type: 'executor', requirements_covered: [] }]
        ]),
        edges: []
      }

      mockDepGraph.getDependencies = vi.fn().mockReturnValue([])

      await harness.spawnAgent('run1', 'agent1', 'executor', graph)

      expect(mockStateManager.transition).toHaveBeenCalledWith('run1', 'agent1', expect.any(String), expect.any(Object))
    })
  })
})
