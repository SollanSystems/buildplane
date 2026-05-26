# Phase 2 · S5 — Scoring Aggregation + routingHints Producer — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development (or executing-plans). Steps use `- [ ]` checkboxes.

**Goal:** Close the outcome-memory loop. Aggregate run outcomes into `outcome_scores`, and add a **producer** that fills `routingHints.preferredWorker` from those scores at packet-prep — **before** `orchestrator.ts:1133` snapshots `ctx.validatedPacket.routingHints` — so the recorded route equals the actual route. Fill-not-override, with min-sample + ε-exploration + recency-decay.

**Why:** S4 stores scores; nothing produces them or uses them yet. Codex R1 proved the late `runtimeRouter` hook diverges route-vs-record and poisons the very scores the feature depends on — hence the upstream packet-prep seam.

**Tech Stack:** TypeScript (ESM, `.js`), Node ≥24.13, vitest, `@buildplane/kernel`, `@buildplane/storage`.

> **⛔ Codex gate R2 (2026-05-26) — REDESIGN REQUIRED, NOT dispatch-ready.** The producer
> integration is mis-placed and underspecified:
> - **The hook is too late.** `prepareRun()` persists `unit_snapshot` via `createRun()` at
>   `orchestrator.ts:689` (store.ts:1954); the recorded route is read back from
>   `runs.unit_snapshot` (store.ts:3121+). Filling `routingHints` before `:1133` changes execution
>   but NOT the stored snapshot → recorded≠actual. Producer must run **before `createRun()`**.
> - **Outcome sources lack route data.** `runs`/`decisions`/`run-completed` events don't record the
>   worker used. Either aggregate in orchestrator finalization while `validatedPacket` is live, or
>   persist route metadata explicitly (couples to the S4 redesign).
> - **`taskType` is optional** (`UnitPacket.intent` optional; `taskType` lives in `intent`). Define a
>   required-intent invariant or a `unit.kind` fallback, else the grain key is null.
> - **Cold start/starvation.** Unhinted traffic routes to the SDK executor and never samples
>   claude-code/codex. ε must operate at zero-score with a defined candidate set, or the table never
>   warms.
> - **ε only when `preferredWorker` is absent** — never override an explicit hint (contract rule 3).
> Re-spec aggregation + hook placement against the S4 redesign, then re-run `/codex challenge`.

## Opus Planning Reference (handoff contract)

- **Slice ID:** `phase2-s5-scoring-aggregation-routing-producer`
- **Phase:** 2 · Track 2 — **serial, AFTER S4.** Re-verify tip at dispatch.
- **Branch base:** cut worktree from `origin/main` after S4 merges.
- **Frozen contract excerpt** (authority: `docs/plans/phase2-memory-contract.md`):
  - **Aggregation:** per `(repoId, taskType, preferredWorker)` from run outcomes; apply **recency decay**; require a **min sample count** before a score may steer routing.
  - **Producer hook:** at packet-prep **before `orchestrator.ts:1133`** snapshots `routingHints`. Query `outcome_scores` for `(repoId, taskType)`; **only if `routingHints.preferredWorker` is absent**, fill it; else leave the explicit value. With probability **ε**, pick an under-sampled worker (exploration). **No late mutation** anywhere downstream (not `runtimeRouter`).
  - **Invariants:** `repoId = projectRoot`. Recorded route == actual route. Grain = `preferredWorker` only.
- **Codex target (second gate):** the **scoring math** + the fill-not-override / exploration / route-record-consistency invariants. This plan must pass `/codex challenge` before dispatch.
- **Off-limits:** existing `routingHints` consumer branches (`run-cli.ts:1358`, orchestrator :1136, eval/runner :620); `outcome_scores` DDL (S4); promotion logic.
- **Merge eligibility:** load-bearing routing change → **manual Opus review.**
- **Verify command:** `pnpm -C <worktree> exec vitest run packages/kernel/test apps/cli/test`. **Then the gate:** full suite + `pnpm -C <worktree> lint` + changeset.

## Verify-first (BEFORE implementation)

- [ ] **VF-1:** Identify which outcome source feeds aggregation — `runs.status`/`decisions` (store.ts:447,466), `run_learnings` (:262), or `events`. Pick the one that records the actual `preferredWorker` used + a success/failure signal. Record it.
- [ ] **VF-2:** Confirm `repoId` derivation at the hook (`projectRoot`) and that `taskType` + the chosen `preferredWorker` are available pre-snapshot at `orchestrator.ts:1133`.
- [ ] **VF-3:** Confirm filling `routingHints` pre-snapshot keeps provenance consistent (the snapshot reads the filled value). Confirm an explicit `preferredWorker` on the incoming packet is never overwritten.
- [ ] **VF-4:** Confirm there is a run-completion site to write the outcome back into `outcome_scores` (closes the loop).

## File Structure

- `packages/kernel/src/outcome-scoring.ts` — **new:** pure aggregation (decay, min-sample, score) + a `chooseWorker(scores, { epsilon })` producer helper.
- `packages/kernel/src/orchestrator.ts` — **modify:** call the producer at packet-prep before :1133 (fill-not-override).
- run-completion site (per VF-4) — **modify:** write outcome back via `upsertOutcomeScore`.
- `packages/kernel/test/outcome-scoring.test.ts` + integration tests — **new.**

## Tasks (TDD)

- [ ] **T1 — aggregation (pure).** Failing tests for the math: recency decay weights recent runs higher; a score below min-sample is **ineligible** to steer; success-rate computed correctly.
- [ ] **T2 — producer hook.** Failing tests: when `preferredWorker` absent and an eligible score exists, it is filled pre-snapshot; when present, it is **never** overridden; with ε>0 an under-sampled worker is chosen at the expected frequency; recorded route == actual route.
- [ ] **T3 — write-back.** Failing test: completing a run upserts its `(repoId, taskType, worker, success)` into `outcome_scores`.

## Acceptance criteria

- Scores below min-sample never steer; explicit `preferredWorker` never overridden; ε-exploration present; recorded route == actual route.
- Outcomes written back on run completion; aggregation applies decay.
- Scoring math + invariants passed `/codex challenge`. Full suite + lint green; changeset added.
