import { describe, it, expect, beforeEach } from 'vitest'
import { IdempotencyCache } from './idempotency-cache.js'
import type { AgentResult } from './types.js'

describe('IdempotencyCache', () => {
  let cache: IdempotencyCache

  beforeEach(() => {
    cache = new IdempotencyCache()
  })

  describe('key() - generates SHA-256 hash', () => {
    it('returns string hash from inputs', () => {
      const key = cache.key('run-1', 'parent-1', 'scope-text', 1)

      expect(key).toBeTypeOf('string')
      expect(key.length).toBe(64) // SHA-256 produces 64-char hex string
    })

    it('is deterministic - same inputs produce same hash', () => {
      const key1 = cache.key('run-1', 'parent-1', 'scope-text', 1)
      const key2 = cache.key('run-1', 'parent-1', 'scope-text', 1)

      expect(key1).toBe(key2)
    })

    it('produces different hash when attempt_number changes', () => {
      const key1 = cache.key('run-1', 'parent-1', 'scope-text', 1)
      const key2 = cache.key('run-1', 'parent-1', 'scope-text', 2)

      expect(key1).not.toBe(key2)
    })

    it('produces different hash when run_id changes', () => {
      const key1 = cache.key('run-1', 'parent-1', 'scope-text', 1)
      const key2 = cache.key('run-2', 'parent-1', 'scope-text', 1)

      expect(key1).not.toBe(key2)
    })

    it('produces different hash when parent_id changes', () => {
      const key1 = cache.key('run-1', 'parent-1', 'scope-text', 1)
      const key2 = cache.key('run-1', 'parent-2', 'scope-text', 1)

      expect(key1).not.toBe(key2)
    })

    it('produces different hash when scope changes', () => {
      const key1 = cache.key('run-1', 'parent-1', 'scope-a', 1)
      const key2 = cache.key('run-1', 'parent-1', 'scope-b', 1)

      expect(key1).not.toBe(key2)
    })
  })

  describe('get() - retrieves cached result', () => {
    it('returns null for non-existent key', () => {
      const key = cache.key('run-1', 'parent-1', 'scope-text', 1)
      const result = cache.get(key)

      expect(result).toBeNull()
    })

    it('returns cached result after set()', () => {
      const key = cache.key('run-1', 'parent-1', 'scope-text', 1)
      const expectedResult: AgentResult = { success: true, output: { data: 'test' } }

      cache.set(key, expectedResult)
      const retrievedResult = cache.get(key)

      expect(retrievedResult).toEqual(expectedResult)
    })

    it('returns cached result on second call with same key', () => {
      const key = cache.key('run-1', 'parent-1', 'scope-text', 1)
      const result: AgentResult = { success: true, output: 42 }

      cache.set(key, result)
      const firstGet = cache.get(key)
      const secondGet = cache.get(key)

      expect(firstGet).toEqual(result)
      expect(secondGet).toEqual(result)
      expect(firstGet).toBe(secondGet) // Same object reference
    })
  })

  describe('set() - stores result', () => {
    it('stores result accessible by get()', () => {
      const key = cache.key('run-1', 'parent-1', 'scope-text', 1)
      const result: AgentResult = { success: false, output: 'error' }

      cache.set(key, result)

      expect(cache.get(key)).toEqual(result)
    })

    it('overwrites existing result for same key', () => {
      const key = cache.key('run-1', 'parent-1', 'scope-text', 1)
      const result1: AgentResult = { success: true, output: 'first' }
      const result2: AgentResult = { success: false, output: 'second' }

      cache.set(key, result1)
      cache.set(key, result2)

      expect(cache.get(key)).toEqual(result2)
    })
  })

  describe('attempt isolation - different attempts use different keys', () => {
    it('stores results for different attempts independently', () => {
      const key1 = cache.key('run-1', 'parent-1', 'scope-text', 1)
      const key2 = cache.key('run-1', 'parent-1', 'scope-text', 2)

      const result1: AgentResult = { success: true, output: 'attempt-1' }
      const result2: AgentResult = { success: true, output: 'attempt-2' }

      cache.set(key1, result1)
      cache.set(key2, result2)

      expect(cache.get(key1)).toEqual(result1)
      expect(cache.get(key2)).toEqual(result2)
    })
  })

  describe('collision resistance', () => {
    it('handles many unique keys without collisions', () => {
      const keys = new Set<string>()

      // Generate 1000 keys with varying inputs
      for (let i = 0; i < 1000; i++) {
        const key = cache.key(`run-${i}`, `parent-${i}`, `scope-${i}`, i)
        keys.add(key)
      }

      // All keys should be unique (no collisions)
      expect(keys.size).toBe(1000)
    })
  })
})
