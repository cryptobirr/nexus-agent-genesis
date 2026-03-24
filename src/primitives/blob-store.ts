import { randomUUID } from 'crypto'
import type { DataRef } from './types.js'
import { BlobNotFoundError } from './types.js'

/**
 * BlobStore - P-03
 * Run-scoped structured payload store. Bypasses context compression.
 *
 * Zero dependencies. Thread-safe via single-threaded event loop.
 *
 * CRITICAL BEHAVIORS (from agent-nexus-spec.md):
 * - BS-01: Multi-node deployments MUST use external backend (S3, GCS, Redis).
 *          This in-memory implementation is explicitly unsafe for distributed runs.
 * - BS-02: Write is synchronous - allows Executor to await DataRef confirmation
 *          before advancing node state to COMPLETE.
 * - BS-03: If read() fails (blob evicted/unavailable), consuming agent should be
 *          escalated and blob_store_dereference_failure logged (enforced at higher layer).
 * - BS-06: on_quota_exceeded: "reject_write" triggers exponential backoff retry
 *          (classified as blob_write_failure, does NOT consume Inner Loop retry budget).
 *          Quota handling deferred to higher layer.
 */
export class BlobStore {
  private store = new Map<string, { payload: unknown; schema: string; run_id: string; size_bytes: number }>()
  private runIndex = new Map<string, Set<string>>() // run_id → Set<ref_id>

  /**
   * Write a payload to the blob store
   * Returns DataRef with ref_id, schema, size_bytes
   *
   * @param run_id - Run identifier for scoping
   * @param payload - Arbitrary payload to store
   * @param schema - Schema identifier for payload
   * @returns DataRef with unique ref_id
   */
  write(run_id: string, payload: unknown, schema: string): DataRef {
    // Generate unique ref_id
    const ref_id = randomUUID()

    // Calculate size_bytes (JSON serialization size)
    const size_bytes = JSON.stringify(payload).length

    // Store payload with metadata
    this.store.set(ref_id, {
      payload,
      schema,
      run_id,
      size_bytes
    })

    // Update run index for efficient list()
    if (!this.runIndex.has(run_id)) {
      this.runIndex.set(run_id, new Set())
    }
    this.runIndex.get(run_id)!.add(ref_id)

    // Return DataRef
    return {
      ref_id,
      schema,
      size_bytes
    }
  }

  /**
   * Read a payload from the blob store
   * Throws BlobNotFoundError if ref_id does not exist
   *
   * @param ref_id - Reference ID from DataRef
   * @returns Original payload
   * @throws {BlobNotFoundError} If blob does not exist
   */
  read(ref_id: string): unknown {
    const entry = this.store.get(ref_id)

    if (!entry) {
      throw new BlobNotFoundError(ref_id)
    }

    return entry.payload
  }

  /**
   * Delete a blob from the store
   * Idempotent - no error if blob does not exist
   *
   * @param ref_id - Reference ID to delete
   */
  delete(ref_id: string): void {
    const entry = this.store.get(ref_id)

    if (entry) {
      // Remove from store
      this.store.delete(ref_id)

      // Update run index
      const runRefs = this.runIndex.get(entry.run_id)
      if (runRefs) {
        runRefs.delete(ref_id)
        if (runRefs.size === 0) {
          this.runIndex.delete(entry.run_id)
        }
      }
    }
  }

  /**
   * List all blobs for a specific run_id
   * Uses run_id-scoped index (no table scans)
   *
   * @param run_id - Run identifier
   * @returns Array of DataRef for all blobs in run
   */
  list(run_id: string): DataRef[] {
    const refIds = this.runIndex.get(run_id)

    if (!refIds || refIds.size === 0) {
      return []
    }

    const dataRefs: DataRef[] = []

    for (const ref_id of refIds) {
      const entry = this.store.get(ref_id)
      if (entry && entry.run_id === run_id) {
        dataRefs.push({
          ref_id,
          schema: entry.schema,
          size_bytes: entry.size_bytes
        })
      }
    }

    return dataRefs
  }
}
