# Track 2 — Outcome Memory Redesign (raw run-outcome rows)

| | |
|---|---|
| **Status** | Design — operator-approved 2026-05-28. Codex R3 FAIL (4 P1+3 P2) → fixed; R4 FAIL (2 P1+2 P2) → fixed (model predicate = `packet.model`; recording `finalizeRun`-only; raw-count coverage; ε default 0). See "R3/R4 findings → resolution". **Pending R5 `/codex challenge` re-gate.** |
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
- **D4 — Cold start is a seed-free deterministic rotation; ε is optional steady-state.** Coverage is
  guaranteed by always routing under-sampled grains to their **least-sampled candidate** (read from
  the table, no RNG, no seed) until every candidate reaches `minSamples`. Only after coverage does
  exploitation kick in, with an **optional** ε-exploration tick. This replaces the rejected R3
  design where the explore decision was a per-*unit* hash that froze forever (a unit hashing above ε
  never explored → permanent starvation). See [[#cold-start--exploration-p1-6]].
- **D5 — Outcome memory scopes to *model* packets only.** `UnitPacket` has both `execution?`
  (command/shell, run via `commandExecutor` at `run-cli.ts:1328`) and `model?`
  (`packages/kernel/src/run-loop.ts:32-33`). The in-scope predicate is **`packet.model !== undefined`**
  — *not* `execution === undefined`, since a packet with neither field still falls through to the
  SDK default (`run-cli.ts:1369`) and would be mis-recorded. Non-model packets are **excluded from
  both recording and routing**: they never append a `run_outcomes` row and `fillRoutingHints`
  returns them untouched. `worker ∈ {sdk,claude-code,codex}` only ever describes a model packet.
  (Resolves R3+R4 P1: command/non-model packets were being mis-recorded as `sdk`.)
- **D6 — V1 records only from `finalizeRun`; infra-failure crashes are Phase 3.** Recording lives at
  the single post-execution terminal commit `finalizeRun` (`orchestrator.ts:762`), where the model
  worker has run and `ctx` + the packet are in scope. Clean successes **and quality-failures**
  (worker ran, output rejected → failed status) both land there and are recorded. Executor
  *infrastructure crashes* take `finalizeInfrastructureFailure` (~15 sites, mostly pre-execution,
  receiving only `run`, with no worker-started signal) — **not recorded in V1**. Rationale: a crash
  is an environmental signal, not a clean worker-quality signal; folding the crash path in requires
  threading a worker-started flag + classifying every failure site, deferred to Phase 3. This is a
  stated scope boundary, not a silent gap. (Resolves R4 P1: the plan no longer depends on a
  nonexistent `ctx.workerStarted` or on `finalizeInfrastructureFailure` carrying execution context.)

## Architecture

### Worker vocabulary (P1 #4 groundwork)

`RoutingHints.preferredWorker` is `"claude-code" | "codex"` (`packages/kernel/src/run-loop.ts:19`);
the **absent** case is the default SDK executor (the `else` of the selection branch at
`apps/cli/src/run-cli.ts:1359/1366`). So the *worker that actually ran* is one of **three** values:

```ts
type WorkerLabel = "sdk" | "claude-code" | "codex";
```

The outcome table records this 3-value reality. The candidate set for exploration is the same three.
**Only model packets are in scope** (D5): the predicate is **`packet.model !== undefined`**. Command
packets (`execution` set, `run-cli.ts:1328`) and any non-model packet are excluded from recording +
routing. S4/S5 verify-first re-confirm the predicate against the live `UnitPacket` type.

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
CREATE UNIQUE INDEX IF NOT EXISTS uq_run_outcomes_run ON run_outcomes (repo_id, source_run_id);
```

No supersession, no `status`, no stored `score`/`confidence`/`sample_count` — the raw success
signal is the only stored fact; everything else is derived in S5. (Graded/continuous outcome scores
→ Phase 3.) **One run = at most one row:** the `uq_run_outcomes_run` unique index + an idempotent
`INSERT … ON CONFLICT DO NOTHING` make `appendRunOutcome` safe against a recorder that fires twice
(retry, replay, or two finalization paths) — otherwise a double-fire double-weights that run
forever. (Resolves R3 P1 / R2 #7.)

**Port** (`packages/kernel/src/ports.ts`, `BuildplaneStoragePort` after :153; supersedes the frozen
`upsertOutcomeScore`/`listOutcomeScores`):

```ts
appendRunOutcome(input: AppendRunOutcomeInput): RunOutcome;
listRunOutcomes(options?: {
  repoId?: string; taskType?: string; worker?: WorkerLabel;
}): readonly RunOutcome[];
```

Types (`packages/kernel/src/memory-types.ts`): `WorkerLabel`, `AppendRunOutcomeInput`, `RunOutcome`.

**Recorder** (P1 #4 — worker provenance falls out of D2's recorded==actual). Recording lives at the
single post-execution terminal commit **`finalizeRun` (`orchestrator.ts:762`)**, where `ctx` + the
packet are in scope and the model worker has run (D6). It records:
- only when **`packet.model !== undefined`** (D5 — model packets; command/non-model packets append
  no row);
- `worker = run.unit_snapshot.routingHints?.preferredWorker ?? "sdk"` — the producer fills the hint
  *before* the snapshot (D2), so the persisted snapshot **is** the authoritative record of which
  model worker ran. No separate provenance plumbing.
- `success` from the terminal status: terminal *success* → 1, a *quality-failure* (worker ran,
  output rejected → failed status) → 0. **S4 verify-first pins** the exact run-status vocabulary and
  confirms `finalizeRun` is reached only post-execution.
- `task_type` via the grain-key rule; `repo_id = projectRoot`; `source_run_id = run.id`. The unique
  index makes a double-fire a no-op.

Executor *infrastructure crashes* (the `finalizeInfrastructureFailure` path) are **not recorded in
V1** (D6 — Phase 3). S4 changes **no routing behavior**; its only effect is a write-only
`run_outcomes` row per in-scope terminal run (see "routing unchanged, not byte-for-byte" under
Invariants).

### S5 — read path (aggregation + producer), opt-in

**Aggregation** — new pure module `packages/kernel/src/outcome-scoring.ts`, no port, fully unit-testable:

```ts
aggregateOutcomeScores(
  rows: readonly RunOutcome[],
  opts: { halfLifeMs: number; now: number },
): Map<WorkerLabel, { decayedSuccess: number; decayedSamples: number; rate: number; rawSamples: number }>;
```

Exponential **recency decay** by row age: `w_i = 2 ** (-(now - created_at) / halfLifeMs)`;
`decayedSuccess = Σ(w·success)`, `decayedSamples = Σ w`, `rate = decayedSuccess / decayedSamples`.
`rawSamples` is the **undecayed** row count per worker — used for cold-start coverage (decayed
samples shrink over time and could keep a sparse grain perpetually "uncovered"; raw counts only grow,
so coverage converges — R4 P2 fix). Decay is **retunable forever** because raw per-row timestamps are
kept (`now` injected for testability). (Resolves P1 #2.)

**Producer** — `chooseWorker(scores, opts): WorkerLabel | undefined`:

#### cold start / exploration (P1 #6)

```ts
chooseWorker(
  scores: ReturnType<typeof aggregateOutcomeScores>,
  opts: {
    candidates: readonly WorkerLabel[];   // ["sdk","claude-code","codex"]
    minSamples: number;                    // coverage + eligibility gate
    epsilon: number;                       // optional steady-state P(explore); 0 disables
    exploreSeed?: number;                  // per-RUN seed (see below); only used post-coverage
  },
): WorkerLabel | undefined;
```

Decision order:
1. **Cold-start coverage (seed-free, deterministic).** If any candidate has **`rawSamples <
   minSamples`** (undecayed count — so coverage is monotonic and actually converges; R4 P2), return
   the candidate with the fewest `rawSamples` (tie-break by candidate order). This *guarantees* every
   candidate — including the ones the default path never picks — climbs to `minSamples`, with no RNG
   and no per-unit frozen coin. This is the fix for the R3 starvation P1.
2. **Exploit.** Once all candidates are covered, return the highest-`rate` candidate.
3. **Optional steady-state ε.** If `epsilon > 0` and a **per-run** `exploreSeed` is supplied,
   `seededUnitInterval(exploreSeed) < epsilon` re-explores the least-sampled candidate. The seed
   **must vary per run, not per unit** (a per-unit seed froze the decision in R3). Since the run id
   is minted inside `createRun` *after* scoring (`store.ts:1937`), S5 must pre-mint/pass a run id (or
   another per-run value) into the hook, or omit ε for V1 — cold-start rotation + exploit already
   guarantees coverage without it.

Returning `"sdk"` (or `undefined`) ⇒ leave the hint absent (default executor).

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
**unchanged** when any of:
- the packet is **not a model packet** (`packet.execution` is set — D5; a command packet must never
  receive a `preferredWorker`, or it would be mis-recorded as `sdk`);
- `routingHints.preferredWorker` is already set (**never override an explicit hint** — contract rule 3);
- `chooseWorker` returns `undefined` or `"sdk"`.

Otherwise it returns a packet with the filled hint. Because the **same** `routedPacket` is both
snapshotted by `createRun` (`store.ts:1959`, `unit_snapshot`) and read at execution
(`orchestrator.ts:1136`), **recorded route == actual route** by construction. No downstream mutation
(not `runtimeRouter`). (Resolves P1 #3 and feeds the clean P1 #4 recording above.)

**Config / flag** (D2): `outcomeRouting: { enabled: boolean (default false), epsilon (default 0),
halfLifeMs, minSamples, candidates }`. `epsilon` defaults to **0** because V1 threads no per-run
seed — a non-zero ε with an undefined seed would be silently inert (R4 P2). Cold-start rotation
guarantees coverage without ε; ε is enabled only once a per-run seed is wired (Phase 3). Disabled ⇒
`fillRoutingHints` is never called ⇒ routing unchanged.

### Other `createRun` sites

`storage.createRun` is called from additional sites that are **not** fresh routing decisions:
profile-resolution failure (`orchestrator.ts:1063`) and approval suspension (`orchestrator.ts:1095`)
— corrected from the earlier "retry/child" guess after the R3 challenge. These commit a run where
**no model worker runs**, so the producer must **not** fire there and the recorder appends **no**
row (the phase gate / model-packet predicate excludes them). Only the `prepareRun` (`:689`)
fresh-decision path gets the producer. S5 verify-first re-confirms each site against the live source.

## Slices

| Slice | Scope | Routing change | Merge gate |
|---|---|---|---|
| **S4** | `run_outcomes` table (+ grain index + `uq_run_outcomes_run` unique index) + `assertTableColumns`; `WorkerLabel`/`AppendRunOutcomeInput`/`RunOutcome` types **+ `index.ts` barrel exports**; idempotent `appendRunOutcome`/`listRunOutcomes` port + store impl **+ test-double updates**; a recorder at `finalizeRun` (model packets only, `packet.model !== undefined`; infra-failure crashes → Phase 3). | None to routing; adds a write-only row per in-scope terminal run. | Manual Opus review (new table + port + recorder). |
| **S5** | `outcome-scoring.ts` (aggregate + `chooseWorker` with seed-free cold-start rotation, pure); `fillRoutingHints` producer in `prepareRun` before `:689` (model-packets only, fill-not-override); `outcomeRouting` config flag (default OFF). Depends on S4. | Behind opt-in flag; default OFF. | Manual Opus review (load-bearing routing). |

Each slice: TDD; verify command `pnpm -C <worktree> exec vitest run <pkg>/test`; then the gate —
full suite + `pnpm -C <worktree> lint` + changeset. (Per the slice-verify-command memory: use
`pnpm -C <wt> exec vitest run`, never `pnpm --filter buildplane test`.)

## P1 → resolution map

| R2 P1 | Resolution |
|---|---|
| #1 tally destroyed | Append-only raw rows; no supersession (D1). |
| #2 decay unimplementable | Raw timestamps + read-time exponential decay; retunable (D1, S5). |
| #3 recorded ≠ actual | Producer fills before `createRun` (`:689`); same packet snapshotted + executed (D2). |
| #4 no worker provenance | Recorded==actual ⇒ `snapshot.preferredWorker ?? "sdk"` is the worker; recorder reads it at `finalizeRun` (D6). |
| #5 taskType optional | Grain key `intent?.taskType ?? unit.kind`; `unit.kind` required ⇒ never null. |
| #6 cold start / starvation | **Seed-free deterministic least-sampled rotation until coverage** (D4), not a per-unit-frozen ε coin; ε is optional steady-state with a per-run seed. |
| #7 uniqueness / score-confidence | No stored score/confidence (derived at read); `uq_run_outcomes_run` unique index + idempotent insert ⇒ one run = one row, no double-weighting. |

### R3 findings → resolution

| R3 finding | Resolution |
|---|---|
| [P1] command packets mis-recorded as `sdk` | D5: model-packet scope — `execution` packets excluded from recording + routing. |
| [P1] infra-failure path unrecorded → upward bias | (R4-corrected) Record at `finalizeRun` only; executor infra-crashes deferred to Phase 3 (D6) — `finalizeRun` covers success + quality-failure, which is the worker-quality signal. |
| [P1] no `source_run_id` uniqueness | `uq_run_outcomes_run` + idempotent `INSERT … ON CONFLICT DO NOTHING`. |
| [P1] frozen-per-unit ε starves | Seed-free cold-start rotation; ε per-run + optional. |
| [P2] createRun sites misclassified | Corrected to profile-resolution (`:1063`) + approval-suspension (`:1095`), no row. |
| [P2] "byte-for-byte unchanged" false | Reworded: routing unchanged; S4 adds a write-only row. |
| [P2] missing barrel exports / test doubles | Added to the S4 task list. |

### R4 findings → resolution

| R4 finding | Resolution |
|---|---|
| [P1] `execution===undefined` is an incomplete model predicate | Predicate is now **`packet.model !== undefined`** (D5; `UnitPacket.model` confirmed in run-loop.ts:33). |
| [P1] `ctx.workerStarted` / infra-failure context doesn't exist | Recording scoped to **`finalizeRun` only** (D6); infra-failure-crash recording deferred to Phase 3. No invented flag. |
| [P2] cold-start on decayed samples never converges | Coverage keyed on **`rawSamples`** (undecayed, monotonic); decay reserved for exploit `rate`. |
| [P2] ε=0.1 inert with no seed | `epsilon` defaults to **0**; ε requires a per-run seed (Phase 3). |

## Invariants

1. `repoId = projectRoot`. Grain = `(repoId, taskType, worker)`, `worker ∈ {sdk,claude-code,codex}`.
2. **Model packets only** (D5): in scope iff `packet.model !== undefined`; command/non-model packets
   are excluded from recording + routing. Recording is **`finalizeRun`-only** (D6); infra-failure
   crashes are Phase 3.
3. Recorded route == actual route (producer fills pre-snapshot; no late mutation).
4. Never override an explicit `routingHints.preferredWorker` (the producer only fills when absent).
5. **One run = at most one `run_outcomes` row** (`uq_run_outcomes_run` + idempotent insert).
6. **Routing unchanged, not byte-for-byte unchanged.** With the flag OFF, `fillRoutingHints` is
   never called ⇒ routing is identical to today. S4's recorder still appends a write-only outcome
   row per in-scope terminal run — a new write with **no** routing or observable-execution effect.
7. Cold-start coverage is guaranteed seed-free; ε steady-state exploration requires a per-run seed.
8. `run_outcomes` is append-only; no existing-table DDL is altered (only ADD).

## Off-limits (unchanged from contract)

`BuildplaneMemoryPort` / `extractLearnings()` / `learning-store.ts`; `promoteMemoryFromReceipt`;
the `memory-retrieval.ts` ranking algorithm; existing table DDL; embeddings / team / Postgres.

## Deferred to Phase 3

Retention / compaction of `run_outcomes`; model/effort routing grain (Phase-2 grain is
`preferredWorker`/worker only); graded continuous outcome scores; promotion automation; embeddings;
team/Postgres mode. **Executor infra-failure-path outcome recording** (D6 — needs a worker-started
signal threaded into `finalizeInfrastructureFailure` + per-site classification). **ε steady-state
exploration** (needs a per-run seed pre-minted before `createRun`).
