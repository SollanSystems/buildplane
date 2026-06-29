import type { ClaudeToolEvent } from "@buildplane/adapters-models";
import { describe, expect, it } from "vitest";
import { createClaudeToolLedgerEmitter } from "../src/claude-tool-ledger-emitter.js";

interface EmittedEvent {
	kind: string;
	payload: Record<string, unknown>;
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
			emitted.push({ kind, payload: payload as Record<string, unknown>, opts });
		},
		emitted,
	};
}

const UNIT_CTX = {
	unitId: "u-1",
	parentEventId: "01919000-0000-7000-8000-000000000010",
};

const PROJECT_ROOT = "/work/buildplane";

describe("createClaudeToolLedgerEmitter", () => {
	it("maps a tool_use request → one tool_request / ToolRequestStoredV1 event", () => {
		const emitter = createMockEmitter();
		const sink = createClaudeToolLedgerEmitter(
			emitter,
			() => UNIT_CTX,
			PROJECT_ROOT,
		);

		const request: ClaudeToolEvent = {
			phase: "request",
			toolUseId: "toolu_abc",
			toolName: "Bash",
			input: { command: "ls -la" },
		};
		sink(request);

		expect(emitter.emitted).toHaveLength(1);
		const ev = emitter.emitted[0];
		expect(ev.kind).toBe("tool_request");
		expect(ev.opts?.parent).toBe(UNIT_CTX.parentEventId);
		expect(ev.opts?.id).toBeDefined();
		const stored = (
			ev.payload as { ToolRequestStoredV1: Record<string, unknown> }
		).ToolRequestStoredV1;
		expect(stored.tool_name).toBe("Bash");
		expect(stored.arguments).toEqual({ command: "ls -la" });
		expect(stored.unit_id).toBe("u-1");
		expect(stored.working_directory).toBe(PROJECT_ROOT);
		expect(stored.working_directory).not.toBe("");
		expect(stored.env).toMatchObject({ redacted: true, hint: "env_var" });
	});

	it("maps a tool_result → one ToolResultV1 whose tool_request_id is the request event id", () => {
		const emitter = createMockEmitter();
		const sink = createClaudeToolLedgerEmitter(
			emitter,
			() => UNIT_CTX,
			PROJECT_ROOT,
		);

		sink({
			phase: "request",
			toolUseId: "toolu_abc",
			toolName: "Bash",
			input: {},
		});
		const requestEventId = emitter.emitted[0].opts?.id;

		sink({
			phase: "result",
			toolUseId: "toolu_abc",
			content: "total 0",
			isError: false,
		});

		expect(emitter.emitted).toHaveLength(2);
		const ev = emitter.emitted[1];
		expect(ev.kind).toBe("tool_result");
		expect(ev.opts?.parent).toBe(requestEventId);
		const out = (ev.payload as { ToolResultV1: Record<string, unknown> })
			.ToolResultV1;
		expect(out.tool_request_id).toBe(requestEventId);
		expect(out.stdout).toBe("total 0");
		expect(out.stderr).toBe("");
		expect(out.output).toEqual({ is_error: false });
		expect(typeof out.duration_ms).toBe("number");
	});

	it("routes an error result content to stderr and flags is_error", () => {
		const emitter = createMockEmitter();
		const sink = createClaudeToolLedgerEmitter(
			emitter,
			() => UNIT_CTX,
			PROJECT_ROOT,
		);

		sink({ phase: "request", toolUseId: "t1", toolName: "Bash", input: {} });
		sink({
			phase: "result",
			toolUseId: "t1",
			content: "boom",
			isError: true,
		});

		const out = (
			emitter.emitted[1].payload as { ToolResultV1: Record<string, unknown> }
		).ToolResultV1;
		expect(out.stdout).toBe("");
		expect(out.stderr).toBe("boom");
		expect(out.output).toEqual({ is_error: true });
	});

	it("drops a result with no matching request (no orphan event)", () => {
		const emitter = createMockEmitter();
		const sink = createClaudeToolLedgerEmitter(
			emitter,
			() => UNIT_CTX,
			PROJECT_ROOT,
		);

		sink({
			phase: "result",
			toolUseId: "unknown",
			content: "x",
			isError: false,
		});

		expect(emitter.emitted).toHaveLength(0);
	});

	it("correlates interleaved tool calls by tool_use_id", () => {
		const emitter = createMockEmitter();
		const sink = createClaudeToolLedgerEmitter(
			emitter,
			() => UNIT_CTX,
			PROJECT_ROOT,
		);

		sink({ phase: "request", toolUseId: "a", toolName: "Bash", input: {} });
		sink({ phase: "request", toolUseId: "b", toolName: "Write", input: {} });
		const idA = emitter.emitted[0].opts?.id;
		const idB = emitter.emitted[1].opts?.id;

		sink({ phase: "result", toolUseId: "b", content: "B", isError: false });
		sink({ phase: "result", toolUseId: "a", content: "A", isError: false });

		const resB = (
			emitter.emitted[2].payload as { ToolResultV1: Record<string, unknown> }
		).ToolResultV1;
		const resA = (
			emitter.emitted[3].payload as { ToolResultV1: Record<string, unknown> }
		).ToolResultV1;
		expect(resB.tool_request_id).toBe(idB);
		expect(resB.stdout).toBe("B");
		expect(resA.tool_request_id).toBe(idA);
		expect(resA.stdout).toBe("A");
	});
});
