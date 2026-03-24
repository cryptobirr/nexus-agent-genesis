import { describe, it, expect, beforeEach } from 'vitest'
import { VersionedStore } from './versioned-store.js'

describe('VersionedStore', () => {
  let store: VersionedStore

  beforeEach(() => {
    store = new VersionedStore()
  })

  describe('get() - returns {value, version_id}', () => {
    it('returns undefined for non-existent key', async () => {
      const result = await store.get('non-existent')
      expect(result).toBeUndefined()
    })

    it('returns value and version_id after first write', async () => {
      await store.cas('key1', 0, 'value1', 'run-1')
      const result = await store.get('key1')

      expect(result).toBeDefined()
      expect(result?.value).toBe('value1')
      expect(result?.version_id).toBe(1)
    })

    it('returns updated version_id after cas update', async () => {
      await store.cas('key1', 0, 'value1', 'run-1')
      await store.cas('key1', 1, 'value2', 'run-1')

      const result = await store.get('key1')
      expect(result?.value).toBe('value2')
      expect(result?.version_id).toBe(2)
    })
  })

  describe('cas() - atomic compare-and-swap', () => {
    it('succeeds when version matches (initial write with version 0)', async () => {
      const result = await store.cas('key1', 0, 'value1', 'run-1')

      expect(result.success).toBe(true)
      expect(result.current_version_id).toBe(1)
    })

    it('succeeds when version matches (update existing)', async () => {
      await store.cas('key1', 0, 'value1', 'run-1')
      const result = await store.cas('key1', 1, 'value2', 'run-1')

      expect(result.success).toBe(true)
      expect(result.current_version_id).toBe(2)
    })

    it('fails when version mismatches', async () => {
      await store.cas('key1', 0, 'value1', 'run-1')
      const result = await store.cas('key1', 999, 'value2', 'run-1')

      expect(result.success).toBe(false)
      expect(result.current_version_id).toBe(1) // Current version unchanged
    })

    it('fails when expected_version_id is 0 but key exists', async () => {
      await store.cas('key1', 0, 'value1', 'run-1')
      const result = await store.cas('key1', 0, 'value2', 'run-1')

      expect(result.success).toBe(false)
      expect(result.current_version_id).toBe(1)
    })

    it('increments version_id on successful update', async () => {
      await store.cas('key1', 0, 'v1', 'run-1')
      await store.cas('key1', 1, 'v2', 'run-1')
      await store.cas('key1', 2, 'v3', 'run-1')

      const result = await store.get('key1')
      expect(result?.version_id).toBe(3)
    })

    it('returns current_version_id on failure', async () => {
      await store.cas('key1', 0, 'value1', 'run-1')
      await store.cas('key1', 1, 'value2', 'run-1')

      const result = await store.cas('key1', 1, 'value3', 'run-1') // Version is now 2, not 1
      expect(result.success).toBe(false)
      expect(result.current_version_id).toBe(2)
    })

    it('allows null and undefined values', async () => {
      const nullResult = await store.cas('key1', 0, null, 'run-1')
      expect(nullResult.success).toBe(true)

      const undefResult = await store.cas('key2', 0, undefined, 'run-1')
      expect(undefResult.success).toBe(true)

      const key1Result = await store.get('key1')
      expect(key1Result?.value).toBe(null)
      const key2Result = await store.get('key2')
      expect(key2Result?.value).toBe(undefined)
    })
  })

  describe('cas() - concurrent operations: exactly one wins', () => {
    it('handles 100 concurrent CAS operations - exactly one succeeds', async () => {
      // All 100 operations try to write with expected_version_id = 0
      const promises = Array.from({ length: 100 }, (_, i) =>
        Promise.resolve().then(() => store.cas('key1', 0, `value-${i}`, 'run-1'))
      )

      const results = await Promise.all(promises)

      // Exactly one should succeed
      const successes = results.filter(r => r.success)
      expect(successes.length).toBe(1)

      // All failures should report current_version_id = 1
      const failures = results.filter(r => !r.success)
      expect(failures.length).toBe(99)
      failures.forEach(f => {
        expect(f.current_version_id).toBe(1)
      })

      // Final version_id should be 1 (one successful write)
      const final = await store.get('key1')
      expect(final?.version_id).toBe(1)
    })

    it('handles sequential concurrent updates correctly', async () => {
      // Initial write
      await store.cas('key1', 0, 'initial', 'run-1')

      // 50 concurrent attempts to update from version 1 to version 2
      const promises = Array.from({ length: 50 }, (_, i) =>
        Promise.resolve().then(() => store.cas('key1', 1, `update-${i}`, 'run-1'))
      )

      const results = await Promise.all(promises)

      // Exactly one should succeed
      const successes = results.filter(r => r.success)
      expect(successes.length).toBe(1)
      expect(successes[0].current_version_id).toBe(2)

      // Final version should be 2
      const final = await store.get('key1')
      expect(final?.version_id).toBe(2)
    })
  })

  describe('snapshot_read() - consistent multi-key read', () => {
    it('returns consistent version_vector at point in time', async () => {
      await store.cas('key1', 0, 'v1', 'run-1')
      await store.cas('key2', 0, 'v2', 'run-1')
      await store.cas('key3', 0, 'v3', 'run-1')

      const snapshot = await store.snapshot_read(['key1', 'key2', 'key3'])

      expect(snapshot.get('key1')).toBe(1)
      expect(snapshot.get('key2')).toBe(1)
      expect(snapshot.get('key3')).toBe(1)
    })

    it('handles empty keys array', async () => {
      const snapshot = await store.snapshot_read([])
      expect(snapshot.size).toBe(0)
    })

    it('includes non-existent keys as version_id = 0', async () => {
      await store.cas('key1', 0, 'v1', 'run-1')

      const snapshot = await store.snapshot_read(['key1', 'non-existent'])

      expect(snapshot.get('key1')).toBe(1)
      expect(snapshot.get('non-existent')).toBe(0)
    })

    it('snapshot not affected by concurrent writes', async () => {
      await store.cas('key1', 0, 'v1', 'run-1')
      await store.cas('key2', 0, 'v2', 'run-1')

      // Take snapshot
      const snapshot = await store.snapshot_read(['key1', 'key2'])

      // Concurrent updates after snapshot
      await Promise.all([
        Promise.resolve().then(() => store.cas('key1', 1, 'v1-updated', 'run-1')),
        Promise.resolve().then(() => store.cas('key2', 1, 'v2-updated', 'run-1'))
      ])

      // Snapshot should reflect state at time of read
      expect(snapshot.get('key1')).toBe(1)
      expect(snapshot.get('key2')).toBe(1)

      // Current state should be updated
      const key1Result = await store.get('key1')
      expect(key1Result?.version_id).toBe(2)
      const key2Result = await store.get('key2')
      expect(key2Result?.version_id).toBe(2)
    })
  })

  describe('list() - run_id-scoped listing', () => {
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

    it('includes all metadata (key, value, version_id, run_id)', async () => {
      await store.cas('key1', 0, 'value1', 'run-1')

      const entries = await store.list('run-1')
      expect(entries.length).toBe(1)

      const entry = entries[0]
      expect(entry.key).toBe('key1')
      expect(entry.value).toBe('value1')
      expect(entry.version_id).toBe(1)
      expect(entry.run_id).toBe('run-1')
    })

    it('isolates entries across different run_ids', async () => {
      await store.cas('shared-key', 0, 'run-1-value', 'run-1')
      await store.cas('shared-key', 1, 'run-2-value', 'run-2')

      const run1Entries = await store.list('run-1')
      const run2Entries = await store.list('run-2')

      // Key exists globally but only latest run_id association tracked
      expect(run1Entries.length).toBe(0) // Overwritten by run-2
      expect(run2Entries.length).toBe(1)
      expect(run2Entries[0].value).toBe('run-2-value')
    })

    it('handles updates to same key maintaining run_id association', async () => {
      await store.cas('key1', 0, 'v1', 'run-1')
      await store.cas('key1', 1, 'v2', 'run-1')
      await store.cas('key1', 2, 'v3', 'run-1')

      const entries = await store.list('run-1')
      expect(entries.length).toBe(1)
      expect(entries[0].value).toBe('v3')
      expect(entries[0].version_id).toBe(3)
    })
  })

  describe('Edge cases', () => {
    it('handles rapid alternating cas operations', async () => {
      await store.cas('key1', 0, 'v1', 'run-1')

      for (let i = 1; i <= 100; i++) {
        const result = await store.cas('key1', i, `v${i + 1}`, 'run-1')
        expect(result.success).toBe(true)
        expect(result.current_version_id).toBe(i + 1)
      }

      const final = await store.get('key1')
      expect(final?.version_id).toBe(101)
    })

    it('handles cas with run_id change on same key', async () => {
      await store.cas('key1', 0, 'v1', 'run-1')
      await store.cas('key1', 1, 'v2', 'run-2')

      const run1Entries = await store.list('run-1')
      const run2Entries = await store.list('run-2')

      expect(run1Entries.length).toBe(0)
      expect(run2Entries.length).toBe(1)
      expect(run2Entries[0].run_id).toBe('run-2')
    })

    it('snapshot_read with duplicate keys returns each key once', async () => {
      await store.cas('key1', 0, 'v1', 'run-1')

      const snapshot = await store.snapshot_read(['key1', 'key1', 'key1'])
      expect(snapshot.size).toBe(1)
      expect(snapshot.get('key1')).toBe(1)
    })
  })
})
