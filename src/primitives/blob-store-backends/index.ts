import type { BlobStoreBackend, BlobStorePolicy } from '../types.js'
import { InMemoryBlobStoreBackend } from './in-memory-backend.js'
import { S3BlobStoreBackend } from './s3-backend.js'
import { GCSBlobStoreBackend } from './gcs-backend.js'

export { InMemoryBlobStoreBackend } from './in-memory-backend.js'
export { S3BlobStoreBackend } from './s3-backend.js'
export { GCSBlobStoreBackend } from './gcs-backend.js'

/**
 * Factory function to create appropriate BlobStoreBackend based on policy
 *
 * Configuration:
 * - memory: No additional config required
 * - s3: Requires AWS_S3_BUCKET env var
 * - gcs: Requires GCS_BUCKET_NAME env var
 *
 * @param policy - BlobStorePolicy from RunConfig
 * @returns Configured BlobStoreBackend instance
 * @throws Error if provider is unsupported or required env vars are missing
 */
export function createBlobStoreBackend(policy: BlobStorePolicy): BlobStoreBackend {
  switch (policy.provider) {
    case 'memory':
      return new InMemoryBlobStoreBackend()

    case 's3': {
      const bucket = process.env.AWS_S3_BUCKET
      if (!bucket) {
        throw new Error('S3 backend requires AWS_S3_BUCKET environment variable')
      }
      return new S3BlobStoreBackend({ bucket })
    }

    case 'gcs': {
      const bucket = process.env.GCS_BUCKET_NAME
      if (!bucket) {
        throw new Error('GCS backend requires GCS_BUCKET_NAME environment variable')
      }
      return new GCSBlobStoreBackend({ bucket })
    }

    case 'redis':
      throw new Error('Redis blob backend not yet implemented (deferred to future sprint)')

    default:
      throw new Error(`Unsupported blob store provider: ${(policy as any).provider}`)
  }
}
