import { describe, it, expect, beforeEach } from 'vitest'
import { AgentStateManager } from './agent-state-manager.js'
import { MessageBus } from '../primitives/message-bus.js'
import { TicketSystem } from '../primitives/ticket-system.js'
import type { AgentState } from '../primitives/types.js'

describe('AgentStateManager - C-08', () => {
  let manager: AgentStateManager
  let messageBus: MessageBus
  let ticketSystem: TicketSystem

  beforeEach(() => {
    messageBus = new MessageBus()
    ticketSystem = new TicketSystem(messageBus)
    manager = new AgentStateManager(messageBus, ticketSystem)
  })

  describe('Basic State Storage and Retrieval', () => {
    it('should initialize agent in QUEUED state', () => {
      const run_id = 'run-1'
      const agent_id = 'agent-1'

      manager.initializeAgent(agent_id, run_id)

      const state = manager.getState(agent_id)
      expect(state).toBe('QUEUED')
    })

    it('should return null for unknown agent', () => {
      const state = manager.getState('unknown-agent')
      expect(state).toBeNull()
    })
  })

  describe('Valid State Transitions', () => {
    it('should allow QUEUED → AWAITING_HITL', () => {
      const run_id = 'run-1'
      const agent_id = 'agent-1'
      manager.initializeAgent(agent_id, run_id)

      const result = manager.transition({
        agent_id,
        run_id,
        reason: 'HITL checkpoint declared'
      }, 'AWAITING_HITL')

      expect(result.success).toBe(true)
      expect(result.current_state).toBe('AWAITING_HITL')
      expect(manager.getState(agent_id)).toBe('AWAITING_HITL')
    })

    it('should allow AWAITING_HITL → PRECHECKING', () => {
      const run_id = 'run-1'
      const agent_id = 'agent-1'
      manager.initializeAgent(agent_id, run_id)
      manager.transition({ agent_id, run_id }, 'AWAITING_HITL')

      const result = manager.transition({ agent_id, run_id }, 'PRECHECKING')

      expect(result.success).toBe(true)
      expect(result.current_state).toBe('PRECHECKING')
    })

    it('should allow PRECHECKING → GENERATING', () => {
      const run_id = 'run-1'
      const agent_id = 'agent-1'
      manager.initializeAgent(agent_id, run_id)
      manager.transition({ agent_id, run_id }, 'AWAITING_HITL')
      manager.transition({ agent_id, run_id }, 'PRECHECKING')

      const result = manager.transition({ agent_id, run_id }, 'GENERATING')

      expect(result.success).toBe(true)
      expect(result.current_state).toBe('GENERATING')
    })

    it('should allow GENERATING → GATE1_EVALUATING', () => {
      const run_id = 'run-1'
      const agent_id = 'agent-1'
      manager.initializeAgent(agent_id, run_id)
      manager.transition({ agent_id, run_id }, 'AWAITING_HITL')
      manager.transition({ agent_id, run_id }, 'PRECHECKING')
      manager.transition({ agent_id, run_id }, 'GENERATING')

      const result = manager.transition({ agent_id, run_id }, 'GATE1_EVALUATING')

      expect(result.success).toBe(true)
      expect(result.current_state).toBe('GATE1_EVALUATING')
    })

    it('should allow GATE1_EVALUATING → GATE2_EVALUATING', () => {
      const run_id = 'run-1'
      const agent_id = 'agent-1'
      manager.initializeAgent(agent_id, run_id)
      manager.transition({ agent_id, run_id }, 'AWAITING_HITL')
      manager.transition({ agent_id, run_id }, 'PRECHECKING')
      manager.transition({ agent_id, run_id }, 'GENERATING')
      manager.transition({ agent_id, run_id }, 'GATE1_EVALUATING')

      const result = manager.transition({ agent_id, run_id }, 'GATE2_EVALUATING')

      expect(result.success).toBe(true)
      expect(result.current_state).toBe('GATE2_EVALUATING')
    })

    it('should allow GATE2_EVALUATING → COMPLETE', () => {
      const run_id = 'run-1'
      const agent_id = 'agent-1'
      manager.initializeAgent(agent_id, run_id)
      manager.transition({ agent_id, run_id }, 'AWAITING_HITL')
      manager.transition({ agent_id, run_id }, 'PRECHECKING')
      manager.transition({ agent_id, run_id }, 'GENERATING')
      manager.transition({ agent_id, run_id }, 'GATE1_EVALUATING')
      manager.transition({ agent_id, run_id }, 'GATE2_EVALUATING')

      const result = manager.transition({ agent_id, run_id }, 'COMPLETE')

      expect(result.success).toBe(true)
      expect(result.current_state).toBe('COMPLETE')
    })

    it('should allow QUEUED → CANCELLED (early termination)', () => {
      const run_id = 'run-1'
      const agent_id = 'agent-1'
      manager.initializeAgent(agent_id, run_id)

      const result = manager.transition({
        agent_id,
        run_id,
        reason: 'early termination'
      }, 'CANCELLED')

      expect(result.success).toBe(true)
      expect(result.current_state).toBe('CANCELLED')
    })

    it('should allow GENERATING → ERROR (sandbox violation)', () => {
      const run_id = 'run-1'
      const agent_id = 'agent-1'
      manager.initializeAgent(agent_id, run_id)
      manager.transition({ agent_id, run_id }, 'AWAITING_HITL')
      manager.transition({ agent_id, run_id }, 'PRECHECKING')
      manager.transition({ agent_id, run_id }, 'GENERATING')

      const result = manager.transition({
        agent_id,
        run_id,
        reason: 'sandbox violation'
      }, 'ERROR')

      expect(result.success).toBe(true)
      expect(result.current_state).toBe('ERROR')
    })

    it('should allow GATE2_EVALUATING → ESCALATED (eval failure)', () => {
      const run_id = 'run-1'
      const agent_id = 'agent-1'
      manager.initializeAgent(agent_id, run_id)
      manager.transition({ agent_id, run_id }, 'AWAITING_HITL')
      manager.transition({ agent_id, run_id }, 'PRECHECKING')
      manager.transition({ agent_id, run_id }, 'GENERATING')
      manager.transition({ agent_id, run_id }, 'GATE1_EVALUATING')
      manager.transition({ agent_id, run_id }, 'GATE2_EVALUATING')

      const result = manager.transition({
        agent_id,
        run_id,
        reason: 'Gate 2 failure',
        best_output: 'partial output'
      }, 'ESCALATED')

      expect(result.success).toBe(true)
      expect(result.current_state).toBe('ESCALATED')
    })

    it('should allow RETRYING → PRECHECKING (retry loop)', () => {
      const run_id = 'run-1'
      const agent_id = 'agent-1'
      manager.initializeAgent(agent_id, run_id)
      manager.transition({ agent_id, run_id }, 'AWAITING_HITL')
      manager.transition({ agent_id, run_id }, 'PRECHECKING')
      manager.transition({ agent_id, run_id }, 'RETRYING')

      const result = manager.transition({ agent_id, run_id }, 'PRECHECKING')

      expect(result.success).toBe(true)
      expect(result.current_state).toBe('PRECHECKING')
    })

    it('should allow RETRYING → GENERATING (retry loop)', () => {
      const run_id = 'run-1'
      const agent_id = 'agent-1'
      manager.initializeAgent(agent_id, run_id)
      manager.transition({ agent_id, run_id }, 'AWAITING_HITL')
      manager.transition({ agent_id, run_id }, 'PRECHECKING')
      manager.transition({ agent_id, run_id }, 'GENERATING')
      manager.transition({ agent_id, run_id }, 'RETRYING')

      const result = manager.transition({ agent_id, run_id }, 'GENERATING')

      expect(result.success).toBe(true)
      expect(result.current_state).toBe('GENERATING')
    })
  })

  describe('Invalid State Transitions', () => {
    it('should reject COMPLETE → any state (terminal)', () => {
      const run_id = 'run-1'
      const agent_id = 'agent-1'
      manager.initializeAgent(agent_id, run_id)
      manager.transition({ agent_id, run_id }, 'AWAITING_HITL')
      manager.transition({ agent_id, run_id }, 'PRECHECKING')
      manager.transition({ agent_id, run_id }, 'GENERATING')
      manager.transition({ agent_id, run_id }, 'GATE1_EVALUATING')
      manager.transition({ agent_id, run_id }, 'GATE2_EVALUATING')
      manager.transition({ agent_id, run_id }, 'COMPLETE')

      const result = manager.transition({ agent_id, run_id }, 'GENERATING')

      expect(result.success).toBe(false)
      expect(result.current_state).toBe('COMPLETE')
      expect(result.error_reason).toContain('terminal state')
    })

    it('should reject CANCELLED → any state (terminal)', () => {
      const run_id = 'run-1'
      const agent_id = 'agent-1'
      manager.initializeAgent(agent_id, run_id)
      manager.transition({ agent_id, run_id }, 'CANCELLED')

      const result = manager.transition({ agent_id, run_id }, 'GENERATING')

      expect(result.success).toBe(false)
      expect(result.current_state).toBe('CANCELLED')
      expect(result.error_reason).toContain('terminal state')
    })

    it('should reject ERROR → any state (terminal)', () => {
      const run_id = 'run-1'
      const agent_id = 'agent-1'
      manager.initializeAgent(agent_id, run_id)
      manager.transition({ agent_id, run_id }, 'AWAITING_HITL')
      manager.transition({ agent_id, run_id }, 'PRECHECKING')
      manager.transition({ agent_id, run_id }, 'GENERATING')
      manager.transition({ agent_id, run_id }, 'ERROR')

      const result = manager.transition({ agent_id, run_id }, 'GENERATING')

      expect(result.success).toBe(false)
      expect(result.current_state).toBe('ERROR')
      expect(result.error_reason).toContain('terminal state')
    })

    it('should reject ESCALATED → any state (terminal)', () => {
      const run_id = 'run-1'
      const agent_id = 'agent-1'
      manager.initializeAgent(agent_id, run_id)
      manager.transition({ agent_id, run_id }, 'AWAITING_HITL')
      manager.transition({ agent_id, run_id }, 'PRECHECKING')
      manager.transition({ agent_id, run_id }, 'ESCALATED')

      const result = manager.transition({ agent_id, run_id }, 'GENERATING')

      expect(result.success).toBe(false)
      expect(result.current_state).toBe('ESCALATED')
    })

    it('should reject QUEUED → GENERATING (skipped states)', () => {
      const run_id = 'run-1'
      const agent_id = 'agent-1'
      manager.initializeAgent(agent_id, run_id)

      const result = manager.transition({ agent_id, run_id }, 'GENERATING')

      expect(result.success).toBe(false)
      expect(result.current_state).toBe('QUEUED')
      expect(result.error_reason).toContain('Invalid transition')
    })

    it('should reject GATE1_EVALUATING → COMPLETE (skipped GATE2)', () => {
      const run_id = 'run-1'
      const agent_id = 'agent-1'
      manager.initializeAgent(agent_id, run_id)
      manager.transition({ agent_id, run_id }, 'AWAITING_HITL')
      manager.transition({ agent_id, run_id }, 'PRECHECKING')
      manager.transition({ agent_id, run_id }, 'GENERATING')
      manager.transition({ agent_id, run_id }, 'GATE1_EVALUATING')

      const result = manager.transition({ agent_id, run_id }, 'COMPLETE')

      expect(result.success).toBe(false)
      expect(result.current_state).toBe('GATE1_EVALUATING')
    })
  })

  describe('Event Emission', () => {
    it('should emit state_transition event on successful transition', () => {
      const run_id = 'run-1'
      const agent_id = 'agent-1'
      const events: any[] = []

      messageBus.subscribe(run_id, 'state_transition', (event_type, payload) => {
        events.push(payload)
      })

      manager.initializeAgent(agent_id, run_id)
      manager.transition({ agent_id, run_id, reason: 'test' }, 'AWAITING_HITL')

      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({
        agent_id,
        from_state: 'QUEUED',
        to_state: 'AWAITING_HITL',
        reason: 'test'
      })
      expect(events[0]).toHaveProperty('timestamp')
    })

    it('should not emit event on failed transition', () => {
      const run_id = 'run-1'
      const agent_id = 'agent-1'
      const events: any[] = []

      messageBus.subscribe(run_id, 'state_transition', (event_type, payload) => {
        events.push(payload)
      })

      manager.initializeAgent(agent_id, run_id)
      manager.transition({ agent_id, run_id }, 'AWAITING_HITL')
      manager.transition({ agent_id, run_id }, 'PRECHECKING')
      manager.transition({ agent_id, run_id }, 'GENERATING')
      manager.transition({ agent_id, run_id }, 'GATE1_EVALUATING')
      manager.transition({ agent_id, run_id }, 'GATE2_EVALUATING')
      manager.transition({ agent_id, run_id }, 'COMPLETE')

      const eventsBefore = events.length

      // Try invalid transition
      manager.transition({ agent_id, run_id }, 'GENERATING')

      expect(events).toHaveLength(eventsBefore)
    })
  })

  describe('Ticket Filing', () => {
    it('should file MAJOR ticket on ESCALATED transition', () => {
      const run_id = 'run-1'
      const agent_id = 'agent-1'
      manager.initializeAgent(agent_id, run_id)
      manager.transition({ agent_id, run_id }, 'AWAITING_HITL')
      manager.transition({ agent_id, run_id }, 'PRECHECKING')
      manager.transition({ agent_id, run_id }, 'ESCALATED')

      const tickets = ticketSystem.list(run_id)

      expect(tickets).toHaveLength(1)
      expect(tickets[0]).toMatchObject({
        ticket_type: 'agent_escalated',
        severity: 'MAJOR',
        agent_id,
        run_id
      })
    })

    it('should file CRITICAL ticket on ERROR transition', () => {
      const run_id = 'run-1'
      const agent_id = 'agent-1'
      manager.initializeAgent(agent_id, run_id)
      manager.transition({ agent_id, run_id }, 'AWAITING_HITL')
      manager.transition({ agent_id, run_id }, 'PRECHECKING')
      manager.transition({ agent_id, run_id }, 'GENERATING')
      manager.transition({ agent_id, run_id, reason: 'sandbox violation' }, 'ERROR')

      const tickets = ticketSystem.list(run_id)

      expect(tickets).toHaveLength(1)
      expect(tickets[0]).toMatchObject({
        ticket_type: 'agent_error',
        severity: 'CRITICAL',
        agent_id,
        run_id
      })
    })

    it('should NOT file ticket on CANCELLED transition', () => {
      const run_id = 'run-1'
      const agent_id = 'agent-1'
      manager.initializeAgent(agent_id, run_id)
      manager.transition({ agent_id, run_id }, 'CANCELLED')

      const tickets = ticketSystem.list(run_id)

      expect(tickets).toHaveLength(0)
    })

    it('should include best_output in ESCALATED ticket context', () => {
      const run_id = 'run-1'
      const agent_id = 'agent-1'
      const best_output = 'partial work product'

      manager.initializeAgent(agent_id, run_id)
      manager.transition({ agent_id, run_id }, 'AWAITING_HITL')
      manager.transition({ agent_id, run_id }, 'PRECHECKING')
      manager.transition({
        agent_id,
        run_id,
        best_output,
        reason: 'Gate 2 failure'
      }, 'ESCALATED')

      const tickets = ticketSystem.list(run_id)

      expect(tickets).toHaveLength(1)
      expect(tickets[0].context).toMatchObject({
        best_output
      })
    })
  })

  describe('Special State Behaviors', () => {
    it('should allow OCC re-decompose (PRECHECKING → PRECHECKING)', () => {
      const run_id = 'run-1'
      const agent_id = 'agent-1'
      manager.initializeAgent(agent_id, run_id)
      manager.transition({ agent_id, run_id }, 'AWAITING_HITL')
      manager.transition({ agent_id, run_id }, 'PRECHECKING')

      const result = manager.transition({
        agent_id,
        run_id,
        reason: 'OCC conflict - re-decompose'
      }, 'PRECHECKING')

      expect(result.success).toBe(true)
      expect(result.current_state).toBe('PRECHECKING')
    })

    it('should allow PARTIALLY_COMPLETE only for planner agent_type', () => {
      const run_id = 'run-1'
      const agent_id = 'planner-1'
      manager.initializeAgent(agent_id, run_id, 'planner')
      manager.transition({ agent_id, run_id }, 'AWAITING_HITL')
      manager.transition({ agent_id, run_id }, 'PRECHECKING')
      manager.transition({ agent_id, run_id }, 'GENERATING')
      manager.transition({ agent_id, run_id }, 'GATE1_EVALUATING')
      manager.transition({ agent_id, run_id }, 'GATE2_EVALUATING')

      const result = manager.transition({
        agent_id,
        run_id,
        agent_type: 'planner'
      }, 'PARTIALLY_COMPLETE')

      expect(result.success).toBe(true)
      expect(result.current_state).toBe('PARTIALLY_COMPLETE')
    })

    it('should reject PARTIALLY_COMPLETE for non-planner agents', () => {
      const run_id = 'run-1'
      const agent_id = 'executor-1'
      manager.initializeAgent(agent_id, run_id, 'executor')
      manager.transition({ agent_id, run_id }, 'AWAITING_HITL')
      manager.transition({ agent_id, run_id }, 'PRECHECKING')
      manager.transition({ agent_id, run_id }, 'GENERATING')
      manager.transition({ agent_id, run_id }, 'GATE1_EVALUATING')
      manager.transition({ agent_id, run_id }, 'GATE2_EVALUATING')

      const result = manager.transition({
        agent_id,
        run_id,
        agent_type: 'executor'
      }, 'PARTIALLY_COMPLETE')

      expect(result.success).toBe(false)
      expect(result.current_state).toBe('GATE2_EVALUATING')
      expect(result.error_reason).toContain('planner only')
    })
  })

  describe('Run-Level State', () => {
    it('should track run-level state separately from agent state', () => {
      const run_id = 'run-1'

      manager.setRunState(run_id, 'PARTIAL_COMPLETE')

      const runState = manager.getRunState(run_id)
      expect(runState).toBe('PARTIAL_COMPLETE')
    })

    it('should return null for unknown run', () => {
      const runState = manager.getRunState('unknown-run')
      expect(runState).toBeNull()
    })

    it('should emit run_state_transition event on run state change', () => {
      const run_id = 'run-1'
      const events: any[] = []

      messageBus.subscribe(run_id, 'run_state_transition', (event_type, payload) => {
        events.push(payload)
      })

      manager.setRunState(run_id, 'PARTIAL_COMPLETE')

      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({
        run_id,
        to_state: 'PARTIAL_COMPLETE'
      })
    })
  })

  describe('Context Confidence Propagation', () => {
    it('should include context_confidence in ESCALATED event payload', () => {
      const run_id = 'run-1'
      const agent_id = 'agent-1'
      const events: any[] = []

      messageBus.subscribe(run_id, 'state_transition', (event_type, payload) => {
        events.push(payload)
      })

      manager.initializeAgent(agent_id, run_id)
      manager.transition({ agent_id, run_id }, 'AWAITING_HITL')
      manager.transition({ agent_id, run_id }, 'PRECHECKING')
      manager.transition({
        agent_id,
        run_id,
        reason: 'Gate failure'
      }, 'ESCALATED')

      const escalatedEvent = events.find(e => e.to_state === 'ESCALATED')
      expect(escalatedEvent).toBeDefined()
      expect(escalatedEvent.context_confidence).toBe('degraded')
    })
  })
})
