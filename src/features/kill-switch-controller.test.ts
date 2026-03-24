import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { KillSwitchController } from './kill-switch-controller.js'
import type { BudgetLedger } from '../primitives/budget-ledger.js'
import type { AgentStateManager } from '../components/agent-state-manager.js'
import type { MessageBus } from '../primitives/message-bus.js'
import type { TicketSystem } from '../primitives/ticket-system.js'
import type { BudgetState, AgentState } from '../primitives/types.js'

describe('KillSwitchController', () => {
  let controller: KillSwitchController
  let mockBudgetLedger: BudgetLedger
  let mockAgentStateManager: AgentStateManager
  let mockMessageBus: MessageBus
  let mockTicketSystem: TicketSystem

  const TEST_RUN_ID = 'test-run-123'
  const TEST_AGENT_IDS = ['agent-1', 'agent-2', 'agent-3']
  const TEST_SCOPE_HASH = 'scope-hash-abc123'

  beforeEach(() => {
    // Mock BudgetLedger
    mockBudgetLedger = {
      check: vi.fn().mockReturnValue({
        remaining: { tokens: 100, calls: 10, wall_ms: 5000 },
        exceeded: false,
        warning_threshold_hit: false
      })
    } as any

    // Mock AgentStateManager
    mockAgentStateManager = {
      transition: vi.fn().mockReturnValue({ success: true, current_state: 'ERROR' }),
      setRunState: vi.fn(),
      getState: vi.fn().mockReturnValue('QUEUED')
    } as any

    // Mock MessageBus
    mockMessageBus = {
      emit: vi.fn()
    } as any

    // Mock TicketSystem
    mockTicketSystem = {
      file: vi.fn().mockReturnValue({ ticket_id: 'ticket-123' })
    } as any

    controller = new KillSwitchController(
      mockBudgetLedger,
      mockAgentStateManager,
      mockMessageBus,
      mockTicketSystem,
      {
        loop_detection_threshold: 3,
        partial_output_timeout_ms: 5000,
        run_wall_clock_sla_ms: null
      }
    )
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  describe('Trigger Detection', () => {
    it('detects cost_exceeded from BudgetLedger', () => {
      vi.mocked(mockBudgetLedger.check).mockReturnValue({
        remaining: { tokens: 0, calls: 0, wall_ms: 0 },
        exceeded: true,
        warning_threshold_hit: true
      })

      const trigger = controller.checkTriggers(TEST_RUN_ID)
      expect(trigger).toBe('cost_exceeded')
    })

    it('detects time_exceeded from BudgetLedger wall_ms', () => {
      // Note: BudgetLedger.check() returns exceeded=true if ANY budget type exceeded
      // This test is actually redundant with cost_exceeded test
      // Keeping for completeness, but both map to 'cost_exceeded' trigger
      vi.mocked(mockBudgetLedger.check).mockReturnValue({
        remaining: { tokens: 100, calls: 10, wall_ms: -1000 },
        exceeded: true,
        warning_threshold_hit: true
      })

      const trigger = controller.checkTriggers(TEST_RUN_ID)
      expect(trigger).toBe('cost_exceeded') // BudgetLedger doesn't distinguish budget types
    })

    it('detects time_exceeded from run_wall_clock_sla_ms', () => {
      const controllerWithSLA = new KillSwitchController(
        mockBudgetLedger,
        mockAgentStateManager,
        mockMessageBus,
        mockTicketSystem,
        {
          loop_detection_threshold: 3,
          partial_output_timeout_ms: 5000,
          run_wall_clock_sla_ms: 10000
        }
      )

      // Simulate run start
      controllerWithSLA.startRun(TEST_RUN_ID)

      // Fast-forward time past SLA
      vi.useFakeTimers()
      vi.advanceTimersByTime(11000)

      const trigger = controllerWithSLA.checkTriggers(TEST_RUN_ID)
      expect(trigger).toBe('time_exceeded')

      vi.useRealTimers()
    })

    it('detects loop_detected when scope hash retries exceed threshold', () => {
      controller.recordRetry(TEST_RUN_ID, TEST_SCOPE_HASH)
      controller.recordRetry(TEST_RUN_ID, TEST_SCOPE_HASH)
      controller.recordRetry(TEST_RUN_ID, TEST_SCOPE_HASH)
      controller.recordRetry(TEST_RUN_ID, TEST_SCOPE_HASH) // 4th retry > threshold of 3

      const trigger = controller.checkTriggers(TEST_RUN_ID)
      expect(trigger).toBe('loop_detected')
    })

    it('does not trigger on budget warning (only exceeded)', () => {
      vi.mocked(mockBudgetLedger.check).mockReturnValue({
        remaining: { tokens: 50, calls: 5, wall_ms: 2000 },
        exceeded: false,
        warning_threshold_hit: true
      })

      const trigger = controller.checkTriggers(TEST_RUN_ID)
      expect(trigger).toBeNull()
    })
  })

  describe('abort_run Action', () => {
    it('halts all agents immediately', () => {
      controller.abortRun(TEST_RUN_ID, 'cost_exceeded', TEST_AGENT_IDS)

      expect(mockAgentStateManager.transition).toHaveBeenCalledTimes(3)
      expect(mockAgentStateManager.transition).toHaveBeenCalledWith(
        expect.objectContaining({
          agent_id: 'agent-1',
          run_id: TEST_RUN_ID,
          reason: expect.stringContaining('Kill switch')
        }),
        'ERROR'
      )
    })

    it('transitions run to ERROR state', () => {
      controller.abortRun(TEST_RUN_ID, 'cost_exceeded', TEST_AGENT_IDS)

      expect(mockAgentStateManager.setRunState).toHaveBeenCalledWith(TEST_RUN_ID, 'ERROR')
    })

    it('files CRITICAL ticket with kill_switch_triggered', () => {
      controller.abortRun(TEST_RUN_ID, 'cost_exceeded', TEST_AGENT_IDS)

      expect(mockTicketSystem.file).toHaveBeenCalledWith('kill_switch_triggered', {
        run_id: TEST_RUN_ID,
        trigger: 'cost_exceeded',
        action: 'abort_run'
      })
    })

    it('emits kill_switch_triggered event', () => {
      controller.abortRun(TEST_RUN_ID, 'cost_exceeded', TEST_AGENT_IDS)

      expect(mockMessageBus.emit).toHaveBeenCalledWith(
        TEST_RUN_ID,
        'kill_switch_triggered',
        expect.objectContaining({
          trigger: 'cost_exceeded',
          action: 'abort_run'
        })
      )
    })
  })

  describe('escalate_run Action', () => {
    it('stops new spawns (implementation detail: flag check)', () => {
      controller.escalateRun(TEST_RUN_ID, 'time_exceeded', TEST_AGENT_IDS)

      expect(controller.isEscalated(TEST_RUN_ID)).toBe(true)
    })

    it('marks in-flight agents ESCALATED', () => {
      vi.mocked(mockAgentStateManager.getState).mockReturnValue('GENERATING')

      controller.escalateRun(TEST_RUN_ID, 'time_exceeded', TEST_AGENT_IDS)

      expect(mockAgentStateManager.transition).toHaveBeenCalledWith(
        expect.objectContaining({
          agent_id: expect.any(String),
          run_id: TEST_RUN_ID
        }),
        'ESCALATED'
      )
    })

    it('does not change run state', () => {
      controller.escalateRun(TEST_RUN_ID, 'time_exceeded', TEST_AGENT_IDS)

      expect(mockAgentStateManager.setRunState).not.toHaveBeenCalled()
    })

    it('files CRITICAL ticket', () => {
      controller.escalateRun(TEST_RUN_ID, 'time_exceeded', TEST_AGENT_IDS)

      expect(mockTicketSystem.file).toHaveBeenCalledWith('kill_switch_triggered', {
        run_id: TEST_RUN_ID,
        trigger: 'time_exceeded',
        action: 'escalate_run'
      })
    })

    it('emits kill_switch_escalation event', () => {
      controller.escalateRun(TEST_RUN_ID, 'time_exceeded', TEST_AGENT_IDS)

      expect(mockMessageBus.emit).toHaveBeenCalledWith(
        TEST_RUN_ID,
        'kill_switch_escalation',
        expect.objectContaining({
          trigger: 'time_exceeded'
        })
      )
    })
  })

  describe('finalize_partial Action', () => {
    it('cancels QUEUED agents', async () => {
      vi.mocked(mockAgentStateManager.getState).mockReturnValue('QUEUED')

      await controller.finalizePartial(TEST_RUN_ID, 'loop_detected', TEST_AGENT_IDS)

      expect(mockAgentStateManager.transition).toHaveBeenCalledWith(
        expect.objectContaining({ agent_id: expect.any(String) }),
        'CANCELLED'
      )
    })

    it('cancels RETRYING agents', async () => {
      vi.mocked(mockAgentStateManager.getState).mockReturnValue('RETRYING')

      await controller.finalizePartial(TEST_RUN_ID, 'loop_detected', TEST_AGENT_IDS)

      expect(mockAgentStateManager.transition).toHaveBeenCalledWith(
        expect.objectContaining({ agent_id: expect.any(String) }),
        'CANCELLED'
      )
    })

    it('gives GENERATING agents partial_output_timeout_ms to finish', async () => {
      vi.useFakeTimers()

      vi.mocked(mockAgentStateManager.getState).mockReturnValue('GENERATING')

      const promise = controller.finalizePartial(TEST_RUN_ID, 'loop_detected', TEST_AGENT_IDS)

      // Should not resolve immediately
      let resolved = false
      promise.then(() => { resolved = true })

      await vi.advanceTimersByTimeAsync(4000)
      expect(resolved).toBe(false)

      // Should resolve after timeout
      await vi.advanceTimersByTimeAsync(1500)
      expect(resolved).toBe(true)

      vi.useRealTimers()
    })

    it('transitions remaining GENERATING to ESCALATED after timeout', async () => {
      vi.useFakeTimers()

      vi.mocked(mockAgentStateManager.getState).mockReturnValue('GENERATING')

      const promise = controller.finalizePartial(TEST_RUN_ID, 'loop_detected', TEST_AGENT_IDS)

      await vi.advanceTimersByTimeAsync(5000)
      await promise

      expect(mockAgentStateManager.transition).toHaveBeenCalledWith(
        expect.objectContaining({ agent_id: expect.any(String) }),
        'ESCALATED'
      )

      vi.useRealTimers()
    })

    it('transitions run to PARTIAL_COMPLETE', async () => {
      await controller.finalizePartial(TEST_RUN_ID, 'loop_detected', TEST_AGENT_IDS)

      expect(mockAgentStateManager.setRunState).toHaveBeenCalledWith(
        TEST_RUN_ID,
        'PARTIAL_COMPLETE'
      )
    })

    it('files CRITICAL ticket', async () => {
      await controller.finalizePartial(TEST_RUN_ID, 'loop_detected', TEST_AGENT_IDS)

      expect(mockTicketSystem.file).toHaveBeenCalledWith('kill_switch_triggered', {
        run_id: TEST_RUN_ID,
        trigger: 'loop_detected',
        action: 'finalize_partial'
      })
    })

    it('emits kill_switch_partial_finalize event', async () => {
      await controller.finalizePartial(TEST_RUN_ID, 'loop_detected', TEST_AGENT_IDS)

      expect(mockMessageBus.emit).toHaveBeenCalledWith(
        TEST_RUN_ID,
        'kill_switch_partial_finalize',
        expect.objectContaining({
          trigger: 'loop_detected'
        })
      )
    })
  })

  describe('Loop Detection', () => {
    it('tracks scope hash retries per run', () => {
      controller.recordRetry(TEST_RUN_ID, TEST_SCOPE_HASH)
      controller.recordRetry(TEST_RUN_ID, TEST_SCOPE_HASH)

      const trigger = controller.checkTriggers(TEST_RUN_ID)
      expect(trigger).toBeNull() // Not exceeded yet
    })

    it('increments retry count on recordRetry(scope_hash)', () => {
      controller.recordRetry(TEST_RUN_ID, TEST_SCOPE_HASH)
      controller.recordRetry(TEST_RUN_ID, TEST_SCOPE_HASH)
      controller.recordRetry(TEST_RUN_ID, TEST_SCOPE_HASH)
      controller.recordRetry(TEST_RUN_ID, TEST_SCOPE_HASH)

      const trigger = controller.checkTriggers(TEST_RUN_ID)
      expect(trigger).toBe('loop_detected')
    })

    it('resets state between runs', () => {
      controller.recordRetry(TEST_RUN_ID, TEST_SCOPE_HASH)
      controller.recordRetry(TEST_RUN_ID, TEST_SCOPE_HASH)
      controller.recordRetry(TEST_RUN_ID, TEST_SCOPE_HASH)
      controller.recordRetry(TEST_RUN_ID, TEST_SCOPE_HASH)

      expect(controller.checkTriggers(TEST_RUN_ID)).toBe('loop_detected')

      // Different run should start fresh
      const DIFFERENT_RUN_ID = 'test-run-456'
      expect(controller.checkTriggers(DIFFERENT_RUN_ID)).toBeNull()
    })
  })
})
