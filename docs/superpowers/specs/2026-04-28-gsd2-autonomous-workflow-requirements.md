# GSD-2 Autonomous Workflow Requirements

## Slice name

GSD-2 V0 docs and schema contract

## Status

Proposed V0 contract plus Milestone 1 non-executing CLI skeleton. This slice defines the workflow contract and ships repo-local state, validation, status, and dry-run preview surfaces; it does not implement an execution backend.

## Context packet

GSD-2 is the repo-local operating layer for autonomous work. It turns ambiguous goals into bounded, verifiable, replayable task records without creating another chat shell or competing coding skill.

Current Buildplane truth this contract depends on:

- Buildplane is the deterministic control plane for autonomous software execution.
- Buildplane's high-trust operator loop is `run -> inspect -> replay/fork/recover`.
- `buildplane ledger replay --run-id <id> --workspace <path>` is read-only tape replay; it reports ledger truth and does not independently verify external git/filesystem truth.
- `buildplane fork <parent-run-id> --at <unit-started-event-id> --packet <file> [--workspace <path>]` is the recovery primitive for re-executing from a unit boundary with a corrected packet.
- Repo-development and in-repo built CLI paths are broader than the verified published/global install contract; published/global native memory remains outside the verified package contract unless a native binary is separately discoverable.

Operator workflow truth this contract depends on:

- `/auto-coder` remains the single operator-facing front door for serious autonomous coding/build work.
- `task-kernel` and worktree-kernel own deterministic local slice execution, receipts, staged review, and fail-closed finalization.
- Buildplane owns serious-mode provenance, event tape, inspect/replay/fork/recovery, and worker-agnostic control-plane trust.
- tmux provides process continuity only; it is not a verifier, sandbox, or policy gate.
- Static analysis tools such as fallow produce evidence inputs; they do not get automatic delete/refactor authority.

## Problem

Autonomous coding workflows currently spread state across chat transcripts, skills, worktrees, plans, Buildplane runs, kernel receipts, and operator memory. That works for small tasks, but it becomes hard to answer boring operational questions:

- What work exists?
- Why is this task safe to run?
- Which repo and source of truth are authoritative?
- What paths and tools are allowed?
- Which backend should execute it?
- What verification evidence is required?
- What failed, and what is the safe recovery path?
- Is a final `PASSED` claim actually supported by evidence?

GSD-2 exists to make those questions explicit in repo-local state before execution starts.

## Product purpose

GSD-2 turns intent into bounded, replayable, evidence-backed autonomous work.

The system is successful when an operator can move from a vague goal to a task envelope, route preview, execution record, verification receipt, and recovery reference without trusting an unstructured chat transcript as the system of record.

## Non-goals

GSD-2 V0 must not:

- replace `/auto-coder` as the operator-facing serious coding front door
- become another agent shell or prompt runner
- implement a new model/provider abstraction
- bypass worktree-kernel or Buildplane verification gates
- treat tmux as correctness infrastructure
- automatically delete/refactor code based on static analysis
- deploy, push, publish, rotate secrets, or mutate production
- claim `PASSED` without verification and acceptance evidence
- make published/global Buildplane installs look equivalent to repo-development or in-repo built CLI paths

## V0 goals

1. Define the minimal repo-local `.gsd2` state contract.
2. Define task IDs, task lifecycle states, task envelope schema, and receipt schema.
3. Define the ownership boundaries between GSD-2, `/auto-coder`, worktree-kernel, Buildplane, tmux, skills, and static tools.
4. Define route selection semantics for planning-only, direct, worktree-kernel, Buildplane, and manual recovery work.
5. Define fail-closed receipt semantics for `PASSED`, `BLOCKED`, and `FAILED`.
6. Define and include the Milestone 1 CLI skeleton target in this slice, without implementing the full execution backend.

## Minimal `.gsd2` layout

V0 only needs this layout:

```text
.gsd2/
  PROJECT.md
  STATE.md
  QUEUE.md
  config.yaml
  tasks/<id>/task.md
  tasks/<id>/envelope.yaml
  tasks/<id>/receipt.yaml
```

Everything else, including run transcripts, command logs, acceptance matrices, and backend-specific evidence bundles, can be added after the basic contract is stable.

## Task ID requirements

Task IDs must be:

- monotonic per repo
- never reused
- human-readable
- stable across retries, replays, forks, and backend migrations
- separate from backend run IDs

Required V0 format:

```text
G2-0001
G2-0002
G2-0003
```

## Lifecycle requirements

A GSD-2 task must use one of these lifecycle states:

- `NEW` — captured but not admitted
- `READY` — admitted and has enough context/envelope to route
- `RUNNING` — execution backend has accepted the task
- `VERIFYING` — implementation is done enough to run evidence checks
- `PASSED` — verification and acceptance are complete with no unresolved material findings
- `BLOCKED` — cannot safely continue without new information, environment repair, or operator decision
- `FAILED` — completed attempt did not meet the contract and should not be retried automatically
- `RETRYING` — bounded remediation is underway after a failed/blocked attempt
- `ESCALATED` — operator intervention or stronger review is required

`PASSED` is forbidden unless all fail-closed criteria are satisfied.

## Task envelope requirements

Every executable task must have an envelope with:

- `id`
- lifecycle metadata: `status`, `created_at`, `updated_at`
- one-sentence `goal`
- repo authority: path, base ref, expected remote, and source-of-truth note
- context packet: source docs, assumptions, unresolved questions
- scope: allowed paths, forbidden paths, out-of-scope items
- routing: route mode, front door, backend, model/tool policy
- done-when acceptance outcomes
- verification commands and stop-on-failure behavior
- review tier requirements
- recovery plan and max attempts

V0 may store the envelope as YAML. Later versions may add JSON schema validation or generated TypeScript types.

## Receipt requirements

Every task must have a receipt with:

- `task_id`
- optional backend `run_id`
- final status: `PASSED`, `BLOCKED`, or `FAILED`
- exact verification commands run
- verification results with exit codes when available
- acceptance criteria checked
- evidence refs, including file paths, artifact paths, run IDs, or ledger links
- unresolved findings
- recovery next step
- timestamp and checked-by actor

A receipt is not a success claim. It is an evidence-backed status claim.

## Routing requirements

GSD-2 must support these route modes:

- `planning_only` — docs/spec/strategy work with no execution
- `direct` — small, low-risk edits handled by the current operator session
- `worktree_kernel` — deterministic local worktree, task packet, verification, staged review, and receipts
- `buildplane` — serious-mode event tape, provenance, inspect/replay/fork/recovery, and worker-agnostic execution
- `manual_recovery` — operator-directed recovery after contradictory state or unsafe automation conditions

Route selection must prefer the smallest route that can produce required evidence.

## Fail-closed requirements

A task may claim `PASSED` only when:

- required verification ran
- acceptance criteria were explicitly checked
- spec-derived acceptance items have passing receipts when present
- no material reviewer findings remain unresolved
- evidence artifacts match the claim
- the route's known capability limits are disclosed

If any required check did not run, status is `BLOCKED` or `FAILED`, not `PASSED`.

## Buildplane contract distinction requirement

GSD-2 docs and receipts must distinguish these Buildplane paths:

1. Repo-development CLI path, for example `pnpm buildplane ...` from the repo root.
2. In-repo built CLI path, for example `node apps/cli/dist/index.js ...` after `pnpm build`.
3. Published/global install path, for example `buildplane ...` after installation.

A receipt must not use evidence from one path to overclaim another path. Native-backed memory and ledger capabilities must be named as repo-local or native-binary-dependent unless the published/global contract is explicitly verified.

## Static-analysis requirements

Static tools such as fallow may provide evidence for candidate dead code, duplicate logic, dependency cycles, and complexity hotspots. They may not mutate code or authorize deletion by themselves. Any cleanup/refactor still requires a task envelope, acceptance criteria, tests, and explicit operator approval when destructive or high-risk.

## V0 success criteria

GSD-2 V0 is successful when:

- a repo can contain the minimal `.gsd2` files without code execution
- a task can be represented with a stable ID, envelope, and receipt
- the route preview can tell the operator whether the task should use planning-only, direct, worktree-kernel, Buildplane, or manual recovery
- fail-closed status rules are explicit enough that weak green claims are rejected
- the Milestone 1 CLI skeleton can be implemented from the tasks doc without guessing the ownership model

## Acceptance criteria for this documentation slice

- Requirements define GSD-2 purpose, non-goals, and success criteria.
- Design defines ownership boundaries between GSD-2, `/auto-coder`, worktree-kernel, Buildplane, tmux, skills, and fallow/static tools.
- Tasks define Milestone 1 CLI skeleton as the first implementation target.
- Docs explicitly prohibit competing with `/auto-coder`.
- Docs distinguish Buildplane repo-dev, built CLI, and published/global install contracts.
- Docs define failure states and fail-closed receipt semantics.
- Milestone 1 code implementation is limited to non-executing repo-local state creation, validation, and dry-run preview surfaces.
