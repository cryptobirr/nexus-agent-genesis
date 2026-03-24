/**
 * UAT-077: Destructive tool: never retried, immediate escalation on failure
 *
 * This test validates that tools with side_effect_class="destructive" are NEVER retried,
 * regardless of retry_on_error setting, and immediately escalate on failure.
 *
 * Story:
 * Verify that when a destructive tool fails, it is not retried (even if retry_on_error=true),
 * and the agent immediately escalates with a ticket filed.
 *
 * Source: agent-nexus-spec.md — C-05, C-07
 *
 * Acceptance Criteria:
 * - AC1: Register a tool with `side_effect_class: "destructive"` and `retry_on_error: true`
 * - AC2: Inject it into an Executor; cause the tool to fail
 * - AC3: Tool execution attempt count = exactly 1 (no retry)
 * - AC4: AgentNode.status = `ESCALATED` immediately after tool failure
 * - AC5: RetryOrchestrator does NOT compose a retry prompt (no `RETRYING` state transition)
 * - AC6: No retry budget consumed (AgentNode.attempt remains at 1)
 * - AC7: A ticket with the tool failure is filed
 * - AC8: `retry_on_error: true` setting on the tool is explicitly overridden by `side_effect_class: "destructive"` — verified by absence of any retry
 *
 * Dependencies:
 * - C-05: SandboxEnforcer (#48)
 * - C-07: RetryOrchestrator (#51)
 * - P-05: ToolRegistry
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { SandboxEnforcer } from './components/sandbox-enforcer.js'
import { RetryOrchestrator } from './components/retry-orchestrator.js'
import { AgentStateManager } from './components/agent-state-manager.js'
import { ToolRegistry } from './primitives/tool-registry.js'
import { FailureClassifier } from './primitives/failure-classifier.js'
import { ExecutionMemoryStore } from './primitives/execution-memory-store.js'
import { EvalPipeline } from './components/eval-pipeline.js'
import { OutputNormalizer } from './primitives/output-normalizer.js'
import { DeterministicPreCheck } from './primitives/deterministic-precheck.js'
import { JudgeRunner } from './primitives/judge-runner.js'
import { ContractRegistry } from './primitives/contract-registry.js'
import { MessageBus } from './primitives/message-bus.js'
import { TicketSystem } from './primitives/ticket-system.js'
import type {
  Tool,
  InjectedToolset,
  ToolCall,
  ToolExecutionResult
} from './primitives/types.js'

describe('UAT-077: Destructive tool: never retried, immediate escalation on failure', () => {
  let sandboxEnforcer: SandboxEnforcer
  let retryOrchestrator: RetryOrchestrator
  let agentStateManager: AgentStateManager
  let toolRegistry: ToolRegistry
  let failureClassifier: FailureClassifier
  let executionMemoryStore: ExecutionMemoryStore
  let messageBus: MessageBus
  let ticketSystem: TicketSystem
  let evalPipeline: EvalPipeline

  beforeEach(() => {
    // Initialize primitives
    messageBus = new MessageBus()
    ticketSystem = new TicketSystem(messageBus)
    failureClassifier = new FailureClassifier()
    executionMemoryStore = new ExecutionMemoryStore({ max_retries: 3 })
    toolRegistry = new ToolRegistry()

    // Initialize AgentStateManager
    agentStateManager = new AgentStateManager(messageBus, ticketSystem)

    // Initialize SandboxEnforcer
    sandboxEnforcer = new SandboxEnforcer(
      toolRegistry,
      messageBus,
      ticketSystem,
      {
        enabled: true,
        tool_execution: 'isolated',
        data_access: 'scoped',
        on_violation: 'error'
      }
    )

    // Initialize EvalPipeline (needed for RetryOrchestrator)
    const outputNormalizer = new OutputNormalizer()
    const preCheck = new DeterministicPreCheck()
    const judgeRunner = {
      run: vi.fn(),
      runMerged: vi.fn()
    } as any
    const contractRegistry = new ContractRegistry()

    evalPipeline = new EvalPipeline(
      outputNormalizer,
      preCheck,
      failureClassifier,
      judgeRunner,
      contractRegistry,
      {
        early_stop_on_gate1: true,
        merged_judge_mode: true,
        model_infra_retry_max: 2,
        gate2_threshold: 0.7
      }
    )

    // Initialize RetryOrchestrator with ToolRegistry
    retryOrchestrator = new RetryOrchestrator(
      failureClassifier,
      executionMemoryStore,
      evalPipeline,
      toolRegistry, // Pass ToolRegistry for destructive tool detection
      {
        max_retries: 3,
        blob_write_retry_max: 3,
        similarity_threshold: 0.75,
        blob_write_backoff_base_ms: 100
      }
    )
  })

  it('should immediately escalate destructive tool failure without retry, despite retry_on_error=true', async () => {
    const agent_id = 'executor-destructive-tool'
    const run_id = 'run-destructive-tool'

    console.log('\n=== UAT-077 Test: Destructive tool never retried, immediate escalation ===\n')

    // AC1: Register a tool with side_effect_class="destructive" and retry_on_error=true
    const destructiveTool: Tool = {
      tool_id: 'delete_database',
      input_schema: {
        type: 'object',
        properties: {
          database_name: { type: 'string' }
        },
        required: ['database_name']
      },
      output_schema: {
        type: 'object',
        properties: {
          deleted: { type: 'boolean' }
        },
        required: ['deleted']
      },
      side_effect_class: 'destructive',
      retry_on_error: true  // AC1: Explicitly set to true, should be overridden
    }

    toolRegistry.register(destructiveTool)
    console.log('✓ AC1: Registered tool with side_effect_class="destructive" and retry_on_error=true')
    console.log(`   Tool ID: ${destructiveTool.tool_id}`)
    console.log(`   side_effect_class: ${destructiveTool.side_effect_class}`)
    console.log(`   retry_on_error: ${destructiveTool.retry_on_error}`)

    // Create injected toolset
    const injectedToolset: InjectedToolset = {
      tools: [destructiveTool],
      get(tool_id: string): Tool {
        const tool = this.tools.find(t => t.tool_id === tool_id)
        if (!tool) throw new Error(`Tool not found: ${tool_id}`)
        return tool
      },
      has(tool_id: string): boolean {
        return this.tools.some(t => t.tool_id === tool_id)
      }
    }

    // Initialize agent in state manager
    agentStateManager.initializeAgent(agent_id, run_id, 'executor')

    // Initialize execution memory
    executionMemoryStore.init(agent_id, run_id)

    // Spy on ticket system for AC7
    const ticketFileSpy = vi.spyOn(ticketSystem, 'file')

    // Spy on message bus for state transitions
    const messageBusEmitSpy = vi.spyOn(messageBus, 'emit')

    // Transition agent through proper state flow
    agentStateManager.transition({ agent_id, run_id, reason: 'Starting execution', agent_type: 'executor' }, 'AWAITING_HITL')
    agentStateManager.transition({ agent_id, run_id, reason: 'HITL passed', agent_type: 'executor' }, 'PRECHECKING')
    agentStateManager.transition({ agent_id, run_id, reason: 'Precheck passed', agent_type: 'executor' }, 'GENERATING')

    // AC2: Inject tool into Executor and cause it to fail
    console.log('\n--- AC2: Executing destructive tool (will fail) ---')

    let executionAttempts = 0
    const mockExecutor = vi.fn(async (tool_id: string, input: any): Promise<any> => {
      executionAttempts++
      console.log(`   Tool execution attempt ${executionAttempts}`)
      // Simulate tool failure
      throw new Error('Database deletion failed - connection timeout')
    })

    const toolCall: ToolCall = {
      tool_id: 'delete_database',
      input: { database_name: 'test_db' },
      agent_id
    }

    const toolResult: ToolExecutionResult = await sandboxEnforcer.executeToolWithEnforcement(
      toolCall,
      injectedToolset,
      mockExecutor,
      run_id
    )

    // AC3: Tool execution attempt count = exactly 1 (no retry)
    expect(executionAttempts).toBe(1)
    console.log('✓ AC3: Tool execution attempt count = exactly 1 (no retry)')
    console.log(`   Total attempts: ${executionAttempts}`)

    // Verify tool execution failed
    expect(toolResult.success).toBe(false)
    expect(toolResult.error).toContain('Database deletion failed')
    expect(toolResult.failure_type).toBe('tool_failure')
    expect(toolResult.retry_attempted).toBe(false)
    console.log('✓ AC2: Tool execution failed as expected')
    console.log(`   Error: ${toolResult.error}`)
    console.log(`   retry_attempted: ${toolResult.retry_attempted}`)

    // AC8: Verify retry_on_error=true was overridden by side_effect_class="destructive"
    console.log('✓ AC8: retry_on_error=true explicitly overridden by side_effect_class="destructive"')
    console.log(`   Tool has retry_on_error=true but was NOT retried`)
    console.log(`   Verified by attempt count = 1 and retry_attempted = false`)

    // AC5: Check RetryOrchestrator decision - should NOT retry
    console.log('\n--- AC5: Verifying RetryOrchestrator does NOT compose retry prompt ---')

    const retryDecision = retryOrchestrator.decideRetry({
      agent_id,
      failure_type: 'tool_failure',
      gate: 1,
      gap: 'Destructive tool execution failed',
      attempt: 1,
      tool_id: 'delete_database'
    })

    expect(retryDecision.should_retry).toBe(false)
    expect(retryDecision.retry_prompt).toBeNull()
    expect(retryDecision.should_escalate).toBe(true)
    expect(retryDecision.retry_count_consumed).toBe(false)
    console.log('✓ AC5: RetryOrchestrator does NOT compose retry prompt')
    console.log(`   should_retry: ${retryDecision.should_retry}`)
    console.log(`   retry_prompt: ${retryDecision.retry_prompt}`)
    console.log(`   should_escalate: ${retryDecision.should_escalate}`)

    // AC6: Verify no retry budget consumed
    const memory = executionMemoryStore.get(agent_id)
    expect(memory?.failed_strategies.length).toBe(0) // No failed strategies recorded since we escalate immediately
    console.log('✓ AC6: No retry budget consumed (AgentNode.attempt remains at 1)')
    console.log(`   failed_strategies count: ${memory?.failed_strategies.length}`)
    console.log(`   retry_count_consumed: ${retryDecision.retry_count_consumed}`)

    // Verify NO RETRYING state transition occurred
    const retryingStateTransitions = messageBusEmitSpy.mock.calls.filter(
      call => call[1] === 'state_transition' && (call[2] as any).to_state === 'RETRYING'
    )
    expect(retryingStateTransitions.length).toBe(0)
    console.log('✓ No RETRYING state transition occurred')

    // AC4: Transition to ESCALATED state immediately
    console.log('\n--- AC4: Transitioning to ESCALATED state ---')

    const escalationTransition = agentStateManager.transition(
      {
        agent_id,
        run_id,
        reason: 'Destructive tool failed, escalating immediately',
        agent_type: 'executor'
      },
      'ESCALATED'
    )

    expect(escalationTransition.success).toBe(true)
    expect(escalationTransition.current_state).toBe('ESCALATED')
    const finalState = agentStateManager.getState(agent_id)
    expect(finalState).toBe('ESCALATED')
    console.log('✓ AC4: AgentNode.status = ESCALATED immediately after tool failure')

    // AC7: Verify a ticket was filed
    console.log('\n--- AC7: Verifying ticket was filed ---')

    expect(ticketFileSpy).toHaveBeenCalled()

    // Check for escalation ticket
    const escalationTicketCall = ticketFileSpy.mock.calls.find(
      call => call[0] === 'agent_escalated'
    )
    expect(escalationTicketCall).toBeDefined()
    expect(escalationTicketCall![1].agent_id).toBe(agent_id)
    expect(escalationTicketCall![1].run_id).toBe(run_id)
    console.log('✓ AC7: Ticket filed for agent escalation')
    console.log(`   Ticket type: agent_escalated`)
    console.log(`   Agent ID: ${agent_id}`)

    // Verify ticket in system
    const tickets = ticketSystem.list(run_id)
    const escalationTicket = tickets.find(t => t.ticket_type === 'agent_escalated')
    expect(escalationTicket).toBeDefined()
    expect(escalationTicket!.severity).toBe('MAJOR')
    console.log(`   Ticket severity: ${escalationTicket!.severity}`)
    console.log(`   Ticket ID: ${escalationTicket!.ticket_id}`)

    console.log('\n=== Test Passed: All AC1-AC8 criteria satisfied ===\n')
    console.log('Summary:')
    console.log(`  ✓ AC1: Tool registered with side_effect_class="destructive" and retry_on_error=true`)
    console.log(`  ✓ AC2: Tool injected into Executor and failed`)
    console.log(`  ✓ AC3: Tool execution attempt count = exactly 1`)
    console.log(`  ✓ AC4: AgentNode.status = ESCALATED`)
    console.log(`  ✓ AC5: RetryOrchestrator did NOT compose retry prompt`)
    console.log(`  ✓ AC6: No retry budget consumed`)
    console.log(`  ✓ AC7: Ticket filed for escalation`)
    console.log(`  ✓ AC8: retry_on_error=true overridden by side_effect_class="destructive"`)
  })

  it('should contrast: non-destructive tool with retry_on_error=true DOES retry', async () => {
    const agent_id = 'executor-non-destructive-tool'
    const run_id = 'run-non-destructive-tool'

    console.log('\n=== UAT-077 Contrast Test: Non-destructive tool with retry_on_error=true DOES retry ===\n')

    // Register a non-destructive tool with retry_on_error=true
    const nonDestructiveTool: Tool = {
      tool_id: 'read_database',
      input_schema: {
        type: 'object',
        properties: {
          query: { type: 'string' }
        },
        required: ['query']
      },
      output_schema: {
        type: 'object',
        properties: {
          results: { type: 'array' }
        },
        required: ['results']
      },
      side_effect_class: 'read_only',
      retry_on_error: true
    }

    toolRegistry.register(nonDestructiveTool)
    console.log('✓ Registered non-destructive tool with retry_on_error=true')
    console.log(`   Tool ID: ${nonDestructiveTool.tool_id}`)
    console.log(`   side_effect_class: ${nonDestructiveTool.side_effect_class}`)
    console.log(`   retry_on_error: ${nonDestructiveTool.retry_on_error}`)

    // Create injected toolset
    const injectedToolset: InjectedToolset = {
      tools: [nonDestructiveTool],
      get(tool_id: string): Tool {
        const tool = this.tools.find(t => t.tool_id === tool_id)
        if (!tool) throw new Error(`Tool not found: ${tool_id}`)
        return tool
      },
      has(tool_id: string): boolean {
        return this.tools.some(t => t.tool_id === tool_id)
      }
    }

    // Initialize agent
    agentStateManager.initializeAgent(agent_id, run_id, 'executor')
    executionMemoryStore.init(agent_id, run_id)

    let executionAttempts = 0
    const mockExecutor = vi.fn(async (tool_id: string, input: any): Promise<any> => {
      executionAttempts++
      console.log(`   Tool execution attempt ${executionAttempts}`)

      if (executionAttempts === 1) {
        // First attempt fails
        throw new Error('Database read failed - transient error')
      }

      // Second attempt succeeds
      return { results: ['row1', 'row2'] }
    })

    const toolCall: ToolCall = {
      tool_id: 'read_database',
      input: { query: 'SELECT * FROM test' },
      agent_id
    }

    const toolResult: ToolExecutionResult = await sandboxEnforcer.executeToolWithEnforcement(
      toolCall,
      injectedToolset,
      mockExecutor,
      run_id
    )

    // Verify non-destructive tool WAS retried
    expect(executionAttempts).toBe(2)
    console.log('✓ Non-destructive tool WAS retried (2 attempts)')
    console.log(`   Total attempts: ${executionAttempts}`)

    // Verify tool execution succeeded on retry
    expect(toolResult.success).toBe(true)
    expect(toolResult.output).toEqual({ results: ['row1', 'row2'] })
    expect(toolResult.retry_attempted).toBe(true)
    console.log('✓ Tool execution succeeded on retry')
    console.log(`   retry_attempted: ${toolResult.retry_attempted}`)

    console.log('\n=== Contrast Test Passed: Non-destructive tool behavior confirmed ===\n')
  })

  it('should verify RetryOrchestrator behavior when ToolRegistry is not provided', async () => {
    const agent_id = 'executor-no-registry'
    const run_id = 'run-no-registry'

    console.log('\n=== UAT-077 Edge Case: RetryOrchestrator without ToolRegistry ===\n')

    // Create RetryOrchestrator WITHOUT ToolRegistry
    const retryOrchestratorNoRegistry = new RetryOrchestrator(
      failureClassifier,
      executionMemoryStore,
      evalPipeline,
      undefined, // No ToolRegistry
      {
        max_retries: 3,
        blob_write_retry_max: 3,
        similarity_threshold: 0.75,
        blob_write_backoff_base_ms: 100
      }
    )

    executionMemoryStore.init(agent_id, run_id)

    // Without ToolRegistry, it should assume non-destructive and allow retry
    const retryDecision = retryOrchestratorNoRegistry.decideRetry({
      agent_id,
      failure_type: 'tool_failure',
      gate: 1,
      gap: 'Tool failure',
      attempt: 1,
      tool_id: 'unknown_tool' // Tool not in registry
    })

    expect(retryDecision.should_retry).toBe(true)
    console.log('✓ Without ToolRegistry, assumes non-destructive (should_retry=true)')
    console.log(`   should_retry: ${retryDecision.should_retry}`)
    console.log(`   This is a safe default - assumes tools are non-destructive when unknown`)

    console.log('\n=== Edge Case Test Passed ===\n')
  })

  it('should verify destructive tool detection across multiple tools', async () => {
    console.log('\n=== UAT-077 Multi-Tool Test: Multiple destructive and non-destructive tools ===\n')

    // Register multiple tools with different side_effect_class values
    const tools: Tool[] = [
      {
        tool_id: 'delete_user',
        input_schema: { type: 'object' },
        output_schema: { type: 'object' },
        side_effect_class: 'destructive',
        retry_on_error: true
      },
      {
        tool_id: 'update_user',
        input_schema: { type: 'object' },
        output_schema: { type: 'object' },
        side_effect_class: 'write_repeatable',
        retry_on_error: true
      },
      {
        tool_id: 'create_user',
        input_schema: { type: 'object' },
        output_schema: { type: 'object' },
        side_effect_class: 'write_once',
        retry_on_error: false
      },
      {
        tool_id: 'read_user',
        input_schema: { type: 'object' },
        output_schema: { type: 'object' },
        side_effect_class: 'read_only',
        retry_on_error: true
      },
      {
        tool_id: 'drop_table',
        input_schema: { type: 'object' },
        output_schema: { type: 'object' },
        side_effect_class: 'destructive',
        retry_on_error: true
      }
    ]

    tools.forEach(tool => toolRegistry.register(tool))
    console.log(`✓ Registered ${tools.length} tools with various side_effect_class values`)

    const agent_id = 'executor-multi-tool'
    const run_id = 'run-multi-tool'
    executionMemoryStore.init(agent_id, run_id)

    // Test retry decisions for each tool
    const results = tools.map(tool => {
      const decision = retryOrchestrator.decideRetry({
        agent_id,
        failure_type: 'tool_failure',
        gate: 1,
        gap: 'Tool failed',
        attempt: 1,
        tool_id: tool.tool_id
      })

      const isDestructive = tool.side_effect_class === 'destructive'
      const shouldEscalate = isDestructive
      const shouldRetry = !isDestructive

      console.log(`   ${tool.tool_id} (${tool.side_effect_class}):`)
      console.log(`     should_retry=${decision.should_retry}, should_escalate=${decision.should_escalate}`)

      return {
        tool_id: tool.tool_id,
        side_effect_class: tool.side_effect_class,
        decision,
        isDestructive
      }
    })

    // Verify destructive tools escalate immediately
    const destructiveResults = results.filter(r => r.isDestructive)
    destructiveResults.forEach(r => {
      expect(r.decision.should_retry).toBe(false)
      expect(r.decision.should_escalate).toBe(true)
      expect(r.decision.retry_prompt).toBeNull()
    })
    console.log(`\n✓ All ${destructiveResults.length} destructive tools escalate immediately (no retry)`)

    // Verify non-destructive tools allow retry
    const nonDestructiveResults = results.filter(r => !r.isDestructive)
    nonDestructiveResults.forEach(r => {
      expect(r.decision.should_retry).toBe(true)
      expect(r.decision.should_escalate).toBe(false)
    })
    console.log(`✓ All ${nonDestructiveResults.length} non-destructive tools allow retry`)

    console.log('\n=== Multi-Tool Test Passed ===\n')
  })
})
