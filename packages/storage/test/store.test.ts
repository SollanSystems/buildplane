import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
	ApprovedPolicyDecision,
	ExecutionReceipt,
	PromotionGitBindingV1,
	RejectedPolicyDecision,
	RunInfrastructureFailure,
	UnitPacket,
} from "@buildplane/kernel";
import { describe, expect, it } from "vitest";
import type {
	CandidateArtifactProjection,
	CandidateArtifactProjectionInput,
	CandidatePromotionIntentInput,
} from "../src";
import { createBuildplaneStorage } from "../src";
import {
	bootstrapStorageProjectionSchema,
	createStorageStore,
} from "../src/store";

const packet: UnitPacket = {
	unit: {
		id: "unit-1",
		kind: "command",
		scope: "task",
		inputRefs: [],
		expectedOutputs: ["tmp/out.txt"],
		verificationContract: "exit-0-and-required-outputs",
		policyProfile: "default",
	},
	execution: {
		command: "node",
		args: ["-e", "console.log('ok')"],
	},
	execution_role: "implementer",
	verification: {
		requiredOutputs: ["tmp/out.txt"],
	},
};

const receipt: ExecutionReceipt = {
	command: "node",
	args: ["-e", "console.log('ok')"],
	cwd: ".",
	startedAt: "2026-03-17T00:00:00.000Z",
	completedAt: "2026-03-17T00:00:01.000Z",
	exitCode: 0,
	stdout: "ok\n",
	stderr: "",
	outputChecks: [{ path: "tmp/out.txt", exists: true }],
};

const decision: ApprovedPolicyDecision = {
	kind: "advance-run",
	outcome: "approved",
	reasons: [],
};

const rejectedDecision: RejectedPolicyDecision = {
	kind: "reject-run",
	outcome: "rejected",
	reasons: ["command exited with code 1"],
};

const failedReceipt: ExecutionReceipt = {
	...receipt,
	exitCode: 1,
	outputChecks: [{ path: "tmp/missing.txt", exists: false }],
};

function candidateArtifact(
	runId: string,
	overrides: Partial<CandidateArtifactProjectionInput> = {},
): CandidateArtifactProjectionInput {
	return {
		schemaVersion: 1,
		candidateId: "candidate-1",
		runId,
		candidateKey: "candidate-1/run-1/1",
		candidateRef: "refs/buildplane/candidates/candidate-1/run-1/1",
		workflowId: "workflow-1",
		unitId: packet.unit.id,
		attempt: 1,
		provenanceRef: "admission:unit-1",
		candidateDigest: "a".repeat(64),
		baseSha: "b".repeat(40),
		candidateCommitSha: "c".repeat(40),
		commitDigest: "6".repeat(64),
		treeDigest: "d".repeat(64),
		patchDigest: "e".repeat(64),
		changedFilesDigest: "f".repeat(64),
		envelopeDigest: `sha256:${"1".repeat(64)}`,
		acceptanceContractDigest: `sha256:${"4".repeat(64)}`,
		actionReceiptDigest: `sha256:${"2".repeat(64)}`,
		...overrides,
	};
}

function sealedCandidateArtifact(
	runId: string,
	actionEvidenceVersion: "sealed-v2" | "sealed_v3" = "sealed-v2",
	overrides: Partial<CandidateArtifactProjectionInput> = {},
): CandidateArtifactProjectionInput {
	const { actionReceiptDigest: _legacyActionReceiptDigest, ...v1Candidate } =
		candidateArtifact(runId);
	return {
		...v1Candidate,
		schemaVersion: 2,
		actionEvidenceVersion,
		actionReceiptSetRef: "tape:action-receipt-set:workflow-1/unit-1/1",
		actionReceiptSetDigest: `sha256:${"9".repeat(64)}`,
		candidateCreatedRef: "tape:candidate-created:workflow-1/unit-1/1",
		...overrides,
	};
}

function candidatePromotionIntent(
	candidate: CandidateArtifactProjection,
	overrides: Partial<CandidatePromotionIntentInput> = {},
): CandidatePromotionIntentInput {
	const candidateDigest = `sha256:${candidate.candidateDigest}`;
	return {
		runId: candidate.runId,
		candidate,
		decision: {
			schemaVersion: 1,
			candidateDigest,
			baseCommitSha: candidate.baseSha.toLowerCase(),
			targetRef: "refs/heads/main",
			envelopeDigest: candidate.envelopeDigest ?? "",
			acceptanceRef: "tape:acceptance:1",
			reviewRefs: ["tape:review:1"],
			decision: "promote",
			authority: "operator",
			decidedBy: "operator-1",
			decidedAt: "2026-07-17T12:00:00.000Z",
			idempotencyKey: "promotion-key-1",
		},
		acceptance: {
			candidateDigest,
			candidateCommitSha: candidate.candidateCommitSha,
			acceptanceRef: "tape:acceptance:1",
			acceptanceContractDigest: candidate.acceptanceContractDigest ?? "",
			outcome: "passed",
		},
		review: {
			candidateDigest,
			candidateCommitSha: candidate.candidateCommitSha,
			reviewRef: "tape:review:1",
			verdict: {
				schemaVersion: 1,
				candidateDigest,
				decision: "approve",
				findings: [],
				confidence: 0.99,
				reviewerManifestDigest: `sha256:${"3".repeat(64)}`,
			},
		},
		preparedAt: "2026-07-17T12:00:01.000Z",
		...overrides,
	};
}

function promotionGitBinding(
	candidate: CandidateArtifactProjection,
	mergedHeadSha: string,
): PromotionGitBindingV1 {
	return {
		targetRef: "refs/heads/main",
		targetHeadBeforeSha: candidate.baseSha,
		targetHeadAfterSha: "8".repeat(40),
		mergedHeadSha,
		candidateCommitSha: candidate.candidateCommitSha,
		mergeParentShas: [candidate.baseSha, candidate.candidateCommitSha],
		mergedTreeSha: "7".repeat(40),
		mergedTreeDigest: `sha256:${candidate.treeDigest}`,
		promotionReceiptRef: "refs/buildplane/promotions/candidate-1/run-1/1",
		worktreeSyncState: "target_advanced",
	};
}

function createPromotableCandidate(
	storage: ReturnType<typeof createBuildplaneStorage>,
	root: string,
	overrides: Partial<CandidateArtifactProjectionInput> = {},
	trustLane: "legacy" | "unsafe" | "governed" = "governed",
): CandidateArtifactProjection {
	const run = storage.createRun(
		{
			...packet,
			provenance_ref: "admission:unit-1",
		},
		{ trustLane },
	);
	storage.recordWorkspacePrepared(run.id, {
		path: createWorkspacePath(root, run.id),
		headSha: "b".repeat(40),
		sourceProjectRoot: root,
	});
	storage.markRunRunning(run.id);
	storage.commitRunCandidateOutcome(run.id, {
		decision,
		candidate: candidateArtifact(run.id, overrides),
	});
	const candidate = storage.getCandidateArtifact(run.id);
	if (!candidate) {
		throw new Error("Expected candidate artifact to be recorded.");
	}
	return candidate;
}

function openStateDatabase(root: string): DatabaseSync {
	return new DatabaseSync(join(root, ".buildplane", "state.db"));
}

function createWorkspacePath(root: string, runId: string): string {
	return join(root, ".buildplane", "workspaces", runId);
}

describe("storage adapter", () => {
	it("atomically records an immutable candidate, active awaiting-promotion run, and retained workspace", () => {
		const root = mkdtempSync(join(tmpdir(), "buildplane-store-candidate-"));
		const storage = createBuildplaneStorage(root);
		storage.initializeProject();
		const governedPacket: UnitPacket = {
			...packet,
			provenance_ref: "admission:unit-1",
		};
		const run = storage.createRun(governedPacket);
		storage.recordWorkspacePrepared(run.id, {
			path: createWorkspacePath(root, run.id),
			headSha: "b".repeat(40),
			sourceProjectRoot: root,
		});
		storage.markRunRunning(run.id);

		const candidate = candidateArtifact(run.id);
		const completed = storage.commitRunCandidateOutcome(run.id, {
			decision,
			candidate,
		});
		const inspect = storage.inspectTarget(run.id);

		expect(completed.status).toBe("running");
		expect(inspect.workspace).toMatchObject({ status: "retained" });
		expect(inspect.candidate).toEqual({
			...candidate,
			unitId: packet.unit.id,
			createdAt: expect.any(String),
		});
		expect(storage.getCandidateArtifact(run.id)).toEqual(inspect.candidate);
	});

	it("round-trips legacy sealed-v2 action-evidence lineage for a governed candidate", () => {
		const root = mkdtempSync(
			join(tmpdir(), "buildplane-store-v3-candidate-action-evidence-"),
		);
		const storage = createBuildplaneStorage(root);
		storage.initializeProject();
		const run = storage.createRun(
			{ ...packet, provenance_ref: "admission:unit-1" },
			{ trustLane: "governed" },
		);
		storage.recordWorkspacePrepared(run.id, {
			path: createWorkspacePath(root, run.id),
			headSha: "b".repeat(40),
			sourceProjectRoot: root,
		});
		storage.markRunRunning(run.id);
		const candidate = sealedCandidateArtifact(run.id);

		storage.commitRunCandidateOutcome(run.id, { decision, candidate });

		expect(storage.getCandidateArtifact(run.id)).toMatchObject({
			schemaVersion: 2,
			actionEvidenceVersion: "sealed-v2",
			actionReceiptSetRef: "tape:action-receipt-set:workflow-1/unit-1/1",
			actionReceiptSetDigest: `sha256:${"9".repeat(64)}`,
			candidateCreatedRef: "tape:candidate-created:workflow-1/unit-1/1",
		});
		const database = openStateDatabase(root);
		expect(
			database
				.prepare(
					`SELECT schema_version, action_evidence_version, action_receipt_set_ref, action_receipt_set_digest, candidate_created_ref FROM candidate_artifacts WHERE run_id = ?`,
				)
				.get(run.id),
		).toEqual({
			schema_version: 2,
			action_evidence_version: "sealed-v2",
			action_receipt_set_ref: "tape:action-receipt-set:workflow-1/unit-1/1",
			action_receipt_set_digest: `sha256:${"9".repeat(64)}`,
			candidate_created_ref: "tape:candidate-created:workflow-1/unit-1/1",
		});
		database.close();
	});

	it("round-trips sealed_v3 action-evidence lineage for a governed candidate", () => {
		const root = mkdtempSync(
			join(tmpdir(), "buildplane-store-sealed-v3-candidate-action-evidence-"),
		);
		const storage = createBuildplaneStorage(root);
		storage.initializeProject();
		const run = storage.createRun(
			{ ...packet, provenance_ref: "admission:unit-1" },
			{ trustLane: "governed" },
		);
		storage.recordWorkspacePrepared(run.id, {
			path: createWorkspacePath(root, run.id),
			headSha: "b".repeat(40),
			sourceProjectRoot: root,
		});
		storage.markRunRunning(run.id);
		const candidate = sealedCandidateArtifact(run.id, "sealed_v3");

		storage.commitRunCandidateOutcome(run.id, { decision, candidate });

		expect(storage.getCandidateArtifact(run.id)).toMatchObject({
			schemaVersion: 2,
			actionEvidenceVersion: "sealed_v3",
			actionReceiptSetRef: "tape:action-receipt-set:workflow-1/unit-1/1",
			actionReceiptSetDigest: `sha256:${"9".repeat(64)}`,
			candidateCreatedRef: "tape:candidate-created:workflow-1/unit-1/1",
		});
		const database = openStateDatabase(root);
		expect(
			database
				.prepare(
					`SELECT schema_version, action_evidence_version, action_receipt_set_ref, action_receipt_set_digest, candidate_created_ref FROM candidate_artifacts WHERE run_id = ?`,
				)
				.get(run.id),
		).toEqual({
			schema_version: 2,
			action_evidence_version: "sealed_v3",
			action_receipt_set_ref: "tape:action-receipt-set:workflow-1/unit-1/1",
			action_receipt_set_digest: `sha256:${"9".repeat(64)}`,
			candidate_created_ref: "tape:candidate-created:workflow-1/unit-1/1",
		});
		database.close();
	});

	it("fails closed on incomplete or unknown persisted schema-v2 action-evidence lineage", () => {
		const root = mkdtempSync(
			join(tmpdir(), "buildplane-store-v3-candidate-action-evidence-reject-"),
		);
		const storage = createBuildplaneStorage(root);
		storage.initializeProject();
		const run = storage.createRun(
			{ ...packet, provenance_ref: "admission:unit-1" },
			{ trustLane: "governed" },
		);
		storage.recordWorkspacePrepared(run.id, {
			path: createWorkspacePath(root, run.id),
			headSha: "b".repeat(40),
			sourceProjectRoot: root,
		});
		storage.markRunRunning(run.id);
		const sealed = sealedCandidateArtifact(run.id, "sealed_v3");
		const { actionEvidenceVersion: _missingVersion, ...missingVersion } =
			sealed;
		const { actionReceiptSetDigest: _missingSetDigest, ...missingSetDigest } =
			sealed;
		const { candidateCreatedRef: _missingCreatedRef, ...missingCreatedRef } =
			sealed;
		const mixedLegacyReceipt = sealedCandidateArtifact(run.id, "sealed_v3", {
			actionReceiptDigest: `sha256:${"0".repeat(64)}`,
		});

		for (const candidate of [
			missingVersion,
			missingSetDigest,
			missingCreatedRef,
			mixedLegacyReceipt,
		]) {
			expect(() =>
				storage.commitRunCandidateOutcome(run.id, { decision, candidate }),
			).toThrow(/schemaVersion 2/i);
		}
		expect(storage.getCandidateArtifact(run.id)).toBeNull();
		expect(storage.inspectTarget(run.id)).toMatchObject({
			run: { status: "running" },
			workspace: { status: "active" },
		});

		storage.commitRunCandidateOutcome(run.id, {
			decision,
			candidate: sealedCandidateArtifact(run.id, "sealed_v3"),
		});
		const database = openStateDatabase(root);
		database
			.prepare(
				"UPDATE candidate_artifacts SET action_evidence_version = ? WHERE run_id = ?",
			)
			.run("sealed_v4", run.id);
		database.close();

		expect(() => storage.getCandidateArtifact(run.id)).toThrow(
			/missing required governed action-evidence lineage/i,
		);
	});

	it("fails closed on unsupported candidate and action-evidence versions", () => {
		const root = mkdtempSync(
			join(tmpdir(), "buildplane-store-candidate-version-reject-"),
		);
		const storage = createBuildplaneStorage(root);
		storage.initializeProject();
		const run = storage.createRun(
			{ ...packet, provenance_ref: "admission:unit-1" },
			{ trustLane: "governed" },
		);
		storage.recordWorkspacePrepared(run.id, {
			path: createWorkspacePath(root, run.id),
			headSha: "b".repeat(40),
			sourceProjectRoot: root,
		});
		storage.markRunRunning(run.id);

		const unsupportedSchema = {
			...sealedCandidateArtifact(run.id, "sealed_v3"),
			schemaVersion: 3 as never,
		};
		const unsupportedEvidenceVersion = sealedCandidateArtifact(
			run.id,
			"sealed_v3",
			{
				actionEvidenceVersion: "sealed_v4" as never,
			},
		);

		expect(() =>
			storage.commitRunCandidateOutcome(run.id, {
				decision,
				candidate: unsupportedSchema,
			}),
		).toThrow(/schemaVersion must be 1 or 2/i);
		expect(() =>
			storage.commitRunCandidateOutcome(run.id, {
				decision,
				candidate: unsupportedEvidenceVersion,
			}),
		).toThrow(/requires actionEvidenceVersion/i);
		expect(storage.getCandidateArtifact(run.id)).toBeNull();
		expect(storage.inspectTarget(run.id)).toMatchObject({
			run: { status: "running" },
			workspace: { status: "active" },
		});
	});

	it("rejects sealed_v3 action evidence on a non-governed run", () => {
		const root = mkdtempSync(
			join(tmpdir(), "buildplane-store-v3-candidate-legacy-run-reject-"),
		);
		const storage = createBuildplaneStorage(root);
		storage.initializeProject();
		const run = storage.createRun(packet);
		storage.recordWorkspacePrepared(run.id, {
			path: createWorkspacePath(root, run.id),
			headSha: "b".repeat(40),
			sourceProjectRoot: root,
		});
		storage.markRunRunning(run.id);

		expect(() =>
			storage.commitRunCandidateOutcome(run.id, {
				decision,
				candidate: sealedCandidateArtifact(run.id, "sealed_v3"),
			}),
		).toThrow(/requires a governed run/i);
		expect(storage.getCandidateArtifact(run.id)).toBeNull();
		expect(storage.inspectTarget(run.id)).toMatchObject({
			run: { status: "running" },
			workspace: { status: "active" },
		});
	});

	it("rejects sealed_v3 action evidence without matching packet provenance", () => {
		const root = mkdtempSync(
			join(tmpdir(), "buildplane-store-v3-candidate-provenance-reject-"),
		);
		const storage = createBuildplaneStorage(root);
		storage.initializeProject();
		const run = storage.createRun(packet, { trustLane: "governed" });
		storage.recordWorkspacePrepared(run.id, {
			path: createWorkspacePath(root, run.id),
			headSha: "b".repeat(40),
			sourceProjectRoot: root,
		});
		storage.markRunRunning(run.id);

		expect(() =>
			storage.commitRunCandidateOutcome(run.id, {
				decision,
				candidate: sealedCandidateArtifact(run.id, "sealed_v3"),
			}),
		).toThrow(/matching governed packet provenance/i);
		expect(storage.getCandidateArtifact(run.id)).toBeNull();
	});

	it.each([
		"sealed-v2",
		"sealed_v3",
	] as const)("prepares promotion from %s evidence without falling back to a legacy receipt", (actionEvidenceVersion) => {
		const root = mkdtempSync(
			join(
				tmpdir(),
				`buildplane-store-${actionEvidenceVersion}-candidate-promotion-`,
			),
		);
		const storage = createBuildplaneStorage(root);
		storage.initializeProject();
		const run = storage.createRun(
			{ ...packet, provenance_ref: "admission:unit-1" },
			{ trustLane: "governed" },
		);
		storage.recordWorkspacePrepared(run.id, {
			path: createWorkspacePath(root, run.id),
			headSha: "b".repeat(40),
			sourceProjectRoot: root,
		});
		storage.markRunRunning(run.id);
		storage.commitRunCandidateOutcome(run.id, {
			decision,
			candidate: sealedCandidateArtifact(run.id, actionEvidenceVersion),
		});
		const candidate = storage.getCandidateArtifact(run.id);
		if (!candidate) throw new Error("Expected sealed candidate artifact.");

		const prepared = storage.prepareCandidatePromotion(
			candidatePromotionIntent(candidate),
		);

		expect(prepared).toMatchObject({
			state: "prepared",
			candidate: {
				schemaVersion: 2,
				actionEvidenceVersion,
				actionReceiptSetRef: "tape:action-receipt-set:workflow-1/unit-1/1",
			},
		});
		expect(prepared.candidate).not.toHaveProperty("actionReceiptDigest");
	});

	it("requires a new workflow attempt before recording another candidate", () => {
		const root = mkdtempSync(
			join(tmpdir(), "buildplane-store-candidate-attempt-"),
		);
		const storage = createBuildplaneStorage(root);
		storage.initializeProject();
		const governedPacket: UnitPacket = {
			...packet,
			provenance_ref: "admission:unit-1",
		};

		const firstRun = storage.createRun(governedPacket);
		storage.recordWorkspacePrepared(firstRun.id, {
			path: createWorkspacePath(root, firstRun.id),
			headSha: "b".repeat(40),
			sourceProjectRoot: root,
		});
		storage.markRunRunning(firstRun.id);
		storage.commitRunCandidateOutcome(firstRun.id, {
			decision,
			candidate: candidateArtifact(firstRun.id),
		});

		const duplicateRun = storage.createRun(governedPacket);
		storage.recordWorkspacePrepared(duplicateRun.id, {
			path: createWorkspacePath(root, duplicateRun.id),
			headSha: "b".repeat(40),
			sourceProjectRoot: root,
		});
		storage.markRunRunning(duplicateRun.id);

		expect(() =>
			storage.commitRunCandidateOutcome(duplicateRun.id, {
				decision,
				candidate: candidateArtifact(duplicateRun.id, {
					candidateDigest: "3".repeat(64),
				}),
			}),
		).toThrow(/new attempt/i);
		expect(storage.inspectTarget(duplicateRun.id)).toMatchObject({
			run: { status: "running" },
			workspace: { status: "active" },
		});
		expect(storage.getCandidateArtifact(duplicateRun.id)).toBeNull();

		const nextAttemptRun = storage.createRun(governedPacket);
		storage.recordWorkspacePrepared(nextAttemptRun.id, {
			path: createWorkspacePath(root, nextAttemptRun.id),
			headSha: "b".repeat(40),
			sourceProjectRoot: root,
		});
		storage.markRunRunning(nextAttemptRun.id);
		const nextAttempt = storage.commitRunCandidateOutcome(nextAttemptRun.id, {
			decision,
			candidate: candidateArtifact(nextAttemptRun.id, {
				attempt: 2,
				candidateDigest: "4".repeat(64),
				candidateKey: "workflow-1:unit-1:attempt-2",
				candidateRef: "refs/buildplane/candidates/candidate-2",
			}),
		});

		expect(nextAttempt.status).toBe("running");
		expect(storage.getCandidateArtifact(nextAttemptRun.id)).toMatchObject({
			candidateId: "candidate-1",
			attempt: 2,
		});
	});

	it("preserves raw candidate identity without fabricating governed lineage", () => {
		const root = mkdtempSync(join(tmpdir(), "buildplane-store-raw-candidate-"));
		const storage = createBuildplaneStorage(root);
		storage.initializeProject();
		const run = storage.createRun(packet);
		storage.recordWorkspacePrepared(run.id, {
			path: createWorkspacePath(root, run.id),
			headSha: "b".repeat(40),
			sourceProjectRoot: root,
		});
		storage.markRunRunning(run.id);
		const {
			workflowId: _workflowId,
			unitId: _unitId,
			provenanceRef: _provenanceRef,
			envelopeDigest: _envelopeDigest,
			actionReceiptDigest: _actionReceiptDigest,
			...rawCandidate
		} = candidateArtifact(run.id, {
			candidateDigest: "5".repeat(64),
		});

		storage.commitRunCandidateOutcome(run.id, {
			decision,
			candidate: rawCandidate,
		});

		expect(storage.getCandidateArtifact(run.id)).toEqual(
			expect.objectContaining({
				runId: run.id,
				unitId: packet.unit.id,
				candidateDigest: "5".repeat(64),
			}),
		);
		expect(storage.getCandidateArtifact(run.id)).not.toHaveProperty(
			"workflowId",
		);
		expect(storage.getCandidateArtifact(run.id)).toMatchObject({ attempt: 1 });
		expect(storage.getCandidateArtifact(run.id)).not.toHaveProperty(
			"provenanceRef",
		);
	});

	it("requires candidate provenance to match a governed run", () => {
		const root = mkdtempSync(
			join(tmpdir(), "buildplane-store-candidate-provenance-"),
		);
		const storage = createBuildplaneStorage(root);
		storage.initializeProject();
		const run = storage.createRun({
			...packet,
			provenance_ref: "admission:governed-run",
		});
		storage.recordWorkspacePrepared(run.id, {
			path: createWorkspacePath(root, run.id),
			headSha: "b".repeat(40),
			sourceProjectRoot: root,
		});
		storage.markRunRunning(run.id);

		expect(() =>
			storage.commitRunCandidateOutcome(run.id, {
				decision,
				candidate: candidateArtifact(run.id, {
					provenanceRef: "admission:another-run",
				}),
			}),
		).toThrow(/provenance/i);
		expect(storage.getCandidateArtifact(run.id)).toBeNull();
		expect(storage.inspectTarget(run.id)).toMatchObject({
			run: { status: "running" },
			workspace: { status: "active" },
		});
	});

	it("rejects malformed raw candidate digests before changing durable state", () => {
		const root = mkdtempSync(
			join(tmpdir(), "buildplane-store-candidate-digest-"),
		);
		const storage = createBuildplaneStorage(root);
		storage.initializeProject();
		const run = storage.createRun(packet);
		storage.recordWorkspacePrepared(run.id, {
			path: createWorkspacePath(root, run.id),
			headSha: "b".repeat(40),
			sourceProjectRoot: root,
		});
		storage.markRunRunning(run.id);

		expect(() =>
			storage.commitRunCandidateOutcome(run.id, {
				decision,
				candidate: candidateArtifact(run.id, {
					candidateDigest: "not-a-candidate-digest",
				}),
			}),
		).toThrow(/digest/i);
		expect(storage.getCandidateArtifact(run.id)).toBeNull();
		expect(storage.inspectTarget(run.id)).toMatchObject({
			run: { status: "running" },
			workspace: { status: "active" },
		});
	});

	it("rolls back the entire candidate outcome when candidate persistence fails", () => {
		const root = mkdtempSync(
			join(tmpdir(), "buildplane-store-candidate-rollback-"),
		);
		createBuildplaneStorage(root).initializeProject();
		const storage = createStorageStore(root, {
			testingHooks: {
				failpoint(name) {
					if (name === "commitRunCandidateOutcome:after-candidate-insert") {
						throw new Error("candidate write failed");
					}
				},
			},
		});
		const run = storage.createRun({
			...packet,
			provenance_ref: "admission:unit-1",
		});
		storage.recordWorkspacePrepared(run.id, {
			path: createWorkspacePath(root, run.id),
			headSha: "b".repeat(40),
			sourceProjectRoot: root,
		});
		storage.markRunRunning(run.id);

		expect(() =>
			storage.commitRunCandidateOutcome(run.id, {
				decision,
				candidate: candidateArtifact(run.id),
			}),
		).toThrow("candidate write failed");

		const database = openStateDatabase(root);
		const candidateCount = database
			.prepare(`SELECT COUNT(*) AS count FROM candidate_artifacts`)
			.get() as { count: number };
		const decisionCount = database
			.prepare(`SELECT COUNT(*) AS count FROM decisions WHERE run_id = ?`)
			.get(run.id) as { count: number };
		database.close();

		expect(candidateCount.count).toBe(0);
		expect(decisionCount.count).toBe(0);
		expect(storage.inspectTarget(run.id)).toMatchObject({
			run: { status: "running" },
			workspace: { status: "active" },
		});
	});

	it("keeps legacy projections readable when the candidate table is absent", () => {
		const root = mkdtempSync(
			join(tmpdir(), "buildplane-store-legacy-candidate-projection-"),
		);
		const storage = createBuildplaneStorage(root);
		storage.initializeProject();
		const run = storage.createRun(packet);
		storage.markRunRunning(run.id);
		storage.completeRun(run.id, "passed");

		const database = openStateDatabase(root);
		database.exec(`DROP TABLE candidate_artifacts`);
		database.close();

		expect(storage.inspectTarget(run.id)).toMatchObject({
			run: { id: run.id, status: "passed" },
		});
		expect(storage.getCandidateArtifact(run.id)).toBeNull();
	});

	it("deduplicates a semantically identical candidate promotion intent and retains its original prepared timestamp", () => {
		const root = mkdtempSync(
			join(tmpdir(), "buildplane-store-promotion-dedupe-"),
		);
		const storage = createBuildplaneStorage(root);
		storage.initializeProject();
		const candidate = createPromotableCandidate(storage, root);
		const firstIntent = candidatePromotionIntent(candidate);

		const first = storage.prepareCandidatePromotion(firstIntent);
		const replay = storage.prepareCandidatePromotion({
			review: firstIntent.review,
			preparedAt: "2026-07-17T12:10:01.000Z",
			acceptance: firstIntent.acceptance,
			candidate: firstIntent.candidate,
			decision: firstIntent.decision,
			runId: firstIntent.runId,
		});

		expect(replay).toEqual(first);
		expect(replay.preparedAt).toBe("2026-07-17T12:00:01.000Z");
		const database = openStateDatabase(root);
		const count = database
			.prepare(`SELECT COUNT(*) AS count FROM candidate_promotions`)
			.get() as { count: number };
		database.close();
		expect(count.count).toBe(1);
	});

	it("requires durable acceptance and review evidence to bind the candidate commit SHA", () => {
		const root = mkdtempSync(
			join(tmpdir(), "buildplane-store-promotion-evidence-commit-"),
		);
		const storage = createBuildplaneStorage(root);
		storage.initializeProject();
		const candidate = createPromotableCandidate(storage, root);
		const intent = candidatePromotionIntent(candidate);
		const {
			candidateCommitSha: _acceptanceCommitSha,
			...acceptanceWithoutCommit
		} = intent.acceptance;
		const { candidateCommitSha: _reviewCommitSha, ...reviewWithoutCommit } =
			intent.review;

		expect(() =>
			storage.prepareCandidatePromotion({
				...intent,
				acceptance: acceptanceWithoutCommit,
				review: reviewWithoutCommit,
			}),
		).toThrow(/candidateCommitSha/i);
		expect(() =>
			storage.prepareCandidatePromotion({
				...intent,
				review: {
					...intent.review,
					candidateCommitSha: "d".repeat(40),
				},
			}),
		).toThrow(/exact immutable candidate commit SHA/i);
	});

	it("rejects an acceptance record from a different signed acceptance contract before persisting a promotion", () => {
		const root = mkdtempSync(
			join(tmpdir(), "buildplane-store-promotion-contract-binding-"),
		);
		const storage = createBuildplaneStorage(root);
		storage.initializeProject();
		const candidate = createPromotableCandidate(storage, root);
		const intent = candidatePromotionIntent(candidate);

		expect(() =>
			storage.prepareCandidatePromotion({
				...intent,
				acceptance: {
					...intent.acceptance,
					acceptanceContractDigest: `sha256:${"9".repeat(64)}`,
				},
			}),
		).toThrow(/acceptanceContractDigest.*signed dispatch/i);

		const database = openStateDatabase(root);
		const count = database
			.prepare(`SELECT COUNT(*) AS count FROM candidate_promotions`)
			.get() as { count: number };
		database.close();
		expect(count.count).toBe(0);
	});

	it("rejects promotion idempotency conflicts across intent content, keys, and candidate digests", () => {
		const root = mkdtempSync(
			join(tmpdir(), "buildplane-store-promotion-conflict-"),
		);
		const storage = createBuildplaneStorage(root);
		storage.initializeProject();
		const candidate = createPromotableCandidate(storage, root);
		const intent = candidatePromotionIntent(candidate);
		storage.prepareCandidatePromotion(intent);

		expect(() =>
			storage.prepareCandidatePromotion({
				...intent,
				review: {
					...intent.review,
					verdict: {
						...intent.review.verdict,
						confidence: 0.75,
					},
				},
			}),
		).toThrow(/different canonical intent/i);

		expect(() =>
			storage.prepareCandidatePromotion({
				...intent,
				decision: {
					...intent.decision,
					idempotencyKey: "promotion-key-2",
				},
			}),
		).toThrow(/different idempotency key/i);

		const anotherCandidate = createPromotableCandidate(storage, root, {
			candidateId: "candidate-2",
			candidateKey: "workflow-1:unit-1:attempt-2",
			candidateRef: "refs/buildplane/candidates/candidate-2",
			attempt: 2,
			candidateDigest: "4".repeat(64),
			commitDigest: "5".repeat(64),
			treeDigest: "6".repeat(64),
			patchDigest: "7".repeat(64),
			changedFilesDigest: "8".repeat(64),
		});
		expect(() =>
			storage.prepareCandidatePromotion(
				candidatePromotionIntent(anotherCandidate),
			),
		).toThrow(/idempotency key.*different candidate digest/i);
	});

	it("returns both prepared and recorded candidate promotions for recovery", () => {
		const root = mkdtempSync(
			join(tmpdir(), "buildplane-store-promotion-pending-"),
		);
		const storage = createBuildplaneStorage(root);
		storage.initializeProject();
		const candidate = createPromotableCandidate(storage, root);
		const intent = candidatePromotionIntent(candidate);
		const prepared = storage.prepareCandidatePromotion(intent);

		expect(storage.listPendingCandidatePromotions()).toEqual([prepared]);
		storage.markCandidatePromotionRecorded(
			candidate.candidateDigest,
			intent.decision.idempotencyKey,
		);
		expect(storage.listPendingCandidatePromotions()).toEqual([
			{
				...prepared,
				state: "recorded",
			},
		]);
	});

	it("issues one durable execution lease and refuses a concurrent promotion claimant", () => {
		const root = mkdtempSync(
			join(tmpdir(), "buildplane-store-promotion-exclusive-lease-"),
		);
		createBuildplaneStorage(root).initializeProject();
		const now = new Date("2026-07-18T12:00:00.000Z");
		const storage = createStorageStore(root, {
			testingHooks: {
				now: () => now,
			},
		});
		const candidate = createPromotableCandidate(storage, root);
		const intent = candidatePromotionIntent(candidate);
		storage.prepareCandidatePromotion(intent);
		storage.markCandidatePromotionRecorded(
			candidate.candidateDigest,
			intent.decision.idempotencyKey,
		);

		const first = storage.claimCandidatePromotionExecution(
			candidate.candidateDigest,
			intent.decision.idempotencyKey,
		);

		expect(first).toEqual(
			expect.objectContaining({
				schemaVersion: 1,
				state: "active",
				candidateDigest: `sha256:${candidate.candidateDigest}`,
				idempotencyKey: intent.decision.idempotencyKey,
				leaseToken: expect.any(String),
				claimedAt: now.toISOString(),
				leaseExpiresAt: expect.any(String),
				claimEpoch: 1,
			}),
		);
		expect(() =>
			storage.claimCandidatePromotionExecution(
				candidate.candidateDigest,
				intent.decision.idempotencyKey,
			),
		).toThrow(/active candidate promotion execution lease/i);

		const restarted = createStorageStore(root, {
			testingHooks: {
				now: () => now,
			},
		});
		expect(() =>
			restarted.claimCandidatePromotionExecution(
				candidate.candidateDigest,
				intent.decision.idempotencyKey,
			),
		).toThrow(/active candidate promotion execution lease/i);
	});

	it("reclaims an expired execution lease and rejects a stale owner before terminal recording", () => {
		const root = mkdtempSync(
			join(tmpdir(), "buildplane-store-promotion-expired-lease-"),
		);
		createBuildplaneStorage(root).initializeProject();
		let now = new Date("2026-07-18T12:00:00.000Z");
		const storage = createStorageStore(root, {
			testingHooks: {
				now: () => now,
			},
		});
		const candidate = createPromotableCandidate(storage, root);
		const intent = candidatePromotionIntent(candidate);
		storage.prepareCandidatePromotion(intent);
		storage.markCandidatePromotionRecorded(
			candidate.candidateDigest,
			intent.decision.idempotencyKey,
		);
		const first = storage.claimCandidatePromotionExecution(
			candidate.candidateDigest,
			intent.decision.idempotencyKey,
		);

		now = new Date(first.leaseExpiresAt);
		expect(
			storage.getCandidatePromotionExecutionClaimState(
				candidate.candidateDigest,
				intent.decision.idempotencyKey,
			),
		).toMatchObject({ state: "expired", claimEpoch: 1 });
		const second = storage.claimCandidatePromotionExecution(
			candidate.candidateDigest,
			intent.decision.idempotencyKey,
		);
		expect(second).toMatchObject({ state: "active", claimEpoch: 2 });
		expect(second.leaseToken).not.toBe(first.leaseToken);

		const mergedHeadSha = "9".repeat(40);
		const outcome = {
			outcome: "promoted" as const,
			mergedHeadSha,
			promotionGitBinding: {
				...promotionGitBinding(candidate, mergedHeadSha),
				targetHeadAfterSha: mergedHeadSha,
				worktreeSyncState: "pending_reconciliation" as const,
			},
		};
		expect(() =>
			storage.markCandidatePromotionExecuted(
				candidate.candidateDigest,
				intent.decision.idempotencyKey,
				outcome,
				first.leaseToken,
			),
		).toThrow(/lease token does not match the active owner/i);
		expect(() =>
			storage.markCandidatePromotionExecuted(
				candidate.candidateDigest,
				intent.decision.idempotencyKey,
				outcome,
				second.leaseToken,
			),
		).not.toThrow();

		expect(
			storage.getCandidatePromotionExecutionClaimState(
				candidate.candidateDigest,
				intent.decision.idempotencyKey,
			),
		).toMatchObject({
			state: "completed",
			claimEpoch: 2,
			executedOutcome: "promoted",
		});
		// Replaying a terminal result is idempotent and does not need a new lease.
		expect(() =>
			storage.markCandidatePromotionExecuted(
				candidate.candidateDigest,
				intent.decision.idempotencyKey,
				outcome,
			),
		).not.toThrow();
	});

	it("keeps a recorded promotion claim active and excludes a terminally corrupted run from recovery", () => {
		const root = mkdtempSync(
			join(tmpdir(), "buildplane-store-promotion-active-claim-"),
		);
		const storage = createBuildplaneStorage(root);
		storage.initializeProject();
		const candidate = createPromotableCandidate(storage, root);
		const intent = candidatePromotionIntent(candidate);
		storage.prepareCandidatePromotion(intent);
		storage.markCandidatePromotionRecorded(
			candidate.candidateDigest,
			intent.decision.idempotencyKey,
		);

		expect(() =>
			storage.claimCandidatePromotionExecution(
				candidate.candidateDigest,
				intent.decision.idempotencyKey,
			),
		).not.toThrow();
		expect(() => storage.suspendRun(candidate.runId)).toThrow(
			/active candidate promotion claim/i,
		);
		expect(() => storage.completeRun(candidate.runId, "failed")).toThrow(
			/active candidate promotion claim/i,
		);
		expect(storage.inspectTarget(candidate.runId).run.status).toBe("running");

		// Simulate a stale/externally corrupted terminal projection. Recovery must
		// never treat it as execution authority, and the immediate pre-Git claim
		// must refuse it even if a caller bypassed normal terminal transitions.
		const database = openStateDatabase(root);
		database
			.prepare(
				"UPDATE runs SET status = 'failed', completed_at = ? WHERE id = ?",
			)
			.run("2026-07-18T00:00:00.000Z", candidate.runId);
		database.close();

		expect(storage.listPendingCandidatePromotions()).toEqual([]);
		expect(() =>
			storage.claimCandidatePromotionExecution(
				candidate.candidateDigest,
				intent.decision.idempotencyKey,
			),
		).toThrow(/active candidate run.*failed/i);
	});

	it("does not let PlanForge reconciliation terminally bypass a recorded candidate claim", () => {
		const root = mkdtempSync(
			join(tmpdir(), "buildplane-store-planforge-promotion-claim-"),
		);
		const storage = createBuildplaneStorage(root);
		storage.initializeProject();
		const planPacket: UnitPacket = {
			...packet,
			unit: { ...packet.unit, id: "plan-1:implement" },
			provenance_ref: "admission:plan-1",
		};
		const run = storage.createRun(planPacket, { trustLane: "governed" });
		storage.recordWorkspacePrepared(run.id, {
			path: createWorkspacePath(root, run.id),
			headSha: "b".repeat(40),
			sourceProjectRoot: root,
		});
		storage.markRunRunning(run.id);
		storage.commitRunCandidateOutcome(run.id, {
			decision,
			candidate: candidateArtifact(run.id, {
				unitId: planPacket.unit.id,
				provenanceRef: "admission:plan-1",
			}),
		});
		const candidate = storage.getCandidateArtifact(run.id);
		if (!candidate) throw new Error("Expected candidate artifact.");
		const intent = candidatePromotionIntent(candidate);
		storage.prepareCandidatePromotion(intent);
		storage.markCandidatePromotionRecorded(
			candidate.candidateDigest,
			intent.decision.idempotencyKey,
		);

		expect(() =>
			storage.reconcilePlanForgeDispatchRuns("plan-1", "failed"),
		).toThrow(/active candidate promotion claim/i);
		expect(storage.inspectTarget(run.id).run.status).toBe("running");
	});

	it("keeps non-governed candidate promotions out of preparation and recovery", () => {
		const root = mkdtempSync(
			join(tmpdir(), "buildplane-store-non-governed-promotion-"),
		);
		const storage = createBuildplaneStorage(root);
		storage.initializeProject();
		const legacyCandidate = createPromotableCandidate(
			storage,
			root,
			{},
			"legacy",
		);
		expect(() =>
			storage.prepareCandidatePromotion(
				candidatePromotionIntent(legacyCandidate),
			),
		).toThrow(/requires a governed run/i);
		expect(storage.listPendingCandidatePromotions()).toEqual([]);

		// A pre-enforcement marker remains durable/readable, but must not be
		// resumed or executed after its run is classified as non-governed.
		const governedCandidate = createPromotableCandidate(storage, root, {
			candidateId: "candidate-governed-before-lane-change",
			candidateKey: "candidate-governed-before-lane-change/run-1/1",
			candidateRef:
				"refs/buildplane/candidates/candidate-governed-before-lane-change/run-1/1",
			workflowId: "workflow-2",
			candidateDigest: "4".repeat(64),
			commitDigest: "5".repeat(64),
			treeDigest: "6".repeat(64),
			patchDigest: "7".repeat(64),
			changedFilesDigest: "8".repeat(64),
		});
		const governedIntent = candidatePromotionIntent(governedCandidate, {
			decision: {
				...candidatePromotionIntent(governedCandidate).decision,
				idempotencyKey: "promotion-governed-before-lane-change",
			},
		});
		storage.prepareCandidatePromotion(governedIntent);
		storage.markCandidatePromotionRecorded(
			governedCandidate.candidateDigest,
			governedIntent.decision.idempotencyKey,
		);
		const database = openStateDatabase(root);
		database
			.prepare(`UPDATE runs SET trust_lane = 'legacy' WHERE id = ?`)
			.run(governedCandidate.runId);
		database.close();

		expect(() =>
			storage.markCandidatePromotionRecorded(
				governedCandidate.candidateDigest,
				governedIntent.decision.idempotencyKey,
			),
		).toThrow(/requires a governed run/i);
		expect(() =>
			storage.markCandidatePromotionExecuted(
				governedCandidate.candidateDigest,
				governedIntent.decision.idempotencyKey,
				{ outcome: "rejected" },
			),
		).toThrow(/requires a governed run/i);
		expect(storage.listPendingCandidatePromotions()).toEqual([]);
	});

	it("treats pre-trust-lane promotion rows as legacy instead of failing recovery reads", () => {
		const root = mkdtempSync(
			join(tmpdir(), "buildplane-store-legacy-promotion-recovery-"),
		);
		const storage = createBuildplaneStorage(root);
		storage.initializeProject();
		const candidate = createPromotableCandidate(storage, root, {
			candidateId: "candidate-legacy-lane",
			candidateKey: "candidate-legacy-lane/run-1/1",
			candidateRef: "refs/buildplane/candidates/candidate-legacy-lane/run-1/1",
			candidateDigest: "9".repeat(64),
		});
		const intent = candidatePromotionIntent(candidate, {
			decision: {
				...candidatePromotionIntent(candidate).decision,
				idempotencyKey: "promotion-legacy-lane",
			},
		});
		storage.prepareCandidatePromotion(intent);

		const database = openStateDatabase(root);
		database.exec("ALTER TABLE runs DROP COLUMN trust_lane");
		database.close();

		// An old row has no durable governed authority, so it is not eligible for
		// recovery and must not make a read path crash or write a migration.
		expect(storage.listPendingCandidatePromotions()).toEqual([]);
	});

	it("excludes executed candidate promotions from recovery and preserves their terminal marker idempotently", () => {
		const root = mkdtempSync(
			join(tmpdir(), "buildplane-store-promotion-executed-"),
		);
		const storage = createBuildplaneStorage(root);
		storage.initializeProject();
		const candidate = createPromotableCandidate(storage, root);
		const intent = candidatePromotionIntent(candidate);
		storage.prepareCandidatePromotion(intent);
		storage.markCandidatePromotionRecorded(
			candidate.candidateDigest,
			intent.decision.idempotencyKey,
		);

		const mergedHeadSha = "9".repeat(40);
		const binding: PromotionGitBindingV1 = {
			...promotionGitBinding(candidate, mergedHeadSha),
			targetHeadAfterSha: mergedHeadSha,
			worktreeSyncState: "pending_reconciliation",
		};
		const executionLease = storage.claimCandidatePromotionExecution(
			candidate.candidateDigest,
			intent.decision.idempotencyKey,
		);
		storage.markCandidatePromotionExecuted(
			candidate.candidateDigest,
			intent.decision.idempotencyKey,
			{ outcome: "promoted", mergedHeadSha, promotionGitBinding: binding },
			executionLease.leaseToken,
		);
		storage.markCandidatePromotionExecuted(
			candidate.candidateDigest,
			intent.decision.idempotencyKey,
			{ outcome: "promoted", mergedHeadSha, promotionGitBinding: binding },
		);

		expect(storage.listPendingCandidatePromotions()).toEqual([]);
		expect(storage.inspectTarget(candidate.runId).run.status).toBe("passed");
		expect(
			storage.prepareCandidatePromotion({
				...intent,
				preparedAt: "2026-07-17T12:10:01.000Z",
			}),
		).toEqual({
			...intent,
			state: "executed",
			executedOutcome: "promoted",
			mergedHeadSha,
			promotionGitBinding: binding,
		});
		expect(() =>
			storage.markCandidatePromotionExecuted(
				candidate.candidateDigest,
				intent.decision.idempotencyKey,
				{
					outcome: "promoted",
					mergedHeadSha: "a".repeat(40),
					promotionGitBinding: {
						...promotionGitBinding(candidate, "a".repeat(40)),
						targetHeadAfterSha: "a".repeat(40),
						worktreeSyncState: "pending_reconciliation",
					},
				},
			),
		).toThrow(/different terminal outcome/i);
	});

	it("does not let a rejected candidate promotion decision record a merge-producing effect", () => {
		const root = mkdtempSync(
			join(tmpdir(), "buildplane-store-rejected-promotion-decision-"),
		);
		const storage = createBuildplaneStorage(root);
		storage.initializeProject();
		const candidate = createPromotableCandidate(storage, root);
		const baseIntent = candidatePromotionIntent(candidate);
		const intent = {
			...baseIntent,
			decision: { ...baseIntent.decision, decision: "reject" as const },
		};
		storage.prepareCandidatePromotion(intent);
		storage.markCandidatePromotionRecorded(
			candidate.candidateDigest,
			intent.decision.idempotencyKey,
		);

		const mergedHeadSha = "9".repeat(40);
		expect(() =>
			storage.markCandidatePromotionExecuted(
				candidate.candidateDigest,
				intent.decision.idempotencyKey,
				{
					outcome: "promoted",
					mergedHeadSha,
					promotionGitBinding: {
						...promotionGitBinding(candidate, mergedHeadSha),
						targetHeadAfterSha: mergedHeadSha,
						worktreeSyncState: "pending_reconciliation",
					},
				},
			),
		).toThrow(
			/rejected candidate promotion decision cannot record a merge-producing effect/i,
		);
		expect(() =>
			storage.markCandidatePromotionExecuted(
				candidate.candidateDigest,
				intent.decision.idempotencyKey,
				{
					outcome: "reconciliation_required",
					mergedHeadSha,
					promotionGitBinding: promotionGitBinding(candidate, mergedHeadSha),
				},
			),
		).toThrow(
			/rejected candidate promotion decision cannot record a merge-producing effect/i,
		);
		expect(storage.listPendingCandidatePromotions()).toHaveLength(1);
		expect(storage.inspectTarget(candidate.runId).run.status).toBe("running");
	});

	it("persists reconciliation-required promotion evidence as an executed suspended state across restart", () => {
		const root = mkdtempSync(
			join(tmpdir(), "buildplane-store-promotion-reconciliation-"),
		);
		const storage = createBuildplaneStorage(root);
		storage.initializeProject();
		const candidate = createPromotableCandidate(storage, root);
		const intent = candidatePromotionIntent(candidate);
		storage.prepareCandidatePromotion(intent);
		storage.markCandidatePromotionRecorded(
			candidate.candidateDigest,
			intent.decision.idempotencyKey,
		);

		const mergedHeadSha = "9".repeat(40);
		const binding = promotionGitBinding(candidate, mergedHeadSha);
		const executionLease = storage.claimCandidatePromotionExecution(
			candidate.candidateDigest,
			intent.decision.idempotencyKey,
		);
		storage.markCandidatePromotionExecuted(
			candidate.candidateDigest,
			intent.decision.idempotencyKey,
			{
				outcome: "reconciliation_required",
				mergedHeadSha,
				promotionGitBinding: binding,
			} as never,
			executionLease.leaseToken,
		);

		const restarted = createBuildplaneStorage(root);
		restarted.initializeProject();
		expect(restarted.listPendingCandidatePromotions()).toEqual([]);
		expect(restarted.inspectTarget(candidate.runId).run.status).toBe(
			"suspended",
		);
		expect(
			restarted.prepareCandidatePromotion({
				...intent,
				preparedAt: "2026-07-17T12:10:01.000Z",
			}),
		).toMatchObject({
			state: "executed",
			executedOutcome: "reconciliation_required",
			mergedHeadSha,
			promotionGitBinding: binding,
		});
		expect(() =>
			restarted.markCandidatePromotionExecuted(
				candidate.candidateDigest,
				intent.decision.idempotencyKey,
				{
					outcome: "reconciliation_required",
					mergedHeadSha,
					promotionGitBinding: binding,
				} as never,
			),
		).not.toThrow();

		const database = openStateDatabase(root);
		const row = database
			.prepare(
				`SELECT state, executed_outcome, promotion_git_binding_json FROM candidate_promotions`,
			)
			.get() as {
			state: string;
			executed_outcome: string;
			promotion_git_binding_json: string | null;
		};
		database.close();
		expect(row).toMatchObject({
			state: "executed",
			executed_outcome: "reconciliation_required",
		});
		expect(JSON.parse(row.promotion_git_binding_json ?? "null")).toEqual(
			binding,
		);
	});

	it("suspends a promotion whose target ref contains the merge but root checkout remains stale", () => {
		const root = mkdtempSync(
			join(tmpdir(), "buildplane-store-promotion-root-checkout-stale-"),
		);
		const storage = createBuildplaneStorage(root);
		storage.initializeProject();
		const candidate = createPromotableCandidate(storage, root);
		const intent = candidatePromotionIntent(candidate);
		storage.prepareCandidatePromotion(intent);
		storage.markCandidatePromotionRecorded(
			candidate.candidateDigest,
			intent.decision.idempotencyKey,
		);

		const mergedHeadSha = "9".repeat(40);
		const binding: PromotionGitBindingV1 = {
			...promotionGitBinding(candidate, mergedHeadSha),
			targetHeadAfterSha: mergedHeadSha,
			worktreeSyncState: "root_checkout_stale",
		};
		const executionLease = storage.claimCandidatePromotionExecution(
			candidate.candidateDigest,
			intent.decision.idempotencyKey,
		);
		storage.markCandidatePromotionExecuted(
			candidate.candidateDigest,
			intent.decision.idempotencyKey,
			{
				outcome: "reconciliation_required",
				mergedHeadSha,
				promotionGitBinding: binding,
			},
			executionLease.leaseToken,
		);

		expect(storage.inspectTarget(candidate.runId).run.status).toBe("suspended");
		expect(
			storage.prepareCandidatePromotion({
				...intent,
				preparedAt: "2026-07-17T12:10:01.000Z",
			}),
		).toMatchObject({
			state: "executed",
			executedOutcome: "reconciliation_required",
			promotionGitBinding: binding,
		});
	});

	it("persists run state and query snapshots", () => {
		const root = mkdtempSync(join(tmpdir(), "buildplane-store-"));
		const storage = createBuildplaneStorage(root);
		storage.initializeProject();

		const run = storage.createRun(packet);
		storage.markRunRunning(run.id);
		storage.recordExecutionEvidence(run.id, receipt);
		storage.recordDecision(run.id, decision);
		const completedRun = storage.completeRun(run.id, "passed");

		const status = storage.getStatusSnapshot();
		const inspect = storage.inspectTarget(run.id);

		expect(completedRun.status).toBe("passed");
		expect(status.latestRun?.status).toBe("passed");
		expect(status.latestRunUsedWorkspace).toBe(false);
		expect(status.latestWorkspace).toBeUndefined();
		expect(status.actionableWorkspaces).toEqual([]);
		expect(status.runCounts.passed).toBe(1);
		expect(inspect.kind).toBe("run");
		expect(inspect.run.id).toBe(run.id);
		expect(inspect.workspace).toBeUndefined();
		expect(inspect.evidence[0].kind).toBe("command-exit");
		expect(inspect.evidence[0]?.message).toBeUndefined();
		expect(inspect.decisions[0].kind).toBe("advance-run");
		expect(inspect.provenance).toEqual({
			route: {
				worker: "command",
				source: "command-block",
			},
			policy: {
				profile: "default",
				decisions: [
					{
						kind: "advance-run",
						outcome: "approved",
						reasons: [],
					},
				],
			},
		});
		expect(
			existsSync(join(root, ".buildplane", "logs", `${run.id}.stdout.log`)),
		).toBe(true);

		const database = openStateDatabase(root);
		const eventKinds = database
			.prepare(`SELECT kind FROM events ORDER BY rowid ASC`)
			.all() as { kind: string }[];
		const eventIndexes = database
			.prepare(`PRAGMA index_list(events)`)
			.all() as {
			name: string;
		}[];
		database.close();

		expect(eventKinds.map((row) => row.kind)).toEqual([
			"project-initialized",
			"run-created",
			"run-started",
			"execution-evidence-recorded",
			"decision-recorded",
			"run-completed",
		]);
		expect(eventIndexes.map((row) => row.name)).toContain(
			"idx_events_run_id_occurred_at",
		);
	});

	it("normalizes legacy packet snapshots without an execution role", () => {
		const root = mkdtempSync(join(tmpdir(), "buildplane-store-legacy-role-"));
		const storage = createBuildplaneStorage(root);
		storage.initializeProject();
		const run = storage.createRun(packet);
		const { execution_role: _legacyRole, ...legacyPacket } = packet;

		const database = openStateDatabase(root);
		try {
			database
				.prepare(`UPDATE runs SET unit_snapshot = ? WHERE id = ?`)
				.run(JSON.stringify(legacyPacket), run.id);
		} finally {
			database.close();
		}

		expect(storage.getPacketSnapshot(run.id)).toMatchObject({
			execution_role: "implementer",
		});
	});

	it("returns null when a persisted packet snapshot is malformed", () => {
		const root = mkdtempSync(
			join(tmpdir(), "buildplane-store-malformed-packet-"),
		);
		const storage = createBuildplaneStorage(root);
		storage.initializeProject();
		const run = storage.createRun(packet);

		const database = openStateDatabase(root);
		try {
			database
				.prepare(`UPDATE runs SET unit_snapshot = ? WHERE id = ?`)
				.run("{not valid JSON", run.id);
		} finally {
			database.close();
		}

		expect(storage.getPacketSnapshot(run.id)).toBeNull();
	});

	it("surfaces a compact event tape summary in inspect snapshots", () => {
		const root = mkdtempSync(join(tmpdir(), "buildplane-store-event-tape-"));
		const storage = createBuildplaneStorage(root);
		storage.initializeProject();

		const run = storage.createRun({
			...packet,
			unit: { ...packet.unit, id: "unit-event-tape" },
		});
		storage.markRunRunning(run.id);
		storage.recordExecutionEvidence(run.id, failedReceipt);
		storage.recordDecision(run.id, rejectedDecision);
		storage.completeRun(run.id, "failed");

		const inspect = storage.inspectTarget(run.id);
		expect(inspect.eventTape).toMatchObject({
			runId: run.id,
			eventCount: 5,
			firstKind: "run-created",
			lastKind: "run-completed",
			terminalStatus: "failed",
		});
		expect(inspect.eventTape?.events.map((event) => event.kind)).toEqual([
			"run-created",
			"run-started",
			"execution-evidence-recorded",
			"decision-recorded",
			"run-completed",
		]);
		expect(inspect.eventTape?.events[1]?.summary).toBe(
			"started unit unit-event-tape",
		);
		expect(inspect.eventTape?.firstOccurredAt).toBe(
			inspect.eventTape?.events[0]?.occurredAt,
		);
		expect(inspect.eventTape?.lastOccurredAt).toBe(
			inspect.eventTape?.events[inspect.eventTape.events.length - 1]
				?.occurredAt,
		);
		expect(inspect.eventTape?.kindCounts).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ kind: "run-created", count: 1 }),
				expect.objectContaining({ kind: "run-started", count: 1 }),
				expect.objectContaining({
					kind: "execution-evidence-recorded",
					count: 1,
				}),
				expect.objectContaining({ kind: "decision-recorded", count: 1 }),
				expect.objectContaining({ kind: "run-completed", count: 1 }),
			]),
		);
		expect(inspect.eventTape?.events[2]?.metadata).toMatchObject({
			exitCode: 1,
			outputChecksCount: 1,
			failedOutputChecks: 1,
		});
		expect(inspect.eventTape?.events[3]?.metadata).toMatchObject({
			kind: "reject-run",
			outcome: "rejected",
			reasonsCount: 1,
		});
	});

	it("keeps failed-run event tape, evidence, and decision reasons together", () => {
		const root = mkdtempSync(join(tmpdir(), "buildplane-store-failed-proof-"));
		const storage = createBuildplaneStorage(root);
		storage.initializeProject();

		const run = storage.createRun({
			...packet,
			unit: { ...packet.unit, id: "unit-failed-proof" },
		});
		storage.markRunRunning(run.id);
		storage.recordExecutionEvidence(run.id, failedReceipt);
		storage.recordDecision(run.id, rejectedDecision);
		storage.completeRun(run.id, "failed");

		const inspect = storage.inspectTarget(run.id);
		expect(inspect.run.status).toBe("failed");
		expect(inspect.evidence).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ kind: "command-exit", status: "fail" }),
				expect.objectContaining({ kind: "output-check", status: "fail" }),
			]),
		);
		expect(inspect.decisions).toEqual([
			expect.objectContaining({
				kind: "reject-run",
				outcome: "rejected",
				reasons: ["command exited with code 1"],
			}),
		]);
		expect(inspect.eventTape?.terminalStatus).toBe("failed");
	});

	it("surfaces route and policy provenance for model packets with routing hints", () => {
		const root = mkdtempSync(join(tmpdir(), "buildplane-store-provenance-"));
		const storage = createBuildplaneStorage(root);
		storage.initializeProject();
		const routedPacket: UnitPacket = {
			unit: {
				id: "unit-routed",
				kind: "model",
				scope: "task",
				inputRefs: [],
				expectedOutputs: [],
				verificationContract: "exit-0",
				policyProfile: "requires-review",
			},
			execution_role: "implementer",
			model: {
				provider: "openai-codex",
				model: "gpt-5.4",
				prompt: "Implement the slice",
			},
			routingHints: {
				preferredWorker: "codex",
				preferredModel: "gpt-5.4",
				effort: "high",
			},
			verification: {
				requiredOutputs: [],
			},
		};

		const run = storage.createRun(routedPacket);
		storage.recordDecision(run.id, {
			kind: "advance-run",
			outcome: "approved",
			reasons: ["requires human approval"],
		});
		const inspectRun = storage.inspectTarget(run.id);
		const inspectUnit = storage.inspectTarget(routedPacket.unit.id);

		expect(inspectRun.provenance).toEqual({
			route: {
				worker: "codex",
				source: "routing-hints",
				preferredWorker: "codex",
				preferredModel: "gpt-5.4",
				effort: "high",
				provider: "openai-codex",
				model: "gpt-5.4",
			},
			policy: {
				profile: "requires-review",
				decisions: [
					{
						kind: "advance-run",
						outcome: "approved",
						reasons: ["requires human approval"],
					},
				],
			},
		});
		expect(inspectUnit.provenance).toEqual(inspectRun.provenance);
	});

	it("falls back to unit kind for legacy model runs without packet snapshots", () => {
		const root = mkdtempSync(join(tmpdir(), "buildplane-store-legacy-model-"));
		const storage = createBuildplaneStorage(root);
		storage.initializeProject();
		const legacyModelPacket: UnitPacket = {
			unit: {
				id: "unit-legacy-model",
				kind: "model",
				scope: "task",
				inputRefs: [],
				expectedOutputs: [],
				verificationContract: "exit-0",
				policyProfile: "requires-review",
			},
			execution_role: "implementer",
			model: {
				provider: "openai-codex",
				model: "gpt-5.4",
				prompt: "Implement the slice",
			},
			verification: {
				requiredOutputs: [],
			},
		};

		const run = storage.createRun(legacyModelPacket);
		const database = new DatabaseSync(join(root, ".buildplane", "state.db"));
		try {
			database
				.prepare(`UPDATE runs SET unit_snapshot = ? WHERE id = ?`)
				.run(JSON.stringify(legacyModelPacket.unit), run.id);
		} finally {
			database.close();
		}

		const inspectRun = storage.inspectTarget(run.id);
		const inspectUnit = storage.inspectTarget(legacyModelPacket.unit.id);

		expect(inspectRun.provenance.route).toEqual({
			worker: "ai-sdk",
			source: "model-block",
		});
		expect(inspectUnit.provenance.route).toEqual({
			worker: "ai-sdk",
			source: "model-block",
		});
	});

	it("persists retained workspaces for rejected runs and exposes workspace snapshots", () => {
		const root = mkdtempSync(join(tmpdir(), "buildplane-store-workspaces-"));
		const storage = createBuildplaneStorage(root);
		storage.initializeProject();

		const run = storage.createRun(packet);
		const workspacePath = createWorkspacePath(root, run.id);

		storage.recordWorkspacePrepared(run.id, {
			path: workspacePath,
			headSha: "abc123",
			sourceProjectRoot: root,
		});

		const activeStatus = storage.getStatusSnapshot();
		expect(activeStatus.latestRunUsedWorkspace).toBe(true);
		expect(activeStatus.latestWorkspace).toMatchObject({
			runId: run.id,
			status: "active",
			headSha: "abc123",
		});
		expect(activeStatus.actionableWorkspaces).toEqual([]);

		storage.commitRunFailureOutcome(run.id, {
			decision: rejectedDecision,
			workspaceStatus: "retained",
		});

		const status = storage.getStatusSnapshot();
		expect(status.latestRunUsedWorkspace).toBe(true);
		expect(status.latestWorkspace).toMatchObject({
			runId: run.id,
			status: "retained",
			headSha: "abc123",
		});
		expect(status.actionableWorkspaces).toHaveLength(1);
		expect(status.actionableWorkspaces[0]?.path).toBe(workspacePath);

		const inspect = storage.inspectTarget(run.id);
		expect(inspect.workspace).toMatchObject({
			status: "retained",
			path: workspacePath,
		});
		expect(inspect.workspace?.finalizedAt).toEqual(expect.any(String));
		expect(inspect.eventTape).toMatchObject({
			lastKind: "workspace-retained",
			terminalStatus: "failed",
		});
	});

	it("persists infrastructure evidence for setup failures without fabricating a workspace row", () => {
		const root = mkdtempSync(join(tmpdir(), "buildplane-store-setup-failure-"));
		const storage = createBuildplaneStorage(root);
		storage.initializeProject();

		const run = storage.createRun(packet);
		const infrastructureFailure: RunInfrastructureFailure = {
			kind: "workspace-prepare-failed",
			message: "git worktree add failed",
		};

		storage.commitRunFailureOutcome(run.id, {
			infrastructureFailure,
		});

		const status = storage.getStatusSnapshot();
		expect(status.latestRunUsedWorkspace).toBe(true);
		expect(status.latestWorkspace).toBeUndefined();
		expect(status.actionableWorkspaces).toEqual([]);

		const inspect = storage.inspectTarget(run.id);
		expect(inspect.workspace).toBeUndefined();
		expect(inspect.evidence).toContainEqual({
			id: expect.any(String),
			kind: infrastructureFailure.kind,
			status: "fail",
			message: infrastructureFailure.message,
		});

		const database = openStateDatabase(root);
		const workspaceCount = database
			.prepare(`SELECT COUNT(*) AS count FROM workspaces WHERE run_id = ?`)
			.get(run.id) as { count: number };
		database.close();

		expect(workspaceCount.count).toBe(0);
	});

	it("retains prepared workspaces and failure evidence together for post-prepare infrastructure failures", () => {
		const root = mkdtempSync(
			join(tmpdir(), "buildplane-store-runtime-failure-"),
		);
		const storage = createBuildplaneStorage(root);
		storage.initializeProject();

		const run = storage.createRun(packet);
		const workspacePath = createWorkspacePath(root, run.id);
		const infrastructureFailure: RunInfrastructureFailure = {
			kind: "runtime-execution-failed",
			message: "runtime crashed before completion",
		};

		storage.recordWorkspacePrepared(run.id, {
			path: workspacePath,
			headSha: "def456",
			sourceProjectRoot: root,
		});
		storage.commitRunFailureOutcome(run.id, {
			infrastructureFailure,
			workspaceStatus: "retained",
		});

		const status = storage.getStatusSnapshot();
		expect(status.latestRun?.status).toBe("failed");
		expect(status.latestRunUsedWorkspace).toBe(true);
		expect(status.latestWorkspace).toMatchObject({
			runId: run.id,
			status: "retained",
			path: workspacePath,
		});

		const inspect = storage.inspectTarget(run.id);
		expect(inspect.workspace).toMatchObject({
			status: "retained",
			path: workspacePath,
		});
		expect(inspect.evidence).toContainEqual({
			id: expect.any(String),
			kind: infrastructureFailure.kind,
			status: "fail",
			message: infrastructureFailure.message,
		});
	});

	it("marks successful workspaces as deleted without leaving actionable entries behind", () => {
		const root = mkdtempSync(
			join(tmpdir(), "buildplane-store-deleted-workspace-"),
		);
		const storage = createBuildplaneStorage(root);
		storage.initializeProject();

		const run = storage.createRun(packet);
		const workspacePath = createWorkspacePath(root, run.id);

		storage.recordWorkspacePrepared(run.id, {
			path: workspacePath,
			headSha: "abc123",
			sourceProjectRoot: root,
		});
		storage.markRunRunning(run.id);
		storage.commitRunSuccessOutcome(run.id, decision);
		storage.recordWorkspaceDeleted(run.id);

		const status = storage.getStatusSnapshot();
		expect(status.latestRun?.status).toBe("passed");
		expect(status.latestRunUsedWorkspace).toBe(true);
		expect(status.latestWorkspace).toMatchObject({
			runId: run.id,
			status: "deleted",
			path: workspacePath,
		});
		expect(status.actionableWorkspaces).toEqual([]);

		const inspect = storage.inspectTarget(run.id);
		expect(inspect.workspace).toMatchObject({
			status: "deleted",
			path: workspacePath,
		});
		expect(inspect.workspace?.finalizedAt).toEqual(expect.any(String));
	});

	it("copies workspace-backed required outputs into durable artifact storage", () => {
		const root = mkdtempSync(join(tmpdir(), "buildplane-store-artifacts-"));
		const storage = createBuildplaneStorage(root);
		storage.initializeProject();

		const run = storage.createRun(packet);
		const workspacePath = createWorkspacePath(root, run.id);
		mkdirSync(join(workspacePath, "tmp"), { recursive: true });
		writeFileSync(join(workspacePath, "tmp", "out.txt"), "ok");

		storage.recordWorkspacePrepared(run.id, {
			path: workspacePath,
			headSha: "abc123",
			sourceProjectRoot: root,
		});
		storage.markRunRunning(run.id);
		storage.recordExecutionEvidence(run.id, {
			...receipt,
			cwd: workspacePath,
		});
		storage.commitRunSuccessOutcome(run.id, decision);
		storage.recordWorkspaceDeleted(run.id);

		const inspect = storage.inspectTarget(run.id);
		expect(inspect.artifacts).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "required-output",
					location: `.buildplane/artifacts/${run.id}/tmp/out.txt`,
				}),
			]),
		);
		expect(
			readFileSync(
				join(root, ".buildplane", "artifacts", run.id, "tmp", "out.txt"),
				"utf8",
			),
		).toBe("ok");
	});

	it("marks successful workspaces with cleanup failures as actionable", () => {
		const root = mkdtempSync(
			join(tmpdir(), "buildplane-store-cleanup-failed-"),
		);
		const storage = createBuildplaneStorage(root);
		storage.initializeProject();

		const run = storage.createRun(packet);
		const workspacePath = createWorkspacePath(root, run.id);

		storage.recordWorkspacePrepared(run.id, {
			path: workspacePath,
			headSha: "abc123",
			sourceProjectRoot: root,
		});
		storage.markRunRunning(run.id);
		storage.commitRunSuccessOutcome(run.id, decision);
		storage.recordWorkspaceCleanupFailed(run.id, "permission denied");

		const status = storage.getStatusSnapshot();
		expect(status.latestRun?.status).toBe("passed");
		expect(status.latestWorkspace).toMatchObject({
			runId: run.id,
			status: "cleanup-failed",
			cleanupError: "permission denied",
		});
		expect(status.actionableWorkspaces).toHaveLength(1);
		expect(status.actionableWorkspaces[0]).toMatchObject({
			runId: run.id,
			status: "cleanup-failed",
			path: workspacePath,
			cleanupError: "permission denied",
		});
	});

	it("marks retained workspaces as deleted when operator cleanup completes", () => {
		const root = mkdtempSync(
			join(tmpdir(), "buildplane-store-cleaned-retained-"),
		);
		const storage = createBuildplaneStorage(root);
		storage.initializeProject();

		const run = storage.createRun(packet);
		const workspacePath = createWorkspacePath(root, run.id);
		storage.recordWorkspacePrepared(run.id, {
			path: workspacePath,
			headSha: "abc123",
			sourceProjectRoot: root,
		});
		storage.commitRunFailureOutcome(run.id, {
			decision: rejectedDecision,
			workspaceStatus: "retained",
		});

		storage.recordWorkspaceCleanedUp(run.id);

		const status = storage.getStatusSnapshot();
		expect(status.actionableWorkspaces).toEqual([]);
		expect(status.latestWorkspace).toMatchObject({
			runId: run.id,
			status: "deleted",
			path: workspacePath,
		});
		const inspect = storage.inspectTarget(run.id);
		expect(inspect.workspace).toMatchObject({
			status: "deleted",
			path: workspacePath,
		});
	});

	it("marks cleanup-failed workspaces as deleted when operator cleanup completes", () => {
		const root = mkdtempSync(
			join(tmpdir(), "buildplane-store-cleaned-failed-"),
		);
		const storage = createBuildplaneStorage(root);
		storage.initializeProject();

		const run = storage.createRun(packet);
		const workspacePath = createWorkspacePath(root, run.id);
		storage.recordWorkspacePrepared(run.id, {
			path: workspacePath,
			headSha: "abc123",
			sourceProjectRoot: root,
		});
		storage.markRunRunning(run.id);
		storage.commitRunSuccessOutcome(run.id, decision);
		storage.recordWorkspaceCleanupFailed(run.id, "permission denied");

		storage.recordWorkspaceCleanedUp(run.id);

		const status = storage.getStatusSnapshot();
		expect(status.actionableWorkspaces).toEqual([]);
		expect(status.latestWorkspace).toMatchObject({
			runId: run.id,
			status: "deleted",
			path: workspacePath,
		});
		const inspect = storage.inspectTarget(run.id);
		expect(inspect.workspace).toMatchObject({
			status: "deleted",
			path: workspacePath,
		});
	});

	it("rejects operator cleanup for non-actionable workspaces", () => {
		const root = mkdtempSync(
			join(tmpdir(), "buildplane-store-cleaned-invalid-"),
		);
		const storage = createBuildplaneStorage(root);
		storage.initializeProject();

		const run = storage.createRun(packet);
		const workspacePath = createWorkspacePath(root, run.id);
		storage.recordWorkspacePrepared(run.id, {
			path: workspacePath,
			headSha: "abc123",
			sourceProjectRoot: root,
		});

		expect(() => storage.recordWorkspaceCleanedUp(run.id)).toThrow(
			/operator cleanup requires a retained or cleanup-failed workspace/i,
		);
	});

	it("returns actionable workspaces newest-first and excludes deleted workspaces", () => {
		const root = mkdtempSync(join(tmpdir(), "buildplane-store-actionable-"));
		const storage = createBuildplaneStorage(root);
		storage.initializeProject();

		const firstRun = storage.createRun(packet);
		storage.recordWorkspacePrepared(firstRun.id, {
			path: createWorkspacePath(root, firstRun.id),
			headSha: "head-1",
			sourceProjectRoot: root,
		});
		storage.commitRunFailureOutcome(firstRun.id, {
			decision: rejectedDecision,
			workspaceStatus: "retained",
		});

		const secondRun = storage.createRun({
			...packet,
			unit: { ...packet.unit, id: "unit-2" },
		});
		storage.recordWorkspacePrepared(secondRun.id, {
			path: createWorkspacePath(root, secondRun.id),
			headSha: "head-2",
			sourceProjectRoot: root,
		});
		storage.markRunRunning(secondRun.id);
		storage.commitRunSuccessOutcome(secondRun.id, decision);
		storage.recordWorkspaceDeleted(secondRun.id);

		const thirdRun = storage.createRun({
			...packet,
			unit: { ...packet.unit, id: "unit-3" },
		});
		storage.recordWorkspacePrepared(thirdRun.id, {
			path: createWorkspacePath(root, thirdRun.id),
			headSha: "head-3",
			sourceProjectRoot: root,
		});
		storage.markRunRunning(thirdRun.id);
		storage.commitRunSuccessOutcome(thirdRun.id, decision);
		storage.recordWorkspaceCleanupFailed(thirdRun.id, "disk busy");

		const fourthRun = storage.createRun({
			...packet,
			unit: { ...packet.unit, id: "unit-4" },
		});
		storage.recordWorkspacePrepared(fourthRun.id, {
			path: createWorkspacePath(root, fourthRun.id),
			headSha: "head-4",
			sourceProjectRoot: root,
		});
		storage.commitRunFailureOutcome(fourthRun.id, {
			decision: rejectedDecision,
			workspaceStatus: "retained",
		});

		const status = storage.getStatusSnapshot();
		expect(
			status.actionableWorkspaces.map((workspace) => workspace.runId),
		).toEqual([fourthRun.id, thirdRun.id, firstRun.id]);
		expect(
			status.actionableWorkspaces.map((workspace) => workspace.status),
		).toEqual(["retained", "cleanup-failed", "retained"]);
	});

	it("orders actionable workspaces by latest actionable transition time", () => {
		const root = mkdtempSync(
			join(tmpdir(), "buildplane-store-actionable-order-"),
		);
		const storage = createBuildplaneStorage(root);
		storage.initializeProject();

		const firstRun = storage.createRun(packet);
		storage.recordWorkspacePrepared(firstRun.id, {
			path: createWorkspacePath(root, firstRun.id),
			headSha: "head-1",
			sourceProjectRoot: root,
		});
		storage.commitRunFailureOutcome(firstRun.id, {
			decision: rejectedDecision,
			workspaceStatus: "retained",
		});

		const secondRun = storage.createRun({
			...packet,
			unit: { ...packet.unit, id: "unit-order-2" },
		});
		storage.recordWorkspacePrepared(secondRun.id, {
			path: createWorkspacePath(root, secondRun.id),
			headSha: "head-2",
			sourceProjectRoot: root,
		});
		storage.markRunRunning(secondRun.id);
		storage.commitRunSuccessOutcome(secondRun.id, decision);
		storage.recordWorkspaceCleanupFailed(secondRun.id, "disk busy");

		const database = openStateDatabase(root);
		database
			.prepare(`UPDATE workspaces SET finalized_at = ? WHERE run_id = ?`)
			.run("2026-03-17T00:00:03.000Z", secondRun.id);
		database
			.prepare(`UPDATE workspaces SET finalized_at = ? WHERE run_id = ?`)
			.run("2026-03-17T00:00:04.000Z", firstRun.id);
		database.close();

		const status = storage.getStatusSnapshot();
		expect(
			status.actionableWorkspaces.map((workspace) => workspace.runId),
		).toEqual([firstRun.id, secondRun.id]);
	});

	it("writes workspace lifecycle events and projection rows together", () => {
		const root = mkdtempSync(join(tmpdir(), "buildplane-store-projections-"));
		const storage = createBuildplaneStorage(root);
		storage.initializeProject();

		const run = storage.createRun(packet);
		const workspacePath = createWorkspacePath(root, run.id);

		storage.recordWorkspacePrepared(run.id, {
			path: workspacePath,
			headSha: "abc123",
			sourceProjectRoot: root,
		});
		storage.commitRunFailureOutcome(run.id, {
			decision: rejectedDecision,
			workspaceStatus: "retained",
		});

		const database = openStateDatabase(root);
		const eventKinds = database
			.prepare(
				`SELECT kind FROM events WHERE kind LIKE 'workspace-%' ORDER BY rowid ASC`,
			)
			.all() as { kind: string }[];
		const workspaceRow = database
			.prepare(
				`SELECT run_id, source_project_root, path, head_sha, status, finalized_at FROM workspaces WHERE run_id = ?`,
			)
			.get(run.id) as {
			run_id: string;
			source_project_root: string;
			path: string;
			head_sha: string;
			status: string;
			finalized_at: string | null;
		};
		database.close();

		expect(eventKinds.map((row) => row.kind)).toEqual([
			"workspace-prepared",
			"workspace-retained",
		]);
		expect(workspaceRow).toMatchObject({
			run_id: run.id,
			source_project_root: root,
			path: workspacePath,
			head_sha: "abc123",
			status: "retained",
		});
		expect(workspaceRow.finalized_at).toEqual(expect.any(String));
	});

	it("rolls back workspace preparation when a failpoint fires mid-transaction", () => {
		const root = mkdtempSync(join(tmpdir(), "buildplane-store-failpoint-"));
		createBuildplaneStorage(root).initializeProject();
		const storage = createStorageStore(root, {
			testingHooks: {
				failpoint(name) {
					if (name === "recordWorkspacePrepared:after-workspace-upsert") {
						throw new Error("boom");
					}
				},
			},
		});

		const run = storage.createRun(packet);
		const workspacePath = createWorkspacePath(root, run.id);

		expect(() =>
			storage.recordWorkspacePrepared(run.id, {
				path: workspacePath,
				headSha: "abc123",
				sourceProjectRoot: root,
			}),
		).toThrow(/boom/);

		const database = openStateDatabase(root);
		const workspaceCount = database
			.prepare(`SELECT COUNT(*) AS count FROM workspaces WHERE run_id = ?`)
			.get(run.id) as { count: number };
		const eventCount = database
			.prepare(
				`SELECT COUNT(*) AS count FROM events WHERE kind = 'workspace-prepared'`,
			)
			.get() as { count: number };
		database.close();

		expect(workspaceCount.count).toBe(0);
		expect(eventCount.count).toBe(0);
		expect(storage.getStatusSnapshot().latestRunUsedWorkspace).toBe(false);
	});

	it("keeps per-run unit metadata snapshots when the same unit id runs again", () => {
		const root = mkdtempSync(join(tmpdir(), "buildplane-store-history-"));
		const storage = createBuildplaneStorage(root);
		storage.initializeProject();

		const firstPacket: UnitPacket = {
			...packet,
			unit: {
				...packet.unit,
				expectedOutputs: ["tmp/first.txt"],
			},
		};
		const secondPacket: UnitPacket = {
			...packet,
			unit: {
				...packet.unit,
				expectedOutputs: ["tmp/second.txt"],
			},
		};

		const firstRun = storage.createRun(firstPacket);
		storage.completeRun(firstRun.id, "passed");
		const secondRun = storage.createRun(secondPacket);
		storage.completeRun(secondRun.id, "passed");

		const inspect = storage.inspectTarget(firstRun.id);
		const unitInspect = storage.inspectTarget(packet.unit.id);

		expect(inspect.kind).toBe("run");
		expect(inspect.unit.expectedOutputs).toEqual(["tmp/first.txt"]);
		expect(unitInspect.kind).toBe("unit");
		expect(unitInspect.run.id).toBe(secondRun.id);
		expect(unitInspect.runHistory).toEqual([
			{ id: secondRun.id, status: "passed" },
			{ id: firstRun.id, status: "passed" },
		]);
	});

	it("surfaces strategy lineage and memory summary counts in inspect and history", () => {
		const root = mkdtempSync(
			join(tmpdir(), "buildplane-store-strategy-history-"),
		);
		const storage = createBuildplaneStorage(root);
		storage.initializeProject();

		const run = storage.createRun(
			{
				...packet,
				unit: { ...packet.unit, id: "unit-strategy-history" },
			},
			{ strategyId: "strategy-injected" },
		);
		storage.completeRun(run.id, "passed");
		storage.recordInjectedMemories(run.id, [
			{
				memoryKind: "repo-fact",
				memoryId: "fact-1",
				displayText: "[repo-fact] commands.typecheck: npx pnpm typecheck",
				matchReason: "fuzzy-fact-key",
				matchClass: "fuzzy",
			},
			{
				memoryKind: "procedure",
				memoryId: "procedure-1",
				displayText: "[procedure] fix TypeScript build: Run typecheck first.",
				matchReason: "exact-task-type",
				matchClass: "exact",
			},
		]);
		storage.createProcedure({
			name: "implement-then-review workflow for implement tasks",
			taskType: "implement",
			bodyMarkdown:
				"Use an implement-then-review workflow for implement tasks.\n\nObserved learning: missing type guards.",
			createdBy: "worker",
			sourceRunId: run.id,
			sourceTaskId: "task-implementer",
			metadata: {
				promotionRule: "multi-round-strategy-workflow->procedure",
				strategyMode: "implement-then-review",
			},
		});

		const inspect = storage.inspectTarget(run.id);
		const unitInspect = storage.inspectTarget("unit-strategy-history");
		const history = storage.getRunHistory();

		expect(inspect.strategy).toEqual({ strategyId: "strategy-injected" });
		expect(inspect.provenance).toMatchObject({
			route: {
				worker: "command",
				source: "command-block",
			},
			policy: {
				profile: "default",
			},
		});
		expect(unitInspect.strategy).toEqual({ strategyId: "strategy-injected" });
		expect(inspect.provenance).toMatchObject({
			route: {
				worker: "command",
				source: "command-block",
			},
			memory: {
				injectedCount: 2,
				matchReasons: ["fuzzy-fact-key", "exact-task-type"],
				matchClasses: ["fuzzy", "exact"],
			},
			policy: {
				profile: "default",
			},
		});
		expect(history[0]).toMatchObject({
			id: run.id,
			strategyId: "strategy-injected",
			injectedMemoryCount: 2,
			promotedStructuredMemoryCount: 1,
			routeWorker: "command",
			routeSource: "command-block",
			policyProfile: "default",
		});
	});

	it("surfaces promoted procedure lineage in inspect snapshots, including superseded records", () => {
		const root = mkdtempSync(
			join(tmpdir(), "buildplane-store-promotion-lineage-"),
		);
		const storage = createBuildplaneStorage(root);
		storage.initializeProject();

		const run = storage.createRun({
			...packet,
			unit: { ...packet.unit, id: "unit-promotion-lineage" },
		});
		storage.completeRun(run.id, "passed");

		const firstProcedure = storage.createProcedure({
			name: "implement-then-review workflow for implement tasks",
			taskType: "implement",
			bodyMarkdown:
				"Use an implement-then-review workflow for implement tasks.\n\nObserved learning: missing tests.",
			createdBy: "worker",
			sourceRunId: run.id,
			sourceTaskId: "task-implementer",
			metadata: {
				promotionRule: "multi-round-strategy-workflow->procedure",
				strategyMode: "implement-then-review",
			},
		});
		storage.supersedeProcedure(firstProcedure.id);
		const secondProcedure = storage.createProcedure({
			name: "implement-then-review workflow for implement tasks",
			taskType: "implement",
			bodyMarkdown:
				"Use an implement-then-review workflow for implement tasks.\n\nObserved learning: missing type guards.",
			createdBy: "worker",
			sourceRunId: run.id,
			sourceTaskId: "task-implementer",
			metadata: {
				promotionRule: "multi-round-strategy-workflow->procedure",
				strategyMode: "implement-then-review",
			},
		});

		const inspect = storage.inspectTarget(run.id);
		const unitInspect = storage.inspectTarget("unit-promotion-lineage");

		expect(inspect.promotedStructuredMemories).toHaveLength(2);
		expect(inspect.promotedStructuredMemories).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					memoryKind: "procedure",
					memoryId: firstProcedure.id,
					status: "superseded",
					promotionRule: "multi-round-strategy-workflow->procedure",
					sourceRunId: run.id,
					sourceTaskId: "task-implementer",
				}),
				expect.objectContaining({
					memoryKind: "procedure",
					memoryId: secondProcedure.id,
					status: "active",
					promotionRule: "multi-round-strategy-workflow->procedure",
					sourceRunId: run.id,
				}),
			]),
		);
		expect(unitInspect.promotedStructuredMemories).toEqual(
			inspect.promotedStructuredMemories,
		);
	});

	it("surfaces model routing provenance when a worker hint is present", () => {
		const root = mkdtempSync(
			join(tmpdir(), "buildplane-store-model-provenance-"),
		);
		const storage = createBuildplaneStorage(root);
		storage.initializeProject();

		const modelRun = storage.createRun({
			unit: {
				...packet.unit,
				id: "unit-model-provenance",
				kind: "model",
			},
			execution_role: "implementer",
			model: {
				provider: "openai",
				model: "gpt-5.4",
			},
			routingHints: {
				preferredWorker: "codex",
				preferredModel: "gpt-5.4",
				effort: "high",
			},
			verification: {
				requiredOutputs: [],
			},
		});
		storage.completeRun(modelRun.id, "passed");

		const inspect = storage.inspectTarget(modelRun.id);
		expect(inspect.provenance).toMatchObject({
			route: {
				worker: "codex",
				source: "routing-hints",
				provider: "openai",
				model: "gpt-5.4",
				preferredWorker: "codex",
				preferredModel: "gpt-5.4",
				effort: "high",
			},
			policy: {
				profile: "default",
			},
		});
	});

	it("rejects invalid failure-outcome payload combinations", () => {
		const root = mkdtempSync(
			join(tmpdir(), "buildplane-store-invalid-failure-"),
		);
		const storage = createBuildplaneStorage(root);
		storage.initializeProject();

		const rejectedRun = storage.createRun(packet);
		expect(() =>
			storage.commitRunFailureOutcome(rejectedRun.id, {
				decision: rejectedDecision,
			}),
		).toThrow(/retained/i);

		const preparedRun = storage.createRun({
			...packet,
			unit: { ...packet.unit, id: "unit-prepared" },
		});
		storage.recordWorkspacePrepared(preparedRun.id, {
			path: createWorkspacePath(root, preparedRun.id),
			headSha: "abc123",
			sourceProjectRoot: root,
		});
		expect(() =>
			storage.commitRunFailureOutcome(preparedRun.id, {
				infrastructureFailure: {
					kind: "runtime-failed",
					message: "boom",
				},
			}),
		).toThrow(/retained/i);

		const contradictoryRun = storage.createRun({
			...packet,
			unit: { ...packet.unit, id: "unit-contradictory" },
		});
		storage.recordWorkspacePrepared(contradictoryRun.id, {
			path: createWorkspacePath(root, contradictoryRun.id),
			headSha: "def456",
			sourceProjectRoot: root,
		});
		expect(() =>
			storage.commitRunFailureOutcome(contradictoryRun.id, {
				decision: decision as unknown as RejectedPolicyDecision,
				workspaceStatus: "retained",
			}),
		).toThrow(/rejected/i);

		const successRun = storage.createRun({
			...packet,
			unit: { ...packet.unit, id: "unit-invalid-success" },
		});
		expect(() =>
			storage.commitRunSuccessOutcome(
				successRun.id,
				rejectedDecision as unknown as ApprovedPolicyDecision,
			),
		).toThrow(/approved/i);
	});

	it("rejects invalid workspace finalization transitions", () => {
		const root = mkdtempSync(
			join(tmpdir(), "buildplane-store-invalid-workspace-"),
		);
		const storage = createBuildplaneStorage(root);
		storage.initializeProject();

		const run = storage.createRun(packet);
		storage.recordWorkspacePrepared(run.id, {
			path: createWorkspacePath(root, run.id),
			headSha: "abc123",
			sourceProjectRoot: root,
		});

		expect(() => storage.recordWorkspaceDeleted(run.id)).toThrow(/passed/i);
		expect(() => storage.recordWorkspaceCleanupFailed(run.id, "boom")).toThrow(
			/passed/i,
		);

		storage.commitRunFailureOutcome(run.id, {
			decision: rejectedDecision,
			workspaceStatus: "retained",
		});

		expect(() => storage.recordWorkspaceCleanupFailed(run.id, "boom")).toThrow(
			/active workspace/i,
		);
	});

	it("rejects invalid terminal-state transitions", () => {
		const root = mkdtempSync(join(tmpdir(), "buildplane-store-terminal-"));
		const storage = createBuildplaneStorage(root);
		storage.initializeProject();

		const completedRun = storage.createRun(packet);
		storage.completeRun(completedRun.id, "passed");
		expect(() => storage.markRunRunning(completedRun.id)).toThrow(/pending/i);
		expect(() => storage.completeRun(completedRun.id, "failed")).toThrow(
			/pending|running/i,
		);
		expect(() =>
			storage.recordWorkspacePrepared(completedRun.id, {
				path: createWorkspacePath(root, completedRun.id),
				headSha: "abc123",
				sourceProjectRoot: root,
			}),
		).toThrow(/pending/i);

		const successRun = storage.createRun({
			...packet,
			unit: { ...packet.unit, id: "unit-terminal-success" },
		});
		storage.markRunRunning(successRun.id);
		storage.commitRunSuccessOutcome(successRun.id, decision);
		expect(() =>
			storage.commitRunSuccessOutcome(successRun.id, decision),
		).toThrow(/running/i);
		expect(() =>
			storage.commitRunFailureOutcome(successRun.id, {
				infrastructureFailure: {
					kind: "late-failure",
					message: "too late",
				},
			}),
		).toThrow(/terminal|pending|running/i);

		const preparedRun = storage.createRun({
			...packet,
			unit: { ...packet.unit, id: "unit-terminal-prepared" },
		});
		storage.recordWorkspacePrepared(preparedRun.id, {
			path: createWorkspacePath(root, preparedRun.id),
			headSha: "def456",
			sourceProjectRoot: root,
		});
		expect(() => storage.completeRun(preparedRun.id, "passed")).toThrow(
			/workspace-backed|commitRun/i,
		);
		expect(() =>
			storage.recordWorkspacePrepared(preparedRun.id, {
				path: createWorkspacePath(root, `${preparedRun.id}-again`),
				headSha: "ghi789",
				sourceProjectRoot: root,
			}),
		).toThrow(/already exists/i);
	});

	it("rejects writes for unknown runs and does not create artifacts for missing outputs", () => {
		const root = mkdtempSync(join(tmpdir(), "buildplane-store-errors-"));
		const storage = createBuildplaneStorage(root);
		storage.initializeProject();

		expect(() => storage.markRunRunning("missing-run")).toThrow(
			/No run found/i,
		);
		expect(() =>
			storage.recordExecutionEvidence("missing-run", failedReceipt),
		).toThrow(/No run found/i);
		expect(() => storage.recordDecision("missing-run", decision)).toThrow(
			/No run found/i,
		);
		expect(() => storage.completeRun("missing-run", "passed")).toThrow(
			/No run found/i,
		);
		expect(() =>
			storage.recordWorkspacePrepared("missing-run", {
				path: createWorkspacePath(root, "missing-run"),
				headSha: "abc123",
				sourceProjectRoot: root,
			}),
		).toThrow(/No run found/i);

		const run = storage.createRun(packet);
		storage.recordExecutionEvidence(run.id, failedReceipt);
		const inspect = storage.inspectTarget(run.id);

		expect(inspect.artifacts).toEqual([]);
	});

	it("fails query access when projection tables are missing instead of silently recreating them", () => {
		const root = mkdtempSync(join(tmpdir(), "buildplane-store-corrupt-"));
		const storage = createBuildplaneStorage(root);
		storage.initializeProject();
		storage.createRun(packet);

		const database = openStateDatabase(root);
		database.exec(`DROP TABLE runs;`);
		database.close();

		expect(() => storage.getStatusSnapshot()).toThrow(
			/missing required projection schema|repair/i,
		);
	});

	it("migrates legacy candidate artifacts without inventing V3 action evidence", () => {
		const dir = mkdtempSync(
			join(tmpdir(), "bp-store-candidate-action-evidence-migration-"),
		);
		const db = new DatabaseSync(join(dir, "state.db"));
		const candidateDigest = "a".repeat(64);
		const actionReceiptDigest = `sha256:${"b".repeat(64)}`;
		db.exec(`
			CREATE TABLE candidate_artifacts (
				run_id TEXT PRIMARY KEY,
				schema_version INTEGER NOT NULL,
				candidate_id TEXT NOT NULL,
				candidate_key TEXT NOT NULL UNIQUE,
				candidate_ref TEXT NOT NULL UNIQUE,
				workflow_id TEXT,
				unit_id TEXT NOT NULL,
				attempt INTEGER NOT NULL,
				provenance_ref TEXT,
				candidate_digest TEXT NOT NULL UNIQUE,
				base_commit_sha TEXT NOT NULL,
				candidate_commit_sha TEXT NOT NULL,
				commit_digest TEXT NOT NULL,
				tree_digest TEXT NOT NULL,
				patch_digest TEXT NOT NULL,
				changed_files_digest TEXT NOT NULL,
				envelope_digest TEXT,
				acceptance_contract_digest TEXT,
				action_receipt_digest TEXT,
				created_at TEXT NOT NULL
			);
			INSERT INTO candidate_artifacts (
				run_id, schema_version, candidate_id, candidate_key, candidate_ref,
				workflow_id, unit_id, attempt, provenance_ref, candidate_digest,
				base_commit_sha, candidate_commit_sha, commit_digest, tree_digest,
				patch_digest, changed_files_digest, envelope_digest,
				acceptance_contract_digest, action_receipt_digest, created_at
			) VALUES (
				'legacy-run', 1, 'legacy-candidate', 'legacy-candidate/run/1',
				'refs/buildplane/candidates/legacy-candidate/run/1', 'workflow-1',
				'unit-1', 1, 'admission:legacy', '${candidateDigest}',
				'${"1".repeat(40)}', '${"2".repeat(40)}', '${"3".repeat(64)}',
				'${"4".repeat(64)}', '${"5".repeat(64)}', '${"6".repeat(64)}',
				'sha256:${"7".repeat(64)}', 'sha256:${"8".repeat(64)}',
				'${actionReceiptDigest}', '2026-07-18T00:00:00.000Z'
			);
		`);

		bootstrapStorageProjectionSchema(db);

		const columns = db
			.prepare(`PRAGMA table_info(candidate_artifacts)`)
			.all() as { name: string }[];
		expect(columns.map((column) => column.name)).toEqual(
			expect.arrayContaining([
				"action_receipt_set_ref",
				"action_receipt_set_digest",
				"action_evidence_version",
				"candidate_created_ref",
			]),
		);
		expect(
			db
				.prepare(
					`SELECT candidate_digest, action_receipt_digest, action_receipt_set_ref, action_receipt_set_digest, action_evidence_version, candidate_created_ref FROM candidate_artifacts WHERE run_id = 'legacy-run'`,
				)
				.get(),
		).toEqual({
			candidate_digest: candidateDigest,
			action_receipt_digest: actionReceiptDigest,
			action_receipt_set_ref: null,
			action_receipt_set_digest: null,
			action_evidence_version: null,
			candidate_created_ref: null,
		});
		expect(() => bootstrapStorageProjectionSchema(db)).not.toThrow();
		db.close();
	});

	it("migrates the legacy candidate-promotion outcome constraint and preserves existing rows", () => {
		const dir = mkdtempSync(
			join(tmpdir(), "bp-store-promotion-reconciliation-migration-"),
		);
		const db = new DatabaseSync(join(dir, "state.db"));
		db.exec(`
			CREATE TABLE candidate_promotions (
				candidate_digest TEXT NOT NULL,
				idempotency_key TEXT NOT NULL,
				run_id TEXT NOT NULL,
				state TEXT NOT NULL CHECK (state IN ('prepared', 'recorded', 'executed')),
				candidate_json TEXT NOT NULL,
				decision_json TEXT NOT NULL,
				acceptance_json TEXT NOT NULL,
				review_json TEXT NOT NULL,
				intent_canonical_json TEXT NOT NULL,
				prepared_at TEXT NOT NULL,
				recorded_at TEXT,
				executed_at TEXT,
				executed_outcome TEXT CHECK (executed_outcome IN ('promoted', 'rejected')),
				merged_head_sha TEXT,
				PRIMARY KEY (candidate_digest, idempotency_key),
				UNIQUE (candidate_digest),
				UNIQUE (idempotency_key)
			);
			INSERT INTO candidate_promotions (
				candidate_digest, idempotency_key, run_id, state, candidate_json,
				decision_json, acceptance_json, review_json, intent_canonical_json,
				prepared_at
			) VALUES (
				'sha256:${"a".repeat(64)}', 'legacy-promotion', 'legacy-run', 'prepared',
				'{}', '{}', '{}', '{}', '{}', '2026-07-17T12:00:00.000Z'
			);
		`);

		bootstrapStorageProjectionSchema(db);

		const columns = db
			.prepare(`PRAGMA table_info(candidate_promotions)`)
			.all() as { name: string }[];
		expect(columns.map((column) => column.name)).toEqual(
			expect.arrayContaining([
				"promotion_git_binding_json",
				"execution_claim_token",
				"execution_claimed_at",
				"execution_lease_expires_at",
				"execution_claim_epoch",
			]),
		);
		expect(
			db
				.prepare(
					`SELECT candidate_digest, idempotency_key FROM candidate_promotions WHERE idempotency_key = 'legacy-promotion'`,
				)
				.get(),
		).toEqual({
			candidate_digest: `sha256:${"a".repeat(64)}`,
			idempotency_key: "legacy-promotion",
		});
		expect(
			db
				.prepare(
					`SELECT execution_claim_token, execution_claimed_at, execution_lease_expires_at, execution_claim_epoch
					 FROM candidate_promotions WHERE idempotency_key = 'legacy-promotion'`,
				)
				.get(),
		).toEqual({
			execution_claim_token: null,
			execution_claimed_at: null,
			execution_lease_expires_at: null,
			execution_claim_epoch: 0,
		});
		expect(() =>
			db
				.prepare(
					`INSERT INTO candidate_promotions (
						candidate_digest, idempotency_key, run_id, state, candidate_json,
						decision_json, acceptance_json, review_json, intent_canonical_json,
						prepared_at, recorded_at, executed_at, executed_outcome,
						merged_head_sha, promotion_git_binding_json
					) VALUES (?, ?, ?, 'executed', ?, ?, ?, ?, ?, ?, ?, ?, 'reconciliation_required', ?, ?)`,
				)
				.run(
					`sha256:${"b".repeat(64)}`,
					"reconciliation-promotion",
					"reconciliation-run",
					"{}",
					"{}",
					"{}",
					"{}",
					"{}",
					"2026-07-17T12:00:00.000Z",
					"2026-07-17T12:00:01.000Z",
					"2026-07-17T12:00:02.000Z",
					"9".repeat(40),
					"{}",
				),
		).not.toThrow();
		expect(() => bootstrapStorageProjectionSchema(db)).not.toThrow();
		db.close();
	});

	it("adds execution lease columns to an already-reconciled promotion projection", () => {
		const dir = mkdtempSync(
			join(tmpdir(), "bp-store-promotion-lease-columns-migration-"),
		);
		const db = new DatabaseSync(join(dir, "state.db"));
		db.exec(`
			CREATE TABLE candidate_promotions (
				candidate_digest TEXT NOT NULL,
				idempotency_key TEXT NOT NULL,
				run_id TEXT NOT NULL,
				state TEXT NOT NULL CHECK (state IN ('prepared', 'recorded', 'executed')),
				candidate_json TEXT NOT NULL,
				decision_json TEXT NOT NULL,
				acceptance_json TEXT NOT NULL,
				review_json TEXT NOT NULL,
				intent_canonical_json TEXT NOT NULL,
				prepared_at TEXT NOT NULL,
				recorded_at TEXT,
				executed_at TEXT,
				executed_outcome TEXT CHECK (executed_outcome IN ('promoted', 'reconciliation_required', 'rejected')),
				merged_head_sha TEXT,
				promotion_git_binding_json TEXT,
				PRIMARY KEY (candidate_digest, idempotency_key),
				UNIQUE (candidate_digest),
				UNIQUE (idempotency_key)
			);
			INSERT INTO candidate_promotions (
				candidate_digest, idempotency_key, run_id, state, candidate_json,
				decision_json, acceptance_json, review_json, intent_canonical_json,
				prepared_at, recorded_at
			) VALUES (
				'sha256:${"c".repeat(64)}', 'current-promotion', 'current-run', 'recorded',
				'{}', '{}', '{}', '{}', '{}', '2026-07-18T00:00:00.000Z', '2026-07-18T00:00:01.000Z'
			);
		`);

		bootstrapStorageProjectionSchema(db);

		expect(
			db
				.prepare(
					`SELECT state, execution_claim_token, execution_claimed_at, execution_lease_expires_at, execution_claim_epoch
					 FROM candidate_promotions WHERE idempotency_key = 'current-promotion'`,
				)
				.get(),
		).toEqual({
			state: "recorded",
			execution_claim_token: null,
			execution_claimed_at: null,
			execution_lease_expires_at: null,
			execution_claim_epoch: 0,
		});
		expect(() => bootstrapStorageProjectionSchema(db)).not.toThrow();
		db.close();
	});

	it("bootstraps run_learnings table on fresh init", () => {
		const dir = mkdtempSync(join(tmpdir(), "bp-store-learnings-"));
		const db = new DatabaseSync(join(dir, "state.db"));
		bootstrapStorageProjectionSchema(db);
		const tables = db
			.prepare(
				`SELECT name FROM sqlite_master WHERE type='table' AND name='run_learnings'`,
			)
			.all() as { name: string }[];
		expect(tables).toHaveLength(1);
		db.close();
	});

	it("run_learnings migration is idempotent", () => {
		const dir = mkdtempSync(join(tmpdir(), "bp-store-learnings-idem-"));
		const db = new DatabaseSync(join(dir, "state.db"));
		bootstrapStorageProjectionSchema(db);
		expect(() => bootstrapStorageProjectionSchema(db)).not.toThrow();
		db.close();
	});
});
