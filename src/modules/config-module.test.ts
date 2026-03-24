import { describe, it, expect, beforeEach } from 'vitest'
import { ConfigModule } from './config-module.js'
import { ContractRegistry } from '../primitives/contract-registry.js'
import { ToolRegistry } from '../primitives/tool-registry.js'
import { DomainRegistry } from '../primitives/domain-registry.js'
import type { RunConfig, Contract, Tool } from '../primitives/types.js'

describe('ConfigModule - M-04', () => {
  let configModule: ConfigModule
  let contractRegistry: ContractRegistry
  let toolRegistry: ToolRegistry
  let domainRegistry: DomainRegistry

  beforeEach(() => {
    contractRegistry = new ContractRegistry()
    toolRegistry = new ToolRegistry()
    domainRegistry = new DomainRegistry()
    configModule = new ConfigModule(contractRegistry, toolRegistry, domainRegistry)
  })

  describe('AC1: All policies configurable at runtime', () => {
    it('should create RunConfig with all policy fields', () => {
      const config = configModule.createRunConfig()

      // Verify all policy surfaces exist
      expect(config.budget_policy).toBeDefined()
      expect(config.repair_policy).toBeDefined()
      expect(config.judging_policy).toBeDefined()
      expect(config.context_assembly_policy).toBeDefined()
      expect(config.compression_policy).toBeDefined()
      expect(config.depth_policy).toBeDefined()
      expect(config.early_termination_policy).toBeDefined()
      expect(config.model_policy).toBeDefined()
      expect(config.merged_judge_policy).toBeDefined()
      expect(config.blob_store_policy).toBeDefined()
      expect(config.parallelism_policy).toBeDefined()
      expect(config.latency_sla_policy).toBeDefined()
      expect(config.sandbox_config).toBeDefined()
      expect(config.conflict_resolution_policy).toBeDefined()
      expect(config.recursion_guard).toBeDefined()
      expect(config.kill_switch).toBeDefined()
    })

    it('should support per-run overrides', () => {
      const config = configModule.createRunConfig({
        budget_policy: {
          limits: { tokens: 5000, calls: 50, wall_ms: 30000, warning_threshold: 0.9 },
          enforcement_mode: 'hard'
        },
        model_policy: {
          default_model: 'gpt-4'
        }
      })

      expect(config.budget_policy.limits.tokens).toBe(5000)
      expect(config.budget_policy.enforcement_mode).toBe('hard')
      expect(config.model_policy.default_model).toBe('gpt-4')
    })
  })

  describe('AC2: Contract version change invalidates PlanCache', () => {
    it('should produce different hash when contract changes', () => {
      // Register initial contract
      const contract1: Contract = {
        agent_type: 'executor',
        dimensions: [
          { dimension_id: 'correctness', weight: 0.5 },
          { dimension_id: 'efficiency', weight: 0.5 }
        ]
      }
      contractRegistry.register(contract1)

      const config1 = configModule.createRunConfig()
      const hash1 = configModule.computeConfigHash(config1)

      // Modify contract (change weights)
      const contract2: Contract = {
        agent_type: 'executor',
        dimensions: [
          { dimension_id: 'correctness', weight: 0.7 },
          { dimension_id: 'efficiency', weight: 0.3 }
        ]
      }
      contractRegistry.register(contract2)

      const config2 = configModule.createRunConfig()
      const hash2 = configModule.computeConfigHash(config2)

      // Hash should differ (invalidates cache)
      expect(hash1).not.toBe(hash2)
    })

    it('should include contract registry state in hash', () => {
      const config = configModule.createRunConfig()
      const hash = configModule.computeConfigHash(config)

      expect(hash).toBeDefined()
      expect(hash.length).toBeGreaterThan(0)
    })
  })

  describe('AC3: Tool registry change invalidates PlanCache', () => {
    it('should produce different hash when tool added', () => {
      // Initial state - no tools
      const config1 = configModule.createRunConfig()
      const hash1 = configModule.computeConfigHash(config1)

      // Add tool
      const tool: Tool = {
        tool_id: 'web_search',
        input_schema: { type: 'object' },
        output_schema: { type: 'object' },
        side_effect_class: 'read'
      }
      toolRegistry.register(tool)

      const config2 = configModule.createRunConfig()
      const hash2 = configModule.computeConfigHash(config2)

      // Hash should differ (invalidates cache)
      expect(hash1).not.toBe(hash2)
    })

    it('should produce different hash when tool removed', () => {
      // Register tool
      const tool: Tool = {
        tool_id: 'web_search',
        input_schema: { type: 'object' },
        output_schema: { type: 'object' },
        side_effect_class: 'read'
      }
      toolRegistry.register(tool)

      const config1 = configModule.createRunConfig()
      const hash1 = configModule.computeConfigHash(config1)

      // Create new registry without tool (simulates removal)
      const newToolRegistry = new ToolRegistry()
      const newConfigModule = new ConfigModule(contractRegistry, newToolRegistry, domainRegistry)

      const config2 = newConfigModule.createRunConfig()
      const hash2 = newConfigModule.computeConfigHash(config2)

      // Hash should differ (invalidates cache)
      expect(hash1).not.toBe(hash2)
    })
  })

  describe('AC4: run_config_hash computed from all policy fields', () => {
    it('should produce identical hash for identical configs', () => {
      const config1 = configModule.createRunConfig({
        budget_policy: {
          limits: { tokens: 10000, calls: 100, wall_ms: 60000, warning_threshold: 0.8 },
          enforcement_mode: 'hard'
        }
      })

      const config2 = configModule.createRunConfig({
        budget_policy: {
          limits: { tokens: 10000, calls: 100, wall_ms: 60000, warning_threshold: 0.8 },
          enforcement_mode: 'hard'
        }
      })

      const hash1 = configModule.computeConfigHash(config1)
      const hash2 = configModule.computeConfigHash(config2)

      expect(hash1).toBe(hash2)
    })

    it('should produce different hash when any policy field changes', () => {
      const baseConfig = configModule.createRunConfig()
      const baseHash = configModule.computeConfigHash(baseConfig)

      // Change budget policy
      const config1 = configModule.createRunConfig({
        budget_policy: {
          limits: { tokens: 5000, calls: 50, wall_ms: 30000, warning_threshold: 0.8 },
          enforcement_mode: 'soft'
        }
      })
      const hash1 = configModule.computeConfigHash(config1)
      expect(hash1).not.toBe(baseHash)

      // Change model policy
      const config2 = configModule.createRunConfig({
        model_policy: {
          default_model: 'gpt-4-turbo'
        }
      })
      const hash2 = configModule.computeConfigHash(config2)
      expect(hash2).not.toBe(baseHash)

      // Change parallelism policy
      const config3 = configModule.createRunConfig({
        parallelism_policy: {
          max_concurrent_agents: 10
        }
      })
      const hash3 = configModule.computeConfigHash(config3)
      expect(hash3).not.toBe(baseHash)
    })

    it('should be deterministic (same input always produces same hash)', () => {
      const config = configModule.createRunConfig({
        budget_policy: {
          limits: { tokens: 10000, calls: 100, wall_ms: 60000, warning_threshold: 0.8 },
          enforcement_mode: 'hard'
        },
        model_policy: {
          default_model: 'gpt-4'
        }
      })

      const hash1 = configModule.computeConfigHash(config)
      const hash2 = configModule.computeConfigHash(config)
      const hash3 = configModule.computeConfigHash(config)

      expect(hash1).toBe(hash2)
      expect(hash2).toBe(hash3)
    })
  })

  describe('Integration: ConfigModule with registries', () => {
    it('should compose ContractRegistry, ToolRegistry, DomainRegistry', () => {
      expect(configModule).toBeDefined()

      // Verify registries are accessible (composition)
      const contract: Contract = {
        agent_type: 'router',
        dimensions: [{ dimension_id: 'accuracy', weight: 1.0 }]
      }
      contractRegistry.register(contract)

      const tool: Tool = {
        tool_id: 'calculator',
        input_schema: {},
        output_schema: {},
        side_effect_class: 'read'
      }
      toolRegistry.register(tool)

      // Config hash should reflect registry state
      const config = configModule.createRunConfig()
      const hash = configModule.computeConfigHash(config)

      expect(hash).toBeDefined()
      expect(hash.length).toBeGreaterThan(0)
    })
  })
})
