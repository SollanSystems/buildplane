# Worktree Isolation Design

**Date:** 2026-03-17
**Status:** Proposed
**Related milestone:** Milestone 1 thin vertical slice

## Goal

Replace root-repo local command execution with isolated git worktree execution while keeping the existing operator-facing CLI surface stable:

1. `buildplane run --packet <path>`
2. `buildplane status [--json]`
3. `buildplane inspect <run-id|unit-id> [--json]`

The slice must execute each run in a fresh git worktree created from the current repository `HEAD`, persist workspace metadata in `.buildplane/state.db`, delete successful worktrees automatically, and retain failed worktrees for operator inspection.

It also extends the canonical local Buildplane layout with a new directory: `.buildplane/workspaces/`.

## Why this slice next

The local run loop proved the control-plane skeleton: packet parsing, durable state, evidence capture, policy judgment, and operator inspection. The next highest-value step is to move execution into the isolation primitive that Buildplane is meant to center on for Milestone 1.

This design intentionally keeps the slice thin:

- it keeps the current CLI contract stable instead of expanding the operator surface early
- it makes runtime execution happen in a disposable git worktree rather than the source checkout
- it proves `packages/adapters-git` as a real adapter instead of a placeholder package
- it adds durable workspace lifecycle state without pulling crash recovery, lease coordination, or explicit cleanup commands into the same slice

## In scope

### Commands

The command set remains unchanged:

- `buildplane run --packet <path>`
- `buildplane status [--json]`
- `buildplane inspect <run-id|unit-id> [--json]`

`buildplane init` remains as implemented in the prior slice and does not gain new git-facing behavior.

### Isolation model

- one run gets one fresh git worktree
- the worktree is created from the current repository `HEAD`
- each run uses a deterministic workspace path under `.buildplane/workspaces/<run-id>`
- packet execution happens inside that worktree path, not the source repo root
- successful runs trigger worktree deletion
- failed runs retain the worktree for operator inspection
- retained or cleanup-failed workspaces are reported through durable state, not only transient CLI output

Using `.buildplane/workspaces/<run-id>` keeps retained leftovers out of the tracked source tree.

### Repository rules

For this first isolation slice:

- the source project must be a git repository
- the source project must have a clean working tree before `run`
- Buildplane fails fast if the working tree is dirty
- Buildplane fails fast if `HEAD` cannot be resolved
- Buildplane-managed `.buildplane/**` state is excluded from cleanliness checks by the git adapter

These constraints are intentional. Auto-stash, dirty-tree snapshots, and non-git project support are later concerns.

### Packet path semantics inside isolation

Worktree isolation only matters if Buildplane-managed packet paths are also confined to the worktree root.

For this slice:

- the kernel owns canonicalization and validation of Buildplane-managed packet paths before runtime executes
- validation uses the structural workspace-root rule `.buildplane/workspaces/<future-run-id>` as a containment model only; it does not require a concrete run id, a physical worktree on disk, or a durably created run record
- `execution.cwd`, when present, is resolved relative to that workspace root
- declared output paths and required output checks are resolved relative to that workspace root
- absolute paths are rejected
- any path that resolves outside the worktree root is rejected

This constrains Buildplane-managed relative paths to the worktree boundary while staying compatible with the existing packet shape. It is not an OS sandbox and does not prevent an arbitrary command from intentionally touching other filesystem paths on its own.

## Out of scope

This slice does **not** implement:

- worktree reuse across runs
- explicit worktree management commands
- concurrent-run coordination or repo-local lease/lock protocols
- race-safe overlapping `buildplane run` behavior
- automatic recovery/reconciliation after process interruption
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
2. load and validate the packet, including worktree-relative path rules
3. verify the current project is a git repo with a clean working tree
4. resolve the current `HEAD` commit and pin that SHA for the run
5. create a fresh run record in storage
6. create a fresh git worktree for that run at `.buildplane/workspaces/<run-id>` from the pinned SHA
7. durably record `workspace-prepared` plus the `workspaces` projection update in one SQLite transaction
8. execute the packet inside the worktree path
9. record evidence and policy decision as in the local run loop slice
10. if the run fails, persist the terminal run state plus workspace status `retained` in one SQLite transaction
11. if the run passes, attempt git deletion of the workspace, then persist `workspace-deleted` on success or `workspace-cleanup-failed` on failure

Failure semantics for this step are part of the design contract:

- failures before step 5 return a clear operator error and create no run
- failures during steps 6-7 after the run already exists mark the run failed with infrastructure evidence such as `workspace-prepare-failed`
- a run that fails before `workspace-prepared` is durably recorded has no normal workspace projection row
- policy evaluation does not run when workspace preparation fails
- overlapping `buildplane run` invocations are unsupported in this slice; behavior is not part of the acceptance contract

Human output should stay narrow. The stable `run-id:` and `status:` lines remain. For this slice, an additional `workspace:` line should be shown whenever the operator has actionable leftover workspace state, including retained failed runs and cleanup-failed passed runs.

### 2. `buildplane status [--json]`

Status remains a summary command.

Behavior:

- reports whether Buildplane is initialized
- reports latest run summary and run counts as before
- includes whether the latest run used worktree isolation
- includes the latest workspace disposition (`deleted`, `retained`, or `cleanup-failed`) in JSON output when a latest run has workspace metadata
- includes the latest workspace path in JSON output when the workspace still needs operator attention
- includes a newest-first `actionableWorkspaces` list in JSON output with `{ runId, status, path, headSha }` for `retained` and `cleanup-failed` workspaces so older leftovers remain discoverable after newer runs happen
- active workspaces may still appear through the latest workspace summary during an in-progress or interrupted run, but they are not treated as actionable in this slice because no recovery command exists yet

Human mode should remain compact, but it should surface:

- the latest run summary
- a one-line workspace note when the latest workspace is `active`, `retained`, or `cleanup-failed`
- `actionable-workspaces: <count>` when older actionable workspaces still exist

### 3. `buildplane inspect <run-id|unit-id> [--json]`

Inspect remains the detailed operator view.

Behavior:

- shows run/unit information, evidence, decisions, and artifacts as before
- additionally shows the workspace path when workspace preparation completed durably for that run
- shows the source commit SHA used for the workspace
- shows whether the workspace was deleted, retained, still appears `active`, or ended in `cleanup-failed`
- shows cleanup timestamp if deletion succeeded
- shows cleanup error details if deletion was attempted and failed
- may report whether the workspace directory currently exists on disk as a read-time observation without mutating durable state
- shows setup failure evidence without inventing a workspace record when the run failed before workspace preparation completed

For retained failed runs and cleanup-failed passed runs, `inspect` becomes the durable way to recover the workspace path later.

If an interrupted passed run is observed as `passed` plus workspace `active`, `inspect` should report that combination plainly as a known thin-slice limitation rather than guessing whether cleanup happened.

For `inspect <unit-id>`, the command continues to resolve to the latest run for that unit, with newest-first `runHistory`, as established by the local run loop slice.

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
- deciding when policy is skipped in infrastructure-failure paths
- the rule that successful runs are cleaned up and failed runs are retained
- translation of workspace lifecycle results into durable run outcomes and query data
- packet path validation against the computed worktree root before runtime executes

Kernel behavior for this slice:

1. validate orchestration preconditions through injected ports
2. create the run record
3. prepare a workspace for that run from the pinned SHA
4. durably record the prepared workspace before runtime executes
5. if workspace preparation fails after run creation, mark the run failed with infrastructure evidence and skip policy evaluation
6. invoke runtime against the workspace root
7. invoke policy against gathered evidence when a valid receipt exists
8. for the failed path, persist decision, terminal run state, and `workspace-retained` together in one transaction
9. for the passing path, persist decision and `passed` run state, then finalize the workspace and record `workspace-deleted` or `workspace-cleanup-failed`
10. return a structured result to CLI

### `packages/adapters-git`

Owns all direct git interaction.

Responsibilities:

- detect whether the project root is a git repo
- determine whether the working tree is clean while excluding Buildplane-managed `.buildplane/**` state
- resolve the current `HEAD` SHA
- create a new git worktree for a run from an explicitly supplied commit SHA
- remove a worktree when instructed
- return structured metadata rather than raw git output

This package should be the only place that shells out to git for the isolation slice.

### `packages/runtime`

Owns:

- deterministic command execution
- receipt capture
- stdout/stderr capture
- output checks against already validated worktree-relative paths

Runtime remains git-agnostic. It receives a workspace root and an already validated packet shape from the kernel and executes inside that root.

### `packages/policy`

Owns:

- domain-level judgment over valid runtime receipts
- approved vs rejected outcomes for command execution semantics

Policy does not participate in setup failures or other infrastructure-failure paths. Those remain kernel-owned semantics.

### `packages/storage`

Owns:

- durable persistence of workspace lifecycle state
- ordered run/event/projection writes for workspace lifecycle transitions
- workspace query projection for `status` and `inspect`
- append-only workspace lifecycle events

Storage must not create or delete worktrees itself.

SQLite remains the control-plane source of truth. Logs remain diagnostics, not control-plane truth.

## Kernel port design

This slice introduces one workspace lifecycle port owned by the kernel boundary.

A minimal shape is:

- `assertRunnableRepository(projectRoot)` returning the pinned `headSha`
- `prepareWorkspace(projectRoot, runId, headSha)`
- `deleteWorkspace(workspace)`

Where `prepareWorkspace(...)` must create the worktree from the exact `headSha` chosen during preflight and returns structured metadata such as:

- `path`
- `headSha`
- optional worktree name if relevant internally

And `deleteWorkspace(...)` returns structured disposition data such as:

- `deleted`
- `cleanup-failed`
- optional cleanup error message

The port should stay narrow. The kernel decides *whether* a workspace should be deleted or retained; the git adapter decides *how* git performs the delete when deletion is requested.

`assertRunnableRepository(...)` intentionally combines repository validation with `HEAD` resolution for this first HEAD-only slice. A later slice can split those concerns if Buildplane needs other snapshot sources.

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

These must be emitted explicitly so later replay/recovery features can reason about workspace history without inferring it from mutable projection rows.

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

Runs that fail before workspace preparation completes should not receive a fake normal workspace row. Their failure should be represented through run state plus infrastructure evidence.

### Atomicity rule

For this slice, workspace lifecycle event append plus `workspaces` projection update must happen in one SQLite transaction.

The spec relies on a crisp boundary:

- either workspace preparation was durably recorded
- or it was not durably recorded

For the failed-run path, the terminal run outcome and `workspace-retained` must commit together in one SQLite transaction. That prevents impossible durable combinations such as failed runs with a still-`active` workspace.

For the passed-run path, decision plus `passed` run state commit in one transaction before the physical delete attempt begins. `workspace-deleted` or `workspace-cleanup-failed` is then recorded in a later transaction after the delete attempt completes.

### Query behavior

`getStatusSnapshot()` should include the latest workspace disposition when a latest run exists.

It should also include `actionableWorkspaces` for retained and `cleanup-failed` workspaces so older leftovers remain discoverable without knowing a run id in advance.

`inspectTarget(id)` should include the workspace record associated with the relevant run so operators can see:

- what commit the run used
- where the worktree lived
- whether it still exists by policy
- whether cleanup failed unexpectedly

## Error handling

### Pre-run repository failures

These fail before execution begins:

- Buildplane project not initialized
- `git` is not installed or not available in `PATH`
- source project is not a git repo
- working tree is dirty
- `HEAD` cannot be resolved

For this slice, these should produce clear operator-facing errors and create no run.

### Packet validation failures

These are deterministic packet errors and should be handled before run creation:

- invalid packet JSON or missing required packet fields
- absolute `execution.cwd`
- absolute output paths
- any packet path that resolves outside the future worktree root

For this slice, packet path validation errors are not treated as infrastructure failures. They produce a stable operator error and create no run.

### Workspace preparation failures

Workspace preparation failures happen after orchestration has started but before runtime execution begins:

- git worktree creation fails
- durable `workspace-prepared` persistence fails after git worktree creation

For this slice:

- if the run record already exists, the run is marked failed
- infrastructure evidence records the setup failure
- policy evaluation does not run
- no normal workspace projection is created unless workspace preparation completed durably
- if git created a worktree before persistence failed, Buildplane attempts immediate best-effort cleanup and reports the infrastructure error clearly

This slice does not attempt automatic later recovery from interrupted or half-recorded setup failures.

### Execution failures

Command failure semantics remain the same as the local run loop:

- non-zero exit code => rejected run
- missing required outputs => rejected run

Difference in this slice:

- failed runs retain the worktree
- the retained workspace path is persisted durably

### Post-prepare infrastructure failures

Once a workspace has been durably prepared, any non-domain failure is treated as an infrastructure failure and the workspace is kept for inspection when possible.

Examples:

- runtime throws before producing a complete receipt
- policy evaluation throws
- decision persistence fails
- final run-state persistence fails

For this slice:

- Buildplane treats these as failed runs when storage is still writable enough to mark failure
- policy is skipped if runtime never produced a valid receipt
- if policy itself throws, no decision record is fabricated
- the workspace is retained when Buildplane can still finalize that state durably
- otherwise the command returns an infrastructure error and the slice makes no automatic later recovery guarantee

### Cleanup failures

A cleanup failure is distinct from an execution failure.

If execution passes but worktree deletion fails:

- the run remains `passed`
- workspace projection status becomes `cleanup-failed`
- the cleanup error is persisted and shown in `inspect`
- human `run` output includes the actionable workspace path
- operators can manually remove the leftover worktree later

If git deletion succeeds but Buildplane cannot durably persist the deleted state, the command returns an infrastructure error. `status` may still show a stale active/actionable entry from durable state, while `inspect` should be able to report that the last-known workspace path no longer exists on disk. This first isolation slice does not attempt automatic later recovery from that condition.

## Testing strategy

This slice should again be delivered through TDD with one clean vertical acceptance path.

### Git adapter tests

Cover:

- detect git repo vs non-git directory
- fail clearly when the `git` binary is unavailable
- reject dirty working tree while ignoring `.buildplane/**`
- reject unresolved `HEAD` in an empty or uncommitted repo
- create a worktree for a run from the pinned `headSha`
- delete a successful worktree
- retain a failed worktree by skipping deletion
- surface worktree-creation failure cleanly
- surface cleanup failure cleanly

### Kernel orchestration tests

Cover:

- repository validation happens before runtime execution
- workspace is prepared and durably recorded before runtime executes
- runtime receives workspace root rather than source project root
- absolute or escaping packet paths are rejected before runtime executes
- successful run triggers workspace cleanup
- failed run triggers workspace retention
- workspace-prepare failure marks the run failed without policy evaluation
- runtime or policy infrastructure failure retains the workspace when durable finalization is still possible
- failed-path transaction failure is treated as an infrastructure error and does not fabricate a retained workspace state it could not durably commit
- cleanup-failed state is recorded separately from run result

### Storage tests

Cover:

- workspace event append behavior
- workspace projection creation and update
- workspace event append plus projection update are atomic for a given lifecycle transition
- runs with setup failure have no fake normal workspace row
- `status` reporting latest workspace disposition
- `status` reporting `actionableWorkspaces` for older retained/cleanup-failed leftovers
- `inspect` including workspace metadata for a run
- `inspect` showing infrastructure setup failure without a workspace record

### CLI integration tests

Cover:

- missing `git` returns a stable operator error
- non-git repo returns a stable operator error
- dirty repo returns a stable operator error
- unresolved `HEAD` returns a stable operator error
- successful run still prints stable `run-id` and `status`
- failed run exposes retained workspace information
- cleanup-failed output exposes actionable workspace information
- infrastructure-failure output after run creation remains stable and points the operator to the recorded run id
- human `run` output covers the `workspace:` line contract
- human `status` output covers the workspace note and `actionable-workspaces: <count>` line
- `status --json` exposes `actionableWorkspaces`
- `inspect --json` includes workspace metadata

### End-to-end acceptance test

One test should prove the full thin slice in a temp git repo:

1. create a temp project and initialize git
2. commit a baseline file so `HEAD` exists
3. run `buildplane init`
4. execute a passing packet and verify its worktree is deleted
5. verify the source checkout did not receive the worktree-generated file changes
6. execute a failing packet and verify its worktree is retained
7. confirm `status --json` reports the latest workspace disposition
8. confirm `inspect --json` reports head SHA, workspace path, and retention state

This test is the primary acceptance signal for the isolation slice.

In addition to that main path, focused automated tests must prove the isolation-specific failure paths:

- non-git repo rejection
- dirty repo rejection
- unresolved `HEAD` rejection
- absolute or escaping packet path rejection
- workspace preparation failure after run creation
- cleanup-failed persistence and inspection
- git-delete-succeeded but `workspace-deleted` persistence-failed operator behavior
- older actionable-workspace discovery through `status --json`
- retained leftovers under `.buildplane/workspaces/<run-id>` not poisoning the next clean-tree preflight
- worktree creation from the exact pinned `headSha`

## Success criteria

This slice is successful when:

- Buildplane executes packet runs inside fresh git worktrees rather than the source repo root
- packet-relative cwd and output paths are confined to the worktree root
- the source checkout remains untouched by normal run execution
- dirty and non-git repos are rejected clearly before execution
- successful runs clean up their worktrees automatically
- failed runs retain their worktrees for operator inspection
- setup failures after run creation become explicit failed runs with infrastructure evidence
- workspace lifecycle is persisted durably in storage
- `status` and `inspect` surface workspace metadata and actionable leftovers cleanly
- Buildplane-managed `.buildplane/**` state does not make the repo fail its own clean-tree gate
- the full git-backed isolation flow and its core failure paths pass in automated tests

## Follow-on slices unlocked by this work

This design intentionally sets up later work without pulling it in now:

1. add explicit operator recovery and cleanup commands for retained worktrees
2. add concurrent-run coordination and repo-local lease/lock behavior
3. add interruption/crash recovery and stale-workspace reconciliation
4. replay a prior run into a fresh worktree from stored packet metadata
5. run model-backed workers inside the same isolated worktree boundary
