import { createHash } from "node:crypto";
import type { PlanForgeCompileResult } from "./compile.js";
import { hasLine } from "./compile.js";
import { digest } from "./digest.js";
import {
	PLANFORGE_PLAN_SCHEMA_VERSION,
	PLANFORGE_RECEIPT_SCHEMA_VERSION,
	PLANFORGE_TASK_IDS,
	type PlanForgePlan,
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

	const plan: PlanForgePlan = {
		schemaVersion: PLANFORGE_PLAN_SCHEMA_VERSION,
		id: `pf-plan-${planFingerprint}`,
		idempotencyKey,
		title: "PlanForge dry-run admission slice",
		goal: normalizedGoal,
		trustedBase: normalizedTrustedBase,
		tasks: [
			{
				id: PLANFORGE_TASK_IDS[0],
				title: "Spec PlanForge contracts and fixture artifacts",
				objective:
					"Define the narrow documentation-level PlanForge contracts plus deterministic dry-run fixtures.",
				assigneeHint: "auto-coder",
				workspace: "isolated-worktree",
				dependsOn: [],
				allowedSideEffects: ["local-doc", "local-fixture"],
				forbiddenSideEffects: [
					"execute-code",
					"board-write",
					"network-write",
					"push",
					"deploy",
					"merge",
				],
				acceptanceCriteria: [
					"Define PlanForgeInput, PlanForgePlan, PlanForgeTask, PlanForgeValidation, and PlanForgeReceipt at documentation/fixture level.",
					"State that the Buildplane kernel validates and admits plans while coding agents remain untrusted workers.",
					"State dry-run/no-side-effect behavior.",
					"Define PASS, BLOCKED, FAILED, INSUFFICIENT_EVIDENCE, and UNSAFE_TO_RUN failure/pass states.",
					"Define idempotency key semantics for repeated planning.",
				],
				verificationCommands: [
					"git status --short --branch",
					"git diff --check",
					"pnpm lint",
				],
			},
			{
				id: PLANFORGE_TASK_IDS[1],
				title: "Implement PlanForge dry-run CLI and schema validation",
				objective:
					"Add a later dry-run command that validates local input and emits stable JSON without storage, board, network, or worker side effects.",
				assigneeHint: "auto-coder",
				workspace: "isolated-worktree",
				dependsOn: [PLANFORGE_TASK_IDS[0]],
				allowedSideEffects: ["local-doc", "local-fixture", "local-receipt"],
				forbiddenSideEffects: [
					"execute-code",
					"board-write",
					"network-write",
					"push",
					"deploy",
					"merge",
				],
				acceptanceCriteria: [
					"Missing input fails closed before any write.",
					"Invalid input fails closed before any write.",
					"Unsupported non-dry-run forms fail with a clear message.",
					"Output is stable JSON suitable for review.",
				],
				verificationCommands: [
					"pnpm vitest --run apps/cli/test/run-cli.test.ts -t planforge",
					"pnpm typecheck",
					"git diff --check",
				],
			},
		],
		validation,
		receiptPreview: {
			schemaVersion: PLANFORGE_RECEIPT_SCHEMA_VERSION,
			status: validationStatus,
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
				"Receipt preview is documentation/fixture only for PF1.",
				"PASS does not create tasks, grant write capabilities, merge, deploy, or start workers.",
				"Non-PASS statuses fail closed: BLOCKED, FAILED, INSUFFICIENT_EVIDENCE, UNSAFE_TO_RUN.",
			],
		},
	};
	const { receiptPreview: _receiptPreview, ...reviewArtifact } = plan;
	plan.receiptPreview.planDigest = digest(reviewArtifact);
	return plan;
}
