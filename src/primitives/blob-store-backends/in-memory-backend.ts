import { randomUUID } from 'crypto'
import type { DataRef, BlobStoreBackend } from '../types.js'
import { BlobNotFoundError } from '../types.js'

/**
 * InMemoryBlobStoreBackend
 * In-memory blob storage for development and single-node deployments
 *
 * CRITICAL: BS-01 - This implementation is explicitly unsafe for distributed/multi-node runs.
 * Production deployments MUST use S3Backend or GCSBackend.
 */
export class InMemoryBlobStoreBackend implements BlobStoreBackend {
  private store = new Map<string, { payload: unknown; schema: string; run_id: string; size_bytes: number }>()
  private runIndex = new Map<string, Set<string>>() // run_id → Set<ref_id>

  async write(run_id: string, payload: unknown, schema: string): Promise<DataRef> {
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

  async read(ref_id: string): Promise<unknown> {
    const entry = this.store.get(ref_id)

    if (!entry) {
      throw new BlobNotFoundError(ref_id)
    }

    return entry.payload
  }

  async delete(ref_id: string): Promise<void> {
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

  async list(run_id: string): Promise<DataRef[]> {
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
