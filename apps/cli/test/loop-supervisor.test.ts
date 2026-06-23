import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	buildEnvelopeProposal,
	initialLoopState,
	loopStatePath,
	nextLoopState,
	readLoopState,
	stopFileRequested,
	writeLoopStateAtomic,
} from "../src/loop-supervisor.js";

describe("loop-supervisor FSM", () => {
	it("advances phase plan→dry-run and bumps iteration on advance", () => {
		const s0 = initialLoopState({ maxIterations: 3, tokenBudget: null });
		expect(s0.iteration).toBe(0);
		expect(s0.phase).toBe("plan");
		const s1 = nextLoopState(s0, {
			type: "slice-selected",
			sliceId: "M5-S2",
			planPath: "/p/plan.md",
		});
		expect(s1.phase).toBe("dry-run");
		expect(s1.currentSliceId).toBe("M5-S2");
		const sMerged = nextLoopState(
			{ ...s1, phase: "reanchor" },
			{ type: "merged", headSha: "abc123" },
		);
		expect(sMerged.lastMergedHeadSha).toBe("abc123");
		const sAdv = nextLoopState(
			{ ...sMerged, phase: "advance" },
			{ type: "advance" },
		);
		expect(sAdv.iteration).toBe(1);
		expect(sAdv.phase).toBe("plan");
	});

	it("reaching maxIterations sets a terminal", () => {
		const s = {
			...initialLoopState({ maxIterations: 1, tokenBudget: null }),
			iteration: 1,
			phase: "advance" as const,
		};
		const t = nextLoopState(s, { type: "advance" });
		expect(t.terminal).toEqual({ reason: "max-iterations" });
	});

	it("acceptance-fail sets terminal acceptance-fail", () => {
		const s = {
			...initialLoopState({ maxIterations: null, tokenBudget: null }),
			phase: "accept" as const,
		};
		const t = nextLoopState(s, {
			type: "acceptance-failed",
			detail: "pnpm vitest exit 1",
		});
		expect(t.terminal?.reason).toBe("acceptance-fail");
	});

	it("cumulative token deltas crossing tokenBudget sets terminal token-budget", () => {
		const s = initialLoopState({ maxIterations: null, tokenBudget: 100 });
		const a = nextLoopState(s, { type: "token-deltas-observed", count: 60 });
		expect(a.cumulativeTokenDeltas).toBe(60);
		expect(a.terminal).toBeNull();
		const b = nextLoopState(a, { type: "token-deltas-observed", count: 60 });
		expect(b.cumulativeTokenDeltas).toBe(120);
		expect(b.terminal?.reason).toBe("token-budget");
	});

	it("a terminal state is sticky — further transitions are no-ops", () => {
		const s = initialLoopState({ maxIterations: null, tokenBudget: null });
		const stopped = nextLoopState(s, { type: "stop-file" });
		expect(stopped.terminal?.reason).toBe("stop-file");
		const after = nextLoopState(stopped, {
			type: "slice-selected",
			sliceId: "X",
			planPath: "/p",
		});
		expect(after).toBe(stopped);
	});

	it("atomic write then read round-trips state", () => {
		const ws = mkdtempSync(join(tmpdir(), "bp-loop-"));
		try {
			const s = initialLoopState({ maxIterations: 2, tokenBudget: null });
			writeLoopStateAtomic(ws, s);
			expect(readLoopState(ws)).toEqual(s);
			expect(loopStatePath(ws)).toContain("loop-state.json");
		} finally {
			rmSync(ws, { recursive: true, force: true });
		}
	});

	it("detects the .buildplane/loop.stop file", () => {
		const ws = mkdtempSync(join(tmpdir(), "bp-loop-"));
		try {
			expect(stopFileRequested(ws)).toBe(false);
			mkdirSync(join(ws, ".buildplane"), { recursive: true });
			writeFileSync(join(ws, ".buildplane", "loop.stop"), "");
			expect(stopFileRequested(ws)).toBe(true);
		} finally {
			rmSync(ws, { recursive: true, force: true });
		}
	});

	it("buildEnvelopeProposal unions task allowedSideEffects + verificationCommands and derives pathGlobs", () => {
		const plan = {
			id: "M5-S2",
			tasks: [
				{
					id: "PF1",
					allowedSideEffects: ["code-edit"],
					verificationCommands: ["pnpm vitest run a"],
				},
				{
					id: "PF2",
					allowedSideEffects: ["code-edit", "fs-write"],
					verificationCommands: ["cargo test"],
				},
			],
		};
		const proposal = buildEnvelopeProposal(plan as never, "M5");
		expect([...proposal.sideEffects].sort()).toEqual(["code-edit", "fs-write"]);
		expect([...proposal.verificationCommands].sort()).toEqual([
			"cargo test",
			"pnpm vitest run a",
		]);
		expect(Array.isArray(proposal.pathGlobs)).toBe(true);
		expect(proposal.milestone).toBe("M5");
	});
});
