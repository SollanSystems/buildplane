import { createHash } from "node:crypto";
import type { PlanForgeCompileResult } from "./compile.js";
import { hasLine, sectionText } from "./compile.js";
import { digest } from "./digest.js";
import {
	PLANFORGE_PLAN_SCHEMA_VERSION,
	PLANFORGE_RECEIPT_SCHEMA_VERSION,
	type PlanForgePlan,
	type PlanForgeTask,
} from "./schema.js";
import type { PlanForgeValidateResult } from "./validate.js";

export function preview(
	compiled: PlanForgeCompileResult,
	validated: PlanForgeValidateResult,
): PlanForgePlan {
	const { goal, remote, trustedBase, worktreePolicy, safetyConstraints } =
		compiled;
	const { status: validationStatus, validation } = validated;

	const normalizedGoal = goal ?? "";
	const normalizedTrustedBase = trustedBase ?? "unknown";
	const normalizedRemote = remote ?? "unknown";

	// Deliberate exception to the M2-S1 canonical-digest migration: the
	// idempotencyKey fingerprint MUST stay byte-identical to the pre-extraction
	// derivation, so it keeps insertion-order JSON.stringify over this
	// hand-ordered object rather than the canonical digest() helper. Switching
	// to digest() would silently rotate every plan's idempotencyKey. Do not "fix".
	// Task content is intentionally excluded: task lists evolve within a plan
	// identity; the fingerprint covers the operator boundary (goal, base, policy).
	const fingerprintInput = JSON.stringify({
		constraints: {
			dryRun: hasLine(safetyConstraints ?? "", "- Dry-run only."),
			noSideEffects: hasLine(
				safetyConstraints ?? "",
				"- No Kanban, GSD2, GitHub, network, push, PR, deploy, merge, or worker-spawn side effects.",
			),
			trustedBoundary: {
				kernelAdmits: hasLine(
					safetyConstraints ?? "",
					"- Buildplane kernel validates and admits plans.",
				),
				untrustedWorkers: hasLine(
					safetyConstraints ?? "",
					"- Coding agents are untrusted workers.",
				),
			},
		},
		evidenceRefs: compiled.evidenceRefs,
		goal: normalizedGoal,
		remote: normalizedRemote,
		trustedBase: normalizedTrustedBase,
		worktreePolicy: worktreePolicy ?? "unknown",
	});
	const planFingerprint = createHash("sha256")
		.update(fingerprintInput)
		.digest("hex")
		.slice(0, 8);
	const idempotencyKey = `planforge:v0:buildplane:${normalizedTrustedBase}:${planFingerprint}`;
	const canonicalInput = compiled.content.replace(/\r\n/g, "\n");
	const inputDigest = digest(canonicalInput);

	const titleSection = sectionText(compiled.content, "Title");
	const planTitle = titleSection?.split("\n")[0]?.trim() ?? "PlanForge plan";

	const tasks: PlanForgeTask[] = compiled.parsedTasks.map((t) => ({
		id: t.id,
		title: t.title,
		objective: t.objective,
		assigneeHint: t.assigneeHint,
		workspace: t.workspace,
		dependsOn: [...t.dependsOn],
		allowedSideEffects: [...t.allowedSideEffects],
		forbiddenSideEffects: [...t.forbiddenSideEffects],
		acceptanceCriteria: [...t.acceptanceCriteria],
		verificationCommands: [...t.verificationCommands],
	}));

	const plan: PlanForgePlan = {
		schemaVersion: PLANFORGE_PLAN_SCHEMA_VERSION,
		id: `pf-plan-${planFingerprint}`,
		idempotencyKey,
		title: planTitle,
		goal: normalizedGoal,
		trustedBase: normalizedTrustedBase,
		tasks,
		validation,
		receiptPreview: {
			schemaVersion: PLANFORGE_RECEIPT_SCHEMA_VERSION,
			status: validationStatus,
			riskClass: validation.riskClass,
			planId: `pf-plan-${planFingerprint}`,
			idempotencyKey,
			inputDigest,
			planDigest: "",
			trustedBase: normalizedTrustedBase,
			admittedBy: "buildplane-kernel",
			generatedAt: "2026-05-07T00:00:00.000Z",
			dryRun: true,
			sideEffects: [],
			notes: [
				"Receipt preview is documentation/fixture only.",
				"PASS does not create tasks, grant write capabilities, merge, deploy, or start workers.",
				"Non-PASS statuses fail closed: BLOCKED, FAILED, INSUFFICIENT_EVIDENCE, UNSAFE_TO_RUN.",
			],
		},
	};
	const { receiptPreview: _receiptPreview, ...reviewArtifact } = plan;
	plan.receiptPreview.planDigest = digest(reviewArtifact);
	return plan;
}
