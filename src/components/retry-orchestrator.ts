import type { FailureClassifier } from '../primitives/failure-classifier.js'
import type { ExecutionMemoryStore } from '../primitives/execution-memory-store.js'
import type { EvalPipeline } from './eval-pipeline.js'
import type { ToolRegistry } from '../primitives/tool-registry.js'
import type {
  FailureType,
  FailedStrategy,
  ExecutionMemory,
  RetryOrchestratorConfig,
  RetryDecision
} from '../primitives/types.js'

/**
 * Input for RetryOrchestrator.decideRetry()
 */
export interface RetryInput {
  agent_id: string
  failure_type: FailureType
  gate: 1 | 2
  gap: string
  attempt: number
  tool_id?: string  // Required for tool_failure type
  current_objective?: string  // For pattern similarity matching
  output?: string  // Current failed output
}

/**
 * RetryOrchestrator - C-07
 * Compose type-specific retry prompts and manage retry budget per agent node.
 *
 * Dependencies: P-13 (FailureClassifier), P-20 (ExecutionMemoryStore), C-06 (EvalPipeline)
 */
export class RetryOrchestrator {
  private config: RetryOrchestratorConfig
  private blobWriteAttempts = new Map<string, number>()  // Track blob write attempts per agent

  constructor(
    private failureClassifier: FailureClassifier,
    private executionMemoryStore: ExecutionMemoryStore,
    private evalPipeline: EvalPipeline,
    private toolRegistry?: ToolRegistry,
    config?: Partial<RetryOrchestratorConfig>
  ) {
    this.config = {
      blob_write_retry_max: 3,
      similarity_threshold: 0.75,
      max_retries: 3,
      blob_write_backoff_base_ms: 100,
      ...config
    }
  }

  /**
   * Decide whether to retry based on failure type and retry budget
   * Composes retry prompt if retry is allowed
   */
  decideRetry(input: RetryInput): RetryDecision {
    const memory = this.executionMemoryStore.get(input.agent_id)
    if (!memory) {
      throw new Error(`ExecutionMemory not initialized for agent: ${input.agent_id}`)
    }

    // Check destructive tool no-retry rule
    if (input.failure_type === 'tool_failure' && input.tool_id) {
      if (this.isDestructiveTool(input.tool_id)) {
        return {
          should_retry: false,
          retry_prompt: null,
          should_escalate: true,
          retry_count_consumed: false
        }
      }
    }

    // Check if failure type is retry-count-exempt
    const isExempt = this.failureClassifier.isRetryCountExempt(input.failure_type)

    // Handle blob_write_failure with exponential backoff
    if (input.failure_type === 'blob_write_failure') {
      return this.handleBlobWriteFailure(input, memory)
    }

    // Check retry budget (only for non-exempt failures)
    if (!isExempt) {
      const consumedRetries = this.countConsumedRetries(memory)
      if (consumedRetries >= this.config.max_retries) {
        // Budget exhausted, escalate
        return {
          should_retry: false,
          retry_prompt: null,
          should_escalate: true,
          retry_count_consumed: false  // Already at max, don't consume more
        }
      }
    }

    // Compose retry prompt
    const retryPrompt = this.composeRetryPrompt(input, memory)

    return {
      should_retry: true,
      retry_prompt: retryPrompt,
      should_escalate: false,
      retry_count_consumed: !isExempt
    }
  }

  /**
   * Record failed attempt in ExecutionMemory
   * Should be called after each failed attempt
   */
  recordFailedAttempt(input: RetryInput): void {
    const failedStrategy: FailedStrategy = {
      attempt: input.attempt,
      failure_type: input.failure_type,
      gate: input.gate,
      gap: input.gap,
      output: input.output
    }

    this.executionMemoryStore.appendFailedStrategy(input.agent_id, failedStrategy)
  }

  /**
   * Handle blob_write_failure with exponential backoff and escalation
   */
  private handleBlobWriteFailure(input: RetryInput, memory: ExecutionMemory): RetryDecision {
    // Get current blob write attempt count
    const currentAttempt = input.attempt
    const backoffMs = this.config.blob_write_backoff_base_ms * Math.pow(2, currentAttempt - 1)

    // Check if exceeded blob_write_retry_max
    if (currentAttempt > this.config.blob_write_retry_max) {
      // Reclassify as infrastructure_failure and escalate
      return {
        should_retry: false,
        retry_prompt: null,
        should_escalate: true,
        retry_count_consumed: false  // blob_write_failure is exempt
      }
    }

    // Retry with backoff
    const retryPrompt = this.composeRetryPrompt(input, memory)

    return {
      should_retry: true,
      retry_prompt: retryPrompt,
      should_escalate: false,
      retry_count_consumed: false,  // blob_write_failure does not consume retry count
      backoff_ms: backoffMs
    }
  }

  /**
   * Compose retry prompt with FailedStrategy summary and pattern injection
   */
  private composeRetryPrompt(input: RetryInput, memory: ExecutionMemory): string {
    let prompt = ''

    // Add failed strategy summaries
    if (memory.failed_strategies.length > 0) {
      prompt += 'Previous failed attempts:\n\n'
      for (const strategy of memory.failed_strategies) {
        prompt += `On attempt ${strategy.attempt}, ${strategy.failure_type} at gate ${strategy.gate}: ${strategy.gap}. Do not repeat this approach.\n`
      }
      prompt += '\n'
    }

    // Add type-specific retry addition from FailureClassifier
    const retryAddition = this.failureClassifier.buildRetryAddition(input.failure_type, memory)
    prompt += retryAddition + '\n\n'

    // Inject successful pattern scaffold if above similarity threshold
    const matchingPattern = this.findMatchingPattern(input, memory)
    if (matchingPattern) {
      prompt += 'Successful pattern scaffold (similar to current objective):\n'
      prompt += matchingPattern.artifact + '\n\n'
    }

    return prompt.trim()
  }

  /**
   * Find successful pattern matching current objective (above similarity threshold)
   * Uses simple string matching for objective_cluster (embedding-based matching would require EmbeddingEngine)
   */
  private findMatchingPattern(input: RetryInput, memory: ExecutionMemory) {
    if (!input.current_objective || memory.successful_patterns.length === 0) {
      return null
    }

    // Simple matching: exact match on objective_cluster
    // In production, this would use embedding similarity via EmbeddingEngine
    for (const pattern of memory.successful_patterns) {
      if (pattern.objective_cluster === input.current_objective) {
        return pattern
      }
    }

    return null
  }

  /**
   * Count number of retry-count-consuming attempts
   * infrastructure_failure and blob_write_failure do NOT count
   */
  private countConsumedRetries(memory: ExecutionMemory): number {
    return memory.failed_strategies.filter(
      strategy => !this.failureClassifier.isRetryCountExempt(strategy.failure_type)
    ).length
  }

  /**
   * Check if tool is destructive (requires ToolRegistry)
   */
  private isDestructiveTool(tool_id: string): boolean {
    if (!this.toolRegistry) {
      return false  // No registry, assume non-destructive
    }

    try {
      const tool = this.toolRegistry.get(tool_id)
      return tool.side_effect_class === 'destructive'
    } catch {
      return false  // Tool not found, assume non-destructive
    }
  }
}
