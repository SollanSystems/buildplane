import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { makeDefaultLoopDispatch, runCli } from "../src/run-cli.js";

function loopDeps(calls: string[]) {
	return {
		loopPlanner: async () => {
			calls.push("plan");
			return {
				planPath: "/tmp/plan.md",
				sliceId: "M5-S2",
				milestone: "M5",
			};
		},
		loopEnvelope: {
			load: async () => ({ ref: "env-1", milestone: "M5" }),
			check: () => ({ ok: true as const }),
		},
		loopDryRun: async () => {
			calls.push("dry-run");
			return { ok: true as const, plan: { id: "M5-S2", tasks: [] } };
		},
		loopAdmit: async () => {
			calls.push("admit");
			return { admittedEventId: "42" };
		},
		loopDispatch: async () => {
			calls.push("dispatch");
			return {
				allPassed: true,
				mergedHeadSha: "head-sha-1",
				runs: [{ task: "PF1", run_id: "r1", status: "passed" }],
			};
		},
	};
}

describe("buildplane planforge loop", () => {
	it("hard-blocks the legacy loop before injected dependencies or state mutation", async () => {
		const ws = mkdtempSync(join(tmpdir(), "bp-loopcli-"));
		const out: string[] = [];
		const calls: string[] = [];
		try {
			const code = await runCli(["planforge", "loop", "--once", "--json"], {
				cwd: ws,
				stdout: (l) => out.push(l),
				dependencies: loopDeps(calls) as never,
			});
			expect(code).toBe(1);
			expect(calls).toEqual([]);
			expect(out.join("\n")).toContain("PlanForge legacy execution is blocked");
			expect(existsSync(join(ws, ".buildplane", "loop-state.json"))).toBe(
				false,
			);
			expect(existsSync(join(ws, ".buildplane"))).toBe(false);
		} finally {
			rmSync(ws, { recursive: true, force: true });
		}
	});

	it("planforge loop --reset clears a terminal loop-state file, exit 0", async () => {
		const ws = mkdtempSync(join(tmpdir(), "bp-loopresetcli-"));
		mkdirSync(join(ws, ".buildplane"), { recursive: true });
		const terminalState = {
			version: 1,
			iteration: 1,
			maxIterations: 1,
			envelopeRef: null,
			trustedBase: null,
			lastMergedHeadSha: null,
			cumulativeTokenDeltas: 0,
			tokenBudget: null,
			phase: "accept",
			currentSliceId: "M6-R1",
			currentPlanPath: "/tmp/plan.md",
			terminal: { reason: "dispatch-error", detail: "429 rate limit" },
			updatedAt: new Date().toISOString(),
		};
		writeFileSync(
			join(ws, ".buildplane", "loop-state.json"),
			JSON.stringify(terminalState),
		);
		try {
			const code = await runCli(["planforge", "loop", "--reset", "--json"], {
				cwd: ws,
				stdout: () => {},
				dependencies: loopDeps([]) as never,
			});
			expect(code).toBe(0);
			expect(existsSync(join(ws, ".buildplane", "loop-state.json"))).toBe(
				false,
			);
		} finally {
			rmSync(ws, { recursive: true, force: true });
		}
	});

	it("planforge loop --help documents --reset", async () => {
		const out: string[] = [];
		await runCli(["planforge", "--help"], {
			cwd: process.cwd(),
			stdout: (l) => out.push(l),
		});
		expect(out.join("\n")).toMatch(/--reset/);
	});

	it("planforge --help lists the loop command", async () => {
		const out: string[] = [];
		await runCli(["planforge", "--help"], {
			cwd: process.cwd(),
			stdout: (l) => out.push(l),
		});
		expect(out.join("\n")).toMatch(/planforge loop/);
	});

	it("planforge loop --help documents the --model override", async () => {
		const out: string[] = [];
		await runCli(["planforge", "--help"], {
			cwd: process.cwd(),
			stdout: (l) => out.push(l),
		});
		expect(out.join("\n")).toMatch(/--model/);
	});

	it("planforge loop --help documents the worker permission + timeout flags (R7)", async () => {
		const out: string[] = [];
		await runCli(["planforge", "--help"], {
			cwd: process.cwd(),
			stdout: (l) => out.push(l),
		});
		const help = out.join("\n");
		expect(help).toMatch(/--worker-allowed-tools/);
		expect(help).toMatch(/--worker-timeout-ms/);
	});
});

describe("makeDefaultLoopDispatch — model override", () => {
	const guard = { budgets: undefined } as never;

	it("threads the model override into the dispatch command opts", async () => {
		const captured: Array<Record<string, unknown> | undefined> = [];
		const spyDispatch = (async (
			_args: readonly string[],
			_cwd: string,
			_stdout: (line: string) => void,
			opts?: Record<string, unknown>,
		) => {
			captured.push(opts);
			return 0;
		}) as never;
		const dispatch = makeDefaultLoopDispatch(
			12,
			spyDispatch,
			"claude-opus-4-8",
		);
		await dispatch("/tmp/plan.md", "/tmp/ws", guard);
		expect(captured).toHaveLength(1);
		expect(captured[0]?.model).toBe("claude-opus-4-8");
	});

	it("passes model undefined when no override is given (default resolves in dispatchAdmittedPlan)", async () => {
		const captured: Array<Record<string, unknown> | undefined> = [];
		const spyDispatch = (async (
			_args: readonly string[],
			_cwd: string,
			_stdout: (line: string) => void,
			opts?: Record<string, unknown>,
		) => {
			captured.push(opts);
			return 0;
		}) as never;
		const dispatch = makeDefaultLoopDispatch(12, spyDispatch);
		await dispatch("/tmp/plan.md", "/tmp/ws", guard);
		expect(captured[0]?.model).toBeUndefined();
	});

	it("threads the worker allowedTools grant + timeout into the dispatch command opts (R7 FIX 1/2)", async () => {
		const captured: Array<Record<string, unknown> | undefined> = [];
		const spyDispatch = (async (
			_args: readonly string[],
			_cwd: string,
			_stdout: (line: string) => void,
			opts?: Record<string, unknown>,
		) => {
			captured.push(opts);
			return 0;
		}) as never;
		const dispatch = makeDefaultLoopDispatch(
			12,
			spyDispatch,
			undefined,
			["Edit", "Write", "Bash"],
			900_000,
		);
		await dispatch("/tmp/plan.md", "/tmp/ws", guard);
		expect(captured[0]?.claudeAllowedTools).toEqual(["Edit", "Write", "Bash"]);
		expect(captured[0]?.claudeTimeoutMs).toBe(900_000);
	});
});
