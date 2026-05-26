# Phase 2 · S4 — outcome_scores Table + Store + Port — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development (or executing-plans). Steps use `- [ ]` checkboxes.

**Goal:** Add the layer-5 outcome-memory store: a new `outcome_scores` table (mirroring `repo_facts`), `UpsertOutcomeScoreInput`/`OutcomeScore` types, and `upsertOutcomeScore`/`listOutcomeScores` port methods. **Schema + storage only — no aggregation or routing (that is S5).**

**Why:** routing today has no memory of what worked. `outcome_scores` is the durable substrate S5 aggregates into and the producer reads. The `routingHints` consumer already exists end-to-end; only the producer + its data are missing.

**Tech Stack:** TypeScript (ESM, `.js`), Node ≥24.13, vitest, `@buildplane/storage`, `@buildplane/kernel`.

> **⛔ Codex gate R2 (2026-05-26) — REDESIGN REQUIRED, NOT dispatch-ready.** The "mirror
> `repo_facts`" model is wrong for an accumulator:
> - **Supersede-then-insert (last-writer-wins) destroys the running tally.** Use atomic
>   increment/update-in-place, OR persist raw per-run outcome rows and aggregate on read.
> - **Decay needs per-run data.** Bare `success_count/sample_count/created_at` can't be decayed
>   correctly later — store raw samples, or `decayed_success`/`decayed_sample`/`last_decay_at` + a
>   fixed decay rule.
> - **Add a uniqueness index** for one active row per `(repo_id, task_type, worker)`, else
>   `listOutcomeScores` returns duplicates and S5's chooser is nondeterministic.
> - **Define `score`/`confidence` invariants** (derive `score` from counts; `confidence` from
>   `sample_count`) or rows drift into contradiction.
> Re-spec the storage model, then re-run `/codex challenge` before dispatch.

## Opus Planning Reference (handoff contract)

- **Slice ID:** `phase2-s4-outcome-scores-table`
- **Phase:** 2 · Track 2 — **serial, AFTER all of Track 1 lands** (touches `ports.ts` + `store.ts` after S3/S2 edits). Gates S5.
- **Branch base:** cut worktree from `origin/main` **after Track 1 merges**. Re-verify tip at dispatch.
- **Frozen contract excerpt** (authority: `docs/plans/phase2-memory-contract.md`):
  - New DDL in `store.ts` near :555 **mirroring `repo_facts` (:503–522)**: typed, scoped, `confidence`, `status`, `source_run_id`, `created_by`, `created_at`.
  - **Invariant:** `repo_id = projectRoot` (store.ts:1090 convention). Scoring grain column `worker` = a `RoutingHints.preferredWorker` value (NOT model/effort).
  - ADD `upsertOutcomeScore(input: UpsertOutcomeScoreInput): OutcomeScore` + `listOutcomeScores(options?: { repoId?: string; taskType?: string }): readonly OutcomeScore[]` after `ports.ts:153`.
- **Codex target (second gate):** the **score schema** — column set, types, aggregation grain, supersession semantics. This plan must pass `/codex challenge` before dispatch.
- **Off-limits:** altering ANY existing table DDL (only ADD `outcome_scores`); the `routingHints` consumer; aggregation/producer logic (S5).
- **Merge eligibility:** new table + new port methods → **manual Opus review** (trust/storage surface).
- **Verify command:** `pnpm -C <worktree> exec vitest run packages/storage/test packages/kernel/test`. **Then the gate:** full suite + `pnpm -C <worktree> lint` + changeset.

## Verify-first (BEFORE implementation)

- [ ] **VF-1:** Re-confirm zero `outcome_scores`/`OutcomeScore` symbols on the (post-Track-1) `origin/main`. Confirm the table truly does not exist.
- [ ] **VF-2:** Read `repo_facts` DDL (`store.ts:503–522`) + its `ensure*Table`/`upsert*` pattern (supersede-then-insert, last-writer-wins). Decide whether `outcome_scores` upsert should supersede or accumulate `sample_count` — **record the choice; this is the Codex-gated decision.**
- [ ] **VF-3:** Confirm `repo_id = projectRoot` (store.ts:1090). Confirm `task_type` vocabulary (reuse the packet `taskType` values).
- [ ] **VF-4:** Lock the column set (Codex target). Proposal: `id, repo_id, task_type, worker, success_count, sample_count, score (REAL), confidence, status, source_run_id, created_by, created_at`. `score` = derived success rate or left for S5 to compute? Record the decision.

## File Structure

- `packages/kernel/src/memory-types.ts` — **modify:** `UpsertOutcomeScoreInput`, `OutcomeScore`.
- `packages/kernel/src/ports.ts` — **modify:** add the two methods to `BuildplaneStoragePort` (after :153).
- `packages/storage/src/store.ts` — **modify:** `ensureOutcomeScoresTable` DDL near :555; implement `upsertOutcomeScore`/`listOutcomeScores`.
- `packages/storage/test/…`, `packages/kernel/test/…` — **new:** tests.

## Tasks (TDD)

- [ ] **T1 — types.** Define `UpsertOutcomeScoreInput`/`OutcomeScore` mirroring repo-fact types.
- [ ] **T2 — DDL.** Failing test: store init creates `outcome_scores`; columns + indexes per VF-4. Implement `ensureOutcomeScoresTable`.
- [ ] **T3 — upsert/list.** Failing test: `upsertOutcomeScore` then `listOutcomeScores({ repoId, taskType })` returns it; the VF-2 supersede/accumulate semantics hold.

## Acceptance criteria

- `outcome_scores` created; `upsert`→`list` round-trips, scoped by `repo_id`/`task_type`.
- No existing DDL altered. Grain = `preferredWorker`. Schema passed `/codex challenge`.
- Full suite + lint green; changeset added.
