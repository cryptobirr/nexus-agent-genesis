import type { FailureType, Signal, ExecutionMemory } from './types.js'

/**
 * FailureClassifier - P-13
 * Deterministic failure type assignment before retry prompt composition.
 *
 * Zero dependencies. Zero inference cost. Fully deterministic.
 */
export class FailureClassifier {
  /**
   * Classify failure based on gate, dimension, and signal
   * Each (gate, dimension, signal) combination maps to exactly ONE FailureType
   */
  classify(gate: 1 | 2, dimension: string, signal: Signal): FailureType {
    // Infrastructure and timeout failures can occur at either gate
    if (dimension.startsWith('infrastructure_')) {
      return 'infrastructure_failure'
    }
    if (dimension.startsWith('timeout_')) {
      return 'timeout_failure'
    }

    // Gate 1: Pre-execution checks
    if (gate === 1) {
      if (dimension.startsWith('planning_')) {
        return 'planning_failure'
      }
      if (dimension.startsWith('schema_')) {
        return 'schema_failure'
      }
      if (dimension.startsWith('tool_')) {
        return 'tool_failure'
      }
    }

    // Gate 2: Post-execution checks
    if (gate === 2) {
      if (dimension.startsWith('reasoning_')) {
        return 'reasoning_failure'
      }
      if (dimension.startsWith('retrieval_')) {
        return 'retrieval_failure'
      }
      if (dimension.startsWith('novelty_')) {
        return 'novelty_failure'
      }
      if (dimension.startsWith('blob_write_')) {
        return 'blob_write_failure'
      }
    }

    // Default fallback (should not reach here with well-formed inputs)
    throw new Error(`Unable to classify failure: gate=${gate}, dimension=${dimension}`)
  }

  /**
   * Build type-specific retry addition string
   * Incorporates execution memory context for retry prompt composition
   */
  buildRetryAddition(failure_type: FailureType, execution_memory: ExecutionMemory): string {
    const attemptText = `Attempt ${execution_memory.attempts}`

    switch (failure_type) {
      case 'retrieval_failure':
        return `${attemptText}: Previous attempt failed to retrieve relevant context. Consider rephrasing your query or checking data sources.`

      case 'reasoning_failure':
        return `${attemptText}: Previous reasoning was insufficient. Review the logic and evidence more carefully.`

      case 'planning_failure':
        return `${attemptText}: Planning phase failed. Break down the task into smaller, clearer steps.`

      case 'tool_failure':
        return `${attemptText}: Tool execution failed. Verify tool parameters and availability.`

      case 'timeout_failure':
        return `${attemptText}: Operation timed out. Simplify the approach or increase timeout limits.`

      case 'novelty_failure':
        return `${attemptText}: Output novelty detection failed. Ensure meaningful changes from previous attempts.`

      case 'schema_failure':
        return `${attemptText}: Schema validation failed. Check output format against expected schema.`

      case 'infrastructure_failure':
        return `${attemptText}: Infrastructure error occurred. Retrying automatically (does not consume retry count).`

      case 'blob_write_failure':
        return `${attemptText}: Blob storage write failed. Retrying automatically (does not consume retry count).`

      default:
        // TypeScript exhaustiveness check
        const _exhaustive: never = failure_type
        throw new Error(`Unknown failure type: ${_exhaustive}`)
    }
  }

  /**
   * Check if failure type is exempt from retry count consumption
   * infrastructure_failure and blob_write_failure do NOT consume Inner Loop retry count
   */
  isRetryCountExempt(failure_type: FailureType): boolean {
    return failure_type === 'infrastructure_failure' || failure_type === 'blob_write_failure'
  }
}
