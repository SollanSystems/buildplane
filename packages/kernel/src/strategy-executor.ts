import type { EventBus } from "./events.js";
import type { GraphResult, UnitGraph } from "./graph.js";
import type {
	PolicyDecision,
	RunPacketResult,
	UnitPacket,
} from "./run-loop.js";
import type { MergeDecision, StrategyPacket, StrategyResult } from "./types.js";

export interface StrategyOrchestrator {
	runPacketAsync(
		packet: UnitPacket,
		eventBus?: EventBus,
	): Promise<RunPacketResult>;
	runGraphAsync(graph: UnitGraph, eventBus?: EventBus): Promise<GraphResult>;
}

/**
 * Execute a StrategyPacket using the provided orchestrator.
 *
 * Supports "single" and "implement-then-review" modes. Other modes
 * are not yet implemented and will throw.
 */
export async function runStrategy(
	strategy: StrategyPacket,
	orchestrator: StrategyOrchestrator,
	eventBus?: EventBus,
): Promise<StrategyResult> {
	switch (strategy.mode) {
		case "single":
			return runSingleMode(strategy, orchestrator, eventBus);
		case "implement-then-review":
			return runImplementThenReviewMode(strategy, orchestrator, eventBus);
		default:
			throw new Error(
				`Strategy mode '${strategy.mode}' is not yet implemented`,
			);
	}
}

async function runSingleMode(
	strategy: StrategyPacket,
	orchestrator: StrategyOrchestrator,
	eventBus?: EventBus,
): Promise<StrategyResult> {
	if (strategy.children.length !== 1) {
		throw new Error(
			`Strategy mode 'single' requires exactly 1 child, got ${strategy.children.length}`,
		);
	}

	const child = strategy.children[0];
	const packetResult = await orchestrator.runPacketAsync(
		child.packet,
		eventBus,
	);

	const childResults = new Map<string, RunPacketResult>();
	childResults.set(child.packet.unit.id, packetResult);

	const accepted = packetResult.run.status === "passed";

	const mergeDecision: MergeDecision = {
		policy: "direct",
		outcome: accepted ? "accepted" : "rejected",
		reasons: accepted ? ["single child passed"] : ["single child did not pass"],
	};

	return {
		strategyId: strategy.id,
		mode: strategy.mode,
		outcome: accepted ? "passed" : "failed",
		childResults,
		winnerRunId: accepted ? packetResult.run.id : undefined,
		mergeDecision,
	};
}

const MAX_REVIEW_ROUNDS = 2;

function syntheticResult(
	graphResult: GraphResult,
	unitId: string,
): RunPacketResult {
	const node = graphResult.nodes.find((n) => n.unitId === unitId);
	const runId = node?.runId ?? "unknown";
	const status = node?.status === "passed" ? "passed" : "failed";

	const decision: PolicyDecision | undefined =
		node?.decisionReasons && node.decisionReasons.length > 0
			? status === "passed"
				? {
						kind: "advance-run" as const,
						outcome: "approved" as const,
						reasons: [...node.decisionReasons],
					}
				: {
						kind: "reject-run" as const,
						outcome: "rejected" as const,
						reasons: [...node.decisionReasons],
					}
			: undefined;

	return {
		run: { id: runId, unitId, status },
		decision,
	};
}

async function runImplementThenReviewMode(
	strategy: StrategyPacket,
	orchestrator: StrategyOrchestrator,
	eventBus?: EventBus,
): Promise<StrategyResult> {
	const implementer = strategy.children.find((c) => c.role === "implementer");
	const reviewer = strategy.children.find((c) => c.role === "reviewer");

	if (!implementer || !reviewer || strategy.children.length !== 2) {
		throw new Error(
			"Strategy mode 'implement-then-review' requires exactly 2 children: one 'implementer' and one 'reviewer'",
		);
	}

	// Track results per round so earlier rounds are not overwritten
	const allRoundResults: Array<Map<string, RunPacketResult>> = [];

	// The implementer packet is mutated between rounds to inject reviewer feedback
	let currentImplementerPacket = implementer.packet;

	for (let round = 0; round < MAX_REVIEW_ROUNDS; round++) {
		// Build a dependency graph: reviewer depends on implementer
		const graph: UnitGraph = {
			nodes: [
				{ ...currentImplementerPacket },
				{
					...reviewer.packet,
					dependsOn: [implementer.packet.unit.id],
				},
			],
			maxConcurrent: 1,
		};

		const graphResult = await orchestrator.runGraphAsync(graph, eventBus);

		const implNode = graphResult.nodes.find(
			(n) => n.unitId === implementer.packet.unit.id,
		);
		const reviewNode = graphResult.nodes.find(
			(n) => n.unitId === reviewer.packet.unit.id,
		);

		// Store this round's results without overwriting previous rounds
		const roundResults = new Map<string, RunPacketResult>();
		roundResults.set(
			implementer.packet.unit.id,
			syntheticResult(graphResult, implementer.packet.unit.id),
		);
		roundResults.set(
			reviewer.packet.unit.id,
			syntheticResult(graphResult, reviewer.packet.unit.id),
		);
		allRoundResults.push(roundResults);

		// The final childResults always reflect the latest round
		const childResults = new Map(roundResults);

		const implPassed = implNode?.status === "passed";
		const reviewPassed = reviewNode?.status === "passed";

		if (!implPassed) {
			return {
				strategyId: strategy.id,
				mode: strategy.mode,
				outcome: "failed",
				childResults,
				rounds: allRoundResults,
				mergeDecision: {
					policy: strategy.mergePolicy,
					outcome: "rejected",
					reasons: ["implementer did not pass"],
				},
			};
		}

		if (reviewPassed) {
			return {
				strategyId: strategy.id,
				mode: strategy.mode,
				outcome: "passed",
				childResults,
				rounds: allRoundResults,
				winnerRunId: implNode?.runId,
				mergeDecision: {
					policy: strategy.mergePolicy,
					outcome: "accepted",
					reasons: ["implementer passed and reviewer approved"],
				},
			};
		}

		// Implementer passed, reviewer rejected — retry if rounds remain
		if (round + 1 >= MAX_REVIEW_ROUNDS) {
			return {
				strategyId: strategy.id,
				mode: strategy.mode,
				outcome: "failed",
				childResults,
				rounds: allRoundResults,
				mergeDecision: {
					policy: strategy.mergePolicy,
					outcome: "rejected",
					reasons: [`reviewer rejected after ${MAX_REVIEW_ROUNDS} round(s)`],
				},
			};
		}

		// Extract reviewer rejection reasons and feed them back to the implementer
		const reviewerResult = roundResults.get(reviewer.packet.unit.id);
		const rejectionReasons: string[] = [];
		if (reviewerResult?.decision?.reasons) {
			rejectionReasons.push(...reviewerResult.decision.reasons);
		}
		if (reviewNode?.runId) {
			rejectionReasons.push(
				`reviewer run ${reviewNode.runId} did not approve (round ${round + 1})`,
			);
		}

		const feedbackSuffix =
			rejectionReasons.length > 0
				? `\n\nReviewer feedback from round ${round + 1}:\n${rejectionReasons.join("\n")}\n\nPlease address the reviewer's concerns and try again.`
				: "";

		if (feedbackSuffix && currentImplementerPacket.model) {
			currentImplementerPacket = {
				...currentImplementerPacket,
				model: {
					...currentImplementerPacket.model,
					systemPrompt:
						(currentImplementerPacket.model.systemPrompt ?? "") +
						feedbackSuffix,
				},
			};
		}
	}

	// Should not be reachable
	return {
		strategyId: strategy.id,
		mode: strategy.mode,
		outcome: "failed",
		childResults:
			allRoundResults.length > 0
				? allRoundResults[allRoundResults.length - 1]
				: new Map(),
		rounds: allRoundResults,
		mergeDecision: {
			policy: strategy.mergePolicy,
			outcome: "rejected",
			reasons: ["maximum review rounds exhausted"],
		},
	};
}
