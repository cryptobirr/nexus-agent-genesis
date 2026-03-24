import type { DomainHint } from './types.js'

/**
 * DomainRegistry - P-06
 * Domain hint lookup for context assembly and model routing.
 *
 * Zero dependencies.
 */
export class DomainRegistry {
  private domains = new Map<string, DomainHint>()

  /**
   * Register a domain hint in the registry
   * Re-registration overwrites previous definition (idempotent)
   *
   * @param domain - Domain hint to register
   */
  register(domain: DomainHint): void {
    // Deep copy to prevent external mutation
    const domainCopy = this.deepCopy(domain)
    this.domains.set(domain.domain_id, domainCopy)
  }

  /**
   * Retrieve a registered domain by ID
   * Returns deep copy to prevent mutation
   *
   * @param domain_id - Domain identifier
   * @returns Array containing the domain if found, empty array if not found
   */
  get(domain_id: string): DomainHint[] {
    const domain = this.domains.get(domain_id)

    if (!domain) {
      return []
    }

    // Return deep copy to prevent mutation
    return [this.deepCopy(domain)]
  }

  /**
   * Find domains by semantic match against scope text
   * Performs case-insensitive keyword matching
   *
   * @param scope_text - Text to match against domain keywords
   * @returns Array of matching domains (empty if no matches)
   */
  match(scope_text: string): DomainHint[] {
    const lowerScopeText = scope_text.toLowerCase()
    const matches: DomainHint[] = []

    for (const domain of this.domains.values()) {
      // Check if any keyword appears in scope_text
      const hasMatch = domain.keywords.some(keyword =>
        lowerScopeText.includes(keyword.toLowerCase())
      )

      if (hasMatch) {
        matches.push(this.deepCopy(domain))
      }
    }

    return matches
  }

  /**
   * Deep copy helper using JSON serialization
   * Works for plain objects
   */
  private deepCopy<T>(obj: T): T {
    return JSON.parse(JSON.stringify(obj))
  }
}
