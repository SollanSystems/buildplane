import { describe, expect, it } from "vitest";
import type { RunOutcome } from "../src/memory-types.js";
import {
	aggregateOutcomeScores,
	chooseWorker,
	seededUnitInterval,
} from "../src/outcome-scoring.js";

const row = (
	worker: RunOutcome["worker"],
	success: boolean,
	createdAt: string,
): RunOutcome => ({
	id: createdAt,
	repoId: "/r",
	taskType: "implement",
	worker,
	success,
	sourceRunId: createdAt,
	createdAt,
});

const HALF = 7 * 24 * 60 * 60 * 1000; // 7-day half-life
const now = Date.parse("2026-05-28T00:00:00.000Z");

describe("aggregateOutcomeScores", () => {
	it("weights recent rows higher (one half-life ⇒ weight 0.5)", () => {
		const old = new Date(now - HALF).toISOString();
		const scores = aggregateOutcomeScores(
			[
				row("codex", true, new Date(now).toISOString()),
				row("codex", false, old),
			],
			{ halfLifeMs: HALF, now },
		);
		const c = scores.get("codex")!;
		expect(c.decayedSamples).toBeCloseTo(1.5, 5); // 1.0 + 0.5
		expect(c.decayedSuccess).toBeCloseTo(1.0, 5); // 1*1 + 0.5*0
		expect(c.rate).toBeCloseTo(1.0 / 1.5, 5);
		expect(c.rawSamples).toBe(2); // undecayed count (cold-start coverage)
	});

	it("groups by worker and is empty for no rows", () => {
		expect(aggregateOutcomeScores([], { halfLifeMs: HALF, now }).size).toBe(0);
	});

	it("groups distinct workers independently", () => {
		const at = new Date(now).toISOString();
		const scores = aggregateOutcomeScores(
			[
				row("codex", true, at),
				row("claude-code", false, at),
				row("claude-code", true, at),
			],
			{ halfLifeMs: HALF, now },
		);
		expect(scores.get("codex")!.rawSamples).toBe(1);
		expect(scores.get("claude-code")!.rawSamples).toBe(2);
		expect(scores.get("claude-code")!.rate).toBeCloseTo(0.5, 5);
	});

	it("clamps future-dated rows to weight 1 (non-negative age)", () => {
		const future = new Date(now + HALF).toISOString();
		const scores = aggregateOutcomeScores([row("codex", true, future)], {
			halfLifeMs: HALF,
			now,
		});
		expect(scores.get("codex")!.decayedSamples).toBeCloseTo(1, 5);
	});
});

const CANDS = ["sdk", "claude-code", "codex"] as const;

function explorerSeedUnder(p: number): number {
	for (let seed = 0; seed < 100_000; seed++) {
		if (seededUnitInterval(seed) < p) return seed;
	}
	throw new Error(`no seed produced a value < ${p}`);
}

describe("chooseWorker", () => {
	it("cold start: routes to the least-sampled candidate (seed-free, RAW count) until coverage", () => {
		const scores = new Map([
			[
				"sdk" as const,
				{ decayedSuccess: 8, decayedSamples: 8, rate: 1, rawSamples: 8 },
			],
			[
				"codex" as const,
				{ decayedSuccess: 2, decayedSamples: 2, rate: 1, rawSamples: 2 },
			],
		]);
		expect(
			chooseWorker(scores, { candidates: CANDS, minSamples: 5, epsilon: 0 }),
		).toBe("claude-code");
	});

	it("at zero data, rotates by least-sampled (tie → candidate order)", () => {
		expect(
			chooseWorker(new Map(), { candidates: CANDS, minSamples: 5, epsilon: 0 }),
		).toBe("sdk");
	});

	it("coverage uses RAW count, not decayed (a decayed-thin but raw-covered worker is not re-warmed)", () => {
		const scores = new Map([
			[
				"sdk" as const,
				{ decayedSuccess: 9, decayedSamples: 10, rate: 0.9, rawSamples: 10 },
			],
			[
				"claude-code" as const,
				{ decayedSuccess: 0.6, decayedSamples: 1.2, rate: 0.5, rawSamples: 6 },
			],
			[
				"codex" as const,
				{ decayedSuccess: 5, decayedSamples: 10, rate: 0.5, rawSamples: 10 },
			],
		]);
		// all raw ≥ 5 ⇒ no cold start ⇒ exploit best rate ⇒ sdk
		expect(
			chooseWorker(scores, { candidates: CANDS, minSamples: 5, epsilon: 0 }),
		).toBe("sdk");
	});

	it("exploits the highest-rate candidate once all candidates are covered", () => {
		const scores = new Map([
			[
				"sdk" as const,
				{ decayedSuccess: 5, decayedSamples: 10, rate: 0.5, rawSamples: 10 },
			],
			[
				"claude-code" as const,
				{ decayedSuccess: 6, decayedSamples: 10, rate: 0.6, rawSamples: 10 },
			],
			[
				"codex" as const,
				{ decayedSuccess: 9, decayedSamples: 10, rate: 0.9, rawSamples: 10 },
			],
		]);
		expect(
			chooseWorker(scores, { candidates: CANDS, minSamples: 5, epsilon: 0 }),
		).toBe("codex");
	});

	it("optional steady-state ε re-explores least-sampled when a per-run seed falls under ε", () => {
		const scores = new Map([
			// all raw ≥ minSamples ⇒ past cold start
			[
				"sdk" as const,
				{ decayedSuccess: 50, decayedSamples: 50, rate: 1, rawSamples: 50 },
			],
			[
				"claude-code" as const,
				{ decayedSuccess: 6, decayedSamples: 6, rate: 1, rawSamples: 6 },
			],
			[
				"codex" as const,
				{ decayedSuccess: 9, decayedSamples: 9, rate: 1, rawSamples: 9 },
			],
		]);
		const seed = explorerSeedUnder(0.2);
		expect(
			chooseWorker(scores, {
				candidates: CANDS,
				minSamples: 5,
				epsilon: 0.2,
				exploreSeed: seed,
			}),
		).toBe("claude-code");
	});

	it("ε is inert without a seed (V1 default): exploits even with epsilon > 0", () => {
		const scores = new Map([
			[
				"sdk" as const,
				{ decayedSuccess: 50, decayedSamples: 50, rate: 1, rawSamples: 50 },
			],
			[
				"claude-code" as const,
				{ decayedSuccess: 3, decayedSamples: 6, rate: 0.5, rawSamples: 6 },
			],
			[
				"codex" as const,
				{ decayedSuccess: 9, decayedSamples: 9, rate: 1, rawSamples: 9 },
			],
		]);
		// epsilon > 0 but no exploreSeed ⇒ no exploration ⇒ exploit best rate (sdk/codex tie → first = sdk)
		expect(
			chooseWorker(scores, {
				candidates: CANDS,
				minSamples: 5,
				epsilon: 0.5,
			}),
		).toBe("sdk");
	});

	it("returns undefined for an empty candidate set", () => {
		expect(
			chooseWorker(new Map(), { candidates: [], minSamples: 5, epsilon: 0 }),
		).toBeUndefined();
	});

	it("seededUnitInterval is deterministic and in [0,1)", () => {
		const v = seededUnitInterval(42);
		expect(v).toBe(seededUnitInterval(42));
		expect(v).toBeGreaterThanOrEqual(0);
		expect(v).toBeLessThan(1);
	});
});
