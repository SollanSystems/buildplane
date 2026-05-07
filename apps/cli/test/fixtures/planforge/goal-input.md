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
