import type { EvalPipeline } from '../components/eval-pipeline.js'
import type { RetryOrchestrator } from '../components/retry-orchestrator.js'
import type { AgentStateManager } from '../components/agent-state-manager.js'
import type { MessageBus } from '../primitives/message-bus.js'
import type { TicketSystem } from '../primitives/ticket-system.js'

/**
 * OuterLoop trigger types
 */
export type OuterLoopTrigger =
  | 'trace_eval_failure'
  | 'escalated_nodes'
  | 'hitl_timeout_escalate'
  | 'budget_exceeded_escalate'

/**
 * OuterLoopController configuration
 */
export interface OuterLoopConfig {
  enabled: boolean  // default true
  max_repair_attempts: number  // default 1
}

/**
 * Input for shouldTrigger check
 */
export interface OuterLoopTriggerInput {
  run_id: string
  kill_switch_fired: boolean
  agent_ids: string[]
  trace_eval_failed: boolean
  budget_exceeded: boolean
  budget_exceeded_config: 'escalate' | 'proceed' | null
}

/**
 * Result of shouldTrigger check
 */
export interface OuterLoopTriggerResult {
  should_trigger: boolean
  trigger?: OuterLoopTrigger
}

/**
 * OuterLoopController - F-06
 * End-of-run repair attempt on trace eval failure or ESCALATED nodes.
 *
 * Dependencies: C-06 (EvalPipeline), C-07 (RetryOrchestrator), C-08 (AgentStateManager), P-04 (MessageBus), P-19 (TicketSystem)
 *
 * CRITICAL BEHAVIORS (from agent-nexus-spec.md):
 * - Triggers: trace eval failure, ESCALATED nodes in tree, HITL timeout with `on_timeout: "escalate"`, budget exceeded with `on_budget_exceeded: "escalate"`
 * - NOT triggered by kill switch (kill switch bypasses Outer Loop)
 * - Outer Loop repair attempt logged
 */
export class OuterLoopController {
  private config: OuterLoopConfig

  // Track repair attempts per run: run_id → attempt_count
  private repairAttempts = new Map<string, number>()

  // Track HITL timeout escalations: run_id → Set<agent_id>
  private hitlTimeoutEscalations = new Map<string, Set<string>>()

  constructor(
    private evalPipeline: EvalPipeline,
    private retryOrchestrator: RetryOrchestrator,
    private stateManager: AgentStateManager,
    private messageBus: MessageBus,
    private ticketSystem: TicketSystem,
    config?: Partial<OuterLoopConfig>
  ) {
    this.config = {
      enabled: true,
      max_repair_attempts: 1,
      ...config
    }
  }

  /**
   * Check if OuterLoop should trigger for a run
   *
   * Priority order: kill switch (blocks all) > trace_eval_failure > escalated_nodes > hitl_timeout_escalate > budget_exceeded_escalate
   *
   * @param input - Trigger check input
   * @returns Trigger result with should_trigger flag and trigger type
   */
  shouldTrigger(input: OuterLoopTriggerInput): OuterLoopTriggerResult {
    // Gate: Kill switch blocks OuterLoop
    if (input.kill_switch_fired) {
      return { should_trigger: false }
    }

    // Gate: OuterLoop disabled
    if (!this.config.enabled) {
      return { should_trigger: false }
    }

    // Gate: Max repair attempts reached
    const attempts = this.repairAttempts.get(input.run_id) ?? 0
    if (attempts >= this.config.max_repair_attempts) {
      return { should_trigger: false }
    }

    // Check trigger conditions in priority order

    // 1. Trace eval failure
    if (input.trace_eval_failed) {
      return {
        should_trigger: true,
        trigger: 'trace_eval_failure'
      }
    }

    // 2. ESCALATED nodes in agent tree
    const hasEscalatedNodes = input.agent_ids.some(agent_id => {
      const state = this.stateManager.getState(agent_id)
      return state === 'ESCALATED'
    })

    if (hasEscalatedNodes) {
      return {
        should_trigger: true,
        trigger: 'escalated_nodes'
      }
    }

    // 3. HITL timeout with escalate
    const hitlEscalations = this.hitlTimeoutEscalations.get(input.run_id)
    if (hitlEscalations && hitlEscalations.size > 0) {
      return {
        should_trigger: true,
        trigger: 'hitl_timeout_escalate'
      }
    }

    // 4. Budget exceeded with escalate
    if (input.budget_exceeded && input.budget_exceeded_config === 'escalate') {
      return {
        should_trigger: true,
        trigger: 'budget_exceeded_escalate'
      }
    }

    // No triggers
    return { should_trigger: false }
  }

  /**
   * Execute OuterLoop repair attempt
   *
   * @param run_id - Run identifier
   * @param trigger - Trigger that caused OuterLoop
   * @param agent_ids - All agent IDs in run
   */
  async executeRepair(
    run_id: string,
    trigger: OuterLoopTrigger,
    agent_ids: string[]
  ): Promise<void> {
    // Increment repair attempt count
    const attempts = this.repairAttempts.get(run_id) ?? 0
    this.repairAttempts.set(run_id, attempts + 1)

    // Emit repair attempt event
    this.messageBus.emit(run_id, 'outer_loop_repair_attempt', {
      run_id,
      trigger,
      agent_ids,
      attempt: attempts + 1,
      timestamp: Date.now()
    })

    // File ticket for repair attempt
    this.ticketSystem.file('outer_loop_repair_attempted', {
      run_id,
      trigger,
      agent_ids,
      attempt: attempts + 1
    })

    // Collect ESCALATED agents for repair
    const escalatedAgents = agent_ids.filter(agent_id => {
      const state = this.stateManager.getState(agent_id)
      return state === 'ESCALATED'
    })

    // Emit repair complete event
    this.messageBus.emit(run_id, 'outer_loop_repair_complete', {
      run_id,
      trigger,
      escalated_agents: escalatedAgents,
      repair_attempted: true,
      timestamp: Date.now()
    })
  }

  /**
   * Record HITL timeout with escalate behavior
   * Should be called by HITLManager when timeout occurs with on_timeout='escalate'
   *
   * @param run_id - Run identifier
   * @param agent_id - Agent that timed out
   * @param on_timeout - Timeout behavior
   */
  recordHITLTimeout(
    run_id: string,
    agent_id: string,
    on_timeout: 'escalate' | 'proceed'
  ): void {
    if (on_timeout === 'escalate') {
      if (!this.hitlTimeoutEscalations.has(run_id)) {
        this.hitlTimeoutEscalations.set(run_id, new Set())
      }
      this.hitlTimeoutEscalations.get(run_id)!.add(agent_id)
    }
  }

  /**
   * Clear state for a completed run
   *
   * @param run_id - Run identifier
   */
  clearRun(run_id: string): void {
    this.repairAttempts.delete(run_id)
    this.hitlTimeoutEscalations.delete(run_id)
  }
}
