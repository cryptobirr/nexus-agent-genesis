import type { AgentType, PreCheckResult } from './types.js'

/**
 * DeterministicPreCheck - P-12
 * Zero-token structural validation of agent output before any judge fires.
 *
 * Zero dependencies. Zero inference cost.
 */
export class DeterministicPreCheck {
  /**
   * Validate agent output structure based on agent type
   * Returns violations array with descriptions of structural issues
   */
  run(agent_type: AgentType, output: any): PreCheckResult {
    const violations: string[] = []

    // Handle null/undefined output
    if (output === null || output === undefined || typeof output !== 'object') {
      violations.push('Output is null, undefined, or not an object')
      return { passed: false, violations }
    }

    // Route to appropriate validation based on agent type
    switch (agent_type) {
      case 'router':
        this.validateRouter(output, violations)
        break
      case 'planner':
        this.validatePlanner(output, violations)
        break
      case 'executor':
        this.validateExecutor(output, violations)
        break
      default:
        violations.push(`Unknown agent_type: ${agent_type}`)
    }

    return {
      passed: violations.length === 0,
      violations
    }
  }

  /**
   * Router validation:
   * - required fields present
   * - routing value valid
   * - requirements array non-empty
   */
  private validateRouter(output: any, violations: string[]): void {
    // Check routing field
    if (!('routing' in output)) {
      violations.push('Router output missing required field: routing')
    } else {
      const validRoutingValues = ['plan', 'execute']
      if (!validRoutingValues.includes(output.routing)) {
        violations.push(`Router output has invalid routing value: ${output.routing}`)
      }
    }

    // Check requirements field
    if (!('requirements' in output)) {
      violations.push('Router output missing required field: requirements')
    } else if (!Array.isArray(output.requirements)) {
      violations.push('Router output requirements must be an array')
    } else if (output.requirements.length === 0) {
      violations.push('Router output requirements array is empty')
    }
  }

  /**
   * Planner validation:
   * - decision field valid
   * - children array non-empty
   * - covers_requirements declared
   */
  private validatePlanner(output: any, violations: string[]): void {
    // Check decision field
    if (!('decision' in output)) {
      violations.push('Planner output missing required field: decision')
    } else {
      const validDecisionValues = ['recurse', 'execute']
      if (!validDecisionValues.includes(output.decision)) {
        violations.push(`Planner output has invalid decision value: ${output.decision}`)
      }
    }

    // Check children field
    if (!('children' in output)) {
      violations.push('Planner output missing required field: children')
    } else if (!Array.isArray(output.children)) {
      violations.push('Planner output children must be an array')
    } else if (output.children.length === 0) {
      violations.push('Planner output children array is empty')
    }

    // Check covers_requirements field
    if (!('covers_requirements' in output)) {
      violations.push('Planner output missing required field: covers_requirements')
    }
  }

  /**
   * Executor validation:
   * - status field present
   * - output or tool_call populated
   * - evidence present for llm_output
   */
  private validateExecutor(output: any, violations: string[]): void {
    // Check status field
    if (!('status' in output)) {
      violations.push('Executor output missing required field: status')
    }

    // Check that at least one of output or tool_call exists
    const hasOutput = 'output' in output
    const hasToolCall = 'tool_call' in output

    if (!hasOutput && !hasToolCall) {
      violations.push('Executor output missing both output and tool_call')
    }

    // If llm_output mode (has 'output' but not 'tool_call'), require evidence
    if (hasOutput && !hasToolCall) {
      if (!('evidence' in output)) {
        violations.push('Executor output with llm_output missing required field: evidence')
      }
    }
  }
}
