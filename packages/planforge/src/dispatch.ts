import type { PlanForgePlan } from "./schema.js";

/**
 * Minimal packet shape PlanForge emits for dispatch. Structurally a subset of
 * `@buildplane/kernel`'s `UnitPacket`; planforge stays a zero-dependency leaf, so
 * the kernel type is not imported. The CLI re-validates each packet through
 * `parseUnitPacket` before handing it to the run loop.
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
	readonly execution: { readonly command: string };
	readonly verification: { readonly requiredOutputs: readonly string[] };
	readonly provenance_ref: string;
}

export interface DispatchPlanInput {
	readonly plan: PlanForgePlan;
	/** Tape event id of the signed `plan_admitted` authorizing this dispatch. */
	readonly admittedEventId: string;
	/** Policy profile each dispatched unit runs under. */
	readonly policyProfile: string;
}

/**
 * Build one packet per `PlanForgeTask` from an admitted plan. Each packet carries
 * `provenance_ref = admittedEventId`, the tape pointer the kernel admission gate
 * verifies. Packets are returned in plan order; the caller runs them respecting
 * `task.dependsOn`. S4 dispatches a deterministic no-op command (`true`) to prove
 * the admission → run → worktree path — real per-objective execution is S5.
 */
export function dispatchAdmittedPlan(
	input: DispatchPlanInput,
): DispatchedUnitPacket[] {
	const { plan, admittedEventId, policyProfile } = input;
	return plan.tasks.map((task) => ({
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
		execution: { command: "true" },
		verification: { requiredOutputs: [] },
		provenance_ref: admittedEventId,
	}));
}
