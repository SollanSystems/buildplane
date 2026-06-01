import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { compile } from "./compile.js";
import { preview } from "./preview.js";
import type { PlanForgePlan } from "./schema.js";
import { validate } from "./validate.js";

export {
	type AdmitPlanInput,
	buildPlanAdmittedPayload,
	PLANFORGE_AUTHORIZED_NEXT_STEP,
	type PlanAdmittedPayload,
	PlanForgeAdmitRejectedError,
} from "./admit.js";
export { compile, type PlanForgeCompileResult } from "./compile.js";
export { canonicalJson, digest } from "./digest.js";
export { preview } from "./preview.js";
export * from "./schema.js";
export { type PlanForgeValidateResult, validate } from "./validate.js";

export function createPlanForgeDryRunPlan(inputPath: string): PlanForgePlan {
	const content = readFileSync(inputPath, "utf8");
	const inputEvidenceName = basename(inputPath);
	const compiled = compile(content, inputEvidenceName);
	const validated = validate(compiled);
	return preview(compiled, validated);
}
