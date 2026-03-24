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

/**
 * SEC (Shared Execution Context) entry
 */
export interface SECEntry {
  key: string
  value: any
  version_id: number
  run_id: string
}

/**
 * SEC snapshot - consistent version vector across keys
 */
export type SECSnapshot = Map<string, number>

/**
 * Compare-and-swap result
 */
export interface CASResult {
  success: boolean
  current_version_id: number
}

/**
 * DataRef - reference to blob in BlobStore
 */
export interface DataRef {
  ref_id: string
  schema: string
  size_bytes: number
}

/**
 * BlobNotFoundError - thrown when reading non-existent blob
 */
export class BlobNotFoundError extends Error {
  constructor(public ref_id: string) {
    super(`Blob not found: ${ref_id}`)
    this.name = 'BlobNotFoundError'
  }
}

/**
 * Event emitted through MessageBus
 */
export interface Event {
  event_type: string
  payload: object
  run_id: string
  timestamp: number
}

/**
 * Event handler function
 */
export type EventHandler = (event_type: string, payload: object) => void

/**
 * Unsubscribe function returned by subscribe()
 */
export type UnsubscribeFn = () => void
