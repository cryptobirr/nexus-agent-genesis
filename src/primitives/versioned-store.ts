import type { SECEntry, SECSnapshot, CASResult, SECBackend } from './types.js'

/**
 * VersionedStore - P-02
 * Atomic conditional key-value store with version_id semantics (CAS).
 * Serves as the SEC (Shared Execution Context) backend.
 *
 * Zero dependencies. Thread-safe via single-threaded event loop.
 * Implements SECBackend interface for in-memory, single-node deployments.
 *
 * WARNING: This in-memory implementation is NOT safe for multi-node deployments.
 * Use RedisVersionedStore or equivalent for distributed deployments.
 */
export class VersionedStore implements SECBackend {
  private store = new Map<string, { value: any; version_id: number; run_id: string }>()
  private runIndex = new Map<string, Set<string>>() // run_id → Set<key>

  /**
   * Get current value and version for a key
   * Returns undefined if key does not exist
   */
  async get(key: string): Promise<{ value: any; version_id: number } | undefined> {
    const entry = this.store.get(key)
    if (!entry) {
      return undefined
    }

    return {
      value: entry.value,
      version_id: entry.version_id
    }
  }

  /**
   * Compare-and-swap: atomic conditional update
   * Succeeds only if current version_id matches expected_version_id
   *
   * For initial writes, use expected_version_id = 0
   *
   * @returns {success: true, current_version_id} on success
   * @returns {success: false, current_version_id} on version mismatch
   */
  async cas(key: string, expected_version_id: number, new_value: any, run_id: string): Promise<CASResult> {
    const entry = this.store.get(key)
    const current_version_id = entry?.version_id ?? 0

    // Check version match
    if (current_version_id !== expected_version_id) {
      return {
        success: false,
        current_version_id
      }
    }

    // Atomic update: increment version and write value
    const new_version_id = current_version_id + 1

    // Update run_id index: remove old association, add new one
    if (entry?.run_id && entry.run_id !== run_id) {
      // Key is moving to different run_id - remove from old run's index
      const oldRunKeys = this.runIndex.get(entry.run_id)
      if (oldRunKeys) {
        oldRunKeys.delete(key)
        if (oldRunKeys.size === 0) {
          this.runIndex.delete(entry.run_id)
        }
      }
    }

    // Add to new run_id index
    if (!this.runIndex.has(run_id)) {
      this.runIndex.set(run_id, new Set())
    }
    this.runIndex.get(run_id)!.add(key)

    // Write to store
    this.store.set(key, {
      value: new_value,
      version_id: new_version_id,
      run_id
    })

    return {
      success: true,
      current_version_id: new_version_id
    }
  }

  /**
   * Snapshot read: consistent version_vector across multiple keys
   * Returns Map<key, version_id> at a single point in time
   *
   * Non-existent keys return version_id = 0
   */
  async snapshot_read(keys: string[]): Promise<SECSnapshot> {
    const snapshot = new Map<string, number>()

    // Single-tick read for consistency
    for (const key of keys) {
      const entry = this.store.get(key)
      snapshot.set(key, entry?.version_id ?? 0)
    }

    return snapshot
  }

  /**
   * List all entries for a specific run_id
   * Uses run_id-scoped index (no table scans)
   *
   * @returns Array of SECEntry with full metadata
   */
  async list(run_id: string): Promise<SECEntry[]> {
    const keys = this.runIndex.get(run_id)
    if (!keys || keys.size === 0) {
      return []
    }

    const entries: SECEntry[] = []

    for (const key of keys) {
      const entry = this.store.get(key)
      if (entry && entry.run_id === run_id) {
        entries.push({
          key,
          value: entry.value,
          version_id: entry.version_id,
          run_id: entry.run_id
        })
      }
    }

    return entries
  }
}
