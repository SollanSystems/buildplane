# Worktree Isolation Design

**Date:** 2026-03-17
**Status:** Proposed
**Related milestone:** Milestone 1 thin vertical slice

## Goal

Replace root-repo local command execution with isolated git worktree execution while keeping the current operator-facing CLI surface stable:

1. `buildplane run --packet <path>`
2. `buildplane status [--json]`
3. `buildplane inspect <run-id|unit-id> [--json]`

The slice must execute each run in a fresh git worktree created from the current repository `HEAD`, persist workspace metadata in `.buildplane/state.db`, delete successful worktrees automatically, and retain failed worktrees for operator inspection.

## Why this slice next

The local run loop proved the control-plane skeleton: packet parsing, durable state, evidence capture, policy judgment, and operator inspection. The next highest-value step is to move execution into the isolation primitive that Buildplane is meant to center on for Milestone 1.

This slice is intentionally narrow but materially advances the product shape:

- it keeps the current CLI contract stable instead of expanding the operator surface early
- it makes runtime execution happen in a disposable git worktree rather than the source checkout
- it proves `packages/adapters-git` as a real adapter instead of a placeholder package
- it adds durable workspace lifecycle state without entangling git logic into runtime or storage
- it sets up later slices for replay, resume, richer inspection, and model-backed workers without overbuilding now

## In scope

### Commands

The command set remains unchanged:

- `buildplane run --packet <path>`
- `buildplane status [--json]`
- `buildplane inspect <run-id|unit-id> [--json]`

`buildplane init` remains as implemented in the prior slice and does not gain git behavior.

### Isolation model

- one run gets one fresh git worktree
- the worktree is created from the current repository `HEAD`
- packet execution happens inside the worktree path, not the source repo root
- successful runs trigger worktree deletion
- failed runs retain the worktree for operator inspection
- retained worktrees are reported through durable state, not only transient CLI output

### Repository rules

For this first isolation slice:

- the source project must be a git repository
- the source project must have a clean working tree before `run`
- Buildplane fails fast if the working tree is dirty
- Buildplane fails fast if `HEAD` cannot be resolved

These constraints are intentional. Auto-stash, dirty-tree snapshots, and non-git project support are later concerns.

## Out of scope

This slice does **not** implement:

- worktree reuse across runs
- explicit worktree management commands
- auto-stash or dirty-repo snapshotting
- replay or resume
- model execution
- multi-unit scheduling
- branch-per-run workflows
- TUI-specific workspace views
- non-git project isolation

Those remain later Milestone 1 or post-Milestone 1 slices.

## Operator flow

### 1. `buildplane run --packet <path>`

The command surface stays the same, but execution moves into an isolated worktree.

Behavior:

1. verify Buildplane project state is initialized
2. verify the current project is a git repo with a clean working tree
3. resolve the current `HEAD` commit
4. create a fresh run record in storage
5. create a fresh git worktree for that run
6. execute the packet inside the worktree path
7. record evidence and policy decision as in the local run loop slice
8. delete the worktree if the run passes
9. retain the worktree if the run fails
10. persist the final workspace disposition for later inspection

Human output should stay narrow. The stable `run-id:` and `status:` lines remain. For this slice, an additional `workspace:` line may be shown only when a failed run leaves a retained worktree the operator can inspect.

### 2. `buildplane status [--json]`

Status remains a summary command.

Behavior:

- reports whether Buildplane is initialized
- reports latest run summary and run counts as before
- includes whether the latest run used worktree isolation
- includes the latest workspace disposition (`deleted`, `retained`, or `cleanup-failed`) in JSON output

Human mode should remain compact and not dump the full workspace path unless needed.

### 3. `buildplane inspect <run-id|unit-id> [--json]`

Inspect remains the detailed operator view.

Behavior:

- shows run/unit information, evidence, decisions, and artifacts as before
- additionally shows the workspace path
- shows the source commit SHA used for the workspace
- shows whether the workspace was deleted or retained
- shows cleanup timestamp if deletion succeeded
- shows cleanup error details if deletion was attempted and failed

For retained failed runs, `inspect` becomes the durable way to recover the workspace path later.

## Package boundaries

### `apps/cli`

Owns:

- unchanged command parsing for `run`, `status`, and `inspect`
- output formatting for workspace metadata
- stable operator-facing error messages

Must not own:

- git commands
- workspace lifecycle rules
- direct filesystem cleanup policy

### `packages/kernel`

Owns:

- orchestration of repo validation, workspace preparation, execution, and finalization
- the rule that successful runs are cleaned up and failed runs are retained
- translation of workspace lifecycle results into durable run outcomes and query data

Kernel behavior for this slice:

1. validate orchestration preconditions through injected ports
2. create the run record
3. prepare a workspace for that run
4. invoke runtime against the workspace root
5. invoke policy against gathered evidence
6. persist decision and final run state
7. finalize the workspace according to run outcome
8. return a structured result to CLI

### `packages/adapters-git`

Owns all direct git interaction.

Responsibilities:

- detect whether the project root is a git repo
- determine whether the working tree is clean
- resolve the current `HEAD` SHA
- create a new git worktree for a run
- remove a worktree when instructed
- return structured metadata rather than raw git output

This package should be the only place that shells out to git for the isolation slice.

### `packages/runtime`

Owns:

- deterministic command execution
- receipt capture
- stdout/stderr capture
- output checks

Runtime remains git-agnostic. It receives a workspace root from the kernel and executes inside it.

### `packages/storage`

Owns:

- durable persistence of workspace lifecycle state
- workspace query projection for `status` and `inspect`
- append-only workspace lifecycle events

Storage must not create or delete worktrees itself.

## Kernel port design

This slice introduces one workspace lifecycle port owned by the kernel boundary.

A minimal shape is:

- `assertRunnableRepository(projectRoot)`
- `prepareWorkspace(projectRoot, runId)`
- `finalizeWorkspace(workspace, outcome)`

Where `prepareWorkspace(...)` returns structured metadata such as:

- `path`
- `headSha`
- optional branch/worktree name if relevant internally

And `finalizeWorkspace(...)` returns structured disposition data such as:

- `deleted`
- `retained`
- `cleanup-failed`
- optional cleanup error message

The port should stay narrow. The kernel decides *when* preparation and finalization happen; the git adapter decides *how* git performs those actions.

## Storage design

### Truth model

The source of truth remains SQLite-backed append-only events plus query projections in `.buildplane/state.db`.

This slice adds workspace lifecycle events alongside the existing run lifecycle events.

### New events

Minimum new event kinds:

- `workspace-prepared`
- `workspace-deleted`
- `workspace-retained`
- `workspace-cleanup-failed`

These must be emitted explicitly so later replay/resume features can reason about workspace history without inferring it from mutable projection rows.

### New projection

Add a dedicated `workspaces` projection instead of overloading `runs` with several nullable workspace columns.

Minimum fields:

- `run_id`
- `source_project_root`
- `head_sha`
- `path`
- `status` (`active | deleted | retained | cleanup-failed`)
- `created_at`
- `finalized_at` nullable
- `cleanup_error` nullable

This keeps the workspace lifecycle explicit and queryable while staying small enough for the first isolation slice.

### Query behavior

`getStatusSnapshot()` should include the latest workspace disposition when a latest run exists.

`inspectTarget(id)` should include the workspace record associated with the relevant run so operators can see:

- what commit the run used
- where the worktree lived
- whether it still exists by policy
- whether cleanup failed unexpectedly

## Error handling

### Pre-run repository failures

These fail before execution begins:

- Buildplane project not initialized
- source project is not a git repo
- working tree is dirty
- `HEAD` cannot be resolved
- worktree creation fails

For this slice, these should produce clear operator-facing errors. If the failure occurs before workspace preparation, Buildplane should avoid partial workspace state.

### Execution failures

Command failure semantics remain the same as the local run loop:

- non-zero exit code => rejected run
- missing required outputs => rejected run

Difference in this slice:

- failed runs retain the worktree
- the retained workspace path is persisted durably

### Cleanup failures

A cleanup failure is distinct from an execution failure.

If execution passes but worktree deletion fails:

- the run remains `passed`
- workspace projection status becomes `cleanup-failed`
- the cleanup error is persisted and shown in `inspect`
- operators can manually remove the leftover worktree later

This preserves truth instead of collapsing cleanup issues into run execution state.

## Testing strategy

This slice should again be delivered through TDD with one clean vertical acceptance path.

### Git adapter tests

Cover:

- detect git repo vs non-git directory
- reject dirty working tree
- resolve `HEAD`
- create a worktree for a run
- delete a successful worktree
- retain a failed worktree by skipping deletion

### Kernel orchestration tests

Cover:

- repository validation happens before runtime execution
- workspace is prepared before runtime executes
- runtime receives workspace root rather than source project root
- successful run triggers workspace cleanup
- failed run triggers workspace retention
- cleanup-failed state is recorded separately from run result

### Storage tests

Cover:

- workspace event append behavior
- workspace projection creation and update
- `status` reporting latest workspace disposition
- `inspect` including workspace metadata for a run

### CLI integration tests

Cover:

- dirty repo returns stable operator error
- successful run still prints stable `run-id` and `status`
- failed run exposes retained workspace information
- `inspect --json` includes workspace metadata

### End-to-end acceptance test

One test should prove the full thin slice in a temp git repo:

1. create a temp project and initialize git
2. commit a baseline file so `HEAD` exists
3. run `buildplane init`
4. execute a passing packet and verify its worktree is deleted
5. execute a failing packet and verify its worktree is retained
6. confirm `status --json` reports the latest workspace disposition
7. confirm `inspect --json` reports head SHA, workspace path, and retention state

This test is the primary acceptance signal for the isolation slice.

## Success criteria

This slice is successful when:

- Buildplane executes packet runs inside fresh git worktrees rather than the source repo root
- dirty repos are rejected clearly before execution
- successful runs clean up their worktrees automatically
- failed runs retain their worktrees for operator inspection
- workspace lifecycle is persisted durably in storage
- `status` and `inspect` surface workspace metadata cleanly
- the full git-backed isolation flow passes in automated tests

## Follow-on slices unlocked by this work

This design intentionally sets up later work without pulling it in now:

1. replay a prior run into a fresh worktree from stored packet metadata
2. resume retained failed workspaces with explicit operator commands
3. add TUI inspection views over workspace lifecycle state
4. allow richer repo preparation flows such as branch naming or stashing policies
5. run model-backed workers inside the same isolated worktree boundary
