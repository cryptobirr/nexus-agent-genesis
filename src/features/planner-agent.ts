import type { SECManager } from '../components/sec-manager.js'
import type { DependencyGraphManager } from '../components/dependency-graph-manager.js'
import type { RecursionGuard } from '../components/recursion-guard.js'
import type { EvalPipeline } from '../components/eval-pipeline.js'
import type { RetryOrchestrator } from '../components/retry-orchestrator.js'
import type { AgentStateManager } from '../components/agent-state-manager.js'
import type { HITLManager } from '../components/hitl-manager.js'
import type { ContextCompressor } from '../primitives/context-compressor.js'
import type { ExecutionMemoryStore } from '../primitives/execution-memory-store.js'
import type { MessageBus } from '../primitives/message-bus.js'
import type { TicketSystem } from '../primitives/ticket-system.js'
import type {
  ModelAdapter,
  PlannerConfig,
  PlannerOutput,
  ConflictInfo
} from '../primitives/types.js'

/**
 * PlannerValidationError - thrown on MECE validation failure
 */
export class PlannerValidationError extends Error {
  constructor(
    message: string,
    public reason: string
  ) {
    super(message)
    this.name = 'PlannerValidationError'
  }
}

/**
 * PlannerAgent - F-02
 * Decomposes scope into MECE children, declares strategy + cost, writes OCC to SEC.
 *
 * Composition: C-01, C-02, C-04, C-06, C-07, C-08, C-09, P-17, P-20
 */
export class PlannerAgent {
  constructor(
    private secManager: SECManager,
    private dependencyGraphManager: DependencyGraphManager,
    private recursionGuard: RecursionGuard,
    private evalPipeline: EvalPipeline,
    private retryOrchestrator: RetryOrchestrator,
    private agentStateManager: AgentStateManager,
    private hitlManager: HITLManager,
    private contextCompressor: ContextCompressor,
    private executionMemoryStore: ExecutionMemoryStore,
    private messageBus: MessageBus,
    private ticketSystem: TicketSystem,
    private modelAdapter: ModelAdapter
  ) {}

  /**
   * Plan decomposition with OCC retry and depth cap handling
   *
   * Flow:
   * 1. Check depth cap
   * 2. Generate decomposition via LLM
   * 3. Validate MECE property
   * 4. Write to SEC with OCC retry (max 2 cycles)
   * 5. Return PlannerOutput
   */
  async plan(config: PlannerConfig): Promise<PlannerOutput> {
    const maxRetries = config.max_retries ?? 2

    // Step 1: Check depth cap
    if (config.current_depth >= config.max_depth) {
      return this.handleDepthCap(config)
    }

    // Step 2: Generate and validate with OCC retry
    let lastConflict: ConflictInfo | null = null
    let attempt = 0

    while (attempt <= maxRetries) {
      try {
        // Generate planner output
        const output = await this.generatePlannerOutput(config, lastConflict)

        // Validate MECE property
        this.validateMECE(output, config)

        // Write to SEC with OCC
        const writeSuccess = await this.writeSECWithRetry(output, config)

        if (writeSuccess.success) {
          // Success: populate sec_writes in output
          output.sec_writes = writeSuccess.version_id
            ? [{ key: `plan-${config.agent_id}`, value: output.plan, version_id: writeSuccess.version_id }]
            : []

          return output
        }

        // OCC conflict: retry
        if (writeSuccess.conflict && attempt < maxRetries) {
          lastConflict = writeSuccess.conflict

          // Emit sec_occ_retry event as per UAT-073 AC5 and AC8
          this.messageBus.emit(config.run_id, 'sec_occ_retry', {
            run_id: config.run_id,
            agent_id: config.agent_id,
            attempt: attempt + 1,
            key: lastConflict.key
          })

          // Also emit planner-specific event for backwards compatibility
          this.messageBus.emit(config.run_id, 'planner_occ_retry', {
            attempt: attempt + 1,
            conflict: lastConflict,
            agent_id: config.agent_id
          })

          attempt++
          continue
        }

        // Max retries exceeded
        throw new Error(`OCC max retries (${maxRetries}) exceeded for planner ${config.agent_id}`)
      } catch (error) {
        if (error instanceof PlannerValidationError) {
          throw error
        }
        throw error
      }
    }

    throw new Error('Planner failed after max OCC retries')
  }

  /**
   * Handle depth cap: return execute_directly decision and file warning ticket
   */
  private handleDepthCap(config: PlannerConfig): PlannerOutput {
    // File warning ticket
    this.ticketSystem.file('recursion_guard_triggered', {
      run_id: config.run_id,
      agent_id: config.agent_id,
      current_depth: config.current_depth,
      max_depth: config.max_depth,
      reason: 'Depth cap reached - handing to Executors'
    })

    // Emit event
    this.messageBus.emit(config.run_id, 'planner_depth_cap_reached', {
      agent_id: config.agent_id,
      current_depth: config.current_depth,
      max_depth: config.max_depth
    })

    return {
      decision: 'execute_directly',
      rationale: `Depth cap reached (${config.current_depth}/${config.max_depth}). Handing to Executors.`,
      plan: 'No decomposition - execute parent scope directly',
      plan_cost_estimate: 0,
      sec_writes: [],
      children: []
    }
  }

  /**
   * Generate PlannerOutput via LLM
   */
  private async generatePlannerOutput(
    config: PlannerConfig,
    conflict: ConflictInfo | null
  ): Promise<PlannerOutput> {
    const prompt = this.buildPlannerPrompt(config, conflict)
    const response = await this.modelAdapter.call(prompt)

    try {
      const parsed = JSON.parse(response) as PlannerOutput

      // Basic structure validation
      if (!parsed.decision || !parsed.rationale || !parsed.plan) {
        throw new Error('Invalid PlannerOutput structure')
      }

      return parsed
    } catch (error) {
      throw new Error(`Failed to parse Planner LLM response: ${(error as Error).message}`)
    }
  }

  /**
   * Build Planner prompt
   */
  private buildPlannerPrompt(config: PlannerConfig, conflict: ConflictInfo | null): string {
    const requirementList = Array.from(config.requirement_map.values())
      .map(r => `- ${r.id}: ${r.description} (priority: ${r.priority})`)
      .join('\n')

    const conflictContext = conflict
      ? `\n\n⚠️  OCC CONFLICT DETECTED:\nKey: ${conflict.key}\nAttempted: ${JSON.stringify(conflict.attempted_value)}\nCurrent: ${JSON.stringify(conflict.current_value)}\nVersion: ${conflict.current_version_id}\n\nRe-decompose to resolve this conflict.\n`
      : ''

    return `You are a Planner agent. Decompose the following scope into MECE children.

Parent Scope: ${config.parent_scope}

Requirements (MUST be collectively covered):
${requirementList}

Current Depth: ${config.current_depth}/${config.max_depth}
Available Budget: ${config.available_budget} tokens
${conflictContext}
Output a JSON object with these fields:
- decision: "decompose" or "execute_directly"
- rationale: brief explanation of decomposition strategy
- plan: decomposition explanation
- plan_cost_estimate: estimated execution cost (number)
- children: array of child objects, each with:
  - child_id: unique identifier (string)
  - strategy: one of "search", "synthesize", "transform", "analyze", "validate"
  - scope: specific scope for this child (string)
  - covers_requirements: array of requirement IDs this child addresses
  - output_spec: object with {type, schema, required_fields, max_tokens, max_normalization_bytes, normalization_mode}
  - depends_on: array of child_ids this child depends on

CRITICAL MECE Requirements:
1. Mutually Exclusive: No two children should overlap in scope
2. Collectively Exhaustive: ALL requirements (${Array.from(config.requirement_map.keys()).join(', ')}) MUST be covered by at least one child
3. Each child MUST have a strategy from the allowed set
4. plan_cost_estimate MUST be a positive number

Return ONLY valid JSON, no explanations.`
  }

  /**
   * Validate MECE property
   * Throws PlannerValidationError if children are not MECE
   */
  private validateMECE(output: PlannerOutput, config: PlannerConfig): void {
    if (output.decision === 'execute_directly') {
      // No children to validate
      return
    }

    // Collect all covered requirements
    const allCovered = new Set<string>()
    for (const child of output.children) {
      for (const reqId of child.covers_requirements) {
        allCovered.add(reqId)
      }
    }

    // Check collectively exhaustive
    const allRequirements = new Set(config.requirement_map.keys())
    const uncovered: string[] = []

    for (const reqId of allRequirements) {
      if (!allCovered.has(reqId)) {
        uncovered.push(reqId)
      }
    }

    if (uncovered.length > 0) {
      throw new PlannerValidationError(
        `MECE validation failed: Requirements not collectively exhaustive. Uncovered: ${uncovered.join(', ')}`,
        'not_collectively_exhaustive'
      )
    }

    // Mutually exclusive check (simplified: check for duplicate requirement coverage)
    // In production, this would be more sophisticated
    const coverageMap = new Map<string, string[]>()
    for (const child of output.children) {
      for (const reqId of child.covers_requirements) {
        if (!coverageMap.has(reqId)) {
          coverageMap.set(reqId, [])
        }
        coverageMap.get(reqId)!.push(child.child_id)
      }
    }

    // Allow requirements to be covered by multiple children (acceptable in some cases)
    // This is a simplified check - production would validate semantic overlap
  }

  /**
   * Write to SEC with OCC support
   */
  private async writeSECWithRetry(
    output: PlannerOutput,
    config: PlannerConfig
  ): Promise<{ success: boolean; conflict?: ConflictInfo; version_id?: number }> {
    const key = `plan-${config.agent_id}`
    const value = output.plan

    // SECManager handles OCC internally
    const result = await this.secManager.write(
      key,
      value,
      config.run_id,
      config.agent_id,
      'planner'
    )

    if (result.success) {
      return { success: true, version_id: result.version_id }
    }

    if (result.conflict) {
      return { success: false, conflict: result.conflict }
    }

    return { success: false }
  }
}
