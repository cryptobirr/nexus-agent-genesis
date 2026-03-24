# Agent Nexus v5

## Product Requirements Document — Production-Grade Autonomous Architecture

---

**Status:** Draft v5.1
**Classification:** Internal Product
**Owner:** Product Engineering
**Last Updated:** 2026-03-22T00:00:00Z

---

### v5.1 Changelog

All changes in v5.1 are spec amendments only. No new primitives were added. All 20 primitives from v5.0 are retained.

| ID | Priority | Change |
|---|---|---|
| C-01 | P0 | Strategy weight semantics changed from delta to absolute override (`weight_override`). Normalization behavior documented explicitly. |
| C-02 | P0 | `RequirementMap` and `RequirementRecord` interfaces added to §14. Coverage score mapping formalized. `priority` field added to `RequirementRecord`. |
| C-03 | P0 | `merge` ConflictResolutionPolicy now has a canonical algorithm: first-writer-wins per object key, lexicographic array append by `written_by` agent ID. `key_conflict_discarded` added to `SECConflict`. |
| C-04 | P1 | `blob_write_failure` added to `FailureType` taxonomy. BS-06 requirement added. `blob_write_retry_max` added to `RunConfig`. Blob write failure added to ticket table and failure classifier. |
| C-05 | P1 | `embedder` and `embedder_dimension` added to `ModelPolicy`. `embedding_model_id` and `embedding_dimension` added to `SuccessfulPattern` and `PlanCacheEntry`. Embedding model mismatch = cache miss. |
| C-06 | P1 | `fallback_payload` added to `OutputContract`. Harness injection behavior on `proceed_degraded` timeout defined. |
| C-07 | P1 | `normalization_mode` field added to `OutputSpec`. Per-type normalization defaults table added. No-op rule for null schema + empty required_fields + passthrough mode documented. |
| C-08 | P1 | `priority` field added to `RequirementRecord`. High-priority requirement guard added to early termination — blocks termination regardless of confidence or `require_all_covered`. ET-07 added for cancellation ordering. |
| C-09 | P1 | `snapshot_read(keys[])` added to `SECBackend`. `SECSnapshot` interface added. SC-13 requirement added. |
| C-10 | P2 | EM-04 updated with ANN index threshold and pattern lookup latency metric. ML-11 updated with pattern store size bound and eviction policy. `max_pattern_store_size`, `pattern_store_eviction_policy`, `pattern_store_index_threshold` added to `RunConfig`. |
| C-11 | P2 | `FeedbackLoopHealth` interface added to §14. CA-11, CA-12 requirements added. `feedback_loop_health` added to `Run`. `feedback_loop_snapshot_id` added to `RunConfig`. `feedback_loop` bus event type added. |
| C-12 | P2 | ML-13, ML-14 requirements added for complexity classification log and calibration metric. `ComplexityOverrideRule` interface added. `complexity_override_rules` added to `RunConfig`. |
| C-13 | P2 | `Tool` interface expanded with `input_schema`, `output_schema`, `latency_sla_ms`, `side_effect_class`, `retry_on_error`. Harness enforcement documented. |
| C-14 | P2 | `BlobStorePolicy` interface added. `blob_store_policy` added to `RunConfig`. Quota exceeded behavior tied to `blob_write_failure` classification. |
| C-15 | P2 | `run_wall_clock_sla_ms` added to `RunConfig`. KS-05 requirement added. NFR Latency-aware row updated. |
| C-16 | P2 | `finalize_partial` added to `KillSwitchTrigger.action`. KS-03a requirement added. `PARTIAL_COMPLETE` run status added. `partial_output_timeout_ms` added to `RunConfig`. Glossary updated. |

---

## Table of Contents

1. [Abstract](#1-abstract)
2. [Synthesis: What Both Reviews Found](#2-synthesis-what-both-reviews-found)
3. [What Changed from v4](#3-what-changed-from-v4)
4. [Design Philosophy](#4-design-philosophy)
5. [Core Primitives](#5-core-primitives)
6. [Architecture](#6-architecture)
7. [The Three Agent Types](#7-the-three-agent-types)
8. [The Eval System](#8-the-eval-system)
9. [The Three Loops](#9-the-three-loops)
10. [Ticket System](#10-ticket-system)
11. [Functional Requirements](#11-functional-requirements)
12. [Non-Functional Requirements](#12-non-functional-requirements)
13. [Agent State Machine](#13-agent-state-machine)
14. [Data Contracts](#14-data-contracts)
15. [User Stories](#15-user-stories)
16. [Constraints & Assumptions](#16-constraints--assumptions)
17. [Glossary](#17-glossary)

---

## 1. Abstract

Agent Nexus v5 hardens v4's production architecture against the failure modes that emerge under high-concurrency, high-depth, and high-stakes workloads. v4 closed the gap between an evaluation harness and an autonomous system. v5 closes the gap between a system that works under controlled conditions and one that is trustworthy at scale.

Two independent reviews of v4 converged on the same five architectural vulnerabilities: silent state corruption from concurrent SEC writes, context fidelity loss when the ContextCompressor summarizes structured data, evaluation latency bloat from per-dimension judge calls, dependency deadlocks with no escape valve, and a recursion guard that measures verbosity instead of complexity. v5 addresses all five with precision.

Beyond hardening, v5 adds the production primitives deliberately deferred in v4: execution isolation, plan pre-validation, failure-type-aware retries, output schema normalization, and short-term execution memory. It adds the operational controls that high-volume deployments require: model routing policy, concurrency bounds, latency SLAs, early termination, idempotency, and a hard kill switch.

**Five new primitives in v5:**

- **EXECUTION MEMORY** — a per-node, per-run short-term cache of retrieved chunks, failed strategies, and successful patterns. Prevents redundant retrieval on retries and informs the retry prompt with what has already failed.
- **PLAN VALIDATOR** — a pre-spawn validation gate that runs between Router output and first agent spawn. Validates dependency correctness, coverage completeness, and cost bounds before a single Executor fires.
- **FAILURE CLASSIFIER** — a harness component that classifies every failure into a typed taxonomy (`retrieval | reasoning | planning | tool | timeout | novelty | schema`). Drives different retry templates per failure type instead of one generic retry prompt.
- **OUTPUT NORMALIZER** — a harness-managed normalization step that converts Executor output to a declared schema before pre-checks and eval run. Enables deterministic structural validation on heterogeneous output.
- **EXECUTION SANDBOX** — a scoped isolation layer around every tool execution. Executors cannot access tools outside their injected subset. Tool execution runs in an isolated context with scoped data access.

**Seven structural changes from v4:**

- **SEC concurrency control** — the SEC now uses Optimistic Concurrency Control (OCC). Planners read with a `version_id` and write conditionally. Conflicting writes fail loudly and trigger re-read before re-decompose. `ConflictResolutionPolicy` is configurable per run.
- **Blob store for structured data** — the ContextCompressor no longer summarizes structured Executor outputs. Executors that produce typed payloads (arrays, JSON, time-series) write them to a run-scoped blob store and pass a pointer. Downstream consumers dereference the pointer, not the summary.
- **Eval merging** — Gate 1 dimensions can be batched into a single judge call via `merged_judge_mode`. Reduces evaluation latency by up to 70% for routine agents without relaxing the two-gate verdict system.
- **DependencyEdge TTL + data contracts** — every DependencyEdge declares a timeout and fallback behavior. Dependent agents no longer wait indefinitely. Edges also carry an `output_contract` — the schema and required fields the prerequisite must produce — enabling pre-spawn validation.
- **Complexity-aware recursion guard** — the RecursionGuard now consults the Router's `complexity_classification` as the primary signal. Token count is a tiebreaker, not the primary heuristic. A 50-token dense technical brief classified `complex` by the Router will not be forced to a single Executor.
- **Failure-type-aware retries** — the Inner Loop now receives a `failure_type` from the Failure Classifier before composing the retry prompt. Retrieval failures trigger re-assembly. Reasoning failures trigger CoT injection. Tool failures trigger fallback tool selection.
- **Strategy-aware planning** — Planners declare a `strategy` per child scope in the decomposition output. Strategy drives tool selection, context assembly behavior, and eval dimension weighting for that child without additional operator configuration. Different children of the same Planner may declare different strategies.

Everything stable in v4 carries forward unchanged.

---

## 2. Synthesis: What Both Reviews Found

Both independent reviews identified the same architectural center of gravity: **v4 is correct at rest but brittle under concurrency, depth, and structured data.** The convergence is signal. Below is the cross-review synthesis that drove v5's prioritization.

| Theme | Feedback 1 Finding | Feedback 2 Finding | v5 Response |
|---|---|---|---|
| SEC race conditions | Silent last-write-wins overwrites; children spawn on stale state | Conflicts silently corrupt strategy | OCC + `ConflictResolutionPolicy` |
| Structured data fidelity | Text summarization destroys arrays, time-series, JSON | Context Compression loses structured outputs | Blob store + `data_refs` pointer pattern |
| Eval latency | 4 LLM calls per node; cost explosion in deep trees | (implied by judge cost concern) | `merged_judge_mode` (batch Gate 1) |
| Dependency deadlocks | Infinite waits on HITL null-timeout or retry loop | Latency SLAs missing entirely | DependencyEdge TTL + per-agent `latency_sla` |
| Recursion guard weakness | Token count ≠ complexity; dense 50-token brief forced to single Executor | Dynamic depth control missing | Complexity-aware RecursionGuard + `depth_policy` |
| Missing failure taxonomy | (implied by retry feedback) | All failures treated identically | FAILURE CLASSIFIER primitive |
| Missing pre-execution validation | (implied) | Bad plans execute immediately | PLAN VALIDATOR primitive |
| Missing production controls | (implied) | Kill switch, sandbox, model routing, idempotency absent | `RunConfig` additions + EXECUTION SANDBOX |
| Cost visibility | (implied by eval merging) | Planners ignore cost; explosion risk | `plan_cost_estimate` + `cost_compliance` dimension |
| Execution memory | (implied by retry context) | ContextAssembly repeats retrieval on each retry | EXECUTION MEMORY primitive |

**What v5 deliberately deferred:** Feedback 2 proposed a Global Objective State (GOS) to replace the SEC with a broader typed, queryable, cross-agent store. v5 addresses the immediate correctness problems (OCC, typed values, Executor read access) without redesigning the primitive. GOS is tracked as a v6 candidate after OCC behavior is validated in production. Similarly, multi-model routing (`model_policy`) and success-pattern learning are included in `RunConfig` and the Meta Loop respectively but are not blocking for v5 deployment. Cross-key SEC semantic conflict detection — OCC guarantees per-key write integrity but cannot detect logically incompatible values across keys. Tracked as a v6 requirement alongside GOS.

---

## 3. What Changed from v4

| Area | v4 Behavior | v5 Behavior |
|---|---|---|
| SEC writes | Last-write-wins per key | OCC: reads include `version_id`; writes conditional; conflict → re-read + re-decompose |
| SEC value types | String only | Typed: `string \| number \| boolean \| object` |
| SEC access | Planners write only | Planners write; Executors read (read-only) |
| SEC conflict policy | Log + continue | `ConflictResolutionPolicy`: `reject \| merge \| priority \| escalate` |
| ContextCompressor | LLM text summaries for all output | Blob store for structured data; `data_refs` pointers bypass text compression |
| DependencyEdge | No timeout | `timeout_ms` + `on_timeout` per edge |
| DependencyEdge | Structural only | `output_contract`: schema + required fields; validated pre-spawn by PLAN VALIDATOR |
| Eval pipeline | One Judge per dimension | `merged_judge_mode`: batch Gate 1 dims into single call; isolated calls for high-stakes |
| RecursionGuard | Token count threshold only | `complexity_classification` is primary signal; token count is tiebreaker |
| Retry prompt | One generic template per gate | Failure Classifier types every failure; targeted retry template per type |
| Planner output | No strategy, no cost estimate | Per-child `strategy` field + `plan_cost_estimate` |
| Planner Contract | 4 dimensions | Adds `cost_compliance` (Gate 2) |
| Executor output | No data pointers, no normalization | `data_refs` for structured payloads + `normalized_output` via OUTPUT NORMALIZER |
| Executor output | No idempotency | `idempotency_key` prevents duplicate tool execution on retry |
| Executor Contract | 5 dimensions | Adds `novelty` (Gate 2) |
| ContextAssembly | Keyword/embedding only | `ranking_model`, `diversity_penalty`, `feedback_loop` |
| Pre-spawn validation | Cycle detection only | PLAN VALIDATOR: dependency + coverage + cost bounds |
| Tool execution | Harness-managed, no runtime isolation | EXECUTION SANDBOX: isolated context + scoped data access |
| Execution memory | None | EXECUTION MEMORY: per-node cache of retrieved chunks, failed strategies, successful patterns |
| Depth control | Static hint + cap | `depth_policy`: adaptive expand/shrink on coverage gaps and entropy |
| Early termination | None | `early_termination`: RequirementMap satisfaction check mid-run |
| Kill switch | None | `kill_switch`: hard stop on `cost \| time \| loop_detected` |
| Parallelism | Unbounded | `parallelism_policy`: `max_concurrent_agents` + priority queue |
| Latency | Unbounded | `latency_sla_policy`: `budgets` (per-agent-type ms) + `on_violation` |
| Model selection | Model agnostic, no routing | `model_policy`: assign models per role (planner, executor, judge) |
| Idempotency | None | `idempotency_key` per AgentNode; `replay_mode` on Run |
| Meta Loop | Failure-oriented calibration | Adds success pattern learning: `successful_plan_embeddings`, `successful_sec_patterns` |
| Failure taxonomy | No failure typing | FAILURE CLASSIFIER: `retrieval \| reasoning \| planning \| tool \| timeout \| novelty \| schema` |
| Output schema | Heterogeneous, unenforced | OUTPUT NORMALIZER: schema declaration + normalization before eval |
| Security | Policy-declared only | EXECUTION SANDBOX: runtime tool isolation, data access scoping |
| Primitives | 15 | 20 |

---

## 4. Design Philosophy

All v4 principles carry forward. Two additions in v5:

### Concurrency is a correctness problem, not a performance problem

Concurrent agents that share state will produce inconsistent results unless the shared state layer has the same guarantees as a distributed system. Optimistic concurrency control, write conflicts that fail loudly, and policy-driven conflict resolution are not operational conveniences — they are correctness requirements. Silent state divergence in a multi-Planner run is not a race condition to tolerate; it is a class of wrong answer to eliminate.

### Production readiness is not a separate track

Isolation, idempotency, kill switches, and latency SLAs are not post-launch concerns. A system that cannot bound its own cost, stop itself cleanly, or replay a run deterministically is not a production system. These controls belong in the architecture from the start. v5 builds them into `RunConfig` and the harness primitives, not a future "hardening pass."

---

## 5. Core Primitives

Twenty irreducible components. Every feature in v5 is a composition of these.

*Primitives 1–10 are unchanged from v3/v4. Primitives 11–15 are from v4 with v5 upgrades noted. Primitives 16–20 are new in v5.*

---

### Primitives 1–10 (Unchanged from v3/v4)

| # | Primitive | Summary |
|---|---|---|
| 1 | CONTRACT | Versioned success specification per agent type, composed of Dimensions |
| 2 | DIMENSION | One independently evaluable quality. Binary → Gate 1. Non-binary → Gate 2 |
| 3 | JUDGE | Independent model call for one Dimension. Two-phase output: prose CoT then fenced JSON |
| 4 | SIGNAL | Structured feedback from a Judge: verdict, numeric_score, gap, severity, reasoning |
| 5 | SCOPE | Span (per agent) and Trace (full mission) evaluation units |
| 6 | LOOP | Inner (per agent), Outer (per run), Meta (cross-run) feedback loops |
| 7 | DETERMINISTIC PRE-CHECK | Zero-token structural validation before any Judge is invoked |
| 8 | TOOL | Harness-managed external capability. Executors declare; harness executes |
| 9 | BUDGET | Runtime resource enforcement with degradation modes |
| 10 | REQUIREMENT | Discrete verifiable success criterion extracted by Router, used for deterministic trace coverage |

---

### Primitive 11: CONTEXT ASSEMBLY (v4, upgraded in v5)

**Proactive retrieval and context enrichment before an Executor's first LLM call.**

Unchanged from v4 with three additions:

**`ranking_model`:** Replaces simple relevance scoring with a configurable ranking model. `cross_encoder` re-ranks retrieved chunks for precision at higher latency cost. `embedding` uses vector similarity at lower latency. Default is `embedding`; use `cross_encoder` for high-stakes accuracy requirements.

**`diversity_penalty`:** A 0–1 scalar that penalizes retrieved chunks too semantically similar to one another. Prevents the assembled context from being dominated by near-duplicate results from a single source. Default `0.2`.

**`feedback_loop`:** When enabled, the harness records which retrieved chunk IDs appeared in the Executor's `evidence` field for runs that pass eval. High-signal chunks are weighted up in future retrievals; unused chunks from passing runs are weighted down. This signal feeds back into relevance scoring without requiring explicit operator tuning.

**Feedback loop write protocol:** Chunk relevance weight updates SHALL be applied as atomic increments/decrements to a per-chunk weight counter, not as full overwrites. Concurrent writes to the same chunk weight are safe because they commute (increment is associative). A chunk's weight SHALL be clamped to the range `[base_weight × 0.5, base_weight × 2.0]` to prevent runaway amplification or suppression. Operators MAY configure `feedback_loop_ttl_days` (default: 30); chunk weights older than the TTL revert to `base_weight`.

**EXECUTION MEMORY integration:** On retry, the harness checks the node's `ExecutionMemory.retrieved_chunks` before querying retrieval sources. Already-retrieved chunk IDs are re-injected without a new retrieval call. Cache misses proceed normally.

```typescript
interface RetrievalSource {
  id:          string
  source_type: "general" | "schema_reference" | "constraint"
}

interface ContextAssemblyPolicy {
  enabled:              boolean
  retrieval_sources:    RetrievalSource[]
  max_context_tokens:   number
  relevance_threshold:  number
  inject_position:      "prepend" | "append"
  deduplicate:          boolean
  ranking_model:        "cross_encoder" | "embedding"   // v5
  diversity_penalty:    number                           // v5: 0–1
  feedback_loop:        boolean                          // v5
}
```

---

### Primitive 12: SHARED EXECUTION CONTEXT (v4, upgraded in v5)

**A run-scoped read/write store accessible to all Planners, with Executor read access and OCC write semantics.**

v5 makes three changes: typed values, Optimistic Concurrency Control, and configurable `ConflictResolutionPolicy`.

**Optimistic Concurrency Control (OCC):** Every SEC read returns the entry's current `version_id`. Every SEC write must include the `version_id` that was read. If the key has been written by another agent since the read, the write is rejected. The Planner must re-read and adjust its decomposition before spawning children. This eliminates the silent-overwrite class of bugs identified in both reviews — children are never spawned on state the Planner did not validate.

**OCC write protocol:**
1. Planner reads SEC entries with `version_id`.
2. Planner generates decomposition.
3. Before spawning children, Planner writes key decisions with the `version_id` it read.
4. If write rejected (version mismatch), Planner re-reads SEC, updates its decomposition, retries write.
4a. The harness constructs an OCC conflict summary for the Planner's re-decompose prompt: the conflicting key, the Planner's rejected value, the current winning value, and the `ConflictResolutionPolicy` applied.
5. Children spawn only after all writes succeed.

**ConflictResolutionPolicy:**

| Policy | Behavior |
|---|---|
| `reject` | Write fails. Planner re-reads and re-decomposes. Default for critical path agents. |
| `merge` | Harness attempts value-level merge using the canonical algorithm below. Falls back to `reject` on top-level type conflict. After a successful merge, the harness re-injects the merged value into the Planner's context as a synthetic re-read before children spawn. If the merged value is structurally different from what the Planner wrote, a full re-decompose is required. |
| `priority` | Higher-depth (more specific) Planner wins. Losing Planner's write is rejected and the losing Planner is treated identically to `reject` — it must re-read the winning value and re-decompose before spawning children. |
| `escalate` | Conflict surfaced to operator via HITL before any write succeeds. Use for high-stakes decisions. |

**`merge` canonical algorithm:**

- **Object-typed values:** When both writes contain the same object key with different values, **first-writer-wins per key** — the value from the write with the lower `version_id` (i.e., the write that read an earlier version of the SEC entry) is retained. The later writer's value for that key is discarded and logged in `SECConflict` as `key_conflict_discarded: true`. Keys present in only one write are always included in the merge result.
- **Array-typed values:** Arrays are appended. Append order is determined lexicographically by the `written_by` agent ID. This produces a deterministic result across replays regardless of wall-clock write order.
- **Top-level type mismatch:** If the two writes have different top-level value types (e.g., one is `object`, the other is `string`), the merge falls back to `reject`.
- **First-writer semantics are consistent with OCC intent:** OCC exists to preserve the earliest validated write. The `merge` policy extends this to the per-key level inside object values rather than rejecting the entire write.

```typescript
interface SharedExecutionContext {
  run_id:                     string
  conflict_resolution_policy: "reject" | "merge" | "priority" | "escalate"  // copied from RunConfig at Run init
  entries:                    SECEntry[]
  sec_conflicts:              SECConflict[]
}

interface SECEntry {
  key:         string
  value:       string | number | boolean | object
  value_type:  "string" | "number" | "boolean" | "object"
  version_id:  string
  written_by:  string
  written_at:  string
  readable_by: "all" | string[]
}

interface SECConflict {
  key:                   string
  attempted_by:          string
  version_read:          string
  version_current:       string
  resolved_by:           "reject" | "merge" | "priority" | "escalate"
  key_conflict_discarded: boolean   // true when merge policy discarded a per-key value (first-writer-wins)
  timestamp:             string
}

interface SECSnapshot {
  entries:        SECEntry[]               // all entries at the moment of the snapshot
  version_vector: Record<string, string>   // key → version_id at snapshot time
  snapshot_at:    string                   // ISO 8601 timestamp of the snapshot
}
```

**Executor read access:** Executors may read SEC entries with `readable_by: "all"` before generating. Executors may not write to the SEC.

---

### Primitive 13: DEPENDENCY GRAPH (v4, upgraded in v5)

**An explicit directed acyclic graph of agent execution order, with TTL and typed data contracts per edge.**

v5 adds two fields to `DependencyEdge`: `timeout_ms` / `on_timeout` (closes the indefinite-wait deadlock) and `output_contract` (closes the untyped-dependency gap).

**Edge-level TTL:** If the prerequisite does not reach `COMPLETE` or `ESCALATED` within `timeout_ms`, the dependent agent proceeds per `on_timeout`. This ensures dependent agents are never permanently blocked by a stalled sibling.

**Typed output contracts:** `output` edges declare the schema and required fields the prerequisite must produce. The PLAN VALIDATOR validates contract satisfiability before spawn. If a prerequisite's declared output schema cannot satisfy the downstream contract, the plan fails pre-validation — not mid-execution after inference cost has been incurred.

```typescript
interface DependencyEdge {
  from:            string
  to:              string
  type:            "output" | "context" | "constraint"
  timeout_ms:      number | null     // null = inherit run-level latency SLA
  on_timeout:      "escalate" | "proceed_degraded"
  output_contract: OutputContract | null   // required for type: "output" edges
}

interface OutputContract {
  output_schema:    string       // JSON Schema identifier or inline schema
  required_fields:  string[]
  validated_by:     "harness" | "plan_validator"
  fallback_payload: unknown | null
  // Injected into the dependent agent's context when on_timeout: "proceed_degraded" fires.
  // Must conform to output_schema. If null, harness injects a schema-compliant null object.
}
```

**`fallback_payload` injection behavior:** When `on_timeout: "proceed_degraded"` fires on a `DependencyEdge`, the harness injects `fallback_payload` (or a schema-compliant null object if `fallback_payload` is null) into the dependent agent's context with the labeled prefix: `"[DEPENDENCY TIMEOUT — data unavailable from {agent_id}]: {fallback_payload}"`. The dependent agent's generation prompt includes this label so it can adapt its strategy rather than attempting to operate on missing data.

```typescript
// (OutputContract interface continued above)
```

---

### Primitive 14: HITL CHECKPOINT (Unchanged from v4)

No changes in v5. All v4 behavior carries forward. For reference, the complete v4 HITL specification covers: the `HITLCheckpoint` and `HITLOption` schemas, the four standard options (Approve and continue / Edit brief / Edit output / Reject and escalate), checkpoint declaration in `RunConfig` and via Planner dynamic emission, and the `AWAITING_HITL` state. The Ticket table in Section 10 covers the two HITL ticket types (triggered, timed out). HC-01 through HC-11 in Section 11 carry the formal requirements.

---

### Primitive 15: CONTEXT COMPRESSOR (v4, upgraded in v5)

**Hierarchical summarization with a blob store bypass for structured data.**

v4's text summarization is appropriate for qualitative outputs. It destroys fidelity for structured outputs: arrays, JSON payloads, time-series, pricing data. An Executor that produces `[{price: 42.1, ts: "..."}, ...]` summarized as "prices trended upward" is useless to a dependent agent that needs the array.

**Blob store pattern:** Executors that produce structured payloads write them to a run-scoped blob store and include the pointer in `data_refs`. The ContextCompressor does not summarize content with `data_refs` entries — it includes the pointer in the `ChunkSummary`. Downstream consumers dereference the pointer to access the full payload. Blob store contents are never compressed. They are retained for the duration of the Run.

```typescript
interface BlobStoreBackend {
  write(run_id: string, payload: unknown, schema: string): DataRef
  read(ref_id: string): unknown     // throws BlobNotFoundError if evicted
  delete(ref_id: string): void
  list(run_id: string): DataRef[]
}
```

If `read(ref_id)` fails (blob evicted or backend unavailable), the failure is classified as `tool_failure`, the consuming agent is escalated, and `blob_store_dereference_failure` is logged on the Run.

```typescript
interface ChunkSummary {
  agent_id:             string
  depth:                number
  summary:              string
  requirements_covered: string[]
  escalated_nodes:      string[]
  key_outputs:          string[]
  token_count:          number
  is_escalated:         boolean
  is_contested:         boolean
  data_refs:            DataRef[]    // v5: pointers to blob store entries
}

interface DataRef {
  ref_id:     string
  label:      string
  schema:     string
  size_bytes: number
}
```

---

### Primitive 16: EXECUTION MEMORY

**A per-node, per-run short-term cache of retrieval results, failed strategies, and successful patterns.**

ExecutionMemory is initialized on every AgentNode at instantiation. It accumulates state across retries within the same run. The harness reads it before ContextAssembly (to avoid redundant retrieval calls) and before retry prompt composition (to include what has already been tried and failed).

ExecutionMemory is not a persistent store. It lives only for the duration of a Run. Cross-run learning is the Meta Loop's job.

```typescript
interface ExecutionMemory {
  agent_id:              string
  run_id:                string
  retrieved_chunks:      string[]          // chunk IDs from all prior retrieval calls for this node
  failed_strategies:     FailedStrategy[]
  successful_patterns:   string[]          // pattern IDs from prior successful runs (Meta Loop)
  max_retrieved_chunks:  number            // default 500; LRU eviction when exceeded
  max_failed_strategies: number            // default: max_retries; one entry per attempt
}

interface FailedStrategy {
  attempt:      number
  failure_type: FailureType
  gate:         "precheck" | "gate1" | "gate2"
  gap:          string
  tool_used:    string | null
}
```

```typescript
interface SuccessfulPattern {
  pattern_id:          string
  type:                "plan_decomposition" | "sec_write_sequence"
  objective_cluster:   string        // cluster label from Meta Loop
  domain:              string | null
  strategy:            string | null
  embedding:           number[]      // vector for similarity lookup
  embedding_model_id:  string        // ModelPolicy.embedder at time of write; validated on load
  embedding_dimension: number        // vector dimension; validated on load
  artifact:            string        // serialized decomposition or SEC write log (truncated to 512 tokens at write time)
  created_at:          string
  run_id:              string
}
```

**Embedding model compatibility validation:** On load (at node instantiation), the harness SHALL compare `embedding_model_id` on each `SuccessfulPattern` against the current `ModelPolicy.embedder`. A mismatch is treated as a cache miss — the pattern is not used and does not error. Mismatches are logged as `embedding_model_mismatch` events on the Run. If `ModelPolicy.embedder` is null, no validation is performed (single-model deployments where the embedder is implicit). The same validation applies to `PlanCacheEntry.embedding_model_id` at PlanCache lookup time.

**Pattern selection algorithm:** At node instantiation, the harness computes cosine similarity between the current node's scope embedding and all stored `SuccessfulPattern.embedding` vectors. The top-1 pattern above `similarity_threshold` (default 0.75, configurable in `RunConfig`) is selected and injected as a labeled scaffold block: `"[Prior successful approach for similar scope]: {artifact}"`, truncated to `min(artifact_length, 256 tokens)`. If no pattern exceeds the threshold, or if the Meta Loop store is empty, scaffold injection is a no-op.

**Retry behavior with ExecutionMemory:**
1. Before re-running ContextAssembly on retry, harness checks `retrieved_chunks`. Already-retrieved chunk IDs are re-injected without a new retrieval call.
2. Before composing the retry prompt, harness prepends a `failed_strategies` summary: "On attempt N, [failure_type] failure at [gate]: [gap]. Do not repeat this approach."
3. If `successful_patterns` exist from prior runs (loaded by Meta Loop at node instantiation), harness injects the most semantically relevant pattern above `similarity_threshold` as a positive example scaffold. If no pattern exceeds the threshold or the store is empty, scaffold injection is a no-op.

---

### Primitive 17: PLAN VALIDATOR

**A pre-spawn validation gate between Router output and first agent spawn.**

In v4, the only pre-spawn check is DependencyGraph cycle detection. v5 adds a full validation phase that catches structural, coverage, and cost problems before any inference cost is incurred.

**Validation pipeline:**

```
Router output accepted
        │
PLAN VALIDATOR runs (zero inference cost)
        │
  ┌─────┴──────────────────────────────────────────────┐
  │                                                    │
All checks pass                              Any check fails
  │                                                    │
Agents spawn                         Fail reason classified
                                             │
                             fixable?  yes → retry Router (max 1 attempt)
                                        no → fatal pre-run error; run does not start
```

**Validation checks:**

| Check | Description | Fatal? |
|---|---|---|
| Acyclicity | DependencyGraph contains no cycles | Yes |
| Output contract satisfiability | Every `output` edge contract can be satisfied by the prerequisite's declared output schema | Yes |
| Coverage completeness | Every `requirement.id` in the RequirementMap MUST appear in at least one child node's declared `covers_requirements` field. The union of all `covers_requirements` across leaf nodes must be a superset of all Requirement IDs. This is a referential structural check — zero inference cost. | Yes |
| Cost bound | `plan_cost_estimate` does not exceed BudgetPolicy hard limit | Yes if exceeded |
| Depth cap | Declared depth hint does not exceed `max_depth` | Yes |
| Orphan detection | Every node has a path to the root | Yes |

```typescript
interface PlanValidationResult {
  passed:     boolean
  checks:     PlanValidationCheck[]
  fatal:      boolean
  retry_hint: string | null
}

interface PlanValidationCheck {
  check_id: string
  passed:   boolean
  message:  string
  fatal:    boolean
}
```

PLAN VALIDATOR results are logged on the Run and visible in the inspector. Failed plans produce a structured artifact. No agents are spawned on validation failure.

---

### Primitive 18: FAILURE CLASSIFIER

**A harness component that classifies every evaluation failure into a typed taxonomy before retry prompt composition.**

v4 treats all failures identically in retry prompt construction. A retrieval failure and a reasoning failure get the same generic "here is your gap, retry" template. v5 classifies failures first, enabling targeted recovery that matches the actual failure mode.

**Failure taxonomy:**

```typescript
type FailureType =
  | "retrieval_failure"      // ContextAssembly returned insufficient or irrelevant context
  | "reasoning_failure"      // output is factually wrong or logically inconsistent
  | "planning_failure"       // decomposition is incorrect, overlapping, or incomplete
  | "tool_failure"           // tool execution returned error or unexpected output
  | "timeout_failure"        // agent exceeded latency_sla before completing
  | "novelty_failure"        // output is semantically duplicative of a prior attempt
  | "schema_failure"         // output failed OutputNormalizer schema validation
  | "infrastructure_failure" // model call returned HTTP 5xx, timeout, or malformed non-verdict response
  | "blob_write_failure"     // blob store write rejected, timed out, or backend unavailable
```

**Classification logic (deterministic, zero inference cost):**

| Failure condition | Classified as |
|---|---|
| Gate 1: `accuracy` FAIL, evidence missing | `retrieval_failure` |
| Gate 1: `accuracy` FAIL, evidence present but contradicted | `reasoning_failure` |
| Gate 2: `decomposition_quality` FAIL | `planning_failure` |
| Gate 1: `tool_verification` FAIL | `tool_failure` |
| Pre-check: schema mismatch | `schema_failure` |
| Gate 2: `novelty` FAIL | `novelty_failure` |
| State: latency_sla exceeded | `timeout_failure` |
| Judge call returns HTTP 5xx, timeout, or malformed non-verdict response | `infrastructure_failure` |
| Blob store write rejected, timed out, or backend unavailable | `blob_write_failure` |

An `infrastructure_failure` does NOT trigger the Inner Loop — it triggers a judge-call retry (per `model_infra_retry_max` from `RunConfig`). Only if judge retries are exhausted does the agent enter the Inner Loop.

**Per-type retry behavior:**

| failure_type | Retry template addition |
|---|---|
| `retrieval_failure` | Re-run ContextAssembly with relaxed `relevance_threshold`; expand `retrieval_sources` if available |
| `reasoning_failure` | Inject chain-of-thought scaffold; include gap from failing Judge; require explicit claim-to-evidence mapping in output |
| `planning_failure` | Inject MECE checklist; include overlap/gap description from Judge; request scope re-partition |
| `tool_failure` | Include tool error message verbatim; suggest fallback tool if registry has alternative; request manual fallback if none |
| `novelty_failure` | Inject prior attempt summary from ExecutionMemory; require substantively different approach |
| `schema_failure` | Inject expected schema; highlight mismatched or missing fields |
| `timeout_failure` | Reduce scope; request abbreviated output; escalate if on critical path |
| `blob_write_failure` | Re-attempt blob write with exponential backoff; does NOT consume Inner Loop retry budget (mirrors `infrastructure_failure`); if `blob_write_retry_max` exhausted, reclassify as `infrastructure_failure` and escalate |

---

### Primitive 19: OUTPUT NORMALIZER

**A harness-managed normalization step that converts Executor output to a declared schema before pre-checks and eval.**

Executor outputs are heterogeneous: prose, JSON, code, structured arrays, tool results. Deterministic pre-checks and binary eval dimensions cannot reliably operate on untyped text. The OUTPUT NORMALIZER converts output to a normalized form before the eval pipeline begins.

When a Planner declares a child Executor, it optionally includes `output_spec` in the child's brief. After Executor generation, before pre-checks, the harness normalizes the raw output to the declared schema. If normalization fails, the failure is classified as `schema_failure` and the Inner Loop retries with the schema injected into the retry prompt.

Normalized output is stored as `normalized_output` on AgentNode. Eval runs against `normalized_output`. Raw output is retained for audit.

If no `output_spec` is declared, the OUTPUT NORMALIZER is a no-op.

```typescript
interface OutputSpec {
  type:                    "text" | "json" | "code" | "artifact" | "tool_result"
  schema:                  string | null
  required_fields:         string[]
  max_tokens:              number | null
  max_normalization_bytes: number    // default 10MB; payload size limit before normalization attempt
  normalization_mode:      "strict" | "structural_only" | "passthrough"
  // strict:          full schema validation + required_fields check; schema_failure on mismatch
  // structural_only: validates max_tokens compliance only; no schema_failure possible
  // passthrough:     normalizer is a no-op; output passes through unchanged
}
```

**Per-type normalization defaults:**

| `type` | Default `normalization_mode` | What is checked |
|---|---|---|
| `json` | `strict` | Schema validation + required fields |
| `text` | `structural_only` | `max_tokens` compliance only; token count injected into any `schema_failure` message |
| `code` | `structural_only` | `max_tokens` compliance + language declaration present |
| `artifact` | `strict` | Schema validation + required fields |
| `tool_result` | `strict` | Schema validation + required fields |

**No-op rule:** If `schema` is null AND `required_fields` is empty AND `normalization_mode` is `passthrough`, the normalizer is a structural no-op. No `schema_failure` is possible for that node. The `validate` strategy overrides this — it enforces `output_spec` declaration and treats normalization failure as immediate escalation (no retry), regardless of `normalization_mode`.

---

### Primitive 20: EXECUTION SANDBOX

**A scoped isolation layer around every tool execution.**

v4 specifies that Executors cannot access tools outside their injected subset by policy declaration. v5 enforces this at runtime.

**Sandbox guarantees:**
- Tool execution for each Executor runs in an isolated context. Filesystem, environment, and network access are scoped to the tools declared in the Executor's brief.
- Retrieval access in ContextAssembly is read-only and scoped to the policy's declared `retrieval_sources`.
- An Executor cannot access another Executor's tool outputs directly. All cross-agent data flows through the SEC, blob store, or DependencyGraph output contracts.
- Sandbox violations are fatal tool errors, classified as `tool_failure`, and escalated.

```typescript
interface SandboxConfig {
  enabled:        boolean
  tool_execution: "isolated" | "shared"
  data_access:    "scoped" | "run_wide"
  network_policy: "tool_declared" | "none"
  on_violation:   "escalate" | "error"
}
```

Recommended default: `isolated` + `scoped` + `tool_declared` + `escalate`.

**ToolResultCache:** A separate in-memory per-run cache keyed on `run_id + tool_id + tool_input_hash`. Distinct from `idempotency_key` (which prevents duplicate node instantiation). The ToolResultCache prevents re-execution of a successful tool call when eval — not the tool — failed.

---

## 6. Architecture

### 6.1 Execution Tree

```
                    ┌──────────────────────────────────┐
      objective ──▶ │             ROUTER               │
                    │  classify complexity              │
                    │  extract RequirementMap           │
                    │  check PlanCache                  │
                    │  build DependencyGraph            │
                    │  emit plan_cost_estimate          │
                    │  route: direct | plan             │
                    └──────────────┬───────────────────┘
                                   │
                          PLAN VALIDATOR
                    (acyclicity, coverage, cost bounds,
                     output contract satisfiability)
                                   │
           ┌───────────────────────┼──────────────────────────┐
           │ simple / atomic       │                           │ complex
           ▼                       │                           ▼
  ┌─────────────────┐              │          ┌──────────────────────────────┐
  │ HITL CHECKPOINT │              │          │       HITL CHECKPOINT        │
  │ (if declared)   │              │          │       (if declared)          │
  └────────┬────────┘              │          └──────────────┬───────────────┘
           │                       │                         │
  ┌────────▼────────┐              │          ┌──────────────▼───────────────┐
  │ CONTEXT ASSEMBLY│              │          │           PLANNER            │
  │  (pre-retrieval)│              │          │  reads SEC (with version_id) │
  │  EXEC MEMORY    │              │          │  decomposes scope            │
  │  cache check    │              │          │  declares strategy + cost    │
  └────────┬────────┘              │          │  writes SEC (OCC)            │
           │                       │          │  declares dependencies       │
  ┌────────▼────────┐              │          └──────────────┬───────────────┘
  │    EXECUTOR     │              │                         │
  │  OUTPUT         │              │          ┌──────────────▼───────────────┐
  │  NORMALIZER     │              │          │  PRE-CHECK → SPAN EVAL       │
  │  PRE-CHECK      │              │          └──────────────┬───────────────┘
  │  SPAN EVAL      │              │                         │
  └────────┬────────┘              │          children start per DependencyGraph
           │                       │          (independent → immediate;
  FAILURE CLASSIFIER               │           dependent → wait or TTL)
  CONTEXT COMPRESSOR               │                         │
  (blob store for structured)      │                         ▼
                                   │          all executors complete
                                   │                         │
                                   │          CONTEXT COMPRESSOR
                                   │          (bottom-up; blob store bypass)
                                   └──────────┬──────────────┘
                                              │
                                    ┌─────────▼──────────┐
                                    │  REQUIREMENT MAP   │
                                    │  coverage check    │
                                    │  early termination │
                                    │  check (if enabled)│
                                    └─────────┬──────────┘
                                              │
                                    ┌─────────▼──────────┐
                                    │    TRACE EVAL      │
                                    │  (structured digest│
                                    │   + blob pointers) │
                                    └─────────┬──────────┘
                                              │
                          pass ───────────────┴──────────── fail
                            │                                  │
                       COMPLETE                           OUTER LOOP
```

### 6.2 Depth Classification (Unchanged from v4)

| Classification | Depth | Structure |
|---|---|---|
| **Atomic** | 0 | Router → Executor |
| **Simple** | 1 | Router → Planner → Executors |
| **Moderate** | 2 | Router → Planner → Planners → Executors |
| **Complex** | 3+ | Router → Planner → Planner(s) → Planner(s) → Executors |

### 6.3 Spawn and Scheduling Rules

**v3/v4 spawn rule (unchanged):** Children start when their brief is determined, subject to declared dependencies.

**v4 DependencyGraph scheduling (unchanged):** Children with declared dependencies wait for prerequisites to reach `COMPLETE` or `ESCALATED` — or for the DependencyEdge TTL to expire.

**v5 RecursionGuard (upgraded):** Before accepting a `"recurse"` decision, the harness runs two checks in priority order:
1. **Complexity check (primary):** If Router's `complexity_classification` is `atomic` or `simple`, the harness overrides `"recurse"` to `"execute"` regardless of token count.
2. **Token count check (tiebreaker):** If complexity classification is ambiguous (`moderate`), the harness applies the `min_scope_tokens` threshold. Below threshold → override to `"execute"`.

A brief classified `complex` by the Router is never forced to a single Executor by the token count heuristic.

**v5 Backpressure (new):** `parallelism_policy.max_queued_agents` (default: 2× `max_concurrent_agents`) caps the total number of agents in `QUEUED` state across the run. When this limit is reached, new Planner decompositions are paused (Planners held in `PRECHECKING`) until the QUEUED count drops below the threshold. Current `queue_depth` is reported in real-time on the message bus.

### 6.4 Adaptive Depth Policy (v5 addition)

`depth_policy` in `RunConfig` enables dynamic depth adjustment during a run. `DepthPolicy.max_depth` is the same field as `RunConfig.max_depth` — `DepthPolicy` references it rather than duplicating it. The hard cap always applies regardless of adaptive expand/shrink signals.

```typescript
interface DepthPolicy {
  adaptive:               boolean
  expand_if:              "coverage_gap" | "complexity_signal" | null
  shrink_if:              "low_entropy" | "cost_overrun" | null
  expansion_cost_reserve: number   // fraction 0–1 of BudgetPolicy hard limit; default 0.2
  // max_depth is governed by RunConfig.max_depth — not duplicated here
}
```

Before signaling a Planner to expand (via `expand_if`), the harness SHALL check current `budget_consumed` against `BudgetPolicy.hard_limit`. If remaining budget < `expansion_cost_reserve` fraction of hard limit, expansion is suppressed.

**`expand_if: "coverage_gap"`:** If the RequirementMap has uncovered Requirements after an Executor completes, the harness signals the parent Planner to spawn additional children before reaching `PARTIALLY_COMPLETE`. Bounded by `max_depth`.

**`shrink_if: "low_entropy"`:** If a Planner's proposed children are semantically near-identical (detected via embedding similarity at decomposition time), the harness overrides the recursion to a single Executor. Prevents decomposition that produces no real parallelism.

### 6.5 Early Termination

When `early_termination_policy.enabled` is true, the harness checks RequirementMap coverage status after every Executor reaches `COMPLETE`. If all Requirements are covered and the coverage confidence exceeds `confidence_threshold`, the harness can terminate the run before remaining queued agents fire.

```typescript
interface EarlyTerminationPolicy {
  enabled:              boolean
  confidence_threshold: number    // 0–1, default 0.9
  require_all_covered:  boolean   // default true; when true, all RequirementRecords must have coverage_status: "covered"
  // coverage_confidence computed as:
  // (covered_requirements / total_requirements) × mean(requirement_coverage_scores)
  // where requirement_coverage_scores: 1.0 = COMPLETE + Gate2 pass, 0.5 = COMPLETE + Gate1 only, 0.0 = ESCALATED
}
```

**High-priority requirement guard:** Early termination is blocked if any `RequirementRecord` with `priority: "high"` has `coverage_status != "covered"`, regardless of `coverage_confidence` and `require_all_covered` setting. This guard runs first — before the `coverage_confidence` check. It cannot be disabled.

**Cancellation ordering:** QUEUED agents are cancelled in **reverse dependency order** (leaves first, closest to root last). The harness SHALL compute a topological sort of all QUEUED agents at early termination time and cancel from the leaf end. This ensures agents with no downstream dependents are cancelled before agents that other QUEUED agents depend on, preventing downstream agents from attempting to start with no upstream to wait on.

**Dependency resolution on cancellation:** Before cancelling a `QUEUED` agent, the harness SHALL check whether any in-flight agent has a `depends_on` edge to it. If a dependency exists, the cancelled agent's DependencyEdge SHALL be treated as an immediate TTL expiry — `on_timeout` behavior fires immediately (either `proceed_degraded` or `escalate`). This is logged as `early_termination_dependency_resolution` on the Run.

**In-flight state behavior at early termination:**

| State at early termination | Behavior |
|---|---|
| `QUEUED` | Cancelled immediately |
| `RETRYING` | Cancelled immediately |
| `AWAITING_HITL` | Cancelled immediately; logged |
| `GENERATING` (no tool side effects yet) | Cancellation signal sent |
| `GENERATING` (tool_output populated) | Allowed to complete; output discarded from RequirementMap scoring |
| `GATE1_EVALUATING` | Allowed to complete |
| `GATE2_EVALUATING` | Allowed to complete |

Early termination is logged on the Run as `early_termination: true` with the triggering Requirement coverage state. All pending agents are cancelled, not escalated.

### 6.6 Kill Switch

A hard stop that overrides all other policies.

```typescript
interface KillSwitch {
  enabled:  boolean
  triggers: KillSwitchTrigger[]
}

interface KillSwitchTrigger {
  condition: "cost_exceeded" | "time_exceeded" | "loop_detected"
  threshold: number
  action:    "abort_run" | "escalate_run" | "finalize_partial"
}
```

`loop_detected` fires when the same agent (by scope hash) has been retried more than `threshold` times across the run. `abort_run` halts all agents immediately and marks the Run `ERROR`. `escalate_run` halts new spawns, marks all in-flight agents `ESCALATED`, and surfaces the Run to the operator. `finalize_partial` initiates a graceful partial-output path: (1) all `QUEUED` and `RETRYING` agents are cancelled; (2) all `GENERATING` agents receive a cancellation signal and have `RunConfig.partial_output_timeout_ms` (default 5,000ms) to produce output before forced cancellation; (3) the harness runs CONTEXT COMPRESSOR and TRACE EVAL on all `COMPLETE` nodes; (4) the Run reaches `PARTIAL_COMPLETE` state; (5) RequirementMap coverage at termination is logged. `finalize_partial` is the appropriate action when partial work has value and should be preserved rather than discarded.

### 6.7 Plan Cache (v5 enhanced)

Before the Router generates a routing decision, the harness checks the PlanCache for a matching objective.

**Cache matching:** A cache hit requires (a) cosine similarity of objective embeddings above `plan_cache_similarity_threshold` (default 0.90, configurable in `RunConfig`) AND (b) `run_config_hash` matches the current RunConfig hash. A hash mismatch (Contract updated, tools changed, domain registry changed) is an automatic cache miss — the cached plan may reference contracts or tools that no longer exist.

A cache hit is surfaced to the operator with: the cached objective, similarity score, the originating `run_id`, and the delta between cached and current `run_config_hash`. Cache writes occur only after `COMPLETE` trace verdict. The stored entry includes the full Router output, DependencyGraph, and RequirementMap.

---

## 7. The Three Agent Types

### 7.1 Router

**One instance. Entry point. Never skipped.**

v5 changes: `complexity_classification` now has a defined vocabulary that the RecursionGuard consults directly. `plan_cost_estimate` is a new output field. Router output feeds the PLAN VALIDATOR before any children spawn.

**Output:**

```json
{
  "routing":                   "direct" | "plan",
  "depth_hint":                0 | 1 | 2 | 3,   // 3 = "3 or more"; Router does not predict exact depth for complex trees
  "complexity_classification": "atomic" | "simple" | "moderate" | "complex",
  "rationale":                 "One sentence: why this routing decision",
  "objective_refined":         "Cleaned, specific restatement of the objective",
  "constraints":               ["Any explicit constraints to carry through execution"],
  "requirements": [
    { "id": "REQ-001", "text": "Discrete, verifiable success criterion" }
  ],
  "dependencies": [
    {
      "from":            "child_id_A",
      "to":              "child_id_B",
      "type":            "output",
      "timeout_ms":      30000,
      "on_timeout":      "proceed_degraded",
      "output_contract": {
        "output_schema":   "schema_id",
        "required_fields": ["field_a", "field_b"],
        "validated_by":    "plan_validator"
      }
    }
  ],
  "plan_cost_estimate": {
    "tokens":     5000,
    "agents":     8,
    "tool_calls": 4
  }
}
```

**Router Contract Dimensions (unchanged from v4):**

| Dimension | Weight | Binary | Description |
|---|---|---|---|
| `complexity_classification` | 0.45 | No | Did the Router correctly assess complexity? |
| `scope_coverage` | 0.35 | **Yes** | Does the routing ensure full objective coverage? Does the RequirementMap capture all discrete success criteria? |
| `dependency_correctness` | 0.20 | No | Are declared dependencies logically correct and acyclic? (Omitted for direct routing) |

---

### 7.2 Planner

**N instances. Self-similar. Recurses or terminates. Shares state via OCC SEC.**

v5 adds: per-child `strategy`, `plan_cost_estimate`, typed SEC writes with `version_id`, and `cost_compliance` dimension. Strategy is declared per child so that different children of the same Planner can use different approaches (one child searches, another transforms).

**Output:**

```json
{
  "decision":  "recurse" | "execute",
  "rationale": "One sentence: why this termination decision",
  "plan":      "One sentence: execution approach for this scope",
  "plan_cost_estimate": {
    "tokens":     2000,
    "agents":     4,
    "tool_calls": 2
  },
  "sec_writes": [
    {
      "key":        "auth_strategy",
      "value":      "oauth2",
      "value_type": "string",
      "version_id": "v_read_id"
    }
  ],
  "children": [
    {
      "id":                 "exec-1",
      "title":              "Fetch pricing data",
      "scope":              "Retrieve current pricing from API and normalize to standard schema.",
      "deliverables":       ["Normalized pricing array"],
      "covers_requirements": ["REQ-001"],
      "type":               "executor",
      "strategy":           "transform",
      "domain":             "data",
      "tools":              ["pricing_api"],
      "depends_on":         [],
      "output_spec": {
        "type":            "json",
        "schema":          "pricing_array_schema",
        "required_fields": ["price", "ts", "sku"],
        "max_tokens":      null
      },
      "hitl": null
    }
  ]
}
```

**Strategy behavioral contracts:**

**Strategy precedence rule:** Where a strategy declares behavior that differs from the general harness default, the strategy-specific rule governs.

Each strategy maps to concrete harness-controlled behaviors. These are not advisory — the harness enforces them.

| Strategy | ContextAssembly behavior | Eval dimension `weight_override` | Other |
|---|---|---|---|
| `search` | `relevance_threshold` reduced by 0.15 from policy default (broader net); `max_context_tokens` increased by 25%; `diversity_penalty` increased by 0.1 (more source variety) | `specificity`: 0.20; `substantiveness`: 0.10 | None |
| `synthesize` | `retrieval_sources` expanded to all available sources in policy (not just declared subset); `diversity_penalty` increased by 0.2; `max_context_tokens` at policy max | `coherence` added as Gate 2 dimension with `weight_override`: 0.10; `specificity`: 0.10 | None |
| `transform` | ContextAssembly disabled if `output_spec.type` is `json` or `artifact`; `retrieval_sources` filtered to sources with `source_type: 'schema_reference'` only. If no `schema_reference` sources exist, ContextAssembly is fully disabled. | `tool_verification`: 0.25; `substantiveness`: 0.05 | Blob store routing enforced (harness auto-routes per EX-15) |
| `analyze` | Standard ContextAssembly; CoT scaffold injected as first line of generation prompt: "Reason step by step before stating conclusions." | `substantiveness`: 0.20 | `accuracy` threshold enforced strictly (no PARTIAL allowed at Gate 1) |
| `validate` | ContextAssembly restricted to schema and reference sources only; `max_context_tokens` at policy minimum | No weight overrides | OUTPUT NORMALIZER required (harness enforces `output_spec` declaration); `accuracy` is Gate 1 binary; `task_completion` threshold raised to 90. Normalization failure triggers immediate escalation (no retry). This overrides ON-02's general retry rule for Executors with `strategy: 'validate'`. |

**Strategy weight override semantics:** `weight_override` values in the table above are **absolute targets**, not deltas. The harness applies each override as an exact assignment — it does not add or subtract from the base weight. After applying all overrides for the active strategy, the harness re-normalizes all dimension weights to sum to 1.0 before Gate 2 scoring. Operators who customize base Executor Contract weights via `RunConfig.contracts` should compute their desired absolute target values directly — delta semantics are not supported. Dimensions not listed in a strategy's `weight_override` table retain their base `RunConfig.contracts` weights before normalization.

**Planner Contract Dimensions (v5 adds `cost_compliance`):**

| Dimension | Weight | Binary | Description |
|---|---|---|---|
| `decomposition_quality` | 0.25 | No | Are children independently executable with no overlap? |
| `scope_fidelity` | 0.25 | No | Does the decomposition cover the full input scope? |
| `termination_correctness` | 0.25 | **Yes** | Was the recurse/execute decision correct? |
| `deliverable_traceability` | 0.15 | No | Can every deliverable be traced to at least one child? |
| `cost_compliance` | 0.10 | No | Does `plan_cost_estimate` fall within bounds for the declared scope? |

---

### 7.3 Executor

**N instances. Leaf nodes. Produce real output or execute real actions.**

v5 adds: `idempotency_key`, `data_refs` (blob store pointers), `normalized_output`, and `novelty` dimension.

**Pre-generation pipeline:**

```
Brief received
      │
HITL Checkpoint? → AWAITING_HITL if declared
      │ (approved)
EXECUTION MEMORY cache check
      │
ContextAssembly → enrich brief (cache miss) / re-inject cached chunks (cache hit)
      │
Generation call fires (enriched brief, strategy-aware)
      │
Tool execution (if tool_call mode) — EXECUTION SANDBOX enforced
      │
OUTPUT NORMALIZER (schema validation only — against declared output_spec)
      │  normalization operates on the raw in-memory output before blob write
Blob store routing (EX-15: harness writes to blob store if output_spec.type is json/artifact)
      │
FAILURE CLASSIFIER (if pre-check or eval fails)
      │
Pre-checks → Span Eval (Gate 1 → Gate 2)
      │
CONTEXT COMPRESSOR (ChunkSummary or blob store DataRef)
```

**Output schema:**

```json
{
  "status":          "complete",
  "mode":            "llm_output" | "tool_call",
  "summary":         "One sentence: what was produced",
  "output":          "The actual work product (null if tool_call mode)",
  "normalized_output": "Normalized form per output_spec (null if no spec)",
  "data_refs": [
    {
      "ref_id":     "blob_abc123",
      "label":      "Pricing array",
      "schema":     "pricing_array_schema",
      "size_bytes": 4096
    }
  ],
  "idempotency_key": "string",
  "action": {
    "tool_id":          "string | null",
    "tool_input":       "object | null",
    "tool_output_raw":  "string | null",
    "tool_output":      "string | object | null",
    "tool_output_type": "string | json | error | null",
    "verified":         "boolean",
    "error":            "string | null"
  },
  "evidence": ["Citations, retrieved chunk IDs, tool output references"]
}
```

After tool execution, the harness SHALL attempt to parse `tool_output_raw` as JSON. If successful and `output_spec.type` is `json` or `artifact`, the parsed object is stored as `tool_output` and `tool_output_type: "json"`. Otherwise `tool_output_type: "string"`. The `tool_verification` Judge receives `tool_output` (parsed form), not `tool_output_raw`.

**`idempotency_key`:** Set by the harness on node instantiation. If the same `idempotency_key` has produced a `COMPLETE` result in a prior attempt within this run, the harness returns the prior result without re-executing the tool call. Prevents duplicate actions on retry.

**`data_refs`:** For structured payload outputs, the Executor writes the payload to the blob store and includes the pointer here. The ContextCompressor receives the pointer instead of summarizing the payload.

**Executor Contract Dimensions (v5 adds `novelty`):**

| Dimension | Weight | Binary | Applies to |
|---|---|---|---|
| `task_completion` | 0.25 | No | Both modes |
| `specificity` | 0.15 | No | `llm_output` only |
| `substantiveness` | 0.15 | No | `llm_output` only |
| `accuracy` | 0.20 | **Yes** | Both modes — claims must be traceable to evidence |
| `tool_verification` | 0.15 | **Yes** | `tool_call` only |
| `novelty` | 0.10 | No | Both modes (Gate 2) — output must not be semantically duplicative of prior attempts |

**Weight normalization by mode:** Dimensions marked for a specific mode are excluded from scoring when the Executor runs in the other mode. The harness normalizes remaining weights proportionally before computing the Gate 2 weighted average. In `llm_output` mode (`tool_verification` excluded), weights normalize over 0.85 total. In `tool_call` mode (`specificity` and `substantiveness` excluded), weights normalize over 0.70 total. The Gate 2 threshold applies to the normalized score in both cases.

**`novelty` dimension:** The Judge evaluating `novelty` receives the current output and all prior attempt outputs from `ExecutionMemory.failed_strategies`. **On attempt 1 (`ExecutionMemory.failed_strategies` is empty), `novelty` is automatically skipped** — there is nothing to compare against and the dimension has no signal. The harness SHALL set `novelty.skipped: true` and `novelty.verdict: "pass"` for attempt 1 regardless of `JudgingPolicy`. From attempt 2 onward, the Judge evaluates whether the current output is substantively different from all prior attempts. A `FAIL` verdict triggers `novelty_failure` retry template. The `novelty` Judge does NOT compare against `successful_patterns` from prior runs — those are scaffolds, not comparison targets.

---

## 8. The Eval System

### 8.1 Evaluation Pipeline (with eval merging)

```
brief received
      │
HITL Checkpoint (if declared)
      │
EXECUTION MEMORY cache check
      │
ContextAssembly (harness-managed)
      │
generation / tool execution
      │
OUTPUT NORMALIZER (if output_spec declared)
      │
PRE-CHECK (deterministic, zero-token)
  fail → FAILURE CLASSIFIER → Inner Loop (type-specific template)
  pass ↓
GATE 1 (binary dimensions)
  merged_judge_mode?
    yes → single batched judge call → parse per-dimension verdicts
    no  → one judge per dimension, concurrent
  any FAIL → FAILURE CLASSIFIER → Inner Loop (Gate 2 skipped unless early_stop_on_gate1: false)
  all PASS ↓
GATE 2 (non-binary dimensions, concurrent)
  weighted avg < threshold → FAILURE CLASSIFIER → Inner Loop
  weighted avg ≥ threshold ↓
PASS → CONTEXT COMPRESSOR → proceed
```

### 8.2 Eval Merging (`merged_judge_mode`)

In standard mode, Gate 1 fires one judge call per binary dimension. For an Executor with three binary dimensions, that is three inference calls before any production work advances. Under `merged_judge_mode`, all Gate 1 dimensions are evaluated in a single judge call that returns a JSON array of per-dimension verdicts.

```typescript
interface MergedJudgePolicy {
  enabled:          boolean
  gate1_merged:     boolean    // batch all Gate 1 dims into one call
  exceptions:       string[]   // dimension IDs always evaluated in isolation
}

interface MergedJudgeResponse {
  verdicts: Array<{
    dimension_id:  string
    verdict:       "pass" | "partial" | "fail"
    numeric_score: 100 | 50 | 0
    gap:           string | null
    severity:      "critical" | "major" | "minor" | null
    reasoning:     string
  }>
}
```

**Merged judge failure handling:**
- If the merged judge call returns malformed JSON or is missing any expected dimension, the harness SHALL fall back to isolated per-dimension calls for the missing/malformed dimensions only.
- If the merged call times out or errors entirely, the harness SHALL fall back to isolated mode for all Gate 1 dimensions and log `merged_judge_fallback` on the node.
- A merged call failure does NOT fail all Gate 1 dimensions — it triggers fallback, not escalation.
- Hard rule: if the estimated token count of the merged prompt exceeds 80% of the judge model's context window (per `model_policy.judge`), the harness SHALL automatically exclude the `accuracy` dimension from the merged call and evaluate it in isolation, regardless of the `exceptions` list.

**When to use isolated (not merged):**
- Custom dimensions added via `JudgingPolicy.add_dimensions` that require full context
- `accuracy` dimension on high-stakes runs (full evidence list may exceed merged prompt window)
- Any dimension in `JudgingPolicy.skip_dimensions` exceptions list

**Latency reduction:** In a 4-dimension Gate 1 agent, `merged_judge_mode` reduces Gate 1 from 4 parallel inference calls to 1. At depth 3 with 4-wide branching, this is the difference between 64 Gate 1 calls and 16 across the leaf layer.

### 8.3 Two-Gate Verdict System (Unchanged from v4)

Gate 1 hard-block and Gate 2 soft-threshold behavior is unchanged. Thresholds are unchanged (Router: 70, Planner: 75, Executor: 80).

### 8.4 Adaptive Judge Selection (JudgingPolicy) (Unchanged from v4)

`full | adaptive | custom` modes carry forward. Binary dimensions are never skippable. `early_stop_on_gate1` default is `true`.

### 8.5 Grounded Accuracy (Unchanged from v4)

The `accuracy` dimension Judge evaluates traceability of claims to evidence entries, injected context, and tool outputs — not plausibility. The v4 accuracy Judge prompt carries forward unchanged.

### 8.6 Trace-Level Eval (v5 enhancements)

Trace eval now receives:
- ChunkSummaries for all branches (hierarchically compressed)
- Blob store `DataRef` pointers for structured outputs (never compressed)
- Full outputs of `ESCALATED` nodes (never compressed)
- Full outputs of nodes covering contested Requirements
- RequirementMap with coverage status
- SEC final state (to detect strategy inconsistencies)
- DependencyGraph execution trace (to detect sequencing failures)
- `early_termination` flag and triggering state (if applicable)

**Trace Input Budget:** `RunConfig.trace_eval_max_tokens` (default: 80% of `model_policy.judge` context window) limits the trace eval input. When budget is at risk, the harness applies this priority ordering:
- Priority 1 (always included): RequirementMap with coverage status, `early_termination` flag, SEC final state summary (key count + conflict count, not full values)
- Priority 2 (until budget): Full outputs of `ESCALATED` nodes on the critical path, ordered by depth (shallowest first)
- Priority 3 (until budget): Full outputs of nodes covering contested Requirements
- Priority 4 (until budget): Non-critical-path ESCALATED node outputs, truncated to `max_escalated_output_tokens` (default 500 tokens each)
- Priority 5 (always included as pointers only): Blob store `DataRef` pointers for structured outputs
- ChunkSummaries for non-escalated branches fill remaining budget

**Trace eval dimensions (unchanged from v4):**

| Dimension | Weight | Description |
|---|---|---|
| `objective_fulfillment` | 0.40 | Do the collective outputs substantively address the original objective? |
| `coverage_completeness` | 0.35 | Are all Requirements covered? (Informed by Phase 1 deterministic check) |
| `coherence` | 0.15 | Do the outputs form a coherent whole? Are there strategy conflicts in the SEC? |
| `dependency_integrity` | 0.10 | Did dependent agents actually use their prerequisite outputs? |

---

## 9. The Three Loops

### 9.1 Inner Loop (per agent, per run)

v5 changes: FAILURE CLASSIFIER runs before retry prompt composition. Retry templates are type-specific (see Primitive 18). ExecutionMemory is updated after every attempt.

All other Inner Loop behavior (retry count, template structure, re-entry into pre-checks) is unchanged from v4.

### 9.2 Outer Loop (per run, end-to-end)

The four v4 Outer Loop triggers carry forward unchanged: trace eval failure, ESCALATED nodes in the tree, HITL Checkpoint timeout with `on_timeout: "escalate"`, and budget exceeded with `on_budget_exceeded: "escalate"`.

**v5 note — Kill switch is NOT an Outer Loop trigger.** When the kill switch fires, it bypasses the Outer Loop entirely. `abort_run` drives all agents to `ERROR` and marks the Run `ERROR` directly. `escalate_run` drives all in-flight agents to `ESCALATED` and surfaces the Run to the operator directly. No repair attempt is made. No Outer Loop iteration runs. This distinction matters: the Outer Loop exists to attempt recovery. Kill switch exists to stop execution unconditionally.

### 9.3 Meta Loop (across runs, over time)

v5 adds success pattern learning alongside the existing failure-oriented calibration.

**Additional Meta Loop step — Success pattern capture:**

After every `COMPLETE` run, the Meta Loop extracts:
- `successful_plan_embeddings`: vector representations of Planner decompositions that produced `COMPLETE` children. Stored by objective-type cluster.
- `successful_sec_patterns`: SEC write sequences from Planners whose children all reached `COMPLETE`. Stored by domain and strategy type.

These are loaded into `ExecutionMemory.successful_patterns` for new nodes at run instantiation. The harness selects the most semantically relevant pattern (by objective embedding similarity) and includes it as a positive example scaffold in the generation prompt.

**Adaptive dimension calibration (unchanged from v4):** Skip rate tracking, false negative rate computation, and JudgingPolicy update process carry forward.

---

## 10. Ticket System

### 10.1 What Triggers a Ticket (v5 additions in italics)

| Trigger | Ticket type | Severity |
|---|---|---|
| Pre-check fails → retry pending | Pre-check failure — retry | Informational |
| Pre-check fails → ESCALATED | Pre-check failure — escalated | Matches failure type |
| Gate 1 fails → retry pending | Span Gate 1 failure — retry | Matches dimension severity |
| Gate 1 fails → ESCALATED | Span Gate 1 failure — escalated | Critical |
| Gate 2 fails → retry pending | Span Gate 2 failure — retry | Informational |
| Gate 2 fails → ESCALATED | Span Gate 2 failure — escalated | Matches dimension severity |
| Trace eval fails, repair succeeds | Trace repair — resolved | Major |
| Trace eval fails, repair fails | Trace failure — escalated | Critical |
| HITL Checkpoint triggered | HITL review required | Informational |
| HITL Checkpoint timed out → escalated | HITL timeout — escalated | Major |
| Budget warning threshold | Budget warning | Major |
| Budget limit exceeded | Budget exceeded | Critical |
| RecursionGuard override | Recursion guard triggered | Minor |
| SEC write conflict | Shared context conflict | Minor |
| *SEC OCC write rejected* | *Shared context OCC rejection* | *Minor* |
| *SEC OCC re-decompose limit exceeded* | *Shared context OCC escalation* | *Critical* |
| Max depth cap reached | Depth limit warning | Major |
| Tool call error | Tool error | Matches severity |
| Judge call error | Infrastructure warning | Minor |
| *PLAN VALIDATOR failure* | *Plan validation failed* | *Critical* |
| *DependencyEdge TTL expired* | *Dependency timeout* | *Major* |
| *Output normalization failed* | *Schema normalization failure* | *Minor* |
| *Kill switch triggered* | *Kill switch activated* | *Critical* |
| *Sandbox violation* | *Execution sandbox violation* | *Critical* |
| *novelty dimension FAIL* | *Novelty failure — retry* | *Informational* |
| *Blob store write failure* | *Blob write failure — retry* | *Major* |

### 10.2 Schema Consolidation (Unchanged from v4)

Tickets reference Signals by ID. No Signal field duplication.

**Ticket payload:**

```json
{
  "ticket_id":          "string",
  "type":               "string (see trigger table)",
  "severity":           "critical" | "major" | "minor",
  "run_id":             "string",
  "agent_id":           "string",
  "agent_type":         "router" | "planner" | "executor",
  "signal_id":          "string | null",
  "failure_gate":       "precheck" | "gate1" | "gate2" | "trace" | "budget" | "tool" | "hitl" | "plan_validator" | "kill_switch" | null,
  "failure_type":       "retrieval_failure" | "reasoning_failure" | "planning_failure" | "tool_failure" | "timeout_failure" | "novelty_failure" | "schema_failure" | "blob_write_failure" | "infrastructure_failure" | null,
  "context_confidence": "high" | "degraded",
  "on_critical_path":   "boolean",
  "attempt":            "number",
  "retry_prompt":       "string",
  "objective_context":  "string",
  "budget_consumed":    { "inference_calls": "number", "tokens": "number", "wall_time_ms": "number" },
  "created_at":         "ISO 8601",
  "provider":           "string",
  "url":                "string | null"
}
```

### 10.3 Provider Interface (Unchanged from v4)

Built-in providers: In-Memory (default), GitHub Issues, Jira, Linear, Webhook.

---

## 11. Functional Requirements

### Router

| ID | Requirement |
|---|---|
| RT-01 | One Router SHALL be instantiated per execution run. |
| RT-02 | The Router SHALL accept a free-text objective as its sole input. |
| RT-03 | The Router SHALL output a routing decision: `"direct"` or `"plan"`. |
| RT-04 | The Router SHALL extract a RequirementMap of 3–7 discrete success criteria. |
| RT-05 | The Router SHALL declare any known top-level dependencies between planned children, including `timeout_ms`, `on_timeout`, and `output_contract` for `output` edges. |
| RT-06 | On `"direct"` routing, the Router SHALL spawn exactly one Executor. |
| RT-07 | On `"plan"` routing, the Router SHALL spawn exactly one root Planner with a depth hint. |
| RT-08 | The Router SHALL refine and clean the raw objective before passing it to children. |
| RT-09 | Before generating a routing decision, the harness SHALL check the PlanCache and surface any hit to the operator. |
| RT-10 | The Router output SHALL pass Deterministic Pre-Checks before the PLAN VALIDATOR runs. |
| RT-11 | The Router output SHALL feed the PLAN VALIDATOR. If PLAN VALIDATOR fails fatally, the run SHALL NOT start. |
| RT-12 | The Router SHALL emit `complexity_classification` as one of: `atomic | simple | moderate | complex`. |
| RT-13 | The Router SHALL emit `plan_cost_estimate` for `"plan"` routing decisions. |
| RT-14 | The Router output SHALL be evaluated against its Contract (two-gate system) before children are spawned. |
| RT-15 | On DoD failure, the Router SHALL follow Inner Loop retry behavior. Max retries: configurable, default 2. |

### Planner

| ID | Requirement |
|---|---|
| PL-01 | The system SHALL spawn one Planner per scope requiring decomposition. |
| PL-02 | All sibling Planners with no declared dependencies SHALL execute concurrently, subject to `parallelism_policy.max_concurrent_agents`. |
| PL-03 | A Planner with declared dependencies SHALL wait for prerequisites to reach `COMPLETE` or `ESCALATED`, or for the DependencyEdge TTL to expire. |
| PL-04 | Before decomposing, a Planner SHALL read SharedExecutionContext entries relevant to its scope, including their `version_id`. |
| PL-05 | After decomposing, a Planner SHALL write its key decisions to SharedExecutionContext using OCC (with `version_id`). If write is rejected, the Planner SHALL re-read and re-decompose before spawning children. The harness SHALL include the OCC conflict summary (key, rejected value, current value) in the re-decompose prompt so the Planner can make a targeted adjustment rather than a full blind regeneration. This cycle is bounded per SC-09. |
| PL-06 | Each Planner SHALL make exactly one termination decision: `"recurse"` or `"execute"`. |
| PL-07 | On `"recurse"`, the Planner SHALL spawn 2–4 child Planners. |
| PL-08 | On `"execute"`, the Planner SHALL spawn 2–6 child Executors. |
| PL-09 | Child scopes SHALL be mutually exclusive and collectively exhaustive of the parent scope (MECE). |
| PL-10 | A Planner SHALL NOT produce work product or content of any kind. |
| PL-11 | Before accepting a `"recurse"` decision, the harness SHALL run the RecursionGuard check: if `complexity_classification` is `atomic` or `simple`, override to `"execute"`. If `moderate`, apply `min_scope_tokens` tiebreaker. |
| PL-12 | Children SHALL be spawned as soon as their briefs are determined, subject to declared dependencies and OCC write success. |
| PL-13 | A Planner SHALL reach `COMPLETE` or `ESCALATED` only after all its children reach terminal state. |
| PL-14 | Planners MAY declare HITL Checkpoints on child nodes. |
| PL-15 | Planners MAY declare dependencies between child nodes using the `depends_on` field, including `timeout_ms` and `on_timeout`. |
| PL-16 | Planners SHALL declare `output_spec` for child Executors where output schema is known. |
| PL-17 | Planners SHALL emit `strategy` and `plan_cost_estimate` in their decomposition output. |
| PL-18 | The Planner output SHALL pass Deterministic Pre-Checks before judges are spawned. |
| PL-19 | The Planner output SHALL be evaluated against its Contract (two-gate system) before children are spawned. |
| PL-20 | If the depth cap is reached, the Planner SHALL hand to Executors unconditionally and file a warning ticket. |
| PL-21 | On DoD failure, the Planner SHALL follow Inner Loop retry behavior. |

### Executor

| ID | Requirement |
|---|---|
| EX-01 | The system SHALL spawn one Executor per atomic task. |
| EX-02 | All sibling Executors with no declared dependencies SHALL execute concurrently, subject to `parallelism_policy.max_concurrent_agents`. |
| EX-03 | An Executor with declared dependencies SHALL wait for prerequisites before starting, or for the DependencyEdge TTL to expire. |
| EX-04 | If a HITL Checkpoint is declared on the Executor, the harness SHALL pause before generation and await operator action. |
| EX-05 | The harness SHALL check `ExecutionMemory.retrieved_chunks` before running ContextAssembly on retry. Cache hits SHALL be re-injected without a new retrieval call. |
| EX-06 | The harness SHALL run ContextAssembly before the Executor's generation call fires, if ContextAssemblyPolicy is enabled. |
| EX-07 | ContextAssembly results SHALL be injected into the brief and recorded on AgentNode. |
| EX-08 | Each Executor SHALL produce a structured output in either `llm_output` or `tool_call` mode. |
| EX-09 | An Executor SHALL NOT spawn child agents. |
| EX-10 | In `llm_output` mode, output SHALL be concrete, specific, and substantive. |
| EX-11 | Every factual claim in `output` SHALL be traceable to an entry in the `evidence` field. Unsupported claims SHALL fail the `accuracy` dimension at Gate 1. |
| EX-12 | In `tool_call` mode, the Executor SHALL declare the tool call. The harness SHALL execute it within the EXECUTION SANDBOX, populate `tool_output_raw`, and then classify `tool_output_raw` as `json` or `string`, storing the result in `tool_output` and `tool_output_type`. This classification informs blob store routing and Output Normalizer behavior. Pre-checks run before judges are spawned. |
| EX-13 | The harness SHALL assign an `idempotency_key` to every Executor at instantiation. The key SHALL be a deterministic hash of: `run_id` + `parent_agent_id` + `scope_text` + `attempt_number`. Using `attempt_number` in the hash means each retry produces a distinct key, preventing false cache hits across attempts; the purpose is to deduplicate duplicate-spawn events within the same attempt (e.g., harness crashes and re-instantiates the same node). If the same `run_id + parent_id + scope + attempt` combination already has a `COMPLETE` result in this run, the harness SHALL return the prior result without re-executing the tool call. The hash function SHALL be SHA-256 or equivalent collision-resistant. The `idempotency_key` prevents duplicate node instantiation within the same attempt; it does NOT prevent tool re-execution across eval-triggered retries (that is the ToolResultCache's job). |
| EX-13a | If an Executor's tool call produced a non-error result in a prior attempt (regardless of eval outcome), the harness SHALL return the cached tool result on retry rather than re-executing the tool. The retry LLM generation receives the cached tool output as input. This applies only to tools where `idempotent: true` (or unspecified, defaulting to true). Tools with `idempotent: false` bypass this cache. |
| EX-14 | If `output_spec` is declared for the Executor, the harness SHALL run the OUTPUT NORMALIZER before pre-checks. Normalization failure SHALL be classified as `schema_failure`. |
| EX-15 | Blob store routing is determined by the harness, not self-reported by the Executor. If `output_spec.type` is `json` or `artifact`, the harness SHALL automatically route the output to the blob store after generation and include a `DataRef` in `data_refs`. If no `output_spec` is declared, the harness SHALL NOT attempt blob store routing — the ContextCompressor will summarize the output as text. The self-report path ("if the output contains a structured payload") is removed; structuredness is determined by declared `output_spec` only. |
| EX-16 | After generation, the FAILURE CLASSIFIER SHALL classify any pre-check or eval failure before retry prompt composition. |
| EX-17 | After generation, the ContextCompressor SHALL produce a ChunkSummary for the Executor's output. If the Executor has `data_refs`, the ChunkSummary SHALL include those `DataRef` pointers and SHALL NOT summarize the structured payload content. |
| EX-18 | The Executor output SHALL pass Deterministic Pre-Checks before judges are spawned. |
| EX-19 | The Executor output SHALL be evaluated against its Contract (two-gate system). |
| EX-20 | On DoD failure, the Executor SHALL follow Inner Loop retry behavior with type-specific retry prompt. |

### Eval System

| ID | Requirement |
|---|---|
| EV-01 | After every agent generates output, the system SHALL run all Deterministic Pre-Checks before invoking any Judge. |
| EV-02 | Pre-check failures SHALL trigger the FAILURE CLASSIFIER and Inner Loop at zero Judge inference cost. |
| EV-03 | After pre-checks pass, the system SHALL run Gate 1: one Judge per binary dimension. If `merged_judge_mode` is enabled, Gate 1 dimensions SHALL be batched into a single judge call. If the merged call returns malformed JSON or times out, the harness SHALL fall back to isolated per-dimension calls and log `merged_judge_fallback`. A merged call failure does NOT fail Gate 1 — it triggers fallback. A Judge returning a FAIL verdict is an evaluation failure (triggers Inner Loop). A Judge call returning an infrastructure error (HTTP 5xx, timeout, malformed response) is an `infrastructure_failure` and SHALL NOT trigger the Inner Loop — it triggers model-level retry. |
| EV-04 | If any Gate 1 Judge returns FAIL, the agent SHALL fail immediately. Gate 2 SHALL NOT run (unless `early_stop_on_gate1: false`). A Judge returning a FAIL verdict is an evaluation failure (triggers Inner Loop). A Judge call returning an infrastructure error (HTTP 5xx, timeout, malformed response) is an `infrastructure_failure` and SHALL NOT trigger the Inner Loop — it triggers model-level retry. |
| EV-05 | If all Gate 1 Judges pass, the system SHALL run Gate 2: one Judge per non-binary dimension, concurrently. |
| EV-06 | Dimensions listed in `JudgingPolicy.skip_dimensions` SHALL be skipped. Binary dimensions SHALL never be skipped. |
| EV-07 | Each Judge SHALL output free-prose reasoning followed by a fenced JSON block. The harness SHALL parse only the fenced JSON block. |
| EV-08 | The `accuracy` dimension Judge SHALL receive: output, evidence list, ContextAssembly chunks, and tool outputs. It SHALL evaluate traceability of claims, not plausibility. |
| EV-09 | The `novelty` dimension Judge SHALL receive: current output and all prior attempt outputs from `ExecutionMemory.failed_strategies`. |
| EV-10 | The Aggregator SHALL compose type-specific retry prompts using FAILURE CLASSIFIER output. |
| EV-11 | Trace eval Phase 1 SHALL run deterministically against the RequirementMap before LLM judges run. |
| EV-12 | Trace eval Phase 2 Judges SHALL receive the ContextCompressor digest within `trace_eval_max_tokens` budget. When budget is exceeded, the harness SHALL apply the priority ordering defined in Section 8.6. |
| EV-13 | Full ESCALATED outputs are included subject to the trace budget and priority ordering — not unconditionally. |
| EV-14 | Trace eval Phase 2 SHALL receive the SEC final state and the DependencyGraph execution trace. |
| EV-15 | A trace eval failure SHALL trigger the Outer Loop. |
| EV-16 | All eval results, including ContextAssembly metadata, JudgingPolicy applied, failure_type, and merging mode, SHALL be stored on AgentNode and visible in inspector. |

### HITL Checkpoints (Unchanged from v4)

HC-01 through HC-11 carry forward unchanged.

### Context Assembly

CA-01 through CA-08 carry forward from v4 with one addition:

| ID | Requirement |
|---|---|
| CA-09 | If `feedback_loop` is enabled, the harness SHALL record which retrieved chunk IDs appeared in passing Executor `evidence` fields and update chunk relevance weights in the retrieval source index. The feedback_loop store SHALL expose a `CAS`-style atomic weight update, or use an append-only log that is periodically compacted. Last-write-wins semantics are not acceptable for weight updates. |
| CA-11 | After every run with `feedback_loop` enabled, the harness SHALL compute and emit a `FeedbackLoopHealth` record to the run summary and the `feedback_loop` bus event stream. The harness SHALL also emit a `feedback_loop_weight_distribution` bus event at configurable intervals (default: at run completion). |
| CA-12 | If `feedback_loop_snapshot_id` is set in `RunConfig`, the harness SHALL load feedback_loop weights from the named snapshot at run start rather than from the live index. This is the operator rollback mechanism for feedback_loop state. Snapshot IDs are the `snapshot_id` field from `FeedbackLoopHealth` records. |
| CA-10 | For Executors with `strategy: 'transform'`, the harness SHALL filter `retrieval_sources` to those with `source_type: 'schema_reference'` before ContextAssembly runs. If no schema_reference sources exist, ContextAssembly is skipped entirely for that Executor. |

### Context Compression

CC-01 through CC-06 carry forward from v4 with one addition:

| ID | Requirement |
|---|---|
| CC-07 | Executor outputs with `data_refs` SHALL NOT be summarized by the ContextCompressor. The ChunkSummary SHALL include the DataRef pointers. Downstream consumers SHALL dereference pointers directly from the blob store. |

### Blob Store

| ID | Requirement |
|---|---|
| BS-01 | In multi-node deployments, the blob store backend MUST be an external shared store (e.g., S3, GCS, Redis Blob). The default in-memory store is explicitly unsafe for distributed deployments. |
| BS-02 | Blob store writes MUST complete before the producing Executor reaches `COMPLETE`. The harness MUST NOT mark the node `COMPLETE` until the `DataRef` is confirmed written. |
| BS-03 | If `read(ref_id)` fails, classify as `tool_failure`, escalate the consuming agent, and log `blob_store_dereference_failure` on the Run. |
| BS-04 | Blob store contents are retained for the duration of the Run. Post-run retention policy is operator-configured. |
| BS-05 | The blob store backend interface is `BlobStoreBackend`. Implementations must satisfy all four method signatures. |
| BS-06 | If a blob store write fails, the harness SHALL classify the failure as `blob_write_failure` and retry with exponential backoff, bounded by `blob_write_retry_max` (configurable in `RunConfig`, default 3). Each retry SHALL NOT consume the Executor's Inner Loop retry budget. If `blob_write_retry_max` is exhausted, the failure SHALL be reclassified as `infrastructure_failure` and the Executor escalated. |

### Shared Execution Context

| ID | Requirement |
|---|---|
| SC-01 | A SharedExecutionContext SHALL be initialized for every Run at the same time as the Run object. |
| SC-02 | All Planners SHALL have read access to all SEC entries with `readable_by: "all"`. Reads SHALL return `version_id`. |
| SC-03 | Executors SHALL have read-only access to SEC entries with `readable_by: "all"`. |
| SC-04 | A Planner SHALL read relevant SEC entries (with `version_id`) before generating its decomposition. |
| SC-05 | A Planner SHALL write its key decisions to the SEC using OCC after generating its decomposition. If write rejected, Planner SHALL re-read and re-decompose. |
| SC-06 | SEC writes SHALL support typed values: `string | number | boolean | object`. |
| SC-07 | Write conflicts SHALL be resolved per `ConflictResolutionPolicy` and recorded as `sec_conflicts` on the Run. Conflict resolution under `merge` and `priority` SHALL guarantee that all Planners whose writes were affected by conflict resolution see the resolved value before spawning children. The harness MUST NOT allow a Planner to spawn children on a value that was subsequently overwritten or merged without its knowledge. |
| SC-08 | The SEC final state SHALL be included in the Trace Eval Phase 2 input. |
| SC-09 | OCC re-decompose cycles for a single Planner SHALL be bounded by `max_occ_retries` (configurable, default 2). If the limit is exceeded, the Planner SHALL be marked `ESCALATED` and a critical ticket filed. OCC re-decompose cycles emit `sec_occ_retry` bus events. Operators can distinguish OCC recovery from zero-cost pre-checks by filtering for this event type. |
| SC-10 | The SEC backend SHALL provide atomic conditional write semantics: a write MUST succeed or fail atomically based on `version_id` match, with no partial application. The default in-memory implementation satisfies this in single-process deployments only. |
| SC-11 | In multi-node harness deployments, the SEC backend MUST be replaced with an external store providing atomic compare-and-swap (CAS) semantics (e.g., Redis with WATCH/MULTI/EXEC, etcd, or a relational DB with optimistic locking). The default in-memory SEC backend is explicitly unsafe for distributed deployments and SHALL NOT be used when multiple harness processes share a Run. |
| SC-12 | The harness SHALL expose a `SECBackend` interface satisfying: `get(key) → {value, version_id}`, `cas(key, expected_version_id, new_value) → {success, current_version_id}`, `snapshot_read(keys[]) → SECSnapshot`, and `list(run_id) → SECEntry[]`. The default in-memory implementation SHALL conform to this interface. The `list(run_id)` operation SHALL be implemented with a `run_id`-scoped index. Full table scans are not acceptable in production backends. The recommended implementation stores all entries for a run under a run-scoped key prefix (Redis) or a `run_id` indexed column (relational DB). If `list(run_id)` would return more entries than `SEC_list_max_entries` (default: 10,000, configurable in `RunConfig`), the harness SHALL log a `sec_size_warning` event and surface it as a major ticket. |
| SC-13 | Planners that read multiple logically-related SEC keys SHOULD use `snapshot_read(keys[])` rather than sequential `get` calls. `snapshot_read` returns all requested entries consistent with a single point in time, with a composite `version_vector` mapping each key to its `version_id` at snapshot time. The Planner passes the per-key `version_id` from the `version_vector` to each corresponding CAS write. This eliminates the mixed-version snapshot problem where sequential `get` calls can return values from different write epochs. |

### Early Termination

| ID | Requirement |
|---|---|
| ET-01 | If `early_termination_policy.enabled` is true, the harness SHALL check RequirementMap coverage after every Executor reaches `COMPLETE`. |
| ET-02 | If all Requirements are covered and coverage confidence exceeds `confidence_threshold`, the harness SHALL cancel agents in `QUEUED`, `RETRYING`, or `AWAITING_HITL` state immediately. Agents in `GENERATING`, `GATE1_EVALUATING`, or `GATE2_EVALUATING` state are allowed to complete. The Run is marked `COMPLETE` after all in-flight agents reach a terminal state. |
| ET-03 | Before marking an agent `CANCELLED`, the harness SHALL resolve all outbound dependency edges from that agent by firing their `on_timeout` behavior immediately. The dependent agent proceeds per its declared `on_timeout` policy. "Cancelled agents" refers strictly to agents in `QUEUED`, `RETRYING`, or `AWAITING_HITL` state at the time early termination fires. Agents in `GENERATING`, `GATE1_EVALUATING`, or `GATE2_EVALUATING` are allowed to complete normally. Cancelled agents SHALL be logged as `cancelled` (not `ESCALATED`) on the Run and visible in the inspector. |
| ET-04 | Early termination SHALL be logged on the Run as `early_termination: true` with the coverage state that triggered it. |
| ET-05 | If `require_all_covered` is `false`, the harness SHALL trigger early termination as soon as `confidence_threshold` is met even if some Requirements are only partially covered. If `require_all_covered` is `true` (default), all Requirements must be fully covered before early termination fires. Regardless of `require_all_covered`, early termination SHALL NOT fire if any `RequirementRecord` with `priority: "high"` has `coverage_status != "covered"`. |
| ET-06 | The harness SHALL compute `coverage_confidence` deterministically using the formula: `(covered_requirements / total_requirements) × mean(requirement_coverage_scores)`. No LLM inference is involved in early termination triggering. |
| ET-07 | When early termination fires, the harness SHALL compute a topological sort of all QUEUED agents and cancel them in reverse dependency order (leaves first). This ensures agents with downstream dependents are cancelled last, allowing `on_timeout` behavior to fire in the correct order. |

### Execution Memory

| ID | Requirement |
|---|---|
| EM-01 | The harness SHALL initialize an `ExecutionMemory` object on every AgentNode at instantiation. |
| EM-02 | Before running ContextAssembly on retry, the harness SHALL check `ExecutionMemory.retrieved_chunks`. Already-retrieved chunk IDs SHALL be re-injected without a new retrieval call. |
| EM-03 | After every failed attempt, the harness SHALL append a `FailedStrategy` entry to `ExecutionMemory.failed_strategies` with the attempt number, `failure_type`, gate, gap text, and tool used. `ExecutionMemory.retrieved_chunks` is bounded by `max_retrieved_chunks` (default 500). Overflow evicts oldest entries (LRU). `ExecutionMemory.failed_strategies` is bounded by `max_retries` — one entry per attempt. |
| EM-04 | At node instantiation, the harness SHALL load semantically relevant `successful_patterns` from the Meta Loop store into `ExecutionMemory.successful_patterns`. The harness SHALL compute cosine similarity between the current node's scope embedding and stored `SuccessfulPattern.embedding` vectors. The top-1 pattern above `similarity_threshold` (default 0.75) SHALL be injected as a positive scaffold. If no pattern exceeds the threshold or the store is empty, scaffold injection is a no-op. When the pattern store exceeds `pattern_store_index_threshold` entries (default 1,000, configurable in `RunConfig`), implementations SHOULD use an approximate nearest-neighbor (ANN) index (e.g., FAISS IVF-PQ, HNSW) for similarity search rather than a full sequential scan. Exact cosine scan is acceptable below threshold. Pattern lookup latency SHALL be reported as `pattern_lookup_latency_ms` in per-node Run metrics. |
| EM-05 | ExecutionMemory SHALL be retained only for the duration of the Run. It SHALL NOT be persisted after Run completion. |

### Recursion Guard

| ID | Requirement |
|---|---|
| RG-01 | Before accepting a Planner's `"recurse"` decision, the harness SHALL check `complexity_classification` from the Router output. The Router's `complexity_classification` is run-scoped and propagated to all Planner instances at all depths — each Planner consults the same root Router classification, not a locally re-derived one. |
| RG-02 | If `complexity_classification` is `atomic` or `simple`, the harness SHALL override the decision to `"execute"` regardless of scope token count. |
| RG-03 | If `complexity_classification` is `moderate`, the harness SHALL apply the `min_scope_tokens` tiebreaker. Below threshold → override to `"execute"`. |
| RG-04 | If `complexity_classification` is `complex`, the run-level classification does NOT guarantee all sub-scopes are complex. The harness SHALL apply a **scope-level complexity check**: if the Planner's input scope is below `min_scope_tokens` AND the Planner's proposed children are semantically near-identical (per `depth_policy.shrink_if: "low_entropy"` check), the harness SHALL override to `"execute"` and log `recursion_guard_scope_override`. This prevents a run-level `complex` classification from forcing recursion on genuinely atomic sub-scopes. |
| RG-05 | RecursionGuard overrides SHALL be logged as `recursion_guard_triggered` events (run-level override) or `recursion_guard_scope_override` events (scope-level override) and filed as minor tickets. |
| RG-06 | `min_scope_tokens` SHALL be configurable per run and per domain context. Default: 200. |

### Depth Policy

| ID | Requirement |
|---|---|
| DP-01 | The harness SHALL check BudgetPolicy remaining budget before triggering `expand_if` behavior. If remaining budget < `expansion_cost_reserve`, expansion SHALL be suppressed regardless of coverage gap. |
| DP-02 | Suppressed expansions SHALL be logged as `depth_expansion_suppressed` on the Run and filed as a minor ticket. The RequirementMap SHALL reflect any Requirements that remain uncovered due to suppressed expansion. |

### Plan Validator

| ID | Requirement |
|---|---|
| PV-01 | The PLAN VALIDATOR SHALL run after Router output is accepted and before any agents are spawned. |
| PV-02 | The PLAN VALIDATOR SHALL check: acyclicity, output contract satisfiability, RequirementMap coverage completeness, cost bounds, depth cap, and orphan detection. **Note:** output contract satisfiability at PLAN VALIDATOR time is a schema-structural check against declared intentions only — it validates that the prerequisite's declared `output_spec` schema is type-compatible with the downstream `output_contract.required_fields`. It does not and cannot validate that the Executor will produce conformant output at runtime. Runtime divergence is handled by PV-06. Coverage completeness is a referential structural check against declared `covers_requirements` fields — it does not semantically verify that execution will actually satisfy the Requirement. Semantic coverage is assessed post-execution by Trace Eval. |
| PV-03 | Any fatal check failure SHALL prevent agent spawn. The harness SHALL log the `PlanValidationResult` and surface it to the operator. |
| PV-04 | The following failures are **fixable** (Router retry permitted, max 1): cost bound slightly exceeded, depth hint exceeds cap but objective is decomposable at lower depth. The following failures are **fatal** (run does not start): cycle detected, output contract type mismatch, uncoverable RequirementMap, orphan node. Partial coverage gaps are fixable only if the Router can produce a plan covering them. All other failures default to fatal. |
| PV-05 | PLAN VALIDATOR results SHALL be logged on the Run and visible in the inspector. |
| PV-06 | At runtime, if an Executor's actual output diverges from its declared `output_spec` or from the `output_contract.required_fields` of a downstream `output` edge, the harness SHALL classify this as `schema_failure`, trigger the Inner Loop with schema-specific retry prompt, and log the divergence as a `plan_validation_runtime_divergence` event on the Run. Downstream agents waiting on the `output` edge SHALL remain in `QUEUED` until the producing Executor reaches `COMPLETE` or `ESCALATED`. |

### Infrastructure Failure

| ID | Requirement |
|---|---|
| IF-01 | An `infrastructure_failure` SHALL NOT consume the agent's Inner Loop retry count. It SHALL trigger model-level retry and fallback behavior only. |

### Failure Classifier

| ID | Requirement |
|---|---|
| FC-01 | The FAILURE CLASSIFIER SHALL run before every Inner Loop retry prompt composition. |
| FC-02 | Classification SHALL be deterministic and zero inference cost. |
| FC-03 | The classified `failure_type` SHALL be included on the Ticket payload. |
| FC-04 | The retry prompt template SHALL be selected based on `failure_type` (see Primitive 18 per-type behavior). |
| FC-05 | The classified `failure_type` SHALL be recorded on `ExecutionMemory.failed_strategies` for the node. |

### Plan Cache

| ID | Requirement |
|---|---|
| PC-01 | PlanCache entries SHALL be invalidated when the RunConfig hash changes (Contract version change, tool registry change, or domain registry change). |
| PC-02 | A cache hit SHALL be surfaced to the operator with: the cached objective, similarity score, the originating run_id, and the delta between cached RunConfig hash and current RunConfig hash. |
| PC-03 | Cache writes occur only after `COMPLETE` trace verdict. The harness SHALL store the full `PlanCacheEntry` including dependency graph and requirement map. |

### Output Normalizer

| ID | Requirement |
|---|---|
| ON-01 | If `output_spec` is declared on an Executor's brief, the harness SHALL run the OUTPUT NORMALIZER after generation and before pre-checks. |
| ON-02 | Normalization failures SHALL be classified as `schema_failure` and trigger the Inner Loop with schema-specific retry prompt. Except for Executors with `strategy: 'validate'`, for which normalization failure SHALL trigger immediate escalation per the strategy behavioral contract. |
| ON-03 | Normalized output SHALL be stored as `normalized_output` on AgentNode. Eval SHALL run against `normalized_output`. |
| ON-04 | Raw output SHALL be retained on AgentNode for audit regardless of normalization. |
| ON-05 | When an Executor's `strategy` field defines behavior that conflicts with a general ON requirement, the strategy-specific behavior SHALL govern. The harness SHALL consult the strategy behavioral contract before applying the default normalization failure path. |
| ON-06 | The OUTPUT NORMALIZER SHALL run against the raw in-memory Executor output before blob store routing. The harness SHALL NOT dereference blob store entries for normalization purposes. |
| ON-07 | If `output_spec.max_normalization_bytes` is exceeded, the harness SHALL classify the failure as `schema_failure`, log `output_size_exceeded` on the node, and include the actual size and limit in the retry prompt. |

### Execution Sandbox

| ID | Requirement |
|---|---|
| ES-01 | All Executor tool execution SHALL run within the EXECUTION SANDBOX if `sandbox_config.enabled` is true. |
| ES-02 | An Executor SHALL NOT access tools outside its injected `tools_injected` subset at runtime. |
| ES-03 | Cross-agent data access SHALL flow only through SEC, blob store, or DependencyGraph output contracts. |
| ES-04 | Sandbox violations SHALL be classified as `tool_failure`, escalated, and filed as critical tickets. |

### Kill Switch

| ID | Requirement |
|---|---|
| KS-01 | If `kill_switch.enabled` is true, the harness SHALL monitor all configured trigger conditions throughout the run. |
| KS-02 | On `abort_run`: all in-flight agents SHALL be halted immediately. Run SHALL be marked `ERROR`. |
| KS-03 | On `escalate_run`: no new agents SHALL be spawned. All in-flight agents SHALL be marked `ESCALATED`. Run SHALL be surfaced to operator. |
| KS-03a | On `finalize_partial`: QUEUED and RETRYING agents SHALL be cancelled. GENERATING agents SHALL receive a cancellation signal and have `RunConfig.partial_output_timeout_ms` to complete before forced cancellation. The harness SHALL run CONTEXT COMPRESSOR and TRACE EVAL on all COMPLETE nodes and mark the Run `PARTIAL_COMPLETE`. |
| KS-04 | Kill switch events SHALL be logged and filed as critical tickets. |
| KS-05 | If `RunConfig.run_wall_clock_sla_ms` is set, the harness SHALL treat wall-clock run duration exceeding this value as a `time_exceeded` kill switch trigger, equivalent to a configured `KillSwitchTrigger` with `condition: "time_exceeded"` and `threshold: run_wall_clock_sla_ms`. |

### Meta Loop

ML-01 through ML-10 carry forward from v4 with two additions:

| ID | Requirement |
|---|---|
| ML-11 | After every `COMPLETE` run, the Meta Loop SHALL extract and store `successful_plan_embeddings` and `successful_sec_patterns` indexed by objective-type cluster and domain. The `artifact` field on `SuccessfulPattern` is capped at 512 tokens at write time. When the pattern store reaches `max_pattern_store_size` (configurable in `RunConfig`, default 10,000), the harness SHALL evict one pattern before writing the new one per `pattern_store_eviction_policy` (default `"lru"`: evict least-recently-accessed; `"oldest_first"`: evict pattern with earliest `created_at`). |
| ML-12 | At node instantiation, the harness SHALL load the most semantically relevant `successful_patterns` from the Meta Loop store into `ExecutionMemory.successful_patterns`. |
| ML-13 | After every `COMPLETE` run, the Meta Loop SHALL append an entry to the `complexity_classification_log`: `{run_id, router_classification, actual_depth_reached, final_trace_eval_score, objective_embedding}`. This log is the basis for Router classifier calibration over time. |
| ML-14 | The Meta Loop SHALL surface `classification_accuracy` as a calibration metric: the fraction of runs where `router_classification` matched `actual_depth_reached` at the same ordinal bucket (atomic→0, simple→1, moderate→2, complex→3+). Operators MAY use this metric to evaluate Router model performance and to configure `complexity_override_rules` for systematically misclassified objective patterns. |

---

## 12. Non-Functional Requirements

| Category | Requirement |
|---|---|
| **Concurrency** | Siblings with no declared dependencies execute concurrently, subject to `parallelism_policy.max_concurrent_agents`. Critical path agents are prioritized. When `max_queued_agents` is reached, upstream Planner decomposition SHALL be paused until queue depth drops below threshold. This prevents unbounded queue accumulation in deep trees. |
| **Resilience** | A failure in one agent branch SHALL NOT halt sibling branches. DependencyEdge TTL expiry proceeds or escalates per policy — never blocks indefinitely. HITL Checkpoint timeout proceeds or escalates per policy. Kill switch provides bounded hard-stop. |
| **Model agnostic** | No component assumes a specific model, vendor, or API. `model_policy` enables per-role routing but is not required. All inference and tool execution is harness-managed and injectable. Infrastructure failures on model calls SHALL be retried and failed-over to `fallback` models before triggering the Inner Loop. Model infrastructure errors are NOT evaluation failures. |
| **Extensibility** | New Dimensions, Contracts, tools, retrieval sources, domain hints, ticket providers, HITL options, failure types, sandbox configs, and normalization schemas SHALL be addable without modifying orchestration logic. |
| **Transparency** | Every decision, pre-check, gate verdict, judge reasoning, ContextAssembly source, SEC write, OCC conflict, `sec_occ_retry` cycle, DependencyGraph edge, HITL event, recursion guard override, retry, compression event, blob store write, failure type, normalization result, sandbox event, kill switch event, budget state, causal chains from any ESCALATED node to its root cause via `caused_by` links, and ticket SHALL be logged, timestamped, and inspectable. |
| **Determinism** | Given the same objective and Contracts, the system SHALL produce structurally consistent agent organizations. OCC and DependencyGraph scheduling introduce ordering guarantees, not nondeterminism. `idempotency_key` ensures retried tool calls do not produce duplicate side effects. |
| **Config-driven** | All policies (BudgetPolicy, RepairPolicy, JudgingPolicy, ContextAssemblyPolicy, CompressionPolicy, RecursionGuard thresholds, DepthPolicy, EarlyTerminationPolicy, KillSwitch, ParallelismPolicy, LatencySLAPolicy, ModelPolicy, MergedJudgePolicy, SandboxConfig, ConflictResolutionPolicy), domain registry, tool registry, plan cache, active ticket provider, and Contracts SHALL be configurable at runtime. |
| **Cost-aware** | Pre-checks are zero-cost. PLAN VALIDATOR is zero-cost. FAILURE CLASSIFIER is zero-cost. Gate 1 short-circuits prevent Gate 2 calls on hard failures. `merged_judge_mode` reduces eval call count by up to 70%. Adaptive judge selection reduces judge calls for routine work. ContextAssembly is retrieval, not inference. `plan_cost_estimate` enables pre-spawn cost gating. `early_termination` stops inference once objectives are met. |
| **Latency-aware** | DependencyEdge TTL prevents indefinite waits. `latency_sla_policy` sets per-agent-type wall time budgets. `on_violation` degrades or escalates rather than blocking. `run_wall_clock_sla_ms` sets a hard run-level wall-clock budget — when exceeded, the kill switch fires with `condition: "time_exceeded"`. This is independent of per-agent SLAs; both apply when both are set. |
| **Tool isolation** | Executors SHALL NOT have access to tools outside their injected subset. EXECUTION SANDBOX enforces this at runtime. Retrieval sources in ContextAssembly are read-only and do not count as tool access for the Executor. |
| **Security** | Tool execution is sandboxed per `SandboxConfig`. Data access is scoped per Executor. Sandbox violations are escalated, never silently tolerated. |

---

## 13. Agent State Machine

```
QUEUED → AWAITING_HITL → PRECHECKING → GENERATING → GATE1_EVALUATING → GATE2_EVALUATING → COMPLETE
                                                                                           → ESCALATED
                                      → RETRYING → PRECHECKING → ...
                                      → ERROR (unrecoverable)
                                      → CANCELLED (early termination)

Planner-only:
PARTIALLY_COMPLETE (at least one child COMPLETE, at least one in-flight)

Run-level (not agent-level):
PARTIAL_COMPLETE (kill switch finalize_partial: COMPLETE nodes evaluated, remaining agents cancelled)
```

**v5 note — OCC re-decompose:** When a Planner's SEC write is rejected (OCC conflict), the Planner re-reads and re-decomposes before spawning. This is a bounded in-Planner cycle (max 2 re-decompose attempts, per SC-09) that occurs entirely within the `PRECHECKING` state before `GENERATING`. It does not introduce a new state — it is a harness-managed loop with an escalation exit.

**v5 note — Kill switch:** `abort_run` drives all in-flight agents to `ERROR`. `escalate_run` drives all in-flight agents to `ESCALATED`.

| State | Description |
|---|---|
| `QUEUED` | Instantiated. Brief not yet received. Waiting on declared dependencies (or DependencyEdge TTL), parent decomposition, or OCC write resolution. |
| `AWAITING_HITL` | HITL Checkpoint reached. Execution paused. Awaiting operator action (approve / edit / reject). Only state requiring external human action before the machine advances. |
| `PRECHECKING` | Running deterministic pre-checks. Zero inference cost. For Planners: also includes OCC read/write cycle and re-decompose loop if write is rejected (bounded by `max_occ_retries`, default 2). Sub-state `PRECHECKING [occ_retry]` is emitted as a distinct bus event type (`sec_occ_retry`) when the Planner is in an OCC re-decompose cycle. This is NOT a new terminal state; it is a labeled sub-phase visible in inspector and on the message bus. On OCC conflict, the harness injects conflict context into the re-decompose prompt. Planners are expected to make targeted scope adjustments, not full regenerations. The conflict summary is logged on the `sec_occ_retry` bus event. |
| `GENERATING` | Actively producing output or declaring a tool call (harness executes tools within EXECUTION SANDBOX). Preceded by ExecutionMemory cache check and ContextAssembly if enabled. |
| `GATE1_EVALUATING` | Binary dimension Judges running. In `merged_judge_mode`: single batched call. Standard mode: one Judge per dimension, concurrent. Immediate fail if any FAIL verdict returned. |
| `GATE2_EVALUATING` | Non-binary dimension Judges running concurrently. Weighted average computed against threshold. |
| `RETRYING` | Span eval or pre-check failed. FAILURE CLASSIFIER has classified the failure. Type-specific retry prompt composed. ExecutionMemory updated. Re-entering AWAITING_HITL (if checkpoint declared) or PRECHECKING. |
| `PARTIALLY_COMPLETE` | Planner only. At least one child COMPLETE; at least one in-flight. |
| `COMPLETE` | Span eval passed. ChunkSummary or DataRef produced. Parent may advance once all siblings terminal. |
| `ESCALATED` | All retry attempts exhausted. Best output retained. Tickets filed. `context_confidence: "degraded"` propagated to all descendants. ChunkSummary produced (flagged escalated). Tree continues. |
| `CANCELLED` | Agent was in `QUEUED` state when early termination fired. RequirementMap coverage threshold was met by sibling branches. Agent did not execute. No tickets filed. Logged on Run as `cancelled`. |
| `ERROR` | Unrecoverable fault (sandbox violation with `on_violation: "error"`, kill switch `abort_run`, or harness-level failure). Branch halted. |

---

## 14. Data Contracts

### Execution Run

```typescript
interface Run {
  id:                       string
  objective:                string
  status:                   "running" | "complete" | "partial_complete" | "escalated" | "error"
  plan_source:              "fresh" | "cache"
  router_id:                string
  complexity_classification: "atomic" | "simple" | "moderate" | "complex"   // from Router; propagated to all RecursionGuard checks
  created_at:               string
  completed_at:           string | null
  requirement_map:        RequirementMap | null
  dependency_graph:       DependencyGraph | null
  shared_exec_context:    SharedExecutionContext
  sec_conflicts:          string[]         // conflict IDs only; full SECConflict objects stored on SharedExecutionContext
  trace_eval:             TraceSignal | null
  repair_attempts:        number
  budget_consumed:        BudgetConsumed
  plan_validation_result: PlanValidationResult | null
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

interface RunConfig {
  max_depth:                  number
  max_retries:                number
  min_scope_tokens:           number
  max_occ_retries:            number            // OCC re-decompose cycle bound, default 2
  model_infra_retry_max:      number            // infrastructure error retry count before fallback model, default 2
  SEC_list_max_entries:       number            // max entries returned by list(run_id); default 10,000
  ticket_provider:            string
  ticket_config:              Record<string, string>
  contracts:                  Record<AgentType, Contract>
  judging_policy:             JudgingPolicy
  merged_judge_policy:        MergedJudgePolicy
  context_assembly_policy:    ContextAssemblyPolicy
  compression_policy:         CompressionPolicy
  depth_policy:               DepthPolicy
  early_termination_policy:   EarlyTerminationPolicy
  kill_switch:                KillSwitch
  parallelism_policy:         ParallelismPolicy
  latency_sla_policy:         LatencySLAPolicy
  model_policy:               ModelPolicy
  sandbox_config:             SandboxConfig
  conflict_resolution_policy: "reject" | "merge" | "priority" | "escalate"
  domain_registry:            Record<string, string>
  tool_registry:              Tool[]
  budget_policy:              BudgetPolicy
  repair_policy:              RepairPolicy
  plan_cache:                        boolean
  hitl_checkpoints:                  HITLCheckpoint[]
  blob_write_retry_max:              number                    // default 3; max blob write retries before infrastructure_failure
  blob_store_policy:                 BlobStorePolicy           // quota and lifecycle policy for blob store
  feedback_loop_snapshot_id:         string | null             // if set, load feedback_loop weights from this snapshot at run start
  max_pattern_store_size:            number                    // default 10,000; max SuccessfulPattern entries before eviction
  pattern_store_eviction_policy:     "lru" | "oldest_first"   // default "lru"
  pattern_store_index_threshold:     number                    // default 1,000; above this, ANN index is used for similarity search
  run_wall_clock_sla_ms:             number | null             // if set, fires kill switch on time_exceeded when exceeded
  complexity_override_rules:         ComplexityOverrideRule[]  // hard-code complexity classification for known objective patterns
  partial_output_timeout_ms:         number                    // default 5,000; grace period for GENERATING agents on finalize_partial kill switch action
}
```

### Agent Node

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
  status:                   AgentStatus
  context_confidence:       "high" | "degraded"
  depth:                    number
  attempt:                  number
  idempotency_key:          string
  hitl_checkpoint:          HITLCheckpoint | null
  hitl_resolution:          "approved" | "edited" | "rejected" | "timed_out" | null
  context_assembly_sources: string[]
  context_tokens_injected:  number
  sec_writes:               SECEntry[]
  execution_memory:         ExecutionMemory
  chunk_summary:            ChunkSummary | null
  plan_cost_estimate:       PlanCostEstimate | null
  output_spec:              OutputSpec | null
  input:                    AgentInput
  output:                   AgentOutput | null
  normalized_output:        object | null
  action:                   ExecutorAction | null
  data_refs:                DataRef[]
  precheck_failures:        string[]
  failure_type:             FailureType | null
  gate1_blocked:            boolean
  gate1_dimension:          string | null
  span_eval:                AggregatedSignal | null
  tickets:                  string[]
  children:                 string[]
  created_at:               string
  completed_at:             string | null
  caused_by:                string | null   // agent_id of upstream agent whose failure caused this node's degraded state
  causal_chain:             string[]        // ordered list of agent_ids from root failure to this node
}
```

### Tool (v5.1 expanded)

```typescript
interface Tool {
  id:                string
  description:       string
  idempotent:        boolean         // default: true. Tools with idempotent: false bypass the ToolResultCache
  input_schema:      string | null   // JSON Schema; harness validates tool input before execution
  output_schema:     string | null   // JSON Schema; harness validates tool output after execution
  latency_sla_ms:    number | null   // null = inherit run-level LatencySLAPolicy for executor type
  side_effect_class: "read_only" | "write_once" | "write_repeatable" | "destructive"
  retry_on_error:    boolean         // default false; if true, harness retries once before classifying as tool_failure
  // Tools with side_effect_class: "destructive" are NEVER retried regardless of retry_on_error
}
```

**Tool contract enforcement:** The harness SHALL validate tool inputs against `input_schema` before execution and tool outputs against `output_schema` after execution. Schema violations are classified as `tool_failure`. `side_effect_class: "destructive"` tools are not retried regardless of `retry_on_error` — a single execution is definitive.

`caused_by` and `causal_chain` are set by the harness when an agent enters `ESCALATED` due to an upstream condition (ESCALATED prerequisite, rejected OCC parent) rather than its own eval failure. The `causal_chain` is built by following `caused_by` links upward. `causal_chain` is included in BusEvent metadata for `retry`, `ticket`, and `dependency_timeout` events.

### Feedback Loop Health

```typescript
interface FeedbackLoopHealth {
  mean_weight_deviation_from_base: number   // average |weight - base_weight| across all tracked chunks
  chunks_at_floor:                 number   // count of chunks at base_weight × 0.5 clamp (minimum)
  chunks_at_ceiling:               number   // count of chunks at base_weight × 2.0 clamp (maximum)
  total_chunks_tracked:            number
  snapshot_id:                     string   // identifier for use as RunConfig.feedback_loop_snapshot_id to roll back
}
```

### Executor Action

```typescript
interface ExecutorAction {
  tool_id:          string | null
  tool_input:       object | null
  tool_output_raw:  string | null
  tool_output:      string | object | null
  tool_output_type: "string" | "json" | "error" | null
  verified:         boolean
  error:            string | null
}
```

### Dimension Signal (v5 adds `failure_type`)

```typescript
interface DimensionSignal {
  dimension_id:  string
  is_binary:     boolean
  gate:          1 | 2
  verdict:       "pass" | "partial" | "fail"
  numeric_score: 100 | 50 | 0
  gap:           string | null
  severity:      "critical" | "major" | "minor" | null
  reasoning:     string
  skipped:       boolean
  failure_type:  FailureType | null
}
```

### Plan Cost Estimate (v5, new)

```typescript
interface PlanCostEstimate {
  tokens:     number    // estimated total token consumption
  agents:     number    // estimated total agents to spawn
  tool_calls: number    // estimated total tool calls
}
```

### Requirement Map

```typescript
interface RequirementMap {
  run_id:              string
  requirements:        RequirementRecord[]
  total:               number
  covered_count:       number
  coverage_confidence: number   // computed per ET-06 formula: (covered_count / total) × mean(coverage_scores)
}

interface RequirementRecord {
  requirement_id:  string
  text:            string
  priority:        "high" | "medium" | "low"   // default: "medium"
  coverage_status: "uncovered" | "partially_covered" | "covered"
  coverage_score:  number
  // Mapping: 1.0 = COMPLETE + Gate 2 pass; 0.5 = COMPLETE + Gate 1 only; 0.0 = ESCALATED or uncovered
  covered_by:      string[]   // agent IDs that produced evidence for this requirement
  contested:       boolean    // true if covered_by contains agents with conflicting outputs
}
```

**`RequirementRecord.priority` early-termination guard:** Early termination is blocked if any `RequirementRecord` with `priority: "high"` has `coverage_status != "covered"`, regardless of `coverage_confidence` and `require_all_covered` setting. This guard runs before the `coverage_confidence` check.

### Plan Cache Entry

```typescript
interface PlanCacheEntry {
  cache_id:            string
  objective_embedding: number[]
  embedding_model_id:  string    // model ID that produced objective_embedding; validated on load
  embedding_dimension: number    // vector dimension; validated on load
  objective_signature: string    // SHA-256 of normalized objective text
  router_output:       RouterOutput
  dependency_graph:    DependencyGraph
  requirement_map:     RequirementMap
  run_config_hash:     string    // hash of RunConfig at cache time
  created_at:          string
  run_id:              string    // the COMPLETE run this was cached from
}
```

### Complexity Override Rule

```typescript
interface ComplexityOverrideRule {
  pattern:              string   // regex matched against objective text (case-insensitive)
  force_classification: "atomic" | "simple" | "moderate" | "complex"
  reason:               string   // documented justification; required
}
```

Override rules in `RunConfig.complexity_override_rules` are applied by the harness **before** the RecursionGuard reads `complexity_classification`. The first matching rule wins. Override application is logged as a `recursion_guard_scope_override` bus event with the matching rule's `reason`.

### Blob Store Policy

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

### Dependency Graph (v4, updated in v5)

```typescript
interface DependencyGraph {
  run_id: string
  edges:  DependencyEdge[]   // DependencyEdge schema in Primitive 13; v5 adds timeout_ms + output_contract
}
```

### Parallelism and Latency Policies

```typescript
interface ParallelismPolicy {
  max_concurrent_agents: number
  max_queued_agents:     number   // default: 2× max_concurrent_agents; caps total QUEUED agents
  priority_queue:        "critical_path_first" | "fifo"
}

interface LatencySLAPolicy {
  enabled:    boolean
  budgets:    Record<"router" | "planner" | "executor", number>  // ms per type
  on_violation: "degrade" | "skip" | "escalate"
}

interface ModelPolicy {
  planner:            string | null    // model identifier
  planner_fallback:   string | null
  executor:           string | null
  executor_fallback:  string | null
  judge:              string | null
  judge_fallback:     string | null
  router:             string | null
  router_fallback:    string | null
  embedder:           string | null    // model used for all embedding computation (SuccessfulPattern, PlanCache, feedback_loop)
  embedder_dimension: number | null    // vector dimension produced by embedder; required when embedder is set
}
```

If a model call returns an infrastructure error (timeout, 5xx, rate limit), the harness SHALL retry the call up to `model_infra_retry_max` times (default 2) before falling back to the `*_fallback` model. This does NOT consume the agent's Inner Loop retry budget.

### Message Bus Event (v5 additions)

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

---

## 15. User Stories

### US-001: Operator — any objective, one action (Unchanged from v4)

Acceptance criteria unchanged. Addition: if PLAN VALIDATOR fails, the operator receives a structured validation failure before any inference cost is incurred.

### US-002: Operator — inspect any agent's full execution trace (Enhanced from v4)

**Acceptance criteria additions:**
7. Failure type classification is shown for every failed attempt.
8. ExecutionMemory contents (retrieved chunks, failed strategies, successful patterns) are visible per node.
9. Blob store DataRef pointers are shown with dereference links for structured outputs.
10. OCC conflict history for SEC writes is visible per Planner node.

### US-003: Operator — proactive review at high-risk decision points (Unchanged from v4)

### US-004: Operator — mission coverage at a glance (Unchanged from v4)

### US-005: Platform engineer — register a new retrieval source (Unchanged from v4)

### US-006: Operator — budget enforcement and degradation (Unchanged from v4)

### US-007: QA engineer — adaptive judge cost control (Enhanced from v4)

**Acceptance criteria addition:**
6. `merged_judge_mode` is configurable per run. Latency reduction from merging is visible in run summary.

### US-008: Operations — judge calibration and drift detection (Unchanged from v4)

---

### US-009: Operator — concurrent Planners don't diverge

**As a** product operator running complex multi-Planner objectives,
**I want to** know that concurrent Planners coordinate their strategy decisions reliably,
**so that** the execution tree doesn't produce conflicting or redundant approaches silently.

**Acceptance criteria:**
1. SEC writes use OCC with `version_id`. A Planner that reads stale state is rejected before spawning children.
2. All SEC OCC rejections are logged and visible in the inspector.
3. `ConflictResolutionPolicy` is configurable per run.
4. SEC conflicts are surfaced in the Run summary with the conflicting values and resolution.
5. A Planner that fails OCC write re-reads and re-decomposes before spawning. This cycle is bounded (max 2 re-decomposes before escalation).

---

### US-010: Engineer — dependent agent gets exact data, not a summary

**As a** platform engineer building pipelines where one Executor's output is another's input,
**I want to** pass structured data (arrays, JSON) between agents without losing fidelity to summarization,
**so that** downstream agents work on the actual data, not a prose description of it.

**Acceptance criteria:**
1. Executors that produce structured payloads write to the blob store and include `DataRef` pointers.
2. The ContextCompressor does not summarize content with `data_refs`.
3. Dependent agents dereference blob store pointers before generation.
4. Blob store contents are accessible for the duration of the run.
5. DataRef pointers are visible in the inspector with schema information.

---

### US-011: Operator — run terminates when work is done, not when tree is exhausted

**As a** product operator,
**I want to** stop the run as soon as all Requirements are met, without waiting for every queued agent to complete,
**so that** I don't waste inference budget on work that's no longer needed.

**Acceptance criteria:**
1. `early_termination_policy` is configurable per run.
2. The harness checks RequirementMap coverage after every Executor completes.
3. If all Requirements are covered and confidence exceeds threshold, pending agents are cancelled and the run completes.
4. Early termination is logged on the Run with the triggering coverage state.
5. Cancelled agents are shown as cancelled (not escalated) in the inspector.

---

## 16. Constraints & Assumptions

### Constraints

**From v4 (all carry forward):**
- ContextAssembly retrieval quality determines Executor accuracy.
- SharedExecutionContext is eventually consistent within a decomposition cycle. OCC ensures children are spawned on valid state, but multiple active decomposition cycles may still produce conflicts. Conflict frequency is a signal to add dependencies.
- DependencyGraph must be acyclic. The PLAN VALIDATOR validates this before spawn.
- HITL Checkpoints add wall time. Use `timeout_ms` and `on_timeout: "proceed"` for checkpoints where review is beneficial but not blocking.
- ContextAssembly adds retrieval latency before the first Executor generation call.
- CompressionPolicy loses detail on qualitative summaries. Use `compress_at_depth` conservatively on high-stakes runs, or disable. Structured data is not affected (blob store bypass).
- JudgingPolicy adaptive mode requires calibration history.
- RecursionGuard complexity classification is only as good as the Router's classification accuracy. Monitor `recursion_guard_triggered` events.
- Tool execution is harness-managed. Models with native tool use APIs must be wrapped to conform to the declare-then-execute pattern.
- Domain registry and tool registry ship empty.

**New in v5:**
- **SEC OCC does not prevent cross-key semantic conflicts.** OCC guarantees per-key write consistency only. Two Planners writing to different keys can produce a semantically inconsistent SEC state that all downstream reads treat as valid. Mitigate by: (a) declaring inter-Planner dependencies that sequence writes for semantically coupled keys, (b) using `ConflictResolutionPolicy: 'escalate'` for high-stakes SEC keys to surface writes to the operator, (c) using the `coherence` trace eval dimension to catch strategy-level conflicts post-execution. Cross-key semantic validation is a v6 candidate (GOS primitive).
- **OCC adds Planner decomposition latency** on write conflict. A Planner that loses a write conflict must re-read and re-decompose before spawning. On high-contention SEC keys, set `ConflictResolutionPolicy: "priority"` to minimize re-decompose cycles.
- **Blob store is run-scoped and in-memory by default.** Large structured payloads (>5MB) require an external blob store backend. Operators must configure this before running data-intensive workloads. Blob store default is in-memory and not shared across harness processes. Multi-node runs MUST configure an external blob store backend.
- **PLAN VALIDATOR adds a synchronous gate before spawn.** This is zero inference cost but adds wall time. On runs where the Router is highly reliable, set `plan_validator.cost_check: false` to skip cost bound validation.
- **`merged_judge_mode` reduces Gate 1 precision for custom dimensions.** Batching all Gate 1 dimensions into one call reduces the Judge's ability to allocate attention per dimension. For custom high-stakes dimensions, use the `exceptions` list in `MergedJudgePolicy`.
- **`feedback_loop` is cross-run persistent state, unlike `ExecutionMemory`.** When `feedback_loop` is enabled in `ContextAssemblyPolicy`, chunk relevance weights are updated in the retrieval source index after every run that passes eval. This is permanent, cross-run state — not run-scoped. Operators must treat it as a shared index that drifts over time and should audit weight distributions periodically. The Meta Loop's `successful_plan_embeddings` and `successful_sec_patterns` are separate from `feedback_loop` — they update different stores and do not conflict. **Feedback loop** is persistent cross-run state. Treat it as a slowly-drifting index. Audit weight distributions when `sec_conflicts` rate or retrieval quality metrics change significantly.
- **`replay_mode: "full"` is specced and safe to use in v5.** `full` replay re-executes the entire run from scratch using the same objective, `RunConfig`, and `DependencyGraph` as the original. All agents are re-instantiated. `idempotency_key` values are re-derived deterministically (same `run_id` + scope hash), so previously-`COMPLETE` tool calls within the same run will return cached results without re-execution, making full replay idempotent for tool side-effects. Recommended for: debugging failed runs, auditing determinism, re-running after Contract updates. **`replay_mode: "from_node"` and `"dry_run"` are deferred to v6.** `from_node` semantics require a spec for node boundary identity across runs and how ExecutionMemory state is restored. `dry_run` requires a spec for how tool execution is mocked without side-effects. Both MUST remain unimplemented in v5 deployments.
- **EXECUTION SANDBOX requires runtime support.** Isolation guarantees depend on the deployment environment's process and network isolation capabilities. In environments without container-level isolation, `tool_execution: "shared"` is the practical default.
- **`idempotency_key` prevents duplicate execution, not duplicate side effects from prior runs.** Idempotency is run-scoped. Cross-run deduplication is an external concern.
- **Kill switch `loop_detected` requires scope hashing.** The harness must hash agent scope at instantiation. Scope hash collisions (different objectives that hash identically) can produce false positives. Use a high-collision-resistance hash function.

### Assumptions

All v4 assumptions carry forward. Additional v5 assumptions:

- OCC re-decompose cycles are rare in practice. Well-decomposed objectives produce Planners with non-overlapping SEC write keys. Monitor `sec_conflicts` rate per run type.
- Blob store backend is available for runs with structured Executor outputs. The default in-memory store is sufficient for development and low-volume production.
- `successful_patterns` loaded from the Meta Loop are semantically relevant to the current objective. Pattern quality degrades if the Meta Loop is not running or if run history is sparse. Default to `full` mode for new deployments.
- `merged_judge_mode` batching produces accurate per-dimension verdicts. This assumption should be validated against isolated-mode results during initial deployment.

---

## 17. Glossary

All v4 glossary entries carry forward. Additions and modifications:

| Term | Definition |
|---|---|
| **Blob Store** | A run-scoped key-value store for structured Executor outputs. Contents are never compressed. Accessed by DataRef pointer. Retained for the duration of the Run. |
| **ConflictResolutionPolicy** | Per-run configuration for how the harness resolves SEC OCC write conflicts: `reject \| merge \| priority \| escalate`. |
| **DataRef** | A pointer to a blob store entry. Included in `data_refs` on AgentNode and in ChunkSummary. Consumers dereference to access the full structured payload. |
| **DepthPolicy** | Run-scoped configuration for adaptive depth adjustment: expand on coverage gaps, shrink on low entropy. Hard cap is governed by `RunConfig.max_depth`. |
| **EarlyTerminationPolicy** | Run-scoped policy that stops the run when RequirementMap coverage exceeds `confidence_threshold`. Cancels pending agents without escalating them. |
| **ExecutionMemory** | Per-node, per-run short-term cache of retrieved chunks, failed strategies, and successful patterns. Prevents redundant retrieval on retries. Lives only for the duration of a Run. |
| **ExecutionSandbox** | Runtime isolation layer around Executor tool execution. Scopes filesystem, environment, and network access to declared tools. |
| **FailureClassifier** | Harness component that classifies every evaluation failure into a typed taxonomy before retry prompt composition. Zero inference cost. |
| **FailureType** | Typed taxonomy for evaluation failures: `retrieval_failure \| reasoning_failure \| planning_failure \| tool_failure \| timeout_failure \| novelty_failure \| schema_failure \| blob_write_failure \| infrastructure_failure`. |
| **GlobalObjectiveState (GOS)** | Proposed v6 primitive: a typed, queryable, cross-agent state store that replaces the SEC with richer semantics. Deferred from v5. |
| **idempotency_key** | Harness-assigned key per AgentNode. Prevents duplicate tool execution when the same node retries. Run-scoped. |
| **KillSwitch** | Hard stop mechanism. Triggers on cost, time, or loop detection. Actions: `abort_run` (immediate halt), `escalate_run` (graceful wind-down), or `finalize_partial` (evaluate completed work and halt). |
| **LatencySLAPolicy** | Per-run configuration for per-agent-type wall time budgets and violation behavior. |
| **MergedJudgePolicy** | Per-run configuration to batch Gate 1 dimensions into a single judge call. Reduces evaluation latency. Binary dimensions are never excluded from evaluation. |
| **ModelPolicy** | Per-run configuration for model assignment per role (router, planner, executor, judge, embedder). Optional — system is model agnostic by default. |
| **BlobStorePolicy** | Per-run configuration for blob store quota, eviction, and lifecycle. Includes `max_run_bytes`, `eviction_policy`, `ttl_seconds`, and `on_quota_exceeded`. |
| **ComplexityOverrideRule** | A regex-pattern + forced classification rule in `RunConfig`. Applied before the RecursionGuard reads Router `complexity_classification`. Allows operators to hard-code classification for systematically misclassified objective patterns. |
| **FeedbackLoopHealth** | Per-run metric record emitted when `feedback_loop` is enabled. Tracks mean weight deviation, chunks at floor/ceiling clamps, and a `snapshot_id` for rollback. |
| **RequirementRecord** | A single entry in the `RequirementMap`. Carries `requirement_id`, `text`, `priority`, `coverage_status`, `coverage_score`, `covered_by`, and `contested`. |
| **SECSnapshot** | Result of `snapshot_read(keys[])` on the SEC backend. Returns all requested entries consistent with a single point in time, plus a `version_vector` mapping each key to its `version_id`. Used by Planners to avoid mixed-version read hazards. |
| **novelty** | Gate 2 Executor dimension. Evaluates whether the output is substantively different from prior retry attempts. Stops retry loops producing near-identical outputs. |
| **OCC (Optimistic Concurrency Control)** | Write protocol for the SEC. Reads return `version_id`. Writes are conditional on `version_id` match. Conflict → write rejected → re-read + re-decompose. |
| **OutputNormalizer** | Harness component that converts raw Executor output to a declared `OutputSpec` schema before pre-checks and eval. |
| **OutputSpec** | Schema declaration for Executor output: type, schema, required fields, max tokens. Declared by Planner in child brief. |
| **ParallelismPolicy** | Per-run configuration for `max_concurrent_agents` and priority queue ordering. |
| **PlanCostEstimate** | Router and Planner estimate of tokens, agents, and tool calls for the execution plan. Validated against BudgetPolicy by the PLAN VALIDATOR. |
| **PlanValidator** | Pre-spawn validation gate. Runs after Router output and before first agent spawn. Checks acyclicity, coverage, cost, depth, orphans, and output contract satisfiability. Zero inference cost. |
| **SandboxConfig** | Per-run configuration for EXECUTION SANDBOX: isolation mode, data access scope, network policy, violation behavior. |
| **strategy** | Per-child field in Planner decomposition output: `search \| synthesize \| transform \| analyze \| validate`. Declared by the Planner for each child scope. Drives tool selection, context assembly behavior, and eval dimension weighting for that child. Different children of the same Planner may have different strategies. |
| **successful_pattern** | Meta Loop artifact: embedding of a Planner decomposition or SEC write sequence from a `COMPLETE` run. Loaded into ExecutionMemory to scaffold successful approaches. |
| **version_id** | Monotonically incrementing identifier on every SEC entry. Read with the value; must match on write for OCC to succeed. |

---

*Agent Nexus v5 PRD — v5.1 — Internal Use Only*
