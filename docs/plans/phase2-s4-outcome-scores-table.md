# Phase 2 · S4 — run_outcomes Table + Store + Recorder — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development (or executing-plans). Steps use `- [ ]` checkboxes.

**Goal:** Add the layer-5 outcome-memory **write path**: a new append-only `run_outcomes` table (one row per finished run), `WorkerLabel`/`AppendRunOutcomeInput`/`RunOutcome` types, `appendRunOutcome`/`listRunOutcomes` port methods, and a **recorder** at run finalization that appends each run's `(taskType, worker, success)`.

**Architecture:** Raw per-run rows, aggregated at read time (S5) — **no accumulator, no stored score/confidence**. Append-only; nothing is superseded. The worker that ran is read back from the run's `unit_snapshot` (recorded==actual, guaranteed once S5's producer lands; pre-S5 it records the incoming packet's worker, also correct).

**Tech Stack:** TypeScript (ESM, `.js`), Node ≥24.13, vitest, `@buildplane/storage`, `@buildplane/kernel`.

> **✅ Redesigned 2026-05-28** per `docs/superpowers/specs/2026-05-28-track2-outcome-memory-redesign-design.md` (operator-approved). **Supersedes** the `outcome_scores` accumulator model that Codex **R2** marked not-dispatch-ready. R2 (7 P1) + **R3** (command-packet scope, infra-failure path, `source_run_id` uniqueness, ε starvation) + **R4** (model predicate = `packet.model`; recording `finalizeRun`-only; raw-count coverage; ε default 0) findings resolved — see the spec's resolution maps. **Pending R5 `/codex challenge` before dispatch.**

## Opus Planning Reference (handoff contract)

- **Slice ID:** `phase2-s4-run-outcomes-table`
- **Phase:** 2 · Track 2 — **serial, AFTER all of Track 1 lands** (Track 1 = S3/S2/S1, already merged on `origin/main`). Gates S5.
- **Branch base:** cut worktree from `origin/main` (hard invariant). Re-verify tip at dispatch.
- **Authority:** the redesign spec (above) + `docs/plans/phase2-memory-contract.md` (Track 2 section, amended 2026-05-28).
- **Storage model:** new append-only DDL in `bootstrapStorageProjectionSchema` (`store.ts:433`, near the `repo_facts` block `:505`). **No supersession, no `status`, no stored score/confidence/sample_count.** Registered in the schema-assertion table lists (`assertBaselineStorageProjectionSchema` :599, `assertInitializableStorageProjectionSchema` :628).
- **Invariants:** `repo_id = projectRoot` (the `createBuildplaneStorage(root)` root; `provenance.repoId === root`). `worker ∈ {"sdk","claude-code","codex"}` — the 3-value reality (`RoutingHints.preferredWorker` is only `claude-code|codex`; absent ⇒ `"sdk"`).
- **Port:** ADD `appendRunOutcome`/`listRunOutcomes` to `BuildplaneStoragePort` after the `listEvents` method (`ports.ts:153`).
- **Recorder:** at `finalizeRun` (`:762`) only — the post-execution terminal commit — **model packets only** (`packet.model !== undefined`); `worker = snapshot.preferredWorker ?? "sdk"`; idempotent insert. Executor infra-crashes (`finalizeInfrastructureFailure`) are out of scope for V1 (Phase 3).
- **Codex target (second gate):** the column set + the append-only/raw-rows decision + the `worker`/`taskType` derivation.
- **Off-limits:** altering ANY existing table DDL (only ADD `run_outcomes`); the `routingHints` consumer; aggregation/producer logic (S5).
- **Merge eligibility:** new table + port + recorder → **manual Opus review** (trust/storage surface).
- **Verify command:** `pnpm -C <worktree> exec vitest run packages/storage/test packages/kernel/test`. **Then the gate:** full suite + `pnpm -C <worktree> lint` + changeset. (Per memory: never `pnpm --filter buildplane test`.)

## Verify-first (BEFORE implementation)

- [ ] **VF-1:** Re-confirm zero `run_outcomes`/`RunOutcome`/`appendRunOutcome` symbols on `origin/main`. Confirm the table does not exist.
- [ ] **VF-2:** Read `repo_facts` DDL + its registration in the three schema fns (`store.ts:433/599/628`) and the `assertTableColumns` pattern (`:362`). Mirror the *style* only — `run_outcomes` is append-only (no `status`/`updated_at`).
- [ ] **VF-3:** Confirm `repoId = projectRoot` via the `createBuildplaneStorage(root)` root (test: `provenance.repoId === root`, see `repo-facts.test.ts`). Confirm `appendRunOutcome` derives `repo_id` internally (like `upsertRepoFact`) — not from input.
- [ ] **VF-4:** Pin the **run-status vocabulary** at `finalizeRun` (orchestrator.ts:762) and the `run-completed` payload status (`store.ts:1809`): which terminal states are *success* (→1) vs *failure* (→0). Confirm the run's `unit_snapshot` + `validatedPacket` are reachable at the recorder seam, and that `taskType = packet.intent?.taskType ?? packet.unit.kind` is resolvable there.
- [ ] **VF-5 (R4 — recording site):** Confirm `finalizeRun` (:762) is reached **only post-execution**, and that **both** clean success and quality-failure (worker ran, output rejected) terminal-commit through it (with a status distinguishing the two for the VF-4 mapping). Confirm `finalizeInfrastructureFailure` (:613, callers incl. :1041/:1243/:1335) is the path for executor crashes — **out of scope for V1** (D6). Confirm `ctx.validatedPacket` (== the routed packet == `unit_snapshot`) and `ctx.run.id` are in scope at the recorder seam.
- [ ] **VF-6 (R4 P1 / D5):** Pin the **model-packet predicate = `packet.model !== undefined`** against the live `UnitPacket` type (`run-loop.ts:30-39` — has both `execution?` and `model?`). Confirm `model` and `execution` are mutually exclusive on real packets, and that a packet with neither would otherwise default to the SDK executor (`run-cli.ts:1369`) — hence `model`-presence, not `execution`-absence, is the correct gate for recording + routing.

## File Structure

- `packages/kernel/src/memory-types.ts` — **modify:** add `WorkerLabel`, `AppendRunOutcomeInput`, `RunOutcome`.
- `packages/kernel/src/index.ts` — **modify:** export the three new types (barrel; storage imports via `@buildplane/kernel`).
- `packages/kernel/src/ports.ts` — **modify:** add `appendRunOutcome`/`listRunOutcomes` to `BuildplaneStoragePort` after `:153`.
- `packages/storage/src/store.ts` — **modify:** `run_outcomes` DDL + grain index + `uq_run_outcomes_run` unique index in `bootstrapStorageProjectionSchema`; register in the two assertion fns; implement idempotent `appendRunOutcome`/`listRunOutcomes`.
- `packages/kernel/src/orchestrator.ts` — **modify:** recorder in `finalizeRun`, model packets only (`packet.model !== undefined`); infra-failure path out of scope (Phase 3).
- `BuildplaneStoragePort` test doubles (grep to locate) — **modify:** add the two new methods.
- `packages/storage/test/run-outcomes.test.ts` — **new.**
- `packages/kernel/test/…` — **new:** recorder integration tests (success / hint / infra-failure / command-packet / pre-execution).

## Tasks (TDD)

### Task 1 — types

**Files:** Modify `packages/kernel/src/memory-types.ts`

- [ ] **Step 1 — add the types** (after the procedure/repo-fact types):

```ts
export type WorkerLabel = "sdk" | "claude-code" | "codex";

export interface AppendRunOutcomeInput {
	readonly taskType: string;
	readonly worker: WorkerLabel;
	readonly success: boolean;
	readonly sourceRunId: string;
}

export interface RunOutcome {
	readonly id: string;
	readonly repoId: string;
	readonly taskType: string;
	readonly worker: WorkerLabel;
	readonly success: boolean;
	readonly sourceRunId: string;
	readonly createdAt: string;
}
```

- [ ] **Step 2 — commit:** `feat(kernel): run-outcome memory types`

### Task 2 — port surface

**Files:** Modify `packages/kernel/src/ports.ts` (after the `listEvents` method, ~:153)

- [ ] **Step 1 — add to `BuildplaneStoragePort`:**

```ts
appendRunOutcome(input: AppendRunOutcomeInput): RunOutcome;
listRunOutcomes(options?: {
	repoId?: string;
	taskType?: string;
	worker?: WorkerLabel;
}): readonly RunOutcome[];
```

- [ ] **Step 2 — add the imports** for `AppendRunOutcomeInput`, `RunOutcome`, `WorkerLabel` to the existing `memory-types.js` import in `ports.ts`. Run `pnpm -C <worktree> exec tsc -p packages/kernel` — expect FAIL (store doesn't implement them yet); that failure drives Task 3.

### Task 3 — table + DDL

**Files:** Modify `packages/storage/src/store.ts`; new `packages/storage/test/run-outcomes.test.ts`

- [ ] **Step 1 — failing test (table exists, scoped append/list round-trips):**

```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createBuildplaneStorage } from "../src";

describe("run_outcomes storage", () => {
	it("appends raw per-run rows and lists them scoped by task/worker", () => {
		const root = mkdtempSync(join(tmpdir(), "buildplane-run-outcomes-"));
		const storage = createBuildplaneStorage(root);
		storage.initializeProject();

		const a = storage.appendRunOutcome({
			taskType: "implement",
			worker: "codex",
			success: true,
			sourceRunId: "run-1",
		});
		storage.appendRunOutcome({
			taskType: "implement",
			worker: "sdk",
			success: false,
			sourceRunId: "run-2",
		});
		storage.appendRunOutcome({
			taskType: "review",
			worker: "codex",
			success: true,
			sourceRunId: "run-3",
		});

		expect(a.repoId).toBe(root);
		expect(a.createdAt).toMatch(/\d{4}-\d{2}-\d{2}T/);
		expect(storage.listRunOutcomes({ taskType: "implement" })).toHaveLength(2);
		expect(storage.listRunOutcomes({ taskType: "implement", worker: "codex" })).toHaveLength(1);
		// append-only: repeating the same grain does NOT supersede
		storage.appendRunOutcome({ taskType: "implement", worker: "codex", success: false, sourceRunId: "run-4" });
		expect(storage.listRunOutcomes({ taskType: "implement", worker: "codex" })).toHaveLength(2);
	});
});
```

- [ ] **Step 2 — run, expect FAIL:** `pnpm -C <worktree> exec vitest run packages/storage/test/run-outcomes.test.ts` → FAIL (`appendRunOutcome is not a function`).

- [ ] **Step 3 — add DDL** inside `bootstrapStorageProjectionSchema` (near the `repo_facts` block, `store.ts:505`):

```sql
CREATE TABLE IF NOT EXISTS run_outcomes (
	id TEXT PRIMARY KEY,
	repo_id TEXT NOT NULL,
	task_type TEXT NOT NULL,
	worker TEXT NOT NULL,
	success INTEGER NOT NULL,
	source_run_id TEXT NOT NULL,
	created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_run_outcomes_grain ON run_outcomes (repo_id, task_type, worker);
CREATE UNIQUE INDEX IF NOT EXISTS uq_run_outcomes_run ON run_outcomes (repo_id, source_run_id);
```

The unique index makes **one run = at most one row** so a recorder that fires twice (two terminal
paths, retry, replay) cannot double-weight a run. The test in Step 1 already asserts a repeated
grain appends a *new* row (different `source_run_id`); add an assertion that the **same**
`source_run_id` is a no-op (idempotent).

- [ ] **Step 4 — register `run_outcomes`** in the table-name lists of `assertBaselineStorageProjectionSchema` (:599) and `assertInitializableStorageProjectionSchema` (:628), matching how `repo_facts` is listed (and the `:604` `sqlite_master` IN-list).

- [ ] **Step 5 — implement** `appendRunOutcome`/`listRunOutcomes` on the storage object (mirror the `upsertRepoFact`/`listRepoFacts` impl shape; `repo_id = the store root`; `id` via the existing id generator; `created_at` via the existing timestamp helper; `success` stored as `0|1`, read back as boolean). `appendRunOutcome` is **idempotent**: `INSERT INTO run_outcomes (...) VALUES (...) ON CONFLICT(repo_id, source_run_id) DO NOTHING` (the `uq_run_outcomes_run` index), then return the existing-or-inserted row. `listRunOutcomes` builds `WHERE` clauses for `repo_id` (default = root) + optional `task_type`/`worker`, `ORDER BY created_at, rowid`.

- [ ] **Step 6 — run, expect PASS.** Then `pnpm -C <worktree> exec tsc -p packages/kernel` PASS (port now implemented).

- [ ] **Step 7 — commit:** `feat(storage): append-only run_outcomes table + appendRunOutcome/listRunOutcomes`

### Task 4 — recorder at finalizeRun (model packets only)

**Files:** Modify `packages/kernel/src/orchestrator.ts` (`finalizeRun` :762); new kernel integration test

> **R4 P1 (corrected from R3):** `UnitPacket` has both `execution?` and **`model?`** (`run-loop.ts:32-33`);
> the model-packet predicate is **`packet.model !== undefined`** (a packet with neither field still
> falls through to the SDK default at `run-cli.ts:1369`, so `execution===undefined` is not enough).
> There is **no `ctx.workerStarted` flag**, and `finalizeInfrastructureFailure` receives only `run`.
> So V1 records at the single post-execution terminal commit **`finalizeRun`** (D6) — clean success
> *and* quality-failure both land there. Executor **infra crashes** (the `finalizeInfrastructureFailure`
> path) are **out of scope for V1** (Phase 3). No invented flag, no 15-site classification.

- [ ] **Step 1 — failing integration tests** (existing orchestrator harness):
  1. model run (`packet.model` set), terminal **success**, no `routingHints` ⇒ exactly one row `worker==="sdk"`, `success===true`, `taskType===unit.kind`, `sourceRunId===run.id`.
  2. model run with `preferredWorker==="codex"` ⇒ row `worker==="codex"`.
  3. model run that reaches `finalizeRun` with a **failed/rejected** terminal status (worker ran, output rejected) ⇒ a row with `success===false`.
  4. a **command packet** (`execution` set, `model` unset) ⇒ **no** row.
  5. a packet with **no `model`** ⇒ **no** row.

- [ ] **Step 2 — run, expect FAIL.**

- [ ] **Step 3 — implement** the recorder in `finalizeRun`, once the terminal status is known (VF-4/VF-6):

```ts
// finalizeRun, terminal status known:
const packet = ctx.validatedPacket;                  // == routedPacket == unit_snapshot
if (packet.model !== undefined) {                    // model packet only (D5; run-loop.ts:33)
	storage.appendRunOutcome({                       // idempotent (uq_run_outcomes_run)
		taskType: packet.intent?.taskType ?? packet.unit.kind,
		worker: packet.routingHints?.preferredWorker ?? "sdk",
		success: isTerminalSuccess(status),          // VF-4 status mapping
		sourceRunId: ctx.run.id,
	});
}
```

Do **not** add recording to `finalizeInfrastructureFailure` in V1 (D6 — Phase 3).

- [ ] **Step 4 — run, expect PASS.**

- [ ] **Step 5 — commit:** `feat(kernel): record model-run outcomes at finalizeRun`

### Task 4b — barrel exports + test doubles

**Files:** Modify `packages/kernel/src/index.ts`; any `BuildplaneStoragePort` test doubles

- [ ] **Step 1:** export `WorkerLabel`, `AppendRunOutcomeInput`, `RunOutcome` from `index.ts` (the package barrel; storage imports kernel types via `@buildplane/kernel`). Run `pnpm -C <worktree> exec tsc -p packages/storage` — expect PASS.
- [ ] **Step 2:** grep for `BuildplaneStoragePort` test doubles / mocks (`grep -rn "BuildplaneStoragePort" packages apps --include=*.ts -l`); add `appendRunOutcome`/`listRunOutcomes` stubs so the suite type-checks.
- [ ] **Step 3 — commit:** `chore(kernel): export run-outcome types + update storage-port test doubles`

### Task 5 — changeset + gate

- [ ] **Step 1 — changeset:** `pnpm -C <worktree> changeset` — minor bump for `@buildplane/storage` + `@buildplane/kernel`, summary "S4: append-only run_outcomes write path".
- [ ] **Step 2 — full gate:** `pnpm -C <worktree> exec vitest run` (full suite) + `pnpm -C <worktree> lint`. Both green.
- [ ] **Step 3 — commit** the changeset.

## Acceptance criteria

- `run_outcomes` table + grain index + `uq_run_outcomes_run` unique index created and registered in both schema-assertion fns; **no existing DDL altered**.
- `appendRunOutcome` → `listRunOutcomes` round-trips; append-only across *distinct* runs (repeat grain, new `source_run_id` ⇒ +1 row); **idempotent** for a repeated `source_run_id` (no second row); `repo_id = root`; `success` boolean; scoped by `task_type`/`worker`.
- The `finalizeRun` recorder appends exactly one row per **model** terminal run (`packet.model !== undefined`); `worker = snapshot.preferredWorker ?? "sdk"`. **Command/non-model packets append none**; executor infra-crashes are not recorded in V1 (Phase 3).
- Grain = `(repoId, taskType, worker)`, `worker ∈ {sdk,claude-code,codex}`. Routing unchanged (a write-only row is added).
- New types exported from `index.ts`; storage-port test doubles updated; suite type-checks.
- Schema + recorder passed `/codex challenge` (R4). Full suite + lint green; changeset added.
