import { describe, it, expect, beforeEach } from 'vitest'
import { BudgetLedger } from './budget-ledger.js'
import type { BudgetLimits } from './types.js'

describe('BudgetLedger', () => {
  let ledger: BudgetLedger
  const defaultLimits: BudgetLimits = {
    tokens: 1000,
    calls: 100,
    wall_ms: 10000,
    warning_threshold: 0.8
  }

  beforeEach(() => {
    ledger = new BudgetLedger()
  })

  describe('consume() - accumulates consumption correctly', () => {
    it('accumulates token consumption', () => {
      ledger.init('run-1', defaultLimits)

      ledger.consume('run-1', 'tokens', 100)
      let state = ledger.check('run-1')
      expect(state.remaining.tokens).toBe(900)

      ledger.consume('run-1', 'tokens', 50)
      state = ledger.check('run-1')
      expect(state.remaining.tokens).toBe(850)
    })

    it('accumulates call consumption', () => {
      ledger.init('run-1', defaultLimits)

      ledger.consume('run-1', 'calls', 30)
      const state = ledger.check('run-1')
      expect(state.remaining.calls).toBe(70)
    })

    it('accumulates wall_ms consumption', () => {
      ledger.init('run-1', defaultLimits)

      ledger.consume('run-1', 'wall_ms', 1000)
      const state = ledger.check('run-1')
      expect(state.remaining.wall_ms).toBe(9000)
    })

    it('keeps budget types independent', () => {
      ledger.init('run-1', defaultLimits)

      ledger.consume('run-1', 'tokens', 100)
      ledger.consume('run-1', 'calls', 10)
      ledger.consume('run-1', 'wall_ms', 500)

      const state = ledger.check('run-1')
      expect(state.remaining.tokens).toBe(900)
      expect(state.remaining.calls).toBe(90)
      expect(state.remaining.wall_ms).toBe(9500)
    })

    it('allows amount = 0 (no-op)', () => {
      ledger.init('run-1', defaultLimits)

      ledger.consume('run-1', 'tokens', 0)
      const state = ledger.check('run-1')
      expect(state.remaining.tokens).toBe(1000)
    })

    it('throws on negative amount', () => {
      ledger.init('run-1', defaultLimits)

      expect(() => {
        ledger.consume('run-1', 'tokens', -10)
      }).toThrow('Amount must be non-negative')
    })

    it('throws on consume before init', () => {
      expect(() => {
        ledger.consume('run-1', 'tokens', 10)
      }).toThrow('Budget not initialized for run_id: run-1')
    })
  })

  describe('check() - fires warning at configured threshold', () => {
    it('returns warning_threshold_hit: true at exactly 80% consumption', () => {
      ledger.init('run-1', defaultLimits)

      ledger.consume('run-1', 'tokens', 800)
      const state = ledger.check('run-1')
      expect(state.warning_threshold_hit).toBe(true)
    })

    it('returns warning_threshold_hit: true above 80% consumption', () => {
      ledger.init('run-1', defaultLimits)

      ledger.consume('run-1', 'tokens', 801)
      const state = ledger.check('run-1')
      expect(state.warning_threshold_hit).toBe(true)
    })

    it('returns warning_threshold_hit: false below 80% consumption', () => {
      ledger.init('run-1', defaultLimits)

      ledger.consume('run-1', 'tokens', 799)
      const state = ledger.check('run-1')
      expect(state.warning_threshold_hit).toBe(false)
    })

    it('checks warning across all budget types', () => {
      ledger.init('run-1', defaultLimits)

      // Token consumption below threshold
      ledger.consume('run-1', 'tokens', 700)
      let state = ledger.check('run-1')
      expect(state.warning_threshold_hit).toBe(false)

      // Calls consumption hits threshold (80 calls = 80% of 100)
      ledger.consume('run-1', 'calls', 80)
      state = ledger.check('run-1')
      expect(state.warning_threshold_hit).toBe(true)
    })

    it('throws on check before init', () => {
      expect(() => {
        ledger.check('run-1')
      }).toThrow('Budget not initialized for run_id: run-1')
    })
  })

  describe('check() - marks exceeded at hard limit', () => {
    it('returns exceeded: true at exactly limit', () => {
      ledger.init('run-1', defaultLimits)

      ledger.consume('run-1', 'tokens', 1000)
      const state = ledger.check('run-1')
      expect(state.exceeded).toBe(true)
    })

    it('returns exceeded: true above limit', () => {
      ledger.init('run-1', defaultLimits)

      ledger.consume('run-1', 'tokens', 1001)
      const state = ledger.check('run-1')
      expect(state.exceeded).toBe(true)
    })

    it('returns exceeded: false below limit', () => {
      ledger.init('run-1', defaultLimits)

      ledger.consume('run-1', 'tokens', 999)
      const state = ledger.check('run-1')
      expect(state.exceeded).toBe(false)
    })

    it('checks exceeded across all budget types', () => {
      ledger.init('run-1', defaultLimits)

      // None exceeded
      ledger.consume('run-1', 'tokens', 500)
      ledger.consume('run-1', 'calls', 50)
      let state = ledger.check('run-1')
      expect(state.exceeded).toBe(false)

      // Calls exceeded (100 calls = limit)
      ledger.consume('run-1', 'calls', 50)
      state = ledger.check('run-1')
      expect(state.exceeded).toBe(true)
    })

    it('allows exceeding limit (no enforcement, only tracking)', () => {
      ledger.init('run-1', defaultLimits)

      // Consume more than limit
      ledger.consume('run-1', 'tokens', 2000)
      const state = ledger.check('run-1')
      expect(state.remaining.tokens).toBe(-1000)
      expect(state.exceeded).toBe(true)
    })
  })

  describe('Thread-safe increment - no double-count on concurrent writes', () => {
    it('handles 100 concurrent consume calls correctly', async () => {
      ledger.init('run-1', defaultLimits)

      // Spawn 100 concurrent consume calls
      const promises = Array.from({ length: 100 }, () =>
        Promise.resolve().then(() => ledger.consume('run-1', 'tokens', 1))
      )

      await Promise.all(promises)

      const state = ledger.check('run-1')
      expect(state.remaining.tokens).toBe(900) // 1000 - 100 = 900
    })

    it('handles concurrent consume across different budget types', async () => {
      ledger.init('run-1', defaultLimits)

      const promises = [
        ...Array.from({ length: 50 }, () =>
          Promise.resolve().then(() => ledger.consume('run-1', 'tokens', 1))
        ),
        ...Array.from({ length: 50 }, () =>
          Promise.resolve().then(() => ledger.consume('run-1', 'calls', 1))
        )
      ]

      await Promise.all(promises)

      const state = ledger.check('run-1')
      expect(state.remaining.tokens).toBe(950)
      expect(state.remaining.calls).toBe(50)
    })
  })

  describe('reset() - clears budget', () => {
    it('resets all consumption to zero', () => {
      ledger.init('run-1', defaultLimits)

      ledger.consume('run-1', 'tokens', 500)
      ledger.consume('run-1', 'calls', 50)
      ledger.consume('run-1', 'wall_ms', 3000)

      ledger.reset('run-1')

      const state = ledger.check('run-1')
      expect(state.remaining.tokens).toBe(1000)
      expect(state.remaining.calls).toBe(100)
      expect(state.remaining.wall_ms).toBe(10000)
      expect(state.exceeded).toBe(false)
      expect(state.warning_threshold_hit).toBe(false)
    })

    it('throws on reset before init', () => {
      expect(() => {
        ledger.reset('run-1')
      }).toThrow('Budget not initialized for run_id: run-1')
    })
  })

  describe('Run isolation', () => {
    it('keeps budgets isolated by run_id', () => {
      ledger.init('run-1', defaultLimits)
      ledger.init('run-2', defaultLimits)

      ledger.consume('run-1', 'tokens', 100)
      ledger.consume('run-2', 'tokens', 200)

      const state1 = ledger.check('run-1')
      const state2 = ledger.check('run-2')

      expect(state1.remaining.tokens).toBe(900)
      expect(state2.remaining.tokens).toBe(800)
    })

    it('allows different limits per run', () => {
      ledger.init('run-1', { ...defaultLimits, tokens: 500 })
      ledger.init('run-2', { ...defaultLimits, tokens: 2000 })

      const state1 = ledger.check('run-1')
      const state2 = ledger.check('run-2')

      expect(state1.remaining.tokens).toBe(500)
      expect(state2.remaining.tokens).toBe(2000)
    })
  })
})
