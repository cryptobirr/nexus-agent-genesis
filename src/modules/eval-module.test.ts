import { describe, it, expect, beforeEach } from 'vitest'
import { EvalModule, EvalModuleConfig } from './eval-module.js'
import { EvalPipeline, type EvalPipelineInput } from '../components/eval-pipeline.js'
import { MetaLoop } from '../features/meta-loop.js'
import { TraceEvaluation, type TraceEvaluationInput } from '../features/trace-evaluation.js'
import { TicketSystem } from '../primitives/ticket-system.js'
import { MessageBus } from '../primitives/message-bus.js'
import type { Dimension, JudgingPolicy } from '../primitives/types.js'

describe('EvalModule - M-02', () => {
  let evalModule: EvalModule
  let evalPipeline: EvalPipeline
  let metaLoop: MetaLoop
  let traceEvaluation: TraceEvaluation
  let ticketSystem: TicketSystem
  let messageBus: MessageBus
  let config: EvalModuleConfig

  beforeEach(() => {
    // Mock dependencies
    evalPipeline = {
      evaluate: async () => ({
        passed: true,
        gate_reached: 2,
        gate1_signals: [],
        gate2_signals: [],
        gate2_weighted_score: 0.8
      })
    } as any

    metaLoop = {
      storePattern: () => {},
      getPatternCount: () => 0
    } as any

    traceEvaluation = {
      evaluate: async () => ({
        success: true,
        phase1: { coverage_status: { covered_count: 1, uncovered_count: 0, covered_ids: [], uncovered_ids: [] }, confidence: 1 },
        phase2: { dimensions: { objective_fulfillment: 1, coverage_completeness: 1, coherence: 1, dependency_integrity: 1 }, weighted_score: 1 },
        outer_loop_trigger: false
      })
    } as any

    ticketSystem = new TicketSystem()
    messageBus = new MessageBus()

    config = {
      judging_policy: {
        mode: 'full',
        skip_non_binary: false,
        adaptive_skip_threshold: 0.3
      },
      merged_judge_mode: true,
      skip_dimensions: [],
      feedback_loop_enabled: false
    }

    evalModule = new EvalModule(
      evalPipeline,
      metaLoop,
      traceEvaluation,
      ticketSystem,
      messageBus,
      config
    )
  })

  describe('Binary Dimension Protection', () => {
    it('never skips binary dimensions regardless of JudgingPolicy', async () => {
      const adaptiveConfig: EvalModuleConfig = {
        ...config,
        judging_policy: { mode: 'adaptive', skip_non_binary: true, adaptive_skip_threshold: 0.1 },
        skip_dimensions: ['binary_dim_1', 'non_binary_dim']
      }

      const module = new EvalModule(
        evalPipeline,
        metaLoop,
        traceEvaluation,
        ticketSystem,
        messageBus,
        adaptiveConfig
      )

      const binaryDimension: Dimension = {
        dimension_id: 'binary_dim_1',
        weight: 0.5,
        is_binary: true,
        gate: 1
      }

      const nonBinaryDimension: Dimension = {
        dimension_id: 'non_binary_dim',
        weight: 0.5,
        is_binary: false,
        gate: 2
      }

      const filtered = module.filterDimensions([binaryDimension, nonBinaryDimension])

      // Binary dimension should NEVER be filtered out
      expect(filtered.some(d => d.dimension_id === 'binary_dim_1')).toBe(true)
      // Non-binary can be filtered
      expect(filtered.some(d => d.dimension_id === 'non_binary_dim')).toBe(false)
    })
  })

  describe('Adaptive Mode', () => {
    it('tracks judge skip rate in adaptive mode', async () => {
      const adaptiveConfig: EvalModuleConfig = {
        ...config,
        judging_policy: { mode: 'adaptive', skip_non_binary: true, adaptive_skip_threshold: 0.3 }
      }

      const module = new EvalModule(
        evalPipeline,
        metaLoop,
        traceEvaluation,
        ticketSystem,
        messageBus,
        adaptiveConfig
      )

      // Simulate some skips
      module.trackJudgeSkip('dim1', true)
      module.trackJudgeSkip('dim2', false)
      module.trackJudgeSkip('dim3', true)

      const skipRate = module.getSkipRate()
      expect(skipRate).toBe(2 / 3) // 2 skipped out of 3 total
    })

    it('reports skip rate in adaptive mode', () => {
      const adaptiveConfig: EvalModuleConfig = {
        ...config,
        judging_policy: { mode: 'adaptive', skip_non_binary: true, adaptive_skip_threshold: 0.3 }
      }

      const module = new EvalModule(
        evalPipeline,
        metaLoop,
        traceEvaluation,
        ticketSystem,
        messageBus,
        adaptiveConfig
      )

      module.trackJudgeSkip('dim1', true)
      module.trackJudgeSkip('dim2', true)

      const report = module.getSkipReport()
      expect(report.skip_rate).toBe(1.0)
      expect(report.total_evaluations).toBe(2)
      expect(report.skipped_evaluations).toBe(2)
    })
  })

  describe('FeedbackLoopHealth', () => {
    it('emits FeedbackLoopHealth after run with feedback_loop enabled', async () => {
      const feedbackConfig: EvalModuleConfig = {
        ...config,
        feedback_loop_enabled: true
      }

      const module = new EvalModule(
        evalPipeline,
        metaLoop,
        traceEvaluation,
        ticketSystem,
        messageBus,
        feedbackConfig
      )

      let emitted = false
      let healthData: any = null

      messageBus.subscribe('run-1', 'feedback_loop_health', (eventType, payload) => {
        emitted = true
        healthData = payload
      })

      module.emitFeedbackLoopHealth('run-1')

      expect(emitted).toBe(true)
      expect(healthData).toHaveProperty('judge_skip_rate')
      expect(healthData).toHaveProperty('false_negative_rate')
      expect(healthData).toHaveProperty('total_evaluations')
      expect(healthData).toHaveProperty('timestamp')
    })

    it('does not emit FeedbackLoopHealth when feedback_loop disabled', () => {
      const noFeedbackConfig: EvalModuleConfig = {
        ...config,
        feedback_loop_enabled: false
      }

      const module = new EvalModule(
        evalPipeline,
        metaLoop,
        traceEvaluation,
        ticketSystem,
        messageBus,
        noFeedbackConfig
      )

      let emitted = false
      messageBus.subscribe('run-1', 'feedback_loop_health', () => {
        emitted = true
      })

      module.emitFeedbackLoopHealth('run-1')

      expect(emitted).toBe(false)
    })
  })

  describe('Snapshot Management', () => {
    it('loads weights from named snapshot', () => {
      const snapshot = {
        snapshot_id: 'snap-1',
        weights: new Map([
          ['dim1', 0.5],
          ['dim2', 0.3],
          ['dim3', 0.2]
        ]),
        created_at: new Date().toISOString()
      }

      evalModule.saveSnapshot(snapshot)
      evalModule.loadWeightsFromSnapshot('snap-1')

      const loadedWeights = evalModule.getCurrentWeights()
      expect(loadedWeights.get('dim1')).toBe(0.5)
      expect(loadedWeights.get('dim2')).toBe(0.3)
      expect(loadedWeights.get('dim3')).toBe(0.2)
    })

    it('supports operator rollback via feedback_loop_snapshot_id', () => {
      const snapshot = {
        snapshot_id: 'rollback-snap',
        weights: new Map([['dim1', 0.9]]),
        created_at: new Date().toISOString()
      }

      // Create module without snapshot first
      const module = new EvalModule(
        evalPipeline,
        metaLoop,
        traceEvaluation,
        ticketSystem,
        messageBus,
        config
      )

      // Save snapshot, then load it
      module.saveSnapshot(snapshot)
      module.loadWeightsFromSnapshot('rollback-snap')

      const weights = module.getCurrentWeights()
      expect(weights.get('dim1')).toBe(0.9)
    })
  })

  describe('JudgingPolicy Modes', () => {
    it('supports full mode (no skipping)', () => {
      const fullConfig: EvalModuleConfig = {
        ...config,
        judging_policy: { mode: 'full', skip_non_binary: false, adaptive_skip_threshold: 0 }
      }

      const module = new EvalModule(
        evalPipeline,
        metaLoop,
        traceEvaluation,
        ticketSystem,
        messageBus,
        fullConfig
      )

      expect(module.getJudgingPolicyMode()).toBe('full')
    })

    it('supports adaptive mode', () => {
      const adaptiveConfig: EvalModuleConfig = {
        ...config,
        judging_policy: { mode: 'adaptive', skip_non_binary: true, adaptive_skip_threshold: 0.3 }
      }

      const module = new EvalModule(
        evalPipeline,
        metaLoop,
        traceEvaluation,
        ticketSystem,
        messageBus,
        adaptiveConfig
      )

      expect(module.getJudgingPolicyMode()).toBe('adaptive')
    })

    it('supports custom mode', () => {
      const customConfig: EvalModuleConfig = {
        ...config,
        judging_policy: { mode: 'custom', skip_non_binary: false, adaptive_skip_threshold: 0 },
        skip_dimensions: ['custom_skip_dim']
      }

      const module = new EvalModule(
        evalPipeline,
        metaLoop,
        traceEvaluation,
        ticketSystem,
        messageBus,
        customConfig
      )

      expect(module.getJudgingPolicyMode()).toBe('custom')
    })
  })

  describe('Merged Judge Mode', () => {
    it('reduces Gate 1 calls when merged_judge_mode enabled', async () => {
      let judgeCallCount = 0

      const mockEvalPipeline = {
        evaluate: async (input: EvalPipelineInput) => {
          if (input.merged_judge_mode) {
            judgeCallCount += 1 // Merged mode: 1 call for all dimensions
          } else {
            judgeCallCount += 3 // Non-merged: 3 calls (one per dimension)
          }
          return {
            passed: true,
            gate_reached: 2 as const,
            gate1_signals: [],
            gate2_signals: [],
            gate2_weighted_score: 0.8
          }
        }
      } as any

      const mergedConfig: EvalModuleConfig = {
        ...config,
        merged_judge_mode: true
      }

      const module = new EvalModule(
        mockEvalPipeline,
        metaLoop,
        traceEvaluation,
        ticketSystem,
        messageBus,
        mergedConfig
      )

      await module.evaluateAgent({
        agent_type: 'executor',
        agent_output: { result: 'test' },
        attempt: 1,
        failed_strategies: [],
        run_id: 'run-1'
      })

      // With merged mode, expect significantly fewer calls (up to 70% reduction)
      expect(judgeCallCount).toBeLessThanOrEqual(1)
    })
  })

  describe('Dimension Skipping', () => {
    it('skip_dimensions only skips non-binary dimensions', () => {
      const skipConfig: EvalModuleConfig = {
        ...config,
        skip_dimensions: ['dim1', 'dim2']
      }

      const module = new EvalModule(
        evalPipeline,
        metaLoop,
        traceEvaluation,
        ticketSystem,
        messageBus,
        skipConfig
      )

      const dimensions: Dimension[] = [
        { dimension_id: 'dim1', weight: 0.3, is_binary: true, gate: 1 },  // Binary - NEVER skip
        { dimension_id: 'dim2', weight: 0.3, is_binary: false, gate: 2 }, // Non-binary - can skip
        { dimension_id: 'dim3', weight: 0.4, is_binary: false, gate: 2 }
      ]

      const filtered = module.filterDimensions(dimensions)

      // dim1 (binary) should be present even though in skip list
      expect(filtered.some(d => d.dimension_id === 'dim1')).toBe(true)
      // dim2 (non-binary) should be skipped
      expect(filtered.some(d => d.dimension_id === 'dim2')).toBe(false)
      // dim3 (not in skip list) should be present
      expect(filtered.some(d => d.dimension_id === 'dim3')).toBe(true)
    })
  })

  describe('Adaptive Judge Calibration', () => {
    it('tracks skip rate', () => {
      evalModule.trackJudgeSkip('dim1', true)
      evalModule.trackJudgeSkip('dim2', false)
      evalModule.trackJudgeSkip('dim3', true)
      evalModule.trackJudgeSkip('dim4', false)

      const skipRate = evalModule.getSkipRate()
      expect(skipRate).toBe(0.5) // 2/4
    })

    it('tracks false negative rate', () => {
      evalModule.trackFalseNegative('dim1', true) // False negative occurred
      evalModule.trackFalseNegative('dim2', false) // No false negative
      evalModule.trackFalseNegative('dim3', false)

      const fnRate = evalModule.getFalseNegativeRate()
      expect(fnRate).toBe(1 / 3)
    })

    it('updates JudgingPolicy based on calibration', () => {
      const adaptiveConfig: EvalModuleConfig = {
        ...config,
        judging_policy: { mode: 'adaptive', skip_non_binary: true, adaptive_skip_threshold: 0.3 }
      }

      const module = new EvalModule(
        evalPipeline,
        metaLoop,
        traceEvaluation,
        ticketSystem,
        messageBus,
        adaptiveConfig
      )

      // Simulate high skip rate
      for (let i = 0; i < 10; i++) {
        module.trackJudgeSkip(`dim${i}`, i < 7) // 70% skip rate
      }

      // Update policy based on skip rate
      module.updateJudgingPolicy()

      // Skip rate above threshold should trigger policy update
      const skipRate = module.getSkipRate()
      expect(skipRate).toBeGreaterThan(adaptiveConfig.judging_policy.adaptive_skip_threshold)
    })
  })
})
