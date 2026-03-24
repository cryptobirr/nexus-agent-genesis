import { describe, it, expect, beforeEach, vi } from 'vitest'
import { SandboxEnforcer } from './sandbox-enforcer.js'
import { ToolRegistry } from '../primitives/tool-registry.js'
import { MessageBus } from '../primitives/message-bus.js'
import { TicketSystem } from '../primitives/ticket-system.js'
import type {
  Tool,
  InjectedToolset,
  ToolCall,
  ToolExecutionResult,
  SandboxConfig
} from '../primitives/types.js'

describe('SandboxEnforcer - C-05', () => {
  let toolRegistry: ToolRegistry
  let messageBus: MessageBus
  let ticketSystem: TicketSystem
  let enforcer: SandboxEnforcer

  // Mock tool executor function
  const createMockExecutor = (returnValue: any = { result: 'success' }, shouldFail = false) => {
    return vi.fn(async (tool_id: string, input: any) => {
      if (shouldFail) throw new Error('Tool execution failed')
      return returnValue
    })
  }

  beforeEach(() => {
    toolRegistry = new ToolRegistry()
    messageBus = new MessageBus()
    ticketSystem = new TicketSystem(messageBus)
    enforcer = new SandboxEnforcer(toolRegistry, messageBus, ticketSystem)
  })

  describe('Tool access isolation', () => {
    it('should reject tool call outside injected subset', async () => {
      // Register tools
      const toolA: Tool = {
        tool_id: 'tool_a',
        input_schema: { type: 'object' },
        output_schema: { type: 'object' },
        side_effect_class: 'query'
      }
      const toolB: Tool = {
        tool_id: 'tool_b',
        input_schema: { type: 'object' },
        output_schema: { type: 'object' },
        side_effect_class: 'query'
      }
      toolRegistry.register(toolA)
      toolRegistry.register(toolB)

      // Inject only tool_a
      const injectedToolset = toolRegistry.inject('agent_1', ['tool_a'])

      // Attempt to call tool_b (not in injected subset)
      const toolCall: ToolCall = {
        tool_id: 'tool_b',
        input: {},
        agent_id: 'agent_1'
      }

      const executor = createMockExecutor()
      const result = await enforcer.executeToolWithEnforcement(
        toolCall,
        injectedToolset,
        executor,
        'run_1'
      )

      // Assert failure
      expect(result.success).toBe(false)
      expect(result.failure_type).toBe('tool_failure')
      expect(result.error).toContain('not in injected toolset')

      // Assert executor was NOT called
      expect(executor).not.toHaveBeenCalled()

      // Assert ticket filed
      const tickets = ticketSystem.list('run_1')
      expect(tickets).toHaveLength(1)
      expect(tickets[0].ticket_type).toBe('sandbox_violation')
    })
  })

  describe('Sandbox violation policy enforcement', () => {
    it('should apply "error" policy on violation', async () => {
      const config: SandboxConfig = {
        enabled: true,
        tool_execution: 'isolated',
        data_access: 'scoped',
        on_violation: 'error'
      }
      enforcer = new SandboxEnforcer(toolRegistry, messageBus, ticketSystem, config)

      const tool: Tool = {
        tool_id: 'tool_a',
        input_schema: { type: 'object' },
        output_schema: { type: 'object' },
        side_effect_class: 'query'
      }
      toolRegistry.register(tool)
      const injectedToolset = toolRegistry.inject('agent_1', ['tool_a'])

      // Attempt unauthorized tool
      const toolCall: ToolCall = {
        tool_id: 'tool_b',
        input: {},
        agent_id: 'agent_1'
      }

      const executor = createMockExecutor()
      const result = await enforcer.executeToolWithEnforcement(
        toolCall,
        injectedToolset,
        executor,
        'run_1'
      )

      expect(result.success).toBe(false)
      expect(result.error).toBeDefined()
    })
  })

  describe('Disabled sandbox (test mode)', () => {
    it('should bypass all validation when enabled=false', async () => {
      const config: SandboxConfig = {
        enabled: false,
        tool_execution: 'isolated',
        data_access: 'scoped',
        on_violation: 'error'
      }
      enforcer = new SandboxEnforcer(toolRegistry, messageBus, ticketSystem, config)

      // Register tool_a
      const tool: Tool = {
        tool_id: 'tool_a',
        input_schema: { type: 'object', properties: { x: { type: 'number' } }, required: ['x'] },
        output_schema: { type: 'object' },
        side_effect_class: 'query'
      }
      toolRegistry.register(tool)
      const injectedToolset = toolRegistry.inject('agent_1', ['tool_a'])

      // Attempt tool_b (not in toolset) with invalid input
      const toolCall: ToolCall = {
        tool_id: 'tool_b',
        input: { x: 'invalid' },  // Invalid input
        agent_id: 'agent_1'
      }

      const executor = createMockExecutor({ output: 'success' })
      const result = await enforcer.executeToolWithEnforcement(
        toolCall,
        injectedToolset,
        executor,
        'run_1'
      )

      // Should succeed - validation bypassed
      expect(result.success).toBe(true)
      expect(result.output).toEqual({ output: 'success' })
      expect(executor).toHaveBeenCalledWith('tool_b', { x: 'invalid' })

      // No tickets filed
      const tickets = ticketSystem.list('run_1')
      expect(tickets).toHaveLength(0)
    })
  })

  describe('Input schema validation', () => {
    it('should reject tool call with invalid input schema', async () => {
      const tool: Tool = {
        tool_id: 'tool_a',
        input_schema: {
          type: 'object',
          properties: { x: { type: 'number' } },
          required: ['x']
        },
        output_schema: { type: 'object' },
        side_effect_class: 'query'
      }
      toolRegistry.register(tool)
      const injectedToolset = toolRegistry.inject('agent_1', ['tool_a'])

      // Invalid input (x should be number, not string)
      const toolCall: ToolCall = {
        tool_id: 'tool_a',
        input: { x: 'invalid_string' },
        agent_id: 'agent_1'
      }

      const executor = createMockExecutor()
      const result = await enforcer.executeToolWithEnforcement(
        toolCall,
        injectedToolset,
        executor,
        'run_1'
      )

      // Assert failure
      expect(result.success).toBe(false)
      expect(result.failure_type).toBe('tool_failure')
      expect(result.error).toContain('input validation failed')

      // Assert executor was NOT called
      expect(executor).not.toHaveBeenCalled()
    })

    it('should allow valid input schema', async () => {
      const tool: Tool = {
        tool_id: 'tool_a',
        input_schema: {
          type: 'object',
          properties: { x: { type: 'number' } },
          required: ['x']
        },
        output_schema: { type: 'object' },
        side_effect_class: 'query'
      }
      toolRegistry.register(tool)
      const injectedToolset = toolRegistry.inject('agent_1', ['tool_a'])

      const toolCall: ToolCall = {
        tool_id: 'tool_a',
        input: { x: 42 },
        agent_id: 'agent_1'
      }

      const executor = createMockExecutor({ result: 'success' })
      const result = await enforcer.executeToolWithEnforcement(
        toolCall,
        injectedToolset,
        executor,
        'run_1'
      )

      expect(result.success).toBe(true)
      expect(executor).toHaveBeenCalledWith('tool_a', { x: 42 })
    })
  })

  describe('Output schema validation', () => {
    it('should reject tool output that violates output_schema', async () => {
      const tool: Tool = {
        tool_id: 'tool_a',
        input_schema: { type: 'object' },
        output_schema: {
          type: 'object',
          properties: { y: { type: 'boolean' } },
          required: ['y']
        },
        side_effect_class: 'query'
      }
      toolRegistry.register(tool)
      const injectedToolset = toolRegistry.inject('agent_1', ['tool_a'])

      const toolCall: ToolCall = {
        tool_id: 'tool_a',
        input: {},
        agent_id: 'agent_1'
      }

      // Executor returns invalid output (y should be boolean, not number)
      const executor = createMockExecutor({ y: 123 })
      const result = await enforcer.executeToolWithEnforcement(
        toolCall,
        injectedToolset,
        executor,
        'run_1'
      )

      expect(result.success).toBe(false)
      expect(result.failure_type).toBe('tool_failure')
      expect(result.error).toContain('output validation failed')
    })

    it('should allow valid output schema', async () => {
      const tool: Tool = {
        tool_id: 'tool_a',
        input_schema: { type: 'object' },
        output_schema: {
          type: 'object',
          properties: { y: { type: 'boolean' } },
          required: ['y']
        },
        side_effect_class: 'query'
      }
      toolRegistry.register(tool)
      const injectedToolset = toolRegistry.inject('agent_1', ['tool_a'])

      const toolCall: ToolCall = {
        tool_id: 'tool_a',
        input: {},
        agent_id: 'agent_1'
      }

      const executor = createMockExecutor({ y: true })
      const result = await enforcer.executeToolWithEnforcement(
        toolCall,
        injectedToolset,
        executor,
        'run_1'
      )

      expect(result.success).toBe(true)
      expect(result.output).toEqual({ y: true })
    })
  })

  describe('Destructive tool no-retry', () => {
    it('should NOT retry destructive tool even if retry_on_error=true', async () => {
      const tool: Tool = {
        tool_id: 'tool_a',
        input_schema: { type: 'object' },
        output_schema: { type: 'object' },
        side_effect_class: 'destructive',
        retry_on_error: true  // Should be ignored
      }
      toolRegistry.register(tool)
      const injectedToolset = toolRegistry.inject('agent_1', ['tool_a'])

      const toolCall: ToolCall = {
        tool_id: 'tool_a',
        input: {},
        agent_id: 'agent_1'
      }

      const executor = createMockExecutor(null, true)  // Always fails
      const result = await enforcer.executeToolWithEnforcement(
        toolCall,
        injectedToolset,
        executor,
        'run_1'
      )

      expect(result.success).toBe(false)
      expect(result.retry_attempted).toBe(false)
      expect(executor).toHaveBeenCalledTimes(1)  // Called exactly once
    })
  })

  describe('Non-destructive retry_on_error', () => {
    it('should retry non-destructive tool exactly once when retry_on_error=true', async () => {
      const tool: Tool = {
        tool_id: 'tool_a',
        input_schema: { type: 'object' },
        output_schema: { type: 'object' },
        side_effect_class: 'query',
        retry_on_error: true
      }
      toolRegistry.register(tool)
      const injectedToolset = toolRegistry.inject('agent_1', ['tool_a'])

      const toolCall: ToolCall = {
        tool_id: 'tool_a',
        input: {},
        agent_id: 'agent_1'
      }

      const executor = createMockExecutor(null, true)  // Always fails
      const result = await enforcer.executeToolWithEnforcement(
        toolCall,
        injectedToolset,
        executor,
        'run_1'
      )

      expect(result.success).toBe(false)
      expect(result.retry_attempted).toBe(true)
      expect(executor).toHaveBeenCalledTimes(2)  // Initial + 1 retry
    })

    it('should NOT retry when retry_on_error=false', async () => {
      const tool: Tool = {
        tool_id: 'tool_a',
        input_schema: { type: 'object' },
        output_schema: { type: 'object' },
        side_effect_class: 'query',
        retry_on_error: false
      }
      toolRegistry.register(tool)
      const injectedToolset = toolRegistry.inject('agent_1', ['tool_a'])

      const toolCall: ToolCall = {
        tool_id: 'tool_a',
        input: {},
        agent_id: 'agent_1'
      }

      const executor = createMockExecutor(null, true)
      const result = await enforcer.executeToolWithEnforcement(
        toolCall,
        injectedToolset,
        executor,
        'run_1'
      )

      expect(result.success).toBe(false)
      expect(result.retry_attempted).toBe(false)
      expect(executor).toHaveBeenCalledTimes(1)
    })

    it('should succeed on retry if second attempt succeeds', async () => {
      const tool: Tool = {
        tool_id: 'tool_a',
        input_schema: { type: 'object' },
        output_schema: { type: 'object' },
        side_effect_class: 'query',
        retry_on_error: true
      }
      toolRegistry.register(tool)
      const injectedToolset = toolRegistry.inject('agent_1', ['tool_a'])

      const toolCall: ToolCall = {
        tool_id: 'tool_a',
        input: {},
        agent_id: 'agent_1'
      }

      // First call fails, second succeeds
      let callCount = 0
      const executor = vi.fn(async () => {
        callCount++
        if (callCount === 1) throw new Error('First attempt failed')
        return { success: true }
      })

      const result = await enforcer.executeToolWithEnforcement(
        toolCall,
        injectedToolset,
        executor,
        'run_1'
      )

      expect(result.success).toBe(true)
      expect(result.retry_attempted).toBe(true)
      expect(result.output).toEqual({ success: true })
      expect(executor).toHaveBeenCalledTimes(2)
    })
  })

  describe('Event emission', () => {
    it('should emit sandbox_violation event on access violation', async () => {
      const eventSpy = vi.fn()
      messageBus.subscribe('run_1', 'sandbox_violation', eventSpy)

      const tool: Tool = {
        tool_id: 'tool_a',
        input_schema: { type: 'object' },
        output_schema: { type: 'object' },
        side_effect_class: 'query'
      }
      toolRegistry.register(tool)
      const injectedToolset = toolRegistry.inject('agent_1', ['tool_a'])

      const toolCall: ToolCall = {
        tool_id: 'tool_b',  // Not in toolset
        input: {},
        agent_id: 'agent_1'
      }

      const executor = createMockExecutor()
      await enforcer.executeToolWithEnforcement(toolCall, injectedToolset, executor, 'run_1')

      expect(eventSpy).toHaveBeenCalled()
    })
  })
})
