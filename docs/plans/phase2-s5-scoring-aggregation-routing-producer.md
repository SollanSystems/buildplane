# Phase 2 · S5 — Outcome Aggregation + routingHints Producer — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development (or executing-plans). Steps use `- [ ]` checkboxes.

**Goal:** Close the outcome-memory loop. Aggregate `run_outcomes` rows (read-time recency decay) and add a **producer** that fills `routingHints.preferredWorker` from those scores — inside `prepareRun` **before `storage.createRun` (`orchestrator.ts:689`)** so the recorded `unit_snapshot` route equals the executed route. Fill-not-override, directed ε-exploration, min-sample eligibility. **Opt-in, default OFF.**

**Architecture:** A pure, dependency-free scoring module (`outcome-scoring.ts`) does all the math (decay + eligibility + choose). A thin `fillRoutingHints` adapter reads `listRunOutcomes`, calls the module, and returns either the unchanged packet or a packet with one filled hint. The orchestrator calls it once, gated by a config flag; disabled ⇒ never called ⇒ zero behavior change.

**Tech Stack:** TypeScript (ESM, `.js`), Node ≥24.13, vitest, `@buildplane/kernel`, `@buildplane/storage`.

> **✅ Redesigned 2026-05-28** per `docs/superpowers/specs/2026-05-28-track2-outcome-memory-redesign-design.md` (operator-approved). **Supersedes** the mis-placed producer hook (`:1133`) and the accumulator dependency that Codex gate **R2** marked not-dispatch-ready. Hook moved before `createRun` (`:689`); exploration is **directed + deterministic**; steering is **opt-in, default OFF**. **This plan must pass `/codex challenge` before dispatch.**

## Opus Planning Reference (handoff contract)

- **Slice ID:** `phase2-s5-outcome-aggregation-routing-producer`
- **Phase:** 2 · Track 2 — **serial, AFTER S4.** Cut worktree from `origin/main` after S4 merges; re-verify tip.
- **Authority:** the redesign spec (above) + `docs/plans/phase2-memory-contract.md` (Track 2, amended 2026-05-28).
- **Aggregation:** per `(repoId, taskType, worker)` from `run_outcomes`; exponential recency decay `w = 2 ** (-ageMs / halfLifeMs)`; a worker is eligible to *exploit* only at `decayedSamples ≥ minSamples`. Pure module; `now` injected.
- **Producer hook:** inside `prepareRun`, after `validatePacketForWorkspaceRoot`, **before** `storage.createRun` (`orchestrator.ts:689`). Fill `preferredWorker` **only if absent**; with probability ε pick the **least-sampled** candidate (directed, deterministic via a run-derived seed); else exploit best decayed `rate`; else leave absent. Construct one `routedPacket`, use it for `createRun` **and** downstream ⇒ recorded==actual. **No late mutation** (not `runtimeRouter`, not orchestrator :1136, not run-cli :1359).
- **Worker↔hint mapping:** `worker ∈ {sdk,claude-code,codex}`; `preferredWorker ∈ {claude-code,codex}`. `chooseWorker` returning `"sdk"` (or `undefined`) ⇒ leave the hint **absent** (default executor). This is symmetric with S4's recorder (`absent ⇒ "sdk"`).
- **Invariants:** `repoId = projectRoot`. Recorded route == actual route. Never override an explicit `preferredWorker`. Default OFF ⇒ unchanged behavior.
- **Codex target (second gate):** the scoring math (decay, eligibility, directed-explore tie-break), the fill-not-override + route==record invariants, and the cold-start coverage argument.
- **Off-limits:** the `routingHints` consumer branches (`run-cli.ts:1359/1366`, orchestrator `:1136`, eval/runner); `run_outcomes` DDL + recorder (S4); promotion logic; `memory-retrieval.ts` ranking.
- **Merge eligibility:** load-bearing routing change → **manual Opus review.**
- **Verify command:** `pnpm -C <worktree> exec vitest run packages/kernel/test`. **Then the gate:** full suite + `pnpm -C <worktree> lint` + changeset.

## Verify-first (BEFORE implementation)

- [ ] **VF-1:** Confirm S4 shipped: `listRunOutcomes`/`appendRunOutcome` exist; `run_outcomes` populated by the recorder. Confirm `RunOutcome.createdAt` parses with `Date.parse`.
- [ ] **VF-2:** Confirm the orchestrator's construction/dependency-injection seam — **where `createOrchestrator` (or equiv) receives deps/config** — and add `outcomeRouting` there. **Do not assume a global `config`.** Confirm `storage` is in scope inside `prepareRun`.
- [ ] **VF-3:** Confirm `prepareRun` has `validatedPacket` + a stable run-derived value for the explore seed (e.g. the unit id / pending run id) available **before** `:689`, and that the value passed to `createRun` is the same object used downstream (so the snapshot reflects the fill).
- [ ] **VF-4:** Classify the other `createRun` call sites (`orchestrator.ts:1080`, `:1101`): which represent a **fresh** routing decision (need the producer) vs an **inherited/retry** packet (must NOT re-route — already carries the filled hint). Default: only `prepareRun:689` gets the producer. Record the classification.
- [ ] **VF-5:** Confirm an explicit incoming `routingHints.preferredWorker` flows through `prepareRun` unchanged when the flag is on (fill-not-override) and when off.

## File Structure

- `packages/kernel/src/outcome-scoring.ts` — **new:** `aggregateOutcomeScores`, `chooseWorker`, `seededUnitInterval` (pure).
- `packages/kernel/src/routing-producer.ts` — **new:** `OutcomeRoutingConfig`, `defaultOutcomeRoutingConfig`, `fillRoutingHints(packet, storage, cfg, now, seed)`.
- `packages/kernel/src/orchestrator.ts` — **modify:** thread `outcomeRouting` config; call `fillRoutingHints` in `prepareRun` before `:689`.
- `packages/kernel/test/outcome-scoring.test.ts`, `packages/kernel/test/routing-producer.test.ts` — **new.**
- `packages/kernel/test/…` — **new:** orchestrator integration test (recorded==actual; default-off no-op).

## Tasks (TDD)

### Task 1 — aggregation (pure)

**Files:** Create `packages/kernel/src/outcome-scoring.ts`; create `packages/kernel/test/outcome-scoring.test.ts`

- [ ] **Step 1 — failing tests:**

```ts
import { describe, expect, it } from "vitest";
import { aggregateOutcomeScores } from "../src/outcome-scoring.js";
import type { RunOutcome } from "../src/memory-types.js";

const row = (worker: RunOutcome["worker"], success: boolean, createdAt: string): RunOutcome => ({
	id: createdAt, repoId: "/r", taskType: "implement", worker, success, sourceRunId: createdAt, createdAt,
});
const HALF = 7 * 24 * 60 * 60 * 1000;            // 7-day half-life
const now = Date.parse("2026-05-28T00:00:00.000Z");

describe("aggregateOutcomeScores", () => {
	it("weights recent rows higher (one half-life ⇒ weight 0.5)", () => {
		const old = new Date(now - HALF).toISOString();
		const scores = aggregateOutcomeScores(
			[row("codex", true, new Date(now).toISOString()), row("codex", false, old)],
			{ halfLifeMs: HALF, now },
		);
		const c = scores.get("codex")!;
		expect(c.decayedSamples).toBeCloseTo(1.5, 5);   // 1.0 + 0.5
		expect(c.decayedSuccess).toBeCloseTo(1.0, 5);   // 1*1 + 0.5*0
		expect(c.rate).toBeCloseTo(1.0 / 1.5, 5);
	});

	it("groups by worker and is empty for no rows", () => {
		expect(aggregateOutcomeScores([], { halfLifeMs: HALF, now }).size).toBe(0);
	});
});
```

- [ ] **Step 2 — run, expect FAIL.**

- [ ] **Step 3 — implement:**

```ts
import type { RunOutcome, WorkerLabel } from "./memory-types.js";

export interface WorkerScore {
	readonly decayedSuccess: number;
	readonly decayedSamples: number;
	readonly rate: number;
}

export function aggregateOutcomeScores(
	rows: readonly RunOutcome[],
	opts: { halfLifeMs: number; now: number },
): Map<WorkerLabel, WorkerScore> {
	const acc = new Map<WorkerLabel, { s: number; n: number }>();
	for (const r of rows) {
		const ageMs = opts.now - Date.parse(r.createdAt);
		const w = 2 ** (-Math.max(0, ageMs) / opts.halfLifeMs);
		const cur = acc.get(r.worker) ?? { s: 0, n: 0 };
		acc.set(r.worker, { s: cur.s + (r.success ? w : 0), n: cur.n + w });
	}
	const out = new Map<WorkerLabel, WorkerScore>();
	for (const [worker, { s, n }] of acc) {
		out.set(worker, { decayedSuccess: s, decayedSamples: n, rate: n > 0 ? s / n : 0 });
	}
	return out;
}
```

- [ ] **Step 4 — run, expect PASS. Commit:** `feat(kernel): outcome score aggregation with recency decay`

### Task 2 — chooseWorker (pure)

**Files:** Modify `packages/kernel/src/outcome-scoring.ts`; modify the test

- [ ] **Step 1 — failing tests:**

```ts
import { chooseWorker, seededUnitInterval } from "../src/outcome-scoring.js";

const CANDS = ["sdk", "claude-code", "codex"] as const;

it("exploits the highest-rate eligible worker", () => {
	const scores = new Map([
		["codex", { decayedSuccess: 9, decayedSamples: 10, rate: 0.9 }],
		["sdk", { decayedSuccess: 5, decayedSamples: 10, rate: 0.5 }],
	]);
	expect(chooseWorker(scores, { candidates: CANDS, minSamples: 5, epsilon: 0, exploreSeed: 1 })).toBe("codex");
});

it("returns undefined when no worker meets min-sample (and not exploring)", () => {
	const scores = new Map([["codex", { decayedSuccess: 2, decayedSamples: 2, rate: 1 }]]);
	expect(chooseWorker(scores, { candidates: CANDS, minSamples: 5, epsilon: 0, exploreSeed: 1 })).toBeUndefined();
});

it("explores the least-sampled candidate when the seed falls under epsilon", () => {
	const scores = new Map([
		["sdk", { decayedSuccess: 8, decayedSamples: 8, rate: 1 }],
		["codex", { decayedSuccess: 2, decayedSamples: 2, rate: 1 }],
		// claude-code has zero samples ⇒ least-sampled
	]);
	const seed = explorerSeedUnder(0.2);   // helper picks a seed with seededUnitInterval < 0.2
	expect(chooseWorker(scores, { candidates: CANDS, minSamples: 5, epsilon: 0.2, exploreSeed: seed })).toBe("claude-code");
});

it("seededUnitInterval is deterministic and in [0,1)", () => {
	const v = seededUnitInterval(42);
	expect(v).toBe(seededUnitInterval(42));
	expect(v).toBeGreaterThanOrEqual(0);
	expect(v).toBeLessThan(1);
});
```

(`explorerSeedUnder` is a tiny test helper that scans integers until `seededUnitInterval(seed) < p`.)

- [ ] **Step 2 — run, expect FAIL.**

- [ ] **Step 3 — implement:**

```ts
export function seededUnitInterval(seed: number): number {
	// deterministic hash → [0,1); no RNG so routes are reproducible
	let x = (seed ^ 0x9e3779b9) >>> 0;
	x = Math.imul(x ^ (x >>> 16), 0x45d9f3b) >>> 0;
	x = Math.imul(x ^ (x >>> 16), 0x45d9f3b) >>> 0;
	return ((x ^ (x >>> 16)) >>> 0) / 0x100000000;
}

export function chooseWorker(
	scores: Map<WorkerLabel, WorkerScore>,
	opts: {
		candidates: readonly WorkerLabel[];
		minSamples: number;
		epsilon: number;
		exploreSeed: number;
	},
): WorkerLabel | undefined {
	const samples = (w: WorkerLabel) => scores.get(w)?.decayedSamples ?? 0;
	if (seededUnitInterval(opts.exploreSeed) < opts.epsilon) {
		const min = Math.min(...opts.candidates.map(samples));
		const least = opts.candidates.filter((w) => samples(w) === min);
		return least[opts.exploreSeed % least.length];     // deterministic tie-break rotates coverage
	}
	const eligible = opts.candidates.filter((w) => samples(w) >= opts.minSamples);
	if (eligible.length === 0) return undefined;
	return eligible.reduce((best, w) => ((scores.get(w)?.rate ?? 0) > (scores.get(best)?.rate ?? 0) ? w : best));
}
```

- [ ] **Step 4 — run, expect PASS. Commit:** `feat(kernel): chooseWorker (eligibility + directed exploration)`

### Task 3 — fillRoutingHints adapter + config

**Files:** Create `packages/kernel/src/routing-producer.ts`; create `packages/kernel/test/routing-producer.test.ts`

- [ ] **Step 1 — failing tests:** flag OFF ⇒ packet returned unchanged; explicit `preferredWorker` ⇒ never overridden (even with flag on); flag ON + hint absent + `chooseWorker` ⇒ `codex` ⇒ packet gains `routingHints.preferredWorker === "codex"`; `chooseWorker` ⇒ `sdk`/`undefined` ⇒ hint stays absent. Build packets with `intent.taskType` present and absent (fallback to `unit.kind`).

- [ ] **Step 2 — run, expect FAIL.**

- [ ] **Step 3 — implement:**

```ts
import type { BuildplaneStoragePort } from "./ports.js";
import type { UnitPacket } from "./run-loop.js";
import type { WorkerLabel } from "./memory-types.js";
import { aggregateOutcomeScores, chooseWorker } from "./outcome-scoring.js";

export interface OutcomeRoutingConfig {
	readonly enabled: boolean;
	readonly epsilon: number;
	readonly halfLifeMs: number;
	readonly minSamples: number;
	readonly candidates: readonly WorkerLabel[];
}

export const defaultOutcomeRoutingConfig: OutcomeRoutingConfig = {
	enabled: false,                                    // opt-in
	epsilon: 0.1,
	halfLifeMs: 14 * 24 * 60 * 60 * 1000,
	minSamples: 5,
	candidates: ["sdk", "claude-code", "codex"],
};

export function fillRoutingHints(
	packet: UnitPacket,
	storage: BuildplaneStoragePort,
	cfg: OutcomeRoutingConfig,
	now: number,
	exploreSeed: number,
): UnitPacket {
	if (!cfg.enabled) return packet;
	if (packet.routingHints?.preferredWorker) return packet;     // never override
	const taskType = packet.intent?.taskType ?? packet.unit.kind;
	const scores = aggregateOutcomeScores(
		storage.listRunOutcomes({ taskType }),
		{ halfLifeMs: cfg.halfLifeMs, now },
	);
	const worker = chooseWorker(scores, {
		candidates: cfg.candidates, minSamples: cfg.minSamples, epsilon: cfg.epsilon, exploreSeed,
	});
	if (!worker || worker === "sdk") return packet;              // sdk ⇒ leave hint absent
	return { ...packet, routingHints: { ...packet.routingHints, preferredWorker: worker } };
}
```

- [ ] **Step 4 — run, expect PASS. Commit:** `feat(kernel): fillRoutingHints producer (opt-in, fill-not-override)`

### Task 4 — orchestrator integration

**Files:** Modify `packages/kernel/src/orchestrator.ts`; new orchestrator integration test

- [ ] **Step 1 — failing integration tests** (orchestrator test harness): with `outcomeRouting.enabled=false` (default) a run's `unit_snapshot.routingHints` is identical to today (no-op). With `enabled=true`, seeded `run_outcomes` favoring `codex` (≥minSamples) and ε=0, an unhinted run's **persisted** `unit_snapshot` shows `preferredWorker === "codex"` AND the executed route is codex (**recorded==actual**). An explicit `preferredWorker` is preserved.

- [ ] **Step 2 — run, expect FAIL.**

- [ ] **Step 3 — implement** per VF-2/VF-3: thread `outcomeRouting: OutcomeRoutingConfig` (default `defaultOutcomeRoutingConfig`) through orchestrator construction; in `prepareRun`, before `storage.createRun` (:689):

```ts
const routedPacket = fillRoutingHints(
	validatedPacket, storage, outcomeRouting, Date.now(), seededRunValue,
);
const run = storage.createRun(routedPacket, createRunOptions);
// use routedPacket (not validatedPacket) for ctx/downstream so execution reads the filled hint
```

`seededRunValue` = a stable integer from the pending run/unit id (VF-3). Per VF-4, do **not** add the producer to the `:1080/:1101` createRun sites unless they are fresh-decision paths.

- [ ] **Step 4 — run, expect PASS. Commit:** `feat(kernel): score-driven routing producer in prepareRun (opt-in)`

### Task 5 — changeset + gate

- [ ] **Step 1 — changeset:** minor bump `@buildplane/kernel`, summary "S5: outcome aggregation + opt-in score-driven routing producer".
- [ ] **Step 2 — full gate:** `pnpm -C <worktree> exec vitest run` + `pnpm -C <worktree> lint`. Green.
- [ ] **Step 3 — commit** the changeset.

## Acceptance criteria

- Decay correct (one half-life ⇒ weight 0.5); below-min-sample workers never exploited; `seededUnitInterval` deterministic in [0,1).
- Directed exploration picks the least-sampled candidate; at zero data all candidates are reachable across seeds (cold start covered).
- Explicit `preferredWorker` never overridden; `chooseWorker → sdk/undefined` leaves the hint absent.
- **Default OFF ⇒ byte-for-byte unchanged routing** (no-op integration test passes).
- With the flag on: persisted `unit_snapshot` route == executed route (recorded==actual); no late mutation anywhere.
- Scoring math + invariants passed `/codex challenge`. Full suite + lint green; changeset added.
