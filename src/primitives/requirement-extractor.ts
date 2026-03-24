import type { RequirementMap, CoverageResult, AgentNode, RequirementRecord } from './types.js'

/**
 * RequirementExtractor - P-08
 * Parse Router output into a RequirementMap with RequirementRecords.
 *
 * Zero dependencies.
 */
export class RequirementExtractor {
  /**
   * Extract requirements from router output
   * Expects JSON array format with id, description, priority fields
   */
  extract(router_output: string): RequirementMap {
    try {
      const parsed = JSON.parse(router_output)

      if (!Array.isArray(parsed)) {
        throw new Error('Router output must be a JSON array')
      }

      const map: RequirementMap = new Map()

      for (const item of parsed) {
        if (!item.id || !item.description || !item.priority) {
          throw new Error('Each requirement must have id, description, and priority')
        }

        const record: RequirementRecord = {
          id: item.id,
          description: item.description,
          priority: item.priority,
          coverage_score: 0
        }

        map.set(item.id, record)
      }

      return map
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new Error('Invalid JSON in router output')
      }
      throw error
    }
  }

  /**
   * Check coverage of requirements against agent nodes
   * Updates coverage_score to 1.0 for covered requirements
   */
  checkCoverage(map: RequirementMap, agent_nodes: AgentNode[]): CoverageResult {
    // Collect all covered requirement IDs from agent nodes
    const coveredSet = new Set<string>()

    for (const node of agent_nodes) {
      for (const reqId of node.requirements_covered) {
        coveredSet.add(reqId)
      }
    }

    // Update coverage scores and track covered/uncovered
    const covered_ids: string[] = []
    const uncovered_ids: string[] = []

    map.forEach((record, id) => {
      if (coveredSet.has(id)) {
        record.coverage_score = 1.0
        covered_ids.push(id)
      } else {
        uncovered_ids.push(id)
      }
    })

    return {
      covered_count: covered_ids.length,
      uncovered_count: uncovered_ids.length,
      covered_ids,
      uncovered_ids
    }
  }

  /**
   * Compute confidence score
   * Formula: (covered/total) × mean(requirement_coverage_scores)
   * Guard: Returns 0 if any high-priority requirement has coverage_score < 1.0
   */
  computeConfidence(map: RequirementMap): number {
    if (map.size === 0) {
      return 0
    }

    // High-priority requirement guard
    for (const record of map.values()) {
      if (record.priority === 'high' && record.coverage_score < 1.0) {
        return 0
      }
    }

    // Count covered requirements
    let covered = 0
    let totalScore = 0

    map.forEach((record) => {
      if (record.coverage_score >= 1.0) {
        covered++
      }
      totalScore += record.coverage_score
    })

    const total = map.size
    const coverageRatio = covered / total
    const meanScore = totalScore / total

    return coverageRatio * meanScore
  }
}
