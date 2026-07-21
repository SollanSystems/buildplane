import type {
	ActionReceiptRecordedV2,
	ActionReceiptSetRecordedV1,
	ActionReceiptV1,
	ActionRequestedV2,
	ActionRequestV1,
	AttemptContextV1,
	CandidateArtifactV1,
	CandidateArtifactV2,
	CandidateCompletionRecordedV1,
	CandidateCreatedV2,
	CandidateViewV1,
	ContextManifestV1,
	DispatchEnvelopeBodyV2,
	DispatchEnvelopeV1,
	DispatchEnvelopeV2,
	DispatchEnvelopeV3,
	PromotionApprovalRequestedV1,
	PromotionDecisionV1,
	ReviewVerdictOutputV1,
	ReviewVerdictRecordedV2,
	ReviewVerdictV1,
	SandboxProfileV1,
	WorkerManifestV1,
} from "@buildplane/kernel";
import * as kernelPublicApi from "@buildplane/kernel";
import {
	assertGovernedExecutionV1,
	canonicalActionReceiptRecordedV2Digest,
	canonicalActionReceiptSetRecordedV1Digest,
	canonicalActionRequestedV2Digest,
	canonicalCandidateCompletionRecordedV1Digest,
	canonicalCandidateViewV1Digest,
	canonicalDispatchEnvelopeV3Digest,
	canonicalGovernedUnitPacketV1Digest,
	canonicalPromotionApprovalRequestedV1Digest,
	canonicalReviewVerdictOutputV1Digest,
	canonicalSha256Digest,
	isCanonicalBuildplaneCandidateRef,
	parseActionReceiptRecordedV2,
	parseActionReceiptSetRecordedV1,
	parseActionReceiptV1,
	parseActionRequestedV2,
	parseActionRequestV1,
	parseAttemptContextV1,
	parseCandidateArtifactV1,
	parseCandidateArtifactV2,
	parseCandidateCompletionRecordedV1,
	parseCandidateCreatedV2,
	parseCandidateViewV1,
	parseContextManifestV1,
	parseDispatchEnvelopeV1,
	parseDispatchEnvelopeV2,
	parseDispatchEnvelopeV3,
	parsePromotionApprovalRequestedV1,
	parsePromotionDecisionV1,
	parseReviewVerdictRecordedV2,
	parseReviewVerdictV1,
	parseSandboxProfileV1,
	parseSignablePromotionDecisionV1,
	parseWorkerManifestV1,
	UNSUPPORTED_COMMIT_MODE,
	UNSUPPORTED_COMMIT_MODE_MESSAGE,
} from "@buildplane/kernel";
import { describe, expect, expectTypeOf, it } from "vitest";

const BASE_SHA = "a".repeat(40);
const CANDIDATE_SHA = "b".repeat(40);

function digest(seed: string): string {
	return `sha256:${seed.repeat(64).slice(0, 64)}`;
}

function dispatchEnvelope(
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		schemaVersion: 1,
		workflowId: "workflow-42",
		workflowRevision: "workflow-revision-7",
		unitId: "unit-7",
		attempt: 1,
		executionRole: "implementer",
		commitMode: "atomic",
		provenanceRef: "ledger://run/42",
		baseCommitSha: BASE_SHA,
		capabilityBundleDigest: digest("c"),
		acceptanceContractDigest: digest("d"),
		contextManifestDigest: digest("e"),
		workerManifestDigest: digest("f"),
		sandboxProfileDigest: digest("1"),
		budget: {
			maxTokens: 100_000,
			maxComputeTimeMs: 60_000,
		},
		trustTier: "governed",
		idempotencyKey: "dispatch:workflow-42:unit-7:1",
		issuedAt: "2026-07-17T12:00:00Z",
		expiresAt: "2026-07-17T12:15:00Z",
		envelopeDigest: digest("2"),
		signatureRef: {
			algorithm: "ed25519",
			keyId: "kernel-test-key",
			signature: "base64:fixture-signature",
		},
		...overrides,
	};
}

function dispatchEnvelopeV2Body(
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	const {
		schemaVersion: _v1SchemaVersion,
		envelopeDigest: _v1Digest,
		signatureRef: _v1Signature,
		...body
	} = dispatchEnvelope();
	return { ...body, ...overrides };
}

function dispatchEnvelopeV2(
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		schemaVersion: 2,
		body: dispatchEnvelopeV2Body(),
		envelopeDigest: digest("0"),
		...overrides,
	};
}

function dispatchEnvelopeV3(
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	const body = dispatchEnvelopeV2Body();
	// New V3 dispatches select the activity-claim chain. Keep the legacy
	// selector constructible here so the parser's backward-read guarantee is
	// exercised independently of governed execution admission.
	const actionEvidenceVersion =
		overrides.actionEvidenceVersion === "sealed-v2" ? "sealed-v2" : "sealed_v3";
	const repositoryBindingDigest =
		overrides.repositoryBindingDigest ?? digest("8");
	const ledgerAuthorityRealmDigest =
		overrides.ledgerAuthorityRealmDigest ?? digest("9");
	const governedPacketDigest =
		actionEvidenceVersion === "sealed-v2" &&
		overrides.governedPacketDigest === undefined
			? undefined
			: (overrides.governedPacketDigest ?? digest("a"));
	const envelopeDigest = canonicalDispatchEnvelopeV3Digest({
		body: body as DispatchEnvelopeBodyV2,
		actionEvidenceVersion,
		repositoryBindingDigest: repositoryBindingDigest as string,
		ledgerAuthorityRealmDigest: ledgerAuthorityRealmDigest as string,
		...(governedPacketDigest === undefined
			? {}
			: { governedPacketDigest: governedPacketDigest as string }),
	});
	return {
		schemaVersion: 3,
		body,
		actionEvidenceVersion: "sealed_v3",
		repositoryBindingDigest,
		ledgerAuthorityRealmDigest,
		...(governedPacketDigest === undefined ? {} : { governedPacketDigest }),
		envelopeDigest,
		...overrides,
	};
}

function actionRequestedV2(
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		schemaVersion: 2,
		runId: "01919000-0000-7000-8000-0000000000e1",
		workflowId: "workflow-42",
		unitId: "unit-7",
		attempt: 1,
		provenanceRef: "ledger://run/42",
		actionId: "action-1",
		idempotencyKey: "action:workflow-42:unit-7:1",
		actionKind: "process",
		canonicalInputDigest: digest("1"),
		canonicalInputRef: "cas://action-input/1",
		dispatchEnvelopeDigest: digest("2"),
		repositoryBindingDigest: digest("8"),
		ledgerAuthorityRealmDigest: digest("9"),
		governedPacketDigest: digest("a"),
		capabilityBundleDigest: digest("c"),
		policyDigest: digest("d"),
		contextManifestDigest: digest("e"),
		workerManifestDigest: digest("f"),
		sandboxProfileDigest: digest("0"),
		authorityActor: "kernel:gateway",
		executionRole: "implementer",
		requestedAt: "2026-07-17T12:01:00Z",
		...overrides,
	};
}

function actionReceiptRecordedV2(
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	const request = actionRequestedV2();
	return {
		schemaVersion: 2,
		runId: request.runId,
		workflowId: request.workflowId,
		unitId: request.unitId,
		attempt: request.attempt,
		provenanceRef: request.provenanceRef,
		actionId: request.actionId,
		idempotencyKey: request.idempotencyKey,
		actionRequestDigest: canonicalActionRequestedV2Digest(
			request as ActionRequestedV2,
		),
		dispatchEnvelopeDigest: request.dispatchEnvelopeDigest,
		capabilityBundleDigest: request.capabilityBundleDigest,
		policyDigest: request.policyDigest,
		contextManifestDigest: request.contextManifestDigest,
		workerManifestDigest: request.workerManifestDigest,
		sandboxProfileDigest: request.sandboxProfileDigest,
		authorityActor: request.authorityActor,
		executionRole: request.executionRole,
		outcome: "succeeded",
		resultDigest: digest("3"),
		resultRef: "cas://action-result/1",
		evidenceDigest: digest("4"),
		evidenceRef: "cas://action-evidence/1",
		resourceUsage: {
			wallTimeMs: 12,
			cpuTimeMs: 4,
			outputBytes: 17,
			inputTokens: 5,
			outputTokens: 7,
		},
		redactions: [],
		actionReceiptRef: "ledger://action-receipt/1",
		completedAt: "2026-07-17T12:01:01Z",
		...overrides,
	};
}

function actionReceiptSetRecordedV1(
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	const receipt = actionReceiptRecordedV2();
	const withoutDigest = {
		schemaVersion: 1 as const,
		runId: receipt.runId as string,
		workflowId: receipt.workflowId as string,
		unitId: receipt.unitId as string,
		attempt: receipt.attempt as number,
		provenanceRef: receipt.provenanceRef as string,
		dispatchEnvelopeDigest: receipt.dispatchEnvelopeDigest as string,
		actionReceiptSetRef: "ledger://action-receipt-set/1",
		receipts: [
			{
				actionId: receipt.actionId as string,
				actionReceiptRef: receipt.actionReceiptRef as string,
				actionReceiptDigest: canonicalActionReceiptRecordedV2Digest(
					receipt as ActionReceiptRecordedV2,
				),
			},
		],
		sealedAt: "2026-07-17T12:01:02Z",
	};
	return {
		...withoutDigest,
		actionReceiptSetDigest:
			canonicalActionReceiptSetRecordedV1Digest(withoutDigest),
		...overrides,
	};
}

function candidateArtifactV2(
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	const set = actionReceiptSetRecordedV1();
	return {
		schemaVersion: 2,
		workflowId: "workflow-42",
		unitId: "unit-7",
		attempt: 1,
		provenanceRef: "ledger://run/42",
		candidateDigest: digest("3"),
		baseCommitSha: BASE_SHA,
		candidateCommitSha: CANDIDATE_SHA,
		commitDigest: digest("4"),
		treeDigest: digest("5"),
		patchDigest: digest("6"),
		changedFilesDigest: digest("7"),
		envelopeDigest: digest("2"),
		actionReceiptSetRef: set.actionReceiptSetRef,
		actionReceiptSetDigest: set.actionReceiptSetDigest,
		...overrides,
	};
}

function candidateCreatedV2(
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	const { schemaVersion: _schemaVersion, ...artifact } = candidateArtifactV2();
	return {
		runId: "01919000-0000-7000-8000-0000000000e1",
		candidateId: "candidate-1",
		candidateRef: "refs/buildplane/candidates/candidate-1/run/1",
		...artifact,
		...overrides,
	};
}

function candidateCompletionRecordedV1(
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	const candidate = candidateCreatedV2();
	const request = actionRequestedV2();
	const receipt = actionReceiptRecordedV2();
	const withoutDigest = {
		runId: candidate.runId as string,
		workflowId: candidate.workflowId as string,
		unitId: candidate.unitId as string,
		attempt: candidate.attempt as number,
		provenanceRef: candidate.provenanceRef as string,
		candidateCreatedEventRef: "01919000-0000-7000-8000-0000000000e2",
		candidateDigest: candidate.candidateDigest as string,
		candidateCreateActionId: request.actionId as string,
		actionRequestRef: "01919000-0000-7000-8000-0000000000e3",
		actionRequestDigest: canonicalActionRequestedV2Digest(
			request as ActionRequestedV2,
		),
		activityClaimEventRef: "01919000-0000-7000-8000-0000000000e4",
		activityClaimEventDigest: digest("8"),
		activityResultEventRef: "01919000-0000-7000-8000-0000000000e5",
		activityResultEventDigest: digest("9"),
		actionReceiptRef: receipt.actionReceiptRef as string,
		actionReceiptDigest: canonicalActionReceiptRecordedV2Digest(
			receipt as ActionReceiptRecordedV2,
		),
		completedAt: "2026-07-17T12:01:03Z",
		...overrides,
	};
	return {
		...withoutDigest,
		completionDigest:
			canonicalCandidateCompletionRecordedV1Digest(withoutDigest),
	};
}

function candidateArtifact(
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		schemaVersion: 1,
		workflowId: "workflow-42",
		unitId: "unit-7",
		attempt: 1,
		provenanceRef: "ledger://run/42",
		candidateDigest: digest("3"),
		baseCommitSha: BASE_SHA,
		candidateCommitSha: CANDIDATE_SHA,
		treeDigest: digest("4"),
		patchDigest: digest("5"),
		changedFilesDigest: digest("6"),
		envelopeDigest: digest("2"),
		actionReceiptDigest: digest("7"),
		...overrides,
	};
}

function reviewVerdict(
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		schemaVersion: 1,
		candidateDigest: digest("3"),
		decision: "approve",
		findings: [
			{
				severity: "low",
				checkId: "lint/no-unused-vars",
				file: "packages/kernel/src/trust-spine.ts",
				line: 18,
				explanation: "This finding is deliberately non-blocking.",
				evidenceRefs: ["ledger://evidence/lint"],
			},
		],
		confidence: 0.98,
		reviewerManifestDigest: digest("8"),
		...overrides,
	};
}

function promotionDecision(
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		schemaVersion: 1,
		candidateDigest: digest("3"),
		baseCommitSha: BASE_SHA,
		targetRef: "refs/heads/main",
		envelopeDigest: digest("2"),
		acceptanceRef: "ledger://acceptance/42",
		reviewRefs: ["ledger://review/42"],
		decision: "promote",
		authority: "operator:khall",
		decidedBy: "operator:khall",
		decidedAt: "2026-07-17T12:16:00Z",
		idempotencyKey: "promotion:workflow-42:unit-7:1",
		...overrides,
	};
}

function promotionApprovalRequest(
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		schemaVersion: 1,
		candidateDigest: digest("3"),
		baseCommitSha: BASE_SHA,
		targetRef: "refs/heads/main",
		envelopeDigest: digest("2"),
		acceptanceRef: "ledger://acceptance/42",
		reviewRefs: ["ledger://review/42"],
		requestedBy: "kernel:workflow-42",
		requestedAt: "2026-07-17T12:15:00Z",
		idempotencyKey: "promotion:workflow-42:unit-7:1",
		...overrides,
	};
}

function actionRequest(
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		schemaVersion: 1,
		workflowId: "workflow-42",
		unitId: "unit-7",
		attempt: 1,
		provenanceRef: "ledger://run/42",
		actionId: "action-1",
		dispatchEnvelopeDigest: digest("2"),
		capabilityBundleDigest: digest("c"),
		contextManifestDigest: digest("e"),
		workerManifestDigest: digest("f"),
		sandboxProfileDigest: digest("1"),
		authority: "gateway:unit-7",
		idempotencyKey: "action:workflow-42:unit-7:1",
		requestedAt: "2026-07-17T12:01:00Z",
		...overrides,
	};
}

function actionReceipt(
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		schemaVersion: 1,
		workflowId: "workflow-42",
		unitId: "unit-7",
		attempt: 1,
		provenanceRef: "ledger://run/42",
		actionId: "action-1",
		actionRequestDigest: digest("9"),
		dispatchEnvelopeDigest: digest("2"),
		candidateDigest: digest("3"),
		contextManifestDigest: digest("e"),
		workerManifestDigest: digest("f"),
		sandboxProfileDigest: digest("1"),
		authority: "gateway:unit-7",
		outcome: "succeeded",
		evidenceDigest: digest("a"),
		completedAt: "2026-07-17T12:02:00Z",
		...overrides,
	};
}

function workerManifest(
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		schemaVersion: 1,
		workflowId: "workflow-42",
		unitId: "unit-7",
		attempt: 1,
		provenanceRef: "ledger://run/42",
		dispatchEnvelopeDigest: digest("2"),
		contextManifestDigest: digest("e"),
		sandboxProfileDigest: digest("1"),
		workerId: "openai-api:gpt-test",
		provider: "openai",
		manifestDigest: digest("f"),
		...overrides,
	};
}

function contextManifest(
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		schemaVersion: 1,
		workflowId: "workflow-42",
		unitId: "unit-7",
		attempt: 1,
		provenanceRef: "ledger://run/42",
		dispatchEnvelopeDigest: digest("2"),
		workerManifestDigest: digest("f"),
		sandboxProfileDigest: digest("1"),
		contextId: "context-1",
		manifestDigest: digest("e"),
		...overrides,
	};
}

function attemptContext(
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		schemaVersion: 1,
		workflowId: "workflow-42",
		unitId: "unit-7",
		attempt: 1,
		provenanceRef: "ledger://run/42",
		dispatchEnvelopeDigest: digest("2"),
		contextManifestDigest: digest("e"),
		workerManifestDigest: digest("f"),
		sandboxProfileDigest: digest("1"),
		...overrides,
	};
}

function sandboxProfile(
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		schemaVersion: 1,
		workflowId: "workflow-42",
		unitId: "unit-7",
		attempt: 1,
		provenanceRef: "ledger://run/42",
		dispatchEnvelopeDigest: digest("2"),
		workerManifestDigest: digest("f"),
		profileId: "podman-rootless-v1",
		profileDigest: digest("1"),
		...overrides,
	};
}

function withInheritedRequiredField(
	raw: Record<string, unknown>,
	field: string,
): Record<string, unknown> {
	const inherited = Object.create({ [field]: raw[field] }) as Record<
		string,
		unknown
	>;
	Object.assign(inherited, raw);
	delete inherited[field];
	return inherited;
}

describe("trust-spine V1 contracts", () => {
	it("normalizes only valid raw SHA-256 values into V1 digest form", () => {
		expect(canonicalSha256Digest("a".repeat(64))).toBe(
			`sha256:${"a".repeat(64)}`,
		);
		expect(canonicalSha256Digest(`sha256:${"b".repeat(64)}`)).toBe(
			`sha256:${"b".repeat(64)}`,
		);
		expect(() => canonicalSha256Digest("A".repeat(64))).toThrow(
			/lowercase SHA-256/i,
		);
	});

	it("parses a structurally valid dispatch envelope without verifying its signature", () => {
		const parsed = parseDispatchEnvelopeV1(dispatchEnvelope());

		expect(parsed).toMatchObject({
			schemaVersion: 1,
			workflowId: "workflow-42",
			workflowRevision: "workflow-revision-7",
			commitMode: "atomic",
			trustTier: "governed",
			budget: { maxTokens: 100_000, maxComputeTimeMs: 60_000 },
			signatureRef: {
				algorithm: "ed25519",
				keyId: "kernel-test-key",
			},
		});
	});

	it.each([
		[
			"unknown envelope field",
			dispatchEnvelope({ unexpected: true }),
			'dispatchEnvelope has unknown field "unexpected"',
		],
		[
			"unknown signature field",
			dispatchEnvelope({
				signatureRef: {
					algorithm: "ed25519",
					keyId: "kernel-test-key",
					signature: "base64:fixture-signature",
					extra: "not accepted",
				},
			}),
			'dispatchEnvelope.signatureRef has unknown field "extra"',
		],
		[
			"abbreviated base SHA",
			dispatchEnvelope({ baseCommitSha: "abcdef1" }),
			"dispatchEnvelope.baseCommitSha must be a full 40- or 64-character lowercase hexadecimal commit SHA",
		],
		[
			"malformed digest",
			dispatchEnvelope({ capabilityBundleDigest: "digest:abc" }),
			"dispatchEnvelope.capabilityBundleDigest must be a sha256 digest",
		],
		[
			"unsafe attempt",
			dispatchEnvelope({ attempt: Number.MAX_SAFE_INTEGER + 1 }),
			"dispatchEnvelope.attempt must be a positive safe integer",
		],
		[
			"unsafe budget",
			dispatchEnvelope({ budget: { maxTokens: 0 } }),
			"dispatchEnvelope.budget.maxTokens must be a positive u32 integer when provided",
		],
		[
			"invalid role",
			dispatchEnvelope({ executionRole: "operator" }),
			"dispatchEnvelope.executionRole must be one of",
		],
		[
			"invalid timestamp",
			dispatchEnvelope({ issuedAt: "not-a-timestamp" }),
			"dispatchEnvelope.issuedAt must be an RFC3339 UTC timestamp",
		],
		[
			"expired envelope",
			dispatchEnvelope({
				issuedAt: "2026-07-17T12:15:00Z",
				expiresAt: "2026-07-17T12:00:00Z",
			}),
			"dispatchEnvelope.expiresAt must be later than issuedAt",
		],
	])("rejects a dispatch envelope with %s", (_label, raw, message) => {
		expect(() => parseDispatchEnvelopeV1(raw)).toThrow(message);
	});

	it("accepts full SHA-256 Git object ids in governed contracts", () => {
		const sha256Commit = "a".repeat(64);

		expect(
			parseDispatchEnvelopeV1(dispatchEnvelope({ baseCommitSha: sha256Commit }))
				.baseCommitSha,
		).toBe(sha256Commit);
		expect(
			parseCandidateArtifactV1(
				candidateArtifact({
					baseCommitSha: sha256Commit,
					candidateCommitSha: "b".repeat(64),
				}),
			).candidateCommitSha,
		).toBe("b".repeat(64));
	});

	it("allows only governed atomic envelopes through the governed execution gate", () => {
		const dispatch = parseDispatchEnvelopeV1(dispatchEnvelope());

		expect(() => assertGovernedExecutionV1(dispatch)).not.toThrow();
		expect(() =>
			assertGovernedExecutionV1(
				parseDispatchEnvelopeV1(dispatchEnvelope({ trustTier: "raw" })),
			),
		).toThrow('Governed execution requires trustTier "governed".');

		for (const commitMode of ["incremental", "saga"] as const) {
			try {
				assertGovernedExecutionV1(
					parseDispatchEnvelopeV1(dispatchEnvelope({ commitMode })),
				);
				expect.unreachable("non-atomic commit modes must be rejected");
			} catch (error) {
				expect(error).toMatchObject({
					code: UNSUPPORTED_COMMIT_MODE,
					message: UNSUPPORTED_COMMIT_MODE_MESSAGE,
				});
			}
		}
	});

	it("parses a candidate artifact that binds immutable candidate evidence", () => {
		const parsed = parseCandidateArtifactV1(candidateArtifact());

		expect(parsed).toMatchObject({
			workflowId: "workflow-42",
			unitId: "unit-7",
			attempt: 1,
			provenanceRef: "ledger://run/42",
			candidateDigest: digest("3"),
			baseCommitSha: BASE_SHA,
			candidateCommitSha: CANDIDATE_SHA,
			actionReceiptDigest: digest("7"),
		});
	});

	it.each([
		[
			"unknown artifact field",
			candidateArtifact({ metadata: {} }),
			'candidateArtifact has unknown field "metadata"',
		],
		[
			"candidate SHA with uppercase hexadecimal characters",
			candidateArtifact({ candidateCommitSha: "A".repeat(40) }),
			"candidateArtifact.candidateCommitSha must be a full 40- or 64-character lowercase hexadecimal commit SHA",
		],
		[
			"malformed changed-files digest",
			candidateArtifact({ changedFilesDigest: "sha256:too-short" }),
			"candidateArtifact.changedFilesDigest must be a sha256 digest",
		],
	])("rejects a candidate artifact with %s", (_label, raw, message) => {
		expect(() => parseCandidateArtifactV1(raw)).toThrow(message);
	});

	it("keeps structural review approval out of the public promotion-authority surface", () => {
		const approved = parseReviewVerdictV1(reviewVerdict());
		const abstained = parseReviewVerdictV1(
			reviewVerdict({ decision: "abstain" }),
		);
		const changesRequested = parseReviewVerdictV1(
			reviewVerdict({ decision: "request_changes" }),
		);
		const rejected = parseReviewVerdictV1(
			reviewVerdict({ decision: "reject" }),
		);

		expect(approved.decision).toBe("approve");
		expect(abstained.decision).toBe("abstain");
		expect(changesRequested.decision).toBe("request_changes");
		expect(rejected.decision).toBe("reject");

		// A parsed reviewer claim is evidence only. Signed replay evaluates it with
		// acceptance and promotion authority; a public boolean helper cannot.
		expect(
			Reflect.has(kernelPublicApi, "isReviewVerdictEligibleForPromotionV1"),
		).toBe(false);
		expect(
			Reflect.has(kernelPublicApi, "isStructurallyAffirmativeReviewVerdictV1"),
		).toBe(false);
	});

	it("derives a closed review-output digest without trusting reviewer-manifest metadata", () => {
		const verdict = parseReviewVerdictV1(reviewVerdict());
		const output: ReviewVerdictOutputV1 = {
			candidateDigest: verdict.candidateDigest,
			candidateCommitSha: CANDIDATE_SHA,
			decision: verdict.decision,
			findings: verdict.findings,
			confidence: verdict.confidence,
			candidateViewDigest: digest("9"),
		};

		const expected = canonicalReviewVerdictOutputV1Digest(output);
		expect(expected).toMatch(/^sha256:[a-f0-9]{64}$/);
		expect(canonicalReviewVerdictOutputV1Digest({ ...output })).toBe(expected);
		expect(
			canonicalReviewVerdictOutputV1Digest({
				...output,
				candidateViewDigest: digest("a"),
			}),
		).not.toBe(expected);
		expect(() =>
			canonicalReviewVerdictOutputV1Digest({
				...output,
				candidateCommitSha: "A".repeat(40),
			}),
		).toThrow(/candidateCommitSha/i);
	});

	it("derives the read-only candidate-view digest from its complete closed contract", () => {
		const view: CandidateViewV1 = {
			candidateRef: "refs/buildplane/candidates/candidate-1/run/1",
			candidateDigest: digest("c"),
			candidateCommitSha: CANDIDATE_SHA,
			treeDigest: digest("d"),
			reviewerContextManifestDigest: digest("e"),
			reviewerSandboxProfileDigest: digest("f"),
			mountPathDigest: digest("a"),
			readOnly: true,
			networkDisabled: true,
		};

		const expected = canonicalCandidateViewV1Digest(view);
		expect(expected).toMatch(/^sha256:[a-f0-9]{64}$/);
		expect(canonicalCandidateViewV1Digest({ ...view })).toBe(expected);
		expect(
			canonicalCandidateViewV1Digest({ ...view, networkDisabled: false }),
		).not.toBe(expected);
		expect(() =>
			canonicalCandidateViewV1Digest({
				...view,
				candidateCommitSha: "B".repeat(40),
			}),
		).toThrow(/candidateCommitSha/i);
	});

	it("accepts only canonical Buildplane candidate refs", () => {
		expect(
			isCanonicalBuildplaneCandidateRef(
				"refs/buildplane/candidates/candidate-1/run/1",
			),
		).toBe(true);
		for (const invalid of [
			"refs/buildplane/candidates/foo/../main",
			"refs/buildplane/candidates/foo//main",
			"refs/buildplane/candidates/foo\\main",
			"refs/buildplane/candidates/.hidden/main",
			"refs/buildplane/candidates/foo/main.lock",
			" refs/buildplane/candidates/foo/main",
			"refs/buildplane/candidates/foo/evil\u202Elock",
			"refs/buildplane/candidates/foo/\uD800",
		]) {
			expect(isCanonicalBuildplaneCandidateRef(invalid)).toBe(false);
		}
	});

	it("requires canonical candidate refs before candidate creation, view parsing, or digesting", () => {
		const invalidRef = "refs/buildplane/candidates/foo//bar";
		const candidateView: CandidateViewV1 = {
			candidateRef: invalidRef,
			candidateDigest: digest("c"),
			candidateCommitSha: CANDIDATE_SHA,
			treeDigest: digest("d"),
			reviewerContextManifestDigest: digest("e"),
			reviewerSandboxProfileDigest: digest("f"),
			mountPathDigest: digest("a"),
			readOnly: true,
			networkDisabled: true,
		};

		expect(() =>
			parseCandidateCreatedV2(candidateCreatedV2({ candidateRef: invalidRef })),
		).toThrow(/canonical Buildplane candidate ref/i);
		expect(() => parseCandidateViewV1(candidateView)).toThrow(
			/canonical Buildplane candidate ref/i,
		);
		expect(() => canonicalCandidateViewV1Digest(candidateView)).toThrow(
			/canonical Buildplane candidate ref/i,
		);
	});

	it("matches the Rust-generated V2 review candidate-view and output digest fixtures", () => {
		const view: CandidateViewV1 = {
			candidateRef:
				"refs/buildplane/candidates/candidate-fixture-v3/run-fixture/1",
			candidateDigest: digest("a"),
			candidateCommitSha: "1".repeat(40),
			treeDigest: digest("c"),
			reviewerContextManifestDigest: digest("c"),
			reviewerSandboxProfileDigest: digest("e"),
			mountPathDigest: digest("d"),
			readOnly: true,
			networkDisabled: true,
		};
		const candidateViewDigest = canonicalCandidateViewV1Digest(view);
		expect(candidateViewDigest).toBe(
			"sha256:fbe6e46799c46ab3cdcb6f2086ac6841622e993d90364c77d502dbec9fec10be",
		);
		expect(
			canonicalReviewVerdictOutputV1Digest({
				candidateDigest: view.candidateDigest,
				candidateCommitSha: view.candidateCommitSha,
				decision: "approve",
				findings: [],
				confidence: 0.99,
				candidateViewDigest,
			}),
		).toBe(
			"sha256:db1309382bd98c39e46d8b24d86c19a53d3d04fdfadea4ee96dda87d8e1350ee",
		);
	});

	it("parses only a closed V2 review record bound to its candidate view and semantic output", () => {
		const candidateView: CandidateViewV1 = {
			candidateRef: "refs/buildplane/candidates/candidate-2/run-2/1",
			candidateDigest: digest("a"),
			candidateCommitSha: CANDIDATE_SHA,
			treeDigest: digest("b"),
			reviewerContextManifestDigest: digest("c"),
			reviewerSandboxProfileDigest: digest("d"),
			mountPathDigest: digest("e"),
			readOnly: true,
			networkDisabled: true,
		};
		const candidateViewDigest = canonicalCandidateViewV1Digest(candidateView);
		const reviewOutputDigest = canonicalReviewVerdictOutputV1Digest({
			candidateDigest: candidateView.candidateDigest,
			candidateCommitSha: candidateView.candidateCommitSha,
			decision: "approve",
			findings: [],
			confidence: 0.9,
			candidateViewDigest,
		});
		const review: ReviewVerdictRecordedV2 = {
			runId: "run-2",
			workflowId: "workflow-2",
			unitId: "unit-2",
			attempt: 1,
			provenanceRef: "admission:2",
			candidateDigest: candidateView.candidateDigest,
			candidateCommitSha: candidateView.candidateCommitSha,
			reviewRef: "review:2",
			reviewVerdictActionId: "review-action:2",
			reviewActionRequestDigest: digest("f"),
			reviewActionReceiptRef: "receipt:review-action:2",
			reviewActionReceiptDigest: digest("0"),
			reviewOutputRef: `cas:${reviewOutputDigest}`,
			reviewOutputDigest,
			decision: "approve",
			findings: [],
			confidence: 0.9,
			acceptanceRef: "acceptance:2",
			acceptanceDigest: digest("1"),
			acceptanceContractDigest: digest("2"),
			candidateEnvelopeDigest: digest("3"),
			reviewerWorkflowId: "workflow-review-2",
			reviewerDispatchEnvelopeDigest: digest("4"),
			reviewerUnitId: "review-unit-2",
			reviewerAttempt: 1,
			reviewerExecutionRole: "reviewer",
			reviewActionReceiptSetRef: "receipt-set:review:2",
			reviewActionReceiptSetDigest: digest("5"),
			candidateView,
			candidateViewRef: "candidate-view:2",
			candidateViewDigest,
			reviewerManifestDigest: digest("6"),
			reviewerAuthority: "reviewer:2",
			reviewedAt: "2026-07-18T12:00:00.000Z",
		};

		expect(parseReviewVerdictRecordedV2(review)).toEqual(review);
		expect(() =>
			parseReviewVerdictRecordedV2({
				...review,
				candidateViewDigest: digest("7"),
			}),
		).toThrow(/candidateViewDigest/i);
		expect(() =>
			parseReviewVerdictRecordedV2({
				...review,
				reviewOutputRef: "cas:wrong-review-output",
			}),
		).toThrow(/reviewOutputRef/i);
		for (const field of [
			"runId",
			"workflowId",
			"reviewRef",
			"reviewerAuthority",
		] as const) {
			expect(() =>
				parseReviewVerdictRecordedV2({ ...review, [field]: " \t " }),
			).toThrow(/non-blank/i);
		}
		expect(() =>
			parseReviewVerdictRecordedV2({ ...review, extra: true }),
		).toThrow(/unknown field/i);
	});

	it.each([
		[
			"unknown verdict field",
			reviewVerdict({ unknown: true }),
			'reviewVerdict has unknown field "unknown"',
		],
		[
			"invalid review decision",
			reviewVerdict({ decision: "pass" }),
			"reviewVerdict.decision must be one of",
		],
		[
			"confidence outside the closed interval",
			reviewVerdict({ confidence: 1.01 }),
			"reviewVerdict.confidence must be a finite number between 0 and 1",
		],
		[
			"finding with a non-positive line",
			reviewVerdict({
				findings: [
					{
						severity: "high",
						checkId: "test/failure",
						file: "packages/kernel/src/trust-spine.ts",
						line: 0,
						explanation: "A valid finding needs a source line.",
						evidenceRefs: ["ledger://evidence/test"],
					},
				],
			}),
			"reviewVerdict.findings[0].line must be a positive safe integer",
		],
		[
			"finding with an unknown field",
			reviewVerdict({
				findings: [
					{
						severity: "high",
						checkId: "test/failure",
						file: "packages/kernel/src/trust-spine.ts",
						line: 10,
						explanation: "Closed findings reject extra data.",
						evidenceRefs: ["ledger://evidence/test"],
						extra: true,
					},
				],
			}),
			'reviewVerdict.findings[0] has unknown field "extra"',
		],
	])("rejects a review verdict with %s", (_label, raw, message) => {
		expect(() => parseReviewVerdictV1(raw)).toThrow(message);
	});

	it("does not trust overridden review-findings array methods", () => {
		const findings = [
			{
				severity: "not-a-severity",
				checkId: "test/overridden-map",
				file: "packages/kernel/src/trust-spine.ts",
				line: 10,
				explanation: "The input map must never choose the parsed findings.",
				evidenceRefs: ["ledger://evidence/test"],
			},
		];
		Object.defineProperty(findings, "map", {
			value: () => [],
		});

		expect(() => parseReviewVerdictV1(reviewVerdict({ findings }))).toThrow(
			"reviewVerdict.findings[0].severity must be one of",
		);
	});

	it("rejects accessor-backed contracts without invoking the accessor", () => {
		let reads = 0;
		const raw = dispatchEnvelope();
		Object.defineProperty(raw, "workflowRevision", {
			enumerable: true,
			get() {
				reads += 1;
				throw new Error("untrusted getter executed");
			},
		});

		expect(() => parseDispatchEnvelopeV1(raw)).toThrow(
			"dispatchEnvelope.workflowRevision must be a data property",
		);
		expect(reads).toBe(0);
	});

	it("normalizes hostile reflection traps without leaking their error text", () => {
		const hostile = new Proxy(reviewVerdict(), {
			ownKeys() {
				throw new Error("proxy-secret=must-not-leak");
			},
		});
		let thrown: unknown;
		try {
			parseReviewVerdictV1(hostile);
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toBeInstanceOf(TypeError);
		expect(thrown).toMatchObject({
			message: "reviewVerdict must be a closed data record",
		});
		expect(thrown).not.toMatchObject({
			message: expect.stringContaining("proxy-secret"),
		});
	});

	it("normalizes hostile nested-array reflection traps without leaking their error text", () => {
		const raw = reviewVerdict();
		const hostileFindings = new Proxy(raw.findings as object[], {
			getOwnPropertyDescriptor() {
				throw new Error("nested-proxy-secret=must-not-leak");
			},
		});
		let thrown: unknown;
		try {
			parseReviewVerdictV1(reviewVerdict({ findings: hostileFindings }));
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toBeInstanceOf(TypeError);
		expect(thrown).toMatchObject({
			message: "reviewVerdict.findings must be a closed data array",
		});
		expect(thrown).not.toMatchObject({
			message: expect.stringContaining("nested-proxy-secret"),
		});
	});

	it("normalizes hostile packet-digest reflection traps without leaking their error text", () => {
		const hostile = new Proxy(
			{ kind: "governed-packet" },
			{
				ownKeys() {
					throw new Error("packet-proxy-secret=must-not-leak");
				},
			},
		);
		let thrown: unknown;
		try {
			canonicalGovernedUnitPacketV1Digest(hostile);
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toMatchObject({
			message: "governed admitted unit packet must be a closed data object.",
		});
		expect(thrown).not.toMatchObject({
			message: expect.stringContaining("packet-proxy-secret"),
		});
	});

	it("normalizes V3-dispatch and receipt-set digest reflection traps", () => {
		const hostileDispatch = new Proxy(dispatchEnvelopeV3(), {
			get() {
				throw new Error("v3-dispatch-proxy-secret=must-not-leak");
			},
			getOwnPropertyDescriptor() {
				throw new Error("v3-dispatch-proxy-secret=must-not-leak");
			},
		});
		const hostileReceiptSet = new Proxy(actionReceiptSetRecordedV1(), {
			get() {
				throw new Error("receipt-set-proxy-secret=must-not-leak");
			},
			getOwnPropertyDescriptor() {
				throw new Error("receipt-set-proxy-secret=must-not-leak");
			},
		});

		expect(() =>
			canonicalDispatchEnvelopeV3Digest(
				hostileDispatch as unknown as DispatchEnvelopeV3,
			),
		).toThrow("dispatchEnvelopeV3 must be a closed data record");
		expect(() =>
			canonicalActionReceiptSetRecordedV1Digest(
				hostileReceiptSet as unknown as ActionReceiptSetRecordedV1,
			),
		).toThrow("actionReceiptSetRecordedV1 must be a closed data record");
	});

	it("parses a promotion decision as a structural binding only", () => {
		const parsed = parsePromotionDecisionV1(promotionDecision());

		expect(parsed).toMatchObject({
			candidateDigest: digest("3"),
			baseCommitSha: BASE_SHA,
			targetRef: "refs/heads/main",
			envelopeDigest: digest("2"),
			acceptanceRef: "ledger://acceptance/42",
			reviewRefs: ["ledger://review/42"],
			decision: "promote",
			decidedBy: "operator:khall",
			decidedAt: "2026-07-17T12:16:00Z",
		});
	});

	it("parses a closed candidate-bound promotion approval request with a stable digest", () => {
		const request = promotionApprovalRequest();
		const parsed = parsePromotionApprovalRequestedV1(request);
		const expected = canonicalPromotionApprovalRequestedV1Digest(request);

		expect(parsed).toMatchObject({
			candidateDigest: digest("3"),
			baseCommitSha: BASE_SHA,
			targetRef: "refs/heads/main",
			envelopeDigest: digest("2"),
			acceptanceRef: "ledger://acceptance/42",
			reviewRefs: ["ledger://review/42"],
			requestedBy: "kernel:workflow-42",
			requestedAt: "2026-07-17T12:15:00Z",
			idempotencyKey: "promotion:workflow-42:unit-7:1",
		});
		expect(expected).toMatch(/^sha256:[a-f0-9]{64}$/);
		expect(canonicalPromotionApprovalRequestedV1Digest({ ...request })).toBe(
			expected,
		);
		expect(
			canonicalPromotionApprovalRequestedV1Digest(
				promotionApprovalRequest({ targetRef: "refs/heads/release" }),
			),
		).not.toBe(expected);
		expect(() =>
			parsePromotionApprovalRequestedV1(
				promotionApprovalRequest({ unexpectedAuthority: true }),
			),
		).toThrow(
			'promotionApprovalRequest has unknown field "unexpectedAuthority"',
		);
	});

	it("keeps promotion approval request references optional for legacy promotion decisions", () => {
		const legacy = parsePromotionDecisionV1(promotionDecision());
		const bound = parsePromotionDecisionV1(
			promotionDecision({
				promotionApprovalRequestRef: "01919000-0000-7000-8000-000000000042",
			}),
		);

		expect(legacy.promotionApprovalRequestRef).toBeUndefined();
		expect(bound.promotionApprovalRequestRef).toBe(
			"01919000-0000-7000-8000-000000000042",
		);
		expect(() =>
			parsePromotionDecisionV1(
				promotionDecision({ promotionApprovalRequestRef: "" }),
			),
		).toThrow(
			"promotionDecision.promotionApprovalRequestRef must be a non-empty string",
		);
	});

	it("requires matching promotion actor fields before a new decision is signable", () => {
		const historical = promotionDecision({
			authority: "operator",
			decidedBy: "operator@example.test",
		});

		expect(parsePromotionDecisionV1(historical)).toMatchObject({
			authority: "operator",
			decidedBy: "operator@example.test",
		});
		expect(() => parseSignablePromotionDecisionV1(historical)).toThrow(
			"promotionDecision.authority must equal promotionDecision.decidedBy for a signable promotion decision",
		);
	});

	it("parses closed action, worker, context, attempt, and sandbox records", () => {
		expect(parseActionRequestV1(actionRequest())).toMatchObject({
			actionId: "action-1",
			attempt: 1,
			requestedAt: "2026-07-17T12:01:00Z",
		});
		expect(parseActionReceiptV1(actionReceipt())).toMatchObject({
			outcome: "succeeded",
			candidateDigest: digest("3"),
		});
		expect(parseWorkerManifestV1(workerManifest())).toMatchObject({
			provider: "openai",
			workerId: "openai-api:gpt-test",
		});
		expect(parseContextManifestV1(contextManifest())).toMatchObject({
			contextId: "context-1",
		});
		expect(parseAttemptContextV1(attemptContext())).toMatchObject({
			workflowId: "workflow-42",
		});
		expect(parseSandboxProfileV1(sandboxProfile())).toMatchObject({
			profileId: "podman-rootless-v1",
		});
	});

	it.each([
		[
			"unknown action request field",
			() => parseActionRequestV1(actionRequest({ extra: true })),
			'actionRequest has unknown field "extra"',
		],
		[
			"invalid action receipt outcome",
			() => parseActionReceiptV1(actionReceipt({ outcome: "maybe" })),
			"actionReceipt.outcome must be one of",
		],
		[
			"unknown worker manifest field",
			() => parseWorkerManifestV1(workerManifest({ model: "unbound" })),
			'workerManifest has unknown field "model"',
		],
		[
			"missing context manifest provenance",
			() => {
				const raw = contextManifest();
				delete raw.provenanceRef;
				return parseContextManifestV1(raw);
			},
			"contextManifest.provenanceRef must be a non-empty string",
		],
		[
			"invalid attempt number",
			() => parseAttemptContextV1(attemptContext({ attempt: 0 })),
			"attemptContext.attempt must be a positive safe integer",
		],
		[
			"unknown sandbox profile field",
			() => parseSandboxProfileV1(sandboxProfile({ network: "open" })),
			'sandboxProfile has unknown field "network"',
		],
	])("rejects a %s", (_label, parse, message) => {
		expect(parse).toThrow(message);
	});

	it.each([
		[
			"unknown promotion field",
			promotionDecision({ merged: true }),
			'promotionDecision has unknown field "merged"',
		],
		[
			"empty review references",
			promotionDecision({ reviewRefs: [] }),
			"promotionDecision.reviewRefs must be a non-empty array of non-empty strings",
		],
		[
			"invalid decision",
			promotionDecision({ decision: "merge" }),
			"promotionDecision.decision must be one of",
		],
		[
			"malformed candidate digest",
			promotionDecision({ candidateDigest: "sha256:short" }),
			"promotionDecision.candidateDigest must be a sha256 digest",
		],
		[
			"invalid decision timestamp",
			promotionDecision({ decidedAt: "tomorrow" }),
			"promotionDecision.decidedAt must be an RFC3339 UTC timestamp",
		],
		[
			"non-branch promotion target",
			promotionDecision({ targetRef: "HEAD" }),
			"promotionDecision.targetRef must be a canonical refs/heads branch ref",
		],
	])("rejects a promotion decision with %s", (_label, raw, message) => {
		expect(() => parsePromotionDecisionV1(raw)).toThrow(message);
	});

	it("does not trust overridden review-reference array methods", () => {
		const reviewRefs: unknown[] = [42];
		Object.defineProperty(reviewRefs, "some", {
			value: () => false,
		});

		expect(() =>
			parsePromotionDecisionV1(promotionDecision({ reviewRefs })),
		).toThrow(
			"promotionDecision.reviewRefs must be a non-empty array of non-empty strings",
		);
	});

	it("captures each review-reference element exactly once", () => {
		const reviewRefs: unknown[] = ["ledger://review/ok"];
		let reads = 0;
		Object.defineProperty(reviewRefs, "0", {
			configurable: true,
			get: () => {
				reads += 1;
				return reads === 1 ? "ledger://review/ok" : 42;
			},
		});

		const parsed = parsePromotionDecisionV1(promotionDecision({ reviewRefs }));
		expect(reads).toBe(1);
		expect(parsed.reviewRefs).toEqual(["ledger://review/ok"]);
	});

	it("rejects sparse evidence arrays and returns dense detached arrays", () => {
		const sparse = new Array<string>(1);
		expect(() =>
			parsePromotionDecisionV1(promotionDecision({ reviewRefs: sparse })),
		).toThrow(
			"promotionDecision.reviewRefs must be a non-empty array of non-empty strings",
		);

		const raw = reviewVerdict();
		const rawFindings = raw.findings as Array<{
			evidenceRefs: string[];
		}>;
		const parsed = parseReviewVerdictV1(raw);
		rawFindings[0].evidenceRefs[0] = "ledger://mutated";

		expect(parsed.findings[0]?.evidenceRefs).toEqual([
			"ledger://evidence/lint",
		]);
	});

	it.each([
		[
			"dispatch envelopes",
			() =>
				parseDispatchEnvelopeV1(
					withInheritedRequiredField(dispatchEnvelope(), "workflowRevision"),
				),
			"dispatchEnvelope.workflowRevision must be a non-empty string",
		],
		[
			"candidate artifacts",
			() =>
				parseCandidateArtifactV1(
					withInheritedRequiredField(candidateArtifact(), "provenanceRef"),
				),
			"candidateArtifact.provenanceRef must be a non-empty string",
		],
		[
			"review verdicts",
			() =>
				parseReviewVerdictV1(
					withInheritedRequiredField(reviewVerdict(), "candidateDigest"),
				),
			"reviewVerdict.candidateDigest must be a sha256 digest",
		],
		[
			"promotion decisions",
			() =>
				parsePromotionDecisionV1(
					withInheritedRequiredField(promotionDecision(), "decidedAt"),
				),
			"promotionDecision.decidedAt must be an RFC3339 UTC timestamp",
		],
	])("rejects required properties inherited by %s", (_label, parse, message) => {
		expect(parse).toThrow(message);
	});

	it("rejects a prototype-pollution-shaped own field", () => {
		const raw = JSON.parse(JSON.stringify(dispatchEnvelope())) as Record<
			string,
			unknown
		>;
		Object.defineProperty(raw, "__proto__", {
			enumerable: true,
			value: { workflowRevision: "polluted" },
		});

		expect(() => parseDispatchEnvelopeV1(raw)).toThrow(
			'dispatchEnvelope has unknown field "__proto__"',
		);
	});

	it("exports deferred V1 contract types without attaching parsers yet", () => {
		expectTypeOf<ActionRequestV1>().toMatchTypeOf<{
			schemaVersion: 1;
			workflowId: string;
			unitId: string;
			attempt: number;
			actionId: string;
			dispatchEnvelopeDigest: string;
			contextManifestDigest: string;
			workerManifestDigest: string;
			sandboxProfileDigest: string;
			authority: string;
		}>();
		expectTypeOf<ActionReceiptV1>().toMatchTypeOf<{
			schemaVersion: 1;
			workflowId: string;
			unitId: string;
			attempt: number;
			actionRequestDigest: string;
			candidateDigest: string;
			outcome: string;
		}>();
		expectTypeOf<WorkerManifestV1>().toMatchTypeOf<{
			schemaVersion: 1;
			workflowId: string;
			unitId: string;
			attempt: number;
			workerId: string;
			dispatchEnvelopeDigest: string;
			sandboxProfileDigest: string;
		}>();
		expectTypeOf<ContextManifestV1>().toMatchTypeOf<{
			schemaVersion: 1;
			workflowId: string;
			unitId: string;
			attempt: number;
			contextId: string;
			dispatchEnvelopeDigest: string;
			workerManifestDigest: string;
			sandboxProfileDigest: string;
		}>();
		expectTypeOf<AttemptContextV1>().toMatchTypeOf<{
			schemaVersion: 1;
			workflowId: string;
			unitId: string;
			attempt: number;
			provenanceRef: string;
			dispatchEnvelopeDigest: string;
			contextManifestDigest: string;
			workerManifestDigest: string;
			sandboxProfileDigest: string;
		}>();
		expectTypeOf<SandboxProfileV1>().toMatchTypeOf<{
			schemaVersion: 1;
			workflowId: string;
			unitId: string;
			attempt: number;
			profileId: string;
			dispatchEnvelopeDigest: string;
			workerManifestDigest: string;
		}>();
		expectTypeOf<DispatchEnvelopeV1>().toMatchTypeOf<{
			schemaVersion: 1;
			baseCommitSha: string;
		}>();
		expectTypeOf<CandidateArtifactV1>().toMatchTypeOf<{
			candidateDigest: string;
		}>();
		expectTypeOf<ReviewVerdictV1>().toMatchTypeOf<{
			candidateDigest: string;
			decision: string;
		}>();
		expectTypeOf<PromotionDecisionV1>().toMatchTypeOf<{
			candidateDigest: string;
			authority: string;
		}>();
		expectTypeOf<PromotionApprovalRequestedV1>().toMatchTypeOf<{
			candidateDigest: string;
			targetRef: string;
			requestedBy: string;
		}>();
	});
});

describe("trust-spine V2 dispatch proposal", () => {
	it("parses a non-circular body without treating it as verified authority", () => {
		const parsed = parseDispatchEnvelopeV2(dispatchEnvelopeV2());

		expect(parsed).toMatchObject({
			schemaVersion: 2,
			envelopeDigest: digest("0"),
			body: {
				workflowId: "workflow-42",
				commitMode: "atomic",
				trustTier: "governed",
			},
		});
		expect("signatureRef" in parsed.body).toBe(false);
	});

	it.each([
		[
			"an outer signature field",
			dispatchEnvelopeV2({ signatureRef: {} }),
			'dispatchEnvelopeV2 has unknown field "signatureRef"',
		],
		[
			"a body digest field",
			dispatchEnvelopeV2({
				body: { ...dispatchEnvelopeV2Body(), envelopeDigest: digest("x") },
			}),
			'dispatchEnvelopeV2.body has unknown field "envelopeDigest"',
		],
		[
			"a nested signature reference",
			dispatchEnvelopeV2({
				body: { ...dispatchEnvelopeV2Body(), signatureRef: {} },
			}),
			'dispatchEnvelopeV2.body has unknown field "signatureRef"',
		],
		[
			"a wrong schema version",
			dispatchEnvelopeV2({ schemaVersion: 1 }),
			"dispatchEnvelopeV2.schemaVersion must be 2",
		],
		[
			"an invalid body expiry",
			dispatchEnvelopeV2({
				body: {
					...dispatchEnvelopeV2Body(),
					issuedAt: "2026-07-17T12:15:00Z",
					expiresAt: "2026-07-17T12:00:00Z",
				},
			}),
			"dispatchEnvelopeV2.body.expiresAt must be later than issuedAt",
		],
	])("rejects %s", (_label, raw, message) => {
		expect(() => parseDispatchEnvelopeV2(raw)).toThrow(message);
	});

	it("keeps V1 and V2 proposal types distinct", () => {
		expectTypeOf<DispatchEnvelopeV1>().not.toMatchTypeOf<DispatchEnvelopeV2>();
		expectTypeOf<DispatchEnvelopeV2>().toMatchTypeOf<{
			schemaVersion: 2;
			body: DispatchEnvelopeBodyV2;
			envelopeDigest: string;
		}>();
	});
});

describe("trust-spine V3 sealed action evidence", () => {
	it("binds repository, authority-realm, and governed-packet digests into sealed_v3", () => {
		const parsed = parseDispatchEnvelopeV3(dispatchEnvelopeV3());
		expect(parsed).toMatchObject({
			schemaVersion: 3,
			actionEvidenceVersion: "sealed_v3",
			body: { workflowId: "workflow-42", trustTier: "governed" },
			repositoryBindingDigest: digest("8"),
			ledgerAuthorityRealmDigest: digest("9"),
			governedPacketDigest: digest("a"),
		});
		expect(parsed.envelopeDigest).toBe(
			canonicalDispatchEnvelopeV3Digest(parsed),
		);

		for (const changedBindings of [
			{ repositoryBindingDigest: digest("b") },
			{ ledgerAuthorityRealmDigest: digest("c") },
			{ governedPacketDigest: digest("d") },
		]) {
			const changed = parseDispatchEnvelopeV3(
				dispatchEnvelopeV3(changedBindings),
			);
			expect(changed.envelopeDigest).not.toBe(parsed.envelopeDigest);
			expect(changed.envelopeDigest).toBe(
				canonicalDispatchEnvelopeV3Digest(changed),
			);
		}

		const missingPacket = dispatchEnvelopeV3();
		delete missingPacket.governedPacketDigest;
		expect(() => parseDispatchEnvelopeV3(missingPacket)).toThrow(
			/governedPacketDigest is required for sealed_v3 authority/i,
		);

		const legacy = parseDispatchEnvelopeV3(
			dispatchEnvelopeV3({ actionEvidenceVersion: "sealed-v2" }),
		);
		expect(legacy).toMatchObject({
			schemaVersion: 3,
			actionEvidenceVersion: "sealed-v2",
			body: { workflowId: "workflow-42", trustTier: "governed" },
			repositoryBindingDigest: digest("8"),
			ledgerAuthorityRealmDigest: digest("9"),
		});
		expect("governedPacketDigest" in legacy).toBe(false);
		expect(legacy.envelopeDigest).toBe(
			canonicalDispatchEnvelopeV3Digest(legacy),
		);

		expect(() =>
			parseDispatchEnvelopeV3(
				dispatchEnvelopeV3({ actionEvidenceVersion: "legacy-v1" }),
			),
		).toThrow(/actionEvidenceVersion/);
		expect(() =>
			parseDispatchEnvelopeV3(
				dispatchEnvelopeV3({ envelopeDigest: digest("f") }),
			),
		).toThrow(/canonical V3 body digest/);
	});

	it("keeps action requests receipt-free and validates the cross-language request digest", () => {
		const request = parseActionRequestedV2(actionRequestedV2());
		expect(canonicalActionRequestedV2Digest(request)).toMatch(/^sha256:/);
		expect(request).toMatchObject({
			repositoryBindingDigest: digest("8"),
			ledgerAuthorityRealmDigest: digest("9"),
			governedPacketDigest: digest("a"),
		});
		expect("candidateDigest" in request).toBe(false);
		expect(() =>
			parseActionRequestedV2(
				actionRequestedV2({ candidateDigest: digest("9") }),
			),
		).toThrow('actionRequestedV2 has unknown field "candidateDigest"');
	});

	it("enforces closed terminal action receipt semantics and canonical receipt digest", () => {
		const receipt = parseActionReceiptRecordedV2(actionReceiptRecordedV2());
		expect(canonicalActionReceiptRecordedV2Digest(receipt)).toMatch(/^sha256:/);
		expect(receipt.resourceUsage).toMatchObject({
			inputTokens: 5,
			outputTokens: 7,
		});
		expect("candidateDigest" in receipt).toBe(false);

		expect(() => {
			const raw = actionReceiptRecordedV2();
			delete raw.resultRef;
			return parseActionReceiptRecordedV2(raw);
		}).toThrow(/resultDigest and resultRef must be present together/);
		expect(() => {
			const raw = actionReceiptRecordedV2({ outcome: "failed" });
			delete raw.resultDigest;
			delete raw.resultRef;
			return parseActionReceiptRecordedV2(raw);
		}).toThrow(/require failure/);
		expect(() =>
			parseActionReceiptRecordedV2(
				actionReceiptRecordedV2({
					redactions: [
						{ field: "token", reason: "secret" },
						{ field: "token", reason: "duplicate" },
					],
				}),
			),
		).toThrow(/duplicate field/);
	});

	it("binds a candidate only to a canonical, sorted sealed receipt set", () => {
		const set = parseActionReceiptSetRecordedV1(actionReceiptSetRecordedV1());
		expect(set.actionReceiptSetDigest).toBe(
			canonicalActionReceiptSetRecordedV1Digest(set),
		);
		expect(() =>
			parseActionReceiptSetRecordedV1(
				actionReceiptSetRecordedV1({ actionReceiptSetDigest: digest("8") }),
			),
		).toThrow(/canonical receipt-set digest/);

		const second = {
			actionId: "action-0",
			actionReceiptRef: "ledger://action-receipt/0",
			actionReceiptDigest: digest("0"),
		};
		expect(() =>
			parseActionReceiptSetRecordedV1(
				actionReceiptSetRecordedV1({
					receipts: [...set.receipts, second],
				}),
			),
		).toThrow(/strictly sorted/);
	});

	it("parses V2 candidate records that bind a receipt set and no pre-effect receipt", () => {
		const artifact = parseCandidateArtifactV2(candidateArtifactV2());
		const created = parseCandidateCreatedV2(candidateCreatedV2());
		expect(artifact.actionReceiptSetRef).toBe("ledger://action-receipt-set/1");
		expect(created.candidateRef).toContain("refs/buildplane/candidates");
		expect(() =>
			parseCandidateArtifactV2(
				candidateArtifactV2({ actionReceiptDigest: digest("7") }),
			),
		).toThrow('candidateArtifactV2 has unknown field "actionReceiptDigest"');
		expectTypeOf<DispatchEnvelopeV3>().toMatchTypeOf<{
			schemaVersion: 3;
			actionEvidenceVersion: "sealed-v2" | "sealed_v3";
		}>();
		expectTypeOf<CandidateArtifactV2>().toMatchTypeOf<{
			schemaVersion: 2;
			actionReceiptSetDigest: string;
		}>();
		expectTypeOf<CandidateCreatedV2>().toMatchTypeOf<{
			runId: string;
			actionReceiptSetRef: string;
		}>();
		expectTypeOf<ActionReceiptSetRecordedV1>().toMatchTypeOf<{
			schemaVersion: 1;
			receipts: readonly unknown[];
		}>();
	});

	it("parses a closed candidate-completion lineage and rejects a digest rebound", () => {
		const completion = parseCandidateCompletionRecordedV1(
			candidateCompletionRecordedV1(),
		);
		expect(completion.candidateCreateActionId).toBe("action-1");
		expect(completion.completionDigest).toBe(
			canonicalCandidateCompletionRecordedV1Digest(completion),
		);
		expectTypeOf<CandidateCompletionRecordedV1>().toMatchTypeOf<{
			candidateCreatedEventRef: string;
			activityResultEventDigest: string;
			completionDigest: string;
		}>();
		const rebound = {
			...candidateCompletionRecordedV1(),
			candidateCreateActionId: "action-2",
		};
		expect(() => parseCandidateCompletionRecordedV1(rebound)).toThrow(
			/completionDigest must equal the canonical candidate-completion digest/,
		);
		expect(() =>
			parseCandidateCompletionRecordedV1(
				candidateCompletionRecordedV1({ forgedAuthority: true }),
			),
		).toThrow(
			'candidateCompletionRecordedV1 has unknown field "forgedAuthority"',
		);
	});
});
