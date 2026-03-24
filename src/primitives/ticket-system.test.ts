import { describe, it, expect, beforeEach } from 'vitest'
import { TicketSystem } from './ticket-system.js'
import { MessageBus } from './message-bus.js'
import type { TicketContext, TriggerType, Ticket } from './types.js'

describe('TicketSystem (P-19)', () => {
  let ticketSystem: TicketSystem
  let messageBus: MessageBus

  beforeEach(() => {
    messageBus = new MessageBus()
    ticketSystem = new TicketSystem(messageBus)
  })

  describe('file() - Ticket creation', () => {
    it('creates ticket with correct structure', () => {
      const context: TicketContext = {
        run_id: 'run-001',
        agent_id: 'agent-001'
      }

      const ticket = ticketSystem.file('occ_max_retries_exceeded', context)

      expect(ticket.ticket_id).toBeDefined()
      expect(ticket.ticket_id).toMatch(/^[0-9a-f-]{36}$/i)  // UUID format
      expect(ticket.ticket_type).toBe('occ_max_retries_exceeded')
      expect(ticket.run_id).toBe('run-001')
      expect(ticket.agent_id).toBe('agent-001')
      expect(ticket.filed_at).toBeDefined()
      expect(ticket.status).toBe('open')
      expect(ticket.context).toEqual(context)
    })

    it('maps trigger to CRITICAL severity correctly', () => {
      const criticalTriggers: TriggerType[] = [
        'occ_max_retries_exceeded',
        'kill_switch_triggered',
        'sandbox_violation'
      ]

      for (const trigger of criticalTriggers) {
        const ticket = ticketSystem.file(trigger, { run_id: 'run-001' })
        expect(ticket.severity).toBe('CRITICAL')
      }
    })

    it('maps trigger to MAJOR severity correctly', () => {
      const majorTriggers: TriggerType[] = [
        'sec_size_warning',
        'budget_exceeded',
        'infrastructure_failure'
      ]

      for (const trigger of majorTriggers) {
        const ticket = ticketSystem.file(trigger, { run_id: 'run-001' })
        expect(ticket.severity).toBe('MAJOR')
      }
    })

    it('maps trigger to MINOR severity correctly', () => {
      const minorTriggers: TriggerType[] = [
        'recursion_guard_triggered',
        'recursion_guard_scope_override',
        'depth_expansion_suppressed'
      ]

      for (const trigger of minorTriggers) {
        const ticket = ticketSystem.file(trigger, { run_id: 'run-001' })
        expect(ticket.severity).toBe('MINOR')
      }
    })

    it('populates failure_gate and failure_type from context', () => {
      const context: TicketContext = {
        run_id: 'run-001',
        failure_gate: 1,
        failure_type: 'reasoning_failure'
      }

      const ticket = ticketSystem.file('occ_max_retries_exceeded', context)

      expect(ticket.failure_gate).toBe(1)
      expect(ticket.failure_type).toBe('reasoning_failure')
    })

    it('handles optional fields correctly (run-level ticket)', () => {
      const context: TicketContext = {
        run_id: 'run-001'
        // No agent_id, failure_gate, or failure_type
      }

      const ticket = ticketSystem.file('kill_switch_triggered', context)

      expect(ticket.agent_id).toBeUndefined()
      expect(ticket.failure_gate).toBeUndefined()
      expect(ticket.failure_type).toBeUndefined()
      expect(ticket.run_id).toBe('run-001')
    })

    it('emits ticket_filed event to MessageBus', () => {
      const context: TicketContext = { run_id: 'run-001' }
      const events: any[] = []

      messageBus.subscribe('run-001', 'ticket_filed', (event_type, payload) => {
        events.push({ event_type, payload })
      })

      const ticket = ticketSystem.file('budget_exceeded', context)

      expect(events.length).toBe(1)
      expect(events[0].event_type).toBe('ticket_filed')
      expect(events[0].payload).toMatchObject({
        ticket_id: ticket.ticket_id,
        ticket_type: 'budget_exceeded',
        severity: 'MAJOR'
      })
    })
  })

  describe('route() - Provider routing', () => {
    it('stores ticket in InMemory provider', () => {
      const context: TicketContext = { run_id: 'run-001' }
      const ticket = ticketSystem.file('sec_size_warning', context)

      ticketSystem.route(ticket)

      const tickets = ticketSystem.list('run-001')
      expect(tickets).toContainEqual(ticket)
    })

    it('emits ticket_routed event', () => {
      const context: TicketContext = { run_id: 'run-001' }
      const events: any[] = []

      messageBus.subscribe('run-001', 'ticket_routed', (event_type, payload) => {
        events.push({ event_type, payload })
      })

      const ticket = ticketSystem.file('sandbox_violation', context)
      ticketSystem.route(ticket)

      expect(events.length).toBe(1)
      expect(events[0].event_type).toBe('ticket_routed')
      expect(events[0].payload).toMatchObject({
        ticket_id: ticket.ticket_id,
        provider: 'InMemory'
      })
    })
  })

  describe('list() - Ticket listing', () => {
    it('returns tickets for specific run_id only', () => {
      // Create tickets for different runs
      ticketSystem.file('budget_exceeded', { run_id: 'run-001' })
      ticketSystem.file('budget_exceeded', { run_id: 'run-001' })
      ticketSystem.file('budget_exceeded', { run_id: 'run-001' })
      ticketSystem.file('sec_size_warning', { run_id: 'run-002' })
      ticketSystem.file('sec_size_warning', { run_id: 'run-002' })

      const run1Tickets = ticketSystem.list('run-001')
      const run2Tickets = ticketSystem.list('run-002')

      expect(run1Tickets.length).toBe(3)
      expect(run2Tickets.length).toBe(2)
      expect(run1Tickets.every(t => t.run_id === 'run-001')).toBe(true)
      expect(run2Tickets.every(t => t.run_id === 'run-002')).toBe(true)
    })

    it('returns empty array for unknown run_id', () => {
      const tickets = ticketSystem.list('unknown-run')
      expect(tickets).toEqual([])
    })

    it('returns tickets sorted by filed_at (newest first)', async () => {
      // Create tickets with slight delays to ensure different timestamps
      const ticket1 = ticketSystem.file('budget_exceeded', { run_id: 'run-001' })
      await new Promise(resolve => setTimeout(resolve, 5))
      const ticket2 = ticketSystem.file('sec_size_warning', { run_id: 'run-001' })
      await new Promise(resolve => setTimeout(resolve, 5))
      const ticket3 = ticketSystem.file('sandbox_violation', { run_id: 'run-001' })

      const tickets = ticketSystem.list('run-001')

      expect(tickets.length).toBe(3)
      // Newest first (ticket3, ticket2, ticket1)
      expect(tickets[0].ticket_id).toBe(ticket3.ticket_id)
      expect(tickets[1].ticket_id).toBe(ticket2.ticket_id)
      expect(tickets[2].ticket_id).toBe(ticket1.ticket_id)
    })
  })

  describe('Acceptance criteria', () => {
    it('infrastructure_failure tickets are correctly classified', () => {
      const ticket = ticketSystem.file('infrastructure_failure', { run_id: 'run-001' })

      // Verify it's MAJOR severity (not CRITICAL)
      expect(ticket.severity).toBe('MAJOR')
      expect(ticket.ticket_type).toBe('infrastructure_failure')
      // infrastructure_failure should NOT be an Inner Loop trigger - this is informational only
      // (The harness will check this - TicketSystem just files it correctly)
    })
  })
})
