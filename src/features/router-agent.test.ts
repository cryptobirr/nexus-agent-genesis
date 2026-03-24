import { describe, it, expect, beforeEach } from 'vitest'
import { RouterAgent } from './router-agent.js'
import { RequirementExtractor } from '../primitives/requirement-extractor.js'
import { PlanCache } from '../primitives/plan-cache.js'
import { EmbeddingEngine } from '../primitives/embedding-engine.js'
import { DependencyGraphManager } from '../components/dependency-graph-manager.js'
import { PlanValidator } from '../components/plan-validator.js'
import { EvalPipeline } from '../components/eval-pipeline.js'
import { MessageBus } from '../primitives/message-bus.js'
import { TicketSystem } from '../primitives/ticket-system.js'
import { ContractRegistry } from '../primitives/contract-registry.js'
import { DeterministicPreCheck } from '../primitives/deterministic-precheck.js'
import { FailureClassifier } from '../primitives/failure-classifier.js'
import { JudgeRunner } from '../primitives/judge-runner.js'
import { OutputNormalizer } from '../primitives/output-normalizer.js'
import type { ModelAdapter, RouterConfig, RouterOutput } from '../primitives/types.js'

/**
 * Mock ModelAdapter for testing
 * Returns predefined Router output JSON
 */
class MockModelAdapter implements ModelAdapter {
  private responses: Map<string, string> = new Map()
  public callCount = 0

  setResponse(key: string, response: string) {
    this.responses.set(key, response)
  }

  async call(prompt: string): Promise<string> {
    this.callCount++
    // Return response based on prompt content
    for (const [key, response] of this.responses.entries()) {
      if (prompt.includes(key)) {
        return response
      }
    }
    // Default valid response
    return JSON.stringify({
      routing: 'plan',
      depth_hint: 2,
      complexity_classification: 'moderate',
      rationale: 'Multi-step task requiring coordination',
      objective_refined: 'Build authentication system with OAuth2',
      constraints: ['Budget: 1000 tokens', 'Max depth: 3'],
      requirements: [
        { id: 'req-1', description: 'Implement OAuth2 flow', priority: 'high' },
        { id: 'req-2', description: 'Add token validation', priority: 'medium' },
        { id: 'req-3', description: 'Create user session store', priority: 'medium' }
      ],
      dependencies: {
        run_id: 'test-run',
        nodes: ['router', 'planner-1', 'executor-1'],
        edges: [
          { from_node_id: 'router', to_node_id: 'planner-1', edge_type: 'control', timeout_ms: null, on_timeout: null }
        ]
      },
      plan_cost_estimate: 500
    })
  }

  getContextWindowSize(): number {
    return 100000
  }

  estimateTokens(text: string): number {
    return Math.ceil(text.length / 4)
  }
}

describe('RouterAgent', () => {
  let routerAgent: RouterAgent
  let mockModelAdapter: MockModelAdapter
  let requirementExtractor: RequirementExtractor
  let planCache: PlanCache
  let embeddingEngine: EmbeddingEngine
  let dependencyGraphManager: DependencyGraphManager
  let planValidator: PlanValidator
  let evalPipeline: EvalPipeline
  let messageBus: MessageBus
  let ticketSystem: TicketSystem
  let contractRegistry: ContractRegistry

  beforeEach(() => {
    // Initialize all dependencies
    mockModelAdapter = new MockModelAdapter()
    requirementExtractor = new RequirementExtractor()
    embeddingEngine = new EmbeddingEngine()
    planCache = new PlanCache(embeddingEngine, 0.90)
    messageBus = new MessageBus()
    ticketSystem = new TicketSystem(messageBus)
    dependencyGraphManager = new DependencyGraphManager(messageBus, ticketSystem)
    contractRegistry = new ContractRegistry()

    // Register Router contract
    contractRegistry.register({
      agent_type: 'router',
      dimensions: [
        { dimension_id: 'complexity_classification', weight: 0.45, is_binary: false, gate: 1 },
        { dimension_id: 'scope_coverage', weight: 0.35, is_binary: true, gate: 1 },
        { dimension_id: 'dependency_correctness', weight: 0.20, is_binary: false, gate: 2 }
      ]
    })

    planValidator = new PlanValidator(
      dependencyGraphManager,
      requirementExtractor,
      contractRegistry
    )

    const preCheck = new DeterministicPreCheck()
    const failureClassifier = new FailureClassifier()
    const judgeRunner = new JudgeRunner(mockModelAdapter)
    const outputNormalizer = new OutputNormalizer()

    evalPipeline = new EvalPipeline(
      outputNormalizer,
      preCheck,
      failureClassifier,
      judgeRunner,
      contractRegistry
    )

    routerAgent = new RouterAgent(
      requirementExtractor,
      planCache,
      dependencyGraphManager,
      planValidator,
      evalPipeline,
      embeddingEngine,
      messageBus,
      mockModelAdapter
    )
  })

  describe('Basic Output Structure', () => {
    it('should return RouterOutput with all 9 required fields', async () => {
      const config: RouterConfig = {
        run_id: 'test-run-1',
        run_config_hash: 'hash-123',
        embedding_model_id: 'text-embedding-ada-002',
        objective: 'Build user authentication system'
      }

      const output = await routerAgent.route(config)

      expect(output).toBeDefined()
      expect(output.routing).toBeDefined()
      expect(output.depth_hint).toBeDefined()
      expect(output.complexity_classification).toBeDefined()
      expect(output.rationale).toBeDefined()
      expect(output.objective_refined).toBeDefined()
      expect(output.constraints).toBeDefined()
      expect(output.requirements).toBeDefined()
      expect(output.dependencies).toBeDefined()
      expect(output.plan_cost_estimate).toBeDefined()
    })

    it('should have complexity_classification as one of: atomic, simple, moderate, complex', async () => {
      const config: RouterConfig = {
        run_id: 'test-run-2',
        run_config_hash: 'hash-456',
        embedding_model_id: 'text-embedding-ada-002',
        objective: 'Print hello world'
      }

      const output = await routerAgent.route(config)

      expect(['atomic', 'simple', 'moderate', 'complex']).toContain(output.complexity_classification)
    })

    it('should have 3-7 requirements', async () => {
      const config: RouterConfig = {
        run_id: 'test-run-3',
        run_config_hash: 'hash-789',
        embedding_model_id: 'text-embedding-ada-002',
        objective: 'Build REST API with CRUD operations'
      }

      const output = await routerAgent.route(config)

      expect(output.requirements.length).toBeGreaterThanOrEqual(3)
      expect(output.requirements.length).toBeLessThanOrEqual(7)
    })

    it('should have non-negative depth_hint', async () => {
      const config: RouterConfig = {
        run_id: 'test-run-4',
        run_config_hash: 'hash-abc',
        embedding_model_id: 'text-embedding-ada-002',
        objective: 'Implement caching layer'
      }

      const output = await routerAgent.route(config)

      expect(output.depth_hint).toBeGreaterThanOrEqual(0)
      expect(Number.isInteger(output.depth_hint)).toBe(true)
    })
  })

  describe('PlanCache Integration', () => {
    it('should return cached output on cache hit (no LLM call)', async () => {
      const config: RouterConfig = {
        run_id: 'test-run-5',
        run_config_hash: 'hash-def',
        embedding_model_id: 'text-embedding-ada-002',
        objective: 'Build user profile page'
      }

      // First call: cache miss, generates output
      const firstOutput = await routerAgent.route(config)
      const firstCallCount = mockModelAdapter.callCount

      // Second call: cache hit, returns cached output
      const secondOutput = await routerAgent.route(config)
      const secondCallCount = mockModelAdapter.callCount

      // Should not make additional LLM call
      expect(secondCallCount).toBe(firstCallCount)

      // Should return same output
      expect(secondOutput.routing).toBe(firstOutput.routing)
      expect(secondOutput.complexity_classification).toBe(firstOutput.complexity_classification)
    })

    it('should generate new output on cache miss', async () => {
      const config1: RouterConfig = {
        run_id: 'test-run-6',
        run_config_hash: 'hash-ghi',
        embedding_model_id: 'text-embedding-ada-002',
        objective: 'Build dashboard'
      }

      const config2: RouterConfig = {
        run_id: 'test-run-7',
        run_config_hash: 'hash-ghi',
        embedding_model_id: 'text-embedding-ada-002',
        objective: 'Build completely different feature with no similarity'
      }

      const firstCallCount = mockModelAdapter.callCount
      await routerAgent.route(config1)
      const afterFirstCall = mockModelAdapter.callCount

      await routerAgent.route(config2)
      const afterSecondCall = mockModelAdapter.callCount

      // Both should make LLM calls (different objectives)
      expect(afterFirstCall).toBeGreaterThan(firstCallCount)
      expect(afterSecondCall).toBeGreaterThan(afterFirstCall)
    })

    it('should treat config hash mismatch as cache miss', async () => {
      const config1: RouterConfig = {
        run_id: 'test-run-8',
        run_config_hash: 'hash-jkl',
        embedding_model_id: 'text-embedding-ada-002',
        objective: 'Build API endpoint'
      }

      const config2: RouterConfig = {
        run_id: 'test-run-9',
        run_config_hash: 'hash-mno',  // Different config hash
        embedding_model_id: 'text-embedding-ada-002',
        objective: 'Build API endpoint'  // Same objective
      }

      const firstCallCount = mockModelAdapter.callCount
      await routerAgent.route(config1)
      const afterFirstCall = mockModelAdapter.callCount

      await routerAgent.route(config2)
      const afterSecondCall = mockModelAdapter.callCount

      // Should make LLM calls for both (config hash mismatch)
      expect(afterFirstCall).toBeGreaterThan(firstCallCount)
      expect(afterSecondCall).toBeGreaterThan(afterFirstCall)
    })
  })

  describe('PlanValidator Integration', () => {
    it('should throw error on fatal PLAN VALIDATOR failure', async () => {
      // Mock invalid response with cycle in dependency graph
      mockModelAdapter.setResponse('invalid-cycle', JSON.stringify({
        routing: 'plan',
        depth_hint: 2,
        complexity_classification: 'moderate',
        rationale: 'Test',
        objective_refined: 'Test',
        constraints: [],
        requirements: [
          { id: 'req-1', description: 'Test 1', priority: 'high' },
          { id: 'req-2', description: 'Test 2', priority: 'medium' },
          { id: 'req-3', description: 'Test 3', priority: 'low' }
        ],
        dependencies: {
          run_id: 'test-run',
          nodes: ['node-1', 'node-2'],
          edges: [
            { from_node_id: 'node-1', to_node_id: 'node-2', edge_type: 'data', timeout_ms: null, on_timeout: null },
            { from_node_id: 'node-2', to_node_id: 'node-1', edge_type: 'data', timeout_ms: null, on_timeout: null }  // Cycle!
          ]
        },
        plan_cost_estimate: 500
      }))

      const config: RouterConfig = {
        run_id: 'test-run-10',
        run_config_hash: 'hash-pqr',
        embedding_model_id: 'text-embedding-ada-002',
        objective: 'invalid-cycle test'
      }

      await expect(routerAgent.route(config)).rejects.toThrow()
    })

    it('should retry once on fixable PLAN VALIDATOR failure', async () => {
      // Use mock adapter that alternates responses
      let callCount = 0
      const customMock = {
        callCount: 0,
        async call(prompt: string): Promise<string> {
          customMock.callCount++
          callCount++

          // First call: fixable failure (cost exceeded)
          if (callCount === 1) {
            return JSON.stringify({
              routing: 'plan',
              depth_hint: 2,
              complexity_classification: 'moderate',
              rationale: 'Test',
              objective_refined: 'Test',
              constraints: [],
              requirements: [
                { id: 'req-1', description: 'Test 1', priority: 'high' },
                { id: 'req-2', description: 'Test 2', priority: 'medium' },
                { id: 'req-3', description: 'Test 3', priority: 'low' }
              ],
              dependencies: {
                run_id: 'test-run',
                nodes: ['node-1'],
                edges: []
              },
              plan_cost_estimate: 1100  // Exceeds default 1000 but within tolerance
            })
          }

          // Second call (retry): valid response
          return JSON.stringify({
            routing: 'plan',
            depth_hint: 2,
            complexity_classification: 'moderate',
            rationale: 'Test',
            objective_refined: 'Test',
            constraints: [],
            requirements: [
              { id: 'req-1', description: 'Test 1', priority: 'high' },
              { id: 'req-2', description: 'Test 2', priority: 'medium' },
              { id: 'req-3', description: 'Test 3', priority: 'low' }
            ],
            dependencies: {
              run_id: 'test-run',
              nodes: ['node-1'],
              edges: []
            },
            plan_cost_estimate: 900  // Within limits
          })
        },
        getContextWindowSize(): number {
          return 100000
        },
        estimateTokens(text: string): number {
          return Math.ceil(text.length / 4)
        }
      } as ModelAdapter

      // Create new RouterAgent with custom mock
      const retryRouterAgent = new RouterAgent(
        requirementExtractor,
        planCache,
        dependencyGraphManager,
        planValidator,
        evalPipeline,
        embeddingEngine,
        messageBus,
        customMock
      )

      const config: RouterConfig = {
        run_id: 'test-run-11',
        run_config_hash: 'hash-stu',
        embedding_model_id: 'text-embedding-ada-002',
        max_retries: 1,
        objective: 'retry-test objective for fixable failure'
      }

      const output = await retryRouterAgent.route(config)

      // Should have made 2 LLM calls (initial + 1 retry)
      expect(customMock.callCount).toBe(2)

      // Final output should be valid
      expect(output.plan_cost_estimate).toBe(900)
    })
  })

  describe('RequirementExtractor Integration', () => {
    it('should extract requirements into RequirementMap', async () => {
      const config: RouterConfig = {
        run_id: 'test-run-12',
        run_config_hash: 'hash-vwx',
        embedding_model_id: 'text-embedding-ada-002',
        objective: 'Build notification system'
      }

      const output = await routerAgent.route(config)

      // Requirements should be valid RequirementRecords
      for (const req of output.requirements) {
        expect(req.id).toBeDefined()
        expect(req.description).toBeDefined()
        expect(req.priority).toBeDefined()
        expect(['high', 'medium', 'low']).toContain(req.priority)
      }
    })

    it('should enforce 3-7 requirements constraint', async () => {
      // Mock response with too few requirements
      mockModelAdapter.setResponse('too-few', JSON.stringify({
        routing: 'plan',
        depth_hint: 1,
        complexity_classification: 'simple',
        rationale: 'Test',
        objective_refined: 'Test',
        constraints: [],
        requirements: [
          { id: 'req-1', description: 'Only one requirement', priority: 'high' }
        ],
        dependencies: {
          run_id: 'test-run',
          nodes: ['node-1'],
          edges: []
        },
        plan_cost_estimate: 100
      }))

      const config: RouterConfig = {
        run_id: 'test-run-13',
        run_config_hash: 'hash-yz',
        embedding_model_id: 'text-embedding-ada-002',
        objective: 'too-few requirements test'
      }

      await expect(routerAgent.route(config)).rejects.toThrow()
    })
  })

  describe('DependencyGraph Validation', () => {
    it('should validate dependency graph structure', async () => {
      const config: RouterConfig = {
        run_id: 'test-run-14',
        run_config_hash: 'hash-123',
        embedding_model_id: 'text-embedding-ada-002',
        objective: 'Build data pipeline'
      }

      const output = await routerAgent.route(config)

      expect(output.dependencies).toBeDefined()
      expect(output.dependencies.run_id).toBe(config.run_id)
      expect(Array.isArray(output.dependencies.nodes)).toBe(true)
      expect(Array.isArray(output.dependencies.edges)).toBe(true)
    })
  })
})
