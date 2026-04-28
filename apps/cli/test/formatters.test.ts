import { describe, expect, it } from "vitest";
import {
	formatInspectDetail,
	formatLearningDetail,
	formatLearningsList,
	formatRunHistory,
	formatRunResult,
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

describe("formatRunResult", () => {
	it("sanitizes injected memory text for terminal-safe human output", () => {
		const lines = formatRunResult({
			run: { id: "run-xyz", status: "passed" },
			injectedMemories: [
				{
					displayText:
						"[repo-fact] commands.typecheck:\n\u001b[31mnpx pnpm typecheck",
					matchReason: "fuzzy-fact-key",
				},
			],
		});

		expect(lines).toContain("injected-memories: 1");
		expect(lines).toContain(
			"  - [repo-fact] commands.typecheck (fuzzy-fact-key)",
		);
		expect(lines.join("\n")).not.toContain("\u001b[31m");
		expect(lines.join("\n")).not.toContain("commands.typecheck:\n");
		expect(lines.join("\n")).not.toContain("npx pnpm typecheck");
	});
});

describe("formatRunHistory", () => {
	it("includes strategy ids and memory provenance summaries", () => {
		const lines = formatRunHistory([
			{
				id: "run-xyz",
				unitId: "implement-foo",
				status: "passed",
				strategyId: "strategy-injected",
				injectedMemoryCount: 2,
				promotedStructuredMemoryCount: 1,
				createdAt: "2026-04-14T01:02:03Z",
			},
		]);

		expect(lines[0]).toContain("STRATEGY");
		expect(lines[0]).toContain("MEM");
		expect(lines[2]).toContain("strategy-injected");
		expect(lines[2]).toContain("mem=2/1");
	});
});

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
		expect(lines).toContainEqual(expect.stringContaining("(seen: 1)"));
	});

	it("sanitizes injected memory text for terminal-safe inspect output", () => {
		const lines = formatInspectDetail(
			{
				...baseSnapshot,
				injectedMemories: [
					{
						displayText:
							"[procedure] fix TypeScript build:\n\u001b[31mRun typecheck first",
						matchReason: "exact-task-type",
					},
				],
			},
			[],
		);
		expect(lines).toContain("injected-memories:");
		expect(lines.join("\n")).toContain(
			"[procedure] fix TypeScript build:\\n\\u001b[31mRun typecheck first (exact-task-type)",
		);
		expect(lines.join("\n")).not.toContain(
			"[procedure] fix TypeScript build:\n",
		);
	});

	it("includes terminal-safe promoted procedure lineage in inspect output", () => {
		const lines = formatInspectDetail(
			{
				...baseSnapshot,
				promotedStructuredMemories: [
					{
						memoryKind: "procedure",
						memoryId: "procedure-1",
						title: "implement-then-review workflow for implement tasks",
						bodySummary:
							"Use an implement-then-review workflow for implement tasks.\n\u001b[31mObserved learning",
						status: "active",
						promotionRule: "multi-round-strategy-workflow->procedure",
						sourceRunId: "run-xyz",
						sourceTaskId: "task-implementer",
						createdAt: "2026-04-14T00:00:00Z",
					},
				],
			},
			[],
		);
		expect(lines).toContain("promoted-memories:");
		expect(lines.join("\n")).toContain(
			"[procedure] implement-then-review workflow for implement tasks: Use an implement-then-review workflow for implement tasks.\\n\\u001b[31mObserved learning (status=active, rule=multi-round-strategy-workflow->procedure, source-task=task-implementer)",
		);
	});

	it("includes strategy lineage when present", () => {
		const lines = formatInspectDetail(
			{
				...baseSnapshot,
				strategy: {
					strategyId: "strategy-injected",
				},
			},
			[],
		);
		expect(lines).toContain("strategy: strategy-injected");
	});

	it("renders event tape summary in inspect output", () => {
		const lines = formatInspectDetail(
			{
				...baseSnapshot,
				eventTape: {
					runId: "run-xyz",
					eventCount: 3,
					firstKind: "run-created",
					lastKind: "run-completed",
					terminalStatus: "failed",
					events: [
						{
							id: "event-1",
							kind: "run-created",
							occurredAt: "2026-04-27T00:00:00.000Z",
							summary: "created unit unit-1",
						},
						{
							id: "event-2",
							kind: "decision-recorded",
							occurredAt: "2026-04-27T00:00:01.000Z",
							summary: "reject-run rejected\n\u001b[31m",
						},
					],
				},
			},
			[],
		);

		expect(lines).toContain("event-tape:");
		expect(lines).toContain("  events: 3");
		expect(lines).toContain("  first: run-created");
		expect(lines).toContain("  last: run-completed");
		expect(lines).toContain("  terminal-status: failed");
		expect(lines.join("\n")).toContain(
			"decision-recorded event-2: reject-run rejected\\n\\u001b[31m",
		);
		expect(lines).toContain("  - ... 1 more events");
		expect(lines.join("\n")).not.toContain("reject-run rejected\n");
	});

	it("includes route and policy provenance when present", () => {
		const lines = formatInspectDetail(
			{
				...baseSnapshot,
				provenance: {
					route: {
						worker: "codex",
						source: "routing-hints",
						provider: "openai-codex",
						model: "gpt-5.4",
						preferredModel: "gpt-5.4",
						effort: "high",
					},
					policy: {
						profile: "default",
					},
				},
			},
			[],
		);

		expect(lines).toContain("provenance:");
		expect(lines).toContain("  route-worker: codex");
		expect(lines).toContain("  route-source: routing-hints");
		expect(lines).toContain("  provider: openai-codex");
		expect(lines).toContain("  model: gpt-5.4");
		expect(lines).toContain("  preferred-model: gpt-5.4");
		expect(lines).toContain("  effort: high");
		expect(lines).toContain("  policy-profile: default");
	});

	it("includes memory and policy decision provenance summaries when present", () => {
		const lines = formatInspectDetail(
			{
				...baseSnapshot,
				provenance: {
					route: {
						worker: "codex",
						source: "routing-hints",
					},
					memory: {
						injectedCount: 2,
						matchReasons: ["exact-task-type", "fuzzy-fact-key"],
						matchClasses: ["exact", "fuzzy"],
					},
					policy: {
						profile: "requires-review",
						decisions: [
							{
								kind: "advance-run",
								outcome: "approved",
								reasons: ["requires human approval"],
							},
							{
								kind: "reject-run",
								outcome: "rejected",
								reasons: ["budget exceeded"],
							},
						],
					},
				},
			},
			[],
		);

		expect(lines).toContain("  memory-injected: 2");
		expect(lines).toContain(
			"  memory-reasons: exact-task-type, fuzzy-fact-key",
		);
		expect(lines).toContain("  memory-match-classes: exact, fuzzy");
		expect(lines).toContain("  policy-profile: requires-review");
		expect(lines).toContain(
			"  policy-decisions: advance-run:approved, reject-run:rejected",
		);
		expect(lines).toContain(
			"  policy-reasons: requires human approval, budget exceeded",
		);
	});

	it("shows outcome, evidence, decisions, and artifacts as a calm causal story", () => {
		const lines = formatInspectDetail(
			{
				...baseSnapshot,
				run: { id: "run-xyz", unitId: "implement-foo", status: "failed" },
				eventTape: {
					runId: "run-xyz",
					eventCount: 1,
					firstKind: "run-created",
					lastKind: "run-created",
					terminalStatus: "failed",
					events: [
						{
							id: "event-1",
							kind: "run-created",
							occurredAt: "2026-04-27T00:00:00.000Z",
							summary: "created unit implement-foo",
						},
					],
				},
				evidence: [
					{
						kind: "verification",
						status: "failed",
						message: "pytest failed\n\u001b[31m1 failed",
					},
				] as Array<{ kind: string; status: string; message: string }>,
				decisions: [
					{
						kind: "advance-run",
						outcome: "blocked",
						reasons: ["verification failed", "needs retry"],
					},
				],
				artifacts: [
					{
						type: "log",
						location: ".buildplane/artifacts/run-xyz/verify.log",
					},
				],
			},
			[],
		);

		expect(lines).toContain("event-tape:");
		expect(lines).toContain("  events: 1");
		expect(lines).toContain("outcome:");
		expect(lines).toContain("  status: failed");
		expect(lines).toContain("evidence:");
		expect(lines).toContain(
			"  - verification failed: pytest failed\\n\\u001b[31m1 failed",
		);
		expect(lines).toContain("decisions:");
		expect(lines).toContain(
			"  - advance-run blocked: verification failed; needs retry",
		);
		expect(lines).toContain("artifacts:");
		expect(lines).toContain(
			"  - log: .buildplane/artifacts/run-xyz/verify.log",
		);
		expect(lines.join("\n")).not.toContain("\u001b[31m1 failed");
	});

	it("sanitizes failure details and still shows outcome when failure is the only detail", () => {
		const lines = formatInspectDetail(
			{
				...baseSnapshot,
				run: { id: "run-xyz", unitId: "implement-foo", status: "failed" },
				failure: {
					kind: "setup\n\u001b[31mkind",
					message: "bad cwd\n\u001b[31mstop",
				},
			} as unknown as Parameters<typeof formatInspectDetail>[0],
			[],
		);

		expect(lines).toContain("failure-kind: setup\\n\\u001b[31mkind");
		expect(lines).toContain("failure: bad cwd\\n\\u001b[31mstop");
		expect(lines).toContain("outcome:");
		expect(lines).toContain("  status: failed");
		expect(lines.join("\n")).not.toContain("setup\n");
		expect(lines.join("\n")).not.toContain("bad cwd\n");
	});

	it("sanitizes inspect header, workspace, and learning fields", () => {
		const lines = formatInspectDetail(
			{
				...baseSnapshot,
				kind: "run\n\u001b[31mkind",
				run: {
					id: "run\n\u001b[31mid",
					unitId: "unit\n\u001b[31mid",
					status: "failed\n\u001b[31mstatus",
				},
				workspace: {
					status: "active\n\u001b[31mstatus",
					path: "/tmp/ws\n\u001b[31mpath",
					headSha: "abc\n\u001b[31msha",
					finalizedAt: "2026-04-24\n\u001b[31mtime",
					cleanupError: "cleanup\n\u001b[31merror",
					existsOnDisk: false,
				},
			} as unknown as Parameters<typeof formatInspectDetail>[0],
			[],
			[
				{
					id: "learning-1",
					runId: "run-xyz",
					scope: "workspace\n\u001b[31mscope",
					kind: "fact\n\u001b[31mkind",
					title: "title\n\u001b[31mtitle",
					body: "body",
					status: "active",
					createdAt: "2026-04-24T00:00:00Z",
					seenCount: 1,
				},
			],
		);

		expect(lines).toContain("kind: run\\n\\u001b[31mkind");
		expect(lines).toContain("run-id: run\\n\\u001b[31mid");
		expect(lines).toContain("unit-id: unit\\n\\u001b[31mid");
		expect(lines).toContain("status: failed\\n\\u001b[31mstatus");
		expect(lines).toContain("workspace-status: active\\n\\u001b[31mstatus");
		expect(lines).toContain("workspace: /tmp/ws\\n\\u001b[31mpath");
		expect(lines).toContain("workspace-head: abc\\n\\u001b[31msha");
		expect(lines).toContain(
			"workspace-finalized-at: 2026-04-24\\n\\u001b[31mtime",
		);
		expect(lines).toContain(
			"workspace-cleanup-error: cleanup\\n\\u001b[31merror",
		);
		expect(lines).toContain(
			"  [workspace\\n\\u001b[31mscope/fact\\n\\u001b[31mkind] title\\n\\u001b[31mtitle (seen: 1)",
		);
		expect(lines.join("\n")).not.toContain("\u001b[31m");
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
