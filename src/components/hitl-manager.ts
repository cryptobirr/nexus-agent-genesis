import type { AgentStateManager } from './agent-state-manager.js'
import type { MessageBus } from '../primitives/message-bus.js'
import type { TicketSystem } from '../primitives/ticket-system.js'
import type { HITLCheckpoint, HITLModifications } from '../primitives/types.js'

/**
 * Result of HITL operation
 */
export interface HITLResult {
  success: boolean
  error_reason?: string
}

/**
 * HITLManager - C-09
 * Pause execution at declared checkpoints and await operator action.
 *
 * Dependencies: C-08 (AgentStateManager), P-04 (MessageBus), P-19 (TicketSystem)
 *
 * CRITICAL BEHAVIORS (from agent-nexus-spec.md):
 * - Agent enters AWAITING_HITL on declared checkpoint
 * - Approve advances agent to next state (PRECHECKING)
 * - Reject escalates agent (ESCALATED)
 * - Timeout fires `on_timeout` behavior
 * - Timeout with `on_timeout: "escalate"` → Outer Loop trigger
 * - Options: Approve and continue / Edit brief / Edit output / Reject and escalate
 */
export class HITLManager {
  private stateManager: AgentStateManager
  private messageBus: MessageBus
  private ticketSystem: TicketSystem

  // Active checkpoints: agent_id → HITLCheckpoint
  private activeCheckpoints = new Map<string, HITLCheckpoint>()

  // Timeout handles: agent_id → timeout handle
  private timeoutHandles = new Map<string, NodeJS.Timeout>()

  constructor(
    stateManager: AgentStateManager,
    messageBus: MessageBus,
    ticketSystem: TicketSystem
  ) {
    this.stateManager = stateManager
    this.messageBus = messageBus
    this.ticketSystem = ticketSystem
  }

  /**
   * Enter AWAITING_HITL state at a declared checkpoint
   *
   * @param agent_id - Agent identifier
   * @param run_id - Run identifier
   * @param checkpoint - Checkpoint configuration
   * @returns Result of checkpoint entry
   */
  checkpoint(agent_id: string, run_id: string, checkpoint: HITLCheckpoint): HITLResult {
    // Check if already in AWAITING_HITL
    const currentState = this.stateManager.getState(agent_id)
    if (currentState === 'AWAITING_HITL') {
      return {
        success: false,
        error_reason: `Agent ${agent_id} already in AWAITING_HITL`
      }
    }

    // Transition to AWAITING_HITL
    const transitionResult = this.stateManager.transition(
      {
        agent_id,
        run_id,
        reason: `HITL checkpoint ${checkpoint.checkpoint_id}`
      },
      'AWAITING_HITL'
    )

    if (!transitionResult.success) {
      return {
        success: false,
        error_reason: transitionResult.error_reason
      }
    }

    // Store checkpoint
    this.activeCheckpoints.set(agent_id, checkpoint)

    // Emit checkpoint reached event
    this.messageBus.emit(run_id, 'hitl_checkpoint_reached', {
      agent_id,
      checkpoint_id: checkpoint.checkpoint_id,
      timeout_ms: checkpoint.timeout_ms,
      on_timeout: checkpoint.on_timeout,
      timestamp: Date.now()
    })

    // Set timeout if configured
    if (checkpoint.timeout_ms !== null) {
      const timeoutHandle = setTimeout(() => {
        this._handleTimeout(agent_id, run_id)
      }, checkpoint.timeout_ms)

      this.timeoutHandles.set(agent_id, timeoutHandle)
    }

    return { success: true }
  }

  /**
   * Approve checkpoint and advance to PRECHECKING
   *
   * @param agent_id - Agent identifier
   * @param run_id - Run identifier
   * @returns Result of approve action
   */
  approve(agent_id: string, run_id: string): HITLResult {
    // Check if in AWAITING_HITL
    const currentState = this.stateManager.getState(agent_id)
    if (currentState !== 'AWAITING_HITL') {
      return {
        success: false,
        error_reason: `Agent ${agent_id} not in AWAITING_HITL (current: ${currentState})`
      }
    }

    const checkpoint = this.activeCheckpoints.get(agent_id)
    if (!checkpoint) {
      return {
        success: false,
        error_reason: `No active checkpoint for agent ${agent_id}`
      }
    }

    // Clear timeout
    this._clearTimeout(agent_id)

    // Transition to PRECHECKING
    const transitionResult = this.stateManager.transition(
      {
        agent_id,
        run_id,
        reason: 'HITL approved'
      },
      'PRECHECKING'
    )

    if (!transitionResult.success) {
      return {
        success: false,
        error_reason: transitionResult.error_reason
      }
    }

    // Emit approved event
    this.messageBus.emit(run_id, 'hitl_checkpoint_approved', {
      agent_id,
      checkpoint_id: checkpoint.checkpoint_id,
      timestamp: Date.now()
    })

    // Clean up checkpoint
    this.activeCheckpoints.delete(agent_id)

    return { success: true }
  }

  /**
   * Reject checkpoint and escalate agent
   *
   * @param agent_id - Agent identifier
   * @param run_id - Run identifier
   * @param reason - Rejection reason
   * @returns Result of reject action
   */
  reject(agent_id: string, run_id: string, reason: string): HITLResult {
    // Check if in AWAITING_HITL
    const currentState = this.stateManager.getState(agent_id)
    if (currentState !== 'AWAITING_HITL') {
      return {
        success: false,
        error_reason: `Agent ${agent_id} not in AWAITING_HITL (current: ${currentState})`
      }
    }

    const checkpoint = this.activeCheckpoints.get(agent_id)
    if (!checkpoint) {
      return {
        success: false,
        error_reason: `No active checkpoint for agent ${agent_id}`
      }
    }

    // Clear timeout
    this._clearTimeout(agent_id)

    // Transition to ESCALATED
    const transitionResult = this.stateManager.transition(
      {
        agent_id,
        run_id,
        reason: `HITL rejected: ${reason}`
      },
      'ESCALATED'
    )

    if (!transitionResult.success) {
      return {
        success: false,
        error_reason: transitionResult.error_reason
      }
    }

    // Emit rejected event
    this.messageBus.emit(run_id, 'hitl_checkpoint_rejected', {
      agent_id,
      checkpoint_id: checkpoint.checkpoint_id,
      reason,
      timestamp: Date.now()
    })

    // Clean up checkpoint
    this.activeCheckpoints.delete(agent_id)

    return { success: true }
  }

  /**
   * Edit brief or output and advance to PRECHECKING
   *
   * @param agent_id - Agent identifier
   * @param run_id - Run identifier
   * @param modifications - Brief or output modifications
   * @returns Result of edit action
   */
  edit(agent_id: string, run_id: string, modifications: HITLModifications): HITLResult {
    // Check if in AWAITING_HITL
    const currentState = this.stateManager.getState(agent_id)
    if (currentState !== 'AWAITING_HITL') {
      return {
        success: false,
        error_reason: `Agent ${agent_id} not in AWAITING_HITL (current: ${currentState})`
      }
    }

    const checkpoint = this.activeCheckpoints.get(agent_id)
    if (!checkpoint) {
      return {
        success: false,
        error_reason: `No active checkpoint for agent ${agent_id}`
      }
    }

    // Clear timeout
    this._clearTimeout(agent_id)

    // Transition to PRECHECKING
    const transitionResult = this.stateManager.transition(
      {
        agent_id,
        run_id,
        reason: 'HITL edited'
      },
      'PRECHECKING'
    )

    if (!transitionResult.success) {
      return {
        success: false,
        error_reason: transitionResult.error_reason
      }
    }

    // Emit edited event
    this.messageBus.emit(run_id, 'hitl_checkpoint_edited', {
      agent_id,
      checkpoint_id: checkpoint.checkpoint_id,
      modifications,
      timestamp: Date.now()
    })

    // Clean up checkpoint
    this.activeCheckpoints.delete(agent_id)

    return { success: true }
  }

  /**
   * Handle checkpoint timeout
   *
   * @param agent_id - Agent identifier
   * @param run_id - Run identifier
   * @private
   */
  private _handleTimeout(agent_id: string, run_id: string): void {
    const checkpoint = this.activeCheckpoints.get(agent_id)
    if (!checkpoint) {
      // Checkpoint already resolved
      return
    }

    // Emit timeout event
    this.messageBus.emit(run_id, 'hitl_checkpoint_timeout', {
      agent_id,
      checkpoint_id: checkpoint.checkpoint_id,
      on_timeout: checkpoint.on_timeout,
      timestamp: Date.now()
    })

    // Execute on_timeout behavior
    if (checkpoint.on_timeout === 'proceed') {
      // Transition to PRECHECKING
      this.stateManager.transition(
        {
          agent_id,
          run_id,
          reason: 'HITL timeout - proceeding'
        },
        'PRECHECKING'
      )
    } else if (checkpoint.on_timeout === 'escalate') {
      // Transition to ESCALATED
      this.stateManager.transition(
        {
          agent_id,
          run_id,
          reason: 'HITL timeout - escalating'
        },
        'ESCALATED'
      )
    }

    // Clean up
    this.activeCheckpoints.delete(agent_id)
    this.timeoutHandles.delete(agent_id)
  }

  /**
   * Clear timeout for an agent
   *
   * @param agent_id - Agent identifier
   * @private
   */
  private _clearTimeout(agent_id: string): void {
    const handle = this.timeoutHandles.get(agent_id)
    if (handle) {
      clearTimeout(handle)
      this.timeoutHandles.delete(agent_id)
    }
  }
}
