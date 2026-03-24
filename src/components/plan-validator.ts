import type { DependencyGraphManager } from './dependency-graph-manager.js'
import type { RequirementExtractor } from '../primitives/requirement-extractor.js'
import type { ContractRegistry } from '../primitives/contract-registry.js'
import type {
  DependencyGraph,
  RequirementMap,
  AgentNode,
  PlanValidationResult,
  PlanValidatorConfig,
  ValidationFailure
} from '../primitives/types.js'

/**
 * PlanValidator - C-03
 * Zero-cost pre-spawn validation gate between Router output and first agent spawn.
 *
 * Dependencies: C-02 (DependencyGraphManager), P-08 (RequirementExtractor), P-07 (ContractRegistry)
 */
export class PlanValidator {
  private dependencyGraphManager: DependencyGraphManager
  private requirementExtractor: RequirementExtractor
  private contractRegistry: ContractRegistry
  private config: PlanValidatorConfig

  constructor(
    dependencyGraphManager: DependencyGraphManager,
    requirementExtractor: RequirementExtractor,
    contractRegistry: ContractRegistry,
    config?: Partial<PlanValidatorConfig>
  ) {
    this.dependencyGraphManager = dependencyGraphManager
    this.requirementExtractor = requirementExtractor
    this.contractRegistry = contractRegistry
    this.config = {
      max_plan_cost: config?.max_plan_cost ?? 1000,
      cost_tolerance: config?.cost_tolerance ?? 1.2,
      max_depth: config?.max_depth ?? 5,
      allow_decomposable_depth: config?.allow_decomposable_depth ?? true
    }
  }

  /**
   * Validate dependency graph, requirements, costs, and depth
   * All 6 checks run independently
   *
   * @param graph - Dependency graph to validate
   * @param requirementMap - Requirements extracted from Router output
   * @param agentNodes - Agent nodes in the plan
   * @param planCost - Estimated plan cost
   * @param depthHint - Depth hint from Router
   * @param rootNodeId - Optional root node for orphan detection
   * @returns PlanValidationResult with failures and retryability
   */
  validate(
    graph: DependencyGraph,
    requirementMap: RequirementMap,
    agentNodes: AgentNode[],
    planCost: number,
    depthHint: number,
    rootNodeId?: string
  ): PlanValidationResult {
    const failures: ValidationFailure[] = []

    // Run all 6 checks independently (all execute regardless of failures)
    failures.push(...this.checkAcyclicity(graph))
    failures.push(...this.checkOrphanDetection(graph, rootNodeId))
    failures.push(...this.checkOutputContractSatisfiability(agentNodes))
    failures.push(...this.checkCoverageCompleteness(requirementMap, agentNodes))
    failures.push(...this.checkCostBounds(planCost))
    failures.push(...this.checkDepthCap(depthHint))

    // Determine validity and retryability
    const valid = failures.length === 0
    const retryable = failures.length === 0 || failures.every(f => f.severity === 'fixable')

    return { valid, failures, retryable }
  }

  /**
   * Check 1: Acyclicity
   * Fatal failure: Dependency graph contains cycles
   */
  private checkAcyclicity(graph: DependencyGraph): ValidationFailure[] {
    const result = this.dependencyGraphManager.validate(graph)

    if (result.cycles.length > 0) {
      return [{
        check: 'acyclicity',
        severity: 'fatal',
        message: `Detected ${result.cycles.length} cycle(s) in dependency graph`,
        details: { cycles: result.cycles }
      }]
    }

    return []
  }

  /**
   * Check 2: Orphan Detection
   * Fatal failure: Nodes unreachable from root
   * Skipped if no rootNodeId provided
   */
  private checkOrphanDetection(graph: DependencyGraph, rootNodeId?: string): ValidationFailure[] {
    if (!rootNodeId) {
      return []  // No root specified, skip orphan check
    }

    const result = this.dependencyGraphManager.validate(graph, rootNodeId)

    if (result.orphans.length > 0) {
      return [{
        check: 'orphan_detection',
        severity: 'fatal',
        message: `Detected ${result.orphans.length} orphan node(s)`,
        details: { orphans: result.orphans }
      }]
    }

    return []
  }

  /**
   * Check 3: Output Contract Satisfiability
   * Fatal failure: Missing contract for agent_type with output_spec
   * Schema-structural check only (not runtime validation)
   */
  private checkOutputContractSatisfiability(agentNodes: AgentNode[]): ValidationFailure[] {
    const failures: ValidationFailure[] = []

    for (const node of agentNodes) {
      // Only check nodes that declare both agent_type and output_spec
      if (node.output_spec && node.agent_type) {
        const contract = this.contractRegistry.get(node.agent_type)

        if (!contract) {
          failures.push({
            check: 'output_contract_satisfiability',
            severity: 'fatal',
            message: `No contract found for agent type: ${node.agent_type}`,
            details: { node_id: node.node_id, agent_type: node.agent_type }
          })
        }

        // Schema-structural check would go here (future enhancement)
        // For now, we only check contract existence
      }
    }

    return failures
  }

  /**
   * Check 4: Coverage Completeness
   * Fatal failure: Uncovered high-priority requirements OR all requirements uncovered
   */
  private checkCoverageCompleteness(
    requirementMap: RequirementMap,
    agentNodes: AgentNode[]
  ): ValidationFailure[] {
    if (requirementMap.size === 0) {
      return []  // No requirements to cover
    }

    const coverage = this.requirementExtractor.checkCoverage(requirementMap, agentNodes)

    if (coverage.uncovered_count > 0) {
      // Check if any uncovered requirements are high-priority
      const uncoveredRecords = coverage.uncovered_ids
        .map(id => requirementMap.get(id))
        .filter(r => r !== undefined)

      const hasHighPriorityUncovered = uncoveredRecords.some(r => r.priority === 'high')

      // Fatal if: (1) any high-priority uncovered OR (2) all requirements uncovered
      if (hasHighPriorityUncovered || coverage.uncovered_count === requirementMap.size) {
        return [{
          check: 'coverage_completeness',
          severity: 'fatal',
          message: `${coverage.uncovered_count} requirement(s) not covered by plan`,
          details: { uncovered_ids: coverage.uncovered_ids }
        }]
      }
    }

    return []
  }

  /**
   * Check 5: Cost Bounds
   * Fixable failure: Cost slightly exceeded (within tolerance)
   * Fatal failure: Cost far exceeded (beyond tolerance)
   */
  private checkCostBounds(planCost: number): ValidationFailure[] {
    const maxCost = this.config.max_plan_cost

    if (planCost > maxCost) {
      const ratio = planCost / maxCost
      const severity = ratio <= this.config.cost_tolerance ? 'fixable' : 'fatal'

      return [{
        check: 'cost_bounds',
        severity,
        message: `Plan cost ${planCost} exceeds max ${maxCost} (ratio: ${ratio.toFixed(2)})`,
        details: { planCost, maxCost, ratio }
      }]
    }

    return []
  }

  /**
   * Check 6: Depth Cap
   * Fixable failure: Depth exceeded but decomposable (config flag)
   * Fatal failure: Depth exceeded and not decomposable
   */
  private checkDepthCap(depthHint: number): ValidationFailure[] {
    const maxDepth = this.config.max_depth

    if (depthHint > maxDepth) {
      const severity = this.config.allow_decomposable_depth ? 'fixable' : 'fatal'

      return [{
        check: 'depth_cap',
        severity,
        message: `Depth hint ${depthHint} exceeds max ${maxDepth}`,
        details: { depthHint, maxDepth }
      }]
    }

    return []
  }
}
