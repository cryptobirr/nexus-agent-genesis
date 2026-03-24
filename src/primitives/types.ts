/**
 * Budget type tracked by BudgetLedger
 */
export type BudgetType = "tokens" | "calls" | "wall_ms"

/**
 * Current budget state for a run
 */
export interface BudgetState {
  remaining: {
    tokens: number
    calls: number
    wall_ms: number
  }
  exceeded: boolean
  warning_threshold_hit: boolean
}

/**
 * Budget limits and thresholds for a run
 */
export interface BudgetLimits {
  tokens: number
  calls: number
  wall_ms: number
  warning_threshold: number  // 0.0 to 1.0 (e.g., 0.8 = 80%)
}
