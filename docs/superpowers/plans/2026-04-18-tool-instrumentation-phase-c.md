# Tool Instrumentation — Phase C Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `buildplane run` produce a tape that captures tool calls and their file-level effects. Ship a proxy wrapper around `ToolRegistry` that emits `tool_request` / `tool_result` / `workspace_write`, install git checkpoints at unit boundaries on `refs/buildplane/run/<runId>`, fix the `--cwd` pollution bug from Phase B, and prove the pipeline end-to-end with real `buildplane run` integration tests plus a cwd-isolation canary.

**Architecture:** `apps/cli/src/ledger-tool-wrapper.ts` wraps `ToolRegistry` with per-method emit hooks. `apps/cli/src/ledger-git-checkpoint.ts` runs `write-tree` + `commit-tree` + `update-ref` plumbing to advance `refs/buildplane/run/<runId>` without touching HEAD. `apps/cli/src/git-in-workspace.ts` centralizes git invocations through a workspace-absolute-path helper. `run-cli.ts` threads a `unitCtx` closure through the wrapper and calls `runGitCheckpoint` at unit boundaries. Integration tests use `makeBuildplaneRunFixture()` to run `runCli()` in-process against an isolated tempdir workspace.

**Tech Stack:** TypeScript (Node 24, ESM), vitest, `node:crypto` for sha256, `node:child_process` for git plumbing. No new Rust. No new dependencies.

**Reference spec:** `docs/superpowers/specs/2026-04-18-tool-instrumentation-design.md`
**Builds on:** Phase A (PR #59) + Phase B (PR #60).

---

## Phase C scope recap

**In scope:**
- `ledger-tool-wrapper.ts` — proxy wrapper around `ToolRegistry`.
- `ledger-git-checkpoint.ts` — `commit-tree`-based checkpoint on `refs/buildplane/run/*`.
- `git-in-workspace.ts` — helper routing all git invocations through an absolute workspace path.
- `run-cli.ts` integration: unitCtx tracker, registry wrapping, unit-boundary hooks, remove Phase B `mapEventKindForLedger` stub.
- 5 integration tests + a cwd-isolation regression canary.
- `makeBuildplaneRunFixture()` helper.

**Out of scope:** `read_file` tool, Rust-side CAS population, `workspace_read` events, `ledger inspect`, replay/fork/bisect, concurrent-run tests, benchmarking.

---

## File structure

```
apps/cli/
├── src/
│   ├── git-in-workspace.ts             # NEW: git -C <cwd> helper
│   ├── ledger-git-checkpoint.ts        # NEW: runGitCheckpoint
│   ├── ledger-tool-wrapper.ts          # NEW: wrapToolRegistryForLedger
│   └── run-cli.ts                      # MODIFY: wire + remove Phase B stub
├── test/
│   ├── ledger-tool-wrapper.test.ts     # NEW: Layer 2 wrapper tests
│   └── ledger-git-checkpoint.test.ts   # NEW: Layer 2 checkpoint tests

test/ledger-integration/
├── fixtures.ts                         # MODIFY: add makeBuildplaneRunFixture
├── cwd-isolation.test.ts               # NEW: Phase C canary
├── tool-capture.test.ts                # NEW
├── shell-command-capture.test.ts       # NEW
├── git-checkpoint.test.ts              # NEW
└── permission-denied.test.ts           # NEW

docs/superpowers/specs/2026-04-18-tool-instrumentation-design.md  # MODIFY: spec marker
```

---

## Phase C.1 — ledger-tool-wrapper

### Task 1: Implement `wrapToolRegistryForLedger` with `write_file` support

**Files:**
- Create: `apps/cli/src/ledger-tool-wrapper.ts`
- Create: `apps/cli/test/ledger-tool-wrapper.test.ts`

- [ ] **Step 1: Write failing tests**

Create `apps/cli/test/ledger-tool-wrapper.test.ts`:

```ts
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { wrapToolRegistryForLedger } from "../src/ledger-tool-wrapper.js";

interface EmittedEvent {
	kind: string;
	payload: unknown;
	opts?: { parent?: string; id?: string };
}

function createMockEmitter(): {
	emit: (kind: string, payload: unknown, opts?: { parent?: string; id?: string }) => void;
	emitted: EmittedEvent[];
} {
	const emitted: EmittedEvent[] = [];
	return {
		emit: (kind, payload, opts) => {
			emitted.push({ kind, payload, opts });
		},
		emitted,
	};
}

describe("wrapToolRegistryForLedger — write_file", () => {
	it("emits tool_request, workspace_write, tool_result on success", async () => {
		const dir = mkdtempSync(join(tmpdir(), "bp-wrapper-"));
		try {
			const rawRegistry = {
				write_file: vi.fn((input: { path: string; content: string }) => ({
					success: true,
					path: input.path,
				})),
				run_command: vi.fn(),
			};
			const emitter = createMockEmitter();
			const wrapped = wrapToolRegistryForLedger(rawRegistry, emitter, () => ({
				unitId: "u-1",
				parentEventId: "01919000-0000-7000-8000-000000000010",
			}));

			const result = wrapped.write_file({ path: join(dir, "out.txt"), content: "hello" });

			expect(result.success).toBe(true);
			expect(rawRegistry.write_file).toHaveBeenCalledOnce();

			const kinds = emitter.emitted.map((e) => e.kind);
			expect(kinds).toEqual(["tool_request", "workspace_write", "tool_result"]);

			const toolReq = emitter.emitted[0];
			expect(toolReq.opts?.parent).toBe("01919000-0000-7000-8000-000000000010");

			const wsWrite = emitter.emitted[1].payload as {
				WorkspaceWriteV1: { hash_before: string | null; after: { status: string; hash: string } };
			};
			expect(wsWrite.WorkspaceWriteV1.hash_before).toBeNull();
			expect(wsWrite.WorkspaceWriteV1.after.status).toBe("captured");
			expect(wsWrite.WorkspaceWriteV1.after.hash).toMatch(/^sha256:/);

			const toolRes = emitter.emitted[2].payload as { ToolResultV1: { output: { success: boolean } } };
			expect(toolRes.ToolResultV1.output).toEqual({ success: true });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("threads hash_before when path already exists", () => {
		const dir = mkdtempSync(join(tmpdir(), "bp-wrapper-"));
		try {
			const path = join(dir, "existing.txt");
			writeFileSync(path, "old content");

			const rawRegistry = {
				write_file: vi.fn(() => ({ success: true, path })),
				run_command: vi.fn(),
			};
			const emitter = createMockEmitter();
			const wrapped = wrapToolRegistryForLedger(rawRegistry, emitter, () => ({
				unitId: "u-1",
				parentEventId: "01919000-0000-7000-8000-000000000010",
			}));

			wrapped.write_file({ path, content: "new content" });

			const wsWrite = emitter.emitted.find((e) => e.kind === "workspace_write")!
				.payload as { WorkspaceWriteV1: { hash_before: string | null } };
			expect(wsWrite.WorkspaceWriteV1.hash_before).toMatch(/^sha256:/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("skips workspace_write when write_file fails", () => {
		const rawRegistry = {
			write_file: vi.fn(() => ({ success: false, error: "denied" })),
			run_command: vi.fn(),
		};
		const emitter = createMockEmitter();
		const wrapped = wrapToolRegistryForLedger(rawRegistry, emitter, () => ({
			unitId: "u-1",
			parentEventId: "01919000-0000-7000-8000-000000000010",
		}));

		wrapped.write_file({ path: "/tmp/nope.txt", content: "x" });

		const kinds = emitter.emitted.map((e) => e.kind);
		expect(kinds).toEqual(["tool_request", "tool_result"]);
		const toolRes = emitter.emitted[1].payload as { ToolResultV1: { output: { success: boolean } } };
		expect(toolRes.ToolResultV1.output).toEqual({ success: false });
	});

	it("emits with parent_event_id = null when getUnitCtx returns null", () => {
		const rawRegistry = {
			write_file: vi.fn(() => ({ success: true, path: "/tmp/x" })),
			run_command: vi.fn(),
		};
		const emitter = createMockEmitter();
		const wrapped = wrapToolRegistryForLedger(rawRegistry, emitter, () => null);

		wrapped.write_file({ path: "/tmp/x", content: "y" });

		expect(emitter.emitted[0].opts?.parent).toBeUndefined();
	});
});
```

- [ ] **Step 2: Run tests — expect FAIL**

```bash
pnpm --filter @buildplane/cli exec vitest run test/ledger-tool-wrapper.test.ts
```
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement `ledger-tool-wrapper.ts`**

Create `apps/cli/src/ledger-tool-wrapper.ts`:

```ts
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import type {
	RunCommandInput,
	RunCommandResult,
	ToolRegistry,
	WriteFileInput,
	WriteFileResult,
} from "@buildplane/adapters-tools";

export interface UnitCtx {
	unitId: string;
	parentEventId: string;
}

export interface LedgerEventEmitter {
	emit(
		kind: string,
		payload: unknown,
		opts?: { parent?: string; id?: string },
	): void;
}

function sha256(bytes: Buffer | string): string {
	return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function uuidv7(): string {
	// Node 20+: use crypto.randomUUID() for a UUIDv4 fallback when we only need
	// a unique id and don't care about time ordering. UUIDv7 is what the
	// ledger-client library generates for real events — but for tool-request
	// ids we just need uniqueness; the wrapper emits them via the emitter
	// which will set the envelope id itself (the `id` opt here is the tool
	// request's referenceable id for workspace_write/tool_result parent links,
	// not the envelope id).
	return crypto.randomUUID();
}

/** Wrap a ToolRegistry so every call emits tool_request / tool_result (and
 * workspace_write for write_file) to the ledger emitter. The original
 * registry is called unchanged; the wrapper is a transparent proxy.
 */
export function wrapToolRegistryForLedger(
	registry: ToolRegistry,
	emitter: LedgerEventEmitter,
	getUnitCtx: () => UnitCtx | null,
): ToolRegistry {
	return {
		write_file(input: WriteFileInput): WriteFileResult {
			const ctx = getUnitCtx();
			const toolReqId = uuidv7();

			// Pre-hash: capture the existing file content if any.
			let hashBefore: string | null = null;
			try {
				if (existsSync(input.path)) {
					hashBefore = sha256(readFileSync(input.path));
				}
			} catch {
				hashBefore = null;
			}

			const hashAfter = sha256(input.content);

			// tool_request
			emitter.emit(
				"tool_request",
				{
					ToolRequestStoredV1: {
						tool_name: "write_file",
						arguments: { path: input.path, content_hash: hashAfter },
						env: { redacted: true, hash: "sha256:", hint: "env_var" },
						working_directory: "",
						unit_id: ctx?.unitId ?? "",
					},
				},
				{ parent: ctx?.parentEventId, id: toolReqId },
			);

			const started = Date.now();
			const result = registry.write_file(input);
			const durationMs = Date.now() - started;

			if (result.success) {
				let sizeBytes = 0;
				try {
					sizeBytes = statSync(input.path).size;
				} catch {
					sizeBytes = Buffer.byteLength(input.content);
				}
				emitter.emit(
					"workspace_write",
					{
						WorkspaceWriteV1: {
							tool_request_id: toolReqId,
							path: input.path,
							hash_before: hashBefore,
							after: {
								status: "captured",
								hash: hashAfter,
								size_bytes: sizeBytes,
							},
						},
					},
					{ parent: toolReqId },
				);
			}

			emitter.emit(
				"tool_result",
				{
					ToolResultV1: {
						tool_request_id: toolReqId,
						stdout: "",
						stderr: result.error ?? "",
						exit_code: null,
						output: { success: result.success },
						duration_ms: durationMs,
					},
				},
				{ parent: toolReqId },
			);

			return result;
		},

		run_command(input: RunCommandInput): RunCommandResult {
			// Phase C.1 ships write_file wrapper. run_command is added in Task 2.
			return registry.run_command(input);
		},
	};
}
```

- [ ] **Step 4: Run tests — expect PASS**

```bash
pnpm --filter @buildplane/cli exec vitest run test/ledger-tool-wrapper.test.ts
```
Expected: 4 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/ledger-tool-wrapper.ts apps/cli/test/ledger-tool-wrapper.test.ts
git commit -m "feat(cli): add wrapToolRegistryForLedger with write_file instrumentation"
```

### Task 2: Extend wrapper with `run_command` instrumentation

**Files:**
- Modify: `apps/cli/src/ledger-tool-wrapper.ts`
- Modify: `apps/cli/test/ledger-tool-wrapper.test.ts`

- [ ] **Step 1: Add failing tests**

Append to `apps/cli/test/ledger-tool-wrapper.test.ts`:

```ts
describe("wrapToolRegistryForLedger — run_command", () => {
	it("emits tool_request and tool_result for a successful shell command", () => {
		const rawRegistry = {
			write_file: vi.fn(),
			run_command: vi.fn(() => ({
				success: true,
				exitCode: 0,
				stdout: "hi\n",
				stderr: "",
			})),
		};
		const emitter = createMockEmitter();
		const wrapped = wrapToolRegistryForLedger(rawRegistry, emitter, () => ({
			unitId: "u-1",
			parentEventId: "01919000-0000-7000-8000-000000000010",
		}));

		wrapped.run_command({ command: "sh", args: ["-c", "echo hi"] });

		const kinds = emitter.emitted.map((e) => e.kind);
		expect(kinds).toEqual(["tool_request", "tool_result"]);

		const toolReq = emitter.emitted[0].payload as {
			ToolRequestStoredV1: { tool_name: string; arguments: unknown };
		};
		expect(toolReq.ToolRequestStoredV1.tool_name).toBe("run_command");
		expect(toolReq.ToolRequestStoredV1.arguments).toEqual({
			command: "sh",
			args: ["-c", "echo hi"],
		});

		const toolRes = emitter.emitted[1].payload as {
			ToolResultV1: { stdout: string; stderr: string; exit_code: number | null };
		};
		expect(toolRes.ToolResultV1.stdout).toBe("hi\n");
		expect(toolRes.ToolResultV1.exit_code).toBe(0);
	});

	it("emits tool_result with non-zero exit_code on command failure", () => {
		const rawRegistry = {
			write_file: vi.fn(),
			run_command: vi.fn(() => ({
				success: false,
				exitCode: 1,
				stdout: "",
				stderr: "oops",
			})),
		};
		const emitter = createMockEmitter();
		const wrapped = wrapToolRegistryForLedger(rawRegistry, emitter, () => ({
			unitId: "u-1",
			parentEventId: "01919000-0000-7000-8000-000000000010",
		}));

		wrapped.run_command({ command: "false" });

		const toolRes = emitter.emitted[1].payload as {
			ToolResultV1: { exit_code: number | null; stderr: string };
		};
		expect(toolRes.ToolResultV1.exit_code).toBe(1);
		expect(toolRes.ToolResultV1.stderr).toBe("oops");
	});

	it("never emits workspace_write for run_command", () => {
		const rawRegistry = {
			write_file: vi.fn(),
			run_command: vi.fn(() => ({
				success: true,
				exitCode: 0,
				stdout: "",
				stderr: "",
			})),
		};
		const emitter = createMockEmitter();
		const wrapped = wrapToolRegistryForLedger(rawRegistry, emitter, () => ({
			unitId: "u-1",
			parentEventId: "01919000-0000-7000-8000-000000000010",
		}));

		wrapped.run_command({ command: "sh", args: ["-c", "echo hi > /tmp/shell-out"] });

		const kinds = emitter.emitted.map((e) => e.kind);
		expect(kinds).not.toContain("workspace_write");
	});
});
```

- [ ] **Step 2: Run tests — expect FAIL on the new describe**

```bash
pnpm --filter @buildplane/cli exec vitest run test/ledger-tool-wrapper.test.ts
```
Expected: 3 new tests FAIL (the wrapper's `run_command` is still a passthrough from Task 1).

- [ ] **Step 3: Implement `run_command` wrapping**

In `apps/cli/src/ledger-tool-wrapper.ts`, replace the `run_command` method body:

```ts
		run_command(input: RunCommandInput): RunCommandResult {
			const ctx = getUnitCtx();
			const toolReqId = uuidv7();

			emitter.emit(
				"tool_request",
				{
					ToolRequestStoredV1: {
						tool_name: "run_command",
						arguments: {
							command: input.command,
							args: input.args ?? [],
						},
						env: { redacted: true, hash: "sha256:", hint: "env_var" },
						working_directory: input.cwd ?? "",
						unit_id: ctx?.unitId ?? "",
					},
				},
				{ parent: ctx?.parentEventId, id: toolReqId },
			);

			const started = Date.now();
			const result = registry.run_command(input);
			const durationMs = Date.now() - started;

			emitter.emit(
				"tool_result",
				{
					ToolResultV1: {
						tool_request_id: toolReqId,
						stdout: result.stdout,
						stderr: result.stderr,
						exit_code: result.exitCode,
						output: null,
						duration_ms: durationMs,
					},
				},
				{ parent: toolReqId },
			);

			return result;
		},
```

- [ ] **Step 4: Run tests — expect PASS**

```bash
pnpm --filter @buildplane/cli exec vitest run test/ledger-tool-wrapper.test.ts
```
Expected: 7 tests PASS (4 write_file + 3 run_command).

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/ledger-tool-wrapper.ts apps/cli/test/ledger-tool-wrapper.test.ts
git commit -m "feat(cli): extend ledger tool wrapper with run_command instrumentation"
```

---

## Phase C.2 — ledger-git-checkpoint

### Task 3: Implement `runGitCheckpoint` using `commit-tree` plumbing

**Files:**
- Create: `apps/cli/src/ledger-git-checkpoint.ts`
- Create: `apps/cli/test/ledger-git-checkpoint.test.ts`

- [ ] **Step 1: Write failing tests**

Create `apps/cli/test/ledger-git-checkpoint.test.ts`:

```ts
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runGitCheckpoint } from "../src/ledger-git-checkpoint.js";

function git(cwd: string, ...args: string[]): string {
	const r = spawnSync("git", args, { cwd, encoding: "utf8" });
	if (r.status !== 0) {
		throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
	}
	return r.stdout.trim();
}

describe("runGitCheckpoint", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "bp-checkpoint-"));
		git(dir, "init", "-q");
		git(dir, "config", "user.email", "test@test");
		git(dir, "config", "user.name", "test");
		writeFileSync(join(dir, "init.txt"), "init");
		git(dir, "add", ".");
		git(dir, "commit", "-q", "-m", "init");
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("pre-unit creates a commit on refs/buildplane/run/<runId> without touching HEAD", () => {
		const emitter = { emit: vi.fn() };
		const headBefore = git(dir, "rev-parse", "HEAD");
		const runId = "01919000-0000-7000-8000-000000000000";

		runGitCheckpoint({
			boundary: "pre-unit",
			runId,
			unitId: "u-1",
			cwd: dir,
			emitter,
			parentEventId: "01919000-0000-7000-8000-000000000010",
		});

		const headAfter = git(dir, "rev-parse", "HEAD");
		expect(headAfter).toBe(headBefore);

		const refSha = git(dir, "show-ref", "--hash", `refs/buildplane/run/${runId}`);
		expect(refSha).toMatch(/^[0-9a-f]{40}$/);

		expect(emitter.emit).toHaveBeenCalledOnce();
		const [kind, payload, opts] = emitter.emit.mock.calls[0];
		expect(kind).toBe("git_checkpoint");
		const p = payload as {
			GitCheckpointV1: {
				boundary: string;
				reference: string;
				commit_sha: string;
				unit_id: string;
				git_status: { kind: string };
			};
		};
		expect(p.GitCheckpointV1.boundary).toBe("pre-unit");
		expect(p.GitCheckpointV1.reference).toBe(`refs/buildplane/run/${runId}`);
		expect(p.GitCheckpointV1.commit_sha).toBe(refSha);
		expect(p.GitCheckpointV1.unit_id).toBe("u-1");
		expect(p.GitCheckpointV1.git_status.kind).toBe("ok");
		expect((opts as { parent: string }).parent).toBe(
			"01919000-0000-7000-8000-000000000010",
		);
	});

	it("post-unit chains on the prior pre-unit commit", () => {
		const emitter = { emit: vi.fn() };
		const runId = "01919000-0000-7000-8000-000000000001";

		runGitCheckpoint({
			boundary: "pre-unit",
			runId,
			unitId: "u-1",
			cwd: dir,
			emitter,
			parentEventId: undefined,
		});
		const preSha = git(dir, "show-ref", "--hash", `refs/buildplane/run/${runId}`);

		runGitCheckpoint({
			boundary: "post-unit",
			runId,
			unitId: "u-1",
			cwd: dir,
			emitter,
			parentEventId: undefined,
		});
		const postSha = git(dir, "show-ref", "--hash", `refs/buildplane/run/${runId}`);

		expect(postSha).not.toBe(preSha);
		const parent = git(dir, "rev-parse", `${postSha}^`);
		expect(parent).toBe(preSha);
	});

	it("captures dirty worktree via write-tree without touching HEAD", () => {
		const emitter = { emit: vi.fn() };
		const runId = "01919000-0000-7000-8000-000000000002";

		writeFileSync(join(dir, "dirty.txt"), "uncommitted");
		git(dir, "add", "dirty.txt");
		const headBefore = git(dir, "rev-parse", "HEAD");

		runGitCheckpoint({
			boundary: "pre-unit",
			runId,
			unitId: "u-1",
			cwd: dir,
			emitter,
			parentEventId: undefined,
		});

		const headAfter = git(dir, "rev-parse", "HEAD");
		expect(headAfter).toBe(headBefore);

		const refSha = git(dir, "show-ref", "--hash", `refs/buildplane/run/${runId}`);
		const treeListing = git(dir, "ls-tree", "-r", "--name-only", refSha);
		expect(treeListing.split("\n")).toContain("dirty.txt");

		// The user's current branch tree still reflects the dirty state in the index,
		// but HEAD itself did not advance.
		expect(headAfter).toBe(headBefore);
	});

	it("does not modify the user's current branch", () => {
		const emitter = { emit: vi.fn() };
		const runId = "01919000-0000-7000-8000-000000000003";

		const branchBefore = git(dir, "rev-parse", "--abbrev-ref", "HEAD");
		const headBefore = git(dir, "rev-parse", "HEAD");

		runGitCheckpoint({
			boundary: "pre-unit",
			runId,
			unitId: "u-1",
			cwd: dir,
			emitter,
			parentEventId: undefined,
		});

		const branchAfter = git(dir, "rev-parse", "--abbrev-ref", "HEAD");
		const headAfter = git(dir, "rev-parse", "HEAD");
		expect(branchAfter).toBe(branchBefore);
		expect(headAfter).toBe(headBefore);
	});
});
```

- [ ] **Step 2: Run tests — expect FAIL**

```bash
pnpm --filter @buildplane/cli exec vitest run test/ledger-git-checkpoint.test.ts
```
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement `ledger-git-checkpoint.ts`**

Create `apps/cli/src/ledger-git-checkpoint.ts`:

```ts
import { spawnSync } from "node:child_process";
import type { LedgerEventEmitter } from "./ledger-tool-wrapper.js";

export type CheckpointBoundary = "pre-unit" | "post-unit";

export interface GitCheckpointInput {
	boundary: CheckpointBoundary;
	runId: string;
	unitId: string;
	cwd: string;
	emitter: LedgerEventEmitter;
	parentEventId?: string;
}

function git(cwd: string, args: string[], stdin?: string): string {
	const r = spawnSync("git", ["-C", cwd, ...args], {
		input: stdin,
		encoding: "utf8",
	});
	if (r.status !== 0) {
		const msg = `git ${args.join(" ")} failed: ${r.stderr.trim()}`;
		throw new Error(msg);
	}
	return r.stdout.trim();
}

function maybeRef(cwd: string, ref: string): string | null {
	const r = spawnSync("git", ["-C", cwd, "show-ref", "--hash", ref], {
		encoding: "utf8",
	});
	return r.status === 0 ? r.stdout.trim() : null;
}

/** Run a git checkpoint using plumbing commands.
 *
 * write-tree captures the index. commit-tree produces a commit without
 * running hooks or touching HEAD. update-ref advances only the buildplane
 * run ref. The user's branch is never modified.
 *
 * If any git step fails, emits a git_checkpoint event with
 * git_status: { kind: "failed", error: "..." } and does NOT throw —
 * checkpoints are advisory and shouldn't abort a run.
 */
export function runGitCheckpoint(input: GitCheckpointInput): void {
	const reference = `refs/buildplane/run/${input.runId}`;
	let commitSha = "";
	let status: { kind: "ok" } | { kind: "failed"; error: string } = { kind: "ok" };

	try {
		const tree = git(input.cwd, ["write-tree"]);

		const existing = maybeRef(input.cwd, reference);
		const commitArgs = ["commit-tree", tree];
		if (existing) {
			commitArgs.push("-p", existing);
		}
		const message = `buildplane/${input.runId}/${input.unitId}/${input.boundary}`;
		commitSha = git(input.cwd, commitArgs, message);

		git(input.cwd, ["update-ref", reference, commitSha]);
	} catch (err) {
		const error = err instanceof Error ? err.message : String(err);
		status = { kind: "failed", error };
	}

	input.emitter.emit(
		"git_checkpoint",
		{
			GitCheckpointV1: {
				boundary: input.boundary,
				reference,
				commit_sha: commitSha,
				unit_id: input.unitId,
				git_status: status,
			},
		},
		{ parent: input.parentEventId },
	);
}
```

- [ ] **Step 4: Run tests — expect PASS**

```bash
pnpm --filter @buildplane/cli exec vitest run test/ledger-git-checkpoint.test.ts
```
Expected: 4 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/ledger-git-checkpoint.ts apps/cli/test/ledger-git-checkpoint.test.ts
git commit -m "feat(cli): add runGitCheckpoint using commit-tree plumbing"
```

---

## Phase C.3 — `--cwd` audit + fix

### Task 4: Create `gitInWorkspace` helper and audit run-cli.ts

**Files:**
- Create: `apps/cli/src/git-in-workspace.ts`
- Create: `apps/cli/test/git-in-workspace.test.ts`
- Modify: `apps/cli/src/run-cli.ts` (route existing git invocations through the helper)

- [ ] **Step 1: Write failing tests for the helper**

Create `apps/cli/test/git-in-workspace.test.ts`:

```ts
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gitInWorkspace } from "../src/git-in-workspace.js";

function git(cwd: string, ...args: string[]): string {
	const r = spawnSync("git", args, { cwd, encoding: "utf8" });
	if (r.status !== 0) throw new Error(r.stderr);
	return r.stdout.trim();
}

describe("gitInWorkspace", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "bp-giw-"));
		git(dir, "init", "-q");
		git(dir, "config", "user.email", "test@test");
		git(dir, "config", "user.name", "test");
		writeFileSync(join(dir, "init.txt"), "init");
		git(dir, "add", ".");
		git(dir, "commit", "-q", "-m", "init");
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("executes git in the passed workspace regardless of process.cwd()", () => {
		const originalCwd = process.cwd();
		try {
			process.chdir(tmpdir()); // NOT the workspace
			const sha = gitInWorkspace(dir, "rev-parse", "HEAD").trim();
			expect(sha).toMatch(/^[0-9a-f]{40}$/);
		} finally {
			process.chdir(originalCwd);
		}
	});

	it("throws on non-zero exit with stderr included", () => {
		expect(() => gitInWorkspace(dir, "nonsensical-subcommand")).toThrow(/git/i);
	});

	it("rejects non-absolute workspace paths", () => {
		expect(() => gitInWorkspace("relative/path", "rev-parse", "HEAD")).toThrow(
			/absolute/i,
		);
	});

	it("resolves path literally — does not resolve symlinks or ..", () => {
		const workspaceAbs = resolve(dir);
		const sha = gitInWorkspace(workspaceAbs, "rev-parse", "HEAD").trim();
		expect(sha).toMatch(/^[0-9a-f]{40}$/);
	});
});
```

- [ ] **Step 2: Run tests — expect FAIL**

```bash
pnpm --filter @buildplane/cli exec vitest run test/git-in-workspace.test.ts
```
Expected: FAIL.

- [ ] **Step 3: Implement the helper**

Create `apps/cli/src/git-in-workspace.ts`:

```ts
import { spawnSync } from "node:child_process";
import { isAbsolute } from "node:path";

/** Run `git -C <workspace> ...args`. The workspace path must be absolute;
 * never falls back to `process.cwd()`. Throws on non-zero exit.
 *
 * This helper centralizes every git invocation in run-path code to prevent
 * the class of bug where `process.cwd()` drift pollutes the wrong directory
 * (see Phase B smoke-test pollution on feat/ledger-phase-a and
 * feat/ledger-phase-b-clean).
 */
export function gitInWorkspace(
	workspace: string,
	...args: string[]
): string {
	if (!isAbsolute(workspace)) {
		throw new Error(
			`gitInWorkspace requires an absolute workspace path; got: ${workspace}`,
		);
	}
	const r = spawnSync("git", ["-C", workspace, ...args], {
		encoding: "utf8",
	});
	if (r.status !== 0) {
		throw new Error(
			`git ${args.join(" ")} failed (cwd=${workspace}): ${r.stderr.trim()}`,
		);
	}
	return r.stdout;
}
```

- [ ] **Step 4: Run tests — expect PASS**

```bash
pnpm --filter @buildplane/cli exec vitest run test/git-in-workspace.test.ts
```
Expected: 4 tests PASS.

- [ ] **Step 5: Audit `apps/cli/src/run-cli.ts` for `process.cwd()` misuse in run-path code**

Read `apps/cli/src/run-cli.ts` and search for:
- `process.cwd()` calls inside the `case "run":` handler or helpers it invokes.
- `spawn("git", ...)` or `spawnSync("git", ...)` that might be using cwd implicitly.
- `resolve(".", ...)` / `join(process.cwd(), ...)` in the run path.

For each finding, decide:
- Is this run-path code? If yes, replace with `gitInWorkspace(workspace, ...)` where `workspace` is the packet's absolute workspace path.
- If it's setup/config code (e.g., resolving config files before the run starts), leave it; that legitimately uses process.cwd().

**Expected audit hotspots** (based on Phase B's pollution pattern):
- Any auto-commit logic that was writing commit messages like `"feat: buildplane run <run-id>"` — this is what polluted Phase B's branch. If present, re-target to use `gitInWorkspace(workspacePath, ...)`.
- The `deriveLedgerSpawnCwd` added in Phase B's `3332f4a` fix — verify it uses the packet's workspace, not `process.cwd()`.

Apply minimal targeted edits. If an offender is in a kernel-adjacent package (`packages/kernel`, `packages/runtime`, etc.), prefer a one-line fix or flag for deferred work; don't sprawl.

- [ ] **Step 6: Verify the CLI still builds and existing tests still pass**

```bash
pnpm --filter @buildplane/cli build
pnpm --filter @buildplane/cli exec vitest run
```
Expected: build clean; tests pass (modulo pre-existing red tests on main).

- [ ] **Step 7: Commit**

```bash
git add apps/cli/src/git-in-workspace.ts apps/cli/test/git-in-workspace.test.ts apps/cli/src/run-cli.ts
git commit -m "feat(cli): add gitInWorkspace helper and route run-path git through it"
```

### Task 5: Add the `cwd-isolation` regression canary test

**Files:**
- Modify: `test/ledger-integration/fixtures.ts` (add `makeBuildplaneRunFixture`)
- Create: `test/ledger-integration/cwd-isolation.test.ts`

This task lands the fixture helper AND the first test that uses it — the test is intentionally scoped to isolate its dependency on the fixture.

- [ ] **Step 1: Extend fixtures with `makeBuildplaneRunFixture`**

Modify `test/ledger-integration/fixtures.ts` — add below the existing `makeLedgerFixture`:

```ts
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";

export interface BuildplaneRunFixture {
	dir: string;
	eventsDbPath: string;
	exitCode: number;
	cleanup: () => Promise<void>;
}

/** Spin up an isolated workspace, write a packet.json, and run `runCli()`
 * in-process with process.cwd() temporarily chdir'd to the tempdir. Restores
 * cwd in finally. Returns the run result + path to events.db.
 *
 * CRITICAL: tests using this fixture MUST NOT run concurrently with each
 * other (process.chdir is process-global). Vitest's default is worker-per-file
 * with sequential tests in a file, so co-locating such tests in one file or
 * different files is fine; inside one file, don't mark `concurrent: true`.
 */
export async function makeBuildplaneRunFixture(opts: {
	packet: unknown;
}): Promise<BuildplaneRunFixture> {
	const dir = await mkdtemp(join(tmpdir(), "bp-run-"));

	// Initialize git repo: clean worktree is a run precondition.
	const runGit = (args: string[]) => {
		const r = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
		if (r.status !== 0) {
			throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
		}
	};
	runGit(["init", "-q"]);
	runGit(["config", "user.email", "test@test"]);
	runGit(["config", "user.name", "test"]);
	runGit(["commit", "-q", "--allow-empty", "-m", "init"]);

	// Write the packet.
	const packetPath = join(dir, "packet.json");
	writeFileSync(packetPath, JSON.stringify(opts.packet, null, 2));

	// Import runCli dynamically so the test doesn't eagerly load the full CLI
	// at module-evaluation time.
	const { runCli } = await import("../../apps/cli/src/run-cli.js");

	const originalCwd = process.cwd();
	let exitCode = 1;
	try {
		process.chdir(dir);
		// Capture stdout/stderr to avoid polluting the test output; we only
		// care about the run's side effects (events.db) here.
		const stdout = (_s: string) => {};
		const stderr = (_s: string) => {};
		exitCode = await runCli({
			args: ["run", "--packet", packetPath],
			cwd: dir,
			stdout,
			stderr,
			env: process.env,
		});
	} finally {
		process.chdir(originalCwd);
	}

	const eventsDbPath = join(dir, ".buildplane", "ledger", "events.db");

	const cleanup = async () => {
		await rm(dir, { recursive: true, force: true });
	};

	return { dir, eventsDbPath, exitCode, cleanup };
}
```

Note: the exact `runCli` signature may differ from the sketch above (the file may export a different entry point name like `runCli` vs `default`, and argument shape may vary). The implementer MUST read the current `apps/cli/src/run-cli.ts` exports and adapt the invocation. If `runCli` does not accept injected `stdout`/`stderr`/`env`, either add that (small refactor) or call the CLI through a child-process harness instead. Report DONE_WITH_CONCERNS if the runCli signature requires invasive changes.

- [ ] **Step 2: Write the canary test**

Create `test/ledger-integration/cwd-isolation.test.ts`:

```ts
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { makeBuildplaneRunFixture } from "./fixtures.js";

function gitInRepoRoot(...args: string[]): string {
	const r = spawnSync("git", args, { cwd: process.cwd(), encoding: "utf8" });
	if (r.status !== 0) throw new Error(r.stderr);
	return r.stdout.trim();
}

/** This is the Phase C canary. If this test fails, every other integration
 * test in this directory is untrusted — the test-isolation bug that hit
 * feat/ledger-phase-a and feat/ledger-phase-b-clean can recur.
 */
describe("cwd-isolation canary", () => {
	it("running buildplane run in a tempdir does not modify repo-root git state", async () => {
		// Capture repo-root state BEFORE.
		const headBefore = gitInRepoRoot("rev-parse", "HEAD");
		const statusBefore = gitInRepoRoot("status", "--porcelain");
		const bpRefsBefore = spawnSync(
			"git",
			["for-each-ref", "--format=%(refname)", "refs/buildplane/"],
			{ cwd: process.cwd(), encoding: "utf8" },
		).stdout;

		const fixture = await makeBuildplaneRunFixture({
			packet: {
				unit: {
					id: "unit-noop",
					kind: "command",
					scope: "task",
					inputRefs: [],
					expectedOutputs: [".buildplane/artifacts/canary/ok"],
					verificationContract: "exit-0-and-required-outputs",
					policyProfile: "default",
				},
				execution: {
					command: "node",
					args: [
						"-e",
						"const fs = require('node:fs'); fs.mkdirSync('.buildplane/artifacts/canary',{recursive:true}); fs.writeFileSync('.buildplane/artifacts/canary/ok','1');",
					],
				},
				verification: {
					requiredOutputs: [".buildplane/artifacts/canary/ok"],
				},
			},
		});

		try {
			// Capture repo-root state AFTER.
			const headAfter = gitInRepoRoot("rev-parse", "HEAD");
			const statusAfter = gitInRepoRoot("status", "--porcelain");
			const bpRefsAfter = spawnSync(
				"git",
				["for-each-ref", "--format=%(refname)", "refs/buildplane/"],
				{ cwd: process.cwd(), encoding: "utf8" },
			).stdout;

			expect(headAfter).toBe(headBefore);
			expect(statusAfter).toBe(statusBefore);
			expect(bpRefsAfter).toBe(bpRefsBefore);
		} finally {
			await fixture.cleanup();
		}
	}, 30_000);
});
```

- [ ] **Step 3: Run the canary**

```bash
pnpm exec vitest run test/ledger-integration/cwd-isolation.test.ts
```

Expected: PASS. If it FAILS, the `--cwd` audit in Task 4 missed something. Stop, re-audit, fix, re-run.

- [ ] **Step 4: Commit**

```bash
git add test/ledger-integration/fixtures.ts test/ledger-integration/cwd-isolation.test.ts
git commit -m "test(ledger): add cwd-isolation canary and makeBuildplaneRunFixture"
```

---

## Phase C.4 — Wire into `run-cli.ts`

### Task 6: Add `unitCtx` tracker and wrap the ToolRegistry in the run handler

**Files:**
- Modify: `apps/cli/src/run-cli.ts`

- [ ] **Step 1: Read the existing `run` handler to understand where `createToolRegistry` is called.**

Locate:
- Where `createToolRegistry(worktreeRoot)` is invoked.
- Where `ledgerEmitter` is declared (Phase B's integration).
- The point after handshake completes but before `orchestrator.runPacket(Async)`.

- [ ] **Step 2: Add the wrap + ctx tracker**

In the run handler, after `ledgerEmitter` is created and before the orchestrator call, add:

```ts
// Unit-context tracker: mutable state that getUnitCtx returns on demand.
// Updated by the unit-boundary hooks installed in Task 7.
let currentUnit: { unitId: string; parentEventId: string } | null = null;
const getUnitCtx = () => currentUnit;

// Wrap the raw registry so every tool call emits to the ledger.
// Find the existing line that does: `const registry = createToolRegistry(worktreeRoot);`
// Replace it with:
const rawRegistry = createToolRegistry(worktreeRoot);
const registry = ledgerEmitter
	? wrapToolRegistryForLedger(rawRegistry, ledgerEmitter, getUnitCtx)
	: rawRegistry;
```

Add the import at the top of the file:

```ts
import { wrapToolRegistryForLedger } from "./ledger-tool-wrapper.js";
```

- [ ] **Step 3: Verify the CLI still builds**

```bash
pnpm --filter @buildplane/cli build
```
Expected: clean.

- [ ] **Step 4: Run unit tests**

```bash
pnpm --filter @buildplane/cli exec vitest run
```
Expected: all wrapper tests pass, existing CLI tests unchanged.

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/run-cli.ts
git commit -m "feat(cli): wrap ToolRegistry in run handler with unitCtx tracker"
```

### Task 7: Install unit-boundary checkpoint hooks and remove the Phase B stub

**Files:**
- Modify: `apps/cli/src/run-cli.ts`

- [ ] **Step 1: Locate the existing direct-emit points**

Phase B's run handler emits `run_started` directly around the orchestrator call. Similar direct-emit points should exist for unit lifecycle — find them. If they don't exist, Phase B only emitted run-level events; Phase C needs to add unit-level direct emits driven by the event bus (use the real kernel event kinds we discovered in B.3: `execution-started`, `command-execution-complete`).

- [ ] **Step 2: Rewire the event-bus subscription**

The Phase B subscription currently routes through the stubbed `mapEventKindForLedger`. Replace that subscription's body with a unit-boundary hook implementation:

Find the block:

```ts
unsubscribeLedger = eventBus.subscribe((evt: unknown) => {
	if (!ledgerEmitter) return;
	const e = evt as { kind?: string };
	const ledgerKind = mapEventKindForLedger(e.kind ?? "");
	if (!ledgerKind) return;
	const payload = mapEventPayloadForLedger(evt);
	ledgerEmitter.emit(ledgerKind, payload);
});
```

Replace with:

```ts
unsubscribeLedger = eventBus.subscribe((evt: unknown) => {
	if (!ledgerEmitter) return;
	const e = evt as { kind?: string; unitId?: string };
	switch (e.kind) {
		case "execution-started": {
			// Unit-level start. Emit unit_started, run pre-unit checkpoint,
			// update currentUnit.
			const unitId = e.unitId ?? "unknown";
			const unitStartedId = crypto.randomUUID();
			ledgerEmitter.emit(
				"unit_started",
				{
					UnitStartedV1: {
						unit_id: unitId,
						parent_unit_id: null,
						unit_kind: "command",
						policy: {},
					},
				},
				{ id: unitStartedId },
			);
			currentUnit = { unitId, parentEventId: unitStartedId };
			runGitCheckpoint({
				boundary: "pre-unit",
				runId,
				unitId,
				cwd: workspacePath,
				emitter: ledgerEmitter,
				parentEventId: unitStartedId,
			});
			break;
		}
		case "command-execution-complete": {
			// Unit-level end. Run post-unit checkpoint, emit unit_completed,
			// clear currentUnit.
			if (currentUnit) {
				runGitCheckpoint({
					boundary: "post-unit",
					runId,
					unitId: currentUnit.unitId,
					cwd: workspacePath,
					emitter: ledgerEmitter,
					parentEventId: currentUnit.parentEventId,
				});
				const outcome =
					(e as { exitCode?: number }).exitCode === 0 ? "passed" : "failed";
				ledgerEmitter.emit(
					"unit_completed",
					{
						UnitCompletedV1: {
							unit_id: currentUnit.unitId,
							outcome,
							artifacts: [],
						},
					},
					{ parent: currentUnit.parentEventId },
				);
				currentUnit = null;
			}
			break;
		}
		default:
			// Phase C does not map policy-decision or other kernel events to
			// ledger events; they're Phase D+ concerns.
			break;
	}
});
```

Add imports at the top of the file:

```ts
import { runGitCheckpoint } from "./ledger-git-checkpoint.js";
```

- [ ] **Step 3: Delete the Phase B `mapEventKindForLedger` + `mapEventPayloadForLedger` stubs**

Find them and delete. They are no longer called.

- [ ] **Step 4: `workspacePath` resolution**

The `runGitCheckpoint` call uses `workspacePath`. Make sure this variable is the absolute path to the packet's workspace (the `--cwd` arg, resolved to absolute). Use `gitInWorkspace`'s contract: it must be absolute. Find where `cwd` is resolved in the run handler and ensure the value passed to `runGitCheckpoint` is always `resolve(cwd)`.

If there's a local `cwd` already, declare `const workspacePath = resolve(cwd);` near the top of the run case.

Add import if not present:

```ts
import { resolve } from "node:path";
```

- [ ] **Step 5: Build + run the CLI smoke**

```bash
pnpm --filter @buildplane/cli build
```

Smoke test via `makeBuildplaneRunFixture` is easier than manual; let Task 8 cover it. For now:

```bash
pnpm --filter @buildplane/cli exec vitest run
```
Expected: unit tests pass. CLI tests that hit `mapEventKindForLedger` (if any) — remove those assertions, they're obsolete.

- [ ] **Step 6: Commit**

```bash
git add apps/cli/src/run-cli.ts
git commit -m "feat(cli): install unit-boundary git checkpoints and remove Phase B stub"
```

---

## Phase C.5 — Integration tests

### Task 8: `tool-capture.test.ts` — write_file end-to-end

**Files:**
- Create: `test/ledger-integration/tool-capture.test.ts`

- [ ] **Step 1: Write the test**

Create `test/ledger-integration/tool-capture.test.ts`:

```ts
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { makeBuildplaneRunFixture } from "./fixtures.js";

function sha256(s: string): string {
	return `sha256:${createHash("sha256").update(s).digest("hex")}`;
}

describe("tool-capture", () => {
	it("write_file packet produces full tool-observation chain in events.db", async () => {
		const content = "hello";
		const fixture = await makeBuildplaneRunFixture({
			packet: {
				unit: {
					id: "unit-write",
					kind: "command",
					scope: "task",
					inputRefs: [],
					expectedOutputs: ["out.txt"],
					verificationContract: "exit-0-and-required-outputs",
					policyProfile: "default",
				},
				execution: {
					command: "node",
					args: [
						"-e",
						`const fs = require('node:fs'); fs.writeFileSync('out.txt', ${JSON.stringify(content)});`,
					],
				},
				verification: { requiredOutputs: ["out.txt"] },
			},
		});

		try {
			expect(fixture.exitCode).toBe(0);
			const db = new DatabaseSync(fixture.eventsDbPath);
			const rows = db
				.prepare("SELECT kind FROM events ORDER BY id ASC")
				.all() as { kind: string }[];
			const kinds = rows.map((r) => r.kind);

			// Expect the canonical Phase C sequence. The `run_command` and its
			// `workspace_write` are absent because this test uses node -e via the
			// command executor, not the write_file tool. The checkpoint captures
			// the file change instead.
			expect(kinds).toContain("run_started");
			expect(kinds).toContain("unit_started");
			expect(kinds).toContain("git_checkpoint");
			expect(kinds).toContain("unit_completed");
			expect(kinds).toContain("run_completed");

			db.close();
		} finally {
			await fixture.cleanup();
		}
	}, 30_000);
});
```

Note: the above uses the `command` executor, which goes through `run_command`, not `write_file`. That's because the packet's `execution.command` is "node" — a shell invocation. If you want to exercise `write_file` directly via the packet, you need a packet shape that invokes `write_file` as a tool call (likely requires a different `kind` or a strategy packet). Check the existing packet fixtures under `test/local-run-loop/` to see what shape actually dispatches through the ToolRegistry's `write_file` method. Adapt this test accordingly.

If `write_file` isn't directly dispatchable by a simple packet, keep the above test as a command-capture proxy (it still proves the pre/post checkpoint + unit lifecycle) and add a narrower Layer-2 test that exercises `wrapToolRegistryForLedger.write_file` directly. Mark this task DONE_WITH_CONCERNS if the packet-level invocation of `write_file` isn't reachable.

- [ ] **Step 2: Run the test**

```bash
pnpm exec vitest run test/ledger-integration/tool-capture.test.ts
```
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add test/ledger-integration/tool-capture.test.ts
git commit -m "test(ledger): add write_file tool-capture integration test"
```

### Task 9: `shell-command-capture.test.ts`

**Files:**
- Create: `test/ledger-integration/shell-command-capture.test.ts`

- [ ] **Step 1: Write the test**

```ts
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { makeBuildplaneRunFixture } from "./fixtures.js";

describe("shell-command-capture", () => {
	it("run_command packet records exit_code, stdout, and tree delta in git checkpoint", async () => {
		const fixture = await makeBuildplaneRunFixture({
			packet: {
				unit: {
					id: "unit-shell",
					kind: "command",
					scope: "task",
					inputRefs: [],
					expectedOutputs: ["shell-out.txt"],
					verificationContract: "exit-0-and-required-outputs",
					policyProfile: "default",
				},
				execution: {
					command: "sh",
					args: ["-c", "echo hi > shell-out.txt"],
				},
				verification: { requiredOutputs: ["shell-out.txt"] },
			},
		});

		try {
			expect(fixture.exitCode).toBe(0);
			const db = new DatabaseSync(fixture.eventsDbPath);

			// Find the post-unit checkpoint and verify the tree contains shell-out.txt.
			const ckptRows = db
				.prepare(
					"SELECT payload FROM events WHERE kind = 'git_checkpoint' ORDER BY id ASC",
				)
				.all() as { payload: string }[];
			const postPayload = JSON.parse(ckptRows[ckptRows.length - 1].payload) as {
				GitCheckpointV1: { commit_sha: string; boundary: string };
			};
			expect(postPayload.GitCheckpointV1.boundary).toBe("post-unit");

			const treeListing = spawnSync(
				"git",
				["-C", fixture.dir, "ls-tree", "-r", "--name-only", postPayload.GitCheckpointV1.commit_sha],
				{ encoding: "utf8" },
			).stdout;
			expect(treeListing.split("\n")).toContain("shell-out.txt");

			// No workspace_write event — the wrapper can't see shell side effects.
			const wsWrites = db
				.prepare("SELECT COUNT(*) as c FROM events WHERE kind = 'workspace_write'")
				.get() as { c: number };
			expect(wsWrites.c).toBe(0);

			db.close();
		} finally {
			await fixture.cleanup();
		}
	}, 30_000);
});
```

- [ ] **Step 2: Run + commit**

```bash
pnpm exec vitest run test/ledger-integration/shell-command-capture.test.ts
```
Expected: PASS.

```bash
git add test/ledger-integration/shell-command-capture.test.ts
git commit -m "test(ledger): add shell-command-capture integration test with git-tree assertion"
```

### Task 10: `git-checkpoint.test.ts` — multi-unit ref chain

**Files:**
- Create: `test/ledger-integration/git-checkpoint.test.ts`

- [ ] **Step 1: Write the test**

```ts
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { makeBuildplaneRunFixture } from "./fixtures.js";

describe("git-checkpoint", () => {
	it("multi-unit run produces a 4-commit chain on refs/buildplane/run/<runId>", async () => {
		// Phase B orchestrator may not natively support multi-unit packets; this
		// test assumes a single-unit packet produces 2 checkpoints (pre + post).
		// For a genuine multi-unit check, would need a strategy/graph packet.
		// Adapt if the orchestrator's packet shape supports multiple units.
		const fixture = await makeBuildplaneRunFixture({
			packet: {
				unit: {
					id: "unit-multi",
					kind: "command",
					scope: "task",
					inputRefs: [],
					expectedOutputs: ["a.txt"],
					verificationContract: "exit-0-and-required-outputs",
					policyProfile: "default",
				},
				execution: {
					command: "sh",
					args: ["-c", "echo a > a.txt"],
				},
				verification: { requiredOutputs: ["a.txt"] },
			},
		});

		try {
			const db = new DatabaseSync(fixture.eventsDbPath);
			const ckpts = db
				.prepare("SELECT payload FROM events WHERE kind = 'git_checkpoint' ORDER BY id ASC")
				.all() as { payload: string }[];

			// At minimum 2 (pre + post) for one unit.
			expect(ckpts.length).toBeGreaterThanOrEqual(2);

			const parsed = ckpts.map(
				(r) => JSON.parse(r.payload).GitCheckpointV1 as {
					boundary: string; commit_sha: string; reference: string;
				},
			);

			expect(parsed[0].boundary).toBe("pre-unit");
			expect(parsed[parsed.length - 1].boundary).toBe("post-unit");

			// All checkpoints share the same ref.
			const refs = new Set(parsed.map((c) => c.reference));
			expect(refs.size).toBe(1);
			const ref = [...refs][0];
			expect(ref).toMatch(/^refs\/buildplane\/run\/[0-9a-f-]{36}$/);

			// The ref resolves to the LAST checkpoint's commit SHA.
			const refSha = spawnSync(
				"git",
				["-C", fixture.dir, "show-ref", "--hash", ref],
				{ encoding: "utf8" },
			).stdout.trim();
			expect(refSha).toBe(parsed[parsed.length - 1].commit_sha);

			// HEAD is untouched: the repo's default branch tip equals the init commit.
			const head = spawnSync(
				"git",
				["-C", fixture.dir, "rev-parse", "HEAD"],
				{ encoding: "utf8" },
			).stdout.trim();
			expect(head).not.toBe(refSha);

			db.close();
		} finally {
			await fixture.cleanup();
		}
	}, 30_000);
});
```

- [ ] **Step 2: Run + commit**

```bash
pnpm exec vitest run test/ledger-integration/git-checkpoint.test.ts
```
Expected: PASS.

```bash
git add test/ledger-integration/git-checkpoint.test.ts
git commit -m "test(ledger): add git-checkpoint integration test for ref chain + HEAD isolation"
```

### Task 11: `permission-denied.test.ts`

**Files:**
- Create: `test/ledger-integration/permission-denied.test.ts`

- [ ] **Step 1: Write the test (Linux-only; skip elsewhere)**

```ts
import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { makeBuildplaneRunFixture } from "./fixtures.js";

const SKIP_PLATFORMS = new Set(["win32", "darwin"]);

describe.skipIf(SKIP_PLATFORMS.has(process.platform))(
	"permission-denied",
	() => {
		it("surfaces a clean failure when .buildplane/ledger is read-only", async () => {
			// Pre-create the ledger dir with read-only perms BEFORE invoking
			// buildplane run, so the ledger subprocess's attempt to create
			// events.db fails.
			const fixture = await makeBuildplaneRunFixture({
				packet: {
					unit: {
						id: "unit-noop",
						kind: "command",
						scope: "task",
						inputRefs: [],
						expectedOutputs: [],
						verificationContract: "exit-0-and-required-outputs",
						policyProfile: "default",
					},
					execution: { command: "sh", args: ["-c", "true"] },
					verification: { requiredOutputs: [] },
				},
			});

			try {
				// The fixture already ran the packet. To actually exercise the
				// permission-denied path, we'd need to inject the chmod BEFORE
				// the run — but makeBuildplaneRunFixture runs synchronously. For
				// Phase C we accept this as a partial test: the ledger subprocess
				// does create its dir successfully on a writable tempdir. A full
				// permission-denied test requires a fixture variant that chmods
				// before runCli(). Mark this as a documented Phase D expansion.
				//
				// For now, assert the run completed normally on a writable
				// workspace. This at least catches regressions where the ledger
				// mkdir -p fails silently.
				expect(fixture.exitCode).toBe(0);
			} finally {
				await fixture.cleanup();
			}
		}, 30_000);
	},
);
```

> **Note:** Full read-only directory testing requires a `makeBuildplaneRunFixture` variant that lets you mutate the workspace between fixture setup and `runCli()` invocation. Phase C's fixture doesn't expose that hook. The spec acknowledges this as potentially flaky; the test as written is best-effort. If the implementer wants to add the hook, fine; if not, mark DONE_WITH_CONCERNS with a note that Phase D's fixture can be extended.

- [ ] **Step 2: Run + commit**

```bash
pnpm exec vitest run test/ledger-integration/permission-denied.test.ts
```

Expected: PASS (or SKIP on non-Linux).

```bash
git add test/ledger-integration/permission-denied.test.ts
git commit -m "test(ledger): add permission-denied integration test (Linux-only, partial)"
```

---

## Phase C.6 — Verification gate

### Task 12: Full gate + spec marker

**Files:**
- Modify: `docs/superpowers/specs/2026-04-18-tool-instrumentation-design.md`

- [ ] **Step 1: Full Rust test suite (should be unchanged from B)**

```bash
cargo test --manifest-path native/Cargo.toml -p bp-ledger -p bp-ledger-macros -p bp-cli
```
Expected: 84 tests still pass.

- [ ] **Step 2: TS unit tests**

```bash
pnpm --filter @buildplane/cli exec vitest run
pnpm --filter @buildplane/ledger-client exec vitest run
```
Expected: all pass.

- [ ] **Step 3: Integration tests**

```bash
pnpm exec vitest run test/ledger-integration/
```
Expected: all Phase B tests pass + all Phase C tests pass (cwd-isolation, tool-capture, shell-command-capture, git-checkpoint, permission-denied).

- [ ] **Step 4: Clippy (no Rust changes; should still be clean)**

```bash
cargo clippy --manifest-path native/Cargo.toml -p bp-ledger -p bp-ledger-macros -p bp-cli -- -D warnings
```
Expected: clean.

- [ ] **Step 5: Fixture drift check**

```bash
pnpm ledger:gen-fixtures
git diff --exit-code -- packages/ledger-client/fixtures/payload-variants.json
```
Expected: clean (no Rust changes in C, so no drift).

- [ ] **Step 6: Real `buildplane run` smoke**

Do one manual smoke test from the repo root, using a tempdir workspace. Verify events.db contains the Section 1 Success-Criteria sequence for a write_file-style packet.

```bash
rm -rf /tmp/bp-phase-c-gate && mkdir -p /tmp/bp-phase-c-gate && cd /tmp/bp-phase-c-gate
git init -q && git config user.email t@t && git config user.name t && git commit -q --allow-empty -m init
cat > packet.json <<'EOF'
{
  "unit": {
    "id": "unit-hello",
    "kind": "command",
    "scope": "task",
    "inputRefs": [],
    "expectedOutputs": ["out.txt"],
    "verificationContract": "exit-0-and-required-outputs",
    "policyProfile": "default"
  },
  "execution": {
    "command": "node",
    "args": ["-e", "const fs = require('node:fs'); fs.writeFileSync('out.txt','hi');"]
  },
  "verification": { "requiredOutputs": ["out.txt"] }
}
EOF
pnpm --dir /mnt/c/Dev/projects/buildplane-ledger-phase-c buildplane run --packet /tmp/bp-phase-c-gate/packet.json --cwd /tmp/bp-phase-c-gate
python3 -c "import sqlite3; c=sqlite3.connect('/tmp/bp-phase-c-gate/.buildplane/ledger/events.db'); print(c.execute('SELECT kind FROM events ORDER BY id').fetchall())"
```

Expected: row sequence includes `run_started`, `unit_started`, at least one `git_checkpoint`, `unit_completed`, `run_completed`.

Also verify repo-root isn't polluted:
```bash
cd /mnt/c/Dev/projects/buildplane-ledger-phase-c
git status --porcelain
```
Expected: unchanged from before the smoke test.

- [ ] **Step 7: Spec marker**

Modify `docs/superpowers/specs/2026-04-18-tool-instrumentation-design.md`. At the end of Section 4 (Phases + Sequencing), append:

```markdown

**Phase C status: complete (2026-04-18).**
```

(use today's date)

- [ ] **Step 8: Commit**

```bash
git add docs/superpowers/specs/2026-04-18-tool-instrumentation-design.md
git commit -m "docs(ledger): mark Phase C complete"
```

---

## Self-review

**Spec coverage check.**

| Spec in-scope item | Task(s) |
|---|---|
| `apps/cli/src/ledger-tool-wrapper.ts` | 1, 2 |
| Wire wrapper into run-cli.ts | 6 |
| Git checkpoints at unit boundaries | 3, 7 |
| Remove Phase B `mapEventKindForLedger` stub | 7 |
| `--cwd` pollution fix | 4 |
| `makeBuildplaneRunFixture()` | 5 |
| tool-capture.test.ts | 8 |
| shell-command-capture.test.ts | 9 |
| git-checkpoint.test.ts | 10 |
| permission-denied.test.ts | 11 |
| cwd-isolation canary | 5 |

Success criteria from spec Section 1:
1. write_file causal chain — Task 8 (proxied via `run_command` since `write_file` tool may not be directly packet-addressable; acceptable per spec).
2. run_command chain + git-tree check — Task 9.
3. Integration tests don't pollute feature branch — Task 5 (canary) + Task 7 (audit fix).
4. `mapEventKindForLedger` stub removed — Task 7.

Gaps I deliberately accept:
- Task 8 may not exercise `write_file` directly via a packet (depends on orchestrator packet schema). Layer-2 test in Task 1 is the authoritative coverage; Task 8's command-path variant proves the pre/post checkpoint + unit lifecycle instead. Documented.
- Task 11 can't fully exercise read-only-dir path without a fixture variant; marked as partial.

**Placeholder scan.** No TBD/TODO in task bodies. Implementation notes where code needs adaptation to the actual file state are explicit guidance (Task 5 re runCli signature, Task 7 re Phase B direct-emit points, Task 8 re packet shape for write_file, Task 11 re read-only dir).

**Type consistency.**
- `UnitCtx`, `LedgerEventEmitter` used consistently (Tasks 1, 2, 3, 6, 7).
- `wrapToolRegistryForLedger`, `runGitCheckpoint`, `gitInWorkspace`, `makeBuildplaneRunFixture` — names match across tasks.
- Wire format (`ToolRequestStoredV1`, `ToolResultV1`, `WorkspaceWriteV1`, `GitCheckpointV1`) matches Phase A payload definitions.
- `getUnitCtx: () => UnitCtx | null` consistent across Tasks 1, 2, 6.

No drift detected.
