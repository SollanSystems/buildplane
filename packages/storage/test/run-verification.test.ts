import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
	ApprovedPolicyDecision,
	CandidateArtifactProjectionInput,
	ExecutionReceipt,
	PromotionGitBindingV1,
	RejectedPolicyDecision,
	UnitPacket,
} from "@buildplane/kernel";
import { describe, expect, it } from "vitest";
import {
	createBuildplaneStorage,
	exportRunBundle,
	verifyRunFinalVerdict,
} from "../src";

const packet: UnitPacket = {
	unit: {
		id: "unit-finalize",
		kind: "command",
		scope: "task",
		inputRefs: [],
		expectedOutputs: ["tmp/out.txt"],
		verificationContract: "exit-0-and-required-outputs",
		policyProfile: "default",
	},
	intent: {
		objective: "Finalize from verifier evidence only.",
		taskType: "implement",
		context: { files: [] },
		constraints: {
			scope: ["tmp/**"],
			forbidden: ["no deploy"],
			verification: ["verifier receipt required"],
		},
		features: {
			ambiguity: "low",
			reversibility: "easy",
			verifierStrength: "strong",
		},
	},
	execution: {
		command: "node",
		args: ["-e", "console.log('worker says pass')"],
	},
	verification: {
		requiredOutputs: ["tmp/out.txt"],
	},
};

const receipt: ExecutionReceipt = {
	command: "node",
	args: ["-e", "console.log('worker says pass')"],
	cwd: ".",
	startedAt: "2026-05-04T10:00:00.000Z",
	completedAt: "2026-05-04T10:00:01.000Z",
	exitCode: 0,
	stdout: "worker says pass\n",
	stderr: "",
	outputChecks: [{ path: "tmp/out.txt", exists: true }],
};

const approved: ApprovedPolicyDecision = {
	kind: "advance-run",
	outcome: "approved",
	reasons: ["verifier receipts satisfy acceptance criteria"],
};

const rejectedUnsafe: RejectedPolicyDecision = {
	kind: "reject-run",
	outcome: "rejected",
	reasons: ["unsafe: command attempted file write outside granted scope"],
};

function createStorage(root: string) {
	const storage = createBuildplaneStorage(root);
	storage.initializeProject();
	return storage;
}

function candidateArtifact(runId: string): CandidateArtifactProjectionInput {
	return {
		schemaVersion: 1,
		candidateId: "candidate-finalize",
		runId,
		attempt: 1,
		candidateKey: "candidate-finalize/run-finalize/1",
		candidateRef:
			"refs/buildplane/candidates/candidate-finalize/run-finalize/1",
		baseSha: "a".repeat(40),
		candidateCommitSha: "b".repeat(40),
		commitDigest: "c".repeat(64),
		treeDigest: "d".repeat(64),
		patchDigest: "e".repeat(64),
		changedFilesDigest: "f".repeat(64),
		candidateDigest: "1".repeat(64),
		workflowId: "workflow-finalize",
		unitId: packet.unit.id,
		provenanceRef: "admission:unit-finalize",
		envelopeDigest: `sha256:${"2".repeat(64)}`,
		acceptanceContractDigest: `sha256:${"4".repeat(64)}`,
		actionReceiptDigest: `sha256:${"3".repeat(64)}`,
	};
}

function sealedV3CandidateArtifact(
	runId: string,
): CandidateArtifactProjectionInput {
	const { actionReceiptDigest: _legacyActionReceiptDigest, ...v1Candidate } =
		candidateArtifact(runId);
	return {
		...v1Candidate,
		schemaVersion: 2,
		actionEvidenceVersion: "sealed_v3",
		actionReceiptSetRef:
			"tape:action-receipt-set:workflow-finalize/unit-finalize/1",
		actionReceiptSetDigest: `sha256:${"5".repeat(64)}`,
		candidateCreatedRef:
			"tape:candidate-created:workflow-finalize/unit-finalize/1",
	};
}

describe("receipt-backed final verdict verification", () => {
	it("keeps initialized pre-trust-lane databases readable as untrusted legacy records", () => {
		const root = mkdtempSync(
			join(tmpdir(), "buildplane-final-legacy-trust-lane-"),
		);
		const storage = createStorage(root);
		const run = storage.createRun(packet, {
			runId: "run-final-legacy-trust-lane",
		});
		storage.markRunRunning(run.id);
		storage.recordExecutionEvidence(run.id, receipt);
		storage.recordDecision(run.id, approved);
		storage.completeRun(run.id, "passed");

		const database = new DatabaseSync(join(root, ".buildplane", "state.db"));
		database.exec("ALTER TABLE runs DROP COLUMN trust_lane");
		database.close();

		const report = verifyRunFinalVerdict(root, { runId: run.id });
		const bundle = exportRunBundle(root, { runId: run.id });

		expect(report).toMatchObject({
			governance: "legacy",
			trustedReceipt: false,
		});
		expect(bundle.run).toMatchObject({
			governance: "legacy",
			trusted_receipt: false,
		});

		const migratedDatabase = new DatabaseSync(
			join(root, ".buildplane", "state.db"),
		);
		const columns = migratedDatabase
			.prepare("PRAGMA table_info(runs)")
			.all() as { name: string }[];
		migratedDatabase.close();
		expect(columns.map((column) => column.name)).not.toContain("trust_lane");
	});

	it("blocks a worker-claimed passed run when required verifier receipts are missing", () => {
		const root = mkdtempSync(
			join(tmpdir(), "buildplane-final-missing-evidence-"),
		);
		const storage = createStorage(root);
		const run = storage.createRun(packet, {
			runId: "run-final-missing-evidence",
		});
		storage.markRunRunning(run.id);
		storage.recordDecision(run.id, approved);
		storage.completeRun(run.id, "passed");

		const report = verifyRunFinalVerdict(root, { runId: run.id });
		const bundle = exportRunBundle(root, { runId: run.id });

		expect(report.verdict).toBe("BLOCKED");
		expect(report.criteria).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: "required-output:tmp/out.txt",
					status: "INSUFFICIENT_EVIDENCE",
				}),
				expect.objectContaining({
					id: "command-exit:0",
					status: "INSUFFICIENT_EVIDENCE",
				}),
			]),
		);
		expect(report.issues).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ code: "MISSING_VERIFIER_RECEIPT" }),
			]),
		);
		expect(bundle.run.status).toBe("blocked");
		expect(bundle.run.verdict).toBe("blocked");
		expect(bundle.run.unverified_criteria).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: "required-output:tmp/out.txt" }),
				expect.objectContaining({ id: "command-exit:0" }),
			]),
		);
	});

	it("allows passed only when verifier receipts and approval evidence exist", () => {
		const root = mkdtempSync(join(tmpdir(), "buildplane-final-pass-"));
		const storage = createStorage(root);
		const run = storage.createRun(packet, { runId: "run-final-pass" });
		storage.markRunRunning(run.id);
		storage.recordExecutionEvidence(run.id, receipt);
		storage.recordDecision(run.id, approved);
		storage.completeRun(run.id, "passed");

		const report = verifyRunFinalVerdict(root, { runId: run.id });

		expect(report.verdict).toBe("PASSED");
		expect(report.criteria).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: "required-output:tmp/out.txt",
					status: "PASSED",
				}),
				expect.objectContaining({
					id: "command-exit:0",
					status: "PASSED",
				}),
			]),
		);
		expect(report.issues).toEqual([]);
		expect(report.receipts.verifier).toBe(2);
	});

	it("never upgrades a raw execution lane into a trusted receipt", () => {
		const root = mkdtempSync(join(tmpdir(), "buildplane-final-raw-lane-"));
		const storage = createStorage(root);
		const run = storage.createRun(packet, {
			runId: "run-final-raw-lane",
			trustLane: "unsafe",
		});
		storage.markRunRunning(run.id);
		storage.recordExecutionEvidence(run.id, receipt);
		storage.recordDecision(run.id, approved);
		storage.completeRun(run.id, "passed");

		const report = verifyRunFinalVerdict(root, { runId: run.id });
		const bundle = exportRunBundle(root, { runId: run.id });

		expect(report).toMatchObject({
			verdict: "UNSAFE_TO_RUN",
			governance: "unsafe",
			trustedReceipt: false,
		});
		expect(report.issues).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ code: "UNTRUSTED_EXECUTION_LANE" }),
			]),
		);
		expect(bundle.run).toMatchObject({
			status: "blocked",
			verdict: "blocked",
			governance: "unsafe",
			trusted_receipt: false,
		});
	});

	it("keeps a governed candidate blocked until promotion instead of treating acceptance as completion", () => {
		const root = mkdtempSync(
			join(tmpdir(), "buildplane-final-governed-candidate-"),
		);
		const storage = createStorage(root);
		const run = storage.createRun(
			{
				...packet,
				provenance_ref: "admission:unit-finalize",
			},
			{
				runId: "run-final-governed-candidate",
				trustLane: "governed",
			},
		);
		storage.recordWorkspacePrepared(run.id, {
			path: join(root, ".buildplane", "workspaces", run.id),
			headSha: "a".repeat(40),
			sourceProjectRoot: root,
		});
		const workspacePath = join(root, ".buildplane", "workspaces", run.id);
		mkdirSync(join(workspacePath, "tmp"), { recursive: true });
		writeFileSync(join(workspacePath, "tmp", "out.txt"), "ok");
		storage.markRunRunning(run.id);
		storage.recordExecutionEvidence(run.id, receipt);
		storage.commitRunCandidateOutcome(run.id, {
			decision: approved,
			candidate: sealedV3CandidateArtifact(run.id),
		});

		const report = verifyRunFinalVerdict(root, { runId: run.id });
		const bundle = exportRunBundle(root, { runId: run.id });

		expect(storage.inspectTarget(run.id).run.status).toBe("running");
		expect(report).toMatchObject({
			verdict: "BLOCKED",
			governance: "governed",
			trustedReceipt: false,
		});
		expect(report.issues).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ code: "MISSING_PROMOTION_RECEIPT" }),
				expect.objectContaining({
					code: "MISSING_SIGNED_TAPE_VERIFICATION",
				}),
			]),
		);
		expect(bundle.run).toMatchObject({
			status: "blocked",
			verdict: "blocked",
			governance: "governed",
			trusted_receipt: false,
		});

		const candidate = storage.getCandidateArtifact(run.id);
		expect(candidate).not.toBeNull();
		if (!candidate) throw new Error("Expected candidate artifact.");
		expect(candidate).toMatchObject({
			schemaVersion: 2,
			actionEvidenceVersion: "sealed_v3",
			actionReceiptSetRef:
				"tape:action-receipt-set:workflow-finalize/unit-finalize/1",
		});
		expect(candidate).not.toHaveProperty("actionReceiptDigest");
		const candidateDigest = `sha256:${candidate.candidateDigest}`;
		storage.prepareCandidatePromotion({
			runId: run.id,
			candidate,
			decision: {
				schemaVersion: 1,
				candidateDigest,
				baseCommitSha: candidate.baseSha,
				targetRef: "refs/heads/main",
				envelopeDigest: candidate.envelopeDigest ?? "",
				acceptanceRef: "tape:acceptance:finalize",
				reviewRefs: ["tape:review:finalize"],
				decision: "promote",
				authority: "operator",
				decidedBy: "operator-finalize",
				decidedAt: "2026-07-17T12:00:00.000Z",
				idempotencyKey: "promotion-finalize",
			},
			acceptance: {
				candidateDigest,
				candidateCommitSha: candidate.candidateCommitSha,
				acceptanceRef: "tape:acceptance:finalize",
				acceptanceContractDigest: candidate.acceptanceContractDigest ?? "",
				outcome: "passed",
			},
			review: {
				candidateDigest,
				candidateCommitSha: candidate.candidateCommitSha,
				reviewRef: "tape:review:finalize",
				verdict: {
					schemaVersion: 1,
					candidateDigest,
					decision: "approve",
					findings: [],
					confidence: 0.99,
					reviewerManifestDigest: `sha256:${"4".repeat(64)}`,
				},
			},
			preparedAt: "2026-07-17T12:00:01.000Z",
		});
		storage.markCandidatePromotionRecorded(
			candidate.candidateDigest,
			"promotion-finalize",
		);
		const mergedHeadSha = "5".repeat(40);
		const promotionGitBinding: PromotionGitBindingV1 = {
			targetRef: "refs/heads/main",
			targetHeadBeforeSha: candidate.baseSha,
			targetHeadAfterSha: mergedHeadSha,
			mergedHeadSha,
			candidateCommitSha: candidate.candidateCommitSha,
			mergeParentShas: [candidate.baseSha, candidate.candidateCommitSha],
			mergedTreeSha: "7".repeat(40),
			mergedTreeDigest: `sha256:${candidate.treeDigest}`,
			promotionReceiptRef:
				"refs/buildplane/promotions/candidate-finalize/run-finalize/1",
			worktreeSyncState: "pending_reconciliation",
		};
		const executionLease = storage.claimCandidatePromotionExecution(
			candidate.candidateDigest,
			"promotion-finalize",
		);
		storage.markCandidatePromotionExecuted(
			candidate.candidateDigest,
			"promotion-finalize",
			{ outcome: "promoted", mergedHeadSha, promotionGitBinding },
			executionLease.leaseToken,
		);

		const locallyCompletedReport = verifyRunFinalVerdict(root, {
			runId: run.id,
		});
		expect(storage.inspectTarget(run.id).run.status).toBe("passed");
		expect(locallyCompletedReport).toMatchObject({
			verdict: "BLOCKED",
			governance: "governed",
			trustedReceipt: false,
		});
		expect(locallyCompletedReport.issues).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					code: "MISSING_SIGNED_TAPE_VERIFICATION",
				}),
			]),
		);
		expect(locallyCompletedReport.issues).not.toEqual(
			expect.arrayContaining([
				expect.objectContaining({ code: "MISSING_PROMOTION_RECEIPT" }),
			]),
		);
	});

	it("fails when verifier command receipts record failed evidence", () => {
		const root = mkdtempSync(join(tmpdir(), "buildplane-final-failed-"));
		const storage = createStorage(root);
		const run = storage.createRun(packet, { runId: "run-final-failed" });
		storage.markRunRunning(run.id);
		storage.recordExecutionEvidence(run.id, {
			...receipt,
			exitCode: 1,
			outputChecks: [{ path: "tmp/out.txt", exists: false }],
		});
		storage.completeRun(run.id, "failed");

		const report = verifyRunFinalVerdict(root, { runId: run.id });

		expect(report.verdict).toBe("FAILED");
		expect(report.issues).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ code: "FAILED_VERIFIER_RECEIPT" }),
			]),
		);
		expect(report.criteria).toEqual(
			expect.arrayContaining([expect.objectContaining({ status: "FAILED" })]),
		);
	});

	it("reports deterministic failure before missing governed-promotion or tape gates", () => {
		const root = mkdtempSync(
			join(tmpdir(), "buildplane-final-governed-failed-evidence-"),
		);
		const storage = createStorage(root);
		const run = storage.createRun(packet, {
			runId: "run-final-governed-failed-evidence",
			trustLane: "governed",
		});
		storage.markRunRunning(run.id);
		storage.recordExecutionEvidence(run.id, {
			...receipt,
			exitCode: 1,
			outputChecks: [{ path: "tmp/out.txt", exists: false }],
		});
		storage.completeRun(run.id, "failed");

		const report = verifyRunFinalVerdict(root, { runId: run.id });

		expect(report).toMatchObject({
			verdict: "FAILED",
			governance: "governed",
			trustedReceipt: false,
		});
		expect(report.issues).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ code: "FAILED_VERIFIER_RECEIPT" }),
				expect.objectContaining({ code: "MISSING_PROMOTION_RECEIPT" }),
				expect.objectContaining({
					code: "MISSING_SIGNED_TAPE_VERIFICATION",
				}),
			]),
		);
	});

	it("returns unsafe-to-run for safety policy violations", () => {
		const root = mkdtempSync(join(tmpdir(), "buildplane-final-unsafe-"));
		const storage = createStorage(root);
		const run = storage.createRun(packet, { runId: "run-final-unsafe" });
		storage.markRunRunning(run.id);
		storage.recordExecutionEvidence(run.id, receipt);
		storage.recordDecision(run.id, rejectedUnsafe);
		storage.completeRun(run.id, "failed");

		const report = verifyRunFinalVerdict(root, { runId: run.id });

		expect(report.verdict).toBe("UNSAFE_TO_RUN");
		expect(report.issues).toEqual([
			expect.objectContaining({ code: "UNSAFE_TO_RUN" }),
		]);
	});
});
