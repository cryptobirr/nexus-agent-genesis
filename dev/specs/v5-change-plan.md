# Agent Nexus v5 → v5.1 Change Plan

**Source:** Consolidated analysis of three independent gap reviews against the v5.0 spec
**Date:** 2026-03-22T00:00:00Z
**Scope:** Spec amendments only — no implementation code

---

## How to Read This Document

Each change is assigned a **priority tier**:

- **P0 — Blocking:** Spec has an internal contradiction or missing definition that makes correct implementation impossible. Multiple implementations will diverge silently.
- **P1 — High:** A production-critical failure mode with no recovery path exists in the current spec.
- **P2 — Medium:** A scalability, observability, or testability gap that will surface under load or over time.
- **P3 — Deferred to v6:** Noted by all reviews but architecturally invasive. Tracked, not actioned in v5.1.

Changes are ordered by priority tier, then by the section of the spec they amend.

---

## P0 — Spec Contradictions (Fix Before Implementation Begins)

---

### C-01 — Strategy Weight Semantics Are Contradictory

**Section affected:** §7.2 (Strategy-Aware Eval)
**Reviewers:** Review 1 (GAP-02)

**Problem:**
Section 7.2 states strategy weight changes are "applied as deltas from base weights before normalization," but the example table uses absolute-target language: "`specificity` weight increased to 0.20 (from 0.15)." These are mutually exclusive semantics. An operator who customizes base weights via `RunConfig.contracts` will get different scores depending on which interpretation the implementer chose.

Additionally, the `synthesize` strategy adds a new `coherence` dimension — the spec does not clarify whether this is "injected at 0.10 and re-normalized" or "delta from zero." Same ambiguity, higher stakes.

**Change required:**
Adopt **absolute override** semantics. Rename the per-strategy weight field to `weight_override` per dimension. Document: "Strategy weight overrides are applied as absolute values. The harness re-normalizes all dimension weights to sum to 1.0 after applying overrides. Operators who need delta semantics must compute the target absolute value themselves." Remove all "increased to X (from Y)" language from the example table — just list the target values.

---

### C-02 — `RequirementMap` Has No Interface Definition

**Section affected:** §14 (Data Contracts)
**Reviewers:** Review 1 (GAP-03), Review 2 (Gap 6), Review 3 (Gap 1)

**Problem:**
`RequirementMap` is referenced in 12+ places: ET-06 formula, PV-02 coverage check, trace eval Phase 1, `Run.requirement_map`, `PlanCacheEntry.requirement_map`, the PLAN VALIDATOR coverage completeness check, and the early termination confidence computation. Section 14 never defines a TypeScript interface for it. The per-requirement `coverage_score` mapping (1.0/0.5/0.0) is buried in an inline comment in §6.5 and never formalized.

**Change required:**
Add the following interface to Section 14:

```typescript
interface RequirementMap {
  run_id:        string
  requirements:  RequirementRecord[]
  total:         number
  covered_count: number
  coverage_confidence: number  // computed: see ET-06 formula
}

interface RequirementRecord {
  requirement_id:  string
  text:            string
  coverage_status: "uncovered" | "partially_covered" | "covered"
  coverage_score:  number    // 1.0 = COMPLETE + Gate2 pass; 0.5 = COMPLETE + Gate1 only; 0.0 = ESCALATED
  covered_by:      string[]  // agent IDs that produced evidence for this requirement
  contested:       boolean   // true if covered_by contains agents with conflicting outputs
}
```

Move the `coverage_score` mapping out of the §6.5 inline comment and into a formal table in §14 adjacent to this interface.

---

### C-03 — `merge` ConflictResolutionPolicy Is Algorithmically Undefined for Object Key Conflicts

**Section affected:** §5, Primitive 12 (SEC), `ConflictResolutionPolicy`
**Reviewers:** Review 1 (GAP-04), Review 3 (Gap 1)

**Problem:**
The `merge` policy says it "attempts value-level merge (object keys, array append)" but gives no algorithm for the case where both writes contain the same object key with different values. The "falls back to `reject` on type conflict" condition does not trigger here (both values are `object` type). The merged value is undefined, breaking the spec's determinism guarantee.

**Change required:**
Add the following merge algorithm to the `merge` policy description in Primitive 12:

> **Object key conflict resolution:** When two writes contain the same key within an `object`-typed value, the **first writer wins** per-key (consistent with OCC's intent of preserving the earliest validated write). Specifically: the key's value from the write with the lower `version_id` (i.e., the write that read an earlier version) is retained. The later writer's value for that key is discarded and logged in `SECConflict` as `key_conflict_discarded`.
>
> **Array append order:** Array values are appended in lexicographic order of the `written_by` agent ID. This is deterministic across replays.
>
> If either value is not an `object` or `array` (i.e., a type mismatch at the top level), the merge falls back to `reject`.

---

## P1 — Production-Critical Failure Modes

---

### C-04 — Blob Store Write Failure Has No Classification or Recovery Path

**Section affected:** §5, Primitive 15 (Context Compressor / Blob Store), §18 (Failure Classifier)
**Reviewers:** Review 1 (GAP-06)

**Problem:**
BS-02 requires blob store writes to complete before an Executor reaches `COMPLETE`. BS-03 handles read failures via `tool_failure` → escalate. But write failures have no defined state transition, no `FailureType` classification, and no retry path. An Executor whose blob write fails is stuck in `GENERATING` indefinitely per the current spec.

**Change required:**
1. Add `"blob_write_failure"` to the `FailureType` union in Primitive 18.
2. Add a classification rule to the Failure Classifier table: `Blob store write rejected or timed out → blob_write_failure`.
3. Add retry behavior for `blob_write_failure`: "Re-attempt the write with exponential backoff, bounded by `blob_write_retry_max` (default: 3, configurable in `RunConfig`). Each retry does NOT consume Inner Loop retry budget (mirrors `infrastructure_failure` behavior for judge retries). If write retries are exhausted, reclassify as `infrastructure_failure` and escalate."
4. Add `blob_write_retry_max: number` to `RunConfig`.

---

### C-05 — Embedding Model Is Absent from `ModelPolicy`; Cross-Run Vector Incompatibility Is Undetected

**Section affected:** §5, Primitive 16 (Execution Memory, `SuccessfulPattern`), §14 (Data Contracts)
**Reviewers:** Review 1 (GAP-07)

**Problem:**
Three subsystems require embedding computation: `SuccessfulPattern.embedding` (EM-04 cosine similarity), `feedback_loop` chunk relevance updates, and PlanCache `objective_embedding` lookup. `ModelPolicy` defines four roles (`router | planner | executor | judge`) but no `embedder` role. If the embedding model changes between runs, all stored vectors become dimensionally incompatible with new vectors. The cosine similarity search will silently return wrong results — this breaks cross-run learning and replay determinism simultaneously.

**Change required:**
1. Add `embedder: string | null` and `embedder_dimension: number` to the `ModelPolicy` interface.
2. Add `embedding_model_id: string` and `embedding_dimension: number` to both `SuccessfulPattern` and `PlanCacheEntry`.
3. Add a validation rule to the Meta Loop and PlanCache load path: "On load, the harness SHALL compare `embedding_model_id` on the stored entry against the current `ModelPolicy.embedder`. A mismatch is treated as a cache miss — the stored vector is not used and does not error. A mismatch is logged as `embedding_model_mismatch` on the Run."

---

### C-06 — `proceed_degraded` Has No Defined Fallback Payload

**Section affected:** §5, Primitive 13 (Dependency Graph), `on_timeout: "proceed_degraded"`
**Reviewers:** Review 2 (Gap 5), Review 3 (Gap 7)

**Problem:**
When a dependency times out and `on_timeout: "proceed_degraded"` fires, the dependent agent proceeds — but the spec does not define what data that agent receives in place of the missing output. An agent whose prompt and tools expect a specific JSON array from its dependency will likely crash with `tool_failure` or `reasoning_failure` when the array is absent, wasting inference budget on a doomed task.

**Change required:**
Add a `fallback_payload` field to `OutputContract`:

```typescript
interface OutputContract {
  output_schema:    string
  required_fields:  string[]
  validated_by:     "harness" | "plan_validator"
  fallback_payload: unknown | null  // injected when on_timeout: "proceed_degraded" fires
  // Must conform to output_schema. If null, harness injects a schema-compliant null object.
}
```

Add behavior: "When `on_timeout: 'proceed_degraded'` fires, the harness injects `fallback_payload` (or a schema-compliant null object if `fallback_payload` is null) into the dependent agent's context with a labeled prefix: `[DEPENDENCY TIMEOUT — data unavailable from {agent_id}]: {fallback_payload}`. The dependent agent's prompt MUST include this label so it can adapt its strategy."

---

### C-07 — Output Normalizer Behavior for `text` and `code` Types Is Undefined

**Section affected:** §5, Primitive 19 (Output Normalizer)
**Reviewers:** Review 1 (GAP-05), Review 2 (Gap 4)

**Problem:**
`OutputSpec.type` accepts `"text" | "json" | "code" | "artifact" | "tool_result"` but normalization behavior is only specified for `json`. For `text` and `code`, `schema` is `string | null` and `required_fields` is a `string[]` — normalization behavior is undefined. A `validate` strategy Executor with `output_spec.type: "text"` has no defined normalization behavior, yet a `schema_failure` path exists that would inject "the expected schema" into the retry prompt — but there is no schema for text.

Additionally: if `schema` is null and `required_fields` is empty, is the normalizer a structural no-op? The spec does not say.

**Change required:**
Add a `normalization_mode` field to `OutputSpec` and document per-type behavior:

```typescript
interface OutputSpec {
  type:                    "text" | "json" | "code" | "artifact" | "tool_result"
  schema:                  string | null
  required_fields:         string[]
  max_tokens:              number | null
  max_normalization_bytes: number
  normalization_mode:      "strict" | "structural_only" | "passthrough"
  // strict:          full schema validation + required_fields check; schema_failure on mismatch
  // structural_only: validates max_tokens compliance only; no schema_failure possible
  // passthrough:     normalizer is a no-op; output passes through unchanged
}
```

Add per-type normalization defaults table:

| `type` | Default `normalization_mode` | What is checked |
|---|---|---|
| `json` | `strict` | Schema validation + required fields |
| `text` | `structural_only` | `max_tokens` compliance only |
| `code` | `structural_only` | `max_tokens` compliance + language declaration present |
| `artifact` | `strict` | Schema validation + required fields |
| `tool_result` | `strict` | Schema validation + required fields |

Document: "If `schema` is null and `required_fields` is empty and `normalization_mode` is `passthrough`, the normalizer is a structural no-op. No `schema_failure` is possible for that node."

---

### C-08 — Early Termination Can Cancel Nodes on the Critical Dependency Path

**Section affected:** §6.5 (Early Termination)
**Reviewers:** Review 2 (Gap 7 — partially addressed), Review 3 (Gap 7)

**Problem:**
The spec's current §6.5 does address dependency resolution on cancellation (the `early_termination_dependency_resolution` log entry). However it only protects *in-flight* agents — agents that have a `depends_on` edge to a `QUEUED` agent being cancelled. It does not protect against the case where a `QUEUED` agent is itself on the critical path for *other queued agents* that have not yet been cancelled. The cancellation order matters and the spec does not specify it.

Additionally, the coverage confidence formula (ET-06) is mathematically dangerous as noted in Review 2: 9/10 perfect requirements + 1 uncovered requirement = 0.81 confidence, above the default 0.9 threshold only if threshold is set lower. But if `confidence_threshold` is 0.80, the system early-terminates despite a total gap. This is an unacceptable outcome for any requirement marked high-priority.

**Change required:**
1. Add a `require_all_covered` guard to `EarlyTerminationPolicy` (the field already exists; clarify that when `require_all_covered: true`, the harness SHALL NOT early-terminate if any `RequirementRecord.coverage_status == "uncovered"` regardless of `coverage_confidence`). Make `require_all_covered: true` the hard default with no override path unless explicitly documented in RunConfig with a reason field.

2. Add `priority: "high" | "medium" | "low"` to `RequirementRecord`. Add a new guard: "Early termination is blocked if any `RequirementRecord` with `priority: 'high'` has `coverage_status != 'covered'`, regardless of `coverage_confidence` and `require_all_covered` setting."

3. Add cancellation ordering rule: "QUEUED agents are cancelled in reverse dependency order (leaves first, closest to root last). The harness SHALL compute a topological sort of QUEUED agents and cancel from the leaf end. This ensures agents with no downstream dependents are cancelled first."

---

### C-09 — SEC Multi-Key Read Has No Snapshot Semantics

**Section affected:** §5, Primitive 12 (SEC)
**Reviewers:** Review 1 (GAP-01), Review 3 (Gap 1, Gap 2)

**Problem:**
A Planner that reads multiple SEC keys sequentially (`get("auth_strategy")`, then `get("data_model")`) has no snapshot isolation across those reads. Between the first and second `get`, another Planner can write to `auth_strategy` and increment its `version_id`. The reading Planner now holds a mixed-version snapshot. OCC will correctly reject the write, but under high contention this creates a starvation loop that `max_occ_retries` (default 2) escalates rather than resolves.

**Change required:**
Add a `snapshot_read(keys: string[])` method to `SECBackend` that returns a consistent multi-key snapshot with a single composite `version_vector`:

```typescript
interface SECBackend {
  get(key: string): SECEntry
  set(key: string, value: unknown, version_id: string): SECWriteResult
  snapshot_read(keys: string[]): SECSnapshot  // NEW
}

interface SECSnapshot {
  entries:        SECEntry[]   // all returned with their version_ids at the moment of the snapshot
  version_vector: Record<string, string>  // key → version_id
  snapshot_at:    string       // ISO 8601 timestamp
}
```

Add guidance: "Planners that read multiple logically-related SEC keys SHOULD use `snapshot_read` rather than sequential `get` calls. The `version_vector` from the snapshot is passed to subsequent writes for all keys in the snapshot — each key's write includes its individual `version_id` from the vector."

---

## P2 — Scalability, Observability, Testability Gaps

---

### C-10 — Meta Loop Pattern Store Has No Size Bound and Uses O(n) Scan

**Section affected:** §9 (Meta Loop), Primitive 16 (Execution Memory, pattern selection algorithm)
**Reviewers:** Review 1 (GAP-08)

**Problem:**
At node instantiation, the harness computes cosine similarity between the current scope embedding and *all stored* `SuccessfulPattern.embedding` vectors — a full sequential scan. No ANN index is specified, no store size limit exists, and no eviction policy is defined. ML-11 mentions no TTL or cap on the pattern store. After a year of production use, this scan becomes a critical-path bottleneck that multiplies across every node in every deep run.

**Change required:**
1. Add `max_pattern_store_size: number` (default: 10,000) and `pattern_store_eviction_policy: "lru" | "oldest_first"` to `RunConfig`.
2. Add: "When the pattern store exceeds `max_pattern_store_size`, eviction fires before the new pattern is written. Under `lru`, the least-recently-accessed pattern is evicted. Under `oldest_first`, the pattern with the earliest `created_at` is evicted."
3. Add: "Implementations SHOULD use an approximate nearest-neighbor (ANN) index (e.g., FAISS IVF-PQ, HNSW) when the pattern store exceeds `pattern_store_index_threshold` entries (default: 1,000, configurable in `RunConfig`). Exact cosine scan is acceptable below threshold."
4. Add `pattern_lookup_latency_ms` to the per-node Run metrics.

---

### C-11 — `feedback_loop` Index Drift Has No Detection Surface

**Section affected:** §5, Primitive 11 (Context Assembly), §12 (Non-Functional Requirements)
**Reviewers:** Review 1 (GAP-09), Review 2 (Gap 3), Review 3 (Gap 4)

**Problem:**
The `feedback_loop` is the only persistent, cross-run, slowly-mutating component in the system. The spec instructs operators to "audit weight distributions periodically" but never defines what metrics to audit, what thresholds constitute "significant" change, or where these metrics are emitted. The feedback_loop has no dedicated bus event type, no metric in run summaries, and no rollback mechanism.

**Change required:**
1. Add a `feedback_loop_health` object to the Run summary:
```typescript
interface FeedbackLoopHealth {
  mean_weight_deviation_from_base:  number   // average |weight - base_weight| across all tracked chunks
  chunks_at_floor:                  number   // count at base_weight × 0.5 clamp
  chunks_at_ceiling:                number   // count at base_weight × 2.0 clamp
  total_chunks_tracked:             number
  snapshot_id:                      string   // identifier for rollback
}
```
2. Add `feedback_loop_weight_distribution` as a named message bus event type, emitted at run completion and configurable interval.
3. Add `feedback_loop_snapshot_id: string | null` to `RunConfig`. When set, the harness loads feedback_loop weights from the named snapshot at run start rather than from the live index. This is the rollback mechanism.

---

### C-12 — `complexity_classification` Has No Calibration Path

**Section affected:** §16 (Constraints & Assumptions), §6.3 (RecursionGuard)
**Reviewers:** Review 1 (GAP-10)

**Problem:**
The entire RecursionGuard behavior depends on Router `complexity_classification` accuracy. The spec acknowledges this in §16 but provides no mechanism to validate, calibrate, or detect systematic misclassification. The `complexity_classification` eval dimension (weight 0.45 in the Router Contract) is judged without ground truth — misclassification in either direction is undetectable from run metrics.

**Change required:**
1. Add `complexity_classification_log` to the Meta Loop: after every COMPLETE run, record `{run_id, router_classification, actual_depth_reached, final_trace_eval_score, objective_embedding}`.
2. Add `classification_accuracy` as a Meta Loop calibration metric alongside false-negative-rate tracking.
3. Add `complexity_override_rules: ComplexityOverrideRule[] | null` to `RunConfig`:
```typescript
interface ComplexityOverrideRule {
  pattern:              string   // regex or embedding-cluster label matching objective text
  force_classification: "atomic" | "simple" | "moderate" | "complex"
  reason:               string
}
```
Document: "Override rules are applied before the RecursionGuard reads `complexity_classification`. This allows operators to hard-code classification for known objective patterns while the Router model calibrates."

---

### C-13 — Tool Layer Has No Reliability Contract

**Section affected:** §5, Primitive 8 (Tool)
**Reviewers:** Review 3 (Gap 9)

**Problem:**
Tools are defined minimally (`id`, `description`, `idempotent`). There are no SLA declarations, no input/output schema guarantees beyond what is enforced by the sandbox, no retry semantics at the tool level, and no side-effect classification. Tool variability becomes system instability because there is no per-tool contract the harness can enforce.

**Change required:**
Add the following to the Tool primitive interface:

```typescript
interface Tool {
  id:                    string
  description:           string
  idempotent:            boolean
  input_schema:          string | null   // JSON Schema; harness validates before execution
  output_schema:         string | null   // JSON Schema; harness validates after execution
  latency_sla_ms:        number | null   // null = inherit run-level agent SLA
  side_effect_class:     "read_only" | "write_once" | "write_repeatable" | "destructive"
  retry_on_error:        boolean         // default false; true = harness retries once before tool_failure
}
```

Add: "The harness SHALL validate tool inputs against `input_schema` before execution and tool outputs against `output_schema` after execution. Schema violations are classified as `tool_failure`. `side_effect_class: 'destructive'` tools are NOT retried regardless of `retry_on_error`."

---

### C-14 — Blob Store Has No Lifecycle or Quota Model

**Section affected:** §5, Primitive 15 (Context Compressor / Blob Store)
**Reviewers:** Review 3 (Gap 10)

**Problem:**
The blob store retains all content for "the duration of the Run" but has no eviction policy, no per-run size quota, and no cost or access latency guarantees. In multi-run deployments with large structured payloads, blob store accumulation is unbounded.

**Change required:**
Add to `RunConfig`:
```typescript
interface BlobStorePolicy {
  max_run_bytes:       number | null   // null = no limit; hard limit per run
  eviction_policy:     "run_complete" | "ttl" | "lru"
  ttl_seconds:         number | null   // used when eviction_policy: "ttl"
  on_quota_exceeded:   "reject_write" | "evict_lru"
}
```
Add: "When `on_quota_exceeded: 'reject_write'` fires, the write attempt is classified as `blob_write_failure` (per C-04). When `on_quota_exceeded: 'evict_lru'`, the least-recently-read blob for that run is evicted before the new write."

---

### C-15 — Run-Level SLA Has No Enforcement Mechanism

**Section affected:** §12 (Non-Functional Requirements), `latency_sla_policy`
**Reviewers:** Review 3 (Gap 14)

**Problem:**
`latency_sla_policy` defines per-agent-type SLAs in milliseconds, but there is no run-level wall-clock SLA. A run can satisfy all per-agent SLAs while taking an arbitrarily long total time due to re-decompose cycles, HITL waits, or OCC retry loops. There is no operator knob to bound overall run duration.

**Change required:**
Add `run_wall_clock_sla_ms: number | null` to `RunConfig` (null = unbounded). Add: "When `run_wall_clock_sla_ms` is set and the run has been executing for longer than the configured value, the kill switch fires with `condition: 'time_exceeded'`. This field is independent of per-agent `latency_sla_policy` — both apply when both are set."

---

### C-16 — Kill Switch Has No Graceful Partial Output Path

**Section affected:** §6.6 (Kill Switch)
**Reviewers:** Review 3 (Gap 15)

**Problem:**
The kill switch supports only `abort_run` or `escalate_run`. Both discard all partial work. In production, a run that completes 8 of 10 requirements before hitting a cost trigger has produced real value that is destroyed by a hard abort.

**Change required:**
Add `"finalize_partial"` to the `KillSwitchTrigger.action` union:

```typescript
interface KillSwitchTrigger {
  condition: "cost_exceeded" | "time_exceeded" | "loop_detected"
  threshold: number
  action:    "abort_run" | "escalate_run" | "finalize_partial"  // NEW
}
```

Document: "`finalize_partial` behavior: (1) All `QUEUED` and `RETRYING` agents are cancelled. (2) All `GENERATING` agents receive a cancellation signal and have `partial_output_timeout_ms` (default: 5,000, configurable in `RunConfig`) to produce output before forced cancellation. (3) The harness runs CONTEXT COMPRESSOR and TRACE EVAL on whatever `COMPLETE` nodes exist. (4) The Run reaches `PARTIAL_COMPLETE` state. (5) RequirementMap coverage at termination is logged."

---

## P3 — Deferred to v6 (Tracked, Not Actioned in v5.1)

These items appeared across reviews but require architectural changes that are out of scope for v5.1. They are recorded here so they are not lost.

| ID | Item | Source |
|---|---|---|
| D-01 | Global Objective State (GOS) — typed, queryable, cross-agent state replacing SEC | v5.0 §2, Review 3 (Gap 1) |
| D-02 | Cross-key SEC semantic conflict detection — per-key OCC is correct but cannot detect logically incompatible values across keys | v5.0 §2, Review 1 (GAP-01), Review 3 |
| D-03 | Dual-eval / shadow judge mode — secondary validation path when primary judge confidence is low | Review 2 (Gap 5), Review 3 (Gap 5) |
| D-04 | Strategy auto-selection policy — Meta Loop learns which strategies succeed per objective cluster | Review 3 (Gap 8) |
| D-05 | Exploration vs. exploitation balance in execution memory — prevent premature convergence on past patterns | Review 3 (Gap 11) |
| D-06 | Per-tool circuit breakers and rate limiters — backpressure on external dependencies | Review 3 (Gap 12) |
| D-07 | Semantic plan validation — lightweight LLM or heuristic check that a structurally valid plan is also logically correct | Review 3 (Gap 13) |
| D-08 | Session Volume in SandboxConfig — shared writable workspace persisting across a single Executor's tool-call sequence | Review 2 (Gap 1) |
| D-09 | Normalizer fidelity scoring — normalizer emits confidence score; Judge receives both raw and normalized when confidence is low | Review 2 (Gap 4) |
| D-10 | Multi-label failure classification — failures are multi-causal; probabilistic or judge-assisted classification | Review 3 (Gap 6) |

---

## Change Summary

| ID | Priority | Section | Description |
|---|---|---|---|
| C-01 | P0 | §7.2 | Fix strategy weight semantics: absolute override, not delta |
| C-02 | P0 | §14 | Add `RequirementMap` / `RequirementRecord` interfaces |
| C-03 | P0 | §5 P12 | Define `merge` object-key conflict algorithm |
| C-04 | P1 | §5 P15/P18 | Add `blob_write_failure` type + retry path |
| C-05 | P1 | §5 P16/§14 | Add `embedder` role to `ModelPolicy`; tag stored vectors |
| C-06 | P1 | §5 P13 | Add `fallback_payload` to `OutputContract` for degraded mode |
| C-07 | P1 | §5 P19 | Define normalizer behavior for `text` and `code` types |
| C-08 | P1 | §6.5 | Requirement priority gate + cancellation ordering for early termination |
| C-09 | P1 | §5 P12 | Add `snapshot_read` to SEC for multi-key snapshot isolation |
| C-10 | P2 | §9/P16 | Pattern store size bounds + ANN index threshold |
| C-11 | P2 | §5 P11 | `feedback_loop` health metrics + rollback mechanism |
| C-12 | P2 | §16/§6.3 | `complexity_classification` calibration log + override rules |
| C-13 | P2 | §5 P8 | Tool reliability contract fields |
| C-14 | P2 | §5 P15 | Blob store quota + lifecycle policy |
| C-15 | P2 | §12 | Run-level wall-clock SLA |
| C-16 | P2 | §6.6 | Kill switch `finalize_partial` action |
