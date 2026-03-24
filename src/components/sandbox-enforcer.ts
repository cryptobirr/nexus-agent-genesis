import Ajv, { type ValidateFunction } from 'ajv'
import type { ToolRegistry } from '../primitives/tool-registry.js'
import type { MessageBus } from '../primitives/message-bus.js'
import type { TicketSystem } from '../primitives/ticket-system.js'
import type {
  Tool,
  InjectedToolset,
  ToolCall,
  ToolExecutionResult,
  SandboxConfig,
  FailureType
} from '../primitives/types.js'

/**
 * SandboxEnforcer - C-05
 * Runtime tool isolation, data access scoping, and tool contract enforcement per SandboxConfig.
 *
 * Dependencies: P-05 (ToolRegistry), P-04 (MessageBus), P-19 (TicketSystem)
 */
export class SandboxEnforcer {
  private toolRegistry: ToolRegistry
  private messageBus: MessageBus
  private ticketSystem: TicketSystem
  private config: SandboxConfig
  private ajv: Ajv
  private schemaCache = new Map<string, ValidateFunction>()

  constructor(
    toolRegistry: ToolRegistry,
    messageBus: MessageBus,
    ticketSystem: TicketSystem,
    config?: Partial<SandboxConfig>
  ) {
    this.toolRegistry = toolRegistry
    this.messageBus = messageBus
    this.ticketSystem = ticketSystem
    this.config = {
      enabled: config?.enabled ?? true,
      tool_execution: config?.tool_execution ?? 'isolated',
      data_access: config?.data_access ?? 'scoped',
      network_policy: config?.network_policy,
      on_violation: config?.on_violation ?? 'error'
    }
    this.ajv = new Ajv({ strict: false })
  }

  /**
   * Execute tool call with full sandbox enforcement
   *
   * Pipeline:
   * 1. Check if sandbox enabled (bypass if false)
   * 2. Validate tool access (must be in injectedToolset)
   * 3. Validate input against input_schema
   * 4. Execute tool via external executor
   * 5. Validate output against output_schema
   * 6. Handle retry logic (retry_on_error, side_effect_class)
   *
   * @param toolCall - Tool invocation request
   * @param injectedToolset - Scoped toolset for this agent
   * @param executor - External function that executes the tool
   * @param run_id - Run identifier
   * @returns ToolExecutionResult with success status and output/error
   */
  async executeToolWithEnforcement(
    toolCall: ToolCall,
    injectedToolset: InjectedToolset,
    executor: (tool_id: string, input: any) => Promise<any>,
    run_id: string
  ): Promise<ToolExecutionResult> {
    // Bypass all validation if sandbox disabled
    if (!this.config.enabled) {
      try {
        const output = await executor(toolCall.tool_id, toolCall.input)
        return { success: true, output }
      } catch (error: any) {
        return { success: false, error: error.message }
      }
    }

    // 1. Validate tool access
    const accessValidation = this.validateToolAccess(toolCall.tool_id, injectedToolset)
    if (!accessValidation.valid) {
      this.handleViolation('tool_access_violation', {
        tool_id: toolCall.tool_id,
        agent_id: toolCall.agent_id,
        error: accessValidation.error
      }, run_id)

      return {
        success: false,
        error: accessValidation.error,
        failure_type: 'tool_failure'
      }
    }

    // Get tool definition for schema validation
    const tool = injectedToolset.get(toolCall.tool_id)

    // 2. Validate input schema
    const inputValidation = this.validateSchema(tool.input_schema, toolCall.input, 'input')
    if (!inputValidation.valid) {
      return {
        success: false,
        error: `Tool ${toolCall.tool_id} input validation failed: ${inputValidation.error}`,
        failure_type: 'tool_failure'
      }
    }

    // 3. Execute tool with retry logic
    return await this.executeWithRetry(tool, toolCall.input, executor, run_id)
  }

  /**
   * Execute tool with retry logic based on retry_on_error and side_effect_class
   */
  private async executeWithRetry(
    tool: Tool,
    input: any,
    executor: (tool_id: string, input: any) => Promise<any>,
    run_id: string
  ): Promise<ToolExecutionResult> {
    let attemptCount = 0
    let lastError: string | undefined

    while (attemptCount < 2) {  // Max 2 attempts (initial + 1 retry)
      try {
        // Execute tool
        const output = await executor(tool.tool_id, input)

        // Validate output schema
        const outputValidation = this.validateSchema(tool.output_schema, output, 'output')
        if (!outputValidation.valid) {
          return {
            success: false,
            error: `Tool ${tool.tool_id} output validation failed: ${outputValidation.error}`,
            failure_type: 'tool_failure',
            retry_attempted: attemptCount > 0
          }
        }

        // Success
        return {
          success: true,
          output,
          retry_attempted: attemptCount > 0
        }
      } catch (error: any) {
        lastError = error.message
        attemptCount++

        // Check if we should retry
        if (!this.shouldRetry(tool, attemptCount)) {
          break
        }
      }
    }

    // All attempts failed
    return {
      success: false,
      error: lastError || 'Tool execution failed',
      failure_type: 'tool_failure',
      retry_attempted: attemptCount > 1
    }
  }

  /**
   * Determine if tool should be retried
   *
   * @param tool - Tool definition
   * @param attemptCount - Number of attempts so far (1-based)
   * @returns true if should retry, false otherwise
   */
  private shouldRetry(tool: Tool, attemptCount: number): boolean {
    // Never retry if already attempted retry
    if (attemptCount > 1) return false

    // Never retry destructive tools
    if (tool.side_effect_class === 'destructive') return false

    // Retry if retry_on_error is true
    return tool.retry_on_error === true
  }

  /**
   * Validate tool access - check if tool is in injected toolset
   */
  private validateToolAccess(
    tool_id: string,
    injectedToolset: InjectedToolset
  ): { valid: boolean; error?: string } {
    if (!injectedToolset.has(tool_id)) {
      return {
        valid: false,
        error: `Tool ${tool_id} not in injected toolset`
      }
    }
    return { valid: true }
  }

  /**
   * Validate data against JSON schema using Ajv
   */
  private validateSchema(
    schema: object,
    data: any,
    schemaType: 'input' | 'output'
  ): { valid: boolean; error?: string } {
    // Get or compile schema validator
    const schemaKey = `${schemaType}:${JSON.stringify(schema)}`
    let validate = this.schemaCache.get(schemaKey)

    if (!validate) {
      validate = this.ajv.compile(schema)
      this.schemaCache.set(schemaKey, validate)
    }

    // Validate
    const valid = validate(data)

    if (!valid) {
      const errors = validate.errors?.map(e => `${e.instancePath} ${e.message}`).join(', ')
      return {
        valid: false,
        error: errors || 'Schema validation failed'
      }
    }

    return { valid: true }
  }

  /**
   * Handle sandbox violation
   *
   * @param violation_type - Type of violation
   * @param context - Violation context
   * @param run_id - Run identifier
   */
  private handleViolation(
    violation_type: string,
    context: any,
    run_id: string
  ): void {
    // File ticket
    this.ticketSystem.file('sandbox_violation', {
      run_id,
      agent_id: context.agent_id,
      violation_type,
      ...context
    })

    // Emit event (MessageBus.emit signature: run_id, event_type, payload)
    this.messageBus.emit(run_id, 'sandbox_violation', {
      violation_type,
      ...context
    })
  }
}
