export const REVIEWER_SYSTEM_PROMPT_TEMPLATE =
	"You are a code reviewer. The implementer was asked to: OBJECTIVE. " +
	"Examine the workspace and verify the output meets the objective. " +
	"If the work is correct and complete, exit successfully. " +
	"If there are issues, exit with a non-zero code and explain what's wrong.";

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
	readonly intent?: {
		readonly objective?: string;
		readonly [key: string]: unknown;
	};
	readonly verification: {
		readonly requiredOutputs: readonly string[];
	};
	readonly routingHints?: unknown;
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
		},
		verification: { requiredOutputs: [] },
	};
}

function buildCommandReviewer(packet: PacketLike): PacketLike {
	const outputs = packet.unit.expectedOutputs;
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
			verification: { requiredOutputs: [] },
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
		verification: { requiredOutputs: [] },
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
