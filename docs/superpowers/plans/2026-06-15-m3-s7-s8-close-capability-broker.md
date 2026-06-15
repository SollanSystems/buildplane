# M3-S7 + M3-S8 — Close the Capability Broker Milestone — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the two remaining M3 critical-path slices — S7 (PlanForge **plan-level** default capability bundle from the admitted plan) and S8 (M3-GATE: end-to-end integration test + architecture doc + GATE receipt) — driving the capability-broker milestone to a complete, reviewed state.

**Architecture:** S3 already attaches a *per-task* `CapabilityBundleV0` at dispatch (least-privilege, one bundle per `UnitPacket`). S7 adds `buildDefaultCapabilityBundleForPlan(plan)` — the run-wide **capability envelope** = the deterministic (sorted) union of every task's `fsWrite` globs + `run_command` allowlist, `bundleId = plan.id`. This is the auditable "what can this admitted plan's workers touch in aggregate" view used by the GATE integration test and the M6 demo narrative; per-task bundles stay the enforced grain at dispatch. S8 proves the envelope confines real filesystem writes through the actual `@buildplane/adapters-tools` `writeFile` path (broker-before-sandbox, S4/S6), writes the architecture doc, and closes the milestone with a GATE receipt that restates the memory-program freeze.

**Tech Stack:** TypeScript (pnpm monorepo, vitest 4.x), `@buildplane/planforge`, `@buildplane/capability-broker`, `@buildplane/adapters-tools`. No Rust/L0 changes (the `capability_denied` tape kind already landed in S5).

**Worktree:** `.worktrees/m3-s7-planforge-default-bundle` (branch `feat/m3-s7-planforge-default-bundle`, cut from `origin/main` @ `4da9888`). Verify command: `pnpm -C <worktree> exec vitest run <paths>`.

**Why "matching M6 demo constraints" ≠ literal `src/`+`test/`:** the v0.5 §7 demo uses `src/`+`test/`+`npm` as an *illustration*. The toy `goal-input.md` plan is doc-oriented — its tasks declare `local-doc`/`local-fixture`/`local-receipt` side effects (there is no `code-edit` side-effect kind in `PLANFORGE_ALLOWED_SIDE_EFFECTS`). So S7's enforceability story is realized on the real fixture: the derived envelope is `fsWrite: [docs/**, fixtures…, docs/operations/**]` + `allowlist: [git, pnpm]`, and the test proves fail-closed confinement to exactly that surface. Extending the side-effect vocabulary to `code-edit`→`src/**`/`test/**` (which would also unblock real `planforge admit` dogfooding) is a tracked follow-up, **not** this slice.

---

## File Structure

- `packages/planforge/src/bundle.ts` — **modify**: add `buildDefaultCapabilityBundleForPlan(plan)`; reuse the existing `buildDefaultCapabilityBundleForTask` per-task mapping so the plan envelope is provably the union of task envelopes (DRY — no second copy of the side-effect→glob map).
- `packages/planforge/src/index.ts` — **modify**: export the new function.
- `packages/planforge/test/bundle.test.ts` — **modify**: add plan-level envelope shape + digest-determinism + broker-validate + broker-enforceability tests.
- `.changeset/m3-s7-planforge-plan-bundle.md` — **create**: minor (`packages/planforge` public surface changes).
- `docs/operations/2026-06-15-m3-s7-plan-bundle-slice-receipt.md` — **create**: S7 receipt.
- `test/workflow/capability-broker-m3-gate.test.ts` — **create**: S8 end-to-end allow/deny integration through `adapters-tools` `writeFile`.
- `docs/architecture/capability-broker.md` — **create**: S8 architecture doc.
- `docs/operations/2026-06-15-m3-gate-receipt.md` — **create**: M3-GATE receipt (restates memory freeze).
- `CLAUDE.md` — **modify** (S8): milestone map → M3 ✅; record S1–S8 archive + the side-effect-vocabulary follow-up.

---

## Task 1 (S7): plan-level capability-bundle envelope

**Files:**
- Modify: `packages/planforge/src/bundle.ts`
- Modify: `packages/planforge/src/index.ts`
- Test: `packages/planforge/test/bundle.test.ts`

- [ ] **Step 1: Write the failing tests** — append to `packages/planforge/test/bundle.test.ts`. Add the import of the new function to the existing top-of-file import from `../src/bundle.ts`, add broker imports, and append a new `describe` block:

```ts
// add to existing imports
import {
	bundleDigest,
	evaluateToolInvocation,
	validateCapabilityBundle,
} from "@buildplane/capability-broker";
import {
	buildDefaultCapabilityBundleForPlan,
	buildDefaultCapabilityBundleForTask,
	capabilityBundleDigest,
} from "../src/bundle.ts";

describe("buildDefaultCapabilityBundleForPlan", () => {
	it("derives the run-wide envelope as the sorted union of every task's capabilities", () => {
		const plan = createPlanForgeDryRunPlan(inputFixture);
		const bundle = buildDefaultCapabilityBundleForPlan(plan);

		expect(bundle.schemaVersion).toBe("buildplane.capability_bundle.v0");
		expect(bundle.bundleId).toBe(plan.id);
		// toy plan: PF1 {local-doc, local-fixture}, PF2 {local-doc, local-fixture, local-receipt}
		expect(bundle.fsWrite).toEqual([
			"apps/cli/test/fixtures/**",
			"docs/**",
			"docs/operations/**",
			"packages/**/test/fixtures/**",
		]);
		expect(bundle.tools?.write_file?.enabled).toBe(true);
		expect(bundle.tools?.run_command?.allowlist).toEqual(["git", "pnpm"]);
	});

	it("envelope is exactly the union of the per-task bundles (no extra, no missing)", () => {
		const plan = createPlanForgeDryRunPlan(inputFixture);
		const envelope = buildDefaultCapabilityBundleForPlan(plan);

		const unionWrite = new Set<string>();
		const unionAllow = new Set<string>();
		for (const task of plan.tasks) {
			const t = buildDefaultCapabilityBundleForTask(plan, task);
			for (const g of t.fsWrite ?? []) unionWrite.add(g);
			for (const c of t.tools?.run_command?.allowlist ?? []) unionAllow.add(c);
		}
		expect(new Set(envelope.fsWrite)).toEqual(unionWrite);
		expect(new Set(envelope.tools?.run_command?.allowlist)).toEqual(unionAllow);
	});

	it("is deterministic and broker-valid, and its digest agrees with the broker", () => {
		const plan = createPlanForgeDryRunPlan(inputFixture);
		const a = buildDefaultCapabilityBundleForPlan(plan);
		const b = buildDefaultCapabilityBundleForPlan(plan);
		expect(capabilityBundleDigest(a)).toBe(capabilityBundleDigest(b));
		expect(capabilityBundleDigest(a)).toBe(bundleDigest(a));

		const validated = validateCapabilityBundle(a);
		expect(validated.ok).toBe(true);
	});

	it("fail-closed-confines a worker to exactly the plan's declared surface (M6 enforceability)", () => {
		const plan = createPlanForgeDryRunPlan(inputFixture);
		const validated = validateCapabilityBundle(
			buildDefaultCapabilityBundleForPlan(plan),
		);
		if (!validated.ok) throw new Error(validated.errors.join("; "));
		const ctx = { worktreeRoot: "/tmp/wt" };

		expect(
			evaluateToolInvocation(
				validated.bundle,
				{ tool: "write_file", path: "docs/note.md" },
				ctx,
			).decision,
		).toBe("allow");
		expect(
			evaluateToolInvocation(
				validated.bundle,
				{ tool: "write_file", path: "src/secret.ts" },
				ctx,
			).decision,
		).toBe("deny");
		expect(
			evaluateToolInvocation(
				validated.bundle,
				{ tool: "run_command", command: "git status --short" },
				ctx,
			).decision,
		).toBe("allow");
		expect(
			evaluateToolInvocation(
				validated.bundle,
				{ tool: "run_command", command: "curl http://evil.example" },
				ctx,
			).decision,
		).toBe("deny");
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm -C .worktrees/m3-s7-planforge-default-bundle exec vitest run packages/planforge/test/bundle.test.ts`
Expected: FAIL — `buildDefaultCapabilityBundleForPlan is not a function` / import error.

- [ ] **Step 3: Implement the builder** — add to `packages/planforge/src/bundle.ts` (after `buildDefaultCapabilityBundleForTask`):

```ts
/**
 * Run-wide capability envelope for an admitted plan (M3-S7): the deterministic
 * (sorted) union of every task's default bundle. `bundleId` is the plan id.
 * This is the auditable "what can this plan's workers touch in aggregate" view;
 * dispatch still attaches the tighter per-task bundle to each UnitPacket.
 */
export function buildDefaultCapabilityBundleForPlan(
	plan: PlanForgePlan,
): PlanForgeAttachedCapabilityBundle {
	const fsWrite = new Set<string>();
	const allowlist = new Set<string>();
	for (const task of plan.tasks) {
		const taskBundle = buildDefaultCapabilityBundleForTask(plan, task);
		for (const glob of taskBundle.fsWrite ?? []) {
			fsWrite.add(glob);
		}
		for (const entry of taskBundle.tools?.run_command?.allowlist ?? []) {
			allowlist.add(entry);
		}
	}
	const fsWriteSorted = [...fsWrite].sort();
	const allowlistSorted = [...allowlist].sort();
	return {
		schemaVersion: PLANFORGE_CAPABILITY_BUNDLE_SCHEMA_VERSION,
		bundleId: plan.id,
		...(fsWriteSorted.length > 0 ? { fsWrite: fsWriteSorted } : {}),
		tools: {
			write_file: { enabled: fsWriteSorted.length > 0 },
			...(allowlistSorted.length > 0
				? { run_command: { allowlist: allowlistSorted } }
				: {}),
		},
	};
}
```

Then export it from `packages/planforge/src/index.ts` — extend the existing `export { ... } from "./bundle.js";` block to include `buildDefaultCapabilityBundleForPlan`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm -C .worktrees/m3-s7-planforge-default-bundle exec vitest run packages/planforge/test/bundle.test.ts`
Expected: PASS (existing per-task test + 4 new envelope tests).

- [ ] **Step 5: Regression — planforge + capability-broker + kernel packet**

Run: `pnpm -C .worktrees/m3-s7-planforge-default-bundle exec vitest run packages/planforge packages/capability-broker packages/kernel/test/packet.test.ts`
Expected: PASS, no regressions.

- [ ] **Step 6: Changeset + commit**

Create `.changeset/m3-s7-planforge-plan-bundle.md`:

```md
---
"buildplane": minor
---

planforge: add `buildDefaultCapabilityBundleForPlan` — the run-wide capability envelope (sorted union of per-task bundles) derived from an admitted plan (M3-S7).
```

```bash
git -C .worktrees/m3-s7-planforge-default-bundle add packages/planforge .changeset/m3-s7-planforge-plan-bundle.md
git -C .worktrees/m3-s7-planforge-default-bundle commit -m "feat(planforge): derive run-wide capability bundle envelope from admitted plan (M3-S7)"
```

---

## Task 2 (S7): slice receipt

**Files:**
- Create: `docs/operations/2026-06-15-m3-s7-plan-bundle-slice-receipt.md`

- [ ] **Step 1: Write the receipt** following `docs/operations/slice-receipt-template.md` — scope, verification command(s) executed, acceptance (envelope = sorted union; deterministic broker-valid digest; fail-closed confinement proven via broker), the "M6 constraints = enforceability principle on the doc-oriented fixture" rationale, and the side-effect-vocabulary follow-up. Review tier: **L2** (2-role).

- [ ] **Step 2: Commit**

```bash
git -C .worktrees/m3-s7-planforge-default-bundle add docs/operations/2026-06-15-m3-s7-plan-bundle-slice-receipt.md
git -C .worktrees/m3-s7-planforge-default-bundle commit -m "docs(operations): M3-S7 plan-level capability bundle slice receipt"
```

> **CHECKPOINT — S7 review (L2):** request an independent reviewer + acceptance verifier (fresh context) before proceeding to S8. Reviewer verdict must be PASS with reviewed SHA = branch tip. Open a draft PR for S7; operator admin-merges (L1/L2 solo PR — no `buildplane:auto-merge`).

---

## Task 3 (S8): M3-GATE end-to-end integration test

**Files:**
- Create: `test/workflow/capability-broker-m3-gate.test.ts`

- [ ] **Step 1: Write the failing integration test** — proves the admitted toy plan's envelope confines real filesystem writes through `@buildplane/adapters-tools`:

```ts
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { validateCapabilityBundle } from "@buildplane/capability-broker";
import { writeFile } from "@buildplane/adapters-tools";
import {
	buildDefaultCapabilityBundleForPlan,
	createPlanForgeDryRunPlan,
} from "@buildplane/planforge";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const inputFixture = join(
	dirname(fileURLToPath(import.meta.url)),
	"../../apps/cli/test/fixtures/planforge/goal-input.md",
);

describe("capability broker M3 gate", () => {
	let worktreeRoot: string;
	beforeEach(() => {
		worktreeRoot = mkdtempSync(join(tmpdir(), "bp-m3-gate-"));
	});
	afterEach(() => {
		rmSync(worktreeRoot, { recursive: true, force: true });
	});

	function envelope() {
		const plan = createPlanForgeDryRunPlan(inputFixture);
		const validated = validateCapabilityBundle(
			buildDefaultCapabilityBundleForPlan(plan),
		);
		if (!validated.ok) throw new Error(validated.errors.join("; "));
		return validated.bundle;
	}

	it("allows an in-scope write declared by the admitted plan", () => {
		const result = writeFile(
			{ path: "docs/generated-note.md", content: "hello" },
			worktreeRoot,
			{ capabilityBundle: envelope() },
		);
		expect(result.success).toBe(true);
		expect(existsSync(join(worktreeRoot, "docs/generated-note.md"))).toBe(true);
	});

	it("denies an out-of-scope write, leaves no file, and fires the quarantine hook", () => {
		const denied: Array<{ tool: string; reason: string; target: string }> = [];
		const result = writeFile(
			{ path: "src/secret.ts", content: "exfil" },
			worktreeRoot,
			{
				capabilityBundle: envelope(),
				onCapabilityDenied: (d) => denied.push(d),
			},
		);
		expect(result.success).toBe(false);
		expect(result.error).toContain("capability broker");
		expect(existsSync(join(worktreeRoot, "src/secret.ts"))).toBe(false);
		expect(denied).toHaveLength(1);
		expect(denied[0]).toMatchObject({ tool: "write_file", target: "src/secret.ts" });
	});
});
```

- [ ] **Step 2: Run to verify it fails first (RED)**

Run: `pnpm -C .worktrees/m3-s7-planforge-default-bundle exec vitest run test/workflow/capability-broker-m3-gate.test.ts`
Expected: initially FAIL only if an import/path is wrong; once S7 is implemented + exported the assertions are the real gate. If it passes immediately, confirm by temporarily asserting a wrong decision to see RED, then revert. (The S4/S6 `writeFile` enforcement already exists, so this is an integration check, not new production code.)

- [ ] **Step 3: Make it pass** — no new production code expected (S7 builder + existing S4/S6 enforcement). Fix only import/path issues surfaced by Step 2.

- [ ] **Step 4: Run to verify PASS**

Run: `pnpm -C .worktrees/m3-s7-planforge-default-bundle exec vitest run test/workflow/capability-broker-m3-gate.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git -C .worktrees/m3-s7-planforge-default-bundle add test/workflow/capability-broker-m3-gate.test.ts
git -C .worktrees/m3-s7-planforge-default-bundle commit -m "test(workflow): M3-GATE capability broker allow/deny integration (M3-S8)"
```

---

## Task 4 (S8): architecture doc

**Files:**
- Create: `docs/architecture/capability-broker.md`

- [ ] **Step 1: Write the doc** — cover: the bundle schema v0 (`buildplane.capability_bundle.v0`); digest discipline (shared `@buildplane/planforge` canonical digest, no forked algorithm); `evaluateToolInvocation` semantics (fail-closed; glob `fsWrite`; `run_command` argv0/prefix allowlist locked in S2); the attach path (per-task at dispatch = least privilege) vs the plan-level **envelope** (`buildDefaultCapabilityBundleForPlan`, audit/M6-demo view); `adapters-tools` enforcement (broker before sandbox resolution) + the `capability_denied` L0 tape quarantine event (S5/S6); and the M6 enforceability story incl. the documented doc-oriented-fixture interpretation + the side-effect-vocabulary follow-up. Link from §"Where things live". Reference, not narration.

- [ ] **Step 2: Commit**

```bash
git -C .worktrees/m3-s7-planforge-default-bundle add docs/architecture/capability-broker.md
git -C .worktrees/m3-s7-planforge-default-bundle commit -m "docs(architecture): capability broker design (M3-S8)"
```

---

## Task 5 (S8): full gate verification + CLAUDE.md + GATE receipt

**Files:**
- Modify: `CLAUDE.md`
- Create: `docs/operations/2026-06-15-m3-gate-receipt.md`

- [ ] **Step 1: Run the full M3 gate** (per spec "Full M3 gate"). Route lint/`pnpm check` through a fresh subagent (biome OOM trap). Build native first for the full suite:

```bash
pnpm -C .worktrees/m3-s7-planforge-default-bundle native:build
pnpm -C .worktrees/m3-s7-planforge-default-bundle typecheck
pnpm -C .worktrees/m3-s7-planforge-default-bundle exec vitest run
cargo test --manifest-path .worktrees/m3-s7-planforge-default-bundle/native/Cargo.toml
pnpm -C .worktrees/m3-s7-planforge-default-bundle build
git -C .worktrees/m3-s7-planforge-default-bundle diff --exit-code packages/ledger-client/src/generated packages/ledger-client/fixtures
```
Expected: all green; ledger fixtures unchanged (no Rust payload change this milestone).

- [ ] **Step 2: Update `CLAUDE.md`** — milestone map M3 → ✅ complete; add an "M3 slice archive (complete): S1–S8 + M3-GATE" line pointing at the GATE receipt; record the side-effect-vocabulary follow-up (unblocks real `planforge admit` dogfooding) under open forks; note S2 receipt backfilled (Task 6) if done.

- [ ] **Step 3: Write the M3-GATE receipt** — `docs/operations/2026-06-15-m3-gate-receipt.md`: slice ledger S1–S8 (with PR/commit refs), the full-gate command results, the allow/deny integration evidence, the **memory-program freeze restated** (outcome routing OFF, unchanged), deferred items (S3b full Ed25519 byte-verify at gate; `net_egress` enforcement; side-effect vocabulary `code-edit`), and the review ceremony record.

- [ ] **Step 4: Commit**

```bash
git -C .worktrees/m3-s7-planforge-default-bundle add CLAUDE.md docs/operations/2026-06-15-m3-gate-receipt.md
git -C .worktrees/m3-s7-planforge-default-bundle commit -m "docs(operations): M3-GATE receipt + close capability broker milestone (M3-S8)"
```

> **CHECKPOINT — S8 review (L1/L2 + adversarial Codex on the gate test):** independent Opus reviewer + adversarial Codex pass over the gate test and the milestone-close docs; acceptance verifier against the M3 spec's S7/S8 criteria. Open a draft PR; operator admin-merges.

---

## Task 6 (optional cleanup): backfill the missing M3-S2 receipt

**Files:**
- Create: `docs/operations/2026-06-10-m3-s2-evaluate-tool-invocation-slice-receipt.md`

- [ ] **Step 1:** S2 (`evaluateToolInvocation`, PR #186) merged without a slice receipt. Backfill one from the template documenting the locked allow/deny semantics (argv0 + space-prefix match; `minimatch` `fsWrite` globs; fail-closed defaults). Commit `docs(operations): backfill M3-S2 evaluateToolInvocation slice receipt`.

(Skip if the operator prefers to leave the historical gap; note the decision in the GATE receipt either way.)

---

## Self-Review (against the M3 spec)

- **S7 acceptance** "Toy `goal-input.md` plan produces bundle matching M6 demo constraints (documented in test)" → Task 1 Step 1 tests 1+4 (envelope shape + fail-closed enforceability) with the documented doc-oriented-fixture interpretation. ✅
- **S7 verification** `vitest run packages/planforge/test/bundle.test.ts` → Task 1 Step 4. ✅
- **S8 acceptance** "Integration test proves deny path + allow path; CI verify green" → Task 3 (allow + deny + no-file + hook) and Task 5 full gate. ✅
- **S8 files** gate test + `docs/architecture/capability-broker.md` + `docs/operations/2026-06-10-m3-gate-receipt.md` → Tasks 3/4/5 (receipt dated 2026-06-15 — actual close date — not the spec's placeholder date). ✅
- **Memory freeze restated in GATE** → Task 5 Step 3. ✅
- **Review tiers** S7 L2, S8 L1/L2 + Codex on gate test → checkpoints after Task 2 and Task 5. ✅
- **No L0 change** (no new tape kind; `capability_denied` landed S5) → no Rust touch, ledger-fixture diff asserted clean (Task 5 Step 1). ✅
- **Changeset** only for `packages/planforge` (S7); S8 is docs + root test → no changeset. ✅
