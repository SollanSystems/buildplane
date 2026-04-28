# GSD-2 Autonomous Workflow Implementation Plan

> **For Hermes:** Use subagent-driven-development or worktree-kernel only after Milestone 1 is explicitly selected. This plan starts with a docs/schema contract and then a CLI skeleton that cannot execute workers.

**Goal:** Implement GSD-2 V0 as a repo-local autonomous-work state layer that can create, validate, and preview task envelopes before any execution backend is wired.

**Architecture:** Keep `/auto-coder` as the operator-facing front door, use GSD-2 for repo-local state and route preview, use worktree-kernel for deterministic local execution later, and use Buildplane for serious-mode provenance/replay/recovery later. Milestone 1 is intentionally non-executing: it can write `.gsd2` files and validate schemas, but it cannot spawn workers or mutate production systems.

**Tech Stack:** TypeScript/Node 24.13.1+, pnpm, Vitest, Biome, YAML/Markdown file contracts, git worktrees. Future milestones may bridge to worktree-kernel and Buildplane.

---

## Source docs

- Requirements: `docs/superpowers/specs/2026-04-28-gsd2-autonomous-workflow-requirements.md`
- Design: `docs/superpowers/specs/2026-04-28-gsd2-autonomous-workflow-design.md`
- North-star planning source: `/mnt/c/Dev/.hermes/plans/2026-04-28_162635-gsd2-full-auto-north-star.md`

## Milestone 1 implementation status

- [x] Add `pnpm gsd2` source command and package bin metadata.
- [x] Implement `gsd2 status` as read-only state inspection.
- [x] Implement `gsd2 new` for minimal `.gsd2` task creation.
- [x] Implement `gsd2 validate` for envelope/receipt checks.
- [x] Implement `gsd2 run --dry-run <task-id>` without worker execution.
- [x] Add focused tests for schema validation and no-execution CLI behavior.

Milestone 1 remains bounded to state creation, validation, and route preview. It does not call Buildplane run dispatch, worktree-kernel wrappers, tmux, or model workers.

## Task envelope for the first executable code milestone

**Milestone:** GSD-2 Milestone 1 — CLI skeleton, no execution

**Allowed future implementation scope:**

- CLI entrypoint location selected by the implementer after inspecting current package boundaries
- schema/types module for GSD-2 envelopes and receipts
- filesystem adapter for `.gsd2` layout
- tests for status/new/validate/dry-run behavior
- docs updates for the new CLI skeleton

**Forbidden future implementation scope:**

- worker execution
- direct worktree-kernel calls
- Buildplane run packet execution
- tmux session creation
- static-analysis-driven code deletion
- push, deploy, publish, or secret edits

**Required final verification for Milestone 1:**

```bash
pnpm exec vitest --run <new-gsd2-test-files>
pnpm lint
pnpm typecheck
pnpm build
git diff --check
```

If Milestone 1 touches existing Buildplane CLI dispatch or package exports, also run the focused existing CLI tests that cover those areas.

---

## Phase A: Contract and schemas

### Task A1: Land the GSD-2 requirements doc

**Objective:** Define GSD-2 purpose, non-goals, success criteria, lifecycle states, receipt rules, and Buildplane contract distinctions.

**Files:**

- Create: `docs/superpowers/specs/2026-04-28-gsd2-autonomous-workflow-requirements.md`

**Steps:**

1. Write the requirements doc.
2. Confirm it explicitly prohibits replacing `/auto-coder`.
3. Confirm it distinguishes repo-development, in-repo built CLI, and published/global Buildplane contracts.
4. Confirm it defines `NEW`, `READY`, `RUNNING`, `VERIFYING`, `PASSED`, `BLOCKED`, `FAILED`, `RETRYING`, and `ESCALATED`.
5. Confirm it defines fail-closed receipt semantics.
6. Run `git diff --check`.

**Expected result:** Requirements are reviewable as a standalone product contract.

### Task A2: Land the GSD-2 design doc

**Objective:** Define ownership boundaries and the minimal `.gsd2` state/envelope/receipt schema.

**Files:**

- Create: `docs/superpowers/specs/2026-04-28-gsd2-autonomous-workflow-design.md`

**Steps:**

1. Write the design doc.
2. Confirm ownership boundaries are present for GSD-2, `/auto-coder`, task-kernel/worktree-kernel, Buildplane, tmux, skills, and static tools.
3. Confirm the minimal `.gsd2` layout is present.
4. Confirm `envelope.yaml` and `receipt.yaml` shapes are specified.
5. Confirm route modes are specified: `planning_only`, `direct`, `worktree_kernel`, `buildplane`, `manual_recovery`.
6. Run `git diff --check`.

**Expected result:** Design is detailed enough to implement Milestone 1 without guessing the boundaries.

### Task A3: Land this implementation plan

**Objective:** Define the implementation sequence, with Milestone 1 as the first code target.

**Files:**

- Create: `docs/superpowers/plans/2026-04-28-gsd2-autonomous-workflow-implementation.md`

**Steps:**

1. Write the implementation plan.
2. Confirm Phase B is a CLI skeleton with no execution.
3. Confirm later phases separate worktree-kernel and Buildplane bridges.
4. Run `git diff --check`.

**Expected result:** The next operator can start Milestone 1 from a bounded task list.

---

## Phase B: Milestone 1 CLI skeleton, no execution

Milestone 1 is the first implementation target after the docs slice. It must be implemented in a fresh isolated worktree from the accepted docs branch or current `origin/main` after the docs are merged.

### Task B1: Decide CLI location and add tests for command discovery

**Objective:** Pick the least invasive location for a `gsd2` command without disrupting Buildplane's existing operator surface.

**Files:**

- Inspect: `package.json`
- Inspect: `apps/cli/package.json`
- Inspect: `apps/cli/src/index.ts`
- Test: new focused CLI discovery test file based on chosen location

**Steps:**

1. Inspect existing CLI package boundaries.
2. Choose one V0 location:
   - a new repo-local package if the repo already supports workspace CLI packages cleanly, or
   - an `apps/cli` subcommand/entrypoint if that is the narrowest change.
3. Write a failing test proving the chosen `gsd2` command can print help without initializing or mutating `.gsd2`.
4. Implement the minimum command discovery surface.
5. Run the focused test.

**Acceptance:** `gsd2 --help` or the chosen equivalent is available and side-effect-free.

### Task B2: Add schema/types for envelopes and receipts

**Objective:** Represent the V0 envelope and receipt contracts in code.

**Files:**

- Create/modify: schema/types file chosen by Task B1
- Test: schema validation tests

**Steps:**

1. Add tests for valid minimal envelope and receipt objects.
2. Add tests rejecting missing `id`, invalid status, missing `goal`, invalid route mode, and invalid final status.
3. Implement the schema/types and validator helpers.
4. Run focused schema tests.

**Acceptance:** The code can validate V0 envelopes and receipts without executing any backend.

### Task B3: Implement `.gsd2 status`

**Objective:** Show repo-local GSD-2 state without mutating it.

**Files:**

- Modify: chosen CLI command implementation
- Test: focused status command tests

**Steps:**

1. Add tests for status when `.gsd2` is missing.
2. Add tests for status when `.gsd2/STATE.md` and `QUEUE.md` exist.
3. Implement read-only status behavior.
4. Ensure missing state exits clearly without creating files.
5. Run focused status tests.

**Acceptance:** Status is read-only, terminal-safe, and clear about missing or present state.

### Task B4: Implement `.gsd2 new`

**Objective:** Create the minimal `.gsd2` layout and allocate the next monotonic task ID.

**Files:**

- Modify: chosen CLI command implementation
- Test: focused new command tests

**Steps:**

1. Add tests for initializing `.gsd2` files when absent.
2. Add tests for monotonic task ID allocation starting at `G2-0001`.
3. Add tests proving existing task IDs are not reused.
4. Implement file creation for `task.md`, `envelope.yaml`, and `receipt.yaml`.
5. Run focused new command tests.

**Acceptance:** `gsd2 new` creates a task record but does not execute workers.

### Task B5: Implement `.gsd2 validate`

**Objective:** Validate existing GSD-2 files and report actionable errors.

**Files:**

- Modify: chosen CLI command implementation
- Test: focused validate command tests

**Steps:**

1. Add tests for a valid task directory.
2. Add tests for malformed envelope status.
3. Add tests for invalid receipt final status.
4. Add tests for missing task files.
5. Implement validation with terminal-safe output and JSON output if existing CLI conventions make that cheap.
6. Run focused validate tests.

**Acceptance:** Validate reports pass/fail and precise file-level errors without mutating state.

### Task B6: Implement `.gsd2 run --dry-run`

**Objective:** Preview route selection and required evidence without executing a worker.

**Files:**

- Modify: chosen CLI command implementation
- Test: focused dry-run tests

**Steps:**

1. Add tests for `planning_only` route preview.
2. Add tests for `worktree_kernel` route preview.
3. Add tests for `buildplane` route preview.
4. Add tests proving dry-run does not call worker, Buildplane, tmux, or worktree-kernel APIs.
5. Implement dry-run preview from `envelope.yaml`.
6. Run focused dry-run tests.

**Acceptance:** The route preview names the front door, backend, required verification, and recovery options, but performs no execution.

### Task B7: Add Milestone 1 docs and final verification

**Objective:** Make the CLI skeleton discoverable and prove it remains bounded.

**Files:**

- Modify: README or a dedicated docs page if appropriate
- Modify: tests if contract coverage is needed

**Steps:**

1. Document the non-executing Milestone 1 command surface.
2. Document that `/auto-coder` remains the serious coding front door.
3. Document that `gsd2 run --dry-run` is preview-only.
4. Run focused tests.
5. Run `pnpm lint`.
6. Run `pnpm typecheck`.
7. Run `pnpm build`.
8. Run `git diff --check`.

**Acceptance:** Milestone 1 is verified and cannot be mistaken for an execution backend.

---

## Phase C: worktree-kernel bridge

Start only after Milestone 1 is accepted.

Planned tasks:

- Map `envelope.yaml` to a worktree-kernel task packet.
- Add `gsd2 kernel prepare --dry-run` route preview.
- Add guarded `gsd2 kernel prepare` only after dry-run contract is accepted.
- Add guarded `gsd2 kernel run` only after prepare receipts are stable.
- Store kernel evidence refs in `receipt.yaml`.
- Preserve fail-closed finalization semantics from worktree-kernel.

Exit gate:

- one local repo task can go from envelope to verified kernel receipt without overclaiming success.

## Phase D: Buildplane bridge

Start only after the local kernel bridge is accepted or when a serious-mode run explicitly needs event tape and replay.

Planned tasks:

- Map `envelope.yaml` to a Buildplane packet.
- Validate clean git preconditions.
- Add dry-run preview for Buildplane packet generation.
- Add guarded Buildplane run dispatch.
- Capture run ID, inspect command, replay command, and fork command in `receipt.yaml`.
- Store path-specific capability notes: repo-dev, in-repo built CLI, or published/global.

Exit gate:

- one serious-mode run is inspectable and replayable from GSD-2 state.

## Phase E: tmux and unattended ergonomics

Start only after execution bridges are trustworthy.

Planned tasks:

- Define deterministic session names.
- Start detached sessions for long verified backend commands.
- Persist logs.
- Add attach/tail helpers.
- Add safe kill/cleanup helpers.

Exit gate:

- long GSD-2 runs survive terminal disconnect and can be inspected from logs and receipts.

## Phase F: analysis adapters

Start only after the task/route/receipt base is stable.

Planned tasks:

- Add repo language/tool detector.
- Add fallow adapter for TS/JS evidence.
- Add ruff/pytest detector for Python.
- Add cargo detector for Rust.
- Add static-analysis evidence refs to route preview and receipts.

Exit gate:

- static tools can propose evidence-backed tasks without mutating code or authorizing deletion.

## Completion checklist for this docs slice

- [x] Requirements define GSD-2 purpose, non-goals, and success criteria.
- [x] Design defines ownership boundaries between GSD-2, `/auto-coder`, worktree-kernel, Buildplane, tmux, skills, and fallow/static tools.
- [x] Tasks define Milestone 1 CLI skeleton as the first implementation target.
- [x] Docs explicitly prohibit competing with `/auto-coder`.
- [x] Docs distinguish Buildplane repo-dev, built CLI, and published/global install contracts.
- [x] Docs define failure states and fail-closed receipt semantics.
- [x] Milestone 1 code implementation is limited to non-executing repo-local state creation, validation, and dry-run preview surfaces.
