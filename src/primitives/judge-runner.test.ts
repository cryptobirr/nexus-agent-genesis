import { describe, it, expect, beforeEach, vi } from 'vitest'
import { JudgeRunner } from './judge-runner.js'
import type { Dimension, JudgeContext, ModelAdapter, Signal } from './types.js'
import type { EventHandler } from './types.js'

/**
 * Mock ModelAdapter for testing
 */
class MockModelAdapter implements ModelAdapter {
  private contextWindowSize = 4096
  private responses: Map<string, string> = new Map()

  setResponse(key: string, response: string): void {
    this.responses.set(key, response)
  }

  async call(prompt: string): Promise<string> {
    // Check for specific prompt patterns in order of specificity
    // Check for exact keys first
    for (const [key, response] of this.responses.entries()) {
      if (prompt.includes(key)) {
        return response
      }
    }

    // Check for dimension IDs in prompt
    if (prompt.includes('dimension_id')) {
      const match = prompt.match(/dimension_id[:\s]+["']?(\w+)["']?/i)
      const dimensionId = match ? match[1] : null
      if (dimensionId && this.responses.has(dimensionId)) {
        return this.responses.get(dimensionId)!
      }
    }

    // Default response
    return this.createDefaultResponse(prompt)
  }

  getContextWindowSize(): number {
    return this.contextWindowSize
  }

  setContextWindowSize(size: number): void {
    this.contextWindowSize = size
  }

  estimateTokens(text: string): number {
    return Math.ceil(text.length / 4)
  }

  private createDefaultResponse(prompt: string): string {
    // Extract dimension_id from prompt if present
    const match = prompt.match(/dimension[_\s]id[:\s]+["']?(\w+)["']?/i)
    const dimensionId = match ? match[1] : 'unknown'

    return `The evaluation for ${dimensionId} shows good performance.

\`\`\`json
{
  "verdict": true,
  "numeric_score": 0.85,
  "gap": 0.15,
  "severity": "low",
  "reasoning": "Performance meets expectations"
}
\`\`\`
`
  }
}

/**
 * Mock MessageBus for testing
 */
class MockMessageBus {
  private events: Array<{ event_type: string; payload: object }> = []

  emit(event_type: string, payload: object): void {
    this.events.push({ event_type, payload })
  }

  subscribe(_event_type: string, _handler: EventHandler): () => void {
    return () => {}
  }

  replay(_run_id: string): any[] {
    return this.events
  }

  getEvents(): Array<{ event_type: string; payload: object }> {
    return this.events
  }

  hasEvent(event_type: string): boolean {
    return this.events.some(e => e.event_type === event_type)
  }
}

describe('JudgeRunner', () => {
  let runner: JudgeRunner
  let mockAdapter: MockModelAdapter
  let mockBus: MockMessageBus

  const createDimension = (overrides?: Partial<Dimension>): Dimension => ({
    dimension_id: 'test_dimension',
    weight: 1.0,
    is_binary: false,
    gate: 1,
    ...overrides
  })

  const createContext = (overrides?: Partial<JudgeContext>): JudgeContext => ({
    agent_output: 'Test agent output',
    dimension_criteria: new Map([['test_dimension', 'Should be correct']]),
    run_id: 'test-run-1',
    ...overrides
  })

  beforeEach(() => {
    mockAdapter = new MockModelAdapter()
    mockBus = new MockMessageBus()
    runner = new JudgeRunner(mockAdapter, mockBus)
  })

  describe('run() - single dimension execution', () => {
    it('returns Signal with all required fields', async () => {
      const dimension = createDimension()
      const context = createContext()

      const signal = await runner.run(dimension, context)

      expect(signal).toHaveProperty('verdict')
      expect(signal).toHaveProperty('numeric_score')
      expect(signal).toHaveProperty('gap')
      expect(signal).toHaveProperty('severity')
      expect(signal).toHaveProperty('reasoning')

      expect(typeof signal.verdict).toBe('boolean')
      expect(typeof signal.numeric_score).toBe('number')
      expect(typeof signal.gap).toBe('number')
      expect(['low', 'medium', 'high', 'critical']).toContain(signal.severity)
      expect(typeof signal.reasoning).toBe('string')
    })

    it('parses fenced JSON block and ignores prose reasoning', async () => {
      mockAdapter.setResponse('test', `This is prose reasoning before the JSON.

It can span multiple lines and contain arbitrary text.

\`\`\`json
{
  "verdict": false,
  "numeric_score": 0.3,
  "gap": 0.7,
  "severity": "high",
  "reasoning": "Performance is below threshold"
}
\`\`\`

This is prose after the JSON that should also be ignored.
`)

      const dimension = createDimension()
      const context = createContext()

      const signal = await runner.run(dimension, context)

      expect(signal.verdict).toBe(false)
      expect(signal.numeric_score).toBe(0.3)
      expect(signal.gap).toBe(0.7)
      expect(signal.severity).toBe('high')
      expect(signal.reasoning).toBe('Performance is below threshold')
    })

    it('handles is_binary dimension', async () => {
      mockAdapter.setResponse('Is Binary:** true', `\`\`\`json
{
  "verdict": true,
  "numeric_score": 1.0,
  "gap": 0.0,
  "severity": "low",
  "reasoning": "Binary check passed"
}
\`\`\``)

      const dimension = createDimension({ is_binary: true })
      const context = createContext()

      const signal = await runner.run(dimension, context)

      expect(signal.verdict).toBe(true)
      expect(signal.numeric_score).toBe(1.0)
      expect(signal.gap).toBe(0.0)
    })

    it('handles numeric dimension with scores', async () => {
      mockAdapter.setResponse('numeric', `\`\`\`json
{
  "verdict": true,
  "numeric_score": 0.75,
  "gap": 0.25,
  "severity": "medium",
  "reasoning": "Partial success with room for improvement"
}
\`\`\``)

      const dimension = createDimension({ is_binary: false })
      const context = createContext()

      const signal = await runner.run(dimension, context)

      expect(signal.verdict).toBe(true)
      expect(signal.numeric_score).toBe(0.75)
      expect(signal.gap).toBe(0.25)
      expect(signal.severity).toBe('medium')
    })
  })

  describe('runMerged() - batched execution', () => {
    it('parses JSON array with per-dimension verdicts', async () => {
      mockAdapter.setResponse('Dimensions to evaluate:', `Batch evaluation results:

\`\`\`json
[
  {
    "verdict": true,
    "numeric_score": 0.9,
    "gap": 0.1,
    "severity": "low",
    "reasoning": "First dimension passed"
  },
  {
    "verdict": false,
    "numeric_score": 0.4,
    "gap": 0.6,
    "severity": "high",
    "reasoning": "Second dimension failed"
  }
]
\`\`\``)

      const dimensions = [
        createDimension({ dimension_id: 'dim1' }),
        createDimension({ dimension_id: 'dim2' })
      ]
      const context = createContext()

      const signals = await runner.runMerged(dimensions, context)

      expect(signals).toHaveLength(2)
      expect(signals[0].verdict).toBe(true)
      expect(signals[0].numeric_score).toBe(0.9)
      expect(signals[1].verdict).toBe(false)
      expect(signals[1].numeric_score).toBe(0.4)
    })

    it('returns Signal[] matching input Dimension[] order', async () => {
      mockAdapter.setResponse('order', `\`\`\`json
[
  {"verdict": true, "numeric_score": 0.8, "gap": 0.2, "severity": "low", "reasoning": "A"},
  {"verdict": true, "numeric_score": 0.9, "gap": 0.1, "severity": "low", "reasoning": "B"},
  {"verdict": false, "numeric_score": 0.5, "gap": 0.5, "severity": "medium", "reasoning": "C"}
]
\`\`\``)

      const dimensions = [
        createDimension({ dimension_id: 'alpha' }),
        createDimension({ dimension_id: 'beta' }),
        createDimension({ dimension_id: 'gamma' })
      ]
      const context = createContext()

      const signals = await runner.runMerged(dimensions, context)

      expect(signals).toHaveLength(3)
      expect(signals[0].reasoning).toBe('A')
      expect(signals[1].reasoning).toBe('B')
      expect(signals[2].reasoning).toBe('C')
    })

    it('falls back to isolated calls on malformed JSON', async () => {
      mockAdapter.setResponse('merged', 'This is not valid JSON at all!')

      const dimensions = [
        createDimension({ dimension_id: 'dim1' }),
        createDimension({ dimension_id: 'dim2' })
      ]
      const context = createContext()

      const signals = await runner.runMerged(dimensions, context)

      // Should still get results via fallback
      expect(signals).toHaveLength(2)
      expect(signals[0]).toHaveProperty('verdict')
      expect(signals[1]).toHaveProperty('verdict')
    })

    it('logs merged_judge_fallback on fallback', async () => {
      mockAdapter.setResponse('merged', 'Invalid JSON')

      const dimensions = [createDimension()]
      const context = createContext()

      await runner.runMerged(dimensions, context)

      expect(mockBus.hasEvent('merged_judge_fallback')).toBe(true)
    })

    it('handles timeout as malformed response (triggers fallback)', async () => {
      // Simulate timeout by throwing
      mockAdapter.setResponse('merged', '')
      vi.spyOn(mockAdapter, 'call').mockRejectedValueOnce(new Error('Timeout'))

      const dimensions = [createDimension()]
      const context = createContext()

      const signals = await runner.runMerged(dimensions, context)

      // Should fallback and succeed
      expect(signals).toHaveLength(1)
      expect(mockBus.hasEvent('merged_judge_fallback')).toBe(true)
    })

    it('auto-excludes accuracy at 80% context window threshold', async () => {
      mockAdapter.setContextWindowSize(1000) // Small window

      const dimensions = [
        createDimension({ dimension_id: 'accuracy' }),
        createDimension({ dimension_id: 'correctness' }),
        createDimension({ dimension_id: 'completeness' })
      ]

      // Create large context to trigger 80% threshold
      const largeCriteria = new Map<string, string>()
      for (let i = 0; i < 100; i++) {
        largeCriteria.set(`key${i}`, 'x'.repeat(100))
      }

      const context = createContext({
        agent_output: 'x'.repeat(3000),
        dimension_criteria: largeCriteria
      })

      const signals = await runner.runMerged(dimensions, context)

      // Should still return signals for all dimensions
      expect(signals).toHaveLength(3)

      // Verify accuracy was excluded from merged batch (fell back to isolated call)
      // We can infer this by checking that fallback was logged
      expect(mockBus.hasEvent('merged_judge_fallback')).toBe(true)
    })
  })

  describe('edge cases', () => {
    it('handles empty dimensions array', async () => {
      const context = createContext()

      const signals = await runner.runMerged([], context)

      expect(signals).toHaveLength(0)
    })

    it('handles single dimension in runMerged', async () => {
      mockAdapter.setResponse('single', `\`\`\`json
[
  {"verdict": true, "numeric_score": 0.95, "gap": 0.05, "severity": "low", "reasoning": "Single"}
]
\`\`\``)

      const dimensions = [createDimension()]
      const context = createContext()

      const signals = await runner.runMerged(dimensions, context)

      expect(signals).toHaveLength(1)
      expect(signals[0].verdict).toBe(true)
    })
  })
})
