import type { OutputSpec, NormalizationResult } from './types.js'
import Ajv from 'ajv'

/**
 * OutputNormalizer - P-14
 * Convert Executor raw output to declared schema before pre-checks.
 *
 * Zero dependencies. Zero inference cost.
 *
 * CRITICAL BEHAVIORS (from agent-nexus-spec.md):
 * - Runs BEFORE blob store routing (on raw in-memory output)
 * - Does NOT dereference blob store entries
 * - validate strategy: normalization failure → immediate escalation (no retry)
 *
 * Normalization modes:
 * - strict: schema validation + required_fields check
 * - structural_only: max_tokens compliance only
 * - passthrough: no-op
 *
 * Default modes by type:
 * - json → strict
 * - text → structural_only
 *
 * No-op rule: null schema + empty required_fields + passthrough = always passes
 */
export class OutputNormalizer {
  private ajv = new Ajv({ allErrors: true })

  /**
   * Normalize raw output according to OutputSpec
   * Returns NormalizationResult with normalized output, pass status, and failure reason
   */
  normalize(raw_output: unknown, output_spec: OutputSpec): NormalizationResult {
    // No-op rule: null schema + empty required_fields + passthrough = always passes
    if (
      output_spec.schema === null &&
      output_spec.required_fields.length === 0 &&
      output_spec.normalization_mode === 'passthrough'
    ) {
      return {
        normalized_output: raw_output,
        passed: true,
        failure_reason: null
      }
    }

    // Passthrough mode: no validation, output unchanged
    if (output_spec.normalization_mode === 'passthrough') {
      return {
        normalized_output: raw_output,
        passed: true,
        failure_reason: null
      }
    }

    // Check max_normalization_bytes limit
    const outputSize = JSON.stringify(raw_output).length
    if (outputSize > output_spec.max_normalization_bytes) {
      return {
        normalized_output: raw_output,
        passed: false,
        failure_reason: `Output size ${outputSize} bytes exceeds max_normalization_bytes ${output_spec.max_normalization_bytes}`
      }
    }

    // Route by normalization mode
    if (output_spec.normalization_mode === 'structural_only') {
      return this.validateStructuralOnly(raw_output, output_spec)
    }

    // Strict mode: schema validation + required_fields
    return this.validateStrict(raw_output, output_spec)
  }

  /**
   * Structural-only validation: max_tokens compliance only
   */
  private validateStructuralOnly(raw_output: unknown, output_spec: OutputSpec): NormalizationResult {
    // If max_tokens is specified, check compliance
    if (output_spec.max_tokens !== null) {
      const tokenCount = this.estimateTokenCount(raw_output)
      if (tokenCount > output_spec.max_tokens) {
        return {
          normalized_output: raw_output,
          passed: false,
          failure_reason: `Token count ${tokenCount} exceeds max_tokens ${output_spec.max_tokens}`
        }
      }
    }

    return {
      normalized_output: raw_output,
      passed: true,
      failure_reason: null
    }
  }

  /**
   * Strict validation: schema + required_fields
   */
  private validateStrict(raw_output: unknown, output_spec: OutputSpec): NormalizationResult {
    // Check required_fields first (simpler check)
    if (output_spec.required_fields.length > 0) {
      const fieldCheck = this.validateRequiredFields(raw_output, output_spec.required_fields)
      if (!fieldCheck.passed) {
        return fieldCheck
      }
    }

    // Check JSON schema if provided
    if (output_spec.schema !== null && output_spec.schema !== '') {
      const schemaCheck = this.validateJsonSchema(raw_output, output_spec.schema)
      if (!schemaCheck.passed) {
        return schemaCheck
      }
    }

    return {
      normalized_output: raw_output,
      passed: true,
      failure_reason: null
    }
  }

  /**
   * Validate required fields are present in output
   */
  private validateRequiredFields(output: unknown, required_fields: string[]): NormalizationResult {
    // Output must be an object to check fields
    if (typeof output !== 'object' || output === null) {
      return {
        normalized_output: output,
        passed: false,
        failure_reason: 'schema_failure'
      }
    }

    const outputObj = output as Record<string, unknown>

    for (const field of required_fields) {
      if (!(field in outputObj)) {
        return {
          normalized_output: output,
          passed: false,
          failure_reason: 'schema_failure'
        }
      }
    }

    return {
      normalized_output: output,
      passed: true,
      failure_reason: null
    }
  }

  /**
   * Validate output against JSON schema
   */
  private validateJsonSchema(output: unknown, schema: string): NormalizationResult {
    try {
      // Parse schema string
      const schemaObj = JSON.parse(schema)

      // Compile and validate
      const validate = this.ajv.compile(schemaObj)
      const valid = validate(output)

      if (!valid) {
        return {
          normalized_output: output,
          passed: false,
          failure_reason: 'schema_failure'
        }
      }

      return {
        normalized_output: output,
        passed: true,
        failure_reason: null
      }
    } catch (error) {
      // Invalid schema string or validation error
      return {
        normalized_output: output,
        passed: false,
        failure_reason: 'schema_failure'
      }
    }
  }

  /**
   * Estimate token count from output
   * Simple heuristic: 1 token ≈ 4 characters for English text
   */
  private estimateTokenCount(output: unknown): number {
    const text = typeof output === 'string' ? output : JSON.stringify(output)
    return Math.ceil(text.length / 4)
  }
}
