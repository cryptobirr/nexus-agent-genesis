import type { RequirementExtractor } from '../primitives/requirement-extractor.js'
import type { DependencyGraphManager } from '../components/dependency-graph-manager.js'
import type { AgentStateManager } from '../components/agent-state-manager.js'
import type { MessageBus } from '../primitives/message-bus.js'
import type {
  RequirementMap,
  AgentNode,
  DependencyGraph,
  AgentState
} from '../primitives/types.js'

/**
 * CancellationResult - result of early termination check
 */
export interface CancellationResult {
  terminated: boolean
  cancelled_agent_ids: string[]
  coverage_state?: {
    covered_count: number
    uncovered_count: number
    confidence: number
  }
}

/**
 * EarlyTerminationController - F-04
 * Monitor RequirementMap coverage after every Executor COMPLETE; cancel QUEUED agents when threshold met.
 *
 * Composition: P-08 (RequirementExtractor), C-02 (DependencyGraphManager), C-08 (AgentStateManager), P-04 (MessageBus)
 *
 * CRITICAL BEHAVIORS (from agent-nexus-spec.md):
 * - Check after every Executor COMPLETE
 * - Fire if: all requirements covered AND confidence ≥ threshold AND no high-priority requirement uncovered
 * - Cancellation order: topological sort → leaves first
 * - Cancelled agents: fire `on_timeout` on outbound dependency edges
 * - GENERATING/GATE1_EVALUATING/GATE2_EVALUATING: allowed to complete
 * - Log `early_termination: true` on Run with triggering coverage state
 */
export class EarlyTerminationController {
  // States that should NOT be cancelled (allowed to complete)
  private static readonly NON_CANCELLABLE_STATES: Set<AgentState> = new Set([
    'GENERATING',
    'GATE1_EVALUATING',
    'GATE2_EVALUATING',
    'COMPLETE',
    'ESCALATED',
    'CANCELLED',
    'ERROR',
    'PARTIALLY_COMPLETE',
    'PARTIAL_COMPLETE'
  ])

  constructor(
    private requirementExtractor: RequirementExtractor,
    private dependencyGraphManager: DependencyGraphManager,
    private agentStateManager: AgentStateManager,
    private messageBus: MessageBus
  ) {}

  /**
   * Check if early termination should trigger
   * Called by harness after every Executor COMPLETE
   *
   * @param run_id - Run identifier
   * @param requirement_map - RequirementMap to check coverage against
   * @param agent_nodes - All agent nodes in run (for coverage checking)
   * @param dependency_graph - Dependency graph for cancellation order
   * @param confidence_threshold - Minimum confidence score to trigger termination
   * @returns CancellationResult with terminated flag and cancelled agent IDs
   */
  check(
    run_id: string,
    requirement_map: RequirementMap,
    agent_nodes: AgentNode[],
    dependency_graph: DependencyGraph,
    confidence_threshold: number
  ): CancellationResult {
    // Check coverage and confidence
    const coverageResult = this.requirementExtractor.checkCoverage(requirement_map, agent_nodes)
    const confidence = this.requirementExtractor.computeConfidence(requirement_map)

    // Determine if we should terminate
    const shouldTerminate = this.shouldTerminate(
      coverageResult.uncovered_count,
      confidence,
      confidence_threshold
    )

    if (!shouldTerminate) {
      return {
        terminated: false,
        cancelled_agent_ids: []
      }
    }

    // Get cancellation order (leaves first - reverse topological)
    const cancellationOrder = this.dependencyGraphManager.getCancellationOrder(dependency_graph)

    // Filter to only QUEUED agents (others allowed to complete)
    const cancellableAgents = this.getCancellableAgents(cancellationOrder)

    // Cancel each agent in order
    const cancelledAgentIds: string[] = []
    for (const agentId of cancellableAgents) {
      const cancelled = this.cancelAgent(agentId, run_id, dependency_graph)
      if (cancelled) {
        cancelledAgentIds.push(agentId)
      }
    }

    // Build coverage state for event
    const coverageState = {
      covered_count: coverageResult.covered_count,
      uncovered_count: coverageResult.uncovered_count,
      confidence
    }

    // Emit early_termination event
    this.messageBus.emit(run_id, 'early_termination_triggered', {
      coverage_state: coverageState,
      cancelled_agent_ids: cancelledAgentIds
    })

    return {
      terminated: true,
      cancelled_agent_ids: cancelledAgentIds,
      coverage_state: coverageState
    }
  }

  /**
   * Determine if early termination should fire
   * Conditions: all requirements covered AND confidence ≥ threshold
   * Note: computeConfidence returns 0 if any high-priority requirement uncovered (guard)
   */
  private shouldTerminate(
    uncovered_count: number,
    confidence: number,
    threshold: number
  ): boolean {
    // All requirements must be covered
    if (uncovered_count > 0) {
      return false
    }

    // Confidence must meet threshold
    // Note: computeConfidence returns 0 if high-priority requirement uncovered
    if (confidence < threshold) {
      return false
    }

    return true
  }

  /**
   * Filter agents to only those in QUEUED state
   * GENERATING, GATE*_EVALUATING, and terminal states are allowed to complete
   */
  private getCancellableAgents(agentIds: string[]): string[] {
    const cancellable: string[] = []

    for (const agentId of agentIds) {
      const state = this.agentStateManager.getState(agentId)

      // Skip if agent not found or in non-cancellable state
      if (!state || EarlyTerminationController.NON_CANCELLABLE_STATES.has(state)) {
        continue
      }

      // Only QUEUED agents can be cancelled
      if (state === 'QUEUED') {
        cancellable.push(agentId)
      }
    }

    return cancellable
  }

  /**
   * Cancel a single agent and fire on_timeout on its outbound edges
   *
   * @param agent_id - Agent to cancel
   * @param run_id - Run identifier
   * @param dependency_graph - Dependency graph for edge lookup
   * @returns True if agent was successfully cancelled
   */
  private cancelAgent(
    agent_id: string,
    run_id: string,
    dependency_graph: DependencyGraph
  ): boolean {
    // Transition agent to CANCELLED state
    const result = this.agentStateManager.transition(
      {
        agent_id,
        run_id,
        reason: 'Early termination: coverage threshold met'
      },
      'CANCELLED'
    )

    if (!result.success) {
      return false
    }

    // Fire on_timeout on all outbound edges (edges where from_node_id === agent_id)
    const outboundEdges = dependency_graph.edges.filter(
      (edge) => edge.from_node_id === agent_id
    )

    for (const edge of outboundEdges) {
      this.dependencyGraphManager.fireTTLTimeout(edge, run_id)
    }

    return true
  }
}
