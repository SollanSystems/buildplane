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
	emit: (
		kind: string,
		payload: unknown,
		opts?: { parent?: string; id?: string },
	) => void;
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

			const result = wrapped.write_file({
				path: join(dir, "out.txt"),
				content: "hello",
			});

			expect(result.success).toBe(true);
			expect(rawRegistry.write_file).toHaveBeenCalledOnce();

			const kinds = emitter.emitted.map((e) => e.kind);
			expect(kinds).toEqual(["tool_request", "workspace_write", "tool_result"]);

			const toolReq = emitter.emitted[0];
			expect(toolReq.opts?.parent).toBe("01919000-0000-7000-8000-000000000010");

			const wsWrite = emitter.emitted[1].payload as {
				WorkspaceWriteV1: {
					hash_before: string | null;
					after: { status: string; hash: string };
				};
			};
			expect(wsWrite.WorkspaceWriteV1.hash_before).toBeNull();
			expect(wsWrite.WorkspaceWriteV1.after.status).toBe("captured");
			expect(wsWrite.WorkspaceWriteV1.after.hash).toMatch(/^sha256:/);

			const toolRes = emitter.emitted[2].payload as {
				ToolResultV1: { output: { success: boolean } };
			};
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
		const toolRes = emitter.emitted[1].payload as {
			ToolResultV1: { output: { success: boolean } };
		};
		expect(toolRes.ToolResultV1.output).toEqual({ success: false });
	});

	it("emits with parent_event_id = undefined when getUnitCtx returns null", () => {
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
			ToolResultV1: {
				stdout: string;
				stderr: string;
				exit_code: number | null;
			};
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

		wrapped.run_command({
			command: "sh",
			args: ["-c", "echo hi > /tmp/shell-out"],
		});

		const kinds = emitter.emitted.map((e) => e.kind);
		expect(kinds).not.toContain("workspace_write");
	});
});
