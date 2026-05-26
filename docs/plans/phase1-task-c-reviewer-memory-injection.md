# Phase 1 · Task C — Reviewer-Side Memory Injection — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make auto-generated reviewer packets carry an `intent` (objective + `taskType:"review"`) so the reviewer leg of `implement-then-review` strategies gets memory-enriched and its injected memories persisted — closing the gap where reviewers run context-blind.

**Architecture:** The strategy run path already enriches *every* child via `prepareStrategyMemoryEnrichment` and already persists `injectedMemoriesByUnitId` for all units (including `<id>-reviewer`) via `persistInjectedMemoriesForTargets`. The ONLY blocker is that `buildModelReviewer` / `buildCommandReviewer` produce reviewer packets without an `intent`, so `preparePacketMemoryEnrichment` early-exits (`packet-enrichment.ts:421`). Fix = attach `intent` in `strategy-wrapper.ts`. No new wiring, no port change.

**Tech Stack:** TypeScript (ESM), vitest, `apps/cli/src/strategy-wrapper.ts`, `apps/cli/src/packet-enrichment.ts`.

---

## Opus Planning Reference (handoff contract)

- **Slice ID:** `phase1-task-C-reviewer-memory-injection`
- **Phase:** 1 (V1 gap closure) — parallel lane C of A/B/C
- **Branch base:** cut from `origin/main` (hard invariant). Verified tip: `29b47fc`.
- **Frozen contract excerpt (authority: `docs/plans/phase1-memory-port-contract.md`):**
  - `strategy-wrapper.ts` `buildModelReviewer` (`:51`) / `buildCommandReviewer` (`:77`) build reviewer packets that currently OMIT `intent`. Give the reviewer packet an `intent` (objective = `review <unit>`, `taskType:"review"`) so `preparePacketMemoryEnrichment` no longer early-exits.
  - Reviewer-packet enrichment then runs through the EXISTING `prepareStrategyMemoryEnrichment` → `enrichPacketWithMemories` path with `taskType:"review"`, and its injected-memory records are persisted by the EXISTING `persistInjectedMemoriesForTargets` (`run-cli.ts:5123`). **This is a real construction change, NOT free wiring (ADR 0001).**
- **Verified facts that bound this slice (origin/main):**
  - `prepareStrategyMemoryEnrichment` (`packet-enrichment.ts:546`) maps over `strategy.children` and enriches each child packet; returns `injectedMemoriesByUnitId` keyed by `child.packet.unit.id`.
  - The `run` strategy path (`run-cli.ts:5089-5127`) calls it, collects `strategyTargets` for every child unit id (incl. `<id>-reviewer`), and persists via `persistInjectedMemoriesForTargets`. **So persistence is already wired** once the reviewer packet carries an enrichable `intent`.
  - `collectStructuredMemoryEnrichment` (`packet-enrichment.ts:281`) drives `retrieveProcedures({ taskType })` off `intent.taskType` and `retrieveRepoFacts` off `intent.objective` keywords. `taskType:"review"` therefore pulls review-typed procedures.
  - **Existing test to update:** `strategy-wrapper.test.ts` asserts `expect(rev.packet.intent).toBeUndefined();` — this MUST flip to assert the reviewer intent.
- **Off-limits:** any port signature; `packet-enrichment.ts` enrichment/early-exit logic (do not change the `!p.intent` guard — we are *satisfying* it, not removing it); `promoteMemoryFromReceipt`; the dual-injection dedup (Phase 2). Do not change implementer-packet construction.
- **Merge eligibility:** narrow + green → `buildplane:auto-merge`. Touches reviewer construction only (not an admission/trust surface, not the shared port) → auto-merge-eligible. If the change drifts into `packet-enrichment.ts` logic, flip to manual Opus review.
- **Verify command:** `pnpm --filter buildplane test test/strategy-wrapper.test.ts test/packet-enrichment.test.ts`

## Verify-first (do this BEFORE writing implementation)

- [ ] **VF-1: Confirm the early-exit is the sole blocker.** Read `packet-enrichment.ts:420-423`: `const p = packet as PacketWithIntent; if (!p.intent) { return { packet, injectedMemories: [] }; }`. Confirm reviewer packets from `strategy-wrapper.ts` have no `intent` field today → they hit this early-exit. Confirm `prepareStrategyMemoryEnrichment` (`:546`) already iterates `strategy.children` (implementer AND reviewer). Conclusion: attaching `intent` to the reviewer packet is sufficient for enrichment; no run-loop change needed.
- [ ] **VF-2: Confirm persistence is already wired.** Read `run-cli.ts:5089-5127`. Confirm `strategyTargets` includes every child unit id and `persistInjectedMemoriesForTargets(structuredMemoryPort, strategyTargets, preparedStrategy.injectedMemoriesByUnitId, ...)` persists by unit id. Conclusion: the reviewer's injected memories will persist to the reviewer's run id automatically once enrichment produces them.

---

## File Structure

- `apps/cli/src/strategy-wrapper.ts` — **modify:** add `intent` to both reviewer builders (`buildModelReviewer` and both return branches of `buildCommandReviewer`).
- `apps/cli/test/strategy-wrapper.test.ts` — **modify:** flip the `intent` assertion; assert objective + `taskType:"review"` for model and command reviewers.
- `apps/cli/test/packet-enrichment.test.ts` — **modify:** add an enrichment test proving the reviewer child gets memories + `injectedMemoriesByUnitId` keyed by `<id>-reviewer`.

---

### Task C1: Attach `intent` to the model reviewer packet

**Files:**
- Modify: `apps/cli/src/strategy-wrapper.ts`
- Test: `apps/cli/test/strategy-wrapper.test.ts`

- [ ] **Step 1: Update the failing assertion + add new ones** in `strategy-wrapper.test.ts`

In the `"wraps a model packet with a model reviewer"` test, REPLACE the line:

```ts
		expect(rev.packet.intent).toBeUndefined();
```

with:

```ts
		expect(rev.packet.intent?.taskType).toBe("review");
		expect(rev.packet.intent?.objective).toContain("Write a hello world script");
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter buildplane test test/strategy-wrapper.test.ts`
Expected: FAIL — `rev.packet.intent` is `undefined`, so `.taskType` is `undefined`.

- [ ] **Step 3: Write minimal implementation** in `strategy-wrapper.ts` `buildModelReviewer`

The function already computes `const objective = packet.intent?.objective ?? "complete the assigned task";`. Add an `intent` field to the returned object (alongside `model`, `verification`, `routingHints`):

```ts
		intent: {
			objective: `Review whether the implementer satisfied: ${objective}`,
			taskType: "review",
		},
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter buildplane test test/strategy-wrapper.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/strategy-wrapper.ts apps/cli/test/strategy-wrapper.test.ts
git commit -m "feat(strategy): give model reviewer packets a review intent"
```

### Task C2: Attach `intent` to the command reviewer packet (both branches)

**Files:**
- Modify: `apps/cli/src/strategy-wrapper.ts`
- Test: `apps/cli/test/strategy-wrapper.test.ts`

- [ ] **Step 1: Add failing assertions** to `strategy-wrapper.test.ts`

In the `"wraps a command packet with a file-check reviewer"` test, add:

```ts
		expect(rev.packet.intent?.taskType).toBe("review");
		expect(rev.packet.intent?.objective).toContain("cmd-1");
```

And in the `"uses 'true' command when no expected outputs"` test, add:

```ts
		expect(rev.packet.intent?.taskType).toBe("review");
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter buildplane test test/strategy-wrapper.test.ts`
Expected: FAIL — command reviewer packets have no `intent`.

- [ ] **Step 3: Write minimal implementation** in `buildCommandReviewer`

Command packets may have no `intent.objective`, so derive a stable objective from the unit id. Compute once at the top of the function:

```ts
	const objective =
		packet.intent?.objective ?? `complete the unit ${packet.unit.id}`;
```

Then add this `intent` field to BOTH returned objects (the `outputs.length === 0` branch and the `checks` branch):

```ts
		intent: {
			objective: `Review whether the implementer satisfied: ${objective}`,
			taskType: "review",
		},
```

(The objective for the command case mentions the unit id via the fallback, satisfying the `toContain("cmd-1")` assertion.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter buildplane test test/strategy-wrapper.test.ts`
Expected: PASS (all `wrapAsStrategy` tests green, including the routing-hints and template tests).

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/strategy-wrapper.ts apps/cli/test/strategy-wrapper.test.ts
git commit -m "feat(strategy): give command reviewer packets a review intent"
```

### Task C3: Prove the reviewer child now enriches + persists by unit id

**Files:**
- Modify: `apps/cli/test/packet-enrichment.test.ts`

- [ ] **Step 1a: Extend the imports** at the TOP of `apps/cli/test/packet-enrichment.test.ts`.

The file currently imports only `enrichPacketWithMemories`. Change the existing import line and add the strategy-wrapper import:

```ts
import {
	enrichPacketWithMemories,
	prepareStrategyMemoryEnrichment,
} from "../src/packet-enrichment.js";
import { wrapAsStrategy } from "../src/strategy-wrapper.js";
```

- [ ] **Step 1b: Write the failing test** (append to `packet-enrichment.test.ts`).

Reuse the existing in-file helpers `createStructuredMemoryPort` (`:140`) and `createProcedureResult` (`:63`) — do NOT hand-roll a fake port. The real result shape is `RankedProcedureResult = RankedMemoryResult<ProcedureMemory>` = `{ item, reason, matchClass, confidence, updatedAt }` (`memory-retrieval.ts:50-60`), which `createProcedureResult` already produces. `createStructuredMemoryPort` fills `retrieveRepoFacts` / `retrieveProcedures` / `retrieveSearchableDocuments` defaults and is structurally typed, so it is passed with NO cast:

```ts
describe("reviewer-side memory injection (Task C)", () => {
	const implementerPacket = {
		unit: {
			id: "task-x",
			kind: "model",
			scope: "task",
			inputRefs: [],
			expectedOutputs: ["out/result.js"],
			verificationContract: "exit-0-and-required-outputs",
			policyProfile: "default",
		},
		model: { provider: "anthropic", model: "claude-sonnet-4-20250514" },
		verification: { requiredOutputs: ["out/result.js"] },
		intent: {
			objective: "Write a parser",
			taskType: "implement",
			context: { files: [] },
		},
	};

	it("enriches the reviewer child and keys injected memories by <id>-reviewer", async () => {
		// Returns a procedure ONLY for the review leg, proving the reviewer
		// packet now reaches enrichment (taskType:"review").
		const structuredMemoryPort = createStructuredMemoryPort({
			retrieveProcedures: (q: { taskType?: string }) =>
				q.taskType === "review"
					? [createProcedureResult({ name: "How to review", reason: "exact-task-type" })]
					: [],
		});

		const strategy = wrapAsStrategy(implementerPacket);
		const prepared = await prepareStrategyMemoryEnrichment(
			strategy as unknown as Record<string, unknown>,
			undefined,
			undefined,
			undefined,
			structuredMemoryPort,
			undefined,
		);

		expect(
			Object.keys(prepared.injectedMemoriesByUnitId),
		).toContain("task-x-reviewer");
		expect(
			prepared.injectedMemoriesByUnitId["task-x-reviewer"].length,
		).toBeGreaterThan(0);
	});
});
```

- [ ] **Step 2: Run test to verify it passes** (Task C1/C2 already added the intent; this test confirms the end-to-end enrichment)

Run: `pnpm --filter buildplane test test/packet-enrichment.test.ts`
Expected: PASS. If it FAILS with an empty `injectedMemoriesByUnitId`, re-check that the reviewer packet's `intent.taskType` is exactly `"review"` and that you reused `createProcedureResult` (the correct `RankedProcedureResult` shape is `{ item, reason, matchClass, confidence, updatedAt }` — NOT `{ score, matchReasons, result }`).

- [ ] **Step 3: Full suite + typecheck**

Run: `pnpm --filter buildplane exec tsc --build && pnpm --filter buildplane test`
Expected: typecheck clean; full suite green (confirms no other test relied on reviewers lacking `intent`).

- [ ] **Step 4: Commit**

```bash
git add apps/cli/test/packet-enrichment.test.ts
git commit -m "test(memory): reviewer child enriches + persists by <id>-reviewer"
```

---

## Acceptance Criteria

1. `buildModelReviewer` and both branches of `buildCommandReviewer` produce reviewer packets with `intent.taskType === "review"` and an objective referencing the implementer's goal/unit.
2. The pre-existing `strategy-wrapper.test.ts` assertion that reviewer `intent` is `undefined` is flipped; all `wrapAsStrategy` tests pass.
3. `prepareStrategyMemoryEnrichment` on a `wrapAsStrategy(...)` strategy yields `injectedMemoriesByUnitId["<id>-reviewer"]` with ≥1 record when the structured port has a review-typed procedure (proves enrichment reaches the reviewer leg).
4. No change to `packet-enrichment.ts` enrichment/early-exit logic, no run-loop change, no port signature change.
5. `pnpm --filter buildplane exec tsc --build` clean and `pnpm --filter buildplane test` green.

**One-line verify:** `pnpm --filter buildplane test test/strategy-wrapper.test.ts test/packet-enrichment.test.ts`

## Self-Review notes

- Spec coverage: contract's Task-C construction change (reviewer carries intent) + persistence-already-wired verification (VF-2) are covered. The "real construction change, not free wiring" framing holds: the edit is to reviewer *construction* in `strategy-wrapper.ts`.
- Type consistency: reviewer `intent` shape (`{ objective, taskType:"review" }`) matches `TaskIntentLike` (`packet-enrichment.ts:53`) and `PacketLike.intent` (`strategy-wrapper.ts:28`). The test reuses the in-file `createStructuredMemoryPort` + `createProcedureResult` helpers, so `retrieveProcedures` returns the correct `RankedProcedureResult` shape (`{ item, reason, matchClass, confidence, updatedAt }`) with no cast.
- Placeholder scan: no TODOs; the one risk (existing tests asserting reviewer has no intent) is explicitly handled by the C1/C2 assertion flips and the full-suite gate in C3.
