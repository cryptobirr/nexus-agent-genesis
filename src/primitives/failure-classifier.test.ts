import { describe, it, expect } from 'vitest'
import { FailureClassifier } from './failure-classifier.js'
import type { Signal, FailureType, ExecutionMemory } from './types.js'

describe('FailureClassifier - P-13', () => {
  const classifier = new FailureClassifier()

  describe('classify() - deterministic mapping', () => {
    it('classifies Gate 1 planning dimension failures as planning_failure', () => {
      const signal: Signal = { verdict: false, numeric_score: 0.3, gap: 0.7, severity: 'high', reasoning: 'Plan incomplete' }
      expect(classifier.classify(1, 'planning_quality', signal)).toBe('planning_failure')
    })

    it('classifies Gate 1 schema dimension failures as schema_failure', () => {
      const signal: Signal = { verdict: false, numeric_score: 0.2, gap: 0.8, severity: 'high', reasoning: 'Schema mismatch' }
      expect(classifier.classify(1, 'schema_compliance', signal)).toBe('schema_failure')
    })

    it('classifies Gate 1 tool dimension failures as tool_failure', () => {
      const signal: Signal = { verdict: false, numeric_score: 0.1, gap: 0.9, severity: 'critical', reasoning: 'Tool unavailable' }
      expect(classifier.classify(1, 'tool_availability', signal)).toBe('tool_failure')
    })

    it('classifies Gate 2 reasoning dimension failures as reasoning_failure', () => {
      const signal: Signal = { verdict: false, numeric_score: 0.4, gap: 0.6, severity: 'medium', reasoning: 'Logic error' }
      expect(classifier.classify(2, 'reasoning_depth', signal)).toBe('reasoning_failure')
    })

    it('classifies Gate 2 retrieval dimension failures as retrieval_failure', () => {
      const signal: Signal = { verdict: false, numeric_score: 0.3, gap: 0.7, severity: 'high', reasoning: 'No context found' }
      expect(classifier.classify(2, 'retrieval_quality', signal)).toBe('retrieval_failure')
    })

    it('classifies Gate 2 novelty dimension failures as novelty_failure', () => {
      const signal: Signal = { verdict: false, numeric_score: 0.2, gap: 0.8, severity: 'high', reasoning: 'Output identical' }
      expect(classifier.classify(2, 'novelty_score', signal)).toBe('novelty_failure')
    })

    it('classifies infrastructure failures at Gate 1', () => {
      const signal: Signal = { verdict: false, numeric_score: 0.0, gap: 1.0, severity: 'critical', reasoning: 'Network error' }
      expect(classifier.classify(1, 'infrastructure_health', signal)).toBe('infrastructure_failure')
    })

    it('classifies infrastructure failures at Gate 2', () => {
      const signal: Signal = { verdict: false, numeric_score: 0.0, gap: 1.0, severity: 'critical', reasoning: 'API down' }
      expect(classifier.classify(2, 'infrastructure_health', signal)).toBe('infrastructure_failure')
    })

    it('classifies timeout failures at Gate 1', () => {
      const signal: Signal = { verdict: false, numeric_score: 0.0, gap: 1.0, severity: 'critical', reasoning: 'Timeout exceeded' }
      expect(classifier.classify(1, 'timeout_check', signal)).toBe('timeout_failure')
    })

    it('classifies timeout failures at Gate 2', () => {
      const signal: Signal = { verdict: false, numeric_score: 0.0, gap: 1.0, severity: 'critical', reasoning: 'Timeout exceeded' }
      expect(classifier.classify(2, 'timeout_check', signal)).toBe('timeout_failure')
    })

    it('classifies blob_write failures at Gate 2', () => {
      const signal: Signal = { verdict: false, numeric_score: 0.0, gap: 1.0, severity: 'critical', reasoning: 'Blob write failed' }
      expect(classifier.classify(2, 'blob_write_success', signal)).toBe('blob_write_failure')
    })

    it('produces deterministic results for same inputs', () => {
      const signal: Signal = { verdict: false, numeric_score: 0.5, gap: 0.5, severity: 'medium', reasoning: 'Test' }
      const result1 = classifier.classify(1, 'planning_quality', signal)
      const result2 = classifier.classify(1, 'planning_quality', signal)
      expect(result1).toBe(result2)
      expect(result1).toBe('planning_failure')
    })
  })

  describe('buildRetryAddition() - type-specific templates', () => {
    const mockMemory: ExecutionMemory = {
      attempts: 1,
      previous_outputs: ['previous output'],
      context: 'test context'
    }

    it('returns template for retrieval_failure', () => {
      const result = classifier.buildRetryAddition('retrieval_failure', mockMemory)
      expect(result).toBeTruthy()
      expect(result.toLowerCase()).toContain('retrieve')
    })

    it('returns template for reasoning_failure', () => {
      const result = classifier.buildRetryAddition('reasoning_failure', mockMemory)
      expect(result).toBeTruthy()
      expect(result).toContain('reasoning')
    })

    it('returns template for planning_failure', () => {
      const result = classifier.buildRetryAddition('planning_failure', mockMemory)
      expect(result).toBeTruthy()
      expect(result.toLowerCase()).toContain('plan')
    })

    it('returns template for tool_failure', () => {
      const result = classifier.buildRetryAddition('tool_failure', mockMemory)
      expect(result).toBeTruthy()
      expect(result).toContain('tool')
    })

    it('returns template for timeout_failure', () => {
      const result = classifier.buildRetryAddition('timeout_failure', mockMemory)
      expect(result).toBeTruthy()
      expect(result).toContain('timeout')
    })

    it('returns template for novelty_failure', () => {
      const result = classifier.buildRetryAddition('novelty_failure', mockMemory)
      expect(result).toBeTruthy()
      expect(result).toContain('novelty')
    })

    it('returns template for schema_failure', () => {
      const result = classifier.buildRetryAddition('schema_failure', mockMemory)
      expect(result).toBeTruthy()
      expect(result).toContain('schema')
    })

    it('returns template for infrastructure_failure', () => {
      const result = classifier.buildRetryAddition('infrastructure_failure', mockMemory)
      expect(result).toBeTruthy()
      expect(result.toLowerCase()).toContain('infrastructure')
    })

    it('returns template for blob_write_failure', () => {
      const result = classifier.buildRetryAddition('blob_write_failure', mockMemory)
      expect(result).toBeTruthy()
      expect(result.toLowerCase()).toContain('blob')
    })

    it('returns different templates for different failure types', () => {
      const template1 = classifier.buildRetryAddition('planning_failure', mockMemory)
      const template2 = classifier.buildRetryAddition('reasoning_failure', mockMemory)
      expect(template1).not.toBe(template2)
    })

    it('incorporates attempt count from execution memory', () => {
      const memoryWithAttempts: ExecutionMemory = {
        attempts: 3,
        previous_outputs: [],
        context: 'test'
      }
      const result = classifier.buildRetryAddition('planning_failure', memoryWithAttempts)
      expect(result).toContain('3')
    })
  })

  describe('isRetryCountExempt() - retry count exemptions', () => {
    it('exempts infrastructure_failure from retry count', () => {
      expect(classifier.isRetryCountExempt('infrastructure_failure')).toBe(true)
    })

    it('exempts blob_write_failure from retry count', () => {
      expect(classifier.isRetryCountExempt('blob_write_failure')).toBe(true)
    })

    it('does NOT exempt retrieval_failure', () => {
      expect(classifier.isRetryCountExempt('retrieval_failure')).toBe(false)
    })

    it('does NOT exempt reasoning_failure', () => {
      expect(classifier.isRetryCountExempt('reasoning_failure')).toBe(false)
    })

    it('does NOT exempt planning_failure', () => {
      expect(classifier.isRetryCountExempt('planning_failure')).toBe(false)
    })

    it('does NOT exempt tool_failure', () => {
      expect(classifier.isRetryCountExempt('tool_failure')).toBe(false)
    })

    it('does NOT exempt timeout_failure', () => {
      expect(classifier.isRetryCountExempt('timeout_failure')).toBe(false)
    })

    it('does NOT exempt novelty_failure', () => {
      expect(classifier.isRetryCountExempt('novelty_failure')).toBe(false)
    })

    it('does NOT exempt schema_failure', () => {
      expect(classifier.isRetryCountExempt('schema_failure')).toBe(false)
    })
  })

  describe('zero inference cost', () => {
    it('classify() executes synchronously without LLM calls', () => {
      const signal: Signal = { verdict: false, numeric_score: 0.5, gap: 0.5, severity: 'medium', reasoning: 'Test' }
      const startTime = Date.now()
      classifier.classify(1, 'planning_quality', signal)
      const endTime = Date.now()
      // Should be near-instantaneous (< 10ms for deterministic logic)
      expect(endTime - startTime).toBeLessThan(10)
    })

    it('buildRetryAddition() executes synchronously without LLM calls', () => {
      const mockMemory: ExecutionMemory = { attempts: 1, previous_outputs: [], context: 'test' }
      const startTime = Date.now()
      classifier.buildRetryAddition('planning_failure', mockMemory)
      const endTime = Date.now()
      // Should be near-instantaneous (< 10ms for string template)
      expect(endTime - startTime).toBeLessThan(10)
    })
  })
})
