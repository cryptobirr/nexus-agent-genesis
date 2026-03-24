import { describe, it, expect, beforeEach } from 'vitest'
import { ObservabilityModule, type ObservabilityModuleConfig } from './observability-module.js'
import { MessageBus } from '../primitives/message-bus.js'
import { TicketSystem } from '../primitives/ticket-system.js'
import type { Event } from '../primitives/types.js'

describe('ObservabilityModule', () => {
  let messageBus: MessageBus
  let ticketSystem: TicketSystem
  let observability: ObservabilityModule

  beforeEach(() => {
    messageBus = new MessageBus()
    ticketSystem = new TicketSystem(messageBus)
    observability = new ObservabilityModule(messageBus, ticketSystem)
  })

  describe('constructor', () => {
    it('accepts dependencies and instantiates', () => {
      expect(observability).toBeInstanceOf(ObservabilityModule)
    })

    it('accepts optional config', () => {
      const config: ObservabilityModuleConfig = {
        enable_causal_tracking: false,
        max_causal_chain_depth: 5
      }
      const obs = new ObservabilityModule(messageBus, ticketSystem, config)
      expect(obs).toBeInstanceOf(ObservabilityModule)
    })
  })

  describe('event emission', () => {
    it('logPreCheck emits pre_check event with required fields', () => {
      const run_id = 'run-001'
      const agent_id = 'agent-001'

      observability.logPreCheck(run_id, agent_id, { passed: true, violations: [] })

      const events = messageBus.replay(run_id)
      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({
        event_type: 'pre_check',
        run_id,
        timestamp: expect.any(Number)
      })
      expect(events[0].payload).toMatchObject({
        agent_id,
        passed: true,
        violations: []
      })
    })

    it('logGateVerdict emits gate_verdict event', () => {
      const run_id = 'run-001'
      const agent_id = 'agent-001'

      observability.logGateVerdict(run_id, agent_id, 1, true, 'All dimensions passed')

      const events = messageBus.replay(run_id)
      expect(events[0]).toMatchObject({
        event_type: 'gate_verdict',
        run_id
      })
      expect(events[0].payload).toMatchObject({
        agent_id,
        gate: 1,
        verdict: true,
        reasoning: 'All dimensions passed'
      })
    })

    it('logJudgeReasoning emits judge_reasoning event', () => {
      const run_id = 'run-001'
      const agent_id = 'agent-001'

      observability.logJudgeReasoning(run_id, agent_id, 'dim-01', 'Output meets criteria', 0.95)

      const events = messageBus.replay(run_id)
      expect(events[0]).toMatchObject({
        event_type: 'judge_reasoning',
        run_id
      })
      expect(events[0].payload).toMatchObject({
        agent_id,
        dimension_id: 'dim-01',
        reasoning: 'Output meets criteria',
        score: 0.95
      })
    })

    it('logContextSource emits context_source event', () => {
      const run_id = 'run-001'
      const agent_id = 'agent-001'

      observability.logContextSource(run_id, agent_id, 'schema_reference', 3)

      const events = messageBus.replay(run_id)
      expect(events[0]).toMatchObject({
        event_type: 'context_source',
        run_id
      })
      expect(events[0].payload).toMatchObject({
        agent_id,
        source: 'schema_reference',
        chunk_count: 3
      })
    })

    it('logSECWrite emits sec_write event', () => {
      const run_id = 'run-001'
      const agent_id = 'agent-001'

      observability.logSECWrite(run_id, agent_id, 'shared_state', 1)

      const events = messageBus.replay(run_id)
      expect(events[0]).toMatchObject({
        event_type: 'sec_write',
        run_id
      })
      expect(events[0].payload).toMatchObject({
        agent_id,
        key: 'shared_state',
        version_id: 1
      })
    })

    it('logOCCConflict emits occ_conflict event', () => {
      const run_id = 'run-001'
      const agent_id = 'agent-001'

      observability.logOCCConflict(run_id, agent_id, 'shared_state', {
        key: 'shared_state',
        attempted_value: 'new',
        current_value: 'old',
        current_version_id: 2
      })

      const events = messageBus.replay(run_id)
      expect(events[0]).toMatchObject({
        event_type: 'occ_conflict',
        run_id
      })
      expect(events[0].payload).toMatchObject({
        agent_id,
        key: 'shared_state',
        conflict_info: {
          current_version_id: 2
        }
      })
    })

    it('logOCCRetry emits sec_occ_retry event', () => {
      const run_id = 'run-001'
      const agent_id = 'agent-001'

      observability.logOCCRetry(run_id, agent_id, 1, 2)

      const events = messageBus.replay(run_id)
      expect(events[0]).toMatchObject({
        event_type: 'sec_occ_retry',
        run_id
      })
      expect(events[0].payload).toMatchObject({
        agent_id,
        attempt: 1,
        max_retries: 2
      })
    })

    it('logDependencyEdge emits dependency_edge event', () => {
      const run_id = 'run-001'

      observability.logDependencyEdge(run_id, 'agent-001', 'agent-002', 'data')

      const events = messageBus.replay(run_id)
      expect(events[0]).toMatchObject({
        event_type: 'dependency_edge',
        run_id
      })
      expect(events[0].payload).toMatchObject({
        from_node: 'agent-001',
        to_node: 'agent-002',
        edge_type: 'data'
      })
    })

    it('logHITLEvent emits hitl_event', () => {
      const run_id = 'run-001'
      const agent_id = 'agent-001'

      observability.logHITLEvent(run_id, agent_id, 'checkpoint-01', 'approved')

      const events = messageBus.replay(run_id)
      expect(events[0]).toMatchObject({
        event_type: 'hitl_event',
        run_id
      })
      expect(events[0].payload).toMatchObject({
        agent_id,
        checkpoint_id: 'checkpoint-01',
        resolution: 'approved'
      })
    })

    it('logRecursionGuardOverride emits recursion_guard_override', () => {
      const run_id = 'run-001'
      const agent_id = 'agent-001'

      observability.logRecursionGuardOverride(run_id, agent_id, 'complexity_override_matched')

      const events = messageBus.replay(run_id)
      expect(events[0]).toMatchObject({
        event_type: 'recursion_guard_override',
        run_id
      })
      expect(events[0].payload).toMatchObject({
        agent_id,
        reason: 'complexity_override_matched'
      })
    })

    it('logRetry emits retry event', () => {
      const run_id = 'run-001'
      const agent_id = 'agent-001'

      observability.logRetry(run_id, agent_id, 1, 'reasoning_failure')

      const events = messageBus.replay(run_id)
      expect(events[0]).toMatchObject({
        event_type: 'retry',
        run_id
      })
      expect(events[0].payload).toMatchObject({
        agent_id,
        attempt: 1,
        failure_type: 'reasoning_failure'
      })
    })

    it('logCompression emits compression event', () => {
      const run_id = 'run-001'

      observability.logCompression(run_id, 'node-001', 1024, 512)

      const events = messageBus.replay(run_id)
      expect(events[0]).toMatchObject({
        event_type: 'compression',
        run_id
      })
      expect(events[0].payload).toMatchObject({
        node_id: 'node-001',
        original_size: 1024,
        compressed_size: 512
      })
    })

    it('logBlobWrite emits blob_write event', () => {
      const run_id = 'run-001'
      const agent_id = 'agent-001'

      observability.logBlobWrite(run_id, agent_id, 'ref-001', 2048)

      const events = messageBus.replay(run_id)
      expect(events[0]).toMatchObject({
        event_type: 'blob_write',
        run_id
      })
      expect(events[0].payload).toMatchObject({
        agent_id,
        ref_id: 'ref-001',
        size_bytes: 2048
      })
    })

    it('logFailureType emits failure_type event', () => {
      const run_id = 'run-001'
      const agent_id = 'agent-001'

      observability.logFailureType(run_id, agent_id, 'tool_failure', 2)

      const events = messageBus.replay(run_id)
      expect(events[0]).toMatchObject({
        event_type: 'failure_type',
        run_id
      })
      expect(events[0].payload).toMatchObject({
        agent_id,
        failure_type: 'tool_failure',
        gate: 2
      })
    })

    it('logNormalizationResult emits normalization_result event', () => {
      const run_id = 'run-001'
      const agent_id = 'agent-001'

      observability.logNormalizationResult(run_id, agent_id, true, null)

      const events = messageBus.replay(run_id)
      expect(events[0]).toMatchObject({
        event_type: 'normalization_result',
        run_id
      })
      expect(events[0].payload).toMatchObject({
        agent_id,
        passed: true,
        failure_reason: null
      })
    })

    it('logSandboxEvent emits sandbox_event', () => {
      const run_id = 'run-001'
      const agent_id = 'agent-001'

      observability.logSandboxEvent(run_id, agent_id, 'tool_execution', { tool_id: 'test' })

      const events = messageBus.replay(run_id)
      expect(events[0]).toMatchObject({
        event_type: 'sandbox_event',
        run_id
      })
      expect(events[0].payload).toMatchObject({
        agent_id,
        event_type: 'tool_execution',
        details: { tool_id: 'test' }
      })
    })

    it('logKillSwitch emits kill_switch event', () => {
      const run_id = 'run-001'

      observability.logKillSwitch(run_id, 'budget_exceeded')

      const events = messageBus.replay(run_id)
      expect(events[0]).toMatchObject({
        event_type: 'kill_switch',
        run_id
      })
      expect(events[0].payload).toMatchObject({
        trigger: 'budget_exceeded'
      })
    })

    it('logBudgetState emits budget_state event', () => {
      const run_id = 'run-001'

      observability.logBudgetState(run_id, { tokens: 1000, calls: 10, wall_ms: 5000 }, false)

      const events = messageBus.replay(run_id)
      expect(events[0]).toMatchObject({
        event_type: 'budget_state',
        run_id
      })
      expect(events[0].payload).toMatchObject({
        remaining: { tokens: 1000 },
        exceeded: false
      })
    })

    it('logSECSizeWarning emits sec_size_warning event', () => {
      const run_id = 'run-001'

      observability.logSECSizeWarning(run_id, 10001, 10000)

      const events = messageBus.replay(run_id)
      expect(events[0]).toMatchObject({
        event_type: 'sec_size_warning',
        run_id
      })
      expect(events[0].payload).toMatchObject({
        entry_count: 10001,
        max_entries: 10000
      })
    })

    it('logPatternLookupLatency emits pattern_lookup_latency_ms event', () => {
      const run_id = 'run-001'

      observability.logPatternLookupLatency(run_id, 'node-001', 45)

      const events = messageBus.replay(run_id)
      expect(events[0]).toMatchObject({
        event_type: 'pattern_lookup_latency_ms',
        run_id
      })
      expect(events[0].payload).toMatchObject({
        node_id: 'node-001',
        latency_ms: 45
      })
    })
  })

  describe('state transitions with causal tracking', () => {
    it('logStateTransition emits state_transition event', () => {
      const run_id = 'run-001'
      const agent_id = 'agent-001'

      observability.logStateTransition(run_id, agent_id, 'GENERATING', 'GATE1_EVALUATING')

      const events = messageBus.replay(run_id)
      expect(events[0]).toMatchObject({
        event_type: 'state_transition',
        run_id
      })
      expect(events[0].payload).toMatchObject({
        agent_id,
        from_state: 'GENERATING',
        to_state: 'GATE1_EVALUATING'
      })
    })

    it('logStateTransition with ESCALATED includes caused_by', () => {
      const run_id = 'run-001'
      const agent_id = 'agent-002'

      observability.logStateTransition(run_id, agent_id, 'RETRYING', 'ESCALATED', 'agent-001')

      const events = messageBus.replay(run_id)
      expect(events[0].payload).toMatchObject({
        agent_id,
        to_state: 'ESCALATED',
        caused_by: 'agent-001'
      })
    })

    it('getCausalChain returns chain for ESCALATED agent', () => {
      const run_id = 'run-001'

      // Build chain: root-cause → agent-001 → agent-002
      observability.logStateTransition(run_id, 'root-cause', 'GENERATING', 'ERROR')
      observability.logStateTransition(run_id, 'agent-001', 'GENERATING', 'ERROR', 'root-cause')
      observability.logStateTransition(run_id, 'agent-002', 'RETRYING', 'ESCALATED', 'agent-001')

      const chain = observability.getCausalChain(run_id, 'agent-002')
      expect(chain).toEqual(['agent-002', 'agent-001', 'root-cause'])
    })

    it('getCausalChain returns empty for non-ESCALATED agent', () => {
      const run_id = 'run-001'

      observability.logStateTransition(run_id, 'agent-001', 'GENERATING', 'COMPLETE')

      const chain = observability.getCausalChain(run_id, 'agent-001')
      expect(chain).toEqual([])
    })
  })

  describe('Inspector API', () => {
    it('replay returns all events for run', () => {
      const run_id = 'run-001'

      observability.logPreCheck(run_id, 'agent-001', { passed: true, violations: [] })
      observability.logGateVerdict(run_id, 'agent-001', 1, true, 'Pass')
      observability.logStateTransition(run_id, 'agent-001', 'GENERATING', 'COMPLETE')

      const events = observability.replay(run_id)
      expect(events).toHaveLength(3)
      expect(events[0].event_type).toBe('pre_check')
      expect(events[1].event_type).toBe('gate_verdict')
      expect(events[2].event_type).toBe('state_transition')
    })

    it('queryEvents filters by agent_id', () => {
      const run_id = 'run-001'

      observability.logPreCheck(run_id, 'agent-001', { passed: true, violations: [] })
      observability.logPreCheck(run_id, 'agent-002', { passed: true, violations: [] })

      const events = observability.queryEvents(run_id, { agent_id: 'agent-001' })
      expect(events).toHaveLength(1)
      expect((events[0].payload as any).agent_id).toBe('agent-001')
    })

    it('queryEvents filters by event_types', () => {
      const run_id = 'run-001'

      observability.logPreCheck(run_id, 'agent-001', { passed: true, violations: [] })
      observability.logGateVerdict(run_id, 'agent-001', 1, true, 'Pass')
      observability.logRetry(run_id, 'agent-001', 1, 'tool_failure')

      const events = observability.queryEvents(run_id, { event_types: ['pre_check', 'retry'] })
      expect(events).toHaveLength(2)
      expect(events[0].event_type).toBe('pre_check')
      expect(events[1].event_type).toBe('retry')
    })

    it('queryEvents filters by time_range', () => {
      const run_id = 'run-001'

      observability.logPreCheck(run_id, 'agent-001', { passed: true, violations: [] })

      // Get first event timestamp
      const allEvents = messageBus.replay(run_id)
      const firstTimestamp = allEvents[0].timestamp

      // Log second event (force different timestamp)
      const futureTimestamp = firstTimestamp + 1000

      // Temporarily override Date.now for second event
      const originalNow = Date.now
      Date.now = () => futureTimestamp
      observability.logGateVerdict(run_id, 'agent-001', 1, true, 'Pass')
      Date.now = originalNow

      const events = observability.queryEvents(run_id, {
        time_range: { start: firstTimestamp - 100, end: firstTimestamp + 500 }
      })
      expect(events).toHaveLength(1)
      expect(events[0].event_type).toBe('pre_check')
    })
  })

  describe('causal chain depth limiting', () => {
    it('respects max_causal_chain_depth config', () => {
      const config: ObservabilityModuleConfig = {
        enable_causal_tracking: true,
        max_causal_chain_depth: 2
      }
      const obs = new ObservabilityModule(messageBus, ticketSystem, config)
      const run_id = 'run-001'

      obs.logStateTransition(run_id, 'agent-001', 'GENERATING', 'ERROR', 'root')
      obs.logStateTransition(run_id, 'agent-002', 'GENERATING', 'ESCALATED', 'agent-001')
      obs.logStateTransition(run_id, 'agent-003', 'GENERATING', 'ESCALATED', 'agent-002')

      const chain = obs.getCausalChain(run_id, 'agent-003')
      expect(chain.length).toBeLessThanOrEqual(2)
      expect(chain).toEqual(['agent-003', 'agent-002'])
    })

    it('disables causal tracking when enable_causal_tracking is false', () => {
      const config: ObservabilityModuleConfig = {
        enable_causal_tracking: false,
        max_causal_chain_depth: 10
      }
      const obs = new ObservabilityModule(messageBus, ticketSystem, config)
      const run_id = 'run-001'

      obs.logStateTransition(run_id, 'agent-001', 'GENERATING', 'ERROR', 'root')
      obs.logStateTransition(run_id, 'agent-002', 'GENERATING', 'ESCALATED', 'agent-001')

      const chain = obs.getCausalChain(run_id, 'agent-002')
      expect(chain).toEqual([])
    })
  })
})
