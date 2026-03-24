import type { BudgetLedger } from '../primitives/budget-ledger.js'
import type { AgentStateManager } from '../components/agent-state-manager.js'
import type { MessageBus } from '../primitives/message-bus.js'
import type { TicketSystem } from '../primitives/ticket-system.js'
import type { AgentState } from '../primitives/types.js'

/**
 * KillSwitchController configuration
 */
export interface KillSwitchConfig {
  loop_detection_threshold: number  // default 3
  partial_output_timeout_ms: number  // default 5000
  run_wall_clock_sla_ms: number | null  // from RunConfig
}

/**
 * Kill switch trigger types
 */
export type KillSwitchTrigger = 'cost_exceeded' | 'time_exceeded' | 'loop_detected'

/**
 * KillSwitchController - F-05
 * Hard stop on cost_exceeded | time_exceeded | loop_detected.
 *
 * Dependencies: P-01 (BudgetLedger), C-08 (AgentStateManager), P-04 (MessageBus), P-19 (TicketSystem)
 *
 * CRITICAL BEHAVIORS (from agent-nexus-spec.md):
 * - Actions: abort_run, escalate_run, finalize_partial
 * - Kill switch bypasses Outer Loop (enforced in M-01 ExecutionHarness)
 * - loop_detected: same scope hash retried > threshold times across run
 * - finalize_partial: PARTIAL_COMPLETE reached after timeout; trace eval runs on COMPLETE nodes only
 * - Critical ticket filed on kill switch trigger
 */
export class KillSwitchController {
  // Loop detection state: run_id → scope_hash → retry_count
  private loopDetectionMap = new Map<string, Map<string, number>>()

  // Escalated runs (blocks new spawns)
  private escalatedRuns = new Set<string>()

  // Run start times for wall clock SLA tracking
  private runStartTimes = new Map<string, number>()

  // States that can be immediately cancelled (QUEUED, RETRYING)
  private static readonly CANCELLABLE_STATES: Set<AgentState> = new Set([
    'QUEUED',
    'RETRYING'
  ])

  // States that are in-flight (GENERATING, evaluating)
  private static readonly IN_FLIGHT_STATES: Set<AgentState> = new Set([
    'GENERATING',
    'GATE1_EVALUATING',
    'GATE2_EVALUATING'
  ])

  constructor(
    private budgetLedger: BudgetLedger,
    private agentStateManager: AgentStateManager,
    private messageBus: MessageBus,
    private ticketSystem: TicketSystem,
    private config: KillSwitchConfig
  ) {}

  /**
   * Start tracking a new run (for wall clock SLA)
   *
   * @param run_id - Run identifier
   */
  startRun(run_id: string): void {
    this.runStartTimes.set(run_id, Date.now())
    this.loopDetectionMap.set(run_id, new Map())
  }

  /**
   * Check if any kill switch triggers have fired
   *
   * Priority order: cost_exceeded > time_exceeded > loop_detected
   *
   * @param run_id - Run identifier
   * @returns Trigger type or null if no trigger
   */
  checkTriggers(run_id: string): KillSwitchTrigger | null {
    // Check budget exceeded
    const budgetState = this.budgetLedger.check(run_id)
    if (budgetState.exceeded) {
      return 'cost_exceeded'
    }

    // Check wall clock SLA
    if (this.config.run_wall_clock_sla_ms !== null) {
      const startTime = this.runStartTimes.get(run_id)
      if (startTime) {
        const elapsed = Date.now() - startTime
        if (elapsed >= this.config.run_wall_clock_sla_ms) {
          return 'time_exceeded'
        }
      }
    }

    // Check loop detection
    const scopeHashMap = this.loopDetectionMap.get(run_id)
    if (scopeHashMap) {
      for (const [_, retryCount] of scopeHashMap) {
        if (retryCount > this.config.loop_detection_threshold) {
          return 'loop_detected'
        }
      }
    }

    return null
  }

  /**
   * Record a retry for loop detection
   *
   * @param run_id - Run identifier
   * @param scope_hash - Hash of scope text
   */
  recordRetry(run_id: string, scope_hash: string): void {
    if (!this.loopDetectionMap.has(run_id)) {
      this.loopDetectionMap.set(run_id, new Map())
    }

    const scopeHashMap = this.loopDetectionMap.get(run_id)!
    const currentCount = scopeHashMap.get(scope_hash) ?? 0
    scopeHashMap.set(scope_hash, currentCount + 1)
  }

  /**
   * Abort run: halt all agents immediately → Run = ERROR
   *
   * @param run_id - Run identifier
   * @param trigger - Trigger that caused abort
   * @param agent_ids - All agent IDs in run
   */
  abortRun(run_id: string, trigger: KillSwitchTrigger, agent_ids: string[]): void {
    // Transition all agents to ERROR
    for (const agent_id of agent_ids) {
      this.agentStateManager.transition(
        {
          agent_id,
          run_id,
          reason: `Kill switch triggered: ${trigger}`
        },
        'ERROR'
      )
    }

    // Set run state to ERROR
    this.agentStateManager.setRunState(run_id, 'ERROR')

    // File CRITICAL ticket
    this.ticketSystem.file('kill_switch_triggered', {
      run_id,
      trigger,
      action: 'abort_run'
    })

    // Emit event
    this.messageBus.emit(run_id, 'kill_switch_triggered', {
      trigger,
      action: 'abort_run',
      timestamp: Date.now()
    })
  }

  /**
   * Escalate run: stop new spawns, mark in-flight ESCALATED, surface to operator
   *
   * @param run_id - Run identifier
   * @param trigger - Trigger that caused escalation
   * @param agent_ids - All agent IDs in run
   */
  escalateRun(run_id: string, trigger: KillSwitchTrigger, agent_ids: string[]): void {
    // Add to escalated runs set (blocks new spawns)
    this.escalatedRuns.add(run_id)

    // Mark in-flight agents ESCALATED
    for (const agent_id of agent_ids) {
      const state = this.agentStateManager.getState(agent_id)

      if (state && KillSwitchController.IN_FLIGHT_STATES.has(state)) {
        this.agentStateManager.transition(
          {
            agent_id,
            run_id,
            reason: `Kill switch escalation: ${trigger}`
          },
          'ESCALATED'
        )
      }
    }

    // File CRITICAL ticket
    this.ticketSystem.file('kill_switch_triggered', {
      run_id,
      trigger,
      action: 'escalate_run'
    })

    // Emit event
    this.messageBus.emit(run_id, 'kill_switch_escalation', {
      trigger,
      action: 'escalate_run',
      timestamp: Date.now()
    })
  }

  /**
   * Finalize partial: cancel QUEUED/RETRYING; give GENERATING agents timeout to finish;
   * run ContextCompressor + TraceEval on COMPLETE nodes; Run = PARTIAL_COMPLETE
   *
   * @param run_id - Run identifier
   * @param trigger - Trigger that caused finalize
   * @param agent_ids - All agent IDs in run
   */
  async finalizePartial(
    run_id: string,
    trigger: KillSwitchTrigger,
    agent_ids: string[]
  ): Promise<void> {
    // Cancel QUEUED and RETRYING agents immediately
    for (const agent_id of agent_ids) {
      const state = this.agentStateManager.getState(agent_id)

      if (state && KillSwitchController.CANCELLABLE_STATES.has(state)) {
        this.agentStateManager.transition(
          {
            agent_id,
            run_id,
            reason: `Kill switch finalize_partial: ${trigger}`
          },
          'CANCELLED'
        )
      }
    }

    // Wait for GENERATING agents to finish (with timeout)
    await new Promise<void>((resolve) => {
      setTimeout(() => {
        // After timeout, force remaining GENERATING to ESCALATED
        for (const agent_id of agent_ids) {
          const state = this.agentStateManager.getState(agent_id)

          if (state === 'GENERATING') {
            this.agentStateManager.transition(
              {
                agent_id,
                run_id,
                reason: `Kill switch timeout: ${trigger}`
              },
              'ESCALATED'
            )
          }
        }

        resolve()
      }, this.config.partial_output_timeout_ms)
    })

    // Set run state to PARTIAL_COMPLETE
    this.agentStateManager.setRunState(run_id, 'PARTIAL_COMPLETE')

    // File CRITICAL ticket
    this.ticketSystem.file('kill_switch_triggered', {
      run_id,
      trigger,
      action: 'finalize_partial'
    })

    // Emit event
    this.messageBus.emit(run_id, 'kill_switch_partial_finalize', {
      trigger,
      action: 'finalize_partial',
      timestamp: Date.now()
    })
  }

  /**
   * Check if a run is escalated (blocks new spawns)
   *
   * @param run_id - Run identifier
   * @returns True if run is escalated
   */
  isEscalated(run_id: string): boolean {
    return this.escalatedRuns.has(run_id)
  }
}
