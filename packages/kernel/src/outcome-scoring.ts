import type { RunOutcome, WorkerLabel } from "./memory-types.js";

export interface WorkerScore {
	readonly decayedSuccess: number;
	readonly decayedSamples: number;
	readonly rate: number;
	readonly rawSamples: number; // undecayed row count — drives cold-start coverage (R4)
}

export function aggregateOutcomeScores(
	rows: readonly RunOutcome[],
	opts: { halfLifeMs: number; now: number },
): Map<WorkerLabel, WorkerScore> {
	const acc = new Map<WorkerLabel, { s: number; n: number; raw: number }>();
	for (const r of rows) {
		const ageMs = opts.now - Date.parse(r.createdAt);
		const w = 2 ** (-Math.max(0, ageMs) / opts.halfLifeMs);
		const cur = acc.get(r.worker) ?? { s: 0, n: 0, raw: 0 };
		acc.set(r.worker, {
			s: cur.s + (r.success ? w : 0),
			n: cur.n + w,
			raw: cur.raw + 1,
		});
	}
	const out = new Map<WorkerLabel, WorkerScore>();
	for (const [worker, { s, n, raw }] of acc) {
		out.set(worker, {
			decayedSuccess: s,
			decayedSamples: n,
			rate: n > 0 ? s / n : 0,
			rawSamples: raw,
		});
	}
	return out;
}

export function seededUnitInterval(seed: number): number {
	// deterministic hash → [0,1); no RNG so routes are reproducible
	let x = (seed ^ 0x9e3779b9) >>> 0;
	x = Math.imul(x ^ (x >>> 16), 0x45d9f3b) >>> 0;
	x = Math.imul(x ^ (x >>> 16), 0x45d9f3b) >>> 0;
	return ((x ^ (x >>> 16)) >>> 0) / 0x100000000;
}

export function chooseWorker(
	scores: Map<WorkerLabel, WorkerScore>,
	opts: {
		candidates: readonly WorkerLabel[];
		minSamples: number;
		epsilon: number;
		exploreSeed?: number; // per-RUN seed; only consulted post-coverage
	},
): WorkerLabel | undefined {
	if (opts.candidates.length === 0) return undefined;
	const raw = (w: WorkerLabel) => scores.get(w)?.rawSamples ?? 0;
	// least-by-RAW-count candidate; `<=` makes ties resolve to the earlier candidate (deterministic)
	const leastSampled = () =>
		opts.candidates.reduce((a, b) => (raw(a) <= raw(b) ? a : b));
	// 1. cold-start coverage (seed-free) on RAW counts — monotonic, so it converges (R4 P2);
	//    decayed samples could shrink back under minSamples and chase coverage forever.
	if (opts.candidates.some((w) => raw(w) < opts.minSamples)) {
		return leastSampled();
	}
	// 2. optional steady-state exploration — needs a per-RUN seed (never a per-unit one)
	if (
		opts.epsilon > 0 &&
		opts.exploreSeed !== undefined &&
		seededUnitInterval(opts.exploreSeed) < opts.epsilon
	) {
		return leastSampled();
	}
	// 3. exploit: highest DECAYED rate (all candidates are covered here)
	return opts.candidates.reduce((best, w) =>
		(scores.get(w)?.rate ?? 0) > (scores.get(best)?.rate ?? 0) ? w : best,
	);
}
