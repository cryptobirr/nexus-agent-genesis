import { describe, it, expect, beforeEach, vi } from 'vitest'
import { OuterLoopController, type OuterLoopTrigger } from './outer-loop.js'
import type { EvalPipeline } from '../components/eval-pipeline.js'
import type { RetryOrchestrator } from '../components/retry-orchestrator.js'
import type { AgentStateManager } from '../components/agent-state-manager.js'
import type { MessageBus } from '../primitives/message-bus.js'
import type { TicketSystem } from '../primitives/ticket-system.js'
import type { AgentState } from '../primitives/types.js'

describe('OuterLoopController', () => {
  let outerLoop: OuterLoopController
  let mockEvalPipeline: EvalPipeline
  let mockRetryOrchestrator: RetryOrchestrator
  let mockStateManager: AgentStateManager
  let mockMessageBus: MessageBus
  let mockTicketSystem: TicketSystem

  beforeEach(() => {
    // Create mocks
    mockEvalPipeline = {} as EvalPipeline
    mockRetryOrchestrator = {
      decideRetry: vi.fn(),
      recordFailedAttempt: vi.fn()
    } as any
    mockStateManager = {
      getState: vi.fn(),
      getRunState: vi.fn(),
      transition: vi.fn(),
      setRunState: vi.fn()
    } as any
    mockMessageBus = {
      emit: vi.fn(),
      subscribe: vi.fn()
    } as any
    mockTicketSystem = {
      file: vi.fn()
    } as any

    outerLoop = new OuterLoopController(
      mockEvalPipeline,
      mockRetryOrchestrator,
      mockStateManager,
      mockMessageBus,
      mockTicketSystem
    )
  })

  describe('shouldTrigger', () => {
    it('does NOT trigger when kill switch fired', () => {
      const result = outerLoop.shouldTrigger({
        run_id: 'run-1',
        kill_switch_fired: true,
        agent_ids: ['agent-1'],
        trace_eval_failed: false,
        budget_exceeded: false,
        budget_exceeded_config: null
      })

      expect(result.should_trigger).toBe(false)
    })

    it('triggers on trace eval failure', () => {
      const result = outerLoop.shouldTrigger({
        run_id: 'run-1',
        kill_switch_fired: false,
        agent_ids: ['agent-1'],
        trace_eval_failed: true,
        budget_exceeded: false,
        budget_exceeded_config: null
      })

      expect(result.should_trigger).toBe(true)
      expect(result.trigger).toBe('trace_eval_failure')
    })

    it('triggers on ESCALATED nodes', () => {
      // Mock agent states
      vi.mocked(mockStateManager.getState).mockReturnValue('ESCALATED' as AgentState)

      const result = outerLoop.shouldTrigger({
        run_id: 'run-1',
        kill_switch_fired: false,
        agent_ids: ['agent-1', 'agent-2'],
        trace_eval_failed: false,
        budget_exceeded: false,
        budget_exceeded_config: null
      })

      expect(result.should_trigger).toBe(true)
      expect(result.trigger).toBe('escalated_nodes')
    })

    it('triggers on HITL timeout with escalate', () => {
      // Simulate HITL timeout event already processed
      outerLoop.recordHITLTimeout('run-1', 'agent-1', 'escalate')

      const result = outerLoop.shouldTrigger({
        run_id: 'run-1',
        kill_switch_fired: false,
        agent_ids: ['agent-1'],
        trace_eval_failed: false,
        budget_exceeded: false,
        budget_exceeded_config: null
      })

      expect(result.should_trigger).toBe(true)
      expect(result.trigger).toBe('hitl_timeout_escalate')
    })

    it('triggers on budget exceeded with escalate', () => {
      const result = outerLoop.shouldTrigger({
        run_id: 'run-1',
        kill_switch_fired: false,
        agent_ids: ['agent-1'],
        trace_eval_failed: false,
        budget_exceeded: true,
        budget_exceeded_config: 'escalate'
      })

      expect(result.should_trigger).toBe(true)
      expect(result.trigger).toBe('budget_exceeded_escalate')
    })

    it('does NOT trigger when no conditions met', () => {
      vi.mocked(mockStateManager.getState).mockReturnValue('COMPLETE' as AgentState)

      const result = outerLoop.shouldTrigger({
        run_id: 'run-1',
        kill_switch_fired: false,
        agent_ids: ['agent-1'],
        trace_eval_failed: false,
        budget_exceeded: false,
        budget_exceeded_config: null
      })

      expect(result.should_trigger).toBe(false)
    })
  })

  describe('executeRepair', () => {
    it('logs repair attempt via MessageBus', async () => {
      await outerLoop.executeRepair('run-1', 'trace_eval_failure', ['agent-1'])

      expect(mockMessageBus.emit).toHaveBeenCalledWith(
        'run-1',
        'outer_loop_repair_attempt',
        expect.objectContaining({
          trigger: 'trace_eval_failure',
          agent_ids: ['agent-1']
        })
      )
    })

    it('emits repair complete event', async () => {
      await outerLoop.executeRepair('run-1', 'escalated_nodes', ['agent-1'])

      expect(mockMessageBus.emit).toHaveBeenCalledWith(
        'run-1',
        'outer_loop_repair_complete',
        expect.objectContaining({
          trigger: 'escalated_nodes'
        })
      )
    })

    it('files ticket for repair attempt', async () => {
      await outerLoop.executeRepair('run-1', 'trace_eval_failure', ['agent-1'])

      expect(mockTicketSystem.file).toHaveBeenCalledWith(
        'outer_loop_repair_attempted',
        expect.objectContaining({
          run_id: 'run-1',
          trigger: 'trace_eval_failure'
        })
      )
    })
  })

  describe('recordHITLTimeout', () => {
    it('records HITL timeout with escalate for trigger detection', () => {
      outerLoop.recordHITLTimeout('run-1', 'agent-1', 'escalate')

      const result = outerLoop.shouldTrigger({
        run_id: 'run-1',
        kill_switch_fired: false,
        agent_ids: ['agent-1'],
        trace_eval_failed: false,
        budget_exceeded: false,
        budget_exceeded_config: null
      })

      expect(result.should_trigger).toBe(true)
      expect(result.trigger).toBe('hitl_timeout_escalate')
    })

    it('does NOT trigger on HITL timeout with proceed', () => {
      outerLoop.recordHITLTimeout('run-1', 'agent-1', 'proceed')

      const result = outerLoop.shouldTrigger({
        run_id: 'run-1',
        kill_switch_fired: false,
        agent_ids: ['agent-1'],
        trace_eval_failed: false,
        budget_exceeded: false,
        budget_exceeded_config: null
      })

      expect(result.should_trigger).toBe(false)
    })
  })
})
