import Redis from 'ioredis'
import type { SECEntry, SECSnapshot, CASResult, SECBackend } from './types.js'

/**
 * RedisVersionedStore - Distributed SEC backend
 * Implements SECBackend using Redis for multi-node deployments
 *
 * Features:
 * - WATCH/MULTI/EXEC for atomic CAS operations (OCC)
 * - Run-scoped key prefixes for efficient isolation
 * - SET-based index for O(1) list operations
 * - Thread-safe across multiple harness processes
 *
 * Requirements: SC-11, SC-12
 */
export class RedisVersionedStore implements SECBackend {
  private redis: Redis

  constructor(redis: Redis) {
    this.redis = redis
  }

  /**
   * Get current value and version for a key
   * Returns undefined if key does not exist
   */
  async get(key: string): Promise<{ value: any; version_id: number } | undefined> {
    // Build Redis key
    const redisKey = this.buildKey(key)

    // Get entry from Redis
    const data = await this.redis.get(redisKey)
    if (!data) {
      return undefined
    }

    // Parse entry
    const entry = JSON.parse(data)
    return {
      value: entry.value,
      version_id: entry.version_id
    }
  }

  /**
   * Compare-and-swap: atomic conditional update using WATCH/MULTI/EXEC
   * Succeeds only if current version_id matches expected_version_id
   *
   * For initial writes, use expected_version_id = 0
   *
   * @returns {success: true, current_version_id} on success
   * @returns {success: false, current_version_id} on version mismatch
   */
  async cas(key: string, expected_version_id: number, new_value: any, run_id: string): Promise<CASResult> {
    const redisKey = this.buildKey(key)
    const runIndexKey = this.buildRunIndexKey(run_id)

    // WATCH key for optimistic concurrency control
    await this.redis.watch(redisKey)

    try {
      // Read current version
      const currentData = await this.redis.get(redisKey)
      const current_version_id = currentData ? JSON.parse(currentData).version_id : 0

      // Check version match
      if (current_version_id !== expected_version_id) {
        await this.redis.unwatch()
        return {
          success: false,
          current_version_id
        }
      }

      // Prepare new entry
      const new_version_id = current_version_id + 1
      const entry = {
        value: new_value,
        version_id: new_version_id,
        run_id
      }

      // Atomic write with MULTI/EXEC
      const result = await this.redis
        .multi()
        .set(redisKey, JSON.stringify(entry))
        .sadd(runIndexKey, key)
        .exec()

      // Check if EXEC succeeded (null means transaction was aborted)
      if (!result) {
        // Concurrent modification detected by WATCH
        // Read current version for retry
        const retryData = await this.redis.get(redisKey)
        const retry_version_id = retryData ? JSON.parse(retryData).version_id : 0

        return {
          success: false,
          current_version_id: retry_version_id
        }
      }

      return {
        success: true,
        current_version_id: new_version_id
      }
    } catch (error) {
      // Ensure we unwatch on error
      await this.redis.unwatch()
      throw error
    }
  }

  /**
   * Snapshot read: consistent version_vector across multiple keys
   * Returns Map<key, version_id> at a single point in time
   *
   * Non-existent keys return version_id = 0
   *
   * Uses Redis pipeline for efficient batching
   */
  async snapshot_read(keys: string[]): Promise<SECSnapshot> {
    const snapshot = new Map<string, number>()

    // Use pipeline for batch read
    const pipeline = this.redis.pipeline()

    for (const key of keys) {
      const redisKey = this.buildKey(key)
      pipeline.get(redisKey)
    }

    const results = await pipeline.exec()

    // Process results
    if (!results) {
      // Pipeline failed - return all zeros
      for (const key of keys) {
        snapshot.set(key, 0)
      }
      return snapshot
    }

    for (let i = 0; i < keys.length; i++) {
      const key = keys[i]
      const [err, data] = results[i]

      if (err || !data) {
        snapshot.set(key, 0)
      } else {
        const entry = JSON.parse(data as string)
        snapshot.set(key, entry.version_id)
      }
    }

    return snapshot
  }

  /**
   * List all entries for a specific run_id
   * Uses run_id-scoped SET index for efficient lookup (no KEYS scan)
   *
   * @returns Array of SECEntry with full metadata
   */
  async list(run_id: string): Promise<SECEntry[]> {
    const runIndexKey = this.buildRunIndexKey(run_id)

    // Get all keys for this run_id from SET
    const keys = await this.redis.smembers(runIndexKey)

    if (keys.length === 0) {
      return []
    }

    // Use pipeline to fetch all entries
    const pipeline = this.redis.pipeline()

    for (const key of keys) {
      const redisKey = this.buildKey(key)
      pipeline.get(redisKey)
    }

    const results = await pipeline.exec()

    // Build SECEntry array
    const entries: SECEntry[] = []

    if (!results) {
      return entries
    }

    for (let i = 0; i < keys.length; i++) {
      const key = keys[i]
      const [err, data] = results[i]

      if (!err && data) {
        const entry = JSON.parse(data as string)

        // Only include entries that still belong to this run_id
        // (handles edge case where key was reassigned to different run)
        if (entry.run_id === run_id) {
          entries.push({
            key,
            value: entry.value,
            version_id: entry.version_id,
            run_id: entry.run_id
          })
        }
      }
    }

    return entries
  }

  /**
   * Build Redis key for SEC entry
   * Pattern: sec:key:{key}
   */
  private buildKey(key: string): string {
    return `sec:key:${key}`
  }

  /**
   * Build Redis key for run index
   * Pattern: sec:run_index:{run_id}
   */
  private buildRunIndexKey(run_id: string): string {
    return `sec:run_index:${run_id}`
  }

  /**
   * Close Redis connection
   * Call this when shutting down the runtime
   */
  async close(): Promise<void> {
    await this.redis.quit()
  }
}
