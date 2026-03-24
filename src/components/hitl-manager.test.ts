import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { HITLManager } from './hitl-manager.js'
import { AgentStateManager } from './agent-state-manager.js'
import { MessageBus } from '../primitives/message-bus.js'
import { TicketSystem } from '../primitives/ticket-system.js'
import type { HITLCheckpoint } from '../primitives/types.js'

describe('HITLManager - C-09', () => {
  let manager: HITLManager
  let stateManager: AgentStateManager
  let messageBus: MessageBus
  let ticketSystem: TicketSystem

  beforeEach(() => {
    messageBus = new MessageBus()
    ticketSystem = new TicketSystem(messageBus)
    stateManager = new AgentStateManager(messageBus, ticketSystem)
    manager = new HITLManager(stateManager, messageBus, ticketSystem)

    // Use fake timers for timeout tests
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('Checkpoint Declaration', () => {
    it('should enter AWAITING_HITL when checkpoint() called', () => {
      const run_id = 'run-1'
      const agent_id = 'agent-1'
      stateManager.initializeAgent(agent_id, run_id)

      const checkpoint: HITLCheckpoint = {
        checkpoint_id: 'checkpoint-1',
        timeout_ms: 5000,
        on_timeout: 'proceed'
      }

      const result = manager.checkpoint(agent_id, run_id, checkpoint)

      expect(result.success).toBe(true)
      expect(stateManager.getState(agent_id)).toBe('AWAITING_HITL')
    })

    it('should emit hitl_checkpoint_reached event', () => {
      const run_id = 'run-1'
      const agent_id = 'agent-1'
      stateManager.initializeAgent(agent_id, run_id)

      const events: any[] = []
      messageBus.subscribe(run_id, 'hitl_checkpoint_reached', (type, payload) => {
        events.push(payload)
      })

      const checkpoint: HITLCheckpoint = {
        checkpoint_id: 'checkpoint-1',
        timeout_ms: 5000,
        on_timeout: 'proceed'
      }

      manager.checkpoint(agent_id, run_id, checkpoint)

      expect(events).toHaveLength(1)
      expect(events[0].agent_id).toBe(agent_id)
      expect(events[0].checkpoint_id).toBe('checkpoint-1')
    })

    it('should fail if agent already in AWAITING_HITL', () => {
      const run_id = 'run-1'
      const agent_id = 'agent-1'
      stateManager.initializeAgent(agent_id, run_id)

      const checkpoint: HITLCheckpoint = {
        checkpoint_id: 'checkpoint-1',
        timeout_ms: 5000,
        on_timeout: 'proceed'
      }

      manager.checkpoint(agent_id, run_id, checkpoint)
      const result = manager.checkpoint(agent_id, run_id, checkpoint)

      expect(result.success).toBe(false)
      expect(result.error_reason).toContain('already in AWAITING_HITL')
    })
  })

  describe('Approve Action', () => {
    it('should transition AWAITING_HITL → PRECHECKING', () => {
      const run_id = 'run-1'
      const agent_id = 'agent-1'
      stateManager.initializeAgent(agent_id, run_id)

      const checkpoint: HITLCheckpoint = {
        checkpoint_id: 'checkpoint-1',
        timeout_ms: 5000,
        on_timeout: 'proceed'
      }

      manager.checkpoint(agent_id, run_id, checkpoint)
      const result = manager.approve(agent_id, run_id)

      expect(result.success).toBe(true)
      expect(stateManager.getState(agent_id)).toBe('PRECHECKING')
    })

    it('should emit hitl_checkpoint_approved event', () => {
      const run_id = 'run-1'
      const agent_id = 'agent-1'
      stateManager.initializeAgent(agent_id, run_id)

      const events: any[] = []
      messageBus.subscribe(run_id, 'hitl_checkpoint_approved', (type, payload) => {
        events.push(payload)
      })

      const checkpoint: HITLCheckpoint = {
        checkpoint_id: 'checkpoint-1',
        timeout_ms: 5000,
        on_timeout: 'proceed'
      }

      manager.checkpoint(agent_id, run_id, checkpoint)
      manager.approve(agent_id, run_id)

      expect(events).toHaveLength(1)
      expect(events[0].agent_id).toBe(agent_id)
      expect(events[0].checkpoint_id).toBe('checkpoint-1')
    })

    it('should clear timeout when approved', () => {
      const run_id = 'run-1'
      const agent_id = 'agent-1'
      stateManager.initializeAgent(agent_id, run_id)

      const checkpoint: HITLCheckpoint = {
        checkpoint_id: 'checkpoint-1',
        timeout_ms: 5000,
        on_timeout: 'proceed'
      }

      manager.checkpoint(agent_id, run_id, checkpoint)
      manager.approve(agent_id, run_id)

      // Advance time past timeout
      vi.advanceTimersByTime(6000)

      // Should still be in PRECHECKING (not affected by timeout)
      expect(stateManager.getState(agent_id)).toBe('PRECHECKING')
    })

    it('should fail if not in AWAITING_HITL', () => {
      const run_id = 'run-1'
      const agent_id = 'agent-1'
      stateManager.initializeAgent(agent_id, run_id)

      const result = manager.approve(agent_id, run_id)

      expect(result.success).toBe(false)
      expect(result.error_reason).toContain('not in AWAITING_HITL')
    })
  })

  describe('Reject Action', () => {
    it('should transition AWAITING_HITL → ESCALATED', () => {
      const run_id = 'run-1'
      const agent_id = 'agent-1'
      stateManager.initializeAgent(agent_id, run_id)

      const checkpoint: HITLCheckpoint = {
        checkpoint_id: 'checkpoint-1',
        timeout_ms: 5000,
        on_timeout: 'proceed'
      }

      manager.checkpoint(agent_id, run_id, checkpoint)
      const result = manager.reject(agent_id, run_id, 'operator rejected')

      expect(result.success).toBe(true)
      expect(stateManager.getState(agent_id)).toBe('ESCALATED')
    })

    it('should emit hitl_checkpoint_rejected event', () => {
      const run_id = 'run-1'
      const agent_id = 'agent-1'
      stateManager.initializeAgent(agent_id, run_id)

      const events: any[] = []
      messageBus.subscribe(run_id, 'hitl_checkpoint_rejected', (type, payload) => {
        events.push(payload)
      })

      const checkpoint: HITLCheckpoint = {
        checkpoint_id: 'checkpoint-1',
        timeout_ms: 5000,
        on_timeout: 'proceed'
      }

      manager.checkpoint(agent_id, run_id, checkpoint)
      manager.reject(agent_id, run_id, 'operator rejected')

      expect(events).toHaveLength(1)
      expect(events[0].agent_id).toBe(agent_id)
      expect(events[0].reason).toBe('operator rejected')
    })

    it('should clear timeout when rejected', () => {
      const run_id = 'run-1'
      const agent_id = 'agent-1'
      stateManager.initializeAgent(agent_id, run_id)

      const checkpoint: HITLCheckpoint = {
        checkpoint_id: 'checkpoint-1',
        timeout_ms: 5000,
        on_timeout: 'proceed'
      }

      manager.checkpoint(agent_id, run_id, checkpoint)
      manager.reject(agent_id, run_id, 'operator rejected')

      // Advance time past timeout
      vi.advanceTimersByTime(6000)

      // Should still be in ESCALATED (not affected by timeout)
      expect(stateManager.getState(agent_id)).toBe('ESCALATED')
    })
  })

  describe('Edit Action', () => {
    it('should transition to PRECHECKING after edit', () => {
      const run_id = 'run-1'
      const agent_id = 'agent-1'
      stateManager.initializeAgent(agent_id, run_id)

      const checkpoint: HITLCheckpoint = {
        checkpoint_id: 'checkpoint-1',
        timeout_ms: 5000,
        on_timeout: 'proceed'
      }

      manager.checkpoint(agent_id, run_id, checkpoint)
      const result = manager.edit(agent_id, run_id, { brief: 'modified brief' })

      expect(result.success).toBe(true)
      expect(stateManager.getState(agent_id)).toBe('PRECHECKING')
    })

    it('should emit hitl_checkpoint_edited event with modifications', () => {
      const run_id = 'run-1'
      const agent_id = 'agent-1'
      stateManager.initializeAgent(agent_id, run_id)

      const events: any[] = []
      messageBus.subscribe(run_id, 'hitl_checkpoint_edited', (type, payload) => {
        events.push(payload)
      })

      const checkpoint: HITLCheckpoint = {
        checkpoint_id: 'checkpoint-1',
        timeout_ms: 5000,
        on_timeout: 'proceed'
      }

      manager.checkpoint(agent_id, run_id, checkpoint)
      manager.edit(agent_id, run_id, { brief: 'modified brief', output: 'modified output' })

      expect(events).toHaveLength(1)
      expect(events[0].agent_id).toBe(agent_id)
      expect(events[0].modifications.brief).toBe('modified brief')
      expect(events[0].modifications.output).toBe('modified output')
    })

    it('should clear timeout when edited', () => {
      const run_id = 'run-1'
      const agent_id = 'agent-1'
      stateManager.initializeAgent(agent_id, run_id)

      const checkpoint: HITLCheckpoint = {
        checkpoint_id: 'checkpoint-1',
        timeout_ms: 5000,
        on_timeout: 'proceed'
      }

      manager.checkpoint(agent_id, run_id, checkpoint)
      manager.edit(agent_id, run_id, { brief: 'modified' })

      // Advance time past timeout
      vi.advanceTimersByTime(6000)

      // Should still be in PRECHECKING (not affected by timeout)
      expect(stateManager.getState(agent_id)).toBe('PRECHECKING')
    })
  })

  describe('Timeout Behavior', () => {
    it('should transition to PRECHECKING on timeout with on_timeout: "proceed"', () => {
      const run_id = 'run-1'
      const agent_id = 'agent-1'
      stateManager.initializeAgent(agent_id, run_id)

      const checkpoint: HITLCheckpoint = {
        checkpoint_id: 'checkpoint-1',
        timeout_ms: 5000,
        on_timeout: 'proceed'
      }

      manager.checkpoint(agent_id, run_id, checkpoint)

      // Advance time to trigger timeout
      vi.advanceTimersByTime(5001)

      expect(stateManager.getState(agent_id)).toBe('PRECHECKING')
    })

    it('should transition to ESCALATED on timeout with on_timeout: "escalate"', () => {
      const run_id = 'run-1'
      const agent_id = 'agent-1'
      stateManager.initializeAgent(agent_id, run_id)

      const checkpoint: HITLCheckpoint = {
        checkpoint_id: 'checkpoint-1',
        timeout_ms: 5000,
        on_timeout: 'escalate'
      }

      manager.checkpoint(agent_id, run_id, checkpoint)

      // Advance time to trigger timeout
      vi.advanceTimersByTime(5001)

      expect(stateManager.getState(agent_id)).toBe('ESCALATED')
    })

    it('should emit hitl_checkpoint_timeout event', () => {
      const run_id = 'run-1'
      const agent_id = 'agent-1'
      stateManager.initializeAgent(agent_id, run_id)

      const events: any[] = []
      messageBus.subscribe(run_id, 'hitl_checkpoint_timeout', (type, payload) => {
        events.push(payload)
      })

      const checkpoint: HITLCheckpoint = {
        checkpoint_id: 'checkpoint-1',
        timeout_ms: 5000,
        on_timeout: 'proceed'
      }

      manager.checkpoint(agent_id, run_id, checkpoint)
      vi.advanceTimersByTime(5001)

      expect(events).toHaveLength(1)
      expect(events[0].agent_id).toBe(agent_id)
      expect(events[0].checkpoint_id).toBe('checkpoint-1')
      expect(events[0].on_timeout).toBe('proceed')
    })

    it('should not timeout if timeout_ms is null', () => {
      const run_id = 'run-1'
      const agent_id = 'agent-1'
      stateManager.initializeAgent(agent_id, run_id)

      const checkpoint: HITLCheckpoint = {
        checkpoint_id: 'checkpoint-1',
        timeout_ms: null,
        on_timeout: 'proceed'
      }

      manager.checkpoint(agent_id, run_id, checkpoint)

      // Advance time arbitrarily
      vi.advanceTimersByTime(100000)

      // Should still be in AWAITING_HITL (no timeout)
      expect(stateManager.getState(agent_id)).toBe('AWAITING_HITL')
    })
  })

  describe('Edge Cases', () => {
    it('should handle multiple agents with different checkpoints', () => {
      const run_id = 'run-1'
      const agent1 = 'agent-1'
      const agent2 = 'agent-2'

      stateManager.initializeAgent(agent1, run_id)
      stateManager.initializeAgent(agent2, run_id)

      const checkpoint1: HITLCheckpoint = {
        checkpoint_id: 'checkpoint-1',
        timeout_ms: 5000,
        on_timeout: 'proceed'
      }

      const checkpoint2: HITLCheckpoint = {
        checkpoint_id: 'checkpoint-2',
        timeout_ms: 3000,
        on_timeout: 'escalate'
      }

      manager.checkpoint(agent1, run_id, checkpoint1)
      manager.checkpoint(agent2, run_id, checkpoint2)

      // Trigger agent2's timeout first
      vi.advanceTimersByTime(3001)
      expect(stateManager.getState(agent2)).toBe('ESCALATED')
      expect(stateManager.getState(agent1)).toBe('AWAITING_HITL')

      // Trigger agent1's timeout
      vi.advanceTimersByTime(2000)
      expect(stateManager.getState(agent1)).toBe('PRECHECKING')
    })

    it('should handle approve on agent without active checkpoint gracefully', () => {
      const run_id = 'run-1'
      const agent_id = 'agent-1'
      stateManager.initializeAgent(agent_id, run_id)

      const result = manager.approve(agent_id, run_id)

      expect(result.success).toBe(false)
    })

    it('should allow checkpoint to be set without timeout', () => {
      const run_id = 'run-1'
      const agent_id = 'agent-1'
      stateManager.initializeAgent(agent_id, run_id)

      const checkpoint: HITLCheckpoint = {
        checkpoint_id: 'checkpoint-infinite',
        timeout_ms: null,
        on_timeout: 'proceed'
      }

      const result = manager.checkpoint(agent_id, run_id, checkpoint)

      expect(result.success).toBe(true)
      expect(stateManager.getState(agent_id)).toBe('AWAITING_HITL')
    })
  })
})
