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
import { runCli } from "../src/run-cli.js";

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
		deps.loopDispatch = async () =>
			({
				allPassed: false,
				mergedHeadSha: null,
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
});
