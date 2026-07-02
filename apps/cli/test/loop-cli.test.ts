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
	it("--once runs exactly one slice end-to-end, writes loop-state, exits 0", async () => {
		const ws = mkdtempSync(join(tmpdir(), "bp-loopcli-"));
		const out: string[] = [];
		const calls: string[] = [];
		try {
			const code = await runCli(["planforge", "loop", "--once", "--json"], {
				cwd: ws,
				stdout: (l) => out.push(l),
				dependencies: loopDeps(calls) as never,
			});
			expect(code).toBe(0);
			expect(calls).toEqual(["plan", "dry-run", "admit", "dispatch"]);
			expect(existsSync(join(ws, ".buildplane", "loop-state.json"))).toBe(true);
			const state = JSON.parse(
				readFileSync(join(ws, ".buildplane", "loop-state.json"), "utf8"),
			);
			expect(state.terminal.reason).toBe("max-iterations");
			expect(state.lastMergedHeadSha).toBe("head-sha-1");
		} finally {
			rmSync(ws, { recursive: true, force: true });
		}
	});

	it("a .buildplane/loop.stop file halts before the next iteration", async () => {
		const ws = mkdtempSync(join(tmpdir(), "bp-loopstop-"));
		const out: string[] = [];
		try {
			mkdirSync(join(ws, ".buildplane"), { recursive: true });
			writeFileSync(join(ws, ".buildplane", "loop.stop"), "");
			const code = await runCli(
				["planforge", "loop", "--max-iterations=5", "--json"],
				{
					cwd: ws,
					stdout: (l) => out.push(l),
					dependencies: loopDeps([]) as never,
				},
			);
			expect(code).toBe(0);
			const state = JSON.parse(
				readFileSync(join(ws, ".buildplane", "loop-state.json"), "utf8"),
			);
			expect(state.terminal.reason).toBe("stop-file");
		} finally {
			rmSync(ws, { recursive: true, force: true });
		}
	});

	it("envelope breach pauses (terminal envelope-breach, exit 2)", async () => {
		const ws = mkdtempSync(join(tmpdir(), "bp-loopenv-"));
		const deps = loopDeps([]);
		deps.loopEnvelope.check = () =>
			({ ok: false, reason: "path glob outside envelope" }) as never;
		try {
			const code = await runCli(["planforge", "loop", "--once", "--json"], {
				cwd: ws,
				stdout: () => {},
				dependencies: deps as never,
			});
			expect(code).toBe(2);
			const state = JSON.parse(
				readFileSync(join(ws, ".buildplane", "loop-state.json"), "utf8"),
			);
			expect(state.terminal.reason).toBe("envelope-breach");
		} finally {
			rmSync(ws, { recursive: true, force: true });
		}
	});

	it("dispatch/acceptance failure sets terminal acceptance-fail, exit 1", async () => {
		const ws = mkdtempSync(join(tmpdir(), "bp-loopfail-"));
		const deps = loopDeps([]);
		// A genuine acceptance failure: the worker ran and produced side effects
		// (a diff) that the acceptance contract then rejected.
		deps.loopDispatch = async () =>
			({
				allPassed: false,
				mergedHeadSha: null,
				producedSideEffects: true,
				reasons: [],
				runs: [{ task: "PF1", run_id: "r1", status: "failed" }],
			}) as never;
		try {
			const code = await runCli(["planforge", "loop", "--once", "--json"], {
				cwd: ws,
				stdout: () => {},
				dependencies: deps as never,
			});
			expect(code).toBe(1);
			const state = JSON.parse(
				readFileSync(join(ws, ".buildplane", "loop-state.json"), "utf8"),
			);
			expect(state.terminal.reason).toBe("acceptance-fail");
		} finally {
			rmSync(ws, { recursive: true, force: true });
		}
	});

	it("worker with no side effects + non-zero exit terminates dispatch-error (not acceptance-fail), threading reasons, exit 1", async () => {
		// R1: a 429 rejection (worker rejected, 0 tokens, 0 turns, no side effects)
		// is an infra/dispatch failure, NOT an acceptance failure — it must be
		// honestly labelled so the loop is re-fireable rather than looking like the
		// worker built a rejected diff.
		const ws = mkdtempSync(join(tmpdir(), "bp-loopdisp-"));
		const deps = loopDeps([]);
		deps.loopDispatch = async () =>
			({
				allPassed: false,
				mergedHeadSha: null,
				tokenUsage: 0,
				producedSideEffects: false,
				reasons: ["worker rejected: 429 rate_limit_error (0 tokens, 0 turns)"],
				runs: [{ task: "PF1", run_id: "r1", status: "failed" }],
			}) as never;
		try {
			const code = await runCli(["planforge", "loop", "--once", "--json"], {
				cwd: ws,
				stdout: () => {},
				dependencies: deps as never,
			});
			expect(code).toBe(1);
			const state = JSON.parse(
				readFileSync(join(ws, ".buildplane", "loop-state.json"), "utf8"),
			);
			expect(state.terminal.reason).toBe("dispatch-error");
			// decision.reasons threaded into the terminal detail (no longer a hardcoded string).
			expect(state.terminal.detail).toContain("429");
		} finally {
			rmSync(ws, { recursive: true, force: true });
		}
	});

	it("worker that produced side effects but failed acceptance stays acceptance-fail, threading reasons", async () => {
		const ws = mkdtempSync(join(tmpdir(), "bp-loopacc-"));
		const deps = loopDeps([]);
		deps.loopDispatch = async () =>
			({
				allPassed: false,
				mergedHeadSha: null,
				tokenUsage: 4200,
				producedSideEffects: true,
				reasons: ["acceptance.contract: out-of-scope file src/secret.ts"],
				runs: [{ task: "PF1", run_id: "r1", status: "failed" }],
			}) as never;
		try {
			const code = await runCli(["planforge", "loop", "--once", "--json"], {
				cwd: ws,
				stdout: () => {},
				dependencies: deps as never,
			});
			expect(code).toBe(1);
			const state = JSON.parse(
				readFileSync(join(ws, ".buildplane", "loop-state.json"), "utf8"),
			);
			expect(state.terminal.reason).toBe("acceptance-fail");
			expect(state.terminal.detail).toContain("out-of-scope");
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

	it("planner reporting done terminates roadmap-complete, exit 0", async () => {
		const ws = mkdtempSync(join(tmpdir(), "bp-loopdone-"));
		const deps = loopDeps([]);
		deps.loopPlanner = async () => ({ done: true }) as never;
		try {
			const code = await runCli(["planforge", "loop", "--once", "--json"], {
				cwd: ws,
				stdout: () => {},
				dependencies: deps as never,
			});
			expect(code).toBe(0);
			const state = JSON.parse(
				readFileSync(join(ws, ".buildplane", "loop-state.json"), "utf8"),
			);
			expect(state.terminal.reason).toBe("roadmap-complete");
		} finally {
			rmSync(ws, { recursive: true, force: true });
		}
	});

	it("resumes from a persisted non-terminal loop-state (does not reset iteration)", async () => {
		const ws = mkdtempSync(join(tmpdir(), "bp-loopresume-"));
		mkdirSync(join(ws, ".buildplane"), { recursive: true });
		const persisted = {
			version: 1,
			iteration: 2,
			maxIterations: 5,
			envelopeRef: "env-1",
			trustedBase: null,
			lastMergedHeadSha: "head-2",
			cumulativeTokenDeltas: 0,
			tokenBudget: null,
			phase: "plan",
			currentSliceId: null,
			currentPlanPath: null,
			terminal: null,
			updatedAt: new Date().toISOString(),
		};
		writeFileSync(
			join(ws, ".buildplane", "loop-state.json"),
			JSON.stringify(persisted),
		);
		// Stop immediately so the resume assertion is deterministic.
		writeFileSync(join(ws, ".buildplane", "loop.stop"), "");
		try {
			await runCli(["planforge", "loop", "--json"], {
				cwd: ws,
				stdout: () => {},
				dependencies: {
					loopPlanner: async () => ({ done: true }),
				} as never,
			});
			const state = JSON.parse(
				readFileSync(join(ws, ".buildplane", "loop-state.json"), "utf8"),
			);
			expect(state.iteration).toBe(2); // resumed, not reset to 0
			expect(state.terminal.reason).toBe("stop-file");
		} finally {
			rmSync(ws, { recursive: true, force: true });
		}
	});

	it("cumulative per-dispatch token usage past the envelope token_budget terminates token-budget", async () => {
		// GAP-7 CRITICAL-2: each dispatch reports real token usage; the supervisor
		// accumulates it across iterations and STOPS once the cumulative total
		// exceeds the envelope's token_budget.
		const ws = mkdtempSync(join(tmpdir(), "bp-looptok-"));
		const deps = loopDeps([]);
		// Envelope pins a cumulative token budget of 100.
		deps.loopEnvelope.load = async () =>
			({ envelope: { token_budget: 100 } }) as never;
		// Each dispatch burns 60 tokens → iteration 1 = 60 (under), iteration 2 = 120 (over).
		deps.loopDispatch = async () =>
			({
				allPassed: true,
				mergedHeadSha: "head-sha-1",
				tokenUsage: 60,
				runs: [{ task: "PF1", run_id: "r1", status: "passed" }],
			}) as never;
		// Never roadmap-complete; only the token budget should stop the loop.
		try {
			const code = await runCli(
				["planforge", "loop", "--max-iterations=10", "--json"],
				{
					cwd: ws,
					stdout: () => {},
					dependencies: deps as never,
				},
			);
			const state = JSON.parse(
				readFileSync(join(ws, ".buildplane", "loop-state.json"), "utf8"),
			);
			expect(state.terminal.reason).toBe("token-budget");
			expect(state.cumulativeTokenDeltas).toBeGreaterThan(100);
			expect(code).toBe(0);
		} finally {
			rmSync(ws, { recursive: true, force: true });
		}
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
});
