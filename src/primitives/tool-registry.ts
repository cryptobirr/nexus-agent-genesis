import type { Tool, InjectedToolset } from './types.js'
import { ToolNotFoundError } from './types.js'

/**
 * ToolRegistry - P-05
 * Runtime tool declaration and scoped injection.
 *
 * Zero dependencies. Thread-safe via single-threaded event loop.
 */
export class ToolRegistry {
  private tools = new Map<string, Tool>()

  /**
   * Register a tool in the registry
   * Re-registration overwrites previous definition (idempotent)
   *
   * @param tool - Tool definition to register
   */
  register(tool: Tool): void {
    // Deep copy to prevent external mutation
    const toolCopy = this.deepCopy(tool)
    this.tools.set(tool.tool_id, toolCopy)
  }

  /**
   * Retrieve a registered tool by ID
   * Returns deep copy to prevent mutation
   *
   * @param tool_id - Tool identifier
   * @returns Tool definition
   * @throws ToolNotFoundError if tool not registered
   */
  get(tool_id: string): Tool {
    const tool = this.tools.get(tool_id)

    if (!tool) {
      throw new ToolNotFoundError(tool_id)
    }

    // Return deep copy to prevent mutation
    return this.deepCopy(tool)
  }

  /**
   * List all registered tools
   * Returns snapshot (not live reference)
   *
   * @returns Array of all registered tools
   */
  list(): Tool[] {
    // Return snapshot as array of deep copies
    return Array.from(this.tools.values()).map(tool => this.deepCopy(tool))
  }

  /**
   * Inject scoped toolset for an agent
   * Returns only the declared subset of tools
   *
   * @param agent_id - Agent identifier (for future use)
   * @param tool_ids - Tool IDs to inject
   * @returns InjectedToolset with scoped access
   * @throws ToolNotFoundError if any tool_id is not registered
   */
  inject(agent_id: string, tool_ids: string[]): InjectedToolset {
    // Validate all tools exist before injecting
    for (const tool_id of tool_ids) {
      if (!this.tools.has(tool_id)) {
        throw new ToolNotFoundError(tool_id)
      }
    }

    // Create scoped toolset with deep copies
    const injectedTools = tool_ids.map(tool_id => this.deepCopy(this.tools.get(tool_id)!))

    return {
      tools: injectedTools,

      get(tool_id: string): Tool {
        const tool = injectedTools.find(t => t.tool_id === tool_id)
        if (!tool) {
          throw new ToolNotFoundError(tool_id)
        }
        return tool
      },

      has(tool_id: string): boolean {
        return injectedTools.some(t => t.tool_id === tool_id)
      }
    }
  }

  /**
   * Deep copy helper using JSON serialization
   * Works for plain objects (schemas are plain objects)
   */
  private deepCopy<T>(obj: T): T {
    return JSON.parse(JSON.stringify(obj))
  }
}
