import type { MessageBus } from '../primitives/message-bus.js'
import type { TicketSystem } from '../primitives/ticket-system.js'
import type { Event, FailureType, AgentState } from '../primitives/types.js'

/**
 * ObservabilityModule configuration
 */
export interface ObservabilityModuleConfig {
  enable_causal_tracking: boolean  // default true
  max_causal_chain_depth: number   // default 10
}

/**
 * Event filters for querying events
 */
export interface EventFilters {
  agent_id?: string
  event_types?: string[]
  time_range?: { start: number; end: number }
}

/**
 * ObservabilityModule - M-03
 * Full transparency: all decisions, state transitions, eval results, conflicts, tickets logged and inspectable.
 *
 * Composition: P-04 (MessageBus), P-19 (TicketSystem), C-01 (SECManager), C-08 (AgentStateManager)
 *
 * Logged events (complete list):
 * - Every pre-check, gate verdict, judge reasoning, ContextAssembly source
 * - SEC writes, OCC conflicts, sec_occ_retry cycles
 * - DependencyGraph edge events, HITL events, recursion guard overrides
 * - Retries, compression events, blob store writes
 * - Failure types, normalization results, sandbox events
 * - Kill switch events, budget state
 * - Causal chains from ESCALATED nodes via caused_by links
 * - sec_size_warning when SEC entries exceed SEC_list_max_entries
 * - pattern_lookup_latency_ms per node
 *
 * Test criteria:
 * - All listed event types emit to MessageBus
 * - Every event has run_id, agent_id, timestamp
 * - caused_by links traceable from ESCALATED node to root cause
 * - Inspector can replay full run from bus events
 */
export class ObservabilityModule {
  private messageBus: MessageBus
  private ticketSystem: TicketSystem
  private config: ObservabilityModuleConfig

  // Causal chain tracking: run_id → agent_id → caused_by
  private causalChains = new Map<string, Map<string, string>>()

  constructor(
    messageBus: MessageBus,
    ticketSystem: TicketSystem,
    config?: Partial<ObservabilityModuleConfig>
  ) {
    this.messageBus = messageBus
    this.ticketSystem = ticketSystem
    this.config = {
      enable_causal_tracking: config?.enable_causal_tracking ?? true,
      max_causal_chain_depth: config?.max_causal_chain_depth ?? 10
    }
  }

  /**
   * Log pre-check result
   */
  logPreCheck(run_id: string, agent_id: string, result: { passed: boolean; violations: string[] }): void {
    this.messageBus.emit(run_id, 'pre_check', {
      agent_id,
      passed: result.passed,
      violations: result.violations
    })
  }

  /**
   * Log gate verdict
   */
  logGateVerdict(run_id: string, agent_id: string, gate: 1 | 2, verdict: boolean, reasoning: string): void {
    this.messageBus.emit(run_id, 'gate_verdict', {
      agent_id,
      gate,
      verdict,
      reasoning
    })
  }

  /**
   * Log judge reasoning for a dimension
   */
  logJudgeReasoning(run_id: string, agent_id: string, dimension_id: string, reasoning: string, score: number): void {
    this.messageBus.emit(run_id, 'judge_reasoning', {
      agent_id,
      dimension_id,
      reasoning,
      score
    })
  }

  /**
   * Log context assembly source
   */
  logContextSource(run_id: string, agent_id: string, source: string, chunk_count: number): void {
    this.messageBus.emit(run_id, 'context_source', {
      agent_id,
      source,
      chunk_count
    })
  }

  /**
   * Log SEC write
   */
  logSECWrite(run_id: string, agent_id: string, key: string, version_id: number): void {
    this.messageBus.emit(run_id, 'sec_write', {
      agent_id,
      key,
      version_id
    })
  }

  /**
   * Log OCC conflict
   */
  logOCCConflict(run_id: string, agent_id: string, key: string, conflict_info: any): void {
    this.messageBus.emit(run_id, 'occ_conflict', {
      agent_id,
      key,
      conflict_info
    })
  }

  /**
   * Log OCC retry cycle
   */
  logOCCRetry(run_id: string, agent_id: string, attempt: number, max_retries: number): void {
    this.messageBus.emit(run_id, 'sec_occ_retry', {
      agent_id,
      attempt,
      max_retries
    })
  }

  /**
   * Log dependency graph edge
   */
  logDependencyEdge(run_id: string, from_node: string, to_node: string, edge_type: string): void {
    this.messageBus.emit(run_id, 'dependency_edge', {
      from_node,
      to_node,
      edge_type
    })
  }

  /**
   * Log HITL event
   */
  logHITLEvent(run_id: string, agent_id: string, checkpoint_id: string, resolution: string): void {
    this.messageBus.emit(run_id, 'hitl_event', {
      agent_id,
      checkpoint_id,
      resolution
    })
  }

  /**
   * Log recursion guard override
   */
  logRecursionGuardOverride(run_id: string, agent_id: string, reason: string): void {
    this.messageBus.emit(run_id, 'recursion_guard_override', {
      agent_id,
      reason
    })
  }

  /**
   * Log retry attempt
   */
  logRetry(run_id: string, agent_id: string, attempt: number, failure_type: FailureType): void {
    this.messageBus.emit(run_id, 'retry', {
      agent_id,
      attempt,
      failure_type
    })
  }

  /**
   * Log compression event
   */
  logCompression(run_id: string, node_id: string, original_size: number, compressed_size: number): void {
    this.messageBus.emit(run_id, 'compression', {
      node_id,
      original_size,
      compressed_size
    })
  }

  /**
   * Log blob store write
   */
  logBlobWrite(run_id: string, agent_id: string, ref_id: string, size_bytes: number): void {
    this.messageBus.emit(run_id, 'blob_write', {
      agent_id,
      ref_id,
      size_bytes
    })
  }

  /**
   * Log failure type classification
   */
  logFailureType(run_id: string, agent_id: string, failure_type: FailureType, gate: 1 | 2 | 'precheck'): void {
    this.messageBus.emit(run_id, 'failure_type', {
      agent_id,
      failure_type,
      gate
    })
  }

  /**
   * Log normalization result
   */
  logNormalizationResult(run_id: string, agent_id: string, passed: boolean, failure_reason: string | null): void {
    this.messageBus.emit(run_id, 'normalization_result', {
      agent_id,
      passed,
      failure_reason
    })
  }

  /**
   * Log sandbox event
   */
  logSandboxEvent(run_id: string, agent_id: string, event_type: string, details: any): void {
    this.messageBus.emit(run_id, 'sandbox_event', {
      agent_id,
      event_type,
      details
    })
  }

  /**
   * Log kill switch trigger
   */
  logKillSwitch(run_id: string, trigger: string): void {
    this.messageBus.emit(run_id, 'kill_switch', {
      trigger
    })
  }

  /**
   * Log budget state
   */
  logBudgetState(run_id: string, remaining: any, exceeded: boolean): void {
    this.messageBus.emit(run_id, 'budget_state', {
      remaining,
      exceeded
    })
  }

  /**
   * Log state transition with optional causal tracking
   */
  logStateTransition(
    run_id: string,
    agent_id: string,
    from_state: AgentState,
    to_state: AgentState,
    caused_by?: string
  ): void {
    const payload: any = {
      agent_id,
      from_state,
      to_state
    }

    // Track causal chain if enabled and caused_by provided
    if (this.config.enable_causal_tracking && caused_by) {
      payload.caused_by = caused_by

      // Store in causal chain map
      if (!this.causalChains.has(run_id)) {
        this.causalChains.set(run_id, new Map())
      }
      this.causalChains.get(run_id)!.set(agent_id, caused_by)
    }

    this.messageBus.emit(run_id, 'state_transition', payload)
  }

  /**
   * Log SEC size warning
   */
  logSECSizeWarning(run_id: string, entry_count: number, max_entries: number): void {
    this.messageBus.emit(run_id, 'sec_size_warning', {
      entry_count,
      max_entries
    })
  }

  /**
   * Log pattern lookup latency
   */
  logPatternLookupLatency(run_id: string, node_id: string, latency_ms: number): void {
    this.messageBus.emit(run_id, 'pattern_lookup_latency_ms', {
      node_id,
      latency_ms
    })
  }

  /**
   * Get causal chain for an agent (from ESCALATED back to root cause)
   * Returns array from current agent to root cause
   */
  getCausalChain(run_id: string, agent_id: string): string[] {
    if (!this.config.enable_causal_tracking) {
      return []
    }

    const runChains = this.causalChains.get(run_id)
    if (!runChains || !runChains.has(agent_id)) {
      return []
    }

    const chain: string[] = [agent_id]
    let current = agent_id

    while (chain.length < this.config.max_causal_chain_depth) {
      const caused_by = runChains.get(current)
      if (!caused_by) break

      // Avoid infinite loops - check BEFORE adding
      if (chain.includes(caused_by)) break

      chain.push(caused_by)
      current = caused_by
    }

    return chain
  }

  /**
   * Replay all events for a run (delegates to MessageBus)
   */
  replay(run_id: string): Event[] {
    return this.messageBus.replay(run_id)
  }

  /**
   * Query events with filters
   */
  queryEvents(run_id: string, filters: EventFilters): Event[] {
    const allEvents = this.messageBus.replay(run_id)

    return allEvents.filter(event => {
      // Filter by agent_id
      if (filters.agent_id) {
        const payload = event.payload as any
        if (payload.agent_id !== filters.agent_id) {
          return false
        }
      }

      // Filter by event_types
      if (filters.event_types && filters.event_types.length > 0) {
        if (!filters.event_types.includes(event.event_type)) {
          return false
        }
      }

      // Filter by time_range
      if (filters.time_range) {
        if (event.timestamp < filters.time_range.start || event.timestamp > filters.time_range.end) {
          return false
        }
      }

      return true
    })
  }
}
