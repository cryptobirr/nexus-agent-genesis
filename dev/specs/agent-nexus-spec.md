# Agent Nexus v5 — Implementation Specification

**Source PRD:** agent-nexus-v5.md (v5.1)
**Created:** 2026-03-23T04:48:56Z
**Method:** Component Architecture (Primitives → Components → Features → Modules → Applications)

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Component Decomposition](#2-component-decomposition)
3. [Dependency Graph](#3-dependency-graph)
4. [Sprint Delivery Plan](#4-sprint-delivery-plan)
5. [Test Readiness Matrix](#5-test-readiness-matrix)
6. [Test Strategy](#6-test-strategy)
7. [Data Contracts Reference](#7-data-contracts-reference)
8. [Non-Functional Constraints](#8-non-functional-constraints)
9. [Validation Checklist](#9-validation-checklist)
10. [CLI Invocation](#10-cli-invocation)

---

## 1. Executive Summary

Agent Nexus v5 is a production-grade autonomous agent harness. The system is pure backend — a TypeScript/Node runtime that orchestrates Router → Planner → Executor agent trees with a two-gate eval system, OCC-based shared state, and 20 composable primitives.

This spec decomposes v5 into 5 build layers over 7 sprints. Each sprint produces tested, runnable software. Infrastructure is deferred until Sprint 6 (staging) and Sprint 7 (production).

**Core architectural insight:** The 20 PRD primitives map directly to Layer 1 of the build plan. Every higher-level behavior (eval pipeline, three loops, agent state machine) is a composition of those primitives.

---

## 2. Component Decomposition

### Layer 1: Primitives (Zero dependencies — all testable immediately)

These are the 20 irreducible primitives from the PRD plus the foundational harness infrastructure they run on.

#### P-01: BudgetLedger
**Purpose:** Track and enforce token, inference, and wall-time budgets per Run.
**Interface:**
```typescript
consume(run_id, type: "tokens"|"calls"|"wall_ms", amount): void
check(run_id): BudgetState   // { remaining, exceeded, warning_threshold_hit }
reset(run_id): void
```
**Test criteria:**
- Accumulates consumption correctly
- Fires warning at configured threshold
- Marks exceeded at hard limit
- Thread-safe increment (no double-count on concurrent writes)
**Dependencies:** None

---

#### P-02: VersionedStore (SEC Backend)
**Purpose:** Atomic conditional key-value store with `version_id` semantics (CAS).
**Interface:**
```typescript
get(key): { value, version_id }
cas(key, expected_version_id, new_value): { success, current_version_id }
snapshot_read(keys[]): SECSnapshot
list(run_id): SECEntry[]
```
**Test criteria:**
- `cas` succeeds when version matches
- `cas` fails (returns `{success: false}`) when version mismatch
- `snapshot_read` returns consistent version_vector across all keys at one point in time
- `list` scoped to run_id only; implemented with run_id-scoped index — full table scans are not acceptable in production backends
- Concurrent CAS on same key: exactly one wins
**Dependencies:** None

---

#### P-03: BlobStore
**Purpose:** Run-scoped structured payload store. Bypasses context compression.
**Interface:**
```typescript
write(run_id, payload, schema): DataRef
read(ref_id): unknown   // throws BlobNotFoundError if missing
delete(ref_id): void
list(run_id): DataRef[]
```
**Behaviors:**
- Blob write must complete before the producing Executor is marked `COMPLETE`. The harness MUST NOT advance node state to `COMPLETE` until the `DataRef` is confirmed written (BS-02).
- If `read(ref_id)` fails (blob evicted or backend unavailable): classify as `tool_failure`, escalate the consuming agent, log `blob_store_dereference_failure` on the Run (BS-03).
- Multi-node deployments MUST use an external shared backend (S3, GCS, Redis Blob). The default in-memory store is explicitly unsafe for distributed runs (BS-01).
- `on_quota_exceeded: "reject_write"` in `BlobStorePolicy` is classified as `blob_write_failure` and triggers the BS-06 exponential-backoff retry path (does NOT consume Inner Loop retry budget).
**Test criteria:**
- Write returns valid DataRef with ref_id, schema, size_bytes
- Read returns exact payload written
- Read throws `BlobNotFoundError` on missing ref_id; consuming agent is escalated; `blob_store_dereference_failure` logged on Run
- List scoped to run_id
- Write fails classification: `blob_write_failure`
- Quota-exceeded write (`on_quota_exceeded: "reject_write"`) → classified as `blob_write_failure`, not eval failure
- Node state does NOT advance to `COMPLETE` before DataRef write is confirmed
**Dependencies:** None

---

#### P-04: MessageBus
**Purpose:** Event emission backbone. All harness decisions, state transitions, and tickets emit here.
**Interface:**
```typescript
emit(event_type: string, payload: object): void
subscribe(event_type, handler): Unsubscribe
replay(run_id): Event[]
```
**Test criteria:**
- Emit fires subscribed handlers
- Unsubscribe stops handler from receiving further events
- replay returns events in emission order for a run_id
- Does not lose events emitted before subscriber attaches (buffered per run)
**Dependencies:** None

---

#### P-05: ToolRegistry
**Purpose:** Runtime tool declaration and scoped injection.
**Interface:**
```typescript
register(tool: Tool): void
get(tool_id): Tool
list(): Tool[]
inject(agent_id, tool_ids[]): InjectedToolset
```
**Test criteria:**
- Registered tools retrievable by id
- `inject` returns only declared subset
- Accessing unregistered tool throws
- Tool schema (input_schema, output_schema, side_effect_class) preserved on registration
**Dependencies:** None

---

#### P-06: DomainRegistry
**Purpose:** Domain hint lookup for context assembly and model routing.
**Interface:**
```typescript
register(domain: DomainHint): void
get(domain_id): DomainHint
match(scope_text): DomainHint[]
```
**Test criteria:**
- Registered domains retrievable
- `match` returns semantically relevant domains for scope text
- Unknown domain returns empty array (not error)
**Dependencies:** None

---

#### P-07: ContractRegistry
**Purpose:** Store and version agent Contracts (sets of Dimensions with weights).
**Interface:**
```typescript
register(contract: Contract): void
get(agent_type: "router"|"planner"|"executor"): Contract
applyStrategyOverrides(contract, strategy): Contract   // weight_override + re-normalize
```
**Test criteria:**
- Contracts retrievable by agent_type
- `applyStrategyOverrides` produces weights that sum to 1.0 after normalization
- Overrides are absolute targets (not deltas)
- Dimensions not in override retain base weight before normalization
**Dependencies:** None

---

#### P-08: RequirementExtractor
**Purpose:** Parse Router output into a RequirementMap with RequirementRecords.
**Interface:**
```typescript
extract(router_output): RequirementMap
checkCoverage(map, agent_node[]): CoverageResult
computeConfidence(map): number   // (covered/total) × mean(scores)
```
**Test criteria:**
- Extracts 3–7 requirements from valid router output
- `checkCoverage` identifies covered/uncovered per RequirementRecord
- `computeConfidence` formula: `(covered/total) × mean(requirement_coverage_scores)`
- High-priority requirement guard: confidence never triggers if any `priority: "high"` requirement uncovered
**Dependencies:** None

---

#### P-09: IdempotencyCache
**Purpose:** Per-run cache keyed on `run_id + parent_id + scope_text + attempt_number`. Prevents duplicate node instantiation within same attempt.
**Interface:**
```typescript
set(key, result): void
get(key): AgentResult | null
key(run_id, parent_id, scope, attempt): string   // SHA-256 hash
```
**Test criteria:**
- Same key returns cached result on second call
- Different attempt_number produces different key
- Hash is SHA-256 or equivalent collision-resistant
**Dependencies:** None

---

#### P-10: ToolResultCache
**Purpose:** Per-run cache keyed on `run_id + tool_id + tool_input_hash`. Prevents re-execution when eval (not tool) failed.
**Interface:**
```typescript
set(run_id, tool_id, input_hash, result): void
get(run_id, tool_id, input_hash): ToolResult | null
```
**Test criteria:**
- Identical tool call returns cached result
- Different input_hash is cache miss
- Only caches tools with `idempotent: true` (default)
- Tools with `idempotent: false` bypass cache
**Dependencies:** None

---

#### P-11: EmbeddingEngine
**Purpose:** Compute and compare vector embeddings for similarity lookup (plan cache, pattern matching, low-entropy detection).
**Interface:**
```typescript
embed(text): number[]
cosineSimilarity(a: number[], b: number[]): number
topK(query_embedding, candidates: SuccessfulPattern[], k, threshold): SuccessfulPattern[]
```
**Test criteria:**
- `cosineSimilarity` returns 1.0 for identical vectors
- `cosineSimilarity` returns value in [-1, 1]
- `topK` returns at most k results above threshold
- Embedding model mismatch (different `embedding_model_id`) treated as cache miss (not error)
**Dependencies:** None

---

#### P-12: DeterministicPreCheck
**Purpose:** Zero-token structural validation of agent output before any judge fires.
**Interface:**
```typescript
run(agent_type, output): PreCheckResult   // { passed, violations: string[] }
```
**Checks by agent type:**
- Router: required fields present, routing value valid, requirements array non-empty
- Planner: decision field valid, children array non-empty, covers_requirements declared
- Executor: status field present, output or tool_call populated, evidence present for llm_output
**Test criteria:**
- Missing required field → PreCheckResult.passed = false with violation description
- Valid output → passed = true, violations empty
- Zero inference cost (no LLM calls)
**Dependencies:** None

---

#### P-13: FailureClassifier
**Purpose:** Deterministic failure type assignment before retry prompt composition.
**Interface:**
```typescript
classify(gate, dimension, signal): FailureType
buildRetryAddition(failure_type, execution_memory): string
```
**Failure taxonomy:** `retrieval_failure | reasoning_failure | planning_failure | tool_failure | timeout_failure | novelty_failure | schema_failure | infrastructure_failure | blob_write_failure`
**Test criteria:**
- Each failure condition maps to exactly one FailureType per classification table
- `infrastructure_failure` does NOT consume Inner Loop retry count
- `blob_write_failure` does NOT consume Inner Loop retry count
- `buildRetryAddition` returns type-specific template string
- Classification is zero inference cost
**Dependencies:** None

---

#### P-14: OutputNormalizer
**Purpose:** Convert Executor raw output to declared schema before pre-checks.
**Interface:**
```typescript
normalize(raw_output, output_spec: OutputSpec): NormalizationResult
// { normalized_output, passed, failure_reason }
```
**Normalization modes:**
- `strict`: schema validation + required_fields check
- `structural_only`: max_tokens compliance only
- `passthrough`: no-op
**Test criteria:**
- `json` type defaults to `strict` mode
- `text` type defaults to `structural_only`
- Schema mismatch in `strict` → `schema_failure`
- `validate` strategy: normalization failure → immediate escalation (no retry)
- No-op rule: null schema + empty required_fields + passthrough = always passes
- Runs before blob store routing (on raw in-memory output)
- Does not dereference blob store entries
**Dependencies:** None

---

#### P-15: JudgeRunner
**Purpose:** Execute a single Judge call for one Dimension. Returns Signal.
**Interface:**
```typescript
run(dimension: Dimension, context: JudgeContext): Signal
runMerged(dimensions: Dimension[], context: JudgeContext): Signal[]
```
**Merged judge behavior:**
- Single batched call, parses per-dimension verdicts from JSON array
- On malformed JSON or timeout: fall back to isolated per-dimension calls + log `merged_judge_fallback`
- If merged prompt exceeds 80% of judge model context window: auto-exclude `accuracy` from batch
**Test criteria:**
- Returns Signal with verdict, numeric_score, gap, severity, reasoning
- Prose reasoning precedes fenced JSON block; harness parses only fenced JSON
- Merged fallback fires on malformed response (not failure)
- `accuracy` auto-exclusion fires at 80% window threshold
**Dependencies:** None (makes LLM calls via injected model adapter)

---

#### P-16: ContextAssembler
**Purpose:** Retrieve and inject relevant context chunks before Executor generation.
**Interface:**
```typescript
assemble(policy: ContextAssemblyPolicy, scope, execution_memory): AssembledContext
recordFeedback(chunk_ids[], run_passed): void
```
**Behaviors:**
- Checks `ExecutionMemory.retrieved_chunks` first (cache hit = re-inject, no new call)
- Applies `ranking_model` (cross_encoder or embedding)
- Applies `diversity_penalty` (0–1 scalar)
- `feedback_loop` weight updates: atomic increment/decrement, clamped to [base×0.5, base×2.0], TTL 30 days
- `strategy: "transform"`: filter to `schema_reference` sources only; skip entirely if none
**Test criteria:**
- Cache hit re-injects without retrieval call
- `diversity_penalty` reduces near-duplicate chunk count
- Feedback weight updates commute (order-independent)
- Weight clamping enforced
- Transform strategy: no retrieval_sources → ContextAssembly skipped
**Dependencies:** P-11 (EmbeddingEngine)

---

#### P-17: ContextCompressor
**Purpose:** Bottom-up ChunkSummary generation. Blob store bypass for structured data.
**Interface:**
```typescript
compress(agent_node): ChunkSummary
```
**Behaviors:**
- Outputs with `data_refs` → include DataRef pointers in ChunkSummary, do NOT summarize content
- Text outputs → LLM-based hierarchical summarization
- Escalated nodes → never compressed, included in full in trace eval (subject to budget)
**Test criteria:**
- Nodes with `data_refs` produce ChunkSummary containing DataRef pointers, not payload content
- Text outputs produce non-empty summary string
- `is_escalated: true` on ChunkSummary for ESCALATED nodes
**Dependencies:** None (LLM calls via injected model adapter)

---

#### P-18: PlanCache
**Purpose:** Objective-indexed cache of successful Router outputs (full plan + dependency graph + requirement map).
**Interface:**
```typescript
lookup(objective_embedding, run_config_hash): PlanCacheEntry | null
write(run_id, router_output, dependency_graph, requirement_map, run_config_hash): void
invalidate(run_config_hash): void
```
**Cache hit conditions:** cosine similarity ≥ `plan_cache_similarity_threshold` (default 0.90) AND `run_config_hash` matches
**Test criteria:**
- Hit requires both similarity threshold AND config hash match
- Config hash mismatch = automatic miss
- Write only after COMPLETE trace verdict
- Hit surfaces: cached objective, similarity score, originating run_id, config hash delta
- Embedding model mismatch on `PlanCacheEntry.embedding_model_id` = cache miss
**Dependencies:** P-11 (EmbeddingEngine)

---

#### P-19: TicketSystem
**Purpose:** Structured ticket creation and routing to configured provider.
**Interface:**
```typescript
file(trigger, context: TicketContext): Ticket
route(ticket): void   // sends to configured provider (InMemory | GitHub | Jira | Linear | Webhook)
list(run_id): Ticket[]
```
**Test criteria:**
- Each trigger type in the Ticket table produces correct ticket_type and severity
- `failure_gate` and `failure_type` populated from context
- `infrastructure_failure` tickets are NOT Inner Loop triggers
- Provider routing fires for configured provider
**Dependencies:** P-04 (MessageBus)

---

#### P-20: ExecutionMemoryStore
**Purpose:** Per-node, per-run short-term cache of retrieved chunks, failed strategies, successful patterns.
**Interface:**
```typescript
init(agent_id, run_id): ExecutionMemory
appendFailedStrategy(agent_id, strategy: FailedStrategy): void
addRetrievedChunks(agent_id, chunk_ids[]): void
loadSuccessfulPatterns(agent_id, patterns: SuccessfulPattern[]): void
get(agent_id): ExecutionMemory
```
**Bounds:**
- `retrieved_chunks`: max 500, LRU eviction
- `failed_strategies`: max `max_retries`, one per attempt
- `successful_patterns`: loaded at node instantiation from Meta Loop store
**Test criteria:**
- LRU eviction fires at 500 retrieved_chunks
- `failed_strategies` capped at max_retries
- Pattern store at `pattern_store_index_threshold` (default 1,000) switches to ANN index
- Embedding model mismatch on pattern load = cache miss (not error)
- Store does NOT persist after Run completion
**Dependencies:** P-11 (EmbeddingEngine)

---

### Layer 2: Components (Composite harness units)

#### C-01: SECManager
**Purpose:** Full Shared Execution Context lifecycle — OCC write protocol, conflict resolution, Executor read access, snapshot reads.
**Composition:** P-02 (VersionedStore), P-04 (MessageBus), P-19 (TicketSystem)
**Behaviors:**
- OCC write protocol: read version_id → generate decomposition → write with version_id → retry on conflict
- `ConflictResolutionPolicy`: reject | merge | priority | escalate
- `merge` algorithm: first-writer-wins per object key; lexicographic array append by `written_by`
- Top-level type mismatch → falls back to `reject`
- OCC re-decompose bounded by `max_occ_retries` (default 2) → escalate on exceeded
- `snapshot_read` for multi-key consistent reads (eliminates mixed-version problem)
- Executors: read-only access to `readable_by: "all"` entries
- After a successful `merge`, if the merged value is structurally different from what the Planner wrote, the harness re-injects the merged value into the Planner's context as a synthetic re-read and requires a full re-decompose before children spawn
- When `list(run_id)` would return more entries than `SEC_list_max_entries` (default 10,000), log a `sec_size_warning` event and file a major ticket
**Test criteria:**
- OCC conflict: planner re-reads and re-decomposes (not blind regeneration)
- `merge` first-writer-wins: lower version_id wins per key
- `merge` array: deterministic order by agent_id lexicographic
- Type mismatch → `reject` regardless of policy
- Re-decompose prompt includes conflict summary (key, rejected value, current value)
- `max_occ_retries` exceeded → ESCALATED + critical ticket
- Executor cannot write SEC
- `merge` with structurally-changed merged value → Planner receives merged value and re-decomposes (not proceeds on stale write)
- `SEC_list_max_entries` exceeded → `sec_size_warning` event emitted + major ticket filed
**Dependencies:** P-02, P-04, P-19

---

#### C-02: DependencyGraphManager
**Purpose:** Build, validate, and schedule agent execution order per DependencyEdge DAG with TTL.
**Composition:** P-04 (MessageBus), P-19 (TicketSystem)
**Behaviors:**
- Acyclicity check (topological sort)
- Edge-level TTL: prerequisite must reach COMPLETE/ESCALATED within `timeout_ms` or `on_timeout` fires
- `on_timeout: "proceed_degraded"`: inject `fallback_payload` with label into dependent context
- `output_contract` declared on `output` edges for PLAN VALIDATOR
- Topological cancellation order for early termination (leaves first)
**Test criteria:**
- Cycle detection finds cycles, returns fatal error
- TTL expiry fires `on_timeout` behavior at correct time
- `proceed_degraded` injects labeled fallback payload into dependent agent context
- Orphan nodes detected (no path to root)
- Topological sort produces correct leaf-first cancellation order
**Dependencies:** P-04, P-19

---

#### C-03: PlanValidator
**Purpose:** Zero-cost pre-spawn validation gate between Router output and first agent spawn.
**Composition:** C-02 (DependencyGraphManager), P-08 (RequirementExtractor), P-07 (ContractRegistry)
**Checks:** acyclicity, output_contract satisfiability (structural/schema-level), coverage completeness, cost bounds, depth cap, orphan detection
**Fatal vs fixable:**
- Fatal: cycle, output_contract type mismatch, uncoverable RequirementMap, orphan node
- Fixable (Router retry, max 1): cost slightly exceeded, depth hint > cap but decomposable
**Runtime divergence (PV-06):** At runtime, if an Executor's actual output diverges from its declared `output_spec` or from the `output_contract.required_fields` of a downstream `output` edge, the harness SHALL classify this as `schema_failure`, trigger the Inner Loop with schema-specific retry prompt, and log the divergence as a `plan_validation_runtime_divergence` event on the Run. Downstream agents waiting on the `output` edge remain in `QUEUED` until the producing Executor reaches `COMPLETE` or `ESCALATED`. This is distinct from the pre-spawn static check — it fires mid-execution after inference cost has been incurred.
**Test criteria:**
- All 6 checks run; each can independently fail
- Fatal failures prevent agent spawn
- Fixable failures trigger Router retry (max 1 attempt)
- `PlanValidationResult` logged on Run and visible in inspector
- Schema-structural satisfiability check only at pre-spawn time (not runtime validation)
- Runtime output_spec divergence → `schema_failure` classification + Inner Loop + `plan_validation_runtime_divergence` event logged on Run
- Downstream QUEUED agents not unblocked until producing Executor reaches terminal state
**Dependencies:** C-02, P-08, P-07

---

#### C-04: RecursionGuard
**Purpose:** Enforce complexity-aware recursion decisions before a Planner's "recurse" decision is accepted.
**Composition:** P-04 (MessageBus), P-11 (EmbeddingEngine)
**ComplexityOverrideRule pre-pass:** Before reading `complexity_classification` from the Router output, the harness applies `RunConfig.complexity_override_rules` in order. Each rule is a regex matched case-insensitively against the current node's objective text. The first matching rule's `force_classification` value replaces the Router's classification for this node. Application is logged as a `recursion_guard_scope_override` bus event with the matching rule's `reason`. If no rule matches, the Router's classification is used unchanged.
**Scope of `complexity_classification`:** `complexity_classification` is a **run-scoped field** sourced exclusively from the root Router output and propagated to every RecursionGuard invocation at all Planner depths. Each Planner consults the same root Router classification — it does NOT re-derive or re-classify its own scope. The classification is stored on the `Run` object at Router completion and injected into every RecursionGuard call by the harness. A Planner at depth 3 in a `complex`-classified run still reads `"complex"` for the run-level classification, then applies the scope-level check in Rule 3 below to determine whether its own sub-scope warrants recursion.
**Rules (priority order, applied after ComplexityOverrideRule pre-pass):**
1. `atomic` or `simple` classification → override to `"execute"` regardless of token count
2. `moderate` classification → apply `min_scope_tokens` tiebreaker (default 200, configurable per run and per domain context)
3. `complex` run-level: apply scope-level check (scope below `min_scope_tokens` AND proposed children semantically near-identical → override to `"execute"`, log `recursion_guard_scope_override`)
**Test criteria:**
- `atomic` brief → always `"execute"` (never recurse)
- Dense 50-token `complex`-classified brief: NOT forced to single executor
- Near-identical children detected via embedding similarity → scope-level override
- All overrides logged as events and minor tickets
- `complexity_override_rules` matched rule applied before classification read; logged with rule's `reason`
- First matching override rule wins; non-matching rules skipped
**Dependencies:** P-04, P-11

---

#### C-05: SandboxEnforcer
**Purpose:** Runtime tool isolation, data access scoping, and tool contract enforcement per SandboxConfig.
**Composition:** P-05 (ToolRegistry), P-04 (MessageBus), P-19 (TicketSystem)
**Behaviors:**
- Executors cannot access tools outside `tools_injected` subset at runtime
- Cross-agent data only through SEC, blob store, or DependencyGraph contracts
- Violations: classify as `tool_failure`, escalate, file critical ticket
- `SandboxConfig`: enabled, tool_execution (isolated|shared), data_access (scoped|run_wide), network_policy, on_violation
- **Tool schema enforcement (v5.1 C-13):** Before executing a tool call, the harness validates the tool input against `Tool.input_schema` (if declared). After execution, the harness validates the tool output against `Tool.output_schema` (if declared). Schema violations are classified as `tool_failure`.
- **Destructive tool no-retry:** Tools with `side_effect_class: "destructive"` are NEVER retried, regardless of `retry_on_error` or `Tool.retry_on_error` setting. A single execution is definitive for destructive tools.
- **retry_on_error enforcement:** For tools with `retry_on_error: true` (and `side_effect_class` is not `"destructive"`), the harness retries the tool call exactly once before classifying the failure as `tool_failure`.
**Test criteria:**
- Tool call outside injected subset → `tool_failure`, escalate
- Sandbox violation with `on_violation: "error"` → agent state = ERROR
- Cross-agent direct data access attempt → violation
- `enabled: false` → all access permitted (test mode)
- Tool input that violates `input_schema` → `tool_failure` (no execution attempted)
- Tool output that violates `output_schema` → `tool_failure`
- `side_effect_class: "destructive"` tool → never retried, even if `retry_on_error: true`
- `retry_on_error: true` non-destructive tool → retried exactly once before `tool_failure`
**Dependencies:** P-05, P-04, P-19

---

#### C-06: EvalPipeline
**Purpose:** Full two-gate evaluation pipeline: pre-check → Gate 1 (binary) → Gate 2 (weighted).
**Composition:** P-12 (DeterministicPreCheck), P-13 (FailureClassifier), P-14 (OutputNormalizer), P-15 (JudgeRunner), P-07 (ContractRegistry)
**Pipeline:**
```
OutputNormalizer (if output_spec) → PreCheck → Gate1 (binary) → Gate2 (non-binary weighted)
```
**Gate 1 thresholds:** Router: 70, Planner: 75, Executor: 80
**Test criteria:**
- Normalization failure → `schema_failure`, no pre-check runs
- Pre-check failure → FailureClassifier runs, no Gate 1 runs
- Gate 1 FAIL → Gate 2 skipped (unless `early_stop_on_gate1: false`)
- `merged_judge_mode`: single batched call; malformed response → fallback to isolated
- `accuracy` auto-excluded from merge if prompt exceeds 80% model window
- Infrastructure error on Judge call → model retry (up to `model_infra_retry_max`, default 2) then fallback model, NOT Inner Loop trigger
- `novelty` skipped (auto-pass) on attempt 1
- `novelty` Judge receives current output and all prior `failed_strategies` outputs — does NOT compare against `successful_patterns` from Meta Loop
**Dependencies:** P-12, P-13, P-14, P-15, P-07

---

#### C-07: RetryOrchestrator (Inner Loop)
**Purpose:** Compose type-specific retry prompts and manage retry budget per agent node.
**Composition:** P-13 (FailureClassifier), P-20 (ExecutionMemoryStore), C-06 (EvalPipeline)
**Behaviors:**
- `infrastructure_failure` and `blob_write_failure`: do NOT consume retry budget
- `blob_write_failure`: exponential backoff, max `blob_write_retry_max` (default 3), then reclassify as `infrastructure_failure` + escalate
- Per-type retry template additions (see PRD §18)
- Failed strategy appended to ExecutionMemory after each attempt
- **Destructive tool no-retry (cross-reference C-05):** When the classified `failure_type` is `tool_failure` and the originating tool has `side_effect_class: "destructive"`, the RetryOrchestrator SHALL NOT compose a retry prompt or consume retry budget — the failure is treated as terminal for that node (escalate immediately). C-05 prevents the re-execution; C-07 prevents the retry loop from firing.
**Test criteria:**
- `infrastructure_failure` does not decrement retry counter
- `blob_write_failure` retries with backoff before consuming Inner Loop budget
- Retry prompt includes: FailedStrategy summary ("On attempt N, [type] at [gate]: [gap]. Do not repeat this approach.")
- Successful pattern scaffold injected if above similarity_threshold
- `tool_failure` from a `side_effect_class: "destructive"` tool → immediate escalation, no retry prompt composed, no retry budget consumed
**Dependencies:** P-13, P-20, C-06

---

#### C-08: AgentStateManager
**Purpose:** Manage agent state machine transitions and enforce valid transition rules.
**Composition:** P-04 (MessageBus), P-19 (TicketSystem)
**States:** QUEUED → AWAITING_HITL → PRECHECKING → GENERATING → GATE1_EVALUATING → GATE2_EVALUATING → COMPLETE | ESCALATED | RETRYING | CANCELLED | ERROR
**Planner-only:** PARTIALLY_COMPLETE
**Run-level:** PARTIAL_COMPLETE (kill switch finalize_partial)
**Test criteria:**
- Invalid transition attempts are rejected
- ESCALATED: retains best output, files tickets, propagates `context_confidence: "degraded"`
- CANCELLED: set only by early termination for QUEUED agents; no tickets filed
- ERROR: set by sandbox violation (`on_violation: "error"`) or kill switch `abort_run`
- OCC re-decompose stays within PRECHECKING (not a new state)
**Dependencies:** P-04, P-19

---

#### C-09: HITLManager
**Purpose:** Pause execution at declared checkpoints and await operator action.
**Composition:** C-08 (AgentStateManager), P-04 (MessageBus), P-19 (TicketSystem)
**Options:** Approve and continue / Edit brief / Edit output / Reject and escalate
**Timeout:** `on_timeout`: proceed or escalate per checkpoint config
**Test criteria:**
- Agent enters AWAITING_HITL on declared checkpoint
- Approve advances agent to next state
- Reject escalates agent
- Timeout fires `on_timeout` behavior
- Timeout with `on_timeout: "escalate"` → Outer Loop trigger
**Dependencies:** C-08, P-04, P-19

---

### Layer 3: Features (Complete agent capabilities)

#### F-01: RouterAgent
**Purpose:** Entry point. Classify complexity, extract RequirementMap, check PlanCache, build DependencyGraph, emit plan_cost_estimate, route to direct or plan.
**Composition:** P-08 (RequirementExtractor), P-18 (PlanCache), C-02 (DependencyGraphManager), C-03 (PlanValidator), C-06 (EvalPipeline), P-11 (EmbeddingEngine)
**Output fields:** routing, depth_hint, complexity_classification, rationale, objective_refined, constraints, requirements, dependencies, plan_cost_estimate
**Router Contract:** complexity_classification (0.45), scope_coverage (0.35, binary), dependency_correctness (0.20)
**Pre-PLAN VALIDATOR flow:** Router output → DeterministicPreCheck → PLAN VALIDATOR → agents spawn (or retry/fatal)
**Test criteria:**
- PlanCache hit surfaced to operator with similarity score + config delta before Router generates
- Router output feeds PLAN VALIDATOR before any spawn
- Fatal PLAN VALIDATOR failure: run does not start
- Fixable failure: Router retried max 1 time
- `complexity_classification` vocabulary: exactly `atomic | simple | moderate | complex`
- RequirementMap: 3–7 requirements
**Dependencies:** P-08, P-18, C-02, C-03, C-06, P-11

---

#### F-02: PlannerAgent
**Purpose:** Decompose scope into children (MECE), declare strategy + cost, write OCC to SEC.
**Composition:** C-01 (SECManager), C-02 (DependencyGraphManager), C-04 (RecursionGuard), C-06 (EvalPipeline), C-07 (RetryOrchestrator), C-08 (AgentStateManager), C-09 (HITLManager), P-17 (ContextCompressor), P-20 (ExecutionMemoryStore)
**v5 output fields:** decision, rationale, plan, plan_cost_estimate, sec_writes (with version_id), children (each with strategy, covers_requirements, output_spec, depends_on)
**Planner Contract:** decomposition_quality (0.25), scope_fidelity (0.25), termination_correctness (0.25, binary), deliverable_traceability (0.15), cost_compliance (0.10)
**Test criteria:**
- Children are MECE (mutually exclusive, collectively exhaustive of parent scope)
- OCC write rejected → re-decompose with conflict summary in prompt (max 2 cycles)
- `strategy` declared per child (different children can have different strategies)
- `plan_cost_estimate` emitted for every decomposition
- Planner does NOT produce work product or content
- Depth cap reached → hand to Executors unconditionally + warning ticket
**Dependencies:** C-01, C-02, C-04, C-06, C-07, C-08, C-09, P-17, P-20

---

#### F-03: ExecutorAgent
**Purpose:** Produce actual work product (llm_output or tool_call). Leaf node.
**Composition:** C-05 (SandboxEnforcer), C-06 (EvalPipeline), C-07 (RetryOrchestrator), C-08 (AgentStateManager), C-09 (HITLManager), P-03 (BlobStore), P-09 (IdempotencyCache), P-10 (ToolResultCache), P-14 (OutputNormalizer), P-16 (ContextAssembler), P-17 (ContextCompressor), P-20 (ExecutionMemoryStore)
**Pre-generation pipeline:** HITL check → ExecutionMemory cache check → ContextAssembly → Generate/Tool → OutputNormalizer → BlobStore routing → FailureClassifier → EvalPipeline → ContextCompressor
**Executor Contract:** task_completion (0.25), specificity (0.15, llm_output only), substantiveness (0.15, llm_output only), accuracy (0.20, binary), tool_verification (0.15, binary, tool_call only), novelty (0.10, Gate 2, attempt 2+ only)
**Idempotency rules:**
- `idempotency_key` = SHA-256(run_id + parent_id + scope + attempt_number)
- ToolResultCache: re-use cached tool result if same inputs and `idempotent: true`
- Blob routing: harness-determined by `output_spec.type` (json/artifact → blob store)
**Strategy behavioral contracts (enforced by harness):**
- `search`: `relevance_threshold` reduced by 0.15 from policy default; `max_context_tokens` increased by 25%; `diversity_penalty` increased by 0.1
- `synthesize`: `retrieval_sources` expanded to all available sources in policy; `diversity_penalty` increased by 0.2; `max_context_tokens` at policy max; `coherence` added as Gate 2 dimension with `weight_override: 0.10`; `specificity` weight_override: 0.10
- `transform`: ContextAssembly disabled if `output_spec.type` is json or artifact; `retrieval_sources` filtered to `schema_reference` sources only; if none exist, ContextAssembly fully disabled; blob store routing enforced
- `analyze`: standard ContextAssembly; CoT scaffold injected as first line of generation prompt: "Reason step by step before stating conclusions."; `accuracy` threshold enforced strictly at Gate 1
- `validate`: ContextAssembly restricted to schema and reference sources; `max_context_tokens` at policy minimum; `output_spec` declaration required (harness enforces); `task_completion` threshold raised to 90; `accuracy` is Gate 1 binary; normalization failure → immediate escalation (no retry); overrides ON-02
**Runtime output divergence (PV-06):** If the Executor's actual output diverges from its declared `output_spec` or from a downstream `output_contract.required_fields`, classify as `schema_failure`, trigger Inner Loop with schema-specific retry, and log `plan_validation_runtime_divergence` on the Run. See C-03 for full PV-06 spec.
**Test criteria:**
- Executor cannot spawn child agents
- `data_refs` populated when output_spec.type is json or artifact
- ToolResultCache hit: retry LLM receives cached tool output (tool not re-executed)
- `novelty` auto-pass on attempt 1 (`failed_strategies` empty)
- `strategy: "validate"` normalization failure → immediate escalation (no retry)
- `strategy: "validate"` task_completion threshold = 90 (not default 80)
- `strategy: "analyze"` → CoT scaffold injected as first line of generation prompt
- `strategy: "synthesize"` → `coherence` added as Gate 2 dimension; all retrieval sources used
- Weight normalization: llm_output mode normalizes over 0.85 total; tool_call mode over 0.70 total
- Runtime output_spec divergence → `schema_failure` + `plan_validation_runtime_divergence` logged
**Dependencies:** C-05, C-06, C-07, C-08, C-09, P-03, P-09, P-10, P-14, P-16, P-17, P-20

---

#### F-04: EarlyTerminationController
**Purpose:** Monitor RequirementMap coverage after every Executor COMPLETE; cancel QUEUED agents when threshold met.
**Composition:** P-08 (RequirementExtractor), C-02 (DependencyGraphManager), C-08 (AgentStateManager), P-04 (MessageBus)
**Behaviors:**
- Check after every Executor COMPLETE
- Fire if: all requirements covered AND confidence ≥ threshold (AND no high-priority requirement uncovered)
- Cancellation order: topological sort → leaves first
- Cancelled agents: fire `on_timeout` on outbound dependency edges
- GENERATING/GATE1_EVALUATING/GATE2_EVALUATING: allowed to complete
**Test criteria:**
- High-priority requirement guard blocks early termination regardless of confidence
- Topological cancel order: leaves cancelled before roots
- Cancelled agent's dependency edges fire `on_timeout` immediately
- `early_termination: true` logged on Run with triggering coverage state
- GENERATING agents at termination time allowed to complete normally
**Dependencies:** P-08, C-02, C-08, P-04

---

#### F-05: KillSwitchController
**Purpose:** Hard stop on `cost_exceeded | time_exceeded | loop_detected`.
**Composition:** P-01 (BudgetLedger), C-08 (AgentStateManager), P-04 (MessageBus), P-19 (TicketSystem)
**Actions:**
- `abort_run`: halt all agents immediately → Run = ERROR
- `escalate_run`: stop new spawns, mark in-flight ESCALATED, surface to operator
- `finalize_partial`: cancel QUEUED/RETRYING; give GENERATING agents `partial_output_timeout_ms` (default 5,000ms) to finish; run ContextCompressor + TraceEval on COMPLETE nodes; Run = PARTIAL_COMPLETE
- `run_wall_clock_sla_ms` in RunConfig: equivalent to configured `time_exceeded` trigger
**Test criteria:**
- Kill switch bypasses Outer Loop entirely (no repair attempt)
- `loop_detected`: same scope hash retried > threshold times across run
- `finalize_partial`: PARTIAL_COMPLETE reached after timeout; trace eval runs on COMPLETE nodes only
- Critical ticket filed on kill switch trigger
**Dependencies:** P-01, C-08, P-04, P-19

---

#### F-06: OuterLoop
**Purpose:** End-of-run repair attempt on trace eval failure or ESCALATED nodes.
**Composition:** C-06 (EvalPipeline), C-07 (RetryOrchestrator), C-08 (AgentStateManager), P-04 (MessageBus), P-19 (TicketSystem)
**Triggers:** trace eval failure, ESCALATED nodes in tree, HITL timeout with `on_timeout: "escalate"`, budget exceeded with `on_budget_exceeded: "escalate"`
**NOT triggered by:** kill switch (kill switch bypasses Outer Loop)
**Test criteria:**
- Outer Loop does NOT run when kill switch fires
- All 4 trigger conditions independently cause Outer Loop
- Outer Loop repair attempt logged
**Dependencies:** C-06, C-07, C-08, P-04, P-19

---

#### F-07: MetaLoop
**Purpose:** Cross-run calibration and success pattern learning.
**Composition:** P-11 (EmbeddingEngine), P-20 (ExecutionMemoryStore), P-18 (PlanCache)
**After every COMPLETE run:**
- Extract `successful_plan_embeddings` and `successful_sec_patterns` indexed by objective cluster + domain
- Artifact field capped at 512 tokens at write
- Pattern store eviction: LRU (default) or `oldest_first` when `max_pattern_store_size` (default 10,000) reached
- Append to `complexity_classification_log`: run_id, router_classification, actual_depth, trace_eval_score
- Compute `classification_accuracy` metric: router_classification matched actual_depth_reached
**Test criteria:**
- Pattern store eviction fires at `max_pattern_store_size`
- `lru` policy evicts least-recently-accessed pattern
- `complexity_classification_log` appended after every COMPLETE run
- `classification_accuracy` computed as fraction of runs with correct ordinal bucket
- ANN index used above `pattern_store_index_threshold` (default 1,000 patterns)
**Dependencies:** P-11, P-20, P-18

---

#### F-08: TraceEvaluation
**Purpose:** Full run-level evaluation: Phase 1 (deterministic coverage) + Phase 2 (LLM judges).
**Composition:** P-08 (RequirementExtractor), P-15 (JudgeRunner), P-17 (ContextCompressor), P-03 (BlobStore)
**Trace eval input priority (when budget exceeded):**
1. Always: RequirementMap + coverage status, early_termination flag, SEC final state summary
2. Until budget: Full ESCALATED outputs on critical path (shallowest first)
3. Until budget: Full outputs of nodes covering contested Requirements
4. Until budget: Non-critical ESCALATED outputs (truncated to `max_escalated_output_tokens`, default 500)
5. Always as pointers only: Blob store DataRef pointers
6. Fill remaining: ChunkSummaries
**Trace eval dimensions:** objective_fulfillment (0.40), coverage_completeness (0.35), coherence (0.15), dependency_integrity (0.10)
**Test criteria:**
- Phase 1 runs deterministically before LLM judges
- SEC final state and DependencyGraph execution trace included in Phase 2 input
- Priority ordering applied when token budget exceeded
- Blob DataRef pointers always included (never compressed away)
- Trace failure triggers Outer Loop
**Dependencies:** P-08, P-15, P-17, P-03

---

#### F-09: AdaptiveDepthController
**Purpose:** Dynamic depth expansion/shrinkage during run based on coverage gaps and entropy.
**Composition:** C-04 (RecursionGuard), P-08 (RequirementExtractor), P-01 (BudgetLedger), P-11 (EmbeddingEngine)
**Behaviors:**
- `expand_if: "coverage_gap"`: uncovered Requirement after Executor COMPLETE → signal parent Planner to spawn more children (if budget allows)
- `shrink_if: "low_entropy"`: near-identical proposed children → override recursion to single Executor
- Budget check before expansion: remaining < `expansion_cost_reserve` (default 20% of hard limit) → suppress
- Suppressed expansion logged as `depth_expansion_suppressed` + minor ticket
- Hard `max_depth` cap always applies
**Test criteria:**
- Expansion suppressed when budget < expansion_cost_reserve
- Low-entropy siblings detected by embedding similarity → scope-level override
- Hard cap enforced: expansion never exceeds max_depth
**Dependencies:** C-04, P-08, P-01, P-11

---

### Layer 4: Modules (Feature groupings)

#### M-01: ExecutionHarness
**Purpose:** Core run orchestration — spawn agents, schedule per DependencyGraph, enforce parallelism policy, manage backpressure.
**Composition:** F-01 (RouterAgent), F-02 (PlannerAgent), F-03 (ExecutorAgent), F-04 (EarlyTerminationController), F-05 (KillSwitchController), F-06 (OuterLoop), F-09 (AdaptiveDepthController), C-08 (AgentStateManager)
**Behaviors:**
- `parallelism_policy.max_concurrent_agents`: cap on concurrent agents
- `max_queued_agents` (default 2× max_concurrent): pause Planner decomposition when exceeded
- Priority queue: critical path agents first
- `latency_sla_policy`: per-agent-type wall time budgets; `on_violation`: degrade or escalate
- `run_wall_clock_sla_ms`: hard run-level wall clock budget
**Test criteria:**
- Concurrent siblings fire immediately (no dependency → immediate start)
- Backpressure: Planner held in PRECHECKING when queue full
- Latency SLA violation degrades or escalates per policy
- Critical path agents processed before non-critical
**Dependencies:** F-01, F-02, F-03, F-04, F-05, F-06, F-09, C-08

---

#### M-02: EvalModule
**Purpose:** Complete evaluation subsystem: pre-check, two-gate eval, trace eval, judge routing, merged mode.
**Composition:** C-06 (EvalPipeline), F-07 (MetaLoop), F-08 (TraceEvaluation), P-19 (TicketSystem)
**Behaviors:**
- JudgingPolicy modes: full | adaptive | custom
- `merged_judge_mode` reduces Gate 1 calls by up to 70%
- `skip_dimensions`: skip non-binary only
- Adaptive judge calibration: skip rate tracking, false negative rate, JudgingPolicy update
- FeedbackLoopHealth emitted after every run with feedback_loop enabled
**Test criteria:**
- Binary dimensions never skipped regardless of JudgingPolicy
- Adaptive mode: judge skip rate tracked and reported
- FeedbackLoopHealth record emitted to run summary and bus
- `feedback_loop_snapshot_id` loads weights from named snapshot (operator rollback)
**Dependencies:** C-06, F-07, F-08, P-19

---

#### M-03: ObservabilityModule
**Purpose:** Full transparency: all decisions, state transitions, eval results, conflicts, tickets logged and inspectable.
**Composition:** P-04 (MessageBus), P-19 (TicketSystem), C-01 (SECManager), C-08 (AgentStateManager)
**Logged events (complete list):**
- Every pre-check, gate verdict, judge reasoning, ContextAssembly source
- SEC writes, OCC conflicts, `sec_occ_retry` cycles
- DependencyGraph edge events, HITL events, recursion guard overrides
- Retries, compression events, blob store writes
- Failure types, normalization results, sandbox events
- Kill switch events, budget state
- Causal chains from ESCALATED nodes via `caused_by` links
- `sec_size_warning` when SEC entries exceed `SEC_list_max_entries`
- `pattern_lookup_latency_ms` per node
**Test criteria:**
- All listed event types emit to MessageBus
- Every event has run_id, agent_id, timestamp
- `caused_by` links traceable from ESCALATED node to root cause
- Inspector can replay full run from bus events
**Dependencies:** P-04, P-19, C-01, C-08

---

#### M-04: ConfigModule
**Purpose:** Runtime config management — all policies injectable and overridable per run.
**Composition:** P-07 (ContractRegistry), P-05 (ToolRegistry), P-06 (DomainRegistry)
**Config surfaces:** BudgetPolicy, RepairPolicy, JudgingPolicy, ContextAssemblyPolicy, CompressionPolicy, RecursionGuard thresholds, DepthPolicy, EarlyTerminationPolicy, KillSwitch, ParallelismPolicy, LatencySLAPolicy, ModelPolicy, MergedJudgePolicy, SandboxConfig, ConflictResolutionPolicy, BlobStorePolicy
**Test criteria:**
- All policies configurable at runtime (per-run override)
- Contract version change invalidates PlanCache
- Tool registry change invalidates PlanCache
- `RunConfig.run_config_hash` computed from all policy fields
**Dependencies:** P-07, P-05, P-06

---

### Layer 5: Application (Deployable system)

#### A-01: NexusAgentRuntime
**Purpose:** The complete deployable Agent Nexus v5 harness. Accepts objective + RunConfig, returns Run result.
**Composition:** M-01 (ExecutionHarness), M-02 (EvalModule), M-03 (ObservabilityModule), M-04 (ConfigModule)
**Entry point:**
```typescript
async run(objective: string, config: RunConfig): Promise<Run>
```
**Run statuses:** running | complete | partial_complete | escalated | error
**Replay mode:** `RunConfig.replay_mode` with `idempotency_key` guarantees deterministic structural re-execution
**Distributed deployment requirements:**
- SEC backend: external CAS store (Redis WATCH/MULTI/EXEC, etcd, or relational DB with OCC)
- Blob store: external shared store (S3, GCS, Redis Blob)
- Default in-memory implementations: valid for single-process only
**Test criteria:**
- `run()` accepts objective + RunConfig, returns Run with correct final status
- E2E: atomic objective → single Executor → COMPLETE (no Planner)
- E2E: complex objective → Router → Planner tree → Executors → trace eval → COMPLETE
- `replay_mode`: same objective + RunConfig produces structurally identical agent organization
- Distributed: in-memory SEC backend fails gracefully with clear error in multi-node mode
**Dependencies:** M-01, M-02, M-03, M-04

---

## 3. Dependency Graph

```
LAYER 5: Application
┌────────────────────────────────────────────────────────────────────┐
│ A-01: NexusAgentRuntime                                           │
│ Depends on: M-01, M-02, M-03, M-04                               │
│ Test readiness: Sprint 7 (after modules exist + prod infra)       │
└────────────────────────────────────────────────────────────────────┘
                               ▲
LAYER 4: Modules               │
┌────────────────────────────────────────────────────────────────────┐
│ M-01: ExecutionHarness    F-01..F-06, F-09, C-08                 │
│ M-02: EvalModule          C-06, F-07, F-08, P-19                 │
│ M-03: ObservabilityModule P-04, P-19, C-01, C-08                 │
│ M-04: ConfigModule        P-05, P-06, P-07                       │
│ Test readiness: Sprint 6 (after features exist + staging infra)  │
└────────────────────────────────────────────────────────────────────┘
                               ▲
LAYER 3: Features              │
┌────────────────────────────────────────────────────────────────────┐
│ F-01: RouterAgent         P-08, P-18, C-02, C-03, C-06, P-11    │
│ F-02: PlannerAgent        C-01..C-04, C-06..C-09, P-17, P-20    │
│ F-03: ExecutorAgent       C-05..C-09, P-03, P-09, P-10, P-14..17, P-20 │
│ F-04: EarlyTermination    P-08, C-02, C-08, P-04                 │
│ F-05: KillSwitch          P-01, C-08, P-04, P-19                 │
│ F-06: OuterLoop           C-06, C-07, C-08, P-04, P-19          │
│ F-07: MetaLoop            P-11, P-20, P-18                       │
│ F-08: TraceEvaluation     P-08, P-15, P-17, P-03                │
│ F-09: AdaptiveDepth       C-04, P-08, P-01, P-11                │
│ Test readiness: Sprint 5 (after components exist + dev infra)    │
└────────────────────────────────────────────────────────────────────┘
                               ▲
LAYER 2: Components            │
┌────────────────────────────────────────────────────────────────────┐
│ C-01: SECManager          P-02, P-04, P-19                       │
│ C-02: DependencyGraphMgr  P-04, P-19                             │
│ C-03: PlanValidator       C-02, P-08, P-07                       │
│ C-04: RecursionGuard      P-04, P-11                             │
│ C-05: SandboxEnforcer     P-05, P-04, P-19                       │
│ C-06: EvalPipeline        P-12, P-13, P-14, P-15, P-07          │
│ C-07: RetryOrchestrator   P-13, P-20, C-06                       │
│ C-08: AgentStateManager   P-04, P-19                             │
│ C-09: HITLManager         C-08, P-04, P-19                       │
│ Test readiness: Sprint 3-4 (after primitives exist)              │
└────────────────────────────────────────────────────────────────────┘
                               ▲
LAYER 1: Primitives            │
┌────────────────────────────────────────────────────────────────────┐
│ P-01..P-20 (20 primitives)                                       │
│ Dependencies: NONE (except P-16 → P-11, P-18 → P-11, P-20 → P-11)│
│ Test readiness: Sprint 1-2 ✅ (immediately testable)             │
└────────────────────────────────────────────────────────────────────┘
```

**Critical Path (longest dependency chain):**
P-02 (VersionedStore) → C-01 (SECManager) → F-02 (PlannerAgent) → M-01 (ExecutionHarness) → A-01 (NexusAgentRuntime)

**Parallelization opportunities:**
- Sprint 1: All 17 zero-dependency primitives build in parallel (P-01 through P-20, minus P-16/P-18/P-20 which depend on P-11)
- Sprint 2: P-11 (EmbeddingEngine) → then P-16, P-18, P-20 in parallel
- Sprint 3: All 9 Components build in parallel (their primitive dependencies exist)
- Sprint 5: F-01..F-09 features can build in parallel (components exist)

---

## 4. Sprint Delivery Plan

### Sprint 1: Zero-Dependency Primitives (2 weeks)
**Build (parallel):**
- P-01: BudgetLedger
- P-02: VersionedStore (SEC Backend)
- P-03: BlobStore
- P-04: MessageBus
- P-05: ToolRegistry
- P-06: DomainRegistry
- P-07: ContractRegistry
- P-08: RequirementExtractor
- P-09: IdempotencyCache
- P-10: ToolResultCache
- P-12: DeterministicPreCheck
- P-13: FailureClassifier
- P-14: OutputNormalizer
- P-15: JudgeRunner (with mock LLM adapter)
- P-17: ContextCompressor (with mock LLM adapter)
- P-19: TicketSystem
**Test:** ✅ All 16 primitives unit-testable immediately (zero dependencies)
**Infrastructure:** None required
**Deliverable:** 16 tested, working primitives

---

### Sprint 2: EmbeddingEngine + Dependent Primitives (1 week)
**Build (sequential then parallel):**
- P-11: EmbeddingEngine (zero dependencies — can build in Sprint 1 in parallel)
- P-16: ContextAssembler (depends on P-11)
- P-18: PlanCache (depends on P-11)
- P-20: ExecutionMemoryStore (depends on P-11)
**Test:** ✅ All 4 testable (P-11 immediately, P-16/P-18/P-20 after P-11 tests pass)
**Infrastructure:** None required
**Deliverable:** All 20 PRD primitives implemented and tested

---

### Sprint 3: Core Harness Components (2 weeks)
**Build (parallel — all depend on Sprint 1-2 primitives):**
- C-01: SECManager (P-02, P-04, P-19)
- C-02: DependencyGraphManager (P-04, P-19)
- C-04: RecursionGuard (P-04, P-11)
- C-05: SandboxEnforcer (P-05, P-04, P-19)
- C-06: EvalPipeline (P-12, P-13, P-14, P-15, P-07)
- C-08: AgentStateManager (P-04, P-19)
**Test:** ✅ All 6 components testable (Sprint 1-2 primitives exist)
**Infrastructure:** None required
**Deliverable:** Core harness components tested

---

### Sprint 4: Compound Components (1 week)
**Build (sequential — depend on Sprint 3 components):**
- C-03: PlanValidator (C-02, P-08, P-07)
- C-07: RetryOrchestrator (P-13, P-20, C-06)
- C-09: HITLManager (C-08, P-04, P-19)
**Test:** ✅ All 3 testable (Sprint 3 components exist)
**Infrastructure:** None required
**Deliverable:** All 9 components tested, full harness building blocks ready

---

### Sprint 5: Agent Features (3 weeks)
**Build (largely parallel — all depend on Sprint 3-4 components):**
- F-01: RouterAgent
- F-02: PlannerAgent
- F-03: ExecutorAgent
- F-04: EarlyTerminationController
- F-05: KillSwitchController
- F-06: OuterLoop
- F-07: MetaLoop
- F-08: TraceEvaluation
- F-09: AdaptiveDepthController
**Test:**
- Unit: mock LLM adapter (all features testable immediately — components exist)
- Integration: real LLM adapter (dev environment)
**Infrastructure:** ⚠️ Dev — Dockerized LLM proxy + in-memory SEC + in-memory blob store
**Deliverable:** All 9 agent features tested with mock + real LLM

---

### Sprint 6: Modules + Staging Integration (2 weeks)
**Build:**
- M-01: ExecutionHarness
- M-02: EvalModule
- M-03: ObservabilityModule
- M-04: ConfigModule
**Test:**
- Module integration tests (features exist)
- End-to-end run: atomic objective → single Executor → COMPLETE
- End-to-end run: multi-level Planner tree → trace eval → COMPLETE
- OCC conflict scenarios: concurrent Planners writing same SEC key
**Infrastructure:** ⚠️ Staging — external Redis (SEC + blob store) + real LLM endpoint + ticket provider
**Deliverable:** Full harness working end-to-end on staging

---

### Sprint 7: Production Application + Infrastructure (2 weeks)
**Build:**
- A-01: NexusAgentRuntime (integration of all modules)
- Distributed SEC backend (Redis or etcd for multi-node)
- Distributed blob store (S3/GCS)
- Replay mode validation
**Test:**
- ✅ E2E application tests (modules exist)
- ✅ Infrastructure tests (production infra exists NOW)
- Concurrency stress: 50+ concurrent agents in single run
- Kill switch scenarios: cost_exceeded, time_exceeded, loop_detected
- Replay mode: deterministic structural re-execution
**Infrastructure:** ✅ Production — distributed SEC backend + blob store + monitoring + ticket provider
**Deliverable:** Production-ready NexusAgentRuntime v5

---

## 5. Test Readiness Matrix

| Layer | Component | Dependencies Met | Testable Sprint | Infra Required |
|---|---|---|---|---|
| Primitive | P-01: BudgetLedger | None | Sprint 1 ✅ | None |
| Primitive | P-02: VersionedStore | None | Sprint 1 ✅ | None |
| Primitive | P-03: BlobStore | None | Sprint 1 ✅ | None |
| Primitive | P-04: MessageBus | None | Sprint 1 ✅ | None |
| Primitive | P-05: ToolRegistry | None | Sprint 1 ✅ | None |
| Primitive | P-06: DomainRegistry | None | Sprint 1 ✅ | None |
| Primitive | P-07: ContractRegistry | None | Sprint 1 ✅ | None |
| Primitive | P-08: RequirementExtractor | None | Sprint 1 ✅ | None |
| Primitive | P-09: IdempotencyCache | None | Sprint 1 ✅ | None |
| Primitive | P-10: ToolResultCache | None | Sprint 1 ✅ | None |
| Primitive | P-11: EmbeddingEngine | None | Sprint 1 ✅ | None |
| Primitive | P-12: DeterministicPreCheck | None | Sprint 1 ✅ | None |
| Primitive | P-13: FailureClassifier | None | Sprint 1 ✅ | None |
| Primitive | P-14: OutputNormalizer | None | Sprint 1 ✅ | None |
| Primitive | P-15: JudgeRunner | None (mock LLM) | Sprint 1 ✅ | None |
| Primitive | P-16: ContextAssembler | P-11 | Sprint 2 ✅ | None |
| Primitive | P-17: ContextCompressor | None (mock LLM) | Sprint 1 ✅ | None |
| Primitive | P-18: PlanCache | P-11 | Sprint 2 ✅ | None |
| Primitive | P-19: TicketSystem | P-04 | Sprint 1 ✅ | None |
| Primitive | P-20: ExecutionMemoryStore | P-11 | Sprint 2 ✅ | None |
| Component | C-01: SECManager | P-02, P-04, P-19 | Sprint 3 ✅ | None |
| Component | C-02: DependencyGraphMgr | P-04, P-19 | Sprint 3 ✅ | None |
| Component | C-03: PlanValidator | C-02, P-08, P-07 | Sprint 4 ✅ | None |
| Component | C-04: RecursionGuard | P-04, P-11 | Sprint 3 ✅ | None |
| Component | C-05: SandboxEnforcer | P-05, P-04, P-19 | Sprint 3 ✅ | None |
| Component | C-06: EvalPipeline | P-12..P-15, P-07 | Sprint 3 ✅ | None (mock LLM) |
| Component | C-07: RetryOrchestrator | P-13, P-20, C-06 | Sprint 4 ✅ | None |
| Component | C-08: AgentStateManager | P-04, P-19 | Sprint 3 ✅ | None |
| Component | C-09: HITLManager | C-08, P-04, P-19 | Sprint 4 ✅ | None |
| Feature | F-01: RouterAgent | P-08, P-18, C-02, C-03, C-06, P-11 | Sprint 5 ✅ | Dev LLM |
| Feature | F-02: PlannerAgent | C-01..C-09, P-17, P-20 | Sprint 5 ✅ | Dev LLM |
| Feature | F-03: ExecutorAgent | All components | Sprint 5 ✅ | Dev LLM |
| Feature | F-04: EarlyTermination | P-08, C-02, C-08, P-04 | Sprint 5 ✅ | Dev LLM |
| Feature | F-05: KillSwitch | P-01, C-08, P-04, P-19 | Sprint 5 ✅ | None |
| Feature | F-06: OuterLoop | C-06..C-08, P-04, P-19 | Sprint 5 ✅ | Dev LLM |
| Feature | F-07: MetaLoop | P-11, P-20, P-18 | Sprint 5 ✅ | None |
| Feature | F-08: TraceEvaluation | P-08, P-15, P-17, P-03 | Sprint 5 ✅ | Dev LLM |
| Feature | F-09: AdaptiveDepth | C-04, P-08, P-01, P-11 | Sprint 5 ✅ | None |
| Module | M-01: ExecutionHarness | F-01..F-06, F-09, C-08 | Sprint 6 ✅ | Staging |
| Module | M-02: EvalModule | C-06, F-07, F-08, P-19 | Sprint 6 ✅ | Staging |
| Module | M-03: Observability | P-04, P-19, C-01, C-08 | Sprint 6 ✅ | Staging |
| Module | M-04: ConfigModule | P-05..P-07 | Sprint 6 ✅ | Staging |
| Application | A-01: NexusAgentRuntime | M-01..M-04 | Sprint 7 ✅ | Production |
| Infrastructure | Redis SEC Backend | A-01 deployed | Sprint 7 ✅ | Production |
| Infrastructure | Distributed Blob Store | A-01 deployed | Sprint 7 ✅ | Production |

---

## 6. Test Strategy

### Rules

**RULE 1: Bottom-Up only** — Tests written in dependency order. Never test a component before its dependencies' tests pass.

**RULE 2: Gate-on-tests** — Sprint N+1 does not start until Sprint N tests pass.

**RULE 3: Infrastructure last** — No infrastructure tests in Sprints 1–5. Staging infra tests in Sprint 6. Production infra tests in Sprint 7.

### Test Types by Layer

| Layer | Test Type | Sprint | Mock Strategy |
|---|---|---|---|
| Primitives | Unit | 1–2 | No mocks needed (zero deps) |
| Components | Integration | 3–4 | Mock LLM adapter for P-15/P-17 |
| Features | Feature/API | 5 | Mock LLM for unit tests; real LLM for integration |
| Modules | Module integration | 6 | Staging Redis + real LLM |
| Application | E2E | 7 | Full production stack |
| Infrastructure | Infrastructure | 7 | Production AWS/GCP |

### Key Test Scenarios

**OCC correctness (C-01 / Sprint 3):**
```typescript
// Concurrent Planners writing same SEC key — exactly one wins
test('OCC: concurrent writes to same key — one succeeds, one fails', async () => {
  const store = new VersionedStore()
  const [result1, result2] = await Promise.all([
    store.cas('key', 'v0', 'value_a'),
    store.cas('key', 'v0', 'value_b'),
  ])
  const results = [result1, result2]
  expect(results.filter(r => r.success).length).toBe(1)
  expect(results.filter(r => !r.success).length).toBe(1)
})
```

**Failure classification (P-13 / Sprint 1):**
```typescript
test('FailureClassifier: evidence present but contradicted → reasoning_failure', () => {
  const ft = classifier.classify('gate1', 'accuracy', { verdict: 'fail', evidence_present: true })
  expect(ft).toBe('reasoning_failure')
})
test('FailureClassifier: infrastructure_failure does NOT increment retry counter', () => {
  const retryBefore = node.retry_count
  orchestrator.handleFailure(node, 'infrastructure_failure')
  expect(node.retry_count).toBe(retryBefore)
})
```

**Kill switch finalize_partial (F-05 / Sprint 5):**
```typescript
// Mock: 3 COMPLETE nodes, 2 GENERATING, 5 QUEUED
test('finalize_partial: PARTIAL_COMPLETE after timeout', async () => {
  killSwitch.trigger('finalize_partial')
  await wait(partial_output_timeout_ms + 100)
  expect(run.status).toBe('PARTIAL_COMPLETE')
  expect(completeNodes).toHaveLength(3)
})
```

**Novelty auto-pass on attempt 1 (F-03 / Sprint 5):**
```typescript
test('novelty dimension auto-pass on attempt 1 (no failed strategies)', () => {
  const signal = evalPipeline.runGate2(executor_output, memory_with_no_failed_strategies)
  expect(signal.novelty.verdict).toBe('pass')
  expect(signal.novelty.skipped).toBe(true)
})
```

### Partial Testing Strategy

**Features (Sprint 5) that depend on LLM:**
- Unit tests: inject mock LLM adapter (deterministic responses)
- Integration tests: run against real LLM endpoint in dev environment
- Do NOT block Sprint 5 unit tests on real LLM availability

---

## 7. Data Contracts Reference

Key interfaces from PRD §14. Implementation must satisfy all fields.

### Run
```typescript
interface Run {
  id:                                         string
  objective:                                  string
  status:                                     "running" | "complete" | "partial_complete" | "escalated" | "error"
  plan_source:                                "fresh" | "cache"
  router_id:                                  string
  complexity_classification:                  "atomic" | "simple" | "moderate" | "complex"   // from Router; propagated to all RecursionGuard checks
  created_at:                                 string
  completed_at:                               string | null
  requirement_map:                            RequirementMap | null
  dependency_graph:                           DependencyGraph | null
  shared_exec_context:                        SharedExecutionContext
  sec_conflicts:                              string[]              // conflict IDs only; full SECConflict objects on SharedExecutionContext
  trace_eval:                                 TraceSignal | null
  repair_attempts:                            number
  budget_consumed:                            BudgetConsumed
  plan_validation_result:                     PlanValidationResult | null
  early_termination:                          boolean
  kill_switch_triggered:                      boolean
  replay_mode:                                "full" | "from_node" | "dry_run" | null
  config:                                     RunConfig
  coverage_confidence_score:                  number    // updated after every Executor reaches terminal state
  early_termination_in_flight_count:          number    // agents allowed to complete after early termination fired
  early_termination_dependency_resolutions:   number    // dependency edges resolved via early termination
  trace_input_truncated:                      boolean   // true when trace judge received budget-constrained input
  queue_depth:                                number    // current QUEUED agent count (real-time)
  feedback_loop_health:                       FeedbackLoopHealth | null   // populated after run when feedback_loop enabled
}
```

### RunConfig (critical fields)
```typescript
interface RunConfig {
  max_depth:                     number          // default 4
  max_occ_retries:               number          // default 2
  max_concurrent_agents:         number
  max_queued_agents:             number          // default 2× max_concurrent
  blob_write_retry_max:          number          // default 3
  pattern_store_index_threshold: number          // default 1,000 (ANN index trigger)
  max_pattern_store_size:        number          // default 10,000
  pattern_store_eviction_policy: "lru"|"oldest_first"
  plan_cache_similarity_threshold: number        // default 0.90
  similarity_threshold:          number          // default 0.75 (pattern match)
  partial_output_timeout_ms:     number          // default 5,000
  run_wall_clock_sla_ms:         number | null
  SEC_list_max_entries:          number          // default 10,000
  trace_eval_max_tokens:         number          // default 80% of judge context window
  feedback_loop_snapshot_id:     string | null
  feedback_loop_ttl_days:        number          // default 30; chunk weights older than TTL revert to base_weight
  min_scope_tokens:              number          // default 200; RecursionGuard tiebreaker for moderate classification
  model_infra_retry_max:         number          // default 2; infrastructure error retry count before fallback model
  replay_mode:                   boolean
  complexity_override_rules:     ComplexityOverrideRule[]  // applied before RecursionGuard reads complexity_classification

  conflict_resolution_policy: "reject"|"merge"|"priority"|"escalate"
  contracts:    { [agent_type]: Contract }
  model_policy: ModelPolicy
  sandbox_config: SandboxConfig
  blob_store_policy: BlobStorePolicy
  judging_policy: JudgingPolicy
  context_assembly_policy: ContextAssemblyPolicy
  budget_policy: BudgetPolicy
  latency_sla_policy: LatencySLAPolicy
  parallelism_policy: ParallelismPolicy
  depth_policy: DepthPolicy
  early_termination_policy: EarlyTerminationPolicy
  kill_switch: KillSwitch
  merged_judge_policy: MergedJudgePolicy
}
```

### ComplexityOverrideRule
```typescript
interface ComplexityOverrideRule {
  pattern:              string   // regex matched case-insensitively against objective text
  force_classification: "atomic" | "simple" | "moderate" | "complex"
  reason:               string   // required; documented justification; included in bus event
}
```
Override rules in `RunConfig.complexity_override_rules` are applied by C-04 (RecursionGuard) **before** reading `complexity_classification`. The first matching rule wins. Application is logged as a `recursion_guard_scope_override` bus event with the matching rule's `reason`.

### Ticket (v5 payload schema)
```typescript
interface Ticket {
  ticket_id:          string
  type:               string   // see trigger table below
  severity:           "critical" | "major" | "minor" | "informational"
  run_id:             string
  agent_id:           string
  agent_type:         "router" | "planner" | "executor"
  signal_id:          string | null
  failure_gate:       "precheck" | "gate1" | "gate2" | "trace" | "budget" | "tool" | "hitl" | "plan_validator" | "kill_switch" | null
  failure_type:       "retrieval_failure" | "reasoning_failure" | "planning_failure" | "tool_failure" | "timeout_failure" | "novelty_failure" | "schema_failure" | "blob_write_failure" | "infrastructure_failure" | null
  context_confidence: "high" | "degraded"
  on_critical_path:   boolean
  attempt:            number
  retry_prompt:       string
  objective_context:  string
  budget_consumed:    { inference_calls: number, tokens: number, wall_time_ms: number }
  created_at:         string   // ISO 8601
  provider:           string
  url:                string | null
}
```

**v5 ticket trigger table (additions to v4 base):**

| Trigger | Ticket type | Severity |
|---|---|---|
| SEC OCC write rejected | Shared context OCC rejection | Minor |
| SEC OCC re-decompose limit exceeded | Shared context OCC escalation | Critical |
| PLAN VALIDATOR failure | Plan validation failed | Critical |
| DependencyEdge TTL expired | Dependency timeout | Major |
| Output normalization failed | Schema normalization failure | Minor |
| Kill switch triggered | Kill switch activated | Critical |
| Sandbox violation | Execution sandbox violation | Critical |
| novelty dimension FAIL | Novelty failure — retry | Informational |
| Blob store write failure | Blob write failure — retry | Major |
| `sec_size_warning` threshold exceeded | SEC size warning | Major |
| Depth expansion suppressed (budget) | Depth expansion suppressed | Minor |

### BusEvent
```typescript
interface BusEvent {
  ts:       string
  run_id:   string
  agent_id: string | null
  type:     "router" | "planner" | "executor" | "eval" | "gate1" | "gate2" |
            "retry" | "ticket" | "trace" | "tool" | "budget" | "repair" |
            "cache" | "hitl" | "context_assembly" | "compression" |
            "sec_write" | "sec_conflict" | "sec_occ_reject" | "sec_occ_retry" |
            "recursion_guard" | "dependency" | "dependency_timeout" |
            "plan_validation" | "failure_classifier" | "output_normalizer" |
            "blob_store" | "sandbox_violation" | "kill_switch" |
            "early_termination" | "execution_memory" | "queue_backpressure" |
            "embedding_model_mismatch" | "feedback_loop" |
            "system" | "error"
  message:  string
  metadata: Record<string, unknown>
}
```

### AgentNode (complete state)
```typescript
interface AgentNode {
  id:                       string
  run_id:                   string
  parent_id:                string | null
  type:                     "router" | "planner" | "executor"
  label:                    string
  domain:                   string | null
  strategy:                 "search" | "synthesize" | "transform" | "analyze" | "validate" | null
  tools_injected:           string[]
  depends_on:               string[]
  on_critical_path:         boolean
  status:                   AgentState
  context_confidence:       "high" | "degraded"
  depth:                    number
  attempt:                  number
  idempotency_key:          string          // v5
  hitl_checkpoint:          HITLCheckpoint | null
  hitl_resolution:          "approved" | "edited" | "rejected" | "timed_out" | null
  context_assembly_sources: string[]
  context_tokens_injected:  number
  sec_writes:               SECEntry[]
  execution_memory:         ExecutionMemory  // v5
  chunk_summary:            ChunkSummary | null
  plan_cost_estimate:       PlanCostEstimate | null
  output_spec:              OutputSpec | null
  input:                    AgentInput
  output:                   AgentOutput | null
  normalized_output:        object | null   // v5
  action:                   ExecutorAction | null
  data_refs:                DataRef[]       // v5
  precheck_failures:        string[]
  failure_type:             FailureType | null
  gate1_blocked:            boolean         // true when Gate 1 hard-blocked this node
  gate1_dimension:          string | null   // the binary dimension that caused Gate 1 block
  span_eval:                AggregatedSignal | null
  tickets:                  string[]        // ticket IDs filed for this node
  children:                 string[]        // child agent IDs
  created_at:               string
  completed_at:             string | null
  caused_by:                string | null   // agent_id of upstream agent whose failure caused this node's degraded state
  causal_chain:             string[]        // ordered list of agent_ids from root failure to this node
}
```

### FeedbackLoopHealth
```typescript
interface FeedbackLoopHealth {
  mean_weight_deviation_from_base: number   // average |weight - base_weight| across all tracked chunks
  chunks_at_floor:                 number   // count of chunks at base_weight × 0.5 clamp (minimum)
  chunks_at_ceiling:               number   // count of chunks at base_weight × 2.0 clamp (maximum)
  total_chunks_tracked:            number
  snapshot_id:                     string   // identifier for use as RunConfig.feedback_loop_snapshot_id to roll back
}
```

### BlobStorePolicy
```typescript
interface BlobStorePolicy {
  max_run_bytes:     number | null              // null = no limit; hard size cap per run
  eviction_policy:   "run_complete" | "ttl" | "lru"
  ttl_seconds:       number | null             // used when eviction_policy: "ttl"
  on_quota_exceeded: "reject_write" | "evict_lru"
  // reject_write: classified as blob_write_failure; triggers BS-06 retry path
  // evict_lru:    least-recently-read blob for this run is evicted before the new write
}
```

---

## 8. Non-Functional Constraints

These drive architectural decisions and must be validated in Sprint 6-7 tests:

| Requirement | Validation Sprint | Test Approach |
|---|---|---|
| OCC atomic CAS — in-memory safe for single-process | Sprint 3 | Concurrent write test |
| OCC — distributed: external CAS required (Redis/etcd) | Sprint 7 | Multi-process integration test |
| Blob store — in-memory for single-process only | Sprint 6 | Size + eviction test |
| `merged_judge_mode` reduces Gate 1 calls by up to 70% | Sprint 5 | Call count measurement |
| Pre-checks, PLAN VALIDATOR, FAILURE CLASSIFIER: zero inference cost | Sprint 3–5 | LLM call count = 0 assertion |
| `pattern_lookup_latency_ms` reported per node | Sprint 5 | Metric presence assertion |
| ANN index at >1,000 patterns | Sprint 7 | Pattern store size load test |
| `SEC_list_max_entries` warning at 10,000 entries | Sprint 6 | Synthetic large-SEC test |
| HITL + DependencyEdge TTL: no indefinite waits | Sprint 5 | TTL expiry test |
| `idempotency_key` prevents duplicate tool side effects on retry | Sprint 5 | Retry with `idempotent: false` bypass test |
| Model infra failure: retry up to `model_infra_retry_max` (default 2) → fallback model → only then Inner Loop | Sprint 5 | Infrastructure error injection test; verify Inner Loop not triggered until retries + fallback exhausted |
| `side_effect_class: "destructive"` tool never retried even with `retry_on_error: true` | Sprint 5 | Destructive tool failure → immediate escalation, no retry prompt |
| `complexity_override_rules` applied before RecursionGuard reads classification | Sprint 5 | Matching rule overrides Router classification; logged as bus event with rule reason |
| Runtime `output_spec` divergence (PV-06) → `schema_failure` + `plan_validation_runtime_divergence` logged | Sprint 5 | Executor output violating declared output_spec mid-run → Inner Loop + event log |

---

## 9. Validation Checklist

### Dependency Validation
- [x] All 20 primitives have zero dependencies documented (except P-16/P-18/P-20 → P-11)
- [x] All 9 components list their primitive and component dependencies
- [x] All 9 features list their component dependencies
- [x] All 4 modules list their feature dependencies
- [x] Application lists all 4 module dependencies
- [x] Dependency graph shows clear bottom-up flow

### Test Readiness Validation
- [x] Test Readiness Matrix covers all 44 components (P-01..P-20, C-01..C-09, F-01..F-09, M-01..M-04, A-01)
- [x] All 20 primitives testable Sprint 1 or Sprint 2
- [x] All 9 components testable Sprint 3-4
- [x] All 9 features testable Sprint 5
- [x] Infrastructure tests deferred to Sprint 7 (production deployment)
- [x] No infrastructure tests in Sprint 1–5

### Build Order Validation
- [x] Sprint 1-2: Primitives only (zero or P-11 dependencies)
- [x] Sprint 3-4: Components only (Sprint 1-2 primitives exist)
- [x] Sprint 5: Features only (Sprint 3-4 components exist)
- [x] Sprint 6: Modules only (Sprint 5 features exist)
- [x] Sprint 7: Application + Infrastructure (Sprint 6 modules + prod infra exist)

### PRD v5 Coverage
- [x] All 20 PRD primitives mapped to Layer 1 (P-01..P-20)
- [x] 5 new v5 primitives covered: ExecutionMemory (P-20), PlanValidator (C-03), FailureClassifier (P-13), OutputNormalizer (P-14), ExecutionSandbox (C-05)
- [x] 7 structural changes covered: OCC (C-01), blob store (P-03/P-17), eval merging (P-15/C-06), DependencyEdge TTL (C-02), RecursionGuard (C-04), failure-type retries (P-13/C-07), strategy-aware planning (C-06/F-02)
- [x] v5.1 changelog items C-01..C-16 addressed in component specs
- [x] PV-06 runtime output_spec divergence: C-03 behavioral spec + F-03 test criteria
- [x] Destructive tool no-retry: C-05 enforcement + C-07 terminal escalation
- [x] Tool input/output schema enforcement: C-05 behaviors + test criteria
- [x] ComplexityOverrideRule pre-pass: C-04 behaviors + §7 data contract
- [x] Blob store BS-01/BS-02/BS-03 + quota-exceeded → blob_write_failure: P-03 behaviors
- [x] SEC merge re-inject/re-decompose + sec_size_warning: C-01 behaviors
- [x] novelty Judge does not compare to successful_patterns: C-06 test criteria
- [x] synthesize strategy harness behaviors + validate task_completion threshold: F-03
- [x] feedback_loop_ttl_days, min_scope_tokens, model_infra_retry_max, complexity_override_rules: RunConfig §7
- [x] Ticket payload schema + v5 ticket trigger table: §7 data contracts
- [x] Model infra retry path (model_infra_retry_max → fallback → Inner Loop): C-06 + §8 NFR
- [x] CLI invocation pattern defined: `nexus.py` entrypoint + `supervisor-nexus.py` chain (§10)
- [x] Issue attachment behavior specified: objective from issue body, result posted as comment (§10)

---

## 10. CLI Invocation

### Overview

Nexus is invokable from any directory within a target project using the same auto-detect pattern as `kodi-lite`/`kodi-lite2`. The entrypoint script (`nexus.py`) walks up the directory tree to find the `.git` root, resolves the GitHub repo via `gh` CLI or git remote, then `os.execv`s into `supervisor-nexus.py` with the resolved context and forwarded user flags.

### Entrypoint: `nexus.py`

**Location:** `long-running-harness/nexus.py` (symlinked into PATH as `nexus`)

**Install:**
```bash
ln -sf /path/to/long-running-harness/nexus.py /usr/local/bin/nexus
chmod +x /path/to/long-running-harness/nexus.py
```

**Usage:**
```bash
cd /path/to/target-project        # any subdirectory works
nexus --objective "..."           # run with explicit objective
nexus --issue 42                  # attach to GitHub issue #42; objective read from issue body
nexus --issue 42 --provider claude # claude-only provider
nexus --dry-run                   # validate RunConfig + print plan, do not execute
nexus --verbose                   # debug logging
nexus --provider gemini           # Gemini primary, Claude fallback (default)
nexus --provider claude           # Claude only
nexus --provider gemini-only      # Gemini only, no fallback
```

### Auto-Detection

1. **Project root** — walk up from `cwd` until `.git/` is found; raise `RuntimeError` if not in a git repo
2. **GitHub repo** — try `gh repo view --json nameWithOwner -q .nameWithOwner`; fallback to parsing `git config --get remote.origin.url` with regex `github\.com[:/]([^/]+/[^.]+?)(\.git)?$`

Both resolved values are passed to `supervisor-nexus.py` as `--project-root` and `--repo`.

### Entrypoint → Supervisor Chain

```
nexus.py
  → resolves: project_root, github_repo
  → os.execv → supervisor-nexus.py
                  --project-root /abs/path
                  --repo owner/repo
                  [+ forwarded user flags]
```

`supervisor-nexus.py` is responsible for:
- Parsing `--objective` / `--issue` (fetches issue body via `gh issue view` if `--issue` given)
- Loading `RunConfig` (from `--run-config` path or defaults)
- Instantiating `NexusAgentRuntime` (A-01)
- Posting run result back to the GitHub issue as a comment (if `--issue` was given)
- Streaming `ObservabilityModule` (M-03) bus events to stdout when `--verbose`

### Issue Attachment

When `--issue N` is provided:
1. `supervisor-nexus.py` fetches issue body + labels via `gh issue view N --json title,body,labels`
2. Constructs `objective` from issue title + body
3. After run completes, posts a summary comment to the issue: run status, trace eval score, tickets filed, budget consumed
4. On `COMPLETE` or `PARTIAL_COMPLETE`: adds label `nexus:resolved` to the issue
5. On `ESCALATED` or `ERROR`: adds label `nexus:needs-review`

### Python Executable Resolution

Priority order:
1. `long-running-harness/.venv/bin/python3` (harness venv)
2. `/usr/bin/python3` (system fallback)

### Provider Flag

| Value | Behavior |
|---|---|
| `gemini` | Gemini primary; Claude fallback on failure (default) |
| `claude` | Claude only; no fallback |
| `gemini-only` | Gemini only; no fallback |

Flag is validated early in `nexus.py` (fails fast on invalid value) and forwarded verbatim to `supervisor-nexus.py`.

### Error Handling

| Error | Exit code |
|---|---|
| Not in git repo | 1 |
| GitHub repo unresolvable | 1 |
| `supervisor-nexus.py` not found | 1 |
| `KeyboardInterrupt` | 130 |

---

## 11. Telemetry & Analytics UX

**Design language:** Dark theme. Monospace data (`JetBrains Mono`). Geometric UI labels (`Syne`). Hairline borders (0.5px). Amber/gold accent for live state. Semantic state chips: 15% opacity fill + matching text. Information density: high. No decorative chrome.

**Persistent nav elements:**
- Left sidebar: screen navigation with icon + label
- Top bar: run selector (current run ID + status chip), global search, system pulse (live event-rate sparkline), timestamp (ISO 8601)

---

### Screen 1: Runs List

**Purpose:** Operational overview — triage, filter, drill into any run.

**Layout:** Full-width table with sticky header. Filter bar above.

**Filter bar (inline, horizontal):**
- Status chips (toggle): `running` `complete` `partial_complete` `escalated` `error`
- Date range picker (ISO range)
- Complexity filter: `atomic` `simple` `moderate` `complex`
- Search: objective text

**Table columns:**
| Column | Type | Notes |
|---|---|---|
| Run ID | monospace, truncated, copyable | e.g. `run_a3f7` |
| Objective | text, truncated to 60 chars, tooltip for full | |
| Status | chip | color-coded by status |
| Complexity | chip | `atomic/simple/moderate/complex` |
| Depth | integer | max depth reached |
| Agents | integer | total spawned |
| Trace Score | `00.0%` | trace eval final score, color-coded |
| Gate 1 Pass% | `00%` | fraction of nodes that passed Gate 1 first attempt |
| Tokens | `000k` | total consumed |
| Cost | `$0.000` | inferred from token counts |
| Wall Time | `00.0s` | |
| Tickets | `C:0 M:0 m:0` | critical / major / minor counts, red if C > 0 |
| Started | ISO datetime, compact | |

**Row interactions:**
- Click row → navigate to Run Detail (Screen 2)
- Hover row → surface quick-stats tooltip: budget gauge, top failure type if any
- Right-click → copy run ID, copy objective, open in new tab

**Empty state:** `No runs match the current filters.` + clear filters button

---

### Screen 2: Run Detail

**Purpose:** Single-run deep-dive. The primary diagnostic screen.

**Layout:** Three-panel layout.
- Left panel (280px): Agent Tree
- Center panel (flex): Timeline + Events
- Right panel (320px): Run Summary + Budget

**Left panel — Agent Tree:**
- Collapsible tree matching actual agent hierarchy (Router → Planner(s) → Executor(s))
- Each node: type icon (R/P/E) + agent ID (monospace) + state chip
- State chips: `QUEUED` `GENERATING` `GATE1_EVALUATING` `COMPLETE` `ESCALATED` `RETRYING` `ERROR` `CANCELLED` `AWAITING_HITL` `PRECHECKING` `GATE2_EVALUATING` `PARTIALLY_COMPLETE`
- ESCALATED nodes: amber left border
- ERROR nodes: red left border
- Active (GENERATING/evaluating) nodes: pulsing amber dot
- Click node → highlight in center panel + scroll to first event; also opens Agent Node Detail (Screen 3) in center panel

**Center panel — Timeline + Events:**
- Horizontal swimlane timeline at top (collapsible): each agent = one lane, time on X-axis
  - Lane bars: colored by state sequence (QUEUED=gray → GENERATING=blue → COMPLETE=green, etc.)
  - Hover bar segment: tooltip with state, start time, duration
- Below timeline: chronological event stream (same data as Trace Timeline Screen 5, scoped to this run)
  - Each event row: timestamp | event_type | agent_id | summary
  - Click event → expand inline: full event payload as formatted JSON

**Right panel — Run Summary:**
- Run ID (monospace, large)
- Status chip (large)
- Objective text (full, wrapped)
- Complexity classification chip
- Depth reached / max_depth allowed
- Trace eval score (large number, colored)
- Requirement coverage: `5/6 requirements covered` + inline mini table if any uncovered

**Right panel — Budget gauges (three stacked):**
```
TOKENS      ████████░░  82,400 / 100,000
CALLS       ██████░░░░  142 / 250
WALL TIME   ██████████  28.4s / 30.0s
```
Each gauge: label + filled bar + `consumed / limit` + percentage

**Right panel — Tickets filed:**
- `CRITICAL  2`  (red)
- `MAJOR     1`  (amber)
- `MINOR     4`  (muted)
- Click each → filter Ticket Dashboard (Screen 7) to this run

**Right panel — Quick links:**
- View Dependency Graph → Screen 11
- View SEC State → Screen 6
- View Eval Pipeline → Screen 4
- View Config → Screen 15

---

### Screen 3: Agent Node Detail

**Purpose:** Inspect a single agent node in full depth.

**Layout:** Single scrollable column with collapsible sections.

**Header:**
- Agent ID (monospace, large) | type badge (ROUTER / PLANNER / EXECUTOR) | state chip
- Parent: `[parent_agent_id]` link | Run: `[run_id]` link
- Strategy: `search` / `synthesize` / `transform` / `analyze` / `validate` (Executor only)
- Scope text (full, wrapped, monospace)

**Section: State History**
- Horizontal stepper: each state the node passed through, with timestamp and duration
- Example: `QUEUED (0ms) → PRECHECKING (12ms) → GENERATING (4.2s) → GATE1_EVALUATING (800ms) → GATE2_EVALUATING (1.1s) → COMPLETE`
- Hover each state → tooltip with entry/exit ISO timestamps

**Section: Eval Pipeline**
- Inline version of Screen 4 (full breakdown), collapsed to summary by default
- Summary: PreCheck pass/fail | Gate 1 score | Gate 2 weighted score
- Expand → full dimension table

**Section: Retry History**
- Table: attempt # | failure_type | gate | dimension | score | retry_addition summary
- Only shown if retry_count > 0

**Section: Context Assembly**
- Sources used: list of `chunk_id | source_type | relevance_score | tokens`
- Cache hits flagged
- `diversity_penalty` applied value
- Strategy overrides applied (e.g. `synthesize: all retrieval sources used`)

**Section: Output**
- For `llm_output`: rendered text (monospace), token count, blob DataRef if applicable
- For `tool_call`: tool_id | input JSON | output JSON | idempotency hit? | retry count
- Normalization result: passed / schema_failure / structural_only

**Section: HITL Checkpoint** (if applicable)
- Checkpoint label | action taken (approved/edited/rejected) | operator | timestamp
- If pending → inline approve/reject/edit controls (same as Screen 10)

---

### Screen 4: Eval Pipeline View

**Purpose:** Gate-by-gate breakdown for any agent node.

**Layout:** Three sequential sections (PreCheck → Gate 1 → Gate 2), with summary bar at top.

**Summary bar:**
```
PreCheck  PASS    Gate 1  87.0    Gate 2  79.4  →  PASS
```
Color coded: green/amber/red based on threshold (Router:70, Planner:75, Executor:80).

**Section: PreCheck**
- Agent type | checks run | result: PASS / FAIL
- If FAIL: violation list (each violation on its own row, monospace)
- Zero-cost annotation: `(0 inference calls)`

**Section: Gate 1 — Binary Dimensions**
Table:
| Dimension | Threshold | Score | Verdict | Reasoning (truncated) |
|---|---|---|---|---|
| `accuracy` | 70 | 91.0 | PASS | "Evidence directly supports..." |
| `tool_verification` | 70 | 45.0 | FAIL | "Tool output not verified against..." |

- FAIL rows: red background tint (5%)
- Expand row → full judge reasoning, prose + fenced JSON
- `merged_judge_mode` indicator if active: `MERGED (3 dims in one call)`
- `accuracy auto-excluded from merge` warning if triggered

**Section: Gate 2 — Weighted Dimensions**
- Weight-normalized score bar at top:
  ```
  task_completion   0.25  ████████████  92.0
  specificity       0.10  ████████░░░░  74.0
  substantiveness   0.10  ██████████░░  83.0
  novelty           0.10  ████░░░░░░░░  51.0  (attempt 2)
  ─────────────────────────────────────────
  WEIGHTED SCORE          79.4  (threshold: 80)  FAIL
  ```
- Each row: dimension name | weight | bar | score | verdict
- `novelty` auto-pass on attempt 1 annotated
- `strategy: synthesize → coherence added` annotation if applicable
- Expand row → full judge reasoning

**Section: Failure Classification** (if Gate 1 or Gate 2 failed)
- `failure_type: reasoning_failure`
- `retry_addition` text shown (the prompt injection for next attempt)
- `Infrastructure failure?` flag → `does NOT consume retry budget`

---

### Screen 5: Trace Timeline

**Purpose:** Chronological full event stream for a run. Debugging and audit.

**Layout:** Filter bar + virtualized event list.

**Filter bar:**
- Event type multi-select (searchable dropdown): all M-03 event types
  - pre_check, gate_verdict, judge_reasoning, context_assembly, sec_write, occ_conflict, dependency_edge, hitl_event, recursion_guard_override, retry, compression, blob_write, failure_classification, normalization, sandbox_event, kill_switch, budget_state, sec_size_warning, pattern_lookup_latency_ms, plan_validation_runtime_divergence, merged_judge_fallback, early_termination, escalation, sec_occ_retry, ...
- Agent ID filter (multi-select from tree)
- Severity filter: info / warning / error / critical
- Time range scrubber (relative to run start)
- Free-text search across payload

**Event list (virtualized for large runs):**
Each row:
```
[+00.412s]  gate_verdict          exec_b3a1    Gate 1 PASS  score=87.0  dim=accuracy
[+00.819s]  sec_write             plan_a1c2    key=plan_output  version=v3  status=success
[+01.204s]  occ_conflict          plan_a1c2    key=shared_state  rejected_version=v2  current=v3
```
- Timestamp: `+XX.XXXs` relative to run start (absolute ISO on hover)
- Event type: monospace, color-coded by category
- Agent ID: monospace link → opens Agent Node Detail
- Summary: key fields inline

**Expand event row:**
- Full payload as formatted/syntax-highlighted JSON
- `caused_by` chain: if present, inline link to source event

**Causal chain view:**
- Click any ESCALATED event → toggle "show causal chain" → filtered view showing only events in the `caused_by` chain, highlighted

---

### Screen 6: SEC Inspector

**Purpose:** Inspect the Shared Execution Context for a run.

**Layout:** Table + detail panel.

**Header:**
- Run ID | SEC entry count | `sec_size_warning` badge if triggered | last updated timestamp

**Table: SEC entries**
| Column | Notes |
|---|---|
| Key | monospace |
| Current Version | e.g. `v4` |
| Written By | agent_id link |
| Readable By | `all` / `planner_only` |
| Value (truncated) | first 80 chars, monospace |
| OCC Conflicts | count (red if > 0) |
| Last Updated | relative time |

- Click row → open detail panel (right side)

**Detail panel:**
- Key name (monospace, large)
- Current value: full JSON, syntax-highlighted
- Version history: table of `version_id | written_by | timestamp | value (truncated)` — click version to view full value diff
- OCC conflict log: for each conflict: `rejected_by | rejected_version | current_version | resolution | timestamp`
- `merge` resolutions: show merged value diff vs each writer's attempted value
- If `sec_size_warning` triggered: amber banner at top of panel

---

### Screen 7: Ticket Dashboard

**Purpose:** Triage and track all system-filed tickets across runs.

**Layout:** Filter sidebar + table.

**Filters (left sidebar, 220px):**
- Severity: CRITICAL / MAJOR / MINOR
- Status: open / resolved / suppressed
- Ticket type (from P-19 taxonomy): list with counts
- Run ID (multi-select)
- Date range

**Table:**
| Column | Notes |
|---|---|
| Ticket ID | monospace |
| Type | e.g. `occ_max_retries_exceeded`, `sec_size_warning`, `kill_switch_triggered` |
| Severity | chip: red/amber/muted |
| Run | run_id link |
| Agent | agent_id link (if node-scoped) |
| `failure_type` | if applicable |
| `failure_gate` | Gate 1 / Gate 2 / PreCheck |
| Status | open / resolved / suppressed |
| Filed | ISO timestamp |

**Ticket detail (slide-out panel):**
- All fields above (full)
- `context` object: full JSON, syntax-highlighted
- Related events: links to Trace Timeline filtered to this ticket's run + agent
- Notes field (free text, operator-editable)
- Status update: mark resolved / suppress

**Summary bar above table:**
```
CRITICAL  12  open     MAJOR  34  open     MINOR  87  open
```
Click counts → auto-filter table

---

### Screen 8: Budget & Cost Analytics

**Purpose:** Token spend, inference cost, and wall-time trends across runs.

**Layout:** KPI row + two chart rows + run breakdown table.

**KPI row (4 cards):**
- Total token spend (all time) | trend arrow vs last 7d
- Average cost per run | P95
- Average wall time | P95
- Runs over budget (%) | last 30d

**Chart row 1:**
- Token spend over time (line chart, daily): `tokens consumed` + `budget limit` overlay
- Breakdown by agent type: stacked bar (Router / Planner / Executor shares)

**Chart row 2:**
- Wall time distribution: histogram (all runs, last 30d)
- Kill switch events over time: bar chart (cost_exceeded / time_exceeded / loop_detected, stacked by type)

**Run breakdown table:**
| Run ID | Tokens | Calls | Wall Time | Budget % | Kill Switch? | Cost |
|---|---|---|---|---|---|---|
Sortable by any column. Click run → Run Detail.

**Budget threshold analysis:**
- "Runs within 10% of token limit: 23%" — amber if > 20%
- "Runs within 10% of wall time: 8%"
- Expand → list of those runs

---

### Screen 9: Meta Loop Insights

**Purpose:** Cross-run calibration and learning performance.

**Layout:** Three sections: Plan Cache | Pattern Store | Classification Accuracy.

**Section: Plan Cache**
- KPIs: cache size | hit rate (last 30d) | average similarity score on hits | invalidations (last 30d)
- Hit rate over time: line chart
- Cache entries table:
  | Entry ID | Objective (truncated) | Similarity Threshold | Config Hash | Hit Count | Last Hit | Last Written |
  - Hover entry → show originating run_id, full objective
  - Invalidated entries: strikethrough, reason shown (contract version change / tool registry change)

**Section: Pattern Store**
- KPIs: total patterns | eviction rate | ANN index active? (threshold: 1,000) | LRU vs oldest_first policy
- Pattern count over time (line chart)
- Eviction events table: `timestamp | pattern_id | reason | last_accessed`
- Pattern browser: searchable by objective cluster / domain
  - Each pattern row: objective snippet | similarity score cluster | domain | usage_count | last_used
  - Click → full pattern payload

**Section: Classification Accuracy**
- KPI: `classification_accuracy` metric (fraction of runs where router_classification matched actual_depth_reached)
- Confusion matrix: `router said` vs `actual depth reached` (atomic/simple/moderate/complex x 4)
- Per-run log table: run_id | router_classification | actual_depth | trace_eval_score | matched?
- Trend: accuracy over time (line chart, 30-run rolling window)
- `complexity_override_rules` impact: runs where override fired | which rule | outcome

---

### Screen 10: HITL Queue

**Purpose:** Human-in-the-loop approvals. Operator action screen.

**Layout:** Queue list (left, 360px) + action panel (right, flex).

**Queue list:**
- Each item: agent_id | run objective (truncated) | checkpoint label | `AWAITING_HITL` chip + elapsed time
- Items sorted by: elapsed time desc (oldest first)
- Timeout countdown: amber when < 20% remaining, red when < 5%
- Click item → load in action panel

**Action panel:**
**Header:** agent_id | type (ROUTER/PLANNER/EXECUTOR) | run_id link | checkpoint label

**Context section:**
- Parent scope / objective
- Agent's current output (full, formatted/syntax-highlighted)
- Eval state so far: PreCheck result | Gate 1 scores if run
- SEC state relevant to this agent (read-only)
- Prior retry history (if any)

**Action buttons:**
```
[ Approve & Continue ]   [ Edit Brief ]   [ Edit Output ]   [ Reject & Escalate ]
```
- **Approve:** one click, confirms with `Are you sure?` inline (no modal)
- **Edit Brief:** inline editor for the agent's scope text; submit re-queues agent with edited brief
- **Edit Output:** inline editor for agent's output JSON; submit accepts edited output, proceeds to eval
- **Reject & Escalate:** marks agent ESCALATED immediately; requires a reason (short text)

**Timeout display:**
- `on_timeout: proceed` → amber banner: `Will auto-proceed in 00:42`
- `on_timeout: escalate` → red banner: `Will auto-escalate in 00:42`

**Resolved items tab:**
- Same list for completed HITL checkpoints: action taken | operator | timestamp | resolution outcome

---

### Screen 11: Dependency Graph View

**Purpose:** Visual DAG of agent execution order for a run.

**Layout:** Full-panel canvas with controls overlay.

**Graph:**
- Nodes: agent_id + type icon + state chip, sized by token cost (larger = more tokens)
- Edges: directed arrows labeled with `output_contract.required_fields` (truncated) + TTL if set
- Node colors: match state chip colors (green=COMPLETE, amber=ESCALATED, red=ERROR, gray=CANCELLED, blue=active)
- Edge states: dashed = waiting/blocked, solid = fulfilled, red = timed out (`on_timeout` fired)
- `proceed_degraded` edges: amber dashed with `[degraded]` label

**Controls (overlay, top-right):**
- Zoom in/out | fit to view | reset
- Filter: show only critical path | show only ESCALATED nodes + their ancestors
- Layout toggle: top-down (default) | left-right

**Node hover tooltip:**
- Full agent_id | scope (truncated) | state | tokens consumed | wall time | eval score

**Node click:**
- Opens Agent Node Detail (Screen 3) in a slide-over panel (graph stays visible)

**Edge click:**
- Shows edge detail: `from → to` | `output_contract` full spec | TTL | status | `on_timeout` value

**Legend (bottom-left):**
- Node state colors | edge types (solid/dashed/degraded/timedout)

---

### Screen 12: Failure Analysis

**Purpose:** Failure type distribution, retry effectiveness, escalation rates.

**Layout:** KPI row + chart grid + drilldown table.

**KPI row:**
- Total failures (all runs, last 30d)
- Escalation rate (% of agents that escalated)
- Retry resolution rate (% of retried agents that ultimately passed)
- Most common failure type (chip)

**Chart grid:**
- **Failure type distribution** (horizontal bar chart): `retrieval_failure | reasoning_failure | planning_failure | tool_failure | timeout_failure | novelty_failure | schema_failure | infrastructure_failure | blob_write_failure` — count + % of total
- **Retry effectiveness** (grouped bar): per failure type — `retried` vs `resolved after retry` vs `escalated after retry`
- **Failures over time** (stacked area chart, daily): colored by failure type
- **Gate where failures occur** (donut): PreCheck / Gate 1 / Gate 2

**Drilldown table:**
| Run ID | Agent | Failure Type | Gate | Attempt | Resolved? | Escalated? |
Filterable by failure type. Click row → Agent Node Detail.

**Infrastructure vs Inner Loop failures panel:**
- `infrastructure_failure` count | `blob_write_failure` count | note: `these do NOT consume retry budget`
- Backoff retry attempts on blob_write: histogram

---

### Screen 13: Judge Calibration

**Purpose:** Eval system health — judge skip rates, false negatives, merged mode performance.

**Layout:** Three sections: Judge Performance | Merged Mode | Adaptive Calibration.

**Section: Judge Performance**
- Per-dimension table (one row per dimension across all agent types):
  | Dimension | Agent Type | Avg Score | Pass Rate | Skip Rate | False Neg Rate |
  - False negative: gate passed but trace eval later failed (correlation metric)
  - Color code: red if false_neg_rate > 10%
- `novelty` row: auto-pass rate on attempt 1 shown separately

**Section: Merged Mode**
- Merged mode active? (boolean from JudgingPolicy)
- Call reduction vs isolated: `saves ~65% of judge calls`
- Fallback events (malformed response → isolated): count + rate
- `accuracy auto-excluded from merge` events: count (fires when prompt > 80% window)
- Response time: merged vs isolated (side-by-side bar)

**Section: Adaptive Calibration**
- JudgingPolicy mode: `full | adaptive | custom`
- Skip rate tracking: per-dimension bar chart (adaptive mode)
- False negative rate trend (line chart, 30-run rolling window)
- `feedback_loop_snapshot_id`: current snapshot | rollback controls (list of snapshots with timestamp + accuracy score)
- FeedbackLoopHealth: last N runs — `feedback_loop_enabled` | `weight_updates` count | `clamping_events` count

---

### Screen 14: Pattern Store

**Purpose:** Browse and manage the MetaLoop successful pattern store.

**Layout:** Search/filter bar + table + detail panel.

**Search/filter bar:**
- Full-text search (objective snippet, domain)
- Domain filter (from DomainRegistry)
- Objective cluster filter
- Embedding model filter (warn if model mismatch vs current)
- Sort: last_used | usage_count | similarity_score

**Table:**
| Pattern ID | Objective Snippet | Domain | Similarity Score | Usage Count | Last Used | Embedding Model | Eviction Risk |
- Eviction risk = LRU position indicator (green/amber/red based on distance from eviction threshold)
- Embedding model mismatch: amber row, tooltip: `model mismatch — will be treated as cache miss`

**Detail panel (right side):**
- Pattern ID (monospace)
- Full objective text
- Domain + cluster
- `successful_plan_embedding` metadata: model_id | dimensions | created_at
- `successful_sec_patterns`: SEC key patterns from this run (artifact, capped to 512 tokens)
- Usage history: runs that used this pattern + their trace scores
- Manually evict button (requires confirmation): `Evict pattern [id] from store?`

**Store health bar:**
```
Patterns:  8,241 / 10,000  ████████░░  82%
ANN index: ACTIVE (above 1,000 threshold)
Eviction policy: LRU
```
Amber at 90%, red at 95%.

---

### Screen 15: Config Inspector

**Purpose:** Runtime config per run — all policies, overrides, contract versions.

**Layout:** Run selector + tabbed policy sections.

**Run selector:** dropdown or search — select any historical run to inspect its exact config snapshot.

**Header:**
- `run_config_hash` (monospace, copyable)
- `Plan cache invalidated by this config?` indicator
- Diff mode: compare two run configs side-by-side (select two runs)

**Tabs:**

**Tab: Budget**
- `max_tokens` | `max_calls` | `wall_clock_sla_ms` | `on_budget_exceeded` | `expansion_cost_reserve`

**Tab: Eval / Judging**
- `JudgingPolicy`: mode | `merged_judge_mode` | `skip_dimensions` | `early_stop_on_gate1`
- `model_infra_retry_max`
- Per-agent-type contract: dimension | weight | threshold — table form
- `applyStrategyOverrides` applied? Show diff vs base contract

**Tab: Retry / Repair**
- `RepairPolicy`: `max_retries` per agent type | `blob_write_retry_max` | `model_infra_retry_max`
- `OuterLoop` enabled? | `max_outer_loop_attempts`
- `KillSwitch` thresholds: `cost_exceeded` limit | `time_exceeded` limit | `loop_detected` threshold | `action`

**Tab: Context Assembly**
- `ContextAssemblyPolicy`: `ranking_model` | `diversity_penalty` | `max_context_tokens` | `retrieval_sources`
- `feedback_loop` enabled? | snapshot_id
- `CompressionPolicy`: mode | `max_escalated_output_tokens`

**Tab: Execution**
- `ParallelismPolicy`: `max_concurrent_agents` | `max_queued_agents`
- `LatencySLAPolicy`: per-agent-type wall time budgets | `on_violation`
- `DepthPolicy`: `max_depth` | `depth_cap_action`
- `EarlyTerminationPolicy`: `confidence_threshold` | `enabled`
- `RecursionGuard`: `min_scope_tokens` | `complexity_override_rules` list

**Tab: Infrastructure**
- `SandboxConfig`: enabled | `tool_execution` | `data_access` | `network_policy` | `on_violation`
- `ConflictResolutionPolicy`: `reject | merge | priority | escalate` | `max_occ_retries` | `SEC_list_max_entries`
- `BlobStorePolicy`: backend type | `on_quota_exceeded`
- `ModelPolicy`: primary model | fallback model | judge model | embedding model

**Tab: Tools & Domains**
- Registered tools at run time: tool_id | `side_effect_class` | `idempotent` | `retry_on_error` | input/output schema present?
- Registered domains: domain_id | scope match hints
- Contract versions: per agent type | version | `plan_cache invalidated by version change?`

**Diff mode (two-run compare):**
- Side-by-side tables, changed fields highlighted in amber
- `run_config_hash` delta displayed
- `Plan cache: would have been invalidated` / `would have been hit` based on diff

---

### Navigation Map

```
Runs List (/)
├── Run Detail (/runs/:id)
│   ├── Agent Node Detail (/runs/:id/agents/:agent_id)
│   │   └── Eval Pipeline View (/runs/:id/agents/:agent_id/eval)
│   ├── Trace Timeline (/runs/:id/trace)
│   ├── SEC Inspector (/runs/:id/sec)
│   ├── Dependency Graph (/runs/:id/graph)
│   └── Config Inspector (/runs/:id/config)
├── HITL Queue (/hitl)
├── Ticket Dashboard (/tickets)
├── Budget & Cost Analytics (/analytics/budget)
├── Meta Loop Insights (/analytics/meta)
├── Failure Analysis (/analytics/failures)
├── Judge Calibration (/analytics/judges)
└── Pattern Store (/analytics/patterns)
```

---

### State Chip Color Reference

| State / Status | Background | Text |
|---|---|---|
| QUEUED | #6B7280 15% | #9CA3AF |
| AWAITING_HITL | #7C3AED 15% | #A78BFA |
| PRECHECKING | #2563EB 15% | #93C5FD |
| GENERATING | #D97706 15% | #FCD34D |
| GATE1_EVALUATING | #0891B2 15% | #67E8F9 |
| GATE2_EVALUATING | #0E7490 15% | #A5F3FC |
| COMPLETE | #059669 15% | #6EE7B7 |
| ESCALATED | #D97706 15% | #FCD34D |
| RETRYING | #EA580C 15% | #FDBA74 |
| CANCELLED | #374151 15% | #6B7280 |
| ERROR | #DC2626 15% | #FCA5A5 |
| PARTIALLY_COMPLETE | #CA8A04 15% | #FDE68A |
| running | #2563EB 15% | #93C5FD |
| complete | #059669 15% | #6EE7B7 |
| partial_complete | #CA8A04 15% | #FDE68A |
| escalated | #D97706 15% | #FCD34D |
| error | #DC2626 15% | #FCA5A5 |
| Unexpected exception | 1 (with traceback) |
