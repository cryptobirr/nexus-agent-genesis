import type { MessageBus } from '../primitives/message-bus.js'
import type { EmbeddingEngine } from '../primitives/embedding-engine.js'
import type { TicketSystem } from '../primitives/ticket-system.js'
import type {
  ComplexityClassification,
  RecursionDecision,
  ComplexityOverrideRule,
  RecursionGuardConfig,
  RecursionGuardResult
} from '../primitives/types.js'

/**
 * RecursionGuard - C-04
 * Enforce complexity-aware recursion decisions before a Planner's "recurse" decision is accepted.
 *
 * Dependencies: P-04 (MessageBus), P-11 (EmbeddingEngine)
 */
export class RecursionGuard {
  private messageBus: MessageBus
  private embeddingEngine: EmbeddingEngine
  private ticketSystem: TicketSystem
  private config: RecursionGuardConfig

  constructor(
    messageBus: MessageBus,
    embeddingEngine: EmbeddingEngine,
    ticketSystem: TicketSystem,
    config?: Partial<RecursionGuardConfig>
  ) {
    this.messageBus = messageBus
    this.embeddingEngine = embeddingEngine
    this.ticketSystem = ticketSystem
    this.config = {
      min_scope_tokens: config?.min_scope_tokens ?? 200,
      near_identical_threshold: config?.near_identical_threshold ?? 0.95
    }
  }

  /**
   * Check recursion decision and apply complexity-aware overrides
   *
   * @param decision - Planner's proposed recursion decision
   * @param scope_text - Scope text for token estimation
   * @param children - Proposed children (for near-identical detection)
   * @param complexity_classification - Complexity level from Router (run-scoped)
   * @param run_id - Run identifier
   * @param agent_id - Agent identifier
   * @param override_rules - Complexity override rules (pre-pass)
   * @returns RecursionGuardResult with final decision and override metadata
   */
  check(
    decision: RecursionDecision,
    scope_text: string,
    children: string[],
    complexity_classification: ComplexityClassification,
    run_id: string,
    agent_id: string,
    override_rules: ComplexityOverrideRule[]
  ): RecursionGuardResult {
    // If decision is already "execute", no need to override
    if (decision === 'execute') {
      return {
        decision: 'execute',
        overridden: false
      }
    }

    // Step 1: Apply complexity override rules (pre-pass)
    const overrideRuleResult = this.applyOverrideRules(
      scope_text,
      override_rules,
      run_id,
      agent_id
    )

    let appliedRuleReason: string | undefined

    if (overrideRuleResult) {
      // Save original classification for logging
      const original_classification = complexity_classification

      // Override rule matched - use overridden classification
      complexity_classification = overrideRuleResult.override_to
      appliedRuleReason = overrideRuleResult.reason

      // Log override rule match
      this.messageBus.emit(run_id, 'complexity_override_rule_matched', {
        run_id,
        agent_id,
        rule_id: overrideRuleResult.rule_id,
        reason: overrideRuleResult.reason,
        override_to: overrideRuleResult.override_to,
        original_classification
      })
    }

    // Step 2: Apply complexity-aware override logic
    const overrideCheck = this.shouldOverride(
      decision,
      scope_text,
      children,
      complexity_classification,
      run_id,
      agent_id
    )

    if (overrideCheck.should_override) {
      // If override rule was applied, include its reason
      const finalReason = appliedRuleReason
        ? `complexity override rule: ${appliedRuleReason}`
        : overrideCheck.reason

      return {
        decision: 'execute',
        overridden: true,
        override_reason: finalReason,
        original_decision: decision
      }
    }

    // No override - allow original decision
    return {
      decision,
      overridden: false
    }
  }

  /**
   * Apply complexity override rules (pre-pass)
   * First matching rule wins
   *
   * @private
   */
  private applyOverrideRules(
    scope_text: string,
    override_rules: ComplexityOverrideRule[],
    run_id: string,
    agent_id: string
  ): ComplexityOverrideRule | null {
    for (const rule of override_rules) {
      // Check if pattern matches scope_text
      // Support both regex and simple string contains
      const matches = this.matchesPattern(scope_text, rule.pattern)

      if (matches) {
        // First matching rule wins
        return rule
      }
    }

    return null
  }

  /**
   * Check if scope_text matches pattern (regex or string contains)
   *
   * @private
   */
  private matchesPattern(scope_text: string, pattern: string): boolean {
    try {
      // Try as regex first
      const regex = new RegExp(pattern, 'i')
      return regex.test(scope_text)
    } catch {
      // Fall back to case-insensitive string contains
      return scope_text.toLowerCase().includes(pattern.toLowerCase())
    }
  }

  /**
   * Check if recursion decision should be overridden
   *
   * @private
   */
  private shouldOverride(
    decision: RecursionDecision,
    scope_text: string,
    children: string[],
    complexity_classification: ComplexityClassification,
    run_id: string,
    agent_id: string
  ): { should_override: boolean; reason?: string } {
    // Rule 1: atomic or simple → always override to "execute"
    if (complexity_classification === 'atomic' || complexity_classification === 'simple') {
      this.logOverride(
        run_id,
        agent_id,
        `${complexity_classification} classification always overrides to execute`,
        'recursion_guard_override',
        complexity_classification,
        decision
      )

      return {
        should_override: true,
        reason: `${complexity_classification} classification always overrides to execute`
      }
    }

    const scope_tokens = this.estimateTokens(scope_text)

    // Rule 2: moderate classification → apply min_scope_tokens tiebreaker
    if (complexity_classification === 'moderate') {
      if (scope_tokens < this.config.min_scope_tokens) {
        this.logOverride(
          run_id,
          agent_id,
          `moderate classification with ${scope_tokens} tokens (< ${this.config.min_scope_tokens}) overrides to execute`,
          'recursion_guard_override',
          complexity_classification,
          decision
        )

        return {
          should_override: true,
          reason: `moderate classification with ${scope_tokens} tokens (< ${this.config.min_scope_tokens}) overrides to execute`
        }
      }

      return { should_override: false }
    }

    // Rule 3: complex → apply scope-level check (scope < min_scope_tokens AND near-identical children)
    if (complexity_classification === 'complex') {
      if (scope_tokens < this.config.min_scope_tokens) {
        // Check if children are near-identical
        const near_identical = this.areChildrenNearIdentical(children)

        if (near_identical) {
          // Log scope-level override
          this.messageBus.emit(run_id, 'recursion_guard_scope_override', {
            run_id,
            agent_id,
            scope_tokens,
            min_scope_tokens: this.config.min_scope_tokens,
            near_identical: true,
            original_decision: decision,
            new_decision: 'execute'
          })

          this.ticketSystem.file('recursion_guard_scope_override', {
            run_id,
            agent_id,
            scope_tokens,
            near_identical: true
          })

          return {
            should_override: true,
            reason: `complex classification with ${scope_tokens} tokens and near-identical children overrides to execute`
          }
        }
      }

      return { should_override: false }
    }

    return { should_override: false }
  }

  /**
   * Estimate token count (simple whitespace split)
   *
   * @private
   */
  private estimateTokens(text: string): number {
    return text.split(/\s+/).filter(token => token.length > 0).length
  }

  /**
   * Check if children are near-identical via embedding similarity
   *
   * @private
   */
  private areChildrenNearIdentical(children: string[]): boolean {
    // Need at least 2 children to compare
    if (children.length < 2) {
      return false
    }

    // Compute embeddings for all children
    const embeddings = children.map(child => this.embeddingEngine.embed(child))

    // Check pairwise similarity
    // If ANY pair has similarity >= threshold, children are near-identical
    for (let i = 0; i < embeddings.length; i++) {
      for (let j = i + 1; j < embeddings.length; j++) {
        const similarity = this.embeddingEngine.cosineSimilarity(
          embeddings[i],
          embeddings[j]
        )

        if (similarity >= this.config.near_identical_threshold) {
          return true
        }
      }
    }

    return false
  }

  /**
   * Log override event and file ticket
   *
   * @private
   */
  private logOverride(
    run_id: string,
    agent_id: string,
    reason: string,
    event_type: 'recursion_guard_override' | 'recursion_guard_scope_override',
    complexity: ComplexityClassification,
    original_decision: RecursionDecision
  ): void {
    // Emit event
    this.messageBus.emit(run_id, event_type, {
      run_id,
      agent_id,
      complexity,
      original_decision,
      new_decision: 'execute',
      reason
    })

    // File ticket
    this.ticketSystem.file(event_type, {
      run_id,
      agent_id,
      complexity,
      reason
    })
  }
}
