import { randomUUID } from 'crypto'
import type { MessageBus } from './message-bus.js'
import type {
  Ticket,
  TicketContext,
  TriggerType,
  Severity,
  ProviderConfig,
  TicketProvider
} from './types.js'

/**
 * TicketSystem - P-19
 * Structured ticket creation and routing to configured provider.
 *
 * Dependencies: P-04 (MessageBus)
 *
 * CRITICAL BEHAVIORS (from agent-nexus-spec.md):
 * - Each trigger type produces correct ticket_type and severity
 * - failure_gate and failure_type populated from context
 * - infrastructure_failure tickets are NOT Inner Loop triggers (classification only)
 * - Provider routing fires for configured provider (InMemory | GitHub | Jira | Linear | Webhook)
 */
export class TicketSystem {
  // In-memory ticket store: run_id → Ticket[]
  private tickets = new Map<string, Ticket[]>()

  // Trigger → severity mapping
  private static readonly TRIGGER_SEVERITY_MAP: Record<TriggerType, Severity> = {
    occ_max_retries_exceeded: 'CRITICAL',
    kill_switch_triggered: 'CRITICAL',
    sandbox_violation: 'CRITICAL',
    sec_size_warning: 'MAJOR',
    budget_exceeded: 'MAJOR',
    infrastructure_failure: 'MAJOR',
    recursion_guard_triggered: 'MINOR',
    recursion_guard_scope_override: 'MINOR',
    depth_expansion_suppressed: 'MINOR'
  }

  private messageBus: MessageBus
  private providerConfig: ProviderConfig

  /**
   * Create a new TicketSystem
   *
   * @param messageBus - MessageBus instance for event emission
   * @param providerConfig - Provider configuration (defaults to InMemory)
   */
  constructor(messageBus: MessageBus, providerConfig?: ProviderConfig) {
    this.messageBus = messageBus
    this.providerConfig = providerConfig || { provider: 'InMemory' }
  }

  /**
   * File a ticket for a trigger event
   *
   * Creates a ticket with automatic severity mapping, stores it,
   * and emits a ticket_filed event to the MessageBus.
   *
   * @param trigger - Trigger type that caused ticket filing
   * @param context - Ticket context (run_id, agent_id, failure details, etc.)
   * @returns Created ticket
   */
  file(trigger: TriggerType, context: TicketContext): Ticket {
    // Generate ticket
    const ticket: Ticket = {
      ticket_id: randomUUID(),
      ticket_type: trigger,
      severity: TicketSystem.TRIGGER_SEVERITY_MAP[trigger],
      run_id: context.run_id,
      agent_id: context.agent_id,
      failure_gate: context.failure_gate,
      failure_type: context.failure_type,
      context,
      filed_at: new Date().toISOString(),
      status: 'open'
    }

    // Store in memory
    if (!this.tickets.has(context.run_id)) {
      this.tickets.set(context.run_id, [])
    }
    this.tickets.get(context.run_id)!.push(ticket)

    // Emit ticket_filed event
    this.messageBus.emit(context.run_id, 'ticket_filed', {
      ticket_id: ticket.ticket_id,
      ticket_type: ticket.ticket_type,
      severity: ticket.severity,
      run_id: ticket.run_id,
      agent_id: ticket.agent_id
    })

    return ticket
  }

  /**
   * Route a ticket to the configured provider
   *
   * For InMemory provider: ticket is already stored, just emit event
   * For external providers: would send to GitHub/Jira/Linear/Webhook
   *
   * @param ticket - Ticket to route
   */
  route(ticket: Ticket): void {
    // For InMemory provider, ticket is already stored
    // Just emit routing event

    // Emit ticket_routed event
    this.messageBus.emit(ticket.run_id, 'ticket_routed', {
      ticket_id: ticket.ticket_id,
      provider: this.providerConfig.provider,
      routed_at: new Date().toISOString()
    })

    // TODO: Future - implement external provider routing
    // switch (this.providerConfig.provider) {
    //   case 'GitHub':
    //     // Create GitHub issue
    //     break
    //   case 'Jira':
    //     // Create Jira ticket
    //     break
    //   case 'Linear':
    //     // Create Linear issue
    //     break
    //   case 'Webhook':
    //     // POST to webhook URL
    //     break
    // }
  }

  /**
   * List all tickets for a run
   *
   * Returns tickets sorted by filed_at descending (newest first)
   *
   * @param run_id - Run identifier
   * @returns Array of tickets for the run (newest first)
   */
  list(run_id: string): Ticket[] {
    const tickets = this.tickets.get(run_id)

    if (!tickets || tickets.length === 0) {
      return []
    }

    // Sort by filed_at descending (newest first)
    return [...tickets].sort((a, b) => {
      return new Date(b.filed_at).getTime() - new Date(a.filed_at).getTime()
    })
  }
}
