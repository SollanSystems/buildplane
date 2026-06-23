# PlanForge dry-run goal fixture

PlanForge is Buildplane's trusted plan-admission surface: it converts an operator goal/spec into a reviewable implementation plan, task graph, and admission receipt before any worker receives write capabilities.

## Goal

Create a local-first PlanForge dry-run slice for Buildplane that accepts this goal fixture, validates the trusted boundary, and emits a reviewable plan JSON fixture without executing code or writing board tasks.

## Repository context

- Remote: https://github.com/SollanSystems/buildplane.git
- Trusted base: 15dbb32db0e1f0024687533755805fc23f3ef6d4
- Worktree policy: isolated-worktree-required

## Safety constraints

- Dry-run only.
- Buildplane kernel validates and admits plans.
- Coding agents are untrusted workers.
- No Kanban, GSD2, GitHub, network, push, PR, deploy, merge, or worker-spawn side effects.
- Idempotent repeated planning for the same normalized input, trusted base, and evidence set.

## Required output

Emit a deterministic PlanForgePlan with a PlanForgeValidation and PlanForgeReceipt preview. The only acceptable pass state is PASS. Missing evidence must produce INSUFFICIENT_EVIDENCE. Unsafe side-effect requests must produce UNSAFE_TO_RUN.

## Tasks

### PF1: Spec PlanForge contracts and fixture artifacts

- Objective: Define the narrow documentation-level PlanForge contracts plus deterministic dry-run fixtures.
- Assignee-hint: auto-coder
- Workspace: isolated-worktree
- Allowed-side-effects: local-doc, local-fixture
- Forbidden-side-effects: execute-code, board-write, network-write, push, deploy, merge
- Depends-on:
- Acceptance-criteria:
  - Define PlanForgeInput, PlanForgePlan, PlanForgeTask, PlanForgeValidation, and PlanForgeReceipt at documentation/fixture level.
  - State that the Buildplane kernel validates and admits plans while coding agents remain untrusted workers.
  - State dry-run/no-side-effect behavior.
  - Define PASS, BLOCKED, FAILED, INSUFFICIENT_EVIDENCE, and UNSAFE_TO_RUN failure/pass states.
  - Define idempotency key semantics for repeated planning.
- Verification-commands:
  - git status --short --branch
  - git diff --check
  - pnpm lint

### PF2: Implement PlanForge dry-run CLI and schema validation

- Objective: Add a later dry-run command that validates local input and emits stable JSON without storage, board, network, or worker side effects.
- Assignee-hint: auto-coder
- Workspace: isolated-worktree
- Allowed-side-effects: local-doc, local-fixture, local-receipt
- Forbidden-side-effects: execute-code, board-write, network-write, push, deploy, merge
- Depends-on: PF1
- Acceptance-criteria:
  - Missing input fails closed before any write.
  - Invalid input fails closed before any write.
  - Unsupported non-dry-run forms fail with a clear message.
  - Output is stable JSON suitable for review.
- Verification-commands:
  - pnpm vitest --run apps/cli/test/run-cli.test.ts -t planforge
  - pnpm typecheck
  - git diff --check
