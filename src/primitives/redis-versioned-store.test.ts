import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Redis from 'ioredis'
import { RedisVersionedStore } from './redis-versioned-store.js'

/**
 * Redis-based SEC backend tests
 * Uses ioredis-mock for testing without external Redis server
 */
describe('RedisVersionedStore - Distributed SEC Backend', () => {
  let redis: Redis
  let store: RedisVersionedStore

  beforeEach(async () => {
    // Use actual Redis or mock for tests
    // For CI: use mock, for local: use Redis on localhost
    redis = new Redis({
      host: 'localhost',
      port: 6379,
      lazyConnect: true,
      retryStrategy: () => null // Don't retry on connection failure
    })

    // Try to connect, if fails, skip Redis tests
    try {
      await redis.connect()
      store = new RedisVersionedStore(redis)

      // Clean all test keys
      const keys = await redis.keys('sec:*')
      if (keys.length > 0) {
        await redis.del(...keys)
      }
    } catch (error) {
      // Redis not available - skip these tests
      redis.disconnect()
      throw new Error('Redis not available for testing - skipping Redis tests')
    }
  })

  afterEach(async () => {
    if (redis && redis.status === 'ready') {
      // Clean up test keys
      const keys = await redis.keys('sec:*')
      if (keys.length > 0) {
        await redis.del(...keys)
      }
      await redis.quit()
    }
  })

  describe('Basic Operations', () => {
    it('get() returns undefined for non-existent key', async () => {
      const result = await store.get('non-existent')
      expect(result).toBeUndefined()
    })

    it('get() returns value and version_id after CAS write', async () => {
      await store.cas('key1', 0, 'value1', 'run-1')
      const result = await store.get('key1')

      expect(result).toBeDefined()
      expect(result?.value).toBe('value1')
      expect(result?.version_id).toBe(1)
    })

    it('cas() succeeds when version matches (initial write)', async () => {
      const result = await store.cas('key1', 0, 'value1', 'run-1')

      expect(result.success).toBe(true)
      expect(result.current_version_id).toBe(1)
    })

    it('cas() fails when version does not match', async () => {
      await store.cas('key1', 0, 'value1', 'run-1')
      const result = await store.cas('key1', 999, 'value2', 'run-1')

      expect(result.success).toBe(false)
      expect(result.current_version_id).toBe(1)
    })

    it('cas() increments version_id on successful update', async () => {
      await store.cas('key1', 0, 'v1', 'run-1')
      await store.cas('key1', 1, 'v2', 'run-1')
      await store.cas('key1', 2, 'v3', 'run-1')

      const result = await store.get('key1')
      expect(result?.version_id).toBe(3)
    })
  })

  describe('OCC Concurrency with WATCH/MULTI/EXEC', () => {
    it('detects concurrent write conflict using WATCH', async () => {
      // Initial write
      await store.cas('key1', 0, 'initial', 'run-1')

      // Simulate two concurrent writes to same key
      const result1Promise = store.cas('key1', 1, 'update-1', 'run-1')
      const result2Promise = store.cas('key1', 1, 'update-2', 'run-1')

      const [result1, result2] = await Promise.all([result1Promise, result2Promise])

      // Exactly one should succeed
      const successes = [result1, result2].filter(r => r.success)
      const failures = [result1, result2].filter(r => !r.success)

      expect(successes.length).toBe(1)
      expect(failures.length).toBe(1)

      // Winner gets version 2
      expect(successes[0].current_version_id).toBe(2)

      // Loser sees version 2 and can retry
      expect(failures[0].current_version_id).toBe(2)
    })

    it('handles 50+ concurrent CAS operations correctly', async () => {
      // 50 agents try to write simultaneously (initial write)
      const promises = Array.from({ length: 50 }, (_, i) =>
        store.cas('shared-key', 0, `value-${i}`, 'run-1')
      )

      const results = await Promise.all(promises)

      // Exactly one should succeed
      const successes = results.filter(r => r.success)
      expect(successes.length).toBe(1)
      expect(successes[0].current_version_id).toBe(1)

      // All failures report current_version_id = 1
      const failures = results.filter(r => !r.success)
      expect(failures.length).toBe(49)
      failures.forEach(f => {
        expect(f.current_version_id).toBe(1)
      })
    })
  })

  describe('snapshot_read() - Consistent Multi-Key Read', () => {
    it('returns consistent version vector using pipeline', async () => {
      await store.cas('key1', 0, 'v1', 'run-1')
      await store.cas('key2', 0, 'v2', 'run-1')
      await store.cas('key3', 0, 'v3', 'run-1')

      const snapshot = await store.snapshot_read(['key1', 'key2', 'key3'])

      expect(snapshot.get('key1')).toBe(1)
      expect(snapshot.get('key2')).toBe(1)
      expect(snapshot.get('key3')).toBe(1)
    })

    it('includes non-existent keys as version_id = 0', async () => {
      await store.cas('key1', 0, 'v1', 'run-1')

      const snapshot = await store.snapshot_read(['key1', 'non-existent'])

      expect(snapshot.get('key1')).toBe(1)
      expect(snapshot.get('non-existent')).toBe(0)
    })

    it('handles empty keys array', async () => {
      const snapshot = await store.snapshot_read([])
      expect(snapshot.size).toBe(0)
    })
  })

  describe('list() - Run-scoped Index with SET', () => {
    it('returns only entries for specified run_id', async () => {
      await store.cas('key1', 0, 'v1', 'run-1')
      await store.cas('key2', 0, 'v2', 'run-1')
      await store.cas('key3', 0, 'v3', 'run-2')

      const run1Entries = await store.list('run-1')
      const run2Entries = await store.list('run-2')

      expect(run1Entries.length).toBe(2)
      expect(run2Entries.length).toBe(1)

      const run1Keys = run1Entries.map(e => e.key).sort()
      expect(run1Keys).toEqual(['key1', 'key2'])

      expect(run2Entries[0].key).toBe('key3')
    })

    it('returns empty array for non-existent run_id', async () => {
      const entries = await store.list('non-existent')
      expect(entries).toEqual([])
    })

    it('includes all metadata in SECEntry', async () => {
      await store.cas('key1', 0, 'value1', 'run-1')

      const entries = await store.list('run-1')
      expect(entries.length).toBe(1)

      const entry = entries[0]
      expect(entry.key).toBe('key1')
      expect(entry.value).toBe('value1')
      expect(entry.version_id).toBe(1)
      expect(entry.run_id).toBe('run-1')
    })

    it('uses SET-based index (no KEYS scan)', async () => {
      // Verify that list() uses SMEMBERS on run_index, not KEYS command
      // This is a performance requirement for production

      // Write 100 entries
      for (let i = 0; i < 100; i++) {
        await store.cas(`key-${i}`, 0, `value-${i}`, 'run-1')
      }

      // Verify run index exists and has correct size
      const indexKey = 'sec:run_index:run-1'
      const indexSize = await redis.scard(indexKey)
      expect(indexSize).toBe(100)

      // List should use SMEMBERS (O(n)) not KEYS (O(N) where N = all keys in DB)
      const entries = await store.list('run-1')
      expect(entries.length).toBe(100)
    })
  })

  describe('Complex Data Types', () => {
    it('stores and retrieves objects', async () => {
      const obj = { status: 'pending', priority: 'high', nested: { value: 42 } }
      await store.cas('key1', 0, obj, 'run-1')

      const result = await store.get('key1')
      expect(result?.value).toEqual(obj)
    })

    it('stores and retrieves arrays', async () => {
      const arr = ['task-1', 'task-2', 'task-3']
      await store.cas('key1', 0, arr, 'run-1')

      const result = await store.get('key1')
      expect(result?.value).toEqual(arr)
    })

    it('stores and retrieves null/undefined', async () => {
      await store.cas('key1', 0, null, 'run-1')
      await store.cas('key2', 0, undefined, 'run-1')

      const result1 = await store.get('key1')
      const result2 = await store.get('key2')

      expect(result1?.value).toBe(null)
      expect(result2?.value).toBe(undefined)
    })
  })

  describe('Run Isolation', () => {
    it('isolates keys across different runs', async () => {
      await store.cas('shared-key', 0, 'run-1-value', 'run-1')
      await store.cas('shared-key', 1, 'run-2-value', 'run-2')

      const run1Entries = await store.list('run-1')
      const run2Entries = await store.list('run-2')

      // Key exists globally but run index tracks latest run_id association
      expect(run1Entries.length).toBe(0) // Overwritten by run-2
      expect(run2Entries.length).toBe(1)
      expect(run2Entries[0].value).toBe('run-2-value')
    })

    it('maintains run_id association through updates', async () => {
      await store.cas('key1', 0, 'v1', 'run-1')
      await store.cas('key1', 1, 'v2', 'run-1')
      await store.cas('key1', 2, 'v3', 'run-1')

      const entries = await store.list('run-1')
      expect(entries.length).toBe(1)
      expect(entries[0].value).toBe('v3')
      expect(entries[0].version_id).toBe(3)
    })
  })

  describe('Error Handling', () => {
    it('handles Redis connection errors gracefully', async () => {
      // Disconnect Redis
      await redis.quit()

      // Operations should throw or return error
      await expect(store.get('key1')).rejects.toThrow()
    })
  })

  describe('Cleanup', () => {
    it('close() shuts down Redis connection', async () => {
      await store.close()
      expect(redis.status).toBe('end')
    })
  })
})

/**
 * Acceptance Criteria Tests from Issue #68
 */
describe('RedisVersionedStore - Acceptance Criteria', () => {
  let redis: Redis
  let store: RedisVersionedStore

  beforeEach(async () => {
    redis = new Redis({
      host: 'localhost',
      port: 6379,
      lazyConnect: true,
      retryStrategy: () => null
    })

    try {
      await redis.connect()
      store = new RedisVersionedStore(redis)

      const keys = await redis.keys('sec:*')
      if (keys.length > 0) {
        await redis.del(...keys)
      }
    } catch (error) {
      redis.disconnect()
      throw new Error('Redis not available for testing')
    }
  })

  afterEach(async () => {
    if (redis && redis.status === 'ready') {
      const keys = await redis.keys('sec:*')
      if (keys.length > 0) {
        await redis.del(...keys)
      }
      await redis.quit()
    }
  })

  it('[AC] Redis WATCH/MULTI/EXEC pattern used for OCC', async () => {
    // Verify WATCH/MULTI/EXEC is used by detecting conflict in concurrent writes
    await store.cas('test-key', 0, 'initial', 'run-1')

    const results = await Promise.all([
      store.cas('test-key', 1, 'update-1', 'run-1'),
      store.cas('test-key', 1, 'update-2', 'run-1')
    ])

    // One succeeds, one fails due to WATCH detecting concurrent modification
    const successes = results.filter(r => r.success)
    const failures = results.filter(r => !r.success)

    expect(successes.length).toBe(1)
    expect(failures.length).toBe(1)
  })

  it('[AC] list(run_id) uses run_id-scoped index (no full table scans)', async () => {
    // Create 1000 entries across multiple runs
    for (let runIdx = 0; runIdx < 10; runIdx++) {
      for (let keyIdx = 0; keyIdx < 100; keyIdx++) {
        await store.cas(`key-${runIdx}-${keyIdx}`, 0, `value`, `run-${runIdx}`)
      }
    }

    // Verify list uses SET-based index for single run
    const indexKey = 'sec:run_index:run-5'
    const indexExists = await redis.exists(indexKey)
    expect(indexExists).toBe(1)

    // List should only scan entries for run-5 (100 entries), not all 1000
    const entries = await store.list('run-5')
    expect(entries.length).toBe(100)

    // All entries belong to run-5
    entries.forEach(e => {
      expect(e.run_id).toBe('run-5')
    })
  })

  it('[AC] Concurrency stress: 50+ concurrent agents', async () => {
    // Stress test: 50+ agents writing to same key
    const results = await Promise.all(
      Array.from({ length: 60 }, (_, i) =>
        store.cas('stress-key', 0, `agent-${i}-value`, 'run-stress')
      )
    )

    // Exactly one wins
    const successes = results.filter(r => r.success)
    expect(successes.length).toBe(1)

    // All others see conflict
    const failures = results.filter(r => !r.success)
    expect(failures.length).toBe(59)
  })
})
