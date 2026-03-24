import { describe, it, expect, beforeEach, vi } from 'vitest'
import { EvalPipeline } from './eval-pipeline.js'
import { OutputNormalizer } from '../primitives/output-normalizer.js'
import { DeterministicPreCheck } from '../primitives/deterministic-precheck.js'
import { FailureClassifier } from '../primitives/failure-classifier.js'
import { JudgeRunner } from '../primitives/judge-runner.js'
import { ContractRegistry } from '../primitives/contract-registry.js'
import type {
  AgentType,
  OutputSpec,
  FailedStrategy,
  ModelAdapter,
  Signal,
  Dimension,
  Contract
} from '../primitives/types.js'

describe('EvalPipeline - C-06', () => {
  let outputNormalizer: OutputNormalizer
  let preCheck: DeterministicPreCheck
  let failureClassifier: FailureClassifier
  let judgeRunner: JudgeRunner
  let contractRegistry: ContractRegistry
  let modelAdapter: ModelAdapter
  let evalPipeline: EvalPipeline

  beforeEach(() => {
    outputNormalizer = new OutputNormalizer()
    preCheck = new DeterministicPreCheck()
    failureClassifier = new FailureClassifier()
    modelAdapter = createMockModelAdapter()
    judgeRunner = new JudgeRunner(modelAdapter)
    contractRegistry = new ContractRegistry()

    evalPipeline = new EvalPipeline(
      outputNormalizer,
      preCheck,
      failureClassifier,
      judgeRunner,
      contractRegistry
    )

    // Register default contracts
    registerDefaultContracts(contractRegistry)
  })

  describe('1. Normalization Stage', () => {
    it('1.1: normalization failure → returns schema_failure, precheck NOT called', async () => {
      // Mock normalization failure
      vi.spyOn(outputNormalizer, 'normalize').mockReturnValue({
        normalized_output: {},
        passed: false,
        failure_reason: 'schema_failure'
      })
      vi.spyOn(preCheck, 'run')

      const result = await evalPipeline.evaluate({
        agent_type: 'router',
        agent_output: { invalid: 'output' },
        output_spec: createMockOutputSpec(),
        attempt: 1,
        failed_strategies: [],
        run_id: 'run_1'
      })

      expect(result.passed).toBe(false)
      expect(result.gate_reached).toBe('normalization')
      expect(result.failure_type).toBe('schema_failure')
      expect(preCheck.run).not.toHaveBeenCalled()
    })

    it('1.2: no output_spec → skip normalization, proceed to precheck', async () => {
      vi.spyOn(outputNormalizer, 'normalize')
      vi.spyOn(preCheck, 'run').mockReturnValue({ passed: true, violations: [] })

      const output = { routing: 'plan', requirements: ['req1'] }
      await evalPipeline.evaluate({
        agent_type: 'router',
        agent_output: output,
        attempt: 1,
        failed_strategies: [],
        run_id: 'run_1'
      })

      expect(outputNormalizer.normalize).not.toHaveBeenCalled()
      expect(preCheck.run).toHaveBeenCalledWith('router', output)
    })

    it('1.3: normalization passes → normalized_output returned, proceed to precheck', async () => {
      const normalizedOutput = { routing: 'plan', requirements: ['req1'] }
      vi.spyOn(outputNormalizer, 'normalize').mockReturnValue({
        normalized_output: normalizedOutput,
        passed: true,
        failure_reason: null
      })
      vi.spyOn(preCheck, 'run').mockReturnValue({ passed: true, violations: [] })

      const result = await evalPipeline.evaluate({
        agent_type: 'router',
        agent_output: { raw: 'output' },
        output_spec: createMockOutputSpec(),
        attempt: 1,
        failed_strategies: [],
        run_id: 'run_1'
      })

      expect(result.normalized_output).toEqual(normalizedOutput)
      expect(preCheck.run).toHaveBeenCalledWith('router', normalizedOutput)
    })
  })

  describe('2. Precheck Stage', () => {
    it('2.1: precheck failure → FailureClassifier determines type, Gate 1 NOT called', async () => {
      vi.spyOn(preCheck, 'run').mockReturnValue({
        passed: false,
        violations: ['Router output missing required field: routing']
      })
      vi.spyOn(failureClassifier, 'classify').mockReturnValue('schema_failure')
      vi.spyOn(judgeRunner, 'run')

      const result = await evalPipeline.evaluate({
        agent_type: 'router',
        agent_output: { invalid: 'output' },
        attempt: 1,
        failed_strategies: [],
        run_id: 'run_1'
      })

      expect(result.passed).toBe(false)
      expect(result.gate_reached).toBe('precheck')
      expect(result.failure_type).toBe('schema_failure')
      expect(result.violations).toEqual(['Router output missing required field: routing'])
      expect(judgeRunner.run).not.toHaveBeenCalled()
    })

    it('2.2: precheck passes → proceed to Gate 1', async () => {
      vi.spyOn(preCheck, 'run').mockReturnValue({ passed: true, violations: [] })
      vi.spyOn(judgeRunner, 'run').mockResolvedValue(createPassingSignal())

      await evalPipeline.evaluate({
        agent_type: 'router',
        agent_output: { routing: 'plan', requirements: ['req1'] },
        attempt: 1,
        failed_strategies: [],
        run_id: 'run_1'
      })

      expect(judgeRunner.run).toHaveBeenCalled()
    })
  })

  describe('3. Gate 1 Evaluation', () => {
    it('3.1: Gate 1 ALL dimensions pass → proceed to Gate 2', async () => {
      vi.spyOn(preCheck, 'run').mockReturnValue({ passed: true, violations: [] })
      vi.spyOn(judgeRunner, 'run').mockResolvedValue({ ...createPassingSignal(), numeric_score: 0.75 })

      const result = await evalPipeline.evaluate({
        agent_type: 'router',
        agent_output: { routing: 'plan', requirements: ['req1'] },
        attempt: 1,
        failed_strategies: [],
        run_id: 'run_1'
      })

      expect(result.passed).toBe(true)
      expect(result.gate_reached).toBe(2)
      expect(result.gate1_signals).toBeDefined()
      expect(result.gate2_signals).toBeDefined()
    })

    it('3.2: Gate 1 ANY dimension fails + early_stop=true → skip Gate 2, return failure', async () => {
      vi.spyOn(preCheck, 'run').mockReturnValue({ passed: true, violations: [] })
      // First dimension passes, second fails (below threshold)
      vi.spyOn(judgeRunner, 'run')
        .mockResolvedValueOnce({ ...createPassingSignal(), numeric_score: 0.75 })
        .mockResolvedValueOnce({ ...createPassingSignal(), verdict: false, numeric_score: 0.65 })

      const result = await evalPipeline.evaluate({
        agent_type: 'router',
        agent_output: { routing: 'plan', requirements: ['req1'] },
        attempt: 1,
        failed_strategies: [],
        run_id: 'run_1'
      })

      expect(result.passed).toBe(false)
      expect(result.gate_reached).toBe(1)
      expect(result.gate2_signals).toBeUndefined()
    })

    it('3.3: Gate 1 fails + early_stop=false → proceed to Gate 2', async () => {
      vi.spyOn(preCheck, 'run').mockReturnValue({ passed: true, violations: [] })
      vi.spyOn(judgeRunner, 'run').mockResolvedValue({ ...createPassingSignal(), numeric_score: 0.65 })

      const result = await evalPipeline.evaluate({
        agent_type: 'router',
        agent_output: { routing: 'plan', requirements: ['req1'] },
        attempt: 1,
        failed_strategies: [],
        run_id: 'run_1',
        early_stop_on_gate1: false
      })

      expect(result.gate_reached).toBe(2)
      expect(result.gate1_signals).toBeDefined()
      expect(result.gate2_signals).toBeDefined()
    })

    it('3.4: Gate 1 thresholds: Router=70, Planner=75, Executor=80', async () => {
      vi.spyOn(preCheck, 'run').mockReturnValue({ passed: true, violations: [] })

      // Router threshold: 70 (0.70)
      vi.spyOn(judgeRunner, 'run').mockResolvedValue({ ...createPassingSignal(), numeric_score: 0.70 })
      let result = await evalPipeline.evaluate({
        agent_type: 'router',
        agent_output: { routing: 'plan', requirements: ['req1'] },
        attempt: 1,
        failed_strategies: [],
        run_id: 'run_1'
      })
      expect(result.passed).toBe(true)

      // Planner threshold: 75 (0.75)
      vi.spyOn(judgeRunner, 'run').mockResolvedValue({ ...createPassingSignal(), numeric_score: 0.75 })
      result = await evalPipeline.evaluate({
        agent_type: 'planner',
        agent_output: { decision: 'recurse', children: [{}], covers_requirements: true },
        attempt: 1,
        failed_strategies: [],
        run_id: 'run_1'
      })
      expect(result.passed).toBe(true)

      // Executor threshold: 80 (0.80)
      vi.spyOn(judgeRunner, 'run').mockResolvedValue({ ...createPassingSignal(), numeric_score: 0.80 })
      result = await evalPipeline.evaluate({
        agent_type: 'executor',
        agent_output: { status: 'complete', output: 'result' },
        attempt: 1,
        failed_strategies: [],
        run_id: 'run_1'
      })
      expect(result.passed).toBe(true)
    })
  })

  describe('4. Gate 2 Evaluation', () => {
    it('4.1: Gate 2 weighted score calculation correct', async () => {
      vi.spyOn(preCheck, 'run').mockReturnValue({ passed: true, violations: [] })

      // Gate 1: pass all
      vi.spyOn(judgeRunner, 'run')
        .mockResolvedValueOnce({ ...createPassingSignal(), numeric_score: 0.80 })

      // Gate 2: On attempt=1, only task_completion is evaluated (novelty auto-passed)
      // task_completion weight=0.6, novelty weight=0.4
      vi.spyOn(judgeRunner, 'runMerged').mockResolvedValue([
        { ...createPassingSignal(), numeric_score: 0.8 }  // task_completion: 0.6 * 0.8 = 0.48
      ])
      // novelty auto-passed: 0.4 * 1.0 = 0.40
      // Expected weighted score: 0.48 + 0.40 = 0.88

      const result = await evalPipeline.evaluate({
        agent_type: 'executor',
        agent_output: { status: 'complete', output: 'result' },
        attempt: 1,
        failed_strategies: [],
        run_id: 'run_1'
      })

      expect(result.gate2_weighted_score).toBeCloseTo(0.88, 2)
    })

    it('4.2: Gate 2 passes → return success', async () => {
      vi.spyOn(preCheck, 'run').mockReturnValue({ passed: true, violations: [] })
      vi.spyOn(judgeRunner, 'run').mockResolvedValue({ ...createPassingSignal(), numeric_score: 0.80 })
      // On attempt=1, only task_completion evaluated
      vi.spyOn(judgeRunner, 'runMerged').mockResolvedValue([
        { ...createPassingSignal(), numeric_score: 0.8 }
      ])

      const result = await evalPipeline.evaluate({
        agent_type: 'executor',
        agent_output: { status: 'complete', output: 'result' },
        attempt: 1,
        failed_strategies: [],
        run_id: 'run_1'
      })

      expect(result.passed).toBe(true)
      expect(result.gate_reached).toBe(2)
    })

    it('4.3: Gate 2 fails → return failure with weighted score', async () => {
      vi.spyOn(preCheck, 'run').mockReturnValue({ passed: true, violations: [] })
      // Gate 1 must pass for Gate 2 to run (merged mode calls runMerged for Gate 1)
      const runMergedSpy = vi.spyOn(judgeRunner, 'runMerged')
      // First call: Gate 1 (accuracy dimension)
      runMergedSpy.mockResolvedValueOnce([
        { ...createPassingSignal(), numeric_score: 0.80 }
      ])
      // Second call: Gate 2 (task_completion only, novelty auto-passed)
      runMergedSpy.mockResolvedValueOnce([
        { ...createPassingSignal(), numeric_score: 0.4 }
      ])
      // task_completion: 0.6 * 0.4 = 0.24
      // novelty (auto-pass): 0.4 * 1.0 = 0.40
      // Total: 0.64 < 0.70

      const result = await evalPipeline.evaluate({
        agent_type: 'executor',
        agent_output: { status: 'complete', output: 'result' },
        attempt: 1,
        failed_strategies: [],
        run_id: 'run_1'
      })

      expect(result.passed).toBe(false)
      expect(result.gate_reached).toBe(2)
      expect(result.gate2_weighted_score).toBeCloseTo(0.64, 2)
    })
  })

  describe('8. Novelty Handling', () => {
    it('8.1: Attempt 1 + novelty dimension → auto-pass (Judge NOT called)', async () => {
      vi.spyOn(preCheck, 'run').mockReturnValue({ passed: true, violations: [] })
      vi.spyOn(judgeRunner, 'run').mockResolvedValue({ ...createPassingSignal(), numeric_score: 0.80 })

      const judgeRunSpy = vi.spyOn(judgeRunner, 'runMerged')
      // Only task_completion evaluated, novelty auto-passed
      judgeRunSpy.mockResolvedValue([
        { ...createPassingSignal(), numeric_score: 0.8 }
      ])

      await evalPipeline.evaluate({
        agent_type: 'executor',
        agent_output: { status: 'complete', output: 'result' },
        attempt: 1, // First attempt
        failed_strategies: [],
        run_id: 'run_1'
      })

      // Novelty should be auto-passed without calling Judge
      // Check that novelty dimension was not evaluated
      const mergedCalls = judgeRunSpy.mock.calls[0]?.[0] || []
      expect(mergedCalls.every((d: Dimension) => d.dimension_id !== 'novelty')).toBe(true)
    })

    it('8.2: Attempt 2+ + novelty dimension → Judge called with failed_strategies context', async () => {
      vi.spyOn(preCheck, 'run').mockReturnValue({ passed: true, violations: [] })
      vi.spyOn(judgeRunner, 'run').mockResolvedValue({ ...createPassingSignal(), numeric_score: 0.80 })

      const judgeRunSpy = vi.spyOn(judgeRunner, 'runMerged')
      // On attempt 2+, both task_completion AND novelty are evaluated
      judgeRunSpy.mockResolvedValue([
        { ...createPassingSignal(), numeric_score: 0.8 },
        { ...createPassingSignal(), numeric_score: 0.8 }
      ])

      const failedStrategies: FailedStrategy[] = [
        {
          attempt: 1,
          failure_type: 'reasoning_failure',
          gate: 2,
          gap: 'Reasoning was insufficient',
          output: 'Previous attempt output'
        }
      ]

      await evalPipeline.evaluate({
        agent_type: 'executor',
        agent_output: { status: 'complete', output: 'new result' },
        attempt: 2, // Second attempt
        failed_strategies: failedStrategies,
        run_id: 'run_1'
      })

      // Novelty should be included in evaluation on attempt 2+
      expect(judgeRunSpy).toHaveBeenCalled()
    })
  })
})

// Helper functions

function createMockOutputSpec(): OutputSpec {
  return {
    type: 'json',
    schema: '{"type":"object"}',
    required_fields: [],
    max_tokens: 1000,
    max_normalization_bytes: 10000,
    normalization_mode: 'strict'
  }
}

function createPassingSignal(): Signal {
  return {
    verdict: true,
    numeric_score: 0.8,
    gap: 0.2,
    severity: 'low',
    reasoning: 'Output meets criteria'
  }
}

function createMockModelAdapter(): ModelAdapter {
  return {
    call: vi.fn().mockResolvedValue('```json\n{"verdict": true, "numeric_score": 0.8, "gap": 0.2, "severity": "low", "reasoning": "test"}\n```'),
    getContextWindowSize: vi.fn().mockReturnValue(8000),
    estimateTokens: vi.fn().mockImplementation((text: string) => Math.ceil(text.length / 4))
  }
}

function registerDefaultContracts(registry: ContractRegistry) {
  // Router contract: Gate 1 binary dimensions (2 dimensions for test 3.2)
  const routerContract: Contract = {
    agent_type: 'router',
    dimensions: [
      { dimension_id: 'scope_coverage', weight: 0.5, is_binary: true, gate: 1 },
      { dimension_id: 'dependency_correctness', weight: 0.5, is_binary: true, gate: 1 }
    ]
  }

  // Planner contract: Gate 1 binary dimension
  const plannerContract: Contract = {
    agent_type: 'planner',
    dimensions: [
      { dimension_id: 'termination_correctness', weight: 1.0, is_binary: true, gate: 1 }
    ]
  }

  // Executor contract: Gate 1 binary + Gate 2 weighted dimensions
  const executorContract: Contract = {
    agent_type: 'executor',
    dimensions: [
      { dimension_id: 'accuracy', weight: 1.0, is_binary: true, gate: 1 },
      { dimension_id: 'task_completion', weight: 0.6, is_binary: false, gate: 2 },
      { dimension_id: 'novelty', weight: 0.4, is_binary: false, gate: 2 }
    ]
  }

  registry.register(routerContract)
  registry.register(plannerContract)
  registry.register(executorContract)
}
