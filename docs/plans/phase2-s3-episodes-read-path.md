# Phase 2 · S3 — Episodes Read Path — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development (or executing-plans). Steps use `- [ ]` checkboxes.

**Goal:** Expose the existing `events` log through a read path: add `listEvents({ runId, limit? })` to `BuildplaneStoragePort`, implement it via `EventStore.getEventsByRunId`, and add a `memory episodes <runId>` CLI subcommand with `--json` parity.

**Why:** `memory` shipped `facts`/`procedures` but not `episodes` — `getStatusSnapshot()`/`inspectTarget()` cannot list events, so the episodic layer is write-only from the operator's view.

**Tech Stack:** TypeScript (ESM, `.js` specifiers), Node ≥24.13, vitest, `@buildplane/storage`, `@buildplane/kernel`.

## Opus Planning Reference (handoff contract)

- **Slice ID:** `phase2-s3-episodes-read-path`
- **Phase:** 2 · Track 1 — **lands FIRST** (sole `ports.ts` editor; S2/S1 rebase after).
- **Branch base:** cut worktree from `origin/main` (hard invariant). Last verified tip: `6391e17`.
- **Frozen contract excerpt** (authority: `docs/plans/phase2-memory-contract.md`):
  - ADD to `BuildplaneStoragePort` (`packages/kernel/src/ports.ts`, after :153): `listEvents(options: { runId: string; limit?: number }): readonly ExecutionEvent[];` — **runId is required** (matches `EventStore.getEventsByRunId`; no global-list method exists).
  - Implement in `packages/storage/src/store.ts` via the existing `EventStore.getEventsByRunId` (`event-store.ts:13`).
  - `memory` dispatch (`run-cli.ts:3496`) gains a `subcommand === "episodes"` branch after :3752; reuse `formatters.ts`.
- **Off-limits:** any other port signature; table DDL; `EventStore` internals beyond calling `getEventsByRunId`; the `facts`/`procedures` branches.
- **Merge eligibility:** narrow + green → `buildplane:auto-merge`. This is the **only** Track-1 slice touching `ports.ts`.
- **Verify command:** `pnpm -C <worktree> exec vitest run packages/storage/test apps/cli/test/run-cli.test.ts` (cwd = repo root). **Then the gate:** full suite `pnpm -C <worktree> exec vitest run` + `pnpm -C <worktree> lint` + add a changeset.

## Verify-first (BEFORE implementation)

- [ ] **VF-1:** Read `event-store.ts:11–26` — confirm `ExecutionEvent` shape and the exact `getEventsByRunId(runId)` signature/return type. Record whether it already returns newest-first or needs sorting/limit applied in the store.
- [ ] **VF-2:** Read `run-cli.ts:3496–3752` — confirm the `memory` dispatch shape and the exact insertion point + how `facts`/`procedures` parse args and `--json`. Confirm `episodes <runId>` requiring a positional runId is acceptable UX (error cleanly when omitted).
- [ ] **VF-3:** Confirm `formatters.ts` has (or needs) an events formatter; reuse the facts/procedures table style.

## File Structure

- `packages/kernel/src/ports.ts` — **modify:** add `listEvents` to `BuildplaneStoragePort` (after :153). Import `ExecutionEvent` if not already in scope.
- `packages/storage/src/store.ts` — **modify:** implement `listEvents` via `EventStore.getEventsByRunId` (apply `limit` if provided).
- `packages/storage/test/…` — **new/modify:** unit test for `listEvents`.
- `apps/cli/src/run-cli.ts` — **modify:** add `episodes` subcommand to `memory` dispatch.
- `apps/cli/src/formatters.ts` — **modify/reuse:** events formatter.
- `apps/cli/test/run-cli.test.ts` — **modify:** integration test for `memory episodes <runId>` (table + `--json`).

## Tasks (TDD)

- [ ] **T1 — port method + store impl.** Failing test: `listEvents({ runId })` returns the events recorded for that run (and `limit` caps the count). Implement on the store delegating to `EventStore.getEventsByRunId`.
- [ ] **T2 — CLI subcommand.** Failing integration test: `memory episodes <runId>` prints an events table; `--json` emits structured JSON; missing `<runId>` exits non-zero with a clear message.

## Acceptance criteria

- `BuildplaneStoragePort.listEvents({ runId, limit? })` returns that run's events; `limit` respected.
- `memory episodes <runId>` lists events (table + `--json` parity with `facts`/`procedures`); missing runId errors cleanly.
- No existing port signature/DDL changed. Full suite + lint green; changeset added.
