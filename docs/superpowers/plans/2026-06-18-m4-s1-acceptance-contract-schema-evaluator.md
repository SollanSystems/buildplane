# M4-S1 — Acceptance contract schema + pure evaluator + digest lock

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Add `AcceptanceContractV0` type, `deriveAcceptanceContract(plan, task)`, `contractDigest`, and `evaluateAcceptanceContract(contract, evidence)` — the pure schema + evaluator foundation for M4. No tape writes, no kernel wiring, no gate insertion (S2/S3).

**Architecture:** Type split mirrors `ArchitectureDiffScopeGate`: the contract type lives in `packages/kernel` (so `TrustGateConfig` can reference it without a dependency cycle — kernel does not depend on policy), while the derive/evaluate/digest functions live in `packages/policy`. `packages/policy` gains `@buildplane/planforge` as a workspace dependency (for `buildDefaultCapabilityBundleForTask` + `digest`). The evaluator reuses `evaluateArchitectureDiffScope` from `./diff-scope.js` — no fork.

**Tech Stack:** TypeScript (pnpm workspace, ESM), Vitest, Biome. New dependency: `@buildplane/planforge` (in `packages/policy`).

**Spec:** `docs/superpowers/specs/2026-06-18-m4-acceptance-contract-design.md` (M4-S1 section, lines 135–140).

---

## Context the implementer must hold

- **L1 slice** — no tape writes, no ledger, no orchestrator wiring, no CLI changes.
- **Do not** implement the `acceptance_recorded` event (S2).
- **Do not** wire the finalization gate (S3).
- **Do not** populate `UnitPacket.acceptance_contract` (stays `unknown`/reserved).
- **Type placement resolves a spec ambiguity.** The spec says "Acceptance logic lives in `packages/policy`" (line 32) and "In `packages/policy`" for the schema (line 50). However, `TrustGateConfig` (which must reference `AcceptanceContractV0`) lives in `packages/kernel/src/policy.ts:56`, and `packages/policy` depends on `packages/kernel` (one-way — kernel does not depend on policy). A type defined in policy cannot be referenced by kernel without a cycle. The established precedent is `ArchitectureDiffScopeGate`: the **gate config type** lives in kernel (`policy.ts:37`), the **evaluator function** lives in policy (`diff-scope.ts:17`). This plan follows that exact split for `AcceptanceContractV0`.
- `deriveAcceptanceContract` calls `buildDefaultCapabilityBundleForTask(plan, task)` from `@buildplane/planforge` to get the `fsWrite` globs — this ensures the acceptance contract's `diff_scope` matches exactly what was enforced at dispatch time (M3). This is the trust-thesis point: declared surface ⊇ actual diff.
- `contractDigest` delegates to `digest` from `@buildplane/planforge` — same canonicalization as `planDigest`, `inputDigest`, and `capabilityBundleDigest`. The `sha256:` prefix is a content-address label, not part of the hashed input.
- `evaluateAcceptanceContract` reuses `evaluateArchitectureDiffScope` from `./diff-scope.js` — do not fork the glob-matching logic.
- `allowed_globs` is sorted in `deriveAcceptanceContract` for canonical ordering (digest stability — `canonicalJson` sorts object keys but not array elements).
- `denied_globs` is omitted in v0 (no source from the capability bundle; deferred to a later slice).

Read before coding:
- `packages/kernel/src/policy.ts` — `ArchitectureDiffScopeGate` (line 37), `TrustGateConfig` (line 56), `PolicyProfile` (line 46).
- `packages/kernel/src/run-loop.ts` — `RejectedPolicyDecision` (line 96).
- `packages/kernel/src/index.ts` — type export block (~line 125).
- `packages/policy/src/diff-scope.ts` — `evaluateArchitectureDiffScope` (line 17), `ArchitectureDiffScopeEvaluation` (line 6).
- `packages/policy/src/index.ts` — current exports.
- `packages/planforge/src/bundle.ts` — `buildDefaultCapabilityBundleForTask` (line 62), `PlanForgeAttachedCapabilityBundle` (line 8), `SIDE_EFFECT_FS_WRITE_GLOBS` (line 18).
- `packages/planforge/src/digest.ts` — `digest` (line 36), `canonicalJson` (line 30).
- `packages/planforge/src/schema.ts` — `PlanForgeTask` (line 111), `PlanForgePlan` (line 154).
- `packages/capability-broker/src/digest.ts` — M3 precedent for a thin `digest` wrapper.
- `docs/superpowers/specs/2026-06-18-m4-acceptance-contract-design.md` — schema (lines 48–61), evaluator (lines 63–82).

---

## File structure

| File | Action |
|---|---|
| `packages/kernel/src/policy.ts` | Modify — add `AcceptanceContractV0` interface + `trustGates.acceptanceContract?` to `TrustGateConfig` |
| `packages/kernel/src/run-loop.ts` | Modify — extend `RejectedPolicyDecision.kind` union with `"acceptance.contract"` |
| `packages/kernel/src/index.ts` | Modify — export `AcceptanceContractV0` type |
| `packages/policy/package.json` | Modify — add `"@buildplane/planforge": "workspace:*"` to dependencies |
| `packages/policy/src/acceptance.ts` | Create — `AcceptanceEvidence`, `AcceptanceVerdict` types + `deriveAcceptanceContract` + `evaluateAcceptanceContract` + `contractDigest` |
| `packages/policy/src/index.ts` | Modify — export new symbols from `./acceptance.js` |
| `packages/policy/test/acceptance.test.ts` | Create — TDD tests |
| `.changeset/m4-s1-acceptance-contract.md` | Create — minor for `@buildplane/policy` + `@buildplane/kernel` |

---

## Task 1: Kernel type extensions

**Objective:** Add `AcceptanceContractV0` to kernel, extend `TrustGateConfig` and `RejectedPolicyDecision`.

**Files:**
- Modify: `packages/kernel/src/policy.ts` (after `ArchitectureDiffScopeGate`, line 42; in `TrustGateConfig`, line 71)
- Modify: `packages/kernel/src/run-loop.ts:97`
- Modify: `packages/kernel/src/index.ts` (~line 125, type export block)

- [ ] **Step 1:** Add `AcceptanceContractV0` interface to `packages/kernel/src/policy.ts`, after the `ArchitectureDiffScopeGate` interface (line 42) and before the `Policy Profiles` section:

```ts
// ── Acceptance Contract (M4) ───────────────────────────────

/**
 * Per-task acceptance contract derived from the admitted plan.
 * The kernel evaluates this at finalization (Point A) before merge.
 * Deterministically derivable from `plan_admitted` + `capability_bundle`.
 */
export interface AcceptanceContractV0 {
	readonly contract_version: "v0";
	readonly diff_scope: {
		readonly allowed_globs: readonly string[];
		readonly denied_globs?: readonly string[];
	};
	readonly checks: readonly { readonly command: string }[];
}
```

- [ ] **Step 2:** Add `acceptanceContract` to `TrustGateConfig` in `packages/kernel/src/policy.ts`, after `architectureDiffScope` (line 71):

```ts
	/**
	 * Per-task acceptance contract evaluated at finalization (M4).
	 * When present, the kernel runs the contract's check commands in the
	 * worktree and rejects the run if the diff escapes scope or any check fails.
	 * Absent = opt-in (unconfigured = fail-open, no gate).
	 */
	readonly acceptanceContract?: AcceptanceContractV0;
```

- [ ] **Step 3:** Extend `RejectedPolicyDecision.kind` in `packages/kernel/src/run-loop.ts:97`:

```ts
export interface RejectedPolicyDecision {
	readonly kind: "reject-run" | "architecture.diff_scope" | "acceptance.contract";
	readonly outcome: "rejected";
	readonly reasons: readonly string[];
}
```

- [ ] **Step 4:** Add `AcceptanceContractV0` to the type export block in `packages/kernel/src/index.ts` (the `export type { ... } from "./policy.js"` block at ~line 125). Add it as the first entry (alphabetical):

```ts
export type {
	AcceptanceContractV0,
	ArchitectureDiffScopeGate,
	BudgetConstraints,
	CapabilityGrant,
	PolicyProfile,
	ResourceUsageSnapshot,
	RetryPolicy,
	TrustGateConfig,
} from "./policy.js";
```

- [ ] **Step 5:** Typecheck kernel:

```bash
pnpm exec tsc --build packages/kernel/tsconfig.json --pretty false
```

Expected: PASS (type-only change, no runtime code yet).

---

## Task 2: Add planforge dependency to policy + scaffold acceptance.ts types

**Objective:** Wire `@buildplane/planforge` into `packages/policy` and create the `acceptance.ts` module with type declarations only.

**Files:**
- Modify: `packages/policy/package.json`
- Create: `packages/policy/src/acceptance.ts`

- [ ] **Step 1:** Add `"@buildplane/planforge": "workspace:*"` to `packages/policy/package.json` dependencies:

```json
	"dependencies": {
		"@buildplane/kernel": "workspace:*",
		"@buildplane/planforge": "workspace:*"
	}
```

- [ ] **Step 2:** Run `pnpm install` at repo root to resolve the new workspace dependency.

- [ ] **Step 3:** Create `packages/policy/src/acceptance.ts` with type declarations only (no functions yet):

```ts
import type { AcceptanceContractV0 } from "@buildplane/kernel";

export interface AcceptanceEvidence {
	readonly changedFiles: readonly string[];
	readonly checkResults: readonly { readonly command: string; readonly exitCode: number }[];
}

export type AcceptanceVerdict =
	| { readonly outcome: "passed" }
	| {
			readonly outcome: "rejected";
			readonly diffScopeStatus: "passed" | "blocked";
			readonly outOfScopeFiles: readonly string[];
			readonly failedChecks: readonly { readonly command: string; readonly exitCode: number }[];
	  };
```

- [ ] **Step 4:** Typecheck policy:

```bash
pnpm exec tsc --build packages/policy/tsconfig.json --pretty false
```

Expected: PASS.

---

## Task 3: deriveAcceptanceContract + contractDigest (RED → GREEN)

**Objective:** Implement `deriveAcceptanceContract(plan, task)` and `contractDigest(contract)` with full TDD.

**Files:**
- Modify: `packages/policy/src/acceptance.ts`
- Create: `packages/policy/test/acceptance.test.ts`

- [ ] **Step 1:** Write failing tests in `packages/policy/test/acceptance.test.ts`. Note: `buildDefaultCapabilityBundleForTask` only reads `plan.id`, so the test fixture can use a partial cast.

```ts
import { describe, expect, it } from "vitest";
import type { PlanForgePlan, PlanForgeTask } from "@buildplane/planforge";
import type { AcceptanceContractV0 } from "@buildplane/kernel";
import {
	contractDigest,
	deriveAcceptanceContract,
	evaluateAcceptanceContract,
} from "../src/acceptance.js";

function makeTask(overrides: Partial<PlanForgeTask> = {}): PlanForgeTask {
	return {
		id: "PF1",
		title: "Test task",
		objective: "Test",
		assigneeHint: "auto-coder",
		workspace: "test",
		dependsOn: [],
		allowedSideEffects: ["local-doc"],
		forbiddenSideEffects: [],
		acceptanceCriteria: [],
		verificationCommands: ["pnpm test", "pnpm lint"],
		...overrides,
	} as PlanForgeTask;
}

function makePlan(tasks: PlanForgeTask[] = [makeTask()]): PlanForgePlan {
	return { id: "plan-1", tasks } as PlanForgePlan;
}

describe("deriveAcceptanceContract", () => {
	it("maps fsWrite globs from the capability bundle to diff_scope.allowed_globs", () => {
		const task = makeTask({ allowedSideEffects: ["local-doc"] });
		const contract = deriveAcceptanceContract(makePlan([task]), task);
		expect(contract.contract_version).toBe("v0");
		expect(contract.diff_scope.allowed_globs).toEqual(["docs/**"]);
	});

	it("maps multiple side effects to sorted allowed_globs", () => {
		const task = makeTask({
			allowedSideEffects: ["local-receipt", "local-doc"],
		});
		const contract = deriveAcceptanceContract(makePlan([task]), task);
		expect(contract.diff_scope.allowed_globs).toEqual([
			"docs/**",
			"docs/operations/**",
		]);
	});

	it("maps verificationCommands to checks, order-preserved and de-duplicated", () => {
		const task = makeTask({
			verificationCommands: ["pnpm test", "pnpm lint", "pnpm test"],
		});
		const contract = deriveAcceptanceContract(makePlan([task]), task);
		expect(contract.checks).toEqual([
			{ command: "pnpm test" },
			{ command: "pnpm lint" },
		]);
	});

	it("produces an empty checks array when verificationCommands is empty", () => {
		const task = makeTask({ verificationCommands: [] });
		const contract = deriveAcceptanceContract(makePlan([task]), task);
		expect(contract.checks).toEqual([]);
	});

	it("produces an empty allowed_globs when no fsWrite side effects", () => {
		const task = makeTask({
			allowedSideEffects: [],
			verificationCommands: ["pnpm test"],
		});
		const contract = deriveAcceptanceContract(makePlan([task]), task);
		expect(contract.diff_scope.allowed_globs).toEqual([]);
	});

	it("is deterministic — two derivations of the same plan+task produce byte-identical contracts", () => {
		const plan = makePlan();
		const task = makeTask();
		const c1 = deriveAcceptanceContract(plan, task);
		const c2 = deriveAcceptanceContract(plan, task);
		expect(JSON.stringify(c1)).toBe(JSON.stringify(c2));
	});
});

describe("contractDigest", () => {
	it("returns a sha256: prefixed digest", () => {
		const contract = deriveAcceptanceContract(makePlan(), makeTask());
		const d = contractDigest(contract);
		expect(d).toMatch(/^sha256:[0-9a-f]{64}$/);
	});

	it("is stable across re-derivations of the same plan+task", () => {
		const plan = makePlan();
		const task = makeTask();
		const d1 = contractDigest(deriveAcceptanceContract(plan, task));
		const d2 = contractDigest(deriveAcceptanceContract(plan, task));
		expect(d1).toBe(d2);
	});
});
```

- [ ] **Step 2:** Run tests — expect FAIL (`deriveAcceptanceContract` and `contractDigest` not exported):

```bash
pnpm -C packages/policy exec vitest run test/acceptance.test.ts
```

- [ ] **Step 3:** Implement `deriveAcceptanceContract` and `contractDigest` in `packages/policy/src/acceptance.ts`. Add these imports at the top and the functions after the type declarations:

```ts
import {
	type PlanForgePlan,
	type PlanForgeTask,
	buildDefaultCapabilityBundleForTask,
	digest,
} from "@buildplane/planforge";
import { evaluateArchitectureDiffScope } from "./diff-scope.js";
```

```ts
export function deriveAcceptanceContract(
	plan: PlanForgePlan,
	task: PlanForgeTask,
): AcceptanceContractV0 {
	const bundle = buildDefaultCapabilityBundleForTask(plan, task);
	const allowedGlobs = [...(bundle.fsWrite ?? [])].sort();
	const seen = new Set<string>();
	const checks: { readonly command: string }[] = [];
	for (const cmd of task.verificationCommands) {
		if (!seen.has(cmd)) {
			seen.add(cmd);
			checks.push({ command: cmd });
		}
	}
	return {
		contract_version: "v0",
		diff_scope: { allowed_globs: allowedGlobs },
		checks,
	};
}

export function contractDigest(contract: AcceptanceContractV0): string {
	return digest(contract);
}
```

- [ ] **Step 4:** Run tests — expect PASS:

```bash
pnpm -C packages/policy exec vitest run test/acceptance.test.ts
```

---

## Task 4: evaluateAcceptanceContract (RED → GREEN)

**Objective:** Implement the pure evaluator that reuses `evaluateArchitectureDiffScope`.

**Files:**
- Modify: `packages/policy/src/acceptance.ts` (add function — `evaluateArchitectureDiffScope` import already added in Task 3)
- Modify: `packages/policy/test/acceptance.test.ts` (add test block)

- [ ] **Step 1:** Add failing tests for `evaluateAcceptanceContract` to `packages/policy/test/acceptance.test.ts`:

```ts
describe("evaluateAcceptanceContract", () => {
	const contract: AcceptanceContractV0 = {
		contract_version: "v0",
		diff_scope: { allowed_globs: ["docs/**"] },
		checks: [{ command: "pnpm test" }, { command: "pnpm lint" }],
	};

	it("passes when all changed files are in scope and all checks exit 0", () => {
		const verdict = evaluateAcceptanceContract(contract, {
			changedFiles: ["docs/readme.md"],
			checkResults: [
				{ command: "pnpm test", exitCode: 0 },
				{ command: "pnpm lint", exitCode: 0 },
			],
		});
		expect(verdict.outcome).toBe("passed");
	});

	it("rejects when a changed file is out of scope", () => {
		const verdict = evaluateAcceptanceContract(contract, {
			changedFiles: ["docs/readme.md", "packages/kernel/src/index.ts"],
			checkResults: [
				{ command: "pnpm test", exitCode: 0 },
				{ command: "pnpm lint", exitCode: 0 },
			],
		});
		expect(verdict.outcome).toBe("rejected");
		if (verdict.outcome === "rejected") {
			expect(verdict.diffScopeStatus).toBe("blocked");
			expect(verdict.outOfScopeFiles).toContain(
				"packages/kernel/src/index.ts",
			);
			expect(verdict.failedChecks).toEqual([]);
		}
	});

	it("rejects when a check exits non-zero (diff scope passes)", () => {
		const verdict = evaluateAcceptanceContract(contract, {
			changedFiles: ["docs/readme.md"],
			checkResults: [
				{ command: "pnpm test", exitCode: 0 },
				{ command: "pnpm lint", exitCode: 1 },
			],
		});
		expect(verdict.outcome).toBe("rejected");
		if (verdict.outcome === "rejected") {
			expect(verdict.diffScopeStatus).toBe("passed");
			expect(verdict.outOfScopeFiles).toEqual([]);
			expect(verdict.failedChecks).toEqual([
				{ command: "pnpm lint", exitCode: 1 },
			]);
		}
	});

	it("rejects when both diff-scope and checks fail (reports both)", () => {
		const verdict = evaluateAcceptanceContract(contract, {
			changedFiles: ["src/hack.ts"],
			checkResults: [{ command: "pnpm test", exitCode: 2 }],
		});
		expect(verdict.outcome).toBe("rejected");
		if (verdict.outcome === "rejected") {
			expect(verdict.diffScopeStatus).toBe("blocked");
			expect(verdict.outOfScopeFiles).toContain("src/hack.ts");
			expect(verdict.failedChecks).toEqual([
				{ command: "pnpm test", exitCode: 2 },
			]);
		}
	});

	it("passes when changedFiles is empty and all checks pass", () => {
		const verdict = evaluateAcceptanceContract(contract, {
			changedFiles: [],
			checkResults: [
				{ command: "pnpm test", exitCode: 0 },
				{ command: "pnpm lint", exitCode: 0 },
			],
		});
		expect(verdict.outcome).toBe("passed");
	});
});
```

- [ ] **Step 2:** Run tests — expect FAIL (`evaluateAcceptanceContract` not exported):

```bash
pnpm -C packages/policy exec vitest run test/acceptance.test.ts
```

- [ ] **Step 3:** Implement `evaluateAcceptanceContract` in `packages/policy/src/acceptance.ts`:

```ts
export function evaluateAcceptanceContract(
	contract: AcceptanceContractV0,
	evidence: AcceptanceEvidence,
): AcceptanceVerdict {
	const diffScopeResult = evaluateArchitectureDiffScope(evidence.changedFiles, {
		allowedPaths: contract.diff_scope.allowed_globs,
		deniedPaths: contract.diff_scope.denied_globs,
	});
	const diffScopeStatus =
		diffScopeResult.status === "passed" ? "passed" : "blocked";
	const outOfScopeFiles = [...diffScopeResult.outOfScopeFiles];
	const failedChecks = evidence.checkResults.filter((r) => r.exitCode !== 0);

	if (diffScopeStatus === "passed" && failedChecks.length === 0) {
		return { outcome: "passed" };
	}
	return {
		outcome: "rejected",
		diffScopeStatus,
		outOfScopeFiles,
		failedChecks: [...failedChecks],
	};
}
```

- [ ] **Step 4:** Run tests — expect PASS:

```bash
pnpm -C packages/policy exec vitest run test/acceptance.test.ts
```

---

## Task 5: Wire exports + full policy test run + typecheck

**Objective:** Export all new symbols from `packages/policy/src/index.ts` and verify the full package + kernel consumers.

**Files:**
- Modify: `packages/policy/src/index.ts`

- [ ] **Step 1:** Add exports to `packages/policy/src/index.ts`:

```ts
export {
	type AcceptanceEvidence,
	type AcceptanceVerdict,
	contractDigest,
	deriveAcceptanceContract,
	evaluateAcceptanceContract,
} from "./acceptance.js";
```

Note: `AcceptanceContractV0` is exported from `@buildplane/kernel`, not re-exported from policy. Consumers who need the contract type import it from `@buildplane/kernel`.

- [ ] **Step 2:** Scoped typecheck (policy):

```bash
pnpm exec tsc --build packages/policy/tsconfig.json --pretty false
```

Expected: PASS.

- [ ] **Step 3:** Full policy test run:

```bash
pnpm -C packages/policy exec vitest run
```

Expected: all tests PASS (existing `diff-scope`, `budgets`, `decision`, `trust-gates`, `profiles`, `grants`, `retry` + new `acceptance`).

- [ ] **Step 4:** Kernel typecheck (verify the type extension didn't break consumers):

```bash
pnpm exec tsc --build packages/kernel/tsconfig.json --pretty false
```

Expected: PASS.

- [ ] **Step 5:** Lint the new/modified files:

```bash
pnpm exec biome check packages/policy/src/acceptance.ts packages/policy/test/acceptance.test.ts packages/kernel/src/policy.ts packages/kernel/src/run-loop.ts
```

Expected: PASS (fix any formatting issues with `pnpm exec biome format --write` if needed).

---

## Task 6: Changeset + commit discipline

- [ ] **Step 1:** Create `.changeset/m4-s1-acceptance-contract.md`:

```markdown
---
"@buildplane/policy": minor
"@buildplane/kernel": minor
---

Add AcceptanceContractV0 type, deriveAcceptanceContract, contractDigest, and evaluateAcceptanceContract — the pure schema + evaluator foundation for M4 acceptance contracts.
```

- [ ] **Step 2:** Conventional commits (lowercase verb), e.g.:
  - `feat(kernel): add AcceptanceContractV0 type + extend TrustGateConfig/RejectedPolicyDecision (M4-S1)`
  - `feat(policy): add acceptance contract derive + evaluate + digest (M4-S1)`
  - `chore: changeset for m4-s1 acceptance contract`

- [ ] **Step 3:** Slice receipt: `docs/operations/2026-06-18-m4-s1-acceptance-contract-slice-receipt.md` (use template) before PR.

- [ ] **Step 4:** Open PR from `feat/m4-s1-acceptance-contract` cut from `origin/main` after the M4 spec PR merges (or stack on `feat/m4-spec` if operator prefers single train).

---

## Out of scope (S1)

- `acceptance_recorded` tape event (S2 — L0, full 4-role review)
- Finalization gate wiring / orchestrator changes / CLI `profileRegistry` (S3)
- `acceptancePort` / `emitAcceptanceRecorded` (S3)
- Quarantine / worktree preservation mechanics (S3)
- `UnitPacket.acceptance_contract` population (stays `unknown`/reserved)
- `run_outcomes` trust scoring (later M4 slice)
- Observed-write reconciliation (later M4 slice)
- `denied_globs` derivation (no source in v0 capability bundle)
- Plan-level aggregate acceptance checks (per-task is the M4 grain)

---

## Verification summary (slice gate)

```bash
pnpm -C <worktree> exec vitest run packages/policy/test/acceptance.test.ts
pnpm -C <worktree> exec vitest run packages/policy
pnpm exec tsc --build packages/policy/tsconfig.json --pretty false
pnpm exec tsc --build packages/kernel/tsconfig.json --pretty false
pnpm exec biome check packages/policy/src/acceptance.ts packages/policy/test/acceptance.test.ts packages/kernel/src/policy.ts packages/kernel/src/run-loop.ts
```

CI `verify` is canonical for full monorepo gate before merge.
