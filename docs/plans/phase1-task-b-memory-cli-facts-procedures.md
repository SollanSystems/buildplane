# Phase 1 · Task B — `memory facts` / `memory procedures` CLI — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the EXISTING `memory` CLI command with read-only `facts` and `procedures` subcommands that surface the structured-memory layer (`repo_facts`, `procedures`) — reusing `listRepoFacts` / `listProcedures` — with human and `--json` output.

**Architecture:** Add a structured-storage loader (`loadStoragePort`) backed by `createBuildplaneStorage`. Add `facts` and `procedures` branches to the existing `memory` dispatch in `run-cli.ts`. Add two formatters (`formatRepoFactsList`, `formatProceduresList`) mirroring `formatLearningsList`. **`episodes` is explicitly DEFERRED in Phase 1** (verify-first decision — no event-listing read path exists).

**Tech Stack:** TypeScript (ESM, `.js` specifiers), vitest, `@buildplane/storage` (`createBuildplaneStorage`, `resolveProjectLayout`), `@buildplane/kernel` (`RepoFact`, `ProcedureMemory`, `MemoryScopeType`).

---

## Opus Planning Reference (handoff contract)

- **Slice ID:** `phase1-task-B-memory-cli-facts-procedures`
- **Phase:** 1 (V1 gap closure) — parallel lane B of A/B/C
- **Branch base:** cut from `origin/main` (hard invariant). Verified tip: `29b47fc`.
- **Frozen contract excerpt (authority: `docs/plans/phase1-memory-port-contract.md`):**
  - EXTEND the existing `memory` command dispatch (`run-cli.ts:3391`, which already has `list`/`inspect`/`promote`). **Never create a parallel `memory-cli.ts`.**
  - ADD `memory facts [--scope <scopeType>] [--json]` → `listRepoFacts(options?)` (`ports.ts:98`).
  - ADD `memory procedures [--task-type <t>] [--json]` → `listProcedures(options?: { taskType?: string })` (`ports.ts:120`).
  - Reuse `apps/cli/src/formatters.ts` for output. `list`/`inspect`/`promote` stay UNCHANGED.
  - `episodes`: `getStatusSnapshot()` / `inspectTarget()` do NOT list events → **DEFER** (verify-first). Do NOT silently add a port method.
- **Off-limits:** any port signature; DDL; `promoteMemoryFromReceipt`; `extractLearnings`; `memory-retrieval.ts` ranking. Do NOT touch the `list`/`inspect`/`promote` branches.
- **Merge eligibility:** narrow + read-only + green → `buildplane:auto-merge`. Shares `run-cli.ts` with Task A (different command branches: A edits `bootstrap`, B edits `memory`); rebase if they race. No port change → stays auto-merge-eligible.
- **Verify command:** `pnpm --filter buildplane test test/run-cli.test.ts test/formatters.test.ts`

## Verify-first (do this BEFORE writing implementation)

- [ ] **VF-1: Confirm the read surface exists.** In `packages/kernel/src/ports.ts`, confirm `BuildplaneStoragePort` declares `listRepoFacts(options?: { scopeType?: MemoryScopeType; scopeKey?: string }): readonly RepoFact[]` (`:98`) and `listProcedures(options?: { taskType?: string }): readonly ProcedureMemory[]` (`:120`). Confirm `createBuildplaneStorage(projectRoot)` (`packages/storage/src/index.ts:88`) returns an object exposing both. No new port method is needed.
- [ ] **VF-2: Lock the episodes decision.** Confirm `StatusSnapshot` (`run-loop.ts:150`) has only run counts and `inspectTarget` (`run-loop.ts:216`) takes a single run/unit id and returns one run's `eventTape` — neither lists episodic events across the store. **Decision: DEFER `episodes` to Phase 2** and document it in the receipt + the `memory` help text. A shallow `episodes` over `inspectTarget` would need an id and would mislead users into thinking it lists the episodic log; deferring is cleaner than shipping a partial view.

---

## File Structure

- `apps/cli/src/run-cli.ts` — **modify:** add `loadStoragePort` helper (next to `loadReadOnlyMemoryPort`, ~`:1407`); add `facts` + `procedures` branches inside the `memory` dispatch (~`:3391`, after `inspect`, before the native fall-through).
- `apps/cli/src/formatters.ts` — **modify:** add `formatRepoFactsList`, `formatProceduresList` (mirroring `formatLearningsList` at `:1009`).
- `apps/cli/test/formatters.test.ts` — **modify:** unit tests for the two new formatters.
- `apps/cli/test/run-cli.test.ts` — **modify:** integration tests for `memory facts` / `memory procedures`.

---

### Task B1: Formatters for repo facts and procedures

**Files:**
- Modify: `apps/cli/src/formatters.ts`
- Test: `apps/cli/test/formatters.test.ts`

- [ ] **Step 1: Write the failing test** (append to `apps/cli/test/formatters.test.ts`)

```ts
import {
	formatProceduresList,
	formatRepoFactsList,
} from "../src/formatters.js";

describe("formatRepoFactsList", () => {
	it("returns an empty-state line when there are no facts", () => {
		expect(formatRepoFactsList([])).toEqual(["No repo facts found."]);
	});

	it("renders a header and one row per fact", () => {
		const lines = formatRepoFactsList([
			{
				factKey: "repo.test-runner",
				scopeType: "repo",
				valueType: "string",
				factValue: "vitest --run",
			},
		]);
		expect(lines[0]).toContain("Key");
		expect(lines[0]).toContain("Value");
		expect(lines.some((l) => l.includes("repo.test-runner"))).toBe(true);
		expect(lines.some((l) => l.includes("vitest --run"))).toBe(true);
	});
});

describe("formatProceduresList", () => {
	it("returns an empty-state line when there are no procedures", () => {
		expect(formatProceduresList([])).toEqual(["No procedures found."]);
	});

	it("renders a header and one row per procedure", () => {
		const lines = formatProceduresList([
			{ id: "abcdef1234", taskType: "review", name: "How to review a PR" },
			{ id: "99887766", taskType: undefined, name: "General cleanup" },
		]);
		expect(lines[0]).toContain("Name");
		expect(lines.some((l) => l.includes("How to review a PR"))).toBe(true);
		expect(lines.some((l) => l.includes("review"))).toBe(true);
		// undefined taskType renders as a placeholder, not the string "undefined"
		expect(lines.some((l) => l.includes("undefined"))).toBe(false);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter buildplane test test/formatters.test.ts`
Expected: FAIL — `formatRepoFactsList`/`formatProceduresList` are not exported.

- [ ] **Step 3: Write minimal implementation** (append to `apps/cli/src/formatters.ts`)

```ts
interface RepoFactLike {
	readonly factKey: string;
	readonly scopeType: string;
	readonly valueType: string;
	readonly factValue: unknown;
}

export function formatRepoFactsList(
	facts: readonly RepoFactLike[],
): string[] {
	if (facts.length === 0) {
		return ["No repo facts found."];
	}
	const lines: string[] = [];
	lines.push(
		`${"Key".padEnd(28)} ${"Scope".padEnd(10)} ${"Type".padEnd(8)} Value`,
	);
	lines.push("─".repeat(80));
	for (const f of facts) {
		lines.push(
			`${f.factKey.padEnd(28)} ${f.scopeType.padEnd(10)} ${f.valueType.padEnd(8)} ${String(f.factValue)}`,
		);
	}
	return lines;
}

interface ProcedureLike {
	readonly id: string;
	readonly taskType?: string;
	readonly name: string;
}

export function formatProceduresList(
	procedures: readonly ProcedureLike[],
): string[] {
	if (procedures.length === 0) {
		return ["No procedures found."];
	}
	const lines: string[] = [];
	lines.push(`${"ID".padEnd(12)} ${"Task Type".padEnd(16)} Name`);
	lines.push("─".repeat(80));
	for (const p of procedures) {
		lines.push(
			`${p.id.slice(0, 8).padEnd(12)} ${(p.taskType ?? "-").padEnd(16)} ${p.name}`,
		);
	}
	return lines;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter buildplane test test/formatters.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/formatters.ts apps/cli/test/formatters.test.ts
git commit -m "feat(cli): add formatRepoFactsList + formatProceduresList"
```

### Task B2: Structured-storage loader

**Files:**
- Modify: `apps/cli/src/run-cli.ts`

> **Note (review B-001):** `createBuildplaneStorage(projectRoot)` returns a read-WRITE handle (unlike `loadReadOnlyMemoryPort`, which opens a `DatabaseSync(..., { readOnly: true })` and wraps it in `createLearningStore`). `createBuildplaneStorage` does not accept a read-only flag, so we narrow the handle to `MemoryListPortLike` (`listRepoFacts` | `listProcedures`) — both reads — and name the helper `loadStoragePort` (NOT `loadReadOnly…`) so the name doesn't over-promise. The narrowed type guarantees no caller can mutate through it. This mirrors the dynamic-import pattern used by `loadRunHistory` (~`:1402`).

- [ ] **Step 1: Add the loader** (place directly after `loadReadOnlyMemoryPort`, ~`:1428`)

```ts
type MemoryListPortLike = Pick<
	import("@buildplane/kernel").BuildplaneStoragePort,
	"listRepoFacts" | "listProcedures"
>;

async function loadStoragePort(
	projectRoot: string,
): Promise<MemoryListPortLike | undefined> {
	try {
		const { resolveProjectLayout, createBuildplaneStorage } = (await import(
			"@buildplane/storage"
		)) as unknown as {
			resolveProjectLayout: (root: string) => { stateDbPath: string };
			createBuildplaneStorage: (root: string) => MemoryListPortLike;
		};
		const layout = resolveProjectLayout(projectRoot);
		if (existsSync(layout.stateDbPath)) {
			return createBuildplaneStorage(projectRoot);
		}
	} catch {
		// Storage port unavailable (pre-cold-path project)
	}
	return undefined;
}
```

- [ ] **Step 2: Typecheck** (no test yet — this is a helper consumed in B3)

Run: `pnpm --filter buildplane exec tsc --build`
Expected: clean. (If `existsSync` is not already imported in this file it is — it is used by `loadReadOnlyMemoryPort`.)

- [ ] **Step 3: Commit**

```bash
git add apps/cli/src/run-cli.ts
git commit -m "feat(cli): add structured-storage port loader (listRepoFacts/listProcedures)"
```

### Task B3: `memory facts` subcommand

**Files:**
- Modify: `apps/cli/src/run-cli.ts` — `memory` dispatch (~`:3391`)
- Test: `apps/cli/test/run-cli.test.ts`

- [ ] **Step 1: Write the failing test** (append inside `describe("cli command surface")`)

```ts
	it("memory facts lists repo.* facts as json and human output", async () => {
		const root = mkdtempSync(join(tmpdir(), "buildplane-cli-facts-"));
		const storage = createBuildplaneStorage(root);
		storage.initializeProject();
		storage.upsertRepoFact({
			factKey: "repo.test-runner",
			factValue: "vitest --run",
			valueType: "string",
			scopeType: "repo",
			createdBy: "system",
		});

		const jsonResult = await runCliCapture(root, ["memory", "facts", "--json"]);
		expect(jsonResult.exitCode).toBe(0);
		const facts = JSON.parse(jsonResult.stdout.join("\n"));
		expect(facts.some((f: { factKey: string }) => f.factKey === "repo.test-runner")).toBe(true);

		const humanResult = await runCliCapture(root, ["memory", "facts"]);
		expect(humanResult.stdout.join("\n")).toContain("repo.test-runner");
		expect(humanResult.stdout.join("\n")).toContain("vitest --run");
	});

	it("memory facts on an uninitialized project prints the empty state", async () => {
		const root = mkdtempSync(join(tmpdir(), "buildplane-cli-facts-empty-"));
		const result = await runCliCapture(root, ["memory", "facts"]);
		expect(result.exitCode).toBe(0);
		expect(result.stdout.join("\n")).toContain("No repo facts found.");
	});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter buildplane test test/run-cli.test.ts`
Expected: FAIL — `facts` falls through to native dispatch and errors / does not print the expected output.

- [ ] **Step 3: Write minimal implementation**

In the `memory` dispatch, add this block AFTER the `if (subcommand === "inspect") { ... }` block and BEFORE the `// Fall through to native` comment:

```ts
			if (subcommand === "facts") {
				const subRest = rest.slice(1);
				const json = subRest.includes("--json");
				const scopeIdx = subRest.indexOf("--scope");
				const scopeType =
					scopeIdx >= 0 && scopeIdx + 1 < subRest.length
						? (subRest[scopeIdx + 1] as import("@buildplane/kernel").MemoryScopeType)
						: undefined;
				let facts: ReturnType<MemoryListPortLike["listRepoFacts"]> = [];
				try {
					const storagePort = await loadStoragePort(cwd);
					if (storagePort) {
						facts = storagePort.listRepoFacts(
							scopeType ? { scopeType } : undefined,
						);
					}
				} catch {
					// Database may lack the repo_facts table
				}
				if (json) {
					stdout(formatJson(facts));
				} else {
					for (const line of formatRepoFactsList(facts)) {
						stdout(line);
					}
				}
				return 0;
			}
```

Add `formatRepoFactsList` to the existing `formatters.js` import group at the top of `run-cli.ts` (the same group that imports `formatLearningsList`).

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter buildplane test test/run-cli.test.ts`
Expected: PASS (both new facts tests).

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/run-cli.ts apps/cli/test/run-cli.test.ts
git commit -m "feat(cli): add 'memory facts' subcommand"
```

### Task B4: `memory procedures` subcommand

**Files:**
- Modify: `apps/cli/src/run-cli.ts` — `memory` dispatch
- Test: `apps/cli/test/run-cli.test.ts`

- [ ] **Step 1: Write the failing test** (append inside `describe("cli command surface")`)

```ts
	it("memory procedures lists procedures filtered by --task-type", async () => {
		const root = mkdtempSync(join(tmpdir(), "buildplane-cli-procs-"));
		const storage = createBuildplaneStorage(root);
		storage.initializeProject();
		storage.createProcedure({
			name: "How to review a PR",
			taskType: "review",
			bodyMarkdown: "1. read the diff",
			createdBy: "system",
		});

		const jsonResult = await runCliCapture(root, [
			"memory",
			"procedures",
			"--task-type",
			"review",
			"--json",
		]);
		expect(jsonResult.exitCode).toBe(0);
		const procs = JSON.parse(jsonResult.stdout.join("\n"));
		expect(procs.some((p: { name: string }) => p.name === "How to review a PR")).toBe(true);

		const humanResult = await runCliCapture(root, ["memory", "procedures"]);
		expect(humanResult.stdout.join("\n")).toContain("How to review a PR");
	});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter buildplane test test/run-cli.test.ts`
Expected: FAIL — `procedures` falls through to native.

- [ ] **Step 3: Write minimal implementation**

In the `memory` dispatch, add immediately after the `facts` block:

```ts
			if (subcommand === "procedures") {
				const subRest = rest.slice(1);
				const json = subRest.includes("--json");
				const taskTypeIdx = subRest.indexOf("--task-type");
				const taskType =
					taskTypeIdx >= 0 && taskTypeIdx + 1 < subRest.length
						? subRest[taskTypeIdx + 1]
						: undefined;
				let procedures: ReturnType<MemoryListPortLike["listProcedures"]> = [];
				try {
					const storagePort = await loadStoragePort(cwd);
					if (storagePort) {
						procedures = storagePort.listProcedures(
							taskType ? { taskType } : undefined,
						);
					}
				} catch {
					// Database may lack the procedures table
				}
				if (json) {
					stdout(formatJson(procedures));
				} else {
					for (const line of formatProceduresList(procedures)) {
						stdout(line);
					}
				}
				return 0;
			}
```

Add `formatProceduresList` to the `formatters.js` import group in `run-cli.ts`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter buildplane test test/run-cli.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/run-cli.ts apps/cli/test/run-cli.test.ts
git commit -m "feat(cli): add 'memory procedures' subcommand"
```

### Task B5: Help text + episodes-deferral note

**Files:**
- Modify: `apps/cli/src/run-cli.ts` — the `memory` help lines (~`:693-695`)

- [ ] **Step 1: Update the help block** — replace the three `memory ...` help lines with:

```ts
		"    memory list            Show stored learnings",
		"    memory facts           Show structured repo facts",
		"    memory procedures      Show stored procedures",
		"    memory inspect <id>    Detail for one learning",
		"    memory <action>        Advanced memory operations (native)",
```

(Do not advertise `episodes` — it is deferred to Phase 2.)

- [ ] **Step 2: Full suite + typecheck**

Run: `pnpm --filter buildplane exec tsc --build && pnpm --filter buildplane test`
Expected: typecheck clean; full suite green.

- [ ] **Step 3: Commit**

```bash
git add apps/cli/src/run-cli.ts
git commit -m "docs(cli): surface memory facts/procedures in help; defer episodes"
```

---

## Acceptance Criteria

1. `memory facts [--scope <scopeType>] [--json]` reads via `listRepoFacts` and renders human/JSON output; empty/uninitialized projects print `No repo facts found.` with exit 0.
2. `memory procedures [--task-type <t>] [--json]` reads via `listProcedures`; `--task-type` filters.
3. `episodes` is NOT added; the deferral is documented in the receipt and help text omits it.
4. `list` / `inspect` / `promote` branches are byte-for-byte unchanged; no port signature added; no DDL.
5. `formatRepoFactsList` / `formatProceduresList` handle empty input and render `undefined` taskType as `-` (never the literal `"undefined"`).
6. `pnpm --filter buildplane exec tsc --build` clean and `pnpm --filter buildplane test` green.

**One-line verify:** `pnpm --filter buildplane test test/run-cli.test.ts test/formatters.test.ts`

## Self-Review notes

- Spec coverage: contract's `facts`/`procedures` subcommands, formatter reuse, and the episodes-defer decision are all covered (VF-1/2 + B1–B5).
- Type consistency: `MemoryListPortLike`, `loadStoragePort`, `formatRepoFactsList`, `formatProceduresList` named identically across helper, dispatch, and tests. Flag parsing mirrors the existing `memory list` `--scope`/`--kind` pattern exactly.
- Placeholder scan: no TODOs; every step has runnable code and an explicit expected result.
