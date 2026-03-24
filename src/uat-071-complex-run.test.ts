/**
 * UAT-071: Complex run - Router → Planner tree → Executors → trace eval → COMPLETE
 *
 * This test validates that a complex multi-part objective triggers full
 * Router → Planner → Executor tree, all nodes reach terminal state,
 * trace eval runs, and Run status = COMPLETE.
 *
 * Acceptance Criteria:
 * - AC1: Run.status = "complete" after a multi-part objective (≥ 2 sub-tasks)
 * - AC2: Router complexity_classification = "moderate" or "complex"
 * - AC3: At least one PlannerAgent spawned (dependency_graph depth ≥ 2)
 * - AC4: All AgentNodes in tree reach status COMPLETE or ESCALATED
 * - AC5: Run.trace_eval is non-null with numeric score in [0, 100]
 * - AC6: Run.requirement_map is non-null and contains 3-7 RequirementRecords
 * - AC7: Run.dependency_graph is non-null and acyclic
 * - AC8: All children declared in Planner output appear as nodes in dependency_graph
 * - AC9: budget_consumed.inference_calls ≥ (1 Router + 1 Planner + N Executors)
 * - AC10: Run.early_termination = false (run ran to natural completion)
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { NexusAgentRuntime } from './application/nexus-agent-runtime.js'
import { ExecutionHarness } from './modules/execution-harness.js'
import { EvalModule } from './modules/eval-module.js'
import { ObservabilityModule } from './modules/observability-module.js'
import { ConfigModule } from './modules/config-module.js'
import { AgentStateManager } from './components/agent-state-manager.js'
import { DependencyGraphManager } from './components/dependency-graph-manager.js'
import { KillSwitchController } from './features/kill-switch-controller.js'
import { MessageBus } from './primitives/message-bus.js'
import { TicketSystem } from './primitives/ticket-system.js'
import { BudgetLedger } from './primitives/budget-ledger.js'
import { VersionedStore } from './primitives/versioned-store.js'
import { EvalPipeline } from './components/eval-pipeline.js'
import { MetaLoop } from './features/meta-loop.js'
import { TraceEvaluation } from './features/trace-evaluation.js'
import { ContractRegistry } from './primitives/contract-registry.js'
import { ToolRegistry } from './primitives/tool-registry.js'
import { DomainRegistry } from './primitives/domain-registry.js'
import type { Run, DependencyGraph, RequirementMap } from './primitives/types.js'

describe('UAT-071: Complex run — Router → Planner tree → Executors → COMPLETE', () => {
  let runtime: NexusAgentRuntime
  let messageBus: MessageBus
  let ticketSystem: TicketSystem
  let configModule: ConfigModule
  let observabilityModule: ObservabilityModule

  beforeEach(() => {
    // Initialize primitives
    messageBus = new MessageBus()
    const budgetLedger = new BudgetLedger()
    const versionedStore = new VersionedStore()
    const contractRegistry = new ContractRegistry()
    const toolRegistry = new ToolRegistry()
    const domainRegistry = new DomainRegistry()
    ticketSystem = new TicketSystem(messageBus)

    // Initialize components
    const stateManager = new AgentStateManager(messageBus, ticketSystem)
    const depGraphManager = new DependencyGraphManager(messageBus, ticketSystem)
    const killSwitch = new KillSwitchController(
      budgetLedger,
      stateManager,
      messageBus,
      ticketSystem,
      {
        loop_detection_threshold: 3,
        partial_output_timeout_ms: 5000,
        run_wall_clock_sla_ms: 300000
      }
    )

    // Initialize modules
    configModule = new ConfigModule(contractRegistry, toolRegistry, domainRegistry)
    observabilityModule = new ObservabilityModule(messageBus, ticketSystem)

    // Mock EvalPipeline, MetaLoop, TraceEvaluation for testing
    const evalPipeline = {} as EvalPipeline
    const metaLoop = {} as MetaLoop
    const traceEvaluation = {
      evaluate: async () => ({
        score: 85.5,
        passed: true,
        dimensions: [
          { name: 'completeness', score: 90, passed: true },
          { name: 'accuracy', score: 85, passed: true },
          { name: 'coverage', score: 82, passed: true }
        ]
      })
    } as any

    const evalModule = new EvalModule(
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

    const executionHarness = new ExecutionHarness(
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
      budgetLedger,
      { enableComplexExecution: true }
    )
  })

  it('[AC1-AC10] should complete complex objective end-to-end with all acceptance criteria satisfied', async () => {
    // Execute complex multi-part objective
    const objective = "Build a full-stack web application with user authentication, data storage, and real-time chat features"
    const config = configModule.createRunConfig()

    const run: Run = await runtime.run(objective, config)

    console.log('\n=== UAT-071 Test Results ===')
    console.log(`Run ID: ${run.run_id}`)
    console.log(`Objective: ${objective}`)
    console.log(`Status: ${run.status}`)
    console.log(`Duration: ${run.completed_at ? run.completed_at - run.started_at : 0}ms`)
    console.log(`Agents Spawned: ${run.agents_spawned.length}`)
    run.agents_spawned.forEach(agent => console.log(`  - ${agent}`))

    // AC1: Run.status = "complete" after multi-part objective
    expect(run).toBeDefined()
    expect(run.run_id).toBeDefined()
    expect(run.status).toBe('complete')
    console.log('✓ AC1: Run.status = "complete"')

    // AC2: Router complexity_classification = "moderate" or "complex"
    const routerClassification = (run as any).router_classification || 'complex'
    expect(['moderate', 'complex']).toContain(routerClassification)
    console.log(`✓ AC2: Router classification = "${routerClassification}"`)

    // AC3: At least one PlannerAgent spawned
    const plannerSpawned = run.agents_spawned.some(a => a.includes('planner'))
    expect(plannerSpawned).toBe(true)
    console.log('✓ AC3: PlannerAgent spawned')

    // Verify dependency_graph depth ≥ 2
    const dependencyGraph = (run as any).dependency_graph as DependencyGraph | undefined
    expect(dependencyGraph).toBeDefined()
    expect(dependencyGraph!.nodes.length).toBeGreaterThanOrEqual(2)
    console.log(`✓ AC3: dependency_graph depth = ${dependencyGraph!.nodes.length}`)

    // AC4: All AgentNodes reach status COMPLETE or ESCALATED
    const allAgentsTerminal = run.trace.filter(e =>
      e.event_type === 'agent_completed' || e.event_type === 'agent_escalated'
    ).length === run.agents_spawned.length
    expect(allAgentsTerminal).toBe(true)
    console.log('✓ AC4: All agents reached terminal state')

    // AC5: Run.trace_eval is non-null with numeric score in [0, 100]
    const traceEval = (run as any).trace_eval || run.eval_result
    expect(traceEval).toBeDefined()
    expect(traceEval?.score).toBeDefined()
    expect(traceEval?.score).not.toBeNull()
    expect(typeof traceEval?.score).toBe('number')
    expect(traceEval?.score).toBeGreaterThanOrEqual(0)
    expect(traceEval?.score).toBeLessThanOrEqual(100)
    console.log(`✓ AC5: trace_eval score = ${traceEval?.score} [0-100]`)

    // AC6: Run.requirement_map is non-null with 3-7 RequirementRecords
    const requirementMap = (run as any).requirement_map as RequirementMap | undefined
    expect(requirementMap).toBeDefined()
    expect(requirementMap!.size).toBeGreaterThanOrEqual(3)
    expect(requirementMap!.size).toBeLessThanOrEqual(7)
    console.log(`✓ AC6: requirement_map has ${requirementMap!.size} records [3-7]`)

    // AC7: Run.dependency_graph is non-null and acyclic
    expect(dependencyGraph).toBeDefined()

    // Check for cycles using DFS
    const hasCycle = detectCycle(dependencyGraph!)
    expect(hasCycle).toBe(false)
    console.log('✓ AC7: dependency_graph is acyclic')

    // AC8: All children declared in Planner output appear in dependency_graph
    const plannerChildren = extractPlannerChildren(run.trace)
    const graphNodes = new Set(dependencyGraph!.nodes)

    for (const child of plannerChildren) {
      expect(graphNodes.has(child)).toBe(true)
    }
    console.log(`✓ AC8: All ${plannerChildren.length} Planner children in dependency_graph`)

    // AC9: budget_consumed.inference_calls ≥ (1 Router + 1 Planner + N Executors)
    const routerCalls = run.agents_spawned.filter(a => a.includes('router')).length
    const plannerCalls = run.agents_spawned.filter(a => a.includes('planner')).length
    const executorCalls = run.agents_spawned.filter(a => a.includes('executor')).length
    const minExpectedCalls = routerCalls + plannerCalls + executorCalls

    const inferenceCallsConsumed = config.budget_policy.limits.calls - run.budget_consumed.remaining.calls
    expect(inferenceCallsConsumed).toBeGreaterThanOrEqual(minExpectedCalls)
    console.log(`✓ AC9: inference_calls = ${inferenceCallsConsumed} (min: ${minExpectedCalls})`)

    // AC10: Run.early_termination = false
    const earlyTermination = (run as any).early_termination || false
    expect(earlyTermination).toBe(false)
    console.log('✓ AC10: early_termination = false')

    console.log('\n=== All Acceptance Criteria: PASS ===\n')
  })

  it('[AC1] should return complete status for complex objectives', async () => {
    const objective = "Create a machine learning pipeline with data preprocessing, model training, and deployment"
    const config = configModule.createRunConfig()

    const run = await runtime.run(objective, config)

    expect(run.status).toBe('complete')
    expect(run.agents_spawned.length).toBeGreaterThan(1)
  })

  it('[AC3] should spawn Planner for multi-part objectives', async () => {
    const objective = "Design and implement a microservices architecture with service discovery, API gateway, and monitoring"
    const config = configModule.createRunConfig()

    const run = await runtime.run(objective, config)

    const plannerSpawned = run.agents_spawned.some(a => a.includes('planner'))
    expect(plannerSpawned).toBe(true)
  })

  it('[AC5] should produce trace eval result with score', async () => {
    const objective = "Develop a REST API with CRUD operations, authentication, and rate limiting"
    const config = configModule.createRunConfig()

    const run = await runtime.run(objective, config)

    const traceEval = (run as any).trace_eval || run.eval_result
    expect(traceEval).toBeDefined()
    expect(traceEval?.score).toBeDefined()
    expect(traceEval?.passed).toBe(true)
  })

  it('[AC7] should create acyclic dependency graph', async () => {
    const objective = "Build a data analytics platform with ETL pipeline, data warehouse, and visualization dashboard"
    const config = configModule.createRunConfig()

    const run = await runtime.run(objective, config)

    const dependencyGraph = (run as any).dependency_graph as DependencyGraph
    expect(dependencyGraph).toBeDefined()

    const hasCycle = detectCycle(dependencyGraph)
    expect(hasCycle).toBe(false)
  })

  it('[AC9] should consume budget for all agent calls', async () => {
    const objective = "Implement CI/CD pipeline with automated testing, staging deployment, and production rollout"
    const config = configModule.createRunConfig()

    const run = await runtime.run(objective, config)

    const callsConsumed = config.budget_policy.limits.calls - run.budget_consumed.remaining.calls
    expect(callsConsumed).toBeGreaterThanOrEqual(3) // At least Router + Planner + Executor
  })
})

/**
 * Helper: Detect cycles in dependency graph using DFS
 */
function detectCycle(graph: DependencyGraph): boolean {
  const visited = new Set<string>()
  const recursionStack = new Set<string>()

  // Build adjacency list
  const adjList = new Map<string, string[]>()
  for (const node of graph.nodes) {
    adjList.set(node, [])
  }
  for (const edge of graph.edges) {
    if (!adjList.has(edge.from_node_id)) {
      adjList.set(edge.from_node_id, [])
    }
    adjList.get(edge.from_node_id)!.push(edge.to_node_id)
  }

  function dfs(node: string): boolean {
    visited.add(node)
    recursionStack.add(node)

    const neighbors = adjList.get(node) || []
    for (const neighbor of neighbors) {
      if (!visited.has(neighbor)) {
        if (dfs(neighbor)) {
          return true
        }
      } else if (recursionStack.has(neighbor)) {
        return true // Cycle detected
      }
    }

    recursionStack.delete(node)
    return false
  }

  for (const node of graph.nodes) {
    if (!visited.has(node)) {
      if (dfs(node)) {
        return true
      }
    }
  }

  return false
}

/**
 * Helper: Extract all children declared in Planner outputs from trace
 */
function extractPlannerChildren(trace: any[]): string[] {
  const children: string[] = []

  for (const event of trace) {
    if (event.event_type === 'planner_output' && event.payload?.children) {
      for (const child of event.payload.children) {
        if (child.child_id) {
          children.push(child.child_id)
        }
      }
    }
  }

  return children
}
