# Phase 2 · S5 — Outcome Aggregation + routingHints Producer — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development (or executing-plans). Steps use `- [ ]` checkboxes.

**Goal:** Close the outcome-memory loop. Aggregate `run_outcomes` rows (read-time recency decay) and add a **producer** that fills `routingHints.preferredWorker` from those scores — inside `prepareRun` **before `storage.createRun` (`orchestrator.ts:689`)** so the recorded `unit_snapshot` route equals the executed route. Fill-not-override, directed ε-exploration, min-sample eligibility. **Opt-in, default OFF.**

**Architecture:** A pure, dependency-free scoring module (`outcome-scoring.ts`) does all the math (decay + eligibility + choose). A thin `fillRoutingHints` adapter reads `listRunOutcomes`, calls the module, and returns either the unchanged packet or a packet with one filled hint. The orchestrator calls it once, gated by a config flag; disabled ⇒ never called ⇒ zero behavior change.

**Tech Stack:** TypeScript (ESM, `.js`), Node ≥24.13, vitest, `@buildplane/kernel`, `@buildplane/storage`.

> **✅ Redesigned 2026-05-28** per `docs/superpowers/specs/2026-05-28-track2-outcome-memory-redesign-design.md` (operator-approved). **Supersedes** the mis-placed producer hook (`:1133`) and the accumulator dependency that Codex gate **R2** marked not-dispatch-ready. Hook moved before `createRun` (`:689`); steering is **opt-in, default OFF**. **R3+R4 fixes folded in:** producer is **model-packets only** (`packet.model !== undefined` — R4 corrected the predicate from `execution===undefined`); cold start is a **seed-free least-sampled rotation keyed on RAW (undecayed) sample count** so it converges (R4); ε defaults to **0** until a per-run seed is threaded (R4). **Pending R5 `/codex challenge` before dispatch.**

## Opus Planning Reference (handoff contract)

- **Slice ID:** `phase2-s5-outcome-aggregation-routing-producer`
- **Phase:** 2 · Track 2 — **serial, AFTER S4.** Cut worktree from `origin/main` after S4 merges; re-verify tip.
- **Authority:** the redesign spec (above) + `docs/plans/phase2-memory-contract.md` (Track 2, amended 2026-05-28).
- **Aggregation:** per `(repoId, taskType, worker)` from `run_outcomes`; exponential recency decay `w = 2 ** (-ageMs / halfLifeMs)` feeds the exploit `rate`; **`rawSamples` (undecayed count) gates cold-start coverage** (`rawSamples ≥ minSamples` ⇒ covered) so coverage converges. Pure module; `now` injected.
- **Producer hook:** inside `prepareRun`, after `validatePacketForWorkspaceRoot`, **before** `storage.createRun` (`orchestrator.ts:689`). **Model packets only** (`packet.model !== undefined`). Fill `preferredWorker` **only if absent**: if any candidate is under `minSamples` by **raw count** → least-sampled (seed-free cold-start coverage); else exploit best decayed `rate`; optional ε steady-state with a per-run seed (V1: ε=0); `sdk` ⇒ leave absent. Construct one `routedPacket`, use it for `createRun` **and** downstream ⇒ recorded==actual. **No late mutation** (not `runtimeRouter`, not orchestrator :1136, not run-cli :1359).
- **Worker↔hint mapping:** `worker ∈ {sdk,claude-code,codex}`; `preferredWorker ∈ {claude-code,codex}`. `chooseWorker` returning `"sdk"` ⇒ leave the hint **absent** (default executor). Symmetric with S4's recorder (`absent ⇒ "sdk"`).
- **Invariants:** `repoId = projectRoot`. Recorded route == actual route. Never override an explicit `preferredWorker`. Model-packets only. Default OFF ⇒ routing unchanged.
- **Codex target (second gate):** the scoring math (decay, seed-free cold-start coverage, eligibility), the fill-not-override + route==record + model-packet invariants, and the cold-start convergence argument.
- **Off-limits:** the `routingHints` consumer branches (`run-cli.ts:1359/1366`, orchestrator `:1136`, eval/runner); `run_outcomes` DDL + recorder (S4); promotion logic; `memory-retrieval.ts` ranking.
- **Merge eligibility:** load-bearing routing change → **manual Opus review.**
- **Verify command:** `pnpm -C <worktree> exec vitest run packages/kernel/test`. **Then the gate:** full suite + `pnpm -C <worktree> lint` + changeset.

## Verify-first (BEFORE implementation)

- [ ] **VF-1:** Confirm S4 shipped: `listRunOutcomes`/`appendRunOutcome` exist; `run_outcomes` populated by the recorder. Confirm `RunOutcome.createdAt` parses with `Date.parse`.
- [ ] **VF-2:** Confirm the orchestrator's construction/dependency-injection seam — **where `createOrchestrator` (or equiv) receives deps/config** — and add `outcomeRouting` there. **Do not assume a global `config`.** Confirm `storage` is in scope inside `prepareRun`.
- [ ] **VF-3 (R3 P1 — seed timing):** The run id is minted inside `storage.createRun` (`store.ts:1937`), i.e. **after** scoring, so it cannot seed the explore decision at the hook. Cold-start rotation is **seed-free** (no seed needed). If optional ε steady-state exploration is kept, confirm a **per-run** value can be pre-minted/passed before `:689` (a per-*unit* value is forbidden — it froze the R3 coin). **Default for V1: omit ε (pass `exploreSeed` undefined); cold-start rotation alone guarantees coverage.** Confirm the packet passed to `createRun` is the same object used downstream (so the snapshot reflects the fill).
- [ ] **VF-4 (R3 P2 — corrected):** The non-`prepareRun` `createRun` sites are **profile-resolution failure (`orchestrator.ts:1063`)** and **approval suspension (`:1095`)** — NOT retry/child paths. They commit a run where **no model worker runs**, so the producer must **not** fire and the recorder appends **no** row. Re-confirm against the live source; record the classification. Only `prepareRun:689` gets the producer.
- [ ] **VF-5 (R4 P1 — model-packet scope):** The routing/recording gate is **`packet.model !== undefined`** (`UnitPacket` has both `execution?` and `model?`, run-loop.ts:30-39). Confirm `fillRoutingHints` is a no-op when `model` is unset (command packets, and any packet that would fall through to the SDK default at `run-cli.ts:1369`). Confirm `model`/`execution` are mutually exclusive on real packets.
- [ ] **VF-6:** Confirm an explicit incoming `routingHints.preferredWorker` flows through `prepareRun` unchanged when the flag is on (fill-not-override) and when off.

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
		expect(c.rawSamples).toBe(2);                   // undecayed count (cold-start coverage)
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
	readonly rawSamples: number;        // undecayed row count — drives cold-start coverage (R4)
}

export function aggregateOutcomeScores(
	rows: readonly RunOutcome[],
	opts: { halfLifeMs: number; now: number },
): Map<WorkerLabel, WorkerScore> {
	const acc = new Map<WorkerLabel, { s: number; n: number; raw: number }>();
	for (const r of rows) {
		const ageMs = opts.now - Date.parse(r.createdAt);
		const w = 2 ** (-Math.max(0, ageMs) / opts.halfLifeMs);
		const cur = acc.get(r.worker) ?? { s: 0, n: 0, raw: 0 };
		acc.set(r.worker, { s: cur.s + (r.success ? w : 0), n: cur.n + w, raw: cur.raw + 1 });
	}
	const out = new Map<WorkerLabel, WorkerScore>();
	for (const [worker, { s, n, raw }] of acc) {
		out.set(worker, { decayedSuccess: s, decayedSamples: n, rate: n > 0 ? s / n : 0, rawSamples: raw });
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

it("cold start: routes to the least-sampled candidate (seed-free, RAW count) until coverage", () => {
	// sdk + codex have raw samples, claude-code has none ⇒ claude-code is least-sampled
	const scores = new Map([
		["sdk", { decayedSuccess: 8, decayedSamples: 8, rate: 1, rawSamples: 8 }],
		["codex", { decayedSuccess: 2, decayedSamples: 2, rate: 1, rawSamples: 2 }],
	]);
	expect(chooseWorker(scores, { candidates: CANDS, minSamples: 5, epsilon: 0 })).toBe("claude-code");
});

it("at zero data, rotates by least-sampled (tie → candidate order)", () => {
	expect(chooseWorker(new Map(), { candidates: CANDS, minSamples: 5, epsilon: 0 })).toBe("sdk");
});

it("coverage uses RAW count, not decayed (a decayed-thin but raw-covered worker is not re-warmed)", () => {
	// claude-code: 6 raw rows but decayed to 1.2 by age — still covered (raw 6 ≥ 5)
	const scores = new Map([
		["sdk", { decayedSuccess: 9, decayedSamples: 10, rate: 0.9, rawSamples: 10 }],
		["claude-code", { decayedSuccess: 0.6, decayedSamples: 1.2, rate: 0.5, rawSamples: 6 }],
		["codex", { decayedSuccess: 5, decayedSamples: 10, rate: 0.5, rawSamples: 10 }],
	]);
	// all raw ≥ 5 ⇒ no cold start ⇒ exploit best rate ⇒ sdk
	expect(chooseWorker(scores, { candidates: CANDS, minSamples: 5, epsilon: 0 })).toBe("sdk");
});

it("exploits the highest-rate candidate once all candidates are covered", () => {
	const scores = new Map([
		["sdk", { decayedSuccess: 5, decayedSamples: 10, rate: 0.5, rawSamples: 10 }],
		["claude-code", { decayedSuccess: 6, decayedSamples: 10, rate: 0.6, rawSamples: 10 }],
		["codex", { decayedSuccess: 9, decayedSamples: 10, rate: 0.9, rawSamples: 10 }],
	]);
	expect(chooseWorker(scores, { candidates: CANDS, minSamples: 5, epsilon: 0 })).toBe("codex");
});

it("optional steady-state ε re-explores least-sampled when a per-run seed falls under ε", () => {
	const scores = new Map([        // all raw ≥ minSamples ⇒ past cold start
		["sdk", { decayedSuccess: 50, decayedSamples: 50, rate: 1, rawSamples: 50 }],
		["claude-code", { decayedSuccess: 6, decayedSamples: 6, rate: 1, rawSamples: 6 }],
		["codex", { decayedSuccess: 9, decayedSamples: 9, rate: 1, rawSamples: 9 }],
	]);
	const seed = explorerSeedUnder(0.2);   // helper: first int with seededUnitInterval < 0.2
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
		exploreSeed?: number;        // per-RUN seed; only consulted post-coverage
	},
): WorkerLabel | undefined {
	if (opts.candidates.length === 0) return undefined;
	const raw = (w: WorkerLabel) => scores.get(w)?.rawSamples ?? 0;
	// least-by-RAW-count candidate; `<=` makes ties resolve to the earlier candidate (deterministic)
	const leastSampled = () => opts.candidates.reduce((a, b) => (raw(a) <= raw(b) ? a : b));
	// 1. cold-start coverage (seed-free) on RAW counts — monotonic, so it converges (R4 P2);
	//    decayed samples could shrink back under minSamples and chase coverage forever.
	if (opts.candidates.some((w) => raw(w) < opts.minSamples)) return leastSampled();
	// 2. optional steady-state exploration — needs a per-RUN seed (never a per-unit one)
	if (opts.epsilon > 0 && opts.exploreSeed !== undefined &&
		seededUnitInterval(opts.exploreSeed) < opts.epsilon) return leastSampled();
	// 3. exploit: highest DECAYED rate (all candidates are covered here)
	return opts.candidates.reduce((best, w) =>
		((scores.get(w)?.rate ?? 0) > (scores.get(best)?.rate ?? 0) ? w : best));
}
```

Note: with cold-start rotation, `chooseWorker` only returns `undefined` for an empty candidate set;
the "leave the hint absent" decision happens in `fillRoutingHints` (`worker === "sdk"` ⇒ absent).

- [ ] **Step 4 — run, expect PASS. Commit:** `feat(kernel): chooseWorker (seed-free cold-start rotation + exploit)`

### Task 3 — fillRoutingHints adapter + config

**Files:** Create `packages/kernel/src/routing-producer.ts`; create `packages/kernel/test/routing-producer.test.ts`

- [ ] **Step 1 — failing tests:** flag OFF ⇒ packet returned unchanged (and `listRunOutcomes` never called); **non-model packet (`model` unset, e.g. a command packet) ⇒ returned unchanged even with flag ON** (R4 P1 — never route a non-model packet); explicit `preferredWorker` ⇒ never overridden (even with flag on); flag ON + model packet + hint absent + `chooseWorker` ⇒ `codex` ⇒ packet gains `routingHints.preferredWorker === "codex"`; `chooseWorker` ⇒ `sdk` ⇒ hint stays absent. Build packets with `intent.taskType` present and absent (fallback to `unit.kind`).

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
	epsilon: 0,                                        // V1: no per-run seed threaded ⇒ ε must be 0 (R4 P2)
	halfLifeMs: 14 * 24 * 60 * 60 * 1000,
	minSamples: 5,
	candidates: ["sdk", "claude-code", "codex"],
};

export function fillRoutingHints(
	packet: UnitPacket,
	storage: BuildplaneStoragePort,
	cfg: OutcomeRoutingConfig,
	now: number,
	exploreSeed?: number,                                        // per-RUN seed (optional ε)
): UnitPacket {
	if (!cfg.enabled) return packet;
	if (packet.model === undefined) return packet;               // model packets only (D5/R4; run-loop.ts:33)
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

- [ ] **Step 1 — failing integration tests** (orchestrator test harness): with `outcomeRouting.enabled=false` (default) a run's `unit_snapshot.routingHints` is identical to today (no-op) **and `listRunOutcomes` is never queried**. With `enabled=true` and seeded `run_outcomes` where every candidate is past `minSamples` and `codex` has the best rate, an unhinted **model** run's **persisted** `unit_snapshot` shows `preferredWorker === "codex"` AND the executed route is codex (**recorded==actual**). With every candidate under `minSamples`, the unhinted run routes to the least-sampled candidate (cold-start coverage). An explicit `preferredWorker` is preserved. A **command packet** (`execution` set) is never routed.

- [ ] **Step 2 — run, expect FAIL.**

- [ ] **Step 3 — implement** per VF-2/VF-3/VF-4: thread `outcomeRouting: OutcomeRoutingConfig` (default `defaultOutcomeRoutingConfig`) through orchestrator construction; in `prepareRun`, before `storage.createRun` (:689):

```ts
const routedPacket = fillRoutingHints(
	validatedPacket, storage, outcomeRouting, Date.now(), /* exploreSeed */ undefined,
);
const run = storage.createRun(routedPacket, createRunOptions);
// use routedPacket (not validatedPacket) for ctx/downstream so execution reads the filled hint
```

V1 passes `exploreSeed` undefined — cold-start rotation guarantees coverage without ε (VF-3). If ε is enabled later, pass a **per-run** seed (never per-unit). Per VF-4, do **not** add the producer to the `:1063`/`:1095` createRun sites (profile-resolution failure / approval suspension — no model worker runs).

- [ ] **Step 4 — run, expect PASS. Commit:** `feat(kernel): score-driven routing producer in prepareRun (opt-in)`

### Task 5 — changeset + gate

- [ ] **Step 1 — changeset:** minor bump `@buildplane/kernel`, summary "S5: outcome aggregation + opt-in score-driven routing producer".
- [ ] **Step 2 — full gate:** `pnpm -C <worktree> exec vitest run` + `pnpm -C <worktree> lint`. Green.
- [ ] **Step 3 — commit** the changeset.

## Acceptance criteria

- Decay correct (one half-life ⇒ weight 0.5); `seededUnitInterval` deterministic in [0,1).
- **Cold-start coverage is seed-free and keyed on RAW sample count** (monotonic ⇒ converges; decayed counts could chase coverage forever): an under-sampled grain routes to its least-sampled candidate until every candidate reaches `minSamples`, without RNG and without a per-unit-frozen coin. Post-coverage, the highest decayed-rate candidate is exploited.
- **Non-model packets are never routed** (`packet.model === undefined` ⇒ no-op, covers command packets); explicit `preferredWorker` never overridden; `chooseWorker → sdk` leaves the hint absent.
- **Default OFF ⇒ routing unchanged** (`fillRoutingHints` not called, `listRunOutcomes` not queried) — no-op integration test passes.
- With the flag on: persisted `unit_snapshot` route == executed route (recorded==actual); no late mutation anywhere.
- Scoring math + invariants passed `/codex challenge` (R4). Full suite + lint green; changeset added.
