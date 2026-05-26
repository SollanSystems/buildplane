# Phase 2 Memory Contract (DRAFT 2026-05-26 — freeze after Codex gate + operator sign-off)

> Authority: ADR 0001 + `docs/superpowers/specs/2026-05-26-memory-program-orchestration-design.md`.
> Operator scope decision (2026-05-26): **Track 1 (V1-gap correctness fixes) first, then Track 2
> (outcome memory layer 5)**; promotion automation deferred to **Phase 3**.
> All symbols verified against `origin/main` (`6391e17`) in the `phase2-planning` worktree.
> Worktrees cut from `origin/main` (hard invariant).

## Authoritative code surfaces (verified origin/main 2026-05-26)

The Phase-1 contract's `packages/kernel/src/store.ts` refs had **drifted** — the store + all
DDL live in `packages/storage`. Corrected map:

```
Port interface     packages/kernel/src/ports.ts        BuildplaneStoragePort :90–153
Store + all DDL    packages/storage/src/store.ts
events DDL         packages/storage/src/database.ts    :14
EventStore         packages/storage/src/event-store.ts :11–26 (getEventsByRunId/ByStrategyId)
repo_facts DDL     packages/storage/src/store.ts        :503–522
procedures DDL     packages/storage/src/store.ts        :524–540
run_learnings DDL  packages/storage/src/store.ts        :262–275
Injection assembly apps/cli/src/packet-enrichment.ts    :442–446
memory CLI dispatch apps/cli/src/run-cli.ts             :3496 (facts :3675, procedures :3716)
RoutingHints type  packages/kernel/src/run-loop.ts      :18–22
runtimeRouter      apps/cli/src/run-cli.ts              :1316–1370 (consume :1358–1368)
```

## Pre-declared port additions (FROZEN interface — slices code against these)

To keep Track-1 slices parallel-safe on the shared `ports.ts`/`store.ts`, Opus pre-declares the
exact surface. S2 and S3 edit **non-overlapping** regions/methods.

```ts
// packages/kernel/src/ports.ts — BuildplaneStoragePort, ADDED in Phase 2
listEvents(options?: { runId?: string; limit?: number }): readonly ExecutionEvent[];   // S3

// repo_facts retrieval gains OPTIONAL, ADDITIVE validity params (S2) — default = today's behavior:
//   readRepoFactRows / readExactRepoFactMatches / readFuzzyRepoFactMatches gain
//   options: { branch?: string; atCommit?: string }
//   (omitted ⇒ no validity filtering, identical to current output)

// Track 2 (S4) — ADDED after ports.ts:153:
upsertOutcomeScore(input: UpsertOutcomeScoreInput): OutcomeScore;
listOutcomeScores(options?: { repoId?: string; taskType?: string }): readonly OutcomeScore[];
```

`ExecutionEvent` already exists (`event-store.ts`). No existing signature is modified or removed.

---

## Track 1 — V1-gap correctness fixes (parallel fan-out, 3 slices)

### S1 — cross-layer injection dedup/precedence  (no port change)
**Site:** `packet-enrichment.ts:442–446`. Today three source arrays are concatenated with **no
cross-layer identity check** (`dedupeRankedMemoryResults` runs only *within* each structured
sub-query at :300/:312/:322):
```ts
const memories = [
  ...localLearnings.map((l) => `[${l.kind}] ${l.title}: ${l.body}`),  // run_learnings (plain text)
  ...structuredMemoryEnrichment.memories,                              // repo_facts/procedures/docs
  ...honchoMemories,
];
```
**Do:** dedup across all three by a stable identity (`memory_id` where available; normalized
display-text fallback) and apply a **documented precedence order**.
**Verify-first:** confirm the identity/display-text available on each source; decide + document
precedence (proposal: structured repo_facts ≻ procedures ≻ run_learnings ≻ honcho, ties by
confidence then recency — slice plan finalizes).
**Off-limits:** `memory-retrieval.ts` ranking; the per-table dedup.

### S2 — repo_facts commit/branch validity filtering
**Site:** `store.ts` `readRepoFactRows` :1081–1127 (+ `readExactRepoFactMatches` :1448,
`readFuzzyRepoFactMatches` :1481). Columns `valid_from_commit`/`valid_to_commit` exist (:518–519,
selected :1118) but are **never used to filter**; no branch param. All active facts returned
regardless of validity window.
**Do:** add the pre-declared optional `{ branch?, atCommit? }` options; when provided, filter.
Wire the structured-retrieval caller (packet-enrichment) to pass the run's current branch/commit.
**Verify-first (HIGHEST RISK — Codex target):** resolve **commit-validity comparison semantics**.
`valid_from_commit <= atCommit` is meaningless as raw SHA string/lex comparison — commits order
**topologically (ancestry), not lexically**. Determine the intended semantics before coding:
(a) ancestry test (`atCommit` is a descendant of `valid_from_commit` and not of `valid_to_commit`),
(b) a monotonic sequence column, or (c) timestamp proxy. Do **not** ship a `<=` SHA comparison.
**Port:** additive optional options only.

### S3 — episodes read path
**Site:** `BuildplaneStoragePort` (`ports.ts:90–153`) has no event-listing method; `EventStore`
(`event-store.ts:11–26`) has `getEventsByRunId` but it's not exposed on the port. `memory`
dispatch (`run-cli.ts:3496`) shipped `facts`/`procedures` but **no `episodes`**.
**Do:** add pre-declared `listEvents(...)` to `ports.ts`, implement in `store.ts` via
`EventStore.getEventsByRunId`, add a `subcommand === "episodes"` branch in `run-cli.ts` after
:3752, reuse `formatters.ts`.
**Verify-first:** `ExecutionEvent` shape + the exact dispatch insertion point + `--json` parity
with `facts`/`procedures`.
**No new table.**

---

## Track 2 — outcome memory layer 5 (serial, AFTER Track 1 merges)

### S4 — `outcome_scores` table + store + port
Confirmed unbuilt (zero matches for `outcome_scores`/`OutcomeScore`). Run outcomes live today in
`run_learnings` (:262, seen-count promotion), `events` (`database.ts:14`), and `runs.status`/
`decisions` (:447,:466).
**Do:** new DDL in `store.ts` near :555 **mirroring `repo_facts` :503–522** (typed, scoped,
`confidence`, `status`, `source_run_id`, `created_by`, `created_at`). Columns to define:
`repo_id`/scope, `task_type`, `worker`/`model`, outcome metric(s) (`success`, `score`,
`sample_count`), provenance. Add pre-declared `upsertOutcomeScore`/`listOutcomeScores` after
`ports.ts:153`.
**Codex target:** the score schema (what is stored, the aggregation grain).
**Off-limits:** altering any existing table DDL — only ADD `outcome_scores`.

### S5 — scoring aggregation + routingHints producer  (depends on S4)
**Aggregation:** compute per-`(repoId, taskType, worker)` scores from run outcomes.
**Producer hook:** `runtimeRouter` `run-cli.ts:1316–1370` — query `outcome_scores` for
`(repoId, taskType)`, build a `RoutingHints`, inject before `executePacketAsync` (or upstream at
`orchestrator.ts:1422` packet-prep). All consumers read `packet.routingHints.preferredWorker`
directly (:1358, orchestrator :1136, eval/runner :620), so the producer is the only missing seam.
**Codex target:** the scoring math + the routing-mutation seam.
**Verify-first:** which outcome source feeds aggregation; **fill-not-override** (see rule 3).

---

## Behavioral rules

1. Promotion stays **manual / receipt-gated / fact-only / no-overwrite** (ADR 0001). Phase 2 does
   NOT automate it → Phase 3.
2. **Additive / opt-in only.** Validity filtering (S2) and score-driven routing (S5) change nothing
   unless callers pass the new params / scores exist. No silent behavior change to existing runs.
3. Score-driven routing **NEVER overrides an explicit `packet.routingHints`** — it only fills when
   the field is absent.
4. **Track 1 merges before Track 2** (shared `ports.ts`/`store.ts` churn). Within Track 1, S2 & S3
   edit the pre-declared, non-overlapping port surface and fan out in parallel; S1 touches no port.

## Off-limits (Phase 2 must NOT touch)

- `BuildplaneMemoryPort` / `extractLearnings()` / `learning-store.ts`; `promoteMemoryFromReceipt`
  logic and its conservatism.
- `memory-retrieval.ts` ranking.
- Existing table DDL (`repo_facts`/`procedures`/`events`/`run_learnings`/`runs`) — only ADD
  `outcome_scores`.
- Embeddings / team mode / Postgres (V2/V3 — Phase 3, parked).

## Gate

Draft → `/codex challenge` (S2 validity semantics + S4/S5 scoring math are the correctness-critical
targets) → fix findings → **operator sign-off** → freeze → write 5 slice plans (S1–S5) with
verify-first + the `pnpm -C <wt> exec vitest run` / full-suite+lint+changeset gate per slice.
