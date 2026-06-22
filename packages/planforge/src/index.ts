import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { compile } from "./compile.js";
import { preview } from "./preview.js";
import type { PlanForgePlan } from "./schema.js";
import { validate } from "./validate.js";

export {
	type AcceptanceContractV0,
	acceptanceContractDigest,
	deriveAcceptanceContract,
} from "./acceptance-contract.js";
export {
	type AdmitPlanInput,
	buildPlanAdmittedPayload,
	PLANFORGE_AUTHORIZED_NEXT_STEP,
	type PlanAdmittedPayload,
	PlanForgeAdmitRejectedError,
} from "./admit.js";
export {
	buildDefaultCapabilityBundleForPlan,
	buildDefaultCapabilityBundleForTask,
	capabilityBundleDigest,
	PLANFORGE_CAPABILITY_BUNDLE_SCHEMA_VERSION,
	type PlanForgeAttachedCapabilityBundle,
} from "./bundle.js";
export { compile, type PlanForgeCompileResult } from "./compile.js";
export { canonicalJson, digest } from "./digest.js";
export {
	type DispatchedUnitPacket,
	type DispatchPlanInput,
	dispatchAdmittedPlan,
} from "./dispatch.js";
export { type ParsedTask, parseTasks } from "./parse-tasks.js";
export { preview } from "./preview.js";
export {
	type BuildPlanReceiptInput,
	buildPlanReceiptPayload,
	type PlanReceiptOutcome,
	type PlanReceiptPayload,
} from "./receipt.js";
export * from "./schema.js";
export { type PlanForgeValidateResult, validate } from "./validate.js";

export function createPlanForgeDryRunPlan(inputPath: string): PlanForgePlan {
	const content = readFileSync(inputPath, "utf8");
	const inputEvidenceName = basename(inputPath);
	const compiled = compile(content, inputEvidenceName);
	const validated = validate(compiled);
	return preview(compiled, validated);
}
