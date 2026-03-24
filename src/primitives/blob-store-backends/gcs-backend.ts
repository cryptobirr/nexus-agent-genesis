import { Storage } from '@google-cloud/storage'
import { randomUUID } from 'crypto'
import type { DataRef, BlobStoreBackend } from '../types.js'
import { BlobNotFoundError } from '../types.js'

export interface GCSBackendConfig {
  bucket: string
  projectId?: string
}

/**
 * GCSBlobStoreBackend
 * Production-grade blob storage using Google Cloud Storage
 *
 * Requirements:
 * - BS-01: Safe for multi-node distributed deployments
 * - BS-02: Synchronous write (awaited by harness)
 * - BS-03: Throws BlobNotFoundError on missing blobs
 * - BS-06: Exponential backoff on quota-exceeded errors
 */
export class GCSBlobStoreBackend implements BlobStoreBackend {
  private storage: Storage
  private bucketName: string

  constructor(config: GCSBackendConfig) {
    this.bucketName = config.bucket
    this.storage = new Storage({
      projectId: config.projectId || process.env.GCP_PROJECT_ID
    })
  }

  async write(run_id: string, payload: unknown, schema: string): Promise<DataRef> {
    const ref_id = randomUUID()
    const key = `blobs/${run_id}/${ref_id}`

    // Serialize payload
    const body = JSON.stringify(payload)
    const size_bytes = body.length

    // Store in GCS with metadata
    await this.saveWithRetry(key, body, { schema, size_bytes: size_bytes.toString() })

    return {
      ref_id,
      schema,
      size_bytes
    }
  }

  async read(ref_id: string): Promise<unknown> {
    const bucket = this.storage.bucket(this.bucketName)

    try {
      // List all blobs and find matching ref_id
      const [files] = await bucket.getFiles({ prefix: 'blobs/' })
      const matchingFile = files.find(file => file.name.endsWith(`/${ref_id}`))

      if (!matchingFile) {
        throw new BlobNotFoundError(ref_id)
      }

      // Download blob content
      const [content] = await matchingFile.download()
      return JSON.parse(content.toString('utf-8'))
    } catch (error: any) {
      if (error instanceof BlobNotFoundError) {
        throw error
      }
      if (error.code === 404 || error.message?.includes('No such object')) {
        throw new BlobNotFoundError(ref_id)
      }
      // Other GCS errors propagate as-is
      throw error
    }
  }

  async delete(ref_id: string): Promise<void> {
    const bucket = this.storage.bucket(this.bucketName)

    try {
      // List all blobs and find matching ref_id
      const [files] = await bucket.getFiles({ prefix: 'blobs/' })
      const matchingFile = files.find(file => file.name.endsWith(`/${ref_id}`))

      if (!matchingFile) {
        // Idempotent: no error if blob does not exist
        return
      }

      await matchingFile.delete()
    } catch (error) {
      // Idempotent: ignore errors on delete
      // Production: log error but don't throw
    }
  }

  async list(run_id: string): Promise<DataRef[]> {
    const bucket = this.storage.bucket(this.bucketName)

    try {
      const [files] = await bucket.getFiles({ prefix: `blobs/${run_id}/` })

      if (files.length === 0) {
        return []
      }

      // Fetch metadata for each blob
      const dataRefs: DataRef[] = []

      for (const file of files) {
        const ref_id = file.name.split('/').pop()!

        // Fetch metadata
        const [metadata] = await file.getMetadata()
        const schema = String(metadata.metadata?.schema || 'unknown')
        const size_bytes = parseInt(String(metadata.metadata?.size_bytes || '0'), 10)

        dataRefs.push({
          ref_id,
          schema,
          size_bytes
        })
      }

      return dataRefs
    } catch (error) {
      // Return empty array on errors (idempotent)
      return []
    }
  }

  /**
   * BS-06: Exponential backoff retry on quota-exceeded errors
   */
  private async saveWithRetry(key: string, body: string, metadata: Record<string, string>, retries = 3): Promise<void> {
    const bucket = this.storage.bucket(this.bucketName)
    const file = bucket.file(key)
    let lastError: Error | undefined

    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        await file.save(body, {
          metadata: { metadata }
        })
        return // Success
      } catch (error: any) {
        lastError = error

        // Check if quota-exceeded (429 or 503)
        if (error.code === 429 || error.code === 503) {
          // Exponential backoff: 1s, 2s, 4s
          const delay = Math.pow(2, attempt) * 1000
          await new Promise(resolve => setTimeout(resolve, delay))
          continue
        }

        // Other errors: fail immediately
        throw error
      }
    }

    // All retries exhausted: throw blob_write_failure
    const writeError = new Error(`Blob write failed after ${retries} retries: ${lastError?.message}`)
    writeError.name = 'blob_write_failure'
    throw writeError
  }
}
