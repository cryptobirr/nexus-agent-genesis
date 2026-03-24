import { describe, it, expect, beforeEach } from 'vitest'
import { RequirementExtractor } from './requirement-extractor.js'
import type { RequirementMap, AgentNode } from './types.js'

describe('RequirementExtractor', () => {
  let extractor: RequirementExtractor

  beforeEach(() => {
    extractor = new RequirementExtractor()
  })

  describe('extract() - extracts 3-7 requirements from valid router output', () => {
    it('extracts 3 requirements from valid input', () => {
      const routerOutput = JSON.stringify([
        { id: 'req-1', description: 'First requirement', priority: 'high' },
        { id: 'req-2', description: 'Second requirement', priority: 'medium' },
        { id: 'req-3', description: 'Third requirement', priority: 'low' }
      ])

      const map = extractor.extract(routerOutput)

      expect(map.size).toBe(3)
      expect(map.has('req-1')).toBe(true)
      expect(map.has('req-2')).toBe(true)
      expect(map.has('req-3')).toBe(true)
    })

    it('extracts 7 requirements from valid input', () => {
      const routerOutput = JSON.stringify([
        { id: 'req-1', description: 'Req 1', priority: 'high' },
        { id: 'req-2', description: 'Req 2', priority: 'medium' },
        { id: 'req-3', description: 'Req 3', priority: 'low' },
        { id: 'req-4', description: 'Req 4', priority: 'medium' },
        { id: 'req-5', description: 'Req 5', priority: 'low' },
        { id: 'req-6', description: 'Req 6', priority: 'high' },
        { id: 'req-7', description: 'Req 7', priority: 'medium' }
      ])

      const map = extractor.extract(routerOutput)

      expect(map.size).toBe(7)
    })

    it('extracts RequirementMap with correct structure', () => {
      const routerOutput = JSON.stringify([
        { id: 'req-1', description: 'Test requirement', priority: 'high' },
        { id: 'req-2', description: 'Another requirement', priority: 'medium' }
      ])

      const map = extractor.extract(routerOutput)
      const req1 = map.get('req-1')

      expect(req1).toBeDefined()
      expect(req1?.id).toBe('req-1')
      expect(req1?.description).toBe('Test requirement')
      expect(req1?.priority).toBe('high')
      expect(req1?.coverage_score).toBe(0)
    })

    it('initializes all requirements with coverage_score = 0', () => {
      const routerOutput = JSON.stringify([
        { id: 'req-1', description: 'Req 1', priority: 'high' },
        { id: 'req-2', description: 'Req 2', priority: 'medium' },
        { id: 'req-3', description: 'Req 3', priority: 'low' }
      ])

      const map = extractor.extract(routerOutput)

      map.forEach((record) => {
        expect(record.coverage_score).toBe(0)
      })
    })

    it('throws error on malformed router output', () => {
      expect(() => {
        extractor.extract('invalid json')
      }).toThrow()
    })

    it('returns empty map for empty array input', () => {
      const routerOutput = JSON.stringify([])
      const map = extractor.extract(routerOutput)

      expect(map.size).toBe(0)
    })
  })

  describe('checkCoverage() - identifies covered/uncovered per RequirementRecord', () => {
    let map: RequirementMap

    beforeEach(() => {
      const routerOutput = JSON.stringify([
        { id: 'req-1', description: 'Req 1', priority: 'high' },
        { id: 'req-2', description: 'Req 2', priority: 'medium' },
        { id: 'req-3', description: 'Req 3', priority: 'low' }
      ])
      map = extractor.extract(routerOutput)
    })

    it('all requirements uncovered when agent_node array is empty', () => {
      const agentNodes: AgentNode[] = []
      const result = extractor.checkCoverage(map, agentNodes)

      expect(result.covered_count).toBe(0)
      expect(result.uncovered_count).toBe(3)
      expect(result.covered_ids).toEqual([])
      expect(result.uncovered_ids).toEqual(['req-1', 'req-2', 'req-3'])
    })

    it('all requirements covered when agent nodes cover all', () => {
      const agentNodes: AgentNode[] = [
        { node_id: 'node-1', requirements_covered: ['req-1', 'req-2'] },
        { node_id: 'node-2', requirements_covered: ['req-3'] }
      ]
      const result = extractor.checkCoverage(map, agentNodes)

      expect(result.covered_count).toBe(3)
      expect(result.uncovered_count).toBe(0)
      expect(result.covered_ids.sort()).toEqual(['req-1', 'req-2', 'req-3'])
      expect(result.uncovered_ids).toEqual([])
    })

    it('partial coverage shows correct split', () => {
      const agentNodes: AgentNode[] = [
        { node_id: 'node-1', requirements_covered: ['req-1'] }
      ]
      const result = extractor.checkCoverage(map, agentNodes)

      expect(result.covered_count).toBe(1)
      expect(result.uncovered_count).toBe(2)
      expect(result.covered_ids).toEqual(['req-1'])
      expect(result.uncovered_ids.sort()).toEqual(['req-2', 'req-3'])
    })

    it('updates RequirementRecord.coverage_score to 1.0 when covered', () => {
      const agentNodes: AgentNode[] = [
        { node_id: 'node-1', requirements_covered: ['req-1', 'req-2'] }
      ]
      extractor.checkCoverage(map, agentNodes)

      expect(map.get('req-1')?.coverage_score).toBe(1.0)
      expect(map.get('req-2')?.coverage_score).toBe(1.0)
      expect(map.get('req-3')?.coverage_score).toBe(0)
    })

    it('handles duplicate coverage (same requirement covered by multiple nodes)', () => {
      const agentNodes: AgentNode[] = [
        { node_id: 'node-1', requirements_covered: ['req-1'] },
        { node_id: 'node-2', requirements_covered: ['req-1', 'req-2'] }
      ]
      const result = extractor.checkCoverage(map, agentNodes)

      expect(result.covered_count).toBe(2)
      expect(result.uncovered_count).toBe(1)
      expect(map.get('req-1')?.coverage_score).toBe(1.0)
    })
  })

  describe('computeConfidence() - formula: (covered/total) × mean(coverage_scores)', () => {
    it('returns mean of coverage_scores when all requirements covered', () => {
      const map = new Map([
        ['req-1', { id: 'req-1', description: 'Req 1', priority: 'high', coverage_score: 1.0 }],
        ['req-2', { id: 'req-2', description: 'Req 2', priority: 'medium', coverage_score: 1.0 }],
        ['req-3', { id: 'req-3', description: 'Req 3', priority: 'low', coverage_score: 1.0 }]
      ])

      const confidence = extractor.computeConfidence(map)

      // (3/3) × ((1.0 + 1.0 + 1.0) / 3) = 1.0 × 1.0 = 1.0
      expect(confidence).toBe(1.0)
    })

    it('returns (covered/total) × mean when partial coverage', () => {
      const map = new Map([
        ['req-1', { id: 'req-1', description: 'Req 1', priority: 'medium', coverage_score: 1.0 }],
        ['req-2', { id: 'req-2', description: 'Req 2', priority: 'medium', coverage_score: 1.0 }],
        ['req-3', { id: 'req-3', description: 'Req 3', priority: 'low', coverage_score: 0 }]
      ])

      const confidence = extractor.computeConfidence(map)

      // (2/3) × ((1.0 + 1.0 + 0) / 3) = 0.6667 × 0.6667 = 0.4444...
      expect(confidence).toBeCloseTo(0.4444, 4)
    })

    it('returns 0 when no requirements covered', () => {
      const map = new Map([
        ['req-1', { id: 'req-1', description: 'Req 1', priority: 'high', coverage_score: 0 }],
        ['req-2', { id: 'req-2', description: 'Req 2', priority: 'medium', coverage_score: 0 }]
      ])

      const confidence = extractor.computeConfidence(map)

      expect(confidence).toBe(0)
    })

    it('returns 0 for empty RequirementMap', () => {
      const map = new Map()
      const confidence = extractor.computeConfidence(map)

      expect(confidence).toBe(0)
    })
  })

  describe('High-priority requirement guard', () => {
    it('returns 0 confidence if any high-priority requirement uncovered', () => {
      const map = new Map([
        ['req-1', { id: 'req-1', description: 'Req 1', priority: 'high', coverage_score: 0 }],
        ['req-2', { id: 'req-2', description: 'Req 2', priority: 'medium', coverage_score: 1.0 }],
        ['req-3', { id: 'req-3', description: 'Req 3', priority: 'low', coverage_score: 1.0 }]
      ])

      const confidence = extractor.computeConfidence(map)

      expect(confidence).toBe(0)
    })

    it('returns 0 confidence if multiple high-priority requirements uncovered', () => {
      const map = new Map([
        ['req-1', { id: 'req-1', description: 'Req 1', priority: 'high', coverage_score: 0 }],
        ['req-2', { id: 'req-2', description: 'Req 2', priority: 'high', coverage_score: 0 }],
        ['req-3', { id: 'req-3', description: 'Req 3', priority: 'medium', coverage_score: 1.0 }]
      ])

      const confidence = extractor.computeConfidence(map)

      expect(confidence).toBe(0)
    })

    it('computes confidence normally when all high-priority requirements covered', () => {
      const map = new Map([
        ['req-1', { id: 'req-1', description: 'Req 1', priority: 'high', coverage_score: 1.0 }],
        ['req-2', { id: 'req-2', description: 'Req 2', priority: 'medium', coverage_score: 0 }],
        ['req-3', { id: 'req-3', description: 'Req 3', priority: 'low', coverage_score: 1.0 }]
      ])

      const confidence = extractor.computeConfidence(map)

      // (2/3) × ((1.0 + 0 + 1.0) / 3) = 0.6667 × 0.6667 = 0.4444...
      expect(confidence).toBeCloseTo(0.4444, 4)
    })

    it('returns normal confidence when no high-priority requirements exist', () => {
      const map = new Map([
        ['req-1', { id: 'req-1', description: 'Req 1', priority: 'medium', coverage_score: 1.0 }],
        ['req-2', { id: 'req-2', description: 'Req 2', priority: 'low', coverage_score: 0 }]
      ])

      const confidence = extractor.computeConfidence(map)

      // (1/2) × ((1.0 + 0) / 2) = 0.5 × 0.5 = 0.25
      expect(confidence).toBe(0.25)
    })

    it('returns 0 when high-priority requirement has partial coverage_score (< 1.0)', () => {
      const map = new Map([
        ['req-1', { id: 'req-1', description: 'Req 1', priority: 'high', coverage_score: 0.5 }],
        ['req-2', { id: 'req-2', description: 'Req 2', priority: 'medium', coverage_score: 1.0 }]
      ])

      const confidence = extractor.computeConfidence(map)

      expect(confidence).toBe(0)
    })
  })
})
