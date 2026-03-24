import type { RequirementExtractor } from '../primitives/requirement-extractor.js'
import type { PlanCache } from '../primitives/plan-cache.js'
import type { DependencyGraphManager } from '../components/dependency-graph-manager.js'
import type { PlanValidator } from '../components/plan-validator.js'
import type { EvalPipeline } from '../components/eval-pipeline.js'
import type { EmbeddingEngine } from '../primitives/embedding-engine.js'
import type { MessageBus } from '../primitives/message-bus.js'
import type {
  ModelAdapter,
  RouterConfig,
  RouterOutput,
  RequirementMap,
  DependencyGraph,
  AgentNode
} from '../primitives/types.js'

/**
 * RouterValidationError - thrown on fatal PLAN VALIDATOR failure
 */
export class RouterValidationError extends Error {
  constructor(
    message: string,
    public failures: any[]
  ) {
    super(message)
    this.name = 'RouterValidationError'
  }
}

/**
 * RouterAgent - F-01
 * Entry point that classifies complexity, extracts RequirementMap, checks PlanCache,
 * builds DependencyGraph, emits plan_cost_estimate, and routes to direct or plan.
 *
 * Composition: P-08, P-18, C-02, C-03, C-06, P-11
 */
export class RouterAgent {
  constructor(
    private requirementExtractor: RequirementExtractor,
    private planCache: PlanCache,
    private dependencyGraphManager: DependencyGraphManager,
    private planValidator: PlanValidator,
    private evalPipeline: EvalPipeline,
    private embeddingEngine: EmbeddingEngine,
    private messageBus: MessageBus,
    private modelAdapter: ModelAdapter
  ) {}

  /**
   * Route objective to direct execution or planning
   * Returns RouterOutput after validation
   *
   * Flow:
   * 1. Generate objective embedding
   * 2. Check PlanCache
   * 3. If cache hit: return cached output
   * 4. If cache miss: generate new output via LLM
   * 5. Validate with PlanValidator
   * 6. Retry once on fixable failure
   * 7. Throw on fatal failure
   */
  async route(config: RouterConfig): Promise<RouterOutput> {
    const maxRetries = config.max_retries ?? 1

    // Step 1: Generate objective embedding
    const objectiveEmbedding = this.embeddingEngine.embed(config.objective)

    // Step 2: Check PlanCache
    const cachedEntry = this.planCache.lookup(
      objectiveEmbedding,
      config.run_config_hash,
      config.embedding_model_id
    )

    if (cachedEntry) {
      // Cache hit: emit event and return cached output
      this.messageBus.emit(config.run_id, 'router_cache_hit', {
        similarity_score: cachedEntry.similarity_score,
        cached_run_id: cachedEntry.run_id,
        objective: config.objective
      })

      return cachedEntry.router_output as RouterOutput
    }

    // Cache miss: emit event
    this.messageBus.emit(config.run_id, 'router_cache_miss', {
      objective: config.objective
    })

    // Step 3: Generate and validate output (with retry)
    let lastError: Error | null = null
    let attempt = 0

    while (attempt <= maxRetries) {
      try {
        // Generate Router output via LLM
        const output = await this.generateRouterOutput(config.objective, config.run_id)

        // Validate output
        this.validateOutput(output, config)

        // Success: write to cache and return
        const requirementMap = this.extractRequirementMap(output)

        this.planCache.write(
          config.run_id,
          config.objective,
          objectiveEmbedding,
          config.embedding_model_id,
          output,
          output.dependencies,
          requirementMap,
          config.run_config_hash
        )

        return output
      } catch (error) {
        lastError = error as Error

        if (error instanceof RouterValidationError) {
          // Check if retryable (fixable failures only)
          const hasOnlyFixableFailures = error.failures.every(
            (f: any) => f.severity === 'fixable'
          )

          if (hasOnlyFixableFailures && attempt < maxRetries) {
            // Emit retry event
            this.messageBus.emit(config.run_id, 'router_retry_triggered', {
              attempt: attempt + 1,
              reason: 'fixable_validation_failure',
              failures: error.failures
            })

            attempt++
            continue
          }

          // Fatal or retry exhausted
          this.messageBus.emit(config.run_id, 'router_validation_failed', {
            attempt,
            failures: error.failures,
            fatal: !hasOnlyFixableFailures
          })

          throw error
        }

        // Other errors: throw immediately
        throw error
      }
    }

    // Should never reach here, but throw last error if we do
    throw lastError ?? new Error('Router failed after max retries')
  }

  /**
   * Generate Router output via LLM
   */
  private async generateRouterOutput(
    objective: string,
    runId: string
  ): Promise<RouterOutput> {
    const prompt = this.buildRouterPrompt(objective)
    const response = await this.modelAdapter.call(prompt)

    try {
      const parsed = JSON.parse(response) as RouterOutput

      // Basic structure validation
      if (!parsed.routing || !parsed.complexity_classification || !parsed.requirements) {
        throw new Error('Invalid Router output structure')
      }

      // Ensure run_id is set in dependencies
      if (parsed.dependencies) {
        parsed.dependencies.run_id = runId
      }

      return parsed
    } catch (error) {
      throw new Error(`Failed to parse Router LLM response: ${(error as Error).message}`)
    }
  }

  /**
   * Build Router prompt
   */
  private buildRouterPrompt(objective: string): string {
    return `You are a Router agent. Analyze the following objective and produce a routing decision.

Objective: ${objective}

Output a JSON object with these fields:
- routing: "direct" or "plan"
- depth_hint: estimated decomposition depth (integer >= 0)
- complexity_classification: one of "atomic", "simple", "moderate", "complex"
- rationale: brief explanation of classification
- objective_refined: refined version of objective
- constraints: array of constraint strings
- requirements: array of 3-7 requirement objects with {id, description, priority}
- dependencies: object with {run_id, nodes, edges}
- plan_cost_estimate: estimated execution cost (number)

Requirements:
- MUST have exactly 3-7 requirements
- Each requirement MUST have: id (string), description (string), priority ("high"|"medium"|"low")
- complexity_classification MUST be exactly one of: "atomic", "simple", "moderate", "complex"
- depth_hint MUST be non-negative integer
- dependencies.nodes MUST be array of node IDs
- dependencies.edges MUST be array of edge objects with {from_node_id, to_node_id, edge_type, timeout_ms, on_timeout}

Return ONLY valid JSON, no explanations.`
  }

  /**
   * Validate Router output with PlanValidator
   * Throws RouterValidationError on validation failure
   */
  private validateOutput(output: RouterOutput, config: RouterConfig): void {
    // Validate requirements count (3-7)
    if (output.requirements.length < 3 || output.requirements.length > 7) {
      throw new RouterValidationError(
        `Requirements count ${output.requirements.length} outside valid range [3,7]`,
        [{ check: 'requirement_count', severity: 'fatal' }]
      )
    }

    // Validate complexity_classification vocabulary
    const validComplexities = ['atomic', 'simple', 'moderate', 'complex']
    if (!validComplexities.includes(output.complexity_classification)) {
      throw new RouterValidationError(
        `Invalid complexity_classification: ${output.complexity_classification}`,
        [{ check: 'complexity_vocabulary', severity: 'fatal' }]
      )
    }

    // Validate depth_hint
    if (output.depth_hint < 0 || !Number.isInteger(output.depth_hint)) {
      throw new RouterValidationError(
        `Invalid depth_hint: ${output.depth_hint}`,
        [{ check: 'depth_hint_format', severity: 'fatal' }]
      )
    }

    // Extract RequirementMap
    const requirementMap = this.extractRequirementMap(output)

    // Build agent nodes from dependency graph (mark all nodes as covering all requirements)
    // This is the initial Router plan - actual coverage tracking happens during execution
    const agentNodes: AgentNode[] = output.dependencies.nodes.map(nodeId => ({
      node_id: nodeId,
      requirements_covered: Array.from(requirementMap.keys())
    }))

    // Run PlanValidator
    const validationResult = this.planValidator.validate(
      output.dependencies,
      requirementMap,
      agentNodes,
      output.plan_cost_estimate,
      output.depth_hint
    )

    if (!validationResult.valid) {
      // Emit validation failure event
      this.messageBus.emit(config.run_id, 'router_validation_failed', {
        failures: validationResult.failures,
        retryable: validationResult.retryable
      })

      throw new RouterValidationError(
        'Router output failed PLAN VALIDATOR checks',
        validationResult.failures
      )
    }
  }

  /**
   * Extract RequirementMap from Router output
   */
  private extractRequirementMap(output: RouterOutput): RequirementMap {
    const map: RequirementMap = new Map()

    for (const req of output.requirements) {
      map.set(req.id, {
        id: req.id,
        description: req.description,
        priority: req.priority,
        coverage_score: 0
      })
    }

    return map
  }
}
