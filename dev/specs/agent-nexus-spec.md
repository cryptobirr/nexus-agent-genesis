# Agent Nexus — Implementation Specification
**Version:** 3.0.0
**Created:** 2026-03-21T00:00:00Z
**Updated:** 2026-03-21T00:00:00Z
**Source PRD:** agent-nexus-prd.docx (v1.0)
**Reference harness:** `/Users/mekonen/Developer/agents/long-running-harness/`

---

## 1. Executive Summary

Agent Nexus is a hierarchical, self-correcting multi-agent execution framework. It accepts a single objective, decomposes it through four nested layers (Executive → Program → Project → Task), evaluates every output against a Definition of Done, retries with gap-injection on failure, and files a structured ticket on unresolved failures.

It ships as a **global CLI tool** (`nexus`) modeled exactly on the kodi pattern:

- `nexus.py` — thin entry point: auto-detect `.git` root → `os.execv` into `supervisor.py`
- `supervisor.py` — runs the 4-layer hierarchy using the Claude Agent SDK
- Installed globally via symlink: `/usr/local/bin/nexus → .../nexus.py`

**Stack:** Python (matching kodi). Claude Agent SDK for all inference calls. No separate web server, no React UI in v1 — stdout/log output only, matching kodi's terminal-first approach.

---

## 2. How Simple This Actually Is

The entire harness is ~3 files of Python:

```
nexus/
├── nexus.py          ~80 lines   Entry point (kodi-lite.py pattern exactly)
├── supervisor.py     ~300 lines  The 4-layer execution loop
├── agents/
│   ├── executive.md              System prompt for CEO Agent
│   ├── program.md                System prompt for Program Director
│   ├── project.md                System prompt for Project Manager
│   └── task.md                   System prompt for Task Agent
└── dod/
    ├── executive.md              DoD criteria for Executive layer
    ├── program.md                DoD criteria for Program layer
    ├── project.md                DoD criteria for Project layer
    └── task.md                   DoD criteria for Task layer
```

That's it. No services layer, no components layer, no TypeScript, no Vite. The Claude Agent SDK handles all the inference complexity. The supervisor is a Python loop.

---

## 3. Architecture

### Entry Point (`nexus.py`) — kodi-lite.py verbatim pattern

```python
#!/usr/bin/env python3
"""
nexus - Hierarchical multi-agent execution framework

Auto-detects project context and runs the 4-layer agent hierarchy.

Usage:
    cd /path/to/project
    nexus "build a login page"
    nexus "build a login page" --retry-limit 3
    nexus --objective-file objective.md
    nexus --dry-run         # Print detected context, no inference
"""

def find_project_root() -> Path:
    # Walk up from cwd to find .git/ — identical to kodi-lite.py

def get_git_context(project_root: Path) -> dict:
    # repo name, branch, last 10 commits, README excerpt (500 chars)

def main():
    project_root = find_project_root()
    git_context  = get_git_context(project_root)
    # os.execv into supervisor.py using harness venv
    # Forward: --project-root, --git-context (JSON), + user args
```

**Git context injected into Executive Agent prompt:**
```
GIT CONTEXT:
  Repo:   nexus-agent/genesis
  Branch: main
  Recent commits:
    - feat: add DoD evaluation loop
    - fix: retry counter off-by-one
  README: Agent Nexus is a hierarchical...
```

**CLI flags:**

| Flag | Default | Description |
|------|---------|-------------|
| `objective` (positional) | — | The objective to run |
| `--objective-file PATH` | — | Read objective from file |
| `--retry-limit N` | `2` | Max retries per agent (3 total attempts) |
| `--provider` | `memory` | Ticket provider: `memory`, `github`, `jira`, `linear`, `webhook` |
| `--dry-run` | false | Print detected context + objective, no inference |
| `--verbose` | false | Debug logging |

**Installation (identical to kodi):**
```bash
sudo ln -sf /path/to/nexus/nexus.py /usr/local/bin/nexus
chmod +x /path/to/nexus/nexus.py
```

---

### Supervisor (`supervisor.py`) — the actual work

The supervisor runs the four-layer pipeline. Each layer follows the same pattern: **run agent → evaluate DoD → retry if failed → file ticket if exhausted → pass output to next layer**.

```python
async def run_executive(objective: str, git_context: dict, config: Config) -> ExecutiveOutput:
    """Run CEO Agent. Returns program briefs."""

async def run_program(program_brief: ProgramBrief, config: Config) -> ProgramOutput:
    """Run Program Director. Returns project scopes."""

async def run_project(project_scope: ProjectScope, config: Config) -> ProjectOutput:
    """Run Project Manager. Returns task specs."""

async def run_task(task_spec: TaskSpec, config: Config) -> TaskOutput:
    """Run Task Agent. Returns work product."""

async def evaluate_dod(layer: str, input_brief: str, output: str, config: Config) -> DoDResult:
    """Separate inference call: evaluate output against layer DoD criteria."""

async def retry_with_gaps(run_fn, dod_fn, input_brief: str, config: Config) -> tuple[Any, DoDResult]:
    """
    Run → evaluate → inject gaps → retry → escalate.
    Returns (best_output, final_dod_result).
    """

async def run_hierarchy(objective: str, git_context: dict, config: Config) -> RunResult:
    """
    Top-level: run executive → fan out programs in parallel →
    fan out projects in parallel → fan out tasks in parallel.
    """
```

**Execution flow:**
```
objective
  └─ run_executive (+ retry loop)
       └─ for each program (concurrent via asyncio.gather):
            run_program (+ retry loop)
              └─ for each project (concurrent via asyncio.gather):
                   run_project (+ retry loop)
                     └─ for each task (concurrent via asyncio.gather):
                          run_task (+ retry loop)
```

**Retry loop (identical across all layers):**
```python
async def retry_with_gaps(run_fn, evaluate_fn, input_brief, config):
    for attempt in range(config.retry_limit + 1):
        output = await run_fn(input_brief)
        dod    = await evaluate_fn(input_brief, output)

        if dod.passed:
            log_pass(layer, attempt, dod.score)
            return output, dod

        log_fail(layer, attempt, dod.score, dod.gaps)
        await file_ticket(dod, attempt, config)

        if attempt < config.retry_limit:
            input_brief = inject_gaps(input_brief, dod.gaps, attempt + 1)

    log_escalation(layer)
    return output, dod  # best available output, execution continues
```

---

### Agent Definitions (`agents/*.md`)

Each agent is a markdown file read by the supervisor and passed as system prompt to the Claude Agent SDK. Same pattern as `~/.claude/agents/github-issue-closer.md` in kodi.

**`agents/executive.md`** (excerpt):
```markdown
You are the CEO Agent in the Agent Nexus framework.

Your role: Receive an objective and decompose it into 2–3 strategic Programs.

RULES:
- Each Program must represent a non-overlapping strategic domain
- Each Program needs: id, title, objective (1-2 sentences), priority, 2+ success criteria
- Include a one-sentence strategic summary
- Do NOT produce Project or Task level details

OUTPUT: Return valid JSON matching the ExecutiveOutput schema exactly.
```

**`dod/executive.md`** (DoD criteria loaded by `evaluate_dod`):
```markdown
1. At least 2 distinct programs covering non-overlapping strategic domains
2. Each program has a clear objective that advances the overall goal
3. Each program has at least 2 concrete, measurable success criteria
4. Strategic summary is directional and specific (not generic)
5. Programs collectively cover the full scope with no critical gaps
```

---

### Ticket Providers

Simple registry dict. Adding a provider = add a class to `providers.py`.

```python
class TicketProvider(Protocol):
    def create(self, config: dict, ticket: TicketPayload) -> IssuedTicket: ...

PROVIDERS = {
    'memory':  InMemoryProvider,   # default, no config
    'github':  GitHubProvider,     # NEXUS_GITHUB_TOKEN + owner/repo
    'jira':    JiraProvider,       # domain, email, NEXUS_JIRA_TOKEN, projectKey
    'linear':  LinearProvider,     # NEXUS_LINEAR_KEY, teamId
    'webhook': WebhookProvider,    # endpoint URL, optional auth header
}
```

---

## 4. Data Models

```python
from dataclasses import dataclass, field
from typing import Literal

AgentStatus = Literal['QUEUED', 'GENERATING', 'EVALUATING', 'RETRYING', 'COMPLETE', 'ESCALATED', 'ERROR']
AgentLayer  = Literal['executive', 'program', 'project', 'task']

@dataclass
class DoDResult:
    passed:             bool
    score:              int          # 0–100
    gaps:               list[str]
    severity:           Literal['critical', 'major', 'minor']
    ticket_title:       str
    ticket_description: str

@dataclass
class AgentNode:
    id:           str
    layer:        AgentLayer
    label:        str
    status:       AgentStatus
    input_brief:  str
    output:       str        = ''
    dod_result:   DoDResult  = None
    attempt_count:int        = 0
    tickets:      list       = field(default_factory=list)
    children:     list       = field(default_factory=list)

@dataclass
class TicketPayload:
    title:         str
    description:   str
    gaps:          list[str]
    severity:      str
    agent_layer:   AgentLayer
    agent_label:   str
    node_id:       str
    attempt_number:int
    dod_score:     int
    created_at:    str       # ISO-8601
```

---

## 5. Layer Output Schemas

```python
# Executive output (EX-02, EX-03)
@dataclass
class ProgramBrief:
    id:               str
    title:            str
    objective:        str            # 1–2 sentences
    priority:         Literal['high', 'medium', 'low']
    success_criteria: list[str]      # min 2

@dataclass
class ExecutiveOutput:
    strategic_summary: str
    programs:          list[ProgramBrief]  # 2–3

# Program output (PR-04, PR-05)
@dataclass
class ProjectScope:
    id:          str
    title:       str
    scope:       str             # 1–2 sentences
    deliverables:list[str]       # min 2

@dataclass
class ProgramOutput:
    projects: list[ProjectScope]  # 2–3

# Project output (PJ-03 through PJ-06)
TaskType = Literal['research', 'design', 'build', 'write', 'analyze', 'test']

@dataclass
class TaskSpec:
    id:           str
    title:        str
    instructions: str            # precise + actionable
    type:         TaskType

@dataclass
class ProjectOutput:
    tasks: list[TaskSpec]         # 3–4

# Task output (TA-03)
@dataclass
class TaskOutput:
    completion_status: Literal['complete', 'partial', 'failed']
    summary:           str        # one sentence
    work_product:      str        # min 3 sentences, concrete
```

---

## 6. DoD Criteria (Baseline — Configurable)

Stored in `dod/*.md` files, loaded at runtime. Changing criteria = edit the file, takes effect next run.

### Executive
1. At least 2 distinct programs covering non-overlapping strategic domains
2. Each program has a clear objective that advances the overall goal
3. Each program has at least 2 concrete, measurable success criteria
4. Strategic summary is directional and specific (not generic)
5. Programs collectively cover the full scope with no critical gaps

### Program
1. 2+ projects covering the full program scope
2. Each project has a distinct, non-overlapping scope
3. Each project has at least 2 concrete deliverables
4. Project scopes are independently completable units of work
5. All program success criteria traceable to at least one project

### Project
1. 3+ atomic tasks decomposed from the project scope
2. Each task independently executable by a single agent
3. Task descriptions are unambiguous with actionable instructions
4. All deliverables mapped to at least one task; no duplicate tasks

### Task
1. Output is specific and substantive — not generic or placeholder
2. Output directly addresses task instructions
3. Summary accurately describes what was produced
4. Output contains concrete details, names, numbers
5. Output is at least 3 sentences of real, usable work product

### DoD Evaluator Prompt

```
You are a strict DoD evaluator for the {layer} layer of Agent Nexus.

INPUT BRIEF:
{input_brief}

AGENT OUTPUT:
{agent_output}

DOD CRITERIA:
{dod_criteria}

Return JSON only:
{
  "passed": bool,
  "score": int (0-100),
  "gaps": [str, ...],
  "severity": "critical"|"major"|"minor",
  "ticket_title": str,
  "ticket_description": str
}

Be strict. Generic or vague output fails even if syntactically valid.
passed is authoritative — a score of 100 does not guarantee a pass.
```

### Gap Injection Template

```
RETRY {n} — You MUST address these DoD gaps before responding:

{gaps as numbered list}

Your previous response scored {score}/100 (severity: {severity}).
Address every gap listed above.
---
{original input brief}
```

---

## 7. Stdout Output (Terminal-First, No UI in v1)

Supervisor prints a structured log to stdout using chalk-equivalent color output (Python `colorama` or ANSI codes directly). Matches kodi's terminal style.

```
================================================================================
 NEXUS  Running: "build a login page"
 Repo:  nexus-agent/genesis  |  Branch: main
================================================================================

[EXECUTIVE] CEO Agent generating...
[EXECUTIVE] DoD evaluation... PASS (score: 87)
  Programs: 3 identified

  [PROGRAM] "Frontend Implementation" generating...
  [PROGRAM] DoD evaluation... PASS (score: 91)

    [PROJECT] "Auth UI Components" generating...
    [PROJECT] DoD evaluation... FAIL (score: 54, severity: major)
      Gaps:
        1. Task descriptions are not specific enough
        2. Missing deliverable for error state handling
    [PROJECT] RETRY 1 — injecting gaps...
    [PROJECT] DoD evaluation... PASS (score: 82)
      Ticket filed: #memory-001

      [TASK] "Build LoginForm component" generating...
      [TASK] DoD evaluation... PASS (score: 94)
        ✓ Work product: 4 sentences, concrete implementation details

...

================================================================================
 COMPLETE  3 programs  |  7 projects  |  22 tasks  |  2 tickets filed
 Duration: 4m 32s
================================================================================
```

**Output file:** Supervisor writes a JSON run report to `.nexus/runs/<timestamp>.json` in the project root on completion.

---

## 8. Delivery Plan

### Sprint 1 — Working Pipeline (Mock Inference)
**Goal:** Full 4-layer pipeline runs end-to-end with a mock LLM. Proves the orchestration logic.

- `nexus.py` — entry point, git detection, `os.execv`
- `supervisor.py` — full pipeline: executive → programs → projects → tasks
- `retry_with_gaps()` — retry loop with gap injection
- `evaluate_dod()` — DoD evaluation call
- `ticket_router.py` — InMemory provider only
- `agents/*.md` and `dod/*.md` — all 4 system prompts + DoD criteria
- Mock AgentRunner that returns deterministic valid JSON

**Sprint 1 milestone:** `python supervisor.py --project-root . --objective "build X"` (with mock runner) prints full tree to stdout, files 0 real tickets.

**Tests:** Unit tests for `retry_with_gaps`, `evaluate_dod`, `ticket_router`. Fixture-based — no real inference, no network.

### Sprint 2 — Real Inference + CLI Install
**Goal:** Real Claude calls. Globally installed `nexus` command. External ticket providers.

- Wire `ANTHROPIC_API_KEY` into `AgentRunner`
- Install: `sudo ln -sf .../nexus.py /usr/local/bin/nexus`
- Add `GitHub`, `Jira`, `Linear`, `Webhook` providers to `providers.py`
- Integration test: `nexus "build a login page"` in a real git repo produces structured output

**Sprint 2 milestone:** `cd some-project && nexus "add a search feature"` runs fully autonomously, prints live log, writes `.nexus/runs/<ts>.json`.

**Tests:**
- E2E: spawn `nexus` binary against a fixture git repo, assert run report structure
- Integration (opt-in, requires `ANTHROPIC_API_KEY`): one full real run, verify structural output

---

## 9. File Structure

```
nexus/
├── nexus.py              Entry point — git detection, os.execv
├── supervisor.py         4-layer execution loop
├── providers.py          InMemory + GitHub + Jira + Linear + Webhook
├── models.py             Dataclasses: DoDResult, AgentNode, TicketPayload, etc.
├── agents/
│   ├── executive.md      CEO Agent system prompt
│   ├── program.md        Program Director system prompt
│   ├── project.md        Project Manager system prompt
│   └── task.md           Task Agent system prompt
├── dod/
│   ├── executive.md      Executive DoD criteria
│   ├── program.md        Program DoD criteria
│   ├── project.md        Project DoD criteria
│   └── task.md           Task DoD criteria
├── dev/
│   └── testing/
│       ├── fixtures/     Fixture git repos for E2E tests
│       ├── test_retry.py
│       ├── test_dod.py
│       └── test_e2e.py
├── requirements.txt      claude-agent-sdk, colorama, pydantic
└── README.md
```

**Installation:**
```bash
cd nexus
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
sudo ln -sf $(pwd)/nexus.py /usr/local/bin/nexus
chmod +x nexus.py
```

---

## 10. What Was Cut vs v1/v2 Spec (and Why)

| Cut | Reason |
|-----|--------|
| TypeScript / Node.js | Python matches the existing harness. No reason to switch stacks. |
| React web UI | kodi is terminal-first. A web UI is a v2 feature, not v1. |
| SSE / HTTP server | Not needed without a UI. Run report JSON file is sufficient. |
| 5-layer component architecture | Overkill for ~3 Python files. |
| `AgentNodeStore` class | Just a dict in the supervisor, no class needed. |
| `MessageBus`, `EventEmitter` classes | Python `asyncio` events + direct stdout logging is sufficient. |
| `ProviderRegistry` class | A dict `PROVIDERS = { 'memory': InMemoryProvider, ... }` is sufficient. |
| Sprint 3–5 | Collapsed into Sprint 1–2. The domain is simple enough. |

**What stays from the PRD (nothing cut from requirements):**
- All 4 layers ✅
- DoD evaluation loop ✅
- Retry with gap injection ✅
- Ticket filing on DoD failure (every attempt) ✅
- State machine (QUEUED → GENERATING → EVALUATING → RETRYING → COMPLETE/ESCALATED) ✅
- Configurable: retry limit, DoD criteria, ticket provider ✅
- Non-blocking escalation (tree continues with best output) ✅
- Full audit log (JSON run report) ✅

---

*Agent Nexus Implementation Spec — v3.0.0 — 2026-03-21T00:00:00Z*
