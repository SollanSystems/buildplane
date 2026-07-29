export const REVIEWER_SYSTEM_PROMPT_TEMPLATE =
	"You are a code reviewer. The implementer was asked to: OBJECTIVE. " +
	"Examine the workspace and verify the output meets the objective. " +
	"If the work is correct and complete, exit successfully. " +
	"If there are issues, exit with a non-zero code and explain what's wrong.";

function reviewerObjective(objective: string): string {
	return `Review the implementer output and determine whether the objective was satisfied: ${objective}`;
}

interface TaskIntentLike {
	readonly objective?: string;
	readonly taskType?: string;
	readonly context?: {
		readonly files?: readonly string[];
		readonly [key: string]: unknown;
	};
	readonly constraints?: {
		readonly scope?: readonly string[];
		readonly verification?: readonly string[];
		readonly [key: string]: unknown;
	};
	readonly features?: {
		readonly ambiguity?: string;
		readonly reversibility?: string;
		readonly verifierStrength?: string;
		readonly [key: string]: unknown;
	};
	readonly [key: string]: unknown;
}

interface PacketLike {
	readonly unit: {
		readonly id: string;
		readonly kind: string;
		readonly scope: string;
		readonly inputRefs: readonly string[];
		readonly expectedOutputs: readonly string[];
		readonly verificationContract: string;
		readonly policyProfile: string;
	};
	readonly execution?: {
		readonly command: string;
		readonly args?: readonly string[];
	};
	readonly model?: {
		readonly provider: string;
		readonly model: string;
		readonly systemPrompt?: string;
		readonly prompt?: string;
		readonly tools?: readonly unknown[];
	};
	readonly intent?: TaskIntentLike;
	readonly verification: {
		readonly requiredOutputs: readonly string[];
	};
	/** The parser is still backward-compatible with legacy packets, but derived
	 * review packets must carry their signed execution role explicitly. */
	readonly execution_role?: string;
	readonly routingHints?: unknown;
}

const DEFAULT_REVIEW_FEATURES = {
	ambiguity: "low",
	reversibility: "easy",
	verifierStrength: "strong",
} as const;

// Build a complete review TaskIntent so the reviewer leg both renders without
// throwing (the renderer reads context.files and features) and is eligible for
// memory enrichment (which keys off intent + taskType:"review"). Files are
// inherited from the work under review (the implementer's expected outputs).
function buildReviewIntent(
	packet: PacketLike,
	objective: string,
	filesUnderReview: readonly string[],
): TaskIntentLike {
	const implementerFeatures = packet.intent?.features;
	return {
		objective: reviewerObjective(objective),
		taskType: "review",
		context: { files: [...filesUnderReview] },
		constraints: { scope: [], verification: [] },
		features: {
			ambiguity:
				implementerFeatures?.ambiguity ?? DEFAULT_REVIEW_FEATURES.ambiguity,
			reversibility:
				implementerFeatures?.reversibility ??
				DEFAULT_REVIEW_FEATURES.reversibility,
			verifierStrength:
				implementerFeatures?.verifierStrength ??
				DEFAULT_REVIEW_FEATURES.verifierStrength,
		},
	};
}

interface StrategyChildLike {
	readonly role: string;
	readonly packet: PacketLike;
	readonly dependsOn?: readonly string[];
}

interface StrategyPacketLike {
	readonly id: string;
	readonly mode: string;
	readonly mergePolicy: string;
	readonly children: readonly StrategyChildLike[];
}

function buildModelReviewer(packet: PacketLike): PacketLike {
	const objective = packet.intent?.objective ?? "complete the assigned task";
	return {
		unit: {
			id: `${packet.unit.id}-reviewer`,
			kind: "model",
			scope: packet.unit.scope,
			inputRefs: [...packet.unit.expectedOutputs],
			expectedOutputs: [],
			verificationContract: "exit-0-and-required-outputs",
			policyProfile: "default",
		},
		model: {
			provider: packet.model?.provider ?? "",
			model: packet.model?.model ?? "",
			systemPrompt: REVIEWER_SYSTEM_PROMPT_TEMPLATE.replace(
				"OBJECTIVE",
				objective,
			),
			prompt: reviewerObjective(objective),
		},
		intent: buildReviewIntent(packet, objective, packet.unit.expectedOutputs),
		verification: { requiredOutputs: [] },
		execution_role: "reviewer",
		routingHints: packet.routingHints,
	};
}

function buildCommandReviewer(packet: PacketLike): PacketLike {
	const outputs = packet.unit.expectedOutputs;
	const objective =
		packet.intent?.objective ?? `complete the unit ${packet.unit.id}`;
	if (outputs.length === 0) {
		return {
			unit: {
				id: `${packet.unit.id}-reviewer`,
				kind: "command",
				scope: packet.unit.scope,
				inputRefs: [],
				expectedOutputs: [],
				verificationContract: "exit-0-and-required-outputs",
				policyProfile: "default",
			},
			execution: { command: "true", args: [] },
			intent: buildReviewIntent(packet, objective, []),
			verification: { requiredOutputs: [] },
			execution_role: "reviewer",
		};
	}
	const checks = outputs.map((o) => `test -s ${o}`).join(" && ");
	return {
		unit: {
			id: `${packet.unit.id}-reviewer`,
			kind: "command",
			scope: packet.unit.scope,
			inputRefs: [...outputs],
			expectedOutputs: [],
			verificationContract: "exit-0-and-required-outputs",
			policyProfile: "default",
		},
		execution: { command: "sh", args: ["-c", checks] },
		intent: buildReviewIntent(packet, objective, outputs),
		verification: { requiredOutputs: [] },
		execution_role: "reviewer",
	};
}

export function wrapAsStrategy(packet: PacketLike): StrategyPacketLike {
	const reviewerPacket = packet.model
		? buildModelReviewer(packet)
		: buildCommandReviewer(packet);
	return {
		id: `auto-${packet.unit.id}`,
		mode: "implement-then-review",
		mergePolicy: "reviewer-must-approve",
		children: [
			{ role: "implementer", packet },
			{
				role: "reviewer",
				dependsOn: [packet.unit.id],
				packet: reviewerPacket,
			},
		],
	};
}
