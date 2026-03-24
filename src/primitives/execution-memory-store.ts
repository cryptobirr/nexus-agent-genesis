import type { ExecutionMemory, FailedStrategy, SuccessfulPattern } from './types.js'
import { EmbeddingEngine } from './embedding-engine.js'

/**
 * ExecutionMemoryStore - P-20
 * Per-node, per-run short-term cache of retrieved chunks, failed strategies, and successful patterns.
 *
 * Zero dependencies (except P-11: EmbeddingEngine).
 *
 * CRITICAL BEHAVIORS (from agent-nexus-spec.md):
 * - retrieved_chunks: max 500, LRU eviction fires at 500
 * - failed_strategies: capped at max_retries (default 3), FIFO eviction
 * - successful_patterns: loaded at node instantiation from Meta Loop
 * - Pattern store at pattern_store_index_threshold (default 1,000) switches to ANN index
 * - Embedding model mismatch on pattern load = cache miss (not error)
 * - Store does NOT persist after Run completion (in-memory only)
 */
export class ExecutionMemoryStore {
  private memories = new Map<string, ExecutionMemory>()
  private readonly maxRetries: number
  private readonly maxRetrievedChunks: number
  private readonly patternStoreIndexThreshold: number
  private readonly embeddingEngine: EmbeddingEngine

  constructor(options?: {
    max_retries?: number
    max_retrieved_chunks?: number
    pattern_store_index_threshold?: number
    embedding_engine?: EmbeddingEngine
  }) {
    this.maxRetries = options?.max_retries ?? 3
    this.maxRetrievedChunks = options?.max_retrieved_chunks ?? 500
    this.patternStoreIndexThreshold = options?.pattern_store_index_threshold ?? 1000
    this.embeddingEngine = options?.embedding_engine ?? new EmbeddingEngine()
  }

  /**
   * Initialize ExecutionMemory for an agent
   * Returns same instance on subsequent calls (singleton per agent_id)
   *
   * @param agent_id - Agent identifier
   * @param run_id - Run identifier
   * @returns ExecutionMemory instance
   */
  init(agent_id: string, run_id: string): ExecutionMemory {
    // Return existing memory if already initialized
    if (this.memories.has(agent_id)) {
      return this.memories.get(agent_id)!
    }

    // Create new memory
    const memory: ExecutionMemory = {
      agent_id,
      run_id,
      retrieved_chunks: [],
      failed_strategies: [],
      successful_patterns: []
    }

    this.memories.set(agent_id, memory)
    return memory
  }

  /**
   * Get ExecutionMemory for an agent
   * Returns undefined if agent not initialized
   *
   * @param agent_id - Agent identifier
   * @returns ExecutionMemory or undefined
   */
  get(agent_id: string): ExecutionMemory | undefined {
    return this.memories.get(agent_id)
  }

  /**
   * Append failed strategy to agent's memory
   * Caps at max_retries using FIFO eviction (oldest dropped first)
   *
   * @param agent_id - Agent identifier
   * @param strategy - Failed strategy to append
   */
  appendFailedStrategy(agent_id: string, strategy: FailedStrategy): void {
    const memory = this.memories.get(agent_id)
    if (!memory) {
      throw new Error(`ExecutionMemory not initialized for agent: ${agent_id}`)
    }

    // Append strategy
    memory.failed_strategies.push(strategy)

    // Cap at max_retries (FIFO: remove oldest)
    if (memory.failed_strategies.length > this.maxRetries) {
      memory.failed_strategies.shift()
    }
  }

  /**
   * Add retrieved chunk IDs to agent's memory
   * LRU eviction fires at max_retrieved_chunks (default 500)
   *
   * @param agent_id - Agent identifier
   * @param chunk_ids - Array of chunk IDs to add
   */
  addRetrievedChunks(agent_id: string, chunk_ids: string[]): void {
    const memory = this.memories.get(agent_id)
    if (!memory) {
      throw new Error(`ExecutionMemory not initialized for agent: ${agent_id}`)
    }

    // Append new chunks
    memory.retrieved_chunks.push(...chunk_ids)

    // LRU eviction: keep only last max_retrieved_chunks
    if (memory.retrieved_chunks.length > this.maxRetrievedChunks) {
      const overflow = memory.retrieved_chunks.length - this.maxRetrievedChunks
      memory.retrieved_chunks.splice(0, overflow)
    }
  }

  /**
   * Load successful patterns into agent's memory
   * Overwrites existing patterns (not append)
   *
   * @param agent_id - Agent identifier
   * @param patterns - Array of successful patterns
   */
  loadSuccessfulPatterns(agent_id: string, patterns: SuccessfulPattern[]): void {
    const memory = this.memories.get(agent_id)
    if (!memory) {
      throw new Error(`ExecutionMemory not initialized for agent: ${agent_id}`)
    }

    // Overwrite patterns (not append)
    memory.successful_patterns = patterns
  }
}
