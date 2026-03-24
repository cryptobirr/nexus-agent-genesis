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

/**
 * Tool definition for ToolRegistry
 */
export interface Tool {
  tool_id: string
  input_schema: object
  output_schema: object
  side_effect_class: string
  idempotent?: boolean  // default true - allows caching in ToolResultCache
}

/**
 * Injected toolset for scoped tool access
 */
export interface InjectedToolset {
  tools: Tool[]
  get(tool_id: string): Tool
  has(tool_id: string): boolean
}

/**
 * ToolNotFoundError - thrown when accessing unregistered tool
 */
export class ToolNotFoundError extends Error {
  constructor(public tool_id: string) {
    super(`Tool not found: ${tool_id}`)
    this.name = 'ToolNotFoundError'
  }
}

/**
 * Domain hint for context assembly and model routing
 */
export interface DomainHint {
  domain_id: string
  keywords: string[]
}

/**
 * Agent type for Contract lookup
 */
export type AgentType = "router" | "planner" | "executor"

/**
 * Strategy type for strategy-aware planning
 */
export type Strategy = "search" | "synthesize" | "transform" | "analyze" | "validate"

/**
 * Dimension - one independently evaluable quality
 */
export interface Dimension {
  dimension_id: string
  weight: number
  is_binary: boolean
  gate: 1 | 2
}

/**
 * Contract - versioned success specification per agent type
 */
export interface Contract {
  agent_type: AgentType
  dimensions: Dimension[]
}

/**
 * Priority level for requirements
 */
export type Priority = "high" | "medium" | "low"

/**
 * RequirementRecord - single requirement with coverage tracking
 */
export interface RequirementRecord {
  id: string
  description: string
  priority: Priority
  coverage_score: number  // 0.0 to 1.0
}

/**
 * RequirementMap - collection of requirements keyed by id
 */
export type RequirementMap = Map<string, RequirementRecord>

/**
 * CoverageResult - result of coverage check operation
 */
export interface CoverageResult {
  covered_count: number
  uncovered_count: number
  covered_ids: string[]
  uncovered_ids: string[]
}

/**
 * AgentNode - represents an agent execution node for coverage matching
 */
export interface AgentNode {
  node_id: string
  requirements_covered: string[]
}

/**
 * AgentResult - agent execution result for IdempotencyCache
 */
export interface AgentResult {
  success: boolean
  output?: any
}

/**
 * ToolResult - tool execution result for ToolResultCache (P-10)
 */
export interface ToolResult {
  success: boolean
  output?: any
  error?: string
}

/**
 * SuccessfulPattern - stored pattern for similarity-based plan cache and execution memory (P-11, P-18, P-20)
 */
export interface SuccessfulPattern {
  pattern_id: string
  type: "plan_decomposition" | "sec_write_sequence"
  objective_cluster: string
  domain: string | null
  strategy: string | null
  embedding: number[]
  embedding_model_id: string
  embedding_dimension: number
  artifact: string
  created_at: string
  run_id: string
}
