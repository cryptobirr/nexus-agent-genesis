import type { Contract, AgentType } from './types.js'

/**
 * ContractRegistry - P-07
 * Store and version agent Contracts (sets of Dimensions with weights).
 *
 * Zero dependencies.
 */
export class ContractRegistry {
  private contracts = new Map<AgentType, Contract>()

  /**
   * Register a contract in the registry
   * Re-registration overwrites previous definition (idempotent)
   *
   * @param contract - Contract to register
   */
  register(contract: Contract): void {
    // Deep copy to prevent external mutation
    const contractCopy = this.deepCopy(contract)
    this.contracts.set(contract.agent_type, contractCopy)
  }

  /**
   * Retrieve a registered contract by agent type
   * Returns deep copy to prevent mutation
   *
   * @param agent_type - Agent type identifier
   * @returns Contract if found, undefined if not found
   */
  get(agent_type: AgentType): Contract | undefined {
    const contract = this.contracts.get(agent_type)

    if (!contract) {
      return undefined
    }

    // Return deep copy to prevent mutation
    return this.deepCopy(contract)
  }

  /**
   * Apply strategy weight overrides and re-normalize
   * Overrides are absolute targets (not deltas)
   * Dimensions not in override retain base weight before normalization
   *
   * @param contract - Base contract
   * @param strategy - Weight overrides as Record<dimension_id, weight>
   * @returns New contract with overrides applied and weights normalized to sum to 1.0
   */
  applyStrategyOverrides(
    contract: Contract,
    strategy: Record<string, number>
  ): Contract {
    // Deep copy to prevent mutation
    const result = this.deepCopy(contract)

    // Step 1: Apply absolute overrides
    for (const dimension of result.dimensions) {
      if (dimension.dimension_id in strategy) {
        dimension.weight = strategy[dimension.dimension_id]
      }
      // Dimensions not in override keep their base weight
    }

    // Step 2: Normalize weights to sum to 1.0
    const sum = result.dimensions.reduce((acc, d) => acc + d.weight, 0)

    if (sum > 0) {
      for (const dimension of result.dimensions) {
        dimension.weight = dimension.weight / sum
      }
    }

    return result
  }

  /**
   * Deep copy helper using JSON serialization
   * Works for plain objects
   */
  private deepCopy<T>(obj: T): T {
    return JSON.parse(JSON.stringify(obj))
  }
}
