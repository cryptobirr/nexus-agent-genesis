import { describe, it, expect, beforeEach, vi } from 'vitest'
import { MessageBus } from './message-bus.js'
import type { Event } from './types.js'

describe('MessageBus', () => {
  let bus: MessageBus

  beforeEach(() => {
    bus = new MessageBus()
  })

  describe('emit() - fires subscribed handlers', () => {
    it('fires handler immediately when subscribed', () => {
      const handler = vi.fn()
      bus.subscribe('run-1', 'test.event', handler)

      bus.emit('run-1', 'test.event', { data: 'hello' })

      expect(handler).toHaveBeenCalledOnce()
      expect(handler).toHaveBeenCalledWith('test.event', { data: 'hello' })
    })

    it('fires multiple handlers for same event_type', () => {
      const handler1 = vi.fn()
      const handler2 = vi.fn()
      bus.subscribe('run-1', 'test.event', handler1)
      bus.subscribe('run-1', 'test.event', handler2)

      bus.emit('run-1', 'test.event', { value: 42 })

      expect(handler1).toHaveBeenCalledWith('test.event', { value: 42 })
      expect(handler2).toHaveBeenCalledWith('test.event', { value: 42 })
    })

    it('does not fire handler for different event_type', () => {
      const handler = vi.fn()
      bus.subscribe('run-1', 'event.a', handler)

      bus.emit('run-1', 'event.b', { data: 'test' })

      expect(handler).not.toHaveBeenCalled()
    })

    it('does not fire handler for different run_id', () => {
      const handler = vi.fn()
      bus.subscribe('run-1', 'test.event', handler)

      bus.emit('run-2', 'test.event', { data: 'test' })

      expect(handler).not.toHaveBeenCalled()
    })

    it('passes correct payload to handler', () => {
      const handler = vi.fn()
      const payload = { complex: { nested: [1, 2, 3] }, flag: true }
      bus.subscribe('run-1', 'test.event', handler)

      bus.emit('run-1', 'test.event', payload)

      expect(handler).toHaveBeenCalledWith('test.event', payload)
    })
  })

  describe('subscribe() - returns unsubscribe function', () => {
    it('returns a function', () => {
      const unsubscribe = bus.subscribe('run-1', 'test.event', vi.fn())

      expect(typeof unsubscribe).toBe('function')
    })

    it('unsubscribe stops handler from receiving events', () => {
      const handler = vi.fn()
      const unsubscribe = bus.subscribe('run-1', 'test.event', handler)

      bus.emit('run-1', 'test.event', { before: true })
      expect(handler).toHaveBeenCalledTimes(1)

      unsubscribe()

      bus.emit('run-1', 'test.event', { after: true })
      expect(handler).toHaveBeenCalledTimes(1) // Still only 1 call
    })

    it('unsubscribe is idempotent (safe to call multiple times)', () => {
      const handler = vi.fn()
      const unsubscribe = bus.subscribe('run-1', 'test.event', handler)

      unsubscribe()
      unsubscribe()
      unsubscribe()

      bus.emit('run-1', 'test.event', { data: 'test' })
      expect(handler).not.toHaveBeenCalled()
    })

    it('unsubscribe only affects specific handler', () => {
      const handler1 = vi.fn()
      const handler2 = vi.fn()
      const unsubscribe1 = bus.subscribe('run-1', 'test.event', handler1)
      bus.subscribe('run-1', 'test.event', handler2)

      unsubscribe1()

      bus.emit('run-1', 'test.event', { data: 'test' })

      expect(handler1).not.toHaveBeenCalled()
      expect(handler2).toHaveBeenCalledOnce()
    })
  })

  describe('replay() - returns events in emission order', () => {
    it('returns empty array for run with no events', () => {
      const events = bus.replay('run-1')

      expect(events).toEqual([])
    })

    it('returns events in emission order', () => {
      bus.emit('run-1', 'event.1', { order: 1 })
      bus.emit('run-1', 'event.2', { order: 2 })
      bus.emit('run-1', 'event.3', { order: 3 })

      const events = bus.replay('run-1')

      expect(events).toHaveLength(3)
      expect(events[0].event_type).toBe('event.1')
      expect(events[1].event_type).toBe('event.2')
      expect(events[2].event_type).toBe('event.3')
    })

    it('events contain correct fields', () => {
      const payload = { data: 'test' }
      bus.emit('run-1', 'test.event', payload)

      const events = bus.replay('run-1')

      expect(events).toHaveLength(1)
      expect(events[0]).toHaveProperty('event_type', 'test.event')
      expect(events[0]).toHaveProperty('payload', payload)
      expect(events[0]).toHaveProperty('run_id', 'run-1')
      expect(events[0]).toHaveProperty('timestamp')
      expect(typeof events[0].timestamp).toBe('number')
    })

    it('scoped to run_id (no cross-contamination)', () => {
      bus.emit('run-1', 'event.a', { run: 1 })
      bus.emit('run-2', 'event.b', { run: 2 })
      bus.emit('run-1', 'event.c', { run: 1 })

      const events1 = bus.replay('run-1')
      const events2 = bus.replay('run-2')

      expect(events1).toHaveLength(2)
      expect(events1[0].event_type).toBe('event.a')
      expect(events1[1].event_type).toBe('event.c')

      expect(events2).toHaveLength(1)
      expect(events2[0].event_type).toBe('event.b')
    })

    it('replay returns snapshot (does not mutate on new events)', () => {
      bus.emit('run-1', 'event.1', { id: 1 })
      const snapshot1 = bus.replay('run-1')

      bus.emit('run-1', 'event.2', { id: 2 })
      const snapshot2 = bus.replay('run-1')

      expect(snapshot1).toHaveLength(1)
      expect(snapshot2).toHaveLength(2)
    })
  })

  describe('Buffering - events emitted before subscriber attaches', () => {
    it('events emitted before subscribe are stored', () => {
      bus.emit('run-1', 'event.1', { order: 1 })
      bus.emit('run-1', 'event.2', { order: 2 })

      const events = bus.replay('run-1')

      expect(events).toHaveLength(2)
      expect(events[0].event_type).toBe('event.1')
      expect(events[1].event_type).toBe('event.2')
    })

    it('late subscriber can retrieve buffered events via replay', () => {
      bus.emit('run-1', 'early.event', { time: 'before' })

      const handler = vi.fn()
      bus.subscribe('run-1', 'early.event', handler)

      // Handler not called for past events (only future)
      expect(handler).not.toHaveBeenCalled()

      // But events available via replay
      const events = bus.replay('run-1')
      expect(events).toHaveLength(1)
      expect(events[0].event_type).toBe('early.event')
      expect(events[0].payload).toEqual({ time: 'before' })
    })

    it('buffer persists per run_id', () => {
      bus.emit('run-1', 'event.a', { data: 'run1' })
      bus.emit('run-2', 'event.b', { data: 'run2' })

      expect(bus.replay('run-1')).toHaveLength(1)
      expect(bus.replay('run-2')).toHaveLength(1)
      expect(bus.replay('run-3')).toHaveLength(0)
    })

    it('mixed scenario: buffered + subscribed events', () => {
      // Emit before subscription
      bus.emit('run-1', 'event.1', { order: 1 })

      // Subscribe
      const handler = vi.fn()
      bus.subscribe('run-1', 'event.2', handler)

      // Emit after subscription
      bus.emit('run-1', 'event.2', { order: 2 })
      bus.emit('run-1', 'event.3', { order: 3 })

      // Handler called only for subscribed event_type after subscription
      expect(handler).toHaveBeenCalledTimes(1)
      expect(handler).toHaveBeenCalledWith('event.2', { order: 2 })

      // All events available via replay
      const events = bus.replay('run-1')
      expect(events).toHaveLength(3)
      expect(events[0].event_type).toBe('event.1')
      expect(events[1].event_type).toBe('event.2')
      expect(events[2].event_type).toBe('event.3')
    })
  })

  describe('Run isolation', () => {
    it('events and subscriptions isolated per run_id', () => {
      const handler1 = vi.fn()
      const handler2 = vi.fn()

      bus.subscribe('run-1', 'test.event', handler1)
      bus.subscribe('run-2', 'test.event', handler2)

      bus.emit('run-1', 'test.event', { run: 1 })
      bus.emit('run-2', 'test.event', { run: 2 })

      expect(handler1).toHaveBeenCalledOnce()
      expect(handler1).toHaveBeenCalledWith('test.event', { run: 1 })

      expect(handler2).toHaveBeenCalledOnce()
      expect(handler2).toHaveBeenCalledWith('test.event', { run: 2 })

      expect(bus.replay('run-1')).toHaveLength(1)
      expect(bus.replay('run-2')).toHaveLength(1)
    })
  })
})
