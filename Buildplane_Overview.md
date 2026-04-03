# Buildplane: Full Technical & Strategic Overview

**The control plane for autonomous software execution.**

*Operator-first autonomy for serious builders.*

By SollanSystems | March 2026

---

## What Buildplane Is

Buildplane is a deterministic execution kernel for autonomous software work. It treats language models as bounded workers inside a structured control plane that owns scheduling, state, policy enforcement, verification, and recovery. Instead of relying on a single long-running chat session where the model decides everything, Buildplane dispatches typed units of work in isolated contexts, captures evidence for every meaningful action, and advances only when reality matches the contract.

The core insight: the model is a worker, not the system. The system is the kernel.

This puts Buildplane in a different category from tools like ForgeCode, Claude Code, Cursor, or Aider — which are interactive coding assistants where the model is the pilot. Buildplane is the infrastructure layer those tools could run on when they need to execute multi-step, unattended, verifiable autonomous work.

---

## Architecture

Buildplane is a TypeScript monorepo built on a port-adapter pattern with strict package boundaries. The architecture has six layers, each in its own package with explicit dependency contracts.

### Package Map

```
@buildplane/kernel          Core types, orchestrator, event bus, packet parsing
    ↓
@buildplane/runtime         Command execution (spawnSync), session lifecycle
@buildplane/storage         SQLite state, filesystem evidence, event store
@buildplane/policy          Verification contracts, run evaluation
@buildplane/adapters-models AI SDK streaming, provider abstraction
@buildplane/adapters-tools  Tool execution adapter (planned)
@buildplane/adapters-git    Git integration adapter (planned)
@buildplane/compat-gsd      Migration bridge from .gsd/ format
@buildplane/ui-tui          React/Ink terminal interface
    ↓
buildplane (apps/cli)       User-facing command surface
```

### Data Flow

```
Unit Packet (JSON)
    │
    ▼
Kernel: Orchestrator
    ├── Creates Run (UUID, status: pending)
    ├── Emits: run-created
    ├── Marks Running
    ├── Emits: run-started
    │
    ▼
Runtime: Executor
    ├── Spawns command OR streams model
    ├── Emits: execution-started
    ├── Emits: model-token-delta (streaming)
    ├── Emits: tool-call-started / tool-call-completed
    ├── Returns: ExecutionReceipt
    │
    ▼
Storage: Evidence
    ├── Persists stdout/stderr logs
    ├── Records output existence checks
    ├── Emits: evidence-recorded
    │
    ▼
Policy: Evaluator
    ├── Checks exit code, required outputs
    ├── Returns: advance-run OR reject-run
    ├── Emits: policy-decision
    │
    ▼
Kernel: Completion
    ├── Marks Run passed/failed
    ├── Emits: run-completed
    └── Full event stream persisted to SQLite
```

---

## The Kernel

The kernel is the heart of Buildplane — the deterministic state machine that orchestrates everything. It defines the core types, owns the run lifecycle, and enforces the contract between work units and their execution.

### Core Types

**Unit** — an atomic, immutable piece of work:

- `id`: unique identifier
- `kind`: "command" or "model"
- `scope`: "task" or "step"
- `inputRefs`: dependencies on other units' outputs
- `expectedOutputs`: what this unit must produce
- `verificationContract`: how to check success
- `policyProfile`: which policy rules apply

**UnitPacket** — the full execution specification:

- `unit`: the work definition
- `execution`: command + args (for command units), OR
- `model`: provider + model + prompt (for model units)
- `verification`: required outputs list

The packet enforces an XOR constraint: a unit is either a command execution or a model execution, never both.

**Run** — the lifecycle state of a unit execution:

- `id`: unique run identifier
- `unitId`: which unit this executes
- `status`: pending → running → passed | failed | cancelled

**ExecutionEvent** — a discriminated union of 14 typed events that form the complete audit trail:

- `run-created`, `run-started`, `run-completed`
- `execution-started`
- `command-execution-complete`
- `model-token-delta`, `model-response-complete`
- `tool-call-started`, `tool-call-completed`
- `evidence-recorded`
- `policy-decision`
- `execution-error`

### Port Definitions

The kernel defines three abstract ports. Each is an interface that external packages implement:

- **StoragePort** — persistence operations (create run, record evidence, complete run)
- **RuntimePort** — execution (sync command execution, async model streaming)
- **PolicyPort** — verification (evaluate receipt against contract, return approve/reject)

This means every external dependency is swappable. You could replace SQLite storage with Postgres, swap the command executor for a Docker sandbox, or plug in a custom policy engine — without touching the kernel.

### Event Bus

A simple, synchronous pub/sub system. `createEventBus()` returns an emitter that broadcasts typed events to all subscribers. Storage subscribes to persist every event. The TUI subscribes to render state. The CLI subscribes to track completion. Multiple listeners can coexist without interference.

---

## Storage

Storage is split into structured state (SQLite) and filesystem artifacts, organized under a `.buildplane/` directory at the project root.

### Project Layout

```
.buildplane/
├── state.db          SQLite database (runs, events, decisions, evidence)
├── project.json      Project metadata
├── artifacts/        Output files produced by units
├── evidence/         Execution receipts, verification results
├── runs/             Per-run directories
│   └── <run-id>/
│       ├── stdout.log
│       └── stderr.log
└── logs/             System logs
```

### Database Schema

The SQLite database has two conceptual layers:

**Event log** (append-only, immutable) — every typed event with ID, kind, timestamp, and JSON payload. This is the source of truth. The full history of any run can be reconstructed from events alone.

**Projection tables** (mutable, derived) — fast-lookup tables for units, runs, evidence, decisions, and artifacts. These are convenience views that could be rebuilt from the event log at any time.

### Key Operations

- `initializeProject()` — creates directory structure, SQLite schema, project metadata
- `createRun()` — inserts run record, generates UUID
- `recordExecutionEvidence()` — writes stdout/stderr to filesystem, records output checks in database
- `recordDecision()` — persists policy verdict with reasons
- `completeRun()` — finalizes status, timestamps
- `EventStore.persistEvent()` — appends typed event to immutable log
- `EventStore.getEventsByRunId()` — replays event stream for inspection

The separation of events (immutable) from projections (mutable) is what makes replay and inspection possible. You can always go back to the event stream and reconstruct exactly what happened.

---

## Runtime

The runtime executes work units and returns structured receipts.

### Command Execution

For command-type units, the runtime uses Node.js `spawnSync` to execute the specified command with arguments in the project root directory. It captures stdout, stderr, exit code, and timestamps, then checks whether each expected output file exists.

The result is an `ExecutionReceipt`:

- `command`, `args`, `cwd`
- `startedAt`, `completedAt` (ISO timestamps)
- `exitCode`
- `stdout`, `stderr`
- `outputChecks` (path + exists boolean for each expected output)

### Model Execution

For model-type units, the `adapters-models` package uses the Vercel AI SDK to stream responses from LLM providers (currently Anthropic). During streaming, it emits typed events for each token delta, tool call, and response completion. The final model output is captured as the receipt's stdout.

The model adapter supports provider resolution (defaulting to Anthropic's Claude), system prompts, and stream iteration with event emission. Tool calls are streamed and captured in the event log, though tool execution itself is not yet wired to a real tool adapter.

---

## Policy

Policy is the verification layer — the gate that decides whether a run's output meets the contract.

### Current Implementation

Today, the policy evaluator checks two things:

1. **Exit code** — did the command return 0?
2. **Required outputs** — do all expected output files exist?

If both pass, the run is approved. If either fails, the run is rejected with specific reasons (e.g., "command exited with code 1" or "required output missing: tmp/out.txt").

The evaluator returns a typed `PolicyDecision`:

- `kind`: "advance-run" or "reject-run"
- `outcome`: "approved" or "rejected"
- `reasons`: array of human-readable explanations

### Planned Capabilities

The architecture is designed for much richer policy enforcement:

- **Budget constraints** — token limits, compute time caps, cost ceilings
- **Trust gates** — operator approval required before advancing past certain thresholds
- **Retry logic** — automatic retry with backoff for transient failures
- **Conditional checks** — policy profiles that apply different rules to different unit types
- **Stop rules** — hard limits that kill a run if exceeded

The `policyProfile` field on every unit and the `scheduling_rule` pattern in the kernel are the extension points for this work.

---

## CLI

The command-line interface provides six commands for the full operator workflow.

### Commands

**`buildplane init`** — Initialize a project. Creates the `.buildplane/` directory structure, SQLite database, and project metadata.

**`buildplane run --packet <path>`** — Execute a single unit packet. Loads and parses the JSON packet, wires the orchestrator with all adapters, runs the unit, captures all events, and exits with code 0 (passed) or 1 (failed). Supports `--tui` for terminal visualization and `--json` for machine-readable output.

**`buildplane status`** — Check project state. Shows initialization status, latest run, and run count histogram. Supports `--json`.

**`buildplane inspect <run-id>`** — Deep inspection of a specific run. Shows unit definition, run metadata, execution evidence, policy decisions, artifacts, and the full event stream. Shows model responses, tool calls, and policy reasoning. Supports `--json`.

**`buildplane history`** — List all runs with ID, unit, status, and timestamps. Formatted table or JSON.

**`buildplane replay <run-id>`** — Re-execute a previous run. Loads the packet snapshot from storage and creates a new run. Supports `--model=provider/model-name` to override the model and `--policy=profile` to override the policy.

### Error Handling

The CLI classifies errors into four categories:

- `NOT_INITIALIZED` — no `.buildplane/` directory found
- `NOT_FOUND` — requested run or unit doesn't exist
- `INVALID_PACKET` — JSON parse or validation failure
- `CLI_ERROR` — generic fallback

Each error produces a clear message with the classification code.

---

## Terminal UI

The `ui-tui` package provides a React/Ink-based terminal interface for real-time run observation.

### Architecture

The TUI subscribes to the event bus and reduces events into visual state through a `useRunState` hook. The state tracks:

- **Phase**: idle → pending → running → executing → evidence → policy → completed/failed
- **Model output**: streaming text accumulated from token deltas
- **Tool calls**: in-progress and completed, with status indicators
- **Evidence count**: number of evidence items recorded
- **Policy outcome**: approved/rejected with reasons
- **Errors**: any execution errors

### Layout

```
┌─ Buildplane — unit-id ───────────────────────────┐
├── Model Output ──────────────────────────────────┤
│ [streaming model response text...]                │
├── Tool Calls ────────────────────────────────────┤
│   ⟳ shell_exec (running)                         │
│   ✓ web_search (completed)                        │
├──────────────────────────────────────────────────┤
│ ▶ Running │ Evidence: 3 │ Policy: approved        │
└──────────────────────────────────────────────────┘
```

Phase indicators are color-coded. The TUI auto-exits when the run completes.

---

## Implementation Status

| Component | Status | Detail |
|-----------|--------|--------|
| Kernel (types, orchestrator, event bus) | Complete | 14 event types, port-adapter pattern, packet validation |
| Storage (SQLite, events, filesystem) | Complete | Append-only event log, projection tables, file-based evidence |
| Runtime (command execution) | Complete | spawnSync with receipt capture |
| CLI (all 6 commands) | Complete | init, run, status, inspect, history, replay |
| UI-TUI (event-driven rendering) | Complete | React/Ink, streaming display, phase tracking |
| Model adapter (AI SDK streaming) | Partial | Token streaming works; tool execution is mocked |
| Policy (verification) | Minimal | Exit code + output check only; no budgets/gates/retries |
| Tool adapter | Not started | Empty stub |
| Git adapter | Not started | Empty stub |
| GSD compat bridge | Not started | Empty stub |
| Multi-unit orchestration | Not started | inputRefs field exists but no scheduler |
| Concurrency | Not started | Sequential single-unit only |

---

## Competitive Landscape

Buildplane occupies a unique position in the AI coding tools market. It is not a coding assistant — it is the runtime layer that coding assistants lack.

### What Exists Today

**Interactive coding agents** (ForgeCode, Claude Code, Cursor, Aider, Copilot CLI) — these are developer-facing tools where the model is the pilot. The developer talks to the agent, reviews suggestions, and approves changes. No structured evidence trail, no policy enforcement, no replay capability.

**Autonomous coding platforms** (OpenHands, Devin, SWE-agent) — these dispatch longer-running autonomous tasks. OpenHands has an event-sourced architecture with Docker-sandboxed execution, but no policy gates or verification contracts. Devin is proprietary and opaque.

**General workflow engines** (Temporal, Inngest) — durable execution with retries, replay, and crash recovery. Temporal now has an OpenAI Agents SDK integration. But these are general-purpose — they don't understand coding-specific concepts like verification contracts, evidence capture, or model budget enforcement.

**Agent security/governance** (NVIDIA OpenShell, Microsoft Agent Governance Toolkit) — these handle sandboxing and audit compliance, but they're security overlays, not execution kernels. They don't schedule work, manage state, or orchestrate multi-step tasks.

**Proprietary internal platforms** (Praetorian's 39-agent system) — Praetorian built a deterministic AI orchestration platform with the same philosophy as Buildplane (model as worker, deterministic runtime owns control). But it's proprietary, enterprise-only, and purpose-built for their security product.

### Buildplane's Position

Nobody has shipped an open-source, terminal-native, lightweight execution kernel that combines:

1. Typed work units with input/output contracts
2. Deterministic orchestration (model as worker, not pilot)
3. Evidence capture for every action
4. Policy gates with verification contracts
5. Append-only event store with full replay
6. Operator inspection and intervention

This is the gap. The market is moving toward unattended, multi-step, autonomous agent runs — Devin-style "assign a ticket and come back later" workflows, CI pipelines that use agents to fix tests, multi-agent review systems. The moment the human leaves the inner loop, every one of these systems needs what Buildplane provides.

---

## Technical Strengths

**Type safety throughout.** Strict TypeScript with discriminated unions for events, no `any` types in core packages, readonly constraints on interfaces. The event system uses pattern matching rather than string comparisons.

**Clean separation of concerns.** The port-adapter pattern means the kernel never imports storage, runtime, or policy directly. Everything flows through interfaces. Packages can be replaced independently.

**Event sourcing done right.** The append-only event log is separate from mutable projection tables. Any run can be fully reconstructed from its event stream. This enables replay, inspection, and future features like time-travel debugging.

**Validation at boundaries.** Packet parsing does recursive field validation with clear error messages before anything enters the kernel. Invalid state is rejected early, not discovered mid-execution.

**Observable at every stage.** The event bus broadcasts every lifecycle transition. Storage, TUI, and CLI all subscribe independently. Adding new observers (metrics, webhooks, external logging) requires zero changes to the kernel.

---

## Technical Gaps

**Policy is the thesis but the thinnest layer.** The entire value proposition is operator control over autonomous work. Today, policy only checks exit codes and file existence. Budget enforcement, trust gates, retry logic, and approval workflows are not implemented.

**Tool execution is mocked.** The model adapter streams tool calls but doesn't execute them. For real autonomous software work, Buildplane needs a tool adapter that runs shell commands, file edits, and searches inside bounded contexts — and captures evidence for each.

**No multi-unit orchestration.** The `inputRefs` field on Unit suggests planned DAG support, but the scheduler doesn't exist. Real autonomous work needs unit A's output to feed unit B's input.

**No concurrency.** Runs are strictly sequential. No work queue, no parallel execution, no multi-run isolation.

**No database migrations.** The SQLite schema is hardcoded in the init path. Schema evolution will break existing `.buildplane/` directories without a migration strategy.

**No graceful shutdown.** Long-running model executions can't be interrupted cleanly. No signal handling, no partial-run persistence.

---

## Roadmap Priorities

Based on the architecture and current gaps, the highest-impact work in priority order:

1. **Policy engine** — Implement budget constraints (token/cost limits), trust gates (operator approval checkpoints), and configurable retry logic. This is the differentiator.

2. **Tool adapter** — Wire tool calls from model execution to actual shell/file/search execution with evidence capture per tool invocation. Without this, model-type units can't do real work.

3. **Multi-unit orchestration** — Build the scheduler that resolves `inputRefs` dependencies and dispatches units in topological order. This unlocks DAG-based workflows.

4. **Git adapter** — Worktree isolation per run, automatic branching, diff capture as evidence. Critical for coding-specific autonomous work.

5. **Database migrations** — Version the SQLite schema and run migrations on init to preserve existing project state across upgrades.

6. **Concurrency** — Parallel unit execution with isolated contexts. Required for DAG parallelism and multi-agent workflows.

---

## Summary

Buildplane is a well-architected foundation for deterministic AI work orchestration. The kernel, storage, and event system are solid. The CLI provides a complete operator workflow for single-unit execution. The architecture is designed for extensibility through ports, adapters, and typed events.

The project is at roughly 40% of its design vision. The core execution path works end-to-end. The differentiation layer — policy enforcement, tool execution, multi-unit orchestration — needs implementation. The competitive window is open: no one else has shipped an open-source control plane purpose-built for autonomous coding agent execution with evidence-first verification.

The bet is that the industry is moving from interactive coding assistance to unattended autonomous execution, and when it does, every agent will need a kernel like this underneath it.
