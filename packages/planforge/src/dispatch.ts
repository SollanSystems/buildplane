import {
	buildDefaultCapabilityBundleForTask,
	capabilityBundleDigest,
	type PlanForgeAttachedCapabilityBundle,
} from "./bundle.js";
import type { PlanForgePlan, PlanForgeTask } from "./schema.js";

/** Default worker provider/model stamped into every dispatched packet. The
 * ClaudeCodeExecutor ignores `provider` (it spawns the `claude` CLI directly)
 * but `parseModelBlock` requires it non-empty; `model` becomes the `--model` flag. */
export const DISPATCH_WORKER_PROVIDER = "anthropic" as const;
export const DISPATCH_WORKER_MODEL = "claude-sonnet-4-20250514" as const;

/** Kernel TaskIntent shape, inlined to keep planforge a zero-dependency leaf.
 * Structurally a subset of `@buildplane/kernel`'s TaskIntent; the CLI re-validates
 * each packet through `parseUnitPacket` (which parses `intent`) before dispatch. */
export interface DispatchTaskIntent {
	readonly objective: string;
	readonly taskType: "implement";
	readonly context: {
		readonly files: readonly string[];
		readonly priorWork?: readonly string[];
	};
	readonly constraints: {
		readonly scope: readonly string[];
		readonly forbidden?: readonly string[];
		readonly verification: readonly string[];
	};
	readonly features: {
		readonly ambiguity: "low" | "medium" | "high";
		readonly reversibility: "easy" | "hard";
		readonly verifierStrength: "strong" | "weak" | "none";
	};
}

/**
 * Minimal packet shape PlanForge emits for dispatch. Structurally a subset of
 * `@buildplane/kernel`'s `UnitPacket`; planforge stays a zero-dependency leaf, so
 * the kernel type is not imported. The CLI re-validates each packet through
 * `parseUnitPacket` before handing it to the run loop.
 *
 * No `execution` field: the run-loop router short-circuits any packet carrying
 * `execution` to the command executor BEFORE checking `routingHints` (run-cli.ts:1436),
 * so a real claude-code worker is selected only when `execution` is absent and
 * `routingHints.preferredWorker === 'claude-code'`.
 */
export interface DispatchedUnitPacket {
	readonly unit: {
		readonly id: string;
		readonly kind: string;
		readonly scope: string;
		readonly inputRefs: readonly string[];
		readonly expectedOutputs: readonly string[];
		readonly verificationContract: string;
		readonly policyProfile: string;
	};
	readonly model: {
		readonly provider: typeof DISPATCH_WORKER_PROVIDER;
		readonly model: string;
		readonly prompt: string;
	};
	readonly intent: DispatchTaskIntent;
	readonly routingHints: { readonly preferredWorker: "claude-code" };
	readonly verification: { readonly requiredOutputs: readonly string[] };
	readonly provenance_ref: string;
	readonly capability_bundle: PlanForgeAttachedCapabilityBundle;
	readonly capability_bundle_digest: string;
}

export interface DispatchPlanInput {
	readonly plan: PlanForgePlan;
	/** Tape event id of the signed `plan_admitted` authorizing this dispatch. */
	readonly admittedEventId: string;
	/** Policy profile each dispatched unit runs under. */
	readonly policyProfile: string;
	/**
	 * Worker model stamped onto every dispatched packet's `model.model` (the
	 * `--model` flag the ClaudeCodeExecutor passes to `claude -p`). Defaults to
	 * `DISPATCH_WORKER_MODEL` so the global default is unchanged; the loop's
	 * `--model` override threads through here.
	 */
	readonly model?: string;
}

/** Map a PlanForgeTask to a kernel-shaped TaskIntent. GAP-5 threads priorWork
 * through `context.priorWork`; GAP-9 reuses this for planner-emitted tasks. */
export function buildTaskIntent(
	_plan: PlanForgePlan,
	task: PlanForgeTask,
): DispatchTaskIntent {
	return {
		objective: task.objective,
		taskType: "implement",
		context: { files: [] },
		constraints: {
			scope: [task.workspace],
			...(task.forbiddenSideEffects.length > 0
				? { forbidden: task.forbiddenSideEffects }
				: {}),
			verification: task.verificationCommands,
		},
		features: {
			ambiguity: "medium",
			reversibility: "easy",
			verifierStrength: "strong",
		},
	};
}

/** Fold a task into the worker prompt. The CLI wires no renderer onto the
 * ClaudeCodeExecutor yet (run-cli.ts:1407), so `model.prompt` — not `intent` —
 * is the field that actually drives `claude -p`. We populate both: prompt works
 * today, intent activates when a renderer is wired (GAP-5/GAP-9). */
function buildWorkerPrompt(plan: PlanForgePlan, task: PlanForgeTask): string {
	const lines = [
		`Objective: ${task.objective}`,
		`Plan goal: ${plan.goal}`,
		`Workspace: ${task.workspace}`,
	];
	if (task.acceptanceCriteria.length > 0) {
		lines.push(
			"Acceptance criteria:",
			...task.acceptanceCriteria.map((c) => `- ${c}`),
		);
	}
	if (task.verificationCommands.length > 0) {
		lines.push(
			"Verify with:",
			...task.verificationCommands.map((c) => `- ${c}`),
		);
	}
	return lines.join("\n");
}

/**
 * Build one packet per `PlanForgeTask` from an admitted plan. Each packet carries
 * `provenance_ref = admittedEventId`, the tape pointer the kernel admission gate
 * verifies. Packets are returned in plan order; the caller runs them respecting
 * `task.dependsOn`. Each packet is a claude-code MODEL packet (no `execution`
 * field): the run-loop router short-circuits any packet with `execution` to the
 * command executor before checking `preferredWorker`, so the real worker is
 * selected only when `execution` is absent and `routingHints.preferredWorker`
 * is `claude-code`.
 */
export function dispatchAdmittedPlan(
	input: DispatchPlanInput,
): DispatchedUnitPacket[] {
	const { plan, admittedEventId, policyProfile } = input;
	const model = input.model ?? DISPATCH_WORKER_MODEL;
	return plan.tasks.map((task) => {
		const capability_bundle = buildDefaultCapabilityBundleForTask(plan, task);
		return {
			unit: {
				id: `${plan.id}:${task.id}`,
				kind: "planforge-task",
				scope: task.workspace,
				inputRefs: [],
				expectedOutputs: [],
				verificationContract:
					task.verificationCommands.length > 0
						? task.verificationCommands.join(" && ")
						: "true",
				policyProfile,
			},
			model: {
				provider: DISPATCH_WORKER_PROVIDER,
				model,
				prompt: buildWorkerPrompt(plan, task),
			},
			intent: buildTaskIntent(plan, task),
			routingHints: { preferredWorker: "claude-code" },
			verification: { requiredOutputs: [] },
			provenance_ref: admittedEventId,
			capability_bundle,
			capability_bundle_digest: capabilityBundleDigest(capability_bundle),
		};
	});
}
