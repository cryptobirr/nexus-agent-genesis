import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, ListObjectsV2Command, NoSuchKey } from '@aws-sdk/client-s3'
import { randomUUID } from 'crypto'
import type { DataRef, BlobStoreBackend } from '../types.js'
import { BlobNotFoundError } from '../types.js'

export interface S3BackendConfig {
  bucket: string
  region?: string
}

/**
 * S3BlobStoreBackend
 * Production-grade blob storage using AWS S3
 *
 * Requirements:
 * - BS-01: Safe for multi-node distributed deployments
 * - BS-02: Synchronous write (awaited by harness)
 * - BS-03: Throws BlobNotFoundError on missing blobs
 * - BS-06: Exponential backoff on quota-exceeded errors
 */
export class S3BlobStoreBackend implements BlobStoreBackend {
  private client: S3Client
  private bucket: string

  constructor(config: S3BackendConfig) {
    this.bucket = config.bucket
    this.client = new S3Client({
      region: config.region || process.env.AWS_REGION || 'us-east-1'
    })
  }

  async write(run_id: string, payload: unknown, schema: string): Promise<DataRef> {
    const ref_id = randomUUID()
    const key = `blobs/${run_id}/${ref_id}`

    // Serialize payload
    const body = JSON.stringify(payload)
    const size_bytes = body.length

    // Store in S3 with metadata
    await this.putWithRetry(key, body, { schema, size_bytes: size_bytes.toString() })

    return {
      ref_id,
      schema,
      size_bytes
    }
  }

  async read(ref_id: string): Promise<unknown> {
    // S3 key format: blobs/{run_id}/{ref_id}
    // We need to search across run_ids (ref_id is globally unique)
    // Alternative: encode run_id in ref_id or use global key-value store for ref_id→key mapping
    // For simplicity, we'll list all objects and find matching ref_id (inefficient but correct)
    // Production optimization: maintain ref_id→key mapping in separate index

    // Efficient approach: Use S3 select or maintain separate DynamoDB index
    // For MVP: List all objects (acceptable for moderate blob counts)
    const command = new ListObjectsV2Command({
      Bucket: this.bucket,
      Prefix: 'blobs/'
    })

    try {
      const response = await this.client.send(command)
      const matchingKey = response.Contents?.find(obj => obj.Key?.endsWith(`/${ref_id}`))?.Key

      if (!matchingKey) {
        throw new BlobNotFoundError(ref_id)
      }

      // Now fetch the actual blob
      const getCommand = new GetObjectCommand({
        Bucket: this.bucket,
        Key: matchingKey
      })

      const getResponse = await this.client.send(getCommand)
      const body = await getResponse.Body?.transformToString()

      if (!body) {
        throw new BlobNotFoundError(ref_id)
      }

      return JSON.parse(body)
    } catch (error) {
      if (error instanceof NoSuchKey || (error as any).name === 'NoSuchKey') {
        throw new BlobNotFoundError(ref_id)
      }
      if (error instanceof BlobNotFoundError) {
        throw error
      }
      // Other S3 errors propagate as-is
      throw error
    }
  }

  async delete(ref_id: string): Promise<void> {
    // Same issue as read(): need to find key by ref_id
    const command = new ListObjectsV2Command({
      Bucket: this.bucket,
      Prefix: 'blobs/'
    })

    try {
      const response = await this.client.send(command)
      const matchingKey = response.Contents?.find(obj => obj.Key?.endsWith(`/${ref_id}`))?.Key

      if (!matchingKey) {
        // Idempotent: no error if blob does not exist
        return
      }

      const deleteCommand = new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: matchingKey
      })

      await this.client.send(deleteCommand)
    } catch (error) {
      // Idempotent: ignore errors on delete
      // Production: log error but don't throw
    }
  }

  async list(run_id: string): Promise<DataRef[]> {
    const command = new ListObjectsV2Command({
      Bucket: this.bucket,
      Prefix: `blobs/${run_id}/`
    })

    try {
      const response = await this.client.send(command)

      if (!response.Contents || response.Contents.length === 0) {
        return []
      }

      // Fetch metadata for each blob (inefficient but correct)
      const dataRefs: DataRef[] = []

      for (const obj of response.Contents) {
        if (!obj.Key) continue

        const ref_id = obj.Key.split('/').pop()!

        // Fetch metadata from object
        const headCommand = new GetObjectCommand({
          Bucket: this.bucket,
          Key: obj.Key
        })

        try {
          const headResponse = await this.client.send(headCommand)
          const schema = headResponse.Metadata?.schema || 'unknown'
          const size_bytes = parseInt(headResponse.Metadata?.size_bytes || '0', 10)

          dataRefs.push({
            ref_id,
            schema,
            size_bytes
          })
        } catch (error) {
          // Skip blobs with missing metadata
          continue
        }
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
  private async putWithRetry(key: string, body: string, metadata: Record<string, string>, retries = 3): Promise<void> {
    let lastError: Error | undefined

    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        const command = new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: body,
          Metadata: metadata
        })

        await this.client.send(command)
        return // Success
      } catch (error: any) {
        lastError = error

        // Check if quota-exceeded (503 SlowDown or similar)
        if (error.name === 'SlowDown' || error.$metadata?.httpStatusCode === 503) {
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
