import { createHash } from 'crypto'
import type { ContractRegistry } from '../primitives/contract-registry.js'
import type { ToolRegistry } from '../primitives/tool-registry.js'
import type { DomainRegistry } from '../primitives/domain-registry.js'
import type { RunConfig } from '../primitives/types.js'

/**
 * ConfigModule - M-04
 * Runtime config management — all policies injectable and overridable per run.
 *
 * Composition: P-07 (ContractRegistry), P-05 (ToolRegistry), P-06 (DomainRegistry)
 *
 * Acceptance Criteria:
 * - All policies configurable at runtime (per-run override)
 * - Contract version change invalidates PlanCache (hash changes)
 * - Tool registry change invalidates PlanCache (hash changes)
 * - RunConfig.run_config_hash computed from all policy fields
 */
export class ConfigModule {
  private contractRegistry: ContractRegistry
  private toolRegistry: ToolRegistry
  private domainRegistry: DomainRegistry

  constructor(
    contractRegistry: ContractRegistry,
    toolRegistry: ToolRegistry,
    domainRegistry: DomainRegistry
  ) {
    this.contractRegistry = contractRegistry
    this.toolRegistry = toolRegistry
    this.domainRegistry = domainRegistry
  }

  /**
   * Create RunConfig with default values and optional overrides
   * All policies have sensible defaults, overridable per run
   *
   * @param overrides - Partial RunConfig to override defaults
   * @returns Complete RunConfig with defaults + overrides
   */
  createRunConfig(overrides?: Partial<RunConfig>): RunConfig {
    const defaults: RunConfig = {
      // Budget policy
      budget_policy: {
        limits: {
          tokens: 10000,
          calls: 100,
          wall_ms: 60000,
          warning_threshold: 0.8
        },
        enforcement_mode: 'hard'
      },

      // Repair policy
      repair_policy: {
        max_retries: 3,
        backoff_strategy: 'exponential',
        initial_delay_ms: 1000
      },

      // Judging policy
      judging_policy: {
        mode: 'adaptive',
        skip_non_binary: false,
        adaptive_skip_threshold: 0.8
      },

      // Context assembly policy
      context_assembly_policy: {
        ranking_model: 'embedding',
        diversity_penalty: 0.3,
        max_chunks: 10,
        relevance_threshold: 0.7,
        retrieval_sources: ['schema_reference', 'documentation']
      },

      // Compression policy
      compression_policy: {
        enabled: true,
        min_tokens_for_compression: 1000,
        compression_ratio_target: 0.5
      },

      // Depth policy
      depth_policy: {
        max_depth: 5,
        adaptive_enabled: true,
        depth_budget_tokens: 5000
      },

      // Early termination policy
      early_termination_policy: {
        enabled: true,
        conditions: ['budget_exceeded', 'objective_met']
      },

      // Model policy
      model_policy: {
        default_model: 'gpt-3.5-turbo'
      },

      // Merged judge policy
      merged_judge_policy: {
        merge_strategy: 'majority',
        judge_count: 3
      },

      // Blob store policy
      blob_store_policy: {
        provider: 'memory',
        max_blob_size_bytes: 10_000_000 // 10 MB
      },

      // Parallelism policy
      parallelism_policy: {
        max_concurrent_agents: 5
      },

      // Latency SLA policy
      latency_sla_policy: {
        budgets: {
          executor: 30000,
          planner: 20000,
          router: 10000
        },
        on_violation: 'degrade'
      },

      // Sandbox config
      sandbox_config: {
        enabled: true,
        allowed_domains: ['localhost', 'api.example.com'],
        blocked_commands: ['rm', 'shutdown'],
        resource_limits: {
          max_memory_mb: 512,
          max_cpu_percent: 80
        }
      },

      // Conflict resolution policy
      conflict_resolution_policy: 'escalate',

      // Recursion guard
      recursion_guard: {
        max_depth: 10,
        max_iterations: 100
      },

      // Kill switch
      kill_switch: {
        enabled: true,
        conditions: ['critical_error', 'security_violation']
      }
    }

    // Deep merge overrides with defaults
    const config: RunConfig = this.deepMerge(defaults, overrides || {})

    return config
  }

  /**
   * Compute stable hash from RunConfig + registry states
   * Hash includes all policy fields + contract registry state + tool registry state
   * Changes to contracts or tools invalidate PlanCache (different hash)
   *
   * @param config - RunConfig to hash
   * @returns SHA-256 hash (hex string)
   */
  computeConfigHash(config: RunConfig): string {
    // Serialize config (exclude run_config_hash to avoid circular dependency)
    const { run_config_hash, contract_registry_version, tool_registry_version, ...configToHash } = config

    // Get registry states (deterministic serialization)
    const contractState = this.serializeContractRegistry()
    const toolState = this.serializeToolRegistry()

    // Combine into single object for hashing
    const hashInput = {
      config: configToHash,
      contracts: contractState,
      tools: toolState
    }

    // Stable JSON serialization (sorted keys)
    const stableJson = this.stableStringify(hashInput)

    // SHA-256 hash
    const hash = createHash('sha256').update(stableJson).digest('hex')

    return hash
  }

  /**
   * Serialize ContractRegistry state for hashing
   * Private contracts are not exposed, so we use reflection
   */
  private serializeContractRegistry(): any {
    // Access private contracts map via reflection
    const registry = this.contractRegistry as any
    const contracts = registry.contracts as Map<string, any>

    // Convert to sorted array for stable serialization
    const contractArray = Array.from(contracts.entries()).sort((a, b) => a[0].localeCompare(b[0]))

    return contractArray
  }

  /**
   * Serialize ToolRegistry state for hashing
   */
  private serializeToolRegistry(): any {
    // Get all tools via public list() method
    const tools = this.toolRegistry.list()

    // Sort by tool_id for stable serialization
    const sortedTools = tools.sort((a, b) => a.tool_id.localeCompare(b.tool_id))

    return sortedTools
  }

  /**
   * Stable JSON stringification with sorted keys
   * Ensures deterministic hash for same logical config
   */
  private stableStringify(obj: any): string {
    if (obj === null) return 'null'
    if (obj === undefined) return 'undefined'
    if (typeof obj !== 'object') return JSON.stringify(obj)

    if (Array.isArray(obj)) {
      return '[' + obj.map(item => this.stableStringify(item)).join(',') + ']'
    }

    // Sort object keys for deterministic serialization
    const sortedKeys = Object.keys(obj).sort()
    const pairs = sortedKeys.map(key => {
      return JSON.stringify(key) + ':' + this.stableStringify(obj[key])
    })

    return '{' + pairs.join(',') + '}'
  }

  /**
   * Deep merge two objects (used for config overrides)
   */
  private deepMerge<T extends Record<string, any>>(target: T, source: Partial<T>): T {
    const result = { ...target }

    for (const key in source) {
      if (source.hasOwnProperty(key)) {
        const sourceValue = source[key]
        const targetValue = result[key]

        if (this.isPlainObject(sourceValue) && this.isPlainObject(targetValue)) {
          result[key] = this.deepMerge(targetValue, sourceValue)
        } else {
          result[key] = sourceValue as any
        }
      }
    }

    return result
  }

  /**
   * Check if value is a plain object (not array, null, etc.)
   */
  private isPlainObject(value: any): boolean {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
  }
}
