import { describe, expect, expectTypeOf, it } from "vitest";
import type {
	BuildplaneWorkspacePort,
	RunInfrastructureFailure,
	RunPacketResult,
	StatusWorkspaceSummary,
	WorkspaceSnapshot,
} from "../src/index";
import { validatePacketForWorkspaceRoot } from "../src/workspace-paths";

describe("workspace path validation", () => {
	it("exports workspace orchestration contracts", () => {
		expectTypeOf<BuildplaneWorkspacePort>().toBeObject();
		expectTypeOf<WorkspaceSnapshot>().toMatchTypeOf<{
			path: string;
			headSha: string;
			status: string;
		}>();
		expectTypeOf<StatusWorkspaceSummary>().toMatchTypeOf<{
			headSha: string;
			status: string;
			path?: string;
		}>();
		expectTypeOf<RunInfrastructureFailure>().toMatchTypeOf<{
			kind: string;
			message: string;
		}>();
		expectTypeOf<RunPacketResult>().toMatchTypeOf<{
			run: unknown;
			receipt?: unknown;
			decision?: unknown;
			failure?: unknown;
			workspace?: unknown;
		}>();
	});

	it("accepts worktree-relative cwd and outputs", () => {
		const packet = validatePacketForWorkspaceRoot(
			{
				unit: {
					id: "unit-1",
					kind: "command",
					scope: "task",
					inputRefs: [],
					expectedOutputs: ["tmp/out.txt"],
					verificationContract: "exit-0-and-required-outputs",
					policyProfile: "default",
				},
				execution: {
					command: "node",
					cwd: "packages/cli/../cli",
				},
				verification: {
					requiredOutputs: ["tmp/out.txt"],
				},
			},
			".buildplane/workspaces/future-run-id",
		);

		expect(packet.execution.cwd).toBe("packages/cli");
	});

	it("rejects workspace-root unit expected outputs", () => {
		expect(() =>
			validatePacketForWorkspaceRoot(
				{
					unit: {
						id: "unit-root-output",
						kind: "command",
						scope: "task",
						inputRefs: [],
						expectedOutputs: ["."],
						verificationContract: "exit-0-and-required-outputs",
						policyProfile: "default",
					},
					execution: {
						command: "node",
					},
					verification: {
						requiredOutputs: ["tmp/out.txt"],
					},
				},
				".buildplane/workspaces/future-run-id",
			),
		).toThrow(/must not be the worktree root/i);
	});

	it("rejects workspace-root required outputs", () => {
		expect(() =>
			validatePacketForWorkspaceRoot(
				{
					unit: {
						id: "unit-root-required-output",
						kind: "command",
						scope: "task",
						inputRefs: [],
						expectedOutputs: ["tmp/out.txt"],
						verificationContract: "exit-0-and-required-outputs",
						policyProfile: "default",
					},
					execution: {
						command: "node",
					},
					verification: {
						requiredOutputs: ["."],
					},
				},
				".buildplane/workspaces/future-run-id",
			),
		).toThrow(/must not be the worktree root/i);
	});

	it("rejects escaping cwd", () => {
		expect(() =>
			validatePacketForWorkspaceRoot(
				{
					unit: {
						id: "unit-2",
						kind: "command",
						scope: "task",
						inputRefs: [],
						expectedOutputs: ["tmp/out.txt"],
						verificationContract: "exit-0-and-required-outputs",
						policyProfile: "default",
					},
					execution: {
						command: "node",
						cwd: "../escape",
					},
					verification: {
						requiredOutputs: ["tmp/out.txt"],
					},
				},
				".buildplane/workspaces/future-run-id",
			),
		).toThrow(/outside the worktree root/i);
	});

	it("rejects absolute execution cwd", () => {
		expect(() =>
			validatePacketForWorkspaceRoot(
				{
					unit: {
						id: "unit-3",
						kind: "command",
						scope: "task",
						inputRefs: [],
						expectedOutputs: ["tmp/out.txt"],
						verificationContract: "exit-0-and-required-outputs",
						policyProfile: "default",
					},
					execution: {
						command: "node",
						cwd: "/tmp/escape",
					},
					verification: {
						requiredOutputs: ["tmp/out.txt"],
					},
				},
				".buildplane/workspaces/future-run-id",
			),
		).toThrow(/absolute/i);
	});

	it("rejects escaping unit expected outputs", () => {
		expect(() =>
			validatePacketForWorkspaceRoot(
				{
					unit: {
						id: "unit-4",
						kind: "command",
						scope: "task",
						inputRefs: [],
						expectedOutputs: ["../escape.txt"],
						verificationContract: "exit-0-and-required-outputs",
						policyProfile: "default",
					},
					execution: {
						command: "node",
					},
					verification: {
						requiredOutputs: ["tmp/out.txt"],
					},
				},
				".buildplane/workspaces/future-run-id",
			),
		).toThrow(/outside the worktree root/i);
	});

	it("rejects absolute unit expected outputs", () => {
		expect(() =>
			validatePacketForWorkspaceRoot(
				{
					unit: {
						id: "unit-5",
						kind: "command",
						scope: "task",
						inputRefs: [],
						expectedOutputs: ["/tmp/escape.txt"],
						verificationContract: "exit-0-and-required-outputs",
						policyProfile: "default",
					},
					execution: {
						command: "node",
					},
					verification: {
						requiredOutputs: ["tmp/out.txt"],
					},
				},
				".buildplane/workspaces/future-run-id",
			),
		).toThrow(/absolute/i);
	});

	it("rejects escaping required outputs", () => {
		expect(() =>
			validatePacketForWorkspaceRoot(
				{
					unit: {
						id: "unit-6",
						kind: "command",
						scope: "task",
						inputRefs: [],
						expectedOutputs: ["tmp/out.txt"],
						verificationContract: "exit-0-and-required-outputs",
						policyProfile: "default",
					},
					execution: {
						command: "node",
					},
					verification: {
						requiredOutputs: ["../escape.txt"],
					},
				},
				".buildplane/workspaces/future-run-id",
			),
		).toThrow(/outside the worktree root/i);
	});

	it("rejects absolute required outputs independently", () => {
		expect(() =>
			validatePacketForWorkspaceRoot(
				{
					unit: {
						id: "unit-7",
						kind: "command",
						scope: "task",
						inputRefs: [],
						expectedOutputs: ["tmp/out.txt"],
						verificationContract: "exit-0-and-required-outputs",
						policyProfile: "default",
					},
					execution: {
						command: "node",
					},
					verification: {
						requiredOutputs: ["/tmp/escape.txt"],
					},
				},
				".buildplane/workspaces/future-run-id",
			),
		).toThrow(/absolute/i);
	});
});
