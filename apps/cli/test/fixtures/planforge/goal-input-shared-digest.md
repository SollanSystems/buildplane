# PlanForge dry-run goal fixture — shared acceptance digest

PlanForge is Buildplane's trusted plan-admission surface: it converts an operator goal/spec into a reviewable implementation plan, task graph, and admission receipt before any worker receives write capabilities.

This fixture deliberately declares two tasks with IDENTICAL allowed-side-effects and verification-commands so they re-derive the SAME acceptance contract digest — the M6-F1 consume-once regression case.

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

### SD1: Spec PlanForge contracts and fixture artifacts

- Objective: Define the narrow documentation-level PlanForge contracts plus deterministic dry-run fixtures.
- Assignee-hint: auto-coder
- Workspace: isolated-worktree
- Allowed-side-effects: local-doc, local-fixture
- Forbidden-side-effects: execute-code, board-write, network-write, push, deploy, merge
- Depends-on:
- Acceptance-criteria:
  - Define PlanForgeInput, PlanForgePlan, PlanForgeTask, PlanForgeValidation, and PlanForgeReceipt at documentation/fixture level.
  - State dry-run/no-side-effect behavior.
- Verification-commands:
  - git status --short --branch
  - git diff --check
  - pnpm lint

### SD2: Document PlanForge review artifacts

- Objective: Document the reviewable PlanForge artifacts alongside SD1 with the same least-privilege surface.
- Assignee-hint: auto-coder
- Workspace: isolated-worktree
- Allowed-side-effects: local-doc, local-fixture
- Forbidden-side-effects: execute-code, board-write, network-write, push, deploy, merge
- Depends-on: SD1
- Acceptance-criteria:
  - Document the PlanForge review artifacts at documentation/fixture level.
  - State dry-run/no-side-effect behavior.
- Verification-commands:
  - git status --short --branch
  - git diff --check
  - pnpm lint
