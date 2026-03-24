import type { BudgetType, BudgetState, BudgetLimits } from './types.js'

/**
 * BudgetLedger - P-01
 * Track and enforce token, inference, and wall-time budgets per Run.
 *
 * Zero dependencies. Thread-safe via single-threaded event loop.
 */
export class BudgetLedger {
  private budgets = new Map<string, BudgetLimits>()
  private consumption = new Map<string, { tokens: number; calls: number; wall_ms: number }>()

  /**
   * Initialize budget limits for a run
   */
  init(run_id: string, limits: BudgetLimits): void {
    if (limits.warning_threshold < 0 || limits.warning_threshold > 1) {
      throw new Error('warning_threshold must be between 0.0 and 1.0')
    }
    if (limits.tokens < 0 || limits.calls < 0 || limits.wall_ms < 0) {
      throw new Error('Budget limits must be non-negative')
    }

    this.budgets.set(run_id, limits)
    this.consumption.set(run_id, { tokens: 0, calls: 0, wall_ms: 0 })
  }

  /**
   * Consume budget for a run
   * Thread-safe via atomic increment pattern (single-threaded event loop)
   */
  consume(run_id: string, type: BudgetType, amount: number): void {
    if (amount < 0) {
      throw new Error('Amount must be non-negative')
    }

    const consumption = this.consumption.get(run_id)
    if (!consumption) {
      throw new Error(`Budget not initialized for run_id: ${run_id}`)
    }

    // Atomic increment (safe in single-threaded Node.js event loop)
    consumption[type] += amount
  }

  /**
   * Check current budget state for a run
   * Returns remaining budget, exceeded status, and warning threshold status
   */
  check(run_id: string): BudgetState {
    const limits = this.budgets.get(run_id)
    const consumption = this.consumption.get(run_id)

    if (!limits || !consumption) {
      throw new Error(`Budget not initialized for run_id: ${run_id}`)
    }

    const remaining = {
      tokens: limits.tokens - consumption.tokens,
      calls: limits.calls - consumption.calls,
      wall_ms: limits.wall_ms - consumption.wall_ms
    }

    // Check if any budget type exceeded
    const exceeded =
      consumption.tokens >= limits.tokens ||
      consumption.calls >= limits.calls ||
      consumption.wall_ms >= limits.wall_ms

    // Check if any budget type hit warning threshold
    const warning_threshold_hit =
      consumption.tokens >= limits.tokens * limits.warning_threshold ||
      consumption.calls >= limits.calls * limits.warning_threshold ||
      consumption.wall_ms >= limits.wall_ms * limits.warning_threshold

    return {
      remaining,
      exceeded,
      warning_threshold_hit
    }
  }

  /**
   * Reset budget consumption for a run
   * Preserves limits, clears consumption
   */
  reset(run_id: string): void {
    const limits = this.budgets.get(run_id)
    if (!limits) {
      throw new Error(`Budget not initialized for run_id: ${run_id}`)
    }

    this.consumption.set(run_id, { tokens: 0, calls: 0, wall_ms: 0 })
  }
}
