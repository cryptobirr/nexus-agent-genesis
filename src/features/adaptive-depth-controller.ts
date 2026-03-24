import type { RecursionGuard } from '../components/recursion-guard.js'
import type { RequirementExtractor } from '../primitives/requirement-extractor.js'
import type { BudgetLedger } from '../primitives/budget-ledger.js'
import type { EmbeddingEngine } from '../primitives/embedding-engine.js'
import type { MessageBus } from '../primitives/message-bus.js'
import type { TicketSystem } from '../primitives/ticket-system.js'
import type {
  RequirementMap,
  AgentNode,
  BudgetLimits,
  ExpansionResult,
  ShrinkageResult,
  AdaptiveDepthControllerConfig
} from '../primitives/types.js'

/**
 * AdaptiveDepthController - F-09
 * Dynamic depth expansion/shrinkage during run based on coverage gaps and entropy.
 *
 * Composition: C-04 (RecursionGuard), P-08 (RequirementExtractor), P-01 (BudgetLedger), P-11 (EmbeddingEngine)
 *
 * CRITICAL BEHAVIORS (from agent-nexus-spec.md):
 * - expand_if: "coverage_gap": uncovered Requirement after Executor COMPLETE → signal parent Planner to spawn more children (if budget allows)
 * - shrink_if: "low_entropy": near-identical proposed children → override recursion to single Executor
 * - Budget check before expansion: remaining < expansion_cost_reserve (default 20%) → suppress
 * - Suppressed expansion logged as depth_expansion_suppressed + minor ticket
 * - Hard max_depth cap always applies
 */
export class AdaptiveDepthController {
  private config: AdaptiveDepthControllerConfig

  constructor(
    private recursionGuard: RecursionGuard,
    private requirementExtractor: RequirementExtractor,
    private budgetLedger: BudgetLedger,
    private embeddingEngine: EmbeddingEngine,
    private messageBus: MessageBus,
    private ticketSystem: TicketSystem,
    config?: Partial<AdaptiveDepthControllerConfig>
  ) {
    this.config = {
      expansion_cost_reserve: config?.expansion_cost_reserve ?? 0.2,
      low_entropy_threshold: config?.low_entropy_threshold ?? 0.95,
      max_depth: config?.max_depth ?? 10
    }
  }

  /**
   * Check if depth expansion should occur
   * Called after Executor COMPLETE when coverage gap detected
   *
   * @param run_id - Run identifier
   * @param requirement_map - RequirementMap to check coverage against
   * @param agent_nodes - All agent nodes in run (for coverage checking)
   * @param current_depth - Current depth in agent tree
   * @param budget_limits - Budget limits for percentage calculation
   * @returns ExpansionResult with expansion decision and metadata
   */
  checkExpansion(
    run_id: string,
    requirement_map: RequirementMap,
    agent_nodes: AgentNode[],
    current_depth: number,
    budget_limits: BudgetLimits
  ): ExpansionResult {
    // Check coverage
    const coverageResult = this.requirementExtractor.checkCoverage(requirement_map, agent_nodes)
    const coverage_gap_detected = coverageResult.uncovered_count > 0

    // No coverage gap = no need to expand
    if (!coverage_gap_detected) {
      return {
        should_expand: false,
        suppressed: false,
        coverage_gap_detected: false
      }
    }

    // Hard cap: enforce max_depth
    if (current_depth >= this.config.max_depth) {
      this.messageBus.emit(run_id, 'max_depth_reached', {
        current_depth,
        max_depth: this.config.max_depth,
        coverage_gap: true
      })

      this.ticketSystem.createTicket(run_id, {
        severity: 'minor',
        category: 'depth_expansion_suppressed',
        description: `Max depth reached (${current_depth}/${this.config.max_depth}). Coverage gap exists but expansion blocked.`,
        metadata: {
          current_depth,
          max_depth: this.config.max_depth,
          uncovered_count: coverageResult.uncovered_count,
          uncovered_ids: coverageResult.uncovered_ids
        }
      })

      return {
        should_expand: false,
        suppressed: true,
        suppression_reason: `max_depth reached (${current_depth}/${this.config.max_depth})`,
        coverage_gap_detected: true
      }
    }

    // Budget check: suppress if insufficient budget
    const budget_state = this.budgetLedger.check(run_id)
    const should_suppress_budget = this.shouldSuppressExpansion(budget_state, budget_limits)

    if (should_suppress_budget) {
      const reason = 'Insufficient budget remaining for expansion'

      this.messageBus.emit(run_id, 'depth_expansion_suppressed', {
        reason,
        current_depth,
        coverage_gap: true,
        budget_state: {
          remaining_tokens: budget_state.remaining.tokens,
          remaining_calls: budget_state.remaining.calls,
          remaining_wall_ms: budget_state.remaining.wall_ms
        },
        expansion_cost_reserve: this.config.expansion_cost_reserve
      })

      this.ticketSystem.createTicket(run_id, {
        severity: 'minor',
        category: 'depth_expansion_suppressed',
        description: `${reason}. Coverage gap exists but expansion blocked due to budget constraints.`,
        metadata: {
          current_depth,
          budget_state,
          expansion_cost_reserve: this.config.expansion_cost_reserve,
          uncovered_count: coverageResult.uncovered_count,
          uncovered_ids: coverageResult.uncovered_ids
        }
      })

      return {
        should_expand: false,
        suppressed: true,
        suppression_reason: reason,
        coverage_gap_detected: true
      }
    }

    // All checks passed: allow expansion
    return {
      should_expand: true,
      suppressed: false,
      coverage_gap_detected: true
    }
  }

  /**
   * Check if depth shrinkage should occur (low-entropy detection)
   * Called before Planner spawns children
   *
   * @param run_id - Run identifier
   * @param agent_id - Agent identifier
   * @param children - Proposed children (task descriptions)
   * @param current_depth - Current depth in agent tree
   * @returns ShrinkageResult with shrinkage decision and metadata
   */
  checkShrinkage(
    run_id: string,
    agent_id: string,
    children: string[],
    current_depth: number
  ): ShrinkageResult {
    // Handle edge cases
    if (children.length <= 1) {
      return {
        should_shrink: false,
        low_entropy_detected: false
      }
    }

    // Detect low entropy via embedding similarity
    const { detected, similarity } = this.detectLowEntropy(children)

    if (detected) {
      this.messageBus.emit(run_id, 'low_entropy_shrinkage_triggered', {
        agent_id,
        similarity_score: similarity,
        threshold: this.config.low_entropy_threshold,
        current_depth,
        children_count: children.length
      })

      return {
        should_shrink: true,
        low_entropy_detected: true,
        similarity_score: similarity
      }
    }

    return {
      should_shrink: false,
      low_entropy_detected: false,
      similarity_score: similarity
    }
  }

  /**
   * Determine if expansion should be suppressed due to budget constraints
   * Checks if remaining budget < expansion_cost_reserve
   *
   * @param budget_state - Current budget state
   * @param budget_limits - Budget limits for percentage calculation
   * @returns True if expansion should be suppressed
   */
  private shouldSuppressExpansion(
    budget_state: { remaining: { tokens: number; calls: number; wall_ms: number } },
    budget_limits: BudgetLimits
  ): boolean {
    // Calculate remaining percentage for each budget type
    const tokens_remaining_pct = budget_state.remaining.tokens / budget_limits.tokens
    const calls_remaining_pct = budget_state.remaining.calls / budget_limits.calls
    const wall_ms_remaining_pct = budget_state.remaining.wall_ms / budget_limits.wall_ms

    // Suppress if ANY budget type below reserve threshold
    const below_reserve =
      tokens_remaining_pct < this.config.expansion_cost_reserve ||
      calls_remaining_pct < this.config.expansion_cost_reserve ||
      wall_ms_remaining_pct < this.config.expansion_cost_reserve

    return below_reserve
  }

  /**
   * Detect low entropy via embedding similarity
   * Compares all pairs of children; triggers if ANY pair exceeds threshold
   *
   * @param children - Proposed children (task descriptions)
   * @returns Object with detected flag and max similarity score
   */
  private detectLowEntropy(children: string[]): { detected: boolean; similarity?: number } {
    if (children.length <= 1) {
      return { detected: false }
    }

    // Compute embeddings for all children
    const embeddings = children.map((child) => this.embeddingEngine.embed(child))

    // Check all pairs for similarity
    let max_similarity = 0

    for (let i = 0; i < embeddings.length; i++) {
      for (let j = i + 1; j < embeddings.length; j++) {
        const similarity = this.embeddingEngine.cosineSimilarity(embeddings[i], embeddings[j])
        max_similarity = Math.max(max_similarity, similarity)

        // Early exit if threshold exceeded
        if (similarity >= this.config.low_entropy_threshold) {
          return {
            detected: true,
            similarity
          }
        }
      }
    }

    return {
      detected: false,
      similarity: max_similarity
    }
  }
}
