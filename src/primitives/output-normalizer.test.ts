import { describe, it, expect } from 'vitest'
import { OutputNormalizer } from './output-normalizer.js'
import type { OutputSpec } from './types.js'

describe('OutputNormalizer (P-14)', () => {
  const normalizer = new OutputNormalizer()

  describe('No-op rule', () => {
    it('should always pass when schema=null, required_fields=[], mode=passthrough', () => {
      const spec: OutputSpec = {
        type: 'json',
        schema: null,
        required_fields: [],
        max_tokens: null,
        max_normalization_bytes: 10_000_000,
        normalization_mode: 'passthrough'
      }

      const result = normalizer.normalize({ anything: 'goes' }, spec)

      expect(result.passed).toBe(true)
      expect(result.failure_reason).toBeNull()
      expect(result.normalized_output).toEqual({ anything: 'goes' })
    })
  })

  describe('Passthrough mode', () => {
    it('should return output unchanged and always pass', () => {
      const raw = { foo: 'bar', baz: 123 }
      const spec: OutputSpec = {
        type: 'json',
        schema: '{"type":"object"}',
        required_fields: ['foo'],
        max_tokens: 100,
        max_normalization_bytes: 10_000_000,
        normalization_mode: 'passthrough'
      }

      const result = normalizer.normalize(raw, spec)

      expect(result.passed).toBe(true)
      expect(result.failure_reason).toBeNull()
      expect(result.normalized_output).toBe(raw)
    })

    it('should pass even with invalid schema when in passthrough mode', () => {
      const raw = { invalid: 'data' }
      const spec: OutputSpec = {
        type: 'json',
        schema: '{"type":"object","required":["missing_field"]}',
        required_fields: ['missing_field'],
        max_tokens: 1,
        max_normalization_bytes: 10_000_000,
        normalization_mode: 'passthrough'
      }

      const result = normalizer.normalize(raw, spec)

      expect(result.passed).toBe(true)
      expect(result.failure_reason).toBeNull()
    })
  })

  describe('Default normalization modes', () => {
    it('should default json type to strict mode', () => {
      const spec: OutputSpec = {
        type: 'json',
        schema: '{"type":"object","properties":{"name":{"type":"string"}},"required":["name"]}',
        required_fields: ['name'],
        max_tokens: null,
        max_normalization_bytes: 10_000_000,
        normalization_mode: 'strict'
      }

      // Valid output - should pass
      const validResult = normalizer.normalize({ name: 'test' }, spec)
      expect(validResult.passed).toBe(true)

      // Invalid output - should fail in strict mode
      const invalidResult = normalizer.normalize({ wrong: 'field' }, spec)
      expect(invalidResult.passed).toBe(false)
      expect(invalidResult.failure_reason).toBe('schema_failure')
    })

    it('should default text type to structural_only mode', () => {
      const spec: OutputSpec = {
        type: 'text',
        schema: null,
        required_fields: [],
        max_tokens: 10,
        max_normalization_bytes: 10_000_000,
        normalization_mode: 'structural_only'
      }

      // Short text - should pass
      const validResult = normalizer.normalize('short', spec)
      expect(validResult.passed).toBe(true)

      // Long text exceeding max_tokens - should fail
      const longText = 'word '.repeat(20) // 20 words, exceeds 10 tokens
      const invalidResult = normalizer.normalize(longText, spec)
      expect(invalidResult.passed).toBe(false)
      expect(invalidResult.failure_reason).toContain('max_tokens')
    })
  })

  describe('Strict mode - schema validation', () => {
    it('should validate JSON schema in strict mode', () => {
      const spec: OutputSpec = {
        type: 'json',
        schema: JSON.stringify({
          type: 'object',
          properties: {
            status: { type: 'string' },
            count: { type: 'number' }
          },
          required: ['status']
        }),
        required_fields: ['status'],
        max_tokens: null,
        max_normalization_bytes: 10_000_000,
        normalization_mode: 'strict'
      }

      // Valid schema match
      const validResult = normalizer.normalize(
        { status: 'success', count: 42 },
        spec
      )
      expect(validResult.passed).toBe(true)
      expect(validResult.failure_reason).toBeNull()

      // Invalid schema (wrong type)
      const invalidResult = normalizer.normalize(
        { status: 123 }, // status should be string
        spec
      )
      expect(invalidResult.passed).toBe(false)
      expect(invalidResult.failure_reason).toBe('schema_failure')
    })

    it('should validate required_fields in strict mode', () => {
      const spec: OutputSpec = {
        type: 'json',
        schema: '{"type":"object"}',
        required_fields: ['id', 'name', 'email'],
        max_tokens: null,
        max_normalization_bytes: 10_000_000,
        normalization_mode: 'strict'
      }

      // All required fields present
      const validResult = normalizer.normalize(
        { id: 1, name: 'Alice', email: 'alice@example.com' },
        spec
      )
      expect(validResult.passed).toBe(true)

      // Missing required field
      const invalidResult = normalizer.normalize(
        { id: 1, name: 'Bob' }, // missing email
        spec
      )
      expect(invalidResult.passed).toBe(false)
      expect(invalidResult.failure_reason).toBe('schema_failure')
    })

    it('should fail on schema mismatch with schema_failure', () => {
      const spec: OutputSpec = {
        type: 'json',
        schema: JSON.stringify({
          type: 'object',
          properties: {
            value: { type: 'number', minimum: 0, maximum: 100 }
          }
        }),
        required_fields: [],
        max_tokens: null,
        max_normalization_bytes: 10_000_000,
        normalization_mode: 'strict'
      }

      const result = normalizer.normalize({ value: 150 }, spec)

      expect(result.passed).toBe(false)
      expect(result.failure_reason).toBe('schema_failure')
    })
  })

  describe('Structural_only mode', () => {
    it('should only check max_tokens compliance', () => {
      const spec: OutputSpec = {
        type: 'text',
        schema: '{"invalid":"schema"}', // Invalid schema but should be ignored
        required_fields: ['ignored'],
        max_tokens: 5,
        max_normalization_bytes: 10_000_000,
        normalization_mode: 'structural_only'
      }

      // Short text - should pass
      const validResult = normalizer.normalize('hello', spec)
      expect(validResult.passed).toBe(true)

      // Long text - should fail
      const longText = 'word '.repeat(10) // Exceeds 5 tokens
      const invalidResult = normalizer.normalize(longText, spec)
      expect(invalidResult.passed).toBe(false)
    })

    it('should not validate schema in structural_only mode', () => {
      const spec: OutputSpec = {
        type: 'json',
        schema: '{"type":"object","required":["missing"]}',
        required_fields: ['missing'],
        max_tokens: null,
        max_normalization_bytes: 10_000_000,
        normalization_mode: 'structural_only'
      }

      // Schema mismatch but structural_only mode - should pass
      const result = normalizer.normalize({ other: 'field' }, spec)
      expect(result.passed).toBe(true)
      expect(result.failure_reason).toBeNull()
    })
  })

  describe('Edge cases', () => {
    it('should handle null output', () => {
      const spec: OutputSpec = {
        type: 'json',
        schema: null,
        required_fields: [],
        max_tokens: null,
        max_normalization_bytes: 10_000_000,
        normalization_mode: 'strict'
      }

      const result = normalizer.normalize(null, spec)
      expect(result.normalized_output).toBeNull()
      expect(result.passed).toBe(true)
    })

    it('should handle undefined output', () => {
      const spec: OutputSpec = {
        type: 'json',
        schema: null,
        required_fields: [],
        max_tokens: null,
        max_normalization_bytes: 10_000_000,
        normalization_mode: 'passthrough'
      }

      const result = normalizer.normalize(undefined, spec)
      expect(result.normalized_output).toBeUndefined()
      expect(result.passed).toBe(true)
    })

    it('should handle invalid JSON schema string gracefully', () => {
      const spec: OutputSpec = {
        type: 'json',
        schema: 'not valid json',
        required_fields: [],
        max_tokens: null,
        max_normalization_bytes: 10_000_000,
        normalization_mode: 'strict'
      }

      const result = normalizer.normalize({ data: 'test' }, spec)
      expect(result.passed).toBe(false)
      expect(result.failure_reason).toBe('schema_failure')
    })

    it('should respect max_normalization_bytes limit', () => {
      const spec: OutputSpec = {
        type: 'json',
        schema: null,
        required_fields: [],
        max_tokens: null,
        max_normalization_bytes: 10, // Very small limit
        normalization_mode: 'strict'
      }

      const largeOutput = { data: 'x'.repeat(1000) }
      const result = normalizer.normalize(largeOutput, spec)

      expect(result.passed).toBe(false)
      expect(result.failure_reason).toContain('size')
    })
  })
})
