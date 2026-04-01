# Buildplane Architecture

Buildplane is an operator-first control plane for autonomous software execution. The initial architecture is organized around a deterministic execution kernel with explicit units of work, durable storage, policy enforcement, bounded worker runtime, and a terminal-first operator interface.

Primary packages:

- `apps/cli` — user-facing command surface
- `packages/kernel` — units, scheduler, orchestration
- `packages/storage` — durable state and evidence
- `packages/runtime` — worker/session lifecycle
- `packages/policy` — budgets, trust, retries, approvals
- `packages/ui-tui` — operator terminal surfaces
- `packages/adapters-*` — model, tool, and git integration layers
- `packages/compat-gsd` — import bridge from `.gsd/`
