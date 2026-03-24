import type { MessageBus } from '../primitives/message-bus.js'
import type { TicketSystem } from '../primitives/ticket-system.js'
import type {
  AgentState,
  StateTransitionResult,
  StateTransitionContext
} from '../primitives/types.js'

/**
 * AgentStateManager - C-08
 * Manage agent state machine transitions and enforce valid transition rules.
 *
 * Dependencies: P-04 (MessageBus), P-19 (TicketSystem)
 *
 * CRITICAL BEHAVIORS (from agent-nexus-spec.md):
 * - States: QUEUED → AWAITING_HITL → PRECHECKING → GENERATING → GATE1_EVALUATING → GATE2_EVALUATING → COMPLETE | ESCALATED | RETRYING | CANCELLED | ERROR
 * - Planner-only: PARTIALLY_COMPLETE
 * - Run-level: PARTIAL_COMPLETE
 * - ESCALATED: retains best_output, files MAJOR ticket, propagates context_confidence: "degraded"
 * - CANCELLED: set only by early termination for QUEUED agents; no tickets filed
 * - ERROR: set by sandbox violation or kill switch abort_run; files CRITICAL ticket
 * - OCC re-decompose stays within PRECHECKING (PRECHECKING → PRECHECKING valid)
 */
export class AgentStateManager {
  private messageBus: MessageBus
  private ticketSystem: TicketSystem

  // Agent-level state storage: agent_id → AgentState
  private agentStates = new Map<string, AgentState>()

  // Agent type tracking: agent_id → agent_type
  private agentTypes = new Map<string, 'router' | 'planner' | 'executor'>()

  // Run-level state storage: run_id → AgentState
  private runStates = new Map<string, AgentState>()

  // Valid transitions map: from_state → Set<to_state>
  private static readonly VALID_TRANSITIONS = new Map<AgentState, Set<AgentState>>([
    ['QUEUED', new Set(['AWAITING_HITL', 'CANCELLED'])],
    ['AWAITING_HITL', new Set(['PRECHECKING', 'ESCALATED'])],
    ['PRECHECKING', new Set(['PRECHECKING', 'GENERATING', 'RETRYING', 'ESCALATED'])], // PRECHECKING → PRECHECKING for OCC
    ['GENERATING', new Set(['GATE1_EVALUATING', 'RETRYING', 'ESCALATED', 'ERROR'])],
    ['GATE1_EVALUATING', new Set(['GATE2_EVALUATING', 'RETRYING', 'ESCALATED'])],
    ['GATE2_EVALUATING', new Set(['COMPLETE', 'RETRYING', 'ESCALATED', 'PARTIALLY_COMPLETE'])],
    ['RETRYING', new Set(['PRECHECKING', 'GENERATING'])],
    // Terminal states - no valid transitions
    ['COMPLETE', new Set()],
    ['ESCALATED', new Set()],
    ['CANCELLED', new Set()],
    ['ERROR', new Set()],
    ['PARTIALLY_COMPLETE', new Set()],
    ['PARTIAL_COMPLETE', new Set()]
  ])

  // Terminal states
  private static readonly TERMINAL_STATES: Set<AgentState> = new Set([
    'COMPLETE',
    'ESCALATED',
    'CANCELLED',
    'ERROR',
    'PARTIALLY_COMPLETE',
    'PARTIAL_COMPLETE'
  ])

  constructor(messageBus: MessageBus, ticketSystem: TicketSystem) {
    this.messageBus = messageBus
    this.ticketSystem = ticketSystem
  }

  /**
   * Initialize a new agent in QUEUED state
   *
   * @param agent_id - Agent identifier
   * @param run_id - Run identifier
   * @param agent_type - Optional agent type (router, planner, executor)
   */
  initializeAgent(
    agent_id: string,
    run_id: string,
    agent_type?: 'router' | 'planner' | 'executor'
  ): void {
    this.agentStates.set(agent_id, 'QUEUED')
    if (agent_type) {
      this.agentTypes.set(agent_id, agent_type)
    }
  }

  /**
   * Get current state of an agent
   *
   * @param agent_id - Agent identifier
   * @returns Current state or null if agent not found
   */
  getState(agent_id: string): AgentState | null {
    return this.agentStates.get(agent_id) ?? null
  }

  /**
   * Transition agent to a new state with validation
   *
   * @param context - Transition context (agent_id, run_id, reason, etc.)
   * @param to_state - Target state
   * @returns StateTransitionResult with success status
   */
  transition(context: StateTransitionContext, to_state: AgentState): StateTransitionResult {
    const { agent_id, run_id, reason, best_output, agent_type } = context

    // Get current state
    const from_state = this.agentStates.get(agent_id)
    if (!from_state) {
      return {
        success: false,
        current_state: 'QUEUED',
        error_reason: `Agent ${agent_id} not initialized`
      }
    }

    // Check if current state is terminal
    if (AgentStateManager.TERMINAL_STATES.has(from_state)) {
      return {
        success: false,
        current_state: from_state,
        error_reason: `Cannot transition from terminal state ${from_state}`
      }
    }

    // Validate PARTIALLY_COMPLETE is planner-only
    if (to_state === 'PARTIALLY_COMPLETE') {
      const storedType = this.agentTypes.get(agent_id)
      const effectiveType = agent_type ?? storedType

      if (effectiveType !== 'planner') {
        return {
          success: false,
          current_state: from_state,
          error_reason: 'PARTIALLY_COMPLETE is planner only'
        }
      }
    }

    // Check if transition is valid
    const validNextStates = AgentStateManager.VALID_TRANSITIONS.get(from_state)
    if (!validNextStates || !validNextStates.has(to_state)) {
      return {
        success: false,
        current_state: from_state,
        error_reason: `Invalid transition from ${from_state} to ${to_state}`
      }
    }

    // Perform transition
    this.agentStates.set(agent_id, to_state)

    // Emit state_transition event
    const eventPayload: any = {
      agent_id,
      from_state,
      to_state,
      reason: reason ?? null,
      timestamp: Date.now()
    }

    // Add context_confidence for ESCALATED
    if (to_state === 'ESCALATED') {
      eventPayload.context_confidence = 'degraded'
    }

    this.messageBus.emit(run_id, 'state_transition', eventPayload)

    // Handle ticket filing
    if (to_state === 'ESCALATED') {
      this.ticketSystem.file('agent_escalated' as any, {
        run_id,
        agent_id,
        best_output,
        reason,
        from_state
      })
    } else if (to_state === 'ERROR') {
      this.ticketSystem.file('agent_error' as any, {
        run_id,
        agent_id,
        reason,
        from_state
      })
    }
    // CANCELLED does NOT file ticket (per spec)

    return {
      success: true,
      current_state: to_state
    }
  }

  /**
   * Set run-level state (PARTIAL_COMPLETE, etc.)
   *
   * @param run_id - Run identifier
   * @param state - Run state
   */
  setRunState(run_id: string, state: AgentState): void {
    this.runStates.set(run_id, state)

    // Emit run_state_transition event
    this.messageBus.emit(run_id, 'run_state_transition', {
      run_id,
      to_state: state,
      timestamp: Date.now()
    })
  }

  /**
   * Get run-level state
   *
   * @param run_id - Run identifier
   * @returns Run state or null if not set
   */
  getRunState(run_id: string): AgentState | null {
    return this.runStates.get(run_id) ?? null
  }
}
