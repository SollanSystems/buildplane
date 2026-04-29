import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	GSD2_FINAL_STATUSES,
	GSD2_ROUTE_MODES,
	GSD2_TASK_STATUSES,
	parseGsd2Envelope,
	parseGsd2Receipt,
	runGsd2,
	validateGsd2Envelope,
	validateGsd2Receipt,
} from "../src/gsd2";

const cleanupPaths: string[] = [];

function tempWorkspace(): string {
	const root = mkdtempSync(join(tmpdir(), "buildplane-gsd2-"));
	cleanupPaths.push(root);
	return root;
}

async function runCapture(cwd: string, argv: string[]) {
	const stdout: string[] = [];
	const stderr: string[] = [];
	const exitCode = await runGsd2(argv, {
		cwd,
		stdout: (line) => stdout.push(line),
		stderr: (line) => stderr.push(line),
	});
	return { exitCode, stdout, stderr };
}

function statePath(cwd: string): string {
	return join(cwd, ".gsd2", "STATE.md");
}

function removeStateSchemaVersion(cwd: string): void {
	writeFileSync(
		statePath(cwd),
		readFileSync(statePath(cwd), "utf8").replace(/^schema_version:.*\n/gm, ""),
	);
}

function writeMutationLock(cwd: string): void {
	mkdirSync(join(cwd, ".gsd2"), { recursive: true });
	writeFileSync(join(cwd, ".gsd2", "mutation.lock"), "stale lock\n");
}

afterEach(() => {
	for (const path of cleanupPaths.splice(0)) {
		rmSync(path, { force: true, recursive: true });
	}
});

describe("GSD-2 V0 schema contract", () => {
	it("defines the V0 task statuses, route modes, and final statuses", () => {
		expect(GSD2_TASK_STATUSES).toEqual([
			"NEW",
			"READY",
			"RUNNING",
			"VERIFYING",
			"PASSED",
			"BLOCKED",
			"FAILED",
			"RETRYING",
			"ESCALATED",
		]);
		expect(GSD2_ROUTE_MODES).toEqual([
			"planning_only",
			"direct",
			"worktree_kernel",
			"buildplane",
			"manual_recovery",
		]);
		expect(GSD2_FINAL_STATUSES).toEqual(["PASSED", "BLOCKED", "FAILED"]);
	});

	it("validates minimal envelopes and receipts", () => {
		const envelope = parseGsd2Envelope(`id: G2-0001
status: NEW
goal: "Create a non-executing CLI skeleton."
routing:
  mode: planning_only
  front_door: auto-coder
  backend: none
verification:
  commands:
    - "git diff --check"
`);
		const receipt = parseGsd2Receipt(`task_id: G2-0001
backend: none
final_status: BLOCKED
verification:
  required_complete: false
acceptance:
  explicitly_checked: false
`);

		expect(validateGsd2Envelope(envelope)).toEqual([]);
		expect(validateGsd2Receipt(receipt)).toEqual([]);
	});

	it("rejects malformed envelopes and receipts", () => {
		const envelope = parseGsd2Envelope(`id: task-1
status: DONE
goal: "x"
routing:
  mode: execute_now
`);
		const receipt = parseGsd2Receipt(`task_id: nope
backend: buildplane
final_status: GREEN
`);

		expect(validateGsd2Envelope(envelope)).toEqual([
			"envelope.id must match G2-0001 format",
			"envelope.status must be one of NEW, READY, RUNNING, VERIFYING, PASSED, BLOCKED, FAILED, RETRYING, ESCALATED",
			"envelope.routing.mode must be one of planning_only, direct, worktree_kernel, buildplane, manual_recovery",
		]);
		expect(validateGsd2Receipt(receipt)).toEqual([
			"receipt.task_id must match G2-0001 format",
			"receipt.final_status must be one of PASSED, BLOCKED, FAILED",
		]);
	});
});

describe("GSD-2 V0 CLI skeleton", () => {
	it("prints help without creating .gsd2", async () => {
		const cwd = tempWorkspace();
		const result = await runCapture(cwd, ["--help"]);

		expect(result.exitCode).toBe(0);
		expect(result.stderr).toEqual([]);
		expect(result.stdout.join("\n")).toContain("GSD-2 repo-local task state");
		expect(existsSync(join(cwd, ".gsd2"))).toBe(false);
	});

	it("reports missing state without creating files", async () => {
		const cwd = tempWorkspace();
		const result = await runCapture(cwd, ["status"]);

		expect(result.exitCode).toBe(1);
		expect(result.stdout).toEqual([
			'gsd2: no .gsd2 state found; run `gsd2 new "<goal>"` to create the first task.',
		]);
		expect(result.stderr).toEqual([]);
		expect(existsSync(join(cwd, ".gsd2"))).toBe(false);
	});

	it("creates the first monotonic task without executing workers", async () => {
		const cwd = tempWorkspace();
		const result = await runCapture(cwd, [
			"new",
			"Create a non-executing GSD-2 skeleton",
			"--route",
			"planning_only",
		]);

		expect(result.exitCode).toBe(0);
		expect(result.stderr).toEqual([]);
		expect(result.stdout).toContain("task-id: G2-0001");
		expect(result.stdout).toContain("route: planning_only");
		const taskDir = join(cwd, ".gsd2", "tasks", "G2-0001");
		expect(existsSync(join(cwd, ".gsd2", "PROJECT.md"))).toBe(true);
		expect(existsSync(join(cwd, ".gsd2", "STATE.md"))).toBe(true);
		expect(existsSync(join(cwd, ".gsd2", "QUEUE.md"))).toBe(true);
		expect(existsSync(join(cwd, ".gsd2", "config.yaml"))).toBe(true);
		expect(readFileSync(join(taskDir, "task.md"), "utf8")).toContain(
			"Create a non-executing GSD-2 skeleton",
		);
		expect(readFileSync(join(taskDir, "envelope.yaml"), "utf8")).toContain(
			"front_door: auto-coder",
		);
		expect(readFileSync(join(taskDir, "receipt.yaml"), "utf8")).toContain(
			"final_status: BLOCKED",
		);
	});

	it("validates existing task state", async () => {
		const cwd = tempWorkspace();
		await runCapture(cwd, ["new", "Validate task state"]);

		const result = await runCapture(cwd, ["validate"]);

		expect(result.exitCode).toBe(0);
		expect(result.stderr).toEqual([]);
		expect(result.stdout).toEqual(["gsd2 validate: pass", "tasks: 1"]);
	});

	it("migrates legacy state before status", async () => {
		const cwd = tempWorkspace();
		await runCapture(cwd, ["new", "Status migrates state"]);
		removeStateSchemaVersion(cwd);

		const result = await runCapture(cwd, ["status"]);

		expect(result.exitCode).toBe(0);
		expect(result.stderr).toEqual([]);
		expect(readFileSync(statePath(cwd), "utf8")).toContain("schema_version: 1");
	});

	it("migrates legacy state before validate", async () => {
		const cwd = tempWorkspace();
		await runCapture(cwd, ["new", "Validate migrates state"]);
		removeStateSchemaVersion(cwd);

		const result = await runCapture(cwd, ["validate"]);

		expect(result.exitCode).toBe(0);
		expect(result.stderr).toEqual([]);
		expect(readFileSync(statePath(cwd), "utf8")).toContain("schema_version: 1");
	});

	it("migrates legacy state before dry-run", async () => {
		const cwd = tempWorkspace();
		await runCapture(cwd, ["new", "Dry-run migrates state"]);
		removeStateSchemaVersion(cwd);

		const result = await runCapture(cwd, ["run", "--dry-run", "G2-0001"]);

		expect(result.exitCode).toBe(0);
		expect(result.stderr).toEqual([]);
		expect(readFileSync(statePath(cwd), "utf8")).toContain("schema_version: 1");
	});

	it("status fails closed while the mutation lock exists", async () => {
		const cwd = tempWorkspace();
		await runCapture(cwd, ["new", "Status lock"]);
		writeMutationLock(cwd);

		const result = await runCapture(cwd, ["status"]);

		expect(result.exitCode).toBe(1);
		expect(result.stderr.join("\n")).toContain(
			"gsd2: mutation lock already held for this worktree",
		);
	});

	it("validate fails closed while the mutation lock exists", async () => {
		const cwd = tempWorkspace();
		await runCapture(cwd, ["new", "Validate lock"]);
		writeMutationLock(cwd);

		const result = await runCapture(cwd, ["validate"]);

		expect(result.exitCode).toBe(1);
		expect(result.stderr.join("\n")).toContain(
			"gsd2: mutation lock already held for this worktree",
		);
	});

	it("dry-run fails closed while the mutation lock exists", async () => {
		const cwd = tempWorkspace();
		await runCapture(cwd, ["new", "Dry-run lock"]);
		writeMutationLock(cwd);

		const result = await runCapture(cwd, ["run", "--dry-run", "G2-0001"]);

		expect(result.exitCode).toBe(1);
		expect(result.stderr.join("\n")).toContain(
			"gsd2: mutation lock already held for this worktree",
		);
	});

	it("fails validation when repo-local state is absent", async () => {
		const cwd = tempWorkspace();
		const result = await runCapture(cwd, ["validate"]);

		expect(result.exitCode).toBe(1);
		expect(result.stderr).toEqual([]);
		expect(result.stdout).toEqual([
			'gsd2 validate: fail; no .gsd2 state found; run `gsd2 new "<goal>"` to create the first task.',
		]);
		expect(existsSync(join(cwd, ".gsd2"))).toBe(false);
	});

	it("honors --workspace without mutating the process cwd", async () => {
		const cwd = tempWorkspace();
		const workspace = tempWorkspace();

		const result = await runCapture(cwd, [
			"new",
			"Create state elsewhere",
			"--workspace",
			workspace,
		]);

		expect(result.exitCode).toBe(0);
		expect(existsSync(join(cwd, ".gsd2"))).toBe(false);
		expect(existsSync(join(workspace, ".gsd2", "tasks", "G2-0001"))).toBe(true);
	});

	it("previews run routing without executing workers", async () => {
		const cwd = tempWorkspace();
		await runCapture(cwd, [
			"new",
			"Preview a serious-mode backend route",
			"--route",
			"buildplane",
		]);

		const result = await runCapture(cwd, ["run", "--dry-run", "G2-0001"]);

		expect(result.exitCode).toBe(0);
		expect(result.stderr).toEqual([]);
		expect(result.stdout).toEqual([
			"gsd2 dry-run: G2-0001",
			"front-door: auto-coder",
			"route: buildplane",
			"backend: buildplane",
			"will-execute: false",
			"verification:",
			"  - git diff --check",
			"recovery:",
			"  - retry_with_tighter_context",
			"  - fresh_worktree",
			"  - buildplane_replay",
			"  - buildplane_fork",
			"  - manual_escalation",
		]);
	});

	it("rejects run without dry-run", async () => {
		const cwd = tempWorkspace();
		await runCapture(cwd, ["new", "Do not execute"]);

		const result = await runCapture(cwd, ["run", "G2-0001"]);

		expect(result.exitCode).toBe(1);
		expect(result.stdout).toEqual([]);
		expect(result.stderr).toEqual([
			"gsd2 run: Milestone 1 only supports --dry-run",
		]);
	});

	it("fails closed when dry-run sees malformed task envelopes", async () => {
		const cwd = tempWorkspace();
		await runCapture(cwd, ["new", "Malformed route preview"]);
		writeFileSync(
			join(cwd, ".gsd2", "tasks", "G2-0001", "envelope.yaml"),
			`id: G2-0001
status: NEW
goal: "Malformed route preview"
routing:
  mode: execute_now
  front_door: auto-coder
  backend: none
verification:
  commands:
    - "git diff --check"
`,
		);

		const result = await runCapture(cwd, ["run", "--dry-run", "G2-0001"]);

		expect(result.exitCode).toBe(1);
		expect(result.stdout).toEqual([]);
		expect(result.stderr).toEqual([
			"gsd2 run --dry-run: G2-0001/envelope.yaml: envelope.routing.mode must be one of planning_only, direct, worktree_kernel, buildplane, manual_recovery",
		]);
	});

	it("does not reuse task IDs after a task directory is removed", async () => {
		const cwd = tempWorkspace();
		await runCapture(cwd, ["new", "First task"]);
		rmSync(join(cwd, ".gsd2", "tasks", "G2-0001"), {
			force: true,
			recursive: true,
		});

		const result = await runCapture(cwd, ["new", "Second task"]);

		expect(result.exitCode).toBe(0);
		expect(result.stderr).toEqual([]);
		expect(result.stdout).toContain("task-id: G2-0002");
		expect(existsSync(join(cwd, ".gsd2", "tasks", "G2-0001"))).toBe(false);
		expect(existsSync(join(cwd, ".gsd2", "tasks", "G2-0002"))).toBe(true);
		expect(readFileSync(join(cwd, ".gsd2", "STATE.md"), "utf8")).toContain(
			"next_task_number: 3",
		);
	});

	it("preserves operator state notes while advancing the task counter", async () => {
		const cwd = tempWorkspace();
		await runCapture(cwd, ["new", "First task"]);
		writeFileSync(
			join(cwd, ".gsd2", "STATE.md"),
			"# GSD-2 State\n\nCurrent status: active\noperator_note: keep this\nnext_task_number: 2\n",
		);

		const result = await runCapture(cwd, ["new", "Second task"]);

		expect(result.exitCode).toBe(0);
		const state = readFileSync(join(cwd, ".gsd2", "STATE.md"), "utf8");
		expect(state).toContain("Current status: active");
		expect(state).toContain("operator_note: keep this");
		expect(state).toContain("schema_version: 1");
		expect(state).toContain("next_task_number: 3");
	});

	it("migrates legacy state by adding the schema version line", async () => {
		const cwd = tempWorkspace();
		await runCapture(cwd, ["new", "First task"]);
		writeFileSync(
			join(cwd, ".gsd2", "STATE.md"),
			"# GSD-2 State\n\nCurrent status: active\nnext_task_number: 2\n",
		);

		const result = await runCapture(cwd, ["new", "Second task"]);

		expect(result.exitCode).toBe(0);
		const state = readFileSync(join(cwd, ".gsd2", "STATE.md"), "utf8");
		expect(state).toContain("schema_version: 1");
		expect(state).toContain("next_task_number: 3");
	});

	it("fails closed when the worktree mutation lock already exists", async () => {
		const cwd = tempWorkspace();
		mkdirSync(join(cwd, ".gsd2"), { recursive: true });
		writeFileSync(join(cwd, ".gsd2", "mutation.lock"), "stale lock\n");

		const result = await runCapture(cwd, ["new", "Blocked by lock"]);

		expect(result.exitCode).toBe(1);
		expect(result.stderr.join("\n")).toContain(
			"gsd2: mutation lock already held for this worktree",
		);
	});

	it("replaces noncanonical task counter lines instead of appending duplicates", async () => {
		const cwd = tempWorkspace();
		await runCapture(cwd, ["new", "First task"]);
		rmSync(join(cwd, ".gsd2", "tasks", "G2-0001"), {
			force: true,
			recursive: true,
		});
		writeFileSync(
			join(cwd, ".gsd2", "STATE.md"),
			"# GSD-2 State\n\nCurrent status: active\nnext_task_number: ' 2 ' # keep moving\n",
		);

		const result = await runCapture(cwd, ["new", "Second task"]);

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("task-id: G2-0002");
		const state = readFileSync(join(cwd, ".gsd2", "STATE.md"), "utf8");
		expect(state.match(/^next_task_number:/gm)).toHaveLength(1);
		expect(state).toContain("next_task_number: 3");
	});

	it("fails validation when task documents disagree with their directory", async () => {
		const cwd = tempWorkspace();
		await runCapture(cwd, ["new", "Validate task identity"]);
		writeFileSync(
			join(cwd, ".gsd2", "tasks", "G2-0001", "envelope.yaml"),
			`id: G2-0002
status: NEW
goal: "Validate task identity"
routing:
  mode: planning_only
  front_door: auto-coder
  backend: none
verification:
  commands:
    - "git diff --check"
`,
		);

		const result = await runCapture(cwd, ["validate"]);

		expect(result.exitCode).toBe(1);
		expect(result.stderr).toEqual([]);
		expect(result.stdout).toEqual([
			"gsd2 validate: fail",
			"  - G2-0001/envelope.yaml: envelope.id must match task directory",
		]);
	});

	it("fails validation when receipt task IDs disagree with their directory", async () => {
		const cwd = tempWorkspace();
		await runCapture(cwd, ["new", "Validate receipt identity"]);
		writeFileSync(
			join(cwd, ".gsd2", "tasks", "G2-0001", "receipt.yaml"),
			`task_id: G2-0002
run_id: null
backend: none
final_status: BLOCKED
checked_by: agent
checked_at: "2026-04-28T16:26:35Z"
verification:
  required_complete: false
acceptance:
  explicitly_checked: false
`,
		);

		const result = await runCapture(cwd, ["validate"]);

		expect(result.exitCode).toBe(1);
		expect(result.stderr).toEqual([]);
		expect(result.stdout).toEqual([
			"gsd2 validate: fail",
			"  - G2-0001/receipt.yaml: receipt.task_id must match task directory",
		]);
	});

	it("does not duplicate directory mismatch errors for malformed document IDs", async () => {
		const cwd = tempWorkspace();
		await runCapture(cwd, ["new", "Validate malformed identities"]);
		writeFileSync(
			join(cwd, ".gsd2", "tasks", "G2-0001", "envelope.yaml"),
			`id: task-1
status: NEW
goal: "Validate malformed identities"
routing:
  mode: planning_only
`,
		);
		writeFileSync(
			join(cwd, ".gsd2", "tasks", "G2-0001", "receipt.yaml"),
			`task_id: nope
backend: none
final_status: BLOCKED
`,
		);

		const result = await runCapture(cwd, ["validate"]);

		expect(result.exitCode).toBe(1);
		expect(result.stdout).toEqual([
			"gsd2 validate: fail",
			"  - G2-0001/envelope.yaml: envelope.id must match G2-0001 format",
			"  - G2-0001/receipt.yaml: receipt.task_id must match G2-0001 format",
		]);
	});

	it("fails closed instead of emitting task IDs outside the V0 format", async () => {
		const cwd = tempWorkspace();
		mkdirSync(join(cwd, ".gsd2", "tasks", "G2-9999"), { recursive: true });

		const result = await runCapture(cwd, ["new", "Overflow task id"]);

		expect(result.exitCode).toBe(1);
		expect(result.stdout).toEqual([]);
		expect(result.stderr).toEqual([
			"gsd2 new: task id space exhausted for V0 format G2-0001 through G2-9999",
		]);
	});
});
