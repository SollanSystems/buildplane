import type { WorkerLabel } from "./memory-types.js";
import { aggregateOutcomeScores, chooseWorker } from "./outcome-scoring.js";
import type { BuildplaneStoragePort } from "./ports.js";
import type { UnitPacket } from "./run-loop.js";

export interface OutcomeRoutingConfig {
	readonly enabled: boolean;
	readonly epsilon: number;
	readonly halfLifeMs: number;
	readonly minSamples: number;
	readonly candidates: readonly WorkerLabel[];
}

export const defaultOutcomeRoutingConfig: OutcomeRoutingConfig = {
	enabled: false, // opt-in
	epsilon: 0, // V1: no per-run seed threaded ⇒ ε must be 0 (R4 P2)
	halfLifeMs: 14 * 24 * 60 * 60 * 1000,
	minSamples: 5,
	candidates: ["sdk", "claude-code", "codex"],
};

export function fillRoutingHints(
	packet: UnitPacket,
	storage: BuildplaneStoragePort,
	cfg: OutcomeRoutingConfig,
	now: number,
	exploreSeed?: number, // per-RUN seed (optional ε)
): UnitPacket {
	if (!cfg.enabled) return packet;
	if (packet.model === undefined) return packet; // model packets only (D5/R4; run-loop.ts:33)
	if (packet.routingHints?.preferredWorker) return packet; // never override
	const taskType = packet.intent?.taskType ?? packet.unit.kind;
	const scores = aggregateOutcomeScores(storage.listRunOutcomes({ taskType }), {
		halfLifeMs: cfg.halfLifeMs,
		now,
	});
	const worker = chooseWorker(scores, {
		candidates: cfg.candidates,
		minSamples: cfg.minSamples,
		epsilon: cfg.epsilon,
		exploreSeed,
	});
	if (!worker || worker === "sdk") return packet; // sdk ⇒ leave hint absent
	return {
		...packet,
		routingHints: { ...packet.routingHints, preferredWorker: worker },
	};
}
