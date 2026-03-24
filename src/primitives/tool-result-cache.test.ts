import { describe, it, expect, beforeEach } from 'vitest'
import { ToolResultCache } from './tool-result-cache.js'
import type { ToolResult } from './types.js'

describe('ToolResultCache', () => {
  let cache: ToolResultCache

  beforeEach(() => {
    cache = new ToolResultCache()
  })

  describe('hash() - generates SHA-256 hash from input', () => {
    it('returns string hash from input', () => {
      const hash = cache.hash({ foo: 'bar', baz: 42 })

      expect(hash).toBeTypeOf('string')
      expect(hash.length).toBe(64) // SHA-256 produces 64-char hex string
    })

    it('is deterministic - same input produces same hash', () => {
      const input = { foo: 'bar', baz: 42 }
      const hash1 = cache.hash(input)
      const hash2 = cache.hash(input)

      expect(hash1).toBe(hash2)
    })

    it('produces different hash for different inputs', () => {
      const hash1 = cache.hash({ foo: 'bar' })
      const hash2 = cache.hash({ foo: 'baz' })

      expect(hash1).not.toBe(hash2)
    })

    it('handles complex nested objects', () => {
      const input = { a: { b: { c: [1, 2, 3] } } }
      const hash = cache.hash(input)

      expect(hash).toBeTypeOf('string')
      expect(hash.length).toBe(64)
    })
  })

  describe('set() - stores tool result', () => {
    it('stores result when idempotent is true', () => {
      const result: ToolResult = { success: true, output: 'test' }
      const inputHash = cache.hash({ test: 'input' })

      cache.set('run-1', 'tool-1', inputHash, result, true)

      expect(cache.get('run-1', 'tool-1', inputHash, true)).toEqual(result)
    })

    it('stores result when idempotent is undefined (default true)', () => {
      const result: ToolResult = { success: true, output: 'test' }
      const inputHash = cache.hash({ test: 'input' })

      cache.set('run-1', 'tool-1', inputHash, result)

      expect(cache.get('run-1', 'tool-1', inputHash)).toEqual(result)
    })

    it('does NOT store result when idempotent is false', () => {
      const result: ToolResult = { success: true, output: 'test' }
      const inputHash = cache.hash({ test: 'input' })

      cache.set('run-1', 'tool-1', inputHash, result, false)

      // Should return null (not cached)
      expect(cache.get('run-1', 'tool-1', inputHash, false)).toBeNull()
    })

    it('overwrites existing result for same key', () => {
      const inputHash = cache.hash({ test: 'input' })
      const result1: ToolResult = { success: true, output: 'first' }
      const result2: ToolResult = { success: false, error: 'second' }

      cache.set('run-1', 'tool-1', inputHash, result1, true)
      cache.set('run-1', 'tool-1', inputHash, result2, true)

      expect(cache.get('run-1', 'tool-1', inputHash, true)).toEqual(result2)
    })
  })

  describe('get() - retrieves cached result', () => {
    it('returns cached result after set()', () => {
      const inputHash = cache.hash({ test: 'input' })
      const result: ToolResult = { success: true, output: { data: 42 } }

      cache.set('run-1', 'tool-1', inputHash, result, true)

      expect(cache.get('run-1', 'tool-1', inputHash, true)).toEqual(result)
    })

    it('returns null for non-existent key', () => {
      const inputHash = cache.hash({ test: 'input' })

      expect(cache.get('run-1', 'tool-1', inputHash, true)).toBeNull()
    })

    it('returns null when idempotent is false (bypass cache)', () => {
      const inputHash = cache.hash({ test: 'input' })
      const result: ToolResult = { success: true, output: 'test' }

      // Even if somehow cached, should return null when idempotent=false
      cache.set('run-1', 'tool-1', inputHash, result, true)

      expect(cache.get('run-1', 'tool-1', inputHash, false)).toBeNull()
    })

    it('returns null for different input_hash (cache miss)', () => {
      const inputHash1 = cache.hash({ test: 'input1' })
      const inputHash2 = cache.hash({ test: 'input2' })
      const result: ToolResult = { success: true, output: 'test' }

      cache.set('run-1', 'tool-1', inputHash1, result, true)

      expect(cache.get('run-1', 'tool-1', inputHash2, true)).toBeNull()
    })

    it('returns null for different run_id (cache miss)', () => {
      const inputHash = cache.hash({ test: 'input' })
      const result: ToolResult = { success: true, output: 'test' }

      cache.set('run-1', 'tool-1', inputHash, result, true)

      expect(cache.get('run-2', 'tool-1', inputHash, true)).toBeNull()
    })

    it('returns null for different tool_id (cache miss)', () => {
      const inputHash = cache.hash({ test: 'input' })
      const result: ToolResult = { success: true, output: 'test' }

      cache.set('run-1', 'tool-1', inputHash, result, true)

      expect(cache.get('run-1', 'tool-2', inputHash, true)).toBeNull()
    })
  })

  describe('idempotent flag behavior', () => {
    it('only caches when idempotent=true (default)', () => {
      const inputHash = cache.hash({ test: 'input' })
      const result: ToolResult = { success: true, output: 'cached' }

      cache.set('run-1', 'tool-1', inputHash, result) // default true

      expect(cache.get('run-1', 'tool-1', inputHash)).toEqual(result)
    })

    it('bypasses cache when idempotent=false', () => {
      const inputHash = cache.hash({ test: 'input' })
      const result: ToolResult = { success: true, output: 'not-cached' }

      cache.set('run-1', 'tool-1', inputHash, result, false)

      expect(cache.get('run-1', 'tool-1', inputHash, false)).toBeNull()
    })
  })

  describe('key isolation - different dimensions produce different keys', () => {
    it('isolates by run_id', () => {
      const inputHash = cache.hash({ test: 'input' })
      const result1: ToolResult = { success: true, output: 'run-1' }
      const result2: ToolResult = { success: true, output: 'run-2' }

      cache.set('run-1', 'tool-1', inputHash, result1, true)
      cache.set('run-2', 'tool-1', inputHash, result2, true)

      expect(cache.get('run-1', 'tool-1', inputHash, true)).toEqual(result1)
      expect(cache.get('run-2', 'tool-1', inputHash, true)).toEqual(result2)
    })

    it('isolates by tool_id', () => {
      const inputHash = cache.hash({ test: 'input' })
      const result1: ToolResult = { success: true, output: 'tool-1' }
      const result2: ToolResult = { success: true, output: 'tool-2' }

      cache.set('run-1', 'tool-1', inputHash, result1, true)
      cache.set('run-1', 'tool-2', inputHash, result2, true)

      expect(cache.get('run-1', 'tool-1', inputHash, true)).toEqual(result1)
      expect(cache.get('run-1', 'tool-2', inputHash, true)).toEqual(result2)
    })

    it('isolates by input_hash', () => {
      const inputHash1 = cache.hash({ test: 'input1' })
      const inputHash2 = cache.hash({ test: 'input2' })
      const result1: ToolResult = { success: true, output: 'input-1' }
      const result2: ToolResult = { success: true, output: 'input-2' }

      cache.set('run-1', 'tool-1', inputHash1, result1, true)
      cache.set('run-1', 'tool-1', inputHash2, result2, true)

      expect(cache.get('run-1', 'tool-1', inputHash1, true)).toEqual(result1)
      expect(cache.get('run-1', 'tool-1', inputHash2, true)).toEqual(result2)
    })
  })

  describe('collision resistance', () => {
    it('handles many unique cache keys without collisions', () => {
      const results = new Map<string, ToolResult>()

      // Generate 1000 cache entries with varying inputs
      for (let i = 0; i < 1000; i++) {
        const inputHash = cache.hash({ iteration: i })
        const result: ToolResult = { success: true, output: i }

        cache.set(`run-${i}`, `tool-${i}`, inputHash, result, true)
        results.set(`run-${i}|tool-${i}|${inputHash}`, result)
      }

      // Verify all can be retrieved
      let retrievedCount = 0
      for (let i = 0; i < 1000; i++) {
        const inputHash = cache.hash({ iteration: i })
        const retrieved = cache.get(`run-${i}`, `tool-${i}`, inputHash, true)
        if (retrieved) retrievedCount++
      }

      expect(retrievedCount).toBe(1000)
    })
  })
})
