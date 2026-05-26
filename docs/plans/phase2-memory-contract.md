# Phase 2 Memory Contract (FROZEN 2026-05-26 — post-Codex-gate R1, operator-signed-off)

> Authority: ADR 0001 + `docs/superpowers/specs/2026-05-26-memory-program-orchestration-design.md`.
> Operator scope (2026-05-26): **Track 1 (V1-gap correctness fixes) first, then Track 2
> (outcome memory layer 5)**; promotion automation → **Phase 3**.
> **Codex adversarial gate (R1) addressed** — see "Codex gate resolutions" below. All symbols
> verified against `origin/main` (`6391e17`) in the `phase2-planning` worktree; the noted
> file:line refs are Codex-verified and re-confirmed per-slice in each slice plan's verify-first.
> Worktrees cut from `origin/main` (hard invariant).

## Codex gate resolutions (R1)

| Codex P1/P2 | Resolution in this rev |
|---|---|
| S2 needs git-ancestry / new metadata (breaks DDL-off-limits) | **S2 rescoped to branch-only filtering** (operator decision). Commit-ancestry validity windows → Phase 3. No DDL change. |
| S2 frozen surface incomplete (public `retrieveRepoFacts`/`RepoFactRetrievalQuery` have no branch param) | Public surface now pre-declared: `branch?` added to `RepoFactRetrievalQuery` + threaded through `retrieveRepoFacts` + the packet-enrichment local port type/call site. |
| S2 & S3 not parallel on `ports.ts` | **S3 is the sole `ports.ts` editor.** S2 stays in memory-retrieval/store/packet-enrichment. Track-1 lands in a defined order (below), not "clean parallel." |
| S5 `runtimeRouter` producer too late (route/record divergence poisons scores) | Producer moved **upstream to packet-prep** (`orchestrator.ts:1133`, before `validatedPacket.routingHints` is snapshotted). |
| S5 `repoId` undefined | **`repoId = projectRoot`** (store.ts:1090 convention) — stated as a contract invariant. |
| `listEvents` signature mismatch | `listEvents` now **runId-required**, implemented via `EventStore.getEventsByRunId`. |
| Aggregation grain conflates model/effort | Grain = **`preferredWorker` only** for Phase 2 (the sole runtime branch). model/effort out of scope. |
| Feedback-loop bias unaddressed | S5 must ship **min-sample threshold + ε-exploration + recency decay** before score-driven routing is trusted. |

## Authoritative code surfaces (Codex-verified origin/main 2026-05-26)

```
Port interface       packages/kernel/src/ports.ts          BuildplaneStoragePort :90–153
Retrieval query type packages/kernel/src/memory-retrieval.ts RepoFactRetrievalQuery :27 (+ retrieveRepoFacts)
Store + all DDL      packages/storage/src/store.ts          repo_facts DDL :503–522; repo_id = projectRoot :1090
                                                            readRepoFactRows :1081–1127; exact :1448; fuzzy :1481
events DDL           packages/storage/src/database.ts       :14
EventStore           packages/storage/src/event-store.ts    getEventsByRunId :13 / getEventsByStrategyId :91
promote writes       apps/cli/src/run-cli.ts                branch/commitSha at :1826 (NOT validity windows)
Injection assembly   apps/cli/src/packet-enrichment.ts      local port type :26; retrieval call :302; assembly :442–446
memory CLI dispatch  apps/cli/src/run-cli.ts                :3496 (facts :3675, procedures :3716)
RoutingHints type    packages/kernel/src/run-loop.ts        :18–22 (preferredWorker | preferredModel | effort)
packet-prep / snapshot packages/kernel/src/orchestrator.ts  records ctx.validatedPacket.routingHints :1133
runtime worker branch apps/cli/src/run-cli.ts               selection branches on preferredWorker only :1358
```

## Pre-declared port / query surface (FROZEN — slices code against these)

```ts
// packages/kernel/src/memory-retrieval.ts — RepoFactRetrievalQuery, ADDED (S2):
//   branch?: string;   // optional; omitted ⇒ no branch filtering (today's behavior)
// retrieveRepoFacts threads `branch` to the store read path; packet-enrichment's local
// port type (:26) and call site (:302) pass the run's current branch.

// packages/kernel/src/ports.ts — BuildplaneStoragePort, ADDED by S3 ONLY:
listEvents(options: { runId: string; limit?: number }): readonly ExecutionEvent[];

// packages/kernel/src/ports.ts — BuildplaneStoragePort, ADDED by S4:
upsertOutcomeScore(input: UpsertOutcomeScoreInput): OutcomeScore;
listOutcomeScores(options?: { repoId?: string; taskType?: string }): readonly OutcomeScore[];
```
No existing signature is modified or removed. `ExecutionEvent` already exists (`event-store.ts`).

---

## Track 1 — V1-gap correctness fixes

**Land order (NOT clean parallel — files overlap):** develop in parallel, land **S3 → S2 → S1**,
each rebasing on the prior. Rationale: S3 owns the `ports.ts`/`store.ts` additions; S2 then edits
`memory-retrieval.ts` + store read helpers + `packet-enrichment.ts:26/302`; S1 last edits the
`packet-enrichment.ts:442–446` assembly. S1∩S2 share `packet-enrichment.ts` (different regions);
S2∩S3 share `store.ts` (different methods).

### S1 — cross-layer injection dedup/precedence  (no port change)
**Site:** `packet-enrichment.ts:442–446` — three source arrays concatenated with no cross-layer
identity check (`dedupeRankedMemoryResults` runs only within each structured sub-query at :300+).
**Do:** dedup across run_learnings + structured + honcho by stable identity (`memory_id` where
available; normalized display-text fallback) + a documented precedence order.
**Verify-first:** identity/display-text available per source; finalize precedence (proposal:
repo_facts ≻ procedures ≻ run_learnings ≻ honcho; ties by confidence then recency).

### S2 — repo_facts **branch-scoped** filtering  (NO DDL change; commit-ancestry → Phase 3)
**Bug:** `readRepoFactRows`/exact/fuzzy (`store.ts:1081–1481`) return all active facts regardless
of `branch`; facts promoted on another branch leak into unrelated runs.
**Do:** add optional `branch?` to `RepoFactRetrievalQuery` (memory-retrieval.ts:27), thread it
through `retrieveRepoFacts` and the store read helpers, and have `packet-enrichment.ts:302` pass
the run's current branch. SQL: match rows where `branch = ? OR branch IS NULL` (null-branch =
repo-global, always matches). `valid_from_commit`/`valid_to_commit` are **left untouched** in
Phase 2.
**Verify-first:** confirm `branch` is populated on promoted facts (run-cli.ts:1826); confirm
null-branch repo-global semantics; confirm the run's current branch is available at :302.
**Off-limits within S2:** the `memory-retrieval.ts` *ranking algorithm* (adding the `branch` query
field is allowed; changing scoring is not). Does NOT touch `ports.ts`.

### S3 — episodes read path  (**sole `ports.ts` editor** in Track 1)
**Gap:** no event-listing on the port; `memory` dispatch shipped `facts`/`procedures`, no `episodes`.
**Do:** add `listEvents({ runId, limit? })` to `ports.ts` (after :153), implement in `store.ts` via
`EventStore.getEventsByRunId`, add `subcommand === "episodes"` to `run-cli.ts` after :3752 (requires
a `<runId>` arg), reuse `formatters.ts` with `--json` parity.
**Verify-first:** `ExecutionEvent` shape; dispatch insertion point; runId-required UX is acceptable.

---

## Track 2 — outcome memory layer 5 (serial, AFTER Track 1 lands)

**Invariants:** `repoId = projectRoot` (store.ts:1090). Scoring grain = `(repoId, taskType,
preferredWorker)` — **preferredWorker only**; model/effort excluded. Score-driven routing is
**fill-not-override** and must include **min-sample threshold + ε-exploration + recency decay**.

### S4 — `outcome_scores` table + store + port
Confirmed unbuilt. **Do:** new DDL in `store.ts` near :555 mirroring `repo_facts:503–522` (typed,
scoped, `confidence`, `status`, `source_run_id`, `created_by`, `created_at`). Columns: `repo_id`
(=projectRoot), `task_type`, `worker` (=preferredWorker value), outcome metric(s) (`success`,
`score`, `sample_count`), provenance. Add `upsertOutcomeScore`/`listOutcomeScores` after
`ports.ts:153`. **Codex target:** the score schema + aggregation grain.
**Off-limits:** altering any existing table DDL — only ADD `outcome_scores`.

### S5 — scoring aggregation + routingHints producer  (depends on S4)
**Aggregation:** per `(repoId, taskType, preferredWorker)` from run outcomes; apply recency decay;
require a min sample count before a score is eligible to steer routing.
**Producer hook (corrected):** at **packet-prep, before `orchestrator.ts:1133` snapshots
`ctx.validatedPacket.routingHints`** — query `outcome_scores` for `(repoId, taskType)`, and **only
if `routingHints.preferredWorker` is absent**, fill it; otherwise leave the explicit value. With
probability ε, pick an under-sampled worker instead (exploration). The recorded route and the
actual route must be the same value (no late `runtimeRouter` mutation).
**Codex targets:** scoring math, the fill-not-override + exploration invariants, route/record
consistency. **Verify-first:** which outcome source feeds aggregation; `repoId` derivation at the
hook; that filling pre-snapshot keeps provenance consistent.

---

## Behavioral rules

1. Promotion stays **manual / receipt-gated / fact-only / no-overwrite** (ADR 0001) → Phase 3.
2. **Additive / opt-in only.** S2 branch filtering changes nothing unless the caller passes
   `branch`; S5 routing changes nothing unless eligible scores exist. No silent behavior change.
3. Score-driven routing **NEVER overrides an explicit `packet.routingHints.preferredWorker`** — it
   only fills when absent, and only when min-sample is met; ε-exploration is the sole exception.
4. **Track 1 lands before Track 2.** Within Track 1, land **S3 → S2 → S1** (overlapping files;
   not clean parallel). S3 is the sole `ports.ts` editor.
5. Recorded route == actual route (S5 fills pre-snapshot; no late mutation).

## Off-limits (Phase 2 must NOT touch)

- `BuildplaneMemoryPort` / `extractLearnings()` / `learning-store.ts`; `promoteMemoryFromReceipt`
  logic + conservatism.
- `memory-retrieval.ts` **ranking algorithm** (adding the `branch` query field is allowed).
- Existing table DDL (`repo_facts`/`procedures`/`events`/`run_learnings`/`runs`) — only ADD
  `outcome_scores`. `valid_from_commit`/`valid_to_commit` untouched.
- Embeddings / team mode / Postgres (V2/V3 — Phase 3, parked).

## Deferred to Phase 3 (recorded)

- **Commit-ancestry validity filtering** of `repo_facts` (`valid_from/to_commit`): needs git
  runtime ancestry or new persisted metadata + populating windows at promote-time.
- Promotion automation; richer learnings→structured graduation.
- Embeddings, team/Postgres mode.

## Gate

**FROZEN** after operator sign-off (2026-05-26). Slice plans S1–S5 written
(`docs/plans/phase2-s{1..5}-*.md`), each with verify-first + the `pnpm -C <wt> exec vitest run` /
full-suite+lint+changeset gate. The S4/S5 scoring-math plans pass a **second Codex gate** before
Track 2 dispatch. Track 1 (land order **S3 → S2 → S1**) is ready to triage to Hermes lanes.
