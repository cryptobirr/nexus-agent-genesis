import type { Dimension, JudgeContext, ModelAdapter, Signal } from './types.js'

/**
 * MessageBus interface (minimal subset for logging)
 */
interface MessageBus {
  emit(event_type: string, payload: object): void
}

/**
 * JudgeRunner - P-15
 * Execute a single Judge call for one Dimension. Returns Signal.
 *
 * Zero dependencies. Makes LLM calls via injected model adapter.
 */
export class JudgeRunner {
  constructor(
    private modelAdapter: ModelAdapter,
    private messageBus?: MessageBus
  ) {}

  /**
   * Execute Judge call for a single Dimension
   */
  async run(dimension: Dimension, context: JudgeContext): Promise<Signal> {
    const prompt = this.buildSinglePrompt(dimension, context)
    const response = await this.modelAdapter.call(prompt)
    return this.parseSignalFromResponse(response)
  }

  /**
   * Execute batched Judge call for multiple Dimensions
   * Falls back to isolated calls on malformed JSON or timeout
   */
  async runMerged(dimensions: Dimension[], context: JudgeContext): Promise<Signal[]> {
    if (dimensions.length === 0) {
      return []
    }

    // Check if we should auto-exclude accuracy due to context window constraints
    const filteredDimensions = this.filterDimensionsForMerge(dimensions, context)

    // If auto-exclusion removed accuracy, we need to handle it separately
    const excludedDimensions = dimensions.filter(
      d => !filteredDimensions.some(fd => fd.dimension_id === d.dimension_id)
    )

    try {
      // Attempt merged call
      const prompt = this.buildMergedPrompt(filteredDimensions, context)
      const response = await this.modelAdapter.call(prompt)
      const signals = this.parseSignalArrayFromResponse(response)

      // Validate we got the right number of signals
      if (signals.length !== filteredDimensions.length) {
        throw new Error('Signal count mismatch')
      }

      // Handle excluded dimensions with isolated calls
      const excludedSignals = await Promise.all(
        excludedDimensions.map(d => this.run(d, context))
      )

      // Merge results in original order
      const signalMap = new Map<string, Signal>()
      filteredDimensions.forEach((d, i) => signalMap.set(d.dimension_id, signals[i]))
      excludedDimensions.forEach((d, i) => signalMap.set(d.dimension_id, excludedSignals[i]))

      return dimensions.map(d => signalMap.get(d.dimension_id)!)
    } catch (error) {
      // Log fallback event
      this.logFallback(context.run_id, error instanceof Error ? error.message : 'Unknown error')

      // Fallback: isolated calls for all dimensions
      return await Promise.all(dimensions.map(d => this.run(d, context)))
    }
  }

  /**
   * Parse Signal from LLM response (extracts fenced JSON block)
   */
  private parseSignalFromResponse(response: string): Signal {
    const jsonBlock = this.extractFencedJson(response)
    const parsed = JSON.parse(jsonBlock)

    return {
      verdict: parsed.verdict,
      numeric_score: parsed.numeric_score,
      gap: parsed.gap,
      severity: parsed.severity,
      reasoning: parsed.reasoning
    }
  }

  /**
   * Parse Signal array from merged LLM response
   */
  private parseSignalArrayFromResponse(response: string): Signal[] {
    const jsonBlock = this.extractFencedJson(response)
    const parsed = JSON.parse(jsonBlock)

    if (!Array.isArray(parsed)) {
      throw new Error('Expected JSON array')
    }

    return parsed.map((item: any) => ({
      verdict: item.verdict,
      numeric_score: item.numeric_score,
      gap: item.gap,
      severity: item.severity,
      reasoning: item.reasoning
    }))
  }

  /**
   * Extract fenced JSON block from response
   * Matches ```json...``` or ```...```
   */
  private extractFencedJson(response: string): string {
    // Match ```json ... ``` or ``` ... ```
    const match = response.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/)
    if (!match) {
      throw new Error('No fenced JSON block found')
    }
    return match[1].trim()
  }

  /**
   * Build prompt for single dimension evaluation
   */
  private buildSinglePrompt(dimension: Dimension, context: JudgeContext): string {
    const criteria = context.dimension_criteria.get(dimension.dimension_id) || 'No criteria specified'

    return `Evaluate the following agent output against the dimension "${dimension.dimension_id}".

**Dimension:** ${dimension.dimension_id}
**Criteria:** ${criteria}
**Is Binary:** ${dimension.is_binary}

**Agent Output:**
${context.agent_output}

Provide your evaluation in the following JSON format within a fenced code block:

\`\`\`json
{
  "verdict": true/false,
  "numeric_score": 0.0-1.0,
  "gap": 0.0-1.0,
  "severity": "low"|"medium"|"high"|"critical",
  "reasoning": "explanation"
}
\`\`\`

You may provide prose reasoning before the JSON block.`
  }

  /**
   * Build prompt for merged dimension evaluation
   */
  private buildMergedPrompt(dimensions: Dimension[], context: JudgeContext): string {
    const dimensionDescriptions = dimensions.map(d => {
      const criteria = context.dimension_criteria.get(d.dimension_id) || 'No criteria specified'
      return `- **${d.dimension_id}**: ${criteria} (is_binary: ${d.is_binary})`
    }).join('\n')

    return `Evaluate the following agent output against multiple dimensions in a single batch.

**Dimensions to evaluate:**
${dimensionDescriptions}

**Agent Output:**
${context.agent_output}

Provide your evaluation as a JSON array within a fenced code block, with one object per dimension in the same order:

\`\`\`json
[
  {
    "verdict": true/false,
    "numeric_score": 0.0-1.0,
    "gap": 0.0-1.0,
    "severity": "low"|"medium"|"high"|"critical",
    "reasoning": "explanation"
  },
  ...
]
\`\`\`

You may provide prose reasoning before the JSON block.`
  }

  /**
   * Filter dimensions for merged call based on context window constraints
   * Auto-excludes 'accuracy' if merged prompt exceeds 80% of context window
   */
  private filterDimensionsForMerge(dimensions: Dimension[], context: JudgeContext): Dimension[] {
    const estimatedSize = this.estimateMergedPromptSize(dimensions, context)
    const contextWindow = this.modelAdapter.getContextWindowSize()
    const threshold = contextWindow * 0.8

    if (estimatedSize > threshold) {
      // Auto-exclude accuracy dimension
      return dimensions.filter(d => d.dimension_id !== 'accuracy')
    }

    return dimensions
  }

  /**
   * Estimate merged prompt size in tokens
   */
  private estimateMergedPromptSize(dimensions: Dimension[], context: JudgeContext): number {
    const prompt = this.buildMergedPrompt(dimensions, context)
    return this.modelAdapter.estimateTokens(prompt)
  }

  /**
   * Log fallback event to MessageBus
   */
  private logFallback(run_id: string, reason: string): void {
    if (this.messageBus) {
      this.messageBus.emit('merged_judge_fallback', {
        run_id,
        reason,
        timestamp: Date.now()
      })
    }
  }
}
