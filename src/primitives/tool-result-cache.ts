import { createHash } from 'crypto'
import type { ToolResult } from './types.js'

/**
 * ToolResultCache - P-10
 * Per-run cache keyed on run_id + tool_id + input_hash.
 * Prevents tool re-execution when eval (not tool) failed.
 *
 * Zero dependencies. Thread-safe via single-threaded event loop.
 */
export class ToolResultCache {
  private cache = new Map<string, ToolResult>()

  /**
   * Generate SHA-256 hash from tool input
   * Uses JSON serialization for deterministic hashing
   *
   * @param input - Tool input (any serializable value)
   * @returns 64-character hex SHA-256 hash
   */
  hash(input: any): string {
    // Serialize input to JSON for deterministic hashing
    const serialized = JSON.stringify(input)

    // Generate SHA-256 hash
    return createHash('sha256').update(serialized).digest('hex')
  }

  /**
   * Generate cache key from run, tool, and input hash
   *
   * @param run_id - Run identifier
   * @param tool_id - Tool identifier
   * @param input_hash - Input hash (from hash() method)
   * @returns 64-character hex SHA-256 hash
   */
  private key(run_id: string, tool_id: string, input_hash: string): string {
    // Concatenate inputs with delimiters to prevent ambiguity
    const input = `${run_id}|${tool_id}|${input_hash}`

    // Generate SHA-256 hash
    return createHash('sha256').update(input).digest('hex')
  }

  /**
   * Retrieve cached result
   * Returns null if key does not exist or if tool is not idempotent
   *
   * @param run_id - Run identifier
   * @param tool_id - Tool identifier
   * @param input_hash - Input hash (from hash() method)
   * @param idempotent - Whether tool is idempotent (default true)
   * @returns ToolResult if cached, null otherwise
   */
  get(run_id: string, tool_id: string, input_hash: string, idempotent: boolean = true): ToolResult | null {
    // Bypass cache for non-idempotent tools
    if (idempotent === false) {
      return null
    }

    const cacheKey = this.key(run_id, tool_id, input_hash)
    return this.cache.get(cacheKey) ?? null
  }

  /**
   * Store result in cache
   * Only stores if tool is idempotent (default true)
   *
   * @param run_id - Run identifier
   * @param tool_id - Tool identifier
   * @param input_hash - Input hash (from hash() method)
   * @param result - ToolResult to cache
   * @param idempotent - Whether tool is idempotent (default true)
   */
  set(run_id: string, tool_id: string, input_hash: string, result: ToolResult, idempotent: boolean = true): void {
    // Bypass cache for non-idempotent tools
    if (idempotent === false) {
      return
    }

    const cacheKey = this.key(run_id, tool_id, input_hash)
    this.cache.set(cacheKey, result)
  }
}
