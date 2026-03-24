import { describe, it, expect } from 'vitest'
import { DeterministicPreCheck } from './deterministic-precheck.js'
import type { AgentType } from './types.js'

describe('DeterministicPreCheck', () => {
  const preCheck = new DeterministicPreCheck()

  describe('PreCheckResult Type', () => {
    it('returns passed=true and empty violations for valid output', () => {
      const output = {
        routing: 'plan',
        requirements: [{ id: 'req1', description: 'test' }]
      }
      const result = preCheck.run('router', output)
      expect(result.passed).toBe(true)
      expect(result.violations).toEqual([])
    })

    it('returns passed=false with violation description for missing field', () => {
      const output = {
        routing: 'plan'
        // missing requirements
      }
      const result = preCheck.run('router', output)
      expect(result.passed).toBe(false)
      expect(result.violations.length).toBeGreaterThan(0)
      expect(result.violations[0]).toContain('requirements')
    })
  })

  describe('Router Validation', () => {
    it('passes for valid router output', () => {
      const output = {
        routing: 'plan',
        requirements: [{ id: 'req1', description: 'test requirement' }]
      }
      const result = preCheck.run('router', output)
      expect(result.passed).toBe(true)
      expect(result.violations).toEqual([])
    })

    it('fails when routing field is missing', () => {
      const output = {
        requirements: [{ id: 'req1' }]
      }
      const result = preCheck.run('router', output)
      expect(result.passed).toBe(false)
      expect(result.violations).toContain('Router output missing required field: routing')
    })

    it('fails when routing value is invalid', () => {
      const output = {
        routing: 'invalid_routing',
        requirements: [{ id: 'req1' }]
      }
      const result = preCheck.run('router', output)
      expect(result.passed).toBe(false)
      expect(result.violations).toContain('Router output has invalid routing value: invalid_routing')
    })

    it('fails when requirements field is missing', () => {
      const output = {
        routing: 'plan'
      }
      const result = preCheck.run('router', output)
      expect(result.passed).toBe(false)
      expect(result.violations).toContain('Router output missing required field: requirements')
    })

    it('fails when requirements array is empty', () => {
      const output = {
        routing: 'plan',
        requirements: []
      }
      const result = preCheck.run('router', output)
      expect(result.passed).toBe(false)
      expect(result.violations).toContain('Router output requirements array is empty')
    })

    it('accepts routing value "execute"', () => {
      const output = {
        routing: 'execute',
        requirements: [{ id: 'req1' }]
      }
      const result = preCheck.run('router', output)
      expect(result.passed).toBe(true)
    })
  })

  describe('Planner Validation', () => {
    it('passes for valid planner output', () => {
      const output = {
        decision: 'recurse',
        children: [{ node_id: 'child1' }],
        covers_requirements: ['req1']
      }
      const result = preCheck.run('planner', output)
      expect(result.passed).toBe(true)
      expect(result.violations).toEqual([])
    })

    it('fails when decision field is missing', () => {
      const output = {
        children: [{ node_id: 'child1' }],
        covers_requirements: ['req1']
      }
      const result = preCheck.run('planner', output)
      expect(result.passed).toBe(false)
      expect(result.violations).toContain('Planner output missing required field: decision')
    })

    it('fails when decision value is invalid', () => {
      const output = {
        decision: 'invalid_decision',
        children: [{ node_id: 'child1' }],
        covers_requirements: ['req1']
      }
      const result = preCheck.run('planner', output)
      expect(result.passed).toBe(false)
      expect(result.violations).toContain('Planner output has invalid decision value: invalid_decision')
    })

    it('fails when children field is missing', () => {
      const output = {
        decision: 'recurse',
        covers_requirements: ['req1']
      }
      const result = preCheck.run('planner', output)
      expect(result.passed).toBe(false)
      expect(result.violations).toContain('Planner output missing required field: children')
    })

    it('fails when children array is empty', () => {
      const output = {
        decision: 'recurse',
        children: [],
        covers_requirements: ['req1']
      }
      const result = preCheck.run('planner', output)
      expect(result.passed).toBe(false)
      expect(result.violations).toContain('Planner output children array is empty')
    })

    it('fails when covers_requirements is missing', () => {
      const output = {
        decision: 'recurse',
        children: [{ node_id: 'child1' }]
      }
      const result = preCheck.run('planner', output)
      expect(result.passed).toBe(false)
      expect(result.violations).toContain('Planner output missing required field: covers_requirements')
    })

    it('accepts decision value "execute"', () => {
      const output = {
        decision: 'execute',
        children: [{ node_id: 'child1' }],
        covers_requirements: ['req1']
      }
      const result = preCheck.run('planner', output)
      expect(result.passed).toBe(true)
    })
  })

  describe('Executor Validation', () => {
    it('passes for valid executor output with llm_output', () => {
      const output = {
        status: 'complete',
        output: 'result data',
        evidence: 'reasoning trace'
      }
      const result = preCheck.run('executor', output)
      expect(result.passed).toBe(true)
      expect(result.violations).toEqual([])
    })

    it('passes for valid executor output with tool_call', () => {
      const output = {
        status: 'complete',
        tool_call: { tool_id: 'search', params: {} }
      }
      const result = preCheck.run('executor', output)
      expect(result.passed).toBe(true)
      expect(result.violations).toEqual([])
    })

    it('fails when status field is missing', () => {
      const output = {
        output: 'result data'
      }
      const result = preCheck.run('executor', output)
      expect(result.passed).toBe(false)
      expect(result.violations).toContain('Executor output missing required field: status')
    })

    it('fails when both output and tool_call are missing', () => {
      const output = {
        status: 'complete'
      }
      const result = preCheck.run('executor', output)
      expect(result.passed).toBe(false)
      expect(result.violations).toContain('Executor output missing both output and tool_call')
    })

    it('fails when llm_output mode lacks evidence', () => {
      const output = {
        status: 'complete',
        output: 'result data'
        // missing evidence for llm_output
      }
      const result = preCheck.run('executor', output)
      expect(result.passed).toBe(false)
      expect(result.violations).toContain('Executor output with llm_output missing required field: evidence')
    })

    it('passes when tool_call mode has no evidence', () => {
      const output = {
        status: 'complete',
        tool_call: { tool_id: 'search', params: {} }
        // no evidence required for tool_call
      }
      const result = preCheck.run('executor', output)
      expect(result.passed).toBe(true)
      expect(result.violations).toEqual([])
    })
  })

  describe('Edge Cases', () => {
    it('fails for unknown agent_type', () => {
      const output = { some: 'data' }
      const result = preCheck.run('unknown' as AgentType, output)
      expect(result.passed).toBe(false)
      expect(result.violations).toContain('Unknown agent_type: unknown')
    })

    it('fails for null output', () => {
      const result = preCheck.run('router', null)
      expect(result.passed).toBe(false)
      expect(result.violations.length).toBeGreaterThan(0)
    })

    it('fails for undefined output', () => {
      const result = preCheck.run('router', undefined)
      expect(result.passed).toBe(false)
      expect(result.violations.length).toBeGreaterThan(0)
    })

    it('accumulates multiple violations', () => {
      const output = {
        // missing routing
        // missing requirements
      }
      const result = preCheck.run('router', output)
      expect(result.passed).toBe(false)
      expect(result.violations.length).toBeGreaterThanOrEqual(2)
    })
  })
})
