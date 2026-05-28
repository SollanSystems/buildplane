# Track 2 — Outcome Memory Redesign (raw run-outcome rows)

| | |
|---|---|
| **Status** | Design — approved by operator 2026-05-28, pre-`/codex challenge` re-gate |
| **Supersedes** | The frozen `outcome_scores` / `upsertOutcomeScore` storage model in `docs/plans/phase2-memory-contract.md` (Track 2) and the ⛔-banner'd plans `phase2-s4-outcome-scores-table.md`, `phase2-s5-scoring-aggregation-routing-producer.md` |
| **Authority** | ADR 0001; `docs/superpowers/specs/2026-05-26-memory-program-orchestration-design.md`; the Phase-2 contract (Track 1 portion unchanged) |
| **Gate** | Re-run `/codex challenge` against this spec + the revised S4/S5 plans before Track 2 dispatch |

> All file:line refs verified against `origin/main` @ `8b322f8` on 2026-05-28. Worktrees cut from
> `origin/main` (hard invariant). Re-confirm tips at dispatch.

## Problem

Phase 2 Track 1 (S1/S2/S3) shipped. Track 2 — "outcome memory layer 5", i.e. routing that
remembers what worked — was frozen against a storage model that mirrored `repo_facts`
(supersede-then-insert, one accumulator row per grain). Codex gate **R2 (2026-05-26)** found 7 P1s
and marked Track 2 **not dispatch-ready**:

1. Supersede-then-insert (last-writer-wins) **destroys the running tally**.
2. **Decay is unimplementable** from a bare `success_count/sample_count/created_at` accumulator.
3. The S5 producer hook is **too late** — filling `routingHints` before `orchestrator.ts:1133`
   changes execution but not the persisted `unit_snapshot`, so **recorded ≠ actual route**, which
   poisons the very scores the feature reads.
4. Outcome sources (`runs`/`decisions`/`run-completed`) **don't record the worker used**.
5. **`taskType` is optional** (`UnitPacket.intent?`), so the grain key can be null.
6. **Cold start / starvation** — unhinted traffic always hits the SDK executor; non-default
   workers never get sampled, so the table never warms.
7. No **uniqueness / score-confidence invariants** → duplicate rows, nondeterministic chooser.

This redesign replaces the accumulator with **raw, append-only per-run outcome rows aggregated at
read time**, and moves the producer ahead of run persistence. Most P1s dissolve by construction.

## Decisions (operator-approved 2026-05-28)

- **D1 — Storage = raw per-run rows, aggregate on read.** `run_outcomes` is append-only; one row
  per finished run. Scores/rates/confidence are *derived* at read time, never stored. (Resolves
  P1 #1, #2, #7.)
- **D2 — Routing posture = full loop, opt-in, default OFF.** Aggregation + exploration + producer
  all ship and are tested against seeded fixtures, gated behind a config flag. Default routing is
  byte-for-byte unchanged. (Honors contract rule 2 "additive / opt-in, no silent behavior change".)
- **D3 — Recording lives in S4** (folded into the write path), so the table warms from real runs
  the moment S4 lands, before any steering logic exists.
- **D4 — Exploration is directed (least-sampled candidate), deterministic.** ε gates *whether* to
  explore; the *choice within* exploration is the least-sampled candidate (no RNG), so every route
  is reproducible and explainable.

## Architecture

### Worker vocabulary (P1 #4 groundwork)

`RoutingHints.preferredWorker` is `"claude-code" | "codex"` (`packages/kernel/src/run-loop.ts:19`);
the **absent** case is the default SDK executor (the `else` of the selection branch at
`apps/cli/src/run-cli.ts:1359/1366`). So the *worker that actually ran* is one of **three** values:

```ts
type WorkerLabel = "sdk" | "claude-code" | "codex";
```

The outcome table records this 3-value reality. The candidate set for exploration is the same three.

### Grain key (P1 #5)

`(repoId, taskType, worker)` where:
- `repoId = projectRoot` (store.ts:1090 convention — a Phase-2 invariant).
- `taskType` resolves as **`packet.intent?.taskType ?? packet.unit.kind`**. `unit.kind` is
  required (`run-loop.ts`: `readonly kind: string`), so the key is **never null** — no
  required-intent invariant needed. (`TaskIntent.taskType`: `types.ts:83`; `UnitPacket.intent?`:
  `run-loop.ts:34`; `unit.kind` used as `validatedPacket.unit.kind` e.g. orchestrator.ts:374.)

### S4 — write path (`run_outcomes` table + port + recorder)

**Table** (new `CREATE TABLE IF NOT EXISTS` in the ensure block at `store.ts:439–587`, registered
in the existence checks at `:604/:615`, asserted via the `assertTableColumns` pattern at `:362`):

```sql
CREATE TABLE IF NOT EXISTS run_outcomes (
  id           TEXT PRIMARY KEY,
  repo_id      TEXT NOT NULL,
  task_type    TEXT NOT NULL,
  worker       TEXT NOT NULL,            -- WorkerLabel
  success      INTEGER NOT NULL,         -- 0 | 1
  source_run_id TEXT NOT NULL,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_run_outcomes_grain ON run_outcomes (repo_id, task_type, worker);
```

No supersession, no `status`, no stored `score`/`confidence`/`sample_count` — the raw success
signal is the only stored fact; everything else is derived in S5. (Graded/continuous outcome scores
→ Phase 3.)

**Port** (`packages/kernel/src/ports.ts`, `BuildplaneStoragePort` after :153; supersedes the frozen
`upsertOutcomeScore`/`listOutcomeScores`):

```ts
appendRunOutcome(input: AppendRunOutcomeInput): RunOutcome;
listRunOutcomes(options?: {
  repoId?: string; taskType?: string; worker?: WorkerLabel;
}): readonly RunOutcome[];
```

Types (`packages/kernel/src/memory-types.ts`): `WorkerLabel`, `AppendRunOutcomeInput`, `RunOutcome`.

**Recorder** (P1 #4 — resolved for free by D2's recorded==actual): at run finalization
(`orchestrator.ts:762 finalizeRun`), append one row:
- `worker = run.unit_snapshot.routingHints?.preferredWorker ?? "sdk"` — because the producer fills
  the hint *before* the snapshot (D2/below), the persisted snapshot **is** the authoritative record
  of which worker ran. No separate provenance plumbing.
- `success` from the run's terminal status (the `run-completed` payload status read at
  `store.ts:1809`): a terminal *success* → 1, a terminal *failure* → 0. Only runs that reach a
  terminal success/failure are recorded; cancelled/superseded/non-terminal runs append no row. **S4
  verify-first pins the exact run-status vocabulary** before mapping.
- `task_type` via the grain-key rule; `repo_id = projectRoot`; `source_run_id = run.id`.

S4 is **fully additive**: it changes no routing behavior. The table simply begins accumulating.

### S5 — read path (aggregation + producer), opt-in

**Aggregation** — new pure module `packages/kernel/src/outcome-scoring.ts`, no port, fully unit-testable:

```ts
aggregateOutcomeScores(
  rows: readonly RunOutcome[],
  opts: { halfLifeMs: number; now: number },
): Map<WorkerLabel, { decayedSuccess: number; decayedSamples: number; rate: number }>;
```

Exponential **recency decay** by row age: `w_i = 2 ** (-(now - created_at) / halfLifeMs)`;
`decayedSuccess = Σ(w·success)`, `decayedSamples = Σ w`, `rate = decayedSuccess / decayedSamples`.
Decay is correct and **retunable forever** because raw per-row timestamps are kept (`now` is
injected for testability). (Resolves P1 #2.)

**Producer** — `chooseWorker(scores, opts): WorkerLabel | undefined`:

```ts
chooseWorker(
  scores: ReturnType<typeof aggregateOutcomeScores>,
  opts: {
    candidates: readonly WorkerLabel[];   // ["sdk","claude-code","codex"]
    minSamples: number;                    // eligibility gate
    epsilon: number;                       // P(explore)
    exploreSeed: number;                   // deterministic explore decision (e.g. run-id hash)
  },
): WorkerLabel | undefined;
```

- A worker is **eligible** to exploit only at `decayedSamples ≥ minSamples`.
- **Explore** (gated by ε via `exploreSeed`, deterministic): return the **least-sampled** candidate
  (directed — warms all three fastest; D4). Handles cold start: at zero data every candidate ties
  at 0 samples and exploration cycles them. (Resolves P1 #6.)
- Otherwise **exploit**: the eligible worker with the highest `rate`.
- If neither explores nor has an eligible worker → return `undefined` (leave hint absent → default
  SDK; unchanged behavior).

**Integration** (`orchestrator.ts`, inside `prepareRun` **before** `storage.createRun` at
`:689`) — resolves P1 #3:

```ts
// prepareRun, after validatePacketForWorkspaceRoot, before storage.createRun:
const routedPacket = outcomeRouting.enabled
  ? fillRoutingHints(validatedPacket, storage, outcomeRouting)  // fill-not-override
  : validatedPacket;
const run = storage.createRun(routedPacket, createRunOptions);
// ...routedPacket is also the ctx packet used downstream (execution read at :1136)
```

The `outcomeRouting` config is threaded into the orchestrator via its existing dependency-injection
seam — **S5 verify-first must confirm where orchestrator construction takes config/deps** and add
the flag there (do not assume a global `config`). `fillRoutingHints` returns `validatedPacket`
unchanged when `routingHints.preferredWorker` is
already set (**never override an explicit hint** — contract rule 3) or when `chooseWorker` returns
`undefined`; otherwise it returns a packet with the filled hint. Because the **same** `routedPacket`
is both snapshotted by `createRun` (`store.ts:1959`, `unit_snapshot`) and read at execution
(`orchestrator.ts:1136`), **recorded route == actual route** by construction. No downstream
mutation (not `runtimeRouter`). (Resolves P1 #3 and feeds the clean P1 #4 recording above.)

**Config / flag** (D2): `outcomeRouting: { enabled: boolean (default false), epsilon, halfLifeMs,
minSamples, candidates }`. Disabled ⇒ `fillRoutingHints` is never called ⇒ zero behavior change.

### Other `createRun` sites

`storage.createRun` is also called at `orchestrator.ts:1080` and `:1101` (retry/child paths). The
S5 plan's verify-first must classify each: a site that represents a **fresh routing decision** needs
the producer; a site that **inherits** an already-routed packet must not re-route (it already
carries the filled hint). Default position: only the `prepareRun` (`:689`) fresh-decision path gets
the producer; retry/child runs inherit. Pin this in the plan, do not over-apply.

## Slices

| Slice | Scope | Routing change | Merge gate |
|---|---|---|---|
| **S4** | `run_outcomes` table + DDL + `assertTableColumns`; `WorkerLabel`/`AppendRunOutcomeInput`/`RunOutcome`; `appendRunOutcome`/`listRunOutcomes` port + store impl; recorder in `finalizeRun`. | **None** (additive). | Manual Opus review (new table + port + recorder). |
| **S5** | `outcome-scoring.ts` (aggregate + chooseWorker, pure); `fillRoutingHints` producer in `prepareRun` before `:689`; `outcomeRouting` config flag (default OFF). Depends on S4. | Behind opt-in flag; default OFF. | Manual Opus review (load-bearing routing). |

Each slice: TDD; verify command `pnpm -C <worktree> exec vitest run <pkg>/test`; then the gate —
full suite + `pnpm -C <worktree> lint` + changeset. (Per the slice-verify-command memory: use
`pnpm -C <wt> exec vitest run`, never `pnpm --filter buildplane test`.)

## P1 → resolution map

| R2 P1 | Resolution |
|---|---|
| #1 tally destroyed | Append-only raw rows; no supersession (D1). |
| #2 decay unimplementable | Raw timestamps + read-time exponential decay; retunable (D1, S5). |
| #3 recorded ≠ actual | Producer fills before `createRun` (`:689`); same packet snapshotted + executed (D2). |
| #4 no worker provenance | Recorded==actual ⇒ `snapshot.preferredWorker ?? "sdk"` is the worker; recorder reads it. |
| #5 taskType optional | Grain key `intent?.taskType ?? unit.kind`; `unit.kind` required ⇒ never null. |
| #6 cold start / starvation | Directed ε-exploration over `{sdk,claude-code,codex}` at zero-score (D4). |
| #7 uniqueness / score-confidence | No stored score/confidence; derived at read; grain index for query locality. |

## Invariants

1. `repoId = projectRoot`. Grain = `(repoId, taskType, worker)`, `worker ∈ {sdk,claude-code,codex}`.
2. Recorded route == actual route (producer fills pre-snapshot; no late mutation).
3. Never override an explicit `routingHints.preferredWorker` (ε-explore only fills when absent).
4. Additive / opt-in: steering does nothing unless `outcomeRouting.enabled` and eligible scores
   (or an explore tick) exist. Default OFF ⇒ no behavior change.
5. `run_outcomes` is append-only; no existing-table DDL is altered (only ADD).

## Off-limits (unchanged from contract)

`BuildplaneMemoryPort` / `extractLearnings()` / `learning-store.ts`; `promoteMemoryFromReceipt`;
the `memory-retrieval.ts` ranking algorithm; existing table DDL; embeddings / team / Postgres.

## Deferred to Phase 3

Retention / compaction of `run_outcomes`; model/effort routing grain (Phase-2 grain is
`preferredWorker`/worker only); graded continuous outcome scores; promotion automation; embeddings;
team/Postgres mode.
