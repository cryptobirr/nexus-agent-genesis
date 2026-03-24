import type { MessageBus } from '../primitives/message-bus.js'
import type { TicketSystem } from '../primitives/ticket-system.js'
import type {
  DependencyGraph,
  DependencyEdge,
  ValidationResult,
  TopologicalOrder,
  DependencyGraphConfig
} from '../primitives/types.js'

/**
 * DependencyGraphManager - C-02
 * Build, validate, and schedule agent execution order per DependencyEdge DAG with TTL.
 *
 * Dependencies: P-04 (MessageBus), P-19 (TicketSystem)
 */
export class DependencyGraphManager {
  private messageBus: MessageBus
  private ticketSystem: TicketSystem
  private config: DependencyGraphConfig

  constructor(
    messageBus: MessageBus,
    ticketSystem: TicketSystem,
    config?: Partial<DependencyGraphConfig>
  ) {
    this.messageBus = messageBus
    this.ticketSystem = ticketSystem
    this.config = {
      enable_ttl_monitoring: config?.enable_ttl_monitoring ?? true,
      default_timeout_behavior: config?.default_timeout_behavior ?? 'fail'
    }
  }

  /**
   * Validate dependency graph for cycles and orphans
   * @param graph - Dependency graph to validate
   * @param root_id - Optional root node ID for orphan detection
   * @returns ValidationResult with cycles, orphans, and errors
   */
  validate(graph: DependencyGraph, root_id?: string): ValidationResult {
    const cycles = this.detectCycles(graph)
    const orphans = root_id ? this.detectOrphans(graph, root_id) : []

    const errors: string[] = []
    const valid = cycles.length === 0 && orphans.length === 0

    if (cycles.length > 0) {
      errors.push(`Detected ${cycles.length} cycle(s) in dependency graph`)
      this.messageBus.emit(graph.run_id, 'dependency_graph_cycle_detected', {
        cycles
      })
      this.ticketSystem.file(
        'infrastructure_failure',
        {
          run_id: graph.run_id,
          cycles,
          message: `Dependency graph contains ${cycles.length} cycle(s)`
        }
      )
    }

    if (orphans.length > 0) {
      errors.push(`Detected ${orphans.length} orphan node(s)`)
      this.messageBus.emit(graph.run_id, 'dependency_graph_orphan_detected', {
        orphans
      })
      this.ticketSystem.file(
        'infrastructure_failure',
        {
          run_id: graph.run_id,
          orphans,
          message: `Dependency graph contains ${orphans.length} orphan node(s)`
        }
      )
    }

    return {
      valid,
      cycles,
      orphans,
      errors
    }
  }

  /**
   * Detect cycles in dependency graph using DFS
   * @param graph - Dependency graph
   * @returns Array of cycles, where each cycle is an array of node IDs
   */
  detectCycles(graph: DependencyGraph): string[][] {
    const adjList = this.buildAdjacencyList(graph)
    const visited = new Set<string>()
    const recStack = new Set<string>()
    const cycles: string[][] = []

    for (const node of graph.nodes) {
      if (!visited.has(node)) {
        const cycle = this.dfsCycleDetect(node, visited, recStack, adjList, [])
        if (cycle) {
          cycles.push(cycle)
        }
      }
    }

    return cycles
  }

  /**
   * Detect orphan nodes (unreachable from root)
   * @param graph - Dependency graph
   * @param root_id - Root node ID
   * @returns Array of orphan node IDs
   */
  detectOrphans(graph: DependencyGraph, root_id: string): string[] {
    const adjList = this.buildAdjacencyList(graph)
    const reachable = this.reachableFromRoot(root_id, adjList)
    const orphans: string[] = []

    for (const node of graph.nodes) {
      if (node !== root_id && !reachable.has(node)) {
        orphans.push(node)
      }
    }

    return orphans
  }

  /**
   * Topological sort using Kahn's algorithm
   * @param graph - Dependency graph
   * @returns TopologicalOrder with execution order and depth levels
   */
  topologicalSort(graph: DependencyGraph): TopologicalOrder {
    const adjList = this.buildAdjacencyList(graph)
    const inDegree = new Map<string, number>()
    const levels = new Map<string, number>()

    // Initialize in-degrees
    for (const node of graph.nodes) {
      inDegree.set(node, 0)
      levels.set(node, 0)
    }

    // Calculate in-degrees
    for (const edge of graph.edges) {
      inDegree.set(edge.to_node_id, (inDegree.get(edge.to_node_id) ?? 0) + 1)
    }

    // Queue nodes with in-degree 0
    const queue: string[] = []
    for (const node of graph.nodes) {
      if (inDegree.get(node) === 0) {
        queue.push(node)
      }
    }

    const order: string[] = []

    while (queue.length > 0) {
      const node = queue.shift()!
      order.push(node)

      const neighbors = adjList.get(node) ?? []
      for (const neighbor of neighbors) {
        const newInDegree = (inDegree.get(neighbor) ?? 0) - 1
        inDegree.set(neighbor, newInDegree)

        // Update level
        const currentLevel = levels.get(node) ?? 0
        const neighborLevel = levels.get(neighbor) ?? 0
        levels.set(neighbor, Math.max(neighborLevel, currentLevel + 1))

        if (newInDegree === 0) {
          queue.push(neighbor)
        }
      }
    }

    return { order, levels }
  }

  /**
   * Get cancellation order (reverse topological order - leaves first)
   * @param graph - Dependency graph
   * @returns Array of node IDs in cancellation order
   */
  getCancellationOrder(graph: DependencyGraph): string[] {
    const topOrder = this.topologicalSort(graph)
    const cancellationOrder = [...topOrder.order].reverse()

    this.messageBus.emit(graph.run_id, 'dependency_graph_cancellation_order_computed', {
      order: cancellationOrder
    })

    return cancellationOrder
  }

  /**
   * Check if TTL has expired for an edge
   * @param edge - Dependency edge
   * @param startTime - Start timestamp (ms)
   * @param currentTime - Current timestamp (ms)
   * @returns True if expired, false otherwise
   */
  checkTTLExpiry(edge: DependencyEdge, startTime: number, currentTime: number): boolean {
    if (!edge.timeout_ms) {
      return false
    }

    return (currentTime - startTime) > edge.timeout_ms
  }

  /**
   * Fire TTL timeout behavior
   * @param edge - Dependency edge
   * @returns Timeout result with behavior and fallback payload
   */
  fireTTLTimeout(edge: DependencyEdge, run_id?: string): { behavior: string; fallback_payload?: any } {
    const behavior = edge.on_timeout ?? this.config.default_timeout_behavior
    const rid = run_id ?? 'unknown'

    this.messageBus.emit(rid, 'dependency_edge_ttl_expired', {
      from_node_id: edge.from_node_id,
      to_node_id: edge.to_node_id,
      timeout_ms: edge.timeout_ms,
      on_timeout: behavior
    })

    if (behavior === 'proceed_degraded') {
      this.messageBus.emit(rid, 'dependency_edge_fallback_injected', {
        from_node_id: edge.from_node_id,
        to_node_id: edge.to_node_id,
        fallback_payload: edge.fallback_payload
      })

      return {
        behavior,
        fallback_payload: edge.fallback_payload
      }
    }

    return { behavior }
  }

  // Private helper methods

  /**
   * Build adjacency list from graph edges
   */
  private buildAdjacencyList(graph: DependencyGraph): Map<string, string[]> {
    const adjList = new Map<string, string[]>()

    // Initialize empty adjacency lists
    for (const node of graph.nodes) {
      adjList.set(node, [])
    }

    // Build adjacency list from edges
    for (const edge of graph.edges) {
      const neighbors = adjList.get(edge.from_node_id) ?? []
      neighbors.push(edge.to_node_id)
      adjList.set(edge.from_node_id, neighbors)
    }

    return adjList
  }

  /**
   * DFS cycle detection
   * @returns Cycle path if found, null otherwise
   */
  private dfsCycleDetect(
    node: string,
    visited: Set<string>,
    recStack: Set<string>,
    adjList: Map<string, string[]>,
    path: string[]
  ): string[] | null {
    visited.add(node)
    recStack.add(node)
    path.push(node)

    const neighbors = adjList.get(node) ?? []
    for (const neighbor of neighbors) {
      if (!visited.has(neighbor)) {
        const cycle = this.dfsCycleDetect(neighbor, visited, recStack, adjList, path)
        if (cycle) {
          return cycle
        }
      } else if (recStack.has(neighbor)) {
        // Found cycle - extract cycle path
        const cycleStartIndex = path.indexOf(neighbor)
        const cyclePath = path.slice(cycleStartIndex)
        cyclePath.push(neighbor) // Close the cycle
        return cyclePath
      }
    }

    recStack.delete(node)
    path.pop()
    return null
  }

  /**
   * Find all nodes reachable from root using BFS
   */
  private reachableFromRoot(root_id: string, adjList: Map<string, string[]>): Set<string> {
    const reachable = new Set<string>()
    const queue = [root_id]
    reachable.add(root_id)

    while (queue.length > 0) {
      const node = queue.shift()!
      const neighbors = adjList.get(node) ?? []

      for (const neighbor of neighbors) {
        if (!reachable.has(neighbor)) {
          reachable.add(neighbor)
          queue.push(neighbor)
        }
      }
    }

    return reachable
  }
}
