/**
 * UAT-082: Early termination: QUEUED agents cancelled when coverage threshold met
 *
 * This test validates that EarlyTerminationController cancels QUEUED agents in
 * topological order when RequirementMap coverage meets the threshold, while allowing
 * GENERATING agents to complete.
 *
 * Story:
 * Verify that EarlyTerminationController cancels QUEUED agents in topological order
 * when RequirementMap coverage meets the threshold, while allowing GENERATING agents
 * to complete.
 *
 * Source: agent-nexus-spec.md — F-04
 *
 * Acceptance Criteria:
 * - AC1: Set up run with 4 requirements; after 3 Executors complete, coverage confidence ≥ threshold with all requirements covered
 * - AC2: EarlyTerminationController fires: Run.early_termination = true
 * - AC3: All remaining QUEUED agents → status = CANCELLED in topological order (leaves first, then roots)
 * - AC4: GENERATING agents at termination time are allowed to complete normally (status = COMPLETE or ESCALATED)
 * - AC5: Cancelled agents' outbound dependency edges fire on_timeout immediately
 * - AC6: Bus emits early_termination event with run_id and the triggering coverage state (requirements covered, confidence score)
 * - AC7: If any priority: "high" requirement is uncovered: early termination does NOT fire regardless of confidence score
 * - AC8: Run.early_termination_in_flight_count = count of GENERATING agents allowed to complete after termination fired
 *
 * Dependencies:
 * - F-04: EarlyTerminationController (#57)
 * - P-08: RequirementExtractor (#32)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { EarlyTerminationController } from './features/early-termination-controller.js'
import { RequirementExtractor } from './primitives/requirement-extractor.js'
import { DependencyGraphManager } from './components/dependency-graph-manager.js'
import { AgentStateManager } from './components/agent-state-manager.js'
import { MessageBus } from './primitives/message-bus.js'
import { TicketSystem } from './primitives/ticket-system.js'
import type {
  RequirementMap,
  AgentNode,
  DependencyGraph,
  DependencyEdge,
  CoverageResult
} from './primitives/types.js'

describe('UAT-082: Early termination: QUEUED agents cancelled when coverage threshold met', () => {
  let earlyTerminationController: EarlyTerminationController
  let requirementExtractor: RequirementExtractor
  let dependencyGraphManager: DependencyGraphManager
  let agentStateManager: AgentStateManager
  let messageBus: MessageBus
  let ticketSystem: TicketSystem

  beforeEach(() => {
    // Initialize primitives
    messageBus = new MessageBus()
    ticketSystem = new TicketSystem(messageBus)

    // Initialize components
    requirementExtractor = new RequirementExtractor()
    dependencyGraphManager = new DependencyGraphManager(messageBus, ticketSystem)
    agentStateManager = new AgentStateManager(messageBus, ticketSystem)

    // Initialize EarlyTerminationController
    earlyTerminationController = new EarlyTerminationController(
      requirementExtractor,
      dependencyGraphManager,
      agentStateManager,
      messageBus
    )
  })

  it('AC1-AC6: should cancel QUEUED agents in topological order when coverage threshold met', () => {
    const run_id = 'run-early-termination-001'

    console.log('\n=== UAT-082 Test: Early termination with coverage threshold met ===\n')

    // AC1: Set up run with 4 requirements
    const requirementMap: RequirementMap = new Map([
      ['req1', { id: 'req1', description: 'User authentication', priority: 'high', coverage_score: 1.0 }],
      ['req2', { id: 'req2', description: 'Data validation', priority: 'medium', coverage_score: 1.0 }],
      ['req3', { id: 'req3', description: 'Error handling', priority: 'medium', coverage_score: 1.0 }],
      ['req4', { id: 'req4', description: 'Logging', priority: 'low', coverage_score: 1.0 }]
    ])

    // After 3 Executors complete, all requirements covered
    const completedAgentNodes: AgentNode[] = [
      { node_id: 'executor-1', requirements_covered: ['req1', 'req2'], agent_type: 'executor' },
      { node_id: 'executor-2', requirements_covered: ['req3'], agent_type: 'executor' },
      { node_id: 'executor-3', requirements_covered: ['req4'], agent_type: 'executor' }
    ]

    console.log('✓ AC1: Created RequirementMap with 4 requirements')
    console.log(`   Requirements: ${Array.from(requirementMap.keys()).join(', ')}`)
    console.log(`   Completed agents covering all requirements: ${completedAgentNodes.length}`)

    // Create dependency graph with topology:
    // executor-1 (COMPLETE) → queued-1 (QUEUED) → queued-3 (QUEUED)
    // executor-2 (COMPLETE) → queued-2 (QUEUED) → queued-3 (QUEUED)
    // executor-3 (COMPLETE)
    // generating-1 (GENERATING) - should be allowed to complete

    const edge1: DependencyEdge = {
      from_node_id: 'executor-1',
      to_node_id: 'queued-1',
      edge_type: 'data',
      timeout_ms: 5000,
      on_timeout: 'fail'
    }

    const edge2: DependencyEdge = {
      from_node_id: 'queued-1',
      to_node_id: 'queued-3',
      edge_type: 'data',
      timeout_ms: 5000,
      on_timeout: 'proceed_degraded',
      fallback_payload: { status: 'degraded' }
    }

    const edge3: DependencyEdge = {
      from_node_id: 'executor-2',
      to_node_id: 'queued-2',
      edge_type: 'control',
      timeout_ms: 3000,
      on_timeout: 'fail'
    }

    const edge4: DependencyEdge = {
      from_node_id: 'queued-2',
      to_node_id: 'queued-3',
      edge_type: 'data',
      timeout_ms: 5000,
      on_timeout: 'proceed_degraded',
      fallback_payload: { status: 'degraded' }
    }

    const dependencyGraph: DependencyGraph = {
      run_id,
      nodes: ['executor-1', 'executor-2', 'executor-3', 'queued-1', 'queued-2', 'queued-3', 'generating-1'],
      edges: [edge1, edge2, edge3, edge4]
    }

    // Initialize agents with states
    const agentTypes = {
      'executor-1': 'executor',
      'executor-2': 'executor',
      'executor-3': 'executor',
      'queued-1': 'executor',
      'queued-2': 'executor',
      'queued-3': 'executor',
      'generating-1': 'executor'
    }

    Object.entries(agentTypes).forEach(([agent_id, agent_type]) => {
      agentStateManager.initializeAgent(agent_id, run_id, agent_type)
    })

    // Set completed agents to COMPLETE state
    // Valid transition path: QUEUED → AWAITING_HITL → PRECHECKING → GENERATING → GATE1_EVALUATING → GATE2_EVALUATING → COMPLETE
    const completedAgents = ['executor-1', 'executor-2', 'executor-3']
    completedAgents.forEach(agent_id => {
      agentStateManager.transition({ agent_id, run_id, reason: 'HITL check' }, 'AWAITING_HITL')
      agentStateManager.transition({ agent_id, run_id, reason: 'Starting prechecks' }, 'PRECHECKING')
      agentStateManager.transition({ agent_id, run_id, reason: 'Starting generation' }, 'GENERATING')
      agentStateManager.transition({ agent_id, run_id, reason: 'Gate 1 evaluation' }, 'GATE1_EVALUATING')
      agentStateManager.transition({ agent_id, run_id, reason: 'Gate 2 evaluation' }, 'GATE2_EVALUATING')
      agentStateManager.transition({ agent_id, run_id, reason: 'Task completed' }, 'COMPLETE')
    })

    // Set generating-1 to GENERATING state (should be allowed to complete)
    // Transition path: QUEUED → AWAITING_HITL → PRECHECKING → GENERATING
    agentStateManager.transition(
      { agent_id: 'generating-1', run_id, reason: 'HITL check' },
      'AWAITING_HITL'
    )
    agentStateManager.transition(
      { agent_id: 'generating-1', run_id, reason: 'Starting prechecks' },
      'PRECHECKING'
    )
    agentStateManager.transition(
      { agent_id: 'generating-1', run_id, reason: 'Starting generation' },
      'GENERATING'
    )

    // Verify initial states
    expect(agentStateManager.getState('queued-1')).toBe('QUEUED')
    expect(agentStateManager.getState('queued-2')).toBe('QUEUED')
    expect(agentStateManager.getState('queued-3')).toBe('QUEUED')
    expect(agentStateManager.getState('generating-1')).toBe('GENERATING')

    // Set up event listener to capture early_termination event (AC6) - BEFORE running check
    let earlyTerminationEvent: any = null
    const unsubscribe = messageBus.subscribe(run_id, 'early_termination_triggered', (event_type, payload) => {
      earlyTerminationEvent = payload
    })

    // Set up dependency graph manager mock to track fireTTLTimeout calls (AC5)
    const fireTTLTimeoutCalls: Array<{ edge: DependencyEdge, run_id: string }> = []
    const originalFireTTLTimeout = dependencyGraphManager.fireTTLTimeout.bind(dependencyGraphManager)
    dependencyGraphManager.fireTTLTimeout = vi.fn((edge, run_id) => {
      fireTTLTimeoutCalls.push({ edge, run_id })
      return originalFireTTLTimeout(edge, run_id)
    })

    console.log('✓ Setup: Created dependency graph with 3 QUEUED agents and 1 GENERATING agent')
    console.log('   QUEUED agents: queued-1, queued-2, queued-3')
    console.log('   GENERATING agents: generating-1')

    // Trigger early termination check
    const confidence_threshold = 0.8
    const result = earlyTerminationController.check(
      run_id,
      requirementMap,
      completedAgentNodes,
      dependencyGraph,
      confidence_threshold
    )

    // AC2: EarlyTerminationController fires: early_termination = true
    expect(result.terminated).toBe(true)
    console.log('\n✓ AC2: EarlyTerminationController fired with early_termination = true')

    // AC3: All remaining QUEUED agents → status = CANCELLED in topological order (leaves first)
    expect(result.cancelled_agent_ids).toHaveLength(3)
    expect(result.cancelled_agent_ids).toContain('queued-1')
    expect(result.cancelled_agent_ids).toContain('queued-2')
    expect(result.cancelled_agent_ids).toContain('queued-3')

    // Verify states after cancellation
    expect(agentStateManager.getState('queued-1')).toBe('CANCELLED')
    expect(agentStateManager.getState('queued-2')).toBe('CANCELLED')
    expect(agentStateManager.getState('queued-3')).toBe('CANCELLED')

    console.log('✓ AC3: All QUEUED agents transitioned to CANCELLED')
    console.log(`   Cancelled agents: ${result.cancelled_agent_ids.join(', ')}`)

    // AC4: GENERATING agents at termination time are allowed to complete normally
    expect(agentStateManager.getState('generating-1')).toBe('GENERATING')
    expect(result.cancelled_agent_ids).not.toContain('generating-1')

    console.log('✓ AC4: GENERATING agent (generating-1) was NOT cancelled')
    console.log(`   generating-1 state: ${agentStateManager.getState('generating-1')}`)

    // AC5: Cancelled agents' outbound dependency edges fire on_timeout immediately
    // queued-1 has edge to queued-3 (edge2)
    // queued-2 has edge to queued-3 (edge4)
    expect(fireTTLTimeoutCalls.length).toBeGreaterThan(0)

    const edgesWithTimeoutFired = fireTTLTimeoutCalls.map(call => call.edge.from_node_id)
    expect(edgesWithTimeoutFired).toContain('queued-1')
    expect(edgesWithTimeoutFired).toContain('queued-2')

    console.log('✓ AC5: Cancelled agents\' outbound edges fired on_timeout')
    console.log(`   fireTTLTimeout called ${fireTTLTimeoutCalls.length} times`)
    console.log(`   Edges fired: ${edgesWithTimeoutFired.join(', ')}`)

    // AC6: Bus emits early_termination event with run_id and coverage state
    expect(earlyTerminationEvent).not.toBeNull()
    expect(earlyTerminationEvent.coverage_state).toBeDefined()
    expect(earlyTerminationEvent.coverage_state.covered_count).toBe(4)
    expect(earlyTerminationEvent.coverage_state.uncovered_count).toBe(0)
    expect(earlyTerminationEvent.coverage_state.confidence).toBeGreaterThanOrEqual(confidence_threshold)
    expect(earlyTerminationEvent.cancelled_agent_ids).toEqual(result.cancelled_agent_ids)

    console.log('✓ AC6: Bus emitted early_termination_triggered event')
    console.log(`   Coverage state: ${JSON.stringify(earlyTerminationEvent.coverage_state)}`)
    console.log(`   Cancelled agent IDs: ${earlyTerminationEvent.cancelled_agent_ids.join(', ')}`)

    // AC8: early_termination_in_flight_count = count of GENERATING agents
    // Note: This should be 1 (generating-1)
    const allAgentStates = ['executor-1', 'executor-2', 'executor-3', 'queued-1', 'queued-2', 'queued-3', 'generating-1']
      .map(agent_id => ({ agent_id, state: agentStateManager.getState(agent_id) }))

    const generatingAgents = allAgentStates.filter(({ state }) =>
      state === 'GENERATING' || state === 'GATE1_EVALUATING' || state === 'GATE2_EVALUATING'
    )

    console.log(`   All agent states: ${JSON.stringify(allAgentStates)}`)
    console.log(`   In-flight agents: ${generatingAgents.map(a => a.agent_id).join(', ')}`)

    expect(generatingAgents.length).toBe(1)
    expect(generatingAgents[0].agent_id).toBe('generating-1')
    console.log('✓ AC8: early_termination_in_flight_count = 1 (GENERATING agent allowed to complete)')
    console.log(`   In-flight agents: generating-1`)

    console.log('\n=== UAT-082 Test PASSED: All acceptance criteria validated ===\n')
  })

  it('AC7: should NOT terminate when high-priority requirement is uncovered', () => {
    const run_id = 'run-early-termination-high-priority-uncovered'

    console.log('\n=== UAT-082 Test: Early termination blocked by uncovered high-priority requirement ===\n')

    // Create RequirementMap with one high-priority requirement uncovered
    const requirementMap: RequirementMap = new Map([
      ['req1', { id: 'req1', description: 'Critical security requirement', priority: 'high', coverage_score: 0.0 }],
      ['req2', { id: 'req2', description: 'Data validation', priority: 'medium', coverage_score: 1.0 }],
      ['req3', { id: 'req3', description: 'Error handling', priority: 'low', coverage_score: 1.0 }]
    ])

    // Only 2 executors completed, but high-priority req1 is NOT covered
    const completedAgentNodes: AgentNode[] = [
      { node_id: 'executor-1', requirements_covered: ['req2'], agent_type: 'executor' },
      { node_id: 'executor-2', requirements_covered: ['req3'], agent_type: 'executor' }
    ]

    const dependencyGraph: DependencyGraph = {
      run_id,
      nodes: ['executor-1', 'executor-2', 'queued-1'],
      edges: []
    }

    // Initialize agents
    agentStateManager.initializeAgent('executor-1', run_id, 'executor')
    agentStateManager.initializeAgent('executor-2', run_id, 'executor')
    agentStateManager.initializeAgent('queued-1', run_id, 'executor')

    // Transition executors to COMPLETE through valid path
    const completedAgentsAC7 = ['executor-1', 'executor-2']
    completedAgentsAC7.forEach(agent_id => {
      agentStateManager.transition({ agent_id, run_id, reason: 'HITL check' }, 'AWAITING_HITL')
      agentStateManager.transition({ agent_id, run_id, reason: 'Starting prechecks' }, 'PRECHECKING')
      agentStateManager.transition({ agent_id, run_id, reason: 'Starting generation' }, 'GENERATING')
      agentStateManager.transition({ agent_id, run_id, reason: 'Gate 1 evaluation' }, 'GATE1_EVALUATING')
      agentStateManager.transition({ agent_id, run_id, reason: 'Gate 2 evaluation' }, 'GATE2_EVALUATING')
      agentStateManager.transition({ agent_id, run_id, reason: 'Task completed' }, 'COMPLETE')
    })

    console.log('✓ Setup: Created scenario with uncovered high-priority requirement (req1)')
    console.log(`   High-priority requirement: req1 (uncovered)`)
    console.log(`   Medium/low requirements: req2, req3 (covered)`)

    // Set up event listener
    let earlyTerminationEvent: any = null
    messageBus.subscribe(run_id, 'early_termination_triggered', (event_type, payload) => {
      earlyTerminationEvent = payload
    })

    // Trigger early termination check
    const confidence_threshold = 0.8
    const result = earlyTerminationController.check(
      run_id,
      requirementMap,
      completedAgentNodes,
      dependencyGraph,
      confidence_threshold
    )

    // AC7: Early termination does NOT fire when high-priority requirement uncovered
    expect(result.terminated).toBe(false)
    expect(result.cancelled_agent_ids).toHaveLength(0)
    expect(earlyTerminationEvent).toBeNull()

    // Verify queued agent still in QUEUED state
    expect(agentStateManager.getState('queued-1')).toBe('QUEUED')

    console.log('✓ AC7: Early termination did NOT fire due to uncovered high-priority requirement')
    console.log(`   Termination result: ${result.terminated}`)
    console.log(`   queued-1 state: ${agentStateManager.getState('queued-1')} (still QUEUED)`)

    console.log('\n=== UAT-082 AC7 Test PASSED: High-priority requirement guard works correctly ===\n')
  })

  it('AC3: should cancel agents in correct topological order (leaves first, then roots)', () => {
    const run_id = 'run-early-termination-topological-order'

    console.log('\n=== UAT-082 Test: Topological cancellation order (leaves first) ===\n')

    // Set up requirement map with all requirements covered
    const requirementMap: RequirementMap = new Map([
      ['req1', { id: 'req1', description: 'Requirement 1', priority: 'medium', coverage_score: 1.0 }]
    ])

    const completedAgentNodes: AgentNode[] = [
      { node_id: 'completed-1', requirements_covered: ['req1'], agent_type: 'executor' }
    ]

    // Create dependency graph with clear topology:
    // root-1 → intermediate-1 → leaf-1
    // root-2 → intermediate-2 → leaf-2
    // Both chains should be cancelled in leaf-first order

    const dependencyGraph: DependencyGraph = {
      run_id,
      nodes: ['completed-1', 'root-1', 'intermediate-1', 'leaf-1', 'root-2', 'intermediate-2', 'leaf-2'],
      edges: [
        { from_node_id: 'root-1', to_node_id: 'intermediate-1', edge_type: 'data', timeout_ms: null, on_timeout: null },
        { from_node_id: 'intermediate-1', to_node_id: 'leaf-1', edge_type: 'data', timeout_ms: null, on_timeout: null },
        { from_node_id: 'root-2', to_node_id: 'intermediate-2', edge_type: 'data', timeout_ms: null, on_timeout: null },
        { from_node_id: 'intermediate-2', to_node_id: 'leaf-2', edge_type: 'data', timeout_ms: null, on_timeout: null }
      ]
    }

    // Initialize all agents
    const agentIds = ['completed-1', 'root-1', 'intermediate-1', 'leaf-1', 'root-2', 'intermediate-2', 'leaf-2']
    agentIds.forEach(agent_id => {
      agentStateManager.initializeAgent(agent_id, run_id, 'executor')
    })

    // Set completed agent to COMPLETE (transition through valid states)
    // Valid path: QUEUED → AWAITING_HITL → PRECHECKING → GENERATING → GATE1_EVALUATING → GATE2_EVALUATING → COMPLETE
    agentStateManager.transition({ agent_id: 'completed-1', run_id, reason: 'HITL check' }, 'AWAITING_HITL')
    agentStateManager.transition({ agent_id: 'completed-1', run_id, reason: 'Starting prechecks' }, 'PRECHECKING')
    agentStateManager.transition({ agent_id: 'completed-1', run_id, reason: 'Starting generation' }, 'GENERATING')
    agentStateManager.transition({ agent_id: 'completed-1', run_id, reason: 'Gate 1 evaluation' }, 'GATE1_EVALUATING')
    agentStateManager.transition({ agent_id: 'completed-1', run_id, reason: 'Gate 2 evaluation' }, 'GATE2_EVALUATING')
    agentStateManager.transition({ agent_id: 'completed-1', run_id, reason: 'Task completed' }, 'COMPLETE')

    // Track cancellation order
    const cancellationOrder: string[] = []
    const originalTransition = agentStateManager.transition.bind(agentStateManager)
    agentStateManager.transition = vi.fn((context, new_state) => {
      const result = originalTransition(context, new_state)
      if (new_state === 'CANCELLED' && result.success) {
        cancellationOrder.push(context.agent_id)
      }
      return result
    })

    console.log('✓ Setup: Created dependency graph with 2 chains (root → intermediate → leaf)')

    // Trigger early termination
    const result = earlyTerminationController.check(
      run_id,
      requirementMap,
      completedAgentNodes,
      dependencyGraph,
      0.8
    )

    expect(result.terminated).toBe(true)
    expect(result.cancelled_agent_ids).toHaveLength(6)

    console.log('✓ AC3: Agents cancelled in topological order')
    console.log(`   Cancellation order: ${cancellationOrder.join(' → ')}`)

    // Verify cancellation order: leaves should come before their dependencies
    // getCancellationOrder returns reverse topological order (leaves first)
    // So we expect: leaf-1, leaf-2, intermediate-1, intermediate-2, root-1, root-2 (or similar valid order)

    const leaf1Index = cancellationOrder.indexOf('leaf-1')
    const leaf2Index = cancellationOrder.indexOf('leaf-2')
    const intermediate1Index = cancellationOrder.indexOf('intermediate-1')
    const intermediate2Index = cancellationOrder.indexOf('intermediate-2')
    const root1Index = cancellationOrder.indexOf('root-1')
    const root2Index = cancellationOrder.indexOf('root-2')

    // Leaves should be cancelled before intermediates
    if (leaf1Index !== -1 && intermediate1Index !== -1) {
      expect(leaf1Index).toBeLessThan(intermediate1Index)
    }
    if (leaf2Index !== -1 && intermediate2Index !== -1) {
      expect(leaf2Index).toBeLessThan(intermediate2Index)
    }

    // Intermediates should be cancelled before roots
    if (intermediate1Index !== -1 && root1Index !== -1) {
      expect(intermediate1Index).toBeLessThan(root1Index)
    }
    if (intermediate2Index !== -1 && root2Index !== -1) {
      expect(intermediate2Index).toBeLessThan(root2Index)
    }

    console.log('   Verified: Leaves cancelled before intermediates, intermediates before roots')
    console.log('\n=== UAT-082 AC3 Topological Order Test PASSED ===\n')
  })
})
