import type { PlanCacheEntry, RequirementMap } from './types.js'
import type { EmbeddingEngine } from './embedding-engine.js'

/**
 * PlanCache - P-18
 * Objective-indexed cache of successful Router outputs (plan + dependency graph + requirement map).
 * Cache hit requires both similarity threshold AND config hash match.
 *
 * Zero external dependencies. Thread-safe via single-threaded event loop.
 *
 * CRITICAL BEHAVIORS (from agent-nexus-spec.md):
 * - Hit requires cosine similarity ≥ threshold AND run_config_hash match
 * - Config hash mismatch = automatic miss (fast filter)
 * - Embedding model mismatch = cache miss
 * - Write only after COMPLETE trace verdict (enforced by caller)
 * - Hit surfaces: cached objective, similarity score, originating run_id
 */
export class PlanCache {
  private cache = new Map<string, PlanCacheEntry>()
  private readonly embeddingEngine: EmbeddingEngine
  private readonly similarityThreshold: number

  constructor(embeddingEngine: EmbeddingEngine, similarityThreshold = 0.90) {
    this.embeddingEngine = embeddingEngine
    this.similarityThreshold = similarityThreshold
  }

  /**
   * Lookup cached Router output by objective similarity and config hash
   * Returns null if no match found above threshold with matching config
   *
   * @param objective_embedding - Query embedding for similarity search
   * @param run_config_hash - Config hash that must match exactly
   * @param embedding_model_id - Optional embedding model ID for filtering (default: no filter)
   * @returns PlanCacheEntry with similarity_score populated, or null
   */
  lookup(
    objective_embedding: number[],
    run_config_hash: string,
    embedding_model_id?: string,
  ): PlanCacheEntry | null {
    // Filter candidates by config hash (fast pre-filter)
    const candidates = Array.from(this.cache.values()).filter(
      (entry) => entry.run_config_hash === run_config_hash,
    )

    // If embedding_model_id specified, filter by it (mismatch = cache miss)
    const compatibleCandidates = embedding_model_id
      ? candidates.filter((entry) => entry.embedding_model_id === embedding_model_id)
      : candidates

    if (compatibleCandidates.length === 0) {
      return null
    }

    // Compute similarities and find best match above threshold
    let bestMatch: PlanCacheEntry | null = null
    let bestSimilarity = -1

    for (const candidate of compatibleCandidates) {
      const similarity = this.embeddingEngine.cosineSimilarity(
        objective_embedding,
        candidate.objective_embedding,
      )

      if (similarity >= this.similarityThreshold && similarity > bestSimilarity) {
        bestMatch = candidate
        bestSimilarity = similarity
      }
    }

    if (bestMatch === null) {
      return null
    }

    // Return copy with similarity_score populated
    return {
      ...bestMatch,
      similarity_score: bestSimilarity,
    }
  }

  /**
   * Write successful Router output to cache
   * Only call after COMPLETE trace verdict (enforced by caller)
   *
   * @param run_id - Originating run identifier
   * @param objective_text - Original objective text (for debugging)
   * @param objective_embedding - Embedding of objective
   * @param embedding_model_id - Embedding model ID for mismatch detection
   * @param router_output - Router output to cache
   * @param dependency_graph - Dependency graph to cache
   * @param requirement_map - Requirement map to cache
   * @param run_config_hash - Config hash for filtering
   */
  write(
    run_id: string,
    objective_text: string,
    objective_embedding: number[],
    embedding_model_id: string,
    router_output: any,
    dependency_graph: any,
    requirement_map: RequirementMap,
    run_config_hash: string,
  ): void {
    const entry: PlanCacheEntry = {
      objective_embedding,
      objective_text,
      run_config_hash,
      embedding_model_id,
      router_output,
      dependency_graph,
      requirement_map,
      run_id,
    }

    // Use run_id as cache key (unique per write)
    this.cache.set(run_id, entry)
  }

  /**
   * Invalidate all cached entries with matching config hash
   * Used when configuration changes invalidate cached plans
   *
   * @param run_config_hash - Config hash to invalidate
   */
  invalidate(run_config_hash: string): void {
    // Find all keys with matching config hash
    const keysToDelete: string[] = []

    for (const [key, entry] of this.cache.entries()) {
      if (entry.run_config_hash === run_config_hash) {
        keysToDelete.push(key)
      }
    }

    // Delete matched entries
    for (const key of keysToDelete) {
      this.cache.delete(key)
    }
  }
}
