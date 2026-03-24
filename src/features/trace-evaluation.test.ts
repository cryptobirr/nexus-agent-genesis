import { describe, it, expect, beforeEach } from 'vitest'
import { TraceEvaluation } from './trace-evaluation.js'
import type {
  RequirementMap,
  AgentNode,
  DependencyGraph,
  SECEntry,
  RequirementRecord,
  CoverageResult,
  Dimension,
  JudgeContext,
  Signal,
  ModelAdapter,
  ChunkSummary,
  DataRef
} from '../primitives/types.js'
import { RequirementExtractor } from '../primitives/requirement-extractor.js'
import { JudgeRunner } from '../primitives/judge-runner.js'
import { ContextCompressor } from '../primitives/context-compressor.js'
import { BlobStore } from '../primitives/blob-store.js'

describe('TraceEvaluation - F-08', () => {
  let requirementExtractor: RequirementExtractor
  let judgeRunner: JudgeRunner
  let contextCompressor: ContextCompressor
  let blobStore: BlobStore
  let traceEvaluation: TraceEvaluation
  let mockModelAdapter: ModelAdapter

  beforeEach(() => {
    // Mock ModelAdapter
    mockModelAdapter = {
      call: async (prompt: string) => {
        return `\`\`\`json
{
  "verdict": true,
  "numeric_score": 0.85,
  "gap": 0.15,
  "severity": "low",
  "reasoning": "Mock evaluation"
}
\`\`\``
      },
      getContextWindowSize: () => 100000,
      estimateTokens: (text: string) => Math.ceil(text.length / 4)
    }

    // Initialize dependencies
    requirementExtractor = new RequirementExtractor()
    judgeRunner = new JudgeRunner(mockModelAdapter)
    contextCompressor = new ContextCompressor(mockModelAdapter)
    blobStore = new BlobStore()

    // Initialize TraceEvaluation
    traceEvaluation = new TraceEvaluation(
      requirementExtractor,
      judgeRunner,
      contextCompressor,
      blobStore
    )
  })

  describe('Test 1: Phase 1 runs before Phase 2', () => {
    it('should execute coverage check before LLM judge calls', async () => {
      const callOrder: string[] = []

      // Track call order
      const originalCheckCoverage = requirementExtractor.checkCoverage.bind(requirementExtractor)
      requirementExtractor.checkCoverage = (map, nodes) => {
        callOrder.push('phase1')
        return originalCheckCoverage(map, nodes)
      }

      const originalRun = judgeRunner.run.bind(judgeRunner)
      judgeRunner.run = async (dimension, context) => {
        callOrder.push('phase2')
        return originalRun(dimension, context)
      }

      const requirementMap: RequirementMap = new Map([
        ['req1', { id: 'req1', description: 'Test requirement', priority: 'high', coverage_score: 0 }]
      ])

      const agentNodes: AgentNode[] = [
        { node_id: 'node1', requirements_covered: ['req1'], output: 'Test output' }
      ]

      await traceEvaluation.evaluate({
        run_id: 'run1',
        requirement_map: requirementMap,
        agent_nodes: agentNodes,
        dependency_graph: { nodes: ['node1'], edges: [], run_id: 'run1' },
        sec_final_state: [],
        early_termination: false,
        token_budget: 10000,
        max_escalated_output_tokens: 500
      })

      expect(callOrder[0]).toBe('phase1')
      expect(callOrder.indexOf('phase2')).toBeGreaterThan(0)
    })
  })

  describe('Test 2: SEC final state and DependencyGraph included in Phase 2 input', () => {
    it('should include SEC and DependencyGraph in judge context', async () => {
      let capturedContext: string = ''

      mockModelAdapter.call = async (prompt: string) => {
        capturedContext = prompt
        return `\`\`\`json
{"verdict": true, "numeric_score": 0.9, "gap": 0.1, "severity": "low", "reasoning": "test"}
\`\`\``
      }

      const requirementMap: RequirementMap = new Map([
        ['req1', { id: 'req1', description: 'Test', priority: 'high', coverage_score: 0 }]
      ])

      const agentNodes: AgentNode[] = [
        { node_id: 'node1', requirements_covered: ['req1'], output: 'Test output' }
      ]

      const secFinalState: SECEntry[] = [
        { key: 'key1', value: 'value1', version_id: 1, run_id: 'run1' }
      ]

      const dependencyGraph: DependencyGraph = {
        nodes: ['node1', 'node2'],
        edges: [{
          from_node_id: 'node1',
          to_node_id: 'node2',
          edge_type: 'data',
          timeout_ms: null,
          on_timeout: null
        }],
        run_id: 'run1'
      }

      await traceEvaluation.evaluate({
        run_id: 'run1',
        requirement_map: requirementMap,
        agent_nodes: agentNodes,
        dependency_graph: dependencyGraph,
        sec_final_state: secFinalState,
        early_termination: false,
        token_budget: 10000,
        max_escalated_output_tokens: 500
      })

      expect(capturedContext).toContain('key1')
      expect(capturedContext).toContain('value1')
      expect(capturedContext).toContain('node1')
      expect(capturedContext).toContain('node2')
    })
  })

  describe('Test 3: Priority ordering applied when token budget exceeded', () => {
    it('should apply priority ordering when budget is low', async () => {
      let capturedContext: string = ''

      mockModelAdapter.call = async (prompt: string) => {
        capturedContext = prompt
        return `\`\`\`json
{"verdict": true, "numeric_score": 0.8, "gap": 0.2, "severity": "low", "reasoning": "test"}
\`\`\``
      }

      mockModelAdapter.estimateTokens = (text: string) => Math.ceil(text.length / 4)

      const requirementMap: RequirementMap = new Map([
        ['req1', { id: 'req1', description: 'Critical req', priority: 'high', coverage_score: 0 }]
      ])

      const agentNodes: AgentNode[] = [
        {
          node_id: 'escalated_critical',
          requirements_covered: ['req1'],
          output: 'A'.repeat(1000),
          is_escalated: true
        },
        {
          node_id: 'normal',
          requirements_covered: [],
          output: 'B'.repeat(1000)
        }
      ]

      await traceEvaluation.evaluate({
        run_id: 'run1',
        requirement_map: requirementMap,
        agent_nodes: agentNodes,
        dependency_graph: {
          nodes: ['escalated_critical', 'normal'],
          edges: [],
          run_id: 'run1'
        },
        sec_final_state: [],
        early_termination: false,
        token_budget: 500, // Low budget
        max_escalated_output_tokens: 500
      })

      // Escalated critical path should be included, normal might be truncated
      expect(capturedContext).toContain('AAAA') // Part of escalated output
    })
  })

  describe('Test 4: Blob DataRef pointers always included', () => {
    it('should always include DataRef pointers even with low budget', async () => {
      let capturedContext: string = ''

      mockModelAdapter.call = async (prompt: string) => {
        capturedContext = prompt
        return `\`\`\`json
{"verdict": true, "numeric_score": 0.8, "gap": 0.2, "severity": "low", "reasoning": "test"}
\`\`\``
      }

      const dataRef: DataRef = {
        ref_id: 'blob-123',
        schema: 'test-schema',
        size_bytes: 1000
      }

      const requirementMap: RequirementMap = new Map([
        ['req1', { id: 'req1', description: 'Test', priority: 'high', coverage_score: 0 }]
      ])

      const agentNodes: AgentNode[] = [
        {
          node_id: 'node1',
          requirements_covered: ['req1'],
          output: 'A'.repeat(5000),
          data_refs: [dataRef]
        }
      ]

      await traceEvaluation.evaluate({
        run_id: 'run1',
        requirement_map: requirementMap,
        agent_nodes: agentNodes,
        dependency_graph: { nodes: ['node1'], edges: [], run_id: 'run1' },
        sec_final_state: [],
        early_termination: false,
        token_budget: 100, // Very low budget
        max_escalated_output_tokens: 500
      })

      // DataRef pointer should be included
      expect(capturedContext).toContain('blob-123')
    })
  })

  describe('Test 5: Trace failure triggers Outer Loop', () => {
    it('should emit failure and set outer_loop_trigger on Phase 2 failure', async () => {
      mockModelAdapter.call = async () => {
        throw new Error('Judge call failed')
      }

      const requirementMap: RequirementMap = new Map([
        ['req1', { id: 'req1', description: 'Test', priority: 'high', coverage_score: 0 }]
      ])

      const agentNodes: AgentNode[] = [
        { node_id: 'node1', requirements_covered: ['req1'], output: 'Test' }
      ]

      const result = await traceEvaluation.evaluate({
        run_id: 'run1',
        requirement_map: requirementMap,
        agent_nodes: agentNodes,
        dependency_graph: { nodes: ['node1'], edges: [], run_id: 'run1' },
        sec_final_state: [],
        early_termination: false,
        token_budget: 10000,
        max_escalated_output_tokens: 500
      })

      expect(result.success).toBe(false)
      expect(result.outer_loop_trigger).toBe(true)
      expect(result.failure_reason).toContain('Judge call failed')
    })
  })

  describe('Test 6: Trace eval dimensions with correct weights', () => {
    it('should use 4 dimensions with correct weights', async () => {
      let capturedDimensions: Dimension[] = []

      const originalRunMerged = judgeRunner.runMerged.bind(judgeRunner)
      judgeRunner.runMerged = async (dimensions: Dimension[], context: JudgeContext) => {
        capturedDimensions = dimensions
        return originalRunMerged(dimensions, context)
      }

      const requirementMap: RequirementMap = new Map([
        ['req1', { id: 'req1', description: 'Test', priority: 'high', coverage_score: 0 }]
      ])

      const agentNodes: AgentNode[] = [
        { node_id: 'node1', requirements_covered: ['req1'], output: 'Test' }
      ]

      await traceEvaluation.evaluate({
        run_id: 'run1',
        requirement_map: requirementMap,
        agent_nodes: agentNodes,
        dependency_graph: { nodes: ['node1'], edges: [], run_id: 'run1' },
        sec_final_state: [],
        early_termination: false,
        token_budget: 10000,
        max_escalated_output_tokens: 500
      })

      expect(capturedDimensions).toHaveLength(4)

      const dimMap = new Map(capturedDimensions.map(d => [d.dimension_id, d.weight]))
      expect(dimMap.get('objective_fulfillment')).toBe(0.40)
      expect(dimMap.get('coverage_completeness')).toBe(0.35)
      expect(dimMap.get('coherence')).toBe(0.15)
      expect(dimMap.get('dependency_integrity')).toBe(0.10)

      // Verify weights sum to 1.0
      const totalWeight = capturedDimensions.reduce((sum, d) => sum + d.weight, 0)
      expect(totalWeight).toBeCloseTo(1.0)
    })
  })

  describe('Test 7: Input priority ordering detailed', () => {
    it('should follow exact priority ordering rules', async () => {
      let capturedContext: string = ''

      mockModelAdapter.call = async (prompt: string) => {
        capturedContext = prompt
        return `\`\`\`json
{"verdict": true, "numeric_score": 0.8, "gap": 0.2, "severity": "low", "reasoning": "test"}
\`\`\``
      }

      const requirementMap: RequirementMap = new Map([
        ['req1', { id: 'req1', description: 'Test req 1', priority: 'high', coverage_score: 0 }],
        ['req2', { id: 'req2', description: 'Test req 2', priority: 'medium', coverage_score: 0 }],
        ['req3', { id: 'req3', description: 'Uncovered req', priority: 'medium', coverage_score: 0 }]
      ])

      const agentNodes: AgentNode[] = [
        {
          node_id: 'node1',
          requirements_covered: ['req1'],
          output: 'Escalated critical path output',
          is_escalated: true
        },
        {
          node_id: 'node2',
          requirements_covered: ['req2'],
          output: 'Normal output'
        },
        {
          node_id: 'node3',
          requirements_covered: ['req3'], // This req will be uncovered in Phase 1
          output: 'Contested requirement output'
        }
      ]

      const secFinalState: SECEntry[] = [
        { key: 'test_key', value: 'test_value', version_id: 1, run_id: 'run1' }
      ]

      await traceEvaluation.evaluate({
        run_id: 'run1',
        requirement_map: requirementMap,
        agent_nodes: agentNodes,
        dependency_graph: {
          nodes: ['node1', 'node2'],
          edges: [{
            from_node_id: 'node1',
            to_node_id: 'node2',
            edge_type: 'data',
            timeout_ms: null,
            on_timeout: null
          }],
          run_id: 'run1'
        },
        sec_final_state: secFinalState,
        early_termination: false,
        token_budget: 10000,
        max_escalated_output_tokens: 500
      })

      // Verify RequirementMap included
      expect(capturedContext).toContain('req1')
      expect(capturedContext).toContain('req2')

      // Verify SEC summary included
      expect(capturedContext).toContain('test_key')

      // Verify escalated output included
      expect(capturedContext).toContain('Escalated critical path output')

      // Verify node outputs included (either as contested or chunk summaries)
      // Note: "Contested" means nodes covering uncovered requirements
      // In this test, all requirements are covered, so it will be in ChunkSummaries
      expect(capturedContext).toContain('node3')
    })
  })

  describe('Test 8: Weighted score aggregation', () => {
    it('should calculate correct weighted score', async () => {
      // Mock specific scores for each dimension
      const dimensionScores = new Map([
        ['objective_fulfillment', 0.9],
        ['coverage_completeness', 0.8],
        ['coherence', 0.7],
        ['dependency_integrity', 0.6]
      ])

      mockModelAdapter.call = async (prompt: string) => {
        // Extract dimension being evaluated from prompt
        let dimension_id = 'objective_fulfillment'
        if (prompt.includes('coverage_completeness')) dimension_id = 'coverage_completeness'
        else if (prompt.includes('coherence')) dimension_id = 'coherence'
        else if (prompt.includes('dependency_integrity')) dimension_id = 'dependency_integrity'

        const score = dimensionScores.get(dimension_id) || 0.5

        return `\`\`\`json
{"verdict": true, "numeric_score": ${score}, "gap": ${1 - score}, "severity": "low", "reasoning": "test"}
\`\`\``
      }

      const requirementMap: RequirementMap = new Map([
        ['req1', { id: 'req1', description: 'Test', priority: 'high', coverage_score: 0 }]
      ])

      const agentNodes: AgentNode[] = [
        { node_id: 'node1', requirements_covered: ['req1'], output: 'Test' }
      ]

      const result = await traceEvaluation.evaluate({
        run_id: 'run1',
        requirement_map: requirementMap,
        agent_nodes: agentNodes,
        dependency_graph: { nodes: ['node1'], edges: [], run_id: 'run1' },
        sec_final_state: [],
        early_termination: false,
        token_budget: 10000,
        max_escalated_output_tokens: 500
      })

      // Expected: (0.40 * 0.9) + (0.35 * 0.8) + (0.15 * 0.7) + (0.10 * 0.6)
      // = 0.36 + 0.28 + 0.105 + 0.06 = 0.805
      expect(result.phase2.weighted_score).toBeCloseTo(0.805, 2)
    })
  })

  describe('Test 9: High-priority requirement guard', () => {
    it('should fail if high-priority requirement uncovered', async () => {
      const requirementMap: RequirementMap = new Map([
        ['req1', { id: 'req1', description: 'High priority req', priority: 'high', coverage_score: 0 }],
        ['req2', { id: 'req2', description: 'Medium priority req', priority: 'medium', coverage_score: 0 }]
      ])

      // Only req2 covered, req1 (high priority) uncovered
      const agentNodes: AgentNode[] = [
        { node_id: 'node1', requirements_covered: ['req2'], output: 'Test' }
      ]

      const result = await traceEvaluation.evaluate({
        run_id: 'run1',
        requirement_map: requirementMap,
        agent_nodes: agentNodes,
        dependency_graph: { nodes: ['node1'], edges: [], run_id: 'run1' },
        sec_final_state: [],
        early_termination: false,
        token_budget: 10000,
        max_escalated_output_tokens: 500
      })

      // Confidence should be 0 due to high-priority guard
      expect(result.phase1.confidence).toBe(0)
      expect(result.phase1.coverage_status.uncovered_ids).toContain('req1')
    })
  })

  describe('Test 10: Empty/minimal input handling', () => {
    it('should handle empty agent_nodes gracefully', async () => {
      const requirementMap: RequirementMap = new Map([
        ['req1', { id: 'req1', description: 'Test', priority: 'high', coverage_score: 0 }]
      ])

      const result = await traceEvaluation.evaluate({
        run_id: 'run1',
        requirement_map: requirementMap,
        agent_nodes: [],
        dependency_graph: { nodes: [], edges: [], run_id: 'run1' },
        sec_final_state: [],
        early_termination: false,
        token_budget: 10000,
        max_escalated_output_tokens: 500
      })

      expect(result.success).toBe(true)
      expect(result.phase1.coverage_status.covered_count).toBe(0)
      expect(result.phase1.confidence).toBe(0)
      // Phase 2 should still run
      expect(result.phase2.weighted_score).toBeGreaterThanOrEqual(0)
    })
  })
})
