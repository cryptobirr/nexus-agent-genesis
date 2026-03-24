import type { SandboxEnforcer } from '../components/sandbox-enforcer.js'
import type { EvalPipeline } from '../components/eval-pipeline.js'
import type { RetryOrchestrator } from '../components/retry-orchestrator.js'
import type { AgentStateManager } from '../components/agent-state-manager.js'
import type { HITLManager } from '../components/hitl-manager.js'
import type { BlobStore } from '../primitives/blob-store.js'
import type { IdempotencyCache } from '../primitives/idempotency-cache.js'
import type { ToolResultCache } from '../primitives/tool-result-cache.js'
import type { OutputNormalizer } from '../primitives/output-normalizer.js'
import type { ContextAssembler } from '../primitives/context-assembler.js'
import type { ContextCompressor } from '../primitives/context-compressor.js'
import type { ExecutionMemoryStore } from '../primitives/execution-memory-store.js'
import type { FailureClassifier } from '../primitives/failure-classifier.js'
import type { MessageBus } from '../primitives/message-bus.js'
import type { TicketSystem } from '../primitives/ticket-system.js'
import type { ToolRegistry } from '../primitives/tool-registry.js'
import type {
  ModelAdapter,
  ExecutorConfig,
  ExecutorOutput,
  ContextAssemblyPolicy,
  Strategy
} from '../primitives/types.js'
import crypto from 'crypto'

/**
 * ExecutorValidationError - thrown on validation failure
 */
export class ExecutorValidationError extends Error {
  constructor(
    message: string,
    public reason: string
  ) {
    super(message)
    this.name = 'ExecutorValidationError'
  }
}

/**
 * ExecutorAgent - F-03
 * Produces actual work product (llm_output or tool_call). Leaf node.
 *
 * Composition: C-05, C-06, C-07, C-08, C-09, P-03, P-09, P-10, P-14, P-16, P-17, P-20
 */
export class ExecutorAgent {
  constructor(
    private sandboxEnforcer: SandboxEnforcer,
    private evalPipeline: EvalPipeline,
    private retryOrchestrator: RetryOrchestrator,
    private agentStateManager: AgentStateManager,
    private hitlManager: HITLManager,
    private blobStore: BlobStore,
    private idempotencyCache: IdempotencyCache,
    private toolResultCache: ToolResultCache,
    private outputNormalizer: OutputNormalizer,
    private contextAssembler: ContextAssembler,
    private contextCompressor: ContextCompressor,
    private executionMemoryStore: ExecutionMemoryStore,
    private failureClassifier: FailureClassifier,
    private messageBus: MessageBus,
    private ticketSystem: TicketSystem,
    private toolRegistry: ToolRegistry,
    private modelAdapter: ModelAdapter
  ) {}

  /**
   * Execute work product generation
   *
   * Pre-generation pipeline (11 stages):
   * 1. HITL check
   * 2. ExecutionMemory cache check
   * 3. ContextAssembly
   * 4. Generate/Tool
   * 5. OutputNormalizer
   * 6. BlobStore routing
   * 7. FailureClassifier
   * 8. EvalPipeline
   * 9. ContextCompressor
   */
  async execute(config: ExecutorConfig): Promise<ExecutorOutput> {
    // Stage 1: HITL check
    if (await this.checkHITL(config)) {
      throw new ExecutorValidationError('HITL approval required but denied', 'hitl_rejected')
    }

    // Stage 2: ExecutionMemory cache check
    const cachedOutput = this.checkExecutionMemoryCache(config)
    if (cachedOutput) {
      this.messageBus.emit(config.run_id, 'executor_cache_hit', {
        agent_id: config.agent_id,
        from_cache: true
      })
      return cachedOutput
    }

    this.messageBus.emit(config.run_id, 'executor_cache_miss', {
      agent_id: config.agent_id
    })

    // Generate idempotency key
    const idempotencyKey = this.generateIdempotencyKey(config)

    // Get or create execution memory for this agent
    let executionMemory = this.executionMemoryStore.get(config.agent_id)
    if (!executionMemory) {
      executionMemory = this.executionMemoryStore.init(config.agent_id, config.run_id)
    }

    // Stage 3: ContextAssembly (with strategy modifications)
    const modifiedPolicy = this.applyStrategyModifications(
      config.strategy,
      config.context_assembly_policy,
      config.output_spec
    )

    let assembledContext
    if (this.shouldUseContextAssembly(config.strategy, config.output_spec)) {
      assembledContext = this.contextAssembler.assemble(modifiedPolicy, config.scope, executionMemory)
    }

    // Stage 4: Generate/Tool
    const rawOutput = await this.generate(config, assembledContext?.chunks || [])

    // Stage 5: OutputNormalizer
    const normalizationResult = this.outputNormalizer.normalize(rawOutput, config.output_spec)

    // Stage 7: FailureClassifier (before handling normalization failure)
    if (!normalizationResult.passed) {
      // Classify failure for normalization errors
      const failureType = this.failureClassifier.classify(1, 'schema_validation', 'low' as any)

      this.messageBus.emit(config.run_id, 'executor_failure_classified', {
        agent_id: config.agent_id,
        failure_type: failureType
      })
    }

    if (!normalizationResult.passed) {
      // Handle normalization failure
      await this.handleNormalizationFailure(config, normalizationResult.failure_reason || 'unknown')
    }

    // Stage 6: BlobStore routing
    const dataRefs = await this.routeToBlobStore(normalizationResult.normalized_output, config.output_spec, config.run_id)

    // Stage 8: EvalPipeline (with weight normalization)
    const evaluationScores = await this.evaluateContract(config, normalizationResult.normalized_output)

    // Stage 9: ContextCompressor
    // In production, would compress output to ChunkSummary for future retrieval
    // Skipped for now as it requires full AgentNode structure

    // Build output
    const output: ExecutorOutput = {
      mode: this.determineOutputMode(config.output_spec),
      content: normalizationResult.normalized_output,
      data_refs: dataRefs,
      idempotency_key: idempotencyKey,
      evaluation_scores: evaluationScores,
      normalization_passed: normalizationResult.passed,
      from_cache: false
    }

    // Store result in ExecutionMemory (update the existing memory with chunk IDs)
    if (assembledContext?.chunks) {
      const chunkIds = assembledContext.chunks.map((chunk: any) => chunk.chunk_id || String(chunk))
      executionMemory.retrieved_chunks = chunkIds
    }

    return output
  }

  /**
   * Stage 1: Check HITL gate
   * Returns true if HITL rejected
   */
  private async checkHITL(config: ExecutorConfig): Promise<boolean> {
    // For now, skip HITL checks (would be configured externally)
    // In production, this would check policy and pause execution
    return false
  }

  /**
   * Stage 2: Check ExecutionMemory cache
   * Returns cached output if found
   */
  private checkExecutionMemoryCache(config: ExecutorConfig): ExecutorOutput | null {
    // ExecutionMemory cache check via executionMemory.retrieved_chunks
    // This is handled in Stage 3 (ContextAssembler checks executionMemory.retrieved_chunks)
    // For now, return null (no separate cache lookup)
    return null
  }

  /**
   * Generate idempotency key
   * SHA-256(run_id + parent_id + scope + attempt_number)
   */
  private generateIdempotencyKey(config: ExecutorConfig): string {
    const input = `${config.run_id}${config.parent_id || ''}${config.scope}${config.attempt_number}`
    return crypto.createHash('sha256').update(input).digest('hex')
  }

  /**
   * Apply strategy-specific modifications to ContextAssemblyPolicy
   */
  private applyStrategyModifications(
    strategy: Strategy,
    policy: ContextAssemblyPolicy,
    outputSpec: any
  ): ContextAssemblyPolicy {
    const modified = { ...policy }

    switch (strategy) {
      case 'search':
        // relevance_threshold reduced by 0.15
        modified.relevance_threshold = Math.max(0, policy.relevance_threshold - 0.15)
        // diversity_penalty increased by 0.1
        modified.diversity_penalty = Math.min(1, policy.diversity_penalty + 0.1)
        break

      case 'synthesize':
        // diversity_penalty increased by 0.2
        modified.diversity_penalty = Math.min(1, policy.diversity_penalty + 0.2)
        // retrieval_sources expanded to all available (mock as adding 'all')
        modified.retrieval_sources = [...policy.retrieval_sources, 'all_sources']
        break

      case 'transform':
        // ContextAssembly disabled for json/artifact (handled in shouldUseContextAssembly)
        // retrieval_sources filtered to schema_reference only
        modified.retrieval_sources = ['schema_reference']
        break

      case 'analyze':
        // Standard ContextAssembly (no modifications)
        break

      case 'validate':
        // Restricted to schema and reference sources
        modified.retrieval_sources = ['schema_reference', 'documentation']
        break
    }

    return modified
  }

  /**
   * Determine if ContextAssembly should be used
   */
  private shouldUseContextAssembly(strategy: Strategy, outputSpec: any): boolean {
    // Transform strategy disables ContextAssembly for json/artifact
    if (strategy === 'transform' && (outputSpec.type === 'json' || outputSpec.type === 'artifact')) {
      return false
    }

    return true
  }

  /**
   * Stage 4: Generate output via LLM or tool
   */
  private async generate(config: ExecutorConfig, contextChunks: any[]): Promise<string> {
    const prompt = this.buildExecutionPrompt(config, contextChunks)

    // Call LLM
    const response = await this.modelAdapter.call(prompt)

    return response
  }

  /**
   * Build execution prompt with strategy-specific scaffolding
   */
  private buildExecutionPrompt(config: ExecutorConfig, contextChunks: any[]): string {
    let prompt = ''

    // Analyze strategy: inject CoT scaffold
    if (config.strategy === 'analyze') {
      prompt = 'Reason step by step before stating conclusions.\n\n'
    }

    prompt += `Scope: ${config.scope}\n\n`

    if (contextChunks.length > 0) {
      prompt += `Context:\n${contextChunks.map(c => c.text || '').join('\n')}\n\n`
    }

    prompt += `Strategy: ${config.strategy}\n`
    prompt += `Output specification: ${JSON.stringify(config.output_spec)}\n\n`
    prompt += `Generate output according to the scope and strategy.`

    return prompt
  }

  /**
   * Handle normalization failure
   * Validate strategy: immediate escalation (no retry)
   */
  private async handleNormalizationFailure(config: ExecutorConfig, reason: string): Promise<void> {
    if (config.strategy === 'validate') {
      // Immediate escalation for validate strategy
      this.ticketSystem.file('agent_escalated', {
        run_id: config.run_id,
        agent_id: config.agent_id,
        reason: `normalization_failure: ${reason}`
      })

      this.messageBus.emit(config.run_id, 'executor_normalization_escalated', {
        agent_id: config.agent_id,
        reason
      })

      throw new ExecutorValidationError(
        `Validate strategy normalization failure: ${reason}`,
        'validate_normalization_failure'
      )
    }

    // For other strategies: log as schema_failure and trigger retry
    this.messageBus.emit(config.run_id, 'plan_validation_runtime_divergence', {
      agent_id: config.agent_id,
      reason,
      strategy: config.strategy
    })

    throw new ExecutorValidationError(
      `Output divergence from spec: ${reason}`,
      'schema_failure'
    )
  }

  /**
   * Stage 6: Route to BlobStore if needed
   * Returns data_refs array
   */
  private async routeToBlobStore(output: unknown, outputSpec: any, runId: string): Promise<string[]> {
    // Only route json and artifact types
    if (outputSpec.type !== 'json' && outputSpec.type !== 'artifact') {
      return []
    }

    const dataRef = this.blobStore.write(
      runId,
      output,
      outputSpec.type
    )

    return [dataRef.ref_id]
  }

  /**
   * Stage 8: Evaluate Executor Contract with weight normalization
   */
  private async evaluateContract(config: ExecutorConfig, output: unknown): Promise<Record<string, number>> {
    const mode = this.determineOutputMode(config.output_spec)

    // Build dimensions based on mode
    const dimensions: Record<string, number> = {}

    if (mode === 'llm_output') {
      // llm_output dimensions
      dimensions.task_completion = 0.25
      dimensions.specificity = 0.15
      dimensions.substantiveness = 0.15
      dimensions.accuracy = 0.20
    } else {
      // tool_call dimensions
      dimensions.task_completion = 0.25
      dimensions.accuracy = 0.20
      dimensions.tool_verification = 0.15
    }

    // Add novelty for attempt 2+
    if (this.shouldEvaluateNovelty(config)) {
      dimensions.novelty = 0.10
    }

    // Add coherence for synthesize strategy (Gate 2)
    if (config.strategy === 'synthesize') {
      dimensions.coherence = 0.10
    }

    // Normalize weights
    const normalizedDimensions = this.normalizeWeights(dimensions, mode)

    // Call EvalPipeline (pass normalized dimensions)
    await this.evalPipeline.evaluate({
      agent_id: config.agent_id,
      agent_type: 'executor',
      output,
      dimensions: normalizedDimensions
    } as any)

    // Return normalized weights as evaluation scores
    return normalizedDimensions
  }

  /**
   * Determine output mode from output_spec
   */
  private determineOutputMode(outputSpec: any): 'llm_output' | 'tool_call' {
    if (outputSpec.type === 'tool_result') {
      return 'tool_call'
    }
    return 'llm_output'
  }

  /**
   * Check if novelty should be evaluated
   * Only on attempt 2+
   */
  private shouldEvaluateNovelty(config: ExecutorConfig): boolean {
    return config.attempt_number >= 2 && config.failed_strategies.length > 0
  }

  /**
   * Normalize weights based on mode
   * llm_output: 0.85 total
   * tool_call: 0.70 total
   */
  private normalizeWeights(
    dimensions: Record<string, number>,
    mode: 'llm_output' | 'tool_call'
  ): Record<string, number> {
    const targetSum = mode === 'llm_output' ? 0.85 : 0.70

    // Exclude novelty and coherence from base sum (they're Gate 2)
    const baseDimensions = Object.entries(dimensions).filter(
      ([key]) => key !== 'novelty' && key !== 'coherence'
    )

    const currentSum = baseDimensions.reduce((sum, [, weight]) => sum + weight, 0)

    // Normalize base dimensions to target sum
    const normalized: Record<string, number> = {}
    const scale = targetSum / currentSum

    for (const [key, weight] of baseDimensions) {
      normalized[key] = weight * scale
    }

    // Add Gate 2 dimensions without normalizing
    if ('novelty' in dimensions) {
      normalized.novelty = dimensions.novelty
    }
    if ('coherence' in dimensions) {
      normalized.coherence = dimensions.coherence
    }

    return normalized
  }
}
