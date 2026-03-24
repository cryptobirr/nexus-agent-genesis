import type {
  RequirementMap,
  AgentNode,
  DependencyGraph,
  SECEntry,
  Signal,
  Dimension,
  DataRef,
  ChunkSummary,
  JudgeContext,
  CoverageResult
} from '../primitives/types.js'
import { RequirementExtractor } from '../primitives/requirement-extractor.js'
import { JudgeRunner } from '../primitives/judge-runner.js'
import { ContextCompressor } from '../primitives/context-compressor.js'
import { BlobStore } from '../primitives/blob-store.js'

/**
 * Input for TraceEvaluation.evaluate()
 */
export interface TraceEvaluationInput {
  run_id: string
  requirement_map: RequirementMap
  agent_nodes: AgentNode[]
  dependency_graph: DependencyGraph
  sec_final_state: SECEntry[]
  early_termination: boolean
  token_budget: number
  max_escalated_output_tokens: number  // default 500
}

/**
 * Result of TraceEvaluation.evaluate()
 */
export interface TraceEvaluationResult {
  success: boolean
  phase1: {
    coverage_status: CoverageResult
    confidence: number
  }
  phase2: {
    dimensions: {
      objective_fulfillment: number
      coverage_completeness: number
      coherence: number
      dependency_integrity: number
    }
    weighted_score: number
  }
  failure_reason?: string
  outer_loop_trigger: boolean
}

/**
 * TraceEvaluation - F-08
 * Full run-level evaluation: Phase 1 (deterministic coverage) + Phase 2 (LLM judges).
 *
 * Composition: P-08 (RequirementExtractor), P-15 (JudgeRunner), P-17 (ContextCompressor), P-03 (BlobStore)
 */
export class TraceEvaluation {
  constructor(
    private requirementExtractor: RequirementExtractor,
    private judgeRunner: JudgeRunner,
    private contextCompressor: ContextCompressor,
    private blobStore: BlobStore
  ) {}

  /**
   * Main entry point: orchestrates Phase 1 → Phase 2
   */
  async evaluate(input: TraceEvaluationInput): Promise<TraceEvaluationResult> {
    try {
      // Phase 1: Deterministic coverage analysis
      const phase1Result = this.runPhase1(input.requirement_map, input.agent_nodes)

      // Phase 2: LLM judge evaluation
      const phase2Result = await this.runPhase2(input, phase1Result)

      return {
        success: true,
        phase1: phase1Result,
        phase2: phase2Result,
        outer_loop_trigger: false
      }
    } catch (error) {
      // Trace failure triggers Outer Loop
      return {
        success: false,
        phase1: {
          coverage_status: {
            covered_count: 0,
            uncovered_count: 0,
            covered_ids: [],
            uncovered_ids: []
          },
          confidence: 0
        },
        phase2: {
          dimensions: {
            objective_fulfillment: 0,
            coverage_completeness: 0,
            coherence: 0,
            dependency_integrity: 0
          },
          weighted_score: 0
        },
        failure_reason: error instanceof Error ? error.message : 'Unknown error',
        outer_loop_trigger: true
      }
    }
  }

  /**
   * Phase 1: Deterministic coverage analysis
   */
  private runPhase1(
    requirement_map: RequirementMap,
    agent_nodes: AgentNode[]
  ): {
    coverage_status: CoverageResult
    confidence: number
  } {
    // Check coverage of requirements
    const coverage_status = this.requirementExtractor.checkCoverage(requirement_map, agent_nodes)

    // Compute confidence score (with high-priority requirement guard)
    const confidence = this.requirementExtractor.computeConfidence(requirement_map)

    return {
      coverage_status,
      confidence
    }
  }

  /**
   * Phase 2: LLM judge evaluation
   */
  private async runPhase2(
    input: TraceEvaluationInput,
    phase1Result: { coverage_status: CoverageResult; confidence: number }
  ): Promise<{
    dimensions: {
      objective_fulfillment: number
      coverage_completeness: number
      coherence: number
      dependency_integrity: number
    }
    weighted_score: number
  }> {
    // Assemble context with priority ordering and budget constraints
    const context = await this.assembleContext(input, phase1Result)

    // Build dimensions with weights
    const dimensions = this.buildDimensions()

    // Create judge context
    const judgeContext: JudgeContext = {
      agent_output: context,
      dimension_criteria: new Map([
        ['objective_fulfillment', 'Does the trace fulfill the stated objectives?'],
        ['coverage_completeness', 'Are all requirements covered?'],
        ['coherence', 'Is the execution trace coherent and logical?'],
        ['dependency_integrity', 'Are dependencies satisfied correctly?']
      ]),
      run_id: input.run_id
    }

    // Run merged judge evaluation
    const signals = await this.judgeRunner.runMerged(dimensions, judgeContext)

    // Aggregate weighted scores
    const dimensionScores = {
      objective_fulfillment: signals[0].numeric_score,
      coverage_completeness: signals[1].numeric_score,
      coherence: signals[2].numeric_score,
      dependency_integrity: signals[3].numeric_score
    }

    const weighted_score = this.aggregateWeightedScore(signals, dimensions)

    return {
      dimensions: dimensionScores,
      weighted_score
    }
  }

  /**
   * Assemble context with priority ordering and budget constraints
   *
   * Priority ordering:
   * 1. Always: RequirementMap + coverage status, early_termination flag, SEC final state summary
   * 2. Until budget: Full ESCALATED outputs on critical path (shallowest first)
   * 3. Until budget: Full outputs of nodes covering contested Requirements
   * 4. Until budget: Non-critical ESCALATED outputs (truncated to max_escalated_output_tokens)
   * 5. Always as pointers only: Blob store DataRef pointers
   * 6. Fill remaining: ChunkSummaries
   */
  private async assembleContext(
    input: TraceEvaluationInput,
    phase1Result: { coverage_status: CoverageResult; confidence: number }
  ): Promise<string> {
    const parts: string[] = []

    // Priority 1: RequirementMap + coverage + early_termination + SEC summary
    parts.push('## RequirementMap')
    const reqArray = Array.from(input.requirement_map.values())
    parts.push(JSON.stringify(reqArray, null, 2))

    parts.push('\n## Coverage Status')
    parts.push(`Covered: ${phase1Result.coverage_status.covered_count}`)
    parts.push(`Uncovered: ${phase1Result.coverage_status.uncovered_count}`)
    parts.push(`Uncovered IDs: ${phase1Result.coverage_status.uncovered_ids.join(', ')}`)
    parts.push(`Confidence: ${phase1Result.confidence}`)

    parts.push('\n## Early Termination')
    parts.push(`${input.early_termination}`)

    parts.push('\n## SEC Final State')
    for (const entry of input.sec_final_state) {
      parts.push(`${entry.key}: ${JSON.stringify(entry.value)}`)
    }

    parts.push('\n## DependencyGraph')
    parts.push(`Nodes: ${input.dependency_graph.nodes.join(', ')}`)
    parts.push(`Edges: ${input.dependency_graph.edges.length}`)

    // Identify critical path nodes
    const criticalPathNodes = this.identifyCriticalPath(input.dependency_graph)

    // Priority 2: Full ESCALATED outputs on critical path
    const escalatedCritical = input.agent_nodes.filter(
      n => n.is_escalated && criticalPathNodes.has(n.node_id)
    )

    parts.push('\n## Escalated Critical Path Outputs')
    for (const node of escalatedCritical) {
      parts.push(`### Node: ${node.node_id}`)
      parts.push(node.output || '')
    }

    // Priority 3: Full outputs of nodes covering contested Requirements (uncovered)
    const contestedNodes = input.agent_nodes.filter(n =>
      n.requirements_covered.some(reqId =>
        phase1Result.coverage_status.uncovered_ids.includes(reqId)
      )
    )

    parts.push('\n## Contested Requirement Outputs')
    for (const node of contestedNodes) {
      parts.push(`### Node: ${node.node_id}`)
      parts.push(node.output || '')
    }

    // Priority 4: Non-critical ESCALATED outputs (truncated)
    const escalatedNonCritical = input.agent_nodes.filter(
      n => n.is_escalated && !criticalPathNodes.has(n.node_id)
    )

    parts.push('\n## Non-Critical Escalated Outputs (truncated)')
    for (const node of escalatedNonCritical) {
      parts.push(`### Node: ${node.node_id}`)
      const truncated = this.truncateOutput(
        node.output || '',
        input.max_escalated_output_tokens
      )
      parts.push(truncated)
    }

    // Priority 5: Blob DataRef pointers (always included)
    parts.push('\n## Blob DataRef Pointers')
    for (const node of input.agent_nodes) {
      if (node.data_refs && node.data_refs.length > 0) {
        parts.push(`### Node: ${node.node_id}`)
        for (const ref of node.data_refs) {
          parts.push(`DataRef: ${ref.ref_id} (schema: ${ref.schema}, size: ${ref.size_bytes})`)
        }
      }
    }

    // Priority 6: ChunkSummaries (fill remaining budget)
    parts.push('\n## ChunkSummaries')
    for (const node of input.agent_nodes) {
      // Skip nodes already included above
      if (
        escalatedCritical.includes(node) ||
        contestedNodes.includes(node) ||
        escalatedNonCritical.includes(node)
      ) {
        continue
      }

      const chunkSummary = await this.contextCompressor.compress(node)
      parts.push(`### Node: ${node.node_id}`)
      parts.push(`Summary: ${chunkSummary.summary}`)
    }

    return parts.join('\n')
  }

  /**
   * Identify critical path nodes (nodes with no dependencies - root nodes)
   */
  private identifyCriticalPath(dependency_graph: DependencyGraph): Set<string> {
    const criticalPath = new Set<string>()

    // Find nodes with no incoming edges (root nodes)
    const nodesWithIncoming = new Set<string>()
    for (const edge of dependency_graph.edges) {
      nodesWithIncoming.add(edge.to_node_id)
    }

    for (const node of dependency_graph.nodes) {
      if (!nodesWithIncoming.has(node)) {
        criticalPath.add(node)
      }
    }

    return criticalPath
  }

  /**
   * Truncate output to max tokens
   */
  private truncateOutput(output: string, max_tokens: number): string {
    // Simple truncation: 1 token ≈ 4 characters
    const max_chars = max_tokens * 4
    if (output.length <= max_chars) {
      return output
    }
    return output.substring(0, max_chars) + '...'
  }

  /**
   * Build 4 dimensions with specified weights
   */
  private buildDimensions(): Dimension[] {
    return [
      {
        dimension_id: 'objective_fulfillment',
        weight: 0.40,
        is_binary: false,
        gate: 2
      },
      {
        dimension_id: 'coverage_completeness',
        weight: 0.35,
        is_binary: false,
        gate: 2
      },
      {
        dimension_id: 'coherence',
        weight: 0.15,
        is_binary: false,
        gate: 2
      },
      {
        dimension_id: 'dependency_integrity',
        weight: 0.10,
        is_binary: false,
        gate: 2
      }
    ]
  }

  /**
   * Aggregate weighted score from signals
   */
  private aggregateWeightedScore(signals: Signal[], dimensions: Dimension[]): number {
    let totalScore = 0

    for (let i = 0; i < signals.length; i++) {
      totalScore += signals[i].numeric_score * dimensions[i].weight
    }

    return totalScore
  }
}
