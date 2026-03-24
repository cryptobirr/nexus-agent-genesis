import type { SuccessfulPattern } from './types.js'

/**
 * EmbeddingEngine - P-11
 * Compute and compare vector embeddings for similarity lookup (plan cache, pattern matching, low-entropy detection).
 *
 * Zero dependencies. Simple deterministic hash-based embeddings.
 *
 * CRITICAL BEHAVIORS (from agent-nexus-spec.md):
 * - cosineSimilarity returns exactly 1.0 for identical vectors
 * - cosineSimilarity returns value in [-1, 1]
 * - topK returns at most k results above threshold
 * - Embedding model mismatch (different embedding_model_id) treated as cache miss (not error)
 */
export class EmbeddingEngine {
  private readonly dimension: number

  constructor(dimension = 384) {
    this.dimension = dimension
  }

  /**
   * Generate deterministic vector embedding from text
   * Uses simple hash-based features: character frequencies + bigrams
   *
   * @param text - Input text to embed
   * @returns Normalized embedding vector of fixed dimension
   */
  embed(text: string): number[] {
    // Initialize embedding vector
    const embedding = new Array(this.dimension).fill(0)

    // Handle empty text
    if (text.length === 0) {
      return this.normalizeVector(embedding)
    }

    // Feature 1: Character frequency distribution
    // Map each character to a position in the embedding
    for (let i = 0; i < text.length; i++) {
      const charCode = text.charCodeAt(i)
      const idx = charCode % this.dimension
      embedding[idx] += 1
    }

    // Feature 2: Bigram patterns
    // Captures word structure and common patterns
    for (let i = 0; i < text.length - 1; i++) {
      const bigram = (text.charCodeAt(i) * 256 + text.charCodeAt(i + 1)) % this.dimension
      embedding[bigram] += 0.5
    }

    // Feature 3: Word boundary markers
    // Helps distinguish "hello world" from "helloworld"
    const words = text.split(/\s+/)
    for (const word of words) {
      if (word.length > 0) {
        const wordHash = this.hashString(word) % this.dimension
        embedding[wordHash] += 0.3
      }
    }

    // Normalize to unit vector for cosine similarity
    return this.normalizeVector(embedding)
  }

  /**
   * Compute cosine similarity between two vectors
   * Returns 1.0 for identical vectors, value in [-1, 1] range
   *
   * @param a - First vector
   * @param b - Second vector
   * @returns Cosine similarity in [-1, 1], where 1.0 = identical
   */
  cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) {
      throw new Error('Vectors must have same dimension')
    }

    // Compute dot product
    let dot = 0
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i]
    }

    // Compute magnitudes
    const magA = this.magnitude(a)
    const magB = this.magnitude(b)

    // Handle zero vectors
    if (magA === 0 || magB === 0) {
      return 0.0
    }

    // Compute cosine similarity
    const similarity = dot / (magA * magB)

    // Clamp to [-1, 1] to handle floating point errors
    return Math.max(-1, Math.min(1, similarity))
  }

  /**
   * Find top k patterns by similarity, filtered by threshold and embedding_model_id
   * Embedding model mismatch = cache miss (filtered out, not error)
   *
   * @param query_embedding - Query vector
   * @param candidates - Candidate patterns with embeddings
   * @param k - Maximum number of results
   * @param threshold - Minimum similarity score
   * @param current_model_id - Current embedding model ID for filtering
   * @returns At most k patterns above threshold, sorted by similarity descending
   */
  topK(
    query_embedding: number[],
    candidates: SuccessfulPattern[],
    k: number,
    threshold: number,
    current_model_id: string,
  ): SuccessfulPattern[] {
    // Filter by embedding_model_id (mismatch = cache miss)
    const compatibleCandidates = candidates.filter(
      (p) => p.embedding_model_id === current_model_id,
    )

    // Compute similarities for compatible candidates
    const scored = compatibleCandidates
      .map((pattern) => ({
        pattern,
        similarity: this.cosineSimilarity(query_embedding, pattern.embedding),
      }))
      // Filter by threshold
      .filter((item) => item.similarity >= threshold)
      // Sort by similarity descending
      .sort((a, b) => b.similarity - a.similarity)
      // Take top k
      .slice(0, k)

    // Return patterns only (not scores)
    return scored.map((item) => item.pattern)
  }

  /**
   * Simple string hash for word-level features
   * @private
   */
  private hashString(str: string): number {
    let hash = 0
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i)
      hash = (hash << 5) - hash + char
      hash = hash & hash // Convert to 32-bit integer
    }
    return Math.abs(hash)
  }

  /**
   * Compute vector magnitude (L2 norm)
   * @private
   */
  private magnitude(vec: number[]): number {
    let sum = 0
    for (let i = 0; i < vec.length; i++) {
      sum += vec[i] * vec[i]
    }
    return Math.sqrt(sum)
  }

  /**
   * Normalize vector to unit length
   * Returns zero vector if input magnitude is zero
   * @private
   */
  private normalizeVector(vec: number[]): number[] {
    const mag = this.magnitude(vec)

    if (mag === 0) {
      return vec // Return zero vector as-is
    }

    return vec.map((v) => v / mag)
  }
}
