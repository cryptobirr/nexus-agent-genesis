import type { AgentNode, ChunkSummary, ModelAdapter } from './types.js'

/**
 * ContextCompressor - P-17
 * Bottom-up ChunkSummary generation. Blob store bypass for structured data.
 *
 * Zero dependencies. Makes LLM calls via injected model adapter.
 */
export class ContextCompressor {
  constructor(private modelAdapter: ModelAdapter) {}

  /**
   * Compress agent node output into ChunkSummary
   *
   * Priority rules:
   * 1. Escalated nodes → preserve full content, no compression
   * 2. Nodes with data_refs → include DataRef pointers, no summarization
   * 3. Text outputs → LLM-based summarization
   */
  async compress(agent_node: AgentNode): Promise<ChunkSummary> {
    const node_id = agent_node.node_id
    const data_refs = agent_node.data_refs || []
    const is_escalated = agent_node.is_escalated || false
    const output = agent_node.output || ''

    // Priority 1: Escalated nodes - never compress
    if (is_escalated) {
      return {
        node_id,
        summary: '',  // No summarization for escalated
        data_refs,
        is_escalated: true,
        full_content: output
      }
    }

    // Priority 2: Nodes with data_refs - bypass content compression
    if (data_refs.length > 0) {
      return {
        node_id,
        summary: '',  // No summarization when data_refs present
        data_refs,
        is_escalated: false
      }
    }

    // Priority 3: Text outputs - LLM summarization
    if (output && output.trim().length > 0) {
      const summary = await this.summarizeText(output)
      return {
        node_id,
        summary,
        data_refs: [],
        is_escalated: false
      }
    }

    // Empty output case
    return {
      node_id,
      summary: '',
      data_refs: [],
      is_escalated: false
    }
  }

  /**
   * Summarize text using LLM
   */
  private async summarizeText(text: string): Promise<string> {
    const prompt = this.buildSummarizationPrompt(text)
    const response = await this.modelAdapter.call(prompt)
    return this.extractSummary(response)
  }

  /**
   * Build summarization prompt
   */
  private buildSummarizationPrompt(text: string): string {
    return `Summarize the following agent output in 1-2 sentences, focusing on key results and decisions.

**Agent Output:**
${text}

Provide your summary within a fenced code block:

\`\`\`
[Your concise summary here]
\`\`\`
`
  }

  /**
   * Extract summary from LLM response
   * Looks for fenced code block with summary
   */
  private extractSummary(response: string): string {
    // Match ```...``` fenced block
    const match = response.match(/```(?:[a-z]*)?\s*\n?([\s\S]*?)\n?```/)
    if (match) {
      return match[1].trim()
    }

    // Fallback: return trimmed response if no fence found
    return response.trim()
  }
}
