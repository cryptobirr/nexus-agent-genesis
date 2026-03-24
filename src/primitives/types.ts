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
 * AgentNode - represents an agent execution node for coverage matching and compression
 */
export interface AgentNode {
  node_id: string
  requirements_covered: string[]
  output?: string  // Agent output (text or structured)
  data_refs?: DataRef[]  // References to blob store
  is_escalated?: boolean  // Escalation flag for compression bypass
  agent_type?: AgentType  // For contract lookup in PlanValidator (C-03)
  output_spec?: OutputSpec  // For output_contract satisfiability check (C-03)
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

/**
 * PreCheckResult - result of DeterministicPreCheck validation (P-12)
 */
export interface PreCheckResult {
  passed: boolean
  violations: string[]
}

/**
 * FailureType - P-13: Deterministic failure type classification
 */
export type FailureType =
  | 'retrieval_failure'
  | 'reasoning_failure'
  | 'planning_failure'
  | 'tool_failure'
  | 'timeout_failure'
  | 'novelty_failure'
  | 'schema_failure'
  | 'infrastructure_failure'
  | 'blob_write_failure'

/**
 * Signal - Judge verdict for a single Dimension (P-15)
 */
export interface Signal {
  verdict: boolean
  numeric_score: number
  gap: number
  severity: 'low' | 'medium' | 'high' | 'critical'
  reasoning: string
}

/**
 * JudgeContext - Execution context for Judge evaluation (P-15)
 */
export interface JudgeContext {
  agent_output: string
  dimension_criteria: Map<string, string>
  run_id: string
}

/**
 * ModelAdapter - LLM interface for P-15 (JudgeRunner) and P-17 (ContextCompressor)
 */
export interface ModelAdapter {
  call(prompt: string): Promise<string>
  getContextWindowSize(): number
  estimateTokens(text: string): number
}

/**
 * FailedStrategy - Record of a failed attempt for retry prompts (P-20, C-07)
 */
export interface FailedStrategy {
  attempt: number
  failure_type: FailureType
  gate: 1 | 2 | 'precheck'
  gap: string
  output?: string
}

/**
 * ExecutionMemory - Per-node, per-run short-term cache (P-20)
 * Stores retrieved chunks, failed strategies, and successful patterns for retry/context assembly
 */
export interface ExecutionMemory {
  agent_id: string
  run_id: string
  retrieved_chunks: string[]  // chunk_ids, max 500, LRU eviction
  failed_strategies: FailedStrategy[]  // max max_retries
  successful_patterns: SuccessfulPattern[]  // loaded at init from Meta Loop
}

/**
 * ContextChunk - Single chunk of context for assembly (P-16)
 */
export interface ContextChunk {
  chunk_id: string
  content: string
  source: string
  embedding?: number[]
  base_relevance_score?: number
}

/**
 * ContextAssemblyPolicy - Configuration for context retrieval (P-16)
 */
export interface ContextAssemblyPolicy {
  ranking_model: "embedding" | "cross_encoder"
  diversity_penalty: number  // 0-1 scalar
  max_chunks: number
  relevance_threshold: number
  retrieval_sources: string[]  // e.g., ["schema_reference", "documentation"]
  strategy?: Strategy  // Optional strategy override
  available_chunks?: ContextChunk[]  // Chunks to rank (for testing/mocking)
}

/**
 * AssembledContext - Output of ContextAssembler.assemble() (P-16)
 */
export interface AssembledContext {
  chunks: ContextChunk[]
  from_cache: boolean
  total_tokens?: number
}

/**
 * OutputSpec - Schema declaration for Executor output (P-14)
 */
export interface OutputSpec {
  type: "text" | "json" | "code" | "artifact" | "tool_result"
  schema: string | null  // JSON schema as string
  required_fields: string[]
  max_tokens: number | null
  max_normalization_bytes: number
  normalization_mode: "strict" | "structural_only" | "passthrough"
}

/**
 * NormalizationResult - Result of OutputNormalizer.normalize() (P-14)
 */
export interface NormalizationResult {
  normalized_output: unknown
  passed: boolean
  failure_reason: string | null
}

/**
 * ChunkSummary - Compressed representation of agent output (P-17)
 */
export interface ChunkSummary {
  node_id: string
  summary: string  // LLM-generated for text, empty for data_refs
  data_refs: DataRef[]  // Blob store references (bypasses compression)
  is_escalated: boolean  // If true, never compressed
  full_content?: string  // Only populated for escalated nodes
}

/**
 * PlanCacheEntry - cached Router output indexed by objective embedding (P-18)
 */
export interface PlanCacheEntry {
  objective_embedding: number[]
  objective_text: string
  run_config_hash: string
  embedding_model_id: string
  router_output: any
  dependency_graph: any
  requirement_map: RequirementMap
  run_id: string
  similarity_score?: number  // Populated on cache hit
}

/**
 * TriggerType - P-19: Ticket trigger types
 */
export type TriggerType =
  | 'occ_max_retries_exceeded'
  | 'sec_size_warning'
  | 'kill_switch_triggered'
  | 'recursion_guard_triggered'
  | 'recursion_guard_scope_override'
  | 'depth_expansion_suppressed'
  | 'sandbox_violation'
  | 'budget_exceeded'
  | 'infrastructure_failure'

/**
 * Severity - P-19: Ticket severity levels
 */
export type Severity = 'CRITICAL' | 'MAJOR' | 'MINOR'

/**
 * TicketContext - P-19: Context for ticket filing
 */
export interface TicketContext {
  run_id: string
  agent_id?: string  // Optional - run-level tickets don't have agent_id
  failure_gate?: 1 | 2 | 'precheck'  // Optional
  failure_type?: FailureType  // Optional - from P-13
  [key: string]: any  // Allow additional context fields
}

/**
 * Ticket - P-19: Structured ticket for routing to external providers
 */
export interface Ticket {
  ticket_id: string  // UUID
  ticket_type: TriggerType
  severity: Severity
  run_id: string
  agent_id?: string
  failure_gate?: 1 | 2 | 'precheck'
  failure_type?: FailureType
  context: TicketContext
  filed_at: string  // ISO timestamp
  status: 'open' | 'resolved' | 'suppressed'
}

/**
 * TicketProvider - P-19: Supported ticket routing providers
 */
export type TicketProvider = 'InMemory' | 'GitHub' | 'Jira' | 'Linear' | 'Webhook'

/**
 * ProviderConfig - P-19: Configuration for ticket provider
 */
export interface ProviderConfig {
  provider: TicketProvider
  config?: any  // Provider-specific config (e.g., GitHub repo, Jira project)
}

/**
 * ConflictResolutionPolicy - C-01: SECManager conflict resolution strategy
 */
export type ConflictResolutionPolicy = 'reject' | 'merge' | 'priority' | 'escalate'

/**
 * AgentRole - C-01: Agent role for access control
 */
export type AgentRole = 'planner' | 'executor' | 'router'

/**
 * SECConfig - C-01: Configuration for SECManager
 */
export interface SECConfig {
  max_occ_retries: number           // default 2
  SEC_list_max_entries: number      // default 10000
  default_policy: ConflictResolutionPolicy  // default 'merge'
}

/**
 * ConflictInfo - C-01: Information about an OCC conflict
 */
export interface ConflictInfo {
  key: string
  attempted_value: any
  current_value: any
  current_version_id: number
}

/**
 * WriteResult - C-01: Result of SECManager write operation
 */
export interface WriteResult {
  success: boolean
  version_id?: number
  conflict?: ConflictInfo
  escalated?: boolean
  requires_redecompose?: boolean  // True if merge resulted in structural change
}

/**
 * ReadResult - C-01: Result of SECManager read operation
 */
export interface ReadResult {
  value: any
  version_id: number
}

/**
 * DependencyEdge - C-02: Edge in dependency graph
 */
export interface DependencyEdge {
  from_node_id: string  // Prerequisite agent
  to_node_id: string    // Dependent agent
  edge_type: "data" | "control" | "output"
  timeout_ms: number | null  // TTL for prerequisite completion
  on_timeout: "fail" | "proceed_degraded" | null
  fallback_payload?: any  // Used when on_timeout="proceed_degraded"
  output_contract?: OutputSpec | null  // For "output" edges
}

/**
 * DependencyGraph - C-02: Collection of nodes and edges
 */
export interface DependencyGraph {
  nodes: string[]  // Node IDs
  edges: DependencyEdge[]
  run_id: string
}

/**
 * ValidationResult - C-02: Result of DAG validation
 */
export interface ValidationResult {
  valid: boolean
  cycles: string[][]  // List of cycles found, e.g., [["A", "B", "C", "A"]]
  orphans: string[]   // Nodes with no path to root
  errors: string[]
}

/**
 * TopologicalOrder - C-02: Result of topological sort
 */
export interface TopologicalOrder {
  order: string[]  // Nodes in execution order
  levels: Map<string, number>  // Node → depth from root
}

/**
 * DependencyGraphConfig - C-02: Configuration for DependencyGraphManager
 */
export interface DependencyGraphConfig {
  enable_ttl_monitoring: boolean  // default true
  default_timeout_behavior: "fail" | "proceed_degraded"  // default "fail"
}

/**
 * PlanValidationCheckType - C-03: Types of validation checks performed by PlanValidator
 */
export type PlanValidationCheckType =
  | 'acyclicity'
  | 'output_contract_satisfiability'
  | 'coverage_completeness'
  | 'cost_bounds'
  | 'depth_cap'
  | 'orphan_detection'

/**
 * FailureSeverity - C-03: Severity classification for validation failures
 */
export type FailureSeverity = 'fatal' | 'fixable'

/**
 * ValidationFailure - C-03: Single validation check failure
 */
export interface ValidationFailure {
  check: PlanValidationCheckType
  severity: FailureSeverity
  message: string
  details?: any
}

/**
 * PlanValidationResult - C-03: Result of PlanValidator.validate()
 */
export interface PlanValidationResult {
  valid: boolean
  failures: ValidationFailure[]
  retryable: boolean  // true if all failures are fixable, false if any fatal
}

/**
 * PlanValidatorConfig - C-03: Configuration for PlanValidator
 */
export interface PlanValidatorConfig {
  max_plan_cost: number          // default 1000
  cost_tolerance: number         // default 1.2 (20% over budget is fixable)
  max_depth: number              // default 5
  allow_decomposable_depth: boolean  // default true (depth > max is fixable)
}
