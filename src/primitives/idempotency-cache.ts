import { createHash } from 'crypto'
import type { AgentResult } from './types.js'

/**
 * IdempotencyCache - P-09
 * Per-run cache keyed on run_id + parent_id + scope_text + attempt_number.
 * Prevents duplicate node instantiation within same attempt.
 *
 * Zero dependencies. Thread-safe via single-threaded event loop.
 */
export class IdempotencyCache {
  private cache = new Map<string, AgentResult>()

  /**
   * Generate SHA-256 cache key from inputs
   * Different attempt_number produces different key (attempt isolation)
   *
   * @param run_id - Run identifier
   * @param parent_id - Parent node identifier
   * @param scope - Scope text
   * @param attempt - Attempt number
   * @returns 64-character hex SHA-256 hash
   */
  key(run_id: string, parent_id: string, scope: string, attempt: number): string {
    // Concatenate inputs with delimiters to prevent ambiguity
    const input = `${run_id}|${parent_id}|${scope}|${attempt}`

    // Generate SHA-256 hash
    return createHash('sha256').update(input).digest('hex')
  }

  /**
   * Retrieve cached result
   * Returns null if key does not exist
   *
   * @param key - Cache key (from key() method)
   * @returns AgentResult if cached, null otherwise
   */
  get(key: string): AgentResult | null {
    return this.cache.get(key) ?? null
  }

  /**
   * Store result in cache
   * Overwrites existing result for same key
   *
   * @param key - Cache key (from key() method)
   * @param result - AgentResult to cache
   */
  set(key: string, result: AgentResult): void {
    this.cache.set(key, result)
  }
}
