import type { Event, EventHandler, UnsubscribeFn } from './types.js'

/**
 * MessageBus - P-04
 * Event emission backbone for harness decisions, state transitions, and tickets.
 *
 * Zero dependencies. Thread-safe via single-threaded event loop.
 *
 * CRITICAL BEHAVIORS (from agent-nexus-spec.md):
 * - Events emitted before subscriber attaches are buffered per run (retrievable via replay)
 * - Subscribers receive events only AFTER subscription (no retroactive delivery)
 * - replay(run_id) returns events in emission order
 * - Unsubscribe stops handler from receiving further events
 */
export class MessageBus {
  // Event buffer: run_id → Event[] (in emission order)
  private eventBuffer = new Map<string, Event[]>()

  // Active subscribers: run_id → event_type → Set<EventHandler>
  private subscribers = new Map<string, Map<string, Set<EventHandler>>>()

  /**
   * Emit an event to all subscribed handlers and store in buffer
   *
   * @param run_id - Run identifier for scoping
   * @param event_type - Event type identifier
   * @param payload - Event payload (arbitrary object)
   */
  emit(run_id: string, event_type: string, payload: object): void {
    // Create event record
    const event: Event = {
      event_type,
      payload,
      run_id,
      timestamp: Date.now()
    }

    // Store in buffer for replay
    if (!this.eventBuffer.has(run_id)) {
      this.eventBuffer.set(run_id, [])
    }
    this.eventBuffer.get(run_id)!.push(event)

    // Fire subscribed handlers
    const runSubscribers = this.subscribers.get(run_id)
    if (!runSubscribers) return

    const handlers = runSubscribers.get(event_type)
    if (!handlers) return

    // Call each handler with event_type and payload
    for (const handler of handlers) {
      handler(event_type, payload)
    }
  }

  /**
   * Subscribe to events of a specific type
   * Returns unsubscribe function to stop receiving events
   *
   * @param run_id - Run identifier for scoping
   * @param event_type - Event type to subscribe to
   * @param handler - Handler function to call on events
   * @returns Unsubscribe function
   */
  subscribe(run_id: string, event_type: string, handler: EventHandler): UnsubscribeFn {
    // Ensure subscriber structure exists
    if (!this.subscribers.has(run_id)) {
      this.subscribers.set(run_id, new Map())
    }

    const runSubscribers = this.subscribers.get(run_id)!
    if (!runSubscribers.has(event_type)) {
      runSubscribers.set(event_type, new Set())
    }

    // Add handler
    runSubscribers.get(event_type)!.add(handler)

    // Return unsubscribe function
    return () => {
      const runSubs = this.subscribers.get(run_id)
      if (!runSubs) return

      const handlers = runSubs.get(event_type)
      if (!handlers) return

      handlers.delete(handler)

      // Cleanup empty structures
      if (handlers.size === 0) {
        runSubs.delete(event_type)
      }
      if (runSubs.size === 0) {
        this.subscribers.delete(run_id)
      }
    }
  }

  /**
   * Replay all events for a run in emission order
   * Returns snapshot of buffered events (does not mutate on new events)
   *
   * @param run_id - Run identifier
   * @returns Array of events in emission order
   */
  replay(run_id: string): Event[] {
    const events = this.eventBuffer.get(run_id)

    if (!events || events.length === 0) {
      return []
    }

    // Return shallow copy (snapshot)
    return [...events]
  }
}
