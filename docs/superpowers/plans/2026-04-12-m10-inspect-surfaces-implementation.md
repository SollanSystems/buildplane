# M10 T4: Inspect Surfaces — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the flywheel visible to operators via TS-native `memory list`/`memory inspect` commands and a learnings section in the run inspector.

**Architecture:** Two new read methods on `BuildplaneMemoryPort` (`fetchLearningById`, `fetchLearningsByRunId`), two new CLI formatter functions, a lightweight `loadReadOnlyMemoryPort()` helper for memory-only commands, and CLI dispatch that intercepts `memory list`/`memory inspect` before native fallthrough.

**Tech Stack:** TypeScript, node:sqlite DatabaseSync, Vitest

---

### Task 1: Add `fetchLearningById` and `fetchLearningsByRunId` to kernel ports and storage

**Files:**
- Modify: `packages/kernel/src/ports.ts:144-165` (add two methods to `BuildplaneMemoryPort`)
- Modify: `packages/storage/src/learning-store.ts:23-183` (implement both methods)
- Test: `packages/storage/test/learning-store.test.ts`

- [ ] **Step 1: Write failing test for `fetchLearningById`**

In `packages/storage/test/learning-store.test.ts`, add inside the existing `describe("createLearningStore", ...)`:

```typescript
it("fetchLearningById returns a single learning by ID", () => {
	const store = createLearningStore(makeDb());
	store.writeLearnings("run-1", [learning]);
	const all = store.fetchLearnings();
	const id = all[0].id;
	const result = store.fetchLearningById(id);
	expect(result).toBeDefined();
	expect(result!.id).toBe(id);
	expect(result!.title).toBe("Run approved");
});

it("fetchLearningById returns undefined for missing ID", () => {
	const store = createLearningStore(makeDb());
	expect(store.fetchLearningById("nonexistent")).toBeUndefined();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /path/to/buildplane && pnpm vitest run packages/storage/test/learning-store.test.ts`
Expected: FAIL with "store.fetchLearningById is not a function"

- [ ] **Step 3: Write failing test for `fetchLearningsByRunId`**

In the same describe block:

```typescript
it("fetchLearningsByRunId returns learnings for that run only", () => {
	const store = createLearningStore(makeDb());
	store.writeLearnings("run-1", [learning]);
	store.writeLearnings("run-2", [
		{ ...learning, title: "Second learning" },
	]);
	const run1Learnings = store.fetchLearningsByRunId("run-1");
	expect(run1Learnings).toHaveLength(1);
	expect(run1Learnings[0].title).toBe("Run approved");
});

it("fetchLearningsByRunId returns empty array for unknown run", () => {
	const store = createLearningStore(makeDb());
	expect(store.fetchLearningsByRunId("nonexistent")).toEqual([]);
});
```

- [ ] **Step 4: Add methods to `BuildplaneMemoryPort` in ports.ts**

In `packages/kernel/src/ports.ts`, add two methods to the `BuildplaneMemoryPort` interface after the `promoteLearnings` method:

```typescript
/**
 * Retrieve a single learning by its ID. Returns undefined if not found or not active.
 * Synchronous.
 */
fetchLearningById(id: string): StoredLearning | undefined;
/**
 * Retrieve all active learnings produced by a specific run.
 * Synchronous. No limit — a single run produces at most a few learnings.
 */
fetchLearningsByRunId(runId: string): readonly StoredLearning[];
```

- [ ] **Step 5: Implement both methods in learning-store.ts**

In `packages/storage/src/learning-store.ts`, add inside the returned object from `createLearningStore()`, after the `promoteLearnings` method:

```typescript
fetchLearningById(id: string): StoredLearning | undefined {
	const rows = database
		.prepare(
			`SELECT id, run_id, scope, kind, title, body, status, created_at, seen_count
       FROM run_learnings
       WHERE id = ? AND status = 'active'
       LIMIT 1`,
		)
		.all(id) as unknown as LearningRow[];

	if (rows.length === 0) {
		return undefined;
	}
	const row = rows[0];
	return {
		id: row.id,
		runId: row.run_id,
		scope: row.scope as LearningScope,
		kind: row.kind as LearningKind,
		title: row.title,
		body: row.body,
		status: row.status as "active" | "superseded" | "archived",
		createdAt: row.created_at,
		seenCount: row.seen_count,
	};
},

fetchLearningsByRunId(runId: string): readonly StoredLearning[] {
	const rows = database
		.prepare(
			`SELECT id, run_id, scope, kind, title, body, status, created_at, seen_count
       FROM run_learnings
       WHERE run_id = ? AND status = 'active'
       ORDER BY created_at ASC`,
		)
		.all(runId) as unknown as LearningRow[];

	return rows.map((row) => ({
		id: row.id,
		runId: row.run_id,
		scope: row.scope as LearningScope,
		kind: row.kind as LearningKind,
		title: row.title,
		body: row.body,
		status: row.status as "active" | "superseded" | "archived",
		createdAt: row.created_at,
		seenCount: row.seen_count,
	}));
},
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd /path/to/buildplane && pnpm vitest run packages/storage/test/learning-store.test.ts`
Expected: All tests PASS

- [ ] **Step 7: Commit**

```bash
cd /path/to/buildplane
git add packages/kernel/src/ports.ts packages/storage/src/learning-store.ts packages/storage/test/learning-store.test.ts
git commit -m "feat: add fetchLearningById and fetchLearningsByRunId to memory port"
```

---

### Task 2: Add learning formatter functions

**Files:**
- Modify: `apps/cli/src/formatters.ts`
- Test: `apps/cli/test/formatters.test.ts` (create if not exists, or add to existing)

- [ ] **Step 1: Check if formatters test file exists**

Run: `ls /path/to/buildplane/apps/cli/test/formatters.test.ts 2>/dev/null || echo "MISSING"`

If missing, create it. If it exists, add to it.

- [ ] **Step 2: Write failing test for `formatLearningsList`**

In `apps/cli/test/formatters.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import {
	formatLearningDetail,
	formatLearningsList,
} from "../src/formatters.js";

const sampleLearning = {
	id: "abc-123",
	runId: "run-1",
	scope: "workspace" as const,
	kind: "constraint" as const,
	title: "Run rejected",
	body: "Rejected: exit code 1",
	status: "active" as const,
	createdAt: "2026-04-12T01:00:00Z",
	seenCount: 3,
};

describe("formatLearningsList", () => {
	it("formats a table with header and rows", () => {
		const lines = formatLearningsList([sampleLearning]);
		expect(lines[0]).toContain("ID");
		expect(lines[0]).toContain("Scope");
		expect(lines[0]).toContain("Kind");
		expect(lines[0]).toContain("Seen");
		expect(lines[0]).toContain("Title");
		expect(lines.length).toBeGreaterThanOrEqual(3); // header + separator + 1 row
		const dataLine = lines[2];
		expect(dataLine).toContain("abc-123");
		expect(dataLine).toContain("workspace");
		expect(dataLine).toContain("constraint");
		expect(dataLine).toContain("3");
		expect(dataLine).toContain("Run rejected");
	});

	it("returns 'No learnings found.' for empty array", () => {
		const lines = formatLearningsList([]);
		expect(lines).toEqual(["No learnings found."]);
	});
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd /path/to/buildplane && pnpm vitest run apps/cli/test/formatters.test.ts`
Expected: FAIL with "formatLearningsList is not a function" or import error

- [ ] **Step 4: Write failing test for `formatLearningDetail`**

Add to the same file:

```typescript
describe("formatLearningDetail", () => {
	it("formats full detail for a learning", () => {
		const lines = formatLearningDetail(sampleLearning);
		expect(lines).toContainEqual(expect.stringContaining("ID:"));
		expect(lines).toContainEqual(expect.stringContaining("abc-123"));
		expect(lines).toContainEqual(expect.stringContaining("Title:"));
		expect(lines).toContainEqual(expect.stringContaining("Run rejected"));
		expect(lines).toContainEqual(expect.stringContaining("Scope:"));
		expect(lines).toContainEqual(expect.stringContaining("workspace"));
		expect(lines).toContainEqual(expect.stringContaining("Kind:"));
		expect(lines).toContainEqual(expect.stringContaining("constraint"));
		expect(lines).toContainEqual(expect.stringContaining("Status:"));
		expect(lines).toContainEqual(expect.stringContaining("active"));
		expect(lines).toContainEqual(expect.stringContaining("Seen:"));
		expect(lines).toContainEqual(expect.stringContaining("3"));
		expect(lines).toContainEqual(expect.stringContaining("Run:"));
		expect(lines).toContainEqual(expect.stringContaining("run-1"));
		expect(lines).toContainEqual(expect.stringContaining("Body:"));
		expect(lines).toContainEqual(
			expect.stringContaining("Rejected: exit code 1"),
		);
	});
});
```

- [ ] **Step 5: Implement `formatLearningsList` and `formatLearningDetail` in formatters.ts**

Add to the bottom of `apps/cli/src/formatters.ts`:

```typescript
interface StoredLearningLike {
	readonly id: string;
	readonly runId: string;
	readonly scope: string;
	readonly kind: string;
	readonly title: string;
	readonly body: string;
	readonly status: string;
	readonly createdAt: string;
	readonly seenCount: number;
}

export function formatLearningsList(
	learnings: readonly StoredLearningLike[],
): string[] {
	if (learnings.length === 0) {
		return ["No learnings found."];
	}

	const lines: string[] = [];
	lines.push(
		`${"ID".padEnd(12)} ${"Scope".padEnd(12)} ${"Kind".padEnd(22)} ${"Seen".padEnd(6)} Title`,
	);
	lines.push("─".repeat(80));

	for (const l of learnings) {
		const shortId = l.id.slice(0, 8);
		lines.push(
			`${shortId.padEnd(12)} ${l.scope.padEnd(12)} ${l.kind.padEnd(22)} ${String(l.seenCount).padEnd(6)} ${l.title}`,
		);
	}

	return lines;
}

export function formatLearningDetail(
	learning: StoredLearningLike,
): string[] {
	const lines: string[] = [];
	lines.push(`ID:         ${learning.id}`);
	lines.push(`Title:      ${learning.title}`);
	lines.push(`Scope:      ${learning.scope}`);
	lines.push(`Kind:       ${learning.kind}`);
	lines.push(`Status:     ${learning.status}`);
	lines.push(`Seen:       ${learning.seenCount}`);
	lines.push(`Run:        ${learning.runId}`);
	lines.push(`Created:    ${learning.createdAt}`);
	lines.push("");
	lines.push("Body:");
	lines.push(learning.body);
	return lines;
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd /path/to/buildplane && pnpm vitest run apps/cli/test/formatters.test.ts`
Expected: All tests PASS

- [ ] **Step 7: Commit**

```bash
cd /path/to/buildplane
git add apps/cli/src/formatters.ts apps/cli/test/formatters.test.ts
git commit -m "feat: add formatLearningsList and formatLearningDetail formatters"
```

---

### Task 3: Wire `memory list` and `memory inspect` CLI commands

**Files:**
- Modify: `apps/cli/src/run-cli.ts:136-142` (expand `MemoryPortLike`)
- Modify: `apps/cli/src/run-cli.ts:501-513` (intercept `memory list`/`memory inspect`)
- Test: `apps/cli/test/run-cli.test.ts`

- [ ] **Step 1: Write failing test for `memory list`**

In `apps/cli/test/run-cli.test.ts`, add a new test. This test needs a real initialized project with learnings in the database. Add after the existing memory delegate test:

```typescript
it("memory list returns a formatted table of learnings", async () => {
	const root = mkdtempSync(join(tmpdir(), "buildplane-cli-memory-list-"));
	// Initialize project + write learnings to state.db
	execFileSync("git", ["init"], { cwd: root });
	execFileSync("git", ["commit", "--allow-empty", "-m", "init"], {
		cwd: root,
	});
	const storage = createBuildplaneStorage(root);
	(storage as unknown as { initialize(): void }).initialize();

	const { DatabaseSync } = await import("node:sqlite");
	const { resolveProjectLayout, createLearningStore } = await import(
		"@buildplane/storage"
	);
	const layout = resolveProjectLayout(root);
	const db = new DatabaseSync(layout.stateDbPath);
	const { bootstrapStorageProjectionSchema } = await import(
		"@buildplane/storage"
	);
	bootstrapStorageProjectionSchema(db);
	const store = createLearningStore(db);
	store.writeLearnings("run-abc", [
		{
			kind: "fact",
			scope: "workspace",
			title: "Verification gate passed",
			body: "All outputs verified",
		},
	]);
	db.close();

	const result = await runCliCapture(root, ["memory", "list"]);

	expect(result.exitCode).toBe(0);
	expect(result.stdout.join("\n")).toContain("Verification gate passed");
	expect(result.stdout.join("\n")).toContain("workspace");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /path/to/buildplane && pnpm vitest run apps/cli/test/run-cli.test.ts -t "memory list"`
Expected: FAIL — `memory list` currently dispatches to native, which fails

- [ ] **Step 3: Write failing test for `memory inspect`**

Add another test:

```typescript
it("memory inspect returns detail for a single learning", async () => {
	const root = mkdtempSync(
		join(tmpdir(), "buildplane-cli-memory-inspect-"),
	);
	execFileSync("git", ["init"], { cwd: root });
	execFileSync("git", ["commit", "--allow-empty", "-m", "init"], {
		cwd: root,
	});
	const storage = createBuildplaneStorage(root);
	(storage as unknown as { initialize(): void }).initialize();

	const { DatabaseSync } = await import("node:sqlite");
	const { resolveProjectLayout, createLearningStore } = await import(
		"@buildplane/storage"
	);
	const layout = resolveProjectLayout(root);
	const db = new DatabaseSync(layout.stateDbPath);
	const { bootstrapStorageProjectionSchema } = await import(
		"@buildplane/storage"
	);
	bootstrapStorageProjectionSchema(db);
	const store = createLearningStore(db);
	store.writeLearnings("run-abc", [
		{
			kind: "constraint",
			scope: "session",
			title: "Run rejected",
			body: "Rejected: exit code 1",
		},
	]);
	const learnings = store.fetchLearnings();
	const id = learnings[0].id;
	db.close();

	const result = await runCliCapture(root, ["memory", "inspect", id]);

	expect(result.exitCode).toBe(0);
	expect(result.stdout.join("\n")).toContain("Run rejected");
	expect(result.stdout.join("\n")).toContain("Rejected: exit code 1");
	expect(result.stdout.join("\n")).toContain(id);
});
```

- [ ] **Step 4: Write failing test for `memory list --json`**

```typescript
it("memory list --json returns JSON array", async () => {
	const root = mkdtempSync(
		join(tmpdir(), "buildplane-cli-memory-list-json-"),
	);
	execFileSync("git", ["init"], { cwd: root });
	execFileSync("git", ["commit", "--allow-empty", "-m", "init"], {
		cwd: root,
	});
	const storage = createBuildplaneStorage(root);
	(storage as unknown as { initialize(): void }).initialize();

	const { DatabaseSync } = await import("node:sqlite");
	const { resolveProjectLayout, createLearningStore } = await import(
		"@buildplane/storage"
	);
	const layout = resolveProjectLayout(root);
	const db = new DatabaseSync(layout.stateDbPath);
	const { bootstrapStorageProjectionSchema } = await import(
		"@buildplane/storage"
	);
	bootstrapStorageProjectionSchema(db);
	const store = createLearningStore(db);
	store.writeLearnings("run-abc", [
		{
			kind: "fact",
			scope: "workspace",
			title: "Verification gate passed",
			body: "All outputs verified",
		},
	]);
	db.close();

	const result = await runCliCapture(root, ["memory", "list", "--json"]);

	expect(result.exitCode).toBe(0);
	const parsed = JSON.parse(result.stdout.join("\n"));
	expect(Array.isArray(parsed)).toBe(true);
	expect(parsed).toHaveLength(1);
	expect(parsed[0].title).toBe("Verification gate passed");
});
```

- [ ] **Step 5: Write failing test that unknown memory subcommands still fall through to native**

```typescript
it("unknown memory subcommands still dispatch to native", async () => {
	const root = mkdtempSync(
		join(tmpdir(), "buildplane-cli-memory-native-fallthrough-"),
	);
	const calls: Array<{
		cwd: string;
		argv: string[];
		commandPath: string[];
	}> = [];
	const dependencies: RunCliDependencies = {
		runNativeCommand: async (argv, options) => {
			calls.push({
				cwd: options.cwd,
				argv,
				commandPath: options.commandPath,
			});
			return 0;
		},
	};

	await runCliCapture(root, ["memory", "search", "foo"], dependencies);

	expect(calls).toEqual([
		{
			cwd: root,
			commandPath: ["memory"],
			argv: ["search", "foo"],
		},
	]);
});
```

- [ ] **Step 6: Expand `MemoryPortLike` in run-cli.ts**

In `apps/cli/src/run-cli.ts`, replace the existing `MemoryPortLike` interface (lines 136-142) with:

```typescript
interface MemoryPortLike {
	fetchLearnings(options?: {
		scope?: string;
		kind?: string;
		limit?: number;
	}): ReadonlyArray<{
		id: string;
		runId: string;
		scope: string;
		kind: string;
		title: string;
		body: string;
		status: string;
		createdAt: string;
		seenCount: number;
	}>;
	fetchLearningById(id: string):
		| {
				id: string;
				runId: string;
				scope: string;
				kind: string;
				title: string;
				body: string;
				status: string;
				createdAt: string;
				seenCount: number;
		  }
		| undefined;
	fetchLearningsByRunId(runId: string): ReadonlyArray<{
		id: string;
		runId: string;
		scope: string;
		kind: string;
		title: string;
		body: string;
		status: string;
		createdAt: string;
		seenCount: number;
	}>;
}
```

- [ ] **Step 7: Add `loadReadOnlyMemoryPort` helper**

Add this function in `apps/cli/src/run-cli.ts`, after the `loadRunHistory` function (around line 376):

```typescript
async function loadReadOnlyMemoryPort(
	projectRoot: string,
): Promise<MemoryPortLike | undefined> {
	try {
		const { resolveProjectLayout, createLearningStore } = (await import(
			"@buildplane/storage"
		)) as unknown as {
			resolveProjectLayout: (root: string) => { stateDbPath: string };
			createLearningStore: (db: unknown) => MemoryPortLike;
		};
		const { DatabaseSync } = await import("node:sqlite");
		const layout = resolveProjectLayout(projectRoot);
		if (existsSync(layout.stateDbPath)) {
			const readDb = new DatabaseSync(layout.stateDbPath, { readOnly: true });
			return createLearningStore(readDb);
		}
	} catch {
		// Memory port unavailable
	}
	return undefined;
}
```

- [ ] **Step 8: Add formatter imports**

In `apps/cli/src/run-cli.ts`, add `formatLearningsList` and `formatLearningDetail` to the existing import from `"./formatters.js"`:

```typescript
import {
	formatHumanError,
	formatInitializationResult,
	formatInspectDetail,
	formatJson,
	formatJsonError,
	formatLearningDetail,
	formatLearningsList,
	formatRunHistory,
	formatRunResult,
	formatStrategyRunResult,
} from "./formatters.js";
```

- [ ] **Step 9: Intercept `memory list` and `memory inspect` before native dispatch**

Replace the `memory` command block in `runCli()` (lines 501-513) with:

```typescript
if (command === "memory") {
	const subcommand = rest[0];
	if (subcommand === "list") {
		const subRest = rest.slice(1);
		const json = subRest.includes("--json");
		const scopeIdx = subRest.indexOf("--scope");
		const scope =
			scopeIdx >= 0 && scopeIdx + 1 < subRest.length
				? subRest[scopeIdx + 1]
				: undefined;
		const kindIdx = subRest.indexOf("--kind");
		const kind =
			kindIdx >= 0 && kindIdx + 1 < subRest.length
				? subRest[kindIdx + 1]
				: undefined;
		const memoryPort = await loadReadOnlyMemoryPort(cwd);
		if (!memoryPort) {
			if (json) {
				stdout(formatJson([]));
			} else {
				stdout("No learnings found.");
			}
			return 0;
		}
		const learnings = memoryPort.fetchLearnings({
			scope: scope as string | undefined,
			kind: kind as string | undefined,
		});
		if (json) {
			stdout(formatJson(learnings));
		} else {
			for (const line of formatLearningsList(learnings)) {
				stdout(line);
			}
		}
		return 0;
	}
	if (subcommand === "inspect") {
		const subRest = rest.slice(1);
		const json = subRest.includes("--json");
		const id = subRest.find((v) => v !== "--json");
		if (!id) {
			const msg = "Missing required learning ID for memory inspect.";
			if (json) {
				stdout(formatJson(formatJsonError("MISSING_ARGUMENT", msg)));
			} else {
				stderr(msg);
			}
			return 1;
		}
		const memoryPort = await loadReadOnlyMemoryPort(cwd);
		if (!memoryPort) {
			const msg = `Learning not found: ${id}`;
			if (json) {
				stdout(formatJson(formatJsonError("NOT_FOUND", msg)));
			} else {
				stderr(msg);
			}
			return 1;
		}
		const learning = memoryPort.fetchLearningById(id);
		if (!learning) {
			const msg = `Learning not found: ${id}`;
			if (json) {
				stdout(formatJson(formatJsonError("NOT_FOUND", msg)));
			} else {
				stderr(msg);
			}
			return 1;
		}
		if (json) {
			stdout(formatJson(learning));
		} else {
			for (const line of formatLearningDetail(learning)) {
				stdout(line);
			}
		}
		return 0;
	}
	// Fall through to native for all other memory subcommands
	try {
		return await (deps?.runNativeCommand ?? runNativeCommand)(rest, {
			cwd,
			commandPath: ["memory"],
			stdout,
			stderr,
		});
	} catch (error) {
		throw createNativeDispatchError(["memory"], error);
	}
}
```

- [ ] **Step 10: Run tests to verify they pass**

Run: `cd /path/to/buildplane && pnpm vitest run apps/cli/test/run-cli.test.ts`
Expected: All tests PASS (existing + new)

- [ ] **Step 11: Commit**

```bash
cd /path/to/buildplane
git add apps/cli/src/run-cli.ts apps/cli/test/run-cli.test.ts
git commit -m "feat: add TS-native memory list and memory inspect commands"
```

---

### Task 4: Augment `inspect <run-id>` with learnings section

**Files:**
- Modify: `apps/cli/src/formatters.ts:165-233` (add optional learnings to `formatInspectDetail`)
- Modify: `apps/cli/src/run-cli.ts:789-822` (query learnings in inspect handler)
- Test: `apps/cli/test/formatters.test.ts`
- Test: `apps/cli/test/run-cli.test.ts`

- [ ] **Step 1: Write failing test for `formatInspectDetail` with learnings**

Add to `apps/cli/test/formatters.test.ts`:

```typescript
import { formatInspectDetail } from "../src/formatters.js";

describe("formatInspectDetail", () => {
	const baseSnapshot = {
		kind: "run",
		unit: { id: "implement-foo", kind: "command" },
		run: { id: "run-xyz", unitId: "implement-foo", status: "passed" },
		evidence: [],
		decisions: [],
		artifacts: [],
	};

	it("includes learnings section when learnings are provided", () => {
		const learnings = [
			{
				id: "abc-123",
				runId: "run-xyz",
				scope: "workspace",
				kind: "fact",
				title: "Verification gate passed",
				body: "All outputs verified",
				status: "active",
				createdAt: "2026-04-12T01:00:00Z",
				seenCount: 1,
			},
		];
		const lines = formatInspectDetail(baseSnapshot, [], learnings);
		expect(lines).toContainEqual(expect.stringContaining("learnings:"));
		expect(lines).toContainEqual(
			expect.stringContaining("[workspace/fact] Verification gate passed"),
		);
	});

	it("omits learnings section when no learnings provided", () => {
		const lines = formatInspectDetail(baseSnapshot, []);
		expect(lines.join("\n")).not.toContain("learnings:");
	});

	it("omits learnings section when empty array provided", () => {
		const lines = formatInspectDetail(baseSnapshot, [], []);
		expect(lines.join("\n")).not.toContain("learnings:");
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /path/to/buildplane && pnpm vitest run apps/cli/test/formatters.test.ts`
Expected: FAIL — `formatInspectDetail` doesn't accept a third argument (but won't error — it will fail the assertion about "learnings:")

- [ ] **Step 3: Update `formatInspectDetail` to accept optional learnings**

In `apps/cli/src/formatters.ts`, modify the `formatInspectDetail` function signature and add learnings rendering at the end:

Change the function signature from:

```typescript
export function formatInspectDetail(
	snapshot: InspectSnapshotLike,
	_events: ExecutionEventLike[],
): string[] {
```

To:

```typescript
export function formatInspectDetail(
	snapshot: InspectSnapshotLike,
	_events: ExecutionEventLike[],
	learnings?: readonly StoredLearningLike[],
): string[] {
```

Then, just before the `return lines;` at the end of the function, add:

```typescript
if (learnings && learnings.length > 0) {
	lines.push("");
	lines.push("learnings:");
	for (const l of learnings) {
		lines.push(
			`  [${l.scope}/${l.kind}] ${l.title} (seen: ${l.seenCount})`,
		);
	}
}
```

- [ ] **Step 4: Run formatter tests to verify they pass**

Run: `cd /path/to/buildplane && pnpm vitest run apps/cli/test/formatters.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Wire learnings query into the `inspect` CLI handler**

In `apps/cli/src/run-cli.ts`, find the `inspect` case (around line 789). The handler currently calls `orchestrator.inspect(id)` and then `formatInspectDetail(result, events)`. Add a learnings query between the event fetch and the format call.

Replace the section from `let events` through the `formatInspectDetail` call:

```typescript
case "inspect": {
	const json = rest.includes("--json");
	const id = rest.find((value) => value !== "--json");
	if (!id) {
		throw new Error("Missing required run or unit id for inspect.");
	}

	const result = orchestrator.inspect(id);

	if (json) {
		stdout(formatJson(result));
	} else {
		let events: Array<{
			kind: string;
			runId: string;
			timestamp: string;
			[key: string]: unknown;
		}> = [];
		try {
			const eventStore = await loadEventStore(cwd);
			events = eventStore.getEventsByRunId(
				result.run.id,
			) as typeof events;
		} catch {
			// Event store unavailable (e.g., uninitialized in tests)
		}

		// Query learnings produced by this run
		let runLearnings: Array<{
			id: string;
			runId: string;
			scope: string;
			kind: string;
			title: string;
			body: string;
			status: string;
			createdAt: string;
			seenCount: number;
		}> = [];
		try {
			const memoryPort = await loadReadOnlyMemoryPort(cwd);
			if (memoryPort) {
				runLearnings = [
					...memoryPort.fetchLearningsByRunId(result.run.id),
				];
			}
		} catch {
			// Memory port unavailable
		}

		for (const line of formatInspectDetail(
			result as unknown as Parameters<typeof formatInspectDetail>[0],
			events,
			runLearnings,
		)) {
			stdout(line);
		}
	}
	return 0;
}
```

- [ ] **Step 6: Run full CLI test suite**

Run: `cd /path/to/buildplane && pnpm vitest run apps/cli/test/run-cli.test.ts`
Expected: All tests PASS

- [ ] **Step 7: Commit**

```bash
cd /path/to/buildplane
git add apps/cli/src/formatters.ts apps/cli/test/formatters.test.ts apps/cli/src/run-cli.ts
git commit -m "feat: augment run inspector with learnings section"
```

---

### Task 5: Update help menu and run full test suite

**Files:**
- Modify: `apps/cli/src/run-cli.ts:44-67` (help menu)
- Test: `apps/cli/test/run-cli.test.ts` (help output test if one exists)

- [ ] **Step 1: Update the help menu**

In `apps/cli/src/run-cli.ts`, replace the `Project:` section in `formatTopLevelHelp()` (lines 60-64):

From:

```typescript
"  Project:",
"    init                   Initialize .buildplane in this repo",
"    memory <action>        Manage stored learnings",
"    pack show <id>         Inspect a pack",
```

To:

```typescript
"  Project:",
"    init                   Initialize .buildplane in this repo",
"    memory list            Show stored learnings",
"    memory inspect <id>    Detail for one learning",
"    memory <action>        Advanced memory operations (native)",
"    pack show <id>         Inspect a pack",
```

- [ ] **Step 2: Run the full test suite**

Run: `cd /path/to/buildplane && pnpm test`
Expected: All tests PASS, no regressions

- [ ] **Step 3: Verify manually with `buildplane demo` then `buildplane memory list`**

Run in sequence:
```bash
cd /path/to/buildplane && pnpm buildplane demo
cd /path/to/buildplane && pnpm buildplane memory list
```

Expected: `memory list` shows the learning produced by the demo run (verification-gate-win fact).

- [ ] **Step 4: Commit**

```bash
cd /path/to/buildplane
git add apps/cli/src/run-cli.ts
git commit -m "docs: update CLI help menu with memory list and inspect commands"
```
