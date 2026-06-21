import { buildDefaultCapabilityBundleForTask } from "./bundle.js";
import { digest } from "./digest.js";
import type { PlanForgePlan, PlanForgeTask } from "./schema.js";

/**
 * Per-task acceptance contract (M4). Structurally compatible with the kernel's
 * `AcceptanceContractV0` — planforge stays a zero-dependency leaf, so the kernel
 * type is not imported. Derived deterministically from the admitted plan: a
 * worker's diff is accepted only if it stays inside `diff_scope.allowed_globs`
 * and every `checks[].command` exits 0.
 */
export interface AcceptanceContractV0 {
	readonly contract_version: "v0";
	readonly diff_scope: {
		readonly allowed_globs: readonly string[];
		readonly denied_globs?: readonly string[];
	};
	readonly checks: readonly { readonly command: string }[];
}

/**
 * Derive the acceptance contract for one PlanForge task. `allowed_globs` is the
 * task's `capability_bundle.fsWrite` (the same least-privilege surface dispatch
 * attaches to the packet); `checks` is the task's `verificationCommands`,
 * order-preserved and de-duplicated.
 */
export function deriveAcceptanceContract(
	plan: PlanForgePlan,
	task: PlanForgeTask,
): AcceptanceContractV0 {
	const bundle = buildDefaultCapabilityBundleForTask(plan, task);
	const allowedGlobs = [...(bundle.fsWrite ?? [])];

	const seen = new Set<string>();
	const checks: { command: string }[] = [];
	for (const command of task.verificationCommands) {
		if (seen.has(command)) {
			continue;
		}
		seen.add(command);
		checks.push({ command });
	}

	return {
		contract_version: "v0",
		diff_scope: { allowed_globs: allowedGlobs },
		checks,
	};
}

/**
 * Canonical `sha256:` content address of an acceptance contract, using the same
 * `canonicalJson` digest as `planDigest`/`bundleDigest`. The signed
 * `acceptance_recorded` event carries this so tape replay can reconstruct and
 * re-verify the contract from `plan_admitted`.
 */
export function acceptanceContractDigest(
	contract: AcceptanceContractV0,
): string {
	return digest(contract);
}
