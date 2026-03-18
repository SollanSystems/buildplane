# Local Run Loop Design

**Date:** 2026-03-17
**Status:** Proposed
**Related milestone:** Milestone 1 thin vertical slice

## Goal

Deliver the first real Buildplane control-plane loop for local development:

1. `buildplane init`
2. `buildplane run --packet <path>`
3. `buildplane status`
4. `buildplane inspect <run-id|unit-id>`

The slice must persist durable state in `.buildplane/`, capture execution evidence, evaluate a minimal policy decision, and let the operator inspect the recorded result.

## Why this slice next

Buildplane now has repo scaffolding, workflow automation, and initial kernel/storage contracts. The next highest-value step is a narrow end-to-end local flow that proves the core product shape instead of adding more isolated scaffolding.

This slice is intentionally small but real:

- it uses the stable CLI surface already described in the product design
- it persists actual control-plane state instead of keeping it in memory
- it proves the separation between runtime evidence gathering, policy judgment, kernel orchestration, and CLI reporting
- it creates a foundation that later slices can extend with worktree isolation, replay, richer policy, and model-backed execution

## In scope

### Commands

- `buildplane init`
- `buildplane run --packet <path>`
- `buildplane status [--json]`
- `buildplane inspect <run-id|unit-id> [--json]`

### Runtime model

- one packet describes one bounded unit of work
- one run executes one packet
- execution is a deterministic local command step, not a model call
- runtime captures raw receipts from command execution
- policy evaluates those receipts and returns a decision
- storage persists the run history and queryable projections

### Persistence

Buildplane creates and owns the minimum local project layout:

```text
.buildplane/
  state.db
  artifacts/
  evidence/
  runs/
  logs/
  project.json
```

The source of truth remains SQLite-backed local state in `.buildplane/state.db`.

## Out of scope

This slice does **not** implement:

- git worktree isolation
- model providers or prompt execution
- replay
- multi-unit scheduling
- rich policy profiles
- TUI surfaces
- `.gsd/` import
- parallel orchestration

Those remain later Milestone 1 or post-Milestone 1 slices.

## Operator flow

### 1. `buildplane init`

Initializes Buildplane state for the current repo.

Behavior:

- creates `.buildplane/`
- creates `artifacts/`, `evidence/`, `runs/`, and `logs/`
- writes `project.json` with project-local metadata
- initializes `state.db` schema
- is idempotent and safe to run twice

### 2. `buildplane run --packet <path>`

Executes one local packet against the current project.

Behavior:

- requires an initialized Buildplane project
- loads and validates the packet file
- records a new run lifecycle
- invokes runtime to execute one local command step
- captures receipts and stores evidence
- asks policy to evaluate the result
- stores the resulting decision and any declared artifact references
- prints the run id and final outcome

### 3. `buildplane status`

Shows current project execution state.

Behavior:

- reports whether the project is initialized
- shows latest run summary
- shows counts by run status
- optionally emits JSON for automation

### 4. `buildplane inspect <run-id|unit-id>`

Shows full history for one run or unit.

Behavior:

- resolves by run id or unit id
- displays packet metadata, run state, evidence summary, decision summary, and artifact references
- optionally emits JSON for automation

## Packet contract

This slice introduces one minimal JSON packet format. It must be small enough to hand-author in tests and examples.

### Required fields

- `unit.id`
- `unit.kind`
- `unit.scope`
- `unit.policyProfile`
- `execution.command`

### Optional fields

- `unit.inputRefs`
- `unit.expectedOutputs`
- `execution.args`
- `execution.cwd`
- `verification.requiredOutputs`

### Example packet

```json
{
  "unit": {
    "id": "unit-hello",
    "kind": "command",
    "scope": "task",
    "inputRefs": [],
    "expectedOutputs": ["tmp/out.txt"],
    "verificationContract": "exit-0-and-required-outputs",
    "policyProfile": "default"
  },
  "execution": {
    "command": "node",
    "args": ["-e", "require('node:fs').writeFileSync('tmp/out.txt', 'ok')"]
  },
  "verification": {
    "requiredOutputs": ["tmp/out.txt"]
  }
}
```

This format deliberately avoids a workflow DSL. It is a packet for one bounded unit only.

## Package boundaries

### `apps/cli`

Owns:

- command parsing
- output formatting
- `--json` serialization
- user-facing errors and guidance

Must not own:

- runtime execution
- policy logic
- storage writes beyond calling package APIs

### `packages/kernel`

Owns:

- packet and run lifecycle contracts
- orchestration entrypoints for init/run/status/inspect
- interfaces for storage, runtime, and policy
- the rule that execution advances through explicit states

Kernel behavior for this slice:

1. validate orchestration inputs
2. create run record in storage
3. invoke runtime executor
4. invoke policy evaluator with gathered evidence
5. persist decision and final run state
6. return a structured result to CLI

### `packages/runtime`

Owns:

- local command execution
- receipt capture
- timing capture
- stdout/stderr capture
- artifact path reporting for declared outputs

Runtime does not judge success. It only reports what happened.

### `packages/policy`

Owns the minimal decision rule for this slice.

Default rule:

- approve if command exit code is `0`
- and all declared required outputs exist
- otherwise reject

Policy produces a decision record; it does not mutate run state directly.

### `packages/storage`

Owns:

- filesystem initialization for `.buildplane/`
- `project.json`
- SQLite schema creation and access
- append-only event persistence
- query/projection persistence
- read APIs used by `status` and `inspect`

Storage is the only package that knows how state is physically stored.

## Storage design

### SQLite driver choice

Use Node 24's built-in `node:sqlite` module behind the storage package boundary.

Rationale:

- no extra dependency for the first slice
- the repo already pins Node `24.13.1`
- local runtime confirms the module is present
- the experimental status is acceptable for this narrow slice because the API is contained entirely within `packages/storage`

If a later slice needs a different driver, that change should stay localized to storage.

### Truth model

The source of truth is an append-only `events` table in `.buildplane/state.db`.

For operator queries, storage also maintains minimal projections in the same database.

### Minimum tables

#### `events`

Append-only control-plane events such as:

- project initialized
- packet registered
- run created
- run started
- evidence recorded
- decision recorded
- run completed

#### Projections

- `projects`
- `units`
- `runs`
- `evidence`
- `decisions`
- `artifacts`

The projections are intentionally small and only support the current CLI query needs.

## Evidence and decision model

### Evidence captured by runtime

For each run, runtime records at minimum:

- command
- args
- cwd
- started at
- completed at
- exit code
- stdout location or inline value
- stderr location or inline value
- existence status for declared output files

### Decision produced by policy

The first policy decision should be explicit and auditable.

Possible outcomes for this slice:

- `approved`
- `rejected`

Likely decision kinds:

- `advance-run`
- `reject-run`

### Run lifecycle

The run lifecycle remains simple:

- `pending`
- `running`
- `passed`
- `failed`
- `cancelled` (declared in core contracts but not actively produced by this slice)

For this slice, successful approval maps to `passed`; rejection maps to `failed`.

## Error handling

### `buildplane init`

- if already initialized, return success with an idempotent message
- if files exist but schema is missing or invalid, fail with actionable guidance

### `buildplane run --packet <path>`

- if Buildplane is not initialized, fail with guidance to run `buildplane init`
- if packet JSON is invalid, fail before creating a run
- if runtime command fails, record the run and evidence, then mark the decision rejected
- if required outputs are missing, record the run and evidence, then mark the decision rejected

### Query commands

- if project is not initialized, return a clear operator-facing error
- if target run or unit is not found, return a not-found error without stack noise
- JSON mode must produce stable machine-readable output for both success and failure paths

## Testing strategy

This slice should be delivered through TDD and verified with a combination of focused tests and one true vertical integration path.

### Kernel tests

Cover:

- packet contract parsing and orchestration boundaries
- run lifecycle transitions
- kernel calling runtime, policy, and storage in the correct order

### Storage tests

Cover:

- project initialization in a temp directory
- schema creation
- event append behavior
- status query projection
- inspect query projection

### Policy tests

Cover:

- exit code `0` + outputs exist => approved
- non-zero exit code => rejected
- missing declared outputs => rejected

### Runtime tests

Cover:

- command receipt capture
- stdout/stderr capture
- timing and exit code capture
- declared output discovery

### CLI integration tests

Cover:

- `buildplane init`
- `buildplane run --packet <path>` for a passing packet
- `buildplane run --packet <path>` for a failing packet
- `buildplane status --json`
- `buildplane inspect <run-id> --json`

### End-to-end acceptance test

One test should prove the entire thin slice:

1. create a temp git-like project directory
2. run `buildplane init`
3. execute a passing packet that writes an output file
4. confirm `state.db` exists
5. confirm `status --json` reports the run
6. confirm `inspect --json` reports evidence, decision, and artifact info

This test is the primary acceptance signal for the slice.

## Success criteria

This slice is successful when:

- Buildplane can initialize local project state
- Buildplane can execute one packet-backed local command
- runtime captures evidence
- policy records an explicit judgment
- storage persists both event truth and queryable projections
- CLI can show status and inspect results from durable state
- the entire flow passes in automated tests

## Follow-on slices unlocked by this work

This design intentionally sets up later work without overbuilding now:

1. replace local command execution with git worktree-isolated execution
2. add replay using stored packet and policy context
3. enrich policy profiles and approval gates
4. add TUI inspection views over the same storage query APIs
5. add model-backed worker execution behind runtime/adapters
