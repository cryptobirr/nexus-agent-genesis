import { describe, it, expect } from 'vitest'
import { ContractRegistry } from './contract-registry.js'
import type { Contract, Dimension } from './types.js'

describe('ContractRegistry', () => {
  describe('register() + get()', () => {
    it('should store and retrieve contract by agent_type', () => {
      const registry = new ContractRegistry()
      const contract: Contract = {
        agent_type: 'router',
        dimensions: [
          { dimension_id: 'completeness', weight: 0.40, is_binary: true, gate: 1 },
          { dimension_id: 'coverage', weight: 0.30, is_binary: false, gate: 2 }
        ]
      }

      registry.register(contract)
      const result = registry.get('router')

      expect(result).toBeDefined()
      expect(result?.agent_type).toBe('router')
      expect(result?.dimensions).toHaveLength(2)
      expect(result?.dimensions[0].dimension_id).toBe('completeness')
    })

    it('should return undefined for unregistered agent_type', () => {
      const registry = new ContractRegistry()
      const result = registry.get('executor')

      expect(result).toBeUndefined()
    })

    it('should support idempotent re-registration (overwrite)', () => {
      const registry = new ContractRegistry()

      const contract1: Contract = {
        agent_type: 'executor',
        dimensions: [
          { dimension_id: 'coherence', weight: 0.20, is_binary: false, gate: 2 }
        ]
      }

      const contract2: Contract = {
        agent_type: 'executor',
        dimensions: [
          { dimension_id: 'task_completion', weight: 0.25, is_binary: true, gate: 1 },
          { dimension_id: 'specificity', weight: 0.15, is_binary: false, gate: 2 }
        ]
      }

      registry.register(contract1)
      registry.register(contract2)

      const result = registry.get('executor')
      expect(result?.dimensions).toHaveLength(2)
      expect(result?.dimensions[0].dimension_id).toBe('task_completion')
      expect(result?.dimensions[1].dimension_id).toBe('specificity')
    })

    it('should return deep copy to prevent mutation', () => {
      const registry = new ContractRegistry()
      const contract: Contract = {
        agent_type: 'planner',
        dimensions: [
          { dimension_id: 'coherence', weight: 0.20, is_binary: false, gate: 2 }
        ]
      }

      registry.register(contract)
      const result1 = registry.get('planner')

      // Mutate returned contract
      result1!.dimensions[0].weight = 0.99

      // Get again - should be unchanged
      const result2 = registry.get('planner')
      expect(result2?.dimensions[0].weight).toBe(0.20)
    })
  })

  describe('applyStrategyOverrides()', () => {
    it('should apply absolute weight overrides', () => {
      const registry = new ContractRegistry()
      const contract: Contract = {
        agent_type: 'executor',
        dimensions: [
          { dimension_id: 'coherence', weight: 0.20, is_binary: false, gate: 2 },
          { dimension_id: 'specificity', weight: 0.15, is_binary: false, gate: 2 },
          { dimension_id: 'task_completion', weight: 0.25, is_binary: true, gate: 1 }
        ]
      }

      const overrides = {
        coherence: 0.10,
        specificity: 0.10
      }

      const result = registry.applyStrategyOverrides(contract, overrides)

      // Verify overrides applied as absolute values (before normalization)
      // After normalization with sum = 0.10 + 0.10 + 0.25 = 0.45
      // coherence: 0.10/0.45 ≈ 0.222
      // specificity: 0.10/0.45 ≈ 0.222
      // task_completion: 0.25/0.45 ≈ 0.556
      expect(result.dimensions.find(d => d.dimension_id === 'coherence')?.weight).toBeCloseTo(0.222, 3)
      expect(result.dimensions.find(d => d.dimension_id === 'specificity')?.weight).toBeCloseTo(0.222, 3)
      expect(result.dimensions.find(d => d.dimension_id === 'task_completion')?.weight).toBeCloseTo(0.556, 3)
    })

    it('should keep base weight for dimensions without override before normalization', () => {
      const registry = new ContractRegistry()
      const contract: Contract = {
        agent_type: 'executor',
        dimensions: [
          { dimension_id: 'coherence', weight: 0.20, is_binary: false, gate: 2 },
          { dimension_id: 'task_completion', weight: 0.25, is_binary: true, gate: 1 }
        ]
      }

      const overrides = {
        coherence: 0.10
      }

      const result = registry.applyStrategyOverrides(contract, overrides)

      // task_completion should keep base weight 0.25 before normalization
      // After normalization: coherence=0.10, task_completion=0.25, sum=0.35
      // coherence: 0.10/0.35 ≈ 0.286
      // task_completion: 0.25/0.35 ≈ 0.714
      expect(result.dimensions.find(d => d.dimension_id === 'coherence')?.weight).toBeCloseTo(0.286, 3)
      expect(result.dimensions.find(d => d.dimension_id === 'task_completion')?.weight).toBeCloseTo(0.714, 3)
    })

    it('should re-normalize weights to sum to 1.0', () => {
      const registry = new ContractRegistry()
      const contract: Contract = {
        agent_type: 'executor',
        dimensions: [
          { dimension_id: 'coherence', weight: 0.20, is_binary: false, gate: 2 },
          { dimension_id: 'specificity', weight: 0.15, is_binary: false, gate: 2 },
          { dimension_id: 'task_completion', weight: 0.25, is_binary: true, gate: 1 }
        ]
      }

      const overrides = {
        coherence: 0.10,
        specificity: 0.10
      }

      const result = registry.applyStrategyOverrides(contract, overrides)

      // Sum of all weights should equal 1.0
      const sum = result.dimensions.reduce((acc, d) => acc + d.weight, 0)
      expect(sum).toBeCloseTo(1.0, 10)
    })

    it('should return normalized copy when override is empty', () => {
      const registry = new ContractRegistry()
      const contract: Contract = {
        agent_type: 'executor',
        dimensions: [
          { dimension_id: 'coherence', weight: 0.20, is_binary: false, gate: 2 },
          { dimension_id: 'task_completion', weight: 0.30, is_binary: true, gate: 1 }
        ]
      }

      const result = registry.applyStrategyOverrides(contract, {})

      // Should normalize to sum to 1.0
      // coherence: 0.20/0.50 = 0.40
      // task_completion: 0.30/0.50 = 0.60
      expect(result.dimensions.find(d => d.dimension_id === 'coherence')?.weight).toBeCloseTo(0.40, 10)
      expect(result.dimensions.find(d => d.dimension_id === 'task_completion')?.weight).toBeCloseTo(0.60, 10)

      // Original should be unchanged
      expect(contract.dimensions[0].weight).toBe(0.20)
    })

    it('should not mutate original contract', () => {
      const registry = new ContractRegistry()
      const contract: Contract = {
        agent_type: 'executor',
        dimensions: [
          { dimension_id: 'coherence', weight: 0.20, is_binary: false, gate: 2 }
        ]
      }

      const originalWeight = contract.dimensions[0].weight

      registry.applyStrategyOverrides(contract, { coherence: 0.50 })

      // Original contract should be unchanged
      expect(contract.dimensions[0].weight).toBe(originalWeight)
    })
  })
})
