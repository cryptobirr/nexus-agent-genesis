import type { VersionedStore } from '../primitives/versioned-store.js'
import type { MessageBus } from '../primitives/message-bus.js'
import type { TicketSystem } from '../primitives/ticket-system.js'
import type {
  SECEntry,
  SECSnapshot,
  SECConfig,
  ConflictResolutionPolicy,
  AgentRole,
  WriteResult,
  ReadResult,
  ConflictInfo
} from '../primitives/types.js'

/**
 * SECManager - C-01
 * Full Shared Execution Context lifecycle with OCC write protocol,
 * conflict resolution, executor read access, and snapshot reads.
 *
 * Dependencies: P-02 (VersionedStore), P-04 (MessageBus), P-19 (TicketSystem)
 */
export class SECManager {
  private versionedStore: VersionedStore
  private messageBus: MessageBus
  private ticketSystem: TicketSystem
  private config: SECConfig
  private sizeWarningEmitted = new Set<string>() // Track runs that already emitted warning
  private agentIdMap = new Map<string, string>() // key → agent_id (for merge logic)

  constructor(
    versionedStore: VersionedStore,
    messageBus: MessageBus,
    ticketSystem: TicketSystem,
    config?: Partial<SECConfig>
  ) {
    this.versionedStore = versionedStore
    this.messageBus = messageBus
    this.ticketSystem = ticketSystem
    this.config = {
      max_occ_retries: config?.max_occ_retries ?? 2,
      SEC_list_max_entries: config?.SEC_list_max_entries ?? 10000,
      default_policy: config?.default_policy ?? 'merge'
    }
  }

  /**
   * Write a value to SEC with OCC protocol
   *
   * @param key - SEC key
   * @param value - Value to write
   * @param run_id - Run identifier
   * @param agent_id - Agent identifier
   * @param role - Agent role (planner, executor, router)
   * @param policy - Conflict resolution policy (default: merge)
   * @returns WriteResult with success status, version_id, or conflict info
   */
  write(
    key: string,
    value: any,
    run_id: string,
    agent_id: string,
    role: AgentRole,
    policy?: ConflictResolutionPolicy
  ): WriteResult {
    // Access control: executors cannot write
    if (role === 'executor') {
      return {
        success: false,
        conflict: {
          key,
          attempted_value: value,
          current_value: null,
          current_version_id: 0
        }
      }
    }

    const resolutionPolicy = policy ?? this.config.default_policy
    const original_value = value // Save original for conflict detection
    let retryCount = 0

    // OCC write loop with retry
    while (retryCount <= this.config.max_occ_retries) {
      // Read current version
      const current = this.versionedStore.get(key)
      const expected_version_id = current?.version_id ?? 0

      // Attempt CAS write
      const casResult = this.versionedStore.cas(key, expected_version_id, value, run_id)

      if (casResult.success) {
        // Write succeeded - store agent_id for merge logic
        this.agentIdMap.set(key, agent_id)
        this.checkSizeLimit(run_id)

        // Check if structural change occurred (for merge policy)
        const requires_redecompose = current && this.isStructurallyDifferent(current.value, value)

        return {
          success: true,
          version_id: casResult.current_version_id,
          requires_redecompose
        }
      }

      // Write failed - conflict detected
      retryCount++

      // Handle conflict based on policy
      const currentEntry = this.versionedStore.get(key)
      if (!currentEntry) {
        // Key was deleted between read and write - rare edge case, retry
        continue
      }

      // Policy: reject - return conflict immediately
      if (resolutionPolicy === 'reject') {
        return {
          success: false,
          conflict: {
            key,
            attempted_value: original_value,
            current_value: currentEntry.value,
            current_version_id: currentEntry.version_id
          }
        }
      }

      // Policy: escalate - file ticket immediately
      if (resolutionPolicy === 'escalate') {
        this.fileOCCMaxRetriesTicket(run_id, agent_id, key)
        return {
          success: false,
          escalated: true
        }
      }

      // Policy: merge - attempt merge and retry
      if (resolutionPolicy === 'merge') {
        // Check if max retries exceeded BEFORE attempting merge
        if (retryCount > this.config.max_occ_retries) {
          this.fileOCCMaxRetriesTicket(run_id, agent_id, key)
          return {
            success: false,
            escalated: true
          }
        }

        // Get current agent_id for merge
        // If not in map yet, extract from run_id or use a default
        const current_agent_id = this.agentIdMap.get(key) || currentEntry.run_id

        // Attempt merge
        const mergeResult = this.attemptMerge(original_value, currentEntry.value, agent_id, current_agent_id)

        if (!mergeResult.success) {
          // Merge failed (type mismatch) - fallback to reject
          return {
            success: false,
            conflict: {
              key,
              attempted_value: original_value,
              current_value: currentEntry.value,
              current_version_id: currentEntry.version_id
            }
          }
        }

        // Update value for next retry
        value = mergeResult.merged_value
        continue
      }

      // Unknown policy - treat as reject
      return {
        success: false,
        conflict: {
          key,
          attempted_value: original_value,
          current_value: currentEntry.value,
          current_version_id: currentEntry.version_id
        }
      }
    }

    // Should never reach here, but return escalated as fallback
    return {
      success: false,
      escalated: true
    }
  }

  /**
   * Read a value from SEC with access control
   *
   * @param key - SEC key
   * @param agent_id - Agent identifier (unused for now, for future access control)
   * @param role - Agent role (unused for now, all roles can read)
   * @returns ReadResult with value and version_id, or null if not found
   */
  read(key: string, agent_id: string, role: AgentRole): ReadResult | null {
    const entry = this.versionedStore.get(key)
    if (!entry) {
      return null
    }

    return {
      value: entry.value,
      version_id: entry.version_id
    }
  }

  /**
   * Snapshot read: consistent version_id across multiple keys
   *
   * @param keys - Array of keys to read
   * @param run_id - Run identifier (unused, for future filtering)
   * @returns Map of key → version_id
   */
  snapshotRead(keys: string[], run_id: string): SECSnapshot {
    return this.versionedStore.snapshot_read(keys)
  }

  /**
   * List all entries for a run
   *
   * @param run_id - Run identifier
   * @returns Array of SEC entries
   */
  list(run_id: string): SECEntry[] {
    const entries = this.versionedStore.list(run_id)
    this.checkSizeLimit(run_id)
    return entries
  }

  /**
   * Attempt to merge two values
   *
   * @param attempted_value - Value being written
   * @param current_value - Current value in store
   * @param attempting_agent_id - Agent attempting write
   * @param current_agent_id - Agent who wrote current value
   * @returns Merge result with success flag and merged value
   */
  private attemptMerge(
    attempted_value: any,
    current_value: any,
    attempting_agent_id: string,
    current_agent_id: string
  ): { success: boolean; merged_value?: any } {
    // Type checking
    const attemptedType = this.getType(attempted_value)
    const currentType = this.getType(current_value)

    if (attemptedType !== currentType) {
      // Type mismatch - fallback to reject
      return { success: false }
    }

    if (attemptedType === 'object') {
      // Merge objects: first-writer-wins per key
      // Current value has lower version_id (it was written first)
      // So current value wins for all its keys, we only add new keys from attempted
      const merged = { ...current_value }

      // Add new keys from attempted value
      for (const key of Object.keys(attempted_value)) {
        if (!(key in current_value)) {
          merged[key] = attempted_value[key]
        }
      }

      return { success: true, merged_value: merged }
    }

    if (attemptedType === 'array') {
      // Merge arrays: lexicographic order by agent_id
      const combined = [
        { agent_id: current_agent_id, items: current_value },
        { agent_id: attempting_agent_id, items: attempted_value }
      ]

      // Sort by agent_id lexicographically
      combined.sort((a, b) => a.agent_id.localeCompare(b.agent_id))

      // Flatten in sorted order
      const merged = combined.flatMap(entry => entry.items)

      return { success: true, merged_value: merged }
    }

    // Primitive types - no merge, first-writer-wins
    return { success: true, merged_value: current_value }
  }

  /**
   * Get type of value for merge logic
   */
  private getType(value: any): 'object' | 'array' | 'primitive' {
    if (Array.isArray(value)) {
      return 'array'
    }
    if (value !== null && typeof value === 'object') {
      return 'object'
    }
    return 'primitive'
  }

  /**
   * Check if two values are structurally different
   * (different keys for objects, different length for arrays)
   */
  private isStructurallyDifferent(value1: any, value2: any): boolean {
    const type1 = this.getType(value1)
    const type2 = this.getType(value2)

    if (type1 !== type2) {
      return true
    }

    if (type1 === 'object') {
      const keys1 = Object.keys(value1).sort()
      const keys2 = Object.keys(value2).sort()
      return JSON.stringify(keys1) !== JSON.stringify(keys2)
    }

    if (type1 === 'array') {
      return value1.length !== value2.length
    }

    return false
  }

  /**
   * Check if SEC size exceeds limit and emit warning
   */
  private checkSizeLimit(run_id: string): void {
    const entries = this.versionedStore.list(run_id)

    if (entries.length > this.config.SEC_list_max_entries) {
      // Only emit once per run
      if (!this.sizeWarningEmitted.has(run_id)) {
        this.sizeWarningEmitted.add(run_id)

        // Emit event
        this.messageBus.emit(run_id, 'sec_size_warning', {
          run_id,
          entry_count: entries.length,
          limit: this.config.SEC_list_max_entries
        })

        // File ticket
        this.ticketSystem.file('sec_size_warning', {
          run_id,
          entry_count: entries.length,
          limit: this.config.SEC_list_max_entries
        })
      }
    }
  }

  /**
   * File a CRITICAL ticket for OCC max retries exceeded
   */
  private fileOCCMaxRetriesTicket(run_id: string, agent_id: string, key: string): void {
    this.ticketSystem.file('occ_max_retries_exceeded', {
      run_id,
      agent_id,
      key,
      max_retries: this.config.max_occ_retries
    })
  }
}
