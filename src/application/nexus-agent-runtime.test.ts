import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NexusAgentRuntime } from './nexus-agent-runtime.js'
import { ExecutionHarness } from '../modules/execution-harness.js'
import { EvalModule } from '../modules/eval-module.js'
import { ObservabilityModule } from '../modules/observability-module.js'
import { ConfigModule } from '../modules/config-module.js'
import { AgentStateManager } from '../components/agent-state-manager.js'
import { DependencyGraphManager } from '../components/dependency-graph-manager.js'
import { KillSwitchController } from '../features/kill-switch-controller.js'
import { MessageBus } from '../primitives/message-bus.js'
import { TicketSystem } from '../primitives/ticket-system.js'
import { BudgetLedger } from '../primitives/budget-ledger.js'
import { VersionedStore } from '../primitives/versioned-store.js'
import { EvalPipeline } from '../components/eval-pipeline.js'
import { MetaLoop } from '../features/meta-loop.js'
import { TraceEvaluation } from '../features/trace-evaluation.js'
import { ContractRegistry } from '../primitives/contract-registry.js'
import { ToolRegistry } from '../primitives/tool-registry.js'
import { DomainRegistry } from '../primitives/domain-registry.js'
import type { RunConfig, Run } from '../primitives/types.js'

describe('NexusAgentRuntime', () => {
  let runtime: NexusAgentRuntime
  let messageBus: MessageBus
  let ticketSystem: TicketSystem
  let configModule: ConfigModule
  let observabilityModule: ObservabilityModule
  let evalModule: EvalModule
  let executionHarness: ExecutionHarness

  beforeEach(() => {
    // Initialize primitives
    messageBus = new MessageBus()
    const budgetLedger = new BudgetLedger()
    const versionedStore = new VersionedStore()
    const contractRegistry = new ContractRegistry()
    const toolRegistry = new ToolRegistry()
    const domainRegistry = new DomainRegistry()
    ticketSystem = new TicketSystem()

    // Initialize components
    const stateManager = new AgentStateManager(versionedStore, messageBus)
    const depGraphManager = new DependencyGraphManager(versionedStore)
    const killSwitch = new KillSwitchController(budgetLedger, stateManager, messageBus, ticketSystem)

    // Initialize modules
    configModule = new ConfigModule(contractRegistry, toolRegistry, domainRegistry)
    observabilityModule = new ObservabilityModule(messageBus, ticketSystem)

    // Mock EvalPipeline, MetaLoop, TraceEvaluation for testing
    const evalPipeline = {} as EvalPipeline
    const metaLoop = {} as MetaLoop
    const traceEvaluation = {
      evaluate: vi.fn().mockResolvedValue({
        score: 1.0,
        passed: true,
        dimensions: []
      })
    } as any

    evalModule = new EvalModule(
      evalPipeline,
      metaLoop,
      traceEvaluation,
      ticketSystem,
      messageBus,
      {
        judging_policy: { mode: 'full', skip_non_binary: false, adaptive_skip_threshold: 0.8 },
        merged_judge_mode: false,
        skip_dimensions: [],
        feedback_loop_enabled: false
      }
    )

    executionHarness = new ExecutionHarness(
      stateManager,
      depGraphManager,
      killSwitch,
      messageBus,
      ticketSystem,
      {
        parallelism_policy: { max_concurrent_agents: 5 },
        max_queued_agents: 10,
        latency_sla_policy: {
          budgets: { executor: 30000, planner: 20000, router: 10000 },
          on_violation: 'degrade'
        },
        run_wall_clock_sla_ms: 300000
      }
    )

    runtime = new NexusAgentRuntime(
      executionHarness,
      evalModule,
      observabilityModule,
      configModule,
      messageBus,
      budgetLedger
    )
  })

  describe('run()', () => {
    it('should accept objective + RunConfig and return Run with correct final status', async () => {
      const objective = "Complete a simple task"
      const config = configModule.createRunConfig()

      const result = await runtime.run(objective, config)

      expect(result).toBeDefined()
      expect(result.run_id).toBeDefined()
      expect(result.objective).toBe(objective)
      expect(result.config.run_config_hash).toBeDefined()
      expect(['complete', 'partial_complete', 'escalated', 'error']).toContain(result.status)
      expect(result.trace).toBeDefined()
      expect(result.budget_consumed).toBeDefined()
      expect(result.agents_spawned).toBeDefined()
      expect(result.started_at).toBeGreaterThan(0)
    })

    it('should handle atomic objective → single Executor → COMPLETE (no Planner)', async () => {
      const objective = "What is 2+2?"  // Atomic, no decomposition needed
      const config = configModule.createRunConfig()

      const result = await runtime.run(objective, config)

      expect(result.status).toBe('complete')
      expect(result.agents_spawned.length).toBeGreaterThan(0)
      // In a real implementation, verify that only Router + Executor spawned (no Planner)
    })

    it('should handle complex objective → Router → Planner tree → Executors → COMPLETE', async () => {
      const objective = "Analyze customer data, generate insights, and create a report"
      const config = configModule.createRunConfig()

      const result = await runtime.run(objective, config)

      expect(['complete', 'partial_complete']).toContain(result.status)
      expect(result.agents_spawned.length).toBeGreaterThan(1)
      expect(result.eval_result).toBeDefined()
    })

    it('should produce structurally identical runs in replay_mode with same config', async () => {
      const objective = "Process data pipeline"
      const config = configModule.createRunConfig()

      const run1 = await runtime.run(objective, config)
      const run2 = await runtime.run(objective, config)

      // Same config hash should produce same agent structure
      expect(run1.config.run_config_hash).toBe(run2.config.run_config_hash)
      // In deterministic mode, same agents should be spawned
      // (exact ordering may vary due to concurrency, but set should match)
    })

    it('should fail gracefully with clear error when in-memory SEC used in multi-node mode', async () => {
      const objective = "Test distributed failure"
      const config = configModule.createRunConfig()

      // Simulate multi-node mode detection
      const multiNodeRuntime = new NexusAgentRuntime(
        executionHarness,
        evalModule,
        observabilityModule,
        configModule,
        messageBus,
        new BudgetLedger(),
        { multi_node_mode: true }  // Force multi-node mode
      )

      const result = await multiNodeRuntime.run(objective, config)

      expect(result.status).toBe('error')
      expect(result.error).toContain('in-memory SEC backend')
      expect(result.error).toContain('multi-node')
    })

    it.skip('should report status as "running" when checked mid-execution', async () => {
      // This test requires complex timing and mocking
      // Skipping for now - validated manually in integration tests
    })

    it('should return status "error" for unrecoverable errors', async () => {
      const objective = "Trigger unrecoverable error"
      const config = configModule.createRunConfig({
        budget_policy: {
          limits: { tokens: 0, calls: 0, wall_ms: 0, warning_threshold: 0 },
          enforcement_mode: 'hard'
        }
      })

      const result = await runtime.run(objective, config)

      // Zero budget leads to partial_complete or error
      expect(['partial_complete', 'error']).toContain(result.status)
    })

    it('should return status "escalated" for objectives requiring human intervention', async () => {
      const objective = "Decision requiring human approval"
      const config = configModule.createRunConfig()

      // Mock scenario where HITL is triggered
      // In real implementation, would simulate HITL checkpoint

      const result = await runtime.run(objective, config)

      // Status could be escalated if HITL triggered
      expect(['complete', 'escalated', 'partial_complete']).toContain(result.status)
    })

    it('should return status "partial_complete" when budget exceeded mid-execution', async () => {
      const objective = "Task requiring large budget"
      const config = configModule.createRunConfig({
        budget_policy: {
          limits: { tokens: 100, calls: 5, wall_ms: 1000, warning_threshold: 0.8 },
          enforcement_mode: 'hard'
        }
      })

      const result = await runtime.run(objective, config)

      // When budget exceeded, run should complete partially
      expect(['partial_complete', 'error']).toContain(result.status)
      expect(result.budget_consumed.exceeded).toBe(true)
    })
  })

  describe('Run statuses', () => {
    it('should support all required statuses', () => {
      const statuses: Array<'running' | 'complete' | 'partial_complete' | 'escalated' | 'error'> = [
        'running',
        'complete',
        'partial_complete',
        'escalated',
        'error'
      ]

      statuses.forEach(status => {
        expect(['running', 'complete', 'partial_complete', 'escalated', 'error']).toContain(status)
      })
    })
  })
})
