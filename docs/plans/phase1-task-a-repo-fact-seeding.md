# Phase 1 · Task A — Repo-Fact Seeding from Inspection — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Seed durable `repo.*` structured facts (primary language, test/build/typecheck/lint commands) into `repo_facts` from a lightweight repo inspection, via the existing `upsertRepoFact` port — no port change.

**Architecture:** A new pure module `repo-fact-seeding.ts` holds a stable `REPO_FACT_KEYS` registry, a `detectRepoSignals(projectRoot)` reader (parses `package.json` scripts + detects TS), and `seedRepoFactsFromInspection(port, signals, provenance)` that calls the existing `BuildplaneStoragePort.upsertRepoFact` once per non-empty signal. A thin `bootstrap seed` CLI subcommand wires detection → seeding → report.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Node ≥24.13, vitest, `@buildplane/storage` (`createBuildplaneStorage`), `@buildplane/kernel` types.

---

## Opus Planning Reference (handoff contract)

- **Slice ID:** `phase1-task-A-repo-fact-seeding`
- **Phase:** 1 (V1 gap closure) — parallel lane A of A/B/C
- **Branch base:** cut the worktree from `origin/main` (hard invariant — local `main` is ~70 commits behind). Last verified `origin/main` tip: `29b47fc`.
- **Frozen contract excerpt (authority: `docs/plans/phase1-memory-port-contract.md`):**
  - Adds a NEW caller of the EXISTING `upsertRepoFact(input: UpsertRepoFactInput): RepoFact` (`packages/kernel/src/ports.ts:90`). **No port method added or modified.**
  - `REPO_FACT_KEYS = { primaryLanguage:"repo.primary-language", testRunner:"repo.test-runner", buildCommand:"repo.build-command", typecheckCommand:"repo.typecheck-command", lintCommand:"repo.lint-command" }`.
  - Each non-empty signal → `upsertRepoFact({ factKey, factValue, valueType:"string", scopeType:"repo", createdBy:"system", ...provenance })`.
  - **Collision rule (ADR 0001):** promote-derived factKeys come from `normalizeReceiptLearningFactKey(title)` = `sanitizeVerifiedMemoryText(title)` (`run-cli.ts:1499,1527`). This is near-identity on `[A-Za-z0-9._-]`, so a learning titled `repo.test-runner` sanitizes to exactly that — **collisions are POSSIBLE, not impossible.** `upsertRepoFact` is last-writer-wins with no conservatism (`store.ts:2531-2545`); the promote *caller* skips on conflict, direct seeding does not.
- **Off-limits:** any port signature; table DDL; `promoteMemoryFromReceipt` logic; `extractLearnings`; `memory-retrieval.ts` ranking; the `memory` command dispatch (`run-cli.ts:3391` — that is Task B's surface — keep this slice in the `bootstrap` branch).
- **Merge eligibility:** narrow + green → `buildplane:auto-merge`. **Caveat:** this slice edits `apps/cli/src/run-cli.ts` (the `bootstrap` branch, ~`:3301-3345`), a file Task B also edits (the `memory` branch, ~`:3391`). The two edits are far apart and neither touches a port signature, so both stay auto-merge-eligible; if they race, rebase Task A first (it is the smaller diff). If any port signature ends up changed, flip to manual Opus review.
- **Verify command:** `pnpm --filter buildplane test test/repo-fact-seeding.test.ts test/run-cli.test.ts`

## Verify-first (do this BEFORE writing implementation)

- [ ] **VF-1: Confirm the collision surface.** Open `apps/cli/src/run-cli.ts` and read `sanitizeVerifiedMemoryText` (`:1499`) and `normalizeReceiptLearningFactKey` (`:1527`). Confirm sanitize only: strips ANSI/control chars, replaces backtick→`'`, escapes `|`→`\|` and `-->`/`<!--`, inserts ZWSP after `@`, collapses whitespace, trims. Conclusion to record in the receipt: **it does NOT lowercase, strip dots, or strip a `repo.` prefix → a promote-derived key CAN equal a seeded `repo.*` key.** Therefore the `repo.*` namespace is NOT inherently collision-free.

- [ ] **VF-2: Lock the resolution.** Adopt the contract's documented arm: **inspection-seeded `repo.*` facts are authoritative for that namespace; seeding is idempotent last-writer-wins; `createdBy:"system"` distinguishes provenance.** (We keep `repo.*` rather than inventing an unreadable collision-proof namespace, because sanitize is near-identity on `[A-Za-z0-9._-]` so no clean prefix is provably unreachable, and the promote caller already skips overwriting facts from different provenance — `run-cli.ts:1740-1758` — so seeding only ever loses to a *re-seed*, never to a promote.) This decision is locked by the idempotency test in Task A2.

- [ ] **VF-3: Confirm the signals source gap.** From the repo root run `git grep -nE "primaryLanguage|testRunner|buildCommand|typecheckCommand|lintCommand" origin/main -- apps packages` (or, from outside it, `git -C <abs-path-to-buildplane> grep -nE "..." origin/main -- apps packages`). Confirm **no existing inspection routine emits these repo signals** (`inspectCapabilities` covers Node/sqlite/native-binary only). Conclusion: this slice must build `detectRepoSignals`; the contract intentionally leaves the signal→input binding to this verify-first.

---

## File Structure

- `apps/cli/src/repo-fact-seeding.ts` — **new.** `REPO_FACT_KEYS`, `RepoSignals`, `SeedProvenance`, `detectRepoSignals`, `seedRepoFactsFromInspection`. One responsibility: turn a repo into seeded repo-facts.
- `apps/cli/test/repo-fact-seeding.test.ts` — **new.** Unit tests for the pure module.
- `apps/cli/src/run-cli.ts` — **modify** the `bootstrap` command branch (~`:3301-3345`) to add a `seed` subcommand.
- `apps/cli/test/run-cli.test.ts` — **modify.** One integration test for `bootstrap seed`.

---

### Task A1: The seeding registry + pure seed function

**Files:**
- Create: `apps/cli/src/repo-fact-seeding.ts`
- Test: `apps/cli/test/repo-fact-seeding.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// apps/cli/test/repo-fact-seeding.test.ts
import { describe, expect, it, vi } from "vitest";
import {
	REPO_FACT_KEYS,
	seedRepoFactsFromInspection,
} from "../src/repo-fact-seeding.js";

function fakePort() {
	const upsertRepoFact = vi.fn((input) => ({
		id: `fact-${input.factKey}`,
		memoryType: "repo-fact" as const,
		scopeType: input.scopeType ?? "repo",
		status: "active" as const,
		factKey: input.factKey,
		valueType: input.valueType,
		factValue: input.factValue,
		provenance: {
			createdBy: input.createdBy,
			createdAt: "t",
			updatedAt: "t",
			confidence: input.confidence ?? 1,
			branch: input.branch,
			commitSha: input.commitSha,
		},
	}));
	return { upsertRepoFact };
}

describe("seedRepoFactsFromInspection", () => {
	it("seeds one repo.* fact per non-empty signal with system provenance", () => {
		const port = fakePort();
		const seeded = seedRepoFactsFromInspection(
			port,
			{
				primaryLanguage: "typescript",
				testRunner: "vitest --run",
				buildCommand: "tsc --build",
			},
			{ branch: "main", commitSha: "abc123" },
		);

		expect(port.upsertRepoFact).toHaveBeenCalledTimes(3);
		expect(seeded.map((f) => f.factKey)).toEqual([
			REPO_FACT_KEYS.primaryLanguage,
			REPO_FACT_KEYS.testRunner,
			REPO_FACT_KEYS.buildCommand,
		]);
		const first = port.upsertRepoFact.mock.calls[0][0];
		expect(first).toMatchObject({
			factKey: "repo.primary-language",
			factValue: "typescript",
			valueType: "string",
			scopeType: "repo",
			createdBy: "system",
			branch: "main",
			commitSha: "abc123",
		});
	});

	it("skips undefined and empty-string signals", () => {
		const port = fakePort();
		const seeded = seedRepoFactsFromInspection(
			port,
			{ primaryLanguage: "typescript", testRunner: "", buildCommand: undefined },
			{},
		);
		expect(port.upsertRepoFact).toHaveBeenCalledTimes(1);
		expect(seeded).toHaveLength(1);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter buildplane test test/repo-fact-seeding.test.ts`
Expected: FAIL — `Cannot find module '../src/repo-fact-seeding.js'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// apps/cli/src/repo-fact-seeding.ts
import type {
	BuildplaneStoragePort,
	RepoFact,
} from "@buildplane/kernel";

export const REPO_FACT_KEYS = {
	primaryLanguage: "repo.primary-language",
	testRunner: "repo.test-runner",
	buildCommand: "repo.build-command",
	typecheckCommand: "repo.typecheck-command",
	lintCommand: "repo.lint-command",
} as const;

export interface RepoSignals {
	primaryLanguage?: string;
	testRunner?: string;
	buildCommand?: string;
	typecheckCommand?: string;
	lintCommand?: string;
}

export interface SeedProvenance {
	branch?: string;
	commitSha?: string;
}

const SIGNAL_TO_KEY: ReadonlyArray<readonly [keyof RepoSignals, string]> = [
	["primaryLanguage", REPO_FACT_KEYS.primaryLanguage],
	["testRunner", REPO_FACT_KEYS.testRunner],
	["buildCommand", REPO_FACT_KEYS.buildCommand],
	["typecheckCommand", REPO_FACT_KEYS.typecheckCommand],
	["lintCommand", REPO_FACT_KEYS.lintCommand],
];

// Inspection-seeded `repo.*` facts are AUTHORITATIVE for that namespace and are
// written last-writer-wins (ADR 0001 VF-2). The promote caller already refuses to
// overwrite facts from different provenance, so seeding only ever supersedes a
// previous seed of the same key.
export function seedRepoFactsFromInspection(
	port: Pick<BuildplaneStoragePort, "upsertRepoFact">,
	signals: RepoSignals,
	provenance: SeedProvenance,
): RepoFact[] {
	const seeded: RepoFact[] = [];
	for (const [signalKey, factKey] of SIGNAL_TO_KEY) {
		const value = signals[signalKey];
		if (value === undefined || value === "") {
			continue;
		}
		seeded.push(
			port.upsertRepoFact({
				factKey,
				factValue: value,
				valueType: "string",
				scopeType: "repo",
				createdBy: "system",
				confidence: 1,
				branch: provenance.branch,
				commitSha: provenance.commitSha,
			}),
		);
	}
	return seeded;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter buildplane test test/repo-fact-seeding.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/repo-fact-seeding.ts apps/cli/test/repo-fact-seeding.test.ts
git commit -m "feat(memory): add seedRepoFactsFromInspection + REPO_FACT_KEYS registry"
```

### Task A2: Idempotency / last-writer-wins lock (VF-2 evidence)

**Files:**
- Test: `apps/cli/test/repo-fact-seeding.test.ts`

- [ ] **Step 1: Write the failing test** (append to the existing `describe`)

```ts
	it("is idempotent last-writer-wins: re-seeding the same key issues a fresh upsert", () => {
		const port = fakePort();
		seedRepoFactsFromInspection(port, { testRunner: "vitest" }, {});
		seedRepoFactsFromInspection(port, { testRunner: "vitest --run" }, {});
		expect(port.upsertRepoFact).toHaveBeenCalledTimes(2);
		expect(port.upsertRepoFact.mock.calls[0][0].factValue).toBe("vitest");
		expect(port.upsertRepoFact.mock.calls[1][0].factValue).toBe("vitest --run");
		// Both target the SAME factKey -> store supersedes the first (last-writer-wins).
		expect(port.upsertRepoFact.mock.calls[0][0].factKey).toBe(
			port.upsertRepoFact.mock.calls[1][0].factKey,
		);
	});
```

- [ ] **Step 2: Run test to verify it passes** (no impl change — this LOCKS the VF-2 decision)

Run: `pnpm --filter buildplane test test/repo-fact-seeding.test.ts`
Expected: PASS (3 tests). If it fails, the seed function is deduping/skipping — that violates VF-2; remove the dedup.

- [ ] **Step 3: Commit**

```bash
git add apps/cli/test/repo-fact-seeding.test.ts
git commit -m "test(memory): lock repo-fact seeding as idempotent last-writer-wins"
```

### Task A3: `detectRepoSignals` (the signal→input binding from VF-3)

**Files:**
- Modify: `apps/cli/src/repo-fact-seeding.ts`
- Test: `apps/cli/test/repo-fact-seeding.test.ts`

- [ ] **Step 1: Write the failing test** (append)

```ts
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectRepoSignals } from "../src/repo-fact-seeding.js";

describe("detectRepoSignals", () => {
	it("reads scripts from package.json and detects TypeScript via tsconfig", () => {
		const root = mkdtempSync(join(tmpdir(), "bp-seed-"));
		writeFileSync(
			join(root, "package.json"),
			JSON.stringify({
				scripts: {
					test: "vitest --run",
					build: "tsc --build",
					typecheck: "tsc --noEmit",
					lint: "biome check",
				},
			}),
		);
		writeFileSync(join(root, "tsconfig.json"), "{}");

		expect(detectRepoSignals(root)).toEqual({
			primaryLanguage: "typescript",
			testRunner: "vitest --run",
			buildCommand: "tsc --build",
			typecheckCommand: "tsc --noEmit",
			lintCommand: "biome check",
		});
	});

	it("returns javascript and omits missing scripts when no tsconfig", () => {
		const root = mkdtempSync(join(tmpdir(), "bp-seed-"));
		writeFileSync(
			join(root, "package.json"),
			JSON.stringify({ scripts: { test: "node --test" } }),
		);
		const signals = detectRepoSignals(root);
		expect(signals.primaryLanguage).toBe("javascript");
		expect(signals.testRunner).toBe("node --test");
		expect(signals.buildCommand).toBeUndefined();
	});

	it("returns empty signals when there is no package.json", () => {
		const root = mkdtempSync(join(tmpdir(), "bp-seed-"));
		expect(detectRepoSignals(root)).toEqual({});
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter buildplane test test/repo-fact-seeding.test.ts`
Expected: FAIL — `detectRepoSignals is not a function`.

- [ ] **Step 3: Write minimal implementation** (add to `repo-fact-seeding.ts`)

```ts
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export function detectRepoSignals(projectRoot: string): RepoSignals {
	const pkgPath = join(projectRoot, "package.json");
	if (!existsSync(pkgPath)) {
		return {};
	}
	let pkg: { scripts?: Record<string, string> };
	try {
		pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
	} catch {
		return {};
	}
	const scripts = pkg.scripts ?? {};
	const hasTsconfig = existsSync(join(projectRoot, "tsconfig.json"));
	return {
		primaryLanguage: hasTsconfig ? "typescript" : "javascript",
		testRunner: scripts.test,
		buildCommand: scripts.build,
		typecheckCommand: scripts.typecheck,
		lintCommand: scripts.lint,
	};
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter buildplane test test/repo-fact-seeding.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/repo-fact-seeding.ts apps/cli/test/repo-fact-seeding.test.ts
git commit -m "feat(memory): detect repo signals from package.json for seeding"
```

### Task A4: Wire the `bootstrap seed` CLI trigger

**Files:**
- Modify: `apps/cli/src/run-cli.ts` — the `bootstrap` command branch. Today it only handles `doctor` and throws on any other subcommand (`Unknown bootstrap command`). Add a `seed` subcommand BEFORE that throw.
- Test: `apps/cli/test/run-cli.test.ts`

- [ ] **Step 1: Write the failing test** (append a new `it` inside the existing `describe("cli command surface")`)

`run-cli.test.ts` already imports `createBuildplaneStorage` (`:24`), `mkdtempSync`, `tmpdir`, `join`, and `writeFileSync` — no new imports needed. (If porting this test elsewhere, add `import { createBuildplaneStorage } from "@buildplane/storage";`.)

```ts
	it("bootstrap seed writes repo.* facts and reports them", async () => {
		const root = mkdtempSync(join(tmpdir(), "buildplane-cli-seed-"));
		// initialize a project so the state DB exists
		createBuildplaneStorage(root).initializeProject();
		writeFileSync(
			join(root, "package.json"),
			JSON.stringify({ scripts: { test: "vitest --run", build: "tsc -b" } }),
		);
		writeFileSync(join(root, "tsconfig.json"), "{}");

		const result = await runCliCapture(root, ["bootstrap", "seed", "--json"]);
		expect(result.exitCode).toBe(0);
		const seeded = JSON.parse(result.stdout.join("\n"));
		const keys = seeded.map((f: { factKey: string }) => f.factKey);
		expect(keys).toContain("repo.primary-language");
		expect(keys).toContain("repo.test-runner");
		expect(keys).toContain("repo.build-command");

		// Persisted: a fresh read-only port can list them.
		const facts = createBuildplaneStorage(root).listRepoFacts({
			scopeType: "repo",
		});
		expect(facts.some((f) => f.factKey === "repo.test-runner")).toBe(true);
	});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter buildplane test test/run-cli.test.ts`
Expected: FAIL — exitCode non-zero / throw `Unknown bootstrap command: seed`.

- [ ] **Step 3: Write minimal implementation**

In `apps/cli/src/run-cli.ts`, inside `if (command === "bootstrap") { ... }`, add this block immediately after the `if (subcommand === "doctor") { ... }` block and before the final `throw new Error("Unknown bootstrap command...")`:

```ts
			if (subcommand === "seed") {
				const seedArgs = rest.slice(1);
				const json = seedArgs.includes("--json");
				const { detectRepoSignals, seedRepoFactsFromInspection } =
					await import("./repo-fact-seeding.js");
				const { createBuildplaneStorage } = (await import(
					"@buildplane/storage"
				)) as unknown as {
					createBuildplaneStorage: (
						root: string,
					) => Pick<
						import("@buildplane/kernel").BuildplaneStoragePort,
						"upsertRepoFact"
					>;
				};
				const signals = detectRepoSignals(cwd);
				const seeded = seedRepoFactsFromInspection(
					createBuildplaneStorage(cwd),
					signals,
					{ branch: resolveCurrentBranch(cwd) },
				);
				if (json) {
					stdout(formatJson(seeded));
				} else if (seeded.length === 0) {
					stdout("No repo signals detected; nothing seeded.");
				} else {
					for (const fact of seeded) {
						stdout(`seeded ${fact.factKey} = ${String(fact.factValue)}`);
					}
				}
				return 0;
			}
```

Notes for the implementer:
- This dynamic-import + `as unknown as {…}` narrowing mirrors the existing `loadRunHistory` precedent (`run-cli.ts:~1402`), which also dynamically imports from `@buildplane/storage`. Keep that house style; do NOT add a new top-level static import.
- `resolveCurrentBranch(cwd)` already exists in this file as a module-level function (`run-cli.ts:520`) and IS in lexical scope at the bootstrap branch. If you prefer to omit provenance, pass `{}` — provenance is optional in the contract.
- `formatJson` and `stdout` are already in scope in this dispatch.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter buildplane test test/run-cli.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + full suite**

Run: `pnpm --filter buildplane exec tsc --build && pnpm --filter buildplane test`
Expected: typecheck clean; full vitest suite green.

- [ ] **Step 6: Commit**

```bash
git add apps/cli/src/run-cli.ts apps/cli/test/run-cli.test.ts
git commit -m "feat(cli): add 'bootstrap seed' to write inspection-derived repo facts"
```

---

## Acceptance Criteria

1. `seedRepoFactsFromInspection` writes exactly one `repo.*` fact per non-empty signal, each `scopeType:"repo"`, `createdBy:"system"`, `valueType:"string"`, carrying provenance — and **adds no port method**.
2. Re-seeding the same key issues a fresh upsert (idempotent last-writer-wins), locking the VF-2 decision.
3. `detectRepoSignals` derives signals from `package.json` scripts + tsconfig presence, and returns `{}` when no `package.json`.
4. `bootstrap seed [--json]` persists the facts; a fresh `listRepoFacts({scopeType:"repo"})` reads them back.
5. `pnpm --filter buildplane exec tsc --build` is clean and `pnpm --filter buildplane test` is green.
6. The diff touches only `repo-fact-seeding.ts`, its test, the `bootstrap` branch of `run-cli.ts`, and `run-cli.test.ts`. No port signature, no DDL, no `memory` dispatch edit.

**One-line verify:** `pnpm --filter buildplane test test/repo-fact-seeding.test.ts test/run-cli.test.ts`

## Self-Review notes

- Spec coverage: contract's Task-A function signature, `REPO_FACT_KEYS`, collision verify-first, and signal-binding verify-first are all covered (VF-1/2/3 + A1–A4).
- Type consistency: `RepoSignals`, `SeedProvenance`, `REPO_FACT_KEYS`, `seedRepoFactsFromInspection`, `detectRepoSignals` are named identically across every task and test.
- Placeholder scan: every code step is complete; the only deliberately deferred decision (provenance source `resolveCurrentBranch` vs `{}`) is bounded with a concrete fallback.
