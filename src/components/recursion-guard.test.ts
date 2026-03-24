import { describe, it, expect, beforeEach, vi } from 'vitest'
import { RecursionGuard } from './recursion-guard.js'
import { MessageBus } from '../primitives/message-bus.js'
import { EmbeddingEngine } from '../primitives/embedding-engine.js'
import { TicketSystem } from '../primitives/ticket-system.js'
import type {
  ComplexityClassification,
  RecursionDecision,
  ComplexityOverrideRule
} from '../primitives/types.js'

describe('RecursionGuard - C-04', () => {
  let messageBus: MessageBus
  let embeddingEngine: EmbeddingEngine
  let ticketSystem: TicketSystem
  let recursionGuard: RecursionGuard

  beforeEach(() => {
    messageBus = new MessageBus()
    embeddingEngine = new EmbeddingEngine()
    ticketSystem = new TicketSystem(messageBus)
    recursionGuard = new RecursionGuard(messageBus, embeddingEngine, ticketSystem)
  })

  describe('Complexity Override Rules - atomic/simple', () => {
    it('should override atomic classification to execute regardless of token count', () => {
      const scope_text = 'Simple atomic task with many words to make it longer than 200 tokens but still atomic in nature so we expect it to be overridden to execute'.repeat(10)
      const children: string[] = []
      const complexity: ComplexityClassification = 'atomic'
      const decision: RecursionDecision = 'recurse'

      const result = recursionGuard.check(
        decision,
        scope_text,
        children,
        complexity,
        'run_1',
        'agent_1',
        []
      )

      expect(result.decision).toBe('execute')
      expect(result.overridden).toBe(true)
      expect(result.override_reason).toContain('atomic')
      expect(result.original_decision).toBe('recurse')
    })

    it('should override simple classification to execute regardless of token count', () => {
      const scope_text = 'Simple task with many words'.repeat(20)
      const children: string[] = []
      const complexity: ComplexityClassification = 'simple'
      const decision: RecursionDecision = 'recurse'

      const result = recursionGuard.check(
        decision,
        scope_text,
        children,
        complexity,
        'run_1',
        'agent_1',
        []
      )

      expect(result.decision).toBe('execute')
      expect(result.overridden).toBe(true)
      expect(result.override_reason).toContain('simple')
    })

    it('should log recursion_guard_override event for atomic override', () => {
      const emitSpy = vi.spyOn(messageBus, 'emit')

      recursionGuard.check(
        'recurse',
        'atomic task',
        [],
        'atomic',
        'run_1',
        'agent_1',
        []
      )

      expect(emitSpy).toHaveBeenCalledWith(
        'run_1',
        'recursion_guard_override',
        expect.objectContaining({
          run_id: 'run_1',
          agent_id: 'agent_1',
          complexity: 'atomic',
          original_decision: 'recurse',
          new_decision: 'execute'
        })
      )
    })

    it('should file minor ticket for atomic override', () => {
      const fileSpy = vi.spyOn(ticketSystem, 'file')

      recursionGuard.check(
        'recurse',
        'atomic task',
        [],
        'atomic',
        'run_1',
        'agent_1',
        []
      )

      expect(fileSpy).toHaveBeenCalledWith(
        'recursion_guard_override',
        expect.objectContaining({
          run_id: 'run_1',
          agent_id: 'agent_1',
          complexity: 'atomic'
        })
      )
    })
  })

  describe('Moderate Classification Tiebreaker', () => {
    it('should allow recurse for moderate with scope >= 200 tokens', () => {
      // Generate 250+ tokens
      const scope_text = 'word '.repeat(250)
      const children = ['child1', 'child2']
      const complexity: ComplexityClassification = 'moderate'
      const decision: RecursionDecision = 'recurse'

      const result = recursionGuard.check(
        decision,
        scope_text,
        children,
        complexity,
        'run_1',
        'agent_1',
        []
      )

      expect(result.decision).toBe('recurse')
      expect(result.overridden).toBe(false)
    })

    it('should override to execute for moderate with scope < 200 tokens', () => {
      const scope_text = 'word '.repeat(150)
      const children = ['child1', 'child2']
      const complexity: ComplexityClassification = 'moderate'
      const decision: RecursionDecision = 'recurse'

      const result = recursionGuard.check(
        decision,
        scope_text,
        children,
        complexity,
        'run_1',
        'agent_1',
        []
      )

      expect(result.decision).toBe('execute')
      expect(result.overridden).toBe(true)
      expect(result.override_reason).toContain('moderate')
      expect(result.override_reason).toContain('200')
    })

    it('should respect custom min_scope_tokens config', () => {
      const customGuard = new RecursionGuard(
        messageBus,
        embeddingEngine,
        ticketSystem,
        { min_scope_tokens: 100, near_identical_threshold: 0.95 }
      )

      const scope_text = 'word '.repeat(120)
      const result = customGuard.check(
        'recurse',
        scope_text,
        ['child1', 'child2'],
        'moderate',
        'run_1',
        'agent_1',
        []
      )

      expect(result.decision).toBe('recurse')
      expect(result.overridden).toBe(false)
    })
  })

  describe('Complex Classification Scope-Level Override', () => {
    it('should allow recurse for complex with scope >= 200 tokens', () => {
      const scope_text = 'word '.repeat(250)
      const children = ['child1', 'child2']
      const complexity: ComplexityClassification = 'complex'

      const result = recursionGuard.check(
        'recurse',
        scope_text,
        children,
        complexity,
        'run_1',
        'agent_1',
        []
      )

      expect(result.decision).toBe('recurse')
      expect(result.overridden).toBe(false)
    })

    it('should override complex with low tokens + near-identical children', () => {
      const scope_text = 'word '.repeat(150)
      // Near-identical children (same text)
      const children = ['implement feature X', 'implement feature X']
      const complexity: ComplexityClassification = 'complex'

      const result = recursionGuard.check(
        'recurse',
        scope_text,
        children,
        complexity,
        'run_1',
        'agent_1',
        []
      )

      expect(result.decision).toBe('execute')
      expect(result.overridden).toBe(true)
      expect(result.override_reason).toContain('near-identical')
    })

    it('should allow recurse for dense 50-token complex brief with diverse children', () => {
      const scope_text = 'word '.repeat(50)
      // Diverse children
      const children = [
        'implement authentication system',
        'build user dashboard',
        'create database schema'
      ]
      const complexity: ComplexityClassification = 'complex'

      const result = recursionGuard.check(
        'recurse',
        scope_text,
        children,
        complexity,
        'run_1',
        'agent_1',
        []
      )

      // Dense 50-token complex brief with diverse children should NOT be forced to single executor
      expect(result.decision).toBe('recurse')
      expect(result.overridden).toBe(false)
    })

    it('should log recursion_guard_scope_override for scope-level override', () => {
      const emitSpy = vi.spyOn(messageBus, 'emit')

      const scope_text = 'word '.repeat(150)
      const children = ['same child', 'same child']

      recursionGuard.check(
        'recurse',
        scope_text,
        children,
        'complex',
        'run_1',
        'agent_1',
        []
      )

      expect(emitSpy).toHaveBeenCalledWith(
        'run_1',
        'recursion_guard_scope_override',
        expect.objectContaining({
          run_id: 'run_1',
          agent_id: 'agent_1',
          scope_tokens: expect.any(Number),
          near_identical: true
        })
      )
    })

    it('should respect custom near_identical_threshold', () => {
      const customGuard = new RecursionGuard(
        messageBus,
        embeddingEngine,
        ticketSystem,
        { min_scope_tokens: 200, near_identical_threshold: 0.99 }
      )

      const scope_text = 'word '.repeat(150)
      // Slightly different children (similarity ~0.97, below 0.99 threshold)
      const children = ['implement feature A', 'implement feature B']

      const result = customGuard.check(
        'recurse',
        scope_text,
        children,
        'complex',
        'run_1',
        'agent_1',
        []
      )

      // Should allow recurse because similarity below custom threshold
      expect(result.decision).toBe('recurse')
      expect(result.overridden).toBe(false)
    })
  })

  describe('Complexity Override Rules (Pre-Pass)', () => {
    it('should apply matching override rule before classification', () => {
      const override_rules: ComplexityOverrideRule[] = [
        {
          rule_id: 'force_simple_for_testing',
          pattern: 'test.*setup',
          override_to: 'simple',
          reason: 'Test setup tasks are always simple'
        }
      ]

      const scope_text = 'test environment setup'
      const result = recursionGuard.check(
        'recurse',
        scope_text,
        ['child1', 'child2'],
        'complex',  // Original classification is complex
        'run_1',
        'agent_1',
        override_rules
      )

      // Override rule should apply BEFORE classification is read
      expect(result.decision).toBe('execute')
      expect(result.overridden).toBe(true)
      expect(result.override_reason).toContain('override rule')
    })

    it('should use first matching override rule', () => {
      const override_rules: ComplexityOverrideRule[] = [
        {
          rule_id: 'rule1',
          pattern: 'deploy',
          override_to: 'simple',
          reason: 'First rule'
        },
        {
          rule_id: 'rule2',
          pattern: 'deploy',
          override_to: 'atomic',
          reason: 'Second rule (should not apply)'
        }
      ]

      const result = recursionGuard.check(
        'recurse',
        'deploy to production',
        [],
        'complex',
        'run_1',
        'agent_1',
        override_rules
      )

      expect(result.override_reason).toContain('First rule')
    })

    it('should skip non-matching override rules', () => {
      const override_rules: ComplexityOverrideRule[] = [
        {
          rule_id: 'rule1',
          pattern: 'nonexistent',
          override_to: 'atomic',
          reason: 'Should not match'
        }
      ]

      const result = recursionGuard.check(
        'recurse',
        'word '.repeat(150),
        ['child1', 'child2'],
        'moderate',
        'run_1',
        'agent_1',
        override_rules
      )

      // Rule doesn't match, falls through to normal logic
      expect(result.decision).toBe('execute')
      expect(result.override_reason).not.toContain('override rule')
    })

    it('should log complexity_override_rule_matched event', () => {
      const emitSpy = vi.spyOn(messageBus, 'emit')

      const override_rules: ComplexityOverrideRule[] = [
        {
          rule_id: 'test_rule',
          pattern: 'deploy',
          override_to: 'simple',
          reason: 'Test reason'
        }
      ]

      recursionGuard.check(
        'recurse',
        'deploy app',
        [],
        'complex',
        'run_1',
        'agent_1',
        override_rules
      )

      expect(emitSpy).toHaveBeenCalledWith(
        'run_1',
        'complexity_override_rule_matched',
        expect.objectContaining({
          run_id: 'run_1',
          agent_id: 'agent_1',
          rule_id: 'test_rule',
          reason: 'Test reason',
          override_to: 'simple'
        })
      )
    })
  })

  describe('Near-Identical Children Detection', () => {
    it('should detect high similarity (>= 0.95) as near-identical', () => {
      const scope_text = 'word '.repeat(150)
      const children = ['implement auth', 'implement auth']  // Identical

      const result = recursionGuard.check(
        'recurse',
        scope_text,
        children,
        'complex',
        'run_1',
        'agent_1',
        []
      )

      expect(result.decision).toBe('execute')
      expect(result.overridden).toBe(true)
    })

    it('should not detect low similarity (< 0.95) as near-identical', () => {
      const scope_text = 'word '.repeat(150)
      const children = [
        'implement authentication system with OAuth',
        'build user dashboard with React',
        'create database schema with PostgreSQL'
      ]

      const result = recursionGuard.check(
        'recurse',
        scope_text,
        children,
        'complex',
        'run_1',
        'agent_1',
        []
      )

      // Diverse children, should allow recurse despite low token count
      expect(result.decision).toBe('recurse')
      expect(result.overridden).toBe(false)
    })

    it('should handle single child (no comparison needed)', () => {
      const scope_text = 'word '.repeat(150)
      const children = ['single child']

      const result = recursionGuard.check(
        'recurse',
        scope_text,
        children,
        'complex',
        'run_1',
        'agent_1',
        []
      )

      // Single child cannot be near-identical to anything
      expect(result.decision).toBe('recurse')
      expect(result.overridden).toBe(false)
    })

    it('should handle empty children array', () => {
      const scope_text = 'word '.repeat(150)
      const children: string[] = []

      const result = recursionGuard.check(
        'recurse',
        scope_text,
        children,
        'complex',
        'run_1',
        'agent_1',
        []
      )

      // No children, no comparison
      expect(result.decision).toBe('recurse')
      expect(result.overridden).toBe(false)
    })
  })

  describe('Run-Scoped Complexity Classification', () => {
    it('should accept complexity classification from run context', () => {
      // Test that complexity_classification parameter is used
      const result = recursionGuard.check(
        'recurse',
        'some task',
        [],
        'atomic',  // Classification from Router
        'run_1',
        'agent_1',
        []
      )

      expect(result.decision).toBe('execute')
      expect(result.overridden).toBe(true)
    })

    it('should propagate classification to all RecursionGuard instances', () => {
      // Each RecursionGuard instance receives classification as parameter
      // No shared state needed - classification is passed explicitly
      const guard1 = new RecursionGuard(messageBus, embeddingEngine, ticketSystem)
      const guard2 = new RecursionGuard(messageBus, embeddingEngine, ticketSystem)

      const result1 = guard1.check('recurse', 'task', [], 'atomic', 'run_1', 'agent_1', [])
      const result2 = guard2.check('recurse', 'task', [], 'atomic', 'run_1', 'agent_2', [])

      // Both instances respect the same classification
      expect(result1.decision).toBe('execute')
      expect(result2.decision).toBe('execute')
    })
  })

  describe('Edge Cases', () => {
    it('should not override when decision is already execute', () => {
      const result = recursionGuard.check(
        'execute',
        'task',
        [],
        'atomic',
        'run_1',
        'agent_1',
        []
      )

      expect(result.decision).toBe('execute')
      expect(result.overridden).toBe(false)
    })

    it('should handle very long scope_text efficiently', () => {
      const scope_text = 'word '.repeat(10000)

      const result = recursionGuard.check(
        'recurse',
        scope_text,
        ['child1', 'child2'],
        'moderate',
        'run_1',
        'agent_1',
        []
      )

      expect(result.decision).toBe('recurse')
    })

    it('should handle unicode characters in scope_text', () => {
      const scope_text = '中文 русский العربية '.repeat(200)

      const result = recursionGuard.check(
        'recurse',
        scope_text,
        ['child1', 'child2'],
        'moderate',
        'run_1',
        'agent_1',
        []
      )

      expect(result.decision).toBe('recurse')
    })
  })
})
