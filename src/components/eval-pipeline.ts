import type {
  AgentType,
  OutputSpec,
  FailedStrategy,
  FailureType,
  Signal,
  Dimension,
  JudgeContext
} from '../primitives/types.js'
import type { OutputNormalizer } from '../primitives/output-normalizer.js'
import type { DeterministicPreCheck } from '../primitives/deterministic-precheck.js'
import type { FailureClassifier } from '../primitives/failure-classifier.js'
import type { JudgeRunner } from '../primitives/judge-runner.js'
import type { ContractRegistry } from '../primitives/contract-registry.js'

/**
 * EvalPipeline configuration
 */
export interface EvalPipelineConfig {
  early_stop_on_gate1: boolean
  merged_judge_mode: boolean
  model_infra_retry_max: number
  gate2_threshold: number
}

/**
 * EvalPipeline input
 */
export interface EvalPipelineInput {
  agent_type: AgentType
  agent_output: unknown
  output_spec?: OutputSpec
  attempt: number
  failed_strategies: FailedStrategy[]
  run_id: string
  early_stop_on_gate1?: boolean
  merged_judge_mode?: boolean
}

/**
 * EvalPipeline result
 */
export interface EvalResult {
  passed: boolean
  gate_reached: 1 | 2 | 'precheck' | 'normalization' | null
  failure_type?: FailureType
  gate1_signals?: Signal[]
  gate2_signals?: Signal[]
  gate2_weighted_score?: number
  normalized_output?: unknown
  violations?: string[]
}

/**
 * EvalPipeline - C-06
 * Full two-gate evaluation pipeline: pre-check → Gate 1 (binary) → Gate 2 (weighted).
 *
 * Pipeline: OutputNormalizer (if output_spec) → PreCheck → Gate1 (binary) → Gate2 (weighted)
 */
export class EvalPipeline {
  private config: EvalPipelineConfig

  constructor(
    private outputNormalizer: OutputNormalizer,
    private preCheck: DeterministicPreCheck,
    private failureClassifier: FailureClassifier,
    private judgeRunner: JudgeRunner,
    private contractRegistry: ContractRegistry,
    config?: Partial<EvalPipelineConfig>
  ) {
    this.config = {
      early_stop_on_gate1: true,
      merged_judge_mode: true,
      model_infra_retry_max: 2,
      gate2_threshold: 0.7,
      ...config
    }
  }

  /**
   * Execute full evaluation pipeline
   */
  async evaluate(input: EvalPipelineInput): Promise<EvalResult> {
    const earlyStop = input.early_stop_on_gate1 ?? this.config.early_stop_on_gate1
    const mergedMode = input.merged_judge_mode ?? this.config.merged_judge_mode

    let currentOutput = input.agent_output
    let normalizedOutput: unknown | undefined

    // Stage 1: Normalization (if output_spec provided)
    if (input.output_spec) {
      const normResult = this.runNormalization(currentOutput, input.output_spec)
      if (!normResult.passed) {
        return {
          passed: false,
          gate_reached: 'normalization',
          failure_type: 'schema_failure'
        }
      }
      currentOutput = normResult.normalized_output
      normalizedOutput = normResult.normalized_output
    }

    // Stage 2: Precheck
    const precheckResult = this.runPreCheck(input.agent_type, currentOutput)
    if (!precheckResult.passed) {
      return {
        passed: false,
        gate_reached: 'precheck',
        failure_type: precheckResult.failure_type,
        violations: precheckResult.violations,
        normalized_output: normalizedOutput
      }
    }

    // Stage 3: Gate 1 (binary dimensions)
    const gate1Result = await this.runGate1(
      input.agent_type,
      currentOutput,
      input.run_id,
      mergedMode
    )

    // Early stop if Gate 1 fails and early_stop_on_gate1 is true
    if (!gate1Result.passed && earlyStop) {
      const failureType = this.classifyGate1Failure(gate1Result.signals)
      return {
        passed: false,
        gate_reached: 1,
        failure_type: failureType,
        gate1_signals: gate1Result.signals,
        normalized_output: normalizedOutput
      }
    }

    // Stage 4: Gate 2 (weighted dimensions)
    const gate2Result = await this.runGate2(
      input.agent_type,
      currentOutput,
      input.attempt,
      input.failed_strategies,
      input.run_id,
      mergedMode
    )

    return {
      passed: gate2Result.passed,
      gate_reached: 2,
      gate1_signals: gate1Result.signals,
      gate2_signals: gate2Result.signals,
      gate2_weighted_score: gate2Result.weighted_score,
      normalized_output: normalizedOutput,
      failure_type: gate2Result.passed ? undefined : this.classifyGate2Failure(gate2Result.signals)
    }
  }

  /**
   * Run normalization stage
   */
  private runNormalization(
    output: unknown,
    output_spec: OutputSpec
  ): { passed: boolean; normalized_output: unknown; failure_reason?: string } {
    const result = this.outputNormalizer.normalize(output, output_spec)
    return {
      passed: result.passed,
      normalized_output: result.normalized_output,
      failure_reason: result.failure_reason || undefined
    }
  }

  /**
   * Run precheck stage
   */
  private runPreCheck(
    agent_type: AgentType,
    output: unknown
  ): { passed: boolean; violations?: string[]; failure_type?: FailureType } {
    const result = this.preCheck.run(agent_type, output)
    if (!result.passed) {
      // Classify precheck failure as schema_failure
      const failureType = this.failureClassifier.classify(1, 'schema_violation', {
        verdict: false,
        numeric_score: 0,
        gap: 1.0,
        severity: 'critical',
        reasoning: result.violations.join(', ')
      })
      return {
        passed: false,
        violations: result.violations,
        failure_type: failureType
      }
    }
    return { passed: true }
  }

  /**
   * Run Gate 1 evaluation (binary dimensions)
   */
  private async runGate1(
    agent_type: AgentType,
    output: unknown,
    run_id: string,
    mergedMode: boolean
  ): Promise<{ passed: boolean; signals: Signal[] }> {
    // Get contract
    const contract = this.contractRegistry.get(agent_type)
    if (!contract) {
      throw new Error(`Contract not found for agent_type: ${agent_type}`)
    }

    // Filter Gate 1 dimensions (binary only)
    const gate1Dimensions = contract.dimensions.filter(d => d.gate === 1 && d.is_binary)

    if (gate1Dimensions.length === 0) {
      // No Gate 1 dimensions, auto-pass
      return { passed: true, signals: [] }
    }

    // Build Judge context
    const context: JudgeContext = {
      agent_output: JSON.stringify(output),
      dimension_criteria: this.buildDimensionCriteria(gate1Dimensions),
      run_id
    }

    // Get signals (merged or isolated based on config)
    const signals = mergedMode
      ? await this.judgeRunner.runMerged(gate1Dimensions, context)
      : await Promise.all(gate1Dimensions.map(d => this.judgeRunner.run(d, context)))

    // Determine Gate 1 threshold based on agent type
    const threshold = this.getGate1Threshold(agent_type)

    // Gate 1 passes if ALL dimensions pass threshold
    const passed = signals.every(s => s.numeric_score >= threshold)

    return { passed, signals }
  }

  /**
   * Run Gate 2 evaluation (weighted dimensions)
   */
  private async runGate2(
    agent_type: AgentType,
    output: unknown,
    attempt: number,
    failed_strategies: FailedStrategy[],
    run_id: string,
    mergedMode: boolean
  ): Promise<{ passed: boolean; signals: Signal[]; weighted_score: number }> {
    // Get contract
    const contract = this.contractRegistry.get(agent_type)
    if (!contract) {
      throw new Error(`Contract not found for agent_type: ${agent_type}`)
    }

    // Filter Gate 2 dimensions
    let gate2Dimensions = contract.dimensions.filter(d => d.gate === 2)

    if (gate2Dimensions.length === 0) {
      // No Gate 2 dimensions, auto-pass
      return { passed: true, signals: [], weighted_score: 1.0 }
    }

    // Handle novelty auto-pass on attempt 1
    const noveltyDimension = gate2Dimensions.find(d => d.dimension_id === 'novelty')
    let noveltySignal: Signal | null = null

    if (noveltyDimension && attempt === 1) {
      // Auto-pass novelty on attempt 1
      noveltySignal = {
        verdict: true,
        numeric_score: 1.0,
        gap: 0,
        severity: 'low',
        reasoning: 'Auto-passed on first attempt'
      }
      // Remove novelty from dimensions to evaluate
      gate2Dimensions = gate2Dimensions.filter(d => d.dimension_id !== 'novelty')
    }

    // Build Judge context
    const context: JudgeContext = {
      agent_output: this.buildNoveltyContext(output, attempt, failed_strategies),
      dimension_criteria: this.buildDimensionCriteria(gate2Dimensions),
      run_id
    }

    // Get signals for non-novelty dimensions
    const signals = gate2Dimensions.length > 0
      ? (mergedMode
        ? await this.judgeRunner.runMerged(gate2Dimensions, context)
        : await Promise.all(gate2Dimensions.map(d => this.judgeRunner.run(d, context))))
      : []

    // Merge novelty signal back if it was auto-passed
    const allSignals = noveltySignal
      ? [...signals, noveltySignal]
      : signals

    // Calculate weighted score
    const allDimensions = noveltySignal
      ? [...gate2Dimensions, noveltyDimension!]
      : gate2Dimensions

    const weightedScore = this.calculateWeightedScore(allDimensions, allSignals)

    // Gate 2 passes if weighted score >= threshold
    const passed = weightedScore >= this.config.gate2_threshold

    return { passed, signals: allSignals, weighted_score: weightedScore }
  }

  /**
   * Build novelty context with failed_strategies
   */
  private buildNoveltyContext(
    output: unknown,
    attempt: number,
    failed_strategies: FailedStrategy[]
  ): string {
    if (attempt === 1 || failed_strategies.length === 0) {
      return JSON.stringify(output)
    }

    // Include current output + failed strategies outputs
    const failedOutputs = failed_strategies
      .map(fs => `Attempt ${fs.attempt}: ${fs.output || 'N/A'}`)
      .join('\n\n')

    return `Current output:\n${JSON.stringify(output)}\n\nPrevious failed attempts:\n${failedOutputs}`
  }

  /**
   * Build dimension criteria map
   */
  private buildDimensionCriteria(dimensions: Dimension[]): Map<string, string> {
    const criteria = new Map<string, string>()
    for (const dim of dimensions) {
      // In production, this would come from a dimension definition registry
      // For now, use dimension_id as placeholder criteria
      criteria.set(dim.dimension_id, `Evaluate ${dim.dimension_id}`)
    }
    return criteria
  }

  /**
   * Get Gate 1 threshold based on agent type
   * Router: 70%, Planner: 75%, Executor: 80%
   */
  private getGate1Threshold(agent_type: AgentType): number {
    const thresholds: Record<AgentType, number> = {
      router: 0.70,
      planner: 0.75,
      executor: 0.80
    }
    return thresholds[agent_type]
  }

  /**
   * Calculate weighted score for Gate 2
   */
  private calculateWeightedScore(dimensions: Dimension[], signals: Signal[]): number {
    if (dimensions.length !== signals.length) {
      throw new Error('Dimension count mismatch with signal count')
    }

    let totalScore = 0
    for (let i = 0; i < dimensions.length; i++) {
      totalScore += dimensions[i].weight * signals[i].numeric_score
    }

    return totalScore
  }

  /**
   * Classify Gate 1 failure
   */
  private classifyGate1Failure(signals: Signal[]): FailureType {
    // Find first failing dimension
    const failingSignal = signals.find(s => !s.verdict)
    if (!failingSignal) {
      return 'planning_failure' // Default fallback
    }

    // Map severity to failure type
    // In production, this would use FailureClassifier with dimension info
    return 'planning_failure'
  }

  /**
   * Classify Gate 2 failure
   */
  private classifyGate2Failure(signals: Signal[]): FailureType {
    // Find most severe failing dimension
    const failingSignal = signals
      .filter(s => !s.verdict)
      .sort((a, b) => {
        const severityOrder = { critical: 4, high: 3, medium: 2, low: 1 }
        return severityOrder[b.severity] - severityOrder[a.severity]
      })[0]

    if (!failingSignal) {
      return 'reasoning_failure' // Default fallback
    }

    // Map severity to failure type
    return 'reasoning_failure'
  }
}
