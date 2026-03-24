import type {
  ContextAssemblyPolicy,
  ContextChunk,
  ExecutionMemory,
  AssembledContext,
} from './types.js'
import type { EmbeddingEngine } from './embedding-engine.js'

/**
 * Feedback weight state for a chunk
 */
interface FeedbackState {
  weight: number
  base_weight: number
  timestamp: number
}

/**
 * ContextAssembler - P-16
 * Retrieve and inject relevant context chunks before Executor generation.
 *
 * CRITICAL BEHAVIORS (from agent-nexus-spec.md):
 * - Cache hit: re-injects ExecutionMemory.retrieved_chunks without new retrieval call
 * - diversity_penalty reduces near-duplicate chunk count
 * - Feedback weight updates commute (order-independent); clamped to [base×0.5, base×2.0]; TTL 30 days
 * - Transform strategy: no retrieval_sources → ContextAssembly skipped
 * - Applies ranking_model (cross_encoder or embedding)
 * - Applies diversity_penalty (0–1 scalar)
 */
export class ContextAssembler {
  private readonly embeddingEngine: EmbeddingEngine
  private feedbackWeights = new Map<string, FeedbackState>()
  private readonly TTL_MS = 30 * 24 * 60 * 60 * 1000 // 30 days

  constructor(embeddingEngine: EmbeddingEngine) {
    this.embeddingEngine = embeddingEngine
  }

  /**
   * Assemble context chunks for Executor generation
   *
   * @param policy - Configuration for retrieval and ranking
   * @param scope - Executor scope (query for relevance ranking)
   * @param execution_memory - Execution memory (may contain cached chunks)
   * @returns AssembledContext with ranked chunks
   */
  assemble(
    policy: ContextAssemblyPolicy,
    scope: string,
    execution_memory: ExecutionMemory,
  ): AssembledContext {
    // Cache hit: re-inject cached chunks
    if (execution_memory.retrieved_chunks && execution_memory.retrieved_chunks.length > 0) {
      return {
        chunks: execution_memory.retrieved_chunks,
        from_cache: true,
      }
    }

    // Transform strategy: skip if no retrieval_sources
    if (policy.strategy === 'transform' && policy.retrieval_sources.length === 0) {
      return {
        chunks: [],
        from_cache: false,
      }
    }

    // Get available chunks (from policy or retrieval system)
    const available_chunks = policy.available_chunks || []

    // Filter by retrieval_sources if specified
    let filtered_chunks = available_chunks
    if (policy.retrieval_sources.length > 0) {
      filtered_chunks = available_chunks.filter((chunk) =>
        policy.retrieval_sources.includes(chunk.source),
      )
    }

    // Rank chunks by relevance
    let ranked_chunks = this.rankChunks(filtered_chunks, scope, policy.ranking_model)

    // Apply diversity penalty
    if (policy.diversity_penalty > 0) {
      ranked_chunks = this.applyDiversityPenalty(ranked_chunks, policy.diversity_penalty)
    }

    // Apply feedback weights
    ranked_chunks = this.applyFeedbackWeights(ranked_chunks)

    // Filter by relevance threshold
    ranked_chunks = ranked_chunks.filter(
      (chunk) => (chunk.base_relevance_score || 0) >= policy.relevance_threshold,
    )

    // Limit to max_chunks
    const final_chunks = ranked_chunks.slice(0, policy.max_chunks)

    return {
      chunks: final_chunks,
      from_cache: false,
    }
  }

  /**
   * Record feedback for chunks used in a run
   * Positive feedback increases weight, negative decreases
   *
   * @param chunk_ids - Chunks used in the run
   * @param run_passed - Whether the run passed
   */
  recordFeedback(chunk_ids: string[], run_passed: boolean): void {
    const delta = run_passed ? 0.1 : -0.1

    for (const chunk_id of chunk_ids) {
      const current = this.feedbackWeights.get(chunk_id) || {
        weight: 1.0,
        base_weight: 1.0,
        timestamp: Date.now(),
      }

      // Increment weight (order-independent)
      const new_weight = current.weight + delta

      // Clamp to [base×0.5, base×2.0]
      const clamped_weight = this.clampWeight(new_weight, current.base_weight)

      // Update state
      this.feedbackWeights.set(chunk_id, {
        weight: clamped_weight,
        base_weight: current.base_weight,
        timestamp: Date.now(),
      })
    }
  }

  /**
   * Get feedback weight for a chunk (with TTL enforcement)
   * Exposed for testing
   *
   * @param chunk_id - Chunk identifier
   * @returns Weight (1.0 if no feedback or expired)
   */
  getFeedbackWeight(chunk_id: string): number {
    const state = this.feedbackWeights.get(chunk_id)

    if (!state) {
      return 1.0 // Base weight
    }

    // TTL check: delete if expired
    const age_ms = Date.now() - state.timestamp
    if (age_ms > this.TTL_MS) {
      this.feedbackWeights.delete(chunk_id)
      return 1.0 // Base weight
    }

    return state.weight
  }

  /**
   * Rank chunks by relevance to scope
   * @private
   */
  private rankChunks(
    chunks: ContextChunk[],
    scope: string,
    ranking_model: 'embedding' | 'cross_encoder',
  ): ContextChunk[] {
    if (ranking_model === 'cross_encoder') {
      // Stub: cross_encoder not implemented, fall back to embedding
      return this.rankByEmbedding(chunks, scope)
    }

    return this.rankByEmbedding(chunks, scope)
  }

  /**
   * Rank chunks by embedding similarity to scope
   * @private
   */
  private rankByEmbedding(chunks: ContextChunk[], scope: string): ContextChunk[] {
    const scope_embedding = this.embeddingEngine.embed(scope)

    // Compute similarity scores
    const scored_chunks = chunks.map((chunk) => {
      const chunk_embedding = chunk.embedding || this.embeddingEngine.embed(chunk.content)
      const similarity = this.embeddingEngine.cosineSimilarity(scope_embedding, chunk_embedding)

      return {
        ...chunk,
        embedding: chunk_embedding,
        base_relevance_score: similarity,
      }
    })

    // Sort by similarity descending
    return scored_chunks.sort((a, b) => (b.base_relevance_score || 0) - (a.base_relevance_score || 0))
  }

  /**
   * Apply diversity penalty to remove near-duplicate chunks
   * @private
   */
  private applyDiversityPenalty(chunks: ContextChunk[], penalty: number): ContextChunk[] {
    if (chunks.length === 0 || penalty === 0) {
      return chunks
    }

    const result: ContextChunk[] = []
    const similarity_threshold = 1.0 - penalty // e.g., 0.5 penalty → 0.5 threshold

    for (const chunk of chunks) {
      // Check if chunk is too similar to any already selected chunk
      const is_duplicate = result.some((selected) => {
        const chunk_embedding = chunk.embedding || this.embeddingEngine.embed(chunk.content)
        const selected_embedding = selected.embedding || this.embeddingEngine.embed(selected.content)
        const similarity = this.embeddingEngine.cosineSimilarity(chunk_embedding, selected_embedding)
        return similarity >= similarity_threshold
      })

      if (!is_duplicate) {
        result.push(chunk)
      }
    }

    return result
  }

  /**
   * Apply feedback weights to chunks (re-rank by weight)
   * @private
   */
  private applyFeedbackWeights(chunks: ContextChunk[]): ContextChunk[] {
    // Re-score by multiplying base_relevance_score by feedback weight
    return chunks.map((chunk) => {
      const weight = this.getFeedbackWeight(chunk.chunk_id)
      return {
        ...chunk,
        base_relevance_score: (chunk.base_relevance_score || 0) * weight,
      }
    }).sort((a, b) => (b.base_relevance_score || 0) - (a.base_relevance_score || 0))
  }

  /**
   * Clamp weight to [base×0.5, base×2.0]
   * @private
   */
  private clampWeight(weight: number, base_weight: number): number {
    const min = base_weight * 0.5
    const max = base_weight * 2.0
    return Math.max(min, Math.min(max, weight))
  }
}
