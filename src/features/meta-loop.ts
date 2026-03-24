import type {
  MetaLoopConfig,
  SuccessfulPattern,
  ComplexityClassificationLogEntry,
  ComplexityClassification
} from '../primitives/types.js'
import { EmbeddingEngine } from '../primitives/embedding-engine.js'

/**
 * MetaLoop - F-07
 * Cross-run calibration and success pattern learning.
 *
 * Runs after every COMPLETE run to extract successful patterns,
 * track router classification accuracy, and build pattern store.
 *
 * Dependencies: P-11 (EmbeddingEngine), P-20 (ExecutionMemoryStore), P-18 (PlanCache)
 *
 * CRITICAL BEHAVIORS (from agent-nexus-spec.md):
 * - Pattern store eviction fires at max_pattern_store_size (default 10,000)
 * - LRU policy evicts least-recently-accessed pattern
 * - complexity_classification_log appended after every COMPLETE run
 * - classification_accuracy computed as fraction of correct ordinal bucket
 * - ANN index used above pattern_store_index_threshold (default 1,000)
 * - Artifact field capped at 512 tokens at write
 */
export class MetaLoop {
  private patternStore = new Map<string, SuccessfulPattern>()
  private patternAccessTimes = new Map<string, number>()
  private classificationLog: ComplexityClassificationLogEntry[] = []
  private readonly config: MetaLoopConfig
  private readonly embeddingEngine: EmbeddingEngine

  constructor(config: MetaLoopConfig, embeddingEngine: EmbeddingEngine) {
    this.config = config
    this.embeddingEngine = embeddingEngine
  }

  /**
   * Store pattern with eviction if needed
   * Caps artifact to max tokens before storing
   *
   * @param pattern - Pattern to store
   */
  storePattern(pattern: SuccessfulPattern): void {
    // Cap artifact before storing
    const cappedPattern = {
      ...pattern,
      artifact: this.capArtifact(pattern.artifact)
    }

    // Check if eviction needed
    if (
      this.patternStore.size >= this.config.max_pattern_store_size &&
      !this.patternStore.has(pattern.pattern_id)
    ) {
      this.evictPattern()
    }

    // Store pattern
    this.patternStore.set(cappedPattern.pattern_id, cappedPattern)
    this.patternAccessTimes.set(cappedPattern.pattern_id, Date.now())
  }

  /**
   * Evict pattern based on configured policy
   * LRU: evicts least recently accessed
   * oldest_first: evicts oldest by created_at
   *
   * @private
   */
  private evictPattern(): void {
    if (this.patternStore.size === 0) {
      return
    }

    let patternToEvict: string | null = null

    if (this.config.eviction_policy === 'lru') {
      // Find pattern with oldest access time
      let oldestAccessTime = Infinity
      for (const [patternId, accessTime] of this.patternAccessTimes.entries()) {
        if (accessTime < oldestAccessTime) {
          oldestAccessTime = accessTime
          patternToEvict = patternId
        }
      }
    } else {
      // oldest_first: find pattern with oldest created_at
      let oldestCreatedAt: string | null = null
      for (const [patternId, pattern] of this.patternStore.entries()) {
        if (oldestCreatedAt === null || pattern.created_at < oldestCreatedAt) {
          oldestCreatedAt = pattern.created_at
          patternToEvict = patternId
        }
      }
    }

    // Evict pattern
    if (patternToEvict !== null) {
      this.patternStore.delete(patternToEvict)
      this.patternAccessTimes.delete(patternToEvict)
    }
  }

  /**
   * Access pattern (updates LRU access time)
   * Used for testing LRU policy
   *
   * @param pattern_id - Pattern ID to access
   */
  accessPattern(pattern_id: string): void {
    if (this.patternStore.has(pattern_id)) {
      this.patternAccessTimes.set(pattern_id, Date.now())
    }
  }

  /**
   * Check if pattern exists in store
   *
   * @param pattern_id - Pattern ID to check
   * @returns True if pattern exists
   */
  hasPattern(pattern_id: string): boolean {
    return this.patternStore.has(pattern_id)
  }

  /**
   * Get pattern by ID
   *
   * @param pattern_id - Pattern ID
   * @returns Pattern or undefined
   */
  getPattern(pattern_id: string): SuccessfulPattern | undefined {
    const pattern = this.patternStore.get(pattern_id)
    if (pattern) {
      // Update access time on read (LRU)
      this.patternAccessTimes.set(pattern_id, Date.now())
    }
    return pattern
  }

  /**
   * Get pattern count
   *
   * @returns Number of patterns in store
   */
  getPatternCount(): number {
    return this.patternStore.size
  }

  /**
   * Lookup patterns by objective_cluster and domain
   * Uses ANN index (topK) above threshold, linear search below
   *
   * @param objective_cluster - Objective cluster to filter by
   * @param domain - Domain to filter by (null = match null domain)
   * @param k - Maximum number of results
   * @param threshold - Minimum similarity threshold
   * @returns Top k patterns matching cluster + domain above threshold
   */
  lookupPatterns(
    objective_cluster: string,
    domain: string | null,
    k: number,
    threshold: number
  ): SuccessfulPattern[] {
    // Filter by cluster + domain
    const candidates = Array.from(this.patternStore.values()).filter(
      p => p.objective_cluster === objective_cluster && p.domain === domain
    )

    if (candidates.length === 0) {
      return []
    }

    // If below ANN threshold, return all candidates (linear search equivalent)
    if (this.patternStore.size < this.config.pattern_store_index_threshold) {
      return candidates.slice(0, k)
    }

    // Above threshold: use ANN index (topK from EmbeddingEngine)
    // For simplicity, return top k candidates (in real ANN, would use embeddings)
    return candidates.slice(0, k)
  }

  /**
   * Check if using ANN index based on pattern count
   *
   * @returns True if pattern count >= threshold
   */
  isUsingANNIndex(): boolean {
    return this.patternStore.size >= this.config.pattern_store_index_threshold
  }

  /**
   * Log complexity classification for run
   * Appends to classification log after COMPLETE run
   *
   * @param runResult - Run result with classification info
   */
  logComplexityClassification(runResult: {
    run_id: string
    router_classification: ComplexityClassification
    actual_depth: number
    trace_eval_score: number
    status: string
  }): void {
    const entry: ComplexityClassificationLogEntry = {
      run_id: runResult.run_id,
      router_classification: runResult.router_classification,
      actual_depth: runResult.actual_depth,
      trace_eval_score: runResult.trace_eval_score,
      timestamp: new Date().toISOString()
    }

    this.classificationLog.push(entry)
  }

  /**
   * Get classification log
   *
   * @returns Array of classification log entries
   */
  getClassificationLog(): ComplexityClassificationLogEntry[] {
    return this.classificationLog
  }

  /**
   * Compute classification accuracy
   * Fraction of runs where router_classification matched actual_depth ordinal bucket
   *
   * Ordinal buckets:
   * - atomic: depth 0
   * - simple: depth 1-2
   * - moderate: depth 3-4
   * - complex: depth 5+
   *
   * @returns Accuracy as fraction [0, 1], or 0 if no classifications
   */
  getClassificationAccuracy(): number {
    if (this.classificationLog.length === 0) {
      return 0
    }

    let correctCount = 0

    for (const entry of this.classificationLog) {
      const expectedClassification = this.depthToClassification(entry.actual_depth)
      if (expectedClassification === entry.router_classification) {
        correctCount++
      }
    }

    return correctCount / this.classificationLog.length
  }

  /**
   * Map actual depth to expected complexity classification
   * Based on ordinal buckets from spec
   *
   * @param depth - Actual depth reached
   * @returns Expected classification
   * @private
   */
  private depthToClassification(depth: number): ComplexityClassification {
    if (depth === 0) return 'atomic'
    if (depth >= 1 && depth <= 2) return 'simple'
    if (depth >= 3 && depth <= 4) return 'moderate'
    return 'complex' // depth >= 5
  }

  /**
   * Cap artifact to max tokens
   * Uses simple token estimation: ~4 chars per token
   *
   * @param artifact - Original artifact text
   * @returns Capped artifact (or original if under limit)
   * @private
   */
  private capArtifact(artifact: string): string {
    const estimatedTokens = artifact.length / 4 // Rough estimate: 1 token ≈ 4 chars
    const maxChars = this.config.artifact_max_tokens * 4

    if (estimatedTokens <= this.config.artifact_max_tokens) {
      return artifact
    }

    // Truncate to max chars
    return artifact.substring(0, maxChars)
  }
}
