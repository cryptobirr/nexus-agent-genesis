import type { AgentStateManager } from '../components/agent-state-manager.js'
import type { DependencyGraphManager } from '../components/dependency-graph-manager.js'
import type { KillSwitchController } from '../features/kill-switch-controller.js'
import type { MessageBus } from '../primitives/message-bus.js'
import type { TicketSystem } from '../primitives/ticket-system.js'
import type { DependencyGraph, AgentType } from '../primitives/types.js'

/**
 * Parallelism policy configuration
 */
export interface ParallelismPolicy {
  max_concurrent_agents: number
}

/**
 * Latency SLA policy configuration
 */
export interface LatencySLAPolicy {
  budgets: {
    executor: number
    planner: number
    router: number
  }
  on_violation: 'degrade' | 'escalate'
}

/**
 * ExecutionHarness configuration
 */
export interface ExecutionHarnessConfig {
  parallelism_policy: ParallelismPolicy
  max_queued_agents: number
  latency_sla_policy: LatencySLAPolicy
  run_wall_clock_sla_ms: number
}

/**
 * Queued agent entry
 */
interface QueuedAgent {
  agent_id: string
  agent_type: AgentType
  is_critical_path: boolean
  enqueued_at: number
}

/**
 * ExecutionHarness - M-01
 * Core run orchestration module that spawns agents, schedules per DependencyGraph,
 * enforces parallelism policy, and manages backpressure.
 *
 * Composition: F-01, F-02, F-03, F-04, F-05, F-06, F-09, C-08
 * Infrastructure: External Redis (SEC + blob store) + real LLM endpoint + ticket provider
 *
 * Acceptance Criteria:
 * - Concurrent siblings fire immediately (no dependency → immediate start)
 * - Backpressure: Planner held in PRECHECKING when queue full
 * - Latency SLA violation degrades or escalates per policy
 * - Critical path agents processed before non-critical
 * - max_concurrent_agents cap enforced
 * - max_queued_agents threshold enforced
 * - Priority queue: critical path agents first
 * - latency_sla_policy per-agent-type enforcement
 * - run_wall_clock_sla_ms hard budget enforcement
 */
export class ExecutionHarness {
  private stateManager: AgentStateManager
  private depGraphManager: DependencyGraphManager
  private killSwitch: KillSwitchController
  private messageBus: MessageBus
  private ticketSystem: TicketSystem
  private config: ExecutionHarnessConfig

  // Run-level tracking
  private runStartTimes = new Map<string, number>()
  private activeAgents = new Map<string, Set<string>>()
  private queuedAgents = new Map<string, QueuedAgent[]>()
  private agentStartTimes = new Map<string, Map<string, number>>()
  private criticalPathAgents = new Map<string, Set<string>>()

  constructor(
    stateManager: AgentStateManager,
    depGraphManager: DependencyGraphManager,
    killSwitch: KillSwitchController,
    messageBus: MessageBus,
    ticketSystem: TicketSystem,
    config: ExecutionHarnessConfig
  ) {
    this.stateManager = stateManager
    this.depGraphManager = depGraphManager
    this.killSwitch = killSwitch
    this.messageBus = messageBus
    this.ticketSystem = ticketSystem
    this.config = config
  }

  /**
   * Start a new run
   */
  startRun(run_id: string): void {
    this.runStartTimes.set(run_id, Date.now())
    this.activeAgents.set(run_id, new Set())
    this.queuedAgents.set(run_id, [])
    this.agentStartTimes.set(run_id, new Map())
    this.criticalPathAgents.set(run_id, new Set())

    this.messageBus.emit(run_id, 'run_started', {
      timestamp: Date.now()
    })
  }

  /**
   * Spawn an agent (or enqueue if at capacity)
   */
  async spawnAgent(
    run_id: string,
    agent_id: string,
    agent_type: AgentType,
    graph: DependencyGraph
  ): Promise<void> {
    // Check if agent has unsatisfied dependencies
    const dependencies = this.depGraphManager.getDependencies(graph, agent_id)
    const dependenciesSatisfied = this.depGraphManager.areDependenciesSatisfied(graph, agent_id)

    if (!dependenciesSatisfied) {
      this.enqueueAgent(run_id, agent_id, agent_type, graph)
      return
    }

    // Check if at max concurrency
    const activeCount = this.getActiveCount(run_id)
    if (activeCount >= this.config.parallelism_policy.max_concurrent_agents) {
      this.enqueueAgent(run_id, agent_id, agent_type, graph)
      return
    }

    // Spawn immediately
    await this.spawnAgentImmediately(run_id, agent_id, agent_type)
  }

  /**
   * Enqueue an agent for later spawning
   */
  private enqueueAgent(
    run_id: string,
    agent_id: string,
    agent_type: AgentType,
    graph: DependencyGraph
  ): void {
    const queue = this.queuedAgents.get(run_id) || []
    const criticalPath = this.getCriticalPath(run_id, graph)
    const isCriticalPath = criticalPath.has(agent_id)

    queue.push({
      agent_id,
      agent_type,
      is_critical_path: isCriticalPath,
      enqueued_at: Date.now()
    })

    // Sort queue: critical path first, then by enqueue time
    queue.sort((a, b) => {
      if (a.is_critical_path && !b.is_critical_path) return -1
      if (!a.is_critical_path && b.is_critical_path) return 1
      return a.enqueued_at - b.enqueued_at
    })

    this.queuedAgents.set(run_id, queue)

    this.messageBus.emit(run_id, 'agent_enqueued', {
      agent_id,
      queue_position: queue.length,
      is_critical_path: isCriticalPath
    })
  }

  /**
   * Spawn agent immediately
   */
  private async spawnAgentImmediately(
    run_id: string,
    agent_id: string,
    agent_type: AgentType
  ): Promise<void> {
    const active = this.activeAgents.get(run_id) || new Set()
    active.add(agent_id)
    this.activeAgents.set(run_id, active)

    const startTimes = this.agentStartTimes.get(run_id) || new Map()
    startTimes.set(agent_id, Date.now())
    this.agentStartTimes.set(run_id, startTimes)

    await this.stateManager.transition(run_id, agent_id, 'GENERATING', {
      spawned_by: 'execution_harness'
    })

    this.messageBus.emit(run_id, 'agent_spawned', {
      agent_id,
      agent_type,
      active_count: this.getActiveCount(run_id)
    })
  }

  /**
   * Handle agent completion - release slot and dequeue next
   */
  async onAgentComplete(run_id: string, agent_id: string): Promise<void> {
    const active = this.activeAgents.get(run_id)
    if (active) {
      active.delete(agent_id)
    }

    this.messageBus.emit(run_id, 'agent_completed', {
      agent_id,
      active_count: this.getActiveCount(run_id)
    })

    await this.dequeueNext(run_id)
  }

  /**
   * Dequeue and spawn next eligible agent
   */
  private async dequeueNext(run_id: string): Promise<void> {
    const queue = this.queuedAgents.get(run_id)
    if (!queue || queue.length === 0) return

    const activeCount = this.getActiveCount(run_id)
    if (activeCount >= this.config.parallelism_policy.max_concurrent_agents) return

    const next = queue.shift()
    if (!next) return

    this.queuedAgents.set(run_id, queue)

    await this.spawnAgentImmediately(run_id, next.agent_id, next.agent_type)
  }

  /**
   * Check if Planner can spawn (backpressure control)
   */
  canSpawnPlanner(run_id: string): boolean {
    const queuedCount = this.getQueuedCount(run_id)
    if (queuedCount >= this.config.max_queued_agents) {
      this.messageBus.emit(run_id, 'backpressure_triggered', {
        queued_count: queuedCount,
        max_queued_agents: this.config.max_queued_agents
      })
      return false
    }
    return true
  }

  /**
   * Check latency SLA for an agent
   */
  async checkLatencySLA(
    run_id: string,
    agent_id: string,
    agent_type: AgentType
  ): Promise<void> {
    const startTimes = this.agentStartTimes.get(run_id)
    if (!startTimes) return

    const startTime = startTimes.get(agent_id)
    if (!startTime) return

    const elapsed = Date.now() - startTime
    const budget = this.config.latency_sla_policy.budgets[agent_type]

    if (elapsed > budget) {
      this.messageBus.emit(run_id, 'latency_sla_violation', {
        agent_id,
        agent_type,
        elapsed_ms: elapsed,
        budget_ms: budget
      })

      const action = this.config.latency_sla_policy.on_violation

      if (action === 'escalate') {
        await this.stateManager.transition(run_id, agent_id, 'ESCALATED', {
          reason: 'latency_sla_exceeded',
          elapsed_ms: elapsed,
          budget_ms: budget
        })
      } else if (action === 'degrade') {
        await this.stateManager.transition(run_id, agent_id, 'ESCALATED', {
          reason: 'latency_sla_exceeded',
          degraded: true,
          elapsed_ms: elapsed,
          budget_ms: budget
        })
      }
    }
  }

  /**
   * Check run wall clock SLA
   */
  async checkRunWallClock(run_id: string): Promise<void> {
    const startTime = this.runStartTimes.get(run_id)
    if (!startTime) return

    const elapsed = Date.now() - startTime
    const budget = this.config.run_wall_clock_sla_ms

    if (elapsed > budget) {
      this.messageBus.emit(run_id, 'run_wall_clock_sla_exceeded', {
        elapsed_ms: elapsed,
        budget_ms: budget
      })

      await this.killSwitch.abort(run_id, {
        reason: 'run_wall_clock_sla_exceeded',
        elapsed_ms: elapsed,
        budget_ms: budget
      })
    }
  }

  /**
   * Get critical path agents for a run
   */
  private getCriticalPath(run_id: string, graph: DependencyGraph): Set<string> {
    let critical = this.criticalPathAgents.get(run_id)
    if (!critical) {
      const topoOrder = this.depGraphManager.getTopologicalOrder(graph)
      critical = new Set(topoOrder.critical_path || [])
      this.criticalPathAgents.set(run_id, critical)
    }
    return critical
  }

  // Public getters for testing

  getActiveCount(run_id?: string): number {
    if (!run_id) return 0
    return this.activeAgents.get(run_id)?.size || 0
  }

  getQueuedCount(run_id?: string): number {
    if (!run_id) return 0
    return this.queuedAgents.get(run_id)?.length || 0
  }

  getAgentStartTime(run_id: string, agent_id: string): number | undefined {
    return this.agentStartTimes.get(run_id)?.get(agent_id)
  }

  getRunStartTime(run_id: string): number | undefined {
    return this.runStartTimes.get(run_id)
  }

  // Test helpers

  setAgentStartTime(run_id: string, agent_id: string, time: number): void {
    const startTimes = this.agentStartTimes.get(run_id) || new Map()
    startTimes.set(agent_id, time)
    this.agentStartTimes.set(run_id, startTimes)
  }

  setRunStartTime(run_id: string, time: number): void {
    this.runStartTimes.set(run_id, time)
  }
}
