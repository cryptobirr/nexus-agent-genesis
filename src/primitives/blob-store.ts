import { randomUUID } from 'crypto'
import type { DataRef, BlobStoreBackend } from './types.js'
import { BlobNotFoundError } from './types.js'
import { InMemoryBlobStoreBackend } from './blob-store-backends/in-memory-backend.js'

/**
 * BlobStore - P-03
 * Run-scoped structured payload store. Bypasses context compression.
 *
 * CRITICAL BEHAVIORS (from agent-nexus-spec.md):
 * - BS-01: Multi-node deployments MUST use external backend (S3, GCS, Redis).
 *          Use S3Backend or GCSBackend for distributed runs.
 * - BS-02: Write is synchronous - allows Executor to await DataRef confirmation
 *          before advancing node state to COMPLETE.
 * - BS-03: If read() fails (blob evicted/unavailable), consuming agent should be
 *          escalated and blob_store_dereference_failure logged (enforced at higher layer).
 * - BS-06: on_quota_exceeded: "reject_write" triggers exponential backoff retry
 *          (classified as blob_write_failure, does NOT consume Inner Loop retry budget).
 *          Implemented in S3/GCS backends.
 *
 * This class supports pluggable backends (InMemory, S3, GCS).
 * For backward compatibility with synchronous API, it uses InMemoryBackend directly
 * when no backend is provided. For S3/GCS backends, methods must be called in async context.
 */
export class BlobStore {
  private backend: BlobStoreBackend | null
  private inMemoryStore: Map<string, { payload: unknown; schema: string; run_id: string; size_bytes: number }> | null
  private inMemoryRunIndex: Map<string, Set<string>> | null

  constructor(backend?: BlobStoreBackend) {
    if (backend) {
      this.backend = backend
      this.inMemoryStore = null
      this.inMemoryRunIndex = null
    } else {
      // Use direct in-memory implementation for backward compatibility (synchronous)
      this.backend = null
      this.inMemoryStore = new Map()
      this.inMemoryRunIndex = new Map()
    }
  }

  /**
   * Write a payload to the blob store
   * Returns DataRef with ref_id, schema, size_bytes
   *
   * BS-02: Write must complete before Executor marked COMPLETE
   *
   * @param run_id - Run identifier for scoping
   * @param payload - Arbitrary payload to store
   * @param schema - Schema identifier for payload
   * @returns DataRef with unique ref_id
   */
  write(run_id: string, payload: unknown, schema: string): DataRef {
    if (this.inMemoryStore) {
      // Direct in-memory implementation (synchronous, backward compatible)
      const ref_id = randomUUID()
      const size_bytes = JSON.stringify(payload).length

      this.inMemoryStore.set(ref_id, {
        payload,
        schema,
        run_id,
        size_bytes
      })

      if (!this.inMemoryRunIndex!.has(run_id)) {
        this.inMemoryRunIndex!.set(run_id, new Set())
      }
      this.inMemoryRunIndex!.get(run_id)!.add(ref_id)

      return {
        ref_id,
        schema,
        size_bytes
      }
    }

    // Backend implementation - requires async context
    throw new Error('BlobStore with external backend (S3/GCS) requires async write context. Use writeAsync() or convert caller to async.')
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
    if (this.inMemoryStore) {
      const entry = this.inMemoryStore.get(ref_id)

      if (!entry) {
        throw new BlobNotFoundError(ref_id)
      }

      return entry.payload
    }

    throw new Error('BlobStore with external backend (S3/GCS) requires async read context')
  }

  /**
   * Delete a blob from the store
   * Idempotent - no error if blob does not exist
   *
   * @param ref_id - Reference ID to delete
   */
  delete(ref_id: string): void {
    if (this.inMemoryStore) {
      const entry = this.inMemoryStore.get(ref_id)

      if (entry) {
        this.inMemoryStore.delete(ref_id)

        const runRefs = this.inMemoryRunIndex!.get(entry.run_id)
        if (runRefs) {
          runRefs.delete(ref_id)
          if (runRefs.size === 0) {
            this.inMemoryRunIndex!.delete(entry.run_id)
          }
        }
      }

      return
    }

    throw new Error('BlobStore with external backend (S3/GCS) requires async delete context')
  }

  /**
   * List all blobs for a specific run_id
   * Uses run_id-scoped index (no table scans)
   *
   * @param run_id - Run identifier
   * @returns Array of DataRef for all blobs in run
   */
  list(run_id: string): DataRef[] {
    if (this.inMemoryStore) {
      const refIds = this.inMemoryRunIndex!.get(run_id)

      if (!refIds || refIds.size === 0) {
        return []
      }

      const dataRefs: DataRef[] = []

      for (const ref_id of refIds) {
        const entry = this.inMemoryStore.get(ref_id)
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

    throw new Error('BlobStore with external backend (S3/GCS) requires async list context')
  }
}
