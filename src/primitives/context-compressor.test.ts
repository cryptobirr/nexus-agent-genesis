import { describe, it, expect, beforeEach } from 'vitest'
import { ContextCompressor } from './context-compressor.js'
import type { AgentNode, ModelAdapter, ChunkSummary, DataRef } from './types.js'

/**
 * Mock ModelAdapter for testing
 */
class MockModelAdapter implements ModelAdapter {
  private mockSummary = 'Agent successfully processed the request and returned results.'

  setSummary(summary: string): void {
    this.mockSummary = summary
  }

  async call(_prompt: string): Promise<string> {
    return `Here's the summary:

\`\`\`
${this.mockSummary}
\`\`\`
`
  }

  getContextWindowSize(): number {
    return 4096
  }

  estimateTokens(text: string): number {
    return Math.ceil(text.length / 4)
  }
}

describe('ContextCompressor', () => {
  let compressor: ContextCompressor
  let mockAdapter: MockModelAdapter

  beforeEach(() => {
    mockAdapter = new MockModelAdapter()
    compressor = new ContextCompressor(mockAdapter)
  })

  describe('Text output compression', () => {
    it('should compress text output using LLM summarization', async () => {
      const node: AgentNode = {
        node_id: 'node-1',
        requirements_covered: ['req-1'],
        output: 'This is a long agent output that should be compressed into a summary. It contains multiple sentences and detailed information about the execution.',
        data_refs: [],
        is_escalated: false
      }

      mockAdapter.setSummary('Agent processed request successfully.')

      const result: ChunkSummary = await compressor.compress(node)

      expect(result.node_id).toBe('node-1')
      expect(result.summary).toBe('Agent processed request successfully.')
      expect(result.data_refs).toEqual([])
      expect(result.is_escalated).toBe(false)
      expect(result.full_content).toBeUndefined()
    })

    it('should produce non-empty summary for text outputs', async () => {
      const node: AgentNode = {
        node_id: 'node-2',
        requirements_covered: [],
        output: 'Some output text',
        is_escalated: false
      }

      const result = await compressor.compress(node)

      expect(result.summary).toBeTruthy()
      expect(result.summary.length).toBeGreaterThan(0)
    })
  })

  describe('DataRef bypass', () => {
    it('should include DataRef pointers without summarizing content', async () => {
      const dataRefs: DataRef[] = [
        { ref_id: 'blob-1', schema: 'json', size_bytes: 1024 },
        { ref_id: 'blob-2', schema: 'csv', size_bytes: 2048 }
      ]

      const node: AgentNode = {
        node_id: 'node-3',
        requirements_covered: ['req-2'],
        output: 'Output text that should be ignored',
        data_refs: dataRefs,
        is_escalated: false
      }

      const result = await compressor.compress(node)

      expect(result.node_id).toBe('node-3')
      expect(result.data_refs).toEqual(dataRefs)
      expect(result.summary).toBe('')  // No summarization when data_refs present
      expect(result.is_escalated).toBe(false)
    })

    it('should handle multiple DataRefs', async () => {
      const dataRefs: DataRef[] = [
        { ref_id: 'blob-1', schema: 'json', size_bytes: 1024 },
        { ref_id: 'blob-2', schema: 'csv', size_bytes: 2048 },
        { ref_id: 'blob-3', schema: 'parquet', size_bytes: 4096 }
      ]

      const node: AgentNode = {
        node_id: 'node-4',
        requirements_covered: [],
        data_refs: dataRefs
      }

      const result = await compressor.compress(node)

      expect(result.data_refs).toHaveLength(3)
      expect(result.data_refs).toEqual(dataRefs)
      expect(result.summary).toBe('')
    })
  })

  describe('Escalated node handling', () => {
    it('should set is_escalated=true and preserve full content', async () => {
      const fullOutput = 'This is the complete output that must be preserved without compression.'

      const node: AgentNode = {
        node_id: 'node-5',
        requirements_covered: ['req-3'],
        output: fullOutput,
        data_refs: [],
        is_escalated: true
      }

      const result = await compressor.compress(node)

      expect(result.node_id).toBe('node-5')
      expect(result.is_escalated).toBe(true)
      expect(result.full_content).toBe(fullOutput)
      expect(result.summary).toBe('')  // No summarization for escalated
      expect(result.data_refs).toEqual([])
    })

    it('should never compress escalated nodes', async () => {
      const node: AgentNode = {
        node_id: 'node-6',
        requirements_covered: [],
        output: 'Long output that would normally be compressed but is escalated',
        is_escalated: true
      }

      const result = await compressor.compress(node)

      expect(result.is_escalated).toBe(true)
      expect(result.full_content).toBeDefined()
      expect(result.full_content).toBe(node.output)
      // Summary should be empty for escalated nodes
      expect(result.summary).toBe('')
    })
  })

  describe('Edge cases', () => {
    it('should handle empty output gracefully', async () => {
      const node: AgentNode = {
        node_id: 'node-7',
        requirements_covered: [],
        output: '',
        is_escalated: false
      }

      const result = await compressor.compress(node)

      expect(result.node_id).toBe('node-7')
      expect(result.summary).toBe('')
      expect(result.is_escalated).toBe(false)
    })

    it('should handle undefined output', async () => {
      const node: AgentNode = {
        node_id: 'node-8',
        requirements_covered: []
      }

      const result = await compressor.compress(node)

      expect(result.node_id).toBe('node-8')
      expect(result.summary).toBe('')
      expect(result.is_escalated).toBe(false)
    })

    it('should handle node with no data_refs field', async () => {
      const node: AgentNode = {
        node_id: 'node-9',
        requirements_covered: [],
        output: 'Some output'
      }

      const result = await compressor.compress(node)

      expect(result.data_refs).toEqual([])
    })
  })

  describe('Priority rules', () => {
    it('should prioritize escalation over data_refs', async () => {
      const dataRefs: DataRef[] = [
        { ref_id: 'blob-1', schema: 'json', size_bytes: 1024 }
      ]

      const node: AgentNode = {
        node_id: 'node-10',
        requirements_covered: [],
        output: 'Output with both escalation and data_refs',
        data_refs: dataRefs,
        is_escalated: true
      }

      const result = await compressor.compress(node)

      expect(result.is_escalated).toBe(true)
      expect(result.full_content).toBe(node.output)
      expect(result.data_refs).toEqual(dataRefs)  // Still included
      expect(result.summary).toBe('')  // No summarization
    })

    it('should prioritize data_refs over text summarization', async () => {
      const dataRefs: DataRef[] = [
        { ref_id: 'blob-1', schema: 'json', size_bytes: 1024 }
      ]

      const node: AgentNode = {
        node_id: 'node-11',
        requirements_covered: [],
        output: 'This text should not be summarized because data_refs are present',
        data_refs: dataRefs,
        is_escalated: false
      }

      const result = await compressor.compress(node)

      expect(result.data_refs).toEqual(dataRefs)
      expect(result.summary).toBe('')  // No LLM call made
      expect(result.is_escalated).toBe(false)
    })
  })
})
