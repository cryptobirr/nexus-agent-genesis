import { describe, it, expect, beforeEach } from 'vitest'
import { ToolRegistry } from './tool-registry.js'
import { ToolNotFoundError } from './types.js'
import type { Tool } from './types.js'

describe('ToolRegistry', () => {
  let registry: ToolRegistry

  beforeEach(() => {
    registry = new ToolRegistry()
  })

  // Helper: Create test tool
  const createTool = (id: string): Tool => ({
    tool_id: id,
    input_schema: { type: 'object', properties: { input: { type: 'string' } } },
    output_schema: { type: 'object', properties: { output: { type: 'string' } } },
    side_effect_class: 'read'
  })

  describe('register()', () => {
    it('registers tool successfully', () => {
      const tool = createTool('test-tool')
      registry.register(tool)

      const retrieved = registry.get('test-tool')
      expect(retrieved.tool_id).toBe('test-tool')
    })

    it('preserves tool schema on registration', () => {
      const tool = createTool('schema-tool')
      registry.register(tool)

      const retrieved = registry.get('schema-tool')
      expect(retrieved.input_schema).toEqual(tool.input_schema)
      expect(retrieved.output_schema).toEqual(tool.output_schema)
      expect(retrieved.side_effect_class).toBe(tool.side_effect_class)
    })

    it('allows re-registration (idempotent)', () => {
      const tool1 = createTool('idempotent-tool')
      const tool2 = { ...createTool('idempotent-tool'), side_effect_class: 'write' }

      registry.register(tool1)
      registry.register(tool2)

      const retrieved = registry.get('idempotent-tool')
      expect(retrieved.side_effect_class).toBe('write') // Latest wins
    })
  })

  describe('get()', () => {
    it('returns registered tool by tool_id', () => {
      const tool = createTool('get-tool')
      registry.register(tool)

      const retrieved = registry.get('get-tool')
      expect(retrieved).toEqual(tool)
    })

    it('throws ToolNotFoundError on unregistered tool_id', () => {
      expect(() => {
        registry.get('nonexistent')
      }).toThrow(ToolNotFoundError)

      expect(() => {
        registry.get('nonexistent')
      }).toThrow('Tool not found: nonexistent')
    })

    it('returns deep copy (mutation isolation)', () => {
      const tool = createTool('mutation-tool')
      registry.register(tool)

      const retrieved = registry.get('mutation-tool')
      // Mutate retrieved copy
      ;(retrieved.input_schema as any).mutated = true

      // Original should be unaffected
      const retrievedAgain = registry.get('mutation-tool')
      expect((retrievedAgain.input_schema as any).mutated).toBeUndefined()
    })
  })

  describe('list()', () => {
    it('returns empty array when no tools registered', () => {
      const tools = registry.list()
      expect(tools).toEqual([])
    })

    it('returns all registered tools', () => {
      const tool1 = createTool('tool1')
      const tool2 = createTool('tool2')
      const tool3 = createTool('tool3')

      registry.register(tool1)
      registry.register(tool2)
      registry.register(tool3)

      const tools = registry.list()
      expect(tools).toHaveLength(3)
      expect(tools.map(t => t.tool_id)).toContain('tool1')
      expect(tools.map(t => t.tool_id)).toContain('tool2')
      expect(tools.map(t => t.tool_id)).toContain('tool3')
    })

    it('returns snapshot (not live reference)', () => {
      const tool = createTool('snapshot-tool')
      registry.register(tool)

      const list1 = registry.list()
      registry.register(createTool('another-tool'))
      const list2 = registry.list()

      expect(list1).toHaveLength(1)
      expect(list2).toHaveLength(2)
    })
  })

  describe('inject()', () => {
    beforeEach(() => {
      registry.register(createTool('tool-a'))
      registry.register(createTool('tool-b'))
      registry.register(createTool('tool-c'))
    })

    it('returns InjectedToolset with only declared subset', () => {
      const injected = registry.inject('agent-1', ['tool-a', 'tool-c'])

      expect(injected.tools).toHaveLength(2)
      expect(injected.tools.map(t => t.tool_id)).toContain('tool-a')
      expect(injected.tools.map(t => t.tool_id)).toContain('tool-c')
      expect(injected.tools.map(t => t.tool_id)).not.toContain('tool-b')
    })

    it('throws ToolNotFoundError if any tool_id unregistered', () => {
      expect(() => {
        registry.inject('agent-2', ['tool-a', 'nonexistent'])
      }).toThrow(ToolNotFoundError)

      expect(() => {
        registry.inject('agent-2', ['tool-a', 'nonexistent'])
      }).toThrow('Tool not found: nonexistent')
    })

    it('InjectedToolset.get() works correctly', () => {
      const injected = registry.inject('agent-3', ['tool-a', 'tool-b'])

      const toolA = injected.get('tool-a')
      expect(toolA.tool_id).toBe('tool-a')

      expect(() => {
        injected.get('tool-c') // Not in injected set
      }).toThrow(ToolNotFoundError)
    })

    it('InjectedToolset.has() works correctly', () => {
      const injected = registry.inject('agent-4', ['tool-a'])

      expect(injected.has('tool-a')).toBe(true)
      expect(injected.has('tool-b')).toBe(false)
      expect(injected.has('nonexistent')).toBe(false)
    })
  })

  describe('schema preservation', () => {
    it('preserves input_schema', () => {
      const tool: Tool = {
        tool_id: 'input-test',
        input_schema: {
          type: 'object',
          properties: {
            param1: { type: 'string' },
            param2: { type: 'number' }
          },
          required: ['param1']
        },
        output_schema: {},
        side_effect_class: 'read'
      }

      registry.register(tool)
      const retrieved = registry.get('input-test')

      expect(retrieved.input_schema).toEqual(tool.input_schema)
    })

    it('preserves output_schema', () => {
      const tool: Tool = {
        tool_id: 'output-test',
        input_schema: {},
        output_schema: {
          type: 'object',
          properties: {
            result: { type: 'string' }
          }
        },
        side_effect_class: 'write'
      }

      registry.register(tool)
      const retrieved = registry.get('output-test')

      expect(retrieved.output_schema).toEqual(tool.output_schema)
    })

    it('preserves side_effect_class', () => {
      const readTool = { ...createTool('read-tool'), side_effect_class: 'read' }
      const writeTool = { ...createTool('write-tool'), side_effect_class: 'write' }

      registry.register(readTool)
      registry.register(writeTool)

      expect(registry.get('read-tool').side_effect_class).toBe('read')
      expect(registry.get('write-tool').side_effect_class).toBe('write')
    })
  })
})
