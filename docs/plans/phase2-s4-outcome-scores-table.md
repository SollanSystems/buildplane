# Phase 2 · S4 — run_outcomes Table + Store + Recorder — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development (or executing-plans). Steps use `- [ ]` checkboxes.

**Goal:** Add the layer-5 outcome-memory **write path**: a new append-only `run_outcomes` table (one row per finished run), `WorkerLabel`/`AppendRunOutcomeInput`/`RunOutcome` types, `appendRunOutcome`/`listRunOutcomes` port methods, and a **recorder** at run finalization that appends each run's `(taskType, worker, success)`.

**Architecture:** Raw per-run rows, aggregated at read time (S5) — **no accumulator, no stored score/confidence**. Append-only; nothing is superseded. The worker that ran is read back from the run's `unit_snapshot` (recorded==actual, guaranteed once S5's producer lands; pre-S5 it records the incoming packet's worker, also correct).

**Tech Stack:** TypeScript (ESM, `.js`), Node ≥24.13, vitest, `@buildplane/storage`, `@buildplane/kernel`.

> **✅ Redesigned 2026-05-28** per `docs/superpowers/specs/2026-05-28-track2-outcome-memory-redesign-design.md` (operator-approved). **Supersedes** the `outcome_scores` accumulator model that Codex gate **R2** marked not-dispatch-ready. The 7 R2 P1s are resolved by construction — see the spec's "P1 → resolution map". **This plan must pass `/codex challenge` before dispatch.**

## Opus Planning Reference (handoff contract)

- **Slice ID:** `phase2-s4-run-outcomes-table`
- **Phase:** 2 · Track 2 — **serial, AFTER all of Track 1 lands** (Track 1 = S3/S2/S1, already merged on `origin/main`). Gates S5.
- **Branch base:** cut worktree from `origin/main` (hard invariant). Re-verify tip at dispatch.
- **Authority:** the redesign spec (above) + `docs/plans/phase2-memory-contract.md` (Track 2 section, amended 2026-05-28).
- **Storage model:** new append-only DDL in `bootstrapStorageProjectionSchema` (`store.ts:433`, near the `repo_facts` block `:505`). **No supersession, no `status`, no stored score/confidence/sample_count.** Registered in the schema-assertion table lists (`assertBaselineStorageProjectionSchema` :599, `assertInitializableStorageProjectionSchema` :628).
- **Invariants:** `repo_id = projectRoot` (the `createBuildplaneStorage(root)` root; `provenance.repoId === root`). `worker ∈ {"sdk","claude-code","codex"}` — the 3-value reality (`RoutingHints.preferredWorker` is only `claude-code|codex`; absent ⇒ `"sdk"`).
- **Port:** ADD `appendRunOutcome`/`listRunOutcomes` to `BuildplaneStoragePort` after the `listEvents` method (`ports.ts:153`).
- **Recorder:** in `orchestrator.ts` `finalizeRun` (`:762`) — append one row per terminal run.
- **Codex target (second gate):** the column set + the append-only/raw-rows decision + the `worker`/`taskType` derivation.
- **Off-limits:** altering ANY existing table DDL (only ADD `run_outcomes`); the `routingHints` consumer; aggregation/producer logic (S5).
- **Merge eligibility:** new table + port + recorder → **manual Opus review** (trust/storage surface).
- **Verify command:** `pnpm -C <worktree> exec vitest run packages/storage/test packages/kernel/test`. **Then the gate:** full suite + `pnpm -C <worktree> lint` + changeset. (Per memory: never `pnpm --filter buildplane test`.)

## Verify-first (BEFORE implementation)

- [ ] **VF-1:** Re-confirm zero `run_outcomes`/`RunOutcome`/`appendRunOutcome` symbols on `origin/main`. Confirm the table does not exist.
- [ ] **VF-2:** Read `repo_facts` DDL + its registration in the three schema fns (`store.ts:433/599/628`) and the `assertTableColumns` pattern (`:362`). Mirror the *style* only — `run_outcomes` is append-only (no `status`/`updated_at`).
- [ ] **VF-3:** Confirm `repoId = projectRoot` via the `createBuildplaneStorage(root)` root (test: `provenance.repoId === root`, see `repo-facts.test.ts`). Confirm `appendRunOutcome` derives `repo_id` internally (like `upsertRepoFact`) — not from input.
- [ ] **VF-4:** Pin the **run-status vocabulary** at `finalizeRun` (orchestrator.ts:762) and the `run-completed` payload status (`store.ts:1809`): which terminal states are *success* (→1) vs *failure* (→0), and which non-terminal/cancelled states append **no** row. Confirm the run's `unit_snapshot` + `validatedPacket` are reachable at the recorder seam, and that `taskType = packet.intent?.taskType ?? packet.unit.kind` is resolvable there.

## File Structure

- `packages/kernel/src/memory-types.ts` — **modify:** add `WorkerLabel`, `AppendRunOutcomeInput`, `RunOutcome`.
- `packages/kernel/src/ports.ts` — **modify:** add `appendRunOutcome`/`listRunOutcomes` to `BuildplaneStoragePort` after `:153`.
- `packages/storage/src/store.ts` — **modify:** `run_outcomes` DDL + index in `bootstrapStorageProjectionSchema`; register in the two assertion fns; implement `appendRunOutcome`/`listRunOutcomes`.
- `packages/kernel/src/orchestrator.ts` — **modify:** recorder call in `finalizeRun`.
- `packages/storage/test/run-outcomes.test.ts` — **new.**
- `packages/kernel/test/…` — **new:** recorder integration test.

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
```

- [ ] **Step 4 — register `run_outcomes`** in the table-name lists of `assertBaselineStorageProjectionSchema` (:599) and `assertInitializableStorageProjectionSchema` (:628), matching how `repo_facts` is listed (and the `:604` `sqlite_master` IN-list).

- [ ] **Step 5 — implement** `appendRunOutcome`/`listRunOutcomes` on the storage object (mirror the `upsertRepoFact`/`listRepoFacts` impl shape; `repo_id = the store root`; `id` via the existing id generator; `created_at` via the existing timestamp helper; `success` stored as `0|1`, read back as boolean; `listRunOutcomes` builds `WHERE` clauses for `repo_id` (default = root) + optional `task_type`/`worker`, `ORDER BY created_at, rowid`).

- [ ] **Step 6 — run, expect PASS.** Then `pnpm -C <worktree> exec tsc -p packages/kernel` PASS (port now implemented).

- [ ] **Step 7 — commit:** `feat(storage): append-only run_outcomes table + appendRunOutcome/listRunOutcomes`

### Task 4 — recorder in finalizeRun

**Files:** Modify `packages/kernel/src/orchestrator.ts` (`finalizeRun`, :762); new kernel integration test

- [ ] **Step 1 — failing integration test** (using the existing orchestrator test harness): run a unit to terminal **success** with no `routingHints` ⇒ exactly one `run_outcomes` row with `worker === "sdk"`, `success === true`, `taskType === <unit.kind or intent.taskType>`, `sourceRunId === run.id`. A second run with `routingHints.preferredWorker === "codex"` ⇒ a row with `worker === "codex"`.

- [ ] **Step 2 — run, expect FAIL** (no row appended).

- [ ] **Step 3 — implement the recorder** in `finalizeRun`, gated to terminal success/failure per VF-4:

```ts
// finalizeRun, once the terminal status is known:
const isSuccess = isTerminalSuccess(status);     // VF-4 mapping
const isFailure = isTerminalFailure(status);
if (isSuccess || isFailure) {
	const packet = ctx.validatedPacket;            // == unit_snapshot (recorded==actual)
	storage.appendRunOutcome({
		taskType: packet.intent?.taskType ?? packet.unit.kind,
		worker: packet.routingHints?.preferredWorker ?? "sdk",
		success: isSuccess,
		sourceRunId: ctx.run.id,
	});
}
```

- [ ] **Step 4 — run, expect PASS.**

- [ ] **Step 5 — commit:** `feat(kernel): record run outcomes on finalization`

### Task 5 — changeset + gate

- [ ] **Step 1 — changeset:** `pnpm -C <worktree> changeset` — minor bump for `@buildplane/storage` + `@buildplane/kernel`, summary "S4: append-only run_outcomes write path".
- [ ] **Step 2 — full gate:** `pnpm -C <worktree> exec vitest run` (full suite) + `pnpm -C <worktree> lint`. Both green.
- [ ] **Step 3 — commit** the changeset.

## Acceptance criteria

- `run_outcomes` table created and registered in both schema-assertion fns; **no existing DDL altered**.
- `appendRunOutcome` → `listRunOutcomes` round-trips, append-only (repeat grain ⇒ +1 row, never supersede), `repo_id = root`, `success` boolean round-trips, scoped by `task_type`/`worker`.
- `finalizeRun` appends exactly one row per terminal success/failure run; `worker = snapshot.preferredWorker ?? "sdk"`; non-terminal/cancelled runs append none.
- Grain = `(repoId, taskType, worker)`, `worker ∈ {sdk,claude-code,codex}`. No routing behavior changed.
- Schema + recorder passed `/codex challenge`. Full suite + lint green; changeset added.
