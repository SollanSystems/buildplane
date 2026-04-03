# Buildplane Design

**Date:** 2026-03-17
**Company (temporary):** SollanSystems
**Future umbrella brand:** Kiln
**Product:** Buildplane
**CLI:** `buildplane`
**Workspace scope:** `@buildplane/*`

## Vision

Buildplane is the control plane for autonomous software execution. It treats language models as bounded workers inside a deterministic execution kernel that owns scheduling, state, policies, verification, and recovery.

## Product Positioning

Buildplane is operator-first autonomy for serious builders. It is not a chat-first assistant. It is a system for dispatching typed units of work, collecting evidence, verifying outcomes, and giving the operator strong visibility and control over long-running autonomous software work.

## Core Naming Decisions

- Product name is **Buildplane**.
- Company attribution is **Buildplane by SollanSystems** for now.
- Future attribution becomes **Buildplane by Kiln**.
- CLI command is `buildplane`.
- Project-local state directory is `.buildplane/`.
- User-global state directory is `~/.buildplane/`.
- Internal package scope is `@buildplane/*`.
- GitHub repo now is `SollanSystems/buildplane`.
- Future repo can become `Kiln/buildplane` without changing product identity.

## State Model

Buildplane's source of truth is a **SQLite-backed event log** stored in `.buildplane/state.db` for project-local state and later mirrored into `~/.buildplane/` for user-global data. Events and projections live in the same database for Milestone 1.

This means:

- durable truth is structured state in SQLite
- events are append-only for Milestone 1
- projections / query tables are maintained in the same DB
- markdown, summaries, and reports are artifacts, not control-plane truth

## Minimum `.buildplane/` Layout

```text
.buildplane/
  state.db
  artifacts/
  evidence/
  runs/
  logs/
  project.json
```

`project.json` stores project-local metadata such as initialization state, active policy profile, and default run settings. It is structured config, not a general-purpose notes file.

## Architecture Layers

1. **Execution Kernel** — units, scheduler, orchestration lifecycle
2. **Runtime** — bounded worker/session execution and supervision
3. **Policy** — budgets, trust gates, retries, approvals, stop rules
4. **Storage** — durable state, artifacts, evidence, decisions, run history
5. **Operator Interface** — terminal-first status, inspect, replay, intervene

## Dependency Rules

- `apps/cli` may depend on any package for composition and command wiring.
- `packages/kernel` must not depend on UI or adapter packages. It defines core orchestration types and ports.
- `packages/storage` may depend on `@buildplane/kernel` contracts only. It owns persistence and query models.
- `packages/policy` may depend on `@buildplane/kernel` and storage read models only. It evaluates evidence and decides whether a unit may advance.
- `packages/runtime` may depend on `@buildplane/kernel`, `@buildplane/storage`, `@buildplane/policy`, and adapter packages. It runs workers, gathers receipts, and emits evidence.
- `packages/ui-tui` may depend on storage query APIs and kernel read models. It must not directly own execution logic.
- `packages/adapters-*` may depend on `@buildplane/kernel` types and runtime-facing contracts only. They must not depend on `@buildplane/ui-tui`, and they should avoid direct storage writes except through runtime-owned interfaces.
- `packages/compat-gsd` is a migration bridge only. It may depend on `@buildplane/storage` import/write contracts plus kernel domain identifiers where needed, but it is intentionally isolated from the core runtime path and is not a Milestone 1 dependency.

## Verification Ownership

Verification is a first-class concern.

- `runtime` gathers receipts, command results, tool outputs, and other raw evidence.
- `policy` evaluates whether the evidence satisfies the contract for a unit.
- `kernel` advances only when policy marks the unit outcome as acceptable.

This keeps evidence collection, judgment, and orchestration separate.

## Isolation Primitive for Milestone 1

Milestone 1 uses **git worktree isolation** as the primary execution isolation primitive for git-backed projects. Non-git project isolation is a later concern.

## Repo Structure

```text
buildplane/
  package.json
  pnpm-workspace.yaml
  tsconfig.base.json
  .gitignore
  apps/
    cli/
  packages/
    kernel/
    storage/
    runtime/
    policy/
    ui-tui/
    adapters-models/
    adapters-tools/
    adapters-git/
    compat-gsd/
  docs/
    architecture/
    superpowers/specs/
    superpowers/plans/
```

## Package Responsibilities

- `apps/cli` — command surface and wiring
- `packages/kernel` — `Unit`, `Run`, scheduler, orchestration ports
- `packages/storage` — SQLite/event log, artifact/evidence/decision records, queries
- `packages/runtime` — worker/session lifecycle, timeout handling, evidence capture
- `packages/policy` — autonomy constraints and gates
- `packages/ui-tui` — terminal operator surfaces
- `packages/adapters-models` — provider integration and routing
- `packages/adapters-tools` — browser/mac/bg-shell/search/MCP adapters behind common tool contracts
- `packages/adapters-git` — worktree and repo isolation
- `packages/compat-gsd` — import bridge from `.gsd/`

## Canonical Domain Entities

- `Run` — one end-to-end execution attempt under a policy profile
- `Unit` — a bounded piece of work
- `Artifact` — a durable produced output
- `Evidence` — objective signal about reality
- `Decision` — a recorded judgment or routing choice
- `Replay` — a re-execution of a prior unit with preserved context inputs

## Initial Command Surface

- `buildplane init` — initialize `.buildplane/` for the current project and write `project.json`
- `buildplane run [--unit <unit-id> | --packet <path>]` — execute the next eligible unit or a specified unit packet
- `buildplane status [--json]` — show active run state and queue summary as a table or JSON
- `buildplane inspect <run-id|unit-id> [--json]` — show unit, artifact, decision, and evidence history
- `buildplane replay <run-id>` — rerun a prior unit as a new `Run` with recorded inputs and policy context
- `buildplane import-gsd <path>` — ingest legacy `.gsd/` materials as Buildplane artifacts

## Milestone 1 Goal

Buildplane can run one bounded unit of autonomous software work in an isolated git worktree, capture evidence, verify the result, persist durable state, and allow operator inspection and replay.

## Non-Goals for Milestone 1

- parallel orchestration
- memory engine
- marketplace / plugin ecosystem
- enterprise policy suite
- full visualizer
- broad compatibility with GSD internals
- long-lived conversational transcript as system state

## Rationale

This approach avoids both long-lived merge debt with GSD-2 and the waste of a blank-slate rewrite. Buildplane gets a new execution kernel and state model while selectively porting valuable lower-level infrastructure from the existing codebase.
