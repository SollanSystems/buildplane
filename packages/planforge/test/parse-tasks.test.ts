import { describe, expect, it } from "vitest";
import { parseTasks } from "../src/parse-tasks.ts";

const MINIMAL_TASK = `## Tasks\n\n### T1: Write the spec\n\n- Objective: Define the PlanForge contracts at documentation level.\n- Assignee-hint: auto-coder\n- Workspace: isolated-worktree\n- Allowed-side-effects: local-doc, local-fixture\n- Forbidden-side-effects: execute-code, board-write, network-write, push, deploy, merge\n- Depends-on:\n- Acceptance-criteria:\n  - All PlanForge types are defined.\n  - Dry-run semantics are documented.\n- Verification-commands:\n  - pnpm lint\n  - git diff --check\n`;

const TWO_TASK_CONTENT = `## Tasks\n\n### T1: Write the spec\n\n- Objective: Define contracts.\n- Assignee-hint: auto-coder\n- Workspace: isolated-worktree\n- Allowed-side-effects: local-doc, local-fixture\n- Forbidden-side-effects: execute-code, board-write, network-write, push, deploy, merge\n- Depends-on:\n- Acceptance-criteria:\n  - All types defined.\n- Verification-commands:\n  - pnpm lint\n\n### T2: Implement CLI\n\n- Objective: Add the dry-run command.\n- Assignee-hint: auto-coder\n- Workspace: isolated-worktree\n- Allowed-side-effects: local-doc, local-fixture, local-receipt\n- Forbidden-side-effects: execute-code, board-write, network-write, push, deploy, merge\n- Depends-on: T1\n- Acceptance-criteria:\n  - Missing input fails closed.\n  - Output is stable JSON.\n- Verification-commands:\n  - pnpm vitest --run apps/cli/test/run-cli.test.ts -t planforge\n  - pnpm typecheck\n`;

describe("parseTasks", () => {
	it("returns [] when no ## Tasks section exists", () => {
		expect(parseTasks("## Goal\n\nSome goal.")).toEqual([]);
	});

	it("returns [] when ## Tasks section is empty", () => {
		expect(parseTasks("## Tasks\n\n## Goal\n\nSome goal.")).toEqual([]);
	});

	it("parses a single task with all required fields", () => {
		const [task] = parseTasks(MINIMAL_TASK);
		expect(task.id).toBe("T1");
		expect(task.title).toBe("Write the spec");
		expect(task.objective).toBe(
			"Define the PlanForge contracts at documentation level.",
		);
		expect(task.assigneeHint).toBe("auto-coder");
		expect(task.workspace).toBe("isolated-worktree");
		expect(task.dependsOn).toEqual([]);
		expect(task.allowedSideEffects).toEqual(["local-doc", "local-fixture"]);
		expect(task.forbiddenSideEffects).toEqual([
			"execute-code",
			"board-write",
			"network-write",
			"push",
			"deploy",
			"merge",
		]);
		expect(task.acceptanceCriteria).toEqual([
			"All PlanForge types are defined.",
			"Dry-run semantics are documented.",
		]);
		expect(task.verificationCommands).toEqual([
			"pnpm lint",
			"git diff --check",
		]);
	});

	it("parses two tasks preserving order and dependsOn reference", () => {
		const tasks = parseTasks(TWO_TASK_CONTENT);
		expect(tasks).toHaveLength(2);
		expect(tasks[0].id).toBe("T1");
		expect(tasks[1].id).toBe("T2");
		expect(tasks[1].dependsOn).toEqual(["T1"]);
		expect(tasks[1].allowedSideEffects).toContain("local-receipt");
		expect(tasks[1].acceptanceCriteria).toEqual([
			"Missing input fails closed.",
			"Output is stable JSON.",
		]);
		expect(tasks[1].verificationCommands).toHaveLength(2);
	});

	it("trims whitespace from all parsed string values", () => {
		const content =
			"## Tasks\n\n### T1:  Trimmed title  \n\n- Objective:  spaced objective  \n- Assignee-hint:  auto-coder \n- Workspace:  isolated-worktree \n- Allowed-side-effects: local-doc\n- Forbidden-side-effects: execute-code\n- Depends-on:\n- Acceptance-criteria:\n  - ok\n- Verification-commands:\n  - pnpm lint\n";
		const [task] = parseTasks(content);
		expect(task.title).toBe("Trimmed title");
		expect(task.objective).toBe("spaced objective");
		expect(task.assigneeHint).toBe("auto-coder");
	});

	it("silently excludes unknown side-effect tokens, keeps valid ones", () => {
		const content =
			"## Tasks\n\n### T1: Test\n\n- Objective: x\n- Assignee-hint: auto-coder\n- Workspace: isolated-worktree\n- Allowed-side-effects: local-doc, unknown-effect, local-fixture\n- Forbidden-side-effects: execute-code\n- Depends-on:\n- Acceptance-criteria:\n  - ok\n- Verification-commands:\n  - pnpm lint\n";
		const [task] = parseTasks(content);
		expect(task.allowedSideEffects).toEqual(["local-doc", "local-fixture"]);
	});

	it("parses multi-item Depends-on as a string array", () => {
		const content =
			"## Tasks\n\n### T3: Multi-dep\n\n- Objective: x\n- Assignee-hint: auto-coder\n- Workspace: isolated-worktree\n- Allowed-side-effects: local-doc\n- Forbidden-side-effects: execute-code\n- Depends-on: T1, T2\n- Acceptance-criteria:\n  - ok\n- Verification-commands:\n  - pnpm lint\n";
		const [task] = parseTasks(content);
		expect(task.dependsOn).toEqual(["T1", "T2"]);
	});

	it("returns [] for a task block missing the Objective field", () => {
		const content =
			"## Tasks\n\n### T1: Incomplete\n\n- Assignee-hint: auto-coder\n- Workspace: isolated-worktree\n- Allowed-side-effects: local-doc\n- Forbidden-side-effects: execute-code\n- Depends-on:\n- Acceptance-criteria:\n  - ok\n- Verification-commands:\n  - pnpm lint\n";
		// Tasks with missing required fields are dropped (fail-safe: validate.ts catches empty tasks[])
		expect(parseTasks(content)).toEqual([]);
	});
});
