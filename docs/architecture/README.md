# Buildplane Architecture

Buildplane is an operator-first control plane for autonomous software execution. The current repo has two architecture tracks:

- the active TypeScript control plane under the pnpm workspace
- the Rust-first native workspace under `native/`, which still owns the active memory implementation while broader host-aware runtime work remains a scaffold

Core product split:

- Buildplane is the umbrella system
- SuperClaude and SuperCodex are packs inside Buildplane
- packs are not hosts
- hosts are not providers

Current TypeScript workspace:

- `apps/cli` — user-facing command surface
- `packages/kernel` — units, scheduler, orchestration
- `packages/storage` — durable state and evidence
- `packages/runtime` — worker/session lifecycle
- `packages/policy` — budgets, trust, retries, approvals
- `packages/ui-tui` — operator terminal surfaces
- `packages/adapters-*` — model, tool, and git integration layers
- `packages/compat-gsd` — import bridge from `.gsd/`

Native workspace:

- `native/` — Rust-first workspace kept separate from the live pnpm root; it currently owns the active memory implementation while broader host-aware runtime work continues there
- `docs/architecture/rust-native-host-runtime.md` — rationale, dependency boundaries, and migration intent for the native workspace

Supporting architecture docs:

- `docs/architecture/buildplane-package-architecture.md` — umbrella system, pack model, dependency boundaries, and migration guidance
- `docs/architecture/buildplane-memory-schema.md` — concrete layered memory model and SQLite schema
- `docs/architecture/buildplane-memory-cli.md` — operator-facing memory CLI contract, including the current `apps/cli/src/run-cli.ts` bridge for `buildplane memory ...`
